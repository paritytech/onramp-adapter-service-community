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
  return toBaseUnits(decimal, MINOR_UNIT_DIGITS);
}

/** A decimal string as integer base units, for a value its schema already bounded to `decimals`. */
export function toBaseUnits(value: string, decimals: number): bigint {
  const [whole = '0', fraction = ''] = value.split('.');
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0');
}

/** Circle USDC's decimals, which every USDC amount is written in and the token must report. */
export const USDC_DECIMALS = 6;

/** A USDC amount `toBaseUnits` converts at `USDC_DECIMALS`. */
export const USDC_AMOUNT = new RegExp(`^\\d{1,12}(\\.\\d{1,${String(USDC_DECIMALS)}})?$`);

/** Ether's decimals, the wei a native balance is read in. */
export const ETH_DECIMALS = 18;

/** An ETH amount `toBaseUnits` converts at `ETH_DECIMALS`. */
export const ETH_AMOUNT = new RegExp(`^\\d{1,6}(\\.\\d{1,${String(ETH_DECIMALS)}})?$`);
