import { afterEach, describe, expect, it, vi } from 'vitest';

import { Refusal } from '../../src/contract.js';
import { MeldClient, MeldHttpError } from '../../src/meld/client.js';
import { Secret } from '../../src/secret.js';

const KEY = 'meld-test-key-not-a-real-credential';
const VERSION = '2025-01-01';
const client = () => new MeldClient('https://api-sb.meld.io', new Secret(KEY), VERSION, 1_000);

/** Stub `fetch` with a JSON response and return the mock, for asserting the request sent. */
const stub = (status: number, body: unknown) => {
  const fn = vi.fn(
    async (_url: string | URL, _init?: RequestInit) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
  );
  vi.stubGlobal('fetch', fn);
  return fn;
};

/**
 * Stub `fetch` with a body given as exact bytes.
 *
 * `stub` goes through `JSON.stringify`, which cannot express the difference between the bare
 * number `21.47` and the string `"21.47"`, and that difference is the whole point of the
 * exactness tests below.
 */
const stubRaw = (status: number, body: string) => {
  const fn = vi.fn(
    async (_url: string | URL, _init?: RequestInit) =>
      new Response(body, { status, headers: { 'content-type': 'application/json' } }),
  );
  vi.stubGlobal('fetch', fn);
  return fn;
};

/** Stub `fetch` with a transport failure, as a timeout or a refused connection appears. */
const stubNetworkFailure = (message: string) => {
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error(message))));
};

const sentUrl = (fn: ReturnType<typeof stub>): string => {
  const url = fn.mock.calls[0]?.[0];
  if (url === undefined) throw new Error('fetch was never called');
  return String(url);
};

const sentMethod = (fn: ReturnType<typeof stub>): string | undefined => sentInit(fn).method;

const sentBody = (fn: ReturnType<typeof stub>): Record<string, unknown> =>
  JSON.parse(sentInit(fn).body as string) as Record<string, unknown>;

const sentInit = (fn: ReturnType<typeof stub>): RequestInit => {
  const init = fn.mock.calls[0]?.[1];
  if (!init) throw new Error('fetch was never called');
  return init;
};

afterEach(() => vi.unstubAllGlobals());

describe('the request timeout', () => {
  it('aborts a request Meld never answers', async () => {
    // Meld holding a connection open is not a failure `fetch` reports on its own. Without the
    // signal the await never settles: the request handler, its funding row and the caller's
    // browser all wait on a socket that will never speak, and `server.request_timeout_ms` is
    // documented as the outer bound on exactly this.
    const fn = vi.fn(
      async (_url: string | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new Error('This operation was aborted'));
          });
        }),
    );
    vi.stubGlobal('fetch', fn);

    const slow = new MeldClient('https://api-sb.meld.io', new Secret(KEY), VERSION, 500);
    await expect(slow.quote(probe())).rejects.toThrow(/meld/i);
  }, 10_000);

  it('aborts at the configured bound, not at a built-in one', async () => {
    // The test above proves an abort happens; it does not prove when. Replacing the
    // configured timeout with a literal `1_000` survived the whole suite, because the fake only
    // ever rejects on abort and fires in time either way, so the constructor argument was dead
    // and nothing said so. `startup.test.ts` already does this check for the server's own
    // timeout; this is the same wiring question one layer down.
    //
    // The two bounds are far enough apart that scheduler jitter cannot confuse them, and the
    // elapsed time is measured rather than the mere fact of rejection.
    const fn = vi.fn(
      async (_url: string | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new Error('This operation was aborted'));
          });
        }),
    );
    vi.stubGlobal('fetch', fn);

    const started = Date.now();
    const brief = new MeldClient('https://api-sb.meld.io', new Secret(KEY), VERSION, 120);
    await expect(brief.quote(probe())).rejects.toThrow(/meld/i);
    const elapsed = Date.now() - started;

    // A band, not a ceiling. `toBeLessThan(400)` alone would also pass against a hardcoded 1ms
    // timeout, which is the opposite mistake from the one this test exists to catch; the lower
    // bound is what says the configured value was actually honoured.
    expect(elapsed).toBeGreaterThanOrEqual(100);
    expect(elapsed).toBeLessThan(400);
  }, 10_000);
});

