import { describe, expect, it } from 'vitest';

import { publicClientIp } from '../src/client-ip.js';

describe('publicClientIp', () => {
  it.each(['203.0.113.7', '8.8.8.8', '2001:db8::1', '2a00:1450:4009:81f::200e'])('passes on %s', (ip) => {
    expect(publicClientIp(ip)).toBe(ip);
  });

  it('unwraps an IPv4 address a dual-stack socket reports as IPv6', () => {
    expect(publicClientIp('::ffff:203.0.113.7')).toBe('203.0.113.7');
  });

  it.each([
    ['loopback', '127.0.0.1'],
    ['loopback, IPv6', '::1'],
    ['a private network', '10.12.0.4'],
    ['a private network', '172.20.1.1'],
    ['a private network', '192.168.1.10'],
    ['shared NAT', '100.64.3.2'],
    ['link-local', '169.254.10.1'],
    ['link-local, IPv6', 'fe80::1'],
    ['unique-local, IPv6', 'fd12:3456::1'],
    ['loopback, IPv4-mapped', '::ffff:127.0.0.1'],
    ['the unspecified address', '0.0.0.0'],
  ])('withholds %s (%s): it is this service talking, not the buyer', (_label, ip) => {
    // A provider would otherwise see every buyer behind an ingress hop as one address.
    expect(publicClientIp(ip)).toBeUndefined();
  });

  it.each([undefined, '', 'not-an-ip'])('withholds %s', (ip) => {
    expect(publicClientIp(ip)).toBeUndefined();
  });
});
