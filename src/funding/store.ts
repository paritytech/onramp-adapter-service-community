/**
 * The durable funding-request store, on CloudSQL Postgres.
 *
 * The deployment target is CloudSQL. Postgres speaks over a socket, so the whole surface is
 * async, and `FundingStore.open()` stands in for a constructor because a constructor cannot await
 * its own migration.
 *
 * One table, provider-neutral. A request records its `rail` and the neutral `provider_*`
 * facts, not Meld-specific columns. The status surface answers from the neutral facts; a caller
 * never sees a rail's internals (see `types.ts`).
 *
 * Two guarantees SQLite gave physically now have to be written down, because Postgres does not
 * give them away:
 *
 *  - One writer per request. A single file on a ReadWriteOnce volume could only ever have one.
 *    Here the worker takes a lease (`claimed_by` / `claimed_until`) and every advance names its
 *    claim, so a second worker's update matches zero rows instead of racing.
 *  - One migrator. `BEGIN IMMEDIATE` stopped two booting processes both migrating one file.
 *    `pg_advisory_lock` does it across replicas.
 */

import { Pool, types as pgTypes, type PoolClient, type PoolConfig } from 'pg';

import type { FundingFailure } from '../contract.js';
import type { RailName } from '../rail.js';
import type { Secret } from '../secret.js';
import type { FundingState } from './state.js';
import { TERMINAL_STATES } from './state.js';
import {
  MIGRATIONS,
  MIGRATIONS_TABLE,
  MIGRATION_LOCK_KEY,
  MIGRATION_LOCK_TIMEOUT_MS,
  SCHEMA_VERSION,
  freshSchema,
  type Migration,
} from './schema.js';
import { mergeAdvance, type UpdateExtra } from './merge.js';
import type { FundingRecord, TimelineEntry } from './types.js';

/**
 * Read `BIGINT` as a number, not a string.
 *
 * `pg` returns OID 20 (`int8`) as a string by default, because a 64-bit integer does not fit a JS
 * number in general. Ours are epoch milliseconds and amounts are `TEXT`, so every `BIGINT` here is
 * far below `Number.MAX_SAFE_INTEGER` (year 287396), and the string would otherwise flow into
 * `FundingRecord.created_at` typed as `number`, where `>` still compiles and compares
 * lexicographically. That is a silently wrong deadline comparison in the worker, so it is fixed at
 * the driver rather than at each read.
 */
pgTypes.setTypeParser(pgTypes.builtins.INT8, (value: string) => Number(value));

/**
 * The `ssl` value handed to `pg`, as a pure function so it can be asserted directly.
 *
 * The branch that matters is the one no test connects through: every suite runs over loopback with
 * TLS off, so `rejectUnauthorized` was a production-only value and flipping it to `false` (which
 * accepts any certificate and encrypts the link to whoever answered) left the suite green.
 */
export function sslOptions(enabled: boolean): { rejectUnauthorized: true } | false {
  return enabled ? { rejectUnauthorized: true } : false;
}

/** How the store reaches Postgres. Mirrors the `store` block in config. */
export interface StoreConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  /**
   * Read from a mounted file outside development, like the Meld key and the JWT key.
   *
   * Kept wrapped to here rather than resolved at the call site: `expose()` is greppable, and the
   * single call below is the only place this credential becomes a plain string.
   */
  password: Secret;
  ssl: boolean;
  /**
   * Postgres schema to resolve unqualified names in. Omitted outside tests, where the default
   * `public` is what CloudSQL provides; the test harness gives each case its own schema so two
   * suites cannot see each other's rows.
   */
  searchPath?: string;
  /**
   * Per-replica connection ceiling.
   *
   * This process serves HTTP and runs the worker against one pool. A pool large enough to let
   * the worker saturate it is a pool that can starve request handlers, so the worker claims in
   * small batches and the ceiling stays low.
   */
  poolMax: number;
  /** Refuse a query that has run away rather than hold a connection for ever. */
  statementTimeoutMs: number;
  connectionTimeoutMs: number;
}

