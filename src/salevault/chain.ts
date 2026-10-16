// The SaleVault EVM client: JSON-RPC reads over fetch, and operator-signed EIP-1559 writes. Modelled
// on the Meld client (fetch + typed failure), with the signing and the ABI kept local so no EVM
// library is pulled in. The operator key is held as a thunk, read only to derive the address and to sign.

import {
  decodeSale,
  decodeUint,
  encodeGetter,
  encodeResolveUnknown,
  encodeReturnHeld,
  encodeReturnRefund,
  encodeSales,
  encodeWithdrawDust,
  type SaleRead,
} from './abi.js';
import { addressFromKey, signTransaction, type Eip1559Tx } from './evm.js';

/** A raw JSON-RPC transport, so tests can inject a fake instead of fetch. */
export type RpcTransport = (method: string, params: unknown[]) => Promise<unknown>;

/** Everything the client needs that is not a secret. */
export interface SaleVaultChainConfig {
  readonly rpcUrl: string;
  readonly chainId: bigint;
  readonly contract: string;
}

/** Thrown when the chain is unreachable or answers an error, so callers can degrade rather than crash. */
export class ChainUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChainUnavailableError';
  }
}

const RPC_TIMEOUT_MS = 15_000;

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
        signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
      });
    } catch (error) {
      throw new ChainUnavailableError(`rpc ${method} transport failed: ${toMessage(error)}`);
    }
    if (!response.ok) throw new ChainUnavailableError(`rpc ${method} returned ${String(response.status)}`);
    const body = (await response.json()) as { result?: unknown; error?: { message?: string } };
    if (body.error) throw new ChainUnavailableError(`rpc ${method} error: ${body.error.message ?? 'unknown'}`);
    return body.result;
  };
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asHexString(value: unknown, what: string): string {
  if (typeof value !== 'string' || !value.startsWith('0x')) {
    throw new ChainUnavailableError(`rpc ${what}: expected hex, got ${JSON.stringify(value)}`);
  }
  return value;
}

// A hex quantity to a bigint, rejecting "0x" and non-hex so a malformed RPC reply is a typed
// ChainUnavailableError (mapped to 502/503) rather than a raw `BigInt('0x')` throw behind a 500.
function hexToBigInt(value: unknown, what: string): bigint {
  const hex = asHexString(value, what);
  if (!/^0x[0-9a-fA-F]+$/.test(hex)) {
    throw new ChainUnavailableError(`rpc ${what}: not a hex quantity, got ${JSON.stringify(value)}`);
  }
  return BigInt(hex);
}

// A sanity ceiling on the gas price the operator will sign for: a real Arbitrum fee is orders of
// magnitude below this, so a larger one is a misbehaving or hostile RPC, not a fee to pay.
const MAX_SANE_FEE_WEI = 1_000_000_000_000n; // 1000 gwei

/** One SaleVault on one chain, read and written by the operator. */
export class SaleVaultClient {
  readonly operatorAddress: string;
  /** The vault address this client talks to, exposed so callers can record which contract answered. */
  readonly contractAddress: string;

  private constructor(
    private readonly cfg: SaleVaultChainConfig,
    private readonly rpc: RpcTransport,
    private readonly exposeKey: () => Uint8Array,
  ) {
    this.operatorAddress = addressFromKey(exposeKey());
    this.contractAddress = cfg.contract;
  }

  /** Builds a client; `operatorKey` is a thunk so the key is read only here and at signing. */
  static create(cfg: SaleVaultChainConfig, operatorKey: () => Uint8Array, rpc?: RpcTransport): SaleVaultClient {
    return new SaleVaultClient(cfg, rpc ?? fetchTransport(cfg.rpcUrl), operatorKey);
  }

  private async ethCall(data: string): Promise<string> {
    return asHexString(await this.rpc('eth_call', [{ to: this.cfg.contract, data }, 'latest']), 'eth_call');
  }

