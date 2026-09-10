import { describe, expect, it, vi } from 'vitest';

import { fakeStore, fundingRecord } from '../fixtures.js';

import type { FundingRecord } from '../../src/funding/types.js';
import {
  newLease,
  startWorker,
  tick,
  type Lease,
  type RailObservation,
  type TransactionFinder,
  type TransactionMapper,
  type TransactionObservation,
} from '../../src/funding/worker.js';
import type { FundingState } from '../../src/funding/state.js';
import type { RailName } from '../../src/rail.js';

const NOW = 1_700_000_000_000;
/** The local ceiling for a session the rail gave no expiry for. A day, as config defaults to. */
const MAX_AGE = 24 * 3_600_000;
/** A sink for the tick's per-record error reports; tests that care assert on it. */
const notes = () => {
  const lines: string[] = [];
  return { lines, log: (m: string) => lines.push(m) };
};
/** "Still in flight": what a mapper says when no terminal rule applies yet. */
const INCONCLUSIVE: TransactionMapper = () => 'transaction_seen';

const record = (overrides: Partial<FundingRecord> = {}): FundingRecord => fundingRecord(overrides);

/** A lease for a tick under test. Fixed id, because most assertions do not care which worker. */
const lease = (workerId = 'test-worker'): Lease => ({ workerId, ttlMs: 60_000, batch: 50 });

/** A store with `update` spied on, so a test can assert whether a write happened. */
const tracking = (initial: readonly FundingRecord[] = []) => {
  const store = fakeStore(initial);
  return { store, updated: vi.spyOn(store, 'update') };
};

/** Wrap a finder/mapper pair as a full per-rail observation set (real values against 'meld'). */
const observations = (
  finder: TransactionFinder,
  mapper: TransactionMapper = INCONCLUSIVE,
): Readonly<Partial<Record<RailName, RailObservation>>> => ({ meld: { finder, mapper } });

/** A found transaction, as the worker sees it (provider-neutral). */
const txn = (id = 'tx-1', status: TransactionObservation['status'] = 'SUCCEEDED'): TransactionObservation => ({
  id,
  status,
});

describe('the worker tick', () => {
  it('leaves a request alone when nothing has transacted yet', async () => {
    const { store, updated } = tracking();
    await store.create(record());

    const advanced = await tick(store, NOW, observations(async () => undefined), MAX_AGE, () => undefined, lease());

    expect(advanced).toBe(0);
    expect(updated).not.toHaveBeenCalled();
    expect((await store.byId('funding-1'))?.status).toBe('session_opened');
    await store.close();
  });

  it('expires a captured-but-unpaid page once past the observation window', async () => {
    const { store } = tracking();
    await store.create(record({ expires_at: NOW - 1, created_at: NOW - MAX_AGE - 1 }));
    const finder = vi.fn(async () => undefined);

    const advanced = await tick(store, NOW, observations(finder), MAX_AGE, () => undefined, lease());

    expect(advanced).toBe(1);
    // The finder is still consulted: expiry is a fallback, never a mask for a payment.
    expect(finder).toHaveBeenCalled();
    expect((await store.byId('funding-1'))?.status).toBe('expired');
    await store.close();
  });

  it('expires a session the rail gave no deadline for, once past the local ceiling', async () => {
    // The bug: expiry was only ever checked when the rail supplied `expires_at`. Both rails may
    // omit it (Meld's is nullish, a Chainflip channel need not carry one), and nothing else
    // moves a `session_opened` row, so such a record came back from every scan for the life of
    // the database. `record()` builds exactly that shape: `expires_at: undefined`.
    const { store } = tracking();
    await store.create(record({ expires_at: undefined, created_at: NOW - MAX_AGE - 1 }));

    const advanced = await tick(store, NOW, observations(async () => undefined), MAX_AGE, () => undefined, lease());

    expect(advanced).toBe(1);
    expect((await store.byId('funding-1'))?.status).toBe('expired');
    await store.close();
  });

  it('leaves a young session with no rail deadline in flight', async () => {
    // The ceiling must not cut short a buyer who is still mid-KYC. Only age ends it.
    const { store } = tracking();
    await store.create(record({ expires_at: undefined, created_at: NOW - 1_000 }));

    const advanced = await tick(store, NOW, observations(async () => undefined), MAX_AGE, () => undefined, lease());

    expect(advanced).toBe(0);
    expect((await store.byId('funding-1'))?.status).toBe('session_opened');
    await store.close();
  });

  it("keeps watching after the rail's own deadline passes, because that is not proof of non-payment", async () => {
    // Meld's `expiresAt` is when its capture page closes, not evidence the buyer did not pay: a
    // first-time KYC can outlast it. Treating it as the deadline marked paid purchases `expired`,
    // terminally, while the card had been charged. The local window is a floor.
    const { store } = tracking();
    await store.create(record({ expires_at: NOW - 1, created_at: NOW - 1_000 }));

    const advanced = await tick(store, NOW, observations(async () => undefined), MAX_AGE, () => undefined, lease());

    expect(advanced).toBe(0);
    expect((await store.byId('funding-1'))?.status).toBe('session_opened');
    await store.close();
  });

  it("lets a rail deadline *longer* than the window extend it", async () => {
    const { store } = tracking();
    await store.create(record({ expires_at: NOW + 10_000, created_at: NOW - MAX_AGE - 1 }));

    const advanced = await tick(store, NOW, observations(async () => undefined), MAX_AGE, () => undefined, lease());

    expect(advanced).toBe(0);
    await store.close();
  });

  it('never lets an expired capture page mask a payment made just before it expired', async () => {
    // The row must be past its deadline, not merely past `expires_at`: `deadlineFor` is
    // `max(expires_at, created_at + maxAge)`, so the fixture's default `created_at: NOW` put the
    // deadline a full window away and the expiry branch was never reached. The test silently
    // degenerated into a copy of the one below it, and the property it is named for, that the
    // finder is asked before expiry is applied, had nothing covering it.
    const { store } = tracking();
    const opened = NOW - MAX_AGE - 1_000;
    await store.create(record({ created_at: opened, updated_at: opened, expires_at: NOW - 1 }));

    const advanced = await tick(store, NOW, observations(async () => txn('tx-1', 'PENDING')), MAX_AGE, () => undefined, lease());

    expect(advanced).toBe(1);
    const seen = await store.byId('funding-1');
    expect(seen?.status).toBe('transaction_seen');
    expect(seen?.provider_transaction_id).toBe('tx-1');
    await store.close();
  });

  it('attaches the transaction the moment it is seen', async () => {
    const { store } = tracking();
    await store.create(record());

    const advanced = await tick(store, NOW, observations(async () => txn('tx-1', 'PENDING')), MAX_AGE, () => undefined, lease());

    expect(advanced).toBe(1);
    const seen = await store.byId('funding-1');
    expect(seen?.status).toBe('transaction_seen');
    expect(seen?.provider_transaction_id).toBe('tx-1');
    expect(seen?.provider_status).toBe('PENDING');
    await store.close();
  });

  it('keeps a session in flight on the exact capture deadline (strictly after it is when it expires)', async () => {
    // Created long enough ago that the local window has already passed, so `expires_at` is the
    // deadline and `NOW` sits exactly on it. With the fixture's default timestamps the deadline
    // is a day away and this asserts nothing about the boundary at all.
    const { store } = tracking();
    const opened = NOW - MAX_AGE - 1_000;
    // With a reference held, so the non-release below is actually asserted. Every fixture reaching
    // this branch used `fundingRecord()`'s default of `undefined`, so nine lines of comment saying
    // the key must not be released had nothing behind them.
    await store.create(
      record({ created_at: opened, updated_at: opened, expires_at: NOW, client_reference: 'app-stable-1' }),
    );
    const finder = vi.fn(async () => undefined);

    expect(await tick(store, NOW, observations(finder), MAX_AGE, () => undefined, lease())).toBe(0);
    expect(finder).toHaveBeenCalled();
    expect((await store.byId('funding-1'))?.status).toBe('session_opened');

    // One millisecond past it, and only then, the request is written off.
    expect(await tick(store, NOW + 1, observations(finder), MAX_AGE, () => undefined, lease())).toBe(1);
    expect((await store.byId('funding-1'))?.status).toBe('expired');
    // And the key stays bound: releasing it would let one key open a second upstream session,
    // which is the thing the key exists to prevent. Only a row with no answer to give releases.
    expect((await store.byId('funding-1'))?.client_reference).toBe('app-stable-1');
    await store.close();
  });

  it('records the transaction id even when the rail omits a status for it', async () => {
    const { store } = tracking();
    await store.create(record());

    // A rail's transaction status is opaque and may be absent; the worker must still capture the
    // id (the join key for a later conclusion) and leave the mapping to a future tick.
    const advanced = await tick(
      store,
      NOW,
      observations(async () => ({ id: 'tx-null-status', status: null })),
      MAX_AGE,
      () => undefined,
      lease(),
    );

    expect(advanced).toBe(1);
    const seen = await store.byId('funding-1');
    expect(seen?.provider_transaction_id).toBe('tx-null-status');
    expect(seen?.provider_status).toBeUndefined();
    await store.close();
  });

  it('does not advance for a rail status the mapper has no terminal rule for', async () => {
    const { store } = tracking();
    await store.create(record({ status: 'transaction_seen', provider_transaction_id: 'tx-1', provider_status: 'PENDING' }));
    const { lines, log } = notes();

    const advanced = await tick(store, NOW, observations(async () => undefined), MAX_AGE, log, lease());

    expect(advanced).toBe(0);
    expect((await store.byId('funding-1'))?.status).toBe('transaction_seen');
    // Quietly alone. The mapper says `transaction_seen` for a record already in that state, and
    // without the same-state guard that reaches `store.update` as a transition to itself, which
    // the state machine refuses. The record would still not advance; it would just log an
    // `IllegalTransition` on every tick, for every pending record, until one settled.
    expect(lines).toEqual([]);
    await store.close();
  });

  it('concludes a transaction_seen request when the mapper names a terminal state', async () => {
    const { store } = tracking();
    await store.create(record({ status: 'transaction_seen', provider_transaction_id: 'tx-1', provider_status: 'SUCCEEDED' }));

    const advanced = await tick(
      store,
      NOW,
      observations(async () => undefined, (status) => (status === 'SUCCEEDED' ? 'settled' : 'failed')),
      MAX_AGE,
      () => undefined,
      lease(),
    );

    expect(advanced).toBe(1);
    expect((await store.byId('funding-1'))?.status).toBe('settled');
    await store.close();
  });

  it('is idempotent: a second tick advances nothing already done', async () => {
    const { store } = tracking();
    await store.create(record({ status: 'transaction_seen', provider_transaction_id: 'tx-1', provider_status: 'SUCCEEDED' }));
    const mapper = (status: string | undefined) => (status === 'SUCCEEDED' ? 'settled' : 'failed');

    await tick(store, NOW, observations(async () => undefined, mapper), MAX_AGE, () => undefined, lease());
    const second = await tick(store, NOW, observations(async () => undefined, mapper), MAX_AGE, () => undefined, lease());

    expect(second).toBe(0);
    expect((await store.byId('funding-1'))?.status).toBe('settled');
    await store.close();
  });

  it('never advances a terminal or created request', async () => {
    const { store } = tracking();
    await store.create(record({ id: 'done', status: 'settled' }));
    await store.create(record({ id: 'fresh', status: 'created', provider_session_id: undefined }));

    const advanced = await tick(store, NOW, observations(async () => txn()), MAX_AGE, () => undefined, lease());

    expect(advanced).toBe(0);
    expect((await store.byId('done'))?.status).toBe('settled');
    expect((await store.byId('fresh'))?.status).toBe('created');
    await store.close();
  });

  it('refuses a request whose rail has no observation wired, rather than leaving it in flight', async () => {
    const { store } = tracking();
    await store.create(record({ rail: 'chainflip', provider_session_id: 'cf-1' }));

    // A partial set covering only Meld: the chainflip row has no finder/mapper.
    const onlyMeld: Partial<Record<RailName, RailObservation>> = { meld: { finder: async () => undefined, mapper: INCONCLUSIVE } };
    const { lines, log } = notes();

    // Reported per record rather than thrown out of the tick: an unwired rail must not abort the
    // records behind it, which `listInFlight`'s stable `created_at ASC` order would make permanent.
    await expect(tick(store, NOW, onlyMeld, MAX_AGE, log, lease())).resolves.toBe(0);
    expect(lines.join(' ')).toContain('chainflip');
    // The row is untouched, and reported loudly instead of a silent no-op.
    expect((await store.byId('funding-1'))?.status).toBe('session_opened');
    await store.close();
  });
});

