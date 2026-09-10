import http from 'node:http';
import net from 'node:net';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { hkdfSync } from 'node:crypto';

import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { createSchema, dropOwnSchemas, liveBackends, openIn, storeConfigFor, storePassword } from './pg.js';
import type { FundingRecord } from '../src/funding/types.js';

import { MeldHttpError } from '../src/meld/client.js';
import { mintChallenge } from '../src/personhood/challenge.js';
import { mintToken } from '../src/personhood/token.js';
import { buildPersonhood, start, verifyKey } from '../src/startup.js';
import { upstreamUnavailable } from '../src/contract.js';
import type { Config } from '../src/config.js';
import { config, createRequest, fakeSocket, fundingRecord, personhoodConfig, rawConfig, withSocket } from './fixtures.js';

/** Just the two levels `verifyKey` uses, so a plain object substitutes for pino. */
const recorder = () => {
  const warn = vi.fn();
  const info = vi.fn();
  return { warn, info, log: { warn, info } as unknown as FastifyBaseLogger };
};

describe('verifyKey', () => {
  it('stops the process when Meld answers with an error status', async () => {
    // Any answer means the request arrived and was rejected: a wrong key, a wrong path, wrong
    // parameters. None of those improve on their own, so serving buyers would be worse than
    // refusing to start.
    const { log, warn } = recorder();
    const meld = { verifyCredentials: () => Promise.reject(new MeldHttpError(401)) };

    await expect(verifyKey(meld, config(), log)).rejects.toBeInstanceOf(MeldHttpError);
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns and continues when Meld cannot be reached', async () => {
    // A transport failure says nothing about the configuration, and a transient Meld outage
    // must not block a rollout.
    const { log, warn } = recorder();
    const meld = { verifyCredentials: () => Promise.reject(upstreamUnavailable('connect ECONNREFUSED')) };

    await expect(verifyKey(meld, config(), log)).resolves.toBeUndefined();
    expect(warn.mock.calls[0]?.[1]).toMatch(/could not reach meld/i);
    // The operator sees why: the detail is the transport reason, shaped for triage.
    expect(warn.mock.calls[0]?.[0]).toMatchObject({ detail: expect.stringContaining('connect ECONNREFUSED') });
  });

  it('warns and continues when Meld answers with no offers', async () => {
    // The key is proven: Meld accepted the credential and understood the request. Zero offers is
    // ambiguous between a dry corridor and a misconfigured probe, and only one is a fault.
    const { log, warn, info } = recorder();
    const meld = { verifyCredentials: () => Promise.resolve(0) };

    await expect(verifyKey(meld, config(), log)).resolves.toBeUndefined();
    expect(warn.mock.calls[0]?.[1]).toMatch(/offered no quotes/i);
    expect(warn.mock.calls[0]?.[1]).toContain('The key is proven; the probe corridor may not be one Meld serves.');
    expect(warn.mock.calls[0]?.[0]).toMatchObject({ probe: 'USD->USDC_ASSETHUB in US' });
    expect(info).not.toHaveBeenCalled();
  });

  it('reports the offer count when the probe corridor is served', async () => {
    const { log, warn, info } = recorder();
    const verifyCredentials = vi.fn<
  (params: {
    countryCode: string;
    sourceCurrencyCode: string;
    destinationCurrencyCode: string;
    sourceAmount: string;
    paymentMethodType: string;
  }) => Promise<number>
>((_params) => Promise.resolve(3));
    const meld = { verifyCredentials };

    await verifyKey(meld, config(), log);
    expect(info).toHaveBeenCalledWith({ offers: 3 }, 'Meld credentials accepted.');
    expect(warn).not.toHaveBeenCalled();

    // The probe is sent verbatim: the params Meld must answer to prove the key.
    const params = verifyCredentials.mock.calls[0]?.[0];
    expect(params).toMatchObject({
      countryCode: 'US',
      sourceCurrencyCode: 'USD',
      destinationCurrencyCode: 'USDC_ASSETHUB',
      sourceAmount: '20',
      paymentMethodType: 'CREDIT_DEBIT_CARD',
    });
  });
});

/** One `session_opened` row, so a tick has something to observe. */
const inFlightRecord = (): FundingRecord =>
  fundingRecord({ id: 'funding-boot-1', subject_alias: 'dev:app.dot', wallet_address: '1x...' });

describe('start', () => {
  let dir: string;
  let handle: { app: FastifyInstance; close: () => Promise<void> } | undefined;
  let meld: http.Server | undefined;
  /** How many requests the fake Meld received, so a test can assert it received none. */
  let meldRequests = 0;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'onramp-startup-'));
  });

  afterAll(async () => {
  // Every schema this process minted, including the ones handed to a child.
  await dropOwnSchemas();
});

