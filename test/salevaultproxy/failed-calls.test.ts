import { describe, expect, it, vi } from 'vitest';

import { ChainUnavailableError, type RpcTransport } from '../../src/salevaultproxy/chain.js';
import { decodeCcmPayload, decodeFailedCalls, FailedCalls, failedCallsKey } from '../../src/salevaultproxy/failed-calls.js';
import { CLAIMER, HOME, SEPOLIA, w } from './fakes.js';

// A cf_failed_call_arbitrum answer for broadcast 3926, a CCM to a test factory
const FAILED_3926 = {
  chain_id: 421614,
  max_priority_fee_per_gas: null,
  max_fee_per_gas: null,
  gas_limit: '0x3aa00',
  contract: SEPOLIA.vault,
  value: '0x0',
  data: '5293178e27293ceccd63cda8400734fa61e9a62287259a97befaeda50741229a07c9e20400000000000000000000000000000000000000000000000000000000000010420000000000000000000000003a6f97f8571d46899ee550ab6464370f1db9759700000000000000000000000075faf114eafb1bdbe2f0316df893fd58ce46aa4d000000000000000000000000950875ea8ee4573c3d3f0c46c8801b61bafc9ec700000000000000000000000000000000000000000000000000000000008b7cf700000000000000000000000000000000000000000000000000000000000000040000000000000000000000000000000000000000000000000000000000000120000000000000000000000000000000000000000000000000000000000000014000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000080c4da9b23e283af292f6bab5a9bf372b087e35194adc2df517761d875cd265c2f0000000000000000000000003eff930b4f3a91d5e71aacd255f3ae8273b50de200000000000000000000000000000000000000000000000000000000004c4b4004db4118037ce69693b8f055b8ca809f01c0a5c308559492c7603a018955c707',
};
const TEST_FACTORY = '0x950875ea8ee4573c3d3f0c46c8801b61bafc9ec7';
// The FailedForeignChainCalls entry for epoch 1076 naming broadcast 3926 from epoch 1075
const STORAGE_1076 = '0x04560f000033040000';

// The payload with a 192-byte message in place of the four-word one
const withMessage = (message: string): string => `${FAILED_3926.data.slice(0, 8 + 64 * 10)}${w(192n)}${message}`;
// A six-word sale message, home fourth and claimer sixth
const withSaleMessage = (home: string, claimer: string): string => withMessage(`${w(1n)}${w(2n)}${w(3n)}${home.slice(2)}${w(4n)}${claimer.slice(2).padStart(64, '0')}`);
// The contract's sale message test vector
const MESSAGE_VECTOR = {
  home: '0xabababababababababababababababababababababababababababababababab',
  claimer: '0x3333333333333333333333333333333333333333',
  encoded:
    '0xc0615bcc697a20445b853b8779e01ab7c45752dbd7ab43f9c3dc100a83e5b52c00000000000000000000000011111111111111111111111111111111111111110000000000000000000000000000000000000000000000000000000002faf080abababababababababababababababababababababababababababababababab000000000000000000000000000000000000000000000000000000006b36ec800000000000000000000000003333333333333333333333333333333333333333',
};

describe('failedCallsKey', () => {
  it('derives the ArbitrumIngressEgress.FailedForeignChainCalls key of an epoch', () => {
    expect(failedCallsKey(1076)).toBe('0x3d3491b8c14ff78a5176bc3b6ebe516f59a5945414145fd6527100b6602ecb31b56635f6c3b68e0734040000');
    expect(failedCallsKey(1077)).toBe('0x3d3491b8c14ff78a5176bc3b6ebe516f59a5945414145fd6527100b6602ecb311facb7eb6e28a08735040000');
  });
});

