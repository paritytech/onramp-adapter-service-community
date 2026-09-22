/**
 * Wire types for the funding surface, and the durable record behind them.
 *
 * Two shapes live here because they are different signatures of the same thing. The record is
 * what the store persists: it holds the rail's ids and the raw timeline, the join keys the worker
 * and support need. The DTO is what a caller may see: never a rail's secrets, never anything
 * another caller's request would disclose. Keeping them separate means the store is free to carry
 * what it needs without that leaking onto the wire.
 */

import type { FundingFailure } from '../contract.js';
import type { Direction, RailName } from '../rail.js';
import { TERMINAL_STATES, type FundingState } from './state.js';

/** One entry in a request's status timeline: a state and the instant it reached it. */
export interface TimelineEntry {
  status: FundingState;
  at: number;
}

/**
 * Why a disclosed deposit address was not accepted as an update to the one already stored.
 *
 * A closed vocabulary, enforced by `funding_deposit_conflict_reason_known` in `schema.ts`, so a
 * support query can group on it. `address_changed` is a well-formed address that disagrees with
 * the one already stored; `address_malformed` is a value that does not decode as an account at
 * all. See `mergeDeposit` in `funding/merge.ts`, the one place either is produced.
 */
export type DepositConflictReason = 'address_changed' | 'address_malformed';

/**
 * The durable record of one funding request.
 *
 * The pinned terms are stored as-sent (the address normalised, the code resolved) so the status
 * surface can echo what was committed without re-deriving it. The provider facts are neutral:
 * `rail` names the rail, and `provider_*` carries that rail's session/transaction facts as they
 * arrive; `service_provider` is the rail-internal pin Meld uses, `undefined` when Meld chooses.
 * The widget URL and expiry belong here so a support conversation can rebuild the settlement
 * surface if needed.
 */
