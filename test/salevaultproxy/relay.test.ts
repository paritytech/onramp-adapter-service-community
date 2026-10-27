import { describe, expect, it, vi } from 'vitest';

import { SALE_VAULT_PROXY } from '../fixtures.js';
import type { Subject } from '../../src/auth.js';
import { Refusal, relayRequest, type RelayRequest } from '../../src/contract.js';
import { ChainUnavailableError } from '../../src/salevaultproxy/chain.js';
import {
  encodeTransferWithAuthorization,
  recoverSigner,
  SaleVaultProxyRelay,
  transferAuthorizationDigest,
  TRANSFER_WITH_AUTHORIZATION_TYPE,
  type RelayChain,
  type RelayKeeper,
  type RelayStore,
  type TransferAuthorization,
} from '../../src/salevaultproxy/relay.js';

// An EIP-3009 authorization signed with key 0x11..11 under the USDC domain separator
const VECTOR = {
  from: '0x19e7e376e7c213b7e7e7e46cc70a5dd086daff2a',
  domainSeparator: '0x85944e1292d007732838d6eadfa67589b78ffcededbd4df60488d0af251308bb',
  digest: '0xdfd8589addef9e63b363d008a584830791973e96987fba0fa81091bc96d5ba2a',
  signature:
    '0xd21df9a9e6ba5a3596d9094d9e88cec5f9237c1e47922cb05beb261ab90cd30124d40d41e7167206aee431515e2029fa0f99897351402034b97d7f87084dd6ad1c',
  calldata:
    '0xe3ee160e00000000000000000000000019e7e376e7c213b7e7e7e46cc70a5dd086daff2a0000000000000000000000003c44cdddb6a900fa2b585dd299e03d12fa4293bc000000000000000000000000000000000000000000000000000000000016e360000000000000000000000000000000000000000000000000000000006553f10000000000000000000000000000000000000000000000000000000000713fb300cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd000000000000000000000000000000000000000000000000000000000000001cd21df9a9e6ba5a3596d9094d9e88cec5f9237c1e47922cb05beb261ab90cd30124d40d41e7167206aee431515e2029fa0f99897351402034b97d7f87084dd6ad',
} as const;
// The token's TRANSFER_WITH_AUTHORIZATION_TYPEHASH
const TYPEHASH = '0x7c7c6cdb67a18743f49ec6fa9b35f50d52ed05cbed4cc592e13b44501c1a2267';
const TO = '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc';
const AUTH: TransferAuthorization = { from: VECTOR.from, to: TO, value: 1_500_000n, validAfter: 1_700_000_000n, validBefore: 1_900_000_000n, nonce: `0x${'cd'.repeat(32)}` };
const BODY: RelayRequest = { from: AUTH.from, to: AUTH.to, value: '1500000', validAfter: '1700000000', validBefore: '1900000000', nonce: AUTH.nonce, signature: VECTOR.signature };
const ALICE: Subject = { productId: 'product', alias: 'alias-abc', proven: true };
const NOW_MS = 1_800_000_000_000;
const hex = (bytes: Uint8Array) => `0x${Buffer.from(bytes).toString('hex')}`;
// The signature with s replaced, v kept
const withS = (s: string) => `${VECTOR.signature.slice(0, 66)}${s}${VECTOR.signature.slice(-2)}`;

describe('the EIP-3009 codec', () => {
  it('hashes the struct FiatTokenV2 names', () => {
    expect(TRANSFER_WITH_AUTHORIZATION_TYPE).toBe(
      'TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)',
    );
  });

  it('matches the digest ethers signs', () => {
    expect(hex(transferAuthorizationDigest(VECTOR.domainSeparator, AUTH))).toBe(VECTOR.digest);
  });

  it('recovers the signer, lowercase', () => {
    expect(recoverSigner(transferAuthorizationDigest(VECTOR.domainSeparator, AUTH), VECTOR.signature)).toBe(VECTOR.from);
  });

  it('refuses what ECRecover.sol refuses', () => {
    const digest = transferAuthorizationDigest(VECTOR.domainSeparator, AUTH);
    expect(recoverSigner(digest, VECTOR.signature.slice(0, -2))).toBeUndefined();
    expect(recoverSigner(digest, `${VECTOR.signature.slice(0, -2)}01`)).toBeUndefined();
    // The high-s twin of a valid signature
    expect(recoverSigner(digest, withS('f'.repeat(64)))).toBeUndefined();
    expect(recoverSigner(digest, `0x${'0'.repeat(128)}1b`)).toBeUndefined();
  });

  it('encodes the v, r, s call exactly as ethers does', () => {
    expect(encodeTransferWithAuthorization(AUTH, VECTOR.signature)).toBe(VECTOR.calldata);
    expect(() => encodeTransferWithAuthorization(AUTH, '0x12')).toThrow(/65 bytes/);
  });
});

