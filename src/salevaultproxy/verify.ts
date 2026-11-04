// Checks the configured SaleVaultProxyFactory against the chain before any sell is pointed at it.

import { USDC_DECIMALS } from '../money.js';
import { isRevert, RpcCallError, type SaleVaultProxyChain } from './chain.js';
import { checksum, predictSaleVaultProxy } from './derive.js';
import type { ReturnLimits, ReturnRoute } from './limits.js';
import { SALE_VAULT_PROXY_CHAIN, SALE_VAULT_PROXY_NETWORKS } from './networks.js';

/** A factory and implementation proven on chain, with the immutables every proxy shares. Addresses lowercase. */
export interface VerifiedSaleVaultProxy {
  readonly chain: string;
  readonly chainId: number;
  readonly factory: string;
  readonly implementation: string;
  readonly vault: string;
  readonly usdc: string;
  readonly broker: string;
  readonly homeChain: bigint;
  readonly homeToken: bigint;
  readonly retryBlocks: number;
  readonly minReturn: bigint;
  readonly maxReturn: bigint;
  readonly priceFloorBps: bigint;
  readonly feeAllowance: bigint;
  readonly returnCooldown: bigint;
  /** Seconds after the last activity before a balance under MIN_RETURN may be released to the claimer. */
  readonly releaseDelay: bigint;
  /** Returns sent after which the proxy may release to the claimer at once. */
  readonly releaseAttempts: bigint;
  /** Seconds after the last activity before any balance may be released to the claimer. */
  readonly staleDelay: bigint;
  /** The factory's only retire and unpause caller. */
  readonly guardian: string;
  /** The factory's other pause caller, the keeper key on the configured deployment. */
  readonly pauser: string;
}

/** The verified deployment as the app cross-checks it, addresses EIP-55. */
export interface SaleVaultProxyPayload {
  chain: string;
  chainId: number;
  factory: string;
  implementation: string;
}

/** The public face of a verified deployment, served by both supported offramp routes. */
export function saleVaultProxyPayload(v: VerifiedSaleVaultProxy): SaleVaultProxyPayload {
  return { chain: v.chain, chainId: v.chainId, factory: checksum(v.factory), implementation: checksum(v.implementation) };
}

/** The current verified deployment, or undefined when unconfigured or not yet verified. */
export type SaleVaultProxyLookup = () => VerifiedSaleVaultProxy | undefined;

/** What verification needs from config. */
export interface SaleVaultProxyDeploymentConfig {
  readonly chainId: number;
  readonly factory: string;
  readonly vault: string;
  readonly usdc: string;
}

/** The live Chainflip reads verification proves the deployment against. */
export type ChainflipSource = Pick<ReturnLimits, 'arbitrumVault' | 'returnRoute' | 'bounds' | 'brokerRegistered' | 'stateChain'>;

/** The configured deployment disagrees with the chain. Fatal, a retry cannot fix it. */
export class SaleVaultProxyMisconfigured extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SaleVaultProxyMisconfigured';
  }
}

/** Verify the deployment's identity: chain, contracts and immutables against its own config, and its PAUSER against `pauser` when given. A mismatch throws SaleVaultProxyMisconfigured, an RPC failure ChainUnavailableError. */
export async function verifyDeployment(
  cfg: SaleVaultProxyDeploymentConfig,
  chain: SaleVaultProxyChain,
  chainflip: Pick<ChainflipSource, 'stateChain'>,
  pauser?: string,
): Promise<VerifiedSaleVaultProxy> {
  const factory = cfg.factory.toLowerCase();
  const vault = cfg.vault.toLowerCase();
  const usdc = cfg.usdc.toLowerCase();
  const network = SALE_VAULT_PROXY_NETWORKS[cfg.chainId] ?? fail(`chain ${String(cfg.chainId)} has no pinned Chainflip network`);
  const chainId = await chain.chainId();
  if (chainId !== BigInt(cfg.chainId)) fail(`rpc_url answers chain ${chainId.toString()}, config says ${String(cfg.chainId)}`);
  const stateChain = await chainflip.stateChain();
  if (stateChain !== network.stateChain) fail(`chainflip.rpc_url answers ${stateChain}, chain ${String(cfg.chainId)} needs ${network.stateChain}`);
  if ((await chain.code(factory)) === '0x') fail(`no contract at factory ${factory}`);

  const f = await claimerBound(chain.factoryInfo(factory), `factory ${factory}`, PAUSE_ABI);
  // The keeper reads it before every pause
  await claimerBound(chain.unpaused(factory), `factory ${factory}`, PAUSE_ABI);
  const { implementation } = f;
  if ((await chain.code(implementation)) === '0x') fail(`no contract at implementation ${implementation}`);
  if (f.vault !== vault) fail(`factory vault is ${f.vault}, config says ${vault}`);
  if (f.usdc !== usdc) fail(`factory USDC is ${f.usdc}, config says ${usdc}`);
  // Only the guardian undoes a pause, so the pausing key is never the guardian
  if (f.pauser === f.guardian) fail(`factory pauser ${f.pauser} is its guardian`);
  if (pauser !== undefined && f.pauser !== pauser.toLowerCase()) fail(`factory pauser is ${f.pauser}, the keeper key is ${pauser.toLowerCase()}`);
  // The keeper key is hot, so it never holds what the factory skims
  if (pauser !== undefined && f.treasury === pauser.toLowerCase()) fail(`factory treasury ${f.treasury} is the keeper key`);
  const decimals = await chain.decimals(usdc);
  if (decimals !== USDC_DECIMALS) fail(`USDC reports ${String(decimals)} decimals, config amounts are written in ${String(USDC_DECIMALS)}`);

  const i = await claimerBound(chain.implementationInfo(implementation), `implementation ${implementation}`);
  if (i.factory !== factory) fail(`implementation factory is ${i.factory}, config says ${factory}`);
  // Any pair proves the clone layout every sell address is derived with off chain, so probe the factory as home and claimer
  const home = `0x${factory.slice(2).padStart(64, '0')}`;
  const predicted = await claimerBound(chain.predict(factory, home, factory), `factory ${factory}`);
  const derived = predictSaleVaultProxy(factory, implementation, home, factory);
  if (predicted !== derived) fail(`factory predicts proxy ${predicted}, the off-chain derivation gives ${derived}`);

  return {
    chain: SALE_VAULT_PROXY_CHAIN,
    chainId: cfg.chainId,
    factory,
    implementation,
    vault: f.vault,
    usdc: f.usdc,
    broker: i.broker,
    homeChain: i.homeChain,
    homeToken: i.homeToken,
    retryBlocks: Number(i.retryBlocks),
    minReturn: i.minReturn,
    maxReturn: i.maxReturn,
    priceFloorBps: i.priceFloorBps,
    feeAllowance: i.feeAllowance,
    returnCooldown: i.returnCooldown,
    releaseDelay: i.releaseDelay,
    releaseAttempts: i.releaseAttempts,
    staleDelay: i.staleDelay,
    guardian: f.guardian,
    pauser: f.pauser,
  };
}