describe('createWidgetSession', () => {
  const session = { id: 'meld-1', serviceProviderWidgetUrl: 'https://meldcrypto.com/session/1' };

  it('sends the Meld-Version header, which every call requires', async () => {
    const fetchMock = stub(200, session);
    await client().createWidgetSession(params());

    expect((sentInit(fetchMock).headers as Record<string, string>)['Meld-Version']).toBe(VERSION);
  });

  it('sends the version it was configured with, not a built-in one', async () => {
    // `VERSION` is the same literal the source could be hardcoded to, and hardcoding it did
    // survive the suite, here and in the e2e fake, which uses the same string. A version the
    // fixture does not share is the only thing that distinguishes "configured" from "constant".
    const fetchMock = stub(200, session);
    await new MeldClient('https://api-sb.meld.io', new Secret(KEY), '2030-12-31', 1_000).createWidgetSession(
      params(),
    );

    expect((sentInit(fetchMock).headers as Record<string, string>)['Meld-Version']).toBe('2030-12-31');
  });

  it('authenticates with the literal word BASIC, not HTTP Basic auth', async () => {
    const fetchMock = stub(200, session);
    await client().createWidgetSession(params());

    const headers = sentInit(fetchMock).headers as Record<string, string>;
    // Meld's scheme is the word BASIC followed by the raw key. Base64-encoding it, or
    // switching to `Basic`, is a plausible "fix" that breaks every request.
    expect(headers.authorization).toBe(`BASIC ${KEY}`);
  });

  it('sends the destination and address locked, so the buyer cannot be walked elsewhere', async () => {
    const fetchMock = stub(200, session);
    await client().createWidgetSession(params());

    const body: unknown = JSON.parse(sentInit(fetchMock).body as string);
    // Verified against Meld's OpenAPI schema: fields are locked via a `lockFields` ENUM ARRAY on
    // sessionData, not per-field `*Locked` booleans (those are silently ignored). The list names all the
    // fields Meld will take, all six of them, which is the entire vocabulary it enumerates when
    // you send a seventh. `countryCode` is deliberately absent. It is sent in `sessionData` but is
    // not lockable under any name (verified live).
    // `toEqual`, not `toMatchObject`, and the whole body. The partial form pinned five fields and
    // none of the four terms that bound the charge, so deleting `sourceAmount` from the request
    // survived all 861 tests: `lockFields` still named it, so the suite stayed green while the
    // amount was no longer sent and therefore no longer locked, and the buyer picks it inside
    // Meld's own flow. A lock over a field that is not in the request locks nothing.
    expect(body).toEqual({
      sessionType: 'BUY',
      sessionData: {
        destinationCurrencyCode: 'USDC_ASSETHUB',
        walletAddress: '1abc',
        sourceAmount: '25.00',
        sourceCurrencyCode: 'USD',
        countryCode: 'US',
        paymentMethodType: 'CREDIT_DEBIT_CARD',
        lockFields: [
          'cryptoCurrency',
          'destinationCurrencyCode',
          'walletAddress',
          'sourceAmount',
          'sourceCurrencyCode',
          'paymentMethodType',
        ],
        // Forwarded so Meld can correlate (and deduplicate, if it turns out to).
        externalCustomerId: 'idem-0000-0001',
      },
      externalSessionId: 'idem-0000-0001',
    });
  });

  it('files the reference as a top-level externalSessionId, not only inside sessionData', async () => {
    // The placement is the whole point. A live-sandbox probe found `sessionData.externalCustomerId` comes
    // back `null` on every transaction while a top-level `externalSessionId` round-trips. So a
    // reference nested one level too deep is a join that silently never resolves, and the worker
    // then expires paid purchases at the 24h deadline.
    const fetchMock = stub(200, session);
    await client().createWidgetSession(params());

    const body = sentBody(fetchMock) as { externalSessionId?: unknown; sessionData: Record<string, unknown> };
    expect(body.externalSessionId).toBe('idem-0000-0001');
    // And still in sessionData, which is what the operator's own Meld dashboard shows.
    expect(body.sessionData.externalCustomerId).toBe('idem-0000-0001');
  });

  it('forwards a redirectUrl into sessionData, and omits the key entirely without one', async () => {
    const withRedirect = stub(200, session);
    await client().createWidgetSession({ ...params(), redirectUrl: 'https://app.example/done' });
    expect(sentBody(withRedirect)).toMatchObject({ sessionData: { redirectUrl: 'https://app.example/done' } });

    vi.unstubAllGlobals();
    const without = stub(200, session);
    await client().createWidgetSession(params());
    // Absent, not null: Meld rejects a null `serviceProvider`, so an explicit null is not a safe
    // way to say "no value" on this endpoint.
    expect((sentBody(without) as { sessionData: Record<string, unknown> }).sessionData).not.toHaveProperty(
      'redirectUrl',
    );
  });

  it.each([
    ['an empty session id', { id: '', serviceProviderWidgetUrl: 'https://widget.example/s/1' }],
    ['a settlement URL that is not a URL', { id: 'meld-1', serviceProviderWidgetUrl: 'not-a-url' }],
  ])('refuses %s rather than passing it on', async (_label, body) => {
    // `RailSession` makes `settlementUrl` and `providerSessionId` required precisely so a session
    // with no buyer-facing surface cannot be reported as created. `test/meld/rail.test.ts` says
    // the hollow case is unreachable because these two bounds exist, and that claim had no test
    // behind it, so `''` satisfied `string` and would have flowed all the way to a 201.
    stub(200, body);

    await expect(client().createWidgetSession(params())).rejects.toThrow(/session/i);
  });

  it('omits serviceProvider entirely when none is named, rather than sending null', async () => {
    // The one thing observed about this field is that Meld rejects a null `serviceProvider`.
    // Null is never sent (the key is dropped), so an absent provider is a different request from
    // the one known to fail. Pinned so nobody "fixes" the optional field into an explicit null.
    const fetchMock = stub(200, session);
    await client().createWidgetSession(params());

    const body = sentBody(fetchMock) as { sessionData: Record<string, unknown> };
    expect(body.sessionData).not.toHaveProperty('serviceProvider');
  });

  it('sends the pinned provider when one is named', async () => {
    const fetchMock = stub(200, session);
    await client().createWidgetSession({ ...params(), serviceProvider: 'KOYWE' });

    expect(sentBody(fetchMock)).toMatchObject({ sessionData: { serviceProvider: 'KOYWE' } });
  });

  it('omits the provider entirely when none is named, so Meld chooses', async () => {
    // Absent rather than null or empty: sending an empty value would pin nothing and might
    // not mean "choose for me".
    const fetchMock = stub(200, session);
    await client().createWidgetSession(params());

    // Scoped to `sessionData`, where the field actually lives. Asserted against the top level it
    // could not fail (`serviceProvider` is never there), so it passed even when the client sent
    // `sessionData.serviceProvider: null`, the one shape Meld is known to reject.
    const body = sentBody(fetchMock) as { sessionData: Record<string, unknown> };
    expect(body.sessionData).not.toHaveProperty('serviceProvider');
  });

  it.each([
    ['a free-text date', '"sometime next week"'],
    ['epoch seconds, which would read as 1970', '1767225600'],
    ['an ISO stamp with no offset, which means a different instant per deployment', '"2026-01-01T00:00:00"'],
    ['a four-digit year Date.parse would happily expand', '"2026"'],
    ['a magnitude no Date can hold', '1e30'],
    // Passes the format regex (four digits, two, two, a `T`, digits and colons, a `Z`) and
    // `Date.parse` still answers NaN, which is why the shape check is not the whole guard.
    ['an ISO-shaped stamp with impossible components', '"2026-13-45T99:99:99Z"'],
    ['the epoch itself', '0'],
    ['a negative instant', '-1'],
  ])('drops %s rather than passing a guess downstream', async (_label, literal) => {
    // Each of these was forwarded confidently before. The consumer's session machine reads this
    // field directly, so a wrong value either kills a live widget or walks a buyer into an
    // expired Meld session with card details already entered. Absent is the honest answer.
    stubRaw(
      200,
      `{"id":"meld-1","serviceProviderWidgetUrl":"https://widget.meld.io/s/abc","expiresAt":${literal}}`,
    );

    expect(await client().createWidgetSession(params())).not.toHaveProperty('expiresAt');
  });

  it.each([
    ['epoch milliseconds', '1800000000000', 1_800_000_000_000],
    ['an ISO stamp with a Z offset', '"2027-01-01T00:00:00.000Z"', Date.parse('2027-01-01T00:00:00.000Z')],
    ['an ISO stamp with a numeric offset', '"2027-01-01T00:00:00+02:00"', Date.parse('2027-01-01T00:00:00+02:00')],
  ])('accepts %s', async (_label, literal, expected) => {
    stubRaw(
      200,
      `{"id":"meld-1","serviceProviderWidgetUrl":"https://widget.meld.io/s/abc","expiresAt":${literal}}`,
    );

    expect((await client().createWidgetSession(params())).expiresAt).toBe(expected);
  });

  it("carries Meld's own hosted widget URL back to the caller", async () => {
    // Meld returns two surfaces and they are not the same page: `serviceProviderWidgetUrl` is
    // the provider's capture page (Transak), `widgetUrl` is Meld's own hosted widget. A product
    // that embeds Meld's flow opens the second, and this is the only line that maps it; every
    // other fixture in this file omits the field, so deleting the mapping changed nothing.
    stub(200, { ...session, widgetUrl: 'https://meldcrypto.com/w/1' });

    const opened = await client().createWidgetSession(params());
    expect(opened.meldWidgetUrl).toBe('https://meldcrypto.com/w/1');
    // And the provider page is still its own field: collapsing the two would hand a caller the
    // wrong page under the name it embeds.
    expect(opened.serviceProviderWidgetUrl).toBe(session.serviceProviderWidgetUrl);
  });

  it.each([
    ['is absent', {}],
    ['is null, which is what Meld sends when it has none', { widgetUrl: null }],
  ])('omits the hosted widget URL when it %s', async (_label, extra) => {
    // Absent rather than an empty string: the field is optional on the wire precisely so a
    // caller can tell "Meld has no hosted widget for this session" from "here is one".
    stub(200, { ...session, ...extra });

    expect(await client().createWidgetSession(params())).not.toHaveProperty('meldWidgetUrl');
  });

  it('refuses a session whose hosted widget URL is not a URL at all', async () => {
    // `widgetUrl` is typed `z.url()`, not "any string". A value that is not a URL is a response
    // unreadable rather than a field to shrug off, because the caller puts it in a WebView.
    stub(200, { ...session, widgetUrl: 'not-a-url' });

    await expect(client().createWidgetSession(params())).rejects.toThrow(/unreadable session/);
  });

  it('refuses a response missing the fields we forward', async () => {
    stub(200, { id: 'meld-1' });
    await expect(client().createWidgetSession(params())).rejects.toThrow(/unreadable session/);
  });

  it.each([401, 403, 404, 429, 500])('reports HTTP %i as an answer, with the status', async (status) => {
    // The client does not decide what a buyer is told; it reports precisely and lets the
    // caller choose. The HTTP layer degrades this to a retryable failure, and boot treats the
    // same error as fatal. See server.test.ts and main.ts.
    stub(status, { message: 'nope' });
    const error = await client().createWidgetSession(params()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MeldHttpError);
    expect((error as MeldHttpError).status).toBe(status);
  });

  it('carries Meld\'s error code and message from the response body', async () => {
    // Both are read so the HTTP layer can tell "no offer" (code) and "below minimum" (message)
    // apart from a genuine outage; the status alone cannot.
    stub(400, { error: 'NO_VALID_QUOTES', message: 'No Valid Quote Combinations Found.' });
    const error = (await client()
      .createWidgetSession(params())
      .catch((e: unknown) => e)) as MeldHttpError;
    expect(error.code).toBe('NO_VALID_QUOTES');
    expect(error.detail).toBe('No Valid Quote Combinations Found.');
  });

  it('leaves code and detail undefined when the error body carries neither', async () => {
    stub(400, { something: 'unrelated' });
    const error = (await client()
      .createWidgetSession(params())
      .catch((e: unknown) => e)) as MeldHttpError;
    expect(error.code).toBeUndefined();
    expect(error.detail).toBeUndefined();
  });

  it.each([
    ['an HTML error page', '<html>gateway timeout</html>'],
    ['an empty body', ''],
    ['truncated JSON', '{"id":"meld-1"'],
  ])('turns a 200 carrying %s into a provider failure, quoting none of it', async (_label, body) => {
    // Response.json() throws on all three. Unhandled, that becomes a 500 with an upstream
    // payload in the log, so it is caught at the client boundary and the text is dropped.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200 })));

    const error = (await client()
      .createWidgetSession(params())
      .catch((e: unknown) => e)) as Refusal;

    expect(error).toBeInstanceOf(Refusal);
    expect(error.failure).toEqual({ tag: 'ProviderTimeout' });
    expect(error.message).not.toContain('html');
    expect(error.message).not.toContain('gateway');
  });

  it('never quotes the key in a network error, whose message reaches the operator log', async () => {
    stubNetworkFailure('ECONNREFUSED');
    const error = (await client()
      .createWidgetSession(params())
      .catch((e: unknown) => e)) as Error;
    expect(error.message).toContain('ECONNREFUSED');
    expect(error.message).not.toContain(KEY);
  });
});

