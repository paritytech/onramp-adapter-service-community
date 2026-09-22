/**
 * Live capability discovery: which (country, fiat, payment-method) corridors this account can
 * actually deliver a given crypto to (buy), or take it from (sell), and at what min/max.
 *
 * Asked live rather than maintained by hand in `config.limits`: a hand-kept list refuses
 * corridors the upstream serves, and a buyer meets `CURRENCY_UNSUPPORTED` for one that is live.
 *
 * Reads through `MeldClient.authedGet`, so the calls carry the API key without this module reading
 * the secret; the key keeps its single reader. The key matters. `/network-partner/supported/*`
 * answers without one, but a keyed call scopes the result to this account's enabled providers
 * (verified live: a sandbox account returns only its onboarded provider set, e.g. one provider;
 * an unkeyed call returns the global set). That is exactly the set `POST /quote` will price, so the
 * catalog never advertises a corridor the quote would then refuse. The provider is Meld's to
 * choose at quote time; nothing here names one.
 *
 * Ground truth is the routes endpoint, which is crypto-scoped (verified):
 *   GET /network-partner/supported/routes/{category}/{country}/{SOURCE}/{DESTINATION}
 * returns one element per provider that delivers that crypto to that corridor, each carrying its
 * payment methods and per-method fiat `limits {min,max}`. An empty `[]` means "not offered". The
 * `fiat-limits` endpoint is deliberately not used for the corridor bound itself: it carries no
 * crypto column, so it cannot tell DOT from BTC and would advertise corridors that never route
 * DOT. (It is used for exactly one narrower thing on a sell -- see `defaultFiat` below.)
 *
 * **The category and the path's argument order both move with direction, and neither moves alone**
 * (verified live against `api-sb.meld.io`; see the probe note this module was built from). A buy
 * reads `CRYPTO_ONRAMP` with the fiat first and the crypto second, because the fiat is the
 * *source* and the crypto is the *destination*. A sell reads `CRYPTO_OFFRAMP` with the crypto
 * first and the fiat second, because the legs invert: the crypto is what the seller sources. Both
 * facts live in the one function that builds the path (`routesPath`), taking `direction` as its
 * only branch, so a caller cannot reuse the on-ramp order under the off-ramp category by handing
 * the two arguments in their buy positions -- there is no seam at which that swap could be made
 * partially. Getting this wrong is the single most dangerous failure mode in this module: Meld
 * answers `200 []` for the swapped order on every off-ramp corridor tried, which is
 * byte-for-byte the same answer as "this account does not serve that corridor". `discovery.test.ts`
 * pins the exact URL string for both directions against the probe's own examples, so a
 * regression here fails a test rather than only degrading silently to "no corridor".
 *
 * Amounts (`min`/`max`) arrive as the exact text Meld sent; `authedGet` preserves every number
 * verbatim, because `JSON.parse` turns `2000.00` into `2000`, and these numbers feed `toMinorUnits`
 * at the charge gate.
 */

import { z } from 'zod';

import type { Direction } from '../rail.js';

/** The category each direction reads under. Off-ramp is `CRYPTO_OFFRAMP`, verified live. */
const CATEGORY: Record<Direction, string> = { buy: 'CRYPTO_ONRAMP', sell: 'CRYPTO_OFFRAMP' };

/**
 * The routes path, with the source/destination positions decided by `direction` and nowhere else.
 *
 * On a buy the fiat is the source and the crypto is the destination; on a sell the crypto is the
 * source and the fiat is the destination. This function's only job is to make that swap the one
 * and only place the order is decided, so a caller supplies `(country, fiat, crypto)` -- the
 * corridor's own vocabulary, unchanged by direction -- and never assembles the path by hand.
 * See the module header for why the swap matters and how it is verified.
 */
function routesPath(direction: Direction, country: string, fiat: string, crypto: string): string {
  const [source, destination] = direction === 'sell' ? [crypto, fiat] : [fiat, crypto];
  return (
    `/network-partner/supported/routes/${CATEGORY[direction]}/${encodeURIComponent(country)}` +
    `/${encodeURIComponent(source)}/${encodeURIComponent(destination)}`
  );
}

