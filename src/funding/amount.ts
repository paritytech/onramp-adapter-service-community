/**
 * Comparing a crypto amount as the provider spells it with the one on file.
 *
 * Shared by `mergeDeposit`, which freezes a disclosed amount, and `depositIsNew` in the worker,
 * which skips a poll that repeats what is on file, so the two cannot disagree on what "the same
 * amount" is.
 */

import { CRYPTO_DECIMAL } from '../contract.js';

/**
 * Whether a reported amount names the one already on file, compared exactly and never as a float.
 *
 * Two exact decimals (`CRYPTO_DECIMAL`) are compared by value, so `23.4521`, `23.45210000` and
 * `023.4521` are one amount: Meld need not spell one amount the same way on every poll. Anything
 * else, an exponent or a sign say, is compared as exact text, since reading it as a number would be
 * a guess. A different value is a change of terms, which `mergeDeposit` records as a conflict.
 */
export function sameAmount(stored: string | undefined, reported: string): boolean {
  // An address on file with no amount is a row no rail writes (the column is nullable, the
  // disclosure is not): it never matches.
  if (stored === undefined) return false;
  if (!CRYPTO_DECIMAL.test(stored) || !CRYPTO_DECIMAL.test(reported)) return stored === reported;
  return plainSpelling(stored) === plainSpelling(reported);
}

/** An exact decimal without the zeros that do not change its value: `023.45210000` is `23.4521`. */
function plainSpelling(decimal: string): string {
  const [whole = '0', fraction = ''] = decimal.split('.');
  const significant = fraction.replace(/0+$/, '');
  return whole.replace(/^0+(?=\d)/, '') + (significant === '' ? '' : `.${significant}`);
}
