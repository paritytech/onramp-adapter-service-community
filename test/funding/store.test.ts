import { describe, expect, it, vi } from 'vitest';

import { fundingRecord } from '../fixtures.js';
import {
  createSchema,
  dropSchema,
  openIn,
  storePassword,
  terminateBackends,
  whileRowLocked,
  withStore,
  withThreeStores,
  withTwoStores,
} from '../pg.js';

import { sslOptions, type FundingStore } from '../../src/funding/store.js';
import type { FundingRecord } from '../../src/funding/types.js';

const record = (overrides: Partial<FundingRecord> = {}): FundingRecord => fundingRecord(overrides);

/** A claim wide enough to see everything a test inserted, for the assertions that only want order. */
const claimAll = (store: FundingStore) => store.claim('test-worker', 1_700_000_000_000, 60_000, 1_000);

describe('FundingStore', () => {
  it('round-trips a request with nullables intact', async () => {
    await withStore(async (store) => {
      await store.create(record());
      expect(await store.byId('funding-1')).toEqual(record());
    });
  });

  describe('cancel, against a real database rather than a fake', () => {
    // The cancel is one statement precisely so that no interleaving can slip between a read and a
    // write. That is a claim about Postgres, and the in-memory fake cannot test it: the fake is
    // single-threaded, so it agrees with whatever the implementation does. These use two real
    // connections.
    it('loses to a worker that saw the payment first, and leaves the surface alone', async () => {
      await withTwoStores(async (worker, caller) => {
        await worker.create(record({ status: 'session_opened' }));

        // The worker's transition commits first; the cancel then finds a `transaction_seen` row.
        await worker.update('funding-1', 'transaction_seen', 1_700_000_000_100, { providerTransactionId: 'tx-1' });
        const cancelled = await caller.cancel('alias-abc', 'app.dot', 'funding-1', 1_700_000_000_200);

        // No match, which the service turns into `REQUEST_NOT_CANCELLABLE`. The row this must
        // never withdraw is exactly the one a payment is already on its way for.
        expect(cancelled).toBeUndefined();
        expect((await worker.byId('funding-1'))?.cancelled_at).toBeUndefined();
      });
    });

    it('survives a worker transition that lands after it', async () => {
      await withTwoStores(async (worker, caller) => {
        await worker.create(record({ status: 'session_opened' }));

        // The other order. The buyer withdraws, and a payment sent moments earlier is observed
        // afterwards. Both facts have to survive: the cancel is not an instruction to stop
        // watching, and the payment does not un-cancel anything.
        const cancelled = await caller.cancel('alias-abc', 'app.dot', 'funding-1', 1_700_000_000_100);
        expect(cancelled?.cancelled_at).toBe(1_700_000_000_100);
        await worker.update('funding-1', 'transaction_seen', 1_700_000_000_200, { providerTransactionId: 'tx-late' });
        await worker.update('funding-1', 'settled', 1_700_000_000_300);

        const row = await worker.byId('funding-1');
        // The status write must not clear the column. `UPDATE_QUERY` does not name it, and this is
        // what proves that rather than assuming it.
        expect(row?.status).toBe('settled');
        expect(row?.cancelled_at).toBe(1_700_000_000_100);
      });
    });

    it('will not withdraw another caller\'s request, in the query rather than in a fake', async () => {
      // The authorization condition, and the only one of the four in that `WHERE` a fake can fool
      // you about: `fakeStore` re-implements the same predicate in TypeScript, so deleting
      // `subject_alias`/`product_id` from the real SQL left every test green. Whoever holds an id
      // could then withdraw the request behind it, taking away a stranger's settlement surface.
      await withStore(async (store) => {
        await store.create(record({ status: 'session_opened' }));

        expect(await store.cancel('alias-other', 'app.dot', 'funding-1', 1_700_000_000_100)).toBeUndefined();
        expect(await store.cancel('alias-abc', 'other.product', 'funding-1', 1_700_000_000_100)).toBeUndefined();
        expect((await store.byId('funding-1'))?.cancelled_at).toBeUndefined();

        // And the owner still can, so the guard is refusing the right callers rather than all of
        // them: a `WHERE` that matched nothing would pass the two assertions above.
        expect((await store.cancel('alias-abc', 'app.dot', 'funding-1', 1_700_000_000_200))?.cancelled_at).toBe(
          1_700_000_000_200,
        );
      });
    });

    it('lets exactly one of two concurrent cancels win, every time', async () => {
      // Repeated, because once is a coin toss. This is the assertion that holds the cancel to
      // being one statement, and a single round detects a regression to read-then-write only about
      // two runs in three. Measured, by rewriting `cancel` as a `SELECT` then an `UPDATE` and
      // running this file six times: caught four times. A guard that misses a third of the time on
      // the invariant the whole design rests on is not a guard.
      //
      // Twenty rounds takes it from a coin toss to a certainty, and costs milliseconds.
      await withTwoStores(async (a, b) => {
        for (let i = 0; i < 20; i += 1) {
          const id = `twice-${String(i)}`;
          await a.create(record({ id, status: 'session_opened' }));

          // Issued together, so the database arbitrates rather than the test. One sets the
          // timestamp; the other must find `cancelled_at IS NULL` already false and match
          // nothing. Otherwise a double tap moves when the buyer decided.
          const [first, second] = await Promise.all([
            a.cancel('alias-abc', 'app.dot', id, 1_700_000_000_100),
            b.cancel('alias-abc', 'app.dot', id, 1_700_000_000_900),
          ]);

          const winners = [first, second].filter((r) => r !== undefined);
          expect(winners, `round ${String(i)}`).toHaveLength(1);
          // And the stored timestamp is the winner's, never the later one overwriting it.
          expect((await a.byId(id))?.cancelled_at).toBe(winners[0]?.cancelled_at);
        }
      });
    });

    it('soaks cancel-vs-observation races, deadlock-free, and never loses the observation', async () => {
      // The sequential tests above script one ordering each. Real life is both statements in
      // flight at once, and the one-statement cancel's whole claim is that Postgres arbitrates the
      // interleaving: the loser blocks on the row lock, then re-evaluates its `WHERE` against the
      // just-committed version. What that promises under true concurrency is exactly two things,
      // and a soak over two independent connections is the way to hold it to both:
      //
      //  - no deadlock: a cancel and a transition issued together must both complete;
      //  - the observation is never lost: the worker's `update` to `transaction_seen` always
      //    returns a row, because withdrawing the surface is not an instruction to stop
      //    watching. A payment already on its way is still recorded.
      //
      // It does not try to pin which ordering won (the sequential tests do that
      // deterministically); it gives a deadlock or a lost write 25 chances to surface instead of
      // one.
      await withTwoStores(async (caller, worker) => {
        for (let i = 0; i < 25; i += 1) {
          const id = `race-${String(i)}`;
          const now = 1_700_000_000_000 + i * 10;
          await caller.create(record({ id, status: 'session_opened' }));

          const [cancelled, advanced] = await Promise.all([
            caller.cancel('alias-abc', 'app.dot', id, now),
            worker.update(id, 'transaction_seen', now, { providerTransactionId: `tx-${String(i)}` }),
          ]);

          // A deadlock would reject one of the two; a stale row lock (pool starvation) would let
          // `advanced` come back undefined. Both fail here, across every race.
          expect(advanced?.status).toBe('transaction_seen');

          const row = await caller.byId(id);
          expect(row?.status).toBe('transaction_seen');
          // Both interleavings must leave the row coherent: if the cancel lost the race the paid
          // row carries no trace of a withdrawal; if it won, its own timestamp is what the row
          // records, never nothing and never something else.
          if (cancelled === undefined) {
            expect(row?.cancelled_at).toBeUndefined();
          } else {
            expect(cancelled.cancelled_at).toBe(now);
            expect(row?.cancelled_at).toBe(now);
          }
        }
      });
    },
    // 30s, not the 5s default. This opens three connections and fires 25 rounds of concurrent
    // claims, and the full suite runs it alongside two other Postgres-backed files against one
    // server. It measures 130-290ms unloaded and has timed out at 5s under that contention, a
    // false failure that says nothing about the code. The bound does not weaken what the test
    // detects: a deadlock never resolves, so it fails at any bound; only a slow-but-correct run is
    // spared.
    30_000);
  });

  it('reads timestamps back as numbers, not strings', async () => {
    // `pg` returns `BIGINT` (OID 20) as a string by default, because 64 bits do not fit a JS
    // number in general. Ours are epoch milliseconds, and the string would flow into a field typed
    // `number` where `>` still compiles and compares lexicographically, so the worker's deadline
    // check would silently compare "1700000000000" against a number and answer nonsense. The
    // driver-level type parser is what stops that, and this is what notices if it is removed.
    await withStore(async (store) => {
      await store.create(record({ created_at: 1_700_000_000_000, updated_at: 1_700_000_000_000, expires_at: 1_800 }));
      const back = await store.byId('funding-1');
      expect(typeof back?.created_at).toBe('number');
      expect(typeof back?.updated_at).toBe('number');
      expect(typeof back?.expires_at).toBe('number');
      expect(back?.created_at).toBe(1_700_000_000_000);
    });
  });

  it('persists a nullable provider id as null then reads it back as undefined', async () => {
    await withStore(async (store) => {
      await store.create(
        record({ provider_session_id: undefined, provider_transaction_id: 'tx-1', provider_status: 'SUCCEEDED' }),
      );
      const read = await store.byId('funding-1');
      expect(read?.provider_session_id).toBeUndefined();
      expect(read?.provider_transaction_id).toBe('tx-1');
      expect(read?.provider_status).toBe('SUCCEEDED');
    });
  });

  it('is not idempotent: a same-id insert fails rather than overwriting history', async () => {
    await withStore(async (store) => {
      await store.create(record());
      // The only id source mints a fresh uuid, so a collision means a bug elsewhere; the primary
      // key surfaces it loudly rather than quietly replacing the earlier request's history.
      await expect(store.create(record())).rejects.toThrow();
    });
  });

  it('is scoped by alias and product: one caller cannot read another', async () => {
    await withStore(async (store) => {
      await store.create(record());
      expect(await store.byAlias('funding-1', 'alias-other', 'app.dot')).toBeUndefined();
      expect(await store.byAlias('funding-1', 'alias-abc', 'app.other')).toBeUndefined();
      expect(await store.byAlias('funding-1', 'alias-abc', 'app.dot')).toEqual(record());
    });
  });

  it('lists a caller newest first, bounded and scoped by product', async () => {
    await withStore(async (store) => {
      await store.create(record({ id: 'older', created_at: 1, updated_at: 1 }));
      await store.create(record({ id: 'newer', created_at: 2, updated_at: 2 }));
      await store.create(record({ id: 'other-product', product_id: 'app.other', created_at: 3, updated_at: 3 }));
      const listed = await store.list('alias-abc', 'app.dot');
      expect(listed.map((r) => r.id)).toEqual(['newer', 'older']);
      expect((await store.list('alias-abc', 'app.dot', 1)).map((r) => r.id)).toEqual(['newer']);
      // A different product under the same alias is not the caller's view of this product.
      expect((await store.list('alias-abc', 'app.other')).map((r) => r.id)).toEqual(['other-product']);
    });
  });

  it('orders rows sharing a timestamp deterministically, both ways round', async () => {
    // Two requests filed in the same millisecond are ordinary, not exotic: the caller list and
    // the worker scan both ordered on `created_at` alone, and a tie left the order to whatever
    // the engine happened to do. Postgres promises nothing for a tie and may answer differently
    // between an index scan and a sequential one. The ids below are inserted out of sort order on
    // purpose, so a missing tiebreaker returns insertion order and fails.
    await withStore(async (store) => {
      for (const id of ['b', 'a', 'c']) await store.create(record({ id, created_at: 1_000, updated_at: 1_000 }));

      // Newest first, so ties break on the id descending, the same direction as the sort.
      expect((await store.list('alias-abc', 'app.dot')).map((r) => r.id)).toEqual(['c', 'b', 'a']);
      // The worker claims oldest first, so its tie breaks the other way.
      expect((await claimAll(store)).map((r) => r.id)).toEqual(['a', 'b', 'c']);
    });
  });

  it('caps a list at a hundred rows when the caller names no bound', async () => {
    // The bound is what stops one account paging an unbounded body out of the service, and the
    // route calls `list` with no limit at all: the default is the ceiling in production.
    // Only an explicit `1` was ever asserted, which holds whatever the default happens to be.
    await withStore(async (store) => {
      for (let i = 0; i < 101; i += 1) {
        await store.create(record({ id: `funding-${String(i)}`, created_at: 1_000 + i, updated_at: 1_000 + i }));
      }

      const listed = await store.list('alias-abc', 'app.dot');
      expect(listed).toHaveLength(100);
      // Newest first, so the row that falls off the end is the oldest one.
      expect(listed[0]?.id).toBe('funding-100');
      expect(listed.map((r) => r.id)).not.toContain('funding-0');
    });
  });

  it('keeps a live request visible behind a wall of refusals', async () => {
    // The reason refusals are excluded. Minimum amounts are per (destination, currency) and there
    // is no discovery route, so a caller learns a minimum by being refused; refusals are
    // ordinary traffic. At a hundred rows newest-first they would push the one request the buyer
    // is actually waiting on out of their own history.
    await withStore(async (store) => {
      await store.create(record({ id: 'the-live-one', status: 'session_opened', created_at: 1_000 }));
      for (let i = 0; i < 150; i += 1) {
        await store.create(
          record({ id: `refused-${String(i)}`, status: 'refused', client_reference: undefined, created_at: 2_000 + i }),
        );
      }

      const listed = await store.list('alias-abc', 'app.dot');
      expect(listed.map((r) => r.id)).toEqual(['the-live-one']);
    });
  });

  it('shows refusals when they are asked for, newest first and still bounded', async () => {
    // They are kept, not dropped: they are the durable record behind the `session.refused` audit
    // line, and an operator answering "why did this caller get nothing" needs them.
    await withStore(async (store) => {
      await store.create(record({ id: 'live', status: 'session_opened', created_at: 1_000 }));
      for (let i = 0; i < 150; i += 1) {
        await store.create(
          record({ id: `r-${String(i)}`, status: 'refused', client_reference: undefined, created_at: 2_000 + i }),
        );
      }

      const listed = await store.list('alias-abc', 'app.dot', 100, true);
      expect(listed).toHaveLength(100);
      expect(listed[0]?.id).toBe('r-149');
    });
  });

  it('claims in-flight requests and leaves terminal ones out', async () => {
    await withStore(async (store) => {
      await store.create(record({ id: 'in-flight', status: 'session_opened' }));
      await store.create(record({ id: 'done', status: 'settled' }));
      expect((await claimAll(store)).map((r) => r.id)).toEqual(['in-flight']);
    });
  });

  it('claims in-flight requests oldest first', async () => {
    // The worker isolates a failing record per tick so the rest still advance, and that argument
    // only holds because the scan order is stable and oldest-first. Newest-first would let a
    // steady arrival rate keep the oldest stuck request at the back of every tick.
    await withStore(async (store) => {
      await store.create(fundingRecord({ id: 'middle', created_at: 2_000 }));
      await store.create(fundingRecord({ id: 'oldest', created_at: 1_000 }));
      await store.create(fundingRecord({ id: 'newest', created_at: 3_000 }));

      expect((await claimAll(store)).map((r) => r.id)).toEqual(['oldest', 'middle', 'newest']);
    });
  });

  describe('pruning refusals', () => {
    it('deletes refusals past the cutoff and leaves everything else alone', async () => {
      // Only `refused`. Every other terminal state is a record of something that reached a payment
      // rail, and a buyer's purchase history is not this service's to expire.
      await withStore(async (store) => {
        await store.create(record({ id: 'old-refusal', status: 'refused', client_reference: undefined, created_at: 1_000 }));
        await store.create(record({ id: 'new-refusal', status: 'refused', client_reference: undefined, created_at: 9_000 }));
        await store.create(record({ id: 'old-settled', status: 'settled', created_at: 1_000 }));
        await store.create(record({ id: 'old-expired', status: 'expired', created_at: 1_000 }));
        await store.create(record({ id: 'old-unobserved', status: 'unobserved', created_at: 1_000 }));

        expect(await store.pruneRefusals(5_000)).toBe(1);

        expect(await store.byId('old-refusal')).toBeUndefined();
        // Inside the window, and every non-refusal regardless of age.
        expect(await store.byId('new-refusal')).toBeDefined();
        expect(await store.byId('old-settled')).toBeDefined();
        expect(await store.byId('old-expired')).toBeDefined();
        expect(await store.byId('old-unobserved')).toBeDefined();
      });
    });

    it('keeps deleting until the backlog is gone, a batch at a time', async () => {
      // A single unbounded DELETE over ninety days of refusals holds row locks and grows WAL for as
      // long as it runs, on the same pool the request path uses. Batching bounds each statement,
      // but only if the sweep loops, and a sweep that ran once would pass every other test here
      // while leaving the backlog to grow for ever, one batch smaller per hour.
      await withStore(async (store) => {
        for (let i = 0; i < 5; i += 1) {
          await store.create(
            record({ id: `refusal-${String(i)}`, status: 'refused', client_reference: undefined, created_at: 1_000 }),
          );
        }

        // Five rows, two per statement: three statements, the last one short.
        expect(await store.pruneRefusals(5_000, 2)).toBe(5);
        expect(await store.byId('refusal-0')).toBeUndefined();
        expect(await store.byId('refusal-4')).toBeUndefined();
      });
    });

    it('reports nothing deleted when there is nothing past the cutoff', async () => {
      await withStore(async (store) => {
        await store.create(record({ id: 'recent', status: 'refused', client_reference: undefined, created_at: 9_000 }));
        expect(await store.pruneRefusals(1_000)).toBe(0);
      });
    });
  });

  describe('reserve', () => {
    it('takes a free idempotency key', async () => {
      await withStore(async (store) => {
        expect(await store.reserve(record({ client_reference: 'key-1' }))).toEqual({ outcome: 'inserted' });
      });
    });

    it('reports the holder instead of throwing when the key is taken', async () => {
      // The previous shape wrapped the insert in a bare `catch {}` and re-read. That could not
      // tell a duplicate key from a dead connection, and on Postgres a failed insert poisons its
      // transaction, so the re-read could fail too and a genuine store fault reached the caller
      // as "reservation failed for an unknown reason".
      await withStore(async (store) => {
        await store.reserve(record({ id: 'first', client_reference: 'key-1' }));
        const second = await store.reserve(record({ id: 'second', client_reference: 'key-1' }));
        expect(second.outcome).toBe('existing');
        expect(second.outcome === 'existing' && second.record.id).toBe('first');
      });
    });

    it('lets exactly one of two concurrent reservations win the same key', async () => {
      // The whole point of arbitrating in the database. Two replicas, two pools, one key: a
      // check-then-act would let both through and open two settlement surfaces for one buyer
      // intent. Separate stores, because a single pool serializes nothing that matters here.
      await withTwoStores(async (a, b) => {
        const [first, second] = await Promise.all([
          a.reserve(record({ id: 'from-a', client_reference: 'shared' })),
          b.reserve(record({ id: 'from-b', client_reference: 'shared' })),
        ]);
        const outcomes = [first.outcome, second.outcome].sort();
        expect(outcomes).toEqual(['existing', 'inserted']);
        expect(await a.list('alias-abc', 'app.dot')).toHaveLength(1);
      });
    });

    it('does not collide two refused rows, which claim no key at all', async () => {
      // The unique index is partial (`WHERE client_reference IS NOT NULL`), precisely so a
      // caller who mistypes an address twice is not blocked by their own earlier refusal.
      await withStore(async (store) => {
        await store.create(record({ id: 'refused-1', status: 'refused', client_reference: undefined }));
        await store.create(record({ id: 'refused-2', status: 'refused', client_reference: undefined }));
        // Asking for them explicitly: refusals are excluded from the default list, and this test
        // is about the index permitting both rows to exist, not about who sees them.
        expect(await store.list('alias-abc', 'app.dot', 100, true)).toHaveLength(2);
      });
    });

    it('takes the key when the conflicting holder released it mid-flight', async () => {
      // Not hypothetical. `Onramp` releases a caller's reference whenever the rail refuses to open
      // a session, so between the conflicting insert and the read-back the winning row can
      // legitimately stop holding the key:
      //
      //   A reserves key-1 , B conflicts , A's rail call fails and A releases key-1 ,
      //   B reads back and finds nothing.
      //
      // The key really is free at that point, and the previous behaviour answered a plain 500. One
      // retry takes it.
      await withStore(async (store) => {
        await store.reserve(record({ id: 'holder', status: 'created', client_reference: 'key-1' }));
        // Stand in for the release landing between the two statements.
        vi.spyOn(store, 'byReference').mockImplementationOnce(async () => {
          await store.update('holder', 'refused', 2, { releaseReference: true });
          return undefined;
        });

        expect(await store.reserve(record({ id: 'later', client_reference: 'key-1' }))).toEqual({
          outcome: 'inserted',
        });
        expect((await store.byId('later'))?.client_reference).toBe('key-1');
      });
    });

    it('reports the holder when the retry conflicts and the second read finds it', async () => {
      // The middle outcome. The first read-back missed (a released key, or simply a read that
      // did not see the row), so the insert is retried; the key is still held, so it conflicts
      // again; and this time the holder is there. That is an ordinary idempotent replay and must
      // answer as one, not as the "conflicted twice" fault.
      await withStore(async (store) => {
        await store.reserve(record({ id: 'holder', client_reference: 'key-1' }));
        const real = store.byReference.bind(store);
        vi.spyOn(store, 'byReference').mockImplementationOnce(async () => undefined).mockImplementation(real);

        const outcome = await store.reserve(record({ id: 'later', client_reference: 'key-1' }));

        expect(outcome.outcome).toBe('existing');
        expect(outcome.outcome === 'existing' && outcome.record.id).toBe('holder');
      });
    });

    it('refuses rather than guessing when the conflict persists with no holder', async () => {
      // Not hypothetical. `Onramp` releases a caller's reference when the rail refuses to open a
      // session (`client_reference` goes NULL), so between this reserve's conflict and its
      // read-back, the row it conflicted with can legitimately stop holding the key:
      //
      //   A reserves key-1 , B conflicts on key-1 , A's rail call fails and A releases key-1 ,
      //   B reads back and finds nothing.
      //
      // There is no safe answer to invent here. Returning `inserted` would be a lie (nothing was
      // written) and returning `existing` needs a record there is none of, so it throws and the
      // caller retries into a now-free key. The read is stubbed because the window is between two
      // statements of one method and cannot be hit from outside.
      await withStore(async (store) => {
        await store.reserve(record({ id: 'holder', client_reference: 'key-1' }));
        // Both read-backs find nothing while the insert keeps conflicting: a key being taken
        // and released faster than a round trip, which is not a caller owed a reservation.
        vi.spyOn(store, 'byReference').mockResolvedValue(undefined);

        await expect(store.reserve(record({ id: 'later', client_reference: 'key-1' }))).rejects.toThrow(
          /conflicted twice with no holder/,
        );
      });
    });

    it('refuses a reservation with no reference rather than defaulting one', async () => {
      // The partial unique index only applies `WHERE client_reference IS NOT NULL`, so a record
      // without one cannot be reserved: there is nothing for the conflict to be against. The
      // `?? ''` this replaces was unreachable from `Onramp`, but had the invariant ever broken it
      // would have looked up a different row under the empty key and reported someone else's
      // reservation as this caller's. Loud is the cheaper wrong answer.
      await withStore(async (store) => {
        await expect(store.reserve(record({ id: 'keyless', client_reference: undefined }))).rejects.toThrow(
          /requires a client_reference/,
        );
      });
    });

    it('still throws on a primary-key collision, which is a different fault', async () => {
      // `ON CONFLICT` names the reference index by its own predicate, so it absorbs a duplicate
      // idempotency key and nothing else. Ids come from `newId()` and are never reused, so a
      // same-id insert is a bug worth hearing about rather than a replay to serve.
      await withStore(async (store) => {
        await store.reserve(record({ id: 'dup', client_reference: 'key-1' }));
        // Matched, not bare. `rejects.toThrow()` with no pattern accepted any rejection, so
        // replacing the partial-index predicate with a plain `ON CONFLICT DO NOTHING` survived:
        // Postgres then absorbed the primary-key conflict too and `reserve` threw a different
        // error from a different branch ("conflicted twice with no holder"), which the bare
        // matcher happily accepted. The comment about the predicate drifting from `freshSchema()`
        // was enforcing nothing.
        await expect(store.reserve(record({ id: 'dup', client_reference: 'key-2' }))).rejects.toThrow(
          /duplicate key/i,
        );
        // And the original row is untouched: the collision did not overwrite it.
        expect((await store.byReference('alias-abc', 'app.dot', 'key-1'))?.id).toBe('dup');
      });
    });
  });

  describe('leases', () => {
    it('gives a claimed row to one worker only', async () => {
      await withTwoStores(async (a, b) => {
        await a.create(record({ id: 'contested', status: 'session_opened' }));
        const first = await a.claim('worker-a', 1_000, 60_000, 10);
        const second = await b.claim('worker-b', 1_000, 60_000, 10);
        expect(first.map((r) => r.id)).toEqual(['contested']);
        // Still leased to A, so B sees nothing rather than working the same row in parallel.
        expect(second).toEqual([]);
      });
    });

    it('offers the row again once the lease has expired', async () => {
      // Expiry is crash recovery: a worker that died mid-tick never released its claim, and the
      // row must not be stranded for ever. `now` past `claimed_until` is what makes it claimable.
      await withTwoStores(async (a, b) => {
        await a.create(record({ id: 'stranded', status: 'session_opened' }));
        await a.claim('worker-a', 1_000, 5_000, 10);
        expect(await b.claim('worker-b', 6_001, 60_000, 10)).toHaveLength(1);
      });
    });

    it('lets the unleased request path write a row a worker currently holds', async () => {
      // `Onramp` is not leased: it passes no `claimedBy` and matches on the id alone, because the
      // request path is the only writer of the row it just reserved. The guard is written
      // `($13::text IS NULL OR claimed_by = $13)` for exactly that reason.
      //
      // Rewriting it as `(claimed_by IS NULL OR claimed_by = $13)`, the natural-looking form,
      // survived all 861 tests, because every `update` test used rows that were never claimed and
      // every lease test passed an explicit worker. In production that turns the settlement-URL
      // write into a silent zero-row no-op whenever the worker's tick happens to hold the row, and
      // the buyer gets a 201 with nowhere to pay.
      await withTwoStores(async (a, b) => {
        await a.create(record({ id: 'held', status: 'created' }));
        await a.claim('worker-a', 1_000, 60_000, 10);

        // The request path, mid-tick, with no lease of its own.
        const written = await b.update('held', 'session_opened', 2_000, {
          providerSessionId: 'meld-1',
          widgetUrl: 'https://meldcrypto.com/session/meld-1',
        });

        expect(written?.status).toBe('session_opened');
        expect(written?.widget_url).toBe('https://meldcrypto.com/session/meld-1');
      });
    });

    it('serializes two overlapping updates to one row rather than racing them', async () => {
      // The read-modify-write is one transaction and the read takes `FOR UPDATE`, so a second
      // update waits and then reads what actually happened. Deleting the row lock survived the
      // suite: every other test here issues its store operations strictly sequentially, so no two
      // ever overlapped. Without it both transactions read the same snapshot, both compute a
      // transition from the same previous state, and the second overwrites the first; one
      // advance is lost from the timeline while its caller was told it succeeded.
      //
      // The invariant is counted rather than branched on: every write that reports success must
      // have left an entry behind. A test that asserted "2 or 3 entries depending on the outcome"
      // would be satisfied by the lost write it exists to catch.
      await withTwoStores(async (a, b) => {
        await a.create(record({ id: 'contended', status: 'created' }));

        const results = await Promise.all([
          a.update('contended', 'session_opened', 2_000, { providerSessionId: 'meld-1' }).catch(() => undefined),
          b.update('contended', 'unobserved', 2_001).catch(() => undefined),
        ]);

        const succeeded = results.filter((r) => r !== undefined).length;
        const final = await a.byId('contended');
        // One entry for `created`, plus one per write that reported success.
        expect(final?.status_history).toHaveLength(1 + succeeded);
      });
    });

    it('refuses an advance made under a lease that has moved on', async () => {
      // The guard that makes the lease mean something. Without the claim in the `WHERE`, a worker
      // whose lease expired mid-Meld-call would still write, and two workers would both advance
      // one request: the double-write a single writer makes impossible.
      await withTwoStores(async (a, b) => {
        await a.create(record({ id: 'taken', status: 'session_opened' }));
        await a.claim('worker-a', 1_000, 5_000, 10);
        await b.claim('worker-b', 6_001, 60_000, 10);

        const stale = await a.update('taken', 'transaction_seen', 7_000, { claimedBy: 'worker-a' });
        expect(stale).toBeUndefined();
        // And the row really is untouched, not merely unreported.
        expect((await a.byId('taken'))?.status).toBe('session_opened');
      });
    });

    it('hands a released row straight back rather than waiting out the lease', async () => {
      await withTwoStores(async (a, b) => {
        await a.create(record({ id: 'passed-on', status: 'session_opened' }));
        await a.claim('worker-a', 1_000, 600_000, 10);
        await a.release('worker-a', ['passed-on']);
        expect(await b.claim('worker-b', 1_100, 60_000, 10)).toHaveLength(1);
      });
    });

    it('will not let one worker release a claim belonging to another', async () => {
      await withTwoStores(async (a, b) => {
        await a.create(record({ id: 'not-yours', status: 'session_opened' }));
        await a.claim('worker-a', 1_000, 600_000, 10);
        await b.release('worker-b', ['not-yours']);
        // Still A's: a stale release must not free a row someone else is actively working.
        expect(await b.claim('worker-b', 1_100, 60_000, 10)).toEqual([]);
      });
    });

    it('costs nothing when there is nothing to release', async () => {
      // The common case, not an edge one: an idle tick claims no rows and then releases the empty
      // list, every `interval_ms`, for ever. `id = ANY('{}')` is valid SQL that matches nothing,
      // so without the early return each idle tick spends a pooled round trip to update no rows.
      await withStore(async (store) => {
        await expect(store.release('worker-a', [])).resolves.toBeUndefined();
      });
    });

    it('bounds a claim to the batch size it was asked for', async () => {
      // A worker that claims everything and then trips its failure ceiling strands the tail until
      // expiry, which is the starvation the ceiling exists to prevent wearing a new hat.
      await withStore(async (store) => {
        for (let i = 0; i < 10; i += 1) {
          await store.create(record({ id: `r-${String(i)}`, status: 'session_opened', created_at: 1_000 + i }));
        }
        expect(await store.claim('worker-a', 2_000, 60_000, 3)).toHaveLength(3);
      });
    });

    it('returns the oldest rows first when the batch falls short', async () => {
      // `claim` sources the candidates ordered by `created_at ASC, id ASC` and the outer select
      // repeats the ORDER BY because `RETURNING` promises no order, so the caller-facing sequence
      // is every bit as load-bearing as the drain order. A pathological scan that claimed the
      // newest three would leave the oldest stuck behind the batch limit at the back of every
      // tick.
      await withStore(async (store) => {
        for (let i = 0; i < 5; i += 1) {
          await store.create(record({ id: `r-${String(i)}`, status: 'session_opened', created_at: 1_000 + i }));
        }
        await expect(store.claim('worker-a', 2_000, 60_000, 3)).resolves.toMatchObject([
          { id: 'r-0' },
          { id: 'r-1' },
          { id: 'r-2' },
        ]);
      });
    });

    it('walks past a row another transaction holds, instead of waiting for it', async () => {
      // The only test here that can tell `SKIP LOCKED` from plain `FOR UPDATE`.
      //
      // Concurrent claims cannot: without `SKIP LOCKED` the losers block on the winner, wait their
      // turn, and come away with the same partition of rows, so every assertion about which rows
      // went where holds either way. Deleting `SKIP LOCKED` from the query leaves the rest of this
      // suite green; measured, not assumed.
      //
      // What the primitive actually buys is that a claimant meeting a locked row does not wait for
      // it. So hold a lock on the oldest row and claim against it: skipping returns the other
      // rows promptly; blocking returns nothing until the holder commits.
      const schema = await createSchema();
      const store = await openIn(schema);
      try {
        await store.create(record({ id: 'locked', status: 'session_opened', created_at: 1_000 }));
        await store.create(record({ id: 'free-a', status: 'session_opened', created_at: 2_000 }));
        await store.create(record({ id: 'free-b', status: 'session_opened', created_at: 3_000 }));

        const claimed = await whileRowLocked(schema, 'locked', async () => {
          // 10s, deliberately generous. This asserts promptness, so the bound only has to
          // separate "skipped past the lock" from "waiting on the holder"; the holder never
          // lets go while this runs, so a blocking claim waits for ever and fails at any bound.
          // Too tight is the real risk: under the full suite's Postgres contention a correct claim
          // can take seconds, and a 3s bound would report `blocked` for a run that skipped fine.
          const raced = await Promise.race([
            store.claim('worker-a', 2_000, 60_000, 10),
            new Promise<'blocked'>((resolve) => setTimeout(() => { resolve('blocked'); }, 10_000)),
          ]);
          return raced;
        });

        expect(claimed, 'the claim blocked on the held lock instead of skipping it').not.toBe('blocked');
        // And it skipped precisely the locked row: not everything, and not nothing.
        expect((claimed as FundingRecord[]).map((r) => r.id)).toEqual(['free-a', 'free-b']);
      } finally {
        await store.close();
        await dropSchema(schema);
      }
    },
    // Must exceed the 10s race above. On the default 5s a genuine block reports "timed out"
    // instead of the sentence that explains it; verified by removing `SKIP LOCKED`, which failed
    // at 5005ms on the least useful diagnostic there is.
    20_000);

    it('partitions a bound batch across concurrent claims without losing or double-admitting a row', async () => {
      // Five live rows, three concurrent claims bound at three: every row is admitted by exactly
      // one claimant, none lost behind the bound, and each claimant's own slice is oldest-first.
      //
      // This does not test `SKIP LOCKED`, despite the concurrency. Blocking produces the same
      // partition as skipping (the losers simply wait their turn), so every assertion here holds
      // with the primitive removed. The test above is the one that can tell them apart. What this
      // covers is the batch boundary: that a bound claim under load neither drops the tail nor
      // hands the same row to two workers.
      await withThreeStores(async (a, b, c) => {
        await a.create(record({ id: 'r-0', status: 'session_opened', created_at: 1_000 }));
        await a.create(record({ id: 'r-1', status: 'session_opened', created_at: 2_000 }));
        await a.create(record({ id: 'r-2', status: 'session_opened', created_at: 3_000 }));
        await a.create(record({ id: 'r-3', status: 'session_opened', created_at: 4_000 }));
        await a.create(record({ id: 'r-4', status: 'session_opened', created_at: 5_000 }));

        const [first, second, third] = await Promise.all([
          a.claim('worker-a', 2_000, 60_000, 3),
          b.claim('worker-b', 2_000, 60_000, 3),
          c.claim('worker-c', 2_000, 60_000, 3),
        ]);

        const everywhere = [...first, ...second, ...third];
        expect(everywhere.map((r) => r.id).sort()).toEqual(['r-0', 'r-1', 'r-2', 'r-3', 'r-4']);
        for (const got of [first, second, third]) {
          const ids = got.map((r) => r.id);
          expect(ids).toEqual([...ids].sort());
        }
      });
    });

    it('gives a contested row to exactly one of three concurrent claims', async () => {
      // The `FOR UPDATE SKIP LOCKED` lease is gone from this suite: every other claim test awaits
      // one claim before the next, so the row lock is always free when the second claim runs, and
      // dropping the clause would sail through green. The property is only observable under
      // contention (the loser must come back empty rather than block or deadlock), so all three
      // claims are issued before any resolves, and the third independent connection proves the
      // loser is skipped, not queued behind a lock that the second claim hands it.
      await withThreeStores(async (a, b, c) => {
        await a.create(record({ id: 'contested', status: 'session_opened' }));
        const [one, two, three] = await Promise.all([
          a.claim('worker-a', 2_000, 60_000, 10),
          b.claim('worker-b', 2_000, 60_000, 10),
          c.claim('worker-c', 2_000, 60_000, 10),
        ]);
        const everywhere = [...one, ...two, ...three];
        expect(everywhere.map((r) => r.id).filter((id) => id === 'contested')).toHaveLength(1);
        expect(everywhere).toHaveLength(1);
      });
    });
  });

  describe('update', () => {
    it('advances a request and appends the timeline entry', async () => {
      await withStore(async (store) => {
        await store.create(
          record({ status: 'created', status_history: [{ status: 'created', at: 1_700_000_000_000 }] }),
        );
        const updated = await store.update('funding-1', 'session_opened', 1_700_000_000_100);
        expect(updated?.status).toBe('session_opened');
        expect(updated?.created_at).toBe(1_700_000_000_000);
        expect(updated?.updated_at).toBe(1_700_000_000_100);
        expect(updated?.status_history).toEqual([
          { status: 'created', at: 1_700_000_000_000 },
          { status: 'session_opened', at: 1_700_000_000_100 },
        ]);
      });
    });

    it('attaches a provider transaction id the moment it is seen', async () => {
      await withStore(async (store) => {
        await store.create(record({ status: 'session_opened', provider_session_id: 'meld-1' }));
        const updated = await store.update('funding-1', 'transaction_seen', 1_700_000_000_200, {
          providerTransactionId: 'tx-1',
          providerStatus: 'PENDING',
        });
        expect(updated?.provider_transaction_id).toBe('tx-1');
        expect(updated?.provider_status).toBe('PENDING');
        // The persisted row agrees: read it back fresh, not from the return value.
        expect((await store.byId('funding-1'))?.provider_transaction_id).toBe('tx-1');
      });
    });

    it('preserves a moved request with its provider session intact', async () => {
      await withStore(async (store) => {
        await store.create(record({ status: 'session_opened', provider_session_id: 'meld-1' }));
        // Advancing the machine must not drop the provider session already attached to the row.
        const updated = await store.update('funding-1', 'transaction_seen', 1_700_000_000_200, {
          providerTransactionId: 'tx-1',
          providerStatus: 'PENDING',
        });
        expect(updated?.provider_session_id).toBe('meld-1');
      });
    });

    it('clears the provider status when the rail explicitly reports none', async () => {
      // `providerStatus` is typed `string | null`, and the two are different facts: `undefined`
      // is "this update says nothing about the status"; `null` is "the rail reported no status".
      // The old `??` collapsed them, so a transaction that stopped reporting a status went on
      // being mapped against one it no longer had: a settled/failed decision made from a stale
      // string.
      await withStore(async (store) => {
        await store.create(record({ status: 'session_opened' }));
        await store.update('funding-1', 'transaction_seen', 1_700_000_000_100, { providerStatus: 'PENDING' });
        expect((await store.byId('funding-1'))?.provider_status).toBe('PENDING');

        const cleared = await store.update('funding-1', 'settled', 1_700_000_000_200, { providerStatus: null });

        expect(cleared?.provider_status).toBeUndefined();
        // The persisted row agrees, not merely the returned copy: the bind list and the merged
        // record are built from one value precisely so they cannot disagree.
        expect((await store.byId('funding-1'))?.provider_status).toBeUndefined();
      });
    });

    it('keeps the provider status when an update says nothing about it', async () => {
      // The other half of the same distinction. An update that only attaches a transaction id
      // must not silently erase the status the rail last reported.
      await withStore(async (store) => {
        await store.create(record({ status: 'session_opened' }));
        await store.update('funding-1', 'transaction_seen', 1_700_000_000_100, { providerStatus: 'PENDING' });

        const advanced = await store.update('funding-1', 'settled', 1_700_000_000_200, {
          providerTransactionId: 'tx-1',
        });

        expect(advanced?.provider_status).toBe('PENDING');
        expect((await store.byId('funding-1'))?.provider_status).toBe('PENDING');
      });
    });

    it('persists every mutable column, not only the ones the caller reads back', async () => {
      // `update` returns a merged JavaScript object and the tests around it assert that object,
      // so the bind list and the merge could disagree and nothing would notice. Only
      // `provider_transaction_id` and `provider_status` were ever read back; binding `null` for the
      // settlement surface and its expiry left the whole suite green.
      //
      // In production `Onramp.createSession` writes the buyer's pay-at URL and its expiry through
      // exactly this call. Losing them means a replay fails the `replay()` invariant and 500s on
      // every retry, and `deadlineFor` loses the rail's own deadline.
      await withStore(async (store) => {
        await store.create(record({ status: 'created', client_reference: 'key-1' }));
        await store.update('funding-1', 'session_opened', 1_700_000_000_100, {
          providerSessionId: 'meld-9',
          widgetUrl: 'https://meldcrypto.com/session/meld-9',
          hostedWidgetUrl: 'https://hosted.example/meld-9',
          expiresAt: 1_800_000_000_000,
        });

        // Read back fresh. This is the assertion the others were missing.
        const persisted = await store.byId('funding-1');
        expect(persisted?.provider_session_id).toBe('meld-9');
        expect(persisted?.widget_url).toBe('https://meldcrypto.com/session/meld-9');
        expect(persisted?.hosted_widget_url).toBe('https://hosted.example/meld-9');
        expect(persisted?.expires_at).toBe(1_800_000_000_000);
        expect(persisted?.client_reference).toBe('key-1');
        // `updated_at` too. It is the one column the caller sees advance on every response, and it
        // was the one this test's own comment missed: the bind list could keep the previous value
        // while the returned object reported the new one, and nothing noticed.
        expect(persisted?.updated_at).toBe(1_700_000_000_100);
        expect(persisted?.status_history).toEqual([
          { status: 'session_opened', at: 1_700_000_000_000 },
          { status: 'session_opened', at: 1_700_000_000_100 },
        ]);
      });
    });

    it('releases the caller reference when asked, in the row and not only in the reply', async () => {
      // `releaseReference` had no test against the real store at all: every assertion about it
      // ran through the in-memory fake, which implements it. Ignoring the flag entirely in the
      // real store left the suite green, and the production consequence is the key staying bound
      // to a dead row for ever while the contract requires it to be stable across a reload.
      await withStore(async (store) => {
        await store.create(record({ status: 'created', client_reference: 'key-1' }));

        const closed = await store.update('funding-1', 'refused', 1_700_000_000_100, {
          releaseReference: true,
        });

        expect(closed?.client_reference).toBeUndefined();
        expect((await store.byId('funding-1'))?.client_reference).toBeUndefined();
        // And the key really is free: a fresh row can take it.
        await expect(store.create(record({ id: 'funding-2', client_reference: 'key-1' }))).resolves.toBeUndefined();
      });
    });

    it('returns undefined for an unknown id', async () => {
      await withStore(async (store) => {
        expect(await store.update('nope', 'settled', 1_700_000_000_000)).toBeUndefined();
      });
    });

    it('throws on an illegal transition and leaves the row untouched (the write rolls back)', async () => {
      await withStore(async (store) => {
        await store.create(record());
        // `settled` can only come from `transaction_seen`; this must throw and the transaction
        // must roll back so the persisted row is unchanged: no partial write from a refused move.
        await expect(store.update('funding-1', 'settled', 1_700_000_000_000)).rejects.toThrow();
        expect(await store.byId('funding-1')).toEqual(record());
      });
    });
  });
});

