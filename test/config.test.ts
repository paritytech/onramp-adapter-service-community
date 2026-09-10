import { readFileSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadConfig, originAllowed, parseConfig, toOriginMatcher } from '../src/config.js';
import { personhoodConfig, rawConfig } from './fixtures.js';

/** The personhood auth block, merged into a single-mode config for the tests. */
const personhoodBlock = (): Record<string, unknown> => ({
  auth: (personhoodConfig() as { auth: Record<string, unknown> }).auth,
});

/**
 * A config that is valid in `production` apart from whatever the caller overrides.
 *
 * The bare fixture is a development one (env-mode credentials, sandbox Meld), so every
 * `not.toThrow` assertion against a production rule would otherwise fail on an unrelated issue and
 * every `toThrow` would pass for the wrong reason.
 */
const productionConfig = (store: Record<string, unknown> = {}): Record<string, unknown> =>
  rawConfig({
    environment: 'production',
    ...personhoodBlock(),
    meld: {
      ...(rawConfig().meld as Record<string, unknown>),
      base_url: 'https://api.meld.io',
      api_key: { mode: 'file', path: '/run/secrets/meld' },
    },
    store: { ...(rawConfig().store as Record<string, unknown>), ...store },
  });

describe('parseConfig', () => {

  /**
   * Every declared numeric bound, asserted at both ends.
   *
   * A mutation pass loosened all twenty-five `.min()`/`.max()` calls in this schema and
   * `contract.ts`, and the suite stayed green on every one, because a bound sits on a covered
   * line the moment a happy value flows through it, so the 100% statements gate says nothing about
   * it. Two have real teeth: `trusted_proxy_cidrs` decides the rate-limit bucket (both wrong answers are
   * real, and only the field's presence was tested), and `session_max_age_ms` is how long a paid
   * buyer's request waits before being written off.
   */
  it.each<[string, string[], number, number | undefined]>([
    ['server.port', ['server', 'port'], 0, 65_536],
    ['server.request_timeout_ms', ['server', 'request_timeout_ms'], 999, 120_001],
    ['meld.timeout_ms', ['meld', 'timeout_ms'], 499, 30_001],
    ['rate_limit.window_seconds', ['rate_limit', 'window_seconds'], 0, 3_601],
    ['rate_limit.per_person_max', ['rate_limit', 'per_person_max'], 0, undefined],
    ['rate_limit.per_address_max', ['rate_limit', 'per_address_max'], 0, undefined],
    ['worker.interval_ms', ['worker', 'interval_ms'], 999, 300_001],
    ['worker.session_max_age_ms', ['worker', 'session_max_age_ms'], 59_999, 30 * 24 * 3_600_000 + 1],
    ['auth.personhood.challenge_ttl_ms', ['auth', 'personhood', 'challenge_ttl_ms'], 999, 300_001],
    ['auth.personhood.token_ttl_s', ['auth', 'personhood', 'token_ttl_s'], 29, 3_601],
  ])('bounds %s at both ends', (_label, path, tooLow, tooHigh) => {
    for (const value of [tooLow, tooHigh]) {
      if (value === undefined) continue;
      // `personhoodConfig()` so the `auth.personhood.*` rows have a block to reach into.
      const raw = (path[0] === 'auth' ? personhoodConfig() : rawConfig()) as Record<string, unknown>;
      let cursor = raw;
      for (const key of path.slice(0, -1)) {
        cursor[key] = { ...(cursor[key] as Record<string, unknown>) };
        cursor = cursor[key] as Record<string, unknown>;
      }
      cursor[path[path.length - 1] as string] = value;
      // Matched on the field, not a bare `toThrow()`: an unrelated refusal would otherwise satisfy
      // a test named for this bound.
      expect(() => parseConfig(raw)).toThrow(new RegExp(path.join('\\.')));
    }
  });

  it.each([
    ['an upper-case host', 'https://App.Example'],
    ['an explicit :443 on https', 'https://app.example:443'],
    ['an explicit :80 on http', 'http://app.example:80'],
  ])('refuses %s, which would validate and then match nothing', (_label, value) => {
    // The regex exists to catch entries that pass validation and can never match. A trailing
    // slash was the motivating case. These three are the same defect: `@fastify/cors` compares a
    // browser `Origin` header by exact string, and that header is always lower-case with the
    // default port elided. Since the redirect guard shares this list, an operator with one of
    // these sees CORS fail and every redirect refused, with one invisible cause.
    expect(() => parseConfig(rawConfig({ cors: { allowed_origins: [value] } }))).toThrow(/allowed_origins|cors/);
  });

  it.each([
    ['sandbox', 'sandbox'],
    ['production', 'production'],
  ])('refuses an environment-variable Meld key in %s', (_label, environment) => {
    // `Secret`'s redaction hooks protect the value once it is inside the object; they do nothing
    // for `process.env`, which is readable at /proc/<pid>/environ, echoed by `docker inspect` and
    // by a pod spec, and captured in a core dump's environment block. That is the vector the
    // file-mount design exists to avoid, and `secret.ts` calls `file` the only mode allowed in production
    // while the schema treated the two as equals, with `config.example.json`, the file people
    // copy, demonstrating env mode for the JWT signing key specifically.
    expect(() =>
      parseConfig(
        rawConfig({
          environment,
          ...personhoodBlock(),
          meld: {
            ...(rawConfig().meld as Record<string, unknown>),
            base_url: environment === 'production' ? 'https://api.meld.io' : 'https://api-sb.meld.io',
            api_key: { mode: 'env', var: 'MELD_KEY' },
          },
        }),
      ),
    ).toThrow(/mounted as a file/);
  });

  it('refuses an environment-variable JWT signing key too, not only the Meld key', () => {
    // The clause the finding was written about, and the one with no test behind it: the loop
    // covers both secrets, but the table above only ever varied `meld.api_key`, and
    // `personhoodBlock()` supplies the JWT key in `file` mode. This is the key both personhood
    // keys are derived from.
    const personhood = (personhoodConfig().auth as { personhood?: Record<string, unknown> }).personhood ?? {};
    expect(() =>
      parseConfig(
        rawConfig({
          environment: 'sandbox',
          auth: {
            mode: 'personhood',
            personhood: { ...personhood, jwt_key: { mode: 'env', var: 'JWT' } },
          },
          meld: {
            ...(rawConfig().meld as Record<string, unknown>),
            api_key: { mode: 'file', path: '/run/secrets/meld-api-key' },
          },
        }),
      ),
    ).toThrow(/auth\.personhood\.jwt_key.*mounted as a file/s);
  });

  it.each([
    ['sandbox', 'sandbox'],
    ['production', 'production'],
  ])('refuses a plaintext CORS origin in %s', (_label, environment) => {
    // Two holes at once. `@fastify/cors` would let an http page call `/quote` and `/session`,
    // spending the operator's metered quota and carrying a bearer token over an unencrypted
    // origin. And since the redirect guard shares this list, that origin would be approved for
    // CORS and refused for a redirect. One allowlist, two answers.
    const personhood = (personhoodConfig().auth as { personhood?: Record<string, unknown> }).personhood ?? {};
    expect(() =>
      parseConfig(
        rawConfig({
          environment,
          auth: { mode: 'personhood', personhood },
          meld: {
            ...(rawConfig().meld as Record<string, unknown>),
            base_url: environment === 'production' ? 'https://api.meld.io' : 'https://api-sb.meld.io',
            api_key: { mode: 'file', path: '/run/secrets/meld-api-key' },
          },
          cors: { allowed_origins: ['http://app.example'] },
        }),
      ),
    ).toThrow(/allowed_origins.*plaintext/s);
  });

  it('still allows a plaintext origin in development, for a local dev server', () => {
    expect(() =>
      parseConfig(rawConfig({ cors: { allowed_origins: ['http://localhost:3000'] } })),
    ).not.toThrow();
  });

  it('refuses a port that could never appear in an Origin header', () => {
    // `:99999` passed the old `\d{1,5}` group, and `URL.parse` returns null for it, so it
    // validated at boot and could never match anything, which is the class the `:443` refinement
    // beside it exists to close.
    expect(() =>
      parseConfig(rawConfig({ cors: { allowed_origins: ['https://app.example:99999'] } })),
    ).toThrow(/allowed_origins/);
  });

  it('still allows an environment-variable secret in development', () => {
    expect(() => parseConfig(rawConfig())).not.toThrow();
  });

  it('accepts an empty limits array: discovery is the allow-gate, config is only a floor', () => {
    // `limits` is no longer the source of truth for what is buyable; live discovery
    // (meld/discovery.ts) decides that, and a `limits` row is only an optional business FLOOR
    // that tightens the live bound. An empty array is valid: the deployment leans on the live
    // catalog, and a discovery outage then fails closed (the safe direction for a charge gate).
    expect(() => parseConfig(rawConfig({ limits: [] }))).not.toThrow();
  });

  it('accepts a complete configuration', () => {
    expect(parseConfig(personhoodConfig()).environment).toBe('sandbox');
  });

  it('refuses insecure_dev auth in sandbox, not only in production', () => {
    // The mode gives every caller of a product the same alias, and the alias is what funding rows,
    // the rate-limit bucket and the idempotency index are scoped by. So two callers of one product
    // share a funding scope, and a key collision replays the other caller's session, answering
    // 201 with their settlement URL. Sandbox is exactly where a real integration is first pointed.
    expect(() =>
      parseConfig(rawConfig({ environment: 'sandbox', auth: { mode: 'insecure_dev' } })),
    ).toThrow(/insecure_dev.*refused when environment is "sandbox"/s);
  });

  it('permits insecure_dev in development, which is the only place it is true', () => {
    expect(() =>
      parseConfig(rawConfig({ environment: 'development', auth: { mode: 'insecure_dev' } })),
    ).not.toThrow();
  });

  it('refuses insecure_dev auth in production', () => {
    // The guard that keeps the development posture out of production. Without it, the mode
    // that trusts a header for the caller's identity is one config edit from being live.
    expect(() =>
      parseConfig(rawConfig({ environment: 'production', auth: { mode: 'insecure_dev' } })),
    ).toThrow(/insecure_dev.*refused when environment is "production"/s);
  });

  it('allows personhood auth in production', () => {
    // A production environment also needs a production endpoint; see the pairing check below,
    // which this test would otherwise trip on the fixture's sandbox URL.
    const cfg = parseConfig(
      rawConfig({
        environment: 'production',
        ...personhoodBlock(),
        // File-mounted, because production refuses an env-var secret.
        meld: {
          ...(rawConfig().meld as Record<string, unknown>),
          base_url: 'https://api.meld.io',
          api_key: { mode: 'file', path: '/run/secrets/meld-api-key' },
        },
      }),
    );

    expect(cfg.auth.mode).toBe('personhood');
  });

  it('requires the personhood block when the mode is personhood', () => {
    // `strict().optional()` allows insecure_dev configs to omit the block; the superRefine is
    // what turns an omission into a boot-blocking error, so both halves need a test.
    expect(() =>
      parseConfig(rawConfig({ auth: { mode: 'personhood' } })),
    ).toThrow(/auth\.personhood is required when auth\.mode is "personhood"/);
  });

  it('rejects a collection identifier that is not a 32-byte hex value', () => {
    const personhood = (personhoodConfig().auth as { personhood?: Record<string, unknown> }).personhood ?? {};
    expect(() =>
      parseConfig(
        rawConfig({
          auth: {
            mode: 'personhood',
            personhood: { ...personhood, collections: [{ identifier: 'nope', ring_exponent: 9 }] },
          },
        }),
      ),
    ).toThrow(/identifier must be a 32-byte hex value/);
  });

  it.each([
    ['sixteen bytes', `0x${'11'.repeat(16)}`],
    ['forty-eight bytes', `0x${'11'.repeat(48)}`],
    ['no 0x prefix', '11'.repeat(32)],
  ])('rejects a collection identifier of %s', (_label, id) => {
    // The test above passes `'nope'`, which a shape-only regex still rejects, so the length
    // half was never asserted. A 16-byte identifier boots fine and then throws
    // `identifier must be 32 bytes` from `membersRootKey` on every single redemption.
    const personhood = (personhoodConfig().auth as { personhood?: Record<string, unknown> }).personhood ?? {};
    expect(() =>
      parseConfig(
        rawConfig({
          auth: {
            mode: 'personhood',
            personhood: { ...personhood, collections: [{ identifier: id, ring_exponent: 9 }] },
          },
        }),
      ),
    ).toThrow(/identifier must be a 32-byte hex value/);
  });

  it('names the offending entry by index, not just the field', () => {
    // With a list, "one of your collections is malformed" is not actionable. The path carries the
    // index so an operator with three entries is told which one.
    const personhood = (personhoodConfig().auth as { personhood?: Record<string, unknown> }).personhood ?? {};
    expect(() =>
      parseConfig(
        rawConfig({
          auth: {
            mode: 'personhood',
            personhood: {
              ...personhood,
              collections: [
                { identifier: `0x${'11'.repeat(32)}`, ring_exponent: 9 },
                { identifier: 'nope', ring_exponent: 9 },
              ],
            },
          },
        }),
      ),
    ).toThrow(/collections\.1\.identifier/);
  });

  it.each([
    ['production paired with a sandbox endpoint', 'production', 'https://api-sb.meld.io'],
    ['sandbox paired with a production endpoint', 'sandbox', 'https://api.meld.io'],
  ])('refuses %s', (_label, environment, base_url) => {
    // Meld's sandbox and production keys are not interchangeable, and the failure is quiet: the
    // wrong pairing reads as a permissions problem rather than a configuration mistake.
    expect(() =>
      parseConfig(
        rawConfig({
          environment,
          ...(environment === 'production' ? personhoodBlock() : {}),
          meld: { ...(rawConfig().meld as Record<string, unknown>), base_url },
        }),
      ),
    ).toThrow(/base_url/);
  });

  it.each([
    ['meld.api_key', (raw: Record<string, unknown>) => {
      (raw.meld as Record<string, unknown>).api_key = { mode: 'env', var: 'MELD_KEY' };
    }],
    ['store.password', (raw: Record<string, unknown>) => {
      (raw.store as Record<string, unknown>).password = { mode: 'env', var: 'PGPASSWORD' };
    }],
    ['auth.personhood.jwt_key', (raw: Record<string, unknown>) => {
      const auth = raw.auth as Record<string, unknown>;
      (auth.personhood as Record<string, unknown>).jwt_key = { mode: 'env', var: 'JWT_KEY' };
    }],
  ])('refuses %s from the environment outside development', (label, mutate) => {
    // All three, in one table, because the one that was missing was missing precisely because the
    // loop was written by hand per credential. `store.password` parsed clean in production while
    // the comment above the block claimed the rule covered it.
    const raw = rawConfig({ environment: 'production', ...personhoodBlock() });
    mutate(raw);
    expect(() => parseConfig(raw)).toThrow(new RegExp(label.replace(/\./gu, '\\.')));
  });

  it.each(['127.0.0.1', '::1'])(
    'permits a plaintext store link to %s in production, because it never leaves the pod',
    (host) => {
      // This is how CloudSQL is actually reached: the Auth Proxy sidecar terminates TLS to the
      // instance and speaks plaintext on loopback. Refusing it left an overlay pinned at
      // `host: 127.0.0.1`, `ssl: true` unable to complete a handshake and unable to be
      // corrected, so neither available shape could boot.
      expect(() => parseConfig(productionConfig({ host, ssl: false }))).not.toThrow();
    },
  );

  it('refuses a plaintext store link to `localhost`, which is a name and not an address', () => {
    // The exemption covers addresses the kernel routes to the loopback interface. `localhost` is
    // resolved by `/etc/hosts`, `nsswitch.conf` and the search domains, all operator-controlled,
    // any of which can point it at something else. The exemption permits sending the database
    // password in the clear, so it does not extend to a name that usually maps to loopback.
    expect(() => parseConfig(productionConfig({ host: 'localhost', ssl: false }))).toThrow(/store\.ssl/);
  });

  it('still refuses a plaintext store link to a host that leaves the pod', () => {
    // The guard protects the hop across the VPC. A private IP is exactly that hop.
    expect(() => parseConfig(productionConfig({ host: '10.1.2.3', ssl: false }))).toThrow(/store\.ssl/);
  });

  it('permits a plaintext link the operator has asserted is an in-cluster proxy', () => {
    // The Cloud SQL Auth Proxy can also run as its own Deployment and Service rather than as a
    // sidecar, so the hop is pod-to-pod on the cluster network and loopback cannot describe it.
    // The proxy listens in the clear (it cannot terminate TLS from a client), so `ssl: true`
    // against it does not encrypt the hop; it fails the connection. Refusing the shape does not
    // make the deployment encrypted; it makes it impossible, which is how a deployment in that
    // shape came to fail config validation at boot.
    expect(() =>
      parseConfig(
        productionConfig({
          host: 'onramp-adapter-service-gcloud-sqlproxy',
          ssl: false,
          plaintext_link: 'in-cluster-proxy',
        }),
      ),
    ).not.toThrow();
  });

  it('will not infer the exemption from a hostname that merely looks in-cluster', () => {
    // The whole reason this is a field and not a pattern. A single-label name resolves through the
    // search domains, which an operator controls, so reading "in-cluster" off its shape would be
    // exactly the inference `isLoopback` refuses to make for `localhost`. The operator asserts it or
    // it does not hold.
    expect(() =>
      parseConfig(productionConfig({ host: 'onramp-adapter-service-gcloud-sqlproxy', ssl: false })),
    ).toThrow(/store\.ssl/);
  });

  it.each([
    ['a public FQDN', 'db.example.com'],
    ['a private IP literal', '10.1.2.3'],
    ['service.namespace, which two labels cannot distinguish from a public domain', 'sqlproxy.default'],
    ['localhost, which names loopback and so contradicts "in-cluster proxy"', 'localhost'],
  ])('refuses the assertion against %s', (_label, host) => {
    // The assertion is checked, not merely recorded. Unverified it would catch nothing: set it once
    // and the host is unconstrained forever, so a config that later drifts to a remote database
    // keeps passing. That was the defect in the first version of this guard.
    expect(() => parseConfig(productionConfig({ host, ssl: false, plaintext_link: 'in-cluster-proxy' }))).toThrow(
      /store\.ssl/,
    );
  });

  it.each([
    ['a bare Service name', 'onramp-adapter-service-gcloud-sqlproxy'],
    ['a .svc short form', 'sqlproxy.default.svc'],
    ['a fully qualified cluster name', 'sqlproxy.default.svc.cluster.local'],
  ])('accepts the assertion against %s', (_label, host) => {
    expect(() =>
      parseConfig(productionConfig({ host, ssl: false, plaintext_link: 'in-cluster-proxy' })),
    ).not.toThrow();
  });

  it('refuses an assertion that contradicts an encrypted link', () => {
    // A stale assertion reads as "plaintext was accepted here" on a link that is encrypted, and it
    // would silently re-permit plaintext if someone later flipped `ssl` back. The field carries a
    // decision, so it has to be wrong when the decision is not.
    expect(() =>
      parseConfig(productionConfig({ host: '10.1.2.3', ssl: true, plaintext_link: 'in-cluster-proxy' })),
    ).toThrow(/plaintext_link/);
  });

  it('accepts only the shape that has been reasoned about', () => {
    // One legal value, so a future third deployment shape cannot be waved through by inventing a
    // word for it. Whoever needs one comes back and argues for it.
    expect(() =>
      parseConfig(
        productionConfig({ host: '10.1.2.3', ssl: false, plaintext_link: 'trust-me' }),
      ),
    ).toThrow(/plaintext_link/);
  });

  it('keeps the retention decision on record, and its floor', () => {
    // 90 days is a decision a data owner signed off on, and the one-day floor exists so a typo
    // cannot turn the sweep into delete-on-sight. Both lived only in a comment: the default could
    // be changed to 1 or 3650, or the floor dropped to 0, with the suite green.
    expect(parseConfig(rawConfig()).worker.refusal_retention_days).toBe(90);

    const withDays = (days: number) =>
      parseConfig(rawConfig({ worker: { ...(rawConfig().worker as Record<string, unknown>), refusal_retention_days: days } }));
    expect(() => withDays(0)).toThrow(/refusal_retention_days/);
    expect(withDays(1).worker.refusal_retention_days).toBe(1);
  });

  it.each(['sandbox', 'production'])('refuses a plaintext store link in %s', (environment) => {
    // The link carries every funding row (aliases, wallet addresses, amounts) and the password
    // that opens it. CloudSQL terminates TLS, so `ssl: false` outside development is a decision to
    // send all of that in the clear across the VPC. Refused for the same reason `people_rpc_url`
    // refuses `ws://`.
    expect(() =>
      parseConfig(
        rawConfig({
          environment,
          ...(environment === 'production' ? personhoodBlock() : {}),
          // Non-loopback: a loopback host is exempt, and this test is about the VPC hop.
          store: { ...(rawConfig().store as Record<string, unknown>), host: '10.1.2.3', ssl: false },
        }),
      ),
    ).toThrow(/store\.ssl/);
  });

  it('permits a plaintext store link in development, where there is no TLS to have', () => {
    expect(() =>
      parseConfig(rawConfig({ store: { ...(rawConfig().store as Record<string, unknown>), ssl: false } })),
    ).not.toThrow();
  });

  it.each([
    ['a quote that closes the option', 'public" -c log_statement=all -c "'],
    ['a leading digit', '1public'],
    ['a hyphen', 'my-schema'],
    ['a space', 'my schema'],
  ])('refuses %s in store.schema', (_label, schema) => {
    // It is interpolated into the connection's libpq `options` string, so anything outside a bare
    // identifier is a way to set connection parameters this service never chose. Operator-
    // controlled rather than caller-controlled, which is why it is a narrow pattern rather than an
    // escape. But "the operator would not do that" is not a validation strategy, and every other
    // string that reaches a connection here (the origin list, the People RPC, the Meld base URL)
    // is already constrained.
    expect(() =>
      parseConfig(rawConfig({ store: { ...(rawConfig().store as Record<string, unknown>), schema } })),
    ).toThrow(/store\.schema/);
  });

  it('accepts a bare identifier for store.schema', () => {
    expect(() =>
      parseConfig(rawConfig({ store: { ...(rawConfig().store as Record<string, unknown>), schema: 'onramp_v2' } })),
    ).not.toThrow();
  });

  it.each(['host', 'database', 'user', 'password'])('refuses a store with no %s', (field) => {
    // No defaults on any of them. A funding history that silently never persists is worse than a
    // server that refuses to boot without saying where the history lives.
    // Rebuilt without the field rather than deleted from a copy: a dynamic `delete` is banned by
    // the lint rules, and the omission is what is being asserted either way.
    const store = Object.fromEntries(
      Object.entries(rawConfig().store as Record<string, unknown>).filter(([key]) => key !== field),
    );
    expect(() => parseConfig(rawConfig({ store }))).toThrow(new RegExp(`store\\.${field}`));
  });

  it.each([
    ['a lookalike host', 'production', 'https://api.meld.io.attacker.example'],
    ['a hyphenated lookalike', 'production', 'https://api-meld-io.attacker.example'],
    ['an unrelated host', 'production', 'https://attacker.example'],
    ['plaintext http', 'production', 'http://api.meld.io'],
    ['userinfo hiding the real host', 'production', 'https://api.meld.io@attacker.example'],
    // Userinfo is refused in every environment: the host is what follows the '@', so a
    // development config written this way sends the operator's key to `attacker.example`.
    ['userinfo in development', 'development', 'https://api.meld.io@attacker.example'],
    ['a path that would be discarded', 'production', 'https://api.meld.io/v1'],
    ['the production endpoint from development', 'development', 'https://api.meld.io'],
  ])('refuses %s as a base_url', (_label, environment, base_url) => {
    // Each of these was accepted before the host was pinned by name, and each one receives
    // `Authorization: BASIC <key>` on the first call. The substring test for `api-sb.` asked
    // whether the endpoint looked like a sandbox, never whether it was Meld at all, and it
    // skipped `development` entirely, which made that value an alias for "anywhere",
    // production endpoint included.
    expect(() =>
      parseConfig(
        rawConfig({
          environment,
          ...(environment === 'production' ? personhoodBlock() : {}),
          meld: { ...(rawConfig().meld as Record<string, unknown>), base_url },
        }),
      ),
    ).toThrow(/base_url/);
  });

  it.each([
    ['a local fake', 'http://localhost:9'],
    ['the sandbox endpoint', 'https://api-sb.meld.io'],
  ])('leaves development free to point at %s', (_label, base_url) => {
    // Development keeps the freedom it exists for. It loses exactly one option, covered above:
    // the endpoint where money actually moves.
    expect(() =>
      parseConfig(
        rawConfig({
          environment: 'development',
          meld: { ...(rawConfig().meld as Record<string, unknown>), base_url },
        }),
      ),
    ).not.toThrow();
  });

  it.each([
    ['a trailing slash, which is what copying from an address bar gives you', 'https://app.example/'],
    ['a path', 'https://app.example/app'],
    ['a non-http scheme', 'file:///etc/passwd'],
    ['a scriptable scheme', 'javascript:alert(1)'],
    ['a wildcard, which @fastify/cors compares literally', 'https://*.example'],
  ])('refuses a CORS origin with %s', (_label, value) => {
    // A browser `Origin` header is always scheme://host[:port]. @fastify/cors compares an entry
    // to it by string equality, so any of these silently refuses every browser request with
    // nothing in the log to explain it, which reads as "CORS is broken" during exactly the
    // integration this service exists for.
    expect(() => parseConfig(rawConfig({ cors: { allowed_origins: [value] } }))).toThrow(/origin/i);
  });

  it.each(['https://app.example', 'https://app.example:8443', 'http://localhost:3000'])(
    'accepts the bare origin %s',
    (value) => {
      expect(() => parseConfig(rawConfig({ cors: { allowed_origins: [value] } }))).not.toThrow();
    },
  );

  it.each([
    ['the opaque origin a sandboxed host sends', 'null'],
    ['the Polkadot host scheme', 'polkadot://app'],
    ['the Polkadot host scheme with a port', 'polkadot://app:8443'],
  ])('accepts %s, which the app inside the Polkadot host actually sends', (_label, value) => {
    // The SPA runs inside the Polkadot host, which sends either its own scheme or, sandboxed,
    // the opaque `null`. Neither clears a validator written for `https?://` only, so preflight
    // failed for the one caller this service exists to serve.
    expect(() => parseConfig(rawConfig({ cors: { allowed_origins: [value] } }))).not.toThrow();
  });

  it.each([
    ['an upper-case host a browser would never send', 'https://App.Example'],
    ['a port above the real range', 'polkadot://app:99999'],
    ['the default https port, which no Origin header carries', 'https://app.example:443'],
    ['the default http port, which no Origin header carries', 'http://localhost:80'],
  ])('still refuses %s after widening for the host', (_label, value) => {
    // Widening the scheme must not widen anything else. Each of these was refused before
    // `polkadot://` and `null` were added and has to stay refused. @fastify/cors compares entries
    // to the browser's `Origin` by string equality, so an entry a browser can never send is an
    // entry that silently never matches: CORS "broken" with nothing in the log to say why.
    expect(() => parseConfig(rawConfig({ cors: { allowed_origins: [value] } }))).toThrow(/origin|port/i);
  });

  it('defaults to trusting no proxy, which is the safe direction', () => {
    // `trusted_proxy_cidrs` replaced `trusted_proxy_hops`, and unlike it this one can have a
    // default, because the safe answer is knowable: trust nobody, read no forwarded header, bucket
    // on the socket address. Behind an ingress that makes the per-caller ceiling a per-service one:
    // visible, and the direction that cannot be exploited. The hop count had no safe default in
    // either direction, which is why it was required; it is gone because once trust is decided by
    // peer a hop count is read by nothing.
    const server: Record<string, unknown> = { ...(rawConfig().server as Record<string, unknown>) };
    delete server.trusted_proxy_cidrs;

    expect(parseConfig(rawConfig({ server })).server.trusted_proxy_cidrs).toEqual([]);
  });

  it('refuses limits naming a destination the catalog does not have', () => {
    // Configuration cannot widen the accepted asset set. Adding a destination is a code
    // change with a test, because DOT and DOT_ASSETHUB are different chains and the wrong
    // answer looks plausible.
    expect(() =>
      parseConfig(rawConfig({ limits: [{ code: 'BTC', min: '10', max: '20', currency: 'USD' }] })),
    ).toThrow(/Unknown destination code "BTC"/);
  });

  it('defaults session creation to enabled when the flag is omitted', () => {
    // A flipped default would silently stop every deployment that does not set it, and
    // nothing would have noticed.
    const raw = rawConfig() as Record<string, unknown>;
    delete raw.session_creation_enabled;

    expect(parseConfig(raw).session_creation_enabled).toBe(true);
  });

  it('accepts a file-sourced secret, which is the default deployment mode', () => {
    const cfg = parseConfig(
      rawConfig({
        meld: {
          base_url: 'https://api-sb.meld.io',
          api_key: { mode: 'file', path: '/run/secrets/meld' },
          api_version: '2025-01-01',
          boot_probe: {
            destination_code: 'USDC_ASSETHUB',
            source_amount: '20',
            source_currency: 'USD',
            country_code: 'US',
            payment_method_type: 'CREDIT_DEBIT_CARD',
          },
        },
      }),
    );

    expect(cfg.meld.api_key).toEqual({ mode: 'file', path: '/run/secrets/meld' });
  });

  it.each([
    ['a leading sign', '+10.00'],
    ['trailing junk', '10.00x'],
    ['leading junk', 'x10.00'],
    ['three fraction digits', '10.000'],
    ['an empty string', ''],
  ])('refuses a limit amount with %s', (_label, min) => {
    expect(() =>
      parseConfig(rawConfig({ limits: [{ code: 'USDC_ASSETHUB', min, max: '2000.00', currency: 'USD' }] })),
    ).toThrow(/Invalid configuration/);
  });

  it('accepts a whole-number limit amount', () => {
    expect(() =>
      parseConfig(rawConfig({ limits: [{ code: 'USDC_ASSETHUB', min: '10', max: '2000', currency: 'USD' }] })),
    ).not.toThrow();
  });

  it.each([
    ['four letters', 'USDX'],
    ['a trailing digit', 'US1'],
    ['leading whitespace', ' USD'],
  ])('refuses a currency with %s', (_label, currency) => {
    expect(() =>
      parseConfig(rawConfig({ limits: [{ code: 'USDC_ASSETHUB', min: '10.00', max: '20.00', currency }] })),
    ).toThrow(/Invalid configuration/);
  });

  it('refuses an inverted limit range', () => {
    // Boots happily and then refuses every amount, which reads as an outage rather than a
    // typo, so it must not boot.
    expect(() =>
      parseConfig(rawConfig({ limits: [{ code: 'USDC_ASSETHUB', min: '2000.00', max: '10.00', currency: 'USD' }] })),
    ).toThrow(/Minimum 2000.00 exceeds maximum 10.00/);
  });

  it('accepts a range where the minimum equals the maximum', () => {
    expect(() =>
      parseConfig(rawConfig({ limits: [{ code: 'USDC_ASSETHUB', min: '50.00', max: '50.00', currency: 'USD' }] })),
    ).not.toThrow();
  });

  it('refuses an entry proxy-addr could not compile, naming the field', () => {
    // Shape, not correctness: whether the address is the right one is not knowable here. But an
    // unvalidated entry threw from inside the `Fastify()` constructor instead, after the store was
    // opened and migrated, and with a message that never mentioned `server.trusted_proxy_cidrs`.
    //
    // The behaviour this guards (that the header is read only for named peers) is asserted
    // against a built server in `server.test.ts`, not here. A test that puts a value through
    // `parseConfig` and reads it back out is a schema echo, and would stay green with `trustProxy`
    // deleted entirely.
    const server = rawConfig().server as Record<string, unknown>;
    const parse = (cidrs: string[]) => () => parseConfig(rawConfig({ server: { ...server, trusted_proxy_cidrs: cidrs } }));

    // The cases that matter are the ones a plausible operator entry produces, not obvious
    // nonsense. A regex here would catch only the charset class below while
    // accepting all of these, including `0.0.0.0/0`, which is exactly what someone writes when
    // told "trust the ingress" and they do not have the CIDR to hand.
    expect(parse(['0.0.0.0/0'])).toThrow(/trusted_proxy_cidrs/);
    expect(parse(['10.0.0.0/33'])).toThrow(/trusted_proxy_cidrs/);
    expect(parse(['256.1.1.1'])).toThrow(/trusted_proxy_cidrs/);
    expect(parse(['::1/129'])).toThrow(/trusted_proxy_cidrs/);
    expect(parse(['127.0.0.1/00'])).toThrow(/trusted_proxy_cidrs/);
    expect(parse(['not-an-ip'])).toThrow(/trusted_proxy_cidrs/);
    expect(parse(['10.0.0.0/8 '])).toThrow(/trusted_proxy_cidrs/);
    expect(parse(['10.0.0.0/8'])).not.toThrow();
    expect(parse(['::1/128'])).not.toThrow();
    expect(parse(['loopback'])).not.toThrow();
  });

  it('serves DOT_ASSETHUB, which is the destination the consumer defaults to', () => {
    // The example config must be able to create the default session: a catalog destination with
    // no configured limits is refused RegionUnavailable, so omitting DOT made the documented
    // example fail on its first session create.
    const example = JSON.parse(readFileSync('config.example.json', 'utf8')) as Record<string, unknown>;
    const cfg = parseConfig(example);

    expect(cfg.limits.map((l) => l.code)).toContain('DOT_ASSETHUB');
    expect(cfg.meld.boot_probe.destination_code).toBe('DOT_ASSETHUB');
  });

  it('keeps the shipped worker deadline in step with the config default', () => {
    // `session_max_age_ms` has three spellings of one value: the schema default (`72 * 3_600_000`),
    // and the literal `259200000` in both `helm/values.yaml` and `config.example.json`. YAML has no
    // expression form to derive one from the other, so they are pinned equal here.
    //
    // Three, and the first version of this test reached only two of them. `config.example.json`
    // sets the key explicitly, so parsing it returns the file's literal and never touches the
    // schema default, which meant changing that default to `6 * 3_600_000` left the whole suite
    // green while the test's own comment named it first. The number is read from the chart, and
    // the default is reached by parsing an example with the key removed.
    const example = JSON.parse(readFileSync('config.example.json', 'utf8')) as Record<string, unknown>;
    const helm = readFileSync('helm/values.yaml', 'utf8');
    const shipped = Number(/session_max_age_ms:\s*(\d+)/.exec(helm)?.[1]);

    // Not a restated literal. That is the drift this test exists to catch. What is pinned is the
    // reason: bank-transfer rails settle in up to 24 hours, so a 24-hour window concluded a
    // late-landing transfer `expired`, which asserts the buyer did not pay about a buyer whose
    // money had moved. The window must exceed that ceiling with room for a weekend.
    // Pinned at the reason, and at the whole reason, because `> ceiling` would pass at 24h plus
    // a millisecond, which is the boundary this value moved away from. A transfer initiated on a
    // Friday settles on a Monday, so the window has to clear the ceiling by a weekend.
    const BANK_SETTLEMENT_CEILING_MS = 24 * 3_600_000;
    const WEEKEND_MS = 48 * 3_600_000;
    expect(shipped).toBeGreaterThanOrEqual(BANK_SETTLEMENT_CEILING_MS + WEEKEND_MS);
    // The example's explicit value.
    expect(parseConfig(example).worker.session_max_age_ms).toBe(shipped);
    // And the schema default, which only a config that omits the key can reach.
    const worker = { ...(example.worker as Record<string, unknown>) };
    delete worker.session_max_age_ms;
    expect(parseConfig({ ...example, worker }).worker.session_max_age_ms).toBe(shipped);
    // The exact value is itself load-bearing, not just the reason-bound: a drift from 72h to, say,
    // 96h (or back toward 24h) clears the reason-bound above and the equality pins here, because
    // all three spellings move together. The window the worker gives a crashed reservation
    // and the "up to three days" docs both quote 72h, so pin the value, not just the shape.
    expect(parseConfig({ ...example, worker }).worker.session_max_age_ms).toBe(72 * 3_600_000);
  });

  it('serves the same destination codes the catalog recognises', () => {
    // The three ASSETHUB codes are owned by `catalog.ts` and repeated in the example
    // config, the Helm values and the fixtures. `parseConfig` validates limits against
    // `DESTINATIONS`, so the example and the chart both fail loudly on drift; this asserts
    // the two files that boot real deployments agree with the catalog through the real validator,
    // rather than leaning on a string scan of YAML.
    const example = JSON.parse(readFileSync('config.example.json', 'utf8')) as Record<string, unknown>;
    const parsed = parseConfig(example);
    // The example lists all three catalog destinations. Each is validated against `DESTINATIONS`
    // by `parseConfig`, so an unknown code here would fail at parse; this records the agreed set.
    expect(parsed.limits.map((l) => l.code)).toEqual(
      expect.arrayContaining(['DOT_ASSETHUB', 'USDC_ASSETHUB', 'USDT_ASSETHUB']),
    );
    expect(parsed.limits).toHaveLength(3);

    const helm = readFileSync('helm/values.yaml', 'utf8');
    expect(helm).toMatch(/destination_code:\s*DOT_ASSETHUB/);
    expect(helm).toMatch(/- code:\s*DOT_ASSETHUB/);
    // `USDC_ASSETHUB` is what regions without DOT are sold (1 Sep meeting), and it is enabled by
    // presence in this list: a destination the catalog knows and the values omit is refused as
    // `RegionUnavailable`, which is a silent refusal rather than an error at boot. The chart gate
    // catches a malformed entry and cannot catch a missing one, so the assertion has to be here.
    expect(helm).toMatch(/- code:\s*USDC_ASSETHUB/);
  });

  it('accepts more than one destination', () => {
    // The array bound is a minimum, not a maximum. Nothing exercised that, so a regression
    // capping it at one would have quietly halved the product.
    const cfg = parseConfig(
      rawConfig({
        limits: [
          { code: 'USDC_ASSETHUB', min: '10.00', max: '2000.00', currency: 'USD' },
          { code: 'DOT_ASSETHUB', min: '25.00', max: '500.00', currency: 'USD' },
        ],
      }),
    );

    expect(cfg.limits).toHaveLength(2);
  });

  it('closes CORS and applies sane rate limits when those blocks are omitted', () => {
    // The default has to be closed. If it ever became permissive, nothing else would notice.
    const raw = rawConfig() as Record<string, unknown>;
    delete raw.cors;
    delete raw.rate_limit;

    const cfg = parseConfig(raw);
    expect(cfg.cors.allowed_origins).toEqual([]);
    expect(cfg.rate_limit).toEqual({ per_person_max: 120, per_address_max: 30, window_seconds: 60 });
  });

  it.each([['omitted entirely', undefined], ['written as an empty object', {}]])(
    'applies the documented cors and rate_limit defaults when each block is %s',
    (_label, empty) => {
      // Both blocks use `.prefault({})` rather than restating their field defaults, precisely so
      // the two ways of saying "I have no opinion" cannot drift apart. An outer `.default({...})`
      // wins over the per-field defaults when the object is absent, so the documented numbers
      // would then depend on whether the operator wrote nothing or wrote `{}`.
      const raw = rawConfig() as Record<string, unknown>;
      if (empty === undefined) {
        delete raw.cors;
        delete raw.rate_limit;
      } else {
        raw.cors = { ...empty };
        raw.rate_limit = { ...empty };
      }

      const cfg = parseConfig(raw);
      // Closed by default: an empty allowlist means no browser may call this service, which is
      // the right answer for one reached server-to-server.
      expect(cfg.cors).toEqual({ allowed_origins: [] });
      expect(cfg.rate_limit).toEqual({ per_person_max: 120, per_address_max: 30, window_seconds: 60 });
    },
  );

  it('gives the same defaults whether a block is omitted or written empty', () => {
    // The property behind the two rows above, stated once: the operator's two ways of writing
    // "no opinion" must be the same configuration, not merely two plausible ones.
    const omitted = rawConfig() as Record<string, unknown>;
    delete omitted.cors;
    delete omitted.rate_limit;
    const empty = rawConfig({ cors: {}, rate_limit: {} }) as Record<string, unknown>;

    expect(parseConfig(empty).cors).toEqual(parseConfig(omitted).cors);
    expect(parseConfig(empty).rate_limit).toEqual(parseConfig(omitted).rate_limit);
  });

  it('refuses the retired rate_limit.max rather than reinterpreting it', () => {
    // `max` meant "per address" before the split in two, and the danger of keeping the
    // name is that an operator's existing `30` would silently become a per-person ceiling as
    // well. `.strict()` turns that into a boot failure, which is the only safe direction.
    expect(() =>
      parseConfig(rawConfig({ rate_limit: { max: 30, window_seconds: 60 } })),
    ).toThrow(/max/);
  });

  it('bounds a person more generously than an address by default', () => {
    // Not cosmetic: an address stands in for however many unproven callers share it, while a
    // person is one human whose bucket cost a ring-VRF proof. If these two ever converge, the
    // per-person tier has stopped earning its complexity.
    const raw = rawConfig() as Record<string, unknown>;
    delete raw.rate_limit;

    const cfg = parseConfig(raw);
    expect(cfg.rate_limit.per_person_max).toBeGreaterThan(cfg.rate_limit.per_address_max);
  });

  /** The personhood block with `collections` replaced wholesale. */
  const withCollections = (collections: unknown): Record<string, unknown> => {
    const personhood = (personhoodConfig().auth as { personhood?: Record<string, unknown> }).personhood ?? {};
    return rawConfig({ auth: { mode: 'personhood', personhood: { ...personhood, collections } } });
  };

  const PEOPLE = '0x' + '11'.repeat(32);
  const PEOPLE_LITE = '0x' + '22'.repeat(32);

  it.each([[10], [14]])('accepts ring_exponent %i, which a larger People collection uses', (exponent) => {
    // Every fixture in this suite uses 9, so replacing the refinement with `() => true` changed
    // nothing anywhere. The exponent is the proof domain handed to `validate_with_commitment`.
    // A value the collection was not built with does not weaken the check; it makes every honest
    // proof fail to open: the personhood gate refusing everybody, at boot, with no message.
    const cfg = parseConfig(withCollections([{ identifier: PEOPLE, ring_exponent: exponent }]));

    expect(cfg.auth.personhood?.collections[0]?.ring_exponent).toBe(exponent);
  });

  it.each([[0], [8], [11], [15], [-9]])('refuses ring_exponent %i, which names no ring', (exponent) => {
    // Only three domains exist. A near-miss is the dangerous shape: 8 and 11 sit either side of
    // a real value and read as plausible in a chart's values file.
    expect(() => parseConfig(withCollections([{ identifier: PEOPLE, ring_exponent: exponent }]))).toThrow(
      /ring_exponent must be 9, 10 or 14\./,
    );
  });

  it('accepts several collections, each carrying its own exponent', () => {
    // Personhood is not one population. A full person and a lite person live in different
    // collections and their proofs open against different rings. Pinning one silently refuses
    // everybody in the other: the commitment read succeeds for a collection they are not in, and
    // the proof does not open, so the service looks healthy and turns real people away.
    //
    // The exponent rides with the collection because it is the ring domain, a property of the
    // collection rather than of this deployment. One shared value would be an assumption with
    // nothing checking it.
    const cfg = parseConfig(
      withCollections([
        { identifier: PEOPLE, ring_exponent: 9 },
        { identifier: PEOPLE_LITE, ring_exponent: 10 },
      ]),
    );

    expect(cfg.auth.personhood?.collections).toHaveLength(2);
    expect(cfg.auth.personhood?.collections[1]?.ring_exponent).toBe(10);
  });

  it('refuses an empty collections list, which would refuse every person', () => {
    // `personhood` mode with nothing to verify against is a gate that cannot pass anyone. It fails
    // at boot rather than serving 401 to every caller with no indication why.
    expect(() => parseConfig(withCollections([]))).toThrow(/collections/);
  });

  it('refuses a duplicate collection, because the duplicate carries an exponent', () => {
    // The entry is what supplies the ring exponent, so two rows for one collection disagreeing
    // on it would make verification depend on list order.
    expect(() =>
      parseConfig(
        withCollections([
          { identifier: PEOPLE, ring_exponent: 9 },
          { identifier: PEOPLE, ring_exponent: 14 },
        ]),
      ),
    ).toThrow(/duplicate collection identifier/);
  });

  it('refuses a collection id that has been trimmed of its padding', () => {
    // The real identifiers are ASCII names space-padded to 32 bytes: `pop:polkadot.network/people`
    // carries four trailing 0x20. Trimming them is the plausible mistake, and it produces a value
    // that is still hex and still looks right.
    const trimmed = '0x' + '11'.repeat(28);
    expect(() => parseConfig(withCollections([{ identifier: trimmed, ring_exponent: 9 }]))).toThrow(
      /32-byte hex|do not trim trailing spaces/,
    );
  });

  it('refuses a boot probe naming a destination the catalog does not have', () => {
    // Meld resolves an unrecognised destination code to Bitcoin rather than refusing it, so a
    // typo here returns BTC quotes and the probe reports "Meld credentials accepted" for a
    // corridor this deployment does not serve. The probe moves no money, which makes it false
    // confidence rather than a wrong purchase, and false confidence at boot is precisely what
    // the probe exists to rule out.
    const meld = { ...(rawConfig().meld as Record<string, unknown>) };
    meld.boot_probe = { ...(meld.boot_probe as Record<string, unknown>), destination_code: 'USDC_ASSETHB' };

    expect(() => parseConfig(rawConfig({ meld }))).toThrow(
      /Unknown destination code\. The boot probe must name one this service delivers\./,
    );
  });

  it.each(['USDC_ASSETHUB', 'USDT_ASSETHUB', 'DOT_ASSETHUB'])(
    'accepts the catalog destination %s as the boot probe corridor',
    (code) => {
      // The check is against the catalog, not against the configured `limits`: the probe proves
      // the credential, and an operator may prove it on a corridor they have not priced yet.
      const meld = { ...(rawConfig().meld as Record<string, unknown>) };
      meld.boot_probe = { ...(meld.boot_probe as Record<string, unknown>), destination_code: code };

      expect(parseConfig(rawConfig({ meld })).meld.boot_probe.destination_code).toBe(code);
    },
  );

  it.each(['ws://people:9944', 'http://people:9944'])(
    'refuses an unauthenticated People-chain RPC (%s) outside development',
    (url) => {
      // This RPC is the root of trust for personhood: the ring commitment read from it is the
      // only thing separating a real member from someone who generated their own ring. Over
      // plaintext an on-path attacker serves a commitment they built, and their self-minted
      // proof validates against it.
      expect(() =>
        parseConfig(
          personhoodConfig({
            auth: {
              mode: 'personhood',
              personhood: {
                jwt_key: { mode: 'env', var: 'TEST_PH_KEY' },
                people_rpc_url: url,
                collections: [{ identifier: '0x' + '11'.repeat(32), ring_exponent: 9 }],
                challenge_ttl_ms: 60_000,
                token_ttl_s: 300,
              },
            },
          }),
        ),
      ).toThrow(/people_rpc_url/);
    },
  );

  it('allows a plaintext People-chain RPC in development, for a local node', () => {
    expect(() =>
      parseConfig(
        personhoodConfig({
          environment: 'development',
          auth: {
            mode: 'personhood',
            personhood: {
              jwt_key: { mode: 'env', var: 'TEST_PH_KEY' },
              people_rpc_url: 'ws://127.0.0.1:9944',
              collections: [{ identifier: '0x' + '11'.repeat(32), ring_exponent: 9 }],
              challenge_ttl_ms: 60_000,
              token_ttl_s: 300,
            },
          },
        }),
      ),
    ).not.toThrow();
  });

  it.each([
    ['meld.base_url', (raw: Record<string, unknown>) => {
      (raw.meld as Record<string, unknown>).base_url = '::::';
    }],
    ['auth.personhood.people_rpc_url', (raw: Record<string, unknown>) => {
      const auth = raw.auth as { personhood: Record<string, unknown> };
      auth.personhood.people_rpc_url = '';
    }],
  ])('names the field when %s is not a URL, rather than throwing a bare TypeError', (field, mutate) => {
    // `superRefine` runs even when a field failed its own check (zod marks the result dirty
    // rather than aborting), so `new URL()` there escaped the error aggregation entirely and
    // surfaced as `Startup failed: Invalid URL`, naming nothing. That is what the chart's own
    // default values produce, so it was the first thing an operator would have seen.
    const raw = personhoodConfig() as Record<string, unknown>;
    mutate(raw);

    const error = (() => {
      try {
        parseConfig(raw);
      } catch (e: unknown) {
        return e;
      }
      return undefined;
    })();

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('Invalid configuration');
    expect((error as Error).message).toContain(field);
  });

  it('refuses a CORS origin that is not a URL', () => {
    expect(() => parseConfig(rawConfig({ cors: { allowed_origins: ['*'] } }))).toThrow(
      /Invalid configuration/,
    );
  });

  it.each([['lowercase', 'us'], ['three letters', 'USA'], ['padded', ' US']])(
    'refuses a boot-probe country that is %s',
    (_label, country) => {
      const meld = { ...(rawConfig().meld as Record<string, unknown>) };
      meld.boot_probe = { ...(meld.boot_probe as Record<string, unknown>), country_code: country };
      expect(() => parseConfig(rawConfig({ meld }))).toThrow(/Invalid configuration/);
    },
  );

  it('refuses duplicate limits for one destination', () => {
    // Lookup would silently use the first, so the behaviour would stop matching what the
    // operator wrote.
    expect(() =>
      parseConfig(
        rawConfig({
          limits: [
            { code: 'USDC_ASSETHUB', min: '10.00', max: '20.00', currency: 'USD' },
            { code: 'USDC_ASSETHUB', min: '30.00', max: '40.00', currency: 'USD' },
          ],
        }),
      ),
    ).toThrow(/Duplicate limits for "USDC_ASSETHUB"/);
  });

  it('refuses a lowercase currency, because the request currency is upper-cased to match', () => {
    expect(() =>
      parseConfig(rawConfig({ limits: [{ code: 'USDC_ASSETHUB', min: '10.00', max: '20.00', currency: 'usd' }] })),
    ).toThrow(/Invalid configuration/);
  });

  it('rejects unknown top-level fields rather than ignoring them', () => {
    // A typo in a safety-relevant key must not be silently discarded.
    expect(() => parseConfig(rawConfig({ sesion_creation_enabled: false }))).toThrow(/Invalid configuration/);
  });

  it.each([
    ['server', { server: { port: 8080, host: '127.0.0.1', log_level: 'silent', prot: 9090 } }],
    [
      'meld',
      {
        meld: {
          base_url: 'https://api-sb.meld.io',
          api_key: { mode: 'env', var: 'K' },
          api_version: '2025-01-01',
          boot_probe: {
            destination_code: 'USDC_ASSETHUB',
            source_amount: '20',
            source_currency: 'USD',
            country_code: 'US',
            payment_method_type: 'CREDIT_DEBIT_CARD',
          },
          retries: 3,
        },
      },
    ],
    ['auth', { auth: { mode: 'insecure_dev', fallback: 'none' } }],
  ])('rejects an unknown key nested under %s', (_label, overrides) => {
    // Strictness only at the root would let a typo in a nested safety key be stripped.
    expect(() => parseConfig(rawConfig(overrides))).toThrow(/Invalid configuration/);
  });

  it('reports every problem at once', () => {
    // An operator fixing one error per restart stops reading the errors.
    const message = (() => {
      try {
        parseConfig({ environment: 'nope', server: { port: 0 } });
      } catch (error) {
        return (error as Error).message;
      }
      throw new Error('expected a throw');
    })();
    expect(message.split('\n').length).toBeGreaterThan(2);
  });

  it('has no default for the auth mode', () => {
    const raw = rawConfig() as Record<string, unknown>;
    delete raw.auth;
    expect(() => parseConfig(raw)).toThrow(/auth/);
  });
});

