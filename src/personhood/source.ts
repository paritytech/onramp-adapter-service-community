/**
 * The People-chain reads backing the register gate: turn a flat `ChainReader` into a
 * `RingSource` that the gate verifies against.
 *
 * One value is read from the chain per proof: the ring's `Root` commitment
 * (`pallet-members::Root`, keyed `(Identifier, RingIndex)`). That single value is the ring root
 * `verifiablejs` validates a proof against directly; reading it is the whole chain cost, and it
 * is why this is cheap compared to reconstructing the member set from the paged `RingKeys`.
 *
 * The `Root` value is `RingRoot { root: Members, revision: u64 }`, where `Members` is the
 * 768-byte commitment `validate_with_commitment` consumes. The commitment is the first 768 bytes. That
 * fixed-layout dependency is documented here, in the module that reads it, rather than pointing
 * at `register.ts`, which does not mention the 768-byte prefix.
 *
 * The ring exponent (which `validate_with_commitment` also needs, as the proof domain) is not
 * decoded from `Collections`: that SCALE struct has a variable-width `owner` enum, and decoding
 * it is not worth the code here. A deployment targets one People collection, so the exponent is a
 * config constant for that collection, not a per-request chain read. This keeps the only chain
 * primitive to a single fixed-offset commitment read.
 */

import { hexToU8a, u8aToHex } from '@polkadot/util';

import type { ChainReader } from './chain.js';
import { membersRootKey } from './key.js';
import type { ChainCommitments } from './register.js';

/** The 768-byte commitment occupies this fixed prefix of the `Root` value. */
const COMMITMENT_BYTES = 768;

/**
 * How many redeems may have reads in flight at once, across all callers.
 *
 * `POST /api/v1/auth/redeem` is public and unauthenticated, and it reaches a chain read after only
 * a MAC check and a product allowlist test. `chainReader` opens a fresh WebSocket per call and
 * holds it for up to its 8-second timeout, so without a bound one ~1KB HTTP request buys one
 * outbound socket held for eight seconds, against a single pod with a 256Mi limit; file
 * descriptors and memory exhaust long before bandwidth does, and the People RPC sees a flood this service
 * generated.
 *
 * Eight, because the ceiling is about amplification, not throughput: the legitimate register path
 * is low-rate, and coalescing below means concurrent proofs against the same ring cost one read
 * between them. A caller past this ceiling is shed with a retryable failure rather than queued,
 * because queueing an unauthenticated request is the same allocation with a longer fuse.
 *
 * Counted in redeems, not reads, and the distinction became load-bearing when a deployment could
 * serve several collections. One redeem walks them until a proof opens, so it costs up to one read
 * per collection. Left as a flat read count, adding a second collection would have halved the
 * concurrent redeems this pod serves: a capacity change nobody chose, arriving through a config
 * edit. The socket bound moves with the collection count instead, which is the quantity the
 * paragraph above is actually reasoning about.
 */
const MAX_IN_FLIGHT_REDEEMS = 8;

/**
 * Build `ChainCommitments` from a `ChainReader` bound to the People-chain RPC.
 *
 * `collectionCount` is how many collections one redeem may walk; see `MAX_IN_FLIGHT_REDEEMS`.
 */
export function commitmentsFrom(reader: ChainReader, collectionCount = 1): ChainCommitments {
  const MAX_IN_FLIGHT_READS = MAX_IN_FLIGHT_REDEEMS * Math.max(collectionCount, 1);
  /**
   * Reads currently open, keyed by storage key, so N concurrent proofs against one ring cost one
   * socket, not N, and every one of them sees the same fresh value.
   *
   * Deduplication alone is not the bound: `ring` is caller-supplied and the schema admits the
   * whole u32 range, so an attacker varying it defeats coalescing entirely.
   * `MAX_IN_FLIGHT_READS` is what actually bounds the outbound sockets; this map is the cheap win
   * for the honest case, where everyone asks about the same ring.
   */
  const inFlight = new Map<string, Promise<string | undefined>>();
  let active = 0;

  const read = (key: string): Promise<string | undefined> => {
    const existing = inFlight.get(key);
    if (existing !== undefined) return existing;

    if (active >= MAX_IN_FLIGHT_READS) {
      // Not a caller mistake and not an internal fault: it is this service declining to open
      // another socket. `personhood.ts` turns a non-`ProofRejected` failure into
      // `upstreamUnavailable`, so the caller meets a 503 with a `retry-after`, which is the
      // honest answer, and the one that tells a legitimate caller to come back.
      throw new Error(`People-chain reads are at their in-flight ceiling (${String(MAX_IN_FLIGHT_READS)}).`);
    }

    active += 1;
    const pending = reader.getStorage(key);
    inFlight.set(key, pending);
    // `then(done, done)` rather than `finally`: the derived promise handles both settlements, so a
    // rejected read cannot surface as an unhandled rejection from the bookkeeping chain, while
    // callers still await `pending` itself and handle their own.
    const done = (): void => {
      active -= 1;
      inFlight.delete(key);
    };
    pending.then(done, done);
    return pending;
  };

  return {
    async commitment(identifier: string, ring: number): Promise<string | null> {
      const value = await read(membersRootKey(identifier, ring));
      if (value === undefined) return null;
      const bytes = hexToU8a(value);
      // Asserted, not assumed. `subarray` shortens without complaining, so a `Root` the chain
      // returned in some other shape would have handed `validate_with_commitment` a truncated
      // commitment (the one input that decides who is a person) as though it were whole. This
      // is a chain or configuration fault rather than a caller mistake, so it surfaces as one.
      if (bytes.byteLength < COMMITMENT_BYTES) {
        throw new Error(
          `People-chain Members.Root for ring ${String(ring)} is ${String(bytes.byteLength)} bytes; ` +
            `the commitment needs ${String(COMMITMENT_BYTES)}.`,
        );
      }
      // The commitment is the first 768 bytes of the `Root` value (the raw `MembersOf` bytes).
      return u8aToHex(bytes.subarray(0, COMMITMENT_BYTES));
    },
  };
}