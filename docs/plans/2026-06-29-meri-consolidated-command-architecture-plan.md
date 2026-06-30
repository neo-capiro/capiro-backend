# MeriV2 — Consolidated Command Architecture Implementation Plan

Date: 2026-06-29
Owner: Neo Martinez (CTO)
Status: Proposed
Codename: **MeriV2** (the consolidated orchestrator + capability platform that supersedes the
two current Meri surfaces; existing surfaces keep running until cutover).
Scope: Consolidate Meri into one orchestrator-driven command architecture (MeriV2), inherit the
current Meri tenant + user scoping model exactly, add the full official-source data layer with
scheduled ingestion pipelines, and land the Deepgram live-hearing feature as a Real-Time
Hearing Intelligence capability (session worker + deterministic tools) at the END of the plan.

---

## 0. Executive summary

Target architecture:

```
Meri Orchestrator -> Capability Modules -> Deterministic Tools -> Data Sources
                  -> Artifacts / Dashboards / Alerts
```

Principle: **few agents, many tools.** Agents exist only for multi-step or independently
running workflows. Everything bounded (retrieve/mutate one thing) is a deterministic tool.

The single most important reframing against the current Capiro codebase:

- Today there is **no orchestrator**. There are **two independent Meri surfaces** that each
  re-assemble the same prompt stack (Sonnet + DOMAIN_PRIMER + PE-structural) by convention,
  not by a shared runtime:
  - In-editor Meri chat: `apps/api/src/workspace-assistant`
  - Post-Context-Builder generation: `apps/workspace` (its OWN service/ECR/Fargate,
    `/workspace-api/*`, deps only `@capiro/shared`)
- "Consolidate Meri" therefore = **stand up a shared orchestration core as its OWN service**
  (Option B, see §5) that BOTH surfaces call behind a feature flag, so any later surface (the
  live-hearing room) plugs in instead of forking a third prompt-assembly copy.
- The orchestrator is built **in parallel with prod on its own Fargate task** and cut over
  per-tenant behind a flag — existing surfaces stay untouched until parity is proven. Live
  Hearing is built **last** (§6 Phase 5), on top of the proven spine, not before it.

Repo: `capiro-meri` (branch `main`). Apps present: `api`, `web`, `workspace`, `clio-sandbox`.
Packages present: `shared`. The orchestrator package lands under `packages/` as
`@capiro/meriv2-core` (importable by `apps/workspace`, which is constrained to `@capiro/shared`
+ `@capiro/meriv2-core` only).

---

## 1. Current-state vs target (honest mapping)

### 1.1 Surfaces

| Surface | Today | Target |
|---|---|---|
| In-editor Workspace Assistant | `apps/api/src/workspace-assistant` (own prompt assembly) | Thin caller of `@capiro/meriv2-core` |
| Workspace generation | `apps/workspace` (own service/ECR/Fargate) | Thin caller of `@capiro/meriv2-core` |
| Full Meri Chat | partial / dashboard copilot prompts | Orchestrator plan-mode |
| Issue Dashboard | exists (Intel tab, Needs Attention, changes inbox — fragmented) | One alert taxonomy, orchestrator-fed |
| Live Hearing Room | does not exist | New standalone worker service |
| Admin / Compliance Console | partial (approvals, contact logs scattered) | Compliance/Audit store + console |

### 1.2 Data layer (six warehouses) — reality check

| Warehouse | Status | Notes |
|---|---|---|
| 1. Official Source Warehouse | PARTIAL | PE/R-1 jbook ingest (`program_element_ingest_run` ledger), LDA, sync ingestion exist. Congress.gov, GovInfo, Fed Register, USAspending, votes mostly NOT ingested = bulk of Phase 2. |
| 2. Private Firm Memory | EXISTS | Prisma/Postgres: clients, contacts, meetings, debriefs, tasks, emails. Tenant-scoped. |
| 3. Knowledge Graph | EXISTS but MISPLACED | Embedded in client profile. Decision already made: lift into "Intelligence Center". Prerequisite for KG as cross-capability system. |
| 4. Freshness / Change Detection | PARTIAL / SCATTERED | Backbone of the ONE alert taxonomy (Intel tab + Needs Attention + changes inbox). Unify BEFORE adding new sources. |
| 5. Claim / Evidence Store | PARTIAL | Implied by PE-structural + source maps; not first-class. Live Hearing forces it (segment-id + timestamp as claim anchors). |
| 6. Compliance / Audit Store | PARTIAL | Outbound contact logs / approvals exist in pieces. Must become system of record for approval gates. |

---

## 2. The shared orchestrator: `@capiro/meriv2-core`

New package under `packages/meriv2-core`. Owns:

- intent classification + plan selection
- tenant + user scoping — **inherits the current Meri scoping model exactly, not a new one.**
  MeriV2 reuses the same tenant resolution AND the same per-user identity/role checks that the
  existing Meri surfaces enforce today: same Clerk/tenant-mw/JWT path, same Clerk v2 org nesting
  `o.{id,slg,rol}` as source of truth, same `tenant_id` row-scoping on every query, and the same
  per-user permission gates (a user sees in MeriV2 exactly what they see in Meri today — no
  more, no less). The scoping wrapper **imports** `@capiro/shared` middleware; it does NOT
  reimplement or relax any check. Every tool handler receives the resolved `{tenant_id, user_id,
  roles, org}` context and must filter on it — a tool that ignores scope is a bug, not a config.
- tool registry + routing (the "many tools" live here as typed handlers)
- memory / KG retrieval
- grounding + claim-map assembly
- approval-gate hooks
- response / artifact generation

Both `apps/api/src/workspace-assistant` and `apps/workspace` become **thin callers**. The
live-hearing worker also calls the registry rather than re-implementing reasoning.

### 2.1 Agent map (accurate count)

Of the "six agents," five are **orchestrator plan-modes + tool bundles**, not separate
runtimes. Standing them up as separate services would re-create the two-surface divergence
problem.

| Role | Implementation |
|---|---|
| Research | orchestrator plan-mode |
| Writing | orchestrator plan-mode |
| Monitoring | orchestrator plan-mode (scheduled) |
| Analytics | orchestrator plan-mode (Python/pandas tool calls) |
| Compliance | orchestrator plan-mode + gate engine |
| **Live Hearing Session Worker** | **genuine separate runtime** (WebSocket audio, low-latency interim/final, reconnect, stateful). Modeled like `apps/workspace`: own service + ECR + Fargate task, deps `@capiro/shared` + `@capiro/meriv2-core`. |

Accurate count: **ONE orchestrator + FIVE plan-modes + ONE real worker service.**

### 2.2 Tool vs capability vs agent rule

- Retrieves/mutates one bounded thing -> **tool**
- Coordinates many tools over time -> **capability module**
- Reasons across many capabilities or runs independently -> **agent/worker**

Do NOT create `Bill Search Agent`, `LDA Agent`, `PE Agent`, `Email Agent`, etc. — those stay
tools or capability modules.

