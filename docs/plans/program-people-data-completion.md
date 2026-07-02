# Programs & People — Data Completion Plan

2026-07-02. Scope: **data completion only** (programs + people), not features. Written against the
external assessment of `pe_lists_export` (programs.csv / people.csv / performers.csv) + the
2026 DoW Directory Update 6 PDF, corrected for what is actually already in capiro-dev.

## 0. Ground truth — where the assessment under-counts prod

The assessed CSVs are a **stale export of local artifacts** (37 source files, generated before the
FY2027 expansion), *not* a dump of prod. Prod is already ahead:

| Layer | Assessment (from CSVs) | Actual prod state (2026-07-02) |
|---|---|---|
| RDT&E PEs | B+ (1,353 codes, stale Navy FY2024) | 952 R-1 FY2027 lines + R-2 detail; FY26+27 HASC/SASC/NDAA-conf/HAC-D marks + deltas (batches 1, 4) |
| Procurement | C- (Army-only) | **818 BLIN-keyed lines, all services** (Army raw BLIN; others `<appropriation><lineItem>`), + FY2027 authorization + HAC-D marks (batches 2–4) |
| O&M | absent | **389 O-1 lines, all accounts** (`<account><line>`, appropriationType=OM) — batch-7, loaded 2026-07-02 |
| People | D+ (86 people) | **~5,593 DoW Update-6 people imported** (`dow_directory_rev6_2026_06`) + Army CPE rosters + SAM + press ≈ 7.7k personnel rows |
| Performers | B (5,991 R-3 rows) | same 5,991 loaded (`sync-jbook-performers`); Navy portion is FY2024 |
| Contracts | missing | `federal_award` ~10.1k with PE links + curated MDAP→PE map + 12.4k SAM-opportunity matches — partial, capped |
| DoW Directory PDF | "ingest it" | **Already parsed AND people-imported.** Unused: `dow_v6_orgs.json` (9,517 orgs **with parent hierarchy**), `dow_v6_programs.json` (126 programs **with owners**), `dow_v6_links.json` (6,726 links) |

The assessment's *structural* findings stand: **person→program linkage** is weak, the **org graph**
is not in queryable tables, **provenance stamping** is partial (committee loads stamped; R-1/P-doc/O&M not),
and the export CSVs must be regenerated from prod.

## Phase 0 — Finish in-flight feeders + measure the real denominators

1. **Batch-5 (P-40 deep enrichment, running):** per procurement line — description, ACAT,
   competition, acquisition phase, **MDAP/MAIS code**, **related RDT&E PE**, **program office
   ("Managed by PEO/PM X")**, contractors, milestones, risks. Loader `load-pdoc-enrichment` is
   deployed. This is the single biggest programs-completion feeder.
2. **Batch-6 (Navy FY2027 R-2, books downloaded via Wayback):** full R-2 narratives + R-2A projects;
   **refresh Navy R-3 performers from FY2024 → FY2027** while extracting.
3. **Prod truth diag (new one-off):** counts by appropriationType/source; personnel by source;
   link coverage: `pe_program_match` rows by status, person→PE links, award→PE coverage,
   `program_element_acquisition_program` size. These are the real baselines for the grades.

## Phase 1 — Programs master completion

| # | Item | Mechanism | Fixes (from assessment) |
|---|---|---|---|
| 1.1 | Close budget gaps: AF Ammunition book (Ninja browser-download), FY2026 procurement marks (needs FY2026/PB26 P-40 books OR marks re-keyed by line-item code), ~50 scattered lines; accept 4 unkeyable DW lines + no-public SAC-D | existing pipeline (toc_parse/match_blins/build_marks) | procurement C- → A- |
| 1.2 | **Re-export master lists from PROD**, not local artifacts: new `export-master-lists` verb emitting `program_elements.csv` + `procurement_lines.csv` + `om_lines.csv` (split keyspaces) with per-row source + sourceUrl | new small script (read-only) | stale CSVs, mixed peCode column |
| 1.3 | **Provenance stamping**: extend `upsertSourceDocument` registration (already used by committee loads, 7.5k rows stamped) to `parse-pdoc`, `load-om`, and R-1 sync | small loader edits | 1,199 blank source URLs |
| 1.4 | **Canonical titles**: batch-5/6 narratives carry full titles; longest-wins guard already in writer. Fix `1203001SF` blank title | already flowing | 355 title variants, 96 dupes |
| 1.5 | **MDAP map seeding**: batch-5 MDAP/MAIS codes → `program_element_acquisition_program` (curated review queue) | new seed verb + review | unlocks contractors for procurement lines |
| 1.6 | **Program (office) entities**: merge `dow_v6_programs.json` (126 programs w/ owners) + batch-5 "managed by" mentions into `program`/`program_alias`; run `match-pe-program --apply` → human review of candidates | existing matcher (candidate-only by design) | org_program_links |

