# PE Enrichment — Phase 1 Report

**Date:** 2026-08-01  
**Env:** sole-live `capiro-dev`  
**API image:** `b792f2d24920d56d7addcda88a602c6282563f47`  
**Quality bar:** **all PE lines** (no marquee subset)  
**Extraction policy:** **LlamaParse only** (`pdf_premium` for money tables) — **no pdfplumber**  
**Models / tools for this job:**

| Layer | Choice | Why |
|---|---|---|
| PDF money tables | **LlamaParse `pdf_premium`** | Best layout/table fidelity in our client (`premium_mode=true`) |
| Scanned pages | LlamaParse `pdf_ocr` | Only when no text layer |
| Ops judgment / plans | x-ai/grok-4.5 (session) | Cost-conscious PE default |
| Canonical dollars | Exact-SHA loaders + writer | Not LLM-invented numbers |
| Forbidden | pdfplumber, chat-model PE dollars | Per Neo |

---

## Phase 1 scope (WS-A / B / C / D)

| ID | Task | Result |
|---|---|---|
| A1–A3 | Observation key hygiene dry-run | **DONE** — see §A |
| B1–B4 | LlamaParse secret + extract-only pilot | **DONE with gap** — see §B |
| C1 | LegiWatch / PE schedule inventory | **DONE** — see §C |
| D1 | Bill↔PE auto path | **PARTIAL** — see §D |
| E0 residual | Full-corpus quality stance | **Locked** — no marquee list |

---

## §A — Hygiene (observation keys)

**Task:** `backfill-pe-observation-keys` DRY-RUN  
**ECS:** `44f989bdb6a74025b7f92844877c7356` exit **0**

| Metric | Value |
|---|---|
| mode | DRY-RUN |
| candidateCount (null keys / null canonicalValueM) | **0** |
| alreadyLegacyStamped | **99,704** |
| multipleWinnerGroups | **0** (good) |
| duplicateLegacyGroups (sample cap 200) | **200 listed** |

**Duplicate sample classification (top sources in 200-cap list):**

| Source | Groups in sample |
|---|---|
| `p_doc_army_fy27` | 87 |
| `p_doc_army` | 73 |
| `stanford_pe_directory_jan2026` | 39 |
| `p_doc_af_fy27` | 1 |

**Fields:** mostly `__row__` (127) and `request` (73).

### Interpretation
- Phase D **observationKey backfill is already complete** (no remaining candidates).  
- Trust diag blockers (`null_source_document_observation`, `duplicate_observations`) are **not** fixed by observationKey stamp — they need a **separate dedupe / source_document attach** workstream (Phase 1.1 / before mass dollar re-commit).  
- **No `--commit` on backfill** required right now (nothing to stamp).

### Artifact
- `docs/program-elements/enrichment/phase1-obskeys-dryrun.json` (worktree)  
- Task log retained in CloudWatch `/capiro/dev/api`

---

## §B — LlamaParse platform + R-1 pilot

### B1 Secret
- SM: `/capiro/dev/llamaparse/api-key` (plain string, len 52)  
- **Not** on live `capiro-dev-api` task definition secrets today  
- Task role simulate `GetSecretValue` → **implicitDeny** (must inject via one-shot env or fix IAM + TD)  
- **Ops note:** one-shot TDs that embed the key were **deregistered** after use (`:92`, `:93`)

### B2–B4 Extract-only pilot — FY2027 R-1

| Step | Result |
|---|---|
| Official PDF | `https://comptroller.war.gov/.../FY2027_r1.pdf` |
| Local sha256 | `1aa8846edb69d4c3a54e03b383b0cabb77f93433162b8139ab8cbb55bcc7882a` |
| Staging upload | `s3://capiro-defense-budget-raw-dev-.../incoming/fy2027/FY2027_r1.pdf` (SSE-KMS required) |
| ECS task | `33e89388a2f445eaa315462f9049508c` exit **0** |
| Mode | **`pdf_premium`** |
| Posture | `extract_only`, `canonicalWrites: false` |
| LlamaParse job | `dbb04c50-66ac-4929-84d0-f30959f82fed` |
| Immutable archive | `raw/public/dod-budget/.../original.pdf` versionId `Co2I4fuNN3XZWiDAoiF1f.mFSLd3F2ki` |
| Derived MD/JSON | written under `derived/public/dod-budget/.../parsed.pages-all.{md,json}` |
| Mapper output | **`lines: 0`, `values: 0`** |

