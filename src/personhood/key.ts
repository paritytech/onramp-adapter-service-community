/**
 * Compute the People-chain storage key the register gate reads, per substrate's key layout.
 *
 * A full key is `twox128(pallet) || twox128(storage) || <key-hasher>(key)`. One item is read:
 *
 *   `Members.Root`: StorageDoubleMap<Identifier[Identity], RingIndex[Blake2_128Concat]>
 *                      -> `twox128("Members") || twox128("Root") || identifier || blake2_128(ring) || ring`
 *
 * The `Identifier` is a 32-byte value already, so the `Identity` hasher appends it verbatim.
 */

import { blake2AsU8a, xxhashAsU8a } from '@polkadot/util-crypto';
import { hexToU8a, stringToU8a, u8aConcat, u8aToHex } from '@polkadot/util';

const PALLET = 'Members';
const STORAGE = 'Root';

/** `Members.Root` for `(identifier, ring)`. The ring index is a little-endian u32. */
export function membersRootKey(identifier: string, ring: number): string {
  const id = hexToU8a(identifier);
  if (id.byteLength !== 32) throw new Error('identifier must be 32 bytes');
  const ringBytes = new Uint8Array(4);
  new DataView(ringBytes.buffer).setUint32(0, ring, true);
  return u8aToHex(
    u8aConcat(
      xxhashAsU8a(stringToU8a(PALLET), 128),
      xxhashAsU8a(stringToU8a(STORAGE), 128),
      id,
      blake2AsU8a(ringBytes, 128),
      ringBytes,
    ),
  );
}