import { describe, expect, it } from 'vitest';

import type { StoredMethod, SupportedCorridorRow } from '../../src/funding/store.js';
import { countryTarget, probeGroups, type TargetOptions } from '../../src/health/targets.js';
import type { ProviderLimit } from '../../src/meld/discovery.js';
import type { Direction } from '../../src/rail.js';

const OPTIONS: TargetOptions = { sellAmounts: new Map([['DOT', '10']]) };

const first = () => 0;

const card = (paymentMethodType = 'CREDIT_DEBIT_CARD'): StoredMethod => ({
  paymentMethodType,
  category: 'card',
  min: '0',
  max: '0',
  currency: 'X',
});

const row = (
  country: string,
  fiat: string,
  providers: Record<string, ProviderLimit[]>,
  over: { direction?: Direction; crypto?: string; methods?: StoredMethod[] } = {},
): SupportedCorridorRow => ({
  destination_currency_code: over.crypto ?? 'DOT',
  direction: over.direction ?? 'buy',
  country,
  name: country,
  fiat,
  methods: over.methods ?? Object.keys(providers).map((type) => card(type)),
  method_providers: Object.entries(providers).map(([paymentMethodType, list]) => ({ paymentMethodType, providers: list })),
  updated_at: 0,
});

const bank = (paymentMethodType: string): StoredMethod => ({ ...card(paymentMethodType), category: 'bank' });

const banxa = (min = '20', max = '15000'): ProviderLimit => ({ provider: 'BANXA', min, max });
const transak = (min = '5', max = '3000'): ProviderLimit => ({ provider: 'TRANSAK', min, max });

const where = (groups: ReturnType<typeof probeGroups>, provider: string, direction: Direction = 'buy') =>
  groups.find((g) => g.provider === provider && g.direction === direction)?.targets.map((t) => `${t.country}/${t.fiat}`);

describe('probeGroups', () => {
  it('probes each provider in two of its own countries, picked at random with different fiat currencies', () => {
    const rows = [
      row('DE', 'EUR', { CREDIT_DEBIT_CARD: [banxa()] }),
      row('GB', 'GBP', { CREDIT_DEBIT_CARD: [banxa(), transak()] }),
      row('US', 'USD', { CREDIT_DEBIT_CARD: [banxa(), transak()] }),
    ];
    const low = probeGroups(rows, OPTIONS, first);
    expect(where(low, 'BANXA')).toEqual(['DE/EUR', 'GB/GBP']);
    expect(where(low, 'TRANSAK')).toEqual(['GB/GBP', 'US/USD']);
    const high = probeGroups(rows, OPTIONS, () => 0.9);
    expect(where(high, 'BANXA')).toEqual(['US/USD', 'GB/GBP']);
    expect(where(high, 'TRANSAK')).toEqual(['US/USD', 'GB/GBP']);
  });

  it('weighs each country once, however many methods it lists', () => {
    const many = { CREDIT_DEBIT_CARD: [banxa()], APPLE_PAY: [banxa()], SEPA: [banxa()] };
    const groups = probeGroups([row('DE', 'EUR', { CREDIT_DEBIT_CARD: [banxa()] }), row('US', 'USD', many)], OPTIONS, () => 0.4);
    expect(where(groups, 'BANXA')).toEqual(['DE/EUR', 'US/USD']);
  });

  it('never probes two countries that share a fiat, so one region cannot decide alone', () => {
    const groups = probeGroups([row('DE', 'EUR', { CREDIT_DEBIT_CARD: [banxa()] }), row('FR', 'EUR', { CREDIT_DEBIT_CARD: [banxa()] })], OPTIONS, first);
    expect(where(groups, 'BANXA')).toEqual(['DE/EUR']);
  });

  it('pays twice the provider minimum on a buy, or the minimum when twice passes the maximum', () => {
    const groups = probeGroups([row('US', 'USD', { CREDIT_DEBIT_CARD: [banxa('20.50'), transak('60', '100')] })], OPTIONS, first);
    const amount = (provider: string) => groups.find((g) => g.provider === provider)?.targets[0].amount;
    expect(amount('BANXA')).toBe('41.00');
    expect(amount('TRANSAK')).toBe('60');
  });

  it('probes each method category apart, in the countries that list the provider for it', () => {
    const groups = probeGroups(
      [
        row('US', 'USD', { ACH: [banxa()], CREDIT_DEBIT_CARD: [banxa()] }, { methods: [bank('ACH'), card()] }),
        row('GB', 'GBP', { CREDIT_DEBIT_CARD: [banxa()] }),
      ],
      OPTIONS,
      first,
    );
    expect(groups.map((g) => [g.category, g.targets.map((t) => `${t.country}/${t.paymentMethodType}`)])).toEqual([
      ['card', ['GB/CREDIT_DEBIT_CARD', 'US/CREDIT_DEBIT_CARD']],
      ['bank', ['US/ACH']],
    ]);
  });

  it('sells the configured crypto amount, and skips a sell crypto with none configured', () => {
    const groups = probeGroups(
      [
        row('GB', 'GBP', { PAYOUT_TO_BANK: [transak()] }, { direction: 'sell', methods: [bank('PAYOUT_TO_BANK')] }),
        row('US', 'USD', { PAYOUT_TO_BANK: [transak()] }, { direction: 'sell', crypto: 'USDC_SOLANA', methods: [bank('PAYOUT_TO_BANK')] }),
      ],
      OPTIONS,
      first,
    );
    expect(groups).toEqual([
      {
        provider: 'TRANSAK',
        direction: 'sell',
        category: 'bank',
        targets: [
          {
            provider: 'TRANSAK',
            direction: 'sell',
            category: 'bank',
            country: 'GB',
            fiat: 'GBP',
            crypto: 'DOT',
            paymentMethodType: 'PAYOUT_TO_BANK',
            amount: '10',
          },
        ],
      },
    ]);
  });

  it('picks a provider\'s target for one method category within one country', () => {
    const rows = [row('US', 'USD', { CREDIT_DEBIT_CARD: [banxa()] }), row('DE', 'EUR', { CREDIT_DEBIT_CARD: [banxa(), transak()] })];
    const key = (provider: string, category: 'card' | 'bank', scope: string) => ({ provider, direction: 'buy' as const, category, scope });
    expect(countryTarget(rows, key('BANXA', 'card', 'DE'), OPTIONS)).toMatchObject({ provider: 'BANXA', country: 'DE', fiat: 'EUR' });
    expect(countryTarget(rows, key('BANXA', 'bank', 'DE'), OPTIONS)).toBeUndefined();
    expect(countryTarget(rows, key('TRANSAK', 'card', 'US'), OPTIONS)).toBeUndefined();
  });

  it('skips rows without stored providers and limits that are not plain decimals', () => {
    const written = ({ method_providers: _providers, ...rest }: SupportedCorridorRow): SupportedCorridorRow => rest;
    const legacy = written(row('US', 'USD', { CREDIT_DEBIT_CARD: [banxa()] }));
    expect(probeGroups([legacy, row('GB', 'GBP', { CREDIT_DEBIT_CARD: [banxa('1e3')] })], OPTIONS, first)).toEqual([]);
  });
});
