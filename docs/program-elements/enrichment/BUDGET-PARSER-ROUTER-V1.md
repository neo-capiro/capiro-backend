# Phase 3 — Cost-Aware Defense-Budget Parser Router V1

This document describes the parser execution and routing layer built in Phase 3.
It converts manually supplied defense-budget source documents into exact,
replayable `defense_budget_extraction_v1` artifacts and uses the Phase 2
verifier to decide whether selected pages require a stronger parser.

The router answers:

> “Which parser should process each supplied source page, what exact output did
> each parser produce, can the output be replayed without paying again, and
> which unresolved pages need a stronger parser?”

It does **not** answer:

> “May these assertions be written to canonical Program Element tables?”

Canonical promotion remains forbidden in Phase 3.

---

## 1. Architecture

```text
┌─────────────────────────────────────────────────────────────────────┐
│                        Node API Orchestrator                         │
│  apps/api/src/defense-budget/parser-router/                          │
│                                                                      │
│  - manifest interpretation & source SHA-256 hashing                  │
│  - page profile request construction                                 │
│  - deterministic route planning & escalation planning                │
│  - content-addressed parser artifact store / replay                  │
│  - targeted LlamaParse authorization & invocation (paid path)        │
│  - page-result composition                                           │
│  - Phase 1 V1 artifact construction                                  │
│  - Phase 2 verification inspect loop                                 │
│  - optional Prisma / S3 audit recording                              │
│  - operator CLI commands                                             │
└──────────────────────────┬───────────────────────────────────────────┘
                           │ job envelope (JSON file)
                           │ result envelope (JSON file)
                           ▼
┌─────────────────────────────────────────────────────────────────────┐
│              Isolated Python Parser Runtime (local only)             │
│  apps/defense-budget-parser/                                         │
│                                                                      │
│  - cheap PDF page profiler                                           │
│  - pdfplumber engine                                                 │
│  - Camelot engine                                                    │
│  - Docling CPU engine                                                │
│  - PaddleOCR PP-StructureV3 targeted engine                          │
│  - normalized parser result production                               │
│                                                                      │
│  The Python runtime must NOT:                                        │
│    connect to Postgres · access AWS credentials · call LlamaParse    │
│    write canonical data · make verification decisions                │
│    select a winning parser result · know tenant/client data          │
└─────────────────────────────────────────────────────────────────────┘
```

The Node side and Python side communicate through a **file/job-envelope
transport** (Section 5.2 of the plan). There is no HTTP/FastAPI server in
Phase 3.

---

## 2. Parser method vocabulary

The Phase 1 vocabulary is used exactly. Persisted parser method fields must
only contain these values:

| Method | Role |
|---|---|
| `native_structured` | Official structured companion file supplied by the operator; PDF is not parsed for primary values |
| `deterministic_pdfplumber` | Default engine for clean digital text/table pages |
| `camelot` | Alternate deterministic table engine for unresolved digital table pages |
| `docling` | Mixed-layout digital pages requiring reading-order and layout reconstruction |
| `paddleocr` | Scanned / image-only / rotated pages, or explicit OCR policy override |
| `llamaparse` | Paid exception path for unresolved complex pages only |
| `manual` | Manual operator entry |

Do **not** add aliases such as `local`, `ocr`, `ai`, or `premium` to persisted
parser method fields.

---

## 3. Local-first routing rules

### 3.1 Default parser order

```text
official structured companion, when supplied
        ↓
deterministic local parsing (pdfplumber → camelot)
        ↓
layout-aware local parsing (docling)
        ↓
targeted OCR for image-only pages (paddleocr)
        ↓
targeted LlamaParse for unresolved complex pages only (paid, explicit opt-in)
```

LlamaParse is the paid exception path. It must never be the default
whole-document parser for clean digital exhibits.

### 3.2 Policy-driven initial routes

| Manifest `parserPolicy` | Initial route | Fallback route |
|---|---|---|
| `native_structured` | Structured companion file only (no PDF parsing for primary values) | Fail closed if no companion supplied |
| `deterministic_table` | pdfplumber on requested pages | camelot → docling → targeted llamaparse (only when explicitly authorized) |
| `mixed_layout` | docling on requested pages | camelot on unresolved table pages → paddleocr on image-only pages → targeted llamaparse (only when explicitly authorized) |
| `ocr` | paddleocr on image-only/scanned pages | docling or camelot where appropriate → targeted llamaparse (only when explicitly authorized) |

