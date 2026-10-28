// The sale vault proxy keeper: the only signer of operator transactions, serialized in process and across replicas.

import type { DeferralRow, FundingStore, KeeperCandidate, KeeperRows, PayoutRow, ProxyCallAction, ProxyCallRow, WatchedProxy } from '../funding/store.js';
import { toBaseUnits, USDC_AMOUNT, USDC_DECIMALS } from '../money.js';
import {
  addressTopic,
  decodeAddress,
  decodeBytes32,
  decodeDeferral,
  decodePendingFlushed,
  decodeShortString,
  decodeUint,
  encodeCall,
  encodeClaimerTermsCall,
  encodeHomeClaimerCall,
  encodeRelease,
  eventTopic,
  EVM_ADDRESS,
  topicAddress,
  type ClaimerProxyState,
  type RawLog,
  type SaleDelivery,
  type SaleTerms,
} from './abi.js';
import { CallRevertedError, ChainUnavailableError, toMessage, type SaleVaultProxyChain } from './chain.js';
import type { FailedCallSource } from './failed-calls.js';
import { proxyMinOut, returnChunk, ReturnNotSwappableError, type ReturnLimits, type ReturnRefusal } from './limits.js';
import type { KeeperSigner } from './signer.js';
import {
  SaleVaultProxyMisconfigured,
  verifyDeployment,
  verifyWindow,
  type SaleVaultProxyDeploymentConfig,
  type VerifiedSaleVaultProxy,
} from './verify.js';

/** The store surface the keeper works through. */
export type KeeperStore = Pick<FundingStore, 'withKeeperLock' | 'keeperRows'>;

/** Keeper tuning, amounts already in base units. */
export interface KeeperSettings {
  readonly intervalMs: number;
  readonly batch: number;
  readonly resendMs: number;
  /** The most blocks one log read spans. */
  readonly logRange: number;
  /** USDC base units. */
  readonly minSkim: bigint;
  /** Wei. */
  readonly minEth: bigint;
  readonly quoteMarginBps: number;
}

export type KeeperLog = (level: 'info' | 'warn' | 'error', message: string) => void;

/** What the keeper read off one proxy. */
export interface ProxyObservation {
  readonly deployed: boolean;
  /** Undefined until the proxy is deployed. */
  readonly state: ClaimerProxyState | undefined;
  readonly balance: bigint;
  /** The factory's funds-only pending for the home and claimer. */
  readonly pending: bigint;
  /** Whether the factory is retired, which stops every return home. */
  readonly retired: boolean;
}

/** What the keeper read off one sale on its proxy. */
export interface SaleObservation {
  /** Undefined before the proxy exists or the sale's terms are known. */
  readonly delivery: SaleDelivery | undefined;
  /** The factory's gas-deferred amount under this sale's exact terms. */
  readonly deferred: bigint;
}

/** Why a proxy holding USDC is not being returned or released right now. */
export type BlockedReason = 'not-due' | 'below-minimum' | ReturnRefusal | 'vault-changed' | 'chain-unavailable';

/** The outcome of evaluating one proxy. */
export interface Evaluation {
  readonly observation: ProxyObservation;
  readonly blockedReason: BlockedReason | null;
}

interface Decision {
  readonly action: ProxyCallAction;
  readonly target: string;
  readonly data: string;
  readonly amount: bigint | null;
  /** Sent instead when this one would revert. */
  readonly fallback?: Decision;
}

interface Judgement {
  readonly decision: Decision | undefined;
  readonly blockedReason: BlockedReason | null;
  /** When to look again in epoch ms, null to wait for a log. */
  readonly dueAt: number | null;
}

// What a send did: broadcast, refused by an estimate revert, left to a call already in flight, or left to the lock holder
export type SendOutcome = 'sent' | 'reverted' | 'skipped' | 'locked';

/** A retired deployment whose proxies are still watched and served, verified against its own Vault and USDC. */
export type RetiredDeployment = Pick<SaleVaultProxyDeploymentConfig, 'factory' | 'vault' | 'usdc'>;

const DELIVERY_PENDING = eventTopic('DeliveryPending(bytes32,address,bytes32,uint256,bytes32)');
const DELIVERY_UNBOOKED = eventTopic('DeliveryUnbooked(bytes32,address,bytes32,address,uint256)');
const DELIVERY_DEFERRED = eventTopic('DeliveryDeferred(bytes32,address,bytes32,address,uint256,uint256,uint256)');
const DEFERRED_EXPIRED = eventTopic('DeferredExpired(bytes32,address,bytes32,address,uint256,uint256,uint256)');
const PENDING_FLUSHED = eventTopic('PendingFlushed(bytes32,address,address,uint256)');
// Factory logs that move USDC for a home, each with the home as its first indexed topic
const FACTORY_TOPICS = [
  eventTopic('Delivered(bytes32,address,bytes32,address,address,uint256,uint256)'),
  DELIVERY_DEFERRED,
  DELIVERY_PENDING,
  DELIVERY_UNBOOKED,
  DEFERRED_EXPIRED,
  PENDING_FLUSHED,
];
// USDC the factory could not book to any home, which a skim sends to the treasury
const UNATTRIBUTED = eventTopic('Unattributed(address,uint256,bytes32)');
// The guardian stopped every return home for good
const RETIRED = eventTopic('Retired()');
// A proxy paid its whole balance to its claimer
const RELEASED = eventTopic('Released(uint256)');
const TRANSFER_TOPIC = eventTopic('Transfer(address,address,uint256)');
// Proxies per Transfer log read, well under the 1000 selectors the public Arbitrum RPCs allow
export const PROXY_TOPIC_CHUNK = 100;

