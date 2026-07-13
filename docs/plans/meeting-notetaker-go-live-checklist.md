# Meeting Notetaker — Go-Live Checklist (open items for Neo)

**As of 2026-07-08.** ALL code is committed and verified (typecheck 0 / prettier / 38 unit tests / adversarial review, PR #344) — including the previously-gated `main.ts` raw-body mount (item A, applied on Ninja's "finish the plan" instruction) and the CDK secret wiring (item C). Phase 1 is code-complete: dispatch + consent gate, webhook receiver (live once the secret resolves), transcript→S3-attachment persistence, debrief generation, status chip/polling, and the "Remove Meri" kill switch. The feature is **inert** (flag off + secrets hold placeholders), so nothing is live. What remains is operator/dashboard/legal work only — do these in order. **The AWS side has been pre-flighted read-only against the live account (see C): ALB routing, IAM, and KMS are all already in place — B+C+E are ~10 minutes of copy-paste.**

---

## ~~A. One gated code edit~~ — ✅ DONE (2026-07-08)
`main.ts` now mounts `raw({ type: '*/*', limit: '1mb' })` on `/webhooks/recall`, exactly the one line documented here (next to the Clerk mount, before the global `json()`). The tenant-context middleware already skipped `webhooks/(.*)`, so nothing else changed. `POST /webhooks/recall` now svix-verifies and processes events as soon as `RECALL_WEBHOOK_SECRET` resolves (fail-closed until then: with the secret unset, every webhook is rejected — nothing is trusted).

## ~~B. Secret value~~ — ✅ DONE + VERIFIED (2026-07-08)
`capiro/dev/recall-api-key` holds the real key (stored at creation on 2026-07-07 — the "PLACEHOLDER" description text was stale). Verified functionally: `GET /api/v1/bot/` against us-west-2.recall.ai with the stored key → **HTTP 200**.

## ~~C. Infra deploy~~ — ✅ DONE (2026-07-08): task-def **rev 37** registered out-of-band from rev 36 + `RECALL_API_KEY` + `RECALL_WEBHOOK_SECRET`; service rolled onto it. `NOTETAKER_ENABLED` deliberately NOT set (that's D). The drift warning below still governs any future change — kept for reference.

### (original C guidance — still the rule for future task-def changes)

> **DO NOT plain-`cdk deploy` the Compute stack.** Verified against the live account (2026-07-08): the running `capiro-dev-api` task def (**revision 36**) carries out-of-band secrets CDK does not know about — `INTERNAL_SERVICE_SECRET` (BYOK3 orchestrator↔api auth), `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `CLIO_SANDBOX_TOKEN` — and out-of-band env (`MERIV2_ENABLED`, `MERIV2_ORCHESTRATOR_URL`, `STRIPE_PRICE_SLOTS`, `STRIPE_PRICE_OVERAGE`, `BILLING_RETURN_URL`, `CLIO_MCP_OAUTH_REDIRECT_URI`, `CLIO_SANDBOX_URL`, `TRACKER_SINGLE_SENDER_GUARD`). A `cdk deploy` would register CDK's task def and **drop all of those → MeriV2 and billing break in prod**. The repo's CDK edits are for a future reconciliation pass; until CDK is reconciled with rev 36, wire Recall the same way those secrets were wired — **out-of-band task-def registration**.

**Pre-flight already verified (2026-07-08, read-only against the live account):**
- `/webhooks/*` ALB rule exists live at **priority 15 → `capiro-prod-api-tg`** — `https://app.capiro.ai/webhooks/recall` routes with **zero ALB work** (G-4 routing closed; only the Recall-dashboard endpoint in E remains).
- Exec role inline policy `CapiroDevRuntimeSecretsRead` already grants `GetSecretValue`/`DescribeSecret` on **`capiro/dev/*`** — **no IAM change needed** for either Recall secret.
- `capiro/dev/recall-api-key` uses the default `aws/secretsmanager` KMS key — **no KMS grant needed**.

**Procedure (after B; same pattern that wired `INTERNAL_SERVICE_SECRET`):**
```sh
aws ecs describe-task-definition --task-definition capiro-dev-api --region us-east-1 \
  --query taskDefinition > td.json
jq 'del(.taskDefinitionArn,.revision,.status,.requiresAttributes,.compatibilities,.registeredAt,.registeredBy)
    | .containerDefinitions[0].secrets += [{"name":"RECALL_API_KEY","valueFrom":"arn:aws:secretsmanager:us-east-1:967807252336:secret:capiro/dev/recall-api-key-WDNzEP"}]' \
  td.json > td-new.json
aws ecs register-task-definition --cli-input-json file://td-new.json --region us-east-1
aws ecs update-service --cluster capiro-dev --service capiro-dev-api \
  --task-definition capiro-dev-api --region us-east-1
```
Then verify: `aws ecs describe-task-definition --task-definition capiro-dev-api --query 'taskDefinition.containerDefinitions[0].secrets[?starts_with(name,`RECALL`)]'`.

Notes:
- The API **image** with the webhook mount ships via the normal merge → CI → `scripts/deploy-dev.sh` roll (the `meeting_bot_sessions` migration applies with it). The task-def registration above is orthogonal — do it before or after.
- `NOTETAKER_ENABLED=true` (env) is added the same way (`.containerDefinitions[0].environment += [{"name":"NOTETAKER_ENABLED","value":"true"}]`) — do that only at canary time (D).
- `RECALL_API_BASE_URL` defaults to `https://us-west-2.recall.ai` (correct) — no action.

## D. Canary flip (you, when ready)
Flip the per-tenant flag for `capiro-internal` first (SQL, same path as the MeriV2 flips):
```sql
UPDATE tenants
SET settings_jsonb = jsonb_set(coalesce(settings_jsonb,'{}'), '{clioFeatureFlags,notetaker.enabled}', 'true')
WHERE slug = 'capiro-internal';
```
Both `NOTETAKER_ENABLED=true` (env) AND this per-tenant flag must be on for the feature to appear.

## ~~E. Recall webhook endpoint~~ — ✅ DONE (2026-07-08)
Endpoint `https://app.capiro.ai/webhooks/recall` created in the Recall dashboard (Capiro workspace, us-west-2, subscribed to all events — the only endpoint, 0.0% error rate). Signing secret stored as `capiro/dev/recall-webhook-secret` (ARN `…-FxKv9v`, taken from clipboard → Secrets Manager without display), wired onto the serve task in rev 37 (see C), and the ARN recorded as `recallWebhookSecret` in `infra/cdk/lib/config.ts` so the future CDK reconciliation keeps it.

## F. Compliance / business (you + counsel)
- Sign the Recall **DPA**; add Recall to the **subprocessor list / Trust Center**; file their SOC 2 report.
- **Legal review** of the consent copy (`meeting-notetaker-consent-copy.md`) — 7 questions queued there.
- Upgrade Recall off the **$5 trial** before real meeting volume.

---
## 🟢 Status 2026-07-08 (later): A ✅ B ✅ C ✅ E ✅ MERGE+DEPLOY ✅ D ✅ — **LIVE ON capiro-internal**

Executed on Ninja's "finish it":
- **PR #344 squash-merged** (`08a651d`); CI built `:latest` = merge SHA (race-checked); `scripts/deploy-dev.sh` ran clean — migration `20260707120000_meeting_bot_sessions` **applied** (visible in the migrate-task log), api + web rolled and stable.
- **Webhook verified live end-to-end:** unsigned POST → 400; a **real svix-signed** synthetic event → **204** with the expected `NotetakerService` log line (session-miss warn) — proving ALB routing → raw mount → secret resolution → signature verify → normalize → DB lookup, in prod.
- **D done:** task-def **rev 38** (= rev 37 + `NOTETAKER_ENABLED=true`) rolled stable (2/2); tenant flag flipped via the sql-exec merge-preserve one-off — capiro-internal flags now `{meriv2.* …, "notetaker.enabled": true}` (all pre-existing flags preserved). 0 exceptions post-deploy.
- Flip script note for future flips: the old `NODE_PATH=/app/node_modules` recipe broke on the current image layout — resolve `@prisma/client` via `require.resolve('@prisma/client', { paths: ['/app/apps/api'] })` instead.

**The ONLY open item is F — compliance/business:** Recall DPA + subprocessor/Trust-Center listing + SOC 2 report on file; legal review of the consent copy (7 questions queued); **upgrade off the $5 trial** — the canary is live, so every recorded meeting now burns trial credit (~$0.76/hr all-in).

**First smoke test (Ninja):** in Engagement → Meetings on capiro-internal, open/create a meeting with a Zoom/Meet/Teams link, click **"Send Meri to take notes"**, tick both consent boxes, and run a short throwaway call. Expect: bot joins named "Meri Notetaker (recording)" + posts the chat disclosure → status chip advances → debrief lands in the Debrief tab ≤5 min after the call + transcript appears as a meeting attachment → confirm the transcription shows in OUR Deepgram usage dashboard (BYO-key proof, Phase-0 exit criterion). "Remove Meri" mid-call exercises the kill switch. Rollback any time: flag off (same one-off, `false`) or unset `NOTETAKER_ENABLED`.

---
## 🟡 GA rollout 2026-07-13 — every tenant + all future tenants, item F still OPEN

**Ninja's explicit call**, made with the compliance gap in front of him: flip `notetaker.enabled` for every existing tenant (not just `capiro-internal`) and default it ON for every new tenant going forward, accepting that **item F (Recall DPA, subprocessor/Trust-Center listing, consent-copy legal review, upgrade off the $5 trial) remains open** while real client meetings are now in scope.

**Mechanism:** rather than a per-tenant SQL flip, `notetakerEnabled()` in [tenant-flags.ts](../../apps/api/src/common/tenant-flags.ts) was promoted to the same GA shape already used for `meriV2FlagEnabled` — the tenant default changed from `false` to `true`, so any tenant with no explicit `clioFeatureFlags['notetaker.enabled']` override now resolves enabled. Verified via a read-only prod dump (2026-07-13, `diag-tenant-config`) that of the 5 live tenants (Capiro/capiro-internal, C2 Strategies, Maven, Victory Six Advisors, DualSight), only `capiro-internal` had an explicit value (`true`) — the other 4 had none — so this single default flip turns the feature on for **every current tenant** with zero DB writes, and covers **every future tenant** the same way. `NOTETAKER_ENABLED=true` (env kill-switch) was already live from the canary. A tenant can still be opted OUT individually with an explicit `false` written into its `settings_jsonb` (same SQL path as the original canary flip) if a specific client needs it held back pending their own review.

**What did NOT change:** the per-meeting strict-consent gate (both checkboxes), the "Remove Meri" kill switch, the chat disclosure message, and the reconciliation sweep are all unaffected — this only changes who is even allowed to see the "Send Meri" button succeed instead of getting a 403.

**Outstanding:** item F is the same compliance list as above, now with real client-meeting volume behind it instead of just capiro-internal dogfooding. Recommend treating the trial-tier upgrade and DPA as the most time-sensitive of the four now that non-Capiro meetings are in scope.
