import { describe, expect, it, vi } from 'vitest';

import type { AuditEvent } from '../src/audit.js';
import { Refusal, reject, upstreamUnavailable, type FundingFailure } from '../src/contract.js';
import { MeldHttpError, type MeldTransaction } from '../src/meld/client.js';
import { railRefusal } from '../src/meld/refusal.js';
import { TERMINAL_STATES } from '../src/funding/state.js';
import { toFundingRequestDto } from '../src/funding/types.js';
import { Onramp, type FundingPort } from '../src/onramp.js';
import type { FundingRail, MeldTransactionReader, RailQuote, RailName, RailRegistry, RailSession, RailSessionInput, RailTransaction } from '../src/rail.js';
import {
  ALICE,
  ALICE_PREFIX_42,
  BOB,
  SHORT_KEY_ADDRESS,
  config,
  createRequest,
  railSessionInput,
  fakeStore,
  fundingRecord,
} from './fixtures.js';

const SUBJECT = { productId: 'app.dot', alias: 'alias-abc', proven: true };
/** Narrow an optional the test has already asserted on. Throws rather than casting: a missing row
 *  then fails at the line that assumed it, naming what was missing. */
function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`expected ${what} to exist`);
  return value;
}

/** A second caller, for the scoping assertions: same product, different personhood alias. */
const OTHER_SUBJECT = { productId: 'app.dot', alias: 'alias-xyz', proven: true };
const REQUEST_ID = 'req-1';
/** Pinned so a test can assert the exact timeline without mocking time. */
const NOW = 1_700_000_000_000;

/** A fake Meld rail: records the calls and honours whatever behaviour/quote/session it is given. */
class FakeMeld implements FundingRail, MeldTransactionReader {
  provider: RailName = 'meld';
  calls: RailSessionInput[] = [];
  quoteCalls: RailQuote[] = [];
  quotes: unknown[] = [];
  transactions: Record<string, MeldTransaction> = {};

  constructor(private readonly behaviour: (n: number) => RailSession | Error = () => ok()) {}

  async createSession(input: RailSessionInput): Promise<RailSession> {
    this.calls.push(input);
    const result = this.behaviour(this.calls.length);
    if (result instanceof Error) throw result;
    return result;
  }

  async quote(input: RailQuote): Promise<unknown[]> {
    this.quoteCalls.push(input);
    return this.quotes;
  }

  async transaction(id: string): Promise<RailTransaction> {
    return this.transactions[id] ?? { id };
  }
}

class FakeAudit {
  events: AuditEvent[] = [];
  info = (event: AuditEvent) => {
    this.events.push(event);
  };
}

const ok = (id = 'meld-1'): RailSession => ({
  providerSessionId: id,
  settlementUrl: `https://meldcrypto.com/session/${id}`,
  hostedWidgetUrl: undefined,
  expiresAt: 1_800_000_000_000,
});

/** A rail registry with meld wired (and, when asked, chainflip). */
const registry = (meld: FundingRail, chainflip?: FundingRail): RailRegistry =>
  chainflip ? { meld, chainflip } : { meld };

/** Both the rail and its transaction reader are the same FakeMeld instance in these tests. */
const build = (meld: FakeMeld & MeldTransactionReader, cfg = config()) => {
  const audit = new FakeAudit();
  const funding = fakeStore();
  let n = 0;
  const service = new Onramp(
    cfg,
    registry(meld),
    audit,
    funding,
    meld,
    () => NOW,
    () => `funding-${String((n += 1))}`,
  );
  return { service, funding, audit } as const;
};

const failureOf = async (fn: () => Promise<unknown>): Promise<FundingFailure> => {
  try {
    await fn();
  } catch (error) {
    if (error instanceof Refusal) return error.failure;
    throw error;
  }
  throw new Error('expected a Refusal');
};

describe('Onramp.quote', () => {
  it('forwards the destination amount and normalises the currency', async () => {
    const meld = new FakeMeld();
    const { service } = build(meld);

    await service.quote({
      destinationCurrencyCode: 'USDC_ASSETHUB',
      sourceAmount: '20',
      fiat: 'usd',
      country: 'US',
      paymentMethodType: 'CREDIT_DEBIT_CARD',
    });

    expect(meld.quoteCalls[0]).toEqual({
      countryCode: 'US',
      sourceCurrencyCode: 'USD',
      destinationCurrencyCode: 'USDC_ASSETHUB',
      sourceAmount: '20',
      paymentMethodType: 'CREDIT_DEBIT_CARD',
    });
  });

  it('echoes the request in canonical form, not as it was typed', async () => {
    const meld = new FakeMeld();
    const { service } = build(meld);

    const result = await service.quote({
      destinationCurrencyCode: 'USDC_ASSETHUB',
      sourceAmount: '20',
      fiat: 'usd',
      country: 'US',
      paymentMethodType: 'CREDIT_DEBIT_CARD',
    });

    expect(result.requested).toEqual({
      destinationCurrencyCode: 'USDC_ASSETHUB',
      sourceAmount: '20',
      fiat: 'USD',
    });
  });

  it('refuses an unknown destination before spending a rail call', async () => {
    const meld = new FakeMeld();
    const { service } = build(meld);

    const failure = await failureOf(() =>
      service.quote({
        destinationCurrencyCode: 'NOT_REAL',
        sourceAmount: '20',
        fiat: 'USD',
        country: 'US',
        paymentMethodType: 'CREDIT_DEBIT_CARD',
      }),
    );

    expect(failure.tag).toBe('WrongAssetOrChain');
    expect(meld.quoteCalls).toHaveLength(0);
  });

  it('does not apply amount bounds at quote time', async () => {
    // Bounds are enforced at session creation, not on a quote; a quote is just price discovery.
    const meld = new FakeMeld();
    const { service } = build(meld);

    await service.quote({
      destinationCurrencyCode: 'USDC_ASSETHUB',
      sourceAmount: '999999',
      fiat: 'USD',
      country: 'US',
      paymentMethodType: 'CREDIT_DEBIT_CARD',
    });

    expect(meld.quoteCalls).toHaveLength(1);
  });

  it('passes the caller\'s includeRefused through to the store', async () => {
    // The route test uses a stub `onramp.list`, and the store test calls `store.list` directly, so
    // the seam between them was joined by nothing: `Onramp.list` could hard-code `false` and both
    // suites stayed green. `?includeRefused=true` would then answer with silence, and the refusal
    // rows kept as the durable record behind `session.refused` would be unreachable.
    const funding = fakeStore();
    await funding.create(fundingRecord({ id: 'live', status: 'session_opened' }));
    await funding.create(fundingRecord({ id: 'nope', status: 'refused', client_reference: undefined }));
    const service = new Onramp(config(), registry(new FakeMeld()), new FakeAudit(), funding, new FakeMeld(), () => NOW);

    expect((await service.list(SUBJECT)).map((r) => r.id)).toEqual(['live']);
    expect((await service.list(SUBJECT, true)).map((r) => r.id).sort()).toEqual(['live', 'nope']);
  });

  it('asks the store for no more rows than the caller may receive', async () => {
    // The 100-row bound is what stops one account paging an unbounded body out of the service, and
    // it was pinned on the store's default while `Onramp.list` is the thing that relies on it.
    // Passing an explicit 10,000 from here left the suite green: the store's own test asserts its
    // default, and nothing asserted that this caller declines to override it.
    const funding = fakeStore();
    const limits: (number | undefined)[] = [];
    const spy = vi.spyOn(funding, 'list').mockImplementation(async (_a: string, _p: string, limit?: number) => {
      limits.push(limit);
      return [];
    });
    const service = new Onramp(config(), registry(new FakeMeld()), new FakeAudit(), funding, new FakeMeld(), () => NOW);

    await service.list(SUBJECT);
    spy.mockRestore();

    // Either it names no limit (taking the store's bound) or it names one no larger.
    expect(limits).toHaveLength(1);
    expect(limits[0] ?? 100).toBeLessThanOrEqual(100);
  });

  it.each([
    ['below', '5.00', 'BelowMinimum', '10.00'],
    ['above', '5000.00', 'AboveMaximum', '2000.00'],
  ])('names the threshold when an amount is %s the configured bound', async (_label, sourceAmount, tag, bound) => {
    // The buyer is told which number to move to. The failure type has always carried `value`, and
    // only the rail-derived form of these two tags filled it. So a config-derived refusal
    // arrived as a bare "that amount is below the minimum" and the client had nothing to render or
    // correct against.
    const { service } = build(new FakeMeld());

    const failure = await failureOf(() =>
      service.createSession(SUBJECT, createRequest({ sourceAmount }), REQUEST_ID),
    );

    expect(failure).toEqual({ tag, value: { amount: bound, currency: 'USD' } });
  });

  it('refuses a currency this deployment does not serve, before spending a rail call', async () => {
    // The journey this closes: a buyer in a EUR region got a complete quote ("you pay 19.80 EUR"),
    // pressed Continue, and only then met `CURRENCY_UNSUPPORTED`, because the check lived in
    // `validate` alone. 13 of the 17 regions the consumer offers resolve to a currency the
    // shipped limits do not configure.
    //
    // Nothing about that answer can change between the quote and the session, so discovering it
    // late was purely a worse place to find out, and it cost a metered rail call to get there.
    const meld = new FakeMeld();
    const { service } = build(meld);

    const failure = await failureOf(() =>
      service.quote({
        destinationCurrencyCode: 'USDC_ASSETHUB',
        sourceAmount: '20',
        fiat: 'EUR',
        country: 'DE',
        paymentMethodType: 'CREDIT_DEBIT_CARD',
      }),
    );

    expect(failure).toEqual({ tag: 'Other', value: { code: 'CURRENCY_UNSUPPORTED', message: expect.any(String) } });
    // And the rail was never asked, which is the other half: the refusal is local.
    expect(meld.quoteCalls).toHaveLength(0);
  });

  it('refuses a destination this deployment does not configure, at quote time too', async () => {
    const meld = new FakeMeld();
    // A configured deployment, just not for this destination: the schema requires at least one
    // limit, and "in the catalog but not served here" is what `RegionUnavailable` means.
    const { service } = build(meld, config({ limits: [{ code: 'DOT_ASSETHUB', min: '10.00', max: '2000.00', currency: 'USD' }] }));

    const failure = await failureOf(() =>
      service.quote({
        destinationCurrencyCode: 'USDC_ASSETHUB',
        sourceAmount: '20',
        fiat: 'USD',
        country: 'US',
        paymentMethodType: 'CREDIT_DEBIT_CARD',
      }),
    );

    expect(failure).toEqual({ tag: 'RegionUnavailable' });
    expect(meld.quoteCalls).toHaveLength(0);
  });

  it('returns the rail\'s offers, which is the entire payload of price discovery', async () => {
    // Nothing asserted that a non-empty quote list survives `Onramp.quote`. `FakeMeld.quotes`
    // defaults to `[]` and the only test touching it set it to `[]` again, so returning `[]`
    // unconditionally left the suite green, on the route whose whole job is price discovery.
    const meld = new FakeMeld();
    meld.quotes = [
      { serviceProvider: 'MELD', destinationAmount: '19.4', sourceAmount: '20', totalFee: '0.6' },
      { serviceProvider: 'OTHER', destinationAmount: '19.1', sourceAmount: '20', totalFee: '0.9' },
    ];
    const { service } = build(meld);

    const answered = await service.quote({
      destinationCurrencyCode: 'USDC_ASSETHUB',
      sourceAmount: '20',
      fiat: 'USD',
      country: 'US',
      paymentMethodType: 'CREDIT_DEBIT_CARD',
    });

    // Both offers, in order, unmodified: the adapter forwards price, it does not curate it.
    expect(answered.quotes).toEqual(meld.quotes);
  });

  it('returns an empty list rather than failing when the rail offers nothing', async () => {
    const meld = new FakeMeld();
    meld.quotes = [];
    const { service } = build(meld);

    expect(
      (
        await service.quote({
          destinationCurrencyCode: 'USDC_ASSETHUB',
          sourceAmount: '20',
          fiat: 'USD',
          country: 'US',
          paymentMethodType: 'CREDIT_DEBIT_CARD',
        })
      ).quotes,
    ).toEqual([]);
  });

  it('routes to the named rail and refuses an unregistered one', async () => {
    const meld = new FakeMeld();
    const chainflip = new FakeMeld();
    chainflip.provider = 'chainflip';
    chainflip.quoteCalls = [];
    const audit = new FakeAudit();
    const funding = fakeStore();
    const service = new Onramp(config(), registry(meld, chainflip), audit, funding, meld, () => NOW, () => 'funding-1');

    await service.quote({
      destinationCurrencyCode: 'USDC_ASSETHUB',
      sourceAmount: '20',
      fiat: 'USD',
      country: 'US',
      paymentMethodType: 'CREDIT_DEBIT_CARD',
      rail: 'chainflip',
    });

    expect(chainflip.quoteCalls).toHaveLength(1);
    expect(meld.quoteCalls).toHaveLength(0);

    // An unregistered rail (e.g. `chainflip` before its wire lands) is refused locally, never
    // fabricated or passed through.
    const onlyMeld = fakeStore();
    const svc = new Onramp(config(), registry(meld), audit, onlyMeld, meld, () => NOW, () => 'funding-1');
    const failure = await failureOf(() =>
      svc.quote({
        destinationCurrencyCode: 'USDC_ASSETHUB',
        sourceAmount: '20',
        fiat: 'USD',
        country: 'US',
        paymentMethodType: 'CREDIT_DEBIT_CARD',
        rail: 'chainflip',
      }),
    );
    expect(failure.tag).toBe('Other');
    expect((failure as { value: { code: string } }).value.code).toBe('UNKNOWN_RAIL');
  });
});

