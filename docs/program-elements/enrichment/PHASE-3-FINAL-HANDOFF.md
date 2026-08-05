# Phase 3 — Cost-Aware Defense-Budget Parser Router V1 — Final Handoff

## 1. Status

**Implementation status:** complete on branch; ready for local closeout validation and owner merge decision.

**Repository:** `neo-capiro/capirov2`

**Branch:** `agent/pe-budget-parser-router-v1-closeout`

**Base:** Phase 2 merge commit `71aa010ae7b35f9b4674e5207a82086202f82475`

**Merge/deployment status:** not merged, not deployed.

GitHub Actions are intentionally not required. The GitHub connector used for
this implementation cannot execute the repository runtime, Python environment,
Docker daemon, or local PostgreSQL. This handoff therefore distinguishes
implemented executable validation from validation actually observed in this
session. Run the closeout command in Section 13 before merge.

## 2. Scope closed

This branch closes the confirmed Phase 3 gaps:

- invalid pseudo extraction artifact;
- illegal parser-router state transition;
- source PDF passed as manifest locator;
- synthetic SourceDocument IDs in persisted flow;
- empty PDF bytes sent to paid parsing;
- profile jobs returning zero pages;
- extract command returning success without extraction;
- Docling absent from runtime dispatch;
- replay store unused by the router;
- S3 parser store stub;
- Prisma parser-run recorder stub;
- missing evidence-to-page escalation mapping;
- non-deterministic profile/plan IDs;
- native-structured fallback to PDF parsing;
- noncontiguous parser jobs incompatible with parse-job proof;
- lost provider job identity after paid-cache replay;
- parser-output metadata keys incompatible with Phase 2 proof;
- negative controls hard-coded as passed.

## 3. Workstreams completed

### A — Cross-language contracts and state machine

- strict TypeScript and Python job/result contracts;
- one-based physical page numbers;
- legal local and paid state transitions;
- terminal state immutability;
- exact engine/version/config/source/page identity validation.

### B — Cheap page profiler

- full-document profiling through an explicit profile-all sentinel;
- source SHA verification before opening the PDF;
- deterministic thresholds and profile content SHA;
- no OCR, Docling, PaddleOCR, LlamaParse, database, or AWS call.

### C — Deterministic planning and escalation

- local-first initial plan;
- `native_structured` fails closed without an explicit companion;
- embedded-text pages are not routed directly to OCR;
- exact evidence IDs resolve back to one-based physical pages;
- source corruption, missing independent references, unsupported policies, and
  canonical-schema gaps are not parser-correctable;
- repeated engine/page runs and unbounded rounds are prevented;
- missing paid authorization and paid-page-cap exhaustion are distinct terminal
  outcomes.

### D — Artifact stores, replay, and parser-run recording

- verified filesystem cache;
- versioned S3 store with exact VersionId replay;
- output byte SHA and canonical content SHA verification;
- SourceDocument/method/version/config/page identity verification;
- method-routing store sends LlamaParse normalized results to S3 while local
  output may use a shared filesystem root;
- real idempotent `DocumentParseJob` recorder;
- proof-bound recorder re-reads the persisted output locator before recording;
- top-level metadata keys match Phase 2 parser-output proof;
- noncontiguous logical plans are split into contiguous parser jobs.

### E–I — Isolated parser runtime and local engines

- strict runtime CLI: validate, profile, run, version;
- lightweight version discovery without importing optional ML modules;
- pdfplumber, Camelot, Docling CPU, and PaddleOCR CPU dispatch;
- source/method/version/config/page result binding;
- parser unavailable exit semantics;
- no AWS, database, LlamaParse, verification, tenant, or canonical dependency in
  the Python runtime.

### J — Targeted LlamaParse

- explicit authorization plus positive page cap;
- exact selected pages only;
- one-based to zero-based conversion at one boundary;
- no automatic provider resubmission;
- actual source PDF bytes;
- normalized parser result and provider raw proof kept distinct;
- provider job ID preserved in immutable paid-cache locator and final parser
  lineage;
- paid cache replay avoids another provider call.

### K — Deterministic compositor

- one selected result or explicit failure per requested page;
- alternatives retained;
- paid parser does not automatically outrank local output;
- OCR does not outrank clean embedded text without a reason;
- no manual last-wins behavior;
- deterministic composed content SHA.

### L — Strict Phase 1 artifact and Phase 2 loop

- bridge emits the complete `defense_budget_extraction_v1` envelope;
- exact contributing parser runs, page ranges, provider job identity, evidence,
  source facts, warnings, omissions, and summary;
- no fake bounding boxes or invented budget assertions;
- artifact byte SHA, not logical content SHA, is supplied as the Phase 2 TOCTOU
  guard;
- real manifest locator and supplied SourceDocument ID;
- inspect by default; persisted audit explicit;
- evidence-backed findings drive bounded stronger-parser rounds.

