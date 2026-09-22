# HTTP API

Every route, its request and response shape, and the errors it returns.
See [README.md](../README.md) for what the service is and how to run it.

Nine routes are authenticated by the short-lived JWT the handshake mints: `POST /quote`,
`POST /session`, `GET /supported`, `GET /supported/countries`, `GET /supported/corridors`,
`GET /funding`, `GET /funding/:id`, `POST /funding/:id/cancel` and `GET /transaction/:id`. The
unauthenticated remainder is `GET /health`, `GET /meld/return` and the two handshake routes.

| Endpoint | Proxies | Purpose |
| --- | --- | --- |
| `POST /api/v1/auth/challenge` | none | Mints a fresh 56-byte blind challenge. No auth, rate-limited. |
| `POST /api/v1/auth/redeem` | none | Exchanges a challenge + ring-VRF proof for a short-lived JWT. Verifies against the People-chain commitment. |
| `GET /supported/countries` | `GET /network-partner/supported/countries` | The region dropdown: every country Meld on-ramps, name-sorted. Read **unkeyed**, so it is deliberately wider than what this account can deliver; whether a country actually routes is answered per selection by `GET /supported`. |
| `GET /supported` | `GET /network-partner/supported/routes/...` | The payment methods and fiat min/max for one `(country, destination)`, with the country's default fiat resolved first (`/network-partner/defaults/...`). Empty `methods` means the corridor is not served here. The provider roster is dropped on the way out, because this service never names a provider. |
| `GET /supported/corridors` | none (reads a background cache) | Every deliverable corridor for one `destinationCurrencyCode` in one payload: `{corridors: [{country, name, fiat, methods}]}`. Served from the `supported_corridors` table a background job refreshes from Meld, so the read is off Meld and off any per-country fan-out. Stale rows (not refreshed within three routes passes) and a cold cache return `[]`, which the client falls back from. DOT-scoped in v1. **A browse surface, not a charge gate:** its `methods` bounds can be up to three refresh passes old, so re-read `GET /supported` for the selected country before validating an amount. Meld's caching guide says the same about the `supported/routes` data underneath it, and the charge gate reads that endpoint live rather than this table. |
| `POST /quote` | `POST /payments/crypto/quote` | Offers with the full fee breakdown. |
| `POST /session` | `POST /crypto/session/widget` | Returns the widget URL to open, and persists a durable funding request. |
| `GET /transaction/:id` | `GET /payments/transactions/{id}` | Status, projected onto the five fields this service declares. |
| `GET /funding` | `?includeRefused=true` | The caller's open and past funding requests, newest first, capped at 100. **Locally refused requests are excluded by default**: `GET /supported` publishes Meld's live bound but not the tightening a `limits` row applies, so being refused is still how a caller learns the *effective* minimum, and a hundred of them would push the request the buyer is waiting on out of the window. |
| `GET /funding/:id` | none | One funding request's status + timeline + terms, and, on a live sell whose provider has disclosed one, the deposit address, amount and currency to send to. |
| `POST /funding/:id/cancel` | none | Withdraw a request the buyer no longer wants. Takes away the settlement surface; **does not conclude the request**, so a payment already in flight is still observed and still settles. Refused once a payment has been seen, or, on a sell, once a deposit address has been disclosed. Idempotent. |
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

## `direction`: buy and sell

`POST /quote` and `POST /session` both take an optional `direction`, `"buy"` or `"sell"`.
**Absent means `buy`**, so a caller written before sell existed is unchanged, byte for byte, in
both request and response.

**`destinationCurrencyCode` names the crypto leg and `fiat` names the fiat leg in both
directions.** On a sell the crypto is what the seller sends, so `destinationCurrencyCode` reads
backwards. It is deliberate: one vocabulary across the surface, and no translation layer to be
wrong about which currency an amount is in.

The amount is the field that changes, and it is a different field rather than the same one
reinterpreted:

| | buy | sell |
| --- | --- | --- |
| amount field | `sourceAmount`, the fiat charged | `cryptoAmount`, the crypto sold |
| format | decimal, at most **2** fraction digits | exact decimal, kept as a string end to end and never rounded or parsed; **this service accepts** up to 30 fraction digits (see the note below on what the provider has been observed to accept) |
| `walletAddress` | **required** on `/session` | **refused**: the provider issues the deposit address after the session exists |

**What "30 fraction digits" is and is not a promise about.** 30 is this service's own accepted
bound, chosen to be wider than any asset's precision so that nothing is ever silently truncated on
the way through — the value is stored and forwarded as the exact string you send and is never
parsed into a number anywhere. It is **not** a statement about what the provider will accept or
honour. The provider has been observed echoing 18 fraction digits back verbatim, with no
truncation, rounding or exponent — but that was observed on BTC and ETH, and **the precision the
provider applies to the Asset Hub assets this service delivers has not been observed at all**,
because no onboarded provider currently off-ramps them. Send your asset's natural precision (DOT
has 10; Asset Hub USDC and USDT have 6). A value finer than the provider's own precision may be
rounded by it, and on a sell the amount you commit is the amount you will be expected to send
on-chain, so a rounding difference there is a payout that does not complete.

