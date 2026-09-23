import { describe, expect, it } from 'vitest';

import type { AuditEvent, AuditLog } from '../src/audit.js';
import { Refusal, reject } from '../src/contract.js';
import { Onramp } from '../src/onramp.js';
import type { Corridor, CountryRow, Discovery, MethodLimit } from '../src/meld/discovery.js';
import type {
  FundingRail,
  MeldTransactionReader,
  RailName,
  RailQuote,
  RailSession,
  RailSessionInput,
  RailTransaction,
} from '../src/rail.js';
import { config, createRequest, fakeStore, sellQuoteBody, sellRequest } from './fixtures.js';

/** An `insecure_dev`-shaped caller. The alias is shared per product, so `proven` is false. */
const SUBJECT = { productId: 'app.dot', alias: 'dev:app.dot', network: 'previewnet', proven: false };

/** A session body for a corridor the caller names, defaulting to the fixture's. */
const sessionBody = (over: Record<string, unknown> = {}) => createRequest({ destinationCurrencyCode: 'DOT_ASSETHUB', ...over });

const NOW = 1_700_000_000_000;

/** The Meld rail, reduced to what these tests touch: it quotes and opens a session without fuss. */
class FakeMeld implements FundingRail, MeldTransactionReader {
  provider: RailName = 'meld';
  async createSession(_input: RailSessionInput): Promise<RailSession> {
    return {
      providerSessionId: 'meld-1',
      settlementUrl: 'https://meldcrypto.com/session/meld-1',
      hostedWidgetUrl: undefined,
      expiresAt: 1_800_000_000_000,
    };
  }
  async quote(_input: RailQuote): Promise<unknown[]> {
    return [{ serviceProvider: 'TRANSAK', sourceAmount: '50' }];
  }
  async transaction(id: string): Promise<RailTransaction> {
    return { id };
  }
}

class FakeAudit implements AuditLog {
  info = (_event: AuditEvent): void => undefined;
}

function method(over: Partial<MethodLimit> = {}): MethodLimit {
  return {
    paymentMethodType: 'CREDIT_DEBIT_CARD',
    category: 'card',
    min: '5',
    max: '3000',
    currency: 'USD',
    providers: ['TRANSAK'],
    ...over,
  };
}

/** A discovery double whose corridor/countries answers (or throws) are set per test. */
function fakeDiscovery(opts: {
  methods?: MethodLimit[];
  corridorThrows?: boolean;
  /** Throws a `Refusal` rather than a transport error: a corridor discovery can see is not offered. */
  corridorRefuses?: boolean;
  rows?: CountryRow[];
  /** Records every `direction` a call arrived with, so a test can assert it was threaded through. */
  directions?: string[];
} = {}): Discovery {
  return {
    corridor: async (country, fiat, crypto, direction): Promise<Corridor> => {
      opts.directions?.push(direction);
      if (opts.corridorRefuses) throw reject({ tag: 'RegionUnavailable' }, 'discovery refused the corridor');
      if (opts.corridorThrows) throw new Error('meld catalog unreachable');
      return { country, fiat, crypto, methods: opts.methods ?? [method()] };
    },
    corridorForCountry: async (country, crypto, direction): Promise<Corridor> => {
      opts.directions?.push(direction);
      if (opts.corridorThrows) throw new Error('meld catalog unreachable');
      return { country, fiat: 'CAD', crypto, methods: opts.methods ?? [method()] };
    },
    countries: async (_crypto, direction): Promise<CountryRow[]> => {
      opts.directions?.push(direction);
      return opts.rows ?? [{ country: 'US', name: 'United States' }];
    },
    // `corridorForCountry` above answers with a fixed fiat, so this agrees with it.
    defaultFiat: async (_country, direction): Promise<string> => {
      opts.directions?.push(direction);
      if (opts.corridorThrows) throw new Error('meld catalog unreachable');
      return 'CAD';
    },
  };
}

const build = (discovery: Discovery | undefined) =>
  new Onramp(config(), { meld: new FakeMeld() }, new FakeAudit(), fakeStore(), new FakeMeld(), () => NOW, () => 'funding-1', discovery);

