import { createHmac } from 'node:crypto';

import { SignJWT, importJWK } from 'jose';
import { describe, expect, it, vi } from 'vitest';

import { hexToU8a, u8aToHex } from '@polkadot/util';
import { blake2AsU8a, xxhashAsU8a } from '@polkadot/util-crypto';
import { stringToU8a, u8aConcat } from '@polkadot/util';

import {
  mintChallenge,
  verifyChallenge,
  InvalidChallenge,
  CHALLENGE_BYTES,
  NONCE_BYTES,
} from '../../src/personhood/challenge.js';
import { membersRootKey } from '../../src/personhood/key.js';
import { ProofRejected, ProofRefusal, verifyRingMembership } from '../../src/personhood/register.js';
import { commitmentsFrom } from '../../src/personhood/source.js';
import { chainReader, type ChainReader } from '../../src/personhood/chain.js';
import { redeemRequest } from '../../src/contract.js';
import { mintToken, verifyToken } from '../../src/personhood/token.js';

const KEY = new Uint8Array(32).fill(1);

describe('challenge', () => {
  it('mints a self-authenticating token of the documented length', () => {
    const token = mintChallenge(KEY);
    expect(token.byteLength).toBe(CHALLENGE_BYTES);
  });

  it('verifies a challenge it minted', () => {
    const token = mintChallenge(KEY, { issuedAtMillis: 1_000 });
    expect(() => {
      verifyChallenge(KEY, token, { now: 1_000, ttlMillis: 60_000 });
    }).not.toThrow();
  });

  it('rejects a token it did not mint', () => {
    const otherKey = new Uint8Array(32).fill(2);
    const token = mintChallenge(otherKey);
    expect(() => {
      verifyChallenge(KEY, token, { now: Date.now(), ttlMillis: 60_000 });
    }).toThrow(InvalidChallenge);
  });

  it('rejects a token whose timestamp is too old, naming "expired"', () => {
    const token = mintChallenge(KEY, { issuedAtMillis: 1_000 });
    expect(() => {
      verifyChallenge(KEY, token, { now: 10_000, ttlMillis: 5_000 });
    }).toThrow('expired');
  });

  it('rejects a token with the wrong byte length, naming "malformed"', () => {
    expect(() => {
      verifyChallenge(KEY, new Uint8Array(10), { now: 0, ttlMillis: 1_000 });
    }).toThrow('malformed');
  });

  it('distinguishes inauthentic from expired', () => {
    const token = mintChallenge(KEY, { issuedAtMillis: 1_000 });
    // Flip the last HMAC byte so the MAC no longer matches.
    const forged = token.slice();
    const last = forged[CHALLENGE_BYTES - 1];
    if (last === undefined) throw new Error('challenge shorter than expected');
    forged.set([last ^ 0xff], CHALLENGE_BYTES - 1);
    expect(() => {
      verifyChallenge(KEY, forged, { now: 1_000, ttlMillis: 1_000 });
    }).toThrow('inauthentic');
  });

  it('rejects a token whose timestamp was rewritten, naming "inauthentic"', () => {
    // The MAC covers `nonce || issuedAt`, not the nonce alone. Were it over the nonce only, any
    // challenge ever issued could be re-dated to the present and replayed indefinitely: the
    // TTL below would still be checked, but against an attacker-chosen number.
    const token = mintChallenge(KEY, { issuedAtMillis: 1_000 });
    const restamped = token.slice();
    new DataView(restamped.buffer).setBigUint64(NONCE_BYTES, BigInt(1_000_000), false);
    expect(() => {
      verifyChallenge(KEY, restamped, { now: 1_000_000, ttlMillis: 60_000 });
    }).toThrow('inauthentic');
  });

  it('accepts a challenge at exactly the TTL, and refuses it one millisecond later', () => {
    const token = mintChallenge(KEY, { issuedAtMillis: 1_000 });
    expect(() => {
      verifyChallenge(KEY, token, { now: 6_000, ttlMillis: 5_000 });
    }).not.toThrow();
    expect(() => {
      verifyChallenge(KEY, token, { now: 6_001, ttlMillis: 5_000 });
    }).toThrow('expired');
  });

  it('rejects a token with trailing bytes, naming "malformed"', () => {
    // An over-long token is as malformed as a short one: the MAC sits at a fixed offset, so
    // accepting extra bytes would verify a prefix and ignore whatever followed it.
    const token = mintChallenge(KEY, { issuedAtMillis: 1_000 });
    const padded = new Uint8Array(CHALLENGE_BYTES + 1);
    padded.set(token, 0);
    expect(() => {
      verifyChallenge(KEY, padded, { now: 1_000, ttlMillis: 60_000 });
    }).toThrow('malformed');
  });

  it('lays the token out byte for byte as identity-backend does', () => {
    // `challenge.ts` claims byte-compatibility with identity-backend's `challenge.schema.ts`, and
    // nothing pinned it: flipping the timestamp's byte order inside the MAC is self-consistent, so
    // every existing test still passed. A golden vector is the only thing that can catch that,
    // because the property is about the bytes on the wire and not about round-tripping.
    const key = new Uint8Array(32).fill(7);
    const nonce = new Uint8Array(16).fill(3);
    const token = mintChallenge(key, { issuedAtMillis: 1_700_000_000_000, nonce });

    expect(token.byteLength).toBe(56);
    // nonce(16) || issuedAt as u64 big-endian(8) || HMAC-SHA256 over both(32).
    expect(Buffer.from(token.subarray(0, 16)).toString('hex')).toBe('03'.repeat(16));
    expect(Buffer.from(token.subarray(16, 24)).toString('hex')).toBe('0000018bcfe56800');
    // The MAC covers exactly those first 24 bytes, under this key.
    const expected = createHmac('sha256', key).update(token.subarray(0, 24)).digest();
    expect(Buffer.from(token.subarray(24)).toString('hex')).toBe(expected.toString('hex'));
  });

  it('rejects a nonce of the wrong length when minting', () => {
    expect(() => {
      mintChallenge(KEY, { nonce: new Uint8Array(15) });
    }).toThrow(/nonce must be/);
  });
});

