# HTTP API

Every route, its request and response shape, and the errors it returns.
See [README.md](../README.md) for what the service is and how to run it.

Eight routes are authenticated by the short-lived JWT the handshake mints: `POST /quote`,
`POST /session`, `GET /supported`, `GET /supported/countries`, `GET /funding`, `GET /funding/:id`,
`POST /funding/:id/cancel` and `GET /transaction/:id`. The unauthenticated remainder is
`GET /health`, `GET /meld/return` and the two handshake routes.

| Endpoint | Proxies | Purpose |
| --- | --- | --- |
| `POST /api/v1/auth/challenge` | none | Mints a fresh 56-byte blind challenge. No auth, rate-limited. |
| `POST /api/v1/auth/redeem` | none | Exchanges a challenge + ring-VRF proof for a short-lived JWT. Verifies against the People-chain commitment. |
| `GET /supported/countries` | `GET /network-partner/supported/countries` | The region dropdown: every country Meld on-ramps, name-sorted. Read **unkeyed**, so it is deliberately wider than what this account can deliver; whether a country actually routes is answered per selection by `GET /supported`. |
| `GET /supported` | `GET /network-partner/supported/routes/...` | The payment methods and fiat min/max for one `(country, destination)`, with the country's default fiat resolved first (`/network-partner/defaults/...`). Empty `methods` means the corridor is not served here. The provider roster is dropped on the way out, because this service never names a provider. |
| `POST /quote` | `POST /payments/crypto/quote` | Offers with the full fee breakdown. |
| `POST /session` | `POST /crypto/session/widget` | Returns the widget URL to open, and persists a durable funding request. |
| `GET /transaction/:id` | `GET /payments/transactions/{id}` | Status, projected onto the five fields this service declares. |
| `GET /funding` | `?includeRefused=true` | The caller's open and past funding requests, newest first, capped at 100. **Locally refused requests are excluded by default**: `GET /supported` publishes Meld's live bound but not the tightening a `limits` row applies, so being refused is still how a caller learns the *effective* minimum, and a hundred of them would push the request the buyer is waiting on out of the window. |
| `GET /funding/:id` | none | One funding request's status + timeline + terms. |
| `POST /funding/:id/cancel` | none | Withdraw a request the buyer no longer wants. Takes away the settlement surface; **does not conclude the request**, so a payment already in flight is still observed and still settles. Refused once a payment has been seen. Idempotent. |
| `GET /health` | none | Liveness. No auth. |
| `GET /meld/return` | none | The completion page the widget redirects to, served from this origin so it frames cleanly. Carries no status and needs no auth; the caller's own `GET /funding/:id` poll stays authoritative. |

The discovery pair is proxied rather than left to the client because a keyed read is scoped to the
providers this account has onboarded, which is the set `POST /quote` will price, so the catalog
never advertises a corridor the quote would refuse. The country list is read unkeyed on purpose:
keyed, a buyer whose country the account cannot serve gets no row and no explanation.

## Bounds a caller will meet

- Request body limit **16 KiB**. Whole request and idle connection bounded by
  `server.request_timeout_ms`.
- CORS allows **`GET` and `POST` only**, against an allowlist. Never a wildcard: any page could
  otherwise spend the operator's Meld quota from a visitor's browser. An empty allowlist disables
  browser access entirely.
- `GET /funding` returns at most **100 rows**, newest first, and does not page.
- Rate limited per proven person where one exists (`per_person_max`, default 120) and per calling
  address otherwise (`per_address_max`, default 30), with a `429` carrying `retry-after`.
  `/health` is exempt, so a throttled instance cannot be declared dead.
- The per-person alias is contextual on the product id and on the People collection, so the
  effective ceiling is `per_person_max x allowed_products.length x collections.length`. See
  threat model R13.
- Every authenticated call carries `Authorization: Bearer <JWT>`. `Meld-Version` is added
  server-side, and the Meld key never reaches a client.

Field names are the caller's, which are mostly Meld's: `country`, `fiat`,
`destinationCurrencyCode`, `sourceAmount`, `paymentMethodType`. Operator configuration stays
snake_case.

## `POST /quote`

**Source-denominated**, because Meld's quote endpoint is source-only: this asks what 21.47 USD
buys, not what 20 USDC costs. A consumer thinking in destination amounts works backwards itself.

