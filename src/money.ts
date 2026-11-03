/**
 * Fiat amounts as integer minor units.
 *
 * Every comparison here decides whether a card gets charged, and `19.99` is not representable in
 * binary floating point, so a limit check wrong by one ulp is wrong at exactly the boundary an
 * operator chose. Amounts stay decimal strings and are compared as `bigint`.
 */

const MINOR_UNIT_DIGITS = 2;

/**
 * The shape `toMinorUnits` can convert, owned here rather than restated by each caller.
 *
 * Widen the request side alone and a buyer's amount is silently truncated where a card is charged;
 * widen the config side alone and `BigInt()` throws a raw `SyntaxError` out of `parseConfig`, past
 * the error aggregation.
 */
export const MINOR_UNIT_DECIMAL = /^\d{1,9}(\.\d{1,2})?$/;

/**
 * Convert a decimal string that has already matched `MINOR_UNIT_DECIMAL`. `whole`'s default is
 * unreachable but required, since the destructured type is `string | undefined`.
 */
export function toMinorUnits(decimal: string): bigint {
  const [whole = '0', fraction = ''] = decimal.split('.');
  return BigInt(whole + fraction.padEnd(MINOR_UNIT_DIGITS, '0'));
}

const DECIMAL = /^(\d+)(?:\.(\d+))?$/;

/** Exact comparison of two non-negative decimal strings, -1 | 0 | 1. Unparseable text sorts as 0. */
export function compareDecimal(a: string, b: string): -1 | 0 | 1 {
  const [pa, pb] = [DECIMAL.exec(a), DECIMAL.exec(b)];
  const scale = Math.max(pa?.[2]?.length ?? 0, pb?.[2]?.length ?? 0);
  const big = (m: RegExpExecArray | null): bigint => BigInt((m?.[1] ?? '0') + (m?.[2] ?? '').padEnd(scale, '0'));
  const [x, y] = [big(pa), big(pb)];
  return x < y ? -1 : x > y ? 1 : 0;
}

/** An amount range as exact decimal text. */
export interface Bound {
  min: string;
  max: string;
}

/** The smallest `min` and the largest `max` across `bounds`. A tie keeps the first text. */
export function widestBound(bounds: readonly [Bound, ...Bound[]]): Bound {
  const [first, ...rest] = bounds;
  let { min, max } = first;
  for (const bound of rest) {
    if (compareDecimal(bound.min, min) < 0) min = bound.min;
    if (compareDecimal(bound.max, max) > 0) max = bound.max;
  }
  return { min, max };
}

/** Whether `text` is a non-negative plain decimal. */
export const isDecimal = (text: string): boolean => DECIMAL.test(text);

/** Twice `decimal`, exactly and at its own scale. `decimal` must satisfy `isDecimal`. */
export function doubleDecimal(decimal: string): string {
  const [whole = '0', fraction = ''] = decimal.split('.');
  const digits = (BigInt(whole + fraction) * 2n).toString().padStart(fraction.length + 1, '0');
  return fraction === '' ? digits : `${digits.slice(0, -fraction.length)}.${digits.slice(-fraction.length)}`;
}
