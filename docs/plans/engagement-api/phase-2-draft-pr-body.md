## Purpose

Deploy `engagement-api` as an independently-managed, **dark** Fargate service.
No ordinary user traffic reaches it in this PR. Canonical Engagement traffic
and the Recall webhook stay on the main API. Nothing in the current product
changes.

## Phase 1 prerequisite

Accepted at `b5de4d0954025483a46413d7a46eeaeb1d1d1345` (head
`47902517c7dd64a408a87cef57323812407c29c8`, draft PR #755, marker
`ENGAGEMENT_PHASE1_AUTHORITATIVE_LOCAL_COMPLETE`). This branch is built on
that head. Phase 0's commits are ancestors of Phase 1 and have no separate PR.

## Scope

Micro-sessions 2.0 through 2.13 (code-and-contract). 2.14 (independent
validation) is the next step; 2.15–2.20 (live AWS work) are **not included** —
this branch was produced without AWS credentials and deploys nothing.

## Infrastructure architecture

- Independent, additive CDK app (`infra/cdk/bin/engagement-api.ts`), entirely
  separate from `bin/capiro.ts`, which owns the historical Compute stack
  (frozen in `UPDATE_ROLLBACK_FAILED`, see `infra/cdk/DRIFT-FINDINGS.md`).
- Three stacks: Registry (ECR), Network (empty target group), Service
  (Fargate). Every live resource — VPC, subnets, cluster, security group,
  listener, secrets, KMS keys — is **imported by identifier**, never created.
- **The historical Compute stack is untouched.**

## Dark runtime posture

```text
ENGAGEMENT_PROCESS_MODE=shadow
ENGAGEMENT_BACKGROUND_OWNER=disabled
ENGAGEMENT_EXTERNAL_ACTIONS=disabled
ENGAGEMENT_CALLBACKS_ENABLED=false
ENGAGEMENT_RECALL_WEBHOOK_ENABLED=false
```

Written as literals in the task definition, not derived from config — no
deployment parameter can arm this service. A test smuggles `active`/`enabled`
values through the config object and asserts the rendered template still says
`shadow`/`disabled`.

## Image provenance

Digest-pinned via `ecs.ContainerImage.fromEcrRepository`; synthesis refuses
outright without both `imageDigest` and `releaseSha`. ARM64, non-root,
serve-only entrypoint that refuses `migrate`/`seed`/`sync-*`/`diag-*` with
exit 64 — verified by actually running the built image against each verb, not
by reading its Dockerfile.

## Networking

Private subnets, no public IP, ECS Exec rendered explicitly `false`. Empty IP
target group on port 4500 with a `/health` check. **No listener rule in CDK**
— the live ALB is hand-managed; only the fail-closed script below may touch it.

## Preview routing

Exactly one rule, managed by `scripts/engagement-api-alb-rules.sh`:

```text
priority 6, path /api/engagement/*, AND header X-Capiro-Engagement-Preview: v3
  -> engagement-api target group, 100% forward, no rewrite, no weighting
```

The header is routing metadata, not authorization. Create and delete each
require a distinct, exact confirmation token; delete re-verifies the rule's
shape before removing it and refuses if it drifted. The generic `/api/*` rule
and Recall are never in this script's AWS-call allowlist — `modify-rule` is
structurally unreachable, not merely avoided. The current web is verified
(by grep, in three separate specs) to send no preview header.

## IAM and secrets

Least privilege: read-only S3 on exactly the configured buckets,
`kms:Decrypt` on exactly the configured keys, an explicit `DENY` covering S3
write, SES send, ECS/ELB mutation, secret mutation, `iam:PassRole`, and
`kms:Encrypt` so a future grant elsewhere cannot quietly widen this. Nine
secret fields injected individually (never a whole JSON document); ten
provider credentials (OpenAI, Anthropic, Recall, Microsoft, Google, …)
deliberately omitted and named, because every path that would use them is
already disabled by the runtime policy.

## Observability and alarms

Eight alarms, two log-derived metric filters (fatal bootstrap, armed
posture — fire on a single event), two EventBridge rules (deployment
failure, unexpected task stop — filtered to exclude planned scaling drains),
one dashboard. Content safety is enforced, not documented: a test lowercases
the entire synthesized template and asserts none of thirteen forbidden
fields (goal text, recipient email, bearer token, …) appears anywhere, and
metric dimensions are restricted to a five-name infrastructure allowlist.

## Database connection budget

`observedSevenDayPeak + maximumCount × perTaskPoolMaximum ≤ floor(max × 0.80)`,
plus 10% headroom required beyond that. Enforced in the config validator, not
just documented.

## UI-aware contracts (Outreach V3 prototype)

The 874 KB standalone prototype (not committed; frozen by checksum) is
reduced to a deterministic 62-state manifest, then mapped to exactly one
Phase 2 capability and future owner per state, then to exactly one of six
preview-acceptance probe classes. **No V3 UI ships.** The one GET route that
actually generates
(`GET /api/engagement/outreach/ai-templates/:id/preview`) is classified as a
shadow-denial probe, not a safe read — a harness treating GET as a synonym
for "safe" could otherwise invoke generation against a live service.

## Automated tests

**282 assertions**, all against synthetic fixtures, a stateful fake AWS
binary, and a fake docker binary — the real behavior a test claims (e.g.
"second create refuses rather than duplicating") is proven against actual
state transitions the fake records, not asserted about static JSON.

```bash
pnpm verify:engagement-phase-2
```

## Negative controls

23 in the template safety verifier alone (plan requires ≥10); every script
spec carries the specific ones the plan names (occupied priority, wrong
account/region/target-group, generic-rule drift, canonical path-only rule,
Recall hijack, drifted-rule-refuses-deletion, mutable tag, armed shadow,
wildcard IAM, missing digest, …).

## Deployment gates

```text
Gate A — code/synth only                          (this PR)
Gate B — Registry + Network foundation             (separate authorization)
Gate D-part-1 — associate empty target group       (separate authorization)
Gate C — image push + Service deploy                (separate authorization)
Gate E — optional production dark deployment         (separate authorization)
```

None of B/C/D/E has been performed. Authorization for one does not authorize
the next.

## Rollback

`scripts/engagement-api-alb-rules.sh delete-preview` first, always — the
current product must recover after that step alone. See
[engagement-api-rollback.md](../../docs/runbooks/engagement-api-rollback.md).

## Migrations

None.

## Web/UI

Unchanged. Verified: no file under `apps/web/src` differs from the Phase 2
base, and none sends the preview header.

## Canonical cutover

Not performed. Phase 10 owns it.

## Recall cutover

Not performed.

## Known limitations

- Repo-wide `pnpm turbo run typecheck` is red on `main` for four pre-existing
  `defense-budget` rootDir violations, unrelated to this work (reproduced on
  a clean `origin/main` checkout). CI's Phase 2 gate is therefore a
  **separate job**, not a step after the existing (already-failing) one.
- The 2.0 input-lock verifier lives under `.artifacts/`, uncommitted — 2.0's
  allowed-changes list didn't include `scripts/`. Recommend promoting it.
- `local-runner-summary.json` in the accepted Phase 1 evidence bundle
  mislabels `clerkAuthentication`; the true value is in `browser-parity.json`.
  Fixing it invalidates that bundle and needs a full re-run — owner's call.
- Ten target/profile states have no current Engagement route (the Directory
  isn't in the route manifest) and are recorded as Phase 7 gaps, not invented
  routes.

## Ready for Phase 3

Not yet — 2.14 (independent validation) is next, then 2.15–2.20 (live AWS,
requires credentials this branch's environment does not have).