// The factory getters also need the returns pause, which a factory built before it lacks
const PAUSE_ABI = 'a home-only factory or one built before the returns pause (PAUSER, unpaused) is not served';

// A getter that reverts means a contract without the ABI the keeper calls, which no retry fixes
async function claimerBound<T>(read: Promise<T>, what: string, missing = 'a home-only deployment is not served'): Promise<T> {
  try {
    return await read;
  } catch (error) {
    if (error instanceof RpcCallError && isRevert(error)) fail(`${what} does not answer the claimer-bound ABI, ${missing}: ${error.message}`);
    throw error;
  }
}

/** Prove a verified deployment still fits Chainflip's live Vault, route and window, which only gates new sells. A mismatch throws SaleVaultProxyMisconfigured, an outage ChainUnavailableError. */
export async function verifyWindow(
  v: VerifiedSaleVaultProxy,
  chainflip: Pick<ChainflipSource, 'arbitrumVault' | 'returnRoute' | 'bounds' | 'brokerRegistered'>,
): Promise<void> {
  // A moved Vault stops new sells only, release never sends to it
  const liveVault = await chainflip.arbitrumVault();
  if (liveVault !== v.vault) fail(`Chainflip's Arbitrum vault is ${liveVault}, config says ${v.vault}`);
  const route = await encoderRoute(v, chainflip);
  if (route.vault !== v.vault) fail(`Chainflip's encoder targets vault ${route.vault}, config says ${v.vault}`);
  if (route.usdc !== v.usdc) fail(`Chainflip's encoder takes USDC ${route.usdc}, config says ${v.usdc}`);
  if (v.homeChain !== route.homeChain) fail(`implementation home chain is ${v.homeChain.toString()}, Chainflip's Assethub is ${route.homeChain.toString()}`);
  if (v.homeToken !== route.homeToken) fail(`implementation home token is ${v.homeToken.toString()}, Chainflip's HubUsdt is ${route.homeToken.toString()}`);
  if (v.broker !== route.broker) fail(`implementation broker is ${v.broker}, Chainflip's default broker is ${route.broker}`);
  // A full chunk must fit Chainflip's live window, else the excess is confiscated or the deposit ignored
  const live = await chainflip.bounds();
  if (v.minReturn < live.floor) fail(`implementation MIN_RETURN ${v.minReturn.toString()} is below Chainflip's floor ${live.floor.toString()}`);
  if (live.maximum !== null && v.maxReturn > live.maximum) {
    fail(`implementation MAX_RETURN ${v.maxReturn.toString()} is above Chainflip's maximum swap ${live.maximum.toString()}`);
  }
  // Either one refunds every return
  if (v.retryBlocks > live.maxRetryBlocks) fail(`implementation RETRY_BLOCKS ${String(v.retryBlocks)} is over Chainflip's cap ${String(live.maxRetryBlocks)}`);
  if (!(await chainflip.brokerRegistered(v.broker))) fail(`implementation broker ${v.broker} is not a registered Chainflip broker`);
}

/** The route Chainflip's encoder builds for a minimum return of this deployment refunding to its factory, the second source of the live Vault. */
export function encoderRoute(v: VerifiedSaleVaultProxy, chainflip: Pick<ChainflipSource, 'returnRoute'>): Promise<ReturnRoute> {
  // Chainflip's encoder fills its default broker and the route ids when no broker is named
  return chainflip.returnRoute({
    amount: v.minReturn,
    refund: v.factory,
    home: `0x${v.factory.slice(2).padStart(64, '0')}`,
    retryBlocks: v.retryBlocks,
  });
}

function fail(message: string): never {
  throw new SaleVaultProxyMisconfigured(`sale_vault_proxy: ${message}`);
}
