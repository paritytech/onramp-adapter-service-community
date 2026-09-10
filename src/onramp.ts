/**
 * Quote, create a session, read a transaction. For the one that spends, validate first.
 *
 * The rule is one sentence: nothing that can be refused locally is ever refused upstream. Every
 * check runs before the rail call, so a rejected request costs no quota and no upstream state.
 *
 * Every session creation is a durable funding request: the record the status surface answers and
 * the worker advances once the SPA is gone. The rail that handles a request is a resolved
 * implementer behind a port (`src/rail.ts`), selected by an explicit `rail` discriminator on the
 * wire, not Meld's `service_provider` pin. `Onramp` morphs a validated wire request into the
 * neutral rail input, calls through the seam, and persists the neutral result.
 */

import { normalizeAddress } from './address.js';
import { railRefusal } from './meld/refusal.js';
import type { AuditEvent, AuditLog } from './audit.js';
import type { Subject } from './auth.js';
import { originAllowed, type Config } from './config.js';
import {
  Refusal,
  reject,
  type CreateSessionRequest,
  type CreateSessionResponse,
  type QuoteRequest,
  type QuoteResponse,
  type TransactionResponse,
  type FundingFailure,
} from './contract.js';
import { TERMINAL_STATES } from './funding/state.js';
import type { FundingRecord } from './funding/types.js';
import type { FundingStore } from './funding/store.js';
import type { FundingRail, MeldTransactionReader, RailName, RailRegistry } from './rail.js';
import { DEFAULT_RAIL } from './rail.js';
import { resolveDestination } from './meld/catalog.js';
import { toMinorUnits } from './money.js';
import type { Corridor, CountryRow, Discovery } from './meld/discovery.js';

/** Just the store surface onramp touches, injectable in a test. */
export type FundingPort = Pick<
  FundingStore,
  'reserve' | 'create' | 'update' | 'byAlias' | 'byReference' | 'list' | 'cancel'
>;

/** An injectable clock so tests can pin "now" without mocking time. */
export type Clock = () => number;

/**
 * What validation committed to, as opposed to what the caller asked for.
 *
 * `pinned` is echoed to the caller; `redirectUrl` is not, but it is committed in the same sense:
 * the normalised href is what reaches the rail, never the caller's spelling of it.
 */
interface Committed {
  pinned: CreateSessionResponse['pinned'];
  redirectUrl: string | undefined;
}

export class Onramp {
  constructor(
    private readonly cfg: Config,
    private readonly rails: RailRegistry,
    private readonly audit: AuditLog,
    private readonly funding: FundingPort,
    private readonly meldTransaction: MeldTransactionReader,
    private readonly clock: Clock = Date.now,
    private readonly newId: () => string = () => crypto.randomUUID(),
    // Last and optional so the many existing positional call sites keep their `clock`/`newId`
    // meaning unchanged. Absent, the limit gate falls back to `config.limits`, which is also the
    // degraded path when discovery is present but Meld's public catalog is briefly unreachable.
    private readonly discovery?: Discovery,
  ) {}

  /** The methods + fiat min/max a corridor offers, for the buyer's amount screen. Refuses an
   *  unknown crypto as `WrongAssetOrChain` before any probe. */
  async supported(country: string, code: string): Promise<Corridor> {
    resolveDestination(code);
    if (this.discovery === undefined) {
      throw reject(
        { tag: 'Other', value: { code: 'DISCOVERY_UNAVAILABLE', message: 'Capability discovery is not configured.' } },
        'supported() called without a discovery client.',
        503,
      );
    }
    // Fiat is resolved from the country's default corridor, so the buyer picks only a country.
    return this.discovery.corridorForCountry(country, code);
  }

  /** The countries this deployment can deliver a crypto to, for the region dropdown. */
  async supportedCountries(code: string): Promise<CountryRow[]> {
    resolveDestination(code);
    if (this.discovery === undefined) {
      throw reject(
        { tag: 'Other', value: { code: 'DISCOVERY_UNAVAILABLE', message: 'Capability discovery is not configured.' } },
        'supportedCountries() called without a discovery client.',
        503,
      );
    }
    return this.discovery.countries(code);
  }

  /** Resolve the rail a request names, refusing an unregistered one locally. */
  private rail(rail: RailName | undefined): FundingRail {
    const name = rail ?? DEFAULT_RAIL;
    const resolved = this.rails[name];
    // `RailRegistry` is partial by type, so a rail can be named without being wired. Both are
    // wired today; this refuses locally, before any upstream call, if that ever stops being true.
    if (resolved === undefined) {
      throw reject({ tag: 'Other', value: { code: 'UNKNOWN_RAIL', message: 'That funding rail is not wired.' } }, `rail ${name} is not wired`);
    }
    return resolved;
  }

