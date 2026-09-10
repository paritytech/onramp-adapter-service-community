import type { FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';

import { callerAuth } from '../src/auth.js';
import { Refusal } from '../src/contract.js';
import { PersonhoodService, type PersonhoodDeps } from '../src/personhood.js';
import { mintToken } from '../src/personhood/token.js';
import { config, personhoodConfig } from './fixtures.js';

const request = (headers: Record<string, string>) => ({ headers }) as unknown as FastifyRequest;

/** The wire shape every personhood refusal must carry: one stable 401 vocabulary. */
const expectRefusal = async (p: Promise<unknown>) => {
  const error = await p.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(Refusal);
  expect((error as Refusal).status).toBe(401);
  expect((error as Refusal).failure).toEqual({ tag: 'Other', value: { code: 'UNAUTHORIZED', message: 'Not authorized.' } });
};

/** A live PersonhoodService with a real token key, so the bearer-token verifier runs end to end. */
function liveService(): { service: PersonhoodService; tokenKey: Uint8Array } {
  const tokenKey = new Uint8Array(32).fill(6);
  const deps: PersonhoodDeps = {
    validate: () => new Uint8Array(32),
    commitments: { commitment: async () => null },
    challengeKey: new Uint8Array(32).fill(6),
    tokenKey: { secret: tokenKey },
    challengeTtlMs: 60_000,
    tokenTtlSeconds: 300,
    rings: [{ identifier: '0x' + '22'.repeat(32), exponent: 9 }],
    allowedProducts: ['app.dot'],
  };
  return { service: new PersonhoodService(deps), tokenKey };
}

const PRODUCT = 'app.dot';

describe('callerAuth', () => {
  it('refuses to build a personhood verifier without a provider, at boot not per request', () => {
    // Throws at construction, which is at boot, so a mis-configured mode cannot surface as
    // a 500 on a buyer's first request. Degrading to an unverified mode would make the
    // absence of personhood verification look exactly like its presence.
    expect(() => callerAuth(config(personhoodConfig()), { personhood: undefined })).toThrow(
      /personhood mode requires a personhood provider/,
    );
  });

  describe('insecure_dev', () => {
    const authenticate = callerAuth(config(), { personhood: undefined });

    it('accepts an allowlisted product and derives a subject from it', async () => {
      expect(await authenticate(request({ 'x-dev-product-id': 'app.dot' }))).toEqual({
        productId: 'app.dot',
        alias: 'dev:app.dot',
        // Not a person: one alias for every caller of the product, which is why the rate limit
        // refuses to key on it. See src/caller.ts.
        proven: false,
      });
    });

    it.each([
      ['a product that is not allowlisted', { 'x-dev-product-id': 'other.dot' }],
      ['no product header at all', {}],
      ['an empty product header', { 'x-dev-product-id': '' }],
      // A duplicated header arrives as an array, which is ordinary HTTP. `includes` alone
      // already rejects it; the `typeof` check narrows the value to a `string` for
      // `Subject.productId`, which is a compile-time job, not a second runtime gate.
      ['a duplicated product header', { 'x-dev-product-id': ['app.dot', 'app.dot'] as unknown as string }],
    ])('refuses %s', async (_label, headers) => {
      await expect(authenticate(request(headers))).rejects.toThrow(Refusal);
    });

    it('closes rather than opens when the allowlist is empty', async () => {
      const closed = callerAuth(config({ allowed_products: [] }), { personhood: undefined });
      await expect(closed(request({ 'x-dev-product-id': 'app.dot' }))).rejects.toThrow(Refusal);
    });
  });

  describe('personhood', () => {
    const authenticate = () => {
      const { service } = liveService();
      return callerAuth(config(personhoodConfig()), { personhood: service });
    };

    it('returns the subject a real token carries', async () => {
      const { tokenKey } = liveService();
      const token = await mintToken({ secret: tokenKey }, '0xalias', PRODUCT, 300);

      await expect(authenticate()(request({ authorization: `Bearer ${token}` }))).resolves.toEqual({
        productId: PRODUCT,
        alias: '0xalias',
        proven: true,
      });
    });

    it('names the reason when the Authorization header is missing', async () => {
      const error = await authenticate()(request({})).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Refusal);
      expect((error as Error).message).toBe('Missing Authorization header.');
      expect((error as Refusal).status).toBe(401);
      expect((error as Refusal).failure).toEqual({
        tag: 'Other',
        value: { code: 'UNAUTHORIZED', message: 'Not authorized.' },
      });
    });

    it('names the reason when the Authorization header is not a bearer token', async () => {
      const error = await authenticate()(request({ authorization: 'Basic dXNlcjpwYXNz' })).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Refusal);
      expect((error as Error).message).toBe('Malformed Authorization header.');
      expect((error as Refusal).status).toBe(401);
      expect((error as Refusal).failure).toEqual({
        tag: 'Other',
        value: { code: 'UNAUTHORIZED', message: 'Not authorized.' },
      });
    });

it.each([
      // `Bearer` with no space: the scheme needs the separating whitespace.
      ['no whitespace after the scheme', 'Bearer' + 'eyJhbGciOiJIUzI1NiJ9.'.repeat(4)],
      // A different scheme prefix: only `Bearer` opens the gate.
      ['a foreign scheme', 'Mac azQ4MDE2OWE5'],
    ])('refuses an Authorization header with %s as malformed', async (_label, authorization) => {
      await expect(authenticate()(request({ authorization }))).rejects.toThrow('Malformed Authorization header.');
    });

it('refuses trailing junk after the token as a bad token, not a malformed header', async () => {
      // The header regex captures the whole rest of the line; the garbage rides along into the
      // token, which then fails JWT verification: an inauthentic token, not a malformed header.
      await expect(authenticate()(request({ authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9. extra' }))).rejects.toThrow(
        'token rejected.',
      );
    });

    it('tolerates padding around the scheme, trimming the header before parsing', async () => {
      // HTTP intermediaries may pad; a header that parses once trimmed is a good header. Without
      // the trim, the leading space would push the `^Bearer` anchor off the line.
      const { tokenKey } = liveService();
      const token = await mintToken({ secret: tokenKey }, '0xalias', PRODUCT, 300);
      await expect(authenticate()(request({ authorization: `   Bearer ${token}   ` }))).resolves.toEqual({
        productId: PRODUCT,
        alias: '0xalias',
        proven: true,
      });
    });

    it('refuses a header whose scheme is preceded by other text', async () => {
      // The scheme must anchor the line; a scheme that floats mid-header must not open the gate.
      const { tokenKey } = liveService();
      const token = await mintToken({ secret: tokenKey }, '0xalias', PRODUCT, 300);
      await expect(authenticate()(request({ authorization: `xBearer ${token}` }))).rejects.toThrow(
        'Malformed Authorization header.',
      );
    });

    it('refuses a token the service did not mint, with the stable 401 shape', async () => {
      const other = new Uint8Array(32).fill(9); // not this service's signing key
      const token = await mintToken({ secret: other }, '0xalias', PRODUCT, 300);

      await expectRefusal(authenticate()(request({ authorization: `Bearer ${token}` })));
    });
  });
});
