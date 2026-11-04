import { describe, expect, it, vi } from 'vitest';

import { ChainUnavailableError, type RpcTransport } from '../../src/salevaultproxy/chain.js';
import { proxyMinOut, returnChunk, ReturnLimits, ReturnNotSwappableError, type PriceTerms } from '../../src/salevaultproxy/limits.js';
import { SEPOLIA, SEPOLIA_VAULT_BYTES, SEPOLIA_VAULT_SWAP } from './fakes.js';

// Trimmed cf_ingress_egress_environment and cf_swapping_environment answers
const ingress = (minimum: unknown = '0x989680', egress: unknown = '0x12d9') => ({
  minimum_deposit_amounts: { Arbitrum: { USDC: minimum } },
  egress_fees: { Arbitrum: { USDC: egress } },
});
const swapping = (maximum: unknown = null, feeMinimum: unknown = 500_000, retryCap: unknown = 600) => ({
  maximum_swap_amounts: { Arbitrum: { USDC: maximum } },
  network_fees: { regular_network_fee: { standard_rate_and_minimum: { rate: 1000, minimum: feeMinimum } } },
  max_swap_retry_duration_blocks: retryCap,
});
// Perseverance's ss58 prefix and its default broker as cf_account_info names it
const PROPERTIES = { ss58Format: 2112 };
const BROKER_SS58 = 'cFMTNSQQVfBo2HqtekvhLPfZY764kuJDVFG1EvnnDGYxc3LRW';
const ROUTE = { retryBlocks: 100, broker: SEPOLIA.broker };

const rpcOf = (i: unknown, s: unknown, vaults: unknown = null, role: unknown = 'broker'): RpcTransport => async (method, params) => {
  if (method === 'system_properties') return PROPERTIES;
  if (method === 'cf_account_info') return params[0] === BROKER_SS58 ? { role } : { role: 'unregistered' };
  return method === 'cf_ingress_egress_environment' ? i : method === 'cf_get_vault_addresses' ? vaults : s;
};
const limits = (i: unknown, s: unknown, fetchImpl?: typeof fetch, vaults?: unknown) =>
  ReturnLimits.create({ rpcUrl: 'https://cf.example', backendUrl: 'https://backend.example/', ttlMs: 0 }, rpcOf(i, s, vaults), fetchImpl);
const answer = (body: unknown, init?: ResponseInit) => vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify(body), init));

describe('ReturnLimits.stateChain', () => {
  it("reads the State Chain's name and refuses anything else", async () => {
    const named = (name: unknown) => ReturnLimits.create({ rpcUrl: 'https://cf.example', backendUrl: 'https://backend.example', ttlMs: 0 }, async () => name);
    expect(await named('Chainflip-Perseverance').stateChain()).toBe('Chainflip-Perseverance');
    await expect(named(7).stateChain()).rejects.toThrow(/expected a name/);
  });
});

describe('returnChunk', () => {
  const limits = { minReturn: 1_000_000n, maxReturn: 100_000_000n };

  it('mirrors the contract: the whole balance up to the maximum, else a chunk leaving nothing or at least the minimum', () => {
    expect(returnChunk(100_000_000n, limits)).toBe(100_000_000n);
    expect(returnChunk(100_500_000n, limits)).toBe(99_500_000n);
    expect(returnChunk(250_000_000n, limits)).toBe(100_000_000n);
  });
});