  /**
   * Offers for a destination amount.
   *
   * Spends a rail call but no credits, so the only local gate is that the destination is one this
   * service delivers. That is why an unknown code costs no quota.
   *
   * The configured fiat bounds are deliberately not applied here, even though `fiat` and
   * `sourceAmount` are both in hand: a quote is price discovery, and a buyer settling on an amount
   * may legitimately ask about one they then adjust. `validate` enforces them where the charge is
   * committed.
   */
  async quote(request: QuoteRequest): Promise<QuoteResponse> {
    const destination = resolveDestination(request.destinationCurrencyCode);
    // Refuse an unservable pair here rather than at the moment of charge. Amount bounds are
    // deliberately not applied at quote time (a quote is exploratory and the buyer is still
    // choosing the number), but whether this deployment serves this currency at all cannot change
    // between the quote and the session, so finding out late only wasted a metered rail call and
    // showed the buyer a price they were never going to be allowed to pay.
    const rail = this.rail(request.rail);
    // The fiat limit gate is Meld's corridor question; only the fiat rail has one. A non-fiat rail
    // (chainflip) has no fiat corridor and refuses at the rail with its own reason, so gating it
    // here would preempt that with a misleading currency error.
    if (rail.provider === 'meld') {
      await this.limitFor(
        destination.code,
        request.fiat.toUpperCase(),
        request.country,
        request.paymentMethodType,
        // A quote charges nothing and Meld prices the amount itself, so a catalog outage is not a
        // reason to refuse one. See `limitFor`.
        'ungate',
      );
    }
    const quotes = await rail.quote({
      countryCode: request.country,
      sourceCurrencyCode: request.fiat.toUpperCase(),
      destinationCurrencyCode: destination.code,
      sourceAmount: request.sourceAmount,
      paymentMethodType: request.paymentMethodType,
    });

    // The echo is built here rather than round-tripped through the rail: every value in it is
    // already in hand, so asking the rail to hand back its own arguments bought nothing.
    return {
      quotes,
      requested: {
        destinationCurrencyCode: destination.code,
        sourceAmount: request.sourceAmount,
        fiat: request.fiat.toUpperCase(),
      },
    };
  }

  /**
   * Status, projected onto the fields this service declares.
   *
   * Projected rather than forwarded, because `transactionResponse` is `.loose()` so that a field
   * Meld adds does not break parsing. Forwarding the parsed object would carry any new field,
   * including a customer-identifying one, to whoever holds the id, on a route that is
   * authenticated but not scoped to the caller who owns the transaction (threat-model R12).
   * Tolerance at the boundary and tolerance on the way out are separate decisions.
   *
   * Projected explicitly rather than by tightening the schema, so the two keep their separate
   * jobs: the parse stays forgiving, the wire stays declared.
   */
  async transaction(id: string): Promise<TransactionResponse> {
    const t = await this.meldTransaction.transaction(id);
    return {
      transaction: {
        id: t.id,
        ...(t.status === undefined || t.status === null ? {} : { status: t.status }),
        ...(t.sourceAmount === undefined || t.sourceAmount === null ? {} : { sourceAmount: t.sourceAmount }),
        ...(t.destinationAmount === undefined || t.destinationAmount === null
          ? {}
          : { destinationAmount: t.destinationAmount }),
        ...(t.serviceProvider === undefined || t.serviceProvider === null
          ? {}
          : { serviceProvider: t.serviceProvider }),
      },
    };
  }

