# Capiro-dev-Compute — CloudFormation Drift Findings & Remediation Runbook

> Status as of 2026-06-01. Investigation by Hermes (read-only). **No remediation
> has been applied.** This document is the playbook for a future planned
> maintenance window.
>
> **UPDATE 2026-07-17 (re-verified):** Still `UPDATE_ROLLBACK_FAILED`; data plane
> still healthy (app.capiro.ai 200s, all ECS services running=desired). Two changes
> since 06-01:
> - A **2026-06-27** `cdk deploy` (adding the **Workspace** service) re-attempted and
>   failed on the same phantom ALB, so the stuck set evolved (now 17 resources — the
>   **`Alb16C2F182` LB resource itself** is `UPDATE_FAILED` "LoadBalancer … not found",
>   plus `Workspace*` create-cancelled; see the refreshed list below). The 05-27 Clio
>   resources are no longer the live wedge.
> - **Step C is now essentially DONE in code:** the `dev` block already uses
>   app.capiro.ai / capiro.ai, and on 2026-07-17 `auroraMaxAcu` (2→4) and
>   `auroraBackupRetentionDays` (7→35) were corrected to match live (verified:
>   MinACU 0.5 / MaxACU 4 / 35-day). A future diff should no longer shrink Aurora.
> - **Still NOT done (the supervised window):** Step A (unstick), **Step B (ALB
>   reconcile — `compute-stack.ts:~1313` still does `new ApplicationLoadBalancer`)**,
>   Step D (one careful deploy after `cdk diff` is clean). Keep shipping out-of-band.

## TL;DR

- The **data plane is healthy**: `app.capiro.ai` serves 200s, API (2/2) + web (1/1)
  ECS tasks HEALTHY, ALB `capiro-prod-alb` active, Aurora at 35-day backup / 4 MaxACU.
  **Nothing user-facing is broken.**
- The **control plane is stuck**: CloudFormation stack `Capiro-dev-Compute` is in
  **`UPDATE_ROLLBACK_FAILED`** and has been since **2026-05-27 03:09 UTC**
  (an earlier wobble occurred 2026-05-05).
- **Do NOT run `cdk deploy Capiro-dev-Compute`** until the steps below are done.
  A deploy from this state will fail, and even once unstuck the current repo config
  would attempt **destructive** changes (ALB/cert replacement, Aurora shrink).
- **Keep shipping via out-of-band ECS task-def revisions** (the approach used for the
  SAM.gov key — clone live task def, edit JSON, `register-task-definition`, run by
  pinned revision). This is the proven safe path while the stack is frozen.

---

## Root cause (three stacked problems)

### 1. Stack is hard-stuck in UPDATE_ROLLBACK_FAILED
A `cdk deploy` on **2026-05-27 03:08:51 UTC** ("User Initiated") attempted to:
- **Add a Clio runtime**: EFS file system, 3 security groups, 2 IAM roles, log group,
  and a ServiceDiscovery PrivateDnsNamespace.
- **Update the ALB listener rules** (`AlbHttpsApiPathsRule`, `AlbHttpsWebDefaultRule`).

The ALB listener-rule update failed first:
```
AlbHttpsApiPathsRule6E83568D  UPDATE_FAILED
  "All rules were not found (ElasticLoadBalancingV2, 400)"
AlbHttpsWebDefaultRule11F4E7A3 UPDATE_FAILED
  Rule 'arn:aws:elasticloadbalancing:...:listener-rule/app/Capiro-Alb16-PWSBu59pPfLj/...' not found
```
The update was rolled back, but the **rollback also failed** (03:09:01) because the
DNS alias records could no longer resolve the load balancer:
```
AppAlias375015D0 / AppWildcardAlias7B653A1B  UPDATE_FAILED
  "Unable to retrieve CanonicalHostedZoneID ... One or more load balancers not found"
```
→ stack landed in `UPDATE_ROLLBACK_FAILED`. CloudFormation refuses all further
updates from this state.

