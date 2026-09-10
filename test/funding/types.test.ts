import { describe, expect, it } from 'vitest';

import { fundingRecord } from '../fixtures.js';
import { toFundingRequestDto, type FundingRecord } from '../../src/funding/types.js';

// Every droppable field is populated. Left `undefined`, both `toEqual` and
// `JSON.stringify` ignore an undefined-valued property, so adding `reason`, `clientReference` and
// `hostedWidgetUrl` to the DTO survived all 861 tests while the fixture stayed silent. On real rows
// those fields carry values, and `client_reference` is the caller's own idempotency key, so the
// leak would have shipped past a green suite.
const record: FundingRecord = fundingRecord({
  provider_transaction_id: 'tx-1',
  provider_status: 'SUCCEEDED',
  widget_url: 'https://meldcrypto.com/session/meld-1',
  hosted_widget_url: 'https://meldcrypto.com/s/meldwidget',
  client_reference: 'idem-0000-0001',
  service_provider: 'TRANSAK',
  reason: 'BelowMinimum',
  expires_at: 1_800_000_000_000,
  status: 'transaction_seen',
  status_history: [
    { status: 'session_opened', at: 1_700_000_000_000 },
    { status: 'transaction_seen', at: 1_700_000_000_100 },
  ],
  updated_at: 1_700_000_000_100,
});

// The fixture's rail expiry is 1_800_000_000_000. `BEFORE` sits well inside it and `AFTER` well
// past it, so "still payable" and "page already closed" are two different clocks rather than two
// different fixtures.
const BEFORE = 1_700_000_000_000;
const AFTER = 1_900_000_000_000;

describe('toFundingRequestDto', () => {
  it('carries the settlement surface while the request is live, so a buyer can resume', () => {
    // The gap this closes: a buyer who closed the tab between "continue to payment" and entering a
    // card had no route back. The service knew where the surface was and would not say, because
    // the DTO dropped it on the argument that the creation response already carried it, which
    // holds only for a buyer who still has that response.
    //
    // Named exactly as `CreateSessionResponse` names them, so resuming reuses the code path the
    // client already has for opening.
    const dto = toFundingRequestDto(record, BEFORE);

    expect(dto.serviceProviderWidgetUrl).toBe('https://meldcrypto.com/session/meld-1');
    expect(dto.widgetUrl).toBe('https://meldcrypto.com/s/meldwidget');
    expect(dto.expiresAt).toBe(1_800_000_000_000);
  });

  it('withholds the settlement surface once the rail says the page has closed', () => {
    // A row can be non-terminal and unpayable. `deadlineFor` is
    // `max(expires_at, created_at + session_max_age_ms)`, so a session Meld expired an hour ago
    // stays `session_opened` until the whole window elapses (72 hours, since that window was
    // widened for bank settlement). Gating on status alone offered a dead capture page as
    // resumable for nearly three days, and widening the window made that worse.
    const dto = toFundingRequestDto(record, AFTER);

    expect(dto.status).toBe('transaction_seen');
    expect(dto.serviceProviderWidgetUrl).toBeUndefined();
    expect(dto.widgetUrl).toBeUndefined();
    expect(dto.expiresAt).toBeUndefined();
  });

  it('offers the surface when the rail published no expiry, because nothing says otherwise', () => {
    // The undecidable case, made explicit. With no `expiresAt` there is nothing to compare, and
    // withholding would strand every buyer of a rail that does not publish one.
    const dto = toFundingRequestDto(fundingRecord({ ...record, expires_at: undefined }), AFTER);

    expect(dto.serviceProviderWidgetUrl).toBe('https://meldcrypto.com/session/meld-1');
    expect(dto.expiresAt).toBeUndefined();
  });

  it.each(['settled', 'failed', 'expired', 'refused', 'unobserved'] as const)(
    'withholds the settlement surface from a %s request',
    (status) => {
      // A terminal request has no live surface. Handing a buyer a dead capture page invites a
      // second payment against a purchase that already concluded, and `settled` is the worst of
      // the five, because there the money has already moved.
      const dto = toFundingRequestDto(fundingRecord({ ...record, status }), BEFORE);

      expect(dto.status).toBe(status);
      expect(dto.serviceProviderWidgetUrl).toBeUndefined();
      expect(dto.widgetUrl).toBeUndefined();
      expect(dto.expiresAt).toBeUndefined();
      // The row still carries them; the wire does not.
      expect(JSON.stringify(dto)).not.toContain('meldcrypto.com');
    },
  );

  it('maps a record to the wire shape, dropping every join key', () => {
    const dto = toFundingRequestDto(record, BEFORE);

    expect(dto).toEqual({
      id: 'funding-1',
      rail: 'meld',
      status: 'transaction_seen',
      providerStatus: 'SUCCEEDED',
      destinationCurrencyCode: 'USDC_ASSETHUB',
      walletAddress: '0x...',
      sourceAmount: '25.00',
      fiat: 'USD',
      // Live, so the surface travels; see the resume test below.
      serviceProviderWidgetUrl: 'https://meldcrypto.com/session/meld-1',
      widgetUrl: 'https://meldcrypto.com/s/meldwidget',
      expiresAt: 1_800_000_000_000,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_100,
      history: record.status_history,
    });
  });

  it('surfaces the rail but drops the provider session and transaction ids', () => {
    const dto = toFundingRequestDto(record, BEFORE);

    // The rail is a caller-relevant fact (their support and recovery is rail-aware). The provider
    // ids are join keys for a support conversation and stay off the wire.
    //
    // Asserted on the keys, not on a substring of the body. The fixture's session id is `meld-1`
    // and the settlement URL is `.../session/meld-1`, so a `not.toContain('meld-1')` check now fails
    // for the surface it is meant to permit: it was testing the id and the URL at once, and only
    // passed while both were absent.
    expect(dto.rail).toBe('meld');
    expect(dto).not.toHaveProperty('providerSessionId');
    expect(dto).not.toHaveProperty('providerTransactionId');
    // `providerStatus` is not a join key: it is surfaced on purpose, for the buyer-facing wording.
    expect(dto.providerStatus).toBe('SUCCEEDED');
    expect(dto).not.toHaveProperty('clientReference');
    expect(dto).not.toHaveProperty('reason');
    expect(JSON.stringify(dto)).not.toContain('tx-1');
  });

  it('omits providerStatus until the rail has reported one', () => {
    const dto = toFundingRequestDto(fundingRecord({ ...record, provider_status: undefined }), BEFORE);
    expect(dto).not.toHaveProperty('providerStatus');
  });
});
