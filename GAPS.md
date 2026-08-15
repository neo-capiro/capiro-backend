# GAPS — Portfolio module backend audit

Backend gaps found while building the Portfolio module against the live backend
(`PORTFOLIO-HANDOFF` §12, `FOUNDATION-HANDOFF` §10). Each entry was confirmed by
reading the server controller/service — not inferred. Sorted **blocking-first**.

**Scope note:** the module ships inside `apps/web/src/vnext/` (runtime-gated to
the vNext surface). No new backend was written; every screen reads an endpoint
that already exists (see `docs/handoff/portfolio-api-inventory.md`). The gaps
below are the surfaces where the design asks for data no endpoint yet provides.

## Summary

| id | module | surface | blocking | backend surface | owner |
| --- | --- | --- | --- | --- | --- |
| G2 | Portfolio index | Program elements — cross-client aggregation + net portfolio delta | No (per-PE figures render; attribution + net delta show unavailable) | 1 aggregate endpoint joining watched PEs to clients | unassigned |
| G3 | Portfolio index | Per-row attention / readiness / next-touch without N+1 | No (columns render `—` rather than per-client fan-out) | 1 portfolio-scoped aggregate | unassigned |
| G1 | Portfolio index | Pulse band `meetingsThisWeek` + `activeStrategies` in the summary response | No (UI composes both from existing tenant-wide endpoints) | extend `intelligence/portfolio-summary` | unassigned |

---

### G1 — Pulse band aggregate fields are composed from existing endpoints

- **Module / surface:** Portfolio index → Portfolio pulse band (§7.1 band 2).
- **What the UI needs:** clients · need attention · active strategies · meetings
  this week · tracked bills, plus a refreshed-at stamp.
- **What exists:** `GET /api/intelligence/portfolio-summary` returns
  `{ activeClients, needAttention, ldaSpendQtd, billsTracked, activeRegulations }`
  (`intelligence.controller.ts:362`, `intelligence.service.ts:6677
  getPortfolioSummary`). It covers clients, need-attention and tracked bills.
- **What's missing from the summary endpoint:** `activeStrategies` (lives in
  `api-strategy`, tenant-scoped but not included in the summary) and
  `meetingsThisWeek` (lives in `engagement/meetings`, not included in the
  portfolio summary).
- **Evidence of absence:** read `getPortfolioSummary` end to end — it queries
  `client`, `clientIntelMapping`, `lda_filing`, `congress_bill`,
  `federalRegisterDocument` only; no strategy or meeting table is touched.
- **Shipped instead:** the pulse band reads the authoritative tenant-wide
  `GET /strategy-api/strategies` list and the current-week
  `GET /api/engagement/meetings` window to fill those two slots. No per-client
  fan-out is used. A single aggregate endpoint remains desirable for one
  consistent refresh boundary, but the prototype's five slots now render.
- **Blocking?** No.
- **Estimated backend surface:** extend `getPortfolioSummary` with two counts
  (join `api-strategy` strategies by tenant; count `engagement/meetings` in the
  current ISO week). No migration.
- **Owner:** unassigned

### G2 — Program elements are not aggregated across clients

- **Module / surface:** Portfolio index → Program elements band (§7.1.2).
- **What the UI needs:** each card shows the PE code, program name, the
  PB → Auth → Approp progression, a per-card delta chip, **a client-attribution
  footer**, and the section header shows a **net portfolio delta** summed across
  clients.
- **What exists:** `GET /api/program-elements?watched=true` returns per-PE
  budget figures (`latestRequest`, `latestEnacted`, `latestCurrent`, `deltaPct`,
  stage claims) — everything the per-PE card needs. This is the same source the
  client-level "Relevant budget programs" card uses.
- **What's missing:** a join from watched PEs to the clients they fund, and a
  summed net delta across the portfolio. The watch list is per-PE; no
  client-attribution or portfolio-aggregate endpoint exists.