describe('loadConfig', () => {
  it('reads and validates a config file', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'onramp-cfg-')), 'config.json');
    await writeFile(path, JSON.stringify(rawConfig()));

    expect((await loadConfig(path)).meld.base_url).toBe('https://api-sb.meld.io');
  });
});

describe('preview origin', () => {
  const withOrigins = (origins: string[]) =>
    parseConfig(rawConfig({ cors: { allowed_origins: origins } }));

  it('accepts the preview series, whose hostname is not knowable before the deploy', () => {
    expect(() => withOrigins(['https://pr#-app.paseo'])).not.toThrow();
  });

  it.each([
    ['a glob, which is not the token', 'https://pr*-app.paseo'],
    ['no literal before the number', 'https://#-app.paseo'],
    ['the token in its own label', 'https://pr#.app.paseo'],
    ['a port, which a preview never sends', 'https://pr#-app.paseo:8443'],
    ['plaintext http', 'http://pr#-app.paseo'],
    ['a different prefix', 'https://foo#-bar.paseo'],
  ])('refuses %s, at boot rather than by matching nothing', (_label, value) => {
    expect(() => withOrigins([value])).toThrow(/origin/i);
  });

  it.each([
    ['the series it names', 'https://pr4-app.paseo', true],
    ['a multi-digit number', 'https://pr11-app.paseo', true],
    // Why the token is `#` and not `*`: a preview URL carries a number, and no pipeline deploys this.
    ['a non-numeric name', 'https://prfoo-app.paseo', false],
    ['the bare domain', 'https://app.paseo', false],
    ['a label boundary where the token sits', 'https://pr4.app.paseo', false],
    ['a domain merely prefixed by the entry', 'https://pr4-app.paseo.attacker.test', false],
    ['the other scheme', 'http://pr4-app.paseo', false],
  ])('matches %s (%s) -> %s', (_label, candidate, expected) => {
    expect(originAllowed(['https://pr#-app.paseo'], candidate)).toBe(expected);
  });

  it('leaves a literal entry, and "null", compared by equality', () => {
    expect(toOriginMatcher('https://app.dot')).toBe('https://app.dot');
    expect(toOriginMatcher('null')).toBe('null');
  });

  /** One list, two readers: CORS and the redirect guard must agree entry for entry. */
  it('gives the redirect guard the same answer it gives @fastify/cors', () => {
    const allowed = ['https://pr#-app.paseo', 'https://app.dot', 'null'];
    for (const candidate of ['https://pr4-app.paseo', 'https://app.dot', 'null', 'https://attacker.test']) {
      const viaCors = allowed
        .map(toOriginMatcher)
        .some((e) => (typeof e === 'string' ? e === candidate : e.test(candidate)));
      expect(originAllowed(allowed, candidate)).toBe(viaCors);
    }
  });
});