  /** The on-chain sale for a reference, decoded. Status 0 means the vault has not seen it yet. */
  async sale(ref: string): Promise<SaleRead> {
    return decodeSale(await this.ethCall(encodeSales(ref)));
  }

  /** The counted dust available for gas. */
  async dust(): Promise<bigint> {
    return decodeUint(await this.ethCall(encodeGetter('dust()')));
  }

  /** USDC in the contract that is not in any bucket. */
  async unclaimed(): Promise<bigint> {
    return decodeUint(await this.ethCall(encodeGetter('unclaimed()')));
  }

  /** Send a refund of a paid sale back to the seller's home. Returns the transaction hash. */
  async returnRefund(ref: string, amount: bigint, cfParameters: string): Promise<string> {
    return this.send(encodeReturnRefund(ref, amount, cfParameters));
  }

  /** Push a held amount back to its sale's home. Returns the transaction hash. */
  async returnHeld(ref: string, cfParameters: string): Promise<string> {
    return this.send(encodeReturnHeld(ref, cfParameters));
  }

  /** Send a stuck delivery to a home the operator confirmed. Returns the transaction hash. */
  async resolveUnknown(home: string, amount: bigint, cfParameters: string): Promise<string> {
    return this.send(encodeResolveUnknown(home, amount, cfParameters));
  }

  /** Move counted dust to the operator wallet for gas. Returns the transaction hash. */
  async withdrawDust(amount: bigint): Promise<string> {
    return this.send(encodeWithdrawDust(amount));
  }

  /** The receipt of a broadcast transaction, or null when it is not yet mined (or was dropped). */
  async receipt(txHash: string): Promise<{ status: boolean } | null> {
    const r = (await this.rpc('eth_getTransactionReceipt', [txHash])) as { status?: string } | null;
    if (r === null) return null;
    return { status: r.status === '0x1' };
  }

  // Build, sign and broadcast an EIP-1559 call to the contract.
  private async send(data: string): Promise<string> {
    const [nonceHex, baseFee, tipHex] = await Promise.all([
      this.rpc('eth_getTransactionCount', [this.operatorAddress, 'pending']),
      this.baseFee(),
      this.rpc('eth_maxPriorityFeePerGas', []),
    ]);
    const tip = hexToBigInt(tipHex, 'maxPriorityFeePerGas');
    // Refuse to sign against a gas price the RPC reports beyond any real fee: a hostile or broken
    // RPC returning a huge base fee or tip would otherwise drain the operator's gas on one send.
    if (baseFee > MAX_SANE_FEE_WEI || tip > MAX_SANE_FEE_WEI) {
      throw new ChainUnavailableError(
        `rpc gas price beyond the sane ceiling: baseFee ${baseFee.toString()}, tip ${tip.toString()}`,
      );
    }
    const tx: Eip1559Tx = {
      chainId: this.cfg.chainId,
      nonce: hexToBigInt(nonceHex, 'getTransactionCount'),
      maxPriorityFeePerGas: tip,
      maxFeePerGas: baseFee * 2n + tip, // headroom for the base fee moving between now and inclusion
      gasLimit: await this.estimateGas(data),
      to: this.cfg.contract,
      value: 0n,
      data,
    };
    const signed = signTransaction(tx, this.exposeKey());
    await this.rpc('eth_sendRawTransaction', [signed.raw]);
    return signed.hash;
  }

  private async baseFee(): Promise<bigint> {
    const block = (await this.rpc('eth_getBlockByNumber', ['latest', false])) as { baseFeePerGas?: string } | null;
    return block?.baseFeePerGas === undefined ? 0n : hexToBigInt(block.baseFeePerGas, 'baseFeePerGas');
  }

  private async estimateGas(data: string): Promise<bigint> {
    const estimate = await this.rpc('eth_estimateGas', [
      { from: this.operatorAddress, to: this.cfg.contract, data },
    ]);
    // A 20% cushion over the estimate, so a slightly heavier path still fits.
    return (hexToBigInt(estimate, 'estimateGas') * 12n) / 10n;
  }
}