  async createSession(
    subject: Subject,
    request: CreateSessionRequest,
    requestId: string,
  ): Promise<CreateSessionResponse> {
    const rail = this.rail(request.rail);
    const name = rail.provider;

    if (!this.cfg.session_creation_enabled) {
      // Audited and recorded like any other refusal. The audit before the throw means a
      // kill-switch window leaves a mark, not silence; and the durable `refused` record means
      // the window is visible in the caller's funding history, exactly as a validation refusal
      // is. A support conversation can then explain why a funding attempt went nowhere.
      throw await this.refuse(
        subject,
        requestId,
        request,
        reject({ tag: 'RouteWithdrawn' }, 'Session creation is disabled by the operator.'),
        name,
      );
    }

    let committed;
    try {
      committed = await this.validate(request, rail);
    } catch (cause) {
      if (cause instanceof Refusal) await this.refuse(subject, requestId, request, cause, name);
      throw cause;
    }
    const { pinned, redirectUrl } = committed;

    const now = this.clock();
    const fundingId = this.newId();

      // Reserve the row before calling the rail, in the `created` state the machine has for it.
      //
      // Checking `byReference` and then calling the rail is check-then-act: two concurrent requests
      // under one idempotency key both see no row, both open an upstream session, and the loser fails
      // its insert on the unique index. One buyer intent, two settlement surfaces. Inserting first
      // makes the unique index the arbiter, which is the only atomic thing here.
      //
      // `reserve` reports the conflict rather than throwing it, so a duplicate key is told apart from a
      // dead connection. On Postgres a failed insert also poisons its transaction, so a re-read inside
      // the same one would fail too.
    const reservation = await this.funding.reserve(
      this.newRecord({
        id: fundingId,
        subject,
        // The pinned terms: what was committed, not what was asked for.
        destinationCurrencyCode: pinned.destinationCurrencyCode,
        walletAddress: pinned.walletAddress,
        sourceAmount: pinned.sourceAmount,
        fiat: pinned.fiat,
        country: pinned.country,
        paymentMethodType: request.paymentMethodType,
        serviceProvider: request.serviceProvider,
        clientReference: request.idempotencyKey,
        rail: name,
        status: 'created',
        now,
      }),
    );
    if (reservation.outcome === 'existing') {
      // The reservation lost, so this key already belongs to a request. Replaying that one is
      // the whole contract of an idempotency key.
      const already = reservation.record;

      // A row still in `created` is not an answer; it is another request holding this key while
      // it waits for the rail, with no session id and no settlement surface yet. Replaying it
      // would return 201 with both fields empty and audit a `session.created` for a session that
      // does not exist. The caller is told to come back instead.
      if (already.status === 'created') {
        throw reject(
          {
            tag: 'Other',
            value: {
              code: 'REQUEST_IN_FLIGHT',
              message: 'That request is still being opened. Retry shortly.',
              fundingRequestId: already.id,
            },
          },
          `idempotency key ${request.idempotencyKey} is held by an in-flight reservation`,
          409,
        );
      }
      // Is this request already over? Answered first, and before any comparison of terms (see
      // `refuseIfOver`). A conclusion outranks a term that drifted.
      this.refuseIfOver(already);
      // An idempotency key answers "is this the same request?", not only "have I seen this
      // key?". Replaying without comparing means a caller who reuses a key with a different wallet
      // or amount is handed the first request's session and terms: a live settlement surface
      // for an intent they are no longer expressing, reported as a `201`. The money is safe (the
      // widget is locked to the pinned terms, and the response echoes them honestly), but a client
      // rendering its own request state shows the buyer one thing over a widget committed to
      // another, and a corrupted client looks successful.
      //
      // Compared against the stored row rather than a stored digest: the row already holds every
      // committed term, so this needs no column and no migration.
      const differs =
        already.destination_currency_code !== pinned.destinationCurrencyCode ||
        already.wallet_address !== pinned.walletAddress ||
        already.source_amount !== pinned.sourceAmount ||
        already.fiat !== pinned.fiat ||
        already.payment_method_type !== request.paymentMethodType ||
        // Country was validated, sent to the rail, and then left out of this comparison. So the
        // same key with a different country replayed the first session silently. It is not a
        // cosmetic field: it selects the provider set, the fee schedule and the KYC path, so a
        // caller who has changed it is expressing a different intent and must be told so.
        already.country !== request.country ||
        already.service_provider !== request.serviceProvider ||
        already.rail !== name;
      if (differs) {
        throw reject(
          {
            tag: 'Other',
            value: {
              code: 'IDEMPOTENCY_KEY_REUSED',
              message: 'That idempotency key belongs to a different request. Use a new key.',
              fundingRequestId: already.id,
            },
          },
          `idempotency key ${request.idempotencyKey} was first used for funding request ${already.id} with different terms`,
          409,
        );
      }

      return this.replay(subject, requestId, already);
    }

    let session;
    try {
      session = await rail.createSession({
        destinationCode: pinned.destinationCurrencyCode,
        walletAddress: pinned.walletAddress,
        sourceAmount: pinned.sourceAmount,
        fiat: pinned.fiat,
        countryCode: request.country,
        paymentMethodType: request.paymentMethodType,
        serviceProvider: request.serviceProvider,
        redirectUrl,
        // This record's id, not the caller's key (see `RailSessionInput.clientReference`).
        clientReference: fundingId,
      });
    } catch (cause) {
      // What the failure proves decides what the row says and whether the key is freed. Both the
      // recorded outcome and the caller's answer derive from this one `Refusal`, so the tag on the
      // row is the tag the caller was answered with.
      //
      // Definitive means the rail read the request and rejected it: a `4xx`, so no settlement
      // surface exists. The row is `refused` and the key released, because a retry under it (which
      // the contract requires to be stable across a page reload) must open a fresh request rather
      // than replay a dead row for ever.
      //
      // Indefinite is exactly `ProviderTimeout`: a timeout, a socket reset, an unreadable body, a
      // 5xx. Every one is consistent with the rail having created the session and the answer never
      // arriving, so releasing the key would hand the retry a second settlement surface for one
      // buyer intent, the failure `worker.ts`'s `created` branch and threat-model T14 both exist
      // to prevent. Such a failure concludes `unobserved` and keeps the key, the caller meets
      // `REQUEST_OUTCOME_UNKNOWN`, and nobody is charged twice on this service's word.
      const refusal = railRefusal(cause);
      const definitive = refusal.failure.tag !== 'ProviderTimeout';
      const reason = refusal.failure.tag;
      // Guarded, because an unguarded compensating write replaces the error it is compensating
      // for. A lost connection, a statement timeout, or a row moved underneath would
      // have thrown here and propagated instead of `cause`, turning Meld's `400 BelowMinimum`,
      // with its threshold, into a bare `500`, and leaving the row in `created` still holding
      // the key. `refuse()` already swallows exactly this class for exactly this reason.
      try {
        await (definitive
          ? this.funding.update(fundingId, 'refused', this.clock(), { releaseReference: true, reason })
          // No reason on the indefinite branch, deliberately: `unobserved` means it could not be told
          // what happened, so there is no refusal to explain and a tag here would assert one.
          : this.funding.update(fundingId, 'unobserved', this.clock()));
      } catch {
        this.audit.info(
          {
            event: 'session.orphaned',
            alias: subject.alias,
            productId: subject.productId,
            requestId,
            rail: name,
            destinationCurrencyCode: pinned.destinationCurrencyCode,
            walletAddress: pinned.walletAddress,
            sourceAmount: pinned.sourceAmount,
            fiat: pinned.fiat,
            // Enumerated, like every other `reason` on this stream. A driver's own message is
            // shaped by the driver (`pg` carries host, database and user in a connection error),
            // and the audit trail is a protected asset that ships off-box, so `audit.ts` says this
            // field is the tag only. That argument does not depend on which driver is underneath.
            // The driver's own words go to the request log, keyed by the same `requestId`.
            reason: 'reservation_close_failed',
          },
          'reservation left open after the rail refused',
        );
      }
      // A refusal by the rail is a thing this service did, and the audit stream is where a dispute
      // is answered from. Every local refusal was recorded and every provider-side one was not,
      // so "what was attempted for this person" had a hole exactly where the money was.
      this.audit.info(
        {
          event: 'session.rail_refused',
          alias: subject.alias,
          productId: subject.productId,
          requestId,
          rail: name,
          destinationCurrencyCode: pinned.destinationCurrencyCode,
          walletAddress: pinned.walletAddress,
          sourceAmount: pinned.sourceAmount,
          fiat: pinned.fiat,
          reason,
        },
        'rail refused the session',
      );
      throw cause;
    }

    try {
      // `await`, inside the `try`. Without it the promise rejects outside this frame: the catch
      // never runs, the `session.orphaned` audit is never written, and the rejection surfaces as
      // an unhandled one, at the exact moment a settlement surface exists that nothing records.
      await this.funding.update(fundingId, 'session_opened', this.clock(), {
        providerSessionId: session.providerSessionId,
        widgetUrl: session.settlementUrl,
        ...(session.hostedWidgetUrl === undefined ? {} : { hostedWidgetUrl: session.hostedWidgetUrl }),
        ...(session.expiresAt === undefined ? {} : { expiresAt: session.expiresAt }),
      });
    } catch (cause) {
      // The rail opened a settlement surface and the row could not be advanced to say so. The
      // reservation still exists, so the buyer is not lost entirely. But nothing records where
      // to pay, and the audit line naming the rail's own session id is the only handle support
      // has. The worker ages the stranded reservation out.
      this.audit.info(
        {
          event: 'session.orphaned',
          alias: subject.alias,
          productId: subject.productId,
          requestId,
          rail: name,
          providerSessionId: session.providerSessionId,
          ...pinned,
        },
        'session opened upstream but the funding record could not be advanced',
      );
      throw cause;
    }

    this.audit.info(
      {
        event: 'session.created',
        alias: subject.alias,
        productId: subject.productId,
        requestId,
        rail: name,
        // A rail must produce one, so this record's shape does not vary with whether the rail
        // named the session.
        providerSessionId: session.providerSessionId,
        ...pinned,
      },
      'session created',
    );

    return {
      // Never defaulted to an empty string: a rail that cannot produce a session id or a
      // settlement surface throws instead (see `RailSession`), because a 201 with either one blank
      // hands the buyer nowhere to pay and leaves a record with no join key back to the rail.
      sessionId: session.providerSessionId,
      // The caller's own handle around the whole funding request: the id it polls with.
      fundingRequestId: fundingId,
      // The buyer-facing settlement surface (Meld's `serviceProviderWidgetUrl`, Chainflip's swap
      // route). The primary open handle; `widgetUrl` remains the rail's own hosted widget when
      // one exists distinct from the provider page.
      serviceProviderWidgetUrl: session.settlementUrl,
      ...(session.hostedWidgetUrl === undefined ? {} : { widgetUrl: session.hostedWidgetUrl }),
      ...(session.expiresAt === undefined ? {} : { expiresAt: session.expiresAt }),
      pinned,
    };
  }

