# Capiro — Defense Money Graph: Consolidated Future-State Plan (v2)

2026-07-03. Supersedes and merges [program-people-data-completion.md](program-people-data-completion.md)
(the data plan) and [budget-intelligence-product-plan.md](budget-intelligence-product-plan.md)
(the 18-feature product plan), and folds in the external architecture review
("you are building a defense money graph"). Nothing meaningful from the two prior
plans is dropped — their phases/features are carried here with current status and
re-parented onto the corrected object model.

**The one foundational change** (from the review): the universal object is a
**BudgetLine**, not a Program Element. A PE is the right anchor for RDT&E only;
procurement is appropriation + BLIN, O&M is appropriation + SAG/BLI, and there are
MILCON, revolving-fund, transfer, and classified lines that don't fit PE semantics
at all. We keep the `/program-elements` surface and the `pe_code` key (they ship
today), but internally the spine becomes a BudgetLine with PE as one **subtype**,
and we build a **relationship + capability + normalized-action + universal-provenance
graph** around it. That single reframe is what lets the platform scale cleanly across
the whole budget stack and become a government-affairs *intelligence* product rather
than a budget database.

---

## 0. Current state — what is already TRUE (do not rebuild)

Shipped + verified on prod (capiro-dev) as of 2026-07-03:

**Data spine** — 2,380 budget lines: ~952 RDT&E PEs (R-1 FY27) · 818 all-services
procurement BLINs (`<appropriation><lineItem>`) · 389 O&M lines (`<account><line>`);
FY25→FY31 series; FY26+FY27 HASC/SASC/NDAA-conf/HAC-D marks; 15k+ deltas (12 types);
**appropriation_type + service now 100% populated** (J/K/V/R/O/X→DW backfill).
Narratives on 1,169 lines (Navy/Army/AF/SF/DW R-2 + DW agency books). Deep P-40
enrichment on **802 procurement lines** (qty, unit cost, MDAP, related PEs) + a
**double-validated LLM layer** (strategy/office/contractors/milestones/risks; 0
invented survivors) in `raw.pDocDetail`.

**Program/people/contract graph** — 92 Programs + **147 deterministic `mdap_curated`
pe_program_match rows** (accepted) + 259 fuzzy candidates in the review queue;
1,298 program_offices (hierarchy) + 3,364 accepted person_roles + 102 program-owner
person links; `federal_award` **169,596 rows** (USAspending 10k-ceiling broken via
adaptive windowing) with award→PE enrichment accumulating (top-dollar first).