---

## 3. Capability module triage (not 19 parallel tracks)

### ALREADY REAL (refactor into module shape under orchestrator)
- Client Intelligence (client profile, intel tab, debrief->graph engine)
- Defense Budget / Program Elements (the actual differentiator: `report-pe-coverage`,
  jbook R-1, contractors, awards mapping)
- Hearing Intelligence (pre-hearing prep, partial)
- Outreach / Workflow (tasks, MS Graph email — **email is a guardrail**, see §7)
- Document / Artifact Generation (`apps/workspace` gen path)
- Knowledge Graph / Memory (exists, being relocated)

### HIGH-LEVERAGE NET-NEW (prior roadmap's biggest gaps — prioritize over the long tail)
- Vote / Whip / Office Targeting  <- previously flagged #1 missing layer
- Congressional Calendar / Floor Monitor
- Regulatory Intelligence (Fed Register / eCFR / Regulations.gov)
- Compliance / Ethics / Risk (precheck engine)
- Budget Score / Fiscal (CBO/JCT)

### DEFER (real but lower marginal value until the spine exists)
- Procurement / Grants / Awards
- State / Local Intelligence
- Litigation / Enforcement
- Campaign / Political Context (permissioned, compliance-reviewed — NOT a "who to donate to"
  feature)
- Standalone Analytics / Modeling
- Evaluation / Red Team — defer the FULL suite, but wire cross-client-leakage + grounding
  evals as CI gates the moment the orchestrator touches real tenant data.

---

## 4. Live Hearing Intelligence (Deepgram) — how it actually plugs in

### 4.1 Division of labor
- **Deepgram = STT only**: streaming transcription, interim -> final segments, endpointing/
  utterance boundaries, diarization, timestamps, reconnect/recovery.
- **Meri/orchestrator = everything policy-side**: entity recognition, source grounding,
  speaker identity mapping, issue matching, client relevance scoring, quote capture, action
  item extraction, artifact generation, compliance checking, KG updates.

### 4.2 First-class Prisma models (tenant-scoped from row one)

`LiveHearingSession`:
```
id, tenant_id, client_id?, matter_id?, issue_ids[], hearing_id?, committee_id?,
bill_ids[]?, program_element_ids[]?, agency_ids[]?, title,
source_type: hearing|markup|meeting|webinar|agency_session,
audio_source: browser_mic|uploaded_audio|stream_url|conference_bridge,
status: scheduled|live|paused|ended|failed, started_at, ended_at?,
consent_status: not_required|confirmed|needs_review,
recording_policy: transcript_only|audio_and_transcript|no_storage,
transcript_segments[], key_quotes[], action_items[], entity_mentions[],
summary_cards[], claim_map_id?
```

`TranscriptSegment`:
```
id, session_id, start_ms, end_ms, speaker_label?, resolved_speaker_id?,
resolved_speaker_name?, text, is_final, confidence?, source: "deepgram",
entity_mentions[], issue_tags[], client_relevance_score?
```

### 4.3 Non-negotiable constraints
- `consent_status` + `recording_policy` are NOT decoration — they **gate persistence** at the
  storage layer. `transcript_only` vs `audio_and_transcript` vs `no_storage` must be enforced
  in code, not UI.
- **Encryption guardrail**: hearing transcripts of client-relevant segments are confidential
  content. `meeting_debriefs` are already AES-GCM encrypted. Live transcripts inherit the
  **same** crypto pattern — do NOT invent a new scheme.
- **Debrief->graph rule applies**: extracted intelligence flows to the tenant_members-only KG
  engine section, NEVER embedded raw.

### 4.4 Deterministic streaming tools (live in orchestrator registry)
`create_live_hearing_session`, `start_live_transcription`, `pause_live_transcription`,
`resume_live_transcription`, `stop_live_transcription`, `ingest_live_audio_chunk`,
`receive_interim_transcript`, `commit_final_transcript_segment`, `identify_speaker_live`,
`tag_live_policy_mentions`, `flag_key_quote`, `extract_live_action_item`,
`update_live_hearing_dashboard`, `generate_post_hearing_summary`, `save_hearing_transcript`,
`create_hearing_claim_map`, `update_issue_dashboard_from_hearing`, `draft_hearing_followup_email`.

Because these live in the shared registry, the chat surface can ALSO run "pull every quote on
unmanned systems" against a finished session. Same tools, two surfaces — the payoff of
orchestrator-first.

### 4.5 Live Hearing Room UI
```
LEFT:   live transcript
CENTER: live summary cards
RIGHT:  client relevance / key quotes / action items
BOTTOM: timeline of important moments
```
Cards: Client mentioned, Bill mentioned, Program element mentioned, Potential ask, Opposition
argument, Member position signal, Follow-up opportunity, Appropriations/authorization
language, Compliance-sensitive statement, Quote worth saving.

### 4.6 The loop it feeds
`prepare -> listen live -> extract statements/action items -> update knowledge graph ->
update issue dashboard -> draft follow-up -> monitor next deadline`. Reuses the §6 alert
taxonomy; it does NOT get its own alert silo.

---

## 5. Deployment model — Option B: standalone orchestrator service + flag cutover

**Chosen approach: build the orchestrator as its OWN service on its OWN Fargate task, in
parallel with prod, and cut over per-tenant behind a feature flag.** This is the
strangler-fig pattern, and `apps/workspace` already proves it works on our stack (it is
already its own service/ECR/Fargate task talking to the rest of Capiro).

### 5.1 Why Option B (service) and not Option A (in-process library)
- **Option A (library):** both surfaces `import @capiro/meriv2-core` in-process. "Cutover" means
  editing live prod code paths during the repoint — exactly the breakage risk we want to
  avoid. Rejected as the Phase-0 mechanism.
- **Option B (service):** new orchestrator service — own ECR repo, own Fargate task/service on
  `capiro-dev`, own ALB target group + route (`/meri-api/*`), deps `@capiro/shared` +
  `@capiro/meriv2-core`. Existing surfaces stay **byte-for-byte untouched** until a flag flips.

### 5.2 Package + service shape
- `packages/meriv2-core` (`@capiro/meriv2-core`) — holds the logic (intent router, tool registry,
  scoping wrapper, grounding/claim-map). Pure, importable.
- `apps/meriv2-orchestrator` — thin service that **hosts** the package over HTTP (`/meri-api/*`),
  modeled on the `apps/workspace` template (own ECR/Fargate/ALB wiring).
- This dual shape means the live-hearing worker and both surfaces can call the same core
  either over HTTP now OR in-process later, without a rewrite.

### 5.3 Cutover mechanics (zero-downtime, instant rollback)
- **Per-tenant + per-surface feature flag** (in-editor chat vs workspace gen flagged
  independently), so we dogfood on ONE internal tenant first.
