import { describe, expect, it } from 'vitest';

import { toBaseUnits, toMinorUnits } from '../src/money.js';

describe('toMinorUnits', () => {
  it.each([
    ['0.01', 1n],
    ['1', 100n],
    ['1.5', 150n],
    ['10.00', 1000n],
    ['2000', 200_000n],
    ['999999999.99', 99_999_999_999n],
  ])('%s -> %s minor units', (decimal, expected) => {
    expect(toMinorUnits(decimal)).toBe(expected);
  });

  it('compares exactly at a boundary a float would blur', () => {
    // 19.99 is not representable in binary floating point, and a limit set to it is a
    // limit an operator chose deliberately. Equality has to hold.
    // Against literals, not against itself: `expect(f(x)).toBe(f(x))` is satisfied by `() => 0n`.
    expect(toMinorUnits('19.99')).toBe(1999n);
    expect(toMinorUnits('20.00')).toBe(2000n);
    expect(toMinorUnits('19.99') < toMinorUnits('20.00')).toBe(true);
    expect(toMinorUnits('0.10') + toMinorUnits('0.20')).toBe(30n);
  });
});

describe('toBaseUnits', () => {
  it('scales a decimal to integer base units', () => {
    expect(toBaseUnits('0.5', 6)).toBe(500_000n);
    expect(toBaseUnits('5', 6)).toBe(5_000_000n);
    expect(toBaseUnits('0.002', 18)).toBe(2_000_000_000_000_000n);
  });
});