describe('Onramp.transaction', () => {
  it('forwards what the rail reported without adding a claim of its own', async () => {
    const meld = new FakeMeld();
    meld.transactions['tx-1'] = { id: 'tx-1', status: 'SETTLING', destinationAmount: '20' };
    const { service } = build(meld);

    expect(await service.transaction('tx-1')).toEqual({
      transaction: { id: 'tx-1', status: 'SETTLING', destinationAmount: '20' },
    });
  });
});

describe('Onramp.create', () => {
  it('pins the normalised address, not the one the caller sent', async () => {
    const meld = new FakeMeld();
    const { service } = build(meld);

    const result = await service.createSession(
      SUBJECT,
      createRequest({ walletAddress: ALICE_PREFIX_42 }),
      REQUEST_ID,
    );

    expect(result.pinned.walletAddress).toBe(ALICE);
    expect(meld.calls[0]?.walletAddress).toBe(ALICE);
  });

  it('hands the rail every term of the request, translated', async () => {
    // Nothing asserted the shape of this call. Four independent constant substitutions in
    // `Onramp.createSession` (`destinationCode: 'DOT_ASSETHUB'`, `sourceAmount: '1.00'`,
    // `countryCode: ''`, `paymentMethodType: 'SEPA'`) each survived all 861 tests, because the
    // durable row and the response `pinned` are built from separate expressions and so constrain
    // this one not at all. Every term here decides what the buyer is actually charged and where
    // the money lands.
    //
    // `toEqual` against the whole input, so a field added to the call without a home in the
    // fixture fails too.
    const meld = new FakeMeld();
    const { service } = build(meld);

    await service.createSession(SUBJECT, createRequest(), REQUEST_ID);

    // `clientReference` is this record's id, never the caller's idempotency key. Two callers can
    // share a key, and the rail's reference namespace is global.
    // `ALICE`, not the fixture's `'5x...'` placeholder: the address the rail is given is the
    // pinned one, normalised to the configured prefix, not the string the caller sent.
    expect(meld.calls[0]).toEqual(railSessionInput({ clientReference: 'funding-1', walletAddress: ALICE }));
  });

  it("returns the rail's session id, its widget URL, and nothing key-shaped", async () => {
    const { service } = build(new FakeMeld());

    const result = await service.createSession(SUBJECT, createRequest(), REQUEST_ID);

    expect(result.sessionId).toBe('meld-1');
    expect(result.serviceProviderWidgetUrl).toBe('https://meldcrypto.com/session/meld-1');
    expect(result.expiresAt).toBe(1_800_000_000_000);
  });

  it('refuses a retry while the first request is still opening, rather than replaying nothing', async () => {
    // The concurrent case the reservation was introduced for. The winner's row exists but is
    // still `created`: no session id, no settlement surface. Replaying it would answer 201 with
    // both fields empty and audit a `session.created` for a session that does not exist, which is
    // the same defect the refused path was fixed for. The caller is told to come back instead.
    const meld = new FakeMeld();
    const { service, funding } = build(meld);
    await funding.create(
      fundingRecord({
        id: 'in-flight',
        status: 'created',
        status_history: [{ status: 'created', at: NOW }],
        client_reference: 'idem-0000-0001',
        provider_session_id: undefined,
        widget_url: undefined,
      }),
    );

    const thrown = await service.createSession(SUBJECT, createRequest(), REQUEST_ID).catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(Refusal);
    // 409, not 400: the request is well-formed and will succeed on a retry, a distinction the
    // caller has to be able to act on.
    expect((thrown as Refusal).status).toBe(409);
    expect((thrown as Refusal).failure).toMatchObject({ value: { code: 'REQUEST_IN_FLIGHT' } });
    // And nothing was opened upstream for the loser.
    expect(meld.calls).toHaveLength(0);
  });

  it('replays both widget URLs exactly, so a retry is not handed a different surface', async () => {
    // Idempotency means the same answer, so both URLs are stored. With only the settlement URL,
    // a retry would return the provider capture page in the field documented as the hosted widget.
    const meld = new FakeMeld(() => ({
      providerSessionId: 'meld-1',
      settlementUrl: 'https://provider.example/capture',
      hostedWidgetUrl: 'https://meldcrypto.example/widget',
      expiresAt: 1_800_000_000_000,
    }));
    const { service } = build(meld);

    const first = await service.createSession(SUBJECT, createRequest(), REQUEST_ID);
    const second = await service.createSession(SUBJECT, createRequest(), REQUEST_ID);

    expect(first.serviceProviderWidgetUrl).toBe('https://provider.example/capture');
    expect(first.widgetUrl).toBe('https://meldcrypto.example/widget');
    expect(second).toEqual(first);
  });

  it('replays an earlier session for a repeated idempotency key instead of opening a second', async () => {
    // The retry a proxy timeout causes: the rail already created the session, the SPA sends the
    // same key again. Without this, one buyer intent became two upstream sessions, two capture
    // pages and two rows, and once a finder exists, one payment settling both.
    const meld = new FakeMeld();
    const { service } = build(meld);

    const first = await service.createSession(SUBJECT, createRequest(), REQUEST_ID);
    const second = await service.createSession(SUBJECT, createRequest(), REQUEST_ID);

    expect(meld.calls).toHaveLength(1);
    expect(second.fundingRequestId).toBe(first.fundingRequestId);
    expect(second.sessionId).toBe(first.sessionId);
    expect(second.pinned).toEqual(first.pinned);
  });

  it('does not let one caller\'s idempotency key replay another caller\'s session', async () => {
    const meld = new FakeMeld();
    const { service } = build(meld);

    await service.createSession(SUBJECT, createRequest(), REQUEST_ID);
    const other = await service.createSession(
      { productId: 'app.dot', alias: 'alias-other', proven: true },
      createRequest(),
      REQUEST_ID,
    );

    expect(meld.calls).toHaveLength(2);
    expect(other.fundingRequestId).not.toBe('funding-1');
  });

  it('reports a reservation that failed for a reason other than the key already existing', async () => {
    // The insert can fail for reasons that are not a duplicate key (a full volume, say). Then
    // there is no earlier request to replay, and saying so beats returning a 201 built from a
    // row that does not exist.
    const meld = new FakeMeld();
    const funding = {
      reserve: () => Promise.reject(new Error('disk full')),
      create: async () => undefined,
      update: async () => undefined,
      byAlias: async () => undefined,
      byReference: async () => undefined,
      cancel: async () => undefined,
      list: async () => [],
    };
    const service = new Onramp(config(), registry(meld), new FakeAudit(), funding, meld, () => NOW, () => 'funding-1');

    // The store's own fault reaches the caller, not a laundered "reservation failed for an
    // unknown reason". The previous shape wrapped the insert in a bare `catch {}` and re-read, so
    // a dead connection and a duplicate idempotency key were indistinguishable, and the operator
    // chasing a real outage was told nothing about it.
    await expect(service.createSession(SUBJECT, createRequest(), REQUEST_ID)).rejects.toThrow(/disk full/);
    // Nothing was opened upstream: the reservation is taken before the rail is called.
    expect(meld.calls).toHaveLength(0);
  });

  it('audits an orphaned session when the record cannot be persisted', async () => {
    // The rail has already opened a settlement surface and the row cannot be advanced to record
    // where it is. Nothing can un-open it; the audit line naming the rail's own session id is
    // the only handle support has.
    const meld = new FakeMeld();
    const audit = new FakeAudit();
    // The reservation succeeds; advancing it to `session_opened` is what fails, which is the
    // only remaining window where the rail has opened a surface and the record cannot say so.
    const funding = {
      reserve: async () => ({ outcome: 'inserted' as const }),
      create: async () => undefined,
      // Rejects rather than throwing synchronously. A synchronous throw is caught by the `try`
      // whether or not the call is awaited, so a fake that threw would go green against an
      // un-awaited `update`; production, on a real socket, skipped the orphan audit and raised
      // an unhandled rejection instead.
      update: () => Promise.reject(new Error('disk full')),
      byAlias: async () => undefined,
      byReference: async () => undefined,
      cancel: async () => undefined,
      list: async () => [],
    };
    const service = new Onramp(config(), registry(meld), audit, funding, meld, () => NOW, () => 'funding-1');

    await expect(service.createSession(SUBJECT, createRequest(), REQUEST_ID)).rejects.toThrow('disk full');

    const orphaned = audit.events.find((e) => e.event === 'session.orphaned');
    expect(orphaned).toMatchObject({ providerSessionId: 'meld-1', rail: 'meld', requestId: REQUEST_ID });
  });

  it('omits expiresAt rather than inventing one when the rail gives none', async () => {
    const meld = new FakeMeld(() => ({
      providerSessionId: 'm',
      settlementUrl: 'https://meldcrypto.com/s/m',
      hostedWidgetUrl: undefined,
      expiresAt: undefined,
    }));
    const { service } = build(meld);

    expect(await service.createSession(SUBJECT, createRequest(), REQUEST_ID)).not.toHaveProperty('expiresAt');
  });

  it("forwards this record's own id to the rail, so two callers sharing a key cannot collide", async () => {
    const meld = new FakeMeld();
    const { service } = build(meld);

    await service.createSession(SUBJECT, createRequest({ idempotencyKey: 'idem-xyz-123' }), REQUEST_ID);

    expect(meld.calls[0]?.clientReference).toBe('funding-1');
  });

  it('accepts a lowercase fiat on create, as the wire schema says it does', async () => {
    // The schema takes either case and `/quote` folds it; only `/quote` was ever tested for it.
    // Unfolded here, the limit lookup misses and a legitimate `"usd"` is refused as an
    // unsupported currency; the rail and the record would disagree with the caller too.
    const meld = new FakeMeld();
    const { service, funding } = build(meld);

    const response = await service.createSession(SUBJECT, createRequest({ fiat: 'usd' }), REQUEST_ID);

    expect(response.pinned.fiat).toBe('USD');
    expect(meld.calls[0]?.fiat).toBe('USD');
    expect((await funding.byId('funding-1'))?.fiat).toBe('USD');
  });

  it('pins the requested service provider onto the rail call and the record', async () => {
    // Choosing a provider is a live wire feature. Dropped anywhere along the way, the caller is
    // silently given whichever provider the rail preferred, and the record cannot say otherwise.
    const meld = new FakeMeld();
    const { service, funding } = build(meld);

    await service.createSession(SUBJECT, createRequest({ serviceProvider: 'TRANSAK' }), REQUEST_ID);

    expect(meld.calls[0]?.serviceProvider).toBe('TRANSAK');
    expect((await funding.byId('funding-1'))?.service_provider).toBe('TRANSAK');
  });

  it('leaves the idempotency key usable after a refusal', async () => {
    // A refusal is persisted for the audit trail, but it must not claim the caller's key: the
    // contract requires that key to be stable across a page reload, so the corrected retry
    // arrives under it. Stamp the reference onto the refused row and that retry replays a row
    // that has no session: 201, an empty settlement URL, and the rejected address echoed back
    // as though it had been committed.
    const meld = new FakeMeld();
    const { service, funding } = build(meld);

    await failureOf(() =>
      service.createSession(
        SUBJECT,
        createRequest({ walletAddress: 'not-an-address', serviceProvider: 'TRANSAK' }),
        REQUEST_ID,
      ),
    );
    const retried = await service.createSession(SUBJECT, createRequest(), REQUEST_ID);

    expect((await funding.byId('funding-1'))?.status).toBe('refused');
    expect((await funding.byId('funding-1'))?.client_reference).toBeUndefined();
    // The refusal is an audit record, so it keeps the terms that were asked for, the provider
    // included, since "which provider was this refused for" is a support question.
    expect((await funding.byId('funding-1'))?.service_provider).toBe('TRANSAK');
    expect(retried.sessionId).toBe('meld-1');
    expect(retried.serviceProviderWidgetUrl).toContain('meldcrypto.com');
    expect(retried.pinned.walletAddress).not.toBe('not-an-address');
  });

  it('forwards a redirect target on the allowlist to the rail', async () => {
    const meld = new FakeMeld();
    const { service } = build(meld, config({ cors: { allowed_origins: ['https://app.example'] } }));

    await service.createSession(
      SUBJECT,
      createRequest({ redirectUrl: 'https://app.example/thanks?order=7' }),
      REQUEST_ID,
    );

    expect(meld.calls[0]?.redirectUrl).toBe('https://app.example/thanks?order=7');
  });

  it('forwards the normalised href, never the caller\'s spelling of it', async () => {
    // Checking one representation and committing another is how a guard is bypassed. The origin is
    // read from a parsed URL, so the value pinned to the rail must be the parse's own `href`;
    // otherwise a string the two parser families disagree about reaches Meld unchanged.
    const meld = new FakeMeld();
    const { service } = build(meld, config({ cors: { allowed_origins: ['https://app.example'] } }));

    await service.createSession(
      SUBJECT,
      // Percent-encodable characters and a default port, both of which normalise.
      createRequest({ redirectUrl: 'https://app.example:443/a b?x=1' }),
      REQUEST_ID,
    );

    expect(meld.calls[0]?.redirectUrl).toBe('https://app.example/a%20b?x=1');
  });

  it('neutralises a target the two URL parser families disagree about', async () => {
    // `https://app.example\@attacker.test/steal` is the bypass class this guard has to survive.
    // WHATWG folds the backslash to `/`, so the origin really is `app.example` and the target is
    // legitimately allowed. An RFC-3986 parser ends the authority only at `/?#` and then splits at
    // the last `@`, reading the host as `attacker.test`, so forwarding the caller's raw string
    // would land a just-charged buyer on the attacker's host if Meld parses it that way.
    // Normalising removes the disagreement: what is forwarded is a URL both families read the same.
    const meld = new FakeMeld();
    const { service } = build(meld, config({ cors: { allowed_origins: ['https://app.example'] } }));

    await service.createSession(
      SUBJECT,
      createRequest({ redirectUrl: 'https://app.example\\@attacker.test/steal' }),
      REQUEST_ID,
    );

    const sent = meld.calls[0]?.redirectUrl ?? '';
    expect(sent).toBe('https://app.example/@attacker.test/steal');
    expect(new URL(sent).host).toBe('app.example');
  });

  it('refuses a redirect target the operator never approved', async () => {
    // The buyer is sent here by the widget the instant a card is charged, so an unchecked target
    // is an open redirect at the worst possible moment. The allowlist is the CORS one: the set of
    // front-ends this deployment already serves.
    const meld = new FakeMeld();
    const { service, funding } = build(meld, config({ cors: { allowed_origins: ['https://app.example'] } }));

    const failure = await failureOf(() =>
      service.createSession(SUBJECT, createRequest({ redirectUrl: 'https://attacker.example/steal' }), REQUEST_ID),
    );

    expect((failure as { value: { code: string } }).value.code).toBe('REDIRECT_NOT_ALLOWED');
    // Refused locally: no session was opened upstream, and the refusal is on the record.
    expect(meld.calls).toHaveLength(0);
    expect((await funding.byId('funding-1'))?.status).toBe('refused');
  });

  it.each([
    ['a lookalike host that has the origin as a prefix', 'https://app.example.attacker.test/x'],
    ['userinfo hiding the real host', 'https://app.example@attacker.test/x'],
    ['a different port on an allowed host', 'https://app.example:8443/x'],
    ['a different scheme on an allowed host', 'http://app.example/x'],
    // Relatives of the allowed host, not strangers to it. A subdomain is what an attacker holds
    // after a takeover; the registrable parent is what a loose `endsWith` check would admit.
    ['a subdomain of an allowed host', 'https://evil.app.example/x'],
    ['the registrable parent of an allowed host', 'https://example/x'],
  ])('refuses %s', async (_label, target) => {
    // Each of these contains the allowed origin as a substring, which is why the check parses the
    // URL and compares `origin` rather than matching text.
    const meld = new FakeMeld();
    const { service } = build(meld, config({ cors: { allowed_origins: ['https://app.example'] } }));

    const failure = await failureOf(() =>
      service.createSession(SUBJECT, createRequest({ redirectUrl: target }), REQUEST_ID),
    );

    expect((failure as { value: { code: string } }).value.code).toBe('REDIRECT_NOT_ALLOWED');
  });

  it('accepts an http redirect in development, where the operator allowlisted it', async () => {
    // Outside development there is no matching case to test: `config.ts` refuses a plaintext entry
    // in `cors.allowed_origins`, so the allowlist is https-only and an `http:` target's origin
    // simply is not a member. The invariant is enforced at boot rather than per request.
    // The consumer's local dev server is `http://localhost:3000`, and `config.ts`'s origin regex
    // permits `http://`, so an operator can allowlist it for CORS. Requiring `https:` at the
    // Requiring `https:` at the schema would put the two controls at odds: the same origin
    // approved for CORS and refused for receiving a buyer.
    const meld = new FakeMeld();
    const { service } = build(
      meld,
      config({ environment: 'development', cors: { allowed_origins: ['http://localhost:3000'] } }),
    );

    await service.createSession(
      SUBJECT,
      createRequest({ redirectUrl: 'http://localhost:3000/#/meld-complete' }),
      REQUEST_ID,
    );

    expect(meld.calls[0]?.redirectUrl).toBe('http://localhost:3000/#/meld-complete');
  });

  it('refuses every redirect when no origins are configured', async () => {
    // Fail closed, matching what `buildServer` does with CORS on an empty list: an operator who
    // has approved no front-ends has approved no landing page either.
    const meld = new FakeMeld();
    const { service } = build(meld, config({ cors: { allowed_origins: [] } }));

    const failure = await failureOf(() =>
      service.createSession(SUBJECT, createRequest({ redirectUrl: 'https://app.example/done' }), REQUEST_ID),
    );

    expect((failure as { value: { code: string } }).value.code).toBe('REDIRECT_NOT_ALLOWED');
  });

  it('opens a session with no redirect target at all', async () => {
    const meld = new FakeMeld();
    const { service } = build(meld, config({ cors: { allowed_origins: ['https://app.example'] } }));

    await service.createSession(SUBJECT, createRequest(), REQUEST_ID);

    expect(meld.calls[0]?.redirectUrl).toBeUndefined();
  });

  it('refuses to replay a request that already concluded', async () => {
    // A terminal row keeps its reference on purpose, so one key cannot open a second session. But
    // reproducing the original 201 hands the buyer a capture page the rail closed hours ago, and
    // if the rail gave no `expiresAt`, the response carries nothing the client could detect that
    // with. The intent is over; a new one needs a new key.
    const meld = new FakeMeld();
    const { service, funding } = build(meld);
    const key = 'idem-concluded-1';

    await service.createSession(SUBJECT, createRequest({ idempotencyKey: key }), REQUEST_ID);
    await funding.update('funding-1', 'expired', NOW + 1);

    const refusal = await service
      .createSession(SUBJECT, createRequest({ idempotencyKey: key }), REQUEST_ID)
      .catch((e: unknown) => e);

    expect((refusal as Refusal).failure).toMatchObject({ value: { code: 'REQUEST_CONCLUDED' } });
    // 409, not 400: the request was well formed and the caller must act by minting a new key.
    expect((refusal as Refusal).status).toBe(409);
    // And no second upstream session was opened for it.
    expect(meld.calls).toHaveLength(1);
  });

  it('will not tell a caller to start again when the first outcome is unknown', async () => {
    // `unobserved` means the rail stopped being askable, so a second payment for the same intent
    // cannot be ruled out. "Start a new one" would invite exactly that.
    const meld = new FakeMeld();
    const { service, funding } = build(meld);
    const key = 'idem-unknown-outcome';

    await service.createSession(SUBJECT, createRequest({ idempotencyKey: key }), REQUEST_ID);
    await funding.update('funding-1', 'unobserved', NOW + 1);

    const failure = await failureOf(() =>
      service.createSession(SUBJECT, createRequest({ idempotencyKey: key }), REQUEST_ID),
    );

    const value = (failure as { value: { code: string; message: string } }).value;
    expect(value.code).toBe('REQUEST_OUTCOME_UNKNOWN');
    expect(value.message).not.toMatch(/start a new one/i);
    expect(value.message).toMatch(/support/i);
  });

  it('refuses to replay a settled request under its own code, never as "concluded"', async () => {
    // `settled` means the buyer has already paid, so it cannot share a code with `expired` and
    // `failed`, where nobody paid and starting again is right. A client acting on one shared code
    // would open a second payable surface for a purchase that already succeeded.
    // The one state that must never be started again looked exactly like the two that must.
    const { service, funding } = build(new FakeMeld());
    const key = 'idem-settled';

    await service.createSession(SUBJECT, createRequest({ idempotencyKey: key }), REQUEST_ID);
    await funding.update('funding-1', 'transaction_seen', NOW + 1, { providerTransactionId: 'tx-1' });
    await funding.update('funding-1', 'settled', NOW + 2);

    const failure = await failureOf(() =>
      service.createSession(SUBJECT, createRequest({ idempotencyKey: key }), REQUEST_ID),
    );

    const value = (failure as { value: { code: string; message: string } }).value;
    expect(value.code).toBe('REQUEST_ALREADY_SETTLED');
    // And it must not carry the instruction the safe states carry.
    expect(value.message).not.toMatch(/start a new one/i);
    expect(value.message).toMatch(/already been paid/i);
  });

  // `expired` is reached from `session_opened` and `failed` from `transaction_seen`; the machine
  // permits no other path to each, so the fixture walks the real one rather than a convenient one.
  it.each([
    ['failed', true],
    ['expired', false],
  ] as const)(
    'refuses to replay a request that concluded as %s',
    async (state, viaTransaction) => {
      // Every terminal state is driven here, each along a transition `state.ts` actually permits,
      // because the guard is one `TERMINAL_STATES.includes` and a state missing from the table is
      // a state that can be dropped from the constant without a single test noticing.
      //
      // `viaTransaction` is what makes that honest rather than decorative: `failed` is only legal
      // from `transaction_seen`, `expired` only from `session_opened`, so a table that drove one
      // path for both would be asserting against an `IllegalTransition`, not against this guard.
      const meld = new FakeMeld();
      const { service, funding } = build(meld);
      const key = `idem-${state}`;

      await service.createSession(SUBJECT, createRequest({ idempotencyKey: key }), REQUEST_ID);
      if (viaTransaction) {
        await funding.update('funding-1', 'transaction_seen', NOW + 1, { providerTransactionId: 'tx-1' });
      }
      await funding.update('funding-1', state, NOW + 2);

      const failure = await failureOf(() =>
        service.createSession(SUBJECT, createRequest({ idempotencyKey: key }), REQUEST_ID),
      );

      // Both mean the rail answered and nothing was paid, so starting a fresh intent is safe,
      // which is exactly what `settled` must not be told, and why it has its own code.
      expect((failure as { value: { code: string } }).value.code).toBe('REQUEST_CONCLUDED');
      expect(meld.calls).toHaveLength(1);
    },
  );

  it('still replays a request that is genuinely still live', async () => {
    // The guard must not swallow the property it sits next to: a retry against an open session is
    // exactly what the idempotency key exists for.
    const meld = new FakeMeld();
    const { service } = build(meld);
    const key = 'idem-live-1';

    const first = await service.createSession(SUBJECT, createRequest({ idempotencyKey: key }), REQUEST_ID);
    const replayed = await service.createSession(SUBJECT, createRequest({ idempotencyKey: key }), REQUEST_ID);

    expect(replayed).toEqual(first);
    expect(meld.calls).toHaveLength(1);
  });


  it('audits an upstream failure under the tag the caller is answered with, never the upstream text', async () => {
    // A `MeldHttpError` reaches this path without being a `Refusal`. `railRefusal` maps it the
    // same way the response path does, so a 5xx is `ProviderTimeout` in the row, in the audit
    // line and on the wire.
    //
    // The operator detail must still not reach the stream: that is where a threshold or a URL
    // would leak.
    const meld = new FakeMeld(() => new MeldHttpError(503, 'UPSTREAM', 'meld is down: api-sb.meld.io'));
    const { service, audit, funding } = build(meld);

    await service.createSession(SUBJECT, createRequest(), REQUEST_ID).catch(() => undefined);

    const refused = audit.events.find((e) => e.event === 'session.rail_refused');
    expect(refused?.reason).toBe('ProviderTimeout');
    expect(JSON.stringify(refused)).not.toContain('api-sb.meld.io');
    // And the row agrees with the answer: indefinite, so the key is kept.
    const row = await funding.byId('funding-1');
    expect(row?.status).toBe('unobserved');
    expect(row?.client_reference).toBe('idem-0000-0001');
  });

  it('keeps the key on a rail throttle, because a 429 does not prove nothing was created', async () => {
    // This briefly went the other way. A `429` was classified as definitive (freeing the key) on
    // the reasoning that Meld throttles before processing, so no settlement surface exists. The
    // reasoning does not survive the code: `MeldClient.send` turns any non-OK response into a
    // `MeldHttpError`, and nothing distinguishes a throttle from Meld's own logic from one emitted
    // by a CDN, a WAF or a load balancer in front of it, or one returned after a session was
    // created or queued.
    //
    // Freeing the key on that inference hands the retry a second settlement surface for one buyer
    // intent. Keeping it costs a throttled buyer an unhelpful `REQUEST_OUTCOME_UNKNOWN`; the other
    // direction charges them twice.
    const throttle = new MeldHttpError(429, 'RATE_LIMITED', 'slow down');
    expect(railRefusal(throttle).failure.tag).toBe('ProviderTimeout');

    const { service, funding } = build(new FakeMeld(() => throttle));
    await service.createSession(SUBJECT, createRequest(), REQUEST_ID).catch(() => undefined);

    const row = await funding.byId('funding-1');
    expect(row?.status).toBe('unobserved');
    expect(row?.client_reference).toBe('idem-0000-0001');
  });

  it('treats an unrecognised throw as indefinite, which is the safe default', async () => {
    // A rail adapter that throws something that is neither a `Refusal` nor a `MeldHttpError`: a
    // bug, a driver error, anything unforeseen. The safe reading when a payment rail's answer is
    // unknown is that a settlement surface might exist, so the row must keep the key rather than
    // hand a retry a second one. This is the branch that decides that, and nothing exercised it.
    const meld = new FakeMeld(() => new TypeError('rail adapter blew up'));
    const { service, funding } = build(meld);

    await service.createSession(SUBJECT, createRequest(), REQUEST_ID).catch(() => undefined);

    const row = await funding.byId('funding-1');
    expect(row?.status).toBe('unobserved');
    expect(row?.client_reference).toBe('idem-0000-0001');
    expect(row?.reason).toBeUndefined();
  });

  it('treats a Meld 401 as indefinite, because that is what the caller is told', async () => {
    // A wrong operator key is a `401`, not a rare shape. Classifying it as definitive would write
    // a durable `refused` row, release the idempotency key, and tell the buyer to try again.
    //
    // One rule now: the row is definitive exactly when the answer is not `ProviderTimeout`.
    const meld = new FakeMeld(() => new MeldHttpError(401, 'UNAUTHORIZED', 'bad key'));
    const { service, funding } = build(meld);

    // The raw error still leaves `Onramp` (`server.ts` is where it becomes a wire refusal), so
    // the answer the caller will be given is asserted on the shared mapping itself.
    await service.createSession(SUBJECT, createRequest(), REQUEST_ID).catch(() => undefined);
    expect(railRefusal(new MeldHttpError(401, 'UNAUTHORIZED', 'bad key')).failure.tag).toBe('ProviderTimeout');

    const row = await funding.byId('funding-1');
    expect(row?.status).toBe('unobserved');
    expect(row?.reason).toBeUndefined();
    // Kept, so a retry meets REQUEST_OUTCOME_UNKNOWN rather than opening a second surface.
    expect(row?.client_reference).toBe('idem-0000-0001');
  });

  it.each([
    // The money-losing direction, and the one that was undefended. Mutating the `definitive` test
    // to `? true` (so a 5xx or a timeout counts as "the rail read this and said no") survived all
    // 861 tests. That mutation frees the idempotency key on a failure that proves nothing, and the
    // retry the contract requires to be stable then opens a second chargeable surface for one
    // buyer intent. The audit line was asserted; the row, the state and the key were not.
    [
      'a 5xx, which proves nothing about whether a session exists',
      () => new MeldHttpError(503, 'UPSTREAM', 'meld is down'),
      'unobserved',
      'idem-0000-0001',
      undefined,
    ],
    [
      'a 400, which means the rail read the request and declined it',
      () => new MeldHttpError(400, undefined, 'Amount is below the minimum allowed, which is 18.00 EUR'),
      'refused',
      undefined,
      'BelowMinimum',
    ],
  ])('closes the reservation after %s', async (_label, fail, status, key, reason) => {
    const meld = new FakeMeld(fail);
    const { service, funding } = build(meld);

    await service.createSession(SUBJECT, createRequest(), REQUEST_ID).catch(() => undefined);

    const row = await funding.byId('funding-1');
    expect(row?.status).toBe(status);
    // The key is released only when the rail definitively answered, and kept when it did not.
    expect(row?.client_reference).toBe(key);
    // And the row records the tag the caller was answered with: `meld400` names a Meld `400`,
    // and it is named before the write rather than in the response path afterwards.
    expect(row?.reason).toBe(reason);
  });

  it('audits a refusal by the rail, not only a refusal by us', async () => {
    // The audit stream is where a dispute is answered from, so a provider-side refusal has to be
    // recorded too. Otherwise a durable `refused` row carries no line naming why.
    const meld = new FakeMeld(() => reject({ tag: 'BelowMinimum' }, '9.99 is below the minimum'));
    const { service, audit, funding } = build(meld);

    await failureOf(() => service.createSession(SUBJECT, createRequest(), REQUEST_ID));

    const refused = audit.events.find((e) => e.event === 'session.rail_refused');
    expect(refused).toMatchObject({ rail: 'meld', reason: 'BelowMinimum', alias: 'alias-abc' });
    // The durable row is still written and the key still released.
    expect((await funding.byId('funding-1'))?.status).toBe('refused');
    expect((await funding.byId('funding-1'))?.client_reference).toBeUndefined();
  });

  it('surfaces the rail\'s own error even when closing the reservation fails', async () => {
    // The compensating write is guarded, so a store failure cannot replace the error it is
    // compensating for. Unguarded, a caller owed `400 BelowMinimum` would get a bare `500`.
    const meld = new FakeMeld(() => reject({ tag: 'BelowMinimum' }, '9.99 is below the minimum'));
    const audit = new FakeAudit();
    const funding = fakeStore();
    let n = 0;
    const service = new Onramp(
      config(),
      registry(meld),
      audit,
      // Delegates to the real store, but every `update` throws, which is the compensating call
      // on this path. Spreading the instance would drop the prototype methods.
      {
        reserve: (r) => funding.reserve(r),
        create: async (r) => { await funding.create(r); },
        byAlias: (id, alias, product) => funding.byAlias(id, alias, product),
        byReference: (alias, product, ref) => funding.byReference(alias, product, ref),
        cancel: (alias, product, id, now) => funding.cancel(alias, product, id, now),
        list: (alias, product, limit) => funding.list(alias, product, limit),
        // Rejects, not throws: a synchronous throw is caught whether or not the call is
        // awaited, so it would go green against a missing `await`.
        update: () => Promise.reject(new Error('database is locked')),
      } satisfies FundingPort,
      meld,
      () => NOW,
      () => `funding-${String((n += 1))}`,
    );

    const failure = await failureOf(() => service.createSession(SUBJECT, createRequest(), REQUEST_ID));

    expect(failure).toEqual({ tag: 'BelowMinimum' });
    // And the store failure is not lost. It is audited, naming the reservation left open. The
    // reason is enumerated, not the driver's own words: SQLite messages carry the database file
    // path, and the audit stream is documented as carrying tags only.
    const orphaned = audit.events.find((e) => e.event === 'session.orphaned');
    expect(orphaned?.reason).toBe('reservation_close_failed');
    expect(JSON.stringify(orphaned)).not.toContain('database is locked');
    await funding.close();
  });

  it('persists a created request on the named rail with no provider transaction yet', async () => {
    const meld = new FakeMeld();
    const chainflip = new FakeMeld();
    chainflip.provider = 'chainflip';
    const audit = new FakeAudit();
    const funding = fakeStore();
    const service = new Onramp(
      config(),
      registry(meld, chainflip),
      audit,
      funding,
      meld,
      () => NOW,
      () => 'funding-cf',
    );

    const result = await service.createSession(
      SUBJECT,
      createRequest({ idempotencyKey: 'idem-cf', rail: 'chainflip' }),
      REQUEST_ID,
    );

    expect(chainflip.calls).toHaveLength(1);
    const record = await funding.byAlias('funding-cf', 'alias-abc', 'app.dot');
    expect(record?.rail).toBe('chainflip');
    expect(record?.provider_session_id).toBe('meld-1');
    expect(record?.provider_transaction_id).toBeUndefined();
    expect(record?.status).toBe('session_opened');
    expect(result.fundingRequestId).toBe('funding-cf');
  });

  it('records the tag on a locally refused row for every local producer, including the catalog', async () => {
    // "Refused before spending anything" is about the rail, not about the row. `refuse()` still
    // writes one, and it records the tag the caller was answered with. A triage query
    // was edited to say `WrongAssetOrChain` "never appears in this column; an unknown destination
    // code is refused before any row exists": true of the upstream call, false of the row.
    //
    // Pinned per producer, because the claim was about which values an on-call engineer can expect
    // to see, and a doc that rules one out stops them looking for it.
    for (const [overrides, expected] of [
      [{ destinationCurrencyCode: 'NOT_REAL' }, 'WrongAssetOrChain'],
      [{ sourceAmount: '9.99' }, 'BelowMinimum'],
      [{ sourceAmount: '2000.01' }, 'AboveMaximum'],
      [{ destinationCurrencyCode: 'DOT_ASSETHUB' }, 'RegionUnavailable'],
      [{ walletAddress: 'not-an-address' }, 'Other'],
    ] as const) {
      const { service, funding } = build(new FakeMeld());
      await failureOf(() => service.createSession(SUBJECT, createRequest(overrides), REQUEST_ID));

      const row = await funding.byId('funding-1');
      expect(row?.status).toBe('refused');
      expect(row?.reason).toBe(expected);
    }
  });

  describe('refuses before spending anything', () => {
    it.each([
      ['an unknown destination code', { destinationCurrencyCode: 'NOT_REAL' }, 'WrongAssetOrChain'],
      ['a destination with no configured limits', { destinationCurrencyCode: 'DOT_ASSETHUB' }, 'RegionUnavailable'],
      ['an amount below the minimum', { sourceAmount: '9.99' }, 'BelowMinimum'],
      ['an amount above the maximum', { sourceAmount: '2000.01' }, 'AboveMaximum'],
      ['an unconfigured currency', { fiat: 'EUR' }, 'Other'],
      ['an address that does not decode', { walletAddress: 'not-an-address' }, 'Other'],
      ['an unregistered rail', { rail: 'chainflip' }, 'Other'],
    ])('%s', async (_label, overrides, expectedTag) => {
      const meld = new FakeMeld();
      const { service } = build(meld);

      const failure = await failureOf(() => service.createSession(SUBJECT, createRequest(overrides), REQUEST_ID));

      expect(failure.tag).toBe(expectedTag);
      // The point of the ordering: no upstream call, so no quota spent on a locally answerable
      // refusal.
      expect(meld.calls).toHaveLength(0);
    });

    it.each([
      ['an undecodable address', { walletAddress: 'not-an-address' }, 'INVALID_ADDRESS'],
      ['a short public key', { walletAddress: SHORT_KEY_ADDRESS }, 'INVALID_ADDRESS'],
      ['an unconfigured currency', { fiat: 'EUR' }, 'CURRENCY_UNSUPPORTED'],
      ['an unregistered rail', { rail: 'chainflip' }, 'UNKNOWN_RAIL'],
    ])('gives %s a stable machine-readable code', async (_label, overrides, code) => {
      // The funding RFC has clients render the message and treat the code as opaque, so the
      // code crosses the wire as contract and is pinned. The prose deliberately is not.
      const { service } = build(new FakeMeld());

      const failure = await failureOf(() => service.createSession(SUBJECT, createRequest(overrides), REQUEST_ID));

      expect(failure).toMatchObject({ tag: 'Other', value: { code } });
      expect((failure as { value: { message: string } }).value.message).not.toBe('');
    });

    it('accepts the exact boundary amounts', async () => {
      const meld = new FakeMeld();
      const { service } = build(meld);

      // Distinct keys: two different amounts are two different buyer intents, and the same key
      // would now correctly replay the first rather than open a second session.
      await service.createSession(SUBJECT, createRequest({ sourceAmount: '10.00', idempotencyKey: 'idem-min' }), REQUEST_ID);
      await service.createSession(SUBJECT, createRequest({ sourceAmount: '2000.00', idempotencyKey: 'idem-max' }), REQUEST_ID);

      expect(meld.calls).toHaveLength(2);
    });

    it('refuses when the operator has disabled session creation', async () => {
      const meld = new FakeMeld();
      const { service } = build(meld, config({ session_creation_enabled: false }));

      expect((await failureOf(() => service.createSession(SUBJECT, createRequest(), REQUEST_ID))).tag).toBe(
        'RouteWithdrawn',
      );
      expect(meld.calls).toHaveLength(0);
    });

    it('surfaces an upstream failure rather than translating it into a refusal of its own', async () => {
      const meld = new FakeMeld(() => upstreamUnavailable('Meld POST timed out'));
      const { service } = build(meld);

      expect((await failureOf(() => service.createSession(SUBJECT, createRequest(), REQUEST_ID))).tag).toBe(
        'ProviderTimeout',
      );
    });
  });

  describe('the audit record', () => {
    it('records a created session with who asked and what was pinned', async () => {
      const { service, audit } = build(new FakeMeld());

      await service.createSession(SUBJECT, createRequest({ walletAddress: ALICE_PREFIX_42 }), REQUEST_ID);

      expect(audit.events).toEqual([
        {
          event: 'session.created',
          alias: 'alias-abc',
          productId: 'app.dot',
          requestId: REQUEST_ID,
          rail: 'meld',
          providerSessionId: 'meld-1',
          destinationCurrencyCode: 'USDC_ASSETHUB',
          // The normalised address, because that is what the rail was actually given.
          walletAddress: ALICE,
          sourceAmount: '25.00',
          fiat: 'USD',
          // The jurisdiction the purchase transacted under. It selects the provider set, the fee
          // schedule and the KYC path at the rail, and a dispute cannot be answered without it.
          country: 'US',
        },
      ]);
    });

    it('records the country on a refused row too, not only a successful one', async () => {
      // Half a fix is worse than none here: refusals are ordinary traffic (being refused is how a
      // caller learns a minimum), so "which jurisdiction was this refused under" is asked of
      // exactly the rows that were not recording it.
      const { service, funding } = build(new FakeMeld());

      await failureOf(() =>
        service.createSession(SUBJECT, createRequest({ sourceAmount: '1.00', country: 'DE' }), REQUEST_ID),
      );

      const [refused] = await funding.list(SUBJECT.alias, SUBJECT.productId, 100, true);
      expect(refused?.status).toBe('refused');
      expect(refused?.country).toBe('DE');
    });

  it('records a refusal with its enumerated reason and no operator detail', async () => {
      const { service, audit } = build(new FakeMeld());

      await failureOf(() => service.createSession(SUBJECT, createRequest({ sourceAmount: '9.99' }), REQUEST_ID));

      expect(audit.events[0]).toMatchObject({ event: 'session.refused', reason: 'BelowMinimum' });
      // The operator detail names a configured threshold; the audit trail must not carry it.
      expect(JSON.stringify(audit.events[0])).not.toContain('10.00');
    });

    it('records the terms as submitted when a refusal means nothing could be pinned', async () => {
      const { service, audit } = build(new FakeMeld());

      await failureOf(() =>
        service.createSession(SUBJECT, createRequest({ walletAddress: 'not-an-address' }), REQUEST_ID),
      );

      expect(audit.events[0]).toMatchObject({ walletAddress: 'not-an-address' });
    });

    it('records the refusal when the operator has disabled creation', async () => {
      const { service, audit } = build(new FakeMeld(), config({ session_creation_enabled: false }));

      await failureOf(() => service.createSession(SUBJECT, createRequest(), REQUEST_ID));

      // The kill switch records like any other refusal. Throwing before `recordRefusal` would
      // leave the append-only record silent for the whole kill-switch window, which is the period
      // an operator is most likely to be asked to account for.
      expect(audit.events).toHaveLength(1);
      expect(audit.events[0]).toMatchObject({
        event: 'session.refused',
        reason: 'RouteWithdrawn',
      });
    });

  });

  describe('the durable funding record', () => {
    it('persists a created request with the pinned terms and no transaction yet', async () => {
      const { service, funding } = build(new FakeMeld());

      await service.createSession(SUBJECT, createRequest({ walletAddress: ALICE_PREFIX_42 }), REQUEST_ID);

      const record = await funding.byAlias('funding-1', 'alias-abc', 'app.dot');
      expect(record?.subject_alias).toBe('alias-abc');
      expect(record?.product_id).toBe('app.dot');
      expect(record?.wallet_address).toBe(ALICE); // normalised, as sent to the rail
      expect(record?.source_amount).toBe('25.00');
      expect(record?.created_at).toBe(NOW);
      expect(record?.status).toBe('session_opened');
      expect(record?.provider_transaction_id).toBeUndefined();
      expect(record?.provider_session_id).toBe('meld-1');
    });

    it('returns the funding id the caller polls with', async () => {
      const { service } = build(new FakeMeld());
      const result = await service.createSession(SUBJECT, createRequest(), REQUEST_ID);
      expect(result.fundingRequestId).toBe('funding-1');
    });

    it('persists a refusal so the history records why funding went nowhere', async () => {
      const { service, funding } = build(new FakeMeld());

      await failureOf(() => service.createSession(SUBJECT, createRequest({ sourceAmount: '9.99' }), REQUEST_ID));

      const record = await funding.byAlias('funding-1', 'alias-abc', 'app.dot');
      expect(record?.status).toBe('refused');
      expect(record?.reason).toBe('BelowMinimum');
      expect(record?.status_history).toEqual([{ status: 'refused', at: NOW }]);
      expect(record?.provider_session_id).toBeUndefined();
    });

    it('persists a refused record when the operator has disabled creation', async () => {
      const { service, funding } = build(new FakeMeld(), config({ session_creation_enabled: false }));

      await failureOf(() => service.createSession(SUBJECT, createRequest(), REQUEST_ID));

      // The kill-switch window is visible in the caller's funding history exactly like a
      // validation refusal (the point of F4), not only in the audit log.
      const record = await funding.byAlias('funding-1', 'alias-abc', 'app.dot');
      expect(record?.status).toBe('refused');
      // The kill switch refuses with `RouteWithdrawn`, so the row says the operator closed the
      // window rather than leaving an unexplained refusal in the caller's history.
      expect(record?.reason).toBe('RouteWithdrawn');
      expect(record?.status_history).toEqual([{ status: 'refused', at: NOW }]);
      expect(record?.provider_session_id).toBeUndefined();
    });

    it('keeps the key when the rail times out, because a session may already exist', async () => {
      // A timeout must not let the retry open a second Meld session, even though the contract
      // needs the key stable across a reload and a dead row must not be replayed for ever.
      //
      // Right about the contract, wrong about what a timeout proves. `upstreamUnavailable` is
      // raised for a socket reset, an abort, or an unreadable body, every one of which is
      // consistent with Meld having created the session and the answer never arriving. Freeing the
      // key there hands the retry a second settlement surface for one buyer intent, which is the
      // failure `worker.ts`'s `created` branch and threat-model T14 both exist to prevent. The
      // in-process path was the one place still doing it.
      //
      // So the row concludes `unobserved` and keeps the key. The retry meets
      // `REQUEST_OUTCOME_UNKNOWN`, and no second session is opened.
      let fail = true;
      const meld = new FakeMeld(() => (fail ? upstreamUnavailable('Meld POST timed out') : ok()));
      const { service, funding } = build(meld);

      await failureOf(() => service.createSession(SUBJECT, createRequest(), REQUEST_ID));
      expect((await funding.byId('funding-1'))?.status).toBe('unobserved');
      expect((await funding.byId('funding-1'))?.client_reference).toBe('idem-0000-0001');

      fail = false;
      const failure = await failureOf(() => service.createSession(SUBJECT, createRequest(), REQUEST_ID));

      expect((failure as { value: { code: string } }).value.code).toBe('REQUEST_OUTCOME_UNKNOWN');
      // The rail was asked exactly once. A second call is a second chargeable surface.
      expect(meld.calls).toHaveLength(1);
    });

    it.each([
      ['a definitive rejection', () => reject({ tag: 'RouteWithdrawn' }, 'Meld says no'), 'refused', undefined, 'RouteWithdrawn'],
      ['a timeout', () => upstreamUnavailable('Meld POST timed out'), 'unobserved', 'idem-0000-0001', undefined],
    ])('closes the reservation after %s, and only frees the key when it is safe to', async (_l, fail, status, key, reason) => {
      // The row is reserved before the rail is called, so an upstream failure leaves one behind.
      // It is closed rather than deleted, so the caller's history shows that an attempt was made
      // and went nowhere. Deleting it would make that promise hold only for local refusals.
      //
      // What the failure proves decides the rest. A definitive rejection means the rail read the
      // request and said no, so no surface exists and the key is freed. A timeout proves nothing:
      // Meld may have created the session and lost the answer, so the row says `unobserved` and
      // keeps the key rather than letting a retry open a second chargeable surface.
      const meld = new FakeMeld(fail);
      const { service, funding } = build(meld);

      await failureOf(() => service.createSession(SUBJECT, createRequest(), REQUEST_ID));

      const row = await funding.byAlias('funding-1', 'alias-abc', 'app.dot');
      expect(row?.status).toBe(status);
      expect(row?.client_reference).toBe(key);
      // And the row says why. `unobserved` carries no reason deliberately: it means the outcome
      // could not be told, so a tag would assert a refusal nobody made.
      expect(row?.reason).toBe(reason);
    });

    it('tells a local refusal apart from a rail refusal, which the status alone cannot', async () => {
      // Both land in `refused`, and until the reason column they were indistinguishable in the
      // table; the audit stream separated them (`session.refused` against `session.rail_refused`)
      // but nothing a query could reach did. So "is the rail rejecting more than usual?" could
      // only be answered by joining a log, and a caller reading their own history got rows they
      // could not act on: "you are below the minimum" and "that address is malformed" looked the
      // same.
      const local = build(new FakeMeld());
      await failureOf(() => local.service.createSession(SUBJECT, createRequest({ sourceAmount: '9.99' }), REQUEST_ID));

      const rail = build(new FakeMeld(() => reject({ tag: 'RouteWithdrawn' }, 'Meld says no')));
      await failureOf(() => rail.service.createSession(SUBJECT, createRequest(), REQUEST_ID));

      const refusedLocally = await local.funding.byAlias('funding-1', 'alias-abc', 'app.dot');
      const refusedByRail = await rail.funding.byAlias('funding-1', 'alias-abc', 'app.dot');

      // Same state, which is correct, and is exactly why the state is not enough on its own.
      expect(refusedLocally?.status).toBe('refused');
      expect(refusedByRail?.status).toBe('refused');
      // Different reasons, and each is the tag the caller was actually answered with.
      expect(refusedLocally?.reason).toBe('BelowMinimum');
      expect(refusedByRail?.reason).toBe('RouteWithdrawn');
    });

    it('does not forward a field Meld invents, on a route it does not scope', async () => {
      // `transactionResponse` is `.loose()` on purpose, so a new Meld field does not break parsing.
      // The port then promised `unknown` and the whole parsed object went to the caller, so any
      // field Meld started returning, including a customer-identifying one, reached whoever held
      // the id, on the one route that is authenticated but not scoped to its owner (R12).
      //
      // Tolerance at the boundary and tolerance on the wire are two decisions, and only one of
      // them was ever made.
      const meld = new FakeMeld();
      meld.transactions['tx-1'] = {
        id: 'tx-1',
        status: 'SETTLED',
        sourceAmount: '25.00',
        // Not declared by `RailTransaction`, and exactly the shape of thing worth not forwarding.
        customerEmail: 'buyer@example.test',
        externalCustomerId: 'idem-0000-0001',
      };
      const { service } = build(meld);

      const answered = await service.transaction('tx-1');

      expect(answered.transaction).toEqual({ id: 'tx-1', status: 'SETTLED', sourceAmount: '25.00' });
      expect(JSON.stringify(answered)).not.toContain('buyer@example.test');
      // The join key is internal, not the caller's business either.
      expect(JSON.stringify(answered)).not.toContain('idem-0000-0001');
    });

    it('returns one of the caller requests by id, scoped by alias and product', async () => {
      const { service } = build(new FakeMeld());
      await service.createSession(SUBJECT, createRequest(), REQUEST_ID);

      expect((await service.get(SUBJECT, 'funding-1'))?.status).toBe('session_opened');
      expect(await service.get({ productId: 'app.dot', alias: 'alias-other', proven: true }, 'funding-1')).toBeUndefined();
      expect(await service.get({ productId: 'app.other', alias: 'alias-abc', proven: true }, 'funding-1')).toBeUndefined();
    });

    it('defaults the clock and id to real sources when not injected (production path)', async () => {
      // The zero-arg defaults (`Date.now` and `crypto.randomUUID`) are the closure the boot
      // path actually runs, but every test injects a pinned clock/id for determinism. Exercise
      // the defaults on at least one call so a regression in them cannot pass silently.
      const audit = new FakeAudit();
      const funding = fakeStore();
      const meld = new FakeMeld();
      const service = new Onramp(config(), registry(meld), audit, funding, meld);

      // Constants satisfy both assertions without exercising anything: `Date.now -> () => 1`
      // clears `created_at > 0`, and a fixed all-zero UUID is 36 characters and matches. Each
      // survived all 861 tests. A frozen clock puts every timestamp at the epoch, which is what
      // the worker's ageing reads; a constant id collides every row's primary key and files
      // every rail session under one reference.
      const before = Date.now();
      const first = await service.createSession(SUBJECT, createRequest(), REQUEST_ID);
      const second = await service.createSession(
        SUBJECT,
        createRequest({ idempotencyKey: 'idem-0000-0002' }),
        REQUEST_ID,
      );

      expect(first.fundingRequestId).toMatch(/^[0-9a-f-]{36}$/);
      // Distinct, which a constant id is not.
      expect(second.fundingRequestId).not.toBe(first.fundingRequestId);

      const record = await funding.byId(first.fundingRequestId);
      // A real clock rather than any positive number: within a minute of now, in both directions.
      expect(record?.created_at).toBeGreaterThanOrEqual(before);
      expect(record?.created_at).toBeLessThanOrEqual(Date.now() + 60_000);
      expect(record?.status).toBe('session_opened');
    });

    it("lists the caller's requests newest first, scoped to their product", async () => {
      const { service, funding } = build(new FakeMeld());
      await service.createSession(SUBJECT, createRequest(), REQUEST_ID);
      await service.createSession(SUBJECT, createRequest({ idempotencyKey: 'idem-0000-0002' }), REQUEST_ID);

      // A foreign row and a foreign product, so "scoped" is a claim the data can falsify. The
      // `every(r => r.subject_alias === 'alias-abc')` this replaces held for any return value,
      // because the store contained nothing else to exclude.
      await funding.create(
        fundingRecord({ id: 'other-alias', subject_alias: 'alias-other', client_reference: undefined }),
      );
      await funding.create(
        fundingRecord({ id: 'other-product', product_id: 'app.other', client_reference: undefined }),
      );

      const listed = await service.list(SUBJECT);
      expect(listed).toHaveLength(2);
      expect(listed.map((r) => r.id)).not.toContain('other-alias');
      expect(listed.map((r) => r.id)).not.toContain('other-product');
      expect(listed.every((r) => r.subject_alias === 'alias-abc')).toBe(true);
      expect(listed.every((r) => r.product_id === 'app.dot')).toBe(true);
    });
  });
});

