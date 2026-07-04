# Radar Cutover — Rollout Record & Operator Runbook

All-tenant cutover of Bill Tracker + Hearing Watch onto intel-api, then the Radar
surface on top. Extends `docs/plans/capiro-intelligence-unification.md` (Phase 8+)
and `docs/plans/intel-tracker-cutover-runbook.md` (per-tenant mechanics) to the
**all-tenant, direct-ship** variant Ninja approved 2026-07-04. Single-sender
invariant preserved throughout: exactly one system delivers alerts per tenant.

Product plan (phases P0–P12 + success criteria): Radar Build & Cutover Plan
artifact (2026-07-04). This file records live evidence + the exact commands.

## Verified live state (2026-07-04, account 967807252336 / us-east-1)

| Item | Value | Evidence |
|---|---|---|
| User-facing env | ECS cluster `capiro-dev` behind `capiro-prod-alb` (app.capiro.ai) | DNS + rules check 2026-07-04 |
| `/intel-api/*` ALB rule | **priority 14** → TG `capiro-dev-intelapi-albtg` (out-of-band; a `cdk deploy` must NOT drop it) | describe-rules |
| intel-api service | `capiro-dev-intel-api` ACTIVE 1/1, task-def rev 5, target healthy | describe-services / target-health |
| e2e routing | `GET app.capiro.ai/intel-api/feature-flags` → 401 from Nest (reaches the service) | probe |
| ALB idle timeout | **180s — MUST be raised to ≥14400s before live hearings GA** (plan SC-10) | describe-load-balancer-attributes |
| SES production access | **GRANTED** (`ProductionAccessEnabled: true`, 50k/day) | sesv2 get-account |
| Watchlist sync schedule | EventBridge `capiro-dev-sync-watchlists` **ENABLED, every 6h** (out-of-band, not in CDK) | list-rules |
| Legacy alert delivery | EventBridge `capiro-dev-detect-tracker-alerts` every 6h; digests daily 12:30 / weekly Mon 12:45 UTC | list-rules |
| Intel shadow detection | EventBridge `capiro-dev-detect-bill-changes` daily 10:00 UTC (no delivery) | list-rules |
| Alert parity (decisions) | EventBridge `capiro-dev-parity-report` daily 13:30 UTC | list-rules |
| Second env | `capiro-prod-os-capiro` cluster live (api 2/2, web 2/2, intel-api 1/1) at app.prodos.capiro.ai, own Aurora — **NOT in scope for this cutover** (users are on capiro-dev) | list/describe |
| One-off task network | subnets `subnet-0e38bd390f8961fef,subnet-0920665f91c905f01,subnet-06db79cd21239de19`, SG `sg-01def4e5c0fe44d4a`, `assignPublicIp=DISABLED` | intel-api service netcfg |
| Verb runner | task-def `capiro-dev-intel-api-enableflag`, container `intel-api-enableflag`, logs → group `/capiro/dev/api` prefix `intel-api-enableflag` (do NOT "fix" the group — exec-role scope) | taskdefs + plan §4059 |

## New cutover verbs (this branch)

| Verb | Effect | Safety |
|---|---|---|
| `task snapshot-legacy` | Chunked JSON dump of `client_watchlist`/`tracked_bill`/`alert_preference` to logs + md5 per table. Contact PII (email/phone) REDACTED in the dump; md5 covers full rows | READ-ONLY |
| `task parity-data [tenant]` | Field-level diff of the 3 migrated stores; PASS = legacyOnly=0 AND mismatched=0; watermark drift + intel-only reported, non-gating; non-zero exit on fail. Alert prefs compared in the CLERK id space (see translation note) | READ-ONLY |
| `task reconcile-intel-tracker [--apply=true --created-before=<ISO>] [--force=true]` | Deletes stale intel-only rows for UNFLIPPED tenants only. **PRE-FIRST-FLIP TOOL**: refuses `--apply` if any disabled `tracker_owner_intel` row exists (rollback evidence) unless forced; `--apply` requires an explicit `--created-before` cutoff (rows at/after it are never deleted — set it before the first flip). Dry-run default | intel_* only (D2) |
| `task enable-feature-all <flag>` / `disable-feature-all <flag>` | Flip a flag for EVERY tenant (upsert-idempotent) | reversible |