// --- upstream shapes (loose: unknown fields carried, never depended on) -------

const routeLimits = z
  .object({
    currencyCode: z.string().nullish(),
    /** Exact decimal text (`authedGet` preserves Meld's JSON numbers verbatim). */
    min: z.string().nullish(),
    max: z.string().nullish(),
  })
  .loose();

const routeMethod = z
  .object({
    /** Canonical, downstream-ready method id, e.g. `CREDIT_DEBIT_CARD`, `SEPA`, `PIX`. */
    name: z.string(),
    /** Broad bucket: `CARD` | `BANK_TRANSFER` | `MOBILE_WALLET` | `EXCHANGE` | ... */
    paymentType: z.string().nullish(),
    limits: routeLimits.nullish(),
  })
  .loose();

const routeEntry = z
  .object({
    partner: z.string(),
    paymentMethods: z.array(routeMethod).nullish(),
  })
  .loose();

const countryRow = z.object({ countryCode: z.string(), name: z.string().nullish() }).loose();
const countriesEnvelope = z.object({ countries: z.array(countryRow).nullish() }).loose();

const defaultsEnvelope = z
  .object({ countryCode: z.string().nullish(), currencyCode: z.string().nullish() })
  .loose();

/**
 * One row of `/network-partner/supported/fiat-limits`, used only for its (country, currency)
 * pairing. See `offrampDefaultFiat` for why this endpoint stands in for a defaults endpoint that
 * does not exist for sell.
 */
const fiatLimitRow = z.object({ countryCode: z.string().nullish(), currencyCode: z.string().nullish() }).loose();
const fiatLimitsEnvelope = z.object({ fiatLimits: z.array(fiatLimitRow).nullish() }).loose();

// --- normalised output --------------------------------------------------------

/** The category a UI groups a method under: `card` or `bank`. */
export type MethodCategory = 'card' | 'bank' | 'wallet' | 'other';

/** One payment method available for a corridor, with the bound a buyer must satisfy. */
export interface MethodLimit {
  /** Canonical Meld method id sent back on `POST /session` as `paymentMethodType`. */
  paymentMethodType: string;
  category: MethodCategory;
  /** Exact decimal text, in `currency` units. */
  min: string;
  max: string;
  currency: string;
  /** The account's providers that offer this method for the corridor (union across providers). */
  providers: string[];
}

/** A (country, fiat) corridor for one crypto. `methods` empty means the corridor is not served. */
export interface Corridor {
  country: string;
  fiat: string;
  crypto: string;
  methods: MethodLimit[];
}

/**
 * A corridor as a client sees it: every field of `Corridor` except the provider roster.
 *
 * `providers` is aggregation bookkeeping: which of the account's partners offered each method, so
 * `min`/`max` can be unioned across them. It was going out on `/supported` because the route sent
 * the internal object, and nothing on the client reads it. This service is careful never to name a
 * provider in code or at quote time (Meld chooses at quote time; nothing here pins one), so
 * serialising the roster contradicted that for no consumer's benefit.
 *
 * Projected explicitly at the boundary rather than by dropping the field from `MethodLimit`,
 * because the aggregation genuinely needs it (the same split `transaction` already makes between
 * a forgiving parse and a declared wire shape).
 */
export interface CorridorDto {
  country: string;
  fiat: string;
  crypto: string;
  methods: Omit<MethodLimit, 'providers'>[];
}

/** Drop the provider roster on the way out. */
export const toCorridorDto = (c: Corridor): CorridorDto => ({
  country: c.country,
  fiat: c.fiat,
  crypto: c.crypto,
  methods: c.methods.map(({ providers: _providers, ...rest }) => rest),
});

/** One row of the region dropdown: every Meld on-ramp country. Whether a country can actually be
 *  delivered to (and via card or bank) is answered per selection by `corridorForCountry`, not
 *  pre-filtered here, so the list stays a cheap single call and the buyer sees every option. */
