// Chainflip's live limits, quote and vault-swap encoding for a proxy return, so nothing about the route is taken on trust.

import { u8aToHex } from '@polkadot/util';
import { encodeAddress } from '@polkadot/util-crypto';

import { EVM_ADDRESS, selector } from './abi.js';
import { ChainUnavailableError, fetchTransport, toMessage, UPSTREAM_TIMEOUT_MS, type RpcTransport } from './chain.js';

/** Why Chainflip would not take a return: an amount it ignores or confiscates, or a route it refunds. */
export type ReturnRefusal = 'not-swappable' | 'route-refused';

/** Thrown when Chainflip would ignore, confiscate or refund a return. */
export class ReturnNotSwappableError extends Error {
  constructor(
    message: string,
    readonly reason: ReturnRefusal = 'not-swappable',
  ) {
    super(message);
    this.name = 'ReturnNotSwappableError';
  }
}

/** Chainflip's live limits on one return. */
export interface SwapBounds {
  readonly floor: bigint;
  /** Null when Chainflip sets no maximum. */
  readonly maximum: bigint | null;
  /** The longest refund retry window Chainflip accepts, in State Chain blocks. */
  readonly maxRetryBlocks: number;
}

/** The proxy's route terms Chainflip must still accept, as verified on chain. */
export interface RouteTerms {
  readonly retryBlocks: number;
  /** The broker account id, 32 bytes hex. */
  readonly broker: string;
}

/** The proxy's price terms, as verified on chain. */
export interface PriceTerms {
  readonly priceFloorBps: bigint;
  readonly feeAllowance: bigint;
}

// The return leg is fixed by the contract: Arbitrum USDC in, Asset Hub USDT out
const SOURCE = { chain: 'Arbitrum', asset: 'USDC' } as const;
const DESTINATION = { chain: 'Assethub', asset: 'USDT' } as const;
// The vault swap a return makes
const X_SWAP_TOKEN = u8aToHex(selector('xSwapToken(uint32,bytes,uint32,address,uint256,bytes)')).slice(2);
// V1 cf_parameters with every option None: version, retry, refund, min price, four None flags, broker, bps, no affiliates
const CF_PARAMETERS_BYTES = 96;
const CF_BROKER_OFFSET = 61;

// A hex quantity or null off an RPC map, refusing anything else
function optionalHex(value: unknown, what: string): bigint | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new ChainUnavailableError(`rpc ${what}: not a hex quantity, got ${JSON.stringify(value)}`);
  }
  return BigInt(value);
}

// A hex quantity off an RPC map that must be present
function requiredHex(value: unknown, what: string): bigint {
  const out = optionalHex(value, what);
  if (out === null) throw new ChainUnavailableError(`rpc ${what}: missing`);
  return out;
}

// One asset's entry in a State Chain per-chain asset map
function assetEntry(result: unknown, field: string): unknown {
  const map = (result as Record<string, unknown> | null)?.[field] as Record<string, Record<string, unknown>> | undefined;
  const chain = map?.[SOURCE.chain];
  if (chain === undefined || !(SOURCE.asset in chain)) {
    throw new ChainUnavailableError(`rpc ${field}: no ${SOURCE.chain} ${SOURCE.asset} entry`);
  }
  return chain[SOURCE.asset];
}

// A non-negative JSON integer off an RPC answer
function count(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new ChainUnavailableError(`rpc ${what}: not a count, got ${JSON.stringify(value)}`);
  }
  return value;
}

// The regular network fee's absolute minimum, in USDC units
function networkFeeMinimum(swapping: unknown): bigint {
  const fees = (swapping as { network_fees?: { regular_network_fee?: { standard_rate_and_minimum?: { minimum?: unknown } } } } | null)
    ?.network_fees?.regular_network_fee?.standard_rate_and_minimum?.minimum;
  return BigInt(count(fees, 'network_fees regular network fee minimum'));
}

/** The amount one `returnHome` sends, the TS mirror of the Solidity chunking: the rest is 0 or at least `minReturn`. */
export function returnChunk(balance: bigint, limits: { minReturn: bigint; maxReturn: bigint }): bigint {
  if (balance <= limits.maxReturn) return balance;
  const rest = balance - limits.minReturn;
  return rest < limits.maxReturn ? rest : limits.maxReturn;
}

/** The least output the proxy accepts, the TS mirror of the Solidity floor. */
export function proxyMinOut(amount: bigint, terms: PriceTerms): bigint {
  return (amount * terms.priceFloorBps) / 10_000n - terms.feeAllowance;
}

/** What Chainflip's own vault-swap encoder builds a return from, lowercase. */
export interface ReturnRoute {
  readonly vault: string;
  readonly usdc: string;
  readonly homeChain: bigint;
  readonly homeToken: bigint;
  readonly broker: string;
}