/** The outcome of a reservation attempt. See `reserve`. */
export type Reservation =
  /** The row belongs to this caller: nothing else held their key. */
  | { outcome: 'inserted' }
  /** Another request holds this caller's key, and here is its row. */
  | { outcome: 'existing'; record: FundingRecord };

/**
 * The single source of truth for the funding row's column order.
 *
 * `INSERT`, every `SELECT ${COLUMNS}`, and `recordToRow` all derive from this one list, so a
 * transposition anywhere in the tuple cannot silently write the wrong value into the wrong
 * column. The positional restatement this replaces was unreachable by the round-trip test, which
 * binds `created_at === updated_at` from one fixture and so could not notice a trailing swap.
 */
export const COLUMN_LIST = [
  'id',
  'subject_alias',
  'product_id',
  'destination_currency_code',
  'wallet_address',
  'source_amount',
  'fiat',
  'payment_method_type',
  'country',
  'service_provider',
  'client_reference',
  'rail',
  'provider_session_id',
  'provider_transaction_id',
  'provider_status',
  'widget_url',
  'hosted_widget_url',
  'expires_at',
  'status',
  'reason',
  'cancelled_at',
  'status_history',
  'created_at',
  'updated_at',
] as const;

const COLUMNS = COLUMN_LIST.join(', ');

/** `($1,$2,...,$N)` for the column list, computed from its own length. */
const PLACEHOLDERS = COLUMN_LIST.map((_c, i) => `$${String(i + 1)}`).join(',');

const INSERT_QUERY = `INSERT INTO funding_requests (${COLUMNS}) VALUES (${PLACEHOLDERS})`;

/**
 * The reservation insert: absorb a duplicate idempotency key, and nothing else.
 *
 * The conflict target has to name the partial unique index by its own predicate, or Postgres
 * cannot resolve which index is meant. Written once because `reserve` issues it twice (the retry
 * path), and two copies is two places for the predicate to drift out of step with
 * `freshSchema()`'s `WHERE client_reference IS NOT NULL`.
 *
 * A primary-key collision is deliberately not absorbed: ids come from `newId()` and are never
 * reused, so a same-id insert is a bug worth hearing about rather than a replay to serve.
 */
const RESERVE_QUERY =
  `${INSERT_QUERY} ON CONFLICT (subject_alias, product_id, client_reference) ` +
  'WHERE client_reference IS NOT NULL DO NOTHING';

/**
 * The one per-row mutation. It writes every mutable column, not only the status: unchanged ones
 * are re-bound from the merged record inside `update`, which is why the list is long. Driven by the
 * worker and by `Onramp`, which uses it to release a reservation and to open a session.
 *
 * `$13` is the claim guard. When the caller holds a lease the update matches only while that lease
 * is still theirs; `Onramp` passes null and matches on the id alone, because a request path is not
 * leased and is the only writer of the row it just reserved.
 */
const UPDATE_QUERY =
  'UPDATE funding_requests ' +
  'SET status = $1, status_history = $2, provider_transaction_id = $3, provider_session_id = $4, ' +
  '    provider_status = $5, widget_url = $6, hosted_widget_url = $7, expires_at = $8, ' +
  '    client_reference = $9, reason = $10, updated_at = $11 ' +
  'WHERE id = $12 AND ($13::text IS NULL OR claimed_by = $13)';


/**
 * The store. Owns the pool and every statement; the rest of the service talks to it only through
 * `reserve`, `create`, `byId`, `byAlias`, `cancel`, `byReference`, `list`, `pruneRefusals`,
 * `claim`, `release`, `update` and `close`.
 */
export class FundingStore {
  private constructor(private readonly pool: Pool) {}

