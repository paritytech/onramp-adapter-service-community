/**
 * The headless customer behind a customer key: its registration at Meld, its KYC, its contact
 * verifications, and what a provider still needs before it takes an order.
 *
 * What a person registers is forwarded to Meld and kept nowhere here: the store holds the key
 * hash, Meld's id, a random external id and KYC states. Meld's own error text is neither forwarded
 * nor logged, because it may quote a submitted value; a Meld failure is named by status and code.
 */

import type { AuditLog } from './audit.js';
import type { Subject } from './auth.js';
import type { Config } from './config.js';
import {
  customerExists,
  customerNotFound,
  reject,
  upstreamUnavailable,
  verificationCooldown,
  verificationExpired,
  type CustomerRegistration,
  type CustomerView,
  type ProviderDetailsRequest,
  type ProviderKycView,
  type RequirementsRequest,
  type RequirementsView,
  type VerificationConfirmation,
  type VerificationRequestBody,
  type VerificationResult,
  type VerificationStarted,
} from './contract.js';
import type { KycCache, KycState, MeldCustomerRow } from './funding/customer.js';
import type { FundingStore } from './funding/store.js';
import { resolveDestination } from './meld/catalog.js';
import { MeldHttpError, type KycRequest, type MeldClient, type MeldCustomer, type MeldRequirements } from './meld/client.js';

/** Only the Meld calls this service makes, so a test can substitute a plain object. */
export type CustomerMeldPort = Pick<
  MeldClient,
  | 'createCustomer'
  | 'getCustomer'
  | 'addCustomerAddress'
  | 'initiateKyc'
  | 'refreshKyc'
  | 'requirements'
  | 'startVerification'
  | 'confirmVerification'
>;

export type CustomerStorePort = Pick<
  FundingStore,
  'customerByKey' | 'insertCustomer' | 'updateKycCache' | 'deleteCustomer'
>;

/** The operator log, for a fault that is not an audit event. Any pino logger satisfies it. */
export interface CustomerLog {
  warn: (fields: Record<string, unknown>, message: string) => void;
}

/** Meld's Unified KYC provider, and the only one this service starts KYC with. */
const UNIFIED_KYC = 'SUMSUB';

const FINAL_KYC: ReadonlySet<KycState> = new Set(['approved', 'rejected', 'expired']);

/**
 * Meld documents example statuses, not the enum, so anything unrecognised reads as `pending`:
 * not approved, and not a final answer either.
 */
export function kycStateOf(status: string | null | undefined): KycState {
  switch (status) {
    case undefined:
    case null:
      return 'none';
    case 'APPROVED':
      return 'approved';
    case 'REJECTED':
      return 'rejected';
    case 'EXPIRED':
      return 'expired';
    default:
      return 'pending';
  }
}

/** A provider's questionnaire link is offered only while its KYC can still move. */
export function customerViewOf(customer: MeldCustomer): CustomerView {
  let kyc: KycState = 'none';
  const providers: ProviderKycView[] = [];
  for (const entry of customer.serviceProviderCustomers ?? []) {
    const state = kycStateOf(entry.kyc?.status);
    if (entry.serviceProvider === UNIFIED_KYC) {
      kyc = state;
      continue;
    }
    const actionUrl = entry.kyc?.additionalInfo?.HostedURL;
    providers.push({
      provider: entry.serviceProvider,
      kyc: state,
      ...(actionUrl == null || FINAL_KYC.has(state) ? {} : { actionUrl }),
    });
  }
  return { kyc, providers };
}

function kycCacheOf(view: CustomerView): KycCache {
  return { kyc: view.kyc, providers: Object.fromEntries(view.providers.map((p) => [p.provider, p.kyc])) };
}

const CHANNELS = [
  ['EMAIL', 'email'],
  ['PHONE', 'phone'],
] as const;

type VerificationReason = RequirementsView['verifications'][number]['reason'];

function reasonOf(reason: string | null | undefined): VerificationReason {
  return reason === 'STALE' || reason === 'VOIP' ? reason : 'MISSING';
}

/**
 * Meld's requirements as the app reads them. `ready` needs a customer: without one Meld answers
 * only the base requirements, so "nothing outstanding" would be a claim about nobody.
 */
export function requirementsViewOf(answer: MeldRequirements, forCustomer: boolean): RequirementsView {
  const verifications: RequirementsView['verifications'] = [];
  for (const [channel, key] of CHANNELS) {
    if (answer.verificationRequirements?.[key]?.required !== true) continue;
    const status = answer.customerStatus?.[key];
    if (status?.satisfied === true) continue;
    verifications.push({ channel, reason: reasonOf(status?.reason) });
  }

  const kyc = answer.kycRequirements ?? [];
  const missingFields = new Set(
    kyc
      .filter((r) => r.code === 'PROVIDER_EXTRA_KYC' && r.status === 'REQUIRED')
      .flatMap((r) => r.missingFields ?? [])
      .filter((field) => field.trim() !== ''),
  );

  return {
    agreements: (answer.legalAgreements ?? []).map(({ type, url }) => ({ type, url })),
    verifications,
    missingFields: [...missingFields],
    pending: kyc.some((r) => r.status === 'PENDING'),
    blocked: kyc.some((r) => r.status === 'BLOCKED'),
    ready: forCustomer && verifications.length === 0 && kyc.every((r) => r.status === 'SATISFIED'),
  };
}

