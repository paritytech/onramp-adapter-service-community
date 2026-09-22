/**
 * How a Meld error status becomes the refusal this service answers with.
 *
 * This lives here rather than in the HTTP error handler because two callers need the same answer
 * at two different times: `Onramp` writes the durable row before the response is built. One owner,
 * called before the write and reused when the response is built, is the only arrangement in which
 * the row's `reason` column and the answer the caller got cannot disagree.
 */

import { noQuotesAvailable, reject, Refusal, upstreamUnavailable } from '../contract.js';

import { MeldHttpError } from './client.js';

/**
 * Pull the threshold out of a Meld limit message, e.g. "...the minimum allowed, which is 18.00
 * EUR" -> `{ value: { amount: '18.00', currency: 'EUR' } }`. Best-effort: a wording change just
 * drops the number, and the buyer still sees a below/above-minimum failure without it.
 *
 * The amount pattern is an amount, not "digits and dots": `[\d.]+` matched `1.2.3` and put it on
 * the wire under a field the contract types as a decimal, for a client to try to render. Dropping
 * an unreadable number is already the correct fallback.
 *
 * **It yields nothing on a sell, and that is a deliberate refusal to guess, not an oversight.**
 * Observed against the sandbox: a sell's limit rejection puts no number in the top-level message
 * at all. It reads "[TRANSAK] Source amount is below the minimum allowed", and the threshold
 * sits in `serviceProviderDetails.message` as prose that differs between the minimum and maximum
 * cases ("Minimum sell amount should be more than or equal to 0.00011648 BTC" against "Please
 * place an order of less than 0.2812547 BTC"). The `which is` anchor is absent and the symbol
 * may be `DOT_ASSETHUB`, which the three-letter currency group would not match either.
 *
 * The provider's sentence *is* now carried (`MeldHttpError.providerDetail`), so extracting the
 * number would be a regex away. It is not done, because `FundingFailure`'s threshold is
 * `{ amount, currency }` with nowhere to say which kind of currency, and every existing producer
 * of it — this function's fiat branch, and `onramp.ts`'s config-derived gate — fills it with
 * fiat. Putting `0.00011648 DOT_ASSETHUB` into the same field would hand a client that renders
 * "the minimum is 0.00011648" a number in units it has no way to know it is reading, next to a
 * `fiat` echo naming something else entirely. A missing threshold makes a client say "too low";
 * a wrongly-denominated one makes it say a specific false thing. So the number goes to the
 * operator in `Refusal.message` (see `meld400`) and not to the wire, and a sell threshold stays
 * out of the contract until the contract can say what it is denominated in.
 */
function threshold(detail: string): { value: { amount: string; currency: string } } | undefined {
  const m = detail.match(/which is\s+(\d+(?:\.\d{1,2})?)\s+([A-Za-z]{3})/i);
  return m && m[1] && m[2] ? { value: { amount: m[1], currency: m[2].toUpperCase() } } : undefined;
}

/**
 * Meld's limit codes onto the two limit tags.
 *
 * The codes are the reason this exists. They are carried in **both** directions and were simply
 * being discarded: `MeldHttpError` read the code from `body.error`, and a limit rejection puts it
 * under `body.code`, with no `error` key at all. So the only signal `meld400` had was the
 * wording of a human sentence, in a body whose other half is a *different provider's* wording.
 * `client.ts` now reads both spellings, and the code is checked first because a code is a
 * taxonomy and a sentence is a sentence: "below the minimum allowed" is one Transak rewrite away
 * from becoming `Other{PROVIDER_REJECTED}`, which tells a seller to give up rather than to send
 * more.
 *
 * The phrase match stays underneath it rather than being replaced. It is the only thing that
 * covers a body carrying the message and no code at all, which is a shape this service has
 * assumed for long enough that removing its handler on the strength of one account's probe would
 * be trading a verified behaviour for a plausible one.
 *
 * A `Map`, not an object literal. The key is an arbitrary string off an upstream body, and an
 * object literal carries `Object.prototype`, so `LIMIT_TAG['constructor']` answers a function
 * rather than `undefined`: Meld sending that code would have produced a `FundingFailure` whose
 * `tag` was a function, which serialises to nothing and reaches the caller as an error body with
 * no `error` key at all. A `Map` has no prototype chain to fall through.
 */
const LIMIT_TAG = new Map<string, 'BelowMinimum' | 'AboveMaximum'>([
  ['INVALID_AMOUNT_TOO_LOW', 'BelowMinimum'],
  ['INVALID_AMOUNT_TOO_HIGH', 'AboveMaximum'],
]);

/**
 * The operator-facing sentence, with the sub-provider's own beside Meld's when it sent one.
 *
 * Both, not either: Meld's says which rule was broken and the provider's says by how much, and
 * on a sell the second is the only place the threshold exists in any form. `Refusal.message` is
 * never serialized to a client (`contract.ts`), so this is the right home for a number that
 * cannot be safely typed onto the wire — an operator reading the log can see "minimum is
 * 0.00011648 BTC" and act on it.
 */
