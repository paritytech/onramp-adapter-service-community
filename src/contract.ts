/**
 * The wire contract.
 *
 * Shaped by the client that already exists: its Meld adapter needs a handoff URL, and its
 * session machine needs an expiry. Nothing here invents a vocabulary
 * the client cannot consume: `FundingFailure` is transcribed from the host's generated
 * types, tag-for-tag, so a rejection is renderable rather than merely logged.
 *
 * What crosses to the client is a scoped, single-buyer widget URL. Never the API key,
 * never a fragment of it, never a token granting direct Meld access.
 */

import { z } from 'zod';
import { MINOR_UNIT_DECIMAL } from './money.js';

import { RAIL_NAMES } from './rail.js';

// --- failures ---------------------------------------------------------------

/**
 * Why a request was refused. Transcribed from the host's `FundingFailure`.
 *
 * Carries an outcome, never a rule: a client classifies these without holding any part
 * of the operator's route configuration. Only the variants this service can actually
 * produce are listed; the rest of the enum describes states a session reaches later,
 * which v0.1 does not track.
 */
export type FundingFailure =
  | { tag: 'RegionUnavailable' }
  // The threshold, when the upstream named one, so a client can show "minimum is 18.00 EUR"
  // rather than a bare "too low". Optional: the config-level check refuses before an amount is known.
  | { tag: 'BelowMinimum'; value?: { amount: string; currency: string } }
  | { tag: 'AboveMaximum'; value?: { amount: string; currency: string } }
  | { tag: 'WrongAssetOrChain' }
  | { tag: 'RouteWithdrawn' }
  | { tag: 'NoQuotesAvailable' }
  | { tag: 'ProviderTimeout' }
  | {
      tag: 'Other';
      value: {
        code: string;
        message: string;
        /**
         * The funding request this refusal is about, when one exists.
         *
         * Present on the four 409s that refuse because a row already exists. Without it those
         * refusals are a dead end: the caller is told a request it cannot name is in the way, so
         * it can neither resume it nor quote it to support. The only escape left is to mint a
         * fresh key, which is how a second settlement surface gets opened.
         *
         * Not an authorization hole: the row was found by `(subject_alias, product_id,
         * client_reference)`, so the caller reaching this branch already owns it.
         */
        fundingRequestId?: string;
      };
    };

/** A refusal, plus the HTTP status it travels under. */
export class Refusal extends Error {
  constructor(
    readonly status: number,
    readonly failure: FundingFailure,
    /** Operator-facing detail. Never serialized to a client. */
    message: string,
  ) {
    super(message);
    this.name = 'Refusal';
  }
}

/** `400`: the request is well-formed but names something this service will not accept. */
export const reject = (failure: FundingFailure, detail: string, status = 400) =>
  new Refusal(status, failure, detail);

/** `503`: Meld did not answer. */
export const upstreamUnavailable = (detail: string) =>
  new Refusal(503, { tag: 'ProviderTimeout' }, detail);

/** The one 401. Identical wording at every site, so a caller cannot tell the failures apart. */
export const unauthorized = (detail: string) =>
  new Refusal(401, { tag: 'Other', value: { code: 'UNAUTHORIZED', message: 'Not authorized.' } }, detail);

/**
 * The one 400 for a request this service could not parse.
 *
 * A factory like the others, because the tag, the code and the exact user-facing sentence were
 * written out three times in `server.ts`: in the framework-error hook, in `parse()`, and in the
 * generic-4xx arm of the error handler. That file's own header claims "all three emit the same
 * `ErrorResponse`", and the sameness was held by copy-paste, so editing one gave a client two
 * different answers for one condition.
 */
export const malformedRequest = (detail: string) =>
  new Refusal(
    400,
    { tag: 'Other', value: { code: 'MALFORMED_REQUEST', message: 'The request was not understood.' } },
    detail,
  );