- Flag OFF -> surface runs today's in-process prompt assembly (untouched behavior).
- Flag ON -> surface proxies the request to the `meriv2-orchestrator` service.
- **Rollback = flip the flag off.** No redeploy, no migration reversal. Seconds.
- A **parity harness** runs both paths on the same input and diffs outputs; it is the gate that
  must be green before any tenant is flagged on.

### 5.4 Three caveats so "won't break anything" is actually true
1. **Shared database.** A separate service isolates CODE, not DATA. New tables (orchestrator
   state, claim store, live-hearing models) are additive and safe; any change to EXISTING
   tables is still a shared-blast-radius migration and goes through normal review — the
   "separate service" framing does NOT make it safe.
2. **Auth is shared, not reforked.** The service validates the same Clerk JWT and enforces
   tenant scoping by importing existing tenant-mw / Clerk middleware from `@capiro/shared`. It
   does NOT reimplement auth. (Clerk v2 org nesting `o.{id,slg,rol}` stays source of truth;
   never fake `clerkUserId=pending:<id>`.) See guardrail §7.1 — no movement without CTO go.
3. **Latency hop.** A separate service adds one HTTP round-trip per orchestrated request.
   Negligible for chat/generation; noted for completeness.

---

## 6. Phasing + success criteria (Live Hearing is the FINAL phase)

Ordering principle: build the spine first; Live Hearing depends on the spine, the alert/KG
consolidation, AND the claim store, so it lands LAST. Every phase below has explicit,
checkable success criteria — a phase is not "done" until all are met.

### Phase 0 — Standalone orchestrator spine (Option B)
Work:
1. Scaffold `packages/meriv2-core` (intent router, tool registry, scoping wrapper, grounding/
   claim-map).
2. Stand up `apps/meriv2-orchestrator` service (own ECR/Fargate/ALB, `/meri-api/*`).
3. Add per-tenant + per-surface feature flags for both existing surfaces.
4. Build the parity harness (same input -> both paths -> diff).
5. Promote Claim/Evidence + Compliance/Audit to first-class Prisma stores (additive tables).
6. Wire cross-client-leakage + grounding evals as CI gates.

Success criteria:
- SC0.1 `apps/meriv2-orchestrator` deploys to `capiro-dev` Fargate; running-task imageDigest ==
  ECR `:latest` digest == merge SHA. Health endpoint returns 200.
- SC0.2 Existing surfaces are unchanged with all flags OFF: `git diff` shows zero behavioral
  edits to `apps/api/src/workspace-assistant` and `apps/workspace` request paths.
- SC0.3 Parity harness passes: for a fixed corpus of N>=20 representative requests per surface,
  flag-ON output matches flag-OFF output within the agreed tolerance (text-identical for
  deterministic fields; semantic-equivalent for model output).
- SC0.4 Flag flip ON->OFF for one internal tenant restores prior behavior in < 5s with no
  redeploy (demonstrated, logged).
- SC0.5 New Prisma migrations are additive only (no ALTER/DROP on existing columns); `db:migrate`
  applies clean on a prod-shaped DB copy.
- SC0.6 CI gates fail the build on any cross-client-leakage or grounding-eval regression
  (proven with a deliberately seeded failing case).
- SC0.7 Scoping parity with current Meri: orchestrator rejects invalid/missing Clerk JWT and
  cross-tenant tokens (401/403) using imported `@capiro/shared` middleware (no auth
  reimplemented), AND for a fixed set of (user, tenant) pairs the set of rows/entities MeriV2
  returns is identical to what current Meri returns for the same user — no broadening of
  visibility, no per-user permission relaxed (code review + diff test).

### Phase 1 — Alert / KG consolidation
Work: ONE alert taxonomy across Intel tab + Needs Attention + changes inbox; lift KG out of
client profile into the Intelligence Center shell; stand up the Freshness/Change-Detection
layer as the single alert source.

Success criteria:
- SC1.1 A single alert-taxonomy type backs all three surfaces; no surface defines its own alert
  shape (one source module, verified by import graph).
- SC1.2 Every alert renders all seven required fields (what changed / why / client+issue / who
  acts / deadline / draft artifact / compliance check); items missing a field are flagged, not
  silently dropped.
- SC1.3 KG is reachable from the Intelligence Center shell and no longer hard-embedded in the
  client-profile component (old embed removed, not duplicated).
- SC1.4 Freshness layer emits a deduplicated change event for each tracked source type; firing
  the same underlying change twice produces one alert, not two.

### Phase 2 — Highest-leverage missing capabilities
Work: Vote/Whip/Office Targeting -> Calendar/Floor Monitor -> Regulatory lifecycle ->
Compliance precheck -> CBO/JCT fiscal. Each is a module + tools on the spine, NOT a new service.

Success criteria:
- SC2.1 Each new capability is registered in the meriv2-core tool registry and callable through
  the orchestrator with tenant scoping enforced.
- SC2.2 Vote/Whip/Office Targeting returns a whip count + office priority list for a real
  tracked bill, grounded in ingested vote/sponsor data (no fabricated members).
- SC2.3 Compliance precheck returns PASS/WARN/BLOCK + reason + rule source + audit record for
  each trigger in §3 (Compliance/Ethics); a BLOCK actually prevents the gated write.
- SC2.4 CBO/JCT fiscal tool maps a bill to its cost estimate / score-risk note where one exists,
  and returns "no estimate found" (not a guess) where none exists.
- SC2.5 Every new tool ships with at least one grounding-eval case in the CI gate.

### Phase 3 — Command center
Work: Path-to-Win planner, live issue dashboards, amendment/report-language workbench, office-
priority scoring, campaign objects, client-ready update packets, monitoring inbox.

Success criteria:
- SC3.1 An issue can be taken end-to-end: status + "what changed" + deadlines + office targets +
  open tasks + artifacts all render from one issue object.
- SC3.2 Monitoring inbox produces action-oriented alerts (the seven fields), not "new result
  found" rows.
- SC3.3 A client-ready update packet generates from a campaign object using the claim store, with
  every claim carrying a source + freshness + confidence.

### Phase 4 — Reliability & enterprise trust
Work: full red-team datasets, grounding evaluations, stale-source tests, compliance
false-negative tests, cross-client leakage tests, artifact review feedback loop.

Success criteria:
- SC4.1 Eval suite covers all categories: hallucination, stale-source, wrong bill version,
  wrong member/district, missed deadline, unsupported claim, tool-selection accuracy,
  cross-client leakage, compliance false-negative, citation precision, "what changed?" recall.
- SC4.2 Each category has a published baseline metric and a CI threshold that fails the build on
  regression.
- SC4.3 Cross-client leakage test = 0 leaks across the full tenant test matrix.
- SC4.4 Artifact review feedback loop captures reviewer edits back into the claim store
  (user-edited flag set, original preserved).

### Phase 5 — Live Hearing Intelligence (FINAL)
Depends on: Phase 0 (tools + claim store), Phase 1 (alert taxonomy + issue dashboard), Phase 4
(grounding/leakage gates). Built LAST so it plugs into a proven spine, not a moving target.

