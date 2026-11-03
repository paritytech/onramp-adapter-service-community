import { describe, expect, it } from 'vitest';

import { upstreamUnavailable } from '../../src/contract.js';
import { classifyError, classifyQuotes } from '../../src/health/classify.js';
import { MeldHttpError } from '../../src/meld/client.js';

describe('classifyQuotes', () => {
  it('is up only when the pinned provider made an offer', () => {
    expect(classifyQuotes('BANXA', [{ serviceProvider: 'BANXA' }])).toEqual({ outcome: 'up' });
    expect(classifyQuotes('BANXA', [])).toEqual({ outcome: 'down', code: 'NO_OFFER' });
    expect(classifyQuotes('BANXA', [{ serviceProvider: 'TRANSAK' }])).toEqual({ outcome: 'down', code: 'NO_OFFER' });
  });
});

describe('classifyError', () => {
  // The first row is the sandbox's answer for a down Banxa, in every country and for every asset.
  it.each([
    [400, 'INCOMPATIBLE_REQUEST', '[BANXA] Incompatible request: Body does not match service providers', 'down'],
    [400, 'NO_VALID_QUOTES', 'No Valid Quote Combinations Found For Provided Quote Request.', 'down'],
    [408, 'QUOTE_TIMEOUT', undefined, 'down'],
    [500, 'SERVICE_PROVIDER_ERROR', undefined, 'down'],
    [403, 'SERVICE_PROVIDER_NOT_ENABLED', undefined, 'down'],
    [400, 'A_NEW_CODE', '[BANXA] something failed', 'down'],
    [400, 'A_NEW_CODE', '[TRANSAK] something failed', 'unknown'],
    [400, 'INVALID_AMOUNT_TOO_LOW', '[BANXA] Source amount is below the minimum allowed', 'unknown'],
    [403, 'Forbidden', undefined, 'unknown'],
    [401, undefined, undefined, 'unknown'],
    [500, 'JSON_PROCESSING_ERROR', undefined, 'unknown'],
    [429, 'TOO_MANY_REQUESTS', undefined, 'throttled'],
    [503, undefined, undefined, 'throttled'],
  ] as const)('HTTP %s %s is %s', (status, code, detail, outcome) => {
    expect(classifyError('BANXA', new MeldHttpError(status, code, detail)).outcome).toBe(outcome);
  });

  it('records Meld\'s code, or the status when there is none', () => {
    expect(classifyError('BANXA', new MeldHttpError(400, 'NO_VALID_QUOTES'))).toEqual({ outcome: 'down', code: 'NO_VALID_QUOTES' });
    expect(classifyError('BANXA', new MeldHttpError(503))).toEqual({ outcome: 'throttled', code: 'HTTP_503' });
  });

  it('keeps Meld\'s request ID on a down answer', () => {
    expect(classifyError('BANXA', new MeldHttpError(400, 'INCOMPATIBLE_REQUEST', '[BANXA] x', undefined, 'req-1'))).toEqual({
      outcome: 'down',
      code: 'INCOMPATIBLE_REQUEST',
      requestId: 'req-1',
    });
  });

  it('says nothing about the provider when Meld could not be reached', () => {
    expect(classifyError('BANXA', upstreamUnavailable('socket hang up'))).toEqual({ outcome: 'unknown', code: 'UNREACHABLE' });
    expect(classifyError('BANXA', new Error('boom'))).toEqual({ outcome: 'unknown', code: 'UNREACHABLE' });
  });
});
