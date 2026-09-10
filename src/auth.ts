/**
 * Who is calling.
 *
 * One invariant: a mode that cannot verify a caller must fail at boot, never per request, so
 * the absence of verification can never look like its presence. `personhood` is the production
 * mode. The bearer token is a short-lived JWT minted by the handshake after proving the caller is
 * currently in the People ring. See docs/threat-model.md R1 for why that is the shipped gate.
 */

import type { FastifyRequest } from 'fastify';

import type { PersonhoodService } from './personhood.js';
import { Refusal, unauthorized } from './contract.js';

/** The rate-limit and audit subject. Never a caller-supplied string in production. */
export interface Subject {
  /** dotNS product identifier, from the verified token audience. */
  readonly productId: string;
  /**
   * The person's contextual alias, recovered from the ring-VRF proof on chain. Stable per person,
   * unlinkable to any account or to the same person elsewhere. The only per-person key, because
   * it is the only one the caller cannot vary.
   */
  readonly alias: string;
  /**
   * Whether `alias` names exactly one proven person.
   *
   * True only under `personhood`, where the alias came out of a ring-VRF proof. Under
   * `insecure_dev` the alias is `dev:<productId>`, one value shared by every caller of the
   * product, so anything that means to be per-person (the rate-limit bucket, above all) must
   * refuse to key on it. Carried as a field rather than inferred from the string's shape,
   * because sniffing for a `dev:` prefix would make the security property depend on a naming
   * convention a future alias format could break silently.
   */
  readonly proven: boolean;
}

/** Verify a request and name its caller, or throw a `Refusal`. */
export type CallerAuth = (request: FastifyRequest) => Promise<Subject>;

/** Reads a bearer token from the `Authorization` header, or refuse. */
function bearerToken(request: FastifyRequest): string | Refusal {
  const auth = request.headers.authorization;
  if (typeof auth !== 'string') return unauthorized('Missing Authorization header.');
  const token = /^Bearer\s+(.+)$/i.exec(auth.trim())?.[1];
  if (token === undefined) return unauthorized('Malformed Authorization header.');
  return token;
}

/** Build the verifier, or refuse to start. Never falls back to an unverified mode. */
export function callerAuth(
  // `allowed_products` is required on `Config` (the schema has no `.optional()` and no default),
  // so declaring it optional here forced a `?? []` fallback for a state the schema makes
  // unreachable, and a fallback that silently allows nothing is the wrong shape to leave lying
  // beside an allowlist.
  cfg: { auth: { mode: 'personhood' | 'insecure_dev' }; allowed_products: readonly string[] },
  provider: { personhood: PersonhoodService | undefined },
): CallerAuth {
  if (cfg.auth.mode === 'personhood') {
    // Mode and provider are one decision: the mode that claims it can verify a caller must have
    // the thing that verifies. Fail at boot (this call), never per request.
    if (provider.personhood === undefined) {
      throw new Error('personhood mode requires a personhood provider.');
    }
    return personhood(provider.personhood);
  }
  return insecureDev(cfg.allowed_products);
}

/** The personhood verifier: trust only a JWT this service minted after proving membership on chain. */
function personhood(service: PersonhoodService): CallerAuth {
  return async (request) => {
    const token = bearerToken(request);
    if (token instanceof Refusal) throw token;
    const subject = await service.verify(token);
    return { productId: subject.productId, alias: subject.subject, proven: true };
  };
}

/** Development only. Trusts a header, which is exactly why config refuses it in production. */
function insecureDev(allowedProducts: readonly string[]): CallerAuth {
  return async (request) => {
    const productId = request.headers['x-dev-product-id'];

    // `typeof` narrows `string | string[] | undefined` to `string` for `Subject.productId`.
    if (typeof productId !== 'string' || !allowedProducts.includes(productId)) {
      throw unauthorized(`Dev auth rejected product id ${JSON.stringify(productId)}.`);
    }

    // `proven: false` because the header names a product, and nobody at all within it.
    return { productId, alias: `dev:${productId}`, proven: false };
  };
}