import { describe, expect, it, vi } from 'vitest';

import { fundingRecord, railSellSessionInput, railSessionInput, sellRecord } from '../fixtures.js';

import { MeldClient } from '../../src/meld/client.js';
import { Secret } from '../../src/secret.js';
import { MeldRail } from '../../src/meld/rail.js';

/** A Meld stub client exercising just the surface the Meld rail adapts, plus the spies to assert on. */
/** One offer, so the rail's pass-through can be asserted on rather than an empty array. */
const OFFERS = [{ serviceProvider: 'TRANSAK', sourceAmount: '21.47' }];

const client = (saveWidget?: () => Promise<Record<string, unknown>>) => {
  const quote = vi.fn(async (): Promise<unknown[]> => OFFERS);
  // Separate from `quote`, exactly as the client's two methods are. A single spy would make
  // "the rail called the sell path" indistinguishable from "the rail called the buy path with
  // the values swapped", which is the one mistake this seam can make.
  const quoteSell = vi.fn(async (): Promise<unknown[]> => OFFERS);
  const createWidgetSession = vi.fn(
    async () =>
      saveWidget?.() ?? {
        meldSessionId: 'meld-1',
        serviceProviderWidgetUrl: 'https://meldcrypto.com/session/meld-1',
        expiresAt: 1_800_000_000_000,
      },
  );
  const transaction = vi.fn(async () => ({ id: 'tx-1', status: 'SUCCEEDED' }));
  const stub = { quote, quoteSell, createWidgetSession, transaction } as unknown as MeldClient;
  return { stub, quote, quoteSell, createWidgetSession, transaction };
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

  it("crosses the two vocabularies on a sell quote: the port's destination is Meld's source", async () => {
    // The one thing this rail does on a sell that a rename would not. The port names the crypto
    // leg `destinationCurrencyCode` in **both** directions (one vocabulary for the consumer),
    // while Meld derives the direction of a quote purely from which of its own legs holds a
    // crypto. So the two namings cross here, and getting the crossing backwards does not fail
    // loudly: Meld would price a buy, or refuse with a currency error about the caller's own
    // request. Asserted field by field for that reason.
    const { stub, quote, quoteSell } = client();
    const rail = new MeldRail(stub);

    const offers = await rail.quote({
      direction: 'sell',
      countryCode: 'GB',
      sourceCurrencyCode: 'GBP',
      destinationCurrencyCode: 'DOT_ASSETHUB',
      cryptoAmount: '12.3456789012',
      paymentMethodType: 'PAYOUT_TO_BANK',
    });

    expect(quoteSell).toHaveBeenCalledWith({
      countryCode: 'GB',
      // The port's `destinationCurrencyCode`, which is Meld's *source* on a sell.
      cryptoCurrencyCode: 'DOT_ASSETHUB',
      // The port's `sourceCurrencyCode`, which is Meld's *destination* on a sell.
      fiatCurrencyCode: 'GBP',
      cryptoAmount: '12.3456789012',
      paymentMethodType: 'PAYOUT_TO_BANK',
    });
    // And not the buy method with the values swapped into it. The two are separate on the client
    // precisely so that neither direction can be served by filling in the other's struct.
    expect(quote).not.toHaveBeenCalled();
    expect(offers).toEqual(OFFERS);
  });

  it('opens a sell session with the legs crossed, the crypto amount, and no address', async () => {
    const { stub, createWidgetSession } = client();
    const rail = new MeldRail(stub);

    const session = await rail.createSession(
      railSellSessionInput({ clientReference: 'funding-sell-1', redirectUrl: 'https://app.example/sold' }),
    );

    // `toEqual` on the whole argument rather than `toMatchObject`: the absence of a
    // `walletAddress` is one of the things being asserted, and a partial match cannot assert an
    // absence. A sell has no caller-supplied address, Meld does not require one, and Meld's
    // session endpoint accepts unknown fields with a `200` — so nothing upstream would object to
    // a stray one and this seam is where it would have to be invented.
    expect(createWidgetSession).toHaveBeenCalledWith({
      direction: 'sell',
      cryptoCurrencyCode: 'DOT_ASSETHUB',
      fiatCurrencyCode: 'GBP',
      cryptoAmount: '12.3456789012',
      countryCode: 'GB',
      paymentMethodType: 'PAYOUT_TO_BANK',
      serviceProvider: 'TRANSAK',
      clientReference: 'funding-sell-1',
      redirectUrl: 'https://app.example/sold',
    });
    expect(session.providerSessionId).toBe('meld-1');
  });

  it('carries no expiry on a sell when Meld supplies none, which is always', async () => {
    // Observed against the sandbox: a SELL session response has no `expiresAt` key at all, ever.
    // So `expires_at` is null on every sell row and the worker's local ceiling is the whole of
    // that row's deadline rather than a floor under a provider one. Pinned here because the rail
    // is where a helpful default would be tempting, and a fabricated expiry on a sell is a
    // deadline this service invented for a seller's on-chain deposit.
    const { stub } = client(async () => ({
      meldSessionId: 'meld-sell-1',
      serviceProviderWidgetUrl: 'https://meldcrypto.com/s/sell',
      meldWidgetUrl: undefined,
      expiresAt: undefined,
    }));

    const session = await new MeldRail(stub).createSession(railSellSessionInput());

    expect(session.expiresAt).toBeUndefined();
  });

  it('maps a neutral quote onto the Meld client and echoes the canonical requested shape', async () => {
    const { stub, quote } = client();
    const rail = new MeldRail(stub);

    const offers = await rail.quote({
      direction: 'buy',
      countryCode: 'US',
      sourceCurrencyCode: 'USD',
      destinationCurrencyCode: 'USDC_ASSETHUB',
      sourceAmount: '20',
      paymentMethodType: 'CREDIT_DEBIT_CARD',
    });

    expect(quote).toHaveBeenCalledWith({
      direction: 'buy',
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
      // Stated on a buy too, not defaulted. The client reads `sessionType` off this field and
      // nothing else, so a buy that failed to name its direction would not silently stay a buy.
      direction: 'buy',
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

  describe('the deposit disclosure', () => {
    it('never surfaces one for a buy, even when the transaction carries the field', async () => {
      // A buy's wallet address is the caller's own, sent before the session opened; there is
      // nothing for a provider to disclose, no matter what the transaction record says.
      const transactionByReference = vi.fn(async () => ({
        id: 'tx-1',
        status: 'SETTLED',
        cryptoDetails: { offrampDestinationWalletAddress: '1SomeAddress' },
      }));
      const rail = new MeldRail({ transactionByReference } as unknown as MeldClient);

      const seen = await rail.observation().finder(recordWith('idem-1'));

      expect(seen).not.toHaveProperty('deposit');
    });

    it('surfaces the address and amount for a sell, from the transaction record', async () => {
      const transactionByReference = vi.fn(async () => ({
        id: 'tx-1',
        status: 'PENDING',
        sourceAmount: '12.3456789012',
        cryptoDetails: { offrampDestinationWalletAddress: '1DepositAddress' },
      }));
      const rail = new MeldRail({ transactionByReference } as unknown as MeldClient);

      const seen = await rail.observation().finder(sellRecord({ client_reference: 'idem-1' }));

      expect(seen?.deposit).toEqual({
        address: '1DepositAddress',
        amount: '12.3456789012',
        // Never read off Meld: the record's own committed asset, pinned before the rail was ever
        // called.
        currency: 'DOT_ASSETHUB',
      });
    });

    it('omits the deposit for a sell until the provider discloses an address', async () => {
      const transactionByReference = vi.fn(async () => ({
        id: 'tx-1',
        status: 'PENDING',
        sourceAmount: '12.3456789012',
        cryptoDetails: { offrampDestinationWalletAddress: null },
      }));
      const rail = new MeldRail({ transactionByReference } as unknown as MeldClient);

      const seen = await rail.observation().finder(sellRecord({ client_reference: 'idem-1' }));

      expect(seen).not.toHaveProperty('deposit');
    });

    it('discloses the address alone, rather than nothing, when Meld reports no amount', async () => {
      // The amount path is unverified; the address must not wait on it. `RailDeposit.amount` is
      // optional for exactly this.
      const transactionByReference = vi.fn(async () => ({
        id: 'tx-1',
        status: 'PENDING',
        sourceAmount: null,
        cryptoDetails: { offrampDestinationWalletAddress: '1DepositAddress' },
      }));
      const rail = new MeldRail({ transactionByReference } as unknown as MeldClient);

      const seen = await rail.observation().finder(sellRecord({ client_reference: 'idem-1' }));

      expect(seen?.deposit).toEqual({ address: '1DepositAddress', currency: 'DOT_ASSETHUB' });
      expect(seen?.deposit).not.toHaveProperty('amount');
    });

    it('omits the deposit for a sell whose transaction carries no cryptoDetails at all', async () => {
      const transactionByReference = vi.fn(async () => ({ id: 'tx-1', status: 'PENDING' }));
      const rail = new MeldRail({ transactionByReference } as unknown as MeldClient);

      const seen = await rail.observation().finder(sellRecord({ client_reference: 'idem-1' }));

      expect(seen).not.toHaveProperty('deposit');
    });
  });
});
