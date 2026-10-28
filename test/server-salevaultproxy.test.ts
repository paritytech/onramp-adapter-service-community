import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { reject } from '../src/contract.js';
import { buildServer } from '../src/server.js';
import type { SaleVaultProxyRelay } from '../src/salevaultproxy/relay.js';
import type { OfframpSaleDto, SaleVaultProxyService } from '../src/salevaultproxy/service.js';
import type { VerifiedSaleVaultProxy } from '../src/salevaultproxy/verify.js';
import { config } from './fixtures.js';

const DEV_HEADERS = { 'x-dev-product-id': 'app.dot' };
const ID = '11111111-1111-4111-8111-111111111111';

const VERIFIED: VerifiedSaleVaultProxy = {
  chain: 'arbitrum',
  chainId: 421614,
  factory: '0xfb63126b916e3bd2497702a0139ad2b344ac7536',
  implementation: '0x2222222222222222222222222222222222222222',
  vault: '0x2bb150e6d4366a1bdbc4275d1f35892cd63f27e3',
  usdc: '0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d',
  broker: `0x${'9e'.repeat(32)}`,
  homeChain: 6n,
  homeToken: 12n,
  retryBlocks: 100,
  minReturn: 1_000_000n,
  maxReturn: 100_000_000n,
  priceFloorBps: 9_900n,
  feeAllowance: 50_000n,
  returnCooldown: 900n,
  releaseDelay: 86_400n,
  releaseAttempts: 7n,
  staleDelay: 5_184_000n,
  guardian: '0x5555555555555555555555555555555555555555',
};

const SALE = { fundingRequestId: ID, status: 'held', returnable: true } as unknown as OfframpSaleDto;

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

const serve = async (saleVaultProxy?: Partial<SaleVaultProxyService>, relay?: Partial<SaleVaultProxyRelay>) => {
  app = await buildServer(
    config(),
    () =>
      ({
        offrampCorridors: async () => [],
      }) as never,
    undefined,
    undefined,
    saleVaultProxy as SaleVaultProxyService | undefined,
    relay as SaleVaultProxyRelay | undefined,
  );
  return app;
};

