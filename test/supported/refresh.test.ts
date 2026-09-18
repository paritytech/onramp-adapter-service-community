import { describe, expect, it, vi } from 'vitest';

import { refreshOnce, startSupportedRefresh, type SupportedDiscovery } from '../../src/supported/refresh.js';
import type { Corridor, CountryRow, MethodLimit } from '../../src/meld/discovery.js';
import { fakeStore } from '../fixtures.js';

const CRYPTO = 'DOT_ASSETHUB';

const method = (over: Partial<MethodLimit> = {}): MethodLimit => ({
  paymentMethodType: 'PIX',
  category: 'bank',
  min: '10',
  max: '5000',
  currency: 'BRL',
  providers: ['TRANSAK'],
  ...over,
});

const corridor = (country: string, over: Partial<Corridor> = {}): Corridor => ({
  country,
  fiat: 'BRL',
  crypto: CRYPTO,
  methods: [method()],
  ...over,
});

/** A discovery double whose country list and per-country corridor are set per test. */
function disco(opts: {
  countries?: CountryRow[];
  countriesThrows?: boolean;
  corridor?: (country: string) => Promise<Corridor>;
}): SupportedDiscovery {
  return {
    countries: async (_crypto: string) => {
      if (opts.countriesThrows) throw new Error('meld down');
      return opts.countries ?? [{ country: 'BR', name: 'Brazil' }];
    },
    corridorForCountry: async (country: string, _crypto: string) =>
      opts.corridor ? opts.corridor(country) : corridor(country),
  };
}

describe('refreshOnce', () => {
  it('upserts every deliverable corridor and reports the count', async () => {
    const store = fakeStore();
    const written = await refreshOnce(disco({ countries: [{ country: 'BR', name: 'Brazil' }] }), store, CRYPTO, () => undefined);

    expect(written).toBe(1);
    expect(await store.readCorridors(CRYPTO)).toEqual([
      {
        destination_currency_code: CRYPTO,
        country: 'BR',
        name: 'Brazil',
        fiat: 'BRL',
        methods: [{ paymentMethodType: 'PIX', category: 'bank', min: '10', max: '5000', currency: 'BRL' }],
        updated_at: 2_000_000_000_000,
      },
    ]);
  });

  it('skips an empty-methods country and keeps its last-known-good row (never deletes on empty)', async () => {
    // An empty result can be a swallowed transient failure, so the row is kept rather than dropped.
    const store = fakeStore();
    await store.upsertCorridor({ destination_currency_code: CRYPTO, country: 'BR', name: 'Brazil', fiat: 'BRL', methods: [{ paymentMethodType: 'PIX', category: 'bank', min: '10', max: '5000', currency: 'BRL' }] });

    const written = await refreshOnce(
      disco({ countries: [{ country: 'BR', name: 'Brazil' }], corridor: async (c) => corridor(c, { methods: [] }) }),
      store,
      CRYPTO,
      () => undefined,
    );

    expect(written).toBe(0);
    expect((await store.readCorridors(CRYPTO)).map((r) => r.country)).toEqual(['BR']);
  });

  it('skips a country whose probe fails and keeps the rest of the pass', async () => {
    const store = fakeStore();
    const log = vi.fn();
    const written = await refreshOnce(
      disco({
        countries: [
          { country: 'BR', name: 'Brazil' },
          { country: 'US', name: 'United States' },
        ],
        corridor: async (c) => {
          if (c === 'BR') throw new Error('429 too many requests');
          return corridor(c, { fiat: 'USD', methods: [method({ paymentMethodType: 'CREDIT_DEBIT_CARD', category: 'card', currency: 'USD' })] });
        },
      }),
      store,
      CRYPTO,
      log,
    );

    expect(written).toBe(1);
    expect((await store.readCorridors(CRYPTO)).map((r) => r.country)).toEqual(['US']);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('BR/DOT_ASSETHUB'));
  });

  it('does not start processing a country when already stopping', async () => {
    const store = fakeStore();
    const probe = vi.fn(async (c: string) => corridor(c));
    const written = await refreshOnce(
      { countries: async () => [{ country: 'BR', name: 'Brazil' }], corridorForCountry: (c) => probe(c) },
      store,
      CRYPTO,
      () => undefined,
      () => true,
    );

    expect(written).toBe(0);
    expect(probe).not.toHaveBeenCalled();
    expect(await store.readCorridors(CRYPTO)).toEqual([]);
  });

  it('skips the upsert when stop arrives during a probe', async () => {
    const store = fakeStore();
    // false at the loop top, true before the upsert.
    let checks = 0;
    const written = await refreshOnce(disco({ countries: [{ country: 'BR', name: 'Brazil' }] }), store, CRYPTO, () => undefined, () => {
      checks += 1;
      return checks > 1;
    });

    expect(written).toBe(0);
    expect(await store.readCorridors(CRYPTO)).toEqual([]);
  });

  it('aborts the pass and keeps the last good rows when the country list fails', async () => {
    const store = fakeStore();
    await store.upsertCorridor({ destination_currency_code: CRYPTO, country: 'BR', name: 'Brazil', fiat: 'BRL', methods: [method()] });
    const log = vi.fn();

    const written = await refreshOnce(disco({ countriesThrows: true }), store, CRYPTO, log);

    expect(written).toBe(0);
    expect((await store.readCorridors(CRYPTO)).map((r) => r.country)).toEqual(['BR']);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('could not list countries'));
  });
});