describe('startWorker', () => {
  it('drives the tick on an interval and stops on request', async () => {
    vi.useFakeTimers();
    const { store } = tracking();
    await store.create(record());
    const finder = vi.fn(async () => undefined);
    const log = vi.fn();

    const worker = startWorker(store, 1_000, observations(finder), MAX_AGE, log, () => NOW);
    await vi.advanceTimersByTimeAsync(2_000);
    await worker.stop(0);
    await vi.advanceTimersByTimeAsync(2_000);

    // The loop's observable side effect is consulting the finder once per tick; asserting the
    // finder ran proves the interval actually fired (a no-op store leaves status unchanged, so
    // asserting only the status would be vacuously green even if the loop never ran).
    expect(finder.mock.calls.length).toBeGreaterThan(0);
    expect((await store.byId('funding-1'))?.status).toBe('session_opened');
    vi.useRealTimers();
    await store.close();
  });

  it('unrefs its interval, so the loop never holds the process open on its own', async () => {
    // `startWorker` is called during boot and the timer outlives every request. Without this a
    // process whose caller forgot `close()` never exits, and the only symptom is a hung shutdown.
    const unref = vi.fn();
    const spy = vi
      .spyOn(globalThis, 'setInterval')
      .mockReturnValue({ unref } as unknown as ReturnType<typeof setInterval>);
    const { store } = tracking();

    await startWorker(store, 1_000, observations(async () => undefined), MAX_AGE, () => undefined, () => NOW).stop();
    // Restored before asserting: a failed assertion here would otherwise leave `setInterval`
    // mocked for every test after it, burying the real failure under a cascade.
    spy.mockRestore();
    await store.close();

    expect(unref).toHaveBeenCalled();
  });

  it('leaves a young record alone when the rail has seen no transaction', async () => {
    // This replaces a test that ran the worker with do-nothing "honest default" observations and
    // asserted nothing happened. Those defaults were not neutral: with a finder that always says
    // "no transaction", the worker falls through to expiry and marks paid purchases `expired`.
    // They are gone; a wired-but-quiet finder is the real version of that scenario.
    const { store } = tracking();
    await store.create(record());
    const log = vi.fn();

    const worker = startWorker(store, 10, observations(async () => undefined), MAX_AGE, log, () => NOW);
    await new Promise((resolve) => setTimeout(resolve, 40));
    await worker.stop(0);

    expect(log).not.toHaveBeenCalled();
    expect((await store.byId('funding-1'))?.status).toBe('session_opened');
    await store.close();
  });

  it('never overlaps ticks: a slow finder holds the loop so the next interval does not stack on it', async () => {
    vi.useFakeTimers();
    const { store } = tracking();
    await store.create(record());
    const log = vi.fn();
    // A finder that never resolves within the test window keeps a tick in-flight; a naive
    // setInterval would fire another tick on top; an overlapping one mistakes a row it is
    // already transitioning. Non-overlap is why the loop survives a slow leg.
    const finder = vi.fn(() => new Promise<undefined>(() => {}));
    const worker = startWorker(store, 100, observations(finder), MAX_AGE, log, () => NOW);

    await vi.advanceTimersByTimeAsync(10_000);

    // The first tick has started; the guard must keep every later interval from starting another.
    expect(finder).toHaveBeenCalledTimes(1);
    await worker.stop(0);
    vi.useRealTimers();
    await store.close();
  });

  it('logs a tick failure instead of throwing: one bad leg must not kill the loop', async () => {
    const { store } = tracking();
    await store.create(record());
    const log = vi.fn();

    // A finder that rejects. The loop must log the failure and keep running, not throw out of
    // `startWorker`. A short real interval lets the tick fire; `stop` tears it down.
    const worker = startWorker(
      store,
      10,
      observations(() => Promise.reject(new Error('rail down'))),
      MAX_AGE,
      log,
      () => NOW,
    );
    await new Promise((resolve) => setTimeout(resolve, 40));
    await worker.stop(0);

    expect(log).toHaveBeenCalledWith(expect.stringContaining('rail down'));
    await store.close();
  });
});

