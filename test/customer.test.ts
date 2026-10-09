import { describe, expect, it, vi } from 'vitest';

import type { AuditEvent } from '../src/audit.js';
import { Refusal, type CustomerRegistration } from '../src/contract.js';
import { CustomerService, customerViewOf, kycStateOf, requirementsViewOf } from '../src/customer.js';
import { MeldHttpError } from '../src/meld/client.js';
import { KEY_HASH, config, customerRow, fakeCustomerMeld, fakeStore, headlessConfig, meldCustomer } from './fixtures.js';

const SUBJECT = { productId: 'app.dot', alias: 'alias-abc', proven: true };
const REQUEST_ID = 'req-1';
const NOW = 1_700_000_000_000;
const EXTERNAL_ID = '6c1f0c4e-8f0e-4d55-9a37-3a3c2d1f0b11';

const ADA: CustomerRegistration = {
  firstName: 'Ada',
  lastName: 'Lovelace',
  email: 'ada@example.com',
  dateOfBirth: '1990-03-15',
  address: { lineOne: '1 Main St', city: 'Berlin', postalCode: '10115', countryCode: 'DE' },
};

const QUERY = {
  provider: 'BANXA',
  paymentMethodType: 'CREDIT_DEBIT_CARD',
  country: 'DE',
  fiat: 'eur',
  sourceAmount: '101.20',
  destinationCurrencyCode: 'DOT_ASSETHUB',
};

const headless = (overrides: Record<string, unknown> = {}) => {
  const raw = headlessConfig();
  const meld = raw.meld as { headless: Record<string, unknown> };
  meld.headless = { ...meld.headless, ...overrides };
  return config(raw);
};

function build(options: { cfg?: ReturnType<typeof config>; store?: ReturnType<typeof fakeStore> } = {}) {
  const meld = fakeCustomerMeld();
  const store = options.store ?? fakeStore();
  const events: AuditEvent[] = [];
  const warn = vi.fn<(fields: Record<string, unknown>, message: string) => void>();
  const service = new CustomerService(
    options.cfg ?? headless(),
    meld,
    store,
    { info: (event) => events.push(event) },
    { warn },
    () => NOW,
    () => EXTERNAL_ID,
  );
  return { service, meld, store, events, warn };
}

const stored = () => {
  const store = fakeStore();
  store.customers.set(`app.dot|${KEY_HASH}`, customerRow());
  return store;
};

const refusalOf = async (promise: Promise<unknown>): Promise<Refusal> => {
  const error = await promise.then(
    () => undefined,
    (cause: unknown) => cause,
  );
  if (!(error instanceof Refusal)) throw new Error(`expected a Refusal, got ${String(error)}`);
  return error;
};

describe('kycStateOf', () => {
  it.each([
    [undefined, 'none'],
    [null, 'none'],
    ['APPROVED', 'approved'],
    ['PENDING', 'pending'],
    ['REJECTED', 'rejected'],
    ['EXPIRED', 'expired'],
    ['ON_HOLD', 'pending'],
  ] as const)('reads %s as %s', (status, state) => {
    expect(kycStateOf(status)).toBe(state);
  });
});

describe('customerViewOf', () => {
  it('reads Sumsub as the unified state and offers a questionnaire only while a provider can move', () => {
    const view = customerViewOf(
      meldCustomer({
        serviceProviderCustomers: [
          { serviceProvider: 'SUMSUB', kyc: { status: 'APPROVED', additionalInfo: null } },
          { serviceProvider: 'NOAH', kyc: { status: 'PENDING', additionalInfo: { HostedURL: 'https://noah.example/kyc' } } },
          { serviceProvider: 'DUENETWORK', kyc: { status: 'REJECTED', additionalInfo: { HostedURL: 'https://due.example/kyc' } } },
          { serviceProvider: 'BANXA', kyc: null },
        ],
      }),
    );

    expect(view).toEqual({
      kyc: 'approved',
      providers: [
        { provider: 'NOAH', kyc: 'pending', actionUrl: 'https://noah.example/kyc' },
        { provider: 'DUENETWORK', kyc: 'rejected' },
        { provider: 'BANXA', kyc: 'none' },
      ],
    });
  });

  it('reads a customer with no provider records as not started', () => {
    expect(customerViewOf(meldCustomer({ serviceProviderCustomers: null }))).toEqual({ kyc: 'none', providers: [] });
  });
});

