import type { ProviderHealthRow, StoredMethod, SupportedCorridorRow } from '../funding/store.js';
import type { Corridor, MethodCategory, MethodLimit, ProviderLimit } from '../meld/discovery.js';
import { widestBound, type Bound } from '../money.js';
import type { Direction } from '../rail.js';
import { keyOf } from './transition.js';
import { GLOBAL_SCOPE } from './types.js';

/** Whether a client can use a method now. */
export type Availability = 'available' | 'temporarily_unavailable';

export type WithAvailability<T> = T & { availability: Availability };

export interface HealthView {
  /**
   * `method` bounded by its providers that are not down. Unchanged while none is down or none is
   * stored; with every provider down it keeps its bound and is `temporarily_unavailable`. `chosen`,
   * a provider taken from a live offer, never counts as down: that offer is fresher evidence than
   * a probe.
   */
  apply<M extends Bound & { category: MethodCategory }>(
    method: M,
    providers: readonly ProviderLimit[] | undefined,
    direction: Direction,
    country: string,
    chosen?: string,
  ): WithAvailability<M>;
}

/**
 * Provider health as of `now`. A `down` row past its expiry counts as up: when probes stop
 * reaching conclusions, every provider is served again rather than one being hidden indefinitely.
 */
export function healthView(rows: readonly ProviderHealthRow[], now: number): HealthView {
  const down = new Set(rows.filter((row) => row.state === 'down' && now < row.expires_at).map(keyOf));
  const isDown = (provider: string, direction: Direction, category: MethodCategory, country: string): boolean =>
    down.has(keyOf({ provider, direction, category, scope: GLOBAL_SCOPE })) || down.has(keyOf({ provider, direction, category, scope: country }));
  return {
    apply: (method, providers = [], direction, country, chosen) => {
      const [first, ...rest] = providers.filter((p) => p.provider === chosen || !isDown(p.provider, direction, method.category, country));
      if (first === undefined) return { ...method, availability: providers.length === 0 ? 'available' : 'temporarily_unavailable' };
      if (rest.length + 1 === providers.length) return { ...method, availability: 'available' };
      return { ...method, ...widestBound([first, ...rest]), availability: 'available' };
    },
  };
}

/** A view in which every provider is up. */
export const NO_HEALTH: HealthView = healthView([], 0);

/** A live corridor's methods as a client sees them. */
export const liveMethods = (view: HealthView, corridor: Corridor, direction: Direction): WithAvailability<Omit<MethodLimit, 'providers'>>[] =>
  corridor.methods.map(({ providers, ...method }) => view.apply(method, providers, direction, corridor.country));

/** A stored corridor's methods as a client sees them. */
export function storedMethods(view: HealthView, row: SupportedCorridorRow): WithAvailability<StoredMethod>[] {
  const providers = new Map((row.method_providers ?? []).map((entry) => [entry.paymentMethodType, entry.providers]));
  return row.methods.map((method) => view.apply(method, providers.get(method.paymentMethodType), row.direction, row.country));
}
