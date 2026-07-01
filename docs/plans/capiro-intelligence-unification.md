# Capiro Intelligence — Unification & Bill-Tracker Migration Plan

**Goal:** collapse the two modules (Bill Tracker in `apps/api`, Hearing Watch in `apps/intel-api`) into **one shared intelligence engine on `apps/intel-api`**, surfaced in the **client-profile Tracker tab** as a single client-specific policy-intelligence feed (Bills + Hearings + Combined alerts + one unified watchlist).

**Strategy:** strangler / parallel-run — rebuild Bill Watch inside `intel-api`, run in **shadow** against the live legacy tracker, prove parity, **cut over per-tenant** with a single-sender guarantee, then decommission the `apps/api` tracker.

**Status:** PROPOSED (deployment-hardened pass). Every section carries deployment logic + measurable success criteria.

## Contents
- 0. Executive summary & how to use this plan
- 1. Guiding principles & decisions
- 2. Target architecture & deployment topology
- 3. Unified data model & migrations
- 4. Phase 1 — intel-api foundations
- 5. Phase 2 — Unified watchlist + legacy sync
- 6. Phase 3 — Bill match engine + change detection (shadow)
- 7. Phase 4 — Unified alerts, scoring & delivery (shadow)
- 8. Phase 5 — Parity validation
- 9. Phase 6 — Combined feed + bill-hearing linking
- 10. Phase 7 — Frontend: Tracker tab unification
- 11. Phase 8 (cutover) & Phase 9 (decommission)
- 12. Cutover & rollback runbook
- 13. Parallel feature workstreams (F1–F7)
- 14. Environments, sequencing & dependencies
- 15. Observability, SLOs & rollback triggers
- 16. Risks & mitigations
- 17. Global success criteria & sign-off checklist
- 18. Open questions & decisions log
- Appendix A — Deployment Facts & Naming Registry

---

## 0. Executive summary & how to use this plan

**What this migration achieves.** It collapses two separate intelligence modules — the **Bill Tracker** (today in `apps/api`) and **Hearing Watch** (today in `apps/intel-api`) — into **one shared intelligence engine hosted on `apps/intel-api`** (the `capiro-dev-intel-api` Fargate serve service, container port `4300`, sharing the same Aurora `capiro` DB as `apps/api`). The unified engine is surfaced in the **client-profile Tracker tab** as a single client-scoped policy-intelligence feed (Bills + Hearings + Combined alerts, driven by one unified watchlist). intel-api **reads** `apps/api`-owned GLOBAL tables (`congress_bill`, `context_embeddings`, etc.) by string ID via raw SQL and **never writes them** (decision D2, §0.1). Tenant-scoped reads (`clients`, tenant-aware `context_embeddings` rows) go through the RLS-aware Prisma path (§0.3, item RLS).

**The strangler strategy in 4 lines.**
1. **Rebuild** the Bill-Watch domain inside intel-api (own `intel_*` tables; read `congress_bill`/`context_embeddings` cross-table).
2. **Shadow** the rebuilt engine against the live legacy tracker — it computes alert rows and logs *would-send* deliveries but **sends nothing** (Phases 3–4).
3. **Prove parity** (≥95% alert-set overlap, zero missed legacy-criticals, N=7 green days — Phase 5), then **cut over per-tenant** by flipping an ownership flag (Phase 8).
4. **Decommission** the `apps/api` tracker only after all tenants are flipped plus a 2-week burn-in (Phase 9).

**The single most important safety property — single-sender / zero double-send.** During the parallel run, **exactly one service delivers alerts per tenant**. This is enforced by three independent layers so no client ever receives a duplicate email:
- **Ownership flag** `tracker_owner_intel` (per tenant, in `intel_feature_flag`): absent/disabled → legacy `apps/api` sends and intel stays in shadow; enabled → intel sends and legacy skips. Resolved via `FeatureFlagService.isEnabled('tracker_owner_intel', tenantId)`; **ALWAYS-on for `CAPIRO_INTERNAL_TENANT_ID`** — so the internal/demo tenant is intel-owned the moment the flag exists (see §0.3 and Phase 8; do not treat the internal tenant as legacy-owned).
- **Legacy skip guard** at the top of the `apps/api/scripts/detect-tracker-alerts.ts` tenant loop: `if (await isIntelOwned(tenantId)) continue;` (the *single* minimal, reversible change to legacy — see §4). `isIntelOwned` must read the SAME `intel_feature_flag` source intel reads, and must apply the same internal-tenant always-on rule, or the two services will disagree on ownership.
- **Idempotency log** — `alertId = 'tracker:' + clientId + ':' + billId + ':' + changeType`, claimed via INSERT … ON CONFLICT on the unique key `(alertId, userId, channel)` (P2002 → skip). Legacy claims in `notification_log`; intel claims in `intel_notification_log`. **Caveat (do not overstate):** these are two SEPARATE tables in the SAME database, so the unique constraint does NOT by itself prevent a cross-service double-send — it only dedupes *within* each service. Cross-service single-send is guaranteed by the ownership flag + legacy skip guard; the idempotency logs are the *within-service* backstop and the audit source for the SC-0.3 cross-join check below.

> **Everything else in this plan exists to protect this property.** No phase that touches delivery ships until its shadow/parity gate proves zero double-send.

### 0.1 How to read the phase / success-criteria structure

Each delivery unit is a **Phase** (§3, numbered 1–9) with a **Build checklist** and an **Acceptance** line, plus parallel **feature workstreams** F1–F7 (§5). This deployment-ready plan tightens that structure so it is independently verifiable:

- **Every phase has an explicit GATE.** A gate is the measurable condition that must be met before the *next* phase (or a cutover) may proceed. Gates are stated as a bold **Success criteria** subsection: *who verifies, what command/metric, what threshold, what it unblocks.*
- **No phase ships without its success criteria met.** "Ships" means merged to `main` + image built **arm64** + migrate task run + deployed to the `capiro-dev-intel-api` serve service. Shadow phases (3–5) are *deployed but deliver nothing* until Phase 8.
- **Read a phase top-to-bottom:** Build → Acceptance → Success criteria (gate) → what it unblocks. Skip to §4 for the cutover/rollback runbook; §7 for risks; §8 for definition-of-done.

**Status legend** (used throughout):

| Marker | Meaning |
|---|---|
| **PROPOSED** | Designed, not started. (Whole plan is PROPOSED as of 2026-06-30.) |
| **SHADOW** | Deployed to intel-api but delivery is suppressed by the ownership flag; computes + logs only. Intended sends are recorded with status `suppressed_shadow` (single token, no parentheses). |
| **LIVE (per-tenant)** | Ownership flag `tracker_owner_intel` enabled for that tenant; intel is the sole sender. |
| **DORMANT** | Code present, disabled by env/flag (e.g. SMS: `TRACKER_SMS_PROVIDER=none`). |
| **UNVERIFIED — must confirm** | Registry could not confirm; treat as a blocking pre-flight item (list in §0.3). Do **not** invent a value. |

**Gate / verb conventions:**
- **One-off tasks** run via the intel-api **migrate** task-def family (which carries the verb dispatch entrypoint), using the exact container-override name `intel-api-migrate`:
  ```
  aws ecs run-task --cluster capiro-dev --launch-type FARGATE \
    --task-definition capiro-dev-intel-api-migrate \
    --network-configuration 'awsvpcConfiguration={subnets=[...],securityGroups=[...],assignPublicIp=DISABLED}' \
    --overrides 'containerOverrides=[{name=intel-api-migrate,command=["<verb>","..."]}]'
  ```
  (subnets/SGs are **UNVERIFIED — must confirm** from `scripts/deploy-ingestion-out-of-band.sh` `run_job_wait` template / resolved task-defs — §0.3.) New tracker jobs (`detect-bill-changes`, `flush-digests`, `parity-report`, `sync-watchlists-from-legacy`) become **entrypoint verbs** — intel-api is HTTP-only today (single `bootstrap()`), so `entrypoint.sh`/CommandFactory must gain verb dispatch (registry §6). **The migrate task-def gets ONLY `DB_*` secrets + `DB_NAME` env** (registry §2); any verb that needs Bedrock/SES/Deepgram/tenant-key secrets (e.g. `detect-bill-changes` summaries, `flush-digests` SES) will NOT have them under `capiro-dev-intel-api-migrate` and must either (a) run under a purpose-built task-def with the right secret set, or (b) have those secrets added to the migrate family. **UNVERIFIED — must confirm which task-def each non-migrate verb runs under and that it carries the needed secrets.** Do not assume the migrate task-def can send email or call Bedrock.
- **Per-tenant enable** uses the existing pattern: `enable-feature <flag> <tenantSlugOrId>` (flags are ALWAYS-on for `CAPIRO_INTERNAL_TENANT_ID`; guards return **404** — not 403 — when disabled).
- **Deploy order (both services)** is migrate-task-first, then `update-service … --force-new-deployment`, per `scripts/deploy-dev.sh`: (1) preflight (account `967807252336` / SHA / `/health`) → (2) optional build+push arm64 (`--build`) → (3) run MIGRATE task, wait STOPPED + **exit code 0** → (4) roll serve `capiro-dev-intel-api --force-new-deployment`, wait stable → (5) roll web (`capiro-dev-web`), order-independent. Prod Fargate is **ARM64**; images MUST be built for `linux/arm64` or the service can't pull them:
  ```
  docker buildx build --platform linux/arm64 \
    -f apps/intel-api/Dockerfile \
    -t 967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/intel-api:latest \
    -t 967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/intel-api:<GIT_SHA> \
    --push <REPO_ROOT>
  ```
  CI equivalent: `.github/workflows/intel-api-image.yml` (`docker/build-push-action@v6`, `platforms: linux/arm64`; triggers on `apps/intel-api/**`, `packages/meriv2-core/**`, `packages/shared/**`, `pnpm-lock.yaml`; OIDC assumes `AWS_DEV_GHA_ROLE_ARN`/`AWS_PROD_GHA_ROLE_ARN`). The dev CodeBuild project `capiro-build-intel-api` builds+pushes+**forces redeploy**; the prod project `capiro-build-intel-api-prod` builds+pushes **only** (no redeploy) — a prod serve roll is a separate explicit `update-service`.
- **`prisma migrate deploy` is the ONLY schema mechanism.** The intel-api `migrate` mode runs `prisma migrate deploy` (with auto-rollback of previously-failed migrations) then exits; it does **NOT** run a seed step (unlike `apps/api` migrate, which additionally runs `seed-workflows.ts`). Any tracker seed/backfill (e.g. `sync-watchlists-from-legacy`) is a separate verb, not part of `migrate`. Never `prisma migrate dev` against a shared cluster.

### 0.2 Definition of terms

| Term | Definition |
|---|---|
| **Shadow** | intel-api runs the full detect→score→deliver pipeline but delivery is gated OFF by `tracker_owner_intel`; it writes alert rows and records intended sends into `intel_notification_log` with the suppressed-shadow status `suppressed_shadow` (single token, no parentheses). Legacy `apps/api` remains the live sender. |
| **Cutover** | The per-tenant flip (Phase 8) that transfers *both* sender ownership and watchlist source-of-truth from legacy to intel, in a fixed order (final one-way sync → catch-up detect → enable `tracker_owner_intel` → enable `tracker_v2` UI → disable reverse sync → 48h watch). |
| **Ownership flag** | `tracker_owner_intel` in `intel_feature_flag`, per tenant. The single authority for *who sends*. Enabling it makes intel the sole sender and legacy skip that tenant (D5). Distinct from `tracker_v2`, which only gates the *UI surface*. Both are new flags to add (registry §3). |
| **Source-of-truth (watchlist)** | Which service owns authoritative watchlist edits. During shadow it is **legacy** (`client_watchlist`/`alert_preference`), synced one-way → intel via the `sync-watchlists-from-legacy` verb (idempotent, D6). It moves to **intel** at cutover step 4, after which the reverse-overwrite sync is disabled. Target intel table shape (`intel_watchlist_term` reuse vs new `intel_topic`/`intel_term`) is **UNVERIFIED — see §0.3 and registry §5; do not conflate.** |

### 0.3 UNVERIFIED items that gate deployment (pre-flight — must confirm before Phase 1 ships)

These come straight from the registry and are **blocking**; confirm and record the real value rather than inventing one. Each has an owner and an acceptance check (see SC-0.4).

- **Prod intel-api service name** — prod cluster is `capiro-prod-os-capiro`; prod serve service name is **UNVERIFIED** (likely `capiro-prod-intel-api` or `capiro-prod-os-capiro-intel-api`, managed out-of-band, NOT in CDK). Prod serve task-def family = `capiro-prod-intel-api`, migrate family = `capiro-prod-intel-api-migrate`, ECR repo = `capiro/prod-os-capiro/intel-api`, log group = `/capiro/prod-os-capiro`, secrets namespace `capiro/prod-os-capiro/*`. Confirm the service name via `aws ecs list-services --cluster capiro-prod-os-capiro` before any prod deploy.
- **run-task network config** — subnets + security groups for `run-task` are **UNVERIFIED**; pull from `scripts/deploy-ingestion-out-of-band.sh` / resolved task-defs (`assignPublicIp=DISABLED`).
- **Task-role Bedrock perms** — the shared api task role (`Capiro-dev-Compute-ApiTaskRole12FAD4A7-szq3QeeZJSCQ` dev / `Capiro-prod-os-capiro-Compute-ApiTaskRole12FAD4A7-5zhubZnOJ9nz` prod) must have `bedrock:InvokeModel` for Titan embed (`amazon.titan-embed-text-v2:0`, 1024-dim) **and** Anthropic Claude-on-Bedrock (summaries). intel-api SHARES the api task role. **UNVERIFIED — confirm both model grants; embeddings/recommendations silently degrade without Titan.**
- **Task-role SES perms** — `ses:SendEmail`/`SendEmailV2` for the `TRACKER_ALERT_EMAIL_FROM` identity (SESv2 client). **UNVERIFIED — confirm perms AND that `TRACKER_ALERT_EMAIL_FROM` is a verified SES identity in `us-east-1`; an unverified from-address fails every alert send.**
- **RLS role compatibility** — whether intel-api's Prisma DB role has `withTenant`/`withSystem` equivalents and can read NULL-tenant `context_embeddings` rows. RLS on `context_embeddings` = `tenant_id IS NULL OR tenant_id = current_setting('app.current_tenant')`; on `clients` it is tenant-scoped. RLS is the PRIMARY isolation — a wrong/mismatched role **silently returns zero cross-tenant rows** (no error), which would make shadow parity look falsely low. intel-api tracker reads MUST `SET app.current_tenant` per query (scoped) and use a system/exempt path for cross-tenant detection (the bypass GUC is `app.bypass_rls='on'`). If intel-api connects under a DIFFERENT role than api, confirm it is either the same role, granted access, or RLS-exempt. **UNVERIFIED — must confirm connecting role, `withTenant`/`withSystem` availability, and NULL-tenant read access.** (GUC names `app.current_tenant` and `app.bypass_rls='on'` are source-verified against s6 §6.0 and s3.)
- **Connection-pool impact** — intel-api adds a SECOND Prisma client pool against the SHARED Aurora `capiro` cluster (serve pods + one-off verb tasks). **UNVERIFIED — confirm Aurora `max_connections` headroom and set intel-api's `connection_limit` so serve + concurrent migrate/detect/flush tasks cannot exhaust the pool that `apps/api` also draws from.** Size before Phase 3 shadow (which runs detection on a schedule).
- **Watchlist table shape** — whether the tracker port reuses the existing `intel_watchlist_term` or introduces new `intel_topic`/`intel_term`. **UNVERIFIED — do not conflate** (registry §5). Blocks the migration DDL.
- **`ai_usage_events` table + `AiCredentialResolverService`** presence in intel-api (tenant-scoped Anthropic summary keys, `usedTenantKey` metering). **UNVERIFIED — confirm or port.** If absent, summaries must fail-safe to null (alert still sends) rather than crash.
- **`IntelligenceChange` table** existence in the intel-api schema (emit target for `emitIntelligenceChange`). **UNVERIFIED — confirm or re-target.**
- **New ALB rule for `/intel-api/*`** — no rule exists today; intel-api is internal-only on `:4300`, and the web axios client resolves `/intel-api/*` against `apiBaseUrl` (which hits the ALB). For the browser to reach intel-api tracker endpoints, a listener rule under host `app.capiro.ai` must be ADDED via `aws elbv2 create-rule` at a free priority (suggested **12 or 17** — **UNVERIFIED, must confirm no collision** with existing rules 3/5/10/15/20). PROD `capiro-prod-alb` is manually managed/wedged — **never** `cdk deploy` (it would drop the out-of-band rule). Confirm target group points at the intel-api `:4300` target. **This is required before `tracker_v2` UI can render for any tenant** (fail-closed `useIntelFeatureEnabled` will otherwise never see the surface work).

**Success criteria (this plan is being followed correctly — at-a-glance):**

| # | Check | Verifier | Command / metric | Threshold / expected | Gate it unblocks |
|---|---|---|---|---|---|
| SC-0.1 | **Every phase has a gate.** | Plan author | Grep §3 for a bold `**Success criteria**` block under each Phase 1–9 | 9/9 phases carry a measurable, verifier-named gate | Plan approval |
| SC-0.2 | **No phase ships without its gate met.** | Release/SRE | For each merged phase, its Success-criteria evidence (task log / parity report) is attached to the PR | 100% of shipped phases have green evidence linked | Merge to `main` |
| SC-0.3 | **Single-sender invariant holds continuously.** | Release/SRE | Daily cross-join over the two logs in DB `capiro`: `SELECT COUNT(*) FROM intel_notification_log l JOIN notification_log n ON n.alert_id = l.alert_id AND n.user_id = l.user_id AND n.channel = l.channel WHERE l.status='sent' AND n.status='sent';` (same alert delivered by BOTH services) | **= 0** on every day of the parallel run | Phase 8 cutover / continued parallel run |
| SC-0.4 | **All §0.3 UNVERIFIED resolved before Phase 1 ships.** | Staff eng + SRE | Each §0.3 row has a confirmed real value recorded in the registry (name/ARN/SQL result/`aws` output), no invented values; owner + date noted | 0 items remain `UNVERIFIED` | Phase 1 deploy |
| SC-0.5 | **Ownership flag is the sole delivery authority.** | Release/SRE | Enable `tracker_owner_intel` for pilot tenant, then confirm the legacy loop skips it (`isIntelOwned` guard hit in `detect-tracker-alerts.ts` CloudWatch logs) AND legacy sends 0 for that tenant while intel sends ≥1 | Legacy sends = 0 AND intel sends ≥ 1 for the owned tenant | Phase 8 per-tenant flip |
| SC-0.6 | **Rollback is real & non-destructive.** | Release/SRE | On pilot: disable `tracker_v2` + `tracker_owner_intel`; confirm legacy resumes sending & serving with intact `client_watchlist`/`tracked_bill` (intel never wrote them) and SC-0.3 stays 0 across the seam | Legacy resumes, 0 lost legacy rows, 0 duplicate sends on the seam | Cutover approval (proves reversibility) |
| SC-0.7 | **Cross-service ownership agreement (no gap/overlap).** | Release/SRE | For every tenant, exactly one of {legacy loop, intel loop} treats it as owned. Cross-check: for each tenant, `isIntelOwned` (legacy view) == `FeatureFlagService.isEnabled('tracker_owner_intel', tenant)` (intel view), including internal-tenant always-on | 100% agreement; 0 tenants owned-by-neither or owned-by-both | Every parallel-run day; Phase 8 |
| SC-0.8 | **arm64 image + migrate-before-serve enforced.** | Release/SRE | For each intel-api deploy: pushed image manifest is `linux/arm64` (`docker manifest inspect` / ECR) AND the migrate task reached STOPPED with exit code 0 BEFORE the serve `--force-new-deployment` | arm64 confirmed AND migrate exit 0 precedes serve roll | Any intel-api ship (§0.1 deploy order) |

*Meaning of "green": the plan is being followed correctly when SC-0.1 through SC-0.8 all hold — every phase carries a measurable gate, nothing shipped skipped its gate, ownership is unambiguous per tenant (SC-0.5/SC-0.7), the double-send count (SC-0.3) has never been non-zero, and every image is arm64 with migrate-before-serve (SC-0.8).*

---

## 1. Guiding principles & decisions

The migration is governed by the decisions below (D1–D7 preserved from the prior draft; D8–D13 added to close deployment/infra gaps the registry implies). Each decision carries: **(a) engineering consequence**, **(b) enforcement point** (guard / flag / migration constraint / infra), and **(c) verifiable check**. Names, commands, tables, env vars, and paths are used verbatim from the Deployment Facts & Naming Registry; where the registry marks a fact UNVERIFIED, it is surfaced here as **UNVERIFIED — confirm** and is a blocking prerequisite, never an assumption.

> **Strangler / shadow / single-sender model (stated once, referenced below):** legacy `apps/api` tracker stays the sole owner and sole *sender* for every tenant until that tenant is explicitly flipped. intel-api runs in **shadow** (computes + logs, delivers nothing) until flipped. At all times **exactly one** service delivers alerts per tenant, enforced by the ownership flag `tracker_owner_intel`. There is no "both send and dedupe" path — dedupe is a *safety net*, not the isolation mechanism.

### 1.1 Decision table (expanded)

| # | Decision | (a) Engineering consequence | (b) Enforced by | (c) Verifiable check |
|---|----------|-----------------------------|-----------------|----------------------|
| **D1** | **Migrate the Bill *Watch* domain only** (watchlist, tracked-bill curation, matching, change-detection, alerts, board). **Leave ingestion** (`sync-congress`, `sync-openstates`, embeddings *writer*) in `apps/api`. | intel-api gets zero ingestion code and no embeddings *writer*; it only ports the query-side `embedText`/`vectorLiteral` from `apps/api/src/embeddings/embedder.ts` (`EMBEDDING_MODEL = process.env.EMBEDDINGS_MODEL ?? 'amazon.titan-embed-text-v2:0'`, 1024-dim). `context_embeddings` bill rows stay written by apps/api. | Scope guard: intel-api entrypoint verb list is **exactly** `serve \| migrate \| enable-feature` today (confirmed in `apps/intel-api/scripts/entrypoint.sh`); D10 adds only tracker read/detect/deliver verbs, **no `sync-*` verb**. All cross-DB access is read-only (see D2). | `grep -rn "sync-congress\|sync-openstates" apps/intel-api/src` → 0 hits. Static check: cross-DB repository issues only `SELECT`/`$queryRawUnsafe` reads (`grep -rn "INSERT\|UPDATE\|DELETE" apps/intel-api/src/sourcedata/` → 0 against `congress_bill*`/`context_embeddings`). |
| **D2** | **intel-api reads apps/api-owned tables via raw SQL** (`$queryRawUnsafe`), **never Prisma models, never writes them.** | intel-api's Prisma client does not model `congress_bill`, `context_embeddings`, `clients`, etc. All cross-DB access is raw SQL against the **shared** Aurora DB `capiro`. Tables read (registry §4): `congress_bill`, `congress_bill_action`, `congress_bill_committee`, `congress_bill_subject`, `bill_text`, `state_bill`, `context_embeddings`, `clients`. `tenants` is **not read directly** (tenantId comes from JWT context per registry §4). | Centralize ALL cross-schema SQL in `apps/intel-api/src/sourcedata/` (one audited repository). Contract test asserts expected columns exist against a scratch DB (guards apps/api schema drift). | Contract test `sourcedata.contract.spec` runs a `SELECT` of each named column (e.g. `congress_bill.latestActionText @db.Text`, `latestActionDate @db.Date`, `peCodes String[]`) and fails on any missing column. Runtime: no intel-api query names an apps/api table via a Prisma model call (`grep -rn "prisma.congressBill\|prisma.contextEmbedding\|prisma.client\b" apps/intel-api/src` → 0). |
| **D3** | **One unified watchlist** drives both bill and hearing matching. **UNVERIFIED — confirm (registry §5):** the tracker port's target tables `intel_topic`/`intel_term` are PROPOSED; the existing hearing tables are `intel_watchlist`, `intel_watchlist_term`, `intel_watchlist_match`. **Must resolve before Phase 2 whether tracker reuses `intel_watchlist_term` or introduces new `intel_topic`/`intel_term`; do not conflate.** | Migration must either (i) extend `intel_watchlist_term` to carry topic/term semantics, or (ii) add `intel_topic`/`intel_term` and re-point the hearing matcher. Legacy `ClientWatchlist` maps per registry §5: `issueAreas → intel_watchlist.enabled_issue_areas`; each `tags[]` object → one topic row `{client_id, tenant_id, name, issue_area, position, priority}`; each `synonyms[]`/`relatedEntities[]`/`riskTerms[]` entry → one term row (`term_type ∈ synonym\|entity\|risk`). | Single **additive** Prisma migration in `apps/intel-api/prisma/schema.prisma`; **no second parallel table set**. All new tenant-scoped tables (`intel_topic`/`intel_term` if chosen) MUST ship with RLS policies matching the hearing tables' policy (D8) in the SAME migration — an unpolicied tenant table is a cross-tenant leak. Naming decision recorded in the migration name + this row before Phase 2 starts. | Schema-review sign-off (owner: staff eng) that exactly ONE watchlist-term lineage exists post-migration; `prisma migrate deploy` (via `migrate` task) applies cleanly on a scratch DB; every new tenant-scoped table has an RLS policy (`SELECT relname FROM pg_class WHERE relrowsecurity` includes them); hearing matcher still resolves terms after the rename/extend. |
| **D4** | **Legacy tracker stays fully live until per-tenant cutover.** No behavior change for un-flipped tenants (strangler model). | Both stacks run in parallel; intel-api runs in **shadow** (computes, does not deliver). No change to `apps/api/src/tracker/*` except the single skip guard (D5). Legacy EventBridge rules (`detect-tracker-alerts` 12:00 UTC, flush digests daily/weekly) keep firing. | Ownership flag default-absent ⇒ apps/api owns. intel delivery short-circuits to a shadow write when the tenant is not owned. | For any un-flipped tenant over 24h, `intel_notification_log` rows are 100% `status='suppressed_shadow'` and legacy `notification_log` continues to record sends. (Status enum value fixed to `suppressed_shadow` — single token, no parentheses.) |
| **D5** | **Single-sender guarantee:** exactly one service delivers alerts per tenant, gated by ownership flag `tracker_owner_intel` (registry §3, NEW). Dedupe on `(alertId,userId,channel)` is a **safety net**, not the primary isolation. | Prevents duplicate client emails (the #1 risk). Legacy loop consults the flag and skips owned tenants; intel delivery runs only for owned tenants. Flag mechanics (registry §3): `FeatureFlagService.isEnabled('tracker_owner_intel', tenantId)` against `intel_feature_flag`; ALWAYS-on for `CAPIRO_INTERNAL_TENANT_ID`; guard returns **404 (not 403)** when disabled. | Legacy: single skip guard at the top of `apps/api/scripts/detect-tracker-alerts.ts` tenant loop — `if (await isIntelOwned(tenantId)) continue;` (reads `intel_feature_flag`). Intel: delivery path gated by the same ownership check + `intel_notification_log` unique `(alertId, userId, channel)` idempotency, `alertId = 'tracker:' + clientId + ':' + billId + ':' + changeType` (registry §6). **Ordering hazard:** legacy and intel must read ownership from the SAME `intel_feature_flag` row so a flip cannot leave both active or neither active during the same cron window; flip is a single UPDATE, and the legacy cron reads the flag at the top of each run (not cached across runs). | **Zero-double-send test:** for a cutover pilot tenant, over 48h, count of `(tenantId,clientId,billId,changeType)` tuples with a delivered send in BOTH legacy `notification_log` AND intel `intel_notification_log` = **exactly 0**. Enable per-tenant via one-off task `enable-feature tracker_owner_intel <tenantSlugOrId>` (registry §3). |
| **D6** | **Watchlist source-of-truth moves at cutover, not before.** Shadow phase = one-way sync `apps/api → intel-api`; Configure UI keeps writing apps/api until the tenant is flipped. | Sync verb copies `ClientWatchlist` + `AlertPreference` into the unified model (mapping per registry §5). `AlertPreference → intel_alert_preference` is 1:1, no decomposition (all columns carry: `triggers[]`, materiality, `email*`, `sms*`, `quietHoursStart/End`). Reverse sync must be **disabled** after flip to prevent overwrite. | Sync direction hard-coded one-way in the sync verb; the sync verb takes a per-tenant advisory lock (`pg_advisory_xact_lock` on a hash of `tenantId`) so concurrent/overlapping cron invocations cannot double-write. Configure UI write target chosen by `tracker_v2` flag (registry §8: legacy `/api/intelligence/.../tracker/*` vs new `/intel-api/*`, same `useApi()` client). | Idempotent re-run: running the sync verb twice for a tenant is a no-op (row-count + content hash of `intel_watchlist*`/`intel_alert_preference` unchanged on 2nd run). After flip, the sync verb is not scheduled/invoked for that tenant (verified in EventBridge + one-off invocation log). |
| **D7** | **End-state UI = client-profile Tracker tab** with sub-views **Board \| Hearings \| Feed \| Configure**; retire standalone workspace `HearingWatchPage` (re-scope hearings to client). | `TrackerTab.tsx` Panel type extends `board\|recs\|config` → `board\|hearings\|feed\|configure` (same sessionStorage `PANEL_KEY` try/catch pattern, registry §8). Gate the v2 surface with `useIntelFeatureEnabled('tracker_v2')` (NEW flag, registry §3) at `ClientProfilePage.tsx` (TrackerTab ~line 513, deep-link `?tab=tracker`). HearingWatchPage rescope needs clientId prop + query-key `['intel','hearings', clientId]` + param + `enabled` gate. | Frontend flag hook `useIntelFeatureEnabled` (GET `/intel-api/feature-flags`, React Query 60s staleTime, **fails CLOSED** → `{}` on error, registry §8). Legacy `tracker-api.ts` path retained for un-flipped tenants. UI reachability of `/intel-api/*` depends on D12 (ALB rule) being green first. | Flagged tenant: Tracker tab renders Board/Hearings/Feed/Configure all sourced from `/intel-api/*`. Un-flagged tenant: unchanged legacy `TrackerTab`. Verified via impersonation header `x-capiro-impersonate-tenant` in `useApi()`. |
| **D8** *(new — cross-DB DB role & RLS)* | **intel-api's tracker port MUST honor Postgres RLS** on tenant-scoped tables and set tenant context per query. **UNVERIFIED — confirm (registry §4):** intel-api today has **no** `withTenant`/`withSystem` helpers and **no** `SET app.current_tenant` code. Must confirm intel-api's DB role AND that it can read `context_embeddings` NULL-tenant (global) rows. | Tenant-scoped tables (`clients`, `context_embeddings`, and any new tenant-scoped `intel_*`) enforce RLS as PRIMARY isolation. `context_embeddings` RLS = `tenant_id IS NULL OR tenant_id = current_tenant` (registry §4) — bill embeddings are global (NULL tenant), so semantic reads work only if the role can read NULL-tenant rows. If intel-api connects under a **different** DB role than apps/api, it is subject to the same policies and blocked from cross-tenant rows unless (a) same role, (b) granted, or (c) RLS-exempt. Cross-tenant change-detection (scanning all tenants' `intel_tracked_bill`) needs a `withSystem` equivalent that sets `app.bypass_rls='on'`. | Port `prisma.withTenant(tenantId, tx=>…)` (scoped reads/writes) and `prisma.withSystem(tx=>…)` (cross-tenant detect job) into intel-api, mirroring apps/api; both set/reset the RLS session vars per transaction. **Session-var names (source-verified — s6 confirmed against `apps/api/src/prisma/prisma.service.ts`):** scoped context uses `app.current_tenant`; cross-tenant/system context uses `app.bypass_rls='on'`. **Connection-pool hazard:** `SET app.current_tenant` (and `app.bypass_rls`) must be `SET LOCAL` inside a transaction (or reset in a `finally`) so a pooled connection never leaks one tenant's context into the next borrower's query. DB creds come from `DB_*` secrets (Aurora `capiro/dev/aurora/master` + `capiro/dev/aurora/app`; prod `capiro/prod-os-capiro/*`); entrypoint composes `DATABASE_URL` (URL-encoded pw, `sslmode=require`). Adding a second service against the shared Aurora also **adds connection-pool load** — size intel-api's Prisma pool so api + intel-api combined stay under the Aurora `max_connections` budget. | **Role parity:** one-off task `SELECT current_user` from intel-api == the DB user apps/api uses. **RLS read test (one-off task):** with tenant context = tenant A (`SET LOCAL app.current_tenant`), `SELECT count(*) FROM context_embeddings WHERE source_type='bill'` returns global rows (>0), and `SELECT count(*) FROM clients WHERE tenant_id=<tenantB>` returns 0. Own-tenant `intel_*` reads succeed only under matching `withTenant`; cross-tenant detect succeeds only under `withSystem` (`app.bypass_rls='on'`). **Pool-leak test:** interleave two queries under different tenants on one pooled connection; second query never sees first tenant's rows. |
| **D9** *(new — arm64 & shared image)* | **All intel-api images are ARM64; intel-api SHARES the api task role.** | Prod Fargate is ARM64; local Windows Docker defaults to AMD64 → an accidental amd64 `:latest` won't pull (`exec format error`). intel-api shares the api task role ARN (registry §1), so any new IAM grant (Bedrock/SES — see D11) on that shared role **also grants apps/api** — scope the policy to exactly the models/identities needed. | Build via `docker buildx build --platform linux/arm64 -f apps/intel-api/Dockerfile -t …/capiro/dev/intel-api:latest -t …:<GIT_SHA> --push <REPO_ROOT>` (registry §1, exact command). CI: `.github/workflows/intel-api-image.yml`, `platforms: linux/arm64`, triggers on `apps/intel-api/**`, `packages/meriv2-core/**`, `packages/shared/**`, `pnpm-lock.yaml`; OIDC assumes `AWS_DEV_GHA_ROLE_ARN`/`AWS_PROD_GHA_ROLE_ARN`. CodeBuild: `capiro-build-intel-api` (dev, ARM_CONTAINER, builds+pushes+forces redeploy) / `capiro-build-intel-api-prod` (builds+pushes only, no redeploy). Execution-role inline policy (ECR pull + Secrets read) at `infra/deploy/intel-api-execrole-inline-policy.json` must include any NEW secret ARNs added in D11 or the serve task fails to start. | `docker manifest inspect <ecr>/capiro/dev/intel-api:latest` → `architecture: arm64`. Post-deploy: `capiro-dev-intel-api` service reaches steady state (no `CannotPullContainer`/`exec format error` in log group `/capiro/dev/intel-api`). Execution role can read every secret ARN referenced by the task def (no `ResourceNotFoundException`/`AccessDenied` on task start). |
| **D10** *(new — job-runner deploy order)* | **Migrate-before-serve, and tracker cron jobs become intel-api entrypoint verbs.** | intel-api entrypoint supports only `serve \| migrate \| enable-feature` today (**confirmed** in `apps/intel-api/scripts/entrypoint.sh`, which prints `expected: serve \| migrate \| enable-feature`). The three legacy scripts (`detect-tracker-alerts.ts`, `emit-bill-alerts.ts`, `flush-tracker-digests.ts`) must become verbs (`detect-bill-changes`, `emit-bill-alerts`, `flush-digests`) — HTTP-only `bootstrap()` refactored to verb dispatch. `migrate` runs `prisma migrate deploy` (forward-only, auto-rollback of previously-failed migrations), then exits — **no seed step** (apps/api migrate additionally runs `seed-workflows.ts`; intel-api does not). | Deploy order mirrors `scripts/deploy-dev.sh`: (1) preflight (account/SHA/health) → (2) optional arm64 build+push (`--build`) → (3) run MIGRATE task `capiro-dev-intel-api-migrate` (container name `intel-api-migrate`), wait STOPPED + exit 0 → (4) `update-service capiro-dev-intel-api --force-new-deployment`, wait stable. **Migrate ALWAYS before service roll.** Cron verbs (`detect-bill-changes`, `flush-digests`) MUST be concurrency-safe: each takes an advisory lock or claims work idempotently (`flushDigests` marks `flushed=true` regardless of send outcome per registry §6; `claim(...)` is INSERT-ON-CONFLICT) so two overlapping EventBridge invocations don't double-deliver. **Prod service name UNVERIFIED — confirm** (registry §1: out-of-band, likely `capiro-prod-intel-api` / `capiro-prod-os-capiro-intel-api`), and prod cluster is `capiro-prod-os-capiro`, migrate family `capiro-prod-intel-api-migrate`. | Deploy log shows migrate task exit code 0 BEFORE the serve service is force-redeployed. New verb runnable: `aws ecs run-task --cluster capiro-dev --launch-type FARGATE --task-definition capiro-dev-intel-api-migrate --overrides 'containerOverrides=[{name=intel-api-migrate,command=["detect-bill-changes"]}]'` → STOPPED exit 0. (`subnets`/`securityGroups`/`assignPublicIp=DISABLED` **UNVERIFIED — confirm** from `scripts/deploy-ingestion-out-of-band.sh` run-task template / resolved task-defs.) |
| **D11** *(new — Bedrock + SES task-role grants + secrets)* | **The shared task role needs Bedrock + SES permissions the registry marks UNVERIFIED; new secrets need exec-role read.** | Tracker recommendations use semantic scoring (`amazon.titan-embed-text-v2:0`, `bedrock:InvokeModel`) and optional summaries (Anthropic Claude on Bedrock). Alerts use SES (`TrackerEmailService`, SESv2 `ses:SendEmail`, registry §6). intel-api has **no** Bedrock code today. Because the role is shared (D9), scope grants tightly (specific model ARNs, specific SES identity). | Add env to the intel-api task def (registry §2): `EMBEDDINGS_MODEL` (default `amazon.titan-embed-text-v2:0`), `AWS_REGION_DEFAULT`, `TRACKER_ALERT_EMAIL_FROM`, `TRACKER_APP_BASE_URL`, and gate envs `TRACKER_ALERTS_ENABLED`, `TRACKER_SCAN_ACTION_HISTORY`, `TRACKER_ALERT_ENRICH`, `TRACKER_ALERT_SUMMARY`. Grant on the shared task role: `bedrock:InvokeModel` (Titan embed + Claude), `ses:SendEmail`. **SES identity gotcha:** `TRACKER_ALERT_EMAIL_FROM` must be a **verified** SES identity in `us-east-1` (or a verified domain), and the account must be out of the SES sandbox for arbitrary recipients — otherwise sends silently fail/bounce. Any secrets referenced (none new required for the base port; summaries use tenant key, below) must be added to the exec-role inline policy (D9). Summaries also need tenant-scoped Anthropic key via `AiCredentialResolverService.resolveProviderByTenantId` — **UNVERIFIED — confirm** whether that service / `ai_usage_events` table exist in intel-api; must port or re-target. | Post-grant one-off task: `embedText("test")` returns a 1024-length vector (no `AccessDenied`). `sendTestAlert` (via `emit-bill-alerts` / `sendTestAlert`) delivers to a seeded verified inbox (SES send success, `intel_notification_log.status='sent'`). SES identity check: `aws sesv2 get-email-identity --email-identity <TRACKER_ALERT_EMAIL_FROM>` → `VerifiedForSendingStatus=true`. With `TRACKER_ALERT_SUMMARY` unset, alerts still send (summary fail-safe → null, registry §6). |
| **D12** *(new — region & ALB exposure)* | **Region is `us-east-1` everywhere; intel-api web calls need a NEW ALB rule (none exists today).** | intel-api runs internal-only on `:4300` (health `/health`, prefix `intel-api`) with **NO `/intel-api/*` ALB rule today** (registry §1). Surfacing the Tracker tab's `/intel-api/*` calls requires ADDING a listener rule under host `app.capiro.ai`. **Priority UNVERIFIED — confirm** (registry suggests 12 or 17; existing rules occupy 3/5/10/15/20, so 12 or 17 are candidate free slots — verify no collision live before creating). PROD ALB `capiro-prod-alb` is manually managed/wedged — rules added via `aws elbv2 create-rule`, **NOT `cdk deploy`** (a `cdk deploy` must not drop this out-of-band rule). | Add rule: path prefix `/intel-api/*`, host `app.capiro.ai`, → intel-api target group (:4300), via `aws elbv2 create-rule` at a confirmed-free priority. Frontend base URL is unchanged (`config.apiBaseUrl`); intel routes resolve relative (registry §8). Document the new rule as out-of-band alongside the priority-15 webhook rule so future CDK work preserves it. | `curl https://app.capiro.ai/intel-api/feature-flags -H 'Authorization: Bearer …'` → 200 (not the web SPA fallback). `aws elbv2 describe-rules` shows exactly one `/intel-api/*` rule at a priority not in {3,5,10,15,20}. New rule recorded in the out-of-band inventory. |
| **D13** *(new — cross-service table existence)* | **Tables the port emits into MUST exist in intel-api's schema or be re-targeted; do not assume apps/api tables are reachable.** | Registry §6 flags `IntelligenceChange` as an **apps/api** table — **UNVERIFIED — confirm** whether it exists in intel-api's schema. `emitIntelligenceChange` cannot write a table intel-api's Prisma client does not own, and cross-service writes violate D2 (read-only across DBs). Same open question for `ai_usage_events` (D11). | Before Phase 3: confirm-or-create. Option (i) add an `intel_intelligence_change` table to intel-api's migration and re-point the emit; option (ii) publish the change event to apps/api via an owned interface (not a raw cross-DB write). Decision recorded here + in the migration. | `emitIntelligenceChange` writes only to an intel-api-owned table (`grep -rn "prisma.intelligenceChange\|INSERT.*intelligence_change" apps/intel-api/src` resolves to an intel-api-owned model/table); dedup key (`source`, `changeType`, `detectedAt≥dedupeSince`, `relatedClientIds`, `data.bill_id`, 14-day window) enforced on that table; migrate task applies it on a scratch DB. |

**Decisions still requiring Ninja sign-off before Phase 1/2:** D1 (watch-only vs move ingestion), D3 (`intel_watchlist_term` reuse vs new `intel_topic`/`intel_term`), D13 (`IntelligenceChange`/`ai_usage_events` create-vs-retarget), and whether **state bills** (`state_bill`) are in cutover v1 (recommendation: federal-first; state read-capable, not cutover-blocking).

### 1.2 Decision success criteria

Each decision has an **owner** and an **objective signal** (command/metric + threshold) that proves it holds. A decision is not "done" until its signal is green in the required environment(s).

| # | Owner | Verification signal (command / metric) | Threshold / expected | Gate it unblocks |
|---|-------|----------------------------------------|----------------------|------------------|
| D1 | Staff eng | `grep -rn "sync-congress\|sync-openstates" apps/intel-api/src`; grep for writes vs `congress_bill*`/`context_embeddings` in `src/sourcedata/` | 0 ingestion verbs; 0 write statements | Phase 1 scope lock |
| D2 | Staff eng | `sourcedata.contract.spec` (column-existence SELECTs) on scratch DB; grep for Prisma-model calls to apps/api tables | test green; 0 model calls | Phase 1 acceptance (read a `congress_bill` row + cosine-rank from `context_embeddings`) |
| D3 | Staff eng | Schema review + `prisma migrate deploy` (migrate task) on scratch DB; RLS-present check on new tenant tables; hearing matcher term-resolution test | migration applies; exactly one term lineage; every new tenant table has RLS; hearing tests pass | Phase 2 (unified watchlist) |
| D4 | SRE | Per un-flipped tenant: `intel_notification_log.status` distribution over 24h | 100% `suppressed_shadow`; legacy `notification_log` still recording | Phase 3–4 shadow run |
| D5 | SRE | 48h double-send query: legacy `notification_log` ∩ intel `intel_notification_log` on `(tenantId,clientId,billId,changeType)` delivered sends | **exactly 0** duplicate tuples | Per-tenant cutover (Phase 8) |
| D6 | Staff eng | Run `sync-watchlists-from-legacy` twice; diff row-count + content hash of `intel_watchlist*`/`intel_alert_preference`; confirm advisory lock held | 2nd run = 0 delta; no overlapping-run double-write | Cutover step "reverse sync disabled" |
| D7 | Frontend eng | Impersonate flagged vs un-flagged tenant (`x-capiro-impersonate-tenant`); inspect Network origin of Tracker data | flagged → `/intel-api/*`; un-flagged → `/api/intelligence/…/tracker/*` | Phase 7 UI acceptance |
| D8 | Staff eng + DBA | One-off `SELECT current_user`; RLS read tests under `SET LOCAL app.current_tenant` (global bill embeddings visible under tenant A; tenant B `clients` = 0) and `withSystem`/`app.bypass_rls='on'` for cross-tenant detect; pooled-connection interleave test; pool-size vs Aurora `max_connections` review | role parity; cross-tenant blocked under `withTenant`, permitted only under `withSystem`; global reads succeed; no context leak; combined pool under budget | Phase 3 (match engine reads `context_embeddings`) |
| D9 | SRE | `docker manifest inspect …/capiro/dev/intel-api:latest`; service steady-state; exec-role can read all task-def secret ARNs | `architecture: arm64`; no `exec format error`/`CannotPullContainer`; no secret `AccessDenied` on start | Every deploy |
| D10 | SRE | Deploy log ordering; `aws ecs run-task … command=["detect-bill-changes"]`; overlapping-invocation idempotency check | migrate exit 0 precedes serve roll; verb task STOPPED exit 0; no double-deliver on concurrent runs | Phase 3 detect job + all deploys |
| D11 | SRE + Staff eng | One-off `embedText` → len-1024 vector; `aws sesv2 get-email-identity` on `TRACKER_ALERT_EMAIL_FROM`; `sendTestAlert` lands + `intel_notification_log.status='sent'` | no `AccessDenied`; SES identity `VerifiedForSendingStatus=true`; test email delivered | Phase 3 (semantic scoring) + Phase 4 (delivery) |
| D12 | SRE | `aws elbv2 describe-rules` for `capiro-prod-alb`; `curl …/intel-api/feature-flags` | one `/intel-api/*` rule at priority ∉ {3,5,10,15,20}; 200 response | Phase 7 UI reachability |
| D13 | Staff eng | `emitIntelligenceChange` write target resolves to an intel-api-owned table; migrate applies the new table on scratch DB | 0 cross-DB writes; dedup key enforced | Phase 3 change-emit |

**Aggregate gate to cutover (Phase 8):** D1, D2, D3, D8, D9, D10, D11, D13 green **in both dev and prod**, plus D5's zero-double-send signal proven in a shadow dry-run, before enabling `tracker_owner_intel` for the first pilot tenant (recommend `CAPIRO_INTERNAL_TENANT_ID` + demo client "Aperture Defense Systems", where flags are ALWAYS-on for internal). D4/D6/D7/D12 gate their own phases but are not cutover-blocking beyond their phase.

---

## 2. Target architecture & deployment topology

> Replaces/expands the prior "## 1. Target architecture" (the plan's original §1 ASCII). Same intent — apps/api owns ingestion + reference data, intel-api becomes the shared intelligence engine reading the shared Aurora DB by ID via raw SQL — now made deployment-ready. This section subsumes the old §1; the schema block that was §2 is unchanged and remains the unified-data-model section.
>
> **Strangler/shadow/single-sender invariants this section must not violate** (referenced throughout): (a) **strangler** — apps/api keeps owning ingestion + reference tables and the legacy `/api/intelligence/.../tracker/*` surface; intel-api only *adds* `intel_*` ownership, never mutates apps/api tables; (b) **shadow** — the change-detection/alert pipeline runs write-to-`intel_alert`-only (`status=new`, no delivery) until a tenant is explicitly promoted; (c) **single-sender** — for any tenant, exactly ONE of {legacy tracker, intel-api tracker} delivers alerts and renders UI, chosen by the `tracker_v2` / `tracker_owner_intel` flags. No dual-send, no dual-render.

### 2.1 Service & cluster topology (verbatim from registry §1)

| Concern | DEV | PROD |
|---|---|---|
| AWS account / region | `967807252336` / `us-east-1` | `967807252336` / `us-east-1` |
| ECS cluster | `capiro-dev` | `capiro-prod-os-capiro` |
| intel-api serve service | `capiro-dev-intel-api` | **UNVERIFIED — confirm** (out-of-band; likely `capiro-prod-intel-api` / `capiro-prod-os-capiro-intel-api`). MUST be resolved before any prod `update-service`. |
| apps/api service | `capiro-dev-api` | **UNVERIFIED — confirm** (prod name not stated by recon) |
| web service | `capiro-dev-web` | **UNVERIFIED — confirm** (prod name not stated) |
| intel-api serve task-def family | `capiro-dev-intel-api` (`command:['serve']`, port 4300, container `intel-api`) | `capiro-prod-intel-api` |
| intel-api migrate task-def family | `capiro-dev-intel-api-migrate` (`command:['migrate']`, container `intel-api-migrate`) | `capiro-prod-intel-api-migrate` |
| intel-api one-off task-def family | `capiro-dev-intel-api-oneoff` (container `intel-api-oneoff`; **EXISTS** — `infra/deploy/intel-api-oneoff-taskdef.json`) | **UNVERIFIED — confirm** prod one-off family name |
| ECR (intel-api) | `…/capiro/dev/intel-api` | `…/capiro/prod-os-capiro/intel-api` |
| Task role (SHARED with api) | `…role/Capiro-dev-Compute-ApiTaskRole12FAD4A7-szq3QeeZJSCQ` | `…role/Capiro-prod-os-capiro-Compute-ApiTaskRole12FAD4A7-5zhubZnOJ9nz` |
| Execution role | `…ApiTaskDefExecutionRoleE6ABB053-YlEDKuUPHjLg` | `…ApiTaskDefExecutionRoleE6-S9U73lqKaGdt` |
| CodeBuild (intel-api) | `capiro-build-intel-api` (ARM_CONTAINER, BUILD_GENERAL1_LARGE, builds+pushes+**force-redeploys**) | `capiro-build-intel-api-prod` (builds+pushes only, **no redeploy** — prod roll is a separate manual `update-service`) |
| Runtime platform | ARM64 / LINUX (verified: `runtimePlatform.cpuArchitecture=ARM64` in serve/migrate/oneoff task-defs) | ARM64 |

intel-api is a **separate ECS service** in the same cluster and VPC as apps/api, sharing the **same Aurora cluster** and the **same task role** as apps/api (verified: serve + migrate + oneoff task-defs all carry `Capiro-dev-Compute-ApiTaskRole…`). It does not run in-process with apps/api and is not a Lambda.

**Task-role sharing consequence (do not skip):** because intel-api reuses the apps/api task role, granting it new permissions (Bedrock, SES — §2.6) **widens the api service's blast radius too**. Scope the added IAM statements to specific resources (Titan/Claude Bedrock model ARNs; the verified SES identity ARN), not `Resource:*`, so the shared role does not become a wildcard. This is a review gate, not optional.

### 2.2 ALB path routing — how `/intel-api`, `/meri-api`, `/api` coexist

All rules on host `app.capiro.ai` (registry §1). Verbatim current state:

| Priority | Path prefix | Target group |
|---|---|---|
| 3 | `/api/*`, `/webhooks/*`, `/health` | api (:4000) |
| 5 | marketing | marketing |
| 10 | `/workspace-api/*` | workspace |
| 15 | `/meri-api/*` | meriv2-orchestrator |
| 20 | host default `app.capiro.ai`, `*.app.capiro.ai` | web |
| — | **`/intel-api/*` — NO ALB RULE EXISTS TODAY** | intel-api is internal-only on :4300 |

**Gap that blocks the whole browser-facing plan.** The web Tracker tab calls `/intel-api/*` (registry §8), but the ALB does not route it — those calls currently fall through to the web default (priority 20) and 404 at the SPA. `apps/intel-api/src/main.ts:29-34` sets `setGlobalPrefix('intel-api', { exclude: [health] })` and its comment claims "the ALB listener rule that forwards `/intel-api/*`" — **that comment is aspirational; the rule is not present.** Do not treat the comment as evidence the route works.

**Action (deployment step, done ONCE before Phase 7 UI ships):** add a new listener rule forwarding `/intel-api/*` → a new intel-api target group on :4300.
- Prefix is **NOT stripped** (main.ts keeps the `intel-api` global prefix), so forward the path as-is.
- Health (`/health`) is excluded from the global prefix (`main.ts:32-34`) and is the target-group health-check path, not routed through this rule.
- Priority: registry suggests **12 or 17 — UNVERIFIED, confirm no collision**. Verify first, then pick the lowest free value in a gap:
  ```bash
  aws elbv2 describe-rules --listener-arn <HTTPS_LISTENER_ARN> \
    --query 'sort_by(Rules,&to_number(Priority))[].{P:Priority,C:Conditions[0].Values}' --output table
  ```
- **PROD ALB `capiro-prod-alb` is manually managed/wedged — add the rule via `aws elbv2 create-rule`, NEVER `cdk deploy`** (registry §1; a `cdk deploy` would drop out-of-band rules, mirroring the Clerk-webhook priority-15 lesson in memory). A new intel-api target group on :4300 must also exist / be created out-of-band and wired to the service.
- **Health-check ordering:** create the target group with health-check path `/health`, register the running intel-api tasks, and wait for `TargetHealth=healthy` (SC-1a) **before** creating the listener rule — routing to an unhealthy TG returns 502s to the SPA.
- WebSocket (live-hearing gateway) rides the SAME `/intel-api/*` rule — it upgrades on `/intel-api/hearings` (see §2.4). No separate WS listener. The **ALB idle timeout must exceed the longest hearing** (`main.ts:78-80` sets `keepAliveTimeout=305000`, `headersTimeout=310000`, and its comment notes the ALB idle timeout is raised separately in infra). **Confirm `idle_timeout.timeout_seconds` ≥ `MAX_SESSION_MS`=14400000ms (14400s / 4h)** — SC-10. Note the container-level keep-alive (305s) is FAR below 4h; hearing longevity depends on the socket staying active (frames flowing) and the ALB idle timeout, not on `keepAliveTimeout`.

Coexistence summary: `/api/*`, `/meri-api/*`, `/workspace-api/*` are unaffected; the ONLY routing change is the additive `/intel-api/*` rule. apps/api keeps `/api/intelligence/clients/:id/tracker/*` (legacy tracker) live in parallel. Per the single-sender invariant, `tracker_v2` decides which surface renders — never both — so there is no ALB-level or UI-level conflict.

### 2.3 Aurora connection, DB role & RLS reality

- Shared Aurora, `DB_NAME=capiro`. intel-api serve + migrate + oneoff tasks compose `DATABASE_URL` in `apps/intel-api/scripts/entrypoint.sh:16-24` from `DB_*` Secrets Manager values (`/capiro/dev/aurora/master` host/port, `/capiro/dev/aurora/app` username/password; prod `capiro/prod-os-capiro/*`), URL-encoding the password and appending `?schema=public&sslmode=require` (Aurora `rds.force_ssl=1`). Migrate task gets ONLY `DB_*` secrets + `DB_NAME` env (verified `intel-api-migrate-taskdef.resolved.json`).
- **DB role — NOT yet settled; confirm role parity before Phase 1.** intel-api sources `DB_USER`/`DB_PASSWORD` from `capiro/dev/aurora/app` (role `capiro_app` per s4, verified). Recon has NOT confirmed this is the SAME role apps/api runs under; s3/s11/s12 all still mark the role identity UNVERIFIED. **Confirm this equals apps/api's role and its RLS/BYPASSRLS standing (see s6)** before treating the two services as RLS-equivalent. What IS established (s6, confirmed): `capiro_app` has **FORCE RLS** and **cannot bypass RLS by table ownership** — so intel-api, if it uses `capiro_app`, is fully subject to the same policies and gets no ownership escape hatch. Do not present role-parity as settled; the plan must verify it, not assume it.
- **Connection-pool impact (NEW — must budget):** intel-api is a *second* long-lived consumer of the SAME Aurora cluster under the SAME credential. Its Prisma client opens its own pool; the change-detection/alert/digest VERBS open ADDITIONAL short-lived pools per one-off task run. Aurora `max_connections` is shared. **Before enabling cron verbs in prod, confirm `intel-api serve` pool size + concurrent one-off task pools + existing apps/api pool ≤ Aurora `max_connections` headroom** (check `SHOW max_connections` and current peak `numbackends`). Set an explicit `connection_limit` on the intel-api `DATABASE_URL` (append `&connection_limit=N`) rather than relying on the Prisma default (`num_cpus*2+1`), which on a large Fargate task can be surprisingly high. Owner: Backend + Infra. Gate: SC-11.
- **RLS gotcha — CONFIRMED against code.** `apps/intel-api/src/prisma/prisma.service.ts` is a plain `PrismaClient` with **no `withTenant`/`withSystem`** helpers; its docstring states isolation is enforced *in application code* ("every query MUST include the `tenantId` resolved by the TenantGuard"), NOT via a Postgres `SET app.current_tenant` session var. Consequences the tracker port MUST handle:
  - Reading **tenant-scoped** apps/api tables (`clients`) or **tenant-aware** `context_embeddings` under the app role will be **blocked by RLS** unless intel-api sets the tenant session var per transaction the way apps/api does. intel-api does NOT do this today.
  - **Required design work (gates Phase 1 acceptance):** add a `withTenant(tenantId, fn)` / `withSystem(fn)` wrapper to intel-api's PrismaService that issues `SET LOCAL app.current_tenant = $tenant` (this is the exact var the apps/api RLS policy reads, resolved against source in s6 — **still confirm it against the apps/api migration SQL** as a belt-and-suspenders check) inside a transaction before scoped reads. The cross-tenant/system path uses `app.bypass_rls = 'on'` (per s6) rather than a BYPASSRLS role attribute — mirror apps/api's `prisma.withSystem` for that. BYPASSRLS on the app role is **rejected** — it would break tenant isolation for the whole (shared-role) service and violate SOC 2 isolation. Recommendation: mirror apps/api's `prisma.withTenant`/`prisma.withSystem` exactly (including the `app.bypass_rls='on'` mechanism for system reads).
  - `context_embeddings` RLS = `tenant_id IS NULL OR tenant_id = current_tenant`. The bill embeddings the matcher needs are written with **NULL** tenant (shared globals), so a NULL-tenant row passes the policy regardless of the session var. **UNVERIFIED — must confirm** the app role can actually SELECT NULL-tenant `context_embeddings` rows *with no session var set*; if RLS denies when the var is unset, wrap the cosine query in `withSystem`. Do NOT assume — SC-5/SC-6 prove this on real data before Phase 3.
- `congress_bill`, `congress_bill_action/committee/subject`, `bill_text`, `state_bill` are GLOBAL / RLS-free (registry §4) → readable by ID with plain `$queryRawUnsafe`, no session var. All cross-schema SQL lives in one audited `SourceDataRepository` (plan §2.5 / §7 mitigation), which is the ONLY place raw cross-table SQL is written (strangler boundary: no scattered cross-schema queries).

### 2.4 Data-flow (ASCII preserved + expanded)

```
apps/api  (UNCHANGED: ingestion + reference-data owner)  [strangler: nothing here is modified]
  ├─ sync-congress / sync-openstates → congress_bill, state_bill, *_action   [GLOBAL, RLS-free]
  ├─ embeddings writer → context_embeddings (pgvector, model dim 1024)       [tenant_id NULL for bills]
  └─ LDA / federal reference tables
        │  (read-only, SAME Aurora, cross-table raw SQL via SourceDataRepository)
        ▼
apps/intel-api  (:4300, service capiro-dev-intel-api, OWNS intel_* only)
  ├─ Unified Watchlist (intel_watchlist / _topic|_term — table names UNVERIFIED, registry §5)  [OWN]
  ├─ Tracked Bills (intel_tracked_bill + lastSeen snapshots)                   [OWN]
  ├─ Match Engine (whole-word + semantic cosine + entity + issue-code)         [shared Bill+Hearing]
  ├─ Change Detection VERB (task verb detect-bill-changes → classifyChange)    [OWN, cron, SHADOW]
  ├─ Hearing pipeline (Deepgram live WS + F3 pre-recorded)                     [EXISTING+]
  ├─ Unified Alert (intel_alert + weighted score §6)                           [OWN, SHADOW until promoted]
  ├─ Delivery VERB (SES email + digests + intel_notification_log idempotency)  [OWN, gated, SINGLE-SENDER]
  └─ Combined Feed API (per-client bill+hearing timeline)                      [OWN]
        │
        ├── HTTP  /intel-api/*  ──┐
        └── WS    /intel-api/hearings (upgrade) ──┐
                                  ▼               ▼
   ALB app.capiro.ai  (NEW rule /intel-api/* → intel-api TG :4300; NOT in CDK)
        │
        ▼
apps/web  Client Profile → Tracker tab (Board | Hearings | Feed | Configure)
          gated by useIntelFeatureEnabled('tracker_v2'); legacy /api/intelligence/… for un-flipped tenants
          [single-sender: exactly one surface renders per tenant]
```

**Sequence — Flow A: live hearing WebSocket (request path).**
1. Browser (flagged tenant) opens WS to `wss://app.capiro.ai/intel-api/hearings` with `Authorization: Bearer <Clerk JWT>` via `useApi()` baseURL (registry §8).
2. ALB (new `/intel-api/*` rule) upgrades and forwards to `capiro-dev-intel-api` :4300; NestJS `WsAdapter` (`main.ts:27`) handles the socket in `hearing.gateway.ts`.
3. TenantGuard resolves `tenantId` from JWT; `HearingWatchFeatureGuard` checks `hearing_watch` flag (**404 if disabled**, registry §3).
4. Audio frames → `DeepgramStreamManager.open()` (`deepgram.listen.live({ model=nova-2, endpointing=300, diarize, punctuate, smart_format, encoding:'opus' })`, registry §7); interim/final transcripts persisted to Postgres (`transcriptSegment`, idempotent upsert on `(sessionId,startMs,endMs)`), encrypted AES-256-GCM via `HEARING_ENCRYPTION_KEY`.
5. Connection held for hours (≤ `MAX_SESSION_MS`=4h); the **ALB idle timeout (≥14400s, SC-10)** keeps it alive — `keepAliveTimeout=305s` is only the container HTTP keep-alive and does not govern an active WS.

**Sequence — Flow B: detect-bill-changes batch (job path — SHADOW).** Runs as an **entrypoint verb**, NOT an HTTP call. `entrypoint.sh` currently supports **only** `serve | migrate | enable-feature` (verified `entrypoint.sh:30-99`, `bootstrap()` is HTTP-only); registry §6 requires ADDING the tracker verbs (`detect-bill-changes`, `emit-bill-alerts`, `flush-digests`) to the `case` dispatch. Refactor the three `scripts/*.ts` into verb handlers.
1. EventBridge (out-of-band, NOT CDK — mirrors the existing `capiro-dev-detect-tracker-alerts` rule; `scripts/deploy-ingestion-out-of-band.sh:215` is the canonical rule+target template) fires `aws ecs run-task` on the **existing** `capiro-dev-intel-api-oneoff` task-def family (`infra/deploy/intel-api-oneoff-taskdef.json`) with `containerOverrides=[{name=intel-api-oneoff,command=["detect-bill-changes"]}]`. Do NOT invent a new `capiro-dev-intel-api-task` clone — the oneoff family already exists and shares the task role. (The current oneoff task-def hardcodes a `hearing_watch` seed entryPoint; override `command`/`entryPoint` per run, or add a dedicated verb-dispatch oneoff task-def if entryPoint override is impractical.)
2. Task loads `intel_tracked_bill.lastSeen*` per tenant/client; reads live `congress_bill` + `congress_bill_action` (GLOBAL, plain raw SQL) via `SourceDataRepository`.
3. `classifyChange()` regex cascade (registry §6, most-significant-first: enacted→to-president→failed→passed-chamber→rule-reported→floor-scheduled→reported→markup→amendment→hearing) selects material events; writes `intel_alert` rows with evidence. **Shadow invariant: `status=new`, NO delivery until the tenant is promoted.**
4. **Concurrency/locking (NEW — required for cron correctness):** `detect-bill-changes` and `flush-digests` MUST be safe under overlapping runs (a slow run + the next scheduled fire). Rely on the `intel_notification_log` UNIQUE `(alertId,userId,channel)` for delivery idempotency (registry §6: `claim()` = INSERT … ON CONFLICT; P2002 → skip), and add a run-level guard so two detection cycles do not double-insert `intel_alert`/enqueue duplicates: either an advisory lock (`SELECT pg_try_advisory_lock(<const>)` at verb start, exit early if not acquired) or `ON CONFLICT DO NOTHING` on the alert/queue insert keyed by `(clientId,billId,changeType)`. `flushDigests` already marks rows flushed regardless of send outcome (poison-row safety, registry §6) — preserve that.
5. Delivery verb (`emit-bill-alerts` / `flush-digests`) claims via `intel_notification_log` unique key (`alertId='tracker:'+clientId+':'+billId+':'+changeType`) → idempotent single-send. **Single-sender invariant:** delivery for a tenant runs from intel-api ONLY after that tenant is promoted off legacy; the legacy `detect-tracker-alerts` rule for that tenant MUST be disabled in the SAME change (see §2.7 promotion) so alerts are never double-delivered.

**Sequence — Flow C: combined-feed read (request path).**
1. Browser GET `/intel-api/clients/:clientId/feed` (Bearer JWT) → ALB → :4300.
2. TenantGuard resolves tenant; service reads intel-owned `intel_alert` (tenant-scoped, filtered by `tenantId`+`clientId` via `withTenant`, §2.3) merged with hearing alerts; enriches bill titles/actions from `congress_bill` (GLOBAL raw SQL).
3. Semantic recommendations use the cosine SQL (registry §6) against `context_embeddings` where `source_type='bill'`, `model=$EMBEDDINGS_MODEL`, cosine ≥ `EMBED_CANDIDATE_FLOOR` (0.3), `LIMIT 400` — wrapped per §2.3 so RLS permits NULL-tenant bill rows.

### 2.5 Health checks & readiness

| Layer | Check | Source-verified |
|---|---|---|
| Container | `wget -q -O /dev/null http://localhost:4300/health || exit 1`, interval 30s, timeout 5s, retries 3, **startPeriod 40s** | `intel-api-serve-taskdef.resolved.json:88-96` |
| App | `GET /health` → `{ ok:true, service:'intel-api' }`, **ungated** (excluded from global prefix) | `health.controller.ts`, `main.ts:32-34` |
| ALB target group | health-check path `/health` on :4300, expect 200; wait `healthy` BEFORE creating the listener rule (§2.2) | must be set when the TG is created |
| Readiness (migrate) | `migrate` task exits 0 after `prisma migrate deploy`; entrypoint first auto-resolves prior failed migrations by stamping `rolled_back_at` (`entrypoint.sh:35-59`); **no seed step** unlike apps/api | `entrypoint.sh:30-60` |

**Log-group defect to fix on deploy (broader than first reported).** **All THREE** intel-api task-defs write to `awslogs-group=/capiro/dev/api` — serve (`intel-api-serve-taskdef.resolved.json:83`), migrate (`intel-api-migrate-taskdef.resolved.json:26`), AND one-off (`intel-api-oneoff-taskdef.json`, `awslogs-stream-prefix=intel-api-oneoff`). Registry §1 says the template intends `/capiro/dev/intel-api`. **Correct the log group to `/capiro/dev/intel-api` (prod `/capiro/prod-os-capiro`) on all three before relying on any log-based success criterion below**, or those criteria must grep `/capiro/dev/api` with the `intel-api*` stream prefixes instead. Create the destination log group first (or the task fails to start if `awslogs-create-group` is not set).

### 2.6 Env vars, secrets & IAM (intel-api)

**Verified injected today (serve):** env `INTEL_PORT=4300`, `INTEL_BIND_HOST=0.0.0.0`, `INTEL_LOG_LEVEL`, `DB_NAME=capiro`, `DEEPGRAM_MODEL=nova-2`, `DEEPGRAM_ENDPOINTING_MS=300`, `MAX_SESSION_MS=14400000`, `NODE_ENV=production` (prod), `WEB_ORIGIN=https://app.prodos.capiro.ai` (prod), optional `CAPIRO_INTERNAL_TENANT_ID`/`MERIV2_ORCHESTRATOR_URL`/`MERIV2_TIMEOUT_MS`; secrets `DEEPGRAM_API_KEY`, `HEARING_ENCRYPTION_KEY`, `CLERK_SECRET_KEY`, `DB_HOST/PORT/USER/PASSWORD` (registry §2).
- **`CLERK_JWT_ISSUER` — registry value is WRONG; use the memory value.** Registry §2 lists `https://clerk.capiro.ai`, but that is stale/incorrect. The authoritative issuer, per the project's Clerk-instance memory, is **`https://clerk.app.capiro.ai`** (issuer `https://clerk.app.capiro.ai`; `capiro` JWT template carries tenant claims). Configure intel-api with `CLERK_JWT_ISSUER=https://clerk.app.capiro.ai`. A wrong issuer fails **all** JWT validation → every tenant read 401s. **Pre-cutover action: confirm the exact issuer against the running api service's env**, defaulting to the memory value `https://clerk.app.capiro.ai` (do NOT default to registry's `clerk.capiro.ai`).

**To ADD for the tracker port (exact names — registry §2):**
- Bedrock/embeddings: `EMBEDDINGS_MODEL` (default `amazon.titan-embed-text-v2:0`, 1024-dim). **IAM: the SHARED task role must be granted `bedrock:InvokeModel` for the Titan embed model ARN AND (for summaries) the Anthropic Claude-on-Bedrock model ARN — UNVERIFIED, MUST confirm** the role has these before Phase 3/summaries. Scope to specific model ARNs (§2.1 blast-radius note).
- SES (alerts): `AWS_REGION_DEFAULT`, `TRACKER_ALERT_EMAIL_FROM`. **IAM: task role needs `ses:SendEmail` — UNVERIFIED, MUST confirm.** Additionally the **SES sending identity for `TRACKER_ALERT_EMAIL_FROM` must be a VERIFIED identity in `us-east-1`** and, if the account is still in the SES sandbox, recipients must be verified too — confirm identity status (`aws sesv2 get-email-identity`) and sandbox state before enabling delivery. Gate: SC-12.
- SNS/SMS (dormant, single-sender-safe as long as `TRACKER_SMS_PROVIDER=none`): `TRACKER_SMS_PROVIDER`, `TRACKER_SMS_ORIGINATION_NUMBER`.
- Pipeline gates (env, default OFF for shadow): `TRACKER_ALERTS_ENABLED`, `TRACKER_SCAN_ACTION_HISTORY`, `TRACKER_ALERT_ENRICH`, `TRACKER_ALERT_SUMMARY`, `TRACKER_APP_BASE_URL`.
- Summaries: tenant-scoped Anthropic key via `AiCredentialResolverService.resolveProviderByTenantId`, metered to `ai_usage_events`. **UNVERIFIED whether that service AND the `ai_usage_events` table exist in intel-api** — the intel-api Prisma schema owns only `intel_*` today (verified `prisma.service.ts` docstring: "owns only intel_* tables"). Confirm-or-port both. Same open question for `IntelligenceChange` (registry §6). Until confirmed, `TRACKER_ALERT_SUMMARY` stays unset (summaries fail-safe to null — registry §6).

**Feature-flag gating (registry §3):** `tracker_owner_intel` (backend data-path ownership) and `tracker_v2` (frontend surface) are NEW flags to add; `FeatureFlagService.isEnabled(feature, tenantId)` reads `intel_feature_flag`, ALWAYS-on for `CAPIRO_INTERNAL_TENANT_ID`, guard returns **404** (not 403) when disabled. Enable per-tenant via the `enable-feature <flag> <tenantSlugOrId>` verb (`entrypoint.sh:65-93`, upserts on conflict `(feature,tenant_id)` — idempotent). Frontend hook `useIntelFeatureEnabled` **fails CLOSED** (registry §8), so a flag-service outage hides the new surface rather than exposing it — consistent with single-sender.

### 2.7 Network & security groups

- `networkMode=awsvpc`, `assignPublicIp=DISABLED` (private subnets; verified in `scripts/deploy-ingestion-out-of-band.sh:98`).
- **Subnets / security groups are NOT hardcoded in any deploy file** (grep of `infra/deploy` and `scripts/` for `subnet-`/`sg-` returns nothing). Canonical mechanism (`scripts/deploy-ingestion-out-of-band.sh:44-58`): **auto-discover from the live api service's `networkConfiguration.awsvpcConfiguration`** and reuse:
  ```bash
  netcfg=$(aws ecs describe-services --cluster capiro-dev --services capiro-dev-api \
    --query 'services[0].networkConfiguration.awsvpcConfiguration' --output json)
  SUBNETS_JSON=$(echo "$netcfg" | jq -c '.subnets'); SG_JSON=$(echo "$netcfg" | jq -c '.securityGroups')
  ```
  This lands intel-api one-off/cron tasks in the same SG that already has Aurora ingress + egress, resolving registry's "subnets/SGs UNVERIFIED" by *not hardcoding*. The intel-api **service's** own SG (for serve tasks behind the ALB) is out-of-band; **confirm it allows ALB→:4300 ingress and Aurora egress** before adding the ALB rule (SC-1a would otherwise never go healthy).
- Bedrock, SES, Secrets Manager, ECR are reached over the VPC's existing egress path (same as apps/api under the shared SG). Confirm egress (or VPC endpoints) exist for Bedrock + SES before enabling those code paths.

### 2.8 Deploy ordering (mirror `scripts/deploy-dev.sh`, registry §1)

1. **Preflight:** assert account `967807252336`, target `<GIT_SHA>`, current `/health` green; confirm the log group exists (§2.5) and (prod) resolve the UNVERIFIED prod service name (§2.1).
2. **Build+push ARM64** image (registry §1 buildx command, `-f apps/intel-api/Dockerfile`, tags `:latest` + `:<GIT_SHA>`) — or let CI (`.github/workflows/intel-api-image.yml`) do it on push touching `apps/intel-api/**`, `packages/meriv2-core/**`, `packages/shared/**`, `pnpm-lock.yaml`. Verify the pushed manifest is `arm64` (`docker manifest inspect … | grep architecture`) — an accidental amd64 `:latest` won't run on Fargate ARM64 (memory: prior amd64/`:latest` incident).
3. **Run MIGRATE task first**, wait STOPPED + `containers[0].exitCode==0`; verify `_prisma_migrations` advanced (SC-7). Migrations are **additive `intel_*` only** — they must never touch apps/api tables (strangler invariant).
4. `aws ecs update-service --cluster capiro-dev --service capiro-dev-intel-api --force-new-deployment`, wait `services-stable`.
5. **(One-time, before UI)** create the intel-api target group (health-check `/health`, wait healthy), then add the `/intel-api/*` ALB rule via `aws elbv2 create-rule` (§2.2).
6. **Per-tenant promotion (shadow → live, single-sender):** enable `tracker_owner_intel` then `tracker_v2` for the tenant via `enable-feature`; **in the same change, disable that tenant's legacy `detect-tracker-alerts` delivery** so alerts are not double-sent. Validate one tenant end-to-end before widening.

**Rollback.** Instant surface hide: **delete the `/intel-api/*` ALB rule** — browser calls fall back to the web default and the legacy tracker under `/api/*` still serves (single-sender preserved). Service rollback: redeploy the previous `:<GIT_SHA>`. Migrations are forward-only, so every tracker migration must be additive and backward-compatible with the prior image (an old serve image must tolerate new-but-unused `intel_*` columns/tables). Per-tenant rollback: flip `tracker_v2`/`tracker_owner_intel` off and re-enable the tenant's legacy delivery rule.

### Success criteria

| # | Check (command / metric) | Threshold / gate | Owner | Unblocks |
|---|---|---|---|---|
| SC-1 | Service stable: `aws ecs describe-services --cluster capiro-dev --services capiro-dev-intel-api --query 'services[0].deployments[?status==\`PRIMARY\`].{r:runningCount,d:desiredCount}'` | runningCount==desiredCount, 0 failed tasks, reaches `services-stable` | Release eng | serve deploy |
| SC-1a | TG target healthy: `aws elbv2 describe-target-health --target-group-arn <intel-tg>` | all targets `healthy` **before** listener rule is created | Release eng | ALB rule |
| SC-2 | App health: `curl -fsS https://app.capiro.ai/intel-api/health` (after rule) AND container-local `:4300/health` | HTTP 200, body `{"ok":true,"service":"intel-api"}` | Release eng | Phase 7 |
| SC-3 | ALB route + no collision: `aws elbv2 describe-rules --listener-arn <arn>` shows one `/intel-api/*` rule → intel-api TG at the chosen priority; that priority absent before add | rule present, unique priority, path `/intel-api/*` unstripped | Release eng | browser calls |
| SC-4 | Global-table read in prod: oneoff task runs `SELECT id,title FROM congress_bill WHERE id='119-hr-1' LIMIT 1` via SourceDataRepository | 1 row, no RLS error | Backend | Phase 1 |
| SC-5 | Cosine on `context_embeddings` (NULL-tenant bills) in prod under app role, per §2.3 wrapping | ≥1 row, `score` in (0,1], query < 500ms p95 | Backend | Phase 3 |
| SC-6 | RLS proof: read `clients` for a known tenant WITH `SET LOCAL app.current_tenant` → that tenant's rows; WITHOUT it → 0 rows | scoped read works only with the session var `app.current_tenant` (policy active); NULL-tenant `context_embeddings` readable; system/cross-tenant path uses `app.bypass_rls='on'` (s6), not a BYPASSRLS role | Backend | §2.3 wrapper design |
| SC-7 | Migrate readiness: migrate task `exitCode==0`; new `intel_*` migration has `finished_at` set in `_prisma_migrations` | exit 0, migration recorded, no apps/api table touched | Release eng | serve roll |
| SC-8 | WS live smoke: connect `wss://app.capiro.ai/intel-api/hearings` (valid tenant JWT, `hearing_watch` on), stream a short opus sample | 101 upgrade, ≥1 transcript segment persisted, clean close; not dropped before `MAX_SESSION_MS` | QA | hearing surface |
| SC-9 | Logs land correctly: after log-group fix, streams `intel-api`/`intel-api-migrate`/`intel-api-oneoff` under `/capiro/dev/intel-api`; none under `/capiro/dev/api` | non-empty streams in the new group, zero new intel streams in `/capiro/dev/api` | Release eng | log-based monitoring |
| SC-10 | ALB idle timeout ≥ hearing max: `aws elbv2 describe-load-balancer-attributes --query "Attributes[?Key=='idle_timeout.timeout_seconds'].Value"` | ≥ 14400 (== `MAX_SESSION_MS`/1000) | Infra | live-hearing GA |
| SC-11 | Connection headroom: `SELECT max_conn, used, (max_conn-used) AS free FROM (SELECT current_setting('max_connections')::int max_conn,(SELECT count(*) FROM pg_stat_activity) used) t` at peak (serve + N concurrent oneoff verbs + apps/api) | free ≥ 20% of `max_connections` with all pools open; explicit `connection_limit` set on intel-api DATABASE_URL | Infra + Backend | cron verbs in prod |
| SC-12 | SES identity + IAM: `aws sesv2 get-email-identity --email-identity <TRACKER_ALERT_EMAIL_FROM>` verified in us-east-1; account out of sandbox (or recipients verified); a dry-run `sendTestAlert` from the task role succeeds | identity `VerificationStatus=SUCCESS`, `ses:SendEmail` allowed on the shared role, test alert delivered | Backend + Infra | alert delivery (single-sender promotion) |
| SC-13 | Cron idempotency/locking: run `detect-bill-changes` twice back-to-back over the same window | no duplicate `intel_alert` rows for `(clientId,billId,changeType)`; no duplicate `intel_notification_log` claims (P2002 skips) | Backend | shadow → live promotion |

**Deployment-blocking prerequisites surfaced by recon (all before Phase-1 acceptance):** (1) add intel-api `withTenant`/`withSystem` — currently ABSENT (verified `prisma.service.ts`); use `SET LOCAL app.current_tenant` for scoped reads and `app.bypass_rls='on'` for system reads (s6); (2) grant the SHARED task role `bedrock:InvokeModel` (Titan embed + Claude) and `ses:SendEmail`, scoped to specific ARNs — both **UNVERIFIED**; (3) create the intel-api target group + `/intel-api/*` ALB rule out-of-band (never via `cdk deploy`); (4) fix the log group on all three task-defs; (5) confirm-or-port `AiCredentialResolverService`, `ai_usage_events`, and `IntelligenceChange` into intel-api (schema owns only `intel_*` today — verified); (6) set `CLERK_JWT_ISSUER=https://clerk.app.capiro.ai` (registry's `clerk.capiro.ai` is stale/wrong — memory is authoritative; confirm against the running api env pre-cutover, defaulting to the memory value); (7) add tracker verbs (`detect-bill-changes`/`emit-bill-alerts`/`flush-digests`) to `entrypoint.sh` (only `serve|migrate|enable-feature` exist today — verified); (8) budget Aurora connections (SC-11); (9) confirm prod intel-api service/task-def/oneoff family names (§2.1); (10) confirm DB role parity — that intel-api's `capiro_app` (from `capiro/dev/aurora/app`) equals apps/api's role and its RLS/BYPASSRLS standing (s3/s11/s12 mark role identity UNVERIFIED; s6 confirms `capiro_app` has FORCE RLS and no ownership bypass).

---

## 3. Unified data model & migrations

This section makes §2 (tables 2.1–2.5) deployment-ready: exact columns/types, indexes, uniques, the **forward-only** migration ordering that absorbs the existing hearing `intel_watchlist`/`intel_watchlist_term` **without a destructive rename**, the idempotent legacy→unified backfill, RLS/role handling for cross-DB reads, and measurable success criteria. It does not change §0 decisions (D1–D7) — intel-api stays a read-only consumer of apps/api tables and the sole writer of `intel_*` (D2), and apps/api remains source of truth during shadow (D6).

> **Authoritative reconciliation notice (resolves cross-section conflicts).** Earlier drafts (referred to as s3 and s5) disagreed on (i) watchlist identity/idempotency, (ii) the exact `intel_watchlist` ALTER set, and (iii) the `term_type` literal for riskTerms. **This section (§3) is now the single source of truth for all three; where s5 differs it is superseded.** The three binding resolutions:
> 1. **Watchlist identity = ONE scheme: deterministic id `wl:<clientId>` (upsert-by-id).** There is **no** `INSERT … ON CONFLICT (tenant_id, client_id)` and **no** added `UNIQUE(tenant_id, client_id)` constraint. Any s5 language proposing an ON-CONFLICT-on-natural-key upsert or a new unique constraint on `intel_watchlist` is dropped. Hearing watchlists keep their cuid ids and never collide with the `wl:` prefix (invariant restated in §3.3).
> 2. **`intel_watchlist` ALTER set = exactly ONE new column: `issue_areas`.** The existing table already has `client_id` and `active` (verified in-repo, §3.0), and `created_by` **stays NOT NULL**. We do **not** add `client_id`, `source_hash`, `active`, `updated_by`, and we do **not** flip `created_by` to NULL. Any s5 statement adding those columns or nulling `created_by` is superseded (see §3.1 note).
> 3. **riskTerms → `term_type = 'risk'`** (registry §5 canonical set `synonym|entity|risk`). The value `risk_phrase` is **removed** from the tracker-backfill vocabulary. Any s5 mapping of riskTerms→`risk_phrase` is superseded; code, the §3.4 verification queries, and success criteria all use `'risk'`.

**Scope boundary (avoids duplicating other sections):** this section owns schema + migrations + backfill only. SES sender-identity verification, per-tenant feature-flag flips (`tracker_owner_intel`/`tracker_v2`), Bedrock/`ses:SendEmail` task-role IAM grants, and connection-pool sizing are owned by the runtime/deploy and IAM sections. They are referenced here only where a data-layer step **hard-depends** on them (e.g. the backfill needs the same DB role as apps/api; the backfill does **not** send email, so SES is explicitly out of scope for this section).

### 3.0 Ground-truth constraints (verified in-repo, not inventions)

These override the illustrative pseudo-columns in §2 where they conflict. All rows below were re-verified against the worktree, not just the registry.

| Fact | Value | Source (verified) |
|---|---|---|
| intel-api id type | **cuid** (`String @default(cuid())`, SQL `TEXT`) | `apps/intel-api/prisma/schema.prisma` (FeatureFlag, Watchlist, WatchlistTerm, WatchlistMatch, all session/segment models — all cuid) |
| intel-api timestamp type | `DateTime` → SQL `TIMESTAMP(3)` (NOT `Timestamptz`) | `apps/intel-api/prisma/migrations/20260630000000_intel_watchlists/migration.sql` (all cols `TIMESTAMP(3)`) |
| apps/api id type | **uuid** (`@db.Uuid`) | `apps/api/prisma/schema.prisma` (ClientWatchlist, AlertPreference, TrackedBill, …) |
| **RLS in intel-api** | **NONE — CONFIRMED.** grep for `withTenant\|withSystem\|set_config\|current_tenant_id\|BYPASSRLS` in `apps/intel-api/src` = **zero matches**. Schema header (line 3–4) states: "Tenant-scoped: every row carries tenant_id NOT NULL and is filtered in application code by the TenantGuard-resolved tenantId." | `apps/intel-api/prisma/schema.prisma`; grep verified this session |
| Existing hearing `intel_watchlist` columns | `id, tenant_id, client_id, name, active, created_by (NOT NULL), created_at, updated_at` — **`client_id` and `active` ALREADY EXIST; no `issue_areas`, no `source_hash`, no topic ref**. Indexes: `(tenant_id, client_id)` AND `(tenant_id, active)`. | migration `20260630000000_intel_watchlists` (verified full SQL) |
| Existing `intel_watchlist_term` columns | `id, watchlist_id, tenant_id, term_type, value, weight, created_at` — **no `topic_id`**; FK `watchlist_id → intel_watchlist(id) ON DELETE CASCADE ON UPDATE CASCADE`. Indexes: `(watchlist_id)`, `(tenant_id, term_type)`. | same |
| Existing hearing `intel_watchlist_match` | present (session/segment match rows) — **must remain untouched** by any tracker migration. | same |
| **Already-applied migrations** | **TWO** folders exist and are applied on dev/prod: `20260629000000_intel_live_hearing_init` and `20260630000000_intel_watchlists`. New tracker migrations must timestamp **after** both. | directory listing (verified) |
| Migration dir convention | `apps/intel-api/prisma/migrations/<YYYYMMDDHHMMSS>_<name>/migration.sql` + `migration_lock.toml` | directory listing |
| Migrate entrypoint | task-def family `capiro-dev-intel-api-migrate` (prod `capiro-prod-intel-api-migrate`), container `intel-api-migrate`, command `['migrate']` → composes `DATABASE_URL` from DB_* secrets (`sslmode=require`), auto-resolves previously-failed migrations, runs `prisma migrate deploy`, exits. **No seed step.** | registry §1 + `apps/intel-api/scripts/entrypoint.sh` (verified: `migrate` case, lines 31–60) |
| **Entrypoint verb-dispatch pattern** | `entrypoint.sh` is a `case "${1:-serve}"` dispatch with `serve` / `migrate` / `enable-feature` verbs today. `enable-feature <feature> <tenantSlugOrId>` already reads the cross-DB `tenants` table via `$queryRawUnsafe('select id from tenants where slug=$1')` and upserts `intel_feature_flag`. Adding new verbs = adding `case` arms + updating the final `*)` "Unknown command" list. | `apps/intel-api/scripts/entrypoint.sh` (verified, lines 30–99) |
| **Cross-DB read already works under intel-api's role for `tenants`** | The live `enable-feature` verb successfully `SELECT`s from `tenants` — proving intel-api's DB role can read that (RLS-free) table. This does **not** prove it can read RLS-scoped `clients`/`context_embeddings`; that remains a hard gate (§3.5). | `entrypoint.sh` (in production per registry §141 commit) |
| Runtime Node version | `NODE_VERSION=20.16.0` (bookworm-slim), prod Fargate ARM64; `binaryTargets = ["native","linux-arm64-openssl-3.0.x"]` already set. | `apps/intel-api/Dockerfile` (verified) |

**Consequence for the schema design:** because intel-api has **no RLS**, primary tenant isolation for `intel_*` tables is application-code `WHERE tenant_id = :ctx`. Therefore **every new `intel_*` table gets `tenant_id TEXT NOT NULL` + a composite index leading with `(tenant_id, client_id, …)`** so the app-code filter is always index-backed, matching the existing hearing tables exactly. Do **not** introduce RLS on `intel_*` — it would diverge from the whole service and is out of scope. (§3.5 covers the *separate* cross-DB-read RLS problem.)

### 3.1 Final column specs (Prisma models — additive to `apps/intel-api/prisma/schema.prisma`)

All ids cuid, all timestamps `DateTime` (`TIMESTAMP(3)`), all `tenant_id` NOT NULL. Enums stored as `String` with an inline comment (matches existing `WatchlistTerm.termType`; do NOT add Postgres enums — the existing free-string `term_type` tolerates supersets and avoids migration coupling).

**2.1 Unified watchlist — EXTEND existing `intel_watchlist`, ADD `intel_watchlist_topic`, EXTEND `intel_watchlist_term`.**

Registry §5 flags `intel_topic`/`intel_term` vs `intel_watchlist_term` as UNVERIFIED. **Resolution (binding decision, supersedes the registry's "PROPOSED `intel_topic`/`intel_term`" note): REUSE the existing hearing tables `intel_watchlist` + `intel_watchlist_term` and ADD a new sibling `intel_watchlist_topic`.** Rationale: D3 unifies bill + hearing matching onto one watchlist; the hearing path already writes `intel_watchlist_term` (cascade FK) and live `intel_watchlist_match` rows. A parallel `intel_topic`/`intel_term` set would fork the very object D3 unifies and orphan the hearing writer. So the tracker port targets `intel_watchlist` / `intel_watchlist_topic` / `intel_watchlist_term` — **NOT** `intel_topic`/`intel_term`.

**Authoritative `intel_watchlist` ALTER set (reconciles s3 + s5).** The existing table already carries `client_id NOT NULL` and `active` (§3.0). The **only** additive column is `issue_areas`. `created_by` **remains NOT NULL** (the backfill supplies it; see §3.3). We do **not** add `client_id`, `source_hash`, `active`, or `updated_by`, and we do **not** change `created_by` nullability. Identity stays the deterministic `wl:<clientId>` id (upsert-by-id) — **no** `UNIQUE(tenant_id, client_id)` is added and **no** ON-CONFLICT-on-natural-key path exists. This is the merge of s3 §3.1/M1 and s5 §5.1; where s5 added extra columns or a unique constraint, this set supersedes it.

```prisma
// EXTEND (additive columns only — no rename, no drop):
model Watchlist {                       // @@map("intel_watchlist")  [EXISTING]
  // ...existing: id, tenantId, clientId (NOT NULL), name, active, createdBy (NOT NULL),
  //              createdAt, updatedAt, terms
  issueAreas String[] @default([]) @map("issue_areas")   // NEW (the ONLY added column)
  topics     WatchlistTopic[]                            // NEW relation (no column)
  // Identity = deterministic id `wl:<clientId>` (upsert-by-id). NO UNIQUE(tenant_id, client_id).
  // createdBy is NOT NULL in the existing table and STAYS NOT NULL. Backfill MUST supply it
  // (use ClientWatchlist.updatedBy ?? 'legacy-sync'); see §3.3.
  // NOT added: client_id (already exists), source_hash, active (already exists), updated_by.
  // EXISTING indexes ([tenantId, clientId], [tenantId, active]) — KEEP BOTH.
}

model WatchlistTopic {                  // @@map("intel_watchlist_topic")  [NEW]
  id          String    @id @default(cuid())
  watchlistId String    @map("watchlist_id")
  tenantId    String    @map("tenant_id")
  label       String                                     // = ClientWatchlist tag.tag
  issueArea   String?   @map("issue_area")               // = normalizeIssueArea(tag.issueArea)
  position    String    @default("monitor")              // 'support'|'oppose'|'monitor'
  priority    String    @default("med")                  // 'low'|'med'|'high'
  createdAt   DateTime  @default(now()) @map("created_at")
  watchlist   Watchlist @relation(fields: [watchlistId], references: [id], onDelete: Cascade)
  terms       WatchlistTerm[]
  @@index([watchlistId])
  @@index([tenantId, watchlistId])
  @@map("intel_watchlist_topic")
}

model WatchlistTerm {                   // @@map("intel_watchlist_term")  [EXISTING — EXTEND]
  // ...existing: id, watchlistId, tenantId, termType, value, weight, createdAt, watchlist(FK cascade)
  topicId String? @map("topic_id")                       // NEW: null = watchlist-global (hearing-style flat term)
  topic   WatchlistTopic? @relation(fields: [topicId], references: [id], onDelete: Cascade)
  @@index([topicId])                                     // NEW
  // EXISTING indexes ([watchlistId], [tenantId, termType]) — KEEP.
}
```

`termType` valid values (superset already accepted by the hearing writer): `keyword | synonym | entity | risk | bill | agency | committee | legislator | company | competitor | support_language | opposition_language | program_element | topic`. **Note the `risk` literal:** the tracker backfill (§3.3) maps riskTerms → `term_type = 'risk'` per registry §5 (`synonym|entity|risk`). The prior `risk_phrase` value is **removed** from this vocabulary to eliminate the s3/s5 ambiguity; any s5 reference to `risk_phrase` for riskTerms is superseded. The tracker backfill (§3.3) emits only `synonym`, `entity`, `risk` (see §5 mapping); the hearing writer keeps its own set. No enum constraint → no migration coupling.

**2.2 `intel_tracked_bill`** (supersedes apps/api `tracked_bill`; carries lastSeen snapshot for change detection):

```prisma
model TrackedBill {                     // @@map("intel_tracked_bill")  [NEW]
  id                 String    @id @default(cuid())
  tenantId           String    @map("tenant_id")
  clientId           String    @map("client_id")
  billId             String    @map("bill_id")           // raw congress_bill.id e.g. "119-hr-1234" (string, NOT uuid)
  source             String    @default("congress")      // 'congress'|'state'
  note               String?
  isManual           Boolean   @default(false) @map("is_manual")   // legacy source == 'manual_search'
  trackedBy          String?   @map("tracked_by")        // clerk id (= legacy created_by)
  trackedAt          DateTime  @default(now()) @map("tracked_at")
  stage              String?                             // board column
  lastSeenActionText String?   @map("last_seen_action_text")
  lastSeenActionDate DateTime? @map("last_seen_action_date")
  lastSeenAt         DateTime? @map("last_seen_at")
  unread             Boolean   @default(false)
  createdAt          DateTime  @default(now()) @map("created_at")
  updatedAt          DateTime  @updatedAt @map("updated_at")
  @@unique([clientId, billId])          // idempotent backfill key (mirrors legacy tracked_bill)
  @@index([tenantId, clientId])
  @@index([billId])
  @@map("intel_tracked_bill")
}
```

**2.3 `intel_alert`** (§6 object; cuid + `TIMESTAMP(3)`):

```prisma
model IntelAlert {                      // @@map("intel_alert")  [NEW]
  id              String   @id @default(cuid())
  tenantId        String   @map("tenant_id")
  clientId        String   @map("client_id")
  sourceType      String   @map("source_type")           // 'bill'|'hearing'|'combined'
  sourceRef       String   @map("source_ref")            // billId | sessionId | composite
  watchlistId     String?  @map("watchlist_id")
  topicId         String?  @map("topic_id")
  termId          String?  @map("term_id")
  kind            String                                 // bill_amended|bill_passed_chamber|hearing_mention|...
  changeType      String?  @map("change_type")           // classifyChange() output (bill path)
  severity        String                                 // 'info'|'notable'|'critical'
  materiality     String                                 // 'low'|'medium'|'high'
  score           Float    @default(0)
  clientImpact    String?  @map("client_impact")         // 'favorable'|'unfavorable'|'monitor'
  urgency         String?                                // 'low'|'med'|'high'
  title           String
  whyItMatters    String?  @map("why_it_matters")
  recommendedAction String? @map("recommended_action")
  evidence        Json     @default("{}")
  status          String   @default("new")               // new|reviewed|sent|dismissed|snoozed|suppressed
  createdAt       DateTime @default(now()) @map("created_at")
  deliveredAt     DateTime? @map("delivered_at")
  @@index([tenantId, clientId, createdAt])
  @@index([tenantId, status])
  @@index([tenantId, sourceType, sourceRef])             // supports 14-day dedup (below)
  @@map("intel_alert")
}
```

Registry flags apps/api `IntelligenceChange` as "UNVERIFIED whether it exists in intel-api". **CONFIRMED: `IntelligenceChange` is NOT in the intel-api schema. Do not emit into it from intel-api (would violate D2 — cross-service write into an apps/api table).** The §6 `emitIntelligenceChange` behavior is re-targeted onto `intel_alert`: the 14-day dedup becomes, before insert, `WHERE tenant_id=? AND source_type='bill' AND change_type=? AND source_ref=? AND created_at >= now()-interval '14 days'`, backed by `@@index([tenantId, sourceType, sourceRef])`.

**2.4 preferences / delivery / feedback:**

```prisma
model IntelAlertPreference {            // @@map("intel_alert_preference")  [NEW] — 1:1 carry of AlertPreference
  id               String   @id @default(cuid())
  tenantId         String   @map("tenant_id")
  clientId         String   @map("client_id")
  userId           String   @map("user_id")              // clerk id
  triggers         String[] @default([])
  materiality      String   @default("medium")
  emailEnabled     Boolean  @default(false) @map("email_enabled")
  emailAddress     String?  @map("email_address")
  emailCadence     String   @default("realtime") @map("email_cadence")
  smsEnabled       Boolean  @default(false) @map("sms_enabled")
  smsPhone         String?  @map("sms_phone")
  smsPhoneVerified Boolean  @default(false) @map("sms_phone_verified")
  smsCadence       String   @default("realtime") @map("sms_cadence")
  quietHoursStart  String?  @map("quiet_hours_start")
  quietHoursEnd    String?  @map("quiet_hours_end")
  createdAt        DateTime @default(now()) @map("created_at")
  updatedAt        DateTime @updatedAt @map("updated_at")
  @@unique([userId, clientId])          // matches legacy AlertPreference unique — idempotent backfill key
  @@index([tenantId, clientId])
  @@map("intel_alert_preference")
}

model IntelNotificationLog {            // @@map("intel_notification_log")  [NEW]
  id                String   @id @default(cuid())
  tenantId          String   @map("tenant_id")
  clientId          String   @map("client_id")
  alertId           String   @map("alert_id")            // = 'tracker:'+clientId+':'+billId+':'+changeType (§6)
  userId            String   @map("user_id")
  channel           String                               // 'email'|'sms'|'in_app'
  status            String                               // 'sent'|'failed'|'suppressed'|'queued'
  providerMessageId String?  @map("provider_message_id")
  error             String?
  createdAt         DateTime @default(now()) @map("created_at")
  @@unique([alertId, userId, channel])  // CRITICAL: preserves §6 send-idempotency; backfill MUST keep this key
  @@index([tenantId, clientId])
  @@map("intel_notification_log")
}

model IntelAlertDigestQueue {           // @@map("intel_alert_digest_queue")  [NEW] — flushDigests target
  id        String   @id @default(cuid())
  tenantId  String   @map("tenant_id")
  clientId  String   @map("client_id")
  userId    String   @map("user_id")
  alertId   String   @map("alert_id")
  channel   String                                       // 'email'|'sms'
  cadence   String                                       // 'daily'|'weekly'
  flushed   Boolean  @default(false)
  createdAt DateTime @default(now()) @map("created_at")
  @@index([tenantId, userId, channel, flushed])          // supports flushDigests query (cadence∈daily,weekly AND flushed=false)
  @@map("intel_alert_digest_queue")
}

model IntelFeedback {                   // @@map("intel_feedback")  [NEW]
  id         String   @id @default(cuid())
  tenantId   String   @map("tenant_id")
  clientId   String   @map("client_id")
  userId     String?  @map("user_id")
  alertId    String?  @map("alert_id")
  targetType String   @map("target_type")               // 'bill'|'hearing'|'alert'|'recommendation'
  targetRef  String   @map("target_ref")
  signal     String                                     // useful|not_useful|wrong_impact|wrong_urgency|false_positive|missed|tracked|dismissed|marked_irrelevant|opened
  createdAt  DateTime @default(now()) @map("created_at")
  @@index([tenantId, clientId])
  @@index([targetRef])
  @@map("intel_feedback")
}
```

`IntelAlertDigestQueue` is required because §6 `claimAndEnqueueDigest` + `flushDigests` read/write it and it has no analog in the existing intel-api schema.

### 3.2 Forward-only migration ordering (additive, non-destructive)

Prisma `migrate deploy` applies **all** pending folders in lexical (timestamp) order and never edits already-applied ones. **Two** migrations are already applied on dev/prod (`20260629000000_intel_live_hearing_init`, `20260630000000_intel_watchlists`) — we must NOT edit either; we layer new timestamped folders after both.

**Create these folders under `apps/intel-api/prisma/migrations/`, in this exact order:**

| # | Folder | What it does | Destructive? |
|---|---|---|---|
| M1 | `20260701090000_intel_watchlist_topics_and_extend/` | `ALTER TABLE intel_watchlist ADD COLUMN issue_areas TEXT[] NOT NULL DEFAULT '{}'` (**the ONLY new column on intel_watchlist — no `client_id`/`source_hash`/`active`/`updated_by`, no UNIQUE(tenant_id,client_id), no change to `created_by` nullability**); `CREATE TABLE intel_watchlist_topic (...)`; `ALTER TABLE intel_watchlist_term ADD COLUMN topic_id TEXT`; add FK `intel_watchlist_term.topic_id → intel_watchlist_topic(id) ON DELETE CASCADE`; `CREATE INDEX` for `topic_id`, `(watchlist_id)` + `(tenant_id, watchlist_id)` on the topic table. | **NO** — pure ADD. Existing hearing rows keep `topic_id = NULL` (= watchlist-global term) and `issue_areas = '{}'`; hearing matcher unaffected. |
| M2 | `20260701090100_intel_tracked_bill/` | `CREATE TABLE intel_tracked_bill` + unique `(client_id, bill_id)` + indexes. | NO |
| M3 | `20260701090200_intel_alert/` | `CREATE TABLE intel_alert` + 3 indexes. | NO |
| M4 | `20260701090300_intel_alert_delivery/` | `CREATE TABLE intel_alert_preference` (unique `(user_id, client_id)`), `intel_notification_log` (unique `(alert_id, user_id, channel)`), `intel_alert_digest_queue`, `intel_feedback`. | NO |

**Why this avoids a destructive rename (registry §5 / D3 concern):** we never rename `intel_watchlist`→anything and never drop `intel_watchlist_term`. The "unified" model is the **existing** hearing table set + two additive extensions (`issue_areas`, `intel_watchlist_topic`, `topic_id`). Bill semantics live in topics + child terms; hearing semantics remain flat terms with `topic_id = NULL`. One object, zero data loss, no backfill of the hearing side. Consistent with the strangler/shadow model: legacy apps/api tracker keeps serving until `tracker_v2` is flipped per tenant (D4/D6).

**Generate the SQL properly (never hand-author drift):**
```bash
cd apps/intel-api      # edit schema.prisma per §3.1 first
DATABASE_URL="postgresql://<user>:<pw>@127.0.0.1:5433/capiro_scratch?sslmode=disable" \
  pnpm exec prisma migrate dev --name intel_watchlist_topics_and_extend --create-only
# Review generated migration.sql; confirm ALTER ... ADD / CREATE only (no DROP/RENAME);
# confirm intel_watchlist gains ONLY issue_areas and no UNIQUE(tenant_id,client_id).
# Repeat --create-only per model group (M2..M4) so each is its own reviewable folder.
```
> Use `127.0.0.1` not `localhost` (IPv6 dead-end via Docker — infra memory). Scratch DB only for `migrate dev`; **never** `migrate dev` against the shared `capiro` dev DB (known migration drift — infra memory). Prod/dev deploy uses `migrate deploy` exclusively (the migrate task-def, container `intel-api-migrate`, cmd `['migrate']`).

**arm64 note:** the intel-api image is built ARM64 (`capiro-build-intel-api`, ARM_CONTAINER; local fallback `docker buildx build --platform linux/arm64 -f apps/intel-api/Dockerfile … --push <REPO_ROOT>`). `binaryTargets = ["native","linux-arm64-openssl-3.0.x"]` is already set — no schema change, but verify `prisma generate` emitted the arm64 query engine into the image (SC-3 log check). Same image serves `serve`, `migrate`, and the new backfill verbs.

**Connection-pool note (data-layer relevant):** migrate + backfill verbs open a short-lived Prisma client that competes with `serve` tasks against the shared Aurora `capiro` cluster. Run backfill verbs as **one-off Fargate tasks** (separate from serve), keep their Prisma pool small (default is fine — single connection burst), and do not run the backfill concurrently with a service roll that also runs migrate. Ordering (§3.3 concurrency) + the advisory lock below prevent pool contention from parallel backfills.

### 3.3 Legacy → unified backfill (idempotent) — new entrypoint verbs

intel-api is HTTP-only with a single `bootstrap()`. The backfill runs as **new entrypoint verbs**, added as `case` arms in `apps/intel-api/scripts/entrypoint.sh` (the `enable-feature` verb proves the pattern — it already reads the cross-DB `tenants` table via `$queryRawUnsafe` and writes an `intel_*` table). Add:
- `sync-watchlists-from-legacy [tenantSlugOrId]`
- `backfill-tracked-bills [tenantSlugOrId]`
- `backfill-alert-prefs [tenantSlugOrId]`

**Update the final `*)` "Unknown command" arm** to list the new verbs (else they fall through to `exit 1`).

**Invocation shape (NOT the `migrate` command — a container override, like `enable-feature`):** these verbs reuse the migrate task-def image (`intel-api-migrate`) because that task-def already injects the DB_* secrets they need (they touch only `tenants`, `client_watchlist`, `tracked_bill`, `alert_preference`, and `intel_*` — no Deepgram/Clerk/SES secrets). Run via `run-task` with a `containerOverrides.command`:
```
aws ecs run-task --cluster capiro-dev --launch-type FARGATE \
  --task-definition capiro-dev-intel-api-migrate \
  --network-configuration 'awsvpcConfiguration={subnets=[<UNVERIFIED — from resolved task-def>],securityGroups=[<UNVERIFIED>],assignPublicIp=DISABLED}' \
  --overrides 'containerOverrides=[{name=intel-api-migrate,command=["sync-watchlists-from-legacy","<tenantSlugOrId>"]}]'
```
> subnets/SGs: **UNVERIFIED — must confirm** from `scripts/deploy-ingestion-out-of-band.sh` run_job_wait template / resolved task-defs (same gap the registry flags for the migrate/enable-feature run-task shape).

The verbs read apps/api tables via **raw SQL** (`$queryRawUnsafe`, D2 — never Prisma models of apps/api) and write `intel_*` via the intel Prisma client. **One-way, apps/api = source of truth during shadow (D6).** They require intel-api's DB role to be able to read `client_watchlist`/`alert_preference`/`tracked_bill` — these are **tenant-scoped RLS tables in apps/api**, so this is gated on §3.5 (same DB role as apps/api, else scoped reads return zero rows). The `enable-feature` precedent only proves the RLS-free `tenants` table is readable; **it does NOT prove the RLS tables are** — SC-8 is a hard prerequisite for backfill.

**Concurrency / locking (required):** a scheduled shadow-sync cron (D6) and a manual run of the same verb can overlap and double-write. Wrap each per-tenant sync in a Postgres **advisory lock** so overlapping runs serialize instead of racing:
```ts
// key = hash of ('intel_sync_wl', tenantId); non-blocking try-lock, skip tenant if held.
const [{ locked }] = await intel.$queryRawUnsafe(
  `SELECT pg_try_advisory_lock(hashtext($1)) AS locked`, `intel_sync_wl:${tenantId}`);
if (!locked) { console.warn('SYNC_SKIP_LOCKED tenant=' + tenantId); continue; }
try { /* per-tenant sync tx below */ } finally {
  await intel.$queryRawUnsafe(`SELECT pg_advisory_unlock(hashtext($1))`, `intel_sync_wl:${tenantId}`);
}
```

**Watchlist identity/idempotency = ONE scheme (deterministic `wl:<clientId>` id).** The watchlist head is upserted **by id** (`wl:<clientId>`); there is **no** natural-key ON-CONFLICT and **no** `UNIQUE(tenant_id, client_id)` constraint (that s5 proposal is dropped — see §3.1). Hearing watchlists carry cuid ids and therefore never collide with the `wl:` prefix; the invariant is restated below.

**Idempotency keys (all upserts, so re-run = no-op):**

| Source row | Target | Upsert key | Notes |
|---|---|---|---|
| `client_watchlist` (1/client) | `intel_watchlist` | **deterministic id** `wl:<clientId>` (upsert-by-id; NO unique-on-`(tenant_id,client_id)`, NO ON-CONFLICT-on-natural-key) | `name='Watchlist'`, `active=true`, `created_by = client_watchlist.updated_by ?? 'legacy-sync'` (createdBy is NOT NULL), `issue_areas = client_watchlist.issue_areas`. Topics/terms rebuilt inside one tx (below). |
| each `tags[]` object | `intel_watchlist_topic` | `(watchlist_id, label)` | `issue_area = normalizeIssueArea(tag.issueArea)`, `position = tag.position ?? 'monitor'`, `priority = tag.priority ?? 'med'` |
| each `tag.synonyms[]` | `intel_watchlist_term` | `(topic_id, term_type='synonym', value)` | |
| each `tag.relatedEntities[]` | `intel_watchlist_term` | `(topic_id, term_type='entity', value)` | |
| each `tag.riskTerms[]` | `intel_watchlist_term` | `(topic_id, term_type='risk', value)` | **`risk`, not `risk_phrase`** (registry §5; supersedes any s5 `risk_phrase` mapping). |
| `alert_preference` (unique `[user_id,client_id]`) | `intel_alert_preference` | `(user_id, client_id)` | 1:1, every column carries over (§5). Verb `backfill-alert-prefs`. |
| `tracked_bill` (unique `[client_id,bill_id]`) | `intel_tracked_bill` | `(client_id, bill_id)` | copy note, source, created_by→tracked_by, lastSeen* verbatim; `is_manual = (source='manual_search')`. Verb `backfill-tracked-bills`. |
| `notification_log` (optional/audit) | `intel_notification_log` | `(alert_id, user_id, channel)` | copy only if migrating history; **must** preserve unique key (§6 idempotency) |

**tags-JSON → topics+terms expansion (pseudo, per watchlist, inside advisory lock + `intel.$transaction`):**
```ts
// verb: sync-watchlists-from-legacy [tenantSlugOrId]
// tenantFilter resolves slug→uuid via `tenants` first (reuse the enable-feature resolver).
for (const cw of await rawQuery(`SELECT client_id, tenant_id, issue_areas, tags, updated_by
                                 FROM client_watchlist ${tenantFilter}`)) {
  const wlId = `wl:${cw.client_id}`;               // deterministic stable id (the ONE identity scheme)
  await tx.watchlist.upsert({
    where: { id: wlId },                           // upsert-by-id; NO ON CONFLICT (tenant_id, client_id)
    create: { id: wlId, tenantId: cw.tenant_id, clientId: cw.client_id,
              name: 'Watchlist', createdBy: cw.updated_by ?? 'legacy-sync',
              issueAreas: cw.issue_areas ?? [] },
    update: { issueAreas: cw.issue_areas ?? [], updatedAt: new Date() },
  });
  // faithful re-sync: wipe legacy-owned topics/terms for THIS watchlist, then rebuild.
  // cascade FK deletes child terms; hearing terms (topic_id NULL) live on DIFFERENT rows.
  await tx.watchlistTopic.deleteMany({ where: { watchlistId: wlId } });
  for (const tag of (cw.tags as Tag[]) ?? []) {
    const topic = await tx.watchlistTopic.create({ data: {
      watchlistId: wlId, tenantId: cw.tenant_id, label: tag.tag,
      issueArea: tag.issueArea ? normalizeIssueArea(tag.issueArea) : null,
      position: tag.position ?? 'monitor', priority: tag.priority ?? 'med' }});
    const rows = [
      ...(tag.synonyms ?? []).map(v => ({ termType: 'synonym', value: v })),
      ...(tag.relatedEntities ?? []).map(v => ({ termType: 'entity', value: v })),
      ...(tag.riskTerms ?? []).map(v => ({ termType: 'risk', value: v })),   // 'risk' (NOT 'risk_phrase')
    ].filter(r => r.value && r.value.trim().length >= 3);   // MIN_TERM_LEN=3 (§6)
    if (rows.length)
      await tx.watchlistTerm.createMany({ data: rows.map(r => ({
        watchlistId: wlId, tenantId: cw.tenant_id, topicId: topic.id, ...r })) });
  }
}
```
> `deleteMany`+rebuild per watchlist inside the tx makes re-runs **faithful to current legacy tags** AND idempotent (identical tags → identical rows). During shadow, all topics on a `wl:<clientId>` row are legacy-derived (Configure still writes apps/api — D6). **Hearing-authored terms are never touched:** hearing watchlists were created by the hearing UI with their own cuid ids (not the `wl:` prefix), so `deleteMany({ watchlistId: 'wl:…' })` never reaches them. Document the invariant: **tracker watchlists use id prefix `wl:`; hearing watchlists use cuid ids** — the two never collide on the same row, and because identity is the `wl:` id (not a `(tenant_id, client_id)` unique), a hearing watchlist for the same client can coexist without constraint conflict. When a verb must distinguish, filter `WHERE id LIKE 'wl:%'`.

`normalizeIssueArea` / `issueAreaForSector` / `ISSUE_AREAS` come from `@capiro/shared` (verified exports at `packages/shared/src/index.ts`; the only shared deps `tracker.service.ts` uses). Confirm `@capiro/shared` is built before the intel image (worktree build gotcha) — the Dockerfile already runs `pnpm --filter @capiro/shared build` before `prisma generate`, so this holds for the container path.

### 3.4 Backfill verification queries (post-run, per tenant)

Run as a `diag-*` one-off task (registry infra: only working path for ad-hoc read-only prod SQL) or in the scratch DB after a dry run.

```sql
-- (A) watchlist row-count parity: one intel_watchlist per client_watchlist
SELECT
  (SELECT count(*) FROM client_watchlist WHERE tenant_id = :t) AS legacy_watchlists,
  (SELECT count(*) FROM intel_watchlist  WHERE tenant_id = :t AND id LIKE 'wl:%') AS unified_watchlists;
-- EXPECT: equal.  (id LIKE 'wl:%' isolates tracker watchlists from hearing cuid-id rows.)

-- (B) topic fan-out parity: unified topic count == sum of tags[] length
SELECT
  (SELECT coalesce(sum(jsonb_array_length(tags)),0) FROM client_watchlist WHERE tenant_id=:t) AS legacy_tags,
  (SELECT count(*) FROM intel_watchlist_topic WHERE tenant_id=:t) AS unified_topics;
-- EXPECT: equal (assumes every tag row has a non-null tags array; NULL tags → 0).

-- (C) alert-pref parity
SELECT
  (SELECT count(*) FROM alert_preference WHERE tenant_id=:t) AS legacy_prefs,
  (SELECT count(*) FROM intel_alert_preference WHERE tenant_id=:t) AS unified_prefs;
-- EXPECT: equal.

-- (D) tracked-bill parity
SELECT
  (SELECT count(*) FROM tracked_bill WHERE tenant_id=:t) AS legacy_tracked,
  (SELECT count(*) FROM intel_tracked_bill WHERE tenant_id=:t) AS unified_tracked;
-- EXPECT: equal.

-- (E) re-run no-op proof: content hash of legacy-derived terms is stable across runs.
--     (delete+rebuild resets created_at, so assert content hash, not timestamps.)
--     term_type for riskTerms is 'risk' (NOT 'risk_phrase') — so this hash never contains 'risk_phrase'.
SELECT md5(string_agg(term_type||'|'||value||'|'||coalesce(topic_id,''), ',' ORDER BY term_type, value, topic_id))
FROM intel_watchlist_term wt
JOIN intel_watchlist w ON w.id = wt.watchlist_id AND w.id LIKE 'wl:%'
WHERE wt.tenant_id = :t;
-- EXPECT: identical md5 across two consecutive runs with unchanged legacy tags.

-- (F) term_type sanity: tracker-derived terms use ONLY synonym|entity|risk (never risk_phrase)
SELECT term_type, count(*) FROM intel_watchlist_term wt
JOIN intel_watchlist w ON w.id = wt.watchlist_id AND w.id LIKE 'wl:%'
WHERE wt.tenant_id = :t AND wt.topic_id IS NOT NULL
GROUP BY term_type;
-- EXPECT: term_type ∈ {synonym, entity, risk} only; zero rows with term_type='risk_phrase'.
```

### 3.5 RLS / DB role for cross-DB reads (registry §4 UNVERIFIED — resolved here)

**Confirmed:** apps/api tenant-scoped tables (`clients`, `context_embeddings`, and the tracker source tables `client_watchlist`/`alert_preference`/`tracked_bill`) enforce **Postgres RLS** (primary isolation). intel-api has **no** `withTenant`/`withSystem`/`SET app.current_tenant_id` plumbing (grep = zero matches). The live `enable-feature` verb reads the RLS-free `tenants` table successfully — but that does **not** establish read access to RLS tables. Two distinct problems:

1. **`context_embeddings` NULL-tenant globals + `source_type='bill'` rows.** RLS policy per registry = `tenant_id IS NULL OR tenant_id = current_tenant_id`. Bill embeddings are written by apps/api; their tenant_id determines whether intel-api can read them without a session var. **Gate (`diag-*`):** `SELECT count(*), count(*) FILTER (WHERE tenant_id IS NULL) FROM context_embeddings WHERE source_type='bill' AND model='amazon.titan-embed-text-v2:0';` — if the two counts are equal (all global), the semantic leg works under any role that satisfies `tenant_id IS NULL`, no session var. If bill embeddings are tenant-scoped, intel-api's role must be RLS-exempt or set the session var (below).

2. **Which DB role does intel-api connect as?** intel-api composes `DATABASE_URL` from `capiro/{env}/aurora/master` + `.../app` (registry §2). **Gate (`diag-*`):** `SELECT current_user, rolbypassrls FROM pg_roles WHERE rolname = current_user;` plus a positive/negative RLS probe: `SELECT count(*) FROM client_watchlist WHERE tenant_id=:t` (must be non-zero for a populated pilot tenant) and the same for a foreign tenant (must be zero unless bypass).
   - If intel-api's role **== apps/api's role** OR **has `BYPASSRLS`** → cross-DB reads of `clients`/`context_embeddings`/`client_watchlist`/… work directly; no session var. (Registry §1 says intel-api SHARES the api **task role** — that is the *IAM* role, NOT necessarily the *DB* role; the DB role is whatever the aurora secret resolves to. Verify separately.)
   - If a **distinct, non-bypass role** → subject to the same policies, reads **zero** tenant-scoped rows. Fix, in priority: (a) connect intel-api as the same DB role apps/api uses (simplest, no schema change), or (b) before each scoped raw query, `SELECT set_config('app.current_tenant_id', :tenantId, true)` in the same tx (mirror apps/api `withTenant`), or (c) grant the intel role `BYPASSRLS` + app-code tenant filtering (least safe; only if (a)/(b) blocked).

   `congress_bill`/`state_bill`/`*_action`/`bill_text` are GLOBAL/RLS-free (registry §4) — no session var ever.

**Decision recorded:** default to **(a) same DB role as apps/api**, making RLS a non-issue for `clients`/`client_watchlist`/`alert_preference`/`tracked_bill` and letting NULL-tenant `context_embeddings` reads work. Add the `set_config` wrapper (b) **only if** the aurora `app` secret resolves to a distinct restricted role. **This is a hard gate: SC-8 must pass before the backfill (§3.3) and before Phase 3 (semantic leg) are trusted** — the backfill silently writing zero rows under a restricted role is the primary failure mode here.

### 3.6 Success criteria

Each is independently verifiable; owner + command + threshold + gate stated. All measured against **arm64** images (prod Fargate is ARM64).

| # | Criterion | Verifier / command | Threshold / expected | Gate it unblocks |
|---|---|---|---|---|
| SC-1 | **Migrations apply clean on a scratch DB** | Release eng: `pnpm exec prisma migrate deploy` against a fresh empty `capiro_scratch` (127.0.0.1), M1→M4 in order | Exit 0; `prisma migrate status` = "Database schema is up to date"; `\dt intel_*` shows new tables `intel_watchlist_topic, intel_tracked_bill, intel_alert, intel_alert_preference, intel_notification_log, intel_alert_digest_queue, intel_feedback`; `\d intel_watchlist` shows `issue_areas` **and NO new `client_id`/`source_hash`/`updated_by` column and NO `UNIQUE(tenant_id, client_id)`**; `\d intel_watchlist_term` shows `topic_id` | Phase 2 build |
| SC-2 | **Non-destructive proof: existing hearing data survives** | Release eng: on a scratch DB seeded with a hearing `intel_watchlist` + terms (cuid ids, `topic_id` NULL) + one `intel_watchlist_match`, run M1→M4 | Pre/post `count(*)` of `intel_watchlist_term` unchanged; all pre-existing terms still `topic_id IS NULL`; `intel_watchlist_match` count unchanged; hearing watchlist keeps its cuid id (no `wl:` collision) | Phase 2 build |
| SC-3 | **Migrate task runs clean on dev then prod** | Release eng: `aws ecs run-task --cluster capiro-dev --task-definition capiro-dev-intel-api-migrate` (container `intel-api-migrate`, cmd `['migrate']`); wait STOPPED + exitCode 0; log group `/capiro/dev/intel-api` stream `intel-api-migrate` shows "up to date" and no arm64 engine load error; then repeat on prod (cluster `capiro-prod-os-capiro`, task-def `capiro-prod-intel-api-migrate`, log group `/capiro/prod-os-capiro`) | Both tasks STOPPED, exitCode 0, zero "failed migration" log lines; runs **before** any serve force-new-deployment (registry deploy order: migrate → roll serve) | intel-api serve deploy |
| SC-8 | **RLS/DB-role verified for scoped cross-DB reads** *(prerequisite for SC-4/SC-9 — must pass first)* | Platform eng: `diag-*` task runs `SELECT current_user, rolbypassrls…`; the `context_embeddings` NULL-tenant count query (§3.5 #1); and RLS probes `SELECT count(*) FROM client_watchlist WHERE tenant_id=:pilot` (non-zero) + `…=:foreign` (zero unless bypass) | Either intel DB role == api DB role / `rolbypassrls=true` (probe returns pilot rows, foreign zero), **or** the `set_config('app.current_tenant_id')` wrapper is added and the probe passes. Zero rows under a restricted role = FAIL | Backfill (SC-4) + Phase 3 semantic trust |
| SC-4 | **Backfill produces exact row-count parity vs legacy** | Release eng: run verbs `sync-watchlists-from-legacy <tenant>` + `backfill-tracked-bills <tenant>` + `backfill-alert-prefs <tenant>` (via run-task override), then §3.4 (A)(C)(D) as a `diag-*` task | (A) legacy_watchlists == unified_watchlists (with `id LIKE 'wl:%'`); (C) legacy_prefs == unified_prefs; (D) legacy_tracked == unified_tracked — **exact equality** per pilot tenant | Phase 5 parity / per-tenant cutover |
| SC-5 | **tags-JSON fan-out is faithful (and term_type is canonical)** | Release eng: §3.4 (B) + a term-count spot check (Σ synonyms+entities+risk with len≥3 vs `count(*) FROM intel_watchlist_term WHERE watchlist_id LIKE 'wl:%'`) + §3.4 (F) | unified_topics == Σ `jsonb_array_length(tags)`; term count matches the len≥3 sum; §3.4 (F) shows tracker terms are ONLY `synonym|entity|risk` with **zero `risk_phrase`** | Cutover per tenant |
| SC-6 | **Re-run is a no-op** | Release eng: run each backfill verb **twice**; compare §3.4 (E) md5 across runs; grep task logs for duplicate-key errors | Identical md5 both runs (unchanged legacy tags); `intel_watchlist`/`intel_alert_preference`/`intel_tracked_bill` counts unchanged; zero P2002/duplicate-key errors; two overlapping runs → one logs `SYNC_SKIP_LOCKED` (advisory lock held) | Scheduled shadow sync (safe on cron) |
| SC-7 | **Cross-DB contract test asserts read columns exist** | CI (jest via tsx per infra jest gotcha): a `SourceDataRepository` contract test issues `SELECT <col>,… FROM <table> LIMIT 0` for every read table/column in registry §4 (congress_bill.id/latestActionText/peCodes/subjects; congress_bill_action.billId/date/text; context_embeddings.embedding/source_type/model/tenant_id; clients.ldaClientIds/issueCodes) plus the backfill source cols (client_watchlist.tags/issue_areas/updated_by; tracked_bill.*; alert_preference.*) | All `LIMIT 0` selects succeed (no `42703 undefined_column`); test fails loudly if apps/api renames a column | Merge to main (blocks Phase 3) |
| SC-9 | **Semantic leg returns ranked bills** | Eng: one-off task runs the §6 cosine SQL with a test query vector against `context_embeddings WHERE source_type='bill'` (after SC-8 passes) | Returns ≥1 row with `score ≥ EMBED_CANDIDATE_FLOOR (0.3)`, ordered desc, `LIMIT 400` respected | Recommendation endpoint |

**Rollback for the data layer:** all migrations are additive → rollback is *not* a down-migration (forward-only). If a new table/column is bad, ship a follow-up additive migration; never `DROP`/`RENAME` an applied one on the shared prod Aurora. The backfill writes only `intel_*` rows and never touches apps/api tables (D2), so aborting mid-backfill leaves legacy fully intact and the legacy tracker (`/api/intelligence/…`, gated off `tracker_v2`) keeps serving (D4/D6). Advisory-lock skips (SC-6) mean a re-run after an abort is safe and self-healing.

---

## 4. Phase 1 — intel-api foundations

> **Role of this phase (enabler, ~3–4 d).** Give `apps/intel-api` the two capabilities the whole migration rests on: (a) **query-side embeddings** (turn a text query into a Titan vector) and (b) **read-only cross-DB access** to the apps/api-owned `congress_bill` / `context_embeddings` tables. Phase 1 ALSO **ports the RLS session helpers `withTenant`/`withSystem` into intel-api** (see §4.2 and the phase-boundary note below) so that later phases have the tenant-context primitives they depend on. No `intel_*` schema changes, no delivery, no watchlist, no ALB rule, no new secret. Preserves plan §3 Phase 1 intent (`SourceDataRepository`, Bedrock query-only, one-off verb runner) and expands it into deployment-grade steps. Aligns with the strangler/shadow model: Phase 1 is **shadow, read-only** — the legacy `/api/intelligence/.../tracker/*` path (single sender of alerts/writes) remains the sole authority; intel-api neither writes apps/api tables (D2) nor sends anything. Respects the arm64 build rule (registry §1 build command).
>
> **Phase-boundary ownership of the RLS helpers (RESOLVED — read before Phase 3).** s6 §6.0's T0 makes `withTenant`/`withSystem` a hard prerequisite that blocks Phase 3 (match engine needs `withSystem` for cross-tenant detection and `withTenant` for scoped reads). Rather than leave the port unowned, **Phase 1 delivers the `withTenant`/`withSystem` helpers** (step 8 below) as inert, unit-tested primitives. Phase 1 itself does NOT exercise them at runtime — all Phase-1 reads are GLOBAL/NULL-tenant and set no tenant context — but shipping them here means s6's T0 dependency is already satisfied when Phase 3 starts, and §4.2's `getClient` stub can reference a real (already-ported) helper. **s6 must treat T0's `withTenant`/`withSystem` requirement as delivered by Phase 1**, not re-scoped to Phase 2.
>
> **Canonical one-off / verb-dispatch task-def family (RESOLVED — use verbatim).** Inventory of the registered one-off task-def families under `infra/deploy/` (verified this session): `capiro-dev-intel-api-oneoff` (a bespoke inline `node -e` seeder — NOT a clean verb runner), `capiro-dev-intel-api-enableflag` (the verb-runner analog: `command:["enable-feature", …]`, container `intel-api-enableflag`, clean DB-only secrets, ARM64, shared roles), `capiro-dev-intel-api-migrate` (migrate verb), and `capiro-dev-intel-api-serve` (serve). **There is NO `capiro-dev-intel-api-task` family** — earlier drafts invented one. The canonical family for verb dispatch (including the Phase-1 `verify-sourcedata` verb) is **`capiro-dev-intel-api-enableflag`** (prod: `capiro-prod-intel-api-enableflag`), container name **`intel-api-enableflag`**. Phase 1 EXTENDS this existing verb runner with a new `task <verb>` arm rather than creating a new family. All of s2/s4/s6/s7 now use this single family + container name; the registry §1 one-off run-task example (which dispatches `enable-feature`) is consistent with reusing the verb runner.

>
> **Verified against the codebase during authoring (supersedes registry UNVERIFIED rows where noted):**
> - **Bedrock IAM is already present on the shared task role.** `infra/cdk/lib/compute-stack.ts:342-344` grants `bedrock:InvokeModel` on `arn:aws:bedrock:us-east-1::foundation-model/amazon.titan-embed-text-v2:0`, attached to `apiTaskRole`. intel-api SHARES this role (`…ApiTaskRole12FAD4A7-szq3QeeZJSCQ`) → **no IAM change needed for Titan query embeddings.** ⚠️ The inline comment at `compute-stack.ts:337-341` names ONLY `apps/api/scripts/embed-backfill.ts` as the consumer; update that comment to also name intel-api so a future scope-tightening of the statement doesn't silently break intel-api. Claude-on-Bedrock (summaries) is NOT granted and is OUT of Phase 1 (deferred; needs a policy widen).
> - **Query-side exports in `apps/api/src/embeddings/embedder.ts`:** `EMBEDDING_MODEL` (`process.env.EMBEDDINGS_MODEL ?? 'amazon.titan-embed-text-v2:0'`), `EMBEDDING_DIM = 1024`, `REGION` (`process.env.AWS_REGION_DEFAULT ?? 'us-east-1'`, module-private), `MAX_INPUT_CHARS = 8000`, `getBedrock()` (module-private, cached client), `normalize()`, `vectorLiteral()`, `embedText()`. Do NOT copy `sha256`, `embedAndUpsert`, or the `EmbedAndUpsertArgs`/`EmbedOutcome` types (write path, stays in apps/api per D1). **Line numbers are volatile — copy by symbol name, not by line range.**
> - **`entrypoint.sh` dispatches `serve | migrate | enable-feature`** (verified: three-arm `case`, default `serve`). It does NOT dispatch a generic `task` verb yet — adding one is a small extension. **Existing verbs run inline `node -e "…"` against the generated Prisma client `require('./generated/prisma-client')`** — they do NOT `exec` a compiled dist script. Any new verb-runner file MUST be emitted into the image's `dist/` by the build and imported the same way (see step 4).
> - **intel-api's Prisma client is the generated client, not `@prisma/client`.** `apps/intel-api/src/prisma/prisma.service.ts` imports `../../generated/prisma-client/index.js`. Raw SQL goes through `PrismaService` (`$queryRawUnsafe` / `$queryRaw`), same as the `enable-feature` verb.
> - **The correct task-def clone source is `infra/deploy/intel-api-enableflag-taskdef.json`, NOT `intel-api-oneoff-taskdef.json`.** enableflag is the verb-runner analog: container name `intel-api-enableflag`, `command` as a string array, real resolved secret ARNs, ARM64, cpu 512 / mem 1024, shared task+exec roles. (`intel-api-oneoff-taskdef.json` exists but is a bespoke inline-`node -e` seeder — not the right shape for a verb runner, and NOT the family Phase 1 extends.)
> - **DB role is `capiro_app` (least-privilege, RLS-enforced), NOT master.** enableflag/serve task-defs source host/port/dbname from `capiro/dev/aurora/master` and username/password from `capiro/dev/aurora/app`. So even Phase-1 reads run under the RLS-subject app role — see the RLS note below.
> - **Still UNVERIFIED (must confirm before running):**
>   - Phase 1 reads ONLY GLOBAL/NULL-tenant rows (`congress_bill`, `context_embeddings WHERE tenant_id IS NULL`), so no per-query tenant context is set even though the `withTenant`/`withSystem` helpers are now ported. **Because reads run as `capiro_app`, you MUST confirm the RLS policy on `context_embeddings` actually admits `tenant_id IS NULL` rows to a session with no `app.current_tenant_id` set** (registry §4: policy is `tenant_id IS NULL OR tenant_id = current_tenant_id`; if `current_tenant_id` is unset/empty the second disjunct must not error). S6's live verify task is the gate that proves this. Tenant-scoped reads (`clients`) remain a Phase 3 concern even though the helpers exist.
>   - **PROD intel-api service name** (registry §1 UNVERIFIED — likely `capiro-prod-intel-api` on cluster `capiro-prod-os-capiro`). Confirm before any prod run-task / rollback (`aws ecs list-services --cluster capiro-prod-os-capiro`).

### 4.1 Build steps (ordered, idempotent)

| # | Step | Files / commands | Notes / guard |
|---|------|------------------|---------------|
| 1 | Add Bedrock SDK dep to intel-api | `apps/intel-api/package.json` → add `"@aws-sdk/client-bedrock-runtime"` **pinned to the exact version already in `apps/api/package.json`** (avoid a second SDK copy / drift); `pnpm install -w` at repo root. This updates `pnpm-lock.yaml`, which is a CI trigger path for `.github/workflows/intel-api-image.yml`. | Idempotent: re-running install is a no-op if the version matches. Verify only ONE `@aws-sdk/client-bedrock-runtime` resolves (`pnpm why @aws-sdk/client-bedrock-runtime`). |
| 2 | Copy **query-side** embeddings into intel-api | New `apps/intel-api/src/embeddings/embedder.ts` containing ONLY `EMBEDDING_MODEL`, `EMBEDDING_DIM`, `REGION`, `MAX_INPUT_CHARS`, `getBedrock()`, `normalize()`, `vectorLiteral()`, `embedText()` — copied **by symbol** from `apps/api/src/embeddings/embedder.ts`. **Omit** `sha256`, `embedAndUpsert`, `EmbedAndUpsertArgs`, `EmbedOutcome`, and the `import type { PrismaClient }` (write/ingestion side; D1). | No `PrismaClient` import (the copied query fns don't use it). Reads env `EMBEDDINGS_MODEL`, `AWS_REGION_DEFAULT` at module load — both set explicitly on the task-def (step 5). |
| 3 | Build `SourceDataRepository` | New `apps/intel-api/src/sourcedata/source-data.repository.ts` (Nest `@Injectable`, injects `PrismaService`) — the single audited home for cross-schema raw SQL (§4.2). Uses `this.prisma.$queryRawUnsafe`/`$queryRaw` (same generated client the `enable-feature` verb uses). | READ-ONLY. Never `$executeRaw*` against apps/api tables (D2 — enforced by S8). All scalar params bound (`$1,$2,…`); the only interpolated value is the pgvector literal, which is self-generated floats from `vectorLiteral` (no injection surface — same rationale as the upstream embedder comment). |
| 4 | Add `task <verb>` runner mode to the entrypoint | Extend `apps/intel-api/scripts/entrypoint.sh` `case` with a `task)` arm mirroring `enable-feature`: `FEATURE`-style positional args, `exec node dist/scripts/task-runner.js "${2:?verb required}" "${@:3}"`. New `apps/intel-api/src/scripts/task-runner.ts` (a) instantiates the generated Prisma client (`require('../../generated/prisma-client')` at runtime resolves to `dist/generated/…` — confirm the Dockerfile copies `generated/` into the image and that the build emits `dist/scripts/task-runner.js`), (b) maps verb → handler. Phase 1 verb: **`verify-sourcedata`** (§4.5). | Keep `set -e`, the `DATABASE_URL` composition block, and `: "${TMPDIR:=/dev/shm}"` (avoids the tsx/compile TMPDIR crash) already at the top of the script. Unknown verb → non-zero exit + usage line (extend the existing `*)` message to list `task`). |
| 5 | Extend the canonical verb-runner task-def with the `task` command | Update **`infra/deploy/intel-api-enableflag-taskdef.json`** (dev) + `infra/deploy/intel-api-prod-enableflag-taskdef.json` (prod) — family **`capiro-dev-intel-api-enableflag`** / `capiro-prod-intel-api-enableflag`, container **name `intel-api-enableflag`**. The `command` is overridden per-run via `containerOverrides` (e.g. `["task","verify-sourcedata","<billId>"]`), so the baked `command` can stay `["enable-feature", …]`; do NOT fork a new `-task` family. Keep `runtimePlatform.cpuArchitecture=ARM64`, `cpu 512 / memory 1024`, `taskRoleArn=…ApiTaskRole12FAD4A7-szq3QeeZJSCQ`, `executionRoleArn=…ApiTaskDefExecutionRoleE6ABB053-YlEDKuUPHjLg`, and the SAME real secret ARNs (host/port/dbname from `capiro/dev/aurora/master`, username/password from `capiro/dev/aurora/app` → confirms the `capiro_app` RLS-subject role). | **Fix the log group** — the enableflag task-def currently logs to `/capiro/dev/api` (verified). Update it to `awslogs-group=/capiro/dev/intel-api`, `awslogs-stream-prefix=intel-api-enableflag` (registry §1). Env: `DB_NAME=capiro`, `EMBEDDINGS_MODEL=amazon.titan-embed-text-v2:0`, `AWS_REGION_DEFAULT=us-east-1` (set explicitly for clarity even though the code defaults). Secrets = DB_* only. Prod variant: prod secret namespace `capiro/prod-os-capiro/*`, log group `/capiro/prod-os-capiro`. |
| 6 | Register the updated task-def | `aws ecs register-task-definition --cli-input-json file://infra/deploy/intel-api-enableflag-taskdef.json --region us-east-1` (dev), then prod variant. | Capture the returned `revision` for rollback (§4.5). Idempotent: re-register produces a new revision; run-task pins the revision you pass (or `:latest` of the family). |
| 7 | **No exec-role change for Phase 1** | The exec-role inline policy (`infra/deploy/intel-api-execrole-inline-policy.json`) grants ECR pull + Secrets read for the intel-api + DB secrets — sufficient for a DB-only task-def. Bedrock is a **task-role runtime** permission and is ALREADY present (verified, `compute-stack.ts:342`). | Do NOT add `bedrock:*` to the EXEC role — Bedrock is called with task-role creds at runtime, not by the ECS agent at launch. |
| 8 | **Port the RLS session helpers `withTenant` / `withSystem`** | New `apps/intel-api/src/prisma/rls.ts` (or extend `PrismaService`) mirroring apps/api's `prisma.withTenant(tenantId, tx=>…)` (sets `app.current_tenant_id` for the transaction) and `prisma.withSystem(tx=>…)` (cross-tenant/RLS-exempt path). Port by symbol from apps/api's Prisma extension; adapt to the generated client (`../../generated/prisma-client`). **Ships inert in Phase 1** — no Phase-1 read path calls them (all Phase-1 reads are GLOBAL/NULL-tenant, no tenant context set). | Satisfies s6 §6.0 T0's hard prerequisite for Phase 3 (match engine). Unit-test both helpers (S3). §4.2 `getClient` references these helpers in its TODO but stays a stub until Phase 3 (tenant-scoped reads are a Phase 3 concern by design). **UNVERIFIED — confirm the exact session-var name + SET syntax the apps/api RLS policies read before wiring live in Phase 3.** |

**Connection-pool note (serve is untouched, but be explicit):** Phase 1 adds NO new serve routes and NO new serve-side DB connections; the verify verb runs in a **separate one-off task** (the `capiro-dev-intel-api-enableflag` family with a `task` command override) with its own short-lived client that `$disconnect()`s on exit (mirror the `enable-feature` verb's `finally`/`.catch` + `process.exit`). So there is zero pool impact on the running `capiro-dev-intel-api` service. Bedrock calls hold open HTTP connections (see `compute-stack.ts:978` comment) but only within the one-off task's lifetime. The ported `withTenant`/`withSystem` helpers add no connections (they only issue `SET`/`SET LOCAL` inside an existing tx) and are not invoked at all in Phase 1.

### 4.2 `SourceDataRepository` — exact read methods + SQL

All GLOBAL / NULL-tenant reads. No RLS context is set (the ported `withTenant` is NOT called in Phase 1); correctness depends on the `context_embeddings` RLS policy admitting NULL-tenant rows to a no-tenant session — proven live by S6, not assumed.

| Method | Returns | SQL (bound params) |
|--------|---------|--------------------|
| `getBillById(id: string)` | one `congress_bill` row or null | `select id, congress, bill_type, bill_number, title, latest_action_text, latest_action_date, policy_area, subjects, pe_codes, url from congress_bill where id = $1` |
| `getBillActions(billId: string)` | `congress_bill_action[]` newest-first | `select id, bill_id, date, text, type, chamber from congress_bill_action where bill_id = $1 order by date desc` (uses index `[billId,date]`) |
| `getBillSubjects(billId)` / `getBillCommittees(billId)` | `congress_bill_subject` / `congress_bill_committee` rows | `select name from congress_bill_subject where bill_id = $1`; `select committee_name, committee_code, chamber from congress_bill_committee where bill_id = $1` |
| **`semanticBillScores(queryVector, model, floor)`** | `{ sourceId, score }[]` cosine-ranked | The registry §6 query VERBATIM (below) |
| `getClient(clientId)` | **NOT IMPLEMENTED in Phase 1** — `clients` is TENANT-SCOPED/RLS; the `withTenant` helper is now ported (§4.1 step 8) but tenant-scoped reads are deferred to Phase 3 by design | Leave a commented stub + `// TODO(Phase 3): wrap in withTenant(tenantId) — the helper is already ported in Phase 1, but without a resolved tenant context RLS returns zero rows under capiro_app.` Do NOT ship a live method that silently returns `[]`. |

**`semanticBillScores` SQL (registry §6, verbatim):**
```sql
SELECT ce.source_id, (1 - (ce.embedding <=> $1::vector))::float8 AS score
FROM context_embeddings ce
WHERE ce.source_type = 'bill' AND ce.model = $2
  AND ce.embedding IS NOT NULL
  AND (1 - (ce.embedding <=> $1::vector)) >= $3
ORDER BY ce.embedding <=> $1::vector
LIMIT 400;
```
`$1` = `vectorLiteral(await embedText(query))` (1024-dim `[v0,…,v1023]`), `$2` = `EMBEDDING_MODEL`, `$3` = `EMBED_CANDIDATE_FLOOR = 0.3`. `context_embeddings` bill rows are NULL-tenant globals; S6 proves this read succeeds from the `capiro_app` role with no tenant context.

### 4.3 One-off verification task — dev, then prod

Discover network config from the live api service instead of hardcoding (registry marks explicit subnets/SGs UNVERIFIED). Mirror the auto-discovery in `scripts/deploy-ingestion-out-of-band.sh`:

```bash
# 1) discover network config from the live api service (dev cluster)
NET=$(aws ecs describe-services --cluster capiro-dev \
  --services capiro-dev-api --region us-east-1 \
  --query 'services[0].networkConfiguration.awsvpcConfiguration' --output json)
SUBNETS=$(echo "$NET" | jq -c '.subnets'); SGS=$(echo "$NET" | jq -c '.securityGroups')

# 2) run the verify verb against a REAL congress_bill id, capturing the task ARN
#    (canonical verb-runner family: capiro-dev-intel-api-enableflag; container: intel-api-enableflag)
TASK_ARN=$(aws ecs run-task --cluster capiro-dev --launch-type FARGATE \
  --task-definition capiro-dev-intel-api-enableflag --region us-east-1 \
  --network-configuration "awsvpcConfiguration={subnets=$SUBNETS,securityGroups=$SGS,assignPublicIp=DISABLED}" \
  --overrides 'containerOverrides=[{name=intel-api-enableflag,command=["task","verify-sourcedata","119-hr-1"]}]' \
  --query 'tasks[0].taskArn' --output text)

# 3) wait for STOPPED, then assert exit code 0
aws ecs wait tasks-stopped --cluster capiro-dev --tasks "$TASK_ARN" --region us-east-1
aws ecs describe-tasks --cluster capiro-dev --tasks "$TASK_ARN" --region us-east-1 \
  --query 'tasks[0].containers[0].exitCode'   # MUST print 0
```

**Concurrency/idempotency:** `verify-sourcedata` is a pure read — it takes no locks, writes nothing, and is safe to run repeatedly and concurrently. No job-locking needed in Phase 1 (locking becomes relevant only for the detection/flush verbs in later phases).

**Prod:** same shape with `--cluster capiro-prod-os-capiro`, `--task-definition capiro-prod-intel-api-enableflag`, container override `name=intel-api-enableflag`, and `--services <PROD_INTEL_OR_API_SVC>` for discovery — **confirm the exact prod service name first** (registry §1 UNVERIFIED; `aws ecs list-services --cluster capiro-prod-os-capiro`). A read-only verify task rolls no service, so the registry §1 "migrate-before-serve" ordering is trivially satisfied (nothing to roll).

`verify-sourcedata <billId>` handler does exactly: (1) `getBillById(billId)` → `BILL_OK id=… title="…"`; (2) build query text from the bill title, `embedText()` it → `EMBED_OK dim=1024 model=…`; (3) `semanticBillScores(vectorLiteral(vec), EMBEDDING_MODEL, 0.3)` → print top-10 `source_id`+score. On any throw: log the error and `process.exit(1)` (mirrors `enable-feature`'s `.catch(e => { console.error(...); process.exit(1); })`); always `$disconnect()` in `finally`.

### 4.4 Expected output (the pass signal)

```
BILL_OK id=119-hr-1 title="…"
EMBED_OK dim=1024 model=amazon.titan-embed-text-v2:0
SEMANTIC_TOP:
  119-hr-1        1.0000
  119-s-45        0.83xx
  118-hr-2210     0.79xx
  … (≥1 row, all score ≥ 0.30, descending)
```
The self-match (`119-hr-1 ≈ 1.0000`) appears ONLY if that bill was already embedded by the apps/api ingestion writer; if the bill isn't yet in `context_embeddings`, the top rows are its nearest neighbors (≥1 row, all ≥0.30). Either is a PASS as long as ≥1 row returns and exit code is 0.

Verify via CloudWatch: `aws logs tail /capiro/dev/intel-api --since 10m --region us-east-1 --filter-pattern BILL_OK` (prod: `/capiro/prod-os-capiro`) plus the `describe-tasks … exitCode` assertion from §4.3.

### 4.5 Rollback

Phase 1 is additive, shadow, and delivery-free → rollback is per-artifact, no data-plane un-apply:

| Failure | Rollback |
|---------|----------|
| Bad task-def rev | `aws ecs deregister-task-definition --task-definition capiro-dev-intel-api-enableflag:<REV> --region us-east-1`. No service points at it (run-task only), so nothing rolls. Re-register the prior known-good JSON (which restores the original `["enable-feature", …]` baked command + `/capiro/dev/api` log group if you must fully revert). |
| Bad serve image (only if step 1's dep broke the shared image build) | Re-point `:latest` to the prior good `:<GIT_SHA>` and `aws ecs update-service --cluster capiro-dev --service capiro-dev-intel-api --force-new-deployment --region us-east-1`; `aws ecs wait services-stable`. Serve behavior is unchanged by Phase 1 (no new routes/env consumed by serve), so this is only relevant if the added dep broke the build. |
| Dep/build/code breakage | Revert the branch diff (`package.json`, `pnpm-lock.yaml`, `src/embeddings/**`, `src/sourcedata/**`, `src/scripts/task-runner.ts`, `src/prisma/rls.ts`, `scripts/entrypoint.sh`, the enableflag `infra/deploy/*enableflag-taskdef.json` dev+prod). CI (`.github/workflows/intel-api-image.yml`) will not push a new `:latest` until green, so a red build never reaches prod. |

No DB migration, ALB rule, EventBridge rule, SES identity, feature flag, or secret is created in Phase 1 → nothing on the data plane to un-apply, and no interaction with the legacy single-sender path. The ported `withTenant`/`withSystem` helpers are inert code (never invoked in Phase 1) so reverting them has no runtime effect.

### 4.6 Success criteria (measurable, gated, owned)

| # | Criterion | Verifier / command | Threshold / expected | Gate it unblocks | Owner |
|---|-----------|--------------------|----------------------|------------------|-------|
| S1 | Typecheck + build green for intel-api with the Bedrock dep + new modules | `pnpm --filter @capiro/intel-api build && pnpm --filter @capiro/intel-api typecheck` (after `pnpm --filter @capiro/shared build` + `prisma generate`, per worktree gotcha) | exit 0; `dist/main.js` **and `dist/scripts/task-runner.js` both emitted** | Image build | intel-api dev |
| S2 | Single SDK copy (no duplicate `@aws-sdk/client-bedrock-runtime`) | `pnpm why @aws-sdk/client-bedrock-runtime` | exactly one resolved version, matching apps/api | Image build | intel-api dev |
| S3 | Unit tests green | `pnpm --filter @capiro/intel-api test` — add tests: `vectorLiteral` returns `[…]` of length 1024 for a 1024-float input; `normalize` collapses whitespace and caps at `MAX_INPUT_CHARS`; unknown `task` verb exits non-zero; **`withTenant`/`withSystem` issue the expected SET (session-var) statement inside a tx** | exit 0; new embedder + task-runner-usage + RLS-helper tests pass | Merge | intel-api dev |
| S4 | arm64 image builds + actually pulls on Fargate | Registry §1 buildx command (`--platform linux/arm64 … --push`), then run-task per §4.3 | task reaches `STOPPED` with **no `CannotPullContainerError`** (proves arm64 manifest) | Deploy | release eng |
| S5 | Task role can call Bedrock; exec role can pull + read DB secrets; no `AccessDenied` | `aws iam get-role-policy` on `…ApiTaskRole12FAD4A7-szq3QeeZJSCQ` shows `bedrock:InvokeModel` on `…foundation-model/amazon.titan-embed-text-v2:0`; and no `AccessDenied`/`Secret` errors in the S6 task logs | policy statement present (not regressed); zero auth errors in `/capiro/dev/intel-api` | Phase 3 (matching) | release eng |
| S6 | **Core enabler: one-off task reads a real `congress_bill` id, embeds, and returns cosine-ranked ids under the `capiro_app` RLS role** | Run §4.3 `verify-sourcedata 119-hr-1` in **dev** (family `capiro-dev-intel-api-enableflag`, container `intel-api-enableflag`); assert logs (§4.4) + `describe-tasks` exitCode | `BILL_OK` + `EMBED_OK dim=1024` + ≥1 `SEMANTIC_TOP` row, all scores ≥0.30 descending, **container exitCode == 0** (this simultaneously proves NULL-tenant `context_embeddings` is readable with no tenant context) | **Phase 2/3 (watchlist + match engine)** | intel-api dev |
| S7 | Same verify task passes in **prod** | Repeat §4.3 vs `capiro-prod-os-capiro` + `capiro-prod-intel-api-enableflag` (container `intel-api-enableflag`; confirm prod service name first); read `/capiro/prod-os-capiro` | identical pass signal, exitCode 0 | Prod cutover readiness | release eng |
| S8 | **D2 invariant: no apps/api table written** | `grep -rEn '\$executeRaw\|\binsert\b\|\bupdate\b\|\bdelete\b' apps/intel-api/src/sourcedata/` (case-insensitive) | zero matches | Safety sign-off (hard invariant) | reviewer |
| S9 | **Shadow invariant: legacy tracker path untouched** | Confirm no diff under `apps/api/src/tracker/**`, `apps/web/src/pages/clients/tracker/tracker-api.ts`, and no new ALB rule / EventBridge rule / feature-flag row created | zero changes to legacy sender; legacy `/api/intelligence/.../tracker/*` still the sole authority | Strangler compliance | reviewer |
| S10 | **RLS helpers ported for Phase 3 (s6 §6.0 T0)** | `withTenant`/`withSystem` present in `apps/intel-api/src/prisma/` and unit-tested (S3); NOT invoked by any Phase-1 read path (`grep -rn 'withTenant\|withSystem' apps/intel-api/src/sourcedata/` → zero) | helpers exist + tested; zero runtime use in Phase 1 | **Phase 3 (T0 satisfied)** | intel-api dev |

Phase 1 is **done** when S1–S6 and S10 pass in dev and S7 passes in prod; S8 and S9 are hard invariants checked at review time.

---

## 5. Phase 2 — Unified watchlist + legacy sync

> Expands plan Phase 2 (§3, lines 130–137) and decisions **D3** (one unified watchlist drives both bill + hearing matching) and **D6** (source of truth stays `apps/api` in shadow; sync is one-way). Deployment target is `capiro-dev-intel-api` (serve) + `capiro-dev-intel-api-migrate` (migrate/verbs). **Prod service/cluster names are UNVERIFIED — must confirm** (Registry §1: prod cluster likely `capiro-prod-os-capiro`, service likely `capiro-prod-intel-api` / `capiro-prod-os-capiro-intel-api`, migrate task-def `capiro-prod-intel-api-migrate`). Prod Fargate is ARM64; intel-api shares the Aurora `capiro` DB with `apps/api`, reads `apps/api`-owned tables via raw SQL only, and NEVER writes them (D6 invariant).

### 5.0 Naming reconciliation (resolve before migration is written)

The existing plan §2.1 uses **`intel_watchlist` / `intel_watchlist_topic` / `intel_watchlist_term`**; Registry §5 proposes **`intel_topic` / `intel_term`** and notes the existing *hearing* tables are `intel_watchlist` / `intel_watchlist_term` / `intel_watchlist_match`. **These are not reconciled — do not conflate them (Registry §5, UNVERIFIED).**

**Binding decision for this section:** keep the plan's names — `intel_watchlist`, `intel_watchlist_topic`, `intel_watchlist_term` — and **extend** the existing hearing `intel_watchlist` / `intel_watchlist_term` rather than create a parallel `intel_topic`/`intel_term` set (per plan §2.1 migration note, line 75). Registry §5's `intel_topic`/`intel_term` is treated as a naming variant, not a second schema.

> **BLOCKING GATE G0 (owner: intel-api lead):** confirm the live hearing schema column set with a read-only `\d intel_watchlist` and `\d intel_watchlist_term` on dev Aurora (via the `diag-*`-style one-off task path — Registry note `infra_query_prod_db`; direct-connect/Data API are dead) BEFORE the migration is authored. If the existing hearing `intel_watchlist_term` already carries a `term_type` with an incompatible value set, or `intel_watchlist` lacks a per-client shape, escalate — the "extend" decision may not hold and §5.1 step 2 must be rewritten. **Do not write the migration until G0 is closed.**

### 5.0.1 `disable-feature` verb — explicit Phase 2 deliverable (feature-flag OFF path)

Phase 2 **builds a `disable-feature` verb** as a first-class entrypoint command alongside the existing `enable-feature` (Registry §1/§3 sanction `enable-feature <flag> <tenantSlugOrId>` on the `-migrate` task-def; there is no OFF verb today). This closes the previously-UNVERIFIED rollback gap referenced in §5.9 and is depended on by other sections for flag-OFF rollback (s11 §11.0.2/§11.5, s12 §12.6, s13, and the s16 recovery rows) — the existence and ownership of a flag-OFF path is therefore **committed here, not left per-section**.

- **Verb:** `disable-feature <flag> <tenantSlugOrId>` — added to `apps/intel-api/scripts/entrypoint.sh` in the same `serve | migrate | enable-feature` case block (confirmed lines 30–96), mirroring the `enable-feature)` node-invocation pattern (lines 65–95); runs on the `capiro-dev-intel-api-migrate` task-def (DB-only secrets suffice — pure `intel_feature_flag` row mutation).
- **Semantics:** sets the tenant's `intel_feature_flag` row for `<flag>` to disabled (UPDATE `enabled=false`, or DELETE the row) under `prisma.withSystem`. Because `FeatureFlagService.isEnabled` is ALWAYS-on for `CAPIRO_INTERNAL_TENANT_ID` (Registry §3), disabling for the internal tenant is a no-op by design — document that the verb only affects named-slug tenants. Guarded surfaces then **fail CLOSED → 404** (Registry §3), which is the intended rollback state.
- **Documented SQL fallback (equivalent, if the verb is unavailable mid-incident):** `UPDATE intel_feature_flag SET enabled=false WHERE feature='<flag>' AND tenant_id=(SELECT id FROM tenants WHERE slug='<tenantSlugOrId>');` (run via a `diag-*`-style one-off task under the system role). This SQL is the canonical fallback referenced by §5.9, s11 §11.5, s12 §12.6, s13, and the s16 recovery rows.
- **Run shape:**
```bash
aws ecs run-task --cluster capiro-dev --task-definition capiro-dev-intel-api-migrate --launch-type FARGATE \
  --network-configuration 'awsvpcConfiguration={subnets=[...],securityGroups=[...],assignPublicIp=DISABLED}' \
  --overrides 'containerOverrides=[{name=intel-api-migrate,command=["disable-feature","<flag>","<tenantSlugOrId>"]}]'
```
(subnets/SGs **UNVERIFIED — confirm** per Registry §1.)
- **Owner:** intel-api lead (ships with the §5.4 entrypoint changes, since both touch `entrypoint.sh`). Verified by **SC-11**.

### 5.1 Migration (schema, NOT S3)

Registry §5 / plan §2.1 confirm the legacy watchlist lives in the **`client_watchlist` Postgres table**, not S3 — the source of truth is a single JSON-bearing row per client (`ClientWatchlist`, UNIQUE `clientId`, `issue_areas String[]`, `tags Json`). **There is no S3 migration; "migration" here = a forward-only Prisma migration + a DB→DB sync task.** (`apps/api/src/tracker/tracker.service.ts` reads/writes `client_watchlist` via `prisma.withTenant`.)

Additive migration in `apps/intel-api/prisma/schema.prisma`, applied by the standard intel-api **migrate task** (Registry §1: `capiro-dev-intel-api-migrate`, command `['migrate']`; entrypoint `apps/intel-api/scripts/entrypoint.sh:31–59` composes `DATABASE_URL` (URL-encoded pw, `sslmode=require`) then runs `prisma migrate deploy` with auto-rollback of failed migrations; **no seed step** — confirmed the `serve | migrate | enable-feature` case block, lines 30–96).

| Step | Action | Guard / idempotency |
|---|---|---|
| 1 | `\d intel_watchlist` + `\d intel_watchlist_term` on dev Aurora; snapshot existing hearing columns (closes G0) | Read-only; blocks §5.0 decision |
| 2 | Write **additive-only** migration: **extend** `intel_watchlist` (add `client_id uuid NOT NULL`, `enabled_issue_areas text[] not null default '{}'`, `active bool not null default true`, `source_hash text NULL`, `created_by text NULL`, `updated_by text NULL`); add `intel_watchlist_topic`; extend `intel_watchlist_term` with `topic_id uuid NULL`, `term_type` value set (`keyword\|synonym\|entity\|risk_phrase\|bill\|agency\|committee\|legislator\|company\|competitor\|support_language\|opposition_language\|program_element`), `weight float not null default 1.0` | Additive only — new columns NULLable or DEFAULTed so existing hearing rows stay valid (`topic_id NULL` = global term). **No column drops/renames** (forward-only). |
| 3 | Add `intel_alert_preference` (Registry §5: 1:1 carry of `alert_preference`, all columns) | UNIQUE `(tenant_id, client_id, user_id)` — mirrors legacy UNIQUE `[userId,clientId]` scoped by tenant |
| 4 | Every NEW table + every table gaining a `tenant_id` gets `tenant_id uuid NOT NULL` + RLS ENABLE + policy mirroring api (Registry §4). **`intel_watchlist` already exists (hearing) — adding `client_id`/`tenant_id` must not break its current RLS/queries; verify hearing reads still pass under the amended policy.** | See §5.5 / G1 |
| 5 | Run migrate task; assert `_prisma_migrations` row `finished_at IS NOT NULL AND rolled_back_at IS NULL` | Re-run = no new row (`migrate deploy` forward-only, idempotent) |

**Unique-index safety on `ADD COLUMN client_id NOT NULL`:** `intel_watchlist` may already hold hearing rows. A bare `ADD COLUMN client_id uuid NOT NULL` will FAIL on a non-empty table. Migration MUST either (a) add nullable → backfill → `SET NOT NULL` in-migration, or (b) confirm the table is empty on dev/prod first. **Gate G0b:** `SELECT count(*) FROM intel_watchlist;` on BOTH dev and prod before finalizing; pick strategy accordingly.

**Deploy ordering (Registry §1, non-negotiable):** migrate task runs to `STOPPED` with **exit 0** BEFORE any `update-service --force-new-deployment` of `capiro-dev-intel-api`. Web is order-independent and out of scope for Phase 2. Rollback: because the migration is additive-only and the serve image is unchanged until §5.2, a bad migrate task leaves the running `serve` deployment untouched; re-point to the prior image tag only if §5.2 ships together and regresses (see §5.9).

Apply command (dev; prod uses `--cluster capiro-prod-os-capiro` + `capiro-prod-intel-api-migrate`, all **UNVERIFIED**; subnets/SGs **UNVERIFIED — confirm** from `scripts/deploy-ingestion-out-of-band.sh` run_job_wait template / resolved task-defs):

```bash
aws ecs run-task --cluster capiro-dev --launch-type FARGATE \
  --task-definition capiro-dev-intel-api-migrate \
  --network-configuration 'awsvpcConfiguration={subnets=[...],securityGroups=[...],assignPublicIp=DISABLED}' \
  --overrides 'containerOverrides=[{name=intel-api-migrate,command=["migrate"]}]'
# wait: aws ecs wait tasks-stopped ... ; then assert containers[0].exitCode == 0
```

### 5.2 CRUD service + controller — `/intel-api/watchlists*`

New `apps/intel-api/src/watchlist/` module (mirrors the hearing feature module layout). All routes are **relative `/intel-api/*`** and resolve against `apiBaseUrl` on the web client (Registry §8).

> **ALB reality (Registry §1):** there is **NO `/intel-api/*` ALB rule today** — intel-api is internal-only on :4300. These routes are therefore **NOT reachable from the browser in Phase 2** and are exercised ONLY by (a) the in-cluster sync task and (b) integration tests hitting the container directly. **Exposing them over the ALB is explicitly DEFERRED to the frontend phase** and requires ADDING a listener rule on `capiro-prod-alb` via `aws elbv2 create-rule` (NOT `cdk deploy`; ALB is manually managed/wedged), at a free priority (**suggest 12 or 17 — UNVERIFIED, must confirm no collision with rules 3/5/10/15/20**). Do not add the ALB rule in Phase 2. This keeps Phase 2 free of any external attack surface.

| Method | Route | Handler | Tenant scoping |
|---|---|---|---|
| GET | `/intel-api/watchlists/:clientId` | `getWatchlist` | `withTenant(tenantId)` |
| PUT | `/intel-api/watchlists/:clientId` | `putWatchlist` (upsert head + replace topics/terms in one tx) | `withTenant` |
| GET | `/intel-api/watchlists/:clientId/alert-prefs` | `getAlertPrefs` | `withTenant` |
| PUT | `/intel-api/watchlists/:clientId/alert-prefs` | `putAlertPrefs` | `withTenant` |
| GET | `/intel-api/watchlists/:clientId/compiled` | `getCompiled` (WatchlistCompiler output, §5.3) | `withTenant` |

- **Guard:** all routes behind `tracker_owner_intel` via `FeatureFlagService.isEnabled` — returns **404 when disabled** (Registry §3), ALWAYS-on for `CAPIRO_INTERNAL_TENANT_ID`.
- **@capiro/shared deps (ONLY these, Registry §6):** `issueAreaForSector`, `normalizeIssueArea`, `ISSUE_AREAS`. Reuse the exact normalization the legacy service applies on read/write so synced data round-trips identically.
- **Write policy during shadow (D6):** these PUT routes are **live but NOT the source of truth**. The Configure UI keeps writing `apps/api` until the tenant is flipped (plan §4 step 4). To prevent split-brain, PUT returns **409** for any client whose tenant is NOT `tracker_owner_intel`-enabled, EXCEPT when invoked by the internal sync context (`prisma.withSystem`, identified by an in-process system flag — the sync task is not an HTTP caller, so this is a service-layer guard, not header-based auth). This makes "edited mid-sync via intel" structurally impossible during shadow and is asserted by SC-7.

### 5.3 WatchlistCompiler (inputs → outputs, keyterm generation)

`apps/intel-api/src/watchlist/watchlist-compiler.ts` — **pure function, no side effects**, unit-testable in isolation (parallels the pure `tracker-relevance.util.ts`, Registry §6).

**Input:** compiled read of `intel_watchlist` + `intel_watchlist_topic` + `intel_watchlist_term` rows for one client.

**Outputs (one per matching path — plan §3 line 133):**

| Output | Consumer | Contents |
|---|---|---|
| `billMatchSet` | Bill match engine (Phase 3) | Per-topic `{ keywords[], synonyms[], entities[], riskPhrases[], issueAreas[], position, priority }`. Terms filtered to `MIN_TERM_LEN = 3` (Registry §6). |
| `hearingTerms` | Hearing matcher + Deepgram | Flat weighted list `{ value, weight }` from all `term_type ∈ (keyword,synonym,entity,risk_phrase,program_element)` |
| `deepgramKeyterms` | `DeepgramStreamManager.open()` (F1) | De-duped, lower-cased `hearingTerms.value` array; passed as `keywords` in `deepgram.listen.live({...})` (Registry §7; keyterm param NOT passed today — F1 wires it, out of scope for Phase 2) |

**Keyterm generation rules:** (1) collapse whitespace + lowercase; (2) drop terms `< MIN_TERM_LEN` (3); (3) de-dupe case-insensitively; (4) cap list length (Deepgram nova-2 keyterm max — **UNVERIFIED, confirm before F1**; default cap 100, highest-`weight` first, ties broken by lexical order); (5) **stable, deterministic sort** so output is byte-identical across runs (required for the no-op assertion in §5.6/SC-3 and the compiler snapshot in SC-4).

### 5.4 Sync task — `sync-watchlists-from-legacy`

New entrypoint verb. **Extend `apps/intel-api/scripts/entrypoint.sh`** (currently `serve | migrate | enable-feature`, confirmed lines 30–96): add a `sync-watchlists-from-legacy)` case that `node`-invokes a compiled `dist/scripts/sync-watchlists-from-legacy.js`, mirroring the existing `enable-feature)` node-invocation pattern (lines 65–95). This same entrypoint pass also adds the `disable-feature)` verb (§5.0.1). **One-way, `apps/api → intel-api` (D6).**

> **Task-def selection (verify, do not assume):** Registry §1 sanctions running `enable-feature` on the `capiro-dev-intel-api-migrate` task-def, which carries **DB-only** secrets — sufficient for a pure DB→DB copy (no Deepgram/Bedrock creds needed). **Gate G2:** confirm the `-migrate` task-def's container image is the SAME image as `serve` (so `dist/scripts/sync-watchlists-from-legacy.js` is present) and that its `command` override to a non-`migrate` verb is honored by `entrypoint.sh`. If the migrate image is stripped of `dist/scripts`, add the verb to the serve task-def instead. Until G2 is closed, do not schedule the sync.

**Field mapping (Registry §5, verbatim):**
- `client_watchlist.issue_areas` (`String[]`) → `intel_watchlist.enabled_issue_areas` (carry array).
- FOR EACH `tags[]` object → one `intel_watchlist_topic` `{client_id, tenant_id, name=tag.tag, issue_area=tag.issueArea, position, priority}`.
- FOR EACH `synonyms[]` / `relatedEntities[]` / `riskTerms[]` under a tag → one `intel_watchlist_term` `{topic_id, tenant_id, term_text, term_type ∈ synonym|entity|risk}` (map `riskTerms`→`risk_phrase` per the §5.1 value set; document the exact mapping in code).
- `alert_preference` (UNIQUE `[userId,clientId]`) → `intel_alert_preference` 1:1, all columns (id, tenantId, clientId, userId, triggers[], materiality, emailEnabled/Address/Cadence, smsEnabled/Phone/PhoneVerified/Cadence, quietHoursStart/End, timestamps).

**Concurrency / locking (mandatory — scheduled 6h run can overlap a manual run):**
- Each per-client copy runs inside ONE `withSystem` transaction that first takes a **Postgres advisory lock** keyed on the client: `SELECT pg_advisory_xact_lock(hashtext('intel_watchlist_sync:'||$clientId))`. Concurrent runs serialize per client; the lock releases at tx commit/rollback. This prevents two overlapping syncs from double-deleting/re-inserting the same client's topics/terms.
- A single manual + scheduled overlap on DIFFERENT clients proceeds in parallel safely (per-client lock, not global).

**Idempotency (re-run = no-op):**

| Object | Idempotency key | Strategy |
|---|---|---|
| `intel_watchlist` (head) | `(tenant_id, client_id)` | `INSERT … ON CONFLICT (tenant_id, client_id) DO UPDATE` |
| topics + terms | per client | **Replace-in-transaction** under the per-client advisory lock: `DELETE topics/terms WHERE client_id=$1` then re-insert from compiled legacy. Deterministic ordering → identical rows on re-run. |
| `intel_alert_preference` | `(tenant_id, client_id, user_id)` | `ON CONFLICT … DO UPDATE` |

**Skip-if-unchanged:** hash legacy `client_watchlist` (`issue_areas` + `tags` JSON, canonicalized) + that client's `alert_preference` rows into `intel_watchlist.source_hash`; if unchanged since last sync, skip the delete/re-insert for that client entirely. Makes re-run cheap AND provably no-op (SC-3 asserts `changed=0`).

**Connection-pool impact (shared Aurora):** intel-api is a SECOND service on the same cluster. The sync task MUST use a **bounded, small Prisma pool** (e.g. `connection_limit=4` in the composed `DATABASE_URL`) so an all-tenants loop cannot exhaust Aurora `max_connections` and starve the live `apps/api` / `capiro-dev-intel-api` serve pools. Process tenants **sequentially** (loop), not fanned-out. **Gate G3:** confirm intel-api serve + api current pool sizing leaves headroom for the sync task before the all-tenants run.

**Run modes:**
- **On-demand (single tenant):**
```bash
aws ecs run-task --cluster capiro-dev --launch-type FARGATE \
  --task-definition capiro-dev-intel-api-migrate \
  --network-configuration 'awsvpcConfiguration={subnets=[...],securityGroups=[...],assignPublicIp=DISABLED}' \
  --overrides 'containerOverrides=[{name=intel-api-migrate,command=["sync-watchlists-from-legacy","<tenantSlugOrId>"]}]'
```
(subnets/SGs **UNVERIFIED — confirm** per Registry §1.)
- **All tenants:** omit the tenant arg; loop all `tenants` rows (`SELECT id, slug FROM tenants`, same pattern as `enable-feature` at entrypoint.sh:65–95) under `prisma.withSystem`, sequentially.
- **Scheduled:** out-of-band EventBridge rule `capiro-dev-sync-watchlists` (NOT in CDK — mirrors existing tracker/press schedules per project memory; **document it so a `cdk deploy` does not drop it**). Cadence: **every 6h during shadow**. **Disable per-tenant at cutover** (plan §4 step 5) so a flipped tenant's new intel-owned edits are never reverse-overwritten. Add a **run-lock**: skip a scheduled run if a prior all-tenants run is still executing (EventBridge does not dedupe; rely on the per-client advisory locks + a top-level `pg_try_advisory_lock('intel_watchlist_sync:global')` that returns immediately/exits 0 if already held).

### 5.5 Conflict handling & source-of-truth invariants

| Scenario | Handling |
|---|---|
| Watchlist edited in `apps/api` **mid-sync** | Per-client copy runs inside ONE `withSystem` tx under a per-client advisory lock. A concurrent legacy edit commits either before the read (picked up now) or after (next run, ≤6h). No partial state — replace is atomic. |
| Edit attempted via **intel PUT** during shadow | Rejected 409 for non-owned tenants (§5.2) — intel is not source of truth (D6). |
| Legacy row **deleted** | LEFT-anti-join sweep: intel `client_id` not present in legacy `client_watchlist` → delete `intel_watchlist` + cascade topics/terms for that client. Keeps unified == legacy exactly. Run the sweep inside the same all-tenants `withSystem` pass. |
| **RLS blocks intel from reading legacy rows** | Legacy `client_watchlist` / `alert_preference` are TENANT-SCOPED (RLS, Registry §4). Sync MUST read under the correct tenant context. See G1 below. |

> **BLOCKING GATE G1 (owner: DB/platform — Registry §4 UNVERIFIED):** confirm intel-api's Prisma **DB role** and that `prisma.withTenant(tenantId, …)` (per-tenant `SET app.current_tenant_id`) and `prisma.withSystem(…)` (RLS-exempt / cross-tenant) both EXIST and WORK in intel-api. Specifically confirm: (a) the cross-tenant sweep + all-tenants loop run under a role that can read every tenant's `client_watchlist`/`alert_preference`; (b) the role can read `context_embeddings` NULL-tenant rows (needed downstream Phase 3). If intel-api connects under a DIFFERENT role than api and that role is NOT RLS-exempt, the all-tenants run will **silently skip** tenants whose rows RLS hides — SC-8 is the tripwire. **Do not run the all-tenants sync until G1 is closed.**

**Invariant (D6):** during shadow, `apps/api` `client_watchlist` is the ONLY writable copy; intel `intel_watchlist*` is a materialized read-replica. Source of truth flips exactly at cutover (plan §4 step 4); sync is then disabled for that tenant (step 5). Because intel never writes `apps/api` tables, rollback (plan §4 / §5.9) leaves legacy fully intact.

### 5.6 Verification query — drift == 0

Run after any sync (read-only; intel + legacy share the same Aurora). Save as `apps/intel-api/scripts/sql/watchlist-parity.sql`. Because this query reads tenant-scoped `client_watchlist`, run it under the RLS-exempt/system role (same path as the sync) or per-tenant — a naive read under a scoped role will under-count and produce a **false PASS**.

```sql
-- Per-client drift: rows in one side but not the other. Expect ZERO rows.
WITH legacy AS (
  SELECT cw.client_id,
         COALESCE(array_length(cw.issue_areas,1),0) AS n_areas,
         COALESCE(jsonb_array_length(cw.tags),0)    AS n_tags
  FROM client_watchlist cw
),
unified AS (
  SELECT w.client_id,
         COALESCE(array_length(w.enabled_issue_areas,1),0)                            AS n_areas,
         (SELECT count(*) FROM intel_watchlist_topic t WHERE t.client_id=w.client_id) AS n_tags
  FROM intel_watchlist w
  WHERE w.client_id IS NOT NULL   -- exclude pre-existing hearing-only rows
)
SELECT COALESCE(l.client_id,u.client_id) AS client_id,
       l.n_areas AS legacy_areas, u.n_areas AS unified_areas,
       l.n_tags  AS legacy_tags,  u.n_tags  AS unified_tags
FROM legacy l FULL OUTER JOIN unified u USING (client_id)
WHERE l.client_id IS NULL OR u.client_id IS NULL
   OR l.n_areas <> u.n_areas OR l.n_tags <> u.n_tags;
```

Run via a `diag-*`-style one-off task (only working path for ad-hoc read-only prod SQL — project memory `infra_query_prod_db`). **Alert-pref parity** (separate query, same task): `SELECT tenant_id, count(*) FROM alert_preference GROUP BY 1` vs `intel_alert_preference` — expect identical per-tenant counts.

### 5.7 Latency + failure alarm

- **Metrics:** sync task emits `WatchlistSyncDurationMs` (per-tenant), `WatchlistSyncClients`, and `WatchlistSyncChanged` to CloudWatch (namespace `Capiro/IntelApi`). Task exits **non-zero on any client failure** so ECS marks it `STOPPED` with a non-zero container `exitCode`. Emit `SYNC_DONE clients=<N> changed=<M> drift_precheck=<0|n>` to the log group `/capiro/dev/intel-api` (stream `intel-api-migrate`) as the final line (SC-3 parses this).
- **CloudWatch alarms (out-of-band; SNS topic `capiro-dev-alerts`, which now has neo@capiro.ai subscribed per project memory `project_alerting`):**
  - `capiro-intel-watchlist-sync-failed`: ALARM when a scheduled run's container exitCode ≠ 0, OR when count of successful runs in an 8h window < 1 (missed-run detection). **Threshold: any failure or any missed run.**
  - `capiro-intel-watchlist-sync-latency`: ALARM when p95 `WatchlistSyncDurationMs` per tenant > **5000 ms** for 2 consecutive periods. (Pure DB copy; a spike signals RLS/lock/pool contention — see G3.)
- **No SES identity needed in Phase 2:** this phase sends NO tracker alert emails (that is the notification port, later). Alarm delivery uses the existing SNS→email subscription, not SES. `TRACKER_ALERT_EMAIL_FROM`/SES verification are out of scope here.

### 5.8 Documented operator command (run + check)

```bash
# 1. Deploy intel-api (ARM64) — build with BOTH :latest and :<GIT_SHA> (Registry §1), migrate FIRST, then roll serve.
GIT_SHA=$(git rev-parse --short HEAD)
docker buildx build --platform linux/arm64 -f apps/intel-api/Dockerfile \
  -t 967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/intel-api:latest \
  -t 967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/intel-api:${GIT_SHA} \
  --push .
# (CI equivalent: .github/workflows/intel-api-image.yml on apps/intel-api/** etc.)

aws ecs run-task --cluster capiro-dev --task-definition capiro-dev-intel-api-migrate \
  --launch-type FARGATE --network-configuration 'awsvpcConfiguration={subnets=[...],securityGroups=[...],assignPublicIp=DISABLED}' \
  --overrides 'containerOverrides=[{name=intel-api-migrate,command=["migrate"]}]'
#   -> aws ecs wait tasks-stopped ...; assert containers[0].exitCode == 0 BEFORE proceeding

aws ecs update-service --cluster capiro-dev --service capiro-dev-intel-api --force-new-deployment
#   -> aws ecs wait services-stable ...

# 2. Enable ownership flag for the pilot tenant (capiro-internal).
#    (guards CRUD; ALWAYS-on for CAPIRO_INTERNAL_TENANT_ID regardless, so this is belt-and-suspenders for named-slug tenants)
aws ecs run-task --cluster capiro-dev --task-definition capiro-dev-intel-api-migrate --launch-type FARGATE \
  --network-configuration 'awsvpcConfiguration={subnets=[...],securityGroups=[...],assignPublicIp=DISABLED}' \
  --overrides 'containerOverrides=[{name=intel-api-migrate,command=["enable-feature","tracker_owner_intel","capiro-internal"]}]'

# 3. Run the sync (one tenant first, then all — only AFTER G1/G2/G3 closed for all-tenants)
aws ecs run-task --cluster capiro-dev --task-definition capiro-dev-intel-api-migrate --launch-type FARGATE \
  --network-configuration 'awsvpcConfiguration={subnets=[...],securityGroups=[...],assignPublicIp=DISABLED}' \
  --overrides 'containerOverrides=[{name=intel-api-migrate,command=["sync-watchlists-from-legacy","capiro-internal"]}]'
# check: log group /capiro/dev/intel-api (stream intel-api-migrate) shows "SYNC_DONE clients=N changed=M"

# 4. Verify drift == 0 (diag-style read-only one-off under the system/RLS-exempt role; §5.6 SQL). Expected: 0 rows.

# 5. Re-run step 3 -> confirm no-op: "SYNC_DONE clients=N changed=0"

# 6. (Rollback drill) Disable the ownership flag for a named-slug tenant via the disable-feature verb (§5.0.1);
#    guarded surfaces then fail CLOSED -> 404. (No-op for CAPIRO_INTERNAL_TENANT_ID, which is ALWAYS-on.)
aws ecs run-task --cluster capiro-dev --task-definition capiro-dev-intel-api-migrate --launch-type FARGATE \
  --network-configuration 'awsvpcConfiguration={subnets=[...],securityGroups=[...],assignPublicIp=DISABLED}' \
  --overrides 'containerOverrides=[{name=intel-api-migrate,command=["disable-feature","tracker_owner_intel","<named-slug-tenant>"]}]'
```

### 5.9 Rollback

- **Migration:** additive-only + forward-only. There is no "down" migration. To back out schema, ship a NEW forward migration dropping the added columns/tables (only if empty/unused); never hand-edit `_prisma_migrations`.
- **Serve image:** if §5.2 CRUD ships in the same image and regresses, `update-service` with the prior `:<GIT_SHA>` task-def revision (Registry §1 keeps SHA-tagged images for exactly this) and `aws ecs wait services-stable`.
- **Sync data:** intel `intel_watchlist*` is a materialized replica of legacy. To reset, disable the schedule, then re-run `sync-watchlists-from-legacy` (idempotent) — or, to fully clear, `DELETE FROM intel_watchlist WHERE client_id IS NOT NULL` (leaves hearing-only rows intact) then re-sync.
- **Legacy safety:** guaranteed intact — intel never writes `apps/api` tables (D6 invariant).
- **Flag (OFF path):** use the `disable-feature <flag> <tenantSlugOrId>` verb built in §5.0.1 (guard then fails CLOSED → 404). If the verb is unavailable mid-incident, use the documented SQL fallback from §5.0.1 (`UPDATE intel_feature_flag SET enabled=false …` under the system role). This is the same flag-OFF path referenced by s11 §11.5, s12 §12.6, s13, and the s16 recovery rows — a `disable-feature` verb (or its SQL fallback) is a committed Phase 2 deliverable, not UNVERIFIED. Note: disabling `tracker_owner_intel` for a named-slug tenant is the correct shadow-phase back-out; it is a no-op for `CAPIRO_INTERNAL_TENANT_ID` (ALWAYS-on, Registry §3).

---

**Success criteria** (each independently verifiable; command/metric + threshold + gate + owner):

| # | Criterion | Owner / how (command or metric) | Threshold / expected | Unblocks |
|---|---|---|---|---|
| SC-0 | **Schema gates closed** | Intel-api lead: G0 (`\d` snapshot), G0b (`count(*) FROM intel_watchlist` dev+prod), G1 (role + `withTenant`/`withSystem`), G2 (migrate image has `dist/scripts`), G3 (pool headroom) all recorded | All 5 gates marked closed with evidence | Writing migration / all-tenants sync |
| SC-1 | **Migration applied, forward-only** | Engineer: `SELECT finished_at, rolled_back_at FROM _prisma_migrations ORDER BY started_at DESC LIMIT 1` after migrate task | `finished_at NOT NULL`, `rolled_back_at NULL`; re-run migrate task adds NO new row | §5.2 CRUD deploy |
| SC-2 | **Drift == 0 (all tenants)** | §5.6 parity SQL via diag one-off under system role | **0 rows** from the drift query AND identical `alert_preference` vs `intel_alert_preference` per-tenant `count(*)` | Phase 3 match engine trusts unified watchlist |
| SC-3 | **Re-run is a no-op** | Run `sync-watchlists-from-legacy` twice back-to-back; parse final log line | 2nd run logs `changed=0`; row-level diff of `intel_watchlist_topic`+`_term` between runs = 0 rows; `source_hash` unchanged | Enabling the 6h schedule |
| SC-4 | **Compiler unit tests** | CI `apps/intel-api` jest: tag→topic→term expansion, `MIN_TERM_LEN=3` drop, case-insensitive dedupe, keyterm cap, deterministic order | 100% pass; `deepgramKeyterms` snapshot **byte-stable** across 3 consecutive builds | F1 keyterm wiring |
| SC-5 | **Per-tenant sync latency** | CloudWatch `Capiro/IntelApi/WatchlistSyncDurationMs` p95 over 3 scheduled runs | p95 < **5000 ms/tenant**; `capiro-intel-watchlist-sync-latency` stays OK | Cutover readiness |
| SC-6 | **Failure + missed-run alarm wired + tested** | Force failure (invalid tenant slug → non-zero exit); observe alarm + email | `capiro-intel-watchlist-sync-failed` → ALARM; neo@capiro.ai receives SNS email within one alarm period | Go-live of scheduled sync |
| SC-7 | **Shadow write-lock holds** | In-cluster call: intel PUT `/intel-api/watchlists/:clientId` for a NON-owned tenant (bypass ALB — no rule exists yet) | HTTP **409**; legacy `client_watchlist` row byte-unchanged (compare `updated_at`) | Confirms D6 before cutover |
| SC-8 | **RLS read path confirmed (G1 tripwire)** | Sync ≥2 different tenants' watchlists; compare synced client set to `SELECT DISTINCT tenant_id` in legacy | ZERO tenants silently skipped by RLS; intel-api role + `withTenant`/`withSystem` documented | All-tenants sync run |
| SC-9 | **Concurrency safe** | Launch two overlapping `sync-watchlists-from-legacy` all-tenants tasks; then run §5.6 drift | Both exit 0 (or one skips via global try-lock); drift == 0; no orphaned/duplicated topic rows | Enabling the 6h schedule |
| SC-10 | **Pool headroom under sync** | During an all-tenants run, Aurora `DatabaseConnections` (CloudWatch) + `apps/api`/`serve` health `/health` 200 | No connection-limit errors in logs; `apps/api` and `capiro-dev-intel-api` `/health` stay 200 throughout | All-tenants sync on prod |
| SC-11 | **`disable-feature` flag-OFF path works** | Run `disable-feature tracker_owner_intel <named-slug-tenant>` (§5.0.1); then hit a guarded route (e.g. GET `/intel-api/watchlists/:clientId` in-cluster) for that tenant; also verify the documented SQL fallback flips the same row | Guarded route returns **404** after disable; `intel_feature_flag` row `enabled=false`; SQL fallback produces the identical state | Rollback readiness for §5.9, s11 §11.5, s12 §12.6, s13, s16 recovery rows |

**Blocking UNVERIFIED items to close in Phase 2** (do NOT run the all-tenants sync on prod until (a)–(g) are confirmed):
(a) **prod intel-api service + cluster + migrate task-def names** (Registry §1);
(b) **migrate-task subnets/SGs** (Registry §1 / `scripts/deploy-ingestion-out-of-band.sh`);
(c) **intel-api Prisma DB role + RLS `withTenant`/`withSystem`** availability incl. `context_embeddings` NULL-tenant read (G1 / SC-8);
(d) **table-name reconciliation** `intel_watchlist_*` vs `intel_topic`/`intel_term` and existing hearing column set (§5.0 / G0);
(e) **`intel_watchlist` non-empty on ADD COLUMN NOT NULL** — backfill strategy (G0b);
(f) **migrate task-def image contains `dist/scripts`** so non-`migrate` verbs run there (G2);
(g) **Aurora connection-pool headroom** for a second service's sync loop (G3 / SC-10);
(h) Deepgram nova-2 keyterm max for the compiler cap (needed for F1, not blocking Phase 2 sync).

> Item (i) — the feature-flag **disable path** — is **no longer UNVERIFIED**: it is a committed Phase 2 deliverable, the `disable-feature` verb (or its documented SQL fallback) built in §5.0.1, verified by SC-11, and referenced consistently by §5.9, s11 §11.5, s12 §12.6, s13, and the s16 recovery rows.

---

## 6. Phase 3 — Bill match engine + change detection (shadow)

**Goal (unchanged from §3 Phase 3):** stand up the unified `MatchEngine`, `intel_tracked_bill` curation + recommendation endpoint, and the `detect-bill-changes` job inside `apps/intel-api`, running entirely in **shadow** — it writes `intel_alert` rows (`status='new'`, `deliveredAt=null`) and delivers **nothing**. Ends when shadow output is provably alignable with legacy (measured in Phase 5). Depends on Phase 1 (`SourceDataRepository`, query-side `embedText`/`vectorLiteral`, **entrypoint verb dispatch + a Nest-context job runner — neither exists today, see §6.0**) and Phase 2 (unified watchlist populated by `sync-watchlists-from-legacy`).

Ground truth confirmed against source: legacy `runDetectionCycle` (`apps/api/src/tracker/tracker-change-detector.service.ts`) reads tracked bills cross-tenant via `prisma.withSystem`, scoped copy/enrichment via `prisma.withTenant`, and advances the `lastSeen*` snapshot **only after** side-effects durably succeed (retry-on-failure). The shadow port preserves this exactly, cutting the pipeline **before** `alerts.fanOut()`.

**Strangler/shadow/single-sender invariant (do not violate anywhere in this phase):** legacy tracker remains the ONLY sender. intel-api Phase 3 is write-to-`intel_alert`-and-stop. No SES identity, no SNS, no `intel_notification_log` write, no `IntelligenceChange` emit on this path. Enforced by §6.3 and gated by T4.

---

### 6.0 Prerequisites that DO NOT EXIST in intel-api today (must build in Phase 1, hard-blocking this phase)

Verified against source — these are **confirmed absent**, not "UNVERIFIED":

1. **`PrismaService.withTenant` / `withSystem` — ABSENT.** `apps/intel-api/src/prisma/prisma.service.ts` is a bare `PrismaClient` (only `$connect`/`$disconnect`); its header comment says tenant isolation is done "in application code" and it "owns only intel_* tables." **Port both helpers verbatim from `apps/api/src/prisma/prisma.service.ts`.** Load-bearing correction to registry §4: the GUC names are **`app.current_tenant`** (NOT `app.current_tenant_id`) and `withSystem` sets **`app.bypass_rls='on'`** — both via `set_config(name, value, /*is_local*/true)` inside a `$transaction`. Also port `withTenantRetry` (deadlock/40001/40P01 retry) if any curation write can contend. Registry §4 must be corrected to `app.current_tenant`.

2. **Nest-context job runner — ABSENT.** `apps/intel-api/src/main.ts` unconditionally calls `bootstrap()` (HTTP server); there is **no `--job` flag handling**. The draft-era `exec node dist/main.js --job detect-bill-changes` would silently start the web server and ignore the flag. Build a job dispatcher: either a new `apps/intel-api/src/job.ts` entry that does `NestFactory.createApplicationContext(AppModule)`, resolves the service, runs, `app.close()`, `process.exit(code)`; or a `--job` branch inside `main.ts` before `bootstrap()`. Mirror `apps/api/scripts/detect-tracker-alerts.ts` (application-context boot so RLS/config go through the service path).

3. **Entrypoint verb dispatch — the existing pattern is NOT reusable as claimed.** `apps/intel-api/scripts/entrypoint.sh` has arms `serve|migrate|enable-feature`. `enable-feature` is a standalone inline `node -e` script — it does **not** boot Nest — so it is **not** a precedent for a service-backed job. New verbs must invoke the §6.0-item-2 job runner, e.g. `exec node dist/job.js detect-bill-changes`. Registry §1's "verb dispatch is the established pattern (enable-feature already does exactly this)" is **misleading — flag to correct.**

Until items 1–3 land (Phase 1) and pass T0 (below), Phase 3 cannot start.

| # | Prereq gate | Check | Threshold | Owner |
|---|---|---|---|---|
| **T0** | withTenant/withSystem + job runner exist and work | `node dist/job.js noop-selftest` boots Nest context, calls `prisma.withSystem(tx=>tx.$queryRaw\`SELECT current_setting('app.bypass_rls',true)\`)` and `withTenant('<uuid>',…)`, prints both GUCs, exits 0 | GUC readback = `on` under withSystem and `<uuid>` under withTenant; exit 0 | Eng |

---

### 6.1 MatchEngine — ported legs, formula, thresholds (verbatim from registry §6)

Port from `apps/api/src/tracker/tracker.service.ts` (`getRecommendations`, `semanticScores`, `keywordCandidateIds`, `fetchBillRows`, `explainMatch` via `tracker-relevance.util.ts`) into `apps/intel-api/src/matching/`. `tracker-relevance.util.ts` (`wholeWordHit`, `billHaystack`, `explainMatch`) is **pure, no side effects** — copy as-is. Its only `@capiro/shared` deps are `issueAreaForSector`, `normalizeIssueArea`, `ISSUE_AREAS` (registry §6 confirms available in intel-api's dependency graph).

**Composite fit (use EXACTLY these weights/floors):**
```
fit = clamp01( 0.40*semantic
             + 0.30*textMatch
             + 0.15*exactEntity
             + 0.10*subjectMatch
             + 0.05*priorityBoost )
```
| Constant | Value | Use |
|---|---|---|
| `RECOMMENDATION_FLOOR` | `0.45` | display threshold for recommendations |
| `EMBED_CANDIDATE_FLOOR` | `0.30` | candidate cosine cutoff (semantic leg) |
| `MIN_TERM_LEN` | `3` | ignore terms shorter than this |

> NOTE — this is the recommendation composite. The plan's §3 line 141 (`0.4 sem + 0.3 kw + 0.2 entity + 0.1 issueCode`) is a **rounded restatement**; the load-bearing coefficients are the five-term formula above (`0.40/0.30/0.15/0.10/0.05`). Use the five-term version in code; treat §3 as prose.

**Semantic cosine SQL** (`semanticScores`, run through `SourceDataRepository` raw SQL against the shared Aurora `context_embeddings`; intel-api never writes it):
```sql
SELECT ce.source_id, (1 - (ce.embedding <=> $1::vector))::float8 AS score
FROM context_embeddings ce
WHERE ce.source_type = 'bill' AND ce.model = $2
  AND ce.embedding IS NOT NULL
  AND (1 - (ce.embedding <=> $1::vector)) >= $3
ORDER BY ce.embedding <=> $1::vector
LIMIT 400;
```
`$1` = query vector from `vectorLiteral(embedText(watchlistText))`; `$2` = `EMBEDDING_MODEL` (`amazon.titan-embed-text-v2:0`, 1024-dim); `$3` = `EMBED_CANDIDATE_FLOOR` (`0.30`).

**RLS — RESOLVED against source (correcting registry §4 "UNVERIFIED"):** the runtime role is `capiro_app` (`apps/api/prisma/migrations/20260502020000_capiro_app_role`), which has DML grants but `FORCE ROW LEVEL SECURITY` on every tenant table (it **cannot** bypass by ownership). The **current** `context_embeddings` READ policy (`20260527021119_context_embeddings_v2`) is:
```
USING ( rls_bypass() OR tenant_id IS NULL OR tenant_id = current_tenant_id() )
```
Therefore: **if intel-api connects as `capiro_app` (same role as apps/api, from the shared Aurora `capiro/*/aurora/app` secret), it can read NULL-tenant bill embeddings with NO tenant GUC set at all** — the `tenant_id IS NULL` clause covers it. `set_config(..., is_local=true)` on custom GUCs needs no GRANT (per the app-role migration comment), so `withTenant`/`withSystem` work under `capiro_app`. The registry §4 "UNVERIFIED — role may be blocked" caveat is **over-cautious**; the residual real risk is only **"is intel-api actually wired to `capiro_app` and not a different/narrower role?"** — that is exactly what **T1 confirms**. If T1 fails (0 rows), the semantic leg collapses to keyword-only and `fit` silently under-scores — **hard gate, do not proceed past 6.1.**

**Connection-pool impact (new, must account for):** intel-api adds a SECOND set of Prisma connections to the SHARED Aurora writer as `capiro_app`. The `detect-bill-changes` job opens short `withSystem`/`withTenant` transactions per bill; set a **bounded pool** on the job's `DATABASE_URL` (`?connection_limit=<N>&pool_timeout=…`, N small, e.g. 4–8) so a scheduled run cannot exhaust Aurora `max_connections` shared with apps/api's serve fleet. Confirm current apps/api pool sizing before choosing N. **UNVERIFIED — confirm Aurora `max_connections` headroom and pick N; owner Eng.**

**Bedrock dependency (registry §2, UNVERIFIED — task-role perms):** `embedText()` (ported from `apps/api/src/embeddings/embedder.ts`) calls Bedrock `InvokeModelCommand` for Titan embed using **task-role** AWS creds. intel-api SHARES the api task role (`Capiro-dev-Compute-ApiTaskRole…` / `Capiro-prod-os-capiro-Compute-ApiTaskRole…`, registry §1); that role **must** allow `bedrock:InvokeModel` on `arn:aws:bedrock:us-east-1::foundation-model/amazon.titan-embed-text-v2:0`. Since apps/api already embeds bills, the shared role likely has it — but the intel-api task must actually assume this role (verify the task-def `taskRoleArn`, not just that the policy exists). **Verification T2 is a hard gate.** `EMBEDDINGS_MODEL` env defaults to `amazon.titan-embed-text-v2:0`; `normalize()` caps input at `MAX_INPUT_CHARS = 8000`. Add `EMBEDDINGS_MODEL` to the intel-api serve + migrate/job task-defs (registry §2 lists it as to-add).

---

### 6.2 `intel_tracked_bill` curation service + recommendation endpoint

- **Model:** `intel_tracked_bill` per plan §2.2 (`tenantId, clientId, billId(=congress_bill.id ref), source(congress|state), displayNum, isManual, trackedBy, trackedAt, stage, lastSeenActionText, lastSeenActionDate, lastSeenAt, unread`). Enforce **UNIQUE `[clientId, billId]`** (mirrors legacy `tracked_bill`). Table is `intel_*`-owned → created by the intel-api **migrate** task (§6.5 deploy order), never by apps/api.
- **Curation service** (port `trackBill`, `untrackBill`, `getBoard`, `getSummary` from `tracker.service.ts`): add/remove tracked bills, board stages via `bill-stage.util.ts` (`humanizeBillId`, stage derivation). All bill-row reads go through `SourceDataRepository.fetchBillRows` (raw SQL on `congress_bill` + `congress_bill_action`/`_committee`/`_subject`); these are GLOBAL/RLS-free tables (registry §4), read by string ID, never written.
- **Recommendation endpoint** (port `getRecommendations`): `GET /intel-api/clients/:clientId/recommendations`. Runs the §6.1 composite over the client's compiled watchlist (Phase 2 `WatchlistCompiler`), returns bills with `fit >= RECOMMENDATION_FLOOR (0.45)`, each with `explainMatch` `{why, matchedTags}`. **Gate with the `tracker_owner_intel` guard** — returns **404** when disabled (registry §3 flag mechanics: guard returns 404, ALWAYS-on for `CAPIRO_INTERNAL_TENANT_ID`, backed by `FeatureFlagService.isEnabled`). This keeps the endpoint invisible to un-flipped tenants during shadow and is consistent with single-sender (read-only rec surface, no delivery).
  - **No ALB exposure in this phase.** Registry §1: there is NO `/intel-api/*` ALB rule today; intel-api is internal-only on :4300. This endpoint is reachable in-cluster only until Phase 7 adds a listener rule (out-of-band `aws elbv2 create-rule`, free priority — suggested 12/17, **UNVERIFIED collision, confirm**). Do NOT add an ALB rule in Phase 3. Web wiring lands in Phase 7; query keys will follow registry §8 (`['tracker-board', clientId]` style).
- **Tenant scoping:** curation writes wrap `prisma.withTenant(tenantId, tx => …)` (ported per §6.0). Cross-tenant reads (none needed in curation) would use `withSystem`. With `capiro_app` + FORCE RLS, an `intel_tracked_bill` write with the wrong/absent tenant GUC will be **RLS-rejected**, not silently mis-scoped — fail-closed, which is correct.

---

### 6.3 `detect-bill-changes` job — shadow change detection

New entrypoint verb wired to the §6.0 Nest-context job runner (NOT the inline-`node -e` `enable-feature` pattern):

**entrypoint.sh addition (invokes the job runner, mirrors the `serve`/`migrate` `exec` arms):**
```sh
detect-bill-changes)
  echo "Running intel bill change detection (SHADOW)"
  exec node dist/job.js detect-bill-changes
  ;;
```
(`job.js` = §6.0-item-2: `NestFactory.createApplicationContext(AppModule)` → resolve `IntelBillChangeDetectorService` → run cycle → log summary → `app.close()` → `process.exit(code)`. This is the mechanism `apps/api/scripts/detect-tracker-alerts.ts` uses so all RLS/config flow through the service path.)

It runs `IntelBillChangeDetectorService.runDetectionCycle()`, a **faithful port of legacy `runDetectionCycle`** with the delivery leg severed.

**Cycle logic (ported verbatim — do not re-derive):**
0. **Acquire overlap lock (§6.5):** `SELECT pg_try_advisory_lock(hashtext('intel:detect-bill-changes'))`; if `false` → log `SKIP_OVERLAP`, exit 0. Release in `finally`.
1. `prisma.withSystem` → read all `intel_tracked_bill` rows `{id, tenantId, clientId, billId, lastSeenActionText, lastSeenActionDate, lastSeenAt}` (cross-tenant; requires `app.bypass_rls='on'`, set by the ported `withSystem`). Early-return `{scanned:0,…}` if empty.
2. Batch-read `congress_bill` rows for the distinct `billId`s via `SourceDataRepository` (raw SQL: `id, title, latestActionText, latestActionDate, url, subjects, policyArea`).
3. **Action-history catch-up** (only when `TRACKER_SCAN_ACTION_HISTORY` set): batch-read `congress_bill_action` `{billId, date, text}` `ORDER BY date ASC`, group by `billId`. Enables `selectMaterialEvents` to catch multiple material moves between runs.
4. Per tracked bill:
   - **Unbaselined** (`lastSeenAt == null`) → `snapshot(...)` to current, `baseline++`, **never alert on historical state.** (`snapshot` writes `lastSeenActionText/Date/At` via `withSystem`.)
   - Compute `textChanged = (bill.latestActionText ?? '') !== (row.lastSeenActionText ?? '')` and `dateAdvanced` (`latestActionDate` strictly newer). If neither → skip.
   - **Select material events:** with history → `selectMaterialEvents(newActions strictly-newer-than lastSeenActionDate, latest)`; without → `classifyChange(bill.latestActionText)` (single event or none).
   - No events → routine churn → `snapshot(...)` (advance now, safe).
   - Events present → enrich (guarded, never breaks the cycle): resolve client name via `withTenant(row.tenantId, …)`; if `TRACKER_ALERT_ENRICH`, `explainMatch(...)` → `{why, matchedTags}`.
5. **SHADOW cut point:** where legacy calls `emitIntelligenceChange(...)` + `alerts.fanOut(...)`, the port instead **writes `intel_alert` rows** (plan §2.3) with `status='new'`, `deliveredAt=null`, populated `evidence` Json `{stage, actionText, actionDate, url, why, matchedTags, summary?}`, and **returns with NO delivery call and NO `IntelligenceChange` emit.** The `intel_alert` write goes through `withTenant(row.tenantId, …)` so the row is written under its tenant's RLS context (fail-closed if mis-scoped). Snapshot advances (step 6) only **after** the `intel_alert` write durably succeeds — per the legacy retry contract, a transient DB failure leaves the snapshot un-advanced so the move re-triggers next run.
6. `snapshot(row.tenantId, row.id, bill.latestActionText, bill.latestActionDate)` via `withSystem`.

> **`IntelligenceChange` is intentionally NOT emitted in Phase 3.** Registry §6 flags that `IntelligenceChange` is an apps/api table and is UNVERIFIED in the intel-api schema — irrelevant here because the shadow path must not emit it (single-sender: legacy still owns the Intelligence feed). Re-target/port is a Phase 4+ decision. Do not add it now.

**`classifyChange` cascade — ported verbatim (most-significant-first; matches source):**
| changeType | severity | triggerKey |
|---|---|---|
| `bill_enacted` (law/signed/enacted) | critical | enactedFailed |
| `bill_to_president` | critical | enactedFailed |
| `bill_failed` (failed/rejected/tabled/veto) | critical | enactedFailed |
| `bill_passed_chamber` | notable | floorVote |
| `bill_rule_reported` (Rules Committee) | notable | **floorVote** ¹ |
| `bill_floor_scheduled` (calendar/scheduled) | notable | floorVote |
| `bill_reported` (reported/committee agreed) | notable | committeeVote |
| `bill_markup` | notable | committeeVote |
| `bill_amendment` | notable | amendment |
| `bill_hearing` | info | hearing |
| (no match) | `null` | — |

¹ **CONFIRMED against source:** `apps/api/src/tracker/tracker-change-detector.service.ts` lines 79–80 emit `bill_rule_reported` → `triggerKey: 'floorVote'`. Registry §6 lists `committeeVote` and is **WRONG** — use `floorVote` (source) so the port byte-matches legacy for the Phase 5 parity gate. This correction MUST propagate to **every** place the `classifyChange` table is restated downstream — registry §6 and any section that cites registry's `committeeVote` for `bill_rule_reported` — so the Phase 5 parity port's classifier bucket (s8) references `floorVote`, not `committeeVote`. Any section relying on the registry's stale `committeeVote` value would diverge from legacy and break the byte-match parity gate. **Action: correct registry §6; the s8 parity classifier's `floorVote` bucket MUST include `bill_rule_reported`.**

Ranks (ported from `tracker-notification.types.ts`): `SEVERITY_RANK {info:1, notable:2, critical:3}`, `MATERIALITY_RANK {low:1, medium:2, high:3}`, `clearsMateriality(sev,mat) = SEVERITY_RANK[sev] >= MATERIALITY_RANK[mat]`.

**Shadow-mode guarantee (nothing sent) — enforced at three layers (upholds single-sender):**
1. **Code:** `detect-bill-changes` / `IntelBillChangeDetectorService` has **no import** of any alert/email/SMS service, no `emitIntelligenceChange`. `intel_alert.status` is only ever `'new'`; `deliveredAt` stays null. Delivery services are not ported until Phase 4 and remain flag-gated OFF.
2. **No `intel_notification_log` writes:** the fan-out that writes that table (unique `[alertId,userId,channel]`) is not on this code path → the table stays empty for shadow-only tenants (T4).
3. **Config:** ship with `TRACKER_ALERTS_ENABLED` **unset/false** and `TRACKER_ALERT_SUMMARY` unset (summaries default off → no Bedrock summary spend, no `ai_usage_events` writes). UNVERIFIED whether `ai_usage_events`/`AiCredentialResolverService` exist in intel-api — **irrelevant while summaries are off; defer to Phase 4** (registry §2).

**Rollback:** the job is idempotent and shadow-only, so rollback is trivial and non-destructive:
- **Disable schedule:** `aws events disable-rule --name capiro-dev-detect-bill-changes` (stops future runs; no in-flight delivery to unwind since nothing is delivered).
- **Roll back image:** re-deploy the prior `:<GIT_SHA>` tag to `capiro-dev-intel-api` (registry §1 tags every push with the SHA). No serve-path behavior changed (endpoint is 404-gated), so an api/web rollback is not required.
- **Data:** `intel_alert` shadow rows are inert (`status='new'`, never delivered); leave them for parity analysis or `DELETE FROM intel_alert WHERE status='new' AND delivered_at IS NULL` if a clean re-run is wanted. `intel_tracked_bill`/`lastSeen*` from backfill are idempotent — a re-run of `backfill-tracked-bills` restores baseline. The migrate task is forward-only (`prisma migrate deploy`); do not attempt a down-migration — new `intel_*` tables are additive and unused by serve until Phase 7.

---

### 6.4 Backfill tracked bills from legacy

One-off verb `backfill-tracked-bills` (same job-runner pattern; **UNVERIFIED subnets/SGs — resolve from `scripts/deploy-ingestion-out-of-band.sh` run_job_wait template / resolved task-defs per registry §1 before running**):
```
aws ecs run-task --cluster capiro-dev --launch-type FARGATE \
  --task-definition capiro-dev-intel-api-migrate \
  --network-configuration 'awsvpcConfiguration={subnets=[...],securityGroups=[...],assignPublicIp=DISABLED}' \
  --overrides 'containerOverrides=[{name=intel-api-migrate,command=["backfill-tracked-bills"]}]'
```
> **Task-def note (verb-to-task-def binding — downstream sections MUST match this):** the two verbs run on DIFFERENT task-defs.
> - **`backfill-tracked-bills` → migrate task-def `capiro-dev-intel-api-migrate`, container `intel-api-migrate`.** The migrate task-def gets **ONLY DB_* secrets + `DB_NAME`** (registry §2). `backfill-tracked-bills` is DB-only (reads legacy `tracked_bill`, writes `intel_tracked_bill`) so migrate is the correct home.
> - **`detect-bill-changes` → SERVE task-def `capiro-dev-intel-api`, container `intel-api`** (or a dedicated jobs task-def carrying the full serve env). It **needs Bedrock creds + the full serve env** (`EMBEDDINGS_MODEL`, task-role Bedrock perms) — see §6.5. Running `detect-bill-changes` on the DB-only migrate task-def would fail T2 (no embed) and/or under-score silently. **Any downstream section (e.g. s11 §11.2 Step 2, s12 §12.4 Step 2) that invokes `detect-bill-changes` MUST target the serve task-def `capiro-dev-intel-api` with container `intel-api` — NOT the migrate task-def / `$JOBS_TD` migrate-family shape. If a `--catch-up` run is needed, it is still `detect-bill-changes` on the serve task-def.**

- Reads legacy `tracked_bill` (raw SQL, cross-tenant via `withSystem`): `clientId, billId, note, source, lastSeenActionText, lastSeenActionDate, lastSeenAt` (registry §5).
- Idempotent **upsert** on `intel_tracked_bill` UNIQUE `[clientId, billId]` — re-running is a no-op (mirrors Phase 2 `sync-watchlists-from-legacy` idempotency contract).
- **Carry `lastSeen*` forward verbatim** so the first `detect-bill-changes` run does **not** re-alert on already-surfaced legacy history (baseline inherited, not reset). Rows with null `lastSeenAt` baseline silently on first cycle (§6.3 step 4).
- Do NOT backfill `TrackerFeedback`/`NotificationLog` in this phase (registry §5: archive-or-later; NotificationLog matters only when delivery turns on in Phase 4/8).

---

### 6.5 Scheduling (out-of-band EventBridge) + concurrency/overlap guard

**Schedule — register out-of-band, NOT in CDK** (registry §1: prod cluster + ALB are out-of-band; same class of drop-risk as the ALB priority-15 rule in project memory): an EventBridge rule that runs `detect-bill-changes` **after** apps/api `sync-congress`. **UNVERIFIED — confirm the current `sync-congress` schedule** before setting; recommended daily, staggered ~30 min after it.

**Run `detect-bill-changes` on the SERVE (or a dedicated job) task-def, not the DB-only migrate task-def** (it needs Bedrock + full env, per §6.4 note):
```
aws events put-rule --name capiro-dev-detect-bill-changes \
  --schedule-expression 'cron(30 12 * * ? *)' --state ENABLED   # confirm time vs sync-congress
aws events put-targets --rule capiro-dev-detect-bill-changes --targets '[{
  "Id":"1","Arn":"<capiro-dev cluster ARN>","RoleArn":"<events-invoke-ecs role ARN>",
  "EcsParameters":{"TaskDefinitionArn":"capiro-dev-intel-api","LaunchType":"FARGATE",
    "NetworkConfiguration":{"awsvpcConfiguration":{"Subnets":[...],"SecurityGroups":[...],"AssignPublicIp":"DISABLED"}}},
  "Input":"{\"containerOverrides\":[{\"name\":\"intel-api\",\"command\":[\"detect-bill-changes\"]}]}"
}]'
```
- Container name in the override MUST be **`intel-api`** (serve container name, registry §1), not `intel-api-migrate`.
- `<events-invoke-ecs role ARN>` = the EventBridge→ECS `RunTask` role (must have `ecs:RunTask` on this task-def + `iam:PassRole` for BOTH the intel-api task role and execution role). **UNVERIFIED — confirm the role ARN and its PassRole grants; owner Eng.** (Registry §1 execution-role inline policy covers ECR pull + Secrets read only; PassRole for the events role is separate.)
- Document this rule name + target task-def in plan §7 out-of-band inventory so a future `cdk deploy` does not drop it.

**Concurrency / anti-double-run:** legacy `detect-tracker-alerts.ts` has **no explicit lock** — safe today only because EventBridge fires once/day and the snapshot advance is per-row idempotent. Because a manual `run-task` can overlap the scheduled run, the shadow port MUST add:
- **Postgres advisory lock at cycle start** (§6.3 step 0): `SELECT pg_try_advisory_lock(hashtext('intel:detect-bill-changes'))`; on `false` → log `SKIP_OVERLAP`, exit 0. Release with `pg_advisory_unlock(...)` in `finally`. **Take the lock on a dedicated, non-transactional connection** (session-level advisory lock; if taken inside a `withSystem`/`withTenant` transaction it releases at commit — take it on the base client before the per-bill transactions, release after).
- **Idempotency holds even without the lock** via the strictly-newer-than-`lastSeenActionDate` filter + per-row snapshot advance: an interleaved second run sees the advanced snapshot, so a move is written to `intel_alert` at most once. The advisory lock is belt-and-suspenders to avoid wasted Bedrock calls + log noise.
- `intel_alert` write is not deduped by a unique key in this phase. Duplicate `new` rows for one move only occur if the snapshot fails to advance — which by design re-triggers intentionally. If dedup-on-write is later desired, add UNIQUE `[clientId, billId, kind, <detectedDate>]`; **defer** — Phase 5 parity measures the natural output first.

**Deploy order (registry §1, same as apps/api `scripts/deploy-dev.sh`):**
1. Preflight (account `967807252336`, region `us-east-1`, target SHA, `/health` on current serve task).
2. **Build+push arm64** image (registry §1 command; `docker buildx --platform linux/arm64 -f apps/intel-api/Dockerfile -t …/capiro/dev/intel-api:latest -t …:<GIT_SHA> --push`, or CI `.github/workflows/intel-api-image.yml`). ARM64 is mandatory — prod Fargate is arm64; an amd64 push won't pull (project-memory arch gotcha).
3. **Run MIGRATE task** (`capiro-dev-intel-api-migrate`, `prisma migrate deploy`, creates `intel_tracked_bill` + `intel_alert`); wait STOPPED + exit 0.
4. `update-service capiro-dev-intel-api --force-new-deployment`; wait stable (picks up new serve env: `EMBEDDINGS_MODEL`, etc.).
5. `backfill-tracked-bills` one-off (§6.4) — after migrate created the tables.
6. **Only AFTER migrate succeeds:** register the EventBridge rule (§6.5) — never before the tables exist.

Web (`capiro-dev-web`) is unchanged this phase (no ALB rule, no web wiring). Migrate ALWAYS before service roll (registry §1).

---

### 6.6 Success criteria

All checks are independently verifiable via one-off ECS tasks (`diag-*`-style — project memory: the only working path for ad-hoc read-only SQL on prod Aurora) or `aws logs` on `/capiro/dev/intel-api` (streams `intel-api`, `intel-api-migrate`; registry §1 — do NOT look in `/capiro/dev/api`). Every row has a command/metric, a threshold, a gate, and an owner.

| # | Check | Who / how | Threshold / expected | Gate it unblocks |
|---|---|---|---|---|
| **T0** | withTenant/withSystem + Nest job runner exist | Eng: `node dist/job.js noop-selftest` (§6.0) | withSystem readback `app.bypass_rls='on'`; withTenant readback = passed uuid; exit 0 | ALL of Phase 3 |
| **T1** | intel-api role (`capiro_app`) reads NULL-tenant `context_embeddings` bill rows | Eng: `diag`/job runs §6.1 cosine SQL for a bill-heavy client (no tenant GUC needed — `tenant_id IS NULL` clause) | **>0** candidate rows with `score>=0.30`; non-zero `0.40*semantic` term on ≥1 rec | 6.1 semantic leg; whole phase |
| **T2** | Task role has `bedrock:InvokeModel` for Titan embed AND intel-api task actually assumes it | Eng: `detect-bill-changes` log shows a successful `embedText` (1024-dim vector); grep `/capiro/dev/intel-api` for `AccessDenied` | Zero Bedrock `AccessDenied`; embed latency logged; verify task-def `taskRoleArn` = shared ApiTaskRole | 6.1 semantic leg |
| **T3** | Shadow detect produces `intel_alert` rows | Eng: seed a tracked bill w/ stale `lastSeen*` + a known material action, run `detect-bill-changes`; `SELECT status,count(*) FROM intel_alert GROUP BY status` | ≥1 row, **all `status='new'`**, `deliveredAt IS NULL`; `evidence` Json populated (`stage,actionText,url,why`) | Phase 4 (scoring/delivery) |
| **T4** | **No delivery / single-sender intact** | Eng: after a full shadow cycle across pilot tenants — `SELECT count(*) FROM intel_notification_log WHERE tenant_id IN (<shadow tenants>)`; grep logs for `fanOut`/SES send/`emitIntelligenceChange` | notification_log **= 0**; **zero** fanOut/SES/IntelligenceChange occurrences | Cutover safety (Phase 8) |
| **T5** | classifyChange fidelity vs legacy | Eng: run ported `classifyChange`/`selectMaterialEvents` against legacy unit fixtures (`tracker-change-detector.spec.ts`, `tracker-relevance.util.spec.ts`) copied into intel-api (note intel-api jest 0-test reparse gotcha — run via tsx if jest discovers 0) | **100%** of legacy spec cases pass unchanged (incl. `bill_rule_reported`→`floorVote`, §6.3 ¹; the s8 parity classifier bucket for `floorVote` MUST contain `bill_rule_reported`) | Phase 5 parity |
| **T6** | Measured agreement vs legacy on a sample | Eng: over a shared window, join legacy `IntelligenceChange`/`tracked_bill` alerts vs `intel_alert` on `(clientId, billId, changeType)` for the pilot tenant | **≥95%** overlap of the material-move set; **zero** legacy-`critical` moves missing from intel | Phase 5 sign-off → Phase 8 |
| **T7** | Job idempotent + overlap-guarded | Eng: run `detect-bill-changes` twice back-to-back (no new actions between); then two concurrently | 2nd sequential: `alerted=0`, `intel_alert` count unchanged; concurrent: logs `SKIP_OVERLAP`, exits 0, no duplicate rows | Scheduling (6.5) |
| **T8** | Backfill idempotent + preserves baseline | Eng: run `backfill-tracked-bills` twice; compare `intel_tracked_bill` count + `lastSeen*` | 2nd run no-op (count stable); `lastSeen*` carried from legacy; first detect run does NOT re-alert historical state | 6.4 → detect cycle |
| **T9** | EventBridge rule out-of-band, correct target, after migrate | Eng: `aws events describe-rule --name capiro-dev-detect-bill-changes` + `list-targets-by-rule` | Rule ENABLED; target task-def=`capiro-dev-intel-api` (serve), container `intel-api`, correct cluster/subnets; events role has PassRole; documented in plan §7 inventory | Ongoing shadow runs |
| **T10** | Pool headroom (no Aurora exhaustion) | Eng: during a scheduled `detect-bill-changes` run, sample `SELECT count(*) FROM pg_stat_activity WHERE usename='capiro_app'` vs `max_connections` | Peak `capiro_app` conns + apps/api steady-state ≤ 80% of `max_connections`; job uses bounded `connection_limit` | Scheduling (6.5) |

**Scoped verification (one-shot shadow run + assertions), pilot = capiro-internal + "Aperture Defense Systems"** (`[...]` subnets/SGs **UNVERIFIED** — resolve per registry §1 before running):
```bash
# 1. (deploy order §6.5 already run: build+push arm64 -> migrate -> roll serve)
#    backfill on the DB-only migrate task-def (T8)
aws ecs run-task --cluster capiro-dev --launch-type FARGATE \
  --task-definition capiro-dev-intel-api-migrate \
  --network-configuration 'awsvpcConfiguration={subnets=[...],securityGroups=[...],assignPublicIp=DISABLED}' \
  --overrides 'containerOverrides=[{name=intel-api-migrate,command=["backfill-tracked-bills"]}]'

# 2. shadow detect on the SERVE task-def (needs Bedrock + full env) (T3/T1/T2)
#    container name is `intel-api` (serve), NOT `intel-api-migrate` — see §6.4/§6.5
aws ecs run-task --cluster capiro-dev --launch-type FARGATE \
  --task-definition capiro-dev-intel-api \
  --network-configuration 'awsvpcConfiguration={subnets=[...],securityGroups=[...],assignPublicIp=DISABLED}' \
  --overrides 'containerOverrides=[{name=intel-api,command=["detect-bill-changes"]}]'

# 3. assert via diag one-off (read-only SQL on shared Aurora):
#    SELECT status, count(*) FROM intel_alert GROUP BY status;          -- expect only status='new'  (T3)
#    SELECT count(*) FROM intel_notification_log;                        -- expect 0                   (T4)
```

**Phase 3 done when:** T0–T10 pass on the pilot tenant; `intel_alert` rows exist with evidence and `status='new'`/`deliveredAt=null`; `intel_notification_log` empty and zero fanOut/SES/IntelligenceChange for shadow tenants (single-sender intact); ≥95% material-move agreement with legacy and zero missed criticals; the detect job is advisory-lock guarded, idempotent, and pool-bounded; the out-of-band EventBridge rule (serve task-def target, PassRole verified) is registered post-migrate and documented in plan §7. This unblocks Phase 4 (scoring + delivery, still shadow) and feeds the Phase 5 parity gate.

**Registry corrections surfaced by this phase (fix upstream):** (1) GUC name is `app.current_tenant`, bypass GUC `app.bypass_rls='on'` — not `app.current_tenant_id` (§4). (2) `bill_rule_reported`→`floorVote`, not `committeeVote` (§6) — this correction MUST propagate to every restatement of the `classifyChange` table downstream (registry §6 and any section citing it), so the s8 Phase 5 parity classifier's `floorVote` bucket includes `bill_rule_reported` and the port byte-matches legacy. (3) intel-api has NO `withTenant`/`withSystem` and NO `--job` runner; `enable-feature` is inline `node -e`, not a Nest-context verb — §1's "established verb dispatch pattern" is misleading. (4) `context_embeddings` READ policy already permits NULL-tenant reads for `capiro_app` — §4's blanket "UNVERIFIED, role may be blocked" is over-cautious (real check is which role intel-api uses = T1). (5) `detect-bill-changes` runs on the SERVE task-def (`capiro-dev-intel-api`, container `intel-api`) because it needs Bedrock + full env — NOT the DB-only migrate task-def; downstream sections that run it (incl. any `--catch-up` invocation in s11 §11.2 / s12 §12.4) must use the serve task-def, not the migrate-family `$JOBS_TD` shape (§6.4/§6.5).

---

## 7. Phase 4 — Unified alerts, scoring & delivery (shadow)

**Goal (unchanged from §3 Phase 4):** stand up the unified alert model, the S6 composite scorer, and the ported delivery stack (SES email + digests + `intel_notification_log`) inside `apps/intel-api`, running **in shadow** behind the ownership flag `tracker_owner_intel`. In shadow the pipeline **computes + logs would-send payloads and sends nothing**. Effort ~4–5 d. Depends on Phase 3 (`intel_alert` rows already being written by `detect-bill-changes`).

> **Registry alignment (verbatim from registry unless flagged):** SES from-address = env `TRACKER_ALERT_EMAIL_FROM`, region = env `AWS_REGION_DEFAULT` (§2, verified `apps/api/src/tracker/notifications/tracker-email.service.ts:2,19-22`). Idempotent `alertId = 'tracker:' + clientId + ':' + billId + ':' + changeType` (§6, verified `tracker-alert.service.ts:71-73`). Ownership flag `tracker_owner_intel` is NEW/to-add (§3); guard returns **404** when disabled (§3). Global kill-switch `TRACKER_ALERTS_ENABLED` (§2, verified `tracker-alert.service.ts:169,254`).
>
> **⚠️ Tables not in the registry — plan-owned, treat as UNVERIFIED until schema lands.** The registry §4 enumerates only the GLOBAL apps/api tables intel-api *reads*; it does NOT define `intel_alert`, `intel_alert_digest_queue`, `intel_notification_log`, `intel_watchlist`, `intel_topic`, or `intel_term`. These are Phase-2/3 migration outputs owned by this plan. Every reference below to those tables is contingent on their migrations having shipped (Phase 2/3) and their column/@@unique names matching. **Before writing any 7.2 code, confirm the actual @@map names and the `@@unique` on the notification-log table from the merged Phase-2 Prisma schema — do not assume from this draft.**
>
> **⚠️ Watchlist table naming conflict (registry §5).** The registry explicitly warns the tracker port tables `intel_topic`/`intel_term` are **PROPOSED/new** and must NOT be conflated with the EXISTING hearing tables `intel_watchlist`, `intel_watchlist_term`, `intel_watchlist_match`. 7.1's client-priority factor reads a matched-topic priority column: the source column name (`intel_topic.priority` vs `intel_watchlist_term`-carried priority) is **UNVERIFIED — must confirm against the merged Phase-2 schema before coding.** The draft's earlier `intel_watchlist_topic.priority` was invented and is corrected below.
>
> **⚠️ Canonical jobs task-def for Bedrock/SES verbs (cross-section standard — use verbatim).** Bedrock/SES-needing verbs (`detect-bill-changes`, `flush-digests`, `emit-bill-alerts`, and the Phase-5 `parity` verb) MUST run on the dedicated one-off jobs task-def **`capiro-dev-intel-api-task`** with container name **`intel-api`** (a clone of the SERVE task-def env — full `TRACKER_*`, SES from-address, Bedrock — command overridable), registered per plan §3 Phase 1 (`intel-api-task-taskdef.json`). This is the SINGLE task-def for these verbs and is used identically in every `run-task` command in §4, §6, §7, §11 (§11.2), and §12. The migrate task-def `capiro-dev-intel-api-migrate` (container `intel-api-migrate`) carries **only DB_\* secrets + `DB_NAME` env** (registry §2) and MUST be used ONLY for DB-only verbs (`migrate`, `enable-feature`, `sync`, `backfill`) — never for detect/flush/emit/parity, which would fail there for lack of SES/Bedrock env. Any run-task command in s4/s6/s7/s11/s12 that targets the migrate family for an alert/detect/emit/parity verb is a defect against this standard and must be re-pointed to `capiro-dev-intel-api-task` + container `intel-api`.

---

### 7.1 AlertScorer — S6 weighted composite

`AlertScorer.score(alert)` produces a float `score ∈ [0,1]` stored on `intel_alert.score`, then bucketed to a display band. Ported logic combines the Phase-3 matcher output (`fit`) with change-detection severity/materiality. **These weights are the plan's §6 weights, restated verbatim; the registry did not supply a competing set, so they are authoritative FOR THIS PLAN (not from the canonical registry — do not cite them as registry-verified).**

| Factor | Weight | Computed from (real fields) | Normalization |
|---|---|---|---|
| relevance | 0.35 | `fit` from Phase-3 composite `max(0,min(1, 0.4·semantic + 0.3·textMatch + 0.15·exactEntity + 0.1·subjectMatch + 0.05·priorityBoost))` (registry §6, verbatim). semantic = cosine `1-(embedding<=>qvec)` vs `context_embeddings` (`source_type='bill'`, `model=EMBEDDING_MODEL`; registry §6 SQL) | already 0–1 |
| materiality | 0.25 | `MATERIALITY_RANK[intel_alert.materiality]` (low1/med2/high3; registry §6) ÷ 3 | /3 → 0–1 |
| urgency | 0.20 | recency of `latestActionDate`/action `date`: `1.0` ≤24h, `0.7` ≤7d, `0.4` ≤30d, `0.1` older; then **override to `1.0`** if `changeType ∈ {bill_enacted, bill_to_president, bill_failed}` (the three `critical`/`enactedFailed` rows, registry §6) | clamped 0–1 |
| political/speaker | 0.10 | bill path: `0` (no speaker signal). Reserved for hearing alerts (stance intensity from F2). Slot kept so bill vs hearing scores stay comparable | 0–1 |
| client-priority | 0.10 | matched topic/term `priority` (low0.33/med0.66/high1.0); take max over matched topics. **Source column UNVERIFIED (see naming conflict above) — confirm the priority field on the shipped topic/term table before wiring** | 0–1 |
| confidence penalty | −(0..0.15) | subtract when only ONE leg contributed (keyword-only, no semantic corroboration) OR `fit < RECOMMENDATION_FLOOR` (0.45; registry §6); penalty = `0.15·(1 − legCoverage)`, legCoverage = fraction of {semantic,keyword,entity,subject} legs that fired | subtracted last, then clamp 0–1 |

Band mapping (display + digest grouping only — does NOT gate send): `High ≥ 0.66`, `Med ≥ 0.45`, else `Low`. Persist both `score` (float) and the band so Phase-5 parity can diff numerically.

**Ordering (cost control, registry §7 mitigation):** compute `fit` in Phase 3 → store on the alert row; the Phase-4 scorer reads stored `fit` + severity/materiality + action dates and **never re-embeds**, so the scoring pass needs NO Bedrock call. (Bedrock task-role perms remain a detect-job go-live blocker, §7.6, not a Phase-4 blocker.)

---

### 7.2 Ported delivery services (`apps/api/src/tracker/notifications/` → `apps/intel-api/src/intel-alert/`)

Port verbatim, re-pointed at intel-api models. Files (registry §6, all confirmed present under `apps/api/src/tracker/notifications/`): `tracker-alert.service.ts`, `tracker-email.service.ts`, `tracker-email.templates.ts`, `tracker-notification.types.ts`, `tracker-summary.service.ts`, `sms/sms.service.ts` (dormant). Rename target classes `Intel*`, keep method signatures.

| Ported behavior | Source (verified) | intel-api target |
|---|---|---|
| `alertId(clientId,billId,changeType)` = `'tracker:'+…` | `TrackerAlertService.alertId` (verified `tracker-alert.service.ts:71-73`) | keep string EXACTLY (parity + idempotency depend on it) |
| `claim(...)` = INSERT notification-log, P2002 → return null/skip | verified `tracker-alert.service.ts:79-99` | write `intel_notification_log`, ON CONFLICT the shipped `@@unique` (confirm columns — draft assumes `(alertId,userId,channel)`) |
| `claimAndEnqueueDigest` = log.create + digest-queue.create in ONE tx | verified `tracker-alert.service.ts:120-161` | same tx over `intel_notification_log` + `intel_alert_digest_queue` |
| SES send | `TrackerEmailService` uses `SESv2Client` + `SendEmailCommand`, `FromEmailAddress=TRACKER_ALERT_EMAIL_FROM`, region=`AWS_REGION_DEFAULT` (verified `tracker-email.service.ts:2,19-22,25`) | identical; add `@aws-sdk/client-sesv2` dep to intel-api |
| quiet-hours | `isWithinQuietHours` ET via `Intl.DateTimeFormat('America/New_York')`, midnight-wrap (registry §6) | port pure fns unchanged |
| cadence | email realtime→send now / daily\|weekly→enqueue; SMS realtime (unless quiet)→now / else daily digest (verified `tracker-alert.service.ts:184-243`) | unchanged |
| `flushDigests(cadence)` | cross-tenant drain via `withSystem`, `where cadence, flushed:false` take 5000, group by tenant\|user\|channel, mark flushed regardless of send outcome — poison-row safety (verified `tracker-alert.service.ts:253-334`) | unchanged logic; add concurrency lock (§7.3a); SMS digest body `Capiro: N tracked-bill update(s). {link}` ≤320 chars |
| summaries | `TrackerSummaryService` gated on `TRACKER_ALERT_SUMMARY`, `SUMMARY_TIMEOUT_MS=15000`, fail-safe→null, metered to `ai_usage_events` (registry §6) | **BLOCKED — see §7.6**; ship with `TRACKER_ALERT_SUMMARY` unset until the metering table + resolver are confirmed |

**CRITICAL PORT BLOCKER — Prisma tenant helpers do not exist in intel-api (CONFIRMED, not merely suspected).** The source service calls `this.prisma.withTenant(tenantId, tx=>…)` and `this.prisma.withSystem(tx=>…)` throughout (verified `tracker-alert.service.ts:88,107,132,171,257,295,308,326,347,350`). intel-api's `PrismaService` is a bare `PrismaClient` with only `onModuleInit/onModuleDestroy` — **no `withTenant`/`withSystem`** (verified `apps/intel-api/src/prisma/prisma.service.ts:14-26`; its docstring states tenant isolation is *"enforced in application code,"* NOT via RLS session vars). This matches the registry §4 RLS gotcha.

**Resolution required before ANY delivery port (pick one, document which):**
- **(a)** Add `withTenant(tenantId, fn)` / `withSystem(fn)` to intel-api `PrismaService` mirroring apps/api (SET `app.current_tenant_id` per tx), AND confirm intel-api's DB role is subject to (or explicitly exempt from) the same RLS policies on the tenant-scoped tables it touches. Per registry §4, intel-api SHARES the api task role but its DB **role** (`DB_USER` from `capiro/dev/aurora/app` vs `master`) is **UNVERIFIED** — a different Postgres role will hit different RLS/GRANT behavior. Confirm the role can read `context_embeddings` NULL-tenant rows (§4) and can `SET app.current_tenant_id`.
- **(b)** Port delivery to explicit `tenantId`-filtered queries with NO RLS reliance (application-code isolation, matching intel-api's stated model). `flushDigests`' cross-tenant drain then needs an explicit "all tenants" query path that is safe ONLY because it runs as a trusted out-of-band job — document that the drain intentionally reads across tenants and re-scopes per group before rendering.

Do not port blind. Whichever path, add a scoped-read test (success criterion S8).

---

### 7.3 Delivery verbs, task-def, and one-off run

intel-api is HTTP-only with a single `bootstrap()` (registry §6 note). Add entrypoint verb dispatch to `scripts/entrypoint.sh` mirroring the existing `enable-feature` verb: `flush-digests <daily|weekly>` → `IntelAlertService.flushDigests(cadence)`; `detect-bill-changes` (from Phase 3) as its own verb; `emit-bill-alerts` (from Phase 3) as its own verb.

**Task-def selection (do NOT run alert verbs on the migrate task-def).** The migrate task-def `capiro-dev-intel-api-migrate` carries **only DB_\* secrets + `DB_NAME` env** (registry §2) — it has no SES/Bedrock/`TRACKER_*` env, so `flush-digests`/`detect-bill-changes`/`emit-bill-alerts` would fail there. Per the cross-section standard (§7 top note), the Bedrock/SES-needing verbs run on the dedicated one-off jobs task-def **`capiro-dev-intel-api-task`** (clone of the SERVE task-def env — full `TRACKER_*`, SES from-address, Bedrock — command overridable; container name `intel-api`), registered per plan §3 Phase 1 (`intel-api-task-taskdef.json`). This is the SAME task-def referenced in §4, §6, §7, §11 (§11.2), and §12 — do not substitute the migrate family, the serve service name, or any per-section variant. One-off run (shape from registry §1; **subnets/SGs UNVERIFIED — confirm from `scripts/deploy-ingestion-out-of-band.sh` run_job_wait template / resolved task-defs**):

```
aws ecs run-task --cluster capiro-dev --launch-type FARGATE \
  --task-definition capiro-dev-intel-api-task \
  --network-configuration 'awsvpcConfiguration={subnets=[...],securityGroups=[...],assignPublicIp=DISABLED}' \
  --overrides 'containerOverrides=[{name=intel-api,command=["flush-digests","daily"]}]'
```

> Note the container name is `intel-api` (serve container), NOT `intel-api-migrate` — the draft's earlier example incorrectly overrode `intel-api-migrate` on the migrate task-def, which lacks the SES/Bedrock env these verbs need. Use `capiro-dev-intel-api-task` + container `intel-api` for `detect-bill-changes`, `flush-digests`, `emit-bill-alerts`, and the Phase-5 `parity` verb. Reserve `capiro-dev-intel-api-migrate` + container `intel-api-migrate` for DB-only verbs (`migrate`, `enable-feature`, `sync`, `backfill`) ONLY.

**Deploy ordering (registry §1, verbatim):** any image change ships migrate-first: (1) arm64 build+push via `capiro-build-intel-api` (ARM_CONTAINER) or `.github/workflows/intel-api-image.yml` — **never an amd64 local build**; (2) run `capiro-dev-intel-api-migrate` task (container `intel-api-migrate`, command `migrate`), wait STOPPED + exit 0; (3) `update-service capiro-dev-intel-api --force-new-deployment`, wait stable; (4) the one-off jobs task-def `capiro-dev-intel-api-task` is (re)registered but only INVOKED manually in shadow. Phase 4 adds no ALB rule (intel-api stays internal-only on :4300; §7 registry note).

**Schedule (Phase 8+, out-of-band EventBridge, NOT in CDK; mirror legacy `flush-tracker-digests`):** daily + weekly rules via `aws events put-rule`/`put-targets`. **In shadow these schedules stay DISABLED**; run flush manually to inspect logs. Rules target `capiro-dev-intel-api-task` (container `intel-api`) with the `flush-digests` command override.

---

### 7.3a Concurrency / locking on digest flush (NEW — was missing)

`flushDigests` drains `where flushed:false` take 5000 and marks `flushed:true` after processing (registry §6). Two overlapping runs (a manual invocation racing a scheduled one, or a retried task) can BOTH read the same unflushed rows before either marks them, double-processing a group. In shadow this only doubles log lines, but the guarantee must hold before cutover.

- **Claim-on-read:** update rows to `flushed:true` (or a `claimed_by=<taskRunId>` / `claimed_at` column) in the SAME statement that selects them (`UPDATE … WHERE flushed=false … RETURNING`), so a second run sees them already claimed. This changes the source's read-then-mark shape — implement in the port, not a verbatim copy.
- **Or advisory lock:** wrap the drain in `pg_advisory_xact_lock(<cadence-derived key>)` so only one flush per cadence runs at a time.
- Idempotency backstop: even if two runs process the same alert, the `intel_notification_log` `@@unique` + `claim()` P2002 path prevents duplicate log/send rows (source `tracker-alert.service.ts:79-99`). Document that the log unique key is the last line of defense, not the primary one.

Verify with success criterion **S9**.

---

### 7.4 HARD delivery guard (shadow = suppress-and-log)

Single-sender guarantee (plan D5). One guard at the top of every send path, keyed on `tracker_owner_intel`. **Consistency with the strangler model:** in shadow, legacy apps/api remains the SOLE sender for ALL tenants; intel-api sends for NO tenant. At Phase-8 cutover, ownership flips PER TENANT — legacy is disabled for a tenant in the SAME change that enables `tracker_owner_intel` for it, so exactly one sender is live per tenant at any instant. Phase 4 never sends and never disables legacy.

```ts
// IntelAlertService.fanOut(event) — FIRST statement, before any claim()
const owned = await this.featureFlags.isEnabled('tracker_owner_intel', event.tenantId);
// registry §3: FeatureFlagService.isEnabled is ALWAYS-on for CAPIRO_INTERNAL_TENANT_ID
if (!owned) {
  // SHADOW: compute the exact payload, log it, write a suppressed log row, send NOTHING.
  const alertId = IntelAlertService.alertId(event.clientId, event.billId, event.changeType);
  const payload = renderAlertEmail({ ...event, url: this.boardUrl(event.clientId) });
  this.logger.log(JSON.stringify({
    shadow: true, tenantId: event.tenantId, clientId: event.clientId, alertId,
    channel: 'email', to: pref.emailAddress, subject: payload.subject,
    score: event.score, band: event.band, wouldSendAt: new Date().toISOString(),
  }));
  await this.claim(event.tenantId, event.clientId, pref.userId, alertId, 'email',
                   'suppressed(shadow)');   // idempotent row, no send
  return; // NEVER reach this.email.send()
}
// owned === true → real delivery (Phase 8 cutover only)
```

Guard placement rules (ALL must hold):
- Guard is BEFORE `this.email.send(...)` / `this.sms.send(...)` on realtime AND before `claimAndEnqueueDigest`, so shadow does NOT accumulate a digest backlog that would fire on cutover.
- `flushDigests` applies the SAME guard per (tenantId) group — a not-owned group is marked `flushed:true` with `status=suppressed(shadow)`, never sent.
- The `claim` status literal in shadow is exactly `suppressed(shadow)` (distinct from the SMS-dormant `suppressed`) so success-criteria queries count shadow-suppressions unambiguously.
- Belt-and-suspenders: the global env kill-switch `TRACKER_ALERTS_ENABLED` (verified `tracker-alert.service.ts:169,254` — `fanOut` and `flushDigests` both early-return when unset) stays **unset** on the intel-api serve AND the `capiro-dev-intel-api-task` jobs task-def envs in shadow, so even a guard bug cannot send.

---

### 7.5 SES prerequisites (prod) — sandbox, verified identity, bounces

Delivery cannot go live at cutover unless SES is production-ready. These are **prerequisites for Phase 8**, staged during Phase 4. Because intel-api SHARES the api task role (registry §1) and reuses the SAME `TRACKER_ALERT_EMAIL_FROM`, most items should already be satisfied by the LIVE apps/api tracker email path (memory: Tracker email LIVE via SES) — the job here is to CONFIRM, not re-provision, and to explicitly reuse the same identity so no dual-sender / new-verification surprise appears at cutover.

| Item | Check / action | Verify (in `967807252336`/`us-east-1`) |
|---|---|---|
| Verified identity | `TRACKER_ALERT_EMAIL_FROM` domain/address must be a verified SESv2 identity. Use the SAME from-address as apps/api so no new verification is needed. | `aws sesv2 get-email-identity --email-identity <domain>` → `VerifiedForSendingStatus=true` |
| Sandbox | Account must be OUT of the SES sandbox. Prod tracker email already reaches clients → almost certainly production-access; confirm. | `aws sesv2 get-account` → `ProductionAccessEnabled=true` |
| Task-role SES perm | intel-api SHARES the api task role (registry §1 ARNs). api already sends → role likely has `ses:SendEmail`. Registry §2 flags this **UNVERIFIED — must confirm.** | inspect role inline/attached policies for `ses:SendEmail`/`ses:SendRawEmail`, `us-east-1` |
| Bounce/complaint handling | SES sends to client-supplied `emailAddress`; high bounce/complaint risks identity suspension. Attach a configuration set with an SNS bounce/complaint destination (reuse api's if one exists). Persist `messageId` from `EmailSendResult` (verified `tracker-email.service.ts:8`) onto `intel_notification_log` for traceability. | `get-email-identity` shows `ConfigurationSetName`; SNS topic has ≥1 subscriber |
| DKIM/SPF | DKIM enabled for deliverability. | `get-email-identity` → `DkimAttributes.Status=SUCCESS` |

If the from-address DIFFERS from api's, the new identity starts in sandbox and MUST be verified + production-access requested (24–48h AWS turnaround) — schedule EARLY in Phase 4, never at cutover. **Recommendation: reuse api's identity to avoid this entirely.**

---

### 7.6 Known blockers to resolve in this phase (do not paper over)

- **Prisma `withTenant`/`withSystem` absent in intel-api** — CONFIRMED (verified `prisma.service.ts:14-26`; source calls verified at 10 sites). Resolve via §7.2(a) or (b) before ANY delivery port. Includes confirming intel-api's DB **role** (`aurora/app` vs `master`) RLS/GRANT behavior.
- **`ai_usage_events` table / `AiCredentialResolverService` in intel-api — UNVERIFIED** (registry §2, §6). Summaries stay OFF (`TRACKER_ALERT_SUMMARY` unset) until confirmed or ported; alerts send without summary (fail-safe→null is the already-ported behavior).
- **`intel_alert` / `intel_alert_digest_queue` / `intel_notification_log` schema — plan-owned, NOT in registry §4.** Confirm the shipped @@map names and the log-table `@@unique` before coding 7.2 (§7 top note). The draft assumes `(alertId,userId,channel)` — verify.
- **Watchlist topic/term priority column — UNVERIFIED** (registry §5 naming conflict). Confirm the priority source (`intel_topic` vs `intel_watchlist_term`) before wiring 7.1 client-priority.
- **`IntelligenceChange` table in intel-api — UNVERIFIED** (registry §6). In shadow the detector only writes `intel_alert` (Phase 3), so this does NOT block shadow delivery, but the in-app feed emit must be re-targeted before Phase 6.
- **Bedrock task-role perms — UNVERIFIED** (registry §2). Not needed for the scoring pass (7.1 reuses stored `fit`), so NOT a Phase-4 blocker; confirm before the detect job's semantic leg runs in the cron path (§7.6 defers to detect go-live). Note the detect/flush/emit jobs run on `capiro-dev-intel-api-task` (which carries the Bedrock env), so the perm gap is a task-ROLE grant, not a task-def env gap.

---

### 7.7 Rollback

Phase 4 writes only `intel_*` tables and log rows; it never touches apps/api tables and never sends mail in shadow. Legacy apps/api remains the sole sender throughout (strangler consistency).

- **Default back-out (no action):** leave `tracker_owner_intel` disabled — legacy stays the sole sender. This is the resting state.
- **Full back-out of shadow artifacts:** `DELETE FROM intel_notification_log WHERE status='suppressed(shadow)'` and `TRUNCATE intel_alert_digest_queue`. Legacy state is untouched.
- **Image rollback:** re-point `capiro-dev-intel-api` to the prior image tag (registry §1 `<GIT_SHA>` tags exist on ECR) and force-new-deployment; no migrate needed to roll back since Phase-4 migrations are additive-only (no destructive DDL on apps/api tables). If a Phase-4 migration must be reverted, do it as a NEW forward migration (`prisma migrate deploy` has no down-migration; registry §1 migrate mode runs deploy only).

---

### **Success criteria**

Each is independently verifiable; all must pass to unblock Phase 5 (parity) and Phase 8 (cutover). Verification runs in `967807252336`/`us-east-1`, DEV shadow unless stated. **Owner** = who signs off.

| # | Criterion | Verify (command/metric) | Threshold / gate | Owner | Unblocks |
|---|---|---|---|---|---|
| S1 | **Dry-run logs exact would-send payloads** | Run `detect-bill-changes` + `flush-digests daily` as one-off `capiro-dev-intel-api-task` runs (container `intel-api`) against pilot tenant (capiro-internal + "Aperture Defense Systems"); `aws logs filter-log-events --log-group-name /capiro/dev/intel-api --filter-pattern '"shadow":true'` | Every WOULD-send alert emits one JSON line with `to`,`subject`,`alertId`,`score`,`band`,`wouldSendAt`; line count **==** count of eligible (trigger+materiality-passing) prefs. Gate: exact equality | Release eng | Phase 5 |
| S2 | **Zero real sends in shadow (two ways)** | (a) CloudWatch `AWS/SES` `Send` metric delta **== 0** over the run window; (b) `SELECT count(*) FROM intel_notification_log WHERE status IN ('sent','failed') AND created_at > <run_start>` | Both **== 0**. Any nonzero = **HARD STOP** (guard bug). Non-negotiable single-sender gate | Release eng | Phase 8 |
| S3 | **Idempotency prevents double rows** | Run `detect-bill-changes` **twice** back-to-back (both on `capiro-dev-intel-api-task`), same window; `SELECT alertId,userId,channel,count(*) FROM intel_notification_log GROUP BY 1,2,3 HAVING count(*)>1` | **0 rows** (log `@@unique` holds; 2nd run no-op via P2002). Non-negotiable | Release eng | Phase 8 |
| S4 | **Digest guard leaves no backlog** | After a shadow run: `SELECT count(*) FROM intel_alert_digest_queue WHERE flushed=false AND tenant_id IN (<not-owned tenants>)` | **== 0** (shadow suppresses BEFORE enqueue; nothing waits to fire on cutover) | Release eng | Phase 8 |
| S5 | **Score distribution sanity** | `SELECT band, count(*), round(avg(score),3), min(score), max(score) FROM intel_alert WHERE created_at > <run_start> GROUP BY band`; plus manual factor breakdown on 5 alerts | All `score ∈ [0,1]`; not degenerate (not 100% in one band); every `changeType ∈ {bill_enacted,bill_to_president,bill_failed}` row lands in **High**; 5 spot-checked breakdowns match 7.1 weights ±0.001 | Eng (scorer author) | Phase 5 |
| S6 | **SES identity verified + prod access** | `aws sesv2 get-email-identity --email-identity <TRACKER_ALERT_EMAIL_FROM domain>` and `get-account` | `VerifiedForSendingStatus=true`, `DkimAttributes.Status=SUCCESS`, `ProductionAccessEnabled=true`; bounce/complaint SNS topic ≥1 subscriber | Release eng | Phase 8 |
| S7 | **Task-role SES perm confirmed (Bedrock deferred)** | Inspect the shared api task role (registry §1 ARNs) for `ses:SendEmail`/`ses:SendRawEmail` | `ses:SendEmail` present (resolves registry §2 UNVERIFIED). Bedrock perm explicitly DEFERRED to detect-job go-live, tracked separately | Release eng | Phase 8 |
| S8 | **Prisma tenant-context resolved + cross-tenant read blocked** | Code review of chosen §7.2 path + scoped-read test: intel-api reads/writes `intel_notification_log` for tenant A and CANNOT read tenant B's rows; `flushDigests` cross-tenant drain documented as trusted-job or RLS-exempt | `withTenant`/`withSystem` present (path a) OR explicit tenant-filtered queries with documented drain (path b) AND cross-tenant read test passes | Eng lead | Phase 8 |
| S9 | **Concurrent flush is safe (NEW)** | Launch two `flush-digests daily` one-off tasks (both `capiro-dev-intel-api-task`, container `intel-api`) simultaneously against the same unflushed set; then S3's dup query | **0 duplicate** `intel_notification_log` rows; each digest group processed once (claim-on-read or advisory lock, §7.3a) | Release eng | Phase 8 |

**Gate:** Phase 4 is DONE when **S1–S5, S8, S9** are green in DEV shadow and **S6–S7** are confirmed in prod. **S2 (zero real sends), S3 (idempotency), and S9 (concurrency-safe flush)** are the non-negotiable single-sender guarantees; failure of any one blocks cutover unconditionally.

---

## 8. Phase 5 — Parity validation

**Goal (preserved from plan):** prove that the shadow intel-api bill pipeline *decides to fire* the same alerts, on the same bills, with the same severity/materiality and comparable `fit` scores as the live legacy `apps/api` tracker — **before** any per-tenant cutover (Phase 8). This is the hard gate: no `tracker_owner_intel` flip for a tenant until its pilot-cohort parity report is green for **N=7 consecutive days**, with **zero missed criticals** and Ninja sign-off.

This phase adds **no delivery** (consistent with the single-sender model: legacy `apps/api` remains the sole sender through Phase 8) and writes **no `apps/api` tables**. It compares two already-populated, durable sources in the shared Aurora `capiro` DB:

- **Legacy (ground truth):** what legacy *decided to send*, read from `notification_log` (`@@map notification_log`, unique `[alertId,userId,channel]`, §5) joined to its owning alert row. **Read-only, never written.**
- **Shadow (candidate):** what intel *would send*, produced by Phase 3/4 in **claim-only mode** — the shadow pipeline runs `runDetectionCycle` + `claim()`/`claimAndEnqueueDigest` but MUST NOT call `fanOut`/`TrackerEmailService`/`SmsService` send paths (single-sender invariant). Parity reads those shadow rows.

Because intel-api reads legacy tables cross-DB by ID only (§4, no cross-schema FK), the parity task is a **read-mostly diff task**: it reads both sides and appends exactly one audit row per run to its own `intel_parity_run` table (§8.6). It is safe to re-run any number of times (idempotent per window+scope+sha, §8.6).

> **Confirmed plan artifacts (established upstream — do NOT re-open):**
> 1. **Shadow alert table `intel_alert`** is a CONFIRMED, intel-owned durable "one row per detected alert" table, defined in **s3 §3.1** and again in **s6 §6.3**, created by the Phase 3/4 intel-api migrations, and written on every `classifyChange` hit. Its schema (per s3 §3.1) carries `tenant_id`, `client_id`, `bill_id`, `changeType`→`@map("change_type")`, `severity`, `status`, and `createdAt`→`@map("created_at")`. Parity in §8.2/§8.4 joins against this confirmed schema — **not** against `intel_notification_log`, and the table's existence is no longer an open question. (Registry §5 lists the migrated legacy→intel field mappings; `intel_alert` is the Phase-3/4 detection-output table defined in s3 §3.1 / s6 §6.3, which the registry field-mapping table does not enumerate. Trust s3/s6.)
>
> **UNVERIFIED — must confirm before build (blocking):**
> 2. **Legacy alert table for the join.** `notification_log.alert_id` FKs an alert row whose table/`@@map` and column names (`change_type`, `severity`, `created_at`, `client_id`, `fit`) are **UNVERIFIED**. There is **no `TrackerAlertEvent` table** — that type is the in-memory event from `tracker-alert.service.ts` `fanOut`. Confirm the durable legacy alert table/`@@map` and its columns from tracker recon before writing the §8.4 join.
> 3. **Legacy column name for the decision timestamp** — confirm the exact snake_case name on the legacy alert row. On the shadow side it is `created_at` (from `createdAt`, s3 §3.1); confirm the legacy side matches or map accordingly.

---

### 8.1 The `parity-report` task

New intel-api entrypoint verb. intel-api is HTTP-only with a single `bootstrap()`, so add verb dispatch in `entrypoint.sh` / CommandFactory (§6, same refactor as the ported `detect-tracker-alerts`/`flush-tracker-digests` verbs).

**Task-def family choice — corrected.** The draft ran this on `capiro-dev-intel-api-migrate`, claiming DB-only secrets suffice. **That is wrong if §8.3 recomputes `fit`.** Recomputing the composite `fit` calls `getRecommendations` → `semanticScores` (reads `context_embeddings` via pgvector — DB-only, OK) **and may call `embedText()` → Bedrock `InvokeModelCommand`** for any query vector not already cached. Bedrock needs (a) the **serve task role** (not the migrate task role) — §2 flags `bedrock:InvokeModel` as **UNVERIFIED — must confirm** — and (b) `EMBEDDINGS_MODEL` env. Two safe options:

- **Preferred:** run `parity-report` on the **serve task-def family `capiro-dev-intel-api`** (has the full task role + Bedrock env), overriding the container command. It still needs no Deepgram/SES/Clerk to run read-only.
- **Only if** parity is proven to require **zero fresh embeddings** (every candidate bill already has a `context_embeddings` row for the model, so `semanticScores` is pure SQL and `embedText` is never hit): the `capiro-dev-intel-api-migrate` family (DB-only secrets) is acceptable. This is fragile — a single un-embedded bill breaks the run. **Default to the serve family.**

```
# Preferred: serve task-def (full task role incl. Bedrock), read-only override
aws ecs run-task --cluster capiro-dev --launch-type FARGATE \
  --task-definition capiro-dev-intel-api \
  --network-configuration 'awsvpcConfiguration={subnets=[...],securityGroups=[...],assignPublicIp=DISABLED}' \
  --overrides 'containerOverrides=[{name=intel-api,command=["parity-report","--window-days=7","--tenants=<slug|all-pilot>","--out=stdout"]}]'
```
- **`--cluster`** — DEV `capiro-dev`; PROD `capiro-prod-os-capiro` (§1).
- **`--task-definition`** — DEV `capiro-dev-intel-api`; PROD `capiro-prod-intel-api` (§1).
- **container `name`** — `intel-api` (serve container name, §1).
- **subnets/securityGroups** — **UNVERIFIED — must confirm** from `scripts/deploy-ingestion-out-of-band.sh` `run_job_wait` template / resolved task-defs (§1).

**Task role / RLS.** intel-api shares the api task role (§1), so its Prisma role sees the same RLS. Cross-tenant reads (all pilot tenants in one pass) MUST go through `prisma.withSystem(tx=>…)`; per-tenant reads through `prisma.withTenant(tenantId, tx=>…)` (§4). **UNVERIFIED — must confirm** intel-api actually exposes `withSystem`/`withTenant` **and** that its DB role is either the same as api's or RLS-exempt/granted; if intel-api connects under a *different* role, cross-tenant `withSystem` reads and NULL-tenant `context_embeddings` reads may be silently blocked (§4 RLS gotcha), which would make parity under-count legacy alerts and **falsely pass**. Validate role identity before trusting any number.

**Connection-pool impact.** This is a one-off Fargate task with its own Prisma pool; it does not share the serve service's pool. Keep its pool small (single connection is enough for sequential SQL) and cap `LIMIT 400` per §6 `semanticScores` to bound Aurora load. Do not run it concurrently with the shadow `detect-bill-changes` cycle against the same Aurora writer if that cycle is write-heavy.

**Idempotency & concurrency.** The task is read-only against both alert sources and appends **one** `intel_parity_run` row. Guard against overlapping runs (out-of-band schedule + manual re-run) with an advisory lock keyed on `(tenant_scope, window_days)` (`pg_try_advisory_lock`); if not acquired, exit 0 as a no-op (do not write a duplicate row). Re-running the same window+scope+sha yields an identical verdict (S6).

---

### 8.2 Join key & the comparison set

A legacy alert and a shadow alert are "the same alert" iff **all four** components match:

| Join component | Legacy source (`notification_log` + joined alert row) | Shadow source (`intel_alert`, defined s3 §3.1 / s6 §6.3) | Notes |
|---|---|---|---|
| **tenant** | `tenant_id` | `tenant_id` | uuid |
| **client** | `client_id` | `client_id` | uuid |
| **bill** | `bill_id` (raw string, e.g. `119-hr-1234`) | `bill_id` | `congress_bill.id` string; identical space both sides (§4) |
| **kind** (`change_type`) | legacy alert `change_type` | shadow `change_type` (`intel_alert.changeType` @map `change_type`, s3 §3.1) | MUST be one of the 9 `classifyChange` types (§6); this discriminator catches scorer/detector drift |

Canonical join key (extends §6 idempotency `alertId` with tenant): `parityKey = tenant_id + ':' + client_id + ':' + bill_id + ':' + change_type`. Stronger than legacy `alertId` (`'tracker:'+clientId+':'+billId+':'+changeType`) — the tenant prefix guarantees no cross-tenant false match.

**Window & grain.** Rolling **7 days** on the alert decision timestamp — on the shadow side this is `intel_alert.created_at` (`createdAt` @map `created_at`, s3 §3.1); on the legacy side confirm the equivalent column per §8 note 3 (`>= now() - interval '7 days'`), same window + same tenant set on both sides. Legacy `notification_log` is collapsed to **one row per `alertId`** (dedupe the `[alertId,userId,channel]` fan-out) before diffing — parity is at the **alert-decision grain**, not the delivery grain. Per-user fan-out parity is a Phase-8 delivery concern (and irrelevant here since intel does not deliver in this phase).

---

### 8.3 Metrics computed

Per tenant and rolled-up-all-pilot, over the window:

| Metric | Definition | Gate |
|---|---|---|
| **Overlap (Jaccard)** | `|L ∩ I| / |L ∪ I|` on `parityKey` sets | **≥ 0.95** |
| **Recall vs legacy** | `|L ∩ I| / |L|` | **≥ 0.95** |
| **Missed criticals** | count of `parityKey ∈ L, severity=critical, ∉ I` | **== 0** (hard) |
| **Precision (extra)** | `|L ∩ I| / |I|` | report + triage; no hard floor (over-firing is safer than missing), but **log every extra key** |
| **Score delta (matched keys)** | per matched key `|I.fit − L.fit|` (composite `fit`, §6) | **max ≤ 0.10, p95 ≤ 0.05** |
| **Severity mismatch** | matched key where `L.severity ≠ I.severity` | **== 0 for critical**; info↔notable tolerance triaged |
| **Materiality/trigger mismatch** | matched key where `triggerKey` or `clearsMateriality` verdict differs | report + triage |

`fit` uses the §6 composite `fit = max(0, min(1, 0.4×semantic + 0.3×textMatch + 0.15×exactEntity + 0.1×subjectMatch + 0.05×priorityBoost))`, floors `RECOMMENDATION_FLOOR=0.45` / `EMBED_CANDIDATE_FLOOR=0.3` / `MIN_TERM_LEN=3`, model `amazon.titan-embed-text-v2:0` (1024-dim). If legacy did not persist per-component `fit`, **recompute both sides from the same `getRecommendations` inputs inside the task** so the delta reflects **scorer** drift, not storage drift. (This is the branch that pulls Bedrock into scope — see §8.1 task-def choice.)

---

### 8.4 Missed-critical detector (non-negotiable, fails the gate independently)

**Correction:** `change_type` is never `'critical'` — **`severity`** is. The §6 `change_type` values that carry `severity='critical'` are `bill_enacted | bill_to_president | bill_failed` (all `triggerKey='enactedFailed'`). The query filters on `severity='critical'`.

```sql
-- Legacy criticals (durable) NOT reproduced by shadow, in-window.
-- L = legacy notification_log joined to its alert row (table/@@map UNVERIFIED, §8 note 2).
-- I = shadow intel_alert (CONFIRMED, s3 §3.1 / s6 §6.3; changeType @map change_type, createdAt @map created_at).
WITH legacy AS (
  SELECT DISTINCT a.tenant_id, a.client_id, a.bill_id, a.change_type, a.severity
  FROM notification_log n
  JOIN <legacy_alert_table> a ON a.id = n.alert_id        -- UNVERIFIED join; confirm table/@@map + cols
  WHERE a.created_at >= now() - interval '7 days'          -- confirm legacy col name (§8 note 3)
    AND a.severity = 'critical'
    AND a.tenant_id = ANY($1::uuid[])                       -- pilot tenants
),
intel AS (
  SELECT tenant_id, client_id, bill_id, change_type
  FROM intel_alert                                          -- CONFIRMED table (s3 §3.1)
  WHERE created_at >= now() - interval '7 days'             -- intel_alert.created_at (createdAt @map, s3 §3.1)
    AND tenant_id = ANY($1::uuid[])
)
SELECT l.*
FROM legacy l
LEFT JOIN intel i
  ON  i.tenant_id   = l.tenant_id
  AND i.client_id   = l.client_id
  AND i.bill_id     = l.bill_id
  AND i.change_type = l.change_type
WHERE i.bill_id IS NULL;   -- any row => GATE RED (missed critical)
```
Notes: (1) `tenant_id` is taken from the **alert row `a`**, not `notification_log n` — confirm the legacy alert table carries `tenant_id` (§5 says the `alert_preference`/notification chain does); `intel_alert.tenant_id` is confirmed present (s3 §3.1). If only `notification_log` carries `tenant_id`, add `n.tenant_id` and dedupe. (2) This detector runs under `withSystem` so RLS does not silently drop other tenants' criticals (a dropped critical here would **falsely pass** the hard gate). (3) Non-empty result ⇒ **hard fail**; print each missed key with evidence (bill title, `latestActionText`, `latestActionDate`, url from `congress_bill`, §4) for triage.

---

### 8.5 Discrepancy triage (matcher vs scorer vs timing vs classifier)

Every non-overlapping `parityKey` is auto-bucketed so tuning targets the right layer:

| Bucket | Detection rule | Root cause | Fix locus |
|---|---|---|---|
| **Matcher** | key in L∪I; bill was candidate-eligible both sides yet only one produced it; `semantic`/`textMatch` inputs differ | candidate selection diverged | `tracker-relevance.util.ts` (`wholeWordHit`), `keywordCandidateIds`, `semanticScores` cosine floor `EMBED_CANDIDATE_FLOOR=0.3`, `MIN_TERM_LEN=3`, embeddings model/dim (1024, titan-v2) |
| **Scorer** | matched both sides but `fit` delta > tolerance, OR one side below `RECOMMENDATION_FLOOR=0.45` and the other above | composite weight / floor drift | `getRecommendations` weights, `RECOMMENDATION_FLOOR` |
| **Timing** | present both sides but `created_at` differ > detection-cycle interval, OR present in one side's window only because the other's `runDetectionCycle` hadn't run | shadow schedule lag vs legacy EventBridge `detect-tracker-alerts` 12:00 UTC | align shadow schedule; window-edge cases handled below |
| **Classifier** | matched bill, but `change_type`/`severity` differ | `classifyChange` regex cascade order diverged (§6) | port `classifyChange` verbatim; add spec parity test |

Timing-bucket keys within one detection interval of the window edge are annotated `TIMING_EDGE` and **excluded from the overlap/recall denominators** for that run (they resolve next run). A **persistent** timing gap (same key missing 2+ consecutive runs) is re-classed to matcher/scorer/classifier and **counts** — it is a real detection defect, not an artifact.

---

### 8.6 Output, durable audit, and the streak query

- **Primary log:** structured JSON + human summary to CloudWatch. DEV log group `/capiro/dev/intel-api`; PROD `/capiro/prod-os-capiro` (§1). Stream depends on task-def family: `intel-api` if run on the serve family (§8.1 preferred), `intel-api-migrate` if run on the migrate family (§1 log streams). Grep by the JSON marker, not the stream name.
- **Durable audit table `intel_parity_run`** (intel-api-owned, created by an intel-api migration — no apps/api write): `{ id, run_at timestamptz, window_days int, tenant_scope text, tenant_id uuid null, overlap float8, recall float8, precision float8, missed_criticals int, max_score_delta float8, p95_score_delta float8, severity_critical_mismatches int, passed bool, git_sha text }`. One row per (scope) per run; write is the only mutation the task performs, guarded by the §8.1 advisory lock for idempotency. Store `git_sha` so a green streak is attributable to a specific image.
- **Optional S3 per-key dump** (`--out=s3`): **blocked today** — no S3 client in intel-api (§7). Requires adding `@aws-sdk/client-s3` + granting the **task role** `s3:PutObject` on the target bucket/prefix (**UNVERIFIED — not present**). Until then use `--out=stdout` → CloudWatch.

**Consecutive-green query — corrected.** The draft's `WHERE x.ok` counted green days but did **not** enforce **contiguity** (a green–red–green–…-green history could still count ≥7). Compute the contiguous streak ending today explicitly:

```sql
WITH daily AS (
  SELECT run_at::date AS d, bool_and(passed) AS ok
  FROM intel_parity_run
  WHERE tenant_scope = $1
    AND run_at >= now() - interval '30 days'
  GROUP BY run_at::date
),
-- flag the most-recent break in the green run
ranked AS (
  SELECT d, ok,
         min(CASE WHEN ok THEN NULL ELSE d END) OVER () AS ignored,  -- placeholder
         row_number() OVER (ORDER BY d DESC) AS rn
  FROM daily
)
SELECT count(*) AS green_streak
FROM ranked
WHERE ok
  AND d > COALESCE(
        (SELECT max(d) FROM daily WHERE NOT ok),  -- last red day
        '-infinity'::date
      );  -- counts only green days AFTER the most recent red day
```
`green_streak >= 7` is the gate for `tenant_scope = $1`. A single red day (any hard-gate failure) moves `max(d) WHERE NOT ok` forward and resets the streak to whatever green days follow it. This also requires the report to have actually **run** each of those days — a missing day is not green; verify `count(distinct d) >= 7` over the streak window separately so a scheduling gap can't masquerade as a streak.

---

### 8.7 Scheduling during the phase

Run `parity-report` **daily** for the phase duration via an out-of-band EventBridge schedule rule (NOT in CDK — same pattern/caveat as the existing `detect-tracker-alerts` and digest-flush rules; §Tracker memory: 3 LIVE rules are already out-of-band, and a `cdk deploy` MUST NOT drop this new rule). Target: `ecs:RunTask` on the **serve** task-def `capiro-dev-intel-api` with the `parity-report` command override (§8.1); the rule's EventBridge role needs `ecs:RunTask` + `iam:PassRole` for the intel-api task & execution roles (§1) — **confirm the invoker role has both** (mirror the existing tracker rules' role).

Schedule it **after** both the legacy `detect-tracker-alerts` (12:00 UTC) **and** the shadow bill-change detection cycle have completed for the day, to minimize timing-edge noise. **Suggest 13:30 UTC — UNVERIFIED: confirm the shadow detector's cadence/completion time first** and set the parity run at least one detection interval after the later of the two.

---

### Success criteria (measurable; command + threshold + gate + owner)

| # | Check | Owner / verifier | Command / metric | Threshold / expected | Unblocks |
|---|---|---|---|---|---|
| S0 | **Registry unknowns resolved** (blocking pre-req) | Release eng (Ninja) | Confirm from tracker recon: legacy alert table/`@@map` + cols (`change_type`/`severity`/`created_at`/`fit`), subnets/SGs, task role has `bedrock:InvokeModel`, intel-api Prisma role = api role (or RLS-exempt) with `withSystem`/`withTenant`. (Shadow `intel_alert` is already CONFIRMED via s3 §3.1 / s6 §6.3 — not part of S0.) | All UNVERIFIED items in §8 notes 2–3, §8.1, §8.4 closed and recorded | Build of §8.1–§8.4 |
| S1 | **Overlap ≥ 95%** | Release eng | `intel_parity_run.overlap` (also JSON in CloudWatch) | `>= 0.95` per pilot tenant **and** rolled-up | Progress toward gate |
| S2 | **Recall vs legacy ≥ 95%** | Release eng | `intel_parity_run.recall` | `>= 0.95` per tenant and rolled-up | Progress toward gate |
| S3 | **Zero missed criticals** (hard) | Release eng | §8.4 SQL returns 0 rows; `intel_parity_run.missed_criticals = 0` | `== 0` every run | Gate cannot be green otherwise |
| S4 | **Score delta within tolerance** | Release eng | `intel_parity_run.max_score_delta`, `p95_score_delta` | `max ≤ 0.10`, `p95 ≤ 0.05` | Gate |
| S5 | **Critical severity mismatch == 0** | Release eng | `intel_parity_run.severity_critical_mismatches` | `== 0` every run | Gate |
| S6 | **Reproducible / idempotent report** | Any engineer | Run S/A cmd (§8.1) on serve task-def, then read CloudWatch (`/capiro/dev/intel-api`); re-run same `--window-days`/`--tenants` | Task exits 0; JSON + one `intel_parity_run` row; re-run for the same window yields identical verdict (advisory-lock guarded, read-only diff) | Trust in the gate |
| S7 | **RLS/role soundness verified** | Release eng | Prove intel-api's role reads all pilot tenants under `withSystem` and NULL-tenant `context_embeddings` rows: run parity with 2+ tenants and confirm legacy count from a known-good direct query matches parity's `|L|` | parity `|L|` == independent legacy count (no silent RLS drop) | S1/S2/S3 trustworthy |
| S8 | **Triage buckets actionable** | Release eng | Report buckets every non-overlap key (matcher/scorer/timing/classifier) with evidence | Zero un-bucketed discrepancies | Tuning loop |
| S9 | **7 consecutive green days** | Release eng | §8.6 corrected `green_streak` query for the tenant scope, plus `count(distinct d) >= 7` (no missing days) | `green_streak >= 7` contiguous, all hard metrics green each day | **Phase 8 cutover** (`tracker_owner_intel` flip) |
| S10 | **Sign-off** | **Ninja (neo@capiro.ai)** — final go/no-go | Ninja confirms S1–S9 green for 7d in `intel_parity_run` and reviews the last triage output | Written sign-off recorded in the plan before any tenant gets `tracker_owner_intel` | **Phase 8** |

**Gate statement:** No tenant may be granted `tracker_owner_intel` (Phase 8) until, for that tenant's pilot cohort, `intel_parity_run` shows overlap ≥ 0.95, recall ≥ 0.95, `missed_criticals = 0`, `severity_critical_mismatches = 0`, `max_score_delta ≤ 0.10`, and `p95_score_delta ≤ 0.05` for **7 consecutive days** (contiguous, no missing days), with S0 (registry unknowns) and S7 (RLS soundness) closed and Ninja's written sign-off. Any hard-gate failure, or a broken/missing day, resets the streak to 0. Consistent with the strangler/shadow/single-sender model: legacy `apps/api` remains the sole sender throughout this phase; the shadow pipeline runs in claim-only mode and delivers nothing.

---

## 9. Phase 6 — Combined feed + bill-hearing linking

**Intent (preserved from §3 Phase 6, ~5–6 d):** three deliverables — (1) a Bill↔Hearing linker that resolves hearing entity/session references to `intel_tracked_bill` and emits a `combined` `intel_alert`; (2) the per-client feed API merging bill + hearing + combined alerts with evidence + `recommendedAction`; (3) promotion of existing `intel_watchlist_match` rows into `intel_alert` (closes the "matches sit unused" gap). All three run **in shadow** (`status='new'`, no delivery) until Phase 8; this phase adds no delivery path and MUST NOT write to `intel_notification_log` or call SES/SNS. intel-api reads apps/api tables read-only via `SourceDataRepository` and **never writes them** (consistent with the single-sender / strangler model: apps/api remains the sole writer of `congress_bill*`, and — until the Phase-8 cutover flips `tracker_owner_intel` — apps/api remains the sole delivery sender).

Prereqs (must be GREEN before starting): Phase 3 (`intel_tracked_bill` + `detect-bill-changes` shadow), Phase 4 (`intel_alert` + `AlertScorer`), Phase 5 parity gate. This section depends on the `intel_alert` shape in §2.3 and the ownership flag `tracker_owner_intel` (registry §3).

> **`intel_alert.dedupe_key` ownership (schema-authority reconciliation, do not re-fork):** the `dedupe_key` column is the load-bearing idempotency key for both the `combined` linker (9.4) and the WatchlistMatch→hearing promotion (9.5). It is **NOT** present in the Phase-3 authoritative `intel_alert` schema (s3 §3.1 defines `intel_alert` with no `dedupe_key` column), and s6 §6.5 explicitly states Phase 3's `intel_alert` has no unique dedup key and **defers** it. This section does not silently re-introduce it as a bare Phase-6 migration. Instead, **`dedupe_key` is a Phase-6 additive, backward-compatible column and unique constraint, and s3 §3.1 MUST carry a forward-reference note stating "`dedupe_key String? @unique` is added by the Phase-6 migration (see §9.4); it does not exist in the Phase-3/Phase-4 `intel_alert` and MUST NOT be assumed present before Phase 6."** With that s3 note in place: s6 §6.5's deferral is satisfied (the deferral resolves *here*, in Phase 6), s7's port continues to rely on `(alertId,userId,channel)` uniqueness living on `intel_notification_log` (unchanged — `dedupe_key` on `intel_alert` is orthogonal to and does not replace the `intel_notification_log` constraint), and s9's linker/promotion own the constraint. **Action item (blocks the Phase-6 migration): add the forward-reference note to s3 §3.1 and confirm with Ninja before writing the migration.** All references below to `dedupe_key` assume this single, Phase-6-scoped, s3-referenced definition.

> **Registry-fidelity flags carried into this section (do not silently resolve):** the following registry cells are `UNVERIFIED — must confirm` and every one gates a build decision below: `intel_alert`/`intel_tracked_bill` table existence and shape (proposed in Phases 3/4, NOT in registry §4's confirmed cross-DB list); `IntelligenceChange` in intel-api schema (registry §6 note); whether tracker reuses `intel_watchlist_term` or introduces `intel_topic`/`intel_term` (registry §5); task-role Bedrock/SES perms (registry §2); intel-api Prisma `withTenant`/`withSystem`/DB role vs apps/api (registry §4 RLS gotcha); the one-off/verb-capable task-def family name (registry §1 leaves it to Phase 1); the entity-mention bill literal; NULL-client fan-out; and the `/intel-api/*` ALB rule (none exists today, registry §1).

---

### 9.1 Source tables (grounded — do not invent)

The linker reads only these intel-api-owned tables. **UNVERIFIED — confirm each `@@map` and column against `apps/intel-api/prisma/schema.prisma` before coding** (registry §4 confirms only the apps/api GLOBAL tables `congress_bill`, `congress_bill_action`, `congress_bill_committee`, `congress_bill_subject`, `bill_text`, `state_bill`, `context_embeddings`, `clients`, `tenants`; the `intel_*` tables below are NOT in the registry's confirmed cross-DB list and are asserted by Phases 1–4, not recon):

| Model | @@map | Columns the linker uses | Status |
|---|---|---|---|
| `LiveHearingSession` | `intel_live_hearing_session` | `id`, `tenantId` (`tenant_id`), `clientId` (`client_id`, nullable), `billIds` (`bill_ids String[]`), `hearingId`, `committeeId`, `title`, `status`, `startedAt`, `endedAt` | UNVERIFIED — confirm |
| `EntityMention` | `intel_entity_mention` | `id`, `sessionId`, `tenantId`, `segmentId` (nullable), `entityType` (`entity_type`), `entityRef` (`entity_ref`, nullable), `entityLabel`, `confidence` — index `[entityType, entityRef]` | UNVERIFIED — confirm |
| `TranscriptSegment` | `intel_transcript_segment` | `id`, `sessionId`, `tenantId`, `startMs`, `endMs`, `resolvedSpeakerName`, `textCiphertext`/`iv`/`authTag` (encrypted) or `textPlain`, `issueTags` | UNVERIFIED — confirm (registry §7 names the persisted model `transcriptSegment` but not its column set) |
| `WatchlistMatch` | `intel_watchlist_match` | `id`, `tenantId`, `sessionId`, `segmentId`, `clientId`, `watchlistId`, `termId`, `termType`, `termValue`, `score`, `startMs`, `createdAt` — indexes `[tenantId, sessionId]`, `[tenantId, clientId]` | `intel_watchlist_match` name CONFIRMED (registry §5); columns UNVERIFIED — confirm |

Bill identity is the **raw string id** of `congress_bill` (e.g. `119-hr-1234`, registry §4 CONFIRMED). `intel_tracked_bill.billId` is assumed to equal that id (registry §5 states `TrackedBill.billId` maps to `intel_tracked_bill`; column-name `billId`/`bill_id` UNVERIFIED — confirm).

**UNVERIFIED — confirm before build:**
- `entityType` literal for bills. Registry does NOT state the literal the hearing extractor writes. Grep the hearing `EntityMention.create` call sites for the constant; do NOT hardcode `'bill'`.
- `intel_tracked_bill` exists and matches the Phase-3 shape (registry §5 maps `TrackedBill` cols: `note, source, lastSeenActionText, lastSeenActionDate, lastSeenAt`, UNIQUE `[clientId,billId]`).
- `intel_alert` exists and matches the Phase-4 shape (columns referenced below: `sourceType`, `kind`, `severity`, `materiality`, `score`, `clientImpact`, `urgency`, `title`, `whyItMatters`, `recommendedAction`, `evidence Json`, `status`, `unread`, `clientId`, `tenantId`, `createdAt`, `updatedAt`, and the enums for `sourceType`/`kind`/`status`/`severity`). If any differ, STOP and reconcile with the Phase-4 schema before writing the migration. **Note: `dedupe_key` is NOT part of the Phase-3/Phase-4 `intel_alert` (s3 §3.1 / §2.3) — it is added by the Phase-6 migration per 9.4 and the s3 forward-reference note above.**
- `intel_alert` has no column for a second (session) pointer on `combined` rows. **Decision needed from Ninja; default below = carry the session pointer in `evidence` Json, and ADD a `dedupe_key` unique column in the Phase-6 migration (9.4).** Do NOT add `linkedSessionId` unless Ninja approves the extra column.
- `EntityMention.entityRef` normalization: extractor may store `HR 1234` / `H.R. 1234` not `119-hr-1234`. Confirm via `SELECT DISTINCT entity_ref FROM intel_entity_mention WHERE entity_type=<BILL_TYPE> LIMIT 50` on dev; canonicalize before matching (9.2 step B).

---

### 9.2 Bill↔Hearing linker — logic

New service `apps/intel-api/src/linking/bill-hearing-linker.service.ts`; new one-off verb `link-bill-hearings`. **Verb-dispatch mechanics: UNVERIFIED — confirm which task-def family carries `task <verb>` dispatch.** Registry §1 states intel-api is HTTP-only today (single `bootstrap()`), and the only run-task shape in the registry uses the **migrate** family container `intel-api-migrate` on task-def `capiro-dev-intel-api-migrate` with `command=["enable-feature", …]`. So either (a) verbs are dispatched by the migrate/one-off container (registry's demonstrated shape), or (b) Phase 1 lands a dedicated task family. Use whichever Phase 1 actually ships, verbatim; do not invent a family name.

**Trigger scope:** a single `sessionId` (event-driven, on hearing `status → ended`) OR a `--since <ISO>` sweep (catch-up). Idempotent either way (9.4).

**Concurrency/locking:** the event hook and the scheduled sweep can process the same session concurrently. To prevent duplicate-work races (both computing evidence for the same session before either upserts), acquire a per-session Postgres advisory lock at the top of `linkSession(sessionId)`: `SELECT pg_try_advisory_xact_lock(hashtext('link:' || $sessionId))`; if not acquired, skip (another worker owns it). The `ON CONFLICT (dedupe_key)` upsert (9.4) is the correctness backstop; the advisory lock is the efficiency backstop. Same pattern for `promoteMatches(sessionId)`.

**Algorithm (per session, all tenant-scoped via `prisma.withTenant(tenantId, …)` — registry §4 RLS gotcha; cross-tenant sweeps use `prisma.withSystem`). UNVERIFIED — confirm intel-api exposes `withTenant`/`withSystem` and that its DB role can read `context_embeddings` NULL-tenant rows and the GLOBAL `congress_bill*` tables (registry §4 RLS gotcha: if intel-api connects under a different DB role than apps/api it is subject to the same RLS and may be BLOCKED). If intel-api uses a distinct role, verify GRANTs on `intel_*` tables AND that RLS session-var (`app.current_tenant_id`) is set per query.**

```
A. Load session S = intel_live_hearing_session where id=$sessionId (within withTenant(S.tenantId)).
   Candidate bill refs = distinct union of:
     - S.billIds[]                                     (curated at session create)
     - SELECT entity_ref FROM intel_entity_mention
        WHERE session_id=$sessionId AND entity_type=<BILL_TYPE> AND entity_ref IS NOT NULL
B. Canonicalize each ref → congress_bill.id form (119-hr-1234) per confirmed normalization rules.
   Verify existence read-only against apps/api via SourceDataRepository:
     SELECT id FROM congress_bill WHERE id = ANY($1::text[])
   Drop refs with no matching congress_bill row (log at debug; non-tracked/non-existent bills).
C. For each canonical billId, find tracked bills covering it for this session's client scope:
     SELECT id, client_id FROM intel_tracked_bill
      WHERE tenant_id=$tenantId AND bill_id=$billId
        AND ($sessionClientId IS NULL OR client_id = $sessionClientId)
   NULL-client fan-out (UNVERIFIED — confirm with Ninja): if S.clientId set → only that client's
   links; if S.clientId NULL (workspace-scoped hearing) → link ALL tenant tracked bills for that
   billId. Default = client-scoped when present, else all-in-tenant.
D. For each (trackedBill, session, billId) triple → build a combined-alert candidate.
   Gather EVIDENCE (9.3): the mention segment(s) for this bill in this session.
E. Annotate the tracked bill. DO NOT overload lastSeenActionText/lastSeenActionDate/lastSeenAt —
   those are the congress action watermark consumed by detect-bill-changes; clobbering them
   corrupts change detection. Instead: (i) write the hearing annotation into intel_alert.evidence
   only, and (ii) OPTIONAL — add nullable intel_tracked_bill.lastHearingSessionId +
   lastHearingAt in the Phase-6 migration purely for the Board badge, and set intel_alert.unread=true
   on link. Default: migration adds those two nullable columns (they are additive/backward-compatible).
F. Upsert the combined intel_alert (idempotent — 9.4).
```

`entityType` literal, canonicalization rules, and NULL-client fan-out are the three **UNVERIFIED** knobs above — resolve in a 30-min recon before coding, not by guessing.

---

### 9.3 Evidence payload shape

`intel_alert.evidence` is `Json`. Combined alerts carry BOTH sides so the feed needs no extra joins on the hot path:

```json
{
  "bill": {
    "billId": "119-hr-1234",
    "displayNum": "H.R. 1234",
    "title": "…",
    "url": "https://www.congress.gov/bill/…",
    "stage": "reported",
    "actionText": "Reported by Committee on Armed Services.",
    "actionDate": "2026-06-20"
  },
  "hearing": {
    "sessionId": "ckv…",
    "title": "HASC Markup — FY27 NDAA",
    "committeeId": "hsas00",
    "occurredAt": "2026-06-24T14:00:00Z",
    "mentions": [
      { "segmentId": "seg_…", "timestampMs": 812000, "speakerName": "Rep. Rogers",
        "quote": null, "quoteSource": "encrypted|textPlain", "issueTags": ["defense"] }
    ]
  },
  "link": { "via": "entity_mention|session.billIds", "matchedRef": "H.R. 1234",
            "confidence": 0.91, "billAlertId": "…?", "hearingAlertId": "…?" }
}
```

- Bill fields come from `congress_bill` (read-only, `SourceDataRepository`); `url` is `congress_bill.url` (registry §4).
- `mentions[].quote` obeys the encryption posture (registry §7, AES-256-GCM via `HearingCryptoService`, key `HEARING_ENCRYPTION_KEY` fallback `NOTES_ENCRYPTION_KEY`, 12-byte IV, no rotation). **Do NOT persist decrypted transcript text into `intel_alert.evidence` for encrypted segments** — store `segmentId`+`timestampMs`+`quoteSource:"encrypted"` and decrypt on feed read (9.7), preserving the fail-closed posture (registry §7/§8). For `textPlain` (public) segments, inline the quote and set `quoteSource:"textPlain"`. This also keeps `evidence` stable across `HEARING_ENCRYPTION_KEY` handling.
- `recommendedAction` and `whyItMatters` are `intel_alert` top-level columns (not inside `evidence`). For `combined`, `recommendedAction` template: *"{displayNum} was {stage} and referenced in {committee} hearing on {date} — review the {N} mention(s) and brief {client}."*

---

### 9.4 `combined` alert construction + idempotency

Reuse the NotificationLog-style stable-id pattern (registry §6). Combined alert dedup key:

```
combinedKey = 'combined:' + clientId + ':' + billId + ':' + sessionId
```

**`dedupe_key` provenance (schema-authority reconciliation):** the Phase-3/Phase-4 authoritative `intel_alert` (s3 §3.1 / §2.3) declares **no** dedup unique constraint, and s6 §6.5 explicitly **defers** it. This section resolves that deferral: `dedupe_key` is added **here, in the Phase-6 migration**, as an additive, backward-compatible column + unique constraint, and s3 §3.1 must carry the forward-reference note (see the section preamble) so s6/s7/s9 all agree on *when* the column exists (Phase 6, not before). This is **not** a competing definition — it is the single owner of the column. It also does **not** touch `intel_notification_log`'s `(alertId,userId,channel)` unique key (s7's port relies on that, unchanged and orthogonal).

**Add in the Phase-6 migration:** `intel_alert.dedupeKey String? @unique` (or `@@unique([tenantId, dedupeKey])` if global uniqueness of the key string is not guaranteed across tenants — since `dedupeKey` embeds `clientId` it is effectively tenant-unique, but the composite is safer under RLS). **Confirm the chosen constraint with Ninja before writing the migration**, and land the s3 §3.1 forward-reference note in the same change so the authoritative schema and this migration do not diverge. Idempotent upsert (raw SQL to get the conditional `WHERE` on the DO UPDATE, tenant context set via `withTenant`):

```sql
INSERT INTO intel_alert (id, tenant_id, client_id, dedupe_key, source_type, kind,
                         severity, materiality, score, client_impact, urgency,
                         title, why_it_matters, recommended_action, evidence,
                         status, unread, created_at, updated_at)
VALUES (…, $combinedKey, 'combined', 'combined', …, 'new', true, now(), now())
ON CONFLICT (dedupe_key) DO UPDATE
  SET evidence = EXCLUDED.evidence,        -- refresh mentions if more arrive
      updated_at = now()
  WHERE intel_alert.status = 'new';        -- never resurrect a dismissed/sent/reviewed alert
```

- `source_type='combined'`, `kind='combined'`. **UNVERIFIED — confirm both literals are in the Phase-4 `sourceType`/`kind` enums** (registry §2.3 is asserted, not recon-confirmed). If the enum uses a different member (e.g. `kind='combined'` not present), reconcile before build.
- `severity` = max of the two source alerts' severity via SEVERITY_RANK (registry §6 CONFIRMED: info 1 / notable 2 / critical 3). Tracked bill mentioned at a markup where it advanced → inherit `critical`/`notable` from the bill alert; passive mention → `info`.
- `score` = run `AlertScorer` (Phase 4) on the combined object; combined alerts get a co-occurrence boost, additive, capped at 1.0. **Weight TBD with Ninja (suggest +0.05, mirroring the `priorityBoost = 0.05` weight in registry §6 composite).**
- `clientImpact`/`urgency`: inherit from the bill alert if present, else default `monitor`/`med`. **UNVERIFIED — confirm the `clientImpact`/`urgency` enum members with Phase-4 schema.**
- **Ordering guarantee (shadow-model consistent):** the linker runs AFTER `detect-bill-changes` and AFTER match→alert promotion (9.5) for the same window, so both single-source alerts already exist and can be referenced by id in `evidence.link` (`billAlertId`, `hearingAlertId`). The advisory lock (9.2) prevents self-races.

**Connection-pool impact:** the sweep processes many sessions; run sessions **sequentially or with bounded concurrency (≤ Prisma pool size, default 10 minus headroom)** — do NOT `Promise.all` over all sessions, or the one-off task will exhaust the shared Aurora pool and starve the serve task (registry §1: intel-api serve on :4300 shares the same Aurora cluster/`capiro/dev/aurora/app` credentials).

**Rollback:** the linker only INSERTs/UPSERTs `intel_alert` rows with `source_type='combined'` and (optionally) touches the two additive nullable `intel_tracked_bill` hearing columns. Full undo:
```sql
DELETE FROM intel_alert WHERE source_type='combined' AND tenant_id=$t;
UPDATE intel_tracked_bill SET last_hearing_session_id=NULL, last_hearing_at=NULL WHERE tenant_id=$t;
```
No apps/api rows touched. The schema-level rollback (dropping the `dedupe_key` unique constraint/column + the score index) is exercised in S9.

---

### 9.5 WatchlistMatch → hearing `intel_alert`

Promote `intel_watchlist_match` rows into `hearing` alerts. New verb `promote-watchlist-matches` (or folded into the hearing-end hook). Per session, under `withTenant` + the same per-session advisory lock:

```
A. SELECT * FROM intel_watchlist_match WHERE tenant_id=$t AND session_id=$s
B. Group by (client_id, session_id) — ONE alert per client per hearing, NOT one per term
   (avoid alert storms; a hearing with 40 term hits → 1 hearing alert per client).
   Rank grouped terms by score desc; keep top K (K=5) as evidence quotes.
C. dedupeKey = 'hearing:' + clientId + ':' + sessionId
D. Build evidence.hearing.mentions[] from grouped matches:
     resolve each match.segmentId → intel_transcript_segment (startMs, speaker, text-pointer per 9.3).
E. severity: notable if any risk-term (termType='risk') hit, else info.
     kind = 'hearing_mention' (or 'risk_phrase' when a risk term drove it).
     UNVERIFIED — confirm 'hearing_mention'/'risk_phrase' are valid kind enum members.
F. Upsert intel_alert (source_type='hearing') with the same ON CONFLICT (dedupe_key)
   DO UPDATE … WHERE status='new' rule as 9.4.
```

`termType` values are `synonym|entity|risk` (registry §5 CONFIRMED). This closes the "matches sit unused" gap (registry §3 Phase 6). **Idempotency depends on the same Phase-6-added `intel_alert.dedupe_key` unique constraint as 9.4** (owned by the Phase-6 migration, forward-referenced from s3 §3.1); re-run refreshes evidence only while `status='new'`.

---

### 9.6 Where the linker runs

| Path | Trigger | Command |
|---|---|---|
| Event-driven | hearing `status → ended` (hook in `HearingModule` end handler) | in-process `BillHearingLinkerService.linkSession(sessionId)` + `promoteMatches(sessionId)`, each under its advisory lock |
| Catch-up / backfill | one-off ECS task | `run-task` per registry §1 shape (see below), `command=["link-bill-hearings","--since","2026-06-01"]` |
| Scheduled sweep | EventBridge rule (out-of-band, **NOT in CDK** — registry §7 risk row; a `cdk deploy` must not be expected to create it) | daily `link-bill-hearings --since 24h` as a safety net for missed hooks |

**One-off run-task command (registry §1 shape, verbatim family/container):**
```
aws ecs run-task --cluster capiro-dev --launch-type FARGATE \
  --task-definition capiro-dev-intel-api-migrate \
  --network-configuration 'awsvpcConfiguration={subnets=[...],securityGroups=[...],assignPublicIp=DISABLED}' \
  --overrides 'containerOverrides=[{name=intel-api-migrate,command=["link-bill-hearings","--since","2026-06-01"]}]'
```
- Cluster `capiro-dev` (DEV) / **PROD cluster `capiro-prod-os-capiro`** (registry §1); prod family `capiro-prod-intel-api-migrate`, prod container name still `intel-api-migrate`.
- subnets/SGs **UNVERIFIED — must confirm** from `scripts/deploy-ingestion-out-of-band.sh` run_job_wait template / resolved task-defs (registry §1).
- **The migrate task-def gets ONLY DB_* secrets + `DB_NAME` env (registry §2).** `link-bill-hearings` needs the Aurora connection (present) but NOT Deepgram. It DOES need `HEARING_ENCRYPTION_KEY` **only if** it decrypts at link time — but 9.3 stores pointers, not decrypted text, so the linker does NOT decrypt and does NOT need `HEARING_ENCRYPTION_KEY`. It needs Bedrock **only if** the combined-alert path generates summaries (default: no summary in Phase 6; `TRACKER_ALERT_SUMMARY` unset). If a verb path DOES call Bedrock/SES, it must run on a task-def whose task role has those perms (registry §2: Bedrock `bedrock:InvokeModel` and `ses:SendEmail` are **UNVERIFIED — must confirm** on the shared api task role). Confirm the migrate task-def's env/secret set covers exactly what the verb touches before shipping.

The verb runs on the migrate/one-off family per registry §1's demonstrated `enable-feature` shape. If Phase 1 lands a dedicated `capiro-dev-intel-api-task` family with its own container name, use that family + container verbatim. **UNVERIFIED — must confirm which family carries `task <verb>` dispatch (registry §1 leaves the task family name to Phase 1).**

---

### 9.7 Combined feed API

New controller `apps/intel-api/src/feed/feed.controller.ts`, route `GET /intel-api/clients/:clientId/feed`, guarded by `useIntelFeatureEnabled`-backed `tracker_v2` server guard (registry §3: `FeatureFlagService.isEnabled('tracker_v2', tenantId)`; guard returns **404 (not 403)** when disabled; ALWAYS-on for `CAPIRO_INTERNAL_TENANT_ID`). Reads `intel_alert` only (evidence denormalized per 9.3 — no live join to `congress_bill`/hearing on the hot path).

**Query params:**

| Param | Type | Default | Meaning |
|---|---|---|---|
| `sourceType` | `bill\|hearing\|combined` (repeatable) | all | filter |
| `severity` | `info\|notable\|critical` (repeatable) | all | filter |
| `status` | `new\|reviewed\|sent\|dismissed\|snoozed` (repeatable) | `new,reviewed,sent` | hide dismissed by default. **UNVERIFIED — confirm the `status` enum members against Phase-4 schema.** |
| `since` / `until` | ISO date | — | `created_at` window |
| `order` | `score\|date` | `date` | sort key |
| `cursor` | opaque | — | keyset pagination cursor |
| `limit` | int 1–100 | 25 | page size |

**Ordering + keyset pagination (no OFFSET):**
- `order=date`: `ORDER BY created_at DESC, id DESC`; cursor = `(created_at,id)` of last row.
- `order=score`: `ORDER BY score DESC, created_at DESC, id DESC`; cursor = `(score,created_at,id)`.

**SQL (date order; tenant context set via `withTenant` so RLS scopes rows — do NOT rely on the app filter alone):**
```sql
SELECT id, source_type, kind, severity, materiality, score,
       client_impact, urgency, title, why_it_matters, recommended_action,
       evidence, status, created_at
FROM intel_alert
WHERE client_id = $clientId                              -- RLS also enforces tenant scope
  AND ($sourceTypes IS NULL OR source_type = ANY($sourceTypes))
  AND ($severities  IS NULL OR severity    = ANY($severities))
  AND status = ANY($statuses)
  AND ($since IS NULL OR created_at >= $since)
  AND ($until IS NULL OR created_at <  $until)
  AND (created_at, id) < ($cursorCreatedAt, $cursorId)   -- keyset; omit on first page
ORDER BY created_at DESC, id DESC
LIMIT $limit + 1;   -- fetch one extra to compute hasMore
```
Note: `tenant_id` is enforced by RLS via the `withTenant` session var; do not additionally hardcode `current_setting('app.current_tenant_id')` in the predicate unless intel-api's role is RLS-exempt (registry §4 — **confirm intel-api's role behavior**).

**Response shape:**
```json
{
  "items": [
    { "id": "…", "sourceType": "combined", "kind": "combined",
      "severity": "notable", "materiality": "high", "score": 0.82,
      "clientImpact": "unfavorable", "urgency": "high",
      "title": "H.R. 1234 reported + referenced at HASC markup",
      "whyItMatters": "…", "recommendedAction": "…",
      "evidence": { "…": "§9.3" }, "status": "new",
      "createdAt": "2026-06-24T18:03:00Z" }
  ],
  "nextCursor": "eyJ0Ijoi…",
  "hasMore": true,
  "counts": { "bill": 12, "hearing": 4, "combined": 3 }
}
```
`counts` powers the `SubNav` badges (registry §8). Compute with a second index-backed grouped query (`GROUP BY source_type`); measure against the 9.8 budget.

**Feed decryption (fail-closed, registry §7/§8):** for `evidence.hearing.mentions[]` with `quoteSource:"encrypted"` and no inline quote, the controller batch-decrypts those segments via `HearingCryptoService` (`HEARING_ENCRYPTION_KEY`, fallback `NOTES_ENCRYPTION_KEY`) before returning; batch by session to avoid N+1. **The serve task-def already injects `HEARING_ENCRYPTION_KEY` (registry §2) — the feed runs on serve, so this is available; the migrate/verb task does not decrypt (9.6).** On decrypt failure, omit the quote (fail closed), never leak ciphertext.

---

### 9.8 Performance budget (index-backed)

The feed must be served from **one index scan on `intel_alert`**, no cross-DB join on the hot path.

**Indexes (add/verify in Phase-6 migration):**
- `order=date`: composite `[tenant_id, client_id, created_at]` (asserted in §2.3 Phase-4 schema — **verify it exists**; PK `id` provides the final tiebreak for keyset).
- `order=score`: **new** `@@index([tenantId, clientId, score, createdAt])` → `intel_alert_tenant_client_score_created_idx`.
- `source_type`/`severity`/`status` are low-cardinality → keep as filter predicates over the composite index (partial indexes not warranted at expected row counts).
- `counts` grouped query is covered by the same `[tenant_id, client_id, …]` prefix.

| Metric | Owner | Verification | Threshold | Gate |
|---|---|---|---|---|
| Feed query plan | dev | `EXPLAIN (ANALYZE, BUFFERS)` for both `order` modes on the pilot tenant's busiest client | **Index Scan** on the composite/score index; **no Seq Scan** on `intel_alert`; no cross-DB join | Phase-6 exit |
| Feed p95 latency (server-side, warm, excl. decrypt) | SRE | 100 sequential calls (limit=25) via one-off task or internal :4300 curl | **p95 ≤ 150 ms** | Phase-6 exit |
| Feed p95 latency incl. batch-decrypt (≤25 segments) | SRE | same 100 calls, UC1 client with encrypted segments | **p95 ≤ 300 ms** | Phase-6 exit |
| Row-count sanity | dev | seed ≥50k alerts for `(t,c)`; re-run `EXPLAIN` | plan stays index-backed at ≥50k | Phase-6 exit |

**ALB exposure (strangler/coexistence note):** `/intel-api/*` has **NO ALB rule today** (registry §1); intel-api is internal-only on :4300. Browser access to this feed requires ADDING a listener rule on the manually-managed/wedged `capiro-prod-alb` via `aws elbv2 create-rule` (**NOT `cdk deploy`** — registry §1). Suggested priority **12 or 17** — **UNVERIFIED, must confirm no collision** against existing priorities 3 (`/api/*`,`/webhooks/*`,`/health`), 5 (marketing), 10 (`/workspace-api/*`), 15 (`/meri-api/*`), 20 (default web) (registry §1). **This is a Phase-7 prerequisite, NOT Phase 6.** In Phase 6 the feed is verified via one-off task / internal :4300 curl only; the legacy `/api/intelligence/clients/{clientId}/tracker/*` surface (registry §8) remains the browser path and both coexist under the same `useApi()` client, gated by `tracker_v2` — no contradiction with the single-sender model since Phase 6 has no delivery.

---

### 9.9 Three end-to-end use cases (with DB writes at each step)

Bill = `119-hr-1234` (`congress_bill.id`). Client `C`, tenant `T`. All intel writes tenant-scoped; **no apps/api writes; no `intel_notification_log` writes; no SES/SNS (shadow).**

**Use case 1 — Tracked bill advances, then is mentioned in a hearing (flagship).**
| Step | Actor | Read (apps/api, RO) | Write (intel-api) |
|---|---|---|---|
| 1 | `detect-bill-changes` (Phase 3) | `congress_bill` + `congress_bill_action` vs `intel_tracked_bill.lastSeen*`; `classifyChange` → `bill_reported`/notable (registry §6) | `intel_alert` **bill** row, dedupeKey `bill:C:119-hr-1234:reported`, evidence.bill; `intel_tracked_bill.lastSeenActionText/Date/At` bumped |
| 2 | hearing capture ends | — | `intel_live_hearing_session` (`billIds` ⊇ `119-hr-1234`), `intel_transcript_segment`, `intel_entity_mention` (`entity_type=<BILL_TYPE>`, `entity_ref` canonicalizes to `119-hr-1234`), possibly `intel_watchlist_match` |
| 3 | `promote-watchlist-matches` (9.5) | resolve `segmentId`→segment | `intel_alert` **hearing** row, dedupeKey `hearing:C:<sessionId>`, evidence.hearing.mentions (pointers) |
| 4 | `link-bill-hearings` (9.2) | `congress_bill` exists check | `intel_alert` **combined** row, dedupeKey `combined:C:119-hr-1234:<sessionId>`, evidence has BOTH; `intel_tracked_bill.lastHearingSessionId/At` set; `unread=true` |
| 5 | feed API | — | none (read) → returns **3 items** (bill, hearing, combined) for C, each with evidence + recommendedAction |

**Use case 2 — Hearing mentions a bill the client does NOT track (pure hearing signal, no combined).**
| Step | Read | Write |
|---|---|---|
| 1 | hearing ends; `entity_mention` ref → `congress_bill` exists but **no** `intel_tracked_bill` row for (T,C,bill) | segments + entity mentions only |
| 2 `link-bill-hearings` | step C returns **0** tracked bills | **no combined alert** (correct) |
| 3 `promote-watchlist-matches` | if a watchlist term hit → hearing alert | `intel_alert` **hearing** row only |
| feed | — | returns **hearing** item; **no combined** |

**Use case 3 — Same tracked bill across TWO hearings (idempotency + no dup).**
| Step | Write |
|---|---|
| session A ends → link | combined alert `combined:C:119-hr-1234:sessionA` |
| session B ends → link | combined alert `combined:C:119-hr-1234:sessionB` (distinct sessionId → distinct row) |
| session A re-processed (hook + catch-up sweep overlap; advisory lock serializes) | `ON CONFLICT (dedupe_key) DO UPDATE … WHERE status='new'` → **refresh evidence, no new row** |
| feed | returns **2** combined items (one per session), never duplicated per session |

---

### 9.10 Automated test (reproduces UC 1–3) — the primary success gate

New Jest suite `apps/intel-api/src/linking/__tests__/bill-hearing-linker.e2e.spec.ts`. **Registry infra notes:** apps/api jest discovers 0 tests in worktrees (reparse points) and needs `moduleNameMapper` for exports-mapped deps; a fresh worktree needs `@capiro/shared` build + `prisma generate` before intel-api typecheck. Two consequences: (a) run against a real scratch Postgres (Testcontainers or `pg` on **`127.0.0.1`, NOT `localhost`** — IPv6 dead-end per infra memory) with the pgvector/pg_trgm/citext/uuid-ossp extensions (registry §4), migrations applied via `prisma migrate deploy` (including the Phase-6 migration that adds `intel_alert.dedupe_key`); (b) if jest won't discover in the worktree, provide a `tsx` runner `scripts/test-linker.ts` returning nonzero on failure so CI can gate on it.

Fixtures (seed via raw SQL / Prisma into scratch DB, tenant context set):
- `congress_bill` row `119-hr-1234` + a `congress_bill_action` ("Reported by Committee").
- `intel_tracked_bill` (T,C,`119-hr-1234`) for UC1/UC3; **absent** for UC2.
- `intel_live_hearing_session` with `billIds`/`entity_mention` (`entity_type=<confirmed BILL literal>`); UC3 seeds two sessions.
- `intel_watchlist_match` rows for the hearing-alert path.
- At least one **encrypted** transcript segment to exercise the pointer-not-plaintext evidence rule (9.3).

Assertions:
1. **UC1:** after linker+promote, `SELECT count(*) FROM intel_alert WHERE client_id='C'` → **3**, one each `source_type in (bill,hearing,combined)`; combined `evidence` has non-empty `bill` AND `hearing.mentions`.
2. **UC2:** exactly **0** rows `source_type='combined'`; ≥1 `hearing`.
3. **UC3:** **2** combined rows (distinct sessionId); running the linker **twice** leaves count unchanged AND does not flip a manually `dismissed` alert back to `new`.
4. **Evidence contract:** every returned feed item has non-null `recommendedAction` and `whyItMatters`.
5. **No plaintext leak:** for encrypted segments, `intel_alert.evidence` mentions have `quote=null`/`quoteSource='encrypted'` (never ciphertext, never decrypted text).
6. **No apps/api writes:** assert `congress_bill` + `congress_bill_action` row counts and `max(updated_at)` unchanged before/after.
7. **No delivery:** `SELECT count(*) FROM intel_notification_log` unchanged (0 new); all new alerts `status='new'`.

---

### Success criteria (measurable — command/metric + threshold + gate + owner)

| # | Criterion | Owner | Command / metric | Threshold / expected | Gate |
|---|---|---|---|---|---|
| S1 | UC 1–3 reproduced by automated test | dev / CI | `pnpm --filter @capiro/intel-api test src/linking` (or `tsx scripts/test-linker.ts`) against scratch pgvector DB on `127.0.0.1` | all 9.10 assertions pass, exit 0 | Phase-6 exit |
| S2 | Idempotency | dev | run `link-bill-hearings --since` **twice** on dev; `SELECT count(*),max(updated_at) FROM intel_alert WHERE source_type='combined' AND tenant_id=$t` before/after 2nd run | count unchanged; no `dismissed→new` resurrection (verify one pre-`dismissed` row stays `dismissed`) | Phase-6 exit |
| S3 | Feed returns bill+hearing+combined with evidence + recommendedAction | dev | one-off task / internal :4300 curl `/intel-api/clients/<C>/feed` for the UC1 client | ≥1 of each `sourceType`; every item non-null `evidence`, `recommendedAction`, `whyItMatters`; `counts` populated | Phase-7 UI |
| S4 | Feed query index-backed | dev | `EXPLAIN (ANALYZE, BUFFERS)` both `order` modes | Index Scan on `[tenant_id,client_id,created_at]` / score index; **no Seq Scan**, no cross-DB join | Phase-6 exit |
| S5 | Feed p95 latency | SRE | 100 warm calls, limit=25 | **p95 ≤ 150 ms** server-side (excl. decrypt); **≤ 300 ms** incl. ≤25 decrypts | Phase-6 exit |
| S6 | WatchlistMatch promotion (gap closed) | dev | seed `intel_watchlist_match`, run `promote-watchlist-matches`; `SELECT count(*),count(DISTINCT (client_id,session_id)) FROM intel_alert WHERE source_type='hearing'` | ≥1 hearing alert per (client,session) with matches; grouped (alerts = distinct (client,session), NOT per-term); dedupeKey unique (no P2002 on re-run) | Phase-6 exit |
| S7 | Shadow safety (no delivery) | SRE | after a full linker+promote run: `SELECT count(*) FROM intel_notification_log WHERE created_at >= $runStart` AND `SELECT count(*) FROM intel_alert WHERE status<>'new' AND source_type IN ('combined','hearing') AND created_at >= $runStart` | **0** new notification_log rows; **0** non-`new` alerts created by the run; no SES/SNS invocation (CloudWatch SES send metric flat for the window) | Phase-8 cutover |
| S8 | No apps/api writes | dev | assertion S1.6 + `SELECT max(updated_at), count(*) FROM congress_bill` and `…FROM congress_bill_action` before/after | both unchanged | audit / cross-DB-drift risk |
| S9 | Migration applies clean + rolls back | SRE | run `capiro-dev-intel-api-migrate` (registry §1 shape), then `\d intel_alert` + `\di` | migrate task STOPPED exit 0; `intel_alert.dedupe_key` unique constraint present (Phase-6-added, per s3 §3.1 forward-ref); `intel_alert_tenant_client_score_created_idx` present; nullable `intel_tracked_bill.last_hearing_session_id/last_hearing_at` present; rollback DELETE (9.4) removes only `source_type='combined'` rows; schema rollback drops the `dedupe_key` constraint/column + score index | deploy |
| S10 | Concurrency safe | dev | fire `linkSession(sameSession)` from two workers simultaneously (or hook + sweep overlap) | exactly 1 combined row per (client,bill,session); no duplicate-key error surfaced to caller (P2002 → skip) | Phase-6 exit |
| S11 | Pool safety on sweep | SRE | run `link-bill-hearings --since 30d` over the pilot tenant while serve task handles feed traffic | serve-task DB errors = 0; Aurora `DatabaseConnections` stays below max; sweep uses bounded concurrency | Phase-6 exit |
| S12 | RLS isolation | dev | as tenant T, run linker; `SELECT count(*) FROM intel_alert WHERE tenant_id<>$T` under T's session var | **0** (intel-api role honors RLS; cannot read/write other tenants) — confirms registry §4 gotcha resolved | Phase-6 exit |
| S13 | `dedupe_key` schema-authority reconciliation | dev | grep s3 §3.1 for the Phase-6 forward-reference note on `dedupe_key`; confirm s6 §6.5 deferral resolves to Phase 6; confirm s7 port still keys idempotency on `intel_notification_log (alertId,userId,channel)` | s3 §3.1 carries the note; no competing/second `dedupe_key` definition exists; `intel_notification_log` unique key unchanged | Phase-6 exit |

**Deploy note (registry §1 order — migrate-before-serve, arm64):**
1. **Build+push arm64** (registry command verbatim):
   ```
   docker buildx build --platform linux/arm64 \
     -f apps/intel-api/Dockerfile \
     -t 967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/intel-api:latest \
     -t 967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/intel-api:<GIT_SHA> \
     --push <REPO_ROOT>
   ```
   (CI equivalent `.github/workflows/intel-api-image.yml` triggers on `apps/intel-api/**`, `packages/meriv2-core/**`, `packages/shared/**`, `pnpm-lock.yaml`; CodeBuild DEV `capiro-build-intel-api` builds+pushes+forces redeploy, PROD `capiro-build-intel-api-prod` builds+pushes only.) **arm64 mandatory — prod Fargate is arm64; an amd64 image will not pull.**
2. **Execution-role check (pre-migrate):** the migrate task's execution role must pull from ECR and read Secrets (registry §1 inline policy `infra/deploy/intel-api-execrole-inline-policy.json`). If the Phase-6 migration adds no new secret, no exec-role change is needed. **The linker/feed add no new Secrets Manager entries** (no new API keys); Bedrock/SES perms, if any verb needs them, are on the **task role**, not the exec role — and are **UNVERIFIED (registry §2), confirm before any Bedrock/SES verb ships.**
3. **Run MIGRATE task** `capiro-dev-intel-api-migrate` (container `intel-api-migrate`, `prisma migrate deploy`; adds the Phase-6-scoped `intel_alert.dedupe_key` unique constraint + `intel_alert_tenant_client_score_created_idx` + nullable `intel_tracked_bill.last_hearing_*`; land the s3 §3.1 forward-reference note in the same change), **wait STOPPED + exit 0** before any service roll. No seed step (registry §1: intel-api migrate has no `seed-workflows.ts`).
4. **`update-service capiro-dev-intel-api --force-new-deployment`** (serve task, port 4300), wait stable. (PROD: cluster `capiro-prod-os-capiro`, service **UNVERIFIED — confirm** (`capiro-prod-intel-api` / `capiro-prod-os-capiro-intel-api`), family `capiro-prod-intel-api`.)
5. **Register the out-of-band EventBridge sweep rule** (9.6) via CLI (NOT CDK — registry §7).
6. **(Phase 7 ONLY, not Phase 6)** add the `/intel-api/*` ALB rule via `aws elbv2 create-rule` on `capiro-prod-alb` at a confirmed-free priority (registry §1).

**Feature-flag gating:** enable per-tenant with the migrate/one-off task `command=["enable-feature","tracker_v2","<tenantSlugOrId>"]` (registry §1/§3). Server guard on the feed returns **404** when `tracker_v2` disabled; frontend `useIntelFeatureEnabled('tracker_v2')` **fails CLOSED** (registry §8). `tracker_owner_intel` stays OFF in Phase 6 (shadow) — it gates the ownership/delivery cutover in Phase 8, not this phase.

---

## 10. Phase 7 — Frontend: Tracker tab unification

> Expands the existing plan's **Phase 7** (§3, "Frontend: Tracker tab becomes the unified surface"). Same intent: add **Board | Hearings | Feed | Configure** sub-views inside the client-profile Tracker tab, wire them to intel-api, gate the whole v2 surface behind `useIntelFeatureEnabled('tracker_v2')` while keeping the legacy path intact, re-scope the standalone `HearingWatchPage` to a client, wire the brief view + feedback buttons, and ship dark to prod. This section adds the concrete file diffs, the intel-api web client, the flag-gating fork, build/deploy of `apps/web`, and measurable success criteria.

**Scope guard (strangler / shadow / single-sender model):** Phase 7 is **UI + read-path only**. It does NOT move delivery ownership and does NOT send client emails. Delivery ownership is `tracker_owner_intel` (server-side, Phase 8); the single-sender invariant (exactly one service fans out alerts) is enforced there, not here. `tracker_v2` gates only which React component renders. Do not couple the two flags anywhere in this phase.

**Preconditions (must be true before starting Phase 7):**
- Phases 3–6 delivered intel-api read/write endpoints under `/intel-api/*` (board, recommendations, watchlists, tracked-bill add/remove, alert-prefs, feed, `GET /hearings/:id/brief`, feedback). **The exact route strings are the Phase-3–6 server contract — the route strings in §10.2 are reconciled against the sections that DEFINE them (watchlists → s5 §5.2, recommendations → s6 §6.2, feed → s9 §9); still CONFIRM them against the delivered intel-api controllers before merge (§10.2).**
- `tracker_v2` flag registered in intel-api (`FeatureFlagService.isEnabled(feature, tenantId)` against `intel_feature_flag`; guard returns **404 when disabled**, ALWAYS-on for `CAPIRO_INTERNAL_TENANT_ID` — §Registry-3). The web hook fails **closed** (returns `{}` on error ⇒ every flag `false` — verified in `apps/web/src/lib/intel-feature-flags.ts`, `retry:false`, `staleTime:60_000`).
- **ALB listener rule for `/intel-api/*` exists** — this is a HARD BLOCKER (§10.2). Until it lands, every `/intel-api/*` call from the browser 404s at the ALB and the fail-closed hook silently keeps all tenants on legacy. Verify via S1 before any web deploy.
- `tracker_owner_intel` (delivery ownership) is orthogonal and lives server-side (§Registry-4 cutover runbook); Phase 7 only reads `tracker_v2` for UI. Delivery stays in shadow (no sends) until Phase 8; shipping this UI does not send client emails.

### 10.1 Files touched (exact paths)

| Action | Path | Notes |
|---|---|---|
| ADD | `apps/web/src/lib/intel-tracker-api.ts` | intel-api route/key registry (mirror of `tracker-api.ts`) |
| ADD | `apps/web/src/pages/clients/tracker/TrackerTabV2.tsx` | unified surface (Board\|Hearings\|Feed\|Configure) |
| ADD | `apps/web/src/pages/clients/tracker/panels/HearingsPanel.tsx` | client-scoped hearings + brief view |
| ADD | `apps/web/src/pages/clients/tracker/panels/FeedPanel.tsx` | combined bill+hearing+combined timeline + feedback buttons |
| ADD | `apps/web/src/pages/clients/tracker/panels/ConfigurePanel.tsx` | unified watchlist editor (folds `TrackerConfigPanel` + hearing watchlist manager) |
| EDIT | `apps/web/src/pages/clients/ClientProfilePage.tsx` | fork at line **513** on `tracker_v2` (verified: `{activeTab === 'tracker' && <TrackerTab clientId={client.id} clientName={client.name} />}`) |
| KEEP (untouched) | `apps/web/src/pages/clients/tracker/TrackerTab.tsx`, `TrackerConfigPanel.tsx`, `tracker-api.ts`, `tracker-components.tsx`, `tracker-icons.tsx`, `tracker.css` | legacy fallback path — **do not modify**, so un-flagged tenants are byte-identical |
| EDIT | `apps/web/src/pages/intelligence/HearingWatchPage.tsx` | accept optional `clientId` prop; re-scope query keys/params; keep standalone route working during transition |

> **Registry correction (verified):** §Registry-8 lists custom icons in `tracker-icons.js`; the actual file is `apps/web/src/pages/clients/tracker/tracker-icons.tsx` (confirmed present, `.tsx`). Reuse it verbatim from the new panels; do not create a `.js` variant.

> **Note — `tracker.css` shared file:** the "KEEP untouched" list includes `tracker.css`, but §10.3 appends new v2 styles to it. These are compatible (append-only, new `trk-*`/`cfg-*` classes; do not alter existing selectors), but this means `tracker.css` is technically **edited**, not byte-identical. Byte-identical guarantee (S4) applies to the legacy *component* render, not the shared stylesheet. Keep v2 additions namespaced so no legacy selector changes.

### 10.2 intel-tracker-api.ts — the intel-api web client

**Base URL is unchanged.** Per §Registry-8, intel routes use the **same axios client** as everything else: `useApi()` → `buildApiClient(getToken, actAsTenantSlug)` with `baseURL = config.apiBaseUrl` (`apps/web/src/env.ts`). Intel routes are **relative `/intel-api/*`** and resolve against that baseURL. No new axios instance, no new env var. Auth (`Authorization: Bearer`) and impersonation (`x-capiro-impersonate-tenant`) are already attached by `buildApiClient`.

**Route strings are reconciled against the backend sections that DEFINE them — do not invent a `/tracker/` prefix where the defining section does not use one:**
- **Watchlist** → s5 §5.2 defines `/intel-api/watchlists/:clientId` (NOT `/intel-api/clients/:c/tracker/watchlist`).
- **Recommendations** → s6 §6.2 defines `/intel-api/clients/:clientId/recommendations` (NOT `/intel-api/clients/:c/tracker/recommendations`).
- **Feed** → s9 §9 defines `/intel-api/clients/:clientId/feed`.
- **Board / track / untrack / alert-prefs / feedback** → remain under `/intel-api/clients/:c/tracker/*` (the tracker-owned resources; confirm segment against the s6/s9 controllers, which own these).
- **Brief** → `/intel-api/hearings/:id/brief` (§Registry-7).
- **Hearings (client-scoped list)** → `/intel-api/clients/:c/hearings` (rescope of the standalone `/intel-api/hearings`, §Registry-8).

All of these still live under the single `/intel-api/*` ALB prefix — including `/intel-api/watchlists/*` and `/intel-api/clients/*` — so the one ALB rule (below) and the S3/S4 "100% of data calls under `/intel-api/*`" gates hold unchanged.

> **HARD BLOCKER (§Registry-1 ALB):** there is **NO ALB listener rule for `/intel-api/*` today** — intel-api is internal-only on `:4300`, not exposed via any ALB path prefix. Existing rules: 3 (`/api/*`,`/webhooks/*`,`/health`), 5 (marketing), 10 (`/workspace-api/*`), 15 (`/meri-api/*`), 20 (web default). A new rule for `/intel-api/*` → intel-api target group (:4300) must be created.
> - Priority: registry suggests **12 or 17** but flags **UNVERIFIED — must confirm no collision** with live rules. Do not assume; run `aws elbv2 describe-rules --listener-arn <arn>` first and pick a free priority.
> - **A new intel-api target group + listener health check on `/intel-api/health` (or `/health`) must exist and be healthy** before adding the forward rule, else the rule forwards to an unhealthy TG and all calls 502. Confirm the intel-api service is registered behind a TG on :4300 — **UNVERIFIED, must confirm** (registry says intel-api is internal-only today, so a TG may not exist yet).
> - PROD ALB `capiro-prod-alb` is manually managed/wedged — create via `aws elbv2 create-rule`, **NOT** `cdk deploy` (a `cdk deploy` could drop the out-of-band rule). DEV cluster is `capiro-dev`; PROD cluster is `capiro-prod-os-capiro`.
> - Track as a Phase 7 pre-req task, gated by S1.

```ts
// apps/web/src/lib/intel-tracker-api.ts
// Relative paths only — resolve against config.apiBaseUrl via useApi().
// Each string is reconciled with the backend section that DEFINES it (noted inline).
// CONFIRM every string below against the delivered Phase-3–6 intel-api controllers before merge.
export const intelTrackerPaths = {
  board:          (c: string) => `/intel-api/clients/${c}/tracker/board`,          // s6/s9 tracker controller
  recommendations:(c: string) => `/intel-api/clients/${c}/recommendations`,        // s6 §6.2 (NO /tracker/ segment)
  watchlist:      (c: string) => `/intel-api/watchlists/${c}`,                      // s5 §5.2 (/watchlists/:clientId)
  track:          (c: string) => `/intel-api/clients/${c}/tracker/track`,          // s6/s9 tracker controller
  untrack:        (c: string) => `/intel-api/clients/${c}/tracker/untrack`,        // s6/s9 tracker controller
  alertPrefs:     (c: string) => `/intel-api/clients/${c}/tracker/alert-prefs`,    // s6/s9 tracker controller
  feed:           (c: string) => `/intel-api/clients/${c}/feed`,                    // s9 §9
  hearings:       (c: string) => `/intel-api/clients/${c}/hearings`,               // §Registry-8 rescope of /intel-api/hearings
  brief:          (id: string) => `/intel-api/hearings/${id}/brief`,               // §Registry-7
  feedback:       (c: string) => `/intel-api/clients/${c}/tracker/feedback`,       // s6/s9 tracker controller (§Registry-2.4)
  // issue-areas: intel-api may NOT own this route. Default to legacy until confirmed (see caveat).
} as const;

// Query keys include clientId for cache isolation (§Registry-8 convention).
export const intelTrackerKeys = {
  board:  (c: string) => ['intel', 'tracker-board', c] as const,
  recs:   (c: string) => ['intel', 'tracker-recs', c] as const,
  watchl: (c: string) => ['intel', 'watchlist', c] as const,
  feed:   (c: string) => ['intel', 'feed', c] as const,
  hearings:(c: string) => ['intel', 'hearings', c] as const,   // §Registry-8 rescope
  brief:  (id: string) => ['intel', 'brief', id] as const,
};
```

> **`/intel-api/issue-areas` caveat (§Registry-8):** legacy reads `/api/intelligence/issue-areas` (verified in `tracker-api.ts:135`). Whether intel-api exposes its own `issue-areas` route is **UNVERIFIED — must confirm**. **Default to the legacy path** (`/api/intelligence/issue-areas`) from the v2 Configure panel until intel-api ownership is confirmed; do NOT add an `issueAreas` entry to `intelTrackerPaths` unless the intel-api controller actually serves it. This avoids a 404 on a path intel-api does not own.

### 10.3 Sub-tabs — exact pattern (mirror TrackerTab.tsx)

Verified against `TrackerTab.tsx`: `type Panel = 'board' | 'recs' | 'config'` (line 31), `PANEL_KEY = 'capiro:tracker:panel'` (line 32), `loadPanel()` with try/catch sessionStorage (line 36), `useState<Panel>(loadPanel)` (line 72), `setPanel()` writes back (line 76). **Reuse this exact pattern** in `TrackerTabV2.tsx` with the new Panel union and a **distinct storage key** so v2/legacy do not clobber each other's persisted tab:

```ts
// apps/web/src/pages/clients/tracker/TrackerTabV2.tsx
type Panel = 'board' | 'hearings' | 'feed' | 'configure';   // §Registry-8
const PANEL_KEY = 'capiro:tracker:v2:panel';                 // distinct from legacy 'capiro:tracker:panel'

function loadPanel(): Panel {
  try {
    const v = window.sessionStorage.getItem(PANEL_KEY);
    if (v === 'board' || v === 'hearings' || v === 'feed' || v === 'configure') return v;
  } catch { /* private mode */ }
  return 'board';
}
const [panel, setPanelState] = useState<Panel>(loadPanel);
const setPanel = (p: Panel) => {
  setPanelState(p);
  try { window.sessionStorage.setItem(PANEL_KEY, p); } catch { /* private mode */ }
};
```

- Sub-nav via `SubNav` (`tracker-components.tsx`) with count badges (recs count on Board, unread-alert count on Feed, upcoming-session count on Hearings). No URL params — same as legacy (deep-link is at the tab level, §10.7).
- **Lazy-load** each heavy panel (§Registry-8, App.tsx pattern): `React.lazy(() => import('./panels/FeedPanel.js').then(m => ({ default: m.FeedPanel })))` wrapped in `<Suspense fallback={<Skeleton active />}>`. Import specifiers use the **`.js` extension** (verified: `TrackerTab.tsx:18` imports `./TrackerConfigPanel.js`).
- UI conventions (§Registry-8): Ant Design (`Button`, `Segmented`, `Dropdown`, `Modal`, `Form`, `Skeleton`), `App.useApp()` for `Modal`/`message`. Reuse `cp-*` / `trk-*` / `cfg-*` classes and `tracker.css`; new styles **append** to `tracker.css` under new namespaced selectors only (do not touch existing selectors — see §10.1 note).

### 10.4 Panel wiring

| Panel | Source | Wiring |
|---|---|---|
| **Board** | repoint existing kanban to intel-api | Same UI as legacy Board; swap `trackerPaths.board`→`intelTrackerPaths.board`, `trackerKeys`→`intelTrackerKeys`. Track/untrack → `intelTrackerPaths.track`/`untrack`. Recommendations badge reads `intelTrackerPaths.recommendations` (s6 §6.2, no `/tracker/` segment). Stages/columns unchanged. |
| **Hearings** | re-scoped `HearingWatchPage` | Client-scoped session list (`intelTrackerPaths.hearings(clientId)`), Live Room link, **brief view** (§10.5), export. Query key `['intel','hearings', clientId]`. |
| **Feed** | new combined timeline | `intelTrackerPaths.feed(clientId)` (s9 §9); merged bill + hearing + combined alerts (§Registry-6 Phase 6). Each row: title, `whyItMatters`, `recommendedAction`, evidence, severity/materiality badge, **useful/not-useful feedback buttons** (§10.6). Filter by sourceType/severity/date (client-side `Segmented`). |
| **Configure** | fold `TrackerConfigPanel` + hearing watchlist manager | One unified watchlist editor writing `intelTrackerPaths.watchlist(clientId)` (s5 §5.2, `/intel-api/watchlists/:clientId`). Alert-prefs via `intelTrackerPaths.alertPrefs`. Issue-areas dropdown reads legacy `/api/intelligence/issue-areas` unless intel-api ownership confirmed (§10.2 caveat). **Configure writes intel-api only when the tenant is flagged** — this is the D6 source-of-truth move; before `tracker_v2`, the legacy `TrackerConfigPanel` (writing `apps/api`) is what renders, so no split-brain. |

**Split-brain guard (write path):** because a flagged tenant writes its watchlist/alert-prefs to intel-api tables while an un-flagged tenant writes to apps/api tables, a tenant that is **flipped mid-session** (or has two tabs open across a flag change) could split writes. Mitigation: (a) flag flips take effect on the 60s refresh + next full mount, not mid-panel; (b) the Phase 8 `tracker_owner_intel` cutover is the authoritative one-way data move — Phase 7 Configure should treat intel-api as write target ONLY for flagged tenants and MUST NOT dual-write. Confirm intel-api Configure endpoints are idempotent upserts keyed on `clientId` (watchlist UNIQUE `clientId`, alert-pref UNIQUE `[userId,clientId]` per §Registry-5) so a repeated save is safe.

### 10.5 HearingWatchPage re-scoping + brief view

§Registry-8: `HearingWatchPage` is currently workspace-scoped (`/intel-api/hearings`, `/intel-api/watchlists`, **no clientId**). Re-scope minimally and reversibly:

1. Add optional prop `clientId?: string`. When present: pass as query param, add to every React Query key, and set `enabled: !!clientId` on client-scoped queries.
2. When absent (standalone workspace route): behave exactly as today — keeps the standalone route alive during transition (retirement/fold happens in Phase 9, not here).
3. `HearingsPanel.tsx` renders `<HearingWatchPage clientId={clientId} />` (or a thin extraction of its list) inside the Tracker tab.
4. **Brief view:** `GET /intel-api/hearings/:id/brief` → `HearingBrief` (§Registry-7: `sessionId`, `title`, `generatedAt`, `executiveSummary`, `keyMoments[]`, `relevantQuotes[]`, `supporters[]`, `opponents[]`, `tone`, `risks[]`, `opportunities[]`, `recommendedNextSteps[]`, `draftClientEmail{subject,body}`, `claimMap[]`, `synthesisSource`). Render in an Ant `Modal`/drawer; export = copy/download of `draftClientEmail` + summary. Key `['intel','brief', hearingId]`. Handle `synthesisSource: 'deterministic'` (orchestrator unavailable) gracefully — show the deterministic brief, do not error.

### 10.6 Feedback buttons (F5)

Feed rows and brief render useful/not-useful (and optional `wrong_impact|wrong_urgency|false_positive` per §Registry-2.4 `intel_feedback.signal`) buttons → `POST intelTrackerPaths.feedback(clientId)` with `{ alertId?, targetType, targetRef, signal }`. Optimistic UI via React Query `onMutate`; on error roll back + `message.error` (via `App.useApp()`). Idempotent server-side (last-write-wins); double-click sends the latest signal, no client-side dedup needed.

### 10.7 Flag gating + deep-link (ClientProfilePage.tsx)

Verified: legacy instantiates `TrackerTab` at **line 513**; deep-link `?tab=tracker` handled ~line 132. Fork on the flag, **preserving the legacy branch verbatim**. Hoist the hook to the top of the component (rules-of-hooks — never call it conditionally inside JSX):

```tsx
// apps/web/src/pages/clients/ClientProfilePage.tsx
// top of component body:
const trackerV2 = useIntelFeatureEnabled('tracker_v2');

// line ~513:
{activeTab === 'tracker' && (
  trackerV2
    ? <TrackerTabV2 clientId={client.id} clientName={client.name} />
    : <TrackerTab   clientId={client.id} clientName={client.name} />   // UNCHANGED legacy path
)}
```

- `useIntelFeatureEnabled('tracker_v2')` (verified `apps/web/src/lib/intel-feature-flags.ts`) — GET `/intel-api/feature-flags`, `staleTime:60_000`, `retry:false`, **fails CLOSED** (`{}` on error ⇒ `false`). So if intel-api or the ALB rule is unreachable, tenants transparently get the legacy tab. This is what lets prod **ship dark**: the code is deployed to all tenants but only flagged tenants (enabled via one-off `enable-feature tracker_v2 <tenantSlugOrId>`, always-on for `CAPIRO_INTERNAL_TENANT_ID`) see v2.
- Deep-link `?tab=tracker` (line 132) is flag-agnostic — it selects the tab; the fork selects which component renders. Alert-email deep-links keep working for both cohorts.

### 10.8 Build & deploy (apps/web)

Web ships as **step 5** of the canonical deploy (`scripts/deploy-dev.sh`: preflight → optional build+push → **MIGRATE task (wait STOPPED + exit 0)** → force-new-deployment api → force-new-deployment web). Web is order-independent but still runs after migrate. **Phase 7 adds NO DB migration to `apps/web`** (it is a static SPA); the intel-api schema/flag work belongs to Phases 3–6 and the `enable-feature` step, not here. The flag (not the deploy) controls exposure.

**Pre-req (blocker):** `/intel-api/*` ALB listener rule + healthy intel-api target group exist (§10.2). Verify (S1) before deploying web.

**Local verify (typecheck + build):**
```
pnpm --filter @capiro/web typecheck
pnpm --filter @capiro/web build     # Vite production build; must exit 0
```
> Do not gate on `pnpm lint` — repo-wide eslint is not installed (memory: `pnpm lint` always fails). Gate on typecheck + build (+ prettier `--check`).

**Deploy (canonical, DEV):** web is a separate ECR image + `update-service capiro-dev-web --force-new-deployment`. Prod Fargate is **ARM64** — any local web image build MUST be `docker buildx --platform linux/arm64` (infra memory; an accidental amd64 `:latest` push is unpullable). **Preferred path is CI building/pushing arm64, then force-new-deployment** — local `--build` is fallback only.

```
# DEV, after api/migrate steps (or web-only):
aws ecs update-service --cluster capiro-dev \
  --service capiro-dev-web --force-new-deployment --region us-east-1
aws ecs wait services-stable --cluster capiro-dev --services capiro-dev-web --region us-east-1
```

> **PROD names — UNVERIFIED, must confirm before a prod roll:** prod cluster is `capiro-prod-os-capiro` (§Registry-1), but the **prod web service name is not stated by recon** (§Registry-1 lists only `capiro-dev-web`). Do NOT guess `capiro-prod-web`; resolve the actual service name (`aws ecs list-services --cluster capiro-prod-os-capiro`) before running the prod `update-service`/`wait`.

**Ship-dark sequence:**
1. Confirm `/intel-api/*` ALB rule live + intel-api TG healthy (§10.2, S1).
2. Deploy web with v2 code (flag OFF everywhere ⇒ every tenant still sees legacy).
3. `enable-feature tracker_v2 <pilotTenant>` via one-off run-task (§Registry-1 shape; cluster `capiro-dev`, task-def `capiro-dev-intel-api-migrate`, container override `name=intel-api-migrate`, `command=["enable-feature","tracker_v2","<tenantSlugOrId>"]`; subnets/SGs **UNVERIFIED — pull from `scripts/deploy-ingestion-out-of-band.sh` template**). Pilot = `capiro-internal` + demo client "Aperture Defense Systems" (plan §9 Q4). Note: `capiro-internal` is ALWAYS-on for intel flags by design, so it will see v2 without an explicit row — pick a **separate real pilot tenant** if you need to prove per-tenant enablement rather than the internal always-on path.
4. QA the pilot (§10.9 checklist).
5. Roll back = `enable-feature`-disable (or delete the flag row) ⇒ pilot reverts to legacy on next ≤60s flag refresh. No redeploy needed.

### 10.9 QA checklist (manual, per cohort)

**Flagged tenant (pilot):**
- [ ] Tracker tab shows 4 sub-tabs Board / Hearings / Feed / Configure; sub-tab persists across reload (sessionStorage `capiro:tracker:v2:panel`).
- [ ] Board lists tracked bills from intel-api; track/untrack works; recs count badge correct (from `/intel-api/clients/:c/recommendations`).
- [ ] Hearings lists client's sessions; brief opens, renders all `HearingBrief` fields, export works; deterministic-brief case renders without error.
- [ ] Feed shows bill + hearing + combined rows with evidence + recommended action; filters work; useful/not-useful persists across reload.
- [ ] Configure edits the unified watchlist and saves to intel-api (`/intel-api/watchlists/:c`, 200); alert-prefs save; re-save is idempotent (no duplicate rows).
- [ ] Network tab: all Tracker data calls hit `/intel-api/*` (including `/intel-api/watchlists/*`, `/intel-api/clients/*/recommendations`, `/intel-api/clients/*/feed`), all **2xx** (no 404/500/502); `Authorization: Bearer` present.

**Un-flagged tenant (control):**
- [ ] Tracker tab is visually identical to today (Board / Recs / Configure legacy panels); all calls hit `/api/intelligence/*` (§Registry-8 legacy paths); zero `/intel-api/*` **data** calls (the `/intel-api/feature-flags` probe is expected and returns `{}` or 404 — that is the fail-closed path).
- [ ] `?tab=tracker` deep-link still lands on the tab.

### 10.10 Rollback

- **UI-only rollback (default):** disable `tracker_v2` for the tenant (one-off `enable-feature` disable / delete flag row) → next ≤60s flag refresh flips them back to legacy. No web redeploy.
- **Total rollback:** `update-service capiro-dev-web --force-new-deployment` pinned to the previous web image tag (`:<PREV_GIT_SHA>`), then `wait services-stable`. Legacy component files were never modified, so revert is clean.
- Because delivery ownership (`tracker_owner_intel`, §Registry-4) is independent of `tracker_v2`, a UI rollback does **not** touch alert sending — no risk of duplicate/lost client emails from a Phase 7 revert. This is consistent with the single-sender model: only Phase 8 changes who sends.

---

**Success criteria** (each independently verifiable; gates Phase 8 cutover UI-readiness). Owner in parens:

| # | Criterion | Owner | Command / method | Threshold / gate |
|---|---|---|---|---|
| S0 | intel-api route strings in `intelTrackerPaths` match the sections that DEFINE them | Eng | Grep `intel-tracker-api.ts` and diff against s5 §5.2 (`/intel-api/watchlists/:clientId`), s6 §6.2 (`/intel-api/clients/:clientId/recommendations`), s9 §9 (`/intel-api/clients/:clientId/feed`), then curl each against the delivered intel-api controllers | every path resolves (no 404 on a path the controller doesn't serve); watchlist has NO `/tracker/` segment; recommendations has NO `/tracker/` segment. **GATE: blocks merge** |
| S1 | `/intel-api/*` reachable through ALB to a healthy intel-api TG | SRE | `aws elbv2 describe-rules --listener-arn <arn>` shows a `/intel-api/*` forward rule at a non-colliding priority AND `aws elbv2 describe-target-health --target-group-arn <intel-tg>` all `healthy`; then `curl -sS -o /dev/null -w '%{http_code}' https://app.capiro.ai/intel-api/health` | rule exists; TG 100% healthy; curl `200` (not `404`/`502`). **GATE: unblocks web deploy** |
| S2 | Web bundle typechecks + builds | Eng | `pnpm --filter @capiro/web typecheck && pnpm --filter @capiro/web build` | both exit `0`. **GATE: unblocks deploy** |
| S3 | Flagged tenant sees unified surface from intel-api | QA (pilot login) | Chrome Network tab on Tracker tab, walk all 4 sub-tabs | 4 sub-tabs render; **100%** of Tracker *data* calls go to `/intel-api/*` (incl. `/intel-api/watchlists/*`, `/intel-api/clients/*/recommendations`, `/intel-api/clients/*/feed`), all `2xx`; **0** `/api/intelligence/*` data calls. **GATE: unblocks pilot cutover** |
| S4 | Un-flagged tenant unchanged | QA (control login) | Network tab + visual compare vs current prod | legacy Tracker renders identically; **0** `/intel-api/*` *data* calls (feature-flags probe excepted); only `/api/intelligence/*`. **GATE: confirms ship-dark safety** |
| S5 | Fail-closed proven | QA | DevTools request-block `/intel-api/*` on a flagged tenant, reload | tab falls back to legacy (flag hook returns `{}` ⇒ `false`), **no crash, no error boundary**. **GATE: confirms resilience** |
| S6 | No console errors | QA | DevTools Console, walk all 4 sub-tabs + brief + feedback, both cohorts | **0** errors, **0** unhandled promise rejections. **GATE: blocks merge** |
| S7 | a11y / tab semantics preserved | QA | Keyboard-only: Tab/Shift-Tab/Enter across `SubNav`; screen-reader roles on Ant `Segmented`/`Button`; brief `Modal` focus | sub-tabs keyboard-reachable + operable; focus order sane; brief `Modal` traps + restores focus. **GATE: blocks merge** |
| S8 | Deep-link works both cohorts | QA | Open `…/clients/<id>?tab=tracker` as flagged and un-flagged user | lands on Tracker tab in both. **GATE: confirms alert-email links unbroken** |
| S9 | Web deployed + stable | SRE | `aws ecs wait services-stable --cluster capiro-dev --services capiro-dev-web --region us-east-1` | returns exit `0` (steady state). **GATE: marks Phase 7 deployed** |
| S10 | UI rollback verified | SRE + QA | Disable `tracker_v2` for pilot → reload after ≤60s | pilot reverts to legacy Tracker, no redeploy, no `/intel-api/*` data calls. **GATE: confirms reversibility** |
| S11 | Zero client sends during Phase 7 | SRE | Confirm `tracker_owner_intel` still OFF for pilot AND intel-api alert/digest verbs not scheduled (or in shadow); check SES send count for `TRACKER_ALERT_EMAIL_FROM` unchanged over the QA window | delivery ownership unchanged; **0** new client-facing sends attributable to Phase 7. **GATE: enforces shadow/single-sender invariant** |

**Definition of done for Phase 7:** S0–S11 all green on the pilot tenant, delivery still in shadow (S11, no client sends), legacy component files unmodified — hands off to Phase 8 per-tenant delivery cutover (`tracker_owner_intel`).

---

## 11. Phase 8 (cutover) & Phase 9 (decommission)

Deployment-ready expansion of Phase 8 / Phase 9 and the §4 runbook. Preserves the strangler strategy (D4–D6), the single-sender guarantee (D5), and the source-of-truth flip ordering (D6). Every name/command below is verbatim from the deployment registry; rows marked **UNVERIFIED — confirm** must be confirmed against live infra before first execution and are called out inline.

### 11.0 Blocking pre-cutover verifications (do these FIRST)

These must be resolved before writing any tenant flip. Several are load-bearing for whether the runbook commands below even run.

1. **Which task-def runs the data verbs.** The runbook below invokes `sync-watchlists-from-legacy`, `detect-bill-changes --catch-up`, and `enable-feature` as `containerOverrides` on the **migrate** task-def family (`capiro-dev-intel-api-migrate` / `capiro-prod-intel-api-migrate`, container `intel-api-migrate`). Per registry §2 the migrate task gets **ONLY DB_* secrets + `DB_NAME`** — it does NOT get `DEEPGRAM_*`, `CLERK_SECRET_KEY`, Bedrock env, SES env, or `HEARING_ENCRYPTION_KEY`. That is fine for pure-SQL verbs (`enable-feature`, `sync-watchlists-from-legacy`) but **`detect-bill-changes` computes embeddings/summaries and (in shadow) needs Bedrock creds + `EMBEDDINGS_MODEL`; catch-up that only advances snapshots and suppresses sends may not.** **UNVERIFIED — confirm** exactly which verbs the migrate task can run vs. which must run on the serve task-def (`capiro-dev-intel-api`) or a new purpose task-def with the full secret/env set. Do not assume the migrate task can do embedding work. Where a verb needs full secrets, swap `--task-definition` to the serve family and container name `intel-api` in `containerOverrides[].name`.
2. **These verbs must exist.** intel-api is HTTP-only today with a single `bootstrap()` (registry §6). `sync-watchlists-from-legacy`, `detect-bill-changes`, and `enable-feature` are all **NEW entrypoint verbs to be added in Phases 1–2** (CommandFactory or `entrypoint.sh` dispatch). `enable-feature <flag> <tenantSlugOrId>` is named in registry §1/§3; `sync-watchlists-from-legacy` and `detect-bill-changes` are **UNVERIFIED — confirm** these exact verb names ship. A `disable-feature` verb (or documented SQL fallback) is required for rollback (§11.5) and is **UNVERIFIED — confirm**.
3. **Network config for run-task.** `awsvpcConfiguration` subnets/SGs (`assignPublicIp=DISABLED`) are **UNVERIFIED — confirm** from `scripts/deploy-ingestion-out-of-band.sh` run_job_wait template / resolved task-defs. Resolve exact subnet/SG IDs once, reuse in every command below.

**Prerequisites (all must be true before ANY tenant is flipped):**
- Phases 1–7 shipped to prod. The intel-api serve service is running the arm64 image containing the ported tracker (`apps/api/src/tracker/*` → intel-api, per registry §6). DEV service = `capiro-dev-intel-api`; PROD service is managed out-of-band and is **UNVERIFIED — confirm** (likely `capiro-prod-intel-api` / `capiro-prod-os-capiro-intel-api`) before prod cutover.
- Image was built arm64 (prod Fargate is arm64): `docker buildx build --platform linux/arm64 -f apps/intel-api/Dockerfile ...` (registry §1) or CI `.github/workflows/intel-api-image.yml`. Never push an accidental amd64 `:latest`.
- Migrate task family (`capiro-dev-intel-api-migrate` / `capiro-prod-intel-api-migrate`) has run `prisma migrate deploy` for all tracker tables. **Table-name set is UNVERIFIED — confirm** and do NOT conflate: registry §5 says the port targets are PROPOSED `intel_topic`/`intel_term`, while the existing hearing tables are `intel_watchlist`, `intel_watchlist_term`, `intel_watchlist_match`. Confirm whether tracker reuses `intel_watchlist_term` or introduces `intel_topic`/`intel_term` BEFORE writing the migration or the parity SQL. Other tables per §5: `intel_watchlist`, `intel_tracked_bill`, `intel_alert_preference`, `intel_notification_log`.
- New feature flags exist in `intel_feature_flag`: `tracker_owner_intel` (ownership/data-path gate) and `tracker_v2` (frontend surface gate). Both default OFF for all real tenants; ALWAYS-on only for `CAPIRO_INTERNAL_TENANT_ID` (registry §3). Guard returns **404** (not 403) when disabled. Because the internal tenant is always-on in `FeatureFlagService.isEnabled` but NOT necessarily backed by an `enabled=true` row, the apps/api single-sender guard must replicate that short-circuit or the migration must seed an enabled row for it — otherwise the internal tenant double-sends (see §11.1 parity note).
- **RLS / DB role (registry §4 gotcha).** intel-api's tracker port reads tenant-scoped tables (`clients`, `context_embeddings` non-NULL-tenant rows) under Postgres RLS. **UNVERIFIED — confirm** that (a) intel-api connects under the SAME DB role as apps/api (or an explicitly RLS-granted role), (b) intel-api has `prisma.withTenant(tenantId, …)` for scoped reads and `prisma.withSystem(…)` for cross-tenant detection, and (c) its role can read `context_embeddings` NULL-tenant global rows. Without this, semantic scoring and recommendations silently return empty for other tenants. Block cutover until confirmed.
- **IAM on the shared task role** (registry §2 — intel-api SHARES the api task role, DEV `...ApiTaskRole12FAD4A7-szq3QeeZJSCQ`, PROD `...ApiTaskRole12FAD4A7-5zhubZnOJ9nz`): `bedrock:InvokeModel` for `amazon.titan-embed-text-v2:0` (embeddings) AND for Anthropic Claude on Bedrock (summaries), plus `ses:SendEmail`. **All three UNVERIFIED — confirm; block cutover** — intel delivery + recommendations silently fail without them. Note whichever task-def actually runs embedding/SES verbs must have the role attached (both serve and migrate use ApiTaskRole per §1, but confirm the migrate task's task role, not just execution role).
- **Execution role** (registry §1) has ECR-pull + Secrets-read inline policy (`infra/deploy/intel-api-execrole-inline-policy.json`) covering every secret ARN the chosen task-def injects. Confirm it covers the tracker-added secrets namespace if any.
- **SES identity/sending.** `TRACKER_ALERT_EMAIL_FROM` (registry §2) must be a verified SES identity in `us-east-1` and the account must be out of the SES sandbox for arbitrary recipients. **UNVERIFIED — confirm** identity verified + production access, or intel-only sends silently fail post-flip. `AWS_REGION_DEFAULT` set.
- **Connection-pool impact.** Adding a second service (intel-api) issuing tracker queries against the shared Aurora cluster increases connection count. **UNVERIFIED — confirm** Aurora `max_connections` headroom and intel-api Prisma pool size so the added detect/flush load does not exhaust the pool shared with apps/api. Size intel-api pool explicitly.
- **`AiCredentialResolverService` / `ai_usage_events`.** Summaries resolve a tenant-scoped Anthropic key via `AiCredentialResolverService.resolveProviderByTenantId` and meter to `ai_usage_events` (registry §2/§6). **UNVERIFIED — confirm** this service and the `ai_usage_events` table exist in intel-api (or are ported). If absent, run with `TRACKER_ALERT_SUMMARY` unset (alerts send without summary, fail-safe → null per §6) until ported.
- **`IntelligenceChange` target.** `emitIntelligenceChange` writes an apps/api table; **UNVERIFIED — confirm** whether `IntelligenceChange` exists in the intel-api schema or must be re-targeted (registry §6). Resolve before enabling detection delivery.
- Rollback rehearsed on `CAPIRO_INTERNAL_TENANT_ID` + demo client "Aperture Defense Systems" (see §11.5) BEFORE the first real tenant.

---

### 11.1 The single-sender guard (the one apps/api change)

Exactly one service delivers per tenant. Add a guard to the apps/api sender loop in `apps/api/scripts/detect-tracker-alerts.ts` (and, for defense-in-depth, the same early-continue in `apps/api/scripts/emit-bill-alerts.ts` and `apps/api/scripts/flush-tracker-digests.ts`). `isIntelOwned` reads the SAME `intel_feature_flag` table intel-api's `FeatureFlagService.isEnabled` reads, so there is one source of truth for ownership:

```ts
// apps/api/scripts/detect-tracker-alerts.ts  (top of per-tenant loop)
async function isIntelOwned(tenantId: string): Promise<boolean> {
  // read-only; must match FeatureFlagService.isEnabled('tracker_owner_intel', tenantId)
  // including its CAPIRO_INTERNAL_TENANT_ID always-on short-circuit (see note below)
  if (tenantId === process.env.CAPIRO_INTERNAL_TENANT_ID) return true;
  const rows = await prisma.$queryRaw<{ enabled: boolean }[]>`
    SELECT enabled FROM intel_feature_flag
    WHERE feature = 'tracker_owner_intel' AND tenant_id = ${tenantId}::uuid
    LIMIT 1`;
  return rows[0]?.enabled === true;
}
// ...
for (const tenant of tenants) {
  if (await isIntelOwned(tenant.id)) { log.info({ tenantId: tenant.id }, 'skip: intel-owned'); continue; }
  // ...existing legacy detection + send...
}
```

**Parity note (mandatory):** `FeatureFlagService.isEnabled` is ALWAYS-on for `CAPIRO_INTERNAL_TENANT_ID` (registry §3), but a raw SQL read of `intel_feature_flag` only sees an actual row. If no `enabled=true` row is seeded for the internal tenant, apps/api would still send for it while intel-api also owns it → double-send. The guard MUST replicate the internal-tenant short-circuit (`if (tenantId === CAPIRO_INTERNAL_TENANT_ID) return true;`, shown above) OR the migration must seed an `enabled=true` `tracker_owner_intel` row for the internal tenant. This is the SAME always-on caveat that §0 (single-sender guarantee) and §12.1 must state; all three must specify it identically so the guard is uniformly defined. **Confirm exactly one of these (short-circuit OR seeded row) is in place before flipping any tenant.**

Guard semantics (mirror registry §3 — intel-api guard returns 404 when disabled; here the guard SKIPS in apps/api):

| `tracker_owner_intel` for tenant | apps/api `detect-tracker-alerts` | intel-api delivery | Watchlist source of truth |
|---|---|---|---|
| absent / `enabled=false` | **sends** (legacy owns) | shadow only (computes, suppresses) | apps/api `client_watchlist` |
| `enabled=true` | **skips** (`continue`) | **sends** | intel-api (after step 4) |
| internal tenant (`CAPIRO_INTERNAL_TENANT_ID`, always-on) | **skips** (short-circuit OR seeded row) | **sends** | intel-api |

Ship this guard to prod (apps/api arm64 image) BEFORE flipping any tenant. Until any flag is enabled it is a no-op for real tenants, so it is safe to deploy early. Deploy via the standard order (`scripts/deploy-dev.sh`: migrate → roll api → roll web).

---

### 11.2 Phase 8 — per-tenant ordered cutover (exact commands)

All commands target DEV names. For prod swap: cluster `capiro-dev` → `capiro-prod-os-capiro`; migrate task-def `capiro-dev-intel-api-migrate` → `capiro-prod-intel-api-migrate`; serve service `capiro-dev-intel-api` → prod service (**UNVERIFIED — confirm**); log group `/capiro/dev/intel-api` → `/capiro/prod-os-capiro`. `<TENANT>` = tenant slug or uuid (both accepted by `enable-feature`). Ordering is load-bearing: **final sync → catch-up detect → ownership flip → UI flip → stop reverse sync**. This is D6's source-of-truth flip: intel does not become authoritative for delivery until step 3 and for edits until step 4; legacy stops sending at step 3, so there is never a window with two senders or two writers.

`awsvpcConfiguration={...}` = subnets/SGs from `scripts/deploy-ingestion-out-of-band.sh` run_job_wait template (`assignPublicIp=DISABLED`) — **UNVERIFIED — confirm** exact IDs before running (§11.0.3). `--task-definition` / container `name` below assume the migrate task can run the verb; swap to serve family + container `intel-api` for any verb needing full secrets (§11.0.1).

**Concurrency lock (all steps):** run-task verbs and the scheduled EventBridge detect/flush crons both touch `intel_*` and `notification_log`. To avoid a cutover verb racing a scheduled cron for the same tenant, **either** run cutover steps in the cron's quiet window **or** confirm the ported verbs take a per-tenant advisory lock (e.g. `pg_advisory_xact_lock`) — **UNVERIFIED — confirm** the lock exists. Idempotency of the notification logs (§below) prevents double-send but not duplicate compute/log churn.

**Step 0 — Preflight (per tenant).** Snapshot legacy state for the parity/no-loss gate (run as a `diag-*` one-off ECS task — the only working ad-hoc prod SQL path, per infra memory):
```sql
SELECT count(*) AS legacy_tracked FROM tracked_bill tb
  JOIN clients c ON c.id = tb.client_id WHERE c.tenant_id = '<TENANT>'::uuid;
SELECT count(*) AS legacy_watchlists FROM client_watchlist cw
  JOIN clients c ON c.id = cw.client_id WHERE c.tenant_id = '<TENANT>'::uuid;
SELECT count(*) AS legacy_alertprefs FROM alert_preference ap
  JOIN clients c ON c.id = ap.client_id WHERE c.tenant_id = '<TENANT>'::uuid;
```
Gate: record counts; used to prove no-loss at step-1 gate and the step-6 audit.

**Step 1 — Final one-way sync legacy → intel (apps/api = source of truth up to here).**
```
aws ecs run-task --cluster capiro-dev --launch-type FARGATE \
  --task-definition capiro-dev-intel-api-migrate \
  --network-configuration 'awsvpcConfiguration={subnets=[...],securityGroups=[...],assignPublicIp=DISABLED}' \
  --overrides 'containerOverrides=[{name=intel-api-migrate,command=["sync-watchlists-from-legacy","<TENANT>"]}]'
```
Wait STOPPED + exit 0 (§11.4). Verify field-mapping fidelity per registry §5: `client_watchlist.issue_areas` → `intel_watchlist.enabled_issue_areas`; each `tags[]` object → one topic row + child term rows (`synonym|entity|risk`); `alert_preference` → `intel_alert_preference` 1:1. Gate below. This verb MUST be idempotent (re-run = no-op, Phase 2 acceptance).

**Step 2 — Catch-up detect (align snapshots, prevent backlog storm).** Run intel change-detection once in catch-up so `intel_tracked_bill.lastSeen*` matches current `congress_bill` state; classify but do not deliver (still shadow — delivery gated by `tracker_owner_intel`, still OFF):
```
# NOTE: if detect-bill-changes needs Bedrock/summaries creds it must run on the SERVE
# task-def (capiro-dev-intel-api, container intel-api), NOT the migrate task-def. See §11.0.1.
aws ecs run-task --cluster capiro-dev --launch-type FARGATE \
  --task-definition capiro-dev-intel-api-migrate \
  --network-configuration 'awsvpcConfiguration={subnets=[...],securityGroups=[...],assignPublicIp=DISABLED}' \
  --overrides 'containerOverrides=[{name=intel-api-migrate,command=["detect-bill-changes","--catch-up","<TENANT>"]}]'
```
Rationale: `classifyChange` fires on `lastSeenActionText/Date` deltas (registry §6). Without catch-up, the first post-cutover cron would re-fire every material action since the last legacy snapshot → an alert storm. Catch-up writes snapshots and marks pre-existing events seen (no send while flag OFF). Idempotent: only advances snapshots.

**Step 3 — Enable ownership flag (legacy STOPS, intel STARTS sending for this tenant).**
```
aws ecs run-task --cluster capiro-dev --launch-type FARGATE \
  --task-definition capiro-dev-intel-api-migrate \
  --network-configuration 'awsvpcConfiguration={subnets=[...],securityGroups=[...],assignPublicIp=DISABLED}' \
  --overrides 'containerOverrides=[{name=intel-api-migrate,command=["enable-feature","tracker_owner_intel","<TENANT>"]}]'
```
Effect: apps/api `isIntelOwned` now returns true → legacy loop `continue`s for this tenant; intel-api delivery guard now passes → intel sends. This is the single-sender seam. `intel_notification_log` unique `(alert_id, user_id, channel)` + apps/api `notification_log` unique `(alertId, userId, channel)` jointly guarantee no double-send even if both fire once in the same window. `enable-feature` is upsert (idempotent).

**Step 4 — Enable UI flag (source of truth for edits moves to intel — D6).**
```
aws ecs run-task --cluster capiro-dev --launch-type FARGATE \
  --task-definition capiro-dev-intel-api-migrate \
  --network-configuration 'awsvpcConfiguration={subnets=[...],securityGroups=[...],assignPublicIp=DISABLED}' \
  --overrides 'containerOverrides=[{name=intel-api-migrate,command=["enable-feature","tracker_v2","<TENANT>"]}]'
```
Effect: `useIntelFeatureEnabled('tracker_v2')` (60s staleTime, fails CLOSED — registry §8) starts returning true within ~60s; `ClientProfilePage.tsx` (TrackerTab ~line 513) renders the unified Tracker (`Panel = board|hearings|feed|configure`) reading `/intel-api/*`; Configure now WRITES intel. Order matters: ownership (step 3) before UI (step 4) so that when users can edit intel, intel is already the sender — no window where edits land in intel but legacy is still authoritative for delivery. **Note (registry §8): `/intel-api/*` has NO ALB rule today — intel-api is internal-only on :4300.** The web client hits intel routes RELATIVE to `apiBaseUrl`, so a listener rule for `/intel-api/*` MUST already be live before step 4 (add via `aws elbv2 create-rule` on `capiro-prod-alb`, NOT `cdk deploy`; pick a free priority — 12 or 17 suggested, **UNVERIFIED — confirm no collision** with rules 3/5/10/15/20). This rule addition is a prerequisite of Phase 1–7 exposure work; if it is not live, `tracker_v2` renders a surface whose XHRs 404. Confirm the rule exists before step 4.

**Step 5 — Stop reverse-overwrite: exclude tenant from scheduled `sync-watchlists-from-legacy`.** After step 4 intel is authoritative for edits; a further legacy→intel sync would clobber post-cutover edits. Add `<TENANT>` to the sync job's exclusion set — exact mechanism (env `SYNC_WATCHLIST_EXCLUDE_TENANTS` or a DB flag) is **UNVERIFIED — confirm** against the Phase 2 sync-job implementation. Do NOT delete the schedule (other un-flipped tenants still need it).

**Step 6 — 48h watch (per-tenant gate; see Success criteria).** Monitor both notification logs + parity report before declaring the tenant done.

**Cutover order across tenants:** `CAPIRO_INTERNAL_TENANT_ID` (always-on, effectively pre-flipped — confirm §11.1 parity note first) → pilot (demo client "Aperture Defense Systems" tenant) → remaining tenants in ascending client-count order. One tenant fully through step 6 (green) before starting the next during pilot; batches of ≤3/day only after pilot burn-in is green.

---

### 11.3 Phase 9 — decommission (only after ALL tenants flipped + 2-week burn-in green)

**Step 9.1 — Disable legacy out-of-band EventBridge rules.** Per tracker-tab memory these are LIVE and NOT in CDK, so disable via CLI (a `cdk deploy` would not touch them). Confirm exact names first — memory names 3 rules ("detect-tracker-alerts 12:00 UTC, flush digests daily/weekly"), but the flush rule names are **UNVERIFIED — confirm** via `aws events list-rules`:

| Rule name | Job | Schedule |
|---|---|---|
| `detect-tracker-alerts` | apps/api change detection + send | 12:00 UTC daily |
| flush daily digest rule (**UNVERIFIED — confirm** exact name) | daily digest flush | daily |
| flush weekly digest rule (**UNVERIFIED — confirm** exact name) | weekly digest flush | weekly |

```
aws events list-rules --query 'Rules[?contains(Name,`tracker`)].{n:Name,s:State,sch:ScheduleExpression}'  # discover exact names first
aws events disable-rule --name detect-tracker-alerts
aws events disable-rule --name <flush-daily-rule>    # confirm exact name first
aws events disable-rule --name <flush-weekly-rule>   # confirm exact name first
# verify:
aws events describe-rule --name detect-tracker-alerts --query 'State'   # expect: DISABLED
```
Disable (not delete) first — a one-command re-enable is the panic rollback during burn-in. Delete only in Step 9.4.

**Step 9.2 — Remove apps/api tracker code + legacy web.** After 2-week burn-in with the guard still present (harmless), delete:
- `apps/api/src/tracker/*` (all files in registry §6: `tracker.service.ts`, `tracker-change-detector.service.ts`, `tracker-relevance.util.ts`, `tracker.types.ts`, `tracker/notifications/*`, `tracker/sms/*`).
- apps/api scripts: `apps/api/scripts/detect-tracker-alerts.ts`, `apps/api/scripts/emit-bill-alerts.ts`, `apps/api/scripts/flush-tracker-digests.ts`.
- Legacy web: `apps/web/src/pages/clients/tracker/tracker-api.ts` (`trackerPaths`/`trackerKeys` hitting `/api/intelligence/clients/{clientId}/tracker/*`) and the legacy TrackerTab branch in `ClientProfilePage.tsx` (~line 513) — after this, `tracker_v2` no longer needs to gate render (always unified).
- **Keep** `apps/api/src/embeddings/embedder.ts` — the WRITER stays in apps/api (D1, ingestion untouched); intel-api has its own query-side copy per registry §6.
- **Do NOT delete the ALB `/intel-api/*` listener rule** added for step 4 — it now serves the only tracker surface.

**Step 9.3 — Legacy tables read-only for one release.** Do NOT drop `client_watchlist`, `tracked_bill`, `alert_preference`, `notification_log`, `tracker_feedback` in the same release as code removal. Revoke writes to prove no live writer remains:
```sql
REVOKE INSERT, UPDATE, DELETE ON client_watchlist, tracked_bill, alert_preference,
  notification_log, tracker_feedback FROM <app_db_role>;   -- exact role UNVERIFIED — confirm
```
Ship, observe one release for permission-denied errors (should be zero — proves 9.2 removals were complete). Preserve `notification_log` unique `(alertId,userId,channel)` untouched (idempotency audit trail). **Note:** if apps/api and intel-api share one DB role (required by the RLS design, §4), scope the REVOKE to the legacy tables only — do NOT revoke on `intel_*`, which the shared role still writes.

**Step 9.4 — Drop.** Next release: migration dropping the five legacy tables + delete the three now-disabled EventBridge rules (`aws events remove-targets` then `aws events delete-rule`). Point of no return; only after 9.3 was clean.

---

### 11.4 Wait/idempotency helpers (every run-task step)

Each `run-task` above MUST wait for STOPPED + assert exit 0 before proceeding (mirrors `scripts/deploy-dev.sh` migrate-then-roll ordering). Container name in the query must match the task-def used (`intel-api-migrate` for migrate family, `intel-api` for serve family — §11.0.1):
```
TASK_ARN=$(aws ecs run-task ... --query 'tasks[0].taskArn' --output text)
aws ecs wait tasks-stopped --cluster capiro-dev --tasks "$TASK_ARN"
EXIT=$(aws ecs describe-tasks --cluster capiro-dev --tasks "$TASK_ARN" \
  --query 'tasks[0].containers[?name==`intel-api-migrate`].exitCode|[0]' --output text)
[ "$EXIT" = "0" ] || { echo "FAIL exit=$EXIT"; exit 1; }   # STOP the runbook; do not proceed
```
Logs: CloudWatch group `/capiro/dev/intel-api`, stream `intel-api-migrate` (or `intel-api` for the serve family); prod group `/capiro/prod-os-capiro`. Idempotency: `enable-feature` is upsert; `sync-watchlists-from-legacy` re-run is a no-op (Phase 2 acceptance); `detect-bill-changes --catch-up` only advances snapshots. (All three are **UNVERIFIED — confirm** verb/idempotency per §11.0.2.)

---

### 11.5 Rollback (per tenant, tested before first real tenant)

Reverse of §11.2, fast path is flags-only (no redeploy, no data restore — intel never wrote apps/api tables, D2). **This assumes a `disable-feature` verb exists — UNVERIFIED — confirm (§11.0.2); fallback is `UPDATE intel_feature_flag SET enabled=false` via a `diag-*` task.**
```
# 1. Return UI ownership to legacy FIRST (users stop editing intel):
aws ecs run-task --cluster capiro-dev --launch-type FARGATE \
  --task-definition capiro-dev-intel-api-migrate \
  --network-configuration 'awsvpcConfiguration={subnets=[...],securityGroups=[...],assignPublicIp=DISABLED}' \
  --overrides 'containerOverrides=[{name=intel-api-migrate,command=["disable-feature","tracker_v2","<TENANT>"]}]'
# 2. THEN return delivery ownership to legacy (intel stops, legacy resumes):
aws ecs run-task ... --overrides 'containerOverrides=[{name=intel-api-migrate,command=["disable-feature","tracker_owner_intel","<TENANT>"]}]'
# 3. Re-include tenant in scheduled sync-watchlists-from-legacy (undo step 5) so legacy edits re-flow.
```
Rollback ordering (mirror-reverse of cutover): disable `tracker_v2` FIRST, THEN `tracker_owner_intel`, THEN re-enable reverse sync. Never disable ownership before UI — that would leave users editing intel while legacy is the sender (edits land where the sender does not read). Double-send at the seam is prevented by both idempotency logs. Note the internal tenant cannot be rolled back this way if it is always-on via the short-circuit rather than a row (§11.1) — a code deploy or a seeded-then-disabled row is required to stop intel owning it. **Edit-loss caveat:** any Configure edits made in intel between step 4 and rollback are NOT in legacy; `sync-watchlists-from-legacy` is one-way and cannot recover them. Mitigation: keep rollback windows short; if a tenant edited during the window, export `intel_watchlist*` diffs (diag-* SQL) BEFORE re-enabling sync for manual reconciliation.

---

**Success criteria**

Per-tenant cutover gate — a step is not "done" and the next step MUST NOT start until its gate passes. Owner/verifier = the release engineer running the cutover, via the listed command; each gate unblocks the next step. All SQL runs as a `diag-*` one-off ECS task. Table names in the SQL are **UNVERIFIED pending §5 confirmation** (`intel_topic`/`intel_term` vs `intel_watchlist_term`) — reconcile before first run.

| Step | Gate (pass/fail) | Command / metric | Threshold | Owner | Unblocks |
|---|---|---|---|---|---|
| 1 Final sync | Unified counts equal legacy snapshot | diag-* SQL: `intel_watchlist` count vs step-0 `legacy_watchlists`; topic/term rows == decomposed `tags[]` count; `intel_alert_preference` == step-0 `legacy_alertprefs`; `intel_tracked_bill` == step-0 `legacy_tracked` | exact match (0 drift); re-run sync is a no-op | Release eng | step 2 |
| 2 Catch-up | No pre-cutover material event would send on flip | diag-* SQL: count `intel_tracked_bill` rows for tenant with `lastSeenAt` older than `congress_bill` latest action (unaligned snapshots) | 0 unaligned; 0 unsent legacy-era criticals queued | Release eng | step 3 |
| 3 Ownership flip | Legacy stops, intel starts, no double-send | one detect cycle post-flip: apps/api `notification_log` rows for tenant since `flip_ts` == 0 AND `intel_notification_log` rows > 0; zero-double-send join (below) == 0 | apps/api sends = 0; overlap = 0; intel sends > 0 | Release eng | step 4 |
| 4 UI flip | Tracker serves from intel; Configure writes intel | in-app: `GET /intel-api/feature-flags` returns `tracker_v2:true` (200, not 404 → ALB rule live); edit a watchlist → row appears in `intel_watchlist*`, NOT `client_watchlist` | write lands in intel only; endpoint 200 | Release eng | step 5 |
| 5 Stop reverse sync | Scheduled sync excludes tenant | next scheduled `sync-watchlists-from-legacy` log (`/capiro/*/intel-api`) shows tenant skipped | tenant absent from sync output | Release eng | step 6 |
| 6 48h watch | Zero double-sends proven via BOTH logs; parity + delivery health hold | zero-double-send query over 48h == 0; parity report (Phase 5) ≥95% alert-set overlap with 0 missed criticals; intel send-success rate ≥ legacy baseline; `/intel-api/*` 5xx flat on CloudWatch (`capiro-dev-alerts`) | 0 double-sends; parity ≥95%; 0 missed criticals; 5xx no regression, 48h | Release eng + SRE | tenant DONE |

Zero-double-send proof (authoritative, both logs) — run at end of step 3 and step 6:
```sql
SELECT count(*) AS double_sends FROM (
  SELECT a.client_id, a.bill_id, a.change_type, a.user_id, a.channel
  FROM notification_log a           -- apps/api legacy
  JOIN intel_notification_log b     -- intel-api
    ON a.user_id=b.user_id AND a.channel=b.channel
   AND a.client_id=b.client_id AND a.bill_id=b.bill_id AND a.change_type=b.change_type
  WHERE a.tenant_id='<TENANT>'::uuid AND a.sent_at >= '<flip_ts>'
) x;   -- MUST be 0
-- join keys/columns (tenant_id, sent_at, change_type on legacy notification_log) UNVERIFIED — confirm
-- against the real notification_log + intel_notification_log schemas before relying on this gate
```

**Decommission gate (Phase 9) — owner/verifier = release eng + SRE:**
- **All tenants flipped:** `SELECT count(*) FROM tenants t WHERE NOT EXISTS (SELECT 1 FROM intel_feature_flag f WHERE f.tenant_id=t.id AND f.feature='tracker_owner_intel' AND f.enabled)` = 0. (Excludes `CAPIRO_INTERNAL_TENANT_ID` if it is always-on without a row — confirm §11.1.) Unblocks burn-in start.
- **2-week burn-in green (named metrics, 14 consecutive days):** (a) parity report ≥95% overlap, 0 missed criticals; (b) `intel_notification_log` send-success rate ≥ legacy 14-day baseline; (c) zero-double-send query (summed all tenants) == 0; (d) `/intel-api/*` 5xx and the `capiro-dev-api-target-4xx`-equivalent alarm flat, no regression (CloudWatch, subscribed to `capiro-dev-alerts`). All four green 14/14 → unblocks Step 9.2 code removal.
- **Read-only release clean:** after Step 9.3 REVOKE, zero permission-denied errors in `/capiro/dev/intel-api` + apps/api logs for one release → unblocks Step 9.4 DROP.
- **Rollback tested:** full §11.5 rollback executed on `CAPIRO_INTERNAL_TENANT_ID` / demo tenant, verified legacy resumed sending (apps/api `notification_log` rows appear) and Tracker tab reverted to legacy render, BEFORE first real-tenant cutover. Gate: documented rehearsal with before/after log evidence. Unblocks first real-tenant flip.

---

## 12. Cutover & rollback runbook

> **Purpose.** Turn §4 (ownership flag + 6 abstract steps + rollback sentence) into an operator-grade, copy-pasteable procedure. This section does not change any §4 decision: single-sender via `tracker_owner_intel` (D5), watchlist source-of-truth flips only at cutover (D6), legacy stays live until flipped (D4), intel never writes apps/api tables. It ADDS exact commands, watch-points with expected values, decision gates, and a full per-tenant rollback with double-send verification on the seam.
>
> **Pilot tenant (open Q4 recommendation):** `capiro-internal` + demo client **"Aperture Defense Systems"**. `capiro-internal` maps to `CAPIRO_INTERNAL_TENANT_ID`, for which `FeatureFlagService.isEnabled` is **ALWAYS-on** (Registry §3) — so on the pilot the `enable-feature` step is a no-op for gating and the rollback-by-flag path CANNOT disable it (see §12.6). For a true flag-gated dry run, use a **second non-internal pilot tenant** (a real customer tenant flagged in DEV). Confirm both before Phase 8. **UNVERIFIED — confirm the second (non-internal) pilot tenant slug/id.**

### 12.0 Scope, invariants & environment

| Invariant | Enforced by |
|---|---|
| Exactly one service delivers alerts per tenant | `tracker_owner_intel` flag + legacy skip guard `if (await isIntelOwned(tenantId)) continue;` at top of `apps/api/src/scripts/detect-tracker-alerts.ts` tenant loop (§4). **UNVERIFIED — confirm exact path; Registry §6 lists `scripts/detect-tracker-alerts.ts` under `apps/api/src/`.** |
| No double-send within a service | `intel_notification_log` idempotency key `alertId = 'tracker:'+clientId+':'+billId+':'+changeType`, `claim()` = INSERT ON CONFLICT `(alertId,userId,channel)` → P2002 = skip (Registry §6). **Note: this guard is per-service and does NOT span the intel↔legacy seam** (different tables). Cross-seam safety comes from ownership ordering, not ON CONFLICT (see §12.5/§12.6). |
| Legacy state intact through rollback | intel reads apps/api GLOBAL tables (`congress_bill`, `context_embeddings`, `clients`) via raw SQL only; never writes `client_watchlist`/`tracked_bill`/`alert_preference`/`notification_log` (Registry §4/§6) |
| Watchlist edits not lost | one-way `apps/api → intel-api` sync until step 4; source-of-truth flips at step 4; reverse-overwrite sync disabled at step 5 (D6) |
| Cross-tenant/NULL-tenant reads respect RLS | intel-api is a SECOND service on the shared Aurora `capiro` DB; tenant-scoped tables (`clients`, `context_embeddings`) enforce Postgres RLS. intel MUST set tenant context per query (`prisma.withTenant`) and use `withSystem` only for cross-tenant detection (Registry §4). **UNVERIFIED — confirm intel Prisma role + `withTenant`/`withSystem` exist and its role can read NULL-tenant `context_embeddings` rows (gated by P6).** |

**Environment used by every command below (DEV shown; PROD values from Registry §1):**

| Var | DEV | PROD |
|---|---|---|
| `CLUSTER` | `capiro-dev` | `capiro-prod-os-capiro` |
| `MIGRATE_TD` | `capiro-dev-intel-api-migrate` | `capiro-prod-intel-api-migrate` |
| `SERVE_SVC` | `capiro-dev-intel-api` | **UNVERIFIED — confirm** (out-of-band; likely `capiro-prod-intel-api` / `capiro-prod-os-capiro-intel-api`) |
| `LOGGRP` | `/capiro/dev/intel-api` (streams `intel-api`, `intel-api-migrate`) | `/capiro/prod-os-capiro` |
| migrate container name | `intel-api-migrate` | same |
| Region | `us-east-1` | `us-east-1` |

> **⚠ Task-def / secrets mismatch — READ BEFORE building the verb runner.** Registry §2 states the **migrate task-def gets ONLY `DB_*` secrets + `DB_NAME`**. The runbook verbs `detect-bill-changes` (Bedrock embeddings + SES send) and `sync-watchlists-from-legacy`/`parity-report` (Bedrock for scoring) therefore CANNOT run on `MIGRATE_TD` as-shipped — they will fail at `bedrock:InvokeModel` / `ses:SendEmail` with missing creds/keys. **Choose ONE before first live run, and record which:**
> - (a) add a dedicated **`*-jobs` task-def** carrying the full serve secret set (`DEEPGRAM_API_KEY` not needed; but `DB_*`, and env `EMBEDDINGS_MODEL`, `AWS_REGION_DEFAULT`, `TRACKER_ALERT_EMAIL_FROM`, `TRACKER_*` gates) plus the serve task role, and run verbs there; or
> - (b) extend `MIGRATE_TD` to include those secrets/env and confirm its task role = the shared api task role (Registry §1) with Bedrock+SES grants (P5).
> `enable-feature`/`disable-feature` are DB-only and are safe on `MIGRATE_TD`. **UNVERIFIED — confirm chosen job task-def name; substitute for `$JOBS_TD` below where a verb needs Bedrock/SES.**

```bash
# One-off intel-api verb runner. DB-only verbs use $MIGRATE_TD; Bedrock/SES verbs use $JOBS_TD.
# subnets/SGs are UNVERIFIED — confirm from scripts/deploy-ingestion-out-of-band.sh
# run_job_wait template / resolved task-defs BEFORE first live run.
run_intel () { # usage: run_intel <task-def> <container-name> <verb> [args...]
  local TD="$1"; local CN="$2"; shift 2
  aws ecs run-task --cluster "$CLUSTER" --launch-type FARGATE --region us-east-1 \
    --task-definition "$TD" \
    --network-configuration 'awsvpcConfiguration={subnets=[SUBNET_A,SUBNET_B],securityGroups=[SG_INTEL],assignPublicIp=DISABLED}' \
    --overrides "containerOverrides=[{name=$CN,command=[$(printf '\"%s\",' "$@" | sed 's/,$//')]}]" \
    --query 'tasks[0].taskArn' --output text
}
# DB-only:   run_intel "$MIGRATE_TD" intel-api-migrate enable-feature tracker_v2 "$TENANT"
# Bedrock/SES: run_intel "$JOBS_TD"  <jobs-container> detect-bill-changes "$TENANT"
```
> **Every verb also requires post-run success verification.** `run-task` returns a taskArn immediately; a non-zero container exit is NOT surfaced. After each `run_intel`, wait STOPPED and assert exit 0:
> ```bash
> aws ecs wait tasks-stopped --cluster "$CLUSTER" --tasks "$ARN"
> aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$ARN" \
>   --query 'tasks[0].containers[0].exitCode' --output text   # MUST be 0
> ```
> intel-api is HTTP-only today with a single `bootstrap()`; verb dispatch (`enable-feature`, `disable-feature`, `sync-watchlists-from-legacy`, `detect-bill-changes`, `parity-report`) must be added to the entrypoint per Registry §6. **Do not run this runbook until those verbs exist AND the §6 ported services / target tables are confirmed (see UNVERIFIED table caveats below).**

**UNVERIFIED schema/dependency caveats that gate this whole runbook (Registry §5/§6):**
- Target tables `intel_topic` / `intel_term` are PROPOSED; the port may instead reuse `intel_watchlist_term`. Every SQL below that names `intel_topic`/`intel_term` must be re-pointed if so. Do NOT conflate with existing `intel_watchlist`/`intel_watchlist_term`/`intel_watchlist_match`.
- `intel_tracked_bill`, `intel_alert_preference`, `intel_notification_log`, `intel_alert_digest_queue`, `intel_feature_flag` must exist in the intel-api schema and be created by `prisma migrate deploy` (P4). Confirm each `@@map` before running verify SQL.
- `IntelligenceChange`, `ai_usage_events`, and `AiCredentialResolverService.resolveProviderByTenantId` are apps/api artifacts — **UNVERIFIED whether they exist in intel-api**. If summaries (`TRACKER_ALERT_SUMMARY`) or `IntelligenceChange` emit are relied on during burn-in, confirm/port first, else disable those env gates for the pilot.

---

### 12.1 Pre-flight checklist (gate: ALL green or STOP)

Run T-24h before the window. Owner = release engineer; second signer = SRE.

| # | Check | Command / method | Expected | Blocks |
|---|---|---|---|---|
| P1 | Account is `967807252336` | `aws sts get-caller-identity --query Account --output text` | `967807252336` | all |
| P2 | intel-api serve healthy | task in `$SERVE_SVC` → `GET :4300/health` (ECS Exec or internal curl; NOT ALB-exposed — no `/intel-api/*` rule exists, Registry §1) | `200` | all |
| P3 | Deployed image is arm64 AND SHA == intended | `aws ecs describe-services --cluster $CLUSTER --services $SERVE_SVC` → task-def image tag == `capiro/dev/intel-api:<GIT_SHA>`; then `docker manifest inspect <image>` (or ECR image manifest) shows `architecture: arm64` | tag equal + arm64 | all (arm64 mismatch = task won't start on Fargate arm64) |
| P4 | Migrate ran clean AND all verbs dispatch | `$LOGGRP`/`intel-api-migrate` shows `prisma migrate deploy` clean exit; run each verb with a no-op/dry arg (`enable-feature`, `disable-feature`, `sync-watchlists-from-legacy`, `detect-bill-changes`, `parity-report`) → recognized, exit 0 | migrations applied; all 5 verbs present | all |
| P5 | Job task role has Bedrock + SES | simulate `bedrock:InvokeModel` (Titan embed + Claude), `ses:SendEmail` on the role attached to `$JOBS_TD`/`$MIGRATE_TD` (shared api task role, Registry §1) via `aws iam simulate-principal-policy` | all Allow | delivery + recs |
| P6 | intel Prisma role reads NULL-tenant `context_embeddings` | `run_intel $JOBS_TD <cn> diag-embeddings-read` → count `tenant_id IS NULL AND source_type='bill' AND model='amazon.titan-embed-text-v2:0'` under intel's actual DB role (RLS active, §4) | count > 0 | recs/scoring |
| P7 | Legacy skip guard deployed | inspect deployed `apps/api` image: `detect-tracker-alerts.ts` contains `isIntelOwned` guard at tenant-loop top | present | **single-sender** |
| P8 | Parity green ≥7d (Phase 5) | latest `parity-report` for the non-internal pilot tenant | overlap ≥95%, **0 missed criticals**, score deltas within tolerance | cutover |
| P9 | Legacy EventBridge cadence known | note next fire of `capiro-dev-…detect-tracker-alerts` (12:00 UTC) + digest-flush rules; record exact rule names | recorded | timing |
| P10 | Rollback verbs / kill-switch exist | `disable-feature` verb present in intel entrypoint; internal-tenant kill-switch path documented (§12.6) | present | rollback |
| P11 | Snapshot pre-state | record `SELECT count(*)` for `intel_notification_log` (tenant-scoped) and legacy `notification_log`; record flip timestamp source | baselines recorded | seam verification |
| P12 | SES sender identity verified | `aws ses get-identity-verification-attributes --identities "$TRACKER_ALERT_EMAIL_FROM"` (region = `AWS_REGION_DEFAULT`) | `VerificationStatus=Success`; if account in SES sandbox, recipient addrs also verified | delivery (email silently fails otherwise) |
| P13 | Feature flags default-OFF pre-flip | `SELECT feature, enabled FROM intel_feature_flag WHERE tenant_id=:t AND feature IN ('tracker_owner_intel','tracker_v2')` for the **non-internal** pilot | 0 rows / all `false` (shadow state) | clean seam |
| P14 | Shared-Aurora connection headroom | intel serve + job tasks add Prisma pools to the SAME cluster as api; check `SELECT count(*) FROM pg_stat_activity` vs `max_connections` at peak, and confirm intel Prisma `connection_limit` sized so serve+jobs+api stay under budget | headroom > planned job concurrency | stability |

> **P8 is the hard gate.** No cutover until ≥95% alert-set overlap AND zero legacy-critical alerts missed by intel for 7 consecutive days. If P8 is amber, STOP — do not proceed to §12.4.

---

### 12.2 Comms & timing (quiet-hours aware)

- **Window:** flip **outside** the legacy detect cron (12:00 UTC) and digest-flush fires so no batch straddles the seam. Start **≥2h after** the last legacy detect fire and **≥2h before** the next.
- **Job concurrency / locking:** during the shadow→owned transition BOTH services may run `detect` against the same tenant. There is no cross-service DB lock. Sequence steps so intel's `detect-bill-changes` and the legacy cron never fire concurrently for `$TENANT`; if timing is tight, temporarily `disable-rule` the legacy detect cron across the flip and re-enable after step 3 verify. Within intel, ensure only one `detect-bill-changes` task per tenant runs at once (advisory lock or single-flight in the verb).
- **Quiet hours:** `isWithinQuietHours(start,end)` is evaluated in **ET** and suppresses **SMS realtime** only (email cadences unaffected; SMS is dormant per Registry §2). Choose a window NOT inside pilot users' `quietHoursStart..quietHoursEnd` so post-flip realtime alerts are representative.
- **Cadence caution:** if any pilot user has `emailCadence=daily|weekly`, realtime post-flip alerts land in `intel_alert_digest_queue`, not inbox — verify via the queue, not by waiting for an email.
- **Comms:** notify pilot admins T-24h ("intelligence engine upgrade; no action needed; alerts continue"); notify #capiro-ops at T-0 and burn-in complete. On rollback, notify #capiro-ops only (customer-invisible).

> **Double-send join key (canonical for §12.5 and §12.6).** The cross-service double-send check joins intel and legacy delivery rows on the underlying columns **`(client_id, bill_id, change_type, user_id, channel)`**, matching §11.4 / §11 success-criteria. Do **NOT** parse the composite `alertId` (`split_part(alert_id, ':', …)`) to derive the join key: the `tracker:clientId:billId:changeType` `alertId` format is defined only for the PORTED intel code (Registry §6), and legacy `notification_log.alert_id` may use a DIFFERENT scheme (**UNVERIFIED**). Joining on the real columns is safer and identical across both services. Only fall back to `split_part` if legacy's `alert_id` format is later confirmed byte-identical to intel's — otherwise it produces false negatives (missed double-sends).

---

### 12.3 Roles

| Role | Owns |
|---|---|
| Release engineer | runs commands, drives checklist, verifies each task exit 0 |
| SRE (second signer) | watches logs/queries, calls GO/NO-GO at each gate |
| On-call | rollback trigger authority during burn-in |

---

### 12.4 Cutover procedure (per tenant, ordered) — expands §4 steps 1–6

`TENANT=<non-internal-pilot-slug-or-id>` throughout (do the flag-gated dry run on the non-internal tenant; §12.6). Each step has a **verify** with expected output; do not advance on a failed verify or a non-zero task exit.

**Step 1 — Final watchlist sync (legacy → intel).**
```bash
ARN=$(run_intel "$JOBS_TD" <jobs-container> sync-watchlists-from-legacy "$TENANT")
aws ecs wait tasks-stopped --cluster "$CLUSTER" --tasks "$ARN"
aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$ARN" --query 'tasks[0].containers[0].exitCode' --output text  # 0
```
- **Watch:** `$LOGGRP`/`intel-api-migrate` (or jobs stream) → `sync-watchlists-from-legacy tenant=$TENANT topics=<n> terms=<m> done`.
- **Verify (object parity):**
  ```sql
  SELECT (SELECT count(*) FROM intel_topic WHERE tenant_id=:t) AS intel_topics,
         (SELECT count(*) FROM intel_term  WHERE tenant_id=:t) AS intel_terms;
  ```
  Expected: `intel_topics` == count of legacy `client_watchlist.tags[]` objects for the tenant; `intel_terms` == Σ(synonyms+relatedEntities+riskTerms) (Registry §5 mapping). **If the port reuses `intel_watchlist_term`, re-point this query (Registry §5).** Run the SELECT under intel's RLS role with tenant context set, else RLS returns 0.

**Step 2 — Catch-up detection (no backlog storm), still shadow.**
```bash
ARN=$(run_intel "$JOBS_TD" <jobs-container> detect-bill-changes "$TENANT")   # snapshots intel_tracked_bill.lastSeen* to current
# wait + assert exit 0 as above
```
- **Watch:** `detect-bill-changes tenant=$TENANT bills=<n> changes=<k> delivered=0 (shadow)`.
- **Verify no storm:** snapshots aligned to live actions:
  ```sql
  SELECT count(*) FROM intel_tracked_bill itb
  WHERE itb.tenant_id=:t
    AND itb.last_seen_action_date IS DISTINCT FROM
        (SELECT cb.latest_action_date FROM congress_bill cb WHERE cb.id = itb.bill_id);
  ```
  Expected: **0**. Non-zero ⇒ re-run step 2; do NOT flip. (`congress_bill` is GLOBAL/RLS-free, Registry §4.)

**Step 3 — Flip ownership → intel sends, legacy skips (SINGLE-SENDER SEAM).**
```bash
ARN=$(run_intel "$MIGRATE_TD" intel-api-migrate enable-feature tracker_owner_intel "$TENANT")
# wait + assert exit 0
```
- **DECISION GATE (do FIRST):** confirm P7 guard is live on the deployed api image AND (per §12.2) the legacy detect cron will not fire before you have verified the flag. If the guard is NOT deployed, **abort** — you would double-send.
- **Watch (intel):** next real `detect-bill-changes` → `owner=intel delivered=<d> suppressed_idempotent=<s>` (no `(shadow)`).
- **Watch (legacy):** next `capiro-dev-…detect-tracker-alerts` (12:00 UTC) → `tenant=$TENANT skipped (intel-owned)`.
- **Verify flag state:**
  ```sql
  SELECT feature, enabled FROM intel_feature_flag WHERE tenant_id=:t AND feature='tracker_owner_intel';
  ```
  Expected: `tracker_owner_intel | true`. (Guard returns **404 when disabled**, not 403 — Registry §3.)

**Step 4 — Flip UI + move watchlist source-of-truth.**
```bash
ARN=$(run_intel "$MIGRATE_TD" intel-api-migrate enable-feature tracker_v2 "$TENANT")
# wait + assert exit 0
```
- **Effect:** `useIntelFeatureEnabled('tracker_v2')` returns true (React Query 60s staleTime, **fails closed** → `{}` on error, Registry §8), so `ClientProfilePage.tsx` renders unified Tracker (Board|Hearings|Feed|Configure) from `/intel-api/*`. Configure now WRITES intel (D6).
- **Verify:** load pilot client Tracker as a pilot-tenant user; Network tab shows `/intel-api/*`; an edit in Configure persists to `intel_topic`/`intel_term` (or `intel_watchlist_term` per the confirmed schema), NOT `client_watchlist`.

**Step 5 — Disable reverse-overwrite sync.**
```bash
aws events disable-rule --name "capiro-dev-sync-watchlists-$TENANT"   # UNVERIFIED rule name — confirm; out-of-band EventBridge, NOT in CDK (§7 risk row)
```
- **Verify:** `aws events describe-rule --name … --query State` → `DISABLED`. Legacy watchlist edits no longer flow to intel (intended — intel is now source of truth).

**Step 6 — Burn-in watch (48h).** See §12.5.

---

### 12.5 What to watch during burn-in (48h) with expected values

| Signal | Where | Expected (GO) | Alarm (→ consider rollback) |
|---|---|---|---|
| **No double-send** | double-send SQL below | for every `(client_id,bill_id,change_type,user_id,channel)`, delivery in **exactly one** of intel/legacy logs in the seam window | any tuple delivered in BOTH within the same event window |
| Idempotent skips working | `$LOGGRP` job stream | `suppressed_idempotent=<s>` present; P2002 on re-run | crash on conflict instead of skip |
| Delivery success | `intel_notification_log.status` | `sent` (realtime) / `queued` (digest) | `error` / repeated retries |
| Legacy actually skipping | legacy detect cron log | `tenant=$TENANT skipped (intel-owned)` every fire | tenant still processed by legacy |
| Parity holds live | `run_intel $JOBS_TD <cn> parity-report $TENANT` | overlap ≥95%, 0 missed criticals | overlap drop / a critical only in legacy |
| No error/latency regression | intel-api serve CloudWatch | flat vs baseline | 5xx or detect-job timeout spike |
| No Aurora connection saturation | `pg_stat_activity` count vs `max_connections` | within P14 budget | pool exhaustion / api-side connection errors |

**Double-send verification query.** Runs cross-DB on the shared `capiro` DB, so it MUST run under a role that can read BOTH `intel_notification_log` and legacy `notification_log` — intel's tenant-scoped RLS role generally CANNOT read legacy `notification_log` for arbitrary tenants, so **run this as the api/system role (or `withSystem`), not intel's per-tenant role** (Registry §4 RLS gotcha).

> **Join key (canonical, per §12.2).** Both sides join on the underlying delivery columns **`(client_id, bill_id, change_type, user_id, channel)`** — the same keys used by §11.4 / §11 success-criteria. This deliberately does **NOT** parse the composite `alertId` via `split_part`: the `tracker:clientId:billId:changeType` format is defined only for the PORTED intel code (Registry §6) and legacy `notification_log.alert_id` may use a different scheme (**UNVERIFIED**), so parsing it would silently miss double-sends. Only if legacy's `alert_id` format is confirmed byte-identical to intel's may you switch to a `split_part`-derived join.

```sql
-- Seam window = [flip_ts - 15m, now]. Run as api/system role (reads both tenant + legacy rows).
-- Join on the underlying delivery columns, NOT parsed alert_id (see §12.2 join-key note).
WITH intel AS (
  SELECT client_id, bill_id, change_type, user_id, channel
  FROM intel_notification_log
  WHERE status='sent' AND created_at >= :flip_ts - interval '15 min'
),
legacy AS (
  SELECT client_id, bill_id, change_type, user_id, channel   -- same underlying columns; adjust names only if legacy schema differs
  FROM notification_log
  WHERE created_at >= :flip_ts - interval '15 min'
    /* AND status/sent filter per legacy schema */
)
SELECT * FROM intel JOIN legacy USING (client_id, bill_id, change_type, user_id, channel);
```
Expected: **0 rows**. Any row = a double-send on the seam → open incident immediately, do not wait for 48h.

> **If a legacy column name differs** (e.g. legacy stores `change_type` under another name, or has no discrete `change_type` column), map it explicitly in the `legacy` CTE's SELECT to the canonical names above — still join on the five real values, never on a parsed `alert_id`. Confirm the legacy `notification_log` column set against recon before first run. **UNVERIFIED — confirm legacy `notification_log` exposes `client_id`/`bill_id`/`change_type`/`user_id`/`channel` (or their equivalents).**

**Burn-in exit gate (→ next tenant / Phase 9):** 48h with 0 double-sends, 0 delivery errors, parity ≥95%, no Aurora connection regression, and pilot-admin confirmation of received alerts. SRE signs off.

---

### 12.6 Rollback (per tenant) — full procedure with legacy-resumed + no-double-send verification

Rollback restores **legacy owns** (D4/D5). Because intel never wrote apps/api tables, legacy `client_watchlist`/`tracked_bill`/`alert_preference`/`notification_log` are intact and legacy resumes once the ownership flag clears.

> **GAP — build before cutover:** Registry §3 defines only `enable-feature`. Rollback REQUIRES a `disable-feature <flag> <tenant>` verb (delete/set-false the `intel_feature_flag` row) or a direct SQL fallback (below). **UNVERIFIED — confirm/add.** For `capiro-internal` the flag is ALWAYS-on and CANNOT be turned off by flag — internal-tenant rollback needs the SQL/kill-switch path or an env kill-switch. Do NOT pick internal as the flag-gated rollback dry-run subject.

**Rollback order (reverse of cutover). Timing first: if inside a cron window, `disable-rule` the legacy detect cron before step 3 so you control exactly when legacy resumes.**

1. **Re-enable legacy → intel sync** (reverses step 5):
   ```bash
   aws events enable-rule --name "capiro-dev-sync-watchlists-$TENANT"   # UNVERIFIED name
   ```
   Verify: `describe-rule … --query State` → `ENABLED`.

2. **Flip UI back to legacy** (reverses step 4):
   ```bash
   ARN=$(run_intel "$MIGRATE_TD" intel-api-migrate disable-feature tracker_v2 "$TENANT")   # verb TO BUILD; wait+exit 0
   # SQL fallback: UPDATE intel_feature_flag SET enabled=false WHERE tenant_id=:t AND feature='tracker_v2';
   ```
   Verify: pilot user's Tracker renders **legacy** `TrackerTab` (Board|Recs|Config from `/api/intelligence/.../tracker/*`, Registry §8); Network tab shows `/api/*`, not `/intel-api/*`. (Hook fails closed → a stale/500 flag also yields legacy — safe.)

3. **Flip ownership back to legacy** (reverses step 3 — legacy resumes, intel goes silent):
   ```bash
   ARN=$(run_intel "$MIGRATE_TD" intel-api-migrate disable-feature tracker_owner_intel "$TENANT")   # verb TO BUILD; wait+exit 0
   # SQL fallback: DELETE FROM intel_feature_flag WHERE tenant_id=:t AND feature='tracker_owner_intel';
   ```
   Verify:
   ```sql
   SELECT count(*) FROM intel_feature_flag WHERE tenant_id=:t AND feature='tracker_owner_intel' AND enabled=true;  -- expect 0
   ```

4. **Confirm legacy resumed sending:** trigger/await next legacy detect cron.
   - Legacy log → `tenant=$TENANT processed` (NO `skipped (intel-owned)`).
   - ```sql
     SELECT count(*) FROM notification_log WHERE created_at > :rollback_ts /* AND tenant/client scope */;  -- expect > 0 on next material change
     ```

5. **Confirm intel stopped sending:** intel detect logs `owner=legacy delivered=0 (shadow)` for `$TENANT`; no new `sent`:
   ```sql
   SELECT count(*) FROM intel_notification_log WHERE created_at > :rollback_ts AND status='sent' /* tenant scope */;  -- expect 0
   ```

6. **No double-send across the rollback seam:** re-run the §12.5 double-send query with `:flip_ts = :rollback_ts` (run as api/system role, joining on the underlying `(client_id, bill_id, change_type, user_id, channel)` columns per §12.2 — NOT parsed `alert_id`). Expected **0 rows**. Idempotency keys are per-service (different tables), so the ON-CONFLICT guard does NOT span the seam — the ordering (ownership OFF, plus cron control) is what prevents overlap; the query is the proof.

---

### 12.7 Idempotency & re-run safety

| Command | Safe to re-run? | Why |
|---|---|---|
| `sync-watchlists-from-legacy` | Yes | upsert on watchlist unique keys (`client_watchlist` 1 row/client → intel decomposition upserts, Registry §5) |
| `detect-bill-changes` (catch-up) | Yes, but not CONCURRENTLY per tenant | snapshot write idempotent; delivery guarded by `intel_notification_log` claim (ON CONFLICT). Enforce single-flight per tenant (§12.2) to avoid duplicate work/races |
| `enable-feature` / `disable-feature` | Yes | flag row upsert/delete; converges |
| Cutover as a whole | Yes | each step converges; re-running a failed step from its verify point is safe |

---

### **Success criteria**

Each is independently verifiable; the runbook is "deployment-ready" only when all pass in DEV against the (non-internal) pilot tenant.

| # | Criterion | Verifier | Command / metric | Threshold / expected | Gate unblocked |
|---|---|---|---|---|---|
| S1 | Pre-flight is a real gate | Release eng | run §12.1 P1–P14 | ALL green; any red halts | entry to §12.4 |
| S2 | Cutover dry-run executes end-to-end | Release eng + SRE | §12.4 steps 1–5 in DEV; each step's *verify* passes AND each task exit 0 | step-2 drift=0; step-3 flag=true + legacy `skipped`; step-4 Network=`/intel-api/*` + edit hits `intel_topic`/`intel_term`; step-5 rule `DISABLED` | Phase 8 GO |
| S3 | Zero double-send on cutover seam | SRE | §12.5 double-send SQL (as system role, join on `(client_id,bill_id,change_type,user_id,channel)`) at T+1h/24h/48h | **0 rows** every run | burn-in pass |
| S4 | Legacy verifiably silenced when intel owns | SRE | legacy detect cron log for `$TENANT` | `skipped (intel-owned)` on every fire post-step-3 | S3 credibility |
| S5 | Parity holds live post-flip | SRE | `run_intel $JOBS_TD <cn> parity-report $TENANT` | overlap ≥95%, **0 missed criticals**, deltas in tolerance | next-tenant rollout |
| S6 | Rollback dry-run restores legacy cleanly | On-call + SRE | §12.6 steps 1–6 in DEV | `tracker_owner_intel enabled=true count = 0`; UI on `/api/*`; legacy `notification_log` grows (>0); intel `sent` after rollback = 0 | rollback certified |
| S7 | No double-send across rollback seam | SRE | §12.6 step 6 SQL (`:flip_ts=:rollback_ts`, join on `(client_id,bill_id,change_type,user_id,channel)`) | **0 rows** | rollback certified |
| S8 | Quiet-hours honored | SRE | inspect a realtime SMS attempt inside a configured quiet window | suppressed per `isWithinQuietHours` (ET); email cadence unaffected | comms sign-off |
| S9 | Rollback verbs / kill-switch exist | Release eng | `disable-feature` verb present (or SQL fallback rehearsed) AND internal-tenant kill-switch path documented | present + rehearsed | S6 executable |
| S10 | Idempotent re-runs | Release eng | run each §12.7 command twice (detect: sequentially, not concurrent) | second run converges; `intel_notification_log` count stable (no dup deliveries) | operational safety |
| S11 | Job task-def carries required secrets/perms | Release eng | `detect-bill-changes` on `$JOBS_TD` completes exit 0 with a real Bedrock call + (test) SES send; P5+P12 green | exit 0; embed + SES succeed | delivery/recs executable |
| S12 | arm64 image + migrate-before-serve honored | Release eng | P3 (arm64 + SHA) green; migrate task ran STOPPED/exit 0 BEFORE serve force-new-deployment (Registry §1 order) | arm64 confirmed; migrate precedes serve | deploy correctness |
| S13 | Shared-Aurora stable under second service | SRE | P14 + §12.5 connection signal across burn-in | no pool exhaustion / api-side connection errors | stability sign-off |
| S14 | RLS/tenant isolation preserved | SRE | confirm intel reads scoped via `withTenant`; cross-tenant only via `withSystem`; P6 NULL-tenant read works; no cross-tenant leakage in pilot | scoped reads correct; count>0 on P6 | data-safety sign-off |

> **Definition of done for §12:** S1–S14 all pass in DEV against the (non-internal) pilot tenant, with cutover dry-run (S2) and rollback dry-run (S6/S7) both green and every step carrying an expected-output check plus a task exit-0 assertion. Only then is a PROD per-tenant cutover authorized under §4 / Phase 8. All rows flagged **UNVERIFIED** above must be resolved to concrete values before their first PROD use.

---

## 13. Parallel feature workstreams (F1–F7)

These finish the hearing/product side and run largely independent of the migration spine (Phases 1–9, §3). This section makes each of the F1–F7 items from §5 **deployment-ready**: exact files/tools, flag + IAM + secret changes, phase dependencies, and per-workstream measurable success criteria. All builds are ARM64 (`docker buildx --platform linux/arm64 -f apps/intel-api/Dockerfile …`, per registry §1); intel-api shares the Aurora `capiro` DB with apps/api and reads apps/api GLOBAL tables via raw SQL only (never writes them — see the ownership rule below for the one nuance around `context_embeddings`).

> **Isolation model — read before building (verified against source, not recon). There are TWO distinct cases; do not conflate them.**
>
> **Case A — intel-OWNED tables (`intel_*`, `hearing_*`, etc.): app-level tenant filtering, NO RLS.** intel-api's `PrismaService` (`apps/intel-api/src/prisma/prisma.service.ts`) connects with a single role and documents: *"Tenant isolation is enforced in application code: every query MUST include the `tenantId` resolved by the TenantGuard."* There is **no** `withTenant`/`withSystem`/`SET app.current_tenant_id` helper in intel-api today (grep-confirmed: 0 hits). For tables intel-api OWNS (which carry NO RLS policy), the correct pattern is to **pass `tenantId` explicitly in the WHERE clause** — do NOT invent a `prisma.withTenant` wrapper for these, because none exists and the tables have no RLS backstop. This is the case for `intel_segment_analysis` (F2), `intel_feedback` (F5), `intel_alert`, and every other `intel_*` table.
>
> **Case B — cross-RLS-boundary tables (`context_embeddings`, `clients`): `withTenant`/`withSystem` (setting `app.current_tenant`) is REQUIRED, per s6/s7/s11/s12.** These tables carry apps/api Postgres RLS keyed on the session var `app.current_tenant` (registry §4: `context_embeddings` policy = `tenant_id IS NULL OR tenant_id = current_tenant_id`; `clients` is fully tenant-scoped). RLS is the PRIMARY isolation for these rows, not app-level filtering. Any intel-api read or write of a cross-RLS-boundary table MUST establish the tenant session context the same way apps/api does — i.e. port/mirror `prisma.withTenant(tenantId, tx=>…)` for tenant-scoped access and `prisma.withSystem(tx=>…)` for cross-tenant detection (s6/s7). Because intel-api has no such helper today, **s6/s7 REQUIRE porting one** (a `SET LOCAL app.current_tenant` wrapper) before F5/F6 touch these tables. The earlier draft's blanket *"do NOT use withTenant, pass tenantId explicitly"* is WRONG for Case B and is corrected here: app-level filtering alone is insufficient for RLS-protected rows.
>
> **Open UNVERIFIED item (both cases):** whether intel-api's `DB_USER` role is *subject to or exempt from* RLS depends on which Postgres user it maps to. **UNVERIFIED — confirm the intel-api DB role vs the apps/api DB role, whether it can set `app.current_tenant`, and whether it can read `context_embeddings` NULL-tenant rows (see F6).** If intel-api shares apps/api's role, the ported `withTenant`/`withSystem` wrappers work identically; if it uses a different role, confirm that role can `SET LOCAL app.current_tenant` and satisfy the policies (or is `BYPASSRLS`).
>
> **Other model corrections:**
> 1. **`enable-feature` verb is CONFIRMED** in `apps/intel-api/scripts/entrypoint.sh` (case arm exists: `serve | migrate | enable-feature`). **No other verb exists.** Any new one-off job (F6 embed-writer, detect/flush verbs) **requires adding a new case arm** to `entrypoint.sh` — it is not a "same pattern, drops in" change; it is a code change that ships in the image.
> 2. **`AiCredentialResolverService`, `ai_usage_events`, and `IntelligenceChange` do NOT exist in intel-api** (grep-confirmed: 0 hits). F2 summary metering and any `IntelligenceChange` emit must be **ported or re-targeted**, not assumed present.
> 3. **Table-name conflation is real.** The only watchlist term table that exists in intel-api is **`intel_watchlist_term`** (migration `20260630000000_intel_watchlists`), with columns `term_type` / `value` / `weight` — **NOT** `intel_topic`/`intel_term` and **NOT** `term_text`. Treat `intel_topic`/`intel_term` as **UNVERIFIED — must confirm before any migration** (registry §5).

**Convention for every WS below:**
- New user-visible surface is gated by `tracker_v2` (`useIntelFeatureEnabled('tracker_v2')`, fails CLOSED per registry §8); backend data-path gated by `tracker_owner_intel` where it produces alerts/writes owned tables. Enable per-tenant with the confirmed one-off verb `enable-feature <flag> <tenantSlugOrId>` (registry §3; verb confirmed in `apps/intel-api/scripts/entrypoint.sh`, run via the `capiro-dev-intel-api-migrate` task-def with a `containerOverrides[].name=intel-api-migrate` command override — registry §1 one-off shape).
- Guard behavior: `FeatureFlagService.isEnabled` guards return **404** when disabled; ALWAYS-on for `CAPIRO_INTERNAL_TENANT_ID`.
- New meriv2-core LLM tools register ONLY when `ANTHROPIC_API_KEY` is set (confirmed in `apps/meriv2-orchestrator/src/meri/meri-registry.service.ts`); intel-api reaches them over `MERIV2_ORCHESTRATOR_URL` (default timeout `MERIV2_TIMEOUT_MS=8000`).
- **Isolation per the two-case model above:** for `intel_*` (owned, no RLS) filter by `tenantId` explicitly; for `context_embeddings`/`clients` (cross-RLS boundary) use the ported `withTenant`/`withSystem` (`app.current_tenant`) wrapper (s6/s7).
- **Single-sender invariant (no contradiction with §4/§8 cutover):** F2/F6/F7 and any alert-emitting path write **shadow rows only** (`status=new`, 0 delivered) until the Phase 8 single-sender cutover. No workstream is a second sender. Delivery is gated by `tracker_owner_intel` **and** the Phase 8 cutover flag together — enabling `tracker_owner_intel` alone never sends.

---

### F1 — Keyterm prompting (XS)

**What to build**
- Extend `DeepgramStreamManager` constructor opts in `apps/intel-api/src/hearing/deepgram-stream.manager.ts:34-41` from `{model?, endpointingMs?}` to `{model?, endpointingMs?, keywords?: string[]}`; store `this.keywords` and add `keywords: this.keywords` to the `deepgram.listen.live({...})` call at lines 72-80. Preserve existing `RECONNECT_MAX_ATTEMPTS=8`, `RECONNECT_BASE_MS=500` (`500 * 2^(attempt-1)`) unchanged.
- Source keywords from `HearingGateway` sessionContext (client issues / bill titles / program-element labels). Cap list length and dedupe to protect Deepgram request size (per-request keyterm cap is **UNVERIFIED** — clamp to ≤200 terms defensively and log if truncated).
- Reuses `WatchlistCompiler` keyterm output once §3 Phase 2 lands, but F1 can ship earlier sourcing keywords directly from `sessionContext`.

**Deploy**
- No new secret, no new IAM, no migration, no connection-pool impact. Ships in the normal intel-api image (`.github/workflows/intel-api-image.yml`, triggers on `apps/intel-api/**`).
- Rollout: no flag needed (pure accuracy improvement, backward-compatible — empty `keywords` = today's behavior). If risk-averse, gate on the frontend that passes context behind `tracker_v2`.
- Order: no migration → `update-service capiro-dev-intel-api --force-new-deployment`, wait services-stable (registry §1). **Rollback:** re-deploy prior task-def revision (empty `keywords` is behavior-identical to today, so rollback is a no-op regression-wise).

**Dependencies:** none hard; richer keyword source depends on Phase 2 `WatchlistCompiler`.

**Success criteria** *(owner in Verifier column; each row is command + threshold + gate)*
| Check | Verifier | Command / metric | Threshold | Gate unblocked |
|---|---|---|---|---|
| `keywords` sent to Deepgram | Eng | With `INTEL_LOG_LEVEL=debug`, log composed `live()` opts on a test session; assert `keywords` present | non-empty array, ≤200 terms, 0 dupes (assert `len==uniq`) | F1 backend done |
| No transcription regression | Eng | Same reference audio with/without keywords; diff final segment count | segment count delta ≤ ±2% AND word-count delta ≤ ±2% | F1 safe to enable |
| Recall lift on target terms | Ninja | Count correct spellings of client-specific proper nouns pre/post on same audio | ≥1 term recovered that was mistranscribed before AND 0 new mistranscriptions introduced | closes §5 F1 |

---

### F2 — Stance / sentiment / impact classifier (M)

**What to build**
- New meriv2-core tool `classify_hearing_stance` under `packages/meriv2-core/src/tools/hearing/` (sibling of `tag-live-policy-mentions.ts` and `generate-post-hearing-summary.ts`, both confirmed present). Follow the exact contract (registry §7): `ToolDefinition<I,O> = { name, description, inputSchema: Zod, handler:(input, ctx: MeriContext)=>Promise<O>, readOnly: true }`, `MeriContext = { tenantId, userId, clerkUserId, role, org? }`. Input = one finalized relevant segment + client context (mirror `TagLivePolicyMentionsInput`); output `{ sentiment, stance(support|oppose|neutral), intensity, clientImpact(favorable|unfavorable|monitor), recommendedAction, confidence }`.
- Register it in `apps/meriv2-orchestrator/src/meri/meri-registry.service.ts` beside the two existing hearing tools, inside the `ANTHROPIC_API_KEY`-guarded block. Invoke ONLY via `registry.invoke('classify_hearing_stance', input, ctx)`. Model choice is **UNVERIFIED** — confirm against `packages/meriv2-core/src/llm/llm-client` before assuming Sonnet.
- **Persistence:** new intel-api table **`intel_segment_analysis`** (additive Prisma migration in `apps/intel-api/prisma/schema.prisma`). This is an **intel-OWNED table (Case A): `tenant_id TEXT NOT NULL`, NO RLS policy** — match existing intel-api convention (`intel_watchlist_term` uses `tenant_id TEXT`, not uuid, and no RLS policy; do not add an RLS policy that intel's single role can't satisfy):
  ```
  intel_segment_analysis  id, tenantId, clientId?, sessionId, segmentId,
                          sentiment, stance, intensity,
                          clientImpact(favorable|unfavorable|monitor),
                          recommendedAction, confidence(float), model, createdAt
                          @@unique([sessionId, segmentId])   -- idempotent re-classify
  ```
  Idempotency: **upsert** on `(sessionId, segmentId)` so re-running classification is a no-op/overwrite, mirroring the confirmed segment-commit idempotency `(sessionId,startMs,endMs)`. Because this is a Case-A owned table with no RLS backstop, all reads MUST filter by `tenantId` explicitly (pass `tenantId` in the WHERE clause — no `withTenant` needed or available for this table).
- **Feeds two consumers:**
  1. **Briefs** — `hearing-brief.service.ts` (`@Controller('hearings')` → `@Get(':id/brief')`, confirmed) reads `intel_segment_analysis` to populate real `supporters[]`/`opponents[]`/`tone`/`risks[]`/`opportunities[]`, flipping `synthesisSource:'deterministic' → 'orchestrator'` when analysis present.
  2. **Alerts** — a `favorable`/`unfavorable` stance above a confidence floor emits a `stance_detected` `intel_alert` (unified alert model, §2.3), evidence `{sessionId, segmentId, timestampMs, quote}`. **Shadow-only** until Phase 8 (write `status=new`, 0 delivered); delivery gated by `tracker_owner_intel` + Phase 8 cutover.

**Deploy**
- **Migrate before serve:** run the migrate task (`aws ecs run-task --cluster capiro-dev --task-definition capiro-dev-intel-api-migrate --overrides containerOverrides=[{name=intel-api-migrate,command=["migrate"]}]`), wait STOPPED + exit 0, THEN `update-service capiro-dev-intel-api --force-new-deployment` (registry §1). Migrate task carries DB_* secrets only.
- **Concurrency/locking:** classification is idempotent-by-upsert, so concurrent re-runs on the same session are safe (last-writer-wins on `(sessionId,segmentId)`). No advisory lock needed.
- **IAM:** prefer routing through the orchestrator (`MERIV2_ORCHESTRATOR_URL`) — it already holds Anthropic access, so **no new intel-api IAM grant**. If (and only if) intel-api calls Bedrock directly, the shared task role needs `bedrock:InvokeModel` for Anthropic Claude — **UNVERIFIED, must confirm task role Bedrock perms** (registry §2). Do not add the grant unless the direct-call path is chosen.
- **Secret/env:** none new via orchestrator; reuse `MERIV2_ORCHESTRATOR_URL`, `MERIV2_TIMEOUT_MS`.
- **Summary metering caveat:** if F2 reuses the §6 `TrackerSummaryService` metering to `ai_usage_events` via `AiCredentialResolverService`, note **neither exists in intel-api** (grep-confirmed). Either port both (table migration + service) or run summaries un-metered through the orchestrator. **UNVERIFIED — decide port vs re-route before build.**
- **Rollout:** register tool (orchestrator deploy) → intel-api migrate + serve roll → keep alert delivery OFF (shadow) until Phase 4 (scorer) + Phase 8 (single sender) are clean.
- **Rollback:** additive table + additive tool; roll back the serve image to disable reads/writes. The table is inert if unread (safe to leave; drop only in a later reversing migration).

**Dependencies:** Phase 4 (unified alert model + `AlertScorer`) for `stance_detected` alerts; Phase 6/F4 for brief consumption. Tool + persistence can ship pre-Phase-4 (shadow-write `intel_segment_analysis` only).

**Success criteria**
| Check | Verifier | Command / metric | Threshold | Gate unblocked |
|---|---|---|---|---|
| Tool registered | Eng | Orchestrator startup log lists new tool; `registry.invoke('classify_hearing_stance',…)` on a fixture | HTTP 200 + Zod-valid output (all fields incl. `confidence∈[0,1]`) | F2 backend |
| Idempotent persistence | Eng | Run classify twice on same session; `SELECT count(*) FROM intel_segment_analysis WHERE session_id=$1` before/after 2nd run | row count identical; 0 unique-key violations in logs | F2 backend |
| Tenant filtering (Case A, no RLS backstop) | Eng | As tenant A, hit brief for a tenant-B session id | 404/empty; 0 tenant-B rows returned (proves explicit WHERE `tenant_id` present) | cutover-safe |
| Brief uses real stance | Ninja | Open brief for a labeled mixed-stance session; check `supporters[]`/`opponents[]`, `synthesisSource` | ≥1 supporter or opponent correctly attributed AND `synthesisSource='orchestrator'` | F4 brief |
| Classifier accuracy | Ninja | Hand-label 20 segments from 1 hearing; compare stance | ≥80% stance agreement (≥16/20) | closes §5 F2 |
| Alert shadow-only | Eng | Post-Phase-4 shadow run; `SELECT status,count(*) FROM intel_alert WHERE kind='stance_detected' GROUP BY status` | ≥1 row w/ full evidence; `status=new`; **0 delivered** | cutover eligibility |

---

### F3 — Pre-recorded / URL ingestion + Deepgram callbacks + S3 (M–L)

**What to build**
- New ingestion path accepting `uploaded_audio` (multipart) and `stream_url`; call Deepgram **pre-recorded** API with a callback URL (async), distinct from the live socket in `deepgram-stream.manager.ts`. Add a new controller endpoint in `apps/intel-api/src/hearing/hearing.controller.ts` (currently `@Controller('hearings')`) plus a callback-receiver endpoint for Deepgram to POST to. Committed transcript segments still land in Postgres via the confirmed idempotent upsert `(sessionId,startMs,endMs)`.
- **S3 client is NEW** — registry §7 confirms NONE exists in intel-api. Add `@aws-sdk/client-s3` dep + an `S3Client` in `HearingModule`. Store audio under `recordingPolicy=audio_and_transcript`.

**S3 bucket — creation, lifecycle, encryption (deployment-ready)**
- Bucket name (suggested, us-east-1): DEV `capiro-dev-intel-hearing-audio`, PROD `capiro-prod-os-capiro-intel-hearing-audio`. **Names UNVERIFIED — confirm no collision + naming convention with Ninja.**
- PROD ECS/ALB are out-of-band (registry §1); create the bucket **out-of-band via CLI, NOT `cdk deploy`** (mirrors the out-of-band EventBridge/ALB-rule pattern, §7 risks). DEV example:
  ```
  aws s3api create-bucket --bucket capiro-dev-intel-hearing-audio --region us-east-1
  aws s3api put-public-access-block --bucket capiro-dev-intel-hearing-audio \
    --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
  aws s3api put-bucket-encryption --bucket capiro-dev-intel-hearing-audio \
    --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"aws:kms"}}]}'
  aws s3api put-bucket-lifecycle-configuration --bucket capiro-dev-intel-hearing-audio \
    --lifecycle-configuration '{"Rules":[{"ID":"expire-raw-audio","Status":"Enabled","Filter":{"Prefix":"audio/"},"Expiration":{"Days":90},"Transitions":[{"Days":30,"StorageClass":"STANDARD_IA"}]}]}'
  ```
  - Encryption: SSE-KMS (SOC 2 posture); app-layer transcript text already AES-256-GCM via `HearingCryptoService`/`HEARING_ENCRYPTION_KEY` (confirmed). Confirm the KMS key policy grants the shared task role `kms:GenerateDataKey`/`kms:Decrypt`.
  - Lifecycle: raw audio → STANDARD_IA at 30d, expire at 90d. Retention window **UNVERIFIED — confirm against SOC 2 retention policy with Ninja.** Transcripts persist in Postgres, not subject to this expiry.
- **IAM (TASK role, not exec role):** grant the shared api task role (`Capiro-dev-…szq3QeeZJSCQ` / prod `…5zhubZnOJ9nz`, registry §1 — intel-api SHARES it) `s3:PutObject`,`s3:GetObject`,`s3:AbortMultipartUpload` on `arn:aws:s3:::capiro-dev-intel-hearing-audio/*`, plus `kms:GenerateDataKey`/`kms:Decrypt` on the SSE key. This is a **task-role** statement; the exec-role inline policy (`infra/deploy/intel-api-execrole-inline-policy.json`, ECR-pull + Secrets-read only) is unrelated — do NOT add S3 there. **UNVERIFIED — task role currently has NO S3 perms; must add.**
- **Env to add:** `INTEL_HEARING_AUDIO_BUCKET`, `INTEL_HEARING_S3_PREFIX` (default `audio/`), `DEEPGRAM_CALLBACK_URL` (must be publicly reachable → requires the ALB rule below). Secret: none new (`DEEPGRAM_API_KEY` already injected, registry §2).
- **ALB exposure (single, tightly-scoped rule):** intel-api is internal-only on :4300 with **NO `/intel-api/*` ALB rule today** (registry §1). Add ONE listener rule under `app.capiro.ai` via `aws elbv2 create-rule` (NOT `cdk deploy` — prod `capiro-prod-alb` is manually managed/wedged), scoped **only to the callback path** (not the whole service). Suggested priority 12 or 17 — **UNVERIFIED, must confirm no collision** with existing rules (3/5/10/15/20) by running `aws elbv2 describe-rules` first. Protect the endpoint with Deepgram request signing/verification (do not rely on obscurity).

**Deploy order**
1. `aws elbv2 describe-rules` → pick a free priority; create S3 bucket + PAB + SSE-KMS + lifecycle (out-of-band CLI, both accounts).
2. Add task-role S3+KMS statements; verify with a one-off task doing a real PutObject→GetObject round-trip (not a dry-run — dry-run won't exercise the KMS grant).
3. Add the single scoped ALB listener rule for the callback path.
4. intel-api **migrate first** (if session-model columns added for pre-recorded source), wait STOPPED+exit0 → serve roll (registry §1).
5. Gate the UI/upload behind `tracker_v2`.

**Rollback:** delete the ALB rule (`aws elbv2 delete-rule`) to close the callback path; roll serve image back; leave bucket (inert). Bucket deletion is a separate, deliberate step.

**Dependencies:** independent of migration spine; benefits from Phase 6 combined feed. This is the plan's original MVP mode (live shipped first).

**Success criteria**
| Check | Verifier | Command / metric | Threshold | Gate unblocked |
|---|---|---|---|---|
| Bucket hardened | Eng | `aws s3api get-public-access-block` / `get-bucket-encryption` / `get-bucket-lifecycle-configuration` | all four PAB flags=true; SSEAlgorithm=`aws:kms`; lifecycle rule `expire-raw-audio` Enabled | S3 ready |
| ALB priority free | Eng | `aws elbv2 describe-rules --listener-arn <arn>` before create | chosen priority absent from returned set | rule safe to add |
| Task role can write | Eng | One-off task PutObject→GetObject round-trip on real bucket | HTTP 200 both; `x-amz-server-side-encryption: aws:kms` on GET | ingestion enabled |
| Callback reachable + scoped | Eng | `curl` ALB callback path from outside VPC; then `curl` a non-callback intel path | callback 200/expected; non-callback path still 404/unreachable (proves scope) | async transcription |
| End-to-end pre-recorded | Ninja | Upload a known audio file; poll session | transcript segments in Postgres AND audio object in S3 AND brief generatable | closes §5 F3 |

---

### F4 — Brief-view UI + export (S)

**What to build**
- Wire `GET /intel-api/hearings/:id/brief` (confirmed route; returns `HearingBrief`, full shape registry §7) into the **Hearings** sub-view of the Tracker tab (Phase 7). Render `executiveSummary`, `keyMoments[]`, `relevantQuotes[]`, `supporters[]`/`opponents[]` (from F2), `tone`, `risks[]`, `opportunities[]`, `recommendedNextSteps[]`, and `draftClientEmail{subject,body}`. Add export (copy/download).
- Frontend: shared `useApi()` axios client (registry §8) — path is RELATIVE `/intel-api/hearings/:id/brief`, resolves against `apiBaseUrl`, carries `Authorization: Bearer` + optional `x-capiro-impersonate-tenant`. Query key `['intel','hearings', clientId, id]` (client-scoped rescope per §8). Lazy-load with `React.lazy(...)` + Suspense. Ant Design; `trk-*`/`cp-*` classes in `apps/web/src/pages/clients/tracker/tracker.css`.

**Deploy**
- Web-only; gate behind `useIntelFeatureEnabled('tracker_v2')` (fails CLOSED). No backend/secret/IAM/migration. Roll `capiro-dev-web --force-new-deployment`; web is order-independent (registry §1). **Rollback:** disable `tracker_v2` for the tenant (instant, no redeploy) or roll web image.

**Dependencies:** Phase 7 (Tracker-tab v2 surface); richer briefs depend on F2. Endpoint already exists, so F4 is UI-only.

**Success criteria**
| Check | Verifier | Command / metric | Threshold | Gate unblocked |
|---|---|---|---|---|
| Brief renders | Ninja | Open a completed hearing (flagged tenant) | all `HearingBrief` sections render; 0 console errors | F4 done |
| Client-scoped cache | Eng | Assert query key includes `clientId`; switch clients | correct brief per client; 0 stale-cache carryover | Phase 7 hearings |
| Export fidelity | Ninja | Export/copy `draftClientEmail` | subject+body match endpoint JSON verbatim (byte-diff clean) | closes §5 F4 |
| Fails closed | Eng | Force flag-fetch error; open Hearings sub-view | sub-view hidden, no crash, legacy path intact | rollback-safe |

---

### F5 — Feedback loop (S)

**What to build**
- Table `intel_feedback` (§2.4) — an **intel-OWNED table (Case A)**: `id, tenantId, clientId, userId, alertId?, targetType, targetRef, signal(useful|not_useful|wrong_impact|wrong_urgency|false_positive|missed), createdAt`. Additive Prisma migration; `tenant_id TEXT NOT NULL`, **no RLS policy** (isolation is app-level for owned tables). Maps legacy `TrackerFeedback` signals `tracked|dismissed|marked_irrelevant|opened` → new vocabulary; archive legacy per registry §5.
- Endpoint `POST /intel-api/clients/:clientId/feedback` — write with `tenantId` from `TenantGuard` set explicitly on the row and on every read filter. For this owned, RLS-free table the correct pattern is **explicit `tenantId` in the WHERE clause** (there is no `withTenant` for `intel_*` tables, and none is needed — Case A). Note the contrast with F6, which touches the RLS-protected `context_embeddings` and therefore DOES require the ported `withTenant`/`withSystem` (Case B).
- Idempotency: add `@@unique([tenantId, userId, targetType, targetRef])` (or include `alertId`) so a double-click is an upsert, not a duplicate row.
- UI: useful/not-useful buttons in the **Feed** sub-view (Phase 7), Ant Design; optimistic update, invalidate `['tracker-feed', clientId]`.

**Deploy**
- **Migrate first** (`capiro-dev-intel-api-migrate` → `migrate`, wait STOPPED+exit0) → serve roll → web roll. Gate UI behind `tracker_v2`. No new secret/IAM (SES/Bedrock not involved). No connection-pool impact (single small INSERT/upsert path). Captures labels now; ranking model is out of scope. **Rollback:** additive table + additive endpoint; roll serve image, leave table inert.

**Dependencies:** Phase 7 (Feed sub-view). Table+endpoint can land earlier.

**Success criteria**
| Check | Verifier | Command / metric | Threshold | Gate unblocked |
|---|---|---|---|---|
| Feedback persists | Eng | Click useful; `SELECT * FROM intel_feedback WHERE client_id=$1 ORDER BY created_at DESC LIMIT 1` | row w/ correct `signal` + Clerk `userId` | F5 done |
| Idempotent | Eng | Double-submit same feedback; count rows | exactly 1 row (upsert held) | F5 done |
| Tenant isolation (Case A, app-level) | Eng | As tenant A, POST/GET with a tenant-B `clientId` | 404/empty; 0 cross-tenant rows (proves explicit `tenant_id` filter, no RLS reliance) | cutover-safe |
| Label coverage | Ninja | 1-week pilot | ≥20 feedback rows captured | closes §5 F5 |

---

### F6 — Archive semantic search (M)

**What to build**
- Embed transcript segments (and reuse existing bill embeddings) into `context_embeddings` (registry §4): `sourceType`, `sourceId`, `model`, `contentText`, `embedding vector`, unique `[tenantId,sourceType,sourceId,model]`, RLS `tenant_id IS NULL OR tenant_id = current_tenant_id`. intel-api WRITES rows with `sourceType='hearing_segment'` (tenant-scoped, `tenant_id` SET) and READS both those and `sourceType='bill'` rows (bill rows are apps/api-owned, often NULL-tenant).
- **Ownership rule (reconciles D2 with §4/§6).** `context_embeddings` is a **shared, multi-writer table, NOT wholly apps/api-owned**: apps/api owns the `source_type='bill'` rows; intel-api's hearing pipeline owns the `source_type='hearing_segment'` rows. Therefore D2 ("intel-api does not WRITE apps/api tables," s6) is **NOT violated** by F6, because the `hearing_segment` rows are intel-api's own data written by its own pipeline. The scope is strict:
  - intel-api **WRITES `context_embeddings` ONLY for `source_type='hearing_segment'`** (tenant-scoped, `tenant_id` SET per row).
  - intel-api is **READ-ONLY for `source_type='bill'`** (apps/api-owned; never inserts, updates, or deletes bill rows — this is what D2/s6 forbids and F6 must respect).
  Document this partition explicitly in the migration/PR so a future reader does not read s6 as blanket-forbidding all `context_embeddings` writes.
- **This is a cross-RLS-boundary write (Case B), so `context_embeddings` carries apps/api RLS and s6/s7's `withTenant`/`withSystem` (setting `app.current_tenant`) requirement applies here — app-level filtering alone is NOT sufficient.** Two hard prerequisites, both **UNVERIFIED — confirm before any write:**
  1. **DB role + session var:** the `context_embeddings` RLS policy is keyed on `app.current_tenant`, which apps/api sets via `withTenant`. intel-api has no such wrapper today. So F6 REQUIRES either (a) porting a `SET LOCAL app.current_tenant` wrapper mirroring apps/api's `withTenant`/`withSystem` (s6/s7 — the sanctioned path for Case B tables), OR (b) a DB role that is RLS-exempt (`BYPASSRLS`/table owner) for this table. **Confirm the intel-api `DB_USER` role's RLS standing on `context_embeddings`, whether it can set `app.current_tenant`, and whether it can read NULL-tenant `bill` rows.** Until this is resolved in writing, F6 is **blocked**.
  2. **Unique-key writes across the RLS boundary** must set `tenant_id` correctly per row, since the unique key includes `tenantId`.
- Embedding: port query-side `embedText`/`vectorLiteral`/`normalize` from `apps/api/src/embeddings/embedder.ts` (registry §6) — `EMBEDDING_MODEL = process.env.EMBEDDINGS_MODEL ?? 'amazon.titan-embed-text-v2:0'` (1024-dim, normalized), `MAX_INPUT_CHARS=8000`, `vectorLiteral → '[v0,…,v1023]'`, `embedText → Bedrock InvokeModelCommand`.
- NL query endpoint spanning bills+hearings (registry §6 cosine SQL), executed inside the ported `withTenant` context so the RLS policy admits both this tenant's `hearing_segment` rows and NULL-tenant `bill` rows:
  ```sql
  SELECT ce.source_id, ce.source_type,
         (1 - (ce.embedding <=> $1::vector))::float8 AS score
  FROM context_embeddings ce
  WHERE ce.source_type IN ('bill','hearing_segment') AND ce.model = $2
    AND ce.embedding IS NOT NULL
    AND (1 - (ce.embedding <=> $1::vector)) >= $3
  ORDER BY ce.embedding <=> $1::vector
  LIMIT 400;
  ```
  `$1`=query `vectorLiteral`, `$2`=`EMBEDDING_MODEL`, `$3`=`EMBED_CANDIDATE_FLOOR` (0.3). Display floor `RECOMMENDATION_FLOOR=0.45`.

**Deploy — IAM / RLS / job mechanics (all critical)**
- **Bedrock:** intel-api WRITES embeddings (unlike query-only Phase 1). Task role needs `bedrock:InvokeModel` for `amazon.titan-embed-text-v2:0`. **UNVERIFIED — confirm task role Bedrock perms** (registry §2). Add env `EMBEDDINGS_MODEL`.
- **RLS (Case B):** see the two prerequisites above — **the top risk in F6.** The sanctioned fix is porting `withTenant`/`withSystem` (s6/s7) so intel-api sets `app.current_tenant` on every `context_embeddings` read/write; a `BYPASSRLS` role is the fallback only if that porting is infeasible. Do not schedule the embed job until the DB-role/session-var question is resolved in writing.
- **Job mechanics (corrected):** the embed-writer is a **new entrypoint verb** — this requires **adding a new `case` arm to `apps/intel-api/scripts/entrypoint.sh`** (today only `serve|migrate|enable-feature` exist; grep-confirmed). It is NOT a drop-in. Run it as a one-off task via the migrate task-def with a command override, or wire a scheduled EventBridge rule (**out-of-band, NOT CDK** — §7 risks).
- **Concurrency/locking:** the embed job is idempotent via the `[tenantId,sourceType,sourceId,model]` unique key (INSERT … ON CONFLICT DO NOTHING/UPDATE). To prevent two concurrent scheduled runs double-embedding, take a Postgres advisory lock (`pg_try_advisory_lock`) at job start and skip if held.
- **Connection-pool impact:** a bulk embed run is a second heavy Postgres consumer on the shared Aurora cluster alongside apps/api. Bound its pool size and batch commits; run off-peak (the scheduled window) to avoid contending with apps/api. Verify Aurora `max_connections` headroom before enabling.
- No new secret. **Rollback:** disable the schedule (delete EventBridge rule); roll serve image to drop the query endpoint. Embedded rows are inert; delete via a targeted `DELETE … WHERE source_type='hearing_segment'` only if reversing (never touch `source_type='bill'` — those are apps/api-owned).

**Dependencies:** F3 (transcript segments to embed) or existing committed segments; independent of cutover. Post-cutover per §6 timeline.

**Success criteria**
| Check | Verifier | Command / metric | Threshold | Gate unblocked |
|---|---|---|---|---|
| DB-role RLS standing (Case B) | Eng | Under the ported `withTenant`/`withSystem` (or as a BYPASSRLS role): `INSERT` a `hearing_segment` row + `SELECT` a NULL-tenant `bill` row on `context_embeddings` | both succeed with `app.current_tenant` set (or role confirmed BYPASSRLS); 0 `permission denied` / RLS-empty results | **gates all F6 writes** |
| Bill rows untouched (D2/s6) | Eng | After an embed run, diff `bill`-row count/hashes before/after | 0 inserts/updates/deletes on `source_type='bill'` (write scope proven `hearing_segment`-only) | ownership-safe |
| Task role Bedrock | Eng | One-off task `embedText('test')` | 1024-length vector; 0 `AccessDenied` | embedding writes |
| Segments embedded | Eng | `SELECT count(*) FROM context_embeddings WHERE source_type='hearing_segment' AND model='amazon.titan-embed-text-v2:0'` before/after run | strictly increasing across runs; 0 unique-key violations | F6 index |
| No double-embed under concurrency | Eng | Launch two embed jobs simultaneously; recount | count increments once (advisory lock held) | schedule-safe |
| Cross-source recall | Ninja | NL query known to match a bill AND a hearing quote | both appear, score ≥0.45, ranked sensibly | closes §5 F6 |
| Tenant isolation (Case B, RLS) | Eng | Query as tenant A (under `withTenant`) | 0 tenant-B `hearing_segment` rows; NULL-tenant `bill` rows still visible | cutover-safe |

---

### F7 — Alert scoring transparency (S)

**What to build**
- Surface the §6 composite score breakdown in the Feed. Backend `AlertScorer` (Phase 4) computes/stores `score` on `intel_alert`; add per-component contributions to `intel_alert.evidence(Json)` (`{score:{relevance,materiality,urgency,political,clientPriority,confidencePenalty,total}}`) so the UI renders "why High/Med/Low" without recomputation. Weights (registry §4 Phase 4): relevance 0.35, materiality 0.25, urgency 0.20, political/speaker 0.10, client-priority 0.10, minus confidence penalty. Bill-fit composite: `0.4×semantic + 0.3×textMatch + 0.15×exactEntity + 0.1×subjectMatch + 0.05×priorityBoost` (registry §6), floor `RECOMMENDATION_FLOOR=0.45`.
- UI: expandable score-breakdown in the Feed sub-view (Ant Design), no new endpoint (reads `evidence`).

**Deploy**
- Backend = a serialization addition on `intel_alert` writes — ships with the detect/scoring image; **prefer JSON `evidence` (no migration).** Only if a dedicated column is added does the migrate-first rule apply. Web change gated by `tracker_v2`. **Rollback:** roll image; older alerts simply lack the breakdown (UI must tolerate absent `evidence.score` — verify below). Shadow-only until Phase 8 (no delivery).

**Dependencies:** Phase 4 (`AlertScorer`) hard dependency — F7 cannot render breakdown until scores are computed and stored.

**Success criteria**
| Check | Verifier | Command / metric | Threshold | Gate unblocked |
|---|---|---|---|---|
| Breakdown stored | Eng | `SELECT evidence->'score' FROM intel_alert WHERE id=$1` | all 6 components + `total` present; `total∈[0,1]` | F7 backend |
| Weights reconcile | Eng | Recompute total from components | matches stored `score` within 1e-6 | correctness |
| UI renders why | Ninja | Expand a High alert in Feed | component contributions match stored JSON | closes §5 F7 |
| Legacy-alert tolerance | Eng | Open an alert written before F7 (no `evidence.score`) | UI degrades gracefully (no crash, breakdown hidden) | rollback-safe |

---

### Cross-workstream deployment checklist

- [ ] **ARM64** for every intel-api image (`docker buildx --platform linux/arm64 -f apps/intel-api/Dockerfile`, registry §1) — an accidental amd64 `:latest` will not pull on Fargate.
- [ ] **Migrate before serve** for F2/F5 (new tables) and any F3/F6 column adds: run `capiro-dev-intel-api-migrate` (`command ['migrate']`, container name `intel-api-migrate`), wait STOPPED + exit 0, THEN `update-service capiro-dev-intel-api --force-new-deployment` (registry §1). Migrate is forward-only `prisma migrate deploy` with failed-migration auto-resolve (confirmed in `entrypoint.sh`); NO seed step.
- [ ] **New one-off/scheduled jobs require a new `entrypoint.sh` case arm** (F6 embed-writer, any detect/flush verbs). Today only `serve | migrate | enable-feature` exist — adding a verb is a code change in the image, not config.
- [ ] **Two-case isolation model — apply the RIGHT one per table.**
  - **Case A — intel-OWNED tables (`intel_*`, no RLS):** every read/write MUST filter by `tenantId` explicitly in the WHERE clause. Do NOT add RLS policies to new intel tables that intel's single DB role cannot satisfy, and do NOT reach for a `withTenant` wrapper for these (it does not exist for owned tables and is unnecessary). Applies to F2 `intel_segment_analysis`, F5 `intel_feedback`, `intel_alert`.
  - **Case B — cross-RLS-boundary tables (`context_embeddings`, `clients`):** RLS is the primary isolation, keyed on `app.current_tenant`. s6/s7 REQUIRE porting/using `withTenant` (tenant-scoped) / `withSystem` (cross-tenant) so intel-api sets that session var on every read/write. App-level filtering alone is insufficient here. Applies to F6 (`context_embeddings` writes/reads) and any read of `clients`.
- [ ] **Cross-RLS-boundary reads/writes need role confirmation.** `context_embeddings` and `clients` carry apps/api RLS keyed on `app.current_tenant`, which intel-api does not set today. Before F5-adjacent and F6 work touches them, **confirm the intel-api DB role's RLS standing** (subject-with-session-var-wrapper vs `BYPASSRLS`) and whether it can read NULL-tenant `context_embeddings`. This blocks F6 writes. (F5's `intel_feedback` is Case A and NOT affected — it needs no such wrapper.)
- [ ] **`context_embeddings` ownership partition (D2/s6 reconciliation).** The table is shared/multi-writer: apps/api owns `source_type='bill'` rows; intel-api owns `source_type='hearing_segment'` rows. intel-api WRITES only `hearing_segment` and is READ-ONLY for `bill`. This does NOT violate D2 ("no writing apps/api tables"), because `hearing_segment` rows are intel-api's own data. Never insert/update/delete `bill` rows.
- [ ] **Out-of-band, NOT `cdk deploy`** for: F3 S3 bucket, F3 ALB listener rule (run `describe-rules` first; priority 12/17 — confirm no collision), F6 scheduled embed job. A `cdk deploy` must not drop these (§7 risks).
- [ ] **Single-sender / shadow invariant.** F2/F6/F7 write shadow rows only (`status=new`, 0 delivered). No workstream is a second sender. Delivery requires BOTH `tracker_owner_intel` AND the Phase 8 single-sender cutover — never one alone (§4/§8).
- [ ] **Flags:** `tracker_v2` (UI, fails closed) + `tracker_owner_intel` (backend data/alert path). Enable per tenant via the confirmed `enable-feature <flag> <tenantSlugOrId>` verb.
- [ ] **UNVERIFIED — confirm before build (do not invent):** task-role Bedrock perms (F2 direct-call/F6); task-role S3+KMS perms (F3); intel-api DB-role RLS standing on `context_embeddings`/`clients` + ability to set `app.current_tenant` + NULL-tenant `context_embeddings` read (F6 Case B); `AiCredentialResolverService` + `ai_usage_events` presence in intel-api (F2 metering — CONFIRMED ABSENT, so port or re-route); `IntelligenceChange` table in intel-api (alert emit — CONFIRMED ABSENT, port or re-target); `intel_topic`/`intel_term` vs existing `intel_watchlist_term` (registry §5 — existing table is `intel_watchlist_term` with cols `term_type`/`value`/`weight`); ALB free priority (`describe-rules`); S3 bucket name + SOC 2 retention window; Deepgram per-request keyterm cap (F1); orchestrator LLM model id (F2).

---

## 14. Environments, sequencing & dependencies

This section makes §3 (phases), §6 (timeline) and §4 (cutover) *deployment-ready*: it fixes the environment promotion path, the hard per-deploy ordering rule, the phase→phase dependency graph, what can run in parallel, and the entry/exit gate for every milestone. A phase is **not "done"** until its exit gate is green (typecheck + build + test + deployed + verified-in-prod, or verified-in-shadow for shadow-only phases). A dependency is **not started** until its blocker's exit gate is green.

**Model reminder (do not contradict downstream):** this is a **strangler + shadow + single-sender** cutover. Until a tenant is cut (P8), **legacy apps/api is the sole sender/owner**; intel-api runs **shadow-only** (detects + would-send, suppressed). After cut, **intel-api is the sole sender/owner** for that tenant and legacy skips it. There is never a window where both send for the same tenant — every gate below is written to prove exactly one sender at all times.

---

### 14.1 Environment promotion path

Per the registry there are **two ECS environments in the SAME account (`967807252336`, `us-east-1`) — no separate staging account for intel-api.** Promotion is `dev → prod`, both out-of-band clusters (NOT in CDK):

| Stage | Cluster | intel-api serve svc | intel-api migrate task-def | ECR repo | Secrets namespace | Log group |
|---|---|---|---|---|---|---|
| **dev** | `capiro-dev` | `capiro-dev-intel-api` | `capiro-dev-intel-api-migrate` | `967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/intel-api` | `capiro/dev/*` | `/capiro/dev/intel-api` (streams `intel-api`, `intel-api-migrate`) |
| **prod** | `capiro-prod-os-capiro` | **UNVERIFIED — confirm** (registry: likely `capiro-prod-intel-api` / `capiro-prod-os-capiro-intel-api`) | `capiro-prod-intel-api-migrate` | `967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/prod-os-capiro/intel-api` | `capiro/prod-os-capiro/*` | `/capiro/prod-os-capiro` |

Rules:
- **Confirm the prod serve service name before ANY prod deploy** (registry marks it UNVERIFIED): `aws ecs list-services --cluster capiro-prod-os-capiro --region us-east-1`. Do not invent it. PRE-0 exit gate resolves this to a concrete value.
- Prod serve/migrate task-def **families** are `capiro-prod-intel-api` / `capiro-prod-intel-api-migrate` (registry §1). The *serve service* name is the only UNVERIFIED item — the family names are canonical.
- Every intel-api migration and code change **lands and is verified in dev first**, then promotes to prod with the identical run-task→redeploy sequence against the prod cluster/family (§14.2). Prod build uses CodeBuild `capiro-build-intel-api-prod` (push-only, no auto-redeploy) — the redeploy step is run explicitly per §14.2.
- **Both clusters and the prod ALB (`capiro-prod-alb`) are out-of-band.** A `cdk deploy` MUST NOT touch them or any manually-added ALB rule.
- Log-group quirk (registry): `resolved.json` shows a WRONG `/capiro/dev/api` in one place — the intel-api template uses `/capiro/dev/intel-api`. Assert the correct log group in preflight.
- Prod-cluster naming quirk (memory): the live *api* runs as `capiro-dev-*` under an ALB named `capiro-prod-alb`; for **intel-api** prod, use the `capiro-prod-os-capiro` cluster + `prod-os-capiro` repo/secret names verbatim.

---

### 14.2 HARD RULE — arm64 build + migrate-before-serve (every intel-api deploy, dev AND prod)

Non-negotiable; applies to **every** phase that ships an intel-api image or migration. Mirrors `scripts/deploy-dev.sh` (registry §1) and the workspace `ws_notification` lesson (migrate task must precede serve roll).

**Ordered steps (fail-closed — abort on any non-green step):**

1. **Preflight** — assert: caller account is `967807252336` (`aws sts get-caller-identity`), region `us-east-1`, target cluster matches the stage, current git SHA recorded, correct log group (`/capiro/dev/intel-api`, not `/capiro/dev/api`), and record the **currently-running serve task-def revision** (for rollback). Capture pre-deploy `/health` (intel-api `:4300/health`) = 200.
2. **Build + push arm64** (prod Fargate is ARM64 — an amd64 `:latest` will refuse to pull; memory: an accidental amd64 push already happened once):
   ```
   docker buildx build --platform linux/arm64 \
     -f apps/intel-api/Dockerfile \
     -t 967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/intel-api:latest \
     -t 967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/intel-api:<GIT_SHA> \
     --push <REPO_ROOT>
   ```
   (For prod, swap the repo to `.../capiro/prod-os-capiro/intel-api`.) CI equivalent `.github/workflows/intel-api-image.yml`, `docker/build-push-action@v6`, `platforms: linux/arm64`, triggers on `apps/intel-api/**`, `packages/meriv2-core/**`, `packages/shared/**`, `pnpm-lock.yaml`; OIDC assumes `AWS_DEV_GHA_ROLE_ARN` / `AWS_PROD_GHA_ROLE_ARN`. CodeBuild: `capiro-build-intel-api` (dev, ARM_CONTAINER/BUILD_GENERAL1_LARGE, builds+pushes+forces redeploy) / `capiro-build-intel-api-prod` (prod, push-only — you still run step 3–4 explicitly).
   - **Tag immutably by `<GIT_SHA>`** and deploy that tag; `:latest` is a convenience alias only. Rollback (step 6) targets a prior SHA/revision, never a floating `:latest`.
3. **MIGRATE FIRST** — run the migrate task-def to completion, then verify STOPPED + exit 0:
   ```
   aws ecs run-task --cluster capiro-dev --launch-type FARGATE \
     --task-definition capiro-dev-intel-api-migrate \
     --network-configuration 'awsvpcConfiguration={subnets=[...],securityGroups=[...],assignPublicIp=DISABLED}' \
     --overrides 'containerOverrides=[{name=intel-api-migrate,command=["migrate"]}]'
   ```
   Entrypoint `migrate` mode runs `prisma migrate deploy` (auto-rolls-back previously-failed migrations), then exits. **No seed step** (unlike apps/api, which also runs `seed-workflows.ts`). Migrate gets **ONLY DB_\* secrets + `DB_NAME` env**; entrypoint composes URL-encoded `DATABASE_URL` with `sslmode=require`. Container override name MUST be exactly `intel-api-migrate`.
   - **subnets/SGs: UNVERIFIED — confirm** from `scripts/deploy-ingestion-out-of-band.sh` run_job_wait template / resolved task-defs before running. Resolved in PRE-0.
   - **Migration concurrency:** `prisma migrate deploy` takes Prisma's advisory lock, so a second concurrent migrate task blocks rather than corrupting. Still, **serialize deploys** — do not run two migrate tasks against the shared `capiro` Aurora at once (dev and prod share the cluster). One deploy in flight at a time.
   - **DDL vs the live api:** these migrations only add `intel_*` tables/columns and read GLOBAL tables — they must **not** ALTER any table apps/api writes (`congress_bill`, `context_embeddings`, `clients`, etc.). Assert the migration diff touches only `intel_*` objects before applying (prevents locking a table the live api is writing).
4. **Roll serve** — only after step 3 exit 0:
   ```
   aws ecs update-service --cluster capiro-dev --service capiro-dev-intel-api --force-new-deployment
   aws ecs wait services-stable --cluster capiro-dev --services capiro-dev-intel-api
   ```
5. **web roll** (Phase 7 only) — `aws ecs update-service --cluster capiro-dev --service capiro-dev-web --force-new-deployment`. Order-independent vs serve.
6. **Rollback** — if any of steps 3–4 (or post-roll `/health`) go red: re-point the serve service to the **prior task-def revision** recorded in step 1 (`update-service --task-definition <family>:<prev-rev>`), `wait services-stable`, re-check `/health`. Schema note: intel-api migrations are **additive-only** (new `intel_*` objects), so the prior image runs fine against the migrated schema — no down-migration needed. The phase gate stays **closed** until a clean re-run.

> Migrate ALWAYS before serve roll. Never `--force-new-deployment` the serve service with an un-migrated schema — the new image boots against a schema missing its `intel_*` columns and fails closed.

**Connection-pool note:** intel-api is a **second** Prisma client against the shared Aurora `capiro` cluster. Its pool size adds to apps/api's. Set a conservative `connection_limit` on the composed `DATABASE_URL` (or PgBouncer if present) so serve + concurrent migrate/verb tasks don't exhaust Aurora `max_connections`. **UNVERIFIED — confirm Aurora max_connections headroom and intel-api pool sizing** before P1 turns on scheduled verbs (PRE-0).

**Success criteria (per deploy) — owner: release engineer, gate: all four green or rollback:**
- (a) pushed image manifest is `arch=arm64`: `docker buildx imagetools inspect <ecr>/capiro/<ns>/intel-api:<GIT_SHA>` reports `linux/arm64`.
- (b) migrate task `lastStatus=STOPPED` AND `containers[0].exitCode=0`: `aws ecs describe-tasks --cluster <cluster> --tasks <arn> --query 'tasks[0].{s:lastStatus,e:containers[0].exitCode}'`.
- (c) serve service reaches `services-stable` (command returns 0).
- (d) post-roll `GET :4300/health` = 200.
Any red → step 6 rollback; phase gate stays closed.

---

### 14.3 Dependency graph (what blocks what)

```
                         ┌─────────────────────────────────────────────┐
                         │ PRE-0  Infra grants (blocks P1)              │
                         │  • task role: bedrock:InvokeModel (Titan +   │
                         │    Claude), ses:SendEmail  [UNVERIFIED]      │
                         │  • exec role: ECR pull + Secrets read        │
                         │  • confirm subnets/SGs, prod serve svc name, │
                         │    Aurora pool headroom, SES identity,       │
                         │    RLS role (withTenant/withSystem)          │
                         └───────────────┬─────────────────────────────┘
                                         │ (gate green)
                    ┌────────────────────▼────────────────────┐
                    │ P1 Foundations (SourceDataRepository,     │
                    │ embeddings query-side, task-verb runner,  │
                    │ RLS withTenant/withSystem) [BLOCKER root] │
                    └───┬───────────────┬──────────────────┬────┘
                        │               │                  │
              ┌─────────▼──────┐  ┌─────▼──────────┐   ┌───▼────────────┐
              │ P2 Watchlist + │  │ (parallel WS)  │   │ F1 keyterms    │
              │ one-way sync   │  │  none blocked  │   │ (needs Compiler│
              └───────┬────────┘  │  by P1 alone   │   │  from P2)      │
                      │           └────────────────┘   └────────────────┘
              ┌───────▼────────┐
              │ P3 Match engine│◄── needs P1(embeddings/repo)+P2(compiled watchlist)
              │ + detect(shadow)│
              └───────┬────────┘
              ┌───────▼────────┐
              │ P4 Alert model,│◄── needs P3 (intel_alert rows to score/deliver)
              │ scoring, deliv.│    + PRE-0 SES grant + verified SES identity
              │ (shadow)       │
              └───────┬────────┘
              ┌───────▼────────┐
              │ P5 Parity gate │◄── needs P3+P4 producing shadow alerts
              │ (≥95% overlap) │    GATES P8 cutover
              └───────┬────────┘
                      │            ┌────────────────────────────┐
              ┌───────▼────────┐   │ P6 Combined feed + bill↔    │◄─ needs P3 tracked_bill
              │ P7 Tracker UI  │◄──┤ hearing linker              │   + hearing pipeline
              │ (needs P6 feed │   └────────────────────────────┘
              │  API + flags)  │   ┌────────────────────────────┐
              └───────┬────────┘   │ F2 stance / F3 pre-recorded │ (hearing side,
                      │            │ /F4 brief/F5 feedback/F6/F7 │  independent of P1-P5)
              ┌───────▼────────┐   └────────────────────────────┘
              │ P8 Cutover     │◄── GATED BY P5 (parity) + P7 (UI) + ALB rule (if web-exposed)
              │ (per-tenant)   │
              └───────┬────────┘
              ┌───────▼────────┐
              │ P9 Decommission│◄── all tenants flipped + 2-wk burn-in
              └────────────────┘
```

**Hard blockers (do not start the successor until the blocker's exit gate is green):**

| Successor | Blocked by | Reason |
|---|---|---|
| P1 | PRE-0 grants | Bedrock/SES/exec-role perms + RLS role + Aurora pool headroom confirmed, else P1 tasks fail at runtime |
| P2 | P1 (repo + RLS ctx) | Sync writes tenant-scoped `intel_watchlist*` under RLS — needs `withTenant`/`withSystem` proven |
| P3 | P1 + P2 | MatchEngine needs embeddings query-side (P1) **and** a compiled watchlist (P2) |
| P4 | P3 + PRE-0 SES | Scorer/delivery operate on `intel_alert` rows P3 produces; delivery needs verified SES identity |
| P5 | P3 + P4 | Parity diffs intel shadow alerts vs legacy — needs both producing |
| P6 | P3 (`intel_tracked_bill`) + hearing pipeline | Linker joins tracked bills to hearing mentions |
| P7 | P6 (feed API) + flags (`tracker_v2`) | UI renders the combined feed endpoint |
| **P8** | **P5 green N=7 days** + P7 shipped + ALB rule (if web-exposed) | Single-sender cutover requires proven parity + working UI |
| P9 | All tenants on P8 + 2-wk burn-in | Cannot delete legacy while any tenant depends on it |

---

### 14.4 Parallelization guidance

Run these tracks concurrently — they share no blocker:

- **Track A (migration spine):** PRE-0 → P1 → P2 → P3 → P4 → P5 → P8 → P9. Critical path; everything else fits around it.
- **Track B (hearing completion, §5 F-series):** F2 (stance), F3 (pre-recorded + S3), F4 (brief UI), F5 (feedback), F6 (archive search), F7 (score UI). Independent of P1–P5 except:
  - **F1 keyterms** needs the `WatchlistCompiler` (ships in P2) → start F1 the moment P2's exit gate is green, not before. F1 wires `keywords` into `deepgram.listen.live(...)` (`deepgram-stream.manager.ts:72-80`) sourced from HearingGateway sessionContext.
  - F3/F6 add a NEW dep to intel-api (`@aws-sdk/client-s3` — no S3 client exists today) → land that infra change in a **dedicated deploy** so it doesn't stall the migration spine. Also confirm the task role has S3 perms for the target bucket (currently unstated).
- **Track C (frontend prep):** the new intel-api web client module (registry §8 names the legacy file `apps/web/src/pages/clients/tracker/tracker-api.ts`; the **new** module path is a to-create file — name it and land it against stubs before P6), the sub-tab shell (`Panel = board|hearings|feed|configure`, `sessionStorage PANEL_KEY` try/catch pattern), and the `useIntelFeatureEnabled('tracker_v2')` gate (`apps/web/src/lib/intel-feature-flags.ts`, GET `/intel-api/feature-flags`, 60s staleTime, **fails CLOSED → `{}`**) can be built against stubs **before P6** — but P7's exit gate cannot close until P6's feed API is live.
- **ALB rule work (only if intel-api web calls go direct, not proxied through `/api/*`):** registry says **NO `/intel-api/*` ALB rule exists today** (intel-api is internal-only on :4300). If P7 calls intel-api directly, add a listener rule **out-of-band via `aws elbv2 create-rule`** (NOT `cdk deploy`; prod ALB manually managed/wedged). Suggested priority 12 or 17 — **UNVERIFIED, confirm no collision** against existing priorities 3/5/10/15/20. Hard dependency of P8 for web-exposed tenants; schedule during P7, gate on "rule present + returns 200 for a flagged tenant". (If P7 instead proxies intel calls through the existing `/api/*` rule, no ALB change is needed — decide this explicitly, don't leave it ambiguous.)

Do **not** parallelize across a hard blocker (§14.3). E.g. P4 delivery cannot be built "ahead" against imaginary P3 alerts — its tests need real `intel_alert` rows.

---

### 14.5 Per-milestone entry/exit gates

Each phase: **Entry** = its blockers' exit gates are green. **Exit** = ALL of typecheck + build + test + deployed + verified-in-prod (or verified-in-shadow where the phase is shadow-only). Every "verified" names a **command/metric + threshold + gate + owner**.

> Repo-wide check note (memory): `pnpm lint` is broken repo-wide (eslint not installed) — **gate on `pnpm typecheck` + prettier + tests, never on lint.** Fresh worktrees need `@capiro/shared` built + `prisma generate` before api/intel-api typecheck; jest may discover 0 tests in a worktree (reparse points) — verify logic via `tsx` there.

> **Canonical parity score-delta tolerance (single source of truth — do not restate a different number elsewhere).** The parity gate compares intel shadow fit-scores against legacy fit-scores for the same bill using **three distinct metrics**, each with its own threshold; they are NOT interchangeable and must all pass:
> - **per-bill fit-delta ≤ 0.02** — every individual bill's `|intel_fit − legacy_fit|` must be ≤ 0.02 (the strictest, per-row check; matches s17 §17.2).
> - **p95 fit-delta ≤ 0.05** — the 95th-percentile of `|intel_fit − legacy_fit|` across all scored bills must be ≤ 0.05 (matches s8 §8.3 p95).
> - **max fit-delta ≤ 0.10** — the maximum `|intel_fit − legacy_fit|` across all scored bills must be ≤ 0.10 (matches s8 §8.3 max).
>
> This resolves the prior conflict where s8 (max ≤0.10 / p95 ≤0.05), s14 (±0.05), and s17 (≤0.02) each stated one number for "the" parity threshold: they are three **different measurements** of the same distribution, not three competing values for one measurement. s14, s8 §8.3, and s17 §17.2 must all cite this triple.

| Phase | Entry gate | Exit gate (command/metric + threshold + owner) |
|---|---|---|
| **PRE-0** | plan approved | **AWS/SRE** confirms via `aws iam get-role-policy` + `aws iam simulate-principal-policy`: task role `...ApiTaskRole...` has `bedrock:InvokeModel` for **Titan embed** (`amazon.titan-embed-text-v2:0`) **and** Anthropic Claude on Bedrock, **and** `ses:SendEmail`; exec role `...ApiTaskDefExecutionRole...` has ECR pull + Secrets read (matches `infra/deploy/intel-api-execrole-inline-policy.json`). **SES identity** for `TRACKER_ALERT_EMAIL_FROM` verified in `us-east-1` and account out of sandbox (`aws ses get-identity-verification-attributes` / `get-account`). subnets/SGs resolved to concrete values; **prod serve svc name** confirmed (`aws ecs list-services --cluster capiro-prod-os-capiro`); Aurora `max_connections` headroom + intel-api pool sizing decided; **RLS**: confirm intel-api's Prisma DB role + `withTenant`/`withSystem` availability and that the role can read `context_embeddings` NULL-tenant rows. **Every UNVERIFIED registry row resolved to a concrete value.** Gate: all boxes checked, SRE signs off. |
| **P1** | PRE-0 green | `pnpm typecheck` clean (intel-api + shared); arm64 image built+pushed + migrate exit 0 (§14.2); **verify-in-dev (owner: eng):** one-off `task` verb (a) reads a real `congress_bill` row by id, AND (b) returns a cosine-ranked list from `context_embeddings` for a test vector using the registry §6 SQL (`source_type='bill'`, model = `EMBEDDING_MODEL`, floor `0.3`, LIMIT 400), **including ≥1 NULL-tenant global row** (proves RLS `tenant_id IS NULL` read works under intel-api's role) AND a tenant-scoped read under `withTenant` returns only that tenant's rows. Eng signs off on the task log. |
| **P2** | P1 green | **First resolve the table-name ambiguity:** registry flags `intel_topic`/`intel_term` as PROPOSED and warns not to conflate with existing hearing tables `intel_watchlist`/`intel_watchlist_term`/`intel_watchlist_match` — **confirm reuse of `intel_watchlist_term` vs new `intel_topic`/`intel_term` BEFORE writing the migration.** Then: migration applied (migrate exit 0, dev then prod); **verify-in-dev (owner: eng):** run the one-way sync verb, assert every legacy `ClientWatchlist`+`AlertPreference` row appears in the unified tables per §5 mapping (row-count diff = 0, field diff = 0), AND **re-run is a no-op (0 rows changed)** proving idempotency. The mapping is one-way legacy→unified only (shadow model — legacy stays authoritative until P8); reverse sync belongs to P8, not here. |
| **P3** | P1 + P2 green | typecheck + build + arm64 deploy; **unit tests assert verbatim port** of `classifyChange` (the full 10-row regex cascade → changeType/severity/triggerKey, most-significant-first) and composite fit `= max(0, min(1, 0.4·semantic + 0.3·textMatch + 0.15·exactEntity + 0.1·subjectMatch + 0.05·priorityBoost))` with `RECOMMENDATION_FLOOR=0.45`, `EMBED_CANDIDATE_FLOOR=0.3`, `MIN_TERM_LEN=3`, and SEVERITY_RANK/MATERIALITY_RANK/`clearsMateriality`; **verify-in-shadow (dev):** `detect` verb writes `intel_alert` rows (status=new, **no delivery**) for a seeded tracked bill with a known material action; the IntelligenceChange 14-day dedupe is exercised (a second identical action → 0 new rows). **Note:** `IntelligenceChange` is an apps/api table — **UNVERIFIED whether it exists in intel-api schema; confirm or re-target before emit.** Owner: eng. |
| **P4** | P3 + PRE-0 SES green | typecheck + build + deploy; delivery ported (SESv2 via `TrackerEmailService`, quiet-hours ET/midnight-wrap, cadence email realtime\|daily\|weekly + SMS realtime\|daily, `intel_notification_log` idempotency on unique `(alertId,userId,channel)` where `alertId='tracker:'+clientId+':'+billId+':'+changeType`); summaries gated behind `TRACKER_ALERT_SUMMARY` (fail-safe → null, metered to `ai_usage_events` — **confirm `ai_usage_events` + `AiCredentialResolverService.resolveProviderByTenantId` exist in intel-api or port them**); **verify-in-shadow (owner: eng):** dry-run logs the exact emails it *would* send but sends **0** (shadow); `intel_notification_log` rows written with a shadow/suppressed marker; a forced duplicate `detect` run produces **0** additional claims (P2002 → skip). `flushDigests` poison-row safety (mark flushed regardless of send outcome) covered by a test. |
| **P5** | P3 + P4 green | `parity-report` verb over a rolling window; **exit ONLY when, for N=7 consecutive days across pilot tenants (capiro-internal + demo "Aperture Defense Systems"):** (a) alert-set overlap vs legacy ≥ **95%**, (b) **zero** legacy-critical alerts (severity=critical) missed by intel, (c) fit-score deltas within the **canonical parity tolerance triple** defined above §14.5 — **per-bill fit-delta ≤ 0.02 AND p95 fit-delta ≤ 0.05 AND max fit-delta ≤ 0.10** (all three must hold; consistent with s8 §8.3 and s17 §17.2). Owner: **SRE + eng co-sign** the 7-day report. **This gate unblocks P8.** Consistent with shadow model: parity is measured while legacy is still the sole sender. |
| **P6** | P3 + hearing pipeline green | typecheck + build + deploy; `GET /intel-api/clients/:clientId/feed` live; **verify-in-dev (owner: eng):** a tracked bill scheduled for a hearing, then mentioned in it, shows bill + hearing + combined alert in one client feed, each with evidence (bill diff / transcript timestamp + segmentId). |
| **P7** | P6 feed API live + `tracker_v2` flag exists | web typecheck + build + web roll (§14.2 step 5); **verify-in-prod, flagged test tenant ONLY (owner: eng):** Tracker tab renders Board/Hearings/Feed/Configure from intel-api (`useIntelFeatureEnabled('tracker_v2')`); flag hook **fails closed** (endpoint error → `{}` → legacy TrackerTab); **un-flagged tenants see unchanged legacy TrackerTab** (proves coexistence, no double-render). If web-exposed: ALB `/intel-api/*` rule present + returns 200 for the flagged tenant. No tenant is *cut* here — P7 only enables the read-side UI behind the flag. |
| **P8** | **P5 green (7d)** + P7 shipped + (ALB rule if web-exposed) | Per-tenant, execute §4 runbook in order: final one-way sync → catch-up `detect` → enable `tracker_owner_intel` (via one-off `enable-feature tracker_owner_intel <tenantSlugOrId>`) → enable `tracker_v2` → **disable legacy sending for that tenant** (single-sender handoff) → 48h watch. **Verify-in-prod (owner: SRE):** for the cut tenant, legacy `detect-tracker-alerts` skips it (`isIntelOwned`=true), intel sends, and `intel_notification_log` + `parity-report` show **zero duplicate sends** for 48h. **Rollback proven:** disabling `tracker_owner_intel` + `tracker_v2` restores legacy send/serve (intel never wrote apps/api tables — strangler invariant), verified by a test flip on the pilot tenant. |
| **P9** | ALL tenants on P8 + 2-wk burn-in green | Disable legacy EventBridge rules (`detect-tracker-alerts`, `emit-bill-alerts`, `flush-tracker-digests`) — these are **out-of-band, NOT in CDK**; remove `apps/api/src/tracker/*` + legacy web `apps/web/src/pages/clients/tracker/tracker-api.ts`; keep `ClientWatchlist`/`TrackedBill` read-only for one release, then drop via an additive-reversal migration. **Verify (owner: SRE):** no legacy tracker send in logs for **14 days**; typecheck/build/test green post-removal; deployed to prod via §14.2. |

**Enforcement:** the phase board tracks each gate as a checkbox; a successor's Entry gate literally references the predecessor's Exit gate checkbox. A gate is **binary green** — "deployed" without "verified-in-prod" (or verified-in-shadow for shadow phases) does **not** count as done. No amber-flips-to-start.

**Success criteria (§14.5 gate enforcement) — owner: SRE + eng, gate: all green or the milestone stays open:**
- Every phase's Exit gate names a concrete command/metric + threshold + owner (table above); a phase is done only when ALL of typecheck + build + test + deployed + verified-in-prod (or verified-in-shadow for shadow phases) are green.
- The **P5 parity gate** passes only when, for **N=7 consecutive days** on pilot tenants, all of: alert-set overlap ≥ 95%, zero critical misses, **and** the canonical parity tolerance triple — **per-bill fit-delta ≤ 0.02, p95 fit-delta ≤ 0.05, max fit-delta ≤ 0.10** — hold simultaneously (identical wording to s8 §8.3 and s17 §17.2; no other score-delta number is used anywhere).
- P8 entry references the SAME "P5 green N=7 days" checkbox; there is exactly one 7-day parity definition across s8 §8.6, s14 §14.5, and s17.
- Each successor's Entry gate references its predecessor's Exit checkbox verbatim (§14.3 blocker table); no gate flips to "start" on amber.

---

### 14.6 Out-of-band artifacts to protect across all environments

Both clusters, the prod ALB, and the schedules live outside CDK. Every deploy checklist must re-assert these survive (a `cdk deploy` elsewhere in the repo must not drop them):

- **ALB listener rules 3/5/10/15/20** (registry §1) + any **new** `/intel-api/*` rule added for P7/P8 (out-of-band `aws elbv2 create-rule`, priority confirmed non-colliding).
- **New intel EventBridge schedules** (the `detect` / `flushDigests` entrypoint verbs) — out-of-band, mirroring the existing `capiro-dev-sync-*` and legacy `detect-tracker-alerts`/`flush-tracker-digests` rules. **Locking/concurrency:** these verbs must be safe against overlap — the `intel_notification_log` unique `(alertId,userId,channel)` + P2002-skip gives per-alert idempotency, but also configure the EventBridge/ECS run so a slow run can't stack (single concurrent invocation, or a claim/lease guard) to avoid duplicate digest fan-out.
- **Migrate task-def wiring** (migrate-on-deploy) — the §14.2 ordering is the guard against the `ws_notification` "migration never applied" class of bug.
- **Secrets** (`capiro/dev/intel-api/*`, `capiro/prod-os-capiro/intel-api/*`, Aurora `capiro/*/aurora/*`, `capiro/*/clerk/secret-key`) — exec role must retain Secrets-read; a task-def re-render must not drop a secret ref (re-assert the full set post-deploy).
- **CodeBuild projects** `capiro-build-intel-api` (dev) / `capiro-build-intel-api-prod` (prod) — out-of-band build path; the redeploy step in §14.2 is explicit for prod since the prod project is push-only.

---

## 15. Observability, SLOs & rollback triggers

**Purpose.** Make the parallel-run and per-tenant cutover *observable and self-halting*. This section defines every metric, log, alarm, SNS topic, SLO, and numeric rollback trigger for the unified system. It enforces the plan's #1 risk control — the single-sender guarantee (D5) — with a **double-send canary** whose non-zero value is an auto-halt condition. It also hardens against the historical failure recorded in the alerting memory: prod SNS topics `capiro-dev-alerts` + `capiro-dev-platform-alarms` had **zero subscribers**, so every alarm was silent. **Every alarm below MUST have a confirmed subscriber before it is trusted (S2 gate).**

**Consistency with the strangler/shadow/single-sender model.** This section only *observes and gates* the cutover; it does not introduce a second sender. In shadow, intel-api detect runs write rows but do **not** deliver (`TRACKER_ALERTS_ENABLED=OFF`, registry §2). Delivery for a tenant flips exactly once — legacy `apps/api` detect-tracker-alerts stops owning that tenant the moment `tracker_owner_intel` is enabled — so there is never a sanctioned window where both services send. The canary (15.2) exists only to catch a *violation* of that invariant, not a designed overlap.

---

### 15.0 UNVERIFIED items that block this section (resolve in Phase 1)

This section names several things the registry marks **UNVERIFIED**. Do not create alarms, filters, or schedules against guessed values. Each must be confirmed and this section updated with the literal value before the corresponding wiring step (15.7) runs:

- **PROD intel-api service name** — registry lists DEV `capiro-dev-intel-api`; PROD is out-of-band and unconfirmed (likely `capiro-prod-intel-api` or `capiro-prod-os-capiro-intel-api`). Blocks M17/dashboard §8 and any `RunningTaskCount` dimension.
- **PROD SNS topic ARNs** — alerting memory names *DEV-suffixed* topics `capiro-dev-alerts` / `capiro-dev-platform-alarms` in account `967807252336`; whether PROD uses a `-prod-os-capiro`-suffixed topic is unconfirmed. Blocks every `--alarm-actions`.
- **PROD log group** — registry: DEV `/capiro/dev/intel-api` (streams `intel-api`, `intel-api-migrate`); PROD `/capiro/prod-os-capiro`. `resolved.json` shows a WRONG `/capiro/dev/api` in one place. Blocks every metric filter.
- **Subnets/SGs** for one-off `run-task` / EventBridge `run-task` — pull from `scripts/deploy-ingestion-out-of-band.sh` run_job_wait template / resolved task-defs. Blocks 15.7 step 6.
- **intel-api Prisma role / `withTenant` / `withSystem`** and whether that role can read `context_embeddings` NULL-tenant rows and cross-tenant `notification_log` — blocks the canary (15.2) and RLS-correct detection.
- **`ai_usage_events` table + `AiCredentialResolverService` in intel-api** — blocks M15 Bedrock token metering; documented fallback below.
- **SES configuration set + event destination** feeding bounce/complaint/delivery — blocks M6.
- **`TRACKER_ALERT_EMAIL_FROM` identity is SES-verified** in the account/region (and, if the account is still in the SES sandbox, that recipients are verified) — blocks any real send in S3/S9 and all live delivery.
- **Table/column reality for delivery metrics** — registry attests only these NEW intel-api tables: `intel_watchlist`, `intel_watchlist_term`, `intel_watchlist_match` (hearing, EXISTING); and PROPOSED `intel_tracked_bill`, `intel_alert_preference`, `intel_notification_log`, plus PROPOSED `intel_topic`/`intel_term` (vs. reuse of `intel_watchlist_term` — **do not conflate**, registry §5). There is **no attested `intel_alert` table, nor `status`/`sent_at`/`deliveredAt` columns**. Every metric below that reads such a column is marked **UNVERIFIED — confirm exact table/column** and must be re-pointed at the real schema before its filter/SQL is created.
- **`IntelligenceChange` as an intel-api table** — registry §6 flags it exists in apps/api but UNVERIFIED in intel-api; any freshness metric derived from it must confirm the source table first.

---

### 15.1 Signal inventory (what we measure)

intel-api today is HTTP-only with a single `bootstrap()`; the tracker jobs become **entrypoint verbs** run as one-off ECS tasks on the migrate-shaped task-def (`capiro-dev-intel-api-migrate`, container name `intel-api-migrate`, command overridden). Registry §6 grounds three of these verbs directly on existing scripts — **use these exact names**:

- `detect-tracker-alerts` (from `scripts/detect-tracker-alerts.ts`) — detection cycle.
- `emit-bill-alerts` (from `scripts/emit-bill-alerts.ts`) — IntelligenceChange emit.
- `flush-tracker-digests` (from `scripts/flush-tracker-digests.ts`) — digest flush.
- `enable-feature <flag> <tenantSlugOrId>` (registry §1/§3) — per-tenant flag flip.

Three further verbs are **NEW and NOT in the registry — mark UNVERIFIED (must add + name-confirm):** `sync-watchlists-from-legacy` (legacy→unified reconciliation, registry §5 mapping), `parity-report` (shadow overlap), `double-send-canary` (15.2). Their metric names below are provisional until the verbs land.

Each verb emits a **single structured JSON summary line** to its CloudWatch log stream on exit; a CloudWatch **metric filter** turns that line into a custom metric. Serve-path signals come from the `intel-api` serve container log stream + task/ALB metrics.

**Custom metric namespace:** `Capiro/IntelTracker` (new). Dimension `Tenant` where per-tenant granularity is needed (canary, parity), else service-level.

| # | Signal | Source | Metric (namespace `Capiro/IntelTracker`) | Unit |
|---|--------|--------|------------------------------------------|------|
| M1 | `detect-tracker-alerts` run success | verb exit JSON `{verb, ok:true/false, exitCode}` | `DetectRunSuccess` (1/0), `DetectRunFailure` | Count |
| M2 | detect lag = now − max(`congress_bill_action.date`) processed (col attested, registry §4) | verb JSON `lagMinutes` | `DetectLagMinutes` | Minutes |
| M3 | detect job duration | verb JSON `durationMs` | `DetectDurationMs` | Milliseconds |
| M4 | `sync-watchlists-from-legacy` drift (NEW verb — UNVERIFIED) = rows differing legacy vs unified after run | verb JSON `driftCount` (should be 0 post-sync) | `WatchlistSyncDrift` | Count |
| M5 | Delivery success/failure — **UNVERIFIED: source is `intel_notification_log` but no `status` column is attested; confirm the real success/fail column or derive from `flush-tracker-digests`/`fanOut` return** | verb JSON `{sent, failed}` | `AlertsSent`, `AlertsSendFailed` | Count |
| M6 | Bounce/complaint/delivery rate | SES event notifications (config set → SNS → metric); **UNVERIFIED SES config set exists (15.0)** | `SesBounces`, `SesComplaints`, `SesDeliveries` | Count |
| M7 | **Double-send canary** (D5 guard) | see 15.2 | `DoubleSendCanary` (per `Tenant`) | Count |
| M8 | Parity score (shadow) — NEW `parity-report` verb (UNVERIFIED) | verb JSON `{overlapPct, missedCriticals, scoreDeltaP95}` | `ParityOverlapPct`, `ParityMissedCriticals` | Percent / Count |
| M9 | Combined-feed latency | serve access log p95 on the feed route — **UNVERIFIED route path; no `/intel-api/*` ALB rule exists today (registry §1), and exposing intel-api web calls requires ADDING a listener rule (suggest priority 12/17, confirm no collision). Until then intel-api is internal-only on :4300 and this metric is unmeasurable via ALB.** | `FeedLatencyP95Ms` | Milliseconds |
| M10 | Bill-alert freshness = delivery time − source action date — **UNVERIFIED: no `intel_alert.deliveredAt`; use `intel_notification_log` insert time (confirm column) minus `congress_bill_action.date`** | verb/serve JSON `freshnessMinutes` | `AlertFreshnessMinutes` (p95) | Minutes |
| M11 | Brief latency = `HearingBrief.generatedAt` − session end (attested field, registry §7) | serve JSON | `BriefLatencyMinutes` (p95) | Minutes |
| M12 | Deepgram error/reconnect (max 8 attempts, base 500ms `500*2^(attempt-1)`, registry §7) | serve log `deepgram-stream.manager` | `DeepgramErrors`, `DeepgramReconnects` | Count |
| M13 | Bedrock error/throttle | embed/summarize catch → log | `BedrockErrors`, `BedrockThrottles` | Count |
| M14 | Deepgram cost proxy (audio seconds, `MAX_SESSION_MS=14400000` cap) | serve log | `DeepgramAudioSeconds` | Seconds |
| M15 | Bedrock cost proxy | `ai_usage_events` token counts — **UNVERIFIED table/service in intel-api (15.0); fallback = `BedrockInvokeCount` from a catch/finally counter** | `BedrockInputTokens`, `BedrockOutputTokens` (or `BedrockInvokeCount`) | Count |
| M16 | Migrate-task success | `intel-api-migrate` stream: `prisma migrate deploy` exit (entrypoint mode `migrate`, registry §1) | `MigrateSuccess` (1/0) | Count |
| M17 | Serve health | ALB target health on `:4300 /health` + task run count | ECS `RunningTaskCount` (`capiro-dev-intel-api`; PROD name UNVERIFIED), ALB `HealthyHostCount` (only after an intel target group + listener rule exist) | Count |

**Signal count:** 17 signals (M1–M17). Of these, **13 are metric-filter-derived** from verb/serve JSON (M1–M5, M8, M10 + the counters in M12–M16 that log a line, M7 via the canary verb). M6 comes from the SES→SNS path, and M9/M17 come from ALB/ECS built-in metrics (not filters). Do not assume "one filter per signal."

**Metric-filter example (M1, detect success):** on the confirmed log group (DEV `/capiro/dev/intel-api`, PROD `/capiro/prod-os-capiro` — 15.0), filter pattern `{ $.verb = "detect-tracker-alerts" && $.ok = true }` → metricValue `1`, defaultValue `0`, metric `DetectRunSuccess`. Mirror for `ok = false` → `DetectRunFailure`.

---

### 15.2 Double-send canary (the single-sender guarantee, D5) — REQUIRED

Because both services can send until per-tenant cutover, the catastrophic failure mode is **one client receiving two emails** (once from legacy `apps/api` detect-tracker-alerts, once from intel-api). The `(alertId, userId, channel)` unique key guards *within* a service but NOT *across* the two services (separate rows in `notification_log` vs `intel_notification_log`). The canary detects cross-service duplication directly and is the trigger for auto-halt (RT-1).

**alertId shape (registry §6, verbatim):** `alertId = 'tracker:' + clientId + ':' + billId + ':' + changeType`. Both services use this shape, so the logical event is joinable.

**Verb `double-send-canary` (NEW — UNVERIFIED, must add), scheduled every 15 min; read-only cross-table SQL. intel-api reads apps/api's `notification_log` by ID and never writes it. Because it reads across tenants it MUST run under `prisma.withSystem(...)` — registry flags `withSystem` availability UNVERIFIED (15.0); if unavailable the canary sees only one tenant and gives a false green, so this is a hard Phase-1 blocker.**

**⚠ Column names below are UNVERIFIED.** Prisma `@@map` gives table names, but the actual DB *column* names for `alertId`/`sentAt` on `notification_log` and `intel_notification_log` are not attested in the registry (§5 lists Prisma field names, not `@map`s for these). Confirm the real column identifiers before creating this SQL; the query is illustrative:

```sql
-- Clients that received the SAME logical bill event from BOTH services in the last 60 min.
-- Column names (alert_id, sent_at, user_id, channel) are UNVERIFIED — confirm against the
-- deployed schema (Prisma @@map is table-only). Run under withSystem (cross-tenant).
WITH legacy AS (
  SELECT split_part(alert_id, ':', 2) AS client_id,
         split_part(alert_id, ':', 3) AS bill_id,
         split_part(alert_id, ':', 4) AS change_type,
         user_id, channel
  FROM notification_log                       -- apps/api table, read-only
  WHERE sent_at > now() - interval '60 minutes'
    AND alert_id LIKE 'tracker:%'
), intel AS (
  SELECT split_part(alert_id, ':', 2) AS client_id,
         split_part(alert_id, ':', 3) AS bill_id,
         split_part(alert_id, ':', 4) AS change_type,
         user_id, channel
  FROM intel_notification_log                 -- intel-api owns
  WHERE sent_at > now() - interval '60 minutes'
    AND alert_id LIKE 'tracker:%'
)
SELECT l.client_id, count(*) AS dup_count
FROM legacy l
JOIN intel i USING (client_id, bill_id, change_type, user_id, channel)
GROUP BY l.client_id;
```

The verb emits one JSON line per tenant `{ verb:"double-send-canary", tenantId, dupCount }`; metric filter → `DoubleSendCanary` dimensioned by `Tenant`. **Expected value: 0, always, for every tenant.** Any non-zero for any tenant is a P1 auto-halt (15.5, RT-1).

**60-min window vs 15-min cadence:** the overlapping window (60 min lookback, 15 min cadence) is intentional so a duplicate is caught by ≥4 consecutive runs even if one run is skipped; do not narrow the window below the detect cadence.

---

### 15.3 CloudWatch alarms → SNS topics (with MANDATORY subscription)

Reuse the existing prod SNS topics from the alerting memory rather than minting new ones: `capiro-dev-alerts` (ops) and `capiro-dev-platform-alarms` (platform). **Exact prod ARNs are UNVERIFIED (15.0) — do not launch alarms against guessed ARNs.** These topics historically had ZERO subscribers — verify subscriptions before trusting any alarm (S2).

| Alarm name (verbatim) | Metric | Condition | Period / eval | Missing-data | Topic | Sev |
|---|---|---|---|---|---|---|
| `capiro-intel-double-send-canary` | `DoubleSendCanary` (any Tenant, `Sum`) | `>= 1` | 15 min / 1 | notBreaching | `capiro-dev-platform-alarms` | **P1** |
| `capiro-intel-detect-run-failure` | `DetectRunFailure` | `>= 1` | matches schedule / 1 | notBreaching | `capiro-dev-alerts` | P2 |
| `capiro-intel-detect-lag` | `DetectLagMinutes` | `> 60` | per-run / 2 consecutive | notBreaching | `capiro-dev-alerts` | P2 |
| `capiro-intel-detect-no-run` (dead-man) | `DetectRunSuccess` | `< 1` | 90 min / 1 | **breaching** | `capiro-dev-platform-alarms` | P2 |
| `capiro-intel-watchlist-sync-drift` | `WatchlistSyncDrift` | `> 0` | per-run / 1 | notBreaching | `capiro-dev-alerts` | P2 |
| `capiro-intel-alert-send-failrate` | `AlertsSendFailed / (AlertsSent+AlertsSendFailed)` (metric math) | `> 0.05` | 1 h / 1 | notBreaching | `capiro-dev-alerts` | P2 |
| `capiro-intel-ses-bounce-rate` | `SesBounces / SesDeliveries` (metric math) | `> 0.05` | 1 h / 1 | notBreaching | `capiro-dev-platform-alarms` | **P1** (SES reputation) |
| `capiro-intel-parity-below-target` | `ParityOverlapPct` | `< 95` | per-run / 1 | notBreaching | `capiro-dev-alerts` | P2 (gates cutover, Phase 5) |
| `capiro-intel-parity-missed-critical` | `ParityMissedCriticals` | `>= 1` | per-run / 1 | notBreaching | `capiro-dev-platform-alarms` | **P1** (blocks cutover) |
| `capiro-intel-feed-latency` | `FeedLatencyP95Ms` | `> 2000` | 5 min / 3 | notBreaching | `capiro-dev-alerts` | P3 |
| `capiro-intel-alert-freshness` | `AlertFreshnessMinutes` (p95) | `> 60` | 1 h / 1 | notBreaching | `capiro-dev-alerts` | P2 (SLO 15.4 release-gate hard cap; canonical freshness gate ↔ s17 §17.3) |
| `capiro-intel-brief-latency` | `BriefLatencyMinutes` (p95) | `> 180` | 1 h / 1 | notBreaching | `capiro-dev-alerts` | P3 (SLO 15.4) |
| `capiro-intel-deepgram-errors` | `DeepgramErrors` | `> 10` | 15 min / 1 | notBreaching | `capiro-dev-alerts` | P3 |
| `capiro-intel-bedrock-throttle` | `BedrockThrottles` | `> 5` | 15 min / 1 | notBreaching | `capiro-dev-alerts` | P3 |
| `capiro-intel-migrate-failure` | `MigrateSuccess` | `< 1` | on deploy / 1 | **breaching** | `capiro-dev-platform-alarms` | **P1** (blocks serve roll) |
| `capiro-intel-serve-unhealthy` | ALB `HealthyHostCount` (intel target group) | `< 1` | 1 min / 3 | **breaching** | `capiro-dev-platform-alarms` | **P1** |

**Alarm count: 16.** Note `capiro-intel-serve-unhealthy` (and the `HealthyHostCount` half of M17) is **not creatable until an intel target group + ALB listener rule exist** — registry §1 confirms **no `/intel-api/*` ALB rule exists today**. Until intel-api is fronted by the ALB, substitute an ECS `RunningTaskCount < desiredCount` alarm on the serve service as the P1 liveness signal, and track adding the listener rule (out-of-band `aws elbv2 create-rule`, NOT `cdk deploy` — the prod ALB `capiro-prod-alb` is manually managed) as a prerequisite.

**Create-alarm shape (out-of-band, example — double-send canary):**
```
aws cloudwatch put-metric-alarm --region us-east-1 \
  --alarm-name capiro-intel-double-send-canary \
  --namespace Capiro/IntelTracker --metric-name DoubleSendCanary \
  --statistic Sum --period 900 --evaluation-periods 1 --threshold 1 \
  --comparison-operator GreaterThanOrEqualToThreshold \
  --treat-missing-data notBreaching \
  --alarm-actions <CONFIRMED capiro-dev-platform-alarms ARN — 15.0> \
  --ok-actions      <CONFIRMED capiro-dev-platform-alarms ARN — 15.0>
```

---

### 15.4 SLOs

**Canonical freshness gate.** Bill-alert freshness has two distinct numbers that must not be confused: the **SLO target is p95 < 30 min** (the internal objective we design detect cadence to hit), and the **release-gate hard cap is p95 ≤ 60 min** (the sign-off threshold that must not be breached to authorize/keep cutover). The 30-min target is deliberately tighter than the 60-min gate to leave headroom; a run between 30 and 60 min misses the target but does **not** trip the release gate. **The single canonical freshness release-gate number is ≤ 60 min**, and it is shared with **s17 §17.3** (MVP benchmark sign-off threshold `p95 ≤ 60 min`). This s15 §15.4 row ↔ s17 §17.3 are the same gate — if one changes, change both. The `capiro-intel-alert-freshness` alarm fires at `> 60`, matching the release gate exactly.

| SLO | Target | Release-gate hard cap | Measured by | Alarm |
|---|---|---|---|---|
| **Bill-alert freshness** (canonical gate ↔ s17 §17.3) | p95 delivered **< 30 min** from source action date | p95 **≤ 60 min** (sign-off threshold; == s17 §17.3) | M10 `AlertFreshnessMinutes` | `capiro-intel-alert-freshness` (`> 60` breaches = gate) |
| **Hearing brief availability** | p95 **< 1 h** after session end | p95 **< 3 h** | M11 `BriefLatencyMinutes` | `capiro-intel-brief-latency` (>180 breaches) |
| **Detect job cadence** | runs every ≤30 min | lag ≤60 min | M1/M2 | `capiro-intel-detect-no-run`, `capiro-intel-detect-lag` |
| **Delivery reliability** | send-failure rate < 5% | SES bounce < 5% | M5/M6 | `capiro-intel-alert-send-failrate`, `capiro-intel-ses-bounce-rate` |
| **Feed responsiveness** | p95 feed route < 2 s (only once the ALB rule exists — M9) | — | M9 | `capiro-intel-feed-latency` |
| **Single-sender integrity** | `DoubleSendCanary` == 0 for all tenants, all windows | 0 (hard) | M7 | `capiro-intel-double-send-canary` |

**Detect-job cadence design:** to meet the freshness SLO (30-min target, ≤60-min release-gate cap — see canonical-gate note above), schedule `detect-tracker-alerts` via an out-of-band EventBridge rule (mirror the existing `detect-tracker-alerts` rule / registry `capiro-dev-detect-tracker-alerts`) at **≤30 min** during shadow + cutover, so freshness p95 stays under the 30-min target and the 90-min dead-man has slack. **Concurrency guard:** two overlapping detect runs must not double-process — the detection cycle relies on the `(alertId, userId, channel)` INSERT-ON-CONFLICT claim (registry §6: `claim` → P2002 = skip) for idempotency, so overlap is safe for *delivery* but wasteful; still, cap concurrency to 1 (EventBridge single target + short run, or a DB advisory lock) so `DetectDurationMs` spikes don't stack. `TRACKER_ALERTS_ENABLED` gates delivery; keep it **OFF in shadow** (detect still writes rows, no send).

---

### 15.5 Rollback triggers (numeric, auto-halt where marked)

Hard gates on the per-tenant cutover runbook (§4). "Auto-halt" = the cutover automation MUST stop advancing to the next tenant and page; the affected tenant is rolled back per §4 (disable `tracker_v2` + `tracker_owner_intel` via `enable-feature`-style flip to off, and re-enable legacy ownership for that tenant). Because flags **fail closed** (frontend `useIntelFeatureEnabled` returns `{}` on error; backend guard returns **404** when disabled — registry §3/§8), a rollback that disables the flag degrades to legacy cleanly.

| ID | Trigger condition | Scope | Action |
|---|---|---|---|
| **RT-1** | `DoubleSendCanary >= 1` for any tenant | that tenant | **AUTO-HALT** cutover; roll back tenant; page P1. D5 backstop — one duplicate client email trips it. |
| **RT-2** | `ParityMissedCriticals >= 1` in the cutover pilot window | pilot | **BLOCK** cutover (do not enable `tracker_owner_intel`); stay in shadow. |
| **RT-3** | `ParityOverlapPct < 95%` on any of the required N=7 consecutive days | pilot | **BLOCK** cutover; extend shadow, tune matcher/scorer (Phase 5). |
| **RT-4** | `SesBounces/SesDeliveries > 5%` sustained 1 h after a tenant flips | that tenant | roll back tenant delivery (revert `tracker_owner_intel`); investigate list hygiene before re-flip. |
| **RT-5** | `AlertsSendFailed` rate > 20% over 1 h | service | halt further cutovers; keep flipped tenants (legacy already skipping them); do NOT re-enable legacy for flipped tenants unless send stays broken (avoids re-introducing the double-send race). |
| **RT-6** | `MigrateSuccess < 1` on a deploy | service | **BLOCK** serve roll (order: migrate → force-new-deployment). No new image goes live; prior task-def stays. |
| **RT-7** | `AlertFreshnessMinutes` p95 > 60 (release-gate hard cap, §15.4 ↔ s17 §17.3) for 2 h post-cutover | service | investigate detect cadence / Bedrock latency; not an auto-rollback but blocks widening. |
| **RT-8** | `DetectRunFailure >= 3` consecutive OR dead-man `capiro-intel-detect-no-run` fires | service | halt cutover widening; alerts are stale → freshness SLO at risk. |

**Precedence:** RT-1 and RT-6 are absolute (integrity + deploy safety). RT-2/RT-3 gate the pilot→cutover transition. RT-4/RT-5/RT-7/RT-8 gate *widening* to additional tenants but do not necessarily reverse an already-stable flip.

---

### 15.6 Dashboard

One CloudWatch dashboard `capiro-intel-tracker` (out-of-band, `aws cloudwatch put-dashboard`), region `us-east-1`, panels top-to-bottom:

1. **Single-sender integrity** — `DoubleSendCanary` per `Tenant`; big-number "hours since last double-send = 0".
2. **SLO row** — `AlertFreshnessMinutes` p95 (annotations at 30 = target & 60 = release-gate hard cap, §15.4 ↔ s17 §17.3), `BriefLatencyMinutes` p95 (60 & 180), `FeedLatencyP95Ms` (2000).
3. **Detect health** — `DetectRunSuccess`/`DetectRunFailure`, `DetectLagMinutes`, `DetectDurationMs`.
4. **Delivery** — `AlertsSent`/`AlertsSendFailed`, SES `SesDeliveries`/`SesBounces`/`SesComplaints` with rate math.
5. **Parity (shadow)** — `ParityOverlapPct` (line at 95), `ParityMissedCriticals`.
6. **Watchlist sync** — `WatchlistSyncDrift`.
7. **Cost & external deps** — `DeepgramAudioSeconds`, `DeepgramErrors`/`DeepgramReconnects`, `BedrockInputTokens`/`BedrockOutputTokens` (**fallback `BedrockInvokeCount` if `ai_usage_events` absent — 15.0/M15**), `BedrockThrottles`.
8. **Serve/infra** — ECS `RunningTaskCount` for the intel serve service (DEV `capiro-dev-intel-api`; **PROD name UNVERIFIED — 15.0**), ALB `HealthyHostCount` (only once fronted), `MigrateSuccess`.

---

### 15.7 Wiring order & idempotency

Do these once per environment (DEV then PROD), out-of-band (**NOT CDK**), before shadow delivery is ever enabled. Steps are ordered by dependency.

1. **Resolve all 15.0 UNVERIFIED values** (service name, SNS ARNs, log group, subnets/SGs, `withSystem`, `ai_usage_events`, SES config set + verified `TRACKER_ALERT_EMAIL_FROM`, real delivery table/columns). Update this section with literals. **Gate for everything below.**
2. **Confirm task-role and exec-role perms** (registry §1/§2):
   - Exec role (`...ApiTaskDefExecutionRole...`) has ECR pull + Secrets read (`infra/deploy/intel-api-execrole-inline-policy.json`) for the added tracker secrets namespace (`capiro/dev/intel-api/*`, prod `capiro/prod-os-capiro/*`).
   - Task role (shared with api, `...ApiTaskRole...`) has `bedrock:InvokeModel` for `amazon.titan-embed-text-v2:0` + Anthropic Claude on Bedrock (summaries) and `ses:SendEmail`/`SendRawEmail`. **Both UNVERIFIED (registry §2) — grant before any embed/summary/send verb runs, else M5/M6/M10 stay empty and detection silently fails.**
3. **Confirm the serve + migrate task-defs are arm64** (Fargate is ARM64; registry arm64 build command uses `--platform linux/arm64`) and that they log to the confirmed log group (not the erroneous `/capiro/dev/api`). **Gate for M1–M16.**
4. **Create metric filters** (13 filter-derived signals, 15.1). Idempotent: `put-metric-filter` upserts by name on a log group.
5. **Create the 16 alarms** (15.3) against the **confirmed** SNS ARNs. Idempotent: `put-metric-alarm` upserts by name.
6. **Subscribe humans to both SNS topics** (kills the zero-subscriber bug): `aws sns subscribe --topic-arn <confirmed> --protocol email --notification-endpoint neo@capiro.ai` for each of `capiro-dev-alerts` and `capiro-dev-platform-alarms`; **confirm each is `Confirmed`, not `PendingConfirmation`.**
7. **Wire SES event publishing** (bounce/complaint/delivery → config set event destination → SNS → M6). Confirm the config set is attached to the sending identity used by `TrackerEmailService` (SESv2, registry §6).
8. **Create EventBridge schedules** (out-of-band, NOT CDK), each a `run-task` on the migrate-shaped task-def with `containerOverrides[].name=intel-api-migrate`, `command=["<verb>"]`, using the confirmed subnets/SGs (`assignPublicIp=DISABLED`):
   - `capiro-intel-detect-tracker-alerts` (≤30 min), `command=["detect-tracker-alerts"]`
   - `capiro-intel-flush-tracker-digests` (daily + weekly, mirroring the existing legacy flush rules)
   - `capiro-intel-double-send-canary` (15 min), `command=["double-send-canary"]`
   Ensure each rule targets a single concurrent run (15.4 concurrency guard).
9. **Create the dashboard** (15.6). Idempotent by name.

---

### 15.8 Success criteria

Measurable, independently verifiable. Each names the owner, the command/metric, the numeric expected result, and the gate it unblocks.

| # | Check | Owner / command | Expected (measurable) | Unblocks |
|---|-------|-----------------|-----------------------|----------|
| S0 | **All 15.0 UNVERIFIED items resolved** | Eng: this section updated; grep for "UNVERIFIED" in §15 | `0` remaining UNVERIFIED tokens tied to a wiring step | All wiring (15.7) |
| S1 | **All 16 alarms exist with an action** | SRE: `aws cloudwatch describe-alarms --alarm-name-prefix capiro-intel- --region us-east-1 --query 'length(MetricAlarms[?AlarmActions[0]])'` | `>= 16` (each has an `AlarmActions` ARN) | Shadow-delivery enablement |
| S2 | **Alarms have live subscribers** | SRE: per topic `aws sns list-subscriptions-by-topic --topic-arn <arn> --query "length(Subscriptions[?SubscriptionArn!='PendingConfirmation'])"` | `>= 1` `Confirmed` per topic (`capiro-dev-alerts`, `capiro-dev-platform-alarms`) | S1 → trusted alerting |
| S3 | **Synthetic double-send fires the canary** | SRE: in a scratch/pilot tenant, insert one matching row into BOTH `notification_log` and `intel_notification_log` for the same `(client,bill,changeType,user,channel)`; run `double-send-canary` verb | `DoubleSendCanary Sum >= 1` for that tenant AND `capiro-intel-double-send-canary` → `ALARM` AND an email reaches neo@capiro.ai; cleanup rows → `OK` | Proves RT-1 auto-halt → cutover authorization |
| S4 | **Task/exec-role perms proven** | SRE: run one `detect-tracker-alerts` + one summary path in DEV; check no `AccessDenied` for bedrock/ses in the log stream; `AlertsSent >= 0` emitted | zero IAM `AccessDenied`; embed + send both succeed on a test row | Delivery correctness |
| S5 | **Dashboard renders SLO lines** | Ninja/SRE: open `capiro-intel-tracker` | Freshness (30 target / 60 release-gate cap), brief (60/180), feed (2000), parity (95) annotation lines present with data | Cutover go/no-go |
| S6 | **Freshness SLO met in shadow** | SRE: `AlertFreshnessMinutes` p95 over 7 days | p95 `< 30 min` (target); MUST stay `≤ 60 min` release-gate hard cap (§15.4 ↔ s17 §17.3) | Confirms detect cadence adequate |
| S7 | **Dead-man works** | SRE: disable the detect EventBridge rule for 100 min in DEV | `capiro-intel-detect-no-run` → `ALARM`; re-enable → `OK` | Silent-stall detection |
| S8 | **Migrate gate works** | SRE: run migrate task with an intentionally bad migration in DEV | `MigrateSuccess < 1` → `capiro-intel-migrate-failure` `ALARM`; deploy script does NOT reach `update-service` (RT-6) | Deploy-safety sign-off |
| S9 | **Parity gate readable** | Eng: `parity-report` verb 7 consecutive days on pilot | `ParityOverlapPct >= 95` all 7 days AND `ParityMissedCriticals == 0` (RT-2/RT-3 clear) | Phase 5 → cutover |
| S10 | **SES bounce/complaint visible** | SRE: `sendTestAlert` to an SES simulator bounce address (`bounce@simulator.amazonses.com`) | `SesBounces >= 1`; rate math renders; `capiro-intel-ses-bounce-rate` reachable | RT-4 enforceable |
| S11 | **Cost proxies emit** | SRE: after one detect + one brief run | `DeepgramAudioSeconds > 0` AND (Bedrock token metric `> 0` OR documented `BedrockInvokeCount` fallback in place) | Cost monitoring baseline |

**Section-level DoD:** **S0, S1, S2, S3, S4, and S8 are mandatory before any tenant delivery is enabled** (shadow→live). S3 specifically must pass — a plan that cannot prove its own double-send tripwire fires is not cleared for cutover; S4 must pass — unpriced/denied Bedrock/SES calls make detection silently fail. S6, S7, S9, S10 gate widening beyond the pilot tenant. No alarm may be launched against a guessed ARN, service name, log group, or delivery column — S0 forecloses that.

---

## 16. Risks & mitigations

Each risk carries a **detection signal** (which S15 metric/alarm/log surfaces it), a **mitigation** (design-time guard), and a **recovery** (tested runbook when it fires). High risks (H) have a named owner, a wired S15 detector, and a rehearsed recovery. `S15/*` refers to monitors defined in §15 (Observability & Alerting); where §15 does not yet define the detector, it is flagged **ADD TO S15**.

Preserves the intent of the earlier draft table (duplicate sends, watchlist split-brain, parity gap, cross-DB drift, arm64, out-of-band rules, migrate-on-deploy, Bedrock cost, fail-closed crypto) and expands it with the registry-surfaced operational risks. All names/commands/tables below are verbatim from the registry; anything the registry does not confirm is marked **UNVERIFIED — confirm**.

**Env-var re-read semantics (applies to R4/R10 and every env gate in this section):** intel-api runs two shapes of process. **Scheduled one-off verbs** (cron detect/digest-flush tasks, e.g. `detect-tracker-alerts`) are launched fresh each fire and therefore re-read their env on the NEXT task launch (next scheduled fire) — no task-def revision or redeploy is required for the change to take effect on the following run, consistent with s6 §6.3 (ships gates unset in shadow) and s7 §7.4 (`TRACKER_ALERTS_ENABLED` belt-and-suspenders kill-switch). The **long-running `serve` process** does NOT re-read env in place; changing an env value there requires a new task-def revision + a `force-new-deployment` (serve redeploy) to pick it up. So: for the scheduled pipeline, an env flip is "effective next fire"; for serve, it is "effective on redeploy." Neither shape re-reads env mid-run — to halt an ALREADY in-flight one-off task, stop the task; you cannot rely on it noticing the env change.

**Model invariants this section must not contradict (registry §1, §5, §8):**
- **Single-sender**: at most one of `capiro-dev-api` (legacy) or `capiro-dev-intel-api` (new) fans out per tenant, arbitrated by `tracker_owner_intel`. Shadow phase = intel-api computes but sends nothing.
- **Strangler/shadow**: `client_watchlist` (api) is source-of-truth until per-tenant cutover; sync is ONE-WAY (api → intel) until the flag flips.
- **intel-api is READ-ONLY on all apps/api tables** (registry §4 — no cross-schema FKs, reads by string ID); it never writes `congress_bill`, `context_embeddings`, `clients`, `notification_log`, `client_watchlist`.

### 16.1 High risks (H)

| # | Risk | Sev | Owner | Detection (S15 signal) | Mitigation | Recovery |
|---|------|-----|-------|------------------------|------------|----------|
| R1 | **Duplicate client emails during parallel run** (both `capiro-dev-api` tracker and `capiro-dev-intel-api` fan out for the same tenant) | H | Release owner | **ADD TO S15**: daily reconciliation query alarms if any `alertId` appears in BOTH `notification_log` (api) and `intel_notification_log` (intel) within 24h for the same `(clientId,billId,changeType)`. Plus SES `Send` rate-spike alarm on the sending identity. | Single-sender flag `tracker_owner_intel` (D5): legacy skips a tenant once the flag is ON; intel-api stays send-suppressed via `TRACKER_ALERTS_ENABLED` (registry §2) composed with the flag until cutover. Shadow phase sends nothing. Idempotency: `alertId = 'tracker:'+clientId+':'+billId+':'+changeType` + `claim()` INSERT ON CONFLICT `(alertId,userId,channel)` → P2002 = skip (registry §6). Because the two services write to SEPARATE log tables, the ON-CONFLICT key does NOT dedupe across services — the flag is the only cross-service guard, so the flag MUST be authoritative on both sides. | `enable-feature tracker_owner_intel <tenantSlugOrId>` toggled OFF via one-off `capiro-dev-intel-api-migrate` task (registry §1 run-task shape; `containerOverrides[].name=intel-api-migrate`) → legacy resumes as sole sender within one detect cycle. Note the flag is ALWAYS-on for `CAPIRO_INTERNAL_TENANT_ID` (registry §3) — the internal tenant cannot be un-cutover by the flag; pause its cron verb instead. Verify no new `intel_notification_log` rows for the tenant. |
| R2 | **Cross-DB RLS blocks intel-api tracker reads** (intel-api connects under a different Postgres role than `capiro-dev-api`; RLS `tenant_id = current_tenant_id` returns 0 rows for `clients`/`context_embeddings` scoped reads, or NULL-tenant global bill embeddings are filtered out) — **UNVERIFIED per registry §4: confirm intel-api Prisma role + `withTenant`/`withSystem` availability before build.** | H | DB/platform owner | **ADD TO S15**: canary verb `tracker-selfcheck <tenant>` (NEW verb — must be added to entrypoint dispatch, registry §6) run post-deploy asserts `getRecommendations` returns ≥1 row for a seeded tenant AND reads ≥1 NULL-tenant `context_embeddings` row; alarm on empty result or `withTenant` throw. Log-metric filter on `/capiro/dev/intel-api` (streams `intel-api`, `intel-api-migrate`) for `permission denied for table` / `42501`. | Confirm intel-api uses the SAME DB role as api (registry §4 option a). Secrets already inject `DB_USER`/`DB_PASSWORD` from `capiro/dev/aurora/app` (registry §2) — verify that IS the api app role, not `aurora/master`. Every scoped read wrapped in `prisma.withTenant(tenantId, tx=>…)` (sets `app.current_tenant_id`), cross-tenant detection in `prisma.withSystem(tx=>…)`. `context_embeddings` policy `tenant_id IS NULL OR tenant_id = current_tenant_id` keeps global bill rows readable when tenant ctx is set. Reads by string ID only, no cross-schema FKs. | If role mismatch in prod: repoint intel-api DB secret to the api app role, re-run migrate task, force-new-deployment. If a specific policy blocks reads, add a read GRANT for the intel role — never disable RLS (primary isolation, registry §4). |
| R3 | **Aurora connection-pool pressure from a 2nd service** (intel-api serve + migrate + cron verbs open new pools on the SHARED `capiro` cluster; `max_connections` exhaustion degrades `capiro-dev-api`) | H | DB/platform owner | S15 RDS `DatabaseConnections` alarm (existing per `project_alerting.md`). **ADD TO S15**: per-service attribution via `pg_stat_activity` grouped by `application_name` + alarm at ≥80% `max_connections`. Requires each intel-api connection string to set a distinct `application_name` (e.g. `intel-api-serve`, `intel-api-detect`) — **add to `DATABASE_URL` composition in entrypoint (registry §2)**; without it the alarm cannot attribute connections. | Cap intel-api Prisma pool via `DATABASE_URL` (`?connection_limit=5&pool_timeout=10&application_name=intel-api-<mode>`); serve and each cron verb use separate small pools; verbs call `$disconnect()` on exit. Do NOT run heavy detect cycles concurrently with a service roll. | Scale intel-api desired count to 1; `aws ecs stop-task` the runaway cron task; lower `connection_limit`; redeploy. If api is starving, `pg_terminate_backend` idle intel connections filtered by `application_name`. |
| R4 | **SES sending-identity / bounce-rate** (intel-api's `TRACKER_ALERT_EMAIL_FROM` uses an unverified `From`, or reputation drops → account-level sending pause halts ALL Capiro mail incl. api) | H | Release owner | S15: SES `Reputation.BounceRate` / `Reputation.ComplaintRate` CloudWatch alarms → SNS `capiro-dev-alerts` (subscribed per `project_alerting.md`). **ADD TO S15**: alarm on `tracker-alert.service` send-failure log-metric > 0 over 5 min. | `TRACKER_ALERT_EMAIL_FROM` MUST resolve to an already-verified SES identity in `us-east-1`. **UNVERIFIED — confirm: (a) which SES identity apps/api sends from and that intel-api reuses it, and (b) the shared api task role has `ses:SendEmail`/`ses:SendRawEmail` (registry §2 flags both as UNVERIFIED — the registry does NOT state a shared verified identity, so "reuse api's identity" is an assumption to confirm, not a fact).** `TrackerEmailService` uses SESv2 (registry §6). Digest flush marks rows `flushed=true` regardless of send outcome (poison-row safety) so one bad address can't wedge the queue. | If bounce alarm fires: set `TRACKER_ALERTS_ENABLED=false` (registry §2/s7 §7.4 kill-switch). Env re-read semantics (see section preamble): for the SCHEDULED detect/digest verbs this takes effect on the NEXT scheduled fire (each one-off verb re-reads env per run — no task-def revision or redeploy needed); for the long-running `serve` process it takes effect only after a new task-def revision + `force-new-deployment`. Neither shape re-reads env mid-run, so to halt sends IMMEDIATELY also STOP the in-flight detect task rather than waiting for the next fire. Legacy remains sender if pre-cutover. Open an SES case on account-level pause. Purge the bad recipient from `alert_preference.emailAddress`. |
| R5 | **Migration collides with existing hearing watchlist / double-insert on back-migration** (tracker port may introduce `intel_topic`/`intel_term`, but hearing already owns `intel_watchlist`/`intel_watchlist_term`/`intel_watchlist_match`) — **UNVERIFIED per registry §5: confirm whether tracker REUSES `intel_watchlist_term` or ADDS `intel_topic`/`intel_term`; do not conflate.** | H | Migration owner | S15: intel-api migrate task exit code (must be 0), surfaced by the deploy-script gate (registry §1 order). **ADD TO S15**: log-metric on stream `intel-api-migrate` for `already exists` / `P3009` (failed migration). Post-migrate row-count assert (see SC-5). | RESOLVE the naming question BEFORE writing the migration (registry §5). Back-migration decomposition is idempotent: `ON CONFLICT` on `intel_watchlist(client_id)` UNIQUE and the topic natural key `(client_id, name)`; additive-only, re-runnable. Migrate task runs `prisma migrate deploy` with auto-rollback of previously-failed migrations, NO seed (registry §1 — unlike apps/api migrate which also runs `seed-workflows.ts`). | Auto-rollback of the failed migration → fix forward → re-run migrate task → THEN roll serve (never roll serve on a failed migrate, registry §1). If a double-insert occurred: dedup with a one-off cleanup verb keyed on the natural key; NEVER truncate hearing's `intel_watchlist*` tables. |

### 16.2 Medium / lower risks

| # | Risk | Sev | Owner | Detection (S15 signal) | Mitigation | Recovery |
|---|------|-----|-------|------------------------|------------|----------|
| R6 | **Watchlist split-brain / lost edits** during parallel run | M | Release owner | **ADD TO S15**: nightly diff of `client_watchlist` (api) vs `intel_watchlist`+topic/term tables (intel) per migrated client; alarm on drift. | ONE-WAY sync (api → intel) until cutover (D6); source-of-truth flips exactly at cutover; reverse sync stays disabled (matches strangler model — no bidirectional writes). | Re-run the one-way sync verb to reconcile; `client_watchlist` remains authoritative until the flip, so pre-cutover edits are never lost. |
| R7 | **Parity gap** — intel misses a legacy-critical alert | M | Release owner | S15 parity dashboard: per-tenant overlap % of emitted `changeType`/severity between the two detectors over rolling 7 days. | Cutover gate SC-6; `classifyChange` regex cascade ported verbatim (registry §6, most-significant-first), `SEVERITY_RANK`/`MATERIALITY_RANK`/`clearsMateriality` unchanged. | Hold cutover (leave `tracker_owner_intel` OFF); diff missed `alertId`s; fix classifier; restart the 7-day burn-in. |
| R8 | **Cross-DB read drift** — apps/api changes a `congress_bill`/`context_embeddings` column intel-api reads by raw SQL | M | DB/platform owner | S15 contract test in CI asserting every column in registry §4 exists via `information_schema.columns`; fails the build. Include the pgvector cosine SQL columns (`source_type`, `model`, `embedding`). | Centralize all raw SQL in one repository module; intel-api NEVER writes apps/api tables (read-only invariant). | Pin the query to the new shape, hotfix-deploy intel-api; the contract test blocks an uncoordinated api schema change from reaching prod. |
| R9 | **Deepgram cost blowout** — long/abandoned live sessions bill continuously (`MAX_SESSION_MS=14400000` = 4h ceiling; many concurrent) | M | Hearing owner | **ADD TO S15**: CloudWatch custom metric = sum of open session-minutes/day + alarm at a $ threshold; log-metric on reconnect storms (>8 attempts = give-up, registry §7). | `MAX_SESSION_MS` hard-caps each session; exp-backoff reconnect max 8 attempts, base 500ms (`500 * 2^(attempt-1)`, registry §7); `nova-2` fixed via `DEEPGRAM_MODEL`. | Close the runaway gateway socket; if systemic, lower `MAX_SESSION_MS`, redeploy; rotate `DEEPGRAM_API_KEY` (`capiro/dev/intel-api/DEEPGRAM_API_KEY`) if leak suspected. |
| R10 | **Bedrock cost/latency + missing task-role perms** (Titan embed per query + optional Claude summaries) — **UNVERIFIED per registry §2: shared api task role must have `bedrock:InvokeModel` for `amazon.titan-embed-text-v2:0` AND Claude on Bedrock.** | M | DB/platform owner | **ADD TO S15**: `ai_usage_events` daily token/$ rollup alarm — **only if `ai_usage_events` + `AiCredentialResolverService.resolveProviderByTenantId` exist in intel-api (registry §2 UNVERIFIED; must confirm or port)**; log-metric on `AccessDeniedException` from Bedrock. | Cache query embeddings by normalized watchlist hash; semantic leg skippable in cron path; summaries gated by `TRACKER_ALERT_SUMMARY` (`SUMMARY_TIMEOUT_MS=15000`, fail-safe → null so the alert still sends). Confirm task-role Bedrock grant pre-deploy. `EMBEDDING_MODEL` dim = 1024 must match the `context_embeddings` vectors (registry §4) or cosine is garbage. | On `AccessDenied`: add `bedrock:InvokeModel` to the shared api task role — an IAM policy change on an assumed role takes effect at the next STS credential refresh with NO redeploy. On cost spike: unset `TRACKER_ALERT_SUMMARY`. Env re-read semantics (see section preamble): summaries are generated in the SCHEDULED detect/alert verbs, which re-read env per run, so unsetting the flag takes effect on the NEXT scheduled fire — no task-def revision or redeploy required. (Only the long-running `serve` process would need a new task-def revision + `force-new-deployment` to pick up an env change; it is not the summary path.) Neither shape re-reads env mid-run. And/or disable the semantic leg via config. |
| R11 | **arm64 image mismatch** — local Windows build pushes amd64 `:latest`, Fargate can't pull | M | Release owner | S15 deploy preflight: `docker manifest inspect <ecr>:latest` arch check; ECS service events show image-pull failures. | Always `docker buildx build --platform linux/arm64 -f apps/intel-api/Dockerfile … --push` (registry §1, dual-tag `:latest` + `:<GIT_SHA>`); CI `intel-api-image.yml` pins `platforms: linux/arm64`. | Restore last-good arm64 `:latest` by re-tagging from the known-good `<GIT_SHA>` tag; force-new-deployment. |
| R12 | **Out-of-band ALB rule / EventBridge schedules dropped by a `cdk deploy`** — prod ALB `capiro-prod-alb` is manually managed; NO `/intel-api/*` rule exists today (registry §1) | M | DB/platform owner | S15 synthetic canary on the new `/intel-api/*` path (once added) + alarm on 404/routing loss; EventBridge rule-existence check. | New `/intel-api/*` listener rule added via `aws elbv2 create-rule` at a free priority — **UNVERIFIED: registry suggests 12 or 17; confirm no collision against existing rules (3/5/10/15/20) before creating.** NOT `cdk deploy` (prod ALB is wedged/manual, registry §1). Document in the out-of-band inventory. Cron verbs registered as out-of-band EventBridge rules (mirrors tracker's `detect-tracker-alerts`/digest-flush rules). | Re-create the dropped rule via `aws elbv2 create-rule`; re-create the EventBridge rule; append to the out-of-band inventory runbook. |
| R13 | **Migrate task not run on deploy** — serve rolls before schema present (workspace `ws_notification` lesson) | M | Release owner | S15 deploy gate: migrate task must STOP with exit 0 before `update-service` (registry §1 deploy order). | Enforced ordering in the deploy script: run `capiro-dev-intel-api-migrate`, wait STOPPED + exit 0, THEN `update-service capiro-dev-intel-api --force-new-deployment`, wait stable (migrate ALWAYS before serve). | If serve rolled without migrate: run the migrate task now, force-new-deployment again; new tasks pick up the schema. |
| R14 | **prod Node version vs dev** — prod Fargate Node20 vs dev Node22; `ERR_REQUIRE_ESM` gotcha (per `project_member_news_tab.md`) fails at runtime, not build | M | Release owner | S15 log-metric on `/capiro/dev/intel-api` for `ERR_REQUIRE_ESM` / startup crash-loop; service `RUNNING` count < desired alarm. | Match the Dockerfile Node major to the prod runtime; smoke `/health` (registry §1, port 4300) on the built arm64 image before promoting; CI builds the same base image both envs use. | Roll back to the prior `<GIT_SHA>` image (force-new-deployment with the known-good tag); fix import style; rebuild. |
| R15 | **Fail-closed encryption** — bill alerts must carry no transcript text; `HEARING_ENCRYPTION_KEY` behavior preserved | L | Hearing owner | S15 log-metric on decrypt failures; alarm on `HEARING_ENCRYPTION_KEY` unset at boot (fallback `NOTES_ENCRYPTION_KEY`, registry §7). | AES-256-GCM via `HearingCryptoService` unchanged (registry §7, 12-byte IV, no rotation); tracker/bill alert payloads reference bill_id/stage/url only (registry §6 emit payload), never transcript text. | Restore the key from Secrets Manager; since no rotation is supported, a re-key is a manual data-migration event — treat as an incident. |
| R16 | **Frontend flag misfire** — `useIntelFeatureEnabled` fails CLOSED (returns `{}`); a bad flag could hide the whole Tracker surface | L | Frontend owner | S15 synthetic on `/intel-api/feature-flags` 5xx; browser Network-tab check (API does NOT log 4xx per `bug_clio_memory_migration_prod.md`). | Hook fails CLOSED by design (registry §8) → worst case the LEGACY `TrackerTab` renders (not a blank tab); gate at `ClientProfilePage.tsx` (~line 513): render unified surface when `tracker_v2` on, else legacy. Note the guard returns **404 not 403** when a flag is disabled (registry §3) — dashboards keying on 403 will miss it. | Toggle `tracker_v2` OFF per-tenant via `enable-feature`; SPA falls back to the legacy tab with no deploy. |

### 16.3 UNVERIFIED items that MUST be closed before High-risk sign-off

These block the S16 high-risk owners from declaring their risk "tested" (all registry-flagged):

- [ ] **R2/R3** — intel-api Prisma DB role identity + `withTenant`/`withSystem` availability; confirm the role (`capiro/dev/aurora/app`) reads NULL-tenant `context_embeddings` rows AND is the SAME role as apps/api. (registry §4)
- [ ] **R5** — tracker table target: REUSE `intel_watchlist_term` vs NEW `intel_topic`/`intel_term`. (registry §5)
- [ ] **R4** — task role has `ses:SendEmail`; the SES identity apps/api sends from is verified in `us-east-1` and `TRACKER_ALERT_EMAIL_FROM` reuses it (registry does NOT assert a shared identity — confirm). (registry §2)
- [ ] **R10** — task role has `bedrock:InvokeModel` (Titan embed 1024-dim + Claude); `ai_usage_events` table + `AiCredentialResolverService.resolveProviderByTenantId` exist in intel-api or are ported. (registry §2)
- [ ] **R12** — free ALB listener priority for `/intel-api/*` (12 or 17) confirmed non-colliding with 3/5/10/15/20; subnets/SGs for the one-off run-task confirmed from `scripts/deploy-ingestion-out-of-band.sh` run_job_wait template / resolved task-defs. (registry §1)
- [ ] **R6 (emit)** — `IntelligenceChange` table exists in the intel-api schema or the emit is re-targeted (registry §6 flags it as an apps/api table, UNVERIFIED in intel-api). (registry §6)
- [ ] **R2 (canary)** — `tracker-selfcheck` verb added to the intel-api entrypoint dispatch (intel-api is HTTP-only today with a single `bootstrap()`; cron/canary verbs require CommandFactory or entrypoint verb dispatch, registry §6).

---

**Success criteria**

Measurable, independently verifiable. Each unblocks the named gate. Every row names a verifier (owner), a command/metric, a numeric threshold, and the gate it unblocks.

| ID | Verifier (owner) | Command / metric | Threshold / expected | Gate unblocked |
|----|------------------|------------------|----------------------|----------------|
| SC-1 (R1) | Release owner | Reconciliation query: any `alertId` present in BOTH `notification_log` and `intel_notification_log` within any 24h window, for the pilot tenant, over a 7-day shadow+parallel run | **0 duplicate `alertId`s**; SES `Send` count for the tenant does NOT increase while intel-api is send-suppressed (`TRACKER_ALERTS_ENABLED=false`/flag OFF) | Per-tenant cutover |
| SC-2 (R2) | DB/platform owner | `tracker-selfcheck <tenant>` verb (post-deploy canary): asserts `getRecommendations` ≥1 row AND ≥1 NULL-tenant `context_embeddings` row read under `withTenant` | Exit **0**, both asserts pass; **0** `permission denied` / `42501` in `/capiro/dev/intel-api` for 24h | intel-api serve promotion |
| SC-3 (R3) | DB/platform owner | `pg_stat_activity` grouped by `application_name` during a detect cycle concurrent with a service roll | intel-api connections **≤ configured `connection_limit`** (default 5); total cluster connections **< 80% `max_connections`**; api p95 latency within **±10%** of the 7-day baseline | Enable cron detect in prod |
| SC-4 (R4) | Release owner | SES `Reputation.BounceRate`/`ComplaintRate` after the first real send batch to the pilot tenant; send-failure log-metric; kill-switch drill | Bounce **< 5%**, complaint **< 0.1%**; **0** send failures over the first 100 sends; kill-switch (`TRACKER_ALERTS_ENABLED=false`, effective next scheduled fire per env re-read semantics, + stop in-flight detect task for immediate halt) verified to halt sends before the next scheduled detect run | Widen cutover beyond pilot |
| SC-5 (R5) | Migration owner | `capiro-dev-intel-api-migrate` task exit code + post-migrate row-count assert: target-topic-table count == distinct `client_watchlist.tags[].tag`; hearing `intel_watchlist`/`intel_watchlist_term`/`intel_watchlist_match` row counts unchanged pre/post | Exit **0**; topic counts match; hearing table row counts identical pre/post | Serve roll after migrate |
| SC-6 (R7) | Release owner | Parity dashboard: 7-day rolling overlap of emitted alerts, per tenant | **≥95% overlap AND 0 missed `critical`** (enacted / to-president / failed) for **7 consecutive days** | Flip `tracker_owner_intel` ON |
| SC-7 (R11/R14) | Release owner | `docker manifest inspect <ecr>:latest` arch + `/health` (:4300) smoke on the built image | arch == **arm64**; `/health` returns 200 on the Node20 base; **0** `ERR_REQUIRE_ESM` at boot | Promote image to prod |
| SC-8 (R12) | DB/platform owner | Synthetic GET to `/intel-api/feature-flags` via ALB after the rule add; `aws elbv2 describe-rules` | **200** through ALB; new rule at a confirmed non-colliding priority; rule recorded in the out-of-band inventory | Expose intel-api web calls |
| SC-9 (all H) | Release owner | §16.3 checklist | **All 7 UNVERIFIED items closed** (checked + evidence linked); every H-risk has an owner + a wired S15 detector + one rehearsed recovery run logged | Production cutover of first pilot tenant |

**Gate rule:** No pilot-tenant cutover until **SC-1, SC-2, SC-5, SC-6, SC-9** are green. No fleet-wide cutover until **SC-3, SC-4, SC-7, SC-8** are additionally green. Cutover is per-tenant via `enable-feature tracker_owner_intel <tenant>` and consistent with the single-sender/strangler model in §16's model invariants; the internal tenant (`CAPIRO_INTERNAL_TENANT_ID`, flag always-on) is exempt from flag-based rollback and must be paused at the cron-verb level instead.

---

## 17. Global success criteria & sign-off checklist

This section hardens §8 (definition of done) into a release gate. **The unification/cutover is signed off only when EVERY box below is checked with linked evidence** (a command transcript, a query result, a CloudWatch metric, a parity-report artifact, or a PR link). No box may be checked on assertion alone. Rows marked **UNVERIFIED** in the registry are called out — resolve the verification before checking, do not paper over.

**Legend:** Owner = who produces + links the evidence. Gate = what checking this box unblocks. All commands assume DEV (`--cluster capiro-dev`, ECR `capiro/dev/intel-api`, secrets `capiro/dev/*`, task-defs `capiro-dev-intel-api[-migrate]`); swap to PROD verbatim from the registry (`capiro-prod-os-capiro` cluster, ECR `capiro/prod-os-capiro/intel-api`, secrets `capiro/prod-os-capiro/*`, serve task-def `capiro-prod-intel-api`, migrate task-def `capiro-prod-intel-api-migrate`).

**PROD-only preconditions that MUST be resolved before any PROD box is checked (registry §1):**
- **UNVERIFIED — intel-api PROD service name:** likely `capiro-prod-intel-api` or `capiro-prod-os-capiro-intel-api`; managed out-of-band. Confirm via `aws ecs list-services --cluster capiro-prod-os-capiro` before any `update-service`/health box. No PROD sign-off until the exact name is pinned.
- **UNVERIFIED — run-task network config:** `subnets`/`securityGroups` for the one-off migrate/enable-feature tasks are not in the registry. Confirm from `scripts/deploy-ingestion-out-of-band.sh` `run_job_wait` template (or a resolved task-def) and paste the resolved `awsvpcConfiguration` into every `run-task` transcript below. `assignPublicIp=DISABLED`.
- **arm64 only:** every image referenced here MUST be built `--platform linux/arm64` (registry §1 build cmd / `.github/workflows/intel-api-image.yml`); an accidental amd64 `:latest` will not schedule on Fargate. Verify `docker manifest inspect <ecr>:<sha>` shows `architecture: arm64` before rolling.

---

### 17.1 Data model & migration (Phases 2–3)

| ✓ | Check | Verification (command / SQL / metric) | Owner | Gate |
|---|-------|----------------------------------------|-------|------|
| ☐ | Migrate task ran clean BEFORE serve rolled (ordering enforced, registry §1 deploy order) | `aws ecs run-task --cluster capiro-dev --launch-type FARGATE --task-definition capiro-dev-intel-api-migrate --network-configuration '<resolved awsvpcConfiguration>' --overrides 'containerOverrides=[{name=intel-api-migrate,command=["migrate"]}]'` → wait task STOPPED, container `intel-api-migrate` exitCode 0; log stream `intel-api-migrate` in `/capiro/dev/intel-api` shows `prisma migrate deploy` applied N, 0 failed. Serve `update-service --force-new-deployment` is issued ONLY after this exit-0 (proof: deploy transcript shows run-task exit 0 timestamp precedes update-service call) | SRE | serve deploy |
| ☐ | Migrate task carries ONLY DB secrets (least-priv, registry §2) | Migrate task-def injects `DB_HOST/DB_PORT/DB_USER/DB_PASSWORD` (+ `DB_NAME` env) and NO `DEEPGRAM_API_KEY`/`HEARING_ENCRYPTION_KEY`/`CLERK_SECRET_KEY`; entrypoint composes `DATABASE_URL` (URL-encoded pw, `sslmode=require`). `aws ecs describe-task-definition --task-definition capiro-dev-intel-api-migrate` secrets list = DB_* only | SRE | serve deploy |
| ☐ | Migration is idempotent / re-runnable (no partial-apply hazard) | Re-run the migrate task a 2nd time → exit 0, `prisma migrate deploy` reports "No pending migrations"; auto-rollback-of-failed behavior (registry §1) confirmed by forcing a failed migration in a scratch DB then re-running. NO seed runs (intel-api migrate has no `seed-workflows.ts` step, registry §1) | Eng | shadow run |
| ☐ | Unified tables exist with `tenant_id NOT NULL` | Using the RESOLVED table set from the schema-freeze row below: `SELECT table_name FROM information_schema.tables WHERE table_name = ANY($resolved_set);` returns ALL expected; for each tenant-scoped table `SELECT column_name FROM information_schema.columns WHERE table_name=$t AND column_name='tenant_id' AND is_nullable='NO';` = 1 row. (GLOBAL cross-DB tables in §4 are RLS-free and out of scope for this check) | Eng | shadow run |
| ☐ | **UNVERIFIED — RESOLVE FIRST (schema freeze):** tracker target table names. Registry §5 proposes `intel_topic`/`intel_term`; plan §2.1 said `intel_watchlist_topic`/`intel_watchlist_term`; the EXISTING hearing migration (`apps/intel-api/prisma/migrations/20260630000000_intel_watchlists`, verified) uses `intel_watchlist` + `intel_watchlist_term` + `intel_watchlist_match`. Pick ONE naming and decide REUSE-vs-NEW for `intel_watchlist_term` (do NOT create two term tables) | Migration SQL review + `\dt intel_*` shows exactly the resolved set, no duplicate term/topic tables; decision recorded in plan with the chosen names. This resolved set is the canonical `$resolved_set` used by the row above | Eng | schema freeze |
| ☐ | `intel_notification_log` idempotency key enforced (registry §5/§6) | `\d intel_notification_log` shows `UNIQUE (alert_id, user_id, channel)` carried verbatim from legacy `NotificationLog`. Insert-conflict test: 2nd insert of same `(alertId,userId,channel)` returns P2002 | Eng | delivery |
| ☐ | Watchlist migration is faithful + idempotent, run under a LOCK (no concurrent double-decompose) | One-off `enable-feature`-shaped task `sync-watchlists-from-legacy <tenant>` acquires a per-tenant advisory lock (`pg_advisory_xact_lock`) so overlapping runs can't double-insert topics/terms; then diff `ClientWatchlist.issueAreas`/`tags` decomposition vs the resolved topic/term tables per §5 mapping = 0 diffs; re-run = 0 rows changed (upsert on natural key). Concurrent double-run in DEV yields identical row counts | Eng | cutover |
| ☐ | **UNVERIFIED — RESOLVE:** `IntelligenceChange` emit target (registry §6). The apps/api `intelligence_change` table is NOT in the intel-api schema today (verified: no such `@@map` in `apps/intel-api/prisma/schema.prisma`) | `SELECT to_regclass('public.intelligence_change');` non-null AND intel-api Prisma role can write it, OR the `emitIntelligenceChange` cross-emit is removed/re-targeted in the port (PR linked). Do not leave a dangling write | Eng | shadow run |
| ☐ | Cross-DB reads centralized + column-contract tested (registry §4) | All `$queryRaw*` against apps/api GLOBAL tables live under `apps/intel-api/src/sourcedata/`; a contract test asserts registry §4 columns exist (`congress_bill.latestActionText`, `context_embeddings.embedding` typed `vector`, etc.). `grep -rn 'queryRaw\(Unsafe\)\?' apps/intel-api/src | grep -v sourcedata` = 0 hits | Eng | parity |
| ☐ | Connection-pool headroom for a 2nd writer | intel-api Prisma `connection_limit` set explicitly (not default) sized against Aurora `max_connections` shared with `capiro-dev-api`; under shadow load, `SELECT count(*) FROM pg_stat_activity WHERE usename=$intel_role;` stays below the allotment and total Aurora connections stay < 80% max. No `remaining connection slots` errors in `/capiro/dev/intel-api` logs during a detect cycle | SRE | shadow run |

---

### 17.2 Matching parity (Phases 3, 5)

| ✓ | Check | Verification | Owner | Gate |
|---|-------|--------------|-------|------|
| ☐ | Composite scoring ported EXACTLY | Code review: `fit = max(0,min(1, 0.4·semantic + 0.3·textMatch + 0.15·exactEntity + 0.1·subjectMatch + 0.05·priorityBoost))` (registry §6). Constants verbatim: `RECOMMENDATION_FLOOR=0.45`, `EMBED_CANDIDATE_FLOOR=0.3`, `MIN_TERM_LEN=3` — legacy source of truth confirmed at `apps/api/src/tracker/tracker.service.ts:44-45` (floors) and `tracker-relevance.util.ts` (`MIN_TERM_LEN`). A ported unit test feeds fixed component inputs and asserts `fit` to 1e-9 | Eng | parity |
| ☐ | Semantic cosine SQL identical | intel `semanticScores` = registry §6 SQL verbatim (`1 - (embedding <=> $1::vector)`, `source_type='bill'`, `model=$2`, `>= $3`, `ORDER BY <=>`, `LIMIT 400`); `$2`=`EMBEDDING_MODEL`, `$3`=`EMBED_CANDIDATE_FLOOR` (0.3). Run same query vector against both services on a fixed client → identical ranked `source_id` list | Eng | parity |
| ☐ | `classifyChange` cascade byte-identical | Table-driven test asserts intel regex cascade == registry §6 table (10 rows, most-significant-first: `bill_enacted`→…→`bill_hearing`→null) incl. changeType/severity/triggerKey; `DEFAULT_TRIGGERS` = 7 exact (newMatch, amendment, hearing, committeeVote, floorVote, enactedFailed, companion); a fixture of latest-action strings maps to identical `(changeType,severity,triggerKey)` in both services | Eng | shadow |
| ☐ | Bedrock query embeddings reachable — **UNVERIFIED — RESOLVE** (registry §2) | Task role has `bedrock:InvokeModel` for `arn:aws:bedrock:us-east-1::foundation-model/amazon.titan-embed-text-v2:0`. Evidence: `aws iam simulate-principal-policy` on the task role for that action/resource = allowed, OR a one-off task embeds a test string and `vectorLiteral` length = 1024 and the cosine query returns ranked bills (Phase 1 acceptance) | SRE | matching |
| ☐ | **False-positive rate < 25%** (MVP benchmark, MEASURED) | Over Phase-5 parity window, N≥200 labeled `intel_alert` rows: `SELECT count(*) FILTER (WHERE signal='false_positive')::float / NULLIF(count(*),0) FROM intel_feedback WHERE created_at > now()-interval '7 days';` **< 0.25**. Threshold: <0.25. Gate: cutover. Sample-size note: block if N<200 (statistically thin) | Product | cutover |
| ☐ | **≥95% alert-set overlap vs legacy, 0 missed criticals, 7 consecutive days** (CUTOVER GATE) | `task parity-report` (Phase 5) artifact per pilot tenant: `overlap = |intel ∩ legacy| / |legacy| ≥ 0.95` AND `missed_critical_count = 0` (any legacy `severity=critical` alert absent from intel) AND per-bill `abs(fit_intel − fit_legacy) ≤ 0.02`. Green for N=7 consecutive UTC days; all 7 daily artifacts archived (17.7) | Eng+Product | **CUTOVER GATE** |

---

### 17.3 Delivery & single-sender (Phases 4, 8)

*(Consistency with the single-sender/strangler model: legacy is the ONLY sender until a tenant is flipped; during shadow, intel sends NOTHING; after flip, legacy skips the flipped tenant and intel is the sole sender. The three checks below — legacy skip-guard, shadow zero-send, post-flip zero-collision — together enforce exactly-one-sender per tenant at every phase.)*

| ✓ | Check | Verification | Owner | Gate |
|---|-------|--------------|-------|------|
| ☐ | Single-sender skip-guard live on LEGACY side (registry §3/§4) | `apps/api/scripts/detect-tracker-alerts.ts` tenant loop has `if (await isIntelOwned(tenantId)) continue;` reading `intel_feature_flag` flag `tracker_owner_intel`. PR linked; unit test: a tenant with `tracker_owner_intel` on is skipped by the legacy detect run | Eng | cutover |
| ☐ | Shadow phase sends ZERO real emails (intel side) | During shadow, intel writes `intel_notification_log` rows with a suppressed/shadow status and calls NO SES send; evidence: CloudWatch SES `Send` for the intel `TRACKER_ALERT_EMAIL_FROM` identity = 0 over the shadow window, AND `SELECT count(*) FROM intel_notification_log WHERE status <> 'suppressed';` = 0 during shadow | SRE | cutover |
| ☐ | Idempotent send across the seam (registry §6) | `alertId = 'tracker:'+clientId+':'+billId+':'+changeType`; force a duplicate detect+deliver → `claim()` (INSERT ON CONFLICT `(alert_id,user_id,channel)`) returns P2002, 2nd send skipped; `SELECT alert_id,user_id,channel,count(*) FROM intel_notification_log GROUP BY 1,2,3 HAVING count(*)>1;` = 0 rows | Eng | cutover |
| ☐ | Detect/flush jobs safe under concurrency (no double-fire on overlapping cron) | A detect run and a flush run each take a job-scoped advisory lock (or `claimAndEnqueueDigest`'s single-tx claim, registry §6) so a slow run overlapping the next schedule cannot double-emit; DEV test: launch two detect runs simultaneously → alert counts identical to one run, 0 duplicate `intel_notification_log` rows | Eng | cutover |
| ☐ | `flushDigests` batching + poison-row safety (registry §6) | `flushDigests` queries `alertDigestQueue` where cadence∈(daily,weekly) AND flushed=false, take 5000, group by `(tenantId,userId,channel)`, marks flushed **regardless of send outcome**; unit test: a send that throws still leaves the row flushed (no infinite redelivery) | Eng | delivery |
| ☐ | **Zero duplicate client emails during 48h parallel burn-in** | Post-flip, per cutover tenant: no client receives BOTH a legacy and an intel alert for the same `(clientId,billId,changeType)`. Cross-check legacy `notification_log` vs `intel_notification_log` over the window: join on `(client_id,bill_id,change_type)` across both = 0 collisions. (This is the operational proof of single-sender, consistent with §17.3 guards) | SRE | sign-off |
| ☐ | Quiet-hours + cadence ported (registry §6) | `isWithinQuietHours(start,end)` HH:MM, ET via Intl.DateTimeFormat, minutes-since-midnight, midnight-wrap, suppresses SMS realtime; email cadence realtime\|daily\|weekly, SMS realtime\|daily. Unit tests green incl. a wrap case (e.g. 22:00→06:00) | Eng | delivery |
| ☐ | **Bill alert delivered within 30–60 min of action** (MVP benchmark, MEASURED) | For realtime-cadence alerts: p95 of `intel_notification_log.sentAt − <source action timestamp>` **≤ 60 min**, where source = `congress_bill_action.date` when time-resolved else detect-run start. Threshold: p95 ≤ 60 min. Gate: sign-off | Product | sign-off |
| ☐ | Every alert carries evidence + recommended action (MVP) | `SELECT count(*) FROM intel_alert WHERE evidence IS NULL OR evidence = '{}'::jsonb OR why_it_matters IS NULL;` = **0**. Bill evidence has `{actionText,url,…}`; hearing evidence has `{sessionId,segmentId,timestampMs,quote}` (plan §2.3). Threshold: 0. Gate: sign-off | Product | sign-off |
| ☐ | SES sender identity verified + task-role perms present — **UNVERIFIED — RESOLVE** (registry §2) | Task role has `ses:SendEmail`/`ses:SendRawEmail`; `TRACKER_ALERT_EMAIL_FROM` and `AWS_REGION_DEFAULT` set on the SERVE task-def; `TRACKER_SMS_PROVIDER=none` (SMS dormant). SES identity for the From address shows `VerificationStatus=Success` (`aws ses get-identity-verification-attributes`) AND account is out of sandbox for the recipient domains, OR recipients are verified. `sendTestAlert` delivers a real test email (post-flip only, not during shadow) | SRE | delivery |

---

### 17.4 Combined feed + use cases (Phase 6)

| ✓ | Check | Verification | Owner | Gate |
|---|-------|--------------|-------|------|
| ☐ | Combined feed endpoint per client, tenant-scoped | `GET /intel-api/clients/:clientId/feed` returns merged bill+hearing+combined alerts, filterable by sourceType/severity/date (plan §3 Phase 6); returns only the caller-tenant's rows (see 17.8 cross-tenant probe) | Eng | UI |
| ☐ | Bill↔hearing linking emits combined alert | Fixture: a tracked bill scheduled for a hearing then mentioned → 1 bill alert + 1 hearing alert + 1 combined alert in ONE feed, each with non-null evidence; assertion on the fixture's feed response | Eng+Product | sign-off |
| ☐ | §7 use cases 1–3 demonstrable end-to-end | Recorded walkthrough per use case linked in sign-off doc; each shows the triggering source event → alert → feed render | Product | sign-off |

---

### 17.5 Frontend (Phase 7)

*(Consistent with the strangler/coexistence model, registry §8: legacy `/api/intelligence/.../tracker/*` and new `/intel-api/*` both ride the SAME `useApi()` client; `tracker_v2` selects which renders. Legacy path is untouched for un-flagged tenants.)*

| ✓ | Check | Verification | Owner | Gate |
|---|-------|--------------|-------|------|
| ☐ | v2 surface gated on `tracker_v2`, fails CLOSED (registry §3/§8) | `useIntelFeatureEnabled('tracker_v2')` (`apps/web/src/lib/intel-feature-flags.ts`, GET `/intel-api/feature-flags`, 60s staleTime, returns `{}` on error) gates the unified Tracker at `ClientProfilePage.tsx` (TrackerTab ~line 513); flag off → legacy `TrackerTab` renders unchanged; forced network error → hook returns `{}` → legacy path (screenshot both) | Eng | cutover |
| ☐ | Sub-views Board \| Hearings \| Feed \| Configure wired to intel-api | `Panel = board\|hearings\|feed\|configure` via the existing sessionStorage `PANEL_KEY` pattern (registry §8, try/catch for private mode); new client (e.g. `apps/web/src/lib/intel-tracker-api.ts`) hits `/intel-api/*`; Hearings query key rescoped `['intel','hearings',clientId]` with clientId prop + `enabled` gate | Eng | cutover |
| ☐ | Brief view wired | Hearings sub-view calls `GET /hearings/:id/brief`, renders `HearingBrief` shape (registry §7) + export (F4); network capture shows the intel base URL + `Authorization: Bearer` | Eng | F-gate |
| ☐ | Feedback buttons persist | useful/not-useful writes `intel_feedback` (F5); row appears with correct `signal`; UI reflects persisted state after refetch | Eng | F-gate |
| ☐ | Legacy + intel coexist without collision | Same-session: un-flagged tenant sees legacy tracker, flagged tenant sees v2, both via one `useApi()` client, no console errors; confirms no route/queryKey collision (legacy keys `['tracker-board',c]` vs intel `['intel',…]`) | Eng | cutover |

---

### 17.6 Hearing completion F1–F7

| ✓ | F | Check | Verification | Owner |
|---|---|-------|--------------|-------|
| ☐ | F1 | Keyterm prompting into Deepgram | `DeepgramStreamManager.open()` (`apps/intel-api/src/hearing/deepgram-stream.manager.ts:72-80`) passes `keywords` (from watchlist compiler / sessionContext) into `listen.live({…})`; `model` still `nova-2` (`DEEPGRAM_MODEL`), endpointing `300` (`DEEPGRAM_ENDPOINTING_MS`) unchanged; reconnect exp backoff `500·2^(n-1)`, max 8. Live session log shows keyterms sent | Eng |
| ☐ | F2 | Stance/impact classifier | meriv2-core tool `classify_hearing_stance` registered via `ToolRegistry.register` in `apps/meriv2-orchestrator/src/meri/meri-registry.service.ts` (guarded by `ANTHROPIC_API_KEY`), `readOnly:true`, invoked only via `registry.invoke(name,input,ctx)` with `MeriContext`; persists a stance table; feeds supporters/opponents + `stance_detected` alerts. **UNVERIFIED — confirm the stance persistence table name/exists in intel-api schema, do not assume `intel_segment_analysis`** | Eng |
| ☐ | F3 | Pre-recorded/URL ingestion + S3 | NEW `@aws-sdk/client-s3` dep + `S3Client` in HearingModule (registry §7: none exists today); accepts uploaded audio / stream URL; Deepgram pre-recorded + callback; task role granted `s3:PutObject`/`s3:GetObject` on the named bucket/prefix (evidence: `simulate-principal-policy` allowed). **UNVERIFIED — confirm target S3 bucket name + that execution role can read any new bucket-scoped secret** | Eng+SRE |
| ☐ | F4 | Brief-view UI + export | (see 17.5) | Eng |
| ☐ | F5 | Feedback loop | (see 17.5) `intel_feedback` labels captured | Eng |
| ☐ | F6 | Archive semantic search | Transcript segments + bills embedded into `context_embeddings` (registry §4, `source_type` set appropriately, model=`amazon.titan-embed-text-v2:0`, dim 1024); NL query returns cross bills+hearings; cosine SQL mirrors §6. Writes respect `context_embeddings` RLS (tenant_id set, not NULL, for tenant-scoped hearing content) | Eng |
| ☐ | F7 | Score transparency in feed | §6 weighted breakdown surfaced per rec (semantic/textMatch/exactEntity/subjectMatch/priorityBoost contributions → why High/Med/Low); UI shows the components summing to `fit` | Eng |
| ☐ | — | **Brief ready within 1–3h of hearing** (MVP benchmark, MEASURED) | p95 `HearingBrief.generatedAt − session.endedAt` **≤ 3h**; `synthesisSource` populated (`orchestrator`\|`deterministic`). Threshold: p95 ≤ 3h | Product |

---

### 17.7 Observability

| ✓ | Check | Verification | Owner | Gate |
|---|-------|--------------|-------|------|
| ☐ | Logs land in correct group (registry §1 gotcha) | intel-api serve+migrate logs in `/capiro/dev/intel-api` streams `intel-api` + `intel-api-migrate`. Confirm the deployed task-defs point at `/capiro/dev/intel-api` (NOT the WRONG `/capiro/dev/api` that appears in one place in `resolved.json`): `aws ecs describe-task-definition ... | jq '..|.logConfiguration?.options["awslogs-group"]?'` shows only `/capiro/dev/intel-api` | SRE | deploy |
| ☐ | Detect/flush jobs scheduled + observed (out-of-band, mirror tracker) | New intel EventBridge rules exist (NOT in CDK — plan §7 risk); `aws events describe-rule`/`list-targets-by-rule` confirm schedule+target; each rule's last invocation succeeded (`Invocations`/`FailedInvocations` metrics). A `cdk deploy` since must NOT have dropped these OR the ALB priority-15 `/meri-api/*` rule (registry §1); re-assert both post-any-deploy | SRE | cutover |
| ☐ | Health check green + steady state | `GET /health` on :4300 returns 200; ECS service (`capiro-dev-intel-api`, PROD name per precondition) `deployments` shows 1 PRIMARY, `runningCount == desiredCount`, no failed tasks in last 30 min | SRE | deploy |
| ☐ | Alert-pipeline failures + SES bounces page a human | Detect/flush job failure metric and SES bounce/complaint route to `capiro-dev-alerts` (confirmed to have subscribers per Alerting memory — verify subscription still present); force one job failure → alarm fires and email received | SRE | sign-off |
| ☐ | Parity report retained as artifact | Each of the 7 green-day `task parity-report` outputs archived (S3 or PR) with date + tenant; links in sign-off doc | Eng | sign-off |

---

### 17.8 Security — tenant isolation, encryption, RLS

*(RLS is PRIMARY isolation, registry §4: intel-api is a SECOND service against the shared Aurora and is subject to the SAME policies. These checks prove it sets tenant context correctly and its DB role can read shared globals but not other tenants' scoped rows.)*

| ✓ | Check | Verification | Owner | Gate |
|---|-------|--------------|-------|------|
| ☐ | **UNVERIFIED — RESOLVE:** intel-api Prisma role + tenant-context primitives (registry §4) | Confirm intel-api sets `app.current_tenant_id` per query via `withTenant(tenantId)` (scoped) / `withSystem` (cross-tenant detect) equivalents, AND its DB role vs the api role (same role, or granted, or exempt). Evidence: role name from `capiro/dev/aurora/*` secret + `SELECT rolname, rolbypassrls FROM pg_roles WHERE rolname=$intel_role;` and the `withTenant`/`withSystem` implementation PR | Security | cutover |
| ☐ | Cross-tenant probe returns nothing | As tenant A, `GET /intel-api/clients/:B/feed` (client B belonging to a DIFFERENT tenant) → 404 / 0 rows, NOT tenant B's data. Repeat for watchlist, recommendations, alert-prefs | Security | cutover |
| ☐ | Shared globals readable, tenant rows isolated (registry §4 RLS) | Under intel-api's role: a query on `context_embeddings` returns NULL-`tenant_id` global bill embeddings BUT zero other-tenant scoped embeddings (policy `tenant_id IS NULL OR tenant_id = current_tenant_id`). Evidence: two `SET app.current_tenant_id` sessions return disjoint scoped sets + shared globals | Security | matching |
| ☐ | Feature guard returns 404 (not 403) when disabled (registry §3) | Hit a `tracker_v2`/`tracker_owner_intel`-gated intel route for a non-enabled, non-internal tenant → HTTP 404 (never 403, never leaks existence) | Eng | cutover |
| ☐ | Hearing transcript encryption intact (registry §7) | AES-256-GCM via `HearingCryptoService` (`HEARING_ENCRYPTION_KEY`, fallback `NOTES_ENCRYPTION_KEY`, 12-byte IV); stored segments unreadable without key (raw `SELECT` shows ciphertext); bill alerts carry NO transcript text | Security | sign-off |
| ☐ | Secrets from Secrets Manager only; none in image/env-literals (registry §2) | Serve task-def pulls `DEEPGRAM_API_KEY`, `HEARING_ENCRYPTION_KEY`, `CLERK_SECRET_KEY`, `DB_*` from `capiro/dev/*`; execution role has ECR-pull + Secrets-read per `infra/deploy/intel-api-execrole-inline-policy.json` AND that policy lists every secret ARN above (a new secret added for tracker MUST be added to the execution-role policy or the task fails to start); `grep -rn` for hardcoded keys in the image = 0; migrate task = DB_* only | SRE | deploy |
| ☐ | New ALB rule (only if intel is web-exposed) added out-of-band at a free priority — **UNVERIFIED** (registry §1) | NO `/intel-api/*` rule exists today; intel is internal-only on :4300 and the frontend resolves `/intel-api/*` against the api base URL. If a dedicated rule IS required, add via `aws elbv2 create-rule` (NOT `cdk deploy`; PROD ALB `capiro-prod-alb` is manually managed) at a priority confirmed free against existing 3/5/10/15/20 — verify with `aws elbv2 describe-rules` before creating; suggested 12/17 are UNVERIFIED | SRE | UI |
| ☐ | Security review clean | `/security-review` on the cutover branch: no high/critical on the tracker port — focus cross-DB `$queryRaw` injection surface in `sourcedata/`, tenant-scoping, secret handling. Findings triaged/fixed, linked | Security | sign-off |

---

### 17.9 Cutover & decommission (Phases 8–9)

| ✓ | Check | Verification | Owner | Gate |
|---|-------|--------------|-------|------|
| ☐ | Per-tenant cutover runbook executed (§4 steps 1–6) | Pilot tenants (recommend capiro-internal + "Aperture Defense Systems"): `enable-feature tracker_owner_intel <tenant>` then `enable-feature tracker_v2 <tenant>` via one-off migrate-family task ran STOPPED exit 0; `SELECT feature, tenant_id, enabled FROM intel_feature_flag WHERE tenant_id=$t;` shows both on | SRE | burn-in |
| ☐ | Flip order correct (owner before UI) | Runbook flips `tracker_owner_intel` (backend ownership + legacy skip) BEFORE `tracker_v2` (UI), so no window where UI is v2 but legacy still sends. Transcript timestamps confirm order | SRE | burn-in |
| ☐ | Reverse-sync disabled post-flip (§4 step 5) | `sync-watchlists-from-legacy` is a no-op for a flipped tenant (source of truth moved to intel); test: run it for a flipped tenant → 0 rows written | Eng | burn-in |
| ☐ | Rollback proven (registry: intel never writes apps/api tables) | Disable both flags → legacy resumes sending + serving within one detect cycle; intel goes silent; no data loss (D5/D6: intel never wrote `ClientWatchlist`/`TrackedBill`/legacy `notification_log`). Rehearsed on a pilot tenant; before/after row counts of legacy tables unchanged by intel | SRE | sign-off |
| ☐ | Decommission gated on full flip + 2-wk burn-in | ALL tenants on intel; legacy EventBridge rules (`detect-tracker-alerts`, `emit-bill-alerts`, `flush-tracker-digests`) disabled (`aws events disable-rule`, verified `State=DISABLED`); `apps/api/src/tracker/*` + legacy web `tracker-api.ts` removed (PR linked); `ClientWatchlist`/`TrackedBill` kept read-only one release, THEN dropped via migration (separate PR) | Eng+SRE | final sign-off |

---

**Success criteria (release-blocking, all must hold with linked evidence):**

1. **Parity gate (17.2):** `task parity-report` shows **≥95% alert-set overlap vs legacy, 0 missed criticals, per-bill fit-delta ≤0.02, 7 consecutive days** across pilot tenants — Eng+Product, artifacts archived (17.7). Unblocks cutover.
2. **Single-sender / no-double-send gate (17.3):** `SELECT … HAVING count(*)>1` on `intel_notification_log` = **0 rows**, AND legacy↔intel collision cross-check over the 48h burn-in = **0 duplicate client emails**, AND legacy skip-guard verified active for flipped tenants — SRE. Unblocks decommission.
3. **MVP benchmarks (all MEASURED, thresholds explicit):**
   - **≥80% of high-priority alerts rated useful:** `count(*) FILTER (WHERE signal='useful')::float / NULLIF(count(*),0) FROM intel_feedback WHERE materiality='high' AND created_at > <burn-in start>` **≥ 0.80** (block if sample N<50) — Product.
   - **Bill alert within 30–60 min:** p95 `sentAt − source-action` **≤ 60 min** (17.3) — Product.
   - **Brief within 1–3h:** p95 `generatedAt − endedAt` **≤ 3h** (17.6) — Product.
   - **False positives < 25%:** false_positive/total **< 0.25**, N≥200 (17.2) — Product.
   - **Every alert has evidence + recommended action:** `intel_alert` with null `evidence`/`why_it_matters` = **0** (17.3) — Product.
4. **Tenant isolation gate (17.8):** cross-tenant probe returns 404/0-rows, RLS enforced under intel-api's DB role, shared-globals-readable confirmed, encryption intact, `/security-review` clean — Security. Unblocks prod cutover.
5. **Rollback proven (17.9):** flag-off rehearsal restores legacy with zero data loss (intel wrote no apps/api tables) — SRE.

**The release is signed off only when every checkbox in 17.1–17.9 is ✓ with evidence linked, and criteria 1–5 above are all satisfied.** Every **UNVERIFIED — RESOLVE** row (schema-freeze table naming, `IntelligenceChange` target, Bedrock/SES/S3 task-role perms, intel-api Prisma role/RLS primitives, PROD intel-api service name, run-task network config, ALB priority, F2 stance table, F3 S3 bucket) must be resolved — verified true, or the plan re-targeted — before its box may be checked. It may not be waved through.

---

## 18. Open questions & decisions log

This section supersedes the earlier "Open questions for Ninja" list. It carries forward every open question, states the **recommended default already baked into this plan**, spells out **what changes if the answer differs**, and adds a **dated, append-only decisions-log table** to record answers as they land. It also promotes every registry item marked **UNVERIFIED — must confirm** into a tracked open question, because those block cutover.

**Convention:** each item has a stable ID (`Q#` for product/scope decisions carried from earlier; `V#` for registry-UNVERIFIED confirmations). Recorded decisions reference the `D1–D7` codes from §0 where they already exist.

**Model this section stays consistent with (do not contradict elsewhere in the plan):**
- **Strangler / watch-only (D1, D2):** intel-api READS `congress_bill` / `state_bill` / `context_embeddings` cross-table via raw SQL and NEVER writes apps/api-owned tables. Any new emit/audit target must be an intel-owned table.
- **Shadow-then-flip (Q4, Q5):** cutover runs intel-api in shadow (compute + compare, deliver nothing) on the pilot tenant until the parity gate clears, then flips delivery ownership.
- **Single-sender (D5):** at any instant exactly ONE service delivers a tenant's tracker alerts. `tracker_owner_intel` is the ownership toggle; apps/api's notifier for a tenant is disabled in the SAME change that turns intel-api's on. No double-send window.
- **Unified watchlist (D3):** one watchlist store drives BOTH bill and hearing matching (Q7 resolves final names). No parallel term stores.

---

### 18.1 Product / scope open questions (carried forward, now with defaults)

| ID | Question | Recommended default (in this plan) | What changes if the answer differs | Owner | Gate it blocks |
|----|----------|-----------------------------------|-----------------------------------|-------|----------------|
| **Q1** | Watch-only migration (ingestion stays in `apps/api`) vs. move ingestion too? (§0 D1) | **Watch-only.** intel-api reads `congress_bill` / `state_bill` / `context_embeddings` cross-table via raw SQL (§0 D2); ingestion + embeddings writer stay in `apps/api`. | Moving ingestion pulls `sync-congress`/`sync-openstates` + the embeddings writer into intel-api → duplicate sync fleet, new EventBridge rules, intel-api gains WRITE access to `congress_bill` (violates D2). Adds ~1 phase. Not recommended. | Ninja | Phase 1 start |
| **Q2** | State bills in cutover v1, or federal-first? | **Federal-first.** intel-api is state-*read-capable* (`state_bill`, §4) but state is NOT cutover-blocking. | State-in-v1 extends Phase 5 parity to `state_bill` change-detection + a second `classifyChange` regex table; the Q5 parity threshold must also be met for state before flip. | Ninja | Phase 5 gate |
| **Q3** | Delivery ownership — intel-api sends directly, or emits events for apps/api's notifier? | **intel-api sends directly** (SESv2 via ported `TrackerEmailService`), gated by single-sender ownership flag `tracker_owner_intel` (§0 D5, §3 flags). | Event-emit model needs a new cross-service queue + apps/api consumer; the single-sender guarantee moves to the consumer side. More moving parts; abandons the clean cutover flag. Not recommended. | Ninja | Phase 4 |
| **Q4** | Pilot tenant for first cutover. | **`capiro-internal` + demo client "Aperture Defense Systems"** (flags ALWAYS-on for `CAPIRO_INTERNAL_TENANT_ID`, so it is the natural shadow/pilot). | A real customer as pilot means the Q5 parity gate must clear against live client-facing alerts before any flip — higher blast radius, and quiet-hours/cadence edge cases hit real recipients. | Ninja | Phase 8 step 1 |
| **Q5** | Parity acceptance threshold for cutover. | **≥95% alert-event overlap (Jaccard on the set of `alertId` = `tracker:<clientId>:<billId>:<changeType>`) AND zero missed *critical*-severity events, for 7 consecutive shadow days** (§7 risk row). Measured by a shadow-diff job comparing intel-api's would-send set vs. apps/api's actual send set per day; report emitted to the intel-api log group. | Loosening (90%, 3d) accelerates cutover at correctness risk; tightening (100% incl. `notable`) delays. This is the HARD Phase 5→8 gate. If overlap <95% or any critical missed on ANY of the 7 days, the 7-day clock RESETS. | Ninja | Phase 5 gate |
| **Q6** | Keep per-user `AlertPreference` semantics identical, or add hearing-specific triggers in unified prefs? | **Identical carry-over** — `alert_preference` → `intel_alert_preference` 1:1, no decomposition (§5). Unified `DEFAULT_TRIGGERS` already includes `hearing`. | Adding hearing-specific triggers means new columns on `intel_alert_preference` + a prefs-UI change + a backfill default for existing rows. Defer to a post-cutover follow-up. | Ninja | Phase 4 (schema freeze) |
| **Q7** | Watchlist target table shape — proposed `intel_topic`/`intel_term` vs. reuse existing hearing tables. | **RESOLVED — reuse/extend the EXISTING hearing tables: `intel_watchlist` + `intel_watchlist_term` (+ `intel_watchlist_match`)**, adding an `intel_watchlist_topic` layer ONLY if bill-topic grouping needs it. **Source-verified 2026-06-30:** `apps/intel-api/prisma/schema.prisma` contains ONLY `intel_watchlist` (@@map, L65), `intel_watchlist_term` (L84), `intel_watchlist_match` (L105) — there is NO `intel_topic`/`intel_term` today. The §5 field mapping that names `intel_topic`/`intel_term` is the DIVERGENT proposal and MUST be rewritten to the existing names before the migration is authored (tracked by Success-criteria #5, and now recorded as decided in §18.3). | Introducing separate `intel_topic`/`intel_term` creates two parallel term stores (hearing vs. bill) — defeats "one watchlist" (D3). Must not ship divergent names. | Staff eng + Ninja | Phase 2 migration author |

---

### 18.2 Registry-UNVERIFIED items (must be CONFIRMED before cutover)

Each row is an open question because the registry (or verified code) could not confirm it. **No cutover while any non-hearing `Blocks` item has `Status = OPEN`.** "How to confirm" gives the exact command/artifact; run read-only against the shared Aurora / prod ECS (prod DB reads only via a `diag-*` one-off ECS task per `infra_query_prod_db`).

> **Source-verified 2026-06-30:** V7, V8, and V10 have been source-verified against `apps/intel-api/prisma/schema.prisma` and the shipped task-def JSON (evidence in §18.3). Their `Status` is set to VERIFIED and their downstream defaults are now the plan of record: no `IntelligenceChange` write (V7), summaries ship OFF (V8), log-group fix required (V10). Q7 is likewise resolved to the existing table names. The other V-rows remain OPEN pending their confirming command.

| ID | UNVERIFIED item (registry ref) | Recommended default | How to confirm (exact) | Blocks | Status |
|----|-------------------------------|---------------------|------------------------|--------|--------|
| **V1** | **Prod intel-api service name** (§1: likely `capiro-prod-intel-api` or `capiro-prod-os-capiro-intel-api`; prod cluster is out-of-band, NOT CDK) | Use `capiro-prod-intel-api` until confirmed. | `aws ecs list-services --cluster capiro-prod-os-capiro --region us-east-1` → grep intel. Record the EXACT ARN. | Phase 8 prod roll (`update-service --force-new-deployment`) | OPEN |
| **V2** | **DB role / `withTenant` / `withSystem` availability in intel-api**, and whether that role can read `context_embeddings` NULL-tenant rows under RLS (§4 RLS gotcha) | intel-api connects under the **same DB role as `apps/api`** (secrets `capiro/<env>/aurora/app`) and mirrors `prisma.withTenant(tenantId, tx)` for scoped reads / `prisma.withSystem(tx)` for cross-tenant detection. Shadow-diff cross-tenant scan uses `withSystem`. | (a) Confirm code: `grep -rn "withTenant\|withSystem\|current_tenant_id" apps/intel-api/src`. (b) Run a `diag-*` one-off ECS task: `SELECT current_user;` then `SET app.current_tenant_id='<uuid>'; SELECT count(*) FROM context_embeddings WHERE tenant_id IS NULL;` — MUST return >0 AND equal the count seen under the api role. | Phase 3 (match-engine reads), Phase 5 parity | OPEN |
| **V3** | **Task role has Bedrock perms** — `bedrock:InvokeModel` for `amazon.titan-embed-text-v2:0` (embeddings) + Anthropic Claude on Bedrock (summaries) (§2) | Grant on the shared api task role (dev `...ApiTaskRole12FAD4A7-szq3QeeZJSCQ`, prod `...ApiTaskRole12FAD4A7-5zhubZnOJ9nz`) via a NEW inline policy file alongside `infra/deploy/intel-api-execrole-inline-policy.json` (note: that existing file is the EXECUTION role's ECR/Secrets policy — Bedrock/SES belong on the TASK role, a different role; do not conflate). | `aws iam list-role-policies --role-name <task-role>` + `aws iam get-role-policy` (and `list-attached-role-policies`); confirm an Allow for `bedrock:InvokeModel` on the Titan-embed + Claude model ARNs in us-east-1. If absent, add inline policy on the task role. | Phase 3 (semantic scores), Phase 4 (summaries) | OPEN |
| **V4** | **SES identity + `ses:SendEmail`** on task role; verified `TRACKER_ALERT_EMAIL_FROM` sender identity (§2) | Reuse apps/api's already-verified SES sender identity for `TRACKER_ALERT_EMAIL_FROM`; grant `ses:SendEmail`/`ses:SendRawEmail` on the TASK role. Confirm the account is out of the SES sandbox in us-east-1 (else only verified recipients receive) OR pilot recipients are verified. | `aws ses get-identity-verification-attributes --identities <from-addr> --region us-east-1` = Success; `aws sesv2 get-account --region us-east-1` → `ProductionAccessEnabled=true`; `get-role-policy` shows `ses:SendEmail`. | Phase 4 delivery (real sends) | OPEN |
| **V5** | **One-off task shape for migrate & enable-feature** — subnets/SGs, AND the enable-feature FAMILY/CONTAINER name (§1 run-task shape) | migrate uses family `capiro-dev-intel-api-migrate` / container `intel-api-migrate`. **enable-feature uses a SEPARATE family `capiro-dev-intel-api-enableflag` / container `intel-api-enableflag`** (verified in `infra/deploy/intel-api-enableflag-taskdef.json`), NOT the migrate container — the §1 run-task example that shows `containerOverrides[].name=intel-api-migrate` for enable-feature is WRONG and must be corrected to `intel-api-enableflag`. Subnets/SGs `assignPublicIp=DISABLED`, pulled from the deploy helper. | Read `scripts/deploy-ingestion-out-of-band.sh` `run_job_wait` template for subnets/SGs; or `aws ecs describe-services --cluster capiro-dev --services capiro-dev-intel-api --query 'services[0].networkConfiguration' --region us-east-1`. Confirm both one-off families are registered: `aws ecs describe-task-definition --task-definition capiro-dev-intel-api-migrate` and `...-enableflag`. | Phase 1 (first migrate task), every `enable-feature` run (Phase 4/8) | OPEN (subnets/SGs) |
| **V6** | **New ALB listener-rule priority for `/intel-api/*`** (§1: no rule exists today; :4300 is internal-only; suggest 12 or 17, collision UNVERIFIED) | Add rule at **priority 12** (between `/workspace-api/*`=10 and `/meri-api/*`=15) forwarding `/intel-api/*` → intel-api target group (:4300), via `aws elbv2 create-rule` on prod `capiro-prod-alb` — NOT `cdk deploy` (prod ALB is manually managed/wedged; a `cdk deploy` must not drop this rule, mirroring the known priority-15 webhook-rule gotcha). Requires the intel-api target group to exist and pass health checks on `/health` first. | `aws elbv2 describe-rules --listener-arn <https-listener-arn> --region us-east-1` → confirm 12 AND 17 are BOTH free, pick lowest free; confirm the intel-api target group ARN and its health status BEFORE creating the rule. Record the created rule ARN + priority. | Phase 7 (frontend calls `/intel-api/*` through ALB) | OPEN |
| **V7** | **`IntelligenceChange` table does NOT exist in intel-api schema** (§6 emit; it is an apps/api-owned table) | **Source-verified 2026-06-30:** a `grep` of `apps/intel-api/prisma/schema.prisma` returns NO `intelligence_change`/`IntelligenceChange`. Writing apps/api's `IntelligenceChange` would violate D2 (no cross-service writes). **Plan of record:** re-target the emit to an intel-owned feed table (`intel_alert` / a new `intel_intelligence_change` added in Phase 2), OR drop the emit and rely on `intel_alert`. The §6 "must confirm or re-target" note is now settled toward re-target; the ONLY remaining open sub-decision is WHICH intel-owned target (new table vs. reuse `intel_alert`), to be fixed in the Phase 2 migration. This supersedes any §2/§6 language that still presents `IntelligenceChange` existence as an open UNVERIFIED question. | `grep -ri "intelligence_change\|IntelligenceChange" apps/intel-api/prisma/schema.prisma` (expect 0 — confirmed). Whichever target chosen, confirm it appears in the Phase 2 migration. | Phase 4 (change emit) | VERIFIED (absent); re-target sub-decision OPEN |
| **V8** | **`AiCredentialResolverService` + `ai_usage_events` table do NOT exist in intel-api** for tenant-scoped Anthropic key + metering (§2, §6 summaries) | **Source-verified 2026-06-30:** `ai_usage_events` and `AiCredentialResolverService` are absent from the intel-api schema/source. **Plan of record:** ship summaries OFF (`TRACKER_ALERT_SUMMARY` UNSET) at cutover; alerts send without summaries (fail-safe → null is already the code path). Port `AiCredentialResolverService.resolveProviderByTenantId` + add `ai_usage_events` (Phase 2 migration) only when enabling summaries later. This supersedes any §2/§6 language that still lists these as open UNVERIFIED for cutover — they are confirmed absent and intentionally deferred (non-blocking). | `grep -ri "AiCredentialResolver\|ai_usage_events" apps/intel-api/` (expect 0 — confirmed). If enabling summaries, confirm both are ported + table migrated before setting the flag. | Phase 4 (summaries) — ONLY if enabled; NOT cutover-blocking with default | VERIFIED (absent); non-blocking |
| **V9** | **S3 bucket naming** for hearing pre-recorded ingestion / audio (F3/F6) — no S3 client exists in intel-api (§7) | Needed ONLY for the hearing pre-recorded workstream, NOT bill-tracker cutover. Provision a dedicated bucket (suggest `capiro-<env>-intel-hearings`, **name UNVERIFIED**) + add `@aws-sdk/client-s3` + `s3:PutObject`/`s3:GetObject` on the TASK role scoped to that bucket ARN. | Decide bucket name with Ninja; `aws s3api head-bucket --bucket <name> --region us-east-1` to check ownership/availability; add scoped S3 policy to task role. | Hearing F3/F6 ONLY (NOT tracker cutover) | OPEN |
| **V10** | **Log-group misconfig in shipped intel-api task-defs** — the intel-api task-defs point `awslogs-group` at `/capiro/dev/api` instead of the intel-api log group; §1 says the template should use `/capiro/dev/intel-api` (prod `/capiro/prod-os-capiro`). Registry §2.5 identifies the affected set as the intel-api **serve / migrate / oneoff** task-defs. | **Source-verified 2026-06-30:** `infra/deploy/intel-api-enableflag-taskdef.json` (an instance of the §2.5 "oneoff" task-def set) has `"awslogs-group": "/capiro/dev/api"` — a concrete instance of the bug, confirming the §2.5 finding. **Plan of record:** fix the log group to `/capiro/dev/intel-api` (prod `/capiro/prod-os-capiro`) across the SAME task-def set §2.5 names — **serve, migrate, and oneoff (which includes `intel-api-enableflag`)** — plus `resolved.json`, before prod register, so migrate/enable-feature output is discoverable during cutover. (Naming reconciliation: §2.5's "oneoff" set is the umbrella that covers the `enableflag` task-def called out in earlier drafts of this row — same fix set, no divergence.) | Fix the JSON (`intel-api-enableflag-taskdef.json` + the serve/migrate task-defs) + `resolved.json`, re-register, then `aws logs describe-log-streams --log-group-name /capiro/prod-os-capiro --region us-east-1` (dev: `/capiro/dev/intel-api`) after first roll → see `intel-api`, `intel-api-migrate`, and the oneoff/`intel-api-enableflag` streams. | Phase 1 (migrate/enable-feature observability), Phase 8 (prod observability) | VERIFIED (bug present); fix OPEN |
| **V11** | **Connection-pool impact of a SECOND service on shared Aurora** (intel-api adds its own Prisma pool on top of apps/api's; §4 shared cluster) | Cap intel-api's Prisma `connection_limit` explicitly (e.g. `?connection_limit=5` in the composed `DATABASE_URL`) so intel-api serve + concurrent one-off tasks stay within Aurora `max_connections` headroom alongside apps/api. Verify before enabling the detection cadence. | `SELECT max_connections;` and `SELECT count(*) FROM pg_stat_activity;` via `diag-*` task at expected load; confirm headroom for intel-api pool + migrate/enableflag one-offs. Set/confirm `connection_limit` on the intel-api serve task-def `DATABASE_URL`. | Phase 3 (match-engine reads at cadence), Phase 8 (prod load) | OPEN |
| **V12** | **Detection-job concurrency/locking** — ported `runDetectionCycle` / `flushDigests` become intel-api entrypoint verbs invoked by EventBridge; two overlapping runs could double-process (§6) | Rely on `NotificationLog` idempotency (`claim` = INSERT ON CONFLICT on unique `(alertId,userId,channel)`, P2002 → skip) as the primary guard, PLUS a single-flight lock (Postgres advisory lock, e.g. `pg_try_advisory_lock`) per verb so a slow run cannot overlap the next EventBridge tick. `flushDigests` already marks rows flushed regardless of send outcome (poison-row safety). Ensure the ported `intel_notification_log` preserves the unique key. | Confirm the Phase 2 migration creates `intel_notification_log` with UNIQUE `(alertId,userId,channel)`; confirm the entrypoint verb acquires an advisory lock and no-ops if not acquired. Test: fire two runs concurrently against the pilot → zero duplicate sends (query `intel_notification_log`). | Phase 4 (scheduled detection + digests) | OPEN |

---

### 18.3 Decisions log (append-only; record answers here as they land)

Rows are recorded chronologically. `Status`: `OPEN` → `DECIDED` → `VERIFIED` (for V-items, VERIFIED means the confirming command was run and evidence attached). Attach evidence (command output / ARN / rule priority) in the `Evidence / notes` cell. **Do not delete rows — the log is the SOC 2 audit trail.**

| Date | ID | Decision / answer | Status | Owner | Evidence / notes |
|------|----|-------------------|--------|-------|------------------|
| 2026-06-30 | D1 | Watch-only migration; ingestion stays in `apps/api`. | DECIDED | Ninja | §0 D1 (recorded in plan) |
| 2026-06-30 | D2 | intel-api reads apps/api tables via raw SQL, never writes them. | DECIDED | Ninja | §0 D2 |
| 2026-06-30 | D3 | One unified watchlist drives bill + hearing matching. | DECIDED | Ninja | §0 D3; see Q7 for final table names |
| 2026-06-30 | D5 | Single-sender via `tracker_owner_intel` ownership flag; apps/api notifier for a tenant is disabled in the same change that enables intel-api's. | DECIDED | Ninja | §0 D5 |
| 2026-06-30 | D7 | End-state UI = client-profile Tracker tab (Board \| Hearings \| Feed \| Configure); retire standalone `HearingWatchPage`. | DECIDED | Ninja | §0 D7 |
| 2026-06-30 | Q7 | Reuse EXISTING hearing tables `intel_watchlist` / `intel_watchlist_term` / `intel_watchlist_match` (add `intel_watchlist_topic` only if needed); do NOT introduce `intel_topic`/`intel_term`. §5 field-mapping must be rewritten off the divergent names. | DECIDED (source-verified) | Staff eng + Ninja | `grep @@map apps/intel-api/prisma/schema.prisma` → only `intel_watchlist` (L65), `intel_watchlist_term` (L84), `intel_watchlist_match` (L105); NO `intel_topic`/`intel_term`. Drives Success-criteria #5. |
| 2026-06-30 | V5 | enable-feature one-off is a SEPARATE task-def family/container from migrate. | VERIFIED (partial) | Staff eng | `infra/deploy/intel-api-enableflag-taskdef.json`: family `capiro-dev-intel-api-enableflag`, container `intel-api-enableflag`. Subnets/SGs still OPEN. |
| 2026-06-30 | V7 | `IntelligenceChange` absent from intel-api schema → must re-target to an intel-owned table, not write apps/api table. | VERIFIED | Staff eng | `grep -ri "intelligence_change\|IntelligenceChange" apps/intel-api/prisma/schema.prisma` = 0 matches. Re-target TARGET sub-decision (new `intel_intelligence_change` vs. reuse `intel_alert`) still OPEN. |
| 2026-06-30 | V8 | `ai_usage_events` / `AiCredentialResolverService` absent from intel-api → summaries ship OFF at cutover. | VERIFIED | Staff eng | `grep -ri "AiCredentialResolver\|ai_usage_events" apps/intel-api/` = 0. Port decision deferred (non-blocking). |
| 2026-06-30 | V10 | Log-group misconfig confirmed in a shipped intel-api task-def; fix required across the §2.5 serve/migrate/oneoff set (oneoff includes `intel-api-enableflag`) + `resolved.json`. | VERIFIED (bug present) | SRE | `intel-api-enableflag-taskdef.json` `awslogs-group=/capiro/dev/api` (should be `/capiro/dev/intel-api`); family `capiro-dev-intel-api-enableflag`. Task-def set reconciled to §2.5 wording (serve/migrate/oneoff). Fix + re-register still OPEN. |
| _pending_ | Q2 | State bills in cutover v1? (default: federal-first) | OPEN | Ninja | — |
| _pending_ | Q4 | Pilot tenant (default: capiro-internal + Aperture Defense Systems) | OPEN | Ninja | — |
| _pending_ | Q5 | Parity threshold (default: ≥95% overlap, 0 missed criticals / 7 consecutive days) | OPEN | Ninja | — |
| _pending_ | V1 | Prod intel-api service name | OPEN | SRE | Run `ecs list-services` |
| _pending_ | V2 | DB role + `withTenant`/`withSystem` + NULL-tenant `context_embeddings` read | OPEN | Staff eng | grep src + `diag-*` task |
| _pending_ | V3 | Task-role Bedrock perms (Titan embed + Claude) | OPEN | SRE | `iam get-role-policy` on TASK role |
| _pending_ | V4 | SES identity + `ses:SendEmail` + prod-access (not sandboxed) | OPEN | SRE | `ses get-identity-verification-attributes` + `sesv2 get-account` |
| _pending_ | V5 | run-task subnets/SGs | OPEN | SRE | Read `deploy-ingestion-out-of-band.sh` |
| _pending_ | V6 | `/intel-api/*` ALB rule priority (default 12) + target group exists/healthy | OPEN | SRE | `elbv2 describe-rules` |
| _pending_ | V7 | `IntelligenceChange` re-target TARGET (new `intel_intelligence_change` vs. reuse `intel_alert`) | OPEN | Staff eng | Confirm chosen target in Phase 2 migration |
| _pending_ | V8 | `AiCredentialResolverService` + `ai_usage_events` port (only if summaries enabled) | OPEN | Staff eng | — |
| _pending_ | V9 | S3 bucket name (hearings; NOT tracker-blocking) | OPEN | Ninja + SRE | — |
| _pending_ | V10 | Log-group FIX (`resolved.json` + serve/migrate/oneoff intel-api task-defs) | OPEN | SRE | Re-register + `logs describe-log-streams` |
| _pending_ | V11 | Aurora connection-pool headroom + intel-api `connection_limit` | OPEN | SRE | `pg_stat_activity` at load |
| _pending_ | V12 | Detection-job single-flight lock + `intel_notification_log` unique key | OPEN | Staff eng | Concurrent-run test → 0 dup sends |

> **Process:** on each decision, flip the matching row to `DECIDED`/`VERIFIED`, fill `Date`/`Owner`/`Evidence`, and (for a changed default) update the affected phase in §3 and any dependent §-row in the SAME PR. Do not delete rows. **Note:** the 2026-06-30 source-verified findings (Q7, V7, V8, V10) are now the plan of record; §5 (watchlist field mapping), §6 (`IntelligenceChange` emit + summaries), §7 (hearing blockers), and §2 (env/secrets) must be reconciled to these decisions in the SAME PR so they no longer present settled items as open — see Success-criteria #5 for the §5-naming gate and V10 above for the §2.5-vs-V10 task-def-set reconciliation.

---

**Success criteria** (independently verifiable; gates final cutover, §3 Phase 8). Each is stated as **command/metric + threshold + gate + owner**:

1. **Zero OPEN blockers at cutover.**
   - Owner/verifier: release owner.
   - Command: `grep -c "| OPEN |" §18.3` restricted to rows whose §18.2 `Blocks` is non-hearing (i.e. all V-items except V9) AND §18.1 Q-items gating Phase ≤8. V7's re-target sub-decision and V10's fix count as OPEN blockers until closed even though their existence facts are VERIFIED.
   - Threshold: **0** such OPEN rows (V9, hearing-only, may remain OPEN; V8 is non-blocking with summaries OFF).
   - Gate: unblocks Phase 8 step 1 (first flip).

2. **Every recorded decision is attributable.**
   - Owner/verifier: SOC 2 reviewer.
   - Command: scan §18.3 for any `DECIDED`/`VERIFIED` row with empty `Date`, `Owner`, or `Evidence / notes`.
   - Threshold: **100%** of non-OPEN rows fully populated (0 empties).
   - Gate: SOC 2 audit sign-off; blocks Phase 9 close-out.

3. **Each V-item confirmation has attached command evidence.**
   - Owner/verifier: SRE.
   - Command: inspect V1–V8, V10–V12 `Evidence` cells for actual command output / ARN / count / priority (not a bare "confirmed"). Examples: V2 shows `count(*)>0` for NULL-tenant `context_embeddings` equal under both roles; V3 shows the `get-role-policy` Allow statement; V6 shows the created rule ARN + priority from `elbv2 create-rule`; V7/V8 show the schema `grep` = 0; V10 shows the offending `awslogs-group` value; V11 shows `max_connections` and observed `pg_stat_activity` count.
   - Threshold: **every** listed V-item has concrete evidence.
   - Gate: unblocks Phase 8 step 1.

4. **No default silently overridden.**
   - Owner/verifier: staff eng.
   - Command: for any Q-item whose recorded answer ≠ the plan's recommended default (e.g. state-in-v1 for Q2), `git blame` the affected §3 phase text and confirm it references the decision date/PR.
   - Threshold: **0** overridden defaults lacking a same-PR §3 update.
   - Gate: prevents plan/impl drift; blocks Phase merge for the affected phase.

5. **Watchlist table-name reconciliation closed (Q7 / §5-naming).**
   - Owner/verifier: migration author.
   - Command: `grep -rc "intel_topic\|intel_term" apps/intel-api/prisma/migrations/` on the Phase 2 migration files, AND `grep -c "intel_topic\|intel_term" §5` on the plan's field-mapping text.
   - Threshold: **0** in both (migration + §5 text use only the existing `intel_watchlist` / `intel_watchlist_term` / `intel_watchlist_match`, plus `intel_watchlist_topic` only if adopted); §5 field-mapping rewritten off `intel_topic`/`intel_term` per the Q7 decision (§18.3).
   - Gate: unblocks Phase 2 merge.

6. **Single-sender invariant holds through the flip (no double-send).**
   - Owner/verifier: release owner.
   - Command: for the pilot tenant across the flip window, compare apps/api `notification_log` vs. intel-api `intel_notification_log` on the shared key `(alertId,userId,channel)`.
   - Threshold: **0** rows present in BOTH within any overlapping minute (i.e. exactly one owning service per tenant at all times).
   - Gate: unblocks widening the flip beyond the pilot tenant.

7. **Migrate-before-serve ordering enforced on every intel-api deploy.**
   - Owner/verifier: SRE.
   - Command: `deploy-dev.sh`-equivalent run log shows the `capiro-dev-intel-api-migrate` task reached STOPPED with exit code 0 BEFORE any `update-service capiro-dev-intel-api --force-new-deployment`; image is arm64 (`docker inspect` / task-def `runtimePlatform.cpuArchitecture=ARM64`).
   - Threshold: migrate exit 0 precedes service roll on **100%** of deploys; **0** amd64 images pushed to `:latest`.
   - Gate: any deploy that rolls serve before a clean migrate is rolled back.

8. **Post-cutover audit sweep (drift check).**
   - Owner/verifier: release owner, T+14d burn-in.
   - Command: re-run every V-item confirming command (V1–V8, V10–V12).
   - Threshold: **all** still pass — ALB rule 12 present, task-role Bedrock/SES perms intact, all intel-api task-defs in the §2.5 serve/migrate/oneoff set log to the intel-api log group, no lingering `IntelligenceChange` cross-service write, `intel_notification_log` unique key + advisory-lock guard present, no double-send observed.
   - Gate: unblocks Phase 9 (legacy `apps/api/src/tracker` decommission).

---

## Appendix A — Deployment Facts & Naming Registry (canonical — use names verbatim)

> Single source of truth for the tracker-into-intel-api plan. Every downstream writer MUST use these names/commands exactly. Where recon was silent or conflicting, the row says **UNVERIFIED — must confirm**.

---

## 1. Canonical Names

| Concept | DEV value | PROD value | Notes |
|---|---|---|---|
| AWS account | `967807252336` | `967807252336` | Same account, us-east-1 |
| Region | `us-east-1` | `us-east-1` | Hardcoded across scripts/configs |
| ECS cluster | `capiro-dev` | `capiro-prod-os-capiro` | Prod cluster is out-of-band, NOT in CDK |
| intel-api service | `capiro-dev-intel-api` | **UNVERIFIED — must confirm** (managed out-of-band; likely `capiro-prod-intel-api` / `capiro-prod-os-capiro-intel-api`) | Separate ECS service from api |
| apps/api service | `capiro-dev-api` | (prod not stated by recon) | |
| web service | `capiro-dev-web` | (prod not stated) | |
| ECR repo (intel-api) | `967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/intel-api` | `967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/prod-os-capiro/intel-api` | |
| ECR repo (api) | `967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/api` | (prod not stated) | |
| intel-api serve task-def family | `capiro-dev-intel-api` | `capiro-prod-intel-api` | command `['serve']`, port 4300 |
| intel-api migrate task-def family | `capiro-dev-intel-api-migrate` | `capiro-prod-intel-api-migrate` | command `['migrate']`, DB-only secrets |
| intel-api container name (overrides) | `intel-api` (serve) / `intel-api-migrate` (migrate) | same | Use exact container name in `containerOverrides[].name` |
| Task role ARN | `arn:aws:iam::967807252336:role/Capiro-dev-Compute-ApiTaskRole12FAD4A7-szq3QeeZJSCQ` | `arn:aws:iam::967807252336:role/Capiro-prod-os-capiro-Compute-ApiTaskRole12FAD4A7-5zhubZnOJ9nz` | intel-api SHARES the api task role |
| Execution role ARN | `arn:aws:iam::967807252336:role/Capiro-dev-Compute-ApiTaskDefExecutionRoleE6ABB053-YlEDKuUPHjLg` | `arn:aws:iam::967807252336:role/Capiro-prod-os-capiro-Com-ApiTaskDefExecutionRoleE6-S9U73lqKaGdt` | Inline policy: ECR pull + Secrets read (`infra/deploy/intel-api-execrole-inline-policy.json`) |
| Log group (intel-api) | `/capiro/dev/intel-api` (streams `intel-api`, `intel-api-migrate`) | `/capiro/prod-os-capiro` | resolved.json shows a WRONG `/capiro/dev/api` in one place — template uses `/capiro/dev/intel-api` |
| DB name | `capiro` | `capiro` | Shared Aurora cluster |
| intel-api port | `4300` (internal only, health `/health`, prefix `intel-api`) | `4300` | NOT exposed via ALB path prefix today |
| api port | `4000` (ALB `/api/*`) | | |
| Deepgram model | `nova-2` (env `DEEPGRAM_MODEL`) | `nova-2` | |
| CodeBuild project (intel-api) | `capiro-build-intel-api` (ARM_CONTAINER, BUILD_GENERAL1_LARGE, builds+pushes+forces redeploy) | `capiro-build-intel-api-prod` (builds+pushes only, no redeploy) | |

**ALB listener rules (all under host `app.capiro.ai`):**
| Priority | Path prefix | Target |
|---|---|---|
| 3 | `/api/*`, `/webhooks/*`, `/health` | apiTargetGroup (:4000) |
| 5 | marketing | marketing |
| 10 | `/workspace-api/*` | workspace |
| 15 | `/meri-api/*` | meriv2-orchestrator |
| 20 | host `app.capiro.ai`, `*.app.capiro.ai` (default) | web |
| — | `/intel-api/*` | **NO ALB rule exists today.** intel-api is internal-only on :4300. Exposing intel-api web calls requires ADDING a new listener rule (pick a free priority, suggest 12 or 17 — **UNVERIFIED, must confirm no collision**). PROD ALB `capiro-prod-alb` is manually managed/wedged; rules must be added via `aws elbv2 create-rule`, NOT `cdk deploy`. |

**arm64 build+push command (intel-api):**
```
docker buildx build --platform linux/arm64 \
  -f apps/intel-api/Dockerfile \
  -t 967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/intel-api:latest \
  -t 967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/intel-api:<GIT_SHA> \
  --push <REPO_ROOT>
```
(CI equivalent: `.github/workflows/intel-api-image.yml`, `docker/build-push-action@v6`, `platforms: linux/arm64`, triggers on `apps/intel-api/**`, `packages/meriv2-core/**`, `packages/shared/**`, `pnpm-lock.yaml`; OIDC assumes `AWS_DEV_GHA_ROLE_ARN`/`AWS_PROD_GHA_ROLE_ARN`.)

**one-off run-task command shape (intel-api migrate/enable-feature):**
```
aws ecs run-task --cluster capiro-dev --launch-type FARGATE \
  --task-definition capiro-dev-intel-api-migrate \
  --network-configuration 'awsvpcConfiguration={subnets=[...],securityGroups=[...],assignPublicIp=DISABLED}' \
  --overrides 'containerOverrides=[{name=intel-api-migrate,command=["enable-feature","<flag>","<tenantSlugOrId>"]}]'
```
(subnets/SGs: **UNVERIFIED — must confirm** from `scripts/deploy-ingestion-out-of-band.sh` run_job_wait template / resolved task-defs.)

**migrate-on-deploy step:** intel-api entrypoint mode `migrate` runs `prisma migrate deploy` (with auto-rollback of previously-failed migrations), then exits. NO seed step (apps/api migrate additionally runs `seed-workflows.ts`).

**apps/api deploy order (scripts/deploy-dev.sh):** (1) preflight (account/SHA/health) → (2) optional build+push arm64 (`--build`) → (3) run MIGRATE task, wait STOPPED + exit 0 → (4) `update-service <api-svc> --force-new-deployment`, wait stable → (5) `update-service <web-svc> --force-new-deployment`. Migrate ALWAYS before service roll; web is order-independent. Same ordering applies to intel-api: migrate task first, then force-new-deployment of `capiro-dev-intel-api`.

---

## 2. Env Vars & Secrets (intel-api)

**Injected today — env vars (serve):** `INTEL_PORT=4300`, `INTEL_BIND_HOST=0.0.0.0`, `INTEL_LOG_LEVEL` (debug), `DB_NAME=capiro`, `DEEPGRAM_MODEL=nova-2`, `DEEPGRAM_ENDPOINTING_MS=300`, `MAX_SESSION_MS=14400000`, `NODE_ENV=production` (prod), `CLERK_JWT_ISSUER=https://clerk.capiro.ai` (prod), `WEB_ORIGIN=https://app.prodos.capiro.ai` (prod), plus optional `CAPIRO_INTERNAL_TENANT_ID`, `MERIV2_ORCHESTRATOR_URL`, `MERIV2_TIMEOUT_MS` (default 8000).

**Injected today — secrets (serve, from Secrets Manager):** `DEEPGRAM_API_KEY` (`capiro/dev/intel-api/DEEPGRAM_API_KEY`), `HEARING_ENCRYPTION_KEY` (`capiro/dev/intel-api/HEARING_ENCRYPTION_KEY`), `CLERK_SECRET_KEY` (`capiro/dev/clerk/secret-key`), `DB_HOST`/`DB_PORT`/`DB_USER`/`DB_PASSWORD` (Aurora `capiro/dev/aurora/master` + `capiro/dev/aurora/app`). Prod namespace: `capiro/prod-os-capiro/*`. Migrate task gets ONLY DB_* secrets + `DB_NAME` env. Entrypoint composes `DATABASE_URL` (URL-encoded password, `sslmode=require`).

**To ADD for tracker port (exact names — confirm against tracker recon):**
- Bedrock/embeddings: `EMBEDDINGS_MODEL` (env, default `amazon.titan-embed-text-v2:0`). Bedrock uses AWS SDK creds from the TASK ROLE — **the task role must be granted `bedrock:InvokeModel` for Titan embed + (for summaries) Anthropic Claude on Bedrock. UNVERIFIED — must confirm task role has Bedrock perms.**
- SES (alerts): `AWS_REGION_DEFAULT`, `TRACKER_ALERT_EMAIL_FROM`. Task role needs `ses:SendEmail` — **UNVERIFIED — must confirm.**
- SNS/SMS (dormant): `TRACKER_SMS_PROVIDER` (`none`|`sns`), `TRACKER_SMS_ORIGINATION_NUMBER`.
- Pipeline gates: `TRACKER_ALERTS_ENABLED`, `TRACKER_SCAN_ACTION_HISTORY`, `TRACKER_ALERT_ENRICH`, `TRACKER_ALERT_SUMMARY`, `TRACKER_APP_BASE_URL`.
- Summaries: tenant-scoped Anthropic key resolved via `AiCredentialResolverService.resolveProviderByTenantId` — **UNVERIFIED whether that service/`ai_usage_events` table exists in intel-api; must confirm or port.**

---

## 3. Feature Flag Names

| Flag | Status | Usage |
|---|---|---|
| `hearing_watch` | EXISTS | `HEARING_WATCH_FEATURE = 'hearing_watch'`; `HearingWatchFeatureGuard`; frontend `useIntelFeatureEnabled('hearing_watch')` |
| `tracker_owner_intel` | NEW (to add) | Gate tracker ownership/data path in intel-api |
| `tracker_v2` | NEW (to add) | Gate unified Board\|Hearings\|Feed\|Configure frontend surface; `useIntelFeatureEnabled('tracker_v2')` |

Flag mechanics: `FeatureFlagService.isEnabled(feature, tenantId)` checks `intel_feature_flag` rows; ALWAYS-on for `CAPIRO_INTERNAL_TENANT_ID`. Guard returns **404** (not 403) when disabled. Enable per-tenant via one-off task: `enable-feature <flag> <tenantSlugOrId>`.

---

## 4. Cross-DB Tables (intel-api reads GLOBAL apps/api tables by ID)

All these are GLOBAL (no tenant_id, RLS-free) unless noted. intel-api references by string ID only — NO cross-schema FKs.

| Logical | @@map | Key columns intel-api reads | RLS |
|---|---|---|---|
| CongressBill | `congress_bill` | id (raw string e.g. `119-hr-1234`), congress, billType, billNumber, title, latestActionText (`@db.Text`), latestActionDate (`@db.Date`), policyArea, subjects (`String[]`), peCodes (`String[]`), committees (Json), url | none (GLOBAL) |
| CongressBillAction | `congress_bill_action` | id, billId (FK), date, text (`@db.Text`), type, chamber; index `[billId,date]` | none |
| CongressBillCommittee | `congress_bill_committee` | id, billId, committeeName, committeeCode, chamber | none |
| CongressBillSubject | `congress_bill_subject` | id, billId, name | none |
| BillText | `bill_text` | id (uuid), billId (`@unique`), sourceUrl, textContent (`@db.Text`), fetchedAt | none |
| StateBill | `state_bill` | id, state, session, identifier, title, subjects, latestActionText, latestActionDate, url | none |
| ContextEmbedding | `context_embeddings` | id (uuid), tenantId (`tenant_id`, NULLABLE uuid), clientId (`client_id`, nullable uuid), sourceType, sourceId, model, contentText (`@db.Text`), contentHash (SHA256), embedding (`Unsupported("vector")` = pgvector), metadata (Json), createdAt, updatedAt. Unique `[tenantId,sourceType,sourceId,model]` | **TENANT-AWARE**: RLS = `tenant_id IS NULL OR tenant_id = current_tenant_id` (shared globals readable) |
| Client | `clients` | id (uuid), tenantId, ldaClientIds (`Int[]`), issueCodes (`String[]`) | TENANT-SCOPED (RLS) |
| Tenant | `tenants` | (not read directly; tenantId comes from JWT context) | tenancy root |

**pgvector:** datasource `extensions = [pgvector(map: "vector"), pg_trgm, citext, uuidOssp(map: "uuid-ossp")]`. Column type in Prisma = `Unsupported("vector")`; raw SQL migrations declare `embedding vector`. `context_embeddings.embedding` is the pgvector column; model dim = 1024 for `amazon.titan-embed-text-v2:0`.

**RLS gotcha for a second service:** All tenant-scoped tables enforce Postgres RLS (PRIMARY isolation, not app-level). If intel-api connects under a DIFFERENT DB role, it is subject to the SAME policies and will be BLOCKED from other tenants' rows unless (a) same role as api, (b) granted access, or (c) RLS exempt. Policies read a session var (e.g. `SET app.current_tenant_id`). intel-api's tracker port must SET the tenant context per query (mirror apps/api `prisma.withTenant(tenantId, tx=>…)` for scoped reads and `prisma.withSystem(tx=>…)` for cross-tenant detection). **UNVERIFIED — must confirm intel-api's Prisma role/`withTenant`/`withSystem` availability and that its role can read `context_embeddings` NULL-tenant rows.**

---

## 5. Legacy → Unified Field Mapping

**ClientWatchlist (`client_watchlist`, 1 row/client, UNIQUE clientId) → intel_watchlist + intel_topic + intel_term**
- `issueAreas` (`String[]`, `@map issue_areas`) → `intel_watchlist.enabled_issue_areas` (carry array).
- `tags` (Json `@default("[]")`, array of `{ tag, issueArea?, synonyms[], relatedEntities[], riskTerms[], position?, priority }`): FOR EACH tag object → one `intel_topic` row `{client_id, tenant_id, name=tag.tag, issue_area=tag.issueArea, position, priority}`; FOR EACH `synonyms[]`/`relatedEntities[]`/`riskTerms[]` entry → one `intel_term` row `{topic_id, tenant_id, term_text, term_type ∈ synonym|entity|risk}`.
- Naming note: recon uses both `intel_topic` and (in the existing hearing migration) `intel_watchlist_term`. **The tracker port target tables `intel_topic`/`intel_term` are PROPOSED/new; the existing hearing watchlist tables are `intel_watchlist`, `intel_watchlist_term`, `intel_watchlist_match`. UNVERIFIED — must confirm whether tracker reuses `intel_watchlist_term` or introduces `intel_topic`/`intel_term`. Do not conflate.**

**AlertPreference (`alert_preference`, UNIQUE `[userId,clientId]`) → intel_alert_preference (1:1, no decomposition)**
- All columns carry over: id, tenantId, clientId, userId (Clerk id), triggers (`String[]`), materiality, emailEnabled, emailAddress, emailCadence, smsEnabled, smsPhone, smsPhoneVerified, smsCadence, quietHoursStart, quietHoursEnd, createdAt, updatedAt.

**Also to migrate (optional/audit):** TrackedBill (`tracked_bill`, UNIQUE `[clientId,billId]`; cols incl. note, source, lastSeenActionText/lastSeenActionDate/lastSeenAt) → `intel_tracked_bill`; TrackerFeedback (`tracker_feedback`, signal ∈ tracked|dismissed|marked_irrelevant|opened) → archive or `feedback_summary`; NotificationLog (`notification_log`, UNIQUE `[alertId,userId,channel]`) → `intel_notification_log` (or archive). Migrate MUST preserve the NotificationLog unique key for idempotency (see §6).

---

## 6. Files/Functions to Port (apps/api/src/tracker → intel-api) + exact logic

**Files (all under `apps/api/src/`):**
- `tracker/tracker.service.ts` — getWatchlist, putWatchlist, getSeedSuggestions, getAlertPrefs, putAlertPrefs, markPhoneVerified, trackBill, untrackBill, recordFeedback, getBoard, getSummary, getRecommendations, searchBills, semanticScores, keywordCandidateIds, fetchBillRows
- `tracker/tracker-change-detector.service.ts` — classifyChange, selectMaterialEvents, runDetectionCycle, readinessReport, billStatus, snapshot, emitIntelligenceChange
- `tracker/tracker-relevance.util.ts` — wholeWordHit, billHaystack, explainMatch (pure, no side effects)
- `tracker/tracker.types.ts` — ALERT_TRIGGERS / DEFAULT_TRIGGERS + ISSUE_AREAS re-export
- `tracker/notifications/tracker-notification.types.ts` — AlertSeverity, TrackerAlertEvent, SEVERITY_RANK, MATERIALITY_RANK, clearsMateriality
- `tracker/notifications/tracker-alert.service.ts` — fanOut, flushDigests, sendTestAlert, quiet-hours, alertId, claim, claimAndEnqueueDigest
- `tracker/notifications/tracker-email.service.ts` — TrackerEmailService (SESv2)
- `tracker/notifications/tracker-email.templates.ts` — renderAlertEmail, renderDigestEmail, renderTestEmail
- `tracker/sms/sms.service.ts` — SmsService, normalizeE164, maskPhone (dormant)
- `tracker/notifications/tracker-summary.service.ts` — TrackerSummaryService (+ ai_usage_events metering)
- `embeddings/embedder.ts` — embedText, vectorLiteral, normalize, EMBEDDING_MODEL
- Scripts: `scripts/detect-tracker-alerts.ts`, `scripts/emit-bill-alerts.ts`, `scripts/flush-tracker-digests.ts` (in intel-api these become entrypoint verbs, since intel-api is HTTP-only today with a single `bootstrap()` — must refactor to CommandFactory or add verb dispatch in entrypoint.sh).

**@capiro/shared deps (ONLY these):** `tracker.service.ts` imports `issueAreaForSector`, `normalizeIssueArea`, `ISSUE_AREAS`; `tracker.types.ts` re-exports `ISSUE_AREAS`. embeddings/notifications/sms have NO shared imports.

**Composite scoring (getRecommendations):**
`fit = max(0, min(1, 0.4×semantic + 0.3×textMatch + 0.15×exactEntity + 0.1×subjectMatch + 0.05×priorityBoost))`.
Floors/thresholds: `RECOMMENDATION_FLOOR = 0.45` (display), `EMBED_CANDIDATE_FLOOR = 0.3` (candidate cosine), `MIN_TERM_LEN = 3`.

**Semantic cosine SQL (semanticScores):**
```sql
SELECT ce.source_id, (1 - (ce.embedding <=> $1::vector))::float8 AS score
FROM context_embeddings ce
WHERE ce.source_type = 'bill' AND ce.model = $2
  AND ce.embedding IS NOT NULL
  AND (1 - (ce.embedding <=> $1::vector)) >= $3
ORDER BY ce.embedding <=> $1::vector
LIMIT 400;
```
`$1`=query vector literal (`vectorLiteral`), `$2`=EMBEDDING_MODEL, `$3`=EMBED_CANDIDATE_FLOOR (0.3).

**classifyChange (regex cascade, most-significant-first) → changeType / severity / triggerKey:**
| Regex signal | changeType | severity | triggerKey |
|---|---|---|---|
| law\|signed\|enacted | `bill_enacted` | critical | enactedFailed |
| (to president) | `bill_to_president` | critical | enactedFailed |
| failed\|rejected\|tabled\|veto | `bill_failed` | critical | enactedFailed |
| passed house\|passed senate | `bill_passed_chamber` | notable | floorVote |
| Rules Committee pattern | `bill_rule_reported` | notable | committeeVote |
| calendar\|scheduled | `bill_floor_scheduled` | notable | floorVote |
| reported\|committee agreed | `bill_reported` | notable | committeeVote |
| markup\|marked up | `bill_markup` | notable | committeeVote |
| amendment\|amended\|substitute | `bill_amendment` | notable | amendment |
| hearing | `bill_hearing` | info | hearing |
| (no match) | `null` | — | — |

**Triggers (DEFAULT_TRIGGERS):** newMatch, amendment, hearing, committeeVote, floorVote, enactedFailed, companion.
**Ranks:** SEVERITY_RANK {info:1, notable:2, critical:3}; MATERIALITY_RANK {low:1, medium:2, high:3}. `clearsMateriality(sev,mat) = SEVERITY_RANK[sev] >= MATERIALITY_RANK[mat]`.

**NotificationLog idempotency:** `alertId = 'tracker:' + clientId + ':' + billId + ':' + changeType`. `claim(...)` = INSERT ON CONFLICT unique `(alertId, userId, channel)`; P2002 → already claimed (return null/skip). `claimAndEnqueueDigest` wraps NotificationLog.create + alertDigestQueue.create in one tx.

**Cadence / quiet-hours:** Email cadence realtime\|daily\|weekly; SMS cadence realtime\|daily. `isWithinQuietHours(start,end)` — HH:MM, ET via Intl.DateTimeFormat, minutes-since-midnight, handles midnight wrap; suppresses SMS realtime. `flushDigests`: query alertDigestQueue where cadence∈(daily,weekly) AND flushed=false, take 5000, group by (tenantId,userId,channel), render+send, mark flushed regardless of send outcome (poison-row safety). SMS digest body = `Capiro: N tracked-bill update(s). {link}` (≤320 chars).

**Summary generation:** disabled unless `TRACKER_ALERT_SUMMARY` set; SUMMARY_TIMEOUT_MS=15000, SUMMARY_MAX_TOKENS=160, SUMMARY_MAX_CHARS=360; fail-safe → null (alert sends without summary); metered to `ai_usage_events` with usedTenantKey flag.

**Embeddings constants:** `EMBEDDING_MODEL = process.env.EMBEDDINGS_MODEL ?? 'amazon.titan-embed-text-v2:0'` (1024-dim, normalized); `normalize()` collapses whitespace + caps `MAX_INPUT_CHARS = 8000`; `vectorLiteral(number[]) → '[v0,…,v1023]'`; `embedText()` → Bedrock InvokeModelCommand.

**IntelligenceChange emit:** source `congress_bill`; deduped within 14 days by (source, changeType, detectedAt≥dedupeSince, relatedClientIds has, data.bill_id); title `{label}: {stage}`; data payload includes bill_id/stage/bill_title/action_date/url/tracker:true/why/matched_tags/summary. **Note: `IntelligenceChange` is an apps/api table — UNVERIFIED whether it exists in intel-api schema; must confirm or re-target.**

---

## 7. Hearing Pipeline Hooks

- **Deepgram open() call** (`apps/intel-api/src/hearing/deepgram-stream.manager.ts:72-80`): `deepgram.listen.live({ model, interim_results:true, diarize:true, punctuate:true, smart_format:true, endpointing:<ms>, encoding:'opus' })`. model = `DEEPGRAM_MODEL ?? 'nova-2'`; endpointing = `DEEPGRAM_ENDPOINTING_MS ?? '300'`. **Keyterm/keyword param NOT passed today.** To add (F1): extend constructor opts `{model?, endpointingMs?, keywords?: string[]}`, store `this.keywords`, add `keywords` field to the live() options; source keywords from HearingGateway sessionContext (client issues/bills/program elements). Reconnect: exp backoff, max 8 attempts, base 500ms (`500 * 2^(attempt-1)`).
- **meriv2-core tool registration contract:** `ToolRegistry.register(ToolDefinition<I,O>)` where `ToolDefinition = { name, description, inputSchema: Zod, handler: (input, ctx: MeriContext)=>Promise<O>, readOnly: boolean }`; `MeriContext = { tenantId, userId, clerkUserId, role, org? }`. Only invoke via `registry.invoke(name, input, ctx)` (validates schema, scoping, approval gate for write tools). Register in `apps/meriv2-orchestrator/src/meri/meri-registry.service.ts` (guarded by `ANTHROPIC_API_KEY`). Existing hearing tools: `tag_live_policy_mentions` (live, readOnly), `generate_post_hearing_summary` (brief synthesis, readOnly), both in `packages/meriv2-core/src/tools/hearing/`.
- **S3 client:** NONE exists in intel-api. All persistence is Postgres (transcriptSegment, keyQuote, liveActionItem, liveSummaryCard). Adding S3 (F3/F6) requires new `@aws-sdk/client-s3` dep + S3Client in HearingModule + new endpoint.
- **Brief endpoint:** `GET /hearings/{id}/brief` → `HearingBrief { sessionId, title, generatedAt(ISO), executiveSummary, keyMoments[{segmentId,timestampMs,speakerName?,text,issueTags[]}], relevantQuotes[], supporters[], opponents[], tone, risks[], opportunities[], recommendedNextSteps[], draftClientEmail{subject,body}, claimMap[{claimId,segmentId,timestampMs}], synthesisSource:'orchestrator'|'deterministic' }`. Encryption: AES-256-GCM via `HearingCryptoService` (`HEARING_ENCRYPTION_KEY`, fallback `NOTES_ENCRYPTION_KEY`; 12-byte IV; no rotation). Segment commit idempotent upsert on `(sessionId, startMs, endMs)`.

---

## 8. Frontend Hooks

- **Feature flag hook:** `useIntelFeatureEnabled(feature): boolean` at `apps/web/src/lib/intel-feature-flags.ts` — GET `/intel-api/feature-flags`, React Query 60s staleTime, **fails CLOSED** (returns `{}` on error). Use `useIntelFeatureEnabled('tracker_v2')` to gate the unified surface; `'hearing_watch'` gates hearings.
- **intel-api web client base URL:** same axios client as everything else — `useApi()` → `buildApiClient(getToken, actAsTenantSlug)` with `baseURL = config.apiBaseUrl` (`apps/web/src/env.ts`, from `window.__CAPIRO_CONFIG__.apiBaseUrl` or `VITE_API_BASE_URL`). Intel routes are RELATIVE `/intel-api/*` and resolve against baseURL. Adds `Authorization: Bearer` + optional `x-capiro-impersonate-tenant`.
- **Legacy tracker-api coexistence:** legacy tracker uses `/api/intelligence/clients/{clientId}/tracker/*` (board, recommendations, watchlist, track, untrack, alertPrefs, smsStart, testAlert; issue-areas at `/api/intelligence/issue-areas`), defined in `apps/web/src/pages/clients/tracker/tracker-api.ts` (`trackerPaths` / `trackerKeys`). New intel-api tracker endpoints use `/intel-api/*`. Both call the SAME `useApi()` client — they coexist; gate which one renders via `tracker_v2`.
- **Adding Tracker sub-tabs:** `TrackerTab.tsx` uses `useState<Panel>` with sessionStorage persistence (`PANEL_KEY`, try/catch for private mode), current Panel = `board|recs|config`. For v2 create `Panel = board|hearings|feed|configure`, same `loadPanel()`/`setPanel()` sessionStorage pattern (no URL params). Sub-nav via `SubNav` (`tracker-components.tsx`) with count badges; alt reference `SectionNav.tsx` in intelligence-v1. Gate at `ClientProfilePage.tsx` (TrackerTab instantiated ~line 513, deep-link `?tab=tracker`): if `tracker_v2` enabled render unified component else legacy TrackerTab.
- **Query keys:** include clientId in tuple for cache isolation, e.g. `board:(c)=>['tracker-board', c]`; hearings rescoped `['intel','hearings', clientId]`. HearingWatchPage currently workspace-scoped (`/intel-api/hearings`, `/intel-api/watchlists`, no clientId) — rescoping requires clientId prop + query-key + param + `enabled` gate.
- **UI conventions:** Ant Design (Button, Segmented, Dropdown, Modal, Form, Skeleton; use `App.useApp()` for Modal/message). Custom classes: `cp-*` (ClientProfile), `trk-*` (tracker), `cfg-*` (config); custom Icon in `tracker-icons.js`; styles in `apps/web/src/pages/clients/tracker/tracker.css`. Lazy-load large panels with `React.lazy(() => import(...).then(m=>({default:m.Export})))` + Suspense (App.tsx pattern).
