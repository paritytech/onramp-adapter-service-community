/**
 * SS58 normalisation for the delivery address. Two traps:
 *
 * 1. The default prefix is 42, not 0. Asset Hub is 0 (`1...`) and the default yields `5...`, which
 *    reaches a locked checkout field where a buyer cannot correct it.
 * 2. SS58 permits 1, 2, 4, 8 and 33-byte payloads, so a short key checksums cleanly and becomes
 *    a plausible address nobody controls. Passing the checksum is not being an account.
 *
 * An address that cannot be round-tripped is refused, never repaired.
 *
 * Two functions, not one, because "cannot be round-tripped" means something different depending
 * on who supplied the address. `normalizeAddress` is for a caller's own input and refuses with a
 * caller-facing `Refusal`; `canonicalizeDisclosedAddress` is for a value a rail hands back (a
 * sell's deposit address) and never throws, because that value was never a caller's to get wrong.
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

/**
 * Canonicalise an address a RAIL disclosed (a sell's deposit address), or say it could not be.
 *
 * Deliberately not `normalizeAddress`. That function throws a `Refusal` shaped for a caller who
 * typed a bad address into a request; the value here never came from a caller at all, it came
 * back from a payment provider's API response, so a failure to decode it is this service's own
 * integrity problem, not the kind of `400 INVALID_ADDRESS` a buyer or seller could act on. There
 * is nothing for anyone downstream to correct, so nothing is thrown: `undefined` is the whole of
 * the signal, and `funding/merge.ts` treats it exactly like a conflicting well-formed address --
 * recorded, never disclosed, never fatal to an unrelated state move riding alongside it.
 *
 * Same rules otherwise, because the account it names lives on the same chain a buy's wallet
 * address does: must decode as SS58, must be the 32-byte payload of a real account (not one of
 * the shorter forms that checksum cleanly without being one), and is returned in the canonical
 * Polkadot-prefix form so two disclosures of the same account under different prefixes compare
 * equal rather than looking like a changed address.
 */
export function canonicalizeDisclosedAddress(input: string): string | undefined {
  // `decodeAddress('')` throws, but spelling the empty case out here rather than relying on that
  // is what stops a future, more permissive base58 decoder from ever making an empty string look
  // like a valid, if peculiar, account.
  if (input.length === 0) return undefined;
  let publicKey: Uint8Array;
  try {
    publicKey = decodeAddress(input);
  } catch {
    return undefined;
  }
  if (publicKey.length !== PUBLIC_KEY_BYTES) return undefined;
  return encodeAddress(publicKey, POLKADOT_SS58_PREFIX);
}
