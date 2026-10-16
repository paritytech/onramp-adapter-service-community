import { describe, expect, it } from 'vitest';
import { addressFromKey, keccak256, rlpEncode, signTransaction } from '../../src/salevault/evm.js';

const hexToBytes = (hex: string): Uint8Array => {
  const clean = hex.replace(/^0x/, '');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
};

// A fixed throwaway key (not a real wallet), with the raw transaction and hash a reference signer
// (ethers v6) produced for the same fields. The point of hand-rolling is proven only by this match.
const KEY = hexToBytes('0x4646464646464646464646464646464646464646464646464646464646464646');
const ADDRESS = '0x9d8A62f656a8d1615C1294fd71e9CFb3E4855A4F';

const TX = {
  chainId: 421614n,
  nonce: 7n,
  maxPriorityFeePerGas: 1_000_000_000n,
  maxFeePerGas: 2_000_000_000n,
  gasLimit: 120_000n,
  to: '0x81949127042930F8e7A1723385A2F76213C72ee9',
  value: 0n,
  data: '0xa9059cbb00000000000000000000000000000000000000000000000000000000deadbeef',
};

const EXPECTED_RAW =
  '0x02f89283066eee07843b9aca0084773594008301d4c09481949127042930f8e7a1723385a2f76213c72ee980a4' +
  'a9059cbb00000000000000000000000000000000000000000000000000000000deadbeefc001a0d1d30e9c10ea0f' +
  '1c42e9b8386ba594d5a9a727d2b75ec6907d22dae5fff4c495a0045590002e20a21d02dd059370ccf90eeffecbd5' +
  'eb381ca3bca31e0e0a3b2f83';
const EXPECTED_HASH = '0x90662c2a1db41300db10d2c4c7d2b61a0679186853602c35ec48d15cd20ad2b9';

describe('evm', () => {
  it('signs an EIP-1559 transaction byte-for-byte like the reference signer', () => {
    const signed = signTransaction(TX, KEY);
    expect(signed.raw).to.equal(EXPECTED_RAW);
    expect(signed.hash).to.equal(EXPECTED_HASH);
  });

  it('derives the EVM address from the private key', () => {
    expect(addressFromKey(KEY).toLowerCase()).to.equal(ADDRESS.toLowerCase());
  });

  it('rejects a key that is not 32 bytes', () => {
    expect(() => signTransaction(TX, new Uint8Array(31))).to.throw('32 bytes');
    expect(() => addressFromKey(new Uint8Array(33))).to.throw('32 bytes');
  });

  it('rejects an odd-length hex field', () => {
    // An odd-length `data` reaches hexToBytes and must be refused rather than silently truncated.
    expect(() => signTransaction({ ...TX, data: '0x1' }, KEY)).to.throw(/odd-length/);
  });

  it('rejects a negative transaction field', () => {
    // A negative amount reaches toMinimalBytes, which refuses it rather than encode a garbage word.
    expect(() => signTransaction({ ...TX, value: -1n }, KEY)).to.throw(/negative/);
  });

  it('keccak256 and rlpEncode behave on known inputs', () => {
    // keccak256 of the empty string, the canonical test value.
    expect(keccak256(new Uint8Array(0))).to.equal(
      '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470',
    );
    // RLP of the empty list is 0xc0, of a single zero byte is 0x00.
    expect(rlpEncode([])).to.deep.equal(Uint8Array.of(0xc0));
    expect(rlpEncode(Uint8Array.of(0x00))).to.deep.equal(Uint8Array.of(0x00));
  });
});