describe('the relay body', () => {
  it('lowercases the addresses and refuses a zero value or a short signature', () => {
    expect(relayRequest.parse({ ...BODY, from: '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A' }).from).toBe(VECTOR.from);
    expect(relayRequest.safeParse({ ...BODY, value: '0' }).success).toBe(false);
    expect(relayRequest.safeParse({ ...BODY, value: (2n ** 256n).toString() }).success).toBe(false);
    expect(relayRequest.safeParse({ ...BODY, signature: '0x12' }).success).toBe(false);
    expect(relayRequest.safeParse({ ...BODY, to: '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2a' }).success).toBe(false);
  });
});

function harness(overrides: { store?: Partial<RelayStore>; chain?: Partial<RelayChain>; keeper?: Partial<RelayKeeper> } = {}) {
  const store: RelayStore = {
    isSellerClaimer: vi.fn(async () => true),
    isSaleAddress: vi.fn(async () => false),
    readLatestProxyCall: vi.fn(async () => ({ tx_hash: '0xabc' }) as never),
    ...overrides.store,
  };
  const chain: RelayChain = {
    bytes32Of: vi.fn(async (_to: string, signature: string) => (signature === 'DOMAIN_SEPARATOR()' ? VECTOR.domainSeparator : TYPEHASH)),
    authorizationUsed: vi.fn(async () => false),
    usdcBalance: vi.fn(async () => 1_500_000n),
    ...overrides.chain,
  };
  const keeper: RelayKeeper = {
    current: vi.fn(() => SALE_VAULT_PROXY),
    relay: vi.fn(async () => 'sent' as const),
    ...overrides.keeper,
  };
  return { store, chain, keeper, relay: new SaleVaultProxyRelay(store, chain, keeper, () => NOW_MS) };
}

const refusal = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (error) {
    if (error instanceof Refusal) return { status: error.status, code: error.failure.tag === 'Other' ? error.failure.value.code : error.failure.tag };
    throw error;
  }
  throw new Error('expected a refusal');
};

