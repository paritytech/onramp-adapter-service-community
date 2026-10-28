import { describe, expect, it, vi } from 'vitest';

import { ChainUnavailableError, RpcCallError, SaleVaultProxyChain } from '../../src/salevaultproxy/chain.js';
import {
  SaleVaultProxyMisconfigured,
  verifyDeployment,
  verifyWindow,
  type ChainflipSource,
  type SaleVaultProxyDeploymentConfig,
} from '../../src/salevaultproxy/verify.js';
import { chainflipOf, deployedGetters, FACTORY, fakeNode, GUARDIAN, IMPL, SEPOLIA, w } from './fakes.js';

const CFG: SaleVaultProxyDeploymentConfig = {
  chainId: 421614,
  factory: FACTORY.toUpperCase().replace('0X', '0x'),
  vault: SEPOLIA.vault.toUpperCase().replace('0X', '0x'),
  usdc: SEPOLIA.usdc,
};

const verify = (node: Parameters<typeof fakeNode>[0], cfg = CFG, chainflip: ChainflipSource = chainflipOf()) =>
  verifyDeployment(cfg, new SaleVaultProxyChain(fakeNode(node).rpc), chainflip);

describe('verifyDeployment', () => {
  it('returns the verified deployment with its immutables', async () => {
    expect(await verify({})).toEqual({
      chain: 'arbitrum',
      chainId: 421614,
      factory: FACTORY,
      implementation: IMPL,
      vault: SEPOLIA.vault,
      usdc: SEPOLIA.usdc,
      broker: SEPOLIA.broker,
      homeChain: 6n,
      homeToken: 12n,
      retryBlocks: 100,
      minReturn: 1_000_000n,
      maxReturn: 100_000_000n,
      priceFloorBps: 9_900n,
      feeAllowance: 50_000n,
      returnCooldown: 900n,
      releaseDelay: 86_400n,
      releaseAttempts: 7n,
      staleDelay: 5_184_000n,
      guardian: GUARDIAN,
    });
  });

  it('refuses a home-only factory or implementation, whose claimer-bound getters revert, as misconfigured', async () => {
    const homeOnly = (drop: string) => ({ getters: Object.fromEntries(Object.entries(deployedGetters()).filter(([key]) => key !== drop)) });
    for (const [drop, what] of [
      [`${FACTORY}:GUARDIAN()`, `factory ${FACTORY}`],
      [`${IMPL}:RELEASE_DELAY()`, `implementation ${IMPL}`],
    ] as const) {
      const result = verify(homeOnly(drop));
      await expect(result).rejects.toBeInstanceOf(SaleVaultProxyMisconfigured);
      await expect(result).rejects.toThrow(`${what} does not answer the claimer-bound ABI`);
    }
    // A node error that is not a revert stays retryable
    const flaky = verify({ getters: {}, methods: { eth_call: () => Promise.reject(new RpcCallError('rpc eth_call error: rate limited', -32005)) } });
    await expect(flaky).rejects.not.toBeInstanceOf(SaleVaultProxyMisconfigured);
  });

  it.each([
    ['a wrong chain id', { chainId: 42161n }, CFG, /answers chain 42161/],
    ['no factory code', { code: { [IMPL]: '0x60' } }, CFG, /no contract at factory/],
    ['no implementation code', { code: { [FACTORY]: '0x60' } }, CFG, /no contract at implementation/],
    ['a factory naming an implementation with no code', { getters: deployedGetters({ [`${FACTORY}:IMPLEMENTATION()`]: w('33'.repeat(20)) }) }, CFG, /no contract at implementation 0x3333/],
    ['a factory vault other than config', { getters: deployedGetters({ [`${FACTORY}:VAULT()`]: w('33'.repeat(20)) }) }, CFG, /factory vault/],
    ['a factory USDC other than config', {}, { ...CFG, usdc: `0x${'33'.repeat(20)}` }, /factory USDC/],
    ['a wrong factory back-reference', { getters: deployedGetters({ [`${IMPL}:FACTORY()`]: w('33'.repeat(20)) }) }, CFG, /implementation factory/],
    ['a USDC that is not 6 decimals', { getters: deployedGetters({ [`${SEPOLIA.usdc}:decimals()`]: w(18n) }) }, CFG, /18 decimals/],
    ['a chain with no pinned network', {}, { ...CFG, chainId: 1 }, /no pinned Chainflip network/],
    ['a factory predicting another proxy than the off-chain derivation', { predicted: w('33'.repeat(20)) }, CFG, /factory predicts proxy 0x3333.*off-chain derivation gives 0x/],
  ])('refuses %s as misconfigured', async (_name, node, cfg, message) => {
    const result = verify(node, cfg);
    await expect(result).rejects.toBeInstanceOf(SaleVaultProxyMisconfigured);
    await expect(result).rejects.toThrow(message);
  });

  it('refuses a State Chain of the other network as misconfigured', async () => {
    const result = verify({}, CFG, chainflipOf({ stateChain: 'Chainflip-Berghain' }));
    await expect(result).rejects.toBeInstanceOf(SaleVaultProxyMisconfigured);
    await expect(result).rejects.toThrow(/needs Chainflip-Perseverance/);
  });

  it('leaves the live Vault, route and window out of identity, so a Chainflip change never stops existing sales', async () => {
    const chainflip = chainflipOf({
      vault: `0x${'33'.repeat(20)}`,
      route: { broker: `0x${'11'.repeat(32)}` },
      bounds: { floor: 1_000_001n, maxRetryBlocks: 0 },
      broker: false,
      down: new ChainUnavailableError('cf down'),
    });
    await expect(verify({}, CFG, chainflip)).resolves.toMatchObject({ factory: FACTORY });
  });

  it("verifies a factory against its own configured Vault, a retired one's after Chainflip moved", async () => {
    const old = `0x${'33'.repeat(20)}`;
    await expect(verify({ getters: deployedGetters({ [`${FACTORY}:VAULT()`]: w(old) }) }, { ...CFG, vault: old })).resolves.toMatchObject({ vault: old });
  });

  it('surfaces an RPC outage as retryable', async () => {
    const chain = new SaleVaultProxyChain(async () => Promise.reject(new ChainUnavailableError('down')));
    await expect(verifyDeployment(CFG, chain, chainflipOf())).rejects.toBeInstanceOf(ChainUnavailableError);
  });
});

