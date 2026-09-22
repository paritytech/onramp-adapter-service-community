// Background job filling the supported-corridors cache from Meld; single-writer only at replicaCount:1.

import { setTimeout as sleep } from 'node:timers/promises';

import type { Discovery } from '../meld/discovery.js';
import { toCorridorDto } from '../meld/discovery.js';
import type { FundingStore } from '../funding/store.js';
import type { Direction } from '../rail.js';

export type SupportedStore = Pick<FundingStore, 'upsertCorridor'>;
export type SupportedDiscovery = Pick<Discovery, 'countries' | 'corridor' | 'defaultFiat'>;

/** A country the routes pass will probe, with the fiat the catalog pass resolved for it. */
export interface CatalogEntry {
  country: string;
  name: string;
  fiat: string;
}

/**
 * One (crypto, direction) the refresh enumerates. A crypto that sells is not necessarily one that
 * buys and vice versa (a corridor is asked for per direction; see `meld/discovery.ts`), so the
 * refresh is driven by an explicit list of jobs rather than a bare crypto list crossed silently
 * with every direction this build knows about -- an operator who wires only a buy job for an asset
 * gets no sell refresh for it, on purpose, rather than a refresh that probes a direction nobody
 * asked for.
 */
export interface RefreshJob {
  readonly crypto: string;
  readonly direction: Direction;
}

/** The in-memory catalog map's key: one slot per (direction, crypto), never shared between them. */
const jobKey = (job: RefreshJob): string => `${job.direction}|${job.crypto}`;

