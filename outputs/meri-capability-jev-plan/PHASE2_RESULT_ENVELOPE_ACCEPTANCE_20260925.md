# Phase 2 result envelope package acceptance

Package branch: `phase2-result-envelope-20260925`
Base: `dae05afb7`
Scope: additive shared model-facing contract; no runtime response changes.

## Accepted locally

- Added `MeriResultEnvelope<T>` and `createMeriResultEnvelope` in the shared package.
- The envelope preserves the old payload unchanged and gives search, document, memory, and legislative source observations explicit scope, observed-at, completeness (`complete` / `partial` / `unknown`), continuation, provenance, availability, and source failure fields.
- Execution outcomes keep `blocked`, `needs_input`, `not_found_within_scope`, and `unavailable` distinct. Truncation and structured errors are explicit.
- The constructor takes all semantic metadata as input. It does not infer complete coverage, freshness, not-found, or availability from legacy payload content.
- Focused contract tests: 6/6 passed.
- `@capiro/shared` typecheck and build passed.

## Residual gates

- This package defines and tests the adapter seam; existing tool handlers are not yet wired to emit the envelope. Their legacy response shapes remain unchanged.
- Full API typecheck did not pass in the clean worktree because the generated Prisma client and built `@capiro/meriv2-core` package were unavailable; it reported broad existing missing-generated-client/module errors. The focused test compiled and exercised the shared API successfully.
- The contract cannot certify the truth of source-provided scope, timestamps, completeness, locators, or provenance. Each handler needs source-backed adapter tests before it may report stronger completeness than `unknown`.
- No provider calls, permission changes, tool merging, Hermes activity, deployment, or live coverage claims are included.
