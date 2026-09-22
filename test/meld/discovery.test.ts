import { describe, expect, it, vi } from 'vitest';

import { MeldDiscovery, toCorridorDto } from '../../src/meld/discovery.js';

/** One lifetime for all three endpoints, which is what these tests assumed before the split. */
const ttls = (ms: number) => ({ countries: ms, defaults: ms, routes: ms });

// A canned Meld dataset, keyed the way the live endpoints are pathed. Amounts are STRINGS: the real
// `authedGet` preserves Meld's JSON numbers verbatim, so the module is fed strings.
const COUNTRIES = {
  countries: [
    { countryCode: 'US', name: 'United States' },
    { countryCode: 'CA', name: 'Canada' },
    { countryCode: 'IN', name: 'India' },
    { countryCode: 'MX', name: 'Mexico' }, // wallet + other categories
    { countryCode: 'XX', name: 'Errorland' }, // defaults probe throws -> dropped
    { countryCode: 'YY', name: 'Routeless' }, // routes probe throws -> dropped
    { countryCode: 'NF', name: 'Nofiat' }, // defaults carry no currencyCode -> dropped
  ],
};
const DEFAULTS: Record<string, unknown> = {
  US: { countryCode: 'US', currencyCode: 'USD' },
  CA: { countryCode: 'CA', currencyCode: 'CAD' },
  IN: { countryCode: 'IN', currencyCode: 'INR' },
  MX: { countryCode: 'MX', currencyCode: 'MXN' },
  YY: { countryCode: 'YY', currencyCode: 'YYY' },
  NF: { countryCode: 'NF' }, // no currencyCode
};
// on-ramp routes keyed `${country}/${fiat}/${crypto}` (source=fiat, destination=crypto).
const ROUTES: Record<string, unknown> = {
  'US/USD/DOT_ASSETHUB': [
    {
      partner: 'TRANSAK',
      paymentMethods: [
        { name: 'CREDIT_DEBIT_CARD', paymentType: 'CARD', limits: { currencyCode: 'USD', min: '5', max: '3000' } },
      ],
    },
    {
      partner: 'GUARDARIAN',
      paymentMethods: [
        { name: 'CREDIT_DEBIT_CARD', paymentType: 'CARD', limits: { currencyCode: 'USD', min: '10', max: '16000' } },
        { name: 'ACH', paymentType: 'BANK_TRANSFER', limits: { currencyCode: 'USD', min: '11', max: '16000' } },
        // A method with no bound must be dropped, not admitted unbounded.
        { name: 'MYSTERY', paymentType: 'CARD', limits: null },
      ],
    },
    {
      // A third provider whose card minimum is below the running min, so the aggregation lowers it.
      partner: 'TOPPER',
      paymentMethods: [
        { name: 'CREDIT_DEBIT_CARD', paymentType: 'CARD', limits: { currencyCode: 'USD', min: '2', max: '9' } },
      ],
    },
  ],
  'CA/CAD/DOT_ASSETHUB': [
    {
      partner: 'TRANSAK',
      paymentMethods: [
        { name: 'CREDIT_DEBIT_CARD', paymentType: 'CARD', limits: { currencyCode: 'CAD', min: '7', max: '8314' } },
      ],
    },
  ],
  'IN/INR/DOT_ASSETHUB': [],
  'MX/MXN/DOT_ASSETHUB': [
    {
      partner: 'TRANSAK',
      paymentMethods: [
        { name: 'CREDIT_DEBIT_CARD', paymentType: 'CARD', limits: { currencyCode: 'MXN', min: '85', max: '101767' } },
        { name: 'APPLE_PAY', paymentType: 'MOBILE_WALLET', limits: { currencyCode: 'MXN', min: '509', max: '50884' } },
        { name: 'SPEI', paymentType: 'SOMETHING_NEW', limits: { currencyCode: 'MXN', min: '100', max: '90000' } },
      ],
    },
  ],
  // USDC is served in fewer places than DOT: the point of the cross-crypto cache test.
  'US/USD/USDC_ASSETHUB': [
    {
      partner: 'TRANSAK',
      paymentMethods: [
        { name: 'CREDIT_DEBIT_CARD', paymentType: 'CARD', limits: { currencyCode: 'USD', min: '5', max: '3000' } },
      ],
    },
  ],
  'CA/CAD/USDC_ASSETHUB': [],
  'IN/INR/USDC_ASSETHUB': [],
};
// off-ramp routes keyed `${country}/${crypto}/${fiat}` (source=crypto, destination=fiat): the
// swapped order §5 of the probe verified live.
const OFFRAMP_ROUTES: Record<string, unknown> = {
  'GB/BTC/GBP': [
    {
      partner: 'TRANSAK',
      paymentMethods: [
        { name: 'PAYOUT_TO_BANK', paymentType: 'BANK_TRANSFER', limits: { currencyCode: 'GBP', min: '7', max: '18550' } },
      ],
    },
  ],
};

