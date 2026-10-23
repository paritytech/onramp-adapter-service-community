import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChainUnavailableError, RefundAmbiguousError, SaleVaultClient, fetchTransport } from '../../src/salevault/chain.js';
import { eventTopic, topicOf } from '../../src/salevault/abi.js';

const hexToBytes = (hex: string): Uint8Array => {
  const clean = hex.replace(/^0x/, '');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
};

const KEY = hexToBytes('0x4646464646464646464646464646464646464646464646464646464646464646');
const CFG = {
  rpcUrl: 'http://localhost',
  chainId: 421614n,
  contract: '0x81949127042930F8e7A1723385A2F76213C72ee9',
};

// A 32-byte word for a uint.
const uintWord = (n: bigint) => n.toString(16).padStart(64, '0');

describe('SaleVaultClient refund attribution', () => {
  const REF = `0x${'22'.repeat(32)}`;
  const RECIPIENT = `0x${'33'.repeat(20)}`;
  const USDC = '0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d';
  const SALE_PAID = eventTopic('SalePaid(bytes32,address,uint256,uint256)');
  const TRANSFER = eventTopic('Transfer(address,address,uint256)');

  // A chain whose SalePaid sits at `paidAt` and whose transfers are listed by block, served window by window.
  function chain(latest: bigint, paidAt: bigint | null, transfers: [bigint, bigint][], otherPaidAt: bigint[] = []) {
    const windows: { address: string; from: bigint; to: bigint }[] = [];
    const rpc = vi.fn(async (method: string, params: unknown[]) => {
      if (method === 'eth_blockNumber') return `0x${latest.toString(16)}`;
      if (method === 'eth_call') return `0x${'00'.repeat(12)}${USDC.slice(2)}`;
      const [filter] = params as [{ address: string; topics: (string | null)[]; fromBlock: string; toBlock: string }];
      const from = BigInt(filter.fromBlock);
      const to = BigInt(filter.toBlock);
      windows.push({ address: filter.address, from, to });
      expect(to - from).toBeLessThan(10_000_000n);
      if (filter.topics[0] === SALE_PAID && filter.topics[1] === null) {
        // Every SalePaid to this recipient, ours included, by recipient topic.
        expect(filter.topics).toEqual([SALE_PAID, null, topicOf(RECIPIENT)]);
        const paid: [bigint, string][] = [
          ...(paidAt === null ? [] : [[paidAt, REF] as [bigint, string]]),
          ...otherPaidAt.map((b) => [b, `0x${'99'.repeat(32)}`] as [bigint, string]),
        ];
        return paid
          .filter(([block]) => block >= from && block <= to)
          .map(([block, ref]) => ({ blockNumber: `0x${block.toString(16)}`, topics: [SALE_PAID, ref, topicOf(RECIPIENT)], data: '0x' }));
      }
      if (filter.topics[0] === SALE_PAID) {
        expect(filter.topics).toEqual([SALE_PAID, REF]);
        return paidAt !== null && paidAt >= from && paidAt <= to ? [{ blockNumber: `0x${paidAt.toString(16)}`, data: '0x' }] : [];
      }
      expect(filter.address).toBe(USDC);
      expect(filter.topics).toEqual([TRANSFER, topicOf(RECIPIENT), topicOf(CFG.contract)]);
      return transfers
        .filter(([block]) => block >= from && block <= to)
        .map(([block, amount]) => ({ blockNumber: `0x${block.toString(16)}`, data: `0x${uintWord(amount)}` }));
    });
    return { client: SaleVaultClient.create(CFG, () => KEY, rpc), windows };
  }

  it('sums only the transfers from the paid address that came after the payout', async () => {
    const { client } = chain(30_000_000n, 12_000_000n, [
      [11_999_999n, 7n], // before the payout, another sale's
      [12_000_001n, 40n],
      [29_000_000n, 20n],
    ]);
    expect(await client.refundedSince(REF, RECIPIENT)).toBe(60n);
  });

  it('waits until the newest refund transfer is an hour of blocks old, so a split refund lands whole', async () => {
    const young = chain(30_000_000n, 12_000_000n, [
      [12_000_001n, 40n],
      [29_990_000n, 20n], // ten thousand blocks ago, still arriving
    ]);
    expect(await young.client.refundedSince(REF, RECIPIENT)).toBe(0n);
    const settled = chain(30_000_000n, 12_000_000n, [
      [12_000_001n, 40n],
      [29_985_600n, 20n], // exactly the settle window ago
    ]);
    expect(await settled.client.refundedSince(REF, RECIPIENT)).toBe(60n);
  });

  it('searches the payout back window by window and reads transfers forward from it', async () => {
    const { client, windows } = chain(30_000_000n, 12_000_000n, []);
    await client.refundedSince(REF, RECIPIENT);
    const paidWindows = windows.filter((w) => w.address === CFG.contract).slice(0, 4);
    expect(paidWindows.map((w) => [w.from, w.to])).toEqual([
      [25_000_001n, 30_000_000n],
      [20_000_001n, 25_000_000n],
      [15_000_001n, 20_000_000n],
      [10_000_001n, 15_000_000n],
    ]);
    const transferWindows = windows.filter((w) => w.address === USDC);
    expect(transferWindows.map((w) => [w.from, w.to])).toEqual([
      [12_000_000n, 16_999_999n],
      [17_000_000n, 21_999_999n],
      [22_000_000n, 26_999_999n],
      [27_000_000n, 30_000_000n],
    ]);
  });

  it('refuses to attribute a refund once another sale was paid to the same address', async () => {
    const { client } = chain(30_000_000n, 12_000_000n, [[20_000_000n, 40n]], [15_000_000n]);
    await expect(client.refundedSince(REF, RECIPIENT)).rejects.toThrow(RefundAmbiguousError);
  });

  it('ignores its own payout among the payouts to the same address', async () => {
    const { client } = chain(30_000_000n, 12_000_000n, [[12_000_000n, 9n], [20_000_000n, 40n]]);
    // The transfer in the payout block itself predates no refund, only later ones count.
    expect(await client.refundedSince(REF, RECIPIENT)).toBe(40n);
  });

  it('answers zero without reading transfers when the sale was never paid', async () => {
    const { client, windows } = chain(70_000_000n, null, [[69_000_000n, 5n]]);
    expect(await client.refundedSince(REF, RECIPIENT)).toBe(0n);
    expect(windows.every((w) => w.address === CFG.contract)).toBe(true);
    expect(windows).toHaveLength(12);
  });

  it('stops the search at block zero on a young chain', async () => {
    const { client, windows } = chain(3_000_000n, null, []);
    expect(await client.refundedSince(REF, RECIPIENT)).toBe(0n);
    expect(windows.map((w) => [w.from, w.to])).toEqual([[0n, 3_000_000n]]);
  });

  it('reads the USDC token off the contract', async () => {
    const { client } = chain(1n, null, []);
    expect(await client.usdc()).toBe(USDC);
  });

  it('treats a log reply that is not a list as an unavailable chain', async () => {
    const rpc = vi.fn(async (method: string) => (method === 'eth_blockNumber' ? '0x10' : { not: 'a list' }));
    const client = SaleVaultClient.create(CFG, () => KEY, rpc);
    await expect(client.refundedSince(REF, RECIPIENT)).rejects.toThrow(ChainUnavailableError);
  });
});