The generic page bridge truthfully produces a review finding when a registered
family-specific extraction adapter has not emitted budget assertions. Complete
RDT&E family semantic extraction remains downstream Phase 4 work and is not
silently invented here.

### M — Operator commands

- deterministic profile command;
- deterministic plan command;
- real extraction/router/verification command;
- explicit paid-page flags;
- native-structured companion workflow;
- optional final audit persistence;
- strict replay command;
- truthful exit codes and execution reports.

### N — Permanent gates and negative controls

- strict Phase 3 TypeScript includes production modules and operator scripts;
- architecture containment gate;
- TypeScript/Python contract and canonical-hash gate;
- Python tests, Ruff, formatting, and mypy commands;
- 20 mandatory controls now each mutate the implementation, require a failing
  gate, restore exact bytes, and require the same gate to return green;
- optional table/layout/OCR Linux/amd64 container builds.

### O — Cost, documentation, and handoff

- executed/reused pages by engine;
- paid page cap and pages remaining;
- provider credits when returned;
- runtime duration and parser failure accounting;
- final technical document;
- final operator runbook;
- this handoff.

## 4. Important files

### Node orchestration

```text
apps/api/src/defense-budget/parser-router/parser-router-v1.service.ts
apps/api/src/defense-budget/parser-router/router-state-machine.ts
apps/api/src/defense-budget/parser-router/route-planner.ts
apps/api/src/defense-budget/parser-router/escalation-planner.ts
apps/api/src/defense-budget/parser-router/page-result-compositor.ts
apps/api/src/defense-budget/parser-router/extraction-artifact-bridge.ts
apps/api/src/defense-budget/parser-router/native-structured-companion.ts
```

### Proof and persistence

```text
apps/api/src/defense-budget/parser-router/parser-artifact-store.ts
apps/api/src/defense-budget/parser-router/s3-parser-artifact-store.ts
apps/api/src/defense-budget/parser-router/method-routing-parser-artifact-store.ts
apps/api/src/defense-budget/parser-router/proof-bound-parser-run-recorder.ts
apps/api/src/defense-budget/parser-router/prisma-parser-run-recorder.ts
apps/api/src/defense-budget/parser-router/production-parser-verification-context.ts
```

### Runtime

```text
apps/defense-budget-parser/src/capiro_defense_budget_parser/cli.py
apps/defense-budget-parser/src/capiro_defense_budget_parser/engine_versions.py
apps/defense-budget-parser/src/capiro_defense_budget_parser/pdf_profile.py
apps/defense-budget-parser/src/capiro_defense_budget_parser/pdfplumber_engine.py
apps/defense-budget-parser/src/capiro_defense_budget_parser/camelot_engine.py
apps/defense-budget-parser/src/capiro_defense_budget_parser/docling_engine.py
apps/defense-budget-parser/src/capiro_defense_budget_parser/paddleocr_engine.py
```

### Operator commands and gates

```text
apps/api/scripts/profile-defense-budget-document.ts
apps/api/scripts/plan-defense-budget-parse.ts
apps/api/scripts/extract-defense-budget-cycle.ts
apps/api/scripts/replay-defense-budget-parser-artifact.ts
apps/api/scripts/verify-defense-budget-parser-runtime.ts
apps/api/scripts/verify-defense-budget-parser-architecture.ts
apps/api/scripts/verify-pe-budget-phase-3-negative-controls.ts
apps/api/scripts/verify-pe-budget-phase-3-closeout.ts
```

## 5. Parser dependency/runtime matrix

Exact dependency versions are governed by
`apps/defense-budget-parser/uv.lock`. Persisted identities are emitted by:

```bash
uv run capiro-defense-budget-parser version --json
```

| Engine | Runtime target | Persisted version source |
|---|---|---|
| pdfplumber | table/layout/ocr | explicit runtime identity |
| Camelot | table/layout/ocr | explicit runtime identity |
| Docling CPU | layout/ocr | installed package metadata without importing model code |
| PaddleOCR CPU | ocr | explicit PP-StructureV3 runtime identity |
| LlamaParse | Node provider boundary | `llamaparse-v1` plus exact mode/config SHA/provider job ID |

The table image may report a Docling contract version while execution still
returns parser-unavailable if Docling is not installed in that image. The route
must use the matching layout/ocr target for actual execution.

## 6. Production parser proof configuration

Local parser output used by persisted Phase 2 verification:

```text
BUDGET_VERIFICATION_PARSER_ARTIFACT_ROOT
```

Persisted LlamaParse normalized output:

```text
BUDGET_VERIFICATION_LLAMAPARSE_OUTPUT_BUCKET
BUDGET_PARSER_ARTIFACT_S3_PREFIX
AWS_REGION
```

Optional local S3-compatible rehearsal:

```text
BUDGET_VERIFICATION_S3_ENDPOINT
```

Provider execution:

```text
LLAMAPARSE_API_KEY
LLAMAPARSE_BASE_URL
```

The persisted command also requires:

```text
DATABASE_URL
--source-document-id <uuid>
--persist-verification-audit
```