describe('verifyWindow', () => {
  const window = async (chainflip: ChainflipSource, getters: Record<string, string> = {}) =>
    verifyWindow(await verify({ getters: deployedGetters(getters) }), chainflip);

  it('passes a deployment that fits the live route and window', async () => {
    await expect(window(chainflipOf())).resolves.toBeUndefined();
    await expect(window(chainflipOf({ bounds: { maximum: null } }))).resolves.toBeUndefined();
  });

  it('asks the encoder for a return at the minimum, refunding to the factory', async () => {
    const chainflip = chainflipOf();
    const returnRoute = vi.spyOn(chainflip, 'returnRoute');
    await window(chainflip);
    expect(returnRoute).toHaveBeenCalledWith({ amount: 1_000_000n, refund: FACTORY, home: `0x${'0'.repeat(24)}${FACTORY.slice(2)}`, retryBlocks: 100 });
  });

  it('surfaces a Chainflip outage as retryable', async () => {
    await expect(window(chainflipOf({ down: new ChainUnavailableError('cf down') }))).rejects.toBeInstanceOf(ChainUnavailableError);
  });

  it.each<[string, ChainflipSource, Record<string, string>, RegExp]>([
    ['a State Chain vault other than config', chainflipOf({ vault: `0x${'33'.repeat(20)}` }), {}, /Chainflip's Arbitrum vault/],
    ['an encoder targeting another vault', chainflipOf({ route: { vault: `0x${'33'.repeat(20)}` } }), {}, /targets vault/],
    ['an encoder taking another USDC', chainflipOf({ route: { usdc: `0x${'33'.repeat(20)}` } }), {}, /takes USDC/],
    ['a broker other than the encoder default', chainflipOf(), { [`${IMPL}:BROKER()`]: w(1n) }, /default broker/],
    ['a home chain other than the encoder Assethub', chainflipOf(), { [`${IMPL}:HOME_CHAIN()`]: w(5n) }, /home chain/],
    ['a home token other than the encoder HubUsdt', chainflipOf(), { [`${IMPL}:HOME_TOKEN()`]: w(3n) }, /home token/],
    ['a MIN_RETURN under the live floor', chainflipOf({ bounds: { floor: 1_000_001n } }), {}, /below Chainflip's floor/],
    ['a MAX_RETURN over the live maximum swap', chainflipOf({ bounds: { maximum: 99_999_999n } }), {}, /above Chainflip's maximum swap/],
    ['RETRY_BLOCKS over the live retry cap', chainflipOf({ bounds: { maxRetryBlocks: 99 } }), {}, /over Chainflip's cap 99/],
    ['a broker Chainflip has not registered', chainflipOf({ broker: false }), {}, /not a registered Chainflip broker/],
  ])('refuses %s as misconfigured', async (_name, chainflip, getters, message) => {
    const result = window(chainflip, getters);
    await expect(result).rejects.toBeInstanceOf(SaleVaultProxyMisconfigured);
    await expect(result).rejects.toThrow(message);
  });
});
