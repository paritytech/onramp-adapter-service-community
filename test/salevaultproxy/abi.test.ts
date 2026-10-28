import { u8aToHex } from '@polkadot/util';
import { describe, expect, it } from 'vitest';

import {
  addressTopic,
  bytes32,
  decodeAddress,
  decodeBool,
  decodeBytes32,
  decodeClaimerProxyState,
  decodeDeferral,
  decodeDelivery,
  decodePendingFlushed,
  decodeShortString,
  decodeUint,
  encodeAuthorizationState,
  encodeBalanceOf,
  encodeCall,
  encodeClaimerTermsCall,
  encodeDelivery,
  encodeHomeClaimerCall,
  encodeRelease,
  encodeRetired,
  eventTopic,
  saleRef,
  selector,
  topicAddress,
  word,
} from '../../src/salevaultproxy/abi.js';

const bytesToHex = (bytes: Uint8Array): string => u8aToHex(bytes).slice(2);

const HOME = `0x${'ab'.repeat(32)}`;
// A raw delivery() answer the contract returns, with what it decodes to
const VECTORS = {
  delivery: {
    ref: '0x1bb189b93efbea7d1c29bbcc09f8531217792fb352f6382e646b312153a3f9de',
    recipient: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
    raw: '0x00000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000003010b000000000000000000000000000000000000000000000000000000000000061a80',
  },
} as const;
const w = (value: bigint | string): string =>
  typeof value === 'bigint' ? value.toString(16).padStart(64, '0') : value.replace(/^0x/, '').padStart(64, '0');

describe('selectors', () => {
  it.each([
    ['returnHome()', '2aadc832'],
    ['release()', '86d1a69f'],
    ['releaseAt()', 'ae69ef4c'],
    ['claimer()', 'd379be23'],
    ['state()', 'c19d93fb'],
    ['home()', '9fa92f9d'],
    ['retired()', '2eb38ae0'],
    ['GUARDIAN()', '724c184c'],
    ['skim()', '1dd19cb4'],
    ['totalPending()', '3f90916a'],
    ['IMPLEMENTATION()', '3a4741bd'],
    ['VAULT()', '411557d1'],
    ['USDC()', '89a30271'],
    ['TREASURY()', '2d2c5565'],
    ['FACTORY()', '2dd31000'],
    ['BROKER()', 'eae2396f'],
    ['RETRY_BLOCKS()', 'f036a575'],
    ['MIN_RETURN()', '0151900d'],
    ['MAX_RETURN()', '90b18557'],
    ['PRICE_FLOOR_BPS()', 'cf056f5b'],
    ['FEE_ALLOWANCE()', 'd44b57ea'],
    ['RETURN_COOLDOWN()', '47446418'],
    ['HOME_CHAIN()', 'f42ff394'],
    ['HOME_TOKEN()', 'f2553acd'],
    ['RELEASE_DELAY()', 'a302e232'],
    ['RELEASE_ATTEMPTS()', '3c0b1a93'],
    ['STALE_DELAY()', 'a1f3888a'],
    ['delivery(bytes32,address,uint256)', 'cf951176'],
    ['balanceOf(address)', '70a08231'],
  ])('%s is 0x%s', (signature, expected) => {
    expect(bytesToHex(selector(signature))).toBe(expected);
    expect(encodeCall(signature)).toBe(`0x${expected}`);
  });
});

describe('encoders', () => {
  it('encodes a balance read, refusing a bad address', () => {
    expect(encodeBalanceOf('0x1111111111111111111111111111111111111111')).toBe(`0x70a08231${w('11'.repeat(20))}`);
    expect(() => encodeBalanceOf('0x12')).toThrow(/address is malformed/);
  });

  it('pads words and refuses what does not fit', () => {
    expect(bytesToHex(word(1n))).toBe(w(1n));
    expect(() => word(-1n)).toThrow(/negative/);
    expect(() => word(1n << 256n)).toThrow(/exceeds/);
    expect(bytesToHex(bytes32('0x01'))).toBe(w(1n));
    expect(() => bytes32(`0x${'00'.repeat(33)}`)).toThrow(/exceeds/);
    expect(() => bytes32('0x123')).toThrow(/not hex/);
    expect(() => bytes32('0xzz')).toThrow(/not hex/);
  });

  it('derives the sale ref from the funding id', () => {
    expect(saleRef('funding-1')).toBe('0xc0615bcc697a20445b853b8779e01ab7c45752dbd7ab43f9c3dc100a83e5b52c');
  });
});

