import type { SupportedCorridorRow } from '../funding/store.js';
import type { MethodCategory, ProviderLimit } from '../meld/discovery.js';
import { compareDecimal, doubleDecimal, isDecimal } from '../money.js';
import type { Direction } from '../rail.js';
import type { HealthKey } from './transition.js';

/** One pinned quote that tests a provider. */
export interface ProbeTarget {
  provider: string;
  direction: Direction;
  category: MethodCategory;
  country: string;
  fiat: string;
  /** Meld's code for the crypto bought or sold. */
  crypto: string;
  paymentMethodType: string;
  /** The fiat paid on a buy, the crypto sold on a sell. */
  amount: string;
}

/** The targets that decide one provider's health for one direction and method category. */
export interface ProbeGroup {
  provider: string;
  direction: Direction;
  category: MethodCategory;
  targets: [ProbeTarget, ...ProbeTarget[]];
}

export interface TargetOptions {
  /** The crypto a sell probe commits, by Meld code. A sell corridor without one is not probed. */
  sellAmounts: ReadonlyMap<string, string>;
}

/**
 * Each round probes a provider, for each direction and method category it serves, in two countries
 * picked at random among those its stored corridors list it in for that category, with different
 * fiat currencies, so an outage in one region cannot mark it down everywhere. Every country weighs
 * the same, however many methods it lists.
 */
export function probeGroups(rows: readonly SupportedCorridorRow[], options: TargetOptions, random: () => number): ProbeGroup[] {
  return perCountry(rows, options).map(({ targets, ...group }) => {
    const first = pick(targets, random) ?? targets[0];
    const second = pick(
      targets.filter((t) => t.fiat !== first.fiat),
      random,
    );
    return { ...group, targets: second === undefined ? [first] : [first, second] };
  });
}

const pick = <T>(list: readonly T[], random: () => number): T | undefined => list[Math.floor(random() * list.length)];

/** One target per country for each provider, direction and method category, ordered by country code. */
function perCountry(rows: readonly SupportedCorridorRow[], options: TargetOptions): ProbeGroup[] {
  const targets = rows.flatMap((row) => targetsOf(row, options));
  targets.sort(
    (a, b) =>
      a.country.localeCompare(b.country) || a.crypto.localeCompare(b.crypto) || a.paymentMethodType.localeCompare(b.paymentMethodType),
  );

  const groups = new Map<string, ProbeGroup>();
  for (const target of targets) {
    const key = `${target.direction}|${target.provider}|${target.category}`;
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, { provider: target.provider, direction: target.direction, category: target.category, targets: [target] });
    } else if (group.targets[group.targets.length - 1]?.country !== target.country) {
      group.targets.push(target);
    }
  }
  return [...groups.values()];
}

function targetsOf(row: SupportedCorridorRow, options: TargetOptions): ProbeTarget[] {
  const providers = new Map((row.method_providers ?? []).map((entry) => [entry.paymentMethodType, entry.providers]));
  return row.methods.flatMap((method) =>
    (providers.get(method.paymentMethodType) ?? []).flatMap((limit): ProbeTarget[] => {
      const amount = row.direction === 'sell' ? options.sellAmounts.get(row.destination_currency_code) : buyAmount(limit);
      if (amount === undefined) return [];
      return [
        {
          provider: limit.provider,
          direction: row.direction,
          category: method.category,
          country: row.country,
          fiat: row.fiat,
          crypto: row.destination_currency_code,
          paymentMethodType: method.paymentMethodType,
          amount,
        },
      ];
    }),
  );
}

/** Twice the provider's minimum, or the minimum itself when twice would pass its maximum. */
function buyAmount({ min, max }: ProviderLimit): string | undefined {
  if (!isDecimal(min) || !isDecimal(max)) return undefined;
  const doubled = doubleDecimal(min);
  return compareDecimal(doubled, max) <= 0 ? doubled : min;
}

/** The target that tests the provider, direction and category of `key` in the country it scopes. */
export function countryTarget(rows: readonly SupportedCorridorRow[], key: HealthKey, options: TargetOptions): ProbeTarget | undefined {
  const local = rows.filter((row) => row.country === key.scope && row.direction === key.direction);
  return perCountry(local, options).find((group) => group.provider === key.provider && group.category === key.category)?.targets[0];
}
