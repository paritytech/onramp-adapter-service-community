import { setTimeout as sleep } from 'node:timers/promises';

import { isAbort, message, serial, stopWithin, type Serial } from '../background.js';
import type { FundingStore, ProviderHealthRow } from '../funding/store.js';
import type { MeldClient } from '../meld/client.js';
import type { RefreshJob } from '../supported/refresh.js';
import { classifyError, classifyQuotes, type ProbeResult } from './classify.js';
import { countryTarget, probeGroups, type ProbeGroup, type ProbeTarget, type TargetOptions } from './targets.js';
import { keyOf, nextHealth, type HealthKey } from './transition.js';
import { GLOBAL_SCOPE, STALE_ROUNDS } from './types.js';

export interface ProbeOptions extends TargetOptions {
  intervalMs: number;
  /** The wait before a failed round is repeated, so a first failure is confirmed in the same round. */
  confirmDelayMs: number;
  failuresToDown: number;
  /** How long probing stops after Meld throttles a probe. */
  throttlePauseMs: number;
  maxProbesPerHour: number;
}

/** A quote whose offers are restricted to the target's provider. */
export type PinnedQuote = (target: ProbeTarget) => Promise<readonly { serviceProvider: string }[]>;

export interface ProbeLog {
  info(message: string): void;
  warn(message: string): void;
}

export interface ProbeDeps {
  store: Pick<FundingStore, 'readCorridors' | 'readProviderHealth' | 'writeProviderHealth'>;
  quote: PinnedQuote;
  /** The (crypto, direction) pairs whose stored corridors hold the probe targets. */
  jobs: readonly RefreshJob[];
  log: ProbeLog;
  clock?: () => number;
  /** Picks the probed countries and the jitter. */
  random?: () => number;
}

const HOUR_MS = 3_600_000;

/** The share of the interval added at random, so replicas and restarts do not probe in step. */
const JITTER = 0.1;

/** The share of the hourly cap that country checks may spend, so they cannot starve the rounds. */
const CHECK_SHARE = 0.5;

interface Pass {
  signal: AbortSignal;
  /** The quotes in the last hour past which this pass stops. */
  limit: number;
}

export function pinnedQuote(meld: Pick<MeldClient, 'quote' | 'quoteSell'>): PinnedQuote {
  return (target) => {
    const common = { countryCode: target.country, paymentMethodType: target.paymentMethodType, serviceProviders: [target.provider] };
    return target.direction === 'sell'
      ? meld.quoteSell({ ...common, cryptoCurrencyCode: target.crypto, fiatCurrencyCode: target.fiat, cryptoAmount: target.amount })
      : meld.quote({ ...common, sourceCurrencyCode: target.fiat, destinationCurrencyCode: target.crypto, sourceAmount: target.amount });
  };
}

const requestRef = (row: ProviderHealthRow): string =>
  row.last_request_id === null ? '' : ` (Meld request ${row.last_request_id})`;

export interface Prober {
  /** One round over every provider the stored corridors name, then over every country outage. */
  round: (signal: AbortSignal) => Promise<void>;
  /**
   * Checks each suspect's provider everywhere, then in the country its key scopes, each at most
   * once per interval and within a share of the hourly cap.
   */
  check: (suspects: readonly HealthKey[], signal: AbortSignal) => Promise<void>;
}

