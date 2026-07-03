# Budget Lines — UI implementation plan (mockup → production)

**Status:** ACTIVE BUILD (started 2026-07-03)
**Companion to:** `defense-money-graph-consolidated-plan.md` (the strategy doc — object model §1, features §3, guardrails §4, deployment playbook §7, success criteria §8). This doc is the *execution* plan for the UI mockup Ninja delivered 2026-07-03 (`Capiro Budget Lines (standalone).html`).
**Mockup provenance:** decoded React source lives in the session scratchpad (`mockup_bundle_*.js`); the spec below is extracted from it, component by component.

---

## 0. What the mockup is

A full reframe of the `/program-elements` surface onto the money graph. Five modules
under an "Intelligence → Budget Lines" surface + a Budget Line 360 detail page:

| Module | Mockup file | Features |
|---|---|---|
| **Catalog** (index) | `04444542` | Capability search hero ("I sell X — where's the money?"), 3 KPIs + color-of-money card, mixed table across all line types w/ type facet strip, color-of-money grouping, sort, watch stars |
| **Capability finder** | `3d3cab13` | F4 recommender + F25 wedge chips + F8/F15 bubble market map; capability picker; per-cap color-of-money split |
| **Movement** | `57bb356d` | F2 action feed (add/cut/hold/transfer filters), F7 heatmap (color-of-money × stage), F9 anomaly list, F3/F13 conference-divergence dashboard |
| **Money graph** | `76759db7` | F12 all-lines graph (color-of-money columns), F23 stakeholder chain, F26 consolidation card, F24 valley-of-death watch |
| **Watchlist** | `f3a7bd61` | F17 evolved: signal feed over budget_actions on watched lines + watch cards w/ sparkline, maturity, approp, signal chip |
| **Budget Line 360** | `66f07c1b` + `924ec89a` + `db184993` | Dark banner (line-type glyph + chips: maturity, appropriability, realization, bills) + same-FY KPI tiles + 8 sub-tabs: Overview, Funding, Legislation, Relationships, Incumbents, People & office, Appropriability, Proof pack |

Chart primitives (`316f1b39`, `02257c8e`, `8eab8150`): MaturityLadder, ScoreDial,
FactorBars, Heatmap, StageFlow, MoneyTime, DivergenceRow, ColorMoneyBar, TierBadge,
ConfBadge, LineTypeBadge, GraphView, StakeChain, BubbleMap (+ Sparkline/LineChart/
DeltaBars/Donut/HBars we already have in `apps/web/src/pages/program-element/charts/`).

**Two cross-cutting rules baked into the mockup (verbatim):**
1. "win rate" is renamed → **funding realization rate** everywhere (already shipped in the pre-work PR).
2. **Same-FY pinning** — enacted vs request is only ever compared *within one FY*; KPI tiles carry FY tags; ladder views carry a "same-FY pinned" note.

**Honesty patterns the mockup itself models (these are requirements, not decoration):**
- Incumbent map: award-evidenced rows say "Incumbent"; R-2/R-3-cited say "Budget-justification performer"; low-confidence say "Candidate — needs review". A permanent honest-note banner states the rule.
- People rows carry tier (verified / third-party seed / inferred) + source + last-verified date + a perishability note; internal directory seeds carry a lock icon and are **never republished** (licensing guardrail §4).
- Empty states everywhere are informative ("Relationship enrichment is accumulating", "Full 9-factor breakdown unlocks once this line completes deep enrichment").
- Classified lines render `•••` and no figures. Zeroed lines say "zeroed", not "—".

---

## 1. Data reality check — mockup concept → what prod has today

