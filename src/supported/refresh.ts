// Background job filling the supported-corridors cache from Meld; single-writer only at replicaCount:1.

import { setTimeout as sleep } from 'node:timers/promises';

import type { Discovery } from '../meld/discovery.js';
import { toCorridorDto } from '../meld/discovery.js';
import type { FundingStore } from '../funding/store.js';

export type SupportedStore = Pick<FundingStore, 'upsertCorridor'>;
export type SupportedDiscovery = Pick<Discovery, 'countries' | 'corridor' | 'defaultFiat'>;

/** A country the routes pass will probe, with the fiat the catalog pass resolved for it. */
export interface CatalogEntry {
  country: string;
  name: string;
  fiat: string;
}

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
  crypto: string,
  log: (message: string) => void,
  signal?: AbortSignal,
): Promise<CatalogEntry[] | undefined> {
  let countries;
  try {
    countries = await discovery.countries(crypto);
  } catch (error) {
    log(`supported refresh could not list countries for ${crypto}: ${message(error)}`);
    return undefined;
  }

  // Through a call, not the property: TS narrows `signal.aborted` to false after the first check.
  const stopped = (): boolean => signal?.aborted === true;

  const catalog: CatalogEntry[] = [];
  for (const { country, name } of countries) {
    if (stopped()) break;
    try {
      const fiat = await discovery.defaultFiat(country);
      // No fiat, no routes URL to build. Not an error.
      if (fiat === '') continue;
      catalog.push({ country, name, fiat });
    } catch (error) {
      log(`supported refresh could not resolve the default fiat for ${country}: ${message(error)}`);
    }
  }
  // `defaultFiat` reports a failed call as `''`, so a defaults-wide outage looks like "no country
  // has a fiat". Indistinguishable from a real empty catalog, and far likelier, so treat it as a
  // failed read: the caller keeps its previous catalog instead of retiring every corridor.
  if (countries.length > 0 && catalog.length === 0) {
    log(`supported refresh resolved no default fiat for any of ${String(countries.length)} countries in ${crypto}`);
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
  crypto: string,
  catalog: readonly CatalogEntry[],
  log: (message: string) => void,
  signal?: AbortSignal,
): Promise<number> {
  const stopped = (): boolean => signal?.aborted === true;

  let written = 0;
  for (const { country, name, fiat } of catalog) {
    if (stopped()) break;
    try {
      const corridor = await discovery.corridor(country, fiat, crypto);
      const methods = toCorridorDto(corridor).methods;
      if (methods.length === 0) continue;
      // Abort may have arrived during the probe; do not write once shutdown has begun.
      if (stopped()) break;
      await store.upsertCorridor({ destination_currency_code: crypto, country, name, fiat: corridor.fiat, methods });
      written += 1;
    } catch (error) {
      log(`supported refresh skipped ${country}/${crypto}: ${message(error)}`);
    }
  }
  return written;
}

/**
 * Drive both passes on their own intervals; returns `stop()`.
 *
 * At boot the catalog pass runs first so the routes pass has something to walk. Each loop sleeps
 * its interval *after* its previous pass returns, so passes never overlap and never burst.
 * `{ ref: false }` is `timer.unref()`; one `AbortController` serves both loops and every pass.
 */
export function startSupportedRefresh(
  discovery: SupportedDiscovery,
  store: SupportedStore,
  cryptos: readonly string[],
  intervals: RefreshIntervals,
  log: (message: string) => void,
): { stop: (graceMs?: number) => Promise<void> } {
  const controller = new AbortController();
  const { signal } = controller;

  // In memory: the catalog pass runs at boot, so a restart rebuilds this before routes needs it.
  const catalogs = new Map<string, CatalogEntry[]>();

  const catalogPass = async (): Promise<void> => {
    for (const crypto of cryptos) {
      if (signal.aborted) break;
      const catalog = await refreshCatalog(discovery, crypto, log, signal);
      // Keep the previous catalog on a failed read.
      if (catalog !== undefined) catalogs.set(crypto, catalog);
    }
  };

  const routesPass = async (): Promise<void> => {
    for (const crypto of cryptos) {
      if (signal.aborted) break;
      let catalog = catalogs.get(crypto);
      // The boot catalog pass failed. Rebuild here rather than waiting out `catalogMs`, which
      // would leave the endpoint empty for a day over a blip during a deploy.
      if (catalog === undefined) {
        catalog = await refreshCatalog(discovery, crypto, log, signal);
        if (catalog !== undefined) catalogs.set(crypto, catalog);
      }
      if (catalog === undefined) {
        log(`supported refresh has no catalog for ${crypto} yet; skipping its routes pass`);
        continue;
      }
      await refreshRoutes(discovery, store, crypto, catalog, log, signal);
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

  const every = (ms: number, pass: () => Promise<void>): Promise<void> =>
    // Re-armed after each pass, not `interval()`: that generator banks every tick that fires while
    // the consumer is awaiting and then yields them back to back with no gap, so a pass outrunning
    // its interval would burst Meld calls exactly when Meld is already slow.
    guarded(async () => {
      for (;;) {
        await sleep(ms, undefined, { signal, ref: false });
        await pass();
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
