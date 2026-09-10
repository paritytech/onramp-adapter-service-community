/**
 * A real Postgres for the tests that need one.
 *
 * `:memory:` SQLite made every test hermetic for free. Postgres is a
 * server, so hermeticity has to be bought: each `withStore` takes its own schema, points the
 * connection's `search_path` at it, and drops it afterwards. Two suites running concurrently
 * therefore cannot see each other's rows, and a failure leaves nothing behind for the next run to
 * trip over.
 *
 * Only the tests that assert something about storage use this: reservation arbitration under a
 * shared idempotency key, lease claiming across two workers, migration locking, ordering. The rest
 * of the suite keeps its in-memory fakes, because pointing four hundred tests at a database would
 * buy coverage of `pg` rather than of this service.
 *
 * `ONRAMP_TEST_PG` overrides the connection for CI, where the database is a service container.
 */

import { Pool } from 'pg';

import type { Migration } from '../src/funding/schema.js';
import { FundingStore, type StoreConfig } from '../src/funding/store.js';
import { Secret } from '../src/secret.js';

const DSN = process.env.ONRAMP_TEST_PG ?? 'postgres://localhost:5432/onramp_test';

/** Parsed once: every helper here builds its config from the same source. */
function baseConfig(): Omit<StoreConfig, 'database'> & { database: string } {
  const url = new URL(DSN);
  return {
    host: url.hostname,
    port: url.port === '' ? 5432 : Number(url.port),
    database: url.pathname.replace(/^\//, ''),
    user: url.username === '' ? (process.env.USER ?? 'postgres') : url.username,
    // Local and CI Postgres use trust auth, so the value is never checked; `Secret` refuses
    // an empty string, so it needs to be something.
    password: new Secret(url.password === '' ? 'trust-auth-unused' : url.password),
    // Local and CI Postgres both speak plaintext on a loopback socket. Production refuses this:
    // `config.ts` rejects `ssl: false` outside development, which is the guard that matters.
    ssl: false,
    poolMax: 4,
    statementTimeoutMs: 10_000,
    connectionTimeoutMs: 5_000,
  };
}

let counter = 0;

/**
 * Run `body` against a store in its own freshly-migrated schema, then drop it.
 *
 * The schema name carries the worker id as well as a counter: vitest runs files in parallel
 * processes, and two of them starting at the same moment would otherwise collide on `s1`.
 */
export async function withStore<T>(body: (store: FundingStore) => Promise<T>): Promise<T> {
  const schema = await createSchema();
  const store = await openIn(schema);
  try {
    return await body(store);
  } finally {
    await store.close();
    await dropSchema(schema);
  }
}

/**
 * As `withStore`, but hands `body` two independent stores on the same schema.
 *
 * This is what a second replica looks like: separate pools, separate leases, one database. Nothing
 * about two workers racing can be asserted through a single pool, because a pool serializes
 * nothing; the contention it has to survive is between processes.
 */
export async function withTwoStores<T>(body: (a: FundingStore, b: FundingStore) => Promise<T>): Promise<T> {
  const schema = await createSchema();
  const first = await openIn(schema);
  const second = await openIn(schema);
  try {
    return await body(first, second);
  } finally {
    await first.close();
    await second.close();
    await dropSchema(schema);
  }
}

/**
 * Three independent connections to the same schema, for keeping a row lock genuinely contended.
 *
 * For the batch-partition property: five live rows, three bound claims in flight at once, each on
 * its own connection so a single-socket pool cannot quietly serialise them.
 *
 * It does not demonstrate `FOR UPDATE SKIP LOCKED`, and a comment claiming otherwise
 * claimed it did. Blocking yields the same partition as skipping (the losers wait their turn and
 * come away with the same rows), so removing the primitive leaves these assertions green. Use
 * `whileRowLocked` for that; it is the one that fails when `SKIP LOCKED` goes.
 */
/**
 * Three stores means twelve connections (`storeConfigFor` sets `poolMax: 4` and each store
 * opens its own pool), and the full suite runs this file beside two other Postgres-backed ones.
 * If the soak starts failing again after its bound was raised to 30s, look here before looking at
 * the bound: connection exhaustion on a server with a modest `max_connections` fails in a way that
 * reads like a logic bug.
 */
export async function withThreeStores<T>(body: (a: FundingStore, b: FundingStore, c: FundingStore) => Promise<T>): Promise<T> {
  const schema = await createSchema();
  const first = await openIn(schema);
  const second = await openIn(schema);
  const third = await openIn(schema);
  try {
    return await body(first, second, third);
  } finally {
    await first.close();
    await second.close();
    await third.close();
    await dropSchema(schema);
  }
}

/** Open a store whose every connection resolves unqualified names inside `schema`. */
export async function openIn(
  schema: string,
  migrations?: readonly Migration[],
  overrides: Partial<StoreConfig> = {},
): Promise<FundingStore> {
  const cfg = { ...baseConfig(), searchPath: schema, ...overrides };
  return migrations === undefined ? FundingStore.open(cfg) : FundingStore.open(cfg, migrations);
}

/** Make an empty schema and return its name. */
export async function createSchema(): Promise<string> {
  counter += 1;
  const name = `t_${String(process.pid)}_${String(counter)}`;
  await admin(async (pool) => {
    await pool.query(`CREATE SCHEMA "${name}"`);
  });
  return name;
}

/** Drop a schema and everything in it. */
export async function dropSchema(name: string): Promise<void> {
  await admin(async (pool) => {
    await pool.query(`DROP SCHEMA IF EXISTS "${name}" CASCADE`);
  });
}

/** A short-lived pool for the schema bookkeeping, outside any store. */
async function admin<T>(body: (pool: Pool) => Promise<T>): Promise<T> {
  const cfg = baseConfig();
  const pool = new Pool({
    host: cfg.host,
    port: cfg.port,
    database: cfg.database,
    user: cfg.user,
    password: cfg.password.expose(),
    max: 2,
  });
  try {
    return await body(pool);
  } finally {
    await pool.end();
  }
}

/**
 * The `store` block a written config file needs to reach the test database.
 *
 * `startup` reads a config file from disk, so a test that boots the whole service cannot inject a
 * store; it has to write one out. The password rides in as an env var because that is the only
 * `secretSource` mode expressible without also writing a secret file, and `environment:
 * 'development'` is what permits it.
 */
export function storeConfigFor(schema: string): Record<string, unknown> {
  const cfg = baseConfig();
  process.env.ONRAMP_TEST_PG_PASSWORD = cfg.password.expose();
  return {
    host: cfg.host,
    port: cfg.port,
    database: cfg.database,
    user: cfg.user,
    password: { mode: 'env', var: 'ONRAMP_TEST_PG_PASSWORD' },
    ssl: false,
    schema,
  };
}

/**
 * How many backends this service holds open, by `application_name`.
 *
 * Scoped to one schema when given one. Vitest runs suites in parallel against a shared database,
 * so an unscoped count is every other suite's connections as well, which made this both wrong and
 * intermittently wrong, depending on what else happened to be running.
 */
export async function liveBackends(schema?: string): Promise<number> {
  const name = schema === undefined ? 'onramp-adapter' : `onramp-adapter/${schema}`;
  return admin(async (pool) => {
    const result = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM pg_stat_activity WHERE application_name = $1',
      [name],
    );
    return Number(result.rows[0]?.count ?? '0');
  });
}