/** A stub of `MeldClient.authedGet`, plus the spy so a test can count upstream calls. */
function stubGet() {
  return vi.fn(async (path: string): Promise<unknown> => {
    if (path.startsWith('/network-partner/supported/countries')) return COUNTRIES;
    const def = /^\/network-partner\/defaults\/([A-Z]{2})\//.exec(path);
    if (def) {
      if (def[1] === 'XX') throw new Error('defaults upstream down');
      return DEFAULTS[def[1] as string];
    }
    const onramp = /^\/network-partner\/supported\/routes\/CRYPTO_ONRAMP\/(.+)$/.exec(path);
    if (onramp) {
      if ((onramp[1] as string).startsWith('YY/')) throw new Error('routes upstream down');
      return ROUTES[onramp[1] as string] ?? [];
    }
    const offramp = /^\/network-partner\/supported\/routes\/CRYPTO_OFFRAMP\/(.+)$/.exec(path);
    if (offramp) return OFFRAMP_ROUTES[offramp[1] as string] ?? [];
    if (path.startsWith('/network-partner/supported/fiat-limits')) return { fiatLimits: [] };
    throw new Error(`unexpected path ${path}`);
  });
}

describe('MeldDiscovery.corridor', () => {
  it('aggregates a corridor across providers: min-of-mins, max-of-maxes, provider union', async () => {
    const d = new MeldDiscovery(stubGet(), ttls(3_600_000));
    const { methods } = await d.corridor('US', 'USD', 'DOT_ASSETHUB', 'buy');

    const card = methods.find((m) => m.paymentMethodType === 'CREDIT_DEBIT_CARD');
    expect(card).toEqual({
      paymentMethodType: 'CREDIT_DEBIT_CARD',
      category: 'card',
      min: '2', // min(5, 10, 2): the later, lower TOPPER min lowers it
      max: '16000', // max(3000, 16000, 9)
      currency: 'USD',
      providers: ['TRANSAK', 'GUARDARIAN', 'TOPPER'],
    });
    // BANK_TRANSFER maps to `bank`; the boundless MYSTERY method is dropped.
    expect(methods.find((m) => m.paymentMethodType === 'ACH')?.category).toBe('bank');
    expect(methods.some((m) => m.paymentMethodType === 'MYSTERY')).toBe(false);
  });

  it('reads an empty route array as a corridor that is not served', async () => {
    const d = new MeldDiscovery(stubGet(), ttls(3_600_000));
    expect((await d.corridor('IN', 'INR', 'DOT_ASSETHUB', 'buy')).methods).toEqual([]);
  });

  it('maps every payment-type bucket: card, wallet, and an unknown type as other', async () => {
    const d = new MeldDiscovery(stubGet(), ttls(3_600_000));
    const { methods } = await d.corridor('MX', 'MXN', 'DOT_ASSETHUB', 'buy');
    const cat = (id: string) => methods.find((m) => m.paymentMethodType === id)?.category;
    expect(cat('CREDIT_DEBIT_CARD')).toBe('card');
    expect(cat('APPLE_PAY')).toBe('wallet'); // MOBILE_WALLET
    expect(cat('SPEI')).toBe('other'); // unrecognised paymentType
  });

  it('caches a corridor for its TTL: a second identical call hits no upstream', async () => {
    const get = stubGet();
    const d = new MeldDiscovery(get, ttls(3_600_000));
    await d.corridor('CA', 'CAD', 'DOT_ASSETHUB', 'buy');
    await d.corridor('CA', 'CAD', 'DOT_ASSETHUB', 'buy');
    expect(get.mock.calls.filter(([p]) => p.includes('/routes/')).length).toBe(1);
  });
});

