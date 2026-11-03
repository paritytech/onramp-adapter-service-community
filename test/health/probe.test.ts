import { describe, expect, it, vi } from 'vitest';

import type { ProviderHealthRow, SupportedCorridorRow } from '../../src/funding/store.js';
import { createProber, pinnedQuote, startProviderProbes, type ProbeOptions, type PinnedQuote } from '../../src/health/probe.js';
import type { ProbeTarget } from '../../src/health/targets.js';
import { MeldHttpError } from '../../src/meld/client.js';
import type { Direction } from '../../src/rail.js';

const INTERVAL = 600_000;

const OPTIONS: ProbeOptions = {
  intervalMs: INTERVAL,
  confirmDelayMs: 0,
  failuresToDown: 2,
  throttlePauseMs: 900_000,
  maxProbesPerHour: 100,
  preferredCountries: ['US', 'GB'],
  sellAmounts: new Map(),
};

const corridor = (country: string, fiat: string): SupportedCorridorRow => ({
  destination_currency_code: 'DOT',
  direction: 'buy',
  country,
  name: country,
  fiat,
  methods: [{ paymentMethodType: 'CREDIT_DEBIT_CARD', category: 'card', min: '5', max: '15000', currency: fiat }],
  method_providers: [
    {
      paymentMethodType: 'CREDIT_DEBIT_CARD',
      providers: [
        { provider: 'BANXA', min: '20', max: '15000' },
        { provider: 'TRANSAK', min: '5', max: '3000' },
      ],
    },
  ],
  updated_at: 0,
});

const BANXA_DOWN = new MeldHttpError(400, 'INCOMPATIBLE_REQUEST', '[BANXA] Incompatible request', undefined, 'req-1');

/** Banxa answers with the sandbox's outage; every other provider offers. */
const banxaDown: PinnedQuote = async (target) => {
  if (target.provider === 'BANXA') throw BANXA_DOWN;
  return [{ serviceProvider: target.provider }];
};

function harness(quote: PinnedQuote, options: Partial<ProbeOptions> = {}) {
  let now = 0;
  const health = new Map<string, ProviderHealthRow>();
  const rows = [corridor('US', 'USD'), corridor('GB', 'GBP'), corridor('DE', 'EUR')];
  const log = { info: vi.fn<(message: string) => void>(), warn: vi.fn<(message: string) => void>() };
  const spy = vi.fn(quote);
  const store = {
    readCorridors: async (code: string, direction: Direction) =>
      rows.filter((r) => r.destination_currency_code === code && r.direction === direction),
    readProviderHealth: async () => [...health.values()],
    writeProviderHealth: async (row: ProviderHealthRow) => {
      health.set(`${row.provider}|${row.direction}`, row);
    },
  };
  const prober = createProber(
    { store, quote: spy, jobs: [{ crypto: 'DOT', direction: 'buy' }], log, clock: () => now },
    { ...OPTIONS, ...options },
  );
  return {
    round: () => prober.round(new AbortController().signal),
    advance: (ms: number) => {
      now += ms;
    },
    state: (provider: string) => health.get(`${provider}|buy`),
    calls: (provider: string) => spy.mock.calls.filter(([t]) => t.provider === provider).length,
    spy,
    log,
  };
}

const lines = (fn: { mock: { calls: [string][] } }) => fn.mock.calls.map(([line]) => line);