  /**
   * Refuse a replay whose request is already over, before anything compares terms.
   *
   * Order matters: this must run before the terms-equality check in `replay()`. That check
   * compares `source_amount` and `service_provider`, which a consumer leaves out of its
   * idempotency key because both are solved from a live rate and drift between quotes. Checked
   * later, a concluded request whose price had moved would answer `IDEMPOTENCY_KEY_REUSED`
   * instead of its own conclusion.
   *
   * That cost two things. `REQUEST_ALREADY_SETTLED` (the code split out precisely so a client
   * cannot mistake "you have paid" for "start again") was unreachable on the ordinary path. And
   * an `expired` request never answered `REQUEST_CONCLUDED`, which is the only code the consumer
   * walks its attempt counter on, so a buyer whose payment window lapsed could not start another
   * on that burner. Ever.
   *
   * Terms are still compared for a live row, which is what that check was written for: being
   * handed a running settlement surface committed to an intent you are no longer expressing. A
   * request that is over has no surface to hand back, so there is nothing for the comparison to
   * protect.
   */
  private refuseIfOver(record: FundingRecord): void {
    if (TERMINAL_STATES.includes(record.status)) {
      // Three answers, because a caller can act on three different things.
      //
      // `expired` and `failed` mean the rail answered and nothing was paid, so starting a fresh
      // intent is safe and is what the caller should do.
      //
      // `settled` means the buyer has already paid, so it gets its own code rather than sharing
      // `REQUEST_CONCLUDED` with the two above. A client that starts a new intent on "concluded"
      // would otherwise open a second payable surface for a purchase that already succeeded.
      //
      // `unobserved` means the rail stopped being askable. Telling that caller to start a new one
      // would invite a second payment for an intent whose first payment cannot be ruled out,
      // which `state.ts` says this record must never claim, and it would claim it at the wire.
      //
      // The split is necessary but not sufficient on its own: whether a second payable surface
      // opens is decided in the client's default branch, which this repo cannot see. A client that
      // halts only on `REQUEST_OUTCOME_UNKNOWN` and retries everything else puts
      // `REQUEST_ALREADY_SETTLED` back into the retry branch. The rule that closes that gap is
      // part of the published contract: an unrecognised `Other` code must halt, never retry.
      const conclusion =
        record.status === 'unobserved'
          ? {
              code: 'REQUEST_OUTCOME_UNKNOWN',
              message: 'We could not confirm what happened to that request. Contact support before starting another.',
            }
          : record.status === 'settled'
            ? {
                code: 'REQUEST_ALREADY_SETTLED',
                message: 'That request has already been paid. Do not start another for it.',
              }
            : { code: 'REQUEST_CONCLUDED', message: 'That request has already concluded. Start a new one.' };
      throw reject(
        { tag: 'Other', value: { ...conclusion, fundingRequestId: record.id } },
        `idempotency key replays funding request ${record.id}, which concluded as ${record.status}`,
        409,
      );
    }
    // A withdrawn request has no surface to replay either, and it is not terminal, so it reaches
    // here rather than the branch above. Answering `201` would hand back the capture page the
    // cancel exists to take away.
    //
    // Its own code, because the instruction differs from every conclusion above: nothing was paid
    // and the buyer chose this, so starting again is safe and is what they want. The message stops
    // short of promising nothing will be paid. A transfer already on its way still settles
    // against this row, which is why cancelling leaves the worker watching.
    if (record.cancelled_at !== undefined) {
      throw reject(
        {
          tag: 'Other',
          value: {
            code: 'REQUEST_CANCELLED',
            message: 'That request was cancelled. Start a new one with a new key.',
            fundingRequestId: record.id,
          },
        },
        `idempotency key replays funding request ${record.id}, which the caller cancelled`,
        409,
      );
    }
  }

