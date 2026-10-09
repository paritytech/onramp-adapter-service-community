import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Config } from '../src/config.js';
import type { CustomerKeys } from '../src/customer-auth.js';
import { CustomerService } from '../src/customer.js';
import { MeldHttpError } from '../src/meld/client.js';
import { MeldWebhooks, meldSignature, type WebhookMeldPort } from '../src/meld/webhook.js';
import { Secret } from '../src/secret.js';
import { buildServer } from '../src/server.js';
import { config, customerRow, fakeCustomerMeld, fakeStore, headlessConfig, headlessRecord } from './fixtures.js';

const KEYS: CustomerKeys = {
  customerChallengeKey: new Uint8Array(32).fill(3),
  customerTokenKey: new Uint8Array(32).fill(4),
};
const SECRET = 'meld-webhook-signing-secret';
const WEBHOOK_URL = 'https://adapter.example/webhooks/meld';
const NOW = Date.parse('2026-10-09T12:00:00.000Z');
const TIMESTAMP = '2026-10-09T11:59:58.123456Z';

const stubOnramp = () => ({
  createSession: async () => Promise.reject(new Error('not under test')),
  createOrder: async () => Promise.reject(new Error('not under test')),
  quote: async () => Promise.reject(new Error('not under test')),
  supported: async () => ({ country: 'US', fiat: 'USD', crypto: 'DOT_ASSETHUB', methods: [] }),
  supportedCountries: async () => [],
  supportedCorridors: async () => [],
  transaction: async () => ({ transaction: {} }),
  cancel: async () => undefined,
  get: async () => undefined,
  list: async () => [],
});

const fakeMeld = (status: string | null = 'PENDING', orderId: string | null = 'order-1') => ({
  transaction: vi.fn<WebhookMeldPort['transaction']>(async (id) => ({ id, status, orderId })),
});

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

const serve = async (
  options: {
    cfg?: Config;
    meld?: ReturnType<typeof fakeMeld>;
    store?: ReturnType<typeof fakeStore>;
    sink?: { write: (line: string) => void };
  } = {},
) => {
  const cfg =
    options.cfg ?? config({ ...headlessConfig(), server: { port: 8080, host: '127.0.0.1', log_level: 'info' } });
  const meld = options.meld ?? fakeMeld();
  const store = options.store ?? fakeStore([headlessRecord()]);
  const webhook = cfg.meld.webhook;
  if (webhook === undefined) throw new Error('the fixture enables headless');
  app = await buildServer(
    cfg,
    stubOnramp,
    undefined,
    options.sink ?? { write: () => undefined },
    KEYS,
    (audit, log) => new CustomerService(cfg, fakeCustomerMeld(), store, audit, log),
    new MeldWebhooks(webhook, new Secret(SECRET), meld, store, () => NOW),
  );
  return { instance: app, meld, store };
};

let counter = 0;
const event = (eventType: string, payload: Record<string, unknown>, eventId = `event-${String((counter += 1))}`) => ({
  eventType,
  eventId,
  timestamp: '2026-10-09T11:59:57.000000Z',
  accountId: 'W2aRZnYGPwhBWB94iFsZus',
  version: '2026-02-02',
  payload,
});

const txEvent = (eventType: string, eventId?: string) =>
  event(
    eventType,
    {
      paymentTransactionId: 'tx-1',
      customerId: 'meld-customer-1',
      externalCustomerId: 'external-1',
      paymentTransactionStatus: 'PENDING',
      transactionType: 'CRYPTO_PURCHASE',
    },
    eventId,
  );

const deliver = (
  instance: FastifyInstance,
  body: object | string,
  sign: { secret?: string; url?: string; timestamp?: string; headers?: Record<string, string> } = {},
) => {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  const timestamp = sign.timestamp ?? TIMESTAMP;
  return instance.inject({
    method: 'POST',
    url: '/webhooks/meld',
    headers: sign.headers ?? {
      'content-type': 'application/json',
      'meld-signature': meldSignature(sign.secret ?? SECRET, timestamp, sign.url ?? WEBHOOK_URL, Buffer.from(raw)),
      'meld-signature-timestamp': timestamp,
    },
    payload: raw,
  });
};

