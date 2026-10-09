import { describe, expect, it } from 'vitest';

import { parseBankInstructions, UnreadableBankDetails } from '../../src/meld/bank-instructions.js';

const IBAN = 'DE89370400440532013000';

const sepa = () => ({
  amount: '101.20',
  currency: 'EUR',
  receivingBankInformation: {
    iban: IBAN,
    bic: 'COBADEFFXXX',
    bankName: 'Commerzbank',
    accountHolderName: 'Banxa Holdings',
  },
  serviceProviderDetails: { memo: 'BX-7Q2K' },
});

const unreadable = (rail: string, details: unknown): UnreadableBankDetails => {
  try {
    parseBankInstructions(rail, details);
  } catch (error) {
    if (error instanceof UnreadableBankDetails) return error;
    throw error;
  }
  throw new Error('parsed');
};

describe('parseBankInstructions', () => {
  it('reads the virtual-account shape with the memo as the reference', () => {
    expect(parseBankInstructions('SEPA', sepa())).toEqual({
      rail: 'SEPA',
      amount: '101.20',
      currency: 'EUR',
      iban: IBAN,
      bic: 'COBADEFFXXX',
      bankName: 'Commerzbank',
      accountHolderName: 'Banxa Holdings',
      reference: 'BX-7Q2K',
    });
  });

  it('reads an ACH account and routing number', () => {
    expect(
      parseBankInstructions('ACH', {
        amount: '250',
        currency: 'USD',
        receivingBankInformation: { accountNumber: '000123456789', routingNumber: '026009593' },
      }),
    ).toEqual({
      rail: 'ACH',
      amount: '250',
      currency: 'USD',
      accountNumber: '000123456789',
      routingNumber: '026009593',
    });
  });

  it('reads the same names flat, with a reference and an expiry', () => {
    expect(
      parseBankInstructions('SEPA', {
        amount: '10.00',
        currency: 'EUR',
        iban: IBAN,
        accountHolderName: 'Banxa Holdings',
        reference: 'BX-7Q2K',
        expiresAt: '2026-10-09T12:00:00Z',
      }),
    ).toEqual({
      rail: 'SEPA',
      amount: '10.00',
      currency: 'EUR',
      iban: IBAN,
      accountHolderName: 'Banxa Holdings',
      reference: 'BX-7Q2K',
      expiresAt: Date.parse('2026-10-09T12:00:00Z'),
    });
  });

  it('reads a PIX key, a flat memo and an epoch expiry', () => {
    expect(
      parseBankInstructions('PIX', {
        amount: '500.5',
        currency: 'BRL',
        pixKey: 'pix@banxa.example',
        memo: 'BX-1',
        expiresAt: '1800000000000',
      }),
    ).toEqual({
      rail: 'PIX',
      amount: '500.5',
      currency: 'BRL',
      pixKey: 'pix@banxa.example',
      reference: 'BX-1',
      expiresAt: 1800000000000,
    });
  });

  it('accepts a field given both nested and flat when the two agree', () => {
    expect(parseBankInstructions('SEPA', { ...sepa(), iban: IBAN }).iban).toBe(IBAN);
  });

  it.each([
    ['null', null, 'not an object'],
    ['an array', [IBAN], 'not an object'],
    ['no amount', { ...sepa(), amount: undefined }, 'amount'],
    ['an exponent amount', { ...sepa(), amount: '1e3' }, 'amount'],
    ['a zero amount', { ...sepa(), amount: '0.00' }, 'amount'],
    ['a negative amount', { ...sepa(), amount: '-5' }, 'amount'],
    ['a lowercase currency', { ...sepa(), currency: 'eur' }, 'currency'],
    ['no account', { amount: '1', currency: 'EUR', bic: 'COBADEFFXXX' }, 'no iban'],
    ['two different IBANs', { ...sepa(), iban: 'GB33BUKB20201555555555' }, 'iban has conflicting'],
    ['a memo that is not text', { ...sepa(), serviceProviderDetails: { memo: true } }, 'reference is not text'],
    ['a blank account number', { amount: '1', currency: 'USD', accountNumber: '  ' }, 'accountNumber is not text'],
    [
      'bank information that is not an object',
      { ...sepa(), receivingBankInformation: IBAN },
      'receivingBankInformation is not an object',
    ],
    ['an expiry without an offset', { ...sepa(), expiresAt: '2026-10-09T12:00:00' }, 'expiresAt'],
  ])('refuses %s', (_label, details, reason) => {
    expect(unreadable('SEPA', details).message).toContain(reason);
  });

  it('refuses an empty rail', () => {
    expect(unreadable(' ', sepa()).message).toContain('no rail');
  });

  it('names the keys it was given and none of their values', () => {
    const other = 'GB33BUKB20201555555555';
    const error = unreadable('SEPA', {
      ...sepa(),
      receivingBankInformation: { iban: IBAN, bic: 'COBADEFFXXX' },
      iban: other,
    });

    expect(error.keys).toEqual([
      'amount',
      'currency',
      'receivingBankInformation',
      'receivingBankInformation.iban',
      'receivingBankInformation.bic',
      'serviceProviderDetails',
      'serviceProviderDetails.memo',
      'iban',
    ]);
    expect(error.message).toContain('receivingBankInformation.iban');
    for (const value of [IBAN, other, 'COBADEFFXXX', 'BX-7Q2K', '101.20', 'EUR']) {
      expect(error.message).not.toContain(value);
      expect(JSON.stringify(error)).not.toContain(value);
    }
  });

  it('says so when there are no keys at all', () => {
    expect(unreadable('SEPA', 'IBAN DE89').message).toContain('Keys: none.');
  });
});
