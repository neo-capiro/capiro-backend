# Capiro Self-Service Onboarding v1 — Deployment Plan (`onboard-api`)

> Status: **APPROVED — EXECUTING** (Ninja, 2026-07-06). Decisions locked (see §9-A below).
> Execution directives: no shortcuts, no guesses, UI must match the prototype exactly,
> production level. Resolve all §8 red flags during deployment except #3/#4 (accepted
> risks — proceed anyway); flag #9 resolved per the new pricing instructions.
> Sources: `Capiro Onboarding Requirements (Gherkin).md`, the standalone Onboarding
> Prototype (React source extracted from the bundled HTML), and a full codebase
> audit (billing, Clerk/auth, LDA import, CDK/ALB, SES/Microsoft/Google email).
> Companion: red-flags + open questions are at the bottom — several need answers
> before Phase 3.

## 0. Goal

A fully self-service onboarding experience: a purchaser lands on capiro.ai, registers,
accepts legal terms, pays (or starts a trial with a method on file), designates admins,
and the platform provisions itself — no Capiro staff in the loop. Admins finish firm
setup on an external dashboard (IT email grant, LDA client import, firm AI settings),
invite the team, and every user passes a personal email-connect gate + guided tour.
Everything entered during onboarding lands in the real tenant so it's live on first login.

All new backend surface lives in a **new Fargate service: `onboard-api`**, which also
becomes the **single owner of Stripe billing** (moved out of `apps/api`, reusing the
existing Stripe account/API key).

---

## 1. Terminology mapping (Gherkin/prototype → Capiro reality)

| Gherkin / prototype term | Capiro implementation |
|---|---|
| Super Admin | **`user_admin` with the new `billing_admin` permission** (NO new role type) |
| Admin | `user_admin` (without billing permission) |
| Standard User | `standard_user` |
| Capiro-managed (CS) | `capiro_admin` |
| Purchaser | Clerk user with **no org membership** + `onboard_purchaser` row (billing/contact only) |
| IT Admin | **No Clerk account.** Signed magic-link token → single-task page |
| Platform / tenant | Existing `tenants` row + Clerk organization (1:1, unchanged) |
| Profile (billed unit) | Existing `clients` row / `tenants.client_slots` |
| `client_slot_limit` | Existing `tenants.client_slots` (trial fixed at 10) |
| SA / ToS | Two versioned legal docs, separate consent records |
| "The admin receives this email" screen | **Prototype-only** — real flow sends a Clerk org invitation email |
| `{slug}.capiro.ai` (prototype confirmation screen) | **Does not exist.** App is `app.capiro.ai`; vanity is `{slug}.app.capiro.ai`. Copy must say `app.capiro.ai` |
| `capiro.com` (prototype landing) | `capiro.ai` |

Role → capability matrix (target):

| Capability | user_admin + billing_admin | user_admin | standard_user |
|---|---|---|---|
| Firm settings / import / invite | yes | yes | no |
| View billing, invoices, payment info | **yes** | **no (fully hidden)** | no |
| Purchase / upgrade slots | **yes** | no ("Contact a billing admin") | no |

---

## 2. Current-state inventory (what we build on)

**Billing (dormant, production-ready, in `apps/api`)** — `apps/api/src/billing/*`:
`StripeClient` (fail-soft on missing `STRIPE_SECRET_KEY`), `BillingService` (checkout,
portal, `syncSubscription`, admin list, comp), `POST /webhooks/stripe` (svix-style raw-body
verify + `stripe_events` idempotency), `BillingOverageService` + `report-llm-overage.ts`
(daily LLM overage meter). Tenant already has `stripe_customer_id`, `stripe_subscription_id`,
`billing_status` (`none|trialing|active|past_due|canceled|comped`), `client_slots`,
`llm_allowance_usd_per_slot`, `llm_hard_cap_usd`, `current_period_end`
(schema.prisma:113–211). Pricing constants in `packages/shared` (MIN_CLIENT_SLOTS=10,
tiers $200/$180/$160, `isBillingEntitled`, `CLIENT_SLOT_LIMIT` 402 code). Web:
`BillingGate` (App.tsx:273), `SubscribePage`, Settings→Billing, capiro-admin Customers page.
Activation runbook: `docs/plans/billing-stripe-setup.md` (`setup-stripe.ts`,
`comp-existing-tenants.ts`).

**Slot enforcement**: 402 gate on `POST /api/clients` + CSV bulk import
(clients.service.ts:112–192). **GAP: the LDA import (`POST /api/firm/import`) does NOT
enforce slots** — must be fixed before self-serve billing goes live.

**LDA import (live)**: `/api/firm/lda-registrants` (search) → `PUT /api/firm/registrant`
(anchor `tenants.lda_registrant_id`) → `/api/firm/import-candidates` → `POST /api/firm/import`
(chunked 100, confirmed `client_intel_mapping`, prepopulation cascade). UI:
`apps/web/src/pages/clients/FirmOnboardingWizard.tsx`. The onboarding dashboard reuses these
endpoints — the prototype's import overlay is already modeled on this exact flow.

**Clerk**: single prod instance, issuer `https://clerk.app.capiro.ai`; orgs=tenants
(`tenants.clerk_org_id`); role derived by `mapClerkRoleToCapiro(orgSlug, orgRole)`;
webhook `/webhooks/clerk` (svix, idempotent via `clerk_events`) + middleware self-heal;
invitation-only today (staff runbook `docs/runbooks/fresh-tenant-onboarding.md`,
`CapiroAdminService.createTenantWithFirstAdmin`). Sign-up is Clerk-hosted `<SignUp>`
(no confirm-password field). `packages/auth` (Option N) provides the narrow
verify-JWT→tenant-context guard used by orchestrator + workspace — **onboard-api adopts it**.

**Infra**: CDK in `infra/cdk` (6 stacks); **prod ALB (`capiro-prod-alb`) is manual/out-of-band**
(rules: p3 `/api/*,/webhooks/*,/health`→api, p5 host `capiro.ai`→marketing, p15 `/meri-api/*`→
meriv2, p20 default→web; `/workspace-api/*` added by hand). ComputeStack has drift
(references a deleted CDK ALB; reported UPDATE_ROLLBACK_FAILED). Certs: `app.capiro.ai` +
`*.app.capiro.ai`, and apex `capiro.ai`+`www` — **nothing covers `onboarding.capiro.ai`**.
CI: per-app GHA arm64 image builds; deploy via `scripts/deploy-dev.sh`.

**Email**: SES live (`alerts@`, `sales@`, `notifications@capiro.ai`). Microsoft 365 OAuth
live (delegated per-user, multi-tenant `/organizations`, cert auth, encrypted tokens,
Graph webhooks; app id `5dba7b19-929d-40d0-bf63-0f9143b3734f`). Customer M365 tenants
require **one-time org-wide admin consent** (Entra "Grant admin consent" or the
`/adminconsent` URL — documented in the fresh-tenant runbook §4a). **Google: UI stub only,
no backend, no GOOGLE_* config** — net-new build.