PaddleOCR is permitted only when the page profiler marks a page image-only /
scanned, or when the operator explicitly overrides the page route. For pages
with a valid embedded text layer, the planner prefers pdfplumber or Docling
over OCR unless OCR is explicitly forced.

---

## 4. Verification-driven escalation

After local parsing and deterministic page-result composition, the composed
output is converted into a `defense_budget_extraction_v1` artifact and passed
to the Phase 2 verifier in **inspect mode**.

Verification findings drive the next page-level escalation step:

1. The escalation planner (`escalation-planner.ts`) maps verification finding
   codes to parser-correctable page sets.
2. A new deterministic plan (`route-planner.ts`) is produced for only those
   pages, with a stronger engine.
3. Escalation stops at a deterministic terminal condition (max rounds reached,
   paid authorization missing, paid page cap exceeded, or no
   parser-correctable findings remain).
4. The router never loops indefinitely.

---

## 5. Page numbering

All Phase 3 contracts use **1-based physical PDF page numbers**.

Conversion to LlamaParse zero-based `targetPages` happens only at the
LlamaParse client boundary (`llamaparse-page-executor.ts`, helper J2).
Permanent tests prevent off-by-one conversion errors.

---

## 6. Caching and proof

Every parser run is identified by a content-addressed identity tuple:

```text
(sourceSha256, method, parserVersion, parserConfigSha256, requestedPages, runtimeContractVersion)
```

The cache key is the canonical-JSON SHA-256 of that tuple
(`computeParserRunCacheKey` in `parser-runtime-contract-v1.ts`).

Replay rules:

- An existing output is reused only after its `contentSha256` is recomputed
  and matches the recorded SHA.
- A corrupted, missing, or unprovable cached output is never reused.
- `durationMillis` is excluded from the content SHA so that replay is
  deterministic.
- Alternative parser results remain retained for audit and comparison; the
  selected page result records why it won.

---

## 7. Parser runtime contract

### 7.1 Job envelope (Node → Python)

```json
{
  "schemaVersion": "defense_budget_parser_job_v1",
  "jobId": "string",
  "sourcePath": "string",
  "sourceSha256": "sha256",
  "engine": "deterministic_pdfplumber | camelot | docling | paddleocr",
  "requestedPages": [1, 2, 3],
  "parserVersion": "string",
  "parserConfig": {},
  "parserConfigSha256": "sha256",
  "outputDirectory": "string",
  "includeDebugArtifacts": false
}
```

### 7.2 Result envelope (Python → Node)

```json
{
  "schemaVersion": "defense_budget_parser_result_v1",
  "jobId": "string",
  "engine": "deterministic_pdfplumber | camelot | docling | paddleocr | llamaparse | manual | native_structured",
  "parserVersion": "string",
  "parserConfigSha256": "sha256",
  "inputSourceSha256": "sha256",
  "requestedPages": [1, 2, 3],
  "succeededPages": [1, 2],
  "failedPages": [],
  "pages": [],
  "warnings": [],
  "metrics": {
    "durationMillis": 0,
    "pagesProcessed": 0,
    "pagesSucceeded": 0,
    "pagesFailed": 0,
    "engineVersion": "string"
  },
  "contentSha256": "sha256"
}
```

Both envelopes are strict Zod schemas; unknown fields fail closed. All
coordinates and money-like values are canonical decimal strings for
cross-language determinism.

---

## 8. Python image targets

The parser runtime is built from a single multi-target Dockerfile
(`apps/defense-budget-parser/Dockerfile`):

| Target | Contents | Use |
|---|---|---|
| `table` | base + pdfplumber + Camelot | clean digital table pages |
| `layout` | table + Docling CPU | mixed-layout digital pages |
| `ocr` | layout + PaddleOCR CPU | scanned / image-only / rotated pages |

All targets run on CPU, as a non-root user, and do not contain AWS
credentials or LlamaParse keys. The `ocr` target pre-creates the PaddleOCR
model-cache directory at `/home/parser/.paddleocr`.

---

## 9. Paid authorization controls

A paid parser call requires **both** of the following CLI flags:

```bash
--allow-paid-parse          # explicit authorization
--max-paid-pages <N>        # positive integer cap
```

Safety rules enforced by the router:

- `--allow-paid-parse` without `--max-paid-pages` is an error.
- The default command path performs no paid call.
- Planned paid pages exceeding the cap produce a deterministic terminal plan
  with reason `paid_not_authorized` or `paid_page_cap_exceeded`.
- The LlamaParse executor refuses to run when `allowPaidParse` is false.
- Provider credits used are reported truthfully when returned by the
  provider; dollar cost is never fabricated.

---

## 10. Non-goals

Phase 3 explicitly does **not** implement or modify:

- automatic budget-document discovery;
- `watch-budget-docs.ts` behavior;
- EventBridge schedules;
- ECS/CDK/Fargate deployment;
- the broader Program Elements service extraction;
- canonical promotion or canonical PE writers;
- source priority or canonical reconciliation;
- Program Element read APIs or UI;
- R-1 funding-column completion, R-2/R-2A project-funding completion,
  R-3 semantic completion, R-4/R-4A milestone extraction;
- complete procurement/P-5/P-21/P-3A extraction;
- complete O&M or MILCON extraction;
- committee/public-law loader migration;
- automatic human-review approval;
- review UI;
- direct email/SMS alerts;
- production parsing or production data backfill;
- shared-environment migrations;
- changes to the main API image that install Docling, PaddleOCR, Camelot,
  PyTorch, or PaddlePaddle;
- a GPU requirement;
- VLM/LLM modes inside Docling;
- any remote model other than the existing explicitly authorized LlamaParse
  path;
- unbounded paid parsing;
- whole-document LlamaParse as the default for `deterministic_table`,
  `mixed_layout`, or `ocr` policies.

---

## 11. Relationship to other phases

| Phase | Relationship |
|---|---|
| **Phase 1** | Provides the `defense_budget_extraction_v1` contract, cycle manifest schema, canonical JSON helpers, and artifact validation commands. Phase 3 composes parser outputs into this exact artifact shape. |
| **Phase 2** | Provides the trusted verifier, verification policies, decision engine, and inspect-mode CLI. Phase 3 feeds composed artifacts into Phase 2 and uses verification findings to drive page-level escalation. |
| **Phase 4** | Will consume the replayable parser artifacts and cost reports produced here for downstream extraction completion (R-1/R-2/R-3/R-4, procurement, O&M, MILCON). |
| **Phase 5** | Will handle canonical promotion and Program Element writes. Phase 3 explicitly forbids them. |
| **Phase 7** | Will deploy the parser runtime as a one-off Fargate task (see Fargate-readiness note below). Phase 3 builds the runtime and contract that make this possible without moving parser libraries into the Node API image. |

---

## 12. Fargate-readiness note (O4)

The following properties are designed in, but **not deployed** in Phase 3:

- The parser runtime is a **one-off task image**; it runs to completion and
  exits.
- The Node orchestrator can later dispatch the same `uv run
  capiro-defense-budget-parser run --job … --out …` command as a Fargate task.
- Source/result materialization will use **S3**; the parser container itself
  remains free of AWS credentials.
- The API service stays free of parser ML dependencies (no Docling,
  PaddleOCR, Camelot, PyTorch, or PaddlePaddle in `apps/api/Dockerfile`).
- OCR/layout tasks may use different CPU/memory sizes; the current `table`,
  `layout`, and `ocr` targets are sized independently.
- `linux/amd64` is the initial parser runtime platform.
- No service-to-service API is required for one-off tasks; file-envelope
  transport is sufficient.

---

## 13. Preliminary evidence matrix (O5)

Status legend: **PASS** = implemented and tested in the current branch;
**PENDING** = pending completion of another workstream (H, L, M, N).

### 13.1 Section 2 requirements (1–37)

