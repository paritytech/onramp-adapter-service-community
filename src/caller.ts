/**
 * The caller gate: authentication moved ahead of the rate limit, so the limiter can key on a
 * person rather than an address.
 *
 * `@fastify/rate-limit` decides a key in its own hook, so a `Subject` has to exist before that
 * hook runs. Authentication is therefore split, and all three phases matter: `identify` runs first in
 * `onRequest`; the limiter runs next, in that same phase, because the plugin appends its hook
 * and so reads what `identify` decided; `enforce` runs a phase later in `preHandler`; and the
 * route handler runs last. See the `hook: 'onRequest'` note in src/server.ts.
 *
 * The one non-obvious move is that `identify` records a refusal instead of throwing it. A
 * throw in `onRequest` would skip the limiter entirely, leaving failed-authentication attempts
 * completely unbounded, a worse hole than the one this closes. `enforce` raises the refusal a phase
 * later, after the attempt has been counted against the caller's address.
 */

import type { FastifyRequest } from 'fastify';

import type { CallerAuth, Subject } from './auth.js';
import { Refusal, unauthorized } from './contract.js';
import { bucketFor } from './limit-store.js';

/**
 * What authentication decided, for the rest of this request.
 *
 * A `WeakMap` rather than `decorateRequest` plus a `declare module 'fastify'` block: the
 * augmentation would put a possibly-absent `subject` on every request in the process, including
 * the ones that never authenticate. Here the readers are the three functions below and nothing
 * else, and the entry dies with the request object.
 */
type Decision = Subject | Refusal;

/** An IPv6 address is eight 16-bit groups; the first four are the /64 a host is allocated. */
const IPV6_GROUPS = 8;
const IPV6_PREFIX_GROUPS = 4;

/**
 * The address, grouped to something an attacker cannot trivially multiply.
 *
 * `@fastify/rate-limit` normalises IPv6 to a /64, but only inside its default key generator,
 * which supplying a custom one silently opts out of. A single routed /64, which is what an ordinary
 * VPS or home connection is handed, then yields 2^64 virgin buckets and the address ceiling
 * bounds nothing. That ceiling is the only thing in front of the two public handshake routes and
 * every failed authentication, so losing it loses the whole pre-auth budget.
 *
 * The address is expanded before it is truncated. Slicing the first four colon-separated
 * groups off the printed form is wrong, because `::` elides a run of zero groups wherever it
 * likes: `2001:db8::1` splits to four groups of which the last is the host, so every host in
 * that prefix would get its own bucket. That is the evasion this exists to close, still open
 * for the common case of hosts at low addresses.
 *
 * IPv4 is returned unchanged, and so is the IPv4-mapped form (`::ffff:203.0.113.7`), where one
 * address is already one bucket.
 */
function addressBucket(ip: string): string {
  if (!ip.includes(':')) return ip;
  // Only the mapped and compatible forms name a single IPv4 host. Testing merely for a dot also
  // fired on the general embedded form. `2001:db8::1.2.3.4` returned `1.2.3.4`, the host bits,
  // handing out 2^32 buckets inside one /64. That is the evasion this function exists to close.
  // Anything else with a dotted tail falls through to the /64 truncation below, which handles it.
  if (/^::(ffff:)?\d{1,3}(\.\d{1,3}){3}$/i.test(ip)) return ip.slice(ip.lastIndexOf(':') + 1);

  const [head = '', tail = ''] = ip.split('::');
  const headGroups = head === '' ? [] : head.split(':');
  const tailGroups = tail === '' ? [] : tail.split(':');
  const elided = IPV6_GROUPS - headGroups.length - tailGroups.length;
  const groups = ip.includes('::')
    ? [...headGroups, ...(Array.from({ length: Math.max(elided, 0) }, () => '0')), ...tailGroups]
    : headGroups;

  const prefix = groups
    .slice(0, IPV6_PREFIX_GROUPS)
    // Canonical: lower case, no leading zeros, so `2001:0DB8:...` and `2001:db8:...` are one bucket.
    .map((group) => (group.replace(/^0+/, '') || '0').toLowerCase());
  return `${prefix.join(':')}::/64`;
}

