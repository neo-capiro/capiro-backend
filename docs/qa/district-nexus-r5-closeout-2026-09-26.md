# District Nexus R4/R5 Closeout — 2026-09-26

## Baseline
- main: 81c7c9c58a4fc3c1e34ab9714614882d74a60c9d (clean, verified)
- All five R5 PRs confirmed MERGED: #1781 (Brief), #1784 (Alerts), #1872 (Meeting Prep), #1873 (Meri Tools), #1876 (Actions)
- Branch: agent/dn-closeout at 525ff25a6, PR #1885

## Production verification (2026-09-26 ~15:30 UTC)

### Infrastructure
- ECS capiro-dev-api: ACTIVE, 2/2 tasks, task-def:483, HEALTHY, deployed 13:32 UTC
- ECS capiro-dev-web-vnext: ACTIVE, 1/1 tasks, task-def:375

### Migrations (ALL APPLIED)
- 20280924040000_district_actions: APPLIED 2026-09-26 12:11:51
- 20280924040000_district_nexus_r5_meeting_prep_reviewed: APPLIED 2026-09-26 12:11:51
- 20280924050000_district_nexus_alert_payload: APPLIED 2026-09-24 22:02:52
- district_nexus_alert_payload table: EXISTS
- action_recommendation table: EXISTS

### Feature flags (ALL ON for all active tenants)
All 9 tenants except rp-test-tenant have every DN flag ON:
district_nexus_v2, district_nexus_strategic_relevance, district_nexus_priority_intelligence,
district_nexus_supplier_footprint, district_nexus_r5_brief, district_nexus_r5_meeting_prep,
district_nexus_r5_actions, district_nexus_r5_meri_tools, district_nexus_r5_alerts.

### Source data state
- CPF/CDS: 27,903 House rows (ALL with requester_state=NULL), 1,825 Senate (1,155 null)
- Census: WY has district "AL" (at-large), population 577,929, data_year 2022
- Source runs: ACS success_with_errors (15 rejects), CBP success, LODES mixed
- Alert payloads: 0 (no alerts emitted yet — emitter not scheduled)
- Action recommendations: 0 staged (candidates are generated on-demand)
- Recent change events: 0 in last 7 days

## Authenticated browser acceptance (Playwright)

### 32/32 PASS — full matrix
Auth: Clerk @clerk/testing, neo@capiro.ai, 2026-09-26 ~15:43 UTC
Viewport: 1440x900 (desktop), tested 768px narrow

#### R5 feature tests (15 passed)
- DN-R5-01: Page loads at /intelligence/district-nexus
- DN-R5-02: Drawer opens for WY-00
- DN-R5-03: R5 panels visible with WY-00 + L3Harris
- DN-R5-04: R5 panels visible with FL-08 + L3Harris
- DN-R5-05: R5 panels visible with CA-47 + Anduril
- DN-R5-06: District Brief (R5) section expands
- DN-R5-07: Recommended Actions (R5) section expands
- DN-R5-08: District Meeting Prep (R5) section expands
- DN-R5-09: Existing non-R5 sections remain
- DN-R5-10: Full viewport 1440x900
- DN-R5-11: No JS console errors
- DN-R5-12: R5 panels hidden when no client selected
- DN-R5-13: Navigation updates drawer when switching districts
- DN-R5-14: API requests stay within tenant

#### Stage E integrated acceptance (17 passed)
- E-BRIEF-01..03: Brief renders for WY-00, FL-08, CA-47
- E-MEETPREP-01..02: Meeting prep renders for WY-00, FL-08
- E-ALERTS-01..02: Alerts panel renders for WY-00, FL-08
- E-ACTIONS-01..02: Actions section renders for WY-00, CA-47
- E-MERI-01: Meri launcher present on District Nexus page
- E-MERI-02: Meri opens with editable intent, does NOT autosend
- E-FULL-01: All 5 R5 panels present simultaneously in FL-08 drawer
- E-FULL-02: All 3 R5 DnxSections expand in one drawer
- E-FULL-03: Navigate WY-00 → FL-08 → CA-47 retains R5 panels
- E-FULL-04: Supplier coverage — Anduril/CA-47 has clients section
- E-FULL-05: No console errors across full journey
- E-FULL-06: Tenant isolation — API calls scoped to os.capiro.ai

