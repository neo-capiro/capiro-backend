# Runbook — defense-budget legacy cutover V1

Retiring the direct canonical budget writers, permanently.

This is the last step of the rollout and the only irreversible one. Everything
before it can be undone with a pointer move; this removes the old path.

Background: [`CANONICAL-PROMOTION-V1.md`](../defense-budget/CANONICAL-PROMOTION-V1.md).

---

## The three layers

Legacy containment is defence in depth, deliberately. Each layer catches what the
one above it misses:

| Layer        | Mechanism                                            | Catches                                          |
| ------------ | ---------------------------------------------------- | ------------------------------------------------ |
| **Runtime**  | `PE_LEGACY_BUDGET_WRITES` kill switch, default `off` | an operator running an old verb by habit         |
| **Static**   | architecture gates in `verify:pe-budget-phase-7`     | a future change re-importing a canonical writer  |
| **Database** | grants — legacy task roles have no canonical write   | everything else, including code you haven't seen |

The database layer is the real boundary. The other two exist so that a violation
fails early and says what to do instead, rather than failing as a permission
error three services deep.

---

## The frozen verbs

Twelve dispatcher verbs write, rebuild, or repair canonical budget rows with no
verification binding:

```text
backfill-appropriation-type      match-pe-mentions
derive-budget-actions            reconcile-stale-pes
ingest-defense-budget            repair-pe-thousands-as-millions
load-om                          seed-demo-client
load-om-op5                      sync-jbook-r2
load-pdoc-enrichment             watch-budget-docs
```

Their canonical `--commit` path is refused; their inspect and extract behaviour
is retained where it is safe, because losing the ability to _look_ at a document
is a real capability loss with no safety benefit.

The refusal message names the replacement workflow rather than just denying:

```text
Canonical budget data now enters through the promotion workflow, which binds
every row to a verified projection, a plan hash, and an independent
authorization:
  plan-defense-budget-promotion-v1 → validate → authorize → execute
```

### The operational consequence, already live

`PE_LEGACY_BUDGET_WRITES` is unset everywhere. That means **any scheduled ECS
task that passes `--commit` to one of these verbs exits 64 on its next run** —
refusing rather than writing, which is correct, but it surfaces as a job failure
rather than as a deliberate freeze. `capiro-dev-watch-budget-docs` is the known
case, and it was accepted knowingly: no canonical snapshot has ever been
activated in any environment, so there is no new system to hand that job to yet.

Check `ingestion-schedule.ts` before any deploy that touches these verbs.

### The bypass that existed, and what it means for new code

The gate lives at the dispatcher, so a script that spawns a loader _around_ the
dispatcher is not gated at all. `run-pe-derive-chain.ts` did exactly that —
`spawn()`-ing `derive-budget-actions.ts --commit` directly — which meant the live
`capiro-dev-pe-derive-chain` rule was never contained by the kill switch despite
the switch being correct.

It is fixed by calling `legacyBudgetCommitDecisionV1` inside
`derive-budget-actions.ts` itself, so the refusal happens before any database
connection. The general lesson: **a new wrapper script reintroduces the hole.**
This is why database grants, not the runtime switch, are the real boundary.

### Where the switch lives, and why not in the writer

The obvious place is inside `ProgramElementWriterService`. That is the wrong
place: it is the shared write path for ordinary product behaviour, not only for
budget loading. A default-off gate inside it would refuse writes the product
still legitimately makes.

"Direct legacy canonical writes" are a set of **operator actions**, not a code
path — so the entry point is where they are gated, and it is also where a refusal
can say what to do instead.

### The read mode can veto, and cannot be vetoed

`PE_LEGACY_BUDGET_WRITES=allow` is the deliberate operator override. It is not
absolute. Once **any** tenant is served from a snapshot, a legacy writer mutating
the compatibility tables underneath produces a divergence indistinguishable from
a promotion defect — and the shadow dashboard an operator is using to decide
whether to proceed becomes untrustworthy.

So `snapshot` and `snapshot_canary` read modes refuse legacy writes regardless of
the override, and the refusal says which of the two reasons applied.

---

## Sequence

Run only after the canary is accepted at full width. Not before.

### 1. Confirm the snapshot path is carrying real traffic

```bash
compare-defense-budget-canonical-reads-v1 --mode shadow --summary-only
```

**Stop if:** any unexplained P0/P1 mismatch remains. This is the last point at
which falling back to `legacy` is cheap.

### 2. Confirm the runtime switch has been off, not just set off

Check that no legacy budget verb has run with `--commit` since the freeze. If one
did, the compatibility tables may have drifted from the snapshot, and the parity
you measured in step 1 measured the wrong thing.

**Stop if:** any legacy commit is found after the freeze timestamp.

### 3. Revoke the database grants

Remove canonical write grants from every legacy task role: the API serve role,
the scheduled-ingestion role, the parser role, and the verifier role. After this,
`capiro_pe_promoter` is the only role that can write canonical rows.

**Stop if:** revoking breaks any non-budget product workflow. That means a table
is serving two categories at once — canonical truth and product data — which must
be separated before continuing, not worked around with a grant.

### 4. Enable the permanent static gates

The architecture gates ban legacy budget writers from J-book loaders, P-doc
loaders, committee/public-law loaders, the generic ingest commit path, and
rebuild/repair scripts.

```bash
pnpm --filter @capiro/api verify:pe-budget-phase-7
```

### 5. Remove immediate outbox processing from the old writer

For migrated budget paths only. The promotion outbox is now the only path to
downstream effects, and two emitters produce duplicate deltas.

### 6. Enable approved alert fan-out

Only now. Alerts before this point would fire on hydration and cutover noise.

---

## Rollback of the cutover itself

There isn't a clean one, which is why it is last.

Restoring legacy write capability means re-granting database permissions and
re-enabling the runtime switch — and then the compatibility tables and the active
snapshot begin to diverge immediately, with no mechanism to reconcile them. If
you need the legacy path back, the honest move is:

1. Move read mode back to `legacy`.
2. Re-grant.
3. Treat the active snapshot as stale and rebuild it from a fresh promotion when
   you return.

Do not run both paths against the same tables and hope they agree.

---

## Inventory to complete before this runbook can be signed off

The plan requires a per-path inventory: path/command, prior behaviour, new
behaviour, runtime gate, static gate, DB-grant status, and remaining noncanonical
inspect capability.

The twelve verbs above have their runtime gate and refusal message shipped. **The
DB-grant column is unfilled for every row**, because the grants have not been
revoked in any environment. That inventory is completed by executing step 3, not
before it.