describe('membersRootKey', () => {
  it('hashes pallet and storage names, appends the identifier verbatim, and blake2s the ring', () => {
    const identifier = '0x' + '44'.repeat(32);
    const ring = 9;
    const ringBytes = new Uint8Array(4);
    new DataView(ringBytes.buffer).setUint32(0, ring, true);
    const expected = u8aToHex(
      u8aConcat(
        xxhashAsU8a(stringToU8a('Members'), 128),
        xxhashAsU8a(stringToU8a('Root'), 128),
        hexToU8a(identifier),
        blake2AsU8a(ringBytes, 128),
        ringBytes,
      ),
    );
    expect(membersRootKey(identifier, ring)).toBe(expected);
  });

  it('refuses a non-32-byte identifier', () => {
    expect(() => membersRootKey('0x1234', 0)).toThrow(/32 bytes/);
  });
});

describe('commitmentsFrom', () => {
  it('reads the Root key and returns the first 768 bytes as the commitment', async () => {
    const commitment = '11'.repeat(768);
    const value = '0x' + commitment + 'aa' + 'bb'; // trailing bytes beyond the commitment
    const reader: ChainReader = {
      getStorage: async (key) => {
        expect(key).toBe(
          membersRootKey('0x' + '44'.repeat(32), 9),
        );
        return value;
      },
      };

    const source = commitmentsFrom(reader);
    const result = await source.commitment('0x' + '44'.repeat(32), 9);
    expect(result).toBe('0x' + commitment);
  });

  it('coalesces concurrent reads of one ring into a single chain round trip', async () => {
    // `chainReader` opens a fresh WebSocket per call and holds it for up to eight seconds, and
    // `/redeem` is public. Concurrent proofs against the same ring (the ordinary case, since a
    // deployment targets one collection) must cost one socket between them, not one each.
    const commitment = '11'.repeat(768);
    let opened = 0;
    let release: (v: string) => void = () => undefined;
    const reader: ChainReader = {
      getStorage: async () => {
        opened += 1;
        return new Promise<string>((resolve) => {
          release = resolve;
        });
      },
    };

    const source = commitmentsFrom(reader);
    const id = '0x' + '44'.repeat(32);
    const all = Promise.all([source.commitment(id, 9), source.commitment(id, 9), source.commitment(id, 9)]);
    release('0x' + commitment);

    expect(await all).toEqual(['0x' + commitment, '0x' + commitment, '0x' + commitment]);
    expect(opened).toBe(1);

    // And the map is cleared afterwards, so a later caller gets a fresh read rather than the
    // resolved one; a coalescing map that is never emptied is a cache, and this is deliberately
    // not a cache: a stale commitment would keep verifying proofs from a ring someone has been
    // removed from.
    const later = source.commitment(id, 9);
    release('0x' + commitment);
    await expect(later).resolves.toBe('0x' + commitment);
    expect(opened).toBe(2);
  });

  it('sheds a read past the in-flight ceiling rather than opening another socket', async () => {
    // The bound that actually holds. Coalescing does not: `ring` is caller-supplied and the schema
    // admits the whole u32 range, so an attacker varying it gets a distinct key every time and
    // every one would open its own socket. One ~1KB unauthenticated request buying one outbound
    // WebSocket held for eight seconds exhausts file descriptors on a 256Mi pod long before it
    // exhausts bandwidth, and floods the People RPC on this service's behalf.
    let opened = 0;
    const reader: ChainReader = {
      getStorage: async () => {
        opened += 1;
        // Never settles: every read stays in flight, which is the shape of the attack.
        return new Promise<string>(() => undefined);
      },
    };

    const source = commitmentsFrom(reader);
    const id = '0x' + '44'.repeat(32);
    // Distinct rings, so nothing coalesces.
    const held = Array.from({ length: 8 }, (_v, i) => source.commitment(id, i));
    void Promise.allSettled(held);

    await expect(source.commitment(id, 99)).rejects.toThrow(/in-flight ceiling/);
    // Eight sockets, and the ninth request opened none.
    expect(opened).toBe(8);
  });

  it('scales the ceiling with the collection count, so a second collection does not halve capacity', async () => {
    // One redeem walks the collections until a proof opens, so it costs up to one read per
    // collection. A flat read ceiling therefore expresses half as many concurrent redeems the day a
    // second collection is configured: a capacity change arriving through a config edit that
    // nobody chose. The bound is counted in redeems and moves with the count.
    let opened = 0;
    const reader: ChainReader = {
      getStorage: async () => {
        opened += 1;
        return new Promise<string>(() => undefined);
      },
    };

    const source = commitmentsFrom(reader, 2);
    const id = '0x' + '44'.repeat(32);
    const held = Array.from({ length: 16 }, (_v, i) => source.commitment(id, i));
    void Promise.allSettled(held);

    // Sixteen reads for two collections: still eight concurrent redeems, as with one.
    await expect(source.commitment(id, 99)).rejects.toThrow(/in-flight ceiling/);
    expect(opened).toBe(16);
  });

  it('returns null when the ring has no current root', async () => {
    const reader: ChainReader = { getStorage: async () => undefined };
    expect(await commitmentsFrom(reader).commitment('0x' + '44'.repeat(32), 9)).toBeNull();
  });

  it('refuses a Root shorter than the commitment rather than truncating it', async () => {
    // `subarray` shortens without complaining, so a `Root` the chain returned in some other shape
    // was handed to `validate_with_commitment` as though it were whole: the one input that
    // decides who is a person, silently truncated. This is a chain or configuration fault, not a
    // caller mistake, so it surfaces as one rather than as a 401.
    const reader: ChainReader = { getStorage: async () => '0x' + '11'.repeat(767) };

    await expect(commitmentsFrom(reader).commitment('0x' + '44'.repeat(32), 9)).rejects.toThrow(
      /is 767 bytes; the commitment needs 768/,
    );
  });

  it('accepts a Root of exactly the commitment length', async () => {
    const commitment = '11'.repeat(768);
    const reader: ChainReader = { getStorage: async () => '0x' + commitment };

    expect(await commitmentsFrom(reader).commitment('0x' + '44'.repeat(32), 9)).toBe('0x' + commitment);
  });
});