export interface FundingRecord {
  /** The service's stable id, the handle a caller polls with. */
  id: string;
  subject_alias: string;
  product_id: string;
  /**
   * Which way this request moves value. Never absent: rows written before the column existed are
   * buys, and the column's `DEFAULT 'buy'` says so for them (v5 -> v6).
   */
  direction: Direction;
  /** The crypto leg in both directions, even on a sell where the crypto is the source. */
  destination_currency_code: string;
  /** The delivery address, on a buy. A sell has none: the provider issues the deposit address. */
  wallet_address: string | undefined;
  /** The fiat committed, on a buy. A sell commits no fiat, only a quoted estimate of it. */
  source_amount: string | undefined;
  /**
   * The crypto committed, on a sell, at full precision and exactly as sent.
   *
   * Never converted to a number, and never to fiat minor units: it is the term a resuming client
   * compares against to tell one sale from another in the same corridor, so a rounded copy of it
   * is worse than none. The database enforces its presence on a sell (`funding_sell_terms`).
   */
  crypto_amount: string | undefined;
  fiat: string;
  payment_method_type: string;
  /**
   * The buyer's country, as committed. Selects the provider set, the fee schedule and the KYC
   * path at the rail, so a replay under one idempotency key must not quietly change it.
   */
  country?: string | undefined;
  service_provider: string | undefined;
  /**
   * The caller's `idempotencyKey`.
   *
   * Used for idempotency only, and deliberately not what the rail is told: it is unique per
   * (caller, product) here but the rail's reference namespace is global, so two callers sharing
   * a key would both match one upstream transaction. The rail is given this record's `id`.
   */
  client_reference: string | undefined;
  rail: RailName;
  provider_session_id: string | undefined;
  provider_transaction_id: string | undefined;
  /** The rail's opaque transaction status, retained so a later tick can conclude the request. */
  provider_status: string | undefined;
  widget_url: string | undefined;
  /** The rail's own hosted surface, where it offers one distinct from the provider page. */
  hosted_widget_url: string | undefined;
  expires_at: number | undefined;
  status: FundingState;
  /**
   * Why a `refused` request was refused: the `Refusal.failure.tag` the caller was answered with.
   *
   * Set only on `refused`, and undefined everywhere else, including on refusals written before
   * the v2 -> v3 migration. It records which of the two producers wrote the row: a local validation
   * failure that never reached a rail, or a definitive rejection by one.
   *
   * Recorded, not surfaced. It is deliberately absent from `FundingRequestDto`, because a refusal
   * tag describes rail behaviour (which providers are withdrawn, where the thresholds sit), and
   * whether a caller sees that is a product decision this column does not pre-empt.
   */
  reason?: FundingFailure['tag'] | undefined;
  /**
   * When the caller withdrew this request, if they did.
   *
   * Withdraws the settlement surface, not the request. The status is untouched and the row
   * stays in the worker's scan on purpose: a payment sent moments before the cancel still has to
   * be observed, and concluding the row here would stop anything from looking for it. So a
   * cancelled request can still reach `transaction_seen` and `settled`, and that is correct. The
   * buyer paid.
   */
  cancelled_at?: number | undefined;
  /**
   * The sell deposit leg: where the seller sends the crypto, how much, in what, with what memo,
   * and when this service first read it off the rail.
   *
   * Written once, by `mergeDeposit` (`funding/merge.ts`), from the first disclosure the worker
   * observes, and never silently revised after that: a later poll fills in a field still
   * `undefined` but does not overwrite one already set. `undefined` on every buy, always, and on
   * a sell until the provider discloses one.
   */
  deposit_address?: string | undefined;
  deposit_amount?: string | undefined;
  deposit_currency?: string | undefined;
  deposit_memo?: string | undefined;
  deposit_observed_at?: number | undefined;
  /**
   * A deposit-address disclosure this service refused to accept, recorded rather than only
   * thrown: a rail reporting a different address than the one already stored (or one that does
   * not decode as an account at all) is an integrity problem `mergeDeposit` never lets overwrite
   * `deposit_address`, so the rejected value lives here instead, queryable by an operator without
   * anyone needing to grep logs. Deliberately absent from `FundingRequestDto`: exactly as
   * `reason` is recorded but not surfaced (see below), whether a caller sees that a rail
   * disagreed with itself is a product decision this column does not pre-empt, and the seller has
   * nothing to act on from it in any case -- the address they were shown has not changed.
   */
  deposit_conflict_address?: string | undefined;
  deposit_conflict_reason?: DepositConflictReason | undefined;
  /** When the conflict was last observed. Re-stamped on every recurrence, not only the first. */
  deposit_conflict_at?: number | undefined;
  status_history: TimelineEntry[];
  created_at: number;
  updated_at: number;
}

/**
 * Which per-direction database constraint a record would violate, or `undefined` for a row the
 * database will take.
 *
 * The rule is `funding_buy_terms` and `funding_sell_terms` in `schema.ts`, written a second time
 * here and named after them. A second expression of one rule is normally the thing this repo
 * refuses, and the exception is the same one `mergeAdvance` is: the in-memory store in
 * `test/fixtures.ts` is what most of the suite writes through, and a fake that accepts rows
 * Postgres refuses lets a test assert behaviour against a row production cannot hold. That is
 * how a sell row with no crypto amount gets reasoned about at all.
 *
 * The two cannot be derived from each other (one is SQL text, one is a predicate over a struct),
 * so they are tied by a test instead: `schema.test.ts` runs the same table of malformed rows
 * against a real Postgres and against the fake, and requires both to refuse each one.
 *
 * Returns the constraint name rather than a boolean so the fake's error reads like the driver's,
 * and a test asserting on `/funding_sell_terms/` passes against either store.
 */
export function directionTermsViolation(record: FundingRecord): string | undefined {
  if (record.direction === 'sell') {
    return record.crypto_amount === undefined ? 'funding_sell_terms' : undefined;
  }
  return record.wallet_address === undefined || record.source_amount === undefined
    ? 'funding_buy_terms'
    : undefined;
}

