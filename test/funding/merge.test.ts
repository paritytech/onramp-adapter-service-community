import { describe, expect, it } from 'vitest';

import { ALICE, ALICE_PREFIX_42, BOB, fundingRecord, sellRecord, SHORT_KEY_ADDRESS } from '../fixtures.js';

import { IllegalTransition, TERMINAL_STATES } from '../../src/funding/state.js';
import { mergeAdvance } from '../../src/funding/merge.js';
import type { RailDeposit } from '../../src/rail.js';

const NOW = 1_700_000_000_200;

/** A sell row sitting in `transaction_seen`, waiting for the seller's on-chain transfer. */
const inFlight = () =>
  sellRecord({
    status: 'transaction_seen',
    provider_transaction_id: 'tx-1',
    status_history: [{ status: 'transaction_seen', at: 1_700_000_000_000 }],
    updated_at: 1_700_000_000_000,
  });

// Real, decodable SS58 addresses throughout: `mergeDeposit` now canonicalises whatever it is
// handed, so a placeholder string like `"1DepositAddress"` would be read as malformed rather than
// accepted, and every test below would be exercising the conflict path by accident.
const deposit = (overrides: Partial<RailDeposit> = {}): RailDeposit => ({
  address: ALICE,
  amount: '12.3456789012',
  currency: 'DOT_ASSETHUB',
  ...overrides,
});