describe('quote', () => {
  it('sends every field Meld needs to price the offer', async () => {
    const fetchMock = stub(200, { quotes: [] });
    await client().quote(probe());

    expect(sentBody(fetchMock)).toEqual({
      countryCode: 'US',
      sourceCurrencyCode: 'USD',
      destinationCurrencyCode: 'USDC_ASSETHUB',
      sourceAmount: '20',
      paymentMethodType: 'CREDIT_DEBIT_CARD',
    });
  });

  it('returns an empty list when Meld answers without a quotes key at all', async () => {
    // An uncontrolled shape. Returning undefined here would push a crash into the caller.
    stub(200, {});
    expect(await client().quote(probe())).toEqual([]);
  });

  it('returns an empty list when Meld answers with a null quotes key', async () => {
    stub(200, { quotes: null });
    expect(await client().quote(probe())).toEqual([]);
  });

  it('forwards the fee breakdown untouched', async () => {
    stub(200, {
      quotes: [
        {
          serviceProvider: 'TRANSAK',
          sourceAmount: 21.47,
          sourceCurrencyCode: 'USD',
          destinationAmount: 20,
          destinationCurrencyCode: 'USDC_ASSETHUB',
          totalFee: 1.47,
          transactionFee: 0.19,
          networkFee: 0.28,
          partnerFee: 1,
          exchangeRate: 0.9315,
        },
      ],
    });

    const [offer] = await client().quote(probe());
    // Strings, and byte-identical to what Meld wrote. `response.json()` would have made these
    // doubles, and the round-trip back out is not identity.
    expect(offer).toMatchObject({
      totalFee: '1.47',
      networkFee: '0.28',
      partnerFee: '1',
      exchangeRate: '0.9315',
    });
  });

  it.each([
    ['a trailing zero', '20.00'],
    ['a sub-cent fee that JSON.stringify would give an exponent', '0.0000001'],
    ['more precision than a double holds', '9007199254740993'],
    ['DOT-scale precision', '20.0000000001'],
  ])('preserves %s exactly', async (_label, literal) => {
    // Each of these was silently altered before: 20.00 -> 20, 0.0000001 -> 1e-7,
    // 9007199254740993 -> ...992. They are the numbers the deposit arithmetic closes over.
    stubRaw(
      200,
      `{"quotes":[{"serviceProvider":"P","sourceAmount":${literal},"sourceCurrencyCode":"USD",` +
        `"destinationAmount":"1","destinationCurrencyCode":"USDC_ASSETHUB"}]}`,
    );

    const [offer] = await client().quote(probe());
    expect(offer?.sourceAmount).toBe(literal);
  });

  it('keeps a field it does not know about, rather than dropping it', async () => {
    // The client may need something Meld adds later; bounded passthrough means unknown fields
    // survive the hop even though nothing here depends on them.
    stub(200, {
      quotes: [
        {
          serviceProvider: 'TRANSAK',
          sourceAmount: 1,
          sourceCurrencyCode: 'USD',
          destinationAmount: 1,
          destinationCurrencyCode: 'USDC_ASSETHUB',
          rampIntelligence: { rampScore: 21.66 },
        },
      ],
    });

    // The field survives. Its number arrives as the exact text Meld sent, because a proxy
    // cannot tell which unknown field is money, so all of them keep their digits.
    expect((await client().quote(probe()))[0]).toMatchObject({
      rampIntelligence: { rampScore: '21.66' },
    });
  });

  it.each([
    ["bare numbers, as Meld's docs suggest", '21.47', '1.47'],
    ['quoted decimal strings, as the consumer assumes', '"21.47"', '"1.47"'],
  ])('reads a quote whose amounts are %s', async (_label, sourceAmount, totalFee) => {
    // Nobody has seen a live Meld quote, so both wire forms are accepted, and both reach the
    // consumer as the same exact decimal string, which is the form its own model assumes.
    stubRaw(
      200,
      `{"quotes":[{"serviceProvider":"TRANSAK","sourceAmount":${sourceAmount},` +
        `"sourceCurrencyCode":"USD","destinationAmount":${sourceAmount},` +
        `"destinationCurrencyCode":"DOT_ASSETHUB","totalFee":${totalFee}}]}`,
    );

    const [offer] = await client().quote(probe());
    expect(offer).toMatchObject({ sourceAmount: '21.47', totalFee: '1.47' });
  });

  it('serves the readable offers and drops only the unreadable one', async () => {
    // The defect this replaces: `z.array(quoteSchema)` parsed the array as a unit, so one
    // provider missing `sourceAmount` turned two working offers into a 503 telling the buyer to
    // retry something that would never change. Offers come from independent providers.
    stub(200, {
      quotes: [
        {
          serviceProvider: 'GOOD',
          sourceAmount: '20',
          sourceCurrencyCode: 'USD',
          destinationAmount: '19.5',
          destinationCurrencyCode: 'USDC_ASSETHUB',
        },
        { serviceProvider: 'PARTIAL', sourceCurrencyCode: 'USD' },
        {
          serviceProvider: 'ALSO_GOOD',
          sourceAmount: '21',
          sourceCurrencyCode: 'USD',
          destinationAmount: '19.4',
          destinationCurrencyCode: 'USDC_ASSETHUB',
        },
      ],
    });

    const offers = await client().quote(probe());
    expect(offers.map((o) => o.serviceProvider)).toEqual(['GOOD', 'ALSO_GOOD']);
  });

  it('treats every offer being unreadable as an upstream failure', async () => {
    // One bad provider is that provider's problem; all of them is a changed response shape.
    stub(200, { quotes: [{ serviceProvider: 'TRANSAK' }, { serviceProvider: 'KOYWE' }] });
    await expect(client().quote(probe())).rejects.toThrow(/2 quotes, none readable/);
  });
});

