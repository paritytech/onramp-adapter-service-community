/**
 * How an advance changes a funding record: the rule, with no storage attached.
 *
 * Its own module rather than a corner of `store.ts`, because `test/fixtures.ts` needs it and
 * `store.ts` opens with `pgTypes.setTypeParser(...)`. Importing the merge from there executed a
 * global mutation of the driver's type registry in every unit test that touches a fixture,
 * including the ones that never go near a database. A pure function over a record has no business
 * pulling in a database driver.
 */

import { canonicalizeDisclosedAddress } from '../address.js';
import { TERMINAL_STATES, transition } from './state.js';

import type { FundingState } from './state.js';
import type { FundingFailure } from '../contract.js';
import type { RailDeposit } from '../rail.js';
import type { DepositConflictReason, FundingRecord } from './types.js';

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
  const deposit = extra?.deposit;

  // `transition` refuses a target equal to the record's own current state, because a self-loop is
  // not a move the machine describes -- and it should not have to, since nothing before this
  // needed to write without moving. A sell's deposit address is the one fact that does: it can be
  // disclosed while a row sits in `transaction_seen`, unmoved, waiting for the seller's on-chain
  // transfer. So the self-loop is accepted here, but only in that one shape (carrying a deposit
  // fact) and only while the row is still in flight: a terminal row is not a legal `transition`
  // target for anything, self-loop or not, and `deposit !== undefined` alone does not say the row
  // is still open. Without this second guard, a `settled` or `failed` row's `SELECT ... FOR
  // UPDATE` (which, unlike `store.claim`, carries no status filter) could reach this function with
  // its own terminal status as `to` and silently rewrite deposit fields on a concluded request.
  // Any other self-loop attempt still goes through `transition` and still throws exactly as
  // before. This is not a general loosening of the machine, and `state.ts` and its exhaustive
  // transition test are untouched.
  const factOnly = to === previous.status && deposit !== undefined && !TERMINAL_STATES.includes(previous.status);
  const next = factOnly ? to : transition(previous.status, to);

  const merged = mergeDeposit(previous, deposit, now);

  const providerStatus = extra?.providerStatus;
  return {
    ...previous,
    status: next,
    // No new timeline entry for a self-loop: the row did not move, so a second "transaction_seen"
    // beside the first would read as a second arrival at a state it never left.
    status_history:
      next === previous.status ? previous.status_history : [...previous.status_history, { status: next, at: now }],
    updated_at: now,
    provider_session_id: extra?.providerSessionId ?? previous.provider_session_id,
    provider_transaction_id: extra?.providerTransactionId ?? previous.provider_transaction_id,
    provider_status: providerStatus === undefined ? previous.provider_status : (providerStatus ?? undefined),
    widget_url: extra?.widgetUrl ?? previous.widget_url,
    hosted_widget_url: extra?.hostedWidgetUrl ?? previous.hosted_widget_url,
    expires_at: extra?.expiresAt ?? previous.expires_at,
    client_reference: extra?.releaseReference === true ? undefined : previous.client_reference,
    reason: extra?.reason ?? previous.reason,
    ...merged,
  };
}

/** The nine deposit-shaped columns `mergeDeposit` decides, together, in one place. */
interface DepositFields {
  deposit_address: string | undefined;
  deposit_amount: string | undefined;
  deposit_currency: string | undefined;
  deposit_memo: string | undefined;
  deposit_observed_at: number | undefined;
  deposit_conflict_address: string | undefined;
  deposit_conflict_reason: DepositConflictReason | undefined;
  deposit_conflict_at: number | undefined;
}