interface CallerGate {
  /** `onRequest`: decide who is calling and remember it. Never throws a refusal; `enforce` does. */
  identify: (request: FastifyRequest) => Promise<void>;
  /** `preHandler`, after the limiter: raise whatever refusal `identify` recorded. */
  enforce: (request: FastifyRequest) => Promise<void>;
  /** The rate-limit key: the proven person if there is one, the address otherwise. */
  key: (request: FastifyRequest) => string;
  /**
   * Whether a proven person is behind this request. That decides which bucket the limiter is
   * filling, and so which of the two allowances applies. Shares its predicate with `key`, so the
   * budget and the bucket can never disagree about who is being counted.
   */
  proven: (request: FastifyRequest) => boolean;
  /** The authenticated subject, for a handler that needs to name its caller. */
  subjectOf: (request: FastifyRequest) => Subject;
}

export function callerGate(authenticate: CallerAuth): CallerGate {
  const decided = new WeakMap<FastifyRequest, Decision>();

  const subjectOf = (request: FastifyRequest): Subject => {
    const decision = decided.get(request);
    if (decision instanceof Refusal) throw decision;
    // No decision means the route was wired without `identify`. Refusing is the truthful answer
    // (this caller is, in fact, not authenticated) and it fails closed, which is the only
    // acceptable direction for a wiring bug on a route that spends money. The detail names the
    // real cause for the operator; the caller still sees the one stable 401.
    if (decision === undefined) throw unauthorized('Authentication did not run for this route.');
    return decision;
  };

  /**
   * The proven person behind this request, if there is one.
   *
   * Absent for three distinct cases that all deserve the same answer: authentication has not run
   * (a public route), it ran and refused, or it succeeded on an `insecure_dev` alias that names a
   * product rather than a person.
   */
  const provenOf = (request: FastifyRequest): Subject | undefined => {
    const decision = decided.get(request);
    if (decision === undefined || decision instanceof Refusal || !decision.proven) return undefined;
    return decision;
  };

  return {
    identify: async (request) => {
      try {
        decided.set(request, await authenticate(request));
      } catch (error) {
        // Only a refusal is deferred. An unexpected failure is not an answer about the caller,
        // so it travels now and becomes the 500 it is, rather than being flattened into a 401
        // that would tell the caller to go and fix their credentials.
        if (!(error instanceof Refusal)) throw error;
        decided.set(request, error);
      }
    },

    enforce: async (request) => {
      subjectOf(request);
    },

    key: (request) => {
      // Only a proven person may own a bucket of their own. An `insecure_dev` alias is shared by
      // every caller of the product, and a caller who failed authentication has no identity at
      // all; keying on either would either collapse everyone into one bucket or hand out a fresh
      // one for free. Both fall back to the address.
      //
      // The prefixes keep the two namespaces apart, so an alias shaped like an address cannot be
      // crafted to land in somebody else's bucket.
      //
      // A proven person is deliberately not also bounded by their address: that is the point of
      // the change, and moving to a fresh address buys nothing once a person is proven.
      //
      // It is not unbounded, but the bound is narrower than it first looks (threat-model R13).
      // The alias is contextual and the context is the product id, so one human legitimately
      // recovers one alias (and one bucket) per allowed product. A second bucket therefore
      // costs either a proof of a second distinct person, which the personhood gate makes
      // unavailable, or a second proof by the same person against another allowed product,
      // which is free. Inert with one product; it multiplies with `allowed_products.length`.
      const person = provenOf(request);
      return person === undefined
        ? bucketFor('address', addressBucket(request.ip))
        : bucketFor('person', person.alias);
    },

    proven: (request) => provenOf(request) !== undefined,

    subjectOf,
  };
}