`sourceAmount` is a decimal string with at most two fraction digits. `rail` is optional
(`meld` | `chainflip`, default `meld`); `chainflip` refuses, having no fiat leg. **Everything else
is required, `paymentMethodType` included**: the corridor resolves per
`(country, fiat, destination, method)`, so a quote for an unoffered method is a price nobody can
pay. Omitting it is a local `MALFORMED_REQUEST`, before any upstream call.

```json
{
  "country": "US",
  "fiat": "USD",
  "destinationCurrencyCode": "USDC_ASSETHUB",
  "sourceAmount": "21.47",
  "paymentMethodType": "CREDIT_DEBIT_CARD"
}
```

`200 OK`, with every fee component intact, because the deposit over-estimation only closes if the
breakdown is complete:

```json
{
  "quotes": [
    {
      "serviceProvider": "TRANSAK",
      "sourceAmount": "21.47",
      "sourceCurrencyCode": "USD",
      "destinationAmount": "20",
      "destinationCurrencyCode": "USDC_ASSETHUB",
      "exchangeRate": "0.9315",
      "totalFee": "1.47",
      "transactionFee": "0.19",
      "networkFee": "0.28",
      "partnerFee": "1.00"
    }
  ],
  "requested": { "destinationCurrencyCode": "USDC_ASSETHUB", "sourceAmount": "21.47", "fiat": "USD" }
}
```

**Every amount is a decimal string carrying Meld's exact digits.** Meld may send a fee as a bare
JSON number, and a double round-trip is not identity: `20.00` returns as `20`, `0.0000001` as
`1e-7`, and anything past 2^53 loses digits. Numbers in unnamed fields are stringified too, since
a proxy cannot tell which unknown field is money.

Amount bounds are not applied here. A quote is price discovery, and a buyer settling on an amount
may legitimately ask about one they then adjust; `POST /session` enforces them where the charge is
committed.

## `POST /session`

The destination, address and amount are sent **locked**. Meld locks through a `lockFields` array
on `sessionData`, not per-field `*Locked` booleans, which are silently ignored. Six fields are
sent locked: `cryptoCurrency`, `destinationCurrencyCode`, `walletAddress`, `sourceAmount`,
`sourceCurrencyCode`, `paymentMethodType`.

**`country` is echoed, not locked.** Meld exposes no `lockFields` entry for it, so a buyer who
changes jurisdiction inside Meld's flow is not stopped here. `pinned` records what was committed,
not necessarily what the buyer transacted under. See threat model R11.

```json
{
  "idempotencyKey": "<caller-prefix>-<uuid-v4>",
  "country": "US",
  "fiat": "USD",
  "destinationCurrencyCode": "USDC_ASSETHUB",
  "sourceAmount": "21.47",
  "walletAddress": "15oF4uVJwmo4TdGW7VfQxNLavjCXviqxT9S1MgbjMNHr6Sp5",
  "paymentMethodType": "CREDIT_DEBIT_CARD",
  "serviceProvider": "TRANSAK",
  "redirectUrl": "https://app.example/purchase/done"
}
```

`serviceProvider` is **required**: Meld refuses an absent one exactly as it refuses a null one, so
"let Meld choose" is not offered. Pick one from `POST /quote`.

`idempotencyKey` is **8 to 200 characters**, enforced by a unique index per
`(caller, product, key)`, so a repeat replays the first session rather than opening a second, and
a retry arriving mid-open gets `409 REQUEST_IN_FLIGHT`. It must survive a page reload. It is not
what Meld is told: the upstream reference is the funding record's own id, because the caller's key
is unique only per (caller, product) while Meld's namespace is global.

`redirectUrl` is optional and checked twice, being the one caller-supplied value a browser follows
right after a card is charged: the scheme must be `https:` (checked on the parsed protocol, since
`z.url()` accepts `javascript:` and `data:`), and the **origin** must be in
`cors.allowed_origins`. Compared on the parsed origin, not as a substring, so
`https://app.example.attacker.test` and `https://app.example@attacker.test` are both refused.
Rejected as `REDIRECT_NOT_ALLOWED`, locally.

`201 Created`:

```json
{
  "sessionId": "0f2b8c1e-...",
  "fundingRequestId": "3f1a9c04-8e2b-4d77-9a10-1c5b7e0d2f43",
  "serviceProviderWidgetUrl": "https://global.transak.com/?apiKey=...",
  "widgetUrl": "https://meldcrypto.com/?sessionId=...",
  "expiresAt": 1800000000000,
  "pinned": {
    "destinationCurrencyCode": "USDC_ASSETHUB",
    "walletAddress": "15oF4uVJwmo4TdGW7VfQxNLavjCXviqxT9S1MgbjMNHr6Sp5",
    "sourceAmount": "21.47",
    "fiat": "USD",
    "country": "US"
  }
}
```

