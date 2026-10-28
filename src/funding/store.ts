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
import type { CorridorDto } from '../meld/discovery.js';
import type { Direction, RailName } from '../rail.js';
import type { Secret } from '../secret.js';
import type { FundingState } from './state.js';
import { TERMINAL_STATES } from './state.js';
import {
  MIGRATIONS,
  MIGRATIONS_TABLE,
  KEEPER_LOCK_KEY,
  MIGRATION_LOCK_KEY,
  MIGRATION_LOCK_TIMEOUT_MS,
  SCHEMA_VERSION,
  freshSchema,
  type Migration,
} from './schema.js';
import { mergeAdvance, type UpdateExtra } from './merge.js';
import type { DepositConflictReason, FundingRecord, TimelineEntry } from './types.js';

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

/** A stored corridor method: the client-facing subset of `MethodLimit`, no provider roster. */
export type StoredMethod = CorridorDto['methods'][number];

/**
 * One supported-corridor row: a deliverable-or-sellable (crypto, direction, country) with its
 * fiat and methods.
 *
 * `direction` is part of what the row means, not merely a filter on it: a buy corridor and a sell
 * corridor for the same (crypto, country) are two different questions to Meld (different category,
 * different route argument order; see `meld/discovery.ts`) and can carry different `fiat` and
 * `methods`. See the v7 -> v8 migration in `schema.ts` for why it had to join the primary key
 * rather than merely widen the row.
 */
export interface SupportedCorridorRow {
  destination_currency_code: string;
  direction: Direction;
  country: string;
  name: string;
  fiat: string;
  methods: StoredMethod[];
  updated_at: number;
}

/** A sale vault proxy as the session path records it, addresses and ref lowercase. */
export interface NewSaleVaultProxyRow {
  funding_request_id: string;
  chain_id: number;
  factory: string;
  implementation: string;
  home: string;
  /** The seller's claimer, bound into the proxy address with the home. */
  claimer: string;
  proxy: string;
  ref: string;
}

/** A sale vault proxy row with the keeper's schedule. */
export interface SaleVaultProxyRow extends NewSaleVaultProxyRow {
  due_at: number | null;
  /** When a factory log or a transfer of at least MIN_RETURN last touched the proxy, the watch window's start. */
  last_activity_at: number;
  created_at: number;
  updated_at: number;
}

/** A sale's exact terms on one factory, the key its gas-deferred deliveries are booked under bar the deadline. */
export interface DeferralTerms {
  chain_id: number;
  factory: string;
  home: string;
  claimer: string;
  ref: string;
  recipient: string;
  /** USDC base units. */
  committed: bigint;
}

/** One gas-deferred delivery's full key as DeliveryDeferred logs it. */
export interface DeferralRow extends DeferralTerms {
  /** The sale's payment deadline in epoch seconds. */
  deadline: bigint;
}

/** One sale the keeper should look at, with the terms its delivery is booked under. */
export interface KeeperCandidate extends NewSaleVaultProxyRow {
  /** The provider's deposit address, undefined until disclosed. */
  deposit_address: string | undefined;
  /** The committed crypto as a decimal, undefined on a malformed row. */
  crypto_amount: string | undefined;
}

/** The keeper's on-chain actions, pinned by a CHECK in `schema.ts`. */
export type ProxyCallAction = 'deliver' | 'expire' | 'flush' | 'deploy' | 'return' | 'release' | 'skim' | 'relay';

/** USDC that reached a claimer: a proxy's release or a factory flush the proxy refused. */
export type PayoutKind = 'released' | 'flushed';

/** One payout to a claimer as its log recorded it, keyed by the log. */
export interface PayoutRow {
  chain_id: number;
  tx_hash: string;
  log_index: number;
  factory: string;
  home: string;
  claimer: string;
  kind: PayoutKind;
  /** USDC base units. */
  amount: bigint;
}

/** A proxy the keeper watches, with the home and claimer its address is derived from. */
export interface WatchedProxy {
  proxy: string;
  factory: string;
  home: string;
  claimer: string;
}

