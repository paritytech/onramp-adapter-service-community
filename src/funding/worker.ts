/**
 * The background worker that advances in-flight funding requests.
 *
 * The SPA can close and the request still moves, because this loop is in-process over the durable
 * store; it does not need a browser to be open. Each tick it loads the requests still in a
 * non-terminal state and does the work the machine allows:
 *
 *   - a `session_opened` request whose settlement surface has expired (the buyer never paid) is
 *     advanced to `expired` (locally determinable, no upstream call needed);
 *   - otherwise it asks the request's rail for the transaction and, when one is found, advances
 *     to `transaction_seen` and attaches the (provider-neutral) transaction id, so the timeline
 *     shows the moment the payment was observed;
 *   - a `transaction_seen` request is concluded (`settled`/`failed`) by the status mapper when a
 *     terminal mapping is known.
 *
 * The worker is idempotent and crash-safe: every advance is one guarded write to the same row, so
 * a restart resumes from the persisted state and no in-memory progress exists to lose.
 *
 * The finder and mapper are injected per rail, which is also what makes the worker testable
 * without HTTP. Dispatch is on the request's explicit `rail`, never on `service_provider`, a
 * Meld-internal pin that cannot tell meld from chainflip. A rail with no observation registered
 * is not refused: the absence is passed down so the row still ages out on local grounds.
 */

import { randomUUID } from "node:crypto";

import { canonicalizeDisclosedAddress } from "../address.js";
import type { Clock } from "../onramp.js";
import type { RailDeposit, RailName } from "../rail.js";
import type { FundingState } from "./state.js";
import type { FundingStore } from "./store.js";
import type { FundingRecord } from "./types.js";

/**
 * How the worker learns about a request's transaction, per rail.
 *
 * Injected per-rail because the lookup contract differs by rail; dispatch happens in `tick` on the
 * request's `rail`. Returns `undefined` when nothing has transacted yet; the request stays where
 * it is.
 */
export type TransactionFinder = (
  record: FundingRecord,
) => Promise<TransactionObservation | undefined>;

/** What the worker takes from a found transaction, provider-neutrally. */
export interface TransactionObservation {
  id: string;
  /** A rail may report a status, or leave it absent/unknown; the id is the join key that matters. */
  status: string | null | undefined;
  /**
   * A provider-issued fact disclosed alongside this observation, rather than at session creation.
   *
   * `undefined` on every buy observation, forever: a buy's wallet address is the caller's own,
   * sent before the session opened, so there is nothing for a provider to disclose. On a sell it
   * starts `undefined` and may become populated on any later poll, once the provider issues a
   * deposit address -- see `RailDeposit`.
   */
  deposit?: RailDeposit;
}

/**
 * How a rail's transaction status becomes a terminal funding state.
 *
 * Pure and injectable so the rule (which statuses mean settled vs failed) lives in one testable
 * place. Rail status is opaque, so this is a function over a string, not an enum.
 */
export type TransactionMapper = (
  providerStatus: string | undefined,
) => FundingState;

/**
 * The worker's one log sink, everywhere in this module.
 *
 * `level` is optional and defaults to `'warn'` at the call site the process binds (`startup.ts`),
 * which is what every pre-existing single-argument call keeps doing without change. `'error'`
 * exists for exactly one caller today: a deposit-address disclosure conflict (see `tick`), which
 * needs to read differently in an aggregator from "a rail hiccuped, this will clear itself" --
 * the two were previously indistinguishable except by parsing the message text.
 */
export type WorkerLog = (message: string, level?: 'warn' | 'error') => void;

/** Per-rail finder + mapper. A rail with no entry here is not wired for observation. */
export interface RailObservation {
  finder: TransactionFinder;
  mapper: TransactionMapper;
}

/**
 * Consecutive per-record failures in one tick that mean the fault is not per-record.
 *
 * Bounds the upstream calls a systemic fault can spend per tick, not per unit time: a rail that
 * fails every request costs three calls a tick rather than one per in-flight row. It is not a rate
 * limit. A rail failing intermittently never reaches three in a row and keeps being asked at full
 * rate, which is intended: those answers are how rows conclude.
 */
