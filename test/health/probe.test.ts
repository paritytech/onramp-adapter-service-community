import { describe, expect, it, vi } from 'vitest';

import type { ProviderHealthRow, SupportedCorridorRow } from '../../src/funding/store.js';
import { createProber, pinnedQuote, startProviderProbes, type ProbeOptions, type PinnedQuote } from '../../src/health/probe.js';
import type { ProbeTarget } from '../../src/health/targets.js';
import type { HealthKey } from '../../src/health/transition.js';
import { MeldHttpError } from '../../src/meld/client.js';
import type { Direction } from '../../src/rail.js';

const INTERVAL = 600_000;
const HOUR = 3_600_000;

const OPTIONS: ProbeOptions = {
  intervalMs: INTERVAL,
  failuresToDown: 2,
  throttlePauseMs: 900_000,
  maxProbesPerHour: 100,
  sellAmounts: new Map(),
  exclusions: [],
};

/** The least gap between two quotes at `OPTIONS.maxProbesPerHour`. */
const GAP = HOUR / OPTIONS.maxProbesPerHour;

const PROVIDERS = [
  { provider: 'BANXA', min: '20', max: '15000' },
  { provider: 'TRANSAK', min: '5', max: '3000' },
];

const corridor = (country: string, fiat: string, bank = false): SupportedCorridorRow => ({
  destination_currency_code: 'DOT',
  direction: 'buy',
  country,
  name: country,
  fiat,
  methods: [
    { paymentMethodType: 'CREDIT_DEBIT_CARD', category: 'card', min: '5', max: '15000', currency: fiat },
    ...(bank ? [{ paymentMethodType: 'SEPA', category: 'bank' as const, min: '5', max: '15000', currency: fiat }] : []),
  ],
  method_providers: [
    { paymentMethodType: 'CREDIT_DEBIT_CARD', providers: PROVIDERS },
    ...(bank ? [{ paymentMethodType: 'SEPA', providers: PROVIDERS }] : []),
  ],
  updated_at: 0,
});

const key = (provider: string, scope = 'global', category: HealthKey['category'] = 'card'): HealthKey => ({
  provider,
  direction: 'buy',
  category,
  scope,
});

const row = (over: Partial<ProviderHealthRow>): ProviderHealthRow => ({
  ...key('BANXA'),
  state: 'up',
  failures: 0,
  last_ok_at: 0,
  last_failed_at: null,
  last_code: null,
  last_request_id: null,
  updated_at: 0,
  expires_at: INTERVAL,
  ...over,
});

const BANXA_DOWN = new MeldHttpError(400, 'INCOMPATIBLE_REQUEST', '[BANXA] Incompatible request', undefined, 'req-1');

const offers: PinnedQuote = async (target) => [{ serviceProvider: target.provider }];

/** Banxa answers with the sandbox's outage; every other provider offers. */
const banxaDown: PinnedQuote = async (target) => {
  if (target.provider === 'BANXA') throw BANXA_DOWN;
  return offers(target);
};

/** Banxa fails in Germany only. */
const downInGermany: PinnedQuote = async (target) => {
  if (target.provider === 'BANXA' && target.country === 'DE') throw BANXA_DOWN;
  return offers(target);
};

