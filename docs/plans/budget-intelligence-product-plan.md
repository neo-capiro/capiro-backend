# Capiro Budget Intelligence — Production Final-State Product Plan

2026-07-02. Target: the **best customer experience buildable on the data we now hold**
(FY25–FY31 RDT&E + all-services procurement + O&M, FY26/27 committee marks, deltas,
P-40 enrichment, org graph, performers, awards, provisions, bills). Production
final-state — every feature ships complete with provenance, confidence, empty states,
exports, alerting, and tests. No MVP cuts.

---

## 0. Ground truth — what already exists (build on, don't rebuild)

**Data (loaded, verified in capiro-dev):** 952 RDT&E PEs (R-1 FY27, FY26/27
HASC/SASC/NDAA-conf/HAC-D marks) · 818 procurement lines all services (FY25–FY31
fyData, FY27 auth + HAC-D marks; FY26 marks 92%-of-$ keyed, load pending) ·
389 O&M lines (FY25 actual/FY26 enacted/FY27 request) · 12.8k deltas (12 delta
types incl. new_start/termination/zeroed/quantity/unit-cost) · P-40 enrichment
in flight (descriptions, ACAT, competition, phase, MDAP, related PEs, contractors,
milestones, risks) · org graph (offices/roles/programs) · 5,991 R-3 performers ·
10.1k awards w/ PE links · provisions · PE↔bill links · source-document registry.

**Backend already built:** program-element read service (years/deltas/provisions/
opportunities/contractors/bills/related), delta engine + materiality scorer,
client-PE relevance scoring w/ explanations, conference-probability model,
alert-memo + docgen (docx/xlsx/pptx), Meri PE tools (search/detail/timeline/
contractors/bills), embeddings, reconciliation, proof-pack, watch table,
tracker alert/digest infra (SES live).

**Web already built (RDT&E-first, pre-expansion):** ProgramElementWatchPage w/
FyHistoryChart, FyDetailDrawer, WhatChangedPanel, ProvisionsPanel, ContractorsPanel,
BillsTouchingPePanel, ProcurementActivityPanel, SecondaryDistributionPanel,
Programs/Projects/ProgramTeam/ClientRelevance/RelatedPes/ProofPack panels;
MarkupMonitorPage; ProgramElementFinderPage; ProgramMatchQueuePage +
PersonCandidatesPage (review queues). **Client profile has NO budget surface** —
the single biggest integration gap.

**Named gaps this plan closes:** cross-appropriation linkage in the UI; technology
taxonomy on budget lines; divergence/anomaly classification layers; client-profile
budget tab; productized memo; NL Q&A contract; portfolios/heatmaps; watch-alerts on
budget events; YoY; color-of-money; runway classification; graph view.

---

## 1. The core object model (foundation for every feature)

### 1.1 Unified Budget Line
One canonical object over the three keyspaces (`appropriationType` RDTE | PROC | OM):
`pe_code` (7-digit PE / BLIN / `<account><line>`), title, service, budget activity,
appropriation account, FY series (FY25 actual → FY31), marks (HASC/SASC/HAC-D/SAC-D/
conference/enacted), deltas, source documents, enrichment (`raw.pDocDetail`).
*Build:* a `BudgetLineView` read-model in program-element-read that normalizes the
three shapes; single API contract for all surfaces. Acceptance: any pe_code returns
an identical envelope regardless of appropriation; every dollar carries
`{value, unit:'millions', source, sourceDocumentId, observedAt}`.