Run shape (canonical):

```
aws ecs run-task --cluster capiro-dev --launch-type FARGATE \
  --task-definition capiro-dev-intel-api-enableflag \
  --network-configuration 'awsvpcConfiguration={subnets=[subnet-0e38bd390f8961fef,subnet-0920665f91c905f01,subnet-06db79cd21239de19],securityGroups=[sg-01def4e5c0fe44d4a],assignPublicIp=DISABLED}' \
  --overrides '{"containerOverrides":[{"name":"intel-api-enableflag","command":["task","<verb>","<args>"]}]}'
```

## Execution order (each gate blocks the next)

0. **PR-1 (backend)** lands on main → `intel-api-image.yml` builds arm64 →
   run `capiro-dev-intel-api-migrate` (new `intel_sms_verification` migration)
   → `update-service --force-new-deployment` on `capiro-dev-intel-api`.
1. `task snapshot-legacy` → record md5s here. Tag rollback point (git SHA + task-def revs).
2. `task sync-watchlists-from-legacy` + `task backfill-tracked-bills` + `task backfill-alert-prefs` (all tenants).
3. `task parity-data` → **must PASS**. Re-run backfills → all `skipped` (idempotency proof).
4. `task reconcile-intel-tracker` (dry-run) → review → `--apply=true` if only expected staleness.
5. **Kill the landmine**: `aws events disable-rule --name capiro-dev-sync-watchlists`.
   Verify a manual intel-api watchlist edit survives past the next former tick.
6. **Flip** (single change window):
   a. Legacy guard: add `TRACKER_SINGLE_SENDER_GUARD=on` to the apps/api serve +
      detect-tracker-alerts task-defs (new revisions; repoint the EventBridge
      target; roll `capiro-dev-api`).
   b. intel-api serve task-def: add `TRACKER_ALERTS_ENABLED=on`,
      `TRACKER_ALERT_EMAIL_FROM=alerts@capiro.ai`, `TRACKER_APP_BASE_URL=https://app.capiro.ai`
      (+ verify SES send IAM on the shared task role) → roll.
   b2. **Freshness re-copy (review finding — do NOT skip):** legacy edits made
      between step 2 and now would otherwise be lost at the flip. Re-run
      `sync-watchlists-from-legacy` + `backfill-tracked-bills` +
      `backfill-alert-prefs` + `parity-data` (all idempotent, minutes). Safe at
      any point BEFORE 6c: the copies skip intel-owned tenants, so they can
      never clobber a flipped tenant. Do 6c immediately after PASS.
   c. `task enable-feature-all tracker_owner_intel` → `task enable-feature-all tracker_v2`
      → `task enable-feature-all hearing_watch`.
   d. Schedules: bump `capiro-dev-detect-bill-changes` to `cron(0 0/6 * * ? *)`;
      create intel `flush-digests` daily/weekly rules; leave legacy digest rules
      (guard-suppressed) until P12.

   **User-id translation (CRITICAL, baked into the verbs):** legacy
   `alert_preference.user_id` is the internal `users.id` uuid; intel-api keys
   prefs by the Clerk subject. `backfill-alert-prefs` translates via
   `users.clerk_user_id` (rows with no clerk id are skipped + counted), and
   `parity-data` compares in the translated space. Never hand-copy pref rows
   without this translation.
7. **Verify**: legacy detector logs `suppressedOwned=N`; `intel_notification_log`
   gains `sent` rows; legacy `notification_log` gains none; browser QA of the v2
   tab + feed on a real tenant.
8. **Bake** with alarms subscribed → then P12 decommission (legacy tracker module,
   sync code, flag scaffolding — complete site list in the guards recon).

Rollback at any point: `task disable-feature-all tracker_owner_intel` (+`tracker_v2`)
→ legacy resumes delivery instantly; data untouched (legacy tables were never modified).

## Snapshot record (fill at step 1)

| Table | Rows | md5 | Task id / log stream |
|---|---|---|---|
| client_watchlist | — | — | — |
| tracked_bill | — | — | — |
| alert_preference | — | — | — |
