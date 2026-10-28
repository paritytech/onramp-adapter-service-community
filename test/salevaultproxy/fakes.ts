// Shared fakes for the sale vault proxy suites: a scripted JSON-RPC node and a deployed factory.

import { decodeAddress, encodeCall } from '../../src/salevaultproxy/abi.js';
import { RpcCallError, type RpcTransport } from '../../src/salevaultproxy/chain.js';
import { predictSaleVaultProxy } from '../../src/salevaultproxy/derive.js';
import type { ReturnRoute, SwapBounds } from '../../src/salevaultproxy/limits.js';
import type { ChainflipSource } from '../../src/salevaultproxy/verify.js';

export const FACTORY = '0x1111111111111111111111111111111111111111';
export const IMPL = '0x2222222222222222222222222222222222222222';
export const TREASURY = '0x4444444444444444444444444444444444444444';
export const HOME = '0xd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d';
export const PROXY = '0xfb63126b916e3bd2497702a0139ad2b344ac7536';
export const CLAIMER = '0x3333333333333333333333333333333333333333';
export const GUARDIAN = '0x5555555555555555555555555555555555555555';
// Perseverance's Arbitrum Vault, USDC and default broker
export const SEPOLIA = {
  vault: '0x2bb150e6d4366a1bdbc4275d1f35892cd63f27e3',
  usdc: '0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d',
  broker: '0x9e8d88ae895c9b37b2dead9757a3452f7c2299704d91ddfa444d87723f94fe0c',
} as const;

// A Perseverance /api/encodeVaultSwapData answer for 100 Arbitrum USDC to Assethub USDT, no broker named
export const SEPOLIA_VAULT_SWAP = {
  to: SEPOLIA.vault,
  calldata:
    '0x04fc7da0000000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000c0000000000000000000000000000000000000000000000000000000000000000c00000000000000000000000075faf114eafb1bdbe2f0316df893fd58ce46aa4d0000000000000000000000000000000000000000000000000000000005f5e10000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000020d43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d0000000000000000000000000000000000000000000000000000000000000060019600000011111111111111111111111111111111111111110100000000000000000000000000000000000000000000000000000000000000000000009e8d88ae895c9b37b2dead9757a3452f7c2299704d91ddfa444d87723f94fe0c000000',
  value: '0',
  sourceTokenAddress: SEPOLIA.usdc,
  chain: 'Arbitrum',
};

// A Perseverance cf_get_vault_addresses Arbitrum entry
export const SEPOLIA_VAULT_BYTES = [43, 177, 80, 230, 212, 54, 106, 27, 219, 196, 39, 93, 31, 53, 137, 44, 214, 63, 39, 227];

/** A Chainflip that agrees with the Sepolia deployment, with any read overridden. */
export function chainflipOf(
  overrides: { vault?: string; route?: Partial<ReturnRoute>; down?: Error; bounds?: Partial<SwapBounds>; broker?: boolean; stateChain?: string } = {},
): ChainflipSource {
  return {
    arbitrumVault: async () => (overrides.down ? Promise.reject(overrides.down) : (overrides.vault ?? SEPOLIA.vault)),
    returnRoute: async () => ({ vault: SEPOLIA.vault, usdc: SEPOLIA.usdc, homeChain: 6n, homeToken: 12n, broker: SEPOLIA.broker, ...overrides.route }),
    // Perseverance's window: no minimum deposit, a 100 USDC maximum swap, a 600 block retry cap
    bounds: async () => ({ floor: 20_000n, maximum: 100_000_000n, maxRetryBlocks: 600, ...overrides.bounds }),
    brokerRegistered: async () => overrides.broker ?? true,
    stateChain: async () => overrides.stateChain ?? 'Chainflip-Perseverance',
  };
}

/** A uint or an address as one 0x-less word. */
export const w = (value: bigint | string): string =>
  typeof value === 'bigint' ? value.toString(16).padStart(64, '0') : value.replace(/^0x/, '').padStart(64, '0');

