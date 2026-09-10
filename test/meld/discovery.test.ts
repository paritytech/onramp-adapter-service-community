import { describe, expect, it, vi } from 'vitest';

import { MeldDiscovery, toCorridorDto } from '../../src/meld/discovery.js';

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
// routes keyed `${country}/${fiat}/${crypto}`.
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

/** A stub of `MeldClient.authedGet`, plus the spy so a test can count upstream calls. */
function stubGet() {
  return vi.fn(async (path: string): Promise<unknown> => {
    if (path.startsWith('/network-partner/supported/countries')) return COUNTRIES;
    const def = /^\/network-partner\/defaults\/([A-Z]{2})\//.exec(path);
    if (def) {
      if (def[1] === 'XX') throw new Error('defaults upstream down');
      return DEFAULTS[def[1] as string];
    }
    const route = /^\/network-partner\/supported\/routes\/CRYPTO_ONRAMP\/(.+)$/.exec(path);
    if (route) {
      if ((route[1] as string).startsWith('YY/')) throw new Error('routes upstream down');
      return ROUTES[route[1] as string] ?? [];
    }
    throw new Error(`unexpected path ${path}`);
  });
}

describe('MeldDiscovery.corridor', () => {
  it('aggregates a corridor across providers: min-of-mins, max-of-maxes, provider union', async () => {
    const d = new MeldDiscovery(stubGet(), 3_600_000);
    const { methods } = await d.corridor('US', 'USD', 'DOT_ASSETHUB');

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
    const d = new MeldDiscovery(stubGet(), 3_600_000);
    expect((await d.corridor('IN', 'INR', 'DOT_ASSETHUB')).methods).toEqual([]);
  });

  it('maps every payment-type bucket: card, wallet, and an unknown type as other', async () => {
    const d = new MeldDiscovery(stubGet(), 3_600_000);
    const { methods } = await d.corridor('MX', 'MXN', 'DOT_ASSETHUB');
    const cat = (id: string) => methods.find((m) => m.paymentMethodType === id)?.category;
    expect(cat('CREDIT_DEBIT_CARD')).toBe('card');
    expect(cat('APPLE_PAY')).toBe('wallet'); // MOBILE_WALLET
    expect(cat('SPEI')).toBe('other'); // unrecognised paymentType
  });

  it('caches a corridor for its TTL: a second identical call hits no upstream', async () => {
    const get = stubGet();
    const d = new MeldDiscovery(get, 3_600_000);
    await d.corridor('CA', 'CAD', 'DOT_ASSETHUB');
    await d.corridor('CA', 'CAD', 'DOT_ASSETHUB');
    expect(get.mock.calls.filter(([p]) => p.includes('/routes/')).length).toBe(1);
  });
});

describe('MeldDiscovery.countries', () => {
  it('returns every on-ramp country, name-sorted and unfiltered', async () => {
    const d = new MeldDiscovery(stubGet(), 3_600_000);
    const rows = await d.countries('DOT_ASSETHUB');
    // The whole list, sorted by NAME; deliverability is decided per selection, not pre-filtered.
    // Canada, Errorland, India, Mexico, Nofiat, Routeless, United States.
    expect(rows.map((r) => r.country)).toEqual(['CA', 'XX', 'IN', 'MX', 'NF', 'YY', 'US']);
    expect(rows.find((r) => r.country === 'US')).toEqual({ country: 'US', name: 'United States' });
  });

  it('memoises the catalog per crypto: a repeat call is served without a re-fetch', async () => {
    const get = stubGet();
    const d = new MeldDiscovery(get, 3_600_000);
    const first = await d.countries('DOT_ASSETHUB');
    expect(await d.countries('DOT_ASSETHUB')).toBe(first);
    expect(get.mock.calls.filter(([p]) => p.includes('/supported/countries')).length).toBe(1);
  });

  // The split startup.ts wires: the dropdown reads the GLOBAL catalog while the corridor probe
  // stays on the keyed transport. Pinned because collapsing the two is silent: the list simply
  // narrows to the account's providers, and the countries it drops cannot be declined (there is no
  // row to select), so the buyer sees no explanation rather than a refusal.
  it('reads the catalog through catalogGet and the corridor through get', async () => {
    const get = stubGet();
    const catalogGet = stubGet();
    const d = new MeldDiscovery(get, 3_600_000, undefined, catalogGet);

    await d.countries('DOT_ASSETHUB');
    await d.corridor('US', 'USD', 'DOT_ASSETHUB');

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
    const d = new MeldDiscovery(get, 3_600_000);
    await d.countries('DOT_ASSETHUB');
    expect(get.mock.calls.filter(([p]) => p.includes('/supported/countries')).length).toBe(1);
  });
});

describe('MeldDiscovery.corridorForCountry', () => {
  it('resolves the country default fiat, then reads that corridor', async () => {
    const d = new MeldDiscovery(stubGet(), 3_600_000);
    const c = await d.corridorForCountry('CA', 'DOT_ASSETHUB');
    expect(c.fiat).toBe('CAD');
    expect(c.methods.map((m) => m.paymentMethodType)).toEqual(['CREDIT_DEBIT_CARD']);
  });

  it('is empty when the country has a default fiat but no route for the crypto', async () => {
    const d = new MeldDiscovery(stubGet(), 3_600_000);
    expect(await d.corridorForCountry('IN', 'DOT_ASSETHUB')).toMatchObject({
      country: 'IN',
      fiat: 'INR',
      methods: [],
    });
  });

  it('is empty (no fiat) when the country carries no default currency', async () => {
    const d = new MeldDiscovery(stubGet(), 3_600_000);
    expect(await d.corridorForCountry('NF', 'DOT_ASSETHUB')).toEqual({
      country: 'NF',
      fiat: '',
      crypto: 'DOT_ASSETHUB',
      methods: [],
    });
  });

  it('is empty when the defaults probe itself fails', async () => {
    const d = new MeldDiscovery(stubGet(), 3_600_000);
    expect((await d.corridorForCountry('XX', 'DOT_ASSETHUB')).methods).toEqual([]);
  });
});

