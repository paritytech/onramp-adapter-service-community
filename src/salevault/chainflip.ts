// The cf_parameters a SaleVault return swap carries, encoded by Chainflip's swap backend as its SDK does.

import { ChainUnavailableError, fetchTransport, type RpcTransport } from './chain.js';

/** Everything the encoder needs, none of it secret. */
export interface ReturnSwapConfig {
  /** The State Chain RPC that reports the swap limits. */
  readonly rpcUrl: string;
  /** The Chainflip swap backend that quotes the return and encodes it with its own broker. */
  readonly backendUrl: string;
  /** How far below the quoted price the return may fill, in basis points. */
  readonly slippageBps: number;
  /** How many State Chain blocks Chainflip retries before refunding to the vault. */
  readonly retryBlocks: number;
}

/** Thrown when Chainflip would not swap this amount: below its minimum deposit or above its maximum swap. */
export class ReturnNotSwappableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReturnNotSwappableError';
  }
}

// The return leg is fixed by the contract: Arbitrum USDC in, Asset Hub USDT out, both six decimals.
const SOURCE = { chain: 'Arbitrum', asset: 'USDC' } as const;
const DESTINATION = { chain: 'Assethub', asset: 'USDT' } as const;
const SOURCE_DECIMALS = 6;
const DESTINATION_DECIMALS = 6;

const BACKEND_TIMEOUT_MS = 15_000;

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// A hex quantity or null off an RPC map, rejecting anything else as a malformed reply.
function optionalHex(value: unknown, what: string): bigint | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new ChainUnavailableError(`rpc ${what}: not a hex quantity, got ${JSON.stringify(value)}`);
  }
  return BigInt(value);
}

// One asset's entry in a State Chain per-chain asset map, e.g. maximum_swap_amounts.Arbitrum.USDC.
function assetEntry(result: unknown, field: string): unknown {
  const map = (result as Record<string, unknown> | null)?.[field] as Record<string, Record<string, unknown>> | undefined;
  const chain = map?.[SOURCE.chain];
  if (chain === undefined || !(SOURCE.asset in chain)) {
    throw new ChainUnavailableError(`rpc ${field}: no ${SOURCE.chain} ${SOURCE.asset} entry`);
  }
  return chain[SOURCE.asset];
}

/** The quoted price less the tolerance as Chainflip's X128 fixed point, rounded as the Chainflip SDK does. */
export function minPriceX128(estimatedPrice: string, slippageBps: number, srcDecimals: number, destDecimals: number): bigint {
  if (!/^\d+(\.\d+)?$/.test(estimatedPrice)) throw new ChainUnavailableError(`quote price is not a decimal: ${estimatedPrice}`);
  const [whole, fraction = ''] = estimatedPrice.split('.');
  const scale = 10n ** BigInt(fraction.length);
  const price = BigInt(`${whole ?? '0'}${fraction}`);
  const divHalfUp = (n: bigint, d: bigint): bigint => (2n * n + d) / (2n * d);
  const atDest = divHalfUp(price * (10_000n - BigInt(slippageBps)) * 10n ** BigInt(destDecimals), scale * 10_000n);
  const shift = BigInt(destDecimals - srcDecimals);
  const numerator = atDest * (1n << 128n) * (shift >= 0n ? 10n ** shift : 1n);
  const denominator = 10n ** BigInt(destDecimals) * (shift < 0n ? 10n ** -shift : 1n);
  return divHalfUp(numerator, denominator);
}

/** Prices and encodes the cf_parameters for one SaleVault return swap. */
export class ReturnSwapEncoder {
  private constructor(
    private readonly cfg: ReturnSwapConfig,
    private readonly rpc: RpcTransport,
    private readonly fetchImpl: typeof fetch,
  ) {}

  /** Builds an encoder, with the transport and fetch injectable for tests. */
  static create(cfg: ReturnSwapConfig, rpc?: RpcTransport, fetchImpl?: typeof fetch): ReturnSwapEncoder {
    return new ReturnSwapEncoder(cfg, rpc ?? fetchTransport(cfg.rpcUrl), fetchImpl ?? fetch);
  }