describe('MeldDiscovery direction: category and route argument order', () => {
  /**
   * The finding the probe calls out as the one most likely to be implemented wrong: the routes
   * path is `/routes/{category}/{country}/{SOURCE}/{DESTINATION}`, and source/destination swap
   * with direction. A buy's fiat is the source; a sell's crypto is. Pinned against the exact
   * strings the probe observed live, so a regression that reuses the buy order under the sell
   * category fails here rather than only returning `200 []`, which reads exactly like "not
   * offered" (see `discovery.ts`'s module header).
   */
  it('reads a buy corridor at .../CRYPTO_ONRAMP/{country}/{fiat}/{crypto}', async () => {
    const get = stubGet();
    const d = new MeldDiscovery(get, ttls(3_600_000));
    await d.corridor('US', 'USD', 'DOT_ASSETHUB', 'buy');
    expect(get).toHaveBeenCalledWith('/network-partner/supported/routes/CRYPTO_ONRAMP/US/USD/DOT_ASSETHUB');
  });

  it('reads a sell corridor at .../CRYPTO_OFFRAMP/{country}/{crypto}/{fiat} -- the swapped order', async () => {
    const get = stubGet();
    const d = new MeldDiscovery(get, ttls(3_600_000));
    await d.corridor('GB', 'GBP', 'BTC', 'sell');
    expect(get).toHaveBeenCalledWith('/network-partner/supported/routes/CRYPTO_OFFRAMP/GB/BTC/GBP');
  });

  it('never asks a sell corridor in the buy order: the two calls are distinct upstream URLs', async () => {
    const get = stubGet();
    const d = new MeldDiscovery(get, ttls(3_600_000));
    await d.corridor('GB', 'GBP', 'BTC', 'sell');
    await d.corridor('GB', 'BTC', 'GBP', 'buy');
    const calls = get.mock.calls.map(([p]) => p);
    expect(calls).toContain('/network-partner/supported/routes/CRYPTO_OFFRAMP/GB/BTC/GBP');
    expect(calls).toContain('/network-partner/supported/routes/CRYPTO_ONRAMP/GB/BTC/GBP');
    expect(new Set(calls).size).toBe(2);
  });

  it('caches a buy and a sell corridor for the same (country, fiat, crypto) separately', async () => {
    const get = vi.fn(async (path: string): Promise<unknown> =>
      path.includes('/CRYPTO_OFFRAMP/')
        ? [{ partner: 'TRANSAK', paymentMethods: [{ name: 'PAYOUT_TO_BANK', paymentType: 'BANK_TRANSFER', limits: { currencyCode: 'GBP', min: '1', max: '2' } }] }]
        : [{ partner: 'TRANSAK', paymentMethods: [{ name: 'CREDIT_DEBIT_CARD', paymentType: 'CARD', limits: { currencyCode: 'GBP', min: '1', max: '2' } }] }],
    );
    const d = new MeldDiscovery(get, ttls(3_600_000));
    const buy = await d.corridor('GB', 'GBP', 'BTC', 'buy');
    const sell = await d.corridor('GB', 'GBP', 'BTC', 'sell');
    expect(buy.methods.map((m) => m.paymentMethodType)).toEqual(['CREDIT_DEBIT_CARD']);
    expect(sell.methods.map((m) => m.paymentMethodType)).toEqual(['PAYOUT_TO_BANK']);
    // Re-reading each still hits no upstream: they are cached under distinct keys, not one
    // overwriting the other's slot.
    await d.corridor('GB', 'GBP', 'BTC', 'buy');
    await d.corridor('GB', 'GBP', 'BTC', 'sell');
    expect(get.mock.calls.length).toBe(2);
  });

  it('reads the region catalog under CRYPTO_OFFRAMP for sell, CRYPTO_ONRAMP for buy', async () => {
    const get = stubGet();
    const d = new MeldDiscovery(get, ttls(3_600_000));
    await d.countries('DOT_ASSETHUB', 'buy');
    await d.countries('DOT_ASSETHUB', 'sell');
    const calls = get.mock.calls.map(([p]) => p);
    expect(calls).toContain('/network-partner/supported/countries?category=CRYPTO_ONRAMP');
    expect(calls).toContain('/network-partner/supported/countries?category=CRYPTO_OFFRAMP');
  });

  it('caches the buy and sell country lists separately', async () => {
    const get = stubGet();
    const d = new MeldDiscovery(get, ttls(3_600_000));
    await d.countries('DOT_ASSETHUB', 'buy');
    await d.countries('DOT_ASSETHUB', 'buy');
    await d.countries('DOT_ASSETHUB', 'sell');
    await d.countries('DOT_ASSETHUB', 'sell');
    expect(get.mock.calls.filter(([p]) => p.includes('/supported/countries')).length).toBe(2);
  });
});

