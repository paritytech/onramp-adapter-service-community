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
import { config, createRequest, fakeStore } from './fixtures.js';

/** An `insecure_dev`-shaped caller. The alias is shared per product, so `proven` is false. */
const SUBJECT = { productId: 'app.dot', alias: 'dev:app.dot', proven: false };

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
} = {}): Discovery {
  return {
    corridor: async (country, fiat, crypto): Promise<Corridor> => {
      if (opts.corridorRefuses) throw reject({ tag: 'RegionUnavailable' }, 'discovery refused the corridor');
      if (opts.corridorThrows) throw new Error('meld catalog unreachable');
      return { country, fiat, crypto, methods: opts.methods ?? [method()] };
    },
    corridorForCountry: async (country, crypto): Promise<Corridor> => {
      if (opts.corridorThrows) throw new Error('meld catalog unreachable');
      return { country, fiat: 'CAD', crypto, methods: opts.methods ?? [method()] };
    },
    countries: async (_crypto): Promise<CountryRow[]> => opts.rows ?? [{ country: 'US', name: 'United States' }],
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