/** The getters a correctly built Sepolia deployment answers. */
export function deployedGetters(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    [`${FACTORY}:IMPLEMENTATION()`]: w(IMPL),
    [`${FACTORY}:VAULT()`]: w(SEPOLIA.vault),
    [`${FACTORY}:USDC()`]: w(SEPOLIA.usdc),
    [`${FACTORY}:GUARDIAN()`]: w(GUARDIAN),
    [`${FACTORY}:retired()`]: w(0n),
    [`${FACTORY}:totalPending()`]: w(0n),
    [`${SEPOLIA.usdc}:decimals()`]: w(6n),
    [`${IMPL}:FACTORY()`]: w(FACTORY),
    [`${IMPL}:BROKER()`]: SEPOLIA.broker.slice(2),
    [`${IMPL}:HOME_CHAIN()`]: w(6n),
    [`${IMPL}:HOME_TOKEN()`]: w(12n),
    [`${IMPL}:RETRY_BLOCKS()`]: w(100n),
    [`${IMPL}:MIN_RETURN()`]: w(1_000_000n),
    [`${IMPL}:MAX_RETURN()`]: w(100_000_000n),
    [`${IMPL}:PRICE_FLOOR_BPS()`]: w(9_900n),
    [`${IMPL}:FEE_ALLOWANCE()`]: w(50_000n),
    [`${IMPL}:RETURN_COOLDOWN()`]: w(900n),
    // The Perseverance release constants the contract vectors pin
    [`${IMPL}:RELEASE_DELAY()`]: w(86_400n),
    [`${IMPL}:RELEASE_ATTEMPTS()`]: w(7n),
    [`${IMPL}:STALE_DELAY()`]: w(5_184_000n),
    ...overrides,
  };
}

const PREDICT = encodeCall('predict(bytes32,address)');

/** A scripted node: eth_call is looked up as `to:signature`, a factory's predict derived off its IMPLEMENTATION, everything else by method. */
export function fakeNode(opts: {
  getters?: Record<string, string>;
  chainId?: bigint;
  code?: Record<string, string>;
  methods?: Record<string, unknown>;
  /** A predict answer other than the factory's own derivation. */
  predicted?: string;
}): { rpc: RpcTransport; calls: { method: string; params: unknown[] }[] } {
  const getters = opts.getters ?? deployedGetters();
  const bySelector = new Map<string, string>();
  for (const [key, value] of Object.entries(getters)) {
    const [to = '', signature = ''] = key.split(':');
    bySelector.set(`${to}:${encodeCall(signature)}`, value);
  }
  const calls: { method: string; params: unknown[] }[] = [];
  const rpc: RpcTransport = async (method, params) => {
    calls.push({ method, params });
    if (method === 'eth_chainId') return `0x${(opts.chainId ?? 421614n).toString(16)}`;
    if (method === 'eth_getCode') {
      const code = opts.code ?? { [FACTORY]: '0x60', [IMPL]: '0x60' };
      return code[String(params[0]).toLowerCase()] ?? '0x';
    }
    if (method === 'eth_call') {
      const { to, data } = params[0] as { to: string; data: string };
      const answer = bySelector.get(`${to.toLowerCase()}:${data}`);
      const implementation = getters[`${to.toLowerCase()}:IMPLEMENTATION()`];
      if (data.startsWith(PREDICT) && implementation !== undefined) {
        return `0x${w(opts.predicted ?? predictSaleVaultProxy(to, decodeAddress(`0x${implementation}`), `0x${data.slice(10, 74)}`, decodeAddress(`0x${data.slice(74)}`)))}`;
      }
      const fallback = opts.methods?.eth_call as ((p: unknown[]) => unknown) | undefined;
      if (answer === undefined && fallback !== undefined) return fallback(params);
      if (answer === undefined) throw new RpcCallError(`rpc eth_call error: execution reverted (${to} ${data})`);
      return `0x${answer}`;
    }
    if (opts.methods !== undefined && method in opts.methods) {
      const answer = opts.methods[method];
      return typeof answer === 'function' ? (answer as (p: unknown[]) => unknown)(params) : answer;
    }
    throw new Error(`unscripted ${method}`);
  };
  return { rpc, calls };
}
