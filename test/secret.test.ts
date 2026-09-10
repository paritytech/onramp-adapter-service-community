import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';

import { beforeAll, describe, expect, it } from 'vitest';

import { resolveSecret, Secret } from '../src/secret.js';

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'onramp-secret-'));
});

describe('Secret', () => {
  const secret = new Secret('meld-test-key-not-a-real-credential');

  it('does not leak through string interpolation', () => {
    /* eslint-disable @typescript-eslint/restrict-template-expressions, @typescript-eslint/restrict-plus-operands
       -- implicit coercion of a Secret is exactly what these assertions exercise. */
    expect(`${secret}`).toBe('[redacted]');
    expect(String(secret)).toBe('[redacted]');
    expect(secret + '').toBe('[redacted]');
    /* eslint-enable @typescript-eslint/restrict-template-expressions, @typescript-eslint/restrict-plus-operands */
  });

  it('does not leak through JSON serialisation', () => {
    // The path a structured logger or an error serialiser takes.
    expect(JSON.stringify({ apiKey: secret })).toBe('{"apiKey":"[redacted]"}');
  });

  it('does not leak through console inspection', () => {
    expect(inspect({ apiKey: secret })).toContain('[redacted]');
    expect(inspect({ apiKey: secret })).not.toContain('not-a-real-credential');
  });

  it('yields the value only through expose()', () => {
    expect(secret.expose()).toBe('meld-test-key-not-a-real-credential');
  });

  it('refuses to hold an empty value', () => {
    expect(() => new Secret('')).toThrow(/empty/);
  });
});

describe('resolveSecret', () => {
  it('reads a mounted file and trims the trailing newline an editor adds', async () => {
    const path = join(dir, 'key');
    await writeFile(path, 'file-sourced-test-key\n');
    const secret = await resolveSecret({ mode: 'file', path });
    expect(secret.expose()).toBe('file-sourced-test-key');
  });

  it('fails loudly when the file is absent', async () => {
    // A missing mount must stop the process. Resolving to a default would mean starting
    // with the wrong key and discovering it in front of a buyer.
    await expect(resolveSecret({ mode: 'file', path: join(dir, 'nope') })).rejects.toThrow(
      /Cannot read secret file/,
    );
  });

  it('fails loudly when the file is empty or whitespace', async () => {
    const path = join(dir, 'blank');
    await writeFile(path, '   \n');
    await expect(resolveSecret({ mode: 'file', path })).rejects.toThrow(/missing or empty/);
  });

  it('reads an environment variable when the platform offers nothing better', async () => {
    process.env.TEST_MELD_KEY = 'env-sourced-test-key';
    const secret = await resolveSecret({ mode: 'env', var: 'TEST_MELD_KEY' });
    expect(secret.expose()).toBe('env-sourced-test-key');
    delete process.env.TEST_MELD_KEY;
  });

  it('fails loudly when the environment variable is unset', async () => {
    await expect(resolveSecret({ mode: 'env', var: 'DEFINITELY_UNSET' })).rejects.toThrow(
      /missing or empty/,
    );
  });
});

describe('resolveSecret, minimum length', () => {
  // The JWT signing key is the one secret whose strength this service depends on rather than
  // merely presents: HKDF expands it into both the challenge MAC key and the HS256 token key
  // without creating entropy, and `jose` will happily sign HS256 with a single byte. Nothing else
  // in the schema polices a secret's value.
  it('refuses a value shorter than the caller requires, naming the requirement', async () => {
    const path = join(dir, 'short.key');
    await writeFile(path, 'too-short\n');

    await expect(
      resolveSecret({ mode: 'file', path }, { minBytes: 32, name: 'auth.personhood.jwt_key' }),
    ).rejects.toThrow(/auth\.personhood\.jwt_key .* shorter than the required 32 bytes/);
  });

  it('names the length but never the value', async () => {
    const path = join(dir, 'short-secret.key');
    await writeFile(path, 'hunter2\n');

    const error = await resolveSecret({ mode: 'file', path }, { minBytes: 32 }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain('hunter2');
  });

  it('accepts a value that clears the floor, and counts bytes rather than characters', async () => {
    const path = join(dir, 'long.key');
    // 31 characters, but 32 bytes in UTF-8: the floor is on entropy-bearing bytes.
    await writeFile(path, `${'a'.repeat(30)}é\n`);

    const secret = await resolveSecret({ mode: 'file', path }, { minBytes: 32 });

    expect(secret.expose()).toHaveLength(31);
  });

  it('applies no floor when the caller asks for none, which is the Meld key\'s case', async () => {
    const path = join(dir, 'meld.key');
    await writeFile(path, 'k\n');

    await expect(resolveSecret({ mode: 'file', path })).resolves.toBeInstanceOf(Secret);
  });
});