describe('MeldDiscovery.defaultFiat for sell: the fiat-limits substitute', () => {
  /**
   * `/network-partner/defaults/{country}/CRYPTO_OFFRAMP` answers `404` for every country the
   * probe tried, never `200` with an absent currency. A sell's `defaultFiat` must not call that
   * path at all; it reads `fiat-limits?category=CRYPTO_OFFRAMP` instead.
   */
  it('never calls the defaults endpoint for a sell', async () => {
    const get = vi.fn(async (path: string): Promise<unknown> => {
      if (path.includes('/defaults/')) throw new Error('a sell must not call the defaults endpoint');
      if (path.includes('/fiat-limits')) return { fiatLimits: [{ countryCode: 'GB', currencyCode: 'GBP' }] };
      return [];
    });
    const d = new MeldDiscovery(get, ttls(3_600_000));
    expect(await d.defaultFiat('GB', 'sell')).toBe('GBP');
  });

  it('reads a country\'s fiat from an unfiltered fiat-limits catalog, cached whole', async () => {
    const get = vi.fn(async (path: string): Promise<unknown> =>
      path.includes('/fiat-limits')
        ? {
            fiatLimits: [
              { countryCode: 'AD', currencyCode: 'EUR' },
              { countryCode: 'GB', currencyCode: 'GBP' },
              { countryCode: 'AU', currencyCode: 'AUD' },
            ],
          }
        : [],
    );
    const d = new MeldDiscovery(get, ttls(3_600_000));
    expect(await d.defaultFiat('GB', 'sell')).toBe('GBP');
    expect(await d.defaultFiat('AU', 'sell')).toBe('AUD');
    // A third distinct country, served from the one cached catalog: still one call.
    expect(await d.defaultFiat('AD', 'sell')).toBe('EUR');
    expect(get.mock.calls.filter(([p]) => p.includes('/fiat-limits')).length).toBe(1);
  });

  it('is empty for a country the catalog does not name', async () => {
    const d = new MeldDiscovery(async () => ({ fiatLimits: [{ countryCode: 'GB', currencyCode: 'GBP' }] }), ttls(3_600_000));
    expect(await d.defaultFiat('ZZ', 'sell')).toBe('');
  });

  it('keeps the first currency seen per country: one row per payment method collapses to one fiat', async () => {
    const d = new MeldDiscovery(
      async () => ({
        fiatLimits: [
          { countryCode: 'GB', currencyCode: 'GBP' },
          { countryCode: 'GB', currencyCode: 'GBP' },
        ],
      }),
      ttls(3_600_000),
    );
    expect(await d.defaultFiat('GB', 'sell')).toBe('GBP');
  });

  it('does not cache a failed call, so a transport blip cannot pin every off-ramp country to no-fiat', async () => {
    let calls = 0;
    const d = new MeldDiscovery(async () => {
      calls += 1;
      throw new Error('meld down');
    }, ttls(3_600_000));
    expect(await d.defaultFiat('GB', 'sell')).toBe('');
    expect(await d.defaultFiat('GB', 'sell')).toBe('');
    expect(calls).toBe(2);
  });

  it('does not cache an unparseable fiat-limits body', async () => {
    let calls = 0;
    const d = new MeldDiscovery(async () => {
      calls += 1;
      return 'not an envelope';
    }, ttls(3_600_000));
    expect(await d.defaultFiat('GB', 'sell')).toBe('');
    await d.defaultFiat('GB', 'sell');
    expect(calls).toBe(2);
  });

  it('re-reads once the cached catalog\'s lifetime has passed', async () => {
    let now = 0;
    let calls = 0;
    const d = new MeldDiscovery(
      async () => {
        calls += 1;
        return { fiatLimits: [{ countryCode: 'GB', currencyCode: 'GBP' }] };
      },
      ttls(1_000),
      () => now,
    );
    await d.defaultFiat('GB', 'sell');
    now += 1_001;
    await d.defaultFiat('GB', 'sell');
    expect(calls).toBe(2);
  });

  it('corridorForCountry resolves a sell corridor through the fiat-limits substitute', async () => {
    const get = vi.fn(async (path: string): Promise<unknown> => {
      if (path.includes('/fiat-limits')) return { fiatLimits: [{ countryCode: 'GB', currencyCode: 'GBP' }] };
      if (path.includes('/CRYPTO_OFFRAMP/GB/BTC/GBP')) return OFFRAMP_ROUTES['GB/BTC/GBP'];
      return [];
    });
    const d = new MeldDiscovery(get, ttls(3_600_000));
    const c = await d.corridorForCountry('GB', 'BTC', 'sell');
    expect(c.fiat).toBe('GBP');
    expect(c.methods.map((m) => m.paymentMethodType)).toEqual(['PAYOUT_TO_BANK']);
  });

  it('corridorForCountry is empty (no fiat) for a sell in a country fiat-limits does not name', async () => {
    const d = new MeldDiscovery(async () => ({ fiatLimits: [] }), ttls(3_600_000));
    expect(await d.corridorForCountry('ZZ', 'BTC', 'sell')).toEqual({
      country: 'ZZ',
      fiat: '',
      crypto: 'BTC',
      methods: [],
    });
  });
});