describe('MeldDiscovery defensive parsing', () => {
  it('reads an unparseable countries payload as an empty list', async () => {
    const d = new MeldDiscovery(async () => 'not an envelope', 3_600_000);
    expect(await d.countries('DOT_ASSETHUB')).toEqual([]);
  });

  it('falls back to the country code when a row carries no name', async () => {
    const d = new MeldDiscovery(async () => ({ countries: [{ countryCode: 'ZZ' }] }), 3_600_000);
    expect(await d.countries('DOT_ASSETHUB')).toEqual([{ country: 'ZZ', name: 'ZZ' }]);
  });

  it('treats an explicit null default currency as no fiat', async () => {
    const d = new MeldDiscovery(
      async (p) => (p.includes('/defaults/') ? { countryCode: 'ZZ', currencyCode: null } : []),
      3_600_000,
    );
    expect(await d.corridorForCountry('ZZ', 'DOT_ASSETHUB')).toMatchObject({ fiat: '', methods: [] });
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
    const d = new MeldDiscovery(get, 3_600_000);
    const { methods } = await d.corridor('GB', 'GBP', 'DOT_ASSETHUB');

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
    const d = new MeldDiscovery(get, 3_600_000);
    expect((await d.corridor('GB', 'GBP', 'DOT_ASSETHUB')).methods).toHaveLength(1);
  });

  it('keeps a method whose limits name no currency, taking the corridor\'s own fiat', async () => {
    // `?? fiat` still applies: an absent currencyCode is not a mismatch; it is unstated.
    const get = async (path: string): Promise<unknown> =>
      path.includes('/routes/')
        ? [{ partner: 'TRANSAK', paymentMethods: [{ name: 'PIX', paymentType: 'BANK_TRANSFER', limits: { min: '1', max: '9' } }] }]
        : [];
    const d = new MeldDiscovery(get, 3_600_000);
    const { methods } = await d.corridor('BR', 'BRL', 'DOT_ASSETHUB');
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
    const d = new MeldDiscovery(stubGet(), 1_000, () => now);

    await d.corridor('US', 'USD', 'DOT_ASSETHUB');
    await d.corridor('CA', 'CAD', 'DOT_ASSETHUB');
    expect(sizeOfCorridorCache(d)).toBe(2);

    // Past the TTL, the next write sweeps the two stale entries and leaves only its own.
    now = 5_000;
    await d.corridor('MX', 'MXN', 'DOT_ASSETHUB');
    expect(sizeOfCorridorCache(d)).toBe(1);
  });

  it('keeps entries that are still fresh when a new one is written', async () => {
    let now = 0;
    const d = new MeldDiscovery(stubGet(), 1_000_000, () => now);

    await d.corridor('US', 'USD', 'DOT_ASSETHUB');
    now = 10;
    await d.corridor('CA', 'CAD', 'DOT_ASSETHUB');
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
    const d = new MeldDiscovery(get, 3_600_000);
    const { methods } = await d.corridor('US', 'USD', 'DOT_ASSETHUB');

    expect(methods.map((m) => m.paymentMethodType)).toEqual(['CREDIT_DEBIT_CARD']);
  });

  it('does not cache a corridor assembled from a partly unparseable body', async () => {
    let calls = 0;
    const get = async (path: string): Promise<unknown> => {
      if (!path.includes('/routes/')) return [];
      calls += 1;
      return [{ paymentMethods: [] }, { partner: 'TRANSAK', paymentMethods: [] }];
    };
    const d = new MeldDiscovery(get, 3_600_000);

    await d.corridor('US', 'USD', 'DOT_ASSETHUB');
    await d.corridor('US', 'USD', 'DOT_ASSETHUB');
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
    const d = new MeldDiscovery(get, 3_600_000);

    expect((await d.corridor('US', 'USD', 'DOT_ASSETHUB')).methods).toEqual([]);
    await d.corridor('US', 'USD', 'DOT_ASSETHUB');
    expect(calls).toBe(2);
  });

  it('still caches a genuinely empty corridor, which is a real answer', async () => {
    let calls = 0;
    const get = async (path: string): Promise<unknown> => {
      if (!path.includes('/routes/')) return [];
      calls += 1;
      return [];
    };
    const d = new MeldDiscovery(get, 3_600_000);

    await d.corridor('ZZ', 'USD', 'DOT_ASSETHUB');
    await d.corridor('ZZ', 'USD', 'DOT_ASSETHUB');
    // "Not offered" is worth memoising: it is what keeps a country walk from re-probing.
    expect(calls).toBe(1);
  });

  it('does not cache an unparseable countries payload', async () => {
    let calls = 0;
    const d = new MeldDiscovery(async () => {
      calls += 1;
      return 'not an envelope';
    }, 3_600_000);

    expect(await d.countries('DOT_ASSETHUB')).toEqual([]);
    await d.countries('DOT_ASSETHUB');
    expect(calls).toBe(2);
  });

  it('caches an envelope that parsed to no countries', async () => {
    let calls = 0;
    const d = new MeldDiscovery(async () => {
      calls += 1;
      return { countries: [] };
    }, 3_600_000);

    await d.countries('DOT_ASSETHUB');
    await d.countries('DOT_ASSETHUB');
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