describe('pruning refused requests', () => {
  const retention = (lastSweptAt?: number) => ({ days: 90, everyMs: 3_600_000, lastSweptAt });

  it('sweeps once, then not again until the interval has passed', async () => {
    // A tick is every fifteen seconds by default and the rows are ninety days old, so a DELETE per
    // tick would be thousands of pointless queries a day against the request path's own pool.
    const cutoffs: number[] = [];
    const store = {
      claim: async () => [],
      release: async () => undefined,
      update: async () => undefined,
      pruneRefusals: async (cutoff: number) => {
        cutoffs.push(cutoff);
        return 0;
      },
    };
    const window = retention();

    await tick(store, NOW, observations(async () => undefined), MAX_AGE, () => undefined, lease(), window);
    await tick(store, NOW + 60_000, observations(async () => undefined), MAX_AGE, () => undefined, lease(), window);
    await tick(store, NOW + 3_600_001, observations(async () => undefined), MAX_AGE, () => undefined, lease(), window);

    expect(cutoffs).toHaveLength(2);
    // Ninety days behind the tick's own clock, not behind wall time.
    expect(cutoffs[0]).toBe(NOW - 90 * 24 * 3_600_000);
  });

  it('recovers the cadence after the clock jumps backwards', async () => {
    // NTP steps a node back, or a replacement pod comes up behind the one it replaced. `now -
    // lastSweptAt` is then negative, which reads as "not yet" against any positive interval, so
    // without the guard the sweep is not skipped for an hour; it is skipped until wall time climbs
    // back past the stamp, and a large enough step means never. Refusals then accumulate for ever
    // while the log says nothing, which is the failure mode retention exists to prevent.
    const cutoffs: number[] = [];
    const store = {
      claim: async () => [],
      release: async () => undefined,
      update: async () => undefined,
      pruneRefusals: async (cutoff: number) => {
        cutoffs.push(cutoff);
        return 0;
      },
    };
    // Swept at NOW, then the clock steps a day back.
    const window = retention(NOW);
    const behind = NOW - 24 * 3_600_000;

    await tick(store, behind, observations(async () => undefined), MAX_AGE, () => undefined, lease(), window);
    // Not this tick: the stamp is corrected, and the interval is honoured from the new clock.
    expect(cutoffs).toEqual([]);
    expect(window.lastSweptAt).toBe(behind);

    await tick(store, behind + 3_600_001, observations(async () => undefined), MAX_AGE, () => undefined, lease(), window);

    expect(cutoffs).toEqual([behind + 3_600_001 - 90 * 24 * 3_600_000]);
  });

  it('logs what it deleted, and only when it deleted something', async () => {
    const { lines, log } = notes();
    const store = {
      claim: async () => [],
      release: async () => undefined,
      update: async () => undefined,
      pruneRefusals: async () => 7,
    };

    await tick(store, NOW, observations(async () => undefined), MAX_AGE, log, lease(), retention());
    expect(lines.join(' ')).toContain('pruned 7 refused request(s) older than 90 days');

    const quiet = notes();
    await tick(
      { ...store, pruneRefusals: async () => 0 },
      NOW,
      observations(async () => undefined),
      MAX_AGE,
      quiet.log,
      lease(),
      retention(),
    );
    expect(quiet.lines).toEqual([]);
  });

  it('advances requests even when the sweep fails', async () => {
    // Housekeeping must not stop the tick. A sweep that cannot run is a storage problem; the rows
    // it would have deleted are ninety days old, and the buyer waiting on an advance is not.
    const { lines, log } = notes();
    const store = {
      claim: async () => [record({ status: 'session_opened', created_at: NOW - MAX_AGE - 1 })],
      release: async () => undefined,
      update: async () => record({ status: 'unobserved' }),
      pruneRefusals: () => Promise.reject(new Error('permission denied for table funding_requests')),
    };

    const advanced = await tick(store, NOW, observations(async () => undefined), MAX_AGE, log, lease(), retention());

    expect(advanced).toBe(1);
    expect(lines.join(' ')).toContain('could not prune refused requests');
  });

  it('sweeps nothing when no retention is configured', async () => {
    const calls: number[] = [];
    const store = {
      claim: async () => [],
      release: async () => undefined,
      update: async () => undefined,
      pruneRefusals: async (cutoff: number) => {
        calls.push(cutoff);
        return 0;
      },
    };

    await tick(store, NOW, observations(async () => undefined), MAX_AGE, () => undefined, lease());

    expect(calls).toEqual([]);
  });
});

describe('naming the lease on every advance', () => {
  it('passes its own claim to the store, so a moved-on lease cannot land a write', async () => {
    // `store.update`'s claim guard is the only thing stopping a replica whose lease expired
    // mid-rail-call from writing to a row another replica now owns. The store honours the guard
    // (`store.test.ts` proves that against real Postgres), but nothing proved the worker ever
    // names it: deleting `claimedBy` from the call left the whole suite green.
    //
    // The helper being tested and the wiring being untested is the same shape as the PID-derived
    // workerId, one layer up.
    const seen: (string | undefined)[] = [];
    const store = {
      claim: async () => [record({ status: 'session_opened', created_at: NOW - MAX_AGE - 1 })],
      release: async () => undefined,
      pruneRefusals: async () => 0,
      update: async (_id: string, _to: FundingState, _now: number, extra?: { claimedBy?: string }) => {
        seen.push(extra?.claimedBy);
        return record({ status: 'unobserved' });
      },
    };

    await tick(store, NOW, observations(async () => undefined), MAX_AGE, () => undefined, lease('worker-under-test'));

    expect(seen).toEqual(['worker-under-test']);
  });

  it('counts nothing when the store reports the lease has moved on', async () => {
    // A zero-row write comes back as `undefined`. Counting it anyway would report another
    // worker's advance as this one's, which both double-counts and hides the overlap.
    const store = {
      claim: async () => [record({ status: 'session_opened', created_at: NOW - MAX_AGE - 1 })],
      release: async () => undefined,
      pruneRefusals: async () => 0,
      update: async () => undefined,
    };

    const advanced = await tick(
      store,
      NOW,
      observations(async () => undefined),
      MAX_AGE,
      () => undefined,
      lease(),
    );

    expect(advanced).toBe(0);
  });
});

describe('releasing claims', () => {
  it('logs a failed release instead of turning a good tick into a failed one', async () => {
    // A rejection out of a `finally` replaces the value the block was returning. Without the
    // guard, a release that fails while the pool closes under a finishing tick reports every row
    // it correctly advanced as a failed tick: the shutdown noise the bounded `stop()` exists to
    // avoid, reintroduced one line lower.
    const { lines, log } = notes();
    const store = {
      claim: async () => [record({ status: 'session_opened', created_at: NOW - MAX_AGE - 1 })],
      release: () => Promise.reject(new Error('Cannot use a pool after calling end on the pool')),
      update: async () => record({ status: 'unobserved' }),
      pruneRefusals: async () => 0,
    };

    const advanced = await tick(store, NOW, observations(async () => undefined), MAX_AGE, log, lease());

    // The advance is still reported, and the release failure is visible rather than swallowed.
    expect(advanced).toBe(1);
    expect(lines.join(' ')).toContain('could not release its claims');
  });
});

describe('a settlement join that answers with nothing of ours', () => {
  it('concludes unobserved, never expired, so a buyer who paid is not told they did not', async () => {
    // `transactionByReference` throws when the filtered search returns rows without the
    // reference, which is evidence about the join rather than about the buyer.
    //
    // `expired` asserts the buyer did not pay. Reaching it because the lookup is broken is the
    // failure `state.ts` singles out: "Collapsing the two would put the first sentence in front of
    // a buyer whose card was charged, which is the one thing this record must never say."
    const { store } = tracking();
    await store.create(record({ status: 'session_opened', created_at: NOW - MAX_AGE - 1 }));
    const brokenJoin = async () => {
      throw new Error('Meld returned 2 transaction(s) for reference funding-1 and none carried it back. The settlement join is not what this client expects.');
    };
    const { lines, log } = notes();

    await tick(store, NOW, observations(brokenJoin), MAX_AGE, log, lease());

    expect((await store.byId('funding-1'))?.status).toBe('unobserved');
    // And it is visible, not silent: the operator has the sentence naming the cause.
    expect(lines.join(' ')).toContain('settlement join is not what this client expects');
  });
});

