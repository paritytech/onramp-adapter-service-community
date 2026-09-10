/**
 * The HTTP surface: the authenticated routes (every one wrapped in `asCaller`, so a grep answers
 * which and how many), the two public handshake routes, the widget's return landing, and a
 * liveness probe.
 *
 * Two invariants live here rather than in the docs, because both are easy to break locally:
 * every failure becomes a response in one of exactly three places (the error handler, the
 * not-found handler, and `frameworkErrors` for what the router rejects before either runs), and
 * all three emit the same `ErrorResponse`; and request schemas are strict, so an unexpected field
 * is refused rather than stripped.
 */

import cors from '@fastify/cors';
import rateLimit, { type FastifyRateLimitStoreCtor } from '@fastify/rate-limit';
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
import { PartitionedStore } from './limit-store.js';
import { z } from 'zod';

import type { AuditLog } from './audit.js';
import { callerAuth } from './auth.js';
import { callerGate } from './caller.js';
import { toOriginMatcher, type Config } from './config.js';
import type { PersonhoodService } from './personhood.js';
import {
  createSessionRequest,
  quoteRequest,
  supportedQuery,
  supportedCountriesQuery,
  redeemRequest,
  malformedRequest,
  notFound,
  Refusal,
  transactionId,
  type ErrorResponse,
  fundingListQuery,
} from './contract.js';
import { toCorridorDto } from './meld/discovery.js';
import { toFundingRequestDto } from './funding/types.js';
import { MeldHttpError } from './meld/client.js';
import { railRefusal } from './meld/refusal.js';
import type { Onramp } from './onramp.js';

/** Only what the routes call, so a test can substitute a plain object. */
type OnrampPort = Pick<
  Onramp,
  | 'createSession'
  | 'quote'
  | 'supported'
  | 'supportedCountries'
  | 'transaction'
  | 'cancel'
  | 'get'
  | 'list'
>;


/**
 * The service is built from the app's logger rather than passed in.
 *
 * The audit record is written through a logger that only exists once Fastify is
 * constructed, and threading a second logger in would create two sinks for one purpose.
 */
type OnrampFactory = (audit: AuditLog) => OnrampPort;

/**
 * Where log lines go. Defaults to stdout; a test passes a stream it can read.
 *
 * This exists so the guarantee the service is built around, that the key reaches no log line, is
 * assertable. pino writes through sonic-boom straight to the file descriptor, so a test that
 * reassigns `process.stdout.write` captures zero bytes and its assertion passes with redaction
 * deleted entirely.
 */
type LogDestination = { write: (line: string) => void };

