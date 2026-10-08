import { describe, expect, it } from 'vitest';

import { mergeMethods, mergeOfframpCorridors, type LaneCorridor, type OfframpLane } from '../src/offramp.js';
import { refreshJobs } from '../src/startup.js';

const DOT: OfframpLane = { code: 'DOT_ASSETHUB', chain: 'assethub' };
const SOL: OfframpLane = { code: 'USDT_SOL', chain: 'solana' };

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

describe('mergeMethods', () => {
  it('takes each method from the first lane that has it, with that lane tag and its own limits', () => {
    const merged = mergeMethods([
      row(DOT, 'DE', [m('SEPA', { min: '5' })]),
      row(SOL, 'DE', [m('SEPA', { min: '9', currency: 'USD' }), m('CARD', { category: 'card' as const })]),
    ]);
    expect(merged).toEqual([
      { ...m('SEPA', { min: '5' }), lane: DOT },
      { ...m('CARD', { category: 'card' }), lane: SOL },
    ]);
  });

  it('drops provider rosters and extra fields, and copies the lane', () => {
    const [only] = mergeMethods([row(DOT, 'DE', [{ ...m('SEPA'), providers: ['X'] } as never])]);
    expect(only).not.toHaveProperty('providers');
    expect(only?.lane).not.toBe(DOT);
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
    expect(fr?.methods.map((x) => [x.paymentMethodType, x.lane.code])).toEqual([
      ['SEPA', 'DOT_ASSETHUB'],
      ['CARD', 'USDT_SOL'],
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
    const jobs = refreshJobs([{ code: 'DOT_ASSETHUB' }, { code: 'USDT_SOL' }, { code: 'USDT_SOL' }]);
    expect(jobs).toEqual([
      { crypto: 'DOT_ASSETHUB', direction: 'buy' },
      { crypto: 'DOT_ASSETHUB', direction: 'sell' },
      { crypto: 'USDT_SOL', direction: 'sell' },
    ]);
  });

  it('still refreshes DOT when it is not a configured lane', () => {
    expect(refreshJobs([{ code: 'USDT_SOL' }]).map((j) => `${j.crypto}|${j.direction}`)).toEqual([
      'DOT_ASSETHUB|buy',
      'DOT_ASSETHUB|sell',
      'USDT_SOL|sell',
    ]);
  });
});
