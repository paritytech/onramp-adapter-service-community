/**
 * Bootstrap, minus the process.
 *
 * The ordering is the point: the key is proven before the port opens, because the worst place
 * to discover a wrong key is in front of a buyer who has entered their card details.
 *
 * Separate from `main.ts` so it can be tested: this module holds the guarantee the README leads
 * with, and what stays in `main.ts` is process wiring with no branches.
 */

import type { FastifyBaseLogger, FastifyInstance } from 'fastify';

import { hkdfSync } from 'node:crypto';

import { loadConfig, type Config } from './config.js';
import { ChainflipRail } from './chainflip/rail.js';
import { FundingStore } from './funding/store.js';
import { startWorker, type RailObservation } from './funding/worker.js';
import { MeldClient, MeldHttpError } from './meld/client.js';
import { MeldDiscovery } from './meld/discovery.js';
import { Onramp } from './onramp.js';
import { MeldRail } from './meld/rail.js';
import type { RailName, RailRegistry } from './rail.js';
import { PersonhoodService, type PersonhoodDeps } from './personhood.js';
import { chainReader } from './personhood/chain.js';
import { commitmentsFrom } from './personhood/source.js';
import { validateWithCommitment } from './personhood/verifiablejs.js';
import { resolveSecret } from './secret.js';
import { buildServer } from './server.js';

/** A listening service, and the one call that takes it down. */
interface ServerHandle {
  app: FastifyInstance;
  /** Stop the worker, close the server, release the store. Idempotent; safe to call once per signal. */
  close: () => Promise<void>;
}

/**
 * Build, prove the credential, then listen. Returns the listening instance.
 *
 * `logDestination` exists for the same reason it does on `buildServer`: the warning below is the
 * operator's only signal that the service is running without caller verification, and a signal
 * nothing can read is a signal nothing can assert.
 */
