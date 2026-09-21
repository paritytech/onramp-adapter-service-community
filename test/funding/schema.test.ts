/**
 * The schema, its version bookkeeping, and the index that makes an idempotency key mean something.
 *
 * Most of this file's bulk went with the CloudSQL move, and that was the point. It would
 * exercise a v0->v1->v2->v3 chain against on-disk SQLite files, minting a v0 file by hand for each
 * case. Nothing was ever deployed, so that chain migrated a population of zero; CloudSQL starts
 * empty, and the v3 shape is the v1 shape here. Testing a chain that cannot run against a shape
 * that no longer exists would have been ceremony.
 *
 * What survives is what still has teeth: the version guard, the advisory lock that keeps two
 * booting replicas from both migrating, and the partial unique index.
 */

import { describe, expect, it } from 'vitest';

import { fakeStore, fundingRecord, sellRecord } from '../fixtures.js';
import { createSchema, dropSchema, openIn, rawQuery as query, withStore } from '../pg.js';

import { MIGRATION_LOCK_TIMEOUT_MS, SCHEMA_VERSION, freshSchema, type Migration } from '../../src/funding/schema.js';
import { FUNDING_STATES } from '../../src/funding/state.js';
import { COLUMN_LIST } from '../../src/funding/store.js';

/** As `rawQuery`, for statements whose rows nobody wants. */
async function raw(schema: string, sql: string): Promise<void> {
  await query(schema, sql);
}

describe('schema bookkeeping', () => {
  it('bounds the migration advisory-lock wait comfortably inside the startup probe budget', () => {
    // The lock_timeout on a migration must land inside the 120s boot probe budget, or a replica
    // blocked behind a live migration would time the probe out of the readiness gate instead of
    // waiting out its turn. The value is asserted rather than the mechanism, because the
    // adjacent two-replica test defends the mechanism.
    expect(MIGRATION_LOCK_TIMEOUT_MS).toBeLessThan(120_000);
  });

  it('creates the current shape in an empty database and records the version', async () => {
    const schema = await createSchema();
    try {
      const store = await openIn(schema);
      await store.create(fundingRecord());
      expect((await store.byId('funding-1'))?.id).toBe('funding-1');
      await store.close();
    } finally {
      await dropSchema(schema);
    }
  });

  it.each([SCHEMA_VERSION + 1, 999])('refuses a database at version %i, one ahead or many', async (version) => {
    // The case that actually happens is exactly one ahead: a database a newer build stamped, then
    // opened by this one after a rollback. A guard of the form `> SCHEMA_VERSION + k` for some k
    // passes the 999 case and lets the real one through, so both are asserted.
    const schema = await createSchema();
    try {
      await raw(schema, 'CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at BIGINT NOT NULL)');
      await raw(schema, `INSERT INTO schema_migrations (version, applied_at) VALUES (${String(version)}, 0)`);
      await raw(schema, 'CREATE TABLE funding_requests (id TEXT PRIMARY KEY)');

      await expect(openIn(schema)).rejects.toThrow(/migrated by a newer build/);
    } finally {
      await dropSchema(schema);
    }
  });

  it('refuses a database older than this build, with no migration to reach current', async () => {
    // The mirror of the case above, and the one a `>` guard makes silent: with `>`, a
    // database whose table exists at a version below this build's applied nothing and passed. The
    // service then served requests against a shape it does not understand, one that, by
    // definition, is missing whatever the migration would have added.
    const schema = await createSchema();
    try {
      await raw(schema, 'CREATE TABLE funding_requests (id TEXT PRIMARY KEY)');
      await raw(schema, 'CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at BIGINT NOT NULL)');
      // Version 0 (the table exists, nothing is recorded), and no migration declares `from: 0`,
      // so nothing can carry it forward.
      await expect(openIn(schema)).rejects.toThrow(/no migration reaches the current version/);
    } finally {
      await dropSchema(schema);
    }
  });

  it('is a no-op on a database already at the current version', async () => {
    // Reopening must not re-run creation over an existing table, and must not double-stamp the
    // version. The second open is the ordinary case: every restart takes this path.
    const schema = await createSchema();
    try {
      const first = await openIn(schema);
      await first.create(fundingRecord({ id: 'survivor' }));
      await first.close();

      const second = await openIn(schema);
      expect((await second.byId('survivor'))?.id).toBe('survivor');
      await second.close();
    } finally {
      await dropSchema(schema);
    }
  });

  it('lets two replicas boot against one empty database without racing the creation', async () => {
    // `pg_advisory_lock` replaces SQLite's `BEGIN IMMEDIATE`, which stopped two processes both
    // migrating one file. Without it both would run `CREATE TABLE funding_requests` and the loser
    // would crash-loop on a duplicate-table error; that is every deploy, since a rollout starts
    // replicas together.
    const schema = await createSchema();
    try {
      const [a, b] = await Promise.all([openIn(schema), openIn(schema)]);
      await a.create(fundingRecord({ id: 'from-a' }));
      expect((await b.byId('from-a'))?.id).toBe('from-a');
      await a.close();
      await b.close();
    } finally {
      await dropSchema(schema);
    }
  });
});

