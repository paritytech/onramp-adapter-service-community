import { NONCE_BYTES } from '../../src/personhood/challenge.js';
import { describe, expect, it } from 'vitest';

import { hexToU8a, u8aToHex } from '@polkadot/util';

import { Refusal } from '../../src/contract.js';
import { PersonhoodService, type PersonhoodDeps } from '../../src/personhood.js';
import { mintChallenge } from '../../src/personhood/challenge.js';
import { mintToken, verifyToken } from '../../src/personhood/token.js';

const ALIAS = '0x' + 'ab'.repeat(32);
const COMMITMENT = '0x' + '11'.repeat(768);
const IDENTIFIER = '0x' + '22'.repeat(32);
const PRODUCT = 'app.dot';
const OTHER = 'other.dot';
const UNALLOWED = 'dropshipped.dot';

const wire = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');

/** Distinct key material per call, so two services never share challenge or token keys. */
let keyNonce = 0;

/**
 * A handshake under test: the service, its two injected keys, and the stub commitments/validate.
 * Tests may replace any of `deps` and rebuild to isolate the one step under test.
 */
function makeService(overrides: Partial<PersonhoodDeps> = {}): { service: PersonhoodService; deps: PersonhoodDeps } {
  const challengeKey = new Uint8Array(32).fill(0x10 + keyNonce);
  const tokenKey = { secret: new Uint8Array(32).fill(0x20 + keyNonce) };
  keyNonce += 1;
  const deps: PersonhoodDeps = {
    validate: () => hexToU8a(ALIAS),
    commitments: { commitment: async () => COMMITMENT },
    challengeKey,
    tokenKey,
    challengeTtlMs: 60_000,
    tokenTtlSeconds: 300,
    rings: [{ identifier: IDENTIFIER, exponent: 9 }],
    allowedProducts: [PRODUCT, OTHER],
    ...overrides,
  };
  return { service: new PersonhoodService(deps), deps };
}

/** A second collection, as the deployment that serves both full and lite persons has. */
const LITE_IDENTIFIER = '0x' + '33'.repeat(32);

describe('several collections', () => {
  /**
   * A commitments stub that only knows one collection, and a validate that only opens against it.
   *
   * This is the shape the real chain has: a person is in exactly one collection, so the other's
   * ring either has no root at all or has one their proof does not open against.
   */
  function onlyKnows(identifier: string) {
    return {
      commitments: { commitment: async (id: string) => (id === identifier ? COMMITMENT : null) },
      validate: () => hexToU8a(ALIAS),
    };
  }

  it('recovers a person from the second collection when the first does not know them', async () => {
    // The case the list exists for. With one collection pinned, this person is refused while the
    // service reports itself healthy, so the failure looks like the buyer's problem.
    const { service, deps } = makeService({
      rings: [
        { identifier: IDENTIFIER, exponent: 9 },
        { identifier: LITE_IDENTIFIER, exponent: 10 },
      ],
      ...onlyKnows(LITE_IDENTIFIER),
    });

    const out = await service.redeem(validRedeem(deps));
    expect(out.token).toBeTruthy();
  });

  it('recovers a person from the first collection without consulting the second', async () => {
    // Order costs work, not outcome. A hit on the first must not go on to read the second. The
    // read is a chain round trip on the redeem path.
    const seen: string[] = [];
    const { service, deps } = makeService({
      rings: [
        { identifier: IDENTIFIER, exponent: 9 },
        { identifier: LITE_IDENTIFIER, exponent: 10 },
      ],
      commitments: {
        commitment: async (id: string) => {
          seen.push(id);
          return COMMITMENT;
        },
      },
    });

    await service.redeem(validRedeem(deps));
    expect(seen).toEqual([IDENTIFIER]);
  });

  it('uses each collection\'s own exponent, not the first one\'s', async () => {
    // The exponent is the proof domain. Carrying one value for the whole deployment would hand
    // the second collection the first collection's domain, and every honest proof would fail to
    // open: the exact silent refusal this change exists to remove.
    const exponents: number[] = [];
    const { service, deps } = makeService({
      rings: [
        { identifier: IDENTIFIER, exponent: 9 },
        { identifier: LITE_IDENTIFIER, exponent: 14 },
      ],
      commitments: { commitment: async (id: string) => (id === LITE_IDENTIFIER ? COMMITMENT : null) },
      validate: (exponent: number) => {
        exponents.push(exponent);
        return hexToU8a(ALIAS);
      },
    });

    await service.redeem(validRedeem(deps));
    expect(exponents).toEqual([14]);
  });

  it('reports a chain failure as unavailable even when another collection merely rejected', async () => {
    // The ordering that matters. If one collection could not be read and the other simply did not
    // open, the honest answer is that the check could not complete. A 401 would tell a real person
    // they are not a person, and point the operator at the caller instead of at the People chain.
    const { service, deps } = makeService({
      rings: [
        { identifier: IDENTIFIER, exponent: 9 },
        { identifier: LITE_IDENTIFIER, exponent: 10 },
      ],
      commitments: {
        commitment: async (id: string) => {
          if (id === IDENTIFIER) throw new Error('People chain unreachable');
          return null; // the other rejects: no root for this ring
        },
      },
    });

    await expect(service.redeem(validRedeem(deps))).rejects.toMatchObject({ status: 503 });
  });

  it('refuses with 401 when every collection rejects the proof', async () => {
    // All rejections and no chain trouble is a caller answerable refusal, and it stays the one
    // stable 401 on the wire.
    const { service, deps } = makeService({
      rings: [
        { identifier: IDENTIFIER, exponent: 9 },
        { identifier: LITE_IDENTIFIER, exponent: 10 },
      ],
      commitments: { commitment: async () => null },
    });

    await expect(service.redeem(validRedeem(deps))).rejects.toMatchObject({ status: 401 });
  });
});

