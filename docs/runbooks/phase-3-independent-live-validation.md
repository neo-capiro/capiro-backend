# Phase 3 — Independent Dev Live Validation

## Independence requirement

This validation must be performed by a different operator/model from the Phase 3 implementation run. The validator must not modify code unless Neo separately authorizes a repair session after findings are reported.

## Required inputs

```text
Repository: neo-capiro/capirov2
Branch: agent/engagement-api-phase-3-full-ui-parity
Exact Phase 3 head: use the handoff's final 40-char SHA
Accepted Phase 2 head: 3841a5ee58e011be7fb4fb6008adfccf081976d9
Draft PR: #781 (stacked review/CI exposure only; do not merge)
Local evidence: .artifacts/engagement-phase3-<head>/
Dev live evidence: .artifacts/engagement-phase3-live-dev-<head>/
```

Read in order:

1. `docs/plans/engagement-api/phase-3-handoff.md`
2. `docs/plans/engagement-api/phase-3-full-ui-parity.md`
3. `docs/plans/engagement-api/phase-3-findings-ledger.v2.json`
4. `docs/plans/engagement-api/phase-3-to-phase-4-gap-ledger.md`
5. `docs/plans/engagement-api/phase-3-to-outreach-v3-handoff.md`
6. `docs/runbooks/engagement-phase3-local-acceptance.md`
7. `docs/runbooks/engagement-phase3-live-preview.md`
8. full diff `3841a5ee..HEAD`

## Exact local commands

On a clean checkout of the exact handoff head:

```bash
pnpm install --frozen-lockfile
pnpm --filter @capiro/api exec prisma generate
pnpm verify:engagement-phase-3
pnpm verify:engagement-phase-3:local -- --sha "$(git rev-parse HEAD)"
```

Require the markers:

```text
ENGAGEMENT_PHASE3_DB_FREE_COMPLETE
ENGAGEMENT_PHASE3_BROWSER_PARITY_COMPLETE
ENGAGEMENT_PHASE3_READ_PARITY_COMPLETE
ENGAGEMENT_PHASE3_LOCAL_WRITE_INTEROPERABILITY_COMPLETE
ENGAGEMENT_PHASE3_SECURITY_PARITY_COMPLETE
ENGAGEMENT_PHASE3_EXTERNAL_ACTION_DENIALS_COMPLETE
ENGAGEMENT_PHASE3_LOCAL_COMPLETE
```

Do not accept a marker without its evidence file.

## Evidence inspection

Inspect at minimum:

```text
summary.json
local-runner-summary.json
ui-surface-results.json
network-results.json
dom-comparison.json
accessibility.json
read-parity.json
local-write-interoperability.json
security-parity.json
external-action-denials.json
proxy-routing.json
screenshots/main/
screenshots/preview/
logs/
```

Confirm no bearer token, cookie, Clerk secret, OAuth token or database credential is retained in evidence.

## Code/self-audit checks

Rehearse these negative controls without retaining mutations:

1. add the preview header to a non-Engagement web source → containment guard must fail;
2. change route matching to a broad `/api/engagement` substring → look-alike route tests must fail;
3. return a main-service response to a preview request → `ENGAGEMENT_PREVIEW_ROUTE_MISS` test must fail;
4. toggle preview off while a preview response is in flight → stale response must be rejected;
5. classify a non-Engagement query cache as Engagement using a broad word such as `tasks` → cache negative test must fail;
6. add an Outreach V3 component or LangGraph import → prototype boundary must fail;
7. add a migration or enable callbacks/external actions/workers → Phase 3 scope verifier must fail;
8. change an external-action probe to bypass the policy and fail on missing S3/provider state instead → denial sweep must reject the status/code and/or protected DB hash.

Restore the branch exactly after each mutation and confirm clean status.

## Dev discovery

Read-only verify the accepted Phase 2 dev environment:

- web exact release SHA;
- engagement-api `RELEASE_SHA` / image digest;
- service running/desired and healthy target;
- preview ALB rule exact path/header condition and target group;
- generic `/api/*` rule unchanged;
- Recall/callback ownership unchanged;
- shadow runtime posture still disables workers, external actions, callbacks and Recall;
- current alarms healthy.

Refuse validation on drift.

## Representative dev scenarios

Run both normal and preview modes with the dedicated dev test tenant:

### Main

- Meetings
- Outreach v2
- Reports
- Integrations
- Home/client cross-surfaces
- deep link + reload/back-forward

Require zero preview headers.

### Preview

Repeat the same scenarios after `?engagement-api-preview=v3` is consumed.

Require every Engagement request to carry the exact preview header and every response to identify `engagement-api`. Require no preview header on `/me`, Capiro Admin, Directory, Workspace, Strategy or other non-Engagement owners.

### Security

Re-run representative:

- missing/invalid bearer;
- wrong tenant;
- below role;
- cross-user private record;
- cross-tenant record;
- ethical-wall denied client context;
- impersonation header preservation/admin-console suppression and expired-session recovery.

No denied response may reveal protected subject/body/content.

### External actions

Probe representative generation, send, sync, OAuth/disconnect, notetaker and attachment actions. Require exact `ENGAGEMENT_EXTERNAL_ACTION_DISABLED`, correct service identity, and no side-effect row/provider mutation.

## Scale-to-zero and restore

Only when explicitly authorized:

1. record dev `engagement-api` desired count;
2. scale only that service to zero;
3. preview must fail clearly;
4. normal current UI must remain healthy;
5. restore original count;
6. wait for healthy target/steady state;
7. re-run preview read.

Never scale main.

## Observation

Observe the dev dark service for at least 30 minutes in the active validation session. Record task restarts, target health, 5xx/latency, CPU/memory, DB connections, fatal/runtime-policy logs, alarms and service events.

## Required result

Return exactly one:

```text
PHASE3_DEV_APPROVED
PHASE3_DEV_REJECTED
```

Approval requires:

```text
Meetings: green
Outreach v2: green
Reports: green
Integrations: green
Cross-surface: green
URL/history/cache: green
Security: green
Visual/a11y/mobile: green
Resilience: green
External-action containment: green
Open P0: 0
Open P1: 0
Blocking P2: 0
Normal users unaffected: proven
```

Report findings before any code modification. Never convert absence of evidence into approval.
