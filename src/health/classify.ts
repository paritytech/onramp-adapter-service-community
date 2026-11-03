import { MeldHttpError } from '../meld/client.js';

/**
 * What one pinned quote says about its provider. `unknown` and `throttled` say nothing about it:
 * the request, the key or Meld itself is at fault. `throttled` also asks the caller to back off.
 */
export type ProbeResult =
  | { outcome: 'up' }
  | { outcome: 'down'; code: string; requestId?: string }
  | { outcome: 'unknown'; code: string }
  | { outcome: 'throttled'; code: string };

/** Meld refused the probe's amount, which describes the probe, not the provider. */
const AMOUNT_CODES = new Set(['INVALID_AMOUNT', 'INVALID_AMOUNT_TOO_LOW', 'INVALID_AMOUNT_TOO_HIGH']);

/** Meld's codes for a provider that failed, timed out or could not price a request it serves. */
const PROVIDER_CODES = new Set([
  'INCOMPATIBLE_REQUEST',
  'NO_VALID_QUOTES',
  'NOT_FOUND',
  'QUOTE_TIMEOUT',
  'SERVICE_PROVIDER_ERROR',
  'SERVICE_PROVIDER_NOT_ENABLED',
  'TRANSACTION_EXCEPTION',
  'TRANSACTION_FAILED_GETTING_CRYPTO_QUOTE',
  'TRANSACTION_FAILED_GETTING_CRYPTO_QUOTE_FROM_PROVIDER',
]);

/** A quote pinned to `provider` succeeded. Only an offer from that provider proves it up. */
export function classifyQuotes(provider: string, quotes: readonly { serviceProvider: string }[]): ProbeResult {
  return quotes.some((quote) => quote.serviceProvider === provider) ? { outcome: 'up' } : { outcome: 'down', code: 'NO_OFFER' };
}

/** A quote pinned to `provider` threw `error`. */
export function classifyError(provider: string, error: unknown): ProbeResult {
  if (!(error instanceof MeldHttpError)) return { outcome: 'unknown', code: 'UNREACHABLE' };
  const code = error.code ?? `HTTP_${String(error.status)}`;
  // A body without a code is not Meld's application answering: on a 503 that is its proxy's throttle.
  if (error.status === 429 || (error.status === 503 && error.code === undefined)) return { outcome: 'throttled', code };
  if (error.code === undefined || AMOUNT_CODES.has(error.code)) return { outcome: 'unknown', code };
  // Meld prefixes a sub-provider's failure with its name, e.g. "[BANXA] Incompatible request".
  if (PROVIDER_CODES.has(error.code) || error.detail?.startsWith(`[${provider}]`) === true) {
    return { outcome: 'down', code, ...(error.requestId === undefined ? {} : { requestId: error.requestId }) };
  }
  return { outcome: 'unknown', code };
}
