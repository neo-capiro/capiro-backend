# Phase 3 — Cost-Aware Defense-Budget Parser Router V1

> **STATUS: IMPLEMENTATION COMPLETE ON CLOSEOUT BRANCH — NOT MERGED OR DEPLOYED**
>
> Phase 3 now contains an executable local-first parser workflow, strict replay
> proof, bounded paid escalation, Phase 2 verification integration, operator
> commands, permanent architecture gates, and 20 real defect-injection
> controls. The validation commands in this document must be executed in a
> repository runtime before merge; this document does not claim they ran in the
> GitHub connector session.

## 1. Purpose and trust boundary

The router answers:

> Which parser should process each supplied source page, what exact output did
> each parser produce, can that output be replayed without paying again, and
> which explicitly identified pages need a stronger parser?

It does not answer:

> May these assertions be written to canonical Program Element tables?

No Phase 3 code imports a canonical Program Element writer, creates a promotion
record, discovers sources automatically, schedules work, deploys infrastructure,
or writes canonical data.

## 2. Executable flow

```text
manual manifest + supplied source bytes
              ↓
recompute source SHA-256
              ↓
cheap full-document pdfplumber profile
              ↓
deterministic local-first route plan
              ↓
execute or cryptographically replay exact parser runs
              ↓
deterministic page-result composition
              ↓
strict defense_budget_extraction_v1 artifact
              ↓
Phase 2 inspect or explicit audit-persist verification
              ↓
evidence-backed finding → exact page escalation
              ↓
local fallback or explicitly authorized bounded LlamaParse
              ↓
terminal PASS / REVIEW / REJECT report
```

The router enforces this state sequence:

```text
PLANNED
  → RUNNING_LOCAL
  → LOCAL_COMPLETE
  → VERIFYING
  → ESCALATION_PLANNED
      → RUNNING_LOCAL → LOCAL_COMPLETE → VERIFYING
      → RUNNING_PAID  → PAID_COMPLETE  → VERIFYING
  → TERMINAL_PASSED | TERMINAL_REVIEW | TERMINAL_REJECTED | FAILED
```

Terminal states have no outgoing transition.

## 3. Parser policy behavior

| Manifest policy | Initial behavior | Escalation |
|---|---|---|
| `native_structured` | Requires an explicitly supplied Phase 1 V1 companion; no PDF parser fallback | Companion is identity-checked and sent directly through Phase 2 |
| `deterministic_table` | pdfplumber on clean digital pages | Camelot → Docling → authorized LlamaParse |
| `mixed_layout` | Docling on digital mixed-layout pages; PaddleOCR on image-only pages | Camelot where table-specific → authorized LlamaParse |
| `ocr` | Embedded-text pages still use pdfplumber; image-only pages use PaddleOCR | Docling/Camelot → authorized LlamaParse |
| `complex` | Local profiling, then pdfplumber/Docling/PaddleOCR according to page evidence | authorized LlamaParse for unresolved explicit pages only |

A high risk score alone never creates a paid call. LlamaParse requires:

```text
--allow-paid-parse
--max-paid-pages <positive integer>
```

The executor submits only the selected one-based pages converted to zero-based
`targetPages` at the provider boundary exactly once.

## 4. Cross-language runtime

The isolated runtime is under:

```text
apps/defense-budget-parser/
```

It exposes:

```bash
uv run capiro-defense-budget-parser validate-job --job <job.json>
uv run capiro-defense-budget-parser profile --job <job.json> --out <profile.json>
uv run capiro-defense-budget-parser run --job <job.json> --out <result.json>
uv run capiro-defense-budget-parser version --json
```

The runtime validates strict Pydantic contracts before execution and dispatches:

- pdfplumber;
- Camelot;
- Docling CPU;
- PaddleOCR PP-StructureV3 CPU.

It performs no AWS, database, LlamaParse, verification, tenant, or canonical
work. The Node runtime discovers exact engine versions through `version --json`
and uses the same default configuration documents as Python when computing
parser-run identities.