describe('verifyRingMembership', () => {
  const claim = { identifier: '0x' + '44'.repeat(32), ring: 0 };
  const commitment = '0x' + '11'.repeat(768);
  const proof = hexToU8a('0x0102');
  const context = new TextEncoder().encode('app.dot');
  const message = new Uint8Array(56);
  const validate = (ringExponent: number, p: Uint8Array, c: Uint8Array, ctx: Uint8Array, msg: Uint8Array) => {
    // Assert the binding is coherent: this is the shape `verifiablejs` requires.
    expect(ringExponent).toBe(9);
    expect(p).toBe(proof);
    expect(c).toEqual(hexToU8a(commitment));
    expect(ctx).toBe(context);
    expect(msg).toBe(message);
    return hexToU8a('0x' + 'ff'.repeat(32));
  };

  it('recovers the alias hex when the proof opens against the commitment', async () => {
    const commitments = { commitment: async () => commitment };
    const person = await verifyRingMembership(validate, commitments, 9, claim, proof, context, message);
    expect(person.alias).toBe('0x' + 'ff'.repeat(32));
  });

  it('refuses an unknown ring before calling the verifier', async () => {
    const commitments = { commitment: async () => null };
    await expect(
      verifyRingMembership(validate, commitments, 9, claim, proof, context, message),
    ).rejects.toMatchObject({ reason: ProofRefusal.UnknownRing });
  });

  it('refuses a proof that throws', async () => {
    const commitments = { commitment: async () => commitment };
    const throwing = () => {
      throw new Error('verify failed');
    };
    await expect(verifyRingMembership(throwing, commitments, 9, claim, proof, context, message)).rejects.toThrow(
      ProofRejected,
    );
  });
});
describe('chainReader', () => {
  /** A fake node `WebSocket` that records what the reader sends and lets the test push events. */
  type FakeSocket = {
    sent: string[];
    closed: boolean;
    addEventListener(type: string, fn: (e: unknown) => void): void;
    send(data: string): void;
    close(): void;
    emit(type: string, event: unknown): void;
  };
  const fakeSocket = (): FakeSocket => {
    const listeners = new Map<string, Array<(event: unknown) => void>>();
    const socket: FakeSocket = {
      sent: [],
      closed: false,
      addEventListener(type: string, fn: (e: unknown) => void): void {
        const list = listeners.get(type) ?? [];
        list.push(fn);
        listeners.set(type, list);
      },
      send(data: string): void {
        socket.sent.push(data);
      },
      close(): void {
        socket.closed = true;
      },
      emit(type: string, event: unknown): void {
        for (const fn of listeners.get(type) ?? []) {
          fn(event);
        }
      },
    };
    return socket;
  };

  const withSocket = <T>(socket: FakeSocket, f: () => T): T => {
    const original = globalThis.WebSocket;
    // The reader constructs `new WebSocket(url)` when getStorage runs, not when it is built, so
    // the stub must cover the whole call, not just reader construction. The cast is the point:
    // the fake carries the WebSocket's duck type plus test hooks; the reader only touches those.
    const stub = (function (this: unknown) {
      return socket;
    }) as unknown as { new (url: string): WebSocket };
    Object.defineProperty(globalThis, 'WebSocket', { value: stub, configurable: true });
    try {
      return f();
    } finally {
      Object.defineProperty(globalThis, 'WebSocket', { value: original, configurable: true });
    }
  };

  /** Build a reader and run `run(reader, socket)` with the fake socket in force the whole time. */
  const withReader = <T>(socket: FakeSocket, run: (reader: ChainReader) => T): T =>
    withSocket(socket, () => {
      return run(chainReader('ws://people'));
    });

  it('round-trips a present storage value', async () => {
    const socket = fakeSocket();
    const p = withReader(socket, (reader) => reader.getStorage('0xabcd'));
    // The request is only sent once the socket opens.
    socket.emit('open', {});
    await vi.waitFor(() => {
  expect(socket.sent.length).toBe(1);
});
    const request = JSON.parse(socket.sent[0] as string);
    expect(request.method).toBe('state_getStorage');
    expect(request.params).toEqual(['0xabcd']);
    socket.emit('message', { data: JSON.stringify({ jsonrpc: '2.0', id: request.id, result: '0xbeef' }) });

    await expect(p).resolves.toBe('0xbeef');
    expect(socket.closed).toBe(true);
  });

  it('resolves undefined for a None query (null result)', async () => {
    const socket = fakeSocket();
    const p = withReader(socket, (reader) => reader.getStorage('0xabcd'));
    socket.emit('open', {});
    await vi.waitFor(() => {
  expect(socket.sent.length).toBe(1);
});
    const request = JSON.parse(socket.sent[0] as string);
    socket.emit('message', { data: JSON.stringify({ jsonrpc: '2.0', id: request.id, result: null }) });

    await expect(p).resolves.toBeUndefined();
  });

  it('rejects when the RPC answers with an error', async () => {
    const socket = fakeSocket();
    const p = withReader(socket, (reader) => reader.getStorage('0xabcd'));
    socket.emit('open', {});
    await vi.waitFor(() => {
  expect(socket.sent.length).toBe(1);
});
    const request = JSON.parse(socket.sent[0] as string);
    socket.emit('message', { data: JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { message: 'boom' } }) });

    await expect(p).rejects.toThrow(/boom/);
  });

  it('rejects when the connection fails', async () => {
    const socket = fakeSocket();
    const p = withReader(socket, (reader) => reader.getStorage('0xabcd'));
    socket.emit('error', {});

    await expect(p).rejects.toThrow(/connection failed/i);
  });

  it('ignores a well-formed frame that answers a different request id', async () => {
    // The correlation guard. The neighbouring test emits `'not json'`, which the `JSON.parse`
    // guard discards on its own, so dropping `|| data.id !== id` survived the suite, and any
    // unsolicited frame arriving on the socket would settle the read that supplies the ring
    // commitment: the one input that decides who is a person.
    const socket = fakeSocket();
    // An explicit short timeout, like the neighbouring non-JSON case: the assertion is that the
    // read never settles from this frame, and "never" is observed as the reader timing out.
    const p = withSocket(socket, () => chainReader('ws://people', 50).getStorage('0xabcd'));
    socket.emit('open', {});
    await vi.waitFor(() => {
      expect(socket.sent.length).toBe(1);
    });
    const request = JSON.parse(socket.sent[0] as string) as { id: number };
    // Valid JSON-RPC, plausible payload, wrong id.
    socket.emit('message', {
      data: JSON.stringify({ jsonrpc: '2.0', id: request.id + 1, result: '0xdeadbeef' }),
    });

    await expect(p).rejects.toThrow(/timed out/);
  });

  it('rejects when the message is not JSON-RPC', async () => {
    const socket = fakeSocket();
    const p = withSocket(socket, () => chainReader('ws://people', 50).getStorage('0xabcd'));
    socket.emit('open', {});
    await vi.waitFor(() => {
      expect(socket.sent.length).toBe(1);
    });
    // A non-JSON payload is indistinguishable from noise: the reader keeps waiting and finally
    // times out rather than parsing garbage into a response.
    socket.emit('message', { data: 'not json' });

    await expect(p).rejects.toThrow(/timed out/);
  });

  it('rejects an RPC error that carries no message text', async () => {
    const socket = fakeSocket();
    const p = withReader(socket, (reader) => reader.getStorage('0xabcd'));
    socket.emit('open', {});
    await vi.waitFor(() => {
      expect(socket.sent.length).toBe(1);
    });
    const request = JSON.parse(socket.sent[0] as string);
    socket.emit('message', { data: JSON.stringify({ jsonrpc: '2.0', id: request.id, error: {} }) });

    await expect(p).rejects.toThrow(/RPC error/);
  });

  it('ignores a late transport event once the request has settled', async () => {
    const socket = fakeSocket();
    const p = withReader(socket, (reader) => reader.getStorage('0xabcd'));
    socket.emit('open', {});
    await vi.waitFor(() => {
      expect(socket.sent.length).toBe(1);
    });
    const request = JSON.parse(socket.sent[0] as string);
    socket.emit('message', { data: JSON.stringify({ jsonrpc: '2.0', id: request.id, result: '0xbeef' }) });
    await expect(p).resolves.toBe('0xbeef');

    // The reader has already settled and closed; a late event must not re-settle it.
    socket.emit('error', {});
  });

});

