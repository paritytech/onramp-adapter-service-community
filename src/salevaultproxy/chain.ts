// JSON-RPC reads and raw broadcasts for the sale vault proxy keeper, over fetch with typed failures and no EVM library.

import {
  decodeAddress,
  decodeBool,
  decodeBytes32,
  decodeClaimerProxyState,
  decodeDelivery,
  decodeUint,
  encodeAuthorizationState,
  encodeBalanceOf,
  encodeCall,
  encodeClaimerTermsCall,
  encodeDelivery,
  encodeHomeClaimerCall,
  encodeRetired,
  type ClaimerProxyState,
  type RawLog,
  type SaleDelivery,
  type SaleTerms,
} from './abi.js';

/** A raw JSON-RPC transport, so tests can inject a fake instead of fetch. */
export type RpcTransport = (method: string, params: unknown[]) => Promise<unknown>;

/** Thrown when the chain is unreachable or answers an error, so callers can degrade rather than crash. */
export class ChainUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChainUnavailableError';
  }
}

/** The node answered with a JSON-RPC error rather than failing to answer. */
export class RpcCallError extends ChainUnavailableError {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
    this.name = 'RpcCallError';
  }
}

/** The call itself reverted, as opposed to the node failing, so retrying it unchanged cannot help. */
export class CallRevertedError extends RpcCallError {
  constructor(message: string, code?: number) {
    super(message, code);
    this.name = 'CallRevertedError';
  }
}

// Geth answers a revert as code 3, Nitro and others as -32000 with this message
const REVERT_CODE = 3;
const REVERT_MESSAGE = /execution reverted/i;

/** Whether a JSON-RPC error is an execution revert rather than a node failure. */
export function isRevert(error: RpcCallError): boolean {
  return error.code === REVERT_CODE || REVERT_MESSAGE.test(error.message);
}

// Every Arbitrum, State Chain and swap backend call, a chosen per-call bound with no upstream source
export const UPSTREAM_TIMEOUT_MS = 15_000;

/** The default transport: a single JSON-RPC POST over fetch, with a timeout and typed failures. */
export function fetchTransport(rpcUrl: string): RpcTransport {
  return async (method, params) => {
    let response: Response;
    try {
      response = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        redirect: 'error',
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
    } catch (error) {
      throw new ChainUnavailableError(`rpc ${method} transport failed: ${toMessage(error)}`);
    }
    if (!response.ok) throw new ChainUnavailableError(`rpc ${method} returned ${String(response.status)}`);
    let body: { result?: unknown; error?: { message?: string; code?: number } };
    try {
      body = (await response.json()) as typeof body;
    } catch (error) {
      throw new ChainUnavailableError(`rpc ${method} answered with a body that is not JSON: ${toMessage(error)}`);
    }
    if (body.error) throw new RpcCallError(`rpc ${method} error: ${body.error.message ?? 'unknown'}`, body.error.code);
    return body.result;
  };
}

/** An error as a message string. */
export function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// A 0x string off an RPC reply, or a ChainUnavailableError
function asHexString(value: unknown, what: string): string {
  if (typeof value !== 'string' || !value.startsWith('0x')) {
    throw new ChainUnavailableError(`rpc ${what}: expected hex, got ${JSON.stringify(value)}`);
  }
  return value;
}

/** A hex quantity to a bigint, refusing "0x" and non-hex as a malformed reply. */
export function hexToBigInt(value: unknown, what: string): bigint {
  const hex = asHexString(value, what);
  if (!/^0x[0-9a-fA-F]+$/.test(hex)) {
    throw new ChainUnavailableError(`rpc ${what}: not a hex quantity, got ${JSON.stringify(value)}`);
  }
  return BigInt(hex);
}

// A ceiling on the max fee per gas the keeper signs, against a broken RPC
export const MAX_SANE_FEE_WEI = 1_000_000_000_000n;

/** The fee pair the keeper signs with. */
export interface Fees {
  readonly maxFeePerGas: bigint;
  readonly maxPriorityFeePerGas: bigint;
}

/** What the factory reports about itself. */
export interface FactoryInfo {
  readonly implementation: string;
  readonly vault: string;
  readonly usdc: string;
  /** The only caller of retire, lowercase. */
  readonly guardian: string;
}