  /**
   * Connect, migrate, and hand back a ready store.
   *
   * A static factory rather than a constructor because the migration is awaited. `startup.ts`
   * calls this before the port opens, so a database that cannot be reached or cannot be migrated
   * is a boot failure. That is the same shape as a rejected Meld credential, and for the same
   * reason: neither improves on its own.
   */
  static async open(cfg: StoreConfig, migrations: readonly Migration[] = MIGRATIONS): Promise<FundingStore> {
    const poolConfig: PoolConfig = {
      host: cfg.host,
      port: cfg.port,
      database: cfg.database,
      user: cfg.user,
      // A function, not a string. `pg` accepts either, and a string becomes a stable field on
      // `pool.options` and on every `Client` for the life of the process. That is against
      // `secret.ts`'s own rule, "call at the point of use, never store the result", which the Meld
      // key (a per-request header) and the JWT key (two HKDF calls at boot) both honour. Resolved
      // per connection instead, so the plaintext exists for the length of a handshake rather than
      // the length of the process.
      password: () => cfg.password.expose(),
      // `rejectUnauthorized: true` is the whole point of asking for TLS: without it the
      // handshake succeeds against any certificate and the link is encrypted to whoever answered.
      // No test reaches this branch (the harness connects over loopback with `ssl: false`), so it
      // is pinned by `sslOptions` below instead, which is a pure function a test can call.
      ssl: sslOptions(cfg.ssl),
      max: cfg.poolMax,
      // Names this service's backends in `pg_stat_activity`, which is how an operator tells its
      // connections from anything else sharing the instance, and how the boot-failure test
      // proves the pool was actually drained rather than leaked.
      //
      // Qualified by schema when there is one. In production there is not, so this reads
      // `onramp-adapter`. In tests every case has its own schema, and without the suffix a suite
      // that counts or terminates this service's backends reaches into every other suite beside it.
      application_name: cfg.searchPath === undefined ? 'onramp-adapter' : `onramp-adapter/${cfg.searchPath}`,
      connectionTimeoutMillis: cfg.connectionTimeoutMs,
      statement_timeout: cfg.statementTimeoutMs,
      // An idle client that the server has already closed is the classic pooled-connection fault:
      // it is handed to a caller and fails on first use. Recycling keeps them fresh.
      idleTimeoutMillis: 30_000,
      maxLifetimeSeconds: 1800,
      // Set per connection rather than with a `SET` after connecting: a pooled client that was
      // recycled mid-suite would otherwise come back pointing at `public`.
      ...(cfg.searchPath === undefined ? {} : { options: `-c search_path="${cfg.searchPath}"` }),
    };
    const pool = new Pool(poolConfig);
    // A pool emits errors for idle clients outside any query. Without a listener Node treats
    // that as an unhandled error event and takes the process down, in the middle of a routine
    // CloudSQL failover, which is exactly when staying up matters.
    pool.on('error', () => {
      /* handled per-query; an idle-client fault must not kill the process */
    });

    const store = new FundingStore(pool);
    try {
      await store.migrate(migrations);
    } catch (error) {
      await pool.end();
      throw error;
    }
    return store;
  }