export async function buildServer(
  cfg: Config,
  makeOnramp: OnrampFactory,
  personhood?: PersonhoodService,
  logDestination?: LogDestination,
): Promise<FastifyInstance> {
  const app = Fastify({
    // A request id on every log line and every error body, so a support conversation can
    // name one request. Trusting an inbound header would let a caller collide with it.
    genReqId: () => crypto.randomUUID(),
    logger: {
      level: cfg.server.log_level,
      // No `redact` list, because it was dead configuration: Fastify's own `req` serializer
      // emits only {method,url,host,remoteAddress}, so request headers never reach a log line
      // for redaction to act on. A caller's bearer token stays out because it is never
      // serialised; the API key stays out because `Secret` redacts itself.
      ...(logDestination === undefined ? {} : { stream: logDestination }),
    },
    // Trust by peer address, handed to Fastify as the list `proxy-addr` compiles.
    //
    // By peer, never by hop index: a predicate like `(_address, hop) => hop < hops` trusts whoever
    // connects, because hop 0 is below any positive bound. Fastify implements the numeric
    // `trust proxy` form by trusting nothing at all, for exactly that reason.
    //
    // An empty list is `false`: read no forwarded header and bucket on the socket address. Behind
    // an ingress that makes the per-caller ceiling a per-service one. Visible, and the direction
    // that cannot be exploited. `config.ts` validates the shape of each entry so a typo names the
    // field here rather than throwing out of `proxy-addr` inside this constructor.
    trustProxy: cfg.server.trusted_proxy_cidrs.length > 0 ? [...cfg.server.trusted_proxy_cidrs] : false,
    bodyLimit: 16 * 1024,
    // Match the schema, which bounds a transaction id at 128. Fastify's default is 100, so a
    // legitimate Meld id of 101-128 characters (a length `transactionId` explicitly permits)
    // was refused by the router with `414`, before any of this service's own validation ran.
    maxParamLength: 128,
    // The router rejects a malformed path before the request lifecycle begins, so neither the
    // error handler nor the rate limiter ever sees it. Left alone, `GET /transaction/%zz` and an
    // over-long parameter answered with Fastify's own body (`error` a bare string, no
    // `request_id`, and the requested path echoed back), which is the exact defect
    // `setNotFoundHandler` below was added to fix, one code path over.
    //
    // This closes the body, and deliberately not the counting. These stay unbounded by the
    // limiter, because its hook is `onRequest` and nothing in the lifecycle runs. That is
    // tolerable here and was not for the not-found and OPTIONS holes, which is the distinction
    // worth keeping: each of those cost a request id and a pino request/response pair, making
    // them a free amplifier against the log pipeline the audit trail depends on. This path
    // allocates a request id and writes one pino line, which is half what a matched route costs,
    // touches no store and makes no upstream call, so what it amplifies is a 400 cheaper than the
    // TLS handshake in front of it.
    // Routing the limiter in here would put a hook on the one path that has none, for that.
    // Threat-model R9.
    frameworkErrors: (_error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
      void reply.code(400).send({
        error: malformedRequest('framework').failure,
        request_id: request.id,
      } satisfies ErrorResponse);
    },
    // Bounds a whole request rather than one hop, so a slow or half-open client cannot hold a
    // connection open indefinitely. `connectionTimeout` covers a socket that never sends a
    // complete request at all.
    requestTimeout: cfg.server.request_timeout_ms,
    connectionTimeout: cfg.server.request_timeout_ms,
  });

  // In `personhood` mode the verifier needs the handshake service; `callerAuth` refuses to build
  // without one at boot, never per request. In `insecure_dev` the service is simply unused.
  //
  // Built before the limiter is registered, because the limiter's key now comes from it. The
  // ordering that actually matters is per request rather than here, and it is spelled out on
  // `hook` below. See src/caller.ts for why authentication is split in two at all.
  const gate = callerGate(callerAuth(cfg, { personhood }));

  // Keyed on the proven person when there is one, and on the address otherwise: a failed
  // authentication, an `insecure_dev` caller, or one of the two public handshake routes. Threat
  // model R3; `gate.key` carries the reasoning for the fallback.
  await app.register(rateLimit, {
    // The counter store, partitioned rather than merely large.
    //
    // The plugin's own store is one LRU for every key, and the keys here are not comparable: an
    // address is free and unlimited (an IPv6 /48 yields 65,536 distinct /64 buckets after
    // truncation), while a `person:` alias costs a ring-VRF proof. In one LRU that asymmetry lets
    // cheap traffic evict expensive traffic. Requests from distinct addresses, each below its own
    // per-address ceiling because each lands in a fresh bucket, push the person's counter out. It
    // restarts at zero and the whole allowance is spendable again.
    //
    // That control bounds the metered upstream quota (threat-model T9), and sizing the LRU only
    // sets the price: 200k entries cost 46.7MB against a 256Mi pod and still lose to an attacker
    // with a /32. Two maps removes the eviction path instead, since address churn can only evict
    // addresses, and costs 20.3MB saturated. See `limit-store.ts` for the sizing.
    //
    // Cast at the seam: the plugin types `child`'s parameter as Fastify's entire `RouteOptions`
    // plus a path and prefix, and this store reads two booleans out of it. Widening the signature
    // to match would import the whole route generic to describe an ignored object.
    store: PartitionedStore as unknown as FastifyRateLimitStoreCtor,
    // The allowance follows the bucket, because the two bound different things: an address
    // stands in for however many unproven callers share it, while a person is one human who
    // cost a ring-VRF proof to become. `gate.proven` is the same predicate `gate.key` uses, so
    // the budget and the bucket cannot disagree about who is being counted.
    max: (request) => (gate.proven(request) ? cfg.rate_limit.per_person_max : cfg.rate_limit.per_address_max),
    // `onRequest` is the plugin's default, and stated here because the ordering is load-bearing
    // rather than incidental. The limiter must sit between the two halves of authentication:
    // after `gate.identify` has decided who is calling, and before `gate.enforce` raises a
    // refusal. The plugin appends its hook to `routeOptions[hook]`, so sharing the `onRequest`
    // phase with `identify` puts it second. `enforce` is a phase later, in `preHandler`.
    //
    // Not `preHandler`, which was the first attempt: appending there puts the limiter after
    // the route-level `enforce`, so a 401 escapes the count entirely. Not `preValidation`
    // either, which orders correctly but runs after body parsing, so a caller spamming malformed
    // JSON would be rejected by the parser before the limiter ever saw them. Running first, in
    // `onRequest`, counts every request that arrives, however it later fails.
    hook: 'onRequest',
    keyGenerator: gate.key,
    // Liveness is exempt. An orchestrator polling `/health` would otherwise declare a
    // throttled-but-healthy instance dead, turning a quota problem into an outage.
    // `routeOptions.url` is the matched route pattern; `request.url` is the raw target, so
    // `/health?probe=1` missed this and got throttled: exactly the outage the exemption
    // exists to prevent, triggered by any orchestrator that adds a cache-buster.
    allowList: (request: { routeOptions: { url?: string | undefined } }) =>
      request.routeOptions.url === '/health',
    timeWindow: cfg.rate_limit.window_seconds * 1_000,
    // No `errorResponseBuilder`: the handler below shapes every response. A builder here was
    // silently overwritten by it, turning a 429 into "malformed request".
  });

  // A preflight never reaches a route, so the route-level limiter never sees it. This does.
  //
  // `@fastify/cors` answers a preflight from an instance-level `onRequest` hook and returns
  // without calling `next()`. Instance hooks run before route hooks, so no amount of reordering
  // helps: every `OPTIONS` carrying an `Origin` and `Access-Control-Request-Method` was answered
  // with no ceiling at all, from any origin, on any path, including ones that do not exist. Each
  // still costs a request id and a pino request/response pair: the same free amplifier against
  // the audit log that the not-found path was fixed for, one method over. The origin allowlist
  // does not help, because it decides whether the `Allow-Origin` header is written, not whether
  // the 204 is sent.
  //
  // It cannot simply be moved to instance level for every request. `gate.identify` is
  // route-level, so an instance-level limiter would run before the caller is known and every
  // bucket would collapse back to the address. A preflight has no caller to know, so limiting
  // just that method here is both correct and sufficient.
  const preflightLimit = app.rateLimit();
  app.addHook('onRequest', async function preflightCeiling(request, reply) {
    // `function`, not an arrow: the plugin's hook reads `this` for the Fastify instance.
    if (request.method === 'OPTIONS') await preflightLimit.call(this, request, reply);
  });

  // Registered after the rate limiter so the hook above is in place first.
  //
  // Never a wildcard: that would let any page spend the operator's quota from a visitor's
  // browser. See threat model T10.
  await app.register(cors, {
    // `false`, not `[]`: both block the browser, but `false` 404s the preflight, which reads as
    // "CORS unconfigured" rather than "origin rejected".
    origin: cfg.cors.allowed_origins.length > 0 ? cfg.cors.allowed_origins.map(toOriginMatcher) : false,
    methods: ['GET', 'POST'],
    // No `credentials`: this service uses no cookies, and allowing them alongside an origin
    // allowlist is how a CSRF surface gets introduced by accident.
    maxAge: 600,
  });

  /**
   * Every route that spends, reads, or names a caller.
   *
   * `onRequest` identifies without refusing; the limiter counts in between; `preHandler` raises
   * whatever refusal was recorded. A route added here without this pair still fails closed
   * (`gate.subjectOf` has no decision to return), but it loses the per-person bucket, so the pair
   * belongs on every authenticated route rather than on the handlers that happen to want a
   * `Subject`.
   */
  const asCaller = { onRequest: gate.identify, preHandler: gate.enforce };
  // pino's logger already satisfies `AuditLog` structurally, so no adapter is needed. The audit
  // stream does get its own level, pinned to `info`, on the same destination.
  //
  // Every audit event is written at `info`: `session.created`, `session.refused`,
  // `session.rail_refused`, and `session.orphaned`, which `audit.ts` calls the one that matters at
  // 3am. An operator raising `server.log_level` to `warn` to cut probe noise would have discarded
  // all four while request-level warnings kept flowing. The logs look alive and the record a
  // dispute is answered from is silently gone.
  //
  // A pino child shares the parent's destination, so this is still one sink and one stream, which
  // is the property the comment above `OnrampFactory` protects. What it does not share is the
  // threshold, and the audit trail is not the request log's to silence.
  const onramp = makeOnramp(app.log.child({}, { level: 'info' }));

  /** Parse or refuse. The zod message is operator-facing and never reaches the client. */
  const parse = <T>(schema: z.ZodType<T>, body: unknown): T => {
    const parsed = schema.safeParse(body);
    if (parsed.success) return parsed.data;

    throw malformedRequest(
      parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
    );
  };

  /**
   * Liveness only. The credential is proven at boot, before the port opens.
   *
   * `logLevel: 'silent'` because this route is both rate-limit exempt and internet-reachable
   * (an overlay routing the ingress at `path: /`, `pathType: Prefix` exposes it). Exempting it is
   * right (a throttled-but-healthy instance would be killed by its own probe), but exempt and
   * logging meant an unauthenticated caller could write two pino lines per request at no cost,
   * for ever. The audit trail is that same stream and has no delivery guarantee (threat-model
   * R6), so that is a free way to bury `session.created` under probe noise. Silencing the route
   * removes the amplifier without touching the exemption.
   */
  app.get('/health', { logLevel: 'silent' }, async () => ({ status: 'ok' }));

  /** Spends a Meld call but no money, which is why boot uses it as the credential probe. */
  app.post('/quote', asCaller, async (request, reply) =>
    reply.send(await onramp.quote(parse(quoteRequest, request.body))),
  );

  // Live capability discovery. Reads a cached view of Meld's public route catalog, so it moves no
  // money and holds no key; it is behind `asCaller` only to keep it off the open internet and
  // rate it per caller, exactly like /quote. The buyer's region dropdown and amount bounds come
  // from here instead of a hand-maintained list that refused corridors Meld actually serves.
  app.get<{ Querystring: Record<string, string> }>(
    '/supported/countries',
    asCaller,
    async (request, reply) => {
      const q = parse(supportedCountriesQuery, request.query);
      return reply.send({ countries: await onramp.supportedCountries(q.destinationCurrencyCode) });
    },
  );
  app.get<{ Querystring: Record<string, string> }>('/supported', asCaller, async (request, reply) => {
    const q = parse(supportedQuery, request.query);
    // Projected, not forwarded: `providers` is aggregation bookkeeping no client reads, and
    // serialising it would name Meld's sub-providers on a surface that deliberately never does.
    return reply.send(toCorridorDto(await onramp.supported(q.country, q.destinationCurrencyCode)));
  });

  /** The one operation that leads to a card charge. */
  app.post('/session', asCaller, async (request, reply) => {
    const subject = gate.subjectOf(request);
    const body = parse(createSessionRequest, request.body);
    return reply.code(201).send(await onramp.createSession(subject, body, request.id));
  });

  /**
   * Status, projected onto the five declared fields.
   *
   * A path parameter is fine over ordinary HTTPS. Behind an RFC 0025 `Credential` grant every
   * concrete id would need its own grant, and this would have to become a query parameter.
   */
  app.get<{ Params: { id: string } }>('/transaction/:id', asCaller, async (request, reply) =>
    // Validated like every body field. Without this an empty id reached Meld's collection
    // path and this route answered with every transaction on the operator's account.
    reply.send(await onramp.transaction(parse(transactionId, request.params.id))),
  );

  /**
   * The personhood handshake. Public (no subject yet) and cheap; the rate limit already bounds
   * them per address.
   *
   * `challenge` mints a fresh blind token; `redeem` turns a ring-VRF proof plus that challenge
   * into a short-lived JWT, proving the caller is currently in the People ring this deployment
   * serves. In `insecure_dev` these routes do not exist: there is no personhood to speak of, and
   * a 404 reads as "personhood not configured" rather than "verified and refused".
   */
  if (personhood) {
    app.post('/api/v1/auth/challenge', async (_request, reply) =>
      reply.send(personhood.challenge()),
    );
    app.post('/api/v1/auth/redeem', async (request, reply) => {
      const body = parse(redeemRequest, request.body);
      return reply.send(await personhood.redeem(body));
    });
  }

  /**
   * The caller's funding request, by its funding id. 404 when the id is unknown or belongs to
   * another caller, so one caller cannot tell whether another's id exists by probing.
   */
  app.get<{ Params: { id: string } }>('/funding/:id', asCaller, async (request, reply) => {
    const subject = gate.subjectOf(request);
    const id = parse(transactionId, request.params.id);
    const record = await onramp.get(subject, id);
    if (record === undefined) {
      const missing = notFound('No such funding request.');
      return reply.code(missing.status).send({
        error: missing.failure,
        request_id: request.id,
      } satisfies ErrorResponse);
    }
    return reply.send({ funding: toFundingRequestDto(record, Date.now()) });
  });

  // A body-less `POST` must not depend on the caller omitting a header.
  //
  // Fastify's built-in JSON parser answers `FST_ERR_CTP_EMPTY_JSON_BODY`, a `400`, when
  // `content-type: application/json` arrives with nothing after it. `POST /funding/:id/cancel`
  // takes no body, so a client with one shared fetch wrapper that sets the header on every call
  // gets a `400` naming a body it was right not to send. The consumer only avoids it today by
  // happening not to set `content-type`, which is not a property to rely on when the route being
  // refused is the one that withdraws a payable settlement surface.
  //
  // An empty body becomes `undefined` rather than an error. Nothing is loosened for the routes
  // that need a body: `parse()` still refuses `undefined` with `MALFORMED_REQUEST`, which is a
  // better answer than the framework's anyway, carrying the contract's shape and a request id.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body: string, done) => {
    if (body === '') {
      done(null, undefined);
      return;
    }
    try {
      done(null, JSON.parse(body));
    } catch {
      // Swallowing the parser's own message on purpose: it quotes the offending body back, and
      // that body is caller-controlled. `malformedRequest` is the one sentence every parse failure
      // gets, so a caller cannot tell them apart.
      done(malformedRequest('request body was not valid JSON'));
    }
  });

  /**
   * Withdraw one of the caller's funding requests.
   *
   * `POST`, not `DELETE`: nothing is deleted. The row is the only record of what the buyer was
   * offered, it stays readable, and a payment already in flight still settles against it.
   *
   * 404 for unknown and another caller's, exactly as the read route does, so this is not an
   * existence oracle either. Idempotent: cancelling an already-cancelled request answers 200 with
   * the row, because a retried tap is not a fault.
   */
  app.post<{ Params: { id: string } }>('/funding/:id/cancel', asCaller, async (request, reply) => {
    const subject = gate.subjectOf(request);
    const id = parse(transactionId, request.params.id);
    const record = await onramp.cancel(subject, id, request.id);
    if (record === undefined) {
      const missing = notFound('No such funding request.');
      return reply.code(missing.status).send({
        error: missing.failure,
        request_id: request.id,
      } satisfies ErrorResponse);
    }
    return reply.send({ funding: toFundingRequestDto(record, Date.now()) });
  });

  /**
   * The caller's open and past funding requests, newest first. Bounded by the store's default.
   *
   * Refused rows (from either producer) are excluded unless `?includeRefused=true`. Being refused
   * is how a caller learns a minimum amount, and there is no discovery route, so refusals are
   * ordinary traffic: a hundred of them would push the request the buyer is actually waiting on
   * out of the window.
   */
  app.get<{ Querystring: { includeRefused?: string } }>('/funding', asCaller, async (request, reply) => {
    const subject = gate.subjectOf(request);
    const { includeRefused } = parse(fundingListQuery, request.query);
    const records = await onramp.list(subject, includeRefused);
    // Wrapped, not point-free: `map` passes the index as the second argument, which would
    // arrive as `now` and make every row after the first look expired.
    const now = Date.now();
    return reply.send({ fundingRequests: records.map((r) => toFundingRequestDto(r, now)) });
  });

  /**
   * The completion landing the Meld widget redirects to (passed as sessionData.redirectUrl).
   *
   * Served from this origin on purpose: a redirect target is loaded inside the payment iframe, and
   * the app's own https page is served `X-Frame-Options: sameorigin` by its gateway (blank frame),
   * while Meld's own default landing is a password-gated page. This tiny same-origin-to-the-adapter
   * page has no such header, so it frames cleanly, and its script posts `meld:paid` to the parent
   * app. It carries no status and needs no auth. The buyer's browser lands here with no header,
   * and the authoritative settlement is still the app's own status poll.
   */
  app.get('/meld/return', async (_request, reply) =>
    reply.type('text/html').send(
      `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
        `<meta name="viewport" content="width=device-width, initial-scale=1">` +
        `<title>Payment received</title></head>` +
        `<body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;` +
        `font-family:system-ui,sans-serif;background:#0b0b0b;color:#fff">` +
        `<div style="text-align:center">` +
        `<div style="width:34px;height:34px;margin:0 auto 14px;border:3px solid #333;border-top-color:#fff;` +
        `border-radius:50%;animation:s 1s linear infinite"></div>` +
        `<p style="font-size:14px;color:#bbb">Payment received, returning...</p></div>` +
        `<style>@keyframes s{to{transform:rotate(360deg)}}</style>` +
        `<script>try{window.parent.postMessage({type:"meld:paid"},"*")}catch(e){}</script>` +
        `</body></html>`,
    ),
  );

  /**
   * A route that does not exist still owes the caller the contract body.
   *
   * Fastify routes "not found" through its own handler, never `setErrorHandler`, so without this
   * it is the one response that escapes `ErrorResponse`: no `request_id`, `error` a bare string,
   * and the requested route echoed back.
   */
  app.setNotFoundHandler(
    // Rate limited explicitly. The plugin attaches itself through `onRoute`, and Fastify builds
    // the not-found context without emitting one, so without this unmatched paths are the one
    // surface with no ceiling. Each costs a request id and a pino request/response pair, making
    // `GET /a1`, `/a2`, ... a free amplifier against the log pipeline the audit trail depends on.
    { preHandler: app.rateLimit() },
    (request, reply) => {
      const missing = notFound('No such route.');
      return reply.code(missing.status).send({
        error: missing.failure,
        request_id: request.id,
      } satisfies ErrorResponse);
    },
  );

  /**
   * The single place a failure becomes a response. Every branch must end in `send`.
   *
   * The middle case is the one easily lost: a framework error already knows its own 4xx status,
   * and flattening those into 500 tells a caller to retry something that will never succeed.
   */
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const send = (status: number, failure: ErrorResponse['error']) =>
      reply.code(status).send({ error: failure, request_id: request.id } satisfies ErrorResponse);

    if (error instanceof Refusal) {
      request.log.warn({ failure: error.failure.tag, detail: error.message }, 'request refused');
      return send(error.status, error.failure);
    }

    // Meld answered with an error status. A buyer cannot act on "the operator's key is wrong"
    // and a 500 would tell them nothing, so it degrades to a retryable failure here. Boot, which
    // never passes through this handler, still sees the status and refuses to start. That split
    // is why the client throws a typed error instead of degrading itself.
    if (error instanceof MeldHttpError) {
      // Through `railRefusal`, the same function `Onramp` calls to decide the row's state
      // and its recorded tag. Naming the mapping in two places is how the row came to say
      // "definitively refused" while this handler told the caller "temporary, retry".
      //
      // A `400` means Meld read the request and declined it, and travels as a specific 4xx. Every
      // other status is something a buyer cannot act on ("the operator's key is wrong" is not a
      // buyer's problem), so it degrades to the retryable 503.
      const refusal = railRefusal(error);
      const level = refusal.failure.tag === 'ProviderTimeout' ? 'error' : 'warn';
      request.log[level]({ status: error.status, code: error.code }, refusal.message);
      return send(refusal.status, refusal.failure);
    }

    // Read the status defensively and once. `throw null` and `Promise.reject()` both reach here,
    // and dereferencing `.statusCode` threw inside this handler; Fastify then fell back to its
    // own, leaking "Cannot read properties of null". The parameter's non-nullable type is the lie
    // that crash relied on.
    const thrown = error as FastifyError | null | undefined;
    const status = thrown?.statusCode ?? 500;

    // Rate limited. Distinct from the generic 4xx below because the remedy is different: wait
    // and retry, rather than change the request. The plugin has already set `retry-after`.
    if (status === 429) {
      request.log.warn({ ip: request.ip }, 'rate limited');
      return send(429, {
        tag: 'Other',
        value: { code: 'RATE_LIMITED', message: 'Too many requests. Retry shortly.' },
      });
    }

    if (status >= 400 && status < 500) {
      request.log.warn({ code: thrown?.code, detail: thrown?.message }, 'request rejected by the framework');
      return send(status, malformedRequest('framework 4xx').failure);
    }

    request.log.error({ err: error }, 'unhandled error');
    return send(500, { tag: 'Other', value: { code: 'INTERNAL', message: 'Something went wrong.' } });
  });

  return app;
}
