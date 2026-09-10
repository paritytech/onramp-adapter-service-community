/**
 * The Chainflip funding rail.
 *
 * Registered, and refuses both of its legs. Chainflip swaps one on-chain asset for another
 * and has no fiat leg, so a card purchase in EUR has no correct source asset, no correct amount
 * (a chain amount is not a two-decimal fiat string) and no correct destination (Meld's catalog
 * vocabulary is not Chainflip's). Making it a funding rail needs a fiat on-ramp in front of the
 * swap, and that design does not exist.
 *
 * It stays registered rather than absent so a caller asking for `rail: "chainflip"` is told the
 * real reason instead of "rail not wired", and so the rail seam keeps a second implementer,
 * which is the honest stub this should have been in the first place.
 */

import { noQuotesAvailable, reject } from '../contract.js';
import type { FundingRail, RailQuote, RailSession, RailSessionInput } from '../rail.js';

/** The registered stub: implements the seam, refuses both legs with the reason. */
export class ChainflipRail implements FundingRail {
  readonly provider = 'chainflip' as const;

  /**
   * Quote is intentionally unwired. Chainflip prices its swaps on-chain at swap time; there is no
   * broker-API quote this service can truthfully answer with, so it refuses rather than guesses.
   */
  // `async`, so the refusal arrives as a rejected promise rather than thrown synchronously from a
  // function declared to return one. `await` hides the difference; a caller using `.catch()` does
  // not, and the throw would go straight past it.
  async quote(_input: RailQuote): Promise<unknown[]> {
    throw noQuotesAvailable(
      'Chainflip has no broker quote endpoint; the buyer price is set on-chain at swap time.',
    );
  }

  /**
   * Also unwired, and for a harder reason than `quote`; see the file header for why.
   *
   * Refusing beats guessing a mapping that moves a buyer's money to the wrong place: a fiat code
   * is not a `sourceAsset`, a two-decimal fiat string is not a chain amount, and a deposit address
   * is not the WebView URL the wire contract documents.
   */
  async createSession(_input: RailSessionInput): Promise<RailSession> {
    throw reject(
      { tag: 'Other', value: { code: 'RAIL_REFUSED', message: 'The funding rail refused this request.' } },
      'Chainflip has no fiat leg: the asset and amount mapping for a card purchase is not defined.',
    );
  }
}
