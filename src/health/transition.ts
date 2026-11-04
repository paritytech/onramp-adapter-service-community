import type { ProviderHealthRow } from '../funding/store.js';
import type { ProbeResult } from './classify.js';

export type HealthKey = Pick<ProviderHealthRow, 'provider' | 'direction' | 'category' | 'scope'>;

export const keyOf = ({ provider, direction, category, scope }: HealthKey): string => `${provider}|${direction}|${category}|${scope}`;

type Down = Extract<ProbeResult, { outcome: 'down' }>;

const isDown = (result: ProbeResult): result is Down => result.outcome === 'down';

/**
 * The health one round of probes leaves `key` in, or `undefined` when the round proves nothing.
 *
 * One `up` answer clears the provider. The round fails only when every target answered `down`, and
 * `failuresToDown` consecutive failed rounds mark the provider down. `unknown` and `throttled`
 * answers never move the state, so a probe that cannot run leaves the provider as it was.
 */
export function nextHealth(
  key: HealthKey,
  previous: ProviderHealthRow | undefined,
  results: readonly ProbeResult[],
  now: number,
  failuresToDown: number,
  expiresAt: number,
): ProviderHealthRow | undefined {
  const kept = {
    last_ok_at: previous?.last_ok_at ?? null,
    last_failed_at: previous?.last_failed_at ?? null,
    last_code: previous?.last_code ?? null,
    last_request_id: previous?.last_request_id ?? null,
  };
  if (results.some((result) => result.outcome === 'up')) {
    return { ...key, ...kept, state: 'up', failures: 0, last_ok_at: now, updated_at: now, expires_at: expiresAt };
  }
  const down = results.filter(isDown);
  const [first] = down;
  if (first === undefined || down.length !== results.length) return undefined;
  const failures = (previous?.failures ?? 0) + 1;
  return {
    ...key,
    ...kept,
    state: failures >= failuresToDown ? 'down' : (previous?.state ?? 'up'),
    failures,
    last_failed_at: now,
    last_code: first.code,
    last_request_id: first.requestId ?? null,
    updated_at: now,
    expires_at: expiresAt,
  };
}

/**
 * `previous` with a pending failure cleared, for a round that proved nothing, so a later failure
 * is confirmed again rather than counted with an older one. The state and expiry stay as they were.
 */
export function clearPending(previous: ProviderHealthRow | undefined): ProviderHealthRow | undefined {
  return previous?.state === 'up' && previous.failures > 0 ? { ...previous, failures: 0 } : undefined;
}
