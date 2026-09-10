import { encodeAddress } from '@polkadot/util-crypto';

import { parseConfig, type Config } from '../src/config.js';
import { TERMINAL_STATES, type FundingState } from '../src/funding/state.js';
import { mergeAdvance } from '../src/funding/merge.js';
import type { FundingStore } from '../src/funding/store.js';
import type { FundingRecord } from '../src/funding/types.js';
import type { RailSessionInput } from '../src/rail.js';

const ALICE_PUBKEY = new Uint8Array([
  0xd4, 0x35, 0x93, 0xc7, 0x15, 0xfd, 0xd3, 0x1c, 0x61, 0x14, 0x1a, 0xbd, 0x04, 0xa9, 0x9f, 0xd6,
  0x82, 0x2c, 0x85, 0x58, 0x85, 0x4c, 0xcd, 0xe3, 0x9a, 0x56, 0x84, 0xe7, 0xa5, 0x6d, 0xa2, 0x7d,
]);

/** Asset Hub form (`1...`), which is what the service pins. */
export const ALICE = encodeAddress(ALICE_PUBKEY, 0);
/** The default-prefix form (`5...`) a careless caller sends. */
export const ALICE_PREFIX_42 = encodeAddress(ALICE_PUBKEY, 42);

/**
 * A well-formed address whose public key is too short to be an account.
 *
 * SS58 permits 1, 2, 4, 8, 32 and 33-byte payloads, so this encodes and checksums cleanly
 * and is still not an account, which is why the length check exists.
 */
export const SHORT_KEY_ADDRESS = encodeAddress(ALICE_PUBKEY.slice(0, 8), 0);

/** A different person entirely, not another spelling of ALICE (which normalises back to it). */
export const BOB = encodeAddress(new Uint8Array(32).fill(2), 0);

