import { describe, expect, it } from 'vitest';

import type { ProviderHealthRow, SupportedCorridorRow } from '../../src/funding/store.js';
import { healthView, NO_HEALTH, storedMethods } from '../../src/health/view.js';

const NOW = 10_000_000;
const STALE = 1_800_000;

const down = (over: Partial<ProviderHealthRow> = {}): ProviderHealthRow => ({
  provider: 'BANXA',
  direction: 'buy',
  scope: 'global',
  state: 'down',
  failures: 2,
  last_ok_at: null,
  last_failed_at: NOW,
  last_code: 'INCOMPATIBLE_REQUEST',
  last_request_id: null,
  updated_at: NOW,
  ...over,
});

const card = { paymentMethodType: 'CREDIT_DEBIT_CARD', category: 'card' as const, min: '5', max: '15000', currency: 'USD' };
const providers = [
  { provider: 'BANXA', min: '20', max: '15000' },
  { provider: 'TRANSAK', min: '5', max: '3000' },
];

describe('healthView', () => {
  it('serves a method unchanged while none of its providers is down', () => {
    expect(NO_HEALTH.apply(card, providers, 'buy', 'US')).toEqual({ ...card, availability: 'available' });
  });

  it('bounds a method by the providers that are not down', () => {
    expect(healthView([down()], NOW, STALE).apply(card, providers, 'buy', 'US')).toEqual({
      ...card,
      min: '5',
      max: '3000',
      availability: 'available',
    });
  });

  it('keeps the bound and flags the method when every provider is down', () => {
    const view = healthView([down(), down({ provider: 'TRANSAK' })], NOW, STALE);
    expect(view.apply(card, providers, 'buy', 'US')).toEqual({ ...card, availability: 'temporarily_unavailable' });
  });

  it('applies a country-scoped outage to that country only', () => {
    const view = healthView([down({ scope: 'DE' })], NOW, STALE);
    expect(view.apply(card, providers, 'buy', 'DE')).toMatchObject({ max: '3000' });
    expect(view.apply(card, providers, 'buy', 'US')).toMatchObject({ max: '15000' });
  });

  it('applies an outage to its own direction only', () => {
    expect(healthView([down({ direction: 'sell' })], NOW, STALE).apply(card, providers, 'buy', 'US')).toMatchObject({ max: '15000' });
  });

  it('ignores a down state older than the stale window', () => {
    const view = healthView([down({ updated_at: NOW - STALE - 1 })], NOW, STALE);
    expect(view.apply(card, providers, 'buy', 'US')).toMatchObject({ max: '15000', availability: 'available' });
  });

  it('serves a method without stored providers as it is', () => {
    expect(healthView([down()], NOW, STALE).apply(card, undefined, 'buy', 'US')).toEqual({ ...card, availability: 'available' });
  });
});

describe('storedMethods', () => {
  it('joins each stored method to its providers by method id', () => {
    const row: SupportedCorridorRow = {
      destination_currency_code: 'DOT',
      direction: 'buy',
      country: 'US',
      name: 'United States',
      fiat: 'USD',
      methods: [card, { ...card, paymentMethodType: 'ACH', category: 'bank', min: '10', max: '500' }],
      method_providers: [{ paymentMethodType: 'CREDIT_DEBIT_CARD', providers }],
      updated_at: NOW,
    };
    expect(storedMethods(healthView([down()], NOW, STALE), row).map(({ paymentMethodType, max }) => [paymentMethodType, max])).toEqual([
      ['CREDIT_DEBIT_CARD', '3000'],
      ['ACH', '500'],
    ]);
  });
});
