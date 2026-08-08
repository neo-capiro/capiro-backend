# Runbook — defense-budget canonical promotion V1

Operator procedure for publishing a verified budget cycle into canonical
production storage.

**Before you start:** this procedure has never been executed against a real
database. Steps 0–7 are rehearsed; steps 8 onward are specified but unproven.
Treat the first real run as a rehearsal with a rollback plan, not as routine
maintenance.

**Not blocked today.** All nine verbs — `plan`, `file-defense-budget-promotion-plan-v1`,
`validate`, `authorize`, `execute`, `rollback`, `status`, `compare`, and
`resume-defense-budget-promotion-side-effects-v1` — have real CLIs, wired into
`entrypoint.sh` and proven end to end against a real disposable Postgres
(Gaps 3 and 4, both closed in session 9). Never insert a plan or authorization
row by hand outside a rehearsal context — `authorize`'s whole purpose is the
segregation evidence it derives from a real, persisted eligibility record,
and a hand-written row makes authorizer-equals-reviewer silently pass.

**Two prerequisite steps added in session 10 (Gap 5).** Both are one-time per
cycle, both run under the serve role, and neither promotes anything — but a
promotion cannot be evaluated until they have happened:

- `backfill-budget-candidate-source-metadata-v1 --commit` — fills `family` and
  `extraction_method` on candidates written before migration
  `20260907010000`. Dry run by default; it performs the entire verification
  chain either way and only skips the UPDATE, so a clean dry run is real
  evidence. Fails closed per candidate: a refused row stays NULL, and a NULL
  row is refused by eligibility rather than promoted on a default.
- `persist-defense-budget-projection-plan-v1 --plan <plan.json> --family <f>
  --producer-version <id> --certification-sha256 <sha> --commit` — files the
  Phase 4/5/6 projection plan the eligibility record will name. This is a
  separate operator step **by design**, not a temporary gap: Phase 5's
  mandatory negative control NC20 forbids its planner from importing Prisma, so
  the pure-planner / separate-persist-verb split is the architecture, the same
  shape `file-defense-budget-promotion-plan-v1` uses for promotion plans. Exit
  code 3 means the plan is `BLOCKED` (it is still filed — a blocked plan is
  evidence); that blocks promotion by design.

- **For the `committee` family only**, the plan document has to be built first,
  because Phase 6 emits audit projections rather than a plan:

  ```text
  build-defense-budget-phase6-projection-plan-v1 --cycle-id <id> --fiscal-year <fy> --out plan.json
  persist-defense-budget-projection-plan-v1 --plan plan.json --family committee \
    --producer-version build-defense-budget-phase6-projection-plan-v1@1 \
    --certification-sha256 <phase6_cycle_certification.content_sha256> \
    --certification-id <phase6_cycle_certification.id> --commit
  ```

  The build verb is read-only and has no `--commit`. It reads every
  non-superseded `phase6_audit_projection` row for the cycle/FY; a `superseded`
  row is never a candidate, and an unresolved or conflicting binding becomes a
  retained `no_op`/`conflict` candidate rather than being dropped, so the filed
  plan can prove it was complete.

Background: [`CANONICAL-PROMOTION-V1.md`](../defense-budget/CANONICAL-PROMOTION-V1.md).

---

## Who may do what

| Role                            | May                                                                                                                                                                   |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| extractor / operator            | run `plan`, `validate`, `status`, `compare`                                                                                                                           |
| reviewer                        | accept or reject verification candidates                                                                                                                              |
| **authorizer** (`capiro_admin`) | issue a promotion authorization — **must not be the reviewer** for the same scope, and must not be the extractor when the extraction method is high-risk (manual/OCR) |
| executor                        | the promoter Fargate task identity. Not a person.                                                                                                                     |

The segregation rule is enforced in code from the eligibility record, not taken
from the requester. An authorizer cannot understate their own involvement.

---

## Preconditions — all must hold

- [ ] Verification candidates for the scope are terminal at `VERIFICATION_PASSED`
      or `REVIEW_ACCEPTED`. Nothing `NEEDS_REVIEW`, `REJECTED`, or `SUPERSEDED`.
