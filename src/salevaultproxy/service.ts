// The per-sale view a seller's client polls, and the route that asks the keeper to act on its proxy now.

import type { Subject } from '../auth.js';
import { reject, saleVaultProxyUnavailable } from '../contract.js';
import type { FundingStore, PayoutRow, ProxyCallAction, SaleVaultProxyRow } from '../funding/store.js';
import type { SaleTerms } from './abi.js';
import { ChainUnavailableError } from './chain.js';
import { checksum } from './derive.js';
import { saleTerms, type BlockedReason, type Evaluation, type SaleObservation, type SaleVaultProxyKeeper } from './keeper.js';
import type { VerifiedSaleVaultProxy } from './verify.js';

/** USDC that reached the claimer, as one log recorded it. */
export interface PayoutDto {
  amount: string;
  txHash: string;
  /** Epoch ms the keeper read the log. */
  at: number;
}

/** One off-ramp sale on its proxy, as the wire carries it. Amounts are USDC base units as decimal strings. */
export interface OfframpSaleDto {
  fundingRequestId: string;
  chain: string;
  chainId: number;
  factory: string;
  implementation: string;
  /** EIP-55. */
  proxy: string;
  home: string;
  /** EIP-55, where release and a refused flush pay. */
  claimer: string;
  ref: string;
  deployed: boolean;
  /** This sale's own record under its exact terms. */
  status: 'none' | 'paid' | 'held';
  /** The provider's deposit address the sale pays, EIP-55, null until disclosed. */
  recipient: string | null;
  committed: string;
  /** USDC this sale delivered under its own terms. */
  amount: string;
  /** What the provider was not owed on this sale, recorded at pay time. */
  leftover: string;
  balance: string;
  /** The factory's funds-only pending for the home and claimer. */
  pending: string;
  /** This sale's gas-deferred delivery, released by the keeper's deliver. */
  deferred: string;
  /** Proxy balance below the least that can go home, released to the claimer at releaseAt. */
  waiting: string;
  minReturn: string;
  returnable: boolean;
  attempts: number;
  /** Epoch ms, null before the first return since the last delivery. */
  nextReturnAt: number | null;
  /** Epoch ms from which release may run on the current balance, 0 once retired or out of attempts, null before the deploy or with no release time. */
  releaseAt: number | null;
  /** What release would send the claimer now. */
  releasable: string;
  /** The claimer's live USDC balance, what a relay can move off it. */
  claimerBalance: string;
  /** Every release to the claimer the keeper read, oldest first. */
  released: PayoutDto[];
  /** Every pending credit the factory paid the claimer because the proxy refused it, oldest first. */
  flushedToClaimer: PayoutDto[];
  blockedReason: BlockedReason | null;
  call: {
    action: Exclude<ProxyCallAction, 'skim' | 'relay'>;
    status: 'sending' | 'sent' | 'mined' | 'reverted' | 'dropped';
    txHash: string | null;
    at: number;
  } | null;
}

/** The store surface the service reads. */
export type SaleVaultProxyServiceStore = Pick<FundingStore, 'byAlias' | 'readSaleVaultProxy' | 'readLatestProxyCall' | 'readPayouts'>;

/** The keeper surface the service drives. */
export type SaleVaultProxyServiceKeeper = Pick<SaleVaultProxyKeeper, 'trigger' | 'hold' | 'observe' | 'observeSale' | 'claimerBalance' | 'verified' | 'verifiedFor'>;

const STATUS_NAMES = ['none', 'paid', 'held'] as const;

// The contract's releaseAt for a balance with no release time yet
const NO_RELEASE_TIME = 2n ** 256n - 1n;

/** The refusal for a chain read that failed, shared with the relay. */
export const chainUnavailable = (detail: string) =>
  reject(
    { tag: 'Other', value: { code: 'SALE_VAULT_PROXY_CHAIN_UNAVAILABLE', message: 'The sale vault proxy chain could not be read.' } },
    detail,
    503,
  );

type Read = Omit<Evaluation, 'blockedReason'> & { blockedReason: BlockedReason | null | undefined };

export class SaleVaultProxyService {
  constructor(
    private readonly store: SaleVaultProxyServiceStore,
    private readonly keeper: SaleVaultProxyServiceKeeper | undefined,
    private readonly clock: () => number = Date.now,
  ) {}

  /** The configured deployment once verified, or undefined. */
  verified(): VerifiedSaleVaultProxy | undefined {
    return this.keeper?.verified();
  }

  /** The caller's sale, or undefined when the id is unknown or another caller's. Blocked by the keeper's last hold, else what a read tells. */
  async status(subject: Subject, id: string): Promise<OfframpSaleDto | undefined> {
    return this.answer(subject, id, async (keeper, v, row) => ({ observation: await keeper.observe(v, row), blockedReason: keeper.hold(row.proxy) }));
  }

  /** Ask the keeper to act on the caller's sale now, then answer as `status` does. */
  async trigger(subject: Subject, id: string): Promise<OfframpSaleDto | undefined> {
    return this.answer(subject, id, (keeper, _v, row) => keeper.trigger(row));
  }

