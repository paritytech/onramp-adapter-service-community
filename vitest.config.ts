import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    /**
     * The end-to-end suite is excluded here and run by `vitest.e2e.config.ts`.
     *
     * It spawns the built artifact as a real process, so it is slow, needs `npm run build` first,
     * and would distort the coverage gate below: it exercises `src/main.ts`, which is excluded
     * from coverage precisely because a unit test cannot reach it.
     */
    exclude: ['test/e2e/**', '**/node_modules/**'],
    coverage: {
      include: ['src/**/*.ts'],
      /**
       * `main.ts` is the process shim: an env read, two signal handlers and an exit code, with
       * no branch a unit test could take. Everything that used to sit beside it now lives in
       * `startup.ts`, which is measured. `audit.ts` is types only and compiles to nothing, so a
       * 0% row would read as untested code rather than as no code.
       */
      exclude: ['src/main.ts', 'src/audit.ts'],
      /**
       * Gated, not merely measured; `npm test` passes `--coverage`, which is what makes
       * that true. Thresholds alone do nothing, because vitest only evaluates them when coverage
       * is collected, so for as long as the script was a bare `vitest run` the gate below was
       * configuration nobody enforced. Adding an entirely uncovered exported function passed CI.
       * Turning it on immediately found two real uncovered paths. The README claims 100% of
       * statements and functions, and until now nothing enforced it. A claim about test coverage
       * that the build would not defend is exactly the kind that slips through.
       *
       * Branches and lines are deliberately not at 100%: they would force tests for
       * unreachable defensive paths.
       */
      thresholds: { statements: 100, functions: 100 },
    },
  },
});