const statuses = (store: ReturnType<typeof fakeStore>, id = 'funding-1') =>
  store.rows.get(id)?.status_history.map((entry) => entry.status);

describe('POST /webhooks/meld: the signature', () => {
  it('acknowledges a signed WEBHOOK_TEST with an empty 200 and records it', async () => {
    const { instance, store } = await serve();
    const response = await deliver(instance, event('WEBHOOK_TEST', { requestId: 'r-1' }, 'test-1'));
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('');
    expect(store.webhookEvents.has('test-1')).toBe(true);
  });

  it.each([
    ['another secret', { secret: 'not-the-secret' }],
    ['another WEBHOOK_URL', { url: 'https://adapter.example/webhooks/meld/' }],
    ['a stale timestamp', { timestamp: '2026-10-09T11:54:59.999Z' }],
    ['a future timestamp', { timestamp: '2026-10-09T12:05:00.001Z' }],
  ])('refuses a delivery signed with %s, applying nothing', async (_name, sign) => {
    const { instance, meld, store } = await serve();
    const response = await deliver(instance, txEvent('TRANSACTION_CRYPTO_PENDING', 'refused-1'), sign);
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: {
        tag: 'Other',
        value: { code: 'WEBHOOK_SIGNATURE_INVALID', message: 'The webhook signature was not accepted.' },
      },
      request_id: expect.any(String),
    });
    expect(meld.transaction).not.toHaveBeenCalled();
    expect(store.webhookEvents.size).toBe(0);
  });

  it('refuses a body altered after signing', async () => {
    const { instance } = await serve();
    const raw = JSON.stringify(event('WEBHOOK_TEST', {}));
    const signature = meldSignature(SECRET, TIMESTAMP, WEBHOOK_URL, Buffer.from(raw));
    const response = await instance.inject({
      method: 'POST',
      url: '/webhooks/meld',
      headers: { 'content-type': 'application/json', 'meld-signature': signature, 'meld-signature-timestamp': TIMESTAMP },
      payload: raw.replace('WEBHOOK_TEST', 'TRANSACTION_CRYPTO_COMPLETE'),
    });
    expect(response.statusCode).toBe(401);
  });

  it('refuses a delivery without the signature headers, or without a body', async () => {
    const { instance } = await serve();
    expect((await deliver(instance, event('WEBHOOK_TEST', {}), { headers: { 'content-type': 'application/json' } })).statusCode).toBe(
      401,
    );
    const empty = await instance.inject({
      method: 'POST',
      url: '/webhooks/meld',
      headers: { 'meld-signature': 'x', 'meld-signature-timestamp': TIMESTAMP },
    });
    expect(empty.statusCode).toBe(401);
  });

  it('is not rate limited, while the routes beside it are', async () => {
    const cfg = config({
      ...headlessConfig(),
      rate_limit: { per_person_max: 1, per_address_max: 1, window_seconds: 60 },
    });
    const { instance } = await serve({ cfg });
    for (let i = 0; i < 4; i += 1) {
      expect((await deliver(instance, event('WEBHOOK_TEST', {}))).statusCode).toBe(200);
    }
    const headers = { 'x-dev-product-id': 'app.dot' };
    await instance.inject({ method: 'GET', url: '/funding', headers });
    expect((await instance.inject({ method: 'GET', url: '/funding', headers })).statusCode).toBe(429);
  });

  it('takes a body up to 64 KiB, beyond the 16 KiB every other route allows', async () => {
    const { instance } = await serve();
    const large = event('WEBHOOK_TEST', { padding: 'x'.repeat(40 * 1024) });
    expect((await deliver(instance, large)).statusCode).toBe(200);
    const tooLarge = event('WEBHOOK_TEST', { padding: 'x'.repeat(65 * 1024) });
    expect((await deliver(instance, tooLarge)).statusCode).toBe(413);
  });
});

