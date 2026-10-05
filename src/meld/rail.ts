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
import { canonicalizeDisclosedAddress } from '../address.js';
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
   * record's own id, which is globally unique by construction. A sell asks Meld's per-session
   * path first, the lookup Meld documents for reading a sale's deposit address, and falls back to
   * the reference while that has nothing.
   *
   * It falls back the same way when the per-session lookup fails, whatever the failure (a 5xx,
   * another 4xx, a transport error, a body that does not read): the reference can still answer,
   * and a throw here would fail the poll and count towards the worker's failure ceiling for every
   * sell in the tick. Only the reference's own failure propagates, so the finder throws only when
   * neither lookup could answer. The swallowed failure is not logged: neither this rail nor its
   * client holds a logger.
   */
  observation(): RailObservation {
    return {
      finder: async (record) => {
        const bySession =
          record.direction === 'sell' && record.provider_session_id !== undefined
            ? await this.client.transactionBySession(record.provider_session_id).catch(() => undefined)
            : undefined;
        // The record's own id, which is what was filed with Meld (not `client_reference`, the
        // caller's key). See `RailSessionInput.clientReference` for why.
        const txn = bySession ?? (await this.client.transactionByReference(record.id));
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
 * and on a sell until the provider's transaction names all three of where, how much and what.
 *
 * Meld's preferred off-ramp flow is to read the token (`sourceCurrencyCode`), the amount
 * (`sourceAmount`) and the deposit address off the transaction and send exactly that, so all three
 * come from the provider and none from this row. A client holds them against the terms it agreed
 * to and refuses a difference, which only works if the disclosure carries the provider's word: an
 * asset or an amount filled in from this row would always agree with itself.
 *
 * **The address**: `cryptoDetails.destinationWalletAddress ?? offrampDestinationWalletAddress`,
 * as Meld advises for either side of `Meld-Version` 2025-03-04, a blank one read as absent. Both
 * present and naming different accounts discloses nothing. Never `sourceWalletAddress`,
 * `sessionWalletAddress` or `walletAddress`, which are the seller's own.
 *
 * **The amount**: the top-level `sourceAmount`, not `serviceProviderDetails.details.cryptoAmount`,
 * which is untyped per-provider passthrough. Withheld while the transaction carries none.
 *
 * **The currency**: the top-level `sourceCurrencyCode`. Withheld while the transaction carries
 * none. Whether the provider honours the locked asset on a sell is unverified, so the row's own
 * `destination_currency_code` is not a stand-in for it.
 *
 * **The memo**: always `undefined`. No candidate field exists anywhere in the probed schema (see
 * the probe's §4); Asset Hub does not need one, and a guessed field name would be worse than an
 * honest absence.
 */
function depositFrom(record: FundingRecord, txn: MeldTransaction): RailDeposit | undefined {
  if (record.direction !== 'sell') return undefined;
  // Meld's own advice for reading it under any Meld-Version: the new name, then the old one. A blank
  // field is an absent one. Two fields that name different accounts leave nothing to choose by, so
  // neither is disclosed.
  const details = txn.cryptoDetails;
  const named = given(details?.destinationWalletAddress);
  const former = given(details?.offrampDestinationWalletAddress);
  if (named !== undefined && former !== undefined && !sameAccount(named, former)) return undefined;
  const address = named ?? former;
  const amount = given(txn.sourceAmount);
  const currency = given(txn.sourceCurrencyCode);
  if (address === undefined || amount === undefined || currency === undefined) return undefined;
  return { address, amount, currency };
}

/** What Meld sent in a field, or `undefined` for one that is missing or blank. */
function given(value: string | null | undefined): string | undefined {
  return value === null || value === undefined || value.trim() === '' ? undefined : value;
}

/** Whether two disclosed addresses are one account, whatever their SS58 prefix. */
function sameAccount(a: string, b: string): boolean {
  const canonical = canonicalizeDisclosedAddress(a);
  return canonical !== undefined && canonical === canonicalizeDisclosedAddress(b);
}