/** A sale's on-chain terms off its funding row: the provider's deposit address and the committed USDC. */
export function saleTerms(sale: KeeperCandidate): SaleTerms | undefined {
  if (sale.deposit_address === undefined || !EVM_ADDRESS.test(sale.deposit_address)) return undefined;
  if (sale.crypto_amount === undefined || !USDC_AMOUNT.test(sale.crypto_amount)) return undefined;
  return {
    home: sale.home,
    claimer: sale.claimer,
    ref: sale.ref,
    recipient: sale.deposit_address.toLowerCase(),
    committed: toBaseUnits(sale.crypto_amount, USDC_DECIMALS),
  };
}

const minOf = (a: bigint, b: bigint): bigint => (a < b ? a : b);
const maxOf = (a: bigint, b: bigint): bigint => (a > b ? a : b);

// A Transfer log's value, zero when unreadable so the proxy is still made due but never kept watched
function transferValue(log: RawLog): bigint {
  try {
    return decodeUint(log.data);
  } catch {
    return 0n;
  }
}
const seconds = (ms: number): bigint => BigInt(Math.floor(ms / 1000));

export interface KeeperDeps {
  readonly deployment: SaleVaultProxyDeploymentConfig;
  readonly retired: readonly RetiredDeployment[];
  readonly chain: SaleVaultProxyChain;
  readonly signer: KeeperSigner;
  readonly limits: ReturnLimits;
  readonly failedCalls: FailedCallSource;
  readonly store: KeeperStore;
  readonly settings: KeeperSettings;
  readonly log: KeeperLog;
  readonly clock?: () => number;
  readonly newId?: () => string;
}

export class SaleVaultProxyKeeper {
  // Identity-verified deployments by factory, the configured one and every retired one that proved out
  private readonly deployments = new Map<string, VerifiedSaleVaultProxy>();
  // Whether the configured deployment still fits Chainflip's live route and window, which gates new sells only
  private windowFits = false;
  // Whether the chain left a deployment unverified on the last verify, so the shared log cursor waits for it
  private unanswered = false;
  // The signing queue, so two sends never read one nonce
  private queue: Promise<unknown> = Promise.resolve();
  // The lock-holding rows while a pass runs, so a send during the pass reuses its lock
  private session: KeeperRows | undefined;
  private inFlight: Promise<void> | undefined;
  private timer: NodeJS.Timeout | undefined;
  // Whether the last scan stopped short of the head, so the loop runs the next pass at once
  private behind = false;
  // Failed CCMs already alerted, by broadcast and epoch, so a re-signed payload alerts again
  private readonly failedAlerted = new Set<string>();
  // The last repeating alert logged per key, so a condition that holds every pass logs once until it changes
  private readonly alerted = new Map<string, string>();
  // The latest hold per proxy a status read cannot tell itself, in memory since every pass judges a held proxy again
  private readonly holds = new Map<string, BlockedReason>();
  private readonly clock: () => number;
  private readonly newId: () => string;

  constructor(private readonly deps: KeeperDeps) {
    this.clock = deps.clock ?? Date.now;
    this.newId = deps.newId ?? (() => crypto.randomUUID());
  }

  /** The configured deployment once verified and fitting Chainflip's live window, the one new sells use. */
  verified(): VerifiedSaleVaultProxy | undefined {
    return this.windowFits ? this.current() : undefined;
  }

  /** The configured deployment once identity-verified, open to new sells or not, which a claimer's relay still needs after a retire. */
  current(): VerifiedSaleVaultProxy | undefined {
    return this.deployments.get(this.deps.deployment.factory.toLowerCase());
  }

  /** An identity-verified deployment, current or retired, by its chain and factory. */
  verifiedFor(chainId: number, factory: string): VerifiedSaleVaultProxy | undefined {
    const v = this.deployments.get(factory.toLowerCase());
    return v?.chainId === chainId ? v : undefined;
  }

  /** Verify every deployment not yet verified, then whether the configured one still takes new sells. A mismatch or outage is logged and leaves it unavailable, never thrown. */
  async verify(): Promise<boolean> {
    const configs = [this.deps.deployment, ...this.deps.retired.map((r) => ({ ...this.deps.deployment, ...r }))];
    let unanswered = false;
    for (const cfg of configs) {
      if (this.deployments.has(cfg.factory.toLowerCase())) continue;
      const outcome = await this.verifying(cfg.factory, 'unavailable', async () => {
        const v = await verifyDeployment(cfg, this.deps.chain, this.deps.limits);
        // The guardian can stop every return, so it is never the hot key that pays for them
        if (v.guardian === this.deps.signer.address.toLowerCase()) throw new SaleVaultProxyMisconfigured(`sale_vault_proxy: factory guardian ${v.guardian} is the keeper key`);
        this.deployments.set(v.factory, v);
      });
      if (outcome === 'unavailable') unanswered = true;
    }
    this.unanswered = unanswered;
    const current = this.current();
    if (current !== undefined) {
      // Read again on every call, so a retire or Chainflip's drift closes new sells without a restart
      const outcome = await this.verifying(current.factory, 'closed to new sells', async () => {
        if (await this.deps.chain.retired(current.factory)) throw new SaleVaultProxyMisconfigured(`sale_vault_proxy: factory ${current.factory} is retired`);
        await verifyWindow(current, this.deps.limits);
      });
      // An outage keeps the last answer rather than closing sells on a blip
      if (outcome !== 'unavailable') this.windowFits = outcome === 'ok';
    }
    return this.verified() !== undefined;
  }

  /** Log an error once when the keeper cannot afford gas, again after a refill. Run at boot and on every pass. */
  async checkGasFunds(): Promise<void> {
    try {
      const balance = await this.deps.chain.nativeBalance(this.deps.signer.address);
      if (balance >= this.deps.settings.minEth) {
        this.alerted.delete('gas');
        return;
      }
      this.alertOnce(
        'gas',
        'low',
        'error',
        `sale vault proxy keeper ${this.deps.signer.address} holds ${balance.toString()} wei, below keeper.min_eth ${this.deps.settings.minEth.toString()}`,
      );
    } catch (error) {
      this.deps.log('warn', `sale vault proxy keeper balance unreadable: ${toMessage(error)}`);
    }
  }

