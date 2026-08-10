# Outreach V3 Revised Phase 6 — Conversational UI Implementation Handoff

## Repository state

Repository: `neo-capiro/capirov2`

Branch:

```text
agent/outreach-v3-p6-conversational-ui
```

Base Phase 5 head:

```text
835cdef35cd8ecb23faf1b100ecfc743bcd31128
```

Draft PR:

```text
#891
```

Resolve and record the exact final Phase 6 head after all verification repairs. Do not use a stale SHA from this handoff.

## Status

```text
Phase 6 source implementation: PRESENT
Final Figma mockup contract: FROZEN
Phase 6 exact-head code gate: PENDING REAL EXECUTION
Combined Phase 4–6 gate: PENDING REAL EXECUTION
Deployed authenticated browser acceptance: PENDING
Independent validation: PENDING
Merge: NOT AUTHORIZED
AWS deployment: NOT AUTHORIZED
```

GitHub Actions attempts observed during implementation ended in `startup_failure` before any job started. That condition is recorded as environment-blocked, never as test evidence.

## Accepted visual contract

Figma:

```text
file  2aa9ipR2qOfumaixZErCfU
page  618:1391
name  28 · Hi-Fi Prototype · Outreach V3
```

The implementation manifest records every accepted desktop/mobile/recovery node:

```text
docs/plans/outreach-v3/revised-phase-6-design-to-state-manifest.md
```

Figma is the visual/responsive source of truth. The Campaign Spec, command protocol, sponsor/target/context authorization, and roadmap remain the security/action source of truth.

## Delivered product architecture

### Default-off, two-switch preview

V3 UI is shown only when:

```text
Engagement API preview = v3
AND
Outreach V3 UI preview = v3
AND
no existing Classic draft is being opened
```

Classic Outreach remains the default and the fallback.

### Canonical state

The UI uses one session hook over the Phase 2 state API.

It does not persist a second Campaign Spec or authoritative wizard stage in the browser.

The current required stage is derived from backend readiness. Generation/draft/preflight blockers owned by the next phase are excluded only from the planning-complete calculation; they are never presented as implemented authority.

### Conversation

- always available beside the desktop decision surface;
- responsive/stacked on narrow screens;
- bounded free text through the Phase 3 reasoning endpoint;
- reasoning may create pending proposals only;
- reasoning outage leaves all deterministic campaign controls usable;
- retry resets only reasoning continuity, not campaign state;
- typing “send it” cannot send or create preflight in Phase 6.

### Goal

Goal-first deterministic read-back captures:

```text
goal
objective
topic
desired outcome
explicit ask OR no formal ask
why now
```

No client is required and no target is selected.

### Sponsor

Explicit supported branches:

```text
firm
one client
several clients
coalition / association
internal team
no formal sponsor
```

Sponsor is never inferred from the global selected-client state. Sponsor never adds recipients.

Client and multi-client branches use only the authorized clients supplied by the existing Engagement route. Multi-client UI states the Phase 5 client-neutral context restriction.

### Targets

Implemented target source views:

```text
Recommended
Directory
Client contacts
Recent contacts
Selected
Manual
Saved audiences — visibly unavailable in Phase 6
```

Behavior:

- initial recommendations are a read-only query;
- criteria commit only on explicit Search or Save criteria;
- no recommendation auto-adds;
- Add → disabled Added + separate Remove;
- Not relevant creates the exact recommendation rejection command;
- manual target is campaign-only and Save to Directory is off;
- profile exposes role, contactability, source, freshness, warnings, and approved personalization facts;
- sole-client campaigns may inspect bounded relationship metadata;
- coverage and selected-snapshot drift are visible.

### Delivery

Explicit patterns:

```text
personalized separate
uniform separate
shared thread
```

Recommendations are display-only. Cards select; Continue commits.

Shared thread requires recipient-visibility/reply-all acknowledgement, and high personalization is blocked.

### Governed context

Visible classes:

```text
required policy
writing guidance
campaign fact
target-specific
group-safe
excluded
```

The UI explicitly states:

```text
Style is not evidence.
```

Context candidates retain source, date, verification class, sensitivity, and exact scope. Target-specific candidates and accepted references name the only target they may influence.

Required policy is locked. Group-safe selection fails closed without a named group. Unverified factual evidence produces a visible readiness blocker.

The conversation never writes institutional memory automatically.

### Strategy

The deterministic recommendation is inspectable and editable.

The user confirms:

```text
campaign angle
tone
length
custom length instruction when required
```

No unrestricted prose generation path exists.

### Proposal review

Every pending proposal uses one shared review surface:

```text
current value
proposed value
exact command
expected state version
visible rationale
Discard
Edit manually
Apply
```

Stale Apply is disabled. Capiro never auto-rebases the proposal.

