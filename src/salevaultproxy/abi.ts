// A tiny ABI codec for the exact SaleVaultProxy and SaleVaultProxyFactory calls the keeper makes, not a general ABI library.

import { hexToU8a, isHex, u8aConcat, u8aToHex, u8aToString } from '@polkadot/util';
import { keccakAsU8a } from '@polkadot/util-crypto';

/** A 20-byte EVM address as 0x hex, any casing. */
export const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
/** A 32-byte word as 0x hex, any casing. */
export const BYTES32 = /^0x[0-9a-fA-F]{64}$/;

const keccakText = (text: string): Uint8Array => keccakAsU8a(new TextEncoder().encode(text), 256);

/** The 4-byte selector for a function signature such as `returnHome()`. */
export function selector(signature: string): Uint8Array {
  return keccakText(signature).slice(0, 4);
}

/** The 32-byte topic of an event signature. */
export function eventTopic(signature: string): string {
  return u8aToHex(keccakText(signature));
}

/** The on-chain sale ref, keccak256 of the funding request id as UTF-8, shared with the CCM sender. */
export function saleRef(fundingRequestId: string): string {
  return u8aToHex(keccakText(fundingRequestId));
}

/** A uint256 (or smaller) left-padded into a 32-byte word. */
export function word(value: bigint): Uint8Array {
  if (value < 0n) throw new Error('negative value');
  const hex = value.toString(16);
  if (hex.length > 64) throw new Error('value exceeds 32 bytes');
  return hexToU8a(`0x${hex.padStart(64, '0')}`);
}

/** A bytes32 or an address, left-padded into a 32-byte word. */
export function bytes32(hex: string): Uint8Array {
  if (!isHex(hex)) throw new Error(`not hex: ${hex}`);
  const raw = hexToU8a(hex);
  if (raw.length > 32) throw new Error('value exceeds 32 bytes');
  const out = new Uint8Array(32);
  out.set(raw, 32 - raw.length);
  return out;
}

// The value when it matches, or a throw naming it
function checked(value: string, pattern: RegExp, what: string): string {
  if (!pattern.test(value)) throw new Error(`${what} is malformed: ${value}`);
  return value;
}

/** calldata for a no-argument call such as `returnHome()` or `IMPLEMENTATION()`. */
export function encodeCall(signature: string): string {
  return u8aToHex(selector(signature));
}

/** calldata for ERC20 `balanceOf(address)`. */
export function encodeBalanceOf(address: string): string {
  return u8aToHex(u8aConcat(selector('balanceOf(address)'), bytes32(checked(address, EVM_ADDRESS, 'address'))));
}

/** calldata for USDC's EIP-3009 `authorizationState(address,bytes32)`. */
export function encodeAuthorizationState(authorizer: string, nonce: string): string {
  return u8aToHex(
    u8aConcat(selector('authorizationState(address,bytes32)'), bytes32(checked(authorizer, EVM_ADDRESS, 'authorizer')), bytes32(checked(nonce, BYTES32, 'nonce'))),
  );
}

/** One sale's exact terms, the key the factory books it under, the proxy keying it bar home and claimer. */
export interface SaleTerms {
  readonly home: string;
  readonly claimer: string;
  readonly ref: string;
  readonly recipient: string;
  readonly committed: bigint;
}

/** calldata for the proxy's `delivery(bytes32,address,uint256)`. */
export function encodeDelivery(t: Pick<SaleTerms, 'ref' | 'recipient' | 'committed'>): string {
  return u8aToHex(
    u8aConcat(
      selector('delivery(bytes32,address,uint256)'),
      bytes32(checked(t.ref, BYTES32, 'ref')),
      bytes32(checked(t.recipient, EVM_ADDRESS, 'recipient')),
      word(t.committed),
    ),
  );
}