export async function start(
  configPath: string,
  logDestination?: { write: (line: string) => void },
  /**
   * How each rail is observed for settlement, by rail name.
   *
   * A parameter, not a constant read at the point of use: what can be observed has to be a value
   * this function is given rather than a predicate over a literal. Decided at authoring time it
   * would leave the worker unreachable while still looking like live wiring.
   *
   * Omitted, it defaults to Meld's own observation (below), which is wired and live. Chainflip
   * has none, because it cannot open a session to observe. Register a rail's finder/mapper here
   * and the worker starts on its own.
   */
  observations?: Readonly<Partial<Record<RailName, RailObservation>>>,
): Promise<ServerHandle> {
  const cfg = await loadConfig(configPath);
  const apiKey = await resolveSecret(cfg.meld.api_key);

  const meld = new MeldClient(cfg.meld.base_url, apiKey, cfg.meld.api_version, cfg.meld.timeout_ms);
  const meldRail = new MeldRail(meld);

  // Live capability discovery over Meld's route catalog. Reading it at runtime is what makes the
  // supported-region set and the amount bounds dynamic instead of hand-maintained. `account` scope
  // reads through the client's keyed GET so Meld returns this account's providers (sandbox -> its
  // onboarded set); the
  // provider is Meld's to choose at quote time and is never named here. `global` reads unkeyed for
  // a fully-provisioned production. Lazily populated and cached for `supported_cache_ttl_ms`.
  const discoveryGet =
    cfg.meld.discovery_scope === 'global' ? meld.publicGet.bind(meld) : meld.authedGet.bind(meld);
  // The country list is always the global one, whatever `discovery_scope` says; it feeds a
  // dropdown, not a charge. Keyed, it is scoped to this account's onboarded providers, and a
  // country missing from it cannot be declined because there is no row to select: the buyer just
  // never sees their country and gets no explanation. Unkeyed it is Meld's full on-ramp list, and
  // the per-selection `corridorForCountry` probe, which stays on `discoveryGet` above, is what
  // answers whether the crypto actually routes there. See MeldDiscovery's header.
  const discovery = new MeldDiscovery(
    discoveryGet,
    cfg.meld.supported_cache_ttl_ms,
    undefined,
    meld.publicGet.bind(meld),
  );

  // The rail registry. Both rails are always wired, but only Meld can open a session:
  // Chainflip swaps on-chain assets and has no fiat leg, so there is no correct asset or amount
  // to send for a card purchase, and it refuses rather than guess (see src/chainflip/rail.ts).
  // Registered rather than absent so the refusal names the real reason instead of "rail not
  // wired".
  const rails: RailRegistry = { meld: meldRail, chainflip: new ChainflipRail() };

  // In `personhood` mode this builds the handshake service: one JWT signing Secret, from which the
  // challenge HMAC key and the JWT signing key are HKDF-derived under separate labels, so the
  // challenge path can never mint a bearer token. In `insecure_dev` nothing personhood-shaped is
  // built and nothing is resolved.
  const personhood =
    cfg.auth.mode === 'personhood' ? await buildPersonhood(cfg) : undefined;

  // The durable funding store: the status surface answers from it and the worker advances it,
  // so a restart resumes from the persisted requests rather than losing in-flight work.
  const funding = await FundingStore.open({
    host: cfg.store.host,
    port: cfg.store.port,
    database: cfg.store.database,
    user: cfg.store.user,
    password: await resolveSecret(cfg.store.password),
    ssl: cfg.store.ssl,
    ...(cfg.store.schema === undefined ? {} : { searchPath: cfg.store.schema }),
    poolMax: cfg.store.pool_max,
    statementTimeoutMs: cfg.store.statement_timeout_ms,
    connectionTimeoutMs: cfg.store.connection_timeout_ms,
  });

  // The audit sink is the request logger: one append-only record per externally observable
  // event, shipped wherever PCF already ships logs. See `audit.ts` on why not a database.
  let app: Awaited<ReturnType<typeof buildServer>> | undefined;
  let worker: ReturnType<typeof startWorker> | undefined;
  // The worker starts only after this and after the port opens. Constructed earlier, a boot that
  // then failed on a bad credential would leave a loop advancing durable funding rows with no
  // handle to stop it, because `start` rejects and the caller never gets a `close`.
  //
  // `buildServer` is inside this `try` too, not before it. The store is connected and migrated by
  // now, and building the server can throw (a plugin registration, or anything the `Fastify()`
  // constructor validates). Outside the guard, that left the pool open with no handle to close it:
  // one dangling CloudSQL connection per attempt, which a crash-loop multiplies. One guard covers
  // both, so there is no second cleanup path to keep in step with this one.
  try {
    app = await buildServer(
      cfg,
      (audit) =>
        new Onramp(cfg, rails, audit, funding, meldRail, Date.now, () => crypto.randomUUID(), discovery),
      personhood,
      logDestination,
    );
    // A non-optional handle for the callbacks below: `app` has to be declared outside this block
    // so the `catch` can close it, and TypeScript cannot narrow a mutable binding inside a closure.
    const server = app;


  // Empty `cors.allowed_origins` is the shipped default and it is the right default: it fails
  // closed, refusing every browser and every redirect. It is the wrong thing to deploy silently.
  //
  // This service is browser-facing by design. A browser application calls it directly, which is why it
  // has an origin allowlist at all. With the list empty, `@fastify/cors` is registered with
  // `origin: false`, so the preflight is refused and the SPA sees a network-shaped failure with
  // nothing in it naming the cause. The same list gates `redirectUrl`, so every session would be
  // refused too. An operator who forgot the value learns from a browser console rather than from
  // the service.
  //
  // A warning rather than a boot refusal: the API is perfectly usable server-to-server, and a
  // deployment that has no browser in front of it is a legitimate shape this must not block.
  if (cfg.cors.allowed_origins.length === 0 && cfg.environment !== 'development') {
    app.log.warn(
      { environment: cfg.environment },
      'cors.allowed_origins is empty: every browser request will fail its preflight and every ' +
        'redirectUrl will be refused. Set it to the front-end origins this deployment serves.',
    );
  }

  if (cfg.auth.mode === 'insecure_dev') {
    app.log.warn(
      { environment: cfg.environment },
      'auth.mode is "insecure_dev": callers are NOT verified and the product id is taken from a header. ' +
        'Never use this outside development.',
    );
  }

  // `buildServer` has already built the caller verifier, so an unimplemented auth mode has
  // already stopped the process by this point. What is left is proving the credential.
  //

    await verifyKey(meld, cfg, app.log);
    await app.listen({ port: cfg.server.port, host: cfg.server.host });

  // The worker advances in-flight requests even when no SPA is open. Observation dispatch is per
  // rail. Stopped on shutdown so a restart tears down cleanly.
  //
  // Meld is observable: a session is filed under its funding row's id, so the transaction that
  // row produces can be found again. Chainflip is absent rather than stubbed; it opens no
  // session, so there is nothing of its to observe.
  //
  // Not started when no rail can observe. A worker with no finder does not sit idle: every
  // in-flight row ages out to `unobserved` (terminal, and unactionable) over purchases it had no
  // way of seeing. Leaving a request at `session_opened` is the truthful answer in that case, so
  // the loop stays down and says so.
  const wired = observations ?? { meld: meldRail.observation() };
  const observable = Object.keys(wired).length > 0;
  if (cfg.worker.enabled && !observable) {
    app.log.warn(
      'No funding rail has a transaction observation wired, so the settlement worker is not ' +
        'started. Requests stay "session_opened" rather than being concluded unobserved.',
    );
  }
  worker =
    cfg.worker.enabled && observable
      ? startWorker(
          funding,
          cfg.worker.interval_ms,
          wired,
          cfg.worker.session_max_age_ms,
          // Bound. `app.log.warn` detached from its logger throws `TypeError: Cannot read
          // properties of undefined (reading 'Symbol(pino.msgPrefix)')` at every real log level;
          // it only survives at `silent`, which is what the tests use. The worker's error handler
          // calls this sink, so an unbound one turned any tick error into an unhandled rejection
          // and took the process down, the exact outcome the handler exists to prevent.
          (message) => {
            server.log.warn(message);
          },
          undefined,
          undefined,
          // Retention. The worker already runs on a timer against this store, so the sweep lives
          // here rather than as a scheduled job outside the service: one fewer thing to deploy
          // and one fewer thing to forget.
          cfg.worker.refusal_retention_days,
        )
      : undefined;
  } catch (error) {
    // One guard, spanning everything between the store opening and the handle being returned.
    //
    // The store is connected and migrated before any of this, the port is open from `listen`
    // onward, and `start` rejects, so the caller never receives the `close` that would have tidied
    // either. Two separate guards were the first shape and the wrong one: the second was
    // unreachable from any config, so it was defensive code no test could exercise, and a
    // second cleanup path is a second thing to keep in step with this one.
    //
    // `app` is undefined only when `buildServer` itself threw, and then there is nothing to close.
    await app?.close();
    await funding.close();
    throw error;
  }

  return {
    app,
    close: async () => {
      // Order matters: stop advancing rows, stop accepting requests, then release the database.
      // The store was never closed at all, so its handle outlived the process's own shutdown,
      // in a service whose entire durability claim is that a restart resumes exactly where this
      // one stopped. Draining the pool also returns its CloudSQL connections promptly instead of
      // leaving the server to time them out.
      await worker?.stop();
      await app.close();
      await funding.close();
    },
  };
}