Edit rejects the pending proposal before opening the owning deterministic stage, so the proposal cannot later surprise-apply.

### Planning-complete boundary

Phase 6 ends truthfully at:

```text
The campaign plan is ready for governed generation.
```

It renders no generation, draft, approval, preflight, sender, test-send, final-send, provider, or retry action.

## Files

Primary UI:

```text
apps/web/src/pages/engagement/outreach/v3/OutreachWizardRouter.tsx
apps/web/src/pages/engagement/outreach/v3/OutreachV3Route.tsx
apps/web/src/pages/engagement/outreach/v3/OutreachConversation.tsx
apps/web/src/pages/engagement/outreach/v3/CampaignBrief.tsx
apps/web/src/pages/engagement/outreach/v3/CurrentDecisionSurface.tsx
apps/web/src/pages/engagement/outreach/v3/GoalDecisionSurface.tsx
apps/web/src/pages/engagement/outreach/v3/SponsorDecisionSurface.tsx
apps/web/src/pages/engagement/outreach/v3/TargetWorkspace.tsx
apps/web/src/pages/engagement/outreach/v3/DeliveryDecisionSurface.tsx
apps/web/src/pages/engagement/outreach/v3/ContextReviewSurface.tsx
apps/web/src/pages/engagement/outreach/v3/StrategyDecisionSurface.tsx
apps/web/src/pages/engagement/outreach/v3/ReadyForGenerationSurface.tsx
```

Contracts and state bridge:

```text
apps/web/src/pages/engagement/outreach/v3/contracts.ts
apps/web/src/pages/engagement/outreach/v3/decision-surface-contract.ts
apps/web/src/pages/engagement/outreach/v3/target-intelligence-contracts.ts
apps/web/src/pages/engagement/outreach/v3/commands.ts
apps/web/src/pages/engagement/outreach/v3/outreach-v3-api.ts
apps/web/src/pages/engagement/outreach/v3/useOutreachV3Session.ts
apps/web/src/pages/engagement/outreach/v3/outreach-v3-preview.ts
```

Styles:

```text
apps/web/src/pages/engagement/outreach/v3/outreach-v3.css
apps/web/src/pages/engagement/outreach/v3/target-workspace.css
apps/web/src/pages/engagement/outreach/v3/context-review-surface.css
apps/web/src/pages/engagement/outreach/v3/planning-surfaces.css
```

Verification:

```text
scripts/verify-outreach-v3-phase6-final.mjs
scripts/verify-outreach-v3-phase4-6-final.mjs
.github/workflows/outreach-v3-phase6-final.yml
.github/workflows/outreach-v3-phase4-6-final.yml
```

Runbook:

```text
docs/runbooks/outreach-v3-phase6-internal-preview.md
```

Findings:

```text
docs/plans/outreach-v3/revised-phase-6-findings.md
```

## Required executable closeout

Run from the exact intended head:

```bash
pnpm install --frozen-lockfile
pnpm --filter @capiro/api exec prisma generate

node scripts/verify-outreach-v3-phase6-final.mjs \
  --sha "$(git rev-parse HEAD)"

node scripts/verify-outreach-v3-phase4-6-final.mjs \
  --sha "$(git rev-parse HEAD)"

git status --short
```

Expected code markers:

```text
OUTREACH_V3_PHASE6_CODE_COMPLETE:<exact-head>
OUTREACH_V3_PHASE4_6_FINAL_CODE_COMPLETE:<exact-head>
```

The markers are valid only when the commands actually ran successfully. Source presence and a GitHub `startup_failure` are not substitutes.

## Deployed acceptance

After code gates and explicit AWS authorization, follow:

```text
docs/runbooks/outreach-v3-phase6-internal-preview.md
```

Required deployed marker:

```text
OUTREACH_V3_PHASE4_6_INTERNAL_PREVIEW_APPROVED
```

## Independent acceptance

A fresh reviewer must inspect the exact Phase 4–6 stack, run the accepted commands, inspect browser evidence, and return:

```text
OUTREACH_V3_PHASE4_6_APPROVED
```

Only after that marker, open P0/P1/blocking-P2 = 0, and a clean tree should the PR stack be considered mergeable.

## Explicit nonchanges

```text
No Outreach v2 removal
No V3 generation
No V3 draft creation
No V3 draft approval
No V3 preflight
No V3 send intent
No test send
No real send
No provider-delivery tool
No delivery retry
No institutional-memory commit
No new Fargate service
No backend ownership cutover
No Recall/callback/worker transfer
No Phase 6 Prisma migration
No AWS deployment
No feature enablement
```

## Current recommendation

```text
KEEP GOING
DO NOT MERGE
DO NOT SHIP
```

Reason: exact-head execution, combined Phase 4–6 validation, deployed browser acceptance, and independent review remain outstanding.