No shared database, AWS object, or provider was touched during this
implementation session.

## 7. Test coverage added or strengthened

```text
extraction-artifact-bridge.spec.ts
parser-router-v1.service.spec.ts
s3-parser-artifact-store.spec.ts
prisma-parser-run-recorder.spec.ts
native-structured-companion.spec.ts
route-planner-closeout.spec.ts
operator-cli-closeout.spec.ts
apps/defense-budget-parser/tests/test_cli.py
```

Coverage includes:

- strict and semantic artifact validity;
- actual router execution and state transitions;
- exact Phase 2 request identities;
- verified cache replay;
- pdfplumber-to-Camelot escalation;
- versioned S3 replay and mutated-byte refusal;
- idempotent parse-job recording;
- native companion proof;
- OCR/native/repeat/round/paid-cap policy;
- operator refusal and deterministic planning;
- profile-all and Docling runtime dispatch.

## 8. Negative-control implementation

`verify-pe-budget-phase-3-negative-controls.ts` executes all 20 required
controls. Each control:

1. saves exact target bytes;
2. injects one defined defect;
3. runs its named test or architecture/cross-language gate;
4. requires that gate to fail;
5. restores the exact bytes;
6. reruns the same gate;
7. requires restored green.

No control uses a hard-coded `passed: true` result.

## 9. Sample free local execution report shape

```json
{
  "executionId": "r1-army-fy2027-<source-prefix>",
  "finalState": "TERMINAL_REVIEW",
  "artifactId": "dbx1_<sha256>",
  "artifactLocator": "work/.../artifacts/<id>.extraction-v1.json",
  "artifactContentSha256": "<sha256>",
  "artifactByteSha256": "<sha256>",
  "verifierDecision": "REVIEW",
  "unresolvedFindings": ["router_family_assertion_mapping_deferred"],
  "paidPagesUsed": [],
  "localPagesUsed": {
    "deterministic_pdfplumber": [1, 2, 3]
  },
  "reusedArtifacts": [],
  "rounds": [],
  "costReport": {
    "providerCreditsUsed": null
  },
  "nextOperatorAction": "Review unresolved findings or supply a registered family extractor/reference artifact."
}
```

This is a schema example, not an observed run from this GitHub connector
session.

## 10. Paid-call safety confirmation

- no paid provider call by default;
- no paid provider construction without explicit authorization and cap;
- exact selected pages only;
- page cap enforced before provider call;
- no automatic new-job retry;
- proven cache prevents another call;
- corrupt cache never grants permission to spend;
- provider job ID, raw proof, normalized content SHA, versioned output locator,
  and exact object byte SHA remain distinct and auditable.

## 11. Phase 2 integration evidence

The router supplies:

- `manifestLocator` from the actual manifest file;
- exact manifest document key;
- artifact locator;
- supplied SourceDocument ID;
- source PDF SHA from actual bytes;
- extraction artifact byte SHA from actual written bytes;
- inspect or explicit persist mode.

Persisted local/paid parser output and Phase 2 audit use one production context.
Provider job identity is preserved in the final parser-run declaration, allowing
Phase 2 to query the exact parse job rather than an arbitrary source-level row.

## 12. Canonical-write isolation

The permanent architecture guard fails on:

```text
ProgramElementWriterService
upsertProgramElement
upsertProgramElementYear
programElementYear.create/update/upsert
assertPromotionReady
getCanonicalPromotionRecords
promotionReady
canonicalEligible
```

The API Dockerfile is guarded against Python/Docling/Paddle/Torch installation.
The Python runtime is guarded against AWS, database, LlamaParse, OpenAI, and
Anthropic imports.

## 13. Required local closeout

Run without containers:

```bash
pnpm --dir apps/api exec tsx scripts/verify-pe-budget-phase-3-closeout.ts
```

Run the complete definition of done including Docker targets:

```bash
pnpm --dir apps/api exec tsx scripts/verify-pe-budget-phase-3-closeout.ts \
  --include-containers
```

This executes Phase 1/2/3 regressions, strict TypeScript, Prisma validation,
architecture and cross-language gates, locked Python sync/tests/Ruff/mypy, all
20 mutate–fail–restore controls, Prettier, and optional container builds.

## 14. Known limitations and downstream dependencies

- The generic Phase 3 bridge intentionally does not invent R-1/R-2/R-2A/R-3
  budget assertions. A registered family artifact factory or explicit native
  structured companion is required for complete semantic verification.
- Automatic source discovery, schedules, Fargate deployment, production
  backfill, review UI, and canonical promotion remain out of scope.
- Live LlamaParse and real production-document smokes require separate explicit
  authorization.
- Shared environment audit persistence requires registered SourceDocument rows
  and separate operational authorization.

## 15. Safety confirmation

- No merge.
- No deployment.
- No shared migration application.
- No AWS infrastructure change.
- No automatic source discovery.
- No unapproved paid parser call.
- No production PDF parse.
- No canonical Program Element write.
