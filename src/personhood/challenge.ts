/**
 * The stateless challenge that starts the personhood handshake.
 *
 * A challenge is a 56-byte token the adapter issues in exchange for nothing and carries nothing
 * personally identifying. It is the "fresh randomness + enforced recency" half of proving a
 * caller is currently a person: a ring proof is bound to the challenge's bytes, and the
 * challenge carries its own issued-at timestamp inside the MAC, so a proof recorded against a
 * previous challenge cannot be paired with a fresh one. That is the actual replay stop.
 *
 * The token is not "used up" by a redemption. Nothing marks a nonce consumed, so the same
 * challenge and the same proof can be re-redeemed within the TTL to re-mint the same alias's
 * token. That is not an escalation (the proof binds the person), and the code relies on it. The
 * only per-person key is the alias, and re-deriving it is re-authenticating the same person.
 *
 * Layout is fixed, so a token issued here interoperates with the reference implementation:
 *
 *     nonce(16) || issuedAt:u64-be-millis(8) || HMAC-SHA256(nonce || issuedAt)(32)
 *
 * The token is self-authenticating: the HMAC key lives only server-side, so an attacker cannot
 * mint their own challenge. It is stateless (no server-side store keyed by nonce) because a
 * challenge is just a signed timestamp; once `verify` checks the MAC and the TTL, there is
 * nothing left to remember.
 */

import { hmacSha256AsU8a } from '@polkadot/util-crypto';
import { randomBytes, timingSafeEqual } from 'node:crypto';

/** The random half of a challenge; the rest is a timestamp and the MAC over both. */
export const NONCE_BYTES = 16;
const TIMESTAMP_BYTES = 8;
const MAC_BYTES = 32;
const SIGNED_BYTES = NONCE_BYTES + TIMESTAMP_BYTES;
/** The exact wire length of a challenge. A body of any other size is refused before the MAC check. */
export const CHALLENGE_BYTES = SIGNED_BYTES + MAC_BYTES;

/** Tolerance for an issued-at slightly ahead of the verifying clock: ordinary drift, not a step. */
const CLOCK_SKEW_MILLIS = 5_000;

/** One type for a failed MAC, length or TTL, so a caller cannot tell which check rejected them. */
export class InvalidChallenge extends Error {}

/**
 * Mint a fresh challenge: opaque bytes for the wire.
 *
 * `issuedAtMillis` and `nonce` are injectable for tests; the defaults make it a live token.
 */
export function mintChallenge(
  key: Uint8Array,
  opts: { issuedAtMillis?: number; nonce?: Uint8Array } = {},
): Uint8Array {
  const issuedAtMillis = opts.issuedAtMillis ?? Date.now();
  const nonce = opts.nonce ?? randomBytes(NONCE_BYTES);

  if (nonce.byteLength !== NONCE_BYTES) throw new Error(`nonce must be ${String(NONCE_BYTES)} bytes`);

  const token = new Uint8Array(CHALLENGE_BYTES);
  token.set(nonce, 0);
  new DataView(token.buffer).setBigUint64(NONCE_BYTES, BigInt(issuedAtMillis), false);
  token.set(mac(key, nonce, issuedAtMillis), SIGNED_BYTES);
  return token;
}

/**
 * Reject a challenge that is not currently authentic.
 *
 * Throws `InvalidChallenge` whose message names the reason ('malformed' | 'inauthentic' |
 * 'expired'). `now` and `ttlMillis` are injected so the caller's clock is the one that counts.
 */
export function verifyChallenge(
  key: Uint8Array,
  token: Uint8Array,
  opts: { now: number; ttlMillis: number },
): void {
  if (token.byteLength !== CHALLENGE_BYTES) throw new InvalidChallenge('malformed');
  const nonce = token.subarray(0, NONCE_BYTES);
  const issuedAtMillis = new DataView(token.buffer, token.byteOffset, token.byteLength).getBigUint64(NONCE_BYTES, false);
  const suppliedHmac = token.subarray(SIGNED_BYTES, CHALLENGE_BYTES);

  const expected = mac(key, nonce, Number(issuedAtMillis));
  if (!timingSafeEqual(suppliedHmac, expected)) throw new InvalidChallenge('inauthentic');
  // Both directions. Only checking `age > ttl` let a future issued-at stay valid for as long
  // as it was ahead by, so a clock that stepped backwards on the minting instance permanently
  // extended every challenge already handed out. Unforgeable, but not therefore harmless.
  const age = opts.now - Number(issuedAtMillis);
  if (age > opts.ttlMillis || age < -CLOCK_SKEW_MILLIS) throw new InvalidChallenge('expired');
}

function mac(key: Uint8Array, nonce: Uint8Array, issuedAtMillis: number): Uint8Array {
  const signed = new Uint8Array(SIGNED_BYTES);
  signed.set(nonce, 0);
  new DataView(signed.buffer).setBigUint64(NONCE_BYTES, BigInt(issuedAtMillis), false);
  return hmacSha256AsU8a(key, signed);
}