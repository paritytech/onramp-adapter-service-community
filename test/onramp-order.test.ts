import { describe, expect, it, vi } from 'vitest';

import type { AuditEvent } from '../src/audit.js';
import type { Config } from '../src/config.js';
import { Refusal, type FundingFailure } from '../src/contract.js';
import type { FundingRecord } from '../src/funding/types.js';
import { MeldHttpError, type HeadlessOrderResult } from '../src/meld/client.js';
import { Onramp, type HeadlessOrderPort } from '../src/onramp.js';
import type { FundingRail, MeldTransactionReader, RailQuote, RailSession, RailTransaction } from '../src/rail.js';
import {
  ALICE,
  ALICE_PREFIX_42,
  KEY_HASH,
  bankInstructions,
  config,
  createRequest,
  customerRow,
  fakeStore,
  headlessConfig,
  orderRequest,
} from './fixtures.js';

const SUBJECT = { productId: 'app.dot', alias: 'alias-abc', proven: true };
const REQUEST_ID = 'req-1';
const NOW = 1_700_000_000_000;
const CLIENT_IP = '203.0.113.24';
/** A minute before `NOW`, as the app would send it. */
const ACCEPTED = new Date(NOW - 60_000).toISOString();

/** Headless on, with a EUR corridor beside the base USD one for bank orders. */
const headless = (overrides: Record<string, unknown> = {}): Config =>
  config({
    ...headlessConfig(),
    limits: [
      { code: 'USDC_ASSETHUB', min: '10.00', max: '2000.00', currency: 'USD' },
      { code: 'USDC_ASSETHUB', min: '10.00', max: '2000.00', currency: 'EUR' },
    ],
    ...overrides,
  });

/** Meld's card order: numbers as numbers, and a credential scoped to the order. */
const CARD_RAW = {
  id: 'order-1',
  customerId: 'meld-customer-1',
  paymentMethodType: 'CREDIT_DEBIT_CARD',
  paymentMethodResponseDetails: { renderMode: 'SDK_NATIVE', sessionToken: 'tok_order_scoped_secret' },
  payload: { sourceAmount: 25.5 },
};

const cardOrder = (): HeadlessOrderResult => ({
  outcome: 'created',
  order: {
    id: 'order-1',
    paymentMethodType: 'CREDIT_DEBIT_CARD',
    paymentMethodResponseDetails: CARD_RAW.paymentMethodResponseDetails,
    raw: structuredClone(CARD_RAW),
  },
});

/** Meld's SEPA details in the documented virtual-account shape. */
const SEPA_DETAILS = {
  amount: '101.20',
  currency: 'EUR',
  expiresAt: '2023-11-14T22:28:20Z',
  receivingBankInformation: {
    iban: 'DE89370400440532013000',
    bic: 'COBADEFFXXX',
    accountHolderName: 'Meld Virtual Account',
  },
  serviceProviderDetails: { memo: 'MELD-REF-1' },
};

const bankOrder = (details: unknown = SEPA_DETAILS): HeadlessOrderResult => ({
  outcome: 'created',
  order: { id: 'order-2', paymentMethodType: 'SEPA', paymentMethodResponseDetails: details, raw: { id: 'order-2' } },
});

const bankRequest = (overrides: Record<string, unknown> = {}) =>
  orderRequest({
    idempotencyKey: 'idem-order-bank-1',
    country: 'DE',
    fiat: 'EUR',
    sourceAmount: '101.20',
    paymentMethodType: 'SEPA',
    termsAcceptedAt: ACCEPTED,
    ...overrides,
  });

class FakeRail implements FundingRail, MeldTransactionReader {
  readonly provider = 'meld' as const;
  quotes: RailQuote[] = [];

  async quote(input: RailQuote): Promise<unknown[]> {
    this.quotes.push(input);
    return [];
  }

  async createSession(): Promise<RailSession> {
    return { providerSessionId: 'meld-1', settlementUrl: 'https://meldcrypto.com/session/meld-1', hostedWidgetUrl: undefined, expiresAt: undefined };
  }

  async transaction(id: string): Promise<RailTransaction> {
    return { id };
  }
}