/** What the implementation reports, the immutables every proxy shares. */
export interface ImplementationInfo {
  readonly factory: string;
  readonly broker: string;
  readonly homeChain: bigint;
  readonly homeToken: bigint;
  readonly retryBlocks: bigint;
  readonly minReturn: bigint;
  readonly maxReturn: bigint;
  readonly priceFloorBps: bigint;
  readonly feeAllowance: bigint;
  readonly returnCooldown: bigint;
  readonly releaseDelay: bigint;
  readonly releaseAttempts: bigint;
  readonly staleDelay: bigint;
}

/** A transaction receipt reduced to its outcome. */
export interface Receipt {
  readonly status: boolean;
}

/** Reads and broadcasts against one Arbitrum RPC. The nonce is always the caller's. */
export class SaleVaultProxyChain {
  constructor(private readonly rpc: RpcTransport) {}

  /** Builds a client over fetch, or over an injected transport. */
  static create(rpcUrl: string, rpc?: RpcTransport): SaleVaultProxyChain {
    return new SaleVaultProxyChain(rpc ?? fetchTransport(rpcUrl));
  }

  async chainId(): Promise<bigint> {
    return hexToBigInt(await this.rpc('eth_chainId', []), 'chainId');
  }

  /** The runtime code at an address, "0x" when there is none. */
  async code(address: string): Promise<string> {
    return asHexString(await this.rpc('eth_getCode', [address, 'latest']), 'getCode');
  }

  async nativeBalance(address: string): Promise<bigint> {
    return hexToBigInt(await this.rpc('eth_getBalance', [address, 'latest']), 'getBalance');
  }

  /** The proxy's `state()`, undefined while no code is deployed there. */
  async proxyState(proxy: string): Promise<ClaimerProxyState | undefined> {
    const hex = await this.call(proxy, encodeCall('state()'));
    return hex === '0x' ? undefined : this.decoded(hex, decodeClaimerProxyState, 'state');
  }

  async usdcBalance(usdc: string, address: string): Promise<bigint> {
    return this.decoded(await this.call(usdc, encodeBalanceOf(address)), decodeUint, 'balanceOf');
  }

  /** A no-argument bytes32 getter such as `DOMAIN_SEPARATOR()`, lowercase. */
  async bytes32Of(to: string, signature: string): Promise<string> {
    return this.decoded(await this.call(to, encodeCall(signature)), decodeBytes32, signature);
  }

  /** Whether an EIP-3009 authorization nonce of `authorizer` is used or cancelled. */
  async authorizationUsed(token: string, authorizer: string, nonce: string): Promise<boolean> {
    return this.decoded(await this.call(token, encodeAuthorizationState(authorizer, nonce)), decodeBool, 'authorizationState');
  }

  /** USDC the factory owes a home and claimer that a delivery could not move to its proxy. */
  async pending(factory: string, home: string, claimer: string): Promise<bigint> {
    return this.decoded(await this.call(factory, encodeHomeClaimerCall('pending(bytes32,address)', home, claimer)), decodeUint, 'pending');
  }

  /** The proxy address the factory derives for a home and claimer, lowercase. */
  async predict(factory: string, home: string, claimer: string): Promise<string> {
    return this.decoded(await this.call(factory, encodeHomeClaimerCall('predict(bytes32,address)', home, claimer)), decodeAddress, 'predict');
  }

  /** Whether the factory's guardian retired it, which stops every return home. */
  async retired(factory: string): Promise<boolean> {
    return this.decoded(await this.call(factory, encodeRetired()), decodeBool, 'retired');
  }

  /** One sale's record on its proxy, keyed by its exact terms. */
  async delivery(proxy: string, terms: Pick<SaleTerms, 'ref' | 'recipient' | 'committed'>): Promise<SaleDelivery> {
    return this.decoded(await this.call(proxy, encodeDelivery(terms)), decodeDelivery, 'delivery');
  }

  /** USDC a gas-short delivery with these exact terms and deadline left on the factory for `deliver`. */
  async pendingDelivery(factory: string, terms: SaleTerms, deadline: bigint): Promise<bigint> {
    return this.decoded(
      await this.call(factory, encodeClaimerTermsCall('pendingDelivery(bytes32,address,bytes32,address,uint256,uint256)', terms, deadline)),
      decodeUint,
      'pendingDelivery',
    );
  }

