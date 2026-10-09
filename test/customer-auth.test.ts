import { SignJWT, decodeJwt } from 'jose';
import { describe, expect, it } from 'vitest';

import { stringToU8a, u8aConcat, u8aToHex, u8aWrapBytes } from '@polkadot/util';
import { blake2AsHex, sr25519PairFromSeed, sr25519Sign } from '@polkadot/util-crypto';

import type { Subject } from '../src/auth.js';
import { CustomerAuth, customerAuth, customerKeyHash, type CustomerKeys } from '../src/customer-auth.js';
import { Refusal } from '../src/contract.js';
import { mintChallenge } from '../src/personhood/challenge.js';
import { config, headlessConfig } from './fixtures.js';

const KEYS: CustomerKeys = {
  customerChallengeKey: new Uint8Array(32).fill(3),
  customerTokenKey: new Uint8Array(32).fill(4),
};
const TTLS = { challengeTtlMs: 120_000, tokenTtlSeconds: 600 };
const T0 = 1_800_000_000_000;
const CALLER: Subject = { productId: 'app.dot', alias: '0xada', proven: true };

const pair = sr25519PairFromSeed(new Uint8Array(32).fill(7));
const other = sr25519PairFromSeed(new Uint8Array(32).fill(8));

const fromWire = (s: string) => new Uint8Array(Buffer.from(s, 'base64url'));

/** The proof the app sends: the raw challenge bytes signed, no `<Bytes>` wrapper. */
const proofFor = (challenge: string, signer = pair, message: Uint8Array = fromWire(challenge)) => ({
  publicKey: u8aToHex(pair.publicKey),
  challenge,
  signature: u8aToHex(sr25519Sign(message, signer)),
});

/** A service on a clock the test moves. */
const clocked = (start = T0) => {
  let now = start;
  const auth = new CustomerAuth(KEYS, TTLS, () => now);
  return {
    auth,
    advance: (ms: number) => {
      now += ms;
    },
  };
};

const refusalCode = async (promise: Promise<unknown>): Promise<string | undefined> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Refusal && error.failure.tag === 'Other') return error.failure.value.code;
    throw error;
  }
  return undefined;
};

describe('customerKeyHash', () => {
  it('is blake2b-256 over the domain prefix and the key, as lowercase hex without 0x', () => {
    const expected = blake2AsHex(u8aConcat(stringToU8a('onramp:meld-customer-key:'), pair.publicKey), 256).slice(2);
    expect(customerKeyHash(pair.publicKey)).toBe(expected);
    expect(customerKeyHash(pair.publicKey)).toMatch(/^[0-9a-f]{64}$/);
    expect(customerKeyHash(other.publicKey)).not.toBe(expected);
  });
});

describe('CustomerAuth.issueToken', () => {
  it('mints a token naming the key hash, bound to the caller product and alias', async () => {
    const { auth } = clocked();
    const { challenge } = auth.challenge();

    const issued = await auth.issueToken(CALLER, proofFor(challenge));

    const claims = decodeJwt(issued.token);
    expect(claims).toMatchObject({ sub: customerKeyHash(pair.publicKey), aud: 'app.dot', sa: '0xada' });
    expect(claims.exp).toBe(Math.floor(T0 / 1_000) + 600);
    expect(issued.expiresAtMs).toBe((Math.floor(T0 / 1_000) + 600) * 1_000);
    // Only the hash travels; the key itself is in no claim.
    expect(issued.token).not.toContain(u8aToHex(pair.publicKey).slice(2));
    await expect(auth.verifyToken(CALLER, issued.token)).resolves.toBe(customerKeyHash(pair.publicKey));
  });

  it('refuses a signature over the <Bytes>-wrapped challenge', async () => {
    // `signatureVerify` would accept this by trying the wrapped form too; the contract is raw bytes.
    const { auth } = clocked();
    const { challenge } = auth.challenge();

    const wrapped = proofFor(challenge, pair, u8aWrapBytes(fromWire(challenge)));

    expect(await refusalCode(auth.issueToken(CALLER, wrapped))).toBe('CUSTOMER_PROOF_INVALID');
  });

  it('refuses a signature made by another key', async () => {
    const { auth } = clocked();
    const { challenge } = auth.challenge();

    expect(await refusalCode(auth.issueToken(CALLER, proofFor(challenge, other)))).toBe('CUSTOMER_PROOF_INVALID');
  });

  it('refuses a public key that is not a curve point rather than throwing', async () => {
    const { auth } = clocked();
    const { challenge } = auth.challenge();

    const proof = { ...proofFor(challenge), publicKey: '0x' + 'ff'.repeat(32) };

    expect(await refusalCode(auth.issueToken(CALLER, proof))).toBe('CUSTOMER_PROOF_INVALID');
  });

  it('refuses a challenge past its TTL', async () => {
    const { auth, advance } = clocked();
    const { challenge } = auth.challenge();
    advance(TTLS.challengeTtlMs + 1);

    expect(await refusalCode(auth.issueToken(CALLER, proofFor(challenge)))).toBe('CUSTOMER_PROOF_INVALID');
  });

  it('refuses a tampered challenge even when the signature covers the tampered bytes', async () => {
    const { auth } = clocked();
    const bytes = fromWire(auth.challenge().challenge);
    bytes[0] = (bytes[0] ?? 0) ^ 0xff;
    const tampered = Buffer.from(bytes).toString('base64url');

    expect(await refusalCode(auth.issueToken(CALLER, proofFor(tampered)))).toBe('CUSTOMER_PROOF_INVALID');
  });

  it('refuses a challenge minted under another key, such as the personhood one', async () => {
    const { auth } = clocked();
    const foreign = Buffer.from(mintChallenge(new Uint8Array(32).fill(9), { issuedAtMillis: T0 })).toString('base64url');

    expect(await refusalCode(auth.issueToken(CALLER, proofFor(foreign)))).toBe('CUSTOMER_PROOF_INVALID');
  });

  it('keeps the public key out of the refusal detail', async () => {
    const { auth } = clocked();
    const { challenge } = auth.challenge();

    const failure = auth.issueToken(CALLER, proofFor(challenge, other));

    await expect(failure).rejects.toBeInstanceOf(Refusal);
    await expect(failure).rejects.not.toThrow(u8aToHex(pair.publicKey).slice(2));
  });
});

