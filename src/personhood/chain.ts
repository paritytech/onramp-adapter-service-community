/**
 * A minimal Substrate RPC client over WebSocket: just enough to read one chain storage value
 * by its full hex key.
 *
 * This avoids pulling in the polkadot-api descriptor/client tower for a single storage read.
 * The People-chain storage keys this module reads are hashed in `key.ts` (which owns the pallet key
 * layout); here the reader stays a dumb transport: connect, send one `state_getStorage`, resolve
 * the `0x`-hex value (or `undefined` for None), close.
 *
 * A connection is opened per call. That is the right shape for the low-rate register path and
 * leaves no long-lived socket to guard; if the register path ever gets hot, a pooled client can
 * slot in behind the same `ChainReader` port without the routes changing.
 */

import { randomUUID } from 'node:crypto';

export interface ChainReader {
  /**
   * One round-trip. Resolves the hex value for a present entry, `undefined` for a None option.
   */
  getStorage(key: string): Promise<string | undefined>;
}

/**
 * Build a reader bound to a `ws://`/`wss://` endpoint using node's global `WebSocket`.
 */
export function chainReader(url: string, timeoutMs = 8_000): ChainReader {
  return {
    // A fresh socket per call: low-rate path, no long-lived connection to babysit.
    async getStorage(key: string): Promise<string | undefined> {
      const id = randomUUID();
      return new Promise((resolve, reject) => {
        let closed = false;
        const settle = (err: Error | null, value?: string): void => {
          if (closed) return;
          closed = true;
          clearTimeout(timer);
          socket.close();
          if (err) {
            reject(err);
          } else {
            resolve(value);
          }
        };

        // The socket is constructed before the timer that can call `settle`, and its failure
        // is caught. `new WebSocket` throws synchronously on a scheme it does not serve (an
        // `https://` URL passes `z.url()`), and with the timer already armed that throw left the
        // promise unsettled and the callback reaching a `socket` still in its temporal dead
        // zone. A ReferenceError inside a timer is an uncaught exception, not a failed request.
        let socket: WebSocket;
        try {
          socket = new WebSocket(url);
        } catch (cause) {
          reject(new Error(`RPC endpoint ${url} could not be opened: ${cause instanceof Error ? cause.message : 'unknown'}`));
          return;
        }

        const timer = setTimeout(() => {
          settle(new Error(`RPC state_getStorage timed out after ${String(timeoutMs)} ms`));
        }, timeoutMs);

        socket.addEventListener('open', () => {
          socket.send(JSON.stringify({ jsonrpc: '2.0', id, method: 'state_getStorage', params: [key] }));
        });
        socket.addEventListener('message', (event) => {
          const raw = ((): unknown => {
            try {
              return JSON.parse(String(event.data));
            } catch {
              return undefined; // not a JSON-RPC message we understand; keep waiting for our id
            }
          })();
          const data =
            raw !== null && typeof raw === 'object'
              ? (raw as { error?: { message?: string }; id?: unknown; result?: unknown })
              : undefined;
          if (data === undefined || data.id !== id) return;
          if (data.error) {
            settle(new Error(data.error.message ?? 'RPC error'));
          } else {
            // A Substrate None query resolves to `null`; a present value to `"0x..."`.
            settle(null, typeof data.result === 'string' ? data.result : undefined);
          }
        });
        socket.addEventListener('error', () => {
          settle(new Error(`WebSocket connection failed to ${url}`));
        });
      });
    },
  };
}