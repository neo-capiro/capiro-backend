# engagement-api Active Promotion — Runbook

Promotes `engagement-api` from the Phase 1/2 read-only shadow clone into full
ownership of the Engagement module: Meetings, Google/Microsoft integrations,
the Meri notetaker, OAuth callbacks, and everything else the runtime policy
gates — Outreach V3 was already active; this closes the gap for everything
else.

**Every gate below is a separate explicit authorization** — approving one
does not authorize the next, same convention as
[engagement-api-dark-deploy.md](engagement-api-dark-deploy.md).

**Nothing in this runbook has been executed against a live account.** It
documents the exact commands a future authorized session runs.

---

## What "promotion" actually changes

| Control | Shadow (today) | Active (promoted) |
|---|---|---|
| `ENGAGEMENT_PROCESS_MODE` | `shadow` | `active` |
| `ENGAGEMENT_BACKGROUND_OWNER` | `disabled` | `engagement-api` |
| `ENGAGEMENT_EXTERNAL_ACTIONS` | `disabled` | `enabled` |
| `ENGAGEMENT_CALLBACKS_ENABLED` | `false` | `true` |
| `ENGAGEMENT_RECALL_WEBHOOK_ENABLED` | `false` | `true` |
| `ENGAGEMENT_API_PROMOTION_TOKEN` | unset | the acknowledgement string |
| Microsoft/Google/Recall/OAuth-state/AI-credential secrets | withheld | injected |
| S3 on assets + attachments buckets | read-only | read + write |
| OAuth redirect/notification URLs | unused (routes 503 first) | point at THIS service |

Three independent layers enforce that this is all-or-nothing, never partial:

1. `apps/api/src/engagement/runtime/engagement-runtime-env.ts` —
   `resolveEngagementRuntimeEnvironment` throws unless all five posture fields
   agree AND (if active) the token matches.
2. `apps/api/src/config/config.schema.ts` — the same check, independently, for
   any code path that reaches `validateConfig` without going through
   `assertEngagementRuntimeEnvironment` first.
3. `infra/cdk/lib/engagement-api/engagement-api-config.ts` —
   `collectConfigFailures` rejects a config file whose `activePromotion` block
   doesn't carry the exact acknowledgement string, before synthesis ever runs.

A config file that omits `activePromotion` entirely renders the byte-identical
shadow environment as before — promotion is opt-in by the KEY EXISTING, not by
a boolean flipping inside it.

---

## Prerequisites

- `capiro-dev-engagement-api`'s live task definition has **already drifted
  from the `Capiro-dev-EngagementApiService` CloudFormation stack** (observed
  2026-08-25: the stack's own `ReleaseSha` output does not match the running
  image). **Reconcile that drift before this runbook's first `cdk deploy`**, or
  the first promoted deploy will show an unrelated image/config diff mixed in
  with the promotion diff, making the change impossible to review cleanly.
  Either accept the live image as the new CDK baseline (`cdk diff` against it
  and confirm the only delta is the promotion) or restore the stack to its own
  last-known-good state first — a judgment call for whoever runs this, not
  automated here.
- Read [engagement-runtime-ownership.md](engagement-runtime-ownership.md) and
  run the current-owner and future-owner rehearsals. The `futureRehearsalProfile`
  in `infra/cdk/fixtures/engagement-runtime-ownership.v1.json` is EXACTLY the
  target state this runbook produces — main api's `backgroundOwner` becomes
  `engagement-api`, its `callbacksEnabled`/`recallWebhookEnabled` become
  `false`, main api's `externalActions` becomes `disabled` for the concerns
  engagement-api now owns.
