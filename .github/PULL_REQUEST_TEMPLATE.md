<!-- Thanks for contributing. Keep the PR to one concern. Open several small PRs rather than one large one. -->

## What this changes

<!-- One or two sentences: what does this PR do, and for whom? -->

## Why

<!-- The problem, issue, or feedback this answers. Link the issue it closes or addresses. -->

## How it was tested

<!-- What you actually ran. Name the route or the branch you exercised, and say whether a real
     Postgres and a real rail were involved or whether it was the fakes. -->

## Gates

- [ ] `npm run verify` (typecheck, lint, test, build)
- [ ] `npm run test:e2e`
- [ ] `npm run check:chart`
- [ ] Scope is one concern, and unrelated changes are not bundled in
- [ ] Docs updated in the same PR if a route, config key or response shape changed
- [ ] No `Co-Authored-By` lines: they fail the paritytech CLA check
- [ ] No secrets, keys, or real credentials added to the repo or to a test fixture

## Related

<!-- Closes #NN, or Addresses #NN / part of #NN -->
