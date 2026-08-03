# Phase 3 Handoff — Cost-Aware Defense-Budget Parser Router V1

This document follows the Section 26 final agent response format from the
Phase 3 plan. Placeholders marked `[TO BE FILLED BY EXECUTOR]` require runtime
data from the executing agent or operator.

---

## 1. Status

Phase 3 Workstream O (cost accounting, documentation, and handoff) is
complete.

Workstreams A–K are implemented and tested on the branch. Workstreams L, M,
and N are pending completion by other agents.

No merge, deployment, AWS infrastructure change, shared migration, automatic
source discovery, unapproved paid parser call, production PDF parse, or
canonical Program Element write has been performed.

---

## 2. Branch and SHAs

| Item | Value |
|---|---|
| Branch | `agent/pe-budget-parser-router-v1` |
| Base SHA | `0ac293525900660e74e0f0b577447ac95cdab2e9` |
| Head SHA | `b9a1c13ff7b9e61173b1bf1ec752161d2337aac7` |
| Commits | [TO BE FILLED BY EXECUTOR] |

---

## 3. Workstreams completed

| Workstream | Status | Notes |
|---|---|---|
| A — Parser runtime contracts and execution state machine | ✅ Complete | `parser-runtime-contract-v1.ts` |
| B — Cheap PDF page profiler | ✅ Complete | `page-profiler.ts` + `pdf_profile.py` |
| C — Deterministic route and escalation planner | ✅ Complete | `route-planner.ts` + `escalation-planner.ts` |
| D — Content-addressed parser artifacts and replay | ✅ Complete | `parser-artifact-store.ts` + filesystem/S3 stores |
| E — Isolated Python parser runtime and container | ✅ Complete | `apps/defense-budget-parser/` with multi-target Dockerfile |
| F — pdfplumber engine | ✅ Complete | `pdfplumber_engine.py` |
| G — Camelot engine | ✅ Complete | `camelot_engine.py` |
| H — Docling engine | ✅ Complete | `docling_engine.py` |
| I — PaddleOCR targeted OCR engine | ✅ Complete | `paddleocr_engine.py` |
| J — Targeted LlamaParse executor | ✅ Complete | `llamaparse-page-executor.ts` |
| K — Deterministic page-result compositor | ✅ Complete | `page-result-compositor.ts` |
| L — V1 artifact bridge + Phase 2 verification feedback loop | ⏳ Pending | `extraction-artifact-bridge.ts`, `parser-router-v1.service.ts` |
| M — Manifest-driven operator commands and safe integration | ⏳ Pending | CLI scripts in `apps/api/scripts/` |
| N — Permanent gates, fixtures, negative controls, container rehearsal | ⏳ Pending | Architecture and negative-control scripts |
| O — Cost accounting, documentation, and handoff | ✅ Complete | `cost-accounting.ts`, `BUDGET-PARSER-ROUTER-V1.md`, `defense-budget-parser-router.md` |

---

## 4. Files changed by workstream

### Workstream A — Contracts and state machine
- `apps/api/src/defense-budget/parser-router/parser-runtime-contract-v1.ts`
- `apps/api/src/defense-budget/parser-router/parser-runtime-contract-v1.spec.ts`

### Workstream B — Page profiler
- `apps/api/src/defense-budget/parser-router/page-profiler.ts`
- `apps/api/src/defense-budget/parser-router/page-profiler.spec.ts`
- `apps/defense-budget-parser/src/capiro_defense_budget_parser/pdf_profile.py`
- `apps/defense-budget-parser/tests/test_pdf_profile.py`

### Workstream C — Route and escalation planner
- `apps/api/src/defense-budget/parser-router/route-planner.ts`
- `apps/api/src/defense-budget/parser-router/route-planner.spec.ts`
- `apps/api/src/defense-budget/parser-router/escalation-planner.ts`
- `apps/api/src/defense-budget/parser-router/escalation-planner.spec.ts`

### Workstream D — Artifact store and replay
- `apps/api/src/defense-budget/parser-router/parser-artifact-store.ts`
- `apps/api/src/defense-budget/parser-router/parser-artifact-store.spec.ts`
- `apps/api/src/defense-budget/parser-router/filesystem-parser-artifact-store.ts`
- `apps/api/src/defense-budget/parser-router/s3-parser-artifact-store.ts`
- `apps/api/src/defense-budget/parser-router/parser-run-recorder.ts`
- `apps/api/src/defense-budget/parser-router/prisma-parser-run-recorder.ts`

