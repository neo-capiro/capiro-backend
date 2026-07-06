# Bucket #3 — Net-New Capabilities Plan

**Date:** 2026-07-06 · **Author:** Claude + Ninja · **Status:** PROPOSED (funding/sequencing = Ninja)
**Scope:** the six net-new capabilities deferred from the MeriV2 plan: Vote/Whip/Office-Targeting,
Congressional Calendar/Floor Monitor, Regulatory lifecycle, Budget/Fiscal, Unified Issue (command
center), and Entity Normalization.

Every external source below was **live-verified on 2026-07-06** (real fetches/searches — access
method, auth, formats, and blocks confirmed, not assumed). The MeriV2 migration + wiring scope is
complete and shipped; this plan is pure net-new product on that substrate: the sync-* ingestion
pattern (`runWithSyncRun`, INGESTION_JOBS, EventBridge one-off Fargate tasks), the orchestrator
tool registry with the B1–B4 gate, the canonical Alert + freshness layer, the Claim/Evidence
store, and per-tool grounding evals (SC2.5).

---

## 0. Executive summary

| Capability | Verdict | Effort | External blockers |
|---|---|---|---|
| C1 Vote / Whip / Office Targeting | BUILD — House via official API (GA since Dec 2025), Senate via LIS XML | ~12–15 pd | none (counsel nod on senate.gov retrieval) |
| C2 Floor Monitor | BUILD — docs.house.gov weekly XML is real; rules/majority-leader scrapes are the fragile edge | ~16 pd | counsel: browser-UA fetching of house.gov properties |
| C3 Regulatory lifecycle | BUILD — eCFR API is excellent; OIRA XML solid; one HTML scrape (12866 meetings current period) | ~12–16 pd | counsel: reginfo scrape; ops: REGULATIONS_GOV_API_KEY wiring |
| C4 Budget / Fiscal | BUILD CBO spine + Treasury; **SKIP JCT** (WAF-blocked + PDF-only = poor ROI) | ~8–13 pd | confirm JCT skip |
| C5 Unified Issue / command center | BUILD — internal; v1 ships without vote data | ~19–24 pd (+4–5 after C1) | product decisions (tab home, packet policy) |
| C6 Entity normalization | BUILD — foundation for C1/SC2.2; bills+members first | ~18–24 pd | SAM.gov role account (10/day → 1,000/day) |

**Total: ~85–110 person-days.** Recommended funding order: Wave 1 (C6 core + C4 CBO spine) →
Wave 2 (C1 votes + C5 Issue spine) → Wave 3 (C2 + C3 monitoring depth) → Wave 4 (C5 planner/packets
+ C4 deep analysis + C6 contractors/regulatory). Each wave ships user-visible value on its own.

---

## 1. C1 — Vote / Whip / Office Targeting (plan P2-T1, SC2.2)

### Sources (verified 2026-07-06)
| Source | Access | Verdict |
|---|---|---|
| **Congress.gov API `house-vote`** (`/v3/house-vote/{congress}/{session}[/{roll}[/members]]`) | API, `CONGRESS_API_KEY` (existing, 5k/hr shared) | **PRIMARY for House.** Out of beta Dec 2025; 117th backfilled June 2026. Live-tested: per-member `bioguideID` + `voteCast`. Note: sub-path is `/members` (not `/votes`). |
| **Senate LIS XML** (`senate.gov/legislative/LIS/roll_call_lists/vote_menu_{c}_{s}.xml` + per-vote files) | Static XML, no auth | **ONLY Senate source — no API exists.** URL scheme stable ~20 yrs. Members keyed by `lis_member_id` (NOT bioguide) → crosswalk required. No robots.txt (verified 404). Re-pull last ~25 votes/run (no updateDate). |
| House Clerk EVS XML (`clerk.house.gov/evs/{year}/roll{N}.xml`) | XML but **403s non-browser UAs** (verified) | FALLBACK/audit only. Never schedule against it. |
| Congress.gov `bill/{...}/cosponsors` | Same API/key | Per-member cosponsors with `bioguideId`, sponsorshipDate, withdrawn. Piggyback on sync-congress incremental. |
| Congress.gov `member/congress/{c}` | Same API/key | Roster (552 rows live-tested for 119th). Weekly sync. |
| `unitedstates/congress-legislators` (GitHub) | Bulk YAML/JSON, **CC0 verified** | The LIS→Bioguide crosswalk (senators carry `lis` ids) + committee-membership cross-check. Community-maintained → alert on unmatched ids / >30-day staleness. |