  /**
   * The response for a request that already exists.
   *
   * Built from the stored row rather than from the rail's answer, which is what makes a replay
   * identical to the original: both URLs are persisted precisely so this can reproduce them.
   */
  private replay(subject: Subject, requestId: string, record: FundingRecord): CreateSessionResponse {
    // Only a live, un-withdrawn row reaches here: `refuseIfOver` answers the terminal and
    // cancelled ones before the caller's terms are even compared.
    //
    // Asserted, not defaulted. A `session_opened` row must have both halves of the handoff.
    // Answering `201` with two empty strings would hand the buyer nowhere to pay and audit a
    // session that never existed, which is the whole defect the reservation exists to avoid.
    //
    // Two paths conclude a row terminally while keeping the caller's key and never opening a
    // session: the worker ageing out a `created` reservation, and an indefinite rail failure.
    // Those rows legitimately hold a key with no session, and `refuseIfOver` has already answered
    // them. So reaching this line without a session id is corruption, not a lifecycle state.
    // That is why it throws rather than refusing, and why the expiry gate below sits after it.
    if (record.provider_session_id === undefined || record.widget_url === undefined) {
      throw new Error(`funding request ${record.id} holds an idempotency key but opened no session`);
    }

    // The rail's own expiry, matching what `toFundingRequestDto` withholds the settlement surface
    // on, so one row cannot answer `201` with a capture page the rail closed hours ago while
    // `GET /funding/:id` withholds it.
    //
    // This gets its own code because the row is not concluded. `deadlineFor` ignores a rail expiry
    // shorter than `session_max_age_ms` on purpose: bank transfers settle after the capture page
    // closes, so ageing the row out at the page's expiry would mark a paid purchase `expired`. The
    // row legitimately sits `session_opened` with a dead page while the worker keeps asking, and
    // answering `REQUEST_CONCLUDED` would tell the caller to start another, which is the one thing
    // must not happen while a payment may still be in flight.
    //
    // A caller that does not know the code halts on it, which is the safe default, and it clears
    // itself once the worker moves the row to a terminal state. It has no timeout of its own,
    // though: nothing but the worker moves this row, so `worker.enabled: false` strands every
    // buyer here indefinitely.
    //
    // After the invariant above, deliberately. A live row missing its session id or URL is data
    // corruption and must keep surfacing as a `500` rather than being buried as an ordinary
    // refusal.
    if ((record.expires_at ?? Infinity) <= this.clock()) {
      throw reject(
        {
          tag: 'Other',
          value: {
            code: 'REQUEST_SURFACE_EXPIRED',
            message:
              'The payment page for that request has closed. We are still confirming whether it was paid. Check its status rather than starting another.',
            fundingRequestId: record.id,
          },
        },
        `idempotency key replays funding request ${record.id}, whose rail expiry passed at ${String(record.expires_at)}`,
        409,
      );
    }


    this.audit.info(
      {
        event: 'session.created',
        alias: subject.alias,
        productId: subject.productId,
        requestId,
        rail: record.rail,
        providerSessionId: record.provider_session_id,
        destinationCurrencyCode: record.destination_currency_code,
        walletAddress: record.wallet_address,
        sourceAmount: record.source_amount,
        fiat: record.fiat,
      },
      'session replayed from the caller idempotency key',
    );
    return {
      sessionId: record.provider_session_id,
      fundingRequestId: record.id,
      serviceProviderWidgetUrl: record.widget_url,
      ...(record.hosted_widget_url === undefined ? {} : { widgetUrl: record.hosted_widget_url }),
      ...(record.expires_at === undefined ? {} : { expiresAt: record.expires_at }),
      pinned: {
        destinationCurrencyCode: record.destination_currency_code,
        walletAddress: record.wallet_address,
        sourceAmount: record.source_amount,
        fiat: record.fiat,
        ...(record.country === undefined ? {} : { country: record.country }),
      },
    };
  }

  /** One of the caller's requests, or undefined. Scoped by alias + product so a caller cannot read another's. */
  async get(subject: Subject, id: string): Promise<FundingRecord | undefined> {
    return this.funding.byAlias(id, subject.alias, subject.productId);
  }

  /**
   * Withdraw a request the caller no longer wants.
   *
   * The consumer lets a buyer cancel a top-up, and until this existed that cancellation stopped at
   * the client: the row stayed live here and `GET /funding/:id` went on serving the capture page
   * for the rest of the session window. A buyer told their purchase was over still had a payable
   * page open in their name.
   *
   * The store decides in one statement (see `FundingStore.cancel`); this turns "nothing matched"
   * into an answer the caller can act on, which needs a second read because the three reasons are
   * not interchangeable:
   *
   * - unknown, or another caller's -> `404`, the same answer as `get`, so the route is not an
   *   existence oracle.
   * - already paid, or already over -> `409`, and that is not a failure of the cancel so much as
   *   the one case where cancelling would be a lie. The buyer's money is in flight or spent.
   * - already cancelled -> the row as it stands. Cancelling twice is the same request twice, and
   *   answering the second one with an error would make a retried tap look like a fault.
   */
  async cancel(
    subject: Subject,
    id: string,
    requestId: string,
    now = Date.now(),
  ): Promise<FundingRecord | undefined> {
    const cancelled = await this.funding.cancel(subject.alias, subject.productId, id, now);
    if (cancelled !== undefined) {
      this.audit.info(
        { ...this.cancelEvent('session.cancelled', subject, requestId, cancelled) },
        `funding request ${cancelled.id} withdrawn by the caller`,
      );
      return cancelled;
    }

    const existing = await this.funding.byAlias(id, subject.alias, subject.productId);
    if (existing === undefined) return undefined;
    // Already cancelled. No second audit line: nothing changed, and a retried tap is not an event.
    if (existing.cancelled_at !== undefined) return existing;

    const refusal =
      existing.status === 'transaction_seen'
        ? 'A payment is already on its way for that request. It cannot be cancelled.'
        : 'That request has already concluded. There is nothing to cancel.';
    this.audit.info(
      { ...this.cancelEvent('session.cancel_refused', subject, requestId, existing), reason: existing.status },
      `funding request ${existing.id} could not be withdrawn from ${existing.status}`,
    );
    throw reject(
      {
        tag: 'Other',
        value: { code: 'REQUEST_NOT_CANCELLABLE', message: refusal, fundingRequestId: existing.id },
      },
      `funding request ${existing.id} cannot be cancelled from ${existing.status}`,
      409,
    );
  }