function harness(
  quote: PinnedQuote,
  options: Partial<ProbeOptions> = {},
  rows = [corridor('US', 'USD'), corridor('GB', 'GBP'), corridor('DE', 'EUR')],
  stored: readonly ProviderHealthRow[] = [],
) {
  let now = 0;
  const health = new Map(stored.map((r) => [`${r.provider}|${r.direction}|${r.category}|${r.scope}`, r]));
  const log = { info: vi.fn<(message: string) => void>(), warn: vi.fn<(message: string) => void>() };
  const sent: { target: ProbeTarget; at: number }[] = [];
  const store = {
    readCorridors: async (code: string, direction: Direction) =>
      rows.filter((r) => r.destination_currency_code === code && r.direction === direction),
    readProviderHealth: async () => [...health.values()],
    writeProviderHealth: async (r: ProviderHealthRow) => {
      health.set(`${r.provider}|${r.direction}|${r.category}|${r.scope}`, r);
    },
    extendProviderHealth: async (ms: number, at: number) => {
      for (const r of health.values()) if (r.expires_at > at) r.expires_at += ms;
    },
  };
  const prober = createProber(
    {
      store,
      quote: async (target) => {
        sent.push({ target, at: now });
        return quote(target);
      },
      jobs: [{ crypto: 'DOT', direction: 'buy' }],
      log,
      clock: () => now,
      // The last country by code, then the last with another fiat: US, then GB.
      random: () => 0.9,
      wait: async (ms) => {
        now += ms;
      },
    },
    { ...OPTIONS, ...options },
  );
  const signal = new AbortController().signal;
  return {
    prober,
    rows,
    step: () => prober.step(signal),
    /** Steps until `count` quotes have gone out in all. */
    until: async (count: number) => {
      while (sent.length < count) await prober.step(signal);
    },
    suspect: (provider: string, country: string) => {
      prober.suspect([key(provider, country)]);
    },
    advance: (ms: number) => {
      now += ms;
    },
    state: (provider: string, scope = 'global', category = 'card') => health.get(`${provider}|buy|${category}|${scope}`),
    calls: (provider: string, country?: string) =>
      sent.filter(({ target }) => target.provider === provider && (country === undefined || target.country === country)).length,
    sent,
    log,
  };
}

const lines = (fn: { mock: { calls: [string][] } }) => fn.mock.calls.map(([line]) => line);