describe('chainReader endpoint failures', () => {
  it('rejects when the socket cannot be constructed, instead of crashing a timer later', async () => {
    // `new WebSocket` throws synchronously on a scheme it does not serve, and an `https://` URL
    // passes `z.url()`. With the timeout armed first, that throw left the promise unsettled and
    // the timer callback reached a `socket` still in its temporal dead zone. A ReferenceError
    // inside a timer is an uncaught exception, not a failed request.
    const original = globalThis.WebSocket;
    // @ts-expect-error: replacing the global for the duration of this test
    globalThis.WebSocket = function ThrowingSocket(): never {
      throw new Error('unsupported scheme');
    };
    try {
      await expect(chainReader('https://people:9944', 50).getStorage('0xkey')).rejects.toThrow(
        /could not be opened/,
      );
      // Nothing is left armed: an unhandled timer would surface after this test, not in it.
      await new Promise((resolve) => setTimeout(resolve, 120));
    } finally {
      globalThis.WebSocket = original;
    }
  });
});

describe('challenge clock handling', () => {
  it('refuses a challenge issued in the future beyond ordinary drift', () => {
    // Checking only `age > ttl` let a future issued-at stay valid for as long as it was ahead by,
    // so a clock that stepped backwards on the minting instance permanently extended every
    // challenge already handed out.
    const key = new Uint8Array(32).fill(3);
    const token = mintChallenge(key, { issuedAtMillis: 2_000_000 });

    expect(() => {
      verifyChallenge(key, token, { now: 1_000_000, ttlMillis: 60_000 });
    }).toThrow(InvalidChallenge);
  });

  it('tolerates a small forward skew, which is drift rather than a step', () => {
    const key = new Uint8Array(32).fill(3);
    const token = mintChallenge(key, { issuedAtMillis: 1_001_000 });

    expect(() => {
      verifyChallenge(key, token, { now: 1_000_000, ttlMillis: 60_000 });
    }).not.toThrow();
  });
});

