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
 */
function threshold(detail: string): { value: { amount: string; currency: string } } | undefined {
  const m = detail.match(/which is\s+(\d+(?:\.\d{1,2})?)\s+([A-Za-z]{3})/i);
  return m && m[1] && m[2] ? { value: { amount: m[1], currency: m[2].toUpperCase() } } : undefined;
}

/**
 * Meld understood the request and declined it: which refusal that is.
 *
 * Pure, and separate from the handler, because the four cases differed only in how the refusal
 * was built while each repeated its own `warn`-then-`send`. So the log line varied by accident
 * (one branch recorded `code`, two did not) and adding a case meant adding a third thing.
 *
 * None of these are retryable as-is: the remedy is a different method, region, or amount. The
 * below/above-minimum rejections carry no error code, only a human message, so they match on that.
 */
export function meld400(error: MeldHttpError): Refusal {
  if (error.code === 'NO_VALID_QUOTES') return noQuotesAvailable(`Meld: ${error.code}`);

  // Narrowed once rather than defaulted at each use: an absent `detail` cannot have matched
  // either phrase, so a per-branch fallback would describe an unreachable state.
  const detail = error.detail;
  if (detail !== undefined) {
    const phrase = detail.toLowerCase();
    if (phrase.includes('below the minimum')) {
      return reject({ tag: 'BelowMinimum', ...(threshold(detail) ?? {}) }, detail);
    }
    if (phrase.includes('above the maximum')) {
      return reject({ tag: 'AboveMaximum', ...(threshold(detail) ?? {}) }, detail);
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
