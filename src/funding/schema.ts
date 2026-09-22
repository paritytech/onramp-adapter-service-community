/**
 * The funding store's schema, versioned.
 *
 * The SQLite migration chain is gone, and deleting it was the point of moving. v0->v1->v2->v3
 * existed to bring an on-disk SQLite file forward in place; the Postgres chain is
 * 1->2->3->4->5->6->7->8, with 3->4 adding `cancelled_at`, 4->5 adding the supported-corridors
 * cache, 5->6 adding the sell direction and the terms only a sell commits, 6->7 recording a
 * deposit-address disclosure conflict, and 7->8 putting a direction into the supported-corridors
 * cache. Nothing was ever
 * deployed, so that chain migrated a population of
 * zero, and CloudSQL starts from an empty database, so porting it would have meant carrying three
 * migrations for no rows, expressed against an engine this service has left. The v3 shape is the v1 shape
 * here.
 *
 * The machinery stays, because the next migration is not hypothetical: `schema_migrations` records
 * what has run, and `store.ts` takes a `pg_advisory_lock` around the whole sequence so two booting
 * replicas cannot both decide they are the one migrating. That lock replaces SQLite's
 * `BEGIN IMMEDIATE`, which served the same purpose against one file.
 */

import { DIRECTIONS } from '../rail.js';
import { FUNDING_STATES } from './state.js';

/** The current schema version. Bump with each migration added here. */
export const SCHEMA_VERSION = 8;

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
 * The v4 -> v5 shape of `supported_corridors`, frozen exactly as it shipped.
 *
 * Not reused by `freshSchema()` any more (see `SUPPORTED_CORRIDORS_TABLE_CURRENT` below): a
 * database that is genuinely still at v4 today walks this step first, on the way to the current
 * shape via v7 -> v8's `ALTER TABLE`s, and that walk only produces the same table a fresh database
 * gets if this text keeps meaning exactly what it meant when v4 -> v5 shipped. Changing it in
 * place to add `direction` would make a *fresh* v5 table (built by a v4 database migrating today)
 * already have the column the v7 -> v8 `ADD COLUMN` step is about to add, which fails outright
 * ("column already exists") the first time both steps run in one boot -- the exact class of
 * fresh-vs-migrated divergence `CRYPTO_AMOUNT_COLUMN`'s comment describes, caught before it could
 * ship rather than after.
 */
const SUPPORTED_CORRIDORS_TABLE =
  'CREATE TABLE IF NOT EXISTS supported_corridors (' +
  ' destination_currency_code TEXT NOT NULL,' +
  ' country TEXT NOT NULL,' +
  ' name TEXT NOT NULL,' +
  ' fiat TEXT NOT NULL,' +
  ' methods JSONB NOT NULL,' +
  ' updated_at BIGINT NOT NULL,' +
  ' PRIMARY KEY (destination_currency_code, country)' +
  ')';

/**
 * The direction column on `supported_corridors`, written once for the same reason
 * `DIRECTION_COLUMN` (below, on `funding_requests`) is: `freshSchema()` and the v7 -> v8 migration
 * must produce the same table, and a value hand-duplicated between the two is exactly the shape
 * this repo has already shipped a divergence in (`CRYPTO_AMOUNT_COLUMN`'s comment tells that
 * story). `NOT NULL DEFAULT 'buy'`: every corridor row written before a sell corridor could exist
 * was a buy corridor.
 */
const SUPPORTED_CORRIDORS_DIRECTION_COLUMN = " direction TEXT NOT NULL DEFAULT 'buy'";

/**
 * The direction alphabet on `supported_corridors`, named explicitly like `funding_direction_known`
 * so a fresh table and a migrated one carry the same constraint name rather than whatever Postgres
 * auto-generates on each path.
 */
const SUPPORTED_CORRIDORS_DIRECTION_CONSTRAINT = `CONSTRAINT supported_corridors_direction_known CHECK (direction IN (${DIRECTIONS.map((d) => `'${d}'`).join(', ')}))`;