describe('the store credential', () => {
  it('is not left as a plaintext string on the pool', async () => {
    // `secret.ts`'s rule is "call at the point of use, never store the result". A string handed to
    // `pg` becomes a stable field on `pool.options` and on every `Client` for the life of the
    // process; a function is resolved per connection, so the plaintext exists for a handshake
    // rather than for ever. The other two credentials already honour this.
    const schema = await createSchema();
    try {
      const store = await openIn(schema);
      // Reaching into the private pool on purpose: the point is what an attacker with a heap dump
      // or a stray `JSON.stringify` would find, not what the public surface exposes.
      const pool = (store as unknown as { pool: { options: { password: unknown } } }).pool;
      expect(typeof pool.options.password).toBe('function');
      // And it resolves to the credential when called: local Postgres uses trust auth, so `pg`
      // never invokes it, and a function that returned the wrong thing would go unnoticed.
      expect((pool.options.password as () => string)()).toBe(storePassword());
      // And it still works. A function that never resolves would fail every query.
      await store.create(fundingRecord({ id: 'still-connects' }));
      expect((await store.byId('still-connects'))?.id).toBe('still-connects');
      await store.close();
    } finally {
      await dropSchema(schema);
    }
  });
});

describe('the TLS options handed to the driver', () => {
  it('verifies the server certificate when TLS is asked for', () => {
    // The branch production runs and no test connects through. The harness is loopback with TLS
    // off. `rejectUnauthorized: false` completes a handshake against any certificate, so the link
    // is encrypted to whoever answered: a MITM on the database connection, invisible to a suite
    // that never executes the branch.
    expect(sslOptions(true)).toEqual({ rejectUnauthorized: true });
  });

  it('is off, not "on without verification", when TLS is not asked for', () => {
    // `false` and `{ rejectUnauthorized: false }` are both "no TLS guarantee", but only one of
    // them is honest about it. The config refuses plaintext to any host outside the pod.
    expect(sslOptions(false)).toBe(false);
  });
});

