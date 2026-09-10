import { describe, expect, it } from 'vitest';

import { ChainflipRail } from '../../src/chainflip/rail.js';
import { Refusal } from '../../src/contract.js';
import { railSessionInput } from '../fixtures.js';

const railInput = () => railSessionInput({ destinationCode: 'DOT_ASSETHUB' });

const failureOf = async (fn: () => Promise<unknown>): Promise<Refusal | undefined> => {
  try {
    await fn();
  } catch (error) {
    if (error instanceof Refusal) return error;
    throw error;
  }
  return undefined;
};

describe('ChainflipRail identity', () => {
  it('names itself chainflip, which is what a refusal is filed under', () => {
    // Mutating the provider to `'meld'` survived the suite: the registry is keyed by hardcoded
    // literals so lookup still worked, but `Onramp` then wrote `rail: 'meld'` onto the durable
    // refused row and the audit event, attributing one rail's refusal to another.
    expect(new ChainflipRail().provider).toBe('chainflip');
  });
});

describe('ChainflipRail', () => {
  it('refuses a session rather than send an asset mapping that does not exist', async () => {
    // Chainflip swaps on-chain assets and has no fiat leg, so a card purchase in USD has no
    // correct `sourceAsset`. The previous version sent the fiat code, a two-decimal fiat string
    // as a chain amount, and Meld's catalog code as the destination: every value wrong, on the
    // money path. Refusing is the only honest answer until a fiat front-end design exists.
    const refusal = await failureOf(() => new ChainflipRail().createSession(railInput()));

    expect(refusal?.failure).toEqual({
      tag: 'Other',
      value: { code: 'RAIL_REFUSED', message: 'The funding rail refused this request.' },
    });
    expect(refusal?.message).toContain('no fiat leg');
  });

  it('refuses a quote: the price is set on-chain at swap time, not quotable here', async () => {
    const refusal = await failureOf(() =>
      new ChainflipRail().quote({
        countryCode: 'US',
        sourceCurrencyCode: 'USD',
        destinationCurrencyCode: 'USDC_ASSETHUB',
        sourceAmount: '20',
        paymentMethodType: 'CREDIT_DEBIT_CARD',
      }),
    );

    expect(refusal?.failure.tag).toBe('NoQuotesAvailable');
  });
});