const build = (cfg: Config = headless(), place: () => Promise<HeadlessOrderResult> = async () => cardOrder()) => {
  const audit: AuditEvent[] = [];
  const store = fakeStore();
  store.customers.set(`app.dot|${KEY_HASH}`, customerRow());
  const orders = { createHeadlessOrder: vi.fn<HeadlessOrderPort['createHeadlessOrder']>(place) };
  const rail = new FakeRail();
  const clock = { now: NOW };
  let n = 0;
  const service = new Onramp(
    cfg,
    { meld: rail },
    { info: (event) => audit.push(event) },
    store,
    rail,
    () => clock.now,
    () => `funding-${String((n += 1))}`,
    undefined,
    orders,
  );
  const order = (overrides: Record<string, unknown> = {}) =>
    service.createOrder(SUBJECT, KEY_HASH, orderRequest({ termsAcceptedAt: ACCEPTED, ...overrides }), REQUEST_ID, CLIENT_IP);
  return { service, store, orders, rail, audit, clock, order };
};

const refusalOf = async (fn: () => Promise<unknown>): Promise<Refusal> => {
  try {
    await fn();
  } catch (error) {
    if (error instanceof Refusal) return error;
    throw error;
  }
  throw new Error('expected a Refusal');
};

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('expected a value');
  return value;
}

const codeOf = (failure: FundingFailure) => (failure.tag === 'Other' ? failure.value.code : failure.tag);

describe('Onramp.createOrder, card', () => {
  it('answers with Meld order verbatim and stores only its id', async () => {
    const { store, orders, audit, order } = build();

    const answer = await order();

    expect(answer).toEqual({ fundingRequestId: 'funding-1', kind: 'card', order: CARD_RAW });
    const row = store.rows.get('funding-1');
    expect(row).toMatchObject({
      status: 'session_opened',
      integration_mode: 'headless',
      meld_order_id: 'order-1',
      customer_key_hash: KEY_HASH,
      terms_accepted_at: NOW - 60_000,
      client_reference: 'idem-order-0001',
      wallet_address: ALICE,
      service_provider: 'BANXA',
    });
    expect(row?.payment_instructions).toBeUndefined();
    expect(JSON.stringify(row)).not.toContain('tok_order_scoped_secret');
    expect(orders.createHeadlessOrder).toHaveBeenCalledTimes(1);
    expect(audit).toEqual([
      {
        event: 'order.created',
        alias: 'alias-abc',
        productId: 'app.dot',
        requestId: REQUEST_ID,
        rail: 'meld',
        integrationMode: 'headless',
        destinationCurrencyCode: 'USDC_ASSETHUB',
        walletAddress: ALICE,
        sourceAmount: '25.00',
        fiat: 'USD',
        country: 'US',
        kind: 'card',
        meldOrderId: 'order-1',
      },
    ]);
  });

  it('places the order for the stored customer, under the funding id, with the buyer IP and the terms time', async () => {
    const { orders, order } = build();

    await order({ walletAddress: ALICE_PREFIX_42, fiat: 'usd' });

    expect(orders.createHeadlessOrder).toHaveBeenCalledWith(
      {
        customerId: 'meld-customer-1',
        externalOrderId: 'funding-1',
        serviceProvider: 'BANXA',
        paymentMethodType: 'CREDIT_DEBIT_CARD',
        countryCode: 'US',
        sourceAmount: '25.00',
        sourceCurrencyCode: 'USD',
        destinationCurrencyCode: 'USDC_ASSETHUB',
        destinationWalletAddress: ALICE,
        destinationNetworkCode: 'polkadot',
        clientIpAddress: CLIENT_IP,
        verification: { agreementAcceptedAt: ACCEPTED },
      },
      'funding-1',
    );
  });

  it('keeps the buyer IP out of every audit line', async () => {
    const { audit, order } = build();

    await order();

    expect(JSON.stringify(audit)).not.toContain(CLIENT_IP);
  });
});

