/**
 * The assets this service can move, and the guard that refuses anything else.
 *
 * Meld does not reliably reject an unrecognised `destinationCurrencyCode`: it has resolved one to
 * Bitcoin, and the code is sent locked, so an unvalidated code is the wrong purchase rather than a
 * broken link. That is the trap; threat model T4 has the rest.
 *
 * Two halves, owned by two different people. What an asset *is* (the chain it settles on, so the
 * address format it takes and whether a buyer may receive it) is code, here, because it decides
 * what the rest of the service does with an address. What Meld *calls* it is configuration
 * (`assets` in `config.ts`), because Meld renames codes (`DOT_ASSETHUB` became `DOT`,
 * `USDT_ASSETHUB` became `USDT_DOT`) and a rename must not need a release. The boot check in
 * `startup.ts` asks Meld for every configured code before the port opens, so a stale name stops
 * the rollout naming the code, rather than refusing buyers one at a time.
 *
 * The active catalog is installed once at boot from the validated config (`installCatalog`), and
 * every lookup below reads it. A lookup before that is a wiring fault, and throws.
 */

import { reject } from '../contract.js';
import type { Direction } from '../rail.js';

/** The chains a code can settle on. Each has its own address format; see `address.ts`. */
export type Chain = 'assethub' | 'solana' | 'arbitrum';

interface AssetSpec {
  readonly chain: Chain;
  /** Whether a buyer may receive it. A buy pins an SS58 wallet, so only Asset Hub assets. */
  readonly deliverable: boolean;
}

/**
 * Every asset this service knows, by a name of its own (`<asset>@<chain>`) that Meld cannot
 * change. Adding one is a code change with a test, as before; naming it is configuration.
 */
export const ASSETS = Object.freeze({
  'dot@assethub': Object.freeze({ chain: 'assethub', deliverable: true }),
  'usdt@assethub': Object.freeze({ chain: 'assethub', deliverable: true }),
  'usdc@assethub': Object.freeze({ chain: 'assethub', deliverable: true }),
  // Sold through a Chainflip swap, never delivered: the seller's funds leave Asset Hub first.
  'usdt@solana': Object.freeze({ chain: 'solana', deliverable: false }),
  'usdc@solana': Object.freeze({ chain: 'solana', deliverable: false }),
  'usdc@arbitrum': Object.freeze({ chain: 'arbitrum', deliverable: false }),
} satisfies Record<string, AssetSpec>);

export type AssetId = keyof typeof ASSETS;

export const ASSET_IDS = Object.freeze(Object.keys(ASSETS) as AssetId[]);

export const isAssetId = (value: string): value is AssetId => Object.hasOwn(ASSETS, value);

/** One asset under the code Meld currently gives it. */
export interface Destination {
  readonly asset: AssetId;
  /** Meld's currency code. The chain is encoded in it; there is no separate parameter. */
  readonly code: string;
  readonly chain: Chain;
  readonly deliverable: boolean;
}

/** Every named asset, looked up by the code Meld knows it by. */
export class AssetCatalog {
  private readonly byCode: ReadonlyMap<string, Destination>;
  private readonly byAsset: ReadonlyMap<AssetId, Destination>;

  /** `names` is the validated `assets` block: asset id to Meld code. An asset left out is unserved. */
  constructor(names: Readonly<Partial<Record<AssetId, string>>>) {
    const entries = ASSET_IDS.flatMap((asset): Destination[] => {
      const code = names[asset];
      return code === undefined ? [] : [Object.freeze({ asset, code, ...ASSETS[asset] })];
    });
    this.byCode = new Map(entries.map((d) => [d.code, d]));
    this.byAsset = new Map(entries.map((d) => [d.asset, d]));
    if (this.byCode.size !== entries.length) {
      throw new Error('Two assets share one Meld code; the config schema should have refused this.');
    }
  }

  /** Every named asset, in `ASSETS` order. */
  all(): readonly Destination[] {
    return [...this.byAsset.values()];
  }

  /** The asset Meld names `code`, if this deployment named one so. */
  find(code: string): Destination | undefined {
    return this.byCode.get(code);
  }
}

let active: AssetCatalog | undefined;

/** Install the catalog every lookup below reads. Called once at boot, after the config validates. */
export function installCatalog(catalog: AssetCatalog): void {
  active = catalog;
}

/** The installed catalog. Throws when nothing installed one, which is a wiring fault, not a request's. */
export function activeCatalog(): AssetCatalog {
  if (active === undefined) throw new Error('No asset catalog installed; call installCatalog at boot.');
  return active;
}

/** The chain a code settles on; `undefined` for a code this deployment does not name. */
export function chainOf(code: string): Chain | undefined {
  return activeCatalog().find(code)?.chain;
}

/** Is this a code that is sellable but never deliverable? */
export function isOfframpOnly(code: string): boolean {
  return activeCatalog().find(code)?.deliverable === false;
}

/** Every code a sell may name: what is delivered plus what is sell-only. */
export function isSellable(code: string): boolean {
  return activeCatalog().find(code) !== undefined;
}

/**
 * Is this a crypto code this service knows (delivered or sell-only)?
 *
 * The predicate behind `resolveDestination`, without the refusal: `client.ts` checks before every
 * quote and session that the leg holding a crypto is the one the direction says should hold it, a
 * consistency check on this service's own mapping, not a judgement on a caller's request. Not a
 * general crypto/fiat classifier: `BTC` is a crypto and is not in it, and `DOT` is three letters,
 * so the shape of a code says nothing.
 */
export function isKnownCrypto(code: string): boolean {
  return isSellable(code);
}

/** Resolve a code, or refuse it as `WrongAssetOrChain`: it settles somewhere unserved. */
export function resolveDestination(code: string): Destination {
  const found = activeCatalog().find(code);
  if (found === undefined || !found.deliverable) {
    throw reject({ tag: 'WrongAssetOrChain' }, `Unknown destination code "${code}".`);
  }
  return found;
}

/**
 * Resolve a code for a sell: delivered codes plus the sell-only ones. A buy must keep using
 * `resolveDestination`, which refuses the sell-only codes.
 */
export function resolveSellCode(code: string): Destination {
  const found = activeCatalog().find(code);
  if (found === undefined) {
    throw reject({ tag: 'WrongAssetOrChain' }, `Unknown destination code "${code}".`);
  }
  return found;
}

/** Resolve a code for the given direction. */
export function resolveForDirection(code: string, direction: Direction): Destination {
  return direction === 'sell' ? resolveSellCode(code) : resolveDestination(code);
}
