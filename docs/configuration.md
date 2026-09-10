# Configuration

Every key the service reads, what it does, and what happens without it.
See [README.md](../README.md) for what the service is and how to run it.


JSON, validated in full at startup. **The whole schema is strict at every level** and there are
no defaults for anything that decides safety: a service that boots with a plausible default is
a service that runs in production with a development posture. See
[`config.example.json`](../config.example.json).

| Field | Notes |
| --- | --- |
| `environment` | `development` \| `sandbox` \| `production`. Makes dangerous combinations detectable. |
| `server.port` / `.host` | `host` defaults to `0.0.0.0`. |
| `server.log_level` | `silent` ... `debug`, default `info`. `silent` for tests, or when shipping logs elsewhere. |
| `server.request_timeout_ms` | Ceiling on a whole request, not just the upstream hop. Default 20000. |
| `server.trusted_proxy_cidrs` | Which peers may set `X-Forwarded-For`, as CIDRs or bare addresses. Empty by default, which reads no forwarded header and buckets every caller on the socket address. Decides whether the address-keyed rate limit (the handshake routes, and any caller with no proven person behind them) is per caller or per service. Replaced `trusted_proxy_hops`: a hop count cannot validate the immediate peer, so on its own it trusted whoever connected. See below. |
| `meld.base_url` | Travels in the same object as the key reference, so a sandbox key cannot be paired with the production endpoint by editing one field. |
| `meld.api_key` | `{ "mode": "file", "path": ... }` or `{ "mode": "env", "var": ... }`. |
| `meld.api_version` | Sent as `Meld-Version` on every call. Required; Meld pins behaviour to it. |
| `meld.timeout_ms` | 500 to 30000, default 8000. |
| `meld.discovery_scope` | `account` (default) reads the corridor catalog with the key, so only providers this account has enabled appear. `global` reads it unkeyed and is correct only where the account has every provider enabled: a mismatch advertises corridors the quote will then refuse. |
| `meld.supported_cache_ttl_ms` | How long a discovered corridor or country catalog stays fresh. 60000 to 86400000, default 3600000. |
| `meld.boot_probe` | The quote requested at boot to prove the key and the endpoint. Operator-supplied, because it has to be a request Meld will actually accept; `destination_code` must be one this service delivers, since Meld resolves an unknown one to Bitcoin rather than refusing it. |
| `auth.mode` | `personhood` \| `insecure_dev`. **Required, no default.** `personhood` verifies a ring-VRF proof on chain before spending the key; `insecure_dev` trusts a dev header and is refused anywhere but `development`. It gives every caller of a product the same alias, so funding rows and idempotency keys are shared between them. |
| `auth.personhood.jwt_key` | Where the JWT signing key is read from: a second `Secret`, redacted like the Meld key. Required when `mode` is `personhood`, and **at least 32 bytes**: `openssl rand -base64 32`. |
| `auth.personhood.people_rpc_url` | The People-chain RPC the register gate reads the ring commitment from. **Must be `wss` outside `development`**: this is the root of trust for personhood, and over plaintext an on-path attacker can serve a ring commitment they generated themselves. |
| `auth.personhood.collections` | The People collections a proof may open against, tried in order. Each is `{ identifier, ring_exponent }`. A **list** because personhood is not one population: full persons (`pop:polkadot.network/people`) and lite persons (`pop:polkadot.network/people-lite`) live in different collections, and pinning one silently refuses everyone in the other. The exponent rides with the collection because it is the ring domain, a property of the collection rather than of the deployment. The real ids are ASCII names **space-padded to 32 bytes**; do not trim the trailing `0x20`. |
| `auth.personhood.challenge_ttl_ms` | How long a challenge stays acceptable; the freshness that stops replay. 1000 to 300000. |
| `auth.personhood.token_ttl_s` | How long a redeemed session JWT is valid; the browser keeps it this long. 30 to 3600. |
| `limits[]` | Per `(destination, currency)`: `code`, `min`, `max`, `currency`. **Optional, and no longer what decides whether a pair is buyable**: live discovery is. A row *tightens* Meld's live bound for the pair it names, so this is where a business ceiling stricter than Meld's goes; a pair with no row stays buyable at Meld's own bounds, and a row that does not overlap the live bound is refused rather than reconciled. It is also the fallback allow-list if the catalog is unreachable, where it does behave like the old hard gate; left empty, that window fails closed. A destination may appear more than once (a card buyer pays USD, a SEPA buyer EUR), but a repeated pair is refused rather than silently resolved. |
| `allowed_products[]` | Product ids permitted to spend the key. Empty means closed, not open. |
| `cors.allowed_origins[]` | Browser origins permitted to call, **and** the allowlist a caller's `redirectUrl` must match. Never a wildcard. Empty disables browser access and refuses every redirect. Accepts `polkadot://...` and the literal `null` for the app running inside the Polkadot host; see the warning below before putting `null` in a production list. |
| `rate_limit.per_person_max` | Requests per window for one proven person, who gets a bucket of their own. Default 120. |
| `rate_limit.per_address_max` | Requests per window per address, shared by everyone with no proven person behind them: the handshake routes, `insecure_dev`, and failed authentication. Default 30. |
| `rate_limit.window_seconds` | The window both allowances are counted over. Default 60. A config carrying the retired `rate_limit.max` is refused at boot rather than reinterpreted. |
| `store.host` / `store.port` | The Postgres endpoint. `127.0.0.1` is the Cloud SQL Auth Proxy sidecar; a private IP reaches the instance directly. Port defaults to 5432. |
| `store.database` / `store.user` | **Required, no defaults**: a funding history that silently never persists is worse than a boot failure. |
| `store.password` | A `secretSource`, like the Meld key and the JWT key: `mode: file` outside development, where `mode: env` is refused. |
| `store.ssl` | Default `true`. Refused as `false` outside development **unless `store.host` is loopback**: the Auth Proxy terminates TLS itself and speaks plaintext over a hop that never leaves the pod. |
| `store.schema` | Optional Postgres schema; a bare identifier. Omitted means `public`. |
| `store.pool_max` | Connections per replica, default 10. This process serves HTTP *and* runs the worker against one pool, so a pool the worker can saturate starves request handlers. |
| `store.statement_timeout_ms` / `store.connection_timeout_ms` | Defaults 10000 and 5000. **Not exposed by the chart**: neither appears in `helm/values.yaml` or the rendered ConfigMap, so every deployment gets the code default. The migration clears the statement timeout for its own connection; a real `ALTER TABLE` outlasts it. |
| `worker.interval_ms` | How often the settlement worker ticks. 1000 to 300000, default 15000. |
| `worker.refusal_retention_days` | How long a locally refused row is kept before the worker deletes it. 1 to 3650, default 90. Only refusals: every other terminal state records something that reached a payment rail, and a buyer's purchase history is not expired. |
| `worker.enabled` | Runs the settlement worker. It is also not started when no rail can observe a transaction, whatever this says. |
| `worker.session_max_age_ms` | How long to keep watching a request for a payment. A **floor**, not a fallback: a longer rail expiry extends this window and a shorter one is ignored, because a rail's expiry says when its capture page closes, which is not evidence about payment. 60000 ms to 30 days, default 72h. |
| `session_creation_enabled` | Kill switch: stops session creation without a deploy. Leaves reads and the settlement worker running. |