  /** The terms half of a cancel audit line, which both outcomes carry identically. */
  private cancelEvent(
    event: 'session.cancelled' | 'session.cancel_refused',
    subject: Subject,
    requestId: string,
    record: FundingRecord,
  ): AuditEvent {
    return {
      event,
      alias: subject.alias,
      productId: subject.productId,
      requestId,
      rail: record.rail,
      destinationCurrencyCode: record.destination_currency_code,
      walletAddress: record.wallet_address,
      sourceAmount: record.source_amount,
      fiat: record.fiat,
      ...(record.country === undefined ? {} : { country: record.country }),
    };
  }

  /** The caller's open and past requests, newest first. */
  async list(subject: Subject, includeRefused = false): Promise<FundingRecord[]> {
    return this.funding.list(subject.alias, subject.productId, undefined, includeRefused);
  }

  /**
   * The configured bounds for one (destination, currency) pair, or the refusal that says why not.
   *
   * Split out so `quote` asks the same question `validate` does. Nothing in the answer depends on
   * what happens between the two calls, so an unsupported currency is worth refusing at the quote
   * rather than at the moment of charge.
   *
   * Limits are keyed by (code, currency): the buyer's fiat picks which bounds apply, so a
   * destination can be offered in USD (card) and EUR (SEPA) at once.
   */
  private async limitFor(
    code: string,
    currency: string,
    country: string,
    method: string,
    onOutage?: 'refuse',
  ): Promise<{ min: string; max: string }>;
  private async limitFor(
    code: string,
    currency: string,
    country: string,
    method: string,
    onOutage: 'ungate',
  ): Promise<{ min: string; max: string } | undefined>;
  /**
   * `onOutage` is what the two callers disagree about, and the disagreement is correct.
   *
   * A catalog outage is not evidence about a corridor. `/session` treats it as a reason to refuse:
   * it is about to charge a card, and the fallback `config.limits` is the operator's own safety net
   * for exactly that window; empty, it fails closed, which is the safe direction for a charge.
   *
   * `/quote` passes `ungate` because applying that same rule to a read-only price path invented an
   * outage the buyer did not have. `values.yaml` floors only DOT/USDC in USD, so every corridor
   * this discovery work added (CAD, EUR and the rest) has no fallback row, and a momentary blip
   * in `/supported/*` refused quotes for precisely the corridors the feature exists to serve, while
   * Meld's own `/quote` was up and would have answered. Nothing is charged by a quote, and Meld
   * still validates the amount when it prices it, so the honest answer is to let the upstream
   * decide rather than to manufacture a local refusal.
   */
  private async limitFor(
    code: string,
    currency: string,
    country: string,
    method: string,
    onOutage: 'refuse' | 'ungate' = 'refuse',
  ): Promise<{ min: string; max: string } | undefined> {
    // Ground truth is Meld's live route catalog, not a hand-maintained list. The old static
    // `config.limits` refused any currency it did not enumerate, so a Canadian buyer met
    // `CURRENCY_UNSUPPORTED` for a CAD corridor Meld served the whole time. When discovery is
    // wired the real corridor is asked; a `config.limits` row then only tightens the live bound as
    // a business floor. When discovery is absent (or Meld's catalog is briefly unreachable), the
    // gate degrades to `config.limits`. That is the fallback allow-list, so a deployment wanting a
    // safety net during a discovery outage keeps it populated; with the default empty `limits` a
    // discovery outage fails closed (every code -> RegionUnavailable), the safe direction for a
    // charge gate.
    if (this.discovery !== undefined) {
      let corridor: Corridor | undefined;
      try {
        corridor = await this.discovery.corridor(country, currency, code);
      } catch (error) {
        // A deliberate refusal is never a reason to fall back.
        //
        // A bare `catch` would turn everything the call can throw into "Meld is unreachable",
        // swallowing a `Refusal` raised inside discovery (a corridor it can see is not offered)
        // and answering from `config.limits`, the one source that cannot know. Parse failures do
        // not reach here, because the schemas fail closed to an empty catalog which surfaces below
        // as `CURRENCY_UNSUPPORTED`. What remains is transport, and only transport degrades.
        if (error instanceof Refusal) throw error;
        corridor = undefined;
      }
      if (corridor !== undefined) {
        if (corridor.methods.length === 0) {
          // No provider routes this crypto to this (country, fiat): the pair is not buyable here.
          throw reject(
            { tag: 'Other', value: { code: 'CURRENCY_UNSUPPORTED', message: 'That currency is not available.' } },
            `No ${code} route for ${country}/${currency}.`,
          );
        }
        const offered = corridor.methods.find((m) => m.paymentMethodType === method);
        if (offered === undefined) {
          throw reject(
            {
              tag: 'Other',
              value: {
                code: 'PAYMENT_METHOD_UNSUPPORTED',
                message: 'That payment method is not available for this region.',
              },
            },
            `Method ${method} not offered for ${country}/${currency}/${code}.`,
          );
        }
        // A configured (code, currency) row is a business floor that tightens the live bound.
        const floor = this.cfg.limits.find((l) => l.code === code && l.currency === currency);
        if (floor === undefined) return { min: offered.min, max: offered.max };
        const min = toMinorUnits(floor.min) > toMinorUnits(offered.min) ? floor.min : offered.min;
        const max = toMinorUnits(floor.max) < toMinorUnits(offered.max) ? floor.max : offered.max;
          // A floor that does not overlap the live bound is refused, not routed around.
          //
          // Returning the live bound instead would discard the operator's cap on the one path where it
          // decides how much a buyer can be charged: with `limits` at 10-2000 and a corridor of 5000-9000
          // the ranges share nothing, and quoting 5000-9000 charges 6000 against a ceiling of 2000.
          //
          // Widening is the wrong direction whichever way the non-overlap falls, so this refuses before any
          // charge and names both ranges, rather than overriding one silently.
        if (toMinorUnits(min) > toMinorUnits(max)) {
          throw reject(
            {
              tag: 'Other',
              value: {
                code: 'CORRIDOR_UNAVAILABLE',
                message: 'That amount range is not available for this region.',
              },
            },
            `Configured limit ${floor.min}-${floor.max} ${currency} does not overlap the live ` +
              `${offered.min}-${offered.max} ${currency} for ${country}/${code}.`,
          );
        }
        return { min, max };
      }
      // `corridor` is undefined only when the catalog call threw: discovery is wired, so this is an
      // outage rather than a deployment without discovery. `/quote` declines to invent a refusal
      // from it; `/session` falls through to the fallback allow-list below.
      if (onOutage === 'ungate') return undefined;
    }
    return this.configLimitFor(code, currency);
  }