### 2. The ALB CFN manages is a phantom — the live ALB was replaced out-of-band
- CFN's stack references an ALB it expected to be named **`Capiro-Alb16-PWSBu59pPfLj`**.
- The **only ALB in the account** is **`capiro-prod-alb`** (active), created/renamed
  out-of-band:
  - ARN: `arn:aws:elasticloadbalancing:us-east-1:967807252336:loadbalancer/app/capiro-prod-alb/7a4acb332b261724`
  - DNS: `capiro-prod-alb-57164953.us-east-1.elb.amazonaws.com`
  - CanonicalHostedZoneId: `Z35SXDOTRQ7X7K`
- So the control plane (CFN) and data plane (real infra) have fully diverged on the ALB.
  This is the proximate cause of the failed update.

### 3. The repo `dev` config was authored for a DIFFERENT account + domain scheme
Introduced by commit **`9f9cfc6` "Wire dev environment for the wrong AWS account"**.
The repo's `dev` override block (`infra/cdk/lib/config.ts`) currently sets:
| Setting | Repo (config.ts dev block) | Live reality |
|---|---|---|
| appHost | `app-dev.capiro.ai` | `app.capiro.ai` |
| wildcardHost | `*.app-dev.capiro.ai` | `*.app.capiro.ai` |
| rootDomain | `app-dev.capiro.ai` | `capiro.ai` |
| auroraBackupRetentionDays | `7` | `35` |
| auroraMaxAcu | `2` | `4` |

A `cdk diff` against the live account therefore shows these as **requires-replacement**
(ACM cert + DNS) and **shrink** (Aurora) changes. That commit targeted a
**wrong/legacy** account (the GHA OIDC role ARNs previously pointed there too —
now corrected to `967807252336`); the live cluster is in
**`967807252336`**. So even after unsticking the stack, deploying the current repo
config would try to swap the cert/domain (**breaking `app.capiro.ai`**) and shrink Aurora.

---

## The stuck resources — CURRENT (17, refreshed 2026-07-17)
From `aws cloudformation list-stack-resources --stack-name Capiro-dev-Compute`
(status != *_COMPLETE). This SUPERSEDES the 2026-05-27 list (the Clio resources are
gone; the 2026-06-27 Workspace attempt is the live wedge, and the ALB resource itself
now shows UPDATE_FAILED "LoadBalancer … not found"):

| Logical ID | Type | Status |
|---|---|---|
| Alb16C2F182 | ELBv2::LoadBalancer | UPDATE_FAILED (LB not found) |
| ApiTaskRoleDefaultPolicyBEF5D530 | IAM::Policy | UPDATE_FAILED (cancelled) |
| ApiTaskDefExecutionRoleDefaultPolicy358EAD94 | IAM::Policy | UPDATE_FAILED (cancelled) |
| ApiMigrateTaskDefExecutionRoleDefaultPolicy2744B7FC | IAM::Policy | UPDATE_FAILED (cancelled) |
| ApiEmbedBackfillLogsF4C5E74F | Logs::LogGroup | CREATE_FAILED |
| ApiEmbedBackfillTaskDefEventsRole46E64944 | IAM::Role | CREATE_FAILED |
| ApiEmbedBackfillTaskDefExecutionRoleAFB54A52 | IAM::Role | CREATE_FAILED |
| ApiSyncJobsLogs4714C6F9 | Logs::LogGroup | CREATE_FAILED |
| ApiSyncJobsTaskDefEventsRoleECDC9F5F | IAM::Role | CREATE_FAILED |
| ApiSyncJobsTaskDefExecutionRole495B990D | IAM::Role | CREATE_FAILED |
| ClusterDefaultServiceDiscoveryNamespaceC336F9B4 | ServiceDiscovery::PrivateDnsNamespace | CREATE_FAILED |
| WorkspaceLogs96AE2C30 | Logs::LogGroup | CREATE_FAILED |
| WorkspaceMigrateLogs7E1F2880 | Logs::LogGroup | CREATE_FAILED |
| WorkspaceMigrateTaskDefExecutionRoleFE94B01B | IAM::Role | CREATE_FAILED |
| WorkspaceTargetGroup394BF056 | ELBv2::TargetGroup | CREATE_FAILED |
| WorkspaceTaskDefExecutionRole1AB2D268 | IAM::Role | CREATE_FAILED |
| WorkspaceTaskRole489F0628 | IAM::Role | CREATE_FAILED |