  /** The cf_parameters to return `amount` USDC to `home`, refunding to `refundAddress` if unfilled. */
  async returnParameters(args: { amount: bigint; home: string; refundAddress: string }): Promise<string> {
    await this.checkSwappable(args.amount);
    const price = await this.quotedPrice(args.amount);
    const minPrice = minPriceX128(price, this.cfg.slippageBps, SOURCE_DECIMALS, DESTINATION_DECIMALS);
    // The SDK's own request when no broker is set, so the backend names its default broker.
    const encoded = await this.backend('/api/encodeCfParameters', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        srcAsset: SOURCE,
        destAsset: DESTINATION,
        srcAddress: args.refundAddress,
        destAddress: args.home,
        amount: args.amount.toString(),
        commissionBps: 0,
        fillOrKillParams: {
          retryDurationBlocks: this.cfg.retryBlocks,
          refundAddress: args.refundAddress,
          minPriceX128: minPrice.toString(),
          maxOraclePriceSlippage: null,
          refundCcmMetadata: null,
        },
      }),
    }, 'chainflip encode');
    return checkedParameters(encoded, this.cfg.retryBlocks, args.refundAddress);
  }

  // Below the minimum deposit Chainflip ignores the swap, above the maximum it confiscates the excess.
  private async checkSwappable(amount: bigint): Promise<void> {
    const [ingress, swapping] = await Promise.all([
      this.rpc('cf_ingress_egress_environment', []),
      this.rpc('cf_swapping_environment', []),
    ]);
    const minimum = optionalHex(assetEntry(ingress, 'minimum_deposit_amounts'), 'minimum_deposit_amounts') ?? 0n;
    const maximum = optionalHex(assetEntry(swapping, 'maximum_swap_amounts'), 'maximum_swap_amounts');
    if (amount < minimum) {
      throw new ReturnNotSwappableError(`return of ${amount.toString()} is below Chainflip's minimum deposit ${minimum.toString()}`);
    }
    if (maximum !== null && amount > maximum) {
      throw new ReturnNotSwappableError(`return of ${amount.toString()} is above Chainflip's maximum swap ${maximum.toString()}`);
    }
  }

  // The regular quote's estimated price for this amount, from the swap backend.
  private async quotedPrice(amount: bigint): Promise<string> {
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
      ? (body as { type?: unknown; estimatedPrice?: unknown }[]).find((q) => q.type === 'REGULAR')
      : undefined;
    if (typeof regular?.estimatedPrice !== 'string') {
      throw new ChainUnavailableError('chainflip quote has no regular quote with an estimated price');
    }
    return regular.estimatedPrice;
  }

  // One JSON call to the swap backend, a transport failure or refusal surfacing as an unavailable chain.
  private async backend(path: string, init: RequestInit, what: string): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.cfg.backendUrl.replace(/\/$/, '')}${path}`, {
        ...init,
        redirect: 'error',
        signal: AbortSignal.timeout(BACKEND_TIMEOUT_MS),
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

// The encoded bytes must be a V1 envelope carrying our retry duration and refund address up front.
function checkedParameters(encoded: unknown, retryBlocks: number, refundAddress: string): string {
  if (typeof encoded !== 'string' || !/^0x[0-9a-fA-F]+$/.test(encoded)) {
    throw new ChainUnavailableError(`chainflip encode: expected hex, got ${JSON.stringify(encoded)}`);
  }
  const hex = encoded.slice(2).toLowerCase();
  const retry = Buffer.alloc(4);
  retry.writeUInt32LE(retryBlocks);
  const head = `01${retry.toString('hex')}${refundAddress.slice(2).toLowerCase()}`;
  if (!hex.startsWith(head)) {
    throw new ChainUnavailableError('chainflip encode: the encoding does not carry the requested refund terms');
  }
  return encoded;
}
