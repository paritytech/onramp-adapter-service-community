import { describe, expect, it } from 'vitest';

import { Refusal } from '../../src/contract.js';
import {
  DESTINATIONS,
  isDeliveredCrypto,
  isOfframpOnly,
  isSellable,
  OFFRAMP_ONLY,
  resolveDestination,
  resolveForDirection,
  resolveSellCode,
} from '../../src/meld/catalog.js';

describe('catalog', () => {
  it('offers exactly the three Asset Hub destinations Meld can deliver', () => {
    // Meld's catalog carries 952 codes; three settle on Polkadot Asset Hub. This test is
    // the gate on a fourth: adding one should be a deliberate change, not a config edit.
    expect(DESTINATIONS.map((d) => d.code)).toEqual([
      'USDC_ASSETHUB',
      'USDT_ASSETHUB',
      'DOT_ASSETHUB',
    ]);
  });

  it('resolves a known code to the entry that carries it', () => {
    // Asserted on `code` alone, because that is the only member anything reads. This test used
    // to assert `symbol` and `decimals` (data no production line touched), which is how they
    // survived unnoticed until mutation testing pointed at them.
    expect(resolveDestination('USDC_ASSETHUB')).toEqual({ code: 'USDC_ASSETHUB' });
    expect(resolveDestination('DOT_ASSETHUB')).toEqual({ code: 'DOT_ASSETHUB' });
  });

  it('refuses an unknown code rather than forwarding it', () => {
    // The reason this guard exists: Meld does not reject an unrecognised code; it resolves
    // it to Bitcoin. Because `destinationCurrencyCode` is locked (via lockFields) the buyer
    // is then locked into buying BTC. An unvalidated code is the wrong purchase, not a 404.
    expect(() => resolveDestination('NOT_A_REAL_ASSET_XYZ')).toThrow(Refusal);
    expect(() => resolveDestination('NOT_A_REAL_ASSET_XYZ')).toThrow(/Unknown destination code/);
  });

  it('refuses DOT, which is a different chain from DOT_ASSETHUB', () => {
    // DOT, DOT_STATEMINT and DOT_BSC all exist in Meld's catalog and settle elsewhere.
    // This is WrongAssetOrChain waiting to happen if the code is taken on trust.
    for (const code of ['DOT', 'DOT_STATEMINT', 'DOT_BSC']) {
      expect(() => resolveDestination(code)).toThrow(Refusal);
    }
  });

  it('is frozen, so a caller cannot extend the accepted set at runtime', () => {
    expect(Object.isFrozen(DESTINATIONS)).toBe(true);
    expect(Object.isFrozen(DESTINATIONS[0])).toBe(true);
  });
});

describe('sell-only codes', () => {
  it('lists exactly the sell-only codes, frozen', () => {
    expect(OFFRAMP_ONLY.map((d) => d.code)).toEqual(['USDT_SOLANA', 'USDC_SOLANA', 'USDC_ARBITRUM']);
    expect(Object.isFrozen(OFFRAMP_ONLY)).toBe(true);
  });

  it('are never valid for a buy, and are valid for a sell', () => {
    for (const code of ['USDT_SOLANA', 'USDC_SOLANA', 'USDC_ARBITRUM']) {
      expect(() => resolveDestination(code)).toThrow(Refusal);
      expect(() => resolveForDirection(code, 'buy')).toThrow(Refusal);
      expect(resolveForDirection(code, 'sell')).toEqual({ code });
      expect(resolveSellCode(code)).toEqual({ code });
      expect(isOfframpOnly(code)).toBe(true);
      expect(isSellable(code)).toBe(true);
      expect(isDeliveredCrypto(code)).toBe(true);
    }
  });

  it('keeps the sell resolver closed to anything else, and delivered codes sellable', () => {
    expect(() => resolveSellCode('BTC')).toThrow(Refusal);
    expect(() => resolveForDirection('USDT_SOL_X', 'sell')).toThrow(Refusal);
    expect(isSellable('BTC')).toBe(false);
    expect(isSellable('USDC_ETHEREUM')).toBe(false);
    expect(isOfframpOnly('DOT_ASSETHUB')).toBe(false);
    expect(resolveForDirection('DOT_ASSETHUB', 'sell')).toEqual({ code: 'DOT_ASSETHUB' });
    expect(isDeliveredCrypto('BTC')).toBe(false);
  });
});
