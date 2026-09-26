# Package 8 semantic-candidate validation — 2026-09-26

This evidence covers the DTIC/JDOCS XML semantic candidate extractor. It is a
candidate-only qualification primitive and does not register a source, persist
a parser artifact, establish family completeness, or authorize import,
replay, or publication.

## Assertions

- The API TypeScript check passed:
  `pnpm --filter @capiro/api exec tsc --noEmit --pretty false`.
- The focused DTIC inspector suite passed: 1 suite and 13 tests.
- The real pinned FY2026 DTIC XML smoke test passed against
  `tmp/p8-dtic-20260925/dtic.xml`, whose SHA-256 is
  `02479cd6e67dfee10bb1029d9413dbc35e81174384b25319fedfb9589d4aac6a`.
  It emitted two PE records (`0605801KA`, `0605998KA`) with 10 and 9 field
  locators respectively.
- Prefix-renamed fixtures produced identical typed records and locators while
  changing the original-byte SHA, proving that paths are namespace-expanded
  and source-bound rather than prefix-bound.
- Missing required fields and non-canonical numeric text are hard failures.
- The trusted `apps/defense-api/runtime-source` mirror is byte-for-byte equal
  to the API source and focused spec after this change.

## Boundary

The extractor does not claim PDF reconciliation, annual-family or component
completeness, human review, expected-source registration, durable semantic
artifact persistence, historical replay, or canonical publication. The
candidate remains `status: candidate_only` and `promotable: false`; all
protected ingestion/publication flags remain false.
