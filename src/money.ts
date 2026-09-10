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
