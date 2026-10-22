// A tiny ABI codec for the exact SaleVault calls this service makes. Not a general ABI library: it
// encodes the handful of function calls and decodes their handful of return shapes, which keeps the
// EVM surface small and auditable. The 4-byte selector is keccak of the signature, from the same
// Polkadot keccak the signer uses.

import { keccakAsU8a } from '@polkadot/util-crypto';

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, '');
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

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** The 4-byte selector for a function signature such as `dust()` or `returnRefund(bytes32,uint256,bytes)`. */
export function selector(signature: string): Uint8Array {
  return keccakAsU8a(new TextEncoder().encode(signature), 256).slice(0, 4);
}

// The on-chain sale key: ref = keccak256(fundingRequestId), the id hashed as its UTF-8 bytes. This is
// the canonical derivation the CCM sender and this service must share, so it lives in one place.
export function saleRef(fundingRequestId: string): string {
  return `0x${bytesToHex(keccakAsU8a(new TextEncoder().encode(fundingRequestId), 256))}`;
}

/** A uint256 (or smaller) left-padded into a 32-byte word. */
export function word(value: bigint): Uint8Array {
  if (value < 0n) throw new Error('negative value');
  let hex = value.toString(16);
  if (hex.length > 64) throw new Error('value exceeds 32 bytes');
  hex = hex.padStart(64, '0');
  return hexToBytes(hex);
}

/** A 32-byte value (bytes32 or a right-padded address) into a 32-byte word. */
export function bytes32(hex: string): Uint8Array {
  const raw = hexToBytes(hex);
  if (raw.length > 32) throw new Error('value exceeds 32 bytes');
  const out = new Uint8Array(32);
  out.set(raw, 32 - raw.length); // left-pad, which is right for bytes32 and address alike
  return out;
}

// A dynamic `bytes` argument tail: the length word then the data, padded to a 32-byte boundary.
function dynamicBytes(hex: string): Uint8Array {
  const data = hexToBytes(hex);
  const padded = new Uint8Array(Math.ceil(data.length / 32) * 32);
  padded.set(data);
  return concat([word(BigInt(data.length)), padded]);
}

/** calldata for `returnRefund(bytes32 ref, uint256 amount, bytes cfParameters)`. */
export function encodeReturnRefund(ref: string, amount: bigint, cfParameters: string): string {
  const head = concat([bytes32(ref), word(amount), word(96n)]); // the bytes arg starts at offset 96
  return `0x${bytesToHex(concat([selector('returnRefund(bytes32,uint256,bytes)'), head, dynamicBytes(cfParameters)]))}`;
}

/** calldata for `resolveUnknown(bytes32 home, uint256 amount, bytes cfParameters)`. */
export function encodeResolveUnknown(home: string, amount: bigint, cfParameters: string): string {
  const head = concat([bytes32(home), word(amount), word(96n)]);
  return `0x${bytesToHex(concat([selector('resolveUnknown(bytes32,uint256,bytes)'), head, dynamicBytes(cfParameters)]))}`;
}

/** calldata for `withdrawDust(uint256 amount)`. */
export function encodeWithdrawDust(amount: bigint): string {
  return `0x${bytesToHex(concat([selector('withdrawDust(uint256)'), word(amount)]))}`;
}

/** calldata for `returnHeld(bytes32 ref, bytes cfParameters)`. */
export function encodeReturnHeld(ref: string, cfParameters: string): string {
  const head = concat([bytes32(ref), word(64n)]); // bytes arg starts at offset 64
  return `0x${bytesToHex(concat([selector('returnHeld(bytes32,bytes)'), head, dynamicBytes(cfParameters)]))}`;
}

/** calldata for a no-argument uint256 getter such as `dust()` or `unclaimed()`. */
export function encodeGetter(signature: string): string {
  return `0x${bytesToHex(selector(signature))}`;
}

/** calldata for `sales(bytes32 ref)`. */
export function encodeSales(ref: string): string {
  return `0x${bytesToHex(concat([selector('sales(bytes32)'), bytes32(ref)]))}`;
}

/** The 32-byte topic of an event signature such as `Transfer(address,address,uint256)`. */
export function eventTopic(signature: string): string {
  return `0x${bytesToHex(keccakAsU8a(new TextEncoder().encode(signature), 256))}`;
}

/** An address or bytes32 as an indexed topic, left-padded to 32 bytes. */
export function topicOf(hex: string): string {
  return `0x${bytesToHex(bytes32(hex))}`;
}

/** Decode the address a getter such as `USDC()` returns. */
export function decodeAddress(hex: string): string {
  return `0x${hex.replace(/^0x/, '').slice(24, 64)}`;
}

/** Decode a single uint256 return value (a dust/unclaimed read). */
export function decodeUint(hex: string): bigint {
  const raw = hex.replace(/^0x/, '');
  if (raw.length === 0) return 0n;
  return BigInt(`0x${raw.slice(0, 64)}`);
}

/** The decoded `sales(ref)` tuple: recipient, amount, home, held, status. */
export interface SaleRead {
  readonly recipient: string;
  readonly amount: bigint;
  readonly home: string;
  readonly held: bigint;
  readonly status: number;
}

/** Decode the five words `sales(bytes32)` returns, in the SaleVault Sale struct order. */
export function decodeSale(hex: string): SaleRead {
  const raw = hex.replace(/^0x/, '');
  const at = (i: number): string => raw.slice(i * 64, i * 64 + 64);
  return {
    recipient: `0x${at(0).slice(24)}`,
    amount: BigInt(`0x${at(1)}`),
    home: `0x${at(2)}`,
    held: BigInt(`0x${at(3)}`),
    status: Number(BigInt(`0x${at(4)}`)),
  };
}
