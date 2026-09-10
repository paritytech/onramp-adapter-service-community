/**
 * End-to-end: the built artifact, run as a real process, over a real socket.
 *
 * Every other test in this repo runs the service in-process through `app.inject`. That covers the
 * routes and misses everything around them: `src/main.ts` is excluded from coverage entirely, so
 * the config-path environment variable, the signal handlers and the exit code have never been
 * executed by a test. Nor had a real HTTP request, a config read from disk, a secret read from a
 * file, or (the one that matters most) the durable store surviving a restart, which is the whole
 * premise of the funding record and was until now only ever asserted against an in-memory database
 * inside a single process.
 *
 * So this spawns `node dist/main.js` exactly as the container does, talks to it with `fetch`, and
 * stops it with a signal.
 */
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { hkdfSync } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { mintChallenge } from '../../src/personhood/challenge.js';
import { mintToken } from '../../src/personhood/token.js';
import { createSchema, dropOwnSchemas, liveBackends, storeConfigFor, storePassword } from '../pg.js';

/** What `spawn` with piped stdout/stderr and no stdin actually returns. */
type Spawned = ChildProcessByStdio<null, Readable, Readable>;

const MELD_KEY = 'e2e-meld-key-not-a-real-credential';
const JWT_KEY = 'e2e-jwt-key-not-a-real-credential';
const PRODUCT = 'app.dot';
/**
 * Meld's OWN hosted widget for the session, distinct from the provider's capture page.
 *
 * The fake returned `null` here, so the one line that maps it, and the schema v3 column that
 * persists it, were exercised by nothing end to end. A product that embeds Meld's flow opens
 * this URL, and a replay under the same idempotency key has to hand back the very same one.
 */
const MELD_WIDGET_URL = 'https://meldcrypto.com/w/e2e';
const WALLET = '15oF4uVJwmo4TdGW7VfQxNLavjCXviqxT9S1MgbjMNHr6Sp5';

/** The one error envelope every refusal uses. */
interface ErrorBody {
  error: { tag: string; value: { code: string } };
  request_id: string;
}

let dir: string;
let meld: http.Server | undefined;
let child: Spawned | undefined;
/** Everything the process wrote, so a test can assert what never appears in it. */
let output = '';
/**
 * Everything the process has written since it was spawned, including boot; never cleared.
 *
 * `output` is deliberately reset the moment the service is ready, so that boot chatter cannot
 * satisfy a later assertion. That is right for the positive assertions and exactly wrong for the
 * secret-leak ones: config load, `resolveSecret`, `buildPersonhood`'s two HKDF derivations and the
 * boot probe that carries the Meld key in an `Authorization` header all happen before the reset.
 * Writing either secret to stdout at boot left all 16 e2e tests green.
 */
let bootOutput = '';
/** Flipped once the service is up, so a fake failure does not also break the boot probe. */
let started = false;
/** Every authenticated path the fake Meld was asked for, in order. */
let meldCalls: string[] = [];

