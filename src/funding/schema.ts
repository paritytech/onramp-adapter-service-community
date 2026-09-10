/**
 * The funding store's schema, versioned.
 *
 * The SQLite migration chain is gone, and deleting it was the point of moving. v0->v1->v2->v3
 * existed to bring an on-disk SQLite file forward in place; the Postgres chain is 1->2->3->4, with
 * 3->4 adding `cancelled_at`. Nothing was ever deployed, so that chain migrated a population of
 * zero, and CloudSQL starts from an empty database, so porting it would have meant carrying three
 * migrations for no rows, expressed against an engine this service has left. The v3 shape is the v1 shape
 * here.
 *
 * The machinery stays, because the next migration is not hypothetical: `schema_migrations` records
 * what has run, and `store.ts` takes a `pg_advisory_lock` around the whole sequence so two booting
 * replicas cannot both decide they are the one migrating. That lock replaces SQLite's
 * `BEGIN IMMEDIATE`, which served the same purpose against one file.
 */

import { FUNDING_STATES } from './state.js';

/** The current schema version. Bump with each migration added here. */
export const SCHEMA_VERSION = 4;

/** A migration: bring the previous version's rows to this version's shape. */
export interface Migration {
  /** Only applied to a database currently at `from`. */
  from: number;
  /** The version this step reaches. Steps run one at a time, in `from` order. */
  to: number;
  /** SQL run inside one transaction, in order, to reach the `to` shape. */
  sql: string[];
}

/**
 * The ordered migration list.
 *
 * A fresh database is created at `SCHEMA_VERSION` directly by `freshSchema()`, so this list is
 * what an existing database walks through, one step at a time. The next migration appends
 * `{ from: 4, to: 5, sql: [...] }` and bumps `SCHEMA_VERSION`; `store.ts` needs no change.
 *
 * This chain is one-way. A build expecting v1 refuses a v2 database: the version check is
 * `!==`, deliberately, because reading a shape you do not understand is worse than not starting.
 * So rolling the image back past a migration means restoring the database first.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    from: 1,
    to: 2,
    /**
     * v1 -> v2: record the buyer's country.
     *
     * It was validated, sent to the rail, and then forgotten. Three things followed from that.
     * A dispute could not be answered with the jurisdiction a purchase transacted under. The
     * idempotency-equality check could not include it, so a replay under one key could serve terms
     * the caller was no longer expressing. And the rail's own country, which selects the provider
     * set, the fee schedule and the KYC path, was unrecoverable after the fact.
     *
     * Nullable, because rows written before this migration genuinely do not have one.
     */
    sql: ['ALTER TABLE funding_requests ADD COLUMN country TEXT'],
  },
  {
    from: 2,
    to: 3,
    /**
     * v2 -> v3: record why a request was refused.
     *
     * `refused` has two producers that mean different things. A local validation failure never
     * reached a payment rail. A definitive rail rejection did: the rail read the request and said
     * no. The audit stream has told these apart since it was written (`session.refused` against
     * `session.rail_refused`), but the row did not, so `status = 'refused'` answered "was this
     * refused?" and nothing else.
     *
     * That cost three things. A caller reading their own history under `?includeRefused=true` got
     * rows they could not act on: no way to distinguish "you are below the $20 minimum" from
     * "that address is malformed". "Is the rail rejecting more than usual?" could only be answered
     * by joining a log, which is a log and not a table. And the prune's own docstring claimed only
     * the local producer existed, which is how the gap was found.
     *
     * The value is `Refusal.failure.tag` (a closed union in `contract.ts`, already computed at
     * both producers), so this column records a vocabulary that exists rather than inventing one.
     * Deliberately not a new funding state: a ninth state is wire-visible, and the consumer
     * understands none of the eight.
     *
     * Nullable, because it is null for every non-refused row and for refusals written before this.
     */
    sql: ['ALTER TABLE funding_requests ADD COLUMN reason TEXT'],
  },
  {
    from: 3,
    to: 4,
    /**
     * v3 -> v4: record that the caller withdrew the request.
     *
     * The consumer lets a buyer cancel a top-up. Nothing here knew that, so a cancelled purchase
     * kept a live settlement surface: `GET /funding/:id` went on handing back the capture page for
     * the rest of the session window, and paying it would have landed money against a request the
     * buyer had been told was over.
     *
     * A column, not a ninth state, for the same reason `reason` was one (v2 -> v3). A state is
     * wire-visible and the consumer understands none of the eight it already has. More than that,
     * a terminal state would be wrong. Cancelling withdraws the surface; it does not settle the
     * question of whether a payment is already on its way. A payment sent seconds before the
     * cancel still has to be observed, and a terminal row leaves the worker's scan. So the buyer
     * would have paid and nothing would ever have looked. The row stays in-flight and the worker
     * keeps watching; only the surface goes.
     *
     * Nullable, and null is the overwhelming majority: it means "not cancelled".
     */
    sql: ['ALTER TABLE funding_requests ADD COLUMN cancelled_at BIGINT'],
  },
];