describe('CustomerAuth.verifyToken', () => {
  const issue = async (auth: CustomerAuth, caller = CALLER) =>
    (await auth.issueToken(caller, proofFor(auth.challenge().challenge))).token;

  /** A token signed with the real key but claims the service never writes. */
  const forge = (claims: Record<string, unknown>, aud: string | string[] = 'app.dot') =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: 'HS256' })
      .setAudience(aud)
      .setIssuedAt(Math.floor(T0 / 1_000))
      .setExpirationTime(Math.floor(T0 / 1_000) + 600)
      .sign(KEYS.customerTokenKey);

  it('refuses a missing token', async () => {
    expect(await refusalCode(clocked().auth.verifyToken(CALLER, undefined))).toBe('CUSTOMER_TOKEN_INVALID');
  });

  it('refuses a token bound to another alias in the same product', async () => {
    const { auth } = clocked();
    const token = await issue(auth, { ...CALLER, alias: '0xgrace' });

    expect(await refusalCode(auth.verifyToken(CALLER, token))).toBe('CUSTOMER_TOKEN_INVALID');
  });

  it('refuses a token minted for another product', async () => {
    const { auth } = clocked();
    const token = await issue(auth, { ...CALLER, productId: 'other.dot' });

    expect(await refusalCode(auth.verifyToken(CALLER, token))).toBe('CUSTOMER_TOKEN_INVALID');
  });

  it('refuses a token past its TTL', async () => {
    const { auth, advance } = clocked();
    const token = await issue(auth);
    advance(TTLS.tokenTtlSeconds * 1_000 + 1_000);

    expect(await refusalCode(auth.verifyToken(CALLER, token))).toBe('CUSTOMER_TOKEN_INVALID');
  });

  it('refuses a token signed with another key, such as the challenge key', async () => {
    const { auth } = clocked();
    const token = await new SignJWT({ sa: CALLER.alias })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(customerKeyHash(pair.publicKey))
      .setAudience('app.dot')
      .setExpirationTime(Math.floor(T0 / 1_000) + 600)
      .sign(KEYS.customerChallengeKey);

    expect(await refusalCode(auth.verifyToken(CALLER, token))).toBe('CUSTOMER_TOKEN_INVALID');
  });

  it('refuses an audience list that merely contains the product', async () => {
    const { auth } = clocked();
    const token = await forge({ sub: customerKeyHash(pair.publicKey), sa: CALLER.alias }, ['app.dot', 'other.dot']);

    expect(await refusalCode(auth.verifyToken(CALLER, token))).toBe('CUSTOMER_TOKEN_INVALID');
  });

  it('refuses a token whose subject is not a customer key hash', async () => {
    const { auth } = clocked();
    const token = await forge({ sub: '0xada', sa: CALLER.alias });

    expect(await refusalCode(auth.verifyToken(CALLER, token))).toBe('CUSTOMER_TOKEN_INVALID');
  });
});

describe('customerAuth', () => {
  it('builds nothing when headless is disabled', () => {
    expect(customerAuth(config(), KEYS)).toBeUndefined();
  });

  it('refuses headless without its keys', () => {
    expect(() => customerAuth(config(headlessConfig()), undefined)).toThrow(/requires the customer block and its keys/);
  });

  it('takes both TTLs from the customer block', async () => {
    const auth = customerAuth(config({ ...headlessConfig(), customer: { ...(headlessConfig().customer as object), challenge_ttl_s: 10, token_ttl_s: 30 } }), KEYS);
    if (auth === undefined) throw new Error('expected a customer service');

    const stale = Buffer.from(mintChallenge(KEYS.customerChallengeKey, { issuedAtMillis: Date.now() - 11_000 })).toString('base64url');
    expect(await refusalCode(auth.issueToken(CALLER, proofFor(stale)))).toBe('CUSTOMER_PROOF_INVALID');

    const issued = await auth.issueToken(CALLER, proofFor(auth.challenge().challenge));
    const claims = decodeJwt(issued.token);
    expect((claims.exp ?? 0) - (claims.iat ?? 0)).toBe(30);
  });
});