// The 64 hex chars of word `i`, refusing a reply too short to hold it
function wordAt(hex: string, i: number): string {
  const raw = hex.replace(/^0x/, '');
  if (!/^[0-9a-fA-F]*$/.test(raw)) throw new Error(`not hex: ${hex}`);
  const out = raw.slice(i * 64, i * 64 + 64);
  if (out.length !== 64) throw new Error(`return data has no word ${String(i)}`);
  return out.toLowerCase();
}

const uintAt = (hex: string, i: number): bigint => BigInt(`0x${wordAt(hex, i)}`);

/** Decode the address in word `i`, such as a getter's `USDC()`, lowercase. */
export function decodeAddress(hex: string, i = 0): string {
  return `0x${wordAt(hex, i).slice(24)}`;
}

/** Decode the uint256 in word `i`, such as a single return value or a log's amount. */
export function decodeUint(hex: string, i = 0): bigint {
  return uintAt(hex, i);
}

/** Decode a single bytes32 return value, lowercase. */
export function decodeBytes32(hex: string): string {
  return `0x${wordAt(hex, 0)}`;
}

/** Decode a short string such as a pend reason, left-aligned in word `i` and zero-padded. */
export function decodeShortString(hex: string, i = 0): string {
  return u8aToString(hexToU8a(`0x${wordAt(hex, i)}`)).replace(/\0+$/, '');
}

/** A sale's status on its proxy: None, Paid, Held. */
export type SaleStatus = 0 | 1 | 2;

/** The decoded `delivery(ref, recipient, committed)` of one sale. */
export interface SaleDelivery {
  readonly status: SaleStatus;
  readonly amount: bigint;
  readonly leftover: bigint;
}

/** Decode the three words `delivery` returns. */
export function decodeDelivery(hex: string): SaleDelivery {
  const status = uintAt(hex, 0);
  if (status > 2n) throw new Error(`unknown sale status ${status.toString()}`);
  return { status: Number(status) as SaleStatus, amount: uintAt(hex, 1), leftover: uintAt(hex, 2) };
}

/** A log as `eth_getLogs` answers it, reduced to what the keeper reads. */
export interface RawLog {
  readonly address: string;
  readonly topics: readonly string[];
  readonly data: string;
  readonly txHash: string;
  readonly logIndex: number;
}

/** A gas-deferred delivery as `DeliveryDeferred` or `DeferredExpired` logs it, the deadline its replay needs. */
export interface DeliveryDeferred extends SaleTerms {
  readonly amount: bigint;
  /** Epoch seconds. */
  readonly deadline: bigint;
}

// The home, claimer and third topic of a factory log keyed by home and claimer, refusing a missing one
function homeClaimerTopics(log: RawLog, name: string): [string, string, string] {
  const [, home, claimer, third] = log.topics;
  if (home === undefined || claimer === undefined || third === undefined) throw new Error(`${name} log has no home, claimer or third topic`);
  return [decodeBytes32(home), decodeAddress(claimer), third];
}

/** Decode a `DeliveryDeferred` or `DeferredExpired(home, claimer, ref, recipient, committed, amount, deadline)` log, the first three indexed. */
export function decodeDeferral(log: RawLog): DeliveryDeferred {
  const [home, claimer, ref] = homeClaimerTopics(log, 'deferral');
  if (log.data.replace(/^0x/, '').length !== 4 * 64) throw new Error(`deferral log data is not four words: ${log.data}`);
  return {
    home,
    claimer,
    ref: decodeBytes32(ref),
    recipient: decodeAddress(log.data, 0),
    committed: uintAt(log.data, 1),
    amount: uintAt(log.data, 2),
    deadline: uintAt(log.data, 3),
  };
}

/** A pending credit the factory moved, to the proxy or, when the proxy refused it, to the claimer. */
export interface PendingFlushed {
  readonly home: string;
  readonly claimer: string;
  readonly to: string;
  readonly amount: bigint;
}

