# State Legislation — Phase 1 Implementation Plan (First Moats + Agentic Tier-2)

**Date:** 2026-07-09 · **Parent:** `2026-07-09-state-legislation-platform-plan.md` (Rev 3, §4)
· **Predecessor:** `2026-07-09-state-phase0-implementation-plan.md` · **Agentic spine:**
`2026-07-09-agentic-intelligence-architecture.md`.
**Scope:** the four Phase-1 moats — **M1** District Impact Engine, **M2** Deadline Physics +
Committee Chokepoint, **M3** State Rules & Agency Watch, **M4** Meri as 50-state analyst — plus
**M5**, the first real build of the agentic **Tier-2 worker** (`run-intel-workflows`,
targeting-brief mode + rules-comparison assist). Every workstream is specified for **both rails**:
the existing federal bill tracker and the new state rail.
**Grounding:** every claim about existing code was read at `87ff019` (file:line anchors); every
"does NOT exist" was grep-verified. Census Geocoder behavior was verified against the live
service. No assumptions.
**Governing rule (from the agentic doc):** deterministic software establishes truth; agents
interpret, connect, prioritize, and draft. M1's geography and M2's chokepoint chain are
**deterministic** precisely so the M5 agent's targeting brief can be **validated** against them.

## Blocking assumptions (verify before starting)

- **A1 — Phase 0 shipped.** LegiScan spine + state truth tables (`state_bill`,
  `state_bill_action/sponsor/vote/version/link/calendar_event`, `state_session`,
  `state_committee`, `state_sync_cursor`), `deriveStateBillStatus`, state alerts on the
  intel-api LegiWatch emitter rail (`sourceType='state_bill'`), the jurisdiction facets on
  `intel_watchlist`/`intel_alert_preference`, and the state Meri read tools (P0-S6:
  `get_state_bill_status`, `search_state_floor_votes`, `get_state_legislator`,
  `resolve_entity` state types) are all live. Phase 1 **builds on** these; it does not re-spec
  them. Where a P0 table's exact shape matters it is re-quoted.