describe('decoders', () => {
  it('reads an address, a uint by word and a bytes32', () => {
    expect(decodeAddress(`0x${w('AbCd'.padStart(40, '0'))}`)).toBe(`0x${'abcd'.padStart(40, '0')}`);
    expect(decodeUint(`0x${w(42n)}`)).toBe(42n);
    expect(decodeUint(`0x${w(1n)}${w(42n)}`, 1)).toBe(42n);
    expect(decodeBytes32(`0x${'AB'.repeat(32)}`)).toBe(HOME);
  });

  it('reads a pend reason left-aligned in its word', () => {
    const reason = Buffer.from('deploy').toString('hex').padEnd(64, '0');
    expect(decodeShortString(`0x${w(5n)}${reason}`, 1)).toBe('deploy');
    expect(() => decodeShortString(`0x${w(5n)}`, 1)).toThrow(/no word 1/);
  });

  it('refuses a reply too short or not hex', () => {
    expect(() => decodeUint('0x')).toThrow(/no word 0/);
    expect(() => decodeUint('0xzz')).toThrow(/not hex/);
  });

  it('decodes one sale of the contract sample and refuses an unknown status', () => {
    expect(decodeDelivery(VECTORS.delivery.raw)).toEqual({ status: 1, amount: 50_400_000n, leftover: 400_000n });
    expect(() => decodeDelivery(`0x${w(3n)}${w(0n)}${w(0n)}`)).toThrow(/unknown sale status/);
  });
});

describe('logs', () => {
  const CLAIMER = '0x90d121876b4f93da56f039139fdf37a96cde00c3';
  const log = (topics: string[], data: string) => ({ address: `0x${'11'.repeat(20)}`, topics, data, txHash: `0x${'aa'.repeat(32)}`, logIndex: 0 });

  it('decodes a DeliveryDeferred or DeferredExpired log with its claimer and deadline, refusing a short one', () => {
    const data = `0x${w(VECTORS.delivery.recipient)}${w(50_000_000n)}${w(49_000_000n)}${w(1_795_590_573n)}`;
    for (const name of ['DeliveryDeferred', 'DeferredExpired']) {
      const topics = [eventTopic(`${name}(bytes32,address,bytes32,address,uint256,uint256,uint256)`), HOME, addressTopic(CLAIMER), VECTORS.delivery.ref];
      expect(decodeDeferral(log(topics, data))).toEqual({
        home: HOME,
        claimer: CLAIMER,
        ref: VECTORS.delivery.ref,
        recipient: VECTORS.delivery.recipient.toLowerCase(),
        committed: 50_000_000n,
        amount: 49_000_000n,
        deadline: 1_795_590_573n,
      });
      expect(() => decodeDeferral(log(topics.slice(0, 3), data))).toThrow(/no home, claimer or third topic/);
      expect(() => decodeDeferral(log(topics, data.slice(0, -64)))).toThrow(/not four words/);
    }
  });

  it('decodes a PendingFlushed log with where it paid', () => {
    const topics = [eventTopic('PendingFlushed(bytes32,address,address,uint256)'), HOME, addressTopic(CLAIMER), addressTopic(CLAIMER)];
    expect(decodePendingFlushed(log(topics, `0x${w(7n)}`))).toEqual({ home: HOME, claimer: CLAIMER, to: CLAIMER, amount: 7n });
    expect(() => decodePendingFlushed(log(topics.slice(0, 2), `0x${w(7n)}`))).toThrow(/no home, claimer or third topic/);
  });

  it('pads and reads an address topic', () => {
    expect(topicAddress(addressTopic(VECTORS.delivery.recipient))).toBe(VECTORS.delivery.recipient.toLowerCase());
  });

  // Each event's topic hash as the contract vectors pin it
  it.each([
    ['Delivered(bytes32,address,bytes32,address,address,uint256,uint256)', '0x740323cc1a31028876638a289f378128325a303cfdd063bc2e5a04b1a5573901'],
    ['DeliveryDeferred(bytes32,address,bytes32,address,uint256,uint256,uint256)', '0xf36d2d6895ea5d23911fc17f8da4f81118ebdd213c96e7846d32873bc35dd96e'],
    ['DeliveryPending(bytes32,address,bytes32,uint256,bytes32)', '0xa439ba302799ba5f6662ccfbba2be083951241f8d802d477e9f323e8678a4f75'],
    ['DeliveryUnbooked(bytes32,address,bytes32,address,uint256)', '0xae542f0e78232e4f714dd64ac912880fcd90e29d239f9abee813117f463b1d06'],
    ['DeferredExpired(bytes32,address,bytes32,address,uint256,uint256,uint256)', '0x2ff0a87413e8741befdd6c42c9b6b8ef0b9bf66e48412812267ecb4835288298'],
    ['PendingFlushed(bytes32,address,address,uint256)', '0x1dc85fc3f58e3ec3a5a227beb1c5ca1500834ad3b5955ba342ec59cf7b4d12ec'],
    ['Retired()', '0xc15f68f0a72806ff3f8bf2435385a67c4c22413f1c7931ef7bcea718e6ffcf03'],
    ['Released(uint256)', '0xfb81f9b30d73d830c3544b34d827c08142579ee75710b490bab0b3995468c565'],
    ['Unattributed(address,uint256,bytes32)', '0x0787f9200c6edc0c789aa92966501bc1cc341358e5ff68465e15a5cc668bd752'],
  ])('the keeper watches %s as the contract emits it', (signature, topic) => {
    expect(eventTopic(signature)).toBe(topic);
  });
});

