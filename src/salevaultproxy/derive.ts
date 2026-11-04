// Off-chain CREATE2 derivation of a seller's SaleVaultProxy, matching OpenZeppelin Clones with immutable args.

import { hexToU8a, u8aToHex } from '@polkadot/util';
import { decodeAddress, ethereumEncode, keccakAsU8a } from '@polkadot/util-crypto';

import { BYTES32, EVM_ADDRESS } from './abi.js';

const HOME_BYTES = 32;
// EIP-1167 runtime code around the implementation, as OZ Clones writes it
const EIP1167_PREFIX = '3d81600a3d39f3363d3d373d3d3d363d73';
const EIP1167_SUFFIX = '5af43d82803e903d91602b57fd5bf3';

/** The seller's 32-byte home as 0x hex, from an SS58 account under any prefix. */
export function homeOf(sellerAccount: string): string {
  const key = decodeAddress(sellerAccount);
  if (key.length !== HOME_BYTES) throw new Error(`seller account is ${String(key.length)} bytes, expected ${String(HOME_BYTES)}`);
  return u8aToHex(key);
}

function addressHex(address: string, what: string): string {
  if (!EVM_ADDRESS.test(address)) throw new Error(`${what} is not an address: ${address}`);
  return address.slice(2).toLowerCase();
}

/** The address `factory.predict(home, claimer)` returns, lowercase: args are home then claimer, the salt their keccak256. */
export function predictSaleVaultProxy(factory: string, implementation: string, home: string, claimer: string): string {
  if (!BYTES32.test(home)) throw new Error(`home must be 32 bytes: ${home}`);
  const claimerHex = addressHex(claimer, 'claimer');
  // The factory refuses a zero claimer
  if (/^0+$/.test(claimerHex)) throw new Error('claimer must not be the zero address');
  const args = `${home.slice(2).toLowerCase()}${claimerHex}`;
  const salt = u8aToHex(keccakAsU8a(hexToU8a(`0x${args}`), 256)).slice(2);
  // The PUSH2 length is the runtime code size, 0x2d plus the args
  const runtimeLength = (args.length / 2 + 0x2d).toString(16).padStart(4, '0');
  const initcode = `0x61${runtimeLength}${EIP1167_PREFIX}${addressHex(implementation, 'implementation')}${EIP1167_SUFFIX}${args}`;
  const initHash = u8aToHex(keccakAsU8a(hexToU8a(initcode), 256)).slice(2);
  const preimage = `0xff${addressHex(factory, 'factory')}${salt}${initHash}`;
  return `0x${u8aToHex(keccakAsU8a(hexToU8a(preimage), 256)).slice(-40)}`;
}

/** EIP-55 casing of a 20-byte address. Never pass anything longer, ethereumEncode keeps the last 20 bytes. */
export function checksum(address: string): string {
  return ethereumEncode(hexToU8a(`0x${addressHex(address, 'address')}`));
}
