import { describe, expect, it } from 'vitest';

import type { ProviderHealthRow } from '../../src/funding/store.js';
import type { ProbeResult } from '../../src/health/classify.js';
import { clearPending, nextHealth, type HealthKey } from '../../src/health/transition.js';

const KEY: HealthKey = { provider: 'BANXA', direction: 'buy', category: 'card', scope: 'global' };
const UP: ProbeResult = { outcome: 'up' };
const DOWN: ProbeResult = { outcome: 'down', code: 'INCOMPATIBLE_REQUEST' };
const UNKNOWN: ProbeResult = { outcome: 'unknown', code: 'UNREACHABLE' };
const THROTTLED: ProbeResult = { outcome: 'throttled', code: 'HTTP_503' };

const step = (previous: ProviderHealthRow | undefined, results: ProbeResult[], now: number) =>
  nextHealth(KEY, previous, results, now, 2, now + 100);

describe('nextHealth', () => {
  it('records a first successful round as up', () => {
    expect(step(undefined, [UP, UP], 1)).toEqual({
      ...KEY,
      state: 'up',
      failures: 0,
      last_ok_at: 1,
      last_failed_at: null,
      last_code: null,
      last_request_id: null,
      updated_at: 1,
      expires_at: 101,
    });
  });

  it('marks a provider down after two failed rounds, not one', () => {
    const once = step(undefined, [DOWN, DOWN], 1);
    expect(once).toMatchObject({ state: 'up', failures: 1, last_failed_at: 1, last_code: 'INCOMPATIBLE_REQUEST' });
    expect(step(once, [DOWN, DOWN], 2)).toMatchObject({ state: 'down', failures: 2, last_failed_at: 2, expires_at: 102 });
  });

  it('records the request ID of the failure it counted', () => {
    expect(step(undefined, [{ ...DOWN, requestId: 'req-1' }, DOWN], 1)).toMatchObject({ last_request_id: 'req-1' });
  });

  it('keeps a down provider down while it keeps failing', () => {
    const down = step(step(undefined, [DOWN, DOWN], 1), [DOWN, DOWN], 2);
    expect(step(down, [DOWN, DOWN], 3)).toMatchObject({ state: 'down', failures: 3 });
  });

  it('brings a provider back up on one success and keeps the last failure for diagnosis', () => {
    const down = step(step(undefined, [DOWN, DOWN], 1), [DOWN, DOWN], 2);
    expect(step(down, [UP], 3)).toMatchObject({
      state: 'up',
      failures: 0,
      last_ok_at: 3,
      last_failed_at: 2,
      last_code: 'INCOMPATIBLE_REQUEST',
    });
  });

  it('clears a round when one region answers, though the other is down', () => {
    expect(step(undefined, [DOWN, UP], 1)).toMatchObject({ state: 'up', failures: 0 });
  });

  it.each([
    ['no answers', []],
    ['only unknown answers', [UNKNOWN, UNKNOWN]],
    ['only throttled answers', [THROTTLED]],
    ['one region down and one unknown', [DOWN, UNKNOWN]],
  ] as const)('changes nothing on %s', (_label, results) => {
    const previous = step(undefined, [DOWN, DOWN], 1);
    expect(step(previous, [...results], 2)).toBeUndefined();
  });
});

describe('clearPending', () => {
  it('clears the failure an up provider was waiting to confirm, and nothing else', () => {
    const once = step(undefined, [DOWN, DOWN], 1);
    expect(clearPending(once)).toEqual({ ...once, failures: 0 });
  });

  it('leaves a provider without a pending failure, or already down, as it is', () => {
    const down = step(step(undefined, [DOWN, DOWN], 1), [DOWN, DOWN], 2);
    expect(clearPending(undefined)).toBeUndefined();
    expect(clearPending(step(undefined, [UP], 1))).toBeUndefined();
    expect(clearPending(down)).toBeUndefined();
  });
});
