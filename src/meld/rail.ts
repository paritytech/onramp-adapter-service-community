/**
 * The Meld funding rail.
 *
 * Adapts `MeldClient` to the neutral `FundingRail` port. Meld's own transcription (the wire
 * bodies, the redacted `Secret`, the zod reads, all of `src/meld/client.ts`) is untouched; this
 * module only maps the port's neutral shapes onto Meld's. Errors propagate unchanged: the
 * `MeldHttpError`/`Refusal` the client throws reach the server error handler exactly as before,
 * so the 400 -> BelowMinimum / AboveMaximum / NoQuotesAvailable mappings and the retryable
 * `ProviderTimeout` degrade all survive the seam.
 *
 * This rail serves both directions. The one thing it does that a pure rename does not is cross
 * two vocabularies: the port names the crypto leg `destinationCurrencyCode` whichever way value
 * moves, while Meld derives the direction from which of *its* legs holds a crypto, so on a sell
 * the port's destination is Meld's source. That crossing happens in this file and nowhere else,
 * which is the arrangement the port's header asks for: a rail that inverts its legs does so
 * inside itself rather than making every caller hold two namings at once.
 *
 * What a sell does **not** get here is a local amount gate. A buy's is fiat, from the corridor
 * catalog, and a sell commits crypto, so there is no local bound to compare against that means
 * anything (see `onramp.ts`). A sell's floor and ceiling are therefore the provider's own, at
 * quote and session time: Meld answers `INVALID_AMOUNT_TOO_LOW`/`_TOO_HIGH`, which `refusal.ts`
 * maps to the same `BelowMinimum`/`AboveMaximum` a buy would get locally. That is a real
 * difference in where the check happens, not a missing check, and it costs one upstream call to
 * learn — the one case this service's "never spend a call on something refusable locally" rule
 * cannot avoid, because the bound is not known locally.
 */

import type { MeldClient, MeldTransaction } from './client.js';
import type { FundingRecord } from '../funding/types.js';
import type { RailObservation, TransactionMapper } from '../funding/worker.js';
import type {
  FundingRail,
  MeldTransactionReader,
  RailDeposit,
  RailQuote,
  RailSession,
  RailSessionInput,
  RailTransaction,
} from '../rail.js';

/**
 * Meld's transaction status onto the funding lifecycle, by Meld's documented TERMINAL/TEMPORARY
 * split. SETTLED is success; FAILED/DECLINED/CANCELLED/REFUNDED and legacy AUTHORIZATION_EXPIRED
 * conclude as `failed` (the raw status rides in `provider_status` for the buyer-facing wording);
 * ERROR is temporary, so it stays `transaction_seen`; anything unknown is polled, not concluded.
 *
 * **This vocabulary is a buy vocabulary and is not known to be complete for a sell.** Every
 * status in it was observed on this account's purchases; the account has never held a
 * `CRYPTO_SELL` transaction, and Meld exposes no way to enumerate the set (a bogus `?statuses=`
 * filter answers `200` with an empty list rather than naming the enum, and there is no statuses
 * endpoint). A sell has at least one state a buy does not — awaiting the seller's on-chain
 * deposit — and if Meld names it something this list has never seen, the fall-through below
 * reads it as `transaction_seen`, the worker keeps polling, and the row ages out at the local
 * ceiling. That is the safe failure (it never concludes a live sale) and it is still a failure.
 *
 * So the fall-through stays, and nothing sell-shaped is guessed into the list above it. Adding
 * `AWAITING_DEPOSIT` or `PENDING_CRYPTO` here on the strength of their plausibility would be a
 * state machine written from imagination, and the statuses that matter are the terminal ones,
 * where a wrong guess concludes a sale that is still live. The real list comes from one observed
 * sandbox sell, which needs a provider that off-ramps the asset.
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

  /**
   * Price a corridor, either way round.
   *
   * `RailBuyQuote` and Meld's `QuoteParams` are the same five fields under the same names, so a
   * buy needs no translation. A sell does, and the translation is the whole of what this arm is:
   * the port names the crypto leg `destinationCurrencyCode` and the fiat leg
   * `sourceCurrencyCode` in **both** directions (one vocabulary for the consumer, see
   * `rail.ts`), while Meld's quote infers the direction from which of its own legs is a crypto.
   * So the two namings cross here, once, at the seam whose job that is, and the client's
   * parameter names say which leg each value is rather than which field it lands in.
   */
  async quote(input: RailQuote): Promise<unknown[]> {
    if (input.direction === 'sell') {
      return this.client.quoteSell({
        countryCode: input.countryCode,
        // The port's `destinationCurrencyCode` is the crypto leg on a sell as on a buy; it is
        // Meld's *source* that it becomes.
        cryptoCurrencyCode: input.destinationCurrencyCode,
        fiatCurrencyCode: input.sourceCurrencyCode,
        cryptoAmount: input.cryptoAmount,
        paymentMethodType: input.paymentMethodType,
      });
    }
    return this.client.quote(input);
  }

  async createSession(input: RailSessionInput): Promise<RailSession> {
    const session = await this.client.createWidgetSession(
      input.direction === 'sell'
        ? {
            direction: 'sell',
            // Same crossing as `quote`, and the same reason. `destinationCode` is the port's
            // crypto leg; `fiat` is its fiat leg.
            cryptoCurrencyCode: input.destinationCode,
            fiatCurrencyCode: input.fiat,
            cryptoAmount: input.cryptoAmount,
            countryCode: input.countryCode,
            paymentMethodType: input.paymentMethodType,
            serviceProvider: input.serviceProvider,
            clientReference: input.clientReference,
            redirectUrl: input.redirectUrl,
          }
        : {
            direction: 'buy',
            destinationCode: input.destinationCode,
            walletAddress: input.walletAddress,
            sourceAmount: input.sourceAmount,
            sourceCurrency: input.fiat,
            countryCode: input.countryCode,
            paymentMethodType: input.paymentMethodType,
            serviceProvider: input.serviceProvider,
            clientReference: input.clientReference,
            redirectUrl: input.redirectUrl,
          },
    );
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
        if (txn === undefined) return undefined;
        const deposit = depositFrom(record, txn);
        return { id: txn.id, status: txn.status ?? null, ...(deposit === undefined ? {} : { deposit }) };
      },
      mapper: MELD_STATUS_TO_STATE,
    };
  }
}

