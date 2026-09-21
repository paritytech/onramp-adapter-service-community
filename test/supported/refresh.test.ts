import { describe, expect, it, vi } from 'vitest';

/**
 * Sleep options, recorded by a pass-through mock: `vi.spyOn` cannot reach a Node builtin's
 * exports, and `ref: false`, the signal, and the two cadences are observable nowhere else.
 * `stop`'s grace timer uses the same call, so tests filter by the interval they configured.
 */
const { sleepCalls } = vi.hoisted(() => ({
  sleepCalls: [] as { ms: number; opts: { ref?: boolean; signal?: AbortSignal } }[],
}));

vi.mock('node:timers/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:timers/promises')>();
  return {
    ...actual,
    setTimeout: (ms: number, value: unknown, opts: { ref?: boolean; signal?: AbortSignal } = {}) => {
      sleepCalls.push({ ms, opts });
      return actual.setTimeout(ms, value, opts);
    },
  };
});

import {
  refreshCatalog,
  refreshRoutes,
  startSupportedRefresh,
  type CatalogEntry,
  type SupportedDiscovery,
} from '../../src/supported/refresh.js';
import type { Corridor, CountryRow, MethodLimit } from '../../src/meld/discovery.js';
import { fakeStore } from '../fixtures.js';

const CRYPTO = 'DOT_ASSETHUB';
/** Long enough that no test reaches a second tick by accident. */
const NEVER = { catalogMs: 100_000, routesMs: 100_000 };

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

const BRAZIL: CatalogEntry = { country: 'BR', name: 'Brazil', fiat: 'BRL' };

/** A discovery double whose country list, default fiat and corridor are set per test. */
function disco(opts: {
  countries?: CountryRow[];
  countriesThrows?: boolean;
  fiat?: (country: string) => Promise<string>;
  corridor?: (country: string) => Promise<Corridor>;
}): SupportedDiscovery {
  return {
    countries: async (_crypto: string) => {
      if (opts.countriesThrows) throw new Error('meld down');
      return opts.countries ?? [{ country: 'BR', name: 'Brazil' }];
    },
    defaultFiat: async (country: string) => (opts.fiat ? opts.fiat(country) : 'BRL'),
    corridor: async (country: string, _fiat: string, _crypto: string) =>
      opts.corridor ? opts.corridor(country) : corridor(country),
  };
}