Work: new standalone worker service (workspace/orchestrator pattern) + Deepgram streaming +
`LiveHearingSession`/`TranscriptSegment` Prisma models + live room UI + extraction reusing
Phase-0 tools + encryption mirroring debriefs + feeding the Phase-1 loop. Internal order:
session object -> Deepgram streaming -> segment store -> live transcript UI -> entity
extraction -> key quote capture -> action item extraction -> post-hearing summary -> issue
dashboard update -> claim map with transcript timestamps.

Success criteria:
- SC5.1 Live Hearing worker is its OWN service/ECR/Fargate task (deps `@capiro/shared` +
  `@capiro/meriv2-core`); it calls registry tools and reimplements NO reasoning.
- SC5.2 A live session streams browser-mic audio to Deepgram and renders interim then final
  transcript segments in the Live Hearing Room with < 2s perceived caption latency.
- SC5.3 `recording_policy` is enforced at the storage layer: `no_storage` persists nothing,
  `transcript_only` persists no audio, `audio_and_transcript` persists both (verified by DB +
  object-store inspection, not UI).
- SC5.4 Client-relevant transcript segments are AES-GCM encrypted at rest using the SAME pattern
  as `meeting_debriefs` (no new scheme; code review sign-off).
- SC5.5 Extracted intelligence flows to the tenant_members-only KG engine section, never
  embedded raw (debrief->graph rule); leakage test on hearing data = 0.
- SC5.6 Each saved key quote / claim points to a `TranscriptSegment` id + timestamp, not just
  the overall transcript.
- SC5.7 Post-hearing, the chat surface answers "pull every quote on <topic>" against the
  finished session using the SAME registry tools (proves the orchestrator-first payoff).
- SC5.8 A captured hearing quote raises an alert through the Phase-1 taxonomy (no separate
  live-hearing alert silo).
- SC5.9 Connection recovery: a forced WebSocket drop mid-session reconnects and resumes
  committing final segments without losing the prior committed transcript.

---

## 7. Data sources + ingestion pipelines (the data layer MeriV2 reasons over)

MeriV2 is only as good as its Official Source Warehouse. **Most of the high-value sources are
ALREADY ingested** by Capiro's existing 6-tier scheduler (see
`docs/plans/2026-06-01-production-ingestion-scheduling-schedule-matrix.md`). The job here is to
(a) inventory what exists, (b) add the genuine gaps, and (c) keep everything on the same
`SyncRun`/`ScheduledJob` construct — incremental `--since`, one instance per job, UTC-staggered,
dependency-ordered (SOURCES -> DERIVED/EMITTERS -> EMBEDDINGS -> MV REFRESH).

### 7.1 ALREADY INGESTED (reuse as-is, no new pipeline)
These existing sync jobs back the corresponding capability modules directly:

| Source | Existing job | Cadence | Feeds capability |
|---|---|---|---|
| Congress.gov bills/actions | `sync-congress` | daily 06:00 | Legislative |
| Federal Register | `sync-federal-register` | daily 06:15 | Regulatory |
| Regulations.gov dockets | `sync-regulations` | daily 06:30 | Regulatory |
| Committee hearings | `sync-hearings` | daily 06:45 | Hearing Intel |
| News/RSS intel | `sync-rss-intel` | 4x/day | Monitoring |
| FEC + PAC | `sync-fec`, `sync-fec-pac` | daily 07:00/07:20 | Campaign/Political |
| Federal awards | `sync-federal-award` (+`enrich-award-districts`) | daily 07:40/08:00 | Procurement/Awards |
| LDA + OpenLobby | `sync-lda`, `sync-openlobby` | weekly Mon | Compliance, Client Intel |
| FARA | `sync-fara` (+`sync-fara-enrichment`) | weekly Mon | Compliance |
| GAO | `sync-gao` | weekly Mon | CRS/GAO/Oversight |
| CRS | `sync-crs` | weekly Mon | CRS/GAO/Oversight |
| Grants.gov | `sync-grants` | weekly Mon | Procurement/Grants |
| OpenStates (state bills) | `sync-openstates` | weekly Mon | State/Local |
| SEC EDGAR (primes) | `sync-sec-edgar` | weekly Mon | Defense Budget, Analytics |
| SAM opportunities + personnel | `sync-sam-opportunities`, `sync-sam-personnel` | daily/weekly | Procurement |
| Member press | `sync-member-press` (+`extract-press-personnel`) | weekly Tue | Vote/Whip, Hearing |
| DoD orgcharts/PEO rosters/personnel | `sync-dod-*`, `sync-peo-rosters`, `sync-cpe-roster` | weekly/monthly | Defense Budget |
| Comptroller J-books / J-book R-2 / performers | `sync-comptroller-jbooks`, `sync-jbook-r2`, `sync-jbook-performers` | seasonal | Defense Budget/PE |
| BEA / BLS / Census | `sync-bea`, `sync-bls`, `sync-census` | monthly | Analytics, Vote/Office |
| OpenSpending | `sync-openspending` | monthly | Analytics |
| X/Twitter signal | `sync-x` | (existing) | Monitoring |

Derived/emitter + embeddings tiers (`emit-changes`, `emit-bill-alerts`, `check-comment-periods`,
`compute-health-scores`, `generate-briefings`, `embed-backfill`) already run daily after sources
— **MeriV2 emits its alerts through this same chain**, not a parallel one (ties to §8 taxonomy).

### 7.2 GAPS — new ingestion pipelines to add (verified absent in the codebase)
Confirmed by source-grep: no dedicated client/job exists for these today. Each is additive
(new tables, new `sync-*` job on the existing scheduler). Cadence chosen by how fast the
upstream actually changes vs. rate-limits, following the Tier rules.