/**
 * The off-ramp deposit fact, read off Meld's transaction record. `undefined` on a buy, always,
 * and on a sell until the provider discloses one.
 *
 * **The address**: `cryptoDetails.offrampDestinationWalletAddress`, confirmed to exist on the
 * schema and confirmed `null` on every buy record this account has produced. It has never been
 * observed populated -- no sell has been driven through this account's one onboarded provider far
 * enough to produce a transaction at all (DOT_ASSETHUB is not sellable on it; see the probe). That
 * gap is why this reads the field defensively (nullish, not asserted) rather than trusting it.
 *
 * **The amount**: the top-level `sourceAmount`, not `serviceProviderDetails.details.cryptoAmount`.
 * Two reasons, not one. First, `sourceAmount` is already this service's name for the crypto leg of
 * a sell everywhere else in this file (`SellQuoteParams`, `SellWidgetSessionParams`) -- it is the
 * exact amount the seller committed, typed and schema-validated, where
 * `serviceProviderDetails.details` is untyped, per-provider passthrough this service has never
 * had reason to trust. Second, and more directly: this service already knows what the seller
 * committed, from its own row (`FundingRecord.crypto_amount`), and if the two ever disagree the
 * question is not "which field do I read" but "why did the amount change after commitment" -- a
 * question this step does not answer, because no sell has reached this line to raise it. Reusing a
 * field this codebase already reads for the same leg is what makes the wrong guess cheap to
 * correct: if a real sell shows the figure belongs elsewhere, this is the one line that moves,
 * and nothing in `merge.ts`, `store.ts` or the DTO depends on which field feeds it.
 *
 * **The currency**: never read off Meld. It is `record.destination_currency_code`, pinned before
 * the rail was ever called and incapable of legitimately differing from what a sell's deposit
 * address receives, so there is nothing to cross-check by asking the provider to repeat it.
 *
 * **The memo**: always `undefined`. No candidate field exists anywhere in the probed schema (see
 * the probe's §4); Asset Hub does not need one, and a guessed field name would be worse than an
 * honest absence.
 */
function depositFrom(record: FundingRecord, txn: MeldTransaction): RailDeposit | undefined {
  if (record.direction !== 'sell') return undefined;
  const address = txn.cryptoDetails?.offrampDestinationWalletAddress ?? undefined;
  if (address === undefined) return undefined;
  return {
    address,
    ...(txn.sourceAmount === undefined || txn.sourceAmount === null ? {} : { amount: txn.sourceAmount }),
    currency: record.destination_currency_code,
  };
}