`serviceProviderWidgetUrl` is the provider's capture page, always present. `widgetUrl` is Meld's
own hosted widget for the session, present only when Meld returns one; a product embedding Meld's
UI opens that one. `expiresAt` is absent when Meld supplies none.

`fundingRequestId` is this service's durable handle, the id a caller polls `GET /funding/:id` with.
Meld's `sessionId` is kept alongside for an operator's Meld-side support conversation.

## `GET /transaction/:id`

Projects Meld's transaction onto exactly five declared fields (`id`, `status`, `sourceAmount`,
`destinationAmount`, `serviceProvider`) under a `transaction` key. `status` is Meld's own opaque
string: the vocabulary is not documented anywhere readable, so an enum would reject real values.

## `POST /api/v1/auth/challenge` and `POST /api/v1/auth/redeem`

The personhood handshake, present only in `personhood` mode. Neither route is authenticated, and
both are rate limited per address, the only key that exists before a proof. In `insecure_dev` they
do not exist, and a 404 reads as "personhood not configured" rather than "verified and refused".

`challenge` mints a fresh **56-byte blind challenge** (base64url): nonce, issued-at, and their
HMAC, so it is self-authenticating and carries its own recency. The ring proof binds to its bytes,
so a proof recorded against an earlier challenge cannot be replayed.

```json
{ "challenge": "<base64url, 56 bytes>" }
```

`redeem` exchanges that challenge plus a ring-VRF proof for a short-lived HS256 JWT:

```json
{
  "challenge": "<base64url, from /challenge>",
  "proof": "<base64url ring-VRF proof>",
  "ring": 0,
  "productId": "another-product.example"
}
```

A stale or inauthentic challenge is rejected first. Then the ring's current `Root` commitment is
read off the People chain (`people_rpc_url`) and the proof verified against it here, never on a
client's word. A valid proof recovers the caller's contextual **alias**, which the JWT binds as
`sub`, with the product as `aud` and a TTL of `token_ttl_s`.

```json
{ "token": "eyJ...", "expiresAtMs": 1800000000000 }
```

## `POST /funding/:id/cancel`

**Cancelling withdraws the payment surface without concluding the request.** `cancelled_at` is a
column, not a ninth state, and that matters: a terminal row leaves the worker's scan, so a
transfer sent moments before the cancel would never be observed. The status is untouched, the
worker keeps watching, and a cancelled request can still reach `settled`.

Refused as `REQUEST_NOT_CANCELLABLE` in two cases, and the message says which: once the request is
`transaction_seen`, because a buyer whose money is in flight must not be told it is cancelled; and
once it has concluded, because there is nothing left to withdraw.

404 for an unknown id and for another caller's alike, so it is not an existence oracle.
Idempotent: a second cancel returns the row with the original timestamp. Both outcomes are
audited, as `session.cancelled` and `session.cancel_refused`, the latter carrying the status that
refused it.

## `GET /funding` and `GET /funding/:id`

The funding surface, so a caller can show open and past funding after the page that started them is
closed. `GET /funding` returns the caller's requests newest first; `GET /funding/:id` returns one.
Both are scoped by the caller's alias, and `GET /funding/:id` answers **404** for an unknown id and
for another caller's alike.

`GET /funding/:id` answers `{ "funding": ... }` and `GET /funding` answers
`{ "fundingRequests": [ ... ] }`. The object in both:

```json
{
  "id": "3f1a9c04-8e2b-4d77-9a10-1c5b7e0d2f43",
  "rail": "meld",
  "status": "transaction_seen",
  "providerStatus": "PENDING",
  "destinationCurrencyCode": "USDC_ASSETHUB",
  "walletAddress": "15oF4u...",
  "sourceAmount": "21.47",
  "fiat": "USD",
  "createdAt": 1800000000000,
  "updatedAt": 1800000000100,
  "history": [
    { "status": "session_opened", "at": 1800000000000 },
    { "status": "transaction_seen", "at": 1800000000100 }
  ]
}
```

`status` is this service's lifecycle, not Meld's: `created` -> `session_opened` ->
`transaction_seen` -> `settled` / `failed`, plus `expired` (the rail answered and no payment
existed), `unobserved` (the rail stopped being askable) and `refused` (declined locally, or read
and definitively rejected by a rail; the `reason` column tells those apart).