describe('mergeAdvance: the deposit disclosure', () => {
  it('writes a fresh disclosure onto a row that does not move, and stamps when', () => {
    // The structural gap this step closes: a deposit address can arrive while a sell sits in
    // `transaction_seen`, unmoved. `to` equals the row's own current status.
    const next = mergeAdvance(inFlight(), 'transaction_seen', NOW, { deposit: deposit() });

    expect(next.deposit_address).toBe(ALICE);
    expect(next.deposit_amount).toBe('12.3456789012');
    expect(next.deposit_currency).toBe('DOT_ASSETHUB');
    expect(next.deposit_observed_at).toBe(NOW);
    expect(next.status).toBe('transaction_seen');
    expect(next.updated_at).toBe(NOW);
  });

  it('does not append a duplicate timeline entry for a fact-only advance', () => {
    const previous = inFlight();
    const next = mergeAdvance(previous, 'transaction_seen', NOW, { deposit: deposit() });

    // Same array, not a second "transaction_seen" beside the first: the row never left the state.
    expect(next.status_history).toEqual(previous.status_history);
    expect(next.status_history).toHaveLength(1);
  });

  it('still refuses a self-loop that carries no deposit fact, exactly as before', () => {
    // The bypass is scoped to "carries a deposit fact", deliberately. Any other attempt at a
    // self-loop is a caller mistake, not a fact update, and must still be refused loudly rather
    // than silently succeeding.
    expect(() => mergeAdvance(inFlight(), 'transaction_seen', NOW)).toThrow(IllegalTransition);
    expect(() => mergeAdvance(inFlight(), 'transaction_seen', NOW, { providerStatus: 'PENDING' })).toThrow(
      IllegalTransition,
    );
  });

  it.each(TERMINAL_STATES)('still refuses a self-loop on an already-%s row, even carrying a deposit fact', (status) => {
    // The layer that owns "a terminal row accepts no further transition" must own it regardless
    // of what rides along with the attempt. `store.update`'s own `SELECT ... FOR UPDATE` carries
    // no status filter (only `store.claim` does), so this guard, not the caller, is what stops a
    // `settled` row from silently having its deposit fields rewritten under a self-loop that
    // `deposit !== undefined` alone would otherwise have let through.
    const terminal = sellRecord({
      status,
      status_history: [{ status, at: 1_700_000_000_000 }],
      deposit_address: ALICE,
    });

    expect(() => mergeAdvance(terminal, status, NOW, { deposit: deposit() })).toThrow(IllegalTransition);
  });

  it('still carries a deposit disclosed the same moment a real move happens', () => {
    // The more common case in practice: Meld's deposit address lives on the transaction record, so
    // it can already be present the first time a transaction is seen at all.
    const opened = sellRecord({ status: 'session_opened' });
    const next = mergeAdvance(opened, 'transaction_seen', NOW, {
      providerTransactionId: 'tx-1',
      deposit: deposit(),
    });

    expect(next.status).toBe('transaction_seen');
    expect(next.status_history).toHaveLength(opened.status_history.length + 1);
    expect(next.deposit_address).toBe(ALICE);
  });

  it('fills in a field still missing, without touching one already set', () => {
    // The provider may disclose the address before the amount (unverified either way). A later
    // poll can complete what is missing.
    const withAddressOnly = mergeAdvance(inFlight(), 'transaction_seen', NOW, {
      deposit: { address: ALICE, currency: 'DOT_ASSETHUB' },
    });
    expect(withAddressOnly.deposit_amount).toBeUndefined();

    const filled = mergeAdvance(withAddressOnly, 'transaction_seen', NOW + 100, {
      deposit: deposit(),
    });
    expect(filled.deposit_address).toBe(ALICE);
    expect(filled.deposit_amount).toBe('12.3456789012');
    // The first sighting, not the second: observed_at does not move once set.
    expect(filled.deposit_observed_at).toBe(NOW);
  });

  it('ignores a repeat of the same address rather than treating it as new information', () => {
    const first = mergeAdvance(inFlight(), 'transaction_seen', NOW, { deposit: deposit() });
    const second = mergeAdvance(first, 'transaction_seen', NOW + 1000, { deposit: deposit() });

    expect(second.deposit_address).toBe(first.deposit_address);
    expect(second.deposit_observed_at).toBe(first.deposit_observed_at);
    expect(second.deposit_conflict_at).toBeUndefined();
  });

  it('treats the same account under a different SS58 prefix as the same address, not a conflict', () => {
    // `ALICE` and `ALICE_PREFIX_42` are the same 32-byte account, encoded under two different
    // prefixes. Comparing the raw strings would call the second one a conflict and freeze a sale
    // that never actually changed destination; comparing canonical forms does not.
    const first = mergeAdvance(inFlight(), 'transaction_seen', NOW, { deposit: deposit({ address: ALICE }) });

    const second = mergeAdvance(first, 'transaction_seen', NOW + 1000, {
      deposit: deposit({ address: ALICE_PREFIX_42 }),
    });

    expect(second.deposit_address).toBe(ALICE);
    expect(second.deposit_conflict_address).toBeUndefined();
    expect(second.deposit_conflict_reason).toBeUndefined();
  });

  describe('a conflicting disclosure', () => {
    it('is recorded rather than thrown, and the original address is kept', () => {
      // The fix over the first version of this function: a conflicting report must not roll back
      // the whole advance any more, because the seller was shown the *original* address and may
      // already have sent to it. That address is the one fact this function still guarantees.
      const first = mergeAdvance(inFlight(), 'transaction_seen', NOW, { deposit: deposit({ address: ALICE }) });

      const second = mergeAdvance(first, 'transaction_seen', NOW + 1000, {
        deposit: deposit({ address: BOB }),
      });

      expect(second.deposit_address).toBe(ALICE);
      expect(second.deposit_conflict_address).toBe(BOB);
      expect(second.deposit_conflict_reason).toBe('address_changed');
      expect(second.deposit_conflict_at).toBe(NOW + 1000);
    });

    it('does not block a genuine, unrelated state move riding alongside it', () => {
      // The heart of the fix: a provider that keeps disclosing a wrong address must not also be
      // able to freeze a row that would otherwise correctly settle or fail.
      const first = mergeAdvance(inFlight(), 'transaction_seen', NOW, { deposit: deposit({ address: ALICE }) });

      const settled = mergeAdvance(first, 'settled', NOW + 1000, { deposit: deposit({ address: BOB }) });

      expect(settled.status).toBe('settled');
      expect(settled.deposit_address).toBe(ALICE);
      expect(settled.deposit_conflict_address).toBe(BOB);
    });

    it('re-stamps `deposit_conflict_at` on every recurrence, not only the first', () => {
      const first = mergeAdvance(inFlight(), 'transaction_seen', NOW, { deposit: deposit({ address: ALICE }) });
      const second = mergeAdvance(first, 'transaction_seen', NOW + 1000, { deposit: deposit({ address: BOB }) });
      const third = mergeAdvance(second, 'transaction_seen', NOW + 2000, { deposit: deposit({ address: BOB }) });

      expect(second.deposit_conflict_at).toBe(NOW + 1000);
      expect(third.deposit_conflict_at).toBe(NOW + 2000);
    });

    it('records the raw reported value, not a canonicalised one', () => {
      // So a later, dumb string comparison (the worker's write-skip check) can recognise "the
      // same wrong answer as last time" without re-deriving a canonical form itself.
      const first = mergeAdvance(inFlight(), 'transaction_seen', NOW, { deposit: deposit({ address: ALICE }) });
      const second = mergeAdvance(first, 'transaction_seen', NOW + 1000, {
        deposit: deposit({ address: BOB }),
      });
      expect(second.deposit_conflict_address).toBe(BOB);
    });
  });

  describe('a disclosure that does not decode as an account at all', () => {
    it('is recorded as malformed rather than set as the address', () => {
      const next = mergeAdvance(inFlight(), 'transaction_seen', NOW, {
        deposit: deposit({ address: 'not-an-address-at-all' }),
      });

      expect(next.deposit_address).toBeUndefined();
      expect(next.deposit_conflict_address).toBe('not-an-address-at-all');
      expect(next.deposit_conflict_reason).toBe('address_malformed');
    });

    it('is recorded as malformed without touching an address already on file', () => {
      // A well-formed but too-short SS58 payload: it checksums cleanly and decodes, but is not
      // the 32-byte payload of a real account. Passing the checksum is not being an account (see
      // `address.ts`), so this must land in the same place a decode failure does.
      const first = mergeAdvance(inFlight(), 'transaction_seen', NOW, { deposit: deposit({ address: ALICE }) });

      const second = mergeAdvance(first, 'transaction_seen', NOW + 1000, {
        deposit: deposit({ address: SHORT_KEY_ADDRESS }),
      });

      expect(second.deposit_address).toBe(ALICE);
      expect(second.deposit_conflict_address).toBe(SHORT_KEY_ADDRESS);
      expect(second.deposit_conflict_reason).toBe('address_malformed');
    });

    it('never surfaces as a caller-facing INVALID_ADDRESS refusal', () => {
      // The value came back from a payment provider's API, not a person's form input, so a
      // decode failure here must not throw the `Refusal` `normalizeAddress` throws for a caller's
      // own bad address -- there is nobody on the other end of this call who typed it in.
      expect(() =>
        mergeAdvance(inFlight(), 'transaction_seen', NOW, { deposit: deposit({ address: '' }) }),
      ).not.toThrow();
    });
  });

  it('does not carry `deposit` on a buy record at all, by construction', () => {
    // Not exercised through `mergeAdvance` (nothing calls it with a deposit fact for a buy), but
    // pinned here so the shape is explicit: `UpdateExtra.deposit` is optional and a buy's finder
    // never produces one, so a buy's merge is byte-identical to before this step.
    const buy = fundingRecord({ status: 'transaction_seen', status_history: [{ status: 'transaction_seen', at: 1_700_000_000_000 }] });
    const next = mergeAdvance(buy, 'settled', NOW);
    expect(next.deposit_address).toBeUndefined();
  });
});