/** A keeper call's lifecycle, pinned by a CHECK in `schema.ts`. */
export type ProxyCallStatus = 'sending' | 'sent' | 'mined' | 'reverted' | 'dropped';

/** A keeper call before it is signed. For a skim `proxy` holds the factory, for a relay the claimer. */
export interface NewProxyCall {
  id: string;
  chain_id: number;
  sender: string;
  target: string;
  proxy: string;
  action: ProxyCallAction;
  amount: string | null;
}

/** A keeper call as stored. */
export interface ProxyCallRow extends NewProxyCall {
  nonce: number | null;
  tx_hash: string | null;
  status: ProxyCallStatus;
  error: string | null;
  created_at: number;
  updated_at: number;
}

const SALE_VAULT_PROXY_COLUMNS =
  'funding_request_id, chain_id, factory, implementation, home, claimer, proxy, ref, due_at, last_activity_at, created_at, updated_at';

const PROXY_CALL_COLUMNS =
  'id, chain_id, sender, target, proxy, action, amount, nonce, tx_hash, status, error, created_at, updated_at';

// The query surface both a pool and one checked-out client offer
type Queryable = Pick<PoolClient, 'query'>;

// A sale joined to its funding row's terms, as Postgres returns it
type CandidateRow = Omit<KeeperCandidate, 'deposit_address' | 'crypto_amount'> & { deposit_address: string | null; crypto_amount: string | null };

const CANDIDATE_SELECT =
  'SELECT p.funding_request_id, p.chain_id, p.factory, p.implementation, p.home, p.claimer, p.proxy, p.ref, f.deposit_address, f.crypto_amount ' +
  'FROM sale_vault_proxies p JOIN funding_requests f ON f.id = p.funding_request_id';

const toCandidate = (row: CandidateRow): KeeperCandidate => ({
  ...row,
  deposit_address: row.deposit_address ?? undefined,
  crypto_amount: row.crypto_amount ?? undefined,
});

/** The keeper's rows, bound to one connection so a locked pass runs on the connection that holds the lock. */
export class KeeperRows {
  constructor(private readonly db: Queryable) {}

  // Sales of these factories active since `sinceMs` and due by `now`, with no call in flight on their proxy
  async listKeeperCandidates(args: {
    chainId: number;
    factories: readonly string[];
    sinceMs: number;
    now: number;
    limit: number;
  }): Promise<KeeperCandidate[]> {
    const result = await this.db.query<CandidateRow>(
      `${CANDIDATE_SELECT} WHERE p.chain_id = $1 AND p.factory = ANY($2) AND p.last_activity_at >= $3 AND p.due_at IS NOT NULL AND p.due_at <= $4 ` +
        'AND NOT EXISTS (SELECT 1 FROM sale_vault_proxy_calls c ' +
        "WHERE c.chain_id = p.chain_id AND c.proxy = p.proxy AND c.status IN ('sending', 'sent')) " +
        'ORDER BY p.due_at ASC, p.created_at ASC LIMIT $5',
      [args.chainId, args.factories.map((f) => f.toLowerCase()), args.sinceMs, args.now, args.limit],
    );
    return result.rows.map(toCandidate);
  }

  // Every sale of one proxy, so a proxy is judged with all its sales at once
  async salesOfProxy(chainId: number, proxy: string): Promise<KeeperCandidate[]> {
    const result = await this.db.query<CandidateRow>(`${CANDIDATE_SELECT} WHERE p.chain_id = $1 AND p.proxy = $2 ORDER BY p.created_at ASC`, [
      chainId,
      proxy.toLowerCase(),
    ]);
    return result.rows.map(toCandidate);
  }