describe('refreshCatalog', () => {
  it('returns an empty catalog, not a failure, when Meld lists no countries at all', async () => {
    expect(await refreshCatalog(disco({ countries: [] }), CRYPTO, () => undefined)).toEqual([]);
  });

  it('pairs every country with its default fiat', async () => {
    const catalog = await refreshCatalog(
      disco({
        countries: [
          { country: 'BR', name: 'Brazil' },
          { country: 'US', name: 'United States' },
        ],
        fiat: async (c) => (c === 'BR' ? 'BRL' : 'USD'),
      }),
      CRYPTO,
      () => undefined,
    );

    expect(catalog).toEqual([BRAZIL, { country: 'US', name: 'United States', fiat: 'USD' }]);
  });

  it('drops a country with no default fiat: there is no routes URL to build for it', async () => {
    const catalog = await refreshCatalog(
      disco({
        countries: [
          { country: 'BR', name: 'Brazil' },
          { country: 'NF', name: 'Nofiat' },
        ],
        fiat: async (c) => (c === 'NF' ? '' : 'BRL'),
      }),
      CRYPTO,
      () => undefined,
    );

    expect(catalog).toEqual([BRAZIL]);
  });

  it('keeps the rest of the pass when one country\'s defaults call throws', async () => {
    const log = vi.fn();
    const catalog = await refreshCatalog(
      disco({
        countries: [
          { country: 'XX', name: 'Errorland' },
          { country: 'BR', name: 'Brazil' },
        ],
        fiat: async (c) => {
          if (c === 'XX') throw new Error('429 too many requests');
          return 'BRL';
        },
      }),
      CRYPTO,
      log,
    );

    expect(catalog).toEqual([BRAZIL]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('XX'));
  });

  it('returns undefined, not an empty catalog, when the country list fails', async () => {
    // `[]` would mean "Meld serves nowhere" and retire every corridor on one bad call.
    const log = vi.fn();
    expect(await refreshCatalog(disco({ countriesThrows: true }), CRYPTO, log)).toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('could not list countries'));
  });

  it('stops at a country boundary once the signal is aborted, without clobbering the catalog', async () => {
    // An aborted pass resolved nothing, which is a failed read rather than an empty world.
    const fiat = vi.fn(async () => 'BRL');
    const catalog = await refreshCatalog(
      { ...disco({ countries: [{ country: 'BR', name: 'Brazil' }] }), defaultFiat: fiat },
      CRYPTO,
      () => undefined,
      AbortSignal.abort(),
    );

    expect(catalog).toBeUndefined();
    expect(fiat).not.toHaveBeenCalled();
  });

  it('reports a defaults-wide outage as a failed read, not an empty catalog', async () => {
    // Every /defaults call failing looks like "no country has a fiat". Returning [] would retire
    // every corridor; the caller must keep what it has.
    const log = vi.fn();
    const catalog = await refreshCatalog(
      disco({
        countries: [
          { country: 'BR', name: 'Brazil' },
          { country: 'US', name: 'US' },
        ],
        fiat: async () => {
          throw new Error('defaults down');
        },
      }),
      CRYPTO,
      log,
    );

    expect(catalog).toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('could not resolve any default fiat'));
  });

  it('keeps a country\'s last-known entry when its defaults call fails, but drops it when Meld says no fiat', async () => {
    const previous = [
      { country: 'GB', name: 'United Kingdom', fiat: 'GBP' },
      { country: 'FR', name: 'France', fiat: 'EUR' },
    ];
    const log = vi.fn();
    const catalog = await refreshCatalog(
      disco({
        countries: [
          { country: 'GB', name: 'United Kingdom' },
          { country: 'FR', name: 'France' },
        ],
        fiat: async (c) => {
          if (c === 'GB') throw new Error('429'); // transient failure -> keep the last known
          return ''; // FR genuinely has no fiat now -> drop it
        },
      }),
      CRYPTO,
      log,
      undefined,
      previous,
    );

    expect(catalog).toEqual([{ country: 'GB', name: 'United Kingdom', fiat: 'GBP' }]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('keeping the last known'));
  });

  it('reports a non-Error rejection without losing what it was', async () => {
    const log = vi.fn();
    const catalog = await refreshCatalog(
      {
        ...disco({}),
        // A non-Error rejection is the point of this test: `message()` has to describe it rather
        // than read `.message` off something that has none.
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        countries: () => Promise.reject('meld exploded'),
      },
      CRYPTO,
      log,
    );

    expect(catalog).toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('meld exploded'));
  });
});