describe('MeldDiscovery.countries', () => {
  it('returns every on-ramp country, name-sorted and unfiltered', async () => {
    const d = new MeldDiscovery(stubGet(), ttls(3_600_000));
    const rows = await d.countries('DOT_ASSETHUB', 'buy');
    // The whole list, sorted by NAME; deliverability is decided per selection, not pre-filtered.
    // Canada, Errorland, India, Mexico, Nofiat, Routeless, United States.
    expect(rows.map((r) => r.country)).toEqual(['CA', 'XX', 'IN', 'MX', 'NF', 'YY', 'US']);
    expect(rows.find((r) => r.country === 'US')).toEqual({ country: 'US', name: 'United States' });
  });

  it('memoises the catalog per direction: a repeat call is served without a re-fetch', async () => {
    const get = stubGet();
    const d = new MeldDiscovery(get, ttls(3_600_000));
    const first = await d.countries('DOT_ASSETHUB', 'buy');
    expect(await d.countries('DOT_ASSETHUB', 'buy')).toBe(first);
    expect(get.mock.calls.filter(([p]) => p.includes('/supported/countries')).length).toBe(1);
  });

  // The split startup.ts wires: the dropdown reads the GLOBAL catalog while the corridor probe
  // stays on the keyed transport. Pinned because collapsing the two is silent: the list simply
  // narrows to the account's providers, and the countries it drops cannot be declined (there is no
  // row to select), so the buyer sees no explanation rather than a refusal.
  it('reads the catalog through catalogGet and the corridor through get', async () => {
    const get = stubGet();
    const catalogGet = stubGet();
    const d = new MeldDiscovery(get, ttls(3_600_000), undefined, catalogGet);

    await d.countries('DOT_ASSETHUB', 'buy');
    await d.corridor('US', 'USD', 'DOT_ASSETHUB', 'buy');

    const countryCalls = (g: typeof get) =>
      g.mock.calls.filter(([p]) => p.includes('/supported/countries')).length;
    const routeCalls = (g: typeof get) =>
      g.mock.calls.filter(([p]) => p.includes('/supported/routes/')).length;

    expect(countryCalls(catalogGet)).toBe(1);
    expect(countryCalls(get)).toBe(0);
    expect(routeCalls(get)).toBe(1);
    expect(routeCalls(catalogGet)).toBe(0);
  });

  it('falls back to the corridor transport when no catalogGet is given', async () => {
    const get = stubGet();
    const d = new MeldDiscovery(get, ttls(3_600_000));
    await d.countries('DOT_ASSETHUB', 'buy');
    expect(get.mock.calls.filter(([p]) => p.includes('/supported/countries')).length).toBe(1);
  });
});

describe('MeldDiscovery.corridorForCountry', () => {
  it('resolves the country default fiat, then reads that corridor', async () => {
    const d = new MeldDiscovery(stubGet(), ttls(3_600_000));
    const c = await d.corridorForCountry('CA', 'DOT_ASSETHUB', 'buy');
    expect(c.fiat).toBe('CAD');
    expect(c.methods.map((m) => m.paymentMethodType)).toEqual(['CREDIT_DEBIT_CARD']);
  });

  it('is empty when the country has a default fiat but no route for the crypto', async () => {
    const d = new MeldDiscovery(stubGet(), ttls(3_600_000));
    expect(await d.corridorForCountry('IN', 'DOT_ASSETHUB', 'buy')).toMatchObject({
      country: 'IN',
      fiat: 'INR',
      methods: [],
    });
  });

  it('is empty (no fiat) when the country carries no default currency', async () => {
    const d = new MeldDiscovery(stubGet(), ttls(3_600_000));
    expect(await d.corridorForCountry('NF', 'DOT_ASSETHUB', 'buy')).toEqual({
      country: 'NF',
      fiat: '',
      crypto: 'DOT_ASSETHUB',
      methods: [],
    });
  });

  it('is empty when the defaults probe itself fails', async () => {
    const d = new MeldDiscovery(stubGet(), ttls(3_600_000));
    expect((await d.corridorForCountry('XX', 'DOT_ASSETHUB', 'buy')).methods).toEqual([]);
  });
});

