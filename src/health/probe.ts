import { setTimeout as sleep } from 'node:timers/promises';

import { isAbort, message, serial, stopWithin, type Serial } from '../background.js';
import type { FundingStore, ProviderHealthRow } from '../funding/store.js';
import type { MeldClient } from '../meld/client.js';
import type { RefreshJob } from '../supported/refresh.js';
import { classifyError, classifyQuotes, type ProbeResult } from './classify.js';
import { countryTarget, probeGroups, type ProbeGroup, type ProbeTarget, type TargetOptions } from './targets.js';
import { clearPending, keyOf, nextHealth, type HealthKey } from './transition.js';
import { GLOBAL_SCOPE, STALE_ROUNDS } from './types.js';

export interface ProbeOptions extends TargetOptions {
  /** The least time between two probes of one group. */
  intervalMs: number;
  failuresToDown: number;
  /** How long probing stops after Meld throttles a probe. */
  throttlePauseMs: number;
  /** Sets the least gap between two quotes: an hour divided by this. */
  maxProbesPerHour: number;
}

/** A quote whose offers are restricted to the target's provider. */
export type PinnedQuote = (target: ProbeTarget) => Promise<readonly { serviceProvider: string }[]>;

export interface ProbeLog {
  info(message: string): void;
  warn(message: string): void;
}

export interface ProbeDeps {
  store: Pick<FundingStore, 'readCorridors' | 'readProviderHealth' | 'writeProviderHealth' | 'extendProviderHealth'>;
  quote: PinnedQuote;
  /** The (crypto, direction) pairs whose stored corridors hold the probe targets. */
  jobs: readonly RefreshJob[];
  log: ProbeLog;
  clock?: () => number;
  /** Picks the probed countries. */
  random?: () => number;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
}

const HOUR_MS = 3_600_000;

/** The share of the quotes in any hour that live-quote checks may spend, so they cannot starve the probes. */
const CHECK_SHARE = 0.5;

const pause = (ms: number, signal: AbortSignal): Promise<void> => sleep(ms, undefined, { signal, ref: false });

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

/** One group to probe and the health it decides. */
interface Work {
  group: ProbeGroup;
  key: HealthKey;
}

export interface Prober {
  /**
   * Probes the next piece of work: a suspect first, else the group probed longest ago once
   * `intervalMs` has passed since its last probe. With nothing due, waits one quote gap.
   */
  step: (signal: AbortSignal) => Promise<void>;
  /** Queues a check of each key's provider everywhere, then in the country the key scopes. */
  suspect: (keys: readonly HealthKey[]) => void;
}

/**
 * Sends one quote at a time, never two closer than an hour divided by `maxProbesPerHour`, so
 * however many providers the account has, probes stay within that rate and every group gets its
 * turn. When the groups need more quotes than that rate allows in `intervalMs`, each group is
 * probed less often.
 */
