# Defense-Budget Non-RDT&E Cycle Runbook

## Scope and safety boundary

Phase 5 covers:

```text
Procurement: P-1 → P-40 → P-5/P-5A/P-21/P-3A
O&M:         O-1 → OP-5
MILCON:      C-1 → DD1391
```

Phase 5 performs semantic extraction, trusted verification, family reconciliation, cycle certification, and **read-only** future-canonical projection planning. It does not promote or write Procurement, O&M, MILCON, or Program Element data. None of the commands below accepts `--commit`.

## Prerequisites

1. Phase 1–4 closeouts are present on the exact working SHA.
2. A reviewed annual manifest exists. Every Phase 5 document must declare its exact `account`, `expectedSourceSha256`, family, exhibit, component, parser policy, and required/optional status.
3. Phase 3 has already produced a persisted `defense_budget_parser_result_v1` JSON. The current Phase 5 extraction command is a complete-single-result replay boundary: every requested page must have succeeded in that result. A partial result is rejected rather than treated as a complete document. Multi-engine page selection remains owned by the Phase 3 router/compositor and must be integrated through a composed-output semantic factory before it can be represented as one Phase 5 input.
4. Production trusted verification requires a real `SourceDocument` ID and the Phase 2 production proof boundary. Local inspect verification remains read-only and is not durable production proof.

## Exit codes

| Code | Meaning                                            |
| ---: | -------------------------------------------------- |
|    0 | Complete/pass                                      |
|    2 | Needs review                                       |
|    3 | Incomplete or rejected by a missing required input |
|    4 | Rejected by trusted verification/certification     |
|    5 | Operational or contract failure                    |

## Input maps

### Parser map

The extraction command consumes one complete, content-addressed Phase 3 result per manifest document:

```json
{
  "p1-army": {
    "parserResultPath": "/absolute/path/p1-army.parser-result.json",
    "parserResultByteSha256": "<sha256-of-exact-json-bytes>",
    "sourceDocumentId": "<optional-uuid>"
  }
}
```

The parser result must account for its entire requested page set. Any failed or missing requested page makes this replay input invalid; do not delete failed pages or narrow `requestedPages` to make it pass.

### Artifact map

Extraction writes `artifact-map.json`. Each entry binds the artifact, parser result, parser-result byte SHA, and optional SourceDocument ID. Do not edit it by hand.

### Verification jobs

```json
{
  "p1-army": {
    "sourceDocumentId": "<uuid>",
    "referenceFile": "/absolute/path/p1-reference-descriptors.json"
  }
}
```

`referenceFile` uses the merged Phase 2 strict reference descriptor contract. It is optional only when the selected Phase 2 policy does not require a comparison.

## Operator workflow

### 1. Local/free manifest preflight

```bash
pnpm --dir apps/api exec tsx scripts/inspect-defense-budget-non-rdte.ts \
  --manifest <fy-manifest.json> \
  --family procurement
```

This validates manifest semantics and reports missing source SHA, account, family profile, or required-document configuration. It makes no network, database, AWS, or provider call.

### 2. Phase 3 parse/router action

Run the merged Phase 3 workflow separately. Paid pages, when separately authorized, remain controlled exclusively by Phase 3’s cumulative page cap. Phase 5 has no paid-parser flag.

When Phase 3 required several engines for different pages, do not select one raw run and discard the other selected pages. Use a composed-output integration that preserves all selected parser runs and page lineage. Until that integration is present in the Phase 5 operator path, treat such a document as incomplete rather than manufacturing a single-result artifact.

### 3. Build proof-bound semantic artifacts

```bash
pnpm --dir apps/api exec tsx scripts/extract-defense-budget-non-rdte.ts \
  --manifest <fy-manifest.json> \
  --parser-map <parser-map.json> \
  --family procurement \
  --out-dir <artifacts-dir>
```

The command:

- independently hashes the exact parser-result bytes;
- verifies the strict Phase 3 result content SHA;
- rejects partial results whose requested pages are not all successful and present;
- creates a real parser-run record with exact method, version, config SHA, source SHA, result SHA, and page ranges;
- rejects synthetic/manual fallback provenance;
- verifies every evidence page is covered by the exact parser result;
- emits `defense_budget_extraction_v1` artifacts;
- writes `artifact-map.json`;
- returns incomplete when a required document is missing, empty, lacks an expected line kind, or has incomplete required source-fact coverage.

### 4. Run the merged Phase 2 trusted verifier

Read-only inspect mode:

```bash
pnpm --dir apps/api exec tsx scripts/verify-defense-budget-non-rdte.ts \
  --manifest <fy-manifest.json> \
  --artifact-map <artifacts-dir/artifact-map.json> \
  --verification-jobs <verification-jobs.json> \
  --family procurement \
  --out-dir <verification-dir>
```

