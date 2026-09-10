/**
 * The only module that reads the API key.
 *
 * Three authenticated calls a browser cannot make itself, plus `authedGet` for the discovery
 * layer (`meld/discovery.ts`). Meld's `/network-partner/supported/*` endpoints answer without a
 * key, but a keyed call scopes them to this account's enabled providers (the same set the quote
 * endpoint prices), so the region catalog and the quote agree instead of the catalog advertising
 * corridors this account cannot actually buy. The key still has one reader: discovery calls
 * through `authedGet` rather than reading the secret itself.
 *
 * No retries and no circuit breaker: a retry on session creation cannot distinguish "Meld never
 * saw it" from "Meld created a session and the response was lost".
 */

import { z } from 'zod';

import { upstreamUnavailable } from '../contract.js';
import type { Secret } from '../secret.js';

/**
 * Endpoint paths.
 *
 * `/payments/crypto/quote` and `/crypto/session/widget` are confirmed by the integrating client.
 *
 * TODO(sandbox): the transaction lookup is reported rather than confirmed here, and there is a
 * known inconsistency to resolve with it: `createWidgetSession` returns Meld's session id,
 * while this is the transaction path. A live-sandbox probe found Meld exposes no per-session
 * lookup and that `?sessionId=` on the collection answers `400`, so the session id is not a
 * usable join even though the transaction record carries one; the reference is. A wrong path here
 * answers 404, but boot never calls it (the probe is a quote), so nothing catches it before a
 * buyer does.
 */
const QUOTE = '/payments/crypto/quote';
const CREATE_WIDGET_SESSION = '/crypto/session/widget';
const transactionPath = (id: string) => `/payments/transactions/${encodeURIComponent(id)}`;
/**
 * Search by the reference the session was filed under.
 *
 * A transaction only exists once the buyer pays and is not keyed by the session id, so the
 * external reference sent at session creation is the only join key back to it.
 *
 * The parameter is `externalSessionIds`, plural. The alternatives were probed against
 * `api-sb.meld.io` and reported `?externalSessionId=`, `?sessionId=` and `?offset=` all answering
 * `400`, with only the plural form filtering (`200`, one of one). Listing the collection instead
 * is not an option: it is paginated at ten with no usable offset, so a busy account hides the row
 * the wanted one behind other accounts' transactions.
 */
const transactionSearchPath = (reference: string) =>
  `/payments/transactions?externalSessionIds=${encodeURIComponent(reference)}`;

/**
 * Meld answered, and said no.
 *
 * The distinction that matters is whether Meld answered at all, not which status it chose.
 * An HTTP status means the request arrived and was understood well enough to be rejected (a
 * wrong key, a wrong path, wrong parameters), and none of those improve on their own. A
 * transport failure says nothing about the configuration and a rollout must survive it. So
 * this carries the status and each caller decides: fatal at boot, degraded at runtime.
 */
export class MeldHttpError extends Error {
  /**
   * Meld's own error code and human message from the response body when it sent them (e.g. code
   * `NO_VALID_QUOTES`, or a message "...below the minimum allowed, which is 18.00 EUR" that carries
   * no code at all). The status alone cannot tell "no offer", "below minimum", and "malformed"
   * apart (all three are `400`), so a caller that must distinguish them reads these. Never a
   * secret: it is Meld's public error taxonomy, and the body is read without any header.
   */
  constructor(
    readonly status: number,
    readonly code?: string,
    readonly detail?: string,
  ) {
    super(`Meld answered HTTP ${String(status)}.`);
    this.name = 'MeldHttpError';
  }
}

// --- quote ------------------------------------------------------------------

/** An amount, kept as the exact text Meld sent rather than parsed to a number. */
const scalarAmount = z.string();