- **A2 — Agentic Tier-2 foundations status is the gating unknown.** The agentic doc places
  `ai_run` (§5.1), the `GroundedJson` helper (§5.3), the deterministic validator gate (§5.4),
  and the H-1 metering-gap fix in **P0**. The **P0 implementation plan (S1–S7) does not build
  them** — it is the data/alert substrate only. So these are a seam. **This plan treats them
  as M5 prerequisites and builds any that did not ship in a P0-agentic pass** (M5.0), with an
  explicit dependency gate. (The Tier-1 enrichment endpoint / W-D generalization is a
  _separate_ LegiWatch federal workstream, **not** a Tier-2-worker prerequisite — it is
  deliberately excluded from M5.0's build list.) Confirm what exists before M5 starts; do not
  assume.
- **A3 — Priority states (Ballard-weighted, parent D2):** FL, CA, TX, NY, IL, MA, GA, VA.
  M1 geocodes all facilities regardless; M2/M3 curation and coverage start with these.
- **A4 — Phase 0.5 status (the amendment-diff worker).** The agentic doc §10 ships a _minimal
  single-mode_ `run-intel-workflows` (amendment-diff / full Change Analyst) in **P0.5**. Confirm
  whether it shipped: if yes, M5.1 **extends** that existing worker to the full mode registry;
  if it slipped, M5.1 builds the minimal worker + amendment-diff mode first. Either way, the
  "full mode registry" M5 completes **includes the P0.5 amendment-diff mode** alongside P1's
  targeting-brief + rules-comparison assist.

---

## 0. Shape of the phase

```
M1 geography ──┬─► M2 chokepoint (needs districts+rosters) ──┐
               │                                             │
M1 represent ──┤                                             ├─► M5 targeting-brief
M4.1 roster ───┤ (get_committee_roster + get_representation) │   (validated vs M1+M2+M4.1)
M4.2 represent ┘   gate the brief + its validator            │
M3 rules ──────────────────────────────────────────────────►┴─► M5 rules-comparison assist
M4.3 cross-jurisdiction Meri (Tier-3) ── parallel with M5
```

| WS  | What                                                                                                                                                                     | New files (≈) | Modified files (≈) | Effort   |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------- | ------------------ | -------- |
| M1  | Census geocoder + facility geo columns + representation resolver + who-represents UI + district one-pager                                                                | 5             | 8                  | 2 wk     |
| M2  | `state_session` calendar hardening + committee-roster activation/normalization + chokepoint chain + deadline emitter + `deadline` key + chokepoint UI                    | 6             | 9                  | 2 wk     |
| M3  | `state_rule` truth table + register ingestion (priority states) + unified rule-emitter on intel-api (**federal regs + state rules**) + comment-deadline reuse + rules UI | 7             | 8                  | 2.5 wk   |
| M4  | state read-tool completion + `get_committee_roster` (both rails) + cross-jurisdiction prompts + eval                                                                     | 2             | 6                  | 1 wk     |
| M5  | agentic prerequisites (if unshipped) + `run-intel-workflows` worker + targeting-brief mode + rules-comparison assist + surfacing                                         | 6             | 5                  | 2–2.5 wk |

**Effort reconciliation (revised from parent §4, stated plainly):** per-workstream estimates
here are revised **up** from the parent's (M1 1.5→2 wk, M2 1.5→2, M3 2→2.5) after the discovery
pass exposed real wiring (the unwired chokepoint chain, per-state register adapters), and **M5
(agentic Tier-2, ~2–2.5 wk) is net-new relative to parent §9's P1 contents row** — the agentic
doc §10 places it in P1. The phase-level total therefore holds at the parent's **~5–7 wk** only
via the stated parallelism: M1↔M3 in week 1, and M4.3 (Tier-3 Meri) ∥ M5. Note the critical
path to the P1 headline (the targeting brief) runs M1→M2→**M4.1/M4.2**→M5.2 (the roster +
representation tools gate the brief and its validator), so M4.1/M4.2 are **on** the critical
path, not parallel; only M4.3 is parallel. Realistic serial critical path ≈ 6–7 wk; the 5-wk
lower bound assumes aggressive M1↔M3 overlap and that agentic prerequisites (A2) already shipped.

---

## 1. Locked design decisions (PD1–PD8)

**PD1 — One geocode call, both rails, and it fixes federal district accuracy too.** The Census
Geocoder `geographies` return type yields, in a single unauthenticated call, the 119th
Congressional District **and** both State Legislative District layers (Upper/Lower) for an
address (verified live: layer keys `"… State Legislative Districts - Upper"` → `SLDU`,
`"… - Lower"` → `SLDL`, plus `"119th Congressional Districts"`). So M1's geocoder populates
federal `congressionalDistrict` **and** the new state-district columns at once. Today
`congressionalDistrict` is manual entry (`districtSource='user'` default,
`client-facilities.service.ts:63`) and the `'geocoded'` provenance is aspirational — no
geocoder exists (grep-verified). M1 makes `'geocoded'` real, which **improves the federal
tracker**: the Office Recommender's facility→member matching
(`office-recommender.service.ts:143-166`) currently trusts hand-typed districts; geocoded
districts raise its accuracy with zero recommender changes. _Rejected:_ a paid geocoder
(Census batch is free, 10k/file); PostGIS/`geom` columns (we store the resolved district
codes, not geometry — no spatial-query need in P1).

**PD2 — Representation is a deterministic resolver, never an LLM call.** "Who represents your
footprint" and its inverse ("which of my facilities are in this member's district") is a pure
join: facility `(state, congressionalDistrict)` → `congress_member (chamber='house', state,
district)` for the House + both senators by state; facility `(state, stateHouseDistrict)` →
`state_legislator (chamber='lower', state, district)`, `stateSenateDistrict` →
`chamber='upper'`. This is buildable today — `congress_member` has `state`/`district Int?`
(`schema.prisma:2278`), `state_legislator` has `state`/`district String?`/`chamber`
(`3677-3694`). Build it once as `RepresentationResolverService`; both the UI (M1.3) and the
agent's validator gate (M5) consume it. The agentic doc is explicit: "Do not ask a language
model which district contains an address" (§7). _Rejected:_ extending the in-memory
member-centric loop in the Office Recommender (it answers a different question — ranking
offices — and only reads the S3 directory, not `congress_member`; a shared resolver is cleaner
and testable).

**PD3 — The committee-chokepoint chain must be WIRED; today it is not.** Discovery found the
chain "referred committee → its chair" is not connected end-to-end federally:
`congress_bill_committee.committeeName/committeeCode` (`schema.prisma:2495-2506`) does **not**
reliably join to `congress_committee.systemCode` (committeeCode often null / different code
space), and the chair — which lives in `congress_committee_membership.title`
(`2352-2366`, values `'Chair'|'Ranking Member'|…`) — sits in a table **populated by
`sync-committees.ts` but read by no live path** (the live directory UI reads chair from the S3
LegiStorm snapshot's `committees[].position` instead). M2 activates
`congress_committee_membership` as the **deterministic** chair/role source and builds a
`committeeName/Code → systemCode` normalization crosswalk so the chain resolves. Why
deterministic-DB over the S3 snapshot: the M5 targeting brief's exit criterion is "names only
members whose roles validate deterministically" — the validator needs a DB truth source, not a
cache. The S3 directory stays the display/fallback. _Rejected:_ fuzzy committee-name substring
matching (what the Office Recommender does, `:190-201`) — not reliable enough to gate a
client-facing "this chair can kill your bill" claim.

**PD4 — One rule-emitter, feeding BOTH federal regs and state rules, on the intel-api LegiWatch
rail — closing an existing federal gap.** Discovery's sharpest finding: **federal regulation
alerting rides exclusively the apps/api `IntelligenceChange` rail and never touches the
intel-api LegiWatch emitter** (`intel_alert.sourceType` is `'bill'|'hearing'|'combined'` only —
no `'regulation'`/`'rule'`). So a client watching "data privacy" sees federal _bills_ in the
LegiWatch feed but federal _regs_ only in the dashboard/profile — a split experience. M3 builds
a single **`regulation` emitter on intel-api** and feeds it from two truth sources: the existing
`federal_register_document` (`3105-3126`) **and** the new `state_rule` table (M3.1). This (a)
gives state rules the same watchlist-match + evidence-block + unified-feed treatment state bills
got in P0-S4, and (b) **unifies federal regs into the LegiWatch feed for the first time**.
**Scope note — this extends the parent's M3.** Parent §M3 specs only a state-direction
`state_rule` source on the rail; unifying _federal_ regs into LegiWatch is a deliberate scope
expansion (pending **D-P1-5**), consistent with the "applies to the federal tracker" mandate but
not in the parent's original M3 — it is nearly free because the emitter is one code path, not
because the parent asked for it. **Naming:** the single intel-api sourceType is **`regulation`**
(jurisdiction distinguishes federal vs state), superseding the parent's `state_rule`
_sourceType_ wording; the _truth table_ stays `state_rule`. So parent SC-9's "state_rule alert"
reads as a `regulation`-sourceType alert carrying `jurisdiction=<state>` — same event, renamed
vocabulary (noted so the SC-9 cross-reference isn't read as a mismatch).
The dashboard `comment_deadline`/`comment_overdue` chips (apps/api `IntelligenceChange`,
`intelligence.service.ts:4165-4330`, `4501-4512`) stay as-is and gain state rows — deadlines
are a countdown surface, distinct from the match-alert surface. **No double-notify —
enforced, not asserted:** the two paths live in separate prisma realms, so M3.4 stamps a
shared `(clientId, documentId, event)` dedupe key readable by both, and the apps/api
comment-deadline path is confirmed **countdown-chip-only** (it must not fire a user
notification for a document the intel-api `regulation` emitter already alerted on); the
cutover verifies zero duplicate notifications (M3-D). _Rejected:_ mirroring federal regs'
apps/api-only path for state rules (would leave state rules out of the unified LegiWatch feed
and duplicate the split we're trying to close).

**PD5 — Deadline-death is state-only; the "deadline approaching" mechanic is federal-proven and
shared.** Federal bills have no deadline-death concept (grep-confirmed; a Congress bill dies at
end of the 2-year term but that is not modeled per-bill and rarely actionable). State bills die
at crossover / committee cutoff / sine die — this is the whole point of M2's deadline physics
and is derived from `state_session` dates (P0 ships `sineDie`; M2 adds crossover/cutoff via NCSL
curation). But the **alert mechanic** already exists federally: `check-comment-periods.ts`
scans `federal_register_document.comment_end_date`, emits `changeType='comment_deadline_approaching'`
with severity critical(<3d)/notable(≤7d)/info. M2's `bill_deadline_approaching` emitter
**generalizes that proven pattern** to a bill's next procedural cutoff. Federal application of
M2 = the **chokepoint map** (committee gatekeeping is universal, uses the #367 truth layer);
the deadline-death piece is state-specific and labeled so. _Rejected:_ forcing a federal
bill-deadline analog (marginal value, not modeled, would be invented data).

**PD6 — The district one-pager is a new alert-memo variant (Route B), both rails.** The parent
says "a Workspace doc type generated from the alert-actions memo machinery." Discovery found two
homes: (A) a new Workspace product — but "One-pager" already exists as a Workspace product
(`cascade.config.ts:219`) for the _reusable-template_ case, and Workspace inputs don't carry
facility/member/bill as first-class fields; (B) a new alert-memo variant in
`apps/api/src/intelligence/alert-memo/` — the grounded machinery (`buildClaims` closed claim
list → `verifyGrounded` drops ungrounded paragraphs → `scaffold` fallback → docx →
`createAttachmentFromBuffer(source:'district_brief')`). For an **alert-triggered** artifact
Route B is the exact precedent; it reuses `loadSteering` (firm voice) unchanged. M1 ships Route
B, applicable to a federal bill hitting a facility's House district and a state bill hitting a
facility's state district — the claim set differs only by which representation the resolver
returns. _Rejected:_ Route A for the alert-triggered flow (Workspace has no facility/member
input binding today — would be more new wiring than a memo variant, and produces an editable
draft when the alert flow wants a one-shot filed artifact).

**PD7 — The Tier-2 worker writes through deterministic writers; it never calls gated write tools,
and its targeting brief is validator-gated on M1/M2 truth.** Per the agentic doc, unattended
runs cannot use the throw-based approval gate. `run-intel-workflows` (M5) generalizes
`run-clio-scheduled-tasks` (read-only allowlist + `FORBIDDEN_SCHEDULED_TOOLS`, per-tenant
`TenantContext`, BYOK resolve) and writes results through its own writers into `ai_run` +
`intel_alert.evidence.enrichment` / an opportunity/brief record — never Workspace/Outreach send
tools. The targeting brief's named members/roles/districts are **re-checked** by the
deterministic `RepresentationResolverService` (M1) and the chokepoint chain (M2) before the
brief attaches; any member the agent names that the resolver doesn't confirm is dropped. This
is how the P1 exit ("names only members whose roles/districts validate deterministically") is
met mechanically, not by trust. _Rejected:_ an orchestrator system-principal door (agentic
D-A1 defers it to P2; app-side worker is the proven pattern).

**PD8 — A new Meri `get_committee_roster` tool is required; `resolve_entity` is insufficient for
targeting.** Discovery: `resolve_entity` returns committee _identity_ (`systemCode, name,
chamber`) but **no roster / chair-ranking roles**, and there is no `get_directory_*` tool. The
M5 targeting brief needs "who chairs the committee this bill sits in," so M4 adds
`get_committee_roster` reading `congress_committee_membership` (federal, activated in M2) and the
normalized state committee roster (M2). This tool is also what makes the brief's role claims
_checkable_ — the validator and the tool read the same DB source. _Rejected:_ having the agent
scrape roles from free text (defeats the deterministic-validation requirement).

---

## 2. M1 — District Impact Engine (~2 wk)

Goal: every client facility resolves to its federal + state legislative districts; users see who
represents their footprint (both rails); an alert can generate a district-impact one-pager.

### M1.1 — Schema: facility geography columns (apps/api migration)

Extend `ClientFacility` (`schema.prisma:1678-1700`; tenant-scoped, RLS):
`latitude Float? @map("latitude")`, `longitude Float? @map("longitude")`,
`stateHouseDistrict String? @map("state_house_district") @db.VarChar(8)`,
`stateSenateDistrict String? @map("state_senate_district") @db.VarChar(8)`,
`geocodedAt DateTime? @map("geocoded_at") @db.Timestamptz(6)`,
`geocodeStatus String? @map("geocode_status") @db.VarChar(16)` (`matched|no_match|ambiguous|error`).
Keep `congressionalDistrict VarChar(2)` (bare "12"/at-large "00") — the geocoder writes it too.
New index `@@index([state, stateHouseDistrict])`, `@@index([state, stateSenateDistrict])`.
`districtSource` DTO enum (`client-facilities.controller.ts:92,139`) already permits `'geocoded'`
— no DTO change; the geocoder becomes the first real writer of it.

### M1.2 — Census Geocoder client + `geocode-facilities` verb (apps/api)

- New `apps/api/src/external/census-geocoder/census-geocoder.client.ts`: `POST` batch to
  `https://geocoding.geo.census.gov/geocoder/geographies/addressbatch` (multipart CSV
  `id,street,city,state,zip`, ≤10k rows/file), params `benchmark=Public_AR_Current`,
  `vintage=Current_Current`, `format=json`, **no key**. Parse per-row match → `{lat, lng,
congressionalDistrict (from "…Congressional Districts" BASENAME), stateHouseDistrict (from
"…- Lower" SLDU/SLDL BASENAME), stateSenateDistrict (from "…- Upper")}`. Match layer keys on
  the `- Upper`/`- Lower` **suffix**, not the year prefix (drifts with vintage). Single-address
  fallback (`/onelineaddress`) for one-off re-geocode.
- New verb `geocode-facilities` (`apps/api/scripts/geocode-facilities.ts`, sync-house-votes
  template: env caps, `runWithSyncRun`, `require.main` guard). Scans `client_facilities` where
  `geocodedAt IS NULL OR updatedAt > geocodedAt` (address changed), batches ≤10k, upserts the
  6 new columns + `districtSource='geocoded'` + `geocodeStatus`. **Idempotent** (re-run only
  touches changed/unGeocoded rows). Writes only when the resolved value differs (avoids
  churn). Cross-check: if a hand-entered `congressionalDistrict` disagrees with the geocoded
  one, keep the geocoded value but log the discrepancy (a data-quality signal for the M5 QA
  surface).
- entrypoint case + `INGESTION_JOBS` row `GeocodeFacilities` cron daily (low volume). No secret
  (keyless).
- **On facility create/edit** (`client-facilities.service.ts`): fire a single-address geocode
  inline (best-effort, non-blocking — the row saves even if geocode fails; the nightly verb
  backfills). This is the path that finally makes `districtSource='geocoded'` populate in the UI.

### M1.3 — `RepresentationResolverService` (apps/api, shared by UI + agent) — PD2

Pure deterministic service, two directions, both rails:

- `representativesForFacility(facility) → { federal: {house: CongressMember?, senate:
CongressMember[]}, state: {lower: StateLegislator?, upper: StateLegislator?} }` — joins on
  `(state, district, chamber)`.
- `facilitiesForMember(tenantId, clientId, member) → ClientFacility[]` — the inverse, for
  member profiles ("represents client facilities: …").
- Federal senate = both current senators for the facility's state (`congress_member` where
  `chamber='senate' AND state=? AND isCurrent`). Federal house = `district = Number(cd)` (at-large
  "00" → district 0/at-large member). State = `state_legislator` where `chamber='lower'|'upper'
AND state=? AND district=?` (`state_legislator.district` is a String — compare normalized).
- **At-large rule (grounded correction):** `sync-congress-members.ts:188` stores
  `district = typeof m.district === 'number' ? m.district : null`, so at-large members (WY, VT,
  DE, ND, SD, AK) are stored with `district = NULL`, **not 0** — the facility sentinel is "00".
  The House match must therefore be `district IS NULL OR district = 0` for a facility whose
  `congressionalDistrict='00'`; a naïve `Number('00')=0` join would silently return no rep for
  ~6 states. Grep the actual stored at-large values before implementing; unit-test an at-large
  facility.
- Guardrail: returns explicit `{unresolved: true, reason}` when a facility has no geocoded
  district — never a silent empty (the UI shows "district undetermined — confirm address", M1.4).
- No LLM, no network. Unit-tested against fixtures (SC below), including the at-large case.
- **Supplier addresses (parent §4 M1 "optional supplier addresses") are deferred to P2**, with
  a note: a supplier-address source (a supplier table or per-client supplier addresses) plus a
  `suppliersForMember` resolver method would route through the _same_ geocoder path when built.
  P1 ships facility footprint only; M2.4's footprint overlay therefore reads facilities, not
  suppliers (the "/suppliers" reference is struck there).

### M1.4 — UI: "who represents your footprint" (apps/web)

- **FacilitiesEditor** (`FacilitiesEditor.tsx`, `FacilityModal:232-380`): show geocode status +
  the resolved federal CD and state upper/lower districts as read-only chips beside the
  editable `congressionalDistrict`; an explicit "district undetermined" state when
  `geocodeStatus!='matched'` with a **manual fallback = text entry of the district code(s)**
  (the existing pattern — NOT a map pin-drop; no map library exists in the web app, M2.5) plus
  an optional lat/lng text-entry that re-runs the single-address geocode. Revise the
  federal-only dek (`:112-115`).
- **Client Intelligence tab — District Nexus section** (`DistrictNexusSection.tsx`): today this
  section shows federal contract _spend_ by district (place-of-performance), a different
  question. Add a **"Your representatives"** block above the spend table: per facility, the
  federal House member + 2 senators + state upper/lower legislators (from M1.3), each with
  committee roles (M2) and a link to their directory profile. New endpoint
  `GET /api/clients/:clientId/representation` (apps/api). This is the natural host per discovery.
- **Directory member modal** (`DirectoryPage.tsx` profile modal): add a "Represents client
  facilities" line/pill when the viewed member maps to any of the current client's facilities
  (via `facilitiesForMember`) — the join that "does NOT exist today" per discovery.

### M1.5 — District-impact one-pager (alert-memo variant, PD6) — both rails

New sibling under `apps/api/src/intelligence/alert-memo/`: `district-brief.service.ts` +
`district-brief-docx.js`. Reuses `AlertMemoService`'s machinery:

- `buildDistrictClaims(alert, facility, representation)` → closed numbered claims: facility name/
  city, `employeeCount`, the representing member(s) + committee role, the bill/rule at stake +
  verbatim action/notice quote, the ask. Only these are assertable.
- `SECTION_ORDER = [Facility & footprint, Who represents it, The bill/rule at stake, District
impact, The ask]`; `verifyGrounded` drops ungrounded paragraphs; `scaffold` fallback →
  `lowConfidence`; `loadSteering` (firm voice) unchanged; filed via
  `createAttachmentFromBuffer(source:'district_brief')`.
- Trigger: a "Generate district brief" action on an alert (feed `recommendedActions`, added in
  M-UI) and from the opportunity card later (P2). **Meters** `recordAiUsageEvent(workflow:
'district_brief')` — fixing the alert-memo metering gap for the new path (H-1-adjacent).

### M1 success criteria

| #    | Criterion                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | How verified                                                                                               |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| M1-A | Geocoder resolves a batch of real facility addresses to federal CD + state upper/lower in one call; layer-suffix matching survives a vintage-year change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | fixture batch + a live smoke on 20 known addresses                                                         |
| M1-B | **SC-5 (parent):** ≥95% of valid-address facilities geocode automatically (**assumption to validate week 1** — the geocoder's _structure_ was verified live, not its match _rate_ on real lobbyist facility data, which skews to military installations / industrial parks / campus addresses that geocode poorly); remainder flagged `no_match`/`ambiguous` for **manual district text-entry** (not pin-drop, M1.4); 20-sample spot-check vs official district finders shows **0 wrong-district assignments**. **Under-target contingency:** if a real-address sample lands <95%, ship with the manual-entry fallback prominent and re-scope the SC to "≥95% of _matchable_ addresses" + a tracked manual-entry rate | `geocode-facilities` batch report + spot-check log; a real-address sample run before the gate is committed |
| M1-C | Idempotency: second `geocode-facilities` run touches 0 unchanged rows                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | run-twice diff                                                                                             |
| M1-D | `RepresentationResolverService` returns correct fed House+2 senators and state upper/lower for a fixtured facility; explicit `unresolved` when no district                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | unit spec (both rails)                                                                                     |
| M1-E | Federal side improved: a facility with a wrong hand-typed `congressionalDistrict` is corrected to `'geocoded'`, discrepancy logged; Office Recommender output shifts accordingly                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | staging fixture + recommender before/after                                                                 |
| M1-F | District brief generates for BOTH a federal bill alert and a state bill alert, passes `verifyGrounded` (0 ungrounded paragraphs), files a `district_brief` Attachment, and meters an `ai_usage_events` row                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | staging click-through + SQL                                                                                |

---

## 3. M2 — Deadline Physics + Committee Chokepoint (~2 wk)

Goal: state bills alert before they die at a procedural cutoff; every priority bill (both rails)
shows who can move or kill it, overlaid with the client's footprint.

### M2.1 — `state_session` calendar hardening (apps/api)

P0 ships `state_session` with `sineDie` only (P0 §S2.2). M2 adds columns:
`crossoverDate DateTime? @db.Date`, `committeeCutoffDate DateTime? @db.Date`,
`secondCommitteeCutoffDate DateTime? @db.Date`, `convene DateTime? @db.Date`,
`calendarSource String? @map("calendar_source")` (`legiscan|ncsl|manual`),
`calendarConfidence String?` (`high|curated|estimated`). `sineDie` remains LegiScan-automated;
crossover/cutoff/convene are **NCSL manual curation**, priority states first (discovery
confirms these are not uniformly published as structured data across 50 states — the parent's
"manual curation" framing is correct). A committed seed file
`apps/api/scripts/__data__/state-session-calendars.<sessionKey>.json` per priority state +
a `load-state-calendars` verb (idempotent upsert, provenance stamped). **Explicitly scoped:**
non-priority states get `sineDie` only until curated; the deadline emitter degrades gracefully
(M2.3).

### M2.2 — Committee roster activation + normalization (both rails) — PD3, PD8 substrate

- **Federal:** activate `congress_committee_membership` (`schema.prisma:2352-2366`, currently
  written but unread) into a read path. Build `committee-crosswalk.ts`: normalize
  `congress_bill_committee.committeeName/committeeCode` → `congress_committee.systemCode`
  (name-normalization + a curated alias map for the null-code cases; log unresolved). This is
  the chain `bill → referred committee → systemCode → membership → chair (title='Chair')`.
- **State:** normalize `StateLegislator.committees Json` (`[{name, role}]`,
  `sync-openstates.ts:151`) into `state_committee_membership` rows (P0 added the thin
  `state_committee` table; M2 adds the membership rows + chair identification from `role`).
  State bill committee referral comes from the LegiScan bill payload (`state_bill` current
  committee, ingested P0) → `state_committee`.
- Both feed the new `get_committee_roster` Meri tool (M4) and the chokepoint service (M2.4).

### M2.3 — Deadline emitter + `deadline` subscriber key (intel-api) — PD5

Generalize the `check-comment-periods.ts` pattern onto tracked state bills:

- A detector step computes, per tracked state bill, days-to-next-cutoff from `state_session`
  (the soonest of crossover/cutoff/sineDie that the bill hasn't already cleared, given its
  `deriveStateBillStatus`). Emits `bill_deadline_approaching` (severity critical <3d /
  notable ≤7d / info ≤14d — same thresholds as the federal comment-period pattern) and
  `bill_dead_by_deadline` when `sineDie` passed and status non-terminal (this is the
  `dead_by_deadline` status the P0 deriver already computes — the emitter fires on that
  transition, no new derivation).
- **New subscriber key `deadline`** — predictive events don't map to the existing 9 keys
  (`tracker.types.ts`). Add to `ALERT_TRIGGERS` + `DEFAULT_TRIGGERS` + web `TRIGGER_LABELS`
  (`tracker-api.ts:221-231`) + a `backfillDefaultTriggers`-style pref backfill (the exact
  pattern #374 used for `fiscalNote`). Evidence block carries the cutoff date + type +
  survival factors (M2.4).
- **Graceful degradation:** a bill in a state with only `sineDie` curated gets sine-die
  deadline alerts but not crossover/cutoff alerts; the alert states which cutoff it's counting
  to. Never invents a date (PD5 / agentic §7).
- **Federal:** no `bill_deadline_approaching` for federal bills (PD5 — no deadline-death). The
  federal deadline surface is the existing comment-period alert (unchanged). Documented as a
  deliberate rail asymmetry.

### M2.4 — Chokepoint chain service + survival heuristic (apps/api, both rails) — PD3

`ChokepointService.forBill(billKey|billId) → { referredCommittee, chair, viceChair, rankingMember,
rulesGate?, appropriationsDependency?, chamberLeadership?, sponsor, companionStatus?, deadlineRisk,
survivalBand, footprintOverlap[] }`:

- Federal: referral via the M2.2 crosswalk → committee → chair/ranking from
  `congress_committee_membership.title`; sponsor from `congress_bill.sponsorBioguideId`;
  rule gate from `bill_rule_link` (#367); votes/whip context from `roll_call_vote`.
- State: referral from LegiScan committee → `state_committee` → chair from
  `state_committee_membership`; sponsor from `state_bill_sponsor` (primary); companion from
  `state_bill_link` (same-as); deadline from M2.1.
- **`chamberLeadership`** (parent §4 M2 lists "leadership" as a chokepoint node): Speaker /
  majority leader / rules-or-calendars chair for the bill's chamber. Populated **only when
  deterministically available** — federal from `congress_committee_membership.title` on the
  Rules committee + a curated leadership map (the S3 directory `leadershipPositions` is the
  display fallback, not the validator source); state from `state_committee_membership` chairs of
  the rules/calendars committee where identifiable. When leadership isn't deterministically
  resolvable it is **omitted, not guessed** (documented deferral of the finer leadership graph
  to P2, not a silent drop).
- **`footprintOverlap`**: for a given client, which of the chokepoint members represent a
  district containing one of the client's **facilities** — via `RepresentationResolverService`
  (M1.3). (Suppliers deferred to P2, M1.3; not referenced here.) This is the "where do I spend
  my time" fusion.
- **Survival heuristic v1 — fully specified (deterministic, transparent, not ML).** A weighted
  additive score in [0,1]; each factor contributes only when its input is present:
  - `sponsorInMajorityOrLeadership` (+0.20): sponsor's party = chamber majority, or sponsor
    holds a leadership/committee-chair role.
  - `chairIsSponsorOrCosponsor` (+0.20): the referred-committee chair sponsors/cosponsors.
  - `companionAdvancing` (+0.15): a same-as companion has cleared its first committee.
  - `committeeAdvancement` (+0.20): bill's derived status ≥ `reported`.
  - `daysToCutoff` (−0.25 if <7d and status < `reported`; +0.10 if already past the nearest
    cutoff with status ≥ `passed_chamber`).
  - Bands: **stalled** score <0.30, **at-risk** 0.30–0.60, **likely-advances** >0.60.
  - **Missing-input handling:** an unresolved committee (crosswalk miss) or an uncurated cutoff
    zeroes that factor's contribution AND downgrades the band's _confidence_ to `low` (surfaced
    on the UI); the band is never computed from a partial score presented as high-confidence.
    Weights/thresholds are v1 starting values to be calibrated against the M2-H backtest, not
    final. LegiScan has a crude prognosis number; the differentiator is deadline-aware,
    client-footprint-overlaid _alerting_ (PD5), and a transparent, auditable score.

### M2.5 — Chokepoint UI (apps/web)

Per PD/discovery, ship as a **ranked list first, not a map** (no map lib exists;
`react-simple-maps`/leaflet absent). Host: extend the **Targets tab** pattern
(`TargetsTab.tsx`) — it already fuses committee jurisdiction + tracked bills + facility-district
nexus as a ranked list. Add a per-bill "Chokepoint" view (from the bill detail drawer
`BillDrawer.tsx`, a new section): Primary target / Secondary target / Blocking risk, each with
the deterministic one-line "why" (role, district-overlap, relationship-history from
`find_path_to`), and the survival band. A map view is an explicit P2+ exploration.

### M2 success criteria

| #    | Criterion                                                                                                                                                                                                                                                                                                                                                                                              | How verified                                                 |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| M2-A | Federal committee-crosswalk resolves ≥90% of tracked-bill referrals to a `systemCode` with a chair from `congress_committee_membership`; unresolved logged. **Under-target contingency:** if <90%, the chokepoint ships for _resolved_ committees only and unresolved ones render "committee referral unmatched — chair not shown" (never a fuzzy guess); the alias map (M2.2) is expanded iteratively | crosswalk coverage query on tracked bills                    |
| M2-B | State committee roster + chair identified for priority-state committees from normalized `StateLegislator.committees`                                                                                                                                                                                                                                                                                   | SQL join-coverage on a priority state                        |
| M2-C | `bill_deadline_approaching` fires exactly once per (bill, cutoff, 14-day window) with the correct cutoff date + type in evidence; re-run → 0 dupes                                                                                                                                                                                                                                                     | staging fixture on a bill approaching a curated cutoff + SQL |
| M2-D | `bill_dead_by_deadline` fires on the sine-die transition for a non-terminal bill; a bill in a sineDie-only state still gets sine-die alerts (graceful degradation)                                                                                                                                                                                                                                     | staging fixture (curated + uncurated state)                  |
| M2-E | **SC-6 (parent), deterministic-fact half:** on a completed prior session, the `dead_by_deadline` derivation correctly classifies bills that failed to clear a cutoff before sine die ≥90% (this is largely mechanical — sineDie passed + non-terminal status — so it validates the _derivation + calendar data_, not the prediction)                                                                   | backtest script on prior-session archive                     |
| M2-H | **Survival-band accuracy (the actual moat):** on the same prior-session archive, of bills the heuristic scored **stalled** ≥X% actually died, and of **likely-advances** ≥Y% actually enacted/advanced (set X/Y at calibration from the backtest, target ≥70% each for v1); mis-bands analyzed to tune weights                                                                                         | backtest of the M2.4 survival heuristic vs actual outcomes   |
| M2-F | `deadline` subscriber key round-trips (pref backfill, label, checkbox); a subscribed pref receives the alert, an unsubscribed one does not                                                                                                                                                                                                                                                             | staging prefs + SQL                                          |
| M2-G | Chokepoint view for a real bill (both rails) names the chair, sponsor, leadership (when resolvable), and footprint-overlap members — **all deterministically resolvable** (no fuzzy-only matches); unresolved nodes render as "not shown", never guessed                                                                                                                                               | staging click-through + validator cross-check                |

---

## 4. M3 — State Rules & Agency Watch (~2.5 wk)

Goal: priority-state proposed/emergency regulations, register notices, and rulemaking dockets
land on the same LegiWatch feed as bills — and federal regs join that feed for the first time.

### M3.1 — `state_rule` truth table (apps/api, GLOBAL, mirrors `federal_register_document`)

New `StateRule` (`state_rule`, no tenant_id/RLS — source-table convention): `id String @id`
(`<state>-<register-doc-id>`), `state`, `agency`, `title @db.Text`, `abstract? @db.Text`,
`ruleType String` (`proposed|emergency|final|notice|executive_order`), `docketId? @map("docket_id")`,
`registerCitation?`, `publicationDate @db.Date`, `commentStartDate? @db.Date`,
`commentEndDate? @db.Date` (the deadline anchor), `effectiveDate? @db.Date`,
`sourceUrl @map("source_url")`, `linkedBillKeys String[] @default([])` (bill→rule successor,
populated P2), `syncedAt`. Indexes `[state, publicationDate]`, `[commentEndDate]`. Field set
deliberately mirrors `federal_register_document` (`3105-3126`) so the unified emitter (M3.3)
treats both with one code path. EOs: state EOs get `ruleType='executive_order'` (federal EOs
already live in `federal_register_document` as `PRESIDENTIAL_DOCUMENT` — no separate model, per
discovery).

### M3.2 — Register ingestion, priority states first (apps/api)

- **First M3 task = a FL-adapter feasibility spike (gate, before committing the 2.5-wk
  estimate).** Register heterogeneity is the biggest unknown in M3; the plan grep-verified
  internal code but did **not** verify any state register exposes a machine-readable feed.
  Confirm the FL FAR (Florida Administrative Register) is fetchable + parseable to the
  `StateRule` shape; only then commit the 8-state adapter roadmap and the estimate. If a state
  publishes no structured feed, that state degrades to scheduled HTML scrape or is deferred.
- New `sync-state-register` verb. **No 50-state API exists** — this is per-state adapters,
  priority states first (FL FAR, CA OAL, TX Register, NY, IL, MA, GA, VA Town Hall — the §7
  register list in the parent). Each adapter normalizes to `StateRule`. Watermark = max
  `publicationDate` per state (the `sync-federal-register` pattern,
  `sync-federal-register.ts:141`). `runWithSyncRun` (so failures alarm via the existing
  `sync-task-failures`→SNS path), entrypoint case, `INGESTION_JOBS` rows (staggered),
  out-of-band schedule.
- **Governor executive orders** (parent §4 M3 + §7 "Governor offices" as a distinct source):
  state EOs are typically **not** in agency rulemaking registers, so the FL/priority-state
  adapters add a governor-office EO-series fetch where published, normalizing to
  `StateRule(ruleType='executive_order')`. Where a governor office publishes no structured EO
  feed, EO ingestion for that state is **deferred** (the schema + emitter are ready; M3-F tests
  the emitter path via fixture, and live EO ingestion is a per-state add as feeds are found).
- Second consumer of the **federal regulations engine's patterns** (watermark, upsert-by-doc-id,
  `runWithSyncRun`) — not its code (state registers are different sources), but the same shape,
  so ops/observability are identical.

### M3.3 — Unified rule-emitter on intel-api (BOTH rails) — PD4

The federal improvement. On intel-api:

- Add `'regulation'` to `intel_alert.sourceType`. The code-at-`87ff019` enum is
  `'bill'|'hearing'|'combined'` (intel-api `schema.prisma:212`); **post-P0 (A1) the live
  baseline is `…|state_bill`**, so M3 adds a 5th value `regulation` (jurisdiction distinguishes
  federal vs state, exactly like `state_bill` vs `bill`).
- New `SourceRuleRepository` read methods in intel-api's `SourceDataRepository` (raw SQL over
  the shared DB): `getRulesByIds`, `getRuleActionsByIds` (publication/comment/effective
  transitions), `getNewRulesForTerms(terms, states)` for watchlist matching — reading
  `federal_register_document` (federal) and `state_rule` (state).
- Detector branch: watchlist terms match rule title/abstract/topics → `rule_new_match`;
  comment-period-opened → `rule_comment_open`; final-rule-published → `rule_finalized`. Evidence
  block = verbatim notice text + register/FR deep link + comment-end date. Reuses the P0-S4
  jurisdiction facet + fanOut filter (a `regulation` alert to a FL-scoped pref only if FL, etc.).
- **Federal regs now appear in the LegiWatch feed** (previously apps/api-only). The existing
  apps/api `IntelligenceChange` comment-deadline path (`check-comment-periods.ts`,
  `getCommentPeriodAlerts`) stays — it feeds the dashboard countdown chips, now with state rows
  too (M3.4). No double-notify: the intel-api rule-emitter is a _match_ alert (new/finalized);
  the apps/api path is the _deadline countdown_ chip — different surfaces, documented like the
  bill/`emit-state-changes` two-rail split (P0-DD4).

### M3.4 — Comment-deadline reuse + double-notify guard (apps/api, both rails)

Extend `check-comment-periods.ts` + `getCommentPeriodAlerts` to also scan `state_rule.commentEndDate`,
emitting `IntelligenceChange` `source='state_register'`, `changeType='comment_deadline_approaching'`
— so the dashboard `comment_deadline`/`comment_overdue` chips (which already render from the
federal path, `intelligence.service.ts:4165-4330`, `4501-4512`) gain state rows with zero UI
change. Client match reuses the `AGENCY_SECTOR_MAP` + capability-keyword approach (state agency
names added to the map for priority states).

- **Double-notify guard (PD4):** the intel-api `regulation` emitter (match/finalized alert) and
  this apps/api comment-deadline path both key off the same document. To prevent two
  notifications for one event, (a) confirm this apps/api path drives only the **dashboard
  countdown chip**, not an email/push, and (b) write a shared dedupe tuple
  `(clientId, documentId, event)` on the `IntelligenceChange.dedupeKey` that the delivery layer
  checks against `intel_notification_log`. Verified by M3-D (zero duplicate notifications on a
  document that matches both paths).

### M3.5 — Rules UI (apps/web)

- **LegiWatch feed**: `regulation` alerts render in the existing `TrackerFeedPanel` FeedCard —
  add a `SOURCE_LABEL` entry ("Regulation"), an `ACTION_ICON`, and the `srcOpts` facet
  (`TrackerFeedPanel.tsx:463-468`, currently `all|bill|hearing|combined`). One template, three
  sources.
- **Rules lifecycle rail**: reuse `RegLifecycleRail.tsx` (the federal component, exact fit per
  discovery) with state-agency stages; surface state rules in the client Intelligence tab's
  `LegislativeRegulatorySection` alongside federal FR rails (both now flow to the same section).
- **Explorer**: add a `state-rules` source (mirrors the existing `fedreg` Explorer source).

### M3 success criteria

| #    | Criterion                                                                                                                                                                                                                                                                                                | How verified                                                               |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| M3-A | `sync-state-register` ingests ≥1 priority-state register into `state_rule` with correct comment/effective dates; watermark advances                                                                                                                                                                      | row inspection + `sync_run` status                                         |
| M3-B | **SC-9 (parent):** a proposed rule matching a client watchlist produces a `regulation` `intel_alert` within 24h, with verbatim notice text + register deep link + comment-end date                                                                                                                       | staging fixture on a real register entry                                   |
| M3-C | **Federal win:** a federal `federal_register_document` matching a client watchlist now also appears in the LegiWatch feed as a `regulation` alert (previously dashboard-only)                                                                                                                            | staging: seed a matching FR doc, check the feed                            |
| M3-D | Dashboard `comment_deadline` chips include state-rule rows; **no double-notify — a document matching both the intel-api `regulation` emitter and the apps/api comment path produces exactly one user notification** (the shared dedupe tuple works)                                                      | staging: seed a both-matching doc, assert one `intel_notification_log` row |
| M3-E | State rules render in `RegLifecycleRail` in the Intelligence tab; Explorer `state-rules` source lists them                                                                                                                                                                                               | staging click-through                                                      |
| M3-F | **Emitter path:** a `StateRule(ruleType='executive_order')` fixture alerts like a rule (verifies schema + emitter). **Live EO ingestion** is validated per-state only where a governor office publishes a structured feed (FL first); states without a feed are logged as deferred, not silently missing | fixture (emitter) + per-state ingestion smoke where a feed exists          |

---

## 5. M4 — Meri as 50-state analyst (~1 wk)

Goal: Meri answers cross-jurisdiction questions with verbatim evidence, and the targeting agent
(M5) has the read tools it needs — including committee roles, which no tool exposes today.

### M4.1 — `get_committee_roster` tool (both rails) — PD8

New Meri tool (`meri-tools.service.ts` — `TOOL_DEFINITIONS` + schema + dispatch + impl +
registration spec + orchestrator catalogs, the full P0-S6 checklist): input `{committee id or
name, jurisdiction, chamber}` → `{committee, chair, viceChair, rankingMember, members[] with
side/rank}`. Federal reads `congress_committee_membership` (activated M2.2); state reads
`state_committee_membership` (M2.2). Honesty note when a roster is unavailable. This closes the
`resolve_entity` gap (committee identity only, no roles) and is the tool the M5 validator shares.

### M4.2 — State read-tool completion

Confirm/finish the P0-S6 state tools (`get_state_bill_status`, `search_state_floor_votes`,
`get_state_legislator`) if any slipped; add `get_state_rule_status` (mirrors
`get_bill_status` shape over `state_rule` + `federal_register_document` — a rule status/
lifecycle tool serving both rails). Add `get_representation` tool (wraps M1.3) so Meri can
answer "who represents my facility in TX" deterministically.

### M4.3 — Cross-jurisdiction prompts + eval

- Full-chat + workspace-gen system prompts taught the state + rules surface and the
  cross-jurisdiction pattern ("compare the data-privacy bills moving in our 8 facility states"),
  always with verbatim evidence blocks (the LegiWatch W-C discipline).
- **Eval:** extend the meriv2-evals gate with cross-jurisdiction mechanism cases: (1)
  multi-state comparison determinism; (2) `get_committee_roster` returns the DB chair, not a
  guess; and (3) **federal+state mixed** (parent §4 M4's explicit case) — "compare this federal
  bill to the analogous state bills in our facility states," each answer carrying a verbatim
  evidence block and no fabricated status. This mixed case is the concrete federal application
  of M4. The pinned died-at-crossover state eval (SC-4) already landed in P0-S6; M4 adds these
  three. **CI note:** the meriv2-evals workflow must trigger on `packages/shared/**` + the new
  tool paths (the P0-S6 fix; confirm it's in place).

### M4 success criteria

| #    | Criterion                                                                                                                                                                                                          | How verified                              |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------- |
| M4-A | `get_committee_roster` returns the DB chair (title='Chair') for a federal committee and a priority-state committee; honesty note when absent                                                                       | tool behavior spec (fake-prisma pattern)  |
| M4-B | Registration spec green at the new tool count; orchestrator catalog coverage spec green                                                                                                                            | local jest (api) + CI jest (orchestrator) |
| M4-C | A cross-jurisdiction full-chat question returns per-state answers each with a verbatim evidence block; no fabricated status                                                                                        | staging transcript                        |
| M4-D | The meriv2-evals gate runs on a `packages/shared/**`-only PR and includes the roster + multi-state cases                                                                                                           | CI check on the M4 PR                     |
| M4-E | **Federal+state mixed eval (parent §4 M4):** a "compare this federal bill to the analogous state bills in our facility states" case is green in the gate — each side cites verbatim evidence, no fabricated status | meriv2-evals gate                         |

---

## 6. M5 — Agentic Tier-2 worker: targeting-brief + rules-comparison (~2–2.5 wk)

Goal: the first production Tier-2 agentic workflows, per the agentic architecture doc §10 P1.

### M5.0 — Prerequisites gate (build only what P0-agentic didn't) — A2

Before any mode ships, confirm and, if missing, build (all per the agentic doc, both rails):

- **`ai_run` table** (§5.1) — model on `ProgramElementIngestRun` (`schema.prisma:2805`);
  columns per the agentic doc (workflow, rail, subjectType/Key, tenantId?, promptVersion,
  model/provider/usedTenantKey, inputRefs/toolCalls/output Json, confidence, validationStatus,
  qaStatus, humanReviewedBy/At, status, durationMs). Global rows for tenant-agnostic runs; RLS
  on tenant rows.
- **`GroundedJson` helper** (§5.3) in `@capiro/meriv2-core` — schema-instructed prompt + zod
  validation + one bounded retry + deterministic fallback + citation check.
- **Deterministic validator gate** (§5.4) — for targeting, the checks are: every named member
  resolves via `RepresentationResolverService`/`get_committee_roster` (M1/M2), every role claim
  matches `congress_committee_membership`/`state_committee_membership`, every district claim
  matches a geocoded facility. Fail → drop that claim; underlying alert unaffected (fail-open).
- **H-1 metering gaps** — close the three (`run-clio-scheduled-tasks`, orchestrator loops,
  alert-memo) so agent volume is metered from the start (`recordAiUsageEvent`).
- **`recordAiUsageEvent` tenant-agnostic path** — today it writes via `withTenant` only
  (`ai-usage-record.ts:41`), so a cached-L1 (tenant-null) run can't meter. Add a system-scoped
  (`withSystem`/RLS-bypass) write path, and **specify how null-tenant rows behave**: they carry
  `tenant_id = NULL`, are **excluded from per-tenant usage/billing reports**
  (`ai-usage.service.ts` filters them out), and bucket into a platform-cost rollup; the
  `ai_usage_events` RLS policy is amended to permit a system-principal null-tenant insert.
  Without this, a tenant-agnostic L1 run either fails the RLS insert or produces unattributed
  rows. (Tier-2 targeting/rules runs are tenant-scoped and meter normally; only cached-L1
  enrichment is tenant-null.)

### M5.1 — `run-intel-workflows` worker (extends the P0.5 worker, or builds it — A4)

- **If P0.5 shipped the minimal `run-intel-workflows`** (amendment-diff / Change Analyst mode,
  A4), M5.1 **extends** it to the full mode registry; **if it slipped**, M5.1 builds the minimal
  worker first, then extends. Either way the verb `run-intel-workflows`
  (`apps/api/scripts/run-intel-workflows.ts`) runs as an ECS one-off on the EventBridge
  out-of-band pattern, **staggered after the derive chain** (so status/deadline/chokepoint truth
  is fresh). Generalizes `run-clio-scheduled-tasks.ts:93-200`: bounded loop (MAX_ROUNDS),
  per-task/per-tenant `TenantContext` (RLS-scoped reads, the `:249-275` pattern),
  `aiCreds.resolveProvider` (BYOK-first), a **read-only allowlist per mode** extending
  `DEFAULT_SCHEDULED_TOOL_ALLOWLIST` + honoring `FORBIDDEN_SCHEDULED_TOOLS`.
- **Full mode registry after M5** = amendment-diff (P0.5) + targeting-brief (M5.2) +
  rules-comparison assist (M5.3). (Naming: "assist" per the agentic §10 wording, not a §4.3
  role-mode; the §4.3 fiscal/opportunity/obligation/successor/campaign/graph modes are P2.)
- **Polls both prisma realms** (apps/api owns truth tables; reads `intel_*` under `withSystem`,
  the blessed cross-realm read precedent). Triggers: qualifying events since last run
  (new material bill/rule events on tracked items in priority states).
- Writes through **its own deterministic writers** into `ai_run` + the surfacing targets (M5.4)
  — never gated write tools (PD7).
- **Failure alarm (liveness, not just accounting):** the worker wraps its run in
  `runWithSyncRun('run-intel-workflows')` so a crash/error routes to the existing
  `sync-task-failures`→SNS `capiro-dev-alerts` path — `ai_run`/`ai_usage_events` are accounting
  rows, not liveness signals. A silently-erroring agent run must page.

### M5.2 — Targeting-brief mode (M2 chokepoints + M1 districts) — the P1 agentic headline

For each priority tracked bill with a material event, the agent produces a brief: primary/
secondary/blocking targets with evidence (role, district-overlap, relationship history via
`find_path_to`), and a recommended sequence — **decision support, never executed** (agentic
§4.3). Tools: `get_bill_status`/`get_state_bill_status`, `search_floor_votes`/state analog,
`get_committee_roster` (M4.1), `get_representation` (M4.2), `resolve_entity`, `find_path_to`.
**Every named member/role/district is re-validated deterministically (M5.0 validator) before the
brief attaches** — this is the mechanical satisfaction of the P1 exit criterion. Federal briefs
use the #367 truth layer + `congress_committee_membership`; same worker, same validator.

### M5.3 — Rules-comparison assist (M3)

For a new state rule linked to (or matching the same watchlist as) a tracked bill, the agent
drafts a short "how this rule relates / what changed vs the statute or the prior notice"
assist, grounded on the verbatim rule text + bill evidence, `GroundedJson` + validator-gated.
Federal application: same assist for a `federal_register_document` implementing a tracked
federal bill (the bill→rule link that M3 now surfaces in one feed).

### M5.4 — Surfacing (no new chat-bound artifact) — grounded in discovery

Discovery ruled out `ClioArtifact` (chat-bound, `conversationId` NOT NULL) and confirmed the
board filters `intel_alert` strictly by `sourceType`. Both surfacing targets are **intel-api-owned
tables** (`intel_alert` schema.prisma:208, `intel_action_item` :354) written from the apps/api
worker — so this is **two blessed cross-realm writes**, both acknowledged and reviewed (§11):

- **`intel_alert.evidence.enrichment`** on the triggering alert (the agentic doc's blessed
  apps/api `withSystem` cross-realm write) — renders inline in the LegiWatch FeedCard's expanded
  body (`TrackerFeedPanel.tsx`), visually distinct as "Analysis" vs the verbatim "From the
  record" block (agentic §3 fact/inference/recommendation separation).
- A **pending action item** row in `intel_action_item` of a new kind `targeting_brief`.
  **Written via a raw `withSystem` insert from apps/api** (the worker **cannot** call the
  intel-api `action-item.service.ts` — that service is in the other app), tenant-scoped by an
  explicit `tenant_id` bind matching the table's RLS; the new `kind='targeting_brief'` value is
  added to the intel-api enum in the same migration. "Generate district one-pager" (M1.5) hangs
  off this item.
- **Never** the Meri inbox (`clio_proactive_alerts`) for these — that's the scheduled-research
  surface; LegiWatch briefs belong on the LegiWatch feed.
  Each carries full `ai_run` provenance + a QA/confidence status. **Interim QA gating (the M-QA
  review surface is a P2 build, not this phase):** high-materiality briefs are written with
  `ai_run.qaStatus='pending'` and are **NOT rendered client-facing** until a human clears them via
  the P0.5 source-quality dashboard (the analyst-console seed); if that dashboard isn't available,
  pending-QA briefs stay in `ai_run` unrendered rather than blocking on an unbuilt surface. Only
  `qaStatus ∈ {approved, approved_with_warning}` briefs render.

### M5 success criteria

| #    | Criterion                                                                                                                                                                                                                                                                                                                                                    | How verified                                                             |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| M5-A | Prerequisites: `ai_run` writes on every agent run; `GroundedJson` validates+retries+falls back; H-1 gaps closed (3 sites meter); tenant-agnostic meter path works                                                                                                                                                                                            | unit + a metered staging run                                             |
| M5-B | **Agentic P1 exit:** a targeting brief on a real bill (both rails) names **only** members whose roles/districts the deterministic validator confirms; a seeded hallucinated member is dropped and logged                                                                                                                                                     | staging fixture with an injected bad member + `ai_run` inspection        |
| M5-C | The brief attaches to `intel_alert.evidence.enrichment` and a `targeting_brief` `intel_action_item` (both via raw `withSystem` from apps/api, RLS-scoped); renders in the feed with fact/inference/recommendation visually separated; is NOT written to `clio_proactive_alerts`; a `qaStatus='pending'` high-materiality brief does NOT render until cleared | staging click-through + SQL (incl. a pending-QA brief that stays hidden) |
| M5-D | Rules-comparison assist grounds every claim on rule/bill evidence (0 fabrications on the eval corpus); fail-open proven (revoke key → alert still delivers)                                                                                                                                                                                                  | eval + staging                                                           |
| M5-E | Worker is unattended-safe: no gated write tool is ever invocable (allowlist + FORBIDDEN enforced); a write attempt is rejected pre-execution                                                                                                                                                                                                                 | spec on the allowlist guard                                              |
| M5-F | Every M5 run writes `ai_usage_events` (metered) and an `ai_run` row with validationStatus/qaStatus                                                                                                                                                                                                                                                           | SQL                                                                      |
| M5-G | Worker liveness: a forced worker error routes to `sync-task-failures`→SNS (via `runWithSyncRun`) — a silent agent failure pages, not just under-writes `ai_run`                                                                                                                                                                                              | staging: inject a fault, confirm the alarm fires                         |

---

## 7. Test plan & gates (cross-cutting)

- **Gates per PR** (lint is broken repo-wide — never `pnpm lint`): `pnpm turbo run typecheck`,
  `pnpm exec prettier --check` (CI-enforced for MeriV2 paths only, `ci-pr.yml:41-46`; local
  elsewhere), jest for touched packages. apps/api + apps/intel-api suites run locally (no
  CI Postgres); meriv2-core/orchestrator/auth + the eval gate run in CI.
- **New spec inventory:** census-geocoder parse (fixture batch incl. a vintage-year drift +
  a no-match), `geocode-facilities` idempotency, `RepresentationResolverService` (both rails,
  unresolved case), district-brief `verifyGrounded`, committee-crosswalk coverage, chokepoint
  service (both rails), deadline-emitter fire-once + graceful degradation + dead-by-deadline
  backtest, `deadline` pref backfill, `state_rule` ingestion, unified rule-emitter (federal +
  state, fanOut jurisdiction), comment-deadline state extension, `get_committee_roster` behavior
  - registration, cross-jurisdiction eval, `GroundedJson`, validator gate (drops bad member),
    `run-intel-workflows` allowlist guard, `ai_run` write. Freeze real fixtures: 1 FL + 1 TX bill,
    1 federal bill, 1 FL rule, under `apps/api/scripts/__fixtures__/`.
- **PR slicing** (each independently deployable, no dark-code): PR-M1a schema+geocoder+resolver
  → PR-M1b who-represents UI + district brief → PR-M2a calendars+roster crosswalk → PR-M2b
  deadline emitter+key → PR-M2c chokepoint service+UI → PR-M3a `state_rule`+ingestion →
  PR-M3b unified rule-emitter (federal+state) → PR-M3c rules UI+comment-deadline → PR-M4
  tools+eval → PR-M5.0 agentic prereqs → PR-M5a worker+targeting → PR-M5b rules-comparison+
  surfacing. Adversarial review on PR-M2a (the chokepoint chain — the one place a wrong claim is
  client-facing) and PR-M5a (the agent).

---

## 8. Rollout runbook (prod, ordered; each step has a rollback)

1. **M1 schema + geocoder**: migrate (Aurora snapshot pre-migrate; additive columns safe) →
   roll api → run `geocode-facilities` for all facilities (keyless, cheap). Verify M1-B.
   _Rollback:_ columns are additive/no-op; `districtSource` reverts to prior on re-edit.
2. **M1 UI + district brief**: roll web + api. Verify M1-D/E/F on capiro-internal.
3. **M2 calendars**: `load-state-calendars` for priority states (committed seed) → verify
   `state_session` rows. _Rollback:_ truncate the added columns' data (reference data).
4. **M2 roster crosswalk**: run committee normalization (federal + priority states) → verify
   M2-A/B. _Rollback:_ the crosswalk is a read-time service + a cache table; drop the cache.
5. **M2 deadline emitter**: intel-api migrate (add `deadline` key handling) → roll intel-api →
   pref backfill → **feed-first** (email-dark) verify M2-C/D/F; then flip email per the P0-DD9
   staged pattern. _Rollback:_ disable the emitter step; revert `LEGIWATCH_EMIT_SOURCE_TYPES`.
6. **M2 chokepoint UI**: roll web. Verify M2-G.
7. **M3 `state_rule` + ingestion**: migrate → roll api → `sync-state-register` for FL first →
   verify M3-A. Backfill remaining priority states. _Rollback:_ truncate `state_rule`.
8. **M3 unified rule-emitter**: intel-api migrate (add `'regulation'` sourceType) → roll
   intel-api → feed-first verify M3-B/C (federal + state), then email. _Rollback:_ remove
   `'regulation'` from the emit source types (feed degrades, no outage).
9. **M3 comment-deadline + UI**: roll api + web → verify M3-D/E/F.
10. **M4 tools + eval**: merge (eval gate must go green on the PR) → roll api + orchestrator.
11. **M5.0 prereqs**: migrate `ai_run` → roll api. Verify metering.
12. **M5 worker**: register `run-intel-workflows` schedule (out-of-band) staggered after the
    derive chain; **shadow first** (writes `ai_run`, does not attach to alerts) → canary
    capiro-internal → verify M5-B (validator drops the injected bad member) → attach on. Flip
    per-mode kill-switches. _Rollback:_ disable the schedule; enrichment is additive.
13. **Exit review**: parent SC-5/SC-6/SC-9 + the agentic P1 exit signed off; quota/cost review
    on the geocoder (free) and agent token spend (metered) → feeds P2 planning.

---

## 9. Success-criteria roll-up

Phase 1 exit = **all** M1–M5 workstream SCs green **plus** the parent + agentic phase-level
criteria they map to:

- **Parent SC-5** (district engine, ≥95% geocode, 0 wrong-district) ← **M1-B**.
- **Parent SC-6** (deadline physics ≥90% backtest) ← **M2-E** (the deterministic
  `dead_by_deadline` derivation) **+ M2-H** (the survival-band accuracy backtest — the actual
  predictive moat, which M2-E alone does not validate).
- **Parent SC-9** (rules watch, `state_rule` alert ≤24h w/ verbatim notice + register link) ←
  **M3-B**.
- **Agentic P1 exit** (targeting brief names only deterministically-validated members/roles/
  districts) ← **M5-B**, resting on M1-D (resolver) + M2-A/B/G (chokepoint chain) + M4-A (roster
  tool) + M5-A (validator gate).
- **Federal-tracker improvements delivered** (the "applies to federal" mandate): geocoded
  district accuracy (M1-E), chokepoint map on the #367 truth layer (M2-G federal), and federal
  regs unified into the LegiWatch feed for the first time (M3-C).

## 10. Decisions for Ninja (D-P1-1 … D-P1-5)

| #      | Decision                                                                                              | Recommendation                                                                                    |
| ------ | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| D-P1-1 | NCSL calendar curation ownership — who maintains crossover/cutoff dates per priority state            | Assign an analyst; committed seed files + `load-state-calendars`; start with the 8 Ballard states |
| D-P1-2 | Register-adapter build order for M3 (which priority state first)                                      | FL first (Ballard home + a clean FAR feed), then CA/TX; the rest as adapters are written          |
| D-P1-3 | Confirm agentic P0 foundations status (A2) — are `ai_run`/GroundedJson/validator/Tier-1/H-1 shipped?  | If not, M5.0 builds them in P1 (already scoped); confirm so effort is booked to the right phase   |
| D-P1-4 | Chokepoint surface: ranked list (recommended) vs a map exploration                                    | Ship the ranked list in the Targets/bill-drawer pattern; map is a P2+ spike                       |
| D-P1-5 | Federal regs into the LegiWatch feed (PD4) — ship the federal unification in P1, or state-only first? | Ship both — the emitter is one code path; the federal win is nearly free and closes a real split  |

## 11. Risks

- **Census Geocoder match rate / address quality** — mitigation: M1-B's ≥95% target with an
  explicit manual-pin-drop remainder; `geocodeStatus` surfaces failures rather than guessing.
- **Committee-crosswalk gaps** (null `committeeCode`) — mitigation: curated alias map + logged
  unresolved + the S3 directory as display fallback; the validator only _confirms_ deterministic
  matches (an unresolved committee simply isn't asserted as a chokepoint).
- **NCSL calendar staleness** — mitigation: priority-states-only, `calendarConfidence` stamped,
  graceful degradation (sine-die-only states still alert); annual curation task.
- **`state_rule` register heterogeneity** — mitigation: per-state adapters, priority-first,
  same watermark/ops shape as federal so failures alarm identically.
- **Agentic prerequisite slippage** (A2/D-P1-3) — if P0-agentic didn't ship the foundations,
  M5 absorbs ~1 wk; sequence M5.0 before M5.1 and don't start M5 until confirmed.
- **Double-notify federal regs** (M3 adds them to LegiWatch while the dashboard chip persists) —
  mitigation is a **mechanism, not an assertion** (M3.4): a shared `(clientId, documentId,
event)` dedupe key + the apps/api comment path confirmed countdown-chip-only (no
  notification); M3-D proves exactly one notification for a both-matching document.
- **Cross-realm writes from the M5 worker** — there are **two** (both apps/api → intel-api-owned
  tables): `intel_alert.evidence.enrichment` and `intel_action_item` (kind `targeting_brief`),
  both raw `withSystem` inserts (the worker can't call intel-api services), tenant-scoped to the
  table RLS. These are the **only** blessed apps/api→intel-api writes; intel-api never writes
  apps/api tables (its read-only invariant is unchanged). Reviewed on PR-M5b; the enum add +
  RLS bind are in the M5 intel-api migration.
