/**
 * The funding-rail seam.
 *
 * A funding "rail" is the entire lifespan of a request on one provider: quote, open a settlement
 * surface for the buyer, and let the worker observe the outcome. Before a second provider existed
 * this was a deliberate non-abstraction; with Chainflip alongside Meld it becomes a port. The port
 * carries exactly what a rail is asked to do today. A method no rail implements, or one invented
 * for symmetry, is dead weight and is cut.
 *
 * The discriminator is a distinct `rail` value, never Meld's `service_provider`. `serviceProvider`
 * is a Meld-internal sub-provider pin (`TRANSAK`, `KOYWE`); overloading it with `CHAINFLIP` would
 * fuse "which rail" and "which provider inside that rail" into one muddy string. Selection is by
 * `rail`, routing through this registry, and an unregistered rail is refused locally before any
 * upstream call.
 */

/** The rails this build knows how to represent on a funding row. */
export const RAIL_NAMES = ['meld', 'chainflip'] as const;

/**
 * The rail a request names when it omits `rail`.
 *
 * Single owner by construction: `RAIL_NAMES[0]` is both the wire default (`contract.ts` hands an
 * absent `rail` an `undefined` that `Onramp.rail()` resolves here) and the registry order, so
 * reordering the array or renaming a rail cannot leave the default spelling a rail the schema does
 * not know.
 */
export const DEFAULT_RAIL: RailName = RAIL_NAMES[0];

/** A rail's stable identity. Stored on the funding row and on the wire. */
export type RailName = (typeof RAIL_NAMES)[number];

/** Everything the quote leg needs from a wire `quoteRequest`. */
export interface RailQuote {
  countryCode: string;
  sourceCurrencyCode: string;
  destinationCurrencyCode: string;
  sourceAmount: string;
  paymentMethodType: string;
}

/** Everything the session leg needs from a wire `createSessionRequest`. */
export interface RailSessionInput {
  destinationCode: string;
  walletAddress: string;
  sourceAmount: string;
  fiat: string;
  countryCode: string;
  paymentMethodType: string;
  /** The rail-internal pin (`TRANSAK`, ...); `undefined` lets the rail choose. */
  serviceProvider: string | undefined;
  /**
   * The reference the rail files this session under, and the worker's join key back to it.
   *
   * This is the funding record's own id, not the caller's `idempotencyKey`. That key is
   * unique only per (caller, product) here while a rail's reference namespace is global, so two
   * callers sharing one would file two sessions under a single reference and the worker could
   * settle the unpaid caller's request against the other's payment.
   */
  clientReference: string;
  /**
   * Where the rail's hosted surface lands the buyer once the purchase completes.
   *
   * Neutral because "return the buyer to where they came from" is not Meld-specific; a rail with
   * no hosted surface ignores it. Already validated against the CORS origin allowlist by the time
   * it reaches a rail; no rail re-checks it, so nothing may reach one unvalidated.
   */
  redirectUrl: string | undefined;
}

/**
 * What opening a settlement surface yields: the buyer-facing handle + worker lookup facts.
 *
 * `settlementUrl` and `providerSessionId` are required, and that is load-bearing. A session with
 * no buyer-facing surface would be reported as created while handing the buyer nowhere to
 * pay; a session with no rail id is one the worker can never join back to the rail, so it could
 * never be observed or concluded. Neither is a session. A rail that cannot produce both must
 * throw rather than return a hollow one, and the wire response is built from these directly
 * instead of defaulting a missing value to `''`.
 *
 * `expiresAt` stays optional because Meld genuinely omits it. The worker bounds those with a
 * local ceiling (`worker.session_max_age_ms`) rather than trusting every rail to supply one.
 */
export interface RailSession {
  /**
   * The settlement surface the buyer is sent to: the provider's own capture page.
   *
   * Kept distinct from `hostedWidgetUrl`. Folding the two into one value loses the provider page
   * entirely and silently gives a caller branching on which surface it got the wrong answer.
   */
  settlementUrl: string;
  /** The rail's own hosted alternative to that page, where it offers one. Meld does; Chainflip does not. */
  hostedWidgetUrl: string | undefined;
  /** When the settlement surface lapses unpaid. Absent means "the worker's local ceiling decides". */
  expiresAt: number | undefined;
  /** The rail's own session/swap id, the worker's finder key. */
  providerSessionId: string;
}

/**
 * One funding rail's implementer.
 *
 * `quote` and `createSession` are the two rail-dispatched routes. `transaction` (the verbatim
 * `/transaction/:id` status surface) is deliberately not on the port: it is Meld-shaped and
 * un-scoped (threat-model R12), so it lives on the Meld adapter alone and is read through a
 * separate seam, not forced onto every rail.
 */
export interface FundingRail {
  readonly provider: RailName;
  /** The fee-bearing offers. The request echo is the caller's to build; it already holds it. */
  quote(input: RailQuote): Promise<unknown[]>;
  createSession(input: RailSessionInput): Promise<RailSession>;
}

/**
 * The fields `/transaction/:id` may surface.
 *
 * Declared rather than `unknown`. The client parses the response with a `.loose()` schema so a
 * field Meld adds does not break it; naming the fields here stops that tolerance flowing to the
 * wire, on a route that is authenticated but not scoped to the transaction's owner (R12), and
 * makes the projection in `Onramp.transaction` a decision rather than an omission.
 */
export interface RailTransaction {
  id: string;
  status?: string | null | undefined;
  sourceAmount?: string | null | undefined;
  destinationAmount?: string | null | undefined;
  serviceProvider?: string | null | undefined;
}

/** The read-only legacy surface: Meld's `/transaction/:id` (R12). */
export interface MeldTransactionReader {
  transaction(id: string): Promise<RailTransaction>;
}

/**
 * Registered rails by name. An unregistered rail is the "not wired" case. `Onramp.rail()` refuses
 * a request for it locally before any upstream call, rather than fabricating a call. Both rails
 * are registered today: Chainflip is present precisely so its refusal names the real reason (no
 * fiat leg) instead of "rail not wired".
 */
export type RailRegistry = Readonly<Partial<Record<RailName, FundingRail>>>;
