import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { reject, transactionId, type CreateSessionResponse, type QuoteResponse } from '../src/contract.js';
import type { FundingRecord } from '../src/funding/types.js';
import { MeldHttpError } from '../src/meld/client.js';
import { Secret } from '../src/secret.js';
import { buildServer } from '../src/server.js';
import { ALICE, config, createRequest, fundingRecord, quoteRequestBody } from './fixtures.js';
import type { AuditLog } from '../src/audit.js';

const RESPONSE: CreateSessionResponse = {
  sessionId: 'sess-1',
  fundingRequestId: 'funding-1',
  serviceProviderWidgetUrl: 'https://meldcrypto.com/session/meld-1',
  pinned: {
    walletAddress: ALICE,
    sourceAmount: '25.00',
    fiat: 'USD',
    destinationCurrencyCode: 'USDC_ASSETHUB',
  },
};

const DEV_HEADERS = { 'x-dev-product-id': 'app.dot' };

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

const SERVER = { port: 8080, host: '127.0.0.1', log_level: 'silent' as const };

/**
 * The server under test, over a fake onramp.
 *
 * One definition of that fake, because four hand-rolled copies of it drifted: each named the same
 * five methods, and a test that cared about one of them still had to restate the other four.
 * `overrides` replaces just the method a test is about.
 */
const serve = async (
  create: () => Promise<CreateSessionResponse> = async () => RESPONSE,
  cfg = config(),
  overrides: Partial<{
    transaction: () => Promise<{ transaction: unknown }>;
    quote: () => Promise<QuoteResponse>;
    get: () => Promise<FundingRecord | undefined>;
    list: () => Promise<FundingRecord[]>;
    cancel: () => Promise<FundingRecord | undefined>;
  }> = {},
  sink?: { write: (line: string) => void },
) => {
  app = await buildServer(cfg, () => ({
    createSession: create,
    get: async () => undefined,
    cancel: async () => undefined,
    list: async () => [],
    supported: async () => ({ country: 'US', fiat: 'USD', crypto: 'DOT_ASSETHUB', methods: [] }),
    supportedCountries: async () => [],
    quote: async () => ({
      // A complete breakdown, because the test below is named for it. An incomplete fixture
      // under that name is the fake and the code agreeing with each other. Amounts are decimal
      // strings, which is the only form the client can now produce: it keeps Meld's exact
      // digits rather than routing them through a double.
      quotes: [
        {
          serviceProvider: 'TRANSAK',
          sourceAmount: '21.47',
          sourceCurrencyCode: 'USD',
          destinationAmount: '20',
          destinationCurrencyCode: 'USDC_ASSETHUB',
          totalFee: '1.47',
          transactionFee: '0.19',
          networkFee: '0.28',
          partnerFee: '1.00',
          exchangeRate: '0.9315',
        },
      ],
      requested: { destinationCurrencyCode: 'USDC_ASSETHUB', sourceAmount: '20', fiat: 'USD' },
    }),
    transaction: async () => ({ transaction: { id: 'tx-1', status: 'PENDING' } }),
    ...overrides,
  }), undefined, sink);
  return app;
};

describe('logging', () => {
  /** Collects what pino actually writes, so an assertion here can fail. */
  const capture = () => {
    const lines: string[] = [];
    return { lines, write: (line: string) => lines.push(line) };
  };

  const withLogger = async (sink: { write: (line: string) => void }) =>
    serve(
      async () => RESPONSE,
      config({ server: { port: 8080, host: '127.0.0.1', log_level: 'info' } }),
      {
        quote: async () => ({
          quotes: [],
          requested: { destinationCurrencyCode: 'USDC_ASSETHUB', sourceAmount: '20', fiat: 'USD' },
        }),
      },
      sink,
    );

  it('captures log output at all, which the previous version of this test did not', async () => {
    // The guard on every assertion below. pino writes through sonic-boom to the file
    // descriptor, so the old approach of reassigning `process.stdout.write` collected nothing
    // and `expect('').not.toContain(token)` passed with redaction deleted.
    //
    // Not `/health`: that route is deliberately `logLevel: 'silent'`, because it is both
    // rate-limit exempt and internet-reachable, and a route that is exempt and logging is a
    // free amplifier against the stream the audit trail shares. So it is the one route that
    // proves nothing about the sink.
    const sink = capture();
    const built = await withLogger(sink);
    await built.inject({ method: 'GET', url: '/nope' });

    expect(sink.lines.length).toBeGreaterThan(0);
  });

  it('keeps writing the audit stream when the request log is turned down', async () => {
    // An operator raising `log_level` to `warn` to cut probe noise would have discarded every
    // audit event (`session.created`, `session.refused`, `session.rail_refused` and
    // `session.orphaned` are all written at `info`) while request-level warnings kept flowing.
    // The logs look alive and the record a dispute is answered from is silently gone.
    //
    // Asserted on the logger `buildServer` hands the service, because that is the object whose
    // threshold is the question; the route-level fake in `serve` writes no audit line of its own.
    const sink = capture();
    let audit: AuditLog | undefined;
    app = await buildServer(
      config({ server: { port: 8080, host: '127.0.0.1', log_level: 'warn' } }),
      (given) => {
        audit = given;
        return {
          createSession: async () => RESPONSE,
          get: async () => undefined,
          list: async () => [],
          cancel: async () => undefined,
          supported: async () => ({ country: 'US', fiat: 'USD', crypto: 'DOT_ASSETHUB', methods: [] }),
          supportedCountries: async () => [],
          quote: async () => ({
            quotes: [],
            requested: { destinationCurrencyCode: 'USDC_ASSETHUB', sourceAmount: '20', fiat: 'USD' },
          }),
          transaction: async () => ({ transaction: {} }),
        };
      },
      undefined,
      sink,
    );

    audit?.info(
      {
        event: 'session.created',
        alias: 'alias-abc',
        productId: 'app.dot',
        requestId: 'req-1',
        rail: 'meld',
        destinationCurrencyCode: 'USDC_ASSETHUB',
        walletAddress: ALICE,
        sourceAmount: '25.00',
        fiat: 'USD',
      },
      'session created',
    );

    // One sink, two thresholds: the request log is turned down and the audit line still lands.
    expect(sink.lines.filter((l) => l.includes('session.created')).length).toBe(1);
  });

  it('writes no log line for the liveness probe', async () => {
    // Exempt from the rate limit and reachable from the internet, so every logged line is a
    // free write an unauthenticated caller can trigger, against the same stream the audit trail
    // has no delivery guarantee on. The exemption stays; the amplifier does not.
    const sink = capture();
    const built = await withLogger(sink);
    await built.inject({ method: 'GET', url: '/health' });

    expect(sink.lines).toEqual([]);
  });

  it('keeps a caller-supplied authorization header out of a real request log line', async () => {
    const sink = capture();
    const built = await withLogger(sink);

    await built.inject({
      method: 'POST',
      url: '/quote',
      headers: { ...DEV_HEADERS, authorization: 'Bearer super-secret-caller-token' },
      payload: quoteRequestBody(),
    });

    expect(sink.lines.length).toBeGreaterThan(0);
    expect(sink.lines.join('')).not.toContain('super-secret-caller-token');
  });

  it('redacts a Secret written straight to the log, and one carried by an Error', async () => {
    // The disclosure path the docs claim and nothing asserted: the API key reaching a log line.
    // `Secret`'s hooks are unit-tested in isolation against JSON.stringify and util.inspect;
    // this pins them through the real sink, and would catch a future `log.info({ cfg })`.
    const sink = capture();
    const built = await withLogger(sink);
    const secret = new Secret('meld-live-key-must-never-be-logged');

    built.log.info({ apiKey: secret }, 'logging a secret directly');
    built.log.error({ err: new Error(`wrapped ${String(secret)}`) }, 'logging a wrapped secret');

    const logged = sink.lines.join('');
    expect(logged.length).toBeGreaterThan(0);
    expect(logged).not.toContain('meld-live-key-must-never-be-logged');
    expect(logged).toContain('[redacted]');
  });
});

