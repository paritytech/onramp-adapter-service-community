/**
 * Merging sell corridors across offramp lanes.
 *
 * A seller picks a country and a payout method, not a lane. Several lanes may serve the same
 * method; the method lists every lane that offers it (in configuration order), each with its own
 * limits, so the client can pick the lane. The method's own min/max span all of them.
 */

import type { MethodLimit } from './meld/discovery.js';

export interface OfframpLane {
  readonly code: string;
  readonly chain: string;
}

type Method = Omit<MethodLimit, 'providers'>;

/** One lane's offer of a payout method, with that lane's own limits. */
export interface OfframpLaneOffer extends OfframpLane {
  min: string;
  max: string;
  currency: string;
}

export interface OfframpMethod {
  paymentMethodType: string;
  category: Method['category'];
  /** The smallest lane minimum. Exact decimal text. */
  min: string;
  /** The largest lane maximum. Exact decimal text. */
  max: string;
  currency: string;
  lanes: OfframpLaneOffer[];
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

const DECIMAL = /^(\d+)(?:\.(\d+))?$/;

/** Exact comparison of two non-negative decimal strings, -1 | 0 | 1. Unparseable text sorts as 0. */
function compareDecimal(a: string, b: string): number {
  const [pa, pb] = [DECIMAL.exec(a), DECIMAL.exec(b)];
  const scale = Math.max(pa?.[2]?.length ?? 0, pb?.[2]?.length ?? 0);
  const big = (m: RegExpExecArray | null): bigint => BigInt((m?.[1] ?? '0') + (m?.[2] ?? '').padEnd(scale, '0'));
  const [x, y] = [big(pa), big(pb)];
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * Merge one country's per-lane views, given in lane order. Every lane offering a method is kept;
 * method order is first-seen, and the method's `currency` is the country fiat when given. Empty when no lane has a method.
 */
export function mergeMethods(views: readonly LaneCorridor[], fiat?: string): OfframpMethod[] {
  const merged = new Map<string, OfframpMethod>();
  for (const view of views) {
    for (const method of view.methods) {
      const offer: OfframpLaneOffer = {
        code: view.lane.code,
        chain: view.lane.chain,
        min: method.min,
        max: method.max,
        currency: method.currency,
      };
      const existing = merged.get(method.paymentMethodType);
      if (existing === undefined) {
        merged.set(method.paymentMethodType, {
          paymentMethodType: method.paymentMethodType,
          category: method.category,
          min: method.min,
          max: method.max,
          currency: fiat ?? method.currency,
          lanes: [offer],
        });
        continue;
      }
      existing.lanes.push(offer);
      if (compareDecimal(method.min, existing.min) < 0) existing.min = method.min;
      if (compareDecimal(method.max, existing.max) > 0) existing.max = method.max;
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
    out.push({ country, name: first.name ?? country, fiat: first.fiat, methods: mergeMethods(views, first.fiat) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name) || a.country.localeCompare(b.country));
}