**Intelligence engines (live, pure, golden-fixture-spec'd)** — committee-posture,
procurement-runway, acquisition-maturity, budget-anomaly.

**Product surface (live)** — Program 360 (`ProgramElementWatchPage`) with FY history,
marks, deltas, provisions, bills, procurement activity, proof-pack; **intelligence
chips** (posture/runway/maturity/anomaly) + **P-40 exhibit detail panel** in the hero;
**Programs panel** populated from the MDAP bridge; MarkupMonitor; Finder (7-service
filter fixed); review-queue pages. Provenance/confidence/empty-states enforced.

**Known honest gaps** (unchanged, carried forward): OP-5 O&M narratives (deferred data
layer — the biggest "looks blank" cause), award→PE enrichment is an asymptotic
accumulation job, ~150 RDT&E lines without FY27 narratives (unpublished Navy BA6-8 +
transitioned lines like F-15 EPAWSS), FY2026 procurement marks last ~8% (needs PB26
books), AF Ammunition book, review-queue human capacity, licensing limits on DoW
Directory people data.

---

## 1. The object model (the reframe) — Stage 0

### 1.1 BudgetLine as the universal spine
Adopt the **BudgetLine** concept with an explicit `line_type` discriminator that is a
**superset** of today's `appropriation_type`:

```
line_type: RDTE_PE | PROCUREMENT_BLIN | OM_BLI | MILCON_PROJECT
         | REVOLVING_FUND | TRANSFER | CLASSIFIED
```

Fields: `service, appropriation, account_code, budget_activity, code, title,
canonical_title, fiscal_year_first_seen, fiscal_year_last_seen, status,
source_confidence`. The `code` is one identifier among several (peCode, BLIN, SAG/BLI)
— **not** the universal join key.

**Migration strategy (non-breaking — this is the key point):** the current
`program_element` table is *already* a de-facto BudgetLine (single table, all three
appropriations, discriminated by `appropriation_type`). So:
- **Now (cheap):** add `line_type` (backfill from appropriation_type + code shape:
  MILCON/transfer/classified/revolving detectable from account + title), and ship the
  `BudgetLineView` read-model (already planned as §1.1 of the product plan) so every
  surface speaks BudgetLine. The `/program-elements` route and `pe_code` stay.
- **Later (dedicated migration, gated):** physically rename `program_element` →
  `budget_line` and split subtype detail into `program_element` / `procurement_line`
  / `om_line` / `milcon_project` tables keyed on `budget_line_id`. Do this only once
  the graph tables below are in place and the read-model has fully abstracted callers,
  so the rename is a swap, not a rewrite.

### 1.2 `budget_action` — normalized committee/appropriations actions
Today marks live as columns on `program_element_year` (great for UI speed; keep as a
**materialized summary**). Add the canonical event table:

```
budget_action(budget_line_id, fy, chamber, committee, bill_id, stage, amount,
  quantity, delta_vs_request, action_type, explanation, source_page, source_text)
  stage: PB | HASC | SASC | HACD | SACD | CONF | ENACTED | SUPPLEMENTAL | REPROGRAMMING
  action_type: add | cut | hold | transfer | rescission | new_start | termination
```

Why: unlocks supplementals, CR anomalies, reprogrammings, and *multiple bills in one
FY* — none of which the fixed-column model can hold. `program_element_year` becomes a
projection of this. Migrate existing marks in as `budget_action` rows (source-stamped).

### 1.3 `budget_line_relationship` — the graph (supersedes product-plan §1.2)
The product plan's `budget_line_link` is generalized into typed, evidence-bearing
edges (relationships are frequently many-to-many and not parent/child — a BLIN can
relate to several RDT&E PEs; an O&M line sustains a portfolio):

```
budget_line_relationship(from_budget_line_id, to_budget_line_id, relationship_type,
  confidence, evidence, source, review_status)
  relationship_type: rdte_to_procurement | procurement_to_om | predecessor_successor
    | transfer_candidate | same_platform | same_program | same_office
    | same_capability | derived_from_report_language
```

Seeded from: P-40 `Other Related Program Elements` (deterministic), shared MDAP code,
`pe_program_match`, title/alias, and (candidate-only) embeddings. This is what turns
join-tables into a graph and powers the transition map, consolidation detector, and
relationship-graph view.

### 1.4 `source_assertion` — universal provenance (generalizes per-field source)
Make the existing `ProgramElementYearSourceValue` pattern universal across *every*
entity, especially people/offices/program-office mappings where truth is contested
and perishable:

```
source_assertion(entity_type, entity_id, field_name, asserted_value, normalized_value,
  source_id, page, snippet, extraction_method, confidence, is_current_winner,
  superseded_at)
```

One reconciliation model for budget values, program names, PM/office mappings, people.

### 1.5 `bill_budget_line_link` — replaces `congress_bill.pe_codes[]`
```
bill_budget_line_link(bill_id, budget_line_id, raw_code_mentioned, link_type,
  confidence, source_page, source_text, extractor_version)
  link_type: explicit_code | title_match | provision_context | table_row | inferred
```
Bills/reports refer to programs by title/platform/office/committee language far more
than by exact PE code; the array can't carry that ambiguity or its evidence.

### 1.6 `Capability` — the first-class demand object (new spine for F4/F8/F14/wedge)
```
capability(id, name, aliases, description, taxonomy_path, keywords, embedding)
capability_budget_line_match(capability_id, budget_line_id, match_type, score,
  evidence, review_status)   match_type: keyword | semantic | source_explicit | human_curated
```
This subsumes the product plan's §1.3 tech-taxonomy (tech areas become the top level
of `taxonomy_path`) and unlocks the core user workflow **"I sell GPS-denied autonomy —
where is the money?"** without the user knowing a single PE code.