Durable audit mode, only in an authorized environment with the full production proof boundary:

```bash
pnpm --dir apps/api exec tsx scripts/verify-defense-budget-non-rdte.ts \
  --manifest <fy-manifest.json> \
  --artifact-map <artifact-map.json> \
  --verification-jobs <verification-jobs.json> \
  --family procurement \
  --out-dir <verification-dir> \
  --persist-audit
```

This delegates to `verify-defense-budget-extraction-v1.ts`; Phase 5 does not define a weaker verifier. It writes `verification-results.json` and `verification-refs.json`.

### 5. Compose and certify one family

```bash
pnpm --dir apps/api exec tsx scripts/certify-defense-budget-non-rdte.ts \
  --manifest <fy-manifest.json> \
  --artifact-map <artifact-map.json> \
  --verification-results <verification-results.json> \
  --verification-refs <verification-refs.json> \
  --family procurement \
  --out-dir <cycle-dir>
```

Certification:

- re-verifies parser-result byte and content proof;
- verifies each Phase 2 result matches the exact artifact, source SHA, candidate, run, and decision;
- composes only accepted assertion IDs;
- retains rejected/unaccepted assertions outside the family view;
- treats missing required documents and comparison controls as incomplete/not-run, never pass;
- keeps MILCON projects distinct by component + account + project number + location;
- writes the family report, cycle bundle, and certification JSON.

A Phase 2 `NEEDS_REVIEW` result remains non-projectable in Phase 5. The operator and exported proof-bound planner accept no caller-supplied decision-ID allowlist. A governed review acceptance must be independently persisted and proved by the later authenticated promotion workflow; it cannot be simulated with a command-line file or in-memory set.

### 6. Build the read-only projection plan

```bash
pnpm --dir apps/api exec tsx scripts/plan-defense-budget-non-rdte-projection.ts \
  --manifest <fy-manifest.json> \
  --bundle <cycle-dir/procurement-cycle-bundle.json> \
  --family-report <cycle-dir/procurement-family-report.json> \
  --artifact-map <artifact-map.json> \
  --verification-results <verification-results.json> \
  --family procurement \
  --out <cycle-dir/procurement-projection-plan.json>
```

The projection wrapper requires:

- `CERTIFIED_NON_RDTE_READY_FOR_PROJECTION`;
- exact parser-result proof;
- an exact Phase 2 `VERIFICATION_PASSED` result;
- accepted assertion-level ledgers;
- nonempty assertion and evidence ledgers for every candidate;
- manifest-owned MILCON account context.

`--canonical-rows <read-only-snapshot.json>` may be provided for a deterministic diff. No database client is instantiated.

## Native future-canonical schema

Migration:

```text
20260818030000_non_rdte_phase5_projection_schema
```

It additively creates native Procurement, O&M, and MILCON tables plus proof-bound source observations and relationships. It does not backfill, load, rewrite, or reference `program_element`. The schema remains unwritten until Phase 7.

No manual backfill is required for this Phase 5 migration.

## Manual closeout when GitHub Actions is unavailable

From repository root:

```bash
pnpm --dir apps/api exec tsx \
  scripts/verify-pe-budget-phase-5-closeout.ts \
  --include-containers
```

The matrix runs:

- merged Phase 1–4 closeout;
- Phase 5 family/proof/projection/operator tests;
- strict Phase 5 TypeScript;
- primary and dedicated projection Prisma validate/generate;
- all 20 mutate-fail-restore controls;
- disposable PostgreSQL 16 fresh and pre-Phase-5 upgrade rehearsal;
- locked Python parser Ruff, mypy, and pytest;
- Phase 3/4 container checks when `--include-containers` is supplied;
- Prettier and `git diff --check`.

The closeout clears cloud/provider credentials and performs no AWS call, paid parse, shared migration, or canonical write.

## Recovery

- **Corrupt parser cache/result:** remove only the corrupt content-addressed result and rerun Phase 3. Never override the expected SHA.
- **Partial parser result:** return to Phase 3 and produce a complete/composed result. Never drop failed pages from the request ledger.
- **Unsupported layout:** preserve the artifact/omission and mark the required document incomplete or needs review. Do not create an empty success.
- **Verification mismatch:** regenerate neither source facts nor IDs. Resolve the exact source/artifact/proof discrepancy and rerun the same job.
- **Migration rehearsal failure:** do not apply the migration to a shared environment. Repair forward on the branch and rerun both paths.
- **Projection failure:** inspect assertion/evidence/verification ledgers. Do not bypass the proof-bound wrapper or call the legacy planner directly.

## Phase 7 boundary

Phase 7 still owns the writer, transactional idempotency, governed review-proof consumption, legacy procurement migration/cutover decisions, read-path adoption, and any production data promotion. Phase 5 readiness must never be described as completed canonical ingestion.