- **Evidence of absence:** `programs.controller.ts` exposes list / match-queue /
  alias / merge routes only; `PortfolioProgramElementsSection.tsx` (the existing
  canonical widget) reads the watch list and per-PE action counts, with no
  cross-client aggregate. Greped `apps/api/src` for a portfolio-level PE
  aggregate — none.
- **Shipped instead:** the cards render the real per-PE PB → Auth → Approp
  progression and delta chip. The footer explicitly says client attribution is
  unavailable, and the header renders `— net`; neither value is invented (a
  missing figure renders `—`, never `$0`, per §7.1.2).
- **Blocking?** No.
- **Estimated backend surface:** 1 endpoint joining watched PEs to clients
  through the existing relevance mapping, plus a summed delta.
- **Owner:** unassigned

### G3 — Per-row attention / readiness / next-touch would need N+1 calls

- **Module / surface:** Portfolio index → Clients table, Work / Intelligence /
  Attention / Next-touch columns (§7.1 band 3).
- **What the UI needs:** per-client strategy count + readiness, tracked-bill and
  funding-match counts, an open-attention count, and the next scheduled
  client-facing event — for every row.
- **What exists:** each value has a per-client endpoint
  (`/strategy-api/strategies`, `/api/intelligence/clients/:id/health-score`,
  `/api/funding-opportunities/clients/:id/opportunities/summary`,
  `/api/engagement/meetings`). None has a portfolio-scoped, all-clients form.