afterEach(async () => {
    await handle?.close();
    handle = undefined;
    meld?.close();
    meld = undefined;
    meldRequests = 0;
  });

  /**
   * The schema requires a real port, so derive a stable one from the worker rather than guessing:
   * two suites binding the same number would fail for a reason unrelated to boot.
   */
  const BOOT_PORT = 20000 + (process.pid % 10000);

  /** Does anything accept a TCP connection there right now? */
  const accepts = (port: number) =>
    new Promise<boolean>((resolve) => {
      const socket = net.connect({ port, host: '127.0.0.1' });
      const settle = (open: boolean) => {
        socket.destroy();
        resolve(open);
      };
      socket.once('connect', () => {
        settle(true);
      });
      socket.once('error', () => {
        settle(false);
      });
    });

  /** A fake Meld that answers the boot probe, so `start` reaches `listen`. */
  const fakeMeld = async (body: unknown, status = 200, duringProbe?: () => Promise<void>) => {
    const server = http.createServer((_req, res) => {
      meldRequests += 1;
      void (async () => {
        await duringProbe?.();
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      })();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    meld = server;
    const address = server.address();
    return `http://127.0.0.1:${String(typeof address === 'object' && address ? address.port : 0)}`;
  };

  const writeConfig = async (name: string, baseUrl: string) => {
    const keyPath = join(dir, `${name}.key`);
    // 32 bytes minimum: the JWT key is HKDF-expanded into two derived keys and boot refuses a
    // short one rather than run the personhood gate brute-forceable.
    await writeFile(keyPath, 'a-thirty-two-byte-or-longer-test-signing-key\n');

    // Every booted config gets its own Postgres schema: `start()` opens a real store before the
    // port, so these cannot run against a fixture that merely typechecks.
    const raw = rawConfig({
      environment: 'development',
      store: storeConfigFor(await createSchema()),
      server: { port: 0, host: '127.0.0.1', log_level: 'info' },
      meld: {
        ...(rawConfig().meld as Record<string, unknown>),
        base_url: baseUrl,
        api_key: { mode: 'file', path: keyPath },
      },
    });
    (raw.server as Record<string, unknown>).port = BOOT_PORT;

    const path = join(dir, `${name}.json`);
    await writeFile(path, JSON.stringify(raw));
    return path;
  };

  /** Point a written config's worker and store at a test database, leaving the rest alone. */
  const patchConfig = async (path: string, worker: Record<string, unknown>, schema: string) => {
    const raw = JSON.parse(await readFile(path, 'utf8')) as {
      worker: Record<string, unknown>;
      store: Record<string, unknown>;
    };
    Object.assign(raw.worker, worker);
    raw.store = storeConfigFor(schema);
    await writeFile(path, JSON.stringify(raw));
  };

  it('proves the credential, then opens the port', async () => {
    // The claim is an ordering, and neither end of the boot can show it: a rejected credential
    // never listens whatever the order, and a successful boot ends up listening either way. The
    // only instant that distinguishes them is while `verifyKey` is in flight, so the fake Meld
    // probes the port from inside the request it is answering. Swap the two calls in `startup.ts`
    // and the port is already accepting connections here, which is the defect. Buyers would reach
    // an instance whose Meld credential had not been proven.
    let acceptingDuringProbe: boolean | undefined;
    const baseUrl = await fakeMeld({ quotes: [] }, 200, async () => {
      acceptingDuringProbe = await accepts(BOOT_PORT);
    });
    const path = await writeConfig('ok', baseUrl);

    const started = await start(path);
    handle = started;

    expect(acceptingDuringProbe).toBe(false);
    // And open afterwards, so the `false` above is ordering rather than a port that never bound.
    expect(await accepts(BOOT_PORT)).toBe(true);
    expect((await started.app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
  });

  it('announces that callers are unverified when auth.mode is insecure_dev', async () => {
    // The operator's only signal that this instance verifies nobody. Configuration refuses this
    // mode in production, so the warning is what covers development and sandbox. Every mutant
    // on it survived while nothing read the log.
    const baseUrl = await fakeMeld({ quotes: [] });
    const path = await writeConfig('warns', baseUrl);
    const lines: string[] = [];

    handle = await start(path, { write: (line) => lines.push(line) });

    const logged = lines.join('');
    expect(logged).toContain('callers are NOT verified');
    expect(logged).toContain('insecure_dev');
    expect(logged).toContain('development');
    expect(logged).toContain('Never use this outside development.');
    // The warning is shaped for an operator: the environment is in the structured log line, not
    // just the message, so a dashboard can route on it.
    expect(logged).toContain('"environment":"development"');
  });

  it('warns when the origin allowlist is empty outside development', async () => {
    // Empty is the shipped default and the right default: it fails closed. It is the wrong thing
    // to deploy silently. This service is browser-facing, so an empty list refuses every preflight
    // and every `redirectUrl`, and the SPA sees a network-shaped failure with nothing naming the
    // cause. The operator learns from a browser console instead of from the service.
    const baseUrl = await fakeMeld({ quotes: [] });
    const path = await writeConfig('cors-empty', baseUrl);
    const written = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;

    const jwtPath = join(dir, 'cors-empty-jwt.key');
    const pgPath = join(dir, 'cors-empty-pg.key');
    // 32 bytes minimum: the JWT key is HKDF-expanded and boot refuses a short one.
    await writeFile(jwtPath, 'a-thirty-two-byte-or-longer-test-signing-key\n');
    // The real database password, from a file. `sandbox` refuses `mode: env`, and the store is
    // opened before this warning is reached, so a store that cannot authenticate preempts the
    // thing under test. Locally that was invisible because Postgres uses trust auth; CI enforces a
    // password and the test failed there with an empty log. Asserting only
    // `rejects.toThrow()`, which an unrelated failure satisfies.
    await writeFile(pgPath, `${storePassword()}\n`);

    const raw = personhoodConfig({
      environment: 'sandbox',
      server: written.server,
      // `127.0.0.1`, not the harness's `localhost`: a name a resolver decides is deliberately not
      // exempt from the plaintext refusal, and this hop is genuinely loopback in both places.
      store: { ...(written.store as Record<string, unknown>), host: '127.0.0.1', ssl: false, password: { mode: 'file', path: pgPath } },
      cors: { allowed_origins: [] },
      // `sandbox` pins the Meld host, so this reaches the real sandbox with a fake key. Whether
      // that answers (fatal) or times out (a warning, and boot continues) depends on the network,
      // which is why this test does not assert the boot outcome, only that the warning is emitted
      // while the config is being acted on, before anything downstream can swallow it.
      meld: { ...(written.meld as Record<string, unknown>), base_url: 'https://api-sb.meld.io', api_key: { mode: 'file', path: jwtPath } },
    });
    (raw.auth as unknown as { personhood: Record<string, unknown> }).personhood.jwt_key = { mode: 'file', path: jwtPath };
    await writeFile(path, JSON.stringify(raw));
    const lines: string[] = [];

    handle = await start(path, { write: (line) => lines.push(line) }).catch(() => undefined);

    const logged = lines.join('');
    expect(logged).toContain('cors.allowed_origins is empty');
    expect(logged).toContain('redirectUrl will be refused');
    expect(logged).toContain('"environment":"sandbox"');
  }, 20_000);

  it('stays quiet about the origin allowlist when it is populated', async () => {
    // The other half: a warning that always fires is a warning nobody reads.
    const baseUrl = await fakeMeld({ quotes: [] });
    const path = await writeConfig('cors-set', baseUrl);
    const raw = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    raw.cors = { allowed_origins: ['https://app.example'] };
    await writeFile(path, JSON.stringify(raw));
    const lines: string[] = [];

    handle = await start(path, { write: (line) => lines.push(line) });

    expect(lines.join('')).not.toContain('cors.allowed_origins is empty');
  }, 15_000);

  it('never opens the port when the credential is rejected', async () => {
    // The name is about the port, and the rejection alone does not show anything about it: a
    // build that listened first and then proved the key would reject exactly the same way. So
    // the fake probes the port from inside the request it is about to refuse, and the port is
    // probed again afterwards. A boot that failed must leave nothing bound behind it either.
    let acceptingDuringProbe: boolean | undefined;
    const baseUrl = await fakeMeld({ error: 'Unauthorized' }, 401, async () => {
      acceptingDuringProbe = await accepts(BOOT_PORT);
    });
    const path = await writeConfig('rejected', baseUrl);

    await expect(start(path)).rejects.toBeInstanceOf(MeldHttpError);
    expect(acceptingDuringProbe).toBe(false);
    expect(await accepts(BOOT_PORT)).toBe(false);
  });

  it('closes the store when boot fails, so a crash-loop does not leak connections', async () => {
    // `FundingStore.open()` connects, takes the migration lock and migrates before anything else
    // can fail. A boot that then rejects must hand the pool back, or a crash-loop leaks one
    // CloudSQL connection per attempt.
    //
    // Driven through a rejected credential, which is a reachable boot failure. A version
    // used a malformed `trusted_proxy_cidrs` to trip `buildServer`, and then the config validation
    // was tightened to catch exactly that value, so the boot began failing at config load, before
    // the store was ever opened, and the test passed while proving nothing.
    //
    // Counted through `pg_stat_activity`: the advisory lock is released with its transaction rather
    // than with the pool, so it cannot stand in for this.
    const schema = await createSchema();
    const baseUrl = await fakeMeld({ error: 'Unauthorized' }, 401);
    const path = await writeConfig('leak', baseUrl);
    const raw = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    raw.store = storeConfigFor(schema);
    await writeFile(path, JSON.stringify(raw));

    await expect(start(path)).rejects.toBeInstanceOf(MeldHttpError);

    expect(await liveBackends(schema)).toBe(0);
  }, 30_000);

  it('registers the chainflip rail, which refuses rather than opening a session', async () => {
    // Replaces a test that flipped a config flag and asserted `/health` was 200. There is no
    // flag any more: the rail is always registered and always refuses, so the caller gets the
    // real reason ("no fiat leg") instead of "rail not wired".
    const baseUrl = await fakeMeld({ quotes: [] });
    handle = await start(await writeConfig('chainflip', baseUrl));

    const response = await handle.app.inject({
      method: 'POST',
      url: '/session',
      headers: { 'x-dev-product-id': 'app.dot' },
      payload: createRequest({ rail: 'chainflip' }),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.value.code).toBe('RAIL_REFUSED');
  });

  it('gives the worker the configured retention window, and it actually sweeps', async () => {
    // `refusal_retention_days` is read in `startup` and used in `worker`, and every test of the
    // sweep built its own `Retention` object, so the argument could be replaced with `undefined`
    // and the suite stayed green. Retention would then be dead config: refusals accumulating for
    // ever on an autogrowing instance that nothing else prunes, which is the outcome the feature
    // exists to prevent.
    const baseUrl = await fakeMeld({ quotes: [] });
    const path = await writeConfig('retention', baseUrl);
    const raw = JSON.parse(await readFile(path, 'utf8')) as { worker: Record<string, unknown>; store: unknown };
    raw.worker.enabled = true;
    raw.worker.interval_ms = 1_000;
    raw.worker.refusal_retention_days = 1;
    const schema = await createSchema();
    raw.store = storeConfigFor(schema);
    await writeFile(path, JSON.stringify(raw));

    const seed = await openIn(schema);
    // Two days old, against a one-day window.
    await seed.create(
      fundingRecord({ id: 'ancient', status: 'refused', client_reference: undefined, created_at: Date.now() - 2 * 86_400_000 }),
    );
    await seed.create(fundingRecord({ id: 'fresh', status: 'refused', client_reference: undefined, created_at: Date.now() }));
    await seed.close();

    handle = await start(path, { write: () => undefined }, {
      meld: { finder: async () => undefined, mapper: () => 'transaction_seen' },
    });

    const after = await openIn(schema);
    await vi.waitFor(
      async () => {
        expect(await after.byId('ancient')).toBeUndefined();
      },
      { timeout: 6_000 },
    );
    // And it swept only what was past the window.
    expect(await after.byId('fresh')).toBeDefined();
    await after.close();
  }, 20_000);

  it('gives the worker the configured observation window, not a constant', async () => {
    // `session_max_age_ms` sits one argument away from `interval_ms` in the same call. Mutating
    // `interval_ms` is caught; mutating this one to `1` was not. At `1` every in-flight
    // request is past its deadline on the first tick and concludes terminally, on the strength of
    // a hard-coded number rather than the operator's.
    const baseUrl = await fakeMeld({ quotes: [] });
    const path = await writeConfig('window', baseUrl);
    const raw = JSON.parse(await readFile(path, 'utf8')) as { worker: Record<string, unknown>; store: unknown };
    raw.worker.enabled = true;
    raw.worker.interval_ms = 1_000;
    // Generous: nothing seeded here should be able to age out during the test.
    raw.worker.session_max_age_ms = 86_400_000;
    const schema = await createSchema();
    raw.store = storeConfigFor(schema);
    await writeFile(path, JSON.stringify(raw));

    const seed = await openIn(schema);
    // Created now, and with no rail deadline of its own, so `session_max_age_ms` is the only
    // thing that could conclude it, which is what this test is about.
    await seed.create({ ...inFlightRecord(), created_at: Date.now(), expires_at: undefined });
    await seed.close();

    const finder = vi.fn(async () => undefined);
    handle = await start(path, { write: () => undefined }, {
      meld: { finder, mapper: () => 'transaction_seen' },
    });
    await vi.waitFor(() => {
      expect(finder.mock.calls.length).toBeGreaterThan(0);
    }, { timeout: 6_000 });

    // Still in flight: a row inside its window is asked about, never concluded.
    const after = await openIn(schema);
    expect((await after.byId(inFlightRecord().id))?.status).toBe('session_opened');
    await after.close();
  }, 20_000);

  it('runs the worker when a rail can be observed, and tears it down on close', async () => {
    // The old version of this asserted `handle.app` was defined and `close()` resolved: both
    // true whatever the worker does. It passed while the worker could not start at all.
    const baseUrl = await fakeMeld({ quotes: [] });
    const path = await writeConfig('worker', baseUrl);
    const raw = JSON.parse(await readFile(path, 'utf8')) as {
      worker: Record<string, unknown>;
      store: Record<string, unknown>;
    };
    raw.worker.enabled = true;
    raw.worker.interval_ms = 1_000;
    // A file, not `:memory:`, so the record seeded below is the one the worker opens.
    const dbPath = await createSchema();
    raw.store = storeConfigFor(dbPath);
    await writeFile(path, JSON.stringify(raw));

    // The tick iterates in-flight rows; with none there is nothing to ask a finder about, so an
    // "is the worker running" assertion needs a record to run over.
    const seed = await openIn(dbPath);
    await seed.create(inFlightRecord());
    await seed.close();

    const finder = vi.fn(async () => undefined);
    const lines: string[] = [];
    handle = await start(path, { write: (line) => lines.push(line) }, {
      meld: { finder, mapper: () => 'transaction_seen' },
    });
    // The loop is live: it ticks, and the finder it was given is the one it asks.
    await vi.waitFor(() => {
      expect(finder.mock.calls.length).toBeGreaterThan(0);
    }, { timeout: 4_000 });

    const before = finder.mock.calls.length;
    const linesAtClose = lines.length;
    await handle.close();
    handle = undefined;
    // And it is genuinely stopped, which a resolved `close()` does not show. The finder count
    // alone does not show it either: `close()` also shuts the store, so `listInFlight` throws
    // before a still-running tick ever reaches the finder; the assertion would hold with
    // `worker.stop()` deleted. What only a stopped interval gives is silence: a live one keeps
    // ticking into a closed database and logs `database is not open` through a closed logger,
    // for ever.
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect(finder.mock.calls.length).toBe(before);
    expect(lines.slice(linesAtClose).filter((line) => line.includes('funding worker'))).toEqual([]);
  }, 15_000);

  it('honours worker.enabled: false even when a rail can be observed', async () => {
    // The flag is the operator's kill switch. Nothing asserted it reached the decision, so a
    // worker that ignored it and ran on `observable` alone looked identical from every test.
    const baseUrl = await fakeMeld({ quotes: [] });
    const path = await writeConfig('worker-off', baseUrl);
    const dbPath = await createSchema();
    await patchConfig(path, { enabled: false, interval_ms: 1_000 }, dbPath);

    const seed = await openIn(dbPath);
    await seed.create(inFlightRecord());
    await seed.close();

    const finder = vi.fn(async () => undefined);
    handle = await start(path, undefined, { meld: { finder, mapper: () => 'transaction_seen' } });

    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect(finder).not.toHaveBeenCalled();
  }, 15_000);

  it('gives the worker the configured observation window, not a built-in one', async () => {
    // `session_max_age_ms` is how long a request keeps being watched for a payment before it is
    // written off as `expired` (terminal, and wrong is unrecoverable). The worker's own tests
    // pass the window directly, so nothing showed the configured value arriving: an operator
    // choosing a minute would silently get whatever the default happened to be.
    const baseUrl = await fakeMeld({ quotes: [] });
    const path = await writeConfig('worker-window', baseUrl);
    const dbPath = await createSchema();
    await patchConfig(path, { enabled: true, interval_ms: 1_000, session_max_age_ms: 60_000 }, dbPath);

    // Two minutes old with no rail expiry: past a sixty-second window, far inside a day-long one.
    const opened = Date.now() - 120_000;
    const seed = await openIn(dbPath);
    await seed.create({ ...inFlightRecord(), created_at: opened, updated_at: opened, expires_at: undefined });
    await seed.close();

    handle = await start(path, undefined, {
      meld: { finder: async () => undefined, mapper: () => 'transaction_seen' },
    });

    await vi.waitFor(
      async () => {
        const store = await openIn(dbPath);
        const status = (await store.byId('funding-boot-1'))?.status;
        await store.close();
        expect(status).toBe('expired');
      },
      { timeout: 6_000 },
    );
  }, 15_000);

  it('does not start the worker when boot fails on the credential', async () => {
    // Constructed before `verifyKey` and before the port opens, a boot
    // that then failed left a loop advancing durable funding rows with no handle to stop it:
    // `start` rejects, so the caller never receives a `close`.
    const baseUrl = await fakeMeld({ message: 'nope' }, 401);
    const path = await writeConfig('worker-badkey', baseUrl);
    const raw = JSON.parse(await readFile(path, 'utf8')) as {
      worker: Record<string, unknown>;
      store: Record<string, unknown>;
    };
    raw.worker.enabled = true;
    raw.worker.interval_ms = 1_000;
    const dbPath = await createSchema();
    raw.store = storeConfigFor(dbPath);
    await writeFile(path, JSON.stringify(raw));

    const seed = await openIn(dbPath);
    await seed.create(inFlightRecord());
    await seed.close();

    const finder = vi.fn(async () => undefined);
    await expect(start(path, undefined, { meld: { finder, mapper: () => 'transaction_seen' } })).rejects.toThrow();

    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(finder).not.toHaveBeenCalled();

    // And the pool went with it. A failed boot returns no `close()`, so anything it opened is
    // leaked for the life of the process; in a crash loop that is a pool's worth of CloudSQL
    // connections per attempt, against an instance with a hard connection ceiling. The backends
    // are identified by `application_name`, which the pool sets for exactly this.
    expect(await liveBackends(dbPath)).toBe(0);
  }, 15_000);

  it('reports a worker failure through the app logger, bound', async () => {
    // `app.log.warn` passed detached throws at every real log level and survives only at
    // `silent`, which is what the fixtures use, so the suite could not see it. This drives a
    // finder failure through a live worker at `log_level: info`, which is the only way to
    // execute the binding the fix introduced.
    const baseUrl = await fakeMeld({ quotes: [] });
    const path = await writeConfig('worker-logs', baseUrl);
    const raw = JSON.parse(await readFile(path, 'utf8')) as {
      worker: Record<string, unknown>;
      store: Record<string, unknown>;
    };
    raw.worker.enabled = true;
    raw.worker.interval_ms = 1_000;
    const dbPath = await createSchema();
    raw.store = storeConfigFor(dbPath);
    await writeFile(path, JSON.stringify(raw));

    // Created just now, so the record is still inside its observation window. Past the window a
    // finder failure is a conclusion (`unobserved`) rather than an error, so a stale fixture would
    // silently stop exercising the logger this test exists for.
    const seed = await openIn(dbPath);
    const now = Date.now();
    await seed.create({ ...inFlightRecord(), created_at: now, updated_at: now });
    await seed.close();

    const lines: string[] = [];
    handle = await start(path, { write: (line) => lines.push(line) }, {
      meld: {
        finder: () => Promise.reject(new Error('rail unreachable')),
        mapper: () => 'transaction_seen',
      },
    });

    await vi.waitFor(() => {
      expect(lines.join(' ')).toContain('rail unreachable');
    }, { timeout: 5_000 });
  }, 15_000);

  it('does not run the worker when no rail can be observed', async () => {
    // The honest default today. A worker with nothing to observe does not sit idle: it falls
    // through to the expiry branch and marks unseen purchases `expired`.
    const baseUrl = await fakeMeld({ quotes: [] });
    const path = await writeConfig('worker-unobservable', baseUrl);
    const raw = JSON.parse(await readFile(path, 'utf8')) as { worker: Record<string, unknown> };
    raw.worker.enabled = true;
    raw.worker.interval_ms = 1_000;
    await writeFile(path, JSON.stringify(raw));

    const lines: string[] = [];
    // An explicitly empty registry: Meld is observable by default now, so "no rail can be
    // observed" has to be asked for rather than being the state of the world.
    handle = await start(path, { write: (line) => lines.push(line) }, {});
    await new Promise((resolve) => setTimeout(resolve, 1_500));

    expect(lines.join(' ')).toContain('settlement worker is not');
  }, 15_000);

  it('fails before any Meld call when the secret file is missing', async () => {
    const baseUrl = await fakeMeld({ quotes: [] });
    const path = await writeConfig('nokey', baseUrl);
    const broken = JSON.parse(await readFile(path, 'utf8')) as { meld: { api_key: { path: string } } };
    broken.meld.api_key.path = join(dir, 'definitely-absent');
    const brokenPath = join(dir, 'nokey-broken.json');
    await writeFile(brokenPath, JSON.stringify(broken));

    await expect(start(brokenPath)).rejects.toThrow(/Cannot read secret file/);
    // "before any Meld call" was the whole claim and nothing showed it: the throw alone happens
    // whatever the ordering. A missing mount must be found before this process speaks to Meld at
    // all. An unauthenticated or half-authenticated call to a payments API is not something to
    // make on the way to reporting a configuration fault.
    expect(meldRequests).toBe(0);
  });

  it('boots in personhood mode and serves the handshake', async () => {
    // The personhood RPC is read lazily on `/redeem`, so boot never opens a socket. The probe
    // still runs, proving the Meld leg; then the handshake routes exist because personhood was
    // wired through buildServer.
    const baseUrl = await fakeMeld({ quotes: [] });
    const keyPath = join(dir, 'personhood.key');
    await writeFile(keyPath, 'personhood-boot-key\n');
    // A separate file, as the deployment mounts them: two distinct secrets, and the JWT signing
    // key must clear the 32-byte floor `buildPersonhood` enforces.
    const jwtKeyPath = join(dir, 'personhood-jwt.key');
    await writeFile(jwtKeyPath, 'a-thirty-two-byte-or-longer-test-signing-key\n');

    const raw = personhoodConfig({
      environment: 'development',
      store: storeConfigFor(await createSchema()),
      server: { port: 0, host: '127.0.0.1', log_level: 'info' },
      meld: {
        ...(rawConfig().meld as Record<string, unknown>),
        base_url: baseUrl,
        api_key: { mode: 'file', path: keyPath },
      },
      auth: {
        mode: 'personhood',
        personhood: {
          // Reconstruct the personhood block, overriding only the key source.
          ...((personhoodConfig() as { auth: { personhood?: Record<string, unknown> } }).auth.personhood ?? {}),
          jwt_key: { mode: 'file', path: jwtKeyPath },
        },
      },
    });
    (raw.server as Record<string, unknown>).port = 20000 + (process.pid % 10000);
    const path = join(dir, 'personhood.json');
    await writeFile(path, JSON.stringify(raw));

    const lines: string[] = [];
    // An explicitly empty registry: Meld is observable by default now, so "no rail can be
    // observed" has to be asked for rather than being the state of the world.
    handle = await start(path, { write: (line) => lines.push(line) }, {});
    expect((await handle.app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    // The handshake routes exist only when personhood is wired through.
    expect((await handle.app.inject({ method: 'POST', url: '/api/v1/auth/challenge' })).statusCode).toBe(200);
    // The unverified-caller warning is for insecure_dev only; verifying instances stay silent.
    expect(lines.join('')).not.toContain('callers are NOT verified');
  });

  it('refuses to boot in personhood mode without the personhood block', async () => {
    const baseUrl = await fakeMeld({ quotes: [] });
    const path = await writeConfig('nopersonhood', baseUrl);
    const raw = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    raw.auth = { mode: 'personhood' }; // stub out the block entirely
    const brokenPath = join(dir, 'nopersonhood-broken.json');
    await writeFile(brokenPath, JSON.stringify(raw));

    await expect(start(brokenPath)).rejects.toThrow(/auth\.personhood is required/);
  });

  it('hands Fastify the configured request and connection timeouts', async () => {
    // `server.request_timeout_ms` is documented as the outer bound on a whole request (what
    // stops a slow or half-open client holding a connection open indefinitely), and nothing
    // asserted the number reached the server. Replacing either with a constant was invisible,
    // so an operator who tightened the bound got whatever the constant happened to be.
    const baseUrl = await fakeMeld({ quotes: [] });
    const path = await writeConfig('timeouts', baseUrl);
    const raw = JSON.parse(await readFile(path, 'utf8')) as { server: Record<string, unknown> };
    // Deliberately not the schema default of 20 000: a test that asserts the default cannot tell
    // a wired-through value from a hard-coded one.
    raw.server.request_timeout_ms = 11_000;
    await writeFile(path, JSON.stringify(raw));

    handle = await start(path);

    // Read off the Node server Fastify built, which is where the bound actually takes effect;
    // no socket has to be held open to observe it.
    expect(handle.app.server.requestTimeout).toBe(11_000);
    // `timeout` is what Fastify's `connectionTimeout` sets: the socket that never manages to
    // send a complete request at all.
    expect(handle.app.server.timeout).toBe(11_000);
  });

  it('refuses to boot when the JWT signing key is shorter than the required floor', async () => {
    // 32 bytes is the HS256 output width. Below it the MAC is weaker than the function it is
    // built from, and a single captured token becomes an offline brute force against the key
    // that mints every other one. HKDF expands this secret into the challenge MAC key and the
    // token key; it manufactures no entropy for either. `jose` will happily sign with one byte,
    // so nothing else in the stack objects.
    const baseUrl = await fakeMeld({ quotes: [] });
    const keyPath = join(dir, 'shortjwt-meld.key');
    // 32 bytes minimum: the JWT key is HKDF-expanded into two derived keys and boot refuses a
    // short one rather than run the personhood gate brute-forceable.
    await writeFile(keyPath, 'a-thirty-two-byte-or-longer-test-signing-key\n');
    const shortKeyPath = join(dir, 'shortjwt.key');
    const shortKey = 'too-short';
    await writeFile(shortKeyPath, `${shortKey}\n`);

    const raw = personhoodConfig({
      environment: 'development',
      store: storeConfigFor(await createSchema()),
      server: { port: BOOT_PORT, host: '127.0.0.1', log_level: 'info' },
      meld: {
        ...(rawConfig().meld as Record<string, unknown>),
        base_url: baseUrl,
        api_key: { mode: 'file', path: keyPath },
      },
      auth: {
        mode: 'personhood',
        personhood: {
          ...((personhoodConfig() as { auth: { personhood?: Record<string, unknown> } }).auth.personhood ?? {}),
          jwt_key: { mode: 'file', path: shortKeyPath },
        },
      },
    });
    const path = join(dir, 'shortjwt.json');
    await writeFile(path, JSON.stringify(raw));

    let error: Error | undefined;
    try {
      handle = await start(path);
    } catch (cause) {
      error = cause as Error;
    }

    expect(error).toBeInstanceOf(Error);
    // The message names the field, the requirement and how to satisfy it: an operator reading a
    // crash loop should not have to find this file to learn what "too short" meant.
    expect(error?.message).toContain('auth.personhood.jwt_key');
    expect(error?.message).toContain('32 bytes');
    expect(error?.message).toContain('openssl rand -base64 32');
    // And never the value itself. This message goes to stderr on a failed boot, which is the one
    // place a short secret would be most tempting to print and most damaging to.
    expect(error?.message).not.toContain(shortKey);
    // The port stayed shut: a process that will not serve must not accept a connection either.
    expect(await accepts(BOOT_PORT)).toBe(false);
  });

  it('buildPersonhood refuses to run without the personhood block', async () => {
    // `parseConfig` already blocks a personhood-mode config that lacks the block, so this path
    // cannot arrive through `start`. It is the guard's own contract: however the service is
    // built, personhood mode without the block refuses. Forge the impossible parse output.
    const forged = {
      ...config(personhoodConfig()),
      auth: { mode: 'personhood' as const },
    } as unknown as Config;
    await expect(buildPersonhood(forged)).rejects.toThrow(
      /auth\.personhood is required in personhood mode/,
    );
  });
});

describe('buildPersonhood key derivation', () => {
  /**
   * One mounted secret, two keys, and the labels are the entire reason that is safe.
   *
   * `POST /api/v1/auth/challenge` is public and unauthenticated, and it returns an HMAC over
   * bytes the server chose under the challenge key. If that key were the JWT signing key, the
   * route would be an oracle for the key that mints every bearer token on the service. The two
   * are unrelated only because HKDF is given a different `info` label for each. Nothing
   * asserted that, so changing `onramp:jwt` to `onramp:challenge`, which makes the two keys
   * identical, left the whole suite green.
   */
  const SECRET = 'a-thirty-two-byte-or-longer-test-signing-key';
  const PRODUCT = 'app.dot';

  /** Exactly what `buildPersonhood` does, so the labels are the only variable. */
  const derive = (label: string) =>
    new Uint8Array(hkdfSync('sha256', SECRET, Buffer.alloc(0), Buffer.from(label), 32));

  const wire = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');

  beforeAll(() => {
    process.env.TEST_PH_KEY = SECRET;
  });

  // `development`, because these tests resolve the secret from an environment variable and
  // `mode: 'env'` is refused anywhere else: the value would be readable from the process table.
  // The environment is irrelevant to what is under test here, which is HKDF label separation.
  const service = async () =>
    buildPersonhood(
      config(
        personhoodConfig({
          environment: 'development',
          meld: { ...(rawConfig().meld as Record<string, unknown>), api_key: { mode: 'env', var: 'TEST_KEY' } },
          auth: {
            mode: 'personhood',
            personhood: {
              jwt_key: { mode: 'env', var: 'TEST_PH_KEY' },
              people_rpc_url: 'wss://127.0.0.1:9944',
              collections: [{ identifier: `0x${'11'.repeat(32)}`, ring_exponent: 9 }],
              challenge_ttl_ms: 60_000,
              token_ttl_s: 300,
            },
          },
        }),
      ),
    );

  it('binds the real ring-VRF verifier, so a proof that does not open is refused', async () => {
    // The blocker this test exists for: nothing asserted that `buildPersonhood` binds the real
    // verifier. Every other personhood test injects its own `validate`, and replacing
    // `validate: validateWithCommitment` in `startup.ts` with `() => new Uint8Array(32)` (accept
    // every proof, hand every caller the same alias) left all 861 tests green. The e2e suite
    // cannot catch it either. It points `people_rpc_url` at `.invalid`, so redeem degrades at the
    // chain read before `validate` is ever reached.
    //
    // So this drives `buildPersonhood`'s own service all the way to the verifier: a real challenge
    // under the real challenge key, an allowed product, and a stubbed People chain that answers
    // with a well-formed `Members.Root`. What arrives at the verifier is three bytes of garbage.
    // The real one refuses it; the stub above would mint a token.
    const built = await service();

    const socket = fakeSocket();
    const redeem = withSocket(socket, () =>
      built.redeem({
        challenge: wire(mintChallenge(derive('onramp:challenge'))),
        proof: wire(new Uint8Array([1, 2, 3])),
        ring: 0,
        productId: PRODUCT,
      }),
    );
    socket.emit('open', {});
    await vi.waitFor(() => {
      expect(socket.sent.length).toBe(1);
    });
    const request = JSON.parse(socket.sent[0] as string) as { id: number; params: string[] };
    // A `Root` long enough to clear the 768-byte commitment floor, so the refusal below comes from
    // the proof check and not from the shape guard in `source.ts`.
    socket.emit('message', {
      data: JSON.stringify({ jsonrpc: '2.0', id: request.id, result: `0x${'00'.repeat(1024)}` }),
    });

    // Rejected, and specifically as a membership failure rather than a chain error, which is what a
    // broken stub would produce and would pass a looser matcher.
    await expect(redeem).rejects.toThrow(/membership proof rejected/);

    // And the storage key the service asked for is derived from the configured collection
    // identifier. Hardcoding `identifier` in `startup.ts` also survived the suite.
    expect(request.params[0]).toContain('11'.repeat(8));
  });

  // NOTE (2026-09-01): the personhood TTLs (challenge_ttl_ms / token_ttl_s) are not asserted at
  // non-default values here. The wiring is correct in code (startup.ts:311-312, personhood.ts:82,129
  // all use the configured deps), but proving it through `redeem` needs a socket-stubbed chain read
  // that mints a real token, and the fakeSocket cannot produce a genuine ring-VRF proof, so the
  // TTL/exponent wiring is only observable against a live People chain. Both are therefore defended
  // by construction rather than by a test.

  it('signs tokens with the jwt-labelled key and refuses one signed with the challenge key', async () => {
    const built = await service();

    // The positive half: a token minted under `onramp:jwt` is this service's own token.
    const mine = await mintToken({ secret: derive('onramp:jwt') }, '0xada', PRODUCT, 300);
    await expect(built.verify(mine)).resolves.toEqual({ subject: '0xada', productId: PRODUCT });

    // The half that matters. A token signed with the challenge key must be a forgery, which
    // it only is while the two keys differ. Collapse the labels and this token verifies, and
    // then anyone who can call the public challenge route can mint a bearer token for any alias
    // and any allowed product.
    const forged = await mintToken({ secret: derive('onramp:challenge') }, '0xmallory', PRODUCT, 300);
    await expect(built.verify(forged)).rejects.toThrow(/token rejected/);
  });

  it('accepts a challenge minted under the challenge label and refuses one minted under the jwt label', async () => {
    const built = await service();
    const redeem = (challengeKey: Uint8Array) =>
      built.redeem({
        challenge: wire(mintChallenge(challengeKey)),
        proof: wire(new Uint8Array([1, 2, 3])),
        ring: 0,
        // Deliberately not an allowed product: the allowlist check is the next step after the
        // challenge MAC, so this refusal is proof the challenge itself verified, and it stops
        // the call before the People-chain read, which has no node behind it here.
        productId: 'not-allowed.dot',
      });

    await expect(redeem(derive('onramp:challenge'))).rejects.toThrow(/is not authorized on this instance/);
    await expect(redeem(derive('onramp:jwt'))).rejects.toThrow(/challenge rejected/);
  });
});
