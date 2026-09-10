import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { PersonhoodService, type PersonhoodDeps } from '../src/personhood.js';
import { mintToken } from '../src/personhood/token.js';
import { buildServer } from '../src/server.js';
import { config, createRequest, personhoodConfig, quoteRequestBody } from './fixtures.js';

const IDENTIFIER = '0x' + '22'.repeat(32);
const COMMITMENT = '0x' + '11'.repeat(768);
const PRODUCT = 'app.dot';

/** A fully-functional PersonhoodService with stub chain reads. */
const TOKEN_KEY = new Uint8Array(32).fill(5);

function makeHandshake(): { service: PersonhoodService } {
  const challengeKey = new Uint8Array(32).fill(4);
  const deps: PersonhoodDeps = {
    validate: () => new Uint8Array(32),
    commitments: { commitment: async () => COMMITMENT },
    challengeKey,
    tokenKey: { secret: TOKEN_KEY },
    challengeTtlMs: 60_000,
    tokenTtlSeconds: 300,
    rings: [{ identifier: IDENTIFIER, exponent: 9 }],
    allowedProducts: [PRODUCT],
  };
  return { service: new PersonhoodService(deps) };
}

const wire = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('personhood handshake routes', () => {

  it('does not register the handshake routes at all in insecure_dev', async () => {
    // Defended only by e2e until now, so anyone running `npm test` alone could delete the guard
    // and see nothing. The routes exist only when a PersonhoodService was built; in insecure_dev
    // none is, and a caller must get the same 404 as for any unknown path, not a 500 from a
    // handler reaching for a service that is not there.
    const app = await buildServer(config(), () => stubOnramp());

    for (const url of ['/api/v1/auth/challenge', '/api/v1/auth/redeem']) {
      const response = await app.inject({ method: 'POST', url, payload: {} });
      expect(response.statusCode).toBe(404);
      expect(response.json().error.value.code).toBe('NOT_FOUND');
    }
    await app.close();
  });
  it('serves challenge and redeems a valid proof into a bearer token', async () => {
    const { service } = makeHandshake();
    app = await buildServer(config(personhoodConfig()), () => ({
      ...stubOnramp(),
    }), service);

    // 1. mint a challenge
    const challengeResponse = await app.inject({ method: 'POST', url: '/api/v1/auth/challenge' });
    expect(challengeResponse.statusCode).toBe(200);
    const { challenge } = challengeResponse.json<{ challenge: string }>();

    // 2. redeem it with a (stubbed) proof
    const redeemResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/redeem',
      payload: { challenge, proof: wire(new Uint8Array([1, 2, 3])), ring: 0, productId: PRODUCT },
    });
    expect(redeemResponse.statusCode).toBe(200);
    const { token, expiresAtMs } = redeemResponse.json<{ token: string; expiresAtMs: number }>();
    expect(token.split('.')).toHaveLength(3);
    expect(expiresAtMs).toBeGreaterThan(Date.now());

    // 3. the minted token authorizes a protected route
    const sessionResponse = await app.inject({
      method: 'POST',
      url: '/session',
      headers: { authorization: `Bearer ${token}` },
      payload: createRequest(),
    });
    expect(sessionResponse.statusCode).toBe(201);
  });

  it('serves the widget return landing without a token, in the configuration production runs', async () => {
    // The dev-mode test asserts this too, but only because that fixture's auth happens to be
    // permissive. This is the posture production uses, where every other route answers `401` to a
    // request carrying no token, and the buyer's browser arrives here on a rail-driven redirect
    // carrying exactly that. If this route ever slips behind the gate, the buyer sees a JSON
    // refusal inside the payment iframe where the app expects a page, and the parent never gets
    // its `meld:paid`.
    const { service } = makeHandshake();
    app = await buildServer(config(personhoodConfig()), stubOnramp, service);

    const landing = await app.inject({ method: 'GET', url: '/meld/return' });
    expect(landing.statusCode).toBe(200);
    expect(landing.headers['content-type']).toMatch(/text\/html/);

    // The contrast is the point: the same request shape against a gated route is refused, so the
    // 200 above is this route being public rather than the gate being off.
    const gated = await app.inject({ method: 'GET', url: '/funding/funding-1' });
    expect(gated.statusCode).toBe(401);
  });

  it('redeems only with an allowed product: a disallowed one is refused', async () => {
    const { service } = makeHandshake();
    app = await buildServer(config(personhoodConfig()), () => ({
      ...stubOnramp(),
    }), service);

    const challengeResponse = await app.inject({ method: 'POST', url: '/api/v1/auth/challenge' });
    const { challenge } = challengeResponse.json<{ challenge: string }>();

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/redeem',
      payload: { challenge, proof: wire(new Uint8Array([1])), ring: 0, productId: 'not-allowed.dot' },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.value.code).toBe('UNAUTHORIZED');
  });
});