  /** The factory's pending and deferred total, the part of its balance a skim never takes. */
  async totalPending(factory: string): Promise<bigint> {
    return this.uint(factory, 'totalPending()');
  }

  async factoryInfo(factory: string): Promise<FactoryInfo> {
    const [implementation, vault, usdc, guardian] = await Promise.all([
      this.address(factory, 'IMPLEMENTATION()'),
      this.address(factory, 'VAULT()'),
      this.address(factory, 'USDC()'),
      this.address(factory, 'GUARDIAN()'),
    ]);
    return { implementation, vault, usdc, guardian };
  }

  /** The USDC token's decimals, so a committed amount converts by the token's own word. */
  async decimals(token: string): Promise<number> {
    return Number(await this.uint(token, 'decimals()'));
  }

  async implementationInfo(implementation: string): Promise<ImplementationInfo> {
    const [factory, broker, homeChain, homeToken, retryBlocks, minReturn, maxReturn, priceFloorBps, feeAllowance, returnCooldown, releaseDelay, releaseAttempts, staleDelay] =
      await Promise.all([
        this.address(implementation, 'FACTORY()'),
        this.call(implementation, encodeCall('BROKER()')).then((hex) => this.decoded(hex, decodeBytes32, 'BROKER()')),
        this.uint(implementation, 'HOME_CHAIN()'),
        this.uint(implementation, 'HOME_TOKEN()'),
        this.uint(implementation, 'RETRY_BLOCKS()'),
        this.uint(implementation, 'MIN_RETURN()'),
        this.uint(implementation, 'MAX_RETURN()'),
        this.uint(implementation, 'PRICE_FLOOR_BPS()'),
        this.uint(implementation, 'FEE_ALLOWANCE()'),
        this.uint(implementation, 'RETURN_COOLDOWN()'),
        this.uint(implementation, 'RELEASE_DELAY()'),
        this.uint(implementation, 'RELEASE_ATTEMPTS()'),
        this.uint(implementation, 'STALE_DELAY()'),
      ]);
    return { factory, broker, homeChain, homeToken, retryBlocks, minReturn, maxReturn, priceFloorBps, feeAllowance, returnCooldown, releaseDelay, releaseAttempts, staleDelay };
  }

  async transactionCount(address: string, tag: 'latest' | 'pending'): Promise<bigint> {
    return hexToBigInt(await this.rpc('eth_getTransactionCount', [address, tag]), 'getTransactionCount');
  }

  /** Whether the node still knows a transaction, mined or pending. */
  async transactionByHash(hash: string): Promise<{ hash: string } | null> {
    const tx = (await this.rpc('eth_getTransactionByHash', [hash])) as { hash?: unknown } | null;
    if (tx === null) return null;
    return { hash: asHexString(tx.hash, 'getTransactionByHash') };
  }

  /** The receipt of a broadcast transaction, or null when it is not mined. */
  async receipt(hash: string): Promise<Receipt | null> {
    const r = (await this.rpc('eth_getTransactionReceipt', [hash])) as { status?: unknown } | null;
    if (r === null) return null;
    return { status: r.status === '0x1' };
  }

  /** The gas a call needs from `from`. A revert throws CallRevertedError, any other node error stays unavailable. */
  async estimateGas(from: string, to: string, data: string): Promise<bigint> {
    let answer: unknown;
    try {
      answer = await this.rpc('eth_estimateGas', [{ from, to, data }]);
    } catch (error) {
      if (error instanceof RpcCallError && isRevert(error)) throw new CallRevertedError(error.message, error.code);
      throw error;
    }
    return hexToBigInt(answer, 'estimateGas');
  }

  async blockNumber(): Promise<bigint> {
    return hexToBigInt(await this.rpc('eth_blockNumber', []), 'blockNumber');
  }

  /** A block's timestamp in unix seconds, refused when the node does not know the block. */
  async blockTimestamp(block: bigint): Promise<bigint> {
    const answer = (await this.rpc('eth_getBlockByNumber', [`0x${block.toString(16)}`, false])) as { timestamp?: unknown } | null;
    if (answer === null) throw new ChainUnavailableError(`rpc getBlockByNumber: block ${block.toString()} unknown`);
    return hexToBigInt(answer.timestamp, 'block timestamp');
  }