describe('the probe pace', () => {
  it('sends one quote at a time, never two closer than the gap, and repeats a failed probe at the next quote', async () => {
    const h = harness(banxaDown);
    await h.step();

    expect(h.state('BANXA')).toMatchObject({ state: 'down', failures: 2, last_code: 'INCOMPATIBLE_REQUEST', last_request_id: 'req-1' });
    expect(h.sent.map(({ target, at }) => `${target.provider} ${target.country} ${String(at)}`)).toEqual([
      'BANXA US 0',
      `BANXA GB ${String(GAP)}`,
      `BANXA US ${String(2 * GAP)}`,
      `BANXA GB ${String(3 * GAP)}`,
    ]);
    expect(lines(h.log.info)).toEqual([
      'provider BANXA buy card failed a probe round in US/USD, GB/GBP: observed INCOMPATIBLE_REQUEST (Meld request req-1); confirming',
    ]);
    expect(lines(h.log.warn)).toEqual([
      'provider BANXA buy card is down after 2 failed probe rounds in US/USD, GB/GBP: expected an offer, observed INCOMPATIBLE_REQUEST (Meld request req-1)',
    ]);

    await h.step();
    expect(h.state('TRANSAK')).toMatchObject({ state: 'up', failures: 0 });
    expect(h.sent.slice(4).map(({ at }) => at)).toEqual([4 * GAP]);
  });

  it('stops a probe at its first offer, and tries the second country only when the first fails', async () => {
    const h = harness(async (target) => (target.provider === 'BANXA' && target.country === 'US' ? banxaDown(target) : offers(target)));
    await h.step();
    await h.step();
    expect(h.sent.map(({ target }) => `${target.provider} ${target.country}`)).toEqual(['BANXA US', 'BANXA GB', 'TRANSAK US']);
    expect(h.state('BANXA')).toMatchObject({ state: 'up', failures: 0 });
  });

  it('confirms a failure again when the repeat of an earlier one proved nothing', async () => {
    let banxa = 0;
    const h = harness(async (target) => {
      if (target.provider !== 'BANXA') return offers(target);
      banxa += 1;
      // A failed round, an inconclusive repeat, then an outage.
      if (banxa === 3 || banxa === 4) throw new MeldHttpError(400, 'INVALID_AMOUNT_TOO_LOW');
      throw BANXA_DOWN;
    });
    await h.step();
    expect(h.state('BANXA')).toMatchObject({ state: 'up', failures: 0, last_code: 'INCOMPATIBLE_REQUEST' });

    await h.step();
    h.advance(INTERVAL);
    await h.step();
    expect(h.state('BANXA')).toMatchObject({ state: 'down', failures: 2 });
    expect(h.calls('BANXA')).toBe(8);
  });

  it('brings a provider back up the next time it answers', async () => {
    let down = true;
    const h = harness(async (target) => (down ? banxaDown(target) : offers(target)));
    await h.step();
    down = false;
    h.advance(INTERVAL);
    await h.step();
    await h.step();

    expect(h.state('BANXA')).toMatchObject({ state: 'up', failures: 0, last_code: 'INCOMPATIBLE_REQUEST' });
    expect(lines(h.log.info)).toContain('provider BANXA buy card is up again in US/USD');
  });

  it('probes the group probed longest ago next, and no group more often than the interval', async () => {
    const h = harness(offers);
    await h.until(2);
    await h.step();
    expect(h.sent).toHaveLength(2);

    await h.until(4);
    expect(h.sent.slice(2).map(({ target, at }) => [target.provider, at >= INTERVAL])).toEqual([
      ['BANXA', true],
      ['TRANSAK', true],
    ]);
  });

  it('counts stored health as the last probe, so a restart does not probe every group at once', async () => {
    const h = harness(offers, {}, undefined, [row({ updated_at: 0 })]);
    await h.step();
    await h.step();
    expect(h.calls('BANXA')).toBe(0);
    expect(h.calls('TRANSAK')).toBe(1);
  });

  it('probes each group less often when the groups need more quotes than the rate allows in the interval', async () => {
    const h = harness(offers, { maxProbesPerHour: 10 });
    await h.until(8);
    expect(h.calls('BANXA')).toBe(4);
    expect(h.calls('TRANSAK')).toBe(4);
    expect(h.sent.map(({ at }) => at)).toEqual([0, 1, 2, 3, 4, 5, 6, 7].map((i) => i * 360_000));
    expect(lines(h.log.info)).toEqual(['2 provider probes need up to 4 quotes at one every 360000ms: each is repeated within 1440000ms']);

    h.rows.splice(0);
    await h.step();
    expect(lines(h.log.info)).toContain('each provider probe is repeated every 600000ms again');
  });

  it('probes each method category on its own, so a card outage leaves bank up', async () => {
    const h = harness(
      async (target) => (target.category === 'card' ? banxaDown(target) : offers(target)),
      {},
      [corridor('US', 'USD'), corridor('GB', 'GBP', true), corridor('DE', 'EUR', true)],
    );
    for (let i = 0; i < 4; i += 1) await h.step();

    expect(h.state('BANXA')).toMatchObject({ state: 'down' });
    expect(h.state('BANXA', 'global', 'bank')).toMatchObject({ state: 'up' });
    expect(h.sent.filter(({ target }) => target.category === 'bank').map(({ target }) => target.country)).not.toContain('US');
  });

  it('keeps stored health valid for three times the time between two probes of a group', async () => {
    const h = harness(banxaDown);
    await h.step();
    expect(h.state('BANXA')).toMatchObject({ state: 'down', expires_at: 3 * GAP + 3 * INTERVAL });

    const slow = harness(banxaDown, { maxProbesPerHour: 10 });
    await slow.step();
    expect(slow.state('BANXA')).toMatchObject({ state: 'down', expires_at: 3 * 360_000 + 3 * 4 * 360_000 });
  });

  it('keeps stored health valid through a throttle pause, without reviving what had expired', async () => {
    const stored = [
      row({ provider: 'TRANSAK', state: 'down', failures: 2, expires_at: 2 * INTERVAL }),
      row({ provider: 'STRIPE', state: 'down', expires_at: 0 }),
    ];
    const throttled: PinnedQuote = async () => {
      throw new MeldHttpError(429);
    };
    const h = harness(throttled, {}, undefined, stored);
    await h.step();
    expect(h.state('TRANSAK')).toMatchObject({ expires_at: 2 * INTERVAL + OPTIONS.throttlePauseMs });
    expect(h.state('STRIPE')).toMatchObject({ expires_at: 0 });
  });

  it('pauses after Meld throttles a probe, then probes again', async () => {
    let throttled = true;
    const h = harness(async (target) => {
      if (throttled) throw new MeldHttpError(503);
      return offers(target);
    });
    await h.step();
    expect(h.sent).toHaveLength(1);
    expect(lines(h.log.warn)).toEqual(['Meld throttled a provider probe (HTTP_503); probing pauses for 900000ms']);

    throttled = false;
    h.suspect('BANXA', 'DE');
    await h.step();
    expect(h.sent).toHaveLength(1);

    await h.step();
    expect(h.state('BANXA', 'DE')).toMatchObject({ state: 'up' });
  });

  it('changes nothing when Meld cannot be reached', async () => {
    const h = harness(async () => {
      throw new Error('socket hang up');
    });
    await h.until(4);
    expect(h.state('BANXA')).toBeUndefined();
    expect(h.state('TRANSAK')).toBeUndefined();
  });

  it('sends nothing once its signal is aborted', async () => {
    const h = harness(banxaDown);
    const controller = new AbortController();
    controller.abort();
    await expect(h.prober.step(controller.signal)).rejects.toThrow(/abort/i);
    expect(h.sent).toHaveLength(0);
  });

  it('warns once when no probe has reached a conclusion for three intervals', async () => {
    const h = harness(async () => {
      throw new Error('socket hang up');
    });
    await h.until(20);
    const stale = lines(h.log.warn).filter((line) => line.startsWith('no provider probe'));
    expect(stale).toHaveLength(1);
    expect(stale[0]).toMatch(/^no provider probe has reached a conclusion for \d+ms; stored provider health is stale$/);
  });
});

