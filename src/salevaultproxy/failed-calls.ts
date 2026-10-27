// Chainflip's failed Arbitrum calls: CCM broadcasts it aborted, kept signed on the State Chain for anyone to submit.

import { compactFromU8a, hexToU8a, u8aToHex } from '@polkadot/util';
import { xxhashAsU8a } from '@polkadot/util-crypto';

import { decodeAddress, selector } from './abi.js';
import { ChainUnavailableError, type RpcTransport } from './chain.js';

/** One aborted CCM broadcast to Arbitrum and the signed payload that can still deliver it. */
export interface FailedCcm {
  readonly broadcastId: number;
  /** The epoch it first failed in, it expires once the current epoch is two past it. */
  readonly originalEpoch: number;
  /** The Vault the payload is sent to, lowercase. */
  readonly contract: string;
  /** The CCM's receiver, lowercase. */
  readonly recipient: string;
  readonly token: string;
  readonly amount: bigint;
  /** The home word of a sale message, undefined for any other message. */
  readonly home: string | undefined;
  /** The claimer of a sale message, lowercase, undefined for any other message. */
  readonly claimer: string | undefined;
}

/** The State Chain reads the keeper watches failed calls through. */
export type FailedCallSource = Pick<FailedCalls, 'failedCcms'>;

// executexSwapAndCall(SigData, TransferParams, srcChain, srcAddress, message), the Vault's CCM entry point
const EXECUTE_X_SWAP_AND_CALL = u8aToHex(selector('executexSwapAndCall((uint256,uint256,address),(address,address,uint256),uint32,bytes,bytes)')).slice(2);
// Word indexes after the selector: sigData is three words, then token, recipient, amount, srcChain, two offsets
const TOKEN_WORD = 3;
const RECIPIENT_WORD = 4;
const AMOUNT_WORD = 5;
const MESSAGE_OFFSET_WORD = 8;
// A sale message is six words, home message[96:128] and claimer message[160:192], as SaleVaultProxyFactory.cfReceive reads it
const SALE_MESSAGE_BYTES = 192;
const SALE_MESSAGE_HOME_WORD = 3;
const SALE_MESSAGE_CLAIMER_WORD = 5;
// One FailedForeignChainCall is a u32 broadcast id then a u32 epoch, both little-endian
const FAILED_CALL_BYTES = 8;

/** The storage key of `ArbitrumIngressEgress.FailedForeignChainCalls` for one epoch, a Twox64Concat u32 key. */
export function failedCallsKey(epoch: number): string {
  const le = new Uint8Array(4);
  new DataView(le.buffer).setUint32(0, epoch, true);
  const prefix = [xxhashAsU8a('ArbitrumIngressEgress', 128), xxhashAsU8a('FailedForeignChainCalls', 128), xxhashAsU8a(le, 64), le];
  return u8aToHex(Uint8Array.from(prefix.flatMap((part) => [...part])));
}

/** Decode a SCALE `Vec<FailedForeignChainCall>`, an absent entry being empty. */
export function decodeFailedCalls(raw: unknown): { broadcastId: number; originalEpoch: number }[] {
  if (raw === null) return [];
  if (typeof raw !== 'string' || !/^0x([0-9a-fA-F]{2})+$/.test(raw)) throw new ChainUnavailableError(`rpc state_getStorage: not SCALE bytes, got ${JSON.stringify(raw)}`);
  const bytes = hexToU8a(raw);
  const [offset, length] = compactFromU8a(bytes);
  const n = length.toNumber();
  if (bytes.length !== offset + n * FAILED_CALL_BYTES) throw new ChainUnavailableError(`rpc state_getStorage: ${String(n)} failed calls do not fit ${String(bytes.length)} bytes`);
  const view = new DataView(bytes.buffer, bytes.byteOffset);
  return Array.from({ length: n }, (_, i) => ({
    broadcastId: view.getUint32(offset + i * FAILED_CALL_BYTES, true),
    originalEpoch: view.getUint32(offset + i * FAILED_CALL_BYTES + 4, true),
  }));
}

/** The CCM a failed call's payload makes, undefined for any other Vault call such as a transfer fallback. */
export function decodeCcmPayload(data: string): Pick<FailedCcm, 'recipient' | 'token' | 'amount' | 'home' | 'claimer'> | undefined {
  const hex = data.replace(/^0x/, '').toLowerCase();
  if (!hex.startsWith(EXECUTE_X_SWAP_AND_CALL)) return undefined;
  const body = hex.slice(8);
  const word = (i: number): string => {
    const out = body.slice(i * 64, i * 64 + 64);
    if (out.length !== 64) throw new ChainUnavailableError(`failed call payload has no word ${String(i)}`);
    return out;
  };
  const at = Number(BigInt(`0x${word(MESSAGE_OFFSET_WORD)}`)) / 32;
  const sale = Number(BigInt(`0x${word(at)}`)) === SALE_MESSAGE_BYTES;
  const homeWord = sale ? word(at + 1 + SALE_MESSAGE_HOME_WORD) : '';
  const claimerWord = sale ? word(at + 1 + SALE_MESSAGE_CLAIMER_WORD) : '';
  // Only what cfReceive books: a nonzero home and a nonzero claimer word within 160 bits
  const booked = /[1-9a-f]/.test(homeWord) && claimerWord.startsWith('0'.repeat(24)) && /[1-9a-f]/.test(claimerWord);
  return {
    recipient: decodeAddress(body, RECIPIENT_WORD),
    token: decodeAddress(body, TOKEN_WORD),
    amount: BigInt(`0x${word(AMOUNT_WORD)}`),
    home: booked ? `0x${homeWord}` : undefined,
    claimer: booked ? `0x${claimerWord.slice(24)}` : undefined,
  };
}

/** Reads the current epoch's failed Arbitrum calls and their payloads off the State Chain. */
export class FailedCalls {
  constructor(private readonly rpc: RpcTransport) {}

  /** Every failed CCM whose payload the current epoch can still submit. */
  async failedCcms(): Promise<FailedCcm[]> {
    const epoch = await this.rpc('cf_current_epoch', []);
    if (typeof epoch !== 'number' || !Number.isSafeInteger(epoch) || epoch < 0) throw new ChainUnavailableError(`rpc cf_current_epoch: not an epoch, got ${JSON.stringify(epoch)}`);
    const calls = decodeFailedCalls(await this.rpc('state_getStorage', [failedCallsKey(epoch)]));
    const out: FailedCcm[] = [];
    for (const call of calls) {
      // Null once the payload can no longer be sent, such as after a resubmit, while the entry stays listed
      const tx = (await this.rpc('cf_failed_call_arbitrum', [call.broadcastId])) as { contract?: unknown; data?: unknown } | null;
      if (tx === null) continue;
      if (typeof tx.contract !== 'string' || typeof tx.data !== 'string') throw new ChainUnavailableError(`rpc cf_failed_call_arbitrum ${String(call.broadcastId)}: no contract or data`);
      const ccm = decodeCcmPayload(tx.data);
      if (ccm !== undefined) out.push({ ...call, contract: tx.contract.toLowerCase(), ...ccm });
    }
    return out;
  }
}