describe('preview origin under the desktop scheme', () => {
  const withOrigins = (origins: string[]) =>
    parseConfig(rawConfig({ cors: { allowed_origins: origins } }));

  it('accepts the series under polkadot://, the scheme the desktop host loads under', () => {
    expect(() => withOrigins(['polkadot://pr#-app.paseo'])).not.toThrow();
  });

  it.each([
    ['plaintext http, which the literal validator also refuses', 'http://pr#-app.paseo'],
    ['a scheme this service knows nothing about', 'evil://pr#-app.paseo'],
    ['the token in its own label', 'polkadot://pr#.app.paseo'],
  ])('still refuses %s', (_label, value) => {
    expect(() => withOrigins([value])).toThrow(/origin/i);
  });

  it.each([
    ['the series it names', 'polkadot://pr4-app.paseo', true],
    ['a multi-digit number', 'polkadot://pr11-app.paseo', true],
    ['a non-numeric name', 'polkadot://prfoo-app.paseo', false],
    // The scheme is part of the entry: an https preview is a different origin from a desktop one.
    ['the same host over https', 'https://pr4-app.paseo', false],
    ['a domain merely prefixed by the entry', 'polkadot://pr4-app.paseo.attacker.test', false],
    // `null` is the opaque origin a sandboxed host sends. It is its own entry, never implied by one.
    ['the opaque origin', 'null', false],
  ])('matches %s (%s) -> %s', (_label, candidate, expected) => {
    expect(originAllowed(['polkadot://pr#-app.paseo'], candidate)).toBe(expected);
  });
});