/**
 * Kill the backends one store is holding, as a CloudSQL failover does.
 *
 * Scoped to a single schema. An unscoped version killed every suite's connections, not just this
 * one's: the tests run in parallel against one database, so "this suite's backends" is only meaningful
 * per schema. Returns how many were terminated.
 */
export async function terminateBackends(schema: string): Promise<number> {
  return admin(async (pool) => {
    const result = await pool.query(
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity ' +
        'WHERE application_name = $1 AND pid <> pg_backend_pid()',
      [`onramp-adapter/${schema}`],
    );
    return result.rowCount ?? 0;
  });
}

/** The password the test database expects, for the suites that mount it as a file. */
export function storePassword(): string {
  return baseConfig().password.expose();
}

/**
 * Drop every schema this process created.
 *
 * `withStore` cleans up after itself, but the suites that boot the whole service create a schema
 * per config file and hand it to a child process, so there is no scope to drop it in. Without this
 * a developer's test database accumulates a schema per boot, for ever.
 *
 * Scoped to this process's own prefix so parallel vitest workers cannot drop each other's.
 */
export async function dropOwnSchemas(): Promise<void> {
  await admin(async (pool) => {
    const found = await pool.query<{ schema_name: string }>(
      'SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE $1',
      [`t_${String(process.pid)}\\_%`],
    );
    for (const row of found.rows) await pool.query(`DROP SCHEMA IF EXISTS "${row.schema_name}" CASCADE`);
  });
}

/**
 * Hold a row lock open while `body` runs, on a connection of its own.
 *
 * This is what makes `FOR UPDATE SKIP LOCKED` observable. Concurrent `claim` calls do not prove
 * it: without `SKIP LOCKED` the losers block on the winner's transaction, wait their turn, and
 * come away with the same partition of rows; every assertion about which rows went where holds
 * either way. Removing `SKIP LOCKED` from the query leaves the whole store suite green.
 *
 * The property that actually distinguishes the two is that a claimant meeting a locked row
 * does not wait for it. So: take the lock here, keep it, and let the caller time a claim
 * against it. Skipping returns promptly without the locked row; blocking returns nothing until
 * this transaction ends.
 */
export async function whileRowLocked<T>(schema: string, id: string, body: () => Promise<T>): Promise<T> {
  const cfg = baseConfig();
  const pool = new Pool({
    host: cfg.host,
    port: cfg.port,
    database: cfg.database,
    user: cfg.user,
    password: cfg.password.expose(),
    options: `-c search_path="${schema}"`,
    max: 1,
  });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM funding_requests WHERE id = $1 FOR UPDATE', [id]);
    return await body();
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
    await pool.end();
  }
}

/**
 * Run arbitrary SQL against one schema, outside any store, and return its rows.
 *
 * Here rather than in the suite that wants it, because building a second connection by hand means
 * a second place to get the credentials right, which is exactly what happened: a duplicate that
 * omitted the password passed against a local trust-auth Postgres and failed in CI.
 */
export async function rawQuery(schema: string, sql: string): Promise<Record<string, unknown>[]> {
  const cfg = baseConfig();
  const pool = new Pool({
    host: cfg.host,
    port: cfg.port,
    database: cfg.database,
    user: cfg.user,
    password: cfg.password.expose(),
    options: `-c search_path="${schema}"`,
    max: 1,
  });
  try {
    return (await pool.query(sql)).rows as Record<string, unknown>[];
  } finally {
    await pool.end();
  }
}
