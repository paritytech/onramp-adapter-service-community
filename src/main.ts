/**
 * The process. Everything with a branch in it lives in `startup.ts`, which is tested.
 *
 * What is left here cannot be unit-tested without testing Node itself: read an environment
 * variable, own two signals, choose an exit code. It is exercised end to end instead (booting
 * the built output against a fake Meld) and is kept small enough that reading it is the
 * review.
 */

import { start } from './startup.js';

const CONFIG_PATH = process.env.CONFIG_PATH ?? 'config.json';

start(CONFIG_PATH)
  .then(({ close }) => {
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
      process.once(signal, () => void close());
    }
  })
  .catch((error: unknown) => {
    // No logger on the config and secret paths, and this must be readable in a crash loop.
    // `Secret` redacts itself, so a message that quotes one is still safe to print.
    console.error(`Startup failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