const meldSays = (error: MeldHttpError) =>
  `Meld answered HTTP ${String(error.status)}${error.code === undefined ? '' : ` ${error.code}`}`;

/** A Meld error status as a refusal, by status and code only. */
function meldRefusal(cause: unknown): unknown {
  if (!(cause instanceof MeldHttpError)) return cause;
  return cause.status === 400
    ? reject(
        { tag: 'Other', value: { code: 'PROVIDER_REJECTED', message: 'The provider declined this request.' } },
        meldSays(cause),
      )
    : upstreamUnavailable(meldSays(cause));
}

async function fromMeld<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (cause) {
    throw meldRefusal(cause);
  }
}

export class CustomerService {
  private readonly headless: NonNullable<Config['meld']['headless']>;

  constructor(
    cfg: Pick<Config, 'meld'>,
    private readonly meld: CustomerMeldPort,
    private readonly store: CustomerStorePort,
    private readonly audit: AuditLog,
    private readonly log: CustomerLog,
    private readonly clock: () => number = Date.now,
    private readonly newId: () => string = () => crypto.randomUUID(),
  ) {
    if (cfg.meld.headless === undefined) {
      throw new Error('The customer service requires meld.headless.');
    }
    this.headless = cfg.meld.headless;
  }

  /**
   * The customer's KYC states, or null until this key has registered. Refreshes the KYC cache. A
   * stored customer Meld no longer knows is forgotten, so the key can register again.
   */
  async get(subject: Subject, keyHash: string, requestId: string): Promise<CustomerView | null> {
    const row = await this.store.customerByKey(subject.productId, keyHash);
    if (row === undefined) return null;
    const customer = await fromMeld(() => this.meld.getCustomer(row.meld_customer_id));
    if (customer === undefined) {
      await this.forget(subject, row, requestId);
      return null;
    }
    const view = customerViewOf(customer);
    await this.store.updateKycCache(row.meld_customer_id, kycCacheOf(view), this.clock());
    return view;
  }

  /**
   * Create the Meld customer for this key and record the mapping.
   *
   * The address is added before the mapping is stored, so a stored customer always has the
   * address it was registered with. A Meld customer left without a mapping is audited with its id,
   * the only handle to it.
   */
  async register(
    subject: Subject,
    keyHash: string,
    details: CustomerRegistration,
    requestId: string,
  ): Promise<CustomerView> {
    const existing = await this.store.customerByKey(subject.productId, keyHash);
    if (existing !== undefined) {
      if ((await fromMeld(() => this.meld.getCustomer(existing.meld_customer_id))) !== undefined) {
        throw customerExists('this customer key already has a Meld customer');
      }
      await this.forget(subject, existing, requestId);
    }

    const externalId = this.newId();
    const created = await fromMeld(() =>
      this.meld.createCustomer({
        externalId,
        name: { firstName: details.firstName, lastName: details.lastName },
        email: details.email,
        dateOfBirth: details.dateOfBirth,
      }),
    );
    const orphaned = (reason: 'address_failed' | 'insert_failed' | 'concurrent_registration') => {
      this.audit.info(
        {
          event: 'customer.orphaned',
          alias: subject.alias,
          productId: subject.productId,
          requestId,
          meldCustomerId: created.id,
          reason,
        },
        'Meld customer created but not recorded',
      );
    };

    const { address } = details;
    if (address !== undefined) {
      try {
        await fromMeld(() =>
          this.meld.addCustomerAddress(created.id, {
            firstName: details.firstName,
            lastName: details.lastName,
            ...address,
          }),
        );
      } catch (cause) {
        orphaned('address_failed');
        throw cause;
      }
    }

    const view = customerViewOf(created);
    const now = this.clock();
    let row: MeldCustomerRow;
    try {
      row = await this.store.insertCustomer({
        product_id: subject.productId,
        customer_key_hash: keyHash,
        meld_customer_id: created.id,
        external_id: externalId,
        kyc_cache: kycCacheOf(view),
        created_at: now,
        updated_at: now,
      });
    } catch (cause) {
      orphaned('insert_failed');
      throw cause;
    }
    if (row.meld_customer_id !== created.id) {
      orphaned('concurrent_registration');
      throw customerExists('a concurrent registration recorded this customer key first');
    }

    this.audit.info(
      { event: 'customer.created', alias: subject.alias, productId: subject.productId, requestId },
      'customer registered',
    );
    return view;
  }

