import { describe, expect, it } from 'vitest';

import { mergeMethods, mergeOfframpCorridors, type LaneCorridor, type OfframpLane } from '../src/offramp.js';
import { refreshJobs } from '../src/startup.js';

const DOT: OfframpLane = { code: 'DOT_ASSETHUB', chain: 'assethub' };
const SOL: OfframpLane = { code: 'USDT_SOLANA', chain: 'solana' };
const ARB: OfframpLane = { code: 'USDC_ARBITRUM', chain: 'arbitrum' };

const m = (paymentMethodType: string, over: Record<string, unknown> = {}) => ({
  paymentMethodType,
  category: 'bank' as const,
  min: '1',
  max: '100',
  currency: 'EUR',
  ...over,
});

const row = (lane: OfframpLane, country: string, methods: ReturnType<typeof m>[], over: Partial<LaneCorridor> = {}): LaneCorridor => ({
  lane,
  country,
  name: country,
  fiat: 'EUR',
  methods,
  ...over,
});

const offer = (lane: OfframpLane, min: string, max: string, currency = 'EUR') => ({ ...lane, min, max, currency });

describe('mergeMethods', () => {
  it('lists every lane per method in lane order, with its own limits, and spans min and max', () => {
    const merged = mergeMethods([
      row(DOT, 'DE', [m('SEPA', { min: '5', max: '100' })]),
      row(SOL, 'DE', [m('SEPA', { min: '9', max: '250' }), m('CARD', { category: 'card' as const })]),
      row(ARB, 'DE', [m('SEPA', { min: '2', max: '90' })]),
    ]);
    expect(merged).toEqual([
      {
        paymentMethodType: 'SEPA',
        category: 'bank',
        min: '2',
        max: '250',
        currency: 'EUR',
        lanes: [offer(DOT, '5', '100'), offer(SOL, '9', '250'), offer(ARB, '2', '90')],
      },
      {
        paymentMethodType: 'CARD',
        category: 'card',
        min: '1',
        max: '100',
        currency: 'EUR',
        lanes: [offer(SOL, '1', '100')],
      },
    ]);
  });

  it('orders methods by first sight across lanes in lane order', () => {
    const merged = mergeMethods([row(DOT, 'DE', [m('B')]), row(SOL, 'DE', [m('A'), m('B')])]);
    expect(merged.map((x) => x.paymentMethodType)).toEqual(['B', 'A']);
  });

  it('compares decimals exactly, not as floats', () => {
    const merged = mergeMethods([
      row(DOT, 'DE', [m('X', { min: '0.30000000000000004', max: '9007199254740993' })]),
      row(SOL, 'DE', [m('X', { min: '0.3', max: '9007199254740992.5' })]),
      row(ARB, 'DE', [m('X', { min: '0.30', max: '9007199254740992.50' })]),
    ]);
    expect(merged[0]?.min).toBe('0.3');
    expect(merged[0]?.max).toBe('9007199254740993');
  });

  it('keeps the first text on an exact tie and sets currency to the country fiat when given', () => {
    const [x] = mergeMethods([row(DOT, 'DE', [m('X', { min: '1.0', currency: 'USD' })]), row(SOL, 'DE', [m('X', { min: '1.00' })])], 'EUR');
    expect(x?.min).toBe('1.0');
    expect(x?.currency).toBe('EUR');
    expect(x?.lanes.map((l) => l.currency)).toEqual(['USD', 'EUR']);
  });

  it('drops provider rosters and extra fields, and copies the lane', () => {
    const [only] = mergeMethods([row(DOT, 'DE', [{ ...m('SEPA'), providers: ['X'] } as never])]);
    expect(only).not.toHaveProperty('providers');
    expect(only?.lanes[0]).toEqual(offer(DOT, '1', '100'));
  });

  it('is empty when nothing routes', () => {
    expect(mergeMethods([])).toEqual([]);
    expect(mergeMethods([row(DOT, 'DE', [])])).toEqual([]);
  });
});

describe('mergeOfframpCorridors', () => {
  it('unions countries, takes name and fiat from the first lane row, and orders by name then country', () => {
    const out = mergeOfframpCorridors([
      row(DOT, 'FR', [m('SEPA')], { name: 'France' }),
      row(DOT, 'DE', [m('SEPA')], { name: 'Germany' }),
      row(SOL, 'FR', [m('CARD')], { name: 'Frankreich', fiat: 'USD' }),
      row(SOL, 'BR', [m('PIX', { currency: 'BRL' })], { name: 'Brazil', fiat: 'BRL' }),
    ]);
    expect(out.map((c) => c.country)).toEqual(['BR', 'FR', 'DE']);
    const fr = out[1];
    expect(fr?.name).toBe('France');
    expect(fr?.fiat).toBe('EUR');
    expect(fr?.methods.map((x) => [x.paymentMethodType, x.lanes.map((l) => l.code)])).toEqual([
      ['SEPA', ['DOT_ASSETHUB']],
      ['CARD', ['USDT_SOLANA']],
    ]);
  });

  it('breaks a name tie on country and falls back to the country when no name is given', () => {
    const out = mergeOfframpCorridors([
      row(DOT, 'B2', [], { name: 'Same' }),
      row(DOT, 'A1', [], { name: 'Same' }),
      { lane: DOT, country: 'ZZ', fiat: 'EUR', methods: [] },
    ]);
    expect(out.map((c) => c.country)).toEqual(['A1', 'B2', 'ZZ']);
    expect(out[2]?.name).toBe('ZZ');
  });
});

describe('refreshJobs', () => {
  it('keeps DOT buy and sell, and adds a sell job per lane without duplicating', () => {
    const jobs = refreshJobs([{ code: 'DOT_ASSETHUB' }, { code: 'USDT_SOLANA' }, { code: 'USDT_SOLANA' }]);
    expect(jobs).toEqual([
      { crypto: 'DOT_ASSETHUB', direction: 'buy' },
      { crypto: 'DOT_ASSETHUB', direction: 'sell' },
      { crypto: 'USDT_SOLANA', direction: 'sell' },
    ]);
  });

  it('still refreshes DOT when it is not a configured lane', () => {
    expect(refreshJobs([{ code: 'USDT_SOLANA' }]).map((j) => `${j.crypto}|${j.direction}`)).toEqual([
      'DOT_ASSETHUB|buy',
      'DOT_ASSETHUB|sell',
      'USDT_SOLANA|sell',
    ]);
  });
});