export const rawConfig = (overrides: Record<string, unknown> = {}) => ({
  // `development`, because the base fixture pairs this with `auth.mode: 'insecure_dev'` and that
  // mode is refused anywhere else: it gives every caller of a product the same alias, so a
  // sandbox in that mode leaks funding rows between callers. `personhoodConfig` overrides this
  // back to `sandbox`, which is where the environment-sensitive guards are actually exercised.
  environment: 'development',
  server: { port: 8080, host: '127.0.0.1', log_level: 'silent' },
  meld: {
    base_url: 'https://api-sb.meld.io',
    api_key: { mode: 'env', var: 'TEST_KEY' },
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
  auth: { mode: 'insecure_dev' },
  limits: [{ code: 'USDC_ASSETHUB', min: '10.00', max: '2000.00', currency: 'USD' }],
  allowed_products: ['app.dot'],
  cors: { allowed_origins: ['https://app.example'] },
  rate_limit: { per_person_max: 1000, per_address_max: 1000, window_seconds: 60 },
  session_creation_enabled: true,
  /**
   * The store block here is never connected to: this fixture builds configs, and the suites that
   * need a database build their own block from `test/pg.ts`. It is `mode: file` and `ssl: true`
   * so that a test overriding `environment` stays valid for reasons that have to do with what it
   * is testing.
   */
  store: {
    host: 'localhost',
    database: 'onramp_test',
    user: 'test',
    // File mode, like the other two credentials and like every real deployment: `env` is refused
    // outside development, so an env-mode default here would make any fixture that overrides
    // `environment` invalid for a reason that has nothing to do with what it is testing.
    password: { mode: 'file', path: '/run/secrets/store-password' },
    // `true`, so the fixture stays valid under every `environment` a test overrides it with.
    // The schema refuses plaintext outside development. Nothing here connects; the tests that do
    // build their own block from `test/pg.ts`.
    ssl: true,
  },
  worker: { interval_ms: 15_000, enabled: false },
  ...overrides,
});

/**
 * A personhood-mode config, so tests can exercise the real gate without a chain behind it.
 * The commitment is whatever the injected stub serves; only the wiring is exercised here.
 */
export const personhoodConfig = (overrides: Record<string, unknown> = {}) =>
  rawConfig({
    environment: 'sandbox',
    // File-mounted secrets, because `sandbox` refuses `mode: 'env'`. An environment variable is
    // readable from the process table and echoed by the pod spec, which is the vector the
    // file-mount design exists to avoid. The paths are never opened: `parseConfig` validates the
    // descriptor and `resolveSecret` reads the bytes later, and no test here gets that far.
    meld: { ...(rawConfig().meld as Record<string, unknown>), api_key: { mode: 'file', path: '/run/secrets/meld-api-key' } },
    auth: {
      mode: 'personhood',
      personhood: {
        jwt_key: { mode: 'file', path: '/run/secrets/jwt-key' },
        people_rpc_url: 'wss://127.0.0.1:9944',
        collections: [{ identifier: '0x' + '11'.repeat(32), ring_exponent: 9 }],
        challenge_ttl_ms: 60_000,
        token_ttl_s: 300,
      },
    },
    ...overrides,
  });

export const config = (overrides: Record<string, unknown> = {}): Config =>
  parseConfig(rawConfig(overrides));

/** The body the consumer frontend said it would send, field for field. */
export const createRequest = (overrides: Record<string, unknown> = {}) => ({
  idempotencyKey: 'idem-0000-0001',
  destinationCurrencyCode: 'USDC_ASSETHUB',
  walletAddress: ALICE,
  sourceAmount: '25.00',
  fiat: 'USD',
  country: 'US',
  paymentMethodType: 'CREDIT_DEBIT_CARD',
  // Required since 2026-09-02: Meld refuses a session whose `serviceProvider` is absent exactly as
  // it refuses a null one, so the field was optional here and mandatory upstream.
  serviceProvider: 'TRANSAK',
  ...overrides,
});

/**
 * A neutral rail session input, as `Onramp` builds one.
 *
 * Shared for the same reason `fundingRecord` is: the struct was written out by hand in two test
 * files and five places, so adding `redirectUrl` to it missed four of them until the compiler
 * said so. `clientReference` is a funding row id, never a caller's idempotency key.
 */
export const railSessionInput = (overrides: Partial<RailSessionInput> = {}): RailSessionInput => ({
  destinationCode: 'USDC_ASSETHUB',
  walletAddress: '5x...',
  sourceAmount: '25.00',
  fiat: 'USD',
  countryCode: 'US',
  paymentMethodType: 'CREDIT_DEBIT_CARD',
  serviceProvider: 'TRANSAK',
  clientReference: 'funding-1',
  redirectUrl: undefined,
  ...overrides,
});

export const quoteRequestBody = (overrides: Record<string, unknown> = {}) => ({
  destinationCurrencyCode: 'USDC_ASSETHUB',
  sourceAmount: '20',
  fiat: 'USD',
  country: 'US',
  paymentMethodType: 'CREDIT_DEBIT_CARD',
  ...overrides,
});

/**
 * One funding record, overridable.
 *
 * Shared because the same twenty-three fields were written out in full in four places, so adding a
 * column meant editing four fixtures and the fifth (inline in a route test) got missed.
 */
export const fundingRecord = (overrides: Partial<FundingRecord> = {}): FundingRecord => ({
  id: 'funding-1',
  subject_alias: 'alias-abc',
  product_id: 'app.dot',
  destination_currency_code: 'USDC_ASSETHUB',
  wallet_address: '0x...',
  source_amount: '25.00',
  fiat: 'USD',
  payment_method_type: 'CREDIT_DEBIT_CARD',
  // Matches `createRequest`'s default, so a seeded row and a fresh request are the same
  // request, which is what the idempotency replay tests are about. A mismatch would make every
  // one of them assert `IDEMPOTENCY_KEY_REUSED` by accident.
  country: 'US',
  service_provider: 'TRANSAK',
  // Absent by default: the unique index is partial on NOT NULL, so records that do not care
  // about idempotency can share a store without colliding. Tests that exercise it pass one.
  client_reference: undefined,
  rail: 'meld',
  provider_session_id: 'meld-1',
  provider_transaction_id: undefined,
  provider_status: undefined,
  widget_url: undefined,
  hosted_widget_url: undefined,
  expires_at: undefined,
  status: 'session_opened',
  status_history: [{ status: 'session_opened', at: 1_700_000_000_000 }],
  created_at: 1_700_000_000_000,
  updated_at: 1_700_000_000_000,
  ...overrides,
});

/**
 * An in-memory stand-in for `FundingStore`, honouring the parts of its contract the callers rely
 * on: the state machine refuses an illegal transition, `update` answers `undefined` for a row that
 * is not there, `claim` leases oldest-first and skips rows already leased, and `release` only
 * frees what the named worker holds.
 *
 * The store's own suite runs against a real Postgres, because storage behaviour is what it
 * asserts. Everything else (the worker's tick logic, the routes, `Onramp`) is about what the
 * service does with the answers, so pointing those at a database would buy coverage of `pg`
 * rather than of this repo, and would trade several hundred hermetic tests for a service
 * dependency. The compiler keeps this honest: `FundingPort` is derived from `FundingStore` with
 * `Pick`, so a method that changes shape breaks every fake at once rather than letting them drift
 * into passing against a contract that no longer exists.
 */
export function fakeStore(initial: readonly FundingRecord[] = []) {
  const rows = new Map<string, FundingRecord>(initial.map((r) => [r.id, structuredClone(r)]));
  const leases = new Map<string, { by: string; until: number }>();

  /** The row already holding this record's (alias, product, reference), if any. */
  const held = (record: FundingRecord): FundingRecord | undefined =>
    [...rows.values()].find(
      (r) =>
        r.client_reference !== undefined &&
        r.client_reference === record.client_reference &&
        r.subject_alias === record.subject_alias &&
        r.product_id === record.product_id,
    );

  return {
    rows,
    reserve: async (record: FundingRecord) => {
      const clash = held(record);
      if (clash !== undefined) return { outcome: 'existing' as const, record: structuredClone(clash) };
      if (rows.has(record.id)) throw new Error('duplicate key value violates unique constraint');
      rows.set(record.id, structuredClone(record));
      return { outcome: 'inserted' as const };
    },
    create: async (record: FundingRecord) => {
      if (rows.has(record.id)) throw new Error('duplicate key value violates unique constraint');
      // The partial unique index applies to `create` too, not only to `reserve`. Omitting it here
      // made the fake more permissive than the real store: a second row could take a
      // `client_reference` that Postgres would have refused, so any test asserting that a held key
      // blocks a second reservation passed without the constraint doing anything.
      if (record.client_reference !== undefined && held(record)) {
        throw new Error('duplicate key value violates unique constraint "funding_by_reference"');
      }
      rows.set(record.id, structuredClone(record));
    },
    byId: async (id: string) => structuredClone(rows.get(id)),
    byAlias: async (id: string, alias: string, productId: string) => {
      const row = rows.get(id);
      return row?.subject_alias === alias && row.product_id === productId ? structuredClone(row) : undefined;
    },
    // Mirrors the real statement's `WHERE`, condition for condition. A fake that just stamped the
    // timestamp would let a test "cancel" a paid request and pass, which is the one outcome the
    // real query exists to make impossible.
    cancel: async (alias: string, productId: string, id: string, now: number) => {
      const row = rows.get(id);
      if (
        row === undefined ||
        row.subject_alias !== alias ||
        row.product_id !== productId ||
        !['created', 'session_opened'].includes(row.status) ||
        row.cancelled_at !== undefined
      ) {
        return undefined;
      }
      const updated = { ...structuredClone(row), cancelled_at: now, updated_at: now };
      rows.set(id, updated);
      return structuredClone(updated);
    },
    byReference: async (alias: string, productId: string, reference: string) => {
      const row = [...rows.values()].find(
        (r) => r.subject_alias === alias && r.product_id === productId && r.client_reference === reference,
      );
      return row === undefined ? undefined : structuredClone(row);
    },
    list: async (alias: string, productId: string, limit = 100, includeRefused = false) =>
      [...rows.values()]
        .filter((r) => r.subject_alias === alias && r.product_id === productId)
        // The real store excludes refusals unless asked. A fake that returned them would make
        // every list assertion pass against a store that had lost the exclusion.
        .filter((r) => includeRefused || r.status !== 'refused')
        .sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? 1 : -1))
        .slice(0, limit)
        .map((r) => structuredClone(r)),
    pruneRefusals: async (cutoff: number) => {
      // Only `refused`, and only past the cutoff: the same two conditions the real DELETE has.
      const doomed = [...rows.values()].filter((r) => r.status === 'refused' && r.created_at < cutoff);
      for (const row of doomed) rows.delete(row.id);
      return doomed.length;
    },
    claim: async (workerId: string, now: number, ttlMs: number, limit: number) => {
      const claimable = [...rows.values()]
        .filter((r) => !TERMINAL_STATES.includes(r.status))
        .filter((r) => {
          const lease = leases.get(r.id);
          return lease === undefined || lease.until < now;
        })
        .sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : 1))
        .slice(0, limit);
      for (const row of claimable) leases.set(row.id, { by: workerId, until: now + ttlMs });
      return claimable.map((r) => structuredClone(r));
    },
    release: async (workerId: string, ids: readonly string[]) => {
      for (const id of ids) if (leases.get(id)?.by === workerId) leases.delete(id);
    },
    // Every field the real `update` merges, in the same way. A fake that quietly drops one is
    // worse than no fake: the suite goes green while the behaviour it is defending is gone.
    /**
     * Signature borrowed from the real store rather than restated.
     *
     * Hand-copied instead, it would drift the moment a column like `reason` were added to
     * `FundingStore.update`. The fake went on compiling (`Onramp` holds the store by a structural
     * interface, so passing an option the parameter type does not declare is not an
     * excess-property error) and silently dropped the value, so the production write was right and
     * every test that read it back saw `undefined`. Derived, the option type cannot drift at all.
     *
     * It does not prove the fake propagates what it accepts; no type can. That is what the
     * refusal-reason tests in `onramp.test.ts` are for, and dropping the line below still fails
     * them.
     */
    update: (async (
      id: string,
      to: FundingState,
      now: number,
      extra?: Parameters<FundingStore['update']>[3],
    ) => {
      const previous = rows.get(id);
      if (previous === undefined) return undefined;
      if (extra?.claimedBy !== undefined && leases.get(id)?.by !== extra.claimedBy) return undefined;
      // The store's own merge, not a copy of it. Restating the eight-field
      // coalescing by hand, so every hermetic test asserted against a second implementation of the
      // rule. When `reason` was added the copy dropped it, leaving production correct and every
      // test that read it back seeing `undefined`.
      const updated = mergeAdvance(previous, to, now, extra);
      rows.set(id, updated);
      return structuredClone(updated);
    }) satisfies FundingStore['update'],
    close: async () => undefined,
  };
}