---

## 2. Data completion — carried from the data plan (status-updated)

| Phase | Was | Now |
|---|---|---|
| 0 Feeders + denominators | running | ✅ done (all batches + diag) |
| 1 Programs master (1.1–1.6) | planned | ✅ done: master-list export, provenance stamping, MDAP map (147), Programs entities + matches. **Open:** FY26 marks last 8%, AF ammo (Ninja downloads) |
| 2 People (2.1–2.6) | planned | ✅ core done (supersede/repair/candidates, owner links, licensing gate). **Open:** roster expansion beyond Army (2.4), top-15 official verification (2.5) |
| 3 Org graph | needs schema | ✅ done (tables existed; 1,298 offices imported) — now re-homed under `source_assertion` (§1.4) |
| 4 Contracts/awards | next | ⚠️ shard fix done (169k); enrich-award-pe **accumulating** — schedule on EventBridge; relabel R-3 as "budget-justification performer" |
| 5 Continuous verification | planned | ⚠️ diag exists; **schedule** it + export-master-lists recurring |

**New data layers added by the review (prioritized):**
1. **OP-5 narratives** (O&M descriptions) — closes the largest "blank profile" set (389 O&M lines). *Next data batch.*
2. **Contracts as candidate relationships**, not raw awards: `award → company → contracting_office → acq_program_code → budget_line candidate → confidence → evidence`, with review tools (feeds the incumbent map).
3. **MILCON + transfer/revolving-fund lines** (now expressible via `line_type`).
4. Report/bill language ingest → `bill_budget_line_link` + `derived_from_report_language` edges.

---

## 3. Feature roadmap — prior F1–F18 + review's new features, with status

### Shipped / in place
- **F1 Program 360** (→ Budget Line 360) — ✅ chips + P-40 panel + Programs live; **extend** to render MILCON/transfer types and the Linked-Lines rail (needs §1.3).
- **F3 Committee Divergence** + **F6 Runway** + **F5 Maturity** + **F9 Anomaly** — ✅ engines live; UIs pending (Stage C).

### Prior product-plan features (re-parented onto the model)
- **F2 Movement Tracker** + **F7 Heatmap** — over `budget_action` (§1.2), filter by capability (§1.6).
- **F4 Capability→Budget Recommender** — now driven by `capability_budget_line_match`; the "wow."
- **F8 Portfolios** / **F15 Market Maps** — aggregates over capability + line_type.
- **F10 Memo generator**, **F11 Ask Capiro**, **F12 Relationship Graph** (now over `budget_line_relationship`), **F13 Conference Dashboard**, **F14 Color-of-Money**, **F16 Budget-to-District**, **F17 Watchlists/Alerts**, **F18 Client Budget Tab + YoY** — as specified in the product plan.

### NEW features from the review (highest-differentiation)
- **F19 Transition-maturity score (0–5):** research → prototype → dev → procurement line
  exists → O&M sustainment → contracts. Computed from `budget_line_relationship` +
  line_type coverage. Answers "science project or real buy line?"
- **F20 Incumbent map (performer→award→budget triangulation):** confidence-tiered
  (high = same normalized company + same acq/PE code + service + FY window + PSC/NAICS +
  office). R-3 = "budget-justification performer"; "incumbent" only with award evidence.
- **F21 Program-office resolver (probabilistic):** fuses R-2 narrative, P-40/O&M titles,
  PEO/CPE directory, SAM contracting office, award office, R-3 performers → likely owner
  / PM / contracting office + confidence + evidence. Never binary.
- **F22 Money-time view:** for a program/capability — *today's money* (enacted/O&M/
  procurement/active contracts) vs *tomorrow's money* (FYDP/PB outyears/RDT&E/adds) vs
  *political money* (marks/report language/member interest) vs *transition money*
  (SBIR/OTA/APFIT/DIU/RDER).
