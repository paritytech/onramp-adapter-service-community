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
| `meld.countries_cache_ttl_ms` | How long the country catalog (`supported/countries`) stays fresh. 60000 to 604800000, default 21600000 (6h). Meld's caching guide calls this endpoint rarely-changing and permits up to a week; the default stays under `supported.catalog_interval_ms` so the refresh pass is never served its own cached copy. |
| `meld.defaults_cache_ttl_ms` | How long a country's default fiat (`defaults/{country}`) stays fresh. 60000 to 604800000, default 21600000 (6h). Same reasoning as the country catalog. Previously uncached entirely, which cost a Meld call on every `GET /supported` and on every country of every refresh pass. |
| `meld.routes_cache_ttl_ms` | How long a discovered corridor (`supported/routes`) stays fresh. 60000 to 86400000, default 900000 (15m). Short because this is the endpoint carrying the amount limits, and it is the one that gates a charge. Must stay under `supported.routes_interval_ms`. |
| `meld.boot_probe` | The quote requested at boot to prove the key and the endpoint. Operator-supplied, because it has to be a request Meld will actually accept; `asset` must be one this service delivers to a buyer, and is sent under the code `assets` names it by. The same corridor (country, fiat, amount, method) carries the per-code check below. |
| `assets` | **Required, no default.** What Meld calls each asset, by this service's own name for it: `{ "dot@assethub": "DOT", "usdt@assethub": "USDT_DOT", "usdc@assethub": "USDC_DOT", "usdc@arbitrum": "USDC_ARBITRUM", "usdc@solana": "USDC_SOLANA", "usdt@solana": "USDT_SOLANA" }`. The only place a Meld code is written: `limits`, `meld.boot_probe` and `supported.offramp_lanes` name assets, so a Meld rename (as `DOT_ASSETHUB` became `DOT`) is one edit here and no release. The asset ids are fixed in `src/meld/catalog.ts`; an unknown id, a code that is not uppercase letters, digits and `_`, and one code for two assets are refused. An asset left out is not served. At boot every listed code is quoted in the boot probe corridor and the process refuses to start if Meld answers `400 INVALID_QUERY_PARAMETER` (an unknown code) or prices a different code; any other answer (no offers, `400 NO_VALID_QUOTES`, a 429 or a 5xx) or Meld unreachable only warns, so a Meld incident cannot keep a restart from coming back up. `GET /assets` serves the table to clients. |
| `auth.mode` | `personhood` \| `insecure_dev`. **Required, no default.** `personhood` verifies a ring-VRF proof on chain before spending the key; `insecure_dev` trusts a dev header and is refused anywhere but `development`. It gives every caller of a product the same alias, so funding rows and idempotency keys are shared between them. |
| `auth.personhood.jwt_key` | Where the JWT signing key is read from: a second `Secret`, redacted like the Meld key. Required when `mode` is `personhood`, and **at least 32 bytes**: `openssl rand -base64 32`. |
| `auth.personhood.people_rpc_url` | The People-chain RPC the register gate reads the ring commitment from. **Must be `wss` outside `development`**: this is the root of trust for personhood, and over plaintext an on-path attacker can serve a ring commitment they generated themselves. |
| `auth.personhood.collections` | The People collections a proof may open against, tried in order. Each is `{ identifier, ring_exponent }`. A **list** because personhood is not one population: full persons (`pop:polkadot.network/people`) and lite persons (`pop:polkadot.network/people-lite`) live in different collections, and pinning one silently refuses everyone in the other. The exponent rides with the collection because it is the ring domain, a property of the collection rather than of the deployment. The real ids are ASCII names **space-padded to 32 bytes**; do not trim the trailing `0x20`. |
| `auth.personhood.challenge_ttl_ms` | How long a challenge stays acceptable; the freshness that stops replay. 1000 to 300000. |
| `auth.personhood.token_ttl_s` | How long a redeemed session JWT is valid; the browser keeps it this long. 30 to 3600. |
| `limits[]` | Per `(asset, currency)`: `asset` (a deliverable asset named in `assets`, e.g. `dot@assethub`), `min`, `max`, `currency`. The Meld code the row applies to is the one `assets` names. **Optional, and no longer what decides whether a pair is buyable**: live discovery is. A row *tightens* Meld's live bound for the pair it names, so this is where a business ceiling stricter than Meld's goes; a pair with no row stays buyable at Meld's own bounds, and a row that does not overlap the live bound is refused rather than reconciled. It is also the fallback allow-list if the catalog is unreachable, where it does behave like the old hard gate; left empty, that window fails closed. A destination may appear more than once (a card buyer pays USD, a SEPA buyer EUR), but a repeated pair is refused rather than silently resolved. |
| `allowed_products[]` | Product ids permitted to spend the key. Empty means closed, not open. |
| `cors.allowed_origins[]` | Browser origins permitted to call, **and** the allowlist a caller's `redirectUrl` must match. Never a wildcard. Empty disables browser access and refuses every redirect. Accepts `polkadot://...` and the literal `null` for the app running inside the Polkadot host; see the warning below before putting `null` in a production list. |
| `rate_limit.per_person_max` | Requests per window for one proven person, who gets a bucket of their own. Default 120. |
| `rate_limit.per_address_max` | Requests per window per address, shared by everyone with no proven person behind them: the handshake routes, `insecure_dev`, and failed authentication. Default 30. |
| (CORS preflights) | Counted per address in a counter of their own, so they never spend a real request's allowance, and held to the larger of `per_person_max` and `per_address_max`: a preflight is never proven, so a lower ceiling would refuse one before a proven caller's own requests run out. |
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
| `supported.enabled` | Runs the background job that fills the `supported_corridors` table behind `GET /supported/corridors`. Off means that endpoint serves `[]` and clients fall back to per-country `GET /supported`. |
| `supported.catalog_interval_ms` | How often the catalog pass re-reads the country list and each country's default fiat. 60000 to 604800000, default 86400000 (24h). Also runs once at startup, before the first routes pass, so the routes pass always has a catalog to walk. |
| `supported.routes_interval_ms` | How often the routes pass re-reads every catalogued corridor's methods and limits. 60000 to 86400000, default 7200000 (2h). One Meld call per country per pass, the fiat already being known from the catalog. Three consecutive missed passes retire a corridor from `GET /supported/corridors`, unless no row for that crypto is fresh, when the last catalog written is served rather than none for up to a day past that window. Each pass walks one buy job per deliverable asset in `assets`, so every one added is another Meld call per country. A job whose pass writes nothing is retried on its own after a minute, then two, four and so on, until the wait reaches this interval. |
| `supported.sell_routes_interval_ms` | How often the routes pass re-reads sell corridors (every sell refresh job, including each offramp lane). 60000 to 604800000, default 43200000 (12h). Buy jobs keep `supported.routes_interval_ms`. Sell rows are retired from `GET /supported/offramp*` and `GET /supported/corridors?direction=sell` after three missed passes (3 x this value). `meld.routes_cache_ttl_ms` must stay under it. |
| `supported.offramp_lanes` | Ordered array of `{ "asset": string }` (strict, at least one), default `[{"asset": "dot@assethub"}]`; the code comes from `assets` and the chain from the asset. The sell lanes behind `GET /supported/offramp*`; where several lanes offer a payout method, the method lists every one of them in this order, each with its own limits. Each `asset` must be a known asset named in `assets`, delivered or sell-only (`usdt@solana`, `usdc@solana`, `usdc@arbitrum`), and lanes must be unique. Every lane gets a sell corridor refresh job, alongside the fixed `dot@assethub` buy and sell jobs. A sell quote or session for a code not listed is refused `RegionUnavailable`, so this list is the switch for which off-ramp routes exist: leave the Chainflip swap lanes (`usdc@arbitrum`, `usdc@solana`) out and only the direct Asset Hub sales are offered. The chart's `values.yaml` lists the direct lanes `usdt@assethub` and `dot@assethub`, with `usdc@arbitrum` and `usdc@solana` commented out; `config.example.json` lists the same two direct lanes, matching the chart, so it starts without a `sale_vault_proxy` and with no refused-lane warning. Only sellable lanes get a refresh job: Asset Hub always, `usdc@arbitrum` only with a `sale_vault_proxy` block, Solana never. Deposit addresses are validated per chain: base58 32-byte keys on Solana, `0x` plus 40 hex (stored lowercased) on Arbitrum, SS58 normalised to the Polkadot prefix on Asset Hub, and for a code the config no longer names (every retired code was Asset Hub's). |
| `worker.session_max_age_ms` | How long to keep watching a request for a payment. A **floor**, not a fallback: a longer rail expiry extends this window and a shorter one is ignored, because a rail's expiry says when its capture page closes, which is not evidence about payment. 60000 ms to 30 days, default 72h. |
| `session_creation_enabled` | Kill switch: stops session creation without a deploy. Leaves reads and the settlement worker running. |
| `sale_vault_proxy` | Optional. The Arbitrum SaleVaultProxyFactory deployment and the keeper that drives it. Absent, every Arbitrum sell answers `503 SALE_VAULT_PROXY_UNAVAILABLE` and the sale routes answer 503. |
| `sale_vault_proxy.chain_id` | The EVM chain id every keeper transaction is signed for. `42161` (Arbitrum One) or `421614` (Arbitrum Sepolia), nothing else. Production requires `42161`, and the RPC's chain id must equal `chain_id`. The payload's `chain` is always `arbitrum`, the catalog chain, with `chainId` telling the networks apart. |
| `sale_vault_proxy.factory` | The deployed SaleVaultProxyFactory, `0x` plus 40 hex, EIP-55 when mixed case, never the zero address. Its implementation is read off the factory's own `IMPLEMENTATION` immutable, so it is not configured. The chart default is the Arbitrum Sepolia deployment `0xe5ab3776f482040f81f53a1080ca48e6313ee5ab`, set `factory` for any other chain; an empty `factory` fails the render when `sale_vault_proxy.enabled`. Verified as soon as the port is open, never holding it shut: the RPC's chain id, the State Chain's `system_chain` name for that chain (`Chainflip-Berghain` for 42161, `Chainflip-Perseverance` for 421614), code at the factory and at the implementation it names, the factory's `VAULT` and `USDC` against config, USDC's `decimals()` equal to 6, the implementation's `FACTORY`, and the factory's own `predict` for a probe home and claimer equal to the off-chain CREATE2 derivation every sell address comes from. Those prove the deployment's identity, which the keeper, the sale routes and the relay need, so a later Chainflip Vault move never stops a release. Then its live window, which only new sells need: `cf_get_vault_addresses` naming the configured vault, the swap backend's `POST /api/encodeVaultSwapData` for an Arbitrum USDC to Assethub USDT return with no broker must target that vault and USDC and carry the implementation's `HOME_CHAIN`, `HOME_TOKEN` and `BROKER` (the backend fills its default broker), `MIN_RETURN` must be at least Chainflip's live floor, `MAX_RETURN` at most its live maximum swap, `RETRY_BLOCKS` at most its live `max_swap_retry_duration_blocks`, and `BROKER` a registered broker (`cf_account_info` answers role `broker` for its ss58 address under the State Chain's own `system_properties` prefix). Nothing about the route is pinned in code. A window mismatch after a Chainflip governance change only closes new sells: the keeper keeps settling, delivering and returning existing sales, which the sale routes keep serving. A mismatch or an outage never fails the boot, and `/health` answers while verification runs: the deployment stays unverified with an error or warning logged, no `saleVaultProxy` payload is served, Arbitrum sells answer 503, buys and Asset Hub sells stay up, and verification runs on the keeper's first pass, or with the keeper off on its own, then every `keeper.interval_ms` until it succeeds. |
| `sale_vault_proxy.chainflip_vault` / `.usdc` | Chainflip's Arbitrum Vault and the USDC it swaps, `0x` plus 40 hex, never the zero address. Arbitrum One: Vault `0x79001a5e762f3befc8e5871b42f6734e00498920`, USDC `0xaf88d065e77c8cc2239327c5edb3a432268e5831`. Arbitrum Sepolia (Perseverance): Vault `0x2bb150e6d4366a1bdbc4275d1f35892cd63f27e3`, USDC `0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d`. Checked against the factory's immutables at boot and against live Chainflip before new sells, as above. |
| `sale_vault_proxy.retired` | Earlier factories on the same chain, at most 8, each `{ "factory", "chainflip_vault", "usdc" }`, default `[]`, no factory listed twice or equal to `factory`, the last two the Vault and USDC that factory's immutables carry, which may differ from the current ones after a Chainflip Vault move. After a factory rotation, list the old one here: its sales are still watched by the keeper and served by `GET /offramp/sale/:id`, judged by that deployment's own verified terms, while new sells use `factory`. A retired deployment that fails verification is logged and left out, the current one is unaffected. List only a factory built from the same contract interface, since the keeper calls every deployment with the same selectors. A home-only factory (one without `GUARDIAN()`, `retired()` and the claimer-bound calls) is not served: its getters revert, verification logs it as misconfigured and leaves it out, and its proxies' `returnHome()` stays callable by anyone by hand. |
| `sale_vault_proxy.rpc_url` | The Arbitrum JSON-RPC the keeper reads and broadcasts through. https outside development. |
| `sale_vault_proxy.keeper_key` | A `secretSource` holding the keeper's 32-byte secp256k1 private key as hex. `mode: file` outside development. The key has no on-chain role: it only pays gas and picks timing (see `docs/threat-model.md`). It also pays the gas of `POST /offramp/relay`, a USDC `transferWithAuthorization` a seller claimer signed, recorded as action `relay` in `sale_vault_proxy_calls` keyed by the claimer, so one relay per claimer is in flight. The relay reads `DOMAIN_SEPARATOR()` and `TRANSFER_WITH_AUTHORIZATION_TYPEHASH()` off the configured `usdc`, and refuses to relay when the typehash is not EIP-3009's. |
| `sale_vault_proxy.keeper.enabled` | Runs the keeper loop. Default `true`. Off, the sale routes still answer and `POST /offramp/returns/:id` still acts, but `POST /offramp/relay` answers 503: only the loop settles what a relay sends, and an unsettled relay would hold its claimer in flight. |
| `sale_vault_proxy.keeper.interval_ms` | 15000 to 3600000, default 60000. The first pass runs as soon as the port opens, and a tick is skipped while a pass is in flight. Also the longest one pass reads logs before it leaves the rest to the next pass. |
| `sale_vault_proxy.keeper.batch` | Due sale rows read per pass, 1 to 200, default 25, earliest due first; each row's proxy is judged with every sale it holds, so a proxy with several due rows takes several slots. The same number caps the idle proxies past the watch window whose balance is read per pass. A sale is due when a factory log (`Delivered`, `DeliveryDeferred`, `DeliveryPending`, `DeliveryUnbooked`, `DeferredExpired`, `PendingFlushed`) names its home or a USDC transfer from anyone (a Chainflip refund, a killed return or a provider refund) reaches its proxy (read 100 watched proxies per `eth_getLogs`, under the 1000 selectors the public Arbitrum RPCs allow), when the wait it is scheduled on ends (its next return time, its release time for a balance under `MIN_RETURN`, or `keeper.resend_ms` after a reverting estimate), or every pass while a return is held back by Chainflip. A proxy with nothing to do is not polled. |
| Watch window | Not configured: a proxy is watched for the longest `STALE_DELAY` of any verified deployment after its last activity, since until then only the keeper sends it home. Activity is a factory log naming its home or a USDC transfer to it of at least the deployment's `MIN_RETURN`, recorded as `last_activity_at`, which starts at the sale's creation. A smaller transfer still makes the sale due once but never extends the window, so dust cannot keep proxies watched. Each pass also reads the USDC balance of up to `keeper.batch` proxies already past the window, longest unchecked first, and watches again any that holds at least `MIN_RETURN`, so a late refund to an expired proxy is still returned. |
| `sale_vault_proxy.keeper.resend_ms` | How long a sent call may go unmined before it is checked for a drop, 60000 to 3600000, default 600000. A call is dropped when the node no longer knows it, when another transaction used its nonce, or when it waits behind a nonce gap no call of ours holds, each only after a last receipt read. A dropped call frees the proxy and is re-sent on the next pass. The same window is how long a proxy waits after a call whose gas estimate reverts. |
| `sale_vault_proxy.keeper.log_range` | The most blocks one `eth_getLogs` spans, 100 to 30000, default 10000 (about 40 minutes of Arbitrum blocks). The cap is the public Arbitrum One and Sepolia RPCs' limit for a read with no address filter, which the `Released` read is. They allow 100000 blocks for a read naming several addresses (the factory read with a retired factory configured) and 10000000 for one address. Keep it at or under a private RPC's own limit too. |
| `sale_vault_proxy.keeper.min_skim` | USDC (at most 6 decimals), default `"5"`. The least free factory balance worth a `skim()` to the treasury. There is no release threshold: every balance is the seller's, and the keeper releases any amount the proxy's `state()` reports `releasable`. |
| `sale_vault_proxy.keeper.min_eth` | ETH (at most 18 decimals, above 0), default `"0.002"`, over 200 `deliver` calls, the keeper's costliest measured call (186753 gas, `gas.measured.deliver` in the contract's `vectors.json`), at the Arbitrum fee cap. Below it the keeper logs an error at boot and on the first pass that sees it, again after a refill; a liveness alert only. |
| `sale_vault_proxy.chainflip.rpc_url` / `.backend_url` | `backend_url` is for development only, a local fake; elsewhere the swap backend is the network's own, `https://chainflip-swap.chainflip.io` for 42161 and `https://chainflip-swap-perseverance.chainflip.io` for 421614. The State Chain RPC (`cf_get_vault_addresses` at boot and again, uncached, before each return, which is held back with `blockedReason` `vault-changed` when the live Arbitrum Vault is not the deployment's; `cf_ingress_egress_environment` and `cf_swapping_environment` before each return) and the swap backend (`/api/encodeVaultSwapData` at boot, `/v2/quote?isVaultSwap=true` before each return). A return is held back with `blockedReason` `not-swappable` below Chainflip's minimum deposit plus two refunds of the live regular network fee minimum and the live Arbitrum USDC egress fee (a smaller deposit is ignored), or above the maximum swap (the excess is confiscated, exactly the maximum swaps), and with `route-refused` when `RETRY_BLOCKS` is over the live `max_swap_retry_duration_blocks` or the broker is no longer registered (Chainflip would refund it). Each hold is logged as an error. The State Chain RPC is also polled every pass for failed Arbitrum CCM broadcasts (see below). https outside development. |
| `sale_vault_proxy.chainflip.quote_margin_bps` | 0 to 1000, default 50, a chosen buffer with no measured drift behind it. A return is sent only when the quoted egress is at least the proxy's on-chain floor plus this margin, so a return that would be killed and refunded is held back instead. The quote is net of the egress fee, so the real headroom is this margin plus that fee. |
| `sale_vault_proxy.chainflip.limits_ttl_ms` | 0 to 600000, default 30000. How long one read of Chainflip's live limits and broker registration is reused by the keeper pass, `POST /offramp/returns/:id` and verification. A failed read is never reused. The gate is at most this stale. |

