/**
 * The funding-request state machine.
 *
 * The funding release turns the transient Meld session into a durable, addressable record whose
 * lifecycle advances even when no SPA is open. This module is the part of that with no I/O: it
 * describes which state a request can legally move to, and refuses anything else. Keeping it pure
 * is what lets a test exhaust the whole surface without a store or a clock.
 *
 * `status` is deliberately derived from the machine's own vocabulary, not from Meld's opaque
 * transaction strings. Meld's `status` values are not documented anywhere readable, so the client
 * treats them as opaque (see `meld/client.ts`); the machine instead carries its own coarse
 * lifecycle (session opened, transaction seen, settled, failed) and lets Meld's finer status ride
 * along on the row for whoever can read it.
 */

/**
 * The lifecycle of one funding request, in the order it can move through.
 *
 * A request enters at `created` (the reservation taken before the rail is called, which is what
 * lets the store's unique index arbitrate an idempotency key rather than a check-then-act race)
 * or at `refused`, when a refusal was recorded before any rail call. A rail that answers advances
 * it to `session_opened`. From any in-flight state the worker advances it to a terminal one as it
 * observes the rail's leg.
 */
export const FUNDING_STATES = [
  'created',
  'session_opened',
  'transaction_seen',
  'settled',
  'failed',
  'expired',
  'refused',
  'unobserved',
] as const;

/** A request's lifecycle state. */
export type FundingState = (typeof FUNDING_STATES)[number];

/** A transition that is not allowed from the request's current state. */
export class IllegalTransition extends Error {
  constructor(
    readonly from: FundingState,
    readonly to: FundingState,
  ) {
    super(`illegal funding transition: ${from} -> ${to}`);
    this.name = 'IllegalTransition';
  }
}

/**
 * States in which a request is finished and a worker has nothing left to do.
 *
 * Exported because the store's in-flight query needs the same set, and `claim` builds its
 * placeholders from this array rather than restating it, so a state added here propagates there.
 *
 * `expired` and `unobserved` are both ends of the road, and they say opposite things.
 *
 * `expired` is a claim about the buyer: the rail was asked, it answered, no payment existed, and
 * the window closed. `unobserved` is a claim about this service: it stopped being able to ask, so
 * whether the buyer paid is unknown. Collapsing the two would put the first
 * sentence in front of a buyer whose card was charged, which is the one thing this record must
 * never say. Only a finder that answers may produce `expired`.
 *
 * Both are terminal so the row leaves the in-flight scan. A row that can never conclude but is
 * still scanned is a metered upstream call per tick, for ever, and the count only grows.
 */
export const TERMINAL_STATES: readonly FundingState[] = [
  'settled',
  'failed',
  'expired',
  'refused',
  'unobserved',
];

/** The transition calls that actually advance a request. */
const TRANSITIONS: Readonly<Record<FundingState, ReadonlySet<FundingState>>> = {
  // `unobserved`, not `expired`. A reservation whose process died before the rail answered must
  // still leave the in-flight scan, but it has to leave it honestly: the row is created before
  // the rail is called, so a `created` row may already have an open settlement surface. That is
  // the orphan case in `Onramp.createSession`, where the rail answered and the write recording it
  // did not. Nothing was ever asked about it, and `expired` asserts the buyer did not pay.
  created: new Set(['session_opened', 'refused', 'unobserved']),
  session_opened: new Set(['transaction_seen', 'expired', 'unobserved']),
  transaction_seen: new Set(['settled', 'failed', 'unobserved']),
  // Terminal states advance to nothing.
  settled: new Set(),
  failed: new Set(),
  expired: new Set(),
  refused: new Set(),
  unobserved: new Set(),
};

/**
 * Move `from` to `to`, or throw.
 *
 * A transition the machine does not allow is a programming error, not a runtime condition: it
 * means the store, worker or route tried to move a request somewhere it cannot go. Throwing the
 * typed `IllegalTransition` lets a caller surface it as a 500 rather than silently dropping an
 * update the operator believes happened.
 */
export function transition(from: FundingState, to: FundingState): FundingState {
  if (!TRANSITIONS[from].has(to)) throw new IllegalTransition(from, to);
  return to;
}