const FAILURE_CEILING = 3;

/**
 * Run one worker tick: advance every in-flight request the store holds, returning how many advanced.
 * Idempotent: a re-run advances nothing already advanced.
 *
 * Dispatch is on the request's `rail`. The observation map is partial because a rail may be wired
 * for sessions but not yet for observation; a row on such a rail ages out on local grounds rather
 * than being retried for ever.
 */
export async function tick(
  store: Pick<FundingStore, 'claim' | 'release' | 'update' | 'pruneRefusals'>,
  now: number,
  observations: Readonly<Partial<Record<RailName, RailObservation>>>,
  sessionMaxAgeMs: number,
  log: WorkerLog,
  // Not defaulted: a wrong default here would be a wrong deployment.
  lease: Lease,
  /** How long a refused row is kept, and when this worker last swept. Omitted, nothing is pruned. */
  retention?: Retention,
  /**
   * Every id this worker still holds a lease on, so `stop` can hand them all back on a planned
   * shutdown rather than leaving the replacement pod to wait out the ttl.
   *
   * Cumulative across ticks, because a saturated tick's rows stay leased across later ones. Keyed
   * by expiry so entries drain: a stale id would let `stop` clear a lease the current tick is
   * writing under, making that write match zero rows and discard the advance.
   */
  held?: Map<string, number>,
): Promise<number> {
  let advanced = 0;
  let consecutiveFailures = 0;
  // Latches for the rest of the tick once the ceiling trips. It cannot be derived from the
  // counter: in skip mode `advanceOne` returns without throwing, which the reset below reads as
  // the rail answering, so the counter would clear and the calls resume row after row.
  let askingRail = true;

  await prune(store, now, retention, log);

  // Before the claim, deliberately: the next line may re-claim a row whose lease has expired, and
  // a stale entry here would let `stop` release a lease this tick is about to write under.
  if (held !== undefined) {
    for (const [id, until] of held) if (until <= now) held.delete(id);
  }

  const claimed = await store.claim(
    lease.workerId,
    now,
    lease.ttlMs,
    lease.batch,
  );
  try {
    for (const record of claimed) {
      // Isolated per record. `claim` returns rows oldest-first and stable, so without this one
      // bad row (a rail returning 503, an illegal transition, a locked row) would abort the tick
      // before anything behind it is touched, and do so again on every tick.
      try {
        // A missing observation is passed down rather than thrown on, so `advanceOne` can still
        // age the row out on local grounds instead of holding its caller's idempotency key.
        //
        // Past the ceiling only the call is skipped, never the scan: breaking out would be a
        // `LIMIT` positioned by whichever rows fail.
        const done = await advanceOne(
          record,
          now,
          observations[record.rail],
          log,
          !askingRail,
          sessionMaxAgeMs,
        );
        // Reset on an answer: either "nothing to do yet" (the usual reply for a healthy unpaid
        // request) or a completed write. Resetting merely because `advanceOne` did not throw would
        // sit ahead of `store.update`, so a systemic store fault could oscillate the counter
        // between 0 and 1 and never reach the ceiling.
        //
        // The state staying put is not, on its own, "nothing to do": a sell's deposit address can
        // be disclosed while the row sits in `transaction_seen` unmoved, and that fact still has
        // to reach the row. So the skip condition is "no move AND nothing newly discovered",
        // not "no move" alone -- the one case this whole step exists to open a channel for.
        if (done === undefined || (done.state === record.status && done.discovered?.deposit === undefined)) {
          consecutiveFailures = 0;
          continue;
        }

        // `discovered` is populated only on the path that observed a new transaction; every other
        // advance writes just the state, and `store.update` preserves the existing provider facts.
        const refreshed = await store.update(record.id, done.state, now, {
          ...done.discovered,
          // Names the lease. A zero-row write means the lease expired and another worker took the
          // row, so `refreshed` is undefined and this tick counts nothing; reporting someone
          // else's advance as this worker's own would double-count and hide the overlap.
          claimedBy: lease.workerId,
        });
        // A deposit-address disclosure conflict does not throw any more (`mergeDeposit` records
        // it and lets an unrelated, legitimate transition through beside it, see `merge.ts`), so
        // it needs its own alarm here or it would be invisible: no error, no failed write, just a
        // row that quietly stopped accepting new disclosures. `deposit_conflict_at` changing is
        // the signal -- re-stamped by `mergeDeposit` on every recurrence, not only the first, so
        // this fires again each time the same disagreement is seen, which is what "loud" means
        // for a fact an operator has not yet acted on. Its own line, and its own level: an
        // aggregator must be able to tell this apart from the generic per-record failure below,
        // which a rail hiccup produces just as easily and clears on its own.
        if (refreshed !== undefined && refreshed.deposit_conflict_at !== record.deposit_conflict_at) {
          log(
            `funding worker: request ${record.id} received a conflicting deposit disclosure ` +
              `(${refreshed.deposit_conflict_reason ?? 'unknown reason'}: "${refreshed.deposit_conflict_address ?? 'unknown value'}"); ` +
              `the previously disclosed address is unchanged and was kept. This needs a person, not a retry.`,
            'error',
          );
        }
        consecutiveFailures = 0;
        if (refreshed !== undefined) advanced += 1;
      } catch (error) {
        log(
          `funding worker could not advance ${record.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
        consecutiveFailures += 1;
        // Per-record isolation does nothing about a fault that is not per-row. A rejected query
        // parameter or an unreachable rail fails for every record, and each failure is a metered
        // upstream call. Consecutive failures are the signal: a per-row fault resets the count and
        // the scan continues past it. Nothing is concluded and no state is written here.
        if (consecutiveFailures === FAILURE_CEILING) {
          askingRail = false;
          log(
            `funding worker stopped asking the rail this tick after ${String(consecutiveFailures)} ` +
              "consecutive failures: the fault looks like the rail or the query, not one record.",
          );
        }
      }
    }
  } finally {
    // Handed back, unless the batch filled, which is what stops the oldest rows starving
    // everything behind them.
    //
    // `claim` takes the oldest `batch` non-terminal rows, and a `session_opened` row holds its
    // slot for the full session window (72h by default). Releasing a full batch would make the
    // next tick claim the very same rows, so with more than `batch` requests in flight the buyer
    // who had just paid would wait behind yesterday's abandoned carts.
    //
    // A batch that did not fill means this tick saw every in-flight row, so releasing immediately
    // keeps the common case fast. A full batch cannot distinguish "more are queued" from "these
    // were exactly all of them", and telling them apart needs a second query per tick for a case
    // that costs one lease window. So the lease is left to expire, the next tick claims different
    // rows, and the rotation comes back round `ttlMs / interval` ticks later.
    const saturated = claimed.length >= lease.batch;
    const ids = claimed.map((record) => record.id);
    // Logged, never thrown: a rejection out of a `finally` replaces the value the block was
    // returning, so a release failing as the pool closes would report a tick that advanced ten
    // rows as a failed one.
    try {
      if (saturated) {
        // Recorded so shutdown can undo it, and written here at the end of the tick so a tick
        // abandoned mid-flight never appears in the set. Its rows may still be mid-`update`, and
        // clearing a lease under a write makes that write match zero rows and lose the advance.
        for (const id of ids) held?.set(id, now + lease.ttlMs);
      } else {
        await store.release(lease.workerId, ids);
        for (const id of ids) held?.delete(id);
      }
    } catch (error) {
      log(
        `funding worker could not release its claims: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return advanced;
}

/**
 * The refusal-retention sweep, and when it last ran.
 *
 * `lastSweptAt` is mutable state on a long-lived object; the alternative is a `DELETE` on every
 * tick, and a tick is every fifteen seconds by default. The rows are ninety days old, so an
 * hourly sweep is as timely as the policy needs.
 */
export interface Retention {
  days: number;
  everyMs: number;
  lastSweptAt: number | undefined;
}

/**
 * Delete refusals past the retention window, at most once per `everyMs`.
 *
 * Failure is logged and swallowed. Pruning is housekeeping: a sweep that cannot run must not stop
 * the tick from advancing funding requests, which is the thing buyers are waiting on.
 */
async function prune(
  store: Pick<FundingStore, 'pruneRefusals'>,
  now: number,
  retention: Retention | undefined,
  log: WorkerLog,
): Promise<void> {
  if (retention === undefined) return;
  // Before the interval check, not after it. A backward clock jump makes `now - lastSweptAt`
  // negative, which reads as "not yet" against any positive interval, so correcting afterwards
  // would be unreachable and the sweep deferred until wall time climbed back past the stamp.
  if (retention.lastSweptAt !== undefined && now < retention.lastSweptAt) retention.lastSweptAt = now;
  if (retention.lastSweptAt !== undefined && now - retention.lastSweptAt < retention.everyMs) return;

  try {
    const deleted = await store.pruneRefusals(now - retention.days * 24 * 3_600_000);
    // Stamped on success, not before the attempt: stamping first would leave a sweep that timed
    // out over a backlog unretried for an hour, and the next one would time out the same way.
    retention.lastSweptAt = now;
    if (deleted > 0) {
      log(`funding worker pruned ${String(deleted)} refused request(s) older than ${String(retention.days)} days`);
    }
  } catch (error) {
    log(`funding worker could not prune refused requests: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** One worker's identity and the bounds on what it may hold at a time. */
export interface Lease {
  /** Distinguishes this worker from another replica's. Stable for the process's lifetime. */
  workerId: string;
  /** How long a claim survives without being released: a crash-recovery bound, nothing else. */
  ttlMs: number;
  /** How many requests one tick may hold. */
  batch: number;
}

/**
 * Build a lease for this worker.
 *
 * The id must be unique per process instance, and `process.pid` is not: the image runs `node` as
 * its entrypoint with no init wrapper, so every container has this process at PID 1. Two replicas
 * sharing a name would both satisfy the claim guard in `store.update`, which is the double-advance
 * the lease exists to prevent. The `randomUUID()` is what distinguishes them; the `worker-` prefix
 * is only a convention that makes `claimed_by` greppable, and nothing branches on it.
 *
 * `batch` is 50 because a tick advances rows in series and each may cost one metered rail call, so
 * it bounds what a single bad tick can strand. `ttlMs` is comfortably longer than a tick that hits
 * the ceiling and gives up.
 */
export function newLease(): Lease {
  return { workerId: `worker-${randomUUID()}`, ttlMs: 120_000, batch: 50 };
}

/** What one advance carries: the new state, plus any provider facts discovered with it. */
interface Advance {
  state: FundingState;
  /**
   * Present only once a transaction is observed. `undefined` keeps the stored provider facts
   * untouched; the state move alone is what the other advances need.
   *
   * `deposit` rides along independently of whether `state` actually moves: a sell's deposit
   * address can be disclosed while a row sits in `transaction_seen` unmoved, still waiting for
   * the seller's on-chain transfer, which is neither a settlement nor a failure. `tick` reads
   * this field precisely so that case still reaches a write.
   */
  discovered?: { providerTransactionId: string; providerStatus: string | null; deposit?: RailDeposit };
}

/**
 * When to stop watching a request for a payment.
 *
 * The local window is a floor, and a rail expiry only ever extends it. Meld's `expiresAt` says
 * when its capture page closes, which is not evidence about payment; taking it as the deadline
 * marked paid purchases `expired`, terminally, while the money had moved.
 *
 * Nothing bounds it from above: a rail returning a far-future expiry keeps the row in the scan
 * that long. Inert with Meld, whose sessions are short-lived; it would need a clamp before a rail
 * that hands out long-dated surfaces.
 *
 * On a sell there is no rail expiry at all, ever. Observed against the sandbox: a `SELL` session
 * response carries no `expiresAt`, so `expires_at` is null on every sell row and the local window
 * is not a floor under a provider deadline but the whole of it. The `?? 0` already does the right
 * thing, so nothing changes here; it is recorded because a sell waiting for an on-chain deposit
 * is bounded by `session_max_age_ms` alone, and that one number decides how long this service
 * keeps looking for a seller's money.
 */
function deadlineFor(record: FundingRecord, sessionMaxAgeMs: number): number {
  return Math.max(record.expires_at ?? 0, record.created_at + sessionMaxAgeMs);
}

/**
 * Decide, for one record, the state it should move to.
 *
 * Returns `undefined` when the record stays where it is (nothing transacted, or a state the
 * worker does not advance). A freshly-observed transaction is the only time new provider facts
 * ride along with the state move.
 */
async function advanceOne(
  record: FundingRecord,
  now: number,
  /**
   * How this record can be observed, or `undefined` if its rail has no observation wired at all.
   *
   * Absent is permanent: a rail nobody registered will not become askable later in this process,
   * so a row on it must still be able to conclude. That is different from `deferred` below.
   */
  obs: RailObservation | undefined,
  /** Where a conclusion drawn from a failure explains itself. See the `catch` below. */
  log: WorkerLog,
  /**
   * Do not ask the rail this tick: enough consecutive failures have already been seen to
   * conclude the fault is not per-row.
   *
   * Not the same as a rail that cannot answer. Choosing not to ask must never become `expired`,
   * which asserts the buyer did not pay, nor `unobserved`, which asserts the chances ran out.
   * A row simply waits for the next tick; only the branches needing no upstream call still run.
   */
  deferred: boolean,
  sessionMaxAgeMs: number,
): Promise<Advance | undefined> {
  // A reservation that never reached the rail cannot have been paid, so there is nothing to
  // observe, only to age out. Asking would spend a lookup on a reference the rail never heard of.
  if (record.status === 'created') {
    // `unobserved`, and the reference is kept. The reservation is written before the rail is
    // called, so this row may already have an open settlement surface: the orphan case where
    // `rail.createSession` answered and the write recording it failed.
    //
    // `expired` would claim the buyer did not pay without having asked anyone, which `state.ts`
    // forbids for this record. Releasing the key would be worse: a retry under it opens a second
    // settlement surface for one buyer intent, so holding it costs a retry where releasing it
    // costs a second charge.
    return now > deadlineFor(record, sessionMaxAgeMs) ? { state: 'unobserved' } : undefined;
  }

  if (record.status === "session_opened") {
    // Ask the leg first, so a buyer who paid just before the settlement surface expired is not
    // mislabelled. Expiry is a fallback for a session with no transaction, never a mask for one.
    //
    // Not asked this tick. Inside the window that means wait, because concluding would turn the
    // worker's own back-off into a claim about the buyer. Past it the window is closed and asking
    // stops whether or not this tick chose to, so the row concludes as `unobserved`, the same
    // answer the structurally identical "cannot ask" case gives below. Returning unconditionally
    // would instead leave every row behind three failures unconcluded for a full
    // `session_max_age_ms`.
    if (deferred) {
      return now > deadlineFor(record, sessionMaxAgeMs)
        ? { state: "unobserved" }
        : undefined;
    }

    // No observation wired for this rail, and that is permanent, so it concludes like any other
    // unreachable rail: `unobserved` past the window, and reported until then.
    if (obs === undefined) {
      if (now > deadlineFor(record, sessionMaxAgeMs))
        return { state: "unobserved" };
      throw new Error(
        `in-flight funding request on rail "${record.rail}" has no observation wired; ` +
          'it cannot be concluded and will age out only on local grounds',
      );
    }

    // A finder that throws is a different fact from one that answers "nothing yet": evidence
    // about the lookup, never about the buyer. Past the window it concludes as `unobserved`; only
    // an answering finder may produce `expired`. Inside it, the error is reported and the next
    // tick tries again, so a transient outage stays transient.
    let txn: TransactionObservation | undefined;
    try {
      txn = await obs.finder(record);
    } catch (cause) {
      if (now > deadlineFor(record, sessionMaxAgeMs)) {
        // The only path that turns an error into a terminal state, so the reason is logged with
        // it; otherwise an operator is left with a terminal record and no cause.
        log(
          `funding worker concluded ${record.id} as unobserved: its observation window closed while ` +
            `the rail could not be asked: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
        return { state: 'unobserved' };
      }
      throw cause;
    }
    if (txn !== undefined) {
      // A payment was observed: capture the transaction and its status for a later conclusion,
      // and any provider-issued fact disclosed the same moment. On a sell, Meld's own deposit
      // address lives on the transaction record (see `meld/rail.ts`), so it can already be
      // populated the very first time a transaction is seen at all.
      return {
        state: "transaction_seen",
        discovered: {
          providerTransactionId: txn.id,
          providerStatus: txn.status ?? null,
          ...(txn.deposit !== undefined && depositIsNew(record, txn.deposit) ? { deposit: txn.deposit } : {}),
        },
      };
    }

    // No transaction yet, and `expired` is terminal, so `deadlineFor` decides how long to keep
    // looking.
    //
    // Concluding here does not release the caller's idempotency reference, and no worker path
    // ever does: only `Onramp` releases, on a definitive rail refusal. An expired row has a real
    // session id to replay, and a `created` row may have an unrecorded settlement surface, so
    // releasing either would let one key open a second upstream session.
    if (now > deadlineFor(record, sessionMaxAgeMs)) {
      return { state: "expired" };
    }
    return undefined;
  }

  // `transaction_seen` is the only remaining state: `claim` returns non-terminal rows only, and
  // `created`/`session_opened` are handled above.

  // Stop asking past the observation window.
  //
  // The mapper answers `transaction_seen` for every status outside the handful a rail has taught
  // it to recognise, so a transaction that never reaches a recognised ending would otherwise be
  // re-fetched every tick for the life of the database, draining the same quota the rate limiter
  // protects. `unobserved` rather than `undefined`, which would stop the mapping but leave the row
  // non-terminal and rescanned for ever; and rather than `expired`, which would assert the buyer
  // did not pay when a transaction was seen. The transaction id and the timeline are kept.
  //
  // The window runs from `updated_at`, the instant this row reached `transaction_seen`, which does
  // not move again while it stays there. Measuring from `created_at` would leave a payment seen
  // late in a request's life only the remainder of that life to conclude in.
  //
  // Logged, unlike the `session_opened` timeout above it: a request that never got as far as a
  // transaction ageing out is the ordinary shape of an abandoned purchase, but one that DID reach
  // a transaction and then aged out anyway means either an unrecognised terminal status (the
  // mapper's fall-through is what makes that possible at all -- see `MELD_STATUS_TO_STATE`) or,
  // worse on a sell, a deposit address the seller was shown with no settlement ever observed
  // against it. Neither should conclude without a trace an operator can find.
  if (now > record.updated_at + sessionMaxAgeMs) {
    const detail =
      record.deposit_address === undefined
        ? `its status stayed "${record.provider_status ?? 'unknown'}"`
        : 'a deposit address was disclosed to the seller but no settlement was ever observed';
    log(
      `funding worker concluded ${record.id} as unobserved: ${detail}, past the observation ` +
        'window without reaching a recognised ending',
    );
    return { state: "unobserved" };
  }

  // Re-observe, rather than re-mapping the status frozen at discovery. `provider_status` is
  // written once, on the `session_opened -> transaction_seen` edge, so mapping that stored value
  // again can only produce the answer it produced last time and the state would be absorbing.
  //
  // The window check above needs no upstream call, so it still runs when the tick has stopped
  // asking or the rail has no observation. Beyond it there is nothing to do without the rail.
  if (deferred) return undefined;
  if (obs === undefined)
    throw new Error(
      `no transaction observation wired for rail "${record.rail}"`,
    );

  const txn = await obs.finder(record);
  const status = txn?.status ?? record.provider_status;
  const state = obs.mapper(status ?? undefined);
  // The refreshed facts ride along with the state move, so a conclusion records the status it
  // concluded on. The id/status pair is written only when the state actually changes (`tick`
  // skips the write otherwise), which is why the re-observation above, not the stored value, is
  // what keeps a still-pending transaction mapping against the newest fact. `deposit` is the one
  // exception: `tick` writes it even when `state` does not move, because a sell's deposit address
  // is exactly the fact that arrives while a row sits here unmoved.
  return txn === undefined
    ? { state }
    : {
        state,
        discovered: {
          providerTransactionId: txn.id,
          providerStatus: txn.status ?? null,
          ...(txn.deposit !== undefined && depositIsNew(record, txn.deposit) ? { deposit: txn.deposit } : {}),
        },
      };
}

/**
 * Whether `deposit` tells the store something it does not already have.
 *
 * Without this, `tick` would write every tick for the life of a disclosed sell: `depositFrom`
 * (`meld/rail.ts`) reports the same address on every poll once the provider has populated the
 * field on the transaction record, not only the first time it appears, so a naive "a deposit is
 * present" check never goes back to "nothing to do" once one exists. Every such write bumps
 * `updated_at`, which is exactly the column `deadlineFor`'s `transaction_seen` branch measures
 * its window from -- so a clean, settled disclosure would otherwise keep this row's deadline
 * sliding forward for ever, and the `session_max_age_ms` safety valve (and the claim slot it
 * frees on ageing out) would never fire for a sell that never settles.
 *
 * Two things count as "not new", both compared against the record as it stood before this poll:
 *
 * 1. It matches what is already accepted. **Canonicalised on both sides**, not a raw comparison:
 *    `record.deposit_address` is always canonical (`mergeDeposit` never stores anything else),
 *    while `deposit.address` is the rail's raw string, and the two encodings are not the same
 *    string for the same account whenever a rail's own default prefix differs from Polkadot's
 *    canonical one (0) -- which, per `address.ts`, is the *default* SS58 behaviour (42), not an
 *    exotic case. Comparing the raw forms directly would make the ordinary case look "new" on
 *    every single poll for ever, undoing the entire point of this function for the common
 *    disclosure rather than only an unusual one. Amount/currency/memo are compared as reported,
 *    for whichever of them the rail bothered to include this time.
 * 2. It matches the address already on file as a *known conflict* (`deposit_conflict_address`).
 *    Without this second case, a rail that keeps disclosing the same wrong address would look
 *    "new" on every single tick for ever, and each of those writes would re-run
 *    `mergeDeposit`'s conflict path -- correct in isolation, but reintroducing the exact
 *    perpetual-write problem this function exists to close, just for the conflicted case instead
 *    of the clean one. This one stays a **raw** comparison, deliberately: `mergeDeposit` stores
 *    `deposit_conflict_address` as the rail's own unmodified string (see its doc comment), exactly
 *    so this dedup can stay cheap and does not need to re-derive a canonical form of a value that
 *    may not even canonicalise at all (a malformed disclosure has no canonical form to compare).
 *
 * A `deposit.address` that does not canonicalise never matches (1) -- there is nothing valid to
 * compare it against -- so it correctly falls through to be recorded as a conflict by
 * `mergeDeposit` rather than being silently absorbed here as "no different from what we have".
 */
function depositIsNew(record: FundingRecord, deposit: RailDeposit): boolean {
  const canonical = canonicalizeDisclosedAddress(deposit.address);
  const matchesAccepted =
    canonical !== undefined &&
    record.deposit_address === canonical &&
    // `currency` is required on `RailDeposit` (see its doc comment), unlike `amount` and `memo`.
    record.deposit_currency === deposit.currency &&
    (deposit.amount === undefined || record.deposit_amount === deposit.amount) &&
    (deposit.memo === undefined || record.deposit_memo === deposit.memo);
  const matchesKnownConflict = record.deposit_conflict_address === deposit.address;
  return !matchesAccepted && !matchesKnownConflict;
}

/**
 * Drive `tick` on an interval, `unref()`'d so the loop never holds the process open on its own.
 *
 * A tick error is logged, not thrown: an upstream hiccup on one request must not kill the loop.
 * Returns a `stop()` that clears the interval so `startup` can tear the worker down on shutdown.
 *
 * The loop is non-overlapping: if a tick is still awaiting the injected finder when the next is
 * due, that tick is skipped rather than started over it. `setInterval` is a cadence, not a
 * guarantee the previous tick finished, and two ticks advancing the same row are how an
 * `IllegalTransition` slips through a read-modify-write gap.
 */
export function startWorker(
  store: Pick<FundingStore, 'claim' | 'release' | 'update' | 'pruneRefusals'>,
  intervalMs: number,
  observations: Readonly<Partial<Record<RailName, RailObservation>>>,
  sessionMaxAgeMs: number,
  log: WorkerLog,
  clock: Clock = Date.now,
  // One lease for the life of this worker, so every tick claims under the same name and a row
  // this worker already holds is not contested by its own next tick.
  lease: Lease = newLease(),
  /**
   * How long a refused row is kept. Omitted, nothing is pruned. That is what every test that
   * does not care about retention gets, so a sweep cannot surprise an assertion about ticks.
   */
  retentionDays?: number,
): { stop: (graceMs?: number) => Promise<void> } {
  // One object for the life of the worker, because it carries when the last sweep ran.
  const retention: Retention | undefined =
    retentionDays === undefined ? undefined : { days: retentionDays, everyMs: 3_600_000, lastSweptAt: undefined };
  // The tick in flight, if there is one. `stop` awaits it, because the caller closes the store
  // next and pulling the pool out from under a running tick kills a live `update` mid-write and
  // leaves its leased rows claimed until they expire.
  let inFlight: Promise<void> | undefined;
  // Every row this worker still holds, accumulated across ticks. Only a tick that reached its
  // `finally` adds to it, so a tick abandoned past the shutdown grace is never in here and `stop`
  // cannot clear a lease out from under a live write.
  const held = new Map<string, number>();
  const timer = setInterval(() => {
    if (inFlight !== undefined) return; // a prior tick is still awaiting a finder; don't stack on it
    inFlight = tick(store, clock(), observations, sessionMaxAgeMs, log, lease, retention, held)
      .then(() => undefined)
      .catch((error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error);
        log(`funding worker tick failed: ${reason}`);
      })
      .finally(() => {
        inFlight = undefined;
      });
  }, intervalMs);
  timer.unref();
  return {
    /**
     * Stop the interval and wait for a tick already in flight, but not for ever.
     *
     * The wait keeps the caller from closing the store out from under a live `update`. It is
     * bounded because what is being waited on is a network call to a payment rail: an unbounded
     * wait would turn one hung request into a shutdown that never completes, which Kubernetes
     * answers with SIGKILL, the abrupt teardown this wait exists to avoid. Past the bound the
     * tick is abandoned and its leases expire on their own.
     */
    stop: async (graceMs = 5_000) => {
      clearInterval(timer);
      // No grace asked for means no wait and no timer, because racing a `setTimeout(..., 0)` hangs
      // under the fake timers the tests drive the loop with. The release below still runs.
      if (inFlight !== undefined && graceMs > 0) {
        let timeout: NodeJS.Timeout | undefined;
        await Promise.race([
          inFlight,
          new Promise<void>((resolve) => {
            timeout = setTimeout(resolve, graceMs);
          }),
        ]);
        if (timeout !== undefined) clearTimeout(timeout);
      }

      // Hand back everything still held. A saturated batch is kept so the next tick reaches
      // different rows, but there is not going to be a next tick, and leaving those leases to
      // expire would cost the replacement pod a full ttl before it could touch them.
      //
      // Only a tick that reached its `finally` put ids in here, and by then its writes are done,
      // so no guard is needed. The set is cleared so a second `stop` is a no-op, and failure is
      // logged rather than thrown because expiry still recovers it.
      if (held.size > 0) {
        const ids = [...held.keys()];
        held.clear();
        try {
          await store.release(lease.workerId, ids);
        } catch (error) {
          log(
            `funding worker could not release its claims on shutdown: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    },
  };
}