- [ ] Cycle certification exists for every family in scope.
- [ ] Zero open blocking reconciliation or identity conflicts.
- [ ] Database backup taken, and the restore procedure confirmed — not assumed.
- [ ] Current AWS/CDK drift state documented. A blind full `ComputeStack`
      deploy is not an acceptable rollout method; drift is known to exist.
- [ ] `PROMOTER_DATABASE_URL` is wired to the `capiro_pe_promoter` secret and is
      **not** the app or master credential.
- [ ] Legacy canonical writes are frozen (`PE_LEGACY_BUDGET_WRITES` unset or
      `off`).

---

## Sequence

Every step has an explicit stop condition. Stop means stop — not "note it and
continue".

### 0. Freeze legacy canonical writes

The freeze is already the default: `PE_LEGACY_BUDGET_WRITES` is unset
everywhere, and the twelve legacy dispatcher verbs refuse `--commit` without it.
So this step is a _confirmation_, not a change.

Confirm all three:

- [ ] `PE_LEGACY_BUDGET_WRITES` is unset (or `off`) on every task definition.
- [ ] No EventBridge rule passes `--commit` to a legacy budget verb. Check
      `ingestion-schedule.ts` — a scheduled task that does will exit 64 rather
      than write, which is correct but shows up as a job failure.
- [ ] No path spawns a loader _around_ the dispatcher. This is not hypothetical:
      `run-pe-derive-chain.ts` used to `spawn()` the derive-budget-actions loader
      with a commit flag directly, bypassing the dispatcher gate entirely, so a
      live EventBridge rule was never actually contained. It is fixed — the gate
      is now called inside `derive-budget-actions.ts` — but any _new_ wrapper
      script reintroduces the same hole.

**Stop if:** any scheduled ingestion task can still reach a canonical writer.

### 1. Back up

Take the backup. Confirm the restore path by testing it, not by reading it.

**Stop if:** restore has not been demonstrated.

### 2. Deploy schema dark

Apply the three Phase 7 migrations through the migrate task. They are additive:
no existing table is narrowed and no data is deleted.

**Stop if:** the migration chain has not passed both fresh and
upgrade-from-production-baseline rehearsals:

```bash
pnpm --filter @capiro/api verify:pe-budget-phase-7:db
```

### 3. Deploy tasks and secrets dark

`ApiPromoterTaskDef`, `ApiPromoterLogGroup`, `PromoterSecret`. Private subnets,
no public listener, scoped task role, dedicated log group, **no schedule**, and
no LLM/vendor/parser secrets on the promoter task.

**Stop if:** the promoter task definition carries a schedule, or any vendor
secret, or the app database secret.

### 4. Create the `LEGACY_BASELINE` snapshot

Promote current production canonical data into a snapshot with
`--mode baseline_hydration`. Every item's alert disposition must be
`suppressed_hydration`.

**Stop if:** any item comes back `eligible`. A hydration that can alert is a
misdeclared mode, and it will page every client on your existing data.

### 5. Validate baseline parity

```bash
compare-defense-budget-canonical-reads-v1 --mode shadow --summary-only
```

**Stop if:** any unexplained P0/P1 mismatch. "Expected improvement" is a valid
classification; "we'll look at it after" is not.

### 6. Generate and authorize the new-cycle plan

```bash
plan-defense-budget-promotion-v1 \
  --cycle-id <id> --fiscal-year <fy> --eligibility-hash <hash> \
  --expected-active-snapshot-id <current-active> --mode new_cycle \
  > plan.json
```

Read `plan.json`. Every `BLOCKED` item is a stop, not a warning.

**Stop if:** the plan contains any `BLOCKED` item, or the plan hash is not
reproducible by re-running `plan` against unchanged inputs.

File the plan — `file-defense-budget-promotion-plan-v1` reads the same
`plan.json` `plan` already printed, recomputes its hash to prove it was not
altered in transit, and inserts it — then validate and authorize it:

```bash
file-defense-budget-promotion-plan-v1 --plan-document plan.json --commit

validate-defense-budget-promotion-v1 --plan-id <id> --expected-plan-hash <hash>

authorize-defense-budget-promotion-v1 \
  --plan-id <id> --reason "<why, for a reviewer six months from now>" \
  --expires-at <ISO 8601, short-lived> \
  --authorizer-actor-id <capiro_admin actor> \
  --authorizer-roles capiro_admin
```

`authorize` reloads the plan's real eligibility record and refuses if the
authorizer reviewed or (for high-risk extraction) extracted the same scope —
derived from that record's actual candidate bindings, not asserted by the
caller. A refusal prints `refusals` with a machine-readable `reason`; do not
retry with a different actor ID to work around a `segregation_violation` — that
refusal is the control working as intended.

### 7. Shadow-promote in a disposable context

Run the full staging and activation against a disposable PostgreSQL loaded from
a production-shaped dataset. Capture timings.

**Stop if:** measurements exceed approved budgets — and note that
**approved budgets do not exist yet**, because they must be derived from measured
production SLOs and the plan forbids inventing them. Until they are measured,
this step cannot produce a pass, only a record.

### 8. Stage the production snapshot

```bash
execute-defense-budget-promotion-v1 \
  --plan-id <id> --authorization-id <id> --expected-plan-hash <hash> \
  --expected-active-snapshot-id <current> --executor-identity <task-arn>
```

Without `--commit --confirm <env>` this is a dry run. Staged rows are invisible
to production reads.

**Stop if:** the run reports drift on the expected active snapshot. Do not
re-plan against the new state without understanding what moved.

### 9. Pre-activation checks

Every authorized plan item accounted for; no extra staged row; row hashes match
the plan; required scopes complete; referential integrity complete.

**Stop if:** any count differs from the plan by even one row.

### 10. Activate

Re-run step 8 with `--commit --confirm <env>`. Activation is one small
transaction: pointer move, ledger write, outbox rows, authorization marked used.

External alerts are suppressed at this step regardless of mode.

**Stop if:** the command returns an ambiguous result (timeout, connection drop).
**Do not retry.** Read the activation ledger first to determine whether the
commit landed — activation is exactly-once by unique key, and a blind retry
against an already-committed activation is the one path that produces a
confusing failure.

### 11. Drain side effects and project compatibility

```bash
resume-defense-budget-promotion-side-effects-v1 --domain defense_budget --commit
```

**Stop if:** the drain backlog age keeps growing after two batches. The snapshot
stays active; investigate the drainer, do not roll back.

### 12–14. Canary, compare, expand

Move read mode `shadow` → `snapshot_canary` → `snapshot`, comparing at each step.

**Stop if:** any unexplained P0/P1 read mismatch at any width.

**Note:** the canary acceptance matrix requires its own authorization and a human
operator. Code being complete is not a reason to run it.

### 15–16. Disable legacy writes permanently, then enable alerts

See [`defense-budget-legacy-cutover-v1.md`](./defense-budget-legacy-cutover-v1.md).
Enable approved alert fan-out only after the cutover is accepted.

---

## If something goes wrong

| Symptom                              | Action                                                                                                                            |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| Failure **before** activation        | Nothing was published. Fix and resume staging; retries verify row hashes.                                                         |
| `COMMITTED_WITH_SIDE_EFFECT_FAILURE` | The snapshot is active and correct. Run `resume`. **Do not roll back** — rollback moves financial truth backwards to fix a cache. |
| Ambiguous commit                     | Read the activation ledger before any retry.                                                                                      |
| Wrong data published                 | [Rollback runbook](./defense-budget-snapshot-rollback-v1.md).                                                                     |
| Bad extraction discovered later      | Corrected source → new verification → new promotion with `--mode correction`. Never edit a canonical row.                         |

---

## What this runbook cannot tell you yet

- Expected wall-clock for staging and activation at production scale — unmeasured.
- Acceptable lock-wait and read-latency deltas — unmeasured.
- How long the outbox drain takes for a full cycle — unmeasured.

Fill these in from the first production-scale rehearsal. Do not populate them
with estimates; an invented threshold that a real run passes is worse than an
absent one.