describe('SaleVaultProxyRelay', () => {
  it('sends a valid authorization through the keeper, keyed by the claimer', async () => {
    const h = harness();
    expect(await h.relay.relay(ALICE, BODY)).toEqual({ status: 'sent', chainId: SALE_VAULT_PROXY.chainId, txHash: '0xabc' });
    expect(h.keeper.relay).toHaveBeenCalledWith(SALE_VAULT_PROXY.chainId, SALE_VAULT_PROXY.usdc, VECTOR.from, VECTOR.calldata, 1_500_000n);
    expect(h.store.isSellerClaimer).toHaveBeenCalledWith('product', VECTOR.from);
    expect(h.store.readLatestProxyCall).toHaveBeenCalledWith(SALE_VAULT_PROXY.chainId, VECTOR.from);
  });

  it('reads the token domain once', async () => {
    const h = harness({ store: { readLatestProxyCall: vi.fn(async () => undefined) } });
    expect((await h.relay.relay(ALICE, BODY)).txHash).toBeNull();
    await h.relay.relay(ALICE, BODY);
    expect(h.chain.bytes32Of).toHaveBeenCalledTimes(2);
  });

  it('refuses without a verified deployment', async () => {
    expect(await refusal(harness({ keeper: { current: () => undefined } }).relay.relay(ALICE, BODY))).toEqual({ status: 503, code: 'SALE_VAULT_PROXY_UNAVAILABLE' });
  });

  it('refuses a transfer to its own sender', async () => {
    expect(await refusal(harness().relay.relay(ALICE, { ...BODY, to: BODY.from }))).toEqual({ status: 400, code: 'RELAY_SELF_TRANSFER' });
  });

  it('refuses outside the token window, at either strict edge', async () => {
    const now = String(NOW_MS / 1000);
    expect(await refusal(harness().relay.relay(ALICE, { ...BODY, validAfter: now }))).toEqual({ status: 400, code: 'RELAY_OUTSIDE_WINDOW' });
    expect(await refusal(harness().relay.relay(ALICE, { ...BODY, validBefore: now }))).toEqual({ status: 400, code: 'RELAY_OUTSIDE_WINDOW' });
  });

  it('refuses a sender that is no claimer of this product, before any chain read', async () => {
    const h = harness({ store: { isSellerClaimer: vi.fn(async () => false) } });
    expect(await refusal(h.relay.relay(ALICE, BODY))).toEqual({ status: 403, code: 'RELAY_NOT_CLAIMER' });
    expect(h.chain.bytes32Of).not.toHaveBeenCalled();
  });

  it('refuses a payee that is a claimer or a proxy', async () => {
    const h = harness({ store: { isSaleAddress: vi.fn(async () => true) } });
    expect(await refusal(h.relay.relay(ALICE, BODY))).toEqual({ status: 400, code: 'RELAY_TO_SALE_ADDRESS' });
    expect(h.store.isSaleAddress).toHaveBeenCalledWith(SALE_VAULT_PROXY.chainId, TO);
  });

  it('refuses a signature that is not the sender, before spending gas', async () => {
    const h = harness();
    expect(await refusal(h.relay.relay(ALICE, { ...BODY, value: '1500001' }))).toEqual({ status: 400, code: 'RELAY_BAD_SIGNATURE' });
    expect(h.keeper.relay).not.toHaveBeenCalled();
  });

  it('refuses a token whose typehash is not the struct signed here', async () => {
    const h = harness({ chain: { bytes32Of: vi.fn(async () => `0x${'00'.repeat(32)}`) } });
    expect(await refusal(h.relay.relay(ALICE, BODY))).toEqual({ status: 503, code: 'SALE_VAULT_PROXY_UNAVAILABLE' });
  });

  it('refuses a spent nonce, a short balance and less than the whole balance', async () => {
    expect(await refusal(harness({ chain: { authorizationUsed: vi.fn(async () => true) } }).relay.relay(ALICE, BODY))).toEqual({ status: 409, code: 'RELAY_NONCE_USED' });
    expect(await refusal(harness({ chain: { usdcBalance: vi.fn(async () => 1_499_999n) } }).relay.relay(ALICE, BODY))).toEqual({
      status: 409,
      code: 'RELAY_INSUFFICIENT_BALANCE',
    });
    const dust = harness({ chain: { usdcBalance: vi.fn(async () => 1_500_001n) } });
    expect(await refusal(dust.relay.relay(ALICE, BODY))).toEqual({ status: 409, code: 'RELAY_NOT_WHOLE_BALANCE' });
    expect(dust.keeper.relay).not.toHaveBeenCalled();
  });

  it('answers 503 when the chain cannot be read, and lets other failures through', async () => {
    const down = harness({ chain: { usdcBalance: vi.fn(async () => Promise.reject(new ChainUnavailableError('rpc down'))) } });
    expect(await refusal(down.relay.relay(ALICE, BODY))).toEqual({ status: 503, code: 'SALE_VAULT_PROXY_CHAIN_UNAVAILABLE' });
    const broken = harness({ chain: { usdcBalance: vi.fn(async () => Promise.reject(new Error('bug'))) } });
    await expect(broken.relay.relay(ALICE, BODY)).rejects.toThrow('bug');
    const sendDown = harness({ keeper: { relay: vi.fn(async () => Promise.reject(new ChainUnavailableError('fees unreadable'))) } });
    expect(await refusal(sendDown.relay.relay(ALICE, BODY))).toEqual({ status: 503, code: 'SALE_VAULT_PROXY_CHAIN_UNAVAILABLE' });
  });

  it('says when the token would revert, another relay holds the claimer, or the keeper lock is held', async () => {
    expect(await refusal(harness({ keeper: { relay: vi.fn(async () => 'reverted' as const) } }).relay.relay(ALICE, BODY))).toEqual({
      status: 422,
      code: 'RELAY_WOULD_REVERT',
    });
    expect(await refusal(harness({ keeper: { relay: vi.fn(async () => 'skipped' as const) } }).relay.relay(ALICE, BODY))).toEqual({ status: 409, code: 'RELAY_BUSY' });
    expect(await refusal(harness({ keeper: { relay: vi.fn(async () => 'locked' as const) } }).relay.relay(ALICE, BODY))).toEqual({ status: 503, code: 'RELAY_KEEPER_BUSY' });
  });
});