  /** Start the interval with a first pass now, skipping a tick while a pass is in flight. */
  start(): void {
    this.tick(() => this.pass());
  }

  /** Verify now and on the interval, for a deployment whose keeper loop is off, so new sells still follow a retire or Chainflip's window. */
  startVerifying(): void {
    this.tick(async () => {
      await this.verify();
    });
  }

  /** Stop the interval and wait a bounded time for work already running. */
  async stop(graceMs = 5_000): Promise<void> {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    if (graceMs <= 0) return;
    let timeout: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.all([this.inFlight, this.queue]),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, graceMs);
      }),
    ]);
    clearTimeout(timeout);
  }

  /** One full pass under the advisory lock, every query on the locking connection. Skipped when another replica holds it. */
  async pass(): Promise<void> {
    // Only a scan that read its ranges and stopped short sets it, so a skipped or failed pass waits the interval
    this.behind = false;
    await this.deps.store.withKeeperLock(async (rows) => {
      this.session = rows;
      try {
        await this.passLocked(rows);
      } finally {
        // Sends queued meanwhile reuse this lock, so every one finishes before it is released
        let drained: Promise<unknown>;
        do {
          drained = this.queue;
          await drained;
        } while (drained !== this.queue);
        this.session = undefined;
      }
    });
  }

  /** Evaluate and act on one sale's proxy now, without waiting for a pass. Only the send is serialized. */
  async trigger(sale: Pick<KeeperCandidate, 'chain_id' | 'proxy'>): Promise<Evaluation> {
    const rows = this.deps.store.keeperRows();
    return this.evaluate(rows, await rows.salesOfProxy(sale.chain_id, sale.proxy), true);
  }

  /** Why the last judgement held this proxy back, undefined when nothing holds it or the reason is one a read tells itself. */
  hold(proxy: string): BlockedReason | undefined {
    return this.holds.get(proxy.toLowerCase());
  }

  /** Read a proxy's on-chain position without acting. */
  async observe(v: VerifiedSaleVaultProxy, sale: Pick<KeeperCandidate, 'factory' | 'proxy' | 'home' | 'claimer'>): Promise<ProxyObservation> {
    const { chain } = this.deps;
    const [state, pending, retired] = await Promise.all([
      chain.proxyState(sale.proxy),
      chain.pending(sale.factory, sale.home, sale.claimer),
      chain.retired(sale.factory),
    ]);
    // Before the deploy USDC can still sit at the address
    const balance = state?.balance ?? (await chain.usdcBalance(v.usdc, sale.proxy));
    return { deployed: state !== undefined, state, balance, pending, retired };
  }

  /** A claimer's live USDC balance in the deployment's own USDC. */
  async claimerBalance(v: VerifiedSaleVaultProxy, claimer: string): Promise<bigint> {
    return this.deps.chain.usdcBalance(v.usdc, claimer);
  }

  /** Read one sale's record and deferred amount over every logged deadline, zero while its terms are unknown. */
  async observeSale(
    sale: Pick<KeeperCandidate, 'chain_id' | 'factory' | 'proxy'>,
    terms: SaleTerms | undefined,
    deployed: boolean,
  ): Promise<SaleObservation> {
    if (terms === undefined) return { delivery: undefined, deferred: 0n };
    const [delivery, deferrals] = await Promise.all([
      deployed ? this.deps.chain.delivery(sale.proxy, terms) : Promise.resolve(undefined),
      this.deferrals(this.deps.store.keeperRows(), sale, terms),
    ]);
    return { delivery, deferred: deferrals.reduce((sum, d) => sum + d.amount, 0n) };
  }

  // The factory's deferred amount under each deadline the logs recorded for these exact terms
  private async deferrals(
    rows: KeeperRows,
    sale: Pick<KeeperCandidate, 'chain_id' | 'factory'>,
    terms: SaleTerms,
  ): Promise<{ deadline: bigint; amount: bigint }[]> {
    const deadlines = await rows.deferralDeadlines({ chain_id: sale.chain_id, factory: sale.factory, ...terms });
    return Promise.all(
      deadlines.map(async (deadline) => ({ deadline, amount: await this.deps.chain.pendingDelivery(sale.factory, terms, deadline) })),
    );
  }

  // Run one verification step, logging a mismatch as an error and an outage as a warning, each once until it changes
  private async verifying(factory: string, outcome: string, step: () => Promise<void>): Promise<'ok' | 'misconfigured' | 'unavailable'> {
    const key = `verify:${factory}:${outcome}`;
    try {
      await step();
      this.alerted.delete(key);
      return 'ok';
    } catch (error) {
      if (error instanceof SaleVaultProxyMisconfigured) {
        this.alertOnce(key, error.message, 'error', `sale vault proxy ${factory} is ${outcome}: ${error.message}`);
        return 'misconfigured';
      }
      if (error instanceof ChainUnavailableError) {
        this.alertOnce(key, error.message, 'warn', `sale vault proxy ${factory} is unverified, the chain did not answer: ${error.message}`);
        return 'unavailable';
      }
      throw error;
    }
  }

  // Log a repeating condition once per distinct `id` under `key`
  private alertOnce(key: string, id: string, level: 'info' | 'warn' | 'error', message: string): void {
    if (this.alerted.get(key) === id) return;
    this.alerted.set(key, id);
    this.deps.log(level, message);
  }

  // Run `work` on the interval, never two at once
  private tick(work: () => Promise<void>): void {
    const run = (): void => {
      if (this.inFlight !== undefined) return;
      this.inFlight = work()
        .catch((error: unknown) => {
          this.deps.log('warn', `sale vault proxy keeper pass failed: ${toMessage(error)}`);
        })
        .finally(() => {
          this.inFlight = undefined;
          // A catch-up keeps its pace, each pass still verifying first
          if (this.behind && this.timer !== undefined) run();
        });
    };
    this.timer = setInterval(run, this.deps.settings.intervalMs);
    this.timer.unref();
    run();
  }

  // A promise chain, so two sends never interleave
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async passLocked(rows: KeeperRows): Promise<void> {
    await this.checkGasFunds();
    await this.verify();
    // Existing sales are served while any deployment is identity-verified, whatever Chainflip's window says
    if (this.deployments.size === 0) return;
    const { chainId } = this.deps.deployment;
    const factories = [...this.deployments.keys()];
    // Watched as long as only the keeper sends a proxy home, the longest STALE_DELAY of any verified deployment
    const watchSeconds = [...this.deployments.values()].reduce((longest, v) => (v.staleDelay > longest ? v.staleDelay : longest), 0n);
    const sinceMs = this.clock() - Number(watchSeconds) * 1000;
    await this.settleInflight(rows, chainId);
    // One cursor serves every factory, so it never moves past blocks an unverified one has not read
    if (!this.unanswered) {
      try {
        await this.scan(rows, chainId, factories, sinceMs);
      } catch (error) {
        // Due proxies are still judged, the cursor stays for the next pass
        this.behind = false;
        this.deps.log('warn', `sale vault proxy log scan failed: ${toMessage(error)}`);
      }
    }
    try {
      await this.reviveIdle(rows, chainId, factories, sinceMs);
    } catch (error) {
      this.deps.log('warn', `sale vault proxy idle check failed: ${toMessage(error)}`);
    }
    const due = await rows.listKeeperCandidates({
      chainId,
      factories,
      sinceMs,
      now: this.clock(),
      limit: this.deps.settings.batch,
    });
    for (const proxy of new Set(due.map((sale) => sale.proxy))) {
      try {
        await this.evaluate(rows, await rows.salesOfProxy(chainId, proxy), true);
      } catch (error) {
        this.deps.log('warn', `sale vault proxy ${proxy} not evaluated: ${toMessage(error)}`);
      }
    }
    for (const v of this.deployments.values()) {
      try {
        await this.skim(v);
      } catch (error) {
        this.deps.log('warn', `sale vault proxy factory ${v.factory} skim not evaluated: ${toMessage(error)}`);
      }
    }
    try {
      await this.alertFailedCcms();
    } catch (error) {
      this.deps.log('warn', `sale vault proxy failed CCM check failed: ${toMessage(error)}`);
    }
  }

  // Read factory logs, releases and USDC transfers to watched proxies since the cursor and make the sales they touch due
  private async scan(rows: KeeperRows, chainId: number, factories: string[], sinceMs: number): Promise<void> {
    const { chain } = this.deps;
    const head = await chain.blockNumber();
    // A Chainflip refund, a killed return or a provider refund all arrive as a Transfer to the proxy
    const watched = await rows.watchedProxies({ chainId, factories, sinceMs });
    // One interval of reading at most, so a long catch-up still verifies, retire and window, as often as a pass idles
    const stopAt = this.clock() + this.deps.settings.intervalMs;
    let cursor = await rows.readCursor(chainId);
    if (cursor === undefined) {
      // Nothing scanned yet, so every watched sale is looked at once and the watch window's logs are read
      await rows.markAllDue({ chainId, factories, sinceMs, at: this.clock() });
      cursor = await this.lastBlockBefore(sinceMs, head);
      // With no sale recorded only a factory log can matter, and a proxy's logs follow its factory's ProxyDeployed
      const allVerified = [this.deps.deployment, ...this.deps.retired].every((d) => this.deployments.has(d.factory.toLowerCase()));
      if (allVerified && watched.length === 0 && (await rows.idleProxies({ chainId, factories, sinceMs, limit: 1 })).length === 0) {
        try {
          let start = head;
          for (const factory of factories) start = await this.beforeFirstLog(factory, cursor, start, stopAt);
          cursor = start;
        } catch (error) {
          // The window start stays, so the scan below still saves its progress range by range
          this.deps.log('warn', `sale vault proxy first log search failed, scanning from the watch window start: ${toMessage(error)}`);
        }
      }
      await rows.writeCursor(chainId, cursor);
    }
    // A transfer counts as activity only at the proxy's MIN_RETURN, the least that can go home, so dust cannot keep a proxy watched
    const minReturnOf = new Map(watched.map((p) => [p.proxy, this.deployments.get(p.factory)?.minReturn ?? 0n]));
    // Each deployment's proxies are paid in its own USDC
    const byToken = new Map<string, string[]>();
    for (const p of watched) {
      const token = this.deployments.get(p.factory)?.usdc;
      if (token !== undefined) byToken.set(token, [...(byToken.get(token) ?? []), p.proxy]);
    }
    const chunks: { token: string; proxies: string[] }[] = [];
    for (const [token, proxies] of byToken) {
      for (let i = 0; i < proxies.length; i += PROXY_TOPIC_CHUNK) chunks.push({ token, proxies: proxies.slice(i, i + PROXY_TOPIC_CHUNK) });
    }
    const range = BigInt(this.deps.settings.logRange);
    let from = cursor + 1n;
    while (from <= head) {
      const to = minOf(from + range - 1n, head);
      const [logs, released, transfers] = await Promise.all([
        chain.logs({ address: factories, topics: [[...FACTORY_TOPICS, UNATTRIBUTED, RETIRED]], fromBlock: from, toBlock: to }),
        // By topic alone, so a release on a proxy past the watch window is recorded too
        chain.logs({ topics: [RELEASED], fromBlock: from, toBlock: to }),
        Promise.all(
          chunks.map((c) => chain.logs({ address: c.token, topics: [TRANSFER_TOPIC, null, c.proxies.map(addressTopic)], fromBlock: from, toBlock: to })),
        ),
      ]);
      const named = (topic: string) => logs.filter((log) => log.topics[0]?.toLowerCase() === topic);
      const moves = logs.filter((log) => FACTORY_TOPICS.includes(log.topics[0]?.toLowerCase() ?? ''));
      const releasers = released.length === 0 ? [] : await rows.recordedProxies({ chainId, factories, proxies: [...new Set(released.map((log) => log.address))] });
      const deferrals = this.readDeferrals(chainId, moves);
      const payouts = this.readPayouts(chainId, moves, released, new Map(releasers.map((p) => [p.proxy, p])));
      await rows.recordDeferrals(deferrals.rows);
      await rows.recordPayouts(payouts.rows);
      const active: string[] = [];
      const dust: string[] = [];
      for (const log of transfers.flat()) {
        if (log.topics[2] === undefined) continue;
        const proxy = topicAddress(log.topics[2]);
        if (transferValue(log) >= (minReturnOf.get(proxy) ?? 0n)) active.push(proxy);
        else dust.push(proxy);
      }
      // A release keeps its proxy watched, so a late refund still reaches the claimer
      await rows.markDue({
        chainId,
        homes: moves.flatMap((log) => (log.topics[1] === undefined ? [] : [decodeBytes32(log.topics[1])])),
        proxies: [...active, ...releasers.map((p) => p.proxy)],
        dust,
        at: this.clock(),
      });
      const retired = named(RETIRED);
      // A retire opens every proxy's release at once, idle ones too
      await rows.markFactoriesActive({ chainId, factories: [...new Set(retired.map((log) => log.address))], at: this.clock() });
      await rows.writeCursor(chainId, to);
      // After the cursor moves, so a range read again never alerts twice
      for (const message of [...deferrals.unreadable, ...payouts.unreadable]) this.deps.log('error', message);
      this.alertMissedBooking(moves);
      this.alertUnattributed(named(UNATTRIBUTED), from, to);
      for (const log of retired) {
        this.deps.log('error', `sale vault proxy factory ${log.address} was retired by its guardian: returns home stop and every proxy releases to its claimer`);
      }
      from = to + 1n;
      if (this.clock() >= stopAt) break;
    }
    // The cursor keeps the rest for the next pass, which runs at once
    this.behind = from <= head;
  }

  // The block before a factory's first log in (from, to], or `to` when it logged none there, thrown past stopAt
  private async beforeFirstLog(factory: string, from: bigint, to: bigint, stopAt: number): Promise<bigint> {
    const floor = BigInt(this.deps.settings.logRange);
    let span = to - from;
    for (let lo = from + 1n; lo <= to; ) {
      if (this.clock() >= stopAt) throw new Error(`first log of ${factory} not found by block ${lo.toString()} within one interval`);
      const hi = minOf(lo + span - 1n, to);
      let first: bigint | undefined;
      try {
        first = await this.deps.chain.firstLogBlock(factory, lo, hi);
      } catch (error) {
        // A node refuses or times out on too long a range, so the span halves down to log_range, which must answer
        if (!(error instanceof ChainUnavailableError) || span <= floor) throw error;
        span = maxOf(span / 2n, floor);
        continue;
      }
      if (first !== undefined) return first - 1n;
      lo = hi + 1n;
    }
    return to;
  }

  // Check a batch of proxies past the watch window, longest unchecked first, and watch again any that can now go home
  private async reviveIdle(rows: KeeperRows, chainId: number, factories: string[], sinceMs: number): Promise<void> {
    const idle = await rows.idleProxies({ chainId, factories, sinceMs, limit: this.deps.settings.batch });
    if (idle.length === 0) return;
    const returnable: string[] = [];
    for (const p of idle) {
      const v = this.deployments.get(p.factory);
      if (v !== undefined && (await this.canLeave(v, p.proxy))) returnable.push(p.proxy);
    }
    const at = this.clock();
    await rows.markChecked({ chainId, proxies: idle.map((p) => p.proxy), at });
    await rows.markDue({ chainId, homes: [], proxies: returnable, dust: [], at });
  }

  // Whether a proxy holds what can go home, or go to its claimer now or once deployed
  private async canLeave(v: VerifiedSaleVaultProxy, proxy: string): Promise<boolean> {
    const state = await this.deps.chain.proxyState(proxy);
    const balance = state?.balance ?? (await this.deps.chain.usdcBalance(v.usdc, proxy));
    return balance >= v.minReturn || (state === undefined ? balance > 0n : state.releasable > 0n);
  }

  // The last block stamped before `sinceMs`, block 0 when every block is inside the window
  private async lastBlockBefore(sinceMs: number, head: bigint): Promise<bigint> {
    const since = seconds(sinceMs);
    let lo = 0n;
    let hi = head;
    while (lo < hi) {
      const mid = (lo + hi + 1n) / 2n;
      if ((await this.deps.chain.blockTimestamp(mid)) < since) lo = mid;
      else hi = mid - 1n;
    }
    return lo;
  }

  // Each DeliveryDeferred log's full key, and an alert for each one that cannot be read
  private readDeferrals(chainId: number, moves: readonly RawLog[]): { rows: DeferralRow[]; unreadable: string[] } {
    const rows: DeferralRow[] = [];
    const unreadable: string[] = [];
    for (const log of moves) {
      if (log.topics[0]?.toLowerCase() !== DELIVERY_DEFERRED) continue;
      try {
        const d = decodeDeferral(log);
        rows.push({
          chain_id: chainId,
          factory: log.address,
          home: d.home,
          claimer: d.claimer,
          ref: d.ref,
          recipient: d.recipient,
          committed: d.committed,
          deadline: d.deadline,
        });
      } catch (error) {
        unreadable.push(`sale vault proxy factory ${log.address} logged an unreadable deferred delivery: ${toMessage(error)}`);
      }
    }
    return { rows, unreadable };
  }

  // Each payout to a claimer the logs show, a proxy's release or a flush its proxy refused, and an alert for each one that cannot be read
  private readPayouts(
    chainId: number,
    moves: readonly RawLog[],
    released: readonly RawLog[],
    proxies: ReadonlyMap<string, WatchedProxy>,
  ): { rows: PayoutRow[]; unreadable: string[] } {
    const rows: PayoutRow[] = [];
    const unreadable: string[] = [];
    const at = (log: RawLog) => ({ chain_id: chainId, tx_hash: log.txHash, log_index: log.logIndex });
    for (const log of moves) {
      if (log.topics[0]?.toLowerCase() !== PENDING_FLUSHED) continue;
      try {
        const f = decodePendingFlushed(log);
        if (f.to === f.claimer) rows.push({ ...at(log), factory: log.address, home: f.home, claimer: f.claimer, kind: 'flushed', amount: f.amount });
      } catch (error) {
        unreadable.push(`sale vault proxy factory ${log.address} logged an unreadable flush: ${toMessage(error)}`);
      }
    }
    for (const log of released) {
      const p = proxies.get(log.address);
      // Any contract can emit this event, only a recorded proxy's counts
      if (p === undefined) continue;
      try {
        rows.push({ ...at(log), factory: p.factory, home: p.home, claimer: p.claimer, kind: 'released', amount: decodeUint(log.data) });
      } catch (error) {
        unreadable.push(`sale vault proxy ${log.address} logged an unreadable release: ${toMessage(error)}`);
      }
    }
    return { rows, unreadable };
  }

  // A delivery left unbooked, pending or expired never pays its provider, so each one is an alert naming its sale
  private alertMissedBooking(moves: readonly RawLog[]): void {
    for (const log of moves) {
      const topic = log.topics[0]?.toLowerCase();
      if (topic !== DELIVERY_UNBOOKED && topic !== DELIVERY_PENDING && topic !== DEFERRED_EXPIRED) continue;
      try {
        this.deps.log('error', `sale vault proxy factory ${log.address} ${missedBooking(topic, log)}`);
      } catch (error) {
        this.deps.log('error', `sale vault proxy factory ${log.address} logged an unreadable missed booking: ${toMessage(error)}`);
      }
    }
  }

  // USDC the factory booked to no home goes to the treasury on the next skim, so each one is an alert
  private alertUnattributed(logs: readonly RawLog[], from: bigint, to: bigint): void {
    for (const log of logs) {
      try {
        const [, token = ''] = log.topics;
        this.deps.log(
          'error',
          `sale vault proxy factory ${log.address} left ${decodeUint(log.data).toString()} base units of token ${topicAddress(token)} unattributed (${decodeShortString(log.data, 1)}) in blocks ${from.toString()} to ${to.toString()}, a skim sends it to the treasury`,
        );
      } catch (error) {
        this.deps.log('error', `sale vault proxy factory ${log.address} logged an unreadable unattributed delivery: ${toMessage(error)}`);
      }
    }
  }

  // Each failed CCM to one of our factories holds a sale's USDC in Chainflip's Vault until its signed payload is submitted
  private async alertFailedCcms(): Promise<void> {
    for (const ccm of await this.deps.failedCalls.failedCcms()) {
      if (!this.deployments.has(ccm.recipient)) continue;
      const key = `${String(ccm.broadcastId)}:${String(ccm.originalEpoch)}`;
      if (this.failedAlerted.has(key)) continue;
      this.failedAlerted.add(key);
      this.deps.log(
        'error',
        `Chainflip CCM broadcast ${String(ccm.broadcastId)} to sale vault proxy factory ${ccm.recipient} failed: ${ccm.amount.toString()} base units of token ${ccm.token} for home ${ccm.home ?? 'unknown'} claimer ${ccm.claimer ?? 'unknown'} stay in the Vault until the cf_failed_call_arbitrum payload is sent to ${ccm.contract}, before epoch ${String(ccm.originalEpoch + 2)}`,
      );
    }
  }

  // Settle every in-flight call on this chain, or one proxy's, from its receipt, a rotated key's too, and release one that cannot mine
  private async settleInflight(rows: KeeperRows, chainId: number, proxy?: string): Promise<void> {
    const calls = await rows.readInflightProxyCalls(chainId);
    const now = this.clock();
    for (const call of calls) {
      if (proxy !== undefined && call.proxy !== proxy.toLowerCase()) continue;
      try {
        await this.settleOne(rows, call, calls, now);
      } catch (error) {
        this.deps.log('warn', `sale vault proxy call ${call.id} not settled: ${toMessage(error)}`);
      }
    }
  }

  private async settleOne(rows: KeeperRows, call: ProxyCallRow, inflight: readonly ProxyCallRow[], now: number): Promise<void> {
    const { chain, settings } = this.deps;
    const stale = now - call.updated_at > settings.resendMs;
    if (call.status === 'sending' || call.tx_hash === null || call.nonce === null) {
      // A crash between claim and broadcast
      if (stale) await rows.settleProxyCall(call.id, 'dropped', 'never broadcast');
      return;
    }
    const hash = call.tx_hash;
    // Read again right before a drop, so a call mined meanwhile is never marked dropped
    const settled = async (): Promise<boolean> => {
      const receipt = await chain.receipt(hash);
      if (receipt === null) return false;
      await rows.settleProxyCall(call.id, receipt.status ? 'mined' : 'reverted');
      return true;
    };
    if ((await settled()) || !stale) return;
    if ((await chain.transactionByHash(hash)) === null) {
      if (!(await settled())) await rows.settleProxyCall(call.id, 'dropped', 'transaction unknown to the node');
      return;
    }
    const latest = await chain.transactionCount(call.sender, 'latest');
    const nonce = BigInt(call.nonce);
    if (latest > nonce) {
      if (!(await settled())) await rows.settleProxyCall(call.id, 'dropped', 'nonce used by another transaction');
      return;
    }
    // Queued behind a nonce no call of ours holds, it cannot mine, so the next send fills the gap
    const held = new Set(inflight.flatMap((c) => (c.nonce === null || c.id === call.id || c.sender !== call.sender ? [] : [BigInt(c.nonce)])));
    let gap = false;
    for (let n = latest; n < nonce; n++) if (!held.has(n)) gap = true;
    if (gap) await rows.settleProxyCall(call.id, 'dropped', `queued behind a nonce gap at ${latest.toString()}`);
  }

  // Observe one proxy with all its sales, record when to look again, and act when `act` is set
  private async evaluate(rows: KeeperRows, sales: readonly KeeperCandidate[], act: boolean): Promise<Evaluation> {
    const [first] = sales;
    if (first === undefined) throw new ChainUnavailableError('no sale names this proxy');
    const v = this.verifiedFor(first.chain_id, first.factory);
    if (v === undefined) throw new ChainUnavailableError(`sale vault proxy deployment ${first.factory} is not verified`);
    const startedAt = this.clock();
    const observation = await this.observe(v, first);
    let judgement: Judgement;
    try {
      judgement = await this.decide(rows, v, first, sales, observation);
    } catch (error) {
      if (!(error instanceof ChainUnavailableError)) throw error;
      this.deps.log('warn', `sale vault proxy ${first.proxy} not judged: ${error.message}`);
      judgement = { decision: undefined, blockedReason: 'chain-unavailable', dueAt: startedAt };
    }
    const reason = judgement.blockedReason;
    if (reason === null) this.alerted.delete(`blocked:${first.proxy}`);
    if (reason === null || reason === 'not-due' || reason === 'below-minimum') this.holds.delete(first.proxy.toLowerCase());
    else this.holds.set(first.proxy.toLowerCase(), reason);
    if (act) {
      let { dueAt } = judgement;
      const { decision } = judgement;
      if (decision !== undefined) {
        let outcome = await this.send(first.chain_id, first.proxy, decision);
        if (outcome === 'reverted' && decision.fallback !== undefined) outcome = await this.send(first.chain_id, first.proxy, decision.fallback);
        // A call that would revert waits out the resend window rather than retrying every pass
        if (outcome === 'reverted') dueAt = this.clock() + this.deps.settings.resendMs;
      }
      await rows.schedule({ chainId: first.chain_id, proxy: first.proxy, dueAt, startedAt, at: this.clock() });
    }
    return { observation, blockedReason: judgement.blockedReason };
  }

  // First match wins: deliver or expire, flush, deploy, return, release
  private async decide(
    rows: KeeperRows,
    v: VerifiedSaleVaultProxy,
    proxy: KeeperCandidate,
    sales: readonly KeeperCandidate[],
    o: ProxyObservation,
  ): Promise<Judgement> {
    const now = this.clock();
    const acting = (decision: Decision): Judgement => ({ decision, blockedReason: null, dueAt: now });
    const release = o.state !== undefined && o.state.releasable > 0n && o.state.releaseAt <= seconds(now)
      ? { action: 'release' as const, target: proxy.proxy, data: encodeRelease(), amount: o.state.releasable }
      : undefined;
    for (const sale of sales) {
      const terms = saleTerms(sale);
      if (terms === undefined) continue;
      const deferred = (await this.deferrals(rows, sale, terms)).find((d) => d.amount > 0n);
      if (deferred === undefined) continue;
      const call = (signature: Parameters<typeof encodeClaimerTermsCall>[0]) => encodeClaimerTermsCall(signature, terms, deferred.deadline);
      // Past its deadline a replay can only hold the sale, so one the token refuses moves to pending, where flush can reach the claimer
      const deliver: Decision = { action: 'deliver', target: sale.factory, data: call('deliver(bytes32,address,bytes32,address,uint256,uint256)'), amount: deferred.amount };
      if (seconds(now) <= deferred.deadline) return acting(deliver);
      const expire: Decision = { action: 'expire', target: sale.factory, data: call('expireDeferred(bytes32,address,bytes32,address,uint256,uint256)'), amount: deferred.amount };
      return acting({ ...deliver, fallback: expire });
    }
    if (o.pending > 0n) {
      const data = encodeHomeClaimerCall('flush(bytes32,address)', proxy.home, proxy.claimer);
      return acting({ action: 'flush', target: proxy.factory, data, amount: o.pending });
    }
    if (o.state === undefined) {
      // USDC at an undeployed address leaves only through the proxy, home or to the claimer
      if (o.balance === 0n) return { decision: undefined, blockedReason: null, dueAt: null };
      return acting({ action: 'deploy', target: proxy.factory, data: encodeHomeClaimerCall('deploy(bytes32,address)', proxy.home, proxy.claimer), amount: null });
    }
    // state() and retired() are separate reads that nodes at different heights can split, and a retired factory always reads releaseAt 0
    const split = o.retired
      ? o.state.releaseAt !== 0n
      : o.state.releaseAt === 0n && o.balance >= v.minReturn && BigInt(o.state.attempts) < v.releaseAttempts;
    if (split && o.balance > 0n) return { decision: undefined, blockedReason: 'chain-unavailable', dueAt: now };
    // Returns end once the factory is retired, or out of attempts once the contract opens release
    if (o.balance >= v.minReturn && !o.retired && (BigInt(o.state.attempts) < v.releaseAttempts || o.state.releasable === 0n)) {
      const held = await this.judgeReturn(v, proxy.proxy, o.state, now);
      return held.decision === undefined && release !== undefined ? acting(release) : held;
    }
    if (release !== undefined) return acting(release);
    if (o.balance === 0n) return { decision: undefined, blockedReason: null, dueAt: null };
    // A balance below MIN_RETURN waits for its release time
    return { decision: undefined, blockedReason: 'below-minimum', dueAt: Math.max(Number(o.state.releaseAt) * 1000, now) };
  }

  // A return of the chunk the contract will send, or why it is held back
  private async judgeReturn(v: VerifiedSaleVaultProxy, proxy: string, state: ClaimerProxyState, now: number): Promise<Judgement> {
    const held = (reason: BlockedReason, level: 'info' | 'error', message: string): Judgement => {
      this.alertOnce(`blocked:${proxy}`, reason, level, `sale vault proxy ${proxy} return held back: ${message}`);
      return { decision: undefined, blockedReason: reason, dueAt: now };
    };
    if (seconds(now) < state.nextReturnAt) return { decision: undefined, blockedReason: 'not-due', dueAt: Number(state.nextReturnAt) * 1000 };
    const amount = returnChunk(state.balance, v);
    try {
      await this.deps.limits.check(amount, v);
    } catch (error) {
      if (!(error instanceof ReturnNotSwappableError)) throw error;
      // Verification proved the deployment fit, so a refusal here is Chainflip's limits moving
      return held(error.reason, 'error', error.message);
    }
    const quoted = await this.deps.limits.quotedOutput(amount);
    const needed = (proxyMinOut(amount, v) * BigInt(10_000 + this.deps.settings.quoteMarginBps)) / 10_000n;
    if (quoted < needed) return held('not-swappable', 'info', `quote ${quoted.toString()} under ${needed.toString()}`);
    // The proxy's Vault is immutable, so a return into a Vault Chainflip moved away from is lost
    const vault = await this.deps.limits.arbitrumVault();
    if (vault !== v.vault) return held('vault-changed', 'error', `Chainflip's Arbitrum vault is ${vault}, the proxy sends to ${v.vault}`);
    return { decision: { action: 'return', target: proxy, data: encodeCall('returnHome()'), amount }, blockedReason: null, dueAt: now };
  }

  /** Send a claimer's signed USDC transfer, keyed by the claimer so one relay per claimer is in flight. */
  async relay(chainId: number, usdc: string, claimer: string, data: string, amount: bigint): Promise<SendOutcome> {
    return this.send(chainId, claimer, { action: 'relay', target: usdc, data, amount });
  }

  // Push a factory's free USDC to the treasury once it is worth the gas
  private async skim(v: VerifiedSaleVaultProxy): Promise<void> {
    const [totalPending, balance] = await Promise.all([
      this.deps.chain.totalPending(v.factory),
      this.deps.chain.usdcBalance(v.usdc, v.factory),
    ]);
    const free = balance - totalPending;
    if (free > 0n && free >= this.deps.settings.minSkim) {
      await this.send(v.chainId, v.factory, { action: 'skim', target: v.factory, data: encodeCall('skim()'), amount: free });
    }
  }

  // Serialized in process, and under the advisory lock: the pass's own when one runs, else taken for this send
  private async send(chainId: number, proxy: string, d: Decision): Promise<SendOutcome> {
    return this.enqueue(async () => {
      const sent =
        this.session === undefined
          ? await this.deps.store.withKeeperLock((rows) => this.sendLocked(rows, chainId, proxy, d))
          : await this.sendLocked(this.session, chainId, proxy, d);
      if (sent !== undefined) return sent;
      this.deps.log('info', `sale vault proxy ${d.action} on ${proxy} left to the replica holding the keeper lock`);
      return 'locked';
    });
  }

  // Claim, estimate, sign, record as sent, then broadcast
  private async sendLocked(rows: KeeperRows, chainId: number, proxy: string, d: Decision): Promise<SendOutcome> {
    const { chain, signer } = this.deps;
    const id = this.newId();
    const call = {
      id,
      chain_id: chainId,
      sender: signer.address,
      target: d.target,
      proxy,
      action: d.action,
      amount: d.amount === null ? null : d.amount.toString(),
    };
    let claimed = await rows.claimProxyCall(call);
    if (!claimed) {
      // A call no pass settled, as with the loop off, frees its proxy once the chain settles it
      await this.settleInflight(rows, chainId, proxy);
      claimed = await rows.claimProxyCall(call);
    }
    if (!claimed) return 'skipped';
    let nonce: bigint;
    let raw: string;
    let hash: string;
    try {
      let gasLimit: bigint;
      try {
        gasLimit = ((await chain.estimateGas(signer.address, d.target, d.data)) * 12n) / 10n;
      } catch (error) {
        if (!(error instanceof CallRevertedError)) throw error;
        await rows.settleProxyCall(id, 'reverted', error.message);
        this.deps.log('warn', `sale vault proxy ${d.action} on ${proxy} would revert: ${error.message}`);
        return 'reverted';
      }
      const fees = await chain.fees();
      nonce = await chain.transactionCount(signer.address, 'pending');
      ({ raw, hash } = signer.sign({ to: d.target, data: d.data, nonce, gasLimit, fees, chainId: BigInt(chainId) }));
    } catch (error) {
      await rows.settleProxyCall(id, 'dropped', toMessage(error));
      throw error;
    }
    await rows.markProxyCallSent(id, hash, Number(nonce));
    try {
      await chain.sendRaw(raw);
      this.deps.log('info', `sale vault proxy ${d.action} on ${proxy} sent as ${hash}`);
    } catch (error) {
      // Left as sent, the settle step resolves it from the chain
      this.deps.log('warn', `sale vault proxy ${d.action} broadcast ${hash} failed: ${toMessage(error)}`);
    }
    return 'sent';
  }
}

// One missed booking's alert text after the factory's address
function missedBooking(topic: string, log: RawLog): string {
  const [, home = '', second = '', third = ''] = log.topics;
  if (topic === DELIVERY_UNBOOKED) {
    return `left ${decodeUint(log.data, 1).toString()} USDC base units unbooked on proxy ${topicAddress(second)} for home ${decodeBytes32(home)} claimer ${decodeAddress(log.data, 0)} ref ${decodeBytes32(third)}`;
  }
  if (topic === DELIVERY_PENDING) {
    return `pended ${decodeUint(log.data).toString()} USDC base units (${decodeShortString(log.data, 1)}) for home ${decodeBytes32(home)} claimer ${topicAddress(second)} ref ${decodeBytes32(third)}`;
  }
  const d = decodeDeferral(log);
  return `moved ${d.amount.toString()} USDC base units deferred past deadline ${d.deadline.toString()} to pending for home ${d.home} claimer ${d.claimer} ref ${d.ref}, a flush sends it to the proxy or the claimer`;
}
