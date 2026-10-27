import { describe, expect, it, vi } from 'vitest';

import { SALE_VAULT_PROXY, sellRecord } from '../fixtures.js';
import type { Subject } from '../../src/auth.js';
import { Refusal } from '../../src/contract.js';
import type { PayoutRow, ProxyCallRow, SaleVaultProxyRow } from '../../src/funding/store.js';
import { saleRef, type ClaimerProxyState, type SaleTerms } from '../../src/salevaultproxy/abi.js';
import { ChainUnavailableError } from '../../src/salevaultproxy/chain.js';
import type { BlockedReason, Evaluation, ProxyObservation, SaleObservation } from '../../src/salevaultproxy/keeper.js';
import { SaleVaultProxyService, type SaleVaultProxyServiceKeeper, type SaleVaultProxyServiceStore } from '../../src/salevaultproxy/service.js';
import type { VerifiedSaleVaultProxy } from '../../src/salevaultproxy/verify.js';
import { CLAIMER, FACTORY, HOME, IMPL, PROXY } from './fakes.js';

const NOW = 1_800_000_000_000;
const ALICE: Subject = { productId: 'product', alias: 'alias-abc', proven: true };
const BOB: Subject = { productId: 'product', alias: 'alias-other', proven: true };
const ID = 'funding-1';
const RECIPIENT = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';

const VERIFIED: VerifiedSaleVaultProxy = { ...SALE_VAULT_PROXY, minReturn: 1_000_000n, maxReturn: 100_000_000n };

const ROW: SaleVaultProxyRow = {
  funding_request_id: ID,
  chain_id: 421614,
  factory: FACTORY,
  implementation: IMPL,
  home: HOME,
  claimer: CLAIMER,
  proxy: PROXY,
  ref: saleRef(ID),
  due_at: null,
  last_activity_at: NOW,
  created_at: NOW,
  updated_at: NOW,
};

// An Arbitrum sale whose provider has disclosed its deposit address
const RECORD = sellRecord({ id: ID, destination_currency_code: 'USDC_ARBITRUM', crypto_amount: '50', deposit_address: RECIPIENT.toLowerCase() });

const state = (overrides: Partial<ClaimerProxyState> = {}): ClaimerProxyState => ({
  home: HOME,
  claimer: CLAIMER,
  balance: 0n,
  attempts: 0,
  lastReturnAt: 0n,
  nextReturnAt: 0n,
  releaseAt: BigInt(NOW / 1000 + 86_400),
  releasable: 0n,
  ...overrides,
});

const observed = (o: Partial<ProxyObservation> = {}): ProxyObservation => ({ deployed: true, state: state(), balance: 0n, pending: 0n, retired: false, ...o });

function serviceWith(opts: {
  observation?: ProxyObservation;
  evaluation?: Evaluation;
  sale?: SaleObservation;
  record?: typeof RECORD;
  row?: SaleVaultProxyRow | undefined;
  latest?: ProxyCallRow | undefined;
  payouts?: (PayoutRow & { created_at: number })[];
  verified?: VerifiedSaleVaultProxy | undefined;
  keeper?: SaleVaultProxyServiceKeeper | undefined;
  failure?: Error;
  hold?: BlockedReason;
}) {
  const store: SaleVaultProxyServiceStore = {
    byAlias: vi.fn(async (id: string, alias: string) => (id === ID && alias === ALICE.alias ? (opts.record ?? RECORD) : undefined)),
    readSaleVaultProxy: vi.fn(async () => ('row' in opts ? opts.row : ROW)),
    readLatestProxyCall: vi.fn(async () => opts.latest),
    readPayouts: vi.fn(async () => opts.payouts ?? []),
  };
  const verified = 'verified' in opts ? opts.verified : VERIFIED;
  const keeper: SaleVaultProxyServiceKeeper = {
    observe: vi.fn(async () => {
      if (opts.failure) throw opts.failure;
      return opts.observation ?? observed();
    }),
    observeSale: vi.fn(async () => opts.sale ?? { delivery: undefined, deferred: 0n }),
    claimerBalance: vi.fn(async () => 400_000n),
    trigger: vi.fn(async () => opts.evaluation ?? { observation: opts.observation ?? observed(), blockedReason: null }),
    hold: vi.fn(() => opts.hold),
    verified: () => verified,
    verifiedFor: (chainId: number, factory: string) => (verified?.chainId === chainId && verified.factory === factory ? verified : undefined),
  };
  const service = new SaleVaultProxyService(store, 'keeper' in opts ? opts.keeper : keeper, () => NOW);
  return { service, keeper, store };
}