/**
 * `404`: no such funding request, and no such route. The same body was inlined three times in
 * `server.ts` (the read route, the cancel route, and the not-found handler), so the two
 * user-facing sentences could drift the way `malformedRequest`'s three copies already had. The
 * body is fully specified by `server.test.ts`, so the factory renders it once and the tests keep
 * pinning it.
 *
 * The wire body's message is the same string a caller reads in the error union's `request_id`
 * reply and, via the operator-facing `Refusal.message`, in the logs; all three views stay in
 * lockstep because they are one value, not three copies.
 *
 * The `404` lives here too, and the call sites take it from `.status` rather than writing the
 * literal again. A factory that unified the message and left the status written out three more
 * times would be one source of truth advertising itself as two.
 */
export const notFound = (message: string) =>
  new Refusal(
    404,
    { tag: 'Other', value: { code: 'NOT_FOUND', message } },
    message,
  );

/**
 * `422`: Meld answered, understood the request, and found no provider offering this
 * (payment method, region, asset) combination. Distinct from `ProviderTimeout`: the remedy
 * is a different method or region, not a retry of the same request.
 */
export const noQuotesAvailable = (detail: string) =>
  new Refusal(422, { tag: 'NoQuotesAvailable' }, detail);

// --- requests ---------------------------------------------------------------

/**
 * The vocabulary is the consumer's, which is mostly Meld's. One convention across the surface;
 * no translation layer to be wrong in. README covers the reasoning.
 */
const country = z.string().regex(/^[A-Z]{2}$/, 'Expected a two-letter ISO country code.');

/**
 * ISO 4217. Upper-cased by the caller and compared against the configured currency.
 *
 * Letters, not merely three characters: `length(3)` let `"$$$"` through to Meld on `/quote`,
 * which has no currency comparison to catch it, and the rejection came back as a misleading
 * `503`. Case-insensitive because the value is upper-cased downstream.
 */
const fiat = z.string().regex(/^[A-Za-z]{3}$/, 'Expected a three-letter ISO 4217 currency code.');

/** Meld's payment-method vocabulary: CREDIT_DEBIT_CARD, SEPA, ACH, PIX. Opaque here. */
const paymentMethodType = z.string().min(1).max(48);

const destinationCurrencyCode = z.string().min(1).max(64);

/**
 * Fiat the buyer pays, so at most two fraction digits. Compared as integer minor units, never as
 * a float.
 *
 * Both quote and session are source-denominated: Meld's quote endpoint is source-only (verified:
 * it rejects a null `sourceAmount`), so a buyer who wants "20 of the destination asset" is served
 * by the frontend solving for the fiat against forward quotes, not by asking Meld a reverse question.
 */
const sourceAmount = z
  .string()
  .regex(MINOR_UNIT_DECIMAL, 'Expected a decimal amount with at most two fraction digits.');

/**
 * Supplied by the caller, and required.
 *
 * Enforced here, not merely forwarded: the funding store holds a unique index per
 * (caller, product, key), so a repeat replays the first session rather than opening a second.
 * It must be unique per intent and survive a page reload, because a key regenerated on each load
 * correlates nothing. It is not the reference the rail is given; see `RailSessionInput`.
 */
const idempotencyKey = z.string().min(8).max(200);

/**
 * The transaction id from `/transaction/:id`, the only caller-supplied value reaching a URL.
 *
 * The length bound is the fix, not the charset: an empty id made `encodeURIComponent('')`
 * empty too, collapsing the per-transaction path onto Meld's collection path and returning
 * every transaction on the operator's account. Escaping cannot constrain an absent value.
 */
export const transactionId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/, 'Expected an opaque alphanumeric transaction id.');

/**
 * Where the widget lands the buyer once the purchase completes.
 *
 * Not a bare `z.url()`. Zod 4's URL check constrains the shape, not the scheme, so it accepts
 * `javascript:`, `data:` and `file:`, and this value is handed to a browser immediately after a
 * card has been charged, which is the worst moment to hand anyone an arbitrary scheme. Those are
 * refused here.
 *
 * Whether `http:` is acceptable is a deployment question, not a shape one, so it is decided in
 * `Onramp` where the config is visible: `https:` everywhere except `development`. Requiring
 * `https:` at the schema put this control at odds with the allowlist it shares. `config.ts`'s
 * `origin` regex permits `http://`, so an operator could approve `http://localhost:3000` for CORS
 * and then have a redirect to that same approved origin refused.
 *
 * The 2048 bound is the conventional URL ceiling, and it is well under the 16 KiB body limit, so
 * it bounds the field rather than the request.
 */
