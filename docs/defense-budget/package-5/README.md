# Defense-budget Package 5 — program and acquisition continuity

Package 5 adds effective-dated program identity continuity and evidence-qualified acquisition relationships without implying unsupported financial allocation. The release is intentionally dark: the projector schedule is disabled, committed projection requires `PROGRAM_ACQUISITION_CONTINUITY_ENABLED=true`, and existing source records are not fetched or modified by this package.

## Delivered scope

- Append-only, bitemporal identity crosswalks for programs, program elements, PE projects, procurement lines, MDAP identities, and source-native program identities.
- Explicit predecessor, successor, split, merge, same-as, and related-to relationships with source, evidence, confidence, review state, fiscal-year validity, and recorded-time history.
- Immutable source revisions for notices, solicitations, vehicles, orders, awards, and modifications. Parent vehicle, order, award, and correction lineage is retained.
- Immutable signed award-transaction deltas. Deobligations and corrections remain negative and are never silently converted to positive spending.
- Evidence-qualified program/acquisition relationships separated into source-stated financial allocation, deterministic financial allocation, reviewed association, inferred relevance, and unresolved states.
- Database constraints and read-time sanitization ensure only verified source-stated or deterministic relationships may expose an allocated dollar amount.
- Explicit coverage gaps for unsupported allocations and missing transaction history. Unknown coverage is never represented as zero.
- Bitemporal, cursor-paginated readers for program, PE, and procurement-line acquisition paths with accepted, candidate, and unresolved results separated.
- Award identity and portfolio projection deduplicate one authoritative USAspending award reached through multiple program paths while preserving each evidentiary path.
- A local-data projector for existing SAM and federal-award records. It performs no network collection, defaults to dry-run, and requires both `--commit` and the exact activation flag for writes.
- One disabled EventBridge schedule definition for bounded daily projection.

## Activation boundary

Do not enable the Package 5 schedule or set `PROGRAM_ACQUISITION_CONTINUITY_ENABLED=true` until operators approve the initial source coverage and the unresolved-allocation queue. Package 5 does not turn reviewed associations, inferred relevance, or textual co-occurrence into financial allocations. It does not combine account totals with award transaction deltas, and it does not make Package 3 congressional inputs authoritative.

## Evidence

- [Validation evidence](./validation-evidence-2026-09-24.md)
- [Machine-readable qualification](./qualification-2026-09-24.json)