describe('requirementsViewOf', () => {
  const answer = {
    legalAgreements: [{ type: 'TERMS_OF_SERVICE', url: 'https://provider.example/terms', region: 'EU' }],
    verificationRequirements: { email: { required: true }, phone: { required: true }, enforced: true },
    customerStatus: { email: { satisfied: true }, phone: { satisfied: false, reason: 'STALE' } },
    kycRequirements: [
      { code: 'MELD_KYC_APPROVED', status: 'SATISFIED' },
      { code: 'PROVIDER_KYC_SHARE', status: 'PENDING' },
      { code: 'PROVIDER_EXTRA_KYC', status: 'REQUIRED', missingFields: ['occupation', 'sourceOfFunds'] },
      { code: 'PROVIDER_EXTRA_KYC', status: 'REQUIRED', missingFields: ['occupation', ' '] },
      { code: 'PROVIDER_EXTRA_KYC', status: 'SATISFIED', missingFields: ['employer'] },
    ],
  };

  it('lists what is outstanding, once each', () => {
    expect(requirementsViewOf(answer, true)).toEqual({
      agreements: [{ type: 'TERMS_OF_SERVICE', url: 'https://provider.example/terms' }],
      verifications: [{ channel: 'PHONE', reason: 'STALE' }],
      missingFields: ['occupation', 'sourceOfFunds'],
      pending: true,
      blocked: false,
      ready: false,
    });
  });

  it('reads an unknown or absent reason as MISSING', () => {
    const view = requirementsViewOf(
      { verificationRequirements: { email: { required: true }, phone: { required: true } }, customerStatus: { phone: { satisfied: false, reason: 'NEW' } } },
      true,
    );
    expect(view.verifications).toEqual([
      { channel: 'EMAIL', reason: 'MISSING' },
      { channel: 'PHONE', reason: 'MISSING' },
    ]);
  });

  it('reports a blocked requirement', () => {
    expect(requirementsViewOf({ kycRequirements: [{ code: 'PROVIDER_KYC_SHARE', status: 'BLOCKED' }] }, true).blocked).toBe(true);
  });

  it('is ready only for a known customer with every requirement satisfied', () => {
    const satisfied = {
      verificationRequirements: { email: { required: true } },
      customerStatus: { email: { satisfied: true } },
      kycRequirements: [{ code: 'MELD_KYC_APPROVED', status: 'SATISFIED' }],
    };
    expect(requirementsViewOf(satisfied, true).ready).toBe(true);
    expect(requirementsViewOf(satisfied, false).ready).toBe(false);
  });
});