export const redirectUrl = z
  .string()
  .max(2048)
  .refine((value) => {
    const protocol = URL.parse(value)?.protocol;
    return protocol === 'https:' || protocol === 'http:';
  }, {
    message: 'Expected an absolute http: or https: URL.',
  });

/**
 * `GET /funding`'s query.
 *
 * `.strict()` like every other schema here, so a typo (`includeRefusals`, `include_refused`)
 * is refused rather than silently read as `false` and answered with a list the caller believes
 * is complete.
 */
export const fundingListQuery = z
  .object({
    /** Opt in to locally refused rows, which are excluded by default. */
    includeRefused: z
      .enum(['true', 'false'])
      .optional()
      .transform((value) => value === 'true'),
  })
  .strict();

/**
 * The redemption body of the personhood handshake.
 *
 * `challenge` and `proof` are base64url (no padding) of the challenges and proofs this service
 * mints/accepts. `ring` is the index within the collection this deployment serves. The collection
 * itself is fixed at boot (config), so the client never names it; a request cannot aim the proof
 * at a foreign ring. `productId` is the product the caller wants to spend as; it is vetted against
 * `allowed_products` at redemption, and binds the proof's context and the minted token's audience.
 */
export const redeemRequest = z
  .object({
    // Bounded like every other string here. A challenge is 56 bytes (75 base64url characters) and
    // a ring proof is under a kilobyte, so these ceilings are generous. The point is that
    // attacker-supplied bytes reach a wasm deserialiser and an HMAC with a stated bound rather
    // than only whatever `bodyLimit` happens to be.
    challenge: z.string().max(128).regex(/^[A-Za-z0-9_-]+$/, 'Expected a base64url challenge token.'),
    proof: z.string().max(8192).regex(/^[A-Za-z0-9_-]+$/, 'Expected a base64url proof.'),
    // A ring index is encoded as a u32 when the People-chain storage key is built
    // (`membersRootKey`), so any value at or beyond 2^32 would silently wrap and read a
    // different ring than the caller declared. Cap it here so the declared index is the
    // index checked.
    ring: z.number().int().min(0).max(0xffff_ffff),
    productId: z.string().min(1).max(128),
  })
  .strict();

/** The body behind `POST /quote`: the corridor to price, and what the buyer will pay. */
export const quoteRequest = z
  .object({
    country,
    fiat,
    destinationCurrencyCode,
    sourceAmount,
    paymentMethodType,
    /** Which funding rail to quote. Absent defaults to `RAIL_NAMES[0]` (meld today). See `src/rail.ts`. */
    rail: z.enum(RAIL_NAMES).optional(),
  })
  .strict();

/** The body behind `POST /session`: everything needed to open one chargeable settlement surface. */
export const createSessionRequest = z
  .object({
    idempotencyKey,
    country,
    fiat,
    destinationCurrencyCode,
    sourceAmount,
    /** SS58 address that receives the tokens. Normalised and validated before use. */
    walletAddress: z.string().min(1).max(128),
    paymentMethodType,
    /**
     * Which onramp to open the session on, e.g. `TRANSAK`.
     *
     * Required, though it reads like it should not be. The intuition (and this schema) was
     * that omitting it lets Meld choose. It does not. Meld refuses an absent
     * `sessionData.serviceProvider` with `must not be null`, the same error it gives for an
     * explicit null. Verified against the live sandbox.
     *
     * So an optional field here bought nothing and cost a metered upstream call: the request
     * passed validation, reached Meld, and came back as "the payment service refused the
     * request", a refusal about the caller's payment when the truth was a field they were told
     * they could leave out. Refusing locally is both cheaper and honest, and it is the rule
     * `onramp.ts` opens with: never spend an upstream call to learn something refusable here.
     *
     * A caller picks one from `POST /quote`, which is where the available providers come from.
     */
    serviceProvider: z.string().min(1).max(48),
    /** Which funding rail to open the session on. Absent defaults to `RAIL_NAMES[0]` (meld today). See `src/rail.ts`. */
    rail: z.enum(RAIL_NAMES).optional(),
    /**
     * Where to land the buyer after the purchase. Absent leaves them on the rail's own page.
     * The scheme is checked here; the host is checked against `cors.allowed_origins` in `Onramp`.
     */
    redirectUrl: redirectUrl.optional(),
  })
  .strict();