const quoteBody = (over: Record<string, unknown> = {}) => ({
  country: 'US',
  fiat: 'USD',
  destinationCurrencyCode: 'DOT_ASSETHUB',
  sourceAmount: '50',
  paymentMethodType: 'CREDIT_DEBIT_CARD',
  ...over,
});

async function refusalOf(fn: () => Promise<unknown>): Promise<{ tag: string; code?: string }> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof Refusal) {
      const f = e.failure as { tag: string; value?: { code?: string } };
      const code = f.value?.code;
      return code === undefined ? { tag: f.tag } : { tag: f.tag, code };
    }
    throw e;
  }
  throw new Error('expected a Refusal');
}

describe('Onramp limit gate over live discovery', () => {
  // config() carries one floor: USDC_ASSETHUB / USD = 10 to 2000. DOT_ASSETHUB has none, so it
  // exercises the no-floor branch; USDC_ASSETHUB exercises the floor-tighten and inversion ones.
  const usdc = (over: Record<string, unknown> = {}) =>
    quoteBody({ destinationCurrencyCode: 'USDC_ASSETHUB', ...over });

  it('tightens the live bound with the configured floor (10 to 2000 beats 5 to 3000)', async () => {
    const svc = build(fakeDiscovery({ methods: [method({ min: '5', max: '3000' })] }));
    expect((await svc.quote(usdc())).quotes).toHaveLength(1);
  });

  it('uses the live bound as-is when no configured floor names that (code, currency)', async () => {
    // DOT_ASSETHUB has no floor in config(), so the corridor's own bound is returned.
    const svc = build(fakeDiscovery());
    expect((await svc.quote(quoteBody())).quotes).toHaveLength(1);
  });

  /**
   * The case this branch exists for, and the one the previous test did not reach.
   *
   * It passed `method({ min: '5', max: '3' })`, a corridor Meld reported backwards, which
   * executes the same line but is not the dangerous input. The dangerous input is an operator cap
   * sitting below the corridor's floor, because the old branch answered it by discarding the cap
   * and quoting the live bound. With `limits` at 10 to 2000 and a corridor of 5000 to 9000, a 6000
   * charge was permitted against a configured ceiling of 2000.
   */
  it('refuses a corridor whose live floor sits above the configured cap', async () => {
    const svc = build(fakeDiscovery({ methods: [method({ min: '5000', max: '9000' })] }));
    expect(await refusalOf(() => svc.quote(usdc({ sourceAmount: '6000' })))).toEqual({
      tag: 'Other',
      code: 'CORRIDOR_UNAVAILABLE',
    });
  });

  it('refuses a corridor whose live ceiling sits below the configured floor', async () => {
    // The same non-overlap from the other side: floor min 10 against a corridor capped at 5.
    const svc = build(fakeDiscovery({ methods: [method({ min: '1', max: '5' })] }));
    expect(await refusalOf(() => svc.quote(usdc()))).toEqual({
      tag: 'Other',
      code: 'CORRIDOR_UNAVAILABLE',
    });
  });

  it('refuses rather than propagating a corridor Meld itself reported inverted', async () => {
    // The old test's input. It is still a non-overlap, and returning it would have handed a
    // caller min 5 / max 3, a range no amount satisfies, instead of saying so.
    const svc = build(fakeDiscovery({ methods: [method({ min: '5', max: '3' })] }));
    expect((await refusalOf(() => svc.quote(usdc()))).code).toBe('CORRIDOR_UNAVAILABLE');
  });

  it('does not refuse when the ranges overlap at a single point', async () => {
    // Boundary: corridor 2000 to 9000 against floor 10 to 2000 leaves exactly 2000 buyable. `>`
    // rather than `>=` is what keeps this a quote instead of a refusal.
    const svc = build(fakeDiscovery({ methods: [method({ min: '2000', max: '9000' })] }));
    expect((await svc.quote(usdc({ sourceAmount: '2000' }))).quotes).toHaveLength(1);
  });

  it('refuses CURRENCY_UNSUPPORTED when no provider routes the corridor', async () => {
    const svc = build(fakeDiscovery({ methods: [] }));
    expect(await refusalOf(() => svc.quote(quoteBody()))).toEqual({
      tag: 'Other',
      code: 'CURRENCY_UNSUPPORTED',
    });
  });

  it('refuses PAYMENT_METHOD_UNSUPPORTED when the corridor lacks the chosen method', async () => {
    const svc = build(fakeDiscovery({ methods: [method({ paymentMethodType: 'SEPA', category: 'bank' })] }));
    expect(await refusalOf(() => svc.quote(quoteBody()))).toEqual({
      tag: 'Other',
      code: 'PAYMENT_METHOD_UNSUPPORTED',
    });
  });

  it('degrades to the configured floor when the catalog is unreachable', async () => {
    // corridor() throws (transport), so the gate falls back to config.limits, where USDC/USD is.
    const svc = build(fakeDiscovery({ corridorThrows: true }));
    expect((await svc.quote(usdc())).quotes).toHaveLength(1);
  });

  /**
   * A catalog outage must not refuse a quote for a corridor that has no fallback row.
   *
   * `config.limits` floors only USDC/USD, so every corridor discovery added (DOT in CAD, EUR
   * and the rest) has nothing to fall back to. Gating the read-only price path on the catalog
   * turned a blip in `/supported/*` into a refusal for exactly those corridors, while Meld's own
   * `/quote` was up and would have priced them.
   */
  it('still quotes an unfloored corridor while the catalog is down', async () => {
    const svc = build(fakeDiscovery({ corridorThrows: true }));
    expect((await svc.quote(quoteBody({ fiat: 'CAD', country: 'CA' }))).quotes).toHaveLength(1);
  });

  it('refuses a session for that same corridor while the catalog is down', async () => {
    // The other half of the split: a session is about to charge a card, so an outage is a reason
    // to refuse, and the empty fallback for CAD fails closed.
    const svc = build(fakeDiscovery({ corridorThrows: true }));
    expect((await refusalOf(() => svc.createSession(SUBJECT, sessionBody({ fiat: 'CAD', country: 'CA' }), 'req-1'))).tag)
      .toBe('RegionUnavailable');
  });
});