  // Distinct proxies of these factories' sales active since `sinceMs`, the ones a USDC transfer can make due
  async watchedProxies(args: { chainId: number; factories: readonly string[]; sinceMs: number }): Promise<WatchedProxy[]> {
    const result = await this.db.query<WatchedProxy>(
      'SELECT DISTINCT proxy, factory, home, claimer FROM sale_vault_proxies WHERE chain_id = $1 AND factory = ANY($2) AND last_activity_at >= $3 ORDER BY proxy',
      [args.chainId, args.factories.map((f) => f.toLowerCase()), args.sinceMs],
    );
    return result.rows;
  }

  // Which of these addresses are recorded proxies of these factories, at any age
  async recordedProxies(args: { chainId: number; factories: readonly string[]; proxies: readonly string[] }): Promise<WatchedProxy[]> {
    const result = await this.db.query<WatchedProxy>(
      'SELECT DISTINCT proxy, factory, home, claimer FROM sale_vault_proxies WHERE chain_id = $1 AND factory = ANY($2) AND proxy = ANY($3) ORDER BY proxy',
      [args.chainId, args.factories.map((f) => f.toLowerCase()), args.proxies.map((p) => p.toLowerCase())],
    );
    return result.rows;
  }

  // Proxies of these factories with no sale active since `sinceMs`, longest unchecked first
  async idleProxies(args: { chainId: number; factories: readonly string[]; sinceMs: number; limit: number }): Promise<{ proxy: string; factory: string }[]> {
    const result = await this.db.query<{ proxy: string; factory: string }>(
      'SELECT proxy, factory FROM sale_vault_proxies WHERE chain_id = $1 AND factory = ANY($2) ' +
        'GROUP BY proxy, factory HAVING MAX(last_activity_at) < $3 ORDER BY MAX(updated_at) ASC, proxy ASC LIMIT $4',
      [args.chainId, args.factories.map((f) => f.toLowerCase()), args.sinceMs, args.limit],
    );
    return result.rows;
  }

  // Record that idle proxies were checked, so the next batch takes others
  async markChecked(args: { chainId: number; proxies: readonly string[]; at: number }): Promise<void> {
    if (args.proxies.length === 0) return;
    await this.db.query('UPDATE sale_vault_proxies SET updated_at = $3 WHERE chain_id = $1 AND proxy = ANY($2)', [
      args.chainId,
      args.proxies.map((p) => p.toLowerCase()),
      args.at,
    ]);
  }

  // Make sales due now when a log names their home or proxy, after any schedule a running evaluation reads, a dust proxy due but not active
  async markDue(args: { chainId: number; homes: readonly string[]; proxies: readonly string[]; dust: readonly string[]; at: number }): Promise<void> {
    if (args.homes.length === 0 && args.proxies.length === 0 && args.dust.length === 0) return;
    await this.db.query(
      'UPDATE sale_vault_proxies SET due_at = $5, updated_at = $5, ' +
        'last_activity_at = CASE WHEN home = ANY($2) OR proxy = ANY($3) THEN $5 ELSE last_activity_at END ' +
        'WHERE chain_id = $1 AND (home = ANY($2) OR proxy = ANY($3) OR proxy = ANY($4))',
      [
        args.chainId,
        args.homes.map((h) => h.toLowerCase()),
        args.proxies.map((p) => p.toLowerCase()),
        args.dust.map((p) => p.toLowerCase()),
        args.at,
      ],
    );
  }

  // Make every sale of these factories active since `sinceMs` due, for a first scan with no cursor
  async markAllDue(args: { chainId: number; factories: readonly string[]; sinceMs: number; at: number }): Promise<void> {
    await this.db.query(
      'UPDATE sale_vault_proxies SET due_at = $4, updated_at = $4 WHERE chain_id = $1 AND factory = ANY($2) AND last_activity_at >= $3',
      [args.chainId, args.factories.map((f) => f.toLowerCase()), args.sinceMs, args.at],
    );
  }