export function createProber(deps: ProbeDeps, options: ProbeOptions): Prober {
  const clock = deps.clock ?? Date.now;
  const random = deps.random ?? Math.random;
  const spent: number[] = [];
  const checkedAt = new Map<string, number>();
  let pausedUntil = 0;
  let capped = false;
  let concludedAt = clock();
  let staleReported = false;

  const withinBudget = (limit: number): boolean => {
    const now = clock();
    while ((spent[0] ?? Infinity) <= now - HOUR_MS) spent.shift();
    if (spent.length >= limit) {
      if (!capped) deps.log.warn(`provider probes reached ${String(limit)} quotes in the last hour; pausing`);
      capped = true;
      return false;
    }
    capped = false;
    spent.push(now);
    return true;
  };

  /** One answer per target, or `undefined` when the round must stop: throttled or out of budget. */
  const probe = async (group: ProbeGroup, limit: number): Promise<ProbeResult[] | undefined> => {
    const results: ProbeResult[] = [];
    for (const target of group.targets) {
      if (!withinBudget(limit)) return undefined;
      const result = await deps.quote(target).then(
        (quotes) => classifyQuotes(target.provider, quotes),
        (error: unknown) => classifyError(target.provider, error),
      );
      if (result.outcome === 'throttled') {
        pausedUntil = clock() + options.throttlePauseMs;
        deps.log.warn(`Meld throttled a provider probe (${result.code}); probing pauses for ${String(options.throttlePauseMs)}ms`);
        return undefined;
      }
      results.push(result);
    }
    return results;
  };

  const report = (group: ProbeGroup, previous: ProviderHealthRow | undefined, next: ProviderHealthRow): void => {
    const name = `provider ${next.provider} ${next.direction}${next.scope === GLOBAL_SCOPE ? '' : ` in ${next.scope}`}`;
    const where = group.targets.map((t) => `${t.country}/${t.fiat}`).join(', ');
    const wasDown = previous?.state === 'down';
    if (next.state === 'down' && !wasDown) {
      deps.log.warn(
        `${name} is down after ${String(next.failures)} failed probe rounds in ${where}: ` +
          `expected an offer, observed ${next.last_code ?? 'none'}${requestRef(next)}`,
      );
    } else if (next.state === 'up' && wasDown) {
      deps.log.info(`${name} is up again in ${where}`);
    } else if (next.state === 'up' && next.failures > 0) {
      deps.log.info(`${name} failed a probe round in ${where}: observed ${next.last_code ?? 'none'}${requestRef(next)}; confirming`);
    }
  };

  const reportStale = (): void => {
    const silentMs = clock() - concludedAt;
    if (staleReported || silentMs <= STALE_ROUNDS * options.intervalMs) return;
    staleReported = true;
    deps.log.warn(`no provider probe has reached a conclusion for ${String(silentMs)}ms; stored provider health is stale`);
  };

  const snapshot = async () => ({
    rows: (await Promise.all(deps.jobs.map((job) => deps.store.readCorridors(job.crypto, job.direction)))).flat(),
    known: new Map((await deps.store.readProviderHealth()).map((row) => [keyOf(row), row])),
  });
  type Snapshot = Awaited<ReturnType<typeof snapshot>>;

  /** Probes `group` until `key`'s state settles. `false` when the pass must stop: throttled or out of budget. */
  const settle = async (group: ProbeGroup, key: HealthKey, known: Snapshot['known'], { signal, limit }: Pass): Promise<boolean> => {
    checkedAt.set(keyOf(key), clock());
    let previous = known.get(keyOf(key));
    for (;;) {
      if (signal.aborted) return false;
      const results = await probe(group, limit);
      if (results === undefined) return false;
      const next = nextHealth(key, previous, results, clock(), options.failuresToDown);
      if (next === undefined) return true;
      concludedAt = clock();
      staleReported = false;
      await deps.store.writeProviderHealth(next);
      report(group, previous, next);
      known.set(keyOf(key), next);
      previous = next;
      if (next.failures === 0 || next.state === 'down') return true;
      await sleep(options.confirmDelayMs, undefined, { signal, ref: false });
    }
  };

  const globalKey = (group: ProbeGroup): HealthKey => ({ provider: group.provider, direction: group.direction, scope: GLOBAL_SCOPE });

  const isDue = (key: HealthKey): boolean => clock() - (checkedAt.get(keyOf(key)) ?? -Infinity) >= options.intervalMs;

  /** A provider already down everywhere is hidden everywhere, so its countries are not checked. */
  const checkCountries = async (suspects: readonly HealthKey[], { rows, known }: Snapshot, pass: Pass): Promise<void> => {
    for (const key of suspects) {
      if (known.get(keyOf({ ...key, scope: GLOBAL_SCOPE }))?.state === 'down') continue;
      const target = countryTarget(rows, key.provider, key.direction, key.scope, options);
      if (target === undefined) continue;
      if (!(await settle({ provider: key.provider, direction: key.direction, targets: [target] }, key, known, pass))) return;
    }
  };

  const round = async (signal: AbortSignal): Promise<void> => {
    if (clock() < pausedUntil) {
      reportStale();
      return;
    }
    try {
      const pass = { signal, limit: options.maxProbesPerHour };
      const current = await snapshot();
      for (const group of probeGroups(current.rows, options, random)) {
        if (!(await settle(group, globalKey(group), current.known, pass))) return;
      }
      const outages = [...current.known.values()].filter((row) => row.scope !== GLOBAL_SCOPE && row.state === 'down');
      await checkCountries(outages, current, pass);
    } finally {
      reportStale();
    }
  };

  /** One outage everywhere can make every country suspect, so the provider is checked everywhere first. */
  const check = async (suspects: readonly HealthKey[], signal: AbortSignal): Promise<void> => {
    if (clock() < pausedUntil) return;
    const due = suspects.filter(isDue);
    if (due.length === 0) return;
    const pass = { signal, limit: Math.floor(options.maxProbesPerHour * CHECK_SHARE) };
    const current = await snapshot();
    for (const group of probeGroups(current.rows, options, random)) {
      const suspected = due.some((key) => key.provider === group.provider && key.direction === group.direction);
      if (!suspected || !isDue(globalKey(group))) continue;
      if (!(await settle(group, globalKey(group), current.known, pass))) return;
    }
    await checkCountries(due, current, pass);
  };

  return { round, check };
}

/**
 * Probe every `intervalMs` plus jitter, and check suspected countries as they are reported, one
 * pass at a time under `exclusive`.
 */
export function startProviderProbes(
  deps: ProbeDeps,
  options: ProbeOptions,
  exclusive: Serial = serial(),
): { stop: (graceMs?: number) => Promise<void>; suspect: (keys: readonly HealthKey[]) => void } {
  const controller = new AbortController();
  const { signal } = controller;
  const { round, check } = createProber(deps, options);
  const random = deps.random ?? Math.random;
  const pending = new Map<string, HealthKey>();
  const checks = new Set<Promise<void>>();
  let scheduled = false;

  const suspect = (keys: readonly HealthKey[]): void => {
    for (const key of keys) pending.set(keyOf(key), key);
    if (scheduled || pending.size === 0 || signal.aborted) return;
    scheduled = true;
    const pass = exclusive(async () => {
      scheduled = false;
      const batch = [...pending.values()];
      pending.clear();
      await check(batch, signal);
    }).catch((error: unknown) => {
      if (!isAbort(error)) deps.log.warn(`provider country check failed: ${message(error)}`);
    });
    checks.add(pass);
    void pass.finally(() => checks.delete(pass));
  };

  const loop = (async () => {
    for (;;) {
      try {
        await sleep(options.intervalMs + Math.floor(random() * options.intervalMs * JITTER), undefined, { signal, ref: false });
        await exclusive(() => round(signal));
      } catch (error) {
        if (isAbort(error)) return;
        deps.log.warn(`provider probe round failed, continuing: ${message(error)}`);
      }
    }
  })();
  return { stop: (graceMs = 5_000) => stopWithin(controller, () => Promise.all([loop, ...checks]), graceMs), suspect };
}