describe('the column contract', () => {
  it('covers every column the store writes, with the lease pair the only carve-out', async () => {
    // `COLUMN_LIST` drives the INSERT names and the bind tuple. The table also carries two lease
    // columns (`claimed_by`, `claimed_until`) that only `claim`/`release` ever write, so `SELECT *`
    // shows the data columns plus those two. Asserting the insert list against the physical table
    // catches the overshoot in either direction: a column `recordToRow` stopped writing (a nullable
    // column dropped by mistake) and a column the schema gained that the INSERT does not name.
    // The second, for a NOT NULL column without a default, would crash every insert rather than
    // being noticed late.
    const schema = await createSchema();
    try {
      const store = await openIn(schema);
      await store.close();
      // `rawQuery` sets `search_path` to the schema, so unqualified `current_schema()` answers it.
      const table = await query(
        schema,
        "SELECT column_name FROM information_schema.columns WHERE table_name = 'funding_requests' " +
          'AND table_schema = current_schema()',
      );
      const physical = table.map((row) => row.column_name as string);

      expect(physical.length).toBe(COLUMN_LIST.length + 2); // the two lease columns
      for (const name of COLUMN_LIST) expect(physical).toContain(name);
      const leaseOnly = physical.filter((name) => !(COLUMN_LIST as readonly string[]).includes(name));
      expect(leaseOnly.sort()).toEqual(['claimed_by', 'claimed_until']);
    } finally {
      await dropSchema(schema);
    }
  });

  it('writes each column into the slot it is named for', async () => {
    // The old `recordToRow` was a positional restatement, so a swapped pair wrote values into the
    // wrong columns and the round-trip test could not see it: the fixture binds `created_at ===
    // updated_at`. The derived build maps by name, but a byName slip (say, transposing the two
    // timestamps in the map) would still write wrong values. This catches that by inserting
    // differing timestamps and reading them straight off the table.
    // Every nullable column gets a distinct sentinel, not just the two timestamps. Binding
    // `service_provider` to a literal `null` in `recordToRow` survived the whole suite: the fixture
    // leaves it `undefined` and no Postgres-backed test overrode it, so the one insert slot
    // production actually fills for it was never read back. `Onramp` compares that value on a
    // replay (`already.service_provider !== request.serviceProvider`), so dropping it would 409
    // every retry of a key that pinned a sub-provider. That fails closed, but it is exactly "a
    // value that does not land in its named column", which this test is here to prevent.
    const schema = await createSchema();
    try {
      const store = await openIn(schema);
      await store.create(
        fundingRecord({
          created_at: 1_800_000_000_000,
          updated_at: 1_900_000_000_000,
          service_provider: 'TRANSAK',
          country: 'DE',
          client_reference: 'idem-slot-1',
          provider_session_id: 'meld-slot',
          provider_transaction_id: 'tx-slot',
          provider_status: 'SETTLED',
          widget_url: 'https://meldcrypto.com/session/slot',
          hosted_widget_url: 'https://meldcrypto.com/s/slot',
          expires_at: 1_950_000_000_000,
        }),
      );
      await store.close();

      const row = (
        await query(
          schema,
          'SELECT id, created_at, updated_at, service_provider, country, client_reference, ' +
            'provider_session_id, provider_transaction_id, provider_status, widget_url, ' +
            'hosted_widget_url, expires_at FROM funding_requests',
        )
      )[0];
      expect(row).toEqual({
        id: 'funding-1',
        created_at: 1_800_000_000_000,
        updated_at: 1_900_000_000_000,
        service_provider: 'TRANSAK',
        country: 'DE',
        client_reference: 'idem-slot-1',
        provider_session_id: 'meld-slot',
        provider_transaction_id: 'tx-slot',
        provider_status: 'SETTLED',
        widget_url: 'https://meldcrypto.com/session/slot',
        hosted_widget_url: 'https://meldcrypto.com/s/slot',
        expires_at: 1_950_000_000_000,
      });
    } finally {
      await dropSchema(schema);
    }
  });
});