describe('ReturnLimits.check', () => {
  const refusal = async (result: Promise<void>): Promise<unknown> => result.then(() => undefined, (error: unknown) => error);

  it('accepts an amount above the minimum deposit plus two refunds of network and egress fees', async () => {
    // 10 USDC minimum + 2 * (0.5 network fee minimum + 0.004825 egress fee)
    await expect(limits(ingress(), swapping()).check(11_009_650n, ROUTE)).resolves.toBeUndefined();
  });

  it('refuses below the minimum plus refund fees and above the maximum as not swappable, and swaps exactly the maximum', async () => {
    const below = await refusal(limits(ingress(), swapping()).check(11_009_649n, ROUTE));
    expect(below).toBeInstanceOf(ReturnNotSwappableError);
    expect(below).toMatchObject({ reason: 'not-swappable' });
    await expect(limits(ingress('0x0'), swapping('0x5f5e100', 1000)).check(100_000_001n, ROUTE)).rejects.toThrow(/maximum swap/);
    await expect(limits(ingress('0x0'), swapping('0x5f5e100', 1000)).check(100_000_000n, ROUTE)).resolves.toBeUndefined();
  });

  it('refuses a retry window over the live cap and an unregistered broker as a route Chainflip would refund', async () => {
    const over = await refusal(limits(ingress(), swapping(null, 500_000, 99)).check(20_000_000n, ROUTE));
    expect(over).toMatchObject({ reason: 'route-refused', message: expect.stringMatching(/over Chainflip's cap 99/) });
    await expect(limits(ingress(), swapping(null, 500_000, 100)).check(20_000_000n, ROUTE)).resolves.toBeUndefined();
    const unregistered = ReturnLimits.create({ rpcUrl: 'https://cf.example', backendUrl: 'https://backend.example', ttlMs: 0 }, rpcOf(ingress(), swapping(), null, 'unregistered'));
    expect(await refusal(unregistered.check(20_000_000n, ROUTE))).toMatchObject({ reason: 'route-refused', message: expect.stringMatching(/not a registered Chainflip broker/) });
    expect(await refusal(limits(ingress(), swapping()).check(20_000_000n, { ...ROUTE, broker: `0x${'11'.repeat(32)}` }))).toMatchObject({ reason: 'route-refused' });
  });

  it('accepts anything when there are no limits', async () => {
    await expect(limits(ingress(null, '0x0'), swapping(null, 0)).check(1n << 100n, ROUTE)).resolves.toBeUndefined();
  });

  it('treats a malformed limit or account as an unavailable chain', async () => {
    await expect(limits(ingress('ten'), swapping()).check(1n, ROUTE)).rejects.toBeInstanceOf(ChainUnavailableError);
    await expect(limits({ minimum_deposit_amounts: { Arbitrum: {} } }, swapping()).check(1n, ROUTE)).rejects.toThrow(/no Arbitrum USDC entry/);
    await expect(limits(null, swapping()).check(1n, ROUTE)).rejects.toThrow(/no Arbitrum USDC entry/);
    await expect(limits(ingress(), swapping(null, '500000')).check(20_000_000n, ROUTE)).rejects.toThrow(/network fee minimum/);
    await expect(limits(ingress(), swapping(null, 500_000, '600')).check(20_000_000n, ROUTE)).rejects.toThrow(/max_swap_retry_duration_blocks/);
    await expect(limits(ingress(), null).check(20_000_000n, ROUTE)).rejects.toThrow(/no Arbitrum USDC entry/);
    await expect(limits(ingress('0x0', null), swapping()).check(20_000_000n, ROUTE)).rejects.toThrow(/egress_fees: missing/);
    const noRole = ReturnLimits.create({ rpcUrl: 'https://cf.example', backendUrl: 'https://backend.example', ttlMs: 0 }, rpcOf(ingress(), swapping(), null, null));
    await expect(noRole.check(20_000_000n, ROUTE)).rejects.toThrow(/no role for cFMTNSQQ/);
    const noPrefix = ReturnLimits.create({ rpcUrl: 'https://cf.example', backendUrl: 'https://backend.example', ttlMs: 0 }, async () => null);
    await expect(noPrefix.brokerRegistered(SEPOLIA.broker)).rejects.toThrow(/ss58Format/);
  });

  it('reuses one live read for the TTL, and reads again after it or after a failure', async () => {
    let now = 0;
    let fail = true;
    const rpc = vi.fn<RpcTransport>(async (method, params) => {
      if (method === 'cf_swapping_environment' && fail) {
        fail = false;
        throw new ChainUnavailableError('down');
      }
      return rpcOf(ingress(), swapping())(method, params);
    });
    const cached = ReturnLimits.create({ rpcUrl: 'https://cf.example', backendUrl: 'https://backend.example', ttlMs: 30_000 }, rpc, undefined, () => now);
    await expect(cached.check(20_000_000n, ROUTE)).rejects.toThrow('down');
    await cached.check(20_000_000n, ROUTE);
    const reads = () => rpc.mock.calls.filter(([method]) => method === 'cf_swapping_environment').length;
    expect(reads()).toBe(2);
    now = 29_999;
    await cached.check(20_000_000n, ROUTE);
    expect(reads()).toBe(2);
    expect(rpc.mock.calls.filter(([method]) => method === 'cf_account_info')).toHaveLength(1);
    now = 30_000;
    await cached.check(20_000_000n, ROUTE);
    expect(reads()).toBe(3);
  });
});

describe('ReturnLimits.quotedOutput', () => {
  it('reads the regular quote egress amount', async () => {
    const fetchImpl = answer([{ type: 'DCA', egressAmount: '1' }, { type: 'REGULAR', egressAmount: '19795000' }]);
    expect(await limits(ingress(), swapping(), fetchImpl).quotedOutput(20_000_000n)).toBe(19_795_000n);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      'https://backend.example/v2/quote?amount=20000000&srcChain=Arbitrum&srcAsset=USDC&destChain=Assethub&destAsset=USDT&isVaultSwap=true',
    );
  });

  it('treats a missing quote, a refusal, a non-JSON body or a transport failure as unavailable', async () => {
    await expect(limits(ingress(), swapping(), answer([{ type: 'REGULAR' }])).quotedOutput(1n)).rejects.toThrow(/egress amount/);
    await expect(limits(ingress(), swapping(), answer({ error: 'x' })).quotedOutput(1n)).rejects.toThrow(/egress amount/);
    await expect(limits(ingress(), swapping(), answer({}, { status: 500 })).quotedOutput(1n)).rejects.toThrow(/returned 500/);
    const html = vi.fn(async () => new Response('<html>'));
    await expect(limits(ingress(), swapping(), html).quotedOutput(1n)).rejects.toThrow(/not JSON/);
    const down = vi.fn(async () => Promise.reject(new Error('reset')));
    await expect(limits(ingress(), swapping(), down).quotedOutput(1n)).rejects.toThrow(/transport failed: reset/);
  });

  it('defaults to the global fetch and transport', () => {
    expect(ReturnLimits.create({ rpcUrl: 'https://cf.example', backendUrl: 'https://backend.example', ttlMs: 0 })).toBeInstanceOf(ReturnLimits);
  });
});

describe('ReturnLimits.arbitrumVault', () => {
  it('reads the State Chain Arbitrum vault', async () => {
    expect(await limits(null, null, undefined, { arbitrum: { Arb: SEPOLIA_VAULT_BYTES } }).arbitrumVault()).toBe(SEPOLIA.vault);
  });

  it('treats a missing or malformed vault as unavailable', async () => {
    await expect(limits(null, null).arbitrumVault()).rejects.toBeInstanceOf(ChainUnavailableError);
    await expect(limits(null, null, undefined, { arbitrum: { Arb: [1, 2] } }).arbitrumVault()).rejects.toThrow(/no Arbitrum vault/);
    await expect(limits(null, null, undefined, { arbitrum: { Arb: Array(20).fill(256) } }).arbitrumVault()).rejects.toThrow(/no Arbitrum vault/);
  });
});

describe('ReturnLimits.returnRoute', () => {
  const ARGS = { amount: 100_000_000n, refund: '0x1111111111111111111111111111111111111111', home: `0x${'ab'.repeat(32)}`, retryBlocks: 150 };
  const MAINNET_USDC = '0xaf88d065e77c8cc2239327c5edb3a432268e5831';
  // A mainnet /api/encodeVaultSwapData answer for ARGS, to pin the ids and broker on both networks
  const MAINNET_VAULT_SWAP = {
    to: '0x79001a5e762f3befc8e5871b42f6734e00498920',
    calldata:
      '0x04fc7da0000000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000c0000000000000000000000000000000000000000000000000000000000000000c000000000000000000000000af88d065e77c8cc2239327c5edb3a432268e58310000000000000000000000000000000000000000000000000000000005f5e10000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000020abababababababababababababababababababababababababababababababab00000000000000000000000000000000000000000000000000000000000000600196000000111111111111111111111111111111111111111100000000000000000000000000000000000000000000000000000000000000000000000070d0cd75a367987344a3896a18e1510e5429ca5e88357b6c2a2e306b3877380d000000',
    value: '0',
    sourceTokenAddress: MAINNET_USDC,
    chain: 'Arbitrum',
  };

  it('reads the vault, USDC, Assethub ids and default broker off a Perseverance encoding', async () => {
    const fetchImpl = answer(SEPOLIA_VAULT_SWAP);
    expect(await limits(null, null, fetchImpl).returnRoute(ARGS)).toEqual({
      vault: SEPOLIA.vault,
      usdc: SEPOLIA.usdc,
      homeChain: 6n,
      homeToken: 12n,
      broker: SEPOLIA.broker,
    });
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe('https://backend.example/api/encodeVaultSwapData');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual({
      srcAsset: { chain: 'Arbitrum', asset: 'USDC' },
      destAsset: { chain: 'Assethub', asset: 'USDT' },
      srcAddress: ARGS.refund,
      destAddress: ARGS.home,
      amount: '100000000',
      fillOrKillParams: { retryDurationBlocks: 150, refundAddress: ARGS.refund, minPriceX128: '0', maxOraclePriceSlippage: null, refundCcmMetadata: null },
    });
  });

  it('reads the same ids and the mainnet broker off a mainnet encoding', async () => {
    expect(await limits(null, null, answer(MAINNET_VAULT_SWAP)).returnRoute(ARGS)).toEqual({
      vault: MAINNET_VAULT_SWAP.to,
      usdc: MAINNET_VAULT_SWAP.sourceTokenAddress,
      homeChain: 6n,
      homeToken: 12n,
      broker: '0x70d0cd75a367987344a3896a18e1510e5429ca5e88357b6c2a2e306b3877380d',
    });
  });

  it.each([
    ['another call', { ...SEPOLIA_VAULT_SWAP, calldata: `0xdeadbeef${SEPOLIA_VAULT_SWAP.calldata.slice(10)}` }, /not an xSwapToken call/],
    ['no calldata', { to: SEPOLIA.vault }, /not an xSwapToken call/],
    ['a truncated body', { ...SEPOLIA_VAULT_SWAP, calldata: SEPOLIA_VAULT_SWAP.calldata.slice(0, 200) }, /no word/],
    ['cf_parameters of another layout', { ...SEPOLIA_VAULT_SWAP, calldata: SEPOLIA_VAULT_SWAP.calldata.replace('60019600', '60029600') }, /V1 layout/],
    ['a bad target', { ...SEPOLIA_VAULT_SWAP, to: 'vault' }, /to is not an address/],
    ['a bad source token', { ...SEPOLIA_VAULT_SWAP, sourceTokenAddress: null }, /sourceTokenAddress is not an address/],
    ['a null body', null, /not an xSwapToken call/],
  ])('treats %s as unavailable', async (_name, body, message) => {
    const result = limits(null, null, answer(body)).returnRoute(ARGS);
    await expect(result).rejects.toBeInstanceOf(ChainUnavailableError);
    await expect(result).rejects.toThrow(message);
  });

  it('treats a refusal as unavailable', async () => {
    await expect(limits(null, null, answer({ message: 'below minimum' }, { status: 400 })).returnRoute(ARGS)).rejects.toThrow(
      /vault swap encoding returned 400/,
    );
  });
});

// The X128 min price the proxy encodes from its floor, as `CfParameters.minPriceX128` does
const minPriceX128 = (amount: bigint, terms: PriceTerms): bigint => (proxyMinOut(amount, terms) << 128n) / amount;

describe('the proxy floor mirror', () => {
  it('matches the Solidity vectors', () => {
    expect(minPriceX128(10_000_000n, { priceFloorBps: 9_900n, feeAllowance: 0n })).toBe(336879543251729078828740861357450529341n);
    expect(minPriceX128(20_000_000n, { priceFloorBps: 9_900n, feeAllowance: 600_000n })).toBe(326671072244100924924839623134497482997n);
    expect(proxyMinOut(20_000_000n, { priceFloorBps: 9_900n, feeAllowance: 600_000n })).toBe(19_200_000n);
  });
});