**`expired` and `unobserved` are not the same claim.** The first is about the buyer: the rail was
asked and answered, nothing was there. The second is about this service: the lookup stopped
working, so whether the buyer paid is unknown. Only an answering rail produces `expired`.

`providerStatus` is the rail's own status string, absent until the rail has reported one. It is
there for distinctions `status` drops, such as a Meld `REFUNDED` against a plain failure. It is the
status as of the last state change rather than a live value, because the rail's status is persisted
only on a transition, so do not read it as the provider's current state. Its vocabulary belongs to
the rail and is not part of this contract.

`cancelledAt` is present only on a withdrawn request, and is how a resumed client tells "still
waiting for your payment" from "you cancelled this". It is not a status: a cancelled request whose
status is still live is not a contradiction.

The settlement surface (`serviceProviderWidgetUrl`, `widgetUrl`, `expiresAt`) is carried only while
the request is non-terminal, the rail's expiry has not passed, and the caller has not cancelled, so
a buyer who closed the tab can be sent back. A dead capture page would invite a second payment. No
Meld session or transaction id is carried: those are internal join keys.

## Durable funding

`POST /session` writes a row to Postgres (CloudSQL; the schema is versioned and migrated under an
advisory lock, so two booting replicas cannot race it) and the funding reads read it back. The row
is reserved **before** the rail is called, so the unique index arbitrates the idempotency key
rather than a check-then-act race. An in-process worker advances the lifecycle.

Two bounds keep that loop from becoming a standing cost:

- A reservation the rail never answered ages out as `unobserved` **and keeps the caller's key**.
  The row predates the rail call, so it may already have an open settlement surface; freeing the
  key would let a retry open a second one. The retry meets `REQUEST_OUTCOME_UNKNOWN`.
- A `transaction_seen` request stops being polled once its observation window passes. Meld's
  status vocabulary is undocumented, so anything unrecognised maps back to `transaction_seen`, and
  without a bound a transaction stuck on `PENDING` would be re-fetched every tick for ever. It
  concludes as `unobserved`, not `expired`, because a payment was seen.

Three consecutive per-record failures end a tick, because a fault repeating across unrelated rows
is the rail or the query, not the row.

## Errors

Every failure returns the same body, and only ever an enumerated outcome:

```json
{ "error": { "tag": "BelowMinimum" }, "request_id": "9f1c..." }
```

Tags are a subset of the host's [`FundingFailure`][funding], so a client classifies them without
holding any part of the operator's configuration. No rule text, jurisdiction logic or upstream
payload crosses to a client; operator detail goes to the log under the same `request_id`. One
deliberate exception: a `BelowMinimum` / `AboveMaximum` refusal carries the effective bound as
`value: { amount, currency }`, because a buyer who cannot see the minimum cannot act on it.