/** A valid redeem body: a real challenge under the service's key, ring 0, allowed product. */
function validRedeem(deps: PersonhoodDeps, overrides: Record<string, unknown> = {}) {
  const token = mintChallenge(deps.challengeKey);
  return {
    challenge: wire(token),
    proof: wire(new Uint8Array([1, 2, 3])),
    ring: 0,
    productId: PRODUCT,
    ...overrides,
  };
}

/**
 * A refusal the caller is answerable for: `401`, and the one stable code.
 *
 * The status is asserted, not just the class. Every refusal here is a `Refusal` and several carry
 * overlapping detail, so `instanceof` plus a message match can be satisfied by the wrong branch,
 * and was: `upstreamUnavailable` interpolates `cause.message`, and `ProofRejected`'s message is
 * literally "membership proof rejected", so a 503 degrade met an assertion written for a 401.
 * A caller with a bad proof would have been told to retry for ever, and a chain outage and a
 * forged proof would be indistinguishable on the wire.
 */
const refuse = async (p: Promise<unknown>, detail?: RegExp) => {
  const error: unknown = await p.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(Refusal);
  expect((error as Refusal).status).toBe(401);
  expect((error as Refusal).failure).toMatchObject({ value: { code: 'UNAUTHORIZED' } });
  if (detail) expect((error as Error).message).toMatch(detail);
};

describe('challenge()', () => {
  it('issues a base64url token that decodes to the documented 56 bytes', () => {
    const { service } = makeService();
    const { challenge } = service.challenge();

    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(new Uint8Array(Buffer.from(challenge, 'base64url'))).toHaveLength(56);
  });

  it('is stateless: every challenge is fresh and distinct', () => {
    const { service } = makeService();
    expect(service.challenge().challenge).not.toBe(service.challenge().challenge);
  });

  it('draws a fresh nonce, not merely a fresh timestamp', () => {
    // Distinctness alone is satisfied by the embedded clock: replacing `randomBytes` with a
    // monotonic counter survived the suite, because two challenges minted a millisecond apart
    // differ in their timestamp bytes whatever the nonce is. The nonce is the first
    // `NONCE_BYTES`, so it is compared on its own.
    const { service } = makeService();
    const nonces = new Set<string>();
    for (let i = 0; i < 64; i += 1) {
      const raw = Buffer.from(service.challenge().challenge, 'base64url');
      nonces.add(raw.subarray(0, NONCE_BYTES).toString('hex'));
    }

    // A counter would also give 64 distinct values, so distinctness is not the assertion: the
    // top byte of a 16-byte counter never moves, while a random nonce fills it.
    expect(nonces.size).toBe(64);
    const topBytes = new Set([...nonces].map((n) => n.slice(0, 2)));
    expect(topBytes.size).toBeGreaterThan(8);
  });
});