  /**
   * Create the schema, or bring an existing database forward one step at a time.
   *
   * The whole sequence runs under a session-scoped advisory lock on one connection, so two
   * replicas booting together serialize: the loser waits, then finds the version already current
   * and applies nothing. This is what `BEGIN IMMEDIATE` did for one SQLite file.
   *
   * The list is a parameter, defaulting to the real one, so the tests can inject a synthetic chain
   * and exercise the apply, the version stamp and the rollback. The two real migrations (v1 to v2
   * adding `country`, v2 to v3 adding `reason`) are both run as shipped by `schema.test.ts`, so
   * the applier is never first exercised in production.
   */
  private async migrate(migrations: readonly Migration[]): Promise<void> {
    const client = await this.pool.connect();
    try {
      // The pool's `statement_timeout` bounds a request-path query, and a migration is not one.
      // A single `ALTER TABLE` over a table with real rows in it outlasts ten seconds easily, and
      // being killed mid-migration means a crash loop with the rollback path as the only clue.
      // Different work, different bound: none here, and the advisory lock is what stops a second
      // replica piling in behind a slow one.
      await client.query('SET statement_timeout = 0');
      // A bound on waiting for the lock, which the cleared statement timeout no longer covers.
      // Without it a replica stuck mid-migration parks every other boot behind it indefinitely.
      //
      // It must land comfortably inside the startup probe's budget, which is what it exists to
      // beat. The probe is `periodSeconds x failureThreshold` in
      // `helm/templates/deployment.yaml`, currently 10 x 12 = 120s. At 120s the timeout fired at
      // the exact moment Kubernetes gave up, so the error raced the kill and the operator saw a
      // CrashLoop with no cause either way: the failure this bound was added to make legible.
      //
      // Half the budget leaves room for the connect, the probe's own period, and the log line to
      // be written and shipped. The two numbers are coupled: raising `failureThreshold` without
      // revisiting this only widens the margin, but lowering it below 60s inverts the relationship
      // and the chart says so at its end.
      await client.query(`SET lock_timeout = '${String(MIGRATION_LOCK_TIMEOUT_MS)}ms'`);
      await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
      try {
        await client.query(MIGRATIONS_TABLE);
        const tableExists = await client.query<{ exists: boolean }>(
          "SELECT to_regclass('funding_requests') IS NOT NULL AS exists",
        );
        let version = await this.schemaVersion(client);

        if (!(tableExists.rows[0]?.exists ?? false)) {
          // A brand-new database: create the current shape and record it, rather than walking a
          // migration chain that has no older shape to start from.
          await client.query('BEGIN');
          try {
            for (const sql of freshSchema()) await client.query(sql);
            await client.query('INSERT INTO schema_migrations (version, applied_at) VALUES ($1, $2)', [
              SCHEMA_VERSION,
              Date.now(),
            ]);
            await client.query('COMMIT');
            version = SCHEMA_VERSION;
          } catch (error) {
            await client.query('ROLLBACK');
            throw error;
          }
        } else {
          for (const migration of migrations) {
            // Migrations are a linear chain: at any version exactly one is next. Anything already
            // passed (including a database a newer build brought this far) is a no-op.
            if (migration.from !== version) continue;
            await client.query('BEGIN');
            try {
              for (const sql of migration.sql) await client.query(sql);
              await client.query('INSERT INTO schema_migrations (version, applied_at) VALUES ($1, $2)', [
                migration.to,
                Date.now(),
              ]);
              await client.query('COMMIT');
              version = migration.to;
            } catch (error) {
              await client.query('ROLLBACK');
              throw error;
            }
          }
        }

        // `!==`, not `>`. Rejecting only newer left the opposite case silent: a database whose
        // table exists but whose recorded version is below this build's, with no migration
        // declaring a step from it, applies nothing and falls straight through; the service
        // then serves requests against a shape it does not understand. A version this build cannot
        // reach is a boot failure whichever side of current it is on.
        if (version !== SCHEMA_VERSION) {
          throw new Error(
            `funding schema is at version ${String(version)} and this build requires exactly ` +
              `${String(SCHEMA_VERSION)}: ${version > SCHEMA_VERSION ? 'it was migrated by a newer build' : 'no migration reaches the current version from here'}.`,
          );
        }
      } finally {
        await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
      }
    } finally {
      client.release();
    }
  }

  /** The database's current schema version. An empty database has no rows and starts at 0. */
  private async schemaVersion(client: PoolClient): Promise<number> {
    const result = await client.query<{ version: number }>('SELECT MAX(version) AS version FROM schema_migrations');
    return result.rows[0]?.version ?? 0;
  }

