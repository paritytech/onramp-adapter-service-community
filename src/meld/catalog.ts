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

/** Resolve a code, or refuse it as `WrongAssetOrChain`: it settles somewhere unserved. */
export function resolveDestination(code: string): Destination {
  const found = DESTINATIONS.find((d) => d.code === code);
  if (!found) {
    throw reject({ tag: 'WrongAssetOrChain' }, `Unknown destination code "${code}".`);
  }
  return found;
}
