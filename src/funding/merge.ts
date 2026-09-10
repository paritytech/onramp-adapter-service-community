/**
 * How an advance changes a funding record: the rule, with no storage attached.
 *
 * Its own module rather than a corner of `store.ts`, because `test/fixtures.ts` needs it and
 * `store.ts` opens with `pgTypes.setTypeParser(...)`. Importing the merge from there executed a
 * global mutation of the driver's type registry in every unit test that touches a fixture,
 * including the ones that never go near a database. A pure function over a record has no business
 * pulling in a database driver.
 */

import { transition } from './state.js';

import type { FundingState } from './state.js';
import type { FundingFailure } from '../contract.js';
import type { FundingRecord } from './types.js';

/**
 * Apply an advance to a record: the new state, its timeline entry, and every field the caller may
 * have supplied. Pure, because the transaction around it is the store's business, not this
 * function's.
 *
 * Exported so the in-memory store in `test/fixtures.ts` applies this rule rather than copying it.
 * A copy is a second implementation the suite would assert against, and it silently drops any
 * column added here. Typing the fake against `FundingStore['update']`
 * stops the signature drifting and cannot stop the body drifting; sharing the body can.
 *
 * `providerStatus` is compared against `undefined` rather than coalesced, because its type is
 * `string | null` and an explicit `null` means "the rail reported no status". `??` read that as
 * absent and kept the previous value, so a transaction that stopped reporting one went on mapping
 * against a status it no longer had.
 */
export function mergeAdvance(
  previous: FundingRecord,
  to: FundingState,
  now: number,
  extra?: UpdateExtra,
): FundingRecord {
  const next = transition(previous.status, to);
  const providerStatus = extra?.providerStatus;
  return {
    ...previous,
    status: next,
    status_history: [...previous.status_history, { status: next, at: now }],
    updated_at: now,
    provider_session_id: extra?.providerSessionId ?? previous.provider_session_id,
    provider_transaction_id: extra?.providerTransactionId ?? previous.provider_transaction_id,
    provider_status: providerStatus === undefined ? previous.provider_status : (providerStatus ?? undefined),
    widget_url: extra?.widgetUrl ?? previous.widget_url,
    hosted_widget_url: extra?.hostedWidgetUrl ?? previous.hosted_widget_url,
    expires_at: extra?.expiresAt ?? previous.expires_at,
    client_reference: extra?.releaseReference === true ? undefined : previous.client_reference,
    reason: extra?.reason ?? previous.reason,
  };
}

/**
 * What an advance may carry alongside the new state.
 *
 * Named and exported so the store and the test fake cannot describe it differently: the fake's
 * hand-copied version silently dropped `reason` the day it was added, and a type alone cannot
 * catch that (see `mergeAdvance`).
 */
export interface UpdateExtra {
      providerSessionId?: string;
      providerTransactionId?: string;
      providerStatus?: string | null;
      /** Written when a reserved row is advanced to `session_opened` and the surface first exists. */
      widgetUrl?: string;
      hostedWidgetUrl?: string;
      expiresAt?: number;
      /**
       * Set `true` when closing a reservation that never became a session.
       *
       * The caller's idempotency key must not stay bound to a request that failed upstream: a
       * retry under the same key (which the contract requires to be stable) would otherwise
       * replay the dead row for ever, answering 201 with an empty settlement URL. The refusal
       * path already stores no reference for exactly this reason.
       */
      releaseReference?: boolean;
      /**
       * Why the request was refused, when `to` is `refused`.
       *
       * Only ever set, never cleared: a row that carries a reason has reached a terminal state and
       * has no further transitions, so there is no `?? previous` case that could need to unset one.
       */
      reason?: FundingFailure['tag'];
      /**
       * The lease this advance is made under. When set, the write matches only while the row is
       * still leased to this worker; a zero-row result means another worker took it after the
       * lease expired, and the caller must not infer success.
       */
      claimedBy?: string;
}