- Decide `promo.callbackBaseUrl` — the public host OAuth providers redirect
  back to. This must be a host that actually reaches engagement-api's target
  group, not `app.capiro.ai` (main api's host). If no dedicated host exists yet
  for engagement-api, resolve that as its own infrastructure step BEFORE this
  runbook — a wrong callbackBaseUrl means every OAuth connect attempt fails at
  the provider's redirect step with no application-level error to debug from.

---

## Gate P1 — code and synth only (no AWS mutation)

**Allowed:** review this diff, run the new unit/CDK tests, `cdk synth`,
`cdk diff` read-only against the CURRENT (shadow) deployed stack to confirm it
shows NO drift when `activePromotion` is omitted.

**Not allowed:** deploy anything, touch IAM, touch secrets, touch the ALB.

```bash
cd apps/api
node ./node_modules/jest/bin/jest.js engagement-runtime-env config.schema

cd ../../infra/cdk
pnpm exec ts-node --prefer-ts-exts test/engagement-api-least-privilege.spec.ts
pnpm exec ts-node --prefer-ts-exts test/engagement-api-service-stack.spec.ts
pnpm exec ts-node --prefer-ts-exts test/engagement-api-outreach-v3-env.spec.ts
pnpm exec ts-node --prefer-ts-exts test/engagement-api-promotion-token-lockstep.spec.ts

# Confirm the CURRENTLY DEPLOYED shadow stack shows zero drift from a config
# that simply omits activePromotion — this is the regression that matters
# most: promoting the CODE must not silently promote the SERVICE.
ENGAGEMENT_API_INFRA_CONFIG=/absolute/path/to/dev-config-no-promotion.json \
  pnpm exec cdk diff Capiro-dev-EngagementApiService \
  --app "ts-node --prefer-ts-exts bin/engagement-api.ts"
```

`cdk diff` above MUST show no change (net of the drift noted in
Prerequisites). If it shows anything beyond that pre-existing drift, stop —
something about the branch-on-`activePromotion` design leaked into the
no-promotion path.

---

## Gate P2 — resolve the ten additional secret ARNs and the callback host

**Requires explicit authorization naming:** environment, account, the exact
ten Secrets Manager ARNs, the callback base URL.

```bash
export AWS_PROFILE=capiro-dev AWS_DEFAULT_REGION=us-east-1

for name in microsoft-client-id microsoft-tenant-id microsoft-cert-thumbprint \
            microsoft-cert-private-key GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET \
            recall-api-key recall-webhook-secret oauth-state-secret \
            ai-credential-encryption-key; do
  aws secretsmanager describe-secret --secret-id "capiro/dev/${name}" \
    --query 'ARN' --output text
done
```

Live values as of 2026-08-25 (re-verify — Secrets Manager suffixes can change
if a secret is ever recreated):

```
capiro/dev/microsoft-client-id-AU8xuO
capiro/dev/microsoft-tenant-id-cC9TIB
capiro/dev/microsoft-cert-thumbprint-gJsG0v
capiro/dev/microsoft-cert-private-key-rW9ERB
capiro/dev/GOOGLE_CLIENT_ID-Y59j1r
capiro/dev/GOOGLE_CLIENT_SECRET-EBWpbt
capiro/dev/recall-api-key-WDNzEP
capiro/dev/recall-webhook-secret-FxKv9v
capiro/dev/oauth-state-secret-XOOzYB
capiro/dev/ai-credential-encryption-key-ohnjaH
```

Add these to the deployment config's `activePromotion.secretArns` — see
[engagement-api-infra-config.example.json](engagement-api-infra-config.example.json)
for the field-by-field shape.

---

## Gate P3 — `cdk diff` with promotion, read-only

**Requires explicit authorization naming:** the exact config file with
`activePromotion` populated.

```bash
export ENGAGEMENT_API_INFRA_CONFIG=/absolute/path/to/dev-config-promoted.json
cd infra/cdk
pnpm exec cdk diff Capiro-dev-EngagementApiService \
  --app "ts-node --prefer-ts-exts bin/engagement-api.ts"
```

**Verify the diff shows, and ONLY shows:**
- The ten new secrets appearing on the task definition's container.
- The five `ENGAGEMENT_*` env vars flipping to their active values, plus
  `ENGAGEMENT_API_PROMOTION_TOKEN`.
- The three `*_REDIRECT_URI` / `*_NOTIFICATION_URL` env vars appearing.
- A new `EngagementApiActivePromotionWriteObjects` IAM statement (S3
  Put/Delete on assets + attachments only).
- `s3:PutObject`/`s3:DeleteObject` REMOVED from the `EngagementApiDenyMutation
  AndSend` statement's action list (removed, not the whole statement — every
  other denial must still be present).
