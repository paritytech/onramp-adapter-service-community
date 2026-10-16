// EIP-1559 signing for the SaleVault operator on @polkadot/util-crypto (secp256k1 + keccak), no EVM library. RLP kept local, verified byte-for-byte in evm.test.ts.

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

function stripHex(hex: string): string {
  return hex.startsWith('0x') ? hex.slice(2) : hex;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = stripHex(hex);
  if (clean.length % 2 !== 0) throw new Error(`odd-length hex: ${hex}`);
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}

// A non-negative integer as its minimal big-endian bytes. Zero is the empty string, as RLP wants.
function toMinimalBytes(value: bigint): Uint8Array {
  if (value < 0n) throw new Error('negative value');
  if (value === 0n) return new Uint8Array(0);
  let hex = value.toString(16);
  if (hex.length % 2 !== 0) hex = `0${hex}`;
  return hexToBytes(hex);
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

// RLP length prefix: `offset + len` for short, `offset + 55 + len-of-len` then the length for long.
function encodeLength(len: number, offset: number): Uint8Array {
  if (len < 56) return Uint8Array.of(offset + len);
  const lenBytes = toMinimalBytes(BigInt(len));
  return concatBytes([Uint8Array.of(offset + 55 + lenBytes.length), lenBytes]);
}

type RlpItem = Uint8Array | RlpItem[];

/** Minimal RLP encoder for byte strings and lists, which is all a transaction needs. */
export function rlpEncode(item: RlpItem): Uint8Array {
  if (Array.isArray(item)) {
    const payload = concatBytes(item.map(rlpEncode));
    return concatBytes([encodeLength(payload.length, 0xc0), payload]);
  }
  if (item.length === 1 && item[0] !== undefined && item[0] < 0x80) return item;
  return concatBytes([encodeLength(item.length, 0x80), item]);
}

/** keccak-256 of some bytes, as 0x-hex. */
export function keccak256(bytes: Uint8Array): string {
  return `0x${bytesToHex(keccakAsU8a(bytes, 256))}`;
}

// The nine fields that are the same signed or unsigned. The access list is always empty here.
function txFields(tx: Eip1559Tx): RlpItem[] {
  return [
    toMinimalBytes(tx.chainId),
    toMinimalBytes(tx.nonce),
    toMinimalBytes(tx.maxPriorityFeePerGas),
    toMinimalBytes(tx.maxFeePerGas),
    toMinimalBytes(tx.gasLimit),
    hexToBytes(tx.to),
    toMinimalBytes(tx.value),
    hexToBytes(tx.data),
    [],
  ];
}

/** Signs an EIP-1559 transaction with a 32-byte secp256k1 private key. */
export function signTransaction(tx: Eip1559Tx, privateKey: Uint8Array): SignedTx {
  if (privateKey.length !== 32) throw new Error('private key must be 32 bytes');
  const preimage = concatBytes([Uint8Array.of(TX_TYPE), rlpEncode(txFields(tx))]);
  // secp256k1Sign with "keccak" hashes the preimage then signs, returning r || s || recovery(0|1).
  const sig = secp256k1Sign(preimage, { secretKey: privateKey }, 'keccak');
  // secp256k1Sign returns r || s || recovery, 65 bytes.
  const r = sig.slice(0, 32);
  const s = sig.slice(32, 64);
  // secp256k1Sign always returns 65 bytes, so the fallback only keeps the index access total without an assertion.
  const yParity = sig[64] ?? 0;
  const signed = concatBytes([
    Uint8Array.of(TX_TYPE),
    rlpEncode([
      ...txFields(tx),
      toMinimalBytes(BigInt(yParity)),
      toMinimalBytes(BigInt(`0x${bytesToHex(r)}`)),
      toMinimalBytes(BigInt(`0x${bytesToHex(s)}`)),
    ]),
  ]);
  return { raw: `0x${bytesToHex(signed)}`, hash: keccak256(signed) };
}

/** The checksummed EVM address for a private key, via the Polkadot secp256k1 helpers. */
export function addressFromKey(privateKey: Uint8Array): string {
  if (privateKey.length !== 32) throw new Error('private key must be 32 bytes');
  return ethereumEncode(secp256k1PairFromSeed(privateKey).publicKey);
}