describe('redeemRequest', () => {
  const body = {
    challenge: 'a'.repeat(56),
    proof: 'b'.repeat(64),
    ring: 0,
    productId: 'app.dot',
  };

  it('refuses a body carrying its own collection identifier', () => {
    // `.strict()` is the whole of "the client never names the collection". The service pins the
    // identifier from config and takes only the ring index from the caller, so a body that
    // smuggles an `identifier` must be refused at the schema; nothing downstream re-checks it.
    expect(redeemRequest.safeParse({ ...body, identifier: `0x${'ab'.repeat(32)}` }).success).toBe(false);
    expect(redeemRequest.safeParse(body).success).toBe(true);
  });

  it('refuses a ring index that would wrap the u32 storage key', () => {
    // `membersRootKey` writes the ring as a little-endian u32, so `232 + 3` silently reads
    // ring 3's commitment while the caller declared a different ring.
    expect(redeemRequest.safeParse({ ...body, ring: 2 ** 32 }).success).toBe(false);
    expect(redeemRequest.safeParse({ ...body, ring: 0xffff_ffff }).success).toBe(true);
    expect(redeemRequest.safeParse({ ...body, ring: -1 }).success).toBe(false);
  });

  it('bounds the proof and the challenge', () => {
    // Attacker-supplied bytes reach a wasm deserialiser and an HMAC, and the point of a stated
    // bound is that it is stated, not left to whatever `bodyLimit` happens to be.
    expect(redeemRequest.safeParse({ ...body, proof: 'b'.repeat(8193) }).success).toBe(false);
    expect(redeemRequest.safeParse({ ...body, challenge: 'a'.repeat(129) }).success).toBe(false);
  });
});