/** A Meld that answers the boot probe, a quote, and a session creation. */
async function fakeMeld(
  opts: { failQuote?: boolean; failBoot?: boolean; transactionStatus?: string } = {},
): Promise<string> {
  const server = http.createServer((req, res) => {
    const json = (body: unknown, status = 200): void => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    // The fake enforces the parts of Meld's contract the client is responsible for. Accepting
    // any shape made this suite blind to exactly the regressions it should catch: swapping
    // `BASIC` for `Bearer`, dropping the version header, or using the wrong verb all passed.
    if (req.headers.authorization !== `BASIC ${MELD_KEY}`) {
      json({ code: 'UNAUTHORIZED' }, 401);
      return;
    }
    if (req.headers['meld-version'] !== '2025-01-01') {
      json({ code: 'BAD_VERSION' }, 400);
      return;
    }
    // The settlement worker's transaction search is the one GET the client makes; everything
    // else is a POST and a wrong verb should still be refused.
    const searching = req.url?.startsWith('/payments/transactions') === true;
    if (req.method !== (searching ? 'GET' : 'POST')) {
      json({ code: 'BAD_METHOD' }, 405);
      return;
    }
    meldCalls.push(req.url ?? '');
    if (searching) {
      // Meld filters on `externalSessionIds` (plural) and answers `400` to the singular form, to
      // `?sessionId=` and to `?offset=`, so the fake refuses everything but the one parameter
      // that works. Accepting any query would let the suite pass against a join Meld rejects.
      const query = new URL(req.url ?? '', 'http://meld.invalid').searchParams;
      if (query.get('externalSessionIds') === null) {
        json({ code: 'BAD_REQUEST' }, 400);
        return;
      }
      const reference = query.get('externalSessionIds');
      json(
        opts.transactionStatus === undefined || reference === null
          ? { transactions: [] }
          : {
              transactions: [
                // Echoed back on `externalSessionId` only. `externalCustomerId` is reported to come
                // back null on every real transaction, so the fake models that rather than the
                // convenient case, and a finder that only reads it finds nothing here either.
                {
                  id: 'meld-txn-e2e',
                  externalSessionId: reference,
                  externalCustomerId: null,
                  status: opts.transactionStatus,
                },
              ],
            },
      );
      return;
    }
    if (req.url?.startsWith('/payments/crypto/quote')) {
      // The boot probe uses this path too, so failing it only after boot keeps the service up.
      if (opts.failBoot && !started) {
        json({ code: 'BAD_CREDENTIAL' }, 401);
        return;
      }
      if (opts.failQuote && started) {
        json({ code: 'UPSTREAM_BOOM' }, 500);
        return;
      }
      json({
        quotes: [
          {
            serviceProvider: 'TRANSAK',
            sourceAmount: '25.00',
            sourceCurrencyCode: 'USD',
            destinationAmount: '24',
            destinationCurrencyCode: 'USDC_ASSETHUB',
            totalFee: '1.00',
          },
        ],
      });
      return;
    }
    if (req.url?.startsWith('/crypto/session/widget')) {
      json({
        id: 'meld-session-e2e',
        serviceProviderWidgetUrl: 'https://meldcrypto.com/session/e2e',
        widgetUrl: MELD_WIDGET_URL,
        expiresAt: null,
      });
      return;
    }
    json({ quotes: [] });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  meld = server;
  const address = server.address();
  return `http://127.0.0.1:${String(typeof address === 'object' && address ? address.port : 0)}`;
}

/** A config file and its two secret files, exactly as the chart mounts them. */
async function writeConfig(
  baseUrl: string,
  port: number,
  schema: string,
  opts: {
    personhood?: boolean;
    worker?: { interval_ms: number; session_max_age_ms: number };
    products?: string[];
    allowedOrigins?: string[];
  } = {},
): Promise<string> {
  const meldKeyPath = join(dir, 'meld.key');
  const jwtKeyPath = join(dir, 'jwt.key');
  const storePasswordPath = join(dir, 'store.password');
  await writeFile(meldKeyPath, `${MELD_KEY}\n`);
  await writeFile(jwtKeyPath, `${JWT_KEY}\n`);
  await writeFile(storePasswordPath, `${storePassword()}\n`);

  const config = {
    environment: 'development',
    server: { port, host: '127.0.0.1', log_level: 'info', request_timeout_ms: 20000 },
    meld: {
      base_url: baseUrl,
      api_key: { mode: 'file', path: meldKeyPath },
      api_version: '2025-01-01',
      timeout_ms: 8000,
      boot_probe: {
        destination_code: 'USDC_ASSETHUB',
        source_amount: '20',
        source_currency: 'USD',
        country_code: 'US',
        payment_method_type: 'CREDIT_DEBIT_CARD',
      },
    },
    auth: opts.personhood
      ? {
          mode: 'personhood',
          personhood: {
            jwt_key: { mode: 'file', path: jwtKeyPath },
            people_rpc_url: 'wss://people.example.invalid',
            collections: [{ identifier: `0x${'11'.repeat(32)}`, ring_exponent: 9 }],
            challenge_ttl_ms: 60000,
            token_ttl_s: 300,
          },
        }
      : { mode: 'insecure_dev' },
    limits: [{ code: 'USDC_ASSETHUB', min: '10.00', max: '2000.00', currency: 'USD' }],
    allowed_products: opts.products ?? [PRODUCT],
    cors: { allowed_origins: opts.allowedOrigins ?? [] },
    rate_limit: { per_person_max: 1000, per_address_max: 1000, window_seconds: 60 },
    session_creation_enabled: true,
    // A real Postgres schema, not a file. The password is mounted from disk exactly as the chart
    // mounts it, because this suite spawns the built artifact as a separate process; an env-var
    // credential would depend on what that child happens to inherit.
    store: { ...storeConfigFor(schema), password: { mode: 'file', path: storePasswordPath } },
    worker:
      opts.worker === undefined
        ? { interval_ms: 15000, enabled: false, session_max_age_ms: 86400000 }
        : { ...opts.worker, enabled: true },
  };
  const path = join(dir, 'config.json');
  await writeFile(path, JSON.stringify(config));
  return path;
}

/** Start the built artifact and wait until it is actually answering. */
async function startService(configPath: string, port: number): Promise<Spawned> {
  const proc = spawn(process.execPath, ['dist/main.js'], {
    env: { ...process.env, CONFIG_PATH: configPath },
    stdio: ['ignore', 'pipe', 'pipe'],
    // Explicit, so the suite does not silently depend on being invoked from the repo root.
    cwd: process.cwd(),
  });
  // Tracked immediately, not on the success path. either throw below would otherwise leave the spawned
  // process unreferenced, so `afterEach` had nothing to kill: a startup regression left six live
  // `node dist/main.js` processes behind after vitest exited, holding ports.
  child = proc;
  proc.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString();
    bootOutput += chunk.toString();
  });
  proc.stderr.on('data', (chunk: Buffer) => {
    output += chunk.toString();
    bootOutput += chunk.toString();
  });

  const deadline = Date.now() + 20_000;
  for (;;) {
    if (proc.exitCode !== null) throw new Error(`service exited early (${String(proc.exitCode)}):\n${output}`);
    // Both conditions, and the first is the one that matters: `freePort` binds a port, closes it,
    // and hands the number to a child that binds it later. Anything could take it in that window,
    // and a health check alone would then call someone else's 200 "ready": a suite that is not
    // red, just testing a program it did not start. The child announcing this exact port on its
    // own stdout binds the harness to the process it spawned.
    const announced = output.includes(`http://127.0.0.1:${String(port)}`);
    try {
      const response = await fetch(`http://127.0.0.1:${String(port)}/health`);
      if (announced && response.ok) {
        started = true;
        // Boot chatter is not evidence about anything a test then does, and on Node 22 it
        // includes an experimental-SQLite warning that would satisfy a non-empty-output guard
        // all by itself.
        output = '';
        return proc;
      }
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) throw new Error(`service never became ready:\n${output}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Signal the process and wait for it to actually go, reporting how it went. */
async function stopService(proc: Spawned, signal: NodeJS.Signals = 'SIGTERM') {
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    proc.once('exit', (code, sig) => {
      resolve({ code, signal: sig });
    }),
  );
  proc.kill(signal);
  let loser: NodeJS.Timeout | undefined;
  const outcome = await Promise.race([
    exited,
    new Promise<'timeout'>((resolve) => {
      loser = setTimeout(() => {
        resolve('timeout');
      }, 10_000);
    }),
  ]).finally(() => {
    clearTimeout(loser);
  });
  if (outcome === 'timeout') {
    proc.kill('SIGKILL');
    throw new Error('service did not exit within 10s of a signal');
  }
  return outcome;
}

/** A port nobody else in this suite is using. */
const freePort = async (): Promise<number> =>
  new Promise((resolve) => {
    const probe = http.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => { resolve(port); });
    });
  });

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'onramp-e2e-'));
});

afterAll(async () => {
  // Every schema this process minted, including the ones handed to a child.
  await dropOwnSchemas();
});

afterEach(async () => {
  if (child && child.exitCode === null) {
    child.kill('SIGKILL');
  }
  child = undefined;
  meld?.close();
  meld = undefined;
  output = '';
  bootOutput = '';
  started = false;
  meldCalls = [];
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('the service as a process', () => {
  it('boots from a config file, serves a real request, and stops on SIGTERM', async () => {
    const baseUrl = await fakeMeld();
    const port = await freePort();
    const configPath = await writeConfig(baseUrl, port, await createSchema());

    child = await startService(configPath, port);

    const health = await fetch(`http://127.0.0.1:${String(port)}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: 'ok' });

    // The whole point of `main.ts`: the signal is owned, so the process shuts down and exits
    // 0 of its own accord. Accepting `signal === 'SIGTERM'` as well would have passed on the
    // kernel's default action. Verified by deleting the handler: the old assertion still
    // passed. A clean code-0 exit is the thing only a handler produces.
    const { code, signal } = await stopService(child);
    expect({ code, signal }).toEqual({ code: 0, signal: null });
  }, 40_000);

  it('proves the Meld credential before the port opens, and refuses to serve without it', async () => {
    // `startup`'s load-bearing guarantee. Nothing asserted it end to end: with a working fake,
    // deleting `verifyKey` entirely still passed, because later route calls drive Meld anyway.
    // A boot probe that Meld rejects must stop the process, so a bad key is found by the deploy
    // rather than by the first buyer.
    const baseUrl = await fakeMeld({ failBoot: true });
    const port = await freePort();
    const configPath = await writeConfig(baseUrl, port, await createSchema());

    const proc = spawn(process.execPath, ['dist/main.js'], {
      env: { ...process.env, CONFIG_PATH: configPath },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child = proc;
    let text = '';
    proc.stdout.on('data', (c: Buffer) => {
      text += c.toString();
    });
    proc.stderr.on('data', (c: Buffer) => {
      text += c.toString();
    });
    // Bounded, so a regression that lets the service start reports "it kept running" rather
    // than a bare 40-second suite timeout.
    const code = await Promise.race([
      new Promise<number | null>((resolve) => {
        proc.once('exit', resolve);
      }),
      new Promise<'still running'>((resolve) => {
        setTimeout(() => {
          resolve('still running');
        }, 15_000);
      }),
    ]);

    expect(code).toBe(1);
    expect(text).toContain('Startup failed');
    // It asked Meld before giving up, and it never opened the port.
    expect(meldCalls.length).toBeGreaterThan(0);
    await expect(fetch(`http://127.0.0.1:${String(port)}/health`)).rejects.toThrow();
  }, 40_000);

  it('releases its database connections on the way out, leaving none behind', async () => {
    // The Postgres form of the write-ahead-log check this replaced. A graceful stop must drain the
    // pool: CloudSQL has a hard connection ceiling shared across everything pointed at the
    // instance, so a process that exits holding its connections costs the next one its slots,
    // and in a crash loop, a pool's worth per attempt.
    //
    // Backends are counted by `application_name`, which the pool sets. This asserts the property
    // and not `startup`'s `funding.close()` line specifically: the connections also go when the
    // process exits, so deleting that line keeps this green. What the explicit close buys is
    // ordering (the pool is drained after the server stops, never while a request might still
    // be using it), and that is not observable from out here.
    const baseUrl = await fakeMeld();
    const port = await freePort();
    const schema = await createSchema();
    const configPath = await writeConfig(baseUrl, port, schema);

    child = await startService(configPath, port);
    // Write something, so connections are genuinely in use rather than merely opened.
    await fetch(`http://127.0.0.1:${String(port)}/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dev-product-id': PRODUCT },
      body: JSON.stringify({
        idempotencyKey: 'e2e-pool-0001',
        destinationCurrencyCode: 'USDC_ASSETHUB',
        walletAddress: WALLET,
        sourceAmount: '25.00',
        fiat: 'USD',
        country: 'US',
        paymentMethodType: 'CREDIT_DEBIT_CARD',
        serviceProvider: 'TRANSAK',
      }),
    });
    expect(await liveBackends(schema)).toBeGreaterThan(0);

    await stopService(child);

    expect(await liveBackends(schema)).toBe(0);
  }, 40_000);

  it('shuts down cleanly on SIGINT as well as SIGTERM', async () => {
    // `main.ts` owns both signals and nothing exercised the second. `main.ts` is excluded from
    // coverage and from mutation testing, so an untested handler there is untested everywhere.
    const baseUrl = await fakeMeld();
    const port = await freePort();
    const configPath = await writeConfig(baseUrl, port, await createSchema());

    child = await startService(configPath, port);
    const { code, signal } = await stopService(child, 'SIGINT');

    expect({ code, signal }).toEqual({ code: 0, signal: null });
  }, 40_000);

  it('refuses to start without a config file, with a readable message and a non-zero exit', async () => {
    // `main.ts`'s catch path. A crash loop has to be diagnosable from the log alone.
    // Tracked in `child` so `afterEach` kills it: a startup regression that hangs instead of
    // exiting would otherwise leave a live process behind when this test times out.
    const proc = spawn(process.execPath, ['dist/main.js'], {
      env: { ...process.env, CONFIG_PATH: join(dir, 'does-not-exist.json') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child = proc;
    let text = '';
    proc.stdout.on('data', (c: Buffer) => {
      text += c.toString();
    });
    proc.stderr.on('data', (c: Buffer) => {
      text += c.toString();
    });
    const code = await new Promise<number | null>((resolve) => proc.once('exit', resolve));

    expect(code).toBe(1);
    expect(text).toContain('Startup failed');
    expect(text).toContain('does-not-exist.json');
  }, 30_000);

  it('never writes the Meld key to its own output, including when the upstream fails', async () => {
    // Asserted against the real process's stdout and stderr: the surface an operator and a log
    // pipeline actually see, rather than a captured logger.
    //
    // What this catches, established by trying each in turn:
    //
    //   - deleting `Secret`'s redaction alone: still passes, because no reachable path hands a
    //     credential to the logger;
    //   - adding a log line that dumps the key alone: still passes, because redaction turns it
    //     into `[redacted]`;
    //   - both together: fails.
    //
    // So this is not a redaction test; the unit test that deliberately logs a `Secret` through
    // the real pino sink is that. This one asserts the outcome the two mechanisms exist to
    // produce, on the actual stdout an operator and a log pipeline read, and it is the check that
    // survives someone deciding one of the two is unnecessary.
    //
    // The failing upstream drives logging about the very call that carries the key, so the output
    // under inspection is output where a leak would plausibly land.
    const baseUrl = await fakeMeld({ failQuote: true });
    const port = await freePort();
    const configPath = await writeConfig(baseUrl, port, await createSchema());

    child = await startService(configPath, port);
    await fetch(`http://127.0.0.1:${String(port)}/health`);
    await fetch(`http://127.0.0.1:${String(port)}/quote`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dev-product-id': PRODUCT },
      body: JSON.stringify({
        country: 'US',
        fiat: 'USD',
        destinationCurrencyCode: 'USDC_ASSETHUB',
        sourceAmount: '25.00',
        paymentMethodType: 'CREDIT_DEBIT_CARD',
      }),
    });
    await stopService(child);

    // The log has to actually describe the failed Meld call, or the absence below proves nothing.
    // `output` is cleared once the service is ready, so this cannot be satisfied by the boot
    // probe's own "Meld accepted the credentials" line, which is what would make
    // this guard survive deleting the only log statement about the failing request.
    expect(output).toMatch(/upstream|meld/i);
    expect(output).toMatch(/50\d|error/i);
    // `bootOutput`, which is never cleared. The boot probe sends the key in an `Authorization`
    // header, so boot is the likeliest place for it to reach a log, and `output` has been reset
    // by the time this runs, which excluded exactly that window.
    expect(bootOutput).not.toContain(MELD_KEY);
  }, 40_000);

  it('derives its challenge key from the JWT key file, not from anything baked in', async () => {
    // "Secrets read from real files" was only half proven. The Meld key is defended (the fake
    // rejects any request not carrying its exact value), but nothing showed the process actually
    // uses the JWT key file: replacing the derived keys with a literal, while still reading the
    // file so a missing mount stayed fatal, passed every test.
    //
    // So the test derives the challenge key the same way `startup` does, mints a challenge with
    // it, and offers it back. If the service derived from the file, the MAC verifies and the
    // request proceeds to the proof check; if it derived from anything else, the challenge is
    // rejected first. Both answer 401 on the wire, so the discriminator is the operator detail
    // in the log, which is exactly what that detail is for.
    const baseUrl = await fakeMeld();
    const port = await freePort();
    const configPath = await writeConfig(baseUrl, port, await createSchema(), { personhood: true });

    child = await startService(configPath, port);

    const challengeKey = new Uint8Array(
      hkdfSync('sha256', JWT_KEY, Buffer.alloc(0), Buffer.from('onramp:challenge'), 32),
    );
    const token = mintChallenge(challengeKey);

    const response = await fetch(`http://127.0.0.1:${String(port)}/api/v1/auth/redeem`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        challenge: Buffer.from(token).toString('base64url'),
        proof: Buffer.from(new Uint8Array([1, 2, 3])).toString('base64url'),
        ring: 0,
        productId: PRODUCT,
      }),
    });
    await stopService(child);

    // A 503, and correctly so: the challenge verified, so the request reached the ring read, and
    // this deployment's People RPC is deliberately unreachable. A chain or transport failure is
    // a dependency declining to answer (`ProviderTimeout`, the same degrade every other
    // upstream in this service uses) rather than a caller mistake flattened into a 401 or an
    // internal fault reported as a 500. It answered 500 until the 2026-08-28 audit.
    //
    // That it got that far is the whole point: a key not derived from the file would have been
    // stopped one step earlier, at the challenge MAC. The log detail is the discriminator,
    // because both outcomes are indistinguishable on the wire.
    expect(response.status).toBe(503);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(output).not.toContain('challenge rejected');
    expect(output).toMatch(/state_getStorage|RPC|people/i);
  }, 40_000);

  it('separates the challenge key from the token key by HKDF label, end to end', async () => {
    // One mounted secret serves two roles, and the labels are the whole reason that is safe:
    // `POST /api/v1/auth/challenge` is public and hands out an HMAC under the challenge key, so
    // if that key were the JWT signing key the route would be an unauthenticated oracle for the
    // key that mints every bearer token this service accepts.
    //
    // The sibling test above proves the challenge key comes from the file. This proves the two
    // derived keys are actually different, against the built artifact: a token signed with the
    // jwt-labelled key is accepted on an authenticated route, and one signed with the
    // challenge-labelled key is not. Collapse the labels in `buildPersonhood` and the second
    // token starts working.
    const baseUrl = await fakeMeld();
    const port = await freePort();
    const configPath = await writeConfig(baseUrl, port, await createSchema(), { personhood: true });

    child = await startService(configPath, port);

    const keyFor = (label: string) => ({
      secret: new Uint8Array(hkdfSync('sha256', JWT_KEY, Buffer.alloc(0), Buffer.from(label), 32)),
    });
    const quoteAs = async (token: string) =>
      fetch(`http://127.0.0.1:${String(port)}/quote`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
          country: 'US',
          fiat: 'USD',
          destinationCurrencyCode: 'USDC_ASSETHUB',
          sourceAmount: '25.00',
          paymentMethodType: 'CREDIT_DEBIT_CARD',
        }),
      });

    const accepted = await quoteAs(await mintToken(keyFor('onramp:jwt'), '0xada', PRODUCT, 300));
    const refused = await quoteAs(await mintToken(keyFor('onramp:challenge'), '0xmallory', PRODUCT, 300));
    await stopService(child);

    expect(accepted.status).toBe(200);
    expect(refused.status).toBe(401);
    expect(((await refused.json()) as ErrorBody).error.value.code).toBe('UNAUTHORIZED');
  }, 40_000);

  it('never writes the JWT signing key to its own output', async () => {
    // Separate from the Meld-key test because it needs `personhood` mode: `insecure_dev` never
    // resolves the JWT secret at all, so asserting its absence there proved nothing; the
    // process had not read the file. Here `buildPersonhood` reads it and derives two keys from
    // it at boot, which is the moment it could leak.
    const baseUrl = await fakeMeld();
    const port = await freePort();
    const configPath = await writeConfig(baseUrl, port, await createSchema(), { personhood: true });

    child = await startService(configPath, port);
    await fetch(`http://127.0.0.1:${String(port)}/api/v1/auth/challenge`, { method: 'POST' });
    await stopService(child);

    expect(output.length).toBeGreaterThan(0);
    // Against `bootOutput`: this test's own comment says the derivation at boot "is the moment it
    // could leak", and `output` starts empty after that moment. Writing the key to stdout inside
    // `buildPersonhood` left all 16 tests green.
    expect(bootOutput).not.toContain(JWT_KEY);
    expect(bootOutput.length).toBeGreaterThan(0);
  }, 40_000);
});