describe('the error contract holds for every failure', () => {
  it.each([
    ['an unknown route', 'GET' as const, '/nope'],
    ['a wrong method on a real route', 'GET' as const, '/quote'],
    ['a wrong method on the probe', 'POST' as const, '/health'],
  ])('answers %s with the contract body', async (_label, method, url) => {
    // Fastify routes "not found" through its own handler, never through `setErrorHandler`, so
    // this was the one response that escaped `ErrorResponse`: no `request_id` to quote in a
    // support conversation, `error` a bare string rather than a `FundingFailure`, and the
    // requested route echoed back to the caller.
    const response = await (await serve()).inject({ method, url, headers: DEV_HEADERS });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: { tag: 'Other', value: { code: 'NOT_FOUND', message: 'No such route.' } },
      request_id: expect.any(String),
    });
    expect(response.body).not.toContain(url);
  });

  it('survives a handler that throws null', async () => {
    // `throw null` and a bare `Promise.reject()` both reach the handler, and reading
    // `.statusCode` off them threw inside it. Fastify then fell back to its own handler,
    // answering off-contract with "Cannot read properties of null" and no request id.
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the point
    const app = await serve(() => Promise.reject(null));

    const response = await app.inject({
      method: 'POST',
      url: '/session',
      headers: DEV_HEADERS,
      payload: createRequest(),
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: { tag: 'Other', value: { code: 'INTERNAL', message: 'Something went wrong.' } },
      request_id: expect.any(String),
    });
    expect(response.body).not.toContain('Cannot read properties');
  });
});

describe('the rate-limit bucket', () => {
  const hit = (app: FastifyInstance, forwardedFor: string) =>
    app.inject({
      method: 'POST',
      url: '/quote',
      headers: { ...DEV_HEADERS, 'x-forwarded-for': forwardedFor },
      payload: quoteRequestBody(),
    });

  it('separates callers by forwarded address when a proxy hop is trusted', async () => {
    // The point of `trusted_proxy_cidrs`. The threat model requires TLS terminated in front, so
    // with no trusted hop every request's socket peer is the proxy and the whole product shares
    // one bucket: ten distinct users, seven throttled having sent nothing.
    const app = await serve(
      undefined,
      config({ rate_limit: { per_address_max: 1, window_seconds: 60 }, server: { ...SERVER, trusted_proxy_cidrs: ['127.0.0.1/32'] } }),
    );

    expect((await hit(app, '203.0.113.1')).statusCode).toBe(200);
    expect((await hit(app, '203.0.113.1')).statusCode).toBe(429);
    // A different buyer, who has sent nothing, is unaffected.
    expect((await hit(app, '203.0.113.2')).statusCode).toBe(200);
  });

  it('shares one bucket when no hop is trusted, which is why the count is required', async () => {
    const app = await serve(
      undefined,
      config({ rate_limit: { per_address_max: 1, window_seconds: 60 }, server: { ...SERVER } }),
    );

    expect((await hit(app, '203.0.113.1')).statusCode).toBe(200);
    expect((await hit(app, '203.0.113.2')).statusCode).toBe(429);
  });
});

describe('the fiat code', () => {
  it.each(['$$$', '   ', 'ЮСД', '1 2', 'US', 'DOLLARS'])(
    'refuses %j locally rather than spending a Meld call on it',
    async (fiat) => {
      // `length(3)` accepted the first four. On /session a mismatch against the configured
      // currency caught them; on /quote there is no such comparison by design, so they reached
      // Meld and came back as 503 ProviderTimeout: "retry" for a request that cannot succeed.
      const response = await (await serve()).inject({
        method: 'POST',
        url: '/quote',
        headers: DEV_HEADERS,
        payload: { ...quoteRequestBody(), fiat },
      });

      expect(response.statusCode).toBe(400);
    },
  );

  it('still accepts a lowercase code, which the caller may legitimately send', async () => {
    const response = await (await serve()).inject({
      method: 'POST',
      url: '/quote',
      headers: DEV_HEADERS,
      payload: { ...quoteRequestBody(), fiat: 'usd' },
    });

    expect(response.statusCode).toBe(200);
  });
});

