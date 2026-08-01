# PE Enrichment — Phase 1 leftovers + Phase 2 status

**Date:** 2026-08-01  
**Branch:** `agent/pe-enrichment-r1-llamaparse-mapper` @ `096c37f61369e4e482b6dbf406a6b6319b1bf5e0`  
**Env:** sole-live `capiro-dev`  
**Extraction:** LlamaParse `pdf_premium` only (no pdfplumber)  
**Quality bar:** full corpus (no marquee)

---

## Phase 1 leftovers — RESOLVED

| Item | Resolution |
|---|---|
| LlamaParse task role `GetSecretValue` | IAM inline policy `pe-enrichment-secrets-read` on ApiTaskRole → **allowed** |
| One-shot TD with LP + Congress + raw bucket env | Family `capiro-dev-api-pe-enrichment` (rev 6 tip) |
| `CONGRESS_API_KEY` on migrate TD | Added on `capiro-dev-api-migrate:42` (+ LP + DEFENSE_BUDGET_* env) |
| Retarget PE EventBridge rules to migrate:42 | watch-budget-docs, pe-derive-chain, match-pe-mentions, extract-bill-pe-codes |
| `extract-bill-pe-codes` schedule | **Created** `capiro-dev-extract-bill-pe-codes` ENABLED `cron(15 9 * * ? *)` |
| Observation key stamp | Already complete (0 candidates) |
| Dedupe procedure | Documented `docs/program-elements/enrichment/phase1-dedupe-plan.md` (execute later) |
| LegiWatch | **Never paused** — congress/LDA/etc. still ENABLED |

---

## Phase 2 — DONE vs OPEN

### Done
| Work | Evidence |
|---|---|
| Root cause: PE in col 1 | Fixed `findPeCodeInRow` + R-1 tests |
| Offline full R-1 map | **1128** PE lines / **2411** request values (request-only) |
| Classifier R-1 vs R-2 | `FY2027_r1.pdf` → exhibit **R-1** |
| R-1 field ownership | request only; `llamaparse*` / `*_r1` → `presidents_budget_request` |
| Quality false positives | E-7 designator titles; guardRows exclude enacted/executed |
| Prisma advisory lock | `$executeRaw` for void `pg_advisory_xact_lock` |
| LlamaParse extract-only live | exit 0; lines=1128 values=4830 (pre request-only) then request-only path |
| API images in ECR | tags `096c37f6…`, `pe-r1-mapper` |
| API service rolling | `capiro-dev-api` updated toward tip image (deploy in progress) |
| Unit tests | 41+ related jest tests PASS |

### Open — R-1 exact-SHA **canonical promote**
Latest commit task still fails after ownership/quality fixes:

```text
Expected exactly one new canonical observation for 0601102A FY2026 __row__; found 0
```

Meaning: writer/reconcile path is not creating a fresh `__row__` observation the promote linker expects (or source string mismatch / no-op year write).  
**Not** a LlamaParse extract failure — extract + map are green.

**Next engineering (Phase 2.1):**
1. Trace `upsertProgramElementYear` for `llamaparse_fy2027_r1` — does it emit `__row__`?
2. Align promote query source keys (`input.source` vs baseSource) with what reconcile logs.
3. If year already identical, define idempotent promote (skip `__row__` link or accept 0 fresh when unchanged).
4. Live commit + **replay** (0 new rows) + diag delta.

---

## Key SHAs / artifacts

| Item | Value |
|---|---|
| Branch tip | `096c37f61369e4e482b6dbf406a6b6319b1bf5e0` |
| R-1 PDF sha256 | `1aa8846edb69d4c3a54e03b383b0cabb77f93433162b8139ab8cbb55bcc7882a` |
| LlamaParse job (first pilot) | `dbb04c50-66ac-4929-84d0-f30959f82fed` |
| S3 archive | `s3://capiro-defense-budget-raw-dev-…/raw/public/dod-budget/.../original.pdf` |
| Derived JSON | `…/parsed.pages-all.json` |
| Metrics | `docs/program-elements/enrichment/r1_extract_metrics.json` |
| Plan | `docs/program-elements/enrichment/ENRICHMENT-PLAN.md` |

---

## Recommended next command

**“Continue Phase 2.1 — fix __row__ observation link and finish R-1 promote+replay”**

No mass PE-year dollars written yet (transaction aborts). LegiWatch untouched.
