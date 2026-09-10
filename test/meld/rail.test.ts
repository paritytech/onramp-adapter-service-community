import { describe, expect, it, vi } from 'vitest';

import { fundingRecord, railSessionInput } from '../fixtures.js';

import { MeldClient } from '../../src/meld/client.js';
import { Secret } from '../../src/secret.js';
import { MeldRail } from '../../src/meld/rail.js';

/** A Meld stub client exercising just the surface the Meld rail adapts, plus the spies to assert on. */
/** One offer, so the rail's pass-through can be asserted on rather than an empty array. */
const OFFERS = [{ serviceProvider: 'TRANSAK', sourceAmount: '21.47' }];

const client = (saveWidget?: () => Promise<Record<string, unknown>>) => {
  const quote = vi.fn(async (): Promise<unknown[]> => OFFERS);
  const createWidgetSession = vi.fn(
    async () =>
      saveWidget?.() ?? {
        meldSessionId: 'meld-1',
        serviceProviderWidgetUrl: 'https://meldcrypto.com/session/meld-1',
        expiresAt: 1_800_000_000_000,
      },
  );
  const transaction = vi.fn(async () => ({ id: 'tx-1', status: 'SUCCEEDED' }));
  const stub = { quote, createWidgetSession, transaction } as unknown as MeldClient;
  return { stub, quote, createWidgetSession, transaction };
};

describe('the rail over a real client', () => {
  /**
   * The one seam both sides stub. `rail.test.ts` stubs the client; `client.test.ts` stubs `fetch`
   * beneath it. Between them sits `transactionByReference`'s re-check (the guard against settling
   * one buyer's request against another buyer's payment), and the e2e cannot exercise its mismatch
   * branch, because the fake Meld always echoes back the reference it was asked for.
   *
   * So: a real `MeldRail` over a real `MeldClient` over a stubbed `fetch`, answering with someone
   * else's reference.
   */
  it('refuses, rather than yielding nothing, when the rail returns someone else\'s transaction', async () => {
    const fetchMock = vi.fn(
      async (_url: string | URL, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            transactions: [
              { id: 'tx-theirs', status: 'SETTLED', externalSessionId: 'funding-someone-else' },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const rail = new MeldRail(new MeldClient('https://api-sb.meld.io', new Secret('k'), '2025-01-01', 1_000));

    // Not `undefined`. The search was filtered by the reference, so an answer carrying someone
    // else's means the filter did not apply, and "no transaction" is the one conclusion that must
    // not be drawn from a join that is visibly wrong. The worker turns this throw into `unobserved`
    // past the deadline instead of `expired`.
    await expect(rail.observation().finder(fundingRecord({ id: 'funding-mine' }))).rejects.toThrow(
      /settlement join is not what this client expects/,
    );
    // And it did ask under the service's own reference, not the caller's key.
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('funding-mine');
    vi.unstubAllGlobals();
  });

  it('yields the transaction when the reference really is ours', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              transactions: [{ id: 'tx-mine', status: 'SETTLED', externalSessionId: 'funding-mine' }],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
      ),
    );

    const rail = new MeldRail(new MeldClient('https://api-sb.meld.io', new Secret('k'), '2025-01-01', 1_000));
    const found = await rail.observation().finder(fundingRecord({ id: 'funding-mine' }));

    expect(found).toEqual({ id: 'tx-mine', status: 'SETTLED' });
    vi.unstubAllGlobals();
  });
});

