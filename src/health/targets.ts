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
  /** Countries tried first, in this order. */
  preferredCountries: readonly string[];
  /** The crypto a sell probe commits, by Meld code. A sell corridor without one is not probed. */
  sellAmounts: ReadonlyMap<string, string>;
}

/** At most this many targets per group, each in a different fiat currency. */
const TARGETS_PER_GROUP = 2;

interface Candidate {
  target: ProbeTarget;
  card: boolean;
}

/**
 * The probe groups the stored corridors support. A group's targets use different fiat currencies,
 * so an outage in one region cannot mark a provider down everywhere. Card methods and the preferred
 * countries come first; the rest is ordered by code, so the choice is stable across passes.
 */
export function probeGroups(rows: readonly SupportedCorridorRow[], options: TargetOptions): ProbeGroup[] {
  const rank = (country: string): number => {
    const index = options.preferredCountries.indexOf(country);
    return index === -1 ? options.preferredCountries.length : index;
  };
  const candidates = rows.flatMap((row) => candidatesOf(row, options));
  candidates.sort(
    (a, b) =>
      rank(a.target.country) - rank(b.target.country) ||
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
    } else if (group.targets.length < TARGETS_PER_GROUP && group.targets.every((t) => t.fiat !== target.fiat)) {
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

/** The target that tests `provider` in one country, chosen as `probeGroups` would choose it. */
export function countryTarget(
  rows: readonly SupportedCorridorRow[],
  provider: string,
  direction: Direction,
  country: string,
  options: TargetOptions,
): ProbeTarget | undefined {
  const local = rows.filter((row) => row.country === country && row.direction === direction);
  return probeGroups(local, options).find((group) => group.provider === provider)?.targets[0];
}
