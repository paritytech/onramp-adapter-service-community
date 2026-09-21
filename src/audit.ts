/**
 * The record of what the service did: append-only, write-once, never read in the request path, which
 * describes a log rather than a table. Threat model R6 covers the trade-off.
 *
 * The fields are chosen so a dispute is answerable while holding no account, no address history
 * and no card detail.
 */

import type { Direction, RailName } from './rail.js';

/** One audit line: what happened, to which request, on which rail. */
export interface AuditEvent {
  /**
   * `session.orphaned` is the one that matters at 3am: the rail opened a settlement surface and
   * the record of it could not be written, so the only handle to that upstream session is this
   * line.
   */
  event:
    | 'session.created'
    | 'session.refused'
    | 'session.rail_refused'
    | 'session.orphaned'
    /**
     * The caller withdrew a request, and a live settlement surface stopped being served.
     *
     * The row carries `cancelled_at`, so the fact is durable, but the row is not what ships
     * off-box. This is the line a dispute turns on: the buyer says they cancelled before paying,
     * and the question is whether it was withdrawn, and when.
     */
    | 'session.cancelled'
    /**
     * The caller tried to withdraw a request and could not, because a payment was already on its
     * way or the request had concluded. Emitted for the same reason as the success: a buyer who
     * attempted to cancel and was refused while their money was moving is precisely the case
     * someone will ask you to reconstruct, and refusing silently leaves nothing to reconstruct it
     * from. `reason` carries which of the two it was.
     */
    | 'session.cancel_refused';
  alias: string;
  productId: string;
  requestId: string;
  destinationCurrencyCode: string;
  /**
   * The delivery address, on a buy.
   *
   * Optional as of the sell release, and this is a deliberate change to a contract that ships
   * off-box: a consumer of this stream that read `walletAddress` as always-present now has to
   * handle its absence. A sell has no caller-supplied address at all (the provider issues the
   * deposit address later), so the alternative was emitting an empty string, which is a claim
   * about a destination that was never pinned, on the one record a dispute is answered from.
   */
  walletAddress?: string;
  /**
   * The fiat committed, on a buy. Absent on a sell, which commits crypto and only estimates the
   * fiat, so a number here would be an estimate presented as a term.
   */
  sourceAmount?: string;
  /** The crypto committed, on a sell. Absent on a buy. Exactly as sent, never rounded. */
  cryptoAmount?: string;
  fiat: string;
  /**
   * Which way the value moved. **Absent means `buy`**, matching `DEFAULT_DIRECTION` on the wire.
   *
   * Optional, and omitted rather than written as `'buy'`, which is the opposite of how `rail` is
   * treated and is deliberate. This stream ships off-box into consumers this repo cannot see,
   * and a consumer validating against a fixed schema (`additionalProperties: false`, a fixed
   * BigQuery or Athena column set) breaks on an unexpected key exactly as it breaks on a missing
   * one. Requiring the field would change the shape of every buy line ever emitted to buy
   * nothing; omitting it means an existing consumer sees no change at all, and only the sell
   * lines it has never seen before carry the new keys. The `walletAddress` narrowing above
   * follows the same rule from the other side.
   */
  direction?: Direction;
  /**
   * The jurisdiction the request transacted under. It selects the provider set, the fee schedule
   * and the KYC path at the rail, so a dispute cannot be answered without it.
   *
   * Optional because the refusal path emits the submitted terms (a refusal may be because a
   * term could not be pinned) while the created path emits the pinned ones. Every request this
   * build serves carries a country; a row written before the column existed does not.
   */
  country?: string;
  /**
   * Which funding rail handled the request. Required: every event this service emits comes from a
   * path that has already resolved a rail, so an optional field described a variation that does
   * not exist and forced every consumer to handle an absence that cannot occur.
   */
  rail: RailName;
  /** Present on success: the rail's session/swap id. */
  providerSessionId?: string;
  /** Present on refusal. The enumerated tag only, never the operator detail. */
  reason?: string;
}

/** Just enough of a logger to write one, so any pino-shaped log satisfies it. */
export interface AuditLog {
  info: (event: AuditEvent, message: string) => void;
}