/**
 * What a caller can read about one request.
 *
 * A strict subset of the record: the id, the current status, the timeline, and the pinned terms.
 * No rail session/transaction ids reach the wire (they are join keys, and a caller other than a
 * support conversation has no use for them). The settlement surface is echoed back, but only
 * while the request is still live (see `serviceProviderWidgetUrl` below). The `rail` is surfaced
 * so a caller's support and recovery can be rail-aware.
 */
export interface FundingRequestDto {
  id: string;
  rail: RailName;
  /** Which way this request moves value. Always present; absent on the wire never meant `buy`. */
  direction: Direction;
  status: FundingState;
  /** Provider's status as of the last state change, not its current one (e.g. Meld `REFUNDED`). */
  providerStatus?: string;
  destinationCurrencyCode: string;
  /**
   * Present on a buy, absent on a sell. An approved narrowing of a shipped field: a sell has no
   * caller-supplied address, and an empty string would be a destination nobody pinned.
   */
  walletAddress?: string;
  /** The fiat committed, on a buy. Absent on a sell, which commits no fiat. */
  sourceAmount?: string;
  /**
   * The crypto committed, on a sell. Load-bearing, not informational.
   *
   * A client resuming into an existing request compares this against the sale it believes it is
   * resuming, and refuses on a mismatch. On a buy that job is done by the wallet address, which
   * is unique per purchase; on a sell there is no such field and `sourceAmount` is absent, so
   * this is the only term between two sales in one corridor. Omitting it would silently degrade
   * that check to corridor-only matching, which hands a seller someone else's settlement surface
   * at someone else's amount. The database refuses a sell row without one.
   */
  cryptoAmount?: string;
  fiat: string;
  /**
   * Where an unfinished purchase can be resumed, present only while the request is
   * non-terminal, and named exactly as `CreateSessionResponse` names them so a client resuming
   * one reuses the code path it already has for opening one.
   *
   * Returning it discloses nothing: `GET /funding/:id` is scoped to the alias and product that
   * created the row, so the only caller who can read this is the one the URL was minted for.
   *
   * Two conditions, not one. The status must be non-terminal and the rail's own expiry must not
   * have passed:
   *
   * - A settled, expired or refused request has no live surface, and handing a buyer a dead
   *   capture page invites a second payment against a purchase that already concluded.
   * - A row can be non-terminal with a closed capture page. `deadlineFor` is
   *   `max(expires_at, created_at + session_max_age_ms)`, so a session the rail expired an hour
   *   ago stays `session_opened` until the whole window elapses. Gating on status alone would
   *   offer a dead page as resumable for nearly three days.
   *
   * The case this cannot decide is a rail that returns no expiry. There is nothing to compare, so
   * the surface is offered rather than stranding every buyer of such a rail.
   */
  serviceProviderWidgetUrl?: string;
  widgetUrl?: string;
  expiresAt?: number;
  /**
   * When the caller withdrew this request. Surfaced, unlike `reason`, because the caller is the
   * one who withdrew it and a resumed client needs to render the difference between "still
   * waiting for your payment" and "you cancelled this".
   *
   * A cancelled request whose status is still live is not a contradiction: the surface is gone and
   * the observation is not. It can still settle, and a client showing it must not claim otherwise.
   */
  cancelledAt?: number;
  /**
   * Where the seller must send the crypto, once Meld has disclosed it. Present only while the
   * request is `live` (see `serviceProviderWidgetUrl` above) -- handing out an address for a
   * concluded or cancelled request is exactly the hazard that gate exists to prevent, and here the
   * cost of getting it wrong is an irreversible on-chain send, not a stale capture page.
   *
   * All-or-nothing, deliberately. `address`, `amount` and `currency` are read together or not at
   * all: a seller who is shown an address with no amount, or an amount with no currency to read it
   * in, has been given something that looks complete and is not. See `toFundingRequestDto`.
   */
  deposit?: FundingRequestDeposit;
  createdAt: number;
  updatedAt: number;
  history: TimelineEntry[];
}

/** The nested shape of `FundingRequestDto.deposit`. See its doc comment for the disclosure rule. */
export interface FundingRequestDeposit {
  address: string;
  amount: string;
  currency: string;
  /** Present only for an asset that needs one. Absent is the normal, permanent case for most. */
  memo?: string;
  /** When this service first read the disclosure off the rail, not when Meld itself issued it. */
  observedAt: number;
}

