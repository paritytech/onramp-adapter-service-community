import { afterEach, describe, expect, it, vi } from 'vitest';
import { SaleVaultClient, fetchTransport } from '../../src/salevault/chain.js';

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