---

## Remediation runbook (PLANNED WINDOW ONLY — eyes-on, with rollback plan)

> Pre-flight: snapshot Aurora, confirm app.capiro.ai serving 200s, have the
> `capiro-prod-alb` ARN + listener ARNs handy, and a second operator watching.
> Do steps in order; stop and reassess if any output is unexpected.

### Step A — Unstick the rollback (low risk, no live-infra change)
Skip the 14 wedged resources so CFN can reach a terminal `UPDATE_ROLLBACK_COMPLETE`.
The CREATE_FAILED Clio/embed resources never finished creating, so skipping them just
drops the phantom create. The UPDATE_FAILED ALB rules / IAM policies stay as-is in
the template (we reconcile in B/C).

> ⚠️ Skip-list refreshed 2026-07-17 to the CURRENT 17 stuck resources. Skipping
> `Alb16C2F182` leaves the phantom LB record in the stack — that is fine for
> unsticking, but it MUST be reconciled in Step B before any deploy. Re-run
> `list-stack-resources` right before the window in case the set drifted again.
```bash
MSYS_NO_PATHCONV=1 aws cloudformation continue-update-rollback \
  --stack-name Capiro-dev-Compute \
  --resources-to-skip \
    Alb16C2F182 \
    ApiTaskRoleDefaultPolicyBEF5D530 \
    ApiTaskDefExecutionRoleDefaultPolicy358EAD94 \
    ApiMigrateTaskDefExecutionRoleDefaultPolicy2744B7FC \
    ApiEmbedBackfillLogsF4C5E74F \
    ApiEmbedBackfillTaskDefEventsRole46E64944 \
    ApiEmbedBackfillTaskDefExecutionRoleAFB54A52 \
    ApiSyncJobsLogs4714C6F9 \
    ApiSyncJobsTaskDefEventsRoleECDC9F5F \
    ApiSyncJobsTaskDefExecutionRole495B990D \
    ClusterDefaultServiceDiscoveryNamespaceC336F9B4 \
    WorkspaceLogs96AE2C30 \
    WorkspaceMigrateLogs7E1F2880 \
    WorkspaceMigrateTaskDefExecutionRoleFE94B01B \
    WorkspaceTargetGroup394BF056 \
    WorkspaceTaskDefExecutionRole1AB2D268 \
    WorkspaceTaskRole489F0628
# then poll until UPDATE_ROLLBACK_COMPLETE:
MSYS_NO_PATHCONV=1 aws cloudformation describe-stacks \
  --stack-name Capiro-dev-Compute --query 'Stacks[0].StackStatus' --output text
```
**Stop here if all you need is an updatable stack.** Do NOT deploy yet — B and C
must be done first or the next deploy is destructive.

### Step C — Fix the repo `dev` config to match reality — ✅ DONE IN CODE (2026-07-17)
`infra/cdk/lib/config.ts` dev override block now matches live reality:
- `appHost: 'app.capiro.ai'` ✅ (fixed earlier)
- `wildcardHost: '*.app.capiro.ai'` ✅
- `rootDomain: 'capiro.ai'` ✅
- `auroraMaxAcu: 4` ✅ (2026-07-17: was 2 → 4; live verified MaxACU 4)
- `auroraBackupRetentionDays: 35` ✅ (2026-07-17: was 7 → 35; live verified 35-day)
- `auroraMinAcu: 0.5` ✅ (already correct; live 0.5)