describe('token', () => {
  it('mints a JWT that verifies back to the same claims it was minted with', async () => {
    const token = await mintToken({ secret: KEY }, '0xalias', 'app.dot', 300);
    const claims = await verifyToken({ secret: KEY }, token, ['app.dot']);
    expect(claims.sub).toBe('0xalias');
    expect(claims.aud).toBe('app.dot');
  });

  it('mints an expiry exactly the configured TTL after issue', async () => {
    // The bearer credential for every spending route, and `token_ttl_s` is the only thing bounding
    // a stolen one. Nothing decoded `exp`, so scaling the TTL by a thousand kept the positive test
    // valid and the negative test expired: a five-minute token silently becoming a three-day one.
    const token = await mintToken({ secret: KEY }, '0xalias', 'app.dot', 300);

    const segment = token.split('.')[1];
    if (segment === undefined) throw new Error('token has no payload segment');
    const claims = JSON.parse(Buffer.from(segment, 'base64url').toString()) as { iat: number; exp: number };

    expect(claims.exp - claims.iat).toBe(300);
  });

  it('refuses a token whose TTL has run out', async () => {
    // What the discarded `exp`/`iat` claims were standing in for. Nothing read them; the
    // property they hinted at is that expiry is enforced, which is jose's job and is worth
    // asserting directly rather than via a number nobody consumes.
    const token = await mintToken({ secret: KEY }, '0xalias', 'app.dot', -1);

    await expect(verifyToken({ secret: KEY }, token, ['app.dot'])).rejects.toThrow();
  });

  it.each<[string, { sub?: string; aud: string | string[] }]>([
    ['no subject', { aud: 'app.dot' }],
    ['an array audience', { sub: '0xalias', aud: ['evil.dot', 'app.dot'] }],
  ])('refuses a token with %s rather than defaulting the claim', async (_label, claims) => {
    // Both defaults guarded the single key everything else is scoped by. An absent `sub` gave the
    // alias `''`, one rate-limit bucket and one funding scope shared by every aliasless caller.
    // And jose's audience check passes when any element matches, so taking `aud[0]` could scope
    // data under a product that was never on the allowlist.
    const jwk = await importJWK({ kty: 'oct', k: Buffer.from(KEY).toString('base64url') }, 'HS256');
    let builder = new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('300s')
      .setAudience(claims.aud);
    if (claims.sub !== undefined) builder = builder.setSubject(claims.sub);
    const token = await builder.sign(jwk);

    await expect(verifyToken({ secret: KEY }, token, ['app.dot'])).rejects.toThrow();
  });

  it('refuses a token whose subject is present but empty', async () => {
    // The alias is the single key everything else is scoped by. An empty `sub` would give every
    // aliasless caller one rate-limit bucket and one funding scope, so the guard checks for an
    // empty string, not merely for a string.
    const jwk = await importJWK({ kty: 'oct', k: Buffer.from(KEY).toString('base64url') }, 'HS256');
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('')
      .setIssuedAt()
      .setExpirationTime('300s')
      .setAudience('app.dot')
      .sign(jwk);

    await expect(verifyToken({ secret: KEY }, token, ['app.dot'])).rejects.toThrow();
  });

  it('refuses a token signed under an algorithm it did not mint with', async () => {
    // Pinning the algorithm is the standard JWT downgrade guard. Symmetric keys make it
    // unexploitable here (every accepted algorithm needs the same secret), so it is one
    // asymmetric-key change away from mattering, and untested it would not survive that change.
    const jwk = await importJWK({ kty: 'oct', k: Buffer.from(KEY).toString('base64url') }, 'HS512');
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS512' })
      .setSubject('0xalias')
      .setIssuedAt()
      .setExpirationTime('300s')
      .setAudience('app.dot')
      .sign(jwk);

    await expect(verifyToken({ secret: KEY }, token, ['app.dot'])).rejects.toThrow();
  });

  it('refuses a token signed with a different key', async () => {
    const token = await mintToken({ secret: KEY }, '0xalias', 'app.dot', 300);
    await expect(verifyToken({ secret: new Uint8Array(32).fill(9) }, token, ['app.dot'])).rejects.toThrow();
  });

  it('caches the imported key per TokenKey without leaking one key into another', async () => {
    // The import is memoised in a WeakMap keyed on the `TokenKey` object, so a rotated key gets
    // its own entry. If the cache were keyed on anything coarser (or shared), a rotation would
    // keep verifying against the retired key, which is the one failure mode a signing-key cache
    // can have.
    const rotated = { secret: new Uint8Array(32).fill(7) };
    const previous = { secret: KEY };

    const underRotated = await mintToken(rotated, '0xalias', 'app.dot', 300);
    const underPrevious = await mintToken(previous, '0xalias', 'app.dot', 300);

    // Each verifies under its own key, repeatedly; the second call is the cached path.
    await expect(verifyToken(rotated, underRotated, ['app.dot'])).resolves.toMatchObject({ sub: '0xalias' });
    await expect(verifyToken(rotated, underRotated, ['app.dot'])).resolves.toMatchObject({ sub: '0xalias' });
    await expect(verifyToken(previous, underPrevious, ['app.dot'])).resolves.toMatchObject({ sub: '0xalias' });

    // And never under the other's.
    await expect(verifyToken(previous, underRotated, ['app.dot'])).rejects.toThrow();
    await expect(verifyToken(rotated, underPrevious, ['app.dot'])).rejects.toThrow();
  });

  it('shares one import across two TokenKey objects holding the same bytes', async () => {
    // Distinct objects are distinct cache entries. Both must still work: the memoisation is an
    // optimisation, never a constraint on how callers hold their key.
    const a = { secret: new Uint8Array(32).fill(3) };
    const b = { secret: new Uint8Array(32).fill(3) };

    const token = await mintToken(a, '0xalias', 'app.dot', 300);
    await expect(verifyToken(b, token, ['app.dot'])).resolves.toMatchObject({ sub: '0xalias' });
  });

  it('refuses a token whose audience is not allowlisted', async () => {
    const token = await mintToken({ secret: KEY }, '0xalias', 'app.dot', 300);
    await expect(verifyToken({ secret: KEY }, token, ['other.dot'])).rejects.toThrow();
  });

  it('refuses a token that has already expired: the single most common bearer failure', async () => {
    // A negative TTL minted an `exp` in the past via `setExpirationTime`, so no clock is needed
    // to make time pass; verifying it is what the "short-lived JWT" claim rests on.
    const token = await mintToken({ secret: KEY }, '0xalias', 'app.dot', -10);
    await expect(verifyToken({ secret: KEY }, token, ['app.dot'])).rejects.toThrow(/exp/i);
  });
});