function operatorDetail(error: MeldHttpError): string {
  const meld = error.detail ?? error.message;
  return error.providerDetail === undefined ? meld : `${meld} (provider: ${error.providerDetail})`;
}

/**
 * Meld understood the request and declined it: which refusal that is.
 *
 * Pure, and separate from the handler, because the four cases differed only in how the refusal
 * was built while each repeated its own `warn`-then-`send`. So the log line varied by accident
 * (one branch recorded `code`, two did not) and adding a case meant adding a third thing.
 *
 * None of these are retryable as-is: the remedy is a different method, region, or amount. The
 * below/above-minimum rejections are resolved by Meld's own code where it sent one, and by the
 * wording of its message where it did not; see `LIMIT_TAG`.
 *
 * Direction-blind, and correctly so. Nothing here is told whether it is refusing a buy or a
 * sell, and nothing needs to be: the codes and the phrases are the same both ways, and the one
 * thing that genuinely differs — where the threshold lives and what it is denominated in — is
 * resolved by not putting it on the wire at all. A direction parameter here would exist only to
 * let this function emit a number it should not emit either way.
 */
export function meld400(error: MeldHttpError): Refusal {
  if (error.code === 'NO_VALID_QUOTES') return noQuotesAvailable(`Meld: ${error.code}`);

  // Narrowed once rather than defaulted at each use: an absent `detail` cannot have matched
  // either phrase, so a per-branch fallback would describe an unreachable state.
  const detail = error.detail;

  // Meld's own code first. `threshold` still reads the top-level message, because that is where
  // a buy's number is; a sell has none there and gets the tag without one, which is the intended
  // outcome rather than a degraded one.
  const coded = error.code === undefined ? undefined : LIMIT_TAG.get(error.code);
  if (coded !== undefined) {
    return reject({ tag: coded, ...(detail === undefined ? {} : (threshold(detail) ?? {})) }, operatorDetail(error));
  }

  if (detail !== undefined) {
    const phrase = detail.toLowerCase();
    if (phrase.includes('below the minimum')) {
      return reject({ tag: 'BelowMinimum', ...(threshold(detail) ?? {}) }, operatorDetail(error));
    }
    if (phrase.includes('above the maximum')) {
      return reject({ tag: 'AboveMaximum', ...(threshold(detail) ?? {}) }, operatorDetail(error));
    }
  }

  // The cases above are the nameable ones; the rest (an unsupported payment method in that
  // country, an unserved corridor) are still not retryable. Falling through to the 503 degrade
  // told the caller to retry something that can never succeed.
  return reject(
    { tag: 'Other', value: { code: 'PROVIDER_REJECTED', message: 'The provider declined this request.' } },
    error.message,
  );
}

/**
 * The refusal this service answers a rail failure with, whatever shape the failure arrived in.
 *
 * One function over one taxonomy, so `Onramp` and the response path cannot disagree. Two
 * predicates would: classifying any 4xx as definitive while the response path names only a `400`
 * makes a Meld `401` (a wrong operator key, not a rare shape) write a durable `refused` row, free
 * the idempotency key, record the tag
 * `UpstreamError` that appears in no vocabulary, and told the buyer to try again. The row said
 * "definitively rejected" and the answer said "temporary". Both were derived from the same error,
 * ten lines apart, by different rules.
 *
 * Now the answer is computed once and everything else reads it: the state, the key, the recorded
 * tag, and the response body. A caller told `ProviderTimeout` gets a row saying the rail could not
 * tell, and a caller told `BelowMinimum` gets a row that says so.
 */
export function railRefusal(cause: unknown): Refusal {
  if (cause instanceof Refusal) return cause;
  if (cause instanceof MeldHttpError) {
    // A `400` means Meld read the request and declined it, and names which refusal that is.
    if (cause.status === 400) return meld400(cause);

    // Everything that is not a `400` keeps the key, including a `429`.
    //
    // A throttle was briefly classified as definitive, on the reasoning that Meld declines before
    // processing so no settlement surface exists. That reasoning does not survive contact with the
    // code: `MeldClient.send` turns any non-OK response into a `MeldHttpError` after a
    // best-effort JSON parse, and nothing proves the status came from Meld's application logic
    // rather than a CDN, a WAF or a load balancer in front of it, or that it was not emitted
    // after a session had already been created or queued. The two cases are indistinguishable
    // here.
    //
    // Releasing the key on that inference lets the retry the contract requires to be stable open
    // a second settlement surface for one buyer intent. The cost of being wrong in the other
    // direction is a throttled buyer meeting `REQUEST_OUTCOME_UNKNOWN` and having to contact
    // support: unpleasant, and recoverable. Being wrong this way charges them twice.
    return upstreamUnavailable(cause.message);
  }
  return upstreamUnavailable(cause instanceof Error ? cause.message : String(cause));
}