describe('cancelling a request', () => {
  // The consumer lets a buyer cancel a top-up. Until this existed the cancel stopped at the
  // client: the row stayed live here and `GET /funding/:id` went on serving the capture page for
  // the rest of the session window, so a buyer told their purchase was over still had a payable
  // page open in their name.
  it('takes the settlement surface away without ending the request', async () => {
    const meld = new FakeMeld();
    const { service, funding } = build(meld);
    const opened = await service.createSession(SUBJECT, createRequest({ idempotencyKey: 'idem-cancel-1' }), REQUEST_ID);

    // Live before: the surface is offered.
    const before = toFundingRequestDto(must(await funding.byId(opened.fundingRequestId), 'the opened row'), NOW);
    expect(before.serviceProviderWidgetUrl).toBeDefined();

    const cancelled = await service.cancel(SUBJECT, opened.fundingRequestId, REQUEST_ID, NOW + 5);

    expect(cancelled?.cancelled_at).toBe(NOW + 5);
    // The status is untouched, and that is the design. A payment sent moments before the
    // cancel still has to be observed; a terminal row leaves the worker's scan, so concluding it
    // here would mean the buyer paid and nothing ever looked.
    expect(cancelled?.status).toBe('session_opened');
    expect(TERMINAL_STATES).not.toContain(cancelled?.status);

    // What actually changes is the surface, and only the surface.
    const after = toFundingRequestDto(must(cancelled, 'the cancelled row'), NOW + 5);
    expect(after.serviceProviderWidgetUrl).toBeUndefined();
    expect(after.widgetUrl).toBeUndefined();
    expect(after.expiresAt).toBeUndefined();
    expect(after.cancelledAt).toBe(NOW + 5);
  });

  it('refuses to cancel a request a payment is already on its way for', async () => {
    // The one row this must never cancel. Telling a buyer their top-up is cancelled while their
    // money is in flight is the claim this service exists not to make, and the surface would go
    // with it, so they could not even watch it land.
    const meld = new FakeMeld();
    const { service, funding } = build(meld);
    const opened = await service.createSession(SUBJECT, createRequest({ idempotencyKey: 'idem-cancel-2' }), REQUEST_ID);
    await funding.update(opened.fundingRequestId, 'transaction_seen', NOW + 1, { providerTransactionId: 'tx-1' });

    const failure = await failureOf(() => service.cancel(SUBJECT, opened.fundingRequestId, REQUEST_ID, NOW + 5));

    expect(failure).toMatchObject({
      value: {
        code: 'REQUEST_NOT_CANCELLABLE',
        message: 'A payment is already on its way for that request. It cannot be cancelled.',
        fundingRequestId: opened.fundingRequestId,
      },
    });
    // And the surface stays, so the buyer can still see the payment through.
    const row = await funding.byId(opened.fundingRequestId);
    expect(row?.cancelled_at).toBeUndefined();
    expect(toFundingRequestDto(must(row, 'the paid row'), NOW + 5).serviceProviderWidgetUrl).toBeDefined();
  });

  it('lets a cancelled request still settle, because the buyer may already have paid', async () => {
    // The whole reason cancelling is a column and not a ninth state. A transfer sent seconds
    // before the cancel arrives afterwards, and it must be recorded against this row rather than
    // vanishing: the money moved.
    const meld = new FakeMeld();
    const { service, funding } = build(meld);
    const opened = await service.createSession(SUBJECT, createRequest({ idempotencyKey: 'idem-cancel-3' }), REQUEST_ID);
    await service.cancel(SUBJECT, opened.fundingRequestId, REQUEST_ID, NOW + 5);

    await funding.update(opened.fundingRequestId, 'transaction_seen', NOW + 6, { providerTransactionId: 'tx-late' });
    await funding.update(opened.fundingRequestId, 'settled', NOW + 7);

    const row = await funding.byId(opened.fundingRequestId);
    expect(row?.status).toBe('settled');
    // Still marked cancelled: both facts are true and the record keeps both.
    expect(row?.cancelled_at).toBe(NOW + 5);
  });

  it('records the withdrawal in the audit stream, and the refused attempt too', async () => {
    // The row carries `cancelled_at`, so the fact is durable, but the row is not what ships
    // off-box. A dispute asks whether the withdrawal happened and when, and the audit stream is
    // where that is answered. The refused attempt matters for
    // the same reason and more so: a buyer who tried to cancel while their money was already
    // moving is exactly the case someone will be asked to reconstruct.
    const meld = new FakeMeld();
    const { service, funding, audit } = build(meld);

    const withdrawn = await service.createSession(SUBJECT, createRequest({ idempotencyKey: 'idem-cancel-8' }), REQUEST_ID);
    await service.cancel(SUBJECT, withdrawn.fundingRequestId, REQUEST_ID, NOW + 5);

    expect(audit.events.find((e) => e.event === 'session.cancelled')).toMatchObject({
      alias: 'alias-abc',
      productId: 'app.dot',
      requestId: REQUEST_ID,
      rail: 'meld',
      sourceAmount: '25.00',
      fiat: 'USD',
    });

    const paid = await service.createSession(SUBJECT, createRequest({ idempotencyKey: 'idem-cancel-9' }), REQUEST_ID);
    await funding.update(paid.fundingRequestId, 'transaction_seen', NOW + 6, { providerTransactionId: 'tx-1' });
    await failureOf(() => service.cancel(SUBJECT, paid.fundingRequestId, REQUEST_ID, NOW + 7));

    // `reason` says which of the two refusals it was, so the stream distinguishes "their money was
    // moving" from "it was already over" without joining anything.
    expect(audit.events.find((e) => e.event === 'session.cancel_refused')).toMatchObject({
      requestId: REQUEST_ID,
      reason: 'transaction_seen',
    });

    // A retried tap changed nothing, so it is not an event. Otherwise the stream would imply a
    // second withdrawal that never happened.
    await service.cancel(SUBJECT, withdrawn.fundingRequestId, REQUEST_ID, NOW + 8);
    expect(audit.events.filter((e) => e.event === 'session.cancelled')).toHaveLength(1);
  });

  it('refuses a request that has already concluded, and says so in those words', async () => {
    // The other arm of `REQUEST_NOT_CANCELLABLE`, which no test reached: collapsing both arms to
    // one sentence passed every gate, and the sentence that would have won is the in-flight one.
    // Telling a buyer whose money is spent "a payment is already on its way" is wrong in the
    // opposite direction. Both messages are asserted here because the code is only useful if the
    // caller can tell the two situations apart.
    const meld = new FakeMeld();
    const { service, funding } = build(meld);
    const opened = await service.createSession(SUBJECT, createRequest({ idempotencyKey: 'idem-cancel-7' }), REQUEST_ID);
    await funding.update(opened.fundingRequestId, 'expired', NOW + 1);

    const failure = await failureOf(() => service.cancel(SUBJECT, opened.fundingRequestId, REQUEST_ID, NOW + 5));

    expect(failure).toMatchObject({
      value: {
        code: 'REQUEST_NOT_CANCELLABLE',
        message: 'That request has already concluded. There is nothing to cancel.',
        fundingRequestId: opened.fundingRequestId,
      },
    });
  });

  it('is idempotent, because a retried tap is not a fault', async () => {
    const meld = new FakeMeld();
    const { service } = build(meld);
    const opened = await service.createSession(SUBJECT, createRequest({ idempotencyKey: 'idem-cancel-4' }), REQUEST_ID);

    const first = await service.cancel(SUBJECT, opened.fundingRequestId, REQUEST_ID, NOW + 5);
    const second = await service.cancel(SUBJECT, opened.fundingRequestId, REQUEST_ID, NOW + 9);

    // The second call must not move the timestamp: when it was withdrawn is a fact about the
    // buyer's decision, not about how many times the button was pressed.
    expect(first?.cancelled_at).toBe(NOW + 5);
    expect(second?.cancelled_at).toBe(NOW + 5);
  });

  it('will not cancel another caller\'s request, and does not admit it exists', async () => {
    const meld = new FakeMeld();
    const { service } = build(meld);
    const opened = await service.createSession(SUBJECT, createRequest({ idempotencyKey: 'idem-cancel-5' }), REQUEST_ID);

    // Undefined, which the route turns into the same 404 an unknown id gets, so this is not an
    // existence oracle any more than the read route is.
    expect(await service.cancel(OTHER_SUBJECT, opened.fundingRequestId, REQUEST_ID, NOW + 5)).toBeUndefined();
  });

  it('refuses to replay a cancelled key rather than handing the surface back', async () => {
    // A cancelled row is not terminal, so it reaches the replay path rather than the conclusion
    // branch. Answering `201` there would return the very capture page the cancel took away.
    const meld = new FakeMeld();
    const { service } = build(meld);
    const key = 'idem-cancel-6';
    const opened = await service.createSession(SUBJECT, createRequest({ idempotencyKey: key }), REQUEST_ID);
    await service.cancel(SUBJECT, opened.fundingRequestId, REQUEST_ID, NOW + 5);

    const failure = await failureOf(() =>
      service.createSession(SUBJECT, createRequest({ idempotencyKey: key }), REQUEST_ID),
    );

    expect(failure).toMatchObject({
      value: { code: 'REQUEST_CANCELLED', fundingRequestId: opened.fundingRequestId },
    });
    // One upstream session for the whole exchange: the replay never reached the rail.
    expect(meld.calls).toHaveLength(1);
  });
});

