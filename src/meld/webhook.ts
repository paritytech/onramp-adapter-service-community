/**
 * Meld's webhook deliveries: the signature check, and what each verified event changes.
 *
 * A delivery is a hint, never the truth. A transaction event is applied from the transaction Meld
 * returns when asked, not from the event's own status, and a KYC event only refreshes a cache the
 * customer read replaces wholesale. Nothing in a delivery reaches a log line except event, order
 * and funding ids, Meld's customer id and statuses.
 *
 * An event id is recorded only once its event has been applied. A delivery that fails part way is
 * therefore redelivered by Meld and applied again, which is safe because applying is idempotent:
 * a transaction moves a row only forwards and only to where Meld's current status puts it, and a
 * KYC merge of the same states changes nothing. Recording first and deleting on failure would lose
 * the event whenever the process died between the two.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

import { z } from 'zod';

import type { Config } from '../config.js';
import { webhookNotApplied } from '../contract.js';
import { UNIFIED_KYC, kycStateOf } from '../customer.js';
import type { KycCache, KycState } from '../funding/customer.js';
import type { FundingStore } from '../funding/store.js';
import type { Secret } from '../secret.js';
import { MeldHttpError, type MeldClient } from './client.js';
import { MELD_STATUS_TO_STATE } from './rail.js';

export type WebhookMeldPort = Pick<MeldClient, 'transaction'>;

export type WebhookStorePort = Pick<
  FundingStore,
  'webhookEventSeen' | 'recordWebhookEvent' | 'byMeldOrderId' | 'advanceTo' | 'mergeKycCache'
>;

/** Any pino logger satisfies it; the route passes the request's own, so lines carry its id. */
export interface WebhookLog {
  info: (fields: Record<string, unknown>, message: string) => void;
  warn: (fields: Record<string, unknown>, message: string) => void;
}

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Meld's signature over one delivery: base64url of HMAC-SHA256 over
 * `timestamp + "." + url + "." + body`, keeping the `=` padding Java's URL encoder writes.
 */
export function meldSignature(secret: string, timestamp: string, url: string, body: Buffer): string {
  const digest = createHmac('sha256', secret).update(`${timestamp}.${url}.`).update(body).digest('base64');
  return digest.replaceAll('+', '-').replaceAll('/', '_');
}

const envelope = z
  .object({
    eventType: z.string().min(1).max(128),
    eventId: z.string().min(1).max(128),
    payload: z.object({}).loose(),
  })
  .loose();

type Envelope = z.infer<typeof envelope>;

const transactionPayload = z
  .object({
    paymentTransactionId: z.string().min(1).max(128),
    paymentTransactionStatus: z.string().nullish(),
  })
  .loose();

const kycPayload = z
  .object({
    customerId: z.string().min(1).max(128),
    serviceProvider: z.string().min(1).nullish(),
    status: z.string().nullish(),
    kycRecipient: z
      .object({ serviceProvider: z.string().min(1), status: z.string().nullish() })
      .loose()
      .nullish(),
  })
  .loose();

const TRANSACTION_EVENT = 'TRANSACTION_CRYPTO_';
const KYC_EVENT = 'CUSTOMER_KYC_STATUS_CHANGE';

/** What a failure to apply may log: Meld's status and code, or the error's class, never its text. */
function causeOf(cause: unknown): Record<string, unknown> {
  if (cause instanceof MeldHttpError) return { status: cause.status, code: cause.code };
  return { error: cause instanceof Error ? cause.name : typeof cause };
}

export class MeldWebhooks {
  private readonly url: string;
  private readonly toleranceMs: number;

  constructor(
    webhook: Pick<NonNullable<Config['meld']['webhook']>, 'url' | 'tolerance_ms'>,
    private readonly secret: Secret,
    private readonly meld: WebhookMeldPort,
    private readonly store: WebhookStorePort,
    private readonly clock: () => number = Date.now,
  ) {
    this.url = webhook.url;
    this.toleranceMs = webhook.tolerance_ms;
  }

  /** Why a delivery is not Meld's, or `undefined` when its signature and timestamp hold. */
  signatureFault(signature: string | undefined, timestamp: string | undefined, body: Buffer): string | undefined {
    if (signature === undefined || timestamp === undefined) return 'signature headers missing';
    const at = ISO_TIMESTAMP.test(timestamp) ? Date.parse(timestamp) : Number.NaN;
    if (Number.isNaN(at)) return 'signature timestamp unreadable';
    if (Math.abs(this.clock() - at) > this.toleranceMs) return 'signature timestamp outside tolerance';
    const expected = Buffer.from(meldSignature(this.secret.expose(), timestamp, this.url, body));
    const given = Buffer.from(signature);
    return given.length === expected.length && timingSafeEqual(given, expected) ? undefined : 'signature mismatch';
  }