⚠️ Still confirm at window time: deploy targets account **`967807252336`** (pass
`--context account=967807252336`), and run `cdk diff` to confirm these are now no-ops
before deploying. This change is committed but **NOT deployed** — it only takes effect
in Step D.

### Step B — Reconcile the ALB (the hard part)
The stack wants to own an ALB (`Capiro-Alb16-…`) that no longer exists; the live ALB
`capiro-prod-alb` was made out-of-band. Two viable paths:
1. **CDK lookup (preferred if the ALB should stay out-of-band):** change the CDK to
   reference the existing ALB via `ApplicationLoadBalancer.fromLookup()` / by ARN and
   attach listener rules to it, instead of `new ApplicationLoadBalancer(...)`. Then the
   stack stops trying to manage a phantom LB.
2. **CFN resource import:** import `capiro-prod-alb` + its listeners/rules into the
   stack so CFN's model matches reality.
Either way, `cdk diff` must come back **clean (no replacement)** on the ALB, listeners,
rules, AppAlias, and AppWildcardAlias before deploying.

### Step D — Verify, then one careful deploy
```bash
cd infra/cdk
npx cdk diff Capiro-dev-Compute -c env=dev -c account=967807252336
# iterate on B/C until diff shows NO requires-replacement and NO Aurora/cert/DNS changes
npx cdk deploy Capiro-dev-Compute -c env=dev -c account=967807252336
```
Post-deploy: confirm app.capiro.ai 200s, ECS tasks HEALTHY, Aurora unchanged
(35-day / 4 ACU), cert unchanged.

---

## Until the window: keep shipping out-of-band
Pattern (validated for SAM.gov key, 2026-06-01):
1. `aws ecs describe-task-definition --task-definition capiro-dev-api-migrate` → JSON.
2. Strip read-only fields; edit (add env/secret/etc.).
3. `aws ecs register-task-definition --cli-input-json file://...` → new revision.
4. Run by pinned revision (`capiro-dev-api-migrate:N`), container name is **`api`**.
Out-of-band secrets must be named `capiro/dev/<name>` (NO leading slash) to fall under
the exec role's `capiro/dev/*` grant; slash-path names are not covered and fail startup.

---

## Codified 2026-07-26 — Google Workspace OAuth
`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` were live out-of-band on
`capiro-dev-api:59` and `capiro-dev-onboard-api:4` with **zero** CDK
representation. Now codified in `config.ts` (`externalSecretArns.googleClientId`
/ `.googleClientSecret`) and `compute-stack.ts` (import, `apiServeSecrets`,
exec-role + task-role ARN patterns, plus a host-derived `GOOGLE_REDIRECT_URI`).
Secret names are **UPPER_SNAKE** (`capiro/dev/GOOGLE_CLIENT_ID`), unlike every
`microsoft-*` secret. Source-only: NOT deployed, per the freeze above.

## STILL UNCODIFIED — `onboard-api` has no CDK construct at all
`grep -rln onboard infra/cdk/lib infra/cdk/bin` returns nothing. The ECS service
`capiro-dev-onboard-api` (task def rev 4) is 100% out-of-band. Its live config,
captured 2026-07-26, so a future codification does not drop it:
- **Secrets:** CLERK_SECRET_KEY, INTERNAL_SERVICE_SECRET, OAUTH_STATE_SECRET,
  MICROSOFT_CLIENT_ID, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, DB_HOST,
  DB_PORT, DB_USER, DB_PASSWORD, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