export interface CountryRow {
  country: string;
  name: string;
}

function categoryOf(paymentType: string | null | undefined): MethodCategory {
  switch ((paymentType ?? '').toUpperCase()) {
    case 'CARD':
      return 'card';
    case 'BANK_TRANSFER':
      return 'bank';
    case 'MOBILE_WALLET':
      return 'wallet';
    default:
      return 'other';
  }
}

/** Numeric view of an exact-decimal string, for choosing the widest bound only. */
function num(s: string | null | undefined): number {
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

interface CacheEntry<T> {
  at: number;
  value: T;
}

/** An authenticated GET that preserves Meld's exact numbers: `MeldClient.authedGet`. */
export type AuthedGet = (path: string) => Promise<unknown>;

/**
 * The capability surface the onramp depends on. An interface (not the class) so the onramp
 * inverts the dependency and a test can substitute a plain double.
 *
 * Every method takes `direction` explicitly, and not as a trailing optional: there is no default
 * direction here the way there is on the wire (`buy` there means "the caller wrote nothing new"),
 * and a parameter a caller can omit is a parameter a caller can forget, which is exactly how the
 * routes path argument order got reused unswapped in the first version of this module's sell
 * support. See the module header.
 */
export interface Discovery {
  corridor(country: string, fiat: string, crypto: string, direction: Direction): Promise<Corridor>;
  corridorForCountry(country: string, crypto: string, direction: Direction): Promise<Corridor>;
  countries(crypto: string, direction: Direction): Promise<CountryRow[]>;
  /** A country's default fiat, `''` when Meld names none, throwing when the call itself failed.
   *  Split out so a caller that knows the fiat never pays for the lookup, and so each half caches on
   *  its own lifetime. */
  defaultFiat(country: string, direction: Direction): Promise<string>;
}

/** One cache lifetime per endpoint, on the scale Meld's caching guide says each one moves. */
export interface DiscoveryTtls {
  /** `supported/countries`. Up to a week. */
  countries: number;
  /** `defaults/{country}/{category}`. Up to a week. */
  defaults: number;
  /** `supported/routes`. Minutes to hours; this one gates a charge. */
  routes: number;
}

/**
 * Discovery client with a per-corridor and per-catalog cache.
 *
 * Cheap by construction: the charge gate asks for one corridor at a time (`corridor`), each
 * cached for `ttls.routes`, so once the first probe for a country resolves the rest are served from
 * memory (concurrent probes before that first resolves are not de-duped). The country dropdown
 * (`countries`) is a single upstream call, memoised whole, keyed by crypto.
 *
 * Two transports, on purpose. The country list and the corridor answer a different question,
 * so they are scoped differently:
 *
 *   `countries`  -> `catalogGet`, the global (unkeyed) view. The dropdown should name every country
 *                  Meld on-ramps, because a buyer whose country is missing has no way to learn
 *                  why: the row simply is not there, and the "not supported here, buy with
 *                  crypto instead" answer they need is unreachable. Keyed, this list is scoped to
 *                  the account's onboarded providers. A one-provider sandbox showed 26 of Meld's
 *                  251 on-ramp countries, so India was absent rather than declined.
 *   `corridor`   -> `get`, scoped per `discovery_scope` (keyed by default). This one gates a
 *                  charge, so it must describe what `POST /quote` will actually price. Widening it
 *                  to the global set would advertise corridors this account cannot buy, moving the
 *                  failure from selection (a sentence the buyer can act on) to payment.
 *
 * So the list is deliberately wider than the deliverable set, and every row it adds is a row that
 * resolves to `methods: []` and an explicit refusal. That asymmetry is the design, not a leak.
 */
export class MeldDiscovery implements Discovery {
  // Keyed by direction first: a buy and a sell corridor for the same (country, fiat, crypto) are
  // two different questions to Meld (different category, different path order) and must never
  // share a slot.
  private readonly corridorCache = new Map<string, CacheEntry<Corridor>>();
  // Keyed by direction only; crypto and country both stay outside the key. Crypto is
  // crypto-independent as it always was (see the old comment this replaces); country is not asked
  // here at all -- this is the *list* of countries, not a per-country lookup.
  private readonly countriesCache = new Map<Direction, CacheEntry<CountryRow[]>>();
  // Buy's defaults cache: per-country, exactly as before this module served a sell at all.
  private readonly defaultsCache = new Map<string, CacheEntry<string>>();
  // Sell's substitute for the endpoint that does not exist (`defaultFiat`'s "OFFRAMP_FIAT_LIMITS
  // catalog" below): the whole (country -> currency) map from one call, cached whole like
  // `countriesCache`, because the source data itself is one call answering for every country.
  private offrampFiatCatalog: CacheEntry<Map<string, string>> | undefined;

  constructor(
    /** Corridor GET, scoped per `discovery_scope`: keyed (this account's providers) by default. */
    private readonly get: AuthedGet,
    private readonly ttls: DiscoveryTtls,
    private readonly clock: () => number = Date.now,
    /**
     * Country-catalog GET. Defaults to `get` so a caller that has only one transport (every test
     * double, and any embedder that does not distinguish the two) keeps the previous behaviour;
     * `startup.ts` passes the unkeyed `publicGet` so the dropdown is the global list.
     */
    private readonly catalogGet: AuthedGet = get,
  ) {}

  private fresh<T>(entry: CacheEntry<T> | undefined, ttlMs: number): T | undefined {
    if (entry === undefined) return undefined;
    return this.clock() - entry.at <= ttlMs ? entry.value : undefined;
  }

  /**
   * Drop entries past their TTL, before writing a new one.
   *
   * `fresh` decides whether an entry is served, not whether it is kept. So a stale entry sat
   * in the map until something asked for that exact corridor again, and a corridor asked for once
   * was never asked for again. The key is (country, fiat, crypto), which is unbounded in the first
   * two: a caller walking countries mints a permanent entry per probe, and this process is long
   * lived. Sweeping on write keeps the map proportional to what is actually live, and costs a pass
   * over a map whose whole purpose is to be small.
   */
  private evictExpired<T>(cache: Map<string, CacheEntry<T>>, ttlMs: number): void {
    const now = this.clock();
    for (const [key, entry] of cache) {
      if (now - entry.at > ttlMs) cache.delete(key);
    }
  }

  /**
   * The methods + limits a corridor offers for one crypto, aggregated across this account's
   * providers: `min` is the smallest provider minimum, `max` the largest provider maximum, so the
   * gate admits any amount at least one offered provider will accept. Cached.
   */
  async corridor(country: string, fiat: string, crypto: string, direction: Direction): Promise<Corridor> {
    const key = `${direction}|${crypto}|${country}|${fiat}`;
    const hit = this.fresh(this.corridorCache.get(key), this.ttls.routes);
    if (hit !== undefined) return hit;

    const raw = await this.get(routesPath(direction, country, fiat, crypto));
    // Parsed per entry, and only a trustworthy answer is cached.
    //
    // Parsing the array as a whole (`z.array(routeEntry).safeParse`) fails as a whole: one element
    // missing `partner`, or a 200 carrying an unexpected body, would zero the entire corridor. That
    // zero is indistinguishable from Meld's genuine "not offered" (`[]`), so the gate would refuse
    // `CURRENCY_UNSUPPORTED` and the cache would memoise that refusal for up to `ttls.routes`. A parse
    // miss is closer to a transport miss than to an answer, and a transport miss is not cached.
    //
    // So keep the entries that parse, and treat a non-array body or any dropped element as
    // "cannot trust this"; serve what was salvaged for this request, cache nothing. A genuinely
    // empty array is still a real answer and is still cached, which is what keeps the country walk
    // from re-probing every corridor it has already been told is unserved.
    const rawEntries = Array.isArray(raw) ? raw : undefined;
    const entries: z.infer<typeof routeEntry>[] = [];
    let dropped = 0;
    for (const element of rawEntries ?? []) {
      const one = routeEntry.safeParse(element);
      if (one.success) entries.push(one.data);
      else dropped += 1;
    }
    const trustworthy = rawEntries !== undefined && dropped === 0;

    // method id -> aggregated limit
    const byMethod = new Map<string, MethodLimit>();
    for (const entry of entries) {
      for (const m of entry.paymentMethods ?? []) {
        const min = m.limits?.min ?? undefined;
        const max = m.limits?.max ?? undefined;
        const currency = m.limits?.currencyCode ?? fiat;
        // A method with no bound is unusable as a gate; skip it rather than admit an unbounded one.
        if (min === undefined || max === undefined) continue;
        // Nor is a bound denominated in some other currency. Adopting whatever `limits.currencyCode`
        // says would let a corridor asked for in one currency carry another's numbers, and
        // `limitFor` compares them in minor units as if they were the same unit, so the mismatch
        // would be invisible rather than loud. Skipped like an absent bound, because a gate that
        // cannot say what currency it is in is not a gate.
        //
        // Verified true in both directions: an off-ramp route's `limits.currencyCode` is the
        // *payout* fiat and equals the corridor's own fiat, exactly as a buy's does, so this guard
        // does not need a direction branch. What a sell's limits do *not* describe is the amount a
        // seller actually commits (that is crypto); see `Onramp.limitFor` for what that means for
        // the gate built on top of this.
        if (currency.toUpperCase() !== fiat.toUpperCase()) continue;
        const existing = byMethod.get(m.name);
        if (existing === undefined) {
          byMethod.set(m.name, {
            paymentMethodType: m.name,
            category: categoryOf(m.paymentType),
            min,
            max,
            currency,
            providers: [entry.partner],
          });
        } else {
          if (num(min) < num(existing.min)) existing.min = min;
          if (num(max) > num(existing.max)) existing.max = max;
          if (!existing.providers.includes(entry.partner)) existing.providers.push(entry.partner);
        }
      }
    }

    const corridor: Corridor = { country, fiat, crypto, methods: [...byMethod.values()] };
    if (trustworthy) {
      this.evictExpired(this.corridorCache, this.ttls.routes);
      this.corridorCache.set(key, { at: this.clock(), value: corridor });
    }
    return corridor;
  }

  /**
   * The full region dropdown: every Meld on-ramp country, name-sorted. One cheap call through
   * `catalogGet`, the global view; see the class header for why this one call is unkeyed while
   * the corridor probe is not. The list is not filtered by whether the crypto routes there,
   * because that is answered per selection by `corridorForCountry`; front-loading a probe per
   * country would be hundreds of calls for a list the buyer mostly scrolls past. Memoised whole;
   * refreshed after `ttls.countries`. (`crypto` only keys the cache and validates the caller; the catalogue
   * itself is crypto-independent.)
   */
  // `_crypto` is accepted (and validated by the caller; see `Discovery`) but does not key this
  // cache: the catalogue is crypto-independent within a direction, exactly as it always was.
  async countries(_crypto: string, direction: Direction): Promise<CountryRow[]> {
    const hit = this.fresh(this.countriesCache.get(direction), this.ttls.countries);
    if (hit !== undefined) return hit;

    const env = countriesEnvelope.safeParse(
      await this.catalogGet(`/network-partner/supported/countries?category=${CATEGORY[direction]}`),
    );
    const catalog = (env.success ? (env.data.countries ?? []) : [])
      .map((c) => ({ country: c.countryCode, name: c.name ?? c.countryCode }))
      .sort((a, b) => a.name.localeCompare(b.name));
    // Cached only when the envelope parsed, for the reason `corridor` does not cache a parse miss:
    // an unparseable body produced the same empty list as a real one, and memoising it means the
    // region dropdown stays empty for up to `ttls.countries` after the body is well-formed again. An
    // envelope that parsed to an empty or absent `countries` is a real answer and is cached.
    if (env.success) {
      this.countriesCache.set(direction, { at: this.clock(), value: catalog });
    }
    return catalog;
  }

  /**
   * The corridor for a country whose fiat the caller has not named: resolve the country's default
   * fiat, then read its routes. An empty `methods` (no default fiat, or no route for the crypto)
   * means "not deliverable here"; the caller then steers the buyer to another method or to crypto.
   */
  async corridorForCountry(country: string, crypto: string, direction: Direction): Promise<Corridor> {
    // The per-selection path swallows a transient defaults failure as "not deliverable right now".
    let fiat: string;
    try {
      fiat = await this.defaultFiat(country, direction);
    } catch {
      return { country, fiat: '', crypto, methods: [] };
    }
    if (fiat === '') return { country, fiat: '', crypto, methods: [] };
    return this.corridor(country, fiat, crypto, direction);
  }

  /**
   * A country's default fiat. `''` means Meld named none. Throws when the call itself failed or was
   * unparseable, so a caller can tell a transient failure apart from a real "no currency" and hold
   * the last known fiat rather than dropping the country.
   *
   * Only a real answer is cached: a thrown failure pins nothing.
   *
   * A buy reads Meld's own defaults endpoint. A sell does not: `/network-partner/defaults/
   * {country}/CRYPTO_OFFRAMP` answers `404` for **every** country tried (US, GB, DE, AU;
   * verified), never `200` with no currency, so it is not "this country has no default" the way
   * an absent `currencyCode` is -- it is "this endpoint does not exist for this category".
   * Swallowing that 404 into `''` the way a transport failure is swallowed would report every
   * country as unserved for sell, silently, which is exactly what the first version of this
   * change did before the probe caught it. `offrampDefaultFiat` reads the substitute the probe
   * found instead: `fiat-limits?category=CRYPTO_OFFRAMP` rows carry a `currencyCode` per country.
   */
  async defaultFiat(country: string, direction: Direction): Promise<string> {
    if (direction === 'sell') return this.offrampDefaultFiat(country);

    const hit = this.fresh(this.defaultsCache.get(country), this.ttls.defaults);
    if (hit !== undefined) return hit;

    const d = defaultsEnvelope.safeParse(
      await this.get(`/network-partner/defaults/${encodeURIComponent(country)}/${CATEGORY.buy}`),
    );
    if (!d.success) throw new Error(`unparseable defaults response for ${country}`);
    const fiat = d.data.currencyCode ?? '';
    this.evictExpired(this.defaultsCache, this.ttls.defaults);
    this.defaultsCache.set(country, { at: this.clock(), value: fiat });
    return fiat;
  }

  /**
   * Sell's stand-in for a defaults endpoint that returns `404` for every country (see
   * `defaultFiat`). `fiat-limits` is not scoped to one country -- the probe's own example, read
   * for `countryCode=GB`, came back carrying rows for AD, AU, BH and others alongside GB -- so it
   * is read once, unfiltered, and the whole (country -> currency) map is cached together, the same
   * shape `countries` already caches whole. A country can carry more than one row (one per payment
   * method); the first `currencyCode` seen for it is kept, on the same assumption `defaultFiat`
   * makes for a buy: a country has one civil currency, not one per payment method.
   */
  private async offrampDefaultFiat(country: string): Promise<string> {
    const hit = this.fresh(this.offrampFiatCatalog, this.ttls.defaults);
    if (hit !== undefined) return hit.get(country) ?? '';

    let catalog = new Map<string, string>();
    let real = false;
    try {
      const env = fiatLimitsEnvelope.safeParse(
        await this.get(`/network-partner/supported/fiat-limits?category=${CATEGORY.sell}`),
      );
      if (env.success) {
        for (const row of env.data.fiatLimits ?? []) {
          if (row.countryCode !== undefined && row.countryCode !== null && !catalog.has(row.countryCode)) {
            catalog.set(row.countryCode, row.currencyCode ?? '');
          }
        }
        real = true;
      }
    } catch {
      catalog = new Map();
    }
    // As with every other cache here, only a real (parsed) answer is memoised, so a transport
    // failure cannot pin every off-ramp country to "no fiat" for a whole TTL.
    if (real) this.offrampFiatCatalog = { at: this.clock(), value: catalog };
    return catalog.get(country) ?? '';
  }
}