describe('startSupportedRefresh', () => {
  it('runs one pass immediately and then on the interval, and stops on request', async () => {
    vi.useFakeTimers();
    const store = fakeStore();
    const countries = vi.fn(async () => [{ country: 'BR', name: 'Brazil' }]);
    const refresh = startSupportedRefresh(
      { countries, corridorForCountry: async (c) => corridor(c) },
      store,
      [CRYPTO],
      1_000,
      () => undefined,
    );

    // The immediate pass fires without waiting a whole interval.
    await vi.advanceTimersByTimeAsync(0);
    expect(countries).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(countries.mock.calls.length).toBeGreaterThan(1);

    await refresh.stop(0);
    vi.useRealTimers();
  });

  it('unrefs its interval, so the loop never holds the process open on its own', async () => {
    const unref = vi.fn();
    const spy = vi
      .spyOn(globalThis, 'setInterval')
      .mockReturnValue({ unref } as unknown as ReturnType<typeof setInterval>);

    const refresh = startSupportedRefresh(disco({}), fakeStore(), [CRYPTO], 1_000, () => undefined);
    spy.mockRestore();
    await refresh.stop(0);

    expect(unref).toHaveBeenCalled();
  });

  it('never overlaps passes: a slow pass holds the loop so the next interval does not stack', async () => {
    vi.useFakeTimers();
    // A country list that never resolves in the window keeps the pass in flight; the guard must
    // stop every later interval from starting another.
    const countries = vi.fn(() => new Promise<CountryRow[]>(() => undefined));
    const refresh = startSupportedRefresh(
      { countries, corridorForCountry: async (c) => corridor(c) },
      fakeStore(),
      [CRYPTO],
      100,
      () => undefined,
    );

    await vi.advanceTimersByTimeAsync(1_000);
    expect(countries).toHaveBeenCalledTimes(1);

    await refresh.stop(0);
    vi.useRealTimers();
  });

  it('does not return until the in-flight pass settles', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const countries = vi.fn(async () => {
      await gate;
      return [{ country: 'BR', name: 'Brazil' }];
    });
    const refresh = startSupportedRefresh(
      { countries, corridorForCountry: async (c) => corridor(c) },
      fakeStore(),
      [CRYPTO],
      100_000,
      () => undefined,
    );

    // The immediate pass is blocked on the gate; stop must await it rather than returning early.
    let resolved = false;
    const stopped = refresh.stop(5_000).then(() => {
      resolved = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(resolved).toBe(false);

    release?.();
    await stopped;
    expect(resolved).toBe(true);
  });

  it('does not start the next crypto once stopping', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const countries = vi.fn(async (crypto: string) => {
      if (crypto === 'A') await gate;
      return [{ country: 'BR', name: 'Brazil' }];
    });
    const refresh = startSupportedRefresh({ countries, corridorForCountry: async (c) => corridor(c) }, fakeStore(), ['A', 'B'], 100_000, () => undefined);

    // The pass is blocked mid crypto 'A'; stopping must skip crypto 'B' entirely.
    await new Promise((resolve) => setTimeout(resolve, 10));
    const stopped = refresh.stop(5_000);
    release?.();
    await stopped;

    expect(countries).toHaveBeenCalledWith('A');
    expect(countries).not.toHaveBeenCalledWith('B');
  });

  it('stop returns within the grace window even if a pass is hung on a single Meld call', async () => {
    // Cooperative stop only breaks at country boundaries; a hung in-flight call is bounded by grace.
    const countries = vi.fn(async () => [{ country: 'BR', name: 'Brazil' }]);
    const corridorForCountry = vi.fn(() => new Promise<Corridor>(() => undefined));
    const refresh = startSupportedRefresh({ countries, corridorForCountry }, fakeStore(), [CRYPTO], 100_000, () => undefined);

    // Let the immediate pass reach the hung corridor call.
    await new Promise((resolve) => setTimeout(resolve, 10));

    const start = Date.now();
    await refresh.stop(50);
    expect(Date.now() - start).toBeLessThan(2_000);
  });

  it('returns at once when no pass is in flight, without waiting out the grace window', async () => {
    const refresh = startSupportedRefresh(disco({}), fakeStore(), [CRYPTO], 100_000, () => undefined);
    // Let the immediate pass finish, so stop sees nothing in flight.
    await new Promise((resolve) => setTimeout(resolve, 10));

    // stop must return promptly, not sit on the 5s grace: a 50ms tripwire proves it.
    let waited = false;
    const tripwire = setTimeout(() => {
      waited = true;
    }, 50);
    await refresh.stop(5_000);
    clearTimeout(tripwire);
    expect(waited).toBe(false);
  });
});