describe('the outbound request line', () => {
  /**
   * The URL and the verb, which every other test in this file took for granted.
   *
   * Both endpoint paths could be blanked to `''` and both `'POST'`s dropped with the suite still
   * green: `new URL('', base)` is just `base`, and `fetch` defaults to GET. These are the two
   * strings that have to match Meld exactly, and the assertions were all about the body.
   */
  const session = { id: 'm', serviceProviderWidgetUrl: 'https://widget.meld.io/s/1' };

  it('refuses to follow an upstream redirect', async () => {
    // `/quote` and `/transaction/:id` forward Meld's body to the caller close to verbatim, so
    // following a redirect would forward some other host's body through them. `redirect: 'error'`
    // is the whole control, and nothing asserted it: the option could be dropped, or set to
    // `follow`, with the suite green.
    const fetchMock = stub(200, { quotes: [] });
    await client().quote(probe());

    expect(sentInit(fetchMock).redirect).toBe('error');
  });

  it('POSTs a quote to /payments/crypto/quote', async () => {
    const fetchMock = stub(200, { quotes: [] });
    await client().quote(probe());

    expect(sentUrl(fetchMock)).toBe('https://api-sb.meld.io/payments/crypto/quote');
    expect(sentMethod(fetchMock)).toBe('POST');
  });

  it('POSTs a session to /crypto/session/widget', async () => {
    const fetchMock = stub(200, session);
    await client().createWidgetSession(params());

    expect(sentUrl(fetchMock)).toBe('https://api-sb.meld.io/crypto/session/widget');
    expect(sentMethod(fetchMock)).toBe('POST');
  });

  it('GETs a transaction from /payments/transactions/:id', async () => {
    const fetchMock = stub(200, { id: 'tx-1' });
    await client().transaction('tx-1');

    expect(sentUrl(fetchMock)).toBe('https://api-sb.meld.io/payments/transactions/tx-1');
    expect(sentMethod(fetchMock)).toBe('GET');
  });

  it.each([
    ['a quote', async () => client().quote(probe()), { quotes: [] }],
    ['a session', async () => client().createWidgetSession(params()), session],
  ])('declares JSON on the POST body for %s', async (_label, call, body) => {
    // Meld would reject a JSON body sent with no content-type. Nothing asserted the POST sends
    // the header (only that the GET omits it), so all three mutants on that line survived.
    const fetchMock = stub(200, body);
    await call();

    expect(sentInit(fetchMock).headers).toMatchObject({ 'content-type': 'application/json' });
  });
});

