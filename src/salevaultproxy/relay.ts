// Relays a claimer's signed USDC transferWithAuthorization (EIP-3009), so released USDC can leave a claimer that holds no ETH.

import { hexToU8a, u8aConcat, u8aToBigInt, u8aToHex } from '@polkadot/util';
import { keccakAsU8a, secp256k1Recover } from '@polkadot/util-crypto';

import type { Subject } from '../auth.js';
import { reject, saleVaultProxyUnavailable, type RelayRequest } from '../contract.js';
import type { FundingStore } from '../funding/store.js';
import { bytes32, selector, word } from './abi.js';
import { ChainUnavailableError, type SaleVaultProxyChain } from './chain.js';
import type { SaleVaultProxyKeeper } from './keeper.js';
import { chainUnavailable } from './service.js';

/** One transfer authorization as the claimer signed it, addresses lowercase. */
export interface TransferAuthorization {
  readonly from: string;
  readonly to: string;
  readonly value: bigint;
  readonly validAfter: bigint;
  readonly validBefore: bigint;
  readonly nonce: string;
}

/** The struct FiatTokenV2 hashes, refused unless the token's own TRANSFER_WITH_AUTHORIZATION_TYPEHASH matches it. */
export const TRANSFER_WITH_AUTHORIZATION_TYPE =
  'TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)';

const TYPEHASH = keccakAsU8a(new TextEncoder().encode(TRANSFER_WITH_AUTHORIZATION_TYPE), 256);

// The secp256k1 half order, the most ECRecover.sol accepts for s
const HALF_ORDER = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

/** The EIP-712 digest the token recovers the signer from, `\x19\x01 || domainSeparator || structHash`. */
export function transferAuthorizationDigest(domainSeparator: string, a: TransferAuthorization): Uint8Array {
  const structHash = keccakAsU8a(
    u8aConcat(TYPEHASH, bytes32(a.from), bytes32(a.to), word(a.value), word(a.validAfter), word(a.validBefore), bytes32(a.nonce)),
    256,
  );
  return keccakAsU8a(u8aConcat(Uint8Array.of(0x19, 0x01), bytes32(domainSeparator), structHash), 256);
}

/** The lowercase address that signed a digest, or undefined for any signature ECRecover.sol would refuse. */
export function recoverSigner(digest: Uint8Array, signature: string): string | undefined {
  const sig = hexToU8a(signature);
  if (sig.length !== 65) return undefined;
  const v = sig[64] ?? 0;
  const s = u8aToBigInt(sig.slice(32, 64), { isLe: false });
  if ((v !== 27 && v !== 28) || s > HALF_ORDER) return undefined;
  try {
    // The 64-byte x || y key hashes to the address in its last 20 bytes
    return u8aToHex(keccakAsU8a(secp256k1Recover(digest, sig.slice(0, 64), v - 27, 'keccak'), 256).slice(12));
  } catch {
    return undefined;
  }
}

/** calldata for FiatTokenV2's `transferWithAuthorization` in its v, r, s form, present on every V2 token. */
export function encodeTransferWithAuthorization(a: TransferAuthorization, signature: string): string {
  const sig = hexToU8a(signature);
  if (sig.length !== 65) throw new Error('signature must be 65 bytes');
  return u8aToHex(
    u8aConcat(
      selector('transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)'),
      bytes32(a.from),
      bytes32(a.to),
      word(a.value),
      word(a.validAfter),
      word(a.validBefore),
      bytes32(a.nonce),
      word(BigInt(sig[64] ?? 0)),
      sig.slice(0, 32),
      sig.slice(32, 64),
    ),
  );
}

/** What a relay answers: the transaction the keeper broadcast. */
export interface RelayDto {
  status: 'sent';
  chainId: number;
  txHash: string | null;
}

export type RelayStore = Pick<FundingStore, 'isSellerClaimer' | 'isSaleAddress' | 'readLatestProxyCall'>;
export type RelayChain = Pick<SaleVaultProxyChain, 'bytes32Of' | 'authorizationUsed' | 'usdcBalance'>;
export type RelayKeeper = Pick<SaleVaultProxyKeeper, 'current' | 'relay'>;

const refused = (code: string, message: string, detail: string, status = 400) => reject({ tag: 'Other', value: { code, message } }, detail, status);

export class SaleVaultProxyRelay {
  // Each token's domain separator once its typehash matched, it only changes with the chain id
  private readonly domains = new Map<string, string>();

  constructor(
    private readonly store: RelayStore,
    private readonly chain: RelayChain,
    private readonly keeper: RelayKeeper,
    private readonly clock: () => number = Date.now,
  ) {}