describe('the status constraint', () => {
  it('refuses a status the state machine does not have', async () => {
    // `update()` validates transitions inside its transaction, but `create()` writes whatever
    // status it is handed. Both production callers are correct; nothing at the storage layer
    // stopped a third (or a hand-run migration) from writing a state that does not exist.
    //
    // The alphabet only. The machine still owns which moves are legal; this stops a row existing
    // in a state nothing can ever transition out of because nothing knows what it means.
    await withStore(async (store) => {
      await store.create(fundingRecord({ id: 'legal', status: 'settled' }));
      await expect(
        store.create(fundingRecord({ id: 'invented', status: 'nearly_settled' as never })),
      ).rejects.toThrow(/violates check constraint/i);
    });
  });

  it('covers every state the machine declares, so adding one cannot be forgotten', async () => {
    // The constraint is generated from `FUNDING_STATES`, so this holds by construction, and
    // asserts that the generation actually reached the database rather than being dropped.
    await withStore(async (store) => {
      for (const [index, state] of FUNDING_STATES.entries()) {
        await expect(
          store.create(fundingRecord({ id: `s-${String(index)}`, status: state })),
        ).resolves.toBeUndefined();
      }
    });
  });
});

describe('the idempotency index', () => {
  it('lets two callers use the same key, and refuses one caller reusing it', async () => {
    // The unique index is per (caller, product, reference): a shared key namespace across callers
    // would let one caller's key collide with another's and deny them a session.
    await withStore(async (store) => {
      await store.create(fundingRecord({ id: 'a', subject_alias: 'alias-a', client_reference: 'idem-1' }));
      await store.create(fundingRecord({ id: 'b', subject_alias: 'alias-b', client_reference: 'idem-1' }));

      expect((await store.byReference('alias-a', 'app.dot', 'idem-1'))?.id).toBe('a');
      expect((await store.byReference('alias-b', 'app.dot', 'idem-1'))?.id).toBe('b');
      await expect(
        store.create(fundingRecord({ id: 'c', subject_alias: 'alias-a', client_reference: 'idem-1' })),
      ).rejects.toThrow();
    });
  });

  it('scopes a key to the product, not just the caller', async () => {
    // One caller may hold sessions on two products at once, and nothing stops them reusing a key
    // across them. Drop `product_id` from either the lookup or the index and product A's session
    // is replayed for product B, while B is simultaneously refused a session of its own.
    await withStore(async (store) => {
      await store.create(fundingRecord({ id: 'a', product_id: 'app.dot', client_reference: 'idem-1' }));

      expect(await store.byReference('alias-abc', 'other.dot', 'idem-1')).toBeUndefined();
      await expect(
        store.create(fundingRecord({ id: 'b', product_id: 'other.dot', client_reference: 'idem-1' })),
      ).resolves.toBeUndefined();
    });
  });

  it('leaves rows without a reference free to coexist', async () => {
    // The index is partial on NOT NULL; refusals carry no reference and there may be many. In
    // Postgres a plain unique index treats NULLs as distinct anyway, but the predicate is what
    // keeps `ON CONFLICT` in `reserve` targeting this index and no other.
    await withStore(async (store) => {
      await store.create(fundingRecord({ id: 'a', status: 'refused', client_reference: undefined }));
      await expect(
        store.create(fundingRecord({ id: 'b', status: 'refused', client_reference: undefined })),
      ).resolves.toBeUndefined();
    });
  });
});

