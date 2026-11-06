import { describe, expect, it } from 'vitest';

import { compareDecimal, doubleDecimal, isDecimal, toMinorUnits, widestBound } from '../src/money.js';

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

describe('compareDecimal', () => {
  it.each([
    ['1', '2', -1],
    ['2.50', '2.5', 0],
    ['9007199254740993', '9007199254740992.5', 1],
    ['0.30000000000000004', '0.3', 1],
  ] as const)('%s vs %s -> %s', (a, b, expected) => {
    expect(compareDecimal(a, b)).toBe(expected);
  });
});

describe('widestBound', () => {
  it('spans the smallest min and the largest max', () => {
    expect(
      widestBound([
        { min: '5', max: '3000' },
        { min: '10', max: '16000' },
        { min: '2', max: '9' },
      ]),
    ).toEqual({ min: '2', max: '16000' });
  });

  it('keeps the first text on a tie', () => {
    expect(widestBound([{ min: '1.0', max: '9.0' }, { min: '1.00', max: '9' }])).toEqual({ min: '1.0', max: '9.0' });
  });
});

describe('isDecimal', () => {
  it.each([
    ['5', true],
    ['20.50', true],
    ['1e3', false],
    ['-1', false],
    ['', false],
  ])('%s -> %s', (text, expected) => {
    expect(isDecimal(text)).toBe(expected);
  });
});

describe('doubleDecimal', () => {
  it.each([
    ['5', '10'],
    ['20.50', '41.00'],
    ['0.05', '0.10'],
    ['0.5', '1.0'],
    ['9007199254740993', '18014398509481986'],
  ])('%s -> %s', (decimal, expected) => {
    expect(doubleDecimal(decimal)).toBe(expected);
  });
});
