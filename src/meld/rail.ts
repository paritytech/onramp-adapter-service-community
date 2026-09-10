/**
 * The Meld funding rail.
 *
 * Adapts `MeldClient` to the neutral `FundingRail` port. Meld's own transcription (the wire
 * bodies, the redacted `Secret`, the zod reads, all of `src/meld/client.ts`) is untouched; this
 * module only maps the port's neutral shapes onto Meld's. Errors propagate unchanged: the
 * `MeldHttpError`/`Refusal` the client throws reach the server error handler exactly as before,
 * so the 400 -> BelowMinimum / AboveMaximum / NoQuotesAvailable mappings and the retryable
 * `ProviderTimeout` degrade all survive the seam.
 */

import type { MeldClient } from './client.js';
import type { RailObservation, TransactionMapper } from '../funding/worker.js';
import type { FundingRail, MeldTransactionReader, RailQuote, RailSession, RailSessionInput, RailTransaction } from '../rail.js';

/**
 * Meld's transaction status onto the funding lifecycle, by Meld's documented TERMINAL/TEMPORARY
 * split. SETTLED is success; FAILED/DECLINED/CANCELLED/REFUNDED and legacy AUTHORIZATION_EXPIRED
 * conclude as `failed` (the raw status rides in `provider_status` for the buyer-facing wording);
 * ERROR is temporary, so it stays `transaction_seen`; anything unknown is polled, not concluded.
 */
const MELD_STATUS_TO_STATE: TransactionMapper = (status) => {
  const value = status?.toUpperCase();
  if (value === 'SETTLED' || value === 'COMPLETED' || value === 'SUCCESS' || value === 'SUCCEEDED') return 'settled';
  if (
    value === 'FAILED' ||
    value === 'DECLINED' ||
    value === 'CANCELLED' ||
    value === 'REFUNDED' ||
    value === 'AUTHORIZATION_EXPIRED'
  )
    return 'failed';
  return 'transaction_seen';
};

export class MeldRail implements FundingRail, MeldTransactionReader {
  readonly provider = 'meld' as const;

  constructor(private readonly client: MeldClient) {}

  // `RailQuote` and Meld's `QuoteParams` are the same five fields under the same names, so the
  // port needs no translation here. `createSession` genuinely renames `fiat` to `sourceCurrency`
  // and does map field by field.
  async quote(input: RailQuote): Promise<unknown[]> {
    return this.client.quote(input);
  }

  async createSession(input: RailSessionInput): Promise<RailSession> {
    const session = await this.client.createWidgetSession({
      destinationCode: input.destinationCode,
      walletAddress: input.walletAddress,
      sourceAmount: input.sourceAmount,
      sourceCurrency: input.fiat,
      countryCode: input.countryCode,
      paymentMethodType: input.paymentMethodType,
      serviceProvider: input.serviceProvider,
      clientReference: input.clientReference,
      redirectUrl: input.redirectUrl,
    });
    return {
      // Each Meld URL keeps its own meaning. `serviceProviderWidgetUrl` is the provider's capture
      // page and is always present; `widgetUrl` is Meld's own hosted widget and is not.
      settlementUrl: session.serviceProviderWidgetUrl,
      hostedWidgetUrl: session.meldWidgetUrl,
      expiresAt: session.expiresAt,
      providerSessionId: session.meldSessionId,
    };
  }

  async transaction(id: string): Promise<RailTransaction> {
    return this.client.transaction(id);
  }

  /**
   * How the settlement worker observes this rail.
   *
   * The finder looks the transaction up by the reference the session was filed under: this
   * record's own id, which is globally unique by construction.
   */
  observation(): RailObservation {
    return {
      finder: async (record) => {
        // The record's own id, which is what was filed with Meld (not `client_reference`, the
        // caller's key). See `RailSessionInput.clientReference` for why.
        const txn = await this.client.transactionByReference(record.id);
        return txn === undefined ? undefined : { id: txn.id, status: txn.status ?? null };
      },
      mapper: MELD_STATUS_TO_STATE,
    };
  }
}