describe('MeldDiscovery defensive parsing', () => {
  it('reads an unparseable countries payload as an empty list', async () => {
    const d = new MeldDiscovery(async () => 'not an envelope', ttls(3_600_000));
    expect(await d.countries('DOT_ASSETHUB', 'buy')).toEqual([]);
  });

  it('falls back to the country code when a row carries no name', async () => {
    const d = new MeldDiscovery(async () => ({ countries: [{ countryCode: 'ZZ' }] }), ttls(3_600_000));
    expect(await d.countries('DOT_ASSETHUB', 'buy')).toEqual([{ country: 'ZZ', name: 'ZZ' }]);
  });

  it('treats an explicit null default currency as no fiat', async () => {
    const d = new MeldDiscovery(
      async (p) => (p.includes('/defaults/') ? { countryCode: 'ZZ', currencyCode: null } : []),
      ttls(3_600_000),
    );
    expect(await d.corridorForCountry('ZZ', 'DOT_ASSETHUB', 'buy')).toMatchObject({ fiat: '', methods: [] });
  });
});

describe('MeldDiscovery.defaultFiat', () => {
  /** Count the `/defaults/` calls, so a cache hit is visible as a call that did not happen. */
  const counting = (body: unknown) => {
    let calls = 0;
    const get = async (path: string) => {
      if (path.includes('/defaults/')) calls += 1;
      return body;
    };
    return { get, calls: () => calls };
  };

  it('serves a repeat from cache, which is the Meld call this endpoint exists to stop making', async () => {
    const meld = counting({ countryCode: 'CA', currencyCode: 'CAD' });
    const d = new MeldDiscovery(meld.get, ttls(3_600_000));

    expect(await d.defaultFiat('CA', 'buy')).toBe('CAD');
    expect(await d.defaultFiat('CA', 'buy')).toBe('CAD');
    expect(meld.calls()).toBe(1);
  });

  it('re-reads once the lifetime has passed', async () => {
    let now = 1_000;
    const meld = counting({ countryCode: 'CA', currencyCode: 'CAD' });
    const d = new MeldDiscovery(meld.get, ttls(1_000), () => now);

    await d.defaultFiat('CA', 'buy');
    now += 1_001;
    await d.defaultFiat('CA', 'buy');
    expect(meld.calls()).toBe(2);
  });

  it('throws on a failed call and does not cache it, so one bad response cannot pin a country to no-fiat', async () => {
    let calls = 0;
    const d = new MeldDiscovery(async () => {
      calls += 1;
      throw new Error('meld down');
    }, ttls(3_600_000));

    // Throws, rather than returning '', so a caller can tell a failure apart from a real "no currency".
    await expect(d.defaultFiat('CA', 'buy')).rejects.toThrow('meld down');
    await expect(d.defaultFiat('CA', 'buy')).rejects.toThrow('meld down');
    expect(calls).toBe(2); // the failure is not cached; each call retries
  });

  it('throws on an unparseable response rather than reading it as no-fiat', async () => {
    const d = new MeldDiscovery(async () => 'not an envelope', ttls(3_600_000));
    await expect(d.defaultFiat('CA', 'buy')).rejects.toThrow(/unparseable/);
  });

  it('caches a parsed envelope that names no currency, which is a real answer', async () => {
    const meld = counting({ countryCode: 'NF' });
    const d = new MeldDiscovery(meld.get, ttls(3_600_000));

    expect(await d.defaultFiat('NF', 'buy')).toBe('');
    expect(await d.defaultFiat('NF', 'buy')).toBe('');
    expect(meld.calls()).toBe(1);
  });
});