- **What's missing:** a single portfolio-scoped aggregate returning those four
  columns keyed by client. Assembling them per row is the N+1 the handoff
  explicitly forbids ("ship the list without that column rather than firing
  eight requests per page load", §7.1).
- **Evidence of absence:** the named controllers expose only `:clientId`-scoped
  routes; no `…/portfolio` or tenant-wide variant. Verified in
  `intelligence.controller.ts`, `funding-opportunities.controller.ts`,
  `engagement.controller.ts`, `api-strategy/strategy.controller.ts`.
- **Shipped instead:** the table preserves the prototype's Work / Intelligence /
  Attention / Next-touch columns, but renders `—` in those cells because no
  portfolio rollup exists. It does not fire per-client requests. The Attention
  sort falls back to name so the control never lies.
- **Blocking?** No.
- **Estimated backend surface:** 1 aggregate endpoint (e.g.
  `GET /api/intelligence/portfolio/client-rollup`) returning the four columns
  per client in one query.
- **Owner:** unassigned

---

## Explicitly checked and NOT gaps

- **Import with LDA (§7.1.1).** The full propose → review → explicit-apply
  contract exists: `GET /api/firm/lda-registrants`, `GET /api/firm/import-candidates`,
  `POST /api/firm/import` (`firm-onboarding.controller.ts:43/59/64`,
  `user_admin`-gated apply). The handoff flagged this as "almost certainly needs
  work" — it does not.
- **Legacy deep links (§6.1).** All eight legacy `?tab=` values resolve and are
  covered by `client-crm-routing.test.ts`.
- **Work ⇄ Strategies node writes (§7.7).** `PATCH
  /strategy-api/strategies/:id/nodes/:nodeId` exists
  (`api-strategy/strategy.controller.ts:72`); the Work tab is a projection with
  no CRM-side task store.

---
---

# GAPS — Directory module backend audit

Backend gaps found while building the Directory module against the live backend
(`DIRECTORY-HANDOFF` §11, `FOUNDATION-HANDOFF` §10). Each entry was confirmed by
reading the server controller/service — not inferred. See
`docs/handoff/directory-api-inventory.md` for the full endpoint map. Sorted
**blocking-first** (the Committee-hierarchy gaps gate Phase C).

## Directory summary

| id | surface | blocking | backend surface | owner |
| --- | --- | --- | --- | --- |
| DIR-1 | Committee hierarchy — unit → staff placement | Phase C canvas (roster unaffected) | placement model (staff → subcommittee-unit) | unassigned |
| DIR-2 | Committee hierarchy — `working_relationship` edges | Phase C canvas (dashed edge) | edge table (structure / working_relationship) | unassigned |
| DIR-3 | Committee hierarchy — vacancies | Phase C canvas (muted nodes) | unfilled-seat record | unassigned |
| DIR-8 | Congressional Staff — `role` + `committee` filter params | No (honest-state note ships) | extend `/api/directory/staffers` query | unassigned |
| DIR-4 | Congressional Staff — normalized `roleFamily` | No (Role filter passes through) | server role-family field | unassigned |
| DIR-6 | Department of War — org-chart reference | No (field absent) | persist orgChartRef | unassigned |

### DIR-1 — Committee unit → staff placement is not modeled

- **Module / surface:** Committee Staff · Hierarchy (§7.2), tier 3–4 (units →
  staff people).
- **What the UI needs:** each staff person placed under the specific
  subcommittee / office unit the source assigns them to.
- **What exists:** staff are attached to a **committee office**, not to a unit
  within it (`directory.service.ts` builds `committeeStaff: Map<committeeId,
  staffer[]>`). Subcommittees exist via `parentOfficeId`
  (`CommitteeDetail.subcommittees[]`), but no row ties a staffer to a
  subcommittee — only to the parent committee.
- **What's missing:** a placement record `personId · unitId · role · current ·
  sourceRef`.
- **Evidence of absence:** `DirectoryCommitteeStaffer.committee` carries only
  the parent committee `{id,name,chamber,kind}`; no `unitId`/`subcommitteeId`
  field. `buildCommitteeLeadershipMap` covers leadership, not staff placement.
- **Shipped instead:** the hierarchy renders the tiers the source backs
  (committee → leadership → subcommittee units). Staff render under their
  committee, grouped at the committee level; per-unit staff grouping is omitted,
  never synthesized. The Roster view is unaffected (it needs no placement).
- **Blocking?** Only the per-unit staff tier of the Phase C canvas.
- **Estimated backend surface:** placement join table / query deriving staff →
  subcommittee from the source snapshot.

### DIR-2 — No edge table (structure vs working_relationship)

- **Module / surface:** Committee Staff · Hierarchy (§7.2), the dashed
  `BIPARTISAN LEADERSHIP` edge and every solid structure edge.
- **What the UI needs:** an explicit `edge: from · to · kind(structure |
  working_relationship) · sourceRef` so no edge is drawn without source backing
  (non-negotiable #5).
- **What exists:** nothing. No edge model anywhere in `directory.service.ts`.
  Committee ↔ subcommittee is the only derivable structural relation
  (`parentOfficeId`); Chair ↔ Ranking Member is co-membership of a leadership
  map, not a stated working relationship.
- **What's missing:** the edge table + its `kind` discriminator.
- **Shipped instead:** solid structure edges are drawn only where
  `parentOfficeId` states a parent (committee → subcommittee). The dashed
  bipartisan/working-relationship edge **ships disabled, not faked** — the
  legend entry renders with a "not source-backed" note.
- **Blocking?** Only the dashed-edge affordance on the Phase C canvas.

### DIR-3 — Committee vacancies are not records

- **Module / surface:** Committee Staff · Hierarchy (§7.2), the muted
  `UNFILLED / PENDING ASSIGNMENT` nodes.
- **What the UI needs:** a vacancy record `unitId · roleLabel · state(unfilled |
  pending_assignment)` with **no** `personId` and no profile route.
- **What exists:** nothing — an unfilled seat exists only as an absence of a
  staff row, which the UI must not turn into a node.
- **Shipped instead:** no vacancy nodes render. The legend's muted entry is
  annotated as not source-backed. A vacancy never enters the roster or any
  person count.
- **Blocking?** Only the muted-node affordance on the Phase C canvas.

### DIR-8 — Congressional staffers endpoint lacks `role` + `committee` params

- **Module / surface:** Congressional Staff (§7.1), the Role and Committee
  filter pills.
- **What the UI needs:** `role` and `committee` query params on
  `GET /api/directory/staffers`, applied server-side so the record count is
  truthful.
- **What exists:** the endpoint accepts `q, chamber, state[], issue[], page,
  pageSize` only (`directory.controller.ts#staffers`). The committee **contacts**
  endpoint (`/api/directory/committees/:id/contacts`) does accept `role`, but
  the staffers list does not.
- **Shipped instead:** the two pills render an honest "not filterable yet" state
  (search matches role/committee text via `q`) rather than filtering only the
  page in hand and reporting a wrong count. **Neo has ruled both params should
  be added server-side** — this is the tracked gap.
- **Blocking?** No — the honest state ships until the params land.

### DIR-4 — No normalized `roleFamily` on congressional staff

- **Module / surface:** Congressional Staff (§7.1), the Role filter family.
- **What exists:** a free-text `title` plus `roles[]` strings per staffer; no
  normalized role-family enum.
- **Shipped instead:** the Role filter is not derived from free-text title
  client-side (a §7.1 "must not"). When DIR-8 lands the `role` param passes the
  source value through. A normalized family is a server addition.
- **Blocking?** No.

### DIR-6 — Acquisition org-chart reference is not persisted

- **Module / surface:** Department of War profile (§7.7), the "Organization
  chart reference" side card.
- **What exists:** `AcquisitionPersonnelDetail` carries `organization` and
  `programOfRecord`, plus `sources[]` per-mention provenance — but no
  directory-section/page org-chart pointer.
- **Shipped instead:** the field is absent from the profile (not defaulted).
  Provenance (first/last seen, confidence, sources) renders in full.
- **Blocking?** No.

## Directory — explicitly checked and NOT gaps

- **State-legislator unknown-vs-zero (DIR-7, §14 Q3): RESOLVED server-side.**
  `billCount`/`enactedCount` are `null` (never crosswalked, `legiscanPeopleId`
  null) vs a real number/`0`; `sponsoredBills` is `null` (unknown) vs `[]`
  (linked, sponsors nothing). The tri-state survives the API boundary — no
  client-side `?? 0` anywhere.
- **DoW PE-first sort:** server-supported via `sort:'pe_first'` on
  `/api/acquisition-personnel`. Provenance triple (firstSeenAt / lastSeenAt /
  confidence) is persisted on both list rows and detail.
- **Committee leadership context (§14 Q1, partial):** Chair / Ranking Member /
  Vice Chair ARE source-backed (member `committees[].position` →
  `buildCommitteeLeadershipMap`). Only unit→staff placement (DIR-1) is absent.
- **Canonical staff identity:** committee staff and congressional staff resolve
  to the same staff id (`/directory/staff/:staffId`), satisfying non-negotiable
  #3 with no duplicate person record.

---

# GAPS — Program Elements vNext module backend audit

Backend gaps found while wiring the Program Elements vNext surface
(`PROGRAM-ELEMENTS-HANDOFF` §13) against the live backend. The module **reuses**
the proven `pages/program-element/v2/` components (already wired to these
endpoints); it ships inside `apps/web/src/vnext/pages/program-elements/`,
runtime-gated to the vNext surface (`os.capiro.ai`). No new backend was written.
Each entry confirmed by reading the server controller/service/DTO — not inferred.
Sorted **blocking-first**. Full endpoint table: `docs/handoff/` PE inventory
(discovery report, 2026-08-12).

**Milestone-01 scope note:** this ship is the vNext **chrome + route + token
re-skin** (handoff §12 milestone 01). The reused v2 component bodies carry the
content. The entries below are where that inherited content diverges from the
handoff §1/§5 domain rules — they are content-fidelity gaps for milestone 02+,
NOT regressions introduced by this ship (the canonical app renders the same
bodies today).

## Program Elements summary

| id | surface | gap | blocking | backend surface | owner |
| --- | --- | --- | --- | --- | --- |
| PE-G6 | Profile trust strip / Sources / inspector | Reconciliation-conflict read model per line has **no server producer** — `openReconciliationConflictCount` is declared client-side but zero API code sets it, so every conflict surface silently renders "no conflicts" | **Yes** (trust surfaces always clear) | read join from `ReconciliationReviewQueue` into the PE detail DTO | unassigned |
| PE-G4 | Profile header "Current" + Explore "Current·stage" | Shared `FUNDING_CURRENT_PRECEDENCE` includes authorization marks (`sasc`/`hasc`) as `current` rungs — violates §1.5/§5.2 (auth never sets `current`; appropriations-only ladder) | **Yes** (domain rule) — inherited from v2, not a vNext regression | appropriations-only `currentFunding` variant in `@capiro/shared` (shared — needs sign-off) | unassigned |
| PE-G1 | Explore | `movement` filter is client-side over the current 50-row page → counts/footer/CSV wrong under that filter | Yes for Movement-filtered export/counts | add `movement` to `QueryProgramElementsDto` + list service | unassigned |
| PE-G5 | Explore / Portfolio client exposure | Only relevance-score rows; no verified/saved/candidate association-state axis (§1.11) | Yes for exposure-count semantics | association-state on `client-pe-relevance` read | unassigned |
| PE-G3 | Movement tape | feed item lacks event date, track, from→to, per-event materiality (fields exist on `BudgetAction`, unmapped) | Partial — tape "date+stage", track strip, materiality chip unbacked | map `createdAt`/`baseline`/`evidenceJson` into `/budget-lines/movement` feed | unassigned |
| PE-G11 | Watch toggle parallel-safety | watch mutation invalidates legacy keys only, NOT `pe-v2-*` keys → v2/vNext lists go stale on toggle (§3.3) | No (correctness/staleness) | extend `useWatchToggle` invalidation set to `pe-v2-*` keys | unassigned |
| PE-G3b | Actions "Create action" | no manual action-create endpoint; `POST /actions/generate` only; `/actions?peCode=` deep link unconsumed by ActionBoardPage | Partial — governed create path differs from mock | manual create endpoint + peCode param consumption | unassigned |
| PE-G12 | Source ledger CSV | `/sources` is JSON-only; all CSV is client Blob builds | No (client CSV is today's contract) | optional `text/csv` producer | unassigned |

## Program Elements — explicitly checked and NOT gaps

- **§13 #2 NOT FILED vs 0 — NOT a gap.** Unfiled = `null` end-to-end: nullable
  `Decimal?` columns (`schema.prisma:3813-3828`); `numDec` null-preserving
  (`read.service.ts:1015`); client `toNum` keeps null; renderers emit
  NOT FILED/NOT ENACTED (`pe-v2-model.ts:144-170`). No `0`-for-unfiled path.
- **§13 #10 Relationship state stored — NOT a gap.** `BudgetLineRelationship.status`
  ('accepted'/'candidate') + `confidence` are stored columns (`schema:8836-8837`),
  returned by `/relationships`; `/programs` splits accepted vs candidate server-side.
- **§13 #14 Bills/vehicles per PE — NOT a gap.** `/bills` + `/bill-actions` live.
- **§13 #8 Data-issue readback — endpoint exists.** `GET :peCode/data-issues` +
  status enum exist (`controller.ts:473`); client fetcher defined (`api.ts:246`) but
  **no caller in apps/web** — unwired, not absent. Data-issue create never patches PE
  values (resolution requires admin reconciliation path, `schema:4305`).
- **§13 #9 R-2A not-ingested signal — mostly fine.** `/projects` returns full R-2A
  rows w/ page cites; `projectCount` on detail; profile renders explicit "Not yet
  ingested" when `years` empty. Empty+count is the signal (no explicit boolean).
- **§13 #11 Watch ownership — per-user.** `(tenant_id,user_id,pe_code)` + audit.
  Divergence: markup-monitor watched set is tenant-wide (`read.service.ts:568-572`)
  while Portfolio "monitored" is per-user — Congressional ≠ Portfolio "monitored".

**Not reached before the discovery iteration cap (verify in milestone 02):**
DataIssueModal field wiring (DTO confirmed compatible), the five tab components'
internal queries (all consume the verified profile hook), gap §13 #7
(promotion-blocked signal to memo/brief artifacts), §15 open questions
(materiality constant scope, snapshot activator, QA-states dev flag).