describe('MeldRail', () => {
  it('advertises itself as the meld rail', () => {
    expect(new MeldRail(client().stub).provider).toBe('meld');
  });

  it('maps a neutral quote onto the Meld client and echoes the canonical requested shape', async () => {
    const { stub, quote } = client();
    const rail = new MeldRail(stub);

    const offers = await rail.quote({
      countryCode: 'US',
      sourceCurrencyCode: 'USD',
      destinationCurrencyCode: 'USDC_ASSETHUB',
      sourceAmount: '20',
      paymentMethodType: 'CREDIT_DEBIT_CARD',
    });

    expect(quote).toHaveBeenCalledWith({
      countryCode: 'US',
      sourceCurrencyCode: 'USD',
      destinationCurrencyCode: 'USDC_ASSETHUB',
      sourceAmount: '20',
      paymentMethodType: 'CREDIT_DEBIT_CARD',
    });
    // The rail returns Meld's offers and nothing else: the request echo is the caller's to
    // build, since it already holds every value in it.
    expect(offers).toEqual(OFFERS);
  });

  it('maps a session onto Meld, forwarding the client reference as the join key', async () => {
    const { stub, createWidgetSession } = client();
    const rail = new MeldRail(stub);

    const session = await rail.createSession(
      railSessionInput({
        serviceProvider: 'sp-1',
        clientReference: 'idem-xyz-123',
        redirectUrl: 'https://app.example/done',
      }),
    );

    expect(createWidgetSession).toHaveBeenCalledWith({
      destinationCode: 'USDC_ASSETHUB',
      walletAddress: '5x...',
      sourceAmount: '25.00',
      sourceCurrency: 'USD',
      countryCode: 'US',
      paymentMethodType: 'CREDIT_DEBIT_CARD',
      serviceProvider: 'sp-1',
      clientReference: 'idem-xyz-123',
      redirectUrl: 'https://app.example/done',
    });
    // The neutral session surfaces Meld's ids and the provider-facing page as the primary widget.
    expect(session.providerSessionId).toBe('meld-1');
    expect(session.settlementUrl).toBe('https://meldcrypto.com/session/meld-1');
    expect(session.expiresAt).toBe(1_800_000_000_000);
  });

  it('keeps the provider page and Meld\'s own widget as two distinct surfaces', async () => {
    const { stub } = client(async () => ({
      meldSessionId: 'meld-1',
      serviceProviderWidgetUrl: 'https://meldcrypto.com/s/provider',
      meldWidgetUrl: 'https://meldcrypto.com/s/meldwidget',
      expiresAt: undefined,
    }));
    const rail = new MeldRail(stub);

    const session = await rail.createSession(railSessionInput({ clientReference: 'idem-xyz-123' }));

    // Collapsing these into one value at the seam would make the field
    // named for the provider page carried Meld's widget instead and the provider page was lost.
    expect(session.settlementUrl).toBe('https://meldcrypto.com/s/provider');
    expect(session.hostedWidgetUrl).toBe('https://meldcrypto.com/s/meldwidget');
  });

  it('has no hollow-session case: MeldClient cannot produce one', async () => {
    // This replaced a test asserting `providerSessionId` and `widgetUrl` came back `undefined`
    // from a `{}` stub. That state is unreachable: `widgetSessionResponse` requires `id` and
    // `serviceProviderWidgetUrl`, and `RailSession` declares both as required precisely because
    // a session missing either is one the buyer cannot pay into and the worker cannot join. The
    // old test would have failed if the invariant were ever enforced on this side too.
    const { stub } = client(async () => ({
      meldSessionId: 'meld-1',
      serviceProviderWidgetUrl: 'https://meldcrypto.com/s/provider',
      meldWidgetUrl: undefined,
      expiresAt: undefined,
    }));
    const rail = new MeldRail(stub);

    const session = await rail.createSession(railSessionInput({ clientReference: 'idem-xyz-123' }));

    expect(session.settlementUrl).toBe('https://meldcrypto.com/s/provider');
    expect(session.hostedWidgetUrl).toBeUndefined();
    expect(session.expiresAt).toBeUndefined();
  });

  it('forwards transaction reads verbatim', async () => {
    const { stub, transaction } = client();
    const rail = new MeldRail(stub);

    expect(await rail.transaction('tx-1')).toEqual({ id: 'tx-1', status: 'SUCCEEDED' });
    expect(transaction).toHaveBeenCalledWith('tx-1');
  });
});

describe('MeldRail.observation', () => {
  const recordWith = (reference: string | undefined) => fundingRecord({ client_reference: reference });

  it('finds the transaction by the reference the session was filed under', async () => {
    const transactionByReference = vi.fn(async () => ({ id: 'tx-1', status: 'SETTLED' }));
    const rail = new MeldRail({ transactionByReference } as unknown as MeldClient);

    const seen = await rail.observation().finder(recordWith('idem-1'));

    // The record's own id, which is globally unique, rather than the caller's idempotency key:
    // that is unique only per (caller, product) and would let two callers match one transaction.
    expect(transactionByReference).toHaveBeenCalledWith('funding-1');
    expect(seen).toEqual({ id: 'tx-1', status: 'SETTLED' });
  });


  it('reports a transaction with no status as seen but unconcluded', async () => {
    const transactionByReference = vi.fn(async () => ({ id: 'tx-1' }));
    const rail = new MeldRail({ transactionByReference } as unknown as MeldClient);

    await expect(rail.observation().finder(recordWith('idem-1'))).resolves.toEqual({ id: 'tx-1', status: null });
  });

  it('passes nothing back when Meld has no transaction yet', async () => {
    const transactionByReference = vi.fn(async () => undefined);
    const rail = new MeldRail({ transactionByReference } as unknown as MeldClient);

    await expect(rail.observation().finder(recordWith('idem-1'))).resolves.toBeUndefined();
  });

  it.each([
    ['SETTLED', 'settled'],
    ['COMPLETED', 'settled'],
    ['SUCCESS', 'settled'],
    ['SUCCEEDED', 'settled'],
    ['settled', 'settled'],
    ['FAILED', 'failed'],
    ['CANCELLED', 'failed'],
    ['DECLINED', 'failed'],
    ['REFUNDED', 'failed'],
    ['AUTHORIZATION_EXPIRED', 'failed'],
    ['declined', 'failed'],
  ])('maps Meld status %s to %s', (status, expected) => {
    expect(new MeldRail({} as unknown as MeldClient).observation().mapper(status)).toBe(expected);
  });

  it.each(['PENDING', 'PROCESSING', 'AUTHORIZED', 'ERROR', 'something-nobody-has-seen', undefined])(
    'leaves %s unconcluded rather than concluding a temporary or unknown status',
    (status) => {
      // ERROR is TEMPORARY per Meld ("may retry"); an unknown status is not on the documented page.
      // Concluding either is how a retryable or still-pending payment gets reported as failed.
      expect(new MeldRail({} as unknown as MeldClient).observation().mapper(status)).toBe('transaction_seen');
    },
  );
});