## 5. Exact parser identity and replay

The parser-run identity is:

```text
source SHA
+ method
+ exact runtime version
+ exact parser configuration SHA
+ sorted one-based page set
+ runtime contract version
```

Before replay, the store verifies:

1. descriptor schema;
2. cache key;
3. actual result bytes;
4. result byte SHA;
5. strict result schema;
6. canonical result content SHA;
7. source SHA;
8. method;
9. parser version;
10. parser configuration SHA;
11. exact requested pages.

A failed check makes the cache unusable and causes a new execution only when
that execution is otherwise authorized.

### Storage modes

- Local/inspect output: content-addressed filesystem store.
- Production local-parser proof: explicitly configured shared filesystem root
  through `BUDGET_VERIFICATION_PARSER_ARTIFACT_ROOT`.
- Persisted LlamaParse normalized output: versioned S3 using
  `BUDGET_VERIFICATION_LLAMAPARSE_OUTPUT_BUCKET`.
- S3 replay requires and reads the exact VersionId.
- A proof-bound recorder re-reads the persisted locator and recomputes its byte
  SHA before writing `DocumentParseJob` metadata.

## 6. Phase 1 artifact bridge

The bridge emits the strict Phase 1 envelope:

```text
schemaVersion
artifactId
contentSha256
source
parserRuns
evidence
sourceFacts
assertions
warnings
omissions
summary
```

It records exact contributing parser runs, exact page ranges, page evidence,
and parser audit facts. It never invents budget assertions or bounding boxes.

The generic page bridge therefore adds a review warning when no registered
family-specific extraction adapter has produced budget assertions. This is a
truthful terminal review, not a false verification pass. A caller may inject a
registered family artifact factory; complete RDT&E semantic extraction remains
owned by the downstream RDT&E phase.

Router-generated evidence IDs preserve the physical page in a deterministic
prefix so minimal Phase 2 findings can be mapped back to an exact page without
filename inference, adjacency guessing, or global mutable state.

## 7. Phase 2 integration

The router sends Phase 2:

- the exact manifest locator;
- the exact manifest document key;
- the exact artifact locator;
- the real supplied SourceDocument ID for persisted mode;
- the recomputed source PDF SHA;
- the recomputed artifact byte SHA;
- inspect mode by default;
- `persist_audit` only with explicit operator authorization.

Persisted mode uses one production context for:

- one Prisma client;
- SourceDocument and audit repository reads/writes;
- local parser output proof;
- versioned S3 paid output proof;
- `DocumentParseJob` recording;
- Phase 2 trusted verification.

The parser-run row contains exact pages, input SHA, method, version, config SHA,
output locator, output byte SHA, canonical output content SHA, status, metrics,
and provider job ID where applicable.

## 8. Operator commands

### Profile

```bash
pnpm --filter @capiro/api profile:defense-budget-document -- \
  --manifest manifest.json \
  --document r1-army \
  --source source.pdf \
  --out profile.json
```

The profile command is deterministic, source-bound, profile-all by default,
and refuses overwrite without `--force`.

### Plan

```bash
pnpm --filter @capiro/api plan:defense-budget-parse -- \
  --manifest manifest.json \
  --document r1-army \
  --source source.pdf \
  --profile profile.json \
  --out plan.json
```

The same source/profile produces byte-identical plans and IDs. Initial plans
are local and free.

### Extract and verify

```bash
pnpm --filter @capiro/api extract:defense-budget-cycle -- \
  --manifest manifest.json \
  --document r1-army \
  --source source.pdf \
  --work-dir .work/fy2027 \
  --out r1.extraction-v1.json
```

Optional paid escalation:

```bash
... --allow-paid-parse --max-paid-pages 12 --paid-mode pdf_premium
```

Optional final audit persistence:

```bash
... --persist-verification-audit --source-document-id <uuid>
```

Persisted mode requires the shared parser artifact root. Persisted paid mode
also requires the LlamaParse output bucket and normal LlamaParse credentials.