describe('a request that is already over answers with its outcome, whatever the price did', () => {
  // The terms-equality check compares `source_amount` and `service_provider`. The consumer leaves
  // both out of its idempotency key on purpose, because both are solved from a live rate and
  // drift between quotes. Without this ordering a fraction of a percent would decide which code
  // a concluded request answers with.
  //
  // Driven with a drifted amount in every case, because that is the ordinary path. The same
  // table with matching terms passes regardless of the ordering, so it proves nothing here.
  it.each([
    ['settled', 'REQUEST_ALREADY_SETTLED', true],
    ['failed', 'REQUEST_CONCLUDED', true],
    ['expired', 'REQUEST_CONCLUDED', false],
    ['unobserved', 'REQUEST_OUTCOME_UNKNOWN', false],
  ] as const)('answers %s with %s even when the amount moved', async (state, code, viaTransaction) => {
    const meld = new FakeMeld();
    const { service, funding } = build(meld);
    const key = `idem-drift-${state}`;
    const opened = await service.createSession(SUBJECT, createRequest({ idempotencyKey: key }), REQUEST_ID);
    if (viaTransaction) {
      await funding.update(opened.fundingRequestId, 'transaction_seen', NOW + 1, { providerTransactionId: 'tx-1' });
    }
    await funding.update(opened.fundingRequestId, state, NOW + 2);

    // The same intent, re-quoted a moment later at a price that moved.
    const failure = await failureOf(() =>
      service.createSession(SUBJECT, createRequest({ idempotencyKey: key, sourceAmount: '25.07' }), REQUEST_ID),
    );

    expect(failure).toMatchObject({ value: { code, fundingRequestId: opened.fundingRequestId } });
  });

  it('answers a cancelled request with REQUEST_CANCELLED even when the amount moved', async () => {
    const meld = new FakeMeld();
    const { service } = build(meld);
    const key = 'idem-drift-cancelled';
    const opened = await service.createSession(SUBJECT, createRequest({ idempotencyKey: key }), REQUEST_ID);
    await service.cancel(SUBJECT, opened.fundingRequestId, REQUEST_ID, NOW + 1);

    const failure = await failureOf(() =>
      service.createSession(SUBJECT, createRequest({ idempotencyKey: key, sourceAmount: '25.07' }), REQUEST_ID),
    );

    expect(failure).toMatchObject({ value: { code: 'REQUEST_CANCELLED' } });
  });

  it('still refuses a LIVE request whose terms moved, which is what that check is for', async () => {
    // The other half. Reordering must not stop a caller being handed a running settlement surface
    // committed to an intent they are no longer expressing: a live row has a surface, and that is
    // exactly the case the comparison was written to catch.
    const meld = new FakeMeld();
    const { service } = build(meld);
    const key = 'idem-drift-live';
    await service.createSession(SUBJECT, createRequest({ idempotencyKey: key }), REQUEST_ID);

    const failure = await failureOf(() =>
      service.createSession(SUBJECT, createRequest({ idempotencyKey: key, country: 'DE' }), REQUEST_ID),
    );

    expect(failure).toMatchObject({ value: { code: 'IDEMPOTENCY_KEY_REUSED' } });
  });
});