describe('surviving a lost connection', () => {
  it('does not take the process down when an idle backend is killed underneath it', async () => {
    // CloudSQL fails over, and a failover drops the connections a pool is holding idle. `pg`
    // reports that on the pool, outside any query, and Node's default for an unhandled `error`
    // event on an EventEmitter is to rethrow; with no listener a routine maintenance event
    // takes down the whole service, at the moment staying up matters most.
    //
    // Killing the backend from a second connection is the real thing, not a simulation.
    const schema = await createSchema();
    try {
      const store = await openIn(schema);
      // One query, so a connection exists and then goes idle in the pool.
      await store.create(fundingRecord({ id: 'before-failover' }));

      const killed = await terminateBackends(schema);
      expect(killed).toBeGreaterThan(0);
      // Give the pool's error event a turn to fire before asserting the process is still here.
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Still serving: the pool opens a fresh connection and the row written before is still there.
      expect((await store.byId('before-failover'))?.id).toBe('before-failover');
      await store.close();
    } finally {
      await dropSchema(schema);
    }
  });
});

describe('closing the store', () => {
  it('is idempotent, because the shutdown path that calls it promises to be', async () => {
    // SIGTERM and SIGINT are owned separately, so `close` can be asked to run twice. The second
    // `Pool.end()` rejects, which would surface as a crash on the way out rather than a clean stop.
    const schema = await createSchema();
    const store = await openIn(schema);
    try {
      await store.close();
      await expect(store.close()).resolves.toBeUndefined();
    } finally {
      await dropSchema(schema);
    }
  });
});