  private async answer(
    subject: Subject,
    id: string,
    read: (keeper: SaleVaultProxyServiceKeeper, v: VerifiedSaleVaultProxy, row: SaleVaultProxyRow) => Promise<Read>,
  ): Promise<OfframpSaleDto | undefined> {
    const record = await this.store.byAlias(id, subject.alias, subject.productId);
    if (record === undefined) return undefined;
    const row = await this.store.readSaleVaultProxy(record.id);
    if (row === undefined) {
      throw reject(
        { tag: 'Other', value: { code: 'SALE_NOT_VAULT_PROXY', message: 'This sale does not pay through a sale vault proxy.' } },
        `funding request ${record.id} has no sale vault proxy`,
        409,
      );
    }
    // A row of a retired deployment is still served, judged by its own verified terms
    const v = this.keeper?.verifiedFor(row.chain_id, row.factory);
    if (this.keeper === undefined || v === undefined) {
      throw saleVaultProxyUnavailable(`sale vault proxy deployment ${row.factory} on chain ${String(row.chain_id)} is not verified`);
    }
    const terms = saleTerms({ ...row, deposit_address: record.deposit_address, crypto_amount: record.crypto_amount });
    let evaluation: Read;
    let sale: SaleObservation;
    let claimerBalance: bigint;
    try {
      evaluation = await read(this.keeper, v, row);
      [sale, claimerBalance] = await Promise.all([this.keeper.observeSale(row, terms, evaluation.observation.deployed), this.keeper.claimerBalance(v, row.claimer)]);
    } catch (error) {
      if (error instanceof ChainUnavailableError) throw chainUnavailable(error.message);
      throw error;
    }
    const [latest, payouts] = await Promise.all([this.store.readLatestProxyCall(row.chain_id, row.proxy), this.store.readPayouts(row)]);
    const call =
      latest === undefined || latest.action === 'skim' || latest.action === 'relay'
        ? null
        : { action: latest.action, status: latest.status, txHash: latest.tx_hash, at: latest.updated_at };
    return toDto(row, v, evaluation, sale, terms, this.clock(), call, payouts, claimerBalance);
  }
}

// The DTO maths: what is returnable, waiting and releasable
function toDto(
  row: SaleVaultProxyRow,
  v: VerifiedSaleVaultProxy,
  e: Read,
  sale: SaleObservation,
  terms: SaleTerms | undefined,
  now: number,
  call: OfframpSaleDto['call'],
  payouts: readonly (PayoutRow & { created_at: number })[],
  claimerBalance: bigint,
): OfframpSaleDto {
  const { state, balance, pending, deployed, retired } = e.observation;
  const { delivery } = sale;
  const waiting = balance < v.minReturn ? balance : 0n;
  // Deferred is not counted, the keeper delivers it, and nothing goes home once retired or out of attempts with release open
  const open = state !== undefined && BigInt(state.attempts) >= v.releaseAttempts && state.releasable > 0n;
  const returnable = !retired && (pending > 0n || (balance >= v.minReturn && !open));
  const payoutsOf = (kind: PayoutRow['kind']): PayoutDto[] =>
    payouts.filter((p) => p.kind === kind).map((p) => ({ amount: p.amount.toString(), txHash: p.tx_hash, at: p.created_at }));
  return {
    fundingRequestId: row.funding_request_id,
    chain: v.chain,
    chainId: row.chain_id,
    factory: checksum(row.factory),
    implementation: checksum(row.implementation),
    proxy: checksum(row.proxy),
    home: row.home,
    claimer: checksum(row.claimer),
    ref: row.ref,
    deployed,
    status: STATUS_NAMES[delivery?.status ?? 0],
    recipient: terms === undefined ? null : checksum(terms.recipient),
    committed: (terms?.committed ?? 0n).toString(),
    amount: (delivery?.amount ?? 0n).toString(),
    leftover: (delivery?.leftover ?? 0n).toString(),
    balance: balance.toString(),
    pending: pending.toString(),
    deferred: sale.deferred.toString(),
    waiting: waiting.toString(),
    minReturn: v.minReturn.toString(),
    returnable,
    attempts: state?.attempts ?? 0,
    nextReturnAt: state === undefined || state.attempts === 0 ? null : Number(state.nextReturnAt) * 1000,
    releaseAt: state === undefined || state.releaseAt === NO_RELEASE_TIME ? null : Number(state.releaseAt) * 1000,
    releasable: (state?.releasable ?? 0n).toString(),
    claimerBalance: claimerBalance.toString(),
    released: payoutsOf('released'),
    flushedToClaimer: payoutsOf('flushed'),
    blockedReason: e.blockedReason === undefined ? staticBlock(e.observation, returnable, waiting, now) : e.blockedReason,
    call,
  };
}

// The block a read-only status can tell without pricing a return
function staticBlock(o: Evaluation['observation'], returnable: boolean, waiting: bigint, now: number): BlockedReason | null {
  // A balance the contract releases now is not blocked, the keeper sends it to the claimer
  if (!returnable) return waiting > 0n && (o.state?.releasable ?? 0n) === 0n ? 'below-minimum' : null;
  if (o.pending === 0n && o.state !== undefined && BigInt(Math.floor(now / 1000)) < o.state.nextReturnAt) return 'not-due';
  return null;
}