/**
 * Prove the credential before the port opens.
 *
 * Three outcomes, and the split between them is the design:
 *
 *   Meld answered with an error status: fatal. Any answer means the request arrived and
 *     was rejected: a wrong key, a wrong endpoint path, wrong parameters. None improve on their
 *     own, so the process stops rather than serving buyers with a credential that cannot work.
 *   Meld could not be reached: warn and continue. A transport failure says nothing about
 *     the configuration, and a transient Meld outage must not block a rollout.
 *   Meld answered, with no offers: warn and continue. It accepted the credential and understood
 *     the request, which is what this probe exists to prove. Zero offers is ambiguous between a
 *     corridor that is dry right now and a probe configured for a corridor Meld never serves,
 *     and only the second is a fault, so an ambiguous signal must not refuse the rollout.
 */
export async function verifyKey(
  meld: Pick<MeldClient, 'verifyCredentials'>,
  cfg: Config,
  log: FastifyBaseLogger,
): Promise<void> {
  const probe = cfg.meld.boot_probe;
  try {
    const offers = await meld.verifyCredentials({
      countryCode: probe.country_code,
      sourceCurrencyCode: probe.source_currency,
      destinationCurrencyCode: probe.destination_code,
      sourceAmount: probe.source_amount,
      paymentMethodType: probe.payment_method_type,
    });

    if (offers === 0) {
      log.warn(
        { probe: `${probe.source_currency}->${probe.destination_code} in ${probe.country_code}` },
        'Meld accepted the credentials but offered no quotes for the boot probe corridor. ' +
          'The key is proven; the probe corridor may not be one Meld serves.',
      );
      return;
    }

    log.info({ offers }, 'Meld credentials accepted.');
  } catch (error) {
    if (error instanceof MeldHttpError) throw error;
    log.warn({ detail: String(error) }, 'Could not reach Meld at boot; the key is unverified.');
  }
}