### Data model (all GLOBAL tables, no tenant_id — congress_bill class)
- `congress_member` — `bioguideId` PK, name, party, state, district, chamber, `lisId?` unique,
  terms, `idsJsonb`. ~1.2k rows (117th–119th incl. historical). **Shared with C6 — build once.**
- `roll_call_vote` — id `"{chamber}-{congress}-{session}-{roll}"`, question, result, voteType,
  `billId?` (soft ref; null for quorum/nominations/Speaker), party totals Json, sourceUrl.
  Backfill 117–119 ≈ 5–6k rows; ~1.0–1.4k/yr steady.
- `member_vote` — (voteId, bioguideId) PK, voteCast, party, state. ≈ 435/100 rows per vote →
  ~2.7M rows backfilled (fine for Postgres; two indexes).
- `congress_bill_cosponsor` — (billId, bioguideId), dates, withdrawn. ~600k backfill (respect the
  5k/hr key budget — shard overnight).

### Build phases
1. **V1 members+crosswalk (shared with C6.P1)** — sync-congress-members (API roster + legislators
   crosswalk merge). *2–3 pd*
2. **V2 House votes** — `sync-house-votes` (API list by updateDate → detail → /members), daily
   06:10; 117–119 backfill. *3 pd*
3. **V3 Senate votes** — `sync-senate-votes` (menu XML → per-vote XML → LIS→bioguide crosswalk;
   name+state fallback + alert on unmatched), daily 06:12; backfill. *3 pd*
4. **V4 cosponsors** — extend sync-congress (fetch when cosponsorsCount/updateDate changes) +
   backfill. *2 pd*
5. **V5 tools + evals** — `search_roll_call_votes`, `analyze_member_vote_history`,
   `build_whip_count`, `score_member_alignment`, `recommend_cosponsor_targets`,
   `map_committee_gatekeepers`, `build_member_issue_dossier`, `rank_office_targets`
   (+`track_member_public_positions` deferred — no clean source; press releases are C-tier).
   Alignment scoring = vote-history similarity on subject-tagged bills + cosponsorship affinity +
   committee-gatekeeper weighting (deterministic, explainable factors on every row). SC2.2 eval:
   every member in a whip count resolves to a real `congress_member.bioguideId` — red/green
   captured in meriv2-evals. *3–4 pd*

**Acceptance (SC2.2):** for a real tracked bill, `build_whip_count` + `rank_office_targets` return
a whip count and office priority list grounded entirely in ingested vote/cosponsor/committee rows;
eval asserts zero fabricated members.

**Risks:** shared 5k/hr key budget (schedule offsets; the existing 429/Retry-After backoff);
LIS-id lag for new senators; votes without bill linkage (nominations) must not break joins.

---

## 2. C2 — Congressional Calendar / Floor Monitor (plan P2-T2, SC2.1)

### Sources (verified)
| Source | Access | Verdict |
|---|---|---|
| **docs.house.gov weekly floor schedule XML** | XML feed (requires **browser UA** — house.gov edge 403s bot UAs, same as our prod sync-hearings already handles) | PRIMARY House floor. Weekly file + republish ledger (`publishDates`) drives diffing. Recess weeks 404 (verified for 20260706) → treat as "no session". |
| House Committee Repository XML/RSS (docs.house.gov, incl. Rules RU00) | XML/RSS, browser UA | Committee notices + Rules meetings source-of-record. |
| rules.house.gov + majorityleader.gov | **HTML scrape (Drupal, layout-coupled) — HIGH fragility** | Only source for rule type/amendment deadlines detail + intraday vote windows. Isolate as enrichment; degrade gracefully. |
| Senate floor (LIS session/floor pages) | XML/HTML | LANDMINE (verified): 2026 daily floor-activity files are NOT at the constructed URLs — discovery must walk the index pages. |
| Senate committee hearings XML | XML (we already consume in sync-hearings) | Notices; every 4–6h. |
| GovInfo CCAL/SCAL calendars | API (free api.data.gov key) | OPTIONAL depth; not needed v1. |

### Build phases (F1–F5, ~16 pd)
7 additive GLOBAL models (`floor_week`, `floor_schedule_item`, `senate_session_day`,
`senate_floor_activity`, `rules_committee_action`, `rules_amendment`,
`committee_notice_revision`) → `sync-floor-schedule` + `sync-house-rules` → **emit-floor-alerts**
derived emitter joining floor items × tracked bills/PEs → clients through the EXISTING freshness
layer + canonical Alert (complete 7-field alerts) → 7 tools + grounding evals →
EventBridge wiring (out-of-band role — the known INGESTION_JOBS/CDK drift landmine).

