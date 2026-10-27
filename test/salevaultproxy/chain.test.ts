import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  encodeAuthorizationState,
  encodeBalanceOf,
  encodeCall,
  encodeClaimerTermsCall,
  encodeDelivery,
  encodeHomeClaimerCall,
  encodeRetired,
} from '../../src/salevaultproxy/abi.js';
import {
  ChainUnavailableError,
  fetchTransport,
  hexToBigInt,
  isRevert,
  MAX_SANE_FEE_WEI,
  RpcCallError,
  SaleVaultProxyChain,
  toMessage,
} from '../../src/salevaultproxy/chain.js';
import { CLAIMER, FACTORY, fakeNode, GUARDIAN, HOME, IMPL, PROXY, SEPOLIA, TREASURY, w } from './fakes.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

const chainWith = (methods: Record<string, unknown>, extra: Parameters<typeof fakeNode>[0] = {}) =>
  new SaleVaultProxyChain(fakeNode({ ...extra, methods }).rpc);

describe('fetchTransport', () => {
  const stub = (impl: () => Promise<Response>) => {
    vi.stubGlobal('fetch', vi.fn(impl));
  };

  it('returns the result of a JSON-RPC call', async () => {
    stub(async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x1' })));
    await expect(fetchTransport('https://rpc.example')('eth_chainId', [])).resolves.toBe('0x1');
  });

  it('maps a JSON-RPC error to RpcCallError', async () => {
    stub(async () => new Response(JSON.stringify({ error: { message: 'execution reverted' } })));
    await expect(fetchTransport('https://rpc.example')('eth_call', [])).rejects.toBeInstanceOf(RpcCallError);
    stub(async () => new Response(JSON.stringify({ error: {} })));
    await expect(fetchTransport('https://rpc.example')('eth_call', [])).rejects.toThrow(/unknown/);
  });

  it('maps a transport failure, an HTTP error and a non-JSON body to ChainUnavailableError', async () => {
    stub(async () => Promise.reject(new Error('ECONNREFUSED')));
    await expect(fetchTransport('https://rpc.example')('eth_chainId', [])).rejects.toThrow(/transport failed: ECONNREFUSED/);
    stub(async () => new Response('busy', { status: 503 }));
    await expect(fetchTransport('https://rpc.example')('eth_chainId', [])).rejects.toThrow(/returned 503/);
    stub(async () => new Response('<html>'));
    await expect(fetchTransport('https://rpc.example')('eth_chainId', [])).rejects.toThrow(/not JSON/);
  });

  it('is what create builds without a transport', async () => {
    stub(async () => new Response(JSON.stringify({ result: '0x66eee' })));
    await expect(SaleVaultProxyChain.create('https://rpc.example').chainId()).resolves.toBe(421614n);
  });
});

describe('helpers', () => {
  it('names an error and parses a quantity', () => {
    expect(toMessage(new Error('x'))).toBe('x');
    expect(toMessage('y')).toBe('y');
    expect(hexToBigInt('0x10', 'n')).toBe(16n);
    expect(() => hexToBigInt('0x', 'n')).toThrow(ChainUnavailableError);
    expect(() => hexToBigInt(7, 'n')).toThrow(/expected hex/);
  });
});

describe('SaleVaultProxyChain reads', () => {
  it('reads chain id, code and native balance', async () => {
    const chain = chainWith({ eth_getBalance: '0xde0b6b3a7640000' });
    expect(await chain.chainId()).toBe(421614n);
    expect(await chain.code(FACTORY)).toBe('0x60');
    expect(await chain.code(PROXY)).toBe('0x');
    expect(await chain.nativeBalance(TREASURY)).toBe(10n ** 18n);
  });

  it('reads the proxy state, a USDC balance, a pending amount and whether the factory is retired', async () => {
    const state = `0x${HOME.slice(2)}${w(CLAIMER)}${w(9n)}${w(0n)}${w(0n)}${w(0n)}${w(1_800_000_000n)}${w(9n)}`;
    const chain = chainWith({
      eth_call: ([{ to, data }]: [{ to: string; data: string }]) => {
        if (to === PROXY) return state;
        if (data === encodeBalanceOf(PROXY)) return `0x${w(9n)}`;
        if (data === encodeHomeClaimerCall('pending(bytes32,address)', HOME, CLAIMER)) return `0x${w(3n)}`;
        if (data === encodeRetired()) return `0x${w(1n)}`;
        return '0x';
      },
    }, { getters: {} });
    expect(await chain.proxyState(PROXY)).toMatchObject({ claimer: CLAIMER, balance: 9n, releaseAt: 1_800_000_000n, releasable: 9n });
    expect(await chain.usdcBalance(SEPOLIA.usdc, PROXY)).toBe(9n);
    expect(await chain.pending(FACTORY, HOME, CLAIMER)).toBe(3n);
    expect(await chain.retired(FACTORY)).toBe(true);
  });

  it('reads a bytes32 getter and an EIP-3009 authorization state', async () => {
    const nonce = `0x${'cd'.repeat(32)}`;
    const chain = chainWith({
      eth_call: ([{ data }]: [{ to: string; data: string }]) => {
        if (data === encodeCall('DOMAIN_SEPARATOR()')) return `0x${'85'.repeat(32)}`;
        if (data === encodeAuthorizationState(PROXY, nonce)) return `0x${w(1n)}`;
        return `0x${w(2n)}`;
      },
    });
    expect(await chain.bytes32Of(SEPOLIA.usdc, 'DOMAIN_SEPARATOR()')).toBe(`0x${'85'.repeat(32)}`);
    expect(await chain.authorizationUsed(SEPOLIA.usdc, PROXY, nonce)).toBe(true);
    await expect(chain.authorizationUsed(SEPOLIA.usdc, PROXY, `0x${'ef'.repeat(32)}`)).rejects.toThrow(/rpc authorizationState: not a bool/);
  });

  it('reads no state where no code is deployed, and turns a short reply into ChainUnavailableError', async () => {
    expect(await chainWith({ eth_call: () => '0x' }).proxyState(PROXY)).toBeUndefined();
    await expect(chainWith({ eth_call: () => `0x${w(1n)}` }).proxyState(PROXY)).rejects.toThrow(/rpc state: return data has no word/);
  });

  it('reads the factory and implementation getters', async () => {
    const chain = chainWith({});
    expect(await chain.factoryInfo(FACTORY)).toEqual({
      implementation: IMPL,
      vault: SEPOLIA.vault,
      usdc: SEPOLIA.usdc,
      guardian: GUARDIAN,
    });
    expect(await chain.retired(FACTORY)).toBe(false);
    expect(await chain.totalPending(FACTORY)).toBe(0n);
    expect(await chain.decimals(SEPOLIA.usdc)).toBe(6);
    expect(await chain.implementationInfo(IMPL)).toEqual({
      factory: FACTORY,
      broker: SEPOLIA.broker,
      homeChain: 6n,
      homeToken: 12n,
      retryBlocks: 100n,
      minReturn: 1_000_000n,
      maxReturn: 100_000_000n,
      priceFloorBps: 9_900n,
      feeAllowance: 50_000n,
      returnCooldown: 900n,
      releaseDelay: 86_400n,
      releaseAttempts: 7n,
      staleDelay: 5_184_000n,
    });
  });

  it("reads one sale's record and its deferred amount by the sale's exact terms", async () => {
    const terms = { home: HOME, claimer: CLAIMER, ref: `0x${'12'.repeat(32)}`, recipient: TREASURY, committed: 50_000_000n };
    const chain = chainWith({
      eth_call: ([{ data }]: [{ data: string }]) => {
        if (data === encodeDelivery(terms)) return `0x${w(2n)}${w(30_000_000n)}${w(0n)}`;
        if (data === encodeClaimerTermsCall('pendingDelivery(bytes32,address,bytes32,address,uint256,uint256)', terms, 1_795_590_573n)) return `0x${w(7n)}`;
        return '0x';
      },
    });
    expect(await chain.delivery(PROXY, terms)).toEqual({ status: 2, amount: 30_000_000n, leftover: 0n });
    expect(await chain.pendingDelivery(FACTORY, terms, 1_795_590_573n)).toBe(7n);
  });

  it('reads logs over a block range, and refuses a reply that is not a list', async () => {
    const seen: unknown[] = [];
    const chain = chainWith({
      eth_blockNumber: '0x10',
      eth_getLogs: (params: unknown[]) => {
        seen.push(params[0]);
        return [
          { address: FACTORY.toUpperCase().replace('0X', '0x'), topics: [`0x${w(1n)}`], data: '0x', transactionHash: `0x${'AB'.repeat(32)}`, logIndex: '0x2' },
          { address: FACTORY, data: '0x', transactionHash: `0x${'cd'.repeat(32)}`, logIndex: '0x0' },
        ];
      },
    });
    expect(await chain.blockNumber()).toBe(16n);
    expect(await chain.logs({ address: [FACTORY], topics: [null], fromBlock: 1n, toBlock: 255n })).toEqual([
      { address: FACTORY, topics: [`0x${w(1n)}`], data: '0x', txHash: `0x${'ab'.repeat(32)}`, logIndex: 2 },
      { address: FACTORY, topics: [], data: '0x', txHash: `0x${'cd'.repeat(32)}`, logIndex: 0 },
    ]);
    expect(seen).toEqual([{ address: [FACTORY], topics: [null], fromBlock: '0x1', toBlock: '0xff' }]);
    await expect(chainWith({ eth_getLogs: { error: 'range' } }).logs({ address: FACTORY, topics: [], fromBlock: 0n, toBlock: 0n })).rejects.toThrow(
      /expected a list/,
    );
  });

  it("reads one contract's first log block in a range, undefined when it logged none", async () => {
    const seen: unknown[] = [];
    let answer: unknown = [{ blockNumber: '0x20' }, { blockNumber: '0x1f' }];
    const chain = chainWith({
      eth_getLogs: (params: unknown[]) => {
        seen.push(params[0]);
        return answer;
      },
    });
    expect(await chain.firstLogBlock(FACTORY, 1n, 255n)).toBe(31n);
    expect(seen).toEqual([{ address: FACTORY, topics: [], fromBlock: '0x1', toBlock: '0xff' }]);
    answer = [];
    expect(await chain.firstLogBlock(FACTORY, 1n, 255n)).toBeUndefined();
    answer = { error: 'range' };
    await expect(chain.firstLogBlock(FACTORY, 1n, 255n)).rejects.toThrow(/expected a list/);
    answer = [{}];
    await expect(chain.firstLogBlock(FACTORY, 1n, 255n)).rejects.toThrow(/getLogs blockNumber/);
  });

  it('reads nonces, transactions and receipts', async () => {
    const chain = chainWith({
      eth_getTransactionCount: ([, tag]: [string, string]) => (tag === 'pending' ? '0x5' : '0x4'),
      eth_getTransactionByHash: ([hash]: [string]) => (hash === '0xaa' ? { hash: '0xaa' } : null),
      eth_getTransactionReceipt: ([hash]: [string]) => (hash === '0xaa' ? { status: '0x1' } : hash === '0xbb' ? { status: '0x0' } : null),
    });
    expect(await chain.transactionCount(TREASURY, 'pending')).toBe(5n);
    expect(await chain.transactionCount(TREASURY, 'latest')).toBe(4n);
    expect(await chain.transactionByHash('0xaa')).toEqual({ hash: '0xaa' });
    expect(await chain.transactionByHash('0xcc')).toBeNull();
    expect(await chain.receipt('0xaa')).toEqual({ status: true });
    expect(await chain.receipt('0xbb')).toEqual({ status: false });
    expect(await chain.receipt('0xcc')).toBeNull();
  });

  it('tells an execution revert from a node failure', () => {
    expect(isRevert(new RpcCallError('rpc eth_estimateGas error: anything', 3))).toBe(true);
    expect(isRevert(new RpcCallError('rpc eth_estimateGas error: execution reverted: paused', -32000))).toBe(true);
    expect(isRevert(new RpcCallError('rpc eth_estimateGas error: nonce too low', -32000))).toBe(false);
    expect(isRevert(new RpcCallError('rpc eth_estimateGas error: reverting to an older state', -32000))).toBe(false);
  });

  it('estimates gas and broadcasts', async () => {
    const chain = chainWith({ eth_estimateGas: '0x5208', eth_sendRawTransaction: '0xhash' });
    expect(await chain.estimateGas(TREASURY, PROXY, '0x2aadc832')).toBe(21_000n);
    expect(await chain.sendRaw('0x02')).toBe('0xhash');
  });
});

describe('SaleVaultProxyChain blockTimestamp', () => {
  it('reads a block timestamp and refuses an unknown block', async () => {
    const seen: unknown[] = [];
    const chain = chainWith({
      eth_getBlockByNumber: (params: unknown[]) => {
        seen.push(params);
        return { timestamp: '0x64e4f6d4' };
      },
    });
    expect(await chain.blockTimestamp(1n)).toBe(1_692_726_996n);
    expect(seen).toEqual([['0x1', false]]);
    await expect(chainWith({ eth_getBlockByNumber: null }).blockTimestamp(9n)).rejects.toThrow(/block 9 unknown/);
    await expect(chainWith({ eth_getBlockByNumber: {} }).blockTimestamp(9n)).rejects.toThrow(/block timestamp/);
  });
});

describe('SaleVaultProxyChain fees', () => {
  it('doubles the base fee and adds the tip', async () => {
    const chain = chainWith({ eth_getBlockByNumber: { baseFeePerGas: '0x64' }, eth_maxPriorityFeePerGas: '0xa' });
    expect(await chain.fees()).toEqual({ maxFeePerGas: 210n, maxPriorityFeePerGas: 10n });
  });

  it('refuses an unknown latest block or one without a base fee as a node failure', async () => {
    for (const block of [null, {}]) {
      const fees = chainWith({ eth_getBlockByNumber: block, eth_maxPriorityFeePerGas: '0x1' }).fees();
      await expect(fees).rejects.toBeInstanceOf(ChainUnavailableError);
      await expect(fees).rejects.toThrow(/unknown or without a baseFeePerGas/);
    }
  });

  it('refuses a signed max fee beyond the sane ceiling, the doubled base fee included', async () => {
    const half = MAX_SANE_FEE_WEI / 2n;
    expect(await chainWith({ eth_getBlockByNumber: { baseFeePerGas: `0x${half.toString(16)}` }, eth_maxPriorityFeePerGas: '0x0' }).fees()).toEqual({ maxFeePerGas: MAX_SANE_FEE_WEI, maxPriorityFeePerGas: 0n });
    await expect(chainWith({ eth_getBlockByNumber: { baseFeePerGas: `0x${half.toString(16)}` }, eth_maxPriorityFeePerGas: '0x1' }).fees()).rejects.toThrow(/sane ceiling/);
    const huge = `0x${(MAX_SANE_FEE_WEI + 1n).toString(16)}`;
    await expect(chainWith({ eth_getBlockByNumber: { baseFeePerGas: huge }, eth_maxPriorityFeePerGas: '0x1' }).fees()).rejects.toThrow(
      /sane ceiling/,
    );
    await expect(chainWith({ eth_getBlockByNumber: { baseFeePerGas: '0x1' }, eth_maxPriorityFeePerGas: huge }).fees()).rejects.toThrow(
      /sane ceiling/,
    );
  });
});