export function createProber(deps: ProbeDeps, options: ProbeOptions, exclusive: Serial = serial()): Prober {
  const clock = deps.clock ?? Date.now;
  const random = deps.random ?? Math.random;
  const wait = deps.wait ?? pause;
  const gapMs = HOUR_MS / options.maxProbesPerHour;
  const checkLimit = Math.floor(options.maxProbesPerHour * CHECK_SHARE);
  const probedAt = new Map<string, number>();
  const suspects = new Map<string, HealthKey>();
  const checksSpent: number[] = [];
  let lastQuoteAt = -Infinity;
  let pausedUntil = 0;
  /** The time between two probes of one group: `intervalMs`, or longer when the groups need more quotes than the rate allows. */
  let cycleMs = options.intervalMs;
  let concludedAt = clock();
  let staleReported = false;

  const snapshot = async () => ({
    rows: (await Promise.all(deps.jobs.map((job) => deps.store.readCorridors(job.crypto, job.direction)))).flat(),
    known: new Map((await deps.store.readProviderHealth()).map((row) => [keyOf(row), row])),
  });
  type Snapshot = Awaited<ReturnType<typeof snapshot>>;

  /** A stored row stands in for a probe this process has not made, so a restart does not probe every group at once. */
  const lastProbe = (key: HealthKey, known: Snapshot['known']): number =>
    probedAt.get(keyOf(key)) ?? known.get(keyOf(key))?.updated_at ?? -Infinity;

  const isDue = (key: HealthKey, known: Snapshot['known']): boolean => clock() - lastProbe(key, known) >= options.intervalMs;

  const checksLeft = (): number => {
    while ((checksSpent[0] ?? Infinity) <= clock() - HOUR_MS) checksSpent.shift();
    return checkLimit - checksSpent.length;
  };

  /** The answers up to the first offer, since one offer clears the provider, or `undefined` when Meld throttled a probe. */
  const probe = async (group: ProbeGroup, check: boolean, signal: AbortSignal): Promise<ProbeResult[] | undefined> => {
    const results: ProbeResult[] = [];
    for (const target of group.targets) {
      signal.throwIfAborted();
      const ready = lastQuoteAt + gapMs - clock();
      if (ready > 0) await wait(ready, signal);
      lastQuoteAt = clock();
      if (check) checksSpent.push(lastQuoteAt);
      const result = await exclusive(() => deps.quote(target)).then(
        (quotes) => classifyQuotes(target.provider, quotes),
        (error: unknown) => classifyError(target.provider, error),
      );
      if (result.outcome === 'throttled') {
        pausedUntil = clock() + options.throttlePauseMs;
        deps.log.warn(`Meld throttled a provider probe (${result.code}); probing pauses for ${String(options.throttlePauseMs)}ms`);
        // A deliberate pause is no evidence that a provider recovered, so stored health outlasts it.
        await deps.store.extendProviderHealth(options.throttlePauseMs, clock());
        return undefined;
      }
      results.push(result);
      if (result.outcome === 'up') break;
    }
    return results;
  };

  const report = (probed: readonly ProbeTarget[], previous: ProviderHealthRow | undefined, next: ProviderHealthRow): void => {
    const name = `provider ${next.provider} ${next.direction} ${next.category}${next.scope === GLOBAL_SCOPE ? '' : ` in ${next.scope}`}`;
    const where = probed.map((t) => `${t.country}/${t.fiat}`).join(', ');
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
    if (staleReported || silentMs <= STALE_ROUNDS * cycleMs) return;
    staleReported = true;
    deps.log.warn(`no provider probe has reached a conclusion for ${String(silentMs)}ms; stored provider health is stale`);
  };

  /**
   * Probes `work` until its state settles, repeating a failed round at the next quote. A check
   * starts a round only when the checks' share of the hour covers all its quotes. `false` when Meld
   * throttled a probe.
   */
  const settle = async ({ group, key }: Work, known: Snapshot['known'], check: boolean, signal: AbortSignal): Promise<boolean> => {
    const affordable = (): boolean => !check || checksLeft() >= group.targets.length;
    if (!affordable()) return true;
    probedAt.set(keyOf(key), clock());
    let previous = known.get(keyOf(key));
    for (;;) {
      const results = await probe(group, check, signal);
      if (results === undefined) return false;
      const next = nextHealth(key, previous, results, clock(), options.failuresToDown, clock() + STALE_ROUNDS * cycleMs);
      if (next === undefined) {
        const cleared = clearPending(previous);
        if (cleared !== undefined) await deps.store.writeProviderHealth(cleared);
        return true;
      }
      concludedAt = clock();
      staleReported = false;
      await deps.store.writeProviderHealth(next);
      report(group.targets.slice(0, results.length), previous, next);
      known.set(keyOf(key), next);
      previous = next;
      if (next.failures === 0 || next.state === 'down' || !affordable()) return true;
    }
  };

  const globalKey = ({ provider, direction, category }: ProbeGroup): HealthKey => ({ provider, direction, category, scope: GLOBAL_SCOPE });

  /** A country probe for `key`, unless its provider is down everywhere and so hidden everywhere already. */
  const countryWork = (key: HealthKey, { rows, known }: Snapshot): Work | undefined => {
    if (known.get(keyOf({ ...key, scope: GLOBAL_SCOPE }))?.state === 'down') return undefined;
    const target = countryTarget(rows, key, options);
    if (target === undefined) return undefined;
    return { group: { provider: key.provider, direction: key.direction, category: key.category, targets: [target] }, key };
  };

  /** Every group everywhere, then every country outage. */
  const regularWork = (current: Snapshot): Work[] => [
    ...probeGroups(current.rows, options, random).map((group) => ({ group, key: globalKey(group) })),
    ...[...current.known.values()]
      .filter((row) => row.scope !== GLOBAL_SCOPE && row.state === 'down')
      .flatMap((row) => countryWork(row, current) ?? []),
  ];

  const pace = (work: readonly Work[]): void => {
    const quotes = work.reduce((sum, w) => sum + w.group.targets.length, 0);
    const wasStretched = cycleMs > options.intervalMs;
    cycleMs = Math.max(options.intervalMs, quotes * gapMs);
    const stretched = cycleMs > options.intervalMs;
    if (stretched === wasStretched) return;
    deps.log.info(
      stretched
        ? `${String(work.length)} provider probes need up to ${String(quotes)} quotes at one every ${String(gapMs)}ms: each is repeated within ${String(cycleMs)}ms`
        : `each provider probe is repeated every ${String(options.intervalMs)}ms again`,
    );
  };

  /** One outage everywhere can make every country suspect, so the provider is checked everywhere first. */
  const check = async (key: HealthKey, current: Snapshot, signal: AbortSignal): Promise<void> => {
    const group = probeGroups(current.rows, options, random).find(
      (g) => g.provider === key.provider && g.direction === key.direction && g.category === key.category,
    );
    if (group !== undefined && isDue(globalKey(group), current.known)) {
      if (!(await settle({ group, key: globalKey(group) }, current.known, true, signal))) return;
    }
    const work = countryWork(key, current);
    if (work !== undefined) await settle(work, current.known, true, signal);
  };

  /** The first suspect due a check; suspects not yet due are dropped, as a live quote reports them again. */
  const takeSuspect = (known: Snapshot['known']): HealthKey | undefined => {
    for (const [id, key] of suspects) {
      suspects.delete(id);
      if (isDue(key, known)) return key;
    }
    return undefined;
  };

  const step = async (signal: AbortSignal): Promise<void> => {
    try {
      if (clock() < pausedUntil) {
        await wait(pausedUntil - clock(), signal);
        return;
      }
      const current = await snapshot();
      const suspect = takeSuspect(current.known);
      if (suspect !== undefined) {
        await check(suspect, current, signal);
        return;
      }
      const work = regularWork(current);
      pace(work);
      const [next] = work
        .filter((w) => isDue(w.key, current.known))
        .sort((a, b) => lastProbe(a.key, current.known) - lastProbe(b.key, current.known));
      if (next === undefined) {
        await wait(gapMs, signal);
        return;
      }
      await settle(next, current.known, false, signal);
    } finally {
      reportStale();
    }
  };

  const suspect = (keys: readonly HealthKey[]): void => {
    for (const key of keys) suspects.set(keyOf(key), key);
  };

  return { step, suspect };
}

/** Probes until stopped. Each quote takes `exclusive`, which the corridor refresh shares, so the two never call Meld at once. */
export function startProviderProbes(
  deps: ProbeDeps,
  options: ProbeOptions,
  exclusive: Serial = serial(),
): { stop: (graceMs?: number) => Promise<void>; suspect: (keys: readonly HealthKey[]) => void } {
  const controller = new AbortController();
  const { signal } = controller;
  const prober = createProber(deps, options, exclusive);
  const wait = deps.wait ?? pause;

  const loop = (async () => {
    while (!signal.aborted) {
      try {
        await prober.step(signal);
      } catch (error) {
        if (isAbort(error)) return;
        deps.log.warn(`provider probe failed, continuing: ${message(error)}`);
        await wait(options.intervalMs, signal).catch(() => undefined);
      }
    }
  })();
  return { stop: (graceMs = 5_000) => stopWithin(controller, () => loop, graceMs), suspect: prober.suspect };
}
