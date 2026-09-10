import type { FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';

import type { Subject } from '../src/auth.js';
import { callerGate } from '../src/caller.js';
import { Refusal } from '../src/contract.js';

/** Only the two fields the gate reads. Each call makes a fresh object, so the WeakMap is per request. */
const request = (ip = '203.0.113.7') => ({ ip, headers: {} }) as unknown as FastifyRequest;

const PERSON: Subject = { productId: 'app.dot', alias: '0xperson', proven: true };
const DEV: Subject = { productId: 'app.dot', alias: 'dev:app.dot', proven: false };

const refusal = () =>
  new Refusal(401, { tag: 'Other', value: { code: 'UNAUTHORIZED', message: 'Not authorized.' } }, 'no');

describe('the caller gate', () => {
  describe('identify', () => {
    it('records the subject without touching the response', async () => {
      const gate = callerGate(async () => PERSON);
      const r = request();

      await expect(gate.identify(r)).resolves.toBeUndefined();
      expect(gate.subjectOf(r)).toEqual(PERSON);
    });

    it('records a refusal instead of throwing it, so the limiter still runs', async () => {
      // The whole reason authentication does not throw in `onRequest`: a throw there skips the
      // rate limiter, and failed-authentication attempts become free and unbounded.
      const gate = callerGate(async () => {
        throw refusal();
      });
      const r = request();

      await expect(gate.identify(r)).resolves.toBeUndefined();
      await expect(gate.enforce(r)).rejects.toThrow(Refusal);
    });

    it('lets an unexpected failure travel now rather than flattening it into a 401', async () => {
      // A verifier that blew up has said nothing about the caller. Recording it as a refusal
      // would tell a caller with perfectly good credentials to go and fix them.
      const gate = callerGate(async () => {
        throw new Error('ring cache exploded');
      });

      await expect(gate.identify(request())).rejects.toThrow('ring cache exploded');
    });
  });

  describe('enforce', () => {
    it('passes an authenticated caller through', async () => {
      const gate = callerGate(async () => PERSON);
      const r = request();
      await gate.identify(r);

      await expect(gate.enforce(r)).resolves.toBeUndefined();
    });

    it('raises the exact refusal authentication recorded, detail and all', async () => {
      const original = refusal();
      const gate = callerGate(async () => {
        throw original;
      });
      const r = request();
      await gate.identify(r);

      await expect(gate.enforce(r)).rejects.toBe(original);
    });
  });

  describe('subjectOf', () => {
    it('fails closed on a route wired without identify', () => {
      // Unreachable through `buildServer`, which pairs the hooks on every authenticated route.
      // It is asserted because the direction of the failure is the point: a wiring slip on a
      // route that spends money must refuse, not hand back an absent subject.
      const gate = callerGate(async () => PERSON);
      const error = (() => {
        try {
          gate.subjectOf(request());
        } catch (e: unknown) {
          return e;
        }
        return undefined;
      })();

      expect(error).toBeInstanceOf(Refusal);
      expect((error as Refusal).status).toBe(401);
      // The same 401 vocabulary every other refusal uses: a caller must not be able to tell a
      // wiring bug from a bad token. The detail is operator-facing and never reaches the wire.
      expect((error as Refusal).failure).toEqual({
        tag: 'Other',
        value: { code: 'UNAUTHORIZED', message: 'Not authorized.' },
      });
      expect((error as Error).message).toBe('Authentication did not run for this route.');
    });
  });

  describe('key', () => {
    it('gives a proven person a bucket of their own', async () => {
      const gate = callerGate(async () => PERSON);
      const r = request();
      await gate.identify(r);

      expect(gate.key(r)).toBe('person:0xperson');
    });

    it('refuses to key on the dev alias, which every caller of the product shares', async () => {
      // Keying on `dev:app.dot` would collapse every developer into one bucket: the first
      // one to spend their allowance would throttle all the others.
      const gate = callerGate(async () => DEV);
      const r = request();
      await gate.identify(r);

      expect(gate.key(r)).toBe('ip:203.0.113.7');
    });

    it('keys a failed authentication on the address, so the attempts are bounded', async () => {
      const gate = callerGate(async () => {
        throw refusal();
      });
      const r = request();
      await gate.identify(r);

      expect(gate.key(r)).toBe('ip:203.0.113.7');
    });

    it('keys an unauthenticated route on the address', () => {
      // `/health`, `/api/v1/auth/challenge` and `/api/v1/auth/redeem` never run `identify`.
      const gate = callerGate(async () => PERSON);

      expect(gate.key(request('198.51.100.4'))).toBe('ip:198.51.100.4');
    });

    it.each([
      // One routed /64 (an ordinary home or VPS allocation) must be one bucket, not 2^64.
      ['2001:db8:abcd:1234::1', 'ip:2001:db8:abcd:1234::/64'],
      ['2001:db8:abcd:1234::9999', 'ip:2001:db8:abcd:1234::/64'],
      ['2001:db8:abcd:1234:5678:9abc:def0:1', 'ip:2001:db8:abcd:1234::/64'],
      // The abbreviated form is the one that matters, and the one a naive four-group slice gets
      // wrong: `::` elides zeros wherever it likes, so slicing the printed form takes a host
      // group as part of the prefix and every host lands in its own bucket. Expand, then cut.
      ['2001:db8::1', 'ip:2001:db8:0:0::/64'],
      ['2001:db8::2', 'ip:2001:db8:0:0::/64'],
      ['2001:db8:0:0:1:2:3:4', 'ip:2001:db8:0:0::/64'],
      // Canonicalised, so case and leading zeros cannot split one prefix into several buckets.
      ['2001:0DB8:0000:0000:1:2:3:4', 'ip:2001:db8:0:0::/64'],
      ['::1', 'ip:0:0:0:0::/64'],
      ['fe80::1', 'ip:fe80:0:0:0::/64'],
      // A different /64 is a different bucket.
      ['2001:db8:abcd:9999::1', 'ip:2001:db8:abcd:9999::/64'],
      // Only the mapped and compatible forms name a single IPv4 host, so only those two are
      // identified by the quad rather than by the wrapper.
      ['::ffff:203.0.113.7', 'ip:203.0.113.7'],
      ['::FFFF:203.0.113.7', 'ip:203.0.113.7'],
      ['::203.0.113.7', 'ip:203.0.113.7'],
      // The general embedded form is not one host: `2001:db8::1.2.3.4` is an ordinary address
      // in the `2001:db8::/64` prefix whose last two groups happen to be printed as a quad.
      // Testing merely for a dotted tail returned `1.2.3.4` (the host bits), which hands out
      // 2^32 virgin buckets inside one /64, the exact evasion this function exists to close.
      ['2001:db8::1.2.3.4', 'ip:2001:db8:0:0::/64'],
      ['2001:db8:abcd:1234::1.2.3.4', 'ip:2001:db8:abcd:1234::/64'],
    ])('buckets the IPv6 address %s by its /64', (ip, expected) => {
      // `@fastify/rate-limit` does this normalisation only inside its default key generator,
      // which supplying a custom one silently opts out of. Without it a single prefix yields unlimited
      // virgin buckets, and the address ceiling (the only thing in front of the handshake routes
      // and every failed authentication) bounds nothing at all.
      const gate = callerGate(async () => PERSON);

      expect(gate.key(request(ip))).toBe(expected);
    });

    it('puts two hosts in one abbreviated prefix in the same bucket', () => {
      // Stated separately from the table because it is the property, not an example of it.
      const gate = callerGate(async () => PERSON);

      expect(gate.key(request('2001:db8::1'))).toBe(gate.key(request('2001:db8::dead:beef')));
      expect(gate.key(request('2001:db8::1'))).not.toBe(gate.key(request('2001:db9::1')));
    });

    it('leaves an IPv4 address alone, where one address is already one bucket', () => {
      const gate = callerGate(async () => PERSON);

      expect(gate.key(request('203.0.113.7'))).toBe('ip:203.0.113.7');
    });

    it('puts every host of one embedded-quad prefix in a single bucket', async () => {
      // Stated as the property rather than as rows. The whole point of refusing to read
      // `2001:db8::1.2.3.4` as an IPv4 host is that its 2^32 printable neighbours share one
      // ceiling with every other host in that /64.
      const gate = callerGate(async () => PERSON);

      expect(gate.key(request('2001:db8::1.2.3.4'))).toBe(gate.key(request('2001:db8::5.6.7.8')));
      expect(gate.key(request('2001:db8::1.2.3.4'))).toBe(gate.key(request('2001:db8::1')));
      // And a genuinely different /64 is still a different bucket, so the collapse above is a
      // prefix truncation rather than everything falling into one pile.
      expect(gate.key(request('2001:db8::1.2.3.4'))).not.toBe(gate.key(request('2001:db9::1.2.3.4')));
    });

    it('keys a person and an address in separate namespaces that cannot collide', async () => {
      // The two key spaces are unrelated: an alias is chosen by the ring, an address by the
      // network, and neither may be spendable against the other's ceiling. Every key therefore
      // carries which space it came from, and the two prefixes must differ. Collapse them and
      // a caller at `203.0.113.7` and the person aliased `203.0.113.7` share one bucket.
      const gate = callerGate(async () => ({ ...PERSON, alias: '203.0.113.7' }));
      const proven = request('198.51.100.4');
      await gate.identify(proven);

      const personKey = gate.key(proven);
      const addressKey = gate.key(request('203.0.113.7'));

      expect(personKey).toBe('person:203.0.113.7');
      expect(addressKey).toBe('ip:203.0.113.7');
      expect(personKey).not.toBe(addressKey);
      // Namespaced by a prefix, not merely different by accident of content: strip the two
      // prefixes and these become the same string.
      expect(personKey.slice('person:'.length)).toBe(addressKey.slice('ip:'.length));
    });

    it('cannot be crafted into somebody else\'s bucket', async () => {
      // The `person:`/`ip:` prefixes are the reason. Without them an alias reading `203.0.113.7`
      // would share a bucket with the caller at that address.
      const gate = callerGate(async () => ({ ...PERSON, alias: '203.0.113.7' }));
      const r = request('203.0.113.7');
      await gate.identify(r);

      expect(gate.key(r)).toBe('person:203.0.113.7');
      expect(gate.key(r)).not.toBe(gate.key(request('203.0.113.7')));
    });
  });
});