// The 64 hex chars of word `i` of an ABI body
function abiWord(body: string, i: number, what: string): string {
  const out = body.slice(i * 64, i * 64 + 64);
  if (out.length !== 64) throw new ChainUnavailableError(`${what}: calldata has no word ${String(i)}`);
  return out;
}

// The route out of an xSwapToken calldata and its cf_parameters, refusing any other shape
function routeOf(encoded: unknown): ReturnRoute {
  const what = 'chainflip vault swap encoding';
  const { to, calldata, sourceTokenAddress } = (encoded ?? {}) as { to?: unknown; calldata?: unknown; sourceTokenAddress?: unknown };
  const address = (value: unknown, field: string): string => {
    if (typeof value !== 'string' || !EVM_ADDRESS.test(value)) throw new ChainUnavailableError(`${what}: ${field} is not an address`);
    return value.toLowerCase();
  };
  if (typeof calldata !== 'string' || !/^0x[0-9a-fA-F]*$/.test(calldata) || !calldata.toLowerCase().startsWith(`0x${X_SWAP_TOKEN}`)) {
    throw new ChainUnavailableError(`${what}: not an xSwapToken call`);
  }
  const body = calldata.slice(10).toLowerCase();
  const at = Number(BigInt(`0x${abiWord(body, 5, what)}`)) / 32;
  const length = Number(BigInt(`0x${abiWord(body, at, what)}`));
  const params = body.slice((at + 1) * 64, (at + 1) * 64 + length * 2);
  if (length !== CF_PARAMETERS_BYTES || params.length !== length * 2 || !params.startsWith('01')) {
    throw new ChainUnavailableError(`${what}: cf_parameters are not the ${String(CF_PARAMETERS_BYTES)}-byte V1 layout`);
  }
  return {
    vault: address(to, 'to'),
    usdc: address(sourceTokenAddress, 'sourceTokenAddress'),
    homeChain: BigInt(`0x${abiWord(body, 0, what)}`),
    homeToken: BigInt(`0x${abiWord(body, 2, what)}`),
    broker: `0x${params.slice(CF_BROKER_OFFSET * 2, (CF_BROKER_OFFSET + 32) * 2)}`,
  };
}

/** Live Chainflip limits, quotes and encodings for the return leg. */
export class ReturnLimits {
  // Live reads by key, each kept for `ttlMs` so a pass and the returns route share one read
  private readonly cache = new Map<string, { at: number; value: Promise<unknown> }>();

  private constructor(
    private readonly backendUrl: string,
    private readonly ttlMs: number,
    private readonly rpc: RpcTransport,
    private readonly fetchImpl: typeof fetch,
    private readonly clock: () => number,
  ) {}

  /** Builds a reader, with the transport, fetch and clock injectable for tests. */
  static create(
    cfg: { rpcUrl: string; backendUrl: string; ttlMs: number },
    rpc?: RpcTransport,
    fetchImpl?: typeof fetch,
    clock: () => number = Date.now,
  ): ReturnLimits {
    return new ReturnLimits(cfg.backendUrl, cfg.ttlMs, rpc ?? fetchTransport(cfg.rpcUrl), fetchImpl ?? fetch, clock);
  }

  /** The least a return may carry, the minimum deposit plus two refunds' network and egress fees, the maximum swap or null, and the retry cap. */
  async bounds(): Promise<SwapBounds> {
    return this.cached('bounds', async () => {
      const [ingress, swapping] = await Promise.all([
        this.rpc('cf_ingress_egress_environment', []),
        this.rpc('cf_swapping_environment', []),
      ]);
      const minimum = optionalHex(assetEntry(ingress, 'minimum_deposit_amounts'), 'minimum_deposit_amounts') ?? 0n;
      const maximum = optionalHex(assetEntry(swapping, 'maximum_swap_amounts'), 'maximum_swap_amounts');
      const egress = requiredHex(assetEntry(ingress, 'egress_fees'), 'egress_fees');
      const maxRetryBlocks = count((swapping as { max_swap_retry_duration_blocks?: unknown } | null)?.max_swap_retry_duration_blocks, 'max_swap_retry_duration_blocks');
      return { floor: minimum + 2n * (networkFeeMinimum(swapping) + egress), maximum, maxRetryBlocks };
    });
  }

  /** Whether the State Chain holds this account id as a registered broker. */
  async brokerRegistered(broker: string): Promise<boolean> {
    return this.cached(`broker:${broker}`, async () => {
      const properties = (await this.rpc('system_properties', [])) as { ss58Format?: unknown } | null;
      const account = encodeAddress(broker, count(properties?.ss58Format, 'system_properties ss58Format'));
      const info = (await this.rpc('cf_account_info', [account])) as { role?: unknown } | null;
      if (typeof info?.role !== 'string') throw new ChainUnavailableError(`rpc cf_account_info: no role for ${account}`);
      return info.role === 'broker';
    });
  }