  /**
   * A Sumsub hosted URL for this customer. Meld answers a repeated start with `409`, and the
   * `PATCH` with the same body re-issues a fresh URL, so a retry after a lapsed page still works.
   */
  async startKyc(subject: Subject, keyHash: string, requestId: string): Promise<{ url: string }> {
    const row = await this.customerOf(subject, keyHash);
    const share = this.headless.kyc_share_providers;
    const request: KycRequest = {
      serviceProvider: UNIFIED_KYC,
      mode: 'HOSTED_URL',
      ...(share.length > 0 ? { kycShareProviders: share } : {}),
    };
    const started = await fromMeld(() => this.meld.initiateKyc(row.meld_customer_id, request));
    const session =
      started.outcome === 'started'
        ? started.session
        : await fromMeld(() => this.meld.refreshKyc(row.meld_customer_id, request));
    if (session.url == null) throw upstreamUnavailable('Meld answered a KYC start without a URL');

    this.audit.info(
      { event: 'customer.kyc_started', alias: subject.alias, productId: subject.productId, requestId },
      'customer KYC started',
    );
    return { url: session.url };
  }

  /** `keyHash` is present only for a valid customer token; the customer id is sent only if stored. */
  async requirements(
    subject: Subject,
    keyHash: string | undefined,
    query: RequirementsRequest,
  ): Promise<RequirementsView> {
    const { code } = resolveDestination(query.destinationCurrencyCode);
    const row = keyHash === undefined ? undefined : await this.store.customerByKey(subject.productId, keyHash);
    const networkCode = this.headless.network_codes[code];
    const answer = await fromMeld(() =>
      this.meld.requirements(query.provider, {
        ...(row === undefined ? {} : { customerId: row.meld_customer_id }),
        paymentMethodType: query.paymentMethodType,
        sourceCurrencyCode: query.fiat.toUpperCase(),
        sourceAmount: query.sourceAmount,
        destinationCurrencyCode: code,
        countryCode: query.country,
        ...(networkCode === undefined ? {} : { destinationNetworkCode: networkCode }),
      }),
    );
    return requirementsViewOf(answer, row !== undefined);
  }

  /**
   * A provider's extra KYC fields, through the KYC `PATCH` as Meld's requirements guide says.
   * Meld does not document the shape of `serviceProviderDetails` for these, so they go as named.
   */
  async submitDetails(subject: Subject, keyHash: string, details: ProviderDetailsRequest): Promise<void> {
    const row = await this.customerOf(subject, keyHash);
    await fromMeld(() =>
      this.meld.refreshKyc(row.meld_customer_id, {
        serviceProvider: UNIFIED_KYC,
        mode: 'HOSTED_URL',
        kycShareProviders: [details.provider],
        serviceProviderDetails: details.fields,
      }),
    );
  }

  async startVerification(
    subject: Subject,
    keyHash: string,
    request: VerificationRequestBody,
  ): Promise<VerificationStarted> {
    const row = await this.customerOf(subject, keyHash);
    const started = await fromMeld(() => this.meld.startVerification(row.meld_customer_id, request));
    if (started.outcome === 'cooldown') throw verificationCooldown(started.resendAvailableAt);
    const { verificationId, expiresAt, resendAvailableAt } = started.verification;
    if (expiresAt == null || resendAvailableAt == null) {
      throw upstreamUnavailable('Meld answered a verification without its expiry or resend time');
    }
    return { verificationId, expiresAt, resendAvailableAt };
  }

  /** `FAILED` is an answer, not an error. Meld's `400` is an expired or spent verification. */
  async confirmVerification(
    subject: Subject,
    keyHash: string,
    confirmation: VerificationConfirmation,
  ): Promise<VerificationResult> {
    const row = await this.customerOf(subject, keyHash);
    let result;
    try {
      result = await this.meld.confirmVerification(row.meld_customer_id, confirmation.verificationId, confirmation.code);
    } catch (cause) {
      if (cause instanceof MeldHttpError && cause.status === 400) throw verificationExpired(meldSays(cause));
      throw meldRefusal(cause);
    }
    if (result.status === 'VERIFIED') return { status: 'VERIFIED' };
    return {
      status: 'FAILED',
      ...(result.attemptsRemaining == null ? {} : { attemptsRemaining: result.attemptsRemaining }),
    };
  }

  /** Drop a mapping whose Meld customer Meld answers `404` for. */
  private async forget(subject: Subject, row: MeldCustomerRow, requestId: string): Promise<void> {
    this.log.warn({ reqId: requestId, meldCustomerId: row.meld_customer_id }, 'stored Meld customer is unknown to Meld');
    if (!(await this.store.deleteCustomer(subject.productId, row.customer_key_hash, row.meld_customer_id))) return;
    this.audit.info(
      {
        event: 'customer.forgotten',
        alias: subject.alias,
        productId: subject.productId,
        requestId,
        meldCustomerId: row.meld_customer_id,
      },
      'stored Meld customer unknown to Meld; mapping removed',
    );
  }

  private async customerOf(subject: Subject, keyHash: string): Promise<MeldCustomerRow> {
    const row = await this.store.customerByKey(subject.productId, keyHash);
    if (row === undefined) throw customerNotFound('no Meld customer is recorded for this customer key');
    return row;
  }
}