describe('refreshRoutes', () => {
  it('upserts every deliverable corridor and reports the count', async () => {
    const store = fakeStore();
    const written = await refreshRoutes(disco({}), store, CRYPTO, [BRAZIL], () => undefined);

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

  it('asks for routes with the catalog\'s fiat, so it never re-reads defaults', async () => {
    // Why the fast cadence is affordable: one call per country, not two.
    const probe = vi.fn(async (_c: string, _f: string, _k: string) => corridor('BR'));
    await refreshRoutes({ ...disco({}), corridor: probe }, fakeStore(), CRYPTO, [BRAZIL], () => undefined);

    expect(probe).toHaveBeenCalledWith('BR', 'BRL', CRYPTO);
  });

  it('skips an empty-methods country and keeps its last-known-good row (never deletes on empty)', async () => {
    // Empty can be a swallowed transient failure, so the row is kept.
    const store = fakeStore();
    await store.upsertCorridor({ destination_currency_code: CRYPTO, country: 'BR', name: 'Brazil', fiat: 'BRL', methods: [{ paymentMethodType: 'PIX', category: 'bank', min: '10', max: '5000', currency: 'BRL' }] });

    const written = await refreshRoutes(
      disco({ corridor: async (c) => corridor(c, { methods: [] }) }),
      store,
      CRYPTO,
      [BRAZIL],
      () => undefined,
    );

    expect(written).toBe(0);
    expect((await store.readCorridors(CRYPTO)).map((r) => r.country)).toEqual(['BR']);
  });

  it('skips a country whose probe fails and keeps the rest of the pass', async () => {
    const store = fakeStore();
    const log = vi.fn();
    const written = await refreshRoutes(
      disco({
        corridor: async (c) => {
          if (c === 'BR') throw new Error('429 too many requests');
          return corridor(c, { fiat: 'USD', methods: [method({ paymentMethodType: 'CREDIT_DEBIT_CARD', category: 'card', currency: 'USD' })] });
        },
      }),
      store,
      CRYPTO,
      [BRAZIL, { country: 'US', name: 'United States', fiat: 'USD' }],
      log,
    );

    expect(written).toBe(1);
    expect((await store.readCorridors(CRYPTO)).map((r) => r.country)).toEqual(['US']);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('BR/DOT_ASSETHUB'));
  });

  it('does not start processing a country when the signal is already aborted', async () => {
    const store = fakeStore();
    const probe = vi.fn(async (c: string) => corridor(c));
    const written = await refreshRoutes(
      { ...disco({}), corridor: async (c) => probe(c) },
      store,
      CRYPTO,
      [BRAZIL],
      () => undefined,
      AbortSignal.abort(),
    );

    expect(written).toBe(0);
    expect(probe).not.toHaveBeenCalled();
    expect(await store.readCorridors(CRYPTO)).toEqual([]);
  });

  it('skips the upsert when the signal fires during a probe', async () => {
    const store = fakeStore();
    // Aborted only after the loop-top check: the pre-write checkpoint is the one that catches it.
    const controller = new AbortController();
    const written = await refreshRoutes(
      disco({
        corridor: async (c) => {
          controller.abort();
          return corridor(c);
        },
      }),
      store,
      CRYPTO,
      [BRAZIL],
      () => undefined,
      controller.signal,
    );

    expect(written).toBe(0);
    expect(await store.readCorridors(CRYPTO)).toEqual([]);
  });
});

describe('startSupportedRefresh', () => {
  it('runs the catalog pass before the first routes pass, so routes has something to walk', async () => {
    const order: string[] = [];
    const store = fakeStore();
    const refresh = startSupportedRefresh(
      {
        countries: async () => {
          order.push('countries');
          return [{ country: 'BR', name: 'Brazil' }];
        },
        defaultFiat: async () => {
          order.push('defaults');
          return 'BRL';
        },
        corridor: async (c) => {
          order.push('routes');
          return corridor(c);
        },
      },
      store,
      [CRYPTO],
      NEVER,
      () => undefined,
    );

    await vi.waitFor(async () => {
      expect((await store.readCorridors(CRYPTO)).map((r) => r.country)).toEqual(['BR']);
    });
    await refresh.stop(0);

    expect(order).toEqual(['countries', 'defaults', 'routes']);
  });

  it('gives each pass its own cadence, both unref\'d and signal-bound', async () => {
    // One sleep per pass. `ref: false` replaces `timer.unref()`, the signal ends the loop.
    sleepCalls.length = 0;
    const refresh = startSupportedRefresh(disco({}), fakeStore(), [CRYPTO], { catalogMs: 90_000, routesMs: 30_000 }, () => undefined);
    // The loops only sleep once the immediate boot passes have returned.
    await vi.waitFor(() => {
      expect(sleepCalls).toHaveLength(2);
    });
    await refresh.stop(0);

    expect(sleepCalls.map((c) => c.ms).sort((a, b) => a - b)).toEqual([30_000, 90_000]);
    for (const call of sleepCalls) {
      expect(call.opts.ref).toBe(false);
      expect(call.opts.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it('sleeps its interval after each pass, so a slow pass never banks ticks into a burst', async () => {
    // `timers/promises.setInterval` counts every tick that fires while the consumer is awaiting and
    // then yields them with no gap. A pass slower than its interval would re-run back to back.
    sleepCalls.length = 0;
    let passes = 0;
    const refresh = startSupportedRefresh(
      {
        ...disco({}),
        countries: async () => {
          passes += 1;
          // Far slower than the 10ms cadence: a banking loop would replay the missed ticks at once.
          await new Promise((resolve) => setTimeout(resolve, 60));
          return [{ country: 'BR', name: 'Brazil' }];
        },
      },
      fakeStore(),
      [CRYPTO],
      { catalogMs: 10, routesMs: 100_000 },
      () => undefined,
    );

    await vi.waitFor(() => {
      expect(passes).toBeGreaterThan(1);
    });
    await refresh.stop(0);

    // One sleep armed per completed pass: never a run of them queued up behind a slow one.
    expect(sleepCalls.filter((c) => c.ms === 10).length).toBeLessThanOrEqual(passes);
  });

  it('refreshes routes on its own interval without re-reading the catalog', async () => {
    // Real timers: vitest's fake timers patch the global `setInterval`, not `node:timers/promises`.
    const countries = vi.fn(async () => [{ country: 'BR', name: 'Brazil' }]);
    const probe = vi.fn(async (c: string) => corridor(c));
    const refresh = startSupportedRefresh(
      { ...disco({}), countries, corridor: async (c) => probe(c) },
      fakeStore(),
      [CRYPTO],
      { catalogMs: 100_000, routesMs: 10 },
      () => undefined,
    );

    // Several routes passes while the catalog pass, on its long interval, runs exactly once.
    await vi.waitFor(() => {
      expect(probe.mock.calls.length).toBeGreaterThan(2);
    });
    expect(countries).toHaveBeenCalledTimes(1);

    await refresh.stop(0);
  });

  it('keeps the previous catalog when a later country list fails', async () => {
    // `refreshCatalog` returns undefined on a failed list; the loop must keep what it has.
    let call = 0;
    const store = fakeStore();
    const countries = vi.fn(async () => {
      call += 1;
      if (call > 1) throw new Error('meld down');
      return [{ country: 'BR', name: 'Brazil' }];
    });
    const refresh = startSupportedRefresh(
      { ...disco({}), countries },
      store,
      [CRYPTO],
      { catalogMs: 10, routesMs: 10 },
      () => undefined,
    );

    // The failing catalog passes keep coming, and routes keeps writing from the first one.
    await vi.waitFor(() => {
      expect(countries.mock.calls.length).toBeGreaterThan(2);
    });
    expect((await store.readCorridors(CRYPTO)).map((r) => r.country)).toEqual(['BR']);

    await refresh.stop(0);
  });

  it('rebuilds a catalog the boot pass failed to get, rather than waiting out the slow cadence', async () => {
    // A blip during a deploy would otherwise leave the endpoint empty until the next catalog tick.
    let call = 0;
    const store = fakeStore();
    const refresh = startSupportedRefresh(
      {
        ...disco({}),
        countries: async () => {
          call += 1;
          if (call === 1) throw new Error('meld down at boot');
          return [{ country: 'BR', name: 'Brazil' }];
        },
      },
      store,
      [CRYPTO],
      { catalogMs: 100_000, routesMs: 10 },
      () => undefined,
    );

    await vi.waitFor(async () => {
      expect((await store.readCorridors(CRYPTO)).map((r) => r.country)).toEqual(['BR']);
    });
    await refresh.stop(0);
  });

  it('says so, rather than throwing, when a routes pass finds no catalog', async () => {
    const log = vi.fn();
    const refresh = startSupportedRefresh(
      { ...disco({ countriesThrows: true }) },
      fakeStore(),
      [CRYPTO],
      { catalogMs: 100_000, routesMs: 10 },
      log,
    );

    await vi.waitFor(() => {
      expect(log).toHaveBeenCalledWith(expect.stringContaining('no catalog'));
    });
    await refresh.stop(0);
  });

  it('never overlaps a pass with itself: a slow pass holds its own loop', async () => {
    // A hung boot pass is never awaited past, so neither interval is entered at all.
    sleepCalls.length = 0;
    const countries = vi.fn(() => new Promise<CountryRow[]>(() => undefined));
    const refresh = startSupportedRefresh({ ...disco({}), countries }, fakeStore(), [CRYPTO], { catalogMs: 10, routesMs: 10 }, () => undefined);

    // Ten intervals' worth of real time: every one of them must find the pass still in flight.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(countries).toHaveBeenCalledTimes(1);
    expect(sleepCalls).toHaveLength(0);

    await refresh.stop(0);
  });

  it('logs and gives up cleanly when the boot pass throws, without rejecting the loop', async () => {
    // A logger that throws is the reachable fault. At boot it escapes the pass and the boot guard
    // reports it rather than rejecting `loop`, which would make shutdown itself throw.
    let thrown = false;
    const log = vi.fn((_message: string) => {
      if (thrown) return;
      thrown = true;
      throw new Error('sink is down');
    });
    const refresh = startSupportedRefresh(disco({ countriesThrows: true }), fakeStore(), [CRYPTO], NEVER, log);

    await vi.waitFor(() => {
      expect(log).toHaveBeenCalledWith(expect.stringContaining('loop stopped: sink is down'));
    });
    await refresh.stop(0);
  });

  it('keeps ticking after a periodic pass throws, rather than dying on the first one', async () => {
    // The reachable fault is a throwing logger, fired once inside a periodic catalog pass. The loop
    // must report it and run the next tick, not stop learning for good.
    let threw = false;
    const log = vi.fn((_message: string) => {
      if (threw) return;
      threw = true;
      throw new Error('sink is down');
    });
    let calls = 0;
    const countries = vi.fn(async () => {
      calls += 1;
      // Boot and later ticks succeed; the first periodic tick fails so its log throws.
      if (calls === 2) throw new Error('meld blip');
      return [] as CountryRow[];
    });
    const refresh = startSupportedRefresh(
      { ...disco({}), countries },
      fakeStore(),
      [CRYPTO],
      { catalogMs: 5, routesMs: 100_000 },
      log,
    );

    await vi.waitFor(() => {
      // Reported the fault and kept going: the catalog pass ran again after the throw.
      expect(log).toHaveBeenCalledWith(expect.stringContaining('pass failed, continuing'));
      expect(calls).toBeGreaterThanOrEqual(3);
    });
    await refresh.stop(0);
  });

  it('runs one pass at a time across both loops: a hung catalog pass holds the routes pass', async () => {
    let catalogCalls = 0;
    const hang = new Promise<CountryRow[]>(() => undefined); // never resolves
    const countries = vi.fn(() => {
      catalogCalls += 1;
      // Boot succeeds; the first periodic catalog pass hangs while holding the shared lock.
      return catalogCalls === 1 ? Promise.resolve([{ country: 'BR', name: 'Brazil' }]) : hang;
    });
    const corridorFn = vi.fn(async () => corridor('BR'));
    const refresh = startSupportedRefresh(
      { ...disco({ corridor: corridorFn }), countries },
      fakeStore(),
      [CRYPTO],
      { catalogMs: 5, routesMs: 5 },
      () => undefined,
    );

    // Let boot and the first ticks settle, then the catalog pass is hung holding the lock.
    await new Promise((r) => setTimeout(r, 60));
    const probesWhileHung = corridorFn.mock.calls.length;
    await new Promise((r) => setTimeout(r, 60));
    // No routes probe runs while the catalog pass holds the lock.
    expect(corridorFn.mock.calls.length).toBe(probesWhileHung);
    await refresh.stop(0);
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
    const refresh = startSupportedRefresh({ ...disco({}), countries }, fakeStore(), [CRYPTO], NEVER, () => undefined);

    // The boot pass is blocked on the gate; stop must await it rather than returning early.
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
    const refresh = startSupportedRefresh({ ...disco({}), countries }, fakeStore(), ['A', 'B'], NEVER, () => undefined);

    // The pass is blocked mid crypto 'A'; stopping must skip crypto 'B' entirely.
    await new Promise((resolve) => setTimeout(resolve, 10));
    const stopped = refresh.stop(5_000);
    release?.();
    await stopped;

    expect(countries).toHaveBeenCalledWith('A');
    expect(countries).not.toHaveBeenCalledWith('B');
  });

  it('stop returns within the grace window even if a pass is hung on a single Meld call', async () => {
    // Stop breaks at country boundaries only; a hung in-flight call is bounded by grace.
    const countries = vi.fn(async () => [{ country: 'BR', name: 'Brazil' }]);
    const defaultFiat = vi.fn(() => new Promise<string>(() => undefined));
    const refresh = startSupportedRefresh({ ...disco({}), countries, defaultFiat }, fakeStore(), [CRYPTO], NEVER, () => undefined);

    // Let the boot pass reach the hung defaults call.
    await new Promise((resolve) => setTimeout(resolve, 10));

    const start = Date.now();
    await refresh.stop(50);
    expect(Date.now() - start).toBeLessThan(2_000);
  });

  it('returns at once when no pass is in flight, without waiting out the grace window', async () => {
    const refresh = startSupportedRefresh(disco({}), fakeStore(), [CRYPTO], NEVER, () => undefined);
    // Let the boot passes finish, so stop sees nothing in flight.
    await new Promise((resolve) => setTimeout(resolve, 10));

    // stop must return promptly, not sit on the 5s grace.
    let waited = false;
    const tripwire = setTimeout(() => {
      waited = true;
    }, 50);
    await refresh.stop(5_000);
    clearTimeout(tripwire);
    expect(waited).toBe(false);
  });
});