- **Env:** ONBOARD_BIND_HOST, ONBOARD_API_PUBLIC_BASE_URL=https://app.capiro.ai,
  ONBOARD_PUBLIC_BASE_URL=https://onboarding.capiro.ai, ONBOARD_EMAIL_ENABLED,
  ONBOARD_EMAIL_FROM, ONBOARD_CS_NOTIFY_EMAIL, ONBOARD_WIRE_DUE_DAYS,
  CLERK_JWT_ISSUER, DB_NAME, STRIPE_PRICE_SLOTS, STRIPE_OVERAGE_METER_EVENT
`ONBOARD_API_PUBLIC_BASE_URL` is what builds the Google IT-admin redirect
`${base}/onboard-api/it/google/callback` (`it-admin.service.ts:195,435`) — that
exact URI must stay registered in the Google Cloud Console OAuth client.

## Codified 2026-10-05 — MeriV3 runtime env (program plan Stage 1 §4.2)

MeriV3 is the only chat runtime from PR #2003 onward. Its gate is two keys, both
default ON in code: env `MERIV3_ENABLED` (global kill switch) and the tenant flag
`meriv3.fullChat`. Before this change both services carried `MERIV3_ENABLED=true`
only on their out-of-band task definitions. With the new gate an omitted key still
means ON, but the value is now codified so the intent is explicit and an operator
`false` cannot be lost by a redeploy.

| Service | Keys codified (live values, verified 2026-10-05) |
| --- | --- |
| api (`capiro-dev-api:553`) | `MERIV3_ENABLED=true`, `MERIV2_ACTION_PROPOSALS_ENABLED=true`, `MERIV2_CONTROL_METRICS=on`, `MERIV2_CONTEXT_PACKET_V2=enforce` |
| meriv2-orchestrator (`:139`) | `MERIV3_ENABLED=true`, `MERIV3_MODEL`/`MERIV3_FAST_MODEL`/`MERIV3_DEEP_MODEL`/`MERIV3_MAX_MODEL=gpt-6-astra`, `MERIV3_{FAST,STANDARD,DEEP,MAX}_REASONING_EFFORT=low/medium/high/max`, `OPENAI_MODEL=gpt-6-astra`, `MERIV2_WORKSPACE_BASE_URL`, `MERIV2_TIMEOUT_MS=170000`, `MERIV2_CONTEXT_PACKET_V2=enforce` |

Deliberately NOT codified: `MERIV3_CANARY_TENANT_SLUGS` (no longer read; it can be
removed from both task definitions in the next configuration revision).

Must stay when the MeriV2 chat path is deleted (§4.3): `MERIV2_ORCHESTRATOR_URL`
(the V3 chat client's orchestrator base URL), `MERIV2_ENABLED` (the narrow
in-editor and workspace-gen assistants), `MERIV2_PORT`, `MERIV2_API_BASE_URL`,
`MERIV2_LOG_LEVEL`, `MERIV2_TIMEOUT_MS`, `MERIV2_WORKSPACE_BASE_URL`.

No `cdk deploy` was run; the Compute stack remains frozen.

## WAF — live `capiro-dev-waf` vs the CDK `WebAcl` (recorded 2026-10-05)

The web ACL serving the live ALB is `capiro-dev-waf` (`95dc2979-45e1-4c94-9ea8-650dfb21c516`),
created out-of-band. The CDK `WebAcl` construct is CloudFormation-managed and differs:

| Rule | Live `capiro-dev-waf` | CDK `WebAcl` |
| --- | --- | --- |
| `allow-msgraph-webhook-validation` (0) | yes | codified 2026-10-05 |
| Common rule set exclusions | `SizeRestrictions_QUERYSTRING`, `_URIPATH`, `_BODY` | codified 2026-10-05 |
| `CrossSiteScripting_BODY` scoped to everything except `POST /api/clio/attachments` | applied 2026-10-05 with Neo's OK (program plan D10, §4.5); PPTX and XLSX uploads verified 201/parsed | codified 2026-10-05 |
| Known bad inputs (2) | yes | yes |
| SQLi rule set (3) | yes | no |
| IP reputation list | no | yes (3) |
| Per-IP rate limit 2,000 | no | yes (10) |