describe('SaleVaultClient', () => {
  it('derives the operator address from the key', () => {
    const client = SaleVaultClient.create(CFG, () => KEY, async () => '0x0');
    expect(client.operatorAddress.toLowerCase()).to.equal('0x9d8a62f656a8d1615c1294fd71e9cfb3e4855a4f');
  });

  it('reads and decodes a sale', async () => {
    const recipient = '00000000000000000000000081949127042930f8e7a1723385a2f76213c72ee9';
    const home = 'ab'.repeat(32);
    const rpc = vi.fn(async () => `0x${recipient}${uintWord(100n)}${home}${uintWord(0n)}${uintWord(1n)}`);
    const client = SaleVaultClient.create(CFG, () => KEY, rpc);
    const sale = await client.sale('0x' + '11'.repeat(32));
    expect(sale.recipient.toLowerCase()).to.equal('0x81949127042930f8e7a1723385a2f76213c72ee9');
    expect(sale.amount).to.equal(100n);
    expect(sale.home).to.equal(`0x${home}`);
    expect(sale.status).to.equal(1);
  });

  it('reads dust and unclaimed', async () => {
    const rpc = vi.fn(async () => `0x${uintWord(500_000n)}`);
    const client = SaleVaultClient.create(CFG, () => KEY, rpc);
    expect(await client.dust()).to.equal(500_000n);
    expect(await client.unclaimed()).to.equal(500_000n);
  });

  it('builds, signs and broadcasts a returnRefund transaction', async () => {
    const calls: { method: string; params: unknown[] }[] = [];
    const rpc = vi.fn(async (method: string, params: unknown[]) => {
      calls.push({ method, params });
      if (method === 'eth_getTransactionCount') return '0x7';
      if (method === 'eth_maxPriorityFeePerGas') return '0x3b9aca00';
      if (method === 'eth_getBlockByNumber') return { baseFeePerGas: '0x3b9aca00' };
      if (method === 'eth_estimateGas') return '0x186a0';
      if (method === 'eth_sendRawTransaction') return '0xtxid';
      return '0x0';
    });
    const client = SaleVaultClient.create(CFG, () => KEY, rpc);
    const hash = await client.returnRefund('0x' + '22'.repeat(32), 100n, '0x');
    const sent = calls.find((c) => c.method === 'eth_sendRawTransaction');
    expect(sent).to.not.equal(undefined);
    const raw = (sent?.params[0] ?? '') as string;
    expect(raw.startsWith('0x02')).to.equal(true); // an EIP-1559 (type 2) transaction
    expect(hash.startsWith('0x')).to.equal(true);
  });

  it('surfaces an rpc error as ChainUnavailableError', async () => {
    const rpc = vi.fn(async () => {
      throw new Error('boom');
    });
    const client = SaleVaultClient.create(CFG, () => KEY, rpc);
    await expect(client.dust()).rejects.toThrow('boom');
  });

  it('rejects a read that answers with a non-hex result', async () => {
    const rpc = vi.fn(async () => 42);
    const client = SaleVaultClient.create(CFG, () => KEY, rpc);
    await expect(client.dust()).rejects.toThrow(/expected hex/);
  });

  // The three remaining writes share the send path returnRefund already proved. Each must still
  // issue a type-2 transaction and hand back a hash.
  const sendRpc = () =>
    vi.fn(async (method: string) => {
      if (method === 'eth_getTransactionCount') return '0x7';
      if (method === 'eth_maxPriorityFeePerGas') return '0x3b9aca00';
      if (method === 'eth_getBlockByNumber') return null; // no base fee in the block, so it falls back to 0
      if (method === 'eth_estimateGas') return '0x186a0';
      if (method === 'eth_sendRawTransaction') return '0xtxid';
      return '0x0';
    });

  it('builds and broadcasts returnHeld', async () => {
    const client = SaleVaultClient.create(CFG, () => KEY, sendRpc());
    expect((await client.returnHeld(`0x${'22'.repeat(32)}`, '0x')).startsWith('0x')).toBe(true);
  });

  it('builds and broadcasts resolveUnknown', async () => {
    const client = SaleVaultClient.create(CFG, () => KEY, sendRpc());
    expect((await client.resolveUnknown(`0x${'ab'.repeat(32)}`, 100n, '0x')).startsWith('0x')).toBe(true);
  });

  it('builds and broadcasts withdrawDust', async () => {
    const client = SaleVaultClient.create(CFG, () => KEY, sendRpc());
    expect((await client.withdrawDust(100n)).startsWith('0x')).toBe(true);
  });

  it('prices a send on the block base fee when the block carries one', async () => {
    const rpc = vi.fn(async (method: string) => {
      if (method === 'eth_getTransactionCount') return '0x7';
      if (method === 'eth_maxPriorityFeePerGas') return '0x3b9aca00';
      if (method === 'eth_getBlockByNumber') return { baseFeePerGas: '0x3b9aca00' };
      if (method === 'eth_estimateGas') return '0x186a0';
      if (method === 'eth_sendRawTransaction') return '0xtxid';
      return '0x0';
    });
    const client = SaleVaultClient.create(CFG, () => KEY, rpc);
    expect((await client.withdrawDust(100n)).startsWith('0x')).toBe(true);
  });

  it('rejects a send when the RPC answers with an empty, non-quantity hex', async () => {
    const rpc = vi.fn(async (method: string) => {
      if (method === 'eth_maxPriorityFeePerGas') return '0x'; // valid 0x prefix, but no digits
      if (method === 'eth_getTransactionCount') return '0x7';
      if (method === 'eth_getBlockByNumber') return null;
      return '0x186a0';
    });
    const client = SaleVaultClient.create(CFG, () => KEY, rpc);
    await expect(client.withdrawDust(100n)).rejects.toThrow(/hex quantity/);
  });

  it('refuses to sign against a gas price beyond the sane ceiling', async () => {
    const rpc = vi.fn(async (method: string) => {
      if (method === 'eth_getTransactionCount') return '0x7';
      if (method === 'eth_maxPriorityFeePerGas') return '0x3b9aca00';
      // 2000 gwei base fee: a hostile or broken RPC, far beyond any real Arbitrum fee.
      if (method === 'eth_getBlockByNumber') return { baseFeePerGas: `0x${(2_000_000_000_000n).toString(16)}` };
      return '0x186a0';
    });
    const client = SaleVaultClient.create(CFG, () => KEY, rpc);
    await expect(client.withdrawDust(100n)).rejects.toThrow(/sane ceiling/);
  });

  it('reads a receipt: success, failure, or null while pending', async () => {
    const mined = SaleVaultClient.create(CFG, () => KEY, vi.fn(async () => ({ status: '0x1' })));
    expect(await mined.receipt('0xdead')).toEqual({ status: true });
    const reverted = SaleVaultClient.create(CFG, () => KEY, vi.fn(async () => ({ status: '0x0' })));
    expect(await reverted.receipt('0xdead')).toEqual({ status: false });
    const pending = SaleVaultClient.create(CFG, () => KEY, vi.fn(async () => null));
    expect(await pending.receipt('0xdead')).toBeNull();
  });
});

