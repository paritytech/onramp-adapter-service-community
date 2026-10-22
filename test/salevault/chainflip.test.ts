import { describe, expect, it, vi } from 'vitest';
import { ChainUnavailableError } from '../../src/salevault/chain.js';
import { ReturnNotSwappableError, ReturnSwapEncoder, minPriceX128 } from '../../src/salevault/chainflip.js';

const VAULT = '0x81949127042930F8e7A1723385A2F76213C72ee9';
const HOME = '0xd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d';
const CFG = {
  rpcUrl: 'https://state-chain.test',
  backendUrl: 'https://swap-backend.test/',
  slippageBps: 200,
  retryBlocks: 100,
};

// Bytes Perseverance's swap backend returned for retry 100 and the vault as refund address, its own broker filled in.
const LIVE_ENCODING =
  '0x016400000081949127042930f8e7a1723385a2f76213c72ee900000000c0669e1c6e4d940ff9e5b1e100000000000000000000000000000000000000009e8d88ae895c9b37b2dead9757a3452f7c2299704d91ddfa444d87723f94fe0c000000';

const environments = (min: string | null, max: string | null): Record<string, unknown> => ({
  cf_ingress_egress_environment: { minimum_deposit_amounts: { Arbitrum: { ETH: '0x0', USDC: min, USDT: '0x0' } } },
  cf_swapping_environment: { maximum_swap_amounts: { Arbitrum: { ETH: null, USDC: max, USDT: null } } },
});

const QUOTES = [
  { type: 'DCA', estimatedPrice: '9.9' },
  { type: 'REGULAR', estimatedPrice: '2.147475' },
];

type Answer = { status?: number; body?: unknown; throws?: Error };

function harness(over: { env?: Record<string, unknown>; quote?: Answer; encode?: Answer } = {}) {
  const env = over.env ?? environments('0x0', '0x5f5e100');
  const rpcMethods: string[] = [];
  const rpc = vi.fn(async (method: string) => {
    rpcMethods.push(method);
    return env[method];
  });
  const answer = (a: Answer, fallback: unknown): Response => {
    if (a.throws !== undefined) throw a.throws;
    return new Response(JSON.stringify(a.body ?? fallback), { status: a.status ?? 200 });
  };
  // The encoder always passes a plain string url.
  const fetchImpl = vi.fn(async (url: string | URL | Request) =>
    typeof url === 'string' && url.includes('/v2/quote')
      ? answer(over.quote ?? {}, QUOTES)
      : answer(over.encode ?? {}, LIVE_ENCODING),
  );
  return { encoder: ReturnSwapEncoder.create(CFG, rpc, fetchImpl), fetchImpl, rpcMethods };
}

const RETURN = { amount: 20_000_000n, home: HOME, refundAddress: VAULT };

describe('minPriceX128', () => {
  it('matches the Chainflip SDK for a live quote at 2% tolerance', () => {
    // The SDK's own encodeVaultSwapData produced this minimum price for the same quote and tolerance.
    expect(minPriceX128('2.147475', 200, 6, 6)).toBe(716133088526654940758721909079949426983n);
  });

  it('scales by 2^128 with no tolerance and shifts by the decimal difference', () => {
    expect(minPriceX128('1.5', 0, 6, 6)).toBe(3n << 127n);
    expect(minPriceX128('1', 0, 6, 18)).toBe((1n << 128n) * 10n ** 12n);
    expect(minPriceX128('1', 0, 18, 6)).toBe((1n << 128n) / 10n ** 12n);
  });

  it('refuses a price that is not a plain decimal', () => {
    expect(() => minPriceX128('1e3', 0, 6, 6)).toThrow(ChainUnavailableError);
  });
});