describe('the sale vault proxy routes', () => {
  it('carry the verified deployment on the corridors payload, checksummed, and nothing when unverified', async () => {
    const verified = await serve({ verified: () => VERIFIED });
    const ok = await verified.inject({ method: 'GET', url: '/supported/offramp/corridors', headers: DEV_HEADERS });
    expect(ok.json()).toEqual({
      corridors: [],
      saleVaultProxy: {
        chain: 'arbitrum',
        chainId: 421614,
        factory: '0xfb63126B916e3bD2497702a0139AD2B344aC7536',
        implementation: '0x2222222222222222222222222222222222222222',
      },
    });
    await app?.close();
    const unverified = await serve({ verified: () => undefined });
    expect((await unverified.inject({ method: 'GET', url: '/supported/offramp/corridors', headers: DEV_HEADERS })).json()).toEqual({
      corridors: [],
    });
    await app?.close();
    const absent = await serve();
    expect((await absent.inject({ method: 'GET', url: '/supported/offramp/corridors', headers: DEV_HEADERS })).json()).toEqual({
      corridors: [],
    });
  });

  it('GET /offramp/sale/:id answers the sale, 404 for an unknown one', async () => {
    const status = vi.fn(async (_subject: unknown, id: string) => (id === ID ? SALE : undefined));
    const built = await serve({ status });
    const ok = await built.inject({ method: 'GET', url: `/offramp/sale/${ID}`, headers: DEV_HEADERS });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ sale: SALE });
    expect(status).toHaveBeenCalledWith(expect.objectContaining({ productId: 'app.dot' }), ID);
    const missing = await built.inject({ method: 'GET', url: '/offramp/sale/other', headers: DEV_HEADERS });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ error: { value: { code: 'NOT_FOUND' } } });
  });

  it('POST /offramp/returns/:id triggers the keeper, body-less, 404 for an unknown one', async () => {
    const trigger = vi.fn(async (_subject: unknown, id: string) => (id === ID ? SALE : undefined));
    const built = await serve({ trigger });
    const ok = await built.inject({
      method: 'POST',
      url: `/offramp/returns/${ID}`,
      headers: { ...DEV_HEADERS, 'content-type': 'application/json' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ sale: SALE });
    expect((await built.inject({ method: 'POST', url: '/offramp/returns/other', headers: DEV_HEADERS })).statusCode).toBe(404);
  });

  it('serves no release route, the keeper releases on its own', async () => {
    const built = await serve({ trigger: vi.fn() });
    expect((await built.inject({ method: 'POST', url: `/offramp/release/${ID}`, headers: DEV_HEADERS })).statusCode).toBe(404);
  });

  it('pass the service refusals through, 409 and 503', async () => {
    const built = await serve({
      status: async () => {
        throw reject({ tag: 'Other', value: { code: 'SALE_NOT_VAULT_PROXY', message: 'x' } }, 'no proxy', 409);
      },
      trigger: async () => {
        throw reject({ tag: 'Other', value: { code: 'SALE_VAULT_PROXY_CHAIN_UNAVAILABLE', message: 'x' } }, 'down', 503);
      },
    });
    const notProxy = await built.inject({ method: 'GET', url: `/offramp/sale/${ID}`, headers: DEV_HEADERS });
    expect(notProxy.statusCode).toBe(409);
    expect(notProxy.json()).toMatchObject({ error: { value: { code: 'SALE_NOT_VAULT_PROXY' } } });
    const down = await built.inject({ method: 'POST', url: `/offramp/returns/${ID}`, headers: DEV_HEADERS });
    expect(down.statusCode).toBe(503);
  });

  it('answer 503 when the service is not wired, and need a caller', async () => {
    const built = await serve();
    for (const [method, url] of [['GET', `/offramp/sale/${ID}`], ['POST', `/offramp/returns/${ID}`]] as const) {
      const response = await built.inject({ method, url, headers: DEV_HEADERS });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ error: { value: { code: 'SALE_VAULT_PROXY_UNAVAILABLE' } } });
      expect((await built.inject({ method, url })).statusCode).toBeGreaterThanOrEqual(400);
    }
  });

  it('POST /offramp/relay parses the body and answers 202 with the broadcast', async () => {
    const body = {
      from: '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A',
      to: '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc',
      value: '1500000',
      validAfter: '0',
      validBefore: '1900000000',
      nonce: `0x${'cd'.repeat(32)}`,
      signature: `0x${'11'.repeat(64)}1b`,
    };
    const relay = vi.fn(async () => ({ status: 'sent' as const, chainId: 421614, txHash: '0xabc' }));
    const built = await serve(undefined, { relay });
    const ok = await built.inject({ method: 'POST', url: '/offramp/relay', headers: DEV_HEADERS, payload: body });
    expect(ok.statusCode).toBe(202);
    expect(ok.json()).toEqual({ relay: { status: 'sent', chainId: 421614, txHash: '0xabc' } });
    expect(relay).toHaveBeenCalledWith(expect.objectContaining({ productId: 'app.dot' }), { ...body, from: body.from.toLowerCase() });
    const malformed = await built.inject({ method: 'POST', url: '/offramp/relay', headers: DEV_HEADERS, payload: { ...body, value: '0' } });
    expect(malformed.statusCode).toBe(400);
    // Not a whole number or a short mixed-case address answers 400, never a thrown refine
    for (const bad of [{ value: '1.5' }, { value: 'abc' }, { validAfter: '1.5' }, { to: '0xAb' }]) {
      const refused = await built.inject({ method: 'POST', url: '/offramp/relay', headers: DEV_HEADERS, payload: { ...body, ...bad } });
      expect(refused.statusCode).toBe(400);
      expect(refused.json()).toMatchObject({ error: { value: { code: 'MALFORMED_REQUEST' } } });
    }
    expect(relay).toHaveBeenCalledTimes(1);
    await app?.close();
    const unwired = await serve();
    const absent = await unwired.inject({ method: 'POST', url: '/offramp/relay', headers: DEV_HEADERS, payload: body });
    expect(absent.statusCode).toBe(503);
    expect(absent.json()).toMatchObject({ error: { value: { code: 'SALE_VAULT_PROXY_UNAVAILABLE' } } });
  });
});