  /** Check a signed authorization off chain and against the token, then have the keeper send it. */
  async relay(subject: Subject, request: RelayRequest): Promise<RelayDto> {
    // Released USDC must still leave a claimer once the factory is retired or closed to new sells
    const v = this.keeper.current();
    if (v === undefined) throw saleVaultProxyUnavailable('no verified sale vault proxy deployment to relay on');
    const a: TransferAuthorization = {
      from: request.from,
      to: request.to,
      value: BigInt(request.value),
      validAfter: BigInt(request.validAfter),
      validBefore: BigInt(request.validBefore),
      nonce: request.nonce.toLowerCase(),
    };
    if (a.to === a.from) throw refused('RELAY_SELF_TRANSFER', 'A relay must move the USDC somewhere else.', 'relay to its own sender');
    // The token's own window, strictly after validAfter and strictly before validBefore
    const now = BigInt(Math.floor(this.clock() / 1000));
    if (!(now > a.validAfter && now < a.validBefore)) {
      throw refused('RELAY_OUTSIDE_WINDOW', 'That authorization is not valid now.', `relay window ${a.validAfter.toString()}..${a.validBefore.toString()} excludes ${now.toString()}`);
    }
    if (!(await this.store.isSellerClaimer(subject.productId, a.from))) {
      throw refused('RELAY_NOT_CLAIMER', 'Only a seller claimer can be relayed from.', `${a.from} is no claimer of product ${subject.productId}`, 403);
    }
    // A claimer or proxy as the payee would let one balance cycle through relays and releases on our gas
    if (await this.store.isSaleAddress(v.chainId, a.to)) {
      throw refused('RELAY_TO_SALE_ADDRESS', 'A relay cannot pay a sale address.', `${a.to} is a claimer or proxy`);
    }
    try {
      const domain = await this.domainOf(v.usdc);
      if (recoverSigner(transferAuthorizationDigest(domain, a), request.signature) !== a.from) {
        throw refused('RELAY_BAD_SIGNATURE', 'The signature does not match the authorization.', `relay signature is not ${a.from}'s`);
      }
      if (await this.chain.authorizationUsed(v.usdc, a.from, a.nonce)) {
        throw refused('RELAY_NONCE_USED', 'That authorization was already used or cancelled.', `nonce ${a.nonce} of ${a.from} is spent`, 409);
      }
      const balance = await this.chain.usdcBalance(v.usdc, a.from);
      if (balance < a.value) {
        throw refused('RELAY_INSUFFICIENT_BALANCE', 'The claimer holds less USDC than that.', `${a.from} holds ${balance.toString()} of ${a.value.toString()}`, 409);
      }
      // Only the whole balance, so each keeper-paid relay empties the claimer and a refill costs its sender gas
      if (balance > a.value) {
        throw refused('RELAY_NOT_WHOLE_BALANCE', 'A relay must move all the USDC the claimer holds.', `${a.from} holds ${balance.toString()}, more than ${a.value.toString()}`, 409);
      }
      const outcome = await this.keeper.relay(v.chainId, v.usdc, a.from, encodeTransferWithAuthorization(a, request.signature), a.value);
      if (outcome === 'reverted') throw refused('RELAY_WOULD_REVERT', 'The token would refuse that transfer.', `relay from ${a.from} would revert`, 422);
      if (outcome === 'skipped') throw refused('RELAY_BUSY', 'A relay for this claimer is already in flight. Retry shortly.', `relay from ${a.from} left in flight`, 409);
      if (outcome === 'locked') throw refused('RELAY_KEEPER_BUSY', 'The keeper is busy. Retry shortly.', `relay from ${a.from} left to the keeper lock holder`, 503);
    } catch (error) {
      if (error instanceof ChainUnavailableError) throw chainUnavailable(error.message);
      throw error;
    }
    const call = await this.store.readLatestProxyCall(v.chainId, a.from);
    return { status: 'sent', chainId: v.chainId, txHash: call?.tx_hash ?? null };
  }

  // The token's domain separator, refused when its typehash is not the struct signed here
  private async domainOf(token: string): Promise<string> {
    const cached = this.domains.get(token);
    if (cached !== undefined) return cached;
    const [typehash, domain] = await Promise.all([
      this.chain.bytes32Of(token, 'TRANSFER_WITH_AUTHORIZATION_TYPEHASH()'),
      this.chain.bytes32Of(token, 'DOMAIN_SEPARATOR()'),
    ]);
    if (typehash !== u8aToHex(TYPEHASH)) throw saleVaultProxyUnavailable(`token ${token} has transfer authorization typehash ${typehash}`);
    this.domains.set(token, domain);
    return domain;
  }
}