### 1.2 Cross-appropriation links (the "↕" in Program 360)
Sources, in trust order: (a) P-40 `Other Related Program Elements` (batch-5,
deterministic, e.g. AMPV BLIN → 0605028A); (b) MDAP code shared across lines;
(c) pe_program_match accepted links through a Program entity; (d) alias/embedding
candidates (candidate-status only, badge "suggested"). O&M attachment: account→
service/BA affinity + title/program-alias match, candidate-gated.
*Build:* `budget_line_link` table (fromCode, toCode, linkType {related_pe, mdap,
program, om_support}, source, confidence, reviewStatus) + backfill job from
batch-5 output + review in ProgramMatchQueuePage (extend, don't fork).

### 1.3 Technology-area taxonomy (unlocks 7 features)
Curated taxonomy (~16 areas: autonomy/robotics, C-UAS, AI/ML, EW, space sensing,
hypersonics, missile defense, shipbuilding, munitions/industrial base, cyber,
tactical networks, uncrewed systems, contested logistics, assured PNT, directed
energy, ISR) with per-line tags.
*Build:* `budget_line_tech_tag` (peCode, tag, source {curated, embedding, enrichment},
confidence, reviewStatus). Bootstrap: embeddings over title+description+enrichment
summary → candidates; curated review pass for the top 500 lines by FY27 $;
deterministic keyword seeds for unambiguous terms. **No tag ships un-reviewed above
the fold** — un-reviewed tags render as "suggested" chips only.

---

## 2. Feature specifications (all 18, mapped to assets)

### F1. Program 360 (the core page) — EXTEND ProgramElementWatchPage
The existing page already renders FY history, marks, deltas, provisions, contractors,
bills, procurement activity, team, proof-pack. Production completion:
- Render all three appropriation types natively (OM/PROC lines currently second-class:
  hide RDT&E-only panels when N/A, add O-1/P-1 header block: account, SAG/BLI, BA title).
- New **Linked Lines rail**: RDT&E ↔ procurement ↔ O&M chain from §1.2 with link
  provenance badges; one-click pivot between linked lines.
- New **Enrichment block** (batch-5): description, ACAT, competition, acquisition
  phase, milestones, risks, named contractors — each with "from P-40, p.N" citation.
- **Source panel**: every number traceable to its sourceDocument (registry is stamped);
  FyDetailDrawer already shows per-field source/date — extend to marks + O&M.
- Confidence/match status chip on every derived element (link, tag, contractor).
- Acceptance: 0601102A (RDT&E), 1506N0147 (PROC w/ AP pair), 2020A010 (OM) all render
  complete, sourced, with working cross-links; page p95 < 800ms (read-model cached).

### F2. Budget Movement Tracker — ELEVATE MarkupMonitorPage
Request → HASC → SASC → HAC-D → conference waterfall per line; grid across lines.
Filters: service, appropriation type + account, BA, tech area (§1.3), committee,
add/cut/hold, |Δ| threshold, FY. Saved filter sets per user. Export CSV/XLSX
(docgen service exists). Waterfall visual per line; sparkline in grid rows.
Data is fully loaded (batches 1,4 + FY26 procurement marks). Acceptance: the query
"FY2027 Army autonomy/robotics/UAS/C-UAS lines with HASC/SASC disagreement" is a
two-filter interaction returning sourced rows.

### F3. Committee Divergence Finder — NEW classification on existing deltas
Delta engine already computes mark_vs_mark / conference_vs_marks. Build the
**posture classifier** (pure, spec'd): for each line+FY, classify
{restoration_opportunity, cut_risk, conference_target, appropriations_target,
aligned, no_action} from the mark vector, with the dollar evidence attached.
Surface: dedicated tab in Movement Tracker + Program 360 badge + feeds F13.
Acceptance: every FY27 line with ≥2 marks gets a posture; classifier has a golden
spec (≥30 real lines incl. 0605053A-style cases); posture changes emit
IntelligenceChange (infra exists).

### F4. Capability→Budget Recommender (the "wow") — EXTEND client-pe-relevance
Existing: client↔PE relevance scoring w/ explainable reasons + embeddings.
Production completion: (a) extend candidate universe from RDT&E-only to all three
keyspaces + tech tags; (b) scoring adds budget size, FYDP growth (F6 output),
committee adds (F3 output), maturity stage (F5 output), service fit; (c) output =
ranked primary RDT&E / procurement / O&M targets + committee posture + recommended
path (which account, which committee, why) + one-click memo (F10) + source package.
Input: client capabilities (exists) or free-text capability set. Every
recommendation carries its reason breakdown (the existing RelevanceEvidence pattern).
Acceptance: Overland-AI-style query returns 0605053A/4868W12002-class results with
scores decomposed, and the same API powers the client-profile Budget tab (F18).

### F5. RDT&E→Procurement Transition Map — NEW derivation, small UI
Maturity stage from data signals: BA1/2 early R&D · BA3/4 prototype · BA5 SDD ·
BA6-8 support/fielded · P-1 BLIN procurement · O&M sustainment. Stage chip on every
line; on Program 360 a pipeline visual across the §1.2 linked chain (Ground Robotics
PE → Robotics & Applique BLIN → OM sustainment). "Has buy line?" boolean filter
everywhere. Acceptance: chain renders for ≥50 curated flagship programs; stage
classifier spec'd; unlinked lines state honestly "no known procurement line".

### F6. Procurement Runway Analyzer — NEW derivation on loaded FYDP
FY25→FY31 series exists on all 818 procurement lines. Classifier (pure, spec'd):
{ramping, flat, declining, zeroed, new_start, one_year_plus_up, cliff} + CAGR +
peak-FY. Stored on the line (recomputed on load), filterable in F2, chip on F1.
Queries like "FY27 request >$100M and positive FYDP ramp" are filter combos.
Quantity + unit-cost columns where P-40 enrichment provides them (flagged sparse).
Acceptance: classification spec with real fixtures (COLUMBIA ramp, M10 Booker
termination, GMLRS flat); every class count reported in diag.

### F7. Congressional Add/Cut Heatmap — NEW visual on F2 data
Matrix: rows = service or tech area, columns = committee (HASC/SASC/HAC-D),
cell = net $ add/cut + count, drill-through to the F2 grid filtered. Powered by a
single aggregate endpoint over marks. Acceptance: sums tie to the loaded artifact
account totals (the tie-out data exists in the mark files).

### F8. Technology-Area Portfolios — NEW pages on §1.3
One page per tech area: FY27 request/HASC/SASC/HAC-D totals, top PEs/BLINs/O&M
lines, biggest adds/cuts, fastest-growing (F6), maturity mix (F5), movement feed.
Curated blurb per portfolio. Acceptance: portfolio totals = sum of reviewed-tag
lines only; "suggested" additions listed separately; CSV export.

### F9. Budget Anomaly Detector — EXTEND delta engine
Add rule set to the existing engine (which already flags new_start/termination/
zeroed): request drop >50% / jump >100%; HASC cut w/ SASC support (and each pairwise
divergence-with-support pattern); blank request w/ mark add; quantity w/o outyear
funding; large O&M w/o procurement link; large PROC w/o RDT&E parent (uses §1.2).
Each anomaly: human-readable sentence + evidence + materiality score, emitted through
the existing IntelligenceChange→alert path. Acceptance: rules spec'd on fixtures;
anomalies appear in watchlist alerts (F17) and Program 360.

### F10. Source-Backed Memo Generator — PRODUCTIZE the Overland flow
Alert-memo service + Memory-grounded memo→Documents pipeline already shipped
(intel actions, PR #183/185). Production completion: parameterized generator
(company, capability tags, target service, committee, state/district) × output type
(staff memo, client memo, approps ask, NDAA language concept, talking points,
one-pager) → docx via existing docgen, filed to client Documents. Every claim in the
memo carries a source reference (budget line + document + page) and a confidence
flag; a "sources" appendix is mandatory and auto-built. Acceptance: memo renders
with zero unsourced dollar claims; regeneration is idempotent per (client, subject).

### F11. "Ask Capiro" Budget Q&A — EXTEND Meri tools + answer contract
Meri already has the PE tools. Build the **answer contract**: every budget answer
returns {answer, table rows, source rows w/ sourceDocument refs, CSV download,
confidence}. Add tools: `query_budget_lines` (structured filter DSL the model fills:
service/approp/tech/mark comparisons/dollar thresholds) + `compare_marks`. Chat UI
renders the table + download chip (Meri chat already renders rich blocks).
Acceptance: the 6 example questions in the product brief return correct sourced
tables; every number in prose matches its table row.

### F12. Program Relationship Graph — NEW visual on existing graph data
Interactive graph: PE → projects → BLIN → O&M → marks → program → office (org graph,
batch-8) → people (person_role) → tech tags → client fit. Read-only viz over
budget_line_link + pe_program_match + program_office(+links) + person_role.
Acceptance: renders the AMPV neighborhood (BLIN, 0605028A, MDAP 471, PM office,
marks) with provenance on every edge; degrades gracefully where links are sparse.

### F13. Conference Strategy Dashboard — NEW on F3 output
For government-affairs users: all FY27 lines with open divergence, grouped by
recommended action {support Senate position, defend House add, seek restoration,
shift to approps, monitor, none} (F3 postures + conference-probability model which
already exists). Per-line "why" + dollar stakes + one-click memo (F10) + add to
watchlist (F17). Acceptance: action recommendations are deterministic from the
posture spec; the dashboard is empty-state-correct pre-conference and archives
post-enactment.

### F14. Color-of-Money Advisor — NEW small feature, big UX win
Rule table (prototype→RDT&E, buy→PROC, sustain/services→O&M, facility→MILCON
[flagged "data pending"], Guard/Reserve→P-1R) rendered as an interactive advisor:
input = what the client sells / needs; output = primary/secondary account paths WITH
real attached lines from F4's engine. Lives inside the client Budget tab + memo
generator. Acceptance: recommendations always attach ≥1 real line or say why not.

### F15. Market Maps by FY — NEW investor-grade view on F8
Per tech area: RDT&E + PROC + O&M totals, growth (F6), top programs, top adds/cuts,
maturity mix — presented as a branded, exportable one-pager (docgen pptx/pdf) and
a live page. Acceptance: numbers identical to F8 (single aggregate source); export
carries source-and-date footer.

### F16. Budget-to-District (phase-limited, honest) — PARTIAL now, full later
Now: state/delegation relevance via award place-of-performance (enrich-award-districts
exists) + org-graph office locations where known + committee membership (directory
exists). Output: "this line is relevant to {states} offices" with evidence chips.
Full district economics deferred until contractor/facility layer (flagged in-UI as
"coverage: partial"). Acceptance: no fabricated geography — only evidence-backed
states; coverage disclosure visible.

### F17. Watchlists + Budget Alerts — EXTEND ProgramElementWatch + tracker infra
Watchable: lines, programs, tech areas, committees, services, saved F2 filters.
Alert events: new mark, mark change, zeroed, new start, conference change, new
related line (§1.2), anomaly (F9), posture change (F3). Delivery: in-app feed +
existing SES email digests (daily/weekly rules already live) + per-watch immediate
option. Acceptance: end-to-end test — load a changed artifact in staging → alert
lands with correct diff + source; unsubscribe/digest preferences honored.

### F18. Client-Profile Budget Tab + YoY — CLOSE the integration gap
The gap found in the read-path investigation: client profiles have no budget surface.
Build the **Budget & Programs tab** on the client profile: relevance-ranked lines
(F4), watchlist section, movement summary (F2 filtered to relevant lines), posture
highlights (F3), memo shortcuts (F10), color-of-money advisor (F14).
Plus the **"What changed since last year"** view: FY26 enacted vs FY27 request,
FY26 conference vs FY27 HASC, request vs HAC-D — biggest increases/cuts/new starts/
terminations/title changes (pb_vs_prior_pb delta type exists).
Acceptance: a thin-signal client renders honest empty states with a "improve your
capability profile" CTA; a defense client (Aperture demo seed) renders all sections.

---

## 3. Cross-cutting production requirements (every feature)

1. **Provenance or it doesn't ship**: every dollar, tag, link, and recommendation
   renders its source (document + page where known) and observation date. The
   source-document registry + per-field year-source rows are already stamped —
   surfaces must consume them. No unsourced number anywhere in the product.
2. **Confidence + review state visible**: accepted vs candidate (suggested) is a
   first-class visual distinction everywhere (links, tags, people, programs).
3. **Honest coverage disclosure**: every aggregate view carries a coverage note
   (e.g. "FY2026 procurement marks: 92% of keyable dollars; classified excluded").
   Known gaps (AF ammo, SAC-D nonexistence, unpublished Navy BA6-8) are stated in-UI.
4. **Empty/edge states designed**, not defaulted: zero-mark lines, OM lines without
   FYDP, unlinked BLINs, thin-signal clients.
5. **Performance**: read-models/caches for Program 360 + tracker grid (p95 < 800ms);
   aggregates precomputed on load (they change only when artifacts load).
6. **Tenancy + compliance**: budget data is tenant-agnostic reference; client-fit
   layers are tenant-scoped (existing RLS pattern). People surfaces respect
   contactUse policy (no lobbying-contact display for procurement-sensitive roles);
   DoW-derived people data internal-seed only per license — official-source-verified
   before customer-facing display.
7. **Exports everywhere**: CSV for grids, docx/pptx for memos/market maps (docgen
   exists), all exports footered with source + generation date.
8. **Testing**: every classifier (posture, runway, anomaly, maturity, color-of-money)
   is a pure module with a golden-fixture spec (the org-gate pattern from batch-8);
   every new endpoint has controller specs; the five flagship pages get Playwright
   smoke flows; verification diags extended (diag-graph-coverage pattern).
9. **Docs**: every feature ships with a runbook section (data dependencies, refresh
   jobs, known limits) in docs/; user-facing "how numbers are sourced" page.

---

## 4. Build sequence (dependency-ordered, no phase ships partial)

**Stage A — Foundations (unblocks everything)**
A1 BudgetLineView unified read-model + API (§1.1) · A2 budget_line_link + batch-5
backfill + review queue extension (§1.2) · A3 tech taxonomy + bootstrap + curation
pass (§1.3) · A4 runway/maturity/posture/anomaly classifiers as spec'd pure modules
(F3/F5/F6/F9 logic). *Depends on: batch-5 enrichment loaded; batch-8 merged.*

**Stage B — Core surfaces**
B1 Program 360 completion (F1) · B2 Movement Tracker (F2) + Heatmap (F7) ·
B3 Divergence + Conference dashboard (F3+F13) · B4 Watchlists/alerts (F17).

**Stage C — Intelligence layer**
C1 Recommender (F4) + Color-of-money (F14) · C2 Portfolios (F8) + Market maps (F15) ·
C3 Transition map (F5 UI) + Runway views (F6 UI) + Anomalies surfaced (F9 UI).

**Stage D — Workflow + integration**
D1 Client Budget tab + YoY (F18) · D2 Memo generator productized (F10) ·
D3 Ask Capiro contract (F11) · D4 Relationship graph (F12) · D5 District-partial (F16).

Each stage: PR(s) → CI → deploy → staging verification with real data → prod.
Data prerequisites tracked alongside: batch-5 load, batch-6 Navy R-2, FY26 marks
load, MDAP map seed, org-graph import commit — all already in the pipeline.

**Explicitly deferred (per the brief, correct calls):** bulk P-40 page viewer,
manual PDF search, granular unit-cost analytics beyond what enrichment yields,
PMO-ownership inference beyond deterministic sources. **Next data layers** (post-
launch): contracts/awards depth (USAspending shard fix feeds vendor mapping),
report language (congressional intent search), MILCON, OP-5 narratives.

---

## 5. What makes this the best-in-class experience (the thesis)

The product's differentiation is not search — it is that every budget line becomes
a **navigable, sourced, classified object** connected to the money's full lifecycle
(R&D → buy → sustain), to Congress's posture on it, to the offices and people who
own it, and to the client's capabilities — with every claim carrying its source and
confidence. The moment a user can go: *capability → ranked lines → divergence
posture → recommended committee path → sourced memo → watchlist alert when it
moves* — inside one product — Capiro is not a database; it is the government-affairs
operating system for defense budgets.