- **F23 Stakeholder-chain ("internal insurgent") map:** operator → requirement writer →
  lab → PM/CPE/PEO → contracting → congressional staff → appropriations line; surfaces
  gaps ("operator pull but no budget owner", "RDT&E but no procurement transition",
  "a mark but no contracting path").
- **F24 Valley-of-death detector:** SBIR-II + RDT&E PE present, but no BLIN / no O&M /
  no award / no committee support → flag + suggested bridges (APFIT, DIU, OTA, Phase III,
  RDT&E eval language, procurement plus-up, O&M pilot).
- **F25 Budget-wedge finder:** best entry wedge per company (RDT&E-eval / procurement-
  transition / O&M-services / report-language / OTA-SBIR-DIU / urgent-operational-need).
- **F26 Consolidation/transfer detector:** zeroed line + new similar-title line +
  transfer language + PE-title change + account move (would have caught TUGV/Ground-
  Robotics-style restructuring) — over year-over-year + `predecessor_successor` edges.
- **F27 Appropriability score (the moat):** capability fit × budget fit × color-of-money
  fit × committee posture × maturity × office clarity × incumbent friction × district
  relevance × evidence strength → High/Medium/Low + reason ("wrong color of money",
  "too early for procurement", "needs O&M path", "needs validated requirement").
- **F28 Proof-pack export** (one-click client-ready work product: budget table + marks +
  source pages + related programs + performers + contracts + people/offices +
  recommended message) — productizes the existing proof-pack.

---

## 4. Cross-cutting requirements + guardrails

Carry all 9 cross-cutting rules from the product plan (provenance-or-it-doesn't-ship,
visible confidence/review-state, honest coverage disclosure, designed empty states,
performance caches, tenancy/compliance, exports everywhere, golden-fixture tests,
docs). **Plus the review's cautions, now binding:**

1. **Rename "win rate"** on the line page → *Funding realization rate* / *Congressional
   support score* (a sales-sounding metric on a budget line misleads).
2. **Same-FY pinning** for enacted vs request stays enforced (never FY27-req vs FY26-enacted unlabeled).
3. **Performer labeling:** `ProgramElementPerformer` renders as *"budget-justification
   performer"* — "incumbent" only with award evidence (F20).
4. **People data is perishable:** every person/office row shows `last_verified`, source,
   confidence, and tier (officially-verified / third-party-seed / inferred). DoW
   Directory = internal seed only; **no republication** of rosters — verify against
   official public pages before customer-facing display.
5. **Design for ambiguity everywhere** (the review's praise of nullable peCode +
   confidence): candidate vs accepted is first-class; nothing fuzzy auto-accepts.

---

## 5. Build sequence (revised, honest about what's shipped)

- **Stage 0 — Model reframe (new, foundational):** add `line_type` + BudgetLineView
  read-model (non-breaking); stand up `budget_action`, `budget_line_relationship`,
  `source_assertion`, `bill_budget_line_link`, `capability` + matches. Migrate existing
  marks/links/tech-tags onto them. *No user-facing change; unblocks everything.*
- **Stage A — Foundations:** ✅ classifiers done. Remaining: tech-taxonomy folded into
  `capability`; backfill `budget_line_relationship` from batch-5 + MDAP.
- **Stage B — Core surfaces:** ✅ B-1 (Program 360 chips + P-40). Next: **F2 Movement
  Tracker + F13 Conference Dashboard** (highest immediate GA value, engines already
  live), then F7 heatmap, F17 watch-alerts.
- **Stage C — Intelligence layer:** F4 recommender + F27 appropriability + F14 color-of-
  money (all on `capability`); F8/F15 portfolios/market-maps; F5/F6/F19 transition +
  runway UIs; F9 anomaly surfacing.
- **Stage D — Graph & workflow:** F20 incumbent map, F21 office resolver, F22 money-time,
  F23 stakeholder chain, F24 valley-of-death, F25 wedge finder, F26 consolidation
  detector, F28 proof-pack; F10 memo, F11 Ask-Capiro, F12 relationship graph, F18 client
  Budget tab, F16 district.

