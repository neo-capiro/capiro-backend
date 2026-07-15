# Onboarding v1 — Operations Runbook

> Companion to docs/plans/onboarding-v1-plan.md (build) and
> docs/plans/billing-stripe-setup.md (original dormant-billing runbook — the
> Stripe pieces now live in onboard-api). Account 967807252336 · us-east-1 ·
> cluster `capiro-dev` · service `capiro-dev-onboard-api`.

## Surfaces & ownership

| Surface | Where | Owner |
|---|---|---|
| Funnel + setup dashboard + IT page | onboarding.capiro.ai (onboard-web SPA served by onboard-api) | onboard-api |
| Funnel/setup/billing API | `/onboard-api/*` (any host via ALB path rule) | onboard-api |
| Stripe webhooks | `https://app.capiro.ai/onboard-api/webhooks/stripe` | onboard-api (single Stripe writer) |
| Billing reads (`/api/billing/state`+`summary`), slot 402, provisioning internal endpoints | apps/api | apps/api |
| In-app gates/tour/banner/lockout | apps/web (scoped `onboarding_flow_version=1`) | apps/web |

## Deploy

CI builds `capiro/dev/onboard-api:latest` on merge to main (onboard-api-image.yml).
Then: `scripts/deploy-onboard.sh` (migrate → roll; same invariant as deploy-dev.sh).
ALB rules: `scripts/onboard-alb-rules.sh --list|--create <TG_ARN>|--delete`
(priorities 8 host + 9 path; NEVER touch p10/12/13/14/15/20).
Task defs: `infra/deploy/onboard-api-{serve,migrate}-taskdef.json` (real ARNs baked in;
Stripe secret ARNs are placeholders until activation).

Post-deploy verification (every roll):
```
curl -s https://onboarding.capiro.ai/health   # {"ok":true,...} (outside the /onboard-api prefix)
curl -s https://app.capiro.ai/onboard-api/public/config   # 200 (path-rule check)
curl -s -o /dev/null -w '%{http_code}\n' https://app.capiro.ai/api/health   # 200 (unchanged)
```

## Activation status — LIVE as of 2026-07-07 (one input remaining)

Steps 1–8 below are **DONE**; the funnel is live at onboarding.capiro.ai (wire path
end-to-end, card/ACH pending the one publishable key). ✅ = complete.

1. ✅ Stripe bootstrap ran (`setup-stripe.ts`): flat-$200 price
   `price_1TqWzaBwkXSqoljjp2n3DbVH`, overage price `price_1TqWzbBwkXSqoljjwgRCWMsb`
   + meter `llm_overage_cents`, CAPIRO-INTERNAL promo, webhook `we_1TqWzc…` →
   `/onboard-api/webhooks/stripe`.
2. ✅ Secrets `capiro/dev/onboard/stripe-secret-key` + `…/stripe-webhook-secret`.
3. ✅ `comp-existing-tenants`: all 4 pre-existing tenants → `comped` (verified
   BEFORE→AFTER via the sql-exec one-off; billing was `none` on 1, already comped on 3).
4. ✅ Legal docs seeded (tos/all + sa/trial + sa/paid v2026.07-draft1). Re-run
   `seed-legal-docs` only when counsel delivers real docs (bump the version first).
5. ✅ onboard-api taskdef **:2** — prices + secret ARNs + `ONBOARD_EMAIL_ENABLED=true`
   + `ONBOARD_FUNNEL_ENABLED=true`; rolled, stable, healthy TG.
6. ✅ apps/api taskdef **:35** — `BILLING_ENFORCED=true`; rolled, 0 exceptions.
7. ✅ Clerk `allowed_origins` set to `[app, onboarding, capiro.ai, www]` via Backend
   API — **this was the real funnel blocker** (prod Clerk 403s any origin subdomain
   not on the allowlist; symptom = `failed_to_load_clerk_js_timeout` + blank SPA).
   Verified: onboarding funnel renders (confirm-password present, 0 console errors);
   app.capiro.ai unaffected.
8. ✅ Marketing "Get Started" CTA → point at https://onboarding.capiro.ai/register
   (funnel is live; do this whenever marketing is ready — nothing else gates it).

### ⛳ THE ONE REMAINING INPUT — Stripe publishable key (card/ACH only)

The `pk_live_…` publishable key is **not** retrievable via the API and lives nowhere
in AWS/repo — copy it from **dashboard.stripe.com → Developers → API keys** (the
"Publishable key" for acct `acct_1TCkmIBwkXSqoljj`, Capiro Inc.). Then:
```
# set the env on the onboard-api serve taskdef (it's PUBLIC — plain env, not a secret)
#   infra/deploy/onboard-api-serve-taskdef.json → STRIPE_PUBLISHABLE_KEY value
aws ecs register-task-definition --cli-input-json file://infra/deploy/onboard-api-serve-taskdef.json
aws ecs update-service --cluster capiro-dev --service capiro-dev-onboard-api \
  --task-definition capiro-dev-onboard-api:<newrev> --force-new-deployment
```
Until then: **wire-payment onboarding works end-to-end**; card/ACH steps show the
built-in "Payments are not configured" note and disable submit (public-config
returns `stripePublishableKey: null`). No error, no data loss — just those two
tender types wait on this value.