describe('MeldDiscovery currency and cache hygiene', () => {
  /**
   * A bound denominated in another currency is not a bound for this corridor.
   *
   * `limits.currencyCode` was adopted as-is, so a corridor asked for in GBP whose limits came back
   * in USD produced a `MethodLimit` carrying USD numbers under a GBP corridor. `limitFor` then
   * compares those against a GBP `sourceAmount` in minor units, where the mismatch is invisible.
   */
  it('drops a method whose limits are in a different currency from the corridor', async () => {
    const get = async (path: string): Promise<unknown> =>
      path.includes('/routes/')
        ? [
            {
              partner: 'TRANSAK',
              paymentMethods: [
                { name: 'CREDIT_DEBIT_CARD', paymentType: 'CARD', limits: { currencyCode: 'USD', min: '5', max: '3000' } },
                { name: 'SEPA', paymentType: 'BANK_TRANSFER', limits: { currencyCode: 'GBP', min: '20', max: '900' } },
              ],
            },
          ]
        : [];
    const d = new MeldDiscovery(get, ttls(3_600_000));
    const { methods } = await d.corridor('GB', 'GBP', 'DOT_ASSETHUB', 'buy');

    expect(methods.map((m) => m.paymentMethodType)).toEqual(['SEPA']);
    expect(methods[0]?.currency).toBe('GBP');
  });

  it('matches the currency case-insensitively, since the comparison is on Meld\'s spelling', async () => {
    const get = async (path: string): Promise<unknown> =>
      path.includes('/routes/')
        ? [
            {
              partner: 'TRANSAK',
              paymentMethods: [
                { name: 'CREDIT_DEBIT_CARD', paymentType: 'CARD', limits: { currencyCode: 'gbp', min: '20', max: '900' } },
              ],
            },
          ]
        : [];
    const d = new MeldDiscovery(get, ttls(3_600_000));
    expect((await d.corridor('GB', 'GBP', 'DOT_ASSETHUB', 'buy')).methods).toHaveLength(1);
  });

  it('keeps a method whose limits name no currency, taking the corridor\'s own fiat', async () => {
    // `?? fiat` still applies: an absent currencyCode is not a mismatch; it is unstated.
    const get = async (path: string): Promise<unknown> =>
      path.includes('/routes/')
        ? [{ partner: 'TRANSAK', paymentMethods: [{ name: 'PIX', paymentType: 'BANK_TRANSFER', limits: { min: '1', max: '9' } }] }]
        : [];
    const d = new MeldDiscovery(get, ttls(3_600_000));
    const { methods } = await d.corridor('BR', 'BRL', 'DOT_ASSETHUB', 'buy');
    expect(methods).toHaveLength(1);
    expect(methods[0]?.currency).toBe('BRL');
  });

  /**
   * The cache held every corridor ever probed, for the life of the process.
   *
   * `fresh` decides what is served, not what is kept, so a stale entry was only replaced if
   * that exact corridor was asked for again, and the key is (country, fiat, crypto), unbounded in
   * the first two. A caller walking countries minted a permanent entry per probe.
   */
  it('evicts expired entries instead of holding every corridor ever probed', async () => {
    let now = 0;
    const d = new MeldDiscovery(stubGet(), ttls(1_000), () => now);

    await d.corridor('US', 'USD', 'DOT_ASSETHUB', 'buy');
    await d.corridor('CA', 'CAD', 'DOT_ASSETHUB', 'buy');
    expect(sizeOfCorridorCache(d)).toBe(2);

    // Past the TTL, the next write sweeps the two stale entries and leaves only its own.
    now = 5_000;
    await d.corridor('MX', 'MXN', 'DOT_ASSETHUB', 'buy');
    expect(sizeOfCorridorCache(d)).toBe(1);
  });

  it('keeps entries that are still fresh when a new one is written', async () => {
    let now = 0;
    const d = new MeldDiscovery(stubGet(), ttls(1_000_000), () => now);

    await d.corridor('US', 'USD', 'DOT_ASSETHUB', 'buy');
    now = 10;
    await d.corridor('CA', 'CAD', 'DOT_ASSETHUB', 'buy');
    expect(sizeOfCorridorCache(d)).toBe(2);
  });
});

/** The cache is private; a test may read its size without the class exposing one. */
function sizeOfCorridorCache(d: MeldDiscovery): number {
  return (d as unknown as { corridorCache: Map<string, unknown> }).corridorCache.size;
}