describe('worker identity', () => {
  it('gives two workers different ids', () => {
    // The lease is worth exactly as much as the id being unique. `worker-${process.pid}` is not:
    // the image runs `node` as its entrypoint with no init wrapper, so this process is PID 1 in
    // every container and every replica would call itself `worker-1`.
    //
    // With one name shared, the claim guard in `store.update` matches for whichever worker
    // writes: A's lease expires mid-rail-call, B takes the row under the same name, and A's write
    // still lands. Two workers advance one funding request, which is the thing the lease exists
    // to prevent, defeated by the lease's own identity.
    //
    // Nothing caught it because every other test here passes an explicit id. This one asserts the
    // value production actually uses.
    expect(newLease().workerId).not.toBe(newLease().workerId);
  });

  it('keeps one identity for the life of a worker, across ticks', async () => {
    // The other half. A fresh id per tick would be just as broken in the opposite direction:
    // the worker could not recognise its own claim from the previous tick, so every advance would
    // match zero rows and nothing would ever conclude.
    const { store } = tracking();
    await store.create(record());
    const claims: string[] = [];
    const spy = vi.spyOn(store, 'claim').mockImplementation(async (workerId: string) => {
      claims.push(workerId);
      return [];
    });

    const worker = startWorker(store, 5, observations(async () => undefined), MAX_AGE, () => undefined, () => NOW);
    await new Promise((resolve) => setTimeout(resolve, 40));
    await worker.stop(0);
    spy.mockRestore();

    expect(claims.length).toBeGreaterThan(1);
    expect(new Set(claims).size).toBe(1);
    // And it is the generated id, not a constant. `startWorker`'s default lease is the
    // production configuration (`startup.ts` calls it with five arguments), so a hardcoded
    // `worker-1` default would satisfy the set-of-one assertion above while reintroducing exactly
    // the collision the random id exists to prevent.
    expect(claims[0]).toMatch(/^worker-[0-9a-f-]{36}$/u);
  });

  it('hands back every batch it is still holding, not only the last one', async () => {
    // The lease is kept when a batch fills, so the next tick reaches different rows, and holding
    // is therefore cumulative: a saturated tick's rows stay leased across many later ticks by
    // design. Recording only the most recent batch meant the next non-saturated tick erased the
    // record of every earlier one, and `stop` handed back nothing.
    //
    // Three rows and a batch of two, which is the same shape as 400 rows and a batch of 50: tick 1
    // fills and keeps `r1,r2`; tick 2 claims only `r3` and is not saturated. The earlier test used
    // a single row with `batch: 1`, so every tick was saturated and this shape never occurred.
    const released: string[][] = [];
    const rows = [
      record({ id: 'r1', status: 'session_opened', created_at: 1_000 }),
      record({ id: 'r2', status: 'session_opened', created_at: 2_000 }),
      record({ id: 'r3', status: 'session_opened', created_at: 3_000 }),
    ];
    const leased = new Set<string>();
    const store = {
      claim: async (_w: string, _now: number, _ttl: number, limit: number) => {
        const free = rows.filter((r) => !leased.has(r.id)).slice(0, limit);
        for (const r of free) leased.add(r.id);
        return free;
      },
      release: async (_w: string, ids: readonly string[]) => {
        released.push([...ids]);
        for (const id of ids) leased.delete(id);
      },
      update: async () => undefined,
      pruneRefusals: async () => 0,
    };

    const lease = { workerId: 'worker-1', ttlMs: 60_000, batch: 2 };
    const held = new Map<string, number>();
    await tick(store, NOW, observations(async () => undefined), MAX_AGE, () => undefined, lease, undefined, held);
    await tick(store, NOW + 1, observations(async () => undefined), MAX_AGE, () => undefined, lease, undefined, held);

    // Tick 1 kept r1 and r2; tick 2 saw only r3 and released it, and did not forget the other two.
    expect(released).toEqual([['r3']]);
    expect([...held.keys()].sort()).toEqual(['r1', 'r2']);
  });

  it('forgets a held row once its lease has expired, so the set stays bounded', async () => {
    // A plain set would grow with cumulative throughput rather than with rows in flight: ids are
    // added on every saturated tick and removed only on the non-saturated branch, so one added
    // while saturated is never removed. Keyed by expiry, the bound is `ttlMs / interval x batch`,
    // and expiry is what enforces it.
    //
    // The row must stop being claimed for the leak to show: if it is re-claimed, the saturated
    // branch overwrites its entry and a leaking implementation looks identical. My first version of
    // this test re-claimed it, and both mutations survived.
    let rows = [record({ id: 'r1', status: 'session_opened' })];
    const store = {
      claim: async () => rows,
      release: async () => undefined,
      update: async () => undefined,
      pruneRefusals: async () => 0,
    };
    const lease = { workerId: 'worker-1', ttlMs: 60_000, batch: 1 };
    const held = new Map<string, number>();

    await tick(store, NOW, observations(async () => undefined), MAX_AGE, () => undefined, lease, undefined, held);
    expect([...held.keys()]).toEqual(['r1']);

    // r1 concludes and leaves the scan; the worker never sees it again.
    rows = [];
    await tick(store, NOW + 1_000, observations(async () => undefined), MAX_AGE, () => undefined, lease, undefined, held);
    // Inside the lease, so still held and handed back on shutdown.
    expect(held.size).toBe(1);

    await tick(store, NOW + 60_001, observations(async () => undefined), MAX_AGE, () => undefined, lease, undefined, held);
    // Past it: the lease has lapsed, so there is nothing for `stop` to release.
    expect(held.size).toBe(0);
  });

  it('drops an expired entry before re-claiming it, so stop cannot clear a live lease', async () => {
    // Once a lease lapses this worker can re-claim its own row, and if the id were still
    // recorded from the earlier tick, a `stop`
    // landing mid-tick would release a lease the current tick is writing under, so its guarded
    // `update` matches zero rows and the advance is silently discarded.
    //
    // Observed from inside the finder, which runs while the tick holds the row: end-state cannot
    // show this, because the tick's own `finally` re-adds the id either way.
    const store = {
      claim: async () => [record({ id: 'r1', status: 'session_opened' })],
      release: async () => undefined,
      update: async () => undefined,
      pruneRefusals: async () => 0,
    };
    const lease = { workerId: 'worker-1', ttlMs: 60_000, batch: 1 };
    const held = new Map<string, number>();

    await tick(store, NOW, observations(async () => undefined), MAX_AGE, () => undefined, lease, undefined, held);
    expect([...held.keys()]).toEqual(['r1']);

    let heldWhileWorking: boolean | undefined;
    const watching = observations(async () => {
      heldWhileWorking = held.has('r1');
      return undefined;
    });
    await tick(store, NOW + 60_001, watching, MAX_AGE, () => undefined, lease, undefined, held);

    // Not held at the moment the tick was working on it.
    expect(heldWhileWorking).toBe(false);
  });

  it('hands a held batch back on a graceful stop, so a rollout does not strand it', async () => {
    // The lease is deliberately kept when the batch fills, so the next tick reaches different
    // rows. That reasoning is about the next tick, and on shutdown there is not going to be one:
    // leaving it to expire made a rollout with more than `batch` rows in flight cost the
    // replacement pod a full lease ttl before it could touch them. Expiry is crash recovery; a
    // planned stop is not a crash.
    const released: string[][] = [];
    const store = {
      claim: async () => [record({ id: 'held-1', status: 'session_opened' })],
      release: async (_w: string, ids: readonly string[]) => {
        released.push([...ids]);
      },
      update: async () => undefined,
      pruneRefusals: async () => 0,
    };

    // batch of 1, so the single claimed row saturates it and the tick keeps the lease.
    const worker = startWorker(store, 5, observations(async () => undefined), MAX_AGE, () => undefined, () => NOW, {
      workerId: 'worker-1',
      ttlMs: 60_000,
      batch: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    // Nothing released while it ran, which is the whole point of holding a saturated batch.
    expect(released).toEqual([]);

    await worker.stop(50);

    expect(released).toEqual([['held-1']]);
  });

  it('logs a failed shutdown release rather than throwing out of stop', async () => {
    // `stop` is called from the signal handler, and the caller closes the store next. A rejection
    // here would surface as an unhandled one during shutdown, and the rows it failed to release
    // are recovered by lease expiry anyway, which is what expiry is for.
    const { lines, log } = notes();
    const store = {
      claim: async () => [record({ id: 'held-1', status: 'session_opened' })],
      release: () => Promise.reject(new Error('pool is closing')),
      update: async () => undefined,
      pruneRefusals: async () => 0,
    };

    const worker = startWorker(store, 5, observations(async () => undefined), MAX_AGE, log, () => NOW, {
      workerId: 'worker-1',
      ttlMs: 60_000,
      batch: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 30));

    await expect(worker.stop(50)).resolves.toBeUndefined();
    expect(lines.join(' ')).toContain('could not release its claims on shutdown');
  });

  it('does not re-claim the same rows when the batch filled, so newer rows are reached', async () => {
    // The starvation. `claim` takes the oldest `batch` non-terminal rows; releasing them all at the
    // end of every tick made the next tick claim exactly the same set. A `session_opened` row holds
    // its slot for the full 24-hour window, and every abandoned cart lingers that long. So with
    // more requests in flight than the batch, rows behind the oldest fifty were never examined,
    // and a buyer who had just paid waited behind yesterday's abandonments.
    //
    // Two rows and a batch of one, which is the same shape as fifty and fifty-one.
    const released: string[][] = [];
    const claims: string[][] = [];
    const rows = [
      record({ id: 'older', status: 'session_opened', created_at: 1_000 }),
      record({ id: 'newer', status: 'session_opened', created_at: 2_000 }),
    ];
    const leased = new Map<string, boolean>();
    const store = {
      claim: async (_w: string, _now: number, _ttl: number, limit: number) => {
        const free = rows.filter((r) => leased.get(r.id) !== true).slice(0, limit);
        for (const r of free) leased.set(r.id, true);
        claims.push(free.map((r) => r.id));
        return free;
      },
      release: async (_w: string, ids: readonly string[]) => {
        released.push([...ids]);
        for (const id of ids) leased.set(id, false);
      },
      update: async () => undefined,
      pruneRefusals: async () => 0,
    };

    const lease = { workerId: 'worker-1', ttlMs: 60_000, batch: 1 };
    await tick(store, NOW, observations(async () => undefined), MAX_AGE, () => undefined, lease);
    await tick(store, NOW + 1, observations(async () => undefined), MAX_AGE, () => undefined, lease);

    // The first tick filled its batch, so it kept the lease rather than handing the row straight
    // back, and the second tick therefore reached the row behind it.
    expect(released).toEqual([]);
    expect(claims).toEqual([['older'], ['newer']]);
  });

  it('releases immediately when the batch did not fill, so the common case keeps its latency', async () => {
    // The other half. With fewer in-flight rows than the batch, this tick saw everything and there
    // is nothing behind them; holding the lease would only delay the next look at a live buyer's
    // request by a full lease ttl.
    const released: string[][] = [];
    const store = {
      claim: async () => [record({ id: 'only', status: 'session_opened' })],
      release: async (_w: string, ids: readonly string[]) => {
        released.push([...ids]);
      },
      update: async () => undefined,
      pruneRefusals: async () => 0,
    };

    await tick(store, NOW, observations(async () => undefined), MAX_AGE, () => undefined, {
      workerId: 'worker-1',
      ttlMs: 60_000,
      batch: 50,
    });

    expect(released).toEqual([['only']]);
  });

  it('hands the store the lease ttl and batch it was built with, not a literal', async () => {
    // The spies above capture only the worker id, so replacing `lease.ttlMs` at the call site with
    // a literal `0` survived the whole suite: every tick test supplies its own lease and `tick`
    // always releases in its `finally`, so nothing ever re-claims against a live one. A zero ttl
    // lets two replicas claim the same row on every tick and both spend metered rail calls on it.
    const { store } = tracking();
    const seen: { ttl: number; batch: number; now: number }[] = [];
    const spy = vi.spyOn(store, 'claim').mockImplementation(
      async (_workerId: string, now: number, ttlMs: number, limit: number) => {
        seen.push({ ttl: ttlMs, batch: limit, now });
        return [];
      },
    );

    const worker = startWorker(store, 5, observations(async () => undefined), MAX_AGE, () => undefined, () => NOW);
    await new Promise((resolve) => setTimeout(resolve, 40));
    await worker.stop(0);
    spy.mockRestore();

    expect(seen.length).toBeGreaterThan(0);
    // The defaults `newLease()` mints, reaching the store unchanged. And the tick's own clock,
    // not a second reading of wall time, since the lease deadline is compared against it.
    expect(seen[0]).toEqual({ ttl: 120_000, batch: 50, now: NOW });
  });

  it('mints its default lease per worker, so two workers do not share one', async () => {
    // The set-of-one assertion above is satisfied by a constant. This is what is not.
    const claimsFor = async (): Promise<string> => {
      const { store } = tracking();
      let claimed = '';
      const spy = vi.spyOn(store, 'claim').mockImplementation(async (workerId: string) => {
        claimed = workerId;
        return [];
      });
      const worker = startWorker(store, 5, observations(async () => undefined), MAX_AGE, () => undefined, () => NOW);
      await new Promise((resolve) => setTimeout(resolve, 20));
      await worker.stop(0);
      spy.mockRestore();
      return claimed;
    };

    expect(await claimsFor()).not.toBe(await claimsFor());
  });

  it('gives its default lease a usable ttl and batch', async () => {
    // Neither was asserted anywhere: every `tick` test supplies its own lease. `ttlMs: 1` would
    // expire the claim before the first rail call returns (the crash-recovery bound gone, two
    // replicas free to take the same row), and `batch: 1` reduces the worker to a row per tick.
    // Exact, not one-sided. `toBeGreaterThanOrEqual` left `batch: 100_000` passing, and the
    // upper bound is the whole reason the batch is 50: a worker that claims everything and then
    // trips its failure ceiling strands the tail until expiry.
    const l = newLease();
    expect(l.ttlMs).toBe(120_000);
    expect(l.batch).toBe(50);
  });
});

describe('stopping the loop', () => {
  it('waits for a tick already in flight before returning', async () => {
    // The caller closes the store next. Returning while a tick is mid-`update` pulls the pool out
    // from under a live transaction and leaves the rows it leased claimed until they expire.
    const { store } = tracking();
    await store.create(record());
    let finished = false;
    const finder = async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      finished = true;
      return undefined;
    };

    const worker = startWorker(store, 5, observations(finder), MAX_AGE, () => undefined, () => NOW);
    await new Promise((resolve) => setTimeout(resolve, 15));
    await worker.stop();

    expect(finished).toBe(true);
  });

  it('gives up on a tick that outlasts the grace period rather than hanging the shutdown', async () => {
    // The thing being waited on is a call to a payment rail over the network. An unbounded wait
    // turns one hung upstream request into a shutdown that never finishes, and Kubernetes answers
    // a missed grace period with SIGKILL, which is the abrupt teardown the wait exists to avoid.
    const { store } = tracking();
    await store.create(record());
    const finder = () => new Promise<undefined>(() => undefined); // never settles

    const worker = startWorker(store, 5, observations(finder), MAX_AGE, () => undefined, () => NOW);
    await new Promise((resolve) => setTimeout(resolve, 15));

    const started = Date.now();
    await worker.stop(50);
    // Returned on the grace, not on the finder, which never settles at all.
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe('the tick, hardened', () => {
  it('re-observes a transaction_seen record instead of re-mapping a frozen status', async () => {
    // The absorbing-state bug. `provider_status` is written once, on discovery, so mapping that
    // same stored value every tick can only ever return the same answer: a transaction first seen
    // PENDING would stay `transaction_seen` for ever and never reach settled or failed.
    const { store } = tracking();
    await store.create(record({ status: 'transaction_seen', provider_transaction_id: 'tx-1', provider_status: 'PENDING' }));
    const finder = vi.fn(async () => txn('tx-1', 'SUCCEEDED'));
    const mapper: TransactionMapper = (status) => (status === 'SUCCEEDED' ? 'settled' : 'transaction_seen');

    const advanced = await tick(store, NOW, observations(finder, mapper), MAX_AGE, () => undefined, lease());

    expect(finder).toHaveBeenCalled();
    expect(advanced).toBe(1);
    expect((await store.byId('funding-1'))?.status).toBe('settled');
    await store.close();
  });

  it('keeps the last known status when a re-observation finds nothing', async () => {
    const { store } = tracking();
    await store.create(record({ status: 'transaction_seen', provider_transaction_id: 'tx-1', provider_status: 'PENDING' }));

    const advanced = await tick(store, NOW, observations(async () => undefined, INCONCLUSIVE), MAX_AGE, () => undefined, lease());

    expect(advanced).toBe(0);
    expect((await store.byId('funding-1'))?.provider_status).toBe('PENDING');
    await store.close();
  });

  it('does not count an advance the store did not write', async () => {
    // `update` answers `undefined` when the row is not there to write: deleted underneath the
    // scan, or never present. Counting it regardless inflates the only number the loop reports.
    const store = {
      claim: async () => [record()],
      release: async () => undefined,
      pruneRefusals: async () => 0,
      update: async () => undefined,
    };

    const advanced = await tick(store, NOW, observations(async () => txn()), MAX_AGE, () => undefined, lease());

    expect(advanced).toBe(0);
  });

  it('isolates a failing record so the ones behind it still advance', async () => {
    // Without per-record isolation the oldest bad record aborts the tick before anything behind
    // it is touched (on every tick, for ever, because the scan order is stable).
    //
    // The failing record is inside its observation window. Past the window a failing lookup is
    // deliberately quiet (see the test below), so a fixture that was already past its deadline
    // would assert the reporting half against a record that no longer reports.
    const { store } = tracking();
    await store.create(record({ id: 'funding-old', created_at: NOW - 10_000 }));
    await store.create(record({ id: 'funding-new', created_at: NOW - MAX_AGE - 5_000, expires_at: NOW - 1 }));
    const finder = vi.fn(async (r: FundingRecord) => {
      if (r.id === 'funding-old') throw new Error('rail down');
      return undefined;
    });
    const { lines, log } = notes();

    const advanced = await tick(store, NOW, observations(finder), MAX_AGE, log, lease());

    expect(advanced).toBe(1);
    expect((await store.byId('funding-old'))?.status).toBe('session_opened');
    expect((await store.byId('funding-new'))?.status).toBe('expired');
    expect(lines.join(' ')).toContain('funding-old');
    await store.close();
  });

  it.each([
    ['a reservation', 'created' as const],
    ['a seen transaction', 'transaction_seen' as const],
  ])('holds %s exactly on its deadline and concludes one millisecond later', async (_label, status) => {
    // The `session_opened` boundary was defended; these two were not, so each aged a row out one
    // millisecond early. Both outcomes are terminal and irreversible, which is why the edge is
    // worth pinning rather than approximating.
    const seed = () =>
      record({
        status,
        status_history: [{ status, at: NOW }],
        created_at: NOW,
        updated_at: NOW,
        ...(status === 'transaction_seen'
          ? { provider_transaction_id: 'tx-1', provider_status: 'PENDING' }
          : {}),
      });

    const held = tracking();
    await held.store.create(seed());
    await tick(held.store, NOW + MAX_AGE, observations(async () => undefined), MAX_AGE, () => undefined, lease());
    expect((await held.store.byId('funding-1'))?.status).toBe(status);
    await held.store.close();

    const past = tracking();
    await past.store.create(seed());
    await tick(past.store, NOW + MAX_AGE + 1, observations(async () => undefined), MAX_AGE, () => undefined, lease());
    expect((await past.store.byId('funding-1'))?.status).not.toBe(status);
    await past.store.close();
  });

  it('stops asking the rail when the fault is the rail, without stopping the scan', async () => {
    // A rejected query parameter or an unreachable rail fails for every record, and each failure
    // is a metered upstream call: one per in-flight row per tick, for ever.
    //
    // Bounded by stopping the calls, not by breaking out. Breaking out was a `LIMIT` on a stable
    // oldest-first scan positioned by whichever rows happen to fail, which is precisely the
    // starvation the scan is written to avoid: three stuck rows at the head would
    // hide everything behind them for as long as they took to age out.
    const { store } = tracking();
    for (let i = 0; i < 10; i += 1) {
      await store.create(record({ id: `funding-${String(i)}`, created_at: NOW - 10_000 - i }));
    }
    const finder = vi.fn(async () => {
      throw new Error('rail down');
    });
    const { lines, log } = notes();

    await tick(store, NOW, observations(finder), MAX_AGE, log, lease());

    // Three calls, and then no more this tick.
    expect(finder.mock.calls.length).toBe(3);
    expect(lines.join(' ')).toContain('stopped asking the rail');
    await store.close();
  });

  /**
   * Three rows that fail and stay in the scan, at the head of it.
   *
   * A failing row only throws while it is inside its observation window; past the deadline the
   * failure concludes as `unobserved` instead, which is not a failure the ceiling counts. And the
   * scan is oldest-first. So the rows that starve others must be old (to sort first) and inside
   * their window, which only a far-future rail expiry produces, the case `deadlineFor` documents
   * as unbounded from above. That combination is what makes this reachable at all.
   */
  const headOfScanFailures = async (store: ReturnType<typeof fakeStore>) => {
    for (let i = 0; i < 3; i += 1) {
      await store.create(
        record({
          id: `funding-bad-${String(i)}`,
          created_at: NOW - MAX_AGE - 20_000 + i,
          expires_at: NOW + MAX_AGE,
        }),
      );
    }
  };

  it.each([
    ['a rail that cannot be reached', true],
    ['a rail with no observation wired', false],
  ])('holds a row on its exact deadline and concludes it one millisecond later: %s', async (_label, wired) => {
    // The two `unobserved` deadlines this release added. Their three siblings got boundary tests
    // in the same commits; these did not, so each wrote a terminal, irreversible state one
    // millisecond early on a row that was still inside its window.
    const seed = () => record({ id: 'funding-edge', rail: wired ? 'meld' : 'chainflip', created_at: NOW });
    const finder = async () => {
      if (wired) throw new Error('rail down');
      return undefined;
    };

    const held = tracking();
    await held.store.create(seed());
    await tick(held.store, NOW + MAX_AGE, observations(finder), MAX_AGE, () => undefined, lease());
    expect((await held.store.byId('funding-edge'))?.status).toBe('session_opened');
    await held.store.close();

    const past = tracking();
    await past.store.create(seed());
    await tick(past.store, NOW + MAX_AGE + 1, observations(finder), MAX_AGE, () => undefined, lease());
    expect((await past.store.byId('funding-edge'))?.status).toBe('unobserved');
    await past.store.close();
  });

  it('trips the ceiling when the store is what is failing, not the rail', async () => {
    // The reset must not sit between `advanceOne` and `store.update`: a systemic store fault (a
    // read-only volume, a full disk, a lock held past its timeout) would oscillate the counter
    // 0 to 1 and never reach the ceiling, so every row would still spend its metered upstream
    // call under exactly the fault the ceiling exists to bound.
    const store = {
      claim: async () =>
        Array.from({ length: 8 }, (_unused, i) => record({ id: `funding-${String(i)}`, created_at: NOW - 10_000 + i })),
      release: async () => undefined,
      pruneRefusals: async () => 0,
      update: async () => {
        throw new Error('attempt to write a readonly database');
      },
    };
    const finder = vi.fn(async () => txn('tx-1'));

    await tick(store, NOW, observations(finder), MAX_AGE, () => undefined, lease());

    expect(finder.mock.calls.length).toBe(3);
  });

  it('does not treat a skipped row as evidence the rail recovered', async () => {
    // The counter must only be cleared by an answer. In skip mode `advanceOne` returns without
    // throwing, so a reset keyed on "did not throw" reads that as the rail being up, clearing the
    // count and resuming calls on the very next row, which is the bound gone.
    const { store } = tracking();
    await headOfScanFailures(store);
    for (let i = 0; i < 5; i += 1) {
      await store.create(record({ id: `funding-after-${String(i)}`, created_at: NOW - 5_000 + i }));
    }
    const finder = vi.fn(async () => {
      throw new Error('rail down');
    });

    await tick(store, NOW, observations(finder), MAX_AGE, () => undefined, lease());

    // Three calls total, not three per stretch of skipped rows.
    expect(finder.mock.calls.length).toBe(3);
    await store.close();
  });

  it('still ages out a row behind the ceiling, because that needs no upstream call', async () => {
    // The point of skipping calls rather than breaking out. A reservation past its deadline is
    // decided entirely locally, so a rail outage must not freeze it too; under the old `break` it
    // sat untouched behind the failing rows, holding its caller's idempotency key.
    const { store } = tracking();
    await headOfScanFailures(store);
    await store.create(
      record({
        id: 'funding-stale',
        status: 'created',
        status_history: [{ status: 'created', at: NOW - MAX_AGE - 5_000 }],
        created_at: NOW - MAX_AGE - 5_000,
        client_reference: 'idem-stale',
      }),
    );
    const finder = vi.fn(async () => {
      throw new Error('rail down');
    });

    await tick(store, NOW, observations(finder), MAX_AGE, () => undefined, lease());

    const aged = await store.byId('funding-stale');
    expect(aged?.status).toBe('unobserved');
    // The key is kept, not released: this row may already have an open settlement surface.
    expect(aged?.client_reference).toBe('idem-stale');
    // And the ceiling still held: three upstream calls, not four.
    expect(finder.mock.calls.length).toBe(3);
    await store.close();
  });

  it('never calls a skipped row expired, but does conclude it once its window has closed', async () => {
    // A skipped row says nothing about the buyer, so never `expired`. It cannot stay open for
    // ever either: past `deadlineFor` the window is closed whether or not this tick asked.
    //
    // Returning unconditionally here left every row behind three failures unasked and
    // unconcluded for a full `session_max_age_ms`: the starvation the ceiling exists to remove,
    // moved from the scan into the asking. This test asserted that as correct.
    const { store } = tracking();
    await headOfScanFailures(store);
    await store.create(record({ id: 'funding-past-deadline', created_at: NOW - MAX_AGE - 5_000 }));
    const finder = vi.fn(async () => {
      throw new Error('rail down');
    });

    await tick(store, NOW, observations(finder), MAX_AGE, () => undefined, lease());

    const concluded = await store.byId('funding-past-deadline');
    expect(concluded?.status).toBe('unobserved');
    expect(concluded?.status).not.toBe('expired');
    // Concluded without an upstream call: the ceiling still held at three.
    expect(finder.mock.calls.length).toBe(3);
    await store.close();
  });

  it('still holds a skipped row that is inside its window', async () => {
    // Inside the window, not asking is temporary: the row waits for the next tick rather than
    // turning a back-off into a conclusion.
    const { store } = tracking();
    await headOfScanFailures(store);
    await store.create(record({ id: 'funding-fresh-deferred', created_at: NOW - 1_000 }));
    const finder = vi.fn(async () => {
      throw new Error('rail down');
    });

    await tick(store, NOW, observations(finder), MAX_AGE, () => undefined, lease());

    expect((await store.byId('funding-fresh-deferred'))?.status).toBe('session_opened');
    await store.close();
  });

  it('resets the give-up count on a quiet record, not only on one that advances', async () => {
    // The shape the first version of this fix missed. "Nothing to do yet" is the usual answer
    // for a healthy unpaid request, and it takes the `continue` path, so counting only advances
    // meant a scan of bad / quiet / bad / quiet / bad tripped a ceiling named for consecutive
    // failures, and starved everything behind it while the rail was demonstrably answering.
    const { store } = tracking();
    for (const [id, age] of [
      ['funding-bad-1', 6_000],
      ['funding-quiet-1', 5_000],
      ['funding-bad-2', 4_000],
      ['funding-quiet-2', 3_000],
      ['funding-bad-3', 2_000],
      ['funding-last', 1_000],
    ] as const) {
      await store.create(record({ id, created_at: NOW - age }));
    }
    const finder = vi.fn(async (r: FundingRecord) => {
      if (r.id.startsWith('funding-bad')) throw new Error('rail down');
      return undefined;
    });

    await tick(store, NOW, observations(finder), MAX_AGE, () => undefined, lease());

    // All six reached: three failures separated by answers are not a systemic fault.
    expect(finder.mock.calls.length).toBe(6);
    await store.close();
  });

  it('ages out a row whose rail has no observation at all, instead of retrying it for ever', async () => {
    // Production wires only Meld. A `chainflip` row that outlived its compensating write (the
    // process killed between the reservation and the rail's refusal) must not throw at the
    // dispatch lookup before `advanceOne` runs. That never ages out: non-terminal for ever,
    // holding its caller's idempotency key and answering every retry with `409 REQUEST_IN_FLIGHT`.
    const { store } = tracking();
    await store.create(
      record({
        id: 'funding-orphan',
        rail: 'chainflip',
        status: 'created',
        status_history: [{ status: 'created', at: NOW - MAX_AGE - 10_000 }],
        created_at: NOW - MAX_AGE - 10_000,
        client_reference: 'idem-cf-1',
      }),
    );

    await tick(store, NOW, observations(async () => undefined), MAX_AGE, () => undefined, lease());

    const aged = await store.byId('funding-orphan');
    expect(aged?.status).toBe('unobserved');
    // And the key is released, so the buyer can start a new intent under it.
    // Kept: an unwired rail means the rail was never asked, and the reservation may still have
    // reached a rail that was wired when it was created.
    expect(aged?.client_reference).toBe('idem-cf-1');
    expect(await store.claim('assert', NOW, 1_000, 100)).toEqual([]);
    await store.close();
  });

  it('concludes an unwired rail\'s open session as unobserved once its window closes', async () => {
    // A rail nobody registered will not become askable later in this process, so the row must
    // still conclude, as `unobserved`: the rail was never asked.
    const { store } = tracking();
    await store.create(
      record({
        id: 'funding-unwired-open',
        rail: 'chainflip',
        created_at: NOW - MAX_AGE - 5_000,
      }),
    );

    await tick(store, NOW, observations(async () => undefined), MAX_AGE, () => undefined, lease());

    expect((await store.byId('funding-unwired-open'))?.status).toBe('unobserved');
    expect(await store.claim('assert', NOW, 1_000, 100)).toEqual([]);
    await store.close();
  });

  it('reports an unwired rail on a seen transaction too, and concludes it past the window', async () => {
    // The `transaction_seen` branch has the same two answers as `session_opened` and they were
    // reachable but untested: inside the window the missing observation is reported so an operator
    // sees it, and past the window the row concludes rather than being scanned for ever.
    const seen = (id: string, at: number) =>
      record({
        id,
        rail: 'chainflip',
        status: 'transaction_seen',
        status_history: [{ status: 'transaction_seen', at }],
        provider_transaction_id: 'tx-1',
        provider_status: 'PENDING',
        created_at: at,
        updated_at: at,
      });

    const inside = tracking();
    await inside.store.create(seen('funding-inside', NOW - 1_000));
    const notes1 = notes();
    await tick(inside.store, NOW, observations(async () => undefined), MAX_AGE, notes1.log, lease());
    expect((await inside.store.byId('funding-inside'))?.status).toBe('transaction_seen');
    expect(notes1.lines.join(' ')).toContain('chainflip');
    await inside.store.close();

    const past = tracking();
    await past.store.create(seen('funding-past', NOW - MAX_AGE - 1_000));
    await tick(past.store, NOW, observations(async () => undefined), MAX_AGE, () => undefined, lease());
    expect((await past.store.byId('funding-past'))?.status).toBe('unobserved');
    await past.store.close();
  });

  it('leaves a seen transaction alone when the tick has stopped asking', async () => {
    // The deferred branch on `transaction_seen`. Inside its window, with the ceiling tripped, the
    // row must simply wait: not conclude, and not cost an upstream call.
    const { store } = tracking();
    await headOfScanFailures(store);
    await store.create(
      record({
        id: 'funding-seen-deferred',
        status: 'transaction_seen',
        status_history: [{ status: 'transaction_seen', at: NOW - 1_000 }],
        provider_transaction_id: 'tx-1',
        provider_status: 'PENDING',
        created_at: NOW - 1_000,
        updated_at: NOW - 1_000,
      }),
    );
    const finder = vi.fn(async () => {
      throw new Error('rail down');
    });

    await tick(store, NOW, observations(finder), MAX_AGE, () => undefined, lease());

    expect((await store.byId('funding-seen-deferred'))?.status).toBe('transaction_seen');
    expect(finder.mock.calls.length).toBe(3);
    await store.close();
  });

  it('still reports an unwired rail while the row is inside its window', async () => {
    // The fault must not become silent just because it is now survivable.
    const { store } = tracking();
    await store.create(record({ id: 'funding-fresh', rail: 'chainflip', created_at: NOW - 1_000 }));
    const { lines, log } = notes();

    await tick(store, NOW, observations(async () => undefined), MAX_AGE, log, lease());

    expect((await store.byId('funding-fresh'))?.status).toBe('session_opened');
    expect(lines.join(' ')).toContain('chainflip');
    await store.close();
  });

  it('resets the give-up count when a record advances, so one bad row is stepped over', async () => {
    // The counter has to distinguish a systemic fault from a scattering of per-row ones, or the
    // bound becomes a new way for a single bad record to freeze the queue behind it.
    // Scanned oldest-first: bad, bad, good, bad, bad. Without the reset the count reaches the
    // ceiling on the fourth record and the fifth is never attempted; with it, the good record in
    // the middle clears the count and the whole scan completes.
    const { store } = tracking();
    for (const [id, age] of [
      ['funding-bad-1', 5_000],
      ['funding-bad-2', 4_000],
      ['funding-good', 3_000],
      ['funding-bad-3', 2_000],
      ['funding-bad-4', 1_000],
    ] as const) {
      await store.create(record({ id, created_at: NOW - age }));
    }
    const finder = vi.fn(async (r: FundingRecord) => {
      if (r.id.startsWith('funding-bad')) throw new Error('rail down');
      return txn('tx-good');
    });

    const advanced = await tick(store, NOW, observations(finder), MAX_AGE, () => undefined, lease());

    expect(finder.mock.calls.length).toBe(5);
    expect(advanced).toBe(1);
    expect((await store.byId('funding-good'))?.status).toBe('transaction_seen');
    await store.close();
  });

  it('never writes off a payer because the rail could not be asked', async () => {
    // A finder answering "nothing yet" is evidence the buyer did not pay. A finder that throws
    // is evidence about the lookup. Only the first may become `expired`.
    const { store } = tracking();
    await store.create(record({ id: 'funding-unreachable', created_at: NOW - MAX_AGE - 10_000 }));
    await store.create(record({ id: 'funding-unpaid', created_at: NOW - MAX_AGE - 10_000 }));
    const finder = vi.fn(async (r: FundingRecord) => {
      if (r.id === 'funding-unreachable') throw new Error('rail down');
      return undefined;
    });

    await tick(store, NOW, observations(finder), MAX_AGE, () => undefined, lease());

    expect((await store.byId('funding-unreachable'))?.status).toBe('unobserved');
    expect((await store.byId('funding-unpaid'))?.status).toBe('expired');
    // And both leave the scan, so neither costs another upstream call.
    expect(await store.claim('assert', NOW, 1_000, 100)).toEqual([]);
    await store.close();
  });

  it('keeps asking an unreachable rail while the window is still open', async () => {
    // `unobserved` is a conclusion, not a retry policy. Inside the window a transient rail failure
    // must stay transient: the error is reported and the next tick tries again.
    const { store } = tracking();
    await store.create(record({ id: 'funding-transient', created_at: NOW - 10_000 }));
    const finder = vi.fn(async () => {
      throw new Error('rail down');
    });
    const { lines, log } = notes();

    await tick(store, NOW, observations(finder), MAX_AGE, log, lease());

    expect((await store.byId('funding-transient'))?.status).toBe('session_opened');
    expect(lines.join(' ')).toContain('funding-transient');
    await store.close();
  });
});

describe('the loop, when the tick itself fails', () => {
  it('logs and keeps running rather than taking the process down', async () => {
    // Per-record isolation catches a failing record; this outer handler catches a failing
    // tick (`claim` failing, say, because the database is gone). That distinction is why both
    // exist, and this path stopped being covered when the inner one was added.
    //
    // A rejected promise now, not a synchronous throw. `startWorker` calls `void tick(..., lease())` and
    // attaches `.catch`, so the rejection is handled; without that attachment this is an
    // unhandled rejection and Node takes the process down on the exact fault the handler was
    // written to survive.
    const store = {
      claim: () => Promise.reject(new Error('database is not open')),
      release: async () => undefined,
      pruneRefusals: async () => 0,
      update: async () => undefined,
    };
    const log = vi.fn();

    const worker = startWorker(store, 10, observations(async () => undefined), MAX_AGE, log, () => NOW);
    await new Promise((resolve) => setTimeout(resolve, 40));
    await worker.stop(0);

    expect(log).toHaveBeenCalled();
    expect(String(log.mock.calls[0]?.[0])).toContain('database is not open');
  });
});

describe('a reservation that never became a session', () => {
  it('is never asked about at the rail: it has not reached one', async () => {
    // Widening the expiry branch to cover `created` also started asking the rail about rows whose
    // `createSession` may not have happened: a lookup, every tick, for a reference the rail has
    // never heard of, and a per-record error line whenever the rail is down for a request that is
    // mid-creation and perfectly healthy. Ageing a reservation out needs no observation.
    const { store } = tracking();
    await store.create(record({ status: 'created', status_history: [{ status: 'created', at: NOW }] }));
    const finder = vi.fn(async () => undefined);

    await tick(store, NOW, observations(finder), MAX_AGE, () => undefined, lease());

    expect(finder).not.toHaveBeenCalled();
    await store.close();
  });

  it('ages out as unobserved, never as expired, because nothing was ever asked', async () => {
    // `created` is written before the rail is called. If the process dies in between, nothing
    // else moves that row, and it is not terminal, so it would be re-scanned for the life of
    // the database. It must conclude.
    //
    // It must conclude honestly. Being written before the rail call is exactly why this row may
    // already have an open settlement surface, and `expired` is a claim that the buyer did not
    // pay, made here without asking anyone. `state.ts` refuses the transition outright now.
    const { store } = tracking();
    await store.create(record({ status: 'created', status_history: [{ status: 'created', at: NOW }], created_at: NOW - MAX_AGE - 1 }));

    const advanced = await tick(store, NOW, observations(async () => undefined), MAX_AGE, () => undefined, lease());

    expect(advanced).toBe(1);
    expect((await store.byId('funding-1'))?.status).toBe('unobserved');
    await store.close();
  });
});

describe('a reservation that never opened a session', () => {
  const reservation = (overrides: Partial<FundingRecord> = {}): FundingRecord =>
    record({
      status: 'created',
      status_history: [{ status: 'created', at: NOW }],
      provider_session_id: undefined,
      widget_url: undefined,
      client_reference: 'app-stable-key-1',
      ...overrides,
    });

  it('keeps the caller\'s idempotency key when it is aged out', async () => {
    // The key is kept, even though a key bound to a terminal row is bound for ever and the
    // contract requires it stable across a reload. Releasing it lets a retry find a dead row and
    // replay it: `201` with no session id and nowhere to pay.
    //
    // That reasoning was right about the symptom and wrong about the trade. This row is `created`,
    // which means the reservation was written and the rail may already have answered: the
    // orphan case where `createSession` succeeded and the write recording it failed. Freeing the
    // key lets the retry open a second settlement surface for one buyer intent. A caller who has
    // to start a new request is inconvenienced; a caller charged twice is not.
    //
    // The key is still held, so a retry meets `REQUEST_OUTCOME_UNKNOWN` rather than a replay of
    // a dead row: whether a session exists is unknown, so do not start another.
    const { store } = tracking();
    await store.create(reservation());

    const advanced = await tick(
      store,
      NOW + MAX_AGE + 1,
      observations(async () => undefined),
      MAX_AGE,
      () => undefined,
      lease(),
    );

    expect(advanced).toBe(1);
    const after = await store.byId('funding-1');
    expect(after?.status).toBe('unobserved');
    expect(after?.client_reference).toBe('app-stable-key-1');
    // And the key is still taken, so a fresh reservation under it loses rather than opening a
    // second surface.
    await expect(store.create(reservation({ id: 'funding-2' }))).rejects.toThrow();
    await store.close();
  });

  it('is never asked about upstream: there is nothing filed to observe', async () => {
    const { store } = tracking();
    await store.create(reservation());
    let asked = 0;

    await tick(
      store,
      NOW + MAX_AGE + 1,
      observations(async () => {
        asked += 1;
        return undefined;
      }),
      MAX_AGE,
      () => undefined,
      lease(),
    );

    expect(asked).toBe(0);
    await store.close();
  });

  it('keeps the key while the reservation is still inside its window', async () => {
    const { store, updated } = tracking();
    await store.create(reservation());

    await tick(store, NOW + 1, observations(async () => undefined), MAX_AGE, () => undefined, lease());

    expect(updated).not.toHaveBeenCalled();
    expect((await store.byId('funding-1'))?.client_reference).toBe('app-stable-key-1');
    await store.close();
  });
});

describe('a transaction seen but never concluded', () => {
  const seen = (): FundingRecord =>
    record({
      status: 'transaction_seen',
      status_history: [{ status: 'transaction_seen', at: NOW }],
      provider_transaction_id: 'tx-1',
      provider_status: 'PENDING',
    });

  it('stops asking the rail once the observation window has passed', async () => {
    // `mapStatus` answers `transaction_seen` for any status outside the handful it recognises, so
    // without this bound a transaction stuck on PENDING costs one upstream call per tick for ever.
    const { store } = tracking();
    await store.create(seen());
    let asked = 0;

    const advanced = await tick(
      store,
      NOW + MAX_AGE + 1,
      observations(async () => {
        asked += 1;
        return txn('tx-1', 'PENDING');
      }),
      MAX_AGE,
      () => undefined,
      lease(),
    );

    // Not asked, and concluded rather than left in the scan for ever.
    expect(asked).toBe(0);
    expect(advanced).toBe(1);
    expect((await store.byId('funding-1'))?.status).toBe('unobserved');
    await store.close();
  });

  it('concludes as unobserved rather than expired, because a payment was seen', async () => {
    // `expired` asserts the buyer did not pay, and it is terminal. `unobserved` says what is
    // true instead: the worker stopped looking, and the transaction it saw stays on the record.
    const { store } = tracking();
    await store.create(seen());

    await tick(store, NOW + MAX_AGE + 1, observations(async () => undefined), MAX_AGE, () => undefined, lease());

    const concluded = await store.byId('funding-1');
    expect(concluded?.status).toBe('unobserved');
    expect(concluded?.provider_transaction_id).toBe('tx-1');
    await store.close();
  });

  it('drops a concluded row out of the in-flight scan entirely', async () => {
    // The point of concluding it. A non-terminal row that can never advance is returned by
    // `listInFlight()` on every tick for the life of the database, and the set only grows.
    const { store } = tracking();
    await store.create(seen());

    await tick(store, NOW + MAX_AGE + 1, observations(async () => undefined), MAX_AGE, () => undefined, lease());

    expect(await store.claim('assert', NOW, 1_000, 100)).toEqual([]);
    await store.close();
  });

  it('measures its window from when the transaction was seen, not when the request was created', async () => {
    // A buyer who took most of a day over KYC and then paid would otherwise get only the remainder
    // of the request's life to conclude in (minutes, in the worst case) because the request and
    // the transaction would share one deadline.
    const { store } = tracking();
    await store.create(
      record({
        status: 'transaction_seen',
        status_history: [{ status: 'transaction_seen', at: NOW }],
        provider_transaction_id: 'tx-1',
        provider_status: 'PENDING',
        created_at: NOW - MAX_AGE + 60_000, // nearly a day old
        updated_at: NOW, // but only just observed
      }),
    );
    let asked = 0;

    // Past `created_at + MAX_AGE` (which fell at NOW + 60s), well inside `updated_at + MAX_AGE`.
    await tick(
      store,
      NOW + 120_000,
      observations(async () => {
        asked += 1;
        return txn('tx-1', 'PENDING');
      }),
      MAX_AGE,
      () => undefined,
      lease(),
    );

    expect(asked).toBe(1);
    await store.close();
  });

  it('still concludes a transaction that reaches a terminal status inside the window', async () => {
    const { store } = tracking();
    await store.create(seen());

    const advanced = await tick(
      store,
      NOW + 1,
      observations(async () => txn('tx-1', 'SETTLED'), (status) => (status === 'SETTLED' ? 'settled' : 'transaction_seen')),
      MAX_AGE,
      () => undefined,
      lease(),
    );

    expect(advanced).toBe(1);
    expect((await store.byId('funding-1'))?.status).toBe('settled');
    await store.close();
  });
});
