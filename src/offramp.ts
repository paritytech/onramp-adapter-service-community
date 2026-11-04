/**
 * Merging sell corridors across offramp lanes.
 *
 * A seller picks a country and a payout method, not a lane. Several lanes may serve the same
 * method; the method lists every lane that offers it (in configuration order), each with its own
 * limits, so the client can pick the lane. The method's own min/max span all of them.
 */

import type { Availability, WithAvailability } from './health/view.js';
import type { MethodLimit } from './meld/discovery.js';
import { widestBound } from './money.js';

export interface OfframpLane {
  /** This service's own name for the asset, which a Meld rename does not change. */
  readonly asset: string;
  /** Meld's current code for it, the one a quote or session for this lane must send. */
  readonly code: string;
  readonly chain: string;
}

type Method = Omit<MethodLimit, 'providers'>;

/** One lane's offer of a payout method, with that lane's own limits. */
export interface OfframpLaneOffer extends OfframpLane {
  min: string;
  max: string;
  currency: string;
  availability: Availability;
}

export interface OfframpMethod {
  paymentMethodType: string;
  category: Method['category'];
  /** The smallest minimum of the available lanes, or of every lane when none is. Exact decimal text. */
  min: string;
  /** The largest maximum, chosen like `min`. */
  max: string;
  currency: string;
  /** Available when one lane is. */
  availability: Availability;
  lanes: OfframpLaneOffer[];
}

/** One lane's view of a country. */
export interface LaneCorridor {
  lane: OfframpLane;
  country: string;
  name?: string;
  fiat: string;
  methods: readonly WithAvailability<Method>[];
}

export interface OfframpCorridor {
  country: string;
  name: string;
  fiat: string;
  methods: OfframpMethod[];
}

/**
 * Merge one country's per-lane views (in lane order). Every lane offering a method is kept; method
 * order is first-seen; `currency` is the country fiat when given.
 */
export function mergeMethods(views: readonly LaneCorridor[], fiat?: string): OfframpMethod[] {
  const merged = new Map<
    string,
    Omit<OfframpMethod, 'min' | 'max' | 'availability' | 'lanes'> & { lanes: [OfframpLaneOffer, ...OfframpLaneOffer[]] }
  >();
  for (const view of views) {
    for (const method of view.methods) {
      const offer: OfframpLaneOffer = {
        asset: view.lane.asset,
        code: view.lane.code,
        chain: view.lane.chain,
        min: method.min,
        max: method.max,
        currency: method.currency,
        availability: method.availability,
      };
      const existing = merged.get(method.paymentMethodType);
      if (existing === undefined) {
        merged.set(method.paymentMethodType, {
          paymentMethodType: method.paymentMethodType,
          category: method.category,
          currency: fiat ?? method.currency,
          lanes: [offer],
        });
      } else {
        existing.lanes.push(offer);
      }
    }
  }
  return [...merged.values()].map((method) => {
    const [first, ...rest] = method.lanes.filter((lane) => lane.availability === 'available');
    return first === undefined
      ? { ...method, ...widestBound(method.lanes), availability: 'temporarily_unavailable' as const }
      : { ...method, ...widestBound([first, ...rest]), availability: 'available' as const };
  });
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
    out.push({ country, name: first.name ?? country, fiat: first.fiat, methods: mergeMethods(views, first.fiat) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name) || a.country.localeCompare(b.country));
}