describe('creating a fresh schema', () => {
  it('rolls back the whole creation when one statement fails', async () => {
    // A half-created schema is the worst outcome: the table exists, so the next boot takes the
    // migration path and finds no migration from version 0, leaving a database with no indexes
    // and no version stamp that this build will happily write funding rows into.
    //
    // Indexes and tables share one relation namespace in Postgres, so a table already holding the
    // name of an index the creation makes is enough to fail it, while `funding_requests` itself
    // is still absent, which is what keeps this on the fresh path.
    const schema = await createSchema();
    try {
      await raw(schema, 'CREATE TABLE funding_by_alias (placeholder INTEGER)');

      await expect(openIn(schema)).rejects.toThrow();

      // `table_schema` explicitly: `search_path` governs unqualified name resolution, not what
      // `information_schema` reports, so without it this reads every schema in the database.
      const tables = await query(
        schema,
        "SELECT table_name FROM information_schema.tables " +
          `WHERE table_schema = '${schema}' AND table_name = 'funding_requests'`,
      );
      expect(tables).toEqual([]);
      const applied = await query(schema, 'SELECT version FROM schema_migrations ORDER BY version');
      expect(applied).toEqual([]);
    } finally {
      await dropSchema(schema);
    }
  });
});

/**
 * `freshSchema()` minus everything the v5 -> v6 migration adds: a v5 funding table.
 *
 * Derived from the current shape rather than written out, so the two cannot drift in the parts
 * v6 does not touch, and a v6 addition that is not stripped here fails loudly when the migration
 * tries to add a column that already exists. That is the intended failure: it says the fixture
 * was not kept up, rather than passing while proving less.
 */
const atV5 = (sql: string): string =>
  sql
    .replace(" direction TEXT NOT NULL DEFAULT 'buy',", '')
    .replace(' crypto_amount TEXT,', '')
    .replace(' deposit_address TEXT,', '')
    .replace(' deposit_amount TEXT,', '')
    .replace(' deposit_currency TEXT,', '')
    .replace(' deposit_memo TEXT,', '')
    .replace(' deposit_observed_at BIGINT,', '')
    // The three v6 constraints are contiguous and last, so one cut removes all of them and
    // closes the statement.
    .replace(/, CONSTRAINT funding_direction_known .*$/, ')')
    // v5 had no direction, so both were mandatory: a request was always a buy.
    .replace(' wallet_address TEXT,', ' wallet_address TEXT NOT NULL,')
    .replace(' source_amount TEXT,', ' source_amount TEXT NOT NULL,');

describe('the v5 -> v6 migration', () => {
  /** A v5 database with one buy row in it, stamped at 5. Returns the schema name. */
  const atVersionFive = async (): Promise<string> => {
    const schema = await createSchema();
    for (const sql of freshSchema().map(atV5)) await raw(schema, sql);
    await raw(schema, 'CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at BIGINT NOT NULL)');
    await raw(schema, 'INSERT INTO schema_migrations (version, applied_at) VALUES (5, 0)');
    await raw(
      schema,
      'INSERT INTO funding_requests (id, subject_alias, product_id, destination_currency_code, ' +
        'wallet_address, source_amount, fiat, payment_method_type, rail, status, status_history, ' +
        "created_at, updated_at) VALUES ('bought', 'alias-abc', 'app.dot', 'USDC_ASSETHUB', " +
        "'0x0', '25.00', 'USD', 'CREDIT_DEBIT_CARD', 'meld', 'settled', '[]', 1, 1)",
    );
    return schema;
  };

  it('calls every row that already exists a buy, and keeps its terms', async () => {
    // The population this migration meets is entirely buys, because nothing else could be
    // recorded. `DEFAULT 'buy'` is what says so, and it has to say so for rows written before the
    // column existed, not only for rows written after.
    const schema = await atVersionFive();
    try {
      const store = await openIn(schema);
      const carried = await store.byId('bought');
      expect(carried?.direction).toBe('buy');
      expect(carried?.wallet_address).toBe('0x0');
      expect(carried?.source_amount).toBe('25.00');
      expect(carried?.crypto_amount).toBeUndefined();
      await store.close();

      const applied = await query(schema, 'SELECT version FROM schema_migrations ORDER BY version');
      expect(applied.map((r) => Number(r.version))).toEqual([5, 6]);
    } finally {
      await dropSchema(schema);
    }
  });

  it('takes a sell on the migrated shape, with no address and no fiat amount', async () => {
    // The two NOT NULLs it drops are the point of the step: a sell has neither, and before this
    // the insert was refused by the table.
    const schema = await atVersionFive();
    try {
      const store = await openIn(schema);
      await store.create(sellRecord({ id: 'sold', client_reference: undefined }));
      const sold = await store.byId('sold');
      expect(sold?.direction).toBe('sell');
      expect(sold?.wallet_address).toBeUndefined();
      expect(sold?.source_amount).toBeUndefined();
      expect(sold?.crypto_amount).toBe('12.3456789012');
      await store.close();
    } finally {
      await dropSchema(schema);
    }
  });
});