describe('transaction', () => {
  it('sends no body and no content-type on the GET', async () => {
    // A GET carrying a JSON content-type and no body is the kind of thing a gateway rejects
    // for reasons that take an afternoon to find.
    const fetchMock = stub(200, { id: 'tx-1', status: 'PENDING' });
    await client().transaction('tx-1');

    const init = sentInit(fetchMock);
    expect(init.body).toBeUndefined();
    expect(init.headers).not.toHaveProperty('content-type');
  });

  it('refuses a transaction body it cannot read', async () => {
    // The whole `transactionResponse` schema could be replaced with accept-anything and nothing
    // failed. If Meld wraps the record (`{transaction: {...}}`), this is the test that says so
    // on first contact rather than a 503 nobody can explain.
    stub(200, { transaction: { id: 'tx-1', status: 'PENDING' } });
    await expect(client().transaction('tx-1')).rejects.toThrow(/unreadable transaction/);
  });

  it('forwards the status verbatim, treating it as opaque', async () => {
    stub(200, { id: 'tx-1', status: 'A_STATUS_NOBODY_DOCUMENTED', sourceAmount: '20.00' });

    expect(await client().transaction('tx-1')).toMatchObject({
      id: 'tx-1',
      status: 'A_STATUS_NOBODY_DOCUMENTED',
      sourceAmount: '20.00',
    });
  });

  it('url-encodes the id rather than interpolating it raw', async () => {
    const fetchMock = stub(200, { id: 'a/b', status: 'PENDING' });
    await client().transaction('a/b ?x');

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('a%2Fb%20%3Fx');
  });
});

