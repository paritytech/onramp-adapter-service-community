/**
 * The three secrets (the Meld API key, the JWT signing key and the CloudSQL password) and how they
 * stay out of everything else.
 *
 * Two things a reader needs. Reading a value requires `expose()`, which is greppable, so
 * "where is this key used" has an exact answer: four call sites, of which the Meld key's is
 * exactly one (the `Authorization: BASIC` header it must eventually reach), the JWT key's are the
 * two HKDF derivations in `startup.ts`, and the store password's is the one place `funding/store.ts`
 * builds its pool. And Node cannot erase a string: the guards below
 * stop accidental disclosure through logging, serialising and inspecting, and nothing more.
 * docs/threat-model.md T2 and R5 state the limit; the value arrives as a mounted file rather than
 * from a secret manager.
 */

import { readFile } from 'node:fs/promises';
import { inspect } from 'node:util';

const REDACTED = '[redacted]';

/**
 * A string that refuses to be printed.
 *
 * Three hooks cover the three accidental paths: interpolation and `String()` reach `toString`,
 * structured loggers and error serialisers reach `toJSON`, and `console.log` of a containing
 * object reaches `inspect.custom`.
 */
export class Secret {
  #value: string;

  constructor(value: string) {
    if (value.length === 0) throw new Error('Refusing to construct an empty Secret.');
    this.#value = value;
  }

  /** The only way to read it. Call at the point of use, never store the result. */
  expose(): string {
    return this.#value;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [inspect.custom](): string {
    return REDACTED;
  }
}

/** Where a secret comes from. `file` is the default, and the only mode allowed in production. */
type SecretSource = { mode: 'file'; path: string } | { mode: 'env'; var: string };

/**
 * Resolve at boot. Absent and empty are both fatal: a missing mount must stop the process.
 *
 * `minBytes` is for a secret whose strength this service depends on, rather than one it merely
 * presents. The Meld key is Meld's to size and is proven by the boot probe; the JWT signing key is
 * this service's, and HKDF expands it into both the challenge MAC key and the HS256 token key without
 * creating any entropy that was not there. `jose` will happily sign HS256 with one byte, so a
 * short mount would leave the personhood gate brute-forceable offline from a single captured
 * token. Nothing else in the schema polices a secret's value.
 */
export async function resolveSecret(
  source: SecretSource,
  opts: { minBytes?: number; name?: string } = {},
): Promise<Secret> {
  const raw = source.mode === 'file' ? await readSecretFile(source.path) : process.env[source.var];
  const value = raw?.trim();
  const where = source.mode === 'file' ? `file ${source.path}` : `environment variable ${source.var}`;

  if (!value) {
    throw new Error(`Secret is missing or empty: ${where}.`);
  }

  const minBytes = opts.minBytes ?? 0;
  if (Buffer.byteLength(value, 'utf8') < minBytes) {
    // The length is named; the value is not, and never is.
    throw new Error(
      `${opts.name ?? 'Secret'} in ${where} is shorter than the required ${String(minBytes)} bytes. ` +
        'Generate one with: openssl rand -base64 32',
    );
  }

  return new Secret(value);
}

async function readSecretFile(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch (cause) {
    throw new Error(
      `Cannot read secret file ${path}: ${cause instanceof Error ? cause.message : 'unknown error'}`,
    );
  }
}
