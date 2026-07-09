# LegiWatch Full Event Coverage + Grounded, LLM-Enriched Alerts

**Date:** 2026-07-09 · **Trigger:** the H.R. 8800 miss (twice) — Meri asserted the FY2027 NDAA
was "pending floor vote / conference imminent" when the rule (H.Res. 1398) had already **failed
198–224 on June 30**. The data was in the warehouse; no tool or alert could reach it.
**Scope:** (1) close every gap from that investigation, (2) make LegiWatch alert on all 8 event
types, (3) every alert carries verbatim source context, (4) LLM enrichment on top — grounded,
BYOK, fail-open. **All findings below verified against main @ 95cd0d0/f9685e0 with file:line.**

---

## 0. Why Meri was blind (root causes, from the live investigation)

| #   | Root cause                                                                                                                                                                                                                                                                                                     | Evidence                                                |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| RC1 | **No votes exist as data.** Zero vote tables; roll calls live only as free text inside `congress_bill_action.text`.                                                                                                                                                                                            | `VOTE_TABLES=[]` in prod; schema has no roll_call model |
| RC2 | **No tool reaches actions/votes.** Meri's only bill tool (`search_congress_bills`) returns scalar columns — `latestActionText` only, title-substring search.                                                                                                                                                   | `lda-intel.service.ts:478` bare findMany                |
| RC3 | **Rule→bill linkage unmodeled.** H.R. 8800's own timeline ends at "Rule reported" (reads as _advancing_). The failure is recorded on _other_ bills (`119-hres-1383`: "Rule H. Res. 1398 failed passage of House"). Nothing connects a rule resolution to the bills it provides consideration for.              | prod action rows, 2026-06-30                            |
| RC4 | **Procedural vehicles aren't synced.** `sync-congress` fetches /actions only for `isLobbyingRelevant` bills (20-policy-area allowlist, `sync-congress.ts:378`); H.Res. 1398 has `policy_area=null` → zero action rows synced.                                                                                  | prod: `HRES1398_ACTIONS=[]`                             |
| RC5 | **Bill stage is regex-derived from one string, in 4 divergent copies** (`intel-api/tracker/bill-stage.util.ts:16`, `api/tracker/bill-stage.util.ts:19`, `web/mappers.ts:386`, `program-element/intelligence/bill-stage.ts`). No persisted status; "rule reported" ≠ "rule passed" is invisible to all of them. | recon R2 §6                                             |

The same five causes are exactly why LegiWatch can't alert on floor outcomes today: `classifyChange`
(`change-detector.util.ts:26-50`) is a regex cascade over the **latest-action string** — if the
truth isn't in that one string on that one bill, no alert fires.

---

## 1. Current LegiWatch state (grounded baseline)

- **Canonical rail:** intel-api. `detect-bill-changes` (EventBridge, every 6h) diffs
  `congress_bill.latestActionText` vs the `intel_tracked_bill.lastSeen*` watermark
  (`bill-change-detector.service.ts:122-127`) → `classifyChange` → `intel_alert` row (14-day
  dedupe, deterministic score) → `emit-bill-alerts` (cron 20 0/6) → SES email + web feed + digests.
- **10 changeTypes today**, folding to **5 subscriber trigger keys**: `enactedFailed`, `floorVote`
  (incl. rule granted/floor scheduled), `committeeVote`, `hearing`, `amendment`.
- **4 trigger keys are UI-subscribable but have NO emitter**: `newMatch`, `fiscalNote`,
  `sponsorMomentum`, `companion` (`tracker.types.ts:14-21`; web labels at `tracker-api.ts:222-240`).
- **Email payload is nearly empty**: subject `[Capiro] HR 8800: <label>`, body = one `<p>` —
  no action text, no link, no why (`intel-email.service.ts:28-47`).
- **"Why" is deterministic keyword matching** (`relevance.util.ts:50-86`), **no LLM on the
  canonical rail**. The good LLM pattern exists on the _suppressed legacy rail only_:
  `TrackerSummaryService` (`tracker-summary.service.ts`) — tenant BYOK by
  `resolveProviderByTenantId`, metered to `ai_usage_events`, fail-safe null, 15s timeout,
  "never invent facts beyond the action text" prompt.
- **Known defects found in passing:** `emitNewBillAlerts` never sets `deliveredAt`/status after
  fan-out (re-sweeps all 'new' rows every 6h; idempotent only via `intel_notification_log`
  unique); hearing/`combined` alerts are never swept for email (web-feed-only).