/**
 * The floor on the JWT signing key, in bytes of the mounted value.
 *
 * 32 is the HS256 output width: below it the MAC is weaker than the function it is built from,
 * and a captured token becomes an offline brute-force against the key that mints every other
 * one. HKDF expands this secret into two keys; it does not manufacture entropy for them.
 */
const JWT_KEY_MIN_BYTES = 32;

/**
 * Build the personhood handshake service from config.
 *
 * One JWT signing `Secret` is resolved, and two 32-byte keys are HKDF-derived from it under
 * separate labels (`onramp:challenge`, `onramp:jwt`). Deriving both from one Secret keeps the
 * secret count minimal while guaranteeing a challenge can never be replayed as a bearer token:
 * the two keys are unrelated to each other, and a challenge signed under one label verifies under
 * that label alone. The People-chain RPC client is built from the configured endpoint.
 */
export async function buildPersonhood(cfg: Config): Promise<PersonhoodService> {
  // The superRefine guarantees this is present whenever mode is `personhood`, which is the only
  // caller of this function. The check is cheap; the alternative is a `!` that outlives the config.
  const personhood = cfg.auth.personhood;
  if (personhood === undefined) throw new Error('auth.personhood is required in personhood mode.');
  const jwtSecret = await resolveSecret(personhood.jwt_key, {
    minBytes: JWT_KEY_MIN_BYTES,
    name: 'auth.personhood.jwt_key',
  });
  const challengeKey = new Uint8Array(hkdfSync('sha256', jwtSecret.expose(), Buffer.alloc(0), Buffer.from('onramp:challenge'), 32));
  const tokenKey = { secret: new Uint8Array(hkdfSync('sha256', jwtSecret.expose(), Buffer.alloc(0), Buffer.from('onramp:jwt'), 32)) };

  const reader = chainReader(personhood.people_rpc_url);
  const deps: PersonhoodDeps = {
    validate: validateWithCommitment,
    commitments: commitmentsFrom(reader, personhood.collections.length),
    challengeKey,
    tokenKey,
    challengeTtlMs: personhood.challenge_ttl_ms,
    tokenTtlSeconds: personhood.token_ttl_s,
    rings: personhood.collections.map((c) => ({ identifier: c.identifier, exponent: c.ring_exponent })),
    allowedProducts: cfg.allowed_products,
  };
  return new PersonhoodService(deps);
}