| New job | Source / API | Tier + Cron (UTC) | Mode | Feeds capability | Notes / risk |
|---|---|---|---|---|---|
| `sync-house-votes` | House Clerk roll-call XML | 🟢 daily `10 6 * * *` | incremental | Vote/Whip/Office | partial `rollcall` code exists; finish + schedule |
| `sync-senate-votes` | Senate.gov roll-call XML | 🟢 daily `12 6 * * *` | incremental | Vote/Whip/Office | XML feed, stable schema |
| `sync-floor-schedule` | House Majority Leader + Senate floor | 🟢 daily `5 6 * * *` | FULL (upsert) | Calendar/Floor Monitor | "what can move this week" |
| `sync-house-rules` | House Rules Committee activity | 🟢 daily `8 6 * * *` | FULL (upsert) | Calendar/Floor Monitor | amendment-deadline windows |
| `sync-ecfr` | eCFR API (+ `diff-ecfr`) | 🔵 weekly Mon `0 4 * * 1` | incremental + ⚙️ diff | Regulatory | diff job derived, after sync |
| `sync-reginfo-oira` | Reginfo.gov / OIRA reviews + 12866 mtgs | 🔵 weekly Mon `30 4 * * 1` | incremental | Regulatory | rulemaking pipeline visibility |
| `sync-unified-agenda` | Unified Agenda (semiannual) | 🟣 monthly `0 3 5 * *` | FULL (upsert) | Regulatory | changes ~2x/yr; monthly check |
| `sync-cbo` | CBO cost estimates | 🔵 weekly Mon `0 5 * * 1` | incremental | Budget/Fiscal | score risk / pay-fors |
| `sync-jct` | JCT revenue estimates | 🔵 weekly Mon `30 5 * * 1` | incremental | Budget/Fiscal | tax-side scores |
| `sync-treasury-fiscal` | Treasury Fiscal Data API | 🟣 monthly `0 4 10 * *` | FULL (upsert) | Budget/Fiscal | budget-account reference |
| `sync-sbir-sttr` | SBIR.gov awards | 🔵 weekly Mon `0 6 * * 1` | incremental | Defense Budget/PE | small-biz R&D footprint |
| `sync-dote` | DOT&E annual reports | 🟠 seasonal (Jan–Feb) | on artifact commit | Defense Budget/PE | report-driven, gate on PDF |
| `sync-unfunded-priorities` | Service UPLs | 🟠 seasonal (Feb–Apr) | on artifact commit | Defense Budget/PE | appropriations-cycle |
| `sync-fpds` | FPDS contract actions | 🔵 weekly Mon `0 7 * * 1` | incremental | Procurement/Awards | complements USAspending |
| `sync-sam-entity` | SAM entity (UEI/CAGE) records | 🔵 weekly Mon `30 7 * * 1` | incremental (upsert) | Procurement, KG | entity normalization anchor |
| `sync-courtlistener` | CourtListener / RECAP dockets | 🟢 daily `20 7 * * *` | incremental --since | Litigation/Enforcement | PACER paid-tier later |
| `sync-doj-press` | DOJ press releases | 🟢 daily `30 7 * * *` | FULL (upsert) | Litigation/Enforcement | enforcement signal |
| `sync-agency-enforcement` | FTC/SEC/CFPB/EPA/etc. enforcement | 🔵 weekly Mon `0 8 * * 1` | FULL (upsert) | Litigation/Enforcement | multi-source crawler |
| `sync-opensecrets` | OpenSecrets (permissioned) | 🟣 monthly `0 5 12 * *` | FULL (upsert) | Campaign/Political | compliance-gated, §9.x |
| `sync-state-regs` | State administrative registers | 🔵 weekly Mon `0 9 * * 1` | incremental | State/Local | per-state adapters, phased |
| `sync-state-procurement` | State procurement portals | 🔵 weekly Mon `30 9 * * 1` | incremental | State/Local | phased per priority state |
| `sync-govinfo-backup` | GovInfo (FR/CFR/hearings backup) | 🔵 weekly Mon `0 10 * * 1` | incremental | resilience layer | fallback when primary stale |

### 7.3 Phasing the new pipelines (aligns to §6 capability phases)
- **With Phase 2** (the capabilities that need them): votes/floor/rules (Vote+Calendar),
  eCFR/Reginfo/Unified Agenda (Regulatory), CBO/JCT/Treasury (Fiscal). These are prerequisites —
  a capability without its source is a stub, so the pipeline lands in the SAME phase as its module.
- **With Phase 2/3 follow-on**: SBIR, FPDS, SAM-entity, DOT&E, UPLs (Defense/Procurement depth).
- **Deferred** (matches §3 DEFER bucket): CourtListener/DOJ/agency-enforcement (Litigation),
  OpenSecrets (Campaign, compliance-gated), state-regs/procurement (State/Local, per-state).
- **Live Hearing (Phase 5)** is a real-time STREAM source, not a scheduled batch job — it does
  NOT live in this scheduler. Deepgram audio is ingested live by the worker; only the finalized
  transcript/segments persist (subject to `recording_policy`).

### 7.4 Ingestion guardrails (carry over from existing matrix)
- Every new job uses `SyncRun --since` incremental mode unless marked FULL (cheap upsert).
- One running instance per job; skip if prior run still active (`status='running'` guard).
- New tables are tenant-aware where the data is tenant-specific; **public official-source data is
  shared/global** (not per-tenant) — only the client/issue LINKAGES are tenant-scoped, matching
  how `sync-congress`/`sync-lda` work today. Do not accidentally per-tenant the public warehouse.
- Embeddings via `embed-backfill` are content-hash idempotent and per-tenant; new sources opt in
  by adding their table to the backfill source list.
- Seasonal/artifact-gated jobs (DOT&E, UPLs) follow Tier-4 rules: gate on committed PDF-extraction
  artifacts, not pure cron.

---

## 8. Alert taxonomy (single shared model)

One taxonomy consumed by: client Intel tab + dashboard "Needs Attention" (all clients) +
changes inbox. No duplicate sections. Every alert answers:
- What changed?
- Why does it matter?
- Which client / issue is affected?
- Who should act?
- What is the deadline?
- What draft artifact is ready?
- What compliance check is needed?

Sources funnel through the Freshness / Change-Detection layer (Phase 1): bill text changed,
new cosponsor, hearing notice changed, markup packet posted, Fed Register notice, comment
deadline approaching, SAM opportunity, award issued, LDA filing changed, **live hearing quote
captured**, client issue status changed.

---

## 9. Hard guardrails — require explicit CTO sign-off before moving

1. **AUTH** (§7.1): orchestrator tenant/client scoping WRAPS Clerk/tenant-mw/JWT. Must not replace or
   reimplement. Clerk v2 org nesting `o.{id,slg,rol}` stays source of truth. Never fake
   `clerkUserId=pending:<id>` (-> 500).
2. **EMAIL**: `send_email`/`reply_email` route through existing MS Graph OAuth. Compliance
   precheck gates them; it does not bypass the OAuth path.
3. **CONFIDENTIAL CONTENT**: live hearing transcripts + debriefs stay AES-GCM encrypted;
   extracted intel goes to tenant_members-only KG engine section, never embedded raw. New STT
   data inherits existing crypto, no new scheme.
4. **Engagement scoping**: strict client-scoped context only (client-linked meetings +
   client-associated email threads). Do not leak coworker/other-attendee domains in TO/CC.

---

## 10. First three PRs (concrete starting point — Option B)

- **PR1**: scaffold `packages/meriv2-core` (`@capiro/meriv2-core`) — tool-registry interface +
  intent-router stub + scoping wrapper that imports `@capiro/shared` tenant-mw (no auth
  reimplemented). No behavior change; nothing calls it yet. (Toward SC0.7.)
- **PR2**: stand up `apps/meriv2-orchestrator` service hosting the package over `/meri-api/*`,
  modeled on the `apps/workspace` ECR/Fargate/ALB template. Deploy to `capiro-dev`; prove
  running-task imageDigest == ECR `:latest` == merge SHA; health endpoint 200. Existing
  surfaces still untouched. (Satisfies SC0.1; keeps SC0.2.)