**Change control**: auth middleware, Clerk webhook, Microsoft OAuth files carry
⛔ CHANGE-CONTROL banners — every touch in this plan that crosses them is called out and
needs explicit sign-off + staging rehearsal.

---

## 3. Target architecture

```
capiro.ai (marketing)  ── "Get Started" ──▶ onboarding.capiro.ai
                                             │
                          ┌──────────────────┴───────────────────┐
                          │  onboard-web (SPA, served by onboard-api container)
                          │  • Flow 1 funnel (register→…→confirm)
                          │  • Flow 2A external setup dashboard
                          │  • IT-admin single-task page (tokened, no login)
                          └──────────────────┬───────────────────┘
                                             │ Bearer (Clerk JWT, same instance)
        ┌─────────────────────┬──────────────┴────────────┬─────────────────────┐
        ▼                     ▼                           ▼                     ▼
  onboard-api (NEW Fargate)  apps/api (existing)      Clerk Backend API      Stripe
  /onboard-api/*             /api/* (LDA import,      (orgs, invitations,    (customer,
  • onboarding state machine  team invites, firm AI,   users)                 SetupIntent,
  • purchaser + consents      tenant internal ops)                            subscription,
  • billing (MOVED here)     • stays billing READER                           invoices,
  • Stripe webhooks            (entitlement/slot 402)                         webhooks)
  • IT-admin tokens + emails
  • trial lifecycle crons
```