describe('ReturnSwapEncoder', () => {
  it('quotes the return, then has the backend encode it as the SDK does with no broker set', async () => {
    const { encoder, fetchImpl, rpcMethods } = harness();
    expect(await encoder.returnParameters(RETURN)).toBe(LIVE_ENCODING);
    expect(rpcMethods.sort()).toEqual(['cf_ingress_egress_environment', 'cf_swapping_environment']);

    const [quoteUrl, quoteInit] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(quoteUrl).toBe(
      'https://swap-backend.test/v2/quote?amount=20000000&srcChain=Arbitrum&srcAsset=USDC&destChain=Assethub&destAsset=USDT&isVaultSwap=true',
    );
    expect(quoteInit.redirect).toBe('error');

    const [encodeUrl, encodeInit] = fetchImpl.mock.calls[1] as unknown as [string, RequestInit];
    expect(encodeUrl).toBe('https://swap-backend.test/api/encodeCfParameters');
    expect(encodeInit.method).toBe('POST');
    expect(encodeInit.headers).toEqual({ 'content-type': 'application/json' });
    // No broker account: the backend names its own, which is the SDK's default path.
    expect(JSON.parse(encodeInit.body as string)).toEqual({
      srcAsset: { chain: 'Arbitrum', asset: 'USDC' },
      destAsset: { chain: 'Assethub', asset: 'USDT' },
      srcAddress: VAULT,
      destAddress: HOME,
      amount: '20000000',
      commissionBps: 0,
      fillOrKillParams: {
        retryDurationBlocks: 100,
        refundAddress: VAULT,
        minPriceX128: '716133088526654940758721909079949426983',
        maxOraclePriceSlippage: null,
        refundCcmMetadata: null,
      },
    });
  });

  it('refuses an amount below the minimum deposit, which Chainflip would ignore', async () => {
    const { encoder, fetchImpl } = harness({ env: environments('0x989680', null) });
    await expect(encoder.returnParameters({ ...RETURN, amount: 9_999_999n })).rejects.toThrow(ReturnNotSwappableError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses an amount above the maximum swap, whose excess Chainflip would confiscate', async () => {
    const { encoder } = harness({ env: environments('0x0', '0x5f5e100') });
    await expect(encoder.returnParameters({ ...RETURN, amount: 100_000_001n })).rejects.toThrow(
      /above Chainflip's maximum swap 100000000/,
    );
  });

  it('accepts any amount when there is no maximum and no minimum', async () => {
    const { encoder } = harness({ env: environments(null, null) });
    expect(await encoder.returnParameters({ ...RETURN, amount: 10n ** 12n })).toBe(LIVE_ENCODING);
  });

  it('treats a malformed or missing limit as an unavailable chain', async () => {
    await expect(harness({ env: environments('ten', null) }).encoder.returnParameters(RETURN)).rejects.toThrow(
      ChainUnavailableError,
    );
    const noArbitrum = { cf_ingress_egress_environment: { minimum_deposit_amounts: {} }, cf_swapping_environment: null };
    await expect(harness({ env: noArbitrum }).encoder.returnParameters(RETURN)).rejects.toThrow(/no Arbitrum USDC entry/);
  });

  it('maps a failed, refused or unusable quote to an unavailable chain', async () => {
    await expect(harness({ quote: { status: 502 } }).encoder.returnParameters(RETURN)).rejects.toThrow(
      'chainflip quote returned 502',
    );
    await expect(
      harness({ quote: { body: [{ type: 'DCA', estimatedPrice: '1' }] } }).encoder.returnParameters(RETURN),
    ).rejects.toThrow(/no regular quote/);
    await expect(harness({ quote: { body: { error: 'x' } } }).encoder.returnParameters(RETURN)).rejects.toThrow(
      /no regular quote/,
    );
    await expect(harness({ quote: { throws: new Error('offline') } }).encoder.returnParameters(RETURN)).rejects.toThrow(
      'chainflip quote transport failed: offline',
    );
  });

  it('maps a failed or refused encode to an unavailable chain', async () => {
    await expect(harness({ encode: { status: 400 } }).encoder.returnParameters(RETURN)).rejects.toThrow(
      'chainflip encode returned 400',
    );
    await expect(harness({ encode: { throws: new Error('reset') } }).encoder.returnParameters(RETURN)).rejects.toThrow(
      'chainflip encode transport failed: reset',
    );
  });

  it('maps a backend answer that is not JSON to an unavailable chain', async () => {
    const rpc = vi.fn(async (method: string) => environments('0x0', null)[method]);
    const html = ReturnSwapEncoder.create(CFG, rpc, async () => new Response('<html>proxy</html>', { status: 200 }));
    await expect(html.returnParameters(RETURN)).rejects.toThrow(/chainflip quote answered with a body that is not JSON/);
  });

  it('refuses an encoding that is not hex or does not carry our refund terms', async () => {
    await expect(harness({ encode: { body: 42 } }).encoder.returnParameters(RETURN)).rejects.toThrow(/expected hex/);
    // A V1 envelope whose refund address is not the vault.
    const other = LIVE_ENCODING.replace('81949127042930f8e7a1723385a2f76213c72ee9', '11'.repeat(20));
    await expect(harness({ encode: { body: other } }).encoder.returnParameters(RETURN)).rejects.toThrow(
      /does not carry the requested refund terms/,
    );
  });

  it('builds a default transport and fetch when none is injected', () => {
    expect(ReturnSwapEncoder.create(CFG)).toBeInstanceOf(ReturnSwapEncoder);
  });
});