Data prerequisites run alongside: OP-5 ingest, award-relationship enrichment (scheduled),
MILCON/transfer lines, report-language ingest. Every change: PR → CI → deploy → ECS
one-off / staging verify → prod, with the browser-verify discipline that has already
caught real bugs (pDocDetail shape, service filter, empty Programs panel).

---

## 6. Thesis — from budget database to defense money graph

The prior model was `PE → money → marks → people → contractors`. The consolidated model
is the full ecosystem the review names:

```
Capability → mission need → requirement owner → RDT&E money → procurement money
→ O&M money → program office → contracting path → incumbent ecosystem
→ congressional posture → next action
```

Every budget line becomes a navigable, sourced, classified node in that graph; every
edge carries its evidence and confidence; and the user's question is no longer "what is
this PE?" but **"I have this capability — where is the money, who owns it, what's the
posture, and what's my next move?"** That is the government-affairs operating system for
defense budgets, and the BudgetLine + Capability + relationship graph is the structure
that makes it hold together across RDT&E, procurement, O&M, MILCON, contracts,
organizations, and companies.

---

## 7. Deployment playbook — how every increment ships without surprises

Everything below is codified from what actually worked (and what actually broke)
across batches 1–10 and PRs #181–#214. Not aspirational — operational.

### 7.1 The pipeline (invariant for every change)

```
branch off origin/main → PR → CI verify (jest + typecheck)
  → squash-merge → api-image / web-image build (arm64 :latest)
  → confirm :latest sha == merged sha           ← never skip; see 7.3(b)
  → roll service(s) (force-new-deployment → wait services-stable)
  → one-off ECS loads (dry-run → INSPECT → --commit)
  → verify: loader JSON (0 quarantined / counts) + diag verb + LIVE BROWSER CHECK
```

Rules that have each independently caught a real production bug:
1. **Dry-run → inspect → commit for every prod write.** The org-import dry-run
   sample caught junk the frequency-sorted eval missed — twice. Chained scripts may
   run DRY+COMMIT together only with an in-chain abort gate (grep the dry output
   for a sentinel before committing).
2. **Browser verification is part of "done."** The pDocDetail shape bug survived
   TWO green loads ("802 updated, 0 skipped") and was only caught by opening the
   page. Ship criterion: the feature/data is seen rendering on app.capiro.ai, or
   the API response is inspected via the authenticated session — never loader exit
   codes alone.
3. **Idempotence is a requirement, not a virtue.** Every loader merges by source
   priority / upserts on natural keys; re-running any load must change nothing.
   New loaders prove it by running twice in staging (second run: 0 changed).