describe('redeem()', () => {
  it('reports the token expiry in milliseconds, not seconds', async () => {
    // The other half of the TTL scaling bug. `expiresAtMs` is what the redeem response hands the
    // browser to schedule its refresh; a value 1000x too small makes every client treat a live
    // token as already expired. Round one named this site and only the JWT's own `exp` was fixed.
    const { service, deps } = makeService();

    const redeemed = await service.redeem(validRedeem(deps));

    const lifetime = redeemed.expiresAtMs - Date.now();
    expect(lifetime).toBeGreaterThan(deps.tokenTtlSeconds * 900);
    expect(lifetime).toBeLessThanOrEqual(deps.tokenTtlSeconds * 1000);
  });

  it('mints a token for a person whose proof validates against the served commitment', async () => {
    const seen = { identifier: '', ring: -1 };
    const { service, deps } = makeService({
      commitments: {
        commitment: async (identifier, ring) => {
          seen.identifier = identifier;
          seen.ring = ring;
          return COMMITMENT;
        },
      },
    });
    // Ring 3, not the fixture's 0: asserting `ring: 0` would be satisfied by a service that
    // hard-coded the ring and never read the caller's claim at all.
    const redeemed = await service.redeem(validRedeem(deps, { ring: 3 }));

    expect(seen).toEqual({ identifier: IDENTIFIER, ring: 3 });
    expect(redeemed.expiresAtMs).toBeGreaterThan(Date.now());
    expect(redeemed.token).toMatch(/^[A-Za-z0-9_.-]+$/);

    // The recovered on-chain alias is the token's `sub`: the per-person key that
    // funds the funding surface and audit record. A constant or wrong alias here would
    // silently merge every caller into one identity, so assert the binding directly.
    const claims = await verifyToken(deps.tokenKey, redeemed.token, [PRODUCT, OTHER]);
    expect(claims.sub).toBe(ALIAS);
    expect(claims.aud).toBe(PRODUCT);
  });

  it('binds the proof to this product and this challenge', async () => {
    // `validate` is the on-chain verifier: `context` and `message` are the exact bytes the proof
    // must have been minted over. Unbind `context` and a proof minted for one product opens a
    // session on another; unbind `message` and a recorded proof replays for as long as the ring
    // stands, which challenge.ts calls "the actual replay stop".
    const seen: { context?: Uint8Array; message?: Uint8Array } = {};
    const { service, deps } = makeService({
      validate: (_exponent, _proof, _commitment, context, message) => {
        seen.context = context;
        seen.message = message;
        return hexToU8a(ALIAS);
      },
    });
    const token = mintChallenge(deps.challengeKey);

    await service.redeem({ ...validRedeem(deps), challenge: wire(token), productId: OTHER });

    expect(new TextDecoder().decode(seen.context)).toBe(OTHER);
    expect(u8aToHex(seen.message ?? new Uint8Array())).toBe(u8aToHex(token));
  });

  it('degrades a chain failure to a retryable refusal, not an internal error', async () => {
    // A People-chain outage is a dependency declining to answer, which is what `ProviderTimeout`
    // means everywhere else here. It surfaced as a bare `500 INTERNAL`, telling a client to
    // report a bug, with no status to branch on and no `retry-after`. With no commitment cache
    // such an outage takes the whole spending surface down, so the code is the only signal.
    const { service, deps } = makeService({
      commitments: {
        commitment: () => Promise.reject(new Error('socket hang up')),
      },
    });

    const error: unknown = await service.redeem(validRedeem(deps)).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Refusal);
    expect((error as Refusal).status).toBe(503);
    expect((error as Refusal).failure).toEqual({ tag: 'ProviderTimeout' });
    // The operator detail names the cause; the caller never sees it.
    expect((error as Error).message).toContain('socket hang up');
  });

  it('rejects an inauthentic challenge before any chain read', async () => {
    const other = makeService(); // minted under a different challenge key
    let reads = 0;
    const { service } = makeService({
      commitments: {
        commitment: async () => {
          reads += 1;
          return COMMITMENT;
        },
      },
    });

    await refuse(service.redeem(validRedeem(other.deps)), /challenge rejected/);
    expect(reads).toBe(0);
  });

  it('rejects a malformed challenge before any chain read', async () => {
    let reads = 0;
    const { service, deps } = makeService({
      commitments: {
        commitment: async () => {
          reads += 1;
          return COMMITMENT;
        },
      },
    });

    await refuse(
      service.redeem({
        ...validRedeem(deps),
        challenge: 'not a base64url challenge of the right length',
      }),
      /challenge rejected/,
    );
    expect(reads).toBe(0);
  });

  it('rejects an expired challenge, even one the service itself minted', async () => {
    const { service, deps } = makeService();
    const token = mintChallenge(deps.challengeKey, { issuedAtMillis: Date.now() - 120_000 });

    await refuse(
      service.redeem({ ...validRedeem(deps), challenge: wire(token) }),
      /expired/,
    );
  });

  it('rejects a product that is not on the allowlist before any chain read', async () => {
    let reads = 0;
    const { service, deps } = makeService({
      commitments: {
        commitment: async () => {
          reads += 1;
          return COMMITMENT;
        },
      },
    });

    await refuse(
      service.redeem({ ...validRedeem(deps), productId: UNALLOWED }),
      /not authorized on this instance/,
    );
    expect(reads).toBe(0);
  });

  it('refuses a ring with no current commitment (a foreign or never-served ring)', async () => {
    const { service, deps } = makeService({ commitments: { commitment: async () => null } });
    // Named, not just "rejected": the operator detail is the only thing separating a
    // misconfigured collection (this case, the ring has no current root) from a
    // caller whose proof does not open. The wire deliberately shows the same 401 for both.
    await refuse(service.redeem(validRedeem(deps)), /membership proof rejected by all 1 configured collection\(s\): UnknownRing/);
  });

  it('refuses a proof that fails to open against the current commitment', async () => {
    const { service, deps } = makeService({
      validate: () => {
        throw new Error('verify failed');
      },
    });
    await refuse(service.redeem(validRedeem(deps)), /membership proof rejected by all 1 configured collection\(s\): NotMember/);
  });

  it('surfaces a chain transport failure distinctly, not as a caller mistake', async () => {
    const { service, deps } = makeService({
      commitments: {
        commitment: async () => {
          throw new Error('ws closed');
        },
      },
    });

    await expect(service.redeem(validRedeem(deps))).rejects.toThrow(/ws closed/);
  });

  it('re-derives the same alias on a re-redeem within TTL: the documented non-escalation', async () => {
    const { service, deps } = makeService();
    const body = validRedeem(deps);

    await service.redeem(body);
    const second = await service.redeem(body);

    // Nothing marks a challenge consumed; the proof binds the person, so re-redeeming re-mints
    // the SAME alias's token. The property to lock in is that the alias does not escalate to a
    // different one; a token that named a new alias would be the real escalation.
    const claims = await verifyToken(deps.tokenKey, second.token, [PRODUCT, OTHER]);
    expect(claims.sub).toBe(ALIAS);
  });
});

