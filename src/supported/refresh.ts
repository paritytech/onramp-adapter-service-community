// Background job that fills the supported-corridors cache from Meld; single-writer only at replicaCount:1.

import type { Discovery } from '../meld/discovery.js';
import { toCorridorDto } from '../meld/discovery.js';
import type { FundingStore } from '../funding/store.js';

/** The store surface the refresh writes through. */
export type SupportedStore = Pick<FundingStore, 'upsertCorridor'>;

/** The discovery surface the refresh reads through. */
export type SupportedDiscovery = Pick<Discovery, 'countries' | 'corridorForCountry'>;

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

// One pass per crypto: upsert deliverable corridors, upsert-only (empty never deletes), shouldStop halts at a country boundary.
export async function refreshOnce(
  discovery: SupportedDiscovery,
  store: SupportedStore,
  crypto: string,
  log: (message: string) => void,
  shouldStop: () => boolean = () => false,
): Promise<number> {
  let countries;
  try {
    countries = await discovery.countries(crypto);
  } catch (error) {
    log(`supported refresh could not list countries for ${crypto}: ${message(error)}`);
    return 0;
  }

  let written = 0;
  for (const { country, name } of countries) {
    if (shouldStop()) break;
    try {
      const corridor = await discovery.corridorForCountry(country, crypto);
      const methods = toCorridorDto(corridor).methods;
      // Empty means not deliverable now, or a swallowed transient failure. Skip either way.
      if (methods.length === 0) continue;
      // Stop may have arrived during the probe; do not write once shutdown has begun.
      if (shouldStop()) break;
      await store.upsertCorridor({ destination_currency_code: crypto, country, name, fiat: corridor.fiat, methods });
      written += 1;
    } catch (error) {
      log(`supported refresh skipped ${country}/${crypto}: ${message(error)}`);
    }
  }
  return written;
}

// Drive refreshOnce on an interval (unref'd, non-overlapping) plus one immediate pass; returns stop().
export function startSupportedRefresh(
  discovery: SupportedDiscovery,
  store: SupportedStore,
  cryptos: readonly string[],
  intervalMs: number,
  log: (message: string) => void,
): { stop: (graceMs?: number) => Promise<void> } {
  let inFlight: Promise<void> | undefined;
  let stopping = false;
  const run = (): void => {
    if (inFlight !== undefined) return; // a prior pass is still running; don't stack on it
    // refreshOnce never rejects (it logs and swallows), so no catch is needed here.
    inFlight = (async () => {
      for (const crypto of cryptos) {
        if (stopping) break;
        await refreshOnce(discovery, store, crypto, log, () => stopping);
      }
    })().finally(() => {
      inFlight = undefined;
    });
  };

  const timer = setInterval(run, intervalMs);
  timer.unref();
  run(); // initial populate, off the request path

  return {
    stop: async (graceMs = 5_000) => {
      // Halt at the next country boundary so no upsert races the pool close; grace below bounds a hung Meld call.
      stopping = true;
      clearInterval(timer);
      // graceMs 0 means no wait and no timer (racing setTimeout(...,0) hangs under the tests' fake timers).
      if (inFlight !== undefined && graceMs > 0) {
        let timeout: NodeJS.Timeout | undefined;
        await Promise.race([
          inFlight,
          new Promise<void>((resolve) => {
            timeout = setTimeout(resolve, graceMs);
          }),
        ]);
        if (timeout !== undefined) clearTimeout(timeout);
      }
    },
  };
}
