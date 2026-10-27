import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DeferralRow, DeferralTerms, KeeperCandidate, KeeperRows, NewProxyCall, PayoutRow, ProxyCallRow } from '../../src/funding/store.js';
import {
  addressTopic,
  encodeBalanceOf,
  encodeCall,
  encodeClaimerTermsCall,
  encodeDelivery,
  encodeHomeClaimerCall,
  encodeRelease,
  encodeRetired,
  eventTopic,
  saleRef,
  type RawLog,
  type SaleTerms,
} from '../../src/salevaultproxy/abi.js';
import { ChainUnavailableError, RpcCallError, SaleVaultProxyChain } from '../../src/salevaultproxy/chain.js';
import {
  PROXY_TOPIC_CHUNK,
  saleTerms,
  SaleVaultProxyKeeper,
  type KeeperLog,
  type KeeperSettings,
  type KeeperStore,
  type RetiredDeployment,
} from '../../src/salevaultproxy/keeper.js';
import type { FailedCallSource, FailedCcm } from '../../src/salevaultproxy/failed-calls.js';
import { ReturnNotSwappableError, type ReturnLimits } from '../../src/salevaultproxy/limits.js';
import { KeeperSigner, parseKeeperKey } from '../../src/salevaultproxy/signer.js';
import type { SaleVaultProxyDeploymentConfig } from '../../src/salevaultproxy/verify.js';
import { chainflipOf, CLAIMER, deployedGetters, FACTORY, fakeNode, HOME, IMPL, PROXY, SEPOLIA, w } from './fakes.js';

const KEY = Uint8Array.from(Buffer.from('46'.repeat(32), 'hex'));
const KEEPER = '0x9d8A62f656a8d1615C1294fd71e9CFb3E4855A4F';
const NOW = 1_800_000_000_000;
const RECIPIENT = '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc';
const MIN_RETURN = 1_000_000n;
// The fake implementation's STALE_DELAY, the watch window
const WATCH_SECONDS = 5_184_000;

const SETTINGS: KeeperSettings = {
  intervalMs: 60_000,
  batch: 25,
  resendMs: 600_000,
  logRange: 100,
  minSkim: 5_000_000n,
  minEth: 2_000_000_000_000_000n,
  quoteMarginBps: 50,
};

interface SaleRow extends KeeperCandidate {
  due_at: number | null;
  last_activity_at: number;
  updated_at: number;
}

/** One Arbitrum sale of the shared vectors, due now unless told otherwise. */
function sale(overrides: Partial<SaleRow> = {}): SaleRow {
  return {
    funding_request_id: 'funding-1',
    chain_id: 421614,
    factory: FACTORY,
    implementation: IMPL,
    home: HOME,
    claimer: CLAIMER,
    proxy: PROXY,
    ref: saleRef('funding-1'),
    deposit_address: RECIPIENT,
    crypto_amount: '50',
    due_at: NOW,
    last_activity_at: NOW - 1_000,
    updated_at: NOW - 1_000,
    ...overrides,
  };
}

const TERMS = saleTerms(sale()) as SaleTerms;
// The sale's payment deadline in epoch seconds, as its CCM carries it
const DEADLINE = 1_800_003_600n;

/** A gas-deferred delivery of the shared sale under `deadline`, as the scan records it. */
const deferral = (deadline = DEADLINE): DeferralRow => ({ chain_id: 421614, factory: FACTORY, ...TERMS, deadline });

/** Where a log sits in its transaction, which the payouts table keys by. */
const at = (logIndex = 0, txHash = `0x${'ee'.repeat(32)}`) => ({ txHash, logIndex });

/** A DeliveryDeferred log of the shared sale, as the factory emits it. */
const deferredLog = (amount: bigint, deadline = DEADLINE, name = 'DeliveryDeferred'): RawLog => ({
  address: FACTORY,
  topics: [eventTopic(`${name}(bytes32,address,bytes32,address,uint256,uint256,uint256)`), HOME, addressTopic(CLAIMER), TERMS.ref],
  data: `0x${w(TERMS.recipient)}${w(TERMS.committed)}${w(amount)}${w(deadline)}`,
  ...at(),
});

const RELEASED = eventTopic('Released(uint256)');

interface ProxyWorld {
  deployed: boolean;
  balance: bigint;
  attempts: bigint;
  nextReturnAt: bigint;
  releaseAt: bigint;
  releasable: bigint;
  pending: bigint;
  /** The factory's deferred amount under the shared sale's terms, by deadline. */
  deferred: Map<bigint, bigint>;
}

// A second deployment on the same chain, verified when a test passes `deployed` to world
const OLD_FACTORY = '0x6666666666666666666666666666666666666666';
const OLD_IMPL = '0x7777777777777777777777777777777777777777';
const oldDeployment = (): Record<string, string> =>
  Object.fromEntries(
    Object.entries(deployedGetters())
      .filter(([key]) => key.startsWith(FACTORY) || key.startsWith(IMPL))
      .map(([key, value]) => [
        key.replace(FACTORY, OLD_FACTORY).replace(IMPL, OLD_IMPL),
        key.endsWith(':IMPLEMENTATION()') ? w(OLD_IMPL) : key.endsWith(':FACTORY()') ? w(OLD_FACTORY) : value,
      ]),
  );

/** A scripted chain whose state the test mutates between calls. */
function world(overrides: Partial<ProxyWorld> = {}, totalPending = 0n, staleDelay = BigInt(WATCH_SECONDS), deployed: Record<string, string> = {}) {
  const proxy: ProxyWorld = {
    deployed: true,
    balance: 0n,
    attempts: 0n,
    nextReturnAt: 0n,
    releaseAt: BigInt(NOW / 1000) + 86_400n,
    releasable: 0n,
    pending: 0n,
    deferred: new Map(),
    ...overrides,
  };
  const state = {
    proxy,
    factoryBalance: 0n,
    head: 1_000n,
    // Seconds between blocks, the head block stamped NOW
    blockSeconds: 1n,
    timestampReads: 0,
    factoryLogs: [] as RawLog[],
    transferLogs: [] as RawLog[],
    releasedLogs: [] as RawLog[],
    retired: false,
    logReads: [] as { address: unknown; topics: unknown; fromBlock: string; toBlock: string }[],
    // Each factory's first log block, and the longest range a one-address read may span
    firstLogs: new Map<string, bigint>(),
    firstLogLimit: undefined as bigint | undefined,
    firstLogReads: [] as { address: unknown; fromBlock: bigint; toBlock: bigint }[],
    nonce: { pending: 7n, latest: 7n },
    receipts: new Map<string, { status: string }>(),
    receiptLate: new Map<string, { status: string }>(),
    known: new Set<string>(),
    sent: [] as string[],
    estimate: (_data: string): unknown => '0x186a0',
    sendFails: false,
    logsFail: false,
    ethBalance: 10n ** 18n,
  };
  // The sale's pendingDelivery call bar its trailing deadline word
  const deferredCall = encodeClaimerTermsCall('pendingDelivery(bytes32,address,bytes32,address,uint256,uint256)', TERMS, 0n).slice(0, -64);
  // Retired is read live, so the test can flip it
  const getters = Object.fromEntries(
    Object.entries(deployedGetters({ [`${FACTORY}:totalPending()`]: w(totalPending), [`${IMPL}:STALE_DELAY()`]: w(staleDelay) })).filter(([key]) => key !== `${FACTORY}:retired()`),
  );
  const node = fakeNode({
    getters: { ...getters, ...deployed },
    code: { [FACTORY]: '0x60', [IMPL]: '0x60', ...Object.fromEntries(Object.keys(deployed).map((key) => [key.split(':')[0], '0x60'])) },
    methods: {
      eth_call: ([{ to, data }]: [{ to: string; data: string }]) => {
        if (to === PROXY && data === encodeCall('state()')) {
          if (!proxy.deployed) return '0x';
          const words = [HOME.slice(2), w(CLAIMER), w(proxy.balance), w(proxy.attempts), w(0n), w(proxy.nextReturnAt), w(proxy.releaseAt), w(proxy.releasable)];
          return `0x${words.join('')}`;
        }
        if (to === FACTORY && data === encodeRetired()) return `0x${w(state.retired ? 1n : 0n)}`;
        if (data === encodeBalanceOf(PROXY)) return `0x${w(proxy.balance)}`;
        if (data === encodeBalanceOf(FACTORY)) return `0x${w(state.factoryBalance)}`;
        if (data === encodeHomeClaimerCall('pending(bytes32,address)', HOME, CLAIMER)) return `0x${w(proxy.pending)}`;
        if (data.length === deferredCall.length + 64 && data.startsWith(deferredCall)) {
          return `0x${w(proxy.deferred.get(BigInt(`0x${data.slice(-64)}`)) ?? 0n)}`;
        }
        if (data === encodeDelivery(TERMS)) return `0x${w(1n)}${w(50_400_000n)}${w(400_000n)}`;
        // Another sale's terms defer nothing
        if (data.startsWith('0x4be199b9')) return `0x${w(0n)}`;
        throw new RpcCallError(`unscripted call ${to} ${data}`);
      },
      eth_getBalance: () => `0x${state.ethBalance.toString(16)}`,
      eth_estimateGas: ([{ data }]: [{ data: string }]) => state.estimate(data),
      eth_getBlockByNumber: ([tag]: [string]) => {
        if (tag === 'latest') return { baseFeePerGas: '0x5f5e100' };
        state.timestampReads += 1;
        const at = BigInt(NOW / 1000) - (state.head - BigInt(tag)) * state.blockSeconds;
        return { timestamp: `0x${at.toString(16)}` };
      },
      eth_maxPriorityFeePerGas: '0x0',
      eth_blockNumber: () => `0x${state.head.toString(16)}`,
      eth_getLogs: ([filter]: [{ address: unknown; topics: unknown; fromBlock: string; toBlock: string }]) => {
        if (state.logsFail) throw new RpcCallError('rpc eth_getLogs error: query exceeds max results', -32005);
        if ((filter.topics as unknown[]).length === 0) {
          const [fromBlock, toBlock] = [BigInt(filter.fromBlock), BigInt(filter.toBlock)];
          state.firstLogReads.push({ address: filter.address, fromBlock, toBlock });
          if (state.firstLogLimit !== undefined && toBlock - fromBlock + 1n > state.firstLogLimit) throw new RpcCallError('query spans too many blocks', -32602);
          const first = state.firstLogs.get(filter.address as string);
          return first !== undefined && first >= fromBlock && first <= toBlock ? [{ blockNumber: `0x${first.toString(16)}` }, { blockNumber: `0x${(first + 1n).toString(16)}` }] : [];
        }
        state.logReads.push(filter);
        const logs = (filter.topics as unknown[])[0] === RELEASED ? state.releasedLogs : Array.isArray(filter.address) ? state.factoryLogs : state.transferLogs;
        // As the node answers them
        return logs.map(({ txHash, logIndex, ...rest }) => ({ ...rest, transactionHash: txHash, logIndex: `0x${logIndex.toString(16)}` }));
      },
      eth_getTransactionCount: ([, tag]: [string, 'pending' | 'latest']) => `0x${state.nonce[tag].toString(16)}`,
      eth_sendRawTransaction: ([raw]: [string]) => {
        if (state.sendFails) throw new ChainUnavailableError('broadcast refused');
        state.sent.push(raw);
        return '0xok';
      },
      eth_getTransactionReceipt: ([hash]: [string]) => {
        const late = state.receiptLate.get(hash);
        // Mined between the first read and the re-read
        if (late !== undefined) {
          state.receiptLate.delete(hash);
          state.receipts.set(hash, late);
          return null;
        }
        return state.receipts.get(hash) ?? null;
      },
      eth_getTransactionByHash: ([hash]: [string]) => (state.known.has(hash) ? { hash } : null),
    },
  });
  return { state, chain: new SaleVaultProxyChain(node.rpc), rpc: node.rpc, calls: node.calls };
}

