/**
 * Bank-transfer details from a headless order's `paymentMethodResponseDetails`.
 *
 * Meld does not document this shape for the onramp order. What is read is the virtual-account
 * shape Meld does document (`receivingBankInformation`, and `serviceProviderDetails.memo` as the
 * reference the payer must quote) and the same names at the top level. Anything else is refused:
 * a payer shown a guessed account sends real money to it.
 */

import { toEpochMillis } from './client.js';

export interface BankInstructions {
  /** The order's `paymentMethodType`, e.g. `SEPA`, `ACH`, `PIX`. */
  rail: string;
  /** Exact decimal text, as Meld sent it. */
  amount: string;
  currency: string;
  accountHolderName?: string;
  bankName?: string;
  iban?: string;
  bic?: string;
  accountNumber?: string;
  routingNumber?: string;
  pixKey?: string;
  /** Mandatory on the transfer when present. */
  reference?: string;
  /** Epoch ms. */
  expiresAt?: number;
}

/** Carries the key names Meld sent and never their values, which name a bank account. */
export class UnreadableBankDetails extends Error {
  constructor(
    readonly keys: readonly string[],
    reason: string,
  ) {
    const named = keys.length > 0 ? keys.join(', ') : 'none';
    super(`Meld bank details are unreadable (${reason}). Keys: ${named}.`);
    this.name = 'UnreadableBankDetails';
  }
}

type Fields = Readonly<Record<string, unknown>>;

const AMOUNT = /^\d{1,15}(\.\d{1,18})?$/;
const CURRENCY = /^[A-Z]{3}$/;
const ACCOUNT_FIELDS = [
  'accountHolderName',
  'bankName',
  'iban',
  'bic',
  'accountNumber',
  'routingNumber',
  'pixKey',
] as const;

export function parseBankInstructions(paymentMethodType: string, details: unknown): BankInstructions {
  const top = fields(details);
  const keys = keyNames(top);
  const fail = (reason: string) => new UnreadableBankDetails(keys, reason);
  if (top === undefined) throw fail('not an object');

  const nested = (name: string): Fields | undefined => {
    const value = top[name];
    if (value === undefined || value === null) return undefined;
    const object = fields(value);
    if (object === undefined) throw fail(`${name} is not an object`);
    return object;
  };
  const bank = nested('receivingBankInformation');
  const provider = nested('serviceProviderDetails');

  // Every candidate for a field must agree: two different accounts leave nothing to choose by.
  const text = (name: string, candidates: readonly (readonly [Fields | undefined, string])[]) => {
    let found: string | undefined;
    for (const [source, key] of candidates) {
      const value = source?.[key];
      if (value === undefined || value === null) continue;
      if (typeof value !== 'string' || value.trim() === '') throw fail(`${name} is not text`);
      if (found !== undefined && found !== value) throw fail(`${name} has conflicting values`);
      found = value;
    }
    return found;
  };

  const rail = paymentMethodType.trim();
  if (rail === '') throw fail('no rail');

  const amount = text('amount', [[top, 'amount']]);
  if (amount === undefined || !AMOUNT.test(amount) || !/[1-9]/.test(amount)) {
    throw fail('amount is not a positive decimal');
  }
  const currency = text('currency', [[top, 'currency']]);
  if (currency === undefined || !CURRENCY.test(currency)) throw fail('currency is not an ISO 4217 code');

  const account: Partial<Record<(typeof ACCOUNT_FIELDS)[number], string>> = {};
  for (const name of ACCOUNT_FIELDS) {
    const value = text(name, [
      [bank, name],
      [top, name],
    ]);
    if (value !== undefined) account[name] = value;
  }
  if (account.iban === undefined && account.accountNumber === undefined && account.pixKey === undefined) {
    throw fail('no iban, accountNumber or pixKey');
  }

  const reference = text('reference', [
    [provider, 'memo'],
    [top, 'memo'],
    [top, 'reference'],
  ]);

  const expiry = text('expiresAt', [[top, 'expiresAt']]);
  const expiresAt = expiry === undefined ? undefined : toEpochMillis(expiry);
  if (expiry !== undefined && expiresAt === undefined) throw fail('expiresAt is not a time');

  return {
    rail,
    amount,
    currency,
    ...account,
    ...(reference === undefined ? {} : { reference }),
    ...(expiresAt === undefined ? {} : { expiresAt }),
  };
}

function fields(value: unknown): Fields | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Fields) : undefined;
}

/** Top-level keys, and one level down as `parent.key`. */
function keyNames(top: Fields | undefined): string[] {
  if (top === undefined) return [];
  return Object.entries(top).flatMap(([key, value]) => {
    const inner = fields(value);
    return [key, ...(inner === undefined ? [] : Object.keys(inner).map((sub) => `${key}.${sub}`))];
  });
}