describe('CustomerService', () => {
  it('refuses to build without the headless block', () => {
    expect(() => new CustomerService(config(), fakeCustomerMeld(), fakeStore(), { info: vi.fn() }, { warn: vi.fn() })).toThrow(
      /requires meld\.headless/,
    );
  });

  describe('get', () => {
    it('answers null for an unregistered key without asking Meld', async () => {
      const { service, meld } = build();

      await expect(service.get(SUBJECT, KEY_HASH, REQUEST_ID)).resolves.toBeNull();
      expect(meld.getCustomer).not.toHaveBeenCalled();
    });

    it('reads the stored customer from Meld and refreshes the KYC cache', async () => {
      const { service, meld, store } = build({ store: stored() });
      meld.getCustomer.mockResolvedValueOnce(
        meldCustomer({
          serviceProviderCustomers: [
            { serviceProvider: 'SUMSUB', kyc: { status: 'APPROVED' } },
            { serviceProvider: 'BANXA', kyc: { status: 'PENDING' } },
          ],
        }),
      );

      const view = await service.get(SUBJECT, KEY_HASH, REQUEST_ID);

      expect(meld.getCustomer).toHaveBeenCalledWith('meld-customer-1');
      expect(view).toEqual({ kyc: 'approved', providers: [{ provider: 'BANXA', kyc: 'pending' }] });
      expect(store.customers.get(`app.dot|${KEY_HASH}`)).toMatchObject({
        kyc_cache: { kyc: 'approved', providers: { BANXA: 'pending' } },
        updated_at: NOW,
      });
    });

    it('forgets a stored customer Meld no longer knows, and tells the operator', async () => {
      const { service, meld, store, warn, events } = build({ store: stored() });
      meld.getCustomer.mockResolvedValueOnce(undefined);

      await expect(service.get(SUBJECT, KEY_HASH, REQUEST_ID)).resolves.toBeNull();
      expect(warn).toHaveBeenCalledWith(
        { reqId: REQUEST_ID, meldCustomerId: 'meld-customer-1' },
        'stored Meld customer is unknown to Meld',
      );
      expect(store.customers.size).toBe(0);
      expect(events).toEqual([
        {
          event: 'customer.forgotten',
          alias: 'alias-abc',
          productId: 'app.dot',
          requestId: REQUEST_ID,
          meldCustomerId: 'meld-customer-1',
        },
      ]);
    });

    it('audits nothing when a concurrent request already removed or replaced the mapping', async () => {
      const store = stored();
      store.deleteCustomer = () => Promise.resolve(false);
      const { service, meld, events } = build({ store });
      meld.getCustomer.mockResolvedValueOnce(undefined);

      await expect(service.get(SUBJECT, KEY_HASH, REQUEST_ID)).resolves.toBeNull();
      expect(events).toEqual([]);
    });

    it('degrades a Meld outage to a retryable refusal naming only status and code', async () => {
      const { service, meld } = build({ store: stored() });
      meld.getCustomer.mockRejectedValueOnce(new MeldHttpError(500, 'SERVICE_PROVIDER_ERROR', 'Ada Lovelace not loaded'));

      const refusal = await refusalOf(service.get(SUBJECT, KEY_HASH, REQUEST_ID));

      expect(refusal.status).toBe(503);
      expect(refusal.failure).toEqual({ tag: 'ProviderTimeout' });
      expect(refusal.message).toBe('Meld answered HTTP 500 SERVICE_PROVIDER_ERROR');
    });

    it('passes a failure that is not a Meld status through', async () => {
      const { service, meld } = build({ store: stored() });
      const cause = new Error('socket hang up');
      meld.getCustomer.mockRejectedValueOnce(cause);

      await expect(service.get(SUBJECT, KEY_HASH, REQUEST_ID)).rejects.toBe(cause);
    });
  });

  describe('register', () => {
    it('creates the Meld customer under a random external id, adds the address, and records the key', async () => {
      const { service, meld, store, events } = build();
      meld.createCustomer.mockResolvedValueOnce(
        meldCustomer({ serviceProviderCustomers: [{ serviceProvider: 'SUMSUB', kyc: { status: 'PENDING' } }] }),
      );

      const view = await service.register(SUBJECT, KEY_HASH, ADA, REQUEST_ID);

      expect(view).toEqual({ kyc: 'pending', providers: [] });
      expect(meld.createCustomer).toHaveBeenCalledWith({
        externalId: EXTERNAL_ID,
        name: { firstName: 'Ada', lastName: 'Lovelace' },
        email: 'ada@example.com',
        dateOfBirth: '1990-03-15',
      });
      expect(meld.addCustomerAddress).toHaveBeenCalledWith('meld-customer-1', {
        firstName: 'Ada',
        lastName: 'Lovelace',
        lineOne: '1 Main St',
        city: 'Berlin',
        postalCode: '10115',
        countryCode: 'DE',
      });
      expect(store.customers.get(`app.dot|${KEY_HASH}`)).toEqual({
        product_id: 'app.dot',
        customer_key_hash: KEY_HASH,
        meld_customer_id: 'meld-customer-1',
        external_id: EXTERNAL_ID,
        kyc_cache: { kyc: 'pending', providers: {} },
        created_at: NOW,
        updated_at: NOW,
      });
      expect(events).toEqual([{ event: 'customer.created', alias: 'alias-abc', productId: 'app.dot', requestId: REQUEST_ID }]);
    });

    it('adds no address when none was given', async () => {
      const { service, meld } = build();
      const withoutAddress: CustomerRegistration = {
        firstName: ADA.firstName,
        lastName: ADA.lastName,
        email: ADA.email,
        dateOfBirth: ADA.dateOfBirth,
      };

      await service.register(SUBJECT, KEY_HASH, withoutAddress, REQUEST_ID);

      expect(meld.addCustomerAddress).not.toHaveBeenCalled();
    });

    it('refuses a key whose customer Meld still knows, creating nothing', async () => {
      const { service, meld } = build({ store: stored() });

      const refusal = await refusalOf(service.register(SUBJECT, KEY_HASH, ADA, REQUEST_ID));

      expect(refusal.status).toBe(409);
      expect(refusal.failure).toEqual({
        tag: 'Other',
        value: { code: 'CUSTOMER_EXISTS', message: 'A customer is already registered for this key.' },
      });
      expect(meld.getCustomer).toHaveBeenCalledWith('meld-customer-1');
      expect(meld.createCustomer).not.toHaveBeenCalled();
    });

    it('forgets a stored customer Meld no longer knows and registers the key again', async () => {
      const { service, meld, store, events } = build({ store: stored() });
      meld.getCustomer.mockResolvedValueOnce(undefined);
      meld.createCustomer.mockResolvedValueOnce(meldCustomer({ id: 'meld-customer-2' }));

      await service.register(SUBJECT, KEY_HASH, ADA, REQUEST_ID);

      expect(store.customers.get(`app.dot|${KEY_HASH}`)?.meld_customer_id).toBe('meld-customer-2');
      expect(events.map((e) => e.event)).toEqual(['customer.forgotten', 'customer.created']);
    });

    it('keeps the mapping when Meld cannot say whether the stored customer exists', async () => {
      const { service, meld, store } = build({ store: stored() });
      meld.getCustomer.mockRejectedValueOnce(new MeldHttpError(503));

      expect((await refusalOf(service.register(SUBJECT, KEY_HASH, ADA, REQUEST_ID))).status).toBe(503);
      expect(store.customers.size).toBe(1);
      expect(meld.createCustomer).not.toHaveBeenCalled();
    });

    it('refuses on a Meld 400 without repeating what Meld said', async () => {
      const { service, meld, events } = build();
      meld.createCustomer.mockRejectedValueOnce(new MeldHttpError(400, 'BAD_REQUEST', 'email ada@example.com is invalid'));

      const refusal = await refusalOf(service.register(SUBJECT, KEY_HASH, ADA, REQUEST_ID));

      expect(refusal.status).toBe(400);
      expect(refusal.failure).toEqual({
        tag: 'Other',
        value: { code: 'PROVIDER_REJECTED', message: 'The provider declined this request.' },
      });
      expect(refusal.message).toBe('Meld answered HTTP 400 BAD_REQUEST');
      expect(events).toEqual([]);
    });

    it('audits the Meld customer an address failure leaves unrecorded', async () => {
      const { service, meld, store, events } = build();
      meld.addCustomerAddress.mockRejectedValueOnce(new MeldHttpError(503));

      const refusal = await refusalOf(service.register(SUBJECT, KEY_HASH, ADA, REQUEST_ID));

      expect(refusal.message).toBe('Meld answered HTTP 503');
      expect(store.customers.size).toBe(0);
      expect(events).toEqual([
        {
          event: 'customer.orphaned',
          alias: 'alias-abc',
          productId: 'app.dot',
          requestId: REQUEST_ID,
          meldCustomerId: 'meld-customer-1',
          reason: 'address_failed',
        },
      ]);
    });

    it('audits the Meld customer a failed insert leaves unrecorded', async () => {
      const store = fakeStore();
      const cause = new Error('connection terminated');
      store.insertCustomer = () => Promise.reject(cause);
      const { service, events } = build({ store });

      await expect(service.register(SUBJECT, KEY_HASH, ADA, REQUEST_ID)).rejects.toBe(cause);
      expect(events).toEqual([expect.objectContaining({ event: 'customer.orphaned', reason: 'insert_failed' })]);
    });

    it('yields to a concurrent registration of the same key', async () => {
      const store = fakeStore();
      const { service, events } = build({ store });
      store.customerByKey = vi.fn<typeof store.customerByKey>().mockResolvedValueOnce(undefined);
      store.customers.set(`app.dot|${KEY_HASH}`, customerRow({ meld_customer_id: 'meld-customer-0', external_id: 'other' }));

      const refusal = await refusalOf(service.register(SUBJECT, KEY_HASH, ADA, REQUEST_ID));

      expect(refusal.failure).toMatchObject({ value: { code: 'CUSTOMER_EXISTS' } });
      expect(events).toEqual([
        expect.objectContaining({ event: 'customer.orphaned', meldCustomerId: 'meld-customer-1', reason: 'concurrent_registration' }),
      ]);
    });
  });

  describe('startKyc', () => {
    it('starts Sumsub hosted KYC, sharing with nobody when the list is empty', async () => {
      const { service, meld, events } = build({ store: stored() });

      await expect(service.startKyc(SUBJECT, KEY_HASH, REQUEST_ID)).resolves.toEqual({ url: 'https://kyc.example/verify/1' });
      expect(meld.initiateKyc).toHaveBeenCalledWith('meld-customer-1', { serviceProvider: 'SUMSUB', mode: 'HOSTED_URL' });
      expect(meld.refreshKyc).not.toHaveBeenCalled();
      expect(events).toEqual([{ event: 'customer.kyc_started', alias: 'alias-abc', productId: 'app.dot', requestId: REQUEST_ID }]);
    });

    it('shares with the configured providers', async () => {
      const { service, meld } = build({ cfg: headless({ kyc_share_providers: ['NOAH'] }), store: stored() });

      await service.startKyc(SUBJECT, KEY_HASH, REQUEST_ID);

      expect(meld.initiateKyc).toHaveBeenCalledWith('meld-customer-1', {
        serviceProvider: 'SUMSUB',
        mode: 'HOSTED_URL',
        kycShareProviders: ['NOAH'],
      });
    });

    it('re-issues the session with the same body when Meld says it was already started', async () => {
      const { service, meld } = build({ cfg: headless({ kyc_share_providers: ['NOAH'] }), store: stored() });
      meld.initiateKyc.mockResolvedValueOnce({ outcome: 'already_shared' });

      await expect(service.startKyc(SUBJECT, KEY_HASH, REQUEST_ID)).resolves.toEqual({ url: 'https://kyc.example/verify/2' });
      expect(meld.refreshKyc).toHaveBeenCalledWith('meld-customer-1', {
        serviceProvider: 'SUMSUB',
        mode: 'HOSTED_URL',
        kycShareProviders: ['NOAH'],
      });
    });

    it('refuses a session without a URL as an upstream failure', async () => {
      const { service, meld, events } = build({ store: stored() });
      meld.initiateKyc.mockResolvedValueOnce({ outcome: 'started', session: { status: 'APPROVED', url: null } });

      const refusal = await refusalOf(service.startKyc(SUBJECT, KEY_HASH, REQUEST_ID));

      expect(refusal.status).toBe(503);
      expect(events).toEqual([]);
    });

    it('refuses an unregistered key', async () => {
      const { service, meld } = build();

      const refusal = await refusalOf(service.startKyc(SUBJECT, KEY_HASH, REQUEST_ID));

      expect(refusal.status).toBe(404);
      expect(refusal.failure).toEqual({
        tag: 'Other',
        value: { code: 'CUSTOMER_NOT_FOUND', message: 'No customer is registered for this key.' },
      });
      expect(meld.initiateKyc).not.toHaveBeenCalled();
    });
  });

  describe('requirements', () => {
    it('asks for the base requirements without a customer, on the configured network', async () => {
      const { service, meld } = build({ store: stored() });

      const view = await service.requirements(SUBJECT, undefined, QUERY);

      expect(meld.requirements).toHaveBeenCalledWith('BANXA', {
        paymentMethodType: 'CREDIT_DEBIT_CARD',
        sourceCurrencyCode: 'EUR',
        sourceAmount: '101.20',
        destinationCurrencyCode: 'DOT_ASSETHUB',
        countryCode: 'DE',
        destinationNetworkCode: 'polkadot',
      });
      expect(view.agreements).toEqual([{ type: 'TERMS_OF_SERVICE', url: 'https://provider.example/terms' }]);
      expect(view.ready).toBe(false);
    });

    it('sends the customer id for a stored customer, and only then can be ready', async () => {
      const { service, meld } = build({ store: stored() });

      const view = await service.requirements(SUBJECT, KEY_HASH, QUERY);

      expect(meld.requirements.mock.calls[0]?.[1]).toMatchObject({ customerId: 'meld-customer-1' });
      expect(view.ready).toBe(true);
    });

    it('sends no customer id for a valid key that has not registered', async () => {
      const { service, meld } = build();

      const view = await service.requirements(SUBJECT, KEY_HASH, QUERY);

      expect(meld.requirements.mock.calls[0]?.[1]).not.toHaveProperty('customerId');
      expect(view.ready).toBe(false);
    });

    it('omits the network code for a destination with none configured', async () => {
      const { service, meld } = build({ cfg: headless({ enabled: false, network_codes: {} }) });

      await service.requirements(SUBJECT, undefined, QUERY);

      expect(meld.requirements.mock.calls[0]?.[1]).not.toHaveProperty('destinationNetworkCode');
    });

    it('refuses a destination this service does not deliver, before calling Meld', async () => {
      const { service, meld } = build();

      const refusal = await refusalOf(service.requirements(SUBJECT, undefined, { ...QUERY, destinationCurrencyCode: 'BTC' }));

      expect(refusal.failure).toEqual({ tag: 'WrongAssetOrChain' });
      expect(meld.requirements).not.toHaveBeenCalled();
    });
  });

  describe('submitDetails', () => {
    it('sends the fields through the KYC PATCH, shared with the provider that asked', async () => {
      const { service, meld } = build({ store: stored() });

      await service.submitDetails(SUBJECT, KEY_HASH, { provider: 'BANXA', fields: { occupation: 'Engineer' } });

      expect(meld.refreshKyc).toHaveBeenCalledWith('meld-customer-1', {
        serviceProvider: 'SUMSUB',
        mode: 'HOSTED_URL',
        kycShareProviders: ['BANXA'],
        serviceProviderDetails: { occupation: 'Engineer' },
      });
    });

    it('refuses an unregistered key', async () => {
      const { service } = build();

      const refusal = await refusalOf(service.submitDetails(SUBJECT, KEY_HASH, { provider: 'BANXA', fields: { a: 'b' } }));

      expect(refusal.status).toBe(404);
    });
  });

  describe('startVerification', () => {
    it('answers the verification and its times as Meld states them', async () => {
      const { service, meld } = build({ store: stored() });

      await expect(service.startVerification(SUBJECT, KEY_HASH, { channel: 'EMAIL', target: 'ada@example.com' })).resolves.toEqual({
        verificationId: 'verification-1',
        expiresAt: '2026-08-25T02:57:26Z',
        resendAvailableAt: '2026-08-25T02:47:56Z',
      });
      expect(meld.startVerification).toHaveBeenCalledWith('meld-customer-1', { channel: 'EMAIL', target: 'ada@example.com' });
    });

    it.each([['2026-08-25T02:47:56Z'], [null]])('refuses a cooldown with 429 carrying resendAvailableAt %s', async (resendAvailableAt) => {
      const { service, meld } = build({ store: stored() });
      meld.startVerification.mockResolvedValueOnce({ outcome: 'cooldown', resendAvailableAt });

      const refusal = await refusalOf(service.startVerification(SUBJECT, KEY_HASH, { channel: 'PHONE', target: '+14155550123' }));

      expect(refusal.status).toBe(429);
      expect(refusal.failure).toEqual({
        tag: 'Other',
        value: {
          code: 'VERIFICATION_COOLDOWN',
          message: 'A code was sent recently. Wait before asking for another.',
          resendAvailableAt,
        },
      });
    });

    it('refuses a verification Meld answered without its times', async () => {
      const { service, meld } = build({ store: stored() });
      meld.startVerification.mockResolvedValueOnce({ outcome: 'sent', verification: { verificationId: 'v', expiresAt: null } });

      expect((await refusalOf(service.startVerification(SUBJECT, KEY_HASH, { channel: 'EMAIL', target: 'a@b.co' }))).status).toBe(503);
    });
  });

  describe('confirmVerification', () => {
    const confirmation = { verificationId: 'verification-1', code: '316856' };

    it('answers VERIFIED', async () => {
      const { service, meld } = build({ store: stored() });

      await expect(service.confirmVerification(SUBJECT, KEY_HASH, confirmation)).resolves.toEqual({ status: 'VERIFIED' });
      expect(meld.confirmVerification).toHaveBeenCalledWith('meld-customer-1', 'verification-1', '316856');
    });

    it('answers FAILED with the attempts left, when Meld states them', async () => {
      const { service, meld } = build({ store: stored() });
      meld.confirmVerification.mockResolvedValueOnce({ status: 'FAILED', attemptsRemaining: 2 });
      meld.confirmVerification.mockResolvedValueOnce({ status: 'FAILED' });

      await expect(service.confirmVerification(SUBJECT, KEY_HASH, confirmation)).resolves.toEqual({ status: 'FAILED', attemptsRemaining: 2 });
      await expect(service.confirmVerification(SUBJECT, KEY_HASH, confirmation)).resolves.toEqual({ status: 'FAILED' });
    });

    it('reads a Meld 400 as an expired verification', async () => {
      const { service, meld } = build({ store: stored() });
      meld.confirmVerification.mockRejectedValueOnce(new MeldHttpError(400, 'BAD_REQUEST', 'code 316856 expired'));

      const refusal = await refusalOf(service.confirmVerification(SUBJECT, KEY_HASH, confirmation));

      expect(refusal.failure).toEqual({
        tag: 'Other',
        value: { code: 'VERIFICATION_EXPIRED', message: 'This code has expired. Ask for a new one.' },
      });
      expect(refusal.message).not.toContain('316856');
    });

    it('degrades any other Meld status', async () => {
      const { service, meld } = build({ store: stored() });
      meld.confirmVerification.mockRejectedValueOnce(new MeldHttpError(502, 'VERIFICATION_SEND_FAILED'));

      expect((await refusalOf(service.confirmVerification(SUBJECT, KEY_HASH, confirmation))).status).toBe(503);
    });
  });
});