/**
 * A stand-in for the browser `WebSocket` the People-chain reader constructs.
 *
 * Shared rather than defined per file: `units.test.ts` grew one to drive `chainReader`, and
 * `startup.test.ts` needs the same thing to reach the ring-VRF verifier through
 * `buildPersonhood`, which is the only place the real verifier is bound, and so the only place
 * its wiring can be asserted.
 */
export type FakeSocket = {
  sent: string[];
  closed: boolean;
  addEventListener(type: string, fn: (e: unknown) => void): void;
  send(data: string): void;
  close(): void;
  emit(type: string, event: unknown): void;
};

export const fakeSocket = (): FakeSocket => {
  const listeners = new Map<string, Array<(event: unknown) => void>>();
  const socket: FakeSocket = {
    sent: [],
    closed: false,
    addEventListener(type: string, fn: (e: unknown) => void): void {
      const list = listeners.get(type) ?? [];
      list.push(fn);
      listeners.set(type, list);
    },
    send(data: string): void {
      socket.sent.push(data);
    },
    close(): void {
      socket.closed = true;
    },
    emit(type: string, event: unknown): void {
      for (const fn of listeners.get(type) ?? []) fn(event);
    },
  };
  return socket;
};

/**
 * Run `f` with `globalThis.WebSocket` replaced by a constructor returning `socket`.
 *
 * The reader builds its socket when the read runs, not when the reader is built, so the stub has
 * to cover the whole call rather than just construction.
 */
export const withSocket = <T>(socket: FakeSocket, f: () => T): T => {
  const original = globalThis.WebSocket;
  const stub = (function (this: unknown) {
    return socket;
  }) as unknown as { new (url: string): WebSocket };
  Object.defineProperty(globalThis, 'WebSocket', { value: stub, configurable: true });
  try {
    return f();
  } finally {
    Object.defineProperty(globalThis, 'WebSocket', { value: original, configurable: true });
  }
};
