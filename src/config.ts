/**
 * Configuration, owned by the operator, validated before anything starts.
 *
 * Two properties matter more than the field list. There are no defaults for anything
 * that decides safety: the auth mode, the environment, and the secret's location are
 * all required, because a service that boots with a plausible default is a service that
 * runs in production with a development posture. And the base URL travels with the
 * secret reference in one object per environment, so a sandbox key cannot be paired
 * with the production endpoint by editing one field.
 */

import { readFile } from 'node:fs/promises';

import { compile } from '@fastify/proxy-addr';
import { z } from 'zod';

import { DESTINATIONS } from './meld/catalog.js';
import { MINOR_UNIT_DECIMAL, toMinorUnits } from './money.js';

/** Shared so the refinement below can re-test it; see the guard in `limit`. */
const DECIMAL = MINOR_UNIT_DECIMAL;
const decimal = z.string().regex(DECIMAL);

/**
 * A browser origin, which is not the same thing as a URL.
 *
 * `@fastify/cors` compares an allowlist entry to the `Origin` header by string equality, and an
 * Origin is always `scheme://host[:port]`, with no path and no trailing slash. `z.url()` accepted
 * `https://app.example/`, which is what you get copying a URL out of an address bar, and the
 * result is that every browser request is refused with nothing in this service's log to say
 * why ("CORS is broken"), during exactly the integration this service exists for. It fails
 * closed, so this is a usability defect rather than a hole. But catching operator mistakes is
 * this file's whole job, and it already rejects inverted limits and lowercase currencies.
 *
 * The host charset is real hostname characters, which also rejects `https://*.example`: the
 * array form of this allowlist is compared literally, so a wildcard matches nothing and reads
 * as a silent outage rather than as the unsupported feature it is.
 */
const origin = z
  .string()
  // `null` and `polkadot://` are here for the Polkadot host: the app runs inside it, and the
  // browser sends either an opaque `Origin: null` or the host's own scheme. Everything else this
  // validator refuses stays refused. The lower-case host, the real port range and the
  // default-port rule below are all still enforced, because an allowlist entry a browser can never
  // send is an entry that silently never matches.
  .refine(
    (value) =>
      value === 'null' ||
      /^(https?|polkadot):\/\/(\[[0-9a-fA-F:]+\]|[a-z0-9.-]+)(:(6553[0-5]|655[0-2]\d|65[0-4]\d{2}|6[0-4]\d{3}|[1-5]?\d{1,4}))?$/.test(
        value,
      ) ||
      PREVIEW_ORIGIN.test(value),
    'Expected a bare origin (scheme://host[:port], lower-case host, no path), or "null" for the opaque origin a sandboxed host sends, or a preview series written https://pr#-app.example.',
  )
  .refine((value) => !/^https:\/\/[^/]+:443$/.test(value) && !/^http:\/\/[^/]+:80$/.test(value), {
    message: 'Drop the default port: a browser Origin header never carries :443 on https or :80 on http.',
  });

/**
 * A per-PR preview origin, where `#` stands for the PR number: `https://pr#-app.example`.
 *
 * Deliberately the only pattern shape accepted. Every preview deploys under a fresh hostname, so
 * the series cannot be enumerated ahead of the deploy that creates it. But nothing wider than
 * `pr<digits>-<host>` is a real deployment, so nothing wider is admitted.
 *
 * `polkadot` as well as `https`, matching the schemes the literal validator below already takes.
 * The desktop host loads the app under its own scheme, so a preview running inside it presents
 * `polkadot://pr4-app.example` rather than an https origin. Note what this does not claim: a
 * browser sends `Origin: null` for an opaque origin, so if the host omits the scheme this entry is
 * one a browser never sends. Check the request's actual `Origin` before relying on it.
 */
const PREVIEW_ORIGIN = /^(https|polkadot):\/\/pr#-[a-z0-9-]+(\.[a-z0-9-]+)+$/;

/**
 * Compile one allowlist entry for matching against an `Origin`.
 *
 * A literal entry is returned untouched and keeps being compared by string equality, including
 * `null`, which is a real value a sandboxed host sends. `#` becomes `[0-9]+`, and every regex
 * metacharacter is escaped first so the label dots match dots and nothing else. Anchored, so
 * `https://pr4-app.example.attacker.test` is not a match.
 */
export const toOriginMatcher = (entry: string): string | RegExp =>
  entry.includes('#')
    ? new RegExp(`^${entry.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&').replace('#', '[0-9]+')}$`, 'u')
    : entry;

/**
 * Whether an origin is permitted by the allowlist.
 *
 * Shared by `buildServer` and `Onramp.checkRedirect`, which both read this one list. A plain
 * `allowed_origins.includes(origin)` is correct only while every entry is a literal, so a single
 * pattern entry would have CORS admit an origin that a redirect to that same origin is refused for.
 */
