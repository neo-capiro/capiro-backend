# MeriV2 — Revert / Teardown Agent Prompt

> Hand this entire file to the agent that will undo the MeriV2 overnight run. It is self-contained.
> Hand it together with the three reference docs named in §1.

---

## 0. Mission

Safely **undo the MeriV2 overnight implementation run** and restore the repository **and** the
`capiro-dev` environment to their pre-run state — **without breaking, redeploying, or modifying any
existing surface** (`api`, `web`, `workspace`) and **without touching prod**.

The build was engineered to be reversible (strangler-fig + OFF feature flags + additive-only DB), so
the user-facing rollback is essentially instant (flip flags OFF). Your job is the complete cleanup:
remove the net-new code, the additive DB tables, the deployed AWS resources, and any ingested data —
leaving everything that existed before exactly as it was.

**Over-deletion is the primary risk of this task.** When in doubt, STOP and report rather than guess.

## 1. Read first (in this order)

1. `docs/plans/2026-06-30-meriv2-revert-plan.md` — the procedure you will execute. Authoritative.
2. `docs/plans/2026-06-30-meriv2-REPORT.md` and `…-meriv2-overnight-DECISIONS.md` (or
   `2026-06-30-meriv2-DECISIONS.md`) — the build run's record of **what was actually deployed,
   migrated, and merged**. This determines your mode (full teardown vs. fast path).
3. `docs/plans/2026-06-30-meriv2-PREFLIGHT.md` — the pre-run captures (main SHA, DB snapshot ID, ALB
   rule inventory, EventBridge inventory, service desired counts). These are your "known-good"
   baselines and your diff targets.
4. For context on what *could* exist: `docs/plans/2026-06-30-meriv2-technical-implementation-plan.md`
   (what the build creates) and `…-meriv2-agent-handoff-prompt.md` (the build kickoff).

If the build REPORT or PREFLIGHT file is missing, do not infer state — derive what you safely can
(see §3) and flag the gap in your report.

## 2. Environment

- Repo root: `C:\Users\neoma\capiro-meri`. Shell is git-bash on Windows; use POSIX for read-only
  commands; write files with native Windows paths.
- AWS: region/account per the live infra (confirm; live is `us-east-1`). Cluster `capiro-dev`.
  Naming: services `capiro-dev-<name>`, ECR `capiro/dev/<name>`, log groups `/capiro/dev/<name>`.
- Verify code health with `pnpm run typecheck && pnpm run lint && pnpm run test && pnpm run build`.

## 3. Determine mode, then execute the revert-plan steps

1. From the REPORT (and `git diff main...<branch>`), classify the run:
   - **Build-and-prove-only** — no `cdk deploy`, migrations on local docker DB only, no EventBridge
     rules, branch unmerged → execute **revert-plan §5 fast path** (delete branch, `db:down`, drop a
     pushed image if any). Then go to §5 report. You are mostly done.
   - **Deployed + dev-DB migrated** → execute **revert-plan §3 Steps 0–6 in order**.
2. Derive the exact teardown targets yourself (do not rely on names from this prompt):
   - Added DB tables: `git diff main...<branch> -- apps/api/prisma/schema.prisma` → the list of
     **added** `model` blocks. Build an explicit allowlist; you may DROP only tables on this list.
   - New migration folder names: `git diff main...<branch> --name-only -- apps/api/prisma/migrations`.
   - New AWS resources: diff `aws elbv2 describe-rules`, `aws events list-rules --name-prefix capiro-dev`,
     and the ECS service list against the PREFLIGHT captures.
3. Follow the revert-plan order: **(1) neutralize flags → (2) stop service/rules → (3) out-of-band
   AWS teardown → (4) DB revert → (5) code revert → (6) verify.** Capture before/after evidence at
   each step.

## 4. HARD GUARDRAILS (do not cross — STOP and report if a step seems to require it)

1. **Never run `cdk deploy Capiro-dev-Compute`** (or any `cdk deploy` to a shared stack). It can drop
   the out-of-band ALB `/webhooks/*` priority-15 rule (breaks Clerk new-user provisioning), replace
   the ACM cert, and shrink Aurora. Tear down orchestrator infra **out-of-band via AWS CLI**, deleting
   only the MeriV2 resources by ARN/name.
2. **Never `db:reset`, `prisma migrate reset`, or any whole-DB drop against `capiro-dev` or prod.**
   Remote DB revert = restore the PREFLIGHT snapshot, or surgically `DROP TABLE` **only** the
   branch-added tables on your allowlist. Never drop/alter/truncate a table that exists on `main`.
3. **Never modify or redeploy `capiro-dev-api`, `-web`, or `-workspace`** (beyond setting the
   `MERIV2_ENABLED=false` env on api, which is the documented kill-switch). Do not change their
   desired counts.
4. **Never touch `capiro-prod-*`.** Scope is `capiro-dev` only.
5. **Delete only the `meriv2-orchestrator` ECR repo;** never the shared `api`/`web`/`workspace` repos.
6. **Edit the ALB by single-rule ARN only** — delete just the `/meri-api/*` rule. Never bulk-edit the
   listener.
7. **No destructive shell beyond the explicit teardown commands** in the revert plan. No
   `git reset --hard`; undo accidents with `git restore`.
8. **If you cannot confidently classify a table/rule/resource as new (vs. pre-existing), or the
   PREFLIGHT snapshot is missing, or any of it was merged to `main` — STOP and report.** Do not guess.

## 5. Revert report (write LAST → `docs/plans/2026-06-30-meriv2-REVERT-REPORT.md`)

1. **TL;DR** — mode detected (fast path vs full), overall red/green, anything left behind and why.
2. **What was torn down** — per class (code/DB/AWS/data/flags): the exact resources/tables/rules
   removed, with the command run and the result.
3. **Evidence** — before/after for: ALB rule set (== PREFLIGHT, `/webhooks/*` intact), DB table list
   (new tables gone, existing intact), ECS services (existing healthy, orchestrator gone),
   EventBridge rules (== PREFLIGHT), `git diff main` clean, `typecheck/lint/test/build` green.
4. **Confirmation** — existing surfaces (`api`/`web`/`workspace`) were not behaviorally changed; all
   `meriv2.*` flags OFF; `MERIV2_ENABLED=false`; prod untouched.
5. **Anything not reverted** — e.g., DB snapshot restore deferred to a maintenance window; an ECR
   image left; the dead orphan rule decision — with the exact follow-up command.
6. **Decisions / deviations** — anything you judged (e.g., the build run had used `cdk deploy`, so you
   verified the cert/`/webhooks/*`/Aurora survived).

## 6. Operating rules

- Be idempotent: check existence before acting; re-running the revert must be safe.
- Restore user-facing behavior FIRST (Step 1 flags), then do cleanup — so even a partial revert
  leaves users on the known-good path.
- Prefer the snapshot restore over surgical drops when a snapshot exists.
- If a step is blocked (missing creds, missing snapshot, ambiguous resource), log it, complete every
  other independent step, and surface the blocker prominently in the report.

Begin by reading the four docs in §1, capturing the current AWS/DB/git state for your before/after
evidence, classifying the mode (§3), then executing the revert-plan steps in order.