- **PR3**: migrate ONE tool end-to-end (`get_client_context` — already real, low blast radius)
  into the registry, add the per-tenant/per-surface flag (default OFF) + parity harness, and
  prove flag-ON == flag-OFF on the test corpus before flipping any tenant. Establishes the
  template every other tool follows. (Toward SC0.3 / SC0.4.)

---

## 11. Final recommended map

```
ONE ORCHESTRATOR              Meri  (packages/meriv2-core, hosted by apps/meriv2-orchestrator)

FIVE PLAN-MODES               Research, Writing, Monitoring, Analytics, Compliance
+ ONE WORKER SERVICE          Live Hearing Session Worker (own service/ECR/Fargate)

CAPABILITY MODULES            Client Intel, Legislative, Vote/Whip/Office, Calendar/Floor,
                              Hearing, Live Hearing, Regulatory, Compliance/Ethics/Risk,
                              Defense Budget/PE, Procurement/Grants, Budget/Fiscal,
                              CRS/GAO/Oversight, State/Local, Litigation/Enforcement,
                              Campaign/Political, Outreach/Workflow, Document Gen,
                              Analytics/Modeling, Knowledge Graph/Memory, Evaluation/Red Team

MANY DETERMINISTIC TOOLS      100-200+ is fine

SIX CORE DATA SYSTEMS         Official Source Warehouse, Private Firm Memory, Knowledge Graph,
                              Freshness/Change Detection, Claim/Evidence Store,
                              Compliance/Audit Store
```

Deepgram live hearing = a capability under Hearing Intelligence, implemented as a session
worker + deterministic streaming tools, feeding Hearing Intelligence, Knowledge Graph, Issue
Dashboard, Claim Map, Task System, and Compliance. Not a detached transcription feature — one
of Meri's strongest command-center inputs.

---

## Appendix A — Capability module tool inventory (all 19 modules)

The §3 triage decides BUILD ORDER; this appendix is the full tool/data/output spec for each
module. Tool names are the canonical registry handles (`@capiro/meriv2-core` registry). "Status"
flags whether the underlying data is already ingested (§7.1) or a gap (§7.2).

### A1. Client Intelligence  — status: ALREADY REAL
- Tools: `get_client_context`, `search_client_knowledge`, `read_client_documents`,
  `search_research_sources`, `update_client_profile`, `find_district_nexus`,
  `get_client_facilities`, `get_client_approved_language`
- Data: client profile, uploaded docs, CRM, meetings, email threads, facilities, prior
  submissions, internal notes, approved-language bank
- Outputs: client nexus summary, district footprint, capability brief, relevant past meetings,
  approved talking points

### A2. Legislative Intelligence — status: data ingested (`sync-congress`)
- Tools: `search_congress_bills`, `search_state_bills`, `search_tracked_bills`,
  `compare_bill_versions`, `search_amendments`, `search_committee_reports`,
  `search_congressional_record`, `search_house_docs`, `search_dear_colleague_letters`,
  `detect_vehicle_opportunity`
- Data: Congress.gov, GovInfo, House Document Repository, House Rules Committee, Senate
  schedules, committee websites, public member/committee statements
- Outputs: bill summary, action timeline, version diff, vehicle map, amendment opportunity,
  report-language opportunity

### A3. Vote / Whip / Office Targeting — status: GAP (`sync-house-votes`,`sync-senate-votes`)
- Tools: `search_roll_call_votes`, `analyze_member_vote_history`, `build_whip_count`,
  `score_member_alignment`, `recommend_cosponsor_targets`, `map_committee_gatekeepers`,
  `track_member_public_positions`, `build_member_issue_dossier`, `rank_office_targets`
- Data: House Clerk votes, Senate votes, Congress.gov sponsors/cosponsors, Congressional
  Record, member press releases, committee memberships, FEC/political context (permissioned),
  Census/BEA/BLS, internal CRM, client footprint
- Outputs: whip count, member alignment score, office priority list, champion/blocker map,
  persuadable offices, staff outreach targets

### A4. Congressional Calendar / Floor Monitor — status: GAP (`sync-floor-schedule`,`sync-house-rules`)
- Tools: `search_floor_schedule`, `search_house_rules_activity`, `search_suspension_calendar`,
  `search_senate_floor_schedule`, `track_committee_notice_changes`, `alert_markup_or_vote_window`,
  `detect_vehicle_opportunity`
- Data: House Majority Leader, House Rules Committee, House Document Repository, Senate floor
  schedule, committee calendars, GovInfo, Congress.gov actions
- Outputs: floor watch, markup watch, amendment-deadline alert, vote-window alert, vehicle
  opportunity alert

### A5. Hearing Intelligence — status: ALREADY REAL (`sync-hearings`, partial)
- Tools: `search_committee_hearings`, `search_committee_documents`, `search_witness_testimony`,
  `search_hearing_video`, `search_hearing_transcripts`, `build_hearing_brief`,
  `extract_witness_positions`, `generate_member_questions`, `build_hearing_followup_plan`
- Data: committee websites, Congress.gov committee-meeting docs, House Document Repository,
  Senate hearing pages, GovInfo hearings, witness statements, video/transcripts, member press,
  CRS/GAO context
- Outputs: hearing brief, witness dossier, expected member questions, opposition map, quote
  bank, post-hearing client update
- Note: extend with truth-in-testimony forms, committee amendments, markup packets, manager's
  amendments, report language, QFRs.

### A6. Live Hearing Intelligence — status: Phase 5 (Deepgram). Full spec in §4.

### A7. Regulatory Intelligence — status: partial (`sync-federal-register`,`sync-regulations` exist; `sync-ecfr`,`sync-reginfo-oira`,`sync-unified-agenda` GAP)
- Tools: `query_regulatory_dockets`, `search_federal_register`, `search_ecfr`, `diff_ecfr_text`,
  `search_unified_agenda`, `search_oira_reviews`, `search_12866_meetings`,
  `track_comment_deadlines`, `summarize_comment_record`, `draft_regulatory_comment`,
  `compare_final_rule_to_proposed_rule`
- Data: Federal Register, eCFR, Regulations.gov, Reginfo.gov/OIRA, Unified Agenda, agency
  rulemaking pages, OMB guidance, GovInfo FR/CFR
- Outputs: docket summary, comment-deadline alert, rule diff, comment-record summary, draft
  comment

### A8. Compliance / Ethics / Risk — status: partial (LDA/FARA ingested; precheck engine GAP)
- Tools: `compliance_precheck`, `check_lda_thresholds`, `draft_ld2_activity_summary`,
  `check_ld203_obligations`, `gift_travel_rule_check`, `fara_risk_check`,
  `procurement_integrity_check`, `pay_to_play_state_check`, `conflict_check_client_positions`,
  `audit_outbound_contact_log`