describe('preview pattern is a development-only affordance', () => {
  /** The pattern's whole point is hostnames nobody has deployed yet: fine in development, not beyond it. */
  it('accepts a pattern in development', () => {
    expect(() =>
      parseConfig(rawConfig({ cors: { allowed_origins: ['https://pr#-app.paseo'] } })),
    ).not.toThrow();
  });

  it.each([
    ['https', 'https://pr#-app.paseo'],
    ['polkadot', 'polkadot://pr#-app.paseo'],
  ])('refuses a %s pattern in production', (_scheme, entry) => {
    expect(() => parseConfig({ ...productionConfig(), cors: { allowed_origins: [entry] } })).toThrow(
      /preview-series pattern, which is refused/,
    );
  });

  it('refuses a pattern in sandbox too, not only production', () => {
    // `sandbox` serves real buyers on a sandbox rail, so it gets the production rule. Named
    // explicitly because "non-prod" and "development" are different sets and only one is correct.
    const personhood = (personhoodConfig().auth as { personhood?: Record<string, unknown> }).personhood ?? {};
    expect(() =>
      parseConfig(
        rawConfig({
          environment: 'sandbox',
          auth: { mode: 'personhood', personhood },
          meld: {
            ...(rawConfig().meld as Record<string, unknown>),
            api_key: { mode: 'file', path: '/run/secrets/meld-api-key' },
          },
          cors: { allowed_origins: ['https://pr#-app.paseo'] },
        }),
      ),
    ).toThrow(/preview-series pattern, which is refused/);
  });

  it('names the offending entry by index, so a long list is actionable', () => {
    expect(() =>
      parseConfig({
        ...productionConfig(),
        cors: { allowed_origins: ['https://app.dot', 'https://pr#-app.paseo'] },
      }),
    ).toThrow(/allowed_origins\.1/);
  });

  it('still accepts literal origins outside development', () => {
    expect(() =>
      parseConfig({ ...productionConfig(), cors: { allowed_origins: ['https://app.dot'] } }),
    ).not.toThrow();
  });
});
