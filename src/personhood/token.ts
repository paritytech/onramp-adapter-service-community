/**
 * The short-lived bearer token that carries a proven person to the protected endpoints.
 *
 * A ring proof proves membership but not, by itself, that the same caller is the one hitting
 * `/session` a moment later; the adapter cannot ask the People chain on every spend. So the
 * handshake ends by minting a short-TTL JWT that binds the proven person (`sub` = their
 * contextual alias) to the product (`aud` = the product id). The protected routes verify this
 * JWT: cheap, stateless, no chain read. The recovered `sub` alias is both the audit key and the
 * rate-limit key on the protected routes (see src/caller.ts).
 *
 * The signing key is a `Secret` (see docs/threat-model.md T2/R5): it never crosses to a client
 * and is separate from the Meld key (separate HKDF label). HS256 via `jose`, which is vetted and
 * refuses `alg: none`. Rotation is an inbound-credential concern. Only one key verifies. A
 * rollout that rotates it invalidates every token minted under the previous one, and the browser
 * must re-run the handshake. The previous-key overlap that would avoid that is designed but not
 * built.
 */

import { SignJWT, jwtVerify, importJWK, type CryptoKey, type JWK } from 'jose';

/** The HS256 signing material for the session JWT. */
export interface TokenKey {
  secret: Uint8Array;
}

/**
 * The imported key, once per `TokenKey`.
 *
 * `importJWK` ran on every verify, which is on the hot path the whole handshake asymmetry
 * exists to keep cheap: the expensive chain-backed proof is supposed to happen once, and the
 * per-spend cost is supposed to be a single HMAC check. Re-deriving the key each time put avoidable
 * work back in front of every protected request.
 *
 * Keyed on the `TokenKey` object in a `WeakMap`, so a rotated key gets its own entry and the old
 * one is collected with it; nothing here pins key material alive past its owner. The promise
 * is cached rather than the resolved key, so concurrent first calls share one import instead of
 * racing to do the same work.
 */
const imported = new WeakMap<TokenKey, Promise<CryptoKey | Uint8Array>>();

function keyFor(key: TokenKey): Promise<CryptoKey | Uint8Array> {
  const already = imported.get(key);
  if (already !== undefined) return already;
  const importing = importJWK({ kty: 'oct', k: base64Url(key.secret) } satisfies JWK, 'HS256');
  imported.set(key, importing);
  return importing;
}

/**
 * Mint a JWT naming the proven person (sub = alias) for the given product (aud).
 * `aud` is the product id, so a token minted for one product cannot be spent by another.
 */
export async function mintToken(key: TokenKey, sub: string, aud: string, ttlSeconds: number): Promise<string> {
  const jwk = await keyFor(key);
  return new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(sub)
    .setAudience(aud)
    .setIssuedAt()
    .setExpirationTime(`${String(ttlSeconds)}s`)
    .sign(jwk);
}

/**
 * Verify `token`, returning its claims if it is valid and freshly enough minted.
 * Throws on a bad signature, expiry, a missing/absent `aud`, or an `aud` absent from
 * `allowedAudiences`. `algorithms` is pinned to HS256 so a downgrade to `alg: none` cannot be
 * smuggled in.
 */
export async function verifyToken(
  key: TokenKey,
  token: string,
  allowedAudiences: readonly string[],
): Promise<{ sub: string; aud: string }> {
  const jwk = await keyFor(key);
  const { payload } = await jwtVerify(token, jwk, {
    algorithms: ['HS256'],
    audience: [...allowedAudiences],
  });
  // Fail closed, rather than default. An absent `sub` would give an aliasless caller the alias
  // `''`, sharing one rate-limit bucket and one funding scope with every other aliasless
  // caller. And jose's audience check passes when any element of an `aud` array matches, so
  // taking `aud[0]` could scope a caller's data under a product that was never on the allowlist.
  // Neither is reachable today, because `mintToken` writes exactly one of each and forging needs
  // the signing key, but both are the single key everything else is scoped by.
  if (typeof payload.sub !== 'string' || payload.sub === '') {
    throw new Error('token carries no subject');
  }
  if (typeof payload.aud !== 'string') {
    throw new Error('token audience is not a single value');
  }
  return { sub: payload.sub, aud: payload.aud };
}

/** Return the base64url-encoded raw bytes (what `jose`'s oct key `k` expects). */
function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}