  /**
   * Take the caller's idempotency key, or report who already holds it.
   *
   * An insert wrapped in a bare `catch {}` could not tell a duplicate key from a dead connection:
   * both throw, both fall into the same re-read, and a genuine store fault would reach the caller
   * as "reservation failed for an unknown reason". On Postgres a failed insert also poisons its
   * transaction, so the re-read could fail too.
   *
   * `ON CONFLICT` names the partial unique index by its own predicate, so it arbitrates the
   * idempotency key and only that. A primary-key collision is a different fault (ids come from
   * `newId()` and are never reused) and still throws, which is the fault worth hearing about.
   */
  async reserve(record: FundingRecord): Promise<Reservation> {
    // A precondition, checked before the insert rather than defaulted after it.
    //
    // The `ON CONFLICT` target is the partial index, which only applies `WHERE client_reference IS
    // NOT NULL`, so a record without one never conflicts, the insert simply succeeds, and the
    // caller gets `inserted` for a row that reserves nothing. The two `?? ''` fallbacks this
    // replaces sat on the conflict path where they could not be reached at all, and would have
    // looked up a different row under the empty key if they ever were.
    const reference = record.client_reference;
    if (reference === undefined) {
      throw new Error('reserve requires a client_reference: the partial unique index does not apply without one');
    }

    const inserted = await this.pool.query(RESERVE_QUERY, recordToRow(record));
    if (inserted.rowCount === 1) return { outcome: 'inserted' };

    const existing = await this.byReference(record.subject_alias, record.product_id, reference);
    if (existing !== undefined) return { outcome: 'existing', record: existing };

    // The conflict was real and the holder is already gone. Not hypothetical. `Onramp` releases a
    // caller's reference (sets `client_reference` to NULL) whenever the rail refuses to open a
    // session, so between this insert and the read-back the winning row can legitimately stop
    // holding the key.
    //
    // The key really is free now, so the honest answer is to take it rather than to report a
    // conflict with nothing to point at. One retry, not a loop: a second failure would mean the
    // key is being taken and released faster than a round trip, which is not a caller this service
    // owes a successful reservation to.
    const retried = await this.pool.query(RESERVE_QUERY, recordToRow(record));
    if (retried.rowCount === 1) return { outcome: 'inserted' };

    const holder = await this.byReference(record.subject_alias, record.product_id, reference);
    if (holder === undefined) {
      throw new Error('funding reservation conflicted twice with no holder either time');
    }
    return { outcome: 'existing', record: holder };
  }

  /**
   * Insert a row that claims no idempotency key: today, the refused-request audit row.
   *
   * An id collision is a primary-key failure, surfaced as thrown rather than silently overwritten:
   * nothing here ever re-uses an id, so a same-id re-insert would be a bug worth hearing about.
   */
  async create(record: FundingRecord): Promise<void> {
    await this.pool.query(INSERT_QUERY, recordToRow(record));
  }

  /** One request, or undefined. Unscoped; callers that must not cross aliases use `byAlias`. */
  async byId(id: string): Promise<FundingRecord | undefined> {
    return this.one(`SELECT ${COLUMNS} FROM funding_requests WHERE id = $1`, [id]);
  }

  /** One request, only if it belongs to `alias` and `productId`. Enforces caller-scoping. */
  async byAlias(id: string, alias: string, productId: string): Promise<FundingRecord | undefined> {
    return this.one(`SELECT ${COLUMNS} FROM funding_requests WHERE id = $1 AND subject_alias = $2 AND product_id = $3`, [
      id,
      alias,
      productId,
    ]);
  }

  /**
   * Withdraw a request's settlement surface, at the caller's request.
   *
   * Scoped and conditional in one statement, deliberately. A read-then-write would let a
   * transaction arrive between the two, and the row this must never cancel is exactly the one that
   * has just been paid. The `WHERE` carries every condition, so the database decides:
   *
   * - `subject_alias`/`product_id`: a caller may only withdraw their own request.
   * - `status IN ('created', 'session_opened')`: a `transaction_seen` row has a payment against
   *   it, and telling that buyer their top-up is cancelled while their money is in flight is the
   *   claim this service exists not to make. Terminal rows are already over.
   * - `cancelled_at IS NULL`: cancelling twice must not move the timestamp.
   *
   * The status is left alone on purpose. See `FundingRecord.cancelled_at`. The worker goes on
   * watching, so a payment already on its way is still observed and still settles.
   *
   * Returns the row as it now stands, or `undefined` when nothing matched, which the caller turns
   * into a refusal it can explain, since "not yours", "already paid" and "already cancelled" are
   * three different answers and only the row can tell them apart.
   */
  async cancel(alias: string, productId: string, id: string, now: number): Promise<FundingRecord | undefined> {
    const updated = await this.one(
      'UPDATE funding_requests SET cancelled_at = $1, updated_at = $1 ' +
        'WHERE id = $2 AND subject_alias = $3 AND product_id = $4 ' +
        "AND status IN ('created', 'session_opened') AND cancelled_at IS NULL " +
        `RETURNING ${COLUMNS}`,
      [now, id, alias, productId],
    );
    return updated;
  }

