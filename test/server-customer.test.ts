import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { u8aToHex, u8aWrapBytes } from '@polkadot/util';
import { sr25519PairFromSeed, sr25519Sign } from '@polkadot/util-crypto';

import { callerAuth } from '../src/auth.js';
import { callerGate } from '../src/caller.js';
import type { Config } from '../src/config.js';
import { CustomerAuth, customerGate, customerKeyHash, type CustomerKeys } from '../src/customer-auth.js';
import { PersonhoodService } from '../src/personhood.js';
import { mintChallenge } from '../src/personhood/challenge.js';
import { mintToken } from '../src/personhood/token.js';
import { MeldHttpError } from '../src/meld/client.js';
import { buildServer } from '../src/server.js';
import { CustomerService } from '../src/customer.js';
import type { HeadlessOrderResult } from '../src/meld/client.js';
import { Onramp, type HeadlessOrderPort } from '../src/onramp.js';
import {
  config,
  customerRow,
  fakeCustomerMeld,
  fakeStore,
  headlessConfig,
  orderRequest,
  personhoodConfig,
} from './fixtures.js';

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
  createOrder: async () => {
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

const stubWebhooks = {
  signatureFault: () => 'not under test',
  handle: async () => {
    throw new Error('not under test');
  },
};

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

const headless = (overrides: Record<string, unknown> = {}) => config({ ...headlessConfig(), ...overrides });

const serve = async (
  cfg: Config = headless(),
  options: {
    personhood?: PersonhoodService;
    sink?: { write: (line: string) => void };
    meld?: ReturnType<typeof fakeCustomerMeld>;
    store?: ReturnType<typeof fakeStore>;
    onramp?: Parameters<typeof buildServer>[1];
  } = {},
) => {
  const meld = options.meld ?? fakeCustomerMeld();
  const store = options.store ?? fakeStore();
  const instance = await buildServer(
    cfg,
    options.onramp ?? stubOnramp,
    options.personhood,
    options.sink,
    KEYS,
    (audit, log) => new CustomerService(cfg, meld, store, audit, log),
    stubWebhooks,
  );
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
 * limiter apply, and so the gate is tested apart from any one production route.
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

    const routes = [
      ['POST', '/customer/challenge'],
      ['POST', '/customer/token'],
      ['GET', '/customer'],
      ['POST', '/customer'],
      ['POST', '/customer/kyc'],
      ['POST', '/customer/details'],
      ['POST', '/customer/verifications'],
      ['POST', '/customer/verifications/confirm'],
      ['GET', '/requirements'],
      ['POST', '/order'],
      ['POST', '/webhooks/meld'],
    ] as const;
    for (const [method, url] of routes) {
      const response = await instance.inject({ method, url, headers: DEV, ...(method === 'POST' ? { payload: {} } : {}) });
      expect(response.statusCode).toBe(404);
      expect(response.json().error.value.code).toBe('NOT_FOUND');
    }
  });

  it('refuse to build when headless is enabled without the customer service', async () => {
    await expect(buildServer(headless(), stubOnramp, undefined, undefined, KEYS)).rejects.toThrow(/requires the customer service/);
  });

  it('refuse to build when headless is enabled without the webhook service', async () => {
    const cfg = headless();
    await expect(
      buildServer(cfg, stubOnramp, undefined, undefined, KEYS, (audit, log) =>
        new CustomerService(cfg, fakeCustomerMeld(), fakeStore(), audit, log),
      ),
    ).rejects.toThrow(/requires the webhook service/);
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

describe('customer routes', () => {
  const REGISTRATION = {
    firstName: 'Ada',
    lastName: 'Lovelace',
    email: 'ada@example.com',
    dateOfBirth: '1990-03-15',
    address: { lineOne: '1 Main St', lineTwo: 'Apt 2', city: 'Berlin', region: 'BE', postalCode: '10115', countryCode: 'DE' },
  };
  const REQUIREMENTS =
    '/requirements?provider=BANXA&paymentMethodType=CREDIT_DEBIT_CARD&country=DE&fiat=EUR&sourceAmount=101.20&destinationCurrencyCode=DOT_ASSETHUB';

  /** A server and a customer token for the test key, through the real A5 routes. */
  const signedIn = async (options: Parameters<typeof serve>[1] = {}, cfg: Config = headless()) => {
    const meld = options.meld ?? fakeCustomerMeld();
    const store = options.store ?? fakeStore();
    const instance = await serve(cfg, { ...options, meld, store });
    const { token } = (await tokenOf(instance)).json<{ token: string }>();
    const headers = { ...DEV, 'x-customer-token': token };
    return { instance, meld, store, headers };
  };

  it('register a customer once, then read it', async () => {
    const { instance, meld, store, headers } = await signedIn();
    meld.createCustomer.mockResolvedValueOnce({
      id: 'meld-customer-1',
      serviceProviderCustomers: [{ serviceProvider: 'SUMSUB', kyc: { status: 'PENDING' } }],
    });

    const before = await instance.inject({ method: 'GET', url: '/customer', headers });
    const created = await instance.inject({ method: 'POST', url: '/customer', headers, payload: REGISTRATION });
    const again = await instance.inject({ method: 'POST', url: '/customer', headers, payload: REGISTRATION });
    const after = await instance.inject({ method: 'GET', url: '/customer', headers });

    expect(before.json()).toEqual({ customer: null });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toEqual({ customer: { kyc: 'pending', providers: [] } });
    expect(store.customers.get(`app.dot|${customerKeyHash(pair.publicKey)}`)?.meld_customer_id).toBe('meld-customer-1');
    expect(again.statusCode).toBe(409);
    expect(again.json().error.value.code).toBe('CUSTOMER_EXISTS');
    expect(after.json()).toEqual({ customer: { kyc: 'none', providers: [] } });
    expect(meld.createCustomer).toHaveBeenCalledTimes(1);
  });

  it('let a key register again once Meld no longer knows its customer', async () => {
    const { instance, meld, headers } = await signedIn();
    await instance.inject({ method: 'POST', url: '/customer', headers, payload: REGISTRATION });
    meld.getCustomer.mockResolvedValueOnce(undefined);
    meld.createCustomer.mockResolvedValueOnce({ id: 'meld-customer-2', serviceProviderCustomers: [] });

    const read = await instance.inject({ method: 'GET', url: '/customer', headers });
    const registered = await instance.inject({ method: 'POST', url: '/customer', headers, payload: REGISTRATION });

    expect(read.json()).toEqual({ customer: null });
    expect(registered.statusCode).toBe(201);
  });

  it.each([
    ['an unexpected field', { ...REGISTRATION, phone: '+14155550123' }],
    ['an unreadable email', { ...REGISTRATION, email: 'ada' }],
    ['a birth date in the future', { ...REGISTRATION, dateOfBirth: '2999-01-01' }],
    ['an impossible birth date', { ...REGISTRATION, dateOfBirth: '1990-02-30' }],
    ['an address without a city', { ...REGISTRATION, address: { lineOne: '1 Main St', postalCode: '10115', countryCode: 'DE' } }],
    ['a blank name', { ...REGISTRATION, firstName: '   ' }],
  ])('refuse a registration with %s', async (_name, payload) => {
    const { instance, meld, headers } = await signedIn();

    const response = await instance.inject({ method: 'POST', url: '/customer', headers, payload });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.value.code).toBe('MALFORMED_REQUEST');
    expect(meld.createCustomer).not.toHaveBeenCalled();
  });

  it('require a customer token', async () => {
    const instance = await serve();

    const response = await instance.inject({ method: 'GET', url: '/customer', headers: DEV });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.value.code).toBe('CUSTOMER_TOKEN_INVALID');
  });

  it('start KYC, re-issuing the URL when Meld already started it', async () => {
    const { instance, meld, headers } = await signedIn();
    await instance.inject({ method: 'POST', url: '/customer', headers, payload: REGISTRATION });
    meld.initiateKyc.mockResolvedValueOnce({ outcome: 'already_shared' });

    const response = await instance.inject({ method: 'POST', url: '/customer/kyc', headers, payload: {} });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ url: 'https://kyc.example/verify/2' });
    expect(meld.refreshKyc).toHaveBeenCalledWith('meld-customer-1', { serviceProvider: 'SUMSUB', mode: 'HOSTED_URL' });
  });

  it('refuse KYC for a key with no customer', async () => {
    const { instance, headers } = await signedIn();

    const response = await instance.inject({ method: 'POST', url: '/customer/kyc', headers });

    expect(response.statusCode).toBe(404);
    expect(response.json().error).toEqual({
      tag: 'Other',
      value: { code: 'CUSTOMER_NOT_FOUND', message: 'No customer is registered for this key.' },
    });
  });

  it('answer requirements without a customer token, never ready', async () => {
    const { instance, meld } = await signedIn();

    const response = await instance.inject({ method: 'GET', url: REQUIREMENTS, headers: DEV });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      agreements: [{ type: 'TERMS_OF_SERVICE', url: 'https://provider.example/terms' }],
      verifications: [],
      missingFields: [],
      pending: false,
      blocked: false,
      ready: false,
    });
    expect(meld.requirements.mock.calls[0]?.[1]).not.toHaveProperty('customerId');
  });

  it('answer requirements for the stored customer when a token is sent', async () => {
    const { instance, meld, headers } = await signedIn();
    await instance.inject({ method: 'POST', url: '/customer', headers, payload: REGISTRATION });

    const response = await instance.inject({ method: 'GET', url: REQUIREMENTS, headers });

    expect(response.json().ready).toBe(true);
    expect(meld.requirements).toHaveBeenCalledWith('BANXA', {
      customerId: 'meld-customer-1',
      paymentMethodType: 'CREDIT_DEBIT_CARD',
      sourceCurrencyCode: 'EUR',
      sourceAmount: '101.20',
      destinationCurrencyCode: 'DOT_ASSETHUB',
      countryCode: 'DE',
      destinationNetworkCode: 'polkadot',
    });
  });

  it('refuse requirements with a customer token that is not valid', async () => {
    const { instance, meld } = await signedIn();

    const response = await instance.inject({
      method: 'GET',
      url: REQUIREMENTS,
      headers: { ...DEV, 'x-customer-token': 'not-a-token' },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.value.code).toBe('CUSTOMER_TOKEN_INVALID');
    expect(meld.requirements).not.toHaveBeenCalled();
  });

  it.each([
    ['an inexact amount', REQUIREMENTS.replace('101.20', '101.205')],
    ['a lowercase provider', REQUIREMENTS.replace('BANXA', 'banxa')],
    ['an unexpected parameter', `${REQUIREMENTS}&customerId=meld-customer-9`],
  ])('refuse a requirements query with %s', async (_name, url) => {
    const { instance } = await signedIn();

    const response = await instance.inject({ method: 'GET', url, headers: DEV });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.value.code).toBe('MALFORMED_REQUEST');
  });

  it('send provider details and answer 204', async () => {
    const { instance, meld, headers } = await signedIn();
    await instance.inject({ method: 'POST', url: '/customer', headers, payload: REGISTRATION });

    const response = await instance.inject({
      method: 'POST',
      url: '/customer/details',
      headers,
      payload: { provider: 'BANXA', fields: { occupation: 'Engineer', sourceOfFunds: 'Salary' } },
    });

    expect(response.statusCode).toBe(204);
    expect(response.body).toBe('');
    expect(meld.refreshKyc.mock.calls[0]?.[1]).toMatchObject({
      kycShareProviders: ['BANXA'],
      serviceProviderDetails: { occupation: 'Engineer', sourceOfFunds: 'Salary' },
    });
  });

  it.each([
    ['no fields', { provider: 'BANXA', fields: {} }],
    ['a field name that is not one', { provider: 'BANXA', fields: { 'source of funds': 'Salary' } }],
    ['a value that is not text', { provider: 'BANXA', fields: { occupation: 3 } }],
  ])('refuse provider details with %s', async (_name, payload) => {
    const { instance, headers } = await signedIn();

    const response = await instance.inject({ method: 'POST', url: '/customer/details', headers, payload });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.value.code).toBe('MALFORMED_REQUEST');
  });

  it('start a verification', async () => {
    const { instance, headers } = await signedIn();
    await instance.inject({ method: 'POST', url: '/customer', headers, payload: REGISTRATION });

    const response = await instance.inject({
      method: 'POST',
      url: '/customer/verifications',
      headers,
      payload: { channel: 'PHONE', target: '+14155550123' },
    });

    expect(response.json()).toEqual({
      verificationId: 'verification-1',
      expiresAt: '2026-08-25T02:57:26Z',
      resendAvailableAt: '2026-08-25T02:47:56Z',
    });
  });

  it('refuse a verification during a cooldown with the time it lifts', async () => {
    const { instance, meld, headers } = await signedIn();
    await instance.inject({ method: 'POST', url: '/customer', headers, payload: REGISTRATION });
    meld.startVerification.mockResolvedValueOnce({ outcome: 'cooldown', resendAvailableAt: '2026-08-25T02:47:56Z' });

    const response = await instance.inject({
      method: 'POST',
      url: '/customer/verifications',
      headers,
      payload: { channel: 'EMAIL', target: 'ada@example.com' },
    });

    expect(response.statusCode).toBe(429);
    expect(response.json()).toEqual({
      error: {
        tag: 'Other',
        value: {
          code: 'VERIFICATION_COOLDOWN',
          message: 'A code was sent recently. Wait before asking for another.',
          resendAvailableAt: '2026-08-25T02:47:56Z',
        },
      },
      request_id: expect.any(String),
    });
  });

  it.each([
    ['a phone number with spacing', { channel: 'PHONE', target: '+1 415 555 0123' }],
    ['an email on the phone channel', { channel: 'PHONE', target: 'ada@example.com' }],
    ['an unknown channel', { channel: 'SMS', target: '+14155550123' }],
  ])('refuse a verification request with %s', async (_name, payload) => {
    const { instance, headers } = await signedIn();

    const response = await instance.inject({ method: 'POST', url: '/customer/verifications', headers, payload });

    expect(response.statusCode).toBe(400);
  });

  it('confirm a code, answering FAILED with the attempts left', async () => {
    const { instance, meld, headers } = await signedIn();
    await instance.inject({ method: 'POST', url: '/customer', headers, payload: REGISTRATION });
    meld.confirmVerification.mockResolvedValueOnce({ status: 'FAILED', attemptsRemaining: 2 });

    const response = await instance.inject({
      method: 'POST',
      url: '/customer/verifications/confirm',
      headers,
      payload: { verificationId: 'verification-1', code: '316856' },
    });

    expect(response.json()).toEqual({ status: 'FAILED', attemptsRemaining: 2 });
  });

  it('refuse a code that is not digits', async () => {
    const { instance, headers } = await signedIn();

    const response = await instance.inject({
      method: 'POST',
      url: '/customer/verifications/confirm',
      headers,
      payload: { verificationId: 'verification-1', code: '31a856' },
    });

    expect(response.statusCode).toBe(400);
  });

  it('write no personal data to the log, on success or on a Meld failure', async () => {
    const lines: string[] = [];
    const cfg = headless({ server: { port: 8080, host: '127.0.0.1', log_level: 'debug' } });
    const { instance, meld, headers } = await signedIn({ sink: { write: (line) => lines.push(line) } }, cfg);
    const phone = '+14155550123';
    const code = '316856';

    await instance.inject({ method: 'POST', url: '/customer', headers, payload: REGISTRATION });
    await instance.inject({ method: 'POST', url: '/customer/verifications', headers, payload: { channel: 'PHONE', target: phone } });
    await instance.inject({ method: 'POST', url: '/customer/verifications/confirm', headers, payload: { verificationId: 'verification-1', code } });

    meld.startVerification.mockRejectedValueOnce(new MeldHttpError(400, 'BAD_REQUEST', `target ${phone} is not mobile`));
    meld.confirmVerification.mockRejectedValueOnce(new MeldHttpError(400, 'BAD_REQUEST', `code ${code} expired`));
    meld.createCustomer.mockRejectedValueOnce(
      new MeldHttpError(500, 'SERVICE_PROVIDER_ERROR', `Ada Lovelace ada@example.com 1990-03-15 1 Main St`, 'Berlin 10115'),
    );
    const failed = [
      await instance.inject({ method: 'POST', url: '/customer/verifications', headers, payload: { channel: 'PHONE', target: phone } }),
      await instance.inject({ method: 'POST', url: '/customer/verifications/confirm', headers, payload: { verificationId: 'verification-1', code } }),
    ];
    const other = await signedIn({ sink: { write: (line) => lines.push(line) }, meld }, cfg);
    failed.push(await other.instance.inject({ method: 'POST', url: '/customer', headers: other.headers, payload: REGISTRATION }));
    failed.push(
      await instance.inject({ method: 'POST', url: '/customer', headers, payload: { ...REGISTRATION, email: 'not-an-email@' } }),
    );

    expect(failed.map((r) => r.statusCode)).toEqual([400, 400, 503, 400]);
    // Without the fields every line carries, so a digit run in a timestamp or an id cannot match a postal code.
    const logged = lines
      .map((line) => {
        const fields = JSON.parse(line) as Record<string, unknown>;
        for (const key of ['time', 'pid', 'reqId', 'requestId']) Reflect.deleteProperty(fields, key);
        return JSON.stringify(fields);
      })
      .join('\n');
    expect(logged).toContain('request refused');
    for (const pii of ['Ada', 'Lovelace', 'ada@example.com', 'not-an-email', '1990-03-15', '1 Main St', 'Apt 2', 'Berlin', '10115', phone, '4155550123', code]) {
      expect(logged).not.toContain(pii);
    }
  });
});