- The `capiro:iam-posture` tag changing to `active-promotion-engagement-owner`.

If the diff shows anything else — a changed image digest, a changed CPU/memory,
a changed target group, a changed listener rule — **stop**. That is either the
pre-existing CF drift surfacing or an unrelated concurrent change; resolve it
separately before proceeding.

---

## Gate P4 — main API stands down the concerns it is transferring

**STOP — Recall webhook ownership has a routing precondition that must be
satisfied FIRST, or this gate causes a real outage.** Recall's webhook POST is
server-to-server (Recall calling Capiro, not the browser) — it carries no
`X-Capiro-Engagement-Preview` header and never will, because
`apps/web/src/lib/engagement-api-preview.ts` only ever attaches that header to
requests the SPA itself makes. The ALB has no rule routing `/webhooks/recall`
anywhere but the main API's target group — confirmed by grep across
`infra/cdk` finding zero matches. `resolveEngagementRuntimeEnvironment`'s
enforcement and `guardNotetakerService`'s DI-level proxy wrap (see
`apps/api/src/engagement/engagement.module.ts`) are BOTH real and correct —
they gate `NotetakerService.receiveWebhook`/`handleBotEvent` on
`recallWebhookEnabled` transparently, with no code gap. The gap is
INFRASTRUCTURE: nothing ever delivers a Recall webhook to engagement-api's
target group in the first place, active posture or not.