  // Make every sale of these factories due and active, at any age
  async markFactoriesActive(args: { chainId: number; factories: readonly string[]; at: number }): Promise<void> {
    if (args.factories.length === 0) return;
    await this.db.query('UPDATE sale_vault_proxies SET due_at = $3, updated_at = $3, last_activity_at = $3 WHERE chain_id = $1 AND factory = ANY($2)', [
      args.chainId,
      args.factories.map((f) => f.toLowerCase()),
      args.at,
    ]);
  }

  // Set when a proxy is next looked at, keeping a due time an event set after `startedAt`
  async schedule(args: { chainId: number; proxy: string; dueAt: number | null; startedAt: number; at: number }): Promise<void> {
    await this.db.query(
      'UPDATE sale_vault_proxies SET due_at = CASE WHEN due_at > $4 THEN due_at ELSE $3 END, updated_at = $5 ' +
        'WHERE chain_id = $1 AND proxy = $2',
      [args.chainId, args.proxy.toLowerCase(), args.dueAt, args.startedAt, args.at],
    );
  }

  // The last block scanned on this chain, or undefined before the first scan
  async readCursor(chainId: number): Promise<bigint | undefined> {
    const result = await this.db.query<{ block: number }>('SELECT block FROM sale_vault_proxy_cursors WHERE chain_id = $1', [chainId]);
    const row = result.rows[0];
    return row === undefined ? undefined : BigInt(row.block);
  }

  async writeCursor(chainId: number, block: bigint): Promise<void> {
    await this.db.query(
      'INSERT INTO sale_vault_proxy_cursors (chain_id, block, updated_at) VALUES ($1, $2, $3) ' +
        'ON CONFLICT (chain_id) DO UPDATE SET block = EXCLUDED.block, updated_at = EXCLUDED.updated_at',
      [chainId, block.toString(), Date.now()],
    );
  }

  // Record deferred deliveries read off the logs, a range read again adding nothing
  async recordDeferrals(deferrals: readonly DeferralRow[]): Promise<void> {
    const now = Date.now();
    for (const d of deferrals) {
      await this.db.query(
        'INSERT INTO sale_vault_proxy_deferrals (chain_id, factory, home, claimer, ref, recipient, committed, deadline, created_at) ' +
          'VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT DO NOTHING',
        [
          d.chain_id,
          d.factory.toLowerCase(),
          d.home.toLowerCase(),
          d.claimer.toLowerCase(),
          d.ref.toLowerCase(),
          d.recipient.toLowerCase(),
          d.committed.toString(),
          d.deadline.toString(),
          now,
        ],
      );
    }
  }

  // Every recorded deadline of a sale's exact terms, earliest first
  async deferralDeadlines(terms: DeferralTerms): Promise<bigint[]> {
    const result = await this.db.query<{ deadline: string }>(
      'SELECT deadline FROM sale_vault_proxy_deferrals ' +
        'WHERE chain_id = $1 AND factory = $2 AND home = $3 AND claimer = $4 AND ref = $5 AND recipient = $6 AND committed = $7 ' +
        'ORDER BY length(deadline), deadline',
      [
        terms.chain_id,
        terms.factory.toLowerCase(),
        terms.home.toLowerCase(),
        terms.claimer.toLowerCase(),
        terms.ref.toLowerCase(),
        terms.recipient.toLowerCase(),
        terms.committed.toString(),
      ],
    );
    return result.rows.map((row) => BigInt(row.deadline));
  }

  // Record payouts to claimers read off the logs, a range read again adding nothing
  async recordPayouts(payouts: readonly PayoutRow[]): Promise<void> {
    const now = Date.now();
    for (const p of payouts) {
      await this.db.query(
        'INSERT INTO sale_vault_proxy_payouts (chain_id, tx_hash, log_index, factory, home, claimer, kind, amount, created_at) ' +
          'VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT DO NOTHING',
        [p.chain_id, p.tx_hash.toLowerCase(), p.log_index, p.factory.toLowerCase(), p.home.toLowerCase(), p.claimer.toLowerCase(), p.kind, p.amount.toString(), now],
      );
    }
  }

