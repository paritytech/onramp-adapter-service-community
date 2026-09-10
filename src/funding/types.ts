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
import type { RailName } from '../rail.js';
import { TERMINAL_STATES, type FundingState } from './state.js';

/** One entry in a request's status timeline: a state and the instant it reached it. */
export interface TimelineEntry {
  status: FundingState;
  at: number;
}

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
  destination_currency_code: string;
  wallet_address: string;
  source_amount: string;
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
  status_history: TimelineEntry[];
  created_at: number;
  updated_at: number;
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
  status: FundingState;
  /** Provider's status as of the last state change, not its current one (e.g. Meld `REFUNDED`). */
  providerStatus?: string;
  destinationCurrencyCode: string;
  walletAddress: string;
  sourceAmount: string;
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
  createdAt: number;
  updatedAt: number;
  history: TimelineEntry[];
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
    status: record.status,
    ...(record.provider_status === undefined ? {} : { providerStatus: record.provider_status }),
    destinationCurrencyCode: record.destination_currency_code,
    walletAddress: record.wallet_address,
    sourceAmount: record.source_amount,
    fiat: record.fiat,
    ...(live && record.widget_url !== undefined ? { serviceProviderWidgetUrl: record.widget_url } : {}),
    ...(live && record.hosted_widget_url !== undefined ? { widgetUrl: record.hosted_widget_url } : {}),
    ...(live && record.expires_at !== undefined ? { expiresAt: record.expires_at } : {}),
    ...(record.cancelled_at === undefined ? {} : { cancelledAt: record.cancelled_at }),
    createdAt: record.created_at,
    updatedAt: record.updated_at,
    history: record.status_history,
  };
}