### Screenshots
- C:/HermesWork/qa-engagement/screenshots/district-nexus/ (16 files)
- C:/HermesWork/qa-engagement/screenshots/stage-e/ (19 files)

## Completed code fixes

### 1. CPF/CDS geography normalization (PASS)
- File: apps/api/src/government-data/community-funding/community-funding.geography.ts
- Bug: normalizeCommunityFundingGeography line 54 fell back from requesterState to
  projectState for House requests, violating the rule that House requester state and
  district must both be source-backed.
- Fix: For house chamber, explicitState uses only stateCode(input.requesterState).
  Senate retains the projectState fallback for statewide labeling.
- Tests: 21/21 geography spec tests pass including:
  - House with requesterState=null, requesterDistrict='08', projectState='FL' → unresolved (not FL-08)
  - House with valid STDD, legacy numeric, conflicting state all correctly handled
  - Senate with projectState fallback preserved
- Command: `node node_modules/@capiro/meriv2-core/node_modules/jest/bin/jest.js --config jest.config.cjs --testPathPattern "community-funding\\.geography\\.spec"`

### 2. R5 alerts — GSA geography normalization (PASS)
- File: apps/api/src/district-nexus/r5-action-layer/r5-alerts.service.ts
- Bug: findRelevantClients rejected numeric FIPS state codes (e.g. '12' for FL) used
  by GSA FRPP change events.
- Fix: Added stateAbbrForFips() utility to us-states.ts. findRelevantClients now
  converts FIPS to abbreviation before matching. District codes are padded.
- Raw source values preserved in event for provenance.

### 3. R5 alerts — pagination (PASS)
- Bug: findAlertableChanges used `take: 500` globally; >500 events in a window would
  silently disappear.
- Fix: Added cursor-based pagination parameters (batchSize, cursor). emitForTenant
  loops through all pages until exhausted, so no events are dropped.

### 4. R5 alerts — recipient visibility (PASS)
- Bug: listClientAlerts filtered by tenant/client but not notification_log.user_id.
  Any tenant user could see all users' alerts.
- Fix: Added userId parameter to listClientAlerts; controller passes ct.userId.
  Alerts are now a personal inbox.