describe('the funding journey over real HTTP', () => {
  it('quotes, creates a session, and lists the request back', async () => {
    const baseUrl = await fakeMeld();
    const port = await freePort();
    const configPath = await writeConfig(baseUrl, port, await createSchema());
    child = await startService(configPath, port);
    const base = `http://127.0.0.1:${String(port)}`;
    const headers = { 'content-type': 'application/json', 'x-dev-product-id': PRODUCT };

    const quote = await fetch(`${base}/quote`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        country: 'US',
        fiat: 'USD',
        destinationCurrencyCode: 'USDC_ASSETHUB',
        sourceAmount: '25.00',
        paymentMethodType: 'CREDIT_DEBIT_CARD',
      }),
    });
    expect(quote.status).toBe(200);
    expect(((await quote.json()) as { quotes: unknown[] }).quotes).toHaveLength(1);

    const session = await fetch(`${base}/session`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        idempotencyKey: 'e2e-0001',
        destinationCurrencyCode: 'USDC_ASSETHUB',
        walletAddress: WALLET,
        sourceAmount: '25.00',
        fiat: 'USD',
        country: 'US',
        paymentMethodType: 'CREDIT_DEBIT_CARD',
        serviceProvider: 'TRANSAK',
      }),
    });
    expect(session.status).toBe(201);
    const created = (await session.json()) as {
      fundingRequestId: string;
      sessionId: string;
      serviceProviderWidgetUrl: string;
      widgetUrl?: string;
      pinned: { destinationCurrencyCode: string; walletAddress: string; sourceAmount: string; fiat: string; country?: string };
    };
    expect(created.fundingRequestId).toBeTruthy();
    // The buyer handoff and the terms it was pinned to. Asserting only the id let a response
    // with an empty settlement URL pass: a 201 handing the buyer nowhere to pay.
    expect(created.sessionId).toBe('meld-session-e2e');
    expect(created.serviceProviderWidgetUrl).toBe('https://meldcrypto.com/session/e2e');
    // Both surfaces, each under its own name. Meld returns two and they are different pages;
    // answering `null` here would let every layer between the response and this body
    // could drop the hosted widget with nothing to notice.
    expect(created.widgetUrl).toBe(MELD_WIDGET_URL);
    expect(created.widgetUrl).not.toBe(created.serviceProviderWidgetUrl);
    expect(created.pinned).toEqual({
      destinationCurrencyCode: 'USDC_ASSETHUB',
      walletAddress: WALLET,
      sourceAmount: '25.00',
      fiat: 'USD',
      // The jurisdiction, committed like the rest. It selects the provider set and the fee
      // schedule at the rail, so a caller confirming what was committed needs to see it.
      country: 'US',
    });

    const listed = await fetch(`${base}/funding`, { headers });
    expect(listed.status).toBe(200);
    const { fundingRequests } = (await listed.json()) as { fundingRequests: Record<string, unknown>[] };
    expect(fundingRequests).toHaveLength(1);
    const [only] = fundingRequests;
    // The lifecycle state as well as the id: a row with the right id and the wrong state is
    // still a broken funding journey, and this is the API a caller polls to learn which it is.
    expect(only).toMatchObject({
      id: created.fundingRequestId,
      status: 'session_opened',
      rail: 'meld',
      destinationCurrencyCode: 'USDC_ASSETHUB',
      sourceAmount: '25.00',
      fiat: 'USD',
    });
    // The DTO boundary, asserted on the wire rather than on a mapper's return value: the rail's
    // own session id is a join key and must not survive the trip.
    expect(JSON.stringify(only)).not.toContain('meld-session-e2e');

    await stopService(child);
  }, 40_000);

  it('keeps the funding record across a restart, which is what the durable store is for', async () => {
    // The durable store's entire premise, and until now only ever asserted against an
    // in-memory database inside one process. A file, two processes, and the record has to
    // still be there.
    const baseUrl = await fakeMeld();
    const port = await freePort();
    const schema = await createSchema();
    const configPath = await writeConfig(baseUrl, port, schema);
    const base = `http://127.0.0.1:${String(port)}`;
    const headers = { 'content-type': 'application/json', 'x-dev-product-id': PRODUCT };

    child = await startService(configPath, port);
    const session = await fetch(`${base}/session`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        idempotencyKey: 'e2e-restart-0001',
        destinationCurrencyCode: 'USDC_ASSETHUB',
        walletAddress: WALLET,
        sourceAmount: '25.00',
        fiat: 'USD',
        country: 'US',
        paymentMethodType: 'CREDIT_DEBIT_CARD',
        serviceProvider: 'TRANSAK',
      }),
    });
    expect(session.status).toBe(201);
    const { fundingRequestId } = (await session.json()) as { fundingRequestId: string };
    await stopService(child);

    child = await startService(configPath, port);
    const after = await fetch(`${base}/funding/${fundingRequestId}`, { headers });
    expect(after.status).toBe(200);
    const { funding } = (await after.json()) as { funding: Record<string, unknown> };
    expect(funding).toMatchObject({
      id: fundingRequestId,
      status: 'session_opened',
      rail: 'meld',
      sourceAmount: '25.00',
    });
    await stopService(child);
  }, 60_000);

  it('withdraws a settlement surface over the wire, and keeps refusing the key afterwards', async () => {
    // Asserted in-process only until now, and the in-process store is not the one a real cancel
    // hits. What matters here is the body over the wire: if the capture page still comes back
    // after a cancel, the buyer was told their purchase was over while the page was live.
    const baseUrl = await fakeMeld();
    const port = await freePort();
    const configPath = await writeConfig(baseUrl, port, await createSchema());
    child = await startService(configPath, port);
    const base = `http://127.0.0.1:${String(port)}`;
    const headers = { 'content-type': 'application/json', 'x-dev-product-id': PRODUCT };

    const session = await fetch(`${base}/session`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        idempotencyKey: 'e2e-cancel-0001',
        destinationCurrencyCode: 'USDC_ASSETHUB',
        walletAddress: WALLET,
        sourceAmount: '25.00',
        fiat: 'USD',
        country: 'US',
        paymentMethodType: 'CREDIT_DEBIT_CARD',
        serviceProvider: 'TRANSAK',
      }),
    });
    expect(session.status).toBe(201);
    const { fundingRequestId } = (await session.json()) as { fundingRequestId: string };

    // Live first, or the assertion after the cancel proves nothing.
    const before = await fetch(`${base}/funding/${fundingRequestId}`, { headers });
    const live = (await before.json()) as { funding: Record<string, unknown> };
    expect(live.funding.serviceProviderWidgetUrl).toBeDefined();

    const cancelled = await fetch(`${base}/funding/${fundingRequestId}/cancel`, { method: 'POST', headers });
    expect(cancelled.status).toBe(200);
    const body = (await cancelled.json()) as { funding: Record<string, unknown> };
    expect(body.funding).toMatchObject({ id: fundingRequestId, status: 'session_opened' });
    expect(body.funding.cancelledAt).toEqual(expect.any(Number));
    expect(body.funding.serviceProviderWidgetUrl).toBeUndefined();

    // And the read route agrees: the surface is gone from every answer, not just the one the
    // cancel returned.
    const after = await fetch(`${base}/funding/${fundingRequestId}`, { headers });
    const read = (await after.json()) as { funding: Record<string, unknown> };
    expect(read.funding.serviceProviderWidgetUrl).toBeUndefined();
    expect(read.funding.cancelledAt).toEqual(expect.any(Number));

    // The key does not become reusable. Replaying it must refuse rather than hand back the page
    // the cancel took away.
    const replay = await fetch(`${base}/session`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        idempotencyKey: 'e2e-cancel-0001',
        destinationCurrencyCode: 'USDC_ASSETHUB',
        walletAddress: WALLET,
        sourceAmount: '25.00',
        fiat: 'USD',
        country: 'US',
        paymentMethodType: 'CREDIT_DEBIT_CARD',
        serviceProvider: 'TRANSAK',
      }),
    });
    expect(replay.status).toBe(409);
    expect(await replay.json()).toMatchObject({
      error: { value: { code: 'REQUEST_CANCELLED', fundingRequestId } },
    });
    await stopService(child);
  }, 60_000);

  it('replays an idempotent retry over the wire without opening a second Meld session', async () => {
    // The whole point of the key is that a page reload does not charge the buyer twice. Every
    // mutation to the replay path passed this suite: it is asserted in-process only, and the
    // in-process store is not the one a reload actually hits.
    const baseUrl = await fakeMeld();
    const port = await freePort();
    const configPath = await writeConfig(baseUrl, port, await createSchema());
    child = await startService(configPath, port);
    const base = `http://127.0.0.1:${String(port)}`;
    const headers = { 'content-type': 'application/json', 'x-dev-product-id': PRODUCT };
    const body = JSON.stringify({
      idempotencyKey: 'e2e-idem-0001',
      destinationCurrencyCode: 'USDC_ASSETHUB',
      walletAddress: WALLET,
      sourceAmount: '25.00',
      fiat: 'USD',
      country: 'US',
      paymentMethodType: 'CREDIT_DEBIT_CARD',
      serviceProvider: 'TRANSAK',
    });

    const first = await fetch(`${base}/session`, { method: 'POST', headers, body });
    const sessionsBefore = meldCalls.filter((url) => url.startsWith('/crypto/session/widget')).length;
    const second = await fetch(`${base}/session`, { method: 'POST', headers, body });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    // Identical, field for field, rather than only "both succeeded". A replay that answered 201
    // with an empty settlement URL would pass any weaker assertion while stranding the buyer.
    const firstBody = (await first.json()) as Record<string, unknown>;
    const secondBody = (await second.json()) as Record<string, unknown>;
    expect(secondBody).toEqual(firstBody);
    // Named explicitly, because this is the field schema v3 and the `hosted_widget_url` column
    // exist for. The replay is rebuilt from the stored row rather than from Meld's answer, so a
    // column that never held the hosted widget replayed the provider page under it. A caller
    // that embedded Meld's widget on the first response got a different page on the retry, which
    // is not idempotent.
    expect(firstBody.widgetUrl).toBe(MELD_WIDGET_URL);
    expect(secondBody.widgetUrl).toBe(MELD_WIDGET_URL);
    // And Meld heard about it once. A second upstream session is a second capture page for one
    // buyer intent, which is how one purchase becomes two.
    expect(meldCalls.filter((url) => url.startsWith('/crypto/session/widget'))).toHaveLength(
      sessionsBefore,
    );

    const listed = await fetch(`${base}/funding`, { headers });
    expect(((await listed.json()) as { fundingRequests: unknown[] }).fundingRequests).toHaveLength(1);

    await stopService(child);
  }, 40_000);

  it('settles a request through the real worker, against a Meld that reports the payment', async () => {
    // Every other config in this suite sets `worker.enabled: false`, so the loop that advances a
    // funding request after the browser has gone (the entire reason the store is durable) had
    // never run outside a unit test with an injected finder. Here it is the real wiring: the
    // built artifact's own rail observation, over HTTP, against a Meld that answers a search.
    const baseUrl = await fakeMeld({ transactionStatus: 'SETTLED' });
    const port = await freePort();
    const configPath = await writeConfig(baseUrl, port, await createSchema(), {
      worker: { interval_ms: 1000, session_max_age_ms: 60000 },
    });
    child = await startService(configPath, port);
    const base = `http://127.0.0.1:${String(port)}`;
    const headers = { 'content-type': 'application/json', 'x-dev-product-id': PRODUCT };

    const session = await fetch(`${base}/session`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        idempotencyKey: 'e2e-worker-0001',
        destinationCurrencyCode: 'USDC_ASSETHUB',
        walletAddress: WALLET,
        sourceAmount: '25.00',
        fiat: 'USD',
        country: 'US',
        paymentMethodType: 'CREDIT_DEBIT_CARD',
        serviceProvider: 'TRANSAK',
      }),
    });
    expect(session.status).toBe(201);
    const { fundingRequestId } = (await session.json()) as { fundingRequestId: string };

    // No browser involved from here on: the buyer has closed the tab and the loop does the rest.
    const deadline = Date.now() + 20_000;
    let status = '';
    while (Date.now() < deadline && status !== 'settled') {
      const seen = await fetch(`${base}/funding/${fundingRequestId}`, { headers });
      status = ((await seen.json()) as { funding: { status: string } }).funding.status;
      if (status !== 'settled') await new Promise((resolve) => setTimeout(resolve, 500));
    }

    expect(status).toBe('settled');
    // It searched by the funding row's own id, which is what was filed upstream. It did not
    // search by the caller's idempotency key, whose namespace is per-caller and would collide
    // across them.
    expect(meldCalls.some((url) => url.includes(encodeURIComponent(fundingRequestId)))).toBe(true);
    expect(meldCalls.some((url) => url.includes('e2e-worker-0001'))).toBe(false);

    await stopService(child);
  }, 60_000);

  it('lands the buyer back on an approved origin, and refuses one that is not', async () => {
    // The redirect is the one caller-supplied value that reaches a browser after a card is
    // charged. Over the wire because the guard spans three layers: the schema's scheme floor,
    // the service's origin allowlist, and the client's placement inside `sessionData`.
    const baseUrl = await fakeMeld();
    const port = await freePort();
    const configPath = await writeConfig(baseUrl, port, await createSchema(), {
      allowedOrigins: ['https://app.example'],
    });
    child = await startService(configPath, port);
    const base = `http://127.0.0.1:${String(port)}`;
    const headers = { 'content-type': 'application/json', 'x-dev-product-id': PRODUCT };
    const body = (redirectUrl: string, key: string) =>
      JSON.stringify({
        idempotencyKey: key,
        destinationCurrencyCode: 'USDC_ASSETHUB',
        walletAddress: WALLET,
        sourceAmount: '25.00',
        fiat: 'USD',
        country: 'US',
        paymentMethodType: 'CREDIT_DEBIT_CARD',
        serviceProvider: 'TRANSAK',
        redirectUrl,
      });

    const allowed = await fetch(`${base}/session`, {
      method: 'POST',
      headers,
      body: body('https://app.example/thanks', 'e2e-redir-ok'),
    });
    expect(allowed.status).toBe(201);

    const refused = await fetch(`${base}/session`, {
      method: 'POST',
      headers,
      body: body('https://attacker.example/steal', 'e2e-redir-no'),
    });
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as ErrorBody).error.value.code).toBe('REDIRECT_NOT_ALLOWED');

    const scheme = await fetch(`${base}/session`, {
      method: 'POST',
      headers,
      body: body('javascript:alert(1)', 'e2e-redir-js'),
    });
    expect(scheme.status).toBe(400);
    expect(((await scheme.json()) as ErrorBody).error.value.code).toBe('MALFORMED_REQUEST');

    await stopService(child);
  }, 40_000);

  it('will not show one caller another caller\'s funding request', async () => {
    // Scoping is asserted in-process against the store. On the wire it is the whole tenancy
    // boundary: `/funding/:id` takes an id straight from the caller, and the id of someone
    // else's request is the first thing anyone would try.
    const baseUrl = await fakeMeld();
    const port = await freePort();
    const other = 'other.dot';
    const configPath = await writeConfig(baseUrl, port, await createSchema(), {
      products: [PRODUCT, other],
    });
    child = await startService(configPath, port);
    const base = `http://127.0.0.1:${String(port)}`;
    const mine = { 'content-type': 'application/json', 'x-dev-product-id': PRODUCT };
    const theirs = { 'content-type': 'application/json', 'x-dev-product-id': other };

    const session = await fetch(`${base}/session`, {
      method: 'POST',
      headers: mine,
      body: JSON.stringify({
        idempotencyKey: 'e2e-scope-0001',
        destinationCurrencyCode: 'USDC_ASSETHUB',
        walletAddress: WALLET,
        sourceAmount: '25.00',
        fiat: 'USD',
        country: 'US',
        paymentMethodType: 'CREDIT_DEBIT_CARD',
        serviceProvider: 'TRANSAK',
      }),
    });
    expect(session.status).toBe(201);
    const { fundingRequestId } = (await session.json()) as { fundingRequestId: string };

    // 404, not 403: the other caller learns nothing about whether the id exists.
    const peek = await fetch(`${base}/funding/${fundingRequestId}`, { headers: theirs });
    expect(peek.status).toBe(404);
    const listed = await fetch(`${base}/funding`, { headers: theirs });
    expect(((await listed.json()) as { fundingRequests: unknown[] }).fundingRequests).toHaveLength(0);
    // And the owner still sees it, so the refusal above is scoping rather than a broken route.
    expect((await fetch(`${base}/funding/${fundingRequestId}`, { headers: mine })).status).toBe(200);

    await stopService(child);
  }, 40_000);

  it('refuses an unauthenticated caller and an unknown route over the wire', async () => {
    const baseUrl = await fakeMeld();
    const port = await freePort();
    const configPath = await writeConfig(baseUrl, port, await createSchema());
    child = await startService(configPath, port);
    const base = `http://127.0.0.1:${String(port)}`;

    const unauthorized = await fetch(`${base}/funding`);
    expect(unauthorized.status).toBe(401);
    expect(((await unauthorized.json()) as ErrorBody).error.value.code).toBe('UNAUTHORIZED');

    // A header that names a product this deployment does not serve. Sending no header at all
    // leaves the allowlist itself unexercised over the wire; the refusal would look the same
    // if any product string were accepted.
    const wrongProduct = await fetch(`${base}/funding`, { headers: { 'x-dev-product-id': 'not-allowed.dot' } });
    expect(wrongProduct.status).toBe(401);

    const missing = await fetch(`${base}/nope`);
    expect(missing.status).toBe(404);
    const body = (await missing.json()) as ErrorBody;
    expect(body.error.value.code).toBe('NOT_FOUND');
    // The contract shape holds on the not-found path too, which has its own Fastify handler.
    expect(body.request_id).toBeTruthy();

    await stopService(child);
  }, 40_000);
});
