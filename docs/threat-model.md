# Threat model

For a security review. The [residual risk](#5-residual-risk) section is the one worth reading
first, because it lists what an attacker can still do.

**Status.** Prototype, not externally audited. Caller authentication is the shipped personhood
gate: a caller proves current membership of the People ring against the chain's commitment and
receives a short-lived JWT that authenticates the protected routes. `insecure_dev` authenticates
nothing and is refused outside `development`. See R1 and R3 for what that does not cover.

## 1. What is being protected

One asset: the **Meld partner API key**, a long-lived account-scoped bearer credential. Anyone
holding it can create sessions, read every transaction on the operator's account, and spend the
metered quota. Meld issues it by hand, so a compromise is expensive to recover from.

Secondary: the operator's Meld quota; the integrity of a session's terms (asset, address, amount);
the audit trail; and the **funding store**, which holds per request a per-person alias, the
destination address, the fiat amount and a lifecycle timeline. R17 covers it.

The service holds no user funds, card data, KYC data or user keys. It signs nothing and custodies
nothing. That is not the same as holding nothing: the store is a record of who bought what, for how
much, and where it was sent.

## 2. Trust boundaries

```
  Untrusted                    | Trusted (this service)        | Third party
  -----------------------------+-------------------------------+---------------------
  Browser application          |  validate -> call Meld        |  Meld API
  (public, untrusted)          |  key resolved from a file     |  -> Transak / Koywe
                               |                               |
  everything it sends is       |  the key never crosses        |  outside our control;
  attacker-controlled          |  leftward                     |  see R7
```

Everything from the browser is attacker-controlled: headers, body fields, path parameters, origin.
The operator is trusted for configuration and for the secret files.

## 3. Threats considered

| # | Threat | Mitigation |
| --- | --- | --- |
| T1 | Key disclosed in a response body | Errors carry an enumerated tag and a request id: no schema message, no stack, no upstream payload. All three places a failure becomes a response emit the same body. One exception: a below/above-minimum refusal forwards the threshold Meld named, because a buyer who cannot see the minimum cannot act on it. Successful responses are narrower than "never forwarded": `/quote` forwards Meld's body, `/transaction/:id` is projected onto five fields. A non-2xx body is discarded before any parse, so the paths that could carry an auth error back are the ones that drop it. |
| T2 | Key disclosed in a log, trace or serialised error | Three secrets (Meld key, JWT signing key, store password), each wrapped in a type whose `toString`, `toJSON` and `util.inspect` return `[redacted]`. Reading one requires `expose()`, at four call sites. Asserted through the real pino sink, not in isolation. A caller's `authorization` header never reaches a log line, because Fastify's serializer emits only method, url, host and remote address. |
| T3 | Key disclosed via the repository or an image | Never in the repo, an image or a default path. `gitleaks` scans full history in CI. A missing secret mount is fatal at boot rather than resolving to a placeholder. |
| T4 | Buyer funds sent to the wrong asset | Meld silently resolves an unrecognised destination code to **Bitcoin** and locks the buyer into it. Codes are validated against a frozen catalog and unknowns refused; adding one is a code change with a test. |
| T5 | Buyer funds sent to a malformed address | Addresses are decoded, asserted to be 32 bytes, and re-encoded to SS58 prefix 0. SS58 also permits 1, 2, 4, 8 and 33-byte payloads, so a valid checksum is not proof of an account. |
| T6 | Buyer walked onto a different asset, address or amount inside Meld | Six fields are sent in Meld's `lockFields` array. Per-field `*Locked` booleans are silently ignored. `country` is **not** lockable and is only echoed, so a change of jurisdiction inside Meld's flow is not stopped; see R11. |
| T7 | Server-side request forgery | The upstream base URL is configuration, host-pinned per environment (T12). No caller-supplied value reaches an upstream URL, method or header. The one path parameter is schema-bounded and `encodeURIComponent`-escaped; the length bound matters, because escaping cannot constrain an empty value and an empty id would collapse onto Meld's collection path. The client sets `redirect: 'error'`, since a Meld call has no legitimate redirect. |
| T8 | Request-body injection into the upstream call | Schemas are strict: an unexpected field is refused, not stripped. Body limit 16 KiB. One qualification: zod strips an own `__proto__` key rather than reporting it, so for that name the refusal comes from Fastify's `secure-json-parse`, a dependency default rather than this service's. |
| T9 | Quota exhaustion | Per-caller rate limit with `retry-after`, per-destination amount ceilings, and a kill switch that stops session creation without a deploy. |
| T9b | Connection exhaustion by a slow client | Whole-request and connection timeouts, set above the upstream timeout so a merely slow Meld call still reports honestly. Body limit 16 KiB. |
| T10 | Any web page spending the quota from a visitor's browser | CORS is an explicit origin allowlist, never a wildcard, credentials disabled. An empty allowlist disables browser access entirely. |
| T11 | Starting with a wrong or wrong-environment key | Boot performs a real authenticated Meld call, and any HTTP error status is fatal. A `200` that cannot be parsed is not: it degrades like a transport failure, so a captive proxy passes the probe. A transport failure is tolerated so a rollout survives an outage. |
| T12 | Key sent to the wrong host or environment | The base URL's host is pinned by name: `production` requires `api.meld.io` over https, `sandbox` requires `api-sb.meld.io`, `development` may point anywhere except the production endpoint. Userinfo and a path prefix are both refused, because `https://api.meld.io@attacker.example` and a silently-discarded path each receive `Authorization: BASIC <key>`. |
| T13 | Configuration mistake causing silent misbehaviour | The schema is strict at every level; unknown keys are refused. No defaults for anything deciding safety. Inverted limits, duplicate destinations and non-canonical currencies refuse to boot, and every problem is reported at once. |
| T14 | Duplicate charge from a retry or double-tap | Creating a session moves no money, so nothing here can produce a second charge. The caller's `idempotencyKey` is enforced by a unique index per `(subject_alias, product_id, client_reference)`: a repeat replays the first session and a concurrent retry gets `409 REQUEST_IN_FLIGHT`. What Meld is told is the funding record's own id, because the caller's key is unique only per (caller, product) while Meld's namespace is global. A row that never opened a session keeps the key and concludes `unobserved`, so a crash-orphaned reservation holds a buyer's intent for up to `worker.session_max_age_ms`. |
| T15 | Development posture reaching production | `insecure_dev` is refused outside `development`, sandbox included, and logs a warning naming itself at boot. See R15. |
| T16 | PII or card data in logs | None is handled. The audit record carries the caller alias, the pinned terms and Meld's session id: no account, no address history, no card detail. |
| T17 | A recorded proof replayed to open a fresh token | The challenge must verify as authentic and unexpired before the chain read, and the proof's `message` binding is the challenge bytes, so a proof captured against one challenge validates against no other. See R14 for what this does not close. |
| T18 | A proof aimed at a foreign ring, or a caller-shrunk proof domain | The collection is fixed at configuration and the request only declares `ring` within it. The ring exponent is a config constant, never caller-supplied. A ring with no current `Root` is refused as `UnknownRing`, and a `Root` shorter than the 768-byte commitment is refused rather than truncated, since `subarray` shortens without complaining. |
| T18b | The JWT signing key weak enough to brute-force offline | A 32-byte floor, refused at boot below it. HKDF expands it into the challenge MAC key and the HS256 token key without creating entropy, and `jose` will sign HS256 with a single byte, so a short mount would leave the gate brute-forceable from one captured token and forged `sub`/`aud` claims readable. |
| T19 | The proof proves something other than a distinct, stable person | Verifying against the chain commitment proves current ring membership. The recovered alias is stable per person, unlinkable to any account, and is the only per-person key, so it is what rate limiting and audit key on. |
| T20 | Buyer landed on an attacker page immediately after payment | `redirectUrl` is the one caller-supplied value a browser follows, at the worst moment. The schema refuses any scheme that is not `http:`/`https:`, because `z.url()` constrains shape and not scheme. The https floor is `config.ts` refusing a plaintext entry in `cors.allowed_origins` outside development. `Onramp` then requires the parsed origin to be in that list and forwards the parse's own `href`, so a prefix host, userinfo, a subdomain, a registrable parent, and forms the WHATWG and RFC-3986 parsers read differently are each refused or neutralised. |

## 4. Deployment assumptions

The service does not provide these and will not warn if they are missing:

- **TLS terminated in front of it.** Nothing here is safe in plaintext.
- **Secret files** outside the image, mode `0400`, owned by the non-root runtime user. The chart
  enforces that shape: secrets are file references only, mounted read-only with `optional: false`.
- **Egress restricted** to the configured Meld host and the People RPC. Nothing in the process
  enforces it. The chart can (`networkPolicy.enabled`), but it is off by default and needs peer
  CIDRs only a cluster operator can supply. Without it, T7 and T18 rest on the in-process controls
  alone.
- **Log shipping and retention**, since the audit trail is a log. See R6.
- **Process isolation.** See R5.

## 5. Residual risk

What this does not protect, ordered by how much it should worry a reviewer.

**R1: the distinct-person stake rests entirely on the ring proof and the chain's transcript.** A
caller proves current membership by a ring-VRF proof validated against the published
`Members.Root`. If that commitment is wrong, or the RPC serving it is not the chain, the gate is
wrong with it. Hence the `wss` requirement.

**R2: the destination address is pinned, not verified.** The service holds constant whatever it is
given and cannot know the buyer controls it. A compromised client can name any address, and the
outcome is real money at an address nobody watches. Fixing this needs a signed intent from
whatever mints the address.

**R3: rate limiting splits at the subject, and is closed for the protected routes.** The handshake
routes are keyed on address, per instance, at the tighter `per_address_max` (default 30), to bound
proof-verification cost rather than accommodate a session. Once proven, both the audit trail and
the bucket key on the recovered alias, which the caller cannot vary.

**R3b: the address bucket is cheap to churn.** `caller.ts` groups IPv6 by `/64`, so a `/48` yields
65,536 buckets rather than billions, and `limit-store.ts` holds person and address counters in
separate LRUs (50,000 and 10,000) so address churn cannot evict a proven person's allowance.

**R4: a Meld error status reaches clients as retryable.** A key revoked mid-life surfaces as `503`
rather than an alarm. Boot catches a wrong key; a change after boot is visible only in the log.

**R5: Node cannot erase a string from memory.** The Meld key must become a string to reach the
`BASIC` header, and strings are immutable and garbage-collected. T2 prevents accidental
disclosure; a memory-disclosure primitive in the process defeats it.

**R6: the audit trail has no delivery guarantee.** It is a log line. A dropped record is gone.
That is the accepted cost of not running a database for one table.

**R7: Meld's own security posture is out of scope.** A compromise at Meld, Transak or Koywe is not
defended here and cannot be. The service also cannot verify funds arrived, and makes no settlement
claim.

**R7b: one unauthenticated request buys one outbound WebSocket.** `/api/v1/auth/redeem` is public
and reaches a People-chain read after a MAC check and an allowlist test, and each call opens a
fresh socket. File descriptors and memory exhaust long before bandwidth does.

**R8: the two keys rotate differently.** The Meld key is outbound with one correct value at a
time, so rotation costs a restart. The JWT key is inbound and only one key verifies, so rotating
it invalidates every token already minted.

**R9: denial of service is coarsely bounded.** The rate limit, request timeout and body limit make
one caller expensive, but they are per instance with no connection-count ceiling. What the router
rejects before the request lifecycle begins is not counted at all, though it allocates a request
id and one log line, touches no store and makes no upstream call.

**R10: two Meld details are unverified, and they fail differently.** A wrong `meld.api_version`
fails loudly at boot, because the probe sends it. The **settlement join** does not: the probe is a
quote, so it never exercises the transaction search. A wrong join field is discovered by nobody,
and the request concludes `unobserved` rather than claiming the buyer did not pay.

**R11: the amount is locked; the jurisdiction is not.** Six fields reach Meld locked, so the
configured bounds bind the charge and not merely the request. `country` is echoed in `pinned` but
Meld exposes no lock for it under any name, so a buyer can change jurisdiction inside Meld's flow
after this service pinned one. `pinned` records what was committed, not what the buyer transacted
under.

**R12: `/transaction/:id` is authenticated but not scoped to the caller.** A verified person
holding a Meld transaction id can read that transaction. A row does acquire
`provider_transaction_id` once observed, but it is absent for every transaction the worker has not
seen, which is the window a caller polls in. Bounded rather than silent: it needs a current
person in the ring, and Meld ids are high-entropy.

**R13: a person holds one bucket and one funding scope per allowed product, and per collection.**
The alias is contextual on the product id, so one human proving against two allowed products
recovers two aliases legitimately. Membership of more than one People collection adds a second
multiplier, so the bound is `allowed_products.length x collections.length`.

**R14: a captured `(challenge, proof)` pair replays until the challenge expires.** A challenge is
deliberately not consumed on redemption, so anyone obtaining one redeem body can re-mint tokens as
that person for the remaining `challenge_ttl_ms`. T17 stops a proof being reused against a
*different* challenge; it does not stop the same body being replayed.

**R15: `insecure_dev` collapses funding-data scoping, not only the rate-limit bucket.** Every
caller of a product shares the alias `dev:<productId>`, and funding rows scope on
`(subject_alias, product_id)`, so one caller's `GET /funding` returns another's addresses and
amounts. Refused anywhere but `development`.

**R16: a transaction seen but never concluded ends as `unobserved`.** Terminal, so the row leaves
the scan, and honest, because it claims only that the worker stopped looking. `expired` would
assert the buyer did not pay.

**R17: the funding store is durable, unencrypted state, and a protected asset.** It holds a
per-person alias, the destination address, the fiat amount and a timeline. Encryption at rest is
the platform's, not this service's. Refused rows are pruned after
`worker.refusal_retention_days`; a buyer's purchase history is kept indefinitely, which is
deliberate and remains the open half.

**R18: the rate limiter is in-process, which is the only thing pinning one replica.** It is keyed
on the caller's alias and held in the pod, so N replicas serve N independent allowances and
multiply every caller's ceiling. The store no longer objects; the limiter does.

**R19: product identity is caller-asserted, and cannot be otherwise.** `productId` is a request
field, filtered by `allowed_products`, then bound into the proof context and carried as the JWT
`aud`. Any person in the ring may redeem for any allowed product. **The service authenticates the
person, never the application.**

**R20: the store link may be plaintext across the cluster network.** Some platforms run the Cloud
SQL Auth Proxy as its own Deployment rather than as a sidecar. If yours is one of them, the hop
from this pod to the proxy is pod-to-pod over the cluster network rather than loopback, and
`store.plaintext_link: "in-cluster-proxy"` is the operator asserting that hop is acceptable.

## 6. Out of scope

Volumetric denial of service, TLS termination, the platform's encryption at rest, and the security
of Meld and the providers behind it.
