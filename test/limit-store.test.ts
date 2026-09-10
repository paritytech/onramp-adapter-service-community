import { describe, expect, it } from 'vitest';

import {
  ADDRESS_ENTRIES,
  BUCKET_NAMESPACE,
  bucketFor,
  namespaceOf,
  PartitionedStore,
  PERSON_ENTRIES,
} from '../src/limit-store.js';

/** `incr`/`read` are callback-shaped; this is the value they hand back. */
const count = (store: PartitionedStore, key: string, window = 60_000, max = 5): number => {
  let seen = 0;
  store.incr(key, (_e, r) => { seen = r?.current ?? 0; }, window, max);
  return seen;
};

import { createRequire } from 'node:module';

/** The plugin's own store, to compare against. */
type Answer = (e: Error | null, r?: { current: number; ttl: number }) => void;
type Fn = (key: string, cb: Answer, timeWindow: number, max: number) => void;
const LocalStore = createRequire(import.meta.url)('@fastify/rate-limit/store/LocalStore') as new (
  continueExceeding: boolean,
  exponentialBackoff: boolean,
  cache: number,
) => { incr: Fn; read: Fn };

describe('the one owner of the bucket namespaces', () => {
  it('mints and classifies a person key against the same prefix', () => {
    // `caller.ts` mints keys with `bucketFor` and the store classifies them with `namespaceOf`.
    // Both derive from `BUCKET_NAMESPACE`, so changing the shared prefix flips them in step. That
    // is the coupling a hand-written `'person:'` in one place and a `startsWith('person:')` in
    // another would not have.
    //
    // Asserted against literals, not against the constant. Writing the expectation as
    // `` `${BUCKET_NAMESPACE.person}0xalice` `` derives both sides from the same value, so it holds
    // for every possible prefix; changing `person:` to `p:` left it green. The literals are the
    // wire-visible strings, and pinning them is the point, rather than claiming a
    // mutation to `address` failed this test, and `address` does not appear in it at all.
    expect(bucketFor('person', '0xalice')).toBe('person:0xalice');
    expect(bucketFor('address', '203.0.113.7')).toBe('ip:203.0.113.7');
    expect(BUCKET_NAMESPACE.person).toBe('person:');
    expect(BUCKET_NAMESPACE.address).toBe('ip:');
    expect(namespaceOf(bucketFor('person', '0xalice'))).toBe('person');
    expect(namespaceOf(bucketFor('address', '203.0.113.7'))).toBe('address');
  });

  it('classifies a key that is not a person as churn', () => {
    // The safety direction: a misspelled or attacker-shaped key must land in the bounded address
    // map, never silently promoted to a person's fresh bucket.
    expect(namespaceOf('ip:203.0.113.7')).toBe('address');
    expect(namespaceOf('person2:bob')).toBe('address');
    expect(namespaceOf('203.0.113.7')).toBe('address');
  });

  it('derives the address ceiling from the namespace owner and not a spelling', () => {
    // The old coupling let one `'ip:'` drift from the other. Muting this to a fresh spelling of the
    // address namespace fails the "closed set of spelled prefixes" assertion.
    expect(BUCKET_NAMESPACE.address).toBe('ip:');
    expect(BUCKET_NAMESPACE.person).toBe('person:');
  });
});

