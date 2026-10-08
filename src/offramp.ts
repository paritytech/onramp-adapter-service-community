/**
 * Merging sell corridors across offramp lanes.
 *
 * A seller picks a country and a payout method, not a lane. Several lanes may serve the same
 * method; the first lane in configuration order that offers it wins, with its own limits and
 * currency, and the method is tagged with that lane so the client knows what to send.
 */

import type { MethodLimit } from './meld/discovery.js';

export interface OfframpLane {
  readonly code: string;
  readonly chain: string;
}

type Method = Omit<MethodLimit, 'providers'>;

export interface OfframpMethod extends Method {
  lane: OfframpLane;
}

/** One lane's view of a country. */
export interface LaneCorridor {
  lane: OfframpLane;
  country: string;
  name?: string;
  fiat: string;
  methods: readonly Method[];
}

export interface OfframpCorridor {
  country: string;
  name: string;
  fiat: string;
  methods: OfframpMethod[];
}

/** Merge one country's per-lane views, given in lane order. Empty when no lane has a method. */
export function mergeMethods(views: readonly LaneCorridor[]): OfframpMethod[] {
  const merged = new Map<string, OfframpMethod>();
  for (const view of views) {
    for (const method of view.methods) {
      if (merged.has(method.paymentMethodType)) continue;
      merged.set(method.paymentMethodType, {
        paymentMethodType: method.paymentMethodType,
        category: method.category,
        min: method.min,
        max: method.max,
        currency: method.currency,
        lane: { code: view.lane.code, chain: view.lane.chain },
      });
    }
  }
  return [...merged.values()];
}

/**
 * Merge every lane's cached rows into one list: the union of countries, name and fiat from the
 * first lane row that has the country, ordered by name then country.
 */
export function mergeOfframpCorridors(rows: readonly LaneCorridor[]): OfframpCorridor[] {
  const byCountry = new Map<string, LaneCorridor[]>();
  for (const row of rows) {
    const list = byCountry.get(row.country);
    if (list === undefined) byCountry.set(row.country, [row]);
    else list.push(row);
  }
  const out: OfframpCorridor[] = [];
  for (const [country, views] of byCountry) {
    const first = views[0] as LaneCorridor;
    out.push({ country, name: first.name ?? country, fiat: first.fiat, methods: mergeMethods(views) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name) || a.country.localeCompare(b.country));
}