describe('decodeFailedCalls', () => {
  it('decodes one entry and an absent one', () => {
    expect(decodeFailedCalls(STORAGE_1076)).toEqual([{ broadcastId: 3926, originalEpoch: 1075 }]);
    expect(decodeFailedCalls(null)).toEqual([]);
  });

  it('refuses anything that is not a whole list', () => {
    expect(() => decodeFailedCalls(7)).toThrow(ChainUnavailableError);
    expect(() => decodeFailedCalls('0x04560f0000')).toThrow(/do not fit/);
  });
});

describe('decodeCcmPayload', () => {
  it('reads the receiver, token and amount off a CCM payload, with no home for a message of another layout', () => {
    expect(decodeCcmPayload(FAILED_3926.data)).toEqual({ recipient: TEST_FACTORY, token: SEPOLIA.usdc, amount: 9_141_495n, home: undefined, claimer: undefined });
  });

  it('reads the home and claimer of a sale message, with or without 0x', () => {
    expect(decodeCcmPayload(`0x${withSaleMessage(HOME, CLAIMER)}`)).toMatchObject({ home: HOME, claimer: CLAIMER });
    expect(decodeCcmPayload(withSaleMessage(HOME, CLAIMER))).toMatchObject({ home: HOME, claimer: CLAIMER });
    expect(decodeCcmPayload(withMessage(MESSAGE_VECTOR.encoded.slice(2)))).toMatchObject({ home: MESSAGE_VECTOR.home, claimer: MESSAGE_VECTOR.claimer });
  });

  it('names no home or claimer for a sale message cfReceive leaves unattributed', () => {
    const unbooked = { home: undefined, claimer: undefined };
    expect(decodeCcmPayload(withSaleMessage(`0x${'0'.repeat(64)}`, CLAIMER))).toMatchObject(unbooked);
    expect(decodeCcmPayload(withSaleMessage(HOME, `0x${'0'.repeat(40)}`))).toMatchObject(unbooked);
    expect(decodeCcmPayload(withSaleMessage(HOME, `0x01${'0'.repeat(22)}${CLAIMER.slice(2)}`))).toMatchObject(unbooked);
  });

  it('skips any other Vault call and refuses a truncated payload', () => {
    expect(decodeCcmPayload(`b267e7f6${FAILED_3926.data.slice(8)}`)).toBeUndefined();
    expect(() => decodeCcmPayload(FAILED_3926.data.slice(0, 8 + 64 * 4))).toThrow(/no word 8/);
  });
});

describe('FailedCalls.failedCcms', () => {
  const rpcOf = (answers: Record<string, unknown>): RpcTransport =>
    vi.fn(async (method: string, params: unknown[]) => {
      if (method === 'cf_failed_call_arbitrum') return (answers.calls as Record<number, unknown>)[params[0] as number] ?? null;
      return answers[method];
    });

  it("reads the current epoch's list and each payload, skipping a call already gone and a transfer fallback", async () => {
    const fallback = { ...FAILED_3926, data: `b267e7f6${FAILED_3926.data.slice(8)}` };
    const rpc = rpcOf({ cf_current_epoch: 1076, state_getStorage: '0x0c560f00003304000001000000330400000200000033040000', calls: { 3926: FAILED_3926, 2: fallback } });
    expect(await new FailedCalls(rpc).failedCcms()).toEqual([
      { broadcastId: 3926, originalEpoch: 1075, contract: SEPOLIA.vault, recipient: TEST_FACTORY, token: SEPOLIA.usdc, amount: 9_141_495n, home: undefined, claimer: undefined },
    ]);
    expect(rpc).toHaveBeenCalledWith('state_getStorage', [failedCallsKey(1076)]);
  });

  it('treats a malformed epoch or payload as an unavailable chain', async () => {
    await expect(new FailedCalls(rpcOf({ cf_current_epoch: '1076' })).failedCcms()).rejects.toThrow(/not an epoch/);
    const bad = rpcOf({ cf_current_epoch: 1076, state_getStorage: STORAGE_1076, calls: { 3926: { contract: SEPOLIA.vault } } });
    await expect(new FailedCalls(bad).failedCcms()).rejects.toThrow(/no contract or data/);
  });
});