  /**
   * Apply one verified delivery. A body that is not a readable envelope is acknowledged and
   * logged, because redelivering it cannot make it readable. Throws `WEBHOOK_NOT_APPLIED` when the
   * event should be redelivered.
   */
  async handle(body: Buffer, log: WebhookLog): Promise<void> {
    let json: unknown;
    try {
      json = JSON.parse(body.toString('utf8'));
    } catch {
      json = undefined;
    }
    const parsed = envelope.safeParse(json);
    if (!parsed.success) {
      log.warn({}, 'verified Meld webhook is not a readable event; acknowledged');
      return;
    }
    const event = parsed.data;
    const ids = { eventType: event.eventType, eventId: event.eventId };
    if (await this.store.webhookEventSeen(event.eventId)) {
      log.info(ids, 'Meld webhook already applied');
      return;
    }

    try {
      await this.apply(event, log);
    } catch (cause) {
      log.warn({ ...ids, ...causeOf(cause) }, 'Meld webhook not applied; Meld will redeliver it');
      throw webhookNotApplied(`Meld webhook ${event.eventType} ${event.eventId} not applied`);
    }
    await this.store.recordWebhookEvent(event.eventId, event.eventType, this.clock());
  }

  private async apply(event: Envelope, log: WebhookLog): Promise<void> {
    if (event.eventType.startsWith(TRANSACTION_EVENT)) {
      await this.transaction(event, log);
      return;
    }
    if (event.eventType === KYC_EVENT) {
      await this.kyc(event, log);
      return;
    }
    log.info({ eventType: event.eventType, eventId: event.eventId }, 'Meld webhook acknowledged');
  }

  /**
   * The order is named only by the transaction, so it is read from Meld. A row the event cannot
   * move (concluded, or already further on) is left as it is.
   */
  private async transaction(event: Envelope, log: WebhookLog): Promise<void> {
    const ids = { eventType: event.eventType, eventId: event.eventId };
    const payload = transactionPayload.safeParse(event.payload);
    if (!payload.success) {
      log.warn(ids, 'Meld transaction webhook names no transaction; acknowledged');
      return;
    }
    const txn = await this.meld.transaction(payload.data.paymentTransactionId, { headless: true });
    const orderId = txn.orderId ?? undefined;
    if (orderId === undefined) {
      log.warn(ids, 'Meld transaction names no order; acknowledged');
      return;
    }
    const row = await this.store.byMeldOrderId(orderId);
    if (row === undefined) {
      log.info({ ...ids, orderId }, 'Meld webhook for an order this service does not hold');
      return;
    }

    const status = txn.status ?? payload.data.paymentTransactionStatus ?? null;
    const target = MELD_STATUS_TO_STATE(status ?? undefined);
    const result = await this.store.advanceTo(row.id, target, this.clock(), {
      providerTransactionId: txn.id,
      providerStatus: status,
    });
    if (result === undefined) {
      log.warn({ ...ids, orderId, fundingId: row.id }, 'funding request vanished before the webhook was applied');
      return;
    }
    const moved = result.record.status !== result.from;
    log.info(
      { ...ids, orderId, fundingId: row.id, status, from: result.from, to: result.record.status },
      moved ? 'Meld webhook applied' : 'Meld webhook left the funding request unchanged',
    );
  }

  /** Sumsub's status is the customer's KYC; any other provider's, and `kycRecipient`, are per provider. */
  private async kyc(event: Envelope, log: WebhookLog): Promise<void> {
    const ids = { eventType: event.eventType, eventId: event.eventId };
    const payload = kycPayload.safeParse(event.payload);
    if (!payload.success) {
      log.warn(ids, 'Meld KYC webhook names no customer; acknowledged');
      return;
    }
    const { customerId, serviceProvider, status, kycRecipient } = payload.data;
    const providers: Record<string, KycState> = {};
    const patch: KycCache = {};
    if (serviceProvider != null && status != null) {
      if (serviceProvider === UNIFIED_KYC) patch.kyc = kycStateOf(status);
      else providers[serviceProvider] = kycStateOf(status);
    }
    if (kycRecipient?.status != null) providers[kycRecipient.serviceProvider] = kycStateOf(kycRecipient.status);
    if (Object.keys(providers).length > 0) patch.providers = providers;
    if (Object.keys(patch).length === 0) {
      log.info({ ...ids, meldCustomerId: customerId }, 'Meld KYC webhook carries no status; acknowledged');
      return;
    }

    const updated = await this.store.mergeKycCache(customerId, patch, this.clock());
    if (updated === undefined) {
      log.info({ ...ids, meldCustomerId: customerId }, 'Meld KYC webhook for a customer this service does not hold');
      return;
    }
    log.info({ ...ids, meldCustomerId: customerId, kyc: updated.kyc_cache }, 'Meld KYC webhook applied');
  }
}