Native structured input:

```bash
... --structured-companion r1.extraction-v1.json
```

The companion must already satisfy the Phase 1 artifact contract and declare
`native_structured` parser lineage.

### Replay

```bash
pnpm --filter @capiro/api replay:defense-budget-parser-artifact -- \
  --descriptor <metadata.json>
```

This local command performs no parser call. S3 replay is available through the
injected `S3ParserArtifactStore` boundary and never silently loads AWS
credentials in the local replay command.

### Exit codes

```text
0 success / verification passed
2 argument or contract failure
3 source, manifest, artifact, or proof failure
4 parser runtime unavailable
5 parsing incomplete
6 verifier rejected
7 verifier needs review
8 paid page cap exceeded
9 internal failure
```

## 9. Permanent gates

TypeScript/Jest:

```bash
pnpm --filter @capiro/api verify:pe-budget-phase-3
pnpm exec tsc -p apps/api/tsconfig.budget-parser-router.json --noEmit
```

Python:

```bash
cd apps/defense-budget-parser
uv sync --locked --all-groups
uv run pytest
uv run ruff check .
uv run ruff format --check .
uv run mypy src
```

Architecture and cross-language:

```bash
pnpm --dir apps/api exec tsx scripts/verify-defense-budget-parser-architecture.ts
pnpm --dir apps/api exec tsx scripts/verify-defense-budget-parser-runtime.ts
```

Twenty mandatory defect-injection controls:

```bash
pnpm --dir apps/api exec tsx scripts/verify-pe-budget-phase-3-negative-controls.ts
```

Each control now mutates the implementation, requires the named gate/test to
fail, restores the exact bytes, and requires the same gate/test to return green.
No control is hard-coded as passed.

Container rehearsal:

```bash
docker build --platform linux/amd64 --target table -f apps/defense-budget-parser/Dockerfile .
docker build --platform linux/amd64 --target layout -f apps/defense-budget-parser/Dockerfile .
docker build --platform linux/amd64 --target ocr -f apps/defense-budget-parser/Dockerfile .
```

## 10. Workstream status

| Workstream | Status | Primary evidence |
|---|---|---|
| A — contracts/state machine | Implemented | strict TS/Python contracts; executable router state map |
| B — page profiler | Implemented | profile-all, source SHA proof, deterministic profile contract |
| C — route/escalation planner | Implemented | native refusal, local-first escalation, cap/round/repeat controls |
| D — artifact stores/replay/recording | Implemented | filesystem and versioned S3 replay; Prisma recorder |
| E — isolated Python runtime/container | Implemented | strict CLI, multi-target Dockerfile, locked project |
| F — pdfplumber | Implemented | requested-page parser with real geometry |
| G — Camelot | Implemented | requested-page flavor routing and real geometry |
| H — Docling | Implemented | CLI-dispatched CPU mixed-layout engine |
| I — PaddleOCR | Implemented | targeted CPU OCR with resource controls |
| J — LlamaParse | Implemented | explicit authorization, exact pages, no auto retry |
| K — deterministic compositor | Implemented | one selected result or explicit failure per page |
| L — V1 bridge/verifier loop | Implemented | strict artifact, exact Phase 2 identities, bounded rounds |
| M — operator commands | Implemented | profile, plan, extract, native companion, replay |
| N — gates/negative controls | Implemented | architecture, cross-language, all 20 real injections |
| O — cost/docs/handoff | Implemented | execution reports, cost accumulator, this document and runbook |

## 11. Scope intentionally left for later phases

- source discovery and scheduling;
- ECS/CDK/Fargate deployment;
- production data backfill;
- canonical promotion and canonical Program Element writes;
- review UI or public review API;
- full family-specific semantic extraction inside the generic Phase 3 bridge;
- live provider/model smoke using production documents.

These exclusions do not weaken Phase 3’s parser-routing, replay, proof, or cost
controls. They remain explicit downstream work.