  /**
   * The static-config gate, the fallback when discovery is off or unreachable. This is the
   * behaviour the service shipped with: a real destination not configured here is
   * `RegionUnavailable`, a fiat not configured for it is `CURRENCY_UNSUPPORTED`.
   */
  private configLimitFor(code: string, currency: string): { min: string; max: string } {
    const forCode = this.cfg.limits.filter((l) => l.code === code);
    if (forCode.length === 0) {
      throw reject({ tag: 'RegionUnavailable' }, `No configured limits for ${code}.`);
    }
    const limit = forCode.find((l) => l.currency === currency);
    if (limit === undefined) {
      throw reject(
        { tag: 'Other', value: { code: 'CURRENCY_UNSUPPORTED', message: 'That currency is not available.' } },
        `Currency ${currency} is not configured for ${code}.`,
      );
    }
    return { min: limit.min, max: limit.max };
  }

  /**
   * Every local check, in one place, before anything is spent.
   *
   * Returns the pinned terms rather than the requested ones: the normalised address is
   * what gets sent to the rail, recorded, and echoed back, so a caller sees what was committed
   * rather than what it asked for.
   */
  private async validate(request: CreateSessionRequest, rail: FundingRail): Promise<Committed> {
    const destination = resolveDestination(request.destinationCurrencyCode);
    const walletAddress = normalizeAddress(request.walletAddress);
    const currency = request.fiat.toUpperCase();

    // The fiat amount gate is Meld's corridor question; only the fiat rail has one. A non-fiat rail
    // (chainflip) has no fiat corridor and refuses at the rail with its own reason (`RAIL_REFUSED`),
    // so running a Meld corridor/limit check here would preempt that with a misleading currency
    // error. Bounds come from the live (crypto, country, fiat, method) corridor, tightened by any
    // configured business floor; the chosen method picks which bound applies.
    if (rail.provider === 'meld') {
      const limit = await this.limitFor(
        destination.code,
        currency,
        request.country,
        request.paymentMethodType,
      );
      // The threshold rides on the failure, as it does on the Meld-derived form of the same two
      // tags (`server.ts`'s `meld400`). The type has always carried `value`; only the rail's
      // version filled it, so a config-derived refusal reached the buyer as a bare "that amount is
      // below the minimum" with no number in it. A client cannot correct an amount unseen.
      const amount = toMinorUnits(request.sourceAmount);
      if (amount < toMinorUnits(limit.min)) {
        throw reject(
          { tag: 'BelowMinimum', value: { amount: limit.min, currency } },
          `${request.sourceAmount} is below the ${limit.min} minimum.`,
        );
      }
      if (amount > toMinorUnits(limit.max)) {
        throw reject(
          { tag: 'AboveMaximum', value: { amount: limit.max, currency } },
          `${request.sourceAmount} is above the ${limit.max} maximum.`,
        );
      }
    }

    const redirectUrl = this.checkRedirect(request.redirectUrl);

    return {
      pinned: {
        destinationCurrencyCode: destination.code,
        walletAddress,
        sourceAmount: request.sourceAmount,
        fiat: currency,
        country: request.country,
      },
      redirectUrl,
    };
  }

  /**
   * Build a funding row.
   *
   * One constructor rather than two literals, because the two were the same twenty-three fields in
   * the same order differing in six values, and `schema.ts` has already grown the struct three times.
   * `test/fixtures.ts` carries this exact lesson ("the same twenty-three fields were written out in
   * full in four places... the fifth got missed"), and it was applied to the tests and not to the
   * path that spends money.
   *
   * Every field a row can hold that is not yet known is `undefined` here: a row is only ever
   * created before the rail has answered, so no caller has a session id, a URL or an expiry to
   * pass. Those arrive through `update`.
   */
  private newRecord(terms: {
    id: string;
    subject: Subject;
    destinationCurrencyCode: string;
    walletAddress: string;
    sourceAmount: string;
    fiat: string;
    paymentMethodType: string;
    /** Committed like the rest: it selects the provider set and the KYC path at the rail. */
    country?: string | undefined;
    serviceProvider: string | undefined;
    clientReference: string | undefined;
    rail: RailName;
    status: Extract<FundingRecord['status'], 'created' | 'refused'>;
    /** Set on a refusal, absent on `created`: there is nothing yet to explain. */
    reason?: FundingFailure['tag'];
    now: number;
  }): FundingRecord {
    return {
      id: terms.id,
      subject_alias: terms.subject.alias,
      product_id: terms.subject.productId,
      destination_currency_code: terms.destinationCurrencyCode,
      wallet_address: terms.walletAddress,
      source_amount: terms.sourceAmount,
      fiat: terms.fiat,
      payment_method_type: terms.paymentMethodType,
      country: terms.country,
      service_provider: terms.serviceProvider,
      client_reference: terms.clientReference,
      rail: terms.rail,
      provider_session_id: undefined,
      provider_transaction_id: undefined,
      provider_status: undefined,
      widget_url: undefined,
      hosted_widget_url: undefined,
      expires_at: undefined,
      status: terms.status,
      reason: terms.reason,
      status_history: [{ status: terms.status, at: terms.now }],
      created_at: terms.now,
      updated_at: terms.now,
    };
  }