describe('a live request whose payment page has closed', () => {
  it('refuses to replay the dead page, and does not claim the request concluded', async () => {
    // `GET /funding/:id` withholds the surface once the rail's expiry passes; this path did not,
    // so one row gave two answers depending on which route asked. The row is genuinely still live
    // (`deadlineFor` ignores a rail expiry shorter than the session window, because a bank
    // transfer settles after the capture page closes), so the answer must not be "start another".
    // The rail gives a page that closes before the service's own window does, a short capture
    // window, which is the ordinary card case.
    const meld = new FakeMeld(() => ({ ...ok(), expiresAt: NOW - 1 }));
    const { service, funding } = build(meld);
    const key = 'idem-surface-expired';
    const opened = await service.createSession(SUBJECT, createRequest({ idempotencyKey: key }), REQUEST_ID);

    const failure = await failureOf(() =>
      service.createSession(SUBJECT, createRequest({ idempotencyKey: key }), REQUEST_ID),
    );

    expect(failure).toMatchObject({
      value: { code: 'REQUEST_SURFACE_EXPIRED', fundingRequestId: opened.fundingRequestId },
    });
    // Not a conclusion: the row is untouched and the worker is still watching it.
    expect((await funding.byId(opened.fundingRequestId))?.status).toBe('session_opened');
    // And no second upstream session was opened for it.
    expect(meld.calls).toHaveLength(1);
  });

  it('refuses a transaction_seen request whose page has closed, without claiming it settled or failed', async () => {
    // `session_opened` is not the only state the expiry gate guards. A row the worker has advanced
    // to `transaction_seen` (a payment observed, conclusion pending) is where a wrong `201` is
    // most expensive: the money may already be moving. The page is dead and the rail expiry has
    // passed, so the answer must still be REQUEST_SURFACE_EXPIRED, and it must not be a conclusion,
    // because `transaction_seen` has no worker path to `expired` (only a finder that answers
    // produces that) and the funds are not confirmed.
    const meld = new FakeMeld(() => ({ ...ok(), expiresAt: NOW - 1 }));
    const { service, funding } = build(meld);
    const key = 'idem-surface-expired-txn-seen';
    const opened = await service.createSession(SUBJECT, createRequest({ idempotencyKey: key }), REQUEST_ID);
    await funding.update(opened.fundingRequestId, 'transaction_seen', NOW + 1, {
      providerTransactionId: 'tx-seen',
    });

    const failure = await failureOf(() =>
      service.createSession(SUBJECT, createRequest({ idempotencyKey: key }), REQUEST_ID),
    );

    expect(failure).toMatchObject({
      value: { code: 'REQUEST_SURFACE_EXPIRED', fundingRequestId: opened.fundingRequestId },
    });
    // Not a conclusion: the row is untouched, still `transaction_seen`, and the worker is still
    // watching it for the payment it has already seen.
    expect((await funding.byId(opened.fundingRequestId))?.status).toBe('transaction_seen');
    // And no second upstream session was opened for it.
    expect(meld.calls).toHaveLength(1);
  });

  it('still replays a row the rail has not expired', async () => {
    const meld = new FakeMeld();
    const { service } = build(meld);
    const key = 'idem-surface-live';
    const opened = await service.createSession(SUBJECT, createRequest({ idempotencyKey: key }), REQUEST_ID);

    const replayed = await service.createSession(SUBJECT, createRequest({ idempotencyKey: key }), REQUEST_ID);

    expect(replayed.fundingRequestId).toBe(opened.fundingRequestId);
    expect(replayed.serviceProviderWidgetUrl).toBe(opened.serviceProviderWidgetUrl);
  });
});