describe('a fresh database and a migrated one are the same database', () => {
  /** Every column, in physical order, with the facts a dump or a `COPY` would care about. */
  const columnsOf = async (schema: string) =>
    query(
      schema,
      'SELECT ordinal_position, column_name, data_type, is_nullable, column_default ' +
        "FROM information_schema.columns WHERE table_name = 'funding_requests' " +
        'AND table_schema = current_schema() ORDER BY ordinal_position',
    );

  /** Every constraint, by name, as Postgres itself renders the definition. */
  const constraintsOf = async (schema: string) =>
    query(
      schema,
      'SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint ' +
        "WHERE conrelid = 'funding_requests'::regclass ORDER BY conname",
    );

  it('agrees column for column and constraint for constraint', async () => {
    // This is the test that was missing, and the omission shipped a real divergence:
    // `crypto_amount` was hand-placed after `source_amount` in `freshSchema()` while the
    // migration appends it at the end, so every column from `fiat` to `cancelled_at` held a
    // different ordinal depending on which path built the database.
    //
    // Nothing in this service reads a column by position, so it broke nothing here. That is
    // precisely the danger: CI builds fresh databases and production is migrated, so the
    // difference is invisible until a `COPY` without a column list, a `pg_dump` shape diff
    // between staging and production, or a `CREATE TABLE ... LIKE` behaves one way in every
    // test and another in production.
    //
    // Asserting the shape rather than the contents is what makes the shared-constant argument
    // in `schema.ts` enforceable instead of merely written down.
    const fresh = await createSchema();
    const migrated = await createSchema();
    try {
      await (await openIn(fresh)).close();

      for (const sql of freshSchema().map(atV5)) await raw(migrated, sql);
      await raw(migrated, 'CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at BIGINT NOT NULL)');
      await raw(migrated, 'INSERT INTO schema_migrations (version, applied_at) VALUES (5, 0)');
      await (await openIn(migrated)).close();

      expect(await columnsOf(migrated)).toEqual(await columnsOf(fresh));
      expect(await constraintsOf(migrated)).toEqual(await constraintsOf(fresh));
    } finally {
      await dropSchema(fresh);
      await dropSchema(migrated);
    }
  });
});