- **Ready substrate (shipped this week):** `cbo_cost_estimate` (+ daily `sync-cbo` RSS),
  `congress_bill_cosponsor` (per-member, `sponsorshipDate`, withdrawn kept),
  `congress_member.lisId` crosswalk (Senate vote prereq), `congress_committee`+rosters,
  `resolve_entity` tool, canonical Alert contract in `@capiro/shared`.

---

## 2. Workstream A — The outcome truth layer (fixes the H.R. 8800 class)

**A1. Roll-call votes as first-class data** _(Bucket-#3 C1.V2/V3, sources live-verified in the
2026-07-06 plan)_

- Tables: `roll_call_vote` (id `{chamber}-{congress}-{session}-{roll}`, question, result,
  voteType, date, `billId?` soft ref, `amendmentRef?`, yea/nay/present/notVoting totals,
  partyTotals Json, sourceUrl) + `member_vote` ((voteId, bioguideId) PK, voteCast; Senate rows
  resolved lisId→bioguide via the shipped crosswalk). GLOBAL, additive.
- Syncs: `sync-house-votes` (Congress.gov `/v3/house-vote/{c}/{s}[/{roll}/members]` — GA since
  Dec 2025, same CONGRESS*API_KEY) hourly-on-session-days/6h otherwise; `sync-senate-votes`
  (senate.gov LIS XML `vote_menu*{c}\_{s}.xml` + per-vote files — the ONLY Senate source;
  re-pull last ~25 votes/run since no updateDate). Never touch House Clerk EVS (403s automation).
- Bill linkage: vote question text → `parseBillDesignation` (shipped) → `billId`; votes on
  rules link to the rule hres AND (via A2) to the target bills.

**A2. Rule→bill linkage** _(the exact H.R. 8800 mechanism)_

- New `bill_rule_link` (ruleBillId hres ↔ targetBillId, source 'title-parse'|'action-parse').
  Two deterministic parsers: hres titles ("Providing for consideration of the bill (H.R. 8800)…"
  — the prod title literally enumerates every target) and target-bill actions ("Rules Committee
  Resolution H. Res. 1398 Reported to House").
- **Outcome propagation:** when a rule's terminal event lands (adopted / failed / tabled — from
  A1 votes or action text), write a _synthetic material event_ onto every linked target bill
  (`rule_failed` / `rule_adopted` changeType) so the tracker watermark diff sees it even though
  Congress.gov never appends it to the target's timeline.

**A3. Close the ingestion gates**

- Sync /actions for: (a) any bill in `intel_tracked_bill` or legacy `tracked_bill` (regardless of
  policy area), (b) all `hres` whose title matches the providing-for-consideration parser,
  (c) keep the policy-area gate for the untracked long tail. Persist `updateDateIncludingText`
  (interface already carries it, `sync-congress.ts:109`; one column + one line).
- Turn ON `TRACKER_SCAN_ACTION_HISTORY` (env exists, off) so a committee vote superseded by
  routine churn within one 6h window isn't lost.

**A4. One canonical bill status**

- Single shared `deriveBillStage()` in `@capiro/shared` replacing the 4 divergent copies; inputs =
  action history + A1 votes + A2 rule outcomes; output = persisted `congress_bill.status`
  - `statusAt` (introduced → committee → reported → rule-pending → **rule-failed** → floor →
    passed-chamber → resolving-differences → to-president → enacted | failed | vetoed).
    "Rule reported" maps to _rule-pending_, never _floor-scheduled-and-advancing_.

**A5. Meri tool surface**

- `get_bill_status(billId)` → status, full action timeline, votes (with tallies), rule links +
  outcomes, explicit "no recorded floor vote" honesty note (SC2.2 style).
- `search_floor_votes(query|billId|member)` → roll calls with question/result/tally/party splits.
- `search_congress_bills`: match bill number + designation (via `parseBillDesignation`), include
  `status`. All wired into full-chat catalog + both drift-guard spec sets (55→57).

**A6. Regression pin**

- Deterministic eval + jest fixture reproducing this incident: given the H.R. 8800 / H.Res. 1398
  rows as of 2026-06-30, `get_bill_status('119-hr-8800')` MUST return `rule-failed` with the roll
  number and tally, and MUST NOT report floor-pending. This exact conversation becomes the test.

## 3. Workstream B — All 8 alert events (emitters on the canonical rail)