describe('fetchTransport', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const response = (body: unknown, ok = true, status = 200) => ({
    ok,
    status,
    json: async () => body,
  });

  it('is the default transport and posts a JSON-RPC request', async () => {
    const fetchMock = vi.fn(async () => response({ result: `0x${'0'.repeat(63)}5` }));
    vi.stubGlobal('fetch', fetchMock);
    const client = SaleVaultClient.create(CFG, () => KEY);
    expect(await client.dust()).toBe(5n);
    expect(fetchMock).toHaveBeenCalledWith('http://localhost', expect.objectContaining({ method: 'POST' }));
  });

  it('raises ChainUnavailableError on a non-2xx status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(undefined, false, 503)));
    await expect(fetchTransport('http://localhost')('eth_call', [])).rejects.toThrow(/returned 503/);
  });

  it('raises ChainUnavailableError when the body carries an rpc error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ error: { message: 'bad params' } })));
    await expect(fetchTransport('http://localhost')('eth_call', [])).rejects.toThrow(/bad params/);
  });

  it('raises ChainUnavailableError when the body error has no message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ error: {} })));
    await expect(fetchTransport('http://localhost')('eth_call', [])).rejects.toThrow(/unknown/);
  });

  it('raises ChainUnavailableError when the transport itself fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('connection refused');
      }),
    );
    await expect(fetchTransport('http://localhost')('eth_call', [])).rejects.toThrow(/transport failed/);
  });
});