describe('a country outage', () => {
  it('is probed again once the interval passes, and clears when the provider answers there', async () => {
    let down = true;
    const h = harness(async (target) => (down ? downInGermany(target) : offers(target)));
    h.suspect('BANXA', 'DE');
    await h.step();
    expect(h.state('BANXA', 'DE')).toMatchObject({ state: 'down' });

    down = false;
    await h.until(h.sent.length + 4);
    h.advance(INTERVAL);
    while (h.calls('BANXA', 'DE') < 3) await h.step();
    expect(h.state('BANXA', 'DE')).toMatchObject({ state: 'up', failures: 0 });
  });

  it('is left alone while the provider is down everywhere', async () => {
    const stored = [row({ state: 'down', failures: 2 }), row({ scope: 'DE', state: 'down', failures: 2 })];
    const h = harness(banxaDown, {}, undefined, stored);
    await h.until(12);
    expect(h.calls('BANXA')).toBeGreaterThan(0);
    expect(h.calls('BANXA', 'DE')).toBe(0);
  });
});

describe('a live-quote check', () => {
  it('runs ahead of the groups due, and marks a provider down in that country only', async () => {
    const h = harness(downInGermany);
    h.suspect('BANXA', 'DE');
    await h.step();

    expect(h.state('BANXA', 'DE')).toMatchObject({ state: 'down', failures: 2 });
    expect(h.state('BANXA')).toMatchObject({ state: 'up', failures: 0 });
    expect(h.calls('BANXA', 'DE')).toBe(2);
    expect(h.calls('TRANSAK')).toBe(0);
    expect(lines(h.log.warn)).toEqual([
      'provider BANXA buy card in DE is down after 2 failed probe rounds in DE/EUR: expected an offer, observed INCOMPATIBLE_REQUEST (Meld request req-1)',
    ]);
  });

  it('checks a country at most once per interval', async () => {
    const h = harness(downInGermany);
    h.suspect('BANXA', 'DE');
    await h.step();
    h.suspect('BANXA', 'DE');
    await h.step();
    expect(h.calls('BANXA', 'DE')).toBe(2);

    h.advance(INTERVAL);
    h.suspect('BANXA', 'DE');
    await h.step();
    expect(h.calls('BANXA', 'DE')).toBe(3);
  });

  it('checks the provider everywhere first, and skips the country when it is down everywhere', async () => {
    const h = harness(banxaDown);
    h.suspect('BANXA', 'DE');
    await h.step();

    expect(h.state('BANXA')).toMatchObject({ state: 'down' });
    expect(h.state('BANXA', 'DE')).toBeUndefined();
    expect(h.calls('BANXA', 'DE')).toBe(0);
  });

  it('starts only what half the hour\'s quotes cover, leaving the rest to the groups', async () => {
    // One quote an hour for checks: the check everywhere needs up to two, the country one.
    const h = harness(downInGermany, { maxProbesPerHour: 2 });
    h.suspect('BANXA', 'DE');
    await h.step();
    expect(h.calls('BANXA')).toBe(1);
    expect(h.calls('BANXA', 'DE')).toBe(1);

    await h.step();
    expect(h.calls('BANXA', 'US')).toBe(1);

    h.suspect('BANXA', 'DE');
    await h.step();
    expect(h.calls('BANXA', 'DE')).toBe(1);

    h.advance(HOUR);
    h.suspect('BANXA', 'DE');
    await h.step();
    expect(h.calls('BANXA', 'DE')).toBe(2);
  });

  it('stops before the country when Meld throttles the check everywhere', async () => {
    const h = harness(async () => {
      throw new MeldHttpError(429);
    });
    h.suspect('BANXA', 'DE');
    await h.step();
    expect(h.sent).toHaveLength(1);
    expect(h.calls('BANXA', 'DE')).toBe(0);
  });

  it('skips a country without a stored corridor for the provider', async () => {
    const h = harness(downInGermany);
    h.suspect('BANXA', 'FR');
    await h.step();
    expect(h.calls('BANXA', 'FR')).toBe(0);
    expect(h.state('BANXA', 'FR')).toBeUndefined();
  });
});

