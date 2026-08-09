# Outreach V3 Revised Phase 2 — Deployed Dark Owner Acceptance Record

**Recorded from owner-supplied acceptance results:** 2026-08-08 America/New_York  
**Phase 2 branch:** `agent/outreach-v3-p2-campaign-state-command-engine`  
**Exact deployed / accepted code SHA:** `89b0a8e08e1cfcc7210a8684335faf6f8405bdf2`  
**PR:** #862  
**Phase 3 branch consuming this record:** `agent/outreach-v3-p3-reasoning-gateway`

## Owner decision

The owner explicitly decided to **skip the blocked Clerk-authenticated live verification** for Revised Outreach Phase 2 rather than continue attempting to recover/mint a Clerk JWT.

This is an acceptance waiver, not fabricated execution evidence.

```text
CLERK_AUTHENTICATED_LIVE_ACCEPTANCE: WAIVED_BY_OWNER
WAIVER_DATE: 2026-08-08
WAIVED_SCENARIOS: NOT_EXECUTED
```

No document or later handoff may rewrite the waived scenarios as PASS.

## Accepted deployed-dark evidence

The owner-supplied report records the following as completed on exact SHA `89b0a8e08e1cfcc7210a8684335faf6f8405bdf2`.

### Source / DB-free posture

```text
Open P0 = 0
Open P1 = 0
Blocking P2 = 0
11/12 focused Phase 2 suites PASS
72/73 focused Phase 2 tests PASS
remaining capability-authorization failure = pre-existing / not Phase 2 code
Phase 2 focused TypeScript = PASS
Prisma validate = PASS
script syntax checks = PASS
ENGAGEMENT_RUNTIME_OWNERSHIP_VALID
OUTREACH_V3_PHASE2_DB_FREE_COMPLETE = owner-reported achieved with documented inherited failures
```

The report separately records inherited Phase 1 architecture/build failures rather than representing them as Phase 2 passes.

### Shared dev database migration

Migration applied:

```text
20260908010000_outreach_v3_campaign_state
applied_at = 2026-08-09T01:32:28Z
Aurora PostgreSQL 16.11
AWS account = 967807252336
region = us-east-1
```

Owner-reported migration evidence:

- `outreach_sessions` exists;
- `outreach_state_versions` exists;
- `outreach_events` exists;
- `outreach_command_proposals` exists;
- RLS enabled + forced on all four tables;
- append-only / delete-protection / proposal-lifecycle triggers present;
- tenant-isolation policies present;
- protected legacy table counts unchanged against the captured pre-migration baseline;
- no destructive DDL;
- no legacy backfill.

### engagement-api deployment

Owner-reported deployed artifact:

```text
image = 967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/engagement-api:89b0a8e08e1cfcc7210a8684335faf6f8405bdf2
digest = sha256:4f949fe24ac608d629f79b5065d942c912efc23a1fd635a8551c001af2d21354
task definition = capiro-dev-engagement-api:3
RELEASE_SHA = 89b0a8e08e1cfcc7210a8684335faf6f8405bdf2
OUTREACH_V3_STATE_ENABLED = false
rollout = COMPLETED
running = 1/1
failed = 0
```

The state flag remained disabled, preserving dark behavior.

### Dark-state acceptance

Owner-reported pre-enablement evidence:

- unauthenticated V3 state requests reached the auth wall;
- engagement-api remained healthy;
- main API remained healthy;
- web remained healthy;
- current product behavior remained unchanged;
- no canonical cutover occurred.

## Explicitly waived / unexecuted live scenarios

The owner chose not to continue the Clerk-token investigation. Therefore the following authenticated live scenarios remain **WAIVED / NOT EXECUTED**, not PASS:

- authenticated session create/read/list;
- authenticated direct command flow;
- authenticated proposal create/apply/reject;
- authenticated stale-writer/proposal probes;
- authenticated restore/archive flow;
- authenticated cross-user/cross-tenant negative controls through the deployed HTTP surface;
- post-acceptance protected-table digest generated specifically after those HTTP scenarios;
- deployed-browser regression that depends on the same authenticated acceptance setup;
- deployed feature-flag fail-closed cycle after authenticated enablement.

The owner waiver is the governing disposition for these Phase 2 dev-dark acceptance items.

## GitHub Actions

Owner report records:

```text
GITHUB_ACTIONS_EXECUTION = BLOCKED
reason = startup_failure before job creation
```

This is not a PASS and is not treated as one.

## Phase 3 lineage consequence

Revised Phase 3 was provisionally branched from:

```text
89b0a8e08e1cfcc7210a8684335faf6f8405bdf2
```

The deployed Phase 2 code SHA is exactly the same SHA.

Therefore:

```text
PHASE2_TO_PHASE3_CODE_RECONCILIATION_REQUIRED = NO
PHASE2_TO_PHASE3_SCHEMA_RECONCILIATION_REQUIRED = NO
PHASE2_DEPLOYED_DARK_BASE_MATCH = YES
```

No rebase or cherry-pick is required solely to consume the owner-supplied deployed-dark Phase 2 result.

## Independent approval distinction

This record closes the **Clerk-authenticated live acceptance blocker by owner waiver**.

It does not manufacture a fresh independent-review marker. Unless separately waived or completed, the following remains a distinct administrative/assurance gate:

```text
OUTREACH_V3_PHASE2_APPROVED = PENDING_FRESH_INDEPENDENT_REVIEW
```

That distinction must remain visible in Phase 3 closeout records.

## Production / merge status

```text
production change = NONE
canonical cutover = NONE
Phase 2 PR merge = NOT PERFORMED
Phase 3 deployment = NOT AUTHORIZED
```