describe('Onramp.supported / supportedCountries', () => {
  it('returns the corridor and the country catalog when discovery is wired', async () => {
    const svc = build(fakeDiscovery({ rows: [{ country: 'CA', name: 'Canada' }] }));
    expect((await svc.supported('CA', 'DOT_ASSETHUB')).methods).toHaveLength(1);
    expect((await svc.supportedCountries('DOT_ASSETHUB')).map((r) => r.country)).toEqual(['CA']);
  });

  it('refuses an unknown crypto before probing', async () => {
    const svc = build(fakeDiscovery());
    expect((await refusalOf(() => svc.supported('US', 'NOPE'))).tag).toBe('WrongAssetOrChain');
  });

  it('answers DISCOVERY_UNAVAILABLE when discovery is not configured', async () => {
    const svc = build(undefined);
    expect(await refusalOf(() => svc.supported('US', 'DOT_ASSETHUB'))).toEqual({
      tag: 'Other',
      code: 'DISCOVERY_UNAVAILABLE',
    });
    expect(await refusalOf(() => svc.supportedCountries('DOT_ASSETHUB'))).toEqual({
      tag: 'Other',
      code: 'DISCOVERY_UNAVAILABLE',
    });
  });

  it('defaults an absent direction to buy, byte for byte with a caller written before sell existed', async () => {
    const directions: string[] = [];
    const svc = build(fakeDiscovery({ directions }));
    await svc.supported('US', 'DOT_ASSETHUB');
    await svc.supportedCountries('DOT_ASSETHUB');
    expect(directions).toEqual(['buy', 'buy']);
  });

  it('threads an explicit sell direction through to discovery', async () => {
    const directions: string[] = [];
    const svc = build(fakeDiscovery({ directions }));
    await svc.supported('US', 'DOT_ASSETHUB', 'sell');
    await svc.supportedCountries('DOT_ASSETHUB', 'sell');
    expect(directions).toEqual(['sell', 'sell']);
  });
});

