# Runbook — defense-budget snapshot rollback V1

Returning production reads to a previously published canonical snapshot.

**Rollback deletes nothing.** It is a forward, audited pointer transition to a
prior immutable snapshot. Both snapshots survive, both remain queryable, and the
rollback itself is recorded in `defense_budget_rollback_record`. Any procedure
that involves deleting or editing a snapshot's rows is not this procedure and
must not be run.

Background: [`CANONICAL-PROMOTION-V1.md`](../defense-budget/CANONICAL-PROMOTION-V1.md).

---

## Decide first: is rollback actually the right tool?

It usually isn't. Three situations look like "roll it back" and only one is.

| Situation                                                                              | Right action                                                                                                                                                                                                  |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deltas, caches, or alerts are behind; canonical data is correct                        | **`resume`, not rollback.** Status `COMMITTED_WITH_SIDE_EFFECT_FAILURE` means the truth is published and correct. Rolling back moves financial truth backwards to fix a cache.                                |
| A value is wrong because the source was misextracted                                   | **Correction, not rollback.** Corrected source → new verification → new promotion with `--mode correction`. Rollback would restore a _different_ wrong state — the one before this cycle — not the right one. |
| The published snapshot is materially wrong or unsafe, and the prior snapshot was right | **Rollback.**                                                                                                                                                                                                 |

If you cannot state which prior snapshot was right and why, you are not ready to
roll back.

---

## Preconditions

- [ ] The target prior snapshot ID is known and was previously `ACTIVE`.
- [ ] A **separate** rollback authorization exists. The promotion authorization
      does not cover it and is single-use anyway.
- [ ] The side-effect drainer is pausable.
- [ ] You have written down what you expect reads to show afterwards, so you can
      tell success from a second failure.

---

## Sequence

### 1. Pause the drain

Stop the outbox drainer for the domain before moving the pointer. A drainer
running across a pointer transition emits deltas computed against a snapshot pair
that is no longer the live pair.

### 2. Confirm the target is eligible

```bash
status-defense-budget-promotion-v1 --domain defense_budget --details
```

Confirm the target snapshot exists, its rows are intact, and it is `SUPERSEDED`
rather than `ROLLED_BACK` or `FAILED_PRECOMMIT`.

**Stop if:** the target snapshot is not one this system previously served.

### 3. Dry-run the rollback

```bash
rollback-defense-budget-snapshot-v1 \
  --domain defense_budget \
  --to-snapshot-id <prior-snapshot-id> \
  --expected-active-snapshot-id <current-active-id> \
  --authorization-id <rollback-authorization-id> \
  --reason "<why, in a sentence a reviewer will read in six months>"
```

Without `--commit --confirm <env>` this writes nothing.

**Stop if:** the expected-active check fails. Something moved the pointer while
you were preparing; re-read the ledger before proceeding.

### 4. Commit

Re-run with `--commit --confirm <env>`.

The transaction: verify expected previous active, reactivate the prior snapshot,
mark the current one `ROLLED_BACK`, write the rollback record, and create outbox
rows with **alerts suppressed by default**.

A rolled-back snapshot cannot silently reactivate. Republishing it requires a new
promotion and a new authorization.

### 5. Verify reads

Compare against what you wrote down in the preconditions.

```bash
compare-defense-budget-canonical-reads-v1 --mode shadow --summary-only
```

**Stop if:** reads do not match the prior snapshot's expected shape. Do not
attempt a second rollback to fix a rollback.

### 6. Resume the drain

```bash
resume-defense-budget-promotion-side-effects-v1 --domain defense_budget --commit
```

Rollback outbox rows are suppressed by default. Notifying clients that data moved
backwards requires an explicit secondary authorization — it is a communications
decision, not an operational one.

### 7. Retain everything, then investigate

Keep both snapshots, all logs, the failed run, and the rollback record. Do not
retry the original promotion until you know why it was wrong. A retry of an
unexplained failure is how the same bad data gets published twice.

---

## What rollback does not do

- It does not delete the bad snapshot. That snapshot remains auditable forever.
- It does not undo side effects that already drained. Those are corrected by the
  next promotion's deltas, not by reversal.
- It does not restore manual overrides that were superseded — active overrides
  survive snapshot changes by design, so there should be nothing to restore. If
  an override appears to have been lost, that is a defect, not a rollback
  consequence; stop and report it.
- It does not clear the read mode. If you were serving `snapshot` and rolled
  back, you are still serving `snapshot`, now from the prior data. Move the read
  mode separately if you want to fall back to `legacy`.

---

## Rehearsal status

The rollback path is proven against disposable PostgreSQL as part of
`verify:pe-budget-phase-7:db`, including the `DENIED` case for history deletion
and the concurrent-activation race. **It has never been rehearsed against a real
database or a production-scale dataset,** so its duration is unmeasured.