`cryptoAmount` must be greater than zero: `"0"` and `"0.00000000"` are refused. On a sell there
is no amount gate behind this one (the corridor's published limits are fiat while the committed
amount is crypto), so this is the only check a zero meets.

**The amount string is the identity, not the number it denotes.** The idempotency comparison is
exact string equality, so `"1.5"` and `"1.50"` are *different requests*: a client that reuses a
key but reformats the amount on retry gets `409 IDEMPOTENCY_KEY_REUSED`, not a replay. That is
deliberate, and it is the safe direction to fail — the alternative is parsing two spellings into
one number and handing back a settlement surface committed to the other one. Send the same
bytes on a retry that you sent the first time.

The wrong combination is **refused, not ignored**: a sell carrying `sourceAmount` or
`walletAddress`, a buy carrying `cryptoAmount`, or either direction missing its own amount, is a
local `400 MALFORMED_REQUEST` before any upstream call.

**The Meld rail serves a sell.** Chainflip still refuses one with
`400 Other{ DIRECTION_UNSUPPORTED }`, permanently: it has no fiat leg to pay a seller from, and no
amount of waiting changes that.

### What a sell does not get, and what stands in for it

**No local amount gate.** A buy's minimum and maximum come from the live corridor catalog,
tightened by a configured `limits` row, and both are **fiat**. A sell commits crypto, so there is
no local bound to compare it against that would mean anything — comparing a DOT figure to a GBP
bound in minor units is a number, not a check. So a sell's amount meets exactly two local checks:
its shape, and that it is greater than zero.

The bound that does apply is the **provider's**, enforced when Meld is called, and it is
crypto-denominated. It comes back as the same `BelowMinimum` / `AboveMaximum` tags a buy would get
locally — but **without a `value`**. On a buy that tag carries `{ amount, currency }` in fiat; on a
sell the provider states the threshold in crypto ("minimum sell amount ... 0.00011648 BTC") and the
failure type has nowhere to say which kind of currency a threshold is in, so putting a crypto
figure in the field every other producer fills with fiat would be a specific false statement rather
than a missing one. A sell that is out of bounds therefore gets the correct tag and no number. The
figure is in the operator's log against the `request_id`.

Two practical consequences: a sell is refused for being out of bounds **upstream, not locally**, so
it costs one provider call to find out; and a client cannot render "the minimum is X" on a sell.

### The deposit address

Once the seller clears KYC in the provider's widget, Meld issues a deposit address on the
transaction record and this service's worker reads it back on a later poll -- the address does not
exist at session creation and can arrive minutes to hours afterwards. `GET /funding/:id` then
carries a `deposit` object (`address`, `amount`, `currency`, `memo` if the asset needs one, and
`observedAt`); see `GET /funding/:id` below for the exact shape and its disclosure rule.

**Written once a rail discloses it, never rewritten -- but a disagreement does not freeze the row.**
If a rail ever reports a *different* address for a row that already has one, or one that does not
decode as an account at all, the stored address is never overwritten: the seller was shown that one
and may already have sent to it, and there is no safe way to pick a winner from here. The
disagreement is recorded (not thrown away), and an operator can find it on the row rather than
grepping logs for it. What changed from the first version of this behaviour: a conflicting
disclosure used to roll back the *entire* advance it arrived with, which meant a provider that kept
disclosing a wrong address could also stop a row that would otherwise correctly settle or fail from
ever concluding. It no longer does -- the conflict is recorded, and a real, unrelated state move
riding alongside it still applies. Each new disagreement is still logged loudly, at its own level.

**Cancelling is refused once an address has been disclosed.** See `POST /funding/:id/cancel` below.