/**
 * The SQL that creates a fresh database at the current schema version.
 *
 * Types worth naming. Every timestamp is epoch milliseconds in `BIGINT`. `INTEGER` is 32-bit in
 * Postgres and overflows in 1970 + 24 days. `status_history` stays `TEXT` holding JSON rather than
 * becoming `JSONB`: nothing queries inside it, and `JSONB` would reorder keys and strip the
 * duplicate-timestamp entries a timeline is allowed to contain.
 *
 * `claimed_by` / `claimed_until` are the worker's lease. SQLite enforced one writer physically
 * (a single file on a ReadWriteOnce volume), and Postgres does not, so the guarantee that two
 * workers never advance the same request has to be expressed in the schema instead of inherited
 * from the storage engine.
 */
export function freshSchema(): string[] {
  return [
    'CREATE TABLE funding_requests (' +
      ' id TEXT PRIMARY KEY,' +
      ' subject_alias TEXT NOT NULL,' +
      ' product_id TEXT NOT NULL,' +
      ' destination_currency_code TEXT NOT NULL,' +
      ' wallet_address TEXT NOT NULL,' +
      ' source_amount TEXT NOT NULL,' +
      ' fiat TEXT NOT NULL,' +
      ' payment_method_type TEXT NOT NULL,' +
      ' country TEXT,' +
      ' service_provider TEXT,' +
      ' client_reference TEXT,' +
      ' rail TEXT NOT NULL,' +
      ' provider_session_id TEXT,' +
      ' provider_transaction_id TEXT,' +
      ' provider_status TEXT,' +
      ' widget_url TEXT,' +
      ' hosted_widget_url TEXT,' +
      ' expires_at BIGINT,' +
      ' status TEXT NOT NULL,' +
      ' status_history TEXT NOT NULL,' +
      ' created_at BIGINT NOT NULL,' +
      ' updated_at BIGINT NOT NULL,' +
      ' claimed_by TEXT,' +
      ' claimed_until BIGINT,' +
      // Why a refusal was refused; null on every other state. See the v2 -> v3 migration.
      ' reason TEXT,' +
      // When the caller withdrew the request. See the v3 -> v4 migration.
      ' cancelled_at BIGINT,' +
      // The vocabulary, enforced by the database rather than only by the state machine.
      // `update()` validates transitions inside its transaction, but `create()` writes whatever
      // status it is handed; both production callers are correct and nothing at the storage layer
      // stopped a third, or a hand-run migration, from writing a state `state.ts` does not have.
      // This does not constrain transitions, only the alphabet; the machine still owns the moves.
      ` CHECK (status IN (${FUNDING_STATES.map((state) => `'${state}'`).join(', ')}))` +
      ')',
    'CREATE INDEX funding_by_alias ON funding_requests (subject_alias, product_id, created_at DESC, id DESC)',
    // Partial, matching the `WHERE client_reference IS NOT NULL` predicate exactly: a refused row
    // deliberately claims no key, and several of those under one caller must not collide.
    'CREATE UNIQUE INDEX funding_by_reference ON funding_requests (subject_alias, product_id, client_reference) ' +
      'WHERE client_reference IS NOT NULL',
    // The worker's claim scan orders by (created_at, id) within the non-terminal rows. Leading on
    // `status` lets the planner cut to those first.
    'CREATE INDEX funding_claim_scan ON funding_requests (status, created_at, id)',
  ];
}

/** The bookkeeping table that records which migrations have run. Created before any of them do. */
export const MIGRATIONS_TABLE =
  'CREATE TABLE IF NOT EXISTS schema_migrations (' +
  ' version INTEGER PRIMARY KEY,' +
  ' applied_at BIGINT NOT NULL' +
  ')';

/**
 * The advisory-lock key the migration sequence serializes on.
 *
 * An arbitrary constant, and it only has to be stable and not collide with another application's
 * key in the same database. `pg_advisory_lock` is session-scoped, so it must be taken and released
 * on one pooled connection.
 */
export const MIGRATION_LOCK_KEY = 0x0117_ad07;

/**
 * How long a booting replica waits for that lock before giving up.
 *
 * Sized against the startup probe in `helm/templates/deployment.yaml`, which is
 * `periodSeconds x failureThreshold`: 10 x 12 = 120s today. This must land comfortably inside it,
 * so the replica fails with a message the operator can read rather than being killed mid-wait.
 * Half the budget leaves room for the connect, one probe period, and the log to be shipped.
 */
export const MIGRATION_LOCK_TIMEOUT_MS = 60_000;
