import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist', 'node_modules', 'coverage'] },
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // A leading underscore marks a parameter kept for its position in a signature.
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    /**
     * Where a declared contract requires a promise the body does not need.
     *
     * Fastify types route and plugin handlers as async; `CallerAuth` returns `Promise<Subject>`
     * because verifying a real proof will await, even though the dev stand-in does not. The
     * caller gate's `enforce` is a Fastify `preHandler` that only re-raises a decision already
     * made, so it awaits nothing, and it must stay `async`, because a hook that throws
     * synchronously escapes Fastify's hook runner instead of becoming a response. `ChainflipRail`
     * implements a port method that only refuses, and must reject rather than throw
     * synchronously, or a caller reaching for `.catch()` would miss it. Scoped to these five
     * files rather than off globally, which is how it was set before: a pointless `async`
     * anywhere else is still an error. Enabling it caught `auth.ts` at once.
     */
    files: ['src/server.ts', 'src/startup.ts', 'src/auth.ts', 'src/caller.ts', 'src/chainflip/rail.ts'],
    rules: { '@typescript-eslint/require-await': 'off' },
  },
  {
    /**
     * The chart-check script is plain ESM, not part of the TypeScript program.
     *
     * `projectService` resolves every linted file against a tsconfig, and this one is not in any,
     * so type-aware linting fails to parse it entirely. It is still linted for everything that
     * does not need type information, which is what a 90-line script needs.
     */
    files: ['scripts/**/*.mjs'],
    languageOptions: { parserOptions: { projectService: false } },
    ...tseslint.configs.disableTypeChecked,
  },
  {
    files: ['test/**/*.ts'],
    // Fakes stand in for classes with private fields; asserting shapes is the point.
    rules: {
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/require-await': 'off',
    },
  },
);
