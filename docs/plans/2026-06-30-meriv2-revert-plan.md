# MeriV2 — Revert & Teardown Plan

Date: 2026-06-30
Owner: Neo Martinez (CTO)
Status: Ready for agent handoff
Pairs with: `2026-06-30-meriv2-technical-implementation-plan.md` (the build),
`2026-06-30-meriv2-agent-handoff-prompt.md` (build kickoff),
`2026-06-30-meriv2-revert-agent-prompt.md` (revert kickoff)

> Purpose: undo an overnight MeriV2 run and restore the repo **and** `capiro-dev` to their pre-run
> state, **without breaking any existing surface**. The build was designed to be reversible
> (strangler-fig + OFF flags + additive-only DB), so the *code* reverts trivially. This plan covers
> the parts a `git checkout main` does **not** undo: the dev database, deployed AWS resources, and
> any data the new jobs pulled in.

---

## 0. TL;DR

- **Code:** trivially reverted — it lives on a branch, was never merged, and existing surfaces run
  behind `meriv2.*` flags that ship OFF (SC0.2 means they're byte-for-byte unchanged). Delete the
  branch.
- **Everything else needs explicit, ordered teardown.** Three persistent classes: (1) additive DB
  tables on the shared `capiro-dev` Postgres, (2) AWS resources from deploying the orchestrator
  (Fargate service, ALB target group + `/meri-api/*` rule, EventBridge sync rules, ECR images),
  (3) data the new sync jobs ingested. All are **additive/isolated** — harmless if left, but they
  cost money and clutter until removed.
- **Two golden rules (see §4 Hazards):**
  1. **Never run a blind `cdk deploy Capiro-dev-Compute`** to build *or* tear down. Repo ops docs
     warn it can drop the out-of-band ALB `/webhooks/*` priority-15 rule (breaks Clerk new-user
     provisioning), replace the ACM cert, and shrink Aurora. Create and delete orchestrator infra
     **out-of-band** (AWS CLI), the same way the rest of the live infra is managed.
  2. **Never `db:reset` / `prisma migrate reset` against `capiro-dev` or prod** — it drops the whole
     database. Use a snapshot restore or a surgical `DROP TABLE` of *only the new tables*.
- **Fastest possible revert (if you used the safer overnight mode):** if the run stayed
  *build-and-prove-only* (no `cdk deploy`, migrations on the local docker DB only, branch unmerged),
  revert = delete the branch + `pnpm run db:down`. Done. See §5.

---

## 1. Pre-flight capture — DO THIS BEFORE the overnight run

These five captures are what make the revert clean and fast. Record them in
`docs/plans/2026-06-30-meriv2-PREFLIGHT.md`.

1. **Main SHA:** `git rev-parse main` (the known-good code state to return to).
2. **DB snapshot (the master rollback):** take a manual Aurora/RDS snapshot of the `capiro-dev`
   cluster and record its ID. This single artifact reverts every DB change in one restore.
   `aws rds create-db-cluster-snapshot --db-cluster-identifier <capiro-dev-cluster> --db-cluster-snapshot-identifier meriv2-preflight-2026-06-30`
3. **ALB rule inventory (protect the out-of-band rules):** record every listener rule + priority so
   you can confirm nothing existing was disturbed — especially the **priority-15 `/webhooks/*`** rule.
   `aws elbv2 describe-rules --listener-arn <DEV_HTTPS_LISTENER_ARN> > preflight-alb-rules.json`
4. **EventBridge inventory:** `aws events list-rules --name-prefix capiro-dev > preflight-rules.json`
   (so new sync rules are diffable).
5. **Service desired counts:** record current desired counts for `capiro-dev-api/web/workspace`
   (proof you never changed them).

If the snapshot in (2) exists, §3 Step 4 is a one-command restore and you can skip the surgical
path entirely.

---

## 2. Inventory — what the run creates, and how each reverts

| Class | Artifacts (from the build plan) | Persists past `git revert`? | Revert via |
|---|---|---|---|
| **Code (net-new)** | `packages/meriv2-core/`, `apps/meriv2-orchestrator/`, new `apps/api/scripts/sync-*.ts`, new `.github/workflows/{ci-pr,meriv2-evals,meriv2-orchestrator-image}.yml`, `infra/deploy/meriv2-ecr-pull-policy.json` | No | branch delete / `git revert` (§3 Step 5) |
| **Code (additive edits to existing files)** | flag-gated proxy in `apps/api/src/workspace-assistant/workspace-assistant.service.ts` + `apps/workspace/src/generation/generation.service.ts`; new keys in flags; **`apps/api/src/ingestion/sync-run.helper.ts` guard (shared!)**; `infra/cdk/lib/{config,compute-stack,ingestion-schedule}.ts`; `apps/api/scripts/entrypoint.sh`; `apps/api/prisma/schema.prisma` | No (but behavior-affecting) | `git revert` — **include the shared `sync-run.helper.ts` change** (§3 Step 5) |
| **Database (additive tables)** | Phase 0 `Claim`, `Evidence`, `ComplianceCheck`; Phase 2 vote/floor/rules/eCFR/CBO/JCT tables; Phase 3 `Issue`; Phase 5 (gated) `LiveHearingSession`/`TranscriptSegment`; + `_prisma_migrations` rows | **Yes** | snapshot restore (preferred) or surgical DROP (§3 Step 4) |
| **AWS infra (capiro-dev)** | ECR repo `capiro/dev/meriv2-orchestrator` + images; Fargate service `capiro-dev-meriv2-orchestrator` + task defs; ALB target group + `/meri-api/*` listener rule; new EventBridge sync rules; CloudWatch log groups `/capiro/dev/meriv2-orchestrator*` | **Yes** | out-of-band AWS CLI deletion (§3 Step 3) — **NOT `cdk deploy`** |
| **Ingested data** | rows in the new source tables + `sync_run` rows for new sources + any embeddings for opted-in new tables | **Yes** | dropped with the tables / snapshot restore (§3 Step 4) |
| **Feature flags** | `meriv2.*` keys in some tenant `settings_jsonb.clioFeatureFlags`; env `MERIV2_ENABLED` | **Yes (DB row)** | flip OFF / remove keys (§3 Step 1) — seconds |
| **Git tags** | `meriv2-phase*-complete` | Yes | `git tag -d` (§3 Step 5) |
| **External / third-party** | none — guardrails forbid email sends, live cutover, and Deepgram (Phase 5 gated) | — | verify none occurred (§3 Step 6) |

---

## 3. Revert procedure (safe order)

Work top to bottom. Each step is **idempotent** — check existence before acting; skip cleanly if the
artifact isn't there (e.g., the run never deployed). Capture before/after evidence at each step.
Region/account: confirm first (live infra is `us-east-1`; cluster `capiro-dev`).

### Step 0 — Read the actual inventory
Read the build run's `docs/plans/2026-06-30-meriv2-REPORT.md` and `…-DECISIONS.md`. They are the
record of what was *actually* deployed/migrated. Decide the mode:
- **Build-and-prove-only** (no `cdk deploy`, migrations local-only, branch unmerged) → jump to §5
  fast path.
- **Deployed + dev-DB migrated** → continue with Steps 1–6.
Also run `git diff main...<branch> -- apps/api/prisma/schema.prisma` to get the exact list of
**added** models (you'll need it in Step 4 fallback). If a model was *modified* rather than added,
flag it — that's a higher-care revert (the build guardrail forbids it; investigate before dropping).

### Step 1 — Neutralize immediately (restores user-facing behavior in seconds)
This is the real "rollback" for users; the rest is cleanup.
- Set the global kill-switch: `MERIV2_ENABLED=false` (env on `capiro-dev-api`; this ANDs out every
  tenant flag).
- Flip any tenant flags OFF: for each tenant with `settings_jsonb.clioFeatureFlags.meriv2.*` set,
  set them to `false` (or remove the keys).
- **Verify:** in-editor assistant + workspace generation behave exactly as on `main` (flag OFF =
  original in-process path, unchanged per SC0.2). Existing surfaces are now fully back to baseline
  regardless of what cleanup remains.

### Step 2 — Stop activity & cost
- If the service exists: `aws ecs update-service --cluster capiro-dev --service capiro-dev-meriv2-orchestrator --desired-count 0`
- Disable any new sync rules before deleting them:
  `aws events disable-rule --name <capiro-dev-sync-...>` for each new rule.
- **Verify:** orchestrator tasks drain to 0; new sync rules show `State=DISABLED`.

### Step 3 — Tear down orchestrator AWS resources OUT-OF-BAND (never `cdk deploy Compute`)
Delete only the MeriV2 additions, by name/ARN. Do **not** touch shared resources.
1. **Listener rule** — find and delete the `/meri-api/*` rule by its ARN; never bulk-edit the listener:
   `aws elbv2 describe-rules --listener-arn <DEV_HTTPS_LISTENER_ARN>` → locate the rule whose
   condition is `path-pattern /meri-api/*` → `aws elbv2 delete-rule --rule-arn <MERI_RULE_ARN>`.
   **Confirm the priority-15 `/webhooks/*` rule and the `/api/*`,`/workspace-api/*`,`/*` rules are
   untouched** (diff against `preflight-alb-rules.json`).
2. **Target group:** `aws elbv2 delete-target-group --target-group-arn <MERI_TG_ARN>` (after the rule
   is gone).
3. **ECS service + task defs:** `aws ecs delete-service --cluster capiro-dev --service capiro-dev-meriv2-orchestrator --force`; then deregister the `capiro-dev-meriv2-orchestrator*` task definitions.
4. **EventBridge sync rules:** for each new rule, remove targets then delete:
   `aws events remove-targets --rule <r> --ids <id>` → `aws events delete-rule --name <r>`.
5. **Log groups:** `aws logs delete-log-group --log-group-name /capiro/dev/meriv2-orchestrator`
   (and the `-migrate` variant if created).
6. **ECR repo (manual — it is imported, not CDK-managed):**
   `aws ecr delete-repository --repository-name capiro/dev/meriv2-orchestrator --force`.
   Do **not** delete the shared `capiro/dev/{api,web,workspace}` repos.
- **Verify:** `capiro-dev-api/web/workspace` services still `RUNNING` and healthy; ALB rule set ==
  preflight + nothing extra; no `meriv2-orchestrator` service/TG/repo/log group remains.

### Step 4 — Revert the database
**Preferred — snapshot restore (clean, total):** restore the `meriv2-preflight-2026-06-30` snapshot
(restore-and-swap, or point-in-time to just before the run). This wipes every new table, every
`_prisma_migrations` row, and all ingested data at once. Coordinate a brief `capiro-dev` DB window.
- **Verify:** `\dt` table list == pre-run; existing row counts intact; api boots and serves.

**Fallback — surgical drop (no snapshot, or want zero downtime):** using the added-models list from
Step 0:
- `DROP TABLE IF EXISTS "<NewTable>" CASCADE;` for **each added table only** (e.g. `claim`,
  `evidence`, `compliance_check`, `roll_call_vote`, `member_vote`, `issue`, … and Phase-5 tables if
  they exist). **Never drop a table that exists on `main`.**
- `DELETE FROM _prisma_migrations WHERE migration_name IN (<the new migration folder names>);`
- `DELETE FROM sync_run WHERE source IN ('sync-house-votes','sync-senate-votes', … new sources);`
- Remove embeddings for any new source opted into `embed-backfill` (delete rows by that source).
- **Never** `pnpm run db:reset` / `prisma migrate reset` against a remote DB (it drops everything).
- **Verify:** `git diff` of `schema.prisma` vs `main` is the only delta; DB now matches `main`'s
  schema; `prisma migrate status` shows no pending/extra.

**Local docker DB:** `pnpm run db:down` (or `pnpm run db:reset` to rebuild from `main`) — safe, it's
ephemeral.

### Step 5 — Revert the code
- **Unmerged branch (expected):** `git branch -D meriv2/phase0` (and `git push origin --delete` if it
  was pushed). Nothing on `main` ever changed — done.
- **If any of it was merged:** create a revert branch, `git revert <merge-or-commits>`, open a PR.
  **Ensure the shared `apps/api/src/ingestion/sync-run.helper.ts` guard is included in the revert**
  (it changes behavior for ~15 existing jobs).
- Delete tags you don't want to keep: `git tag -d meriv2-phase0-complete …`.
- **Verify:** `git diff main` clean for all MeriV2 paths; `pnpm run typecheck && pnpm run lint && pnpm run test && pnpm run build` green.

### Step 6 — Final verification checklist
- [ ] `capiro-dev-api`, `-web`, `-workspace` services healthy; desired counts == preflight.
- [ ] ALB rules == `preflight-alb-rules.json` (the `/webhooks/*` priority-15 rule present).
- [ ] No `meriv2-orchestrator` service / target group / listener rule / ECR repo / log group.
- [ ] EventBridge rules == preflight (no new `sync-*` rules; orphan `capiro-dev-emit-changes-daily`
      in the same state as preflight — if the run deleted it, decide whether to recreate; it was dead).
- [ ] DB schema == `main`; no `claim/evidence/compliance_check/...` tables; existing data intact.
- [ ] All `meriv2.*` flags OFF; `MERIV2_ENABLED=false`.
- [ ] No outbound emails / external actions occurred (spot-check `outreach_record` / `notification_log`
      for run-time rows; guardrails should have prevented any).
- [ ] `main` builds green.

---

## 4. Hazards & hard "do-nots"

1. **Do NOT run a blind `cdk deploy Capiro-dev-Compute`** — for build or teardown. Repo ops docs
   (`docs/ingestion-pipeline-analysis.md`, the 2026-06-01 ingestion plan, the sam-govid runbook)
   warn it can **drop the out-of-band `/webhooks/*` priority-15 ALB rule** (breaking Clerk → new-user
   provisioning), **replace the ACM cert**, and **shrink Aurora** (live runs backup-retention 35 /
   ACU 4 vs repo config). Manage orchestrator infra out-of-band, exactly as it should have been
   created. (If the build run used `cdk deploy`, note it as a DEVIATION and verify the `/webhooks/*`
   rule + cert + Aurora sizing survived.)
2. **Do NOT `db:reset` / `prisma migrate reset` against `capiro-dev` or prod** — it drops the entire
   database. Remote DB revert is snapshot restore or surgical `DROP TABLE` of new tables only.
3. **Do NOT touch `capiro-prod-*` anything.** Overnight scope is `capiro-dev` only; prod ALB is a
   manual `capiro-prod-alb` not in CFN. There is nothing to revert in prod.
4. **Do NOT drop, alter, or truncate any table that exists on `main`.** Only the branch-added tables.
5. **Do NOT delete the shared ECR repos** `capiro/dev/{api,web,workspace}` — only
   `capiro/dev/meriv2-orchestrator`.
6. **Do NOT bulk-modify the ALB listener.** Delete only the single `/meri-api/*` rule by its ARN.

---

## 5. Fast path — "build-and-prove-only" runs (the safest overnight mode)

If you ran the agent in the recommended low-blast mode — it **built and proved the image digest but
deferred the `cdk deploy`**, ran **migrations on the local docker DB only**, scheduled **no**
EventBridge rules, and left the **branch unmerged** — then there is essentially nothing persistent to
undo:

1. `git branch -D meriv2/phase0` (+ delete remote branch if pushed).
2. `pnpm run db:down` (local docker DB is ephemeral).
3. `aws ecr batch-delete-image` / `aws ecr delete-repository --force` **only if** an image was pushed
   to a `meriv2-orchestrator` repo during the digest-proof.
4. Verify `main` is the only state; no AWS resources created.

This is why the build kickoff offers the build-and-prove-only mode: it makes "I changed my mind in
the morning" a 30-second operation. The full teardown (§3) is only needed if you let the run deploy
to `capiro-dev` and migrate its DB.

---

## 6. Effort & involvement

- **Step 1 (neutralize):** seconds — restores all user-facing behavior. Anyone with flag access.
- **Steps 2–3 (AWS teardown):** ~15–30 min, AWS CLI, someone with `capiro-dev` infra creds.
- **Step 4 (DB):** snapshot restore ~10–20 min + brief dev DB window; surgical drop ~10 min.
- **Step 5 (code):** seconds (branch delete) to ~30 min (revert PR if merged).
- **Total:** well under an hour for a fully-deployed run; seconds-to-minutes for build-and-prove-only.

*Revert kickoff prompt: `2026-06-30-meriv2-revert-agent-prompt.md`.*