> **`null` in `allowed_origins` is close to "any origin". Keep it out of production unless you
> have checked the two conditions below.**
>
> The opaque origin is sent by any sandboxed iframe and any `data:` URL, so any site can produce
> it. It is on the accepted list because the app runs inside the Polkadot host, which presents
> either `polkadot://...` or, sandboxed, `null`. Without it the one caller this service exists
> to serve cannot clear preflight.
>
> It is safe here for two reasons, and both are gates rather than intentions. This service sets no
> CORS `credentials` and uses no cookies, so a `null`-origin page cannot ride a session it does not
> have (`server.ts`, asserted by `server.test.ts` and `server-personhood.test.ts`). And every route
> that spends or reads a caller sits behind the personhood gate, so the JWT must be presented in an
> `Authorization` header the attacking page cannot forge. What a `null` origin can reach is the
> unauthenticated set (`/health`, the challenge mint, and `/meld/return`), none of which discloses
> anything.
>
> Adding `credentials` while `null` is listed turns this into a cross-origin read of authenticated
> responses. Two tests fail if anyone tries; do not delete them to make the change pass.

Startup refuses to boot on any of these, and reports every problem at once, because an operator
fixing one error per restart stops reading the errors:

- `auth.mode: "insecure_dev"` when `environment` is anything but `development`;
- a secret with `"mode": "env"` when `environment` is anything but `development`: an
  environment variable is readable from the process table and echoed by a pod spec, which is
  what the file mount exists to avoid;