describe('declared string bounds', () => {
  /**
   * The wire-side half of the same gap: every `.max()` in `contract.ts` could be removed with the
   * suite green, because a valid value flows through the bound and marks the line covered. The
   * bounds are what keep attacker-supplied bytes away from a wasm deserialiser and an HMAC with a
   * stated ceiling rather than only whatever `bodyLimit` happens to be.
   */
  it.each<[string, string, number]>([
    ['walletAddress', 'walletAddress', 129],
    ['paymentMethodType', 'paymentMethodType', 49],
    ['destinationCurrencyCode', 'destinationCurrencyCode', 65],
    ['idempotencyKey', 'idempotencyKey', 201],
    ['redirectUrl', 'redirectUrl', 2049],
  ])('refuses a %s over its bound', async (_label, field, length) => {
    const value = field === 'redirectUrl' ? `https://app.example/${'a'.repeat(length)}` : 'a'.repeat(length);
    const response = await (await serve()).inject({
      method: 'POST',
      url: '/session',
      headers: DEV_HEADERS,
      payload: { ...createRequest(), [field]: value },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.value.code).toBe('MALFORMED_REQUEST');
  });

  it('refuses a session with no serviceProvider here, rather than letting Meld refuse it', async () => {
    // Meld rejects an absent `sessionData.serviceProvider` with `must not be null`, the same
    // error it gives for an explicit null (verified live). While this field was
    // `.optional()`, a caller who left it out passed validation, spent a metered upstream call,
    // and was told "the payment service refused the request": a refusal about their payment when
    // the truth was a field they had been told they could omit.
    //
    // The second assertion is the one that matters. A refusal that still reached the rail would be
    // the same defect wearing a better message, and `onramp.ts` opens with the rule it breaks:
    // never spend an upstream call to learn something refusable here.
    let reached = 0;
    const withoutProvider = { ...createRequest() };
    delete (withoutProvider as Record<string, unknown>).serviceProvider;
    const app = await serve(async () => {
      reached += 1;
      return RESPONSE;
    });

    const response = await app.inject({
      method: 'POST',
      url: '/session',
      headers: DEV_HEADERS,
      payload: withoutProvider,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.value.code).toBe('MALFORMED_REQUEST');
    expect(reached, 'the request reached the service instead of being refused at the boundary').toBe(0);
  });
});

describe('the /quote route refusal', () => {
  it('returns a local destination refusal as the contract body, not a 500', async () => {
    // `onramp.quote` refuses an unknown destination locally (resolveDestination) before any
    // Meld call. Assert that Refusal travels through the error handler as the standard body.
    const app = await serve(async () => RESPONSE, config(), {
      quote: () => {
        throw reject({ tag: 'WrongAssetOrChain' }, 'Nope is not a destination we serve.');
      },
    });
    const response = await app.inject({
      method: 'POST',
      url: '/quote',
      headers: DEV_HEADERS,
      payload: quoteRequestBody(),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: { tag: 'WrongAssetOrChain' }, request_id: expect.any(String) });
    expect(response.body).not.toContain('we serve');
  });
});

describe('the transaction id', () => {
  it.each(['/transaction/', '/transaction/.', '/transaction/%2e'])(
    'refuses %s locally instead of asking Meld for the whole collection',
    async (url) => {
      // An empty id made `transactionPath('')` collapse to Meld's collection path, and this
      // route forwarded every transaction on the operator's account to the caller.
      //
      // All three of these URLs arrive at the handler as `params.id === ''` (Fastify normalises
      // `.` and `%2e` away before any handler runs), so this table is one case wearing three hats.
      // It is kept because the route-level behaviour is what a caller sees, but the mechanism is
      // asserted directly below: the charset regex, not the length bound, is what rejects `''`,
      // and this is the direction that holds.
      let upstreamCalls = 0;
      const app = await serve(undefined, undefined, {
        transaction: async () => {
          upstreamCalls++;
          return { transaction: {} };
        },
      });

      const response = await app.inject({ method: 'GET', url, headers: DEV_HEADERS });

      expect(response.statusCode).toBe(400);
      expect(upstreamCalls).toBe(0);
    },
  );

  it.each([
    ['an empty id', ''],
    ['a dot', '.'],
    ['a path traversal', '../admin'],
    ['a slash', 'a/b'],
    ['a percent escape', 'a%2eb'],
    ['a query fragment', 'a?b=c'],
  ])('the schema itself refuses %s', (_label, id) => {
    // Asserted against the schema rather than through the router, because the router normalises
    // three of these into one before a handler sees them. The `+` in the charset regex is what
    // rejects `''`; `.min(1)` can be removed with the route tests still green.
    expect(transactionId.safeParse(id).success).toBe(false);
  });

  it('still accepts an ordinary opaque id', async () => {
    const response = await (await serve()).inject({
      method: 'GET',
      url: '/transaction/tx_A1-b2C3',
      headers: DEV_HEADERS,
    });
    expect(response.statusCode).toBe(200);
  });
});

describe('CORS', () => {
  it('answers the preflight for an allowlisted origin', async () => {
    // Without this the browser never sends the real request at all: the preflight 404s and the
    // integration fails before any of this service's logic runs.
    const response = await (await serve()).inject({
      method: 'OPTIONS',
      url: '/quote',
      headers: {
        origin: 'https://app.example',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
      },
    });

    expect(response.statusCode).toBeLessThan(300);
    expect(response.headers['access-control-allow-origin']).toBe('https://app.example');
  });

  it('does not reflect an origin that is not allowlisted', async () => {
    const response = await (await serve()).inject({
      method: 'OPTIONS',
      url: '/quote',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
    });

    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('never answers with a wildcard, which would let any page spend the quota', async () => {
    const response = await (await serve()).inject({
      method: 'OPTIONS',
      url: '/quote',
      headers: { origin: 'https://app.example', 'access-control-request-method': 'POST' },
    });

    expect(response.headers['access-control-allow-origin']).not.toBe('*');
  });

  it('disables CORS entirely when the allowlist is empty', async () => {
    // Distinct from a rejected origin on purpose. An empty allowlist means CORS is not
    // configured, so the preflight is not handled at all, which tells an operator something
    // different from "your origin is not on the list".
    const closed = await serve(undefined, config({ cors: { allowed_origins: [] } }));

    const response = await closed.inject({
      method: 'OPTIONS',
      url: '/quote',
      headers: { origin: 'https://app.example', 'access-control-request-method': 'POST' },
    });

    expect(response.statusCode).toBe(404);
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('answers a rejected origin, but without the header', async () => {
    // The other side of the distinction above: CORS is configured, this origin is not allowed.
    const response = await (await serve()).inject({
      method: 'OPTIONS',
      url: '/quote',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
    });

    expect(response.statusCode).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('does not allow credentials, which would open a CSRF surface', async () => {
    const response = await (await serve()).inject({
      method: 'OPTIONS',
      url: '/quote',
      headers: { origin: 'https://app.example', 'access-control-request-method': 'POST' },
    });

    expect(response.headers['access-control-allow-credentials']).toBeUndefined();
  });
});

describe('required fields on POST /session', () => {
  it.each(['country', 'walletAddress', 'sourceAmount', 'fiat', 'destinationCurrencyCode', 'idempotencyKey'])(
    'refuses a body with no %s',
    async (field) => {
      // Format was tested; presence was not. `country` in particular could be made optional with
      // the whole suite green, and a session would then open with `countryCode: undefined` at the
      // rail, which selects the provider set, the fee schedule and the KYC path.
      const app = await serve(undefined, config());
      // Rebuilt without the field rather than deleted from a copy: a dynamic `delete` is banned
      // by the lint rules, and the omission is what is being asserted either way.
      const body = Object.fromEntries(Object.entries(createRequest()).filter(([key]) => key !== field));

      const res = await app.inject({ method: 'POST', url: '/session', headers: DEV_HEADERS, payload: body });

      expect(res.statusCode).toBe(400);
      expect(res.json().error.value.code).toBe('MALFORMED_REQUEST');
    },
  );
});

describe('GET /funding and refusals', () => {
  const rows = [
    fundingRecord({ id: 'live', status: 'session_opened' }),
    fundingRecord({ id: 'nope', status: 'refused' }),
  ];

  it('excludes refusals by default', async () => {
    let asked: boolean | undefined;
    const app = await serve(undefined, config(), {
      list: async (_s: unknown, includeRefused?: boolean) => {
        asked = includeRefused;
        return rows.filter((r) => includeRefused === true || r.status !== 'refused');
      },
    } as never);

    const body = (await app.inject({ method: 'GET', url: '/funding', headers: DEV_HEADERS })).json<{
      fundingRequests: { id: string }[];
    }>();

    expect(asked).toBe(false);
    expect(body.fundingRequests.map((r) => r.id)).toEqual(['live']);
  });

  it('includes them when the caller opts in', async () => {
    const app = await serve(undefined, config(), {
      list: async (_s: unknown, includeRefused?: boolean) =>
        rows.filter((r) => includeRefused === true || r.status !== 'refused'),
    } as never);

    const body = (
      await app.inject({ method: 'GET', url: '/funding?includeRefused=true', headers: DEV_HEADERS })
    ).json<{ fundingRequests: { id: string }[] }>();

    expect(body.fundingRequests.map((r) => r.id)).toEqual(['live', 'nope']);
  });

  it('refuses a query it does not recognise rather than silently ignoring it', async () => {
    // `.strict()`, like every other schema here. A caller who writes `includeRefusals` or
    // `include_refused` would otherwise be handed a list they believe is complete and is not.
    const app = await serve(undefined, config());

    const res = await app.inject({ method: 'GET', url: '/funding?includeRefusals=true', headers: DEV_HEADERS });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.value.code).toBe('MALFORMED_REQUEST');
  });

  it('refuses a value that is not a boolean word', async () => {
    const app = await serve(undefined, config());

    const res = await app.inject({ method: 'GET', url: '/funding?includeRefused=yes', headers: DEV_HEADERS });

    expect(res.statusCode).toBe(400);
  });
});

describe('rate limiting', () => {
  const strict = () => config({ rate_limit: { per_address_max: 2, window_seconds: 60 } });

  it('refuses a caller past the ceiling with the standard error body', async () => {
    const app = await serve(undefined, strict());
    const call = () =>
      app.inject({ method: 'POST', url: '/quote', headers: DEV_HEADERS, payload: quoteRequestBody() });

    expect((await call()).statusCode).toBe(200);
    expect((await call()).statusCode).toBe(200);
    const limited = await call();

    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.value.code).toBe('RATE_LIMITED');
    expect(limited.json().request_id).toBeTruthy();
  });

  it('uses the partitioned store, not the plugin\'s single LRU', async () => {
    // The one line joining `limit-store.ts` to production is `store: PartitionedStore` in the
    // limiter registration, and deleting it left the whole suite green: the limiter reverts to
    // `@fastify/rate-limit`'s single 5,000-entry LRU and the eviction attack the file exists to
    // close reopens, fail-open.
    //
    // The observable difference is capacity. Ours holds 10,000 address entries; the plugin's
    // default holds 5,000 for every key. Churning past 5,000 distinct addresses evicts the first
    // one under the plugin's default and does not under the configured one.
    const app = await serve(
      undefined,
      config({
        rate_limit: { per_address_max: 1, window_seconds: 60 },
        server: { port: 8080, host: '127.0.0.1', log_level: 'silent', trusted_proxy_cidrs: ['127.0.0.1/32'] },
      }),
    );
    const spend = (ip: string) =>
      app.inject({
        method: 'POST',
        url: '/quote',
        headers: { ...DEV_HEADERS, 'x-forwarded-for': ip },
        payload: quoteRequestBody(),
      });

    await spend('203.0.113.9');
    expect((await spend('203.0.113.9')).statusCode).toBe(429);

    // Past the plugin's default capacity, short of the configured one.
    for (let i = 0; i < 6_000; i += 1) {
      const a = Math.floor(i / 254);
      await spend(`198.51.${String(a)}.${String((i % 254) + 1)}`);
    }

    // Still counted. Under the plugin's own store this entry is long gone and returns 200.
    expect((await spend('203.0.113.9')).statusCode).toBe(429);
  }, 30_000);

  it('does not forget an address when other addresses churn through the store', async () => {
    // The store is an LRU. At the plugin's 5,000-entry default, five thousand requests from
    // distinct addresses (each in a fresh bucket and so each below its own ceiling) evicted
    // every entry, and a caller already at their limit was served again.
    const app = await serve(
      undefined,
      config({
        rate_limit: { per_address_max: 2, window_seconds: 60 },
        server: { port: 8080, host: '127.0.0.1', log_level: 'silent', trusted_proxy_cidrs: ['127.0.0.1/32'] },
      }),
    );
    const spend = (ip: string) =>
      app.inject({
        method: 'POST',
        url: '/quote',
        headers: { ...DEV_HEADERS, 'x-forwarded-for': ip },
        payload: quoteRequestBody(),
      });

    await spend('203.0.113.9');
    await spend('203.0.113.9');
    expect((await spend('203.0.113.9')).statusCode).toBe(429);

    for (let i = 0; i < 300; i += 1) await spend(`198.51.100.${String(i % 254)}`);

    expect((await spend('203.0.113.9')).statusCode).toBe(429);
  });

  it('tells the caller when to come back', async () => {
    const app = await serve(undefined, strict());
    for (let i = 0; i < 3; i++) {
      await app.inject({ method: 'POST', url: '/quote', headers: DEV_HEADERS, payload: quoteRequestBody() });
    }

    const limited = await app.inject({
      method: 'POST',
      url: '/quote',
      headers: DEV_HEADERS,
      payload: quoteRequestBody(),
    });

    expect(limited.headers['retry-after']).toBeDefined();
  });

  it('counts the session endpoint too, since that is the one that costs money', async () => {
    const app = await serve(undefined, strict());
    const post = (url: string, payload: object) =>
      app.inject({ method: 'POST', url, headers: DEV_HEADERS, payload });

    await post('/quote', quoteRequestBody());
    await post('/quote', quoteRequestBody());

    expect((await post('/session', createRequest())).statusCode).toBe(429);
  });

  it('throttles a CORS preflight, which had no ceiling at all', async () => {
    // `@fastify/cors` answers a preflight from an instance-level `onRequest` hook and returns
    // without calling `next()`, and registers its own `OPTIONS *` route. Registered before the
    // limiter, both happened before any ceiling existed, so preflights were unlimited from any
    // origin on any path, each costing a request id and a log pair. The allowlist does not help:
    // it decides whether the `Allow-Origin` header is written, not whether the 204 is sent.
    const app = await serve(undefined, config({ rate_limit: { per_address_max: 2, window_seconds: 60 } }));
    const preflight = (origin: string) =>
      app.inject({
        method: 'OPTIONS',
        url: '/session',
        headers: { origin, 'access-control-request-method': 'POST' },
      });

    expect((await preflight('https://app.example')).statusCode).toBe(204);
    expect((await preflight('https://app.example')).statusCode).toBe(204);

    // And a disallowed origin draws on the same bucket rather than an unlimited one.
    expect((await preflight('https://evil.example')).statusCode).toBe(429);
  });

  it('throttles unmatched routes, which had no ceiling at all', async () => {
    // The plugin attaches itself via `onRoute`; Fastify builds the not-found context without
    // emitting one, so `GET /a1`, `/a2`, ... were unlimited. Each costs a request id and a pino
    // request/response pair: a free amplifier against the log pipeline the audit trail needs.
    const app = await serve(undefined, config({ rate_limit: { per_address_max: 2, window_seconds: 60 } }));
    const miss = () => app.inject({ method: 'GET', url: '/does-not-exist' });

    expect((await miss()).statusCode).toBe(404);
    expect((await miss()).statusCode).toBe(404);

    expect((await miss()).statusCode).toBe(429);
  });

  it('does not exempt a path that merely begins with /health', async () => {
    // The exemption matches the matched route pattern, not the raw target. A prefix test would
    // unbound every unmatched path under `/healthz...`, which is the log amplifier the not-found
    // limiter exists to close; only the positive direction was ever asserted.
    const app = await serve(undefined, config({ rate_limit: { per_address_max: 1, window_seconds: 60 } }));
    const codes: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      codes.push((await app.inject({ method: 'GET', url: '/healthz' })).statusCode);
    }

    expect(codes).toEqual([404, 429, 429]);
  });

  it.each(['/health', '/health?probe=1'])(
    'never throttles the liveness probe at %s',
    async (url) => {
      // `expect([200, 429]).toContain(...)` would pass either way and so
      // could not notice the exemption being removed. The query-string case is the one that was
      // actually broken: `allowList` compared the raw target, so any orchestrator adding a
      // cache-buster got a 429 from a healthy instance, verbatim the outage the exemption exists
      // to prevent.
      const app = await serve(undefined, config({ rate_limit: { per_address_max: 1, window_seconds: 60 } }));

      const codes: number[] = [];
      for (let i = 0; i < 3; i++) {
        codes.push((await app.inject({ method: 'GET', url })).statusCode);
      }

      expect(codes).toEqual([200, 200, 200]);
    },
  );
});

describe('the consumer contract', () => {
  it('accepts the exact request body the consumer said it would send', async () => {
    // Field for field, from the integration note: {country, fiat, destinationCurrencyCode,
    // sourceAmount, paymentMethodType}. Meld's quote is source-denominated. Schemas are strict, so
    // a rename on either side fails here rather than on the first real integration.
    const response = await (await serve()).inject({
      method: 'POST',
      url: '/quote',
      headers: DEV_HEADERS,
      payload: {
        country: 'US',
        fiat: 'USD',
        destinationCurrencyCode: 'USDC_ASSETHUB',
        sourceAmount: '20',
        paymentMethodType: 'CREDIT_DEBIT_CARD',
      },
    });

    expect(response.statusCode).toBe(200);
  });

  it('returns the widget URL under the name the consumer asked for', async () => {
    const response = await (await serve()).inject({
      method: 'POST',
      url: '/session',
      headers: DEV_HEADERS,
      payload: createRequest(),
    });

    expect(response.json()).toHaveProperty('serviceProviderWidgetUrl');
  });

  it('serves the unversioned paths the integration note names', async () => {
    const app = await serve();
    const cases = [
      ['POST', '/quote', quoteRequestBody()],
      ['POST', '/session', createRequest()],
      ['GET', '/transaction/tx-1', undefined],
    ] as const;

    for (const [method, url, payload] of cases) {
      const response = await app.inject({
        method,
        url,
        headers: DEV_HEADERS,
        ...(payload === undefined ? {} : { payload }),
      });
      expect(response.statusCode, `${method} ${url}`).not.toBe(404);
    }
  });
});

describe('POST /quote', () => {
  it('returns offers with the fee breakdown intact', async () => {
    // The client works backwards from a destination amount to the fiat to charge, so every
    // fee component has to survive the hop. Reshaping or trimming here moves the rounding
    // error into its arithmetic.
    const response = await (await serve()).inject({
      method: 'POST',
      url: '/quote',
      headers: DEV_HEADERS,
      payload: quoteRequestBody(),
    });

    expect(response.statusCode).toBe(200);
    // Every component the frontend needs for the deposit over-estimation, named explicitly, so
    // dropping one from the passthrough fails here rather than in someone else's arithmetic.
    expect(response.json().quotes[0]).toMatchObject({
      sourceAmount: '21.47',
      totalFee: '1.47',
      transactionFee: '0.19',
      networkFee: '0.28',
      exchangeRate: '0.9315',
    });
    expect(response.json().requested).toMatchObject({ sourceAmount: '20' });
  });

  it.each([
    ['a missing country', { country: undefined }],
    ['a lowercase country', { country: 'us' }],
    ['a three-letter country', { country: 'USA' }],
    ['a missing payment method', { paymentMethodType: undefined }],
    ['a non-numeric source amount', { sourceAmount: 'twenty' }],
    ['an unexpected extra field', { url: 'https://evil.example' }],
  ])('rejects %s with 400', async (_label, overrides) => {
    const response = await (await serve()).inject({
      method: 'POST',
      url: '/quote',
      headers: DEV_HEADERS,
      payload: { ...quoteRequestBody(), ...overrides },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.value.code).toBe('MALFORMED_REQUEST');
  });

  it('says only that the request was not understood, never which rule broke', async () => {
    // The zod message is operator-facing: it names fields, bounds and regexes, which is a map of
    // the validation surface handed to whoever is probing it. The client gets one fixed sentence,
    // and the detail goes to the log line instead.
    const response = await (await serve()).inject({
      method: 'POST',
      url: '/quote',
      headers: DEV_HEADERS,
      payload: { ...quoteRequestBody(), sourceAmount: 'twenty', url: 'https://evil.example' },
    });

    expect(response.json().error.value).toEqual({
      code: 'MALFORMED_REQUEST',
      message: 'The request was not understood.',
    });
  });

  it('mints its own request id rather than taking one from the caller', async () => {
    // The id ties a support conversation to a log line. Read it from the header and a caller can
    // stamp every request with one value, or reuse someone else's, and the audit trail stops
    // identifying anything.
    const response = await (await serve()).inject({
      method: 'GET',
      url: '/no-such-route',
      headers: { ...DEV_HEADERS, 'x-request-id': 'chosen-by-the-caller' },
    });

    expect(response.json().request_id).not.toBe('chosen-by-the-caller');
    expect(response.json().request_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it.each([
    // Meld's quote is source-denominated (fiat), so at most two fraction digits and nine integer
    // digits, the same bound the session's sourceAmount uses.
    '20',
    '20.5',
    '20.50',
    '0.01',
    '999999999',
  ])('accepts the source amount %s', async (amount) => {
    const response = await (await serve()).inject({
      method: 'POST',
      url: '/quote',
      headers: DEV_HEADERS,
      payload: quoteRequestBody({ sourceAmount: amount }),
    });

    expect(response.statusCode).toBe(200);
  });

  it.each([
    ['three fraction digits', '1.005'],
    ['ten integer digits', '1234567890'],
    ['a leading plus', '+20'],
    ['trailing junk', '20x'],
    ['leading junk', 'x20'],
    ['a bare dot', '.'],
    ['an empty string', ''],
  ])('refuses a source amount with %s', async (_label, amount) => {
    const response = await (await serve()).inject({
      method: 'POST',
      url: '/quote',
      headers: DEV_HEADERS,
      payload: quoteRequestBody({ sourceAmount: amount }),
    });

    expect(response.statusCode).toBe(400);
  });

  it('requires authentication, because it spends the operator quota', async () => {
    const response = await (await serve()).inject({ method: 'POST', url: '/quote', payload: quoteRequestBody() });
    expect(response.statusCode).toBe(401);
  });
});

describe('GET /transaction/:id', () => {
  it('forwards the transaction as Meld reported it', async () => {
    const response = await (await serve()).inject({
      method: 'GET',
      url: '/transaction/tx-1',
      headers: DEV_HEADERS,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().transaction).toEqual({ id: 'tx-1', status: 'PENDING' });
  });

  it('requires authentication', async () => {
    const response = await (await serve()).inject({ method: 'GET', url: '/transaction/tx-1' });
    expect(response.statusCode).toBe(401);
  });
});

describe('upstream errors', () => {
  it('degrades a Meld error status to a retryable failure rather than a 500', async () => {
    // A buyer cannot act on "the operator's key is wrong", and a 500 tells them nothing. Boot
    // treats the same error as fatal; only the HTTP layer softens it.
    const app = await serve(() => Promise.reject(new MeldHttpError(401)));

    const response = await app.inject({
      method: 'POST',
      url: '/session',
      headers: DEV_HEADERS,
      payload: createRequest(),
    });

    expect(response.statusCode).toBe(503);
    // The upstream status is for the operator log, not for the buyer, so assert the whole body
    // structurally. `not.toContain('401')` stood here and was flaky at about 0.87%: "401" is
    // three valid hex characters, so roughly one request id in 115 contains it.
    expect(response.json()).toEqual({
      error: { tag: 'ProviderTimeout' },
      request_id: expect.any(String),
    });
  });

  it('maps Meld NO_VALID_QUOTES (400) to a 422 NoQuotesAvailable, not a retryable timeout', async () => {
    // No provider serves this (method, region, asset). Retrying the same request never succeeds,
    // so it must not read as ProviderTimeout.
    const app = await serve(() => Promise.reject(new MeldHttpError(400, 'NO_VALID_QUOTES')));

    const response = await app.inject({
      method: 'POST',
      url: '/session',
      headers: DEV_HEADERS,
      payload: createRequest(),
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({
      error: { tag: 'NoQuotesAvailable' },
      request_id: expect.any(String),
    });
  });

  it('maps a Meld below-minimum message (400) to BelowMinimum with the threshold', async () => {
    // The below-minimum rejection carries only a human message, no error code; the threshold in it
    // is surfaced so a client can show "the minimum is 18.00 EUR".
    const app = await serve(() =>
      Promise.reject(
        new MeldHttpError(400, undefined, 'Source amount is below the minimum allowed, which is 18.00 EUR'),
      ),
    );

    const response = await app.inject({
      method: 'POST',
      url: '/session',
      headers: DEV_HEADERS,
      payload: createRequest(),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: { tag: 'BelowMinimum', value: { amount: '18.00', currency: 'EUR' } },
      request_id: expect.any(String),
    });
  });

  it('maps a Meld above-maximum message (400) to AboveMaximum, upper-casing the currency', async () => {
    // Mirror of below-minimum on the other bound. A lower-case currency in the message must still
    // come back upper-cased, and the threshold parse must be reused.
    const app = await serve(() =>
      Promise.reject(
        new MeldHttpError(400, undefined, 'Source amount is above the maximum allowed, which is 2000.00 usd'),
      ),
    );

    const response = await app.inject({
      method: 'POST',
      url: '/session',
      headers: DEV_HEADERS,
      payload: createRequest(),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: { tag: 'AboveMaximum', value: { amount: '2000.00', currency: 'USD' } },
      request_id: expect.any(String),
    });
  });

  it('maps a below-minimum message with no parseable threshold to a bare BelowMinimum', async () => {
    // When the wording carries no "which is X CUR", the tag still travels, just without a value.
    const app = await serve(() =>
      Promise.reject(new MeldHttpError(400, undefined, 'amount is below the minimum')),
    );

    const response = await app.inject({
      method: 'POST',
      url: '/session',
      headers: DEV_HEADERS,
      payload: createRequest(),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: { tag: 'BelowMinimum' },
      request_id: expect.any(String),
    });
  });

  it('refuses a non-limit Meld 400 as non-retryable, rather than telling the caller to retry', async () => {
    // A 400 means Meld understood the request and declined it: an unsupported payment method
    // for that country, an unserved corridor. Only three such cases are named; the rest would
    // fall through to the 503 degrade, telling the caller to retry a request that can never
    // succeed, which the handler refuses.
    const app = await serve(() => Promise.reject(new MeldHttpError(400, undefined, 'some other problem')));

    const response = await app.inject({
      method: 'POST',
      url: '/session',
      headers: DEV_HEADERS,
      payload: createRequest(),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: { tag: 'Other', value: { code: 'PROVIDER_REJECTED', message: 'The provider declined this request.' } },
      request_id: expect.any(String),
    });
  });

  it('still degrades a Meld 5xx to a retryable ProviderTimeout', async () => {
    // The other half of the split: an outage says nothing about the request, so retrying is
    // exactly the right advice.
    const app = await serve(() => Promise.reject(new MeldHttpError(503, undefined, 'upstream down')));

    const response = await app.inject({
      method: 'POST',
      url: '/session',
      headers: DEV_HEADERS,
      payload: createRequest(),
    });

    expect(response.statusCode).toBe(503);
    expect(response.json().error).toEqual({ tag: 'ProviderTimeout' });
  });
});

describe('POST /session', () => {
  it('creates a session for an allowed product', async () => {
    const response = await (await serve()).inject({
      method: 'POST',
      url: '/session',
      headers: DEV_HEADERS,
      payload: createRequest(),
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual(RESPONSE);
  });

  it.each(['25', '25.0', '25.00', '0.01'])('accepts the whole-number amount %s', async (amount) => {
    // The fraction group is optional. Nothing exercised that, so a regression making it
    // required would have rejected every whole-pound amount silently.
    const response = await (await serve()).inject({
      method: 'POST',
      url: '/session',
      headers: DEV_HEADERS,
      payload: createRequest({ sourceAmount: amount }),
    });

    expect(response.statusCode).toBe(201);
  });

  it.each([
    ['an empty provider', ''],
    ['a provider longer than the bound', 'X'.repeat(49)],
  ])('rejects %s', async (_label, provider) => {
    const response = await (await serve()).inject({
      method: 'POST',
      url: '/session',
      headers: DEV_HEADERS,
      payload: createRequest({ serviceProvider: provider }),
    });

    expect(response.statusCode).toBe(400);
  });

  it('rejects a duplicated product-id header, which arrives as an array', async () => {
    // Two headers of the same name is ordinary HTTP, and the refusal comes from `includes`
    // rather than from the `typeof` check beside it; that one exists to narrow the type. The
    // outcome is what matters here, and it is 401 either way.
    const response = await (await serve()).inject({
      method: 'POST',
      url: '/session',
      headers: { 'x-dev-product-id': ['app.dot', 'app.dot'] as unknown as string },
      payload: createRequest(),
    });

    expect(response.statusCode).toBe(401);
  });

  it('rejects a product that is not allowlisted', async () => {
    // Curation at the money boundary: declaring the funding modality is a manifest edit
    // anyone can make, and it must not earn the right to spend the operator's key.
    const response = await (await serve()).inject({
      method: 'POST',
      url: '/session',
      headers: { 'x-dev-product-id': 'someone-elses-app.dot' },
      payload: createRequest(),
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.value.code).toBe('UNAUTHORIZED');
  });

  it('rejects a caller with no identity at all', async () => {
    const response = await (await serve()).inject({ method: 'POST', url: '/session', payload: createRequest() });
    expect(response.statusCode).toBe(401);
  });

  it.each([
    ['an unknown operation', { op: 'refund' }],
    ['a missing idempotency key', { idempotencyKey: undefined }],
    ['a short idempotency key', { idempotencyKey: 'x' }],
    ['an amount with three fraction digits', { sourceAmount: '25.000' }],
    ['a non-numeric amount', { sourceAmount: 'twenty' }],
    ['a currency that is not three letters', { fiat: 'DOLLARS' }],
    ['an unexpected extra field', { url: 'https://evil.example/api' }],
    ['a field that looks like a proxy instruction', { headers: { authorization: 'BASIC x' } }],
    // The scheme half of the redirect guard, at the wire boundary. Zod 4's `z.url()` accepts all
    // three of these, which is why the schema refines on `protocol` rather than calling it.
    ['a javascript: redirect', { redirectUrl: 'javascript:alert(1)' }],
    ['a data: redirect', { redirectUrl: 'data:text/html,<script>alert(1)</script>' }],
    ['a file: redirect', { redirectUrl: 'file:///etc/passwd' }],
    ['a redirect that is not a URL at all', { redirectUrl: 'app.example/done' }],
  ])('rejects %s with 400', async (_label, overrides) => {
    const response = await (await serve()).inject({
      method: 'POST',
      url: '/session',
      headers: DEV_HEADERS,
      payload: { ...createRequest(), ...overrides },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.value.code).toBe('MALFORMED_REQUEST');
  });

  it('returns the enumerated failure and no operator detail', async () => {
    const app = await serve(async () => {
      throw reject({ tag: 'BelowMinimum' }, '9.99 is below the 10.00 minimum for USDC_ASSETHUB');
    });

    const response = await app.inject({
      method: 'POST',
      url: '/session',
      headers: DEV_HEADERS,
      payload: createRequest({ sourceAmount: '9.99' }),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: { tag: 'BelowMinimum' }, request_id: expect.any(String) });
    // The operator's detail names a configured threshold. Clients get outcomes, never rules.
    expect(response.body).not.toContain('10.00');
  });

  it('turns an unexpected error into a bare 500 that quotes nothing', async () => {
    const app = await serve(async () => {
      throw new Error('Meld said {"apiKey":"leaked-credential-value","detail":"internal"}');
    });

    const response = await app.inject({
      method: 'POST',
      url: '/session',
      headers: DEV_HEADERS,
      payload: createRequest(),
    });

    expect(response.statusCode).toBe(500);
    expect(response.json().error).toEqual({
      tag: 'Other',
      value: { code: 'INTERNAL', message: 'Something went wrong.' },
    });
    expect(response.body).not.toContain('leaked-credential-value');
  });

  it('keeps the standard error body when the thrown value is not an Error', async () => {
    /* A handler rejecting with a non-Error is exactly the case under test: the error handler
       must not assume `.statusCode` or `.message` exist on whatever it caught. */
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    const app = await serve(() => Promise.reject('a bare string'));

    const response = await app.inject({
      method: 'POST',
      url: '/session',
      headers: DEV_HEADERS,
      payload: createRequest(),
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: { tag: 'Other', value: { code: 'INTERNAL', message: 'Something went wrong.' } },
      request_id: expect.any(String),
    });
  });

  it('keeps the standard error body when the JSON body is unparseable', async () => {
    const response = await (await serve()).inject({
      method: 'POST',
      url: '/session',
      headers: { ...DEV_HEADERS, 'content-type': 'application/json' },
      payload: '{"op": "create"',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.value.code).toBe('MALFORMED_REQUEST');
  });

  it('carries a request id on every error, so a support conversation can name one', async () => {
    const response = await (await serve()).inject({ method: 'POST', url: '/session', payload: {} });
    expect(response.json().request_id).toBeTruthy();
  });

  it('refuses a body larger than the limit', async () => {
    const response = await (await serve()).inject({
      method: 'POST',
      url: '/session',
      headers: DEV_HEADERS,
      payload: { ...createRequest(), padding: 'x'.repeat(32 * 1024) },
    });

    expect(response.statusCode).toBe(413);
  });
});

describe('GET /health', () => {
  it('answers ok without authentication', async () => {
    const response = await (await serve()).inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });
});

describe('the funding surface', () => {
  it('answers an unknown funding id with 404, indistinguishably from an unauthorised one', async () => {
    const response = await (await serve()).inject({ method: 'GET', url: '/funding/nope', headers: DEV_HEADERS });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: { tag: 'Other', value: { code: 'NOT_FOUND', message: 'No such funding request.' } },
      request_id: expect.any(String),
    });
  });

  it('refuses a malformed funding id locally rather than asking the store', async () => {
    const response = await (await serve()).inject({ method: 'GET', url: '/funding/abc!x', headers: DEV_HEADERS });

    expect(response.statusCode).toBe(400);
  });

  it('answers an existing funding request with its DTO, carrying no join key', async () => {
    const app = await serve(async () => RESPONSE, config(), {
      // A FundingRecord, which is what `onramp.get` actually returns. `toFundingRequestDto` maps
      // it to the wire shape, so this fixture is snake_case, not the DTO.
      get: async () =>
        fundingRecord({
          wallet_address: ALICE,
          provider_transaction_id: 'tx-1',
          provider_status: 'SUCCEEDED',
          widget_url: 'https://meldcrypto.com/session/meld-1',
          // Populated, not left undefined: `JSON.stringify` drops an undefined property, so an
          // absent value proves nothing about whether the route would have serialised it.
          hosted_widget_url: 'https://meldcrypto.com/s/meldwidget',
          client_reference: 'idem-0000-0001',
          reason: 'BelowMinimum',
          expires_at: 1_800_000_000_000,
          status: 'transaction_seen',
          status_history: [
            { status: 'session_opened', at: 1_700_000_000_000 },
            { status: 'transaction_seen', at: 1_700_000_000_100 },
          ],
          updated_at: 1_700_000_000_100,
        }),
    });

    const response = await app.inject({ method: 'GET', url: '/funding/funding-1', headers: DEV_HEADERS });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      funding: {
        id: 'funding-1',
        rail: 'meld',
        status: 'transaction_seen',
        providerStatus: 'SUCCEEDED',
        destinationCurrencyCode: 'USDC_ASSETHUB',
        walletAddress: ALICE,
        sourceAmount: '25.00',
        fiat: 'USD',
        // Live row, so the surface a buyer resumes at travels with it, over the real route rather
        // than only through the mapper. Terminal rows withhold it; `types.test.ts` covers all five.
        serviceProviderWidgetUrl: 'https://meldcrypto.com/session/meld-1',
        widgetUrl: 'https://meldcrypto.com/s/meldwidget',
        expiresAt: 1_800_000_000_000,
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_100,
        history: [
          { status: 'session_opened', at: 1_700_000_000_000 },
          { status: 'transaction_seen', at: 1_700_000_000_100 },
        ],
      },
    });
    // The rail names itself, and no provider join key reaches the wire: no session id, no
    // transaction id. The settlement surface does, for a live row, which is the point of the
    // change; `types.test.ts` proves all five terminal states withhold it.
    //
    // Keyed, not substring-matched: this fixture's session id is `meld-1` and its settlement URL
    // is `.../session/meld-1`, so a body-substring check answers two questions at once and fails the
    // moment the surface is legitimately present.
    const funding = response.json<{ funding: Record<string, unknown> }>().funding;
    for (const key of ['providerSessionId', 'providerTransactionId', 'clientReference', 'reason']) {
      expect(funding).not.toHaveProperty(key);
    }
    // `providerStatus` is surfaced on purpose (the buyer-facing wording); it is not a join key.
    expect(funding.providerStatus).toBe('SUCCEEDED');
    expect(response.body).not.toContain('tx-1');
    expect(response.body).not.toContain('idem-0000-0001');
    expect(response.body).not.toContain('BelowMinimum');
  });

  it('lists the caller, which the empty serve fixture leaves empty', async () => {
    const response = await (await serve()).inject({ method: 'GET', url: '/funding', headers: DEV_HEADERS });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ fundingRequests: [] });
  });

  it('maps every listed row with the same clock, not with its array index', async () => {
    // `records.map(toFundingRequestDto)` hands `map`'s second argument (the index) in as `now`.
    // Row 0 would be evaluated against a clock of 0 and every later row against 1, 2, 3..., so every
    // row's rail expiry would compare as still in the future and the surface would be offered on
    // rows whose capture page had closed. Point-free is the bug.
    const live = fundingRecord({
      id: 'live-1',
      status: 'session_opened',
      widget_url: 'https://meldcrypto.com/session/live-1',
      // Long past: with a real clock every row must withhold; with the index as the clock, none would.
      expires_at: 1_000,
      client_reference: undefined,
    });
    const app = await serve(undefined, config(), {
      list: async () => [live, fundingRecord({ ...live, id: 'live-2' }), fundingRecord({ ...live, id: 'live-3' })] as never,
    });

    const response = await app.inject({ method: 'GET', url: '/funding', headers: DEV_HEADERS });

    expect(response.statusCode).toBe(200);
    const rows = response.json<{ fundingRequests: Record<string, unknown>[] }>().fundingRequests;
    expect(rows).toHaveLength(3);
    for (const row of rows) expect(row).not.toHaveProperty('serviceProviderWidgetUrl');
  });

  it('maps every listed record through the DTO, so no join key reaches the caller', async () => {
    // The list route was covered only by the empty-array case above, so `records.map(toDto)` ran
    // over nothing: sending the raw rows (alias, provider session and transaction ids, provider
    // status, widget url) left the whole suite green. `/funding/:id` was defended and its
    // sibling was not.
    const record = fundingRecord({
      wallet_address: ALICE,
      provider_session_id: 'meld-secret-1',
      provider_transaction_id: 'tx-secret-1',
      provider_status: 'SUCCEEDED',
      // Deliberately not embedding the session id. The surface is now returned for live rows, so
      // a URL containing `meld-secret-1` would make the body check below pass or fail for two
      // different reasons at once; it is the id leaking that this test is about.
      widget_url: 'https://meldcrypto.com/session/surface-1',
      expires_at: 1_800_000_000_000,
      status: 'transaction_seen',
      updated_at: 1_700_000_000_100,
    });
    const app = await serve(undefined, config(), { list: async () => [record] as never });

    const response = await app.inject({ method: 'GET', url: '/funding', headers: DEV_HEADERS });

    expect(response.statusCode).toBe(200);
    const [funding] = response.json<{ fundingRequests: Record<string, unknown>[] }>().fundingRequests;
    expect(funding).toMatchObject({ id: 'funding-1', rail: 'meld', status: 'transaction_seen' });
    for (const key of ['subject_alias', 'provider_session_id', 'provider_transaction_id', 'provider_status', 'widget_url']) {
      expect(funding).not.toHaveProperty(key);
    }
    // And the live surface is carried: the list is where a client finds a pending purchase to
    // resume, so withholding it there would leave the same buyer stranded one route over.
    expect(funding).toMatchObject({ serviceProviderWidgetUrl: 'https://meldcrypto.com/session/surface-1' });
    // Belt and braces on the serialised body: no join-key value survives either.
    expect(response.body).not.toContain('meld-secret-1');
    expect(response.body).not.toContain('tx-secret-1');
    expect(response.body).not.toContain('alias-abc');
  });

  it('withdraws a request and answers with the row, minus its settlement surface', async () => {
    const cancelled = fundingRecord({
      wallet_address: ALICE,
      widget_url: 'https://meldcrypto.com/session/surface-1',
      expires_at: 1_800_000_000_000,
      status: 'session_opened',
      cancelled_at: 1_700_000_000_500,
    });
    const app = await serve(undefined, config(), { cancel: async () => cancelled });

    const response = await app.inject({
      method: 'POST',
      url: '/funding/funding-1/cancel',
      headers: DEV_HEADERS,
    });

    expect(response.statusCode).toBe(200);
    const { funding } = response.json<{ funding: Record<string, unknown> }>();
    expect(funding).toMatchObject({ id: 'funding-1', cancelledAt: 1_700_000_000_500 });
    // The point of the whole route: the capture page is gone from the answer even though the
    // status is still live. A body still carrying it would mean the cancel changed nothing a
    // buyer's client can see.
    expect(funding).not.toHaveProperty('serviceProviderWidgetUrl');
    expect(response.body).not.toContain('meldcrypto.com');
  });

  it('reads a cancelled-but-live request as live, with the surface withheld and cancelledAt present', async () => {
    // The whole point of the feature, pinned at the layer a client actually consumes. A cancelled
    // `session_opened` row is not terminal (the worker keeps watching so a payment already in
    // flight can still settle), and the read route must say exactly that: the status is still live,
    // `cancelledAt` tells the buyer they withdrew it, and the capture page is gone from every
    // answer. Without the cancel-withhold, this row would answer exactly like a live one, which is
    // the defect the route exists to close.
    const cancelled = fundingRecord({
      wallet_address: ALICE,
      widget_url: 'https://meldcrypto.com/session/surface-1',
      expires_at: 1_800_000_000_000,
      status: 'session_opened',
      cancelled_at: 1_700_000_000_500,
    });
    const app = await serve(undefined, config(), { get: async () => cancelled });

    const response = await app.inject({ method: 'GET', url: '/funding/funding-1', headers: DEV_HEADERS });

    expect(response.statusCode).toBe(200);
    const { funding } = response.json<{ funding: Record<string, unknown> }>();
    expect(funding).toMatchObject({ id: 'funding-1', status: 'session_opened', cancelledAt: 1_700_000_000_500 });
    // The surface is gone; `expiresAt` goes with it, because a withheld capture page must not
    // still advertise an expiry. "Still live" is about the observation, not the page.
    expect(funding).not.toHaveProperty('serviceProviderWidgetUrl');
    expect(funding).not.toHaveProperty('widgetUrl');
    expect(funding).not.toHaveProperty('expiresAt');
    expect(response.body).not.toContain('meldcrypto.com');
  });

  it('lists a cancelled-but-live request with the surface withheld and cancelledAt present', async () => {
    // The list route maps through the same DTO, so it must agree with the read route: a resumed
    // client finds the cancelled row in its funding list and must see the same "you withdrew this,
    // and nothing is payable" shape, not a live page it can reopen.
    const cancelled = fundingRecord({
      wallet_address: ALICE,
      widget_url: 'https://meldcrypto.com/session/surface-1',
      expires_at: 1_800_000_000_000,
      status: 'session_opened',
      cancelled_at: 1_700_000_000_500,
    });
    const app = await serve(undefined, config(), { list: async () => [cancelled] as never });

    const response = await app.inject({ method: 'GET', url: '/funding', headers: DEV_HEADERS });

    expect(response.statusCode).toBe(200);
    const rows = response.json<{ fundingRequests: Record<string, unknown>[] }>().fundingRequests;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'funding-1', status: 'session_opened', cancelledAt: 1_700_000_000_500 });
    expect(rows[0]).not.toHaveProperty('serviceProviderWidgetUrl');
    expect(rows[0]).not.toHaveProperty('widgetUrl');
    expect(rows[0]).not.toHaveProperty('expiresAt');
    expect(response.body).not.toContain('meldcrypto.com');
  });

  it('accepts a body-less cancel that still declares a JSON content type', async () => {
    // Fastify's own parser answers `FST_ERR_CTP_EMPTY_JSON_BODY` here, a `400` naming a body the
    // caller was right not to send. One shared fetch wrapper setting `content-type` on every call
    // is all it takes, and the route it would break is the one that withdraws a payable surface.
    const cancelled = fundingRecord({ status: 'session_opened', cancelled_at: 1_700_000_000_500 });
    const app = await serve(undefined, config(), { cancel: async () => cancelled });

    const response = await app.inject({
      method: 'POST',
      url: '/funding/funding-1/cancel',
      headers: { ...DEV_HEADERS, 'content-type': 'application/json' },
    });

    expect(response.statusCode).toBe(200);
  });

  it('still refuses a body that is not JSON, without quoting it back', async () => {
    // The other half of the custom parser. Loosening the empty case must not loosen this one, and
    // the framework's own message echoes the offending body, which is caller-controlled.
    const app = await serve();

    const response = await app.inject({
      method: 'POST',
      url: '/quote',
      headers: { ...DEV_HEADERS, 'content-type': 'application/json' },
      payload: '{"country": "US"',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.value.code).toBe('MALFORMED_REQUEST');
    expect(response.body).not.toContain('country');
  });

  it('answers 404 for a request that is not the caller\'s, exactly as the read route does', async () => {
    // Same body and same status as an unknown id, so cancelling is not an existence oracle either.
    const app = await serve(undefined, config(), { cancel: async () => undefined });

    const response = await app.inject({
      method: 'POST',
      url: '/funding/funding-1/cancel',
      headers: DEV_HEADERS,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { value: { code: 'NOT_FOUND' } } });
  });
});

describe('the widget return landing', () => {
  it('serves framable HTML with no auth, because the buyer lands here with no header', async () => {
    // Meld redirects the buyer's browser here inside the payment iframe. There is no Authorization
    // header on a top-level navigation the rail performs, so requiring one would leave the buyer
    // staring at a JSON error where the app expects a page.
    const app = await serve();

    const response = await app.inject({ method: 'GET', url: '/meld/return' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toMatch(/text\/html/);
    // The whole reason this page exists on this origin: it must frame. A gateway-served page
    // carries `X-Frame-Options: sameorigin` and renders blank inside Meld's iframe.
    expect(response.headers['x-frame-options']).toBeUndefined();
    expect(response.body).toContain('meld:paid');
  });

  it('carries no funding state, so framing it discloses nothing', async () => {
    // It is deliberately unauthenticated and therefore readable by anyone who can guess the URL,
    // including any site that frames it. That is only acceptable while the page says nothing: no
    // id, no amount, no status. The message it posts is a bare signal, and the app's own poll
    // remains the authoritative settlement.
    const app = await serve();

    const body = (await app.inject({ method: 'GET', url: '/meld/return' })).body;

    for (const leak of ['fundingRequestId', 'sourceAmount', 'walletAddress', 'settled', 'alias']) {
      expect(body).not.toContain(leak);
    }
  });
});

describe('what the router rejects before the lifecycle begins', () => {
  // Fastify answers a malformed path from the router itself, so neither `setErrorHandler` nor
  // `setNotFoundHandler` sees it; neither does the rate limiter, whose hook is `onRequest`.
  // Left alone these answered with Fastify's own body: `error` a bare string, no `request_id`,
  // and the requested path echoed back. That is the exact defect `setNotFoundHandler` exists to
  // fix, one code path over.
  it('answers a malformed URL escape with the contract body, not Fastify\'s', async () => {
    const app = await serve();

    const response = await app.inject({ method: 'GET', url: '/transaction/%zz', headers: DEV_HEADERS });

    expect(response.statusCode).toBe(400);
    const body = response.json<{ error: { tag: string; value: { code: string } }; request_id: string }>();
    expect(body.error).toEqual({
      tag: 'Other',
      value: { code: 'MALFORMED_REQUEST', message: 'The request was not understood.' },
    });
    expect(body.request_id).toMatch(/^[0-9a-f-]{36}$/);
    // The caller's own path is not reflected back to them.
    expect(JSON.stringify(body)).not.toContain('%zz');
  });

  it('accepts a transaction id at the full length the schema permits', async () => {
    // The schema bounds an id at 128; Fastify's `maxParamLength` default is 100, so a legitimate
    // Meld id of 101-128 characters was refused by the router with `414` before any of this
    // service's own validation ran.
    const id = 'a'.repeat(128);
    let reached: string | undefined;
    const app = await serve(undefined, config(), {
      transaction: async () => {
        reached = id;
        return { transaction: { id } };
      },
    });

    const response = await app.inject({ method: 'GET', url: `/transaction/${id}`, headers: DEV_HEADERS });

    expect(response.statusCode).toBe(200);
    expect(reached).toBe(id);
  });

  it('still refuses an id past the schema bound, as a refusal rather than a router error', async () => {
    const app = await serve();

    const response = await app.inject({
      method: 'GET',
      url: `/transaction/${'a'.repeat(129)}`,
      headers: DEV_HEADERS,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { value: { code: string } } }>().error.value.code).toBe('MALFORMED_REQUEST');
  });
});

describe('the threshold pulled out of a Meld limit message', () => {
  const belowMinimum = (detail: string) => new MeldHttpError(400, undefined, detail);

  it('forwards a well-formed amount so the buyer can act on the refusal', async () => {
    const app = await serve(() => Promise.reject(belowMinimum('Amount is below the minimum allowed, which is 18.00 EUR')));

    const response = await app.inject({ method: 'POST', url: '/session', payload: createRequest(), headers: DEV_HEADERS });

    expect(response.json<{ error: unknown }>().error).toEqual({
      tag: 'BelowMinimum',
      value: { amount: '18.00', currency: 'EUR' },
    });
  });

  it('drops a number that is not an amount rather than putting it on the wire', async () => {
    // `[\d.]+` matched `1.2.3` and emitted it under a field the contract types as a decimal, for
    // a client to try to render. Dropping an unreadable number is already the correct fallback:
    // the buyer still sees a below-minimum refusal, just without the figure.
    const app = await serve(() => Promise.reject(belowMinimum('Amount is below the minimum allowed, which is 1.2.3 EUR')));

    const response = await app.inject({ method: 'POST', url: '/session', payload: createRequest(), headers: DEV_HEADERS });

    expect(response.json<{ error: unknown }>().error).toEqual({ tag: 'BelowMinimum' });
  });
});

describe('the discovery routes', () => {
  it('GET /supported returns the corridor for the (country, fiat, crypto)', async () => {
    const built = await serve();
    const response = await built.inject({
      method: 'GET',
      url: '/supported?country=US&destinationCurrencyCode=DOT_ASSETHUB',
      headers: DEV_HEADERS,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ country: 'US', fiat: 'USD', methods: [] });
  });

  it('GET /supported/countries returns the region catalog under a `countries` key', async () => {
    const built = await serve();
    const response = await built.inject({
      method: 'GET',
      url: '/supported/countries?destinationCurrencyCode=DOT_ASSETHUB',
      headers: DEV_HEADERS,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ countries: [] });
  });
});