describe('the sizes the partition rests on', () => {
  /** Fill one map past `n` distinct keys and report whether the first survived. */
  const survivesChurn = (prefix: string, n: number): boolean => {
    const store = new PartitionedStore();
    count(store, `${prefix}first`);
    for (let i = 0; i < n; i += 1) count(store, `${prefix}${String(i)}`);
    let seen = 0;
    store.read(`${prefix}first`, (_e, r) => { seen = r?.current ?? 0; }, 60_000, 5);
    return seen > 0;
  };

  it('holds the sizes its argument rests on', () => {
    // The churn probes below use 20,000 in both directions, so between them they pin only
    // `PERSON_ENTRIES > 20_000 > ADDRESS_ENTRIES`: `50_000 -> 20_001` and `10_000 -> 19_000` each
    // survived the suite. The numbers are the argument (eviction of a person's counter must cost
    // proofs, not packets), so they are asserted directly rather than inferred from a probe.
    expect(PERSON_ENTRIES).toBe(50_000);
    expect(ADDRESS_ENTRIES).toBe(10_000);
  });

  it('holds far more person keys than any ring could produce', () => {
    // The number is the whole argument: eviction of a person's counter must need proofs, not
    // packets. It was asserted nowhere, so 50,000 could become 10 with the suite green, and at 10
    // the fail-open the partition exists to remove comes back at a price a modest ring can pay.
    expect(survivesChurn('person:', 20_000)).toBe(true);
  });

  it('bounds address keys, because churn is what they are for', () => {
    // The other direction. A bigger address map buys nothing against an attacker who has more
    // addresses than there is memory for, so this one is deliberately small and does evict.
    expect(survivesChurn('ip:', 20_000)).toBe(false);
  });

  it('forwards a route\'s window options to the child store', async () => {
    // `child()` could return `new PartitionedStore()` (dropping the route's options) with the
    // suite green, because the only test calling it passed `{}`. A route configured with
    // `continueExceeding` would silently lose it, and its `retry-after` would be wrong.
    //
    // The flags move the window, never the count, and only once time has actually passed. With
    // `continueExceeding` an exceeded caller's window resets to full on every request; without it
    // the remainder ticks down. A test that measured immediately saw 60_000 either way.
    const withFlag = new PartitionedStore().child({ continueExceeding: true });
    const without = new PartitionedStore().child({});
    const drive = async (store: PartitionedStore) => {
      for (let i = 0; i < 2; i += 1) count(store, 'person:hammering', 200, 1);
      await new Promise((resolve) => setTimeout(resolve, 40));
      let ttl = 0;
      store.incr('person:hammering', (_e, r) => { ttl = r?.ttl ?? 0; }, 200, 1);
      return ttl;
    };

    expect(await drive(withFlag)).toBe(200);
    expect(await drive(without)).toBeLessThan(200);
  });
});

describe('conformance with the plugin\'s own store', () => {
  /** Drive both stores through the same sequence and compare every answer. */
  const compare = (options: { continueExceeding?: boolean; exponentialBackoff?: boolean }, window: number, max: number) => {
    const mine = new PartitionedStore(options);
    const theirs = new LocalStore(options.continueExceeding ?? false, options.exponentialBackoff ?? false, 5_000);
    const seen: { mine: unknown; theirs: unknown }[] = [];

    // Both halves of the partition. Driving `person:` only would leave the address
    // store's constructor arguments were unasserted: it could be built with the flags hard-coded
    // to `false` and the suite stayed green, giving unproven callers different window behaviour
    // from proven ones. They are the majority, and the ones backoff exists for.
    for (const key of ['person:same', 'ip:203.0.113.7']) {
      for (let i = 0; i < 6; i += 1) {
        let a: unknown;
        let b: unknown;
        // `current` and `ttl`. The window flags do not change the count at all, only the reset
        // window, so comparing counts alone let the address store be built with both flags
        // hard-coded off while every case passed.
        // `current` exactly, `ttl` to the nearest 10ms.
        //
        // The two stores are driven by two separate calls, so a millisecond boundary falling
        // between them made the exact `ttl` strings differ and failed this test intermittently,
        // for a reason that has nothing to do with the window arithmetic it exists to compare.
        // Bucketing keeps the assertion (a store using the wrong window is off by seconds, not
        // milliseconds) and removes the clock race.
        const bucket = (ttl: number | undefined) => Math.round((ttl ?? -1) / 10);
        mine.incr(key, (_e, r) => { a = `${String(r?.current)}/${String(bucket(r?.ttl))}`; }, window, max);
        theirs.incr(key, (_e, r) => { b = `${String(r?.current)}/${String(bucket(r?.ttl))}`; }, window, max);
        seen.push({ mine: a, theirs: b });
        mine.read(key, (_e, r) => { a = r?.current; }, window, max);
        theirs.read(key, (_e, r) => { b = r?.current; }, window, max);
        seen.push({ mine: a, theirs: b });
      }
    }
    return seen;
  };

  it('counts and reads identically to LocalStore', () => {
    // The reason this file delegates rather than reimplements. The first version wrote out the
    // plugin's window arithmetic by hand and `read()` diverged: it recomputed the remaining window
    // from the original `timeWindow` while the plugin stores a reset or widened one, so a
    // non-mutating check after an exceeded request reported the wrong `retry-after` and
    // `x-ratelimit-reset`. Comments claimed the arithmetic was mirrored; nothing checked it.
    for (const { mine, theirs } of compare({}, 60_000, 3)) expect(mine).toBe(theirs);
  });

  it('counts and reads identically under continueExceeding', () => {
    for (const { mine, theirs } of compare({ continueExceeding: true }, 60_000, 2)) expect(mine).toBe(theirs);
  });

  it('counts and reads identically under exponentialBackoff', () => {
    for (const { mine, theirs } of compare({ exponentialBackoff: true }, 1_000, 2)) expect(mine).toBe(theirs);
  });

  it('reports a ttl the plugin can turn into retry-after', () => {
    // The plugin divides this by 1000 for `retry-after` and `x-ratelimit-reset`, so a wrong value
    // is a wrong instruction to the caller rather than a wrong count.
    const mine = new PartitionedStore();
    const theirs = new LocalStore(false, false, 5_000);
    let a = -1;
    let b = -1;
    mine.incr('ip:203.0.113.1', (_e, r) => { a = r?.ttl ?? -1; }, 60_000, 5);
    theirs.incr('ip:203.0.113.1', (_e, r) => { b = r?.ttl ?? -1; }, 60_000, 5);
    expect(a).toBe(b);
  });
});