describe('Onramp.supportedCorridors', () => {
  const pix = { paymentMethodType: 'PIX', category: 'bank' as const, min: '10', max: '5000', currency: 'BRL' };
  const payout = { paymentMethodType: 'PAYOUT_TO_BANK', category: 'bank' as const, min: '5', max: '1000', currency: 'BRL' };

  it('reads cached corridors from the store, off Meld, without needing discovery', async () => {
    const store = fakeStore();
    await store.upsertCorridor({ destination_currency_code: 'DOT_ASSETHUB', direction: 'buy', country: 'BR', name: 'Brazil', fiat: 'BRL', methods: [pix] });
    // No discovery wired: the bulk read is DB-backed.
    const svc = new Onramp(config(), { meld: new FakeMeld() }, new FakeAudit(), store, new FakeMeld(), () => NOW, () => 'funding-1', undefined);

    expect(await svc.supportedCorridors('DOT_ASSETHUB')).toEqual([
      { country: 'BR', name: 'Brazil', fiat: 'BRL', methods: [pix] },
    ]);
  });

  it('reads the sell row rather than the buy one when asked for direction sell', async () => {
    const store = fakeStore();
    await store.upsertCorridor({ destination_currency_code: 'DOT_ASSETHUB', direction: 'buy', country: 'BR', name: 'Brazil', fiat: 'BRL', methods: [pix] });
    await store.upsertCorridor({ destination_currency_code: 'DOT_ASSETHUB', direction: 'sell', country: 'BR', name: 'Brazil', fiat: 'BRL', methods: [payout] });
    const svc = new Onramp(config(), { meld: new FakeMeld() }, new FakeAudit(), store, new FakeMeld(), () => NOW, () => 'funding-1', undefined);

    expect(await svc.supportedCorridors('DOT_ASSETHUB')).toEqual([{ country: 'BR', name: 'Brazil', fiat: 'BRL', methods: [pix] }]);
    expect(await svc.supportedCorridors('DOT_ASSETHUB', 'sell')).toEqual([{ country: 'BR', name: 'Brazil', fiat: 'BRL', methods: [payout] }]);
  });

  it('hides a stale corridor whose row predates the freshness window', async () => {
    const store = fakeStore();
    await store.upsertCorridor({ destination_currency_code: 'DOT_ASSETHUB', direction: 'buy', country: 'BR', name: 'Brazil', fiat: 'BRL', methods: [pix] });
    // A clock far past the row's stamp (2e12) puts it outside `now - 3*interval`, so it is filtered.
    const svc = new Onramp(config(), { meld: new FakeMeld() }, new FakeAudit(), store, new FakeMeld(), () => 3_000_000_000_000, () => 'funding-1', undefined);

    expect(await svc.supportedCorridors('DOT_ASSETHUB')).toEqual([]);
  });

  it('refuses an unknown crypto before reading', async () => {
    const svc = build(undefined);
    expect((await refusalOf(() => svc.supportedCorridors('NOPE'))).tag).toBe('WrongAssetOrChain');
  });
});

/** `sellQuoteBody`/`sellRequest` are built loosely (see `fixtures.ts`); cast at the call site,
 *  matching the pattern `onramp.test.ts` already uses for `sellRequest`. */
const asQuote = (body: Record<string, unknown>) => body as unknown as Parameters<Onramp['quote']>[0];
const asSession = (body: Record<string, unknown>) => body as unknown as Parameters<Onramp['createSession']>[1];