| Mockup concept | Prod reality | Verdict |
|---|---|---|
| BudgetLine + `line_type` | `program_element` w/ `appropriationType` ∈ {RDTE, PROCUREMENT, OM} | **Derive** `lineType` (RDTE_PE / PROCUREMENT_BLIN / OM_BLI). MILCON/TRANSFER/CLASSIFIED = registry entries with 0 rows until ingested (catalog facet strip only shows types that exist) |
| `budget_action` (§1.2) | `program_element_year` marks (request/HASC/SASC/HAC-D/SAC-D/conference/enacted) + `ProgramElementDelta` | **Derive** deterministic actions: add/cut per stage (mark vs request), new_start (first-FY appearance), termination (request→null w/ prior funding). hold/transfer need report-language parsing → NOT in v1, schema supports them |
| `budget_line_relationship` (§1.3) | Seeds exist: `raw.pDocDetail.relatedPEs` (P-40), `PeProgramMatch`→same Program, MDAP bridge RDT&E↔procurement, O&M `raw.op5Detail` | **Derive** typed edges: `related_pe_exhibit`, `same_program`, `rdte_to_procurement`, `predecessor_successor` (consolidation heuristic). Every edge carries evidence text + confidence + status |
| Capability (§1.6) | Nothing | **New curated seed** (~10 defense tech areas w/ aliases) + deterministic keyword matcher over title/description → `capability_budget_line_match` w/ matchedOn evidence. Review-gated growth |
| Maturity 0–5 (F19) | `acquisition-maturity` classifier SHIPPED (intelligence engine) | **Extend** to the 0–5 ladder w/ per-rung evidence (BA code, procurement edge, O&M edge, award evidence) |
| Appropriability (F27) | Nothing composite; components exist (posture engine, maturity, funding trend, office links, incumbents) | **New engine** `appropriability.ts` — factor breakdown w/ per-factor evidence; factors we can't compute (district relevance) are omitted from the composite and listed as "not yet scored", never faked |
| Committee posture / conference (F3/F13) | `committee-posture` engine SHIPPED; marks in `program_element_year` | Conference dashboard = house vs senate marks per open FY. **Have** |
| Anomalies (F9) | `budget-anomaly` engine SHIPPED | **Have** — surface in Movement |
| Incumbents (F20) | `FederalAward.peCode` (+`peCodeSource`+`peCodeConfidence`) = award-evidenced; `ProgramElementPerformer` (R-3) = budget-justification performer | **Have both tiers** — merge endpoint w/ honest labels |
| Office/people (F21) | `ProgramOffice`, `PersonRole`, `AcquisitionPersonnel` + person-PE links (source, confidence, lastVerified) | **Have** — resolver endpoint w/ tier/source/last-verified; DoW-directory rows flagged internal-only (license) |
| Stakeholder chain (F23) | Partial (PM/office/contracting resolvable; operator/requirement-writer/staff not modeled) | Render chain w/ honest "unknown" states for missing roles |
| Money-time (F22) | Derivable: today=enacted+O&M, tomorrow=request, political=adds this cycle. Transition (SBIR/OTA/APFIT) not ingested | 3 real buckets + transition shown as "no transition vehicles linked" until data exists |
| Valley-of-death (F24) | Derivable rule over graph: RDT&E line w/ no procurement/O&M edge + no award | **Derive** flag in intelligence cache |
| Consolidation (F26) | Derivable: zeroed line + similar-title/same-service growing line (+ same office when known) | **Derive** as `predecessor_successor` candidate edges w/ signal list |
| Watch/watchlist (F17) | `ProgramElementWatch` + toggle SHIPPED | Evolve UI; signal feed joins watches × budget_actions |
| Proof pack (F28) | `ProgramElementSource` + docx machinery in apps/api (memo pipeline) | Panel v1 (sections + preview) + docx export verb reusing memo/docx pipeline |
| Bills w/ link-type chips | PE-bill links SHIPPED | Add link-type labeling where known |

**Non-negotiable:** no mockup number ships. Every figure renders from prod queries; every
empty state is the honest one. The mockup's fake rows (Trimble Federal, COL Downs, …) are
layout spec ONLY.

---

## 2. Schema (expand-only, §7.2 discipline)

One migration, four tables + one cache. No column drops/renames anywhere.