/**
 * A compatibility probe of the real `verifiablejs` wasm binding.
 *
 * Every other test drives a hand-written stub (`validate`) that merely asserts "this is the shape
 * verifiablejs requires", a self-fulfilling agreement that never asked the library. This probe
 * anchors the gate to the actual artifact: it pins that the binding exists, takes five arguments
 * (the arity `verifyRingMembership` relies on), and rejects a malformed proof with no error
 * swallowed silently. It cannot produce a real member proof (out of scope: proofs come from the
 * product SDK), but it catches a boot-breaking rename or arity drift and confirms the gate is not
 * a stub-to-stub agreement.
 */
describe('verifiablejs binding (compatibility probe)', () => {
  it('exposes validate_with_commitment with the arity the gate assumes', async () => {
    const v = await import('verifiablejs/nodejs').then((m) => m.default);
    expect(typeof v.validate_with_commitment).toBe('function');
    // Explicit, not from the stub's own private certainty: five args (exponent, proof,
    // commitment, context, message).
    expect(v.validate_with_commitment.length).toBe(5);
  });

  it('does not silently accept garbage as a proof', async () => {
    const v = await import('verifiablejs/nodejs').then((m) => m.default);
    // Malformed proof against a zeroed commitment: a honest verifier throws or returns empty;
    // it must not return a 32-byte alias that a caller could take as "proof accepted".
    let outcome: unknown;
    let threw = false;
    try {
      outcome = v.validate_with_commitment(
        9,
        new Uint8Array(2),
        new Uint8Array(768),
        new TextEncoder().encode('app.dot'),
        new Uint8Array(56),
      );
    } catch {
      threw = true;
    }
    // Either it rejected (threw), or it returned nothing usable as an alias.
    if (!threw) expect(outcome).toBeUndefined();
  });
});
