import { afterEach, describe, expect, it } from 'vitest';

import { Refusal } from '../../src/contract.js';
import {
  ASSET_IDS,
  ASSETS,
  AssetCatalog,
  activeCatalog,
  chainOf,
  installCatalog,
  isAssetId,
  isKnownCrypto,
  isOfframpOnly,
  isSellable,
  resolveDestination,
  resolveForDirection,
  resolveSellCode,
} from '../../src/meld/catalog.js';
import { TEST_ASSETS } from '../fixtures.js';

const SELL_ONLY = ['USDT_SOLANA', 'USDC_SOLANA', 'USDC_ARBITRUM'];

describe('assets', () => {
  it('knows exactly the three Asset Hub assets a buyer can receive', () => {
    // Meld's catalog carries hundreds of codes; three settle on Polkadot Asset Hub. This test is
    // the gate on a fourth: adding an asset is a deliberate code change, naming one is config.
    expect(ASSET_IDS.filter((id) => ASSETS[id].deliverable)).toEqual(['dot@assethub', 'usdt@assethub', 'usdc@assethub']);
    expect(ASSET_IDS.filter((id) => !ASSETS[id].deliverable)).toEqual(['usdt@solana', 'usdc@solana', 'usdc@arbitrum']);
  });

  it('is frozen, so a caller cannot extend the known set at runtime', () => {
    expect(Object.isFrozen(ASSETS)).toBe(true);
    expect(Object.isFrozen(ASSETS['dot@assethub'])).toBe(true);
    expect(Object.isFrozen(ASSET_IDS)).toBe(true);
  });

  it('tells an asset id from anything else, including a Meld code', () => {
    expect(isAssetId('dot@assethub')).toBe(true);
    expect(isAssetId('DOT')).toBe(false);
    expect(isAssetId('toString')).toBe(false);
  });
});

describe('AssetCatalog', () => {
  it('resolves a configured code to its asset and chain, and serves nothing unnamed', () => {
    const catalog = new AssetCatalog({ 'dot@assethub': 'DOT', 'usdc@arbitrum': 'USDC_ARBITRUM' });
    expect(catalog.find('DOT')).toEqual({ asset: 'dot@assethub', code: 'DOT', chain: 'assethub', deliverable: true });
    expect(catalog.find('USDT_DOT')).toBeUndefined();
    expect(catalog.all().map((d) => d.code)).toEqual(['DOT', 'USDC_ARBITRUM']);
  });

  it('follows a rename: the old code stops resolving and the new one takes its place', () => {
    const before = new AssetCatalog({ 'dot@assethub': 'DOT_ASSETHUB' });
    const after = new AssetCatalog({ 'dot@assethub': 'DOT' });
    expect(before.find('DOT_ASSETHUB')?.asset).toBe('dot@assethub');
    expect(after.find('DOT_ASSETHUB')).toBeUndefined();
    expect(after.find('DOT')?.asset).toBe('dot@assethub');
  });

  it('refuses two assets under one code, which config validation also refuses', () => {
    expect(() => new AssetCatalog({ 'dot@assethub': 'DOT', 'usdt@assethub': 'DOT' })).toThrow(/share one Meld code/);
  });
});

describe('the installed catalog', () => {
  afterEach(() => {
    installCatalog(new AssetCatalog(TEST_ASSETS));
  });

  it('is what every lookup reads', () => {
    installCatalog(new AssetCatalog({ 'dot@assethub': 'DOT_RENAMED' }));
    expect(resolveDestination('DOT_RENAMED').asset).toBe('dot@assethub');
    expect(() => resolveDestination('DOT')).toThrow(Refusal);
  });

  it('throws when nothing installed one, naming the wiring fault', async () => {
    // A fresh module instance, so the installed one in this file is not disturbed.
    const { vi } = await import('vitest');
    vi.resetModules();
    const fresh = await import('../../src/meld/catalog.js');
    expect(() => fresh.activeCatalog()).toThrow(/No asset catalog installed/);
    expect(() => fresh.isSellable('DOT')).toThrow(/No asset catalog installed/);
    expect(activeCatalog().find('DOT')).toBeDefined();
  });
});

describe('delivered codes', () => {
  it('resolves a configured code to the asset that carries it', () => {
    expect(resolveDestination('USDC_DOT')).toMatchObject({ asset: 'usdc@assethub', code: 'USDC_DOT' });
    expect(resolveDestination('DOT')).toMatchObject({ asset: 'dot@assethub', code: 'DOT', chain: 'assethub' });
  });

  it('refuses an unknown code rather than forwarding it', () => {
    // The reason this guard exists: Meld has resolved an unrecognised code to Bitcoin. Because
    // `destinationCurrencyCode` is locked (via lockFields) the buyer is then locked into buying
    // BTC. An unvalidated code is the wrong purchase, not a 404.
    expect(() => resolveDestination('NOT_A_REAL_ASSET_XYZ')).toThrow(Refusal);
    expect(() => resolveDestination('NOT_A_REAL_ASSET_XYZ')).toThrow(/Unknown destination code/);
  });

  it('refuses the codes Meld retired, once the config names the new ones', () => {
    for (const code of ['DOT_ASSETHUB', 'DOT_STATEMINT', 'USDT_ASSETHUB', 'USDT_STATEMINT', 'DOT_BSC']) {
      expect(() => resolveDestination(code)).toThrow(Refusal);
      expect(() => resolveSellCode(code)).toThrow(Refusal);
    }
  });
});

describe('sell-only codes', () => {
  it('are never valid for a buy, and are valid for a sell', () => {
    for (const code of SELL_ONLY) {
      expect(() => resolveDestination(code)).toThrow(Refusal);
      expect(() => resolveForDirection(code, 'buy')).toThrow(Refusal);
      expect(resolveForDirection(code, 'sell').code).toBe(code);
      expect(resolveSellCode(code).code).toBe(code);
      expect(isOfframpOnly(code)).toBe(true);
      expect(isSellable(code)).toBe(true);
      expect(isKnownCrypto(code)).toBe(true);
    }
  });

  it('keeps the sell resolver closed to anything else, and delivered codes sellable', () => {
    expect(() => resolveSellCode('BTC')).toThrow(Refusal);
    expect(() => resolveForDirection('USDT_SOL_X', 'sell')).toThrow(Refusal);
    expect(isSellable('BTC')).toBe(false);
    expect(isSellable('USDC_ETHEREUM')).toBe(false);
    expect(isOfframpOnly('DOT')).toBe(false);
    expect(isOfframpOnly('BTC')).toBe(false);
    expect(resolveForDirection('DOT', 'sell').code).toBe('DOT');
    expect(isKnownCrypto('BTC')).toBe(false);
  });
});

describe('chainOf', () => {
  it('reads the chain from the asset a code names, and is undefined for an unnamed code', () => {
    expect(chainOf('DOT')).toBe('assethub');
    expect(chainOf('USDT_DOT')).toBe('assethub');
    expect(chainOf('USDC_SOLANA')).toBe('solana');
    expect(chainOf('USDC_ARBITRUM')).toBe('arbitrum');
    expect(chainOf('BTC')).toBeUndefined();
  });
});