```prisma
model BudgetAction {          // §1.2 — one row per (line, fy, stage, action) derived event
  id           String   @id @default(uuid()) @db.Uuid
  peCode       String   @map("pe_code") @db.VarChar(16)      // FK program_element
  fy           Int
  stage        String   @db.VarChar(12)   // PB|HASC|SASC|HAC_D|SAC_D|CONF|ENACTED (REPROG/SUPP reserved)
  action       String   @db.VarChar(16)   // add|cut|new_start|termination (hold|transfer|rescission reserved)
  amount       Decimal? @db.Decimal(14,2) // $M signed; null for non-monetary
  baseline     String   @db.VarChar(12)   // what amount is measured against: request|prior_stage|prior_year
  note         String?  @db.Text          // human-readable "why" when derivable (e.g. "SASC +$42.0M over request")
  evidenceJson Json     @default("{}")    // {sourceField, requestValue, markValue, ...} — §1.4 provenance
  derivedBy    String   @db.VarChar(32)   // 'derive-budget-actions@v1'
  createdAt / updatedAt
  @@unique([peCode, fy, stage, action])
}

model BudgetLineRelationship { // §1.3 — typed evidence-bearing edges
  id           String  @id @default(uuid()) @db.Uuid
  fromPeCode   String  @map("from_pe_code") @db.VarChar(16)
  toPeCode     String  @map("to_pe_code") @db.VarChar(16)
  relType      String  @map("rel_type") @db.VarChar(40) // related_pe_exhibit|same_program|rdte_to_procurement|procurement_to_om|predecessor_successor|same_capability
  confidence   String  @db.VarChar(8)   // high|med|low
  status       String  @default("accepted") @db.VarChar(12) // accepted|candidate (candidates render dashed + labeled)
  evidence     String  @db.Text         // human-readable ("P-40 'Related PEs' lists 0604011A")
  evidenceJson Json    @default("{}")
  derivedBy    String  @db.VarChar(32)
  @@unique([fromPeCode, toPeCode, relType])
}

model Capability {            // §1.6 — curated demand-side object
  id / slug / name / aliases String[] / taxonomyPath / description / curated Boolean
}
model CapabilityBudgetLineMatch {
  capabilityId / peCode / confidence / matchedOn String  // 'title_keyword:PNT' | 'curated'
  status String @default("accepted")                     // curated seeds accepted; keyword matches reviewable
  @@unique([capabilityId, peCode])
}

model ProgramElementIntelligenceCache { // catalog-sortable engine outputs, refreshed by derive verb
  peCode String @id @db.VarChar(16)
  lineType String? / maturity Int? / maturityJson Json
  appropTier String? / appropScore Int? / appropJson Json  // factor breakdown w/ evidence
  signalType String? / signalTone String?                  // latest budget_action → catalog Signal chip
  valleyOfDeath Boolean @default(false) / postureJson Json / computedAt
}
```

Naming: keep `pe_code` as the join key everywhere (it already stores BLINs/BLIs —
"PE" is legacy naming for the universal key; renaming the column is Stage-0c contract
work per the consolidated plan, not this build).

## 3. Derivation verbs (apps/api/scripts, wired in entrypoint.sh)

| Verb | Reads | Writes | Logic |
|---|---|---|---|
| `derive-budget-actions` | program_element_year | budget_action | Per (pe, fy): each stage mark ≠ request → add/cut w/ delta; first FY w/ any value → new_start; funded prior FY + no current-cycle request → termination. Idempotent upsert on the natural key; `--commit` gate |
| `derive-relationships` | raw.pDocDetail.relatedPEs, PeProgramMatch, Program, titles | budget_line_relationship | related_pe_exhibit (P-40, high); same_program (accepted matches, high); rdte_to_procurement (same Program across approp types, high); predecessor_successor (termination + same service + title-token overlap ≥ threshold → **candidate**, never auto-accepted) |
| `seed-capabilities` | curated JSON artifact | capability, capability_budget_line_match | ~10 areas (PNT, C-UAS, autonomy/AI, EW, directed energy, hypersonics, space/SDA, JADC2, cyber, munitions) w/ alias lists; matcher = word-boundary keyword over title+description, matchedOn records the exact token |
| `derive-intelligence-cache` | everything above + engines | program_element_intelligence_cache | Runs maturity ladder, appropriability, posture, anomaly, valley-of-death per line; stamps computedAt |

DAG order: (existing loads) → derive-budget-actions → derive-relationships →
seed-capabilities → derive-intelligence-cache. Weekly EventBridge candidates later (§7.5).

## 4. API (apps/api program-element module)

- `GET /program-elements/catalog` — extend existing finder: + lineType, com, maturity, appropTier/Score, signal, capability filter; sortable
- `GET /program-elements/:pe/actions` — budget actions, newest first
- `GET /program-elements/:pe/relationships` — edges + resolved endpoints
- `GET /program-elements/:pe/incumbents` — merge FederalAward (tier=incumbent, awards $, psc/naics where present) + ProgramElementPerformer (tier=performer) + low-confidence award candidates
- `GET /program-elements/:pe/office` — ProgramOffice/PersonRole resolver output w/ signals; people rows carry tier/source/lastVerified/internalOnly
- `GET /program-elements/movement` — feed + heatmap + conference divergence + anomalies (one aggregate endpoint)
- `GET /capabilities` / `GET /capabilities/:slug/recommendations` — recs ranked by appropScore, wedge derived from lineType
- `GET /program-elements/watchlist/signals` — watched lines × budget_actions
- intelligence endpoint: + appropriability + ladder + valleyOfDeath (extend existing)
- Existing endpoints (bills, deltas, projects, provisions, procurement-lines, sources, personnel, programs, relevance) unchanged — reused by the 360 tabs.

