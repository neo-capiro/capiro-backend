# Band A — Independent §6.2 review: P07 and P08

**Scope:** P07 (human decision and next-action persistence) and P08 (atomic
review/pursuit task action).

**Pinned at:** `d800dcfde51f6cf21a4b54b511006b9001fd6d2b` (`origin/main` HEAD,
2026-08-13).

**Reviewer:** an agent that did **not** implement, test or merge P07 or P08, per
§6.2 and the convention in `docs/runbooks/phase-2-independent-live-validation.md`
("Hand this to a different agent or model than the one that implemented …
Self-review defeats the purpose").

**Why this document exists:** the completion matrix carries `*pending*` in the
**Review** column for every phase from P05 to P11, including both phases in this
band. Both rows nonetheless carry detailed **Live acceptance** prose asserting
what was proven. Under §6.2 that prose is the *executor's* claim, not a review.
This document tests those claims by execution.

**Method note — what was and was not trusted.** Nothing in the handoff, the
completion matrix, the decision log, or the source docblocks was accepted as
evidence. Schema claims were re-derived from a fresh 263-migration replay onto an
empty `pgvector/pgvector:pg16`; behavioural claims were re-derived by executing
the code paths against that database with the real `@prisma/client` 5.22.0. Where
this review reaches a different conclusion from the matrix, the disagreement is
backed by a transcript below that anyone can re-run.

**Read-only against the shared checkout.** Every read of pinned content used
`git show d800dcfde5:<path>` against `C:\dev\capirov2`; that worktree's working
tree (which carries unrelated uncommitted work) was never modified. Execution
used the prepared detached worktree `C:\dev\capiro-fo-ga-review-wt`, confirmed at
`d800dcfde5`. Two temporary probe scripts were written under `apps/api/` during
this review and **deleted**; the worktree carries no change from this review
except this file. Nothing was staged, committed or pushed.

**Disposable database.** A throwaway container `fo-p78-review-pg`
(`pgvector/pgvector:pg16`, host port `55471`) was created for this review. It is
not shared with any other reviewer's instance and holds no real data.

---

## 0. Correcting the brief's premises before verifying anything

Two premises in the review assignment do not survive contact with the code. They
are recorded here because a reviewer who verified them as stated would have
produced a false result.

| Premise as briefed | What is actually there |
|---|---|
| "P07 adds a migration (`funding_opportunity_decisions`) with … RLS policies" | The migration adds **no** RLS statement at all, deliberately. `funding_opportunity_decisions` is only the migration **directory name**; no table of that name exists. Six nullable columns are added to the pre-existing `client_funding_opportunity`. RLS/`FORCE`/4 policies come from `20260810010000_funding_opportunities` and are **inherited**, not re-issued. The migration explains why: re-issuing "would risk replacing a policy with a subtly different predicate." This is the correct call. |
| "a unique-constraint-guarded first-decision race" | **No such unique constraint exists**, in this migration or anywhere else. `grep`-verified across every migration and confirmed against the migrated database. P07 adds three `CHECK`s and one *non-unique* partial index. The only unique indexes on the table are the three pre-existing **identity** uniques (grant / sam / generic). There is no first-decision race guard, and §3 below shows the absence is load-bearing for P08. |

Verifying the briefed premises as literally stated would have produced two
false PASSes. They are reported as brief defects, not as phase defects.

---

## 1. P07 — the migration, verified by replay and execution

### 1.1 Clean replay

```bash
docker run -d --name fo-p78-review-pg -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=capiro -p 55471:5432 \
  pgvector/pgvector:pg16

cd C:/dev/capiro-fo-ga-review-wt
DATABASE_URL="postgresql://postgres:postgres@localhost:55471/capiro?schema=public" \
  pnpm --filter @capiro/api exec prisma migrate deploy
```

**Result: PASS.** `All migrations have been successfully applied.` — 263 rows in
`_prisma_migrations` with a non-null `finished_at`, from empty. The matrix's
"clean replay from verified-empty pgvector:pg16" claim is confirmed
independently.

### 1.2 Schema state — every P07 acceptance claim, re-derived

| Claim (matrix) | Verified value | Verdict |
|---|---|---|
| 6 additive nullable columns | all 6 present, `is_nullable=YES` | PASS |
| no DEFAULT on any | `column_default` NULL on all 6 | PASS |
| no backfill | migration contains no `UPDATE` | PASS |
| 3 CHECKs, correctly shaped | all 3 present; definitions read back from `pg_get_constraintdef` and match intent | PASS |
| decision index is partial | `… WHERE (human_decision IS NOT NULL)` | PASS |
| index leads on `tenant_id` | `btree (tenant_id, human_decision, next_action_due_at)` | PASS |
| RLS still ENABLED + FORCED | `relrowsecurity=t`, `relforcerowsecurity=t` | PASS |
| exactly 4 policies | 4 — `select`/`insert`/`update`/`delete` | PASS |

### 1.3 The CHECKs actually **reject** — the claim nothing automated tests

The matrix asserts all three CHECKs were "proven against real Postgres to
reject" six specific bad shapes. That proof existed only as prose: the P07 spec
is a **text-regex read of the migration file** (`funding-opportunity-decision.spec.ts`
never opens a database), and the CI gate asserts only that the constraints
*exist* (`SELECT count(*) FROM pg_constraint … = 1`), never that they reject.

Re-proved by execution against the migrated database:

| # | Attempted insert | Outcome |
|---|---|---|
| 1 | `human_decision='maybe'` (out of vocabulary) | REJECTED — `…_human_decision_chk` |
| 2 | `human_decision='suggested'` (machine state as decision) | REJECTED — `…_human_decision_chk` |
| 3 | decision, no actor | REJECTED — `…_decision_actor_chk` |
| 4 | decision, no timestamp | REJECTED — `…_decision_actor_chk` |
| 5 | actor + timestamp, no decision | REJECTED — `…_decision_actor_chk` |
| 6 | due date, no action | REJECTED — `…_next_action_chk` |
| 7 | *(positive control)* valid decision + action + due date | INSERTED |
| 8 | *(positive control)* action with no due date | INSERTED |

Exactly 3 rows survived (baseline undecided + the two controls), which is the
expected count. **PASS** — the matrix's claim is true. It is, however, true by
manual rehearsal only; see finding F-4.

### 1.4 P07 verdict

**P07 passes.** Every claim in its completion-matrix row that can be checked
from the pinned tree is true, and the three integrity CHECKs do the work they
are said to do. Reviewed in isolation, P07 would be approved with non-blocking
notes F-4 and F-5 only.

---

## 2. P08 — the transaction boundary is real (the good news first)

The central P08 claim is that the task insert and the decision write happen in
**one** transaction. This is the claim most worth doubting, because the entire
unit suite is built on a hand-written fake.

### 2.1 The code genuinely threads one transaction client

Traced by reading, not by trusting the docblock:

- `act()` wraps both writes in `this.prisma.withTenant(tenantId, async (tx) => …)`.
- `withTenant` is a real Prisma **interactive transaction** —
  `scopedClient({tenantId}).$transaction(async (tx) => …)` (`prisma.service.ts`).
- The task insert uses `tx.engagementTask.create`.
- `applyActionDecision(tx, …)` takes the tx as its first parameter and uses it
  throughout: `findWorkflowRow(tx, …)` → `tx.clientFundingOpportunity.findFirst`;
  the write → `tx.clientFundingOpportunity.update`/`.create`;
  `writeWorkflowAudit(tx, …)` → `tx.auditLog.create`.

There is **no** hidden fallback to `this.prisma` on the write path. This is
exactly the P48 failure mode (a service that accepts a `tx` and then quietly
ignores it), and P08 does not have it.

### 2.2 Rollback proven against real Postgres, not against a fake

The suite's own rollback tests are tautological: `makeFake()` implements the
rollback *itself* (`catch { created.length = 0; decisions.length = 0 }`) and the
test asserts the fake's own flag. Those two tests would pass even if `withTenant`
opened no transaction whatsoever.

Re-proved for real — insert a task on the transaction, then throw, exactly as a
failing `applyActionDecision` would:

```
PASS  D. A throw after the task insert discards the task (real Prisma rollback)
      threw=true, surviving rows=0 (expected 0)
```

**PASS.** The atomicity claim — the actual point of the phase — is true. Both
directions hold: a throw after the insert discards it (proven above), and a
failing task insert never reaches the decision write (guaranteed by statement
order in `act()`, since `applyActionDecision` is only called after `create`
resolves).

---

## 3. P08 — the idempotency claim is false under concurrency (blocking)

### 3.1 The claim

`funding-opportunity-actions.service.ts` states it as a guarantee:

> "A double-clicked button, a retried request and a replayed mutation all land on
> the same key and get the SAME task back."

The completion matrix records it as accepted: *"Retry returns the SAME task
(`reused: true`) and creates none."*

### 3.2 The mechanism cannot deliver that

The guard is a read-then-write with no lock and no unique constraint:

```ts
const existingTask = await tx.engagementTask.findFirst({
  where: { tenantId, sourceType: FUNDING_OPPORTUNITY_TASK_SOURCE, sourceId },
  …
});
const task = existingTask ?? (await tx.engagementTask.create({ … }));
```

`withTenant` passes no `isolationLevel`, so these transactions run at Postgres's
default **READ COMMITTED**. Two concurrent transactions both see no row, and both
insert. Nothing stops them: verified against the migrated database, the only
indexes on `engagement_tasks` are `engagement_tasks_pkey`,
`engagement_tasks_tenant_client_status_idx` and `engagement_tasks_tenant_due_idx`
— **no unique index on `(tenant_id, source_type, source_id)`**, and none in the
Prisma model either.

### 3.3 Proven by execution

Real `@prisma/client` 5.22.0, real interactive transactions, real migrated
Postgres, issuing the exact statement pair `act()` issues:

```
PASS  A. Sequential retry returns the same task and creates only one row
      rows=1, second.reused=true, sameId=true
FAIL  B. Concurrent double-click creates exactly ONE task
      rows=2 (expected 1), rejections=0  <-- DUPLICATE TASKS
FAIL  C. 8 genuinely parallel identical requests create exactly ONE task
      rows=2 (expected 1), rejections=0  <-- duplicates arose with NO artificial delay
```

Case **C** used no barrier, no injected sleep and no contrivance — eight ordinary
parallel calls. The duplicate is not a theoretical window.

A further, unplanned confirmation: the probe's final step tried to build a unique
index on `(tenant_id, source_type, source_id)` and Postgres **refused**, because
the rows produced by case B were already duplicated:

```
Code: 23505  Key (tenant_id, source_type, source_id)=(…, funding_opportunity,
sam_gov:…-barrier:pursuit) is duplicated.
```

On a cleaned table the same race with that index present behaves correctly:

```
E. WITH unique index -> rows=1 (expected 1), rejections=1, code=P2002
PASS  a unique index converts the silent duplicate into a loud, retryable conflict
```

So the defect is real, and the standard remedy demonstrably fixes it.

### 3.4 Why the tests never caught it

`funding-opportunity-actions.spec.ts` has no concurrency test at all. Its
idempotency case **pre-seeds** `existingTask` into the fake and then asserts
`created` is empty — it verifies the `??` operator, not that one row exists in a
database. This is precisely the weaker claim §6.2 exists to catch: it asserts the
shape of a call, never a row count after two real writes.

### 3.5 Mitigation and real severity

The web caller passes `confirmLoading={editorMutation.isPending}` on the modal OK
button, so antd's own loading state suppresses the *ordinary* second click. That
lowers the practical rate but does not repair the claim: the guarantee is stated
as a **server-side** property covering "a retried request and a replayed
mutation" — proxy retries, offline replay and non-browser clients are all outside
the UI's protection. Consequence is duplicate Engagement tasks requiring manual
cleanup; it is not data corruption and not a security issue.

---

## 4. P08 — the "same value" date invariant breaks on the reuse path

Both the docblock and the matrix claim the task's due date and the opportunity's
next-action date are the same value ("Two dates that could drift is how a task
says one thing and the inbox says another").

That holds on first creation. It does **not** hold on reuse. In `act()`:

- `dueDate` is recomputed from a **fresh** `describeForAction` read each call;
- on reuse, `task` is the **existing** row, carrying its original `dueDate`;
- `applyActionDecision` is nevertheless passed the **fresh** `nextActionDueAt: dueDate`.

So if the source deadline moved between the first action and a later retry, the
opportunity is updated to the new date while the task keeps the old one — the
exact drift the phase says it prevents. `ownerUserId` diverges the same way: a
retry with a different owner updates the opportunity and leaves the task's owner
untouched, while the response still reports the stale task owner.

The unit test checks only the fresh-create path (`created[0].dueDate` against
`decisions[0].nextActionDueAt`) and never the reuse path, so it cannot see this.

---

## 5. The mandatory question: would either phase notice itself doing nothing?

**Asked because of today's finding that two brand-new producer scripts ran
"successfully" and inserted zero rows, with no test or alert catching it.**

**Answer: no. Neither P07 nor P08 has any live-verifiable success assertion.**

- The feature's diagnostic script,
  `apps/api/scripts/diag-funding-opportunities-makegov.ts`, does not count
  decisions or action-created tasks. Its only match for "decision" is an
  unrelated comment about terminal failures.
- No CloudWatch alarm, CI assertion or scheduled check references
  `human_decision` on the **write** path. The `humanDecisionsPreserved` counters
  in the producer scripts count rows the producers **skipped** because a human had
  already decided — a read-side guard, and it reads 0 both when the feature is
  healthy-but-unused and when it is completely broken.
- The CI gate asserts the decision **columns and constraints exist**. A column
  that exists and is never written looks identical to one that works.
- P08's route has no counter, no audit assertion and no smoke test that a task
  row and a decision row exist after a real call.

If the `/action` or `/decision` route silently wrote nothing in production — a
guard rejecting every request, a 500 swallowed by the UI, a flag misconfigured —
every check in this program would stay green. This is the same class of blind
spot as the zero-row producers, and it applies to the two phases that own the
feature's only user-initiated writes.

Note the asymmetry: the audit row written by `writeWorkflowAudit` would make a
successful action *observable after the fact*, but nothing *asserts* on it, so it
is evidence available to an investigator, not a detector.

---

## 6. Verdict

Exactly one of:

```
BAND_A_P07_P08_INDEPENDENTLY_APPROVED
or
BAND_A_P07_P08_REJECTED  (list every failing check by section number)
```

**Verdict: `BAND_A_P07_P08_REJECTED`**

Failing sections: **§3** (idempotency guarantee false under concurrency,
reproduced twice against real Postgres, once with no artificial delay) and **§4**
(the task/opportunity date invariant breaks on the reuse path). Both are claims
the phase's own completion-matrix **Live acceptance** cell records as proven.
Under §6.2 the bar is that the phase's stated acceptance holds; two of P08's
stated acceptance criteria are disproven by execution.

**P07 is not the reason for this verdict.** Reviewed alone, P07 would be
approved: every claim in its row is true, and its CHECKs genuinely reject all six
bad shapes. The rejection is P08's.

This verdict is about P08's **claims**, not about shipping risk. The atomicity
guarantee — the phase's actual reason for existing — is real and proven (§2). The
remedy for §3 is one partial unique index plus a catch on `P2002`; §4 is a few
lines in `act()`. Neither requires rethinking the design.

---

## 7. Findings queue

**Nothing in this queue was fixed.** Per the review instruction, findings are
recorded here rather than repaired, so that a self-review does not happen by
accident. Every item needs an implementer who is not this reviewer.

| ID | Sev | Finding | Suggested remedy |
|---|---|---|---|
| **F-1** | **High** | §3 — `findFirst`-then-`create` under READ COMMITTED with no unique index lets concurrent identical actions create duplicate tasks. Reproduced: 2 rows from 2 concurrent calls, and 2 rows from 8 parallel calls with no injected delay. The docblock and matrix both state the opposite as a guarantee. | Add a partial unique index on `engagement_tasks (tenant_id, source_type, source_id) WHERE source_type IS NOT NULL AND source_id IS NOT NULL` (proven in §3.3 to fix it), catch `P2002` in `act()` and re-read the winning row to return `reused: true`. Verify the index builds on production data first — duplicates may already exist. |
| **F-2** | **Medium** | §4 — on the reuse path the task keeps its original `dueDate`/`ownerUserId` while the opportunity is written with the fresh values, breaking the "same value" invariant the phase claims. | Either update the reused task to the fresh values inside the same transaction, or derive the opportunity's `nextActionDueAt`/owner from the reused task. Add a test that reuses a task **after** the deadline changed. |
| **F-3** | **Medium** | §2.2, §3.4 — P08's suite is entirely fake-backed, and the two tests named as proof of the phase's core property assert the fake's own hand-written rollback. No P08 test ever executes SQL. | Add one DB-backed test per direction against the CI Postgres the gate already provisions: a real rollback, and a real concurrent double-action asserting `count() === 1`. |
| **F-4** | **Medium** | §1.3 — the CHECK-rejection proof exists only as prose in the matrix. CI asserts constraints *exist* (`count(*) = 1`) but never that they reject, and does not assert their **definitions**. A later migration could `DROP` and re-`ADD` a same-named constraint as `CHECK (true)` and CI would stay green. | Add the six negative inserts from §1.3 to the CI gate's psql step, or assert `pg_get_constraintdef` bodies as the gate already does for `…_one_source_chk` and the parity constraints. |
| **F-5** | **Medium** | §5 — neither phase has any assertion, counter or alarm that would distinguish "working" from "silently writing nothing", the same blind spot as the zero-row producers. | Add a decision/action write counter to `diag-funding-opportunities-makegov.ts`, and a post-deploy smoke assertion that a real `/action` call produces both an `engagement_tasks` row and a `client_funding_opportunity` row with a non-null `human_decision`. |
| **F-6** | **Low** | §2 — `describeForAction()` and `assertOwnerAssignable()` each run in their **own** `withTenant` transaction *before* the write transaction opens, so pursuability and owner membership are checked on a different snapshot than the one that writes. An opportunity closing (or an owner leaving the tenant) between check and write is not caught. | Accept and document, or move both reads inside the write transaction. Low: the window is milliseconds and the consequence is a stale-but-valid pursuit. |
| **F-7** | **Low** | Brief/doc defect, §0 — the review assignment described P07 as adding RLS policies and a unique-constraint-guarded first-decision race. Neither exists. Whatever source that came from will mislead the next reviewer. | Correct the source doc. The migration's own comments are accurate; the brief is not. |
| **F-8** | **Info** | `prisma.service.ts` states the runtime role `capiro_app` "BYPASSES Postgres row-level security, so the RLS policies never fire", with isolation actually enforced by the in-query tenant-scope extension. That is in tension with `FORCE ROW LEVEL SECURITY` (which subjects even the owner to RLS), so one of the two is wrong. Either way the matrix's "RLS still ENABLED + FORCED" line asserts a net that may not be the one actually catching anything at runtime. Pre-existing (P00), outside P07/P08's scope, and P07 correctly inherits whatever the table has. | Settle empirically which is true under the production role and correct the comment or the posture. Do not treat the CI RLS assertion as proof of runtime tenant isolation until then. |

---

## Approval record

**Verdict: `BAND_A_P07_P08_REJECTED`** — 2026-08-13, by an independent agent (not
the agent that implemented, tested or merged P07 or P08), pinned to
`d800dcfde5`.

Rejected on **§3** and **§4**, both P08. Evidence:

- **§3 — reproduced, not argued.** Two concurrent invocations of P08's exact
  `findFirst`→`create` pair, on real `@prisma/client` 5.22.0 interactive
  transactions against a 263-migration replay of `pgvector/pgvector:pg16`,
  produced **two** `engagement_tasks` rows for one derived idempotency key. Eight
  genuinely parallel invocations with no injected delay produced duplicates too.
  Postgres then refused to build a unique index on
  `(tenant_id, source_type, source_id)` because of those duplicates (`23505`),
  and the same race with that index in place produced exactly one row plus one
  `P2002` — so the defect and its remedy are both demonstrated. The service
  docblock and the P08 matrix row both assert the opposite as an accepted
  guarantee.
- **§4 — invariant breaks on reuse.** A reused task retains its original
  `dueDate`/`ownerUserId` while the opportunity receives freshly-read values,
  which is the drift the phase claims to prevent. Untested: the suite checks only
  the fresh-create path.

What passed, and is recorded so the rejection is not read as broader than it is:

- **P07 passes outright.** Clean replay of all 263 migrations from empty. All six
  columns nullable with no `DEFAULT`; no backfill; three CHECKs present with
  correct definitions; decision index present, partial, and leading on
  `tenant_id`; RLS `ENABLED` **and** `FORCED` with exactly four policies. All six
  bad-data shapes named in the matrix were re-proved to be **rejected** by real
  Postgres, with two positive controls inserting and exactly three rows
  surviving.
- **P08's atomicity — the phase's actual purpose — is real.** `withTenant` is a
  genuine Prisma interactive transaction; `applyActionDecision` threads the same
  `tx` through every write including the audit row, with no hidden fallback to
  `this.prisma`. A throw after the task insert left **zero** surviving rows
  against real Postgres. This is the P48 failure mode, and P08 does not have it.
- Both spec files are green at the pinned commit: 2 suites, **57 tests**, 0
  failures, 0 skips.

**Non-blocking findings recorded even though the verdict is a rejection**, per
the template's practice of reporting them either way: F-3 (fake-backed tests for
the phase's core property), F-4 (CHECK rejection never automated; CI asserts
existence but not definitions), F-5 (no live-verifiable success assertion in
either phase), F-6 (validation reads on a different snapshot than the write),
F-7 (two false premises in the review brief itself), F-8 (RLS enforcement-vs-bypass
contradiction in `prisma.service.ts`).

**Answer to the mandatory question — recorded explicitly because it is the one
this program keeps getting wrong:** *no*, neither P07 nor P08 has any
live-verifiable success assertion that would catch the code silently doing
nothing. Both phases would look identical, to every gate in this program, whether
they were working or writing nothing at all. See §5 and F-5.

**Procedural note.** The review worktree was described as clean; it also contains
another reviewer's in-flight instruments (`apps/api/scripts/zz-review-*.ts`) and
reports (`band-a-p51-ga-closeout.md`, `band-c-attestation.md`,
`flag-ui-reconciliation.md`). None of their content was read or relied on, and
none was modified — this review is independent of them. Their Postgres is on port
`55439`; this review used its own container on `55471`, so there was no
interference in either direction.

**This review is not itself a fix.** Every finding above is queued in §7 and left
unrepaired by design, so that whoever remediates them is not the agent that
found them.