describe('the claimer-bound contract', () => {
  const CLAIMER = '0x90D121876b4f93DA56F039139fdF37a96cde00c3';
  const TERMS = { home: HOME, claimer: CLAIMER, ref: VECTORS.delivery.ref, recipient: VECTORS.delivery.recipient, committed: 50_000_000n };
  // Selectors and state() as the regenerated contract vectors pin them
  const CLAIMER_VECTORS = {
    'flush(bytes32,address)': '0xb026fd99',
    'deploy(bytes32,address)': '0x8c1fb931',
    'pending(bytes32,address)': '0xda4e6595',
    'predict(bytes32,address)': '0xc4b9f746',
    'deliver(bytes32,address,bytes32,address,uint256,uint256)': '0x67b12c52',
    'expireDeferred(bytes32,address,bytes32,address,uint256,uint256)': '0xae50b33c',
    'pendingDelivery(bytes32,address,bytes32,address,uint256,uint256)': '0x4be199b9',
    stateRaw:
      '0x62b6213d2086917d3e2a2e73a6097257fb8dc33aeae24f8ec5c066dc32639a6500000000000000000000000090d121876b4f93da56f039139fdf37a96cde00c3000000000000000000000000000000000000000000000000000000000007a120000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000006ae0914c0000000000000000000000000000000000000000000000000000000000000000',
  } as const;

  it('keys a factory call by home then claimer', () => {
    for (const signature of ['flush(bytes32,address)', 'deploy(bytes32,address)', 'pending(bytes32,address)', 'predict(bytes32,address)'] as const) {
      expect(encodeHomeClaimerCall(signature, HOME, CLAIMER)).toBe(`${CLAIMER_VECTORS[signature]}${'ab'.repeat(32)}${'0'.repeat(24)}${CLAIMER.slice(2).toLowerCase()}`);
    }
    expect(() => encodeHomeClaimerCall('flush(bytes32,address)', HOME, '0x12')).toThrow(/claimer is malformed/);
  });

  it('refuses a short or non-hex bytes32 nonce, ref or home', () => {
    for (const bad of [`0x${'ab'.repeat(31)}`, `0x${'zz'.repeat(32)}`]) {
      expect(() => encodeAuthorizationState(CLAIMER, bad)).toThrow(/nonce is malformed/);
      expect(() => encodeHomeClaimerCall('flush(bytes32,address)', bad, CLAIMER)).toThrow(/home is malformed/);
      expect(() => encodeDelivery({ ...TERMS, ref: bad })).toThrow(/ref is malformed/);
    }
  });

  it('encodes the per-sale lookup without home or claimer', () => {
    expect(encodeDelivery(TERMS)).toBe(`0xcf951176${VECTORS.delivery.ref.slice(2)}${w(VECTORS.delivery.recipient.toLowerCase())}${w(50_000_000n)}`);
  });

  it('puts home and claimer before the terms and the deadline', () => {
    for (const signature of [
      'deliver(bytes32,address,bytes32,address,uint256,uint256)',
      'expireDeferred(bytes32,address,bytes32,address,uint256,uint256)',
      'pendingDelivery(bytes32,address,bytes32,address,uint256,uint256)',
    ] as const) {
      const data = encodeClaimerTermsCall(signature, TERMS, 1_793_094_375n);
      expect(data.slice(0, 10)).toBe(CLAIMER_VECTORS[signature]);
      expect(data.slice(10)).toBe(
        bytesToHex(bytes32(HOME)) +
          bytesToHex(bytes32(CLAIMER)) +
          bytesToHex(bytes32(TERMS.ref)) +
          bytesToHex(bytes32(TERMS.recipient)) +
          bytesToHex(word(TERMS.committed)) +
          bytesToHex(word(1_793_094_375n)),
      );
    }
    expect(() => encodeClaimerTermsCall('deliver(bytes32,address,bytes32,address,uint256,uint256)', { ...TERMS, claimer: 'nope' }, 1n)).toThrow(/claimer/);
  });

  it('encodes release and retired', () => {
    expect(encodeRelease()).toBe('0x86d1a69f');
    expect(encodeRetired()).toBe('0x2eb38ae0');
  });

  it('decodes a bool and refuses any other word', () => {
    expect(decodeBool(bytesToHex(word(1n)))).toBe(true);
    expect(decodeBool(`0x${bytesToHex(word(0n))}`)).toBe(false);
    expect(() => decodeBool(`0x${bytesToHex(word(2n))}`)).toThrow(/not a bool/);
  });

  it('decodes the eight-word state() of a deployed proxy', () => {
    expect(decodeClaimerProxyState(CLAIMER_VECTORS.stateRaw)).toEqual({
      home: '0x62b6213d2086917d3e2a2e73a6097257fb8dc33aeae24f8ec5c066dc32639a65',
      claimer: CLAIMER.toLowerCase(),
      balance: 500_000n,
      attempts: 0,
      lastReturnAt: 0n,
      nextReturnAt: 0n,
      releaseAt: 1_793_102_156n,
      releasable: 0n,
    });
    expect(() => decodeClaimerProxyState(CLAIMER_VECTORS.stateRaw.slice(0, 2 + 7 * 64))).toThrow(/no word 7/);
  });
});