describe('the per-direction term constraints', () => {
  it('refuses a sell row with no crypto amount, on a fresh database and a migrated one', async () => {
    // The one a client's resume path depends on. Without a crypto amount, a resuming seller's
    // "is this the same sale?" check has nothing to compare but the corridor, so it matches a
    // different sale at a different amount and hands over its settlement surface. Enforced by
    // the database rather than by a guard in the store, so a future write path cannot miss it.
    await withStore(async (store) => {
      await expect(
        store.create(sellRecord({ id: 'no-amount', crypto_amount: undefined })),
      ).rejects.toThrow(/funding_sell_terms/);
    });
  });

  it('refuses a buy row that lost the terms the dropped NOT NULLs used to guarantee', async () => {
    // `wallet_address` and `source_amount` became nullable for the sake of sells. These keep
    // that from loosening a buy, which still requires both.
    await withStore(async (store) => {
      await expect(
        store.create(fundingRecord({ id: 'no-address', wallet_address: undefined })),
      ).rejects.toThrow(/funding_buy_terms/);
      await expect(
        store.create(fundingRecord({ id: 'no-amount', source_amount: undefined })),
      ).rejects.toThrow(/funding_buy_terms/);
    });
  });

  it('refuses a direction the vocabulary does not have', async () => {
    // The alphabet, exactly as the status check is. `DIRECTIONS` generates both the type and this
    // constraint, so a direction added in one place cannot be written without the other.
    await withStore(async (store) => {
      await expect(
        store.create(fundingRecord({ id: 'sideways', direction: 'sideways' as never })),
      ).rejects.toThrow(/funding_direction_known/);
    });
  });

  it.each([
    ['funding_sell_terms', () => sellRecord({ id: 'bad', crypto_amount: undefined })],
    ['funding_buy_terms', () => fundingRecord({ id: 'bad', wallet_address: undefined })],
    ['funding_buy_terms', () => fundingRecord({ id: 'bad', source_amount: undefined })],
  ])('has the in-memory fake refuse a %s row exactly as Postgres does', async (constraint, row) => {
    // The repo's rule is that a rule lives in one place: `mergeAdvance` is shared with the fake
    // so the advance cannot drift. These constraints cannot be shared that way, because one side
    // is SQL text and the other a predicate over a struct, so they are tied by this test instead.
    //
    // It matters because most of the suite writes through the fake. A fake more permissive than
    // the database lets a test reason about a row production cannot hold, and the whole point of
    // putting these in the database was that no future write path could produce one.
    await withStore(async (store) => {
      await expect(store.create(row())).rejects.toThrow(new RegExp(constraint));
    });
    await expect(fakeStore().create(row())).rejects.toThrow(new RegExp(constraint));
  });

  it('round-trips a sell through a database created fresh at the current version', async () => {
    // The other half of the migration story: a database that never walked the chain must carry
    // the same shape the chain produces, or the two paths disagree about what a row is.
    await withStore(async (store) => {
      await store.create(sellRecord({ id: 'sold', client_reference: 'idem-sell-1' }));
      const sold = await store.byId('sold');
      expect(sold).toMatchObject({
        direction: 'sell',
        destination_currency_code: 'DOT_ASSETHUB',
        crypto_amount: '12.3456789012',
        fiat: 'GBP',
      });
      expect(sold?.wallet_address).toBeUndefined();
      expect(sold?.source_amount).toBeUndefined();
      // The deposit leg exists as columns and is written by nothing in this build.
      expect(sold?.deposit_address).toBeUndefined();
      expect(sold?.deposit_observed_at).toBeUndefined();
    });
  });
});

