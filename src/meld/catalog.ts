/**
 * The destinations this service delivers, and the guard that refuses anything else.
 *
 * Meld does not reject an unrecognised `destinationCurrencyCode`; it resolves it to Bitcoin,
 * and the code is sent locked, so an unvalidated code is the wrong purchase rather than a broken
 * link. That is the trap; threat model T4 has the rest, including why this set is code and not
 * configuration.
 */

import { reject } from '../contract.js';
import type { Direction } from '../rail.js';

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
 * Codes a seller may sell and a buyer may never receive: Chainflip-swapped Solana/Arbitrum codes,
 * and Meld's older `*_STATEMINT` names for Asset Hub. Code, not configuration (T4).
 */
export const OFFRAMP_ONLY: readonly Destination[] = Object.freeze([
  Object.freeze({ code: 'USDT_SOLANA' }),
  Object.freeze({ code: 'USDC_SOLANA' }),
  Object.freeze({ code: 'USDC_ARBITRUM' }),
  Object.freeze({ code: 'DOT_STATEMINT' }),
  Object.freeze({ code: 'USDT_STATEMINT' }),
]);

/** Every code a sell may name: delivered plus sell-only. */
const SELLABLE: readonly Destination[] = Object.freeze([...DESTINATIONS, ...OFFRAMP_ONLY]);

/** The chain a code settles on, from its suffix; `undefined` for a code with no known chain. */
export function chainOf(code: string): string | undefined {
  if (code.endsWith('_ASSETHUB') || code.endsWith('_STATEMINT')) return 'assethub';
  if (code.endsWith('_SOLANA')) return 'solana';
  if (code.endsWith('_ARBITRUM')) return 'arbitrum';
  return undefined;
}

/** Is this a code that is sellable but never deliverable? */
export function isOfframpOnly(code: string): boolean {
  return OFFRAMP_ONLY.some((d) => d.code === code);
}

/** Every code a sell may name: what is delivered plus what is sell-only. */
export function isSellable(code: string): boolean {
  return SELLABLE.some((d) => d.code === code);
}

/**
 * Is this a crypto code this service knows (delivered or sell-only)?
 *
 * The predicate behind `resolveDestination`, without the refusal: `client.ts` checks before every
 * quote and session that the leg holding a crypto is the one the direction says should hold it, a
 * consistency check on this service's own mapping, not a judgement on a caller's request. Not a
 * general crypto/fiat classifier: `BTC` is a crypto and is not in it.
 */
export function isKnownCrypto(code: string): boolean {
  return isSellable(code);
}

/** Resolve a code, or refuse it as `WrongAssetOrChain`: it settles somewhere unserved. */
export function resolveDestination(code: string): Destination {
  const found = DESTINATIONS.find((d) => d.code === code);
  if (!found) {
    throw reject({ tag: 'WrongAssetOrChain' }, `Unknown destination code "${code}".`);
  }
  return found;
}

/**
 * Resolve a code for a sell: delivered codes plus the sell-only ones. A buy must keep using
 * `resolveDestination`, which refuses the sell-only codes.
 */
export function resolveSellCode(code: string): Destination {
  const found = SELLABLE.find((d) => d.code === code);
  if (!found) {
    throw reject({ tag: 'WrongAssetOrChain' }, `Unknown destination code "${code}".`);
  }
  return found;
}

/** Resolve a code for the given direction. */
export function resolveForDirection(code: string, direction: Direction): Destination {
  return direction === 'sell' ? resolveSellCode(code) : resolveDestination(code);
}
