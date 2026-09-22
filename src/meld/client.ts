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
import type { Direction } from '../rail.js';
import type { Secret } from '../secret.js';
import { isDeliveredCrypto } from './catalog.js';

/**
 * Refuse to send a request whose legs contradict its direction.
 *
 * **This exists because Meld would not refuse it.** There is no direction field on a quote
 * request: Meld derives the direction from whether `sourceCurrencyCode` holds a crypto. So a
 * sell whose legs were crossed the wrong way is not a malformed request upstream — it is a
 * perfectly valid *buy*, which Meld prices and answers `200`. A wrong number comes back looking
 * exactly like a right one, and it is the number a seller decides on. Nothing downstream can
 * tell the two apart, because the only thing distinguishing them was which field held which
 * currency.
 *
 * The session endpoint does check (`sessionType` and the leg orientation are validated against
 * each other), so a crossed sell session fails loudly at Meld. That asymmetry is exactly why
 * this cannot be left to the upstream: the more dangerous of the two calls is the unchecked one.
 * The guard runs on both anyway, so the failure is at this service's boundary and says what is
 * actually wrong rather than arriving as a currency complaint about the caller's request.
 *
 * A plain `Error`, not a `Refusal`. Nothing a caller sends can reach it — both the direction and
 * the legs are chosen by this service, from a request the schema has already validated — so it
 * can only fire when this service's own mapping is wrong. That is a `500` and a fault to fix,
 * not a `400` for someone to act on, and it is the same judgement `onramp.ts`'s `committedTerm`
 * makes about a term the schema was supposed to have guaranteed.
 *
 * The test is "a crypto this deployment delivers", not "a crypto"; see `isDeliveredCrypto`.
 */
function assertLegs(direction: Direction, sourceCurrencyCode: string, destinationCurrencyCode: string): void {
  const sourceIsCrypto = isDeliveredCrypto(sourceCurrencyCode);
  if (sourceIsCrypto !== (direction === 'sell')) {
    throw new Error(
      `Meld ${direction}: sourceCurrencyCode "${sourceCurrencyCode}" ${sourceIsCrypto ? 'is' : 'is not'} a ` +
        `delivered crypto, which is wrong for a ${direction}. The legs are crossed in this service's mapping.`,
    );
  }
  // The other way to build a request Meld cannot read as intended, and one the check above
  // cannot see, since it only looks at the source. Exactly one leg is crypto in either
  // direction; two of a kind is a mapping that dropped a leg rather than crossing it.
  if (isDeliveredCrypto(destinationCurrencyCode) === sourceIsCrypto) {
    throw new Error(
      `Meld ${direction}: both legs name the same kind of currency ` +
        `("${sourceCurrencyCode}" -> "${destinationCurrencyCode}"). One leg is fiat in either direction.`,
    );
  }
}

/**
 * Meld's `sessionType`, by this service's direction.
 *
 * A map rather than a ternary, and keyed by `Direction`, so the compiler adds the arm when the
 * tuple in `rail.ts` grows. The enum has a third member Meld enumerates when you send a bad one
 * (`BUY, SELL, TRANSFER`); `TRANSFER` is not a funding direction here and is deliberately absent
 * rather than mapped to something.
 */
