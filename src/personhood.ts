/**
 * The personhood handshake that gates every Meld-spending call.
 *
 * Two routes, one asymmetric protocol. `challenge` is public and rate-limited; nothing of value
 * is minted, just a fresh 56-byte token. `redeem` is where a proof becomes a short-lived JWT. It
 * verifies the challenge was authentic and unexpired, proves the caller is currently in the
 * People ring (the on-chain commitment check), then mints a JWT binding that person (`sub`) to
 * this product (`aud`).
 *
 * The protected routes only verify the JWT: cheap, stateless, no chain touch per spend. The
 * `sub` alias is the audit key and the rate-limit key (see src/caller.ts for how
 * authentication was moved ahead of the limiter to make that possible). The asymmetry is
 * the whole design: the expensive, chain-backed proof runs once per handshake; the hot path is a
 * single HMAC check.
 */

import { unauthorized, upstreamUnavailable } from './contract.js';
import { mintChallenge, verifyChallenge } from './personhood/challenge.js';
import {
  ProofRefusal,
  ProofRejected,
  verifyRingMembership,
  type ChainCommitments,
  type Person,
  type Validate,
} from './personhood/register.js';
import { mintToken, verifyToken, type TokenKey } from './personhood/token.js';

/**
 * One People network: its own commitment reader and its own collections.
 *
 * Per network rather than shared so a chain that stops answering cannot consume the socket budget
 * the others' redeems need.
 */
export interface PersonhoodNetwork {
  /** The name a caller declares at redeem, and the `net` claim the minted token carries. */
  id: string;
  commitments: ChainCommitments;
  /**
   * The People collections this network accepts, each with its own ring exponent, tried in
   * order. Plural because personhood is not one population: full and lite persons live in
   * different collections and a proof opens against exactly one.
   */
  rings: ReadonlyArray<{ identifier: string; exponent: number }>;
}

/** Everything the personhood service needs, injected in `startup.ts` from config. */
export interface PersonhoodDeps {
  /** The on-chain proof verifier bound to `validate_with_commitment`. */
  validate: Validate;
  challengeKey: Uint8Array;
  tokenKey: TokenKey;
  challengeTtlMs: number;
  tokenTtlSeconds: number;
  /**
   * The People networks this deployment accepts. The caller names one per redeem; the proof is
   * verified against that network's chain and no other. Never empty, ids distinct (config schema).
   */
  networks: readonly PersonhoodNetwork[];
  /** Product ids the caller may redeem into. Curation at the money boundary. */
  allowedProducts: readonly string[];
}

interface IssuedChallenge {
  challenge: string; // base64url of the 56-byte token
}

interface RedeemInput {
  challenge: string; // base64url, from a prior /challenge
  proof: string; // base64url of the ring-VRF proof
  ring: number; // ring index within the collection
  /** The product the caller wants to spend as; must be allowed. Bound as the proof context + JWT aud. */
  productId: string;
  /** Which configured People network verifies this proof. Matched exactly against `deps.networks`. */
  network: string;
}

interface Redeemed {
  token: string;
  expiresAtMs: number;
}

const toWire = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');
const fromWire = (s: string) => new Uint8Array(Buffer.from(s, 'base64url'));
const utf8 = (s: string) => new TextEncoder().encode(s);

export class PersonhoodService {
  constructor(private readonly deps: PersonhoodDeps) {}

  /**
   * The configured networks, for the boot probe in `startup.ts`. Exposed rather than re-derived
   * from config so the probe reads the very objects `redeem` will use.
   */
  get networks(): readonly PersonhoodNetwork[] {
    return this.deps.networks;
  }

  challenge(): IssuedChallenge {
    return { challenge: toWire(mintChallenge(this.deps.challengeKey)) };
  }