## 5. Frontend (apps/web, evolve — don't fork — the PE pages)

Route stays `/program-elements[/:peCode]`; nav label → **Budget Lines**.

- **Module tab bar** (Catalog | Capability finder | Movement | Money graph | Watchlist) on the index route; detail = own page as today
- **Catalog**: rebuild FinderCatalogTable per mockup (type facet strip, color-of-money grouping toggle, maturity pips, approp TierBadge, Signal chip, watch star); CapabilityHero above; summary strip w/ ColorMoneyBar
- **Budget Line 360**: evolve ProgramElementWatchPage — banner gains line-type glyph + chips row (Maturity x/5, Appropriability tier·score, Realization %, Bills n); KPI strip pinned same-FY w/ FY tags; tabs become Overview / Funding / Legislation / Relationships / Incumbents / People & office / Appropriability / Proof pack. Existing panels are redistributed (Contractors→Incumbents, Team→People & office, Evidence content→Proof pack + Relationships); DescriptionPanel (pre-work) stays top of Overview
- **New chart primitives** in `charts/`: MaturityLadder, ScoreDial, FactorBars, Heatmap, StageFlow, MoneyTime, DivergenceRow, ColorMoneyBar, GraphView, StakeChain, BubbleMap, TierBadge/ConfBadge/LineTypeBadge (all hand-rolled SVG per mockup, design-token driven)
- Theme: reuse existing `--accent`/pe-* token system; add mockup's line-type/color-of-money palette as CSS vars

## 6. Build phases (each = PR → CI → merge → deploy → browser-verify)

| Phase | Scope | Ships |
|---|---|---|
| **BL-0** | Migration (5 tables) + 4 derive verbs + entrypoint wiring + engine: appropriability + maturity-ladder extension + unit tests (golden fixtures per engine discipline) | API image; run verbs on prod (dry→inspect→commit); diag counts |
| **BL-1** | Catalog API extensions + catalog UI (facets, grouping, chips, hero) + capability endpoints + Capability finder view | Web+API; verify: filter every line type, capability rec flow |
| **BL-2** | Budget Line 360: 8-tab reorganization, banner/chips/KPI same-FY, Relationships panel (radial graph + ladder + consolidation/VoD cards), Incumbents, People & office, Appropriability, Proof pack panel | Web+API; verify on 0603004A-class, a BLIN, an O&M BLI, an empty line |
| **BL-3** | Movement view + Watchlist evolution + Money graph view | Web+API; verify feeds/heatmap/conference against known marks |
| **BL-4** | Proof-pack docx export verb + polish + a11y/empty-state sweep + §8 success-criteria audit | Full |

Risks & mitigations: image tsc is stricter (noUncheckedIndexedAccess) → build API image
mentally against guarded accessors; concurrent-session UI drift → rebase before each PR;
derive verbs touch prod data → dry-run + sample inspection before --commit, additive only.

## 7. Success criteria (this build)

1. Every module renders **real data only**; zero mockup constants in shipped code.
2. Catalog: all three live line types filterable; counts match `SELECT count(*) GROUP BY appropriation_type`.
3. A line with marks shows the same numbers on Catalog row, 360 KPIs, StageFlow, and Movement feed (single source: program_element_year → budget_action).
4. Incumbents tab on an award-linked line shows tiered labels w/ evidence; zero "incumbent" labels without award evidence.
5. People tab never renders a DoW-directory-only row to a customer-visible export (license guardrail); every person row shows source + last-verified.
6. Appropriability shows factor breakdown w/ per-factor evidence; un-scorable factors listed as such.
7. "Win rate" appears nowhere in the UI.
8. Same-FY pinning: no KPI or delta compares across FYs anywhere.
9. All existing PE-page tests pass + new engine golden fixtures + panel render tests.
10. Live browser verification on app.capiro.ai for each phase before it's called done.
