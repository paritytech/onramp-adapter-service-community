/**
 * The context a native Host binds `host_account_create_proof` to, so a proof opens here only under
 * the bytes the Host derived:
 *
 *     blake2_256("product/" || productId || "/" || index_bytes(index))
 *     index_bytes(n) = u32-le(n) || blake2_256("product-account-index")[..28]
 */

import { stringToU8a, u8aConcat } from '@polkadot/util';
import { blake2AsU8a } from '@polkadot/util-crypto';

const INDEX_MAGIC = blake2AsU8a(stringToU8a('product-account-index'), 256).subarray(0, 28);

export function productProofContext(productId: string, index: number): Uint8Array {
  const indexBytes = new Uint8Array(4);
  new DataView(indexBytes.buffer).setUint32(0, index, true);
  return blake2AsU8a(u8aConcat(stringToU8a(`product/${productId}/`), indexBytes, INDEX_MAGIC), 256);
}