  // Claim a call before signing it. False when another call on this proxy is in flight.
  async claimProxyCall(call: NewProxyCall): Promise<boolean> {
    const now = Date.now();
    const result = await this.db.query(
      'INSERT INTO sale_vault_proxy_calls (id, chain_id, sender, target, proxy, action, amount, created_at, updated_at) ' +
        "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8) ON CONFLICT (chain_id, proxy) WHERE status IN ('sending', 'sent') DO NOTHING",
      [call.id, call.chain_id, call.sender.toLowerCase(), call.target.toLowerCase(), call.proxy.toLowerCase(), call.action, call.amount, now],
    );
    return result.rowCount === 1;
  }

  // Record the signed hash and nonce before the broadcast leaves
  async markProxyCallSent(id: string, txHash: string, nonce: number): Promise<void> {
    await this.db.query(
      "UPDATE sale_vault_proxy_calls SET status = 'sent', tx_hash = $2, nonce = $3, updated_at = $4 WHERE id = $1 AND status = 'sending'",
      [id, txHash, nonce, Date.now()],
    );
  }

  // Settle an in-flight call. A settled call is never moved again.
  async settleProxyCall(id: string, status: 'mined' | 'reverted' | 'dropped', error?: string): Promise<void> {
    await this.db.query(
      'UPDATE sale_vault_proxy_calls SET status = $2, error = $3, updated_at = $4 ' + "WHERE id = $1 AND status IN ('sending', 'sent')",
      [id, status, error ?? null, Date.now()],
    );
  }

  // Every sender's calls on one chain still sending or sent, oldest first, so a rotated key's calls still settle
  async readInflightProxyCalls(chainId: number): Promise<ProxyCallRow[]> {
    const result = await this.db.query<ProxyCallRow>(
      `SELECT ${PROXY_CALL_COLUMNS} FROM sale_vault_proxy_calls WHERE chain_id = $1 ` +
        "AND status IN ('sending', 'sent') ORDER BY created_at ASC, id ASC",
      [chainId],
    );
    return result.rows;
  }
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
  'direction',
  'destination_currency_code',
  'wallet_address',
  'source_amount',
  'crypto_amount',
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
  // The sell deposit leg. Named by the INSERT (which must name every column it binds), which is
  // why every row still starts out NULL here, and by `UPDATE_QUERY` too: the worker's observation
  // finder is what fills these once a provider discloses, through `UpdateExtra.deposit` and
  // `mergeAdvance`/`mergeDeposit` (`funding/merge.ts`), which is also where a conflicting
  // disclosure is recorded rather than accepted. Nothing else writes them.
  'deposit_address',
  'deposit_amount',
  'deposit_currency',
  'deposit_memo',
  'deposit_observed_at',
  // Where a deposit-address disclosure conflict is recorded. See `mergeDeposit` and the v6 -> v7
  // migration in `schema.ts`.
  'deposit_conflict_address',
  'deposit_conflict_reason',
  'deposit_conflict_at',
  // The seller's own account on a sell. Written once at create, never by `UPDATE_QUERY`.
  'seller_account',
  // The seller's claimer on an Arbitrum sell, written once at create like the account.
  'seller_claimer',
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
 * The eight deposit-shaped columns ($12-$19) are here for exactly one writer: the worker's
 * observation finder, through `mergeAdvance`/`mergeDeposit`. Every other caller's merged record
 * carries the previous row's deposit and conflict fields untouched (`mergeDeposit` coalesces
 * them), so binding them unconditionally on every update is not a new way for them to be written,
 * only the one place they finally can be.
 *
 * `$21` is the claim guard. When the caller holds a lease the update matches only while that lease
 * is still theirs; `Onramp` passes null and matches on the id alone, because a request path is not
 * leased and is the only writer of the row it just reserved.
 */