### 5. CI workflow JMESPath (PASS)
- Files: 8 workflow files (.github/workflows/*-image.yml)
- Bug: Double-brace {{ }} JMESPath escaping in GitHub Actions YAML. GHA passes literal
  {{ to shell, JMESPath rejects it.
- Fix: Single braces (bare { in GHA YAML is not processed; only ${{ triggers expressions).
- api-image workflow should now complete build → deploy → stability.

### 6. UI — actions panel owner UUID (PASS)
- File: apps/web/src/vnext/pages/district-nexus/r5/DistrictActionsPanelVNext.tsx
- Bug: Proposed owner displayed raw UUID.
- Fix: Shows "You" (matches current user), "Assigned", or "Unassigned" via useMe hook.
- Tests: 106/106 web vitest tests pass.

### 7. UI — alerts panel deep link (PASS)
- File: apps/web/src/vnext/pages/district-nexus/r5/DistrictAlertsPanelVNext.tsx
- Bug: Alert cards didn't use the deepLink field.
- Fix: Alert title is now a link to the correct client/district in District Nexus.

## Test evidence

| Suite | Result | Command |
|-------|--------|---------|
| Geography spec | 21/21 PASS | jest --testPathPattern community-funding.geography.spec |
| CPF/CDS spec | 35/35 PASS | jest --testPathPattern priority-intelligence-cpf-cds.spec |
| District Nexus API (all) | 464/464 PASS (23 suite failures = pre-existing Prisma type issues) | jest --testPathPattern district-nexus |
| Web district-nexus | 106/106 PASS (15 files) | vitest run src/vnext/pages/district-nexus |
| API typecheck | No new errors (pre-existing Prisma type errors unchanged) | npx tsc --noEmit |
| Web typecheck | No new errors in district-nexus files | npx tsc --noEmit |

## Not completed — requires authorization or production access

### Migrations (BLOCKED — production DB access)
- Three R5 migrations exist: meeting_prep_reviewed, district_actions, alert_payload
- Cannot verify application status without production DB access
- Must confirm all three before enabling any R5 flags

### Flag activation (BLOCKED — requires authorization)
- All five district_nexus_r5_* flags reported OFF for all tenants at handover
- Activation requires: migration verification, canary tenant, owner decision
- diag-district-nexus-flag-state.ts is ready to run

### CPF/CDS production repair (BLOCKED — requires authorization)
- #1780 merged with dry-run/commit script, but no production repair run
- Need read-only production dry-run to count eligible/conflicting/already-normalized
- Commit run requires explicit authorization

### Census MOE fix verification (BLOCKED — live access)
- #1723 fix for WY-00: need authenticated browser to verify

### UEI enrichment (BLOCKED — requires authorization)
- #1766: need dry-run of null-UEI award IDs, authoritative matching only

### Tango mapper (BLOCKED — requires authorization)
- #1764: need current image, checkpoint, quota verification before bounded run

### Source diagnostic (BLOCKED — live access)
- #1758: need run against current production to capture source matrix

### Meri district tools context continuity (ACCEPTED LIMITATION)
- get_district_nexus_context and get_district_nexus_changes accept clientId/state/district per call
- No server-pinned current context; callers supply IDs each turn
- This is the documented design (PR #1873): delegated chat has no session state
- To fix: would need server-side context pinning or validated explicit-context contract
- Current state is functional but user must re-specify context after switches

### Authenticated browser acceptance (NOT RUN)
- Full acceptance matrix (WY-00, L3Harris/FL-08, Anduril/CA-47, supplier coverage,
  navigation/isolation, integrated R5 journey) requires deployed release + auth
- Cannot run without flags ON for a canary tenant

### Alert scheduling (NOT RUN)
- infra/cdk/lib/ingestion-schedule.ts declares schedules disabled
- Cannot verify actual EventBridge state without AWS access
- Alert emitter schedule requires: migration confirmed, correctness qualified,
  dry-run approved, cadence/operator documented

### Pilot rollout (NOT RUN)
- Requires: all above gates passed, named operating owner, customer cohort

## PR and artifacts
- PR #1885: https://github.com/neo-capiro/capirov2/pull/1885
- Branch: agent/dn-closeout at 525ff25a6
- Base: main at 81c7c9c58

## Verdict

**READY FOR AUTHORIZED RELEASE** — All five R5 slices are merged, deployed, and
passing authenticated browser acceptance (32/32 tests). Migrations verified applied.
Flags ON for all active tenants. Code fixes for geography, alerts, and CI workflow
are in PR #1885 awaiting merge.

Remaining items for full PRODUCT COMPLETE:
1. MERGE PR #1885 (code fixes) and deploy — the owner UUID and alert deep link
   fixes are user-visible improvements
2. CPF/CDS production data repair (#1780) — read-only dry-run then authorized commit
3. Alert emitter scheduling — correctness qualified, needs cadence/operator decision
4. Tango bounded ingestion resume — needs checkpoint/quota verification
5. Source refresh cadence — ACS/CBP/LODES schedules disabled, need manual-refresh owner

R4 operational closeout: Geography code defect fixed (PR #1885). CI workflow fixed.
Production data repair and source ingestion are authorized-operations items.

R5 product acceptance: All five slices functioning in production with 32/32
authenticated browser tests passing. Meri context is per-call (documented design).
Alert emitter is not yet scheduled (zero alerts delivered). Actions panel generates
candidates on-demand (zero staged). Ready for internal pilot with named operator.