A future reconciliation must decide the SQLi, IP-reputation and rate-limit rules
deliberately; a `cdk deploy` would otherwise attach a differently configured ACL.

## Meri alarms (created live 2026-10-05, codified the same day)

Metric filters on `/capiro/dev/api`: `capiro-meri-unavailable` (`"meri_unavailable"`) and
`capiro-meri-orchestrator-failure` (`"meri_orchestrator_failure"`), namespace `Capiro/Meri`.
Alarms `Capiro-Meri-Unavailable` (Sum >= 1 in 5 minutes) and `Capiro-Meri-Orchestrator-Failure`
(Sum >= 3 in 5 minutes) notify `capiro-dev-platform-alarms`. The T15 kill-switch drill on
2026-10-05 moved `Capiro-Meri-Unavailable` from OK to ALARM on its single refused turn, as intended.

## Hermes pilot residue removed (2026-10-05, Neo's OK; program plan §4.8)

Read-only reference check first: no ECS service, running task, EventBridge rule, Scheduler schedule
or other security-group rule referenced any of these; the IAM roles were last used 2026-09-20 and the
log group's last event was 2026-09-20.

| Resource | Action |
| --- | --- |
| `capiro-hermesval-worker:1..5`, `capiro-hermesval-worker-v4a:1`, `capiro-hermesval-worker-v5:1` | deregistered (INACTIVE) |
| EFS `fs-0a641cad57e8bff4e` (worker home at `/opt/data`, 72 MB), its access point and 3 mount targets | deleted |
| Security groups `sg-0c488a0562b1d271a`, `sg-036302af841a987f6` | deleted |
| IAM roles `capiro-hermesval-worker-exec`, `capiro-hermesval-worker-task` (policies detached/deleted first) | deleted |
| ECR repository `capiro/dev/meri-hermes-worker` (4 images) | deleted |
| Secret `hermes/jumpbox/openrouter-api-key` | kept (Neo's choice) |
| Log group `/capiro/dev/meri-hermes-worker` | kept; expires under its 30-day retention |

No database change. Approvals and journal history are untouched.

## Deep Research per-run budget (2026-10-06 UTC, Neo's OK; Stage 2 Release A)

Configuration revision (deployment plan §2.5), env only, same image digest:
`capiro-dev-api:563` → `capiro-dev-api:564`.

| Key | Before | After |
| --- | --- | --- |
| `CLIO_RESEARCH_MAX_TOTAL_TOKENS` | unset (code default 120000) | `4000000` |
| `CLIO_RESEARCH_MAX_COST_USD` | unset (code default 6) | `25` |

Why: research reservations count the request body in bytes as tokens, so one
V3 research call reserved about 240,000 units and every run was refused at its
first model call (`Research provider budget rejected reservations (HTTP 409)`).
Settled spend uses actual usage; the cap stops runaway runs only. Codified in
`compute-stack.ts` (API environment) in the same PR as this entry.


## LegiScan key on the API serve task (2026-10-06 UTC, Neo's OK; Meri live state-bill lookup)

Configuration revision (deployment plan §2.5), secret only, same image digest
(`sha256:8ba4408b…`, `d53a5919e`): `capiro-dev-api:602` → `capiro-dev-api:603`.

| Secret | Before | After |
| --- | --- | --- |
| `LEGISCAN_API_KEY` | unset | `capiro/dev/legiscan_api_key` |

Why: #2098 lets `get_state_bill_status` and the other state tools look up an
exact designation in LegiScan when the hourly sync has not stored it yet,
within a 1,000-query monthly live budget inside the shared 28,000 soft budget.
No IAM change: the execution role already reads `capiro/dev/*` through
`CapiroDevRuntimeSecretsRead`. Codified in `compute-stack.ts` (serve secrets
and the execution-role secret patterns) in the same PR as this entry.