describe('the real migration chain', () => {
  it('carries a v1 database through every shipped migration and keeps its rows', async () => {
    // The migrations this chain has actually had. Everything else here injects a synthetic one;
    // this runs `MIGRATIONS` as shipped, which is the thing that will execute against a real
    // database the first time one exists.
    const schema = await createSchema();
    try {
      // A v1 database: the current shape minus every column a later version adds, stamped at 1.
      //
      // Each new migration must strip its own column here. That is deliberate rather than derived:
      // a v1 shape reconstructed from `freshSchema()` is only a v1 shape as long as this list keeps
      // up, and forgetting an entry does not silently weaken the test. The migration then tries to
      // add a column that is already there and this fails loudly, which is how the omission is
      // caught.
      // supported_corridors is a v5 table, so a v1 database has none: filter it out before stripping
      // the later funding_requests columns, or its own ` country TEXT,` would be mangled too.
      const v1 = freshSchema()
        .filter((sql) => !sql.includes('supported_corridors'))
        .map((sql) =>
          sql
            .replace(' country TEXT,', '')
            .replace(' reason TEXT,', '')
            .replace(' cancelled_at BIGINT,', ''),
        )
        // Everything v6 adds, stripped by the same helper the v5 fixture uses.
        .map(atV5);
      for (const sql of v1) await raw(schema, sql);
      await raw(schema, 'CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at BIGINT NOT NULL)');
      await raw(schema, 'INSERT INTO schema_migrations (version, applied_at) VALUES (1, 0)');
      await raw(
        schema,
        "INSERT INTO funding_requests (id, subject_alias, product_id, destination_currency_code, " +
          "wallet_address, source_amount, fiat, payment_method_type, rail, status, status_history, " +
          "created_at, updated_at) VALUES ('older', 'alias-abc', 'app.dot', 'USDC_ASSETHUB', " +
          "'0x0', '25.00', 'USD', 'CREDIT_DEBIT_CARD', 'meld', 'settled', '[]', 1, 1)",
      );

      const store = await openIn(schema);

      // The row survived both shape changes, and reads back with neither column set, which is
      // honest: a request recorded before they existed genuinely has no country, and a `settled`
      // row was never refused so it has no reason either.
      const carried = await store.byId('older');
      expect(carried?.id).toBe('older');
      expect(carried?.country).toBeUndefined();
      expect(carried?.reason).toBeUndefined();
      expect(carried?.cancelled_at).toBeUndefined();
      // And both new columns are usable.
      await store.create(fundingRecord({ id: 'newer', country: 'DE', status: 'refused', client_reference: undefined, reason: 'BelowMinimum' }));
      const written = await store.byId('newer');
      expect(written?.country).toBe('DE');
      expect(written?.reason).toBe('BelowMinimum');
      // v4's column is usable through the store's own path, not just present in the table: the
      // cancel statement is the only writer, so exercising it is what proves the migration landed
      // somewhere the code can reach.
      await store.create(fundingRecord({ id: 'live', status: 'session_opened', client_reference: 'ref-live' }));
      const withdrawn = await store.cancel('alias-abc', 'app.dot', 'live', 99);
      expect(withdrawn?.cancelled_at).toBe(99);
      // v5's table is reachable through the store, not just present: the upsert and read prove the
      // migration landed somewhere the code can use.
      await store.upsertCorridor({
        destination_currency_code: 'DOT_ASSETHUB',
        country: 'BR',
        name: 'Brazil',
        fiat: 'BRL',
        methods: [{ paymentMethodType: 'PIX', category: 'bank', min: '10', max: '5000', currency: 'BRL' }],
      });
      expect((await store.readCorridors('DOT_ASSETHUB')).map((c) => c.country)).toEqual(['BR']);
      // v6: the pre-existing row is a buy, because it could not have been anything else, and the
      // column's DEFAULT is what says so without a backfill.
      expect(carried?.direction).toBe('buy');
      expect(carried?.crypto_amount).toBeUndefined();
      // And a sell round-trips through the store on the migrated shape: null address, null fiat
      // amount, the crypto amount at a precision the fiat validator cannot express.
      await store.create(sellRecord({ id: 'sold', client_reference: undefined }));
      const sold = await store.byId('sold');
      expect(sold?.direction).toBe('sell');
      expect(sold?.wallet_address).toBeUndefined();
      expect(sold?.source_amount).toBeUndefined();
      expect(sold?.crypto_amount).toBe('12.3456789012');
      await store.close();

      const applied = await query(schema, 'SELECT version FROM schema_migrations ORDER BY version');
      // Every step, in order, not just the last one. A chain that skipped a step and stamped the
      // end version would leave a shape this build reads against columns that do not exist.
      expect(applied.map((r) => Number(r.version))).toEqual([1, 2, 3, 4, 5, 6]);
    } finally {
      await dropSchema(schema);
    }
  });
});

