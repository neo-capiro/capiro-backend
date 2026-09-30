# Capture producer foundation qualification

This increment adds signed server capture receipts to the API and orchestrator. It preserves the current source/child/durable-task guards while connecting actual task usage observations. Missing provider usage, cache coverage, source ownership, fixture identity, or deployment proof remains unknown or blocked.

The integration starts from foundation `dcdbe0152ffcb84a84c6a785413b0465dfa0185a` and selectively incorporates producer commit `15b072c389dc37193caba1c32e5b9c40a10c7639`. It does not merge that donor's older branch history. Discovery controls are recorded as read-only capture executions while remaining excluded from document and durable task observers. Ordinary compaction continues excluding internal governed artifacts.

## Verification

- Shared/core builds, API/runtime type checks and production TypeScript builds: exit 0.
- Capture regression suites: 122 runtime tests, 59 proxy tests, 18 API authority/persistence tests, and 8 core signature tests; all exit 0. The last two API tests directly check output-fence release and revocation after immutable turn binding.
- Real local PostgreSQL JSONB round trip: before repair exit 1, after repair exit 0. Object key reordering previously broke HMAC verification. Signing and envelope hashing now use canonical JSON; receipt readback uses structural equality. Value tampering still fails.
- Formatting and diff checks passed. Independent Hermes/Kimi review identified the JSONB problem; raw findings, source snapshots, follow-up dispositions and terminal exits are retained with the qualification evidence.

The isolated candidate's runtime dependency junction points at the foundation checkout. Candidate verification therefore explicitly maps core/shared exports to the candidate's built outputs. Standard package gates must also run after integration into foundation; these mappings do not establish hosted CI success.

Evidence is retained under `C:\dev\cap-meri-foundation-evidence\capture-foundation-validation`, with independent review artifacts alongside that directory. The local PostgreSQL probe uses a JSONB SELECT and makes no schema or data changes. Provider calls, shared fixture creation, AWS deployment and live acceptance were not run for this qualification.

## Remaining acceptance

This is a producer qualification, not full File01 or Workstream A completion. The live collector/verifier remains closed pending canonical source/fixture binding, approved build/digest cross-checks, exhaustive effects evidence, reviewed fixture lifecycle and live acceptance. API-only receipts intentionally remain blocked when actual tool/source joins are absent. Do not invent tool calls or exempt join checks to turn these receipts green.