| #   | Event                                 | Data source                                                                                                                       | Build                                                                                                                                                                                                                |
| --- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1  | **New matched bill**                  | Recommendation engine already scores fit (`bill-fit.util.ts:40`, floor 0.45) but is compute-on-read only                          | Persist per-client match snapshots (`intel_bill_match`); nightly diff → `new_match` event (fit score + matched terms in evidence). Emitter for the existing dead `newMatch` key                                      |
| B2  | **Amendment / text changed**          | `updateDateIncludingText` (A3); /amendments sub-resource fetched for TRACKED bills only (bounded volume)                          | `text_changed` when textDate advances; `amendment_filed` rows with amendment purpose/sponsor in evidence. Upgrades the regex-only `bill_amendment`                                                                   |
| B3  | **Hearing scheduled**                 | `committee_hearing` exists but sync-hearings drops the committee-meeting detail's related-bill items — no hearing→bill link today | Fetch agenda bills → new `committee_hearing_bill` link; detector joins tracked bills × upcoming hearings → `hearing_scheduled` with date/room/witnesses. (Distinct from action-text `bill_hearing`)                  |
| B4  | **Committee vote / passed committee** | Action rows already carry tallies ("Ordered to be Reported… 44 - 12")                                                             | Keep `bill_reported`/`bill_markup`; add tally parser → structured `{yeas, nays}` in evidence                                                                                                                         |
| B5  | **Floor vote / passed chamber**       | A1 votes                                                                                                                          | `floor_vote` event with roll no., question, result, tally, party splits; `passed_chamber` from vote result; **`rule_failed`/`rule_adopted` via A2**                                                                  |
| B6  | **Enacted or failed**                 | Exists (`enactedFailed`, critical)                                                                                                | Keep; add veto-override + pocket-veto patterns; rule-failure propagation makes "stalled" visible                                                                                                                     |
| B7  | **New fiscal note**                   | `cbo_cost_estimate` + daily RSS (shipped)                                                                                         | Detector join: new estimate rows (by `lastSyncedAt` window) × tracked bills → `fiscal_note` with title/description/cboUrl. Emitter for the dead `fiscalNote` key                                                     |
| B8  | **Sponsor / cosponsor momentum**      | `congress_bill_cosponsor` with `sponsorshipDate` (shipped) — a time series with no snapshot table needed                          | Derivation per cycle: ≥N new in 7d (default 5), first cross-party join, relevant-committee member joins, withdrawal → `cosponsor_momentum` with the actual names/parties. Emitter for the dead `sponsorMomentum` key |

Also in B: fix `emitNewBillAlerts` deliveredAt idempotency; sweep hearing/`combined` alerts into
email delivery (pref-gated); add the new changeTypes to `DEFAULT_TRIGGERS` deliberately
(momentum/fiscal default-on, text-changed default-on, new-match default-on).

## 4. Workstream C — Source context in every alert (no more "the House voted…")

Extend `IntelAlertEvent` + the `intel_alert.evidence` JSON with a mandatory **evidence block**:

- `sourceQuote` — the verbatim record text: full action sentence(s), vote question + result +
  tally ("On agreeing to the resolution: Not agreed to, 198–224, Roll no. 232"), CBO estimate
  title + first description sentence, or the cosponsor names added.
- `sourceUrl` — deep link (congress.gov actions page / clerk vote page / cbo.gov publication).
- Per-event structured fields (tally, partyTotals, hearingDate, fitScore, newCosponsors[]).

Renderers: rebuild the SES email template (today: one `<p>`) → event label + **"From the record:"
quoted block** + link + enrichment (D) + deep-link to the feed card; same block on web feed cards
and in digests; SMS short-form carries label + tally + link (when the toll-free number lands).
The canonical `Alert.whatChanged` (`@capiro/shared`) gets event + quote, closing part of the
SC1.2 incompleteness backlog.

## 5. Workstream D — LLM enrichment (grounded, BYOK, fail-open)

Two layers, both strictly grounded on the evidence block — port of the proven
`TrackerSummaryService` + `alert-memo` patterns onto the canonical rail:

- **Layer 1 — event explanation (tenant-agnostic, cached).** "What happened + what procedurally
  happens next," ≤60 words, grounded ONLY on the evidence block. Cached per
  `(billId, changeType, actionDate)` and shared across all tenants tracking that bill (one LLM
  call per event, not per tenant). Global key, cheap model.
- **Layer 2 — client relevance (tenant-scoped).** "Why this matters to _your_ client," using
  watchlist matches + firm-soul steering (the `tracker-summary` `loadFirmContext` pattern).
  Tenant BYOK via `resolveProviderByTenantId`, metered via `recordAiUsageEvent`
  (workflow `legiwatch_alert_enrichment`), model override honored.