- Data: LDA.gov, LDA guidance, House/Senate ethics rules, DOJ FARA, FEC, FAR/eCFR procurement
  integrity, state ethics portals, internal compliance logs, conflict database
- Outputs: PASS/WARN/BLOCK, reportability note, audit record, required approval, conflict flag
- Guardrail: see §9.2 — never bypasses MS Graph OAuth on email-gated actions.

### A9. Defense Budget / Program Elements — status: ALREADY REAL (differentiator)
- Tools: `search_program_elements`, `get_program_element`, `get_pe_budget_timeline`,
  `get_pe_contractors`, `get_pe_bills`, `search_acquisition_personnel`, `get_acquisition_person`,
  `search_dote_reports`, `search_sbir_sttr`, `search_unfunded_priorities`, `map_pe_to_awards`,
  `detect_defense_language_opportunity`
- Data: OUSD Comptroller materials, service J-books, NDAA/approps bills, committee reports,
  HASC/SASC/HAC-D/SAC-D materials, DoD contract announcements, USAspending, SAM.gov, FPDS,
  DOT&E, SBIR.gov, GAO, CRS, public PEO/program-office pages
- Outputs: PE dossier, budget timeline, contractor map, PE→awards map, defense-language
  opportunity
- New data: `sync-sbir-sttr`, `sync-dote`, `sync-unfunded-priorities`, `sync-fpds` (§7.2).

### A10. Procurement / Grants / Awards — status: partial (awards/SAM/grants ingested; FPDS/SAM-entity GAP)
- Tools: `search_federal_awards`, `search_sam_opportunities`, `search_federal_grants`,
  `search_contract_awards`, `search_entity_records`, `search_assistance_listings`,
  `build_incumbent_map`, `predict_recompete_window`, `score_grant_fit`, `map_award_to_client_issue`
- Data: USAspending, SAM.gov opportunities + contract awards, FPDS, SAM entity records,
  Grants.gov/Simpler Grants, agency procurement forecasts, GSA forecasts, SBA SUBNet, NAICS/PSC,
  internal client past performance

### A11. Budget Score / Fiscal — status: GAP (`sync-cbo`,`sync-jct`,`sync-treasury-fiscal`)
- Tools: `search_cbo_cost_estimates`, `search_jct_revenue_estimates`, `extract_payfors`,
  `compare_budgetary_effects`, `estimate_score_risk`, `map_bill_to_budget_accounts`,
  `search_treasury_fiscal_data`, `search_federal_budget_accounts`
- Data: CBO, JCT, OMB budget, GovInfo budget collection, Treasury Fiscal Data, agency CBJs,
  BEA/BLS/Census

### A12. State / Local Intelligence — status: partial (OpenStates ingested; regs/procurement GAP, DEFER)
- Tools: `search_state_bills`, `search_state_regulatory_dockets`, `search_state_procurement`,
  `search_state_budget`, `search_state_campaign_finance`, `search_state_ethics_rules`,
  `search_governor_actions`, `search_attorney_general_actions`,
  `search_public_utility_commission_dockets`, `search_medicaid_waivers`, `search_local_ordinances`
- Data: OpenStates, LegiScan, state legislature sites, state administrative registers, state
  procurement portals, state ethics/lobbying commissions, state campaign-finance portals,
  governor/AG websites, PUC dockets, municipal code platforms, commercial state platforms

### A13. Litigation / Enforcement — status: GAP, DEFER (`sync-courtlistener`,`sync-doj-press`,`sync-agency-enforcement`)
- Tools: `search_court_dockets`, `search_federal_opinions`, `track_agency_litigation`,
  `search_doj_press_releases`, `search_agency_enforcement`, `monitor_settlements_consent_decrees`
- Data: PACER, CourtListener/RECAP, DOJ News, FTC/SEC/CFPB/EPA/HHS-OIG/CMS/FDA/DOL/FCC/FERC
  pages, Federal Register, Regulations.gov, agency enforcement pages

### A14. Campaign / Political Context — status: partial (FEC ingested; OpenSecrets GAP). PERMISSIONED + compliance-reviewed.
- Tools: `search_fec_filings`, `analyze_pac_industry_support`, `map_member_election_pressure`,
  `track_primary_general_risk`, `search_state_campaign_finance`, `summarize_member_political_context`
- Data: FEC, FEC bulk, state campaign-finance portals, OpenSecrets, NCSL, internal compliance
  approvals
- Guardrail: political-context + compliance-risk intelligence ONLY. NOT a "who should we donate
  to" feature. Compliance-gated.

### A15. Outreach / Workflow — status: ALREADY REAL (tasks + MS Graph email = GUARDRAIL §9.2)
- Tools: `query_tasks`, `create_task`, `update_task`, `query_action_items`, `query_debriefs`,
  `query_outreach`, `send_email`, `reply_email`, `list_emails`, `draft_followup_email`,
  `create_outreach_campaign`, `track_office_response`
- Data: tasks, CRM, Microsoft 365, meeting notes, outreach logs, approvals, compliance audit logs
- Outputs: tasks, follow-up emails, outreach campaigns, office status, promised follow-ups,
  escalation reminders

### A16. Document / Artifact Generation — status: ALREADY REAL (`apps/workspace` gen path)
- Tools: `create_word`, `create_excel`, `create_powerpoint`, `create_meeting_brief`,
  `draft_policy_memo`, `draft_coalition_letter`, `draft_regulatory_comment`, `draft_hearing_brief`,
  `draft_client_update`, `save_note`
- Data: official sources, client docs, prior approved artifacts, source snippets, claim maps,
  reviewer comments, firm templates
- Outputs: memo, deck, spreadsheet, one-pager, client alert, hearing packet, leave-behind,
  comment letter, coalition letter
- Required behavior: uses claim map, cites official sources, preserves client-approved language,
  flags unsupported claims, writes in firm style, produces editable artifacts.

### A17. Analytics / Modeling — status: DEFER (standalone); plan-mode covers ad-hoc
- Tools: `run_analysis`, `build_vote_model`, `build_office_priority_score`, `analyze_award_trends`,
  `forecast_budget_line`, `cluster_member_positions`, `score_grant_fit`, `predict_recompete_window`
- Data: official-source warehouse, client footprint, spending data, votes, PE budgets,
  Census/BEA/BLS, CRM/meetings, historical campaigns

### A18. Knowledge Graph / Memory — status: EXISTS, being relocated (Phase 1; see §B)
- Tools: `search_memory`, `query_knowledge_graph`, `find_path_to`, `save_memory`,
  `link_entities`, `resolve_entity`, `merge_duplicate_entities`, `update_relationship_strength`
- Data: firm memory, meetings, CRM, emails, clients, bills, offices, staff, agencies, companies,
  awards, grants, dockets, program elements, live-hearing transcripts