The keeper is the only signer. Every transaction is signed in one in-process queue under a Postgres
advisory lock, so a second replica skips rather than racing a nonce. A pass holds the lock on one
connection and runs every query on it, and `POST /offramp/returns/:id` takes the lock on its own
connection to sign even with the keeper loop off, so `store.pool_max` must be at least 2 whenever
`sale_vault_proxy` is set. `POST /offramp/returns/:id` evaluates its sale at once and only waits for
the signing step. A call whose gas estimate reverts waits `keeper.resend_ms` before its proxy is
judged again. The keeper also settles calls a rotated key left in flight. Each call is claimed in
`sale_vault_proxy_calls` before it is signed, marked sent with its hash and nonce before the
broadcast, and settled from its receipt. Every pass, and every interval with the loop off, re-reads
the configured factory's `retired()` and Chainflip's live window, so a retire or a limit drift
closes new sells without a restart and a recovery reopens them; an outage keeps the last answer, and
each failure is logged once until it changes. A factory whose `GUARDIAN()` is the keeper key is
refused. Before each return the keeper also reads the factory's `retired()`: once retired, or once
the proxy sent `RELEASE_ATTEMPTS` returns and the contract opened release (a balance at least
`MIN_RETURN` above what the last return left, while that return's refund window
`lastReturnAt + RELEASE_DELAY` is open), it stops returning and sends `release()` to the claimer as
soon as `state()` reports it `releasable`. A balance under `MIN_RETURN` is released the same way
once `releaseAt` passes, and USDC at an undeployed proxy is deployed first. A held-back return is
logged once per proxy and reason. Before a return the keeper sizes the chunk the contract will send
(the whole balance up to `MAX_RETURN`, else a chunk that leaves nothing or at least `MIN_RETURN`)
and checks that chunk against Chainflip's live limits and quote. A gas-deferred delivery is released
with `deliver(home, ref, recipient, committed, deadline)` under the sale's own terms: the provider's
deposit address and the committed crypto amount on its funding row. The deadline is the payment
deadline the app sealed into the CCM, which the adapter never holds: the scan records every
`DeliveryDeferred` log's terms and deadline in `sale_vault_proxy_deferrals` before it saves the
range's cursor, so a range read again adds nothing, and the keeper replays each recorded deadline
whose `pendingDelivery` is still above zero, one per pass. Copies under different deadlines are
booked apart and released apart. A `DeliveryDeferred` log that cannot be decoded is logged as an
error and skipped. The contract applies the deadline, so a delivery released after it is held as
`expired` and goes home with the next return. Past the deadline a `deliver` the estimate shows would
revert (USDC paused, the proxy blacklisted) is followed in the same evaluation by
`expireDeferred(home, claimer, ref, recipient, committed, deadline)`, which moves the credit to
`pending`, where `flush` pays the proxy or, when the proxy refuses it, the claimer. The scan also
records each `Released` log of any recorded proxy, read by topic alone so a release on a proxy past
the watch window or sent by anyone counts, and each `PendingFlushed` log paid to its claimer in
`sale_vault_proxy_payouts`, keyed by transaction and log index, which `GET /offramp/sale/:id` reads.
A release also watches its proxy again. Every `Retired` log is logged as an error and makes every
proxy of that factory due and watched, idle ones included, since a retire opens every release at
once. Every `DeliveryUnbooked`, `DeliveryPending` or `DeferredExpired` log the scan reads is logged
as an error naming the factory, home, claimer, ref, amount and, for a pend, its reason: such a
delivery never pays its provider, so a CCM gas repricing or a failing proxy shows at once. The alert
fires once its range's cursor is saved, so a range read again never alerts twice, and the first pass
reads the whole watch window (from the last block stamped before it) so a log emitted before the
keeper started is alerted too. When the database records no sale of any configured factory and every
configured and retired factory verified, the first pass starts instead at the earliest block any of
them logged inside the window, or at the head when none did: with no sale recorded only a factory
log can matter, and every proxy's own logs follow its factory's `ProxyDeployed`. Each factory's
first log comes from one-address `eth_getLogs` reads with no topic, the first spanning the whole
window and each refused or timed-out one halving the span down to `log_range`, so it needs no
archive state (the public Arbitrum RPCs keep code history only for recent blocks) and no deploy
block in config. The search shares the pass's `keeper.interval_ms` budget, and when that runs out or
a read at `log_range` still fails, a warning is logged and the pass scans from the window start
instead, saving its cursor range by range. A saved cursor is never moved by this. One pass reads
`log_range` ranges for at most `keeper.interval_ms` and, while it stopped short of the head, the
next pass starts at once from the cursor, so a long catch-up (a database with sales and no cursor
reads the whole watch window, `STALE_DELAY` after its last activity) re-checks a retire and
Chainflip's window, which close new sells, as often as an idle keeper does. Every `Unattributed` log
(USDC or another token the factory could not book to a home: wrong token, a message of the wrong
length, a zero home, a zero or dirty claimer word) is logged as an error the same way, naming the
factory, token, amount, reason and block range, since a skim sends it to the treasury.