describe('applying a migration', () => {
  // These inject a synthetic chain, so the applier is exercised over shapes the real list does
  // not contain: a step that fails halfway, a step already applied, a step that would carry the
  // database past what this build supports. The real chain is run as shipped by the test above.
  //
  // The step runs up to `SCHEMA_VERSION`, never past it: a database stamped beyond what the
  // build supports is refused, which is the guard asserted above. So the fixture is a database at
  // version 0 (an existing table with nothing recorded against it), which is exactly the shape a
  // real upgrade starts from.
  const toCurrent: Migration = {
    from: 0,
    to: SCHEMA_VERSION,
    sql: ['ALTER TABLE funding_requests ADD COLUMN status_history TEXT NOT NULL DEFAULT \'[]\''],
  };

  /**
   * A pre-versioning database: the table exists, nothing is recorded against it.
   *
   * Hand-written rather than derived from `freshSchema()`, because the point is a shape this build
   * does not produce. It carries every column except the one `toCurrent` adds, so a new column
   * added to the real schema must be added here too; if it is not, `create()` below fails on
   * the missing column rather than passing while proving less.
   */
  const atVersionZero = async (): Promise<string> => {
    const schema = await createSchema();
    await raw(
      schema,
      'CREATE TABLE funding_requests (' +
        ' id TEXT PRIMARY KEY, subject_alias TEXT NOT NULL, product_id TEXT NOT NULL,' +
        ' destination_currency_code TEXT NOT NULL, wallet_address TEXT NOT NULL,' +
        ' source_amount TEXT NOT NULL, fiat TEXT NOT NULL, payment_method_type TEXT NOT NULL,' +
        ' country TEXT, service_provider TEXT, client_reference TEXT, rail TEXT NOT NULL,' +
        ' provider_session_id TEXT, provider_transaction_id TEXT, provider_status TEXT,' +
        ' widget_url TEXT, hosted_widget_url TEXT, expires_at BIGINT, status TEXT NOT NULL,' +
        ' reason TEXT, cancelled_at BIGINT, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL,' +
        " direction TEXT NOT NULL DEFAULT 'buy', crypto_amount TEXT, deposit_address TEXT," +
        ' deposit_amount TEXT, deposit_currency TEXT, deposit_memo TEXT, deposit_observed_at BIGINT,' +
        ' claimed_by TEXT, claimed_until BIGINT)',
    );
    return schema;
  };

  it('runs a pending step and records the new version', async () => {
    const schema = await atVersionZero();
    try {
      const migrated = await openIn(schema, [toCurrent]);
      // The migrated shape is usable, which is the only claim that matters.
      await migrated.create(fundingRecord({ id: 'after' }));
      expect((await migrated.byId('after'))?.id).toBe('after');
      await migrated.close();

      const applied = await query(schema, 'SELECT version FROM schema_migrations ORDER BY version');
      expect(applied.map((r) => Number(r.version))).toEqual([SCHEMA_VERSION]);
    } finally {
      await dropSchema(schema);
    }
  });

  it('does not re-run a step already applied', async () => {
    const schema = await atVersionZero();
    try {
      await (await openIn(schema, [toCurrent])).close();
      // Re-running `ADD COLUMN` would fail with a duplicate-column error, which is exactly what a
      // restart after a successful migration must not do.
      const again = await openIn(schema, [toCurrent]);
      await again.close();
      const applied = await query(schema, 'SELECT version FROM schema_migrations ORDER BY version');
      expect(applied.map((r) => Number(r.version))).toEqual([SCHEMA_VERSION]);
    } finally {
      await dropSchema(schema);
    }
  });

  it('is not killed by the request-path statement timeout', async () => {
    // The pool's `statement_timeout` bounds a request-path query, and a migration is not one. A
    // single `ALTER TABLE` over a table with real rows outlasts ten seconds easily, and being
    // killed mid-migration means a crash loop with the rollback path as the only clue.
    //
    // A one-second sleep under a 300ms timeout stands in for that: it is killed unless the
    // migration connection clears the bound first.
    const schema = await atVersionZero();
    try {
      const slow: Migration = {
        from: 0,
        to: SCHEMA_VERSION,
        sql: ['SELECT pg_sleep(1)', "ALTER TABLE funding_requests ADD COLUMN status_history TEXT NOT NULL DEFAULT '[]'"],
      };

      const store = await openIn(schema, [slow], { statementTimeoutMs: 300 });
      await store.close();

      const applied = await query(schema, 'SELECT version FROM schema_migrations ORDER BY version');
      expect(applied.map((r) => Number(r.version))).toEqual([SCHEMA_VERSION]);
    } finally {
      await dropSchema(schema);
    }
  }, 20_000);

  it('rolls the whole step back when one of its statements fails', async () => {
    const schema = await atVersionZero();
    try {
      const halfBroken: Migration = {
        from: 0,
        to: SCHEMA_VERSION,
        sql: ['ALTER TABLE funding_requests ADD COLUMN good TEXT', 'THIS IS NOT SQL'],
      };

      await expect(openIn(schema, [halfBroken])).rejects.toThrow();

      // Neither the column nor the version stamp survived. A half-migrated database is worse than
      // an unmigrated one: the next boot reads a version that says the step is done and skips it.
      const columns = await query(
        schema,
        'SELECT column_name FROM information_schema.columns ' +
          `WHERE table_schema = '${schema}' AND table_name = 'funding_requests' AND column_name = 'good'`,
      );
      expect(columns).toEqual([]);
      const applied = await query(schema, 'SELECT version FROM schema_migrations ORDER BY version');
      expect(applied).toEqual([]);
    } finally {
      await dropSchema(schema);
    }
  });
});