describe('POST /webhooks/meld: transaction events', () => {
  it('moves a row through each status Meld reports, recording the transaction', async () => {
    const meld = fakeMeld('PENDING');
    const { instance, store } = await serve({ meld });

    expect((await deliver(instance, txEvent('TRANSACTION_CRYPTO_PENDING'))).statusCode).toBe(200);
    expect(meld.transaction).toHaveBeenCalledWith('tx-1', { headless: true });
    expect(store.rows.get('funding-1')).toMatchObject({
      status: 'transaction_seen',
      provider_transaction_id: 'tx-1',
      provider_status: 'PENDING',
    });

    meld.transaction.mockResolvedValue({ id: 'tx-1', status: 'SETTLING', orderId: 'order-1' });
    expect((await deliver(instance, txEvent('TRANSACTION_CRYPTO_TRANSFERRING'))).statusCode).toBe(200);
    expect(store.rows.get('funding-1')?.status).toBe('transaction_seen');

    meld.transaction.mockResolvedValue({ id: 'tx-1', status: 'SETTLED', orderId: 'order-1' });
    expect((await deliver(instance, txEvent('TRANSACTION_CRYPTO_COMPLETE'))).statusCode).toBe(200);
    expect(store.rows.get('funding-1')).toMatchObject({ status: 'settled', provider_status: 'SETTLED' });
    expect(statuses(store)).toEqual(['session_opened', 'transaction_seen', 'settled']);
  });

  it('settles a row it had not yet seen pay, through transaction_seen, in one delivery', async () => {
    const { instance, store } = await serve({ meld: fakeMeld('SETTLED') });
    expect((await deliver(instance, txEvent('TRANSACTION_CRYPTO_COMPLETE'))).statusCode).toBe(200);
    expect(statuses(store)).toEqual(['session_opened', 'transaction_seen', 'settled']);
    expect(store.rows.get('funding-1')?.provider_transaction_id).toBe('tx-1');
  });

  it('reads the status from the transaction, not from the event', async () => {
    const { instance, store } = await serve({ meld: fakeMeld('SETTLED') });
    await deliver(instance, txEvent('TRANSACTION_CRYPTO_PENDING'));
    expect(store.rows.get('funding-1')?.status).toBe('settled');
  });

  it('concludes FAILED, and keeps an ERROR, which Meld calls temporary, live', async () => {
    const failed = await serve({ meld: fakeMeld('FAILED') });
    await deliver(failed.instance, txEvent('TRANSACTION_CRYPTO_FAILED'));
    expect(failed.store.rows.get('funding-1')).toMatchObject({ status: 'failed', provider_status: 'FAILED' });
    await app?.close();

    const errored = await serve({ meld: fakeMeld('ERROR') });
    await deliver(errored.instance, txEvent('TRANSACTION_CRYPTO_FAILED'));
    expect(errored.store.rows.get('funding-1')).toMatchObject({ status: 'transaction_seen', provider_status: 'ERROR' });
  });

  it('falls back to the event status when the transaction carries none', async () => {
    const { instance, store } = await serve({ meld: fakeMeld(null) });
    await deliver(instance, txEvent('TRANSACTION_CRYPTO_PENDING'));
    expect(store.rows.get('funding-1')).toMatchObject({ status: 'transaction_seen', provider_status: 'PENDING' });
  });

  it('leaves a row the worker already concluded as it is', async () => {
    const settled = headlessRecord({
      status: 'settled',
      status_history: [
        { status: 'session_opened', at: 1 },
        { status: 'transaction_seen', at: 2 },
        { status: 'settled', at: 3 },
      ],
      provider_status: 'SETTLED',
    });
    const { instance, store } = await serve({ meld: fakeMeld('FAILED'), store: fakeStore([settled]) });
    const response = await deliver(instance, txEvent('TRANSACTION_CRYPTO_FAILED', 'late-1'));
    expect(response.statusCode).toBe(200);
    expect(store.rows.get('funding-1')).toEqual(settled);
    expect(store.webhookEvents.has('late-1')).toBe(true);
  });

  it('acknowledges an order this service does not hold, and a transaction naming no order', async () => {
    const unknown = await serve({ meld: fakeMeld('SETTLED', 'order-elsewhere') });
    expect((await deliver(unknown.instance, txEvent('TRANSACTION_CRYPTO_COMPLETE'))).statusCode).toBe(200);
    expect(unknown.store.rows.get('funding-1')?.status).toBe('session_opened');
    await app?.close();

    const orphan = await serve({ meld: fakeMeld('SETTLED', null) });
    expect((await deliver(orphan.instance, txEvent('TRANSACTION_CRYPTO_COMPLETE'))).statusCode).toBe(200);
    expect(orphan.store.rows.get('funding-1')?.status).toBe('session_opened');
  });

  it('acknowledges a row that disappears before it is moved', async () => {
    const store = fakeStore([headlessRecord()]);
    vi.spyOn(store, 'advanceTo').mockResolvedValue(undefined);
    const { instance } = await serve({ store });
    expect((await deliver(instance, txEvent('TRANSACTION_CRYPTO_PENDING'))).statusCode).toBe(200);
  });

  it('applies a redelivered event once', async () => {
    const meld = fakeMeld('PENDING');
    const { instance, store } = await serve({ meld });
    const pending = txEvent('TRANSACTION_CRYPTO_PENDING', 'once-1');
    expect((await deliver(instance, pending)).statusCode).toBe(200);
    expect((await deliver(instance, pending)).statusCode).toBe(200);
    expect(meld.transaction).toHaveBeenCalledTimes(1);
    expect(statuses(store)).toEqual(['session_opened', 'transaction_seen']);
  });

  it('answers 503 when the event cannot be applied, and applies its redelivery', async () => {
    const meld = fakeMeld('SETTLED');
    meld.transaction.mockRejectedValueOnce(new MeldHttpError(500, 'INTERNAL_ERROR'));
    const { instance, store } = await serve({ meld });
    const complete = txEvent('TRANSACTION_CRYPTO_COMPLETE', 'retry-1');

    const failed = await deliver(instance, complete);
    expect(failed.statusCode).toBe(503);
    expect(failed.json().error.value.code).toBe('WEBHOOK_NOT_APPLIED');
    expect(store.webhookEvents.has('retry-1')).toBe(false);
    expect(store.rows.get('funding-1')?.status).toBe('session_opened');

    expect((await deliver(instance, complete)).statusCode).toBe(200);
    expect(store.rows.get('funding-1')?.status).toBe('settled');
    expect(store.webhookEvents.has('retry-1')).toBe(true);
  });

  it('answers 503 for a store failure too', async () => {
    const store = fakeStore([headlessRecord()]);
    vi.spyOn(store, 'byMeldOrderId').mockRejectedValueOnce(new Error('connection terminated'));
    const { instance } = await serve({ store });
    expect((await deliver(instance, txEvent('TRANSACTION_CRYPTO_PENDING'))).statusCode).toBe(503);
  });

  it('acknowledges a transaction event that names no transaction', async () => {
    const meld = fakeMeld();
    const { instance } = await serve({ meld });
    expect((await deliver(instance, event('TRANSACTION_CRYPTO_PENDING', { customerId: 'c' }))).statusCode).toBe(200);
    expect(meld.transaction).not.toHaveBeenCalled();
  });
});