/** An in-memory keeper store with the Postgres semantics the keeper relies on. */
function memoryStore(sales: SaleRow[] = [sale()]) {
  const calls: ProxyCallRow[] = [];
  const schedules: { proxy: string; dueAt: number | null }[] = [];
  const marked: { homes: readonly string[]; proxies: readonly string[]; dust: readonly string[] }[] = [];
  const deferrals: DeferralRow[] = [];
  const payouts: PayoutRow[] = [];
  const activated: (readonly string[])[] = [];
  let cursor: bigint | undefined = 0n;
  let replica = false;
  let locked = false;
  const inflight = (c: ProxyCallRow) => c.status === 'sending' || c.status === 'sent';
  const busy = (proxy: string) => calls.some((c) => inflight(c) && c.proxy === proxy);
  const view = (s: SaleRow): KeeperCandidate => ({
    funding_request_id: s.funding_request_id,
    chain_id: s.chain_id,
    factory: s.factory,
    implementation: s.implementation,
    home: s.home,
    claimer: s.claimer,
    proxy: s.proxy,
    ref: s.ref,
    deposit_address: s.deposit_address,
    crypto_amount: s.crypto_amount,
  });
  const rows = {
    listKeeperCandidates: async (a: { chainId: number; factories: readonly string[]; sinceMs: number; now: number; limit: number }) =>
      sales
        .filter((s) => s.chain_id === a.chainId && a.factories.includes(s.factory) && s.last_activity_at >= a.sinceMs)
        .filter((s) => s.due_at !== null && s.due_at <= a.now && !busy(s.proxy))
        .slice(0, a.limit)
        .map(view),
    salesOfProxy: async (chainId: number, proxy: string) => sales.filter((s) => s.chain_id === chainId && s.proxy === proxy).map(view),
    watchedProxies: async (a: { chainId: number; factories: readonly string[]; sinceMs: number }) =>
      [...new Set(sales.filter((s) => s.chain_id === a.chainId && a.factories.includes(s.factory) && s.last_activity_at >= a.sinceMs).map((s) => s.proxy))]
        .sort()
        .map((proxy) => {
          const s = sales.find((x) => x.proxy === proxy) as SaleRow;
          return { proxy, factory: s.factory, home: s.home, claimer: s.claimer };
        }),
    recordedProxies: async (a: { chainId: number; factories: readonly string[]; proxies: readonly string[] }) =>
      [...new Set(sales.filter((s) => s.chain_id === a.chainId && a.factories.includes(s.factory) && a.proxies.includes(s.proxy)).map((s) => s.proxy))]
        .sort()
        .map((proxy) => {
          const s = sales.find((x) => x.proxy === proxy) as SaleRow;
          return { proxy, factory: s.factory, home: s.home, claimer: s.claimer };
        }),
    idleProxies: async (a: { chainId: number; factories: readonly string[]; sinceMs: number; limit: number }) => {
      const mine = sales.filter((s) => s.chain_id === a.chainId && a.factories.includes(s.factory));
      const idle = [...new Set(mine.map((s) => s.proxy))].filter((p) => mine.every((s) => s.proxy !== p || s.last_activity_at < a.sinceMs));
      const checkedAt = (p: string) => Math.max(...mine.filter((s) => s.proxy === p).map((s) => s.updated_at));
      return idle
        .sort((x, y) => checkedAt(x) - checkedAt(y))
        .slice(0, a.limit)
        .map((proxy) => ({ proxy, factory: mine.find((s) => s.proxy === proxy)?.factory ?? '' }));
    },
    markChecked: async (a: { proxies: readonly string[]; at: number }) => {
      for (const s of sales) if (a.proxies.includes(s.proxy)) s.updated_at = a.at;
    },
    markDue: async (a: { homes: readonly string[]; proxies: readonly string[]; dust: readonly string[]; at: number }) => {
      if (a.homes.length + a.proxies.length + a.dust.length > 0) marked.push({ homes: a.homes, proxies: a.proxies, dust: a.dust });
      for (const s of sales) {
        const active = a.homes.includes(s.home) || a.proxies.includes(s.proxy);
        if (active) s.last_activity_at = a.at;
        if (active || a.dust.includes(s.proxy)) s.due_at = a.at;
      }
    },
    markAllDue: async (a: { at: number }) => {
      for (const s of sales) s.due_at = a.at;
    },
    markFactoriesActive: async (a: { chainId: number; factories: readonly string[]; at: number }) => {
      if (a.factories.length > 0) activated.push(a.factories);
      for (const s of sales) {
        if (s.chain_id === a.chainId && a.factories.includes(s.factory)) Object.assign(s, { due_at: a.at, last_activity_at: a.at });
      }
    },
    schedule: async (a: { proxy: string; dueAt: number | null; startedAt: number }) => {
      schedules.push({ proxy: a.proxy, dueAt: a.dueAt });
      for (const s of sales) if (s.proxy === a.proxy) s.due_at = s.due_at !== null && s.due_at > a.startedAt ? s.due_at : a.dueAt;
    },
    recordDeferrals: async (rows: readonly DeferralRow[]) => {
      const key = (d: DeferralRow) => [d.chain_id, d.factory, d.home, d.claimer, d.ref, d.recipient, d.committed, d.deadline].join(':');
      for (const d of rows) if (!deferrals.some((x) => key(x) === key(d))) deferrals.push(d);
    },
    deferralDeadlines: async (t: DeferralTerms) =>
      deferrals
        .filter(
          (d) =>
            d.chain_id === t.chain_id &&
            d.factory === t.factory &&
            d.home === t.home &&
            d.claimer === t.claimer &&
            d.ref === t.ref &&
            d.recipient === t.recipient &&
            d.committed === t.committed,
        )
        .map((d) => d.deadline)
        .sort((a, b) => (a < b ? -1 : 1)),
    recordPayouts: async (rows: readonly PayoutRow[]) => {
      for (const p of rows) if (!payouts.some((x) => x.tx_hash === p.tx_hash && x.log_index === p.log_index)) payouts.push(p);
    },
    readCursor: async () => cursor,
    writeCursor: async (_chainId: number, block: bigint) => {
      cursor = block;
    },
    claimProxyCall: async (call: NewProxyCall) => {
      if (busy(call.proxy)) return false;
      calls.push({ ...call, sender: call.sender.toLowerCase(), nonce: null, tx_hash: null, status: 'sending', error: null, created_at: NOW, updated_at: NOW });
      return true;
    },
    markProxyCallSent: async (id: string, txHash: string, nonce: number) => {
      const c = calls.find((x) => x.id === id && x.status === 'sending');
      if (c) Object.assign(c, { status: 'sent', tx_hash: txHash, nonce });
    },
    settleProxyCall: async (id: string, status: ProxyCallRow['status'], error?: string) => {
      const c = calls.find((x) => x.id === id && inflight(x));
      if (c) Object.assign(c, { status, error: error ?? null });
    },
    readInflightProxyCalls: async (chainId: number) => calls.filter((c) => inflight(c) && c.chain_id === chainId),
  };
  const store: KeeperStore = {
    keeperRows: () => rows as unknown as KeeperRows,
    withKeeperLock: async <T>(fn: (r: KeeperRows) => Promise<T>): Promise<T | undefined> => {
      if (replica || locked) return undefined;
      locked = true;
      try {
        return await fn(rows as unknown as KeeperRows);
      } finally {
        locked = false;
      }
    },
  };
  return {
    store,
    rows,
    sales,
    calls,
    schedules,
    marked,
    activated,
    deferrals,
    payouts,
    cursor: () => cursor,
    setCursor: (block: bigint | undefined) => {
      cursor = block;
    },
    otherReplica: (value: boolean) => {
      replica = value;
    },
  };
}

const DEPLOYMENT: SaleVaultProxyDeploymentConfig = { chainId: 421614, factory: FACTORY, vault: SEPOLIA.vault, usdc: SEPOLIA.usdc };

function limitsOf(opts: { check?: () => Promise<void>; quote?: bigint | (() => Promise<bigint>) } = {}): ReturnLimits {
  return {
    ...chainflipOf(),
    check: vi.fn(opts.check ?? (async () => undefined)),
    quotedOutput: vi.fn(typeof opts.quote === 'function' ? opts.quote : async () => opts.quote ?? 10n ** 12n),
  } as unknown as ReturnLimits;
}

function keeperFor(
  w0: ReturnType<typeof world>,
  mem: ReturnType<typeof memoryStore>,
  opts: {
    limits?: ReturnLimits;
    now?: () => number;
    log?: KeeperLog;
    chain?: SaleVaultProxyChain;
    deployment?: typeof DEPLOYMENT;
    retired?: RetiredDeployment[];
    failedCalls?: FailedCallSource;
  } = {},
) {
  let n = 0;
  const log = opts.log ?? vi.fn<KeeperLog>();
  const keeper = new SaleVaultProxyKeeper({
    deployment: opts.deployment ?? DEPLOYMENT,
    retired: opts.retired ?? [],
    chain: opts.chain ?? w0.chain,
    signer: new KeeperSigner(() => KEY),
    limits: opts.limits ?? limitsOf(),
    failedCalls: opts.failedCalls ?? { failedCcms: async () => [] },
    store: mem.store,
    settings: SETTINGS,
    log,
    clock: opts.now ?? (() => NOW),
    newId: () => `call-${String(++n)}`,
  });
  return { keeper, log };
}

const actionsOf = (mem: ReturnType<typeof memoryStore>) => mem.calls.map((c) => `${c.action}:${c.status}`);
const down = () => new SaleVaultProxyChain(async () => Promise.reject(new ChainUnavailableError('down')));

afterEach(() => {
  vi.useRealTimers();
});

describe('sale terms', () => {
  it('reads the deposit address and committed USDC off the funding row', () => {
    expect(TERMS).toEqual({ home: HOME, claimer: CLAIMER, ref: saleRef('funding-1'), recipient: RECIPIENT, committed: 50_000_000n });
    expect(saleTerms(sale({ deposit_address: RECIPIENT.toUpperCase().replace('0X', '0x'), crypto_amount: '1.000001' }))).toMatchObject({
      recipient: RECIPIENT,
      committed: 1_000_001n,
    });
  });

  it('has none before the deposit address is disclosed or for a malformed amount', () => {
    expect(saleTerms(sale({ deposit_address: undefined }))).toBeUndefined();
    expect(saleTerms(sale({ deposit_address: '15oF4uVJwmo4TdGW7VfQxNLavjCXviqxT9S1MgbjMNHr6Sp5' }))).toBeUndefined();
    expect(saleTerms(sale({ crypto_amount: '1.0000001' }))).toBeUndefined();
    expect(saleTerms(sale({ crypto_amount: undefined }))).toBeUndefined();
  });
});