**What remains unverified.** No sandbox sell has ever reached the point of having a transaction, let
alone a disclosed address (DOT_ASSETHUB is not sellable on the account this was built against).
Specifically unverified: the status at which Meld first discloses an address; whether the amount
this service reads (the transaction's top-level `sourceAmount`, sibling of `cryptoDetails`) is in
fact the right field, though it is already this service's name for a sell's crypto leg everywhere
else on this surface; and whether any asset this service delivers needs the `memo` field, which no
observed schema has a candidate for at all. None of this has been exercised against a real off-ramp
corridor, only against the fake store and the unit suite.

**The `sourceAmount` choice is a documented guess, not a confirmed fact, and treating it as
confirmed is an operational decision, not merely a code comment someone might not read.** Before
this service enables an off-ramp corridor for real money -- DOT_ASSETHUB or any other asset -- the
amount this endpoint discloses to a seller must be confirmed against at least one real, settled
sandbox sell for that asset. Until that confirmation happens, going live is going live on a guess
about which field carries the figure a seller is told to expect, for the single most
safety-critical value this service hands out. This is a release gate, to be checked off before
`GET /supported*` (or any other switch) is turned on for a sell corridor, not a fact that reading
`meld/rail.ts` is sufficient to establish.

Off-ramp corridor discovery (`GET /supported*` answers on-ramp corridors only) remains a later
step.

## `POST /quote`

**Source-denominated**, because Meld's quote endpoint is source-only: this asks what 21.47 USD
buys, not what 20 USDC costs. A consumer thinking in destination amounts works backwards itself.

`sourceAmount` is a decimal string with at most two fraction digits (on a sell it is
`cryptoAmount` instead; see `direction` above). `rail` is optional (`meld` | `chainflip`, default
`meld`); `chainflip` refuses, having no fiat leg. **Everything else is required,
`paymentMethodType` included**: the corridor resolves per
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

A sell is priced from the crypto and the echo says so, carrying `cryptoAmount` where a buy carries
`sourceAmount`. The key that is present is the discriminator; there is no `direction` in the echo,
because the amount already names the direction and a second statement of it could disagree with the
first.

```json
{
  "quotes": [ /* ... */ ],
  "requested": { "destinationCurrencyCode": "DOT_ASSETHUB", "cryptoAmount": "12.3456789012", "fiat": "GBP" }
}
```

**A sell's offers carry the fee breakdown in the payout fiat, deducted from the destination, not
the source.** That is inverted from a buy: a buy's `sourceAmountWithoutFees` is populated and the
fees come off what the buyer pays; a sell's is `null`, `destinationAmountWithoutFees` is populated,
and the fees come off what the seller receives (`631.88 - 12.58 = 619.30`). `exchangeRate` is
fiat-per-crypto rather than destination-per-source. The offers are forwarded exactly as the provider
sent them, so any code assuming "fees are in the same currency as `sourceAmount`" is wrong on a
sell.

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

**On a sell, the same six fields are sent and accepted — and that is all this service claims.**
The pinning above is a statement about a buy, established by probing the provider's behaviour. That
probing has **not** been repeated for a sell, and the evidence available does not substitute for it:
the provider exposes no way to read a session back, and its session endpoint accepts unknown and
meaningless fields with a `200`, so acceptance of a lock proves only that the name is spelled
correctly. What can be said is that the vocabulary is identical in both directions (there is no
seventh, sell-specific lockable field), and that on a sell the inversion puts the two terms that
most need pinning — the crypto amount and the payout method — onto `sourceAmount` and
`paymentMethodType`, which are among the six. **Whether any of them is enforced on a sell has not
been observed.** Treat `pinned` on a sell as a record of what this service committed, not as a
guarantee about what the provider's widget will allow.

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

A sell sends the same body with `direction: "sell"`, `cryptoAmount` in place of `sourceAmount`,
and no `walletAddress`:

```json
{
  "idempotencyKey": "<caller-prefix>-<uuid-v4>",
  "direction": "sell",
  "country": "GB",
  "fiat": "GBP",
  "destinationCurrencyCode": "DOT_ASSETHUB",
  "cryptoAmount": "12.3456789012",
  "paymentMethodType": "PAYOUT_TO_BANK",
  "serviceProvider": "TRANSAK"
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

On a sell, `pinned` carries `cryptoAmount` and no `walletAddress` or `sourceAmount`: those are
terms a sell does not commit, and they are absent rather than empty. **`cryptoAmount` is the term
a resuming client compares against.** On a buy the wallet address distinguishes two purchases in
one corridor; a sell has none, so this is the only thing between two sales of the same asset in
the same corridor, and a mismatch must be treated as "this is a different sale", not a warning.

`serviceProviderWidgetUrl` is the provider's capture page, always present. `widgetUrl` is Meld's
own hosted widget for the session, present only when Meld returns one; a product embedding Meld's
UI opens that one. `expiresAt` is absent when Meld supplies none — **and on a sell it is always
absent**: a sell session carries no provider expiry at all, so the only deadline is this service's
own `worker.session_max_age_ms`, after which the row concludes without the sale having been
observed.

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

Refused as `REQUEST_NOT_CANCELLABLE` in three cases, and the message says which:

- **A deposit address has been disclosed.** The sell analogue of "money in flight" is the seller
  broadcasting on-chain, which this service cannot see and does not cause; once a seller has been
  shown where to send, they may already be sending, and cancelling would be exactly the lie the
  next case exists to prevent, from the other side of the same address. Checked directly against
  whether an address exists, not against `status`, because the status at which Meld first
  discloses one on a sell is unverified.
- The request is `transaction_seen`, because a buyer whose money is in flight must not be told it
  is cancelled.
- The request has already concluded, because there is nothing left to withdraw.

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
  "direction": "buy",
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

`direction` is always present. On a sell row, `walletAddress` and `sourceAmount` are absent and
`cryptoAmount` carries the committed crypto at full precision; see `direction` above for why that
echo is load-bearing rather than informational. A sell moves through the **same** eight states a
buy does: the direction is a term of the request, not a stage of its life.

On a sell whose provider has disclosed a deposit address, the object also carries:

```json
"deposit": {
  "address": "1CounterpartyDepositAddressXXXXXXXXXXXXXXXXX",
  "amount": "12.3456789012",
  "currency": "DOT_ASSETHUB",
  "observedAt": 1800000000200
}
```

`memo` joins the four above only for an asset that needs one; no asset this service delivers has
been observed to. **All four of `address`, `amount`, `currency` and `observedAt` are sent together
or not at all** -- a half-disclosure (an address with no amount, say) is worse than none, because it
looks complete. And `deposit` is gated exactly as the settlement surface below it is: only while the
request is non-terminal, the rail's expiry has not passed, and the caller has not cancelled. Handing
a seller a deposit address for a concluded or cancelled request is an invitation to an unrecoverable
on-chain send to a place nobody is watching for it any more.

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
| 409 | `Other{ REQUEST_NOT_CANCELLABLE }` | `POST /funding/:id/cancel` on a request that cannot be withdrawn: a deposit address has already been disclosed to the seller, a payment is already on its way for it, or it has already concluded. |
| 409 | `Other{ REQUEST_CONCLUDED }` | The key belongs to a request that ended as `expired` or `failed`: the rail answered and nothing was paid. Start a new one with a new key. (`refused` shares this code but never reaches the path: a refused row holds no key.) |
| 409 | `Other{ REQUEST_ALREADY_SETTLED }` | The key belongs to a request the buyer **already paid**. Do not start another for it. Split out of `REQUEST_CONCLUDED` because a client cannot act on one code for both: told "start a new one" after a settled purchase, it opens a second payable surface for money already taken. |
| 409 | `Other{ REQUEST_OUTCOME_UNKNOWN }` | The key belongs to a request that concluded as `unobserved`: we stopped being able to ask the rail and never learned whether the buyer paid. Distinct from **both** other 409 conclusions: `REQUEST_CONCLUDED` says it finished and nothing was paid, `REQUEST_ALREADY_SETTLED` says it finished and *was* paid, this one says nobody knows which. Starting a new request means accepting the risk of paying twice. |
| 400 | `RegionUnavailable` | A real destination this deployment has not configured. |
| 400 | `BelowMinimum` / `AboveMaximum` | On a **buy**, outside the effective fiat bounds (Meld's live corridor bound, tightened by a `limits` row when one names that pair), carrying `value: { amount, currency }` in fiat. On a **sell**, the provider's own crypto-denominated bound, refused upstream and carrying **no** `value`; see `direction` above for why a crypto threshold is not put on the wire. |
| 400 | `Other{ CORRIDOR_UNAVAILABLE }` | A configured `limits` row does not overlap the live corridor bound, so this deployment cannot serve the corridor within its own limits. Refused rather than widened to the upstream bound. |
| 400 | `Other{ INVALID_ADDRESS }` | Address failed to decode, or is not a 32-byte account. |
| 400 | `Other{ CURRENCY_UNSUPPORTED }` | Not the configured currency for that destination. |
| 400 | `Other{ PAYMENT_METHOD_UNSUPPORTED }` | The live corridor for this `(country, fiat, destination)` does not offer the requested `paymentMethodType`. Ask `GET /supported` for the ones it does. Not retryable as sent. |
| 400 | `Other{ MALFORMED_REQUEST }` | Body did not parse, named an unexpected field, or a field failed its bounds. **Which field is in the log against this `request_id`, never in the body**, so an integrator debugging a 400 needs the server's log line and not just the response. |
| 401 | `Other{ UNAUTHORIZED }` | Caller not verified. |
| 400 | `RouteWithdrawn` | The operator has disabled session creation. |
| 400 | `Other{ UNKNOWN_RAIL }` | A rail this build knows but this deployment has not wired. |
| 400 | `Other{ PROVIDER_REJECTED }` | Meld understood the request and declined it, for a reason not enumerated above. Not retryable. |
| 400 | `Other{ DIRECTION_UNSUPPORTED }` | The named rail does not serve that direction. `chainflip` refuses `direction: "sell"` permanently, having no fiat leg to pay a seller from; `meld` serves both. Not retryable; the remedy is a different rail or a different direction, never the same request again. |
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
