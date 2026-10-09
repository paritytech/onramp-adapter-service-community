import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { u8aToHex, u8aWrapBytes } from '@polkadot/util';
import { sr25519PairFromSeed, sr25519Sign } from '@polkadot/util-crypto';

import { callerAuth } from '../src/auth.js';
import { callerGate } from '../src/caller.js';
import type { Config } from '../src/config.js';
import { CustomerAuth, customerGate, customerKeyHash, type CustomerKeys } from '../src/customer-auth.js';
import { PersonhoodService } from '../src/personhood.js';
import { mintChallenge } from '../src/personhood/challenge.js';
import { mintToken } from '../src/personhood/token.js';
import { buildServer } from '../src/server.js';
import { config, headlessConfig, personhoodConfig } from './fixtures.js';

const KEYS: CustomerKeys = {
  customerChallengeKey: new Uint8Array(32).fill(3),
  customerTokenKey: new Uint8Array(32).fill(4),
};
const DEV = { 'x-dev-product-id': 'app.dot' };
const pair = sr25519PairFromSeed(new Uint8Array(32).fill(7));
const PUBLIC_KEY = u8aToHex(pair.publicKey);

const fromWire = (s: string) => new Uint8Array(Buffer.from(s, 'base64url'));
const proofFor = (challenge: string, message: Uint8Array = fromWire(challenge)) => ({
  publicKey: PUBLIC_KEY,
  challenge,
  signature: u8aToHex(sr25519Sign(message, pair)),
});

const stubOnramp = () => ({
  createSession: async () => {
    throw new Error('not under test');
  },
  quote: async () => {
    throw new Error('not under test');
  },
  supported: async () => ({ country: 'US', fiat: 'USD', crypto: 'DOT_ASSETHUB', methods: [] }),
  supportedCountries: async () => [],
  supportedCorridors: async () => [],
  transaction: async () => ({ transaction: {} }),
  cancel: async () => undefined,
  get: async () => undefined,
  list: async () => [],
});

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

const headless = (overrides: Record<string, unknown> = {}) => config({ ...headlessConfig(), ...overrides });

const serve = async (
  cfg: Config = headless(),
  options: { personhood?: PersonhoodService; sink?: { write: (line: string) => void } } = {},
) => {
  const instance = await buildServer(cfg, stubOnramp, options.personhood, options.sink, KEYS);
  app = instance;
  return instance;
};

const challengeOf = async (instance: FastifyInstance, headers: Record<string, string> = DEV) =>
  (await instance.inject({ method: 'POST', url: '/customer/challenge', headers, payload: {} })).json<{ challenge: string }>()
    .challenge;

const tokenOf = async (instance: FastifyInstance, headers: Record<string, string> = DEV) =>
  instance.inject({
    method: 'POST',
    url: '/customer/token',
    headers,
    payload: proofFor(await challengeOf(instance, headers)),
  });

/**
 * A route behind `asCustomer`, registered by the test on the real server so its error handler and
 * limiter apply. No production route consumes the helper yet.
 */
const withProbe = (instance: FastifyInstance, cfg: Config, personhood?: PersonhoodService) => {
  const gate = callerGate(callerAuth(cfg, { personhood }));
  const { asCustomer, customerKeyHashOf } = customerGate(new CustomerAuth(KEYS, { challengeTtlMs: 120_000, tokenTtlSeconds: 600 }), gate);
  instance.get('/probe', asCustomer, async (request) => ({ customerKeyHash: customerKeyHashOf(request) }));
  instance.get('/unguarded', { onRequest: gate.identify, preHandler: gate.enforce }, async (request) => ({
    customerKeyHash: customerKeyHashOf(request),
  }));
  return instance;
};

