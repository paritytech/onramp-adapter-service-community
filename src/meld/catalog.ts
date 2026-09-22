/**
 * The destinations this service delivers, and the guard that refuses anything else.
 *
 * Meld does not reject an unrecognised `destinationCurrencyCode`; it resolves it to Bitcoin,
 * and the code is sent locked, so an unvalidated code is the wrong purchase rather than a broken
 * link. That is the trap; threat model T4 has the rest, including why this set is code and not
 * configuration.
 */

import { reject } from '../contract.js';

interface Destination {
  /** Meld's currency code. The chain is encoded here; there is no separate parameter. */
  readonly code: string;
}

/** Codes only. A `symbol` and a `decimals` lived here and nothing ever read either. */
export const DESTINATIONS: readonly Destination[] = Object.freeze([
  Object.freeze({ code: 'USDC_ASSETHUB' }),
  Object.freeze({ code: 'USDT_ASSETHUB' }),
  Object.freeze({ code: 'DOT_ASSETHUB' }),
]);

/**
 * Is this one of the crypto codes this service delivers?
 *
 * The predicate behind `resolveDestination`, exposed separately because one caller needs the
 * question answered without the refusal attached: `client.ts` checks, before every quote and
 * every session, that the leg holding a crypto is the leg the direction says should hold it.
 * That is a consistency check on this service's own mapping, not a judgement about a caller's
 * request, so it must not raise a caller-facing `WrongAssetOrChain`.
 *
 * "Crypto" here means "crypto this deployment delivers", which is narrower than Meld's notion of
 * one. That is the right test for that purpose and the wrong one for any other: a code outside
 * this list is refused by `resolveDestination` long before a rail is called, so by the time the
 * client asks, the only codes in play are these three and fiat. It is not a general crypto/fiat
 * classifier and must not be used as one — `BTC` is a crypto and is not in it.
 */
export function isDeliveredCrypto(code: string): boolean {
  return DESTINATIONS.some((d) => d.code === code);
}

/** Resolve a code, or refuse it as `WrongAssetOrChain`: it settles somewhere unserved. */
export function resolveDestination(code: string): Destination {
  const found = DESTINATIONS.find((d) => d.code === code);
  if (!found) {
    throw reject({ tag: 'WrongAssetOrChain' }, `Unknown destination code "${code}".`);
  }
  return found;
}