  /**
   * The caller's earlier request under this reference, if any.
   *
   * Scoped by caller and product, matching the unique index: two callers may legitimately use the
   * same key. This is what makes `idempotencyKey` mean something. Without it a retried
   * `POST /session` opened a second upstream session for one buyer intent.
   */
  async byReference(alias: string, productId: string, reference: string): Promise<FundingRecord | undefined> {
    return this.one(
      `SELECT ${COLUMNS} FROM funding_requests WHERE subject_alias = $1 AND product_id = $2 AND client_reference = $3`,
      [alias, productId, reference],
    );
  }

  /**
   * A caller's requests for one product, newest first, bounded so one account cannot page an
   * unbounded body out of the service.
   *
   * `id` breaks a timestamp tie. Two requests filed in the same millisecond are ordinary, and
   * ordering on `created_at` alone leaves their order to the planner, which may answer differently
   * between an index scan and a sequential one.
   */
  async list(
    alias: string,
    productId: string,
    limit = 100,
    /**
     * Include refused rows, which are excluded by default.
     *
     * A refusal is written for every local validation failure, and, because minimum amounts are
     * per (destination, currency) and there is no discovery route, being refused is how a caller
     * learns a minimum. So refusals are ordinary traffic, not an error path, and at a hundred
     * rows newest-first they would push a buyer's live request out of their own history. That is
     * the one row in this list they are actually waiting on.
     *
     * They are kept rather than dropped: they are the durable record behind the `session.refused`
     * audit line, and an operator answering "why did this caller get nothing" needs them.
     */
    includeRefused = false,
  ): Promise<FundingRecord[]> {
    return this.many(
      `SELECT ${COLUMNS} FROM funding_requests WHERE subject_alias = $1 AND product_id = $2 ` +
        (includeRefused ? '' : "AND status <> 'refused' ") +
        'ORDER BY created_at DESC, id DESC LIMIT $3',
      [alias, productId, limit],
    );
  }

  /**
   * Delete refused rows older than `cutoff`, in bounded batches, returning how many went.
   *
   * Both producers, deliberately. `refused` is written by a local validation failure that never
   * reached a rail and by a definitive rail rejection that did (`reason` tells them apart), and
   * neither records a payment. An indefinite failure is not here at all: it concludes `unobserved`
   * precisely so its row survives, because nobody can say the buyer did not pay.
   *
   * Only `refused`. Every other terminal state records something that reached a payment rail, and
   * a buyer's purchase history is not this service's to expire.
   *
   * Batched, because one unbounded `DELETE` runs under the request path's own
   * `statement_timeout`. The first sweep after real traffic is exactly when a backlog exists,
   * and a statement killed at ten seconds leaves the caller logging a warning and not trying
   * again for an hour. The next sweep meets the same backlog and the same timeout, so that hour is
   * effectively for ever, while the table grows and the docs say it is bounded.
   * Each batch is its own statement, so progress survives a timeout even if the sweep does not
   * finish.
   */
  async pruneRefusals(cutoff: number, batch = 5_000): Promise<number> {
    let deleted = 0;
    for (;;) {
      const result = await this.pool.query(
        "DELETE FROM funding_requests WHERE ctid IN (" +
          "  SELECT ctid FROM funding_requests WHERE status = 'refused' AND created_at < $1 LIMIT $2" +
          ')',
        [cutoff, batch],
      );
      const went = result.rowCount ?? 0;
      deleted += went;
      if (went < batch) return deleted;
    }
  }