/** Decode a `PendingFlushed(home, claimer, to, amount)` log, the first three indexed. */
export function decodePendingFlushed(log: RawLog): PendingFlushed {
  const [home, claimer, to] = homeClaimerTopics(log, 'PendingFlushed');
  return { home, claimer, to: decodeAddress(to), amount: uintAt(log.data, 0) };
}

/** An address as a 32-byte log topic, for filtering an indexed address. */
export function addressTopic(address: string): string {
  return u8aToHex(bytes32(checked(address, EVM_ADDRESS, 'address')));
}

/** The address in an indexed topic, lowercase. */
export function topicAddress(topic: string): string {
  return decodeAddress(topic);
}

/** calldata for a factory call keyed by a home and its claimer, such as `flush(bytes32,address)`. */
export function encodeHomeClaimerCall(
  signature: 'flush(bytes32,address)' | 'deploy(bytes32,address)' | 'pending(bytes32,address)' | 'predict(bytes32,address)',
  home: string,
  claimer: string,
): string {
  return u8aToHex(u8aConcat(selector(signature), bytes32(checked(home, BYTES32, 'home')), bytes32(checked(claimer, EVM_ADDRESS, 'claimer'))));
}

/** calldata for the factory's `deliver`, `expireDeferred` or `pendingDelivery`, home and claimer first, then the terms and the deadline. */
export function encodeClaimerTermsCall(
  signature:
    | 'deliver(bytes32,address,bytes32,address,uint256,uint256)'
    | 'expireDeferred(bytes32,address,bytes32,address,uint256,uint256)'
    | 'pendingDelivery(bytes32,address,bytes32,address,uint256,uint256)',
  t: SaleTerms,
  deadline: bigint,
): string {
  return u8aToHex(
    u8aConcat(
      selector(signature),
      bytes32(checked(t.home, BYTES32, 'home')),
      bytes32(checked(t.claimer, EVM_ADDRESS, 'claimer')),
      bytes32(checked(t.ref, BYTES32, 'ref')),
      bytes32(checked(t.recipient, EVM_ADDRESS, 'recipient')),
      word(t.committed),
      word(deadline),
    ),
  );
}

/** calldata for the proxy's permissionless `release()`, which pays its whole USDC balance to the claimer once due. */
export function encodeRelease(): string {
  return encodeCall('release()');
}

/** calldata for the factory's `retired()` getter. */
export function encodeRetired(): string {
  return encodeCall('retired()');
}

/** Decode a single bool return value, refusing any word but 0 or 1. */
export function decodeBool(hex: string): boolean {
  const value = uintAt(hex, 0);
  if (value > 1n) throw new Error(`not a bool: ${value.toString()}`);
  return value === 1n;
}

/** The decoded `state()` of a claimer-bound proxy. */
export interface ClaimerProxyState {
  readonly home: string;
  readonly claimer: string;
  readonly balance: bigint;
  readonly attempts: number;
  readonly lastReturnAt: bigint;
  /** Epoch seconds, 0 before the first return since the last delivery. */
  readonly nextReturnAt: bigint;
  /** Epoch seconds from which release may run on the current balance, 0 once retired or out of attempts, uint256 max while a returnable balance has no clock. */
  readonly releaseAt: bigint;
  /** What release would send now, 0 before releaseAt. */
  readonly releasable: bigint;
}

/** Decode the eight static words a claimer-bound proxy's `state()` returns, by index. */
export function decodeClaimerProxyState(hex: string): ClaimerProxyState {
  return {
    home: `0x${wordAt(hex, 0)}`,
    claimer: decodeAddress(hex, 1),
    balance: uintAt(hex, 2),
    attempts: Number(uintAt(hex, 3)),
    lastReturnAt: uintAt(hex, 4),
    nextReturnAt: uintAt(hex, 5),
    releaseAt: uintAt(hex, 6),
    releasable: uintAt(hex, 7),
  };
}