export interface RefreshIntervals {
  /** Countries + default fiat. Meld calls both rarely-changing. */
  catalogMs: number;
  /** Routes, which carry the limits. */
  routesMs: number;
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const isAbort = (error: unknown): boolean => error instanceof Error && error.name === 'AbortError';

/**
 * Which countries exist, and what fiat each uses.
 *
 * `undefined`, not `[]`, when the country list itself failed: `[]` would mean Meld serves nowhere
 * and would retire a working catalog over one bad call.
 */
export async function refreshCatalog(
  discovery: SupportedDiscovery,
  job: RefreshJob,
  log: (message: string) => void,
  signal?: AbortSignal,
  previous: readonly CatalogEntry[] = [],
): Promise<CatalogEntry[] | undefined> {
  const { crypto, direction } = job;
  let countries;
  try {
    countries = await discovery.countries(crypto, direction);
  } catch (error) {
    log(`supported refresh could not list ${direction} countries for ${crypto}: ${message(error)}`);
    return undefined;
  }

  // Through a call, not the property: TS narrows `signal.aborted` to false after the first check.
  const stopped = (): boolean => signal?.aborted === true;
  const known = new Map(previous.map((entry) => [entry.country, entry]));

  const catalog: CatalogEntry[] = [];
  let failed = 0;
  for (const { country, name } of countries) {
    if (stopped()) break;
    try {
      const fiat = await discovery.defaultFiat(country, direction);
      // Meld names no fiat here: legitimately not deliverable, so let the row drop.
      if (fiat === '') continue;
      catalog.push({ country, name, fiat });
    } catch (error) {
      // The defaults call failed. Keep the last known entry rather than dropping a good country over a blip.
      failed += 1;
      const prior = known.get(country);
      if (prior !== undefined) catalog.push(prior);
      log(`supported refresh could not resolve the ${direction} default fiat for ${country}, keeping the last known: ${message(error)}`);
    }
  }
  // A pass cut short by shutdown returns a partial or empty list; keep the previous catalog rather
  // than clobbering it with a truncated one.
  if (stopped()) return undefined;
  // A defaults-wide failure with nothing to fall back on is indistinguishable from a real empty
  // catalog and far likelier, so treat it as a failed read: the caller keeps its previous catalog.
  //
  // On `sell` the fiat comes from Meld's `fiat-limits` catalog rather than a per-country defaults
  // call (see `MeldDiscovery.defaultFiat`), so an empty catalog there reads the same way: a
  // genuinely-empty sell catalog and an empty `fiat-limits` response are indistinguishable from
  // here, exactly as they are on `buy`.
  if (countries.length > 0 && catalog.length === 0 && failed > 0) {
    log(
      `supported refresh could not resolve any ${direction} default fiat across ${String(countries.length)} countries in ${crypto}`,
    );
    return undefined;
  }
  return catalog;
}

/**
 * The routes, and their limits, for a catalog the slow pass produced. One call per country, the
 * fiat already known, which is what makes this cadence affordable.
 *
 * Upsert-only: empty `methods` is also what a swallowed transient failure looks like, so the last
 * known-good row stays and `readCorridors`' freshness window retires it instead.
 */
export async function refreshRoutes(
  discovery: SupportedDiscovery,
  store: SupportedStore,
  job: RefreshJob,
  catalog: readonly CatalogEntry[],
  log: (message: string) => void,
  signal?: AbortSignal,
): Promise<number> {
  const { crypto, direction } = job;
  const stopped = (): boolean => signal?.aborted === true;

  let written = 0;
  for (const { country, name, fiat } of catalog) {
    if (stopped()) break;
    try {
      const corridor = await discovery.corridor(country, fiat, crypto, direction);
      const methods = toCorridorDto(corridor).methods;
      if (methods.length === 0) continue;
      // Abort may have arrived during the probe; do not write once shutdown has begun.
      if (stopped()) break;
      await store.upsertCorridor({ destination_currency_code: crypto, direction, country, name, fiat: corridor.fiat, methods });
      written += 1;
    } catch (error) {
      log(`supported refresh skipped ${direction} ${country}/${crypto}: ${message(error)}`);
    }
  }
  return written;
}

/**
 * Drive both passes on their own intervals; returns `stop()`.
 *
 * At boot the catalog pass runs first so the routes pass has something to walk. Each loop sleeps its
 * interval after its previous pass returns, and a shared lock serialises the two loops, so a catalog
 * pass and a routes pass never hit Meld at the same time and no pass overlaps another.
 * `{ ref: false }` is `timer.unref()`; one `AbortController` serves both loops and every pass.
 */
export function startSupportedRefresh(
  discovery: SupportedDiscovery,
  store: SupportedStore,
  jobs: readonly RefreshJob[],
  intervals: RefreshIntervals,
  log: (message: string) => void,
): { stop: (graceMs?: number) => Promise<void> } {
  const controller = new AbortController();
  const { signal } = controller;

  // In memory: the catalog pass runs at boot, so a restart rebuilds this before routes needs it.
  // Keyed by (direction, crypto): a buy job and a sell job for the same crypto walk two different
  // country lists (see `MeldDiscovery.countries`) and must never share a slot.
  const catalogs = new Map<string, CatalogEntry[]>();

  const catalogPass = async (): Promise<void> => {
    for (const job of jobs) {
      if (signal.aborted) break;
      // The previous catalog feeds the carry-forward for a country whose defaults call fails.
      const catalog = await refreshCatalog(discovery, job, log, signal, catalogs.get(jobKey(job)) ?? []);
      // Keep the previous catalog on a failed read.
      if (catalog !== undefined) catalogs.set(jobKey(job), catalog);
    }
  };

  const routesPass = async (): Promise<void> => {
    for (const job of jobs) {
      if (signal.aborted) break;
      let catalog = catalogs.get(jobKey(job));
      // The boot catalog pass failed. Rebuild here rather than waiting out `catalogMs`, which
      // would leave the endpoint empty for a day over a blip during a deploy.
      if (catalog === undefined) {
        catalog = await refreshCatalog(discovery, job, log, signal, []);
        if (catalog !== undefined) catalogs.set(jobKey(job), catalog);
      }
      if (catalog === undefined) {
        log(`supported refresh has no catalog for ${job.direction} ${job.crypto} yet; skipping its routes pass`);
        continue;
      }
      await refreshRoutes(discovery, store, job, catalog, log, signal);
    }
  };

  // The abort from `stop` is how these end; anything else is a fault. Both are swallowed so `stop`
  // never awaits a rejected `loop`, which would make shutdown itself throw.
  const guarded = async (body: () => Promise<void>): Promise<void> => {
    try {
      await body();
    } catch (error) {
      if (!isAbort(error)) log(`supported refresh loop stopped: ${message(error)}`);
    }
  };

  // One pass runs at a time across both loops, so a catalog and a routes pass never hit Meld together.
  let chain: Promise<void> = Promise.resolve();
  const exclusive = (pass: () => Promise<void>): Promise<void> => {
    const next = chain.then(pass, pass);
    chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  const every = (ms: number, pass: () => Promise<void>): Promise<void> =>
    // Re-armed after each pass, not `interval()`: that generator banks every tick that fires while
    // the consumer is awaiting and then yields them back to back with no gap, so a pass outrunning
    // its interval would burst Meld calls exactly when Meld is already slow.
    guarded(async () => {
      for (;;) {
        await sleep(ms, undefined, { signal, ref: false });
        try {
          await exclusive(pass);
        } catch (error) {
          // A pass never throws the stop abort: it returns early, and the abort ends this loop through
          // the `sleep` above. Any other fault is logged and the loop keeps ticking.
          log(`supported refresh pass failed, continuing: ${message(error)}`);
        }
      }
    });

  const loop = (async () => {
    await guarded(async () => {
      await catalogPass();
      await routesPass();
    });
    await Promise.all([every(intervals.catalogMs, catalogPass), every(intervals.routesMs, routesPass)]);
  })();

  return {
    stop: async (graceMs = 5_000) => {
      // Halt at the next country boundary so no upsert races the pool close; grace bounds a hung call.
      controller.abort();
      if (graceMs <= 0) return;
      const grace = new AbortController();
      try {
        await Promise.race([
          loop,
          // `.catch` because aborting the grace timer below rejects it after the race settled.
          sleep(graceMs, undefined, { signal: grace.signal, ref: false }).catch(() => undefined),
        ]);
      } finally {
        grace.abort();
      }
    },
  };
}
