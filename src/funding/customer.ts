/**
 * The stored mapping from a caller's customer key to one Meld customer, and its KYC cache.
 *
 * Keyed by `(product_id, customer_key_hash)`. The hash is the only form of the customer key this
 * service keeps: the public key is discarded once its signature is verified, and Meld is given a
 * random `external_id`, never the key, the hash or the caller's alias.
 */

import { z } from 'zod';

/** A KYC outcome as this service reports it, for Meld's Unified KYC and for each provider. */
export const KYC_STATES = ['none', 'pending', 'approved', 'rejected', 'expired'] as const;

export type KycState = (typeof KYC_STATES)[number];

/**
 * The last KYC states this service learnt, from a customer read or a webhook. A cache, not the
 * truth: Meld's customer record is. `{}` until anything has been learnt.
 */
export const KYC_CACHE = z
  .object({
    /** Meld's Unified KYC (Sumsub). */
    kyc: z.enum(KYC_STATES).exactOptional(),
    /** Keyed by Meld's service provider code. */
    providers: z.record(z.string().min(1), z.enum(KYC_STATES)).exactOptional(),
  })
  .strict();

export type KycCache = z.infer<typeof KYC_CACHE>;

/** One `meld_customers` row. Timestamps are epoch ms. */
export interface MeldCustomerRow {
  product_id: string;
  /** Hex `blake2b-256("onramp:meld-customer-key:" || publicKey)`. */
  customer_key_hash: string;
  meld_customer_id: string;
  /** The random id Meld holds as `externalId`. */
  external_id: string;
  kyc_cache: KycCache;
  created_at: number;
  updated_at: number;
}