const refusalOf = async (p: Promise<unknown>): Promise<Refusal> => {
  try {
    await p;
  } catch (error) {
    if (error instanceof Refusal) return error;
    throw error;
  }
  throw new Error('expected a refusal');
};

describe('SaleVaultProxyService.status', () => {
  it('answers a fresh undeployed proxy with the sale terms off its record', async () => {
    const { service, keeper } = serviceWith({ observation: observed({ deployed: false, state: undefined }) });
    expect(await service.status(ALICE, ID)).toEqual({
      fundingRequestId: ID,
      chain: 'arbitrum',
      chainId: 421614,
      factory: '0x1111111111111111111111111111111111111111',
      implementation: '0x2222222222222222222222222222222222222222',
      proxy: '0xfb63126B916e3bD2497702a0139AD2B344aC7536',
      home: HOME,
      claimer: CLAIMER,
      ref: '0xc0615bcc697a20445b853b8779e01ab7c45752dbd7ab43f9c3dc100a83e5b52c',
      deployed: false,
      status: 'none',
      recipient: RECIPIENT,
      committed: '50000000',
      amount: '0',
      leftover: '0',
      balance: '0',
      pending: '0',
      deferred: '0',
      waiting: '0',
      minReturn: '1000000',
      returnable: false,
      attempts: 0,
      nextReturnAt: null,
      releaseAt: null,
      releasable: '0',
      claimerBalance: '400000',
      released: [],
      flushedToClaimer: [],
      blockedReason: null,
      call: null,
    });
    const terms: SaleTerms = { home: HOME, claimer: CLAIMER, ref: saleRef(ID), recipient: RECIPIENT.toLowerCase(), committed: 50_000_000n };
    expect(keeper.observeSale).toHaveBeenCalledWith(ROW, terms, false);
    expect(keeper.claimerBalance).toHaveBeenCalledWith(VERIFIED, ROW.claimer);
  });

  it('names no recipient or committed amount before the deposit address is disclosed', async () => {
    const { service, keeper } = serviceWith({ record: { ...RECORD, deposit_address: undefined } });
    expect(await service.status(ALICE, ID)).toMatchObject({ recipient: null, committed: '0', status: 'none' });
    expect(keeper.observeSale).toHaveBeenCalledWith(ROW, undefined, true);
  });

  it("reports this sale's own record, not the proxy's other sales", async () => {
    const { service } = serviceWith({
      observation: observed({ state: state({ balance: 700_000n, releasable: 700_000n, releaseAt: BigInt(NOW / 1000) }), balance: 700_000n }),
      sale: { delivery: { status: 1, amount: 50_400_000n, leftover: 400_000n }, deferred: 0n },
    });
    expect(await service.status(ALICE, ID)).toMatchObject({
      status: 'paid',
      amount: '50400000',
      leftover: '400000',
      waiting: '700000',
      returnable: false,
      releaseAt: NOW,
      releasable: '700000',
      blockedReason: null,
    });
  });

  it('carries a gas-deferred delivery without counting it returnable', async () => {
    const { service } = serviceWith({ sale: { delivery: undefined, deferred: 50_000_000n } });
    expect(await service.status(ALICE, ID)).toMatchObject({ deferred: '50000000', returnable: false });
  });

  it('answers a balance under the minimum as waiting for its release time', async () => {
    const { service } = serviceWith({ observation: observed({ state: state({ balance: 500_000n }), balance: 500_000n }) });
    expect(await service.status(ALICE, ID)).toMatchObject({ waiting: '500000', releaseAt: NOW + 86_400_000, releasable: '0', blockedReason: 'below-minimum' });
  });

  it('counts a sub-minimum balance before the deploy as waiting', async () => {
    const { service } = serviceWith({ observation: observed({ deployed: false, state: undefined, balance: 300n }) });
    expect(await service.status(ALICE, ID)).toMatchObject({ waiting: '300', releaseAt: null, blockedReason: 'below-minimum' });
  });

  it('answers nothing returnable once retired, the whole balance releasable at once', async () => {
    const { service } = serviceWith({
      observation: observed({ retired: true, state: state({ balance: 5_000_000n, releaseAt: 0n, releasable: 5_000_000n }), balance: 5_000_000n }),
    });
    expect(await service.status(ALICE, ID)).toMatchObject({ returnable: false, releaseAt: 0, releasable: '5000000', blockedReason: null });
  });

  it('answers nothing returnable once out of attempts with release open, as the keeper then releases to the claimer', async () => {
    const { service } = serviceWith({
      observation: observed({ state: state({ attempts: 7, balance: 20_000_000n, releaseAt: 0n, releasable: 20_000_000n }), balance: 20_000_000n }),
    });
    expect(await service.status(ALICE, ID)).toMatchObject({ returnable: false, attempts: 7, releasable: '20000000', blockedReason: null });
    const { service: under } = serviceWith({ observation: observed({ state: state({ attempts: 6, balance: 20_000_000n }), balance: 20_000_000n }) });
    expect(await under.status(ALICE, ID)).toMatchObject({ returnable: true });
    // At the cap a chunk the last return left behind still goes home, the contract keeps release shut
    const { service: kept } = serviceWith({ observation: observed({ state: state({ attempts: 7, balance: 20_000_000n, releasable: 0n }), balance: 20_000_000n }) });
    expect(await kept.status(ALICE, ID)).toMatchObject({ returnable: true });
  });

  it('answers no release time while a returnable balance has none on chain', async () => {
    const { service } = serviceWith({ observation: observed({ state: state({ balance: 20_000_000n, releaseAt: 2n ** 256n - 1n }), balance: 20_000_000n }) });
    expect(await service.status(ALICE, ID)).toMatchObject({ returnable: true, releaseAt: null });
  });

  it('lists releases and refused flushes to the claimer apart, oldest first', async () => {
    const payout = { chain_id: 421614, tx_hash: `0x${'ab'.repeat(32)}`, log_index: 0, factory: FACTORY, home: HOME, claimer: CLAIMER, created_at: NOW };
    const { service } = serviceWith({
      payouts: [
        { ...payout, kind: 'flushed', amount: 4n },
        { ...payout, log_index: 1, kind: 'released', amount: 6n, created_at: NOW + 1 },
      ],
    });
    expect(await service.status(ALICE, ID)).toMatchObject({
      released: [{ amount: '6', txHash: payout.tx_hash, at: NOW + 1 }],
      flushedToClaimer: [{ amount: '4', txHash: payout.tx_hash, at: NOW }],
    });
  });

  it('answers a held sale inside its backoff as returnable but not due', async () => {
    const { service } = serviceWith({
      observation: observed({ state: state({ attempts: 1, nextReturnAt: BigInt(NOW / 1000 + 60), balance: 5_000_000n }), balance: 5_000_000n }),
      sale: { delivery: { status: 2, amount: 5_000_000n, leftover: 0n }, deferred: 0n },
    });
    expect(await service.status(ALICE, ID)).toMatchObject({
      status: 'held',
      returnable: true,
      attempts: 1,
      nextReturnAt: NOW + 60_000,
      blockedReason: 'not-due',
    });
  });

  it('treats pending as returnable with nothing blocking', async () => {
    const { service } = serviceWith({ observation: observed({ deployed: false, state: undefined, pending: 7n }) });
    expect(await service.status(ALICE, ID)).toMatchObject({ pending: '7', returnable: true, blockedReason: null });
  });

  it('carries the latest call, a deliver among them, but never a skim', async () => {
    const call: ProxyCallRow = {
      id: 'c',
      chain_id: 421614,
      sender: '0x9d8a62f656a8d1615c1294fd71e9cfb3e4855a4f',
      target: FACTORY,
      proxy: PROXY,
      action: 'deliver',
      amount: '1',
      nonce: 1,
      tx_hash: '0xabc',
      status: 'mined',
      error: null,
      created_at: NOW,
      updated_at: NOW + 5,
    };
    expect((await serviceWith({ latest: call }).service.status(ALICE, ID))?.call).toEqual({ action: 'deliver', status: 'mined', txHash: '0xabc', at: NOW + 5 });
    expect((await serviceWith({ latest: { ...call, action: 'skim' } }).service.status(ALICE, ID))?.call).toBeNull();
  });

  it('answers undefined for an unknown id or another caller', async () => {
    const { service } = serviceWith({});
    expect(await service.status(ALICE, 'other')).toBeUndefined();
    expect(await service.status(BOB, ID)).toBeUndefined();
  });

  it('refuses a sale with no proxy as 409', async () => {
    const refusal = await refusalOf(serviceWith({ row: undefined }).service.status(ALICE, ID));
    expect(refusal.status).toBe(409);
    expect(refusal.failure).toMatchObject({ value: { code: 'SALE_NOT_VAULT_PROXY' } });
  });

  it('refuses an unverified, unconfigured or unknown deployment as 503', async () => {
    for (const opts of [{ verified: undefined }, { keeper: undefined }, { row: { ...ROW, chain_id: 42161 } }, { row: { ...ROW, factory: IMPL } }]) {
      const { service, keeper } = serviceWith(opts);
      const refusal = await refusalOf(service.status(ALICE, ID));
      expect(refusal.status).toBe(503);
      expect(refusal.failure).toMatchObject({ value: { code: 'SALE_VAULT_PROXY_UNAVAILABLE' } });
      expect(keeper.observe).not.toHaveBeenCalled();
    }
  });

  it('maps an RPC failure to 503 and lets anything else through', async () => {
    const refusal = await refusalOf(serviceWith({ failure: new ChainUnavailableError('down') }).service.status(ALICE, ID));
    expect(refusal.status).toBe(503);
    expect(refusal.failure).toMatchObject({ value: { code: 'SALE_VAULT_PROXY_CHAIN_UNAVAILABLE' } });
    await expect(serviceWith({ failure: new TypeError('bug') }).service.status(ALICE, ID)).rejects.toThrow('bug');
  });

  it('exposes the verified deployment', () => {
    expect(serviceWith({}).service.verified()).toBe(VERIFIED);
    expect(serviceWith({ verified: undefined }).service.verified()).toBeUndefined();
    expect(serviceWith({ keeper: undefined }).service.verified()).toBeUndefined();
  });

  it("serves the keeper's last hold over the static reason, and the static one without a hold", async () => {
    const due = state({ attempts: 1, nextReturnAt: BigInt(NOW / 1000 + 60), balance: 5_000_000n });
    const held = serviceWith({ observation: observed({ state: due, balance: 5_000_000n }), hold: 'vault-changed' });
    expect(await held.service.status(ALICE, ID)).toMatchObject({ returnable: true, blockedReason: 'vault-changed' });
    expect(held.keeper.hold).toHaveBeenCalledWith(ROW.proxy);
    expect(held.keeper.trigger).not.toHaveBeenCalled();
    const unheld = serviceWith({ observation: observed({ state: due, balance: 5_000_000n }) });
    expect(await unheld.service.status(ALICE, ID)).toMatchObject({ blockedReason: 'not-due' });
  });

  it('defaults to the real clock', async () => {
    const { keeper, store } = serviceWith({});
    expect((await new SaleVaultProxyService(store, keeper).status(ALICE, ID))?.blockedReason).toBeNull();
  });
});

describe('SaleVaultProxyService.trigger', () => {
  it('asks the keeper and reports its blocked reason', async () => {
    const { service, keeper } = serviceWith({
      evaluation: { observation: observed({ state: state({ balance: 5_000_000n }), balance: 5_000_000n }), blockedReason: 'not-swappable' },
    });
    expect(await service.trigger(ALICE, ID)).toMatchObject({ returnable: true, blockedReason: 'not-swappable' });
    expect(keeper.trigger).toHaveBeenCalledWith(ROW);
  });

  it("keeps the keeper's explicit nothing-blocking over the static guess", async () => {
    const held = state({ attempts: 1, nextReturnAt: BigInt(NOW / 1000 + 60), balance: 5_000_000n });
    const { service } = serviceWith({ evaluation: { observation: observed({ state: held, balance: 5_000_000n }), blockedReason: null } });
    expect(await service.trigger(ALICE, ID)).toMatchObject({ blockedReason: null });
  });
});
