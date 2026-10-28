// EIP-1559 signing for the sale vault proxy keeper on @polkadot/util-crypto, no EVM library. RLP verified byte for byte in evm.test.ts.

import { hexToU8a, isHex, u8aConcatStrict, u8aToBigInt, u8aToHex } from '@polkadot/util';
import { ethereumEncode, keccakAsU8a, secp256k1PairFromSeed, secp256k1Sign } from '@polkadot/util-crypto';

/** A type-0x02 (EIP-1559) transaction, amounts as bigint and `to`/`data` as 0x-hex. */
export interface Eip1559Tx {
  readonly chainId: bigint;
  readonly nonce: bigint;
  readonly maxPriorityFeePerGas: bigint;
  readonly maxFeePerGas: bigint;
  readonly gasLimit: bigint;
  readonly to: string;
  readonly value: bigint;
  readonly data: string;
}

/** A signed transaction: the raw bytes to broadcast and the hash it will be mined under. */
export interface SignedTx {
  readonly raw: string;
  readonly hash: string;
}

const TX_TYPE = 0x02;

// 0x-hex as bytes, refusing anything that is not hex
function hexBytes(value: string, what: string): Uint8Array {
  if (!isHex(value)) throw new Error(`${what} is not hex: ${value}`);
  return hexToU8a(value);
}

// A non-negative integer as its minimal big-endian bytes. Zero is the empty string, as RLP wants.
function toMinimalBytes(value: bigint): Uint8Array {
  if (value < 0n) throw new Error('negative value');
  if (value === 0n) return new Uint8Array(0);
  let hex = value.toString(16);
  if (hex.length % 2 !== 0) hex = `0${hex}`;
  return hexToU8a(`0x${hex}`);
}

// RLP length prefix: `offset + len` for short, `offset + 55 + len-of-len` then the length for long.
function encodeLength(len: number, offset: number): Uint8Array {
  if (len < 56) return Uint8Array.of(offset + len);
  const lenBytes = toMinimalBytes(BigInt(len));
  return u8aConcatStrict([Uint8Array.of(offset + 55 + lenBytes.length), lenBytes]);
}

type RlpItem = Uint8Array | RlpItem[];

/** Minimal RLP encoder for byte strings and lists, which is all a transaction needs. */
export function rlpEncode(item: RlpItem): Uint8Array {
  if (Array.isArray(item)) {
    const payload = u8aConcatStrict(item.map(rlpEncode));
    return u8aConcatStrict([encodeLength(payload.length, 0xc0), payload]);
  }
  if (item.length === 1 && item[0] !== undefined && item[0] < 0x80) return item;
  return u8aConcatStrict([encodeLength(item.length, 0x80), item]);
}

/** keccak-256 of some bytes, as 0x-hex. */
export function keccak256(bytes: Uint8Array): string {
  return u8aToHex(keccakAsU8a(bytes, 256));
}

// The nine fields that are the same signed or unsigned. The access list is always empty here.
function txFields(tx: Eip1559Tx): RlpItem[] {
  return [
    toMinimalBytes(tx.chainId),
    toMinimalBytes(tx.nonce),
    toMinimalBytes(tx.maxPriorityFeePerGas),
    toMinimalBytes(tx.maxFeePerGas),
    toMinimalBytes(tx.gasLimit),
    hexBytes(tx.to, 'to'),
    toMinimalBytes(tx.value),
    hexBytes(tx.data, 'data'),
    [],
  ];
}

/** Signs an EIP-1559 transaction with a 32-byte secp256k1 private key. */
export function signTransaction(tx: Eip1559Tx, privateKey: Uint8Array): SignedTx {
  if (privateKey.length !== 32) throw new Error('private key must be 32 bytes');
  const preimage = u8aConcatStrict([Uint8Array.of(TX_TYPE), rlpEncode(txFields(tx))]);
  // secp256k1Sign with "keccak" hashes the preimage then signs, returning r || s || recovery(0|1).
  const sig = secp256k1Sign(preimage, { secretKey: privateKey }, 'keccak');
  const r = sig.slice(0, 32);
  const s = sig.slice(32, 64);
  // secp256k1Sign always returns 65 bytes, so the fallback only keeps the index access total without an assertion.
  const yParity = sig[64] ?? 0;
  const signed = u8aConcatStrict([
    Uint8Array.of(TX_TYPE),
    rlpEncode([
      ...txFields(tx),
      toMinimalBytes(BigInt(yParity)),
      toMinimalBytes(u8aToBigInt(r, { isLe: false })),
      toMinimalBytes(u8aToBigInt(s, { isLe: false })),
    ]),
  ]);
  return { raw: u8aToHex(signed), hash: keccak256(signed) };
}

/** The checksummed EVM address for a private key, via the Polkadot secp256k1 helpers. */
export function addressFromKey(privateKey: Uint8Array): string {
  if (privateKey.length !== 32) throw new Error('private key must be 32 bytes');
  return ethereumEncode(secp256k1PairFromSeed(privateKey).publicKey);
}