**Cadence override vs plan:** every-4h weekdays (not the plan's daily 05:06) — floor schedules
shift intraday; daily is stale by lunchtime. ~$1–2/mo extra Fargate.

**Acceptance (SC2.1):** "what can move this week" returns floor/markup/amendment-deadline alerts
sourced ONLY from ingested rows; every cited legis-num resolves to an ingested item. Alert wording
must hedge ("scheduled/may be considered") — floor schedules are not promises.

**Risks:** UA-gating posture (counsel memo below); legis-num normalization (trailing spaces,
"H. Res." variants — normalize through the C6 registry); the two Drupal scrapes WILL break on
redesign — build with per-source circuit breakers + parse-failure alerts.

---

## 3. C3 — Regulatory lifecycle (plan P2-T3, SC2.1)

### Sources (verified)
| Source | Access | Verdict |
|---|---|---|
| **eCFR Versioner API** (ecfr.gov) | REST API, no key, point-in-time versioning | EXCELLENT. Diff = fetch `full/{dateA}` vs `full/{dateB}` for only the parts the versions feed says changed, then text-diff. Per-part fetches only (Title 40/48 full-title XML is huge). |
| FederalRegister.gov API v1 | API, no key (already synced daily) | Extend existing sync: request `regulation_id_numbers` + `raw_text_url`; RIN backfill 2021+. |
| Regulations.gov API v4 | API key — **NOT currently wired in CDK/config.schema (verified gap — prod-health fix regardless)** | Dockets/documents daily; comments ON DEMAND (5k pagination cap → mass-comment dockets sampled). |
| Reginfo EO 12866 XML (under-review + concluded) | Static XML (file dated today — live) | OIRA review tracking. LOW fragility. |
| Reginfo 12866 **meeting logs** | XML lags 1+ year; **current period = JSP HTML scrape (HIGH)** | The one fragile source. Weekly scrape; counsel item. |
| Reginfo Unified Agenda bulk XML | Static XML per season | 2 pubs/yr; schema drifted across eras → per-era parser tolerance. |

### Data model
RIN-centric spine: `regulatory_action` (RIN unique, agency, stage, cfrCitations[], docketIds[],
oiraStatus, significance) + `ecfr_version_event` + `oira_review` + `oira_meeting` +
`unified_agenda_entry`, linked to existing `federal_register_document` + `regulatory_docket`.
All GLOBAL; tenant linkage at the watch/alert layer.

### Build phases (R0–R5, ~12–16 pd)
R0 key+schema groundwork (wire REGULATIONS_GOV_API_KEY as CDK secret — mirrors govinfo pattern) →
R1 FR-sync extension + RIN spine → R2 agenda+OIRA syncs → R3 eCFR sync + diff engine (the hard
part; S3 snapshots of changed parts; diff validation before any client sees one) → R4 the 11
tools + grounding evals → R5 comment-deadline canonical Alert + live SC2.1 demo on a real RIN.

**Hard product rule:** `draft_regulatory_comment` is **DRAFT-ONLY** — no regulations.gov e-filing
(the POST/comments ToS carries real obligations; drafts flow to the human via Workspace).

**Risks:** wrong eCFR diff shown to a client is worse than no diff (validation corpus + hedged
rendering); comment records >5k sampled with explicit "sampled N of M" labeling; LLM cost cap for
`summarize_comment_record` (≤500-comment sample proposed).

---

## 4. C4 — Budget Score / Fiscal (plan P2-T5, SC2.4)

### Sources (verified) — and one honest SKIP
| Source | Access | Verdict |
|---|---|---|
| **Congress.gov bill-detail `cboCostEstimates[]`** | Already in the responses sync-congress fetches — **zero extra API calls** | PRIMARY. The cheapest capability in the bucket. |
| CBO all-publications RSS | RSS open (verified) — but **cbo.gov pages/PDFs WAF-block server fetches even with browser UA (TLS fingerprinting, verified via curl)** | Discovery/freshness only; never fetch cbo.gov HTML server-side. |
| Committee reports (Congress.gov/GovInfo API) | API, same key | The RELIABLE full-text path for dollar tables/pay-fors (estimates are embedded in reports). |
| **JCT (jct.gov)** | **HTML hard-403s automation; PDF-only content; no feed** | **RECOMMEND SKIP** as a pipeline. Poor ROI; tax-score gap documented in tool output ("no JCT pipeline") instead. |
| **Treasury Fiscal Data API** | Real documented REST API, keyless (verified live; MTS latest 2026-05-31) | MTS tables 1/5/9 + Debt to the Penny. Note: literal `"null"` strings in amounts (seen live) — parser must handle. |
| USAspending `/v2/federal_accounts` | API, keyless (2,261 FY26 accounts returned live) | Budget-account reference for bill↔account mapping. |

### Build phases
F1 CBO spine (model + persist from existing bill-detail + 117–119 backfill; **SC2.4 green here**)
*3–4 pd* → F2 sync-cbo RSS discovery (daily, not the plan's weekly — freshness is the product)
*2 pd* → F3 sync-treasury-fiscal + budget accounts *3–4 pd* → F4 pay-for extraction from committee
reports + money-graph/PE-360 surfacing (coordinates with the line-type-aware PE profile, #297)
*4–5 pd*.

**Acceptance (SC2.4):** bill→estimate mapping where one exists; explicit "no estimate found"
(never a guess) where none — eval covers both.

---

## 5. C5 — Unified Issue + Path-to-Win + Client Packets (plan P3-T1..T3)

**Internal build** on stores that all exist today (tracked bills/intel alerts, engagement
tasks/campaigns/meetings, ClioArtifact, office recommender, the NOW-LIVE canonical-Alert adapters
and the NOW-WRITING Claim/Evidence store, budget timeline).

### Data model (tenant-scoped + RLS, tracked_bill convention; cross-store refs = plain id columns)
`issue` (client-scoped: title, status active/monitoring/won/lost/parked, objective
pass/block/amend/fund/defund/regulatory/monitor, position) + `issue_link` (polymorphic:
bill/alert/task/artifact/hearing/PE/docket) + `issue_office_target` + `issue_plan` +
`issue_update_packet`. Denormalized `next_deadline_at`/`last_change_at` caches with recompute.

### Build phases
- **A — Issue spine + 360 surface (SC3.1)** *7–9 pd, no dependencies.* CRUD + tenant roll-up +
  `GET /issues/:id/360` (batched intel-api internal calls — watch fan-out latency). UI: proposed
  **5th LegiWatch tab "Issues"** + issue detail; coordinate with the in-flight LegiWatch v2 L1
  calm-cards work.
- **B — Path-to-Win planner, degraded v1** *6–8 pd, after A.* Deterministic candidate assembly
  from what exists TODAY: vehicle stage (bill actions), committee gatekeepers (directory), office
  targets (recommender), cosponsor prospects (needs the small sync-congress cosponsor extension —
  ~1 pd, shared with C1.V4). **Ships with an explicit "no vote data yet" banner** — credibility
  over polish.
- **C — Client update packet generator (SC3.3)** *6–7 pd, after A.* Period assembly (alerts, stage
  moves, budget actions, tasks, meeting/debrief summaries) → grounded narrative through the
  verifier + Claim/Evidence store → **always human-approved before send** (B2 gate + SOC2) →
  in-app + Outreach HTML email v1 (docx via Workspace export in D).
- **D — Vote-data upgrade + docx export** *4–5 pd, **blocked on C1**.* Swing/champion
  classification, whip-count stage in the plan, remove the degraded banner.

**Risks:** issue↔alert linkage GIGO for thin watchlists; EngagementCampaign (email send) vs
"campaign object" naming collision — recommend **Issue IS the campaign container**; LegiStorm
license scope for staffer names in client-deliverable packets (counsel).

---

## 6. C6 — Entity Normalization (canonical IDs; plan Appendix B)

**The foundation layer.** C1's SC2.2 and every "no fabricated entities" eval rest on it.

### Sources (verified)
`unitedstates/congress-legislators` (CC0; bioguide hub incl. lis/fec/opensecrets/wikidata ids) ·
Congress.gov API (bills/members/committees) · SEC `company_tickers.json` (CIK↔ticker↔name — **403s
default UAs; requires the declared-UA fair-access header**, verified) · **SAM.gov Entity API
(UEI↔CAGE↔name↔NAICS) — roleless keys get TEN requests/day (verified in GSA docs); a
role/system account gets 1,000/day → BLOCKING account action for Ninja** · FederalRegister API
(RINs) · Regulations.gov (docket↔RIN) · LDA API (client_id/registrant, existing) · USAspending
(FAIN/PIID/UEI, existing).

### Build phases
- **P6.0 registry module** *2–3 pd* — `packages/shared/src/canonical-ids.ts`: `CanonicalIdType`
  union (bioguide, billId, committee systemCode, CIK, UEI, CAGE, RIN, docketId, FAIN/PIID, NAICS,
  peCode), per-type regex validators + parsers + normalizers (incl. our `"{congress}-{type}-{num}"`
  bill-id house format ↔ Congress.gov forms — bidirectional, round-trip-tested).
- **P6.1 bills + members** *5–6 pd* — `congress_member` + committees + memberships +
  `entity_crosswalk` ((idType,idValue)→entity) + `congress_bill.sponsor_bioguide_id` + cosponsors.
  **Shared with C1.V1/V4 — fund once.** Decision: promote `congress_member` to canonical for
  member IDENTITY (directory S3 JSON keeps narrative/press overlays).
- **P6.2 tool enforcement + `resolve_entity`** *4–5 pd* — registry zod refinements on tool
  params/outputs typed as canonical IDs; `resolve_entity` tool; the SC2.2-class eval gate.
- **P6.3 contractors (CIK/UEI/CAGE)** *5–7 pd, blocked on the SAM account* — sec_company weekly +
  sam_entity lookup-driven cache + human-confirmable crosswalk (auto-confirm only exact-name+state;
  everything else queued — **crosswalk poisoning is the top risk**).
- **P6.4 regulatory (RIN/docket)** *4–5 pd, parallelizable* — FR rins[] + docket.rin enrichment.
- **P6.5 coverage metrics** *2–3 pd* — nightly % coverage report + normalization-gap flagging.

---

## 7. Consolidated sequencing (waves)

```
Wave 1  (~16–20 pd): C6.P6.0–P6.2 (registry, members, cosponsors, enforcement)
                     + C4.F1–F2 (CBO spine — cheap, immediate lobbyist value)
Wave 2  (~20 pd):    C1.V2–V5 (House+Senate votes, whip/office tools; SC2.2)
                     + C5.A (Issue spine + 360 — independent, parallel track)
Wave 3  (~28–32 pd): C2.F1–F5 (Floor Monitor) + C3.R0–R5 (Regulatory lifecycle)
Wave 4  (~25–30 pd): C5.B–D (Path-to-Win + packets + vote upgrade)
                     + C4.F3–F4 (Treasury + pay-fors) + C6.P6.3–P6.5
```
Dependencies: C1 ⇐ C6.P6.1 (members). C5.D ⇐ C1. Everything else parallelizable.
Each wave exits with live tools + grounding evals green + a demo on real data.

## 8. The counsel memo (one consolidated review, ~1 hour of counsel time)
1. **Browser-UA fetching of house.gov properties** (docs.house.gov XML — already done in prod for
   hearings; majorityleader.gov + rules.house.gov scrapes) — bless the UA posture.
2. **senate.gov automated retrieval** (no robots.txt, no API ToS to point at; public-domain data).
3. **reginfo.gov 12866 meeting-search HTML scrape** (official XML lags 1+ yr).
4. **cbo.gov / jct.gov WAF blocks — we will NOT circumvent** (feeds/API paths only; confirm).
5. **`draft_regulatory_comment` DRAFT-ONLY** — no e-filing (regulations.gov POST ToS).
6. **LegiStorm license scope** — staffer names/contacts in client-deliverable packets.
7. **SAM.gov public-tier extract** caching/redistribution posture.

## 9. Ops / account actions (Ninja, ~1 hour total)
- **SAM.gov role/system account** (blocks C6.P6.3; roleless = 10 req/day).
- **Wire REGULATIONS_GOV_API_KEY as CDK secret** (verified gap; prod-health fix regardless).
- Optional: api.data.gov key for GovInfo CCAL/SCAL.
- Cadence approvals: floor monitor every-4h weekdays; sync-cbo daily.

## 10. Product decisions (Ninja)
1. Confirm **JCT skip** (documented gap vs fragile PDF pipeline).
2. Issues tab home: **LegiWatch 5th tab** (proposed) — agree/veto.
3. **Issue = the campaign container** (EngagementCampaign stays the email-send mechanism).
4. Packets: **always human-approved**; v1 delivery in-app + Outreach email (docx in Wave 4).
5. Floor alerts at launch: in-app only, or also the tracker email channel?
6. Treasury macro data: tool-only (recommended) or a UI tile?
7. Historical depth defaults: votes/cosponsors 117th+; regulatory 2021+; members incl. historical.
8. Wave funding: green-light Wave 1 now, or re-scope.
