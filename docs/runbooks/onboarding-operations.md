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
curl -s https://onboarding.capiro.ai/onboard-api/health   # {"ok":true,...}
curl -s https://app.capiro.ai/onboard-api/health          # {"ok":true,...}
curl -s -o /dev/null -w '%{http_code}\n' https://app.capiro.ai/api/health   # 200 (unchanged)
```

## One-time activation order (billing + funnel)

1. Stripe: `STRIPE_SECRET_KEY=sk_live_… pnpm --filter @capiro/onboard-api exec tsx scripts/setup-stripe.ts`
   → creates flat-$200 price (lookup `capiro_client_slots_flat200`), overage meter,
   CAPIRO-INTERNAL promo, webhook at `/onboard-api/webhooks/stripe`. Record the 4 env values.
2. Secrets Manager: `capiro/dev/onboard/stripe-secret-key` + `…/stripe-webhook-secret`
   (exec-role policy `onboard-api-ecr-secrets` already grants reads on `capiro/dev/onboard/*`).
3. `pnpm --filter @capiro/onboard-api exec tsx scripts/comp-existing-tenants.ts --commit`
   (protects every pre-existing tenant BEFORE enforcement).
4. Seed legal docs: run task verb `seed-legal-docs` (one-off ECS task, command
   `["task","seed-legal-docs"]`). ToS/SA v2026.07-draft1 are COUNSEL-PENDING drafts.
5. Update the serve taskdef env: STRIPE_PRICE_SLOTS/OVERAGE + the 2 secret ARNs +
   `ONBOARD_EMAIL_ENABLED=true`; register new revision; roll onboard-api.
6. apps/api taskdef: add `BILLING_ENFORCED=true` (this arms the 402 slot cap + paywall);
   roll api. **Never set BILLING_ENFORCED before step 3.**
7. Flip `ONBOARD_FUNNEL_ENABLED=true` on onboard-api; point the marketing "Get Started"
   CTA at https://onboarding.capiro.ai/register.

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
