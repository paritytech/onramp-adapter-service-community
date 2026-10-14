import { describe, expect, it } from 'vitest';
import {
  bytes32,
  decodeSale,
  decodeUint,
  encodeGetter,
  encodeResolveUnknown,
  encodeReturnHeld,
  encodeReturnRefund,
  encodeSales,
  encodeWithdrawDust,
  saleRef,
  selector,
  word,
} from '../../src/salevault/abi.js';

const uintWord = (n: bigint) => n.toString(16).padStart(64, '0');

describe('selector', () => {
  it('is the first four bytes of the signature hash', () => {
    expect(selector('dust()')).toHaveLength(4);
  });
});

describe('saleRef', () => {
  it('is a deterministic 32-byte keccak of the id as UTF-8', () => {
    const a = saleRef('funding-1');
    expect(a).toMatch(/^0x[0-9a-f]{64}$/);
    expect(saleRef('funding-1')).toBe(a);
    expect(saleRef('funding-2')).not.toBe(a);
  });
});

describe('word', () => {
  it('left-pads a uint into a 32-byte word', () => {
    expect(word(1n)).toHaveLength(32);
    expect(word(0n).every((b) => b === 0)).toBe(true);
  });

  it('refuses a negative value', () => {
    expect(() => word(-1n)).toThrow(/negative/);
  });

  it('refuses a value wider than 32 bytes', () => {
    expect(() => word(2n ** 256n)).toThrow(/exceeds/);
  });
});

describe('bytes32', () => {
  it('left-pads a short value into a 32-byte word', () => {
    expect(bytes32('0xab')).toHaveLength(32);
  });

  it('refuses a value wider than 32 bytes', () => {
    expect(() => bytes32(`0x${'ab'.repeat(33)}`)).toThrow(/exceeds/);
  });

  it('refuses an odd-length hex value', () => {
    expect(() => bytes32('0xabc')).toThrow(/odd-length/);
  });
});

describe('call encoders', () => {
  const ref = `0x${'11'.repeat(32)}`;
  const home = `0x${'ab'.repeat(32)}`;

  it('encodes returnRefund with the selector, head and bytes tail', () => {
    const data = encodeReturnRefund(ref, 100n, '0x');
    // 4-byte selector, then ref, amount, offset, length words.
    expect(data.startsWith('0x')).toBe(true);
    expect((data.length - 2) / 2).toBe(4 + 32 * 4);
  });

  it('encodes resolveUnknown the same shape as returnRefund', () => {
    const data = encodeResolveUnknown(home, 100n, '0x');
    expect((data.length - 2) / 2).toBe(4 + 32 * 4);
  });

  it('encodes returnHeld with a bytes tail at offset 64', () => {
    const data = encodeReturnHeld(ref, '0x');
    expect((data.length - 2) / 2).toBe(4 + 32 * 3);
  });

  it('encodes withdrawDust as selector plus one word', () => {
    const data = encodeWithdrawDust(100n);
    expect((data.length - 2) / 2).toBe(4 + 32);
  });

  it('encodes a no-argument getter as the bare selector', () => {
    expect((encodeGetter('dust()').length - 2) / 2).toBe(4);
  });

  it('encodes sales as selector plus the ref word', () => {
    expect((encodeSales(ref).length - 2) / 2).toBe(4 + 32);
  });

  it('carries a non-empty bytes tail padded to a 32-byte boundary', () => {
    const data = encodeReturnHeld(ref, '0xabcd');
    // selector + ref + offset + length + one padded data word.
    expect((data.length - 2) / 2).toBe(4 + 32 * 4);
  });
});

describe('decoders', () => {
  it('decodes a single uint, and reads an empty return as zero', () => {
    expect(decodeUint(`0x${uintWord(500n)}`)).toBe(500n);
    expect(decodeUint('0x')).toBe(0n);
  });

  it('decodes the five-word sales tuple', () => {
    const recipient = '00000000000000000000000081949127042930f8e7a1723385a2f76213c72ee9';
    const home = 'ab'.repeat(32);
    const hex = `0x${recipient}${uintWord(100n)}${home}${uintWord(7n)}${uintWord(2n)}`;
    const sale = decodeSale(hex);
    expect(sale.recipient.toLowerCase()).toBe('0x81949127042930f8e7a1723385a2f76213c72ee9');
    expect(sale.amount).toBe(100n);
    expect(sale.home).toBe(`0x${home}`);
    expect(sale.held).toBe(7n);
    expect(sale.status).toBe(2);
  });
});