/**
 * The record down to the wire, dropping every join key. This is the one lease a caller is given
 * over a funding request; the DTO has no field the record lacks, and the record has plenty the
 * caller never sees.
 */
export function toFundingRequestDto(record: FundingRecord, now: number): FundingRequestDto {
  // `now` is required rather than defaulted. A defaulted clock is one nothing ever passes, and the
  // branch that matters here (an expiry in the past) is only reachable by controlling it.
  //
  // Can this still be paid? `TERMINAL_STATES` owns half the answer, so it cannot drift from the
  // machine the worker advances rows through; the rail's expiry owns the other half.
  // Three conditions now. A cancelled request has no surface to offer even while its status is
  // live; that is the whole of what cancelling does, and leaving the URL out is where it happens.
  const live =
    !TERMINAL_STATES.includes(record.status) &&
    (record.expires_at ?? Infinity) > now &&
    record.cancelled_at === undefined;
  return {
    id: record.id,
    rail: record.rail,
    direction: record.direction,
    status: record.status,
    ...(record.provider_status === undefined ? {} : { providerStatus: record.provider_status }),
    destinationCurrencyCode: record.destination_currency_code,
    // Each of the three committed-amount fields is emitted only where it exists, rather than
    // defaulted: a buy's body is unchanged, and a sell's carries the crypto it committed and no
    // fiat term it never committed.
    ...(record.wallet_address === undefined ? {} : { walletAddress: record.wallet_address }),
    ...(record.source_amount === undefined ? {} : { sourceAmount: record.source_amount }),
    ...(record.crypto_amount === undefined ? {} : { cryptoAmount: record.crypto_amount }),
    fiat: record.fiat,
    ...(live && record.widget_url !== undefined ? { serviceProviderWidgetUrl: record.widget_url } : {}),
    ...(live && record.hosted_widget_url !== undefined ? { widgetUrl: record.hosted_widget_url } : {}),
    ...(live && record.expires_at !== undefined ? { expiresAt: record.expires_at } : {}),
    ...(record.cancelled_at === undefined ? {} : { cancelledAt: record.cancelled_at }),
    ...(live ? depositDisclosure(record, now) : {}),
    createdAt: record.created_at,
    updatedAt: record.updated_at,
    history: record.status_history,
  };
}

/**
 * The `{ deposit }` wrapper for `toFundingRequestDto`, or `{}` when there is nothing safe to show.
 *
 * Gated on the caller passing `live` first (see `toFundingRequestDto`), and, independently, on
 * `address`, `amount` and `currency` all being present. The three are read together deliberately:
 * `mergeAdvance` can, in principle, leave a row with an address and no amount yet (a provider that
 * discloses one before the other, which is unverified either way -- see `funding/merge.ts`), and a
 * half-disclosure is worse than none. An address with no amount looks like a destination with
 * nothing wrong with it; a seller cannot tell "not disclosed" from "disclosed, but this service
 * dropped a field" from the wire alone, so neither is sent until all three exist.
 */
function depositDisclosure(record: FundingRecord, now: number): { deposit?: FundingRequestDeposit } {
  const { deposit_address: address, deposit_amount: amount, deposit_currency: currency } = record;
  if (address === undefined || amount === undefined || currency === undefined) return {};
  return {
    deposit: {
      address,
      amount,
      currency,
      ...(record.deposit_memo === undefined ? {} : { memo: record.deposit_memo }),
      // `deposit_observed_at` is written in the same merge as `deposit_address` (see
      // `mergeAdvance`), so in practice it is never absent here; still guarded rather than
      // asserted, because a DTO builder asserting a database's internal consistency is the wrong
      // place to discover it is wrong. `now` is the caller's own clock (see `toFundingRequestDto`),
      // never `Date.now()`, so this stays exactly as pure and as testable as the function it falls
      // back inside of.
      observedAt: record.deposit_observed_at ?? now,
    },
  };
}