export const originAllowed = (allowed: readonly string[], origin: string): boolean =>
  allowed.some((entry) => {
    const matcher = toOriginMatcher(entry);
    return typeof matcher === 'string' ? matcher === origin : matcher.test(origin);
  });

/**
 * Whether a host is this pod's own loopback interface.
 *
 * Addresses only. `localhost` is deliberately not on this list: it is resolved by the
 * resolver (`/etc/hosts`, `nsswitch.conf`, NSS modules, search domains), all of which an operator
 * controls and any of which can point it elsewhere. `127.0.0.1` and `::1` are routed to the
 * loopback interface by the kernel and nothing can redirect them.
 *
 * This exemption is what permits sending the database password and every funding row in the clear,
 * so it covers the property being asserted (the packets never reach a network) rather than a name
 * that usually maps to it.
 */
const isLoopback = (host: string): boolean => host === '127.0.0.1' || host === '::1';

/**
 * Whether a host can only name something inside this cluster.
 *
 * Paired with `store.plaintext_link`, so the operator's assertion is checked rather than merely
 * recorded: the claim is "this is an in-cluster proxy", and a claim nothing verifies is a comment
 * with a schema around it. A bare single label resolves only through the pod's search domains, and
 * the `.svc` suffixes are cluster-local by construction; a public FQDN, an IP literal and a
 * `db.example.com` that a config quietly drifted to all fail.
 *
 * `<service>.<namespace>` is deliberately not accepted. It is a legitimate in-cluster form, but
 * two labels with no recognisable suffix are indistinguishable from `example.com`, and the whole
 * point here is to be able to tell. Use the bare name or the fully qualified one.
 *
 * `localhost` is excluded. It names loopback, so asserting it is an in-cluster proxy contradicts
 * itself, and `isLoopback` above already explains why a name is not evidence of loopback.
 */
const isClusterInternal = (host: string): boolean =>
  host !== 'localhost' &&
  (/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/u.test(host) || /^[a-z0-9][a-z0-9-.]*\.svc(\.cluster\.local)?$/u.test(host));

const secretSource = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('file'), path: z.string().min(1) }).strict(),
  z.object({ mode: z.literal('env'), var: z.string().min(1) }).strict(),
]);

/**
 * Per-destination limits. Rules about a single limit live here, not on the root schema.
 */
const limit = z
  .object({
    code: z.string().min(1),
    min: decimal,
    max: decimal,
    /** Canonical uppercase ISO 4217, because the request currency is upper-cased to match. */
    currency: z.string().regex(/^[A-Z]{3}$/),
  })
  .strict()
  .superRefine((entry, ctx) => {
    if (!DESTINATIONS.some((d) => d.code === entry.code)) {
      ctx.addIssue({
        code: 'custom',
        path: ['code'],
        message: `Unknown destination code "${entry.code}". Adding a destination is a code change.`,
      });
    }

    // An inverted range boots happily and then refuses every amount, which reads as an outage
    // rather than a typo.
    //
    // The pattern is re-tested first because zod runs an object refinement even when a
    // field-level check already failed: a failed `regex` marks the result "dirty", not
    // "aborted". Without this guard a typo'd amount reaches `toMinorUnits` and surfaces as a
    // raw BigInt conversion error instead of a readable message.
    if (!DECIMAL.test(entry.min) || !DECIMAL.test(entry.max)) return;

    if (toMinorUnits(entry.min) > toMinorUnits(entry.max)) {
      ctx.addIssue({
        code: 'custom',
        path: ['min'],
        message: `Minimum ${entry.min} exceeds maximum ${entry.max} for "${entry.code}".`,
      });
    }
  });

