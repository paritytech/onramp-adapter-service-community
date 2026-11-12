import type { SupportedCorridorRow } from './funding/store.js';
import type { MethodProviders } from './meld/discovery.js';
import { widestBound } from './money.js';
import type { Direction } from './rail.js';

/** A `provider_exclusions` rule, its assets resolved to Meld codes. An absent list matches anything. */
export interface ProviderExclusion {
  provider: string;
  codes?: readonly string[] | undefined;
  payment_methods?: readonly string[] | undefined;
  directions?: readonly Direction[] | undefined;
  countries?: readonly string[] | undefined;
  reason: string;
}

/** One provider offering a payment method for a crypto in a country. */
export interface ProviderOffer {
  provider: string;
  direction: Direction;
  code: string;
  paymentMethodType: string;
  country: string;
}

const covers = <T>(listed: readonly T[] | undefined, value: T): boolean => listed === undefined || listed.includes(value);

export const isExcluded = (rules: readonly ProviderExclusion[], offer: ProviderOffer): boolean =>
  rules.some(
    (rule) =>
      rule.provider === offer.provider.toUpperCase() &&
      covers(rule.codes, offer.code) &&
      covers(rule.payment_methods, offer.paymentMethodType) &&
      covers(rule.directions, offer.direction) &&
      covers(rule.countries, offer.country),
  );

/**
 * A stored corridor without its excluded providers: each method narrows to the bound of the
 * providers left, and a method left with none is dropped. Applied on read so a rule takes effect
 * before the refresh rewrites the row.
 */
export function withoutExcluded(row: SupportedCorridorRow, rules: readonly ProviderExclusion[]): SupportedCorridorRow {
  if (rules.length === 0 || row.method_providers === undefined) return row;
  const rosters = new Map(row.method_providers.map((entry) => [entry.paymentMethodType, entry.providers]));
  const methods: SupportedCorridorRow['methods'] = [];
  const method_providers: MethodProviders[] = [];
  for (const method of row.methods) {
    const { paymentMethodType } = method;
    const listed = rosters.get(paymentMethodType) ?? [];
    const [first, ...rest] = listed.filter(
      ({ provider }) =>
        !isExcluded(rules, { provider, direction: row.direction, code: row.destination_currency_code, paymentMethodType, country: row.country }),
    );
    if (first === undefined) continue;
    const kept: [typeof first, ...typeof rest] = [first, ...rest];
    methods.push(kept.length === listed.length ? method : { ...method, ...widestBound(kept) });
    method_providers.push({ paymentMethodType, providers: kept });
  }
  return { ...row, methods, method_providers };
}