/**
 * The onramp port every server in this file is built with; none of these tests spend it.
 *
 * One definition, because this helper already existed and four hand-rolled copies of the same
 * five methods sat beside it, three differing in a wallet address for no reason. That is the
 * defect `server.test.ts` records having already fixed once in the file next door: "four
 * hand-rolled copies of it drifted". Adding a sixth method to `OnrampPort` meant editing five
 * sites across two files.
 */
const stubOnramp = () => ({
  createSession: async () => ({
    sessionId: 'sess-1',
    fundingRequestId: 'funding-1',
    serviceProviderWidgetUrl: 'https://meldcrypto.com/session/1',
    pinned: {
      walletAddress: '0x0',
      sourceAmount: '25.00',
      fiat: 'USD',
      destinationCurrencyCode: 'USDC_ASSETHUB',
    },
  }),
  quote: async () => ({
    quotes: [],
    requested: { destinationCurrencyCode: 'USDC_ASSETHUB', sourceAmount: '20', fiat: 'USD' },
  }),
  supported: async () => ({ country: 'US', fiat: 'USD', crypto: 'DOT_ASSETHUB', methods: [] }),
  supportedCountries: async () => [],
  transaction: async () => ({ transaction: {} }),
  cancel: async () => undefined,
  get: async () => undefined,
  list: async () => [],
});

describe('the address ceiling in front of the two public handshake routes', () => {
  /** A personhood server whose address allowance is spent by a single request. */
  const serveWithAddressCeiling = async (addressMax: number) => {
    const { service } = makeHandshake();
    return buildServer(
      config(
        personhoodConfig({
          rate_limit: { per_person_max: 1_000, per_address_max: addressMax, window_seconds: 60 },
          server: { port: 8080, host: '127.0.0.1', log_level: 'silent', trusted_proxy_cidrs: ['127.0.0.1/32'] },
        }),
      ),
      stubOnramp,
      service,
    );
  };

  it('throttles POST /api/v1/auth/challenge once the address allowance is spent', async () => {
    // `caller.ts` calls the address ceiling "the only thing in front of the two public handshake
    // routes", and every other rate-limit test here goes through the authenticated `/quote`. So
    // adding these paths to the limiter's `allowList` (the same shape as the `/health` exemption
    // directly above it) left the suite green while making the handshake free.
    const instance = await serveWithAddressCeiling(1);
    app = instance;
    const challenge = () =>
      instance.inject({
        method: 'POST',
        url: '/api/v1/auth/challenge',
        headers: { 'x-forwarded-for': '203.0.113.5' },
      });

    expect((await challenge()).statusCode).toBe(200);

    const limited = await challenge();
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.value.code).toBe('RATE_LIMITED');
  });

  it('throttles POST /api/v1/auth/redeem once the address allowance is spent', async () => {
    // The expensive half of the handshake: a chain round trip plus a ring-VRF verification, with
    // nobody proven behind it. Unbounded, it is the cheapest way to make this service do the most
    // work, and the caller pays nothing for a refused proof.
    const instance = await serveWithAddressCeiling(1);
    app = instance;
    const redeem = () =>
      instance.inject({
        method: 'POST',
        url: '/api/v1/auth/redeem',
        headers: { 'x-forwarded-for': '203.0.113.6' },
        payload: { challenge: wire(new Uint8Array(8)), proof: wire(new Uint8Array([1])), ring: 0, productId: PRODUCT },
      });

    // The first attempt is refused on its merits (a challenge that is not a challenge), which
    // is exactly the attempt that has to be counted.
    expect((await redeem()).statusCode).toBe(401);

    const limited = await redeem();
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.value.code).toBe('RATE_LIMITED');
  });

  it('keeps counting the handshake against the same bucket as everything else unproven', async () => {
    // The two public routes are not their own allowance. A caller who has spent the address
    // budget probing `/redeem` must not find a fresh one waiting at `/challenge`.
    const instance = await serveWithAddressCeiling(1);
    app = instance;
    const headers = { 'x-forwarded-for': '203.0.113.7' };

    const challenge = await instance.inject({ method: 'POST', url: '/api/v1/auth/challenge', headers });
    const redeem = await instance.inject({
      method: 'POST',
      url: '/api/v1/auth/redeem',
      headers,
      payload: { challenge: wire(new Uint8Array(8)), proof: wire(new Uint8Array([1])), ring: 0, productId: PRODUCT },
    });

    expect(challenge.statusCode).toBe(200);
    expect(redeem.statusCode).toBe(429);
  });
});