Each pass also reads `ArbitrumIngressEgress.FailedForeignChainCalls` for the current epoch
(`cf_current_epoch`, then `state_getStorage`) and fetches each entry's signed payload with
`cf_failed_call_arbitrum`. A payload that calls the Vault's `executexSwapAndCall` with one of our
factories (current or retired) as receiver is logged once per broadcast and epoch as an error naming
the broadcast id, amount, token, home and claimer (for a 192-byte sale message), the Vault to send
it to and the epoch it expires at (two past the one it first failed in). Until someone sends that
payload the sale's USDC stays in Chainflip's Vault. The keeper does not resubmit it: send `data` to
`contract` from any funded account before expiry.

Lanes the runtime refuses never fail the boot. A Solana entry in `supported.offramp_lanes`, or
`usdc@arbitrum` listed without `sale_vault_proxy`, only logs a warning at startup; every sell path
(`/supported/offramp*`, `/quote`, `/session`) refuses them at runtime.

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
- a `meld.boot_probe.asset` that is not a deliverable asset, so the probe would report
  "credentials accepted" for a corridor this deployment does not serve;
- a missing `assets` block, an unknown asset id in it, a malformed code, one code for two assets,
  or a `limits`, `meld.boot_probe` or `supported.offramp_lanes` entry naming an asset `assets`
  gives no code;
- an unknown or never-delivered asset in `limits`, duplicate limits for one `(asset, currency)`
  pair, an inverted `min`/`max`, or a non-uppercase currency;
- `store.ssl: false` outside development when `store.host` is not loopback;
- a `sale_vault_proxy` address that is zero or mixed case with a bad EIP-55 checksum, a factory
  listed twice, a plaintext `rpc_url` or `chainflip.rpc_url` outside development, a `keeper.min_eth`
  of 0, or an env-mode `keeper_key` outside development;
- a `sale_vault_proxy.chain_id` other than 42161 or 421614, or other than 42161 in production;
- outside development, any `chainflip.backend_url`, or a `chainflip.rpc_url` host that names
  `perseverance` on 42161 or does not on 421614;
- `store.pool_max` below 2 while `sale_vault_proxy` is set;
- a keeper key that is not 32 bytes of hex;
- any of the three credentials, or `sale_vault_proxy.keeper_key`, sourced from the environment
  outside development;
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
