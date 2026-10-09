import { describe, expect, it } from 'vitest';
import { encodeAddress } from '@polkadot/util-crypto';

import { canonicalizeDisclosedAddress, normalizeAddress } from '../src/address.js';
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

describe('canonicalizeDisclosedAddress for a sell-only code', () => {
  const SOLANA = 'So11111111111111111111111111111111111111112';

  it('passes a base58 Solana key through unchanged', () => {
    expect(canonicalizeDisclosedAddress(SOLANA, 'USDT_SOLANA')).toBe(SOLANA);
    expect(canonicalizeDisclosedAddress(SOLANA, 'USDC_SOLANA')).toBe(SOLANA);
  });

  it('refuses empty, non-base58 and wrong-length values', () => {
    expect(canonicalizeDisclosedAddress('', 'USDT_SOLANA')).toBeUndefined();
    expect(canonicalizeDisclosedAddress('0OIl', 'USDT_SOLANA')).toBeUndefined();
    expect(canonicalizeDisclosedAddress('abc', 'USDT_SOLANA')).toBeUndefined();
  });

  it('leaves SS58 handling for Asset Hub codes as it was', () => {
    expect(canonicalizeDisclosedAddress(ALICE_PREFIX_42, 'DOT_ASSETHUB')).toBe(ALICE_PREFIX_0);
    expect(canonicalizeDisclosedAddress(ALICE_PREFIX_42)).toBe(ALICE_PREFIX_0);
    expect(canonicalizeDisclosedAddress(SOLANA, 'DOT_ASSETHUB')).toBeUndefined();
  });
});

describe('canonicalizeDisclosedAddress for an EVM sell-only code', () => {
  const MIXED = '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01';

  it('accepts 0x plus 40 hex and lowercases it, so casings compare equal', () => {
    expect(canonicalizeDisclosedAddress(MIXED, 'USDC_ARBITRUM')).toBe(MIXED.toLowerCase());
    expect(canonicalizeDisclosedAddress(MIXED.toLowerCase(), 'USDC_ARBITRUM')).toBe(MIXED.toLowerCase());
  });

  it('refuses everything else, including Solana and SS58 values', () => {
    for (const bad of ['', '0x', '0x1234', `${MIXED}ab`, MIXED.slice(2), `0x${'g'.repeat(40)}`, 'So11111111111111111111111111111111111111112', ALICE_PREFIX_0]) {
      expect(canonicalizeDisclosedAddress(bad, 'USDC_ARBITRUM')).toBeUndefined();
    }
  });

  it('is not accepted for the other codes', () => {
    expect(canonicalizeDisclosedAddress(MIXED, 'USDC_SOLANA')).toBeUndefined();
    expect(canonicalizeDisclosedAddress(MIXED, 'DOT_ASSETHUB')).toBeUndefined();
  });
});