/**
 * One provider's offer, with the whole fee breakdown.
 *
 * Every component is forwarded because the client works backwards from "the buyer wants X of
 * the destination asset" to the fiat to charge, and that sum only closes if the breakdown is
 * complete. Dropping a component here would silently move the error into someone else's
 * arithmetic.
 *
 * Passthrough is bounded rather than blind: named fields are typed, unknown ones are carried
 * but not depended on, and a response that cannot be read at all is an upstream failure
 * rather than a partial answer.
 *
 * Amounts are always strings. `parseExact` below keeps every number as the exact text Meld
 * sent, because these are the components the deposit arithmetic closes over and a fee altered
 * by a JSON round-trip is a wrong fiat charge.
 */
const quoteSchema = z
  .object({
    serviceProvider: z.string(),
    sourceAmount: scalarAmount,
    sourceCurrencyCode: z.string(),
    destinationAmount: scalarAmount,
    destinationCurrencyCode: z.string(),
    exchangeRate: scalarAmount.nullish(),
    totalFee: scalarAmount.nullish(),
    transactionFee: scalarAmount.nullish(),
    networkFee: scalarAmount.nullish(),
    partnerFee: scalarAmount.nullish(),
    paymentMethodType: z.string().nullish(),
  })
  .loose();

/**
 * The envelope only. Offers are read one at a time, not as a unit.
 *
 * `z.array(quoteSchema)` parsed the whole array together, so one provider returning a partial
 * offer discarded every good offer beside it and the caller got `503 ProviderTimeout`: a
 * retry instruction for something that would never change, while working offers existed. A
 * quote response is a list of independent offers from different providers, so one provider's
 * bad payload is no evidence about the others.
 */
const quoteEnvelope = z.object({ quotes: z.array(z.unknown()).nullish() }).loose();

type MeldQuote = z.infer<typeof quoteSchema>;

/** What Meld's quote endpoint is asked for. */
export interface QuoteParams {
  countryCode: string;
  sourceCurrencyCode: string;
  destinationCurrencyCode: string;
  /** Meld's quote is source-denominated: the buyer names the fiat they will pay and Meld returns
   *  the crypto out. Verified against api-sb.meld.io, which rejects a null `sourceAmount`. */
  sourceAmount: string;
  paymentMethodType: string;
}

// --- session ----------------------------------------------------------------

const widgetSessionResponse = z
  .object({
    id: z.string().min(1),
    /** The provider's hosted capture page (e.g. Transak). Verified present against api-sb.meld.io. */
    serviceProviderWidgetUrl: z.url(),
    /** Meld's own hosted widget for this session (meldcrypto.com). A product that wants to embed
     *  Meld's UI rather than the raw provider page opens this. Verified present in the response. */
    widgetUrl: z.url().nullish(),
    expiresAt: z.string().nullish(),
  })
  .loose();

interface WidgetSessionParams {
  destinationCode: string;
  walletAddress: string;
  sourceAmount: string;
  sourceCurrency: string;
  countryCode: string;
  paymentMethodType: string;
  /**
   * Pins one onramp, e.g. `TRANSAK` or `KOYWE`.
   *
   * Optional on this type only; in practice always supplied, because Meld refuses an absent
   * `sessionData.serviceProvider` with `must not be null`. `createSessionRequest` therefore
   * requires it on the wire, so a caller is refused locally rather than upstream.
   */
  serviceProvider?: string | undefined;
  /**
   * Filed as Meld's top-level `externalSessionId`, and as `externalCustomerId` for the operator's
   * dashboard. This is the funding row's own id, never the caller's key. See
   * `RailSessionInput.clientReference` for why.
   */
  clientReference: string;
  /**
   * Where Meld's widget lands the buyer once the purchase completes. Absent leaves them on
   * Meld's own page. Validated against the CORS origin allowlist before it reaches here; an
   * unchecked value here is an open redirect handed to someone who has just paid.
   */
  redirectUrl?: string | undefined;
}

interface WidgetSession {
  meldSessionId: string;
  /** The provider's hosted capture page (serviceProviderWidgetUrl). */
  serviceProviderWidgetUrl: string;
  /** Meld's own hosted widget for this session, when Meld returns one. */
  meldWidgetUrl?: string;
  expiresAt?: number;
}