/**
 * The current shape of `supported_corridors`: one row per (crypto, direction, country), which is
 * what `upsertCorridor`'s `ON CONFLICT` target and `readCorridors`' predicate both assume from the
 * day this ships. Without `direction` in the key, a sell refresh pass upserting `(DOT_ASSETHUB,
 * GB)` would silently overwrite the buy row for the same corridor -- the two are different
 * questions to Meld (different category, different route argument order; see
 * `meld/discovery.ts`), and this table must not fold their answers into one slot.
 *
 * `IF NOT EXISTS` even though this text now runs only on a genuinely fresh database (a v7 -> v8
 * `ALTER` handles every database that already has the old shape): kept for the same defensive
 * reason `freshSchema()`'s other `CREATE TABLE`s have no `IF NOT EXISTS` and this one, historically
 * shared with a migration step, always did -- consistency with the frozen text above costs nothing
 * and a second reader comparing the two is one fewer place to wonder why they differ.
 *
 * `direction` is placed *last*, after `updated_at`, not beside `destination_currency_code` where a
 * reader would expect a key column to sit. That is the `CRYPTO_AMOUNT_COLUMN` lesson applied here:
 * `ALTER TABLE ... ADD COLUMN` can only append, so the v7 -> v8 migration is forced to put
 * `direction` at the end regardless of where it reads best, and this text has to match that
 * ordinal position exactly or `schema.test.ts`'s column-for-column comparison (the test this
 * repo's shipped divergence is why it exists) fails on a fresh-vs-migrated database. Whatever key
 * columns *look* like they belong together, the physical order is the migration's, not the
 * reader's.
 */
const SUPPORTED_CORRIDORS_TABLE_CURRENT =
  'CREATE TABLE IF NOT EXISTS supported_corridors (' +
  ' destination_currency_code TEXT NOT NULL,' +
  ' country TEXT NOT NULL,' +
  ' name TEXT NOT NULL,' +
  ' fiat TEXT NOT NULL,' +
  ' methods JSONB NOT NULL,' +
  ' updated_at BIGINT NOT NULL,' +
  `${SUPPORTED_CORRIDORS_DIRECTION_COLUMN},` +
  ' PRIMARY KEY (destination_currency_code, direction, country),' +
  ` ${SUPPORTED_CORRIDORS_DIRECTION_CONSTRAINT}` +
  ')';

/**
 * The direction column, written once because `freshSchema()` and the v5 -> v6 migration must
 * produce the same table.
 *
 * `NOT NULL DEFAULT 'buy'`: every row that existed before this column did was a buy, and the
 * default is what makes that true of the existing population without a backfill pass. It stays
 * on a fresh database too, so the two paths cannot diverge, but nothing relies on it: every
 * insert names the column (`COLUMN_LIST`).
 */
const DIRECTION_COLUMN = " direction TEXT NOT NULL DEFAULT 'buy'";

/**
 * The committed crypto on a sell, at full precision, exactly as the caller sent it.
 *
 * A shared constant for the same reason `DIRECTION_COLUMN` is one, and it is the field that
 * proved the reason: written out by hand it sat beside `source_amount` in `freshSchema()` and at
 * the end of the table on the migrated path, so every column between `fiat` and `cancelled_at`
 * held a different ordinal depending on which path made the database. Nothing in this service
 * reads a column by position (`COLUMN_LIST` names every one, and there is no `SELECT *`), so it
 * broke nothing here — which is exactly why it would have survived: CI creates fresh databases
 * and production is migrated, so the divergence is invisible until a `COPY` without a column
 * list, a `pg_dump` shape diff between environments, or a `CREATE TABLE ... LIKE` behaves one way
 * in tests and another in production.
 *
 * Emitted in the migration's append position, because that is the one an existing database is
 * forced into. `schema.test.ts` compares both tables column by column and constraint by
 * constraint, so this cannot drift again without a failure.
 */
