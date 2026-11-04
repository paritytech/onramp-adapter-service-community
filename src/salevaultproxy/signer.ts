// The keeper's EIP-1559 signer. The key is a thunk, read only to derive the address and to sign.

import { hexToU8a } from '@polkadot/util';

import type { Fees } from './chain.js';
import { addressFromKey, signTransaction, type SignedTx } from './evm.js';

/** One keeper transaction to sign. Value is always zero, the keeper only pays gas. */
export interface KeeperTx {
  readonly to: string;
  readonly data: string;
  readonly nonce: bigint;
  readonly gasLimit: bigint;
  readonly fees: Fees;
  readonly chainId: bigint;
}

export class KeeperSigner {
  /** The checksummed keeper address. */
  readonly address: string;

  constructor(private readonly key: () => Uint8Array) {
    this.address = addressFromKey(key());
  }

  sign(tx: KeeperTx): SignedTx {
    return signTransaction(
      {
        chainId: tx.chainId,
        nonce: tx.nonce,
        maxPriorityFeePerGas: tx.fees.maxPriorityFeePerGas,
        maxFeePerGas: tx.fees.maxFeePerGas,
        gasLimit: tx.gasLimit,
        to: tx.to,
        value: 0n,
        data: tx.data,
      },
      this.key(),
    );
  }
}

/** A 32-byte secp256k1 key from hex, with or without 0x. The value is never echoed. */
export function parseKeeperKey(hex: string): Uint8Array {
  const clean = hex.trim().replace(/^0x/, '');
  if (!/^[0-9a-fA-F]{64}$/.test(clean)) throw new Error('sale_vault_proxy.keeper_key must be a 32-byte hex private key.');
  return hexToU8a(`0x${clean}`);
}