describe('POST /webhooks/meld: KYC events', () => {
  const kycStore = () => {
    const store = fakeStore();
    store.customers.set(
      'app.dot|key',
      customerRow({ customer_key_hash: 'key', kyc_cache: { kyc: 'pending', providers: { BANXA: 'pending' } } }),
    );
    return store;
  };

  it('merges Sumsub into kyc and kycRecipient into its provider, keeping the rest', async () => {
    const store = kycStore();
    const { instance } = await serve({ store });
    const response = await deliver(
      instance,
      event('CUSTOMER_KYC_STATUS_CHANGE', {
        requestId: 'r-1',
        customerId: 'meld-customer-1',
        serviceProvider: 'SUMSUB',
        status: 'APPROVED',
        statusUpdatedAt: '2026-10-09T11:59:00Z',
        kycRecipient: { serviceProvider: 'MERCURYO', status: 'PENDING' },
      }),
    );
    expect(response.statusCode).toBe(200);
    expect(store.customers.get('app.dot|key')).toMatchObject({
      kyc_cache: { kyc: 'approved', providers: { BANXA: 'pending', MERCURYO: 'pending' } },
      updated_at: NOW,
    });
  });

  it("files another provider's own status under that provider", async () => {
    const store = kycStore();
    const { instance } = await serve({ store });
    await deliver(
      instance,
      event('CUSTOMER_KYC_STATUS_CHANGE', { customerId: 'meld-customer-1', serviceProvider: 'BANXA', status: 'REJECTED' }),
    );
    expect(store.customers.get('app.dot|key')?.kyc_cache).toEqual({ kyc: 'pending', providers: { BANXA: 'rejected' } });
  });

  it('acknowledges an unknown customer, an event with no status, and one naming no customer', async () => {
    const store = kycStore();
    const { instance } = await serve({ store });
    const before = structuredClone(store.customers.get('app.dot|key'));
    for (const payload of [
      { customerId: 'meld-customer-404', serviceProvider: 'SUMSUB', status: 'APPROVED' },
      { customerId: 'meld-customer-1', serviceProvider: 'SUMSUB' },
      { serviceProvider: 'SUMSUB', status: 'APPROVED' },
    ]) {
      expect((await deliver(instance, event('CUSTOMER_KYC_STATUS_CHANGE', payload))).statusCode).toBe(200);
    }
    expect(store.customers.get('app.dot|key')).toEqual(before);
  });
});

