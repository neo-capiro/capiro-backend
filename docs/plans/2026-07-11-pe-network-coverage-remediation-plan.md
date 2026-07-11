# Program Element network-coverage remediation — technical blueprint

**Status:** plan only, no code written. **Author context:** follows a live investigation of PE 0604256A/0604258A/1242C93000 (2026-07-10/11) and a code-grounded research pass across six subsystems (2026-07-11). Every claim below is cited to a file:line; nothing here is inferred without a citation. Where a fact could not be verified without new investigation, it is called out explicitly as an **open unknown**, not assumed.

**Scope:** why bills, committee-report provisions, USAspending awards, SAM.gov opportunities, contractor/performer tables, acquisition personnel, and budget-line relationships are structurally under-populated for large swaths of the Program Element catalog — and the sequenced, lowest-risk path to closing each gap. No tenant/RLS concerns apply anywhere in this plan: every table involved (`program_element*`, `federal_award`, `sam_opportunity*`, `acquisition_personnel`, `program_alias`, `budget_line_relationship`) is global reference data, confirmed by existing model comments throughout this subsystem.

---

## 0. Executive summary

Two failure classes explain almost everything found:

1. **A code-shape blind spot.** Three matchers (bills, provisions, award-description-regex) and a fourth just discovered in this pass (SAM opportunity text-scan) all recognize the RDT&E PE-code shape (`0604256A`) but not the procurement-BLIN shape (`1242C93000`). This is a same-day, low-risk fix already half-built (draft PR #391 covers 3 of the 4 files) and is the single highest-leverage item in this plan.
2. **A dead code path, not thin data.** The SAM opportunity matcher's second matching tier (alias + office/PSC corroboration) can **never fire in production** — the query that feeds it omits the two columns its own logic branches on, and those columns don't even exist on the model. This was diagnosed in the prior session as "thin alias coverage." It is not thin coverage; it is an inert code path. Fixing the query wiring (or accepting the tier as permanently retired) is a decision, not a data-entry task.

Everything else is either (a) already-built machinery that's simply under-used (the personnel review queue, the relationship-candidate rendering), (b) a bounded, precedented data-entry task (expanding the curated acquisition-program map from committed source documents that already exist), or (c) a genuinely new pipeline build with no shortcut (procurement performer-table extraction).

Recommended sequencing, in five waves, detailed below:

| Wave | Focus | Effort | Blast radius | Depends on |
|---|---|---|---|---|
| 0 | Finish the code-shape fix (bills/provisions/awards/**SAM**) + diag-pe fix | ~1 day (3 files already done) | Low — additive regex, filtered against known codes | none |
| 1 | Backfill re-runs to realize Wave 0 | ~1 day of run-time, ~0 dev | Low — all idempotent verbs | Wave 0 shipped |
| 2 | Expand curated acq-program↔PE map from P-40 exhibit headers | 3-5 days (research-heavy, mechanical) | Low — validated against known PEs, never invented | none (parallel to 0/1) |
| 3 | Decide + wire (or retire) the SAM alias tier; add relationship-candidate promotion flow; personnel queue bulk-action | 2-4 days, several independent decisions | Low-medium | Wave 2 partially (map expansion also grows alias coverage) |
| 4 | New procurement performer-extraction pipeline (P-5/P-40) | 1-2 weeks | Medium — new offline tool + new loader, but additive/idempotent by construction | none, but lowest ROI-per-day of anything here |

Waves 0-2 can run in parallel; Wave 3's sub-items are independent of each other; Wave 4 is a standalone initiative that should be explicitly greenlit, not started by default.

---

## 1. Cross-cutting findings ("other issues found along the way")

These reshape the plan and must be read before the per-item sections, because they change what "the fix" actually is for two of the seven original items.

### 1.1 The SAM opportunity matcher's alias tier is dead code, not "thin"

`sam-opportunity-matcher.ts` has three tiers (`matchOpportunity`, lines 163-242):

- **Tier 1** (`description_pe_code`): a verbatim PE-code-shaped string in the opportunity's title/description, checked against known PE codes → confidence 0.95, `accepted`.
- **Tier 2** (`program_alias`): a program alias matched by trigram similarity (≥0.45) against title/description text, **gated on "office or PSC agreement"** → confidence up to 0.88, `candidate`.
- **Tier 3** (`psc_naics_component`): PSC/NAICS present, no stronger tier fired → confidence 0.4, `quarantined`.

Tier 2's gate reads `AliasForMatch.officeHint`/`pscHints` (lines 81-84, 208-210) — but the query that builds the alias index, `sync-sam-opportunities.ts:255-257`, selects only `{programId, aliasNormalized, aliasType}`. It never selects `officeHint`/`pscHints`. **The `ProgramAlias` Prisma model has no such columns at all.** So in every live run, `officeAgrees` and `pscAgrees` are always `false`, the `if (!officeAgrees && !pscAgrees) continue` guard (line 210) always fires, and **Tier 2 has never produced a single match in this system's history.** Every existing `sam_opportunity_match` row was written by Tier 1 (verbatim code) or Tier 3 (quarantined PSC/NAICS-alone).

This means: "audit alias coverage" (the prior session's framing) is the wrong diagnostic question. The right question is a design decision — see §4.2.

### 1.2 Aliases are 100% derived from the curated acquisition-program map — there is no separate alias-curation surface

`seed-programs.ts`'s `collectAliases` (lines 241-267) generates every `program_alias` row from three sources: a program's canonical/MDAP name, its linked PEs' titles, and R-2A project titles — and "linked PEs" means rows in `program_element_acquisition_program`, the same 147-168-entry table that drives federal-award attribution. **There is no manual alias-add script, admin endpoint, or seed file independent of that map.** Consequence: expanding the acquisition-program map (§4.1) is not just an awards fix — it mechanically grows the alias universe Tier 1/3 of the SAM matcher can draw on, for free, as a side effect. These two originally-separate plan items are coupled; sequencing the map expansion first compounds into both.

### 1.3 PR #391 (already drafted, CI-green, held) fixed 3 of the 4 files that need the BLIN-shape fix — it missed the SAM matcher

`sam-opportunity-matcher.ts:56`'s `PE_IN_TEXT` regex is a fourth, previously-unaudited copy of the same PE-only text-scan pattern already fixed in `bill-pe-extractor.service.ts`, `provision-loader.ts` (via the shared extractor), and `award-pe-extractor.service.ts`. It was not touched by that PR. Folding this into Wave 0 costs one file edit and one new test case; skipping it leaves SAM Tier-1 blind to procurement BLINs exactly like the other three were.

### 1.4 The 454 relationship "consolidation candidates" are not a hidden backlog — they already render live, dashed, in the UI

`derive-relationships.ts` writes every candidate it finds directly into `budget_line_relationship` with `status: 'candidate'` (lines 206-218, 253-267) — nothing is discarded after the console summary. `MoneyGraphView.tsx`/`bl-charts.tsx`'s `GraphView` already renders `status:'candidate'` edges dashed (confirmed end-to-end wiring: `MoneyGraphView.tsx:79,117-118`; `bl-charts.tsx:284,286`). The prior session's "review the 454 candidates" framing implied an unreviewed queue analogous to the person-candidate table. **It is not that.** The actual gap is narrower and different in kind: **there is no promote-to-accepted action anywhere** for a relationship edge — no button, no verb, no API. A user can see a dashed line and never do anything about it. This is a smaller, differently-shaped gap than originally scoped (§4.3).

### 1.5 The person-candidate review flow is fully built — the real gap is bulk action, not existence

`PersonCandidatesPage.tsx` + its backend (`acquisition-personnel.controller.ts:151-165`, `acquisition-personnel-read.service.ts:689-897`) is a complete, role-gated (`capiro_admin`), transactional confirm/reject flow that already writes `pePrimary`, a citation row, and a `PersonRole` on confirm. The only real gaps: (a) strictly one-at-a-time — no bulk-resolve, and (b) zero test coverage for the page. "Work the queue" is an *operational* ask (an admin needs to click through ~454 rows), not an engineering one, unless bulk-action is explicitly wanted (§4.4).

### 1.6 `diag-pe.ts`'s "sources" field queries the wrong table, with a verified exact fix

`diag-pe.ts:91-93` counts `program_element_source` rows — an RDT&E-J-book-only provenance table (populated only by `sync-jbook-r2.ts`/`sync-jbook-performers.ts`/`sync-comptroller-jbooks.ts`, established in the prior session). It does not reflect provenance for procurement-loaded PEs at all, and it was never meant to be a general "does this PE have sourced data" signal. The correct signal already exists, unused by this diagnostic: `program_element_year_source_value`, whose `field_name` column distinguishes a coarse `'__row__'` whole-row blob (always written by the writer service, `program-element-writer.service.ts:611-638`) from genuine per-field rows (written by `reconciliation.service.ts:102-124`'s `reconcile()`, one row per real field name). The corrected query (§4.5) is fully specified and ready to apply.

### 1.7 A confirmed open unknown: does the raw USAspending payload even carry NAICS?

`FederalAward` has no `naics_code` column, and `sync-federal-award.ts`'s fetch/parse path never references NAICS anywhere. Before any "NAICS-based award-to-PE heuristic" is scoped as real engineering work, someone must confirm the USAspending search/award-detail API response actually includes a NAICS field on contract records (SAM.gov opportunities do carry NAICS per `SamOpportunity.naicsCode`; contract *awards* are a different API surface and this has NOT been checked). This plan explicitly does not assume it exists — see §4.1's decision gate.

---

## 2. Per-item technical detail

### 2.1 Bills / provisions / award-description / SAM-text matching (the code-shape fix)

**Current state (verified):**
- `bill-pe-extractor.service.ts`, `provision-loader.ts` (via the same shared regex), `award-pe-extractor.service.ts` — all fixed in draft PR #391 (CI green, not merged): each now alternates PE-shape | BLIN-shape and is filtered against the live `program_element` table, which carries both code types with no restriction. Renamed `extractPeCodes`→`extractProgramCodes` to match what it returns.
- `sam-opportunity-matcher.ts:56`'s `PE_IN_TEXT` — **not yet fixed.** Same defect, one more file.
- Safety property already established and re-verified during PR #391: every regex match is filtered against the full `program_element` table before it can create a link, so a BLIN-shaped false positive is dropped exactly as a PE-shaped false positive already was. No new false-positive risk from widening the regex.

**Remaining work for Wave 0:**
1. Apply the identical alternation fix to `sam-opportunity-matcher.ts:56`, mirroring the pattern already used in the other three files (alternate `[01]\d{6}[A-Z]` | `[0-9]{4}[A-Z]{1,2}[0-9A-Z]{2,14}`, word-bounded).
2. Add the equivalent BLIN regression tests to `sam-opportunity-matcher.spec.ts` (one BLIN-in-text case, one mixed PE+BLIN case) mirroring the test pattern already added to the other three specs in PR #391.
3. Fold into the existing PR #391, or ship as a fast-follow — both are low-risk; folding in avoids a second review cycle.

**Real-world yield, honestly scoped (unchanged from prior analysis, now confirmed against the SAM tier structure too):**
- **Bills + provisions: high yield.** Appropriations-bill funding tables and committee-report language cite procurement line items verbatim; this was structurally invisible before, now isn't.
- **Awards (description-regex tier): correct but low yield.** Documented in the code itself as "effectively never fires for USAspending" — most award descriptions don't embed a bare code of either shape. `sync-federal-award.ts:147` already calls the fixed resolver at ingestion, so future awards benefit automatically; only the one-time `enrich-award-pe --refresh` backfill is needed for existing rows, and its expected yield is near-zero.
- **SAM Tier 1 (verbatim code): correct, yield depends entirely on how often a SAM notice quotes a BLIN verbatim** — untested territory; the backfill run in Wave 1 will produce the actual number.

### 2.2 Curated acquisition-program → PE map expansion (feeds both awards AND SAM aliases — §1.2)

**Current state (verified):** 147-168 candidate pairs from two committed sources:
- `seed-acq-program-map.ts:40-88`'s hand-typed `CURATED` array — 38 entries, e.g. `{code:'198', name:'F-35', peCodes:[...]}`.
- `scripts/__data__/mdap_evidence_fy2027.json` — 108 entries, format `{acqProgramCode, peCode, title, book}`, each one **read directly off a P-40 exhibit's "Line Item MDAP/MAIS Code" header field** in the FY2027 justification books already committed to this repo (`seed-acq-program-map.ts:107-110`). This is document-stated fact, not inference.
- Every entry is validated against live `program_element` before insert; unknown PEs are skipped and reported (never invented). 21 of 168 candidate pairs are currently skipped this way in this deployment.

This means expanding the map is **not new engineering** — it's the same mechanical task already done for 168 pairs, applied to more P-40 exhibit headers. The `report-award-pe-coverage` diagnostic (already run this session) names the highest-value targets by real award-dollar volume: MDA Support (221 awards), UH-60M Black Hawk (45), DDG-51 (30), SBIRS High (11), Apache (11), CH-47F Block II (10), F/A-18E/F (9), MH-60R (9), F-15 (8), and more below that.

**Work for Wave 2:**
1. For each unmapped acquisition-program code above a chosen award-count threshold (recommend ≥5 awards, ~20 codes at that bar per the coverage report), locate the corresponding P-40 exhibit(s) in the relevant service's FY2027 (or latest available) justification book and read off the PE code(s) the MDAP/MAIS code line item maps to.
2. Append entries to `mdap_evidence_fy2027.json` in its existing format (or extend `CURATED` if the source is a well-known program rather than a specific exhibit citation) — no schema change, no new code path.
3. Re-run `seed-acq-program-map.ts --commit` (idempotent, unique on `(acqProgramCode, peCode)`).
4. Re-run `seed-programs.ts` so the newly-linked PEs' titles/project titles flow into `program_alias` (§1.2's coupling).
5. Re-run `enrich-award-pe --refresh` so previously-unresolved awards under the newly-mapped codes get attributed.

**Decision needed (Ninja):** how many codes to research before the first commit — this is bounded, billable research time, not open-ended engineering. Recommend scoping Wave 2 to the top 20-30 codes by award volume as a first pass, then deciding whether a second pass is worth it based on the coverage delta observed.

**Open unknown carried forward, not resolved here:** whether a NAICS/contracting-office fallback tier (the "multi-day, new capability" alternative originally proposed) is worth building AT ALL depends on §1.7 — confirm the USAspending payload carries NAICS before scoping this as real work. If it doesn't, the only path to closing the remaining award-attribution gap is more curated-map entries (this section) or accepting the ceiling.

### 2.3 Relationship-candidate promotion (corrected scope per §1.4)

**Current state (verified):** candidates already persist and already render dashed in the live UI. The gap is specifically: no accept/promote action exists anywhere for a `budget_line_relationship` row.

**Work for Wave 3 (if greenlit):**
1. Add a `status` transition endpoint (mirroring the existing `provision_pe_link`/`program_element_person_candidate` accept/reject pattern already proven twice in this codebase) — `candidate` → `accepted`, admin-gated, audit-logged.
2. Add the corresponding UI affordance on the dashed edge in `MoneyGraphView`/`bl-charts.tsx` (click → confirm/reject), following the exact interaction pattern already shipped for person-candidates.
3. No threshold tuning is required for this to ship — the 0.6 token-overlap threshold in `derive-relationships.ts:204` is an orthogonal, separate lever (see below) that changes *how many* candidates exist, not whether they're actionable.

**Separate, independent lever — threshold tuning:** loosening `predecessor_successor`'s 0.6 overlap threshold would surface more candidates but at declining precision (this is the documented reason the threshold is 0.6 in the first place — the `deadTokens.size < 2` guard already exists specifically to avoid generic false matches). **Recommend NOT touching this threshold until the promotion flow (item 1 above) exists** — otherwise loosening it just makes more inert dashed lines nobody can act on. Sequence: build promotion flow first, observe real accept/reject rates from actual review, then decide whether precision headroom exists to loosen the threshold.

### 2.4 Personnel candidate queue (corrected scope per §1.5)

**Current state (verified):** fully functional, role-gated, transactional. 603 confirmed (mostly via a separate `auto-confirm-pe-person-candidates.ts --min-score 0.8` batch job, not manual review), 454 open sub-threshold candidates awaiting the one-at-a-time `PersonCandidatesPage` review flow.

**Work for Wave 3 (two independent decisions):**
1. **Operational, zero engineering:** have an admin work through the existing queue. This alone moves the 6.9%-of-PEs personnel-coverage number without any code change.
2. **Optional engineering, if the queue is too large to review one-by-one in practice:** add bulk-approve for candidates above a chosen confidence floor (mirroring the existing `auto-confirm-pe-person-candidates.ts` script's own 0.8 threshold pattern, but as an in-UI reviewed action rather than an unattended batch job) — a `rowSelection` + bulk-resolve endpoint, small and additive to the existing controller.
3. **Not in scope for this plan:** re-running `generate-pe-person-candidates.ts` to find *more* candidates is a separate, orthogonal lever (it only scans people with `pePrimary IS NULL`, so it will find candidates as new personnel data lands, independent of anything here).

**Test-coverage gap:** `PersonCandidatesPage.tsx` has zero test coverage today. If bulk-action is built (2 above), tests should cover both the existing one-at-a-time flow and the new bulk path — this has been a live gap for a while and shouldn't ship more surface area on top of an untested page without closing it.

### 2.5 `diag-pe.ts` "sources" fix (fully specified, ready to apply)

**Exact current defect** (`diag-pe.ts:91-93`): counts `program_element_source`, an RDT&E-only table, mischaracterizing coverage for every procurement-loaded PE.

**Exact fix**, verified against the real schema and the real writer/reconciler split:

Replace the `sources` field's query with one against `program_element_year_source_value`, filtering out the coarse `'__row__'` whole-row blob and surfacing only genuine per-field provenance:

```
SELECT fy, field_name, source, is_winner,
       coalesce(value_text, value_decimal::text, value_jsonb::text) AS value,
       written_at
FROM program_element_year_source_value
WHERE upper(pe_code) = <PE>
  AND field_name <> '__row__'
ORDER BY fy, field_name, written_at DESC
```

This is a pure read-only diagnostic change, no risk, no migration, no deploy dependency on anything else in this plan. Recommend shipping it in Wave 0 alongside the regex fix, since both are already-open, low-risk, same-day items.

### 2.6 Procurement performer-table pipeline (net-new build, unchanged scope, now with an exact template)

**Current state (verified):** the RDT&E performer pipeline (`sync-jbook-performers.ts`) is a **pure offline-artifact loader** — zero runtime PDF parsing, zero network calls. It consumes a committed JSON artifact (`PerformerArtifact`, shape: `{docType, exhibitType, fy, sourceUrl, ..., performers: PerformerRow[]}`) produced entirely offline by a Python tool (`scripts/__tools__/extract_jbook_performers.py`, pdfplumber word-coordinate column slicing) and a batch driver (`run_perf_batch.py`). The loader validates every `peCode` against `program_element`, derives `isNamedCompany`/`tableType` via regex heuristics, upserts on a natural-key composite, and registers a fingerprinted `SourceDocument`. Dry-run by default; the ECS-dispatched verb always appends `--commit`.

**Confirmed: nothing procurement-side exists at this level of rigor.** The only procurement-adjacent artifact is an **LLM-extracted, unstructured JSON blob** (`load-pdoc-enrichment.ts`) merged into `program_element.raw.pDocDetail` — not a page-cited, natural-keyed, deterministic table like `program_element_performer`. Building the real thing requires two new components, directly modeled on the RDT&E pair above:

1. **New offline extraction tool** (Python, pdfplumber or equivalent), targeting the P-5/P-40 procurement cost-exhibit table layout specifically — this is genuinely new work; P-5/P-40 tables are laid out differently from R-2/R-3 tables and a fresh column-slicing/heading-detection pass is required. This is the actual "1-2 week" cost center; everything downstream of it is a template copy.
2. **New loader script** (`sync-pdoc-performers.ts` or similar), structurally a near-copy of `sync-jbook-performers.ts`: same natural-key upsert into the same `program_element_performer` table (no schema change needed — the model is already appropriation-type-agnostic), same `SourceDocument` registration, same dry-run/`--commit` convention, same `program_element` validation gate.

**Decision needed (Ninja):** this is the one item in this plan that is a genuine multi-week net-new build with no shortcut. It should be explicitly greenlit as its own initiative rather than started as a byproduct of this remediation pass — recommend treating Waves 0-3 as this plan's actual deliverable, and scoping Wave 4 separately once its ROI can be weighed against whatever else is competing for that time.

---

## 3. Delivery sequencing, dependencies, and rollback posture

### Wave 0 — code-shape fix completion (≈1 day; 3/4 files already done in draft PR #391)
- **Add:** `sam-opportunity-matcher.ts` regex fix + tests (§2.1); `diag-pe.ts` sources-field fix (§2.5) — fold into the same PR, both are read/match-only, zero migration.
- **Verify:** typecheck clean; new BLIN test cases pass; existing test suites unaffected (confirmed pattern from PR #391's own verification — false-positive risk is structurally bounded by the existing filter-against-known-codes step in every affected file).
- **Deploy:** standard `deploy-dev.sh` (migrate is a no-op — no schema change in this wave — then roll api only; no web changes).
- **Rollback:** trivial — revert the merge commit; no data was written by this wave, only code paths widened.

### Wave 1 — backfill re-runs to realize Wave 0 (≈1 day of run-time)
Run, in this order (each already idempotent/dry-run-safe per existing script conventions):
1. `extract-bill-pe-codes` — documented safe-to-re-run.
2. `sync-report-provisions --commit` (dry-run default, so `--commit` required).
3. `enrich-award-pe --refresh` — low expected yield, run anyway for completeness.
4. Re-run the SAM sync's matching pass against existing `sam_opportunity` rows (or wait for the next scheduled daily sync to pick it up naturally, since Tier 1 fires at ingestion time — confirm which is faster/preferred before executing).
- **Verify:** before/after counts on `bill_budget_line_link`, `provision_pe_link`, `federal_award.pe_code IS NOT NULL`, `sam_opportunity_match` — the exact deltas ARE the yield measurement for this whole wave; report them.
- **Rollback:** every one of these writes is additive/idempotent; a bad run can be re-run safely, and none of them touch `program_element_year` or trigger delta/alert emission (the lesson from this session's earlier NDAA-conference work about natural-key stability and alert-storm risk does not apply here — none of these tables feed `program_element_delta`).

### Wave 2 — acquisition-program map expansion (≈3-5 days, parallel to Waves 0/1)
- Sequenced as in §2.2: research → append to `mdap_evidence_fy2027.json` / `CURATED` → `seed-acq-program-map.ts --commit` → `seed-programs.ts` (regrows aliases) → `enrich-award-pe --refresh`.
- **Decision gate before starting:** confirm scope (top-N codes by award volume — recommend 20-30 as a first pass, per §2.2).
- **Verify:** award-attribution rate (currently 0.13%) and `program_alias` row count, before/after.
- **Rollback:** every write here is a validated, natural-keyed upsert against known PEs; trivial to leave in place even if a later entry turns out wrong (it will simply have zero matching awards, not corrupt anything).

### Wave 3 — three independent decisions (≈2-4 days total, can run fully in parallel with each other)
1. **SAM Tier 2 (§1.1, §4.2 below):** decide and either wire or formally retire.
2. **Relationship-candidate promotion flow (§2.3):** build the accept/reject endpoint + UI affordance.
3. **Personnel queue bulk-action (§2.4):** build if the 454-row one-by-one flow is judged impractical; otherwise, just work the queue operationally.
- Each is independently shippable and independently rollback-safe (each is additive UI/API surface on existing, already-correct tables).

### Wave 4 — procurement performer pipeline (≈1-2 weeks, standalone initiative)
- As scoped in §2.5. Should be explicitly greenlit, not folded into this remediation pass by default, given its cost relative to everything else here.

---

## 4. Explicit decisions needed from Ninja before work starts

**4.1 — Acquisition-program map expansion scope.** How many unmapped acq-program codes to research in the first pass (recommend top 20-30 by award volume from the existing coverage report)? Confirm before Wave 2 starts, since this is bounded research time, not open-ended.

**4.2 — SAM Tier 2's fate.** Three real options, not a foregone conclusion:
  - (a) **Wire it properly** — add `officeHint`/`pscHints` columns to `ProgramAlias`, populate them (from what source? this needs its own small design — office/PSC hints would have to come from somewhere, likely derived from the acquisition-program map's associated contracting offices, which itself needs verification that such data exists per-program), and fix the query to select them.
  - (b) **Retire it** — remove the dead branch entirely, simplify the matcher to 2 tiers, and stop implying alias-based matching is active when it isn't.
  - (c) **Leave as-is, documented** — accept it as a known-dormant tier, correct the code comments so a future engineer doesn't waste time debugging "why doesn't this ever match," and revisit only if/when office/PSC hint data becomes available.
  Recommend (c) as the immediate action (near-zero cost, stops the misdiagnosis) with (a) as a possible Wave 5 if the underlying hint-data question resolves favorably — but this is Ninja's call, not a default.

**4.3 — Relationship-candidate promotion flow.** Greenlight for Wave 3, or defer? It's a real, if modest, UX gap (dashed lines nobody can act on) but not urgent — nothing is broken, coverage isn't silently wrong, it's just an unfinished interaction loop.

**4.4 — Personnel queue: operational pass only, or also build bulk-action?** If an admin can realistically spend an hour clicking through 454 rows, no engineering is needed. If that's impractical, bulk-action is a small, well-precedented add.

**4.5 — NAICS-based award fallback (§1.7).** Do not scope this as real work until someone confirms the USAspending contract-award API payload actually includes NAICS. This is a 10-minute API-payload check, not a design decision — but it must happen before any engineering estimate for this path is trusted.

**4.6 — Wave 4 (procurement performer pipeline): greenlight now, or treat as a separate future initiative?** Given its cost (1-2 weeks) relative to every other item in this plan (days, and several already half-built), recommend treating it as a deliberately separate decision, not a default inclusion.

---

## 5. Success metrics (measure before/after each wave, not just "shipped")

| Metric | Current (2026-07-11, verified this session) | Wave that moves it |
|---|---|---|
| Bill links on procurement-BLIN PEs | Structurally 0 (regex blind) | 0 |
| Provision links on procurement-BLIN PEs | Structurally 0 (regex blind) | 0 |
| Federal-award PE-attribution rate | 225 / 169,623 = 0.13% | 0 (small), 2 (larger, curated-map-driven) |
| Distinct acq-program codes mapped | 147 (curated) | 2 |
| `program_alias` row count | not queried live this pass (grow via §1.2's coupling) | 2 (side effect) |
| SAM opportunity match rate, by tier | Tier 1 + Tier 3 only (Tier 2 = 0, dead) | 0 (BLIN fix), 4.2 (Tier 2 fate) |
| PEs with any relationship edge | 666 edges / 2,394 lines scanned (~28%) | unchanged by promotion-flow work; only threshold-tuning (deliberately deferred, §2.3) would move this number |
| PEs with any accepted relationship edge | 415 of 666 edges are `candidate` (dashed); rest `accepted` | 3.2 (as candidates get promoted) |
| PEs with a primary-assigned person | 165 / 2,395 = 6.9% | 3.3 (operational queue work) |
| Open person-candidates awaiting review | 454 | 3.3 |
| Procurement-line performer-table coverage | 0 (no pipeline exists) | 4 only |
| `diag-pe` "sources" field accuracy | Wrong table for every non-RDT&E PE | 0 |

---

## 6. What this plan deliberately does not include

- No changes to the delta engine, `program_element_delta`, or anything that emits `IntelligenceChange` — none of the tables in this plan's scope feed that pipeline, so the alert-storm risk pattern from the earlier NDAA-conference work does not apply here and no natural-key stability analysis is needed.
- No schema migrations in Waves 0-3 — every fix in those waves is either read-only (diagnostics), an insert into an existing table via an existing validated natural key, or new API/UI surface on an existing table. Wave 4 (performer pipeline) needs no schema change either — `program_element_performer` is already appropriation-type-agnostic.
- No assumption that SAM Tier 2 "just needs more aliases" — corrected in §1.1; that framing is retired by this plan.
- No assumption that the 454 relationship candidates are an unreviewed backlog — corrected in §1.4.
- No NAICS-based award-matching design — deferred pending §4.5's verification step.
