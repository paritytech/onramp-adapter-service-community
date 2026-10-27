// The two networks a sale vault proxy runs on, each pinned to its own Chainflip endpoints.

import type { Chain } from '../meld/catalog.js';

/** The catalog chain every sale vault proxy lives on, the chain id telling its networks apart. */
export const SALE_VAULT_PROXY_CHAIN: Chain = 'arbitrum';

/** Chainflip's endpoints for one Arbitrum network. */
export interface SaleVaultProxyNetwork {
  /** What the State Chain RPC answers to `system_chain`. */
  readonly stateChain: string;
  /** The Chainflip swap backend that quotes and encodes its returns. */
  readonly backendUrl: string;
}

/** Chainflip's endpoints per Arbitrum chain id. */
export const SALE_VAULT_PROXY_NETWORKS: Readonly<Record<number, SaleVaultProxyNetwork>> = {
  42161: { stateChain: 'Chainflip-Berghain', backendUrl: 'https://chainflip-swap.chainflip.io' },
  421614: { stateChain: 'Chainflip-Perseverance', backendUrl: 'https://chainflip-swap-perseverance.chainflip.io' },
};

/** A chain id's network, which config already proved is pinned. */
export function saleVaultProxyNetwork(chainId: number): SaleVaultProxyNetwork {
  const network = SALE_VAULT_PROXY_NETWORKS[chainId];
  if (network === undefined) throw new Error(`chain ${String(chainId)} has no pinned Chainflip network`);
  return network;
}