const CRYPTO_AMOUNT_COLUMN = ' crypto_amount TEXT';

/**
 * The three constraints that keep a row's terms consistent with its direction.
 *
 * Named explicitly, unlike the status check above, so a fresh v6 database and a migrated one
 * carry identical constraint names rather than whatever Postgres happens to auto-generate on
 * each path.
 *
 * The first is the alphabet, exactly as the status check is: the machine still owns the moves,
 * this stops a row existing in a direction nothing knows how to read.
 *
 * The other two replace what the dropped `NOT NULL`s used to guarantee, per direction rather
 * than globally. `wallet_address` and `source_amount` became nullable because a sell has
 * neither, and without these a buy could now be written missing both.
 *
 * `crypto_amount` is the one worth spelling out. A consumer resuming a sell hard-compares the
 * committed crypto against its own record to detect being resumed into a *different* sale, and
 * on a sell there is no other distinguishing term: the wallet address that does that job on a
 * buy does not exist, and `source_amount` is null. A sell row written without a crypto amount
 * silently degrades that check to "same corridor", which hands a seller the settlement surface
 * of someone else's sale at someone else's amount. A database constraint rather than a guard in
 * the store, because it cannot be bypassed by a future write path that has not read this
 * comment.
 */
const DIRECTION_CONSTRAINTS = [
  `CONSTRAINT funding_direction_known CHECK (direction IN (${DIRECTIONS.map((d) => `'${d}'`).join(', ')}))`,
  'CONSTRAINT funding_buy_terms CHECK (' +
    "direction <> 'buy' OR (source_amount IS NOT NULL AND wallet_address IS NOT NULL))",
  "CONSTRAINT funding_sell_terms CHECK (direction <> 'sell' OR crypto_amount IS NOT NULL)",
];

/**
 * The columns the deposit leg of a sell is observed into.
 *
 * Filled by the worker's observation finder, through `UpdateExtra.deposit` and `mergeDeposit`
 * (`funding/merge.ts`), once a provider discloses an address -- not by this migration, which only
 * adds the shape. Every one is nullable, and null is the overwhelming majority: a buy has no
 * deposit leg at all, and a sell has none until disclosure.
 *
 * `deposit_memo` exists despite Polkadot Asset Hub needing no destination tag, and despite the
 * sandbox probe finding no candidate field on Meld's transaction record. It is there because an
 * asset that needs one and has nowhere to put it is a payout sent to the right address and
 * credited to nobody.
 */
const DEPOSIT_COLUMNS = [
  ' deposit_address TEXT',
  ' deposit_amount TEXT',
  ' deposit_currency TEXT',
  ' deposit_memo TEXT',
  ' deposit_observed_at BIGINT',
];

/**
 * Where a deposit-address disclosure conflict is recorded, rather than only thrown and forgotten.
 *
 * `mergeDeposit` (`funding/merge.ts`) never lets a conflicting report overwrite a `deposit_address`
 * already stored -- the seller may already have sent to the one shown, and there is no safe way to
 * pick a winner from here. Refusing the write silently would still hide the fact that a rail
 * disagreed with itself, so the disagreement is written down instead of only logged: which value
 * was rejected, why (`funding_deposit_conflict_reason_known` below), and when it was last seen.
 * `deposit_conflict_at IS NOT NULL` is then a query, not a log grep.
 *
 * Separate columns from the `deposit_*` ones rather than overloading them, because a conflict is
 * a fact about the *disclosure*, not a revision of the *deposit*: the accepted address must stay
 * exactly what it was, in the same columns, while the conflicting report lives beside it.
 *
 * Every one is nullable, and null is the overwhelming majority: nothing has conflicted on any row
 * this build has produced.
 */
const DEPOSIT_CONFLICT_COLUMNS = [
  ' deposit_conflict_address TEXT',
  ' deposit_conflict_reason TEXT',
  ' deposit_conflict_at BIGINT',
];

