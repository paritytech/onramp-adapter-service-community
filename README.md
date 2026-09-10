> [!WARNING]
> The following is a prototype, reference implementation, and proof-of-concept. This open source code is provided for research, experimentation, and developer education only. This code has not been audited, is actively experimental, and may contain bugs, vulnerabilities, or incomplete features. Use at your own risk.

Parity doesn't deploy the code but may update it based on community feedback.

If you experience problems with any product or service that was built on or deployed from this
code, you should contact the third party who deployed the code in its amended form, not Parity.

# onramp-adapter-service

A backend that holds a [Meld.io](https://meld.io) partner API key so a browser application can
buy Asset Hub tokens with a card or a bank transfer. The key never reaches a client: what crosses
the boundary is a widget URL scoped to one buyer, with the destination address and amount pinned
and locked server-side.

It serves Meld. What a deployer builds on top of it is not this service's concern.

- [docs/api.md](docs/api.md) for the routes, request and response shapes, and error codes
- [docs/configuration.md](docs/configuration.md) for every config key
- [docs/threat-model.md](docs/threat-model.md) for trust boundaries and residual risk

## Why a backend at all

Meld's key is a long-lived, account-scoped bearer credential, meant to be called from a backend
and nowhere else, and Meld whitelists no customer domains. So a product wanting server-created
Meld sessions needs one. [RFC 0025][rfc0025] prescribes this shape: the deployer runs a service
holding the credential, and what crosses to the product is a widget URL scoped to one buyer.

What that buys over redirecting a buyer to `meldcrypto.com`: a session id, so progress can be
reported at all; readable route limits, which Meld does not publish without a partner key;
server-side validation of the asset code and destination address; and control over a commercial
quota. It does not buy pinning the destination address, because a public widget URL can already
lock that.

## Requirements

- **A Meld partner API key.** Issued commercially, sandbox first, with no self-service signup.
  Without one the project builds and the suite passes against a fake Meld, but `npm start` stops
  on the unreadable secret file.
- **A People-chain RPC URL**, for the personhood handshake. The collection ids are in the example.
- **A Postgres.** `createdb onramp` is enough locally.
- **Node 22 or newer**, pinned by `package.json`'s `engines`.

No funded account, local node or wallet extension. The buyer pays Meld directly, and this service
never holds a key that can move anyone's funds.

## Which network

The shipped example points at **Paseo**, Polkadot's public test network, and the destination codes
(`DOT_ASSETHUB`, `USDC_ASSETHUB`, `USDT_ASSETHUB`) settle on Asset Hub. Nothing is pinned to
Paseo, so retargeting is a config change. Do it deliberately: a mainnet destination means a real
card charge buying real tokens.

## Running it

```sh
npm install
cp config.example.json config.json
npm run build
npm start
```

The config path is `./config.json`, overridable with `CONFIG_PATH`.

**As copied that fails**, deliberately: the example is a production-shaped template with all three
secrets mounted as files, so `npm start` stops at `Cannot read secret file
/run/secrets/meld-api-key`. A missing secret is always fatal.

For a local instance, set `environment: "development"`, `auth.mode: "insecure_dev"`, a
`meld.base_url` that is not a production endpoint, and a `store` pointing at your Postgres. Then
`echo not-a-real-key > local.key`, `export PGPASSWORD=...`, and `npm start`. In that mode callers
send an `x-dev-product-id` header instead of a bearer token, and the handshake routes do not exist.

`insecure_dev` verifies nobody: every caller of a product shares one alias, so they share a funding
scope and an idempotency namespace. Configuration refuses it anywhere but `development`.

[docs/configuration.md](docs/configuration.md) has the rest, including the personhood posture and
the rules on where each secret may come from.

## The API

Twelve routes: the authenticated Meld calls and funding reads, the two public personhood handshake
routes, the widget's return landing, and a liveness probe.
[docs/api.md](docs/api.md) is the reference.

## Testing

```sh
npm run verify          # typecheck, lint, test, build
npm run test:e2e        # against the built artefact, over a real socket
```

The unit suite needs a Postgres; see [CONTRIBUTING.md](CONTRIBUTING.md).

## Deploying it

The Helm chart is in [helm/](helm/). It renders a Deployment, a Service, an Ingress, a
NetworkPolicy and a ConfigMap holding `config.json`, with the three secrets mounted as files.

**It runs exactly one replica and cannot be scaled horizontally.** The rate limiter is in-process
and keyed on the caller's personhood alias, so a second pod gives every caller twice their ceiling
on a metered upstream quota. Raising it is a change to the limiter, not to the database. Deploys
are not an outage: `RollingUpdate` with `maxUnavailable: 0` overlaps two pods for the length of a
rollout, which doubles the allowance for that window only.

Six values are not the service's to invent, and are left empty so a chart missing one fails at
render or at boot rather than behaving as though somebody had decided. `npm run check:chart`
parses `values.yaml` and prints each one still owed.

| Value | Supplied by | What it does, and what happens without it |
| --- | --- | --- |
| `auth.personhood.people_rpc_url` | the People chain you target | The People-chain RPC the ring commitment is read from. Empty fails config parse at boot, and anything but `wss` outside `development` is refused, because over plaintext whoever is on the path decides who is a person. |
| `auth.personhood.collections` | the consumer application | The People-chain collection the ring-VRF proof is verified against. Empty fails config parse at boot, so the pod crash-loops rather than accepting unverifiable proofs. |
| `cors.allowed_origins` | the consumer application | The SPA origins allowed to call this service, and the only origins a `redirectUrl` may land on. Empty is fail-closed: every browser preflight and every redirect is refused. |
| `server.trusted_proxy_cidrs` | your cluster operator | The peer CIDRs allowed to set `X-Forwarded-For` (the ingress controller's pod CIDR). Empty reads no forwarded header, so **every** caller behind the ingress shares one rate-limit bucket; that is safe and visible, but it is not what production wants. Filling it restores per-caller buckets behind the ingress. |
| `store.authProxy.instance` | your cluster operator | `PROJECT:REGION:INSTANCE` for the Cloud SQL Auth Proxy. Empty and the proxy exits at startup, so the startup probe fails and the pod never serves. |
| `serviceAccount.annotations["iam.gke.io/gcp-service-account"]` | your cluster operator | The Workload Identity binding the proxy authenticates with. Without it the proxy starts and then cannot authenticate, and the symptom is a database error rather than an IAM one, which is why it is listed here rather than left to be discovered. |

### When it will not start

Boot is deliberately fatal on anything it cannot verify, and the message names the cause:

- `identifier must be a 32-byte hex value`: `auth.personhood.collections` is empty. Expected on a
  first deploy.
- `Secret is missing or empty`: the Meld key, the JWT signing key or the store password is not
  mounted. All three are mandatory.
- `Meld answered HTTP <status>`: the credential probe reached Meld and was rejected, so the key or
  `meld.base_url` is wrong. A Meld *transport* failure only warns, because a rollout must survive
  one.
- A database error before the port opens: the store is unreachable, or its schema is newer than
  this build supports, which happens on a rollback past a migration. Restore the database first.
- `503 ProviderTimeout` on `/api/v1/auth/redeem` while `/health` is green: the People-chain RPC is
  unreachable. A `401` there instead means it answered but the ring has no current root, which is a
  wrong collection id.

There is no `/metrics`. Diagnostics are the structured log, keyed by `request_id`, and
`GET /funding/:id` for one request's state and timeline.

### Verifying a tagged build

Image tags are `YYYYmmdd-HHMMSS-<sha8>`, published by `.github/workflows/release.yml` on a push to
`main`. `docker buildx imagetools inspect <image>:<tag>` shows the digest and the source commit, so
an operator can tie a running pod to a commit in this repository.

## What is deliberately absent

- **Webhook ingress and reconciliation.** Session status is polled through `GET /funding/:id`.
- **A second funding rail.** Chainflip is registered and refuses: it swaps on-chain assets and has
  no fiat leg, so a card purchase has no correct source asset.
- **Horizontal scaling.** The rate limiter is in-process, which pins one replica; see Deploying it.

## Before this can serve real traffic

- **The settlement join is unverified against a live Meld.** The worker finds a transaction by the
  reference the session was filed under. That contract is reported from a live sandbox but never
  re-verified here, so a request whose transaction cannot be found concludes `unobserved` rather
  than claiming the buyer did not pay.
- **`meld.api_version` has no known-good value yet.** It is required precisely so it is not guessed.
- **The jurisdiction is pinned but not locked.** Meld exposes no `lockFields` entry for the country,
  so a buyer can change it inside Meld's flow after this service pinned one. See the threat model.

## Security

> [!WARNING]
> The following is a prototype, reference implementation, and proof-of-concept. This open source code is provided for research, experimentation, and developer education only. This code has not been audited, is actively experimental, and may contain bugs, vulnerabilities, or incomplete features. Use at your own risk.

Before deploying it for real use cases, you are responsible for:

- Reviewing the code yourself, we publish a reference, not a hardened production build
- Checking that the dependencies are up to date and free of known vulnerabilities
- Securing your own fork or deployment environment (keys, secrets, network configuration)
- Tracking the latest tagged release/commits for security fixes; older releases are not backported (exceptions might apply)

For Parity's security disclosure process, and Bug Bounty program, feel free to visit: https://parity.io/bug-bounty

`onramp-adapter-service` is experimental proof-of-concept code **developed and published by Parity
Technologies**. It is **not** a Parity product or service, and Parity does **not** operate, host,
deploy, or endorse any deployment of it. Anyone who runs it does so on their own infrastructure,
under their own Meld commercial agreement, and at their own discretion.

### Where this code stands

Two properties of the current state are worth knowing before any deployment.

`auth.mode: "personhood"` is the production gate. A caller proves ring-VRF membership of the People
chain and receives a short-lived JWT before any spend. The proof context is `utf8(productId)`
(`src/personhood.ts`), so nothing in the path derives an RFC 0025 `ProductProofContext`.

`auth.mode: "insecure_dev"` performs **no caller verification** and takes the calling product's
identity from a request header. Configuration validation refuses it anywhere but `development`,
because it gives every caller of a product one alias, which means one funding scope and one
idempotency namespace shared between all of them.

The [threat model](docs/threat-model.md) states the trust boundaries, the mitigations, and, more
usefully for a researcher, the residual risks that are known and accepted. Read its residual-risk
section first, because several of the things it lists are documented gaps rather than findings.

### What is worth reporting

Report a security issue if it demonstrates realistic impact against one or more of these:

- Disclosure of the Meld API key, the JWT signing key or the CloudSQL password, or of any token
  granting direct Meld API access, by any path at all: a response body, a log line, a trace, an
  error message, or a crash dump
- **Open redirect via `redirectUrl`**, meaning any target this service accepts whose origin is not
  in `cors.allowed_origins`, or any form where the value we validate and the value we forward to
  the provider resolve to different hosts
- Bypass of caller authentication, or of the configured product allowlist
- Causing a session to be created with a destination address or amount other than the one this
  service validated and pinned
- Bypass of the destination asset-code allowlist, which exists because an unrecognised code is
  silently resolved by Meld to Bitcoin and locked
- Remote code execution in a realistic deployment
- Server-side request forgery, or any path that induces a request to a host other than the
  configured Meld endpoint

### What is not worth reporting

- Findings that require `auth.mode: "insecure_dev"`. That mode is documented above as unverified by
  design, and configuration validation refuses it anywhere but `development`.
- Missing rate limiting. Caller authentication is implemented, and so are the limits it makes
  possible (`src/caller.ts`), in two buckets. A proven caller is keyed on the contextual alias
  recovered from their People-chain ring-VRF proof, not on anything from RFC 0025, at
  `rate_limit.per_person_max` (default 120 per 60-second window). Everything with nobody proven
  behind it, meaning the two public handshake routes, an `insecure_dev` caller, and every request
  whose authentication failed, is keyed on an address bucket at the deliberately tighter
  `per_address_max` (default 30). That the alias is contextual on the product id *and* on the
  People collection, so one person's effective ceiling multiplies with
  `allowed_products.length x collections.length`, is already recorded as residual **R13** in the
  threat model.
- Webhook ingress and reconciliation. Both are deliberately absent from this version. Session
  status, by contrast, has shipped: `GET /funding` and `GET /funding/:id`.

### Reporting a vulnerability

Please do **not** open a public issue for an unfixed vulnerability. This repository carries no
security policy of its own; it inherits Parity's organisation-wide policy, which GitHub serves
from this repository's Security tab. For the disclosure process and the Bug Bounty program, visit
https://parity.io/bug-bounty.


## License

Licensed under the **GNU General Public License v3.0 or later (GPL-3.0-or-later)**. See
[LICENSE](LICENSE) for the full text. Third-party dependency licences are listed in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Copyright (C) 2026 Parity Technologies (UK) Ltd. and contributors.

[rfc0025]: https://github.com/paritytech/host-rust-core/pull/335