describe('POST /webhooks/meld: other deliveries', () => {
  it('acknowledges and records an event type it does not act on', async () => {
    const { instance, store, meld } = await serve();
    expect((await deliver(instance, event('BANK_LINKING_CONNECTION_COMPLETED', {}, 'other-1'))).statusCode).toBe(200);
    expect(store.webhookEvents.has('other-1')).toBe(true);
    expect(meld.transaction).not.toHaveBeenCalled();
  });

  it('acknowledges a verified body that is not an event, recording nothing', async () => {
    const { instance, store } = await serve();
    expect((await deliver(instance, 'not json')).statusCode).toBe(200);
    expect((await deliver(instance, { eventType: 'WEBHOOK_TEST' })).statusCode).toBe(200);
    expect(store.webhookEvents.size).toBe(0);
  });
});

describe('POST /webhooks/meld: logs', () => {
  it('name events, orders and funding requests, and nothing from the body, the signature or the secret', async () => {
    const lines: string[] = [];
    const store = fakeStore([headlessRecord()]);
    store.customers.set('app.dot|key', customerRow({ customer_key_hash: 'key' }));
    const { instance } = await serve({ sink: { write: (line) => lines.push(line) }, store, meld: fakeMeld('SETTLED') });

    const pii = { email: 'alice@example.com', firstName: 'Alice', walletAddress: '15oF4uVJwmo4TdGW7VfQxNLavjCXviqxT9S1MgbjMNHr6Sp5' };
    const transaction = { ...txEvent('TRANSACTION_CRYPTO_COMPLETE', 'logged-1'), payload: { ...txEvent('x').payload, ...pii } };
    const kyc = event(
      'CUSTOMER_KYC_STATUS_CHANGE',
      { customerId: 'meld-customer-1', serviceProvider: 'SUMSUB', status: 'APPROVED', ...pii },
      'logged-2',
    );
    const raw = JSON.stringify(transaction);
    const signature = meldSignature(SECRET, TIMESTAMP, WEBHOOK_URL, Buffer.from(raw));
    expect((await deliver(instance, raw)).statusCode).toBe(200);
    expect((await deliver(instance, kyc)).statusCode).toBe(200);
    expect((await deliver(instance, kyc, { secret: 'wrong' })).statusCode).toBe(401);

    const logged = lines.join('\n');
    expect(logged).toContain('"eventId":"logged-1"');
    expect(logged).toContain('"orderId":"order-1"');
    expect(logged).toContain('"fundingId":"funding-1"');
    expect(logged).toContain('"eventId":"logged-2"');
    for (const forbidden of [SECRET, signature, raw, 'alice@example.com', 'Alice', pii.walletAddress, 'external-1']) {
      expect(logged).not.toContain(forbidden);
    }
  });
});
