import { setTimeout as sleep } from 'node:timers/promises';

import { isAbort, message, serial, stopWithin, type Serial } from '../background.js';
import type { FundingStore, ProviderHealthRow } from '../funding/store.js';
import type { MeldClient } from '../meld/client.js';
import type { RefreshJob } from '../supported/refresh.js';
import { classifyError, classifyQuotes, type ProbeResult } from './classify.js';
import { probeGroups, type ProbeGroup, type ProbeTarget, type TargetOptions } from './targets.js';
import { nextHealth, type HealthKey } from './transition.js';
import { GLOBAL_SCOPE } from './types.js';

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
}

/** Intervals without a conclusive round after which stored health counts as stale. */
export const STALE_ROUNDS = 3;

const HOUR_MS = 3_600_000;

/** The share of the interval added at random, so replicas and restarts do not probe in step. */
const JITTER = 0.1;

export function pinnedQuote(meld: Pick<MeldClient, 'quote' | 'quoteSell'>): PinnedQuote {
  return (target) => {
    const common = { countryCode: target.country, paymentMethodType: target.paymentMethodType, serviceProviders: [target.provider] };
    return target.direction === 'sell'
      ? meld.quoteSell({ ...common, cryptoCurrencyCode: target.crypto, fiatCurrencyCode: target.fiat, cryptoAmount: target.amount })
      : meld.quote({ ...common, sourceCurrencyCode: target.fiat, destinationCurrencyCode: target.crypto, sourceAmount: target.amount });
  };
}

const keyOf = ({ provider, direction, scope }: HealthKey): string => `${provider}|${direction}|${scope}`;

const requestRef = (row: ProviderHealthRow): string =>
  row.last_request_id === null ? '' : ` (Meld request ${row.last_request_id})`;

/** One probe round over every provider the stored corridors name. */
export function createProber(deps: ProbeDeps, options: ProbeOptions): { round: (signal: AbortSignal) => Promise<void> } {
  const clock = deps.clock ?? Date.now;
  const spent: number[] = [];
  let pausedUntil = 0;
  let capped = false;
  let concludedAt = clock();
  let staleReported = false;

  const withinBudget = (): boolean => {
    const now = clock();
    while ((spent[0] ?? Infinity) <= now - HOUR_MS) spent.shift();
    if (spent.length >= options.maxProbesPerHour) {
      if (!capped) deps.log.warn(`provider probes reached ${String(options.maxProbesPerHour)} quotes in the last hour; pausing`);
      capped = true;
      return false;
    }
    capped = false;
    spent.push(now);
    return true;
  };

  /** One answer per target, or `undefined` when the round must stop: throttled or out of budget. */
  const probe = async (group: ProbeGroup): Promise<ProbeResult[] | undefined> => {
    const results: ProbeResult[] = [];
    for (const target of group.targets) {
      if (!withinBudget()) return undefined;
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
    const name = `provider ${next.provider} ${next.direction}`;
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

  const round = async (signal: AbortSignal): Promise<void> => {
    if (clock() < pausedUntil) {
      reportStale();
      return;
    }
    try {
      const rows = (await Promise.all(deps.jobs.map((job) => deps.store.readCorridors(job.crypto, job.direction)))).flat();
      const known = new Map((await deps.store.readProviderHealth()).map((row) => [keyOf(row), row]));
      for (const group of probeGroups(rows, options)) {
        const key: HealthKey = { provider: group.provider, direction: group.direction, scope: GLOBAL_SCOPE };
        let previous = known.get(keyOf(key));
        for (;;) {
          if (signal.aborted) return;
          const results = await probe(group);
          if (results === undefined) return;
          const next = nextHealth(key, previous, results, clock(), options.failuresToDown);
          if (next === undefined) break;
          concludedAt = clock();
          staleReported = false;
          await deps.store.writeProviderHealth(next);
          report(group, previous, next);
          previous = next;
          if (next.failures === 0 || next.state === 'down') break;
          await sleep(options.confirmDelayMs, undefined, { signal, ref: false });
        }
      }
    } finally {
      reportStale();
    }
  };

  return { round };
}

/** Probe every `intervalMs` plus jitter, one round at a time under `exclusive`; returns `stop()`. */
export function startProviderProbes(
  deps: ProbeDeps,
  options: ProbeOptions,
  exclusive: Serial = serial(),
  random: () => number = Math.random,
): { stop: (graceMs?: number) => Promise<void> } {
  const controller = new AbortController();
  const { signal } = controller;
  const { round } = createProber(deps, options);
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
  return { stop: (graceMs = 5_000) => stopWithin(controller, () => loop, graceMs) };
}
