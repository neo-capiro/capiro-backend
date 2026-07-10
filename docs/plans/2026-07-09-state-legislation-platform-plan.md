# Capiro State Legislation Platform — Comprehensive Build Plan

**Date:** 2026-07-09 · **Trigger:** state is at the "we can search it" stage — two thin global
tables, a throttled OpenStates sync, one Meri tool, and a Data Explorer page. No change
detection on real legislative events, no client association, no money layer, no UI.
**Scope:** (1) the basics — everything required to _serve_ a state client (alerts, association,
entity depth, UI, freshness), and (2) the moats — the four spaces verified open in the
2026-07 competitive sweep, each built as a second consumer of an engine Capiro already shipped
for federal. **File anchors verified against this branch (post-#374, `87ff019`).**
**Rev 2 (2026-07-09):** revised after an external market review and the decision that
**Ballard Partners is the anchor design partner** (D4 resolved). Changes: state
regulations/agency watch pulled into Phase 1, new Phase 0.5 (practice completeness), Phase 2
reframed around a Policy Opportunity Engine + Implementation Obligation Engine, Phase 3
reframed around the Influence Graph + Government Decision Timeline, local government
explicitly parked (P4, demand-gated), moat claims narrowed for sales use, priority states
re-weighted for Ballard. Phase 0 detail: `docs/plans/2026-07-09-state-phase0-implementation-plan.md`.
**Rev 3 (2026-07-09):** agentic intelligence layer added —
`docs/plans/2026-07-09-agentic-intelligence-architecture.md`: event-to-action workflows over
**both rails** (federal LegiWatch + state), on the rule _deterministic software establishes
truth; agents interpret, connect, prioritize, and draft_. Four analyst roles across three
execution tiers (in-rail enrichment = LegiWatch W-D generalized; bounded unattended runs =
the scheduled-agent-runner pattern; interactive = MeriV2), with automation levels, validator
gates, provenance (`ai_run`), and per-phase agentic scope P0→P3.

---

## 0. Thesis & competitive ground truth

**What is commodity (do not build a pitch on it).** Verified 2026-07-09: similar-bill /
model-bill detection ships today in BillTrack50, Plural, and FastDemocracy. Live state
hearing transcription with mention alerts ships in USLege, FastDemocracy TranscriptAI, and
Quorum State. AI bill summaries/comparisons are table stakes (FiscalNote PolicyNote). 50-state
tracking with keyword alerts is a knife fight with five funded incumbents (FiscalNote/State Net,
Quorum, Plural, BillTrack50, FastDemocracy). Vendor links in §12.

**What came back open in the sweep (the moats).** "Nobody does X" below means _none found in
the 2026-07-09 sweep of the major vendors' public materials_ (§12) — not a market-wide proof.
Re-verify against vendor demos / design-partner intel before these claims drive pricing or
positioning (ties to D4/D5):

1. **No major national GA platform structures state money.** No incumbent offers
   client-aware, cross-state structured budget line-item + fiscal-note alerts tied to bills,
   facilities, and work product. (Narrowed per Rev 2: single-state precedents exist — Utah's
   line-item budget visualization, InstaTrac's Massachusetts line-item/earmark comparisons —
   so the claim is "no national client-aware engine," not "nobody anywhere.") This is PE
   Watch's muscle, unexported.
2. **Nobody connects federal ↔ state.** Incumbents run the two as parallel feeds. None can say
   "this NDAA provision / grant program / preemption threat creates obligations in your 12
   states" — because none of them have Capiro's federal depth to anchor one end of the link.
3. **No software product works pre-introduction.** Interim committee charges, sunset reviews,
   governor budgets, prefiles — the 6-month window where bills are actually shaped. (Narrowed:
   MultiState-style _services_ and contract lobbyists watch this window as labor; the open
   space is software that connects pre-intro signals to client footprint and generated work
   product.)
4. **Nobody closes the loop into work product.** Alert → verbatim evidence → client memo in
   firm voice → outreach, in one chain. We already have every link for federal.

Two adjacent claims to keep narrow in sales material: **district matching is commodity**
(FiscalNote/VoterVoice sell address-to-district; Geocodio returns SLDU/SLDL from addresses) —
Capiro's wedge is facility/supplier/jobs footprint + bill impact + committee chokepoint +
generated member-specific ask, not the lookup. And **passage prediction is gestured at**
(Plural's momentum indicator, State Net forecasting) — the wedge is deadline-aware,
client-specific survival _alerting_ on procedural calendars, not a score.

**Positioning:** don't sell "state bill tracking." Sell _"your state practice runs on the same
money-grounded, client-contextual intelligence engine as your federal practice."_ The product
truth: the lobbyist gets the alert with the verbatim quote, the dollar impact, the district
math, and a drafted memo — before the client calls. Name v1 honestly: **"Capiro State: a
client-contextual state bill + money-intelligence engine for federal-first firms"** — not yet
"the complete state policy operating system." Incumbents (FiscalNote/State Net) sell a wider
universe (regulations, notices, executive orders, local ordinances); the Rev-2 P1
regulations workstream starts closing that gap deliberately, priority-states-first.

**Beachhead (Rev 2 — Ballard-anchored):** Ballard Partners is the anchor design partner.
Their model is strategic advocacy — federal + high-value state capitals (FL home base, CA,
IL, MA, NY, TX, GA) — not municipal compliance or grassroots blast. That confirms the
original call: sell the state practice of federal-first firms, skip Quorum's multistate
corporate-compliance turf AND VoterVoice-style grassroots tooling. Market a per-state
freshness SLA; batched-cycle staleness is the incumbent weakness lobbyists actually complain
about. For Ballard's industries (healthcare, insurance, gaming, energy), **regulations often
matter more than bills** — the reason the agency/rules watch moved up to Phase 1.

---

## 1. Current state (grounded baseline)

- **Ingestion:** `apps/api/scripts/sync-openstates.ts` — OpenStates v3, `PER_PAGE=20` (API hard
  max), `MAX_PAGES=5` → ≤100 bills/state/resource/run, `BATCH_SIZE=10` states/run cycled by
  day-of-month (`sync-openstates.ts:16-29`), bills filtered to `updated_since` 30 days, first
  sponsor only, no actions/votes/versions/committees fetched.
- **Schema:** two thin GLOBAL tables, no tenant_id (correct — reference data), no truth layer:
  `StateBill` (`apps/api/prisma/schema.prisma:3656-3675`) = identifier/title/chamber/
  classification/subjects/sponsorName/sponsorParty/latestActionDate/latestActionText/url/
  syncedAt. **No status, no statusAt, no actions, no sponsors table, no votes, no versions.**
  `StateLegislator` (`schema.prisma:3677-3694`) = name/state/chamber/district/party/email/
  image/url/committees Json/active. No id crosswalk, no district geometry linkage.
- **Read surface:** `search_state_bills` Meri tool — impl `apps/api/src/meri/meri-tools.service.ts:2824`
  (schema :621, dispatch :1273), delegated in meriv2 via
  `apps/meriv2-orchestrator/src/meri/full-chat-read-tools.catalog.ts:48`. Plus Data Explorer.
- **"Alerting" today:** the coarse changes-inbox rail only. `apps/api/scripts/emit-changes.ts:72-78`
  counts `state_bill` rows by **`synced_at`** (line 76) → one `intelligence_change` count row per
  day. It fires on re-sync, not on legislative events. The fine per-bill LegiWatch rail
  (`apps/intel-api`) is congress-only.
- **Association:** none. `tracked_bill` (`schema.prisma:3181`) and the intel-api watchlist
  compiler target `congress_bill` only. (`client-association.service.ts` is the _engagement→client_
  matcher — meetings/mail — not a federal-entity path; its `state.gov` entry at ~L65 is just a
  generic-domain exclusion.)
- **UI:** state touches ~3 web files (Data Explorer); federal bills/PE touch 64.

**Gap list (from the 2026-07-09 audit) → where each is closed in this plan:**

| #   | Gap                                                          | Closed by                                                                                              |
| --- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| 1   | No real change-detection/alerting on state bills             | Phase 0 · S4                                                                                           |
| 2   | No client → state-entity association                         | Phase 0 · S5                                                                                           |
| 3   | No PE/spend/lobbying analog (bare bill metadata)             | Phase 0 · S2 (entity depth) + Phase 2 (money); state lobbying disclosure = O3 Influence Graph (§6, D9) |
| 4   | Legislator model a stub; no district↔facility linkage        | Phase 0 · S2 + Phase 1 · M1                                                                            |
| 5   | UI asymmetry (no detail panel / client section / watch page) | Phase 0 · S7                                                                                           |
| 6   | Coverage/freshness SLA (weekly cycling, ~100-bill cap)       | Phase 0 · S1                                                                                           |

---

## 2. Architecture principle: every state feature is a second consumer

The last month of federal work was accidentally the state platform. The plan's core bet is that
we extend engines, not build new ones:

| Federal engine (shipped)                                   | Anchor                                                                                                                             | State consumer                                                                          |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Canonical bill status `deriveBillStatus` + `BillStatus`    | `packages/shared/src/index.ts:990-1031`                                                                                            | `deriveStateBillStatus` + `StateBillStatus` (S3)                                        |
| LegiWatch emitter rail (8 emitters, idempotent delivery)   | `apps/intel-api/src/tracker/bill-change-detector.service.ts`, `change-detector.util.ts`                                            | state source branch (S4)                                                                |
| Delivery already source-parameterized                      | `LEGIWATCH_EMIT_SOURCE_TYPES` (`intel-alert.service.ts:226`), feed `?sourceType=` filter                                           | add `state_bill` (S4)                                                                   |
| Tracked-bill source column (dormant)                       | `intel_tracked_bill.source 'congress'\|'state'` (`intel-api/prisma/schema.prisma:146`)                                             | activate (S4/S5)                                                                        |
| Watchlist topics/terms + `issueAreaForSector`              | `apps/intel-api/src/tracker/tracker-watchlist.service.ts`, `watchlist/watchlist-compiler.ts`                                       | compile against state corpus (S5)                                                       |
| Verbatim evidence block                                    | `intel_alert.evidence.actionText` (`bill-change-detector.service.ts:517-533`), `MaterialEvent` (`change-detector.util.ts:238-248`) | same contract, state action text (S4)                                                   |
| Entity crosswalk + `resolve_entity`                        | `EntityCrosswalk` (`schema.prisma:2373`), `meri-tools.service.ts:2281`, `CANONICAL_ID_TYPES` (`shared:658`)                        | `state_legislator`/`state_bill` id types (S2/S6)                                        |
| PE funding lifecycle precedence + SQL generators           | `packages/shared/src/index.ts:1105-1262` (`FundingStage`, `pickFunding`, `fundingCurrentCoalesceSql`)                              | state budget line-item lifecycle (Phase 2)                                              |
| PE Watch derive DAG + quarantine + doc-parse tooling       | `run-pe-derive-chain.ts`, `scripts/__tools__`                                                                                      | fiscal-note extraction (Phase 2)                                                        |
| EventBridge ingestion matrix + out-of-band runbook         | `infra/cdk/lib/ingestion-schedule.ts`, `docs/runbooks/out-of-band-ingestion-deploy.md`                                             | new state sync rows (S1)                                                                |
| Alert-actions memo drafting + Workspace doc-gen + Outreach | shipped 2026-07-02 / workspace                                                                                                     | state memos, district one-pagers (M1/M4)                                                |
| Meri tool registry ×2 + eval gate                          | `TOOL_DEFINITIONS` (`meri-tools.service.ts:70`), meriv2 delegated catalogs, `meriv2-evals`                                         | state tools + pinned state eval (S6/M4)                                                 |
| Grounded LLM enrichment + unattended agent runner          | LegiWatch W-D (`/api/internal/alert-enrichment` spec), `run-clio-scheduled-tasks` (bounded read-only loop, prod since 2026-06)     | Tier-1/Tier-2 agentic layer, both rails (Rev 3 — agentic-intelligence architecture doc) |

**Data strategy (the S1 decision that unlocks everything):**

- **LegiScan becomes the bill spine.** Its Pull API is built for exactly our problem:
  `getMasterListRaw(state)` returns _every bill in a session with a `change_hash`_ in one call —
  diff hashes, then `getBill` only the changed ones (bill payload includes **actions (history),
  sponsors, roll-call votes with per-member records, texts/versions, committee, calendar
  events, `sasts` same-as/companion links, and supplements — which include fiscal notes**
  (supplement type 1) where states publish them. Free tier = 30k queries/mo (verified against
  the API manual); the paid **Push API** upgrades priority states to 15-minute push when
  revenue justifies. Quota-budget arithmetic and the mandatory bulk-dataset backfill are in S1.
- **OpenStates stays for people/geo.** Legislator profiles, committee memberships, and the
  `people.geo` point-lookup endpoint. Bills from OpenStates become a cross-check, not the spine.
- **Direct state scrapers = tier 3, priority states only,** and only where LegiScan lags
  (e.g. same-day committee substitute texts).
- **Census Geocoder** (free, batch): facility address → lat/lng + SLDU/SLDL district codes in
  one call (Phase 1 · M1).

**Tenancy/SOC 2:** state truth tables stay GLOBAL (same posture as `congress_bill`); all
tenant-scoped state (subscriptions, tracked bills, alerts, associations) lives in existing
RLS'd tables. Public data; no new classification burden.

---

## 3. Phase 0 — Substrate: the basics (~3–4 wk)

Everything a real state client needs on day one. Exit = a state client sees their bills in the
Intel tab, Needs Attention, and the changes inbox, with evidence-quoted alerts, fresh within
the SLA.

### S1 — Ingestion: LegiScan spine + freshness SLA (~4 d)

- **Backfill first, then diff.** One-time `backfill-legiscan-dataset`: seed every state/session
  from LegiScan's weekly bulk dataset ZIPs (no per-bill API cost). Without this, the first
  masterlist walk marks ~100k in-session bills as "changed" and draining them via `getBill`
  burns months of quota before steady state. The same path is the quota-exhaustion fallback.
- New verbs: `sync-legiscan-masterlist` (`getMasterListRaw` hash-diff per state; hourly for
  priority states, 6h for the rest), `sync-legiscan-bills` (drain the changed-bill queue:
  actions, sponsors, votes with per-member records, texts, `sasts` companion links,
  supplements), `sync-openstates` reduced to people/committees.
- **Quota budget — an assumption to validate in week 1:** masterlists ≈ 11k/mo
  (8 states hourly ≈ 5.8k + 43 every 6h ≈ 5.2k), leaving ~19k `getBill` calls ≈ 600 changed
  bills/day nationally. Peak season (Jan–Apr, most legislatures in session) will plausibly
  exceed that ceiling. Mitigations: weekly bulk-dataset refresh for non-priority states in
  peak months, and/or early Push/commercial upgrade (D1; push delivers changes every
  15 min–4 h per subscribed state).
- `LEGISCAN_API_KEY` secret; per-state cursor + hash cache table (`state_sync_cursor`).
- Schedule rows in `INGESTION_JOBS` (`infra/cdk/lib/ingestion-schedule.ts`) + live rules via
  the out-of-band runbook (`docs/runbooks/out-of-band-ingestion-deploy.md` — the Compute CFN
  stack is still wedged; do NOT `cdk deploy`, see [[infra_cdk_taskdef_drift]]).
- **Telemetry — measure ingestion lag, not legislative activity:** stamp `firstSeenAt` on each
  `state_bill_action`; expose `(firstSeenAt − action.date)` percentiles + last-successful-sync
  age per state in `diag-ingestion-health`. (Naive `max(action.date) − now` would read quiet or
  out-of-session states as permanent SLA breaches.) This is the marketed SLA number.

### S2 — Schema: the state truth layer (~4 d, parallel with S1)

Mirror the federal Workstream-A shapes (all in `apps/api/prisma`, GLOBAL):

- **Re-key `state_bill` to a canonical natural key** `"<state>-<session>-<billnumber>"`
  (e.g. `tx-89-hb1234`), matching the federal `119-hr-8800` convention. Store `openstatesId`
  and `legiscanBillId` as columns + `entity_crosswalk` rows (`idType='openstates_bill'|
'legiscan_bill'`). Migration mechanic: the key is derivable in place (state/session/
  identifier all exist today, `schema.prisma:3658-3660`), but since the table is thin,
  rebuildable reference data with no inbound FKs, the clean path is wipe-and-resync via the
  S1 backfill. The two read paths (`search_state_bills`, Data Explorer) must tolerate the
  cutover window. Cheap now, never again.
- `state_bill` additions: `status`, `statusAt`, `statusSource`, `textDate`, `abstract`.
- New tables:
  - `state_bill_action` (billKey, date, actionText, chamber, classification[], orderKey) —
    mirrors `congress_bill_action`.
  - `state_bill_sponsor` (billKey, legislatorId?, name, party, type primary|cosponsor, date,
    withdrawn) — mirrors `congress_bill_cosponsor`.
  - `state_roll_call_vote` (billKey, chamber, date, motion, yeas/nays/nv/absent, result,
    legiscanRollCallId) + `state_member_vote` (rollCallId, legislatorId, vote) — mirrors
    `roll_call_vote`/`member_vote` from PR #367.
  - `state_bill_version` (billKey, versionType introduced|committee_sub|engrossed|enrolled,
    date, url) — **metadata only in P0** (the text-changed emitter anchors on a date
    watermark, not content; text blobs land with P2's diff work — implementation plan DD7).
  - `state_session` (state, sessionKey, name, convene, sineDie, special; procedural-calendar
    fields — crossover, committee cutoff — filled progressively, priority states first).
  - `state_committee` (state, chamber, name, legiscanCommitteeId) — normalize
    `StateLegislator.committees` Json into rosters in Phase 1.
- `entity_crosswalk`: `idType='openstates_person'|'legiscan_people'`,
  `entityType='state_legislator'`; add `state_legislator`/`state_bill` to the
  `CANONICAL_ID_TYPES` vocabulary (`packages/shared/src/index.ts:658`).

### S3 — Canonical status: `deriveStateBillStatus` (@capiro/shared) (~2 d)

Second consumer of the PR-#367 pattern, one abstraction up. `StateBillStatus =
introduced | committee | reported | floor | passed_chamber | resolving |
to_governor | enacted | vetoed | veto_overridden | failed | dead_by_deadline` (12; crossover
is the `passed_chamber` _event_, not a distinct status — the deadline machinery uses the
crossover _date_). Inputs:
LegiScan's own status codes (1–6: Introduced/Engrossed/Enrolled/Passed/Vetoed/Failed) +
progress events + action-classification arrays, with action-text regex as fallback only —
the exact inverse of the 4-copy regex bug we just killed federally. New verb
`derive-state-bill-status` chained after S1 syncs. `dead_by_deadline` computes from
`state_session` calendars (heuristic in P0, hardened in M2).

### S4 — State alerts through the LegiWatch rail (~5 d)

The critical seam findings (verified at `87ff019`): `sourceType:'bill'` is hardcoded at
`bill-change-detector.service.ts:485/:507`, `new-match-detector.service.ts:149`,
`parity.service.ts:76`, `tracker-board.service.ts:306/:415`, and
`bill-hearing-linker.service.ts:221` — the estimate covers the board/parity/linker paths, not
just the detector; all reads go through the congress-only `SourceDataRepository`
(`apps/intel-api/src/sourcedata/source-data.repository.ts:27-91`); `intel_tracked_bill.source`
exists but is ignored; delivery + feed already accept new source types with no code change.
(Emitter naming below = the LegiWatch event-coverage plan's Workstream-B inventory,
`docs/plans/2026-07-09-legiwatch-event-coverage-plan.md`.)

- Add `StateSourceDataRepository` (state_bill/actions/votes/sponsors reads shaped like
  `SourceBill` etc.), branch `runDetectionCycle` on `intel_tracked_bill.source`, write alerts
  with `sourceType:'state_bill'`; add `state_bill` to `LEGIWATCH_EMIT_SOURCE_TYPES`.
- **Emitter parity from day one, except `fiscalNote` (Phase 2)** — the anchors now exist
  because of S2/S3: status-transition (floor/passed/enacted/vetoed/failed, incl.
  `dead_by_deadline` — a state-only event federal doesn't have), text/version changed, hearing
  scheduled (LegiScan calendar events), vote tally with per-member breakdown, sponsor
  momentum, new match, **and companion** — LegiScan's `sasts` (same-as) data makes cross-chamber
  companion detection tractable, lighting up the `companion` subscriber key that is still
  emitter-less even federally. Reuse the existing 9 subscriber keys
  (`apps/api/src/tracker/tracker.types.ts:13-23`) — **no pref migration in Phase 0** (Phase 1
  adds `deadline`, Phase 2 adds `familySpread`; see M2/$6).
- **Evidence block mandatory**: `evidence.actionText` = verbatim state action text +
  state-site deep link, same `MaterialEvent` contract. Rides the Workstream-C email template
  work already planned for federal (one template, two sources).
- **Jurisdiction facet**: add `jurisdictions String[]` to `intel_alert_preference` and
  watchlist scoping (`@default([])` — empty preserves today's behavior exactly: watchlists
  stay federal-only until states are opted in; prefs with empty = all jurisdictions the
  client's watchlist produces; implementation plan DD5). Today prefs are trigger-key-only
  with no geography concept — this is the one genuinely new subscription concept in the plan.
- Retire the misleading coarse signal: drop `state_bill` from `emit-changes.ts:72-78`
  (synced_at counts) once per-bill state alerts are live.

### S5 — Client ↔ state association (~3 d)

- Activate `intel_tracked_bill.source='state'` for explicit tracking (tracker UI gains a
  jurisdiction picker).
- Extend the watchlist compiler to run topics/terms + `issueAreaForSector` against the state
  corpus, prefiltered by client geography: `client_facilities.state` (`schema.prisma:1685`)
  ∪ explicit watchlist jurisdictions. Same fit-score floor, same `newMatch` emitter.
- Needs-Attention/changes-inbox chips read the same `intel_alert` rows — no new plumbing
  (feed controller already filters by `sourceType`).

### S6 — Meri: state tools + resolve_entity (~2 d)

- Upgrade `search_state_bills` (real corpus now: status, sponsors, actions); add
  `get_state_bill_status`, `search_state_floor_votes`, `get_state_legislator` — registered in
  `TOOL_DEFINITIONS` + both meriv2 delegated catalogs (specs:
  `meri-tools.registration.spec.ts`, `full-chat-read-tools.catalog.spec.ts`).
- `resolve_entity` learns `state_legislator` + `state_bill` (crosswalk-backed, state-scoped
  name disambiguation — the federal ambiguity bugs from #367 pre-solved).
- **Author the pinned state eval here (SC-4):** a real bill that died at crossover with
  misleading final action text — the state twin of the H.R. 8800 pin — into the meriv2-evals
  gate alongside `get_state_bill_status`.

### S7 — UI surfaces (~5 d)

- **LegiWatch**: jurisdiction scope (Federal | \<state\> | All) on the 4-tab shell; state bills
  in the same swimlanes.
- **State bill detail panel**: reuse the federal panel shell — status ladder (S3), action
  timeline, sponsors, votes with tallies, versions, "track for client."
- **Client profile**: state section in the Intel tab (matched + tracked state bills, state
  reps for the client's facilities once M1 lands).
- **Data Explorer** stays as-is.

**Phase 0 exit criteria:** SC-1, SC-2, SC-3, SC-4 (§8). Full workstream detail, per-section
success criteria, and the rollout runbook: `docs/plans/2026-07-09-state-phase0-implementation-plan.md`.

### Phase 0.5 — State practice completeness (~2–3 wk, immediately after P0; Rev 2)

Small-to-medium adds that make the daily state-GR workflow credible before the P1 hero bets
(the external review's strongest process point — adopted):

- **First-class amendments**: `state_bill_amendment` (LegiScan `getBill` carries an
  `amendments[]` array with adopted/failed flags — confirm exact fields against a fixture in
  week 1) + adopted/not-adopted emitter riding the `amendment` trigger key. State practice
  turns on committee substitutes and floor amendments _before_ they become the next version;
  fiscal notes are frequently revised on amendment (NCSL). Feeds P2's kill-switch radar.
- **Hearing agendas + witness/testimony metadata, priority states** (moved up from P3-O3):
  TX witness lists, FL appearance records — agenda + who-testified-for-whom metadata only;
  stream transcription stays counsel-gated (D6). The wedge is hearing-to-client impact
  ("your facility's rep sits on this committee; this witness attacked your language"), not
  raw transcription (USLege/Quorum already sell that).
- **Client bill positions + ownership**: `position` (support/oppose/monitor/amend), `tier`,
  `owner`, `nextAction` on `intel_tracked_bill` + board UI. The smallest slice of the "State
  Workroom" concept; the full workroom (testimony files, call sheets, coalition status)
  remains the P3 campaign console.
- **People-data enrichment decision**: committee clerks/schedulers/chiefs/district offices are
  what state lobbyists actually need; OpenStates doesn't carry them. Priority-state
  committee-staff scraping + a buy-vs-scrape decision on commercial contact data (new D8).
- **Source-quality & confidence dashboard**: per-state freshness, parse confidence, crosswalk
  coverage, quarantine counts — internal first (the analyst-console seed; StateScape/MultiState
  sell "analyst-reviewed" as trust; our answer is provenance + QA status on every high-risk alert).

---

## 4. Phase 1 — First moats (~5–7 wk; Rev 2: regulations pulled in, contagion moved to P2)

The demo that makes a state GR shop gasp. Order within the phase: M1 → M2 → M3 → M4.
Full workstream detail, per-section success criteria, the agentic Tier-2 build (M5), and the
rollout runbook: `docs/plans/2026-07-09-state-phase1-implementation-plan.md`.

### M1 — District Impact Engine (~1.5 wk)

- `client_facilities` gains `lat/lng` + `stateSenateDistrict`/`stateHouseDistrict`
  (Census Geocoder batch: address → point + SLDU/SLDL in one call; `districtSource` extended).
- "Who represents your footprint": facility → state reps (+ committee roles) on the client
  profile; member detail shows "represents client facilities: X".
- **District impact one-pager**: a Workspace doc type — facility, jobs (`employeeCount`),
  the member, the bill, the ask — generated from the alert-actions memo machinery, in firm
  voice. This is the defense-lobbying playbook applied to states; no state tool maps client
  economic footprint to legislative targeting.
- Optional supplier addresses per client (same geocode path) for second-degree targeting.

### M2 — Deadline physics + committee chokepoint map (~1.5 wk)

- Harden `state_session` procedural calendars for priority states (NCSL session tables +
  chamber rules; a maintenance task, not a scrape — this tedium IS the moat).
- New emitter: `bill_deadline_approaching` ("dies in N days unless it clears X") and
  `bill_dead_by_deadline`. **New subscriber key `deadline`** (predictive events don't map to
  the existing 9): `ALERT_TRIGGERS` + `DEFAULT_TRIGGERS` + web trigger labels + a
  `backfillDefaultTriggers`-style pref backfill, same as #374 did for `fiscalNote`. Survival
  heuristic v1: sponsor-in-majority/leadership, committee chair sponsorship, companion
  presence, days-to-cutoff. LegiScan has a crude prognosis number; nobody does deadline-aware
  _alerting_.
- **Chokepoint map (Rev 2, adopted):** per priority bill, render who can actually move or
  kill it — committee chair/vice, rules/calendars gate, appropriations subcommittee,
  leadership, sponsor relationship, companion status, deadline risk — overlaid with which
  client facilities/suppliers sit in those members' districts (M1 data). This is "bill
  status" upgraded to "where do I spend my time," and it's cheap once rosters + districts
  exist.

### M3 — State Rules & Agency Watch (~2 wk; Rev 2 — moved up from Phase 3)

The external review's biggest structural point, and right for Ballard's book (healthcare,
insurance, gaming, energy — industries where **regulations matter more than bills**, and
where policy risk lands _after_ enactment, in agencies):

- Priority-state coverage of: proposed + emergency regulations, register notices, rulemaking
  dockets, governor executive orders. Second consumer of the **federal regulations engine**
  (fedreg ingestion + watermark machinery already in prod) — same pattern: per-state register
  feeds where they exist, scrape where they don't, priority states first.
- New source type on the alert rail: `state_rule` (watchlist terms match notice/docket text;
  same evidence-block contract, verbatim notice quote + register deep link).
- Comment-deadline tracking reuses the existing federal comment-deadline taxonomy (the
  dashboard already renders `comment_deadline` chips).
- Bill→rule successor watches (auto-create a docket watch when a tracked bill grants
  rulemaking authority) land in P2 with the Implementation Obligation Engine — this
  workstream builds the docket substrate they attach to.

### M4 — Meri as the 50-state analyst (~1 wk)

- Full-chat + workspace-gen prompts taught the state surface; cross-jurisdiction questions
  ("compare the data-privacy bills moving in our 8 facility states") answered with verbatim
  evidence blocks.
- Extend the eval suite with cross-jurisdiction cases (multi-state comparison, federal+state
  mixed questions). The SC-4 pin itself lands earlier, in S6.

---

## 5. Phase 2 — The money layer → Policy Opportunity Engine (~8–10 wk, priority states first)

The headline moat. No national platform structures state money client-aware (§0, narrowed);
PE Watch is the only codebase that has already solved this class of problem (heterogeneous
budget documents → lifecycle-staged line items → change alerts). **Rev 2 reframe:** the line
items, fiscal notes, and diffs are the substrate; the _product_ is the Policy Opportunity
Engine ($4) — "here's where revenue is going to move," not "a bill changed."

### $1 — State Budget Line-Item Watch (~3–4 wk)

- `state_budget_line_item` (state, session, budgetBillKey, agency, program, lineCode, purpose
  text, amounts per stage) with a **shared lifecycle precedence** modeled exactly like
  `FundingStage` (`shared:1105-1262`): `enrolled → conference → senate_sub → senate_committee →
house_sub → house_committee → introduced → governor_proposed`, with `pickFunding`-style
  helpers + SQL COALESCE generators so no consumer ever re-derives "current."
- Extraction: budget-bill versions (S2 already stores them) → line-item parse per state
  format (start TX/VA — structured-ish; then CA/FL/OH/AL/GA/PA), LLM-assisted with the PE
  Watch quarantine pattern (parse → validate → quarantine on low confidence → derive).
- Emitters: line-item appeared / changed / struck between versions — "your $4M rider survived
  House Approps but was struck in the Senate committee substitute." The PE Watch swimlane UI
  ports directly.
- **Stretch — earmark/rider attribution:** who inserted it, who defended it, who struck it,
  which district benefits (amendment-sponsor linkage via P0.5's `state_bill_amendment`;
  InstaTrac's Massachusetts earmark-by-legislator reporting is the single-state proof it's
  possible).

### $2 — Fiscal-note intelligence (~1.5 wk)

- LegiScan **supplements** already deliver fiscal-note documents for most states that publish
  them — no 50-site scrape. `state_fiscal_note` (billKey, agency, date, url, extracted
  {costByYear, fundsAffected, localImpact}, quarantine fields); LLM extraction, PE-derive-chain
  style.
- Lights up the existing `fiscalNote` subscriber key for state (the federal fiscal-note
  emitter shape, swapping `cbo_cost_estimate` for `state_fiscal_note`). "Every bill with
  > $10M impact in your states" becomes a watchlist primitive.

### $3 — Semantic version diff + amendment kill-switch radar (~1.5 wk)

- On `state_bill_version`/`state_bill_amendment` transitions: aligned-section diff + LLM
  change summary with verbatim before/after quotes ("committee substitute changed the rate
  from 2% to 3.5% and exempted co-ops"). Attached to the `amendment`/text-changed alert
  evidence. Feeds $1 (budget bills are just the biggest version-diff case) and $6 (family drift).
- **Kill-switch radar (Rev 2, adopted):** clause-level watch primitives — definitions,
  exemptions, preemption language, procurement eligibility, tax-credit percentages, match
  requirements, effective dates, retroactivity, "subject to appropriation" traps. Catches the
  moment a friendly bill becomes dangerous; this is a _watch target type_ on the diff output,
  not a new pipeline.

### $4 — Policy Opportunity Engine (~2 wk; Rev 2 — the phase's product face)

Synthesis layer over $1/$2/$5 + M1 + the federal graph. For a material money event, emit an
**opportunity card**, not a change notice: program size, affected client facilities/districts
(M1), rulemaking due dates ($5), grant/procurement windows, federal funding interaction (the
first increment of the federal↔state transmission graph — federal funds → state
implementation link — moves up from P3 to serve this), recommended outreach targets (M2
chokepoints), one-click memo/one-pager (Workspace). "HB 123 creates a $450M grant program
affecting 18 client facilities; agency rules due in 120 days; IIJA match; here are the three
members who control it."

### $5 — Implementation Obligation Engine (~2 wk; Rev 2, adopted)

From enrolled/chaptered text, extract the obligations clients actually ask about after
passage: rulemaking mandates + deadlines, reporting requirements, grant/application windows,
new procurement authority, compliance dates, sunset dates, penalties. LLM extraction with the
PE-Watch quarantine pattern; each extracted obligation auto-creates the matching successor
watch (agency docket via M3's substrate, date-based reminders via the deadline rail).
Closes the loop the review called out: clients don't ask "did it pass," they ask "what do we
do now, who owns it, by when." Code-impact/effective-date extraction (State Net "Code
Navigator" territory) starts here as amended-section + effective-date fields on the same
extraction pass.

### $6 — Contagion early warning (~1.5 wk; moved from P1 — Rev 2 ranked regs above it for Ballard)

- Bill-family clustering: MinHash/SimHash over bill texts (fetched for diffing in $3; pure TS,
  no vector infra for v1), threshold-clustered into `state_bill_family`; LLM confirm pass on
  borderline pairs runs on the **platform key, fail-open** — family clustering is GLOBAL
  reference data, so tenant BYOK would be a tenancy/cost mismatch (PE-derive-chain precedent).
- Emitter: family event — "a variant of \<family\> (hurt you in FL) just prefiled in TX; this
  family reached 6 states last session." **New subscriber key `familySpread`** (same pref
  mechanics as M2's `deadline`). Detection is commodity (BillTrack50 has a _tab_);
  **velocity + client exposure + alerting** is not.
- Backtest against the public azcentral/USA-Today model-legislation corpus (SC-7).

### Analyst QA console (thin, alongside $1/$2 — Rev 2)

The quarantine-review UI the money layer needs anyway, generalized: fiscal-note/line-item
parse review, crosswalk misses, source-quality flags, priority-client overrides; every
high-risk alert carries provenance + QA status. Internal-only in P2 (extends the P0.5
dashboard); customer-visible provenance copy later.

**Phase 2 exit criteria:** SC-8 + SC-10 (§8) + the priority-state money layer + opportunity
cards live (§9).

---

## 6. Phase 3 — The oracle (ongoing bets, sequenced quarterly; Rev 2 reframed around two flagship surfaces)

- **O1 · Pre-Introduction Radar.** Ingest interim-committee charges/agendas, sunset-review
  schedules, governor budget proposals, agency reports, AG opinions, prefiles. Alert: "the
  interim committee studying your issue published its charge — a bill is coming in January."
  Reuses hearing-discovery + regulations-pipeline patterns. Being early is worth 10× being
  complete; no _software product_ works this window (services do — §0 narrowing).
- **O2 · Federal↔State Transmission Graph (full).** The funds→implementation coupling ships
  early inside the Opportunity Engine ($4); the full graph adds tax/code conformity and
  preemption in both directions. Product moment: "your federal NDAA win creates a
  state-incentive opportunity in 4 facility states; here are the committees that would move
  it." Requires our federal stack — structurally uncopyable by state-only vendors.
- **O3 · Influence Graph (Rev 2 flagship — subsumes the old testimony + lobbying-disclosure
  bets).** One graph per bill/issue: committee chokepoints (M2) + witness/testimony records
  (P0.5 metadata, deepened here) + state lobbying registrations (ethics commissions /
  secretaries of state — the LDA counterpart) + campaign-finance edges (OpenSecrets state
  data) + industry associations + affected clients/facilities → coalition and opposition
  inferred, "where do I spend my time" answered. Heterogeneous per state → priority states
  first. Stream transcription remains counsel-gated (D6) and is fast-follow, not moat
  (USLege/Quorum already transcribe).
- **O4 · Government Decision Timeline (Rev 2 flagship).** Open an issue ("AI data centers")
  and see the whole lifecycle stitched: governor budget → agency plan → interim committee →
  bill filed → committee → appropriations → conference → governor → rulemaking → grant window
  → procurement → award → oversight → sunset. **This is a synthesis surface, not a new
  dataset** — every node ships in P0–P2 (bills, budgets, rules, obligations, opportunities)
  or O1 (pre-intro); the timeline is the join. Everyone tracks documents; nobody renders the
  decision _process_. Sequenced after O1 so the left edge of the timeline is populated.
- **O5 · Multistate Campaign Console / State Workroom (full).** One issue, 15 legislatures:
  per-state status board, testimony files, call sheets, coalition status, outreach log,
  client-ready reporting — the P0.5 positions/owners slice grown into the daily operating
  surface. MultiState sells this as a _service_; productizing it is the wedge.

**P4 · Local government — parked, demand-gated (Rev 2, decided).** Thousands of
municipalities, inconsistent publishing, little reuse, weak monetization for a
strategic-advocacy firm; Ballard's book is federal + state capitals, not "City of Dayton
zoning amendment 14-B." Revisit only on concrete client demand, and then as a
**state-to-local implementation/procurement radar** (follow money we already track into
county/school-board budgets), never as generic municipal tracking. FiscalNote is racing
toward local breadth — that's their capital to burn.

**P3 bets get formal SCs at kickoff; initial targets:** O1 — on a priority-state backtest,
≥60% of sampled introductions were preceded by a captured pre-intro signal; O2 — a labeled
federal provision resolves to correct state implementation/conformity links in ≥3 states;
O3 — for a real contested bill, the graph names the chokepoint members, registered
lobbyists/orgs on each side, and testimony evidence with verbatim quotes; O4 — a staging
issue renders a ≥8-node lifecycle timeline spanning at least bill→rule→opportunity; O5 — a
staging 15-state campaign board renders per-state status + generated one-pagers.

---

## 7. Data source inventory

| Source                                                               | What                                                                                                                                | Coverage                                                                                                     | Cost/auth                                | Phase           |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------- | --------------- |
| LegiScan Pull API                                                    | bills, actions, sponsors, roll calls (per-member), texts/versions, calendars, supplements (fiscal notes), `change_hash` masterlists | 50 states + DC + Congress                                                                                    | free 30k q/mo; commercial terms TBD (D1) | S1              |
| LegiScan Push API                                                    | push per state, every 15 min–4 h                                                                                                    | subscription states                                                                                          | paid, annual per state (D1)              | post-P0 upgrade |
| OpenStates v3                                                        | people, committees, `people.geo` point lookup                                                                                       | 50 states, freshness varies                                                                                  | free key (have)                          | S1 (people)     |
| Census Geocoder                                                      | address → lat/lng + SLDU/SLDL                                                                                                       | national                                                                                                     | free                                     | M1              |
| NCSL session calendars + chamber rules                               | convene/adjourn/crossover/cutoffs                                                                                                   | 50 states                                                                                                    | manual curation                          | S3/M2           |
| State budget documents                                               | budget bill versions, line items                                                                                                    | priority states first                                                                                        | public                                   | $1              |
| LegiScan supplements                                                 | fiscal notes, analyses                                                                                                              | states that publish                                                                                          | included                                 | $2              |
| Interim committee pages, sunset commissions, governor budget offices | pre-introduction signals                                                                                                            | priority states                                                                                              | scrape/manual                            | O1              |
| State hearing streams (Granicus/Sliq/YouTube)                        | live/archived hearing A/V                                                                                                           | most legislatures                                                                                            | **counsel gate (D6)**                    | O3              |
| State ethics commissions / secretaries of state                      | lobbying registrations + filings                                                                                                    | heterogeneous; priority states first                                                                         | public                                   | O3              |
| State registers / APA feeds + agency rulemaking dockets              | proposed/emergency rules, notices, EOs                                                                                              | priority states first (FL FAR, CA OAL, TX Register, NY Register, IL Register, MA Register, GA, VA Town Hall) | public                                   | M3              |
| Hearing agendas + witness lists / appearance records                 | who testified, for whom, on what                                                                                                    | TX, FL strongest; per-state variance                                                                         | public                                   | P0.5            |
| LegiScan `amendments[]` (in getBill)                                 | amendment metadata + adopted flag                                                                                                   | 50 states                                                                                                    | included (verify fields wk 1)            | P0.5            |
| Governor offices                                                     | budget proposals, EOs, veto messages                                                                                                | priority states                                                                                              | public                                   | M3/O1           |
| State procurement portals (e.g. MyFloridaMarketPlace)                | RFPs, awards                                                                                                                        | priority states                                                                                              | public                                   | $4/O4           |
| Commercial contact data (staffers/clerks/schedulers)                 | people enrichment                                                                                                                   | vendor-dependent                                                                                             | **paid — decision D8**                   | P0.5            |
| azcentral/USA-Today model-bill corpus                                | labeled bill families                                                                                                               | historical                                                                                                   | public                                   | $6 backtest     |

Priority states (recommendation, D2 — **Rev 2, Ballard-weighted**): **FL, CA, TX, NY, IL,
MA, GA, VA** — Ballard's strongholds (FL home base) + the biggest client-relevant capitals;
tier 2: NC (partnership), OH, AL, PA (the defense-weighted alternates from Rev 1 slot back in
when a defense-first tenant anchors a cohort).

---

## 8. Success criteria (each independently testable)

| #     | Criterion                                                                                                                                                                                                                                                                                                                  | Test                                                                                         |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| SC-1  | **Freshness SLA:** a LegiScan-visible action lands in `state_bill_action` + derived status within one sync cycle — p95 ≤60 min, hard bound ≤90 min (priority states, hourly pull; the Push upgrade is the path to a hard real-time SLA)                                                                                    | ingestion-lag telemetry (`firstSeenAt − action.date` percentiles) in `diag-ingestion-health` |
| SC-2  | **Served client:** a staging tenant with facilities + watchlist terms in 2 states sees a populated client-profile state surface — LegiWatch tab (board + feed with state rows), Needs-Attention chips, tracked state bills. (Rev 2 amendment: the _Intelligence-tab_ state section lands with M1's district data, not P0.) | staging fixture walkthrough                                                                  |
| SC-3  | **Alert parity:** a state status transition produces an `intel_alert` `sourceType='state_bill'` with verbatim `evidence.actionText` + deep link, delivered exactly once per (client, bill, changeType, 14d)                                                                                                                | replay harness on a captured session; idempotency via `intel_notification_log`               |
| SC-4  | **Pinned state eval:** Meri answers a died-at-crossover bill correctly via `get_state_bill_status` (misleading final action text)                                                                                                                                                                                          | meriv2-evals gate, state twin of the H.R. 8800 pin                                           |
| SC-5  | **District engine:** ≥95% of facilities geocode automatically to SLDU/SLDL, remainder flagged for manual pin-drop; 20-sample spot-check vs official district finders shows 0 wrong-district assignments                                                                                                                    | geocode batch report + spot-check log                                                        |
| SC-6  | **Deadline physics:** backtested on a completed session, `dead_by_deadline` matches actual outcomes ≥90% (priority states)                                                                                                                                                                                                 | backtest script on prior-session archive                                                     |
| SC-7  | **Contagion precision:** ≥80% family-clustering precision on a 50-family sample of the public model-bill corpus                                                                                                                                                                                                            | labeled-corpus eval                                                                          |
| SC-8  | **Budget watch golden test:** detect a known line-item change between two archived versions of a prior FL or TX budget bill                                                                                                                                                                                                | golden fixture in CI                                                                         |
| SC-9  | **Rules watch (Rev 2):** a proposed rule published in a priority-state register that matches a client watchlist produces a `state_rule` alert within 24 h, with the verbatim notice text + register deep link                                                                                                              | staging fixture on a real register entry                                                     |
| SC-10 | **Opportunity card (Rev 2):** a golden enacted bill with an appropriation + rulemaking mandate produces one card carrying program size, ≥1 affected facility, the rules-due date, and ≥1 recommended target                                                                                                                | golden fixture in CI                                                                         |

---

## 9. Sequencing & effort

| Phase                      | Contents                                                                                                                          | Effort         | Exit                                       |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | -------------- | ------------------------------------------ |
| P0 substrate               | S1–S7 (the basics)                                                                                                                | ~3–4 wk        | SC-1…SC-4                                  |
| P0.5 practice completeness | amendments, hearing/witness metadata, positions/owners, people enrichment, source-quality dashboard                               | ~2–3 wk        | staged demos per item                      |
| P1 moats                   | M1 district, M2 deadline+chokepoints, M3 rules & agency watch, M4 Meri                                                            | ~5–7 wk        | SC-5, SC-6, SC-9 + demo                    |
| P2 money → opportunity     | $1 budget watch, $2 fiscal notes, $3 diff+kill-switch, $4 opportunity engine, $5 obligation engine, $6 contagion, analyst console | ~8–10 wk       | SC-7, SC-8, SC-10 + opportunity cards live |
| P3 oracle                  | O1 pre-intro, O2 fed↔state full, O3 influence graph, O4 decision timeline, O5 campaign console                                    | quarterly bets | per-bet (initial targets in §6)            |
| P4 local                   | state-to-local radar ONLY on concrete demand                                                                                      | not scheduled  | n/a                                        |

~4.5–5 months to the full P2 exit ("sellable with the money story"), **if run focused** —
Rev 2 consciously trades ~5 weeks of calendar for regulations + amendments + opportunity
framing, because that is what Ballard's practice actually runs on. A credible **Ballard demo
gate** exists earlier: end of P1 (bills + alerts + district + deadlines + rules watch).
Known contention:
MeriV2 roadmap (live-LLM evals, alert collapse), bucket-#3 Wave 2 (votes/whip + Issue spine),
LegiWatch Workstream B/C/D. Note W-B/C are _shared_ work: the state rail rides the same
emitters and email template. Recommended interleave: P0 immediately after LegiWatch W-C ships
(one email template, two sources), P1 next, P2 gated on D4 design-partner signal.

---

## 10. Decisions for Ninja

| #   | Decision                                     | Recommendation                                                                                                                                          |
| --- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | LegiScan tier & commercial terms             | Start free Pull now; request commercial/Push quote in parallel (their terms require it for product use — must be resolved before GA, not before build)  |
| D2  | Priority-state list                          | **Rev 2:** FL, CA, TX, NY, IL, MA, GA, VA — Ballard-weighted (§7); tier 2 NC/OH/AL/PA                                                                   |
| D3  | Re-key `state_bill` to canonical natural key | Yes — cheap now, never again; crosswalk keeps both source ids                                                                                           |
| D4  | Design partner                               | **RESOLVED (Rev 2): Ballard Partners.** Demo gate = end of P1; P0 walkthrough at week 4 on FL fixtures                                                  |
| D5  | Packaging                                    | State = paid module (per-state or flat) vs platform-included — affects P2 priority                                                                      |
| D6  | Counsel: state hearing streams               | Same gate as C-SPAN/YouTube resolvers (env-gated OFF); official Granicus/Sliq feeds likely cleaner — ask counsel together                               |
| D7  | Sequencing vs MeriV2/bucket-3 roadmap        | Recommend P0 right after LegiWatch W-C; state rides the shared emitter/email work                                                                       |
| D8  | Contact-data enrichment (Rev 2)              | Buy vs scrape for staffers/clerks/schedulers: start with priority-state committee-staff scraping in P0.5; get a commercial-vendor quote in parallel     |
| D9  | Lobbying-disclosure acceleration (Rev 2)     | Stays in P3's Influence Graph unless Ballard asks for competitive intel earlier — then priority-state registrations pull forward as a standalone P2 add |

---

## 11. Risks

- **50-state heterogeneity** (procedures, budget formats, fiscal-note practice). Mitigation:
  SLA tiers — priority states get the full stack, the rest get the spine; expand by demand.
- **LegiScan licensing.** Free tier ≠ commercial product rights; get terms early (D1).
  Fallback: OpenStates bulk + direct scrapes (slower, more maintenance).
- **Procedural-calendar maintenance** is manual curation. Mitigation: it's also the moat;
  scope to priority states; annual refresh task.
- **Coarse-rail double-fire** during cutover (S4 retires `emit-changes` state counts).
  Sequence: state emitters live → verify → drop the count row, same as the Radar cutover.
- **Schedules out-of-band** while Compute CFN is wedged — follow the existing runbook; do not
  `cdk deploy` ([[infra_cdk_taskdef_drift]]).
- **Scope creep vs federal roadmap** — D7 exists for this reason.
- **Regulatory-coverage heterogeneity (Rev 2):** 50 APA regimes, register formats, and docket
  systems. Mitigation: M3 is priority-states-only by design, reuses the federal regulations
  engine's watermark/ingestion patterns, and the register list (§7) starts with the 8 states
  where Ballard lives.
- **Moat-claim drift into sales copy:** §0's narrowed wordings are the approved claims;
  anything broader ("nobody does X" without the qualifier) must not leave the building —
  single-state counterexamples exist and a demo-stage buyer will know them.

---

## 12. Competitive sources (2026-07-09 sweep)

FiscalNote [state tracking](https://fiscalnote.com/solutions/state-legislative-tracking) ·
[PolicyNote AI bill comparison](https://fiscalnote.com/newsroom/fiscalnote-introduces-ai-powered-bill-comparison-in-policynote) ·
Quorum [State](https://www.quorum.us/products/state/) ·
Plural [state tracker](https://pluralpolicy.com/solutions/state-legislation-tracker/) ·
BillTrack50 [Similar Bills](https://www.billtrack50.com/info/blog/new-feature-discover-similar-bills) ·
[USLege](https://www.uslege.ai/) (live transcripts) ·
[FastDemocracy](https://fastdemocracy.com/) (TranscriptAI, similarity) ·
[State Net](https://www.lexisnexis.com/en-us/products/state-net.page) ·
LegiScan [API](https://legiscan.com/legiscan) · [datasets](https://legiscan.com/datasets)

**Rev 2 additional references** (from the 2026-07-09 external market review; names, not
independently link-verified here): NCSL fiscal-note practices overview · StateScape
(analyst-filtered tracking) · MultiState (analyst-reviewed monitoring + services) · Geocodio
(address→SLDU/SLDL) · VoterVoice (advocacy execution) · FiscalNote API (local/municipal
breadth, pre-RFP leads) · InstaTrac Massachusetts (line-item/earmark budget reports) · Utah
line-item budget visualization · State Net Code Navigator (bill→statute impact).