describe('startProviderProbes', () => {
  /** Every group probed just now, so only a suspect is due. */
  const fresh = () => [row({ updated_at: Date.now() }), row({ provider: 'TRANSAK', updated_at: Date.now() })];

  it('checks a suspect as it is reported, and nothing once stopped', async () => {
    const quote = vi.fn(offers);
    const store = {
      readCorridors: async () => [corridor('DE', 'EUR')],
      readProviderHealth: async () => fresh(),
      writeProviderHealth: async () => undefined,
      extendProviderHealth: async () => undefined,
    };
    const probes = startProviderProbes(
      { store, quote, jobs: [{ crypto: 'DOT', direction: 'buy' }], log: { info: vi.fn(), warn: vi.fn() } },
      { ...OPTIONS, maxProbesPerHour: 10_000 },
    );
    probes.suspect([key('BANXA', 'DE')]);
    await vi.waitFor(() => {
      expect(quote).toHaveBeenCalledWith(expect.objectContaining({ provider: 'BANXA', country: 'DE' }));
    });
    await probes.stop();

    const calls = quote.mock.calls.length;
    probes.suspect([key('TRANSAK', 'DE')]);
    await new Promise((resolve) => setImmediate(resolve));
    expect(quote).toHaveBeenCalledTimes(calls);
  });

  it('warns and continues when a step fails', async () => {
    const store = {
      readCorridors: async () => {
        throw new Error('store unreachable');
      },
      readProviderHealth: async () => [],
      writeProviderHealth: async () => undefined,
      extendProviderHealth: async () => undefined,
    };
    const log = { info: vi.fn<(message: string) => void>(), warn: vi.fn<(message: string) => void>() };
    const probes = startProviderProbes({ store, quote: offers, jobs: [{ crypto: 'DOT', direction: 'buy' }], log }, { ...OPTIONS, intervalMs: 5 });
    await vi.waitFor(() => {
      expect(lines(log.warn).filter((line) => line === 'provider probe failed, continuing: store unreachable').length).toBeGreaterThan(1);
    });
    await probes.stop();
  });
});

describe('pinnedQuote', () => {
  const target: ProbeTarget = {
    provider: 'TRANSAK',
    direction: 'buy',
    category: 'card',
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
