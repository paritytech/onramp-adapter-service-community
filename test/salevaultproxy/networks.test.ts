import { describe, expect, it } from 'vitest';

import { saleVaultProxyNetwork } from '../../src/salevaultproxy/networks.js';

describe('saleVaultProxyNetwork', () => {
  it('names each pinned network and refuses any other chain', () => {
    expect(saleVaultProxyNetwork(42161)).toEqual({ stateChain: 'Chainflip-Berghain', backendUrl: 'https://chainflip-swap.chainflip.io' });
    expect(saleVaultProxyNetwork(421614)).toEqual({ stateChain: 'Chainflip-Perseverance', backendUrl: 'https://chainflip-swap-perseverance.chainflip.io' });
    expect(() => saleVaultProxyNetwork(1)).toThrow(/chain 1 has no pinned Chainflip network/);
  });
});