/**
 * Fold one disclosure into what a record already knows about its deposit leg.
 *
 * Three outcomes, and only three:
 *
 * 1. **Nothing disclosed this poll** (`incoming` is `undefined`): every field carries over
 *    unchanged. The common case for a buy, forever, and for a sell before the provider has said
 *    anything.
 * 2. **A first disclosure, or the same address repeated**: written (first time) or left alone
 *    (repeat), and any field still missing is filled in from this poll without disturbing one
 *    already landed -- an amount that arrives after the address, say.
 * 3. **A conflict** -- a different, well-formed address than the one already stored, or a value
 *    that does not decode as an account at all: `deposit_address` and its siblings are left
 *    completely untouched. **This is the fix over the first version of this function**, which
 *    threw and rolled back the *entire* advance, including any real state move (a settlement, a
 *    failure) riding alongside the conflicting fact. A provider that keeps disclosing a wrong
 *    address must not also be able to freeze a row that would otherwise correctly conclude: the
 *    seller was shown the *original* address and may already have sent to it, so keeping that
 *    address disclosed and correct is the one thing this function must still guarantee, but a
 *    conflicting fact riding along with an unrelated, legitimate transition is not a reason to
 *    refuse the transition. The conflict is recorded instead (`deposit_conflict_*`), which is
 *    what makes it loud without making it destructive: `funding/worker.ts` reads the change in
 *    `deposit_conflict_at` and logs it at its own level, and the row stays queryable by an
 *    operator without anyone needing to grep for a thrown error's message text.
 *
 * The comparison that decides between (2) and (3) is on the **canonical** form
 * (`canonicalizeDisclosedAddress`), not the raw string a rail hands over. The same account
 * re-serialised under a different SS58 prefix between two polls is not a conflict; comparing raw
 * strings would have called it one and frozen a healthy sale on an address that never actually
 * changed.
 */
function mergeDeposit(previous: FundingRecord, incoming: RailDeposit | undefined, now: number): DepositFields {
  const carried: DepositFields = {
    deposit_address: previous.deposit_address,
    deposit_amount: previous.deposit_amount,
    deposit_currency: previous.deposit_currency,
    deposit_memo: previous.deposit_memo,
    deposit_observed_at: previous.deposit_observed_at,
    deposit_conflict_address: previous.deposit_conflict_address,
    deposit_conflict_reason: previous.deposit_conflict_reason,
    deposit_conflict_at: previous.deposit_conflict_at,
  };
  if (incoming === undefined) return carried;

  // Never a caller-facing `INVALID_ADDRESS`: whatever produced this string was a payment
  // provider's API response, not a person typing into a form, so a value that does not decode is
  // this service's own integrity problem. `undefined` here means exactly "could not canonicalise",
  // nothing more specific, and it is handled identically to a conflicting well-formed address:
  // recorded, not disclosed, not fatal to a state move riding alongside it.
  const canonical = canonicalizeDisclosedAddress(incoming.address);

  if (canonical === undefined) {
    return {
      ...carried,
      deposit_conflict_address: incoming.address,
      deposit_conflict_reason: 'address_malformed',
      deposit_conflict_at: now,
    };
  }

  if (carried.deposit_address === undefined) {
    // First disclosure. Stamps `deposit_observed_at` once, here, never again.
    return {
      ...carried,
      deposit_address: canonical,
      deposit_amount: incoming.amount,
      deposit_currency: incoming.currency,
      deposit_memo: incoming.memo,
      deposit_observed_at: now,
    };
  }

  if (canonical !== carried.deposit_address) {
    return {
      ...carried,
      // The raw string, not the canonical one: `funding/worker.ts` compares a later poll's raw
      // report against this column to recognise "the same wrong answer as last time" without
      // re-deriving a canonical form there too, and a raw-to-canonical comparison would never
      // match, defeating that dedup every single tick.
      deposit_conflict_address: incoming.address,
      deposit_conflict_reason: 'address_changed',
      deposit_conflict_at: now,
    };
  }

  // The same address, reported again: fill in whatever is still missing, never revise what
  // already landed.
  return {
    ...carried,
    deposit_amount: carried.deposit_amount ?? incoming.amount,
    deposit_currency: carried.deposit_currency ?? incoming.currency,
    deposit_memo: carried.deposit_memo ?? incoming.memo,
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
      /**
       * A provider-issued fact disclosed on this poll, independent of `to`. See `RailDeposit` and
       * `mergeDeposit`, the rule this function enforces around it: written once, never silently
       * revised, and a conflicting report is recorded rather than rejecting the whole advance.
       */
      deposit?: RailDeposit;
}