describe('customer key routes', () => {
  it('do not exist when headless is disabled', async () => {
    const instance = await buildServer(config(), stubOnramp, undefined, undefined, KEYS);
    app = instance;

    for (const url of ['/customer/challenge', '/customer/token']) {
      const response = await instance.inject({ method: 'POST', url, headers: DEV, payload: {} });
      expect(response.statusCode).toBe(404);
      expect(response.json().error.value.code).toBe('NOT_FOUND');
    }
  });

  it('refuse to build when headless is enabled without the keys', async () => {
    await expect(buildServer(headless(), stubOnramp)).rejects.toThrow(/requires the customer block and its keys/);
  });

  it('exchange a raw-bytes signature over a fresh challenge for a customer token', async () => {
    const instance = await serve();

    const challenge = await challengeOf(instance);
    expect(fromWire(challenge)).toHaveLength(56);

    const response = await instance.inject({ method: 'POST', url: '/customer/token', headers: DEV, payload: proofFor(challenge) });

    expect(response.statusCode).toBe(200);
    const { token, expiresAtMs } = response.json<{ token: string; expiresAtMs: number }>();
    expect(token.split('.')).toHaveLength(3);
    expect(expiresAtMs).toBeGreaterThan(Date.now());
  });

  it('require caller auth on both routes', async () => {
    const instance = await serve();

    const challenge = await instance.inject({ method: 'POST', url: '/customer/challenge', payload: {} });
    const token = await instance.inject({
      method: 'POST',
      url: '/customer/token',
      payload: proofFor(await challengeOf(instance)),
    });

    expect(challenge.statusCode).toBe(401);
    expect(challenge.json().error.value.code).toBe('UNAUTHORIZED');
    expect(token.statusCode).toBe(401);
    expect(token.json().error.value.code).toBe('UNAUTHORIZED');
  });

  it('refuse a signature over the <Bytes>-wrapped challenge', async () => {
    const instance = await serve();
    const challenge = await challengeOf(instance);

    const response = await instance.inject({
      method: 'POST',
      url: '/customer/token',
      headers: DEV,
      payload: proofFor(challenge, u8aWrapBytes(fromWire(challenge))),
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error).toEqual({
      tag: 'Other',
      value: { code: 'CUSTOMER_PROOF_INVALID', message: 'The customer key proof was not accepted.' },
    });
  });

  it('refuse a challenge older than customer.challenge_ttl_s', async () => {
    const instance = await serve();
    const stale = Buffer.from(mintChallenge(KEYS.customerChallengeKey, { issuedAtMillis: Date.now() - 121_000 })).toString('base64url');

    const response = await instance.inject({ method: 'POST', url: '/customer/token', headers: DEV, payload: proofFor(stale) });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.value.code).toBe('CUSTOMER_PROOF_INVALID');
  });

  it.each([
    ['an unexpected field', { extra: 1 }],
    ['a short public key', { publicKey: '0x' + 'ab'.repeat(31) }],
    ['an unprefixed signature', { signature: 'ab'.repeat(64) }],
  ])('refuse a body with %s as malformed', async (_name, override) => {
    const instance = await serve();
    const payload = { ...proofFor(await challengeOf(instance)), ...override };

    const response = await instance.inject({ method: 'POST', url: '/customer/token', headers: DEV, payload });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.value.code).toBe('MALFORMED_REQUEST');
  });

  it('are rate limited like every other caller route', async () => {
    const instance = await serve(headless({ rate_limit: { per_person_max: 1, per_address_max: 1, window_seconds: 60 } }));

    expect((await instance.inject({ method: 'POST', url: '/customer/challenge', headers: DEV })).statusCode).toBe(200);
    const limited = await instance.inject({ method: 'POST', url: '/customer/token', headers: DEV, payload: {} });

    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.value.code).toBe('RATE_LIMITED');
  });

  it('never write the public key to the log', async () => {
    const lines: string[] = [];
    const instance = await serve(headless({ server: { port: 8080, host: '127.0.0.1', log_level: 'debug' } }), {
      sink: { write: (line) => lines.push(line) },
    });

    expect((await tokenOf(instance)).statusCode).toBe(200);
    const refused = await instance.inject({
      method: 'POST',
      url: '/customer/token',
      headers: DEV,
      payload: { ...proofFor(await challengeOf(instance)), signature: '0x' + '00'.repeat(64) },
    });
    expect(refused.statusCode).toBe(401);

    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('\n')).toContain('request refused');
    expect(lines.join('\n').toLowerCase()).not.toContain(PUBLIC_KEY.slice(2));
  });
});