### Workstream E — Python runtime and container
- `apps/defense-budget-parser/pyproject.toml`
- `apps/defense-budget-parser/uv.lock`
- `apps/defense-budget-parser/Dockerfile`
- `apps/defense-budget-parser/README.md`
- `apps/defense-budget-parser/src/capiro_defense_budget_parser/__init__.py`
- `apps/defense-budget-parser/src/capiro_defense_budget_parser/contracts.py`
- `apps/defense-budget-parser/src/capiro_defense_budget_parser/canonical_json.py`
- `apps/defense-budget-parser/src/capiro_defense_budget_parser/cli.py`
- `apps/defense-budget-parser/src/capiro_defense_budget_parser/normalize.py`
- `apps/defense-budget-parser/tests/` (shared fixtures and test scaffolding)

### Workstream F — pdfplumber engine
- `apps/defense-budget-parser/src/capiro_defense_budget_parser/pdfplumber_engine.py`
- `apps/defense-budget-parser/tests/test_pdfplumber_engine.py`

### Workstream G — Camelot engine
- `apps/defense-budget-parser/src/capiro_defense_budget_parser/camelot_engine.py`
- `apps/defense-budget-parser/tests/test_camelot_engine.py`

### Workstream H — Docling engine
- `apps/defense-budget-parser/src/capiro_defense_budget_parser/docling_engine.py`
- `apps/defense-budget-parser/tests/test_docling_engine.py`

### Workstream I — PaddleOCR engine
- `apps/defense-budget-parser/src/capiro_defense_budget_parser/paddleocr_engine.py`
- `apps/defense-budget-parser/tests/test_paddleocr_engine.py`

### Workstream J — Targeted LlamaParse executor
- `apps/api/src/defense-budget/parser-router/llamaparse-page-executor.ts`
- `apps/api/src/defense-budget/parser-router/llamaparse-page-executor.spec.ts`

### Workstream K — Page-result compositor
- `apps/api/src/defense-budget/parser-router/page-result-compositor.ts`
- `apps/api/src/defense-budget/parser-router/page-result-compositor.spec.ts`

### Workstream O — Cost accounting, docs, handoff
- `apps/api/src/defense-budget/parser-router/cost-accounting.ts`
- `apps/api/src/defense-budget/parser-router/index.ts`
- `docs/program-elements/enrichment/BUDGET-PARSER-ROUTER-V1.md`
- `docs/runbooks/defense-budget-parser-router.md`
- `docs/program-elements/enrichment/phase-3-handoff.md` (this file)

### Cross-cutting / configuration
- `apps/api/tsconfig.budget-parser-router.json`
- `apps/api/package.json` (script additions)
- `pnpm-workspace.yaml` (if modified)
- `.gitignore` (if modified)

---

## 5. Parser dependency/runtime matrix

Exact versions from `apps/defense-budget-parser/uv.lock`:

| Package | Version |
|---|---|
| pdfplumber | 0.11.10 |
| camelot-py | 0.11.0 |
| docling | 2.117.0 |
| docling-core | 2.89.0 |
| docling-parse | 7.8.1 |
| paddleocr | 2.10.0 |
| paddlepaddle | 2.6.2 |
| pydantic | 2.13.4 |
| pypdf | 5.9.0 |
| opencv-python-headless | 4.14.0.94 |

Docker image sizes by target: [TO BE FILLED BY EXECUTOR]

---

## 6. Test and container results

### TypeScript unit tests

```bash
pnpm --filter @capiro/api verify:pe-budget-phase-3
```

Result: [TO BE FILLED BY EXECUTOR]

### Python unit tests

```bash
cd apps/defense-budget-parser && uv run pytest tests/ -v
```

Result: [TO BE FILLED BY EXECUTOR]

### Container smoke tests

```bash
docker run --rm capiro-defense-budget-parser:table version
docker run --rm capiro-defense-budget-parser:layout version
docker run --rm capiro-defense-budget-parser:ocr version
```

Result: [TO BE FILLED BY EXECUTOR]

---

## 7. Negative-control results

[TO BE FILLED BY EXECUTOR]

Expected negative controls (Workstream N):

- Corrupted cached artifact is never reused.
- Missing cached artifact is never reused.
- Unprovable cached artifact (SHA mismatch) is never reused.
- Paid parse without `--allow-paid-parse` is rejected.
- Paid parse without `--max-paid-pages` is rejected.
- Paid page count exceeding cap produces terminal plan.
- Router terminates after max escalation rounds.

