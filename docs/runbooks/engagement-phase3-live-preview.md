# Engagement Phase 3 — Dev Live Preview Acceptance

## Authorization boundary

This runbook mutates the dev web release and may temporarily scale **only** the dev `engagement-api` service. Execute only with explicit dev-live authorization and the accepted Phase 2 dark deployment healthy.

Production is not authorized by this runbook.

## Preconditions

- Phase 3 code/local gate green on one exact SHA;
- `capiro-dev` Phase 2 dark service independently approved;
- dedicated test tenant/users only;
- preview rule remains exact path + `X-Capiro-Engagement-Preview: v3`;
- ordinary Engagement traffic still targets main;
- shadow posture:
  - `ENGAGEMENT_BACKGROUND_OWNER=disabled`
  - `ENGAGEMENT_EXTERNAL_ACTIONS=disabled`
  - `ENGAGEMENT_CALLBACKS_ENABLED=false`
  - `ENGAGEMENT_RECALL_WEBHOOK_ENABLED=false`
- no migration;
- current product healthy;
- rollback operator available.

## Read-only preflight

Record:

```text
Phase 3 web SHA
engagement-api RELEASE_SHA + image digest
ECS desired/running count
preview listener rule ARN/priority/conditions
main generic /api/* rule
Recall/callback routing
shadow task-definition posture
healthy target count
current alarms
```

Refuse to continue on drift.

## Web release

Deploy only the Phase 3 web build from the exact accepted SHA using the existing web release mechanism. Do not deploy the historical Compute stack and do not change the generic API rule.

Preview remains off for ordinary users because activation requires the internal query parameter and sessionStorage value.

## Main baseline

Without preview activation, run the current Engagement experience and record network evidence:

- Meetings;
- Outreach v2;
- Reports;
- Integrations;
- Home/client cross-surfaces;
- deep links/reload/back-forward;
- desktop and mobile representative states.

Require zero preview headers.

## Preview

Open a dedicated test browser/session with:

```text
?engagement-api-preview=v3
```

Confirm the parameter is consumed and the fixed indicator is visible.

Run the same surface matrix. For every Engagement request require:

```text
X-Capiro-Engagement-Preview: v3 (request)
X-Capiro-Service: engagement-api (response)
```

Non-Engagement requests must not carry the preview header.

## Security and containment

Use only dedicated test data. Re-run representative auth/tenant/ownership denials and the external-action matrix. Every external action must fail before side effects with:

```text
503
ENGAGEMENT_EXTERNAL_ACTION_DISABLED
```

Confirm no send intent/job/provider mutation, OAuth mutation, sync mutation, Recall bot action, or external attachment mutation occurred.

## Scale-to-zero rehearsal

Requires explicit authorization for this exact mutation.

1. Record current desired count.
2. Scale **only** `engagement-api` desired count to zero.
3. Verify preview fails clearly / has no healthy target.
4. Verify ordinary current UI remains healthy on main.
5. Restore the prior desired count.
6. Wait for ECS steady state and healthy target.
7. Re-run one preview read and confirm service identity.

Never scale the main API.

## Observation

Observe the dev dark service for at least 30 minutes in the active validation session. Record:

- task restarts;
- target health;
- 5xx and latency;
- CPU/memory;
- DB connections;
- runtime-policy/fatal logs;
- alarms;
- deployment/service events.

Stop on auth/tenant mismatch, external-action escape, sustained 5xx, DB-budget breach, or main-product degradation.

## Evidence directory

Use:

```text
.artifacts/engagement-phase3-live-dev-<sha>/
```

Redact tokens, cookies, secrets and unnecessary confidential content.

## Exit

Only a fully evidenced run may return:

```text
PHASE3_DEV_LIVE_GREEN
```

Otherwise return `PHASE3_DEV_LIVE_BLOCKED` with the exact failed prerequisite or assertion. A code-complete branch does not imply live acceptance.