describe('verification', () => {
  it('starts unverified and verifies on the first pass', async () => {
    const { keeper } = keeperFor(world(), memoryStore([]));
    expect(keeper.verified()).toBeUndefined();
    await keeper.pass();
    expect(keeper.verified()?.factory).toBe(FACTORY);
    expect(keeper.verifiedFor(421614, FACTORY.toUpperCase().replace('0X', '0x'))).toMatchObject({ releaseDelay: 86_400n, releaseAttempts: 7n, staleDelay: 5_184_000n });
    expect(keeper.verifiedFor(42161, FACTORY)).toBeUndefined();
  });

  it('stays unverified through an outage, and logs a mismatch without throwing or acting', async () => {
    const mem = memoryStore();
    const outage = keeperFor(world(), mem, { chain: down() });
    expect(await outage.keeper.verify()).toBe(false);
    expect(outage.log).toHaveBeenCalledWith('warn', expect.stringMatching(/unverified, the chain did not answer/));

    const wrong = keeperFor(world(), mem, { deployment: { ...DEPLOYMENT, vault: '0x3333333333333333333333333333333333333333' } });
    expect(await wrong.keeper.verify()).toBe(false);
    await wrong.keeper.pass();
    expect(wrong.log).toHaveBeenCalledWith('error', expect.stringMatching(/is unavailable: .*factory vault is/));
    expect(wrong.keeper.verified()).toBeUndefined();
    expect(mem.calls).toEqual([]);
  });

  it('serves a retired deployment that verifies, and keeps the current one when a retired one does not', async () => {
    const OLD = '0x5555555555555555555555555555555555555555';
    const { keeper, log } = keeperFor(world(), memoryStore([]), { retired: [{ factory: OLD, vault: SEPOLIA.vault, usdc: SEPOLIA.usdc }] });
    expect(await keeper.verify()).toBe(true);
    expect(keeper.verifiedFor(421614, FACTORY)).toBeDefined();
    expect(keeper.verifiedFor(421614, OLD)).toBeUndefined();
    expect(log).toHaveBeenCalledWith('error', expect.stringContaining(OLD));
  });

  it('keeps serving and releasing after Chainflip moves its Vault, which closes new sells only', async () => {
    const moved = limitsOf();
    (moved as unknown as { arbitrumVault: () => Promise<string> }).arbitrumVault = async () => `0x${'99'.repeat(20)}`;
    const mem = memoryStore();
    const { keeper, log } = keeperFor(world({ balance: 20_000_000n, attempts: 7n, releaseAt: 0n, releasable: 20_000_000n }), mem, { limits: moved });
    await keeper.pass();
    expect(log).toHaveBeenCalledWith('error', expect.stringMatching(/is closed to new sells: .*Chainflip's Arbitrum vault is 0x9999/));
    expect(keeper.verified()).toBeUndefined();
    expect(keeper.current()?.factory).toBe(FACTORY);
    expect(actionsOf(mem)).toEqual(['release:sent']);
  });

  it("verifies a retired deployment against its own Vault and USDC, not the current one's", async () => {
    const NEW = '0x5555555555555555555555555555555555555555';
    const deployment = { ...DEPLOYMENT, factory: NEW, vault: `0x${'99'.repeat(20)}` };
    const { keeper } = keeperFor(world(), memoryStore([]), { deployment, retired: [{ factory: FACTORY, vault: SEPOLIA.vault, usdc: SEPOLIA.usdc }] });
    await keeper.verify();
    expect(keeper.verifiedFor(421614, FACTORY)).toMatchObject({ vault: SEPOLIA.vault, usdc: SEPOLIA.usdc });
    expect(keeper.current()).toBeUndefined();
  });

  it('closes new sells on a live window mismatch but keeps acting on existing sales, until the window fits again', async () => {
    let broker = `0x${'11'.repeat(32)}`;
    const limits = limitsOf();
    const route = limits.returnRoute.bind(limits);
    (limits as unknown as { returnRoute: ReturnLimits['returnRoute'] }).returnRoute = async (args) => ({ ...(await route(args)), broker });
    const mem = memoryStore();
    const { keeper, log } = keeperFor(world({ pending: 5n }), mem, { limits });
    await keeper.pass();
    expect(log).toHaveBeenCalledWith('error', expect.stringMatching(/is closed to new sells: .*default broker/));
    expect(keeper.verified()).toBeUndefined();
    expect(keeper.verifiedFor(421614, FACTORY)?.factory).toBe(FACTORY);
    expect(actionsOf(mem)).toEqual(['flush:sent']);
    broker = SEPOLIA.broker;
    await keeper.pass();
    expect(keeper.verified()?.factory).toBe(FACTORY);
  });

  it("verifies each deployment's identity once, and whether it is retired every time", async () => {
    const w0 = world();
    const { keeper } = keeperFor(w0, memoryStore([]));
    await keeper.verify();
    const reads = (data: string) => w0.calls.filter((c) => c.method === 'eth_call' && (c.params[0] as { data: string }).data === data).length;
    expect(await keeper.verify()).toBe(true);
    expect(reads(encodeCall('IMPLEMENTATION()'))).toBe(1);
    expect(reads(encodeRetired())).toBe(2);
  });

  it('closes new sells once the factory is retired, logging it once, and keeps acting on existing sales', async () => {
    const w0 = world({ pending: 5n });
    const mem = memoryStore();
    const log = vi.fn<KeeperLog>();
    const { keeper } = keeperFor(w0, mem, { log });
    expect(await keeper.verify()).toBe(true);
    w0.state.retired = true;
    await keeper.pass();
    await keeper.pass();
    expect(keeper.verified()).toBeUndefined();
    expect(keeper.current()?.factory).toBe(FACTORY);
    expect(log.mock.calls.filter(([, m]) => /is closed to new sells: .*is retired/.test(m))).toHaveLength(1);
    expect(actionsOf(mem)).toEqual(['flush:sent']);
  });

  it('keeps the last window answer through an outage, and logs an outage once', async () => {
    const limits = limitsOf();
    const log = vi.fn<KeeperLog>();
    const { keeper } = keeperFor(world(), memoryStore([]), { limits, log });
    expect(await keeper.verify()).toBe(true);
    (limits as unknown as { bounds: ReturnLimits['bounds'] }).bounds = async () => Promise.reject(new ChainUnavailableError('cf down'));
    expect(await keeper.verify()).toBe(true);
    expect(await keeper.verify()).toBe(true);
    expect(log.mock.calls.filter(([level]) => level === 'warn')).toHaveLength(1);
  });

  it('refuses a deployment whose guardian is the keeper key', async () => {
    const w0 = world();
    const node = fakeNode({ getters: deployedGetters({ [`${FACTORY}:GUARDIAN()`]: w(KEEPER.toLowerCase()) }) });
    const { keeper, log } = keeperFor(w0, memoryStore([]), { chain: new SaleVaultProxyChain(node.rpc) });
    expect(await keeper.verify()).toBe(false);
    expect(log).toHaveBeenCalledWith('error', expect.stringMatching(/is unavailable: .*guardian .* is the keeper key/));
  });

  it('rethrows an unexpected failure', async () => {
    const { keeper } = keeperFor(world(), memoryStore(), { chain: new SaleVaultProxyChain(async () => Promise.reject(new TypeError('bug'))) });
    await expect(keeper.pass()).rejects.toThrow('bug');
  });
});

describe('action priority', () => {
  it("delivers a sale's gas-deferred amount first, under the sale's own terms and logged deadline", async () => {
    const w0 = world({ deferred: new Map([[DEADLINE, 50_000_000n]]), pending: 5n, balance: 50_000_000n });
    const mem = memoryStore();
    mem.deferrals.push(deferral());
    await keeperFor(w0, mem).keeper.pass();
    expect(mem.calls).toMatchObject([{ action: 'deliver', target: FACTORY, proxy: PROXY, amount: '50000000', status: 'sent', nonce: 7 }]);
    expect(w0.calls.find((c) => c.method === 'eth_estimateGas')?.params[0]).toMatchObject({
      to: FACTORY,
      data: encodeClaimerTermsCall('deliver(bytes32,address,bytes32,address,uint256,uint256)', TERMS, DEADLINE),
    });
  });

  it('delivers nothing for a sale whose terms are not known yet', async () => {
    const w0 = world({ deferred: new Map([[DEADLINE, 50_000_000n]]) });
    const mem = memoryStore([sale({ deposit_address: undefined })]);
    mem.deferrals.push(deferral());
    await keeperFor(w0, mem).keeper.pass();
    expect(mem.calls).toEqual([]);
  });

  it('delivers nothing while no log has recorded a deadline for the terms', async () => {
    const w0 = world({ deferred: new Map([[DEADLINE, 50_000_000n]]) });
    const mem = memoryStore();
    await keeperFor(w0, mem).keeper.pass();
    expect(mem.calls).toEqual([]);
  });

  it('delivers each deadline of the same terms in turn, skipping one already delivered', async () => {
    const later = DEADLINE + 3_600n;
    const w0 = world({ deferred: new Map([[DEADLINE, 0n], [later, 7_000_000n]]) });
    const mem = memoryStore();
    mem.deferrals.push(deferral(later), deferral());
    const { keeper } = keeperFor(w0, mem);
    await keeper.pass();
    expect(mem.calls).toMatchObject([{ action: 'deliver', amount: '7000000' }]);
    expect(w0.calls.filter((c) => c.method === 'eth_estimateGas').map((c) => (c.params[0] as { data: string }).data)).toEqual([
      encodeClaimerTermsCall('deliver(bytes32,address,bytes32,address,uint256,uint256)', TERMS, later),
    ]);
    // The next copy to defer under the first deadline is delivered on its own
    await mem.rows.settleProxyCall('call-1', 'mined');
    w0.state.proxy.deferred = new Map([[DEADLINE, 3_000_000n], [later, 0n]]);
    await keeper.pass();
    expect(mem.calls.map((c) => c.amount)).toEqual(['7000000', '3000000']);
    expect(w0.calls.filter((c) => c.method === 'eth_estimateGas').map((c) => (c.params[0] as { data: string }).data)[1]).toBe(
      encodeClaimerTermsCall('deliver(bytes32,address,bytes32,address,uint256,uint256)', TERMS, DEADLINE),
    );
  });

  it('flushes pending next', async () => {
    const w0 = world({ pending: 5n, balance: 50_000_000n });
    const mem = memoryStore();
    await keeperFor(w0, mem).keeper.pass();
    expect(mem.calls).toMatchObject([{ action: 'flush', target: FACTORY, proxy: PROXY, amount: '5', sender: KEEPER.toLowerCase() }]);
    expect(w0.state.sent).toHaveLength(1);
  });

  it('deploys an undeployed proxy holding any USDC, which leaves only through the proxy', async () => {
    for (const balance of [MIN_RETURN, 1n]) {
      const w0 = world({ deployed: false, balance });
      const mem = memoryStore();
      await keeperFor(w0, mem).keeper.pass();
      expect(actionsOf(mem)).toEqual(['deploy:sent']);
      expect(w0.calls.find((c) => c.method === 'eth_estimateGas')?.params[0]).toMatchObject({
        to: FACTORY,
        data: encodeHomeClaimerCall('deploy(bytes32,address)', HOME, CLAIMER),
      });
    }
  });

  it('leaves an undeployed proxy holding nothing alone, waiting for a log', async () => {
    const mem = memoryStore();
    await keeperFor(world({ deployed: false }), mem).keeper.pass();
    expect(mem.calls).toEqual([]);
    expect(mem.schedules).toEqual([{ proxy: PROXY, dueAt: null }]);
  });

  it('replays a deferred delivery past its deadline, and expires it when the replay would revert', async () => {
    const reverts = (data: string): unknown => {
      if (data.startsWith('0x67b12c52')) throw new RpcCallError('rpc eth_estimateGas error: execution reverted', 3);
      return '0x186a0';
    };
    const early = world({ deferred: new Map([[DEADLINE, 9n]]) });
    early.state.estimate = reverts;
    const before = memoryStore();
    before.deferrals.push(deferral());
    await keeperFor(early, before, { now: () => Number(DEADLINE) * 1000 }).keeper.pass();
    expect(actionsOf(before)).toEqual(['deliver:reverted']);

    const late = world({ deferred: new Map([[DEADLINE, 9n]]) });
    late.state.estimate = reverts;
    const after = memoryStore();
    after.deferrals.push(deferral());
    await keeperFor(late, after, { now: () => Number(DEADLINE) * 1000 + 1000 }).keeper.pass();
    expect(actionsOf(after)).toEqual(['deliver:reverted', 'expire:sent']);
    expect(late.calls.filter((c) => c.method === 'eth_estimateGas').map((c) => (c.params[0] as { data: string }).data)[1]).toBe(
      encodeClaimerTermsCall('expireDeferred(bytes32,address,bytes32,address,uint256,uint256)', TERMS, DEADLINE),
    );
  });

  it.each([
    ['under the maximum, the whole balance', 50_000_000n, 50_000_000n],
    ['over the maximum, a full chunk', 150_000_000n, 100_000_000n],
    ['just over the maximum, a chunk that leaves the minimum', 100_500_000n, 99_500_000n],
  ])('returns a due proxy %s', async (_name, balance, amount) => {
    const mem = memoryStore();
    const check = vi.fn(async () => undefined);
    const limits = { ...chainflipOf(), check, quotedOutput: async () => 10n ** 12n } as unknown as ReturnLimits;
    await keeperFor(world({ balance }), mem, { limits }).keeper.pass();
    expect(mem.calls).toMatchObject([{ action: 'return', target: PROXY, amount: amount.toString() }]);
    expect(check).toHaveBeenCalledWith(amount, expect.objectContaining({ retryBlocks: 100, broker: SEPOLIA.broker }));
  });

  it('releases a balance under the minimum to the claimer once releaseAt passes, and waits for it before', async () => {
    const mem = memoryStore();
    const { keeper } = keeperFor(world({ balance: 600_000n, releaseAt: BigInt(NOW / 1000 + 60) }), mem);
    await keeper.pass();
    expect(mem.calls).toEqual([]);
    expect(mem.schedules.at(-1)).toEqual({ proxy: PROXY, dueAt: NOW + 60_000 });
    expect((await keeper.trigger(sale())).blockedReason).toBe('below-minimum');

    const later = memoryStore();
    const w0 = world({ balance: 600_000n, releaseAt: BigInt(NOW / 1000), releasable: 600_000n });
    await keeperFor(w0, later).keeper.pass();
    expect(later.calls).toMatchObject([{ action: 'release', target: PROXY, proxy: PROXY, amount: '600000' }]);
    expect(w0.calls.find((c) => c.method === 'eth_estimateGas')?.params[0]).toMatchObject({ to: PROXY, data: encodeRelease() });
  });

  it('looks again next pass when releaseAt passed but the chain releases nothing yet', async () => {
    const mem = memoryStore();
    await keeperFor(world({ balance: 600_000n, releaseAt: BigInt(NOW / 1000 - 60) }), mem).keeper.pass();
    expect(mem.calls).toEqual([]);
    expect(mem.schedules.at(-1)).toEqual({ proxy: PROXY, dueAt: NOW });
  });

  it('still returns at the attempt cap while the contract keeps release shut on what the last return left', async () => {
    const mem = memoryStore();
    await keeperFor(world({ balance: 20_000_000n, attempts: 7n, nextReturnAt: 0n, releasable: 0n }), mem).keeper.pass();
    expect(mem.calls).toMatchObject([{ action: 'return', target: PROXY, amount: '20000000', status: 'sent' }]);
  });

  it('releases instead of returning once the factory is retired or the proxy is out of attempts', async () => {
    const retired = world({ balance: 20_000_000n, releaseAt: 0n, releasable: 20_000_000n });
    retired.state.retired = true;
    const a = memoryStore();
    await keeperFor(retired, a).keeper.pass();
    expect(actionsOf(a)).toEqual(['release:sent']);

    const spent = memoryStore();
    await keeperFor(world({ balance: 20_000_000n, attempts: 7n, releaseAt: 0n, releasable: 20_000_000n }), spent).keeper.pass();
    expect(actionsOf(spent)).toEqual(['release:sent']);
  });

  it('reads again next pass when state() and retired() come from nodes on either side of the retire', async () => {
    // state() before the retire, a refund with no clock yet
    const before = world({ balance: 20_000_000n, releaseAt: 2n ** 256n - 1n, releasable: 0n });
    before.state.retired = true;
    const a = memoryStore();
    const { keeper } = keeperFor(before, a);
    await keeper.verify();
    expect((await keeper.trigger(sale())).blockedReason).toBe('chain-unavailable');
    expect(a.calls).toEqual([]);
    expect(a.schedules.at(-1)).toEqual({ proxy: PROXY, dueAt: NOW });

    // state() after the retire, retired() before it
    const after = memoryStore();
    await keeperFor(world({ balance: 20_000_000n, releaseAt: 0n, releasable: 20_000_000n }), after).keeper.pass();
    expect(after.calls).toEqual([]);
    expect(after.schedules.at(-1)).toEqual({ proxy: PROXY, dueAt: NOW });
  });

  it('returns a balance that can go home even when the contract would release it, and releases it once the return is held back', async () => {
    const open = { balance: 20_000_000n, releaseAt: 5_184_000n, releasable: 20_000_000n };
    const home = memoryStore();
    await keeperFor(world(open), home).keeper.pass();
    expect(actionsOf(home)).toEqual(['return:sent']);

    const held = memoryStore();
    const limits = limitsOf({ check: async () => Promise.reject(new ReturnNotSwappableError('above maximum')) });
    await keeperFor(world(open), held, { limits }).keeper.pass();
    expect(actionsOf(held)).toEqual(['release:sent']);
  });

  it('skims the factory once its free balance is worth it, reading only totalPending', async () => {
    const w0 = world({}, 1_000_000n);
    w0.state.factoryBalance = 6_000_000n;
    const mem = memoryStore([]);
    const { keeper } = keeperFor(w0, mem);
    await keeper.verify();
    const before = w0.calls.length;
    await keeper.pass();
    expect(mem.calls).toMatchObject([{ action: 'skim', target: FACTORY, proxy: FACTORY, amount: '5000000' }]);
    const reads = w0.calls.slice(before).filter((c) => c.method === 'eth_call').map((c) => (c.params[0] as { data: string }).data);
    expect(reads).not.toContain(encodeCall('IMPLEMENTATION()'));
  });

  it('does nothing for an empty proxy and a factory under the skim threshold, and waits for a log', async () => {
    const w0 = world();
    w0.state.factoryBalance = 4_000_000n;
    const mem = memoryStore();
    const { keeper } = keeperFor(w0, mem);
    await keeper.pass();
    expect(mem.calls).toEqual([]);
    expect(mem.schedules).toEqual([{ proxy: PROXY, dueAt: null }]);
    expect((await keeper.trigger(sale())).blockedReason).toBeNull();
  });
});

describe('a return held back', () => {
  const base = { balance: 20_000_000n, attempts: 1n };

  it('is not due inside the backoff, and is looked at again when it is', async () => {
    const mem = memoryStore();
    const { keeper } = keeperFor(world({ ...base, nextReturnAt: BigInt(NOW / 1000 + 60) }), mem);
    await keeper.verify();
    expect((await keeper.trigger(sale())).blockedReason).toBe('not-due');
    expect(mem.calls).toEqual([]);
    expect(mem.schedules).toEqual([{ proxy: PROXY, dueAt: NOW + 60_000 }]);
  });

  it('is below the minimum until its release time', async () => {
    const mem = memoryStore();
    const waiting = keeperFor(world({ balance: 999_999n }), mem).keeper;
    await waiting.verify();
    expect((await waiting.trigger(sale())).blockedReason).toBe('below-minimum');
    expect(mem.calls).toEqual([]);
    expect(mem.schedules).toEqual([{ proxy: PROXY, dueAt: NOW + 86_400_000 }]);
  });

  it('keeps the latest hold a read cannot tell, until a judgement clears it', async () => {
    const limits = limitsOf();
    const w0 = world(base);
    const { keeper } = keeperFor(w0, memoryStore(), { limits });
    await keeper.verify();
    const vault = limits as unknown as { arbitrumVault: () => Promise<string> };
    vault.arbitrumVault = async () => `0x${'99'.repeat(20)}`;
    await keeper.pass();
    expect(keeper.hold(PROXY.toUpperCase())).toBe('vault-changed');
    // A static reason is left to the read
    w0.state.proxy.nextReturnAt = BigInt(NOW / 1000 + 60);
    await keeper.trigger(sale());
    expect(keeper.hold(PROXY)).toBeUndefined();
    w0.state.proxy.nextReturnAt = 0n;
    await keeper.trigger(sale());
    expect(keeper.hold(PROXY)).toBe('vault-changed');
    vault.arbitrumVault = async () => SEPOLIA.vault;
    await keeper.trigger(sale());
    expect(keeper.hold(PROXY)).toBeUndefined();
  });

  it('keeps chain-unavailable as a hold', async () => {
    const limits = limitsOf({ quote: async () => Promise.reject(new ChainUnavailableError('backend down')) });
    const { keeper } = keeperFor(world(base), memoryStore(), { limits });
    await keeper.verify();
    await keeper.trigger(sale());
    expect(keeper.hold(PROXY)).toBe('chain-unavailable');
  });

  it("is vault-changed, logged once until it clears, when Chainflip's live Arbitrum vault is not the proxy's", async () => {
    const mem = memoryStore();
    const limits = limitsOf();
    const log = vi.fn<KeeperLog>();
    const { keeper } = keeperFor(world(base), mem, { limits, log });
    await keeper.verify();
    (limits as unknown as { arbitrumVault: () => Promise<string> }).arbitrumVault = async () => `0x${'99'.repeat(20)}`;
    expect((await keeper.trigger(sale())).blockedReason).toBe('vault-changed');
    expect((await keeper.trigger(sale())).blockedReason).toBe('vault-changed');
    expect(log.mock.calls.filter(([, m]) => m.includes("Chainflip's Arbitrum vault is"))).toHaveLength(1);
    expect(mem.calls).toEqual([]);
    (limits as unknown as { arbitrumVault: () => Promise<string> }).arbitrumVault = async () => SEPOLIA.vault;
    await keeper.trigger(sale());
    expect(actionsOf(mem)).toEqual(['return:sent']);
  });

  it('is not swappable when Chainflip refuses the chunk', async () => {
    const mem = memoryStore();
    const limits = limitsOf({ check: async () => Promise.reject(new ReturnNotSwappableError('below minimum')) });
    const { keeper } = keeperFor(world(base), mem, { limits });
    await keeper.verify();
    expect((await keeper.trigger(sale())).blockedReason).toBe('not-swappable');
    expect(mem.calls).toEqual([]);
    expect(mem.schedules).toEqual([{ proxy: PROXY, dueAt: NOW }]);
  });

  it('is route-refused and alerts when Chainflip would refund the return', async () => {
    const mem = memoryStore();
    const refused = new ReturnNotSwappableError('broker is not a registered Chainflip broker', 'route-refused');
    const log = vi.fn<KeeperLog>();
    const { keeper } = keeperFor(world(base), mem, { limits: limitsOf({ check: async () => Promise.reject(refused) }), log });
    await keeper.verify();
    expect((await keeper.trigger(sale())).blockedReason).toBe('route-refused');
    expect((await keeper.trigger(sale())).blockedReason).toBe('route-refused');
    // Logged once per proxy and reason, not every pass
    expect(log.mock.calls.filter(([level]) => level === 'error')).toEqual([['error', `sale vault proxy ${PROXY} return held back: broker is not a registered Chainflip broker`]]);
    expect(mem.calls).toEqual([]);
  });

  it('is not swappable when the quote is under the floor plus margin', async () => {
    // floor = 20e6 * 0.99 - 0.05e6 = 19.75e6, plus 50 bps = 19,848,750
    const mem = memoryStore();
    const under = keeperFor(world(base), mem, { limits: limitsOf({ quote: 19_848_749n }) }).keeper;
    await under.verify();
    expect((await under.trigger(sale())).blockedReason).toBe('not-swappable');
    expect(mem.calls).toEqual([]);
    const at = keeperFor(world(base), mem, { limits: limitsOf({ quote: 19_848_750n }) }).keeper;
    await at.verify();
    await at.trigger(sale());
    expect(actionsOf(mem)).toEqual(['return:sent']);
  });

  it('is chain-unavailable when the quote cannot be read', async () => {
    const limits = limitsOf({ quote: async () => Promise.reject(new ChainUnavailableError('backend down')) });
    const { keeper } = keeperFor(world(base), memoryStore(), { limits });
    await keeper.verify();
    expect((await keeper.trigger(sale())).blockedReason).toBe('chain-unavailable');
  });

  it('surfaces an unexpected limits failure', async () => {
    const limits = limitsOf({ check: async () => Promise.reject(new TypeError('bug')) });
    const { keeper } = keeperFor(world(base), memoryStore(), { limits });
    await keeper.verify();
    await expect(keeper.trigger(sale())).rejects.toThrow('bug');
  });

  it('refuses a trigger for an unverified deployment or a proxy no sale names', async () => {
    const { keeper } = keeperFor(world(), memoryStore());
    await expect(keeper.trigger(sale())).rejects.toThrow(/not verified/);
    await keeper.verify();
    await expect(keeper.trigger(sale({ proxy: '0x9999999999999999999999999999999999999999' }))).rejects.toThrow(/no sale names/);
  });
});

describe('observing one sale', () => {
  it("reads the sale's record once deployed, its deferred amount over every logged deadline, and nothing without terms", async () => {
    const later = DEADLINE + 60n;
    const mem = memoryStore();
    const { keeper } = keeperFor(world({ deferred: new Map([[DEADLINE, 9n], [later, 4n]]) }), mem);
    expect(await keeper.observeSale(sale(), TERMS, false)).toEqual({ delivery: undefined, deferred: 0n });
    mem.deferrals.push(deferral(), deferral(later));
    expect(await keeper.observeSale(sale(), undefined, true)).toEqual({ delivery: undefined, deferred: 0n });
    expect(await keeper.observeSale(sale(), TERMS, false)).toEqual({ delivery: undefined, deferred: 13n });
    expect(await keeper.observeSale(sale(), TERMS, true)).toEqual({ delivery: { status: 1, amount: 50_400_000n, leftover: 400_000n }, deferred: 13n });
  });
});

describe('the log scan', () => {
  const log = (address: string, topics: string[]): RawLog => ({ address, topics, data: '0x', ...at() });
  const unbooked = (amount: bigint): RawLog => ({
    address: FACTORY,
    topics: [eventTopic('DeliveryUnbooked(bytes32,address,bytes32,address,uint256)'), HOME, addressTopic(PROXY), saleRef('funding-1')],
    data: `0x${w(CLAIMER)}${w(amount)}`,
    ...at(),
  });
  const factoryReads = (w0: ReturnType<typeof world>) => w0.state.logReads.filter((r) => Array.isArray((r.topics as unknown[])[0]));

  it('makes every watched sale due on the first scan and reads the watch window once, alerting on what it missed', async () => {
    const w0 = world();
    // 400 blocks span the watch window, so block 600 is its first
    w0.state.blockSeconds = BigInt(WATCH_SECONDS / 400);
    w0.state.factoryLogs = [unbooked(7n)];
    const mem = memoryStore([sale({ due_at: null })]);
    mem.setCursor(undefined);
    const log = vi.fn<KeeperLog>();
    await keeperFor(w0, mem, { log }).keeper.pass();
    expect(w0.state.timestampReads).toBeLessThanOrEqual(10);
    expect(factoryReads(w0).map((r) => [r.fromBlock, r.toBlock])).toEqual([
      ['0x258', '0x2bb'],
      ['0x2bc', '0x31f'],
      ['0x320', '0x383'],
      ['0x384', '0x3e7'],
      ['0x3e8', '0x3e8'],
    ]);
    expect(mem.cursor()).toBe(1_000n);
    expect(w0.state.firstLogReads).toEqual([]);
    expect(log.mock.calls.filter(([level]) => level === 'error')).toHaveLength(5);

    // Every block inside the window reads from block 1
    const young = world();
    young.state.head = 50n;
    const fresh = memoryStore([sale({ due_at: null })]);
    fresh.setCursor(undefined);
    await keeperFor(young, fresh).keeper.pass();
    expect(factoryReads(young).map((r) => [r.fromBlock, r.toBlock])).toEqual([['0x1', '0x32']]);
    expect(fresh.schedules.map((s) => s.proxy)).toEqual([PROXY]);
  });

  it('alerts only once the cursor is written, so a failed write alerts on the next pass alone', async () => {
    const w0 = world();
    w0.state.head = 50n;
    w0.state.factoryLogs = [unbooked(7n)];
    const mem = memoryStore([sale({ due_at: null })]);
    const write = mem.rows.writeCursor;
    mem.rows.writeCursor = async () => Promise.reject(new Error('db down'));
    const log = vi.fn<KeeperLog>();
    const { keeper } = keeperFor(w0, mem, { log });
    await keeper.pass();
    expect(log).toHaveBeenCalledWith('warn', expect.stringMatching(/log scan failed: db down/));
    expect(log.mock.calls.filter(([level]) => level === 'error')).toEqual([]);
    mem.rows.writeCursor = write;
    await keeper.pass();
    expect(log.mock.calls.filter(([level]) => level === 'error')).toHaveLength(1);
    expect(mem.cursor()).toBe(50n);
  });

  it('reads ranges for one interval a pass at most, so a retire closes new sells during a long catch-up', async () => {
    const w0 = world();
    w0.state.head = BigInt(SETTINGS.logRange * 25);
    const mem = memoryStore([sale({ due_at: null })]);
    // Each range read takes a tenth of the interval
    const { keeper } = keeperFor(w0, mem, { now: () => NOW + (factoryReads(w0).length * SETTINGS.intervalMs) / 10 });
    await keeper.pass();
    expect(factoryReads(w0)).toHaveLength(10);
    expect(mem.cursor()).toBe(BigInt(SETTINGS.logRange * 10));
    expect(keeper.verified()?.factory).toBe(FACTORY);
    w0.state.retired = true;
    await keeper.pass();
    expect(keeper.verified()).toBeUndefined();
    expect(factoryReads(w0)).toHaveLength(20);
    await keeper.pass();
    expect(factoryReads(w0)).toHaveLength(25);
    expect(mem.cursor()).toBe(w0.state.head);
  });

  it('starts a fresh cursor before the first factory log in the watch window when no sale is recorded', async () => {
    const w0 = world();
    // 400 blocks span the watch window, so block 600 is its first
    w0.state.blockSeconds = BigInt(WATCH_SECONDS / 400);
    w0.state.firstLogs.set(FACTORY, 900n);
    const mem = memoryStore([]);
    mem.setCursor(undefined);
    await keeperFor(w0, mem).keeper.pass();
    expect(w0.state.firstLogReads).toEqual([{ address: FACTORY, fromBlock: 600n, toBlock: 1_000n }]);
    expect(factoryReads(w0).map((r) => r.fromBlock)).toEqual(['0x384', '0x3e8']);
    expect(mem.cursor()).toBe(1_000n);

    // A factory that logged nothing inside the window starts at the head, never before the window
    const quiet = world();
    quiet.state.blockSeconds = BigInt(WATCH_SECONDS / 400);
    quiet.state.firstLogs.set(FACTORY, 300n);
    const none = memoryStore([]);
    none.setCursor(undefined);
    await keeperFor(quiet, none).keeper.pass();
    expect(quiet.state.firstLogReads).toEqual([{ address: FACTORY, fromBlock: 600n, toBlock: 1_000n }]);
    expect(factoryReads(quiet)).toEqual([]);
    expect(none.cursor()).toBe(1_000n);

    // An idle recorded sale keeps the window start, since its proxy's own logs need no factory log first
    const idle = world();
    idle.state.firstLogs.set(FACTORY, 900n);
    const old = memoryStore([sale({ due_at: null, last_activity_at: NOW - (WATCH_SECONDS + 1) * 1000 })]);
    old.setCursor(undefined);
    await keeperFor(idle, old).keeper.pass();
    expect(idle.state.firstLogReads).toEqual([]);
    expect(factoryReads(idle)[0]?.fromBlock).toBe('0x1');
  });

  it('never moves an existing cursor to a first log, nor back when the node is behind it', async () => {
    const w0 = world();
    w0.state.firstLogs.set(FACTORY, 900n);
    const mem = memoryStore([]);
    mem.setCursor(500n);
    const { keeper } = keeperFor(w0, mem);
    await keeper.pass();
    expect(w0.state.firstLogReads).toEqual([]);
    expect(factoryReads(w0)[0]?.fromBlock).toBe('0x1f5');
    expect(mem.cursor()).toBe(1_000n);
    mem.setCursor(1_200n);
    await keeper.pass();
    expect(factoryReads(w0)).toHaveLength(5);
    expect(mem.cursor()).toBe(1_200n);
  });

  it('takes the earliest first log of the configured and retired factories, and the window start while one is unverified', async () => {
    const retired = [{ factory: OLD_FACTORY, vault: SEPOLIA.vault, usdc: SEPOLIA.usdc }];
    const w0 = world({}, 0n, BigInt(WATCH_SECONDS), oldDeployment());
    w0.state.firstLogs.set(FACTORY, 800n);
    w0.state.firstLogs.set(OLD_FACTORY, 650n);
    const mem = memoryStore([]);
    mem.setCursor(undefined);
    await keeperFor(w0, mem, { retired }).keeper.pass();
    expect(w0.state.firstLogReads).toEqual([
      { address: FACTORY, fromBlock: 1n, toBlock: 1_000n },
      { address: OLD_FACTORY, fromBlock: 1n, toBlock: 799n },
    ]);
    expect(factoryReads(w0)[0]).toMatchObject({ address: [FACTORY, OLD_FACTORY], fromBlock: '0x28a' });

    const unverified = world();
    unverified.state.firstLogs.set(FACTORY, 800n);
    const fresh = memoryStore([]);
    fresh.setCursor(undefined);
    await keeperFor(unverified, fresh, { retired }).keeper.pass();
    expect(unverified.state.firstLogReads).toEqual([]);
    expect(factoryReads(unverified)[0]?.fromBlock).toBe('0x1');
  });

  it('holds the shared cursor while the chain leaves a retired deployment unverified, then reads its blocks with it', async () => {
    const retired = [{ factory: OLD_FACTORY, vault: SEPOLIA.vault, usdc: SEPOLIA.usdc }];
    const w0 = world({}, 0n, BigInt(WATCH_SECONDS), oldDeployment());
    const mem = memoryStore([]);
    mem.setCursor(500n);
    let blip = true;
    const chain = new SaleVaultProxyChain(async (method: string, params: unknown[]) => {
      const target = method === 'eth_call' ? (params as [{ to?: string }])[0].to : method === 'eth_getCode' ? (params as string[])[0] : undefined;
      if (blip && target === OLD_FACTORY) throw new ChainUnavailableError('blip');
      return w0.rpc(method, params);
    });
    const { keeper } = keeperFor(w0, mem, { retired, chain });
    await keeper.pass();
    expect(keeper.verifiedFor(421614, OLD_FACTORY)).toBeUndefined();
    expect(factoryReads(w0)).toEqual([]);
    expect(mem.cursor()).toBe(500n);
    blip = false;
    await keeper.pass();
    expect(factoryReads(w0)[0]).toMatchObject({ address: [FACTORY, OLD_FACTORY], fromBlock: '0x1f5' });
    expect(mem.cursor()).toBe(1_000n);
  });

  it('halves the first-log span while the node refuses it, down to log_range, and scans from the window start past that', async () => {
    const w0 = world();
    w0.state.firstLogs.set(FACTORY, 750n);
    w0.state.firstLogLimit = 300n;
    const mem = memoryStore([]);
    mem.setCursor(undefined);
    const log = vi.fn<KeeperLog>();
    const { keeper } = keeperFor(w0, mem, { log });
    await keeper.pass();
    expect(w0.state.firstLogReads.map((r) => [r.fromBlock, r.toBlock])).toEqual([
      [1n, 1_000n],
      [1n, 500n],
      [1n, 250n],
      [251n, 500n],
      [501n, 750n],
    ]);
    expect(factoryReads(w0)[0]?.fromBlock).toBe('0x2ee');

    const strict = world();
    strict.state.firstLogs.set(FACTORY, 750n);
    strict.state.firstLogLimit = BigInt(SETTINGS.logRange - 1);
    const fresh = memoryStore([]);
    fresh.setCursor(undefined);
    const warn = keeperFor(strict, fresh, { log });
    await warn.keeper.pass();
    expect(log).toHaveBeenCalledWith('warn', expect.stringMatching(/first log search failed, scanning from the watch window start: .*too many blocks/));
    expect(log).not.toHaveBeenCalledWith('warn', expect.stringMatching(/log scan failed/));
    expect(factoryReads(strict)[0]?.fromBlock).toBe('0x1');
    expect(fresh.cursor()).toBe(1_000n);
  });

  it('gives up the first-log search after one interval and scans from the window start', async () => {
    const w0 = world();
    w0.state.firstLogs.set(FACTORY, 750n);
    w0.state.firstLogLimit = BigInt(SETTINGS.logRange);
    const mem = memoryStore([]);
    mem.setCursor(undefined);
    const log = vi.fn<KeeperLog>();
    // Each first-log read takes a quarter of the interval
    await keeperFor(w0, mem, { log, now: () => NOW + (w0.state.firstLogReads.length * SETTINGS.intervalMs) / 4 }).keeper.pass();
    expect(w0.state.firstLogReads.length).toBeLessThanOrEqual(4);
    expect(log).toHaveBeenCalledWith('warn', expect.stringMatching(/first log search failed, .*within one interval/));
    expect(factoryReads(w0)[0]?.fromBlock).toBe('0x1');
    expect(mem.cursor()).toBe(100n);
  });

  it('reads factory moves and transfers to watched proxies in ranges, and makes only the sales they name due', async () => {
    const w0 = world();
    w0.state.head = 250n;
    const QUIET = '0x8888888888888888888888888888888888888888';
    const transfer = eventTopic('Transfer(address,address,uint256)');
    w0.state.factoryLogs = [deferredLog(0n)];
    w0.state.transferLogs = [log(SEPOLIA.usdc, [transfer, addressTopic(SEPOLIA.vault), addressTopic(QUIET)])];
    const quiet = sale({ funding_request_id: 'funding-2', home: `0x${'cd'.repeat(32)}`, proxy: QUIET, due_at: null });
    const mem = memoryStore([sale({ due_at: null }), quiet]);
    await keeperFor(w0, mem).keeper.pass();
    expect(w0.state.logReads.map((r) => [r.fromBlock, r.toBlock])).toEqual(
      [['0x1', '0x64'], ['0x65', '0xc8'], ['0xc9', '0xfa']].flatMap((range) => [range, range, range]),
    );
    expect(w0.state.logReads[0]).toMatchObject({
      address: [FACTORY],
      topics: [
        [
          'Delivered(bytes32,address,bytes32,address,address,uint256,uint256)',
          'DeliveryDeferred(bytes32,address,bytes32,address,uint256,uint256,uint256)',
          'DeliveryPending(bytes32,address,bytes32,uint256,bytes32)',
          'DeliveryUnbooked(bytes32,address,bytes32,address,uint256)',
          'DeferredExpired(bytes32,address,bytes32,address,uint256,uint256,uint256)',
          'PendingFlushed(bytes32,address,address,uint256)',
          'Unattributed(address,uint256,bytes32)',
          'Retired()',
        ].map(eventTopic),
      ],
    });
    expect(w0.state.logReads[1]).toEqual({ topics: [RELEASED], fromBlock: '0x1', toBlock: '0x64' });
    expect(w0.state.logReads[2]).toMatchObject({ address: SEPOLIA.usdc, topics: [transfer, null, [addressTopic(QUIET), addressTopic(PROXY)]] });
    expect(mem.marked[0]).toEqual({ homes: [HOME], proxies: [], dust: [QUIET] });
    expect(mem.cursor()).toBe(250n);
    // The other proxy is due too, the fake chain only answers for PROXY
    expect(mem.sales[1]?.due_at).toBe(NOW);
    expect(mem.schedules.map((s) => s.proxy)).toEqual([PROXY]);
  });

  it('alerts on every unbooked or pending delivery it reads, naming its home and ref, and keeps scanning', async () => {
    const w0 = world();
    w0.state.head = 50n;
    const ref = saleRef('funding-1');
    const reason = Buffer.from('deploy').toString('hex').padEnd(64, '0');
    const pendingTopic = eventTopic('DeliveryPending(bytes32,address,bytes32,uint256,bytes32)');
    w0.state.factoryLogs = [
      unbooked(7n),
      { address: FACTORY, topics: [pendingTopic, HOME, addressTopic(CLAIMER), ref], data: `0x${w(9n)}${reason}`, ...at(1) },
      deferredLog(0n),
      deferredLog(5n, DEADLINE, 'DeferredExpired'),
      { address: FACTORY, topics: [pendingTopic, HOME], data: '0x', ...at(2) },
    ];
    const mem = memoryStore([sale({ due_at: null })]);
    const logged = vi.fn<KeeperLog>();
    await keeperFor(w0, mem, { log: logged }).keeper.pass();
    const errors = logged.mock.calls.filter(([level]) => level === 'error').map(([, message]) => message);
    expect(errors).toEqual([
      `sale vault proxy factory ${FACTORY} left 7 USDC base units unbooked on proxy ${PROXY} for home ${HOME} claimer ${CLAIMER} ref ${ref}`,
      `sale vault proxy factory ${FACTORY} pended 9 USDC base units (deploy) for home ${HOME} claimer ${CLAIMER} ref ${ref}`,
      `sale vault proxy factory ${FACTORY} moved 5 USDC base units deferred past deadline ${DEADLINE.toString()} to pending for home ${HOME} claimer ${CLAIMER} ref ${ref}, a flush sends it to the proxy or the claimer`,
      `sale vault proxy factory ${FACTORY} logged an unreadable missed booking: return data has no word 0`,
    ]);
    expect(mem.marked[0]?.homes).toEqual([HOME, HOME, HOME, HOME, HOME]);
    expect(mem.cursor()).toBe(50n);
  });

  it('records each deferred delivery it reads with its deadline and delivers it in the same pass', async () => {
    const w0 = world({ deferred: new Map([[DEADLINE, 49_000_000n]]) });
    w0.state.head = 50n;
    w0.state.factoryLogs = [deferredLog(49_000_000n)];
    const mem = memoryStore([sale({ due_at: null })]);
    await keeperFor(w0, mem).keeper.pass();
    expect(mem.deferrals).toEqual([deferral()]);
    expect(mem.calls).toMatchObject([{ action: 'deliver', target: FACTORY, amount: '49000000', status: 'sent' }]);
    expect(w0.calls.find((c) => c.method === 'eth_estimateGas')?.params[0]).toMatchObject({
      data: encodeClaimerTermsCall('deliver(bytes32,address,bytes32,address,uint256,uint256)', TERMS, DEADLINE),
    });
  });

  it('records two deadlines of the same terms apart, and adds nothing when a range is read again', async () => {
    const w0 = world();
    w0.state.head = 50n;
    const later = DEADLINE + 3_600n;
    w0.state.factoryLogs = [deferredLog(1n), deferredLog(2n, later), deferredLog(3n)];
    const mem = memoryStore([sale({ due_at: null })]);
    const recorded = vi.spyOn(mem.rows, 'recordDeferrals');
    const { keeper } = keeperFor(w0, mem);
    await keeper.pass();
    expect(mem.deferrals).toEqual([deferral(), deferral(later)]);
    mem.setCursor(0n);
    await keeper.pass();
    expect(recorded).toHaveBeenCalledTimes(2);
    expect(mem.deferrals).toEqual([deferral(), deferral(later)]);
  });

  it('alerts on a deferred delivery it cannot read once the cursor moves, and records the rest', async () => {
    const w0 = world();
    w0.state.head = 50n;
    w0.state.factoryLogs = [
      { ...deferredLog(1n), topics: deferredLog(1n).topics.slice(0, 3) },
      { ...deferredLog(1n), data: `0x${w(1n)}` },
      deferredLog(1n),
    ];
    const mem = memoryStore([sale({ due_at: null })]);
    const logged = vi.fn<KeeperLog>();
    await keeperFor(w0, mem, { log: logged }).keeper.pass();
    expect(logged.mock.calls.filter(([level]) => level === 'error').map(([, message]) => message)).toEqual([
      `sale vault proxy factory ${FACTORY} logged an unreadable deferred delivery: deferral log has no home, claimer or third topic`,
      `sale vault proxy factory ${FACTORY} logged an unreadable deferred delivery: deferral log data is not four words: 0x${w(1n)}`,
    ]);
    expect(mem.deferrals).toEqual([deferral()]);
    expect(mem.cursor()).toBe(50n);
  });

  it('returns a provider refund sent from any address once its transfer is seen', async () => {
    const w0 = world({ balance: 20_000_000n });
    w0.state.head = 50n;
    const provider = '0x6666666666666666666666666666666666666666';
    w0.state.transferLogs = [{ ...log(SEPOLIA.usdc, [eventTopic('Transfer(address,address,uint256)'), addressTopic(provider), addressTopic(PROXY)]), data: `0x${w(MIN_RETURN)}` }];
    const mem = memoryStore([sale({ due_at: null })]);
    await keeperFor(w0, mem).keeper.pass();
    expect(mem.marked[0]).toEqual({ homes: [], proxies: [PROXY], dust: [] });
    expect(mem.calls).toMatchObject([{ action: 'return', target: PROXY, amount: '20000000', status: 'sent' }]);
  });

  it('reads transfers in chunks of watched proxies, and none when nothing is watched', async () => {
    const w0 = world();
    w0.state.head = 50n;
    const many = Array.from({ length: PROXY_TOPIC_CHUNK + 1 }, (_, i) =>
      sale({ funding_request_id: `funding-${String(i)}`, proxy: `0x${(i + 1).toString(16).padStart(40, '0')}`, due_at: null }),
    );
    await keeperFor(w0, memoryStore(many)).keeper.pass();
    const transfers = w0.state.logReads.filter((r) => typeof r.address === 'string').map((r) => (r.topics as [string, null, string[]])[2]);
    expect(transfers.map((t) => t.length)).toEqual([PROXY_TOPIC_CHUNK, 1]);
    // One release read by topic, whatever the number of proxies
    expect(w0.state.logReads.filter((r) => (r.topics as unknown[])[0] === RELEASED).map((r) => r.address)).toEqual([undefined]);

    const idle = world();
    idle.state.head = 50n;
    await keeperFor(idle, memoryStore([])).keeper.pass();
    expect(idle.state.logReads.map((r) => (r.topics as unknown[])[0] === RELEASED || Array.isArray(r.address))).toEqual([true, true]);
  });

  it('still judges due proxies when the log read fails, and keeps the cursor', async () => {
    const w0 = world({ pending: 5n });
    w0.state.logsFail = true;
    const mem = memoryStore();
    const { keeper, log } = keeperFor(w0, mem);
    await keeper.pass();
    expect(log).toHaveBeenCalledWith('warn', expect.stringMatching(/log scan failed: .*max results/));
    expect(mem.cursor()).toBe(0n);
    expect(actionsOf(mem)).toEqual(['flush:sent']);
  });

  it('keeps a due time a log set while the proxy was being judged', async () => {
    const mem = memoryStore();
    const { keeper } = keeperFor(world(), mem, { now: () => NOW + 1 });
    await keeper.verify();
    const schedule = mem.rows.schedule;
    mem.rows.schedule = async (a) => {
      for (const s of mem.sales) s.due_at = NOW + 5;
      await schedule(a);
    };
    await keeper.trigger(sale());
    expect(mem.sales[0]?.due_at).toBe(NOW + 5);
  });
});

describe('the watch window', () => {
  const transfer = (to: string, value: bigint | undefined): RawLog => ({
    address: SEPOLIA.usdc,
    topics: [eventTopic('Transfer(address,address,uint256)'), addressTopic(SEPOLIA.vault), addressTopic(to)],
    data: value === undefined ? '0x' : `0x${w(value)}`,
    ...at(),
  });
  const OLD = NOW - (WATCH_SECONDS + 86_400) * 1000;

  it("watches a proxy for the deployment's STALE_DELAY, not a fixed window", async () => {
    for (const [staleDays, watched] of [
      [60, true],
      [30, false],
    ] as const) {
      const mem = memoryStore([sale({ last_activity_at: NOW - 45 * 86_400_000 })]);
      await keeperFor(world({}, 0n, BigInt(staleDays * 86_400)), mem).keeper.pass();
      expect(mem.schedules.length > 0).toBe(watched);
    }
  });

  it('counts a transfer of at least MIN_RETURN as activity, makes a smaller or unreadable one due only, and skips one with no receiver', async () => {
    const w0 = world();
    w0.state.head = 50n;
    const OTHER = '0x8888888888888888888888888888888888888888';
    const noTarget = { ...transfer(OTHER, MIN_RETURN), topics: transfer(OTHER, MIN_RETURN).topics.slice(0, 2) };
    w0.state.transferLogs = [transfer(PROXY, MIN_RETURN), transfer(OTHER, MIN_RETURN - 1n), transfer(OTHER, undefined), noTarget];
    const other = sale({ funding_request_id: 'funding-2', home: `0x${'cd'.repeat(32)}`, proxy: OTHER, due_at: null });
    const mem = memoryStore([sale({ due_at: null }), other]);
    await keeperFor(w0, mem).keeper.pass();
    expect(mem.marked[0]).toEqual({ homes: [], proxies: [PROXY], dust: [OTHER, OTHER] });
    expect(mem.sales.map((s) => s.last_activity_at)).toEqual([NOW, NOW - 1_000]);
    expect(mem.sales[1]?.due_at).toBe(NOW);
  });

  it('records a release anyone sent on a proxy past the window, and watches it again', async () => {
    const w0 = world();
    w0.state.head = 50n;
    w0.state.releasedLogs = [{ address: PROXY, topics: [RELEASED], data: `0x${w(6n)}`, ...at(3) }];
    const mem = memoryStore([sale({ due_at: null, last_activity_at: OLD })]);
    await keeperFor(w0, mem).keeper.pass();
    expect(mem.payouts).toEqual([
      { chain_id: 421614, tx_hash: `0x${'ee'.repeat(32)}`, log_index: 3, factory: FACTORY, home: HOME, claimer: CLAIMER, kind: 'released', amount: 6n },
    ]);
    expect(mem.marked[0]).toEqual({ homes: [], proxies: [PROXY], dust: [] });
    expect(mem.sales[0]?.last_activity_at).toBe(NOW);
  });

  it('keeps watching a proxy whose factory logged within the window, however old its sale', async () => {
    const w0 = world({ pending: 5n });
    w0.state.head = 50n;
    w0.state.factoryLogs = [deferredLog(0n)];
    const mem = memoryStore([sale({ due_at: null, last_activity_at: OLD })]);
    await keeperFor(w0, mem).keeper.pass();
    expect(mem.sales[0]?.last_activity_at).toBe(NOW);
    expect(actionsOf(mem)).toEqual(['flush:sent']);
  });

  it('checks idle proxies longest unchecked first, watches again one that can go home and only marks the rest checked', async () => {
    const w0 = world({ balance: MIN_RETURN });
    w0.state.head = 50n;
    const EMPTY = '0x8888888888888888888888888888888888888888';
    const empty = sale({ funding_request_id: 'funding-2', home: `0x${'cd'.repeat(32)}`, proxy: EMPTY, due_at: null, last_activity_at: OLD, updated_at: 1 });
    const mem = memoryStore([sale({ due_at: null, last_activity_at: OLD, updated_at: 2 }), empty]);
    const chain = new SaleVaultProxyChain(async (method, params) => {
      const call = params[0] as { to?: string; data?: string } | undefined;
      if (method === 'eth_call' && call?.to === EMPTY) return '0x';
      if (method === 'eth_call' && call?.data === encodeBalanceOf(EMPTY)) return `0x${w(0n)}`;
      return w0.rpc(method, params);
    });
    await keeperFor(w0, mem, { chain }).keeper.pass();
    expect(mem.marked).toEqual([{ homes: [], proxies: [PROXY], dust: [] }]);
    expect(mem.sales.map((s) => [s.last_activity_at, s.updated_at])).toEqual([[NOW, NOW], [OLD, NOW]]);
    expect(actionsOf(mem)).toEqual(['return:sent']);
  });

  it('watches again an idle proxy whose release is open, or that holds USDC undeployed', async () => {
    const OLD_SALE = { due_at: null, last_activity_at: OLD };
    const open = world({ balance: 5n, releaseAt: 0n, releasable: 5n });
    open.state.head = 50n;
    const a = memoryStore([sale(OLD_SALE)]);
    await keeperFor(open, a).keeper.pass();
    expect(actionsOf(a)).toEqual(['release:sent']);

    const closed = world({ balance: 5n });
    closed.state.head = 50n;
    const b = memoryStore([sale(OLD_SALE)]);
    await keeperFor(closed, b).keeper.pass();
    expect(b.marked).toEqual([]);

    const undeployed = world({ deployed: false, balance: 5n });
    undeployed.state.head = 50n;
    const c = memoryStore([sale(OLD_SALE)]);
    await keeperFor(undeployed, c).keeper.pass();
    expect(actionsOf(c)).toEqual(['deploy:sent']);
  });

  it('warns and carries on when the idle check fails', async () => {
    const w0 = world({ pending: 5n });
    w0.state.head = 50n;
    const mem = memoryStore();
    mem.rows.idleProxies = async () => Promise.reject(new Error('db down'));
    const log = vi.fn<KeeperLog>();
    await keeperFor(w0, mem, { log }).keeper.pass();
    expect(log).toHaveBeenCalledWith('warn', 'sale vault proxy idle check failed: db down');
    expect(actionsOf(mem)).toEqual(['flush:sent']);
  });
});

describe('the factory and Chainflip alerts', () => {
  const unattributed = (reason: string, data?: string): RawLog => ({
    address: FACTORY,
    topics: [eventTopic('Unattributed(address,uint256,bytes32)'), addressTopic(SEPOLIA.usdc)],
    data: data ?? `0x${w(3_000_000n)}${Buffer.from(reason).toString('hex').padEnd(64, '0')}`,
    ...at(),
  });

  it('alerts on every unattributed delivery once the cursor moves, and never reads its token as a home', async () => {
    const w0 = world();
    w0.state.head = 50n;
    w0.state.factoryLogs = [unattributed('message'), unattributed('claimer'), unattributed('token', '0x')];
    const mem = memoryStore([sale({ due_at: null })]);
    const log = vi.fn<KeeperLog>();
    await keeperFor(w0, mem, { log }).keeper.pass();
    expect(log.mock.calls.filter(([level]) => level === 'error').map(([, message]) => message)).toEqual([
      `sale vault proxy factory ${FACTORY} left 3000000 base units of token ${SEPOLIA.usdc} unattributed (message) in blocks 1 to 50, a skim sends it to the treasury`,
      `sale vault proxy factory ${FACTORY} left 3000000 base units of token ${SEPOLIA.usdc} unattributed (claimer) in blocks 1 to 50, a skim sends it to the treasury`,
      `sale vault proxy factory ${FACTORY} logged an unreadable unattributed delivery: return data has no word 0`,
    ]);
    expect(mem.marked).toEqual([]);
    expect(mem.cursor()).toBe(50n);
  });

  const ccm = (overrides: Partial<FailedCcm> = {}): FailedCcm => ({
    broadcastId: 3926,
    originalEpoch: 1075,
    contract: SEPOLIA.vault,
    recipient: FACTORY,
    token: SEPOLIA.usdc,
    amount: 9_141_495n,
    home: HOME,
    claimer: CLAIMER,
    ...overrides,
  });

  it('alerts on a Retired log once the cursor moves, and makes every proxy of the factory due and watched, idle ones too', async () => {
    const w0 = world({ balance: 20_000_000n, nextReturnAt: BigInt(NOW / 1000) + 3_600n, releaseAt: 0n, releasable: 20_000_000n });
    w0.state.head = 50n;
    w0.state.retired = true;
    w0.state.factoryLogs = [{ address: FACTORY, topics: [eventTopic('Retired()')], data: '0x', ...at() }];
    // Scheduled for its old backoff and past the watch window
    const mem = memoryStore([sale({ due_at: NOW + 3_600_000, last_activity_at: NOW - 61 * 86_400_000 })]);
    const log = vi.fn<KeeperLog>();
    await keeperFor(w0, mem, { log }).keeper.pass();
    expect(log).toHaveBeenCalledWith(
      'error',
      `sale vault proxy factory ${FACTORY} was retired by its guardian: returns home stop and every proxy releases to its claimer`,
    );
    expect(mem.marked).toEqual([]);
    expect(mem.activated).toEqual([[FACTORY]]);
    expect(mem.sales[0]?.last_activity_at).toBe(NOW);
    expect(actionsOf(mem)).toEqual(['release:sent']);
  });

  it('records each release and each flush its proxy refused, once, alerting on one it cannot read', async () => {
    const w0 = world();
    w0.state.head = 50n;
    const flushed = (to: string, index: number): RawLog => ({
      address: FACTORY,
      topics: [eventTopic('PendingFlushed(bytes32,address,address,uint256)'), HOME, addressTopic(CLAIMER), addressTopic(to)],
      data: `0x${w(4n)}`,
      ...at(index),
    });
    const STRANGER = '0x7777777777777777777777777777777777777777';
    w0.state.factoryLogs = [flushed(CLAIMER, 0), flushed(PROXY, 1), { ...flushed(CLAIMER, 2), topics: flushed(CLAIMER, 2).topics.slice(0, 2) }];
    w0.state.releasedLogs = [
      { address: PROXY, topics: [RELEASED], data: `0x${w(6n)}`, ...at(3) },
      { address: PROXY, topics: [RELEASED], data: '0x', ...at(4) },
      { address: STRANGER, topics: [RELEASED], data: `0x${w(1n)}`, ...at(5) },
    ];
    const mem = memoryStore([sale({ due_at: null })]);
    const log = vi.fn<KeeperLog>();
    const { keeper } = keeperFor(w0, mem, { log });
    await keeper.pass();
    const row = { chain_id: 421614, tx_hash: `0x${'ee'.repeat(32)}`, factory: FACTORY, home: HOME, claimer: CLAIMER };
    expect(mem.payouts).toEqual([
      { ...row, log_index: 0, kind: 'flushed', amount: 4n },
      { ...row, log_index: 3, kind: 'released', amount: 6n },
    ]);
    // Another contract's log under the same topic is not ours, so it is skipped without an alert
    expect(log.mock.calls.filter(([level]) => level === 'error').map(([, m]) => m)).toEqual([
      `sale vault proxy factory ${FACTORY} logged an unreadable flush: PendingFlushed log has no home, claimer or third topic`,
      `sale vault proxy ${PROXY} logged an unreadable release: return data has no word 0`,
    ]);
    expect(mem.marked[0]?.proxies).toEqual([PROXY]);
    mem.setCursor(0n);
    await keeper.pass();
    expect(mem.payouts).toHaveLength(2);
  });

  it('alerts once per broadcast and epoch on a failed CCM to one of our factories, and ignores any other receiver', async () => {
    let failed = [ccm(), ccm({ broadcastId: 1, recipient: `0x${'33'.repeat(20)}` }), ccm({ broadcastId: 2, home: undefined, claimer: undefined })];
    const log = vi.fn<KeeperLog>();
    const { keeper } = keeperFor(world(), memoryStore([]), { log, failedCalls: { failedCcms: async () => failed } });
    await keeper.pass();
    await keeper.pass();
    failed = [ccm({ originalEpoch: 1076 })];
    await keeper.pass();
    expect(log.mock.calls.filter(([level]) => level === 'error').map(([, message]) => message)).toEqual([
      `Chainflip CCM broadcast 3926 to sale vault proxy factory ${FACTORY} failed: 9141495 base units of token ${SEPOLIA.usdc} for home ${HOME} claimer ${CLAIMER} stay in the Vault until the cf_failed_call_arbitrum payload is sent to ${SEPOLIA.vault}, before epoch 1077`,
      `Chainflip CCM broadcast 2 to sale vault proxy factory ${FACTORY} failed: 9141495 base units of token ${SEPOLIA.usdc} for home unknown claimer unknown stay in the Vault until the cf_failed_call_arbitrum payload is sent to ${SEPOLIA.vault}, before epoch 1077`,
      `Chainflip CCM broadcast 3926 to sale vault proxy factory ${FACTORY} failed: 9141495 base units of token ${SEPOLIA.usdc} for home ${HOME} claimer ${CLAIMER} stay in the Vault until the cf_failed_call_arbitrum payload is sent to ${SEPOLIA.vault}, before epoch 1078`,
    ]);
  });

  it('warns when the failed CCMs cannot be read', async () => {
    const log = vi.fn<KeeperLog>();
    const failedCalls = { failedCcms: async () => Promise.reject(new ChainUnavailableError('state chain down')) };
    await keeperFor(world(), memoryStore([]), { log, failedCalls }).keeper.pass();
    expect(log).toHaveBeenCalledWith('warn', 'sale vault proxy failed CCM check failed: state chain down');
  });
});

describe('sending', () => {
  it('records a reverting estimate as reverted and broadcasts nothing', async () => {
    const w0 = world({ pending: 5n });
    w0.state.estimate = () => {
      throw new RpcCallError('rpc eth_estimateGas error: execution reverted', 3);
    };
    const mem = memoryStore();
    await keeperFor(w0, mem).keeper.pass();
    expect(mem.calls).toMatchObject([{ status: 'reverted', error: 'rpc eth_estimateGas error: execution reverted' }]);
    expect(w0.state.sent).toEqual([]);
    // Looked at again after the resend window, not every pass
    expect(mem.schedules).toEqual([{ proxy: PROXY, dueAt: NOW + SETTINGS.resendMs }]);
  });

  it('drops the claim on a node error that is not a revert, and moves on', async () => {
    const w0 = world({ pending: 5n });
    w0.state.estimate = () => {
      throw new RpcCallError('rpc eth_estimateGas error: header not found', -32000);
    };
    const mem = memoryStore();
    const { keeper, log } = keeperFor(w0, mem);
    await keeper.pass();
    expect(mem.calls).toMatchObject([{ status: 'dropped', error: 'rpc eth_estimateGas error: header not found' }]);
    expect(log).toHaveBeenCalledWith('warn', expect.stringMatching(/not evaluated/));
  });

  it('marks the call sent before the broadcast, and leaves it sent when the broadcast fails', async () => {
    const w0 = world({ pending: 5n });
    w0.state.sendFails = true;
    const mem = memoryStore();
    const { keeper, log } = keeperFor(w0, mem);
    await keeper.pass();
    expect(mem.calls).toMatchObject([{ status: 'sent', nonce: 7 }]);
    expect(mem.calls[0]?.tx_hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(log).toHaveBeenCalledWith('warn', expect.stringMatching(/broadcast .* failed/));
  });

  it('skips a proxy another call already claimed', async () => {
    const mem = memoryStore();
    await mem.rows.claimProxyCall({ id: 'other', chain_id: 421614, sender: KEEPER, target: FACTORY, proxy: PROXY, action: 'flush', amount: null });
    const { keeper } = keeperFor(world({ pending: 5n }), mem);
    await keeper.verify();
    await keeper.trigger(sale());
    expect(mem.calls.map((c) => c.id)).toEqual(['other']);
  });

  it('acts on a trigger while a pass runs, signing both in one nonce sequence', async () => {
    const w0 = world({ pending: 5n });
    w0.state.factoryBalance = 6_000_000n;
    // Each send consumes a nonce, as the node would
    w0.state.estimate = () => {
      w0.state.nonce.pending += 1n;
      return '0x186a0';
    };
    const mem = memoryStore([]);
    let release: () => void = () => undefined;
    const readInflight = mem.rows.readInflightProxyCalls;
    mem.rows.readInflightProxyCalls = async (chainId) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return readInflight(chainId);
    };
    const { keeper } = keeperFor(w0, mem);
    await keeper.verify();
    mem.sales.push(sale({ due_at: null }));
    const pass = keeper.pass();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await keeper.trigger(sale());
    expect(mem.calls.map((c) => `${c.action}:${String(c.nonce)}`)).toEqual(['flush:8']);
    release();
    await pass;
    expect(mem.calls.map((c) => `${c.action}:${String(c.nonce)}`)).toEqual(['flush:8', 'skim:9']);
  });

  it("holds the pass's lock until a trigger's send on its connection finishes", async () => {
    const w0 = world({ pending: 5n });
    let estimating: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      estimating = resolve;
    });
    let finish: () => void = () => undefined;
    w0.state.estimate = () => {
      estimating();
      return new Promise((resolve) => {
        finish = () => {
          resolve('0x186a0');
        };
      });
    };
    const mem = memoryStore([]);
    let release: () => void = () => undefined;
    const readInflight = mem.rows.readInflightProxyCalls;
    mem.rows.readInflightProxyCalls = async (chainId) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return readInflight(chainId);
    };
    const { keeper } = keeperFor(w0, mem);
    await keeper.verify();
    mem.sales.push(sale({ due_at: null }));
    let passed = false;
    const pass = keeper.pass().then(() => {
      passed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const trigger = keeper.trigger(sale());
    await started;
    release();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(passed).toBe(false);
    finish();
    await trigger;
    await pass;
    expect(passed).toBe(true);
    expect(actionsOf(mem)).toEqual(['flush:sent']);
  });

  it('skips a pass and leaves a triggered send to the replica holding the lock', async () => {
    const mem = memoryStore();
    mem.otherReplica(true);
    const { keeper, log } = keeperFor(world({ pending: 5n }), mem);
    await keeper.pass();
    expect(keeper.verified()).toBeUndefined();
    await keeper.verify();
    const seen = await keeper.trigger(sale());
    expect(seen.observation.pending).toBe(5n);
    expect(mem.calls).toEqual([]);
    expect(log).toHaveBeenCalledWith('info', expect.stringMatching(/left to the replica holding the keeper lock/));
  });
});

describe('settling', () => {
  const sentCall = async (mem: ReturnType<typeof memoryStore>, hash: string, nonce = 7, proxy = PROXY) => {
    await mem.rows.claimProxyCall({ id: hash, chain_id: 421614, sender: KEEPER, target: proxy, proxy, action: 'return', amount: '1' });
    await mem.rows.markProxyCallSent(hash, hash, nonce);
  };
  const stale = () => NOW + SETTINGS.resendMs + 1;

  it('settles mined and reverted receipts', async () => {
    const w0 = world();
    w0.state.receipts.set('0xa', { status: '0x1' });
    const mem = memoryStore([]);
    await sentCall(mem, '0xa');
    const { keeper } = keeperFor(w0, mem);
    await keeper.pass();
    w0.state.receipts.set('0xb', { status: '0x0' });
    await sentCall(mem, '0xb');
    await keeper.pass();
    expect(actionsOf(mem)).toEqual(['return:mined', 'return:reverted']);
  });

  it('settles a proxy blocking a trigger with the loop off, and keeps one not yet mined', async () => {
    const w0 = world({ balance: 20_000_000n, attempts: 7n, releaseAt: 0n, releasable: 20_000_000n });
    const mem = memoryStore();
    const { keeper } = keeperFor(w0, mem);
    await keeper.verify();
    await keeper.trigger({ chain_id: 421614, proxy: PROXY });
    w0.state.proxy.releasable = 5_000_000n;
    await keeper.trigger({ chain_id: 421614, proxy: PROXY });
    expect(actionsOf(mem)).toEqual(['release:sent']);
    for (const c of mem.calls) if (c.tx_hash !== null) w0.state.receipts.set(c.tx_hash, { status: '0x1' });
    // Another proxy's call is left to the pass
    await sentCall(mem, '0xother', 8, FACTORY);
    w0.state.receipts.set('0xother', { status: '0x1' });
    await keeper.trigger({ chain_id: 421614, proxy: PROXY });
    expect(actionsOf(mem)).toEqual(['release:mined', 'return:sent', 'release:sent']);
    expect(w0.state.sent).toHaveLength(2);
  });

  it('keeps a fresh unmined call, then drops it once stale and unknown, and re-sends next pass', async () => {
    const mem = memoryStore();
    await sentCall(mem, '0xa');
    let now = NOW;
    const { keeper } = keeperFor(world({ balance: 20_000_000n }), mem, { now: () => now });
    await keeper.pass();
    expect(actionsOf(mem)).toEqual(['return:sent']);
    now = stale();
    await keeper.pass();
    expect(mem.calls[0]).toMatchObject({ status: 'dropped', error: 'transaction unknown to the node' });
    expect(actionsOf(mem)).toEqual(['return:dropped', 'return:sent']);
  });

  it('reads the receipt again before a drop, so a call mined meanwhile settles as mined', async () => {
    const w0 = world();
    w0.state.receiptLate.set('0xa', { status: '0x1' });
    const mem = memoryStore([]);
    await sentCall(mem, '0xa');
    await keeperFor(w0, mem, { now: stale }).keeper.pass();
    expect(actionsOf(mem)).toEqual(['return:mined']);
  });

  it('drops a stale call whose nonce another transaction used, and keeps one queued behind its own', async () => {
    const w0 = world();
    w0.state.known.add('0xa');
    w0.state.known.add('0xb');
    const mem = memoryStore([]);
    await sentCall(mem, '0xa', 7);
    await sentCall(mem, '0xb', 8, FACTORY);
    const { keeper } = keeperFor(w0, mem, { now: stale });
    await keeper.pass();
    expect(actionsOf(mem)).toEqual(['return:sent', 'return:sent']);
    w0.state.nonce.latest = 8n;
    await keeper.pass();
    expect(mem.calls[0]).toMatchObject({ status: 'dropped', error: 'nonce used by another transaction' });
    expect(mem.calls[1]?.status).toBe('sent');
  });

  it('releases a call queued behind a nonce gap no call of ours holds', async () => {
    const w0 = world();
    w0.state.known.add('0xa');
    const mem = memoryStore([]);
    await sentCall(mem, '0xa', 9);
    await keeperFor(w0, mem, { now: stale }).keeper.pass();
    expect(mem.calls[0]).toMatchObject({ status: 'dropped', error: 'queued behind a nonce gap at 7' });
  });

  it("settles a rotated key's calls too, on its own chain only", async () => {
    const mem = memoryStore([]);
    await mem.rows.claimProxyCall({ id: 'x', chain_id: 42161, sender: KEEPER, target: PROXY, proxy: PROXY, action: 'release', amount: null });
    await mem.rows.claimProxyCall({ id: 'y', chain_id: 421614, sender: FACTORY, target: FACTORY, proxy: FACTORY, action: 'skim', amount: null });
    await keeperFor(world(), mem, { now: stale }).keeper.pass();
    expect(actionsOf(mem)).toEqual(['release:sending', 'skim:dropped']);
  });

  it("never counts another key's nonces as filling this key's gap", async () => {
    const w0 = world();
    for (const hash of ['0xa', '0xb', '0xc']) w0.state.known.add(hash);
    const mem = memoryStore([]);
    await sentCall(mem, '0xa', 9);
    for (const [hash, nonce, proxy] of [['0xb', 7, FACTORY], ['0xc', 8, IMPL]] as const) {
      await mem.rows.claimProxyCall({ id: hash, chain_id: 421614, sender: FACTORY, target: proxy, proxy, action: 'return', amount: '1' });
      await mem.rows.markProxyCallSent(hash, hash, nonce);
    }
    await keeperFor(w0, mem, { now: stale }).keeper.pass();
    expect(mem.calls.map((c) => `${c.id}:${c.status}`)).toEqual(['0xa:dropped', '0xb:sent', '0xc:sent']);
  });

  it('drops a call left sending by a crash once stale', async () => {
    const mem = memoryStore([]);
    await mem.rows.claimProxyCall({ id: 'c', chain_id: 421614, sender: KEEPER, target: PROXY, proxy: PROXY, action: 'release', amount: null });
    await keeperFor(world(), mem, { now: () => NOW + 1 }).keeper.pass();
    expect(actionsOf(mem)).toEqual(['release:sending']);
    await keeperFor(world(), mem, { now: stale }).keeper.pass();
    expect(mem.calls[0]).toMatchObject({ status: 'dropped', error: 'never broadcast' });
  });

  it('logs a call it could not settle and carries on', async () => {
    const w0 = world();
    const mem = memoryStore([]);
    await sentCall(mem, '0xa');
    const { keeper, log } = keeperFor(w0, mem);
    await keeper.verify();
    w0.state.receipts.get = () => {
      throw new ChainUnavailableError('receipts down');
    };
    await keeper.pass();
    expect(log).toHaveBeenCalledWith('warn', expect.stringMatching(/not settled/));
  });
});

describe('skim and gas', () => {
  it('logs a skim it could not evaluate', async () => {
    const w0 = world();
    const { keeper, log } = keeperFor(w0, memoryStore([]));
    await keeper.verify();
    w0.state.factoryBalance = -1n;
    await keeper.pass();
    expect(log).toHaveBeenCalledWith('warn', expect.stringMatching(/skim not evaluated/));
  });

  it('logs an error on each pass once the keeper is low on ETH, once until a refill, and a warning when unreadable', async () => {
    const w0 = world();
    const log = vi.fn<KeeperLog>();
    const { keeper } = keeperFor(w0, memoryStore([]), { log });
    await keeper.checkGasFunds();
    expect(log).not.toHaveBeenCalled();
    const low = (): number => log.mock.calls.filter(([level, message]) => level === 'error' && message.includes('below keeper.min_eth')).length;
    const funded = w0.state.ethBalance;
    w0.state.ethBalance = 1n;
    await keeper.pass();
    await keeper.pass();
    expect(low()).toBe(1);
    expect(log).toHaveBeenCalledWith('error', expect.stringContaining(KEEPER));
    w0.state.ethBalance = funded;
    await keeper.pass();
    w0.state.ethBalance = 1n;
    await keeper.pass();
    expect(low()).toBe(2);
    await keeperFor(world(), memoryStore(), { chain: down(), log }).keeper.checkGasFunds();
    expect(log).toHaveBeenCalledWith('warn', expect.stringMatching(/balance unreadable/));
  });
});

describe('the loop', () => {
  it('runs a pass at once and per interval, skips while one is in flight, and stops', async () => {
    vi.useFakeTimers();
    const mem = memoryStore([]);
    const list = vi.spyOn(mem.rows, 'listKeeperCandidates');
    const { keeper } = keeperFor(world(), mem);
    keeper.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(list).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(SETTINGS.intervalMs);
    await vi.advanceTimersByTimeAsync(SETTINGS.intervalMs);
    expect(list).toHaveBeenCalledTimes(3);
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ chainId: 421614, factories: [FACTORY] }));
    await keeper.stop(0);
    await vi.advanceTimersByTimeAsync(SETTINGS.intervalMs * 3);
    expect(list).toHaveBeenCalledTimes(3);
  });

  it('runs the next pass at once while the scan is behind the head, and waits the interval once caught up or when the scan fails', async () => {
    vi.useFakeTimers();
    const w0 = world();
    w0.state.head = BigInt(SETTINGS.logRange * 30);
    const mem = memoryStore([]);
    const list = vi.spyOn(mem.rows, 'listKeeperCandidates');
    // Each range read takes a tenth of the interval, so a pass reads ten
    const { keeper } = keeperFor(w0, mem, { now: () => NOW + (w0.state.logReads.length * SETTINGS.intervalMs) / 20 });
    keeper.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(list).toHaveBeenCalledTimes(3);
    expect(mem.cursor()).toBe(w0.state.head);
    await vi.advanceTimersByTimeAsync(SETTINGS.intervalMs);
    expect(list).toHaveBeenCalledTimes(4);

    // A failing scan never spins, behind or not
    w0.state.head *= 2n;
    w0.state.logsFail = true;
    await vi.advanceTimersByTimeAsync(SETTINGS.intervalMs);
    expect(list).toHaveBeenCalledTimes(5);
    await keeper.stop(0);
  });

  it('logs a failed pass and waits a bounded time on stop', async () => {
    vi.useFakeTimers();
    const mem = memoryStore([]);
    let release: () => void = () => undefined;
    const readInflight = vi.fn(
      () =>
        new Promise<ProxyCallRow[]>((resolve) => {
          release = () => {
            resolve([]);
          };
        }),
    );
    mem.rows.readInflightProxyCalls = readInflight;
    const log = vi.fn<KeeperLog>();
    const { keeper } = keeperFor(world(), mem, { log });
    await keeper.verify();
    keeper.start();
    await vi.advanceTimersByTimeAsync(SETTINGS.intervalMs * 2);
    expect(readInflight).toHaveBeenCalledTimes(1);
    const stopping = keeper.stop(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await stopping;
    release();
    await vi.runOnlyPendingTimersAsync();

    mem.rows.listKeeperCandidates = vi.fn(async () => Promise.reject(new Error('db gone')));
    mem.rows.readInflightProxyCalls = vi.fn(async () => []);
    keeper.start();
    await vi.advanceTimersByTimeAsync(SETTINGS.intervalMs);
    expect(log).toHaveBeenCalledWith('warn', 'sale vault proxy keeper pass failed: db gone');
    await keeper.stop();
  });

  it('verifies alone on the interval, keeps verifying once it succeeds, and logs each outcome once', async () => {
    vi.useFakeTimers();
    let mode: 'down' | 'wrong' | 'ok' = 'down';
    const limits = limitsOf();
    const vault = vi.fn(async (): Promise<string> => {
      if (mode === 'down') throw new ChainUnavailableError('down');
      return mode === 'wrong' ? '0x9999999999999999999999999999999999999999' : SEPOLIA.vault;
    });
    (limits as unknown as { arbitrumVault: () => Promise<string> }).arbitrumVault = vault;
    const log = vi.fn<KeeperLog>();
    const { keeper } = keeperFor(world(), memoryStore([]), { limits, log });
    keeper.startVerifying();
    await vi.advanceTimersByTimeAsync(SETTINGS.intervalMs);
    expect(log).toHaveBeenCalledWith('warn', expect.stringMatching(/unverified/));
    mode = 'wrong';
    await vi.advanceTimersByTimeAsync(SETTINGS.intervalMs);
    expect(log).toHaveBeenCalledWith('error', expect.stringMatching(/Arbitrum vault/));
    expect(keeper.verified()).toBeUndefined();
    mode = 'ok';
    await vi.advanceTimersByTimeAsync(SETTINGS.intervalMs);
    expect(keeper.verified()?.factory).toBe(FACTORY);
    const reads = vi.spyOn(limits, 'returnRoute');
    await vi.advanceTimersByTimeAsync(SETTINGS.intervalMs * 2);
    expect(reads).toHaveBeenCalledTimes(2);
    await keeper.stop(0);
  });

  it('stops cleanly without ever starting', async () => {
    await expect(keeperFor(world(), memoryStore()).keeper.stop()).resolves.toBeUndefined();
  });
});