describe('verifyCredentials', () => {
  it('reports how many offers the probe corridor returned', async () => {
    // The count is what lets boot distinguish "key proven, corridor dry" from "key proven,
    // corridor served"; the first is a warning, not a refusal to start.
    stub(200, { quotes: [] });
    await expect(client().verifyCredentials(probe())).resolves.toBe(0);

    stub(200, {
      quotes: [
        {
          serviceProvider: 'TRANSAK',
          sourceAmount: '20',
          sourceCurrencyCode: 'USD',
          destinationAmount: '19.5',
          destinationCurrencyCode: 'USDC_ASSETHUB',
        },
      ],
    });
    await expect(client().verifyCredentials(probe())).resolves.toBe(1);
  });



  it.each([
    ['a rejected key', 401],
    ['a forbidden key', 403],
    ['a wrong endpoint path', 404],
    ['a wrong method', 405],
  ])('reports %s as an answer from Meld, which boot treats as fatal', async (_label, status) => {
    // The finding this test exists for: a transcribed path answers 404, and a
    // version mapped that to a retryable failure that boot then shrugged off, so the
    // service would start with an endpoint that had never worked.
    stub(status, {});
    await expect(client().verifyCredentials(probe())).rejects.toThrow(MeldHttpError);
  });

  it('reports an unreachable Meld as retryable, so a rollout survives it', async () => {
    stubNetworkFailure('ETIMEDOUT');
    const error = await client().verifyCredentials(probe()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Refusal);
    expect(error).not.toBeInstanceOf(MeldHttpError);
  });
});