describe('the order route', () => {
  /** Meld's card order, with a fee as a JSON number and a credential scoped to the order. */
  const CARD_RAW = {
    id: 'order-1',
    paymentMethodType: 'CREDIT_DEBIT_CARD',
    paymentMethodResponseDetails: { renderMode: 'SDK_NATIVE', sessionToken: 'tok_order_scoped_secret' },
    payload: { sourceAmount: 25.5, fees: { total: 1.25 } },
  };
  const BUYER_IP = '203.0.113.24';
  const IBAN = 'DE89370400440532013000';

  const card = async (): Promise<HeadlessOrderResult> => ({
    outcome: 'created',
    order: {
      id: 'order-1',
      paymentMethodType: 'CREDIT_DEBIT_CARD',
      paymentMethodResponseDetails: CARD_RAW.paymentMethodResponseDetails,
      raw: structuredClone(CARD_RAW),
    },
  });
  const bank = (details: unknown) => async (): Promise<HeadlessOrderResult> => ({
    outcome: 'created',
    order: { id: 'order-2', paymentMethodType: 'SEPA', paymentMethodResponseDetails: details, raw: { id: 'order-2' } },
  });
  const SEPA = {
    amount: '25.00',
    currency: 'USD',
    expiresAt: '2999-01-01T00:00:00Z',
    receivingBankInformation: { iban: IBAN, bic: 'COBADEFFXXX', accountHolderName: 'Meld Virtual Account' },
    serviceProviderDetails: { memo: 'MELD-REF-1' },
  };

  /** A real `Onramp` behind the route, with the order call faked and the caller's customer stored. */
  const ordering = async (
    place: () => Promise<HeadlessOrderResult> = card,
    overrides: Record<string, unknown> = {},
    sink?: { write: (line: string) => void },
  ) => {
    const cfg = headless({
      // The injected request arrives from 127.0.0.1, standing in for the ingress.
      server: {
        port: 8080,
        host: '127.0.0.1',
        log_level: sink === undefined ? 'silent' : 'debug',
        trusted_proxy_cidrs: ['127.0.0.1/32'],
      },
      ...overrides,
    });
    const store = fakeStore();
    store.customers.set(`app.dot|${customerKeyHash(pair.publicKey)}`, customerRow({ customer_key_hash: customerKeyHash(pair.publicKey) }));
    const orders = { createHeadlessOrder: vi.fn<HeadlessOrderPort['createHeadlessOrder']>(place) };
    const rail = {
      provider: 'meld' as const,
      quote: async () => [],
      createSession: () => Promise.reject(new Error('not under test')),
      transaction: async (id: string) => ({ id }),
    };
    const instance = await serve(cfg, {
      store,
      ...(sink === undefined ? {} : { sink }),
      onramp: (audit) => new Onramp(cfg, { meld: rail }, audit, store, rail, Date.now, () => crypto.randomUUID(), undefined, orders),
    });
    const { token } = (await tokenOf(instance)).json<{ token: string }>();
    const headers = { ...DEV, 'x-customer-token': token, 'x-forwarded-for': BUYER_IP };
    const post = (payload: Record<string, unknown> = orderRequest()) =>
      instance.inject({ method: 'POST', url: '/order', headers, payload });
    return { instance, store, orders, headers, post };
  };

  it('answers a card order with Meld body verbatim, numbers as numbers', async () => {
    const { orders, post } = await ordering();

    const response = await post();

    expect(response.statusCode).toBe(201);
    const body = response.json<{ fundingRequestId: string; kind: string; order: typeof CARD_RAW }>();
    expect(body.kind).toBe('card');
    expect(body.order).toEqual(CARD_RAW);
    expect(response.body).toContain('"sourceAmount":25.5');
    expect(response.body).toContain('"total":1.25');
    expect(orders.createHeadlessOrder.mock.calls[0]?.[0]).toMatchObject({
      customerId: 'meld-customer-1',
      externalOrderId: body.fundingRequestId,
      clientIpAddress: BUYER_IP,
    });
  });

  it('answers a bank order with its details, serves them from the funding read, and replays them', async () => {
    const { instance, orders, headers, post } = await ordering(bank(SEPA));

    const created = await post(orderRequest({ paymentMethodType: 'SEPA' }));
    const { fundingRequestId, instructions } = created.json<{ fundingRequestId: string; instructions: unknown }>();
    const read = await instance.inject({ method: 'GET', url: `/funding/${fundingRequestId}`, headers });
    const replayed = await post(orderRequest({ paymentMethodType: 'SEPA' }));

    expect(created.statusCode).toBe(201);
    expect(instructions).toEqual({
      rail: 'SEPA',
      amount: '25.00',
      currency: 'USD',
      accountHolderName: 'Meld Virtual Account',
      iban: IBAN,
      bic: 'COBADEFFXXX',
      reference: 'MELD-REF-1',
      expiresAt: Date.parse('2999-01-01T00:00:00Z'),
    });
    expect(read.json().funding).toMatchObject({ integrationMode: 'headless', status: 'session_opened', paymentInstructions: instructions });
    expect(replayed.statusCode).toBe(201);
    expect(replayed.json()).toEqual(created.json());
    expect(orders.createHeadlessOrder).toHaveBeenCalledTimes(1);
  });

  it('answers a card replay with REQUEST_SURFACE_EXPIRED', async () => {
    const { post } = await ordering();
    const first = await post();

    const again = await post();

    expect(again.statusCode).toBe(409);
    expect(again.json().error.value).toMatchObject({
      code: 'REQUEST_SURFACE_EXPIRED',
      fundingRequestId: first.json<{ fundingRequestId: string }>().fundingRequestId,
    });
  });

  it('maps a customer the provider will not take yet to 403 CUSTOMER_NOT_READY', async () => {
    const { post } = await ordering(async () => ({ outcome: 'customer_not_ready', code: 'KYC_NOT_COMPLETED' }));

    const response = await post();

    expect(response.statusCode).toBe(403);
    expect(response.json().error.value.code).toBe('CUSTOMER_NOT_READY');
  });

  it('answers a Meld refusal that created no order with 422 PROVIDER_REJECTED', async () => {
    const { post } = await ordering(() => Promise.reject(new MeldHttpError(403, 'WHITELABEL_NOT_ENABLED', 'no')));

    const response = await post();

    expect(response.statusCode).toBe(422);
    expect(response.json().error).toEqual({
      tag: 'Other',
      value: { code: 'PROVIDER_REJECTED', message: 'The provider declined this request.' },
    });
  });

  it.each([
    ['a redirect URL', { redirectUrl: 'https://app.example/done' }],
    ['a direction', { direction: 'buy' }],
    ['no terms time', { termsAcceptedAt: undefined }],
    ['a lower-case provider code', { serviceProvider: 'banxa' }],
  ])('refuses a body with %s', async (_name, override) => {
    const { orders, post } = await ordering();

    const response = await post(orderRequest(override));

    expect(response.statusCode).toBe(400);
    expect(response.json().error.value.code).toBe('MALFORMED_REQUEST');
    expect(orders.createHeadlessOrder).not.toHaveBeenCalled();
  });

  it('requires a customer token', async () => {
    const { instance } = await ordering();

    const response = await instance.inject({ method: 'POST', url: '/order', headers: DEV, payload: orderRequest() });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.value.code).toBe('CUSTOMER_TOKEN_INVALID');
  });

  it('writes neither the order body nor the buyer IP to the log, and names only the keys of unreadable details', async () => {
    const lines: string[] = [];
    const sink = { write: (line: string) => lines.push(line) };
    const { post } = await ordering(card, {}, sink);
    expect((await post()).statusCode).toBe(201);
    const unreadable = await ordering(bank({ receivingBankInformation: { iban: IBAN }, total: '25.00' }), {}, sink);

    const refused = await unreadable.post(orderRequest({ paymentMethodType: 'SEPA' }));

    expect(refused.statusCode).toBe(502);
    expect(refused.json().error).toEqual({
      tag: 'Other',
      value: { code: 'BANK_DETAILS_UNREADABLE', message: 'The bank transfer details could not be read.' },
    });
    const logged = lines.join('\n');
    expect(logged).toContain('order created');
    expect(logged).toContain('receivingBankInformation.iban');
    for (const secret of ['tok_order_scoped_secret', 'SDK_NATIVE', IBAN, BUYER_IP]) {
      expect(logged).not.toContain(secret);
    }
  });
});