describe('Onramp.createOrder, bank', () => {
  it('answers with the parsed transfer details as exact decimal text, and stores them', async () => {
    const { service, store, audit } = build(headless(), async () => bankOrder());

    const answer = await service.createOrder(SUBJECT, KEY_HASH, bankRequest(), REQUEST_ID, CLIENT_IP);

    const instructions = bankInstructions({ expiresAt: Date.parse('2023-11-14T22:28:20Z') });
    expect(answer).toEqual({ fundingRequestId: 'funding-1', kind: 'bank', instructions });
    expect(store.rows.get('funding-1')).toMatchObject({
      status: 'session_opened',
      meld_order_id: 'order-2',
      payment_instructions: instructions,
    });
    expect(audit.map((e) => [e.event, 'kind' in e ? e.kind : undefined])).toEqual([['order.created', 'bank']]);
  });

  it('refuses details it cannot read with 502, naming only the keys, and keeps the order id', async () => {
    const details = { receivingBankInformation: { iban: 'DE89370400440532013000' }, total: '101.20' };
    const { service, store, audit } = build(headless(), async () => bankOrder(details));

    const refusal = await refusalOf(() => service.createOrder(SUBJECT, KEY_HASH, bankRequest(), REQUEST_ID, CLIENT_IP));

    expect(refusal.status).toBe(502);
    expect(codeOf(refusal.failure)).toBe('BANK_DETAILS_UNREADABLE');
    expect(refusal.message).toContain('receivingBankInformation.iban');
    expect(refusal.message).not.toContain('DE89370400440532013000');
    expect(store.rows.get('funding-1')).toMatchObject({
      status: 'refused',
      reason: 'Other',
      client_reference: undefined,
      meld_order_id: 'order-2',
      payment_instructions: undefined,
    });
    expect(audit).toMatchObject([{ event: 'order.rail_refused', reason: 'Other', meldOrderId: 'order-2' }]);
  });
});

describe('Onramp.createOrder, local checks', () => {
  it('refuses a network code other than the configured one, before Meld', async () => {
    const { store, orders, audit, order } = build();

    const refusal = await refusalOf(() => order({ destinationNetworkCode: 'ethereum' }));

    expect(refusal.failure).toEqual({ tag: 'WrongAssetOrChain' });
    expect(orders.createHeadlessOrder).not.toHaveBeenCalled();
    const [row] = [...store.rows.values()];
    expect(row).toMatchObject({
      status: 'refused',
      reason: 'WrongAssetOrChain',
      integration_mode: 'headless',
      customer_key_hash: KEY_HASH,
      client_reference: undefined,
    });
    expect(audit).toMatchObject([{ event: 'order.refused', integrationMode: 'headless', reason: 'WrongAssetOrChain' }]);
  });

  it('applies the session validation: the address and the amount bounds', async () => {
    const { orders, order } = build();

    expect(codeOf((await refusalOf(() => order({ walletAddress: 'not-an-address' }))).failure)).toBe('INVALID_ADDRESS');
    expect((await refusalOf(() => order({ sourceAmount: '5000.00' }))).failure.tag).toBe('AboveMaximum');
    expect((await refusalOf(() => order({ destinationCurrencyCode: 'NOT_REAL' }))).failure.tag).toBe('WrongAssetOrChain');
    expect(orders.createHeadlessOrder).not.toHaveBeenCalled();
  });

  it.each([
    ['older than an hour', new Date(NOW - 3_600_001).toISOString()],
    ['in the future', new Date(NOW + 300_001).toISOString()],
    ['without an offset', '2023-11-14T22:12:20'],
    ['not a time', 'yesterday'],
  ])('refuses terms accepted %s as TERMS_STALE', async (_why, termsAcceptedAt) => {
    const { orders, order } = build();

    const refusal = await refusalOf(() => order({ termsAcceptedAt }));

    expect(refusal.status).toBe(400);
    expect(codeOf(refusal.failure)).toBe('TERMS_STALE');
    expect(orders.createHeadlessOrder).not.toHaveBeenCalled();
  });

  it('reads an acceptance slightly ahead of this clock as now, so Meld is never sent a future time', async () => {
    const { store, orders, order } = build();

    await order({ termsAcceptedAt: new Date(NOW + 120_000).toISOString() });

    expect(orders.createHeadlessOrder.mock.calls[0]?.[0].verification).toEqual({
      agreementAcceptedAt: new Date(NOW).toISOString(),
    });
    expect(store.rows.get('funding-1')?.terms_accepted_at).toBe(NOW);
  });

  it('refuses a key with no stored customer, reserving nothing', async () => {
    const { store, orders, order } = build();
    store.customers.clear();

    const refusal = await refusalOf(() => order());

    expect(refusal.status).toBe(404);
    expect(codeOf(refusal.failure)).toBe('CUSTOMER_NOT_FOUND');
    expect(store.rows.size).toBe(0);
    expect(orders.createHeadlessOrder).not.toHaveBeenCalled();
  });

  it('honours the operator switch', async () => {
    const { orders, audit, order } = build(headless({ session_creation_enabled: false }));

    expect((await refusalOf(() => order())).failure).toEqual({ tag: 'RouteWithdrawn' });
    expect(orders.createHeadlessOrder).not.toHaveBeenCalled();
    expect(audit.map((e) => e.event)).toEqual(['order.refused']);
  });

  it('refuses to run on a deployment without Meld Headless', async () => {
    const { order } = build(config());

    await expect(order()).rejects.toThrow(/without Meld Headless/);
  });
});