4. **Presence-based raw merges.** load-pdoc-enrichment's wholesale
   `raw.pDocDetail = pe.pDocDetail ?? null` nulls the key when an artifact omits
   it. Any loader touching `raw.*` sub-objects must only write keys PRESENT in the
   artifact item (fix this in the loader before batch-10's op5Detail lands).

### 7.2 Stage 0 migration logic (expand-contract; zero downtime)

The BudgetLine reframe ships in three strictly-ordered, individually-shippable steps:

- **Step 0a — Expand (additive only):** migration adds `line_type` column + the
  five new tables (`budget_action`, `budget_line_relationship`, `source_assertion`,
  `bill_budget_line_link`, `capability` + match). No reads change. Backfill verbs
  (all dry-run-default): `backfill-line-type` (from appropriation_type + code
  shape), `migrate-marks-to-actions` (year columns → budget_action rows,
  source-stamped), `backfill-relationships` (P-40 relatedPEs + MDAP +
  pe_program_match → edges). Rollback = simply do not read the new tables; they
  are inert.
- **Step 0b — Read-model cutover:** BudgetLineView serves every surface from the
  new shape; program_element_year mark columns become a projection the view still
  reads (dual-source with a per-line equality check in the diag: view value ==
  column value for 100% of lines before any consumer switches). The
  /program-elements API contract does not change.
- **Step 0c — Contract (gated, later):** physical rename program_element →
  budget_line + subtype tables. Only after 0b has run in prod ≥2 weeks with the
  equality diag green. This is the ONLY step needing a maintenance window, and it
  is optional until then.

Prisma migration rules (from the migration-drift experience): never `migrate dev`
against the shared dev DB; validate every migration on a fresh scratch DB first;
the deploy task runs `prisma migrate deploy` via the migrate entrypoint (which
auto-resolves prior failed migration rows).

### 7.3 Known deployment gotchas (each has bitten us; check every time)

a. **Image tsc is stricter than PR verify** (noUncheckedIndexedAccess): raw array
   indexing passes CI and fails the Docker build (#195). Run strict single-file
   tsc locally on new pure modules before pushing.
b. **api-image sometimes does not trigger on merge** (#193) and workflow_dispatch
   403s on the current PAT. If no run appears for the merged sha within ~2 min,
   re-fire with a real commit (barrel/comment) — never assume :latest updated.
   ALWAYS compare `aws ecr describe-images ... imageTag=latest` sha to the merge.
c. **Git Bash mangles leading-slash args** (`/capiro/dev/api` becomes a Windows
   path): export MSYS_NO_PATHCONV=1 in every shell that calls awscli.
d. **Worktrees have no node_modules**: typecheck via the main clone's tsc/tsx;
   jest discovers 0 tests in worktrees — CI is the authoritative test gate.
e. **ECS one-off tasks**: cluster capiro-dev, task-def capiro-dev-api-sync,
   container api, the three private subnets + sg from the runbook; logs in
   /capiro/dev/api stream api/api/<taskId>. `aws ecs wait` gives up at ~10 min —
   exitCode=None means "still running"; check describe-tasks before assuming
   failure.
f. **EventBridge rules are NOT in CDK** (tracker-alerts precedent): any schedule
   added out-of-band must be documented here and must survive `cdk deploy`.
g. **Source routes by publisher**: comptroller.war.gov serves direct;
   asafm = Wayback under "Discretionary Budget/…"; secnav = LIVE with a browser
   UA under /fmc/fmb/Documents/27pres/; saffm/afpims block non-browser clients
   and Wayback rarely captures their PDFs — AF books may require a real-browser
   download.
h. **Two clones / worktree confusion**: verify `git branch --show-current` +
   `git status` before committing; stash-pop can resurrect other sessions' parked
   work (4 parked stashes exist — do not drop them).

### 7.4 Load-ordering DAG (data dependencies)

```
budget lines (R-1 / P-1 / O-1 loads)
  → marks (committee loaders; field-merge protects line metadata)
    → compute-budget-deltas
  → enrichment (load-pdoc-enrichment / sync-jbook-r2 / load-om-op5)
    → seed-acq-program-map → seed-programs        (Programs panel)
    → backfill-relationships                       (graph edges)
  → sync-federal-award (windowed) → enrich-award-pe (scheduled, accumulating)
personnel imports → reconcile-personnel-supersede → repair-person-pe-links
  → generate-pe-person-candidates → import-dow-orgs (roles / owners)
any load → diag-graph-coverage (before/after numbers go in the PR description)
```

Rules: marks NEVER load before their budget lines exist (quarantine floods);
enrichment loaders never create lines; deltas recompute after any dollar change;
rebuild-pe-years / normalize-pe-units only with explicit intent.

### 7.5 Scheduled jobs to stand up (accumulation + verification)

| Job | Cadence | Why |
|---|---|---|
| enrich-award-pe --limit 5000 | daily | asymptotic award→PE linking (top-dollar first) |
| sync-federal-award --days 7 | daily (exists) | award freshness |
| diag-graph-coverage snapshot → artifact | weekly | drift detection; alert on coverage drops |
| export-master-lists | weekly | master CSVs never go stale again |
| top-office re-verify (data plan 2.5) | quarterly | people-data perishability |

### 7.6 Release gates per stage

- **Stage 0**: equality diag green (view == columns) + zero consumer regressions
  (Playwright smoke on the five flagship pages) before 0c is even scheduled.
- **Stages B–D features**: each feature merges dark or additive; a feature is
  "released" only after its §8 criteria pass on prod data and the browser
  walkthrough is attached to the PR. No feature flips on with unmet
  empty-state/provenance rules.

---

## 8. Success criteria — measurable, per layer

### 8.1 Data completeness (prod, via diag-graph-coverage; current → target)

| Metric | Current (2026-07-03) | Target |
|---|---|---|
| Budget lines typed (line_type + service) | 100% | stay 100% (CI diag guard) |
| RDT&E lines with narrative | ~88% (1,169) | ≥95% of lines with a published book; 100% of the remainder carrying an in-UI "unpublished / transitioned" reason |
| Procurement lines with P-40 detail | 802/818 (98%) | ≥98%; the 9 unmatched codes documented |
| O&M lines with OP-5 narrative | 0 → batch-10 in flight | ≥85% of lines whose account has a published OP-5; AF rides follow-up; structural non-narrative lines (classified, R&D/PROC-in-DHP) flagged, not counted |
| FY26+27 marks coverage | 92% of keyable $ (FY26 proc) | ≥95% when PB26 books land; classified always excluded + disclosed |
| budget_action rows == year-column projection | n/a | 100% equality before the Stage-0b cutover |
| Relationship edges (deterministic tiers) | 147 MDAP; relatedPEs backfill pending | every P-40 relatedPE + MDAP pair edge-ified; 0 fuzzy edges auto-accepted |
| Capability matches reviewed (top 500 lines by FY27 $) | 0 | 100% of the top-500 carry ≥1 reviewed capability tag |
| Award→PE links | 85+ (accumulating) | +≥500/week while the scheduled job runs; weekly coverage report |
| Person roles / owner links | 3,364 / 102 | Navy/AF/SF PEO rosters added; top-15 offices last_verified_at < 90 days |

### 8.2 Engine quality (pure classifiers; golden-fixture gates in CI)

- Posture / runway / maturity / anomaly: 100% of golden fixtures pass (49 today);
  any vocabulary change requires a fixture change in the same PR.
- New engines (transition-maturity F19, appropriability F27, office-resolver F21):
  ship with ≥20 real-line fixtures each; F21 additionally reports calibration —
  of matches scored ≥0.7, ≥80% confirmed correct on a 50-sample human audit.
- Zero-invention rule for LLM layers: extraction validators (verbatim-substring)
  report 0 invented survivors on every run — a nonzero count blocks the load.

### 8.3 Product experience (verified in the browser on prod, per release)

- **Line 360**: for the canonical trio (0601102A RDT&E / 1506N0145 PROC /
  2020A010 OM) — every panel either renders sourced data or an honest empty state
  with a reason; intelligence chips present wherever ≥2 marks exist; p95 < 800ms.
- **No unsourced number anywhere**: spot-audit 20 random lines per release —
  every dollar, tag, and link traces to a source document + date in ≤2 clicks.
- **The thesis flow works end-to-end**: capability search → ranked lines →
  posture → recommended committee path → sourced memo → watchlist alert, without
  the user typing a PE code. (Stage C/D acceptance demo, run on the Aperture
  seed client.)
- **Coverage honesty**: every aggregate surface displays its coverage note; the
  known-gaps list in §0 is reflected in-UI wherever those lines appear.

### 8.4 Operational health

- Every prod load's PR description contains before/after diag numbers.
- The weekly diag snapshot shows no metric regressing >2% without a linked
  explanation.
- Review queues (person→PE, program-match) have an owner and a weekly triage
  cadence; queue age p50 < 14 days once staffed.
- Scheduled jobs (§7.5) alive: last-run < 2× cadence, alerting via the existing
  SNS/email path when stale.
- Rollback drill: Stage-0a tables can be ignored (inert) and any loader re-run is
  a no-op — demonstrated once in staging per new loader.