const SESSION_TYPE: Readonly<Record<Direction, 'BUY' | 'SELL'>> = Object.freeze({
  buy: 'BUY',
  sell: 'SELL',
});

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
 * `400`, with only the plural form filtering (`200`, one of one).
 *
 * Two corrections to what this comment used to claim, both from a later probe of the same
 * sandbox, and neither changing the code:
 *
 * - The collection is **not** "paginated at ten with no usable offset". Ten is the default page
 *   size; `?limit=100` returned all 74 rows of the account in one page, and `after`/`before`
 *   exist for cursoring. Listing is therefore possible — it is just a worse join than filtering.
 * - `sessionIds` (plural) **is** an accepted filter parameter: the rejected-parameter error
 *   enumerates the whole accepted set and it is in it. Only the singular `?sessionId=` answers
 *   `400`. Whether it actually joins a session to its transaction is untested (no transaction
 *   existed for the probe's sessions), so this stays on the reference, which is observed to
 *   round-trip. If `sessionIds` does join, it removes the whole "the session id is not a join
 *   key" awkwardness in both directions and is worth one follow-up probe.
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
   * `NO_VALID_QUOTES`, or a message "...below the minimum allowed, which is 18.00 EUR"). The
   * status alone cannot tell "no offer", "below minimum", and "malformed" apart (all three are
   * `400`), so a caller that must distinguish them reads these. Never a secret: it is Meld's
   * public error taxonomy, and the body is read without any header.
   *
   * `providerDetail` is the sub-provider's own sentence, from `serviceProviderDetails.message`.
   * It is carried separately rather than folded into `detail` because it is a different
   * statement by a different party: `detail` is Meld's, and on a sell the provider's is the only
   * place the actual threshold appears. **Operator-facing only.** It is prose that differs per
   * provider and per case, and on a sell the number in it is crypto-denominated, so it must not
   * become a wire value that a client reads as fiat. See `refusal.ts`.
   */
  constructor(
    readonly status: number,
    readonly code?: string,
    readonly detail?: string,
    readonly providerDetail?: string,
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

/** What Meld's quote endpoint is asked for, on a buy. */
export interface QuoteParams {
  countryCode: string;
  sourceCurrencyCode: string;
  destinationCurrencyCode: string;
  /** Meld's quote is source-denominated: the buyer names the fiat they will pay and Meld returns
   *  the crypto out. Verified against api-sb.meld.io, which rejects a null `sourceAmount`. */
  sourceAmount: string;
  paymentMethodType: string;
}

/**
 * What the same endpoint is asked for on a sell, named by what each value **is**.
 *
 * Deliberately not `QuoteParams` with the values swapped by the caller. Meld's quote request has
 * no direction flag: it infers the direction purely from whether `sourceCurrencyCode` is a crypto
 * (verified — passing fiat as source on a sell answers "Source currency is not a valid crypto
 * currency"). So on a sell the crypto sits in `sourceCurrencyCode` and the fiat in
 * `destinationCurrencyCode`, exactly inverted from a buy, and a shared struct would mean the same
 * field name holding a different currency depending on a direction the struct does not carry.
 * That is the one confusion this whole split exists to prevent, so the inversion happens here, in
 * the module that owns the wire, once, against fields that say which leg they are.
 */
export interface SellQuoteParams {
  countryCode: string;
  /** The asset being sold. Meld's `sourceCurrencyCode` on a sell. */
  cryptoCurrencyCode: string;
  /** The currency paid out. Meld's `destinationCurrencyCode` on a sell. */
  fiatCurrencyCode: string;
  /**
   * The exact crypto the seller commits. Meld's `sourceAmount` on a sell, and still mandatory:
   * the endpoint rejects a null `sourceAmount` in both directions and ignores a
   * `destinationAmount` sent beside it, so a sell quote answers "what does this much crypto
   * fetch", never "how much must I sell to receive 500".
   *
   * Sent as the caller's exact string. Meld was observed echoing 18 fraction digits back
   * verbatim, with no truncation, rounding or exponent.
   */
  cryptoAmount: string;
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
    /**
     * Nullish because Meld omits it. On a SELL it is not merely often absent but always: the
     * sell session response carries no `expiresAt` key at all (verified), so every sell row's
     * `expires_at` is null and the worker's local ceiling is the whole of its deadline rather
     * than a floor under a provider one. `funding/worker.ts`'s `deadlineFor` already says so.
     */
    expiresAt: z.string().nullish(),
  })
  .loose();