// --- transaction ------------------------------------------------------------

/**
 * A transaction as Meld reports it.
 *
 * `status` stays a string rather than an enum: the vocabulary is not documented anywhere this
 * can read, so pinning it would reject values that turn out to be real. It is forwarded
 * verbatim and treated as opaque.
 */
const transactionResponse = z
  .object({
    id: z.string().min(1),
    status: z.string().nullish(),
    // Both join keys, because the re-check below has to see whichever one Meld populates.
    externalSessionId: z.string().nullish(),
    externalCustomerId: z.string().nullish(),
    sourceAmount: scalarAmount.nullish(),
    destinationAmount: scalarAmount.nullish(),
    serviceProvider: z.string().nullish(),
  })
  .loose();

/** One transaction as Meld reports it. Every join field is nullish; Meld omits them freely. */
export type MeldTransaction = z.infer<typeof transactionResponse>;

/**
 * A search answer. Meld has been observed to wrap collections in `transactions`, so both the
 * bare array and the wrapper are accepted rather than guessing which.
 */
const transactionSearchResponse = z.union([
  z.array(transactionResponse),
  z.object({ transactions: z.array(transactionResponse) }).loose(),
]);

// --- client -----------------------------------------------------------------

export class MeldClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: Secret,
    private readonly apiVersion: string,
    private readonly timeoutMs: number,
  ) {}

  /**
   * A keyed GET for the discovery layer, scoping the answer to this account's enabled providers
   * (verified live: a sandbox account returns only its onboarded provider set), which is exactly
   * what the quote will price. Kept here so the key keeps a single reader.
   */
  async authedGet(path: string): Promise<unknown> {
    return this.send('GET', path);
  }

  /**
   * An unkeyed GET for the discovery layer: the same `/network-partner/supported/*` endpoints
   * return the global provider set with no key. A deployment whose account has every provider
   * enabled can use this so the catalog is the full global one; a partial account should stay on
   * `authedGet`, or the catalog advertises corridors the quote would refuse.
   */
  async publicGet(path: string): Promise<unknown> {
    return this.send('GET', path, undefined, false);
  }

  /**
   * Offers for a buyer, source-denominated: they name the fiat they pay and Meld returns the crypto.
   *
   * Confirmed against api-sb.meld.io: the endpoint is source-only; it rejects a null `sourceAmount`
   * ("[sourceAmount] must not be null"). A buyer who wants "20 of the destination asset" is served by
   * the caller solving for the fiat against forward quotes, not by a reverse question.
   */
  async quote(params: QuoteParams): Promise<MeldQuote[]> {
    const body = await this.send('POST', QUOTE, {
      countryCode: params.countryCode,
      sourceCurrencyCode: params.sourceCurrencyCode,
      destinationCurrencyCode: params.destinationCurrencyCode,
      sourceAmount: params.sourceAmount,
      paymentMethodType: params.paymentMethodType,
    });

    const offers = this.read(quoteEnvelope, body, 'quote').quotes ?? [];
    const readable = offers.flatMap((offer) => {
      const parsed = quoteSchema.safeParse(offer);
      return parsed.success ? [parsed.data] : [];
    });

    // Every offer unreadable when there were offers to read is systemic (a changed response
    // shape rather than one provider having a bad minute), so it stays an upstream failure.
    // A partial drop is not reported anywhere, which is a real if minor gap: this client is
    // constructed before the logger exists, deliberately, because it must not depend on the
    // server. Serving the readable offers beats discarding them to preserve a log line.
    if (offers.length > 0 && readable.length === 0) {
      throw upstreamUnavailable(`Meld returned ${String(offers.length)} quotes, none readable.`);
    }

    return readable;
  }

  /**
   * Create a session with the destination and address pinned server-side.
   *
   * The amount too. Meld locks through a `lockFields` array on `sessionData`, not per-field
   * `*Locked` booleans, which are accepted and silently ignored. Six fields are listed, so the configured
   * `limits` bound the charge, not only the request. `country` is not among them: Meld exposes
   * no lock for it, so the jurisdiction is pinned in this service's record but not enforced upstream.
   *
   * `walletAddress` arrives already normalised and `destinationCode` already validated, so
   * neither is re-derived here and each rule lives in exactly one place. Both are sent locked,
   * so a buyer cannot be walked onto a different asset or address inside Meld's own interface.
   */
  async createWidgetSession(params: WidgetSessionParams): Promise<WidgetSession> {
    // Verified against api-sb.meld.io: the endpoint wants `{ sessionType, sessionData: {...} }`;
    // the flat shape returns "[sessionData] must not be null".
    //
    // `sessionData.serviceProvider` is always present because `contract.ts` requires it. Meld
    // refuses an absent one with the same "must not be null" as an explicit null, so there is
    // nothing to be gained by telling the two apart here.
    const body = await this.send('POST', CREATE_WIDGET_SESSION, {
      sessionType: 'BUY',
      sessionData: {
        serviceProvider: params.serviceProvider,
        destinationCurrencyCode: params.destinationCode,
        walletAddress: params.walletAddress,
        sourceAmount: params.sourceAmount,
        sourceCurrencyCode: params.sourceCurrency,
        countryCode: params.countryCode,
        paymentMethodType: params.paymentMethodType,
        // Meld's whole lockable vocabulary is six values, and it names them when you send a
        // seventh: `cryptoCurrency, destinationCurrencyCode, paymentMethodType, sourceAmount,
        // sourceCurrencyCode, walletAddress`. Observed against the live sandbox, and all six are
        // listed here.
        //
        // Whether `cryptoCurrency` constrains anything `destinationCurrencyCode` does not is
        // unverified. They may be the same concept at different granularity (`DOT` against
        // `DOT_ASSETHUB`), or the widget's asset picker may bind to one and not the other. Listed
        // anyway, because the asymmetry is one-sided: a redundant lock costs nothing, and an
        // absent one leaves the buyer walkable onto another asset if it is the field that matters.
        //
        // `countryCode` is not on the list and cannot be. It is sent above but is not lockable
        // under any name: `country`, `sourceCountry` and `countryCodeAlpha2` are all refused too.
        // So a buyer can change jurisdiction inside Meld after this service pinned one, and the
        // provider set, fee schedule and KYC path change with it. The remaining defence has to be
        // a comparison after the fact, not a lock. That comparison does not exist yet, so the
        // exposure is live, not closed.
        lockFields: [
          'cryptoCurrency',
          'destinationCurrencyCode',
          'walletAddress',
          'sourceAmount',
          'sourceCurrencyCode',
          'paymentMethodType',
        ],
        // Kept alongside the top-level `externalSessionId` below rather than replaced by it. A probe
        // reports this field coming back `null` on every transaction, which is why it stopped being
        // the join key. But that is one unverified reading of one sandbox account, and dropping it
        // would remove the only reference the operator's own Meld dashboard shows against a buyer.
        externalCustomerId: params.clientReference,
        // Plain assignment, like serviceProvider above: this object is only ever JSON-serialised,
        // and JSON.stringify drops an undefined value, so a conditional spread would render the
        // identical bytes.
        redirectUrl: params.redirectUrl,
      },
      // The join key, at the top level of the request rather than inside `sessionData`: that
      // placement is what makes it round-trip onto the transaction record (observed, not assumed).
      externalSessionId: params.clientReference,
    });

    const session = this.read(widgetSessionResponse, body, 'session');
    const expiresAt = toEpochMillis(session.expiresAt);

    return {
      meldSessionId: session.id,
      serviceProviderWidgetUrl: session.serviceProviderWidgetUrl,
      ...(session.widgetUrl == null ? {} : { meldWidgetUrl: session.widgetUrl }),
      ...(expiresAt === undefined ? {} : { expiresAt }),
    };
  }

  async transaction(id: string): Promise<MeldTransaction> {
    const body = await this.send('GET', transactionPath(id));
    return this.read(transactionResponse, body, 'transaction');
  }

  /**
   * The transaction filed under `reference`, or nothing.
   *
   * The match is re-checked here rather than trusted. A query parameter a server does not
   * understand is commonly ignored rather than rejected, and an ignored filter on a collection
   * endpoint returns the operator's other transactions. Taken at face value, that would
   * settle one buyer's funding request against another buyer's payment. So every returned row
   * must carry back the reference that was asked for, and anything else is discarded.
   *
   * More than one match is ambiguous and throws: two payments under one reference is not
   * something to resolve by picking the first.
   *
   * The endpoint shape is reported rather than verified here, which is exactly why the re-check
   * above is not optional.
   */
  async transactionByReference(reference: string): Promise<MeldTransaction | undefined> {
    const body = await this.send('GET', transactionSearchPath(reference));
    const parsed = this.read(transactionSearchResponse, body, 'transaction search');
    const rows = Array.isArray(parsed) ? parsed : parsed.transactions;

    // Either field, because which one Meld populates is exactly what is unverified. The session
    // reference in both, and a row matches if it carries it back in either. So the re-check
    // survives whichever field turns out to be the live one, and still discards a row that
    // carries neither. Matching on both widens nothing: a row must still carry this reference.
    const mine = rows.filter(
      (row) => row.externalSessionId === reference || row.externalCustomerId === reference,
    );

    if (mine.length > 1) {
      throw new Error(`Meld returned ${String(mine.length)} transactions for one external reference.`);
    }

    // Answered, but with nothing matching. The query is already filtered by this reference
    // (`?externalSessionIds=`), so rows coming back that do not carry it in either field is
    // evidence that the filter or the fields are not as documented, which is precisely the part
    // of this endpoint that remains unverified.
    //
    // Returning `undefined` here would say "no transaction yet", and the worker would keep waiting
    // and then conclude `expired`: a claim that the buyer did not pay, made on the strength of
    // a join there is reason to believe is broken. Throwing instead surfaces it in the tick log and
    // lets the row age out as `unobserved`, meaning it could not be told. That is the one distinction
    // `state.ts` says this record must never get wrong.
    //
    // It cannot help when Meld answers with an empty list for a buyer who paid. Nothing here can;
    // only a real paid transaction settles that, which is why it is still an open gap.
    if (rows.length > 0 && mine.length === 0) {
      throw new Error(
        `Meld returned ${String(rows.length)} transaction(s) for reference ${reference} and none carried it back. ` +
          'The settlement join is not what this client expects.',
      );
    }
    return mine[0];
  }

  /**
   * Prove at boot that the key works and the endpoints are real.
   *
   * A quote is the cheapest authenticated call that exercises a path the service depends on, and it
   * moves no money. Throws `MeldHttpError` when Meld answers with any error status; a
   * transport failure raises the retryable `Refusal` instead, which the caller tolerates.
   */
  async verifyCredentials(probe: QuoteParams): Promise<number> {
    return (await this.quote(probe)).length;
  }

  /** One place where an unreadable upstream body becomes an upstream failure. */
  private read<T>(schema: z.ZodType<T>, body: unknown, what: string): T {
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw upstreamUnavailable(`Meld returned an unreadable ${what}: ${parsed.error.message}`);
    }
    return parsed.data;
  }

  private async send(
    method: 'GET' | 'POST',
    path: string,
    payload?: unknown,
    // Discovery's `publicGet` sends `false` to omit the key: the same endpoint returns the global
    // provider set unkeyed and this account's set keyed, and a deployment may want either.
    authed = true,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(new URL(path, this.baseUrl), {
        method,
        headers: {
          // The literal word BASIC precedes the key. This is not HTTP Basic auth and the value
          // is not base64; a plausible "fix" to either breaks every request.
          ...(authed ? { authorization: `BASIC ${this.apiKey.expose()}` } : {}),
          'Meld-Version': this.apiVersion,
          accept: 'application/json',
          ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
        // A Meld API call has no legitimate redirect. Following one would forward some other
        // host's body to the caller through the two verbatim-forwarding routes. (undici already
        // strips `Authorization` cross-origin, so the key itself does not travel either way;
        // this closes the response leg.) A redirect now fails as a transport error, which is the
        // retryable `ProviderTimeout` degrade.
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (cause) {
      // Transport failure or timeout. Operator-facing only, and it may name the URL but never
      // a header, because that is where the key lives.
      throw upstreamUnavailable(
        `Meld ${method} ${path} failed: ${cause instanceof Error ? cause.message : 'unknown error'}`,
      );
    }

    if (!response.ok) {
      // Meld's error body is `{ error: "CODE", message: "..." }`, or sometimes only one of the two
      // (a below-minimum rejection carries just the message). Read both best-effort so the caller
      // can tell "no offer" (NO_VALID_QUOTES) and "below minimum" apart from a genuine outage. A
      // missing or unparseable body just means no code, and the status still degrades.
      let code: string | undefined;
      let detail: string | undefined;
      try {
        const body = (await response.json()) as { error?: unknown; message?: unknown };
        if (typeof body.error === 'string') code = body.error;
        if (typeof body.message === 'string') detail = body.message;
      } catch {
        // no JSON body; the status carries the signal on its own
      }
      throw new MeldHttpError(response.status, code, detail);
    }

    try {
      return parseExact(await response.text());
    } catch {
      // An HTML error page or an empty body throws here. Unhandled that becomes a 500 with an
      // upstream payload in the log, so it is caught and the text dropped.
      throw upstreamUnavailable(`Meld ${method} ${path} returned a body that is not JSON.`);
    }
  }
}

/**
 * Read an upstream body, keeping every number as the exact text Meld sent.
 *
 * `response.json()` makes a JSON number a double, which loses trailing zeros, adds exponents to
 * small values, and rounds past 2^53. Numbers in unnamed fields become strings too: a
 * proxy cannot tell which unknown field is money, and exactness matters more here than a JSON
 * type nothing in this service computes on.
 */
function parseExact(text: string): unknown {
  return JSON.parse(text, function (_key: string, value: unknown, context?: { source?: string }) {
    return typeof value === 'number' && context?.source !== undefined ? context.source : value;
  });
}

/** Below this an "epoch" value is not milliseconds: 2001-09-09, comfortably before Meld. */
const MIN_PLAUSIBLE_MILLIS = 1e12;
/** The ECMAScript time-value clip. `Number.isFinite` passes values `new Date()` cannot hold. */
const MAX_TIME_VALUE = 8.64e15;

/**
 * Meld's expiry as Unix milliseconds, or nothing.
 *
 * A guess is worse than an absence here: the consumer's session machine either kills a live
 * widget or walks a buyer into an expired session with card details already entered. So four
 * plausible-looking forms are refused rather than coerced: epoch seconds (which land in 1970),
 * ISO without an offset (shifted by the host's zone, differently per deployment), magnitudes
 * `Date` cannot hold, and a bare year that `Date.parse` would expand.
 */
function toEpochMillis(value: string | number | null | undefined): number | undefined {
  const raw = typeof value === 'number' ? String(value) : value;
  if (typeof raw !== 'string') return undefined;

  if (/^\d+$/.test(raw)) {
    const millis = Number(raw);
    return millis >= MIN_PLAUSIBLE_MILLIS && millis <= MAX_TIME_VALUE ? millis : undefined;
  }

  // An explicit offset is required: without one `Date.parse` applies the host's zone, so the
  // same response means a different instant in every deployment.
  if (!/^\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})$/.test(raw)) return undefined;
  const millis = Date.parse(raw);
  return Number.isFinite(millis) ? millis : undefined;
}
