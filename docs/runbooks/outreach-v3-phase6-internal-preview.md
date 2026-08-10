# Outreach V3 Phase 6 — Internal Preview and Rollback Runbook

## Purpose

Deploy and test the Phase 4–6 Outreach stack internally without replacing Classic Outreach, enabling generation/send authority, or changing canonical Engagement ownership.

This runbook does **not** authorize AWS mutation. Execute it only after:

```text
Phase 6 exact-head code gate PASS
Combined Phase 4–6 code gate PASS
Open P0 = 0
Open P1 = 0
Blocking P2 = 0
Explicit AWS authorization from Neo
```

## Runtime

Use the existing `engagement-api` service. Do not create `outreach-api` or another Fargate service.

Required backend flags for the internal task definition:

```text
OUTREACH_V3_STATE_ENABLED=true
OUTREACH_V3_REASONING_ENABLED=true
OUTREACH_V3_TARGETS_ENABLED=true
OUTREACH_V3_CONTEXT_ENABLED=true
```

Keep all later-phase authority disabled:

```text
No V3 generation endpoint
No V3 draft approval endpoint
No V3 preflight endpoint
No V3 send-intent endpoint
No provider-send tool
No delivery retry tool
```

Current background, callback, Recall, and external-action ownership stays unchanged.

## Database preflight

Phase 6 adds no migration. Before deployment, verify that the accepted Phase 2 campaign-state and Phase 3 reasoning-conversation migrations already exist in the target environment.

Do not run or rerun a shared database migration merely because the web UI is deploying. If a required migration is missing, stop and request separate migration authorization.

## Immutable artifacts

Record:

```text
Phase 4 SHA
Phase 5 SHA
Phase 6 SHA
web image digest
engagement-api image digest
task-definition revision
current ALB/listener rules
current feature-flag values
```

Deploy images by immutable digest, not a mutable `latest` tag.

## Activation

Both browser-session switches are required.

1. Activate Engagement API preview:

```text
?engagement-api-preview=v3
```

2. Activate Outreach V3 UI:

```text
?outreach-v3-preview=v3
```

The query parameters are consumed and the modes are stored in `sessionStorage`. They do not persist to a new browser session.

Opening an existing Classic draft always remains in Classic Outreach.

## Required internal test sequence

### A. Safe entry and fallback

1. Open Engagement → Outreach normally.
2. Confirm Classic Outreach is unchanged.
3. Activate Engagement preview only; confirm Classic remains visible.
4. Activate both switches; start a new campaign.
5. Turn V3 UI preview off and confirm Classic returns.
6. Reactivate V3 and confirm the canonical session resumes.

### B. Goal and sponsor

1. Start with a goal; confirm no client is required.
2. Confirm goal, objective, topic, desired outcome, ask/no-ask, and why-now.
3. Exercise firm, one client, several clients, coalition, internal, and no-sponsor branches.
4. Verify sponsor selection never adds a recipient.
5. Attempt an unauthorized or ethically walled client; verify nonleaking denial.

### C. Targets and profiles

1. Load recommendations and confirm no target auto-adds.
2. Search the Directory.
3. Search client contacts and recent contacts for a sole-client campaign.
4. Add, Added-disabled, Remove, and Not relevant.
5. Add a manual target; verify Save to Directory is off.
6. Open a profile; inspect role, email, source, freshness, warnings, and personalization facts.
7. Inspect relationship metadata for a sole-client campaign.
8. Confirm target snapshot drift is visible and no silent replacement occurs.

### D. Delivery

1. Confirm recommendations are visible but not selected.
2. Select personalized separate; Continue.
3. Select uniform separate; Continue.
4. Select shared thread without acknowledgement; verify blocked.
5. Acknowledge recipient visibility; Continue.
6. Confirm high personalization cannot be chosen for shared thread.

### E. Governed context

1. Search institutional memory and verify no result auto-applies.
2. Search government sources.
3. Confirm writing guidance is visually distinct from evidence.
4. Accept a campaign fact and inspect source/date/scope/verification.
5. Accept target-specific context and confirm the named target scope.
6. Attempt group-safe context without a named group; verify fail closed.
7. Confirm required policy cannot be excluded.
8. Confirm unverified factual evidence creates a visible readiness blocker.
9. Confirm no conversation content is written to institutional memory.

### F. Strategy and proposal safety

1. Inspect the deterministic strategy recommendation.
2. Confirm recommendation values are editable and not auto-applied.
3. Ask Meri for a proposal.
4. Inspect exact current/proposed values and commands.
5. Discard; confirm Campaign Spec unchanged.
6. Edit manually; confirm proposal rejected and owning stage opens.
7. Apply; confirm one new state version.
8. Create a proposal, mutate the campaign elsewhere, then attempt Apply; verify stale conflict and no auto-rebase.

### G. Model outage

1. Disable or break only the reasoning provider.
2. Confirm Campaign Spec, stages, targets, context, and deterministic controls remain usable.
3. Retry reasoning; verify the page and campaign state do not reload or reset.

### H. Phase boundary

1. Complete planning.
2. Confirm the final surface says governed generation is a later phase.
3. Search network traffic and verify zero V3 generation, draft, approval, preflight, send-intent, test-send, provider-send, or retry requests.
4. Type “send it”; verify no external action occurs.

### I. Responsive and accessibility

Test at minimum:

```text
1600 × 980 desktop
1280 × 800 desktop
1024 × 768 tablet
768 × 1024 tablet
390 × 844 mobile
360 × 800 mobile
200% browser zoom
keyboard only
screen reader smoke test
reduced motion
```

Verify:

- conversation remains available;
- composer remains reachable;
- no horizontal page overflow;
- stage and proposal actions are keyboard reachable;
- icon buttons have accessible names;
- dialogs/failures move focus predictably;
- touch targets meet policy;
- error text is announced;
- disabled controls use real disabled semantics.

## Evidence package

Archive under an exact-head directory:

```text
.artifacts/outreach-v3-phase4-6-<sha>/
  summary.json
  exact-head.txt
  environment.json
  desktop/
  tablet/
  mobile/
  accessibility/
  network/
  state-history.json
  proposal-conflict.json
  target-authorization.json
  context-isolation.json
  classic-regression.json
  logs/
```

Do not place confidential message, note, memory, or document bodies in the evidence package.

## Rollback

Fastest rollback is browser/session feature rollback:

```text
?outreach-v3-preview=off
?engagement-api-preview=off
```

Then disable backend V3 flags if needed. Classic Outreach remains available throughout.

If a deployment rollback is required:

1. restore the prior web image digest;
2. restore the prior engagement-api task-definition revision only if the API deployment changed;
3. do not destructively roll back additive Phase 2/3 database tables merely to disable the UI;
4. verify Classic Outreach and current Engagement routes;
5. preserve failed-session/event evidence for diagnosis.

## Acceptance marker

Internal preview passes only when a reviewer records:

```text
OUTREACH_V3_PHASE4_6_INTERNAL_PREVIEW_APPROVED
```

This marker is not production cutover authorization.
