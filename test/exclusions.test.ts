import { describe, expect, it } from 'vitest';

import { isExcluded, withoutExcluded, type ProviderExclusion, type ProviderOffer } from '../src/exclusions.js';
import type { SupportedCorridorRow } from '../src/funding/store.js';

const OFFER: ProviderOffer = { provider: 'BANXA', direction: 'buy', code: 'USDT_DOT', paymentMethodType: 'SEPA', country: 'DE' };

describe('isExcluded', () => {
  it('matches a rule naming only the provider on anything it offers', () => {
    expect(isExcluded([{ provider: 'BANXA', reason: 'r' }], OFFER)).toBe(true);
  });

  it.each<[string, Partial<ProviderOffer>]>([
    ['provider', { provider: 'MERCURYO' }],
    ['asset', { code: 'DOT' }],
    ['payment method', { paymentMethodType: 'IDEAL' }],
    ['direction', { direction: 'sell' }],
    ['country', { country: 'FR' }],
  ])('lets an offer through when its %s is outside the rule', (_, change) => {
    const rule: ProviderExclusion = {
      provider: 'BANXA',
      codes: ['USDT_DOT'],
      payment_methods: ['SEPA'],
      directions: ['buy'],
      countries: ['DE'],
      reason: 'r',
    };
    expect(isExcluded([rule], OFFER)).toBe(true);
    expect(isExcluded([rule], { ...OFFER, ...change })).toBe(false);
  });
});

describe('withoutExcluded', () => {
  const row: SupportedCorridorRow = {
    destination_currency_code: 'DOT',
    direction: 'buy',
    country: 'DE',
    name: 'Germany',
    fiat: 'EUR',
    methods: [
      { paymentMethodType: 'CREDIT_DEBIT_CARD', category: 'card', currency: 'EUR', min: '10', max: '15000' },
      { paymentMethodType: 'SEPA', category: 'bank', currency: 'EUR', min: '10', max: '30000' },
      { paymentMethodType: 'IDEAL', category: 'bank', currency: 'EUR', min: '15', max: '500' },
    ],
    method_providers: [
      {
        paymentMethodType: 'CREDIT_DEBIT_CARD',
        providers: [
          { provider: 'BANXA', min: '10', max: '15000' },
          { provider: 'MERCURYO', min: '30', max: '2000' },
        ],
      },
      { paymentMethodType: 'SEPA', providers: [{ provider: 'BANXA', min: '10', max: '30000' }] },
      { paymentMethodType: 'IDEAL', providers: [{ provider: 'MERCURYO', min: '15', max: '500' }] },
    ],
    updated_at: 0,
  };

  it('narrows a method to the providers left, drops one left with none and keeps an untouched one as stored', () => {
    expect(withoutExcluded(row, [{ provider: 'BANXA', reason: 'r' }])).toEqual({
      ...row,
      methods: [
        { paymentMethodType: 'CREDIT_DEBIT_CARD', category: 'card', currency: 'EUR', min: '30', max: '2000' },
        { paymentMethodType: 'IDEAL', category: 'bank', currency: 'EUR', min: '15', max: '500' },
      ],
      method_providers: [
        { paymentMethodType: 'CREDIT_DEBIT_CARD', providers: [{ provider: 'MERCURYO', min: '30', max: '2000' }] },
        { paymentMethodType: 'IDEAL', providers: [{ provider: 'MERCURYO', min: '15', max: '500' }] },
      ],
    });
  });

  it('returns the row as stored when no rule applies or it has no providers to match', () => {
    expect(withoutExcluded(row, [])).toBe(row);
    const unrostered = (({ method_providers: _roster, ...rest }: SupportedCorridorRow): SupportedCorridorRow => rest)(row);
    expect(withoutExcluded(unrostered, [{ provider: 'BANXA', reason: 'r' }])).toBe(unrostered);
  });
});
