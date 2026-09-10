/**
 * The load-bearing check: is this proof a member of a People-chain ring?
 *
 * This is what actually proves "distinct person", the whole reason this gate exists. A proof is a
 * ring-VRF membership proof over a bandersnatch member set. If it validates against the ring root
 * the People chain currently publishes for the collection and ring the caller declares, then
 * whoever holds the proof's secret is a registered person. There is no "the SDK said Member"
 * (trivially spoofed) and no self-minted possession (anyone can pair a key). The adapter reads
 * the commitment from the chain RPC and verifies against it itself. See docs/threat-model.md R1
 * for the full account of why this is the shipped gate.
 *
 * The check transcribes the chain's own `verify_membership` (pallet-members): read the ring's
 * current `Root` commitment, then `validate_with_commitment` with the collection's ring exponent.
 * The exponent is not accepted from the caller (it is a config constant for the one People
 * collection this deployment serves), so a caller cannot shrink the proof's domain to force a
 * pass.
 *
 * The chain read is injected (`commitment`) so this module stays pure; the transport and storage
 * hashing live in `chain.ts` / `source.ts`. A refusal here costs nothing: no key is spent and no
 * Meld call has happened.
 */

import { hexToU8a, u8aToHex } from '@polkadot/util';

/** The on-chain verifier, bound to a People-chain `Root` commitment. `verifiablejs` fits this. */
export type Validate = (
  ringExponent: number,
  proof: Uint8Array,
  commitment: Uint8Array,
  context: Uint8Array,
  message: Uint8Array,
) => Uint8Array;

/** Supplies the ring commitment the People chain currently publishes for a declared `(id, ring)`. */
export interface ChainCommitments {
  /** The current `Members.Root` commitment, as `0x...`, or null if the ring has no current root. */
  commitment(identifier: string, ring: number): Promise<string | null>;
}

/** What the caller claims about the ring their proof lives in. The `ring` index is not trusted until verified. */
interface RingClaim {
  /** The People-chain collection identifier, hex `0x...` (32 bytes). */
  identifier: string;
  /** The ring index within that collection. */
  ring: number;
}

/** A person proven to be in the ring, once the proof validates on-chain. */
export interface Person {
  /** The contextual alias the proof recovers: the stable per-person key for audit and rate limiting. */
  alias: string;
}

/** Why a proof was not a valid member. Enumerated, but surfaced to the wire only as `401`. */
export enum ProofRefusal {
  /** The declared ring had no current root: not one this chain serves (or a foreign ring). */
  UnknownRing,
  /** The proof failed to open against the current commitment, or is malformed. */
  NotMember,
}

export class ProofRejected extends Error {
  constructor(readonly reason: ProofRefusal) {
    super('membership proof rejected');
    this.name = 'ProofRejected';
  }
}

/**
 * Verify a ring-VRF proof against the current on-chain commitment and recover the person.
 *
 * `context` and `message` are the exact bytes the proof was minted over; `verify_membership` on
 * chain binds all four (proof, commitment, context, message). The commitment is always read from
 * the chain, never from the caller. `ringExponent` is the deployment's fixed domain size.
 *
 * The caller verifies the challenge is authentic and unexpired before this; ordering the
 * challenge check first is what stops a recorded proof being replayed.
 */
export async function verifyRingMembership(
  validate: Validate,
  commitments: ChainCommitments,
  ringExponent: number,
  claim: RingClaim,
  proof: Uint8Array,
  context: Uint8Array,
  message: Uint8Array,
): Promise<Person> {
  const commitmentHex = await commitments.commitment(claim.identifier, claim.ring);
  if (commitmentHex === null) throw new ProofRejected(ProofRefusal.UnknownRing);

  let alias: Uint8Array;
  try {
    alias = validate(ringExponent, proof, hexToU8a(commitmentHex), context, message);
  } catch {
    throw new ProofRejected(ProofRefusal.NotMember);
  }
  return { alias: u8aToHex(alias) };
}