| Status | Tag | Meaning |
| --- | --- | --- |
| 400 | `WrongAssetOrChain` | Destination code is not one this service delivers. |
| 400 | `Other{ REDIRECT_NOT_ALLOWED }` | The redirect target's origin is not in `cors.allowed_origins`. |
| 409 | `Other{ IDEMPOTENCY_KEY_REUSED }` | The idempotency key was first used for a different request. Mint a new key. |
| 409 | `Other{ REQUEST_SURFACE_EXPIRED }` | The rail's payment page for that request has closed, but the request has **not** concluded: a transfer may still be in flight, and the worker is still watching. Do **not** start another: poll `GET /funding/:id` and act on the conclusion when it arrives. Cleared by the worker concluding the row, so a stopped worker leaves a caller on this code indefinitely. |
| 409 | `Other{ REQUEST_CANCELLED }` | The key belongs to a request the caller withdrew. Nothing was paid and starting again is safe, with a new key. A transfer already in flight when it was cancelled can still settle against the old request, so this is not a promise that nothing will arrive. |
| 409 | `Other{ REQUEST_NOT_CANCELLABLE }` | `POST /funding/:id/cancel` on a request that cannot be withdrawn: a payment is already on its way for it, or it has already concluded. |
| 409 | `Other{ REQUEST_CONCLUDED }` | The key belongs to a request that ended as `expired` or `failed`: the rail answered and nothing was paid. Start a new one with a new key. (`refused` shares this code but never reaches the path: a refused row holds no key.) |
| 409 | `Other{ REQUEST_ALREADY_SETTLED }` | The key belongs to a request the buyer **already paid**. Do not start another for it. Split out of `REQUEST_CONCLUDED` because a client cannot act on one code for both: told "start a new one" after a settled purchase, it opens a second payable surface for money already taken. |
| 409 | `Other{ REQUEST_OUTCOME_UNKNOWN }` | The key belongs to a request that concluded as `unobserved`: we stopped being able to ask the rail and never learned whether the buyer paid. Distinct from **both** other 409 conclusions: `REQUEST_CONCLUDED` says it finished and nothing was paid, `REQUEST_ALREADY_SETTLED` says it finished and *was* paid, this one says nobody knows which. Starting a new request means accepting the risk of paying twice. |
| 400 | `RegionUnavailable` | A real destination this deployment has not configured. |
| 400 | `BelowMinimum` / `AboveMaximum` | Outside the effective fiat bounds: Meld's live corridor bound, tightened by a `limits` row when one names that pair. |
| 400 | `Other{ CORRIDOR_UNAVAILABLE }` | A configured `limits` row does not overlap the live corridor bound, so this deployment cannot serve the corridor within its own limits. Refused rather than widened to the upstream bound. |
| 400 | `Other{ INVALID_ADDRESS }` | Address failed to decode, or is not a 32-byte account. |
| 400 | `Other{ CURRENCY_UNSUPPORTED }` | Not the configured currency for that destination. |
| 400 | `Other{ PAYMENT_METHOD_UNSUPPORTED }` | The live corridor for this `(country, fiat, destination)` does not offer the requested `paymentMethodType`. Ask `GET /supported` for the ones it does. Not retryable as sent. |
| 400 | `Other{ MALFORMED_REQUEST }` | Body did not parse, named an unexpected field, or a field failed its bounds. **Which field is in the log against this `request_id`, never in the body**, so an integrator debugging a 400 needs the server's log line and not just the response. |
| 401 | `Other{ UNAUTHORIZED }` | Caller not verified. |
| 400 | `RouteWithdrawn` | The operator has disabled session creation. |
| 400 | `Other{ UNKNOWN_RAIL }` | A rail this build knows but this deployment has not wired. |
| 400 | `Other{ PROVIDER_REJECTED }` | Meld understood the request and declined it, for a reason not enumerated above. Not retryable. |
| 400 | `Other{ RAIL_REFUSED }` | The Chainflip rail refuses **session creation**: it swaps on-chain assets and has no fiat leg. Not retryable. (Its quote leg answers `422 NoQuotesAvailable`.) |
| 409 | `Other{ REQUEST_IN_FLIGHT }` | Another request is already opening a session under this idempotency key. Well-formed; retry shortly. |
| 404 | `Other{ NOT_FOUND }` | No such route, or no such funding request *for this caller*. |
| 422 | `NoQuotesAvailable` | Meld served the corridor but had no offers, or the rail cannot quote at all. |
| 429 | `Other{ RATE_LIMITED }` | Past the ceiling for this person, or for this address when no person is proven. `retry-after` says when. |
| 500 | `Other{ INTERNAL }` | An unhandled failure. The detail is in the log against this `request_id`; the body never carries it. |
| 503 | `ProviderTimeout` | Meld did not answer, or the People chain did not answer a `/redeem`, or answered with a non-400 error status. |

Every `409` refuses because a request already exists, and each carries that request's id as
`fundingRequestId` inside `Other`'s value. It turns "do not start another" into something the
caller can follow. Minting a fresh key instead is the one response that opens a second settlement
surface.

### Unknown `Other` codes must halt, never retry

Part of the contract, not advice. The `code` inside `Other` is an open string that will grow:
`REQUEST_ALREADY_SETTLED` was split out of `REQUEST_CONCLUDED` precisely because one code could
not carry two opposite instructions. A client treating an unrecognised code as "start a new one"
re-introduces that defect on the next split, and on a `409` the defect is a second payable surface
for money already taken.

```
if (code === 'REQUEST_CONCLUDED') startNewIntent();   // the only code that authorises a retry
else                              surfaceToBuyer();   // everything else, known or not
```

A Meld **5xx** becomes `503 ProviderTimeout` rather than a 500: a buyer cannot act on "the
operator's key is wrong". A Meld **400** stays a 4xx, because Meld understood the request and
declined it, and retrying cannot fix that.

[funding]: https://github.com/paritytech/host-rust-core/pull/339