describe('asCustomer', () => {
  const probe = (instance: FastifyInstance, headers: Record<string, string>) =>
    instance.inject({ method: 'GET', url: '/probe', headers });

  it('exposes the key hash of a valid token for this caller', async () => {
    const cfg = headless();
    const instance = withProbe(await serve(cfg), cfg);
    const { token } = (await tokenOf(instance)).json<{ token: string }>();

    const response = await probe(instance, { ...DEV, 'x-customer-token': token });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ customerKeyHash: customerKeyHash(pair.publicKey) });
  });

  it('refuses a request without a customer token', async () => {
    const cfg = headless();
    const instance = withProbe(await serve(cfg), cfg);

    const response = await probe(instance, DEV);

    expect(response.statusCode).toBe(401);
    expect(response.json().error).toEqual({
      tag: 'Other',
      value: { code: 'CUSTOMER_TOKEN_INVALID', message: 'The customer token was not accepted.' },
    });
  });

  it('answers the caller refusal first when caller auth fails', async () => {
    const cfg = headless();
    const instance = withProbe(await serve(cfg), cfg);
    const { token } = (await tokenOf(instance)).json<{ token: string }>();

    const response = await probe(instance, { 'x-customer-token': token });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.value.code).toBe('UNAUTHORIZED');
  });

  it('refuses a token minted for another product', async () => {
    const cfg = headless({ allowed_products: ['app.dot', 'other.dot'] });
    const instance = withProbe(await serve(cfg), cfg);
    const { token } = (await tokenOf(instance, { 'x-dev-product-id': 'other.dot' })).json<{ token: string }>();

    const response = await probe(instance, { ...DEV, 'x-customer-token': token });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.value.code).toBe('CUSTOMER_TOKEN_INVALID');
  });

  it('refuses a token bound to another person in the same product', async () => {
    const jwtKey = { secret: new Uint8Array(32).fill(5) };
    const personhood = new PersonhoodService({
      validate: () => new Uint8Array(32),
      commitments: { commitment: async () => '0x' },
      challengeKey: new Uint8Array(32).fill(6),
      tokenKey: jwtKey,
      challengeTtlMs: 60_000,
      tokenTtlSeconds: 300,
      rings: [],
      allowedProducts: ['app.dot'],
    });
    const { meld, customer } = headlessConfig() as { meld: Record<string, unknown>; customer: unknown };
    const cfg = config(personhoodConfig({ meld: { ...meld, api_key: { mode: 'file', path: '/run/secrets/meld-api-key' } }, customer }));
    const instance = withProbe(await serve(cfg, { personhood }), cfg, personhood);
    const bearer = async (alias: string) => ({ authorization: `Bearer ${await mintToken(jwtKey, alias, 'app.dot', 300)}` });

    const { token } = (await tokenOf(instance, await bearer('0xada'))).json<{ token: string }>();
    const own = await probe(instance, { ...(await bearer('0xada')), 'x-customer-token': token });
    const borrowed = await probe(instance, { ...(await bearer('0xgrace')), 'x-customer-token': token });

    expect(own.statusCode).toBe(200);
    expect(borrowed.statusCode).toBe(401);
    expect(borrowed.json().error.value.code).toBe('CUSTOMER_TOKEN_INVALID');
  });

  it('refuses an expired token', async () => {
    const cfg = headless();
    const instance = withProbe(await serve(cfg), cfg);
    const past = new CustomerAuth(KEYS, { challengeTtlMs: 120_000, tokenTtlSeconds: 600 }, () => Date.now() - 601_000);
    const { token } = await past.issueToken(
      { productId: 'app.dot', alias: 'dev:app.dot', proven: false },
      proofFor(past.challenge().challenge),
    );

    const response = await probe(instance, { ...DEV, 'x-customer-token': token });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.value.code).toBe('CUSTOMER_TOKEN_INVALID');
  });

  it('fails closed when a route reads the key hash without asCustomer', async () => {
    const cfg = headless();
    const instance = withProbe(await serve(cfg), cfg);

    const response = await instance.inject({ method: 'GET', url: '/unguarded', headers: DEV });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.value.code).toBe('CUSTOMER_TOKEN_INVALID');
  });
});