/**
 * The vocabulary `deposit_conflict_reason` may hold, enforced by the database for the same reason
 * `funding_direction_known` is: a write path that has not read `DepositConflictReason` in
 * `merge.ts` must still be refused rather than silently widening what this column can mean.
 */
const DEPOSIT_CONFLICT_CONSTRAINT =
  'CONSTRAINT funding_deposit_conflict_reason_known CHECK (' +
  "deposit_conflict_reason IS NULL OR deposit_conflict_reason IN ('address_changed', 'address_malformed'))";

/**
 * The ordered migration list.
 *
 * A fresh database is created at `SCHEMA_VERSION` directly by `freshSchema()`, so this list is
 * what an existing database walks through, one step at a time. The next migration appends
 * `{ from: 6, to: 7, sql: [...] }` and bumps `SCHEMA_VERSION`; `store.ts` needs no change.
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
  {
    from: 4,
    to: 5,
    // v4 -> v5: cache Meld's supported corridors for the bulk endpoint. Same shape as freshSchema.
    sql: [SUPPORTED_CORRIDORS_TABLE],
  },
  {
    from: 5,
    to: 6,
    /**
     * v5 -> v6: a request can now sell as well as buy.
     *
     * A column, not a ninth state, for the third time (see v2 -> v3 and v3 -> v4). A direction is
     * not a stage of the lifecycle: a sell moves through the same eight states a buy does, in the
     * same order, and the transition table is untouched by this migration. Making it a state
     * would be wire-visible to a consumer that understands none of the eight it already has, and
     * would have to be crossed with every one of them.
     *
     * Three things become nullable-or-new because a sell commits different terms:
     *
     * - `wallet_address` loses `NOT NULL`. A sell has no caller-supplied address; the provider
     *   issues the deposit address after the session exists.
     * - `source_amount` loses `NOT NULL`. A sell commits crypto. The fiat it will fetch is a
     *   quoted estimate that moves with the rate, and storing an estimate in the column that
     *   means "what was committed" is how an estimate gets quoted back as a term.
     * - `crypto_amount` is that committed crypto, at full precision, as the exact string sent.
     *
     * The three `CHECK`s added alongside are what stops the two dropped `NOT NULL`s from
     * loosening a buy; see `DIRECTION_CONSTRAINTS`.
     *
     * The deposit columns land in the same step and stay empty until the worker that fills them
     * exists; see `DEPOSIT_COLUMNS`.
     *
     * ## What this step costs a live service, and when that stops being acceptable
     *
     * Decided, not left open. The whole step runs in one transaction with `statement_timeout = 0`
     * (see `FundingStore.migrate`), and the first `ALTER TABLE` takes `ACCESS EXCLUSIVE`, so that
     * lock is held until `COMMIT` and everything else queues behind it. The service is live
     * throughout: a rollout's old pods keep serving while the new one migrates at boot.
     *
     * Measured at 2,000,000 rows on warm local NVMe:
     *
     * - `ADD COLUMN direction TEXT NOT NULL DEFAULT 'buy'`: 4.9 ms. No table rewrite, because
     *   Postgres 11+ stores a non-volatile default in the catalog rather than writing every row.
     * - the two `DROP NOT NULL`s: catalog-only, immeasurable.
     * - the three `ADD CONSTRAINT ... CHECK`: 869 ms + 141 ms + 115 ms. Each validates by
     *   scanning the whole table.
     *
     * So roughly **1.1 s of blackout at 2M rows**, and it scales with the row count. CloudSQL's
     * storage is slower than the machine that produced these numbers, so treat them as a floor.
     *
     * `ADD CONSTRAINT ... NOT VALID` plus a later `VALIDATE CONSTRAINT` is the standard way to
     * cut that, and it is deliberately **not** used here. It only helps if the validation happens
     * in a *separate transaction*: inside this one the `ACCESS EXCLUSIVE` lock is held to
     * `COMMIT` regardless, so splitting the statements without splitting the transaction moves
     * nothing. Splitting the transaction is the part this harness cannot express, and should not
     * learn to in this step: a step is one transaction precisely so that its SQL and its
     * `schema_migrations` stamp commit together, which is what makes a half-applied step at a
     * stamped version impossible (`schema.test.ts` asserts that directly). Leaving the constraint
     * `NOT VALID` instead is not an option either: `convalidated` would then differ between a
     * fresh database and a migrated one, which is the exact class of divergence the shared
     * `CRYPTO_AMOUNT_COLUMN` constant above exists to prevent.
     *
     * **The number to act on: around 10M rows.** That is ~5.5 s of blackout by the scaling above,
     * past half the pool's 10 s `statement_timeout`, so queued requests begin failing outright
     * rather than merely slowing down. At that point split the harness to allow a step to declare
     * post-commit statements, and add these constraints `NOT VALID` with a `VALIDATE` behind it.
     * Below it, a second of queueing on a deploy is cheaper than the harness change.
     *
     * The v6 -> v7 step below adds a fourth constraint of the same class (`ACCESS EXCLUSIVE`,
     * full-table scan, sized to row count rather than to how many rows a predicate matches). It is
     * priced against this same measurement and this same threshold there, rather than restated,
     * so the two are sized together: by the time either needs `NOT VALID` + `VALIDATE`, both do.
     */
    sql: [
      `ALTER TABLE funding_requests ADD COLUMN${DIRECTION_COLUMN}`,
      'ALTER TABLE funding_requests ALTER COLUMN wallet_address DROP NOT NULL',
      'ALTER TABLE funding_requests ALTER COLUMN source_amount DROP NOT NULL',
      `ALTER TABLE funding_requests ADD COLUMN${CRYPTO_AMOUNT_COLUMN}`,
      ...DEPOSIT_COLUMNS.map((column) => `ALTER TABLE funding_requests ADD COLUMN${column}`),
      // Last, so every column each one names already exists.
      ...DIRECTION_CONSTRAINTS.map((constraint) => `ALTER TABLE funding_requests ADD ${constraint}`),
    ],
  },
  {
    from: 6,
    to: 7,
    /**
     * v6 -> v7: record a deposit-address disclosure conflict, rather than only refusing it.
     *
     * The first version of the sell deposit leg (v5 -> v6) threw and rolled back an entire advance
     * whenever a rail reported a different address than one already stored -- correct about never
     * overwriting the address, wrong about taking an unrelated, legitimate state move down with
     * it every time the same disagreement recurred. This step adds nowhere for the conflicting
     * value to overwrite; it adds somewhere for it to be *recorded* instead, so a provider that
     * keeps disclosing a wrong address can no longer also freeze a row that would otherwise
     * correctly settle or fail. See `mergeAdvance` and `mergeDeposit` in `funding/merge.ts`.
     *
     * Three nullable columns, catalog-only like every `ADD COLUMN` in this chain since v5 -> v6
     * (no default, no rewrite), plus one `CHECK` that costs the same way the three v5 -> v6 ones
     * do (see that migration's "What this step costs a live service" section): a full-table scan
     * under the same `ACCESS EXCLUSIVE` lock, sized to the *table's* row count, not to how many
     * rows happen to have a non-null `deposit_conflict_reason`. It is tempting to read "this build
     * has zero rows with a conflict, by construction" as "the scan has nothing to read" -- it does
     * not: `CHECK (col IS NULL OR col IN (...))` still visits every row to confirm the `IS NULL`
     * branch, exactly as `funding_sell_terms` does for the buy rows it never rejects. So this
     * constraint is sized with the same 2M-row measurement and the same ~10M-row threshold as the
     * v5 -> v6 ones, not separately: at the scale where those three needed `NOT VALID` +
     * `VALIDATE`, this one does too, in the same pass.
     */
    sql: [
      ...DEPOSIT_CONFLICT_COLUMNS.map((column) => `ALTER TABLE funding_requests ADD COLUMN${column}`),
      `ALTER TABLE funding_requests ADD ${DEPOSIT_CONFLICT_CONSTRAINT}`,
    ],
  },
  {
    from: 7,
    to: 8,
    /**
     * v7 -> v8: a corridor can now be a sell as well as a buy, so direction joins the key.
     *
     * Before this step `supported_corridors`' primary key is `(destination_currency_code,
     * country)`. A sell refresh pass and a buy refresh pass for the same (crypto, country) would
     * upsert into the same row, each overwriting the other's `methods` and `fiat` on every pass --
     * silently, because `ON CONFLICT ... DO UPDATE` has no way to say "this is a different
     * corridor" when the key does not carry the fact that makes it one. `store.ts`'s
     * `upsertCorridor` conflict target and `readCorridors`' predicate both move to match, in the
     * same commit as this migration, so the two cannot drift out of step with each other.
     *
     * Three statements, mirroring `freshSchema()`'s `SUPPORTED_CORRIDORS_TABLE_CURRENT` column for
     * column: add the column, then swap the primary key for one that includes it (Postgres names
     * an unnamed primary key `<table>_pkey`, which is what `DROP CONSTRAINT` below names), then add
     * the direction alphabet as a `CHECK`, exactly as `funding_direction_known` does for
     * `funding_requests`.
     *
     * ## What this step costs a live service, and when that stops being acceptable
     *
     * Sized the same way the v5 -> v6 and v6 -> v7 steps on `funding_requests` are, but measured
     * fresh rather than borrowed from that number: this migration's costliest statement (rebuilding
     * a primary-key index) has no analogue in either of those steps, which never touched an index,
     * so reusing their figure would have understated it. One transaction, `ACCESS EXCLUSIVE` held
     * to `COMMIT`, the service live throughout behind old pods, exactly as before. What differs is
     * the table: `supported_corridors` is not a request ledger that grows with traffic; it is
     * bounded by (crypto count) x (direction count) x (country count) the refresh job walks, which
     * is dozens of cryptos at the very most against at most a few hundred countries -- several
     * orders of magnitude below `funding_requests`' row count today or at any plausible scale this
     * deployment reaches. Measured at 2,000,000 rows regardless, on warm local NVMe, to give a real
     * number rather than an assumption:
     *
     * - `ADD COLUMN direction TEXT NOT NULL DEFAULT 'buy'`: 5.3 ms. Catalog-only, for the same
     *   reason the `funding_requests` one is (Postgres 11+ stores a non-volatile default in the
     *   catalog rather than rewriting every row).
     * - `DROP CONSTRAINT supported_corridors_pkey`: 7.1 ms. Dropping a constraint is catalog-only
     *   too; only building its replacement costs anything.
     * - `ADD PRIMARY KEY (destination_currency_code, direction, country)`: **5.07 s.** Unlike a
     *   `CHECK`, this rebuilds the underlying unique btree index over the whole table, and it is by
     *   far the expensive statement in this step -- roughly 4.5x the *combined* cost of every
     *   `funding_requests` constraint the v5 -> v6 step measured. A composite index over three text
     *   columns is heavier to build than a single-column default or a boolean-ish `CHECK`, and nothing
     *   about this table being small in row count changes that; it changes only how many rows there
     *   are to build the index over.
     * - `ADD CONSTRAINT ... CHECK`: 136 ms, scanning the whole table exactly as `funding_sell_terms`
     *   does, cheaper than the `funding_requests` `CHECK`s because this row is narrower.
     *
     * ~5.2 s total at 2,000,000 rows, essentially all of it the primary-key rebuild. **The
     * threshold to act on is lower than the ~10M rows the v5 -> v6 and v6 -> v7 steps name**,
     * because this step's dominant cost scales with index-build work rather than with the cheaper
     * per-row catalog/scan cost those steps measured: extrapolating linearly, 5.2 s at 2M rows
     * crosses the same "half the pool's 10 s `statement_timeout`" line named there at roughly
     * **2M x (5/5.2) ≈ 1.9M** rows already past this measurement, i.e. this step is already close
     * to that line at the row count it was measured against, not merely approaching it from a
     * comfortable distance the way the smaller `funding_requests` constraints are. In practice
     * `supported_corridors` has no path to that row count at all: the refresh job that populates it
     * (`supported/refresh.ts`) writes one row per (crypto, direction, country) it is configured to
     * walk, and nothing in this service inserts a row outside that loop, so the number above is a
     * ceiling this table is not expected to approach rather than a live risk. If that ever stops
     * being true -- a per-buyer or per-request row here would be a different design, not a bigger
     * version of this one -- split this step the way the v5 -> v6 docblock describes (`NOT VALID`
     * + `VALIDATE` in a later, separate transaction) well before the row count, not the 10M figure
     * that applies to the other steps.
     */
    sql: [
      `ALTER TABLE supported_corridors ADD COLUMN${SUPPORTED_CORRIDORS_DIRECTION_COLUMN}`,
      'ALTER TABLE supported_corridors DROP CONSTRAINT supported_corridors_pkey',
      'ALTER TABLE supported_corridors ADD PRIMARY KEY (destination_currency_code, direction, country)',
      `ALTER TABLE supported_corridors ADD ${SUPPORTED_CORRIDORS_DIRECTION_CONSTRAINT}`,
    ],
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
      // Nullable since v6: a sell has no caller-supplied wallet address and no committed fiat.
      // The per-direction CHECKs below are what keeps a buy carrying both.
      ' wallet_address TEXT,' +
      ' source_amount TEXT,' +
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
      // Which way this request moves value, and the crypto a sell commits. Both in the order the
      // v5 -> v6 migration appends them, so the two paths build the same table.
      `${DIRECTION_COLUMN},` +
      `${CRYPTO_AMOUNT_COLUMN},` +
      // The sell deposit leg, and where a disclosure conflict on it is recorded. Both in the
      // order the v5 -> v6 and v6 -> v7 migrations append them, so the two paths build the same
      // table.
      DEPOSIT_COLUMNS.map((column) => `${column},`).join('') +
      DEPOSIT_CONFLICT_COLUMNS.map((column) => `${column},`).join('') +
      // The vocabulary, enforced by the database rather than only by the state machine.
      // `update()` validates transitions inside its transaction, but `create()` writes whatever
      // status it is handed; both production callers are correct and nothing at the storage layer
      // stopped a third, or a hand-run migration, from writing a state `state.ts` does not have.
      // This does not constrain transitions, only the alphabet; the machine still owns the moves.
      ` CHECK (status IN (${FUNDING_STATES.map((state) => `'${state}'`).join(', ')})),` +
      // The direction alphabet, and the per-direction term constraints the v6 migration adds to
      // an existing table. Same text on both paths, so the two tables are the same table.
      DIRECTION_CONSTRAINTS.map((constraint) => ` ${constraint}`).join(',') +
      `, ${DEPOSIT_CONFLICT_CONSTRAINT}` +
      ')',
    'CREATE INDEX funding_by_alias ON funding_requests (subject_alias, product_id, created_at DESC, id DESC)',
    // Partial, matching the `WHERE client_reference IS NOT NULL` predicate exactly: a refused row
    // deliberately claims no key, and several of those under one caller must not collide.
    'CREATE UNIQUE INDEX funding_by_reference ON funding_requests (subject_alias, product_id, client_reference) ' +
      'WHERE client_reference IS NOT NULL',
    // The worker's claim scan orders by (created_at, id) within the non-terminal rows. Leading on
    // `status` lets the planner cut to those first.
    'CREATE INDEX funding_claim_scan ON funding_requests (status, created_at, id)',
    // The supported-corridors cache, at the current (v8) shape. See the v7 -> v8 migration for
    // what an existing database walks through to reach the same table.
    SUPPORTED_CORRIDORS_TABLE_CURRENT,
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