### Parse quality (raw LlamaParse JSON)
Downloaded derived JSON (~3.0 MB):

| Check | Value |
|---|---|
| pages | **125** |
| PE-like codes in text | **~1130** unique (`0101113F`, …) |
| classic PE pattern | **~1042** |
| Cover text | “RDT&E PROGRAMS (R-1) … Fiscal Year 2027” |

**Conclusion:** LlamaParse **premium worked** and saw the PE universe.  
**Blocker for “all lines perfect”:** our **RDTE assertion extractor/mapper did not emit lineAssertions/yearValues** from this LlamaParse JSON shape → cannot exact-SHA promote PE-year dollars yet from this path.

### Root cause hint (post-parse analysis)
LlamaParse JSON has **125 pages**, **127 table items**, **121 pages with tables**. Sample table `md` includes proper R-1 headers (`Program Element Number`, FY columns) and pipe rows. PE codes are present in text (~1042 classic).

Likely mapper issue: adapter expects `items[type=table].rows` matrix and/or GitHub pipe tables; if `rows` is empty/malformed and pipe parse drops separators incorrectly, extractors emit 0 lines. **Fix:** harden `llamaparse-adapter` + `rdte.extractor` against this R-1 fixture (`sha256=1aa8846e…`, job `dbb04c50-…`) until lines ≫ 0 offline.


### LlamaParse unit audit (SELECT-only)
**Task:** `cd18e97ff22747d0ac964d94504c4ebf` exit 0  
- `llamaFieldsExamined: 0`, `provenAffected: 0`  
- No historical LlamaParse canonical winners to fix — clean slate for units.

### Permanent platform gaps to close (Phase 1.1 / 2)
1. Wire `LLAMA_CLOUD_API_KEY` from SM onto API one-shot / migrate TD (no env-in-TD secrets).  
2. IAM: task role `GetSecretValue` on `/capiro/dev/llamaparse/api-key`.  
3. **Fix RDTE extractor** for LlamaParse `pages[].text|md|items` → `lineAssertions` + `yearValues` (this is the critical path for full-corpus quality).  
4. Prefer S3/`s3://` paths (HTTPS bare URLs are not accepted by ingest `--path`).  
5. Raw bucket puts require **SSE-KMS** key `29f4399d-4a5c-449e-b28d-29a7e71b8970`.

---

## §C — LegiWatch / schedules (must stay on)

| Rule | State | Schedule | Notes |
|---|---|---|---|
| `capiro-dev-sync-congress` | ENABLED | cron 09:00 UTC daily | Legislation spine |
| `capiro-dev-sync-congress-members` | ENABLED | Mon/Thu | |
| `capiro-dev-derive-bill-status` | ENABLED | every 6h | |
| `capiro-dev-detect-bill-changes` | ENABLED | every 6h | |
| `capiro-dev-emit-bill-alerts` | ENABLED | every 6h | |
| `capiro-dev-pe-derive-chain` | ENABLED | 10:30 UTC | **already `--commit`** |
| `capiro-dev-watch-budget-docs` | ENABLED | 12:00 UTC | **already `--commit`** |
| `capiro-dev-match-pe-mentions` | ENABLED | 12:45 UTC | hearing/title PE mentions (`--commit --limit 50`) |
| `capiro-dev-enrich-award-pe` | ENABLED | | awards PE tag |
| LDA / LegiScan / Legistorm / OpenStates | ENABLED (various) | | LegiWatch stack |

**PE enrichment did not disable any of these.**

### watch-budget-docs dry-run (extra inventory)
**Task:** `f27f7740959f49308abfb6d8e20472ee` exit 0

```json
scanned: 168, known: 152, new_detections: [], revised: []
degraded_sources:
  - service-index:secnav (fetch failed)
  - service-index:saffm (fetch failed)
  - congress-reports (CONGRESS_API_KEY not set on api TD)
```

**Gap:** scheduled `watch-budget-docs` runs on `capiro-dev-api-migrate` TD which **has** `CONGRESS_API_KEY`; bare `capiro-dev-api` service TD does **not**. One-shots from service TD miss Congress.gov committee reports. Fix: run watch one-shots on migrate TD or add key to API secrets.