- Implementation note: the live KG is the Obsidian-style graph — `react-force-graph-3d` 3D
  node-link view (`apps/web/src/pages/intelligence/`), backed by `memory_edges` merging DB
  foreign keys (`relation='fk'`, authoritative) with analyst `[[type:slug]]` wikilink mentions
  (`relation='mention'`). Do NOT confuse with `microsoft-graph-sync` (MS Graph email). Do NOT
  build a second graph; extend this one.

### A19. Evaluation / Red Team — status: DEFER full suite; leakage+grounding gates EARLY (§6 Phase 0/4)
- Tools: `run_grounding_eval`, `test_bill_summary_accuracy`, `test_vote_history_accuracy`,
  `test_deadline_detection`, `test_cross_client_leakage`, `test_compliance_false_negatives`,
  `test_stale_source_detection`, `test_claim_map_precision`, `review_artifact_quality`
- Datasets: gold-standard bill summaries, known vote histories, known regulatory dockets, known
  LDA/FARA examples, known procurement awards, historical client campaigns, stale-source test
  set, unsupported-claim corpus, reviewer-labeled artifacts
- Categories (per §6 SC4.1): hallucination, stale-source, wrong bill version, wrong
  member/district, missed deadline, unsupported claim, tool-selection accuracy, cross-client
  leakage, compliance false-negative, citation precision, "what changed?" recall.

---

## Appendix B — Canonical entity identifiers (KG normalization)

Entity resolution across all capabilities MUST key on stable IDs, not names. Required IDs:

| Domain | Identifier |
|---|---|
| Member of Congress | Bioguide ID |
| Bill | Congress.gov bill ID |
| Committee | committee ID |
| Public company | CIK |
| Federal entity/contractor | UEI, CAGE |
| Regulation | RIN |
| Rulemaking docket | docket ID |
| Contract award | award ID |
| Grant | FAIN |
| Assistance program | Assistance Listing / CFDA |
| Industry/product code | NAICS, PSC |
| Defense program | program element ID |
| Internal | client ID, contact ID |
| Live hearing | hearing session ID, transcript segment ID |

`resolve_entity` + `merge_duplicate_entities` (A18) enforce this. A new entity without its
canonical ID is a normalization gap to flag, not silently dual-write.

---

## Appendix C — Tool vs capability vs agent classification (decision rule)

Rule: retrieves/mutates ONE bounded thing → **tool**. Coordinates many tools over time →
**capability module**. Reasons across many capabilities or runs independently → **agent/worker**.

- TOOLS (examples): `search_bill`, `search_hearing`, `search_votes`, `get_client_context`,
  `search_lda_filings`, `search_federal_register`, `search_program_element`, `create_task`,
  `send_email`, `create_word`, `run_analysis`, `start_live_transcription`,
  `commit_final_transcript_segment`.
- CAPABILITY MODULES: Legislative, Vote/Whip Targeting, Hearing, Live Hearing, Regulatory,
  Defense Budget, Compliance, Client Intelligence, Document Generation (Appendix A).
- AGENTS/WORKER: Research, Writing, Monitoring, Analytics, Compliance (plan-modes — §2.1), and
  the Live Hearing Session Worker (the only true separate runtime).
- ANTI-PATTERN — do NOT create: `Bill Search Agent`, `LDA Agent`, `GAO Agent`, `PE Agent`,
  `Census Agent`, `Email Agent`. Those stay tools or capability modules.

---

## Appendix D — Product surface routing (which surface for which job)

| Surface | Best for |
|---|---|
| Full Meri Chat | complex research, "what should we do?", client strategy, drafting, office targeting, doc generation, compliance-aware workflows |
| In-Editor Assistant | editing memos, tightening asks, improving nexus, grounding claims, source-backed changes, doc-scoped Q&A |
| Issue Dashboard | current status, what changed, upcoming deadlines, office targets, open tasks, artifacts, claim confidence, stale-source warnings |
| Live Hearing Room | real-time transcript, live summary cards, client-relevance alerts, timestamped quote capture, action-item extraction, post-hearing summary |
| Monitoring Inbox | scheduled alerts: new bills, hearing changes, Fed Register updates, contract/grant opportunities, LDA/FARA changes, deadline alerts |
| Compliance Console | approvals, outbound contact audits, LDA/FARA checks, gifts/travel review, procurement firewall, conflict checks, live-hearing consent policy |

---

## Appendix E — Bill Tracker ↔ Hearing Watch: two modules, one engine

A core design decision: **Bill Tracker and Hearing Watch are SEPARATE modules that feed the
SAME shared intelligence engine.** Neither owns the other; both are inputs to one engine that
produces unified outputs. This is already half-built in the repo and must not be re-forked.

### E.1 Mapping to existing code
- **Bill Tracker** = `apps/api/src/tracker/` (real today): tracks legislative data, amendments,
  actions, votes, hearings-as-events. Has `tracker-change-detector.service.ts`,
  `tracker-relevance.util.ts`, alert/email/SMS notifications, `bill-stage.util.ts`.
- **Hearing Watch** = the hearing modules (`sync-hearings.ts`, `HearingsMarkupList.tsx`, witness
  extraction) PLUS Live Hearing Intelligence (§4, Phase 5): tracks hearings, audio/video,
  Deepgram transcripts, speakers, stance, sentiment.
- **Shared Capiro Intelligence Layer** = the engine both feed: client watchlists, issue
  taxonomy, semantic matching, impact/relevance scoring. In code this is
  `tracker-change-detector` + `tracker-relevance.util` + `emit-changes` resolving against the
  KG (Appendix A18) and emitting through the ONE alert taxonomy (§8).
- **Unified Outputs** = alerts, briefs, memos, action items, archive search — all via the
  shared alert taxonomy and Document/Artifact Generation (A16), NOT per-module silos.

### E.2 Bidirectional triggers (the requirement)
The two modules are wired to each other THROUGH the shared engine, not directly:
- **Bill movement → Hearing Watch**: a tracked bill reaching markup/floor stage, or a new
  committee action, raises a "watch upcoming hearings on this bill/committee" signal.
- **Hearing insight → Bill record**: a captured hearing quote / witness stance / member
  position signal (including from a Live Hearing session, §4.6) updates the bill record's
  intelligence and can change office-targeting or amendment-opportunity state.
- Both directions flow through `tracker-change-detector` → relevance scoring → §8 alert
  taxonomy, so a bill-driven and a hearing-driven alert are the SAME shape and land in the SAME
  inbox. No second alert pipeline.

### E.3 Build implication
- Do NOT build Hearing Watch (or Live Hearing) as a standalone tracker with its own
  change-detection + alerting. Register its events INTO the existing `tracker-change-detector` /
  `emit-changes` chain so the shared engine fans them out.
- The cross-link (bill ↔ hearing) is an edge in the Knowledge Graph (A18) keyed on canonical IDs
  (Appendix B): `bill_id`, `committee_id`, `hearing session ID`. Resolve, don't string-match.
- This is consistent with §7.1 (MeriV2 emits through the existing emit-changes chain) and §8
  (one alert taxonomy) — Appendix E is the concrete bill/hearing instance of that principle.