describe('defaults', () => {
  it('names calls with a fresh uuid and reads the real clock', async () => {
    const w0 = world({ pending: 5n });
    const mem = memoryStore([sale({ due_at: 0, last_activity_at: Date.now() })]);
    const keeper = new SaleVaultProxyKeeper({
      deployment: DEPLOYMENT,
      retired: [],
      chain: w0.chain,
      signer: new KeeperSigner(() => KEY),
      limits: limitsOf(),
      failedCalls: { failedCcms: async () => [] },
      store: mem.store,
      settings: SETTINGS,
      log: vi.fn(),
    });
    await keeper.pass();
    expect(mem.calls[0]?.id).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('signing', () => {
  it('signs as the keeper address', () => {
    expect(new KeeperSigner(() => KEY).address).toBe(KEEPER);
  });

  it('parses a hex key with or without 0x, and refuses anything else', () => {
    expect(parseKeeperKey(`0x${'46'.repeat(32)}\n`)).toEqual(KEY);
    expect(parseKeeperKey('46'.repeat(32))).toEqual(KEY);
    expect(() => parseKeeperKey('46'.repeat(31))).toThrow(/32-byte hex/);
    expect(() => parseKeeperKey('not a key')).toThrow(/32-byte hex/);
  });
});

describe('relay', () => {
  it('sends a claimer transfer through the signing queue, keyed by the claimer, one in flight', async () => {
    const mem = memoryStore([]);
    const { keeper } = keeperFor(world(), mem);
    expect(await keeper.relay(421614, SEPOLIA.usdc, CLAIMER, '0xe3ee160e', 5n)).toBe('sent');
    expect(mem.calls).toMatchObject([{ action: 'relay', target: SEPOLIA.usdc, proxy: CLAIMER, amount: '5', status: 'sent' }]);
    expect(await keeper.relay(421614, SEPOLIA.usdc, CLAIMER, '0xe3ee160e', 5n)).toBe('skipped');
  });

  it("reads a claimer's live balance in the deployment's own USDC", async () => {
    const w0 = world({ balance: 7n });
    const { keeper } = keeperFor(w0, memoryStore([]));
    await keeper.verify();
    expect(await keeper.claimerBalance(keeper.current() as NonNullable<ReturnType<typeof keeper.current>>, PROXY)).toBe(7n);
    expect(w0.calls.at(-1)?.params[0]).toMatchObject({ to: SEPOLIA.usdc, data: encodeBalanceOf(PROXY) });
  });

  it('answers locked, not skipped, while another replica holds the keeper lock', async () => {
    const mem = memoryStore([]);
    mem.otherReplica(true);
    expect(await keeperFor(world(), mem).keeper.relay(421614, SEPOLIA.usdc, CLAIMER, '0xe3ee160e', 5n)).toBe('locked');
    expect(mem.calls).toEqual([]);
  });
});
