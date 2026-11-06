import { setTimeout as sleep } from 'node:timers/promises';

import { describe, expect, it } from 'vitest';

import { serial, stopWithin } from '../src/background.js';

describe('serial', () => {
  it('runs passes one at a time, in call order, past a failed one', async () => {
    const exclusive = serial();
    const order: string[] = [];
    const pass = (name: string, ms: number) => async () => {
      order.push(`${name} start`);
      await sleep(ms);
      order.push(`${name} end`);
    };
    const first = exclusive(pass('a', 5));
    const failing = exclusive(async () => {
      order.push('failing');
      throw new Error('boom');
    });
    const last = exclusive(pass('b', 0));
    await Promise.all([first, failing.catch(() => undefined), last]);
    expect(order).toEqual(['a start', 'a end', 'failing', 'b start', 'b end']);
    await expect(failing).rejects.toThrow('boom');
  });
});

describe('stopWithin', () => {
  it('aborts, then waits for the work to settle', async () => {
    const controller = new AbortController();
    let settled = false;
    const work = sleep(5).then(() => {
      settled = true;
    });
    await stopWithin(controller, () => work, 1_000);
    expect(controller.signal.aborted).toBe(true);
    expect(settled).toBe(true);
  });

  it('gives up on work that outlasts the grace period', async () => {
    const started = Date.now();
    await stopWithin(new AbortController(), () => new Promise(() => undefined), 10);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