describe('verify()', () => {
  it('accepts a token minted for an allowed product and returns the proven subject', async () => {
    const { service, deps } = makeService();
    const token = await mintToken(deps.tokenKey, '0xalias', PRODUCT, 300);

    await expect(service.verify(token)).resolves.toEqual({ subject: '0xalias', productId: PRODUCT });
  });

  it('rejects a token whose audience is no longer allowed (revoked product)', async () => {
    const { service, deps } = makeService();
    const token = await mintToken(deps.tokenKey, '0xalias', UNALLOWED, 300);

    await refuse(service.verify(token));
  });

  it('rejects a token signed by a different key', async () => {
    const { service } = makeService();
    const { deps: otherDeps } = makeService();
    const token = await mintToken(otherDeps.tokenKey, '0xalias', PRODUCT, 300);

    await refuse(service.verify(token));
  });

  it('rejects a token that was tampered with after minting', async () => {
    const { service, deps } = makeService();
    const token = await mintToken(deps.tokenKey, '0xalias', PRODUCT, 300);

    // Flip the payload segment so the signature no longer covers it.
    const [header, payload, signature] = token.split('.');
    if (header === undefined || payload === undefined || signature === undefined) {
      throw new Error('token was not a JWT');
    }
    const tampered = `${header}.${payload.slice(0, -2)}XX.${signature}`;
    await refuse(service.verify(tampered));
  });

  it('rejects an expired token through the verify path, not just the token unit', async () => {
    const { service, deps } = makeService();
    const token = await mintToken(deps.tokenKey, '0xalias', PRODUCT, -10);

    await refuse(service.verify(token));
  });
});