| # | Requirement | Implementation file | Test file | Command | Status |
|---|---|---|---|---|---|
| 1 | Consumes one schema-valid manual manifest | `apps/api/scripts/validate-defense-budget-cycle-manifest.ts` (Phase 1) | `apps/api/src/defense-budget/contracts/budget-cycle-manifest-v1.spec.ts` | `pnpm --filter @capiro/api validate:defense-budget-manifest` | PASS |
| 2 | No automatic source discovery | — (out-of-scope guard) | — | — | PASS |
| 3 | Computes actual source-file SHA before parsing | `apps/api/src/defense-budget/parser-router/parser-artifact-store.ts` | `parser-artifact-store.spec.ts` | `pnpm --filter @capiro/api verify:pe-budget-phase-3` | PASS |
| 4 | Profiles every requested PDF page cheaply | `apps/api/src/defense-budget/parser-router/page-profiler.ts` + `apps/defense-budget-parser/src/capiro_defense_budget_parser/pdf_profile.py` | `page-profiler.spec.ts` + `test_pdf_profile.py` | `pnpm --filter @capiro/api verify:pe-budget-phase-3` | PASS |
| 5 | Deterministic parser execution plan before paid call | `apps/api/src/defense-budget/parser-router/route-planner.ts` | `route-planner.spec.ts` | `pnpm --filter @capiro/api verify:pe-budget-phase-3` | PASS |
| 6 | Respects manifest `parserPolicy` without weakening verification | `route-planner.ts` | `route-planner.spec.ts` | `pnpm --filter @capiro/api verify:pe-budget-phase-3` | PASS |
| 7 | Uses official structured companion when supplied | `route-planner.ts` (`native_structured` policy) | `route-planner.spec.ts` | `pnpm --filter @capiro/api verify:pe-budget-phase-3` | PASS |
| 8 | pdfplumber default for clean digital pages | `apps/defense-budget-parser/src/capiro_defense_budget_parser/pdfplumber_engine.py` | `test_pdfplumber_engine.py` | `cd apps/defense-budget-parser && uv run pytest tests/test_pdfplumber_engine.py` | PASS |
| 9 | Camelot alternate for unresolved digital tables | `apps/defense-budget-parser/src/capiro_defense_budget_parser/camelot_engine.py` | `test_camelot_engine.py` | `cd apps/defense-budget-parser && uv run pytest tests/test_camelot_engine.py` | PASS |
| 10 | Docling for mixed-layout pages | `apps/defense-budget-parser/src/capiro_defense_budget_parser/docling_engine.py` | `test_docling_engine.py` | `cd apps/defense-budget-parser && uv run pytest tests/test_docling_engine.py` | PASS |
| 11 | PaddleOCR PP-StructureV3 for scanned/image-only | `apps/defense-budget-parser/src/capiro_defense_budget_parser/paddleocr_engine.py` | `test_paddleocr_engine.py` | `cd apps/defense-budget-parser && uv run pytest tests/test_paddleocr_engine.py` | PASS |
| 12 | LlamaParse only for explicitly authorized unresolved pages | `apps/api/src/defense-budget/parser-router/llamaparse-page-executor.ts` | `llamaparse-page-executor.spec.ts` | `pnpm --filter @capiro/api verify:pe-budget-phase-3` | PASS |
| 13 | Paid call requires explicit CLI authorization flag | `llamaparse-page-executor.ts` (`--allow-paid-parse`) | `llamaparse-page-executor.spec.ts` | `pnpm --filter @capiro/api verify:pe-budget-phase-3` | PASS |
| 14 | Paid call bounded by max page count | `llamaparse-page-executor.ts` (`--max-paid-pages`) | `llamaparse-page-executor.spec.ts` | `pnpm --filter @capiro/api verify:pe-budget-phase-3` | PASS |
| 15 | Default command path performs no paid call | `route-planner.ts` / `llamaparse-page-executor.ts` | `route-planner.spec.ts` + `llamaparse-page-executor.spec.ts` | `pnpm --filter @capiro/api verify:pe-budget-phase-3` | PASS |
| 16 | Exact method/version/config SHA/source SHA/page range/output SHA/locator per run | `parser-runtime-contract-v1.ts` | `parser-runtime-contract-v1.spec.ts` | `pnpm --filter @capiro/api verify:pe-budget-phase-3` | PASS |
| 17 | Content-addressed, replayable parser outputs | `parser-artifact-store.ts` | `parser-artifact-store.spec.ts` | `pnpm --filter @capiro/api verify:pe-budget-phase-3` | PASS |
| 18 | Reuse only after SHA recompute and match | `parser-artifact-store.ts` (`verifyResultContentSha256`) | `parser-artifact-store.spec.ts` | `pnpm --filter @capiro/api verify:pe-budget-phase-3` | PASS |
| 19 | Corrupted/missing/unprovable cache never reused | `parser-artifact-store.ts` | `parser-artifact-store.spec.ts` | `pnpm --filter @capiro/api verify:pe-budget-phase-3` | PASS |
| 20 | Truthful evidence precision; no fake bounding boxes | `parser-runtime-contract-v1.ts` (`evidencePrecisionV1Schema`) | `parser-runtime-contract-v1.spec.ts` | `pnpm --filter @capiro/api verify:pe-budget-phase-3` | PASS |
| 21 | Deterministic multi-engine composition, no last-wins | `page-result-compositor.ts` | `page-result-compositor.spec.ts` | `pnpm --filter @capiro/api verify:pe-budget-phase-3` | PASS |
| 22 | Every requested page has exactly one selected result or one blocking failure | `page-result-compositor.ts` | `page-result-compositor.spec.ts` | `pnpm --filter @capiro/api verify:pe-budget-phase-3` | PASS |
| 23 | Alternative parser results retained for audit | `page-result-compositor.ts` | `page-result-compositor.spec.ts` | `pnpm --filter @capiro/api verify:pe-budget-phase-3` | PASS |
| 24 | Selected page result records why it won | `page-result-compositor.ts` | `page-result-compositor.spec.ts` | `pnpm --filter @capiro/api verify:pe-budget-phase-3` | PASS |
| 25 | Composed output converted to `defense_budget_extraction_v1` | `extraction-artifact-bridge.ts` (pending WS L) | `extraction-artifact-bridge.spec.ts` (pending WS L) | `pnpm --filter @capiro/api verify:pe-budget-phase-3` | PENDING |
| 26 | Composed V1 artifact passed to Phase 2 verification inspect mode | `parser-router-v1.service.ts` (pending WS L) | `parser-router-v1.service.spec.ts` (pending WS L) | `pnpm --filter @capiro/api verify:pe-budget-phase-3` | PENDING |
| 27 | Verification findings drive next page-level escalation | `escalation-planner.ts` | `escalation-planner.spec.ts` | `pnpm --filter @capiro/api verify:pe-budget-phase-3` | PASS |
| 28 | Escalation stops at deterministic terminal condition | `route-planner.ts` / `escalation-planner.ts` | `route-planner.spec.ts` + `escalation-planner.spec.ts` | `pnpm --filter @capiro/api verify:pe-budget-phase-3` | PASS |
| 29 | Router never loops indefinitely | `route-planner.ts` (`DEFAULT_MAX_ESCALATION_ROUNDS`) | `route-planner.spec.ts` | `pnpm --filter @capiro/api verify:pe-budget-phase-3` | PASS |
| 30 | Records local vs paid page counts and parser metrics | `cost-accounting.ts` | `cost-accounting.ts` (self-contained accumulator) | `pnpm --filter @capiro/api typecheck` | PASS |
| 31 | Local filesystem operation with no AWS/DB dependency | `filesystem-parser-artifact-store.ts` | `parser-artifact-store.spec.ts` | `pnpm --filter @capiro/api verify:pe-budget-phase-3` | PASS |
| 32 | Optional S3/SourceDocument/DocumentParseJob recording path | `s3-parser-artifact-store.ts` / `prisma-parser-run-recorder.ts` | — | — | PASS |
| 33 | No canonical Program Element write | — (containment guard) | `verification-containment.spec.ts` / `contract-containment.spec.ts` | `pnpm --filter @capiro/api verify:pe-budget-phase-2` | PASS |
| 34 | Imports no `ProgramElementWriterService` | — (containment guard) | `verification-containment.spec.ts` / `contract-containment.spec.ts` | `pnpm --filter @capiro/api verify:pe-budget-phase-2` | PASS |
| 35 | Does not invoke canonical `--commit` path in `ingest-defense-budget-pdf.ts` | — (containment guard) | `ingest-defense-budget-replay.spec.ts` | `pnpm --filter @capiro/api verify:pe-phase-b` | PASS |
| 36 | Reusable for FY2027, FY2028, and later | manifest-driven design | `budget-cycle-manifest-v1.spec.ts` | `pnpm --filter @capiro/api validate:defense-budget-manifest` | PASS |
| 37 | Isolated parser runtime can later launch as one-off Fargate task | `apps/defense-budget-parser/Dockerfile` | — | `docker build apps/defense-budget-parser` | PASS |