const params = () => ({
  destinationCode: 'USDC_ASSETHUB',
  walletAddress: '1abc',
  sourceAmount: '25.00',
  sourceCurrency: 'USD',
  countryCode: 'US',
  paymentMethodType: 'CREDIT_DEBIT_CARD',
  clientReference: 'idem-0000-0001',
});

const probe = () => ({
  countryCode: 'US',
  sourceCurrencyCode: 'USD',
  destinationCurrencyCode: 'USDC_ASSETHUB',
  sourceAmount: '20',
  paymentMethodType: 'CREDIT_DEBIT_CARD',
});

describe('transactionByReference', () => {
  const found = { id: 'tx-1', status: 'SETTLED', externalSessionId: 'idem-1' };

  it('finds the transaction filed under the reference', async () => {
    stub(200, [found]);

    await expect(client().transactionByReference('idem-1')).resolves.toMatchObject({ id: 'tx-1' });
  });

  it('finds it under either join field, because which one Meld populates is unverified', async () => {
    // The reference is filed as both a top-level `externalSessionId` and a `sessionData`
    // `externalCustomerId`. A probe found the latter coming back null on every transaction, but
    // that is one unverified reading, so a row carrying the reference in either field matches,
    // and the finder does not depend on which report turns out to be right.
    stub(200, [{ id: 'tx-legacy', status: 'SETTLED', externalCustomerId: 'idem-1' }]);

    await expect(client().transactionByReference('idem-1')).resolves.toMatchObject({ id: 'tx-legacy' });
  });

  it('accepts the wrapped collection shape as well as the bare array', async () => {
    stub(200, { transactions: [found] });

    await expect(client().transactionByReference('idem-1')).resolves.toMatchObject({ id: 'tx-1' });
  });

  it('refuses rows that do not carry back the reference that was asked for', async () => {
    // The one that matters. A query parameter a server does not understand is commonly ignored
    // rather than rejected, and an ignored filter on a collection endpoint returns the operator's
    // other transactions. Taken at face value, that would settle one buyer's funding request
    // against another buyer's payment.
    //
    // It must never accept them. It must also not quietly report "nothing found", which is what it
    // Returning undefined reads as "this buyer has not paid yet", and the worker eventually writes
    // `expired`, telling a buyer whose card may have been charged that no payment existed. The
    // scenario in this comment is precisely the one where the join is broken, so it is precisely
    // where that conclusion is least earned.
    stub(200, [
      { id: 'someone-else', status: 'SETTLED', externalCustomerId: 'idem-other' },
      { id: 'no-reference-at-all', status: 'SETTLED' },
    ]);

    await expect(client().transactionByReference('idem-1')).rejects.toThrow(
      /settlement join is not what this client expects/,
    );
  });

  it('picks ours out of a mixed page, not simply the first row', async () => {
    // The gap mutation testing exposed: every other fixture here is all-matching or
    // all-non-matching, so `mine[0]` and `rows[0]` never diverge and `return rows[0]` survived all
    // 861 tests. A mixed page is not hypothetical: it is exactly what a partially-applied or
    // ignored filter on a paginated collection returns, which is the failure this whole re-check
    // exists for. Someone else's transaction is deliberately placed first.
    stub(200, [
      { id: 'someone-else', status: 'SETTLED', externalSessionId: 'idem-other' },
      found,
    ]);

    // Ours, by reference (not the row that happened to be first in the page).
    await expect(client().transactionByReference('idem-1')).resolves.toMatchObject({ id: 'tx-1' });
  });

  it('refuses to pick one when two transactions share a reference', async () => {
    stub(200, [found, { id: 'tx-2', status: 'SETTLED', externalSessionId: 'idem-1' }]);

    await expect(client().transactionByReference('idem-1')).rejects.toThrow(/2 transactions/);
  });

  it('sends the reference as the query filter, encoded', async () => {
    const fetchMock = stub(200, []);

    await client().transactionByReference('idem//1');

    // `externalSessionIds`, plural. A probe tried the singular form, `?sessionId=` and `?offset=`
    // against the sandbox and reported `400` from all three; only this one filters. Getting it
    // wrong does not fail loudly: an unfiltered collection comes back and the re-check above
    // silently discards all of it.
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('externalSessionIds=idem%2F%2F1');
  });

  it('refuses a row whose reference sits in neither join field, rather than reporting nothing found', async () => {
    // Two claims here, and the second is the one that matters.
    //
    // First: "either field" must not decay into "any row"; a row carrying someone else's
    // reference never matches.
    //
    // Second: the query is already filtered by the reference
    // (`?externalSessionIds=`), so Meld answering with rows that do not carry it back is evidence
    // the join is not what this client thinks. Reporting `undefined` would say "no transaction
    // yet", and the worker would wait and then conclude `expired`: a claim that the buyer did
    // not pay, made on the strength of a join there is reason to believe is broken.
    //
    // Throwing surfaces it in the tick log and lets the row age out as `unobserved`, meaning it could not
    // tell. That is the one distinction `state.ts` says this record must never get wrong.
    stub(200, [{ id: 'someone-else', status: 'SETTLED', externalSessionId: 'idem-other', externalCustomerId: 'idem-other' }]);

    await expect(client().transactionByReference('idem-1')).rejects.toThrow(/settlement join is not what this client expects/);
  });

  it('reports nothing found when the search is genuinely empty', async () => {
    // The other side of it. An empty answer is the ordinary reply for a buyer who has not paid
    // yet, and it must stay quiet: turning that into an error would make every unpaid request
    // a logged failure on every tick, and trip the worker's failure ceiling against healthy rows.
    stub(200, []);

    await expect(client().transactionByReference('idem-1')).resolves.toBeUndefined();
  });
});

describe('discovery reads', () => {
  it('authedGet sends the key, GETs the path, and returns the parsed body', async () => {
    const fetchMock = stub(200, { countries: [] });
    const body = await client().authedGet('/network-partner/supported/countries?category=CRYPTO_ONRAMP');
    expect(sentUrl(fetchMock)).toContain('/network-partner/supported/countries');
    expect(sentMethod(fetchMock)).toBe('GET');
    expect((sentInit(fetchMock).headers as Record<string, string>).authorization).toBe(`BASIC ${KEY}`);
    expect(body).toEqual({ countries: [] });
  });

  it('publicGet omits the key (global scope) yet still returns the parsed body', async () => {
    const fetchMock = stub(200, { ok: true });
    const body = await client().publicGet(
      '/network-partner/supported/routes/CRYPTO_ONRAMP/US/USD/DOT_ASSETHUB',
    );
    expect(sentMethod(fetchMock)).toBe('GET');
    expect((sentInit(fetchMock).headers as Record<string, string>).authorization).toBeUndefined();
    expect(body).toEqual({ ok: true });
  });
});