describe('a probe round', () => {
  it('marks a provider down within one round, confirming its first failure in both fiat currencies', async () => {
    const h = harness(banxaDown);
    await h.round();

    expect(h.state('BANXA')).toMatchObject({
      state: 'down',
      failures: 2,
      last_code: 'INCOMPATIBLE_REQUEST',
      last_request_id: 'req-1',
    });
    expect(h.state('TRANSAK')).toMatchObject({ state: 'up', failures: 0 });
    expect(h.calls('BANXA')).toBe(4);
    expect(h.calls('TRANSAK')).toBe(2);
    expect(h.spy.mock.calls.map(([t]) => t.country)).not.toContain('DE');
    expect(lines(h.log.warn)).toEqual([
      'provider BANXA buy is down after 2 failed probe rounds in US/USD, GB/GBP: expected an offer, observed INCOMPATIBLE_REQUEST (Meld request req-1)',
    ]);
  });

  it('brings a provider back up on the next round it answers', async () => {
    let down = true;
    const h = harness(async (target) => (down ? banxaDown(target) : [{ serviceProvider: target.provider }]));
    await h.round();
    down = false;
    h.advance(INTERVAL);
    await h.round();

    expect(h.state('BANXA')).toMatchObject({ state: 'up', failures: 0, last_code: 'INCOMPATIBLE_REQUEST' });
    expect(lines(h.log.info)).toContain('provider BANXA buy is up again in US/USD, GB/GBP');
  });

  it('changes nothing when Meld cannot be reached', async () => {
    const h = harness(async () => {
      throw new Error('socket hang up');
    });
    await h.round();

    expect(h.state('BANXA')).toBeUndefined();
    expect(h.state('TRANSAK')).toBeUndefined();
  });

  it('stops the round and pauses probing after Meld throttles a probe', async () => {
    let throttled = true;
    const h = harness(async (target) => {
      if (throttled) throw new MeldHttpError(503);
      return [{ serviceProvider: target.provider }];
    });
    await h.round();
    expect(h.spy).toHaveBeenCalledTimes(1);
    expect(lines(h.log.warn)).toEqual(['Meld throttled a provider probe (HTTP_503); probing pauses for 900000ms']);

    throttled = false;
    h.advance(OPTIONS.throttlePauseMs - 1);
    await h.round();
    expect(h.spy).toHaveBeenCalledTimes(1);

    h.advance(1);
    await h.round();
    expect(h.state('BANXA')).toMatchObject({ state: 'up' });
  });

  it('sends no more quotes than the hourly cap allows', async () => {
    const h = harness(banxaDown, { maxProbesPerHour: 3 });
    await h.round();
    expect(h.spy).toHaveBeenCalledTimes(3);
    expect(lines(h.log.warn)).toEqual(['provider probes reached 3 quotes in the last hour; pausing']);

    h.advance(3_600_000);
    await h.round();
    expect(h.spy).toHaveBeenCalledTimes(6);
  });

  it('warns once when no round has reached a conclusion for three intervals', async () => {
    const h = harness(async () => {
      throw new Error('socket hang up');
    });
    for (let i = 0; i < 5; i += 1) {
      await h.round();
      h.advance(INTERVAL);
    }
    expect(lines(h.log.warn)).toEqual([
      `no provider probe has reached a conclusion for ${String(4 * INTERVAL)}ms; stored provider health is stale`,
    ]);
  });
});

describe('startProviderProbes', () => {
  it('runs rounds on its interval and stops cleanly', async () => {
    const quote = vi.fn(async (target: ProbeTarget) => [{ serviceProvider: target.provider }]);
    const store = {
      readCorridors: async () => [corridor('US', 'USD')],
      readProviderHealth: async () => [],
      writeProviderHealth: async () => undefined,
    };
    const log = { info: vi.fn(), warn: vi.fn() };
    const probes = startProviderProbes(
      { store, quote, jobs: [{ crypto: 'DOT', direction: 'buy' }], log },
      { ...OPTIONS, intervalMs: 5 },
      undefined,
      () => 0,
    );
    await vi.waitFor(() => {
      expect(quote).toHaveBeenCalled();
    });
    await probes.stop();
    expect(log.warn).not.toHaveBeenCalled();
  });
});

describe('pinnedQuote', () => {
  const target: ProbeTarget = {
    provider: 'TRANSAK',
    direction: 'buy',
    country: 'GB',
    fiat: 'GBP',
    crypto: 'DOT',
    paymentMethodType: 'CREDIT_DEBIT_CARD',
    amount: '10',
  };

  it('prices a buy in the target fiat, pinned to the provider', async () => {
    const meld = { quote: vi.fn(async () => []), quoteSell: vi.fn(async () => []) };
    await pinnedQuote(meld)(target);
    expect(meld.quote).toHaveBeenCalledWith({
      countryCode: 'GB',
      sourceCurrencyCode: 'GBP',
      destinationCurrencyCode: 'DOT',
      sourceAmount: '10',
      paymentMethodType: 'CREDIT_DEBIT_CARD',
      serviceProviders: ['TRANSAK'],
    });
  });

  it('prices a sell from the target crypto, pinned to the provider', async () => {
    const meld = { quote: vi.fn(async () => []), quoteSell: vi.fn(async () => []) };
    await pinnedQuote(meld)({ ...target, direction: 'sell', paymentMethodType: 'PAYOUT_TO_BANK', amount: '15' });
    expect(meld.quoteSell).toHaveBeenCalledWith({
      countryCode: 'GB',
      cryptoCurrencyCode: 'DOT',
      fiatCurrencyCode: 'GBP',
      cryptoAmount: '15',
      paymentMethodType: 'PAYOUT_TO_BANK',
      serviceProviders: ['TRANSAK'],
    });
  });
});