  /**
   * Lease a batch of in-flight requests to one worker.
   *
   * `FOR UPDATE SKIP LOCKED` is the claiming primitive, but the lock is held only for the length
   * of this statement: the worker then talks to a payment rail over the network, and holding a
   * row lock across that would turn upstream slowness into database contention and burn a pooled
   * connection per in-flight request. The lease outlives the lock instead.
   *
   * `limit` is small on purpose. A worker that claims everything and then trips its failure
   * ceiling leaves the rest leased and unlooked-at until expiry, which is the starvation the
   * ceiling exists to prevent, wearing a new hat. Small batches bound how much a trip can strand,
   * and `release` hands back what the tick did not reach.
   */
  async claim(workerId: string, now: number, leaseMs: number, limit: number): Promise<FundingRecord[]> {
    const terminal = TERMINAL_STATES.map((_, index) => `$${String(index + 4)}`).join(',');
    const limitParam = `$${String(TERMINAL_STATES.length + 4)}`;
    // The outer `ORDER BY` is not decoration. `RETURNING` promises nothing about order: it
    // answers in whatever order the update touched rows, which is not the inner `ORDER BY`. The
    // worker's per-record isolation argument rests on draining oldest-first. Newest-first lets a
    // steady arrival rate keep the oldest stuck request at the back of every tick for ever.
    return this.many(
      'WITH claimed AS (' +
        '  UPDATE funding_requests SET claimed_by = $1, claimed_until = $2 WHERE id IN (' +
        `    SELECT id FROM funding_requests WHERE status NOT IN (${terminal}) ` +
        '      AND (claimed_until IS NULL OR claimed_until < $3) ' +
        `    ORDER BY created_at ASC, id ASC LIMIT ${limitParam} ` +
        '    FOR UPDATE SKIP LOCKED' +
        `  ) RETURNING ${COLUMNS}` +
        `) SELECT ${COLUMNS} FROM claimed ORDER BY created_at ASC, id ASC`,
      [workerId, now + leaseMs, now, ...TERMINAL_STATES, limit],
    );
  }

  /**
   * Hand back rows this worker leased but did not reach.
   *
   * Scoped to `workerId` so a lease that already expired and was re-taken by someone else is not
   * cleared out from under them. Lease expiry is for crash recovery only; a live worker releases
   * what it is done with, which is what keeps the next tick from waiting out a timeout.
   */
  async release(workerId: string, ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.pool.query(
      'UPDATE funding_requests SET claimed_by = NULL, claimed_until = NULL WHERE claimed_by = $1 AND id = ANY($2)',
      [workerId, [...ids]],
    );
  }

  /**
   * Advance a request to `to`, appending the timeline entry.
   *
   * Validates the transition against the machine before writing (an illegal transition surfaces as
   * a typed error, not a silent partial write). Returns the refreshed record, or `undefined` when
   * the row is gone, or the lease named in `claimedBy` belongs to someone else.
   *
   * The read-modify-write is one transaction, and the read takes `FOR UPDATE` so two overlapping
   * updates to the same row serialize on it rather than racing. Without the row lock the
   * transition is validated against a stale read and an `IllegalTransition` can be computed from a
   * write that already happened. This is the Postgres form of what `BEGIN IMMEDIATE` bought under
   * SQLite's WAL; there the whole write lock was taken up front, because a deferred transaction
   * failed at COMMIT with `SQLITE_BUSY_SNAPSHOT`, which `busy_timeout` would not retry. Postgres
   * blocks on the row instead, so the loser waits and then reads what actually happened.
   */
  async update(
    id: string,
    to: FundingState,
    now: number,
    extra?: UpdateExtra,
  ): Promise<FundingRecord | undefined> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      try {
        const locked = await client.query<Row>(
          `SELECT ${COLUMNS} FROM funding_requests WHERE id = $1 FOR UPDATE`,
          [id],
        );
        const row = locked.rows[0];
        if (row === undefined) {
          await client.query('COMMIT');
          return undefined;
        }
        const previous = rowToRecord(row);
        const updated = mergeAdvance(previous, to, now, extra);

        const written = await client.query(UPDATE_QUERY, [
          updated.status,
          JSON.stringify(updated.status_history),
          updated.provider_transaction_id ?? null,
          updated.provider_session_id ?? null,
          updated.provider_status ?? null,
          updated.widget_url ?? null,
          updated.hosted_widget_url ?? null,
          updated.expires_at ?? null,
          updated.client_reference ?? null,
          updated.reason ?? null,
          updated.updated_at,
          id,
          extra?.claimedBy ?? null,
        ]);
        await client.query('COMMIT');
        // The row exists but the lease moved on: report it the same way as a missing row, so the
        // worker counts nothing as advanced rather than reporting someone else's work as its own.
        return written.rowCount === 1 ? updated : undefined;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    } finally {
      client.release();
    }
  }

  /**
   * Close the pool. `startup`'s `close` calls this last, after the server.
   *
   * Idempotent, because the shutdown path it serves promises to be: `SIGTERM` and `SIGINT` are
   * each owned separately, so a process can be asked to stop twice, and `Pool.end()` rejects on
   * the second call.
   */
  async close(): Promise<void> {
    if (!this.ended) {
      this.ended = true;
      await this.pool.end();
    }
  }

  private ended = false;

  /** Run a query and map the single row it may return. */
  private async one(sql: string, params: unknown[]): Promise<FundingRecord | undefined> {
    const result = await this.pool.query<Row>(sql, params);
    const row = result.rows[0];
    return row === undefined ? undefined : rowToRecord(row);
  }

  /** As `one`, for the queries that return a set. */
  private async many(sql: string, params: unknown[]): Promise<FundingRecord[]> {
    const result = await this.pool.query<Row>(sql, params);
    return result.rows.map(rowToRecord);
  }
}