/** A validated `POST /quote` body. */
export type QuoteRequest = z.infer<typeof quoteRequest>;
/** A validated `POST /session` body. */
export type CreateSessionRequest = z.infer<typeof createSessionRequest>;

/**
 * The live-capability query behind `GET /supported`: the methods + fiat min/max one corridor
 * offers for one delivered crypto. Read-only and metered by nothing upstream a buyer pays for;
 * it reads a cached view of Meld's public route catalog.
 */
export const supportedQuery = z.object({ country, destinationCurrencyCode }).strict();

/** The query behind `GET /supported/countries`: the region dropdown for one delivered crypto. */
export const supportedCountriesQuery = z.object({ destinationCurrencyCode }).strict();


// --- responses --------------------------------------------------------------

/**
 * Offers, forwarded with the fee breakdown as Meld returned it.
 *
 * `quotes` is Meld's own array, reshaped as little as possible: the frontend needs every fee
 * component to work backwards from a destination amount to the fiat to charge, so nothing is
 * trimmed and unknown fields survive. Components Meld omits are absent rather than defaulted.
 * An invented zero would be worse than a gap the caller can see.
 */
export interface QuoteResponse {
  quotes: unknown[];
  /** Echoed in canonical form, so a caller confirms what was committed rather than assuming. */
  requested: { destinationCurrencyCode: string; sourceAmount: string; fiat: string };
}

/** What a caller gets back from `POST /session`: the two ids, and where to send the buyer. */
export interface CreateSessionResponse {
  sessionId: string;
  /**
   * The durable funding-request id. Unlike Meld's `sessionId`, this is the id the
   * status surface answers, the handle the caller polls with. Meld's id serves a support
   * conversation on Meld's side; this service's serves the funding surface. Both are returned because
   * each owner reaches its own system.
   */
  fundingRequestId: string;
  /** The provider's hosted capture page (Meld's `serviceProviderWidgetUrl`), ready for a WebView. */
  serviceProviderWidgetUrl: string;
  /** Meld's own hosted widget for this session, when Meld returns one; the product embeds this to
   *  keep Meld's flow rather than the raw provider page. */
  widgetUrl?: string;
  /** Unix milliseconds, when Meld supplies one. Absent is honest; a guess would not be. */
  expiresAt?: number;
  /**
   * The terms as sent, with the address normalised.
   *
   * Exact. Four of the five echoed here (destination, address, amount and currency) travel in
   * Meld's `lockFields` array, so the buyer cannot raise the amount or change the asset inside
   * Meld's own flow. (Per-field `*Locked` booleans are silently ignored by Meld; the array is
   * the mechanism that works.) `country` is the fifth and is not lockable: it records what
   * was committed, not what the buyer necessarily transacted under. `paymentMethodType` is
   * locked but is not echoed here.
   */
  pinned: {
    destinationCurrencyCode: string;
    walletAddress: string;
    sourceAmount: string;
    fiat: string;
    /**
     * Optional only because rows written before the country column exists do not carry one. Every
     * request this build serves pins it, and a replay that omitted it would be echoing terms it
     * cannot actually vouch for.
     */
    country?: string;
  };
}

/**
 * Meld's transaction, projected onto the five fields this service declares. `status` is Meld's
 * string and is opaque here. The parse stays loose and the wire stays declared; see
 * `Onramp.transaction`, which performs the projection rather than forwarding the parsed object.
 */
export interface TransactionResponse {
  transaction: unknown;
}

/** The only error body a client ever sees. No rule text, no upstream payload, no detail. */
export interface ErrorResponse {
  error: FundingFailure;
  request_id: string;
}
