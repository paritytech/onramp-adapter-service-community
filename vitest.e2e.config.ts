import { defineConfig } from 'vitest/config';

/**
 * The end-to-end suite: the built artifact, spawned as a real process, over a real socket.
 *
 * Separate from the unit config because it answers a different question and pays a different
 * price. No coverage thresholds: these tests cover the seams a unit test structurally cannot
 * reach (the process entrypoint, signal handling, a config file on disk, a store that outlives
 * one process), not lines.
 *
 * Single-threaded: each test binds a port and spawns a process, and running them concurrently
 * makes failures look like flakes.
 */
export default defineConfig({
  test: {
    // Everything under `test/e2e`, not only `*.e2e.test.ts`. The unit config excludes the whole
    // directory, so a narrower pattern here left a file matching neither: linted, type-checked,
    // and run by nothing.
    include: ['test/e2e/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    pool: 'forks',
    maxWorkers: 1,
  },
});
