# Contributing

## Licence and conduct

Licensed under **GPL-3.0-or-later**. By contributing you agree your contributions are licensed
under the same terms. This repository follows the
[Parity Code of Conduct](https://github.com/paritytech/polkadot-sdk/blob/master/docs/contributor/CODE_OF_CONDUCT.md).

## Setup

**You need a Postgres.** The store's suite runs against a real one, because what it asserts
(`ON CONFLICT` arbitrating an idempotency key between concurrent reservations, `FOR UPDATE SKIP
LOCKED` leasing a row, `pg_advisory_lock` serialising two booting replicas) is behaviour an
emulator would answer from a lookup table. Everything else uses in-memory fakes.

```sh
createdb onramp_test
# or: export ONRAMP_TEST_PG=postgres://user:pass@host:5432/onramp_test

npm install
npm run verify         # typecheck, lint, test, build
npm run test:e2e       # spawns the built artefact and talks to it over a socket
npm run check:chart    # renders the chart and parses the config it produces
npm run test:watch
```

`check:chart` shells out to `helm`, so it needs `helm` on `PATH`, and it reads `dist/`, so build
first. Without a Meld sandbox key the suite runs against a fake Meld and `npm start` fails the
boot credential probe, which is the design.

## The gates

Every PR must pass these four. Three have a local equivalent worth running first.

| Gate | Command | What it catches |
| --- | --- | --- |
| `verify` | `npm run verify` | won't compile, won't lint, or a test regressed. Needs a Postgres |
| `e2e` | `npm run test:e2e` | the units pass but the built artefact does not start, serve or stop |
| `chart` | `npm run check:chart` | the chart does not render, or renders a config this service refuses |
| `secrets` | CI only (gitleaks) | a key committed at any point in the history |

CI runs on pull requests and on pushes to `main`, which is what images publish from.

## Rules this repo enforces

- **No `Co-Authored-By` lines in commit messages.** They fail the paritytech org's CLA check.
- **Docs travel in the same PR as the code.** A change to a route, config key, threshold or
  response shape is not complete until the doc naming it is updated.
- **Strict schemas.** Request and config schemas are `strict()`: an unexpected field is refused,
  never stripped. Do not loosen this to tolerate a caller's extra field.
- **No `console.log`.** Route and service code logs through Fastify's request logger, which carries
  a request id, and the audit record goes through `AuditLog`. The one `console.error` in
  `src/main.ts` is deliberate: it reports a startup failure before a logger exists.
- **A missing or empty secret is fatal at boot, and must stay fatal.** Never add a default path, a
  placeholder or a fallback. `src/secret.ts` is the one resolution path.
- **`auth.mode: "personhood"` must fail at boot when its verifier is absent**, never per request,
  so an unverified mode cannot look like a verified one. `insecure_dev` is refused in `production`,
  and `auth.personhood.jwt_key` must clear a 32-byte floor.
- **The Meld base URL travels with the key reference in the same config object**, so a sandbox key
  cannot be paired with the production endpoint by editing one field.

## Branching and PRs

1. Branch off `main`, one concern per PR. Prefer several small PRs over one large one.
2. Run the gates above locally.
3. Open the PR using the template, fill the checklist, and link the issue it closes or addresses.
4. Keep a change to a route, config key or response shape backed by the doc update in the same PR.
5. Squash merge once review is done and the branch is up to date with `main`.

## Labels

Issues and pull requests share one label pool. New issues get `needs-triage`, and a maintainer
then applies the type, area, and priority labels.

## Open work

- A **webhook receiver** for `TRANSACTION_CRYPTO_*`. Deferred: Meld's webhook auth is undocumented.
- A **sandbox key from Meld**, the only thing between "built against a fake" and "verified against
  a live Meld".

## Reporting a vulnerability

Do **not** open a public issue for an unfixed vulnerability. Follow [SECURITY.md](SECURITY.md) and
report through the [Polkadot Security Hub](https://security.parity.io/). What is worth reporting is
in the README's [Security](README.md#security) section. For the disclosure process and the Bug
Bounty program: https://parity.io/bug-bounty.