- **Where it runs:** intel-api has no LLM client or BYOK store — enrichment lives in apps/api
  behind an internal service endpoint (`POST /api/internal/alert-enrichment`, INTERNAL_SERVICE_SECRET
  auth — the BYOK3 precedent), called fire-and-forget from the emit path _before_ fan-out with a
  hard budget (aim 15s timeout, batch by bill).
- **Grounding guard:** `verifyGrounded`-style gate (from alert-memo) — enrichment sentences must
  trace to evidence-block facts; ungrounded output dropped, deterministic `why` (explainMatch)
  remains. Optional: persist enrichment claims via `MeriClaimWriterService`
  (`subjectType:'intel_alert'`) for the audit trail.
- **Fail-open invariant:** no key / flag off / timeout / provider error ⇒ the alert still
  delivers with quote + deterministic why. Kill-switch env `LEGIWATCH_ENRICHMENT_ENABLED`.

## 6. Workstream E — Rollout & ops

Shadow-first (new emitters log-only 1 week → compare volumes), canary capiro-internal, then all
tenants. New EventBridge schedules follow the out-of-band procedure (ComputeStack wedged —
[[infra_cdk_taskdef_drift]]) + entries in the canonical `ingestion-schedule.ts` matrix + the
task-failure→SNS alarm pattern. Weekly coverage report verb (`diag-legiwatch-coverage`): % tracked
bills with fresh actions, votes linked, evidence completeness, enrichment hit-rate.

---

## 7. Success criteria (each independently testable)

1. **The H.R. 8800 regression is dead:** the pinned eval (A6) is green in CI, and a live smoke of
   "which Army robotics lines have congressional movement / what happened to H.R. 8800" surfaces
   the failed rule (roll no. + 198–224 tally) via `get_bill_status` — never "pending floor vote."
2. **8/8 event types fire end-to-end:** for each, a fixture (seeded row or replayed real event)
   produces exactly one `intel_alert` with correct changeType, and the delivered email contains
   the verbatim source quote + working deep link. No subscribable trigger key without an emitter.
3. **Latency SLOs:** action-derived events ≤6h after `congress_bill` updates (existing cadence);
   House floor votes ≤2h on session days; Senate votes ≤6h; fiscal notes ≤24h of RSS publication;
   momentum computed each detection cycle.
4. **Context completeness = 100%:** every alert (all types) carries a non-empty `sourceQuote` +
   `sourceUrl`; enforced by an emit-path check + weekly coverage metric. The email template
   never renders the old bare-`<p>` body.
5. **Enrichment is grounded and safe:** deterministic eval — every enrichment sentence traces to
   the evidence block (0 fabrications on the eval corpus, incl. adversarial "rule reported but
   not adopted" cases); fail-open proven (revoke key in test → alert still delivers); Layer-2
   uses the tenant key when present (`usedTenantKey=true` rows in `ai_usage_events`) and is
   metered; Layer-1 cache means ≤1 Layer-1 call per (bill, event) regardless of tenant count.
6. **Idempotency:** `emitNewBillAlerts` marks delivery; re-running detect+emit produces zero
   duplicate notifications (test); per-event dedupe keys documented.
7. **Truth layer verified:** ≥99% of House/Senate roll calls for the current session present
   within SLO with member positions resolving to bioguide (Senate via lisId crosswalk); every
   119th-Congress rule hres linked to its target bills; `congress_bill.status` matches a
   hand-labeled 50-bill sample at ≥95%, and the 4 stage-derivation copies are deleted.
8. **Tool honesty:** `get_bill_status`/`search_floor_votes` return explicit "no recorded vote"
   notes when absent (never infer); drift-guard specs (registration + catalogs) updated; the
   entity eval gate extended with a vote-grounding case.

## 8. Sequencing & effort

- **Phase 1 (~2 wks): Workstream A** — votes, rule links, gates, status, tools, regression eval.
  _Unblocks B5/B6 and kills the Meri blindness on its own._
- **Phase 2 (~2 wks): B + C** — 8 emitters + evidence block + template rebuild (shadow → canary).
- **Phase 3 (~1.5 wks): D + E** — enrichment endpoint, grounding gate, caching, metering, GA.

**Decisions for Ninja:** (1) Layer-1 enrichment key/model (global cheap vs per-tenant);
(2) momentum thresholds (default: 5 new/7d, any cross-party first); (3) sweep hearing/`combined`
alerts into email now or keep web-only; (4) SMS inclusion timing (gated on toll-free anyway);
(5) counsel confirm on senate.gov LIS automated retrieval — already item 2 of the consolidated
Bucket-#3 counsel memo, no new asks.