  /** Logs in an inclusive block range, `topics` matched by position, an inner array an OR, every contract's without `address`. */
  async logs(filter: { address?: string | readonly string[]; topics: (string | string[] | null)[]; fromBlock: bigint; toBlock: bigint }): Promise<RawLog[]> {
    const answer = await this.rpc('eth_getLogs', [
      {
        address: filter.address,
        topics: filter.topics,
        fromBlock: `0x${filter.fromBlock.toString(16)}`,
        toBlock: `0x${filter.toBlock.toString(16)}`,
      },
    ]);
    if (!Array.isArray(answer)) throw new ChainUnavailableError(`rpc getLogs: expected a list, got ${JSON.stringify(answer)}`);
    return answer.map((raw: unknown) => {
      const log = raw as { address?: unknown; topics?: unknown; data?: unknown; transactionHash?: unknown; logIndex?: unknown };
      const topics = Array.isArray(log.topics) ? log.topics.map((t: unknown) => asHexString(t, 'getLogs topic')) : [];
      return {
        address: asHexString(log.address, 'getLogs address').toLowerCase(),
        topics,
        data: asHexString(log.data, 'getLogs data'),
        txHash: asHexString(log.transactionHash, 'getLogs transactionHash').toLowerCase(),
        logIndex: Number(hexToBigInt(log.logIndex, 'getLogs logIndex')),
      };
    });
  }

  /** The block of the first log one contract emitted in an inclusive range, undefined when it emitted none. */
  async firstLogBlock(address: string, fromBlock: bigint, toBlock: bigint): Promise<bigint | undefined> {
    // One address, since the public Arbitrum RPCs allow it a far longer range than several
    const answer = await this.rpc('eth_getLogs', [{ address, topics: [], fromBlock: `0x${fromBlock.toString(16)}`, toBlock: `0x${toBlock.toString(16)}` }]);
    if (!Array.isArray(answer)) throw new ChainUnavailableError(`rpc getLogs: expected a list, got ${JSON.stringify(answer)}`);
    let first: bigint | undefined;
    for (const raw of answer) {
      const block = hexToBigInt((raw as { blockNumber?: unknown }).blockNumber, 'getLogs blockNumber');
      if (first === undefined || block < first) first = block;
    }
    return first;
  }

  /** The base fee doubled for headroom plus the tip, refused beyond the sane ceiling. */
  async fees(): Promise<Fees> {
    const [block, tipHex] = await Promise.all([
      this.rpc('eth_getBlockByNumber', ['latest', false]) as Promise<{ baseFeePerGas?: string } | null>,
      this.rpc('eth_maxPriorityFeePerGas', []),
    ]);
    // Arbitrum always charges a base fee, so a block without one is a node failure, never free gas
    if (block?.baseFeePerGas === undefined) throw new ChainUnavailableError('rpc getBlockByNumber: latest block unknown or without a baseFeePerGas');
    const baseFee = hexToBigInt(block.baseFeePerGas, 'baseFeePerGas');
    const tip = hexToBigInt(tipHex, 'maxPriorityFeePerGas');
    const maxFeePerGas = baseFee * 2n + tip;
    if (maxFeePerGas > MAX_SANE_FEE_WEI) {
      throw new ChainUnavailableError(`rpc gas price beyond the sane ceiling: baseFee ${baseFee.toString()}, tip ${tip.toString()}`);
    }
    return { maxFeePerGas, maxPriorityFeePerGas: tip };
  }

  /** Broadcast a signed transaction, returning the hash the node reports. */
  async sendRaw(raw: string): Promise<string> {
    return asHexString(await this.rpc('eth_sendRawTransaction', [raw]), 'sendRawTransaction');
  }

  private async call(to: string, data: string): Promise<string> {
    return asHexString(await this.rpc('eth_call', [{ to, data }, 'latest']), 'eth_call');
  }

  private async address(to: string, signature: string): Promise<string> {
    return this.decoded(await this.call(to, encodeCall(signature)), decodeAddress, signature);
  }

  private async uint(to: string, signature: string): Promise<bigint> {
    return this.decoded(await this.call(to, encodeCall(signature)), decodeUint, signature);
  }

  // A decode failure is a malformed reply, so it surfaces as an unavailable chain
  private decoded<T>(hex: string, decode: (hex: string) => T, what: string): T {
    try {
      return decode(hex);
    } catch (error) {
      throw new ChainUnavailableError(`rpc ${what}: ${toMessage(error)}`);
    }
  }
}
