import { describe, expect, it } from 'vitest';

import { MeldWebhooks, meldSignature } from '../../src/meld/webhook.js';
import { Secret } from '../../src/secret.js';
import { fakeStore } from '../fixtures.js';

/** Meld's worked example (reference §9), byte for byte. */
const VECTOR = {
  secret: '42m4NMLS34WQ6BbMfo1KFKqMv4hy',
  url: 'https://example.meld.io/webhooks',
  timestamp: '2022-05-26T20:25:17.682818Z',
  body:
    '{"eventType":"WEBHOOK_TEST","eventId":"GDtv8pQgwzc9HuFFBQFrww","timestamp":"2022-05-26T20:23:45.908400Z",' +
    '"accountId":"W9jpQc1HKvwscqMPcLmzUS","profileId":null,"version":"2021-10-27","payload":{"requestId":"7aWW1GXTjWCCtNubzvVX7V"}}',
  signature: 'O4bN5E0U9s88l2DFc0kjt-0w3LLA3Zkv8hXhafc22Hg=',
};

const at = Date.parse(VECTOR.timestamp);

const webhooks = (overrides: { secret?: string; url?: string; now?: number } = {}) =>
  new MeldWebhooks(
    { url: overrides.url ?? VECTOR.url, tolerance_ms: 300_000 },
    new Secret(overrides.secret ?? VECTOR.secret),
    { transaction: async () => Promise.reject(new Error('not under test')) },
    fakeStore(),
    () => overrides.now ?? at,
  );

const body = (text = VECTOR.body) => Buffer.from(text);

describe('meldSignature', () => {
  it("reproduces Meld's worked example, padding included", () => {
    expect(meldSignature(VECTOR.secret, VECTOR.timestamp, VECTOR.url, body())).toBe(VECTOR.signature);
  });
});

describe('MeldWebhooks.signatureFault', () => {
  it("accepts Meld's worked example", () => {
    expect(webhooks().signatureFault(VECTOR.signature, VECTOR.timestamp, body())).toBeUndefined();
  });

  it.each([
    ['another secret', { secret: 'another-secret' }, body()],
    ['another configured URL', { url: 'https://example.meld.io/webhooks/' }, body()],
    ['an altered body', {}, body(VECTOR.body.replace('WEBHOOK_TEST', 'WEBHOOK_TEST '))],
  ])('refuses a signature made with %s', (_name, overrides, delivered) => {
    expect(webhooks(overrides).signatureFault(VECTOR.signature, VECTOR.timestamp, delivered)).toBe('signature mismatch');
  });

  it('refuses the same signature without its padding, or truncated', () => {
    const hooks = webhooks();
    expect(hooks.signatureFault(VECTOR.signature.slice(0, -1), VECTOR.timestamp, body())).toBe('signature mismatch');
    expect(hooks.signatureFault('', VECTOR.timestamp, body())).toBe('signature mismatch');
  });

  it('refuses a timestamp outside the tolerance, either side of now', () => {
    expect(webhooks({ now: at + 300_001 }).signatureFault(VECTOR.signature, VECTOR.timestamp, body())).toBe(
      'signature timestamp outside tolerance',
    );
    expect(webhooks({ now: at - 300_001 }).signatureFault(VECTOR.signature, VECTOR.timestamp, body())).toBe(
      'signature timestamp outside tolerance',
    );
    expect(webhooks({ now: at + 300_000 }).signatureFault(VECTOR.signature, VECTOR.timestamp, body())).toBeUndefined();
  });

  it.each(['May 26 2022 20:25:17', '2022-05-26 20:25:17Z', '2022-13-45T99:99:99Z', '1653596717682'])(
    'refuses a timestamp that is not ISO 8601: %s',
    (timestamp) => {
      expect(webhooks().signatureFault(VECTOR.signature, timestamp, body())).toBe('signature timestamp unreadable');
    },
  );

  it('refuses a delivery missing either header', () => {
    expect(webhooks().signatureFault(undefined, VECTOR.timestamp, body())).toBe('signature headers missing');
    expect(webhooks().signatureFault(VECTOR.signature, undefined, body())).toBe('signature headers missing');
  });
});
