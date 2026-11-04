import type { SupportedCorridorRow } from '../funding/store.js';
import type { ProviderLimit } from '../meld/discovery.js';
import { compareDecimal, doubleDecimal, isDecimal } from '../money.js';
import type { Direction } from '../rail.js';

/** One pinned quote that tests a provider. */
export interface ProbeTarget {
  provider: string;
  direction: Direction;
  country: string;
  fiat: string;
  /** Meld's code for the crypto bought or sold. */
  crypto: string;
  paymentMethodType: string;
  /** The fiat paid on a buy, the crypto sold on a sell. */
  amount: string;
}

/** The targets that decide one provider's health in one direction. */
export interface ProbeGroup {
  provider: string;
  direction: Direction;
  targets: [ProbeTarget, ...ProbeTarget[]];
}

export interface TargetOptions {
  /** The crypto a sell probe commits, by Meld code. A sell corridor without one is not probed. */
  sellAmounts: ReadonlyMap<string, string>;
}

interface Candidate {
  target: ProbeTarget;
  card: boolean;
}

/**
 * Each round probes a provider in two countries picked at random among those its stored corridors
 * list it in, with different fiat currencies, so an outage in one region cannot mark it down
 * everywhere. Every country weighs the same, however many methods it lists.
 */
export function probeGroups(rows: readonly SupportedCorridorRow[], options: TargetOptions, random: () => number): ProbeGroup[] {
  return perCountry(rows, options).map(({ provider, direction, targets }) => {
    const first = pick(targets, random) ?? targets[0];
    const second = pick(
      targets.filter((t) => t.fiat !== first.fiat),
      random,
    );
    return { provider, direction, targets: second === undefined ? [first] : [first, second] };
  });
}

const pick = <T>(list: readonly T[], random: () => number): T | undefined => list[Math.floor(random() * list.length)];

/** One target per country for each provider and direction, a card method first, ordered by country code. */
function perCountry(rows: readonly SupportedCorridorRow[], options: TargetOptions): ProbeGroup[] {
  const candidates = rows.flatMap((row) => candidatesOf(row, options));
  candidates.sort(
    (a, b) =>
      a.target.country.localeCompare(b.target.country) ||
      Number(b.card) - Number(a.card) ||
      a.target.crypto.localeCompare(b.target.crypto) ||
      a.target.paymentMethodType.localeCompare(b.target.paymentMethodType),
  );

  const groups = new Map<string, ProbeGroup>();
  for (const { target } of candidates) {
    const key = `${target.direction}|${target.provider}`;
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, { provider: target.provider, direction: target.direction, targets: [target] });
    } else if (group.targets[group.targets.length - 1]?.country !== target.country) {
      group.targets.push(target);
    }
  }
  return [...groups.values()];
}

function candidatesOf(row: SupportedCorridorRow, options: TargetOptions): Candidate[] {
  const cards = new Set(row.methods.filter((m) => m.category === 'card').map((m) => m.paymentMethodType));
  return (row.method_providers ?? []).flatMap(({ paymentMethodType, providers }) =>
    providers.flatMap((limit): Candidate[] => {
      const amount = row.direction === 'sell' ? options.sellAmounts.get(row.destination_currency_code) : buyAmount(limit);
      if (amount === undefined) return [];
      const target: ProbeTarget = {
        provider: limit.provider,
        direction: row.direction,
        country: row.country,
        fiat: row.fiat,
        crypto: row.destination_currency_code,
        paymentMethodType,
        amount,
      };
      return [{ target, card: cards.has(paymentMethodType) }];
    }),
  );
}

/** Twice the provider's minimum, or the minimum itself when twice would pass its maximum. */
function buyAmount({ min, max }: ProviderLimit): string | undefined {
  if (!isDecimal(min) || !isDecimal(max)) return undefined;
  const doubled = doubleDecimal(min);
  return compareDecimal(doubled, max) <= 0 ? doubled : min;
}

/** The target that tests `provider` in one country, chosen as `probeGroups` would choose it there. */
export function countryTarget(
  rows: readonly SupportedCorridorRow[],
  provider: string,
  direction: Direction,
  country: string,
  options: TargetOptions,
): ProbeTarget | undefined {
  const local = rows.filter((row) => row.country === country && row.direction === direction);
  return perCountry(local, options).find((group) => group.provider === provider)?.targets[0];
}
