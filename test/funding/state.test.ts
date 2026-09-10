import { describe, expect, it } from 'vitest';

import {
  FUNDING_STATES,
  IllegalTransition,
  TERMINAL_STATES,
  transition,
  type FundingState,
} from '../../src/funding/state.js';

describe('the funding state machine', () => {
  it('recognises the terminal states the worker can stop caring about', () => {
    for (const state of ['settled', 'failed', 'expired', 'refused'] as const) {
      expect(TERMINAL_STATES).toContain(state);
    }
  });

  it('treats every in-flight state as non-terminal', () => {
    for (const state of ['created', 'session_opened', 'transaction_seen'] as const) {
      expect(TERMINAL_STATES).not.toContain(state);
    }
  });

  it('allows the lifecycle moves the worker relies on', () => {
    expect(transition('created', 'session_opened')).toBe('session_opened');
    expect(transition('created', 'refused')).toBe('refused');
    // `unobserved`, and deliberately not `expired`. A reservation is written before the rail is
    // called, so an aged-out `created` row may already have an open settlement surface; nothing
    // was ever asked about it, and `expired` is a claim that the buyer did not pay.
    expect(transition('created', 'unobserved')).toBe('unobserved');
    expect(transition('session_opened', 'transaction_seen')).toBe('transaction_seen');
    expect(transition('session_opened', 'expired')).toBe('expired');
    // A concluded request requires the Meld status mapper, which the worker supplies.
    expect(transition('transaction_seen', 'settled')).toBe('settled');
    expect(transition('transaction_seen', 'failed')).toBe('failed');
  });

  describe('refuses moves that do not exist', () => {
    /**
     * The legal set, restated here on purpose.
     *
     * The illegal cases are then generated as its complement over `FUNDING_STATES x
     * FUNDING_STATES`: all of them, rather than four hand-picked ones out of forty-nine. Two that
     * were missing mattered: `transaction_seen -> expired` is the machine's backstop against
     * calling a seen payment unpaid, and `created -> expired` is the one the machine now
     * refuses outright. A reservation nobody asked about cannot be declared unpaid, so the
     * worker's ageing produces `unobserved` instead.
     *
     * Restating rather than importing `TRANSITIONS` is the point: this is a second, independent
     * statement of the rule, so a change to the machine has to be made deliberately in two places
     * instead of silently widening what the test permits. Adding a state fails here until it is
     * accounted for.
     */
    const LEGAL: Readonly<Record<FundingState, readonly FundingState[]>> = {
      created: ['session_opened', 'refused', 'unobserved'],
      session_opened: ['transaction_seen', 'expired', 'unobserved'],
      transaction_seen: ['settled', 'failed', 'unobserved'],
      settled: [],
      failed: [],
      expired: [],
      refused: [],
      unobserved: [],
    };

    const illegal = FUNDING_STATES.flatMap((from) =>
      FUNDING_STATES.filter((to) => !LEGAL[from].includes(to)).map((to) => [from, to] as const),
    );

    it('covers every state, so a new one cannot be added unnoticed', () => {
      expect(Object.keys(LEGAL).sort()).toEqual([...FUNDING_STATES].sort());
      // 8 states squared, minus the nine legal moves.
      expect(illegal).toHaveLength(FUNDING_STATES.length * FUNDING_STATES.length - 9);
    });

    it.each(illegal)('refuses %s -> %s', (from, to) => {
      expect(() => transition(from, to)).toThrow(IllegalTransition);
    });

    it.each(FUNDING_STATES.flatMap((from) => LEGAL[from].map((to) => [from, to] as const)))(
      'allows %s -> %s',
      (from, to) => {
        expect(transition(from, to)).toBe(to);
      },
    );
  });

  it('names the refused move in the error, for the log line', () => {
    const error = (() => {
      try {
        transition('settled', 'session_opened');
      } catch (e) {
        return e as IllegalTransition;
      }
      throw new Error('expected a throw');
    })();
    expect(error.from).toBe('settled');
    expect(error.to).toBe('session_opened');
    expect(error.message).toContain('illegal funding transition');
  });
});