---

## §D — PE lines from congressional activity

| Path | Status |
|---|---|
| Bill text PE codes (`extract-bill-pe-codes`) | Script exists; **no dedicated EventBridge rule name found** in account list — may be missing from live schedule or named differently |
| Hearing/title PE mentions (`match-pe-mentions`) | **ENABLED** daily with `--commit` |
| Congress sync | **ENABLED** |

**Action for Phase 1.1:** Confirm whether `extract-bill-pe-codes` is actually scheduled; if not, **add** rule (do not rely only on match-pe-mentions). Full-corpus “perfect” PE↔legislation needs the bill-text extractor on a cadence.

---

## Full-corpus quality stance (no marquee)

Neo directive: **all PE lines should come out perfect** — no marquee subset.

Implications encoded for Phase 2+:

1. Every official current-cycle R-1 PE row must parse → map → promote with provenance.  
2. Mapper **0 lines** on a 125-page R-1 with 1k+ codes = **release blocker** for dollar promote.  
3. Hygiene duplicates (p_doc / stanford) must be cleaned so replay/idempotency stays honest at full scale.  
4. Conference + SAC-D/HAC-D gaps remain data completeness work after extract path is fixed.  
5. Success metric replaces “marquee checklist” with **coverage SLOs** (e.g. % of R-1 PE codes present as PE entities; % with request for current FY; marks/conf/enacted where source exists).

---

## Phase 1 exit status

| Gate | Status |
|---|---|
| Hygiene inventory | **PASS** (keys done; dupes classified) |
| LlamaParse pilot extract-only | **PASS** (vendor + archive + derived) |
| LlamaParse → PE line mapping | **FAIL / BLOCKER** (0 lines) — Phase 2 engineering |
| LegiWatch left running | **PASS** |
| watch-budget-docs live | **PASS** (scheduled); Congress key gap on api TD |
| extract-bill-pe-codes scheduled | **UNKNOWN / likely gap** |
| Ready for mass PE-year commit | **NO** |

**Phase 1 = complete for readiness discovery; not complete for dollar promotion.**

---

## Immediate Phase 1.1 / Phase 2 backlog (ordered)

1. **P0 — RDTE LlamaParse extractor:** map `pages[].md/text/items` tables → PE codes + $ → `lineAssertions`/`yearValues`; unit tests with this R-1 fixture (`sha256=1aa8846e…`).  
2. **P0 — Re-run extract-only or map-from-derived** on stored JSON (avoid re-billing if possible); expect lines ≫ 0.  
3. **P0 — IAM + TD:** `LLAMA_CLOUD_API_KEY` from SM on one-shot role; never leave key in active task def.  
4. **P1 — Schedule `extract-bill-pe-codes`** if missing; verify SyncRuns.  
5. **P1 — watch-budget-docs:** ensure CONGRESS_API_KEY on the TD that runs the rule (migrate TD OK); fix secnav/saffm degraded if possible.  
6. **P1 — Dedupe plan** for p_doc + stanford `__row__` duplicates (no silent delete).  
7. **P2 — After mapper green:** exact-SHA commit R-1 full corpus + replay; then R-2 volumes; then marks/conference.  

---

## Artifacts

| Path | What |
|---|---|
| `Downloads/pe-closeout/enrichment/ENRICHMENT-PLAN.md` | Complete program plan |
| `Downloads/pe-closeout/enrichment/FY2027_r1.pdf` | Official R-1 bytes |
| `Downloads/pe-closeout/enrichment/r1_parsed.json` | LlamaParse derived JSON |
| `s3://…/raw/.../original.pdf` | Immutable archive |
| `s3://…/derived/.../parsed.pages-all.json` | Derived parse |
| PDF sha256 | `1aa8846edb69d4c3a54e03b383b0cabb77f93433162b8139ab8cbb55bcc7882a` |
| Parse job | `dbb04c50-66ac-4929-84d0-f30959f82fed` |

---

## Recommended next command from Neo

**“Start Phase 2 — fix RDTE LlamaParse mapper and promote R-1”**  
(or split: engineering PR for extractor first, then ops promote)

No PE-year canonical commits were made in Phase 1.  
No LegiWatch jobs were paused.  
No pdfplumber was used.
