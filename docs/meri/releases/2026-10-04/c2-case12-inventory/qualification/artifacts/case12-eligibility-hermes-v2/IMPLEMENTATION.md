# Governed-memory eligibility extraction proposal

Status: incomplete scratch proposal. No tests were run (NOTRUN); supervisor execution is required.

## Intended API

- `canonicalMemoryEligibilitySql({ tenantId, userId, allowedClientIds, memoryItemId? }): Prisma.Sql` returns the canonical predicate without `WHERE`. It retains the source `mi` alias, the optional exact item selector, bound parameters (including empty client arrays), and PostgreSQL `now()` expressions.
- `includeCanonicalGovernedMemoryRow(row, { tenantId, userId, allowedClientIds }): boolean` accepts a `CanonicalGovernedMemoryRow extends GovernedMemoryRecord` with required `visibility`, `legacyStatus`, and `clientId` fields. The original adapter row shape structurally satisfies these requirements.

## Exact-source preservation claim and outstanding integration

The helper's SQL body transcribes the `eligible_base` WHERE conditions from the supplied adapter source, preserving their order, expressions, SQL parameterization, fixed alias, `governedRecallEligibilitySql('mi')`, optional selector, and use of database `now()`. It intentionally makes no new date input. The row helper transcribes the adapter's post-query boolean expression in the same short-circuit order and delegates governance decisions to the real `filterGovernedMemory` and `MEMORY_CLASSES` exports.

The adapter source has NOT yet been updated to call these helpers. Therefore this is not yet a complete behavior-preserving refactor proposal, and no claim is made that production retrieval currently uses the extracted functions. In the adapter, the future minimal integration must replace only the existing WHERE expression with `WHERE ${canonicalMemoryEligibilitySql({ tenantId: request.caller.tenantId, userId: request.caller.userId, allowedClientIds, memoryItemId: request.memoryItemId })}` (preserving the existing optional-selector semantics), and replace the existing `.filter` predicate with `includeCanonicalGovernedMemoryRow(row, { tenantId: request.caller.tenantId, userId: request.caller.userId, allowedClientIds })`. Remove only imports made unused by those replacements. Keep ranking, pagination, embeddings, projection, limits, clocks, error handling, and allowlists unchanged.

The focused Jest spec is written against Prisma SQL fragments and the actual source governance filter. Tests are NOTRUN and have not been verified by a test runner or type checker.

## Limits and future Case12 use

This helper alone proves none of Case12's older-than-500 inventory, current-source/runtime, semantic-clock, capture, or provider-authority requirements. Do not treat it as Case12 admission or capture; do not add a live route/CLI or change fixture owner v1. Any future local inventory inspector must call these exact shared helpers rather than implement a parallel predicate. Supervisor must separately add/run an actual owned rollback PostgreSQL integration to validate the SQL against the relevant schema and demonstrate rollback; this extraction does not replace that requirement.

Only evidence/source and evidence/manifest.json were used as source context. No cloud, shell, database, provider, git, or test execution was performed.