describe('the reservation invariant', () => {
  it('names the request that is in the way, on every 409 that refuses because one exists', async () => {
    // Without the id these refusals are a dead end. The caller is told a request it cannot name
    // is holding the key, so it can neither resume that request nor quote it to support, and the
    // only escape left is a fresh key, which is precisely how a second settlement surface gets
    // opened for one buyer. The id is what makes "do not start another" an instruction the caller
    // can actually follow.
    //
    // Driven for the two shapes that reach it by different routes: a live row refusing on terms,
    // and a concluded row refusing on its outcome. Both must name the row, and it must be the
    // row. An id that does not resolve is worse than none.
    const meld = new FakeMeld();
    const { service, funding } = build(meld);

    const live = await service.createSession(SUBJECT, createRequest({ idempotencyKey: 'idem-id-1' }), REQUEST_ID);
    const reused = await failureOf(() =>
      service.createSession(SUBJECT, createRequest({ idempotencyKey: 'idem-id-1', country: 'DE' }), REQUEST_ID),
    );
    expect(reused).toMatchObject({
      value: { code: 'IDEMPOTENCY_KEY_REUSED', fundingRequestId: live.fundingRequestId },
    });

    const settled = await service.createSession(SUBJECT, createRequest({ idempotencyKey: 'idem-id-2' }), REQUEST_ID);
    await funding.update(settled.fundingRequestId, 'transaction_seen', NOW + 1, { providerTransactionId: 'tx-1' });
    await funding.update(settled.fundingRequestId, 'settled', NOW + 2);
    const concluded = await failureOf(() =>
      service.createSession(SUBJECT, createRequest({ idempotencyKey: 'idem-id-2' }), REQUEST_ID),
    );
    expect(concluded).toMatchObject({
      value: { code: 'REQUEST_ALREADY_SETTLED', fundingRequestId: settled.fundingRequestId },
    });

    // The id has to be resolvable by the caller that received it, or it is decoration.
    expect(await funding.byId(settled.fundingRequestId)).toBeDefined();
  });

  it('refuses a key reused with a different country, which changes the provider and the fees', async () => {
    // Country was validated, sent to the rail, and then left out of the equality check, so this
    // case silently replayed the first session, answering `201` with a jurisdiction the caller was
    // no longer expressing. It is not a cosmetic field: it selects the provider set, the fee
    // schedule and the KYC path, so the buyer pays the pinned amount and can receive a different
    // destination amount than they were quoted.
    const meld = new FakeMeld();
    const { service } = build(meld);
    const key = 'idem-country-1';

    await service.createSession(SUBJECT, createRequest({ idempotencyKey: key, country: 'US' }), REQUEST_ID);
    const failure = await failureOf(() =>
      service.createSession(SUBJECT, createRequest({ idempotencyKey: key, country: 'DE' }), REQUEST_ID),
    );

    expect((failure as { value: { code: string } }).value.code).toBe('IDEMPOTENCY_KEY_REUSED');
    // And no second upstream session was opened under the new jurisdiction.
    expect(meld.calls).toHaveLength(1);
  });

  it('pins the country on the record and echoes it back on a replay', async () => {
    // A dispute asks which jurisdiction a purchase transacted under. The row is the only place
    // that can answer, and it recorded everything except that.
    const { service, funding } = build(new FakeMeld());
    const key = 'idem-country-2';

    const created = await service.createSession(SUBJECT, createRequest({ idempotencyKey: key }), REQUEST_ID);
    expect(created.pinned.country).toBe('US');
    expect((await funding.byId(created.fundingRequestId))?.country).toBe('US');

    // The replay echoes what was committed, not what the caller happens to be sending now.
    const replayed = await service.createSession(SUBJECT, createRequest({ idempotencyKey: key }), REQUEST_ID);
    expect(replayed.pinned.country).toBe('US');
  });

  it('refuses a key reused for a different request rather than replaying the first', async () => {
    // An idempotency key answers "is this the same request?", not "have I seen this key?". A
    // caller reusing one with a different wallet and amount was handed the first request's
    // session and pinned terms, reported as a 201. That is a live settlement surface for an intent
    // they are no longer expressing. The money is safe, because the widget is locked to the pinned
    // terms and the response echoes them honestly; what breaks is the caller's own view of what
    // they asked for, and a corrupted client looks successful.
    const meld = new FakeMeld();
    const { service } = build(meld);
    const key = 'idem-reused-1';

    await service.createSession(SUBJECT, createRequest({ idempotencyKey: key }), REQUEST_ID);
    const failure = await failureOf(() =>
      service.createSession(
        SUBJECT,
        createRequest({ idempotencyKey: key, sourceAmount: '2000.00', walletAddress: BOB }),
        REQUEST_ID,
      ),
    );

    expect((failure as { value: { code: string } }).value.code).toBe('IDEMPOTENCY_KEY_REUSED');
    // And no second upstream session was opened for it.
    expect(meld.calls).toHaveLength(1);
  });

  it('answers a reused key with 409, not 400', async () => {
    // The status is what a client branches on: 400 says "your request is malformed", 409 says
    // "well formed, but it collides; mint a new key". `failureOf` discards the status, so every
    // test above asserts the code and none asserts what it answers.
    const meld = new FakeMeld();
    const { service } = build(meld);
    const key = 'idem-status';

    await service.createSession(SUBJECT, createRequest({ idempotencyKey: key }), REQUEST_ID);
    const refusal = await service
      .createSession(SUBJECT, createRequest({ idempotencyKey: key, sourceAmount: '30.00' }), REQUEST_ID)
      .catch((e: unknown) => e);

    expect((refusal as Refusal).status).toBe(409);
  });

  it.each([
    ['a different wallet', { walletAddress: BOB }],
    ['a different amount', { sourceAmount: '30.00' }],
    ['a different payment method', { paymentMethodType: 'SEPA' }],
    // Was 'a pinned provider where there was none'. `serviceProvider` is required as of
    // 2026-09-02, so a row without one is no longer reachable through the API. The case that
    // remains, and the one a re-solved quote actually produces, is a different provider.
    ['a different pinned provider', { serviceProvider: 'BANXA' }],
  ])('refuses a key reused with %s', async (_label, change) => {
    // One field at a time, so every clause of the comparison is independently load-bearing.
    // Varying two at once lets one clause cover for another being deleted.
    const meld = new FakeMeld();
    const { service } = build(meld);
    const key = 'idem-one-field';

    await service.createSession(SUBJECT, createRequest({ idempotencyKey: key }), REQUEST_ID);
    const failure = await failureOf(() =>
      service.createSession(SUBJECT, createRequest({ idempotencyKey: key, ...change }), REQUEST_ID),
    );

    expect((failure as { value: { code: string } }).value.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it.each([
    ['a different destination', { destinationCurrencyCode: 'DOT_ASSETHUB' }],
    ['a different fiat', { fiat: 'EUR' }],
  ])('refuses a key reused with %s', async (_label, change) => {
    // These two need a deployment that actually serves more than one destination and currency:
    // with a single limit configured they are refused earlier as `RegionUnavailable` or
    // `CURRENCY_UNSUPPORTED`, so the clauses that compare them look defended and are not.
    const meld = new FakeMeld();
    const { service } = build(
      meld,
      config({
        limits: [
          { code: 'USDC_ASSETHUB', min: '10.00', max: '2000.00', currency: 'USD' },
          { code: 'USDC_ASSETHUB', min: '10.00', max: '2000.00', currency: 'EUR' },
          { code: 'DOT_ASSETHUB', min: '10.00', max: '2000.00', currency: 'USD' },
        ],
      }),
    );
    const key = 'idem-multi';

    await service.createSession(SUBJECT, createRequest({ idempotencyKey: key }), REQUEST_ID);
    const failure = await failureOf(() =>
      service.createSession(SUBJECT, createRequest({ idempotencyKey: key, ...change }), REQUEST_ID),
    );

    expect((failure as { value: { code: string } }).value.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('refuses a key reused against a different rail', async () => {
    // Reachable only where a second rail is registered, so the clause comparing rails looks
    // defended by the tests above and is not: with one rail wired, the retry is refused earlier
    // as `UNKNOWN_RAIL`.
    const meld = new FakeMeld();
    const chainflip = new FakeMeld();
    chainflip.provider = 'chainflip';
    const audit = new FakeAudit();
    const funding = fakeStore();
    let n = 0;
    const service = new Onramp(
      config(),
      registry(meld, chainflip),
      audit,
      funding,
      meld,
      () => NOW,
      () => `funding-${String((n += 1))}`,
    );
    const key = 'idem-rail-swap';

    await service.createSession(SUBJECT, createRequest({ idempotencyKey: key }), REQUEST_ID);
    const failure = await failureOf(() =>
      service.createSession(SUBJECT, createRequest({ idempotencyKey: key, rail: 'chainflip' }), REQUEST_ID),
    );

    expect((failure as { value: { code: string } }).value.code).toBe('IDEMPOTENCY_KEY_REUSED');
    // The second rail was never called: the key is refused before any upstream work.
    expect(chainflip.calls).toHaveLength(0);
    await funding.close();
  });

  it('treats another spelling of the same address as the same request', async () => {
    // The comparison is against the pinned terms, so an SS58 prefix difference is not a
    // different request: `normalizeAddress` folds them to one value before anything is stored.
    // Comparing raw request fields instead would refuse a caller for retrying correctly.
    const meld = new FakeMeld();
    const { service } = build(meld);
    const key = 'idem-same-address';

    const first = await service.createSession(SUBJECT, createRequest({ idempotencyKey: key }), REQUEST_ID);
    const again = await service.createSession(
      SUBJECT,
      createRequest({ idempotencyKey: key, walletAddress: ALICE_PREFIX_42 }),
      REQUEST_ID,
    );

    expect(again).toEqual(first);
    expect(meld.calls).toHaveLength(1);
  });

  it('still replays when the retry really is the same request', async () => {
    const meld = new FakeMeld();
    const { service } = build(meld);
    const key = 'idem-same-1';

    const first = await service.createSession(SUBJECT, createRequest({ idempotencyKey: key }), REQUEST_ID);
    const again = await service.createSession(SUBJECT, createRequest({ idempotencyKey: key }), REQUEST_ID);

    expect(again).toEqual(first);
    expect(meld.calls).toHaveLength(1);
  });

  it('refuses to replay a row that holds an idempotency key but never opened a session', async () => {
    // Such a live row should not exist. The refusal path stores no reference, and a definitive
    // rail rejection releases it. Two paths now legitimately hold a key with no session (an
    // indefinite rail failure, and the worker ageing out a `created` reservation), but both write
    // a terminal state, and terminal rows are answered before this invariant is reached,
    // because freeing their key would let a retry open a second settlement surface.
    //
    // So this fires only for a row claiming to be replayable, and
    // `replay` answered `201` with two empty strings: a buyer sent nowhere to pay and a
    // `session.created` audit line for a session that never happened. Assert it rather than
    // paper over it with `?? ''`.
    const meld = new FakeMeld();
    const { service, funding, audit } = build(meld);
    await funding.create(
      fundingRecord({
        id: 'stranded',
        client_reference: createRequest().idempotencyKey,
        // Live, not terminal: a terminal row is answered by the branch above, so `expired` here
        // would pass even with the invariant deleted.
        status: 'session_opened',
        // A session id but no URL, so the second clause of the invariant is what fires. With
        // both undefined either clause alone satisfied the test, so one could be deleted unseen.
        provider_session_id: 'meld-original',
        widget_url: undefined,
        // The row's terms must match the retry's pinned terms, or the reuse check refuses first
        // and this never reaches the invariant it is named for.
        wallet_address: ALICE,
        payment_method_type: 'CREDIT_DEBIT_CARD',
      }),
    );

    await expect(service.createSession(SUBJECT, createRequest(), REQUEST_ID)).rejects.toThrow(
      /holds an idempotency key but opened no session/,
    );
    // And it says so instead of claiming a session was created.
    expect(audit.events.map((e) => e.event)).not.toContain('session.created');
    await funding.close();
  });

  it('replays a row that did open one, reproducing both URLs from the record', async () => {
    const meld = new FakeMeld();
    const { service, funding } = build(meld);
    await funding.create(
      fundingRecord({
        id: 'already',
        client_reference: createRequest().idempotencyKey,
        provider_session_id: 'meld-original',
        widget_url: 'https://provider.example/capture/1',
        hosted_widget_url: 'https://meldcrypto.com/w/1',
        // Same terms as the retry: a replay is only correct when the request really is the same
        // one, which the reuse check below now enforces.
        wallet_address: ALICE,
        payment_method_type: 'CREDIT_DEBIT_CARD',
      }),
    );

    const replayed = await service.createSession(SUBJECT, createRequest(), REQUEST_ID);

    expect(replayed.sessionId).toBe('meld-original');
    expect(replayed.serviceProviderWidgetUrl).toBe('https://provider.example/capture/1');
    expect(replayed.widgetUrl).toBe('https://meldcrypto.com/w/1');
    // Replayed, not re-opened.
    expect(meld.calls).toHaveLength(0);
    await funding.close();
  });
});

describe('recording a refusal is best-effort', () => {
  it('still answers the refusal when the durable row cannot be written', async () => {
    // The refusal is the answer, and it is already in the audit log. A store that cannot take the
    // row must not turn a deterministic 400 into a 500; that tells the caller to retry something
    // that will be refused identically for ever.
    const meld = new FakeMeld();
    const audit = new FakeAudit();
    const broken: FundingPort = {
      reserve: async () => ({ outcome: 'inserted' as const }),
      create: () => Promise.reject(new Error('disk full')),
      update: async () => undefined,
      byAlias: async () => undefined,
      byReference: async () => undefined,
      cancel: async () => undefined,
      list: async () => [],
    };
    const service = new Onramp(config(), registry(meld), audit, broken, meld, () => NOW);

    const failure = await failureOf(() =>
      service.createSession(SUBJECT, createRequest({ walletAddress: 'not-an-address' }), REQUEST_ID),
    );

    expect(failure).toEqual({
      tag: 'Other',
      value: { code: 'INVALID_ADDRESS', message: 'The destination address is not valid.' },
    });
    // The audit line is the record of last resort, and it went out.
    expect(audit.events.map((e) => e.event)).toEqual(['session.refused']);
    expect(meld.calls).toHaveLength(0);
  });

  it('names the rail on a refusal, as it does on a creation', async () => {
    const meld = new FakeMeld();
    const { service, funding, audit } = build(meld, config({ session_creation_enabled: false }));

    await failureOf(() => service.createSession(SUBJECT, createRequest(), REQUEST_ID));

    // Which rail refused is the first question a support conversation asks, so the refusal
    // record names it.
    expect(audit.events).toEqual([
      expect.objectContaining({ event: 'session.refused', rail: 'meld', reason: 'RouteWithdrawn' }),
    ]);
    // And the kill-switch refusal is durable. Asked for explicitly: refusals are excluded from the
    // default list so they cannot evict a live request, and the claim here is that the row exists,
    // not that a buyer is shown it.
    expect((await funding.list(SUBJECT.alias, SUBJECT.productId, 100, true)).map((r) => r.status)).toEqual([
      'refused',
    ]);
    await funding.close();
  });
});