describe('Onramp.createOrder, Meld refusals', () => {
  it('answers a customer the provider will not take yet with 403 and frees the key', async () => {
    let first = true;
    const { store, orders, audit, order } = build(headless(), async () => {
      if (!first) return cardOrder();
      first = false;
      return { outcome: 'customer_not_ready', code: 'KYC_NOT_COMPLETED' };
    });

    const refusal = await refusalOf(() => order());

    expect(refusal.status).toBe(403);
    expect(codeOf(refusal.failure)).toBe('CUSTOMER_NOT_READY');
    expect(store.rows.get('funding-1')).toMatchObject({ status: 'refused', reason: 'Other', client_reference: undefined });
    expect(audit).toMatchObject([{ event: 'order.rail_refused', reason: 'Other' }]);
    // The key was released, so the retry once the customer is ready places a fresh order.
    expect((await order()).fundingRequestId).toBe('funding-2');
    expect(orders.createHeadlessOrder).toHaveBeenCalledTimes(2);
  });

  it('frees the key on a Meld 400 and keeps it on a failure that may have created the order', async () => {
    const rejected = build(headless(), () => Promise.reject(new MeldHttpError(400, 'INVALID_AMOUNT', 'no')));
    await expect(rejected.order()).rejects.toBeInstanceOf(MeldHttpError);
    expect(rejected.store.rows.get('funding-1')).toMatchObject({ status: 'refused', client_reference: undefined });

    const unknown = build(headless(), () => Promise.reject(new MeldHttpError(500, 'SERVICE_PROVIDER_ERROR', 'no')));
    await expect(unknown.order()).rejects.toBeInstanceOf(MeldHttpError);
    expect(unknown.store.rows.get('funding-1')).toMatchObject({ status: 'unobserved', client_reference: 'idem-order-0001' });
    expect(unknown.audit).toMatchObject([{ event: 'order.rail_refused', reason: 'ProviderTimeout' }]);
  });

  it.each([
    [403, 'WHITELABEL_NOT_ENABLED'],
    [403, 'SERVICE_PROVIDER_NOT_ENABLED'],
    [422, 'COINBASE_ORDER_REJECTED'],
  ])('answers a Meld %i %s, which created no order, as a definitive refusal that frees the key', async (status, code) => {
    let first = true;
    const { store, orders, audit, order } = build(headless(), () => {
      if (!first) return Promise.resolve(cardOrder());
      first = false;
      // The message would map to something else if it were read; only the code may decide.
      return Promise.reject(new MeldHttpError(status, code, 'below the minimum, which is 99.00 USD'));
    });

    const refusal = await refusalOf(() => order());

    expect(refusal.status).toBe(422);
    expect(refusal.failure).toEqual({
      tag: 'Other',
      value: { code: 'PROVIDER_REJECTED', message: 'The provider declined this request.' },
    });
    expect(refusal.message).not.toContain('minimum');
    expect(store.rows.get('funding-1')).toMatchObject({ status: 'refused', reason: 'Other', client_reference: undefined });
    expect(audit).toMatchObject([{ event: 'order.rail_refused', reason: 'Other' }]);
    expect((await order()).fundingRequestId).toBe('funding-2');
    expect(orders.createHeadlessOrder).toHaveBeenCalledTimes(2);
  });

  it.each([
    [403, 'KYC_TOKEN_EXPIRED'],
    [422, 'TRANSACTION_FAILED_GETTING_CRYPTO_QUOTE_FROM_PROVIDER'],
    [403, undefined],
    [500, 'COINBASE_ORDER_REJECTED'],
  ])('keeps the key on a Meld %i %s it cannot rule an order out for', async (status, code) => {
    const { store, audit, order } = build(headless(), () => Promise.reject(new MeldHttpError(status, code, 'no')));

    await expect(order()).rejects.toBeInstanceOf(MeldHttpError);
    expect(store.rows.get('funding-1')).toMatchObject({ status: 'unobserved', client_reference: 'idem-order-0001' });
    expect(audit).toMatchObject([{ event: 'order.rail_refused', reason: 'ProviderTimeout' }]);
  });

  it('leaves a widget session refused with the same code as it was', async () => {
    const { service, store, rail } = build();
    vi.spyOn(rail, 'createSession').mockRejectedValue(new MeldHttpError(403, 'WHITELABEL_NOT_ENABLED', 'no'));

    await expect(service.createSession(SUBJECT, createRequest(), REQUEST_ID)).rejects.toBeInstanceOf(MeldHttpError);
    expect(store.rows.get('funding-1')).toMatchObject({ status: 'unobserved', client_reference: 'idem-0000-0001' });
  });

  it('audits an orphan when the reservation cannot be closed', async () => {
    const { store, audit, order } = build(headless(), async () => ({ outcome: 'customer_not_ready', code: 'VERIFICATION_REQUIRED' }));
    vi.spyOn(store, 'update').mockRejectedValue(new Error('connection lost'));

    expect(codeOf((await refusalOf(() => order())).failure)).toBe('CUSTOMER_NOT_READY');
    expect(audit.map((e) => [e.event, e.reason])).toEqual([
      ['order.orphaned', 'reservation_close_failed'],
      ['order.rail_refused', 'Other'],
    ]);
  });

  it('audits an orphan naming the Meld order when the opened order cannot be recorded', async () => {
    const { store, audit, order } = build();
    vi.spyOn(store, 'update').mockRejectedValue(new Error('connection lost'));

    await expect(order()).rejects.toThrow('connection lost');
    expect(audit).toMatchObject([{ event: 'order.orphaned', meldOrderId: 'order-1' }]);
    expect(JSON.stringify(audit)).not.toContain('tok_order_scoped_secret');
  });
});