### IT-admin Google option (ships dark — two activation inputs)

The IT-admin page (`/it/:token`) offers **Connect with Google** next to Microsoft.
Google has no Entra-style tenant-wide admin-consent URL, so the flow is:
the Workspace admin marks the Capiro OAuth client **Trusted** in the Google Admin
console (Security → API controls → App access control — this also exempts the app
from Google's unverified-app block for that domain), then proves it worked with a
**test-connect**: an OAuth sign-in requesting the same scopes team members will
request. On success onboard-api records the grant (+ `hd` Workspace domain) and
flips `it_email` — the exchanged tokens are read for scopes/identity and discarded
(never persisted, never revoked: revoking would kill the admin's user↔client grant
including any real mailbox connection).

Fail-closed dark until BOTH are done:
1. **Env on the onboard-api serve taskdef** (out-of-band, same as apps/api rev 43):
   `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` (Secrets Manager
   `capiro/dev/GOOGLE_CLIENT_ID` / `capiro/dev/GOOGLE_CLIENT_SECRET`). Until set,
   the button renders disabled "Coming soon" and the consent-url route 400s.
2. **Redirect URI on the Google OAuth client** (GCP console, project
   `capiro-gmail-integration`): add
   `https://app.capiro.ai/onboard-api/it/google/callback`
   alongside the engagement callbacks — without it Google errors
   `redirect_uri_mismatch` at sign-in.

While the OAuth app is in **Testing** publishing status, only `neo@capiro.ai` +
manually-added test users can complete the test-connect — real customers need
Phase 0b verification (see docs/runbooks/gmail-phase-0-google-verification.md)
**or** their admin trusting the app in their own Workspace, which lifts Google's
unverified-app block for that domain.

## Scheduled tasks (EventBridge → RunTask on the onboard-api image)

| Rule | Command | Cadence |
|---|---|---|
| onboard-lifecycle-daily | `["task","lifecycle-daily"]` | daily 06:10 UTC |
| onboard-report-llm-overage | `["task","report-llm-overage"]` | daily 06:40 UTC |

`lifecycle-daily` handles: day-31 trial conversion (card/ACH charge · wire invoice),
reminder cadence (d1/15/25/29), never-started backstop (+30d nudge, +60d cancel),
wire/ACH lockout (`ONBOARD_UNPAID_LOCKOUT_DAYS`, default 14 — X still TBD w/ Jordan),
retention (warn 83d, hard delete 90d). All idempotent (onboard_email_log dedupe +
CAS updates) — a double-run is a no-op.

## Common operations

**Stuck provisioning / failed health check** — session state='failed' with
failureReason; CS got an email. Fix the cause, then clear:
`UPDATE onboard_session SET state='org_setup', failure_reason=NULL WHERE id='…'`
(via the diag one-off task pattern) and have the purchaser press Finish again.

**Resend an admin invite** — Clerk dashboard → the org → Invitations → resend, or the
purchaser confirmation email lists them; team invites resend from Settings→Team.

**IT invite expired/lost** — dashboard Task 1 → Resend (rotates the token) or
Add another contact. Multiple simultaneous IT contacts are supported.

**Courtesy swap (support-mediated ONLY — never exposed in UI)** — one per account:
archive the old client in-app, then
`UPDATE tenants SET courtesy_swap_used=true WHERE id='…'` and (if at cap) nothing else —
archiving freed the slot. Refuse if courtesy_swap_used is already true.

**Lockout override (payment confirmed out-of-band)** —
`UPDATE tenants SET locked_at=NULL WHERE id='…'`; the cron re-applies if the
subscription is still past_due, so also fix the Stripe invoice.

**Pause a scheduled deletion** — `UPDATE tenants SET deletion_hold=true WHERE id='…'`.
The hard-delete endpoint re-verifies eligibility server-side; a hold blocks it
indefinitely.

**Comp a tenant** — capiro-admin → Settings→Customers → comp toggle (writes via
onboard-api). Webhook syncs never clobber `comped`.

## Monitoring

- CloudWatch alarms on the onboard TG (5xx, unhealthy hosts) → `capiro-dev-alerts`
  (neo@ subscribed). Watch `/capiro/dev/onboard-api` for `ExceptionsHandler`.
- Stripe webhook failures: `SELECT * FROM stripe_events WHERE error IS NOT NULL` —
  Stripe retries on our 500s; a stuck event usually means a schema/tenant mismatch.
- Funnel drop-off: `SELECT state, count(*) FROM onboard_session GROUP BY 1`.

## Rollback

- Service: `aws ecs update-service --cluster capiro-dev --service capiro-dev-onboard-api --task-definition capiro-dev-onboard-api:<prev>`
- Funnel only: set `ONBOARD_FUNNEL_ENABLED=false` (marketing CTA falls back to demo form).
- Billing enforcement only: set `BILLING_ENFORCED=false` on apps/api (paywall + 402 off;
  billing UI stays visible to billing admins).
- Full retreat: delete ALB rules p8/p9 (`onboard-alb-rules.sh --delete`), scale the
  service to 0. Nothing else references onboard-api.