describe('Onramp limit gate on a sell: corridor/method checked, amount never gated', () => {
  /**
   * The decision this step made: `limitFor` runs for a sell too, so an unrouted corridor or an
   * unoffered payout method is refused locally, before any rail call -- exactly as a buy is. What
   * it does not do is compare the committed crypto amount against the corridor's (fiat) bound; see
   * `limitFor`'s own doc comment in `onramp.ts` for the full reasoning.
   */
  it('refuses CURRENCY_UNSUPPORTED for a sell corridor no provider routes', async () => {
    const svc = build(fakeDiscovery({ methods: [] }));
    expect(await refusalOf(() => svc.quote(asQuote(sellQuoteBody())))).toEqual({ tag: 'Other', code: 'CURRENCY_UNSUPPORTED' });
  });

  it('refuses PAYMENT_METHOD_UNSUPPORTED for a sell payout method the corridor does not offer', async () => {
    const svc = build(fakeDiscovery({ methods: [method({ paymentMethodType: 'PAYOUT_TO_CARD', category: 'card' })] }));
    expect(await refusalOf(() => svc.quote(asQuote(sellQuoteBody())))).toEqual({
      tag: 'Other',
      code: 'PAYMENT_METHOD_UNSUPPORTED',
    });
  });

  it('quotes a sell whose corridor and method both exist, at any amount, with no local bound applied', async () => {
    const svc = build(fakeDiscovery({ methods: [method({ paymentMethodType: 'PAYOUT_TO_BANK', category: 'bank', min: '1', max: '2' })] }));
    // An amount wildly outside the corridor's (fiat) min/max is still quoted: that bound does not
    // apply to a crypto amount, and no crypto-denominated one exists locally to apply instead.
    expect((await svc.quote(asQuote(sellQuoteBody({ cryptoAmount: '999999999.123456789012' })))).quotes).toHaveLength(1);
  });

  it('opens a sell session under the same corridor/method checks, still with no amount gate', async () => {
    const svc = build(fakeDiscovery({ methods: [method({ paymentMethodType: 'PAYOUT_TO_BANK', category: 'bank' })] }));
    const opened = await svc.createSession(SUBJECT, asSession(sellRequest()), 'req-sell-1');
    expect(opened.pinned.cryptoAmount).toBe('12.3456789012');
  });

  it('refuses a sell session locally for an unoffered method, before any rail call', async () => {
    const svc = build(fakeDiscovery({ methods: [method({ paymentMethodType: 'PAYOUT_TO_CARD', category: 'card' })] }));
    expect((await refusalOf(() => svc.createSession(SUBJECT, asSession(sellRequest()), 'req-sell-2'))).code).toBe(
      'PAYMENT_METHOD_UNSUPPORTED',
    );
  });

  it('passes the sell direction to discovery.corridor, not the buy corridor for the same crypto', async () => {
    const directions: string[] = [];
    const svc = build(fakeDiscovery({ methods: [method({ paymentMethodType: 'PAYOUT_TO_BANK', category: 'bank' })], directions }));
    await svc.quote(asQuote(sellQuoteBody()));
    expect(directions).toEqual(['sell']);
  });

  it('reaches Meld ungated during a discovery outage on a sell quote, same as a buy quote does', async () => {
    const svc = build(fakeDiscovery({ corridorThrows: true }));
    expect((await svc.quote(asQuote(sellQuoteBody()))).quotes).toHaveLength(1);
  });

  /**
   * Unlike a buy, a sell session also reaches Meld ungated during an outage: `config.limits` is a
   * fiat business-floor list, not a corridor/method existence table, so there is nothing for a
   * sell to fail closed against. This is the pre-existing posture (a sell skipped this whole gate
   * before direction-aware discovery existed), not a new hole; see `limitFor`'s doc comment.
   */
  it('reaches Meld ungated during a discovery outage on a sell session too', async () => {
    const svc = build(fakeDiscovery({ corridorThrows: true }));
    const opened = await svc.createSession(SUBJECT, asSession(sellRequest()), 'req-sell-3');
    expect(opened.pinned.cryptoAmount).toBe('12.3456789012');
  });
});

describe('a refusal from discovery is not an outage', () => {
  /**
   * The bare `catch` took everything, including a deliberate `Refusal`.
   *
   * Swallowing one answered a "this corridor is not offered" from `config.limits` (the single
   * source that cannot know whether Meld offers a corridor), so a refusal discovery raised
   * deliberately came back as a successful quote against a stale configured floor.
   */
  it('propagates a Refusal instead of degrading to the configured floor', async () => {
    const svc = build(fakeDiscovery({ corridorRefuses: true }));
    // USDC/USD is floored in config(), so the old bare catch quoted this successfully.
    expect((await refusalOf(() => svc.quote(quoteBody({ destinationCurrencyCode: 'USDC_ASSETHUB' })))).tag)
      .toBe('RegionUnavailable');
  });

  it('propagates it on the session path too, where the fallback would also have applied', async () => {
    const svc = build(fakeDiscovery({ corridorRefuses: true }));
    expect((await refusalOf(() => svc.createSession(SUBJECT, sessionBody({ destinationCurrencyCode: 'USDC_ASSETHUB' }), 'req-2'))).tag)
      .toBe('RegionUnavailable');
  });
});
