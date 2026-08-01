# Program Elements — Complete Enrichment Plan

**Status:** ACTIVE (post–PR #705 merge / sole-live ship)  
**Env:** sole-live `capiro-dev` / `app.capiro.ai` / Aurora `capiro`  
**Code tip at plan start:** main `b792f2d24920d56d7addcda88a602c6282563f47`  
**Baseline evidence:** `docs/program-elements/enrichment/baseline-2026-08-01.md` + `diag-pe-trust-2026-08-01.json`  
**Owner:** Neo + PE ops sessions  
**Non-goals of closeout PR:** already closed; this plan is **ops + data**, not another closeout phase ladder.

---

## 0. Purpose

Make PE data **complete enough for product trust** under the post-closeout gates:

1. Fill PE-year dollars and provenance for loaded source families (current cycle first).  
2. Keep **LegiWatch / legislation auto-population** running without pause or rewire.  
3. Keep **bill ↔ PE auto-link** (`extract-bill-pe-codes`) healthy.  
4. Stand up a **reliable conference → PE funding update path** (detect → LlamaParse extract → exact-SHA promote → derive).  
5. Never claim human-reviewed accuracy for synthetic or un-audited rows.  
6. Fail closed on unsupported source families.

**Done** means: marquee + current-cycle coverage honest and dense where sources exist; auto rails for legislation and PE-bill links green; conference detection + load path proven end-to-end; trust blockers reduced per hygiene SLOs; no pdfplumber in the active extract path.

---

## 1. Non-negotiable rules

| # | Rule |
|---|---|
| R1 | **LlamaParse only** for new PDF extraction. **Do not use pdfplumber** (or other cheap local table scrapers) for PE money extracts. |
| R2 | LlamaParse secret: AWS SM `/capiro/dev/llamaparse/api-key` → runtime `LLAMA_CLOUD_API_KEY`. Never commit keys. |
| R3 | Default posture = **inspect / extract-only**. Canonical PE-year writes only via **`--commit --approved-sha256 <sha>`** after audit. |
| R4 | Generalized path: `ingest-defense-budget-pdf.ts` with `--extract-only --allow-vendor-parse` before any commit. Prefer mode **`pdf_premium`** for dollar tables; **`pdf_ocr`** only for scanned pages. |
| R5 | Exact-SHA dollar loaders list remains authority (`PE_EXACT_SHA_DOLLAR_LOADERS`). One artifact / one approved SHA per commit. |
| R6 | **Unsupported / blocked** families (coverage matrix) never write canonical PE year fields. |
| R7 | **LegiWatch and legislation schedules stay on.** PE enrichment must not disable, rewrite, or “pause for maintenance” congress/LDA/bill pipelines. |
| R8 | **Auth vs approps tracks stay separated.** NDAA conference → `ndaaConference`; appropriations conference → `conference`. Never blend. |
| R9 | Outyears must never be labeled the current ask. Zeros are real. |
| R10 | Email / canaries / derive `--commit` / mass alert fan-out stay **dark** unless Neo explicitly opens them. |
| R11 | Entrypoint traps: `sync-comptroller-jbooks` / `sync-jbook-r2` / performers **force `--commit`**. For inspect, run `tsx scripts/….ts` **without** those verbs (custom one-shot entrypoint). |
| R12 | Do not bulk re-promote dollars until observation hygiene plan is accepted (baseline trust blockers). |
| R13 | Synthetic / AI rows never labeled human-reviewed. Human goldens are a separate workstream. |
| R14 | One new parser family per future PR if a family is unsupported today. |

---

## 2. Architecture (target end state)

```text
┌──────────────────────────────────────────────────────────────────────┐
│ LEGISLATION / LEGIWATCH (unchanged, always on)                       │
│  sync-congress* → bills/actions/text                                  │
│  extract-bill-pe-codes (daily) → bill↔PE links                        │
│  LDA / hearings / alerts (existing schedules)                         │
└───────────────────────────────┬──────────────────────────────────────┘
                                │ PE codes in bill text
                                ▼
┌──────────────────────────────────────────────────────────────────────┐
│ PE ENTITY + WATCH UI (api + web already on main)                      │
│  program_element / year / sources / CRM / data_issue                  │
└───────────────────────────────┬──────────────────────────────────────┘
                                ▲
┌───────────────────────────────┴──────────────────────────────────────┐
│ DOLLAR + MARK INGEST (enrichment focus)                               │
│  watch-budget-docs → detect new/revised PDFs                          │
│  LlamaParse (ingest-defense-budget) → extract-only artifacts          │
│  family loaders (jbook / marks / ndaa / approps / public-law / pdoc)  │
│       inspect → audit → commit --approved-sha256                      │
│  writer + source_document + observations (fail-closed ownership)     │
│  run-pe-derive-chain (dry-run default; commit only if authorized)     │
└──────────────────────────────────────────────────────────────────────┘
```

### Extraction stack (policy)

| Layer | Tool | When |
|---|---|---|
| PDF parse | **LlamaParse** (`pdf_premium` default) | All new PE budget PDFs |
| Archive | Immutable S3 + SourceDocument (Object Lock path where configured) | Before/with extract |
| Promote | Exact-SHA loader commit | After human/ops audit of inspect report |
| Forbidden | **pdfplumber**, ad-hoc spreadsheet guesses, chat-model invented dollars | Always |

### LlamaParse wiring checklist

- [ ] SM secret `/capiro/dev/llamaparse/api-key` readable by one-shot task role  
- [ ] Task env `LLAMA_CLOUD_API_KEY` injected (or compose from SM in one-shot)  
- [ ] Optional `LLAMA_CLOUD_BASE_URL` default `https://api.cloud.llamaindex.ai`  
- [ ] Idempotent parse jobs reused (no double-bill same SHA)  
- [ ] `--allow-vendor-parse` required for extract-only / commit that calls vendor  
- [ ] Cost log per job (pages, mode, job id) stored with artifact metadata  

---

## 3. What already auto-runs vs what enrichment must finish

### 3.1 Already auto (must remain healthy)

| Capability | Mechanism | Enrichment duty |
|---|---|---|
| Bill / action / text ingest | `sync-congress` (+ related) schedules | **Do not touch** schedule/commands except monitoring |
| **PE lines from congressional activity (linkage)** | `extract-bill-pe-codes` daily ~09:00 UTC | Verify green; fix if PE codes miss; never disable |
| PE change derive / alert plumbing | `pe-derive-chain`, `send-pe-alert-emails` (last success 2026-07-31) | Keep email dark; derive dry-run after dollar waves |
| LegiWatch product surface | Existing API/web | Out of enrichment scope |

**Answer locked in plan:** Yes — PE lines continue to auto-update from congressional activity **via bill↔PE extraction and LegiWatch**. That is linkage/activity, not automatic rewrite of every PE-year dollar from floor votes.

### 3.2 Partial today — must complete for “funding after conferences”

| Capability | Today | Target |
|---|---|---|
| Detect new budget / committee / conference docs | `watch-budget-docs` exists (dry-run default; commit records + optional email) | **Scheduled** detect on sole-live; detections durable |
| NDAA (auth) conference dollars | Loader `parse-ndaa-conference`; baseline `ndaaConference` = 1562 | Current-cycle complete + auto path: detect → LlamaParse → inspect → commit |
| Approps conference dollars | Field `conference` baseline **0** | Load path + artifacts for current cycle; same auto chain |
| Enacted public law | Loader exists; baseline enacted = 2831 | Keep current cycle current after conf/enact windows |
| Committee marks | HASC/SASC strong; HAC-D thin; SAC-D ≈ empty (5) | Fill SAC-D / HAC-D gaps via LlamaParse + loaders |
| End-to-end unattended “PDF live → dollars live” | **Not certified** | Optional later: auto **extract-only** on detect; **commit still gated** unless Neo opens full auto |

**Answer locked in plan:** We are **architecturally set up** for post-conference funding updates, but **not fully auto-complete** until watch is scheduled, LlamaParse extract is standard, and conference loaders are proven on current-cycle artifacts (especially approps `conference`).

### 3.3 Baseline gaps driving priority (2026-08-01 diag)

| Signal | Value | Plan response |
|---|---|---|
| PE-year rows | 10,312 | Grow quality, not noise |
| request / enacted | 8307 / 2831 | Protect; fill attribution |
| HASC / SASC | ~3960 each | Maintain; refresh current FY |
| HAC-D / SAC-D | 1319 / **5** | Wave marks |
| conference / ndaaConference | **0** / 1562 | Conference workstream |
| Trust ok | **false** | Hygiene workstream first |
| null source_document obs | 24,878 | Hygiene |
| duplicate obs groups | 22,677 | Hygiene |
| open reconciliation | 1,131 stale | Hygiene / triage |
| P-doc / OP-5 detail | 314 / 278 of 2395 PEs | Wave procurement/O&M |
| SAM opportunities sync | error (HTML) | Separate ticket; non-blocking for PE dollars |

---

## 4. Workstreams (complete program)

### WS-A — Observation & trust hygiene (prerequisite)

**Goal:** Reduce trust blockers so new commits do not amplify garbage.

| ID | Task | Exit |
|---|---|---|
| A1 | Snapshot + classify null `source_document_id` observations (legacy vs loader class) | Report counts by source/field |
| A2 | Duplicate observation groups: dedupe strategy (keep earliest with SHA / merge keys) | Written procedure + dry-run counts |
| A3 | Run / extend `backfill-pe-observation-keys` inspect then gated commit | Keys populated; no dollar mutation surprise |
| A4 | Stale reconciliation triage: auto-close safe / queue real conflicts | openCount trending down; SLO defined |
| A5 | SourceDocument archive metadata backfill where missing (109/110 lacking immutable archive fields) | Heads have archive refs or explicit waiver |
| A6 | Re-run `diag-pe-trust`; track blockers week over week | Trend dashboard in enrichment log |

**Gate:** No mass PE-year re-commit until A1–A3 plan accepted by Neo (A4–A6 can parallel carefully).

---

### WS-B — LlamaParse platform readiness

| ID | Task | Exit |
|---|---|---|
| B1 | Confirm task role can `GetSecretValue` on `/capiro/dev/llamaparse/api-key` | One-shot proof (no key printed) |
| B2 | Standard one-shot recipe: env inject + `ingest-defense-budget --extract-only --allow-vendor-parse --mode pdf_premium` | Runbook section |
| B3 | Artifact layout: S3 archive + local/JSON derived rows + sha256 manifest | Path convention documented |
| B4 | Cost/idempotency: reuse succeeded parse jobs; log pages/mode/jobId | No double-bill same SHA in test |
| B5 | **Remove pdfplumber from operator runbooks** for PE money; mark legacy JSON-only loaders as “consume prior artifact only” | This plan + baseline updated |
| B6 | Unit audit: `audit-llamaparse-pe-units` SELECT-only after first LlamaParse promotes | Report clean or listed fixes |

---

### WS-C — LegiWatch & PE↔legislation continuity (always on)

| ID | Task | Exit |
|---|---|---|
| C1 | Inventory EventBridge rules: `sync-congress*`, `extract-bill-pe-codes`, related | List enabled + last SyncRun |
| C2 | After each PE dollar wave: spot-check bill↔PE links still updating (sample bills) | No regression |
| C3 | If `extract-bill-pe-codes` fails: fix **without** changing PE writer ownership rules | Green SyncRun |
| C4 | Document boundary: legislation auto ≠ PE-year dollar auto | In this plan §3 (done) |
| C5 | Do not run PE enrichment jobs that take exclusive locks starving congress sync windows | Schedule map |

---

### WS-D — Bill activity → PE line auto-update (linkage)

| ID | Task | Exit |
|---|---|---|
| D1 | Confirm daily `ExtractBillPeCodes` firing on sole-live | CloudWatch / SyncRun |
| D2 | Coverage sample: top watched PEs have recent bill links where text mentions PE codes | Query + UI |
| D3 | Full-text vs title-only mode flags understood (`--no-full-text` etc.) | Runbook |
| D4 | Optional: PE Watch “legislative activity” panel QA after waves | Checklist |

**Success criterion:** Operators can answer “yes, PE lines still auto-update from congressional activity” with SyncRun proof + sample links.

---

### WS-E — Conference & marks funding auto-update (complete the money loop)

| ID | Task | Exit |
|---|---|---|
| E1 | Schedule or out-of-band cron **`watch-budget-docs`** (baseline commit once, then regular `--commit`; email optional/dark) | Detections accruing |
| E2 | Map detection → loader hint (NDAA conf / HAC-D / SAC-D / HASC / SASC / R-1 / public law) | Routing table |
| E3 | On new **NDAA conference** PDF: LlamaParse extract-only → `parse-ndaa-conference` inspect → exact-SHA commit → `ndaaConference` | Current-cycle conf PE years move |
| E4 | On new **approps conference / JES**: LlamaParse → appropriate loader → **`conference` field** (today 0) | Non-zero honest coverage or documented absence of source |
| E5 | On new **public law / enacted**: `parse-defense-approps-public-law` path | enacted current-cycle |
| E6 | Committee marks refresh: HASC/SASC maintain; **HAC-D/SAC-D** priority fill | sacDMark >> 5 |
| E7 | Post-load: `run-pe-derive-chain` dry-run; open commit only if Neo authorizes | Derive report |
| E8 | Optional Phase 2: auto-queue extract-only on detection (still SHA-gate commit) | Design + flag |
| E9 | Follow `docs/runbooks/fy26-defense-appropriations-conference-enacted-ingest.md` patterns; generalize to current FY | Runbook updated for FY27+ |

**Success criterion:** “When a new conference report drops, we detect it and can promote PE funding within one ops cycle without manual archaeology.” Full unattended commit only if Neo later opens E8+auto-commit.

---

### WS-F — Core RDT&E dollars (Wave 1 product fill)

Prefer **LlamaParse new extracts** of official R-1/R-2 PDFs; promote via exact-SHA loaders (or package load). Do not regenerate with pdfplumber.

| ID | Task | Exit |
|---|---|---|
| F1 | Inventory official FY26/FY27 R-1/R-2 URLs (comptroller) | URL + expected exhibit list |
| F2 | LlamaParse extract-only per PDF (`pdf_premium`) | Artifacts + sha256 |
| F3 | Inspect reports (row counts, PE hit rate, unit sanity, unparsed pages) | Go/no-go |
| F4 | Exact-SHA commit R-1 then R-2 (one SHA each); **replay** same SHA → zero new canonical rows | Metrics |
| F5 | R-3 performers as evidence-class (not fake PE dollars) | Linkage stats |
| F6 | UI spot-check marquee PEs (trust header, zeros, failed≠empty) | Checklist |

---

### WS-G — Procurement / O&M / package depth (Wave 2)

| ID | Task | Exit |
|---|---|---|
| G1 | P-doc / P-40 LlamaParse + `parse-pdoc` / enrichment loaders for priority PEs | pDocDetail count ↑ |
| G2 | O-1 / OP-5 where fixtures/PDFs exist | op5Detail ↑ |
| G3 | `load-defense-budget-package` for reviewed package JSON only when package is human-gated | Package verify green |
| G4 | FYDP outyears labeled projection, never current ask | Read-path checks |

---

### WS-H — Secondary context (non-canonical careful)

| ID | Task | Exit |
|---|---|---|
| H1 | SAM opportunities fix (HTML error) — separate; PE context only | SyncRun green or ticket |
| H2 | SAM personnel / awards PE-tag — no lobby POC as target | Policy held |
| H3 | USAspending / TAS enrichment where supported | Coverage report |

---

### WS-I — Human accuracy & product honesty

| ID | Task | Exit |
|---|---|---|
| I1 | Marquee PE list (Neo): 10–25 PEs for goldens | List file |
| I2 | Human-reviewed golden sample (small) — never mix with synthetic | Golden set |
| I3 | Coverage matrix UI/API honesty for unsupported families | Spot-check |
| I4 | Data-issue workflow smoke on live | File + resolve without bad mutation |

---

### WS-J — Optional platform polish

| ID | Task | Exit |
|---|---|---|
| J1 | Rebuild **workspace** image on main SHA so generation uses shared PE grounding | Only if Neo wants WS generation parity |
| J2 | Fix GHA `api-image`/`web-image` `startup_failure` so main push builds ECR again | CI green |
| J3 | Entrypoint: add explicit `inspect-comptroller-jbooks` / `inspect-jbook-r2` verbs (no forced commit) | Safer ops |

---

## 5. Phased timeline (executable)

### Phase 0 — Plan lock (this document)
- [x] Baseline diag captured  
- [x] LlamaParse-first policy  
- [x] LegiWatch / bill-PE / conference answers encoded  
- [ ] Neo ACK of plan + marquee PE list  

### Phase 1 — Hygiene + LlamaParse ready (WS-A, WS-B, WS-C)
1. A1–A3 design + dry-runs  
2. B1–B4 secret + one-shot extract pilot (1 short PDF)  
3. C1 schedule inventory; confirm extract-bill-pe-codes green  

**Exit:** Pilot LlamaParse extract-only succeeded; hygiene procedure approved; legislation still auto.

### Phase 2 — Auto rails for docs + legislation proof (WS-D, WS-E1–E2)
1. D1–D2 bill↔PE proof  
2. E1 schedule watch-budget-docs  
3. E2 routing table  

**Exit:** Written proof: “congressional activity still auto-links PEs”; “new docs are detected.”

### Phase 3 — Current-cycle dollars (WS-F + WS-E3–E6)
1. F1–F6 R-1/R-2 LlamaParse → commit → replay  
2. Marks HAC-D/SAC-D + NDAA conf refresh  
3. Approps conference path to populate `conference` when sources exist  
4. Derive dry-run  

**Exit:** Current-cycle request/marks/conf/enacted improved; conference path exercised once end-to-end.

### Phase 4 — Depth (WS-G, WS-H)
P-doc/O&M/packages + secondary context.

### Phase 5 — Accuracy & sustain (WS-I, WS-E7–E8, WS-J)
Goldens, optional auto extract-only queue, workspace/CI polish.

---

## 6. Coverage bar (no marquee subset)

**Neo (2026-08-01):** no marquee list — **all PE lines must come out correct** for sources we load.

Success is measured by **full-corpus SLOs**, not a demo subset:

| SLO | Intent |
|---|---|
| R-1 PE codes → `program_element` | Every valid R-1 PE in current PB present |
| Current-FY request | Present where R-1/R-2 prints a value (zeros kept) |
| Marks / conf / enacted | Present when official source exists; else honest gap |
| Provenance | Every promoted dollar has source doc + page/artifact SHA |
| Replay | Same approved SHA → zero new canonical rows |

Optional internal smoke list may be used by ops for UI clicks; it is **not** a scope limit.

---

## 7. Standard operating procedures (SOP)

### 7.1 LlamaParse extract-only (new PDF)

```text
1. Obtain official PDF URL or S3 path
2. ECS one-shot (api image on main), env LLAMA_CLOUD_API_KEY from SM
3. ingest-defense-budget --path <pdf> --extract-only --allow-vendor-parse --mode pdf_premium [--fy YYYY]
4. Record: source URL, sha256, parse job id, page count, artifact paths
5. Do NOT --commit until audit
```

### 7.2 Exact-SHA promote (family loader)

```text
1. tsx scripts/<loader>.ts --artifact <rows.json>          # inspect (NOT entrypoint forced-commit verbs)
2. Review inspect JSON: rows, quarantines, units, PE codes
3. tsx scripts/<loader>.ts --artifact <rows.json> --commit --approved-sha256 <sha>
4. Immediate replay same command → expect 0 new canonical rows / id-set equal
5. diag-pe-trust slice + UI marquee check
6. run-pe-derive-chain dry-run
```

### 7.3 Conference drop (ops cycle)

```text
1. watch-budget-docs detection (or manual official URL)
2. LlamaParse extract-only (§7.1)
3. Route:
   - NDAA conf → parse-ndaa-conference
   - Approps conf → approps conference / JES loader path
   - Public law → parse-defense-approps-public-law
4. Promote §7.2
5. Confirm field: ndaaConference vs conference (correct track)
6. Derive dry-run; PE Watch sample
```

### 7.4 Do not

- Use pdfplumber for new money extracts  
- Use entrypoint `sync-comptroller-jbooks` / `sync-jbook-r2` when you meant inspect  
- Pause `sync-congress` or `extract-bill-pe-codes` for PE work  
- Commit without approved SHA  
- Label LlamaParse output as human-reviewed  
- Open PE alert emails without Neo  

---

## 8. Scheduling map (target)

| Job | Intent | Target cadence | Notes |
|---|---|---|---|
| sync-congress* | Legislation | Existing | **Keep** |
| extract-bill-pe-codes | Bill↔PE | Daily (existing ~09:00 UTC) | **Keep + monitor** |
| watch-budget-docs | Detect budget/mark/conf PDFs | Daily or 2× daily | Enable if not live |
| LlamaParse extract queue | Optional auto extract-only | On detection | Phase 5; commit still gated |
| parse-* / jbook commits | Dollars | Ops-triggered or gated cron | Exact-SHA |
| run-pe-derive-chain | Derived PE state | After commits / existing | Prefer dry-run unless authorized |
| send-pe-alert-emails | Notify | Dark default | Neo only |
| diag-pe-trust | Trust baseline | Weekly + after waves | SELECT-only |

Confirm live EventBridge rules before assuming enabled (CDK matrix ≠ proof of rule in account).

---

## 9. Success metrics

| Metric | Baseline (2026-08-01) | Target (program complete) |
|---|---|---|
| Trust eval ok | false (3 blockers) | blockers reduced per A-SLO; no new blocker classes from our commits |
| sacDMark non-null | 5 | Meaningful current-cycle coverage or documented source absence |
| conference non-null | 0 | Populated when approps conf sources exist |
| ndaaConference | 1562 | Current-cycle complete for loaded PE set |
| Bill↔PE daily job | assumed on | Proven green SyncRuns |
| watch-budget-docs | unknown schedule | Proven detections |
| Conference E2E drill | not done | ≥1 full detect→LlamaParse→commit→UI |
| Marquee PE UI | untracked | 100% checklist pass after Wave 1 |
| pdfplumber in ops path | legacy refs | **Zero** for new extracts |
| LegiWatch paused | no | **Still no** |

---

## 10. Risk register

| Risk | Mitigation |
|---|---|
| LlamaParse cost / rate limits | extract-only idempotent; premium only on money pages; target_pages when possible |
| Entrypoint forced `--commit` | Custom inspect one-shots; later WS-J3 verbs |
| Hygiene debt amplified by commits | WS-A gate before mass promote |
| Conference auto over-writes wrong track | Auth vs approps field split + tests |
| GHA image build broken | Local/ECR push recipe (used for #705 ship) until J2 |
| SAM HTML errors | H1 separate; don’t block dollars |
| Quiet failure of extract-bill-pe-codes | C1/D1 monitoring |

---

## 11. Authorization matrix

| Action | Who |
|---|---|
| Inspect / extract-only / diag | Ops session OK |
| Exact-SHA PE dollar commit | Neo (or standing auth per wave) |
| Enable watch-budget-docs --commit email | Neo |
| derive-chain --commit / PE emails | Neo |
| Pause any LegiWatch job | **Forbidden** without explicit Neo + incident |
| Merge infra schedule via full CDK Compute | Careful (taskdef drift); prefer out-of-band Events when possible |
| Human golden sign-off | Neo / designated reviewer |

---

## 12. Deliverables checklist (definition of complete)

- [ ] WS-A hygiene procedure executed; diag trend improved  
- [ ] LlamaParse-only extract path proven; pdfplumber not used for new PE money  
- [ ] LegiWatch still auto; `extract-bill-pe-codes` proven green  
- [ ] Documented + proven answer: PE lines auto-update from congressional **activity/links**  
- [ ] `watch-budget-docs` live; conference detect → LlamaParse → promote drill done  
- [ ] Approps `conference` path addressed (data or documented source gap)  
- [ ] Current-cycle R-1/R-2 + marks + NDAA conf improved under exact-SHA  
- [ ] Replay + UI marquee checks recorded  
- [ ] Enrichment log updated after each wave (`docs/program-elements/enrichment/log.md`)  
- [ ] Optional: auto extract-only queue design (commit still gated unless Neo opens full auto)  

---

## 13. Immediate next commands (when Neo says go)

1. **ACK this plan** + provide marquee PE list.  
2. Phase 1: hygiene classify (A1) + LlamaParse secret one-shot extract pilot (B1–B2) on **one** official PDF.  
3. Phase 2: prove `extract-bill-pe-codes` + enable `watch-budget-docs`.  
4. Phase 3: Wave 1 R-1/R-2 LlamaParse → inspect → commit → replay.  

---

## 14. Document control

| Version | Date | Notes |
|---|---|---|
| 1.0 | 2026-08-01 | Complete plan: LlamaParse-first, LegiWatch continuity, bill↔PE auto, conference funding auto path, hygiene, waves, SOPs |

**Related:**  
- `baseline-2026-08-01.md`  
- `diag-pe-trust-2026-08-01.json`  
- `docs/program-elements/source-coverage-matrix.md`  
- `docs/plans/2026-07-06-pe-watch-auto-update-plan.md`  
- `docs/runbooks/fy26-defense-appropriations-conference-enacted-ingest.md`  
- `packages/shared/src/pe-source-coverage.ts`  
- `apps/api/scripts/ingest-defense-budget-pdf.ts`  
- `infra/cdk/lib/ingestion-schedule.ts`  
