import { describe, expect, it } from 'vitest';
import { encodeAddress } from '@polkadot/util-crypto';

import { normalizeAddress } from '../src/address.js';
import { Refusal } from '../src/contract.js';

// Alice, the canonical well-known account.
const ALICE_PUBKEY = new Uint8Array([
  0xd4, 0x35, 0x93, 0xc7, 0x15, 0xfd, 0xd3, 0x1c, 0x61, 0x14, 0x1a, 0xbd, 0x04, 0xa9, 0x9f, 0xd6,
  0x82, 0x2c, 0x85, 0x58, 0x85, 0x4c, 0xcd, 0xe3, 0x9a, 0x56, 0x84, 0xe7, 0xa5, 0x6d, 0xa2, 0x7d,
]);

const ALICE_PREFIX_0 = encodeAddress(ALICE_PUBKEY, 0);
const ALICE_PREFIX_42 = encodeAddress(ALICE_PUBKEY, 42);

describe('normalizeAddress', () => {
  it('rewrites the default prefix 42 to Polkadot prefix 0', () => {
    // The defect that shipped: prefix 42 gives 5..., Asset Hub needs 1..., and it went into a
    // locked checkout field where the buyer could not correct it.
    expect(ALICE_PREFIX_42.startsWith('5')).toBe(true);
    expect(normalizeAddress(ALICE_PREFIX_42)).toBe(ALICE_PREFIX_0);
    expect(normalizeAddress(ALICE_PREFIX_42).startsWith('1')).toBe(true);
  });

  it('is idempotent on an already-normalised address', () => {
    expect(normalizeAddress(ALICE_PREFIX_0)).toBe(ALICE_PREFIX_0);
  });

  it('collapses the same account written under two prefixes to one string', () => {
    // Why the pinned value is the normalised one: comparing caller strings directly would
    // treat one account as two destinations, and the request hash would differ.
    expect(normalizeAddress(ALICE_PREFIX_42)).toBe(normalizeAddress(ALICE_PREFIX_0));
  });

  it.each([
    ['empty', ''],
    ['not base58', 'not-an-address!!'],
    ['truncated', ALICE_PREFIX_0.slice(0, 10)],
    ['bad checksum', `${ALICE_PREFIX_0.slice(0, -1)}X`],
  ])('refuses %s', (_label, input) => {
    expect(() => normalizeAddress(input)).toThrow(Refusal);
  });

  it('refuses a 33-byte payload, which SS58 also permits', () => {
    // 33 bytes is a valid SS58 length, so it round-trips cleanly and is not an account.
    const long = encodeAddress(new Uint8Array(33).fill(7), 0);
    expect(() => normalizeAddress(long)).toThrow(/33 bytes, expected 32/);
  });

  it('refuses a well-formed address whose key is not 32 bytes', () => {
    // SS58 permits key lengths 1, 2, 4, 8, 32 and 33, so a short key encodes and checksums
    // cleanly and decodes back without complaint. Passing the checksum is therefore not the
    // same as being an account, and without this assertion a malformed key becomes a
    // plausible address that nobody controls, in a locked checkout field.
    const short = encodeAddress(ALICE_PUBKEY.slice(0, 8), 0);
    expect(() => normalizeAddress(short)).toThrow(/8 bytes, expected 32/);
  });
});