describe('Onramp.createOrder, replay', () => {
  it('answers a bank replay with the stored details and places no second order', async () => {
    const { service, orders, audit } = build(headless(), async () => bankOrder());
    const first = await service.createOrder(SUBJECT, KEY_HASH, bankRequest(), REQUEST_ID, CLIENT_IP);

    const again = await service.createOrder(SUBJECT, KEY_HASH, bankRequest(), 'req-2', CLIENT_IP);

    expect(again).toEqual(first);
    expect(orders.createHeadlessOrder).toHaveBeenCalledTimes(1);
    expect(audit.map((e) => e.event)).toEqual(['order.created', 'order.created']);
  });

  it('answers a bank replay whose details have lapsed with REQUEST_SURFACE_EXPIRED', async () => {
    const { service, clock } = build(headless(), async () => bankOrder());
    await service.createOrder(SUBJECT, KEY_HASH, bankRequest(), REQUEST_ID, CLIENT_IP);
    clock.now = Date.parse('2023-11-14T22:28:20Z');

    const refusal = await refusalOf(() =>
      service.createOrder(SUBJECT, KEY_HASH, bankRequest({ termsAcceptedAt: new Date(clock.now).toISOString() }), REQUEST_ID, CLIENT_IP),
    );

    expect(refusal.status).toBe(409);
    expect(refusal.failure).toMatchObject({ value: { code: 'REQUEST_SURFACE_EXPIRED', fundingRequestId: 'funding-1' } });
  });

  it('cannot replay a card order, whose body was never stored', async () => {
    const { orders, order } = build();
    await order();

    const refusal = await refusalOf(() => order());

    expect(refusal.status).toBe(409);
    expect(refusal.failure).toMatchObject({ value: { code: 'REQUEST_SURFACE_EXPIRED', fundingRequestId: 'funding-1' } });
    expect(orders.createHeadlessOrder).toHaveBeenCalledTimes(1);
  });

  it('keeps the existing codes for rows that are in flight, concluded, or other terms', async () => {
    const { service, store, order } = build();
    await order();
    const reset = (overrides: Partial<FundingRecord>) => {
      store.rows.set('funding-1', { ...must(store.rows.get('funding-1')), ...overrides });
    };

    reset({ status: 'created' });
    expect(codeOf((await refusalOf(() => order())).failure)).toBe('REQUEST_IN_FLIGHT');

    reset({ status: 'settled' });
    expect(codeOf((await refusalOf(() => order())).failure)).toBe('REQUEST_ALREADY_SETTLED');

    reset({ status: 'session_opened' });
    expect(codeOf((await refusalOf(() => order({ sourceAmount: '30.00' }))).failure)).toBe('IDEMPOTENCY_KEY_REUSED');

    // The same caller and key under another customer key is another buyer's order.
    const other = '0c'.repeat(32);
    store.customers.set(`app.dot|${other}`, customerRow({ customer_key_hash: other, meld_customer_id: 'meld-customer-2' }));
    const foreign = await refusalOf(() =>
      service.createOrder(SUBJECT, other, orderRequest({ termsAcceptedAt: ACCEPTED }), REQUEST_ID, CLIENT_IP),
    );
    expect(codeOf(foreign.failure)).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('refuses a key used for a widget session, and the reverse', async () => {
    const { service, order } = build();
    await service.createSession(SUBJECT, createRequest({ idempotencyKey: 'idem-shared-01' }), REQUEST_ID);
    await order({ idempotencyKey: 'idem-shared-02' });

    expect(codeOf((await refusalOf(() => order({ idempotencyKey: 'idem-shared-01' }))).failure)).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(
      codeOf((await refusalOf(() => service.createSession(SUBJECT, createRequest({ idempotencyKey: 'idem-shared-02' }), REQUEST_ID))).failure),
    ).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('treats a live headless row without an order id as corruption', async () => {
    const { store, order } = build();
    await order();
    store.rows.set('funding-1', { ...must(store.rows.get('funding-1')), meld_order_id: undefined });

    await expect(order()).rejects.toThrow(/placed no order/);
  });
});

describe('Onramp.quote, headless', () => {
  it('asks the rail for headless offers', async () => {
    const { service, rail } = build();

    await service.quote({ ...quoteBody(), integrationMode: 'headless' });

    expect(rail.quotes[0]).toMatchObject({ direction: 'buy', integrationMode: 'headless' });
  });

  it('leaves a widget quote as it was', async () => {
    const { service, rail } = build();

    await service.quote(quoteBody());

    expect(rail.quotes[0]).not.toHaveProperty('integrationMode');
  });

  it('refuses a headless quote where Meld Headless is off', async () => {
    const { service, rail } = build(config());

    const refusal = await refusalOf(() => service.quote({ ...quoteBody(), integrationMode: 'headless' }));

    expect(codeOf(refusal.failure)).toBe('HEADLESS_DISABLED');
    expect(rail.quotes).toHaveLength(0);
  });
});

function quoteBody() {
  return {
    destinationCurrencyCode: 'USDC_ASSETHUB',
    sourceAmount: '20',
    fiat: 'USD',
    country: 'US',
    paymentMethodType: 'CREDIT_DEBIT_CARD',
  };
}