describe('MeldDiscovery does not cache an answer it cannot trust', () => {
  /**
   * A parse miss is closer to a transport miss than to "not offered".
   *
   * `z.array(routeEntry).safeParse` failed as a whole, so one element missing `partner` zeroed the
   * corridor, and the zero is indistinguishable from Meld's genuine `[]`. The gate read it as
   * `CURRENCY_UNSUPPORTED` and the cache held that refusal for the full TTL, so a single malformed
   * element took a live corridor down for an hour.
   */
  it('keeps the entries that parse when one element is malformed', async () => {
    const get = async (path: string): Promise<unknown> =>
      path.includes('/routes/')
        ? [
            { /* no `partner`: unparseable */ paymentMethods: [{ name: 'SEPA', limits: { min: '1', max: '2' } }] },
            { partner: 'TRANSAK', paymentMethods: [{ name: 'CREDIT_DEBIT_CARD', paymentType: 'CARD', limits: { min: '5', max: '3000' } }] },
          ]
        : [];
    const d = new MeldDiscovery(get, ttls(3_600_000));
    const { methods } = await d.corridor('US', 'USD', 'DOT_ASSETHUB', 'buy');

    expect(methods.map((m) => m.paymentMethodType)).toEqual(['CREDIT_DEBIT_CARD']);
  });

  it('does not cache a corridor assembled from a partly unparseable body', async () => {
    let calls = 0;
    const get = async (path: string): Promise<unknown> => {
      if (!path.includes('/routes/')) return [];
      calls += 1;
      return [{ paymentMethods: [] }, { partner: 'TRANSAK', paymentMethods: [] }];
    };
    const d = new MeldDiscovery(get, ttls(3_600_000));

    await d.corridor('US', 'USD', 'DOT_ASSETHUB', 'buy');
    await d.corridor('US', 'USD', 'DOT_ASSETHUB', 'buy');
    // Re-probed rather than served from cache: the first answer was incomplete.
    expect(calls).toBe(2);
  });

  it('does not cache a corridor whose body is not an array at all', async () => {
    let calls = 0;
    const get = async (path: string): Promise<unknown> => {
      if (!path.includes('/routes/')) return [];
      calls += 1;
      return { unexpected: 'shape' };
    };
    const d = new MeldDiscovery(get, ttls(3_600_000));

    expect((await d.corridor('US', 'USD', 'DOT_ASSETHUB', 'buy')).methods).toEqual([]);
    await d.corridor('US', 'USD', 'DOT_ASSETHUB', 'buy');
    expect(calls).toBe(2);
  });

  it('still caches a genuinely empty corridor, which is a real answer', async () => {
    let calls = 0;
    const get = async (path: string): Promise<unknown> => {
      if (!path.includes('/routes/')) return [];
      calls += 1;
      return [];
    };
    const d = new MeldDiscovery(get, ttls(3_600_000));

    await d.corridor('ZZ', 'USD', 'DOT_ASSETHUB', 'buy');
    await d.corridor('ZZ', 'USD', 'DOT_ASSETHUB', 'buy');
    // "Not offered" is worth memoising: it is what keeps a country walk from re-probing.
    expect(calls).toBe(1);
  });

  it('does not cache an unparseable countries payload', async () => {
    let calls = 0;
    const d = new MeldDiscovery(async () => {
      calls += 1;
      return 'not an envelope';
    }, ttls(3_600_000));

    expect(await d.countries('DOT_ASSETHUB', 'buy')).toEqual([]);
    await d.countries('DOT_ASSETHUB', 'buy');
    expect(calls).toBe(2);
  });

  it('caches an envelope that parsed to no countries', async () => {
    let calls = 0;
    const d = new MeldDiscovery(async () => {
      calls += 1;
      return { countries: [] };
    }, ttls(3_600_000));

    await d.countries('DOT_ASSETHUB', 'buy');
    await d.countries('DOT_ASSETHUB', 'buy');
    expect(calls).toBe(1);
  });
});

describe('toCorridorDto', () => {
  it('drops the provider roster and keeps every other field', () => {
    const dto = toCorridorDto({
      country: 'US',
      fiat: 'USD',
      crypto: 'DOT_ASSETHUB',
      methods: [
        { paymentMethodType: 'CREDIT_DEBIT_CARD', category: 'card', min: '5', max: '3000', currency: 'USD', providers: ['TRANSAK', 'GUARDARIAN'] },
      ],
    });

    expect(dto).toEqual({
      country: 'US',
      fiat: 'USD',
      crypto: 'DOT_ASSETHUB',
      methods: [{ paymentMethodType: 'CREDIT_DEBIT_CARD', category: 'card', min: '5', max: '3000', currency: 'USD' }],
    });
    expect(dto.methods[0]).not.toHaveProperty('providers');
  });
});