Decisions (per Ninja's corrections + audit):

1. **`onboard-api` owns**: the onboarding state machine, purchaser records, legal consents,
   IT-admin invite tokens, org-grant health checks, **all Stripe write paths** (checkout,
   setup intents, subscriptions, portal, webhooks, overage reporting), trial lifecycle
   (clock, conversion, reminders, lockout, retention/deletion), onboarding emails (SES).
   It gets its own tables (`onboard_*`) in the shared Aurora DB, migrated by its own
   migrate task (same pattern as intel-api's `intel_*`).
2. **`apps/api` stays the billing *reader***: slot 402 enforcement, `isBillingEntitled`
   gating, `GET /api/billing/summary` (read-only, so the app shell/banner doesn't need a
   second origin). All *mutating* billing endpoints move to onboard-api; the apps/api
   billing module's checkout/portal/webhook paths are deleted (not proxied) so there is
   exactly **one Stripe writer**. `packages/shared` pricing constants stay the shared
   source of truth.
3. **The external dashboard reuses existing tenant APIs with the admin's own Clerk JWT**
   (LDA import `/api/firm/*`, team invites `/api/tenant-admin/team/*`, firm-AI settings) —
   no duplication of import logic. Requires CORS allow-listing `onboarding.capiro.ai`
   on apps/api.
4. **Service-to-service**: onboard-api → apps/api internal endpoints reuse the existing
   `INTERNAL_SERVICE_SECRET` pattern (`/api/internal/*`, shipped for BYOK3) for tenant
   provisioning (wraps `createTenantWithFirstAdmin`-equivalent), firm-AI writes on behalf
   of the org, and setup-state reads.
5. **Domain**: `onboarding.capiro.ai` as a **Clerk satellite domain** (primary stays
   `app.capiro.ai`). Fallback if satellite proves fragile in staging:
   `onboarding.app.capiro.ai` (already inside the wildcard cert + cookie domain; requires
   reserving the `onboarding` tenant slug) — same code, one env var. Decision gate at
   Phase 0 exit.
6. **New CDK**: `onboard-api` is deployed from a **new, independent CDK stack**
   (`infra/cdk-onboard/` or a new `OnboardStack` in a separate app) that *imports* shared
   resources (VPC lookup, cluster by name, DB secret ARN) and **never touches the manual
   prod ALB** (target group created by the stack; listener rules added out-of-band by
   documented CLI, like workspace/meriv2). This honors "break the cdk deploy into
   independent cdks" without attempting to repair ComputeStack drift in the same window.

ALB additions (manual, documented, idempotent script in `scripts/onboard-alb-rules.sh`):

| Priority | Condition | Target |
|---|---|---|
| 8 | host `onboarding.capiro.ai` | onboard-api TG (serves SPA + API) |
| 9 | path `/onboard-api/*` (any host) | onboard-api TG |

`/onboard-api/*` does **not** collide with the existing p3 `/api/*`+`/webhooks/*` rule
(prefix match is from the path start). The **Stripe webhook URL becomes
`https://app.capiro.ai/onboard-api/webhooks/stripe`** — registered fresh in Stripe (billing
is dormant; there is no live webhook endpoint to migrate). The existing `/webhooks/*`→api
rule is untouched (Clerk webhook keeps working).

New ACM cert for `onboarding.capiro.ai` (DNS-validated) attached to the HTTPS listener as
an additional SNI cert + Route53 alias → `capiro-prod-alb`.

---

## 4. Data model changes

### 4.1 Existing tables (apps/api Prisma — one migration)

```
tenant_membership
  + billing_admin        boolean NOT NULL DEFAULT false   -- the "Super Admin" bit

tenants
  + onboarding_flow_version  int NULL          -- NULL for the 4 legacy tenants; 1 = self-serve
  + trial_ends_at            timestamptz NULL  -- set when setup completes (clock anchor)
  + price_lock_expires_at    timestamptz NULL  -- 2-year $200 lock
  + import_mode              text NULL         -- 'self' | 'managed'
  + courtesy_swap_used       boolean NOT NULL DEFAULT false
  (org profile fields — vertical, team size, tz, address — go into tenants.settings_jsonb
   under settings.orgProfile; logo uses the existing logo_s3_key path)
```

`billing_admin` semantics: only meaningful on `role='user_admin'` (guard ignores it
otherwise). Grantable by `capiro_admin` and by any member who already has
`billing_admin=true`; at least one billing admin enforced per tenant (cannot remove the
last one). Surfaced in **Settings → Team** as a per-member toggle (per Ninja: billing
permissions set under the current settings page).

### 4.2 New `onboard_*` tables (owned/migrated by onboard-api)

```
onboard_purchaser        id, clerk_user_id UNIQUE, email, first/last, org_name,
                         tenant_id NULL, stripe_customer_id NULL, created_at
onboard_session          id, purchaser_id, state (enum: registered→verified→plan_selected→
                         legal_accepted→payment_on_file→roles_designated→import_pref→
                         org_setup→provisioning→provisioned→failed), plan ('trial'|'paid'),
                         pay_method ('card'|'ach'|'wire'), profiles int, role_designations
                         jsonb, it_admin_emails text[], org_profile jsonb, slug_final,
                         updated_at   -- resumable funnel; one active session per purchaser
onboard_consent          id, session_id, clerk_user_id, doc_type ('tos'|'sa'),
                         doc_version, accepted_at, ip, user_agent      -- two rows per signup
onboard_legal_doc        id, doc_type, version, html, pdf_s3_key, effective_at, plan_variant
onboard_setup_task       tenant_id, task ('it_email'|'import'|'firm_ai'|'invites'),
                         status ('none'|'waiting'|'verifying'|'done'), completed_by, at
                         -- org-level so parallel admins don't duplicate effort (2A)
onboard_it_invite        id, tenant_id, email, token_hash, provider NULL ('microsoft'|'google'),
                         status ('sent'|'granted'|'verified'|'failed'), entra_tenant_id NULL,
                         google_domain NULL, expires_at, granted_at, verified_at
onboard_email_log        id, tenant_id NULL, purchaser_id NULL, kind (welcome|receipt|invite|
                         trial_d15|trial_d25|trial_d29|trial_ended|lockout…), sent_at, ses_msg_id
                         -- idempotency for the reminder cadence
onboard_billing_event    (optional) audit of subscription transitions per tenant
```

Stripe idempotency (`stripe_events`) and usage meters (`tenant_usage_meters`) move with the
billing code (same tables, writer changes — no schema change).

---

## 5. Phases

Ordering rule: each phase ships independently, is verifiable, and is dark for existing
tenants until its flag flips. Existing 4 tenants are protected throughout by
`onboarding_flow_version IS NULL` + `billing_status='comped'`.

---

### Phase 0 — Foundations & decisions (no user-visible change)

**Steps**
1. Ninja answers the Open Questions (§9) — especially domain approach, pricing sheet,
   legal-doc source, trial backstop.
2. Stripe (existing account, existing key): run an adapted `setup-stripe.ts` to create/verify
   products & prices (slot price @$200 with tier table, overage meter), enable **ACH
   (us_bank_account)** and **customer-balance/bank-transfer (wire)** payment method configs
   in the dashboard, create the webhook endpoint pointing at
   `https://app.capiro.ai/onboard-api/webhooks/stripe`. Capture `STRIPE_WEBHOOK_SECRET`.
3. Run `comp-existing-tenants.ts --commit` → all 4 live tenants `billing_status='comped'`
   BEFORE any enforcement ever turns on.
4. AWS: create ECR repo `capiro/dev/onboard-api`; new ACM cert `onboarding.capiro.ai`;
   Route53 A-alias → `capiro-prod-alb`; attach cert to HTTPS listener (SNI).
5. Clerk (maintenance window, via dashboard — Chrome MCP):
   a. Add satellite domain `onboarding.capiro.ai` (or record fallback decision).
   b. Flip sign-up mode to allow public sign-ups **with bot protection ON** — verify the
      app's behavior for an org-less user first on staging (an org-less user must dead-end
      gracefully, not 500).
   c. Add webhook events if missing (`organizationInvitation.accepted` already handled).
   d. **Do not touch**: JWT template `capiro`, existing webhook endpoint, org settings.
   Verification after each change: live login on app.capiro.ai (all 4 tenants' canary
   users), `/api/me` 200, Clerk webhook deliveries green in Svix.
6. CDK: scaffold the independent onboard stack (service, task def, TG, log group, secrets
   wiring; NO listener rules). GHA workflow `onboard-api-image.yml` (copy of api-image.yml).

**Success criteria**
- Stripe test-mode dry run: product/price IDs resolvable; webhook signed events received
  by a local listener.
- All 4 tenants show `comped`; zero change in app behavior (`BillingGate` still pass-through).
- `nslookup onboarding.capiro.ai` → ALB; ACM cert ISSUED; hitting it returns the web
  default rule for now (expected until Phase 1 rules).
- Clerk: existing users unaffected (canary logins fine); public sign-up allowed but the
  bare `/sign-up` on app.capiro.ai still routes org-less users to a friendly dead-end.
- `cdk synth` of the new stack references zero resources owned by ComputeStack.

**Rollback**: remove DNS record / cert; flip Clerk sign-up mode back to restricted.

---

### Phase 1 — `onboard-api` skeleton live (dark)

**Steps**
1. Scaffold `apps/onboard-api` (NestJS, port 4400, global prefix `/onboard-api`), adopting
   `@capiro/auth` (Option N narrow guard) for authenticated routes; health at
   `/onboard-api/health`; serves the built `onboard-web` SPA statically for host
   `onboarding.capiro.ai` (one container, marketing-style).
2. `onboard_*` Prisma schema + migrate task definition (`capiro-dev-onboard-migrate`).
3. Deploy the CDK stack; add the two ALB rules (p8 host, p9 path) via the documented
   script; wire secrets (DB URL, `INTERNAL_SERVICE_SECRET`, `OAUTH_STATE_SECRET`,
   Clerk secret key, SES creds via task role).
4. Extend `scripts/deploy-dev.sh` with `--onboard-only` (migrate → roll onboard-api).
5. CloudWatch: 5xx + unhealthy-target alarms on the new TG → `capiro-dev-alerts` (has
   subscribers since 2026-06-04).

**Success criteria**
- `https://onboarding.capiro.ai/onboard-api/health` → 200 via ALB; SPA shell renders.
- `https://app.capiro.ai/api/*`, `/meri-api/*`, `/workspace-api/*`, `/webhooks/clerk`
  all still route correctly (rule-priority regression check — scripted curl matrix).
- A Clerk-authenticated request to a protected onboard-api route returns tenant context
  (JWT verified against the same issuer).
- Deploy + rollback rehearsal: `aws ecs update-service --force-new-deployment` and
  scale-to-zero both clean.

**Rollback**: delete the 2 ALB rules (script has `--delete`); service scale 0. Nothing
else references it.

---

### Phase 2 — Billing moves to onboard-api + `billing_admin` permission

**Steps**
1. Port `billing/` module from apps/api → onboard-api (checkout, portal, setup-intents,
   subscription sync, webhook controller/service, overage service + daily cron). Same
   tables. Register the Phase-0 webhook endpoint; keep `stripe_events` idempotency.
2. apps/api: delete checkout/portal/webhook write paths; keep `GET /api/billing/summary`
   (reads tenant fields only) + 402 slot enforcement; **add the missing slot check to
   `POST /api/firm/import`** (LDA path) with role-aware 402 payloads (billing_admin →
   "purchase more"; user_admin → "ask a billing admin").
3. Migration: `tenant_membership.billing_admin` + backfill NOTHING (legacy tenants comped;
   capiro_admin can grant later). New `BillingAdminGuard` in apps/api (for the summary
   visibility rule) and onboard-api (for all mutating billing routes).
4. Web: Settings → Team gets the "Billing permission" toggle (visible to capiro_admin +
   billing admins; server-enforced: cannot remove last billing admin). Settings → Billing
   tab + `SubscribePage` + capiro-admin Customers re-point mutations to
   `/onboard-api/billing/*`; tab hidden entirely for non-billing-admins (Gherkin: billing
   fully hidden — today it shows to all user_admins).
5. Keep everything **dormant-safe**: onboard-api billing fails soft without
  `STRIPE_SECRET_KEY` exactly like today. The key is wired to onboard-api only (never
  back to apps/api), in test mode first.

**Success criteria**
- Test-mode e2e on staging tenant: checkout → webhook → `tenants.billing_status='active'`,
  `client_slots` set; portal opens; overage cron reports a synthetic delta once and is
  idempotent on rerun.
- `grep`-proof: zero Stripe *write* calls remain in apps/api (`stripe.` usages limited to
  none; module deleted); exactly one webhook consumer.
- LDA import at cap returns 402 with the role-correct message; under cap imports fine.
- A user_admin without billing_admin sees no billing tab, gets 403 on
  `/api/billing/summary`, and sees "Contact a billing admin" on locked purchase CTAs.
- Removing the last billing admin is rejected (400) — tested.
- All 4 live tenants: unchanged behavior (comped bypasses everything).

**Rollback**: re-point web mutations back; apps/api billing module restorable from git;
webhook endpoint disabled in Stripe. DB columns are additive.

---

### Phase 3 — Flow 1: registration & purchase funnel

Route map (all on `onboarding.capiro.ai`, step rail Account→Verify→Plan→Legal→Billing→
Admins→Clients→Org→Done, resumable via `onboard_session.state`):

1. **/register** — first/last, work email, org name, **password + confirm-password**.
   Custom form via Clerk's `useSignUp()` (headless), NOT the hosted `<SignUp>`:
   client-side match validation + Clerk password policy errors surfaced inline. Creates
   the Clerk user (org-less) + `onboard_purchaser` + session `registered`.
   *Also (separate PR, change-controlled): the invite-acceptance sign-up on app.capiro.ai
   gets the same custom form with confirm-password (ticket strategy), replacing the bare
   hosted component — per Ninja, account creation must always confirm the password.*
2. **/verify** — Clerk email-verification (code/link). Server blocks `state>registered`
   until `email_verified`. Resend affordance.
3. **/plan** — "Subscribe now" (recommended) vs "Start 30-day trial". Sets intended
   `billing_status` (`pending_payment` vs `trialing` — stored on session; tenant fields
   set at provisioning). Pricing copy (per Ninja): **"$200 per client profile — limited-time
   price: lock it in for 2 years"** + "prices subject to change" for everything beyond the
   lock (see Q3 on reconciling with volume tiers).
4. **/legal** — render current `onboard_legal_doc` (ToS + SA, SA text variant per
   plan/trial). Two checkboxes → two `onboard_consent` rows (user, timestamp, version, IP).
   SA readable in-page + "Download PDF" (pre-rendered `pdf_s3_key`). "Need custom terms?
   Contact us" mailto. The strings "MSA"/"Master Subscription Agreement" must not appear
   (copy lint in CI for the onboard-web bundle).
5. **/billing** — trial: **SetupIntent** (Card via Stripe Elements — raw card fields in
   the prototype are replaced by Elements for PCI SAQ-A; ACH via Financial Connections /
   micro-deposit mandate; Wire = billing-contact capture only, invoice at conversion).
   $0 today, method stored on Stripe customer. Paid: tier selector (min 10) + immediate
   subscription — card charges now; ACH debits (1–3d pending state); wire →
   `collection_method='send_invoice'` invoice with instructions; account enters
   pending-payment. Failure → retry state, session stays `legal_accepted`.
6. **/admins** — "Who will manage your organization's Capiro account?" Self-assign or
   invite ≥1 **Super Admin (billing admin)** + optional Admins. Stored on session.
7. **/clients** — import preference `self` | `managed`; `managed` → SES notification to
   Capiro CS inbox + flag on tenant (capiro_admin works the import later via existing
   admin tooling and marks the task complete).
8. **/org** — firm legal name, vertical, team size, timezone, address (→
   `tenants.settings_jsonb.orgProfile`), optional logo (S3 presigned, existing branding
   path), optional IT-admin email (early capture). **No slug field** — server generates
   from firm name (lowercase, dedupe with `-2`, reserved-word list incl. `onboarding`).
9. **/confirm** — provisioning bridge, then: "Platform created" (never "Tenant
   provisioned"), trial copy = "your 30-day trial begins when the firm finishes setting up
   its workspace" (never "Trial started"), receipt/invoice summary, admin-invite list.

**Provisioning (server, idempotent state machine on `onboard_session`)**
1. Create tenant + Clerk org via apps/api internal endpoint (reuses the
   `createTenantWithFirstAdmin` machinery — same code path as staff-created tenants, so
   webhook/self-heal behavior is identical). Sets `onboarding_flow_version=1`,
   `import_mode`, `client_slots` (10 for trial, N for paid), `billing_status`
   (`trialing` w/o started clock — see Phase 6 — or `active`/`past_due` per payment),
   `price_lock_expires_at = now()+24 months`, links `stripe_customer_id`.
2. **Health check** (must pass before any invite sends): tenant row + Clerk org exist and
   cross-link; org `public_metadata.capiro_tenant_id` set (JWT template resolves);
   `/api/health` 200; a synthetic JWT-less internal read of the tenant succeeds. Fail/timeout
   → invites HELD, session `failed`, SES alert to CS + CloudWatch alarm; retry button
   for purchaser support path.
3. Send role invites (Clerk org invitations; role admin; `public_metadata` carries
   name + `billing_admin:true` for Super Admins — the Clerk webhook + a small extension
   writes `billing_admin` onto the membership on accept). Redirect URL →
   `onboarding.capiro.ai` (external dashboard). Purchaser-self-assigned → org membership
   created directly + auto-login redirect to the dashboard.
4. Emails via SES (`onboarding@capiro.ai` — add the SES identity/from address):
   confirmation + receipt/invoice per plan (content matrix from Gherkin 1.11), IT-admin
   invite if captured.

**Success criteria**
- Synthetic e2e (staging, Stripe test mode) for all 6 paths {trial,paid}×{card,ach,wire}:
  funnel completes, tenant provisions, health check passes, invites send, consents have
  2 rows w/ version+IP, receipt email logged in `onboard_email_log`, Stripe objects match
  (customer, default PM or subscription).
- Password-confirm mismatch blocks with inline error; weak password shows Clerk policy
  error; resumability: kill browser mid-funnel at every state, resume lands on the right step.
- Abandoned unverified purchasers auto-expire (7d cleanup cron) without residue.
- Provisioning is idempotent: forced double-submit creates exactly one tenant/org (unique
  constraint on session→tenant).
- No invite is ever sent when the health check fails (fault-injection test: break the
  internal secret, verify invites held + CS alert).
- The word "Trial started" appears nowhere; "Platform created" does.

**Rollback**: funnel behind a `ONBOARD_FUNNEL_ENABLED` env flag → marketing "Get Started"
falls back to the current demo-request form.

---

### Phase 4 — Flow 2A: external setup dashboard + IT-admin path

**Steps**
1. Dashboard (authed, admin roles of tenants with `onboarding_flow_version=1` and setup
   incomplete): 4 task cards driven by `onboard_setup_task` (org-level, multi-admin safe;
   optimistic-lock on status transitions). Persistent `support@capiro.ai` link.
2. **Task 1 — Connect email provider (IT admin)**: invite by email → `onboard_it_invite`
   (signed token, 7-day expiry, multiple simultaneous contacts, resend, add-another).
   IT-admin page is tokened (NO Clerk account):
   - **Microsoft**: "Connect with Microsoft" → `https://login.microsoftonline.com/organizations/adminconsent?client_id=5dba7b19…&state=<signed>&redirect_uri=<onboard-api callback>`
     (new dedicated callback on onboard-api; the app registration gains this second
     redirect URI — Entra change, additive, zero risk to the existing app.capiro.ai
     callback). On `admin_consent=True&tenant=<id>`: store `entra_tenant_id`, task →
     `granted`. **Verified** when the first delegated user OAuth in that Entra tenant
     succeeds (Phase 5 gate reports back), or immediately if the IT admin optionally runs
     a personal test-connect.
   - **Google**: guided allowlist flow (no admin-consent URL equivalent exists):
     step-list with our OAuth client ID + copy button → Google Admin console → Security →
     API Controls → App Access Control → "Configure new app" → mark **Trusted**. Then a
     "Test connection" button runs a real OAuth code flow against the IT admin's own
     account with the production scopes; success → `granted`+`verified` in one step
     (this is the strongest self-service verification Google allows; a domain admin
     marking the app Trusted also exempts their users from Google's unverified-app
     block on restricted scopes).
   - Health-check semantics per Gherkin: **only the "Send team invites" step is gated**
     on this task; import + firm AI stay available in parallel. Failure → resend / add
     another contact.
3. **Task 2 — Import client profiles**: embeds the existing LDA wizard flow against
   `/api/firm/*` with the admin's JWT (CORS + the Phase-2 slot cap). Progress bar
   `imported/cap`; at-cap prompts are role-aware (billing_admin → upgrade CTA →
   onboard-api checkout; others → "ask a billing admin"). Capiro-managed mode: task shows
   "Capiro is handling your import" and is completed by capiro_admin (existing admin UI
   gets a "mark import complete" action).
4. **Task 3 — Firm AI settings**: three memory files — **Firm Soul + Firm Compass reuse
   the existing shipped firm-memory storage** (PR #257 wiring; same fields the app reads
   today, greyed example hints, never pre-filled); **Firm Playbook is added to that store**
   (one additive field-group; apps/api internal write; the steering/context loaders pick
   it up in a follow-up PR). Saving all three → `firm_ai_settings_configured=true`.
5. **Task 4 — Send team invites**: locked until IT ✓ AND import ✓ AND firm-AI ✓ (inline
   text lists what's missing). Rows email+role (+CSV bulk), sends standard-user invites
   with redirect → app.capiro.ai; after send, admins are routed into the app (Phase 5
   gate). Marks setup complete → **starts the trial clock** (Phase 6).
6. Invite edge cases: expired/revoked invite pages ("Invite expired, contact your
   administrator") on both surfaces; resend endpoints already exist for team invites.

**Success criteria**
- Two admins in parallel can't double-run a task (state transitions are compare-and-set;
  verified by a concurrency test).
- Microsoft path proven against a scratch Entra tenant: consent → granted; revoke consent
  in Entra → user connect fails → task flips back to `waiting` with guidance (re-check job).
- Google path proven against a scratch Workspace: without Trusted → test-connect shows the
  blocked screen and task stays `waiting` with the exact remediation text; with Trusted →
  verified.
- Import respects cap exactly at boundary (cap−1, cap, cap+1 tested); "Select all"
  truncates to remaining.
- Standard users cannot log into the app before invites-sent (Phase 5 gate returns them a
  friendly "your firm is still setting up" screen — tested).
- IT-admin token: single-use-per-action, expiring, unguessable (hash-stored), and the page
  exposes zero tenant data beyond firm display name.

---

### Phase 5 — Flow 2B: in-app personal gate, tour, trial UX (apps/web)

**Scope guard**: everything here activates **only** for tenants with
`onboarding_flow_version=1` — the 4 live tenants see zero change (their users are already
connected/working; retro-gating them would lock out paying users).

**Steps**
1. **SetupGate** (after BillingGate): if tenant setup incomplete and user is admin →
   redirect to the external dashboard; if standard user → "firm still setting up" screen.
2. **Email/calendar hard gate** on first login: modal (no skip) with Connect Microsoft /
   Connect Google → existing per-user OAuth (`/api/engagement/integrations/microsoft/start`;
   Google added in Phase 7). Success also reports org-grant "verified" (Phase 4 handshake).
3. **Personal AI settings** step: optional, skippable, revisitable (existing personal
   memory/settings surface).
4. **7-step tour**: auto-launch on first dashboard load (dim overlay, spotlight, n/7 rail,
   Back/Next/Skip/Finish), exactly the step order+headlines from the Gherkin table; Meri
   stays the floating bottom-right assistant (never a nav item). `tour_done` per-user;
   re-openable from "Help & product tour" in the sidebar.
5. **Trial UX**: persistent banner (days remaining + `used/10` profiles) on every screen
   when `billing_status='trialing'`; Upgrade CTA only for billing admins → onboard-api
   checkout (prorated upgrade converts immediately). Locked-feature helper strings by role
   (billing admin: "Available on the full plan — Upgrade now"; everyone else: "Ask a
   billing admin to upgrade").

**Success criteria**
- Legacy-tenant regression suite: a c2-strategies/maven/victory-six user sees no gate, no
  banner, no tour prompt (flag test with impersonation).
- New-tenant user cannot reach any app route without a connected integration (deep-link
  attempts bounce to the gate); after connect, lands on dashboard with tour step 1.
- Tour: skip/finish persists across logins; Help re-launches at step 1; step targets exist
  on all viewport sizes ≥1024px.
- Trial banner day-count matches `trial_ends_at` (UTC-safe, parses as local dates per the
  Meetings-tab lesson).

---

### Phase 6 — Trial & billing lifecycle engine (onboard-api crons)

**State machine (tenant-level)**

```
provisioned(trial, clock NOT started)
   └─ setup complete (invites sent) → trial_ends_at = now()+30d ── reminders d1/15/25/29-30
        ├─ billing-admin upgrades early → subscription active (prorated) → 'active'
        ├─ cancel by day 30 → 'canceled' → data retained 90d → hard delete
        └─ day 31: create/activate subscription from stored method
             ├─ card: charge now → 'active' (fail → 'past_due' + dunning emails)
             ├─ ach: debit (1–3d) → 'active' on settle / 'past_due' on fail
             └─ wire: issue invoice (send_invoice) → 'past_due(pending)' until funds
paid(wire/ACH) unpaid after X days → LOCKOUT: billing_status drives BillingGate lockout
   screen (payment instructions + confirmation path); payment confirmed → restored
```

**Steps**
1. Daily cron (EventBridge → onboard-api task, same pattern as report-llm-overage):
   trial conversions due, reminder cadence (keyed off `onboard_email_log` for
   idempotency — counted from setup completion, not registration), wire/ACH lockout after
   `ONBOARD_UNPAID_LOCKOUT_DAYS` (env; **X TBD by Jordan**), retention sweep (canceled
   ≥90d → hard delete via the existing tenant-cascade delete, with a
   `deletion_hold` capiro_admin escape hatch + 7-day pre-delete warning email).
2. Lockout screen in apps/web driven by a new `locked` read on billing summary
   (`past_due` beyond X → locked; Gherkin: all access suspended).
3. Courtesy swap: **support-mediated only** — a capiro_admin action (existing admin
   surface) that archives one client + frees a slot, allowed once
   (`courtesy_swap_used` flip). No UI mention anywhere else (copy-lint).
4. Trial-never-started backstop (**needs Ninja/Jordan decision, Q4**): default proposal —
   if setup incomplete 30 days after provisioning, email purchaser+admins; at 60 days,
   auto-cancel without charge.

**Success criteria**
- Clock manipulation tests (staging, injected dates): each reminder fires exactly once;
  day-31 conversion per method produces the right Stripe object and status; early upgrade
  prorates and kills the banner; cancel → 90-day retention row + delete job dry-run lists
  exactly that tenant.
- Lockout: unpaid wire tenant locks on day X, users see the lockout screen (not a 500),
  capiro_admin "payment confirmed" restores access within one request cycle.
- Cron is idempotent (double-run produces no duplicate emails/charges — enforced by
  `onboard_email_log` + Stripe idempotency keys).

---

### Phase 7 — Google email/calendar integration — **CUT (Ninja decision Q5, 2026-07-06)**

Skipped entirely for v1: no Google OAuth backend, no Google Cloud/CASA work. The
IT-admin page and the personal email gate are Microsoft-only; Google buttons render
disabled ("Coming soon") to stay prototype-faithful. Original plan text retained below
for when Google is revisited.

<details><summary>Original Phase 7 (deferred)</summary>

Prereq for the hard gate at Google-shop customers; mirrors the Microsoft module.

**Steps**
1. Google Cloud (neo@capiro.ai via Chrome): create/confirm project, OAuth consent screen
   (External), branding + domains, scopes `gmail.readonly`, `calendar.readonly` (+
   `gmail.send` **only if** outbound-mail parity is required — see Q6; every added
   restricted scope raises the verification bar), redirect URI
   `https://app.capiro.ai/api/engagement/integrations/google/callback`. Create OAuth
   client (web). **Start Google brand verification immediately** (restricted-scope/CASA
   review runs weeks-long in parallel; customer Workspace admins marking us Trusted are
   unblocked meanwhile — that's the Phase 4 flow).
2. `apps/api/src/engagement/google/`: `google-oauth.controller/service.ts` mirroring the
   Microsoft pattern exactly (signed state HMAC, code exchange, refresh-token persistence
   **with rotation persisted** — do not re-create the Microsoft refresh-storm bug —
   AES-256-GCM token storage in the existing `integration_connection_token` table,
   provider `google_workspace`), config schema `GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI`.
   ⛔ change-controlled area: staging first, Neo sign-off.
3. Sync: Gmail API history-based incremental + Calendar API sync tokens, feeding the same
   `mail_*`/`meeting` tables the Microsoft sync feeds (adapter parity checklist so
   Meri/engagement features are provider-agnostic).
4. IntegrationsPage: activate the existing Google provider card (start/sync/status).

**Success criteria**
- neo@capiro.ai end-to-end on staging: connect → tokens stored encrypted → mail+calendar
  rows land → refresh survives >1h token expiry → disconnect cleans up.
- A Workspace tenant WITHOUT Trusted marking shows the correct guided error.
- Parity checklist: every consumer of `IntegrationConnection` handles
  `google_workspace` (grep-audited list, each signed off).

</details>

---

### Phase 8 — Hardening, wiring verification, launch

**Steps**
1. **Full-wire verification matrix** (Ninja's "completely wired and functioning" ask):
   - Clerk: purchaser sign-up w/ confirm-password; invite-accept w/ confirm-password;
     satellite-domain session shared onboarding↔app; webhooks green in Svix; JWT template
     claims intact; all 4 legacy tenants' logins unaffected.
   - Auth: role matrix probed by automated tests (billing hidden from non-billing-admins
     everywhere incl. 402 payloads).
   - Email: SES sends from `onboarding@`/`alerts@`/`notifications@` (DKIM aligned);
     Clerk invitation mails; reminder cadence; Microsoft org-consent + per-user connect;
     Google trusted-app + per-user connect.
   - Billing: the 6 {plan×method} paths in **live mode** with a real $1-tier test price,
     then real pricing; webhook signature; overage cron.
2. Load/abuse: rate-limit registration + IT-token endpoints (per-IP + per-email);
   disposable-email domain blocklist; Clerk bot protection verified.
3. SOC 2 evidence: consent records export, audit-log entries for billing permission
   grants, provisioning events, deletion job logs; update the audit-window doc.
4. Runbooks: `docs/runbooks/onboarding-operations.md` (failed health check, stuck
   provisioning, lockout override, courtesy swap, refunds), plus ALB-rule +
   cert renewal notes; alarm wiring documented.
5. Launch: flip `ONBOARD_FUNNEL_ENABLED` on prod, point marketing "Get Started" at
   `onboarding.capiro.ai`, monitor first cohort with a temporary CS notification on every
   registration (SES to sales@).

**Success criteria**: every row of the verification matrix checked off in a tracking
issue with evidence links; one clean pilot signup end-to-end in prod (real card,
refunded) before the marketing CTA flips.

---

## 6. Onboarding-field → platform mapping (nothing entered is throwaway)

| Collected at | Field | Lands in |
|---|---|---|
| 1.2 register | name/email/password | Clerk user (purchaser) |
| 1.2/1.9 | organization/firm legal name | `tenants.name` |
| 1.4/1.6 | plan, tier N | `tenants.billing_status`, `client_slots`, Stripe subscription |
| 1.5 | ToS/SA acceptance | `onboard_consent` (×2, versioned) |
| 1.6 | payment method | Stripe customer default PM / mandate |
| 1.7 | Super Admin/Admins | Clerk org invitations → memberships (`user_admin`, `billing_admin` bit) |
| 1.8 | import preference | `tenants.import_mode` (+ CS notify) |
| 1.9 | vertical, team size, tz, locale, address | `tenants.settings_jsonb.orgProfile` |
| 1.9 | logo | existing `logo_s3_key` branding path |
| 1.9/2A | IT admin email(s) | `onboard_it_invite` |
| 2A.2 | LDA registrant + clients | `tenants.lda_registrant_id`, `clients`, `client_intel_mapping` (existing import) |
| 2A.4 | Firm Soul/Compass/Playbook | existing firm-memory store (Playbook = additive field-group) |
| 2A.5 | team invites | Clerk org invitations → memberships |
| 2B.1 | email/calendar connect | `integration_connection`(+token) |
| 2B.3 | personal AI prefs | existing per-user memory/settings |

---

## 7. What changes where (repo layout)

```
apps/onboard-api/            NEW — NestJS service + onboard_* prisma schema + crons
apps/onboard-web/            NEW — Vite SPA (funnel + dashboard + IT page); built into the
                             onboard-api image (single container, marketing-style serve)
apps/api/                    billing writes removed; slot check added to /api/firm/import;
                             internal provisioning endpoint; google/ engagement module (P7);
                             billing_admin guard + summary visibility; CORS for onboarding host
apps/web/                    Settings→Team billing toggle; Billing tab re-point + hide;
                             SetupGate + hard email gate + tour + trial banner (flag-scoped);
                             custom sign-up form w/ confirm password
packages/shared/             billing_admin types; onboarding state enums; pricing copy consts
packages/auth/               unchanged (consumed by onboard-api)
infra/cdk-onboard/           NEW independent CDK app (service/TG/logs/alarms; no ALB rules)
scripts/                     onboard-alb-rules.sh; deploy-dev.sh --onboard-only
.github/workflows/           onboard-api-image.yml
```

---

## 7-A. DEPLOY WORKSHEET (live AWS facts, verified 2026-07-07 via capirocli)

- Cluster `capiro-dev`; existing services: api(:34), web(:6), marketing, workspace,
  meriv2-orchestrator, intel-api(:8), clio-sandbox.
- Subnets `subnet-0e38bd390f8961fef, subnet-0920665f91c905f01, subnet-06db79cd21239de19`;
  SG `sg-01def4e5c0fe44d4a`; assignPublicIp DISABLED (mirror for onboard-api).
- Roles (shared by intel-api — reused in the onboard taskdefs):
  exec `…role/Capiro-dev-Compute-ApiTaskDefExecutionRoleE6ABB053-YlEDKuUPHjLg`,
  task `…role/Capiro-dev-Compute-ApiTaskRole12FAD4A7-szq3QeeZJSCQ` (has SES send —
  tracker emails run under it).
- ALB `capiro-prod-alb` (arn …7a4acb332b261724, dns capiro-prod-alb-57164953…,
  hosted-zone Z35SXDOTRQ7X7K). HTTPS listener `…e2d19b3dd47fc440`.
  **Actual rules**: p10 /api/* → capiro-prod-api-tg · p12 /workspace-api/* · p13
  /meri-api/* · p14 /intel-api/* → capiro-dev-intelapi-albtg · p15 /webhooks/* →
  api-tg · p20 host capiro.ai,www → marketing · default → web.
  → onboard rules use free priorities **8 (host onboarding.capiro.ai)** and
  **9 (path /onboard-api/*)** via scripts/onboard-alb-rules.sh.
- Cert on the 443 listener: b3ed3fa7… SANs app.capiro.ai + capiro.ai + **\*.capiro.ai
  — onboarding.capiro.ai is ALREADY covered; NO new ACM cert needed** (red-flag
  cert item dissolves).
- Route53: zone Z085985135X6Q5QT98ZBK (capiro.ai) → create A/AAAA alias
  onboarding.capiro.ai → the ALB.
- Secrets (real ARNs, already wired into infra/deploy/onboard-api-*.json):
  clerk secret `/capiro/dev/clerk/secret-key-FT67tM`; internal secret
  `capiro/dev/internal-service-secret-6cEZG4`; oauth-state
  `capiro/dev/oauth-state-secret-XOOzYB`; ms client id
  `capiro/dev/microsoft-client-id-AU8xuO`; aurora master `-P4z1Vo` (host/port; +
  username/password for the MIGRATE task, matching capiro-dev-api-admin-migrate)
  and app `-zNPtsU` (username/password for serve). DB_NAME=capiro via env.
  **No Stripe secret exists anywhere in Secrets Manager** → P8 creates
  `capiro/dev/onboard/stripe-secret-key` + `…/stripe-webhook-secret` after the
  key is retrieved from the Stripe dashboard (Chrome).
- Clerk publishable key (public): `pk_live_Y2xlcmsuYXBwLmNhcGlyby5haSQ`.
- SES: domain identity capiro.ai VERIFIED → onboarding@capiro.ai sends under it.
- DONE 2026-07-07 (additive, invisible until service exists): ECR repo
  `capiro/dev/onboard-api` (scanOnPush) ✓; `capiro-gha-api` ecr-push policy
  extended (+dev/staging onboard-api; 16 resources verified) ✓; log group
  `/capiro/dev/onboard-api` ✓; exec-role inline policy `onboard-api-ecr-secrets`
  (ECR pull + `capiro/dev/onboard/*` secret reads; recorded at
  infra/deploy/onboard-api-execrole-inline-policy.json) ✓.
- Still to create in P8: the 2 Stripe secrets under `capiro/dev/onboard/*`,
  register the two taskdefs, TG `capiro-dev-onboardapi-albtg` (port 4400, health
  `/health`), service `capiro-dev-onboard-api`, the 2 ALB rules, Route53 alias
  (defer DNS until rules exist so the host never falls through to the web SPA),
  EventBridge rules for `task report-llm-overage` + `task lifecycle-daily`,
  Entra app: add redirect URI https://app.capiro.ai/onboard-api/it/microsoft/callback.

## 8. Red flags (surfaced during audit — please read)

1. **Prod ALB is hand-managed and ComputeStack is wedged** (references a deleted ALB;
   UPDATE_ROLLBACK_FAILED). Any `cdk deploy` of the existing ComputeStack is dangerous.
   The independent onboard stack sidesteps this, but the drift itself should be scheduled
   for remediation separately — it's a standing landmine for every future service.
2. **Prototype promises `{slug}.capiro.ai`** — that URL scheme doesn't exist (and the
   landing shows `capiro.com`). Copy must say `app.capiro.ai`. If real vanity URLs are
   wanted, `{slug}.app.capiro.ai` wildcard already exists but multi-domain Clerk/session
   behavior there is untested — recommend keeping it cosmetic-only in v1.
3. **Opening Clerk to public sign-up** changes the platform's security posture
   (today: invitation-only). Needs bot protection, rate limiting, disposable-domain
   blocking, and a verified graceful dead-end for org-less users — an org-less
   authenticated user hitting apps/api is an untested path today.
4. **Confirm-password requires replacing Clerk's hosted `<SignUp>`** with a headless
   custom form on BOTH surfaces (funnel + invite-accept). Invite-accept uses the ticket
   strategy and is change-controlled auth code with a history of tenant-wide outages —
   this is a small feature with a big blast radius; staging rehearsal is mandatory.
5. **Google restricted scopes**: `gmail.readonly` triggers Google's restricted-scope
   verification (CASA security assessment — weeks, external cost). Mitigation: customer
   Workspace admins marking Capiro "Trusted" exempts their domain (that's our IT-admin
   flow), but consumer Gmail and non-trusted domains stay blocked until verification
   completes. Start verification at Phase 0, not Phase 7.
6. **"Wire on file" is not a storable instrument.** A wire trial is an honor-system
   trial: day-31 conversion just issues an invoice, and enforcement is the lockout after
   X days — with X still TBD (Jordan). Until X is set, a wire "trial" is effectively
   30 days + X of free usage. Same for paid-wire: workspace provisions immediately,
   money arrives later.
7. **Trial clock anchored to setup completion means some trials never start** — a stored
   card that is never charged, indefinitely. Needs the backstop policy (Q4).
8. **LDA import bypasses the slot cap today** (`POST /api/firm/import` has no 402 check)
   — must land with/before billing activation or self-serve tenants can import unlimited
   profiles.
9. **Pricing copy conflict**: shared constants already grant volume tiers ($180/$160),
   the Gherkin says "$200 flat + contact sales", and the new ask adds "limited-time $200,
   2-year lock". Three stories; one price sheet needed (Q3). Also "prices subject to
   change" must be reworded to coexist with a 24-month lock ("locked for 24 months from
   subscription; thereafter subject to change").
10. **Two billing writers during migration** — mitigated by deleting (not proxying) the
    apps/api write paths in the same PR that activates onboard-api's, plus a grep-gate in CI.
11. **Existing `/settings/billing` is visible to all user_admins today**; Gherkin demands
    billing be invisible to non-billing-admins. Flipping this changes what current live
    tenants' admins see — comped tenants show no billing data anyway, but the tab removal
    should be release-noted to Ninja before shipping (it also affects capiro-internal).
12. **`onboarding.capiro.ai` isn't covered by any existing cert** and the Clerk satellite
    domain feature is net-new for this instance — both are Phase 0 items with a tested
    fallback (`onboarding.app.capiro.ai`).
13. **Open Gherkin dependencies**: wire/ACH lockout X (Jordan), tier increments above 10
    (Jordan), IT-admin credential fate post-health-check. None block Phases 0–5; X blocks
    Phase 6 lockout timer (env-var'd so the code ships anyway).
14. **Legal content**: ToS/SA text in the prototype is filler. Real, versioned documents
    (+ per-plan SA variants + PDFs) are an offline dependency — consents are only as good
    as the docs they reference.

## 9-A. DECISIONS (Ninja, 2026-07-06) — answers to §9

1. **Domain**: YES — `onboarding.capiro.ai` as Clerk satellite domain;
   `onboarding.app.capiro.ai` is the tested fallback.
2. **Pricing**: follow the new plan — **flat $200/slot self-serve (min 10), headline
   "limited-time price — lock it in for 2 years"**; volume discounts are contact-sales
   copy only (the shipped $180/$160 auto-tiers are neutralized to $200 so self-serve
   never discounts silently); `price_lock_expires_at = subscribe + 24mo`; "prices subject
   to change" reworded to "locked for 24 months from subscription; thereafter subject to
   change."
3. **Trial backstop**: YES — nudge at +30d, auto-cancel (no charge) at +60d if setup
   never completes.
4. **Hard delete at 90d**: YES — with capiro_admin `deletion_hold` + 7-day warning email.
5. **Google**: **SKIP entirely** (no Google OAuth backend, no CASA). Phase 7 is cut.
   IT-admin page and personal gate ship **Microsoft-only**; the Google button renders
   (prototype-faithful) but disabled with a "Coming soon" tag.
6. **Billing permission**: grantable by capiro_admin + existing billing admins; **no
   minimum/limit enforced** (a tenant may have zero billing admins; capiro_admin can
   re-grant).
7. **Legal docs**: TBD with counsel — **ship v1 placeholder ToS + SA now** (versioned
   `2026-07-v1-draft`, based on prototype text, marked for counsel replacement).
8. **Billing-tab visibility flip**: YES — billing fully hidden from non-billing-admins.
9. **Upgrade flows**: YES — in-app upgrade path stays (re-pointed to onboard-api); new
   purchases on onboarding.capiro.ai.

## 9. Open questions for Ninja (answered above — kept for history)

1. **Domain**: OK to add `onboarding.capiro.ai` as a Clerk satellite domain (my
   recommendation, matches the spec), with `onboarding.app.capiro.ai` as the tested
   fallback if satellite auth misbehaves in staging?
2. **Who can grant billing permission**: proposal = capiro_admin + any existing billing
   admin, min 1 per tenant. Confirm?
3. **Final price sheet**: keep the shipped volume tiers ($180 @50, $160 @100) alongside
   "$200 limited-time with 2-year lock", or flat $200 + "contact sales"? And does the
   2-year lock apply to the tier price or only the $200 band?
4. **Trial-never-started backstop**: proposal = nudge at +30d, auto-cancel (no charge) at
   +60d if setup never completes. Confirm/adjust?
5. **Cancel-then-delete**: Gherkin says hard delete after 90 days, no read-only grace.
   Confirm you want true hard deletion (with a capiro_admin hold + 7-day warning email),
   given SOC 2 retention posture.
6. **Google scope depth**: read-only (gmail.readonly + calendar.readonly) for v1, or full
   Microsoft parity (send + read-write) — parity roughly doubles the verification burden
   and the IT-admin trust ask?
7. **Legal docs**: who produces the real ToS + SA (and the SA trial/paid variants)? I can
   draft placeholders, but they need counsel before launch.
8. **`/settings/billing` visibility flip** (red flag 11) — confirm.
9. **Existing dormant billing UI** (`SubscribePage`, BillingGate paywall redirect): keep
   as the in-app upgrade path (re-pointed to onboard-api), or should ALL purchase flows
   live on onboarding.capiro.ai only? (Proposal: keep in-app for upgrades — it's the
   Gherkin 1.6b-reuse requirement for early upgrade.)