  /**
   * A redirect target must be somewhere this deployment already serves a browser.
   *
   * The scheme is `https:` by the time it gets here (`contract.ts`); what only the service can
   * check is the host, and the honest allowlist is the one the operator already maintains for
   * exactly this population: `cors.allowed_origins`, the front-ends permitted to call this service. A
   * second list would be the same set maintained twice, and the copy that drifts is the one that
   * lets a buyer be landed somewhere the operator never approved.
   *
   * An empty allowlist refuses every redirect rather than allowing any. That is the same posture
   * `buildServer` takes with CORS, where an empty list disables cross-origin calls outright: an
   * operator who has configured no front-ends has not approved a landing page either.
   */
  private checkRedirect(target: string | undefined): string | undefined {
    if (target === undefined) return undefined;
    // Parsed, not string-matched. `https://app.example.attacker.test` has the allowed origin as a
    // prefix, and `https://app.example@attacker.test` has it as userinfo; only an origin
    // comparison rejects both. `includes` is exact: a subdomain of an allowed host, and the
    // registrable parent of one, are both strangers here.
    const url = URL.parse(target);
    // No scheme check here. `config.ts` refuses a plaintext entry in `cors.allowed_origins`
    // outside development, so beyond it the list is https-only and an `http:` target's origin
    // cannot be a member; the check below already refuses it. Enforcing it at boot, in one place,
    // beats a per-request rule that would agree with the allowlist only by construction.
    if (url === null || !originAllowed(this.cfg.cors.allowed_origins, url.origin)) {
      throw reject(
        { tag: 'Other', value: { code: 'REDIRECT_NOT_ALLOWED', message: 'That redirect target is not allowed.' } },
        `redirectUrl origin ${url?.origin ?? '(unparseable)'} is not in cors.allowed_origins`,
      );
    }
    // The normalised href, not the caller's spelling. Checking one representation and
    // committing another is how a guard is bypassed: `https://app.example\@attacker.test/x` has
    // origin `app.example` under WHATWG (which folds `\` to `/`) and hostname `attacker.test`
    // under RFC 3986 (which ends the authority only at `/?#`, then splits at the last `@`). Meld's
    // parser is not this service's to choose. `href` is what both families agree on, and pinning it
    // is the same rule `normalizeAddress` applies to the other caller-supplied value it commits.
    return url.href;
  }

  /**
   * Audit a refusal and record it durably. Returns the refusal, so a caller can `throw` it.
   *
   * One function rather than two called in sequence, because auditing a refusal without recording
   * it (or the reverse) was a pairing held only by convention at each of the two call sites.
   *
   * The terms are the ones submitted, deliberately not the pinned ones: a refusal may be because
   * the address or the code could not be pinned, so there is nothing normalised to record. Only
   * the enumerated tag is logged, never the operator detail; that already reaches the request
   * log, and duplicating it here would put a configured threshold into the audit trail.
   */
  private async refuse(
    subject: Subject,
    requestId: string,
    request: CreateSessionRequest,
    refusal: Refusal,
    rail: RailName,
  ): Promise<Refusal> {
    this.audit.info(
      {
        event: 'session.refused',
        alias: subject.alias,
        productId: subject.productId,
        requestId,
        rail,
        destinationCurrencyCode: request.destinationCurrencyCode,
        walletAddress: request.walletAddress,
        sourceAmount: request.sourceAmount,
        fiat: request.fiat,
        reason: refusal.failure.tag,
      },
      'session refused',
    );

    const now = this.clock();
    try {
      await this.funding.create(
        this.newRecord({
          id: this.newId(),
          subject,
          // The submitted terms, deliberately not pinned ones: a refusal may be because the
          // address or the code could not be pinned, so there is nothing normalised to record.
          destinationCurrencyCode: request.destinationCurrencyCode,
          walletAddress: request.walletAddress,
          sourceAmount: request.sourceAmount,
          fiat: request.fiat.toUpperCase(),
          country: request.country,
          paymentMethodType: request.paymentMethodType,
          serviceProvider: request.serviceProvider,
          // Refused rows carry no reference: the unique index is per (caller, product, reference),
          // and a caller who mistypes an address twice under one key must not be blocked by their
          // own earlier refusal.
          clientReference: undefined,
          rail,
          status: 'refused',
          // The tag the caller was answered with, so the row says why and not only that.
          reason: refusal.failure.tag,
          now,
        }),
      );
    } catch {
      // Deliberately swallowed, and the only swallowed error in this file.
      //
      // The refusal is the answer to the caller, and it is already in the audit log above; the
      // durable row exists so the attempt also appears in the caller's own funding history. A
      // store that cannot take that row (an unreachable instance, a statement timeout) must not
      // turn a deterministic `400` into a `500`, which tells the caller to retry something that
      // will be refused identically for ever. The same store failure surfaces loudly on every
      // path that cannot proceed without it.
    }

    return refusal;
  }
}