/** A row as `pg` returns it: snake_case, JSON string for history. */
interface Row {
  id: string;
  subject_alias: string;
  product_id: string;
  destination_currency_code: string;
  wallet_address: string;
  source_amount: string;
  fiat: string;
  payment_method_type: string;
  country: string | null;
  service_provider: string | null;
  client_reference: string | null;
  rail: RailName;
  provider_session_id: string | null;
  provider_transaction_id: string | null;
  provider_status: string | null;
  widget_url: string | null;
  hosted_widget_url: string | null;
  expires_at: number | null;
  status: FundingState;
  reason: FundingFailure['tag'] | null;
  cancelled_at: number | null;
  status_history: string;
  created_at: number;
  updated_at: number;
}

function rowToRecord(row: Row): FundingRecord {
  return {
    ...row,
    country: row.country ?? undefined,
    service_provider: row.service_provider ?? undefined,
    client_reference: row.client_reference ?? undefined,
    provider_session_id: row.provider_session_id ?? undefined,
    provider_transaction_id: row.provider_transaction_id ?? undefined,
    provider_status: row.provider_status ?? undefined,
    widget_url: row.widget_url ?? undefined,
    hosted_widget_url: row.hosted_widget_url ?? undefined,
    expires_at: row.expires_at ?? undefined,
    reason: row.reason ?? undefined,
    cancelled_at: row.cancelled_at ?? undefined,
    status_history: JSON.parse(row.status_history) as TimelineEntry[],
  } satisfies FundingRecord;
}

/**
 * A record into a bindable row, in exactly `COLUMN_LIST` order.
 *
 * Derived from `COLUMN_LIST` so the INSERT and the value tuple cannot drift apart: transposed by
 * hand, values land in the wrong columns and a round-trip test cannot see it. `undefined`
 * nullable strings become null for the driver.
 */
function recordToRow(r: FundingRecord): unknown[] {
  const byName = {
    id: r.id,
    subject_alias: r.subject_alias,
    product_id: r.product_id,
    destination_currency_code: r.destination_currency_code,
    wallet_address: r.wallet_address,
    source_amount: r.source_amount,
    fiat: r.fiat,
    payment_method_type: r.payment_method_type,
    country: r.country ?? null,
    service_provider: r.service_provider ?? null,
    client_reference: r.client_reference ?? null,
    rail: r.rail,
    provider_session_id: r.provider_session_id ?? null,
    provider_transaction_id: r.provider_transaction_id ?? null,
    provider_status: r.provider_status ?? null,
    widget_url: r.widget_url ?? null,
    hosted_widget_url: r.hosted_widget_url ?? null,
    expires_at: r.expires_at ?? null,
    status: r.status,
    reason: r.reason ?? null,
    cancelled_at: r.cancelled_at ?? null,
    status_history: JSON.stringify(r.status_history),
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
  return COLUMN_LIST.map((name) => byName[name]);
}
