/**
 * The rate limiter's counter store, partitioned so cheap traffic cannot evict expensive traffic.
 *
 * `@fastify/rate-limit` keeps one LRU for every key. Keys here are `person:<alias>` for a caller who
 * proved personhood and `ip:<addr|/64>` for everyone else (see `caller.ts`), and those two are not
 * comparable: an address is free and unlimited (an IPv6 /48 yields 65,536 distinct /64 buckets
 * after truncation, a /32 yields billions), while an alias costs a ring-VRF proof.
 *
 * In one LRU that asymmetry is an attack. Requests from distinct addresses, each below its own
 * per-address ceiling because each lands in a fresh bucket, evict entries until the person's counter
 * is gone; it restarts at zero and their whole allowance is spendable again. The control that bounds
 * the metered upstream quota fails open, and sizing the LRU only sets the price: an attacker
 * with a /32 can evict any size. Two maps removes the eviction path rather than pricing it.
 *
 * It delegates rather than reimplements. Writing out the plugin's own window arithmetic (expiry,
 * `continueExceeding`, `exponentialBackoff`, the overflow guard) would be a hundred lines this
 * service does not own and as many ways to diverge from it. Holding two real `LocalStore`s makes
 * those semantics exact by construction and leaves this file only the thing it adds: choosing
 * which map a key belongs in.
 */

import { createRequire } from 'node:module';

/**
 * `@fastify/rate-limit` publishes no exports map, so its store is reachable only by subpath require.
 * The package is CommonJS; this is the ESM-safe way to read it, and it is one line rather than a
 * dependency on the store's internals being re-exported some day.
 *
 * A private path carries no compatibility promise, which is why the dependency is pinned exactly
 * rather than by caret: under `^` a transitive `npm install` could move the store underneath and the
 * first symptom would be a limiter that silently stops counting. The conformance suite compares this
 * class against the real `LocalStore` on every run, so a bump is a deliberate change that the tests
 * either clear or fail, never one that arrives on its own.
 */
const LocalStore = createRequire(import.meta.url)('@fastify/rate-limit/store/LocalStore') as StoreCtor;

/** What the plugin hands its store, and what a store hands back. */
interface Store {
  incr(key: string, cb: Callback, timeWindow: number, max: number): void;
  read(key: string, cb: Callback, timeWindow: number, max: number): void;
}
type StoreCtor = new (continueExceeding: boolean, exponentialBackoff: boolean, cache: number) => Store;
type Callback = (error: Error | null, result?: { current: number; ttl: number }) => void;

/**
 * Sized by what can create a key, not by traffic.
 *
 * A person key needs a ring-VRF proof against a People-chain ring, so the population is bounded by
 * ring membership across the allowed products (thousands at the current exponent). 50,000 leaves
 * room for that to grow by orders of magnitude before an eviction is possible, and eviction would
 * then need proofs rather than packets.
 *
 * Address keys are the churn, so a bigger map buys nothing against an attacker and costs memory
 * against everyone. Measured at 245 bytes an entry, these two together are 20.3MB saturated, 7.9% of
 * the chart's 256Mi limit. A single shared LRU sized to make eviction merely expensive (200,000)
 * cost 46.7MB and still lost to a /32.
 */
export const PERSON_ENTRIES = 50_000;
export const ADDRESS_ENTRIES = 10_000;

/**
 * The namespace a rate-limit bucket belongs to, and the single owner of the two prefixes.
 *
 * `caller.ts` mints keys and this file classifies them, so both derive from this one map:
 * `bucketFor` and `namespaceOf` cannot disagree about which namespace a key
 * lives in.
 */
export const BUCKET_NAMESPACE = {
  person: 'person:',
  address: 'ip:',
} as const;
/** Which of the two partitions a key belongs to. */
export type BucketNamespace = keyof typeof BUCKET_NAMESPACE;

/** One bucket key, from the namespace's single owner. */
export function bucketFor(namespace: BucketNamespace, subject: string): string {
  return `${BUCKET_NAMESPACE[namespace]}${subject}`;
}

/** The namespace a key names. Anything not explicitly a person is churn. */
export function namespaceOf(key: string): BucketNamespace {
  return key.startsWith(BUCKET_NAMESPACE.person) ? 'person' : 'address';
}

/** The flags the plugin passes through to a store, and forwards to `child`. */
interface StoreOptions {
  continueExceeding?: boolean;
  exponentialBackoff?: boolean;
}

/** The store the plugin is given: two `LocalStore`s, routed by `namespaceOf(key)`. */
export class PartitionedStore {
  private readonly people: Store;
  private readonly addresses: Store;

  constructor(options: StoreOptions = {}) {
    const { continueExceeding = false, exponentialBackoff = false } = options;
    this.people = new LocalStore(continueExceeding, exponentialBackoff, PERSON_ENTRIES);
    this.addresses = new LocalStore(continueExceeding, exponentialBackoff, ADDRESS_ENTRIES);
  }

  /** The map a key belongs to, from the one namespace owner. */
  private storeFor(key: string): Store {
    return namespaceOf(key) === 'person' ? this.people : this.addresses;
  }

  incr(key: string, cb: Callback, timeWindow: number, max: number): void {
    this.storeFor(key).incr(key, cb, timeWindow, max);
  }

  read(key: string, cb: Callback, timeWindow: number, max: number): void {
    this.storeFor(key).read(key, cb, timeWindow, max);
  }

  /**
   * A per-route store.
   *
   * The plugin calls this for every route carrying its own limiter config, so each gets its own
   * counters; that is the plugin's design and is left alone. The partition holds inside each one.
   */
  child(routeOptions: StoreOptions): PartitionedStore {
    return new PartitionedStore(routeOptions);
  }
}