describe('the CORS preflight answer', () => {
  const serveCors = async () => {
    const { service } = makeHandshake();
    return buildServer(config(personhoodConfig()), stubOnramp, service);
  };

  it('advertises only the two methods this service actually serves', async () => {
    // Nothing read `access-control-allow-methods`, so widening it to PUT/DELETE/PATCH passed.
    // The header is what a browser enforces the preflight against. Advertising a method no route
    // implements invites a caller to build against a request that will only ever 404, and it
    // widens the surface a compromised page may reach from a visitor's browser.
    const instance = await serveCors();
    app = instance;

    const preflight = await instance.inject({
      method: 'OPTIONS',
      url: '/quote',
      headers: {
        origin: 'https://app.example',
        'access-control-request-method': 'POST',
      },
    });

    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers['access-control-allow-origin']).toBe('https://app.example');
    // Exact, not "contains GET and POST": the point is what is absent.
    expect(preflight.headers['access-control-allow-methods']).toBe('GET, POST');
    // No cookies: this service uses none, and allowing them beside an origin allowlist is how a
    // CSRF surface arrives by accident.
    expect(preflight.headers).not.toHaveProperty('access-control-allow-credentials');
  });

  it.each(['PUT', 'DELETE', 'PATCH'])('does not advertise %s', async (method) => {
    const instance = await serveCors();
    app = instance;

    const preflight = await instance.inject({
      method: 'OPTIONS',
      url: '/quote',
      headers: { origin: 'https://app.example', 'access-control-request-method': method },
    });

    expect(String(preflight.headers['access-control-allow-methods'])).not.toContain(method);
  });
});

