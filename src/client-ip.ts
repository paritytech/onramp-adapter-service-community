/**
 * The caller's address as a rail may be told it, or nothing.
 *
 * Meld passes `sessionData.clientIpAddress` to the provider, and some providers refuse a session
 * without it (Transak answers `CLIENT_IP_ADDRESS_REQUIRED` on every buy and sell). It is the end
 * user's public address the provider wants for its geo and fraud checks, so only a publicly
 * routable one is passed on. A private, loopback, link-local or shared-NAT address is this
 * service's own network talking (an ingress hop when `server.trusted_proxy_cidrs` is unset, or a
 * developer's machine) and would hand the provider every buyer under one meaningless address.
 *
 * `request.ip` is already the forwarded client when the proxy hop is trusted; see `trustProxy` in
 * `server.ts`.
 */

import { BlockList, isIP } from 'node:net';

const NOT_PUBLIC = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
] as const) {
  NOT_PUBLIC.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
] as const) {
  NOT_PUBLIC.addSubnet(network, prefix, 'ipv6');
}

/** IPv4 written as IPv6 (`::ffff:203.0.113.7`), as a dual-stack socket reports it. */
const MAPPED_V4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;

export function publicClientIp(ip: string | undefined): string | undefined {
  if (ip === undefined) return undefined;
  const address = MAPPED_V4.exec(ip)?.[1] ?? ip;
  const family = isIP(address);
  if (family === 0) return undefined;
  return NOT_PUBLIC.check(address, family === 4 ? 'ipv4' : 'ipv6') ? undefined : address;
}