- `auth.mode: "personhood"` with no `auth.personhood` block, because the mode that claims to
  verify a caller must have the verifier;
- an `auth.personhood.jwt_key` shorter than 32 bytes, an empty `collections` list, a collection
  `identifier` that is not 32 bytes of hex, a duplicate identifier, or a `ring_exponent` outside
  `9 | 10 | 14`;
- `auth.personhood.people_rpc_url` that is not `wss` outside `development`: over plaintext an
  on-path attacker serves a ring commitment they generated themselves, and the personhood gate
  verifies against it;
- a `meld.base_url` whose host is not this environment's pinned Meld host, or that is not https,
  or that carries userinfo (`https://api.meld.io@attacker.example`) or a path;
- a `meld.boot_probe.destination_code` outside the catalog: Meld resolves an unrecognised
  destination to **Bitcoin** rather than refusing it, so a typo made the probe report "credentials
  accepted" for a corridor this deployment does not serve;
- an unknown destination code in `limits`, duplicate limits for one `(destination, currency)`
  pair, an inverted `min`/`max`, or a non-uppercase currency;
- `store.ssl: false` outside development when `store.host` is not loopback;
- any of the three credentials sourced from the environment outside development;
- a `store.schema` that is not a bare Postgres identifier;
- a funding schema version that is not exactly the one this build expects, in either direction;
- a missing or empty secret file, and any unknown key at any nesting level.


## The API key


**A mounted file is the default and the only mode required.** It is the one mechanism every
deployment target has: Kubernetes, ECS, Docker, docker-compose, a VM with systemd. Storing
ciphertext in a database was considered and rejected: without a KMS the key that decrypts it
must be readable unattended, so it lives in a file, which is where the API key could have lived
to begin with. That moves the secret and leaves the lock beside it.

Requirements: outside the image, `0400`, owned by the non-root runtime user, and **no default
path or placeholder baked in**, because a missing mount must stop the process rather than resolve to
something we shipped.

**Rotation: replace the file contents, restart.** There is no version state machine, because
this is an *outbound* credential: exactly one value is correct at a time and we are the only
party presenting it, so the overlap window an inbound credential needs does not exist.

In process the key lives in a type whose `toString`, `toJSON` and `inspect` hooks all return
`[redacted]`, and reading it requires calling `expose()`, which is greppable, so *"where is the
key used"* has an exact answer. There are three secrets (the Meld key, the JWT signing key and the
CloudSQL password) and four `expose()` call sites: one in the Meld client, two in `startup`'s HKDF
derivation, and one where the store builds its pool.

> [!NOTE]
> Node cannot erase a string. `Buffer` contents can be overwritten, but the value must become a
> string to reach an HTTP header, and strings are immutable and GC-managed. This guards against
> *accidental disclosure* (logging, serialising, inspecting) and relies on process isolation
> for the rest. Stated plainly rather than implying a guarantee that does not exist.

**The JWT signing key is a second, separate secret** with its own rotation model. It is redacted
in exactly the same way as the Meld key and never reaches a client, but the bearer tokens it signs
are an *inbound* credential (the opposite of the Meld key's outbound shape), so rotation *should*
keep the previous key verifying for one token TTL. **That overlap is designed and not built.**
Only one key verifies today, so rotating it invalidates every token minted under the previous one
and every browser mid-purchase must re-run the handshake. The short TTL (`token_ttl_s`) is what
bounds the damage; see [Before this can serve real traffic](../README.md#before-this-can-serve-real-traffic).
Re-vetting a token's `aud` against the *current* `allowed_products` on every check does work, so
dropping a product from config revokes its tokens within one TTL.

**The JWT signing key must be at least 32 bytes**, refused at boot below that. HKDF expands it into
both the challenge MAC key and the HS256 token key without creating entropy that was not there,
and `jose` will sign HS256 with a single byte. So a short mount leaves the whole personhood gate
brute-forceable offline from one captured token. Generate one with `openssl rand -base64 32`.