If `ENGAGEMENT_RECALL_WEBHOOK_ENABLED=false` is deployed to main api (as the
"cede ownership" env change below literally says) BEFORE a `/webhooks/recall`
ALB rule forwards to engagement-api, main api starts returning 503
`ENGAGEMENT_RECALL_WEBHOOK_DISABLED` for every real Recall delivery, and
engagement-api never receives a single one to process instead — a full,
silent Recall/notetaker outage, not a safe pause. This is EXACTLY the
same shape as the OAuth callback host problem P2/P3 already solve for
Microsoft/Google (`callbackBaseUrl`) — Recall has no equivalent field in this
runbook yet because a `/webhooks/recall` rule change is a routing-layer
change, and every existing precedent in this repo
([engagement-api-preview-rule.md](engagement-api-preview-rule.md)'s own
guarantee table: "No Recall rule to engagement-api ... checked before
create") treats moving Recall traffic as explicitly outside what the ALB
scripts here are authorized to do.

**Do not flip `ENGAGEMENT_RECALL_WEBHOOK_ENABLED` on main api in this gate.**
Two honest options, pick one explicitly before proceeding, and treat whichever
is chosen as ITS OWN separately authorized ALB change (a new priority, a new
path-pattern condition on `/webhooks/recall`, forwarding to the engagement-api
target group) — not a byproduct of this runbook:

- **(a) Leave Recall on main api indefinitely.** Set
  `activePromotion.secretArns.recallApiKey` /`recallWebhookSecret` on
  engagement-api anyway if promoting other concerns, but keep
  `ENGAGEMENT_RECALL_WEBHOOK_ENABLED=true` on main api and treat this as a
  DELIBERATE, permanent carve-out — main api keeps owning the one concern with
  no browser-side routing signal to move. Update
  `infra/cdk/fixtures/engagement-runtime-ownership.v1.json`'s
  `futureRehearsalProfile` to reflect this if it is adopted (it currently
  models Recall moving too).
- **(b) Add the ALB rule, THEN cede ownership.** Extend
  `scripts/engagement-api-alb-rules.sh` (or a sibling script — this exact
  script's `verify-baseline` explicitly checks "no rule already routes
  `/webhooks/recall` to `engagement-api`" as a SAFETY invariant for the
  preview rule, so reusing it as-is for a permanent Recall rule needs review,
  not a blind rerun) with a new, permanent (non-preview, no header condition)
  rule: `path /webhooks/recall -> forward 100% to engagement-api target
  group`. Verify Recall's dashboard-configured webhook URL still resolves to
  the same public hostname (Recall's target is a URL, not a target group; the
  ALB rule is what decides which service that URL's traffic reaches). Only
  after that rule is live and verified (send one real bot event, confirm it
  lands in engagement-api's logs) does flipping
  `ENGAGEMENT_RECALL_WEBHOOK_ENABLED` on main api become safe.

The other four env changes below (`ENGAGEMENT_BACKGROUND_OWNER`,
`ENGAGEMENT_CALLBACKS_ENABLED`) do not have this problem — background workers
have no external routing dependency (they run on a timer, not behind a
listener rule) and OAuth callbacks are covered by P2/P3's `callbackBaseUrl`.
Recall is the ONE concern among the five where "flip the env var" and "the
traffic actually arrives" are decoupled facts.

---

Before or in the same authorized window as P5, main api's task definition
env changes (NOT a code change — `apps/api` already reads these at boot):

```
ENGAGEMENT_BACKGROUND_OWNER=engagement-api
ENGAGEMENT_CALLBACKS_ENABLED=false
```

`ENGAGEMENT_RECALL_WEBHOOK_ENABLED` stays `true` on main api until one of the
two options above is deliberately executed — see the STOP block.

`ENGAGEMENT_EXTERNAL_ACTIONS` on main api is a coarser knob than the future
profile's `disabled` — it currently also governs Classic (non-V3) outreach
generate/send, which is NOT part of this promotion. Leave it `enabled` on main
api unless Classic outreach is also being retired from main api in the same
change (out of scope here; a separate, explicitly authorized decision).

**Order matters.** Deploy P4 (main api stands down) and P5 (engagement-api
stands up) as close together as the deployment tooling allows. A main api that
has already ceded `ENGAGEMENT_BACKGROUND_OWNER` while engagement-api is still
shadow means NO service runs the sync scheduler / notetaker reconcile / job
workers for that gap — a real availability regression, even though it fails
safe (nothing double-processes; things simply pause). Prefer deploying P5
first, confirming engagement-api's workers actually started (its CloudWatch
logs, not just a health check), THEN deploying P4.

---

## Gate P5 — deploy the promoted engagement-api

```bash
cd infra/cdk
pnpm exec cdk deploy Capiro-dev-EngagementApiService \
  --app "ts-node --prefer-ts-exts bin/engagement-api.ts" \
  --require-approval never
```

**After deploy, verify — in this order:**

1. `GET /health` (via a c1-sql-master-style internal path, or an ECS
   `run-task` curl — the health check has no public listener rule) shows
   `runtime.processMode: "active"`, `backgroundOwner: "engagement-api"`,
   `externalActions: "enabled"`, `callbacksEnabled: true`,
   `recallWebhookEnabled: true`.
2. CloudWatch `/capiro/dev/engagement-api` shows the sync scheduler,
   notetaker reconcile sweep, and outreach job worker LOG THEIR STARTUP LINES
   (`engagement auto-sync started...`, etc.) — a health check alone does not
   prove a background timer actually armed.
3. `capabilities()` for a connected tenant reports `configured: true` for
   Microsoft and Google where secrets exist.
4. A real (or test) OAuth connect flow round-trips through the NEW callback
   host without a redirect-URI mismatch error from the provider.
5. Zero double-processing: confirm via CloudWatch that main api's own sync
   scheduler/notetaker/job-worker startup lines DO NOT appear after its P4
   deploy (they should log the "disabled by runtime policy" line instead).

---

## Rollback

The ordering principle is the same as
[engagement-api-rollback.md](engagement-api-rollback.md): **stop routing before
touching the service.** For a promotion rollback specifically:

1. Revert the config file to omit `activePromotion` (or set it back to a
   config that matches the CURRENT deployed shadow state) and `cdk deploy`
   again. This is the fastest path back to shadow — it is the exact reverse of
   Gate P5 and needs no new authorization beyond "redeploy the previous
   config."
2. Revert main api's three env vars from P4 back to `api`/`true`/`true` so it
   resumes owning workers/callbacks/Recall. **Do this promptly** — while
   engagement-api is rolled back to shadow AND main api still thinks
   engagement-api owns these concerns, NOTHING processes them.
3. Confirm via CloudWatch that main api's startup lines reappear.

Never leave the two services disagreeing about who owns background work for
longer than the single deploy cycle it takes to fix — that gap is where a
missed sync or a stranded notetaker session comes from, not from either
service actively misbehaving.

---

## What this runbook does NOT do

- Does not touch the `X-Capiro-Engagement-Preview` header-gated ALB rule
  (prio 6) — that rule's SCOPE decides which requests reach engagement-api at
  all; this runbook only changes what engagement-api DOES once a request
  arrives. Routing more traffic to engagement-api (e.g. making `os.capiro.ai`
  send every Engagement request there, not just Outreach V3) is a SEPARATE,
  separately authorized change — see the ALB rule discussion in
  [engagement-api-preview-rule.md](engagement-api-preview-rule.md).
- Does not touch Classic (non-V3) outreach on main api.
- Does not reconcile the CloudFormation drift noted in Prerequisites — that is
  its own remediation, not a side effect of this one.
- Does not retire, destroy, or scale down main api. Main api keeps serving
  every module this promotion does not touch, plus Classic outreach, plus
  everything under `/api/*` that was never part of Engagement.

---

## Gate P6 — os.capiro.ai auto-routes the FULL Engagement surface (optional, FE-only)

Everything above (P1-P5) promotes the BACKEND. The frontend still only
auto-attaches the preview header for Outreach V3 (`isOutreachV3ApiRequest`)
unless this gate is separately run. Skipping P6 is a completely valid end
state: engagement-api can own the full backend while the SPA still only
auto-routes V3, and every other Engagement call keeps going to main api via
the generic `/api/*` rule exactly as today — nothing about P1-P5 forces P6.

**Precondition: P1-P5 complete AND the preview rule (prio 6,
`/api/engagement/*` + header) already covers every path the SPA will now
auto-route** — it does; the header-gated rule matches on path prefix only,
not sub-path, so no ALB change is needed for P6 itself. What P6 actually
changes is a pure frontend decision: whether the SPA voluntarily sends that
header on paths it previously left alone.

```bash
# Web-vnext CDK context flag (defaults to unset/false — omit for no change):
cdk deploy Capiro-<env>-WebVNext \
  --app "ts-node --prefer-ts-exts bin/web-vnext.ts" \
  -c engagementApiFullOwnership=true \
  --require-approval never
```

This sets `ENGAGEMENT_API_FULL_OWNERSHIP=true` on the web-vnext task, which
`entrypoint.sh` writes into `runtime-config.js`, which
`apps/web/src/env.ts`'s `isEngagementApiFullOwnership` reads, which
`apps/web/src/lib/engagement-api-preview.ts`'s `isAutoRoutedEngagementRequest`
consults. No image rebuild required — same mechanism as `webSurface` itself.

**After deploy, verify:**
- `window.__CAPIRO_CONFIG__.engagementApiFullOwnership === 'true'` on
  `os.capiro.ai`.
- A Meetings request (previously main-api-only) now carries
  `X-Capiro-Engagement-Preview: v3` in the Network tab and the response's
  `X-Capiro-Service` header (if present) reads `engagement-api`.
- Outreach V3 is unaffected — it was already auto-routed before P6 and stays
  that way (`isOutreachV3ApiRequest` is checked first, unconditionally).
- The manual preview toggle (`?engagement-api-preview=v3`) still works
  independently on `app.capiro.ai` classic, untouched by this gate.

**Rollback:** redeploy with `-c engagementApiFullOwnership=false` (or omit the
context flag entirely — both render the same absent env var). No ALB change,
no backend change; this is a same-speed-as-forward frontend-only revert.
