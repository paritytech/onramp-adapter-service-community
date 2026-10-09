/**
 * Proof that a caller controls a headless customer key, and the short-lived token that carries it.
 *
 * The app derives one sr25519 customer key per identity. `challenge` mints the same stateless
 * 56-byte token the personhood handshake uses, under its own HKDF key. `issueToken` checks the
 * challenge, verifies the signature over its raw bytes, and mints an HS256 token whose `sub` is
 * the customer key hash, `aud` the caller's product and `sa` the caller's alias. The public key is
 * used for that one verification and then dropped: only its hash is kept, in the token and in the
 * store, and no log line or refusal detail names it.
 *
 * Routes that act for a customer run caller auth first and then this token (`customerGate`), so a
 * token minted for one caller cannot be spent by another, even within the same product.
 */

import type { FastifyRequest } from 'fastify';
import { SignJWT, importJWK, jwtVerify, type CryptoKey, type JWK } from 'jose';
import { hexToU8a, stringToU8a, u8aConcat, u8aToHex } from '@polkadot/util';
import { blake2AsU8a, sr25519Verify } from '@polkadot/util-crypto';

import type { Subject } from './auth.js';
import type { CallerGate } from './caller.js';
import type { Config } from './config.js';
import { customerProofInvalid, customerTokenInvalid, type CustomerTokenRequest } from './contract.js';
import { mintChallenge, verifyChallenge } from './personhood/challenge.js';

/** The two keys HKDF-derived from `customer.token_key` at boot. */
export interface CustomerKeys {
  customerChallengeKey: Uint8Array;
  customerTokenKey: Uint8Array;
}

interface CustomerTtls {
  challengeTtlMs: number;
  tokenTtlSeconds: number;
}

const CUSTOMER_KEY_DOMAIN = 'onramp:meld-customer-key:';
const KEY_HASH = /^[0-9a-f]{64}$/;

/** Lowercase hex `blake2b-256("onramp:meld-customer-key:" || publicKey)`, with no `0x`. */
export function customerKeyHash(publicKey: Uint8Array): string {
  return u8aToHex(blake2AsU8a(u8aConcat(stringToU8a(CUSTOMER_KEY_DOMAIN), publicKey), 256), -1, false);
}

const toWire = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');
const fromWire = (s: string) => new Uint8Array(Buffer.from(s, 'base64url'));

/** False for any signature that does not verify, including a public key that is not a valid point. */
function signatureHolds(message: Uint8Array, signature: string, publicKey: Uint8Array): boolean {
  try {
    return sr25519Verify(message, hexToU8a(signature), publicKey);
  } catch {
    return false;
  }
}

export class CustomerAuth {
  #tokenKey: Promise<CryptoKey | Uint8Array> | undefined;

  constructor(
    private readonly keys: CustomerKeys,
    private readonly ttls: CustomerTtls,
    private readonly now: () => number = Date.now,
  ) {}

  challenge(): { challenge: string } {
    return { challenge: toWire(mintChallenge(this.keys.customerChallengeKey, { issuedAtMillis: this.now() })) };
  }

  /** Verify a key proof and mint the customer token for this caller, or refuse. */
  async issueToken(subject: Subject, input: CustomerTokenRequest): Promise<{ token: string; expiresAtMs: number }> {
    const challenge = fromWire(input.challenge);
    try {
      verifyChallenge(this.keys.customerChallengeKey, challenge, { now: this.now(), ttlMillis: this.ttls.challengeTtlMs });
    } catch (cause) {
      throw customerProofInvalid(`customer challenge rejected: ${cause instanceof Error ? cause.message : 'malformed'}`);
    }

    const publicKey = hexToU8a(input.publicKey);
    if (!signatureHolds(challenge, input.signature, publicKey)) {
      throw customerProofInvalid('customer key signature does not verify over the challenge');
    }

    const issuedAt = Math.floor(this.now() / 1_000);
    const expiresAt = issuedAt + this.ttls.tokenTtlSeconds;
    const token = await new SignJWT({ sa: subject.alias })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(customerKeyHash(publicKey))
      .setAudience(subject.productId)
      .setIssuedAt(issuedAt)
      .setExpirationTime(expiresAt)
      .sign(await this.tokenKey());
    return { token, expiresAtMs: expiresAt * 1_000 };
  }

  /** The customer key hash a token names, if it is valid and bound to this caller; refuse otherwise. */
  async verifyToken(subject: Subject, token: string | undefined): Promise<string> {
    if (token === undefined) throw customerTokenInvalid('missing x-customer-token header');
    let payload: { sub?: unknown; aud?: unknown; sa?: unknown };
    try {
      ({ payload } = await jwtVerify(token, await this.tokenKey(), {
        algorithms: ['HS256'],
        audience: subject.productId,
        currentDate: new Date(this.now()),
      }));
    } catch {
      throw customerTokenInvalid('customer token rejected');
    }
    // jose accepts an `aud` array that merely contains the product, so the single value is checked.
    if (payload.aud !== subject.productId || payload.sa !== subject.alias) {
      throw customerTokenInvalid('customer token is bound to another caller');
    }
    if (typeof payload.sub !== 'string' || !KEY_HASH.test(payload.sub)) {
      throw customerTokenInvalid('customer token carries no customer key hash');
    }
    return payload.sub;
  }

  private tokenKey(): Promise<CryptoKey | Uint8Array> {
    this.#tokenKey ??= importJWK({ kty: 'oct', k: toWire(this.keys.customerTokenKey) } satisfies JWK, 'HS256');
    return this.#tokenKey;
  }
}

/**
 * The customer token service when Meld Headless is enabled, `undefined` when it is not.
 *
 * Enabled without its keys refuses at boot, never per request, like `callerAuth`.
 */
export function customerAuth(cfg: Pick<Config, 'meld' | 'customer'>, keys: CustomerKeys | undefined): CustomerAuth | undefined {
  if (cfg.meld.headless?.enabled !== true) return undefined;
  if (keys === undefined || cfg.customer === undefined) {
    throw new Error('meld.headless.enabled requires the customer block and its keys.');
  }
  return new CustomerAuth(keys, {
    challengeTtlMs: cfg.customer.challenge_ttl_s * 1_000,
    tokenTtlSeconds: cfg.customer.token_ttl_s,
  });
}

/**
 * Route options for a route that acts for a customer, and the customer key hash it proved.
 *
 * `asCustomer` keeps the caller gate's `identify` and `enforce` in place, so the rate limit and
 * the caller refusal behave as on every `asCaller` route, and checks `x-customer-token` last.
 */
export function customerGate(auth: CustomerAuth, caller: Pick<CallerGate, 'identify' | 'enforce' | 'subjectOf'>) {
  const verified = new WeakMap<FastifyRequest, string>();

  const verify = async (request: FastifyRequest): Promise<void> => {
    const header = request.headers['x-customer-token'];
    verified.set(request, await auth.verifyToken(caller.subjectOf(request), typeof header === 'string' ? header : undefined));
  };

  return {
    asCustomer: { onRequest: caller.identify, preHandler: [caller.enforce, verify] },
    /** The proven customer key hash. Fails closed when the route was wired without `asCustomer`. */
    customerKeyHashOf: (request: FastifyRequest): string => {
      const hash = verified.get(request);
      if (hash === undefined) throw customerTokenInvalid('Customer authentication did not run for this route.');
      return hash;
    },
  };
}
