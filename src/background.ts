import { setTimeout as sleep } from 'node:timers/promises';

/** Runs passes one at a time, in call order. A failed pass does not block the next one. */
export type Serial = <T>(pass: () => Promise<T>) => Promise<T>;

export function serial(): Serial {
  let chain: Promise<unknown> = Promise.resolve();
  return <T>(pass: () => Promise<T>): Promise<T> => {
    const next = chain.then(pass, pass);
    chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };
}

/** Abort `controller`, then wait for `running` to settle, for at most `graceMs`. */
export async function stopWithin(controller: AbortController, running: () => Promise<unknown>, graceMs: number): Promise<void> {
  controller.abort();
  if (graceMs <= 0) return;
  const grace = new AbortController();
  try {
    await Promise.race([
      running(),
      // `.catch` because aborting the grace timer below rejects it after the race settled.
      sleep(graceMs, undefined, { signal: grace.signal, ref: false }).catch(() => undefined),
    ]);
  } finally {
    grace.abort();
  }
}

export const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export const isAbort = (error: unknown): boolean => error instanceof Error && error.name === 'AbortError';