const configSchema = z
  .object({
    /** Gates nothing on its own; makes the dangerous combinations below detectable. */
    environment: z.enum(['development', 'sandbox', 'production']),
    server: z
      .object({
        port: z.number().int().min(1).max(65_535),
        host: z.string().min(1).default('0.0.0.0'),
        /** `silent` exists for tests and for an operator who ships logs elsewhere. */
        log_level: z.enum(['silent', 'error', 'warn', 'info', 'debug']).default('info'),
        /**
         * Ceiling on a whole request, not just the upstream call.
         *
         * The Meld timeout bounds one hop; this bounds everything, so a slow or half-open
         * client cannot hold a connection indefinitely. Comfortably above the upstream timeout
         * so a Meld call that is merely slow still gets to finish and report honestly.
         */
        request_timeout_ms: z.number().int().min(1_000).max(120_000).default(20_000),
        /**
         * Which peers may set `X-Forwarded-For`, as CIDRs or bare addresses.
         *
         * Peers rather than a hop count, because a hop count cannot validate the immediate peer.
         * Fastify refuses to trust anything under a numeric `trust proxy` for that reason, and
         * says so in `lib/request.js`: "Hop-count-only trust cannot validate the immediate peer.
         * Fail closed so direct clients cannot spoof X-Forwarded-* values by supplying enough
         * hops."
         *
         * It matters concretely: the Service is a ClusterIP and no NetworkPolicy ships, so any
         * workload that can reach the port could otherwise forge the header and mint an unlimited
         * supply of fresh rate-limit buckets, defeating the only control in front of both public
         * handshake routes, each of which costs a People-chain round trip and a ring-proof
         * verification.
         *
         * Empty means trust no peer and read no forwarded header, which is the safe default and
         * the one Fastify itself picks; every caller then buckets on the socket address, which
         * behind an ingress is one bucket for everyone.
         */
        trusted_proxy_cidrs: z.array(z.string().min(1)).default([]),
      })
      .strict(),
    meld: z
      .object({
        base_url: z.url(),
        api_key: secretSource,
        /** Meld pins behaviour to a dated API version and requires it on every call. */
        api_version: z.string().min(1),
        timeout_ms: z.number().int().min(500).max(30_000).default(8_000),
        /**
         * The quote this service asks for at boot to prove the key and the endpoint.
         *
         * A quote moves no money, so it is the cheapest honest liveness proof. It has to be
         * a request Meld will actually accept, which is why the operator supplies it rather
         * than the code inventing one.
         */
        boot_probe: z
          .object({
            /**
             * From the same catalog the routes are held to.
             *
             * Meld resolves an unrecognised destination code to Bitcoin rather than refusing
             * it (see `meld/catalog.ts`), so a typo here returns BTC quotes and the probe reports
             * "Meld credentials accepted" for a corridor this deployment does not serve. The
             * probe moves no money, which makes it false confidence rather than a wrong purchase,
             * and false confidence at boot is exactly what the probe exists to rule out.
             */
            destination_code: z.string().refine((code) => DESTINATIONS.some((d) => d.code === code), {
              message: 'Unknown destination code. The boot probe must name one this service delivers.',
            }),
            source_amount: z.string().min(1),
            source_currency: z.string().length(3),
            country_code: z.string().regex(/^[A-Z]{2}$/),
            payment_method_type: z.string().min(1),
          })
          .strict(),
        /**
         * How the region catalog is scoped, without ever naming a provider here.
         *
         * `account` (default) reads discovery with the key, so Meld returns exactly the providers
         * this account has enabled: a sandbox with one onboarded provider shows only its corridors,
         * and the catalog can never advertise a corridor the quote would then refuse. `global` reads
         * it without the key, returning every provider Meld routes. Correct only where the account
         * has every provider enabled (a fully-provisioned production), and a mismatch otherwise.
         */
        discovery_scope: z.enum(['account', 'global']).default('account'),
        /** How long a discovered corridor / country catalog stays fresh before a re-probe. The
         *  crypto a catalog is built for is not configured here; it rides each request's
         *  `destinationCurrencyCode`, validated against `DESTINATIONS`. */
        supported_cache_ttl_ms: z.number().int().min(60_000).max(86_400_000).default(3_600_000),
      })
      .strict(),
    auth: z
      .object({
        /**
         * `personhood` is the production posture: the caller's ring-VRF proof is verified against
         * the People-chain ring commitment, and a short-lived JWT carries the proven person to the
         * protected routes. `insecure_dev` exists so the Meld leg can be exercised without it; it
         * trusts a header and is refused anywhere but `development` (see the superRefine).
         * It gives every caller of a product one alias, so it has no data separation at all.
         */
        mode: z.enum(['personhood', 'insecure_dev']),
        /**
         * Personhood's configuration. Optional as a shape and required by the superRefine when
         * `mode` is `personhood`: a mode with no key/RPC/collection must fail at boot, never
         * serve with a verifier it cannot run. Nothing here has a default.
         */
        personhood: z
          .object({
            /** Where the JWT signing key is read from. A second `Secret`, redacted like the Meld key. */
            jwt_key: secretSource,
            /** The People-chain RPC the register gate reads the ring commitment from. */
            people_rpc_url: z.url(),
            /**
             * The People-chain collections a proof may open against, tried in order.
             *
             * A list because pinning one silently refuses every person in the other: the commitment
             * read succeeds for a collection they are not in, so the proof does not open and the
             * service looks healthy while turning real people away. Multiplies the alias bound;
             * see threat model R13.
             *
             * The exponent rides with the collection because it is the ring domain; two collections
             * need not share one.
             */
            collections: z
              .array(
                z
                  .object({
                    /** The collection id, as `0x...` hex (32 bytes). */
                    identifier: z.string(),
                    /** The ring exponent (proof domain) for this collection: 9 | 10 | 14. */
                    ring_exponent: z.number().int().refine((n) => n === 9 || n === 10 || n === 14, {
                      message: 'ring_exponent must be 9, 10 or 14.',
                    }),
                  })
                  .strict(),
              )
              .min(1),
            /** How long a challenge stays acceptable; the freshness that stops replay. */
            challenge_ttl_ms: z.number().int().min(1_000).max(300_000),
            /** How long a redeemed session JWT is valid; the browser keeps it this long. */
            token_ttl_s: z.number().int().min(30).max(3_600),
          })
          .strict()
          .optional(),
      })
      .strict(),
    /**
     * Per-(code, currency) amount bounds. Not the gate that decides what is buyable.
     *
     * Ground truth is Meld's live route catalog (`meld/discovery.ts`), asked per (country, fiat,
     * crypto, method) at the moment of the quote, so a corridor is buyable because the upstream
     * offers it. A row here tightens that bound for the pair it names and cannot widen it, which is
     * where a deployment expresses a business ceiling stricter than Meld's.
     *
     *   - A pair with no row is still buyable at Meld's bounds, so this is not a list of corridors
     *     permitted to spend the key.
     *   - A row that does not overlap the live bound refuses the corridor rather than widening to
     *     the upstream one.
     *   - During a discovery outage it is the fallback allow-list, so left empty an outage fails
     *     closed and every code refuses.
     */
    limits: z.array(limit).default([]),
    /**
     * Product ids permitted to spend the key.
     *
     * Curation at the money boundary. Declaring the funding modality is a manifest edit
     * anyone can make; it earns a row in the host's rail list, not the right to spend a
     * commercial credential. Empty means closed, not open.
     */
    allowed_products: z.array(z.string().min(1)),
    /**
     * Browser origins permitted to call this service.
     *
     * An explicit allowlist and never a wildcard: the caller is a browser application, so
     * without CORS it cannot reach this service at all, and with `*` any page on the internet
     * could spend the operator's Meld quota from a visitor's browser. Empty means no browser
     * may call it, which is the right default for a service reached only server-to-server.
     */
    // `.default({})`, not a second copy of the field defaults: when the whole object is absent
    // an outer literal wins and the per-field defaults never run, so the two could drift and
    // ship different values depending on whether the operator wrote `"cors": {}` or nothing.
    cors: z
      .object({ allowed_origins: z.array(origin).default([]) })
      .strict()
      .prefault({}),

    /**
     * Per-caller request ceiling, in two allowances, because the two buckets bound different things.
     *
     * It protects a commercial quota rather than the service: these endpoints are cheap to serve and
     * metered for the operator, so what matters is the number of Meld calls.
     *
     * `per_address_max` stands in front of traffic with nobody proven behind it: the two public
     * handshake routes, an `insecure_dev` caller, and every failed authentication. It makes probing
     * and proof verification expensive, is shared by everyone behind one NAT, and is the tighter of
     * the two.
     *
     * `per_person_max` is one person's own ceiling and is deliberately more generous, because what it
     * bounds is a genuine session: a few quotes, a session, then polling one request to settlement.
     * A second bucket costs either a proof of a second distinct person, which the personhood gate
     * makes unavailable, or a second proof by the same person against another allowed product, which
     * is free. The alias is contextual on the product id and on the People collection, so the
     * effective ceiling is this number times `allowed_products.length x collections.length`
     * (threat-model R13).
     *
     * There is no single `max`, and `.strict()` refuses one at boot, so an operator's existing
     * per-address number cannot silently become a per-person ceiling.
     */
    rate_limit: z
      .object({
        per_person_max: z.number().int().min(1).default(120),
        per_address_max: z.number().int().min(1).default(30),
        window_seconds: z.number().int().min(1).max(3_600).default(60),
      })
      .strict()
      // See `cors` above: every field here has a default, so restating them would be a second
      // source of truth that only applies when the whole object is omitted.
      .prefault({}),

    /** Stops session creation without a deploy. Nothing else is affected. */
    session_creation_enabled: z.boolean().default(true),

    /**
     * The durable funding-request store, on CloudSQL Postgres.
     *
     * Required with no default: a funding history that silently never persists is worse than a
     * server that refuses to boot without saying where history lives. The password is a
     * `secretSource` like the Meld key and the JWT key, so it is a mounted file outside
     * development and is refused from the environment there. One rule for all three credentials
     * rather than an exception for the newest.
     *
     * `pool_max` is per replica and deliberately small. This process serves HTTP and runs the
     * worker against one pool, so a pool the worker can saturate is a pool that starves request
     * handlers.
     */
    store: z
      .object({
        host: z.string().min(1),
        port: z.number().int().min(1).max(65535).default(5432),
        database: z.string().min(1),
        user: z.string().min(1),
        password: secretSource,
        /** Refused outside development by the guard below: an unencrypted link carries the rows. */
        ssl: z.boolean().default(true),
        /**
         * The operator's assertion that an unencrypted link is acceptable on a hop that leaves the
         * pod, permitting `ssl: false` outside development against a cluster-internal host.
         *
         * One accepted value because one shape has been reasoned about: the Cloud SQL Auth Proxy as
         * its own Deployment and Service. It listens in the clear and cannot terminate TLS from a
         * client, so `ssl: true` against it fails at connect. Refusing the shape does not encrypt
         * the deployment; it prevents it.
         *
         * A field rather than a hostname inference, because `isLoopback` above refuses even
         * `localhost` on the grounds that a name is resolved by machinery the operator controls.
         * The assertion is nevertheless checked against `isClusterInternal`: on its own it would
         * catch nothing, so a config that drifts to a remote database would keep passing.
         *
         * What this accepts is real; see threat model R20.
         */
        plaintext_link: z.literal('in-cluster-proxy').optional(),
        /**
         * The Postgres schema to resolve unqualified names in. Omitted means `public`, which is
         * what CloudSQL hands a fresh instance. Named so a deployment can share a database, and so
         * the tests can give each case its own.
         */
        // Constrained, not merely non-empty: it is interpolated into the connection's libpq
        // `options` string, so anything outside an unquoted identifier is a way to set connection
        // parameters this service never chose. Operator-controlled rather than caller-controlled,
        // which is why it is a narrow pattern and not an escape.
        schema: z
          .string()
          .regex(/^[A-Za-z_][A-Za-z0-9_$]*$/u, {
            message: 'store.schema must be a bare Postgres identifier: letters, digits, _ and $, not starting with a digit.',
          })
          .max(63)
          .optional(),
        pool_max: z.number().int().min(1).max(50).default(10),
        statement_timeout_ms: z.number().int().min(100).max(60_000).default(10_000),
        connection_timeout_ms: z.number().int().min(100).max(60_000).default(5_000),
      })
      .strict(),

    /**
     * The background worker that advances in-flight funding requests.
     *
     * `interval_ms` bounds how often a request's Meld transaction is polled. `enabled` exists so a
     * unit test can run the service with the worker silent; the worker itself is still fully
     * tested directly, just not racing a clock in every route test.
     */
    worker: z
      .object({
        interval_ms: z.number().int().min(1_000).max(300_000).default(15_000),
        enabled: z.boolean().default(true),
        /**
         * How long to keep watching a request for a payment before concluding there was none.
         *
         * A floor, not a fallback: a rail's own expiry only extends this window. Meld's `expiresAt`
         * says when its capture page closes, which is not evidence about payment, so taking it as the
         * deadline concludes `expired` over a buyer whose money has moved. It also bounds the scan:
         * without it a record with no rail expiry never leaves `session_opened`.
         *
         * Three days, because bank transfers settle in up to 24 hours and a Friday initiation lands
         * Monday. The cost is latency on the happy path: a row comes back round every
         * `(in-flight / batch) x interval`, so a longer window means a paid buyer can wait longer to
         * see `settled`. The lever for that is `worker.interval_ms` or the batch size, not this.
         */
        session_max_age_ms: z
          .number()
          .int()
          .min(60_000)
          .max(30 * 24 * 3_600_000)
          .default(72 * 3_600_000),
        /**
         * How long a locally refused row is kept before the worker deletes it.
         *
         * A refusal never reached a payment rail (it is a validation failure this service wrote
         * down), so past the window it is storage with no reader, on an instance that autogrows
         * and that nothing else prunes. Every other terminal state is a record of something that
         * did reach a rail, and a buyer's purchase history is not this service's to expire.
         *
         * Configurable rather than constant because it is a retention policy, and those are
         * decided by whoever answers for the data rather than by this file. 90 days is the
         * decision on record; the floor of one day exists so a typo cannot turn it into a delete.
         */
        refusal_retention_days: z
          .number()
          .int()
          .min(1)
          .max(3_650)
          .default(90),
      })
      .strict(),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    /**
     * Parse a URL that a field-level `z.url()` has already looked at, or give up quietly.
     *
     * `superRefine` runs even when a field failed its own check (zod marks the result dirty
     * rather than aborting), so `new URL()` here would throw a bare `TypeError: Invalid URL` out
     * of `parseConfig`, past the error aggregation, and out of `main` as `Startup failed: Invalid
     * URL`, naming no field. That is what the shipped default values produce.
     *
     * Returning `undefined` and skipping the extra checks leaves the field's own `z.url()`
     * message as the one the operator reads: one error per problem, which is the contract this
     * function promises.
     */
    const parsedUrl = (value: string): URL | undefined => {
      try {
        return new URL(value);
      } catch {
        return undefined;
      }
    };

    /**
     * The endpoint must be the one this environment is allowed to talk to, pinned by host name.
     *
     * A substring test for `api-sb.` classified an endpoint without asking whether it was
     * Meld, so production accepted lookalike hosts, plaintext http, and a userinfo form that
     * reads as Meld and resolves elsewhere, each receiving `Authorization: BASIC <key>`. It
     * also skipped `development`, making that an alias for "anywhere". `development` now keeps
     * every freedom except the endpoint where money actually moves.
     */
    const MELD_HOST = { production: 'api.meld.io', sandbox: 'api-sb.meld.io' } as const;
    const refuseUrl = (message: string) => {
      ctx.addIssue({ code: 'custom', path: ['meld', 'base_url'], message });
    };
    const url = parsedUrl(cfg.meld.base_url);
    // A `base_url` that did not parse has already been reported by `z.url()`, and a second message
    // about the same field adds nothing, so the chain below runs only when there is a URL to
    // inspect.
    if (url !== undefined) {
        if (url.username !== '' || url.password !== '') {
        // `https://api.meld.io@attacker.example`: the host is what follows the `@`.
        refuseUrl('meld.base_url must not carry userinfo: the real host is what follows the "@".');
      } else if (url.pathname !== '/') {
        // Endpoint paths are absolute, so `new URL(path, base)` discards a prefix silently.
        refuseUrl(`meld.base_url must have no path: "${url.pathname}" would be silently ignored.`);
      } else if (cfg.environment === 'development') {
        if (url.host === MELD_HOST.production) {
          refuseUrl(
            'meld.base_url is the production Meld endpoint, which environment "development" may ' +
              'not use. Set environment to "production", which then requires a real auth.mode.',
          );
        }
      } else if (url.protocol !== 'https:') {
        refuseUrl(`meld.base_url must use https in "${cfg.environment}", not "${url.protocol}".`);
      } else if (url.host !== MELD_HOST[cfg.environment]) {
        refuseUrl(
          `environment "${cfg.environment}" requires meld.base_url host ` +
            `"${MELD_HOST[cfg.environment]}", not "${url.host}".`,
        );
      }
    }

    /**
     * The People-chain RPC is the root of trust for personhood, so its scheme is checked here.
     *
     * The commitment read from it is the only thing separating a real ring member from someone
     * who generated their own ring and proof. Over `ws://`, anyone on the path answers
     * `state_getStorage` with a commitment they built themselves, and their self-minted proof
     * then validates against it: a JWT for a person who does not exist. `meld.base_url` is
     * pinned because it carries a key; this one decides who is a person.
     */
    if (cfg.auth.personhood !== undefined) {
      const rpc = parsedUrl(cfg.auth.personhood.people_rpc_url);
      // `undefined` means the field's own `z.url()` already refused it.
      if (rpc !== undefined && cfg.environment !== 'development' && rpc.protocol !== 'wss:') {
        ctx.addIssue({
          code: 'custom',
          path: ['auth', 'personhood', 'people_rpc_url'],
          message:
            `auth.personhood.people_rpc_url must use wss in "${cfg.environment}", not ` +
            `"${rpc.protocol}": an unauthenticated RPC can forge the ring commitment the ` +
            'personhood gate is verified against.',
        });
      }
    }

    // Refused outside `development`, not merely outside `production`.
    //
    // In this mode every caller of a product shares one alias (`dev:<productId>`), and the alias is
    // what funding rows, the rate-limit bucket and the idempotency index are all scoped by. So two
    // callers of one product share a funding scope (each can read the other's wallet address,
    // amount and timeline) and share an idempotency namespace, which is the sharper half: a key
    // collision replays the other caller's session and answers 201 with their settlement URL.
    //
    // A sandbox holding anything real therefore leaks it between callers, and "sandbox" is exactly
    // where a real integration is first pointed. Development is the only environment where every
    // caller being the same person is a true statement.
    // `Secret`'s redaction hooks protect the value once it is in the object; they do nothing for
    // `process.env`, which is readable at /proc/<pid>/environ by anything sharing the namespace,
    // echoed by `docker inspect` and by a pod spec, and captured in a core dump's environment
    // block. That is the exact vector the file-mount design exists to avoid, and `secret.ts` calls
    // `file` "the default and the only mode allowed in production" while the schema treated the two as
    // equals. Development keeps `env` because a developer without a mount needs something.
    for (const [label, source] of [
      ['meld.api_key', cfg.meld.api_key],
      // The store credential belongs here for the same reason as the other two, and was missing
      // while the comment on the `store` block claimed "one rule for all three credentials". It
      // opens every funding row (alias, wallet address, amount, timeline), and `Secret`'s
      // redaction hooks do nothing for `process.env`, which is the whole reason this loop exists.
      ['store.password', cfg.store.password],
      ...(cfg.auth.personhood === undefined ? [] : [['auth.personhood.jwt_key', cfg.auth.personhood.jwt_key] as const]),
    ] as const) {
      if (source.mode === 'env' && cfg.environment !== 'development') {
        ctx.addIssue({
          code: 'custom',
          path: label.split('.'),
          message: `${label} must be mounted as a file outside development: an environment variable is readable from the process table and echoed by the pod spec.`,
        });
      }
    }

    // Validated with the compiler that will actually consume it, not with a regex approximating
    // its grammar.
    //
    // A hand-written regex accepts shapes `proxy-addr` rejects (`10.0.0.0/33`, `::1/129`,
    // `127.0.0.1/00`), which reinstates the failure this check exists to prevent: a malformed
    // entry passing config load and then throwing inside the `Fastify()` constructor, after the
    // store is open, with a message that never names this field. So the grammar is asked, not
    // mirrored.
    for (const [index, entry] of cfg.server.trusted_proxy_cidrs.entries()) {
      try {
        compile([entry]);
      } catch (error) {
        ctx.addIssue({
          code: 'custom',
          path: ['server', 'trusted_proxy_cidrs', index],
          message:
            `"${entry}" is not an address, CIDR range, or one of loopback/linklocal/uniquelocal: ` +
            (error instanceof Error ? error.message : String(error)),
        });
      }
    }

    // A plaintext origin outside development is two holes at once. `@fastify/cors` would let an
    // `http://` page call `/quote` and `/session`, spending the operator's metered quota and
    // carrying the caller's bearer token over an unencrypted origin. And since the redirect
    // guard shares this list, that origin would be approved for CORS and refused for a redirect.
    // One allowlist, two answers, which is the disagreement the redirect fix set out to end.
    for (const value of cfg.cors.allowed_origins) {
      if (value.startsWith('http://') && cfg.environment !== 'development') {
        ctx.addIssue({
          code: 'custom',
          path: ['cors', 'allowed_origins'],
          message: `cors.allowed_origins must use https outside development: "${value}" is plaintext.`,
        });
      }
    }

    // The store link carries every funding row (aliases, wallet addresses, amounts) and the
    // password that opens it. Plaintext across a VPC is refused for the same reason
    // `people_rpc_url` refuses `ws://`.
    //
    // Except over loopback, which is how CloudSQL is actually reached. The Cloud SQL Auth
    // Proxy runs as a sidecar, terminates TLS to the instance itself, and speaks plaintext on
    // `127.0.0.1`, a hop that never leaves the pod's network namespace. Requiring TLS to it
    // fails the handshake, and refusing the correction left both available deployment shapes
    // unreachable: the proxy could not be spoken to, and a direct private IP needs a per-instance
    // CA that this config has nowhere to put.
    //
    // What the guard protects is the link leaving the pod. Loopback does not.
    if (
      !cfg.store.ssl &&
      cfg.environment !== 'development' &&
      !isLoopback(cfg.store.host) &&
      !(cfg.store.plaintext_link !== undefined && isClusterInternal(cfg.store.host))
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['store', 'ssl'],
        message:
          `store.ssl must be true when environment is "${cfg.environment}" and store.host is not loopback: ` +
          'the link carries funding rows and the credential that opens it. For a Cloud SQL Auth Proxy ' +
          'reached over the cluster network, which cannot terminate TLS from its clients, set ' +
          'store.plaintext_link to "in-cluster-proxy". That is accepted only with a cluster-internal ' +
          `host (a bare Service name, or one ending .svc / .svc.cluster.local); "${cfg.store.host}" is not one.`,
      });
    }

    // A stale assertion would silently re-permit plaintext if someone later flipped `ssl` back.
    if (cfg.store.ssl && cfg.store.plaintext_link !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['store', 'plaintext_link'],
        message:
          'store.plaintext_link asserts that an unencrypted link is acceptable, but store.ssl is true. ' +
          'Remove the assertion, or set store.ssl to false if the link really is plaintext.',
      });
    }

    if (cfg.auth.mode === 'insecure_dev' && cfg.environment !== 'development') {
      ctx.addIssue({
        code: 'custom',
        path: ['auth', 'mode'],
        message: `auth.mode "insecure_dev" is refused when environment is "${cfg.environment}"; it has no data separation between callers.`,
      });
    }

    // A preview-series pattern is a development affordance, and refused anywhere else.
    //
    // It stands for hostnames nobody has deployed yet, which is exactly what a per-PR preview
    // needs and exactly what a deployment serving buyers must not have: this list answers twice,
    // so a pattern widens both who may spend the operator's metered quota from a visitor's browser
    // and, through `checkRedirect`, where a buyer may be sent the instant a card is charged.
    //
    // Refused rather than merely ignored, because ignoring it would mean a config that reads as
    // permitting previews while silently refusing every one of them, and a silently-never-matching
    // entry is the failure the `origin` grammar above is shaped to prevent. An operator who wants
    // an origin outside development names it literally; that friction is the point.
    for (const [index, entry] of cfg.cors.allowed_origins.entries()) {
      // A literal origin cannot contain `#` (the host charset refuses it), so this identifies a
      // pattern without re-deriving the grammar.
      if (entry.includes('#') && cfg.environment !== 'development') {
        ctx.addIssue({
          code: 'custom',
          path: ['cors', 'allowed_origins', index],
          message:
            `"${entry}" is a preview-series pattern, which is refused when environment is "${cfg.environment}": ` +
            'this list also gates redirectUrl, so a pattern widens where a buyer may be sent after payment. ' +
            'Name the origin literally outside development.',
        });
      }
    }

    // `personhood` needs its configuration; `insecure_dev` ignores it entirely. The personhood
    // block is `.strict()` and required whenever mode is personhood, so a cluster booted with
    // mode=personhood but no key/RPC/collection stops at startup rather than serving with a
    // verifier it cannot actually run.
    if (cfg.auth.mode === 'personhood') {
      if (!cfg.auth.personhood) {
        ctx.addIssue({
          code: 'custom',
          path: ['auth', 'personhood'],
          message: 'auth.personhood is required when auth.mode is "personhood".',
        });
      } else {
        // Each identifier, by index, so a bad third entry names the third entry. The collection ids
        // are ASCII names space-padded to 32 bytes (`pop:polkadot.network/people` carries four
        // trailing `0x20`), so a trimmed value is a plausible mistake that must not be waived.
        const seen = new Map<string, number>();
        for (const [index, entry] of cfg.auth.personhood.collections.entries()) {
          if (!/^0x[0-9a-fA-F]{64}$/.test(entry.identifier)) {
            ctx.addIssue({
              code: 'custom',
              path: ['auth', 'personhood', 'collections', index, 'identifier'],
              message:
                'identifier must be a 32-byte hex value, e.g. "0x" followed by 64 hex digits. The ' +
                'People collection ids are ASCII names padded to 32 bytes, so do not trim trailing spaces.',
            });
            continue;
          }
          // Duplicates are refused because the entry is what carries the exponent: two rows for
          // one collection disagreeing on it makes verification depend on list order.
          const canonical = entry.identifier.toLowerCase();
          const first = seen.get(canonical);
          if (first !== undefined) {
            ctx.addIssue({
              code: 'custom',
              path: ['auth', 'personhood', 'collections', index, 'identifier'],
              message: `duplicate collection identifier: already declared at index ${String(first)}.`,
            });
          } else {
            seen.set(canonical, index);
          }
        }
      }
    }

    // Only the cross-entry rule belongs here; per-limit rules live on `limit` above. A limit is
    // keyed by (code, currency): a destination may be offered in several fiats (a card buyer pays
    // USD, a SEPA buyer pays EUR), each with its own bounds. A second entry for the same
    // (code, currency) is silently ignored by lookup, so refuse that rather than pick one.
    const seen = new Set<string>();
    for (const [i, entry] of cfg.limits.entries()) {
      const key = `${entry.code}:${entry.currency}`;
      if (seen.has(key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['limits', i, 'code'],
          message: `Duplicate limits for "${entry.code}" in ${entry.currency}.`,
        });
      }
      seen.add(key);
    }
  });

/** The validated configuration. Every consumer takes this, never the raw parsed JSON. */
export type Config = z.infer<typeof configSchema>;

/**
 * Parse and validate, or throw with every problem at once.
 *
 * All issues rather than the first: an operator fixing a config file one error per
 * restart is an operator who stops reading the errors.
 */
export function parseConfig(raw: unknown): Config {
  const result = configSchema.safeParse(raw);
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid configuration:\n${problems}`);
  }
  return result.data;
}

/** Read a config file and validate it. Throws on unreadable, unparseable or invalid. */
export async function loadConfig(path: string): Promise<Config> {
  const contents = await readFile(path, 'utf8');
  return parseConfig(JSON.parse(contents));
}