  /** Refuses a return Chainflip would ignore, confiscate or refund under its live limits. */
  async check(amount: bigint, route: RouteTerms): Promise<void> {
    const [{ floor, maximum, maxRetryBlocks }, registered] = await Promise.all([this.bounds(), this.brokerRegistered(route.broker)]);
    if (amount < floor) {
      throw new ReturnNotSwappableError(`return of ${amount.toString()} is below Chainflip's minimum deposit plus refund fees ${floor.toString()}`);
    }
    // Only the excess over the maximum is confiscated, so exactly the maximum swaps
    if (maximum !== null && amount > maximum) {
      throw new ReturnNotSwappableError(`return of ${amount.toString()} is above Chainflip's maximum swap ${maximum.toString()}`);
    }
    if (route.retryBlocks > maxRetryBlocks) {
      throw new ReturnNotSwappableError(`retry window ${String(route.retryBlocks)} blocks is over Chainflip's cap ${String(maxRetryBlocks)}, the return would be refunded`, 'route-refused');
    }
    if (!registered) throw new ReturnNotSwappableError(`broker ${route.broker} is not a registered Chainflip broker, the return would be refunded`, 'route-refused');
  }

  /** The State Chain's name, which tells mainnet from Perseverance. */
  async stateChain(): Promise<string> {
    const name = await this.rpc('system_chain', []);
    if (typeof name !== 'string') throw new ChainUnavailableError(`rpc system_chain: expected a name, got ${JSON.stringify(name)}`);
    return name;
  }

  /** The regular vault-swap quote's egress amount for this input. */
  async quotedOutput(amount: bigint): Promise<bigint> {
    const params = new URLSearchParams({
      amount: amount.toString(),
      srcChain: SOURCE.chain,
      srcAsset: SOURCE.asset,
      destChain: DESTINATION.chain,
      destAsset: DESTINATION.asset,
      isVaultSwap: 'true',
    });
    const body = await this.backend(`/v2/quote?${params.toString()}`, {}, 'chainflip quote');
    const regular = Array.isArray(body)
      ? (body as { type?: unknown; egressAmount?: unknown }[]).find((q) => q.type === 'REGULAR')
      : undefined;
    if (typeof regular?.egressAmount !== 'string' || !/^\d+$/.test(regular.egressAmount)) {
      throw new ChainUnavailableError('chainflip quote has no regular quote with an egress amount');
    }
    return BigInt(regular.egressAmount);
  }

  /** The Arbitrum Vault the State Chain names, lowercase. */
  async arbitrumVault(): Promise<string> {
    const result = (await this.rpc('cf_get_vault_addresses', [])) as { arbitrum?: { Arb?: unknown } } | null;
    const bytes = result?.arbitrum?.Arb;
    if (!Array.isArray(bytes) || bytes.length !== 20 || !bytes.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) {
      throw new ChainUnavailableError(`rpc cf_get_vault_addresses: no Arbitrum vault, got ${JSON.stringify(bytes)}`);
    }
    return u8aToHex(Uint8Array.from(bytes as number[]));
  }

  /** The route Chainflip's encoder builds for a return with no broker named, so it fills its default broker. */
  async returnRoute(args: { amount: bigint; refund: string; home: string; retryBlocks: number }): Promise<ReturnRoute> {
    const encoded = await this.backend(
      '/api/encodeVaultSwapData',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          srcAsset: SOURCE,
          destAsset: DESTINATION,
          srcAddress: args.refund,
          destAddress: args.home,
          amount: args.amount.toString(),
          fillOrKillParams: {
            retryDurationBlocks: args.retryBlocks,
            refundAddress: args.refund,
            minPriceX128: '0',
            maxOraclePriceSlippage: null,
            refundCcmMetadata: null,
          },
        }),
      },
      'chainflip vault swap encoding',
    );
    return routeOf(encoded);
  }

  // A live read kept for the TTL, a failed one dropped so the next call reads again
  private cached<T>(key: string, read: () => Promise<T>): Promise<T> {
    const now = this.clock();
    const hit = this.cache.get(key);
    if (hit !== undefined && now - hit.at < this.ttlMs) return hit.value as Promise<T>;
    const entry = { at: now, value: read() };
    this.cache.set(key, entry);
    entry.value.catch(() => {
      if (this.cache.get(key) === entry) this.cache.delete(key);
    });
    return entry.value;
  }

  // One JSON call to the swap backend, any failure surfacing as an unavailable chain
  private async backend(path: string, init: RequestInit, what: string): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.backendUrl.replace(/\/$/, '')}${path}`, {
        ...init,
        redirect: 'error',
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
    } catch (error) {
      throw new ChainUnavailableError(`${what} transport failed: ${toMessage(error)}`);
    }
    if (!response.ok) throw new ChainUnavailableError(`${what} returned ${String(response.status)}`);
    try {
      return await response.json();
    } catch (error) {
      throw new ChainUnavailableError(`${what} answered with a body that is not JSON: ${toMessage(error)}`);
    }
  }
}
