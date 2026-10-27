import { encodeAddress } from '@polkadot/util-crypto';
import { describe, expect, it } from 'vitest';

import { checksum, homeOf, predictSaleVaultProxy } from '../../src/salevaultproxy/derive.js';

const FACTORY = '0x1111111111111111111111111111111111111111';
const IMPL = '0x2222222222222222222222222222222222222222';
const ALICE_HOME = '0xd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d';

const CLAIMER = '0x3333333333333333333333333333333333333333';

describe('predictSaleVaultProxy', () => {
  it('matches the contract test suite pinned vectors for home then claimer', () => {
    expect(checksum(predictSaleVaultProxy(FACTORY, IMPL, `0x${'ab'.repeat(32)}`, CLAIMER))).toBe('0xcc7d876cC298b0e30157D6c2656FBC6Fc66deeC7');
    expect(checksum(predictSaleVaultProxy(FACTORY, IMPL, ALICE_HOME, CLAIMER))).toBe('0xB7967f92Fd611b5fF68b6A043DAf49034Cad476B');
  });

  it('matches the address a deployed factory.predict returned in the contract vectors', () => {
    const factory = '0xC140bBe06848EeA22BACc5f02D4D1A69767d33c5';
    const implementation = '0xc3813cd0fC2e34A56dd030c6e9362AA7D1428344';
    const home = '0x0a528ed24585e375c843bdbaa82a92ea3320936295ba3eacac9bc93acce2a575';
    const claimer = '0x90D121876b4f93DA56F039139fdF37a96cde00c3';
    expect(checksum(predictSaleVaultProxy(factory, implementation, home, claimer))).toBe('0xad46C51Afe8817c4127D08f6Ff78dEF7E6fb83a9');
  });

  it('gives each claimer its own address for one home', () => {
    const other = '0x4444444444444444444444444444444444444444';
    expect(predictSaleVaultProxy(FACTORY, IMPL, ALICE_HOME, other)).not.toBe(predictSaleVaultProxy(FACTORY, IMPL, ALICE_HOME, CLAIMER));
  });

  it('ignores input casing', () => {
    expect(
      predictSaleVaultProxy(FACTORY.toUpperCase().replace('0X', '0x'), IMPL, ALICE_HOME.toUpperCase().replace('0X', '0x'), CLAIMER.toUpperCase().replace('0X', '0x')),
    ).toBe('0xb7967f92fd611b5ff68b6a043daf49034cad476b');
  });

  it('refuses a short home, a bad address or a zero claimer', () => {
    expect(() => predictSaleVaultProxy(FACTORY, IMPL, '0xabcd', CLAIMER)).toThrow(/32 bytes/);
    expect(() => predictSaleVaultProxy('0x12', IMPL, ALICE_HOME, CLAIMER)).toThrow(/factory/);
    expect(() => predictSaleVaultProxy(FACTORY, 'nope', ALICE_HOME, CLAIMER)).toThrow(/implementation/);
    expect(() => predictSaleVaultProxy(FACTORY, IMPL, ALICE_HOME, '0x12')).toThrow(/claimer/);
    expect(() => predictSaleVaultProxy(FACTORY, IMPL, ALICE_HOME, `0x${'0'.repeat(40)}`)).toThrow(/zero address/);
  });
});

describe('checksum', () => {
  it('writes EIP-55 casing', () => {
    expect(checksum('0xfb63126b916e3bd2497702a0139ad2b344ac7536')).toBe('0xfb63126B916e3bD2497702a0139AD2B344aC7536');
    expect(checksum('0x5a8b0082b72d54cef53705de15fe844ff9027dfd')).toBe('0x5a8b0082B72D54cef53705de15FE844ff9027dFD');
  });

  it('refuses anything but 20 bytes', () => {
    expect(() => checksum(ALICE_HOME)).toThrow(/not an address/);
  });
});

describe('homeOf', () => {
  it('gives the same home for prefix 0 and prefix 42', () => {
    const key = Uint8Array.from(Buffer.from(ALICE_HOME.slice(2), 'hex'));
    expect(homeOf(encodeAddress(key, 0))).toBe(ALICE_HOME);
    expect(homeOf(encodeAddress(key, 42))).toBe(ALICE_HOME);
  });

  it('refuses a 20-byte EVM account', () => {
    expect(() => homeOf(FACTORY)).toThrow(/20 bytes/);
  });
});
