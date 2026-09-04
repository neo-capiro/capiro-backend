# Fix plan — P08 atomic review/pursuit task action: F-1 (duplicate Engagement tasks under concurrency)

**Status:** PLANNED — nothing in this document has been implemented. No source file, test file,
migration, or schema file has been modified. This is a plan for a future engineer/agent to execute.

**Scope:** Exactly one bug — the proven race that lets a double-clicked "Pursue" (or a network
retry, or a replayed mutation) create two `engagement_tasks` rows instead of one. Two closely
related but distinct items are deliberately **not** fixed here — the P08 date/owner drift on the
reuse path (F-2) and a cross-intent race in `applyActionDecision` this plan surfaced but was not
asked to fix — see [§11](#11-explicitly-out-of-scope--adjacent-findings) for both, and why.

**Verified against:** `origin/main` at `3e2a691baa2a94802047ded1c3fe7a5dfd4e366c` (re-fetched twice
during this session, unchanged; merge PR #955, "directory: give vNext member profiles the same
depth as canonical", 2026-08-14 09:06:06 -0400). Confirmed by
`git log d800dcfde5..origin/main --oneline -- apps/api/src/funding-opportunities/funding-opportunity-actions.service.ts apps/api/src/funding-opportunities/funding-opportunities.service.ts apps/api/src/funding-opportunities/funding-opportunity-actions.spec.ts apps/api/prisma/schema.prisma apps/api/prisma/migrations/ apps/api/src/engagement/engagement.service.ts apps/api/src/common/prisma-exception.filter.ts apps/api/src/prisma/prisma.service.ts .github/workflows/funding-opportunities-ci.yml apps/api/package.json`
that **zero commits touched any relevant path** between the independent review's pin (`d800dcfde5`,
2026-08-13) and current tip (7 unrelated commits landed in between) — so every quote and every line
number below is simultaneously "what `band-a-p07-p08.md` reviewed" and "what is on main today."
The bug is confirmed still present; see [§1](#1-bug-confirmation-at-current-originmain).

**Method:** Read-only. All source was read via `git show origin/main:<path>` against
`C:\dev\capirov2`; that worktree's working tree (unrelated uncommitted work on
`agent/fo-p36-outcome-capture`) was never touched. This file was written directly into
`C:\dev\capiro-fo-ga-review-wt` (branch `docs/fo-ga-independent-review`), the only change this
session made anywhere. No migration was applied, no code was edited, nothing was staged, committed,
or pushed. No live database (capiro-dev or otherwise) was queried — see
[§10.3](#103-pre-flight-duplicate-check-not-yet-run-against-capiro-dev) for why, and for the exact
query to run before this ships.

**Source of the finding:** `docs/plans/funding-opportunities-makegov-v1/independent-review/band-a-p07-p08.md`
§3, finding **F-1** (High) — one of the two grounds for that document's
`BAND_A_P07_P08_REJECTED` verdict — cross-indexed in `MASTER-FINDINGS-QUEUE.md` as **P1-3**
("P08's idempotency guarantee is false under concurrency — reproduced twice against real
Postgres"). Note for anyone tracking severity tiers: this is **P1** (High), not one of the
program's 13 **P0** findings (those are a different, higher tier — webhook data loss, missing
alarms, the `cdk deploy Capiro-dev-Compute` blast radius, and the canary findings; P08's race is
serious but is not among them).

---

## TL;DR

- The bug is real and still on `origin/main` today: `FundingOpportunityActionsService.act()` does a
  `findFirst`-then-`create` on `engagement_tasks` inside a plain READ COMMITTED transaction, and
  **no unique index exists** on the columns that check reads. Proven by the review with real
  Postgres: 2 rows from 2 concurrent calls, 2 rows from 8 parallel calls with no injected delay.
  See [§1](#1-bug-confirmation-at-current-originmain)–[§2](#2-the-exact-current-mechanism-line-by-line).
- **This program already has a working fix for this exact problem, on a sibling table.**
  `client_funding_opportunity`'s `decide()` (and `setWorkflowStatus()`, and `patchWorkflow()`) use a
  partial unique index plus a catch of Prisma `P2002` that re-reads and updates instead of erroring.
  This plan is that same pattern, applied to `engagement_tasks`, not a new one.
  See [§3](#3-the-working-precedent-p07s-decision-persistence-race-resolution).
- **Migration:** one partial unique index,
  `engagement_tasks_tenant_source_uniq ON engagement_tasks (tenant_id, source_type, source_id) WHERE source_type IS NOT NULL AND source_id IS NOT NULL`,
  guarded by a pre-flight duplicate check that `RAISE EXCEPTION`s instead of letting a bare
  constraint violation kill a half-applied deploy. Exact SQL in [§5](#5-the-migration-exact-sql).
- **Code:** wrap `act()`'s transaction in a `try`/`catch`, exactly like `decide()`'s own catch block;
  on a caught `P2002`, re-read the row the winner created and return it with `reused: true` instead
  of letting the error reach the caller as a raw 500 (confirmed: `PrismaClientExceptionFilter` does
  **not** special-case `P2002`, so today, post-migration-only, the loser of the race would get an
  unhandled 500 — the code change is not optional polish, it is required for the migration to be
  safe to ship). Exact diff in [§6](#6-the-code-change-exact-before--after).
- **Test:** the existing suite is 100% mock-backed and cannot catch this (confirmed: `makeFake()`
  never opens a real transaction or hits a real unique index). A new script,
  `apps/api/scripts/test-funding-opportunity-action-concurrency.ts`, fires 8 genuinely concurrent
  `act()` calls at a real, migrated, disposable Postgres and asserts exactly one row survives in
  each of two tables. Wired into `funding-opportunities-ci.yml` so it runs on every PR, not just
  manually. See [§8](#8-test-plan--the-real-postgres-concurrency-proof)–[§9](#9-ci-wiring).
- **Safety:** additive-only migration, RLS untouched (already correct), forward-only, no data loss.
  The one real risk is a duplicate already sitting in a target database, which would make
  `CREATE UNIQUE INDEX` fail outright — guarded with a pre-check, and a read-only query to run
  against capiro-dev before deploying there is given in [§10](#10-migration-safety-checklist).

---

## 1. Bug confirmation at current `origin/main`

`apps/api/src/funding-opportunities/funding-opportunity-actions.service.ts`, current lines 145–166,
inside `act()` (method starts line 90, `Promise<OpportunityActionResult>`):

```ts
    return this.prisma.withTenant(tenantId, async (tx) => {
      const existingTask = await tx.engagementTask.findFirst({
        where: { tenantId, sourceType: FUNDING_OPPORTUNITY_TASK_SOURCE, sourceId },
        select: { id: true, title: true, ownerUserId: true, dueDate: true },
      });

      const task =
        existingTask ??
        (await tx.engagementTask.create({
          data: {
            tenantId,
            clientId,
            title,
            description: description || null,
            ownerUserId: input.ownerUserId ?? null,
            dueDate,
            sourceType: FUNDING_OPPORTUNITY_TASK_SOURCE,
            sourceId,
            createdByUserId: input.actorUserId,
          },
          select: { id: true, title: true, ownerUserId: true, dueDate: true },
        }));
```

The file's own docblock (lines 30–39) states the guarantee this is supposed to provide:

> "A double-clicked button, a retried request and a replayed mutation all land on the same key and
> get the SAME task back."

Independently re-derived (not merely trusted from the review) by reading the schema directly.
`apps/api/prisma/schema.prisma`, model `EngagementTask` (lines 1176–1203):

```prisma
model EngagementTask {
  id              String               @id @default(uuid()) @db.Uuid
  tenantId        String               @map("tenant_id") @db.Uuid
  ...
  sourceType      String?              @map("source_type")
  sourceId        String?              @map("source_id")
  ...
  @@index([tenantId, clientId, status], map: "engagement_tasks_tenant_client_status_idx")
  @@index([tenantId, dueDate], map: "engagement_tasks_tenant_due_idx")
  @@map("engagement_tasks")
}
```

Two plain (non-unique) indexes, neither covering `source_type`/`source_id`. Confirmed against the
raw table DDL too — `engagement_tasks` has exactly one migration touching it in the entire history,
`20260503020000_engagement_manager_core` (line 396), which creates
`engagement_tasks_pkey`, `engagement_tasks_tenant_client_status_idx`, and
`engagement_tasks_tenant_due_idx` and nothing else. `git grep`-verified: no later migration among
all 264 in the tree touches `engagement_tasks` at all. **There is no unique constraint on this
table beyond the primary key, on `origin/main`, today.**

`withTenant` (`apps/api/src/prisma/prisma.service.ts` line 145) opens a real Prisma interactive
transaction with no `isolationLevel` override, i.e. Postgres's default READ COMMITTED. Two
concurrent transactions both running the `findFirst` above before either commits both observe no
row, and both proceed to `create`. Nothing at the database layer stops them.

This is exactly what the review proved by execution (`band-a-p07-p08.md` §3.3), against a real
263-migration replay of `pgvector/pgvector:pg16` with real `@prisma/client` 5.22.0 interactive
transactions issuing the exact statement pair `act()` issues:

```
PASS  A. Sequential retry returns the same task and creates only one row
FAIL  B. Concurrent double-click creates exactly ONE task
      rows=2 (expected 1), rejections=0  <-- DUPLICATE TASKS
FAIL  C. 8 genuinely parallel identical requests create exactly ONE task
      rows=2 (expected 1), rejections=0  <-- duplicates arose with NO artificial delay
```

Case C used no barrier, no injected sleep, no contrivance — eight ordinary parallel calls. The
review also attempted to build a unique index on `(tenant_id, source_type, source_id)` directly
against the duplicated rows case B had just produced, and Postgres correctly refused
(`Code: 23505 ... is duplicated`) — independent confirmation both that no such index exists today
and that it is the correct remedy once duplicates are cleared. With the index pre-applied to a
clean table, the same race produced exactly one row plus one clean `P2002` on the loser.

**Verdict: the bug is real, reproducible, and unchanged on current `origin/main`.**

---

## 2. The exact current mechanism, line by line

Table: `engagement_tasks` (Prisma model `EngagementTask`, `@capiro/api`'s schema only — confirmed
no other package's `schema.prisma` among `apps/api-strategy`, `apps/intel-api`,
`apps/onboard-api`, `apps/workspace` defines this model, so this table has exactly one owner).

Columns that matter: `tenant_id UUID NOT NULL`, `source_type TEXT` (nullable), `source_id TEXT`
(nullable). Both nullable because they are **optional** — the generic "create a task" path,
`EngagementService.createTask` (`apps/api/src/engagement/engagement.service.ts` line 5750), never
sets either column:

```ts
  createTask(ctx: TenantContext, input: CreateTaskInput) {
    return this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.engagementTask.create({
        data: {
          tenantId: ctx.tenantId,
          clientId: input.clientId ?? null,
          ...
          // no sourceType, no sourceId
        },
      }),
    );
  }
```

`FundingOpportunityActionsService` (`funding-opportunity-actions.service.ts`) is the **only** writer
that ever sets these two columns, and it derives `sourceId` deterministically (never
caller-supplied) via `taskSourceId` (line ~72):

```ts
  static taskSourceId(source: OpportunitySource, sourceRecordId: string, intent: OpportunityActionIntent): string {
    return `${source}:${sourceRecordId}:${intent}`;
  }
```

with `sourceType` always the constant `FUNDING_OPPORTUNITY_TASK_SOURCE = 'funding_opportunity'`
(line 45). So the identity tuple the code itself already treats as "this is the same request" is
exactly three columns: `tenantId`, `sourceType`, `sourceId` — **not** `clientId` (the `findFirst`
at line 147 does not filter on it either; see [§8](#8-what-this-fix-deliberately-does-not-touch)
in the sibling doc-note below for why this migration matches that scope exactly rather than
widening it).

**The race, mechanically:** two callers issue `act()` for the same `(source, sourceRecordId,
intent)` at the same time (a double-click, or a client retry after a dropped response). Both open a
`withTenant` transaction. Both run the `findFirst` at line 146 before either has committed, both see
`null`, both fall through the `??` to `tx.engagementTask.create(...)` at line 153. Both inserts
succeed — there is nothing in the schema to stop a second row with the identical
`(tenantId, sourceType, sourceId)` triple. Both transactions then call
`this.opportunities.applyActionDecision(tx, ...)` (line 170), which does its **own**
find-then-create/update against `client_funding_opportunity` — but that table already has a
partial unique index covering this case (see [§3](#3-the-working-precedent-p07s-decision-persistence-race-resolution)),
so in the common case where a decision row does not yet exist for this opportunity, one of the two
`applyActionDecision` calls will find a row already committed by the other and take the `update`
branch instead of `create`, which succeeds without conflict (concurrent `UPDATE`s to the same row
serialize via an ordinary row lock — no unique index needed to prevent duplication there). **Both
outer transactions therefore commit cleanly.** Result: two real, fully-committed `engagement_tasks`
rows, and (typically) one `client_funding_opportunity` row — exactly the asymmetry the review's
transcript shows, and exactly why the bug is in `engagement_tasks` specifically, not in the
decision table.

---

## 3. The working precedent: P07's decision-persistence race resolution

`client_funding_opportunity` has faced this identical shape of problem — a workflow row that may or
may not exist yet, written by concurrent first actions — in three places in
`apps/api/src/funding-opportunities/funding-opportunities.service.ts`, and all three use the same
pattern. `decide()` (line 487, the human-decision write path — the one the task named "P07"), is
the clearest template:

```ts
// funding-opportunities.service.ts, current lines 539–619 (excerpted)
    const write = async () =>
      this.prisma.withTenant(tenantId, async (tx) => {
        const existing = await this.findWorkflowRow(tx, clientId, source, sourceRecordId);
        const saved = existing
          ? await tx.clientFundingOpportunity.update({ where: { id: existing.id }, data: { ...data, ... } })
          : await tx.clientFundingOpportunity.create({ data: { tenantId, clientId, source, ...data } });
        await this.writeWorkflowAudit(tx, { ... });
        return this.shapeDecision(saved)!;
      });

    try {
      return await write();
    } catch (error) {
      // The partial unique indexes are the concurrency backstop: two simultaneous
      // first decisions can both observe no row, and the loser must retry as an
      // update rather than leak a P2002.
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
        throw error;
      }
      return this.prisma.withTenant(tenantId, async (tx) => {
        const existing = await this.findWorkflowRow(tx, clientId, source, sourceRecordId);
        if (!existing) throw error;
        const saved = await tx.clientFundingOpportunity.update({ where: { id: existing.id }, data: { ...decisionData, ... } });
        return this.shapeDecision(saved)!;
      });
    }
```

(`setWorkflowStatus`, line 351, and `patchWorkflow`, line 804, repeat the identical
try/`write()`/catch-`P2002`/re-find/update shape. `import { Prisma } from '@prisma/client';` is
already at line 2 of this file, which is how `Prisma.PrismaClientKnownRequestError` is available.)

The database half this code leans on: `client_funding_opportunity` has had a **partial unique
index** since it was created — `20260810010000_funding_opportunities`, lines 75–81:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS "client_funding_opportunity_grant_uniq"
    ON "client_funding_opportunity" ("tenant_id", "client_id", "grant_opportunity_id")
    WHERE "grant_opportunity_id" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "client_funding_opportunity_sam_uniq"
    ON "client_funding_opportunity" ("tenant_id", "client_id", "sam_opportunity_id")
    WHERE "sam_opportunity_id" IS NOT NULL;
```

plus a third, generic one added later by `20260820010000_funding_opportunity_generic_source`
(lines 180–182), same shape:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS "client_funding_opportunity_generic_uniq"
    ON "client_funding_opportunity" ("tenant_id", "client_id", "source", "source_record_key")
    WHERE "source_record_key" IS NOT NULL;
```

The migration's own comment states the reasoning this fix plan is reusing verbatim:

> "PARTIAL unique indexes, which is the whole point: Postgres treats NULLs as distinct, so a single
> unique index ... would admit unlimited duplicate ... rows ... Prisma cannot express a partial
> unique index, so it lives only here — and no writer may use `upsert` against these keys (Prisma
> cannot target them); the writers do find-then-create-or-update."

**This is the exact remedy this plan applies to `engagement_tasks`.** Nothing new is being
invented: same index shape (partial, `WHERE col IS NOT NULL`), same code shape (try the plain
find-then-create, catch `P2002`, re-find, recover), same reason for both (Prisma cannot express a
partial unique constraint in `schema.prisma`, so the index lives only in the migration and the
service layer must handle the conflict Prisma's own type-safe `upsert` cannot target).

**Important distinction from `decide()`'s catch block, stated explicitly so the difference isn't
mistaken for an inconsistency:** `decide()`'s recovery *writes* — the loser of a first-decision
race still needs to apply *its own* new decision on top of the row the winner just created. `act()`'s
recovery only *reads* — see [§6.2](#62-why-the-recovery-path-only-reads-not-writes) for why that is
correct, not a shortcut.

---

## 4. Fix design

Two changes, shipped together (see [§10.1](#101-the-migration-and-the-code-change-must-ship-in-the-same-deploy)
for why together, not either alone):

1. **Migration:** one partial unique index on `engagement_tasks`, matching the identity tuple the
   code already uses (`tenant_id, source_type, source_id`), guarded by a pre-flight duplicate check.
2. **Code:** `act()`'s transaction wrapped in try/catch, mirroring `decide()`'s shape exactly; on a
   caught `P2002`, re-read the row that won the race and return it as `reused: true`.

Nothing about the transaction boundary, the validation order, or `applyActionDecision`'s contract
changes. The atomicity property the review already confirmed correct (`band-a-p07-p08.md` §2 — one
transaction, real rollback, no hidden fallback to `this.prisma`) is untouched by this fix.

---

## 5. The migration, exact SQL

New directory: `apps/api/prisma/migrations/20261120050000_engagement_task_action_source_uniq/migration.sql`
(the latest migration on `origin/main` is `20261120040000_x_intelligence_feed`; this timestamp
sorts after it, following the existing `YYYYMMDDHHMMSS_description` convention).

```sql
-- Funding Opportunities — independent §6.2 review remediation.
--
-- Closes finding F-1 (band-a-p07-p08.md §3; master queue P1-3, High): P08's
-- "atomic review/pursuit task action" can create duplicate engagement_tasks
-- rows under concurrency, because the find-then-create check in
-- FundingOpportunityActionsService.act() has no unique constraint backing
-- it. Reproduced against a real 263-migration replay of
-- pgvector/pgvector:pg16 with real @prisma/client 5.22.0 interactive
-- transactions: 2 rows from 2 concurrent identical calls, and 2 rows from 8
-- parallel calls with NO injected delay.
--
-- THE FIX IS THE SAME SHAPE THIS PROGRAM ALREADY USES
-- -------------------------------------------------------------------------
-- client_funding_opportunity solved this identical problem for its own
-- find-then-create paths (setWorkflowStatus, decide, patchWorkflow) with a
-- PARTIAL unique index plus a service-layer catch of Prisma P2002 — see
-- 20260810010000_funding_opportunities and
-- 20260820010000_funding_opportunity_generic_source. This migration is the
-- database half of the identical remedy for engagement_tasks; the code half
-- (catching P2002 in act() and returning the winning row) is tracked in
-- docs/plans/funding-opportunities-makegov-v1/independent-review/FIX-PLAN-p08-idempotency.md
-- and must ship in the SAME deploy as this migration — see that document's
-- section 10.1 for why the migration alone is unsafe to ship first.
--
-- WHY PARTIAL
-- -----------
-- source_type/source_id are NULL for every task created through the
-- generic path (EngagementService.createTask,
-- apps/api/src/engagement/engagement.service.ts, never sets either column)
-- — the overwhelming majority of rows in this table. This repository's
-- convention (see the comment on client_funding_opportunity_grant_uniq) is
-- to say so explicitly with a WHERE clause, and a partial index is also
-- smaller, since it excludes those rows entirely.
--
-- WHY (tenant_id, source_type, source_id) AND NOT ALSO client_id
-- -------------------------------------------------------------------------
-- Matches the `findFirst` in act() exactly:
--   where: { tenantId, sourceType: FUNDING_OPPORTUNITY_TASK_SOURCE, sourceId }
-- which does not filter on client_id either. Widening the key would change
-- existing behaviour (whether two different clients in the same tenant
-- pursuing the same source opportunity share one task) — a separate,
-- pre-existing question this migration deliberately does not decide. See
-- FIX-PLAN-p08-idempotency.md section 11.
--
-- PRE-FLIGHT DUPLICATE CHECK
-- -------------------------------------------------------------------------
-- CREATE UNIQUE INDEX fails outright over existing duplicates — exactly
-- what the review's own probe hit (Postgres error 23505) applying this same
-- index shape to rows its own concurrency test had just duplicated. Guarded
-- here with the same check-then-RAISE pattern as
-- 20260728230000_add_tenant_scoped_pe_watch_key, so a real duplicate
-- already sitting in a target database blocks this migration with a clear
-- message instead of dying with a bare constraint-violation stack trace.
-- See FIX-PLAN-p08-idempotency.md section 10 for the read-only query to run
-- against capiro-dev before this migration is deployed there, and for what
-- to do if it finds one.
--
-- RLS: untouched, deliberately — the same call
-- 20260819010000_funding_opportunity_decisions made for
-- client_funding_opportunity. engagement_tasks already has RLS ENABLED +
-- FORCED with its one combined engagement_tasks_isolation policy
-- (USING/WITH CHECK tenant_id = current_tenant_id()), from
-- 20260503020000_engagement_manager_core. An index changes nothing about
-- access control, and re-issuing the policy would risk replacing it with a
-- subtly different predicate for no reason.
--
-- Additive only: no column added, no type changed, no existing index,
-- constraint or policy touched. Every statement is retry-safe.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "engagement_tasks"
    WHERE "source_type" IS NOT NULL AND "source_id" IS NOT NULL
    GROUP BY "tenant_id", "source_type", "source_id"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION
      'engagement_tasks has duplicate (tenant_id, source_type, source_id) rows; resolve them before this unique index can apply — see FIX-PLAN-p08-idempotency.md section 10';
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS "engagement_tasks_tenant_source_uniq"
    ON "engagement_tasks" ("tenant_id", "source_type", "source_id")
    WHERE "source_type" IS NOT NULL AND "source_id" IS NOT NULL;
```

**Companion `schema.prisma` update** (documentation only, no behavior change — Prisma cannot express
a partial unique index, so the schema file can only describe it in a comment, exactly as it already
does for `client_funding_opportunity_generic_uniq` at lines 6223–6229). Add to the `EngagementTask`
model (after line 1201, before `@@map`):

```prisma
  @@index([tenantId, clientId, status], map: "engagement_tasks_tenant_client_status_idx")
  @@index([tenantId, dueDate], map: "engagement_tasks_tenant_due_idx")
  // P08 idempotency guard (independent-review finding F-1). A PARTIAL unique
  // index — created only in the migration, since Prisma cannot express
  // `WHERE source_type IS NOT NULL AND source_id IS NOT NULL`:
  //   engagement_tasks_tenant_source_uniq
  //     UNIQUE (tenant_id, source_type, source_id)
  //     WHERE source_type IS NOT NULL AND source_id IS NOT NULL
  @@map("engagement_tasks")
```

---

## 6. The code change, exact before / after

File: `apps/api/src/funding-opportunities/funding-opportunity-actions.service.ts`.

**Import change** — add `Prisma` (not currently imported in this file; every other file in this
program that catches `P2002` imports it the same way, e.g. `funding-opportunities.service.ts` line 2):

```diff
 import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
+import { Prisma } from '@prisma/client';
 import { PrismaService } from '../prisma/prisma.service.js';
 import { FundingOpportunitiesService } from './funding-opportunities.service.js';
 import type { OpportunitySource } from './funding-opportunities.types.js';
```

**`act()` body** — current lines 145–196 (the whole `return this.prisma.withTenant(...)` block)
become a named `write` (matching `decide()`/`setWorkflowStatus()`/`patchWorkflow()`'s own naming)
wrapped in try/catch:

```diff
-    return this.prisma.withTenant(tenantId, async (tx) => {
-      const existingTask = await tx.engagementTask.findFirst({
-        where: { tenantId, sourceType: FUNDING_OPPORTUNITY_TASK_SOURCE, sourceId },
-        select: { id: true, title: true, ownerUserId: true, dueDate: true },
-      });
-
-      const task =
-        existingTask ??
-        (await tx.engagementTask.create({
-          data: {
-            tenantId,
-            clientId,
-            title,
-            description: description || null,
-            ownerUserId: input.ownerUserId ?? null,
-            dueDate,
-            sourceType: FUNDING_OPPORTUNITY_TASK_SOURCE,
-            sourceId,
-            createdByUserId: input.actorUserId,
-          },
-          select: { id: true, title: true, ownerUserId: true, dueDate: true },
-        }));
-
-      // Same transaction. If this throws, the task insert above rolls back with
-      // it — which is the entire point of the phase.
-      const saved = await this.opportunities.applyActionDecision(tx, {
-        tenantId,
-        clientId,
-        source,
-        sourceRecordId,
-        actorUserId: input.actorUserId,
-        decision,
-        workflowStatus,
-        ownerUserId: input.ownerUserId,
-        notes: input.notes,
-        nextAction: input.nextAction ?? (input.intent === 'pursuit' ? title : null),
-        nextActionDueAt: dueDate,
-        taskId: task.id,
-      });
-
-      return {
-        task: {
-          id: task.id,
-          title: task.title,
-          ownerUserId: task.ownerUserId ?? null,
-          dueDate: task.dueDate ? task.dueDate.toISOString() : null,
-          reused: existingTask != null,
-        },
-        decision,
-        workflowStatus: saved.workflowStatus,
-      };
-    });
+    const write = async (): Promise<OpportunityActionResult> =>
+      this.prisma.withTenant(tenantId, async (tx) => {
+        const existingTask = await tx.engagementTask.findFirst({
+          where: { tenantId, sourceType: FUNDING_OPPORTUNITY_TASK_SOURCE, sourceId },
+          select: { id: true, title: true, ownerUserId: true, dueDate: true },
+        });
+
+        const task =
+          existingTask ??
+          (await tx.engagementTask.create({
+            data: {
+              tenantId,
+              clientId,
+              title,
+              description: description || null,
+              ownerUserId: input.ownerUserId ?? null,
+              dueDate,
+              sourceType: FUNDING_OPPORTUNITY_TASK_SOURCE,
+              sourceId,
+              createdByUserId: input.actorUserId,
+            },
+            select: { id: true, title: true, ownerUserId: true, dueDate: true },
+          }));
+
+        // Same transaction. If this throws, the task insert above rolls back with
+        // it — which is the entire point of the phase.
+        const saved = await this.opportunities.applyActionDecision(tx, {
+          tenantId,
+          clientId,
+          source,
+          sourceRecordId,
+          actorUserId: input.actorUserId,
+          decision,
+          workflowStatus,
+          ownerUserId: input.ownerUserId,
+          notes: input.notes,
+          nextAction: input.nextAction ?? (input.intent === 'pursuit' ? title : null),
+          nextActionDueAt: dueDate,
+          taskId: task.id,
+        });
+
+        return {
+          task: {
+            id: task.id,
+            title: task.title,
+            ownerUserId: task.ownerUserId ?? null,
+            dueDate: task.dueDate ? task.dueDate.toISOString() : null,
+            reused: existingTask != null,
+          },
+          decision,
+          workflowStatus: saved.workflowStatus,
+        };
+      });
+
+    try {
+      return await write();
+    } catch (error) {
+      // engagement_tasks_tenant_source_uniq is the concurrency backstop — the
+      // SAME pattern client_funding_opportunity's writers already use (see
+      // decide() in funding-opportunities.service.ts): two simultaneous
+      // identical actions can both observe no existing task, and the loser
+      // must return the WINNER's row as `reused: true` rather than leaking a
+      // P2002. PrismaClientExceptionFilter does not special-case P2002 (only
+      // P2023/P2000/P2025/P2024/P2028 are mapped), so an uncaught one would
+      // reach the caller as a raw 500 — precisely the regression this catch
+      // exists to prevent now that the unique index can produce one.
+      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
+        throw error;
+      }
+      return this.prisma.withTenant(tenantId, async (tx) => {
+        const winner = await tx.engagementTask.findFirst({
+          where: { tenantId, sourceType: FUNDING_OPPORTUNITY_TASK_SOURCE, sourceId },
+          select: { id: true, title: true, ownerUserId: true, dueDate: true },
+        });
+        // The row that caused the P2002 must exist by now — Postgres blocks a
+        // conflicting INSERT until the winning transaction ends, so by the time
+        // this catch runs the winner has either committed (this find succeeds)
+        // or rolled back (in which case the constraint could not have fired).
+        // Re-throwing the ORIGINAL error on the impossible case, rather than a
+        // new one, matches decide()'s own defensive fallback exactly.
+        if (!winner) throw error;
+        return {
+          task: {
+            id: winner.id,
+            title: winner.title,
+            ownerUserId: winner.ownerUserId ?? null,
+            dueDate: winner.dueDate ? winner.dueDate.toISOString() : null,
+            reused: true,
+          },
+          decision,
+          workflowStatus,
+        };
+      });
+    }
```

### 6.1 Why the recovery path is a plain `findFirst`, not `findFirstOrThrow`

Matches `decide()`'s own `if (!existing) throw error;` exactly (line ~611 of
`funding-opportunities.service.ts`) rather than throwing a new `NotFoundException`. If the row
somehow is not there — which the transaction-ordering argument above says should be impossible —
re-throwing the *original* `P2002` preserves the real error for logs/alarms instead of masking it
behind a misleading 404.

### 6.2 Why the recovery path only reads, not writes

This is the one place this fix's shape genuinely differs from `decide()`'s, and it is a correct
simplification, not a shortcut:

- `decide()`'s catch-block recovery **writes**, because the loser of a first-decision race still has
  its *own new* decision to apply on top of the row the winner just created.
- `act()`'s catch-block recovery **only reads**, because by the time `tx.engagementTask.create`
  throws `P2002`, the winning transaction has already run `applyActionDecision` to completion and
  committed (statement order in `write()` guarantees the task insert precedes the decision write,
  and the whole transaction is atomic) — there is nothing left for the loser to write. Its
  `decision`/`workflowStatus` values were computed, before the transaction ever opened, as a pure
  function of `input.intent` (`const decision = input.intent === 'pursuit' ? 'pursue' : 'monitor'`
  etc., current lines 122–123) — identical for winner and loser by construction — and
  `applyActionDecision` passes `workflowStatus` straight through unmodified
  (`funding-opportunities.service.ts` line ~705: `workflowStatus: input.workflowStatus`), so the
  loser's locally-known `workflowStatus`/`decision` are already exactly what a fresh read of the
  winner's write would show. No new helper method, no extra query, no risk of the two racers
  disagreeing about what the action *meant* (as opposed to which task row represents it).

---

## 7. Downstream consumers — confirmed unaffected

`git grep`-verified (`select:` and constructor call sites): `FundingOpportunityActionsService` has
exactly one caller, `funding-opportunities.controller.ts` line 961
(`POST /clients/:clientId/opportunities/:source/:id/action`), which does
`return this.actions.act(...)` with no wrapping try/catch — any exception from `act()` propagates
through Nest's normal exception handling. The response shape returned by `act()`
(`OpportunityActionResult` — `task`, `decision`, `workflowStatus`) is unchanged by this fix in every
field and every case; the only behavioral change visible to the controller/caller is that a
concurrent loser now returns **successfully** with `task.reused === true` instead of (post-migration,
pre-code-fix) throwing. Confirmed no other file constructs `FundingOpportunityActionsService`
directly (only `funding-opportunities.module.ts` line ~72, as an ordinary Nest provider) and no
other file reads `FUNDING_OPPORTUNITY_TASK_SOURCE` or calls `taskSourceId` outside this file and its
spec.

---

## 8. Test plan — the real-Postgres concurrency proof

### 8.1 Why the existing suite cannot catch this (confirmed, not assumed)

`funding-opportunity-actions.spec.ts`'s `makeFake()` (lines ~35–100) implements `tx.engagementTask`
as hand-written Jest mocks backed by a plain in-memory array, and `prisma.withTenant` as a function
that just calls the callback with that same fake `tx`, with a hand-rolled `catch { created.length =
0 }` standing in for a real rollback. Its one idempotency test **pre-seeds** `existingTask` into the
fake and asserts `created` stays empty — it verifies the `??` operator's behavior on given input, not
that a unique index (which does not exist in the fake at all) prevents two real rows. No test in this
file opens a real transaction, issues real concurrent calls, or touches real SQL. This is exactly
finding **F-3** (`band-a-p07-p08.md` §3.4, master queue P2-31) and is why the review had to write a
disposable throwaway script to find the bug at all.

### 8.2 What must exist instead

A script — not a Jest `.spec.ts` — matching this program's own established convention for
tests that require a live, disposable Postgres rather than a mock: `funding-opportunities-ci.yml`
already provisions a real `pgvector/pgvector:pg16` service container and runs `prisma migrate
deploy` against it before any other check; `apps/api/scripts/test-policy-pack-lifecycle-concurrency.sh`
is this repository's precedent for a concurrency proof that runs as its own CI step against that
same kind of live container rather than inside the default `pnpm test` Jest run (which must stay
green with no `DATABASE_URL` at all, for local/unrelated-CI runs). The policy-pack script drives raw
`psql`, appropriate for proving a trigger; this fix needs to drive the actual **TypeScript service**
`FundingOpportunityActionsService.act()`, so the new script is `.ts`, run via `tsx` — this
program's own convention for every script under `apps/api/scripts/` (see `apps/api/package.json`,
e.g. `"diag:funding-opportunities-makegov": "tsx scripts/diag-funding-opportunities-makegov.ts"`).

**New file:** `apps/api/scripts/test-funding-opportunity-action-concurrency.ts`

**New `apps/api/package.json` alias** (alongside the existing `diag:*`/`test-policy-pack-*` entries):

```json
"test:funding-opportunity-action-concurrency": "tsx scripts/test-funding-opportunity-action-concurrency.ts"
```

**Illustrative sketch** (the implementer fills in the seed helpers and picks a construction strategy
for the two collaborator services — direct `new` is simplest for a script and is sketched here;
`Test.createTestingModule({ imports: [PrismaModule, MemoryModule, FundingOpportunitiesModule] })`
is the alternative if going through real Nest DI is preferred):

```ts
#!/usr/bin/env tsx
/**
 * Real-Postgres proof for FIX-PLAN-p08-idempotency.md (independent-review
 * finding F-1): N concurrent identical "Pursue" actions against
 * FundingOpportunityActionsService.act() must create EXACTLY ONE
 * engagement_tasks row and ONE client_funding_opportunity row.
 *
 * This is the test the review found missing (F-3 / master queue P2-31) and
 * that would have caught the original bug. It does not replace
 * funding-opportunity-actions.spec.ts, which stays the fast mock-backed unit
 * suite for validation/shape logic — this script is the DB-backed proof.
 *
 * Requires a real, already-migrated Postgres at DATABASE_URL. In CI this is
 * the same pgvector/pgvector:pg16 container and DATABASE_URL that
 * funding-opportunities-ci.yml already provisions for the migration-replay
 * steps; locally, the docker-compose Postgres after `prisma migrate deploy`.
 */
import { PrismaService } from '../src/prisma/prisma.service.js';
import { FundingOpportunitiesService } from '../src/funding-opportunities/funding-opportunities.service.js';
import { FundingOpportunityActionsService } from '../src/funding-opportunities/funding-opportunity-actions.service.js';

const CONCURRENCY = 8; // matches the review's own reproduction count exactly

async function main() {
  const prisma = new PrismaService();
  await prisma.$connect();

  // Fixtures: a disposable tenant/user/client and ONE pursuable sam_opportunity
  // row, inserted via prisma.withSystem (bypasses tenant-scope injection,
  // appropriate for fixture setup rather than simulating a tenant request).
  // Mirror the minimal field set funding-opportunity-actions.spec.ts's
  // TENANT/CLIENT/USER/SAM_ID constants already exercise.
  const { tenantId, userId, clientId, samOpportunityId } = await seedFixtures(prisma);

  // act()'s sam_gov/grants_gov path never reaches Tango — construct the real
  // collaborator services directly rather than mocking, so this stays an
  // honest exercise of the real code, not a re-mock of the thing under test.
  const opportunities = new FundingOpportunitiesService(prisma, tangoStore, tangoGateway);
  const actions = new FundingOpportunityActionsService(prisma, opportunities);

  const results = await Promise.allSettled(
    Array.from({ length: CONCURRENCY }, () =>
      actions.act(tenantId, clientId, 'sam_gov', samOpportunityId, {
        intent: 'pursuit',
        actorUserId: userId,
      }),
    ),
  );

  const rejected = results.filter((r) => r.status === 'rejected');
  if (rejected.length > 0) {
    console.error(`FAIL: ${rejected.length}/${CONCURRENCY} calls rejected (expected 0 — a P2002 escaped act()'s catch)`);
    rejected.forEach((r) => r.status === 'rejected' && console.error(r.reason));
    process.exit(1);
  }

  const fulfilled = results as PromiseFulfilledResult<Awaited<ReturnType<typeof actions.act>>>[];
  const distinctTaskIds = new Set(fulfilled.map((r) => r.value.task.id));
  const reusedCount = fulfilled.filter((r) => r.value.task.reused).length;

  const taskRows = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*)::bigint AS count FROM engagement_tasks
    WHERE tenant_id = ${tenantId}::uuid AND source_type = 'funding_opportunity'
      AND source_id = ${`sam_gov:${samOpportunityId}:pursuit`}`;
  const decisionRows = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*)::bigint AS count FROM client_funding_opportunity
    WHERE tenant_id = ${tenantId}::uuid AND client_id = ${clientId}::uuid
      AND source = 'sam_gov' AND sam_opportunity_id = ${samOpportunityId}::uuid`;

  assertEqual(distinctTaskIds.size, 1, 'all concurrent calls must return the SAME task id');
  assertEqual(Number(taskRows[0].count), 1, 'exactly one engagement_tasks row must survive');
  assertEqual(Number(decisionRows[0].count), 1, 'exactly one client_funding_opportunity row must survive');
  assertEqual(reusedCount, CONCURRENCY - 1, `exactly ${CONCURRENCY - 1} of ${CONCURRENCY} calls must report reused:true`);

  await cleanupFixtures(prisma, tenantId);
  console.log(`P08_ACTION_CONCURRENCY_OK: ${CONCURRENCY} concurrent calls -> 1 task row, 1 decision row, ${reusedCount} reused=true`);
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
```

### 8.3 What this test would show, before vs. after this fix

- **Against `origin/main` today (no migration, no code change):** all `CONCURRENCY` calls resolve
  successfully (nothing throws), but `distinctTaskIds.size` and the `engagement_tasks` row count
  both come back `> 1` — the exact failure the review found.
- **With the migration only, no code change:** the assertion on `rejected.length === 0` fails first —
  some calls now throw a raw 500-shaped `P2002` instead of duplicating, which is safer but is not
  the fixed behavior the phase promises ("the caller ... needs a task back either way").
- **With both changes:** all assertions pass. This is the regression guard.

### 8.4 The existing mock-backed suite: keep, do not replace

`funding-opportunity-actions.spec.ts` should gain one addition mirroring its own existing style —
a fake-backed test that a caught fake `P2002`-shaped error causes a re-`findFirst` and a
`reused: true` result — but this is a shape/wiring test, not a substitute for §8.2's real-Postgres
proof. Recommend adding `Prisma` import support to `makeFake()`'s `tx.engagementTask.create` mock
(a second call rejects with an object shaped like `Prisma.PrismaClientKnownRequestError` with
`code: 'P2002'`) so the catch branch's *logic* is unit-tested fast, while §8.2 remains the only test
that can actually prove the database enforces it.

---

## 9. CI wiring

`.github/workflows/funding-opportunities-ci.yml`, job `funding-opportunities`, needs two additions
so the new migration and the new concurrency script both run on every PR that touches this program
(the job already gates on path scope via `steps.scope.outputs.in_scope`, and
`apps/api/src/funding-opportunities/` is already in that path list, so no scope-regex change is
needed).

**9.1 — add the new migration to "Assert this feature's migrations were applied"** (the `for name
in \ ... do` list, currently 20 entries ending at `20260909010000_tango_sbir_sttr`): append

```
            20260909010000_tango_sbir_sttr \
            20261120050000_engagement_task_action_source_uniq
```

(replacing the current final line, which has no trailing `\`, with the new final line carrying the
`\` and this migration's name taking its place as the list's new last entry).

**9.2 — add two `check` lines to "Assert this feature's schema objects exist in the migrated
database"**, alongside the existing `client_funding_opportunity_generic_uniq` checks (same file,
same `check` helper already defined in that step):

```bash
          check "engagement task action-source unique index exists" \
            "SELECT count(*) FROM pg_indexes WHERE indexname='engagement_tasks_tenant_source_uniq'" \
            "1"
          check "engagement task action-source unique index is PARTIAL" \
            "SELECT CASE WHEN indexdef LIKE '%WHERE%' THEN 'yes' ELSE 'no' END FROM pg_indexes WHERE indexname='engagement_tasks_tenant_source_uniq'" \
            "yes"
```

**9.3 — new step to run the concurrency script**, placed after the "Assert this feature's schema
objects exist" step (so it runs against the same already-migrated container) and before the job's
typecheck/unit-test steps:

```yaml
      - name: P08 concurrency proof — N parallel Pursue actions create exactly one task
        if: steps.scope.outputs.in_scope == 'true'
        run: pnpm --filter @capiro/api run test:funding-opportunity-action-concurrency
```

No change needed to the job's `services.postgres` block, its `DATABASE_URL`/`PSQL_DATABASE_URL` env,
or the path-scope regex at line 107 — all three already cover this program and this file.

---

## 10. Migration safety checklist

### 10.1 The migration and the code change must ship in the same deploy

Confirmed via `apps/api/src/common/prisma-exception.filter.ts` (`@Catch(Prisma.PrismaClientKnownRequestError)`):
only `P2023`, `P2000`, `P2025`, `P2024`, `P2028` are mapped to specific HTTP statuses; the `default:`
branch (which `P2002` falls into) returns a bare `500 Internal server error` and logs `Unhandled
Prisma error P2002`. **If the migration in §5 ships without the code change in §6, the loser of a
concurrent "Pursue" race changes from "silently gets a duplicate task, 200 OK" to "gets an unhandled
500."** That is a real regression in caller experience even though it is a strict improvement in data
integrity, and it is not what the phase's own contract promises ("the caller ... needs a task back
either way"). Ship both in the same PR/deploy; do not sequence the migration ahead of the code as a
"safe first step" — for this specific pair, it is not safe on its own without also accepting worse
UX in the interim.

### 10.2 Forward-only, additive, no data loss

The migration in §5 adds one index and no column, no type change, no `DROP`, no data rewrite, and
touches no RLS object. It is retry-safe (`CREATE UNIQUE INDEX IF NOT EXISTS`) and reversible by a
plain `DROP INDEX IF EXISTS "engagement_tasks_tenant_source_uniq";` if ever needed (not included
here — this plan does not add a down-migration, matching this repository's forward-only migration
convention observed throughout `apps/api/prisma/migrations/`).

### 10.3 Pre-flight duplicate check — not yet run against capiro-dev

The migration's own `DO $$ ... RAISE EXCEPTION $$` guard (§5) protects the migration run itself: if
capiro-dev (or production) already has a duplicate `(tenant_id, source_type, source_id)` pair —
plausible, since this exact race is provably reachable today — the migration will fail loudly with
a clear message rather than applying inconsistently or crashing with a bare `23505`.

**This session did not query capiro-dev or any live database** — the task was scoped to producing
this plan, not to executing changes or live diagnostics, and no database connection was set up as
part of this work. Before this migration is deployed to capiro-dev, run this **read-only** query
against it first:

```sql
SELECT tenant_id, source_type, source_id, COUNT(*), array_agg(id ORDER BY created_at) AS row_ids
FROM engagement_tasks
WHERE source_type IS NOT NULL AND source_id IS NOT NULL
GROUP BY tenant_id, source_type, source_id
HAVING COUNT(*) > 1;
```

- **Zero rows returned:** the migration will apply cleanly; proceed.
- **Any row returned:** real duplicates exist. Do not force the index. For each group, decide which
  row is canonical (recommend: earliest `created_at`, i.e. `row_ids[0]`) and what to do with the
  rest — likely re-point anything referencing the later duplicate's `id` (check
  `client_funding_opportunity.notes`/audit rows for mentions, though nothing has a hard FK to
  `engagement_tasks.id` per the schema read in [§1](#1-bug-confirmation-at-current-originmain)) and
  then delete or retitle the later row(s) so the group is unique before re-running the migration.
  This is a data-remediation decision for whoever owns capiro-dev/production data, not a decision
  this plan makes unilaterally.

### 10.4 RLS — confirmed already correct, untouched by this change

`engagement_tasks` already has RLS `ENABLED` and `FORCED`, with exactly one combined policy,
`engagement_tasks_isolation` (`USING (rls_bypass() OR tenant_id = current_tenant_id()) WITH CHECK
(...)`), from `20260503020000_engagement_manager_core` lines 551–555. This is a **different**
shape from `client_funding_opportunity`'s four separate select/insert/update/delete policies — both
are legitimate, pre-existing conventions in this codebase for different tables, and this migration
does not need to (and does not) change either. An index has no interaction with row-level security.
No new grant is needed either: `capiro_app` already holds `SELECT, INSERT, UPDATE, DELETE` on
`engagement_tasks` from the same original migration (lines 569–588).

### 10.5 Rollout sequencing

1. Run the §10.3 query against capiro-dev; resolve any duplicates found.
2. Land the migration (§5) and the code change (§6) in the same PR.
3. Confirm CI's new concurrency step (§9.3) passes — this is the gate that proves both halves work
   together before merge, not just that each applies in isolation.
4. Deploy per this program's normal rollout (migration first via the existing migrate-deploy path,
   then the image carrying the code change) — standard for this program's additive migrations, since
   a brief window where the index exists but the old code is still running only means the old code's
   occasional loser gets an uncaught `P2002` (§10.1) rather than a silent duplicate, for the seconds
   the rolling deploy takes, not a correctness regression.

---

## 11. Explicitly out of scope / adjacent findings

Two things this investigation surfaced but this plan deliberately does not fix, so they are not lost
and not silently folded into this change's blast radius:

**F-2 (`band-a-p07-p08.md` §4, master queue P2-30, Medium) — task/opportunity date and owner drift
on reuse.** When `act()` returns an *existing* task (either via the original `existingTask` hit or
via this fix's new P2002-recovery path), the task keeps its original `dueDate`/`ownerUserId` while
`applyActionDecision` still writes the *freshly re-read* `dueDate`/`ownerUserId` onto the opportunity
— so a source deadline that moved between the first action and a retry drifts the two apart, which is
exactly the invariant the phase's own docblock claims to prevent. This fix's new recovery path
inherits this **exact same pre-existing behavior** (it is not a new instance of the bug — the
original `existingTask ??` branch already has it) rather than introducing a new one, but does not
repair it either; F-2 has its own suggested remedy in the review and is a separate, self-contained
change (touching how `act()` reconciles a reused task's stale fields, not the concurrency guard this
plan adds). Fixing both in one PR is reasonable if the implementer prefers; this plan does not assume
that and specifies F-1's fix independently so it is not blocked on F-2 being resolved.

**A cross-intent race in `applyActionDecision`, found during this investigation, not in the
original review.** `review` and `pursuit` are deliberately separate idempotency keys (separate
`sourceId` values), so a `review` action and a `pursuit` action on the *same* opportunity, fired
concurrently, both pass the new `engagement_tasks` uniqueness check independently (different keys)
and both reach `this.opportunities.applyActionDecision(tx, ...)` concurrently, targeting the *same*
`client_funding_opportunity` row. If neither has a decision row yet, both attempt `.create()`;
`client_funding_opportunity`'s own partial unique indexes (§3) correctly stop the second one at the
database layer — but unlike `decide()`/`setWorkflowStatus()`/`patchWorkflow()`, `applyActionDecision`
itself has no `try`/catch of its own, so that second `P2002` propagates up through `act()` uncaught
(this fix's new catch only matches on the `engagementTask.create` failure path — its `winner`
re-`findFirst` and return covers the *task* race, not this separate *decision-row* race, and does not
suppress an error thrown at a different point in `write()`). Net effect: in this specific narrow
window (both the FIRST review action and the FIRST pursuit action on the same never-before-touched
opportunity, truly concurrent), the loser gets a clean transaction rollback and an uncaught 500 rather
than a silent duplicate — safe, but not graceful, and not covered by this plan's fix or its test in
§8. This is pre-existing, not introduced or worsened by this change, and is narrower in practice than
F-1 was (it requires two *different* intents racing on an opportunity with *no* prior decision, not
merely two identical clicks). Recording it here rather than fixing it, per this task's scope; suggest
logging it in `MASTER-FINDINGS-QUEUE.md` alongside F-1/F-2 if the team wants it tracked formally.

---

## 12. Rollout / verification checklist

For whoever implements §5–§9:

1. Run the §10.3 query against capiro-dev (and any other live environment this program targets)
   before writing the migration file, so a real duplicate is known about before it becomes a failed
   deploy.
2. Add the migration directory and file exactly as in §5, plus the `schema.prisma` comment.
3. Apply the code change in §6 (import + `write()` extraction + try/catch). `tsc`
   (`tsc -p tsconfig.funding-opportunities.json --noEmit`, per this program's own typecheck
   convention) should pass with no new errors.
4. Add the new script (§8.2) and package.json alias; add the fake-backed shape test noted in §8.4 to
   `funding-opportunity-actions.spec.ts`.
5. Wire CI per §9 (migration-name list, two `check` lines, new step).
6. Run locally against docker-compose Postgres:
   ```
   pnpm --filter @capiro/api exec prisma migrate deploy
   pnpm --filter @capiro/api run test:funding-opportunity-action-concurrency
   pnpm --filter @capiro/api test -- funding-opportunity-actions
   ```
   Expect: migration applies; concurrency script prints `P08_ACTION_CONCURRENCY_OK` with `rowIds
   size 1` and `reused=CONCURRENCY-1`; existing mock-backed spec still green plus the new shape test
   from §8.4.
7. Confirm no other consumer of `EngagementTask.sourceType`/`sourceId` exists beyond the two call
   sites identified in §2/§7 (re-run the `git grep` if time has passed since this plan was written —
   main moves fast on this repo).
8. Deploy per §10.5's sequencing. Do not deploy the migration ahead of the code change (§10.1).
