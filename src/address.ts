/**
 * SS58 normalisation for the delivery address. Two traps:
 *
 * 1. The default prefix is 42, not 0. Asset Hub is 0 (`1...`) and the default yields `5...`, which
 *    reaches a locked checkout field where a buyer cannot correct it.
 * 2. SS58 permits 1, 2, 4, 8 and 33-byte payloads, so a short key checksums cleanly and becomes
 *    a plausible address nobody controls. Passing the checksum is not being an account.
 *
 * An address that cannot be round-tripped is refused, never repaired.
 */

import { decodeAddress, encodeAddress } from '@polkadot/util-crypto';

import { reject } from './contract.js';

/** Polkadot Asset Hub. Passed explicitly at every call site; never defaulted. */
const POLKADOT_SS58_PREFIX = 0;

const PUBLIC_KEY_BYTES = 32;

/**
 * The caller-visible half of both refusals below, written once.
 *
 * The two branches differ only in the operator detail; the tag, the code and the sentence the buyer
 * reads are the same answer to the same question. Two copies of a user-facing string in one
 * small file is one edit away from telling a caller two different things about one condition.
 */
const invalidAddress = (detail: string) =>
  reject({ tag: 'Other', value: { code: 'INVALID_ADDRESS', message: 'The destination address is not valid.' } }, detail);

/**
 * Normalise to the Polkadot prefix, or refuse.
 *
 * Returns the canonical form, which is what gets pinned and stored. Comparing
 * caller-supplied strings directly would treat the same account under two prefixes as
 * two different destinations.
 */
export function normalizeAddress(input: string): string {
  let publicKey: Uint8Array;
  try {
    publicKey = decodeAddress(input);
  } catch (cause) {
    throw invalidAddress(`Address failed to decode: ${cause instanceof Error ? cause.message : 'unknown'}`);
  }

  if (publicKey.length !== PUBLIC_KEY_BYTES) {
    throw invalidAddress(
      `Address decoded to ${String(publicKey.length)} bytes, expected ${String(PUBLIC_KEY_BYTES)}.`,
    );
  }

  return encodeAddress(publicKey, POLKADOT_SS58_PREFIX);
}