const UPDATE_QUERY =
  'UPDATE funding_requests ' +
  'SET status = $1, status_history = $2, provider_transaction_id = $3, provider_session_id = $4, ' +
  '    provider_status = $5, widget_url = $6, hosted_widget_url = $7, expires_at = $8, ' +
  '    client_reference = $9, reason = $10, updated_at = $11, ' +
  '    deposit_address = $12, deposit_amount = $13, deposit_currency = $14, deposit_memo = $15, ' +
  '    deposit_observed_at = $16, deposit_conflict_address = $17, deposit_conflict_reason = $18, ' +
  '    deposit_conflict_at = $19 ' +
  'WHERE id = $20 AND ($21::text IS NULL OR claimed_by = $21)';


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
   * - `deposit_address IS NULL`: a sell's analogue of "the money is in flight" is the seller
   *   broadcasting on-chain, which this service cannot see and does not cause -- there is no
   *   observation to wait for the way `transaction_seen` waits for one. Once a deposit address has
   *   been shown to a seller, they may already have sent to it, and this service has no way to
   *   know either way. Telling them the request is cancelled would be exactly the lie the
   *   `transaction_seen` guard exists to prevent, just from the other side of the same address.
   *   Checked directly on the column rather than inferred from `status`, deliberately: the status
   *   at which Meld first discloses a sell's address is unverified (the probe found no sandbox
   *   sell to observe it against), and a rule tied to a status this service is not sure of yet
   *   would stop protecting the moment that status turned out to be wrong. The column is the one
   *   fact this service is certain of either way.
   *
   * The status is left alone on purpose. See `FundingRecord.cancelled_at`. The worker goes on
   * watching, so a payment already on its way is still observed and still settles.
   *
   * Returns the row as it now stands, or `undefined` when nothing matched, which the caller turns
   * into a refusal it can explain, since "not yours", "already paid", "already disclosed" and
   * "already cancelled" are four different answers and only the row can tell them apart.
   */
  async cancel(alias: string, productId: string, id: string, now: number): Promise<FundingRecord | undefined> {
    const updated = await this.one(
      'UPDATE funding_requests SET cancelled_at = $1, updated_at = $1 ' +
        'WHERE id = $2 AND subject_alias = $3 AND product_id = $4 ' +
        "AND status IN ('created', 'session_opened') AND cancelled_at IS NULL " +
        'AND deposit_address IS NULL ' +
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
          updated.deposit_address ?? null,
          updated.deposit_amount ?? null,
          updated.deposit_currency ?? null,
          updated.deposit_memo ?? null,
          updated.deposit_observed_at ?? null,
          updated.deposit_conflict_address ?? null,
          updated.deposit_conflict_reason ?? null,
          updated.deposit_conflict_at ?? null,
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

  // Upsert one supported-corridor row (crypto, direction, country); `updated_at` stamped here.
  //
  // The conflict target names all three columns of the v7 -> v8 primary key. Two of them
  // (`destination_currency_code`, `country`) were the whole key before that migration; naming only
  // those two here after the key grew would upsert a sell corridor onto whatever row a buy
  // corridor for the same (crypto, country) happened to hold, overwriting its `fiat` and `methods`
  // silently, on every refresh pass -- the same failure the migration exists to make impossible at
  // the table, reintroduced at the one write site if this list ever drifted from it.
  async upsertCorridor(row: Omit<SupportedCorridorRow, 'updated_at'>): Promise<void> {
    await this.pool.query(
      'INSERT INTO supported_corridors (destination_currency_code, direction, country, name, fiat, methods, updated_at) ' +
        'VALUES ($1, $2, $3, $4, $5, $6, $7) ' +
        'ON CONFLICT (destination_currency_code, direction, country) DO UPDATE SET ' +
        'name = EXCLUDED.name, fiat = EXCLUDED.fiat, methods = EXCLUDED.methods, updated_at = EXCLUDED.updated_at',
      [row.destination_currency_code, row.direction, row.country, row.name, row.fiat, JSON.stringify(row.methods), Date.now()],
    );
  }

  // Fresh supported corridors for one (crypto, direction), name-sorted; `freshAfter` ages out rows
  // the refresh stopped touching (0 = all). `direction` is required, not defaulted to `buy` here:
  // this is the storage layer, and a caller that means "buy" says so explicitly the way
  // `upsertCorridor`'s caller already must (`Onramp.supportedCorridors` is where an omitted wire
  // `direction` becomes `buy`; see `rail.ts`'s `DEFAULT_DIRECTION`).
  async readCorridors(code: string, direction: Direction, freshAfter = 0): Promise<SupportedCorridorRow[]> {
    const result = await this.pool.query<SupportedCorridorRow>(
      'SELECT destination_currency_code, direction, country, name, fiat, methods, updated_at FROM supported_corridors ' +
        'WHERE destination_currency_code = $1 AND direction = $2 AND updated_at >= $3 ORDER BY name ASC, country ASC',
      [code, direction, freshAfter],
    );
    return result.rows;
  }

  // Record the proxy and ref an Arbitrum sell pays from, once. Not due until a log touches it.
  async insertSaleVaultProxy(row: NewSaleVaultProxyRow): Promise<void> {
    const now = Date.now();
    await this.pool.query(
      'INSERT INTO sale_vault_proxies (funding_request_id, chain_id, factory, implementation, home, claimer, proxy, ref, last_activity_at, created_at, updated_at) ' +
        'VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9, $9) ON CONFLICT (funding_request_id) DO NOTHING',
      [
        row.funding_request_id,
        row.chain_id,
        row.factory.toLowerCase(),
        row.implementation.toLowerCase(),
        row.home.toLowerCase(),
        row.claimer.toLowerCase(),
        row.proxy.toLowerCase(),
        row.ref.toLowerCase(),
        now,
      ],
    );
  }

  // Drop the proxy row of a sell whose session never opened
  async deleteSaleVaultProxy(fundingRequestId: string): Promise<void> {
    await this.pool.query('DELETE FROM sale_vault_proxies WHERE funding_request_id = $1', [fundingRequestId]);
  }

  // The proxy row for a funding request, or undefined for a sale without one
  async readSaleVaultProxy(fundingRequestId: string): Promise<SaleVaultProxyRow | undefined> {
    const result = await this.pool.query<SaleVaultProxyRow>(
      `SELECT ${SALE_VAULT_PROXY_COLUMNS} FROM sale_vault_proxies WHERE funding_request_id = $1`,
      [fundingRequestId],
    );
    return result.rows[0];
  }

  // Whether a sale of this product recorded this claimer, the relay's only gate on whose USDC it moves
  async isSellerClaimer(productId: string, claimer: string): Promise<boolean> {
    const result = await this.pool.query(
      'SELECT 1 FROM funding_requests WHERE seller_claimer = $1 AND product_id = $2 LIMIT 1',
      [claimer.toLowerCase(), productId],
    );
    return result.rowCount === 1;
  }

  // Whether an address is any sale's claimer or one of the chain's recorded proxies
  async isSaleAddress(chainId: number, address: string): Promise<boolean> {
    const result = await this.pool.query(
      'SELECT 1 FROM funding_requests WHERE seller_claimer = $1 ' +
        'UNION ALL SELECT 1 FROM sale_vault_proxies WHERE chain_id = $2 AND proxy = $1 LIMIT 1',
      [address.toLowerCase(), chainId],
    );
    return result.rowCount === 1;
  }

  // Every payout recorded to one home and claimer on a factory, oldest first, with when the keeper read it
  async readPayouts(terms: Pick<PayoutRow, 'chain_id' | 'factory' | 'home' | 'claimer'>): Promise<(PayoutRow & { created_at: number })[]> {
    const result = await this.pool.query<Omit<PayoutRow, 'amount'> & { amount: string; created_at: number }>(
      'SELECT chain_id, tx_hash, log_index, factory, home, claimer, kind, amount, created_at FROM sale_vault_proxy_payouts ' +
        'WHERE chain_id = $1 AND factory = $2 AND home = $3 AND claimer = $4 ORDER BY created_at ASC, tx_hash ASC, log_index ASC',
      [terms.chain_id, terms.factory.toLowerCase(), terms.home.toLowerCase(), terms.claimer.toLowerCase()],
    );
    return result.rows.map((row) => ({ ...row, amount: BigInt(row.amount) }));
  }

  // The newest call on one proxy, or undefined when none was ever made
  async readLatestProxyCall(chainId: number, proxy: string): Promise<ProxyCallRow | undefined> {
    const result = await this.pool.query<ProxyCallRow>(
      `SELECT ${PROXY_CALL_COLUMNS} FROM sale_vault_proxy_calls WHERE chain_id = $1 AND proxy = $2 ` +
        'ORDER BY created_at DESC, id DESC LIMIT 1',
      [chainId, proxy.toLowerCase()],
    );
    return result.rows[0];
  }

  // The keeper's rows over the pool, for reads that need no lock
  keeperRows(): KeeperRows {
    return new KeeperRows(this.pool);
  }

  // Run `fn` holding the keeper lock, every query on the locking connection, or undefined when another replica holds it
  async withKeeperLock<T>(fn: (rows: KeeperRows) => Promise<T>): Promise<T | undefined> {
    const client = await this.pool.connect();
    try {
      const taken = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [KEEPER_LOCK_KEY]);
      if (taken.rows[0]?.locked !== true) return undefined;
      try {
        return await fn(new KeeperRows(client));
      } finally {
        await client.query('SELECT pg_advisory_unlock($1)', [KEEPER_LOCK_KEY]);
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
  direction: Direction;
  destination_currency_code: string;
  wallet_address: string | null;
  source_amount: string | null;
  crypto_amount: string | null;
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
  deposit_address: string | null;
  deposit_amount: string | null;
  deposit_currency: string | null;
  deposit_memo: string | null;
  deposit_observed_at: number | null;
  deposit_conflict_address: string | null;
  deposit_conflict_reason: DepositConflictReason | null;
  deposit_conflict_at: number | null;
  seller_account: string | null;
  seller_claimer: string | null;
  status_history: string;
  created_at: number;
  updated_at: number;
}

function rowToRecord(row: Row): FundingRecord {
  return {
    ...row,
    wallet_address: row.wallet_address ?? undefined,
    source_amount: row.source_amount ?? undefined,
    crypto_amount: row.crypto_amount ?? undefined,
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
    deposit_address: row.deposit_address ?? undefined,
    deposit_amount: row.deposit_amount ?? undefined,
    deposit_currency: row.deposit_currency ?? undefined,
    deposit_memo: row.deposit_memo ?? undefined,
    deposit_observed_at: row.deposit_observed_at ?? undefined,
    deposit_conflict_address: row.deposit_conflict_address ?? undefined,
    deposit_conflict_reason: row.deposit_conflict_reason ?? undefined,
    deposit_conflict_at: row.deposit_conflict_at ?? undefined,
    seller_account: row.seller_account ?? undefined,
    seller_claimer: row.seller_claimer ?? undefined,
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
    direction: r.direction,
    destination_currency_code: r.destination_currency_code,
    wallet_address: r.wallet_address ?? null,
    source_amount: r.source_amount ?? null,
    crypto_amount: r.crypto_amount ?? null,
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
    deposit_address: r.deposit_address ?? null,
    deposit_amount: r.deposit_amount ?? null,
    deposit_currency: r.deposit_currency ?? null,
    deposit_memo: r.deposit_memo ?? null,
    deposit_observed_at: r.deposit_observed_at ?? null,
    deposit_conflict_address: r.deposit_conflict_address ?? null,
    deposit_conflict_reason: r.deposit_conflict_reason ?? null,
    deposit_conflict_at: r.deposit_conflict_at ?? null,
    seller_account: r.seller_account ?? null,
    seller_claimer: r.seller_claimer ?? null,
    status_history: JSON.stringify(r.status_history),
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
  return COLUMN_LIST.map((name) => byName[name]);
}