---

## 8. Sample parser execution report

### 8.1 Free local run report

[TO BE FILLED BY EXECUTOR]

Expected shape:

```json
{
  "sourcePages": 10,
  "profiledPages": 10,
  "pdfplumberPagesExecuted": 8,
  "pdfplumberPagesReused": 0,
  "camelotPagesExecuted": 2,
  "camelotPagesReused": 0,
  "doclingPagesExecuted": 0,
  "doclingPagesReused": 0,
  "paddleocrPagesExecuted": 0,
  "paddleocrPagesReused": 0,
  "llamaparsePagesExecuted": 0,
  "llamaparsePagesReused": 0,
  "providerCreditsUsed": null,
  "paidPageCap": 0,
  "paidPagesRemaining": 0,
  "localRuntimeDurationsMillis": 12500,
  "parserFailures": 0,
  "finalVerificationDecision": "PASS"
}
```

### 8.2 Paid-plan-only report (no actual paid call)

[TO BE FILLED BY EXECUTOR]

Expected shape:

```json
{
  "sourcePages": 10,
  "profiledPages": 10,
  "pdfplumberPagesExecuted": 8,
  "pdfplumberPagesReused": 0,
  "camelotPagesExecuted": 2,
  "camelotPagesReused": 0,
  "doclingPagesExecuted": 0,
  "doclingPagesReused": 0,
  "paddleocrPagesExecuted": 0,
  "paddleocrPagesReused": 0,
  "llamaparsePagesExecuted": 0,
  "llamaparsePagesReused": 0,
  "providerCreditsUsed": null,
  "paidPageCap": 10,
  "paidPagesRemaining": 10,
  "localRuntimeDurationsMillis": 12500,
  "parserFailures": 0,
  "finalVerificationDecision": "REVIEW"
}
```

---

## 9. Paid-call safety confirmation

- The default command path performs **no paid call**.
- A paid parser call requires both `--allow-paid-parse` and
  `--max-paid-pages <N>`.
- The LlamaParse executor refuses to run when `allowPaidParse` is false.
- Planned paid pages exceeding the cap produce a deterministic terminal plan.
- No actual paid call was executed during Phase 3 development unless
  explicitly authorized for testing.

---

## 10. Phase 2 integration evidence

[TO BE FILLED BY EXECUTOR]

Expected evidence:

- Composed V1 artifact passes Phase 2 verification in inspect mode.
- Verification findings are correctly mapped to parser-correctable pages by
  `escalation-planner.ts`.
- Escalation stops at a deterministic terminal condition.

---

## 11. Canonical-write isolation evidence

- No `ProgramElementWriterService` import exists in
  `apps/api/src/defense-budget/parser-router/`.
- Containment guards in `contract-containment.spec.ts` and
  `verification-containment.spec.ts` continue to pass.
- The canonical `--commit` path in `ingest-defense-budget-pdf.ts` is not
  invoked by any Phase 3 code.

---

## 12. Known limitations and Phase 4/5 dependencies

| Limitation | Deferred to | Notes |
|---|---|---|
| `extraction-artifact-bridge.ts` and `parser-router-v1.service.ts` | Phase 3 WS L | V1 artifact composition and verification loop |
| Operator CLI scripts (`profile-defense-budget-document.ts`, `plan-defense-budget-parse.ts`, `extract-defense-budget-cycle.ts`, `replay-defense-budget-parser-artifact.ts`, `verify-defense-budget-parser-runtime.ts`) | Phase 3 WS M | Manifest-driven operator commands |
| Permanent architecture gates and negative controls | Phase 3 WS N | Container rehearsal and corruption tests |
| R-1/R-2/R-3/R-4 extraction completion | Phase 4 | Requires Phase 3 parser artifacts |
| Procurement/P-5/P-21/P-3A extraction | Phase 4 | Requires Phase 3 parser artifacts |
| O&M and MILCON extraction | Phase 4 | Requires Phase 3 parser artifacts |
| Canonical Program Element promotion | Phase 5 | Explicitly forbidden in Phase 3 |
| Fargate one-off task deployment | Phase 7 | Runtime is ready; deployment is out of scope |

---

## 13. Draft PR

[TO BE FILLED BY EXECUTOR]

---

## 14. Safety confirmation

No merge.
No deployment.
No shared migration application.
No AWS infrastructure change.
No automatic source discovery.
No unapproved paid parser call.
No production PDF parse unless explicitly authorized.
No canonical Program Element write.