  /**
   * Turn a proof and the challenge it answers into a short-lived bearer JWT.
   *
   * Order is the point: the challenge must be authentic and unexpired before the chain
   * membership check, so a captured proof cannot be replayed to open a new token. The chain check
   * then proves current membership; the alias recovered is the token `sub`.
   */
  async redeem(input: RedeemInput): Promise<Redeemed> {
    const challenge = fromWire(input.challenge);
    try {
      verifyChallenge(this.deps.challengeKey, challenge, { now: Date.now(), ttlMillis: this.deps.challengeTtlMs });
    } catch (cause) {
      throw unauthorized(`challenge rejected: ${cause instanceof Error ? cause.message : 'malformed'}`);
    }

    // Curation at the money boundary. The product is a per-request input, not a deployment
    // constant; an operator may serve several products behind one collection (and one proof).
    if (!this.deps.allowedProducts.includes(input.productId)) {
      throw unauthorized(`product '${input.productId}' is not authorized on this instance.`);
    }

    // Refused before a socket is opened: the declared name selects among the operator's networks,
    // it never supplies one.
    const network = this.deps.networks.find((candidate) => candidate.id === input.network);
    if (network === undefined) {
      throw unauthorized(`network '${input.network}' is not served by this instance.`);
    }

    // The proof was minted over `context` = the product, `message` = the challenge bytes. Binding
    // both makes the proof coherent with this handshake and this deployment.
    const context = utf8(input.productId);
    const message = challenge;

    // Each collection until one opens the proof. Order costs work, not outcome: a proof opens
    // against exactly one collection, so the same person is recovered whatever the order. Cost is
    // bounded by `MAX_IN_FLIGHT_REDEEMS`, which scales with this list.
    let person: Person | undefined;
    let rejection: ProofRejected | undefined;
    let unavailableDetail: string | undefined;

    for (const ring of network.rings) {
      try {
        person = await verifyRingMembership(
          this.deps.validate,
          network.commitments,
          ring.exponent,
          { identifier: ring.identifier, ring: input.ring },
          fromWire(input.proof),
          context,
          message,
        );
        break;
      } catch (cause) {
        // A proof that does not open against this collection says nothing about the next.
        if (cause instanceof ProofRejected) {
          rejection ??= cause;
        } else {
          unavailableDetail ??= cause instanceof Error ? cause.message : String(cause);
        }
      }
    }

    if (person === undefined) {
      // A chain that would not answer outranks a proof that did not open. Reporting 401 when one
      // read failed would tell a legitimate person they are not a person, and send the operator to
      // inspect the caller instead of the People chain.
      if (unavailableDetail !== undefined) {
        throw upstreamUnavailable(`People chain read failed: ${unavailableDetail}`);
      }
      // The reason reaches the operator detail, never the wire; the caller still gets the one
      // stable 401. It is the difference between a misconfigured collection (no ring has a current
      // root) and a caller presenting a proof that does not open, which is the first thing worth
      // knowing when the gate starts refusing everyone.
      const reason = rejection === undefined ? 'no collections configured' : ProofRefusal[rejection.reason];
      throw unauthorized(
        `membership proof rejected by all ${String(network.rings.length)} collection(s) configured ` +
          `for network '${network.id}': ${reason}`,
      );
    }

    const token = await mintToken(
      this.deps.tokenKey,
      person.alias,
      input.productId,
      network.id,
      this.deps.tokenTtlSeconds,
    );
    return { token, expiresAtMs: Date.now() + this.deps.tokenTtlSeconds * 1000 };
  }

  /**
   * Verify a protected route's bearer token. The recovered `sub` alias is the audit key (a
   * per-person handle the caller cannot vary), and the `aud` is the product the token was minted
   * for.
   *
   * The audience is re-vetted against the current `allowedProducts` at every check: the token's
   * own `aud` is trusted only as far as it is still on the allowlist, so dropping a product from
   * config revokes that product's tokens within one TTL.
   */
  async verify(bearerToken: string): Promise<{ subject: string; productId: string; network: string }> {
    let claims: { sub: string; aud: string; net: string };
    try {
      claims = await verifyToken(this.deps.tokenKey, bearerToken, this.deps.allowedProducts);
    } catch {
      // Any failure here (bad signature, expired, audience revoked) is "not a valid token", and
      // a caller mistake, not an internal error. jose's own error types must not reach the wire.
      throw unauthorized('token rejected.');
    }
    // `net` is reported as minted, not re-vetted like `aud`. A product is an authorisation and is
    // revocable; a network is a fact about a proof already verified, and rewriting it would falsify
    // the audit trail.
    return { subject: claims.sub, productId: claims.aud, network: claims.net };
  }
}