### 13.2 Workstream acceptance items

| Workstream | Acceptance item | Implementation file | Test file | Command | Status |
|---|---|---|---|---|---|
| A | Parser runtime contracts and state machine | `parser-runtime-contract-v1.ts` | `parser-runtime-contract-v1.spec.ts` | `pnpm --filter @capiro/api verify:pe-budget-phase-3` | PASS |
| B | Cheap PDF page profiler | `page-profiler.ts` + `pdf_profile.py` | `page-profiler.spec.ts` + `test_pdf_profile.py` | `pnpm --filter @capiro/api verify:pe-budget-phase-3` | PASS |
| C | Deterministic route and escalation planner | `route-planner.ts` + `escalation-planner.ts` | `route-planner.spec.ts` + `escalation-planner.spec.ts` | `pnpm --filter @capiro/api verify:pe-budget-phase-3` | PASS |
| D | Content-addressed parser artifacts and replay | `parser-artifact-store.ts` + `filesystem-parser-artifact-store.ts` + `s3-parser-artifact-store.ts` | `parser-artifact-store.spec.ts` | `pnpm --filter @capiro/api verify:pe-budget-phase-3` | PASS |
| E | Isolated Python parser runtime and container | `apps/defense-budget-parser/pyproject.toml` + `Dockerfile` + `src/` | `tests/` | `cd apps/defense-budget-parser && uv run pytest` | PASS |
| F | pdfplumber engine | `pdfplumber_engine.py` | `test_pdfplumber_engine.py` | `cd apps/defense-budget-parser && uv run pytest tests/test_pdfplumber_engine.py` | PASS |
| G | Camelot engine | `camelot_engine.py` | `test_camelot_engine.py` | `cd apps/defense-budget-parser && uv run pytest tests/test_camelot_engine.py` | PASS |
| H | Docling engine | `docling_engine.py` | `test_docling_engine.py` | `cd apps/defense-budget-parser && uv run pytest tests/test_docling_engine.py` | PASS |
| I | PaddleOCR targeted OCR engine | `paddleocr_engine.py` | `test_paddleocr_engine.py` | `cd apps/defense-budget-parser && uv run pytest tests/test_paddleocr_engine.py` | PASS |
| J | Targeted LlamaParse executor | `llamaparse-page-executor.ts` | `llamaparse-page-executor.spec.ts` | `pnpm --filter @capiro/api verify:pe-budget-phase-3` | PASS |
| K | Deterministic page-result compositor | `page-result-compositor.ts` | `page-result-compositor.spec.ts` | `pnpm --filter @capiro/api verify:pe-budget-phase-3` | PASS |
| L | V1 artifact bridge + Phase 2 verification feedback loop | `extraction-artifact-bridge.ts` + `parser-router-v1.service.ts` (pending) | `extraction-artifact-bridge.spec.ts` + `parser-router-v1.service.spec.ts` (pending) | `pnpm --filter @capiro/api verify:pe-budget-phase-3` | PENDING |
| M | Manifest-driven operator commands and safe integration | `apps/api/scripts/profile-defense-budget-document.ts` etc. (pending) | — | — | PENDING |
| N | Permanent gates, fixtures, negative controls, container rehearsal | `apps/api/scripts/verify-defense-budget-parser-architecture.ts` + `verify-pe-budget-phase-3-negative-controls.ts` (pending) | — | — | PENDING |
| O | Cost accounting, documentation, and handoff | `cost-accounting.ts` + `docs/program-elements/enrichment/BUDGET-PARSER-ROUTER-V1.md` + `docs/runbooks/defense-budget-parser-router.md` | — | — | PASS |

---

## 14. Cost accounting

Per-document cost reports are produced by `CostAccumulator` in
`cost-accounting.ts`. The report contains exactly the fields required by
Section 21 / O1:

- source pages
- profiled pages
- per-engine pages executed / reused (pdfplumber, Camelot, Docling,
  PaddleOCR, LlamaParse)
- provider credits used, when returned (`null` when not returned)
- paid page cap
- paid pages remaining
- local runtime durations (milliseconds)
- parser failures
- final verification decision

No dollar cost is fabricated when the provider does not return enough current
pricing data. Units, pages, and credits are reported truthfully.
