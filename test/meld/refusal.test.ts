import { describe, expect, it } from 'vitest';

import { Refusal } from '../../src/contract.js';
import { MeldHttpError } from '../../src/meld/client.js';
import { meld400 } from '../../src/meld/refusal.js';

const refusalOf = (detail: string, code?: string): Refusal => meld400(new MeldHttpError(400, code, detail));

describe('the threshold a Meld limit message names', () => {
  it('is carried when it is a fiat amount', () => {
    expect(refusalOf('Amount is below the minimum allowed, which is 18.00 EUR').failure).toEqual({
      tag: 'BelowMinimum',
      value: { amount: '18.00', currency: 'EUR' },
    });
  });

  it('is dropped when the "currency" is a crypto this service knows, now that DOT is three letters', () => {
    // Meld's code for DOT was DOT_ASSETHUB, which the three-letter group could not match. Under
    // `DOT` it can, and a crypto amount on the wire would read as a fiat minimum.
    expect(refusalOf('Amount is below the minimum allowed, which is 2 DOT').failure).toEqual({ tag: 'BelowMinimum' });
    expect(refusalOf('Amount is above the maximum allowed, which is 500 dot', 'INVALID_AMOUNT_TOO_HIGH').failure).toEqual({
      tag: 'AboveMaximum',
    });
  });
});

describe('an amount a provider turned down without naming a bound', () => {
  it('is its own code, so the buyer is asked for a different amount', () => {
    expect(refusalOf('Invalid currency amount', 'INVALID_AMOUNT').failure).toEqual({
      tag: 'Other',
      value: { code: 'AMOUNT_REJECTED', message: 'The provider cannot take this amount.' },
    });
  });

  it('keeps the bound when its message still names one', () => {
    expect(
      refusalOf('Amount is below the minimum allowed, which is 18.00 EUR', 'INVALID_AMOUNT').failure,
    ).toEqual({ tag: 'BelowMinimum', value: { amount: '18.00', currency: 'EUR' } });
  });

  it('leaves a combination the provider declines as the generic refusal', () => {
    expect(refusalOf('Incompatible request: Body does not match service providers', 'INCOMPATIBLE_REQUEST').failure).toEqual({
      tag: 'Other',
      value: { code: 'PROVIDER_REJECTED', message: 'The provider declined this request.' },
    });
  });
});