describe('the per-person rate-limit bucket', () => {
  /** A bearer token for `alias`, minted with the same key the service verifies against. */
  const tokenFor = (alias: string) => mintToken({ secret: TOKEN_KEY }, alias, PRODUCT, 300);

  /** A personhood-mode server with tight ceilings, behind one trusted proxy hop. */
  const serve = async (personMax: number, addressMax = personMax) => {
    const { service } = makeHandshake();
    return buildServer(
      config(
        personhoodConfig({
          rate_limit: { per_person_max: personMax, per_address_max: addressMax, window_seconds: 60 },
          server: { port: 8080, host: '127.0.0.1', log_level: 'silent', trusted_proxy_cidrs: ['127.0.0.1/32'] },
        }),
      ),
      () => stubOnramp(),
      service,
    );
  };

  const quote = (instance: FastifyInstance, authorization: string, forwardedFor = '203.0.113.1') =>
    instance.inject({
      method: 'POST',
      url: '/quote',
      headers: { authorization, 'x-forwarded-for': forwardedFor },
      payload: quoteRequestBody(),
    });

  it('gives two proven people at one address a bucket each', async () => {
    // The whole point of the per-person bucket. Before authentication moved ahead of the
    // limiter the key was the address, so two people sharing a NAT, an office, or a mobile
    // carrier shared one ceiling
    // and the second was throttled having spent nothing.
    app = await serve(1);
    const [ada, grace] = await Promise.all([tokenFor('0xada'), tokenFor('0xgrace')]);

    expect((await quote(app, `Bearer ${ada}`)).statusCode).toBe(200);
    expect((await quote(app, `Bearer ${ada}`)).statusCode).toBe(429);
    // Same address, different person, nothing spent yet.
    expect((await quote(app, `Bearer ${grace}`)).statusCode).toBe(200);
  });

  it('holds one person to their ceiling however many addresses they call from', async () => {
    // The other half: the bucket follows the person, so moving to a fresh address does not
    // reset it. That is only true because the alias comes out of the ring-VRF proof and the
    // caller cannot vary it.
    app = await serve(1);
    const ada = `Bearer ${await tokenFor('0xada')}`;

    expect((await quote(app, ada, '203.0.113.1')).statusCode).toBe(200);
    expect((await quote(app, ada, '198.51.100.9')).statusCode).toBe(429);
  });

  it('counts a failed authentication against the address, so probes stay bounded', async () => {
    // `identify` records the refusal rather than throwing it, precisely so the limiter still
    // runs. Were it to throw in `onRequest`, every rejected token would skip the limiter and
    // an attacker could probe the verifier for free.
    app = await serve(2);
    const forged = `Bearer ${await mintToken({ secret: new Uint8Array(32).fill(9) }, '0xada', PRODUCT, 300)}`;

    expect((await quote(app, forged)).statusCode).toBe(401);
    expect((await quote(app, forged)).statusCode).toBe(401);
    const limited = await quote(app, forged);

    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.value.code).toBe('RATE_LIMITED');
  });

  it('spends the person allowance for a person and the address allowance for everyone else', async () => {
    // The two numbers are what make the split worth having. A proven person draws on
    // `per_person_max`; a caller with nobody proven behind them draws on the tighter
    // `per_address_max`, at the same address, in the same window.
    app = await serve(3, 1);
    const ada = `Bearer ${await tokenFor('0xada')}`;
    const forged = `Bearer ${await mintToken({ secret: new Uint8Array(32).fill(9) }, '0xada', PRODUCT, 300)}`;

    // The address allowance of 1 is spent by a single rejected attempt.
    expect((await quote(app, forged)).statusCode).toBe(401);
    expect((await quote(app, forged)).statusCode).toBe(429);

    // The person's own allowance of 3 is untouched by it.
    expect((await quote(app, ada)).statusCode).toBe(200);
    expect((await quote(app, ada)).statusCode).toBe(200);
    expect((await quote(app, ada)).statusCode).toBe(200);
    expect((await quote(app, ada)).statusCode).toBe(429);
  });

  it('counts a request the body parser rejects, so malformed spam is bounded too', async () => {
    // The limiter runs in `onRequest`, before a body exists. At `preValidation`, which orders
    // just as correctly against authentication, a caller spamming malformed JSON would be
    // turned away by the parser before the limiter ever saw them, and the 400s would be free.
    const instance = await serve(2);
    app = instance;
    const ada = await tokenFor('0xada');
    const malformed = () =>
      instance.inject({
        method: 'POST',
        url: '/quote',
        headers: {
          authorization: `Bearer ${ada}`,
          'x-forwarded-for': '203.0.113.1',
          'content-type': 'application/json',
        },
        payload: '{"not":',
      });

    expect((await malformed()).statusCode).toBe(400);
    expect((await malformed()).statusCode).toBe(400);

    expect((await malformed()).statusCode).toBe(429);
  });

  it('does not let a rejected caller spend a proven person\'s budget', async () => {
    // The refused attempts land in the address bucket; the person's own bucket is untouched.
    app = await serve(1);
    const forged = `Bearer ${await mintToken({ secret: new Uint8Array(32).fill(9) }, '0xada', PRODUCT, 300)}`;

    expect((await quote(app, forged)).statusCode).toBe(401);
    expect((await quote(app, `Bearer ${await tokenFor('0xada')}`)).statusCode).toBe(200);
  });
});