/** What a session carries whichever way the value moves. */
interface WidgetSessionCommon {
  countryCode: string;
  /**
   * How the buyer pays, or how the seller is paid out (`PAYOUT_TO_BANK`, `PAYOUT_TO_CARD`).
   *
   * Required here in both directions, though Meld only requires it on a buy: a SELL session with
   * no `paymentMethodType` is accepted (verified). Sent anyway, because it is the one field that
   * decides how the seller receives their money and letting the provider pick it inside the
   * widget is a term of the sale this service did not commit.
   */
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

/** Opening a buy: the buyer pays fiat and the crypto is delivered to an address they named. */
export interface BuyWidgetSessionParams extends WidgetSessionCommon {
  direction: 'buy';
  /** The crypto delivered. Meld's `destinationCurrencyCode` on a buy. */
  destinationCode: string;
  /** Where it is delivered. Required by Meld on a buy ("must not be blank"), verified. */
  walletAddress: string;
  /** The fiat charged. Meld's `sourceAmount` on a buy. */
  sourceAmount: string;
  /** The currency charged. Meld's `sourceCurrencyCode` on a buy. */
  sourceCurrency: string;
}

/**
 * Opening a sell: the seller commits crypto and the provider pays fiat out.
 *
 * Named by leg rather than by Meld's field, for the reason `SellQuoteParams` gives: Meld infers
 * the direction from the currency types and refuses a session whose source is not a crypto
 * ("Source currency is not a valid crypto currency"), so a sell's `sourceCurrencyCode` is the
 * asset and its `destinationCurrencyCode` is the payout currency.
 *
 * **No `walletAddress`, and that is not an omission.** Verified: Meld does not require one on a
 * SELL (a BUY without one is refused, a SELL without one is `200`), and there is no request-side
 * field for a deposit address under any name — Meld issues the address itself, on the transaction
 * record, after the seller clears KYC. Sending one anyway would be worse than useless: the
 * endpoint silently accepts unknown and meaningless fields (an invalid address, and an entirely
 * invented key, both return `200`), so a `walletAddress` here would be read by nobody while
 * looking, to anyone auditing the request, like a pinned destination.
 */
export interface SellWidgetSessionParams extends WidgetSessionCommon {
  direction: 'sell';
  /** The asset sold. Meld's `sourceCurrencyCode` on a sell. */
  cryptoCurrencyCode: string;
  /** The currency paid out. Meld's `destinationCurrencyCode` on a sell. */
  fiatCurrencyCode: string;
  /** The exact crypto committed. Meld's `sourceAmount` on a sell, and required. */
  cryptoAmount: string;
}

type WidgetSessionParams = BuyWidgetSessionParams | SellWidgetSessionParams;

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
    assertLegs('buy', params.sourceCurrencyCode, params.destinationCurrencyCode);
    return this.postQuote({
      countryCode: params.countryCode,
      sourceCurrencyCode: params.sourceCurrencyCode,
      destinationCurrencyCode: params.destinationCurrencyCode,
      sourceAmount: params.sourceAmount,
      paymentMethodType: params.paymentMethodType,
    });
  }

  /**
   * Offers for a seller: they name the crypto they will send and Meld returns the fiat out.
   *
   * The same path and the same five field names as `quote`, with the legs inverted (see
   * `SellQuoteParams`). There is no `direction`, `category` or `sessionType` on this request and
   * no sell-specific endpoint; verified against api-sb.meld.io, where a crypto `sourceCurrencyCode`
   * is the whole of what makes the answer a sell (`quotes[].transactionType: "CRYPTO_SELL"`).
   *
   * The offers come back under the same schema and are forwarded untouched, but **the fee
   * breakdown means something different** and nothing here converts it. On a buy the fees are
   * fiat and come off the source (`100 - 5.99 = 94.01`); on a sell they are still fiat and come
   * off the **destination** (`631.88 - 12.58 = 619.30`). `sourceAmountWithoutFees` is null on a
   * sell and `destinationAmountWithoutFees` is populated, exactly inverted, and `exchangeRate`
   * becomes fiat-per-crypto. A consumer that assumed "fees are denominated in the same currency
   * as `sourceAmount`" is wrong on a sell; that assumption is not made here, because this
   * forwards the breakdown rather than closing any sum over it.
   */
  async quoteSell(params: SellQuoteParams): Promise<MeldQuote[]> {
    // The load-bearing one. A crossed sell here is a `200` from Meld carrying a buy's price.
    assertLegs('sell', params.cryptoCurrencyCode, params.fiatCurrencyCode);
    return this.postQuote({
      countryCode: params.countryCode,
      sourceCurrencyCode: params.cryptoCurrencyCode,
      destinationCurrencyCode: params.fiatCurrencyCode,
      sourceAmount: params.cryptoAmount,
      paymentMethodType: params.paymentMethodType,
    });
  }

  /**
   * The one place a quote body is sent and its answer read.
   *
   * Shared by both directions because the endpoint is genuinely one endpoint: everything that
   * differs between a buy and a sell is which value each field holds, and that is decided above
   * this line. Duplicating the partial-offer handling per direction would give the sell path its
   * own copy of the rule that one bad provider must not discard the others.
   */
  private async postQuote(request: Record<string, string>): Promise<MeldQuote[]> {
    const body = await this.send('POST', QUOTE, request);

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
   * Create a session with the legs, the amount and (on a buy) the address pinned server-side.
   *
   * Meld locks through a `lockFields` array on `sessionData`, not per-field `*Locked` booleans,
   * which are accepted and silently ignored. Six fields are listed, so the configured `limits`
   * bound the charge, not only the request. `country` is not among them: Meld exposes no lock for
   * it, so the jurisdiction is pinned in this service's record but not enforced upstream.
   *
   * On a buy, `walletAddress` arrives already normalised and `destinationCode` already validated,
   * so neither is re-derived here and each rule lives in exactly one place. Both are sent locked,
   * so a buyer cannot be walked onto a different asset or address inside Meld's own interface.
   *
   * On a sell the legs invert and one endpoint serves both: same path, same envelope, and
   * `sessionType` carries the difference. See `SellWidgetSessionParams` for why there is no
   * address on that side.
   */
  async createWidgetSession(params: WidgetSessionParams): Promise<WidgetSession> {
    // The three fields whose meaning inverts with the direction, resolved once. Meld's names on
    // the left, this service's legs on the right; a sell's source is the crypto and its
    // destination is the fiat, which the server enforces rather than merely accepts (sending
    // fiat as source on a SELL answers "Source currency is not a valid crypto currency").
    //
    // `walletAddress` is in this object rather than below it because it exists on exactly one
    // side. Spreading it means a sell's body does not carry the key at all, as opposed to
    // carrying it empty — and an empty one would be accepted, since this endpoint takes unknown
    // and meaningless fields with a `200`.
    const legs =
      params.direction === 'sell'
        ? {
            sourceCurrencyCode: params.cryptoCurrencyCode,
            destinationCurrencyCode: params.fiatCurrencyCode,
            sourceAmount: params.cryptoAmount,
            // Plain `undefined`, as `serviceProvider` and `redirectUrl` below are: this object
            // is only ever JSON-serialised and `JSON.stringify` drops an undefined value, so the
            // key is genuinely absent from the sell body. Written this way rather than as a
            // conditional spread so both branches emit the same field in the same position, and
            // the bytes a buy POSTs do not depend on which branch produced them.
            walletAddress: undefined,
          }
        : {
            sourceCurrencyCode: params.sourceCurrency,
            destinationCurrencyCode: params.destinationCode,
            sourceAmount: params.sourceAmount,
            walletAddress: params.walletAddress,
          };

    assertLegs(params.direction, legs.sourceCurrencyCode, legs.destinationCurrencyCode);

    // Verified against api-sb.meld.io: the endpoint wants `{ sessionType, sessionData: {...} }`;
    // the flat shape returns "[sessionData] must not be null".
    //
    // `sessionData.serviceProvider` is always present because `contract.ts` requires it. Meld
    // refuses an absent one with the same "must not be null" as an explicit null, so there is
    // nothing to be gained by telling the two apart here.
    const body = await this.send('POST', CREATE_WIDGET_SESSION, {
      sessionType: SESSION_TYPE[params.direction],
      sessionData: {
        // Field by field in the order a buy has always sent them, rather than spreading `legs`.
        // `JSON.stringify` preserves insertion order, so spreading a branch-shaped object made
        // the literal bytes of a buy depend on which branch built it — an invisible change that
        // `toEqual` on a parsed body cannot see, under a claim that buy is byte-identical.
        serviceProvider: params.serviceProvider,
        destinationCurrencyCode: legs.destinationCurrencyCode,
        walletAddress: legs.walletAddress,
        sourceAmount: legs.sourceAmount,
        sourceCurrencyCode: legs.sourceCurrencyCode,
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
        //
        // The same six on a sell, and the list is not direction-dependent. Verified: the enum is
        // validated identically for both session types and the error naming it is byte-identical,
        // so there is no seventh, sell-specific lockable field — nothing for a payout method
        // beyond `paymentMethodType`, nothing for a crypto amount beyond `sourceAmount`, nothing
        // for a bank account. The inversion works in this service's favour, since on a sell
        // `sourceAmount` is the crypto sold and `paymentMethodType` is the payout method, so the
        // two terms that most need pinning are the ones already named.
        //
        // **What is NOT known is whether any of them is honoured on a sell.** All six are
        // accepted there, but so is `walletAddress` when the field it names is absent from the
        // body entirely, so is a malformed address, and so is an invented key — this endpoint
        // takes anything with a `200`, and Meld exposes no session read-back to check against
        // (five paths probed; 404, 403 and 401). Acceptance is therefore no evidence at all. The
        // buy guarantee was established behaviourally and has not been re-established here, and
        // `docs/api.md` says exactly that rather than copying the buy's sentence across. Sent
        // regardless: the asymmetry is the same one-sided one as `cryptoCurrency` above — an
        // ignored lock costs nothing, an absent one costs the term.
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
      // Meld's error body carries its code under `error` on some responses and under `code` on
      // others. Both are read, `error` first, because reading only `error` discarded the code on
      // every body that uses the other spelling — which is every limit rejection in **both**
      // directions. An observed below-minimum body is
      // `{"code":"INVALID_AMOUNT_TOO_LOW","message":"[TRANSAK] Source amount is below the minimum
      // allowed","serviceProviderDetails":{"message":"Minimum sell amount should be more than or
      // equal to 0.00011648 BTC"}}`: no `error` key at all. This comment used to say such a body
      // "carries just the message", and that was a reading of the field this code happened to
      // look at rather than of the body. `refusal.ts` had to match on the message's wording as a
      // result; now it has the code, which is the stabler signal.
      //
      // `serviceProviderDetails.message` is read too, and kept apart from Meld's own message. On
      // a sell it is the only place the threshold appears, and it is crypto-denominated prose, so
      // it goes to the operator and never to the wire.
      let code: string | undefined;
      let detail: string | undefined;
      let providerDetail: string | undefined;
      try {
        const body = (await response.json()) as {
          error?: unknown;
          code?: unknown;
          message?: unknown;
          serviceProviderDetails?: unknown;
        };
        if (typeof body.error === 'string') code = body.error;
        else if (typeof body.code === 'string') code = body.code;
        if (typeof body.message === 'string') detail = body.message;
        const provider: unknown = body.serviceProviderDetails;
        if (typeof provider === 'object' && provider !== null) {
          const nested = (provider as { message?: unknown }).message;
          if (typeof nested === 'string') providerDetail = nested;
        }
      } catch {
        // no JSON body; the status carries the signal on its own
      }
      throw new MeldHttpError(response.status, code, detail, providerDetail);
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