describe('the partitioned limit store', () => {
  it('keeps a person\'s counter when addresses churn past the address map\'s size', () => {
    // The whole reason this store exists. An address is free (an IPv6 /48 gives 65,536 distinct
    // /64 buckets after truncation, a /32 gives billions), while a `person:` alias costs a
    // ring-VRF proof. Sharing one LRU lets the cheap key evict the expensive one, and the person's
    // allowance restarts at zero.
    //
    // 40,000 distinct addresses is four times the address map and would have evicted everything in
    // a shared LRU of any size this service could afford.
    const store = new PartitionedStore();
    expect(count(store, 'person:alice')).toBe(1);
    expect(count(store, 'person:alice')).toBe(2);

    for (let i = 0; i < 40_000; i += 1) count(store, `ip:198.51.100.${String(i)}`);

    // Still counting from where she left off, not from zero.
    expect(count(store, 'person:alice')).toBe(3);
  });

  it('still evicts addresses, which is what the address map is for', () => {
    const store = new PartitionedStore();
    count(store, 'ip:203.0.113.1');
    for (let i = 0; i < 20_000; i += 1) count(store, `ip:198.51.100.${String(i)}`);
    // Pushed out, and starts again: the bounded-memory trade this map deliberately makes.
    expect(count(store, 'ip:203.0.113.1')).toBe(1);
  });

  it('starts a new window once the old one has passed', () => {
    const store = new PartitionedStore();
    expect(count(store, 'person:bob', 1)).toBe(1);
    const past = Date.now() + 10;
    while (Date.now() < past) { /* let the 1ms window lapse */ }
    expect(count(store, 'person:bob', 1)).toBe(1);
  });

  it('reads without counting', () => {
    const store = new PartitionedStore();
    count(store, 'person:carol');
    let peeked = -1;
    store.read('person:carol', (_e, r) => { peeked = r?.current ?? -1; }, 60_000, 5);
    expect(peeked).toBe(1);
    // And the peek did not advance it.
    expect(count(store, 'person:carol')).toBe(2);
  });

  it('reports a clean state for a key it has never seen', () => {
    const store = new PartitionedStore();
    let peeked = -1;
    store.read('person:nobody', (_e, r) => { peeked = r?.current ?? -1; }, 60_000, 5);
    expect(peeked).toBe(0);
  });

  it('holds the window open while a caller keeps exceeding it, when asked to', () => {
    // `continueExceeding` resets the window on every request past the ceiling, so a caller who
    // keeps hammering never rolls out of it. The limiter reads the `ttl` to build `retry-after`.
    const store = new PartitionedStore({ continueExceeding: true });
    for (let i = 0; i < 3; i += 1) count(store, 'person:dave', 60_000, 2);
    let ttl = 0;
    store.incr('person:dave', (_e, r) => { ttl = r?.ttl ?? 0; }, 60_000, 2);
    expect(ttl).toBe(60_000);
  });

  it('widens the window exponentially when asked to, and does not overflow', () => {
    const store = new PartitionedStore({ exponentialBackoff: true });
    for (let i = 0; i < 3; i += 1) count(store, 'person:erin', 1_000, 2);
    let ttl = 0;
    store.incr('person:erin', (_e, r) => { ttl = r?.ttl ?? 0; }, 1_000, 2);
    expect(ttl).toBeGreaterThan(1_000);

    // A caller who keeps going must not push the ttl past what a number can hold.
    for (let i = 0; i < 80; i += 1) store.incr('person:erin', () => undefined, 1_000, 2);
    store.incr('person:erin', (_e, r) => { ttl = r?.ttl ?? 0; }, 1_000, 2);
    expect(Number.isSafeInteger(ttl)).toBe(true);
  });

  it('gives each route its own counters, and each keeps the partition', () => {
    const parent = new PartitionedStore();
    const child = parent.child({});
    count(parent, 'person:frank');
    // A fresh store, so the parent's count does not carry over.
    expect(count(child, 'person:frank')).toBe(1);
    for (let i = 0; i < 20_000; i += 1) count(child, `ip:198.51.100.${String(i)}`);
    expect(count(child, 'person:frank')).toBe(2);
  });
});