## Phase 2 — People completion

| # | Item | Mechanism |
|---|---|---|
| 2.1 | **No re-ingest of the Directory** — Update 6 already parsed + imported. Sanity-diff the attached PDF vs `dow_v6_stats.json`; idempotent re-run only if the artifact is newer | `import-dow-directory-v6` (idempotent) |
| 2.2 | **Person→program/PE links (the real gap):** run `generate-pe-person-candidates --commit` (uses the imported `programs_mentioned` signal), then `match-pe-person` scoring + `repair-person-pe-links`; human review queue. Measure link coverage before/after | existing verbs, not yet run at scale over the new program universe |
| 2.3 | **Stale-source sweep:** retire `stanford_*` personnel not re-confirmed by `dow_directory_rev6` (imports are additive-only today; stale rows still display) | `reconcile-personnel-supersede` + read-filter fix |
| 2.4 | **Roster expansion beyond Army:** Navy PEOs (IWS, Ships, Subs, USC, Digital), AF PEOs, SF/SSC, MARCORSYSCOM, SOCOM SOF-ATL — official pages, same scrape pattern as CPE rosters | extend `sync-peo-rosters` roster set |
| 2.5 | **Official verification of top ~15 offices** (ASA(ALT), ASN(RDA), SAF/AQ, SSC, MDA, DISA, SOCOM, MARCORSYSCOM + major PEO/PM pages): verify names/titles, set `last_verified_at`, confidence | manual+scripted pass; staleness tracking exists |
| 2.6 | **Licensing guard:** Directory = internal seed only (its license bars republication). Customer-facing display keeps the existing contact-use policy gate + prefers officially-verified rows | policy already in code; enforce in exports |

## Phase 3 — Org graph (minimal schema; data model, not feature)

The raw material already exists, parsed: `dow_v6_orgs.json` has **9,517 org rows with `parent`
pointers** (PAE → CPE/PEO → PM/PdM chain), people rows carry `organization`/`sub_organization`,
`dow_v6_programs.json` carries program→owner. Missing only the tables.

1. Migration: `org_unit` (id, parent_id, name, code, service, org_type, source, source_page),
   `person_position` (person → org_unit, title, rank/grade, source, verified_at),
   `org_program_link` (org_unit → program).
2. Importer: `import-dow-orgs` — load orgs w/ hierarchy, attach people by org/sub-org match,
   attach programs by owner match. All rows carry source_page + confidence (source_assertion style).
3. Result: PAE → PEO → PM → program → PE/BLIN/O&M-line chain queryable end-to-end
   (budget line already links via phases 1.5/1.6).

## Phase 4 — Contracts/awards layer (next after graph)

1. **Break the USAspending 10k ceiling** (`spending_by_award` caps pagination): shard the backfill
   into <10k windows (`--until` + adaptive split) → full award universe, not top-10k-by-$.
2. Award→procurement-line linkage via the MDAP map (1.5) — extends the existing two-tier
   contractor attribution to BLINs.
3. Relabel R-3 rows as "budget-justification performer" (planned/associated), distinct from
   award-holder — wording only, keeps the honest-provenance rule.

## Phase 5 — Continuous verification

- Quarterly top-office re-verify (2.5) + personnel staleness alerts (tracker exists).
- Scheduled `export-master-lists` artifact so the master CSVs never go stale again.
- New directory revision (Update 7+) → same parse → idempotent re-import → rev diff (the v6
  artifact already includes `dow_rev4_to_rev6_diff.json` as the pattern).

## Decision points (Ninja)

1. **Org-graph migration** (Phase 3) — new tables; needs schema approval.
2. **Human-review capacity** — pe_program_match and person→PE candidates are review-gated by
   design; someone has to work the queue (or we agree an auto-accept threshold for exact-alias hits).
3. **FY2026 procurement marks** — blocked on FY2026 (PB26) P-40 books or a re-keyed mark export.
4. **AF Ammunition book** — still needs a browser download.

## Sequencing

Phase 0 is running now. 1.2–1.6 + 2.1–2.3 are a week-scale increment on existing pipelines.
Phase 3 is the one schema change. Phase 4 rides afterwards. Every load stays: PR → CI → deploy →
ECS one-off → verify (0 quarantined + spot checks), as batches 1–7 did.
