# Defense budget approval replacement v1

This runbook describes the bounded, resumable replacement of scoped R-2 PE
approvals after one extraction candidate corrects another. It is an operator
contract, not authorization to change production data. Production use still
requires an explicitly approved maintenance window and separately reviewed
candidate, manifest, reviewer, and revoked-row acknowledgements.

## Visibility contract

The command is intentionally sequential:

1. A dry-run preflight verifies the exact old/new candidate, current run,
   source, extraction artifact, manifest, selected scopes, amount, page,
   assertions, evidence, and live eligibility. It writes nothing.
2. One transaction supersedes all active scoped reviews on the old candidate
   and appends the immutable correction link with the complete reviewed
   operation intent.
3. Each selected replacement approval commits in its own fenced transaction.
4. One set-based statement observes every newly approved or already approved
   ledger row and validates its full identity at one database timestamp.

After step 2, old approvals are already superseded while replacement progress
can be anywhere from 0 through N. Read surfaces can therefore temporarily show
0..N replacement approvals. Reconciliation and resumability do not make those
commits atomically visible. Use a bounded, explicitly approved maintenance
window for this design. If a zero-gap display is required, design a separate
staged/atomic-visibility mechanism; this command does not provide one.

## Rollout and pre-deploy audit

Deploy the additive migration before application code and do not run
correction/review traffic during a mixed-version rollout. The migration keeps
legacy rows readable and revocable, but new scoped reviews must use the
sanctioned repository path and its locked eligibility recheck.

The sanctioned correction, scoped-review, and verification-evidence writers
explicitly use PostgreSQL `READ COMMITTED`. Their advisory-lock guards depend
on a fresh statement snapshot after a wait; the database triggers therefore
fail closed for writes attempted at `REPEATABLE READ` or `SERIALIZABLE`, with
named `*_requires_read_committed` errors. If one appears, stop that custom/raw
writer and retry only through the sanctioned path at `READ COMMITTED`; do not
disable the trigger or lower isolation for unrelated work in the transaction.

Run the following queries read-only after the additive migration commits and
before resuming application writers or serving traffic. Any returned row needs
human investigation; do not auto-repair it as part of deployment.

```sql
-- Existing correction cycles.
WITH RECURSIVE correction_walk AS (
  SELECT c.old_candidate_id AS origin,
         c.new_candidate_id AS node,
         ARRAY[c.old_candidate_id, c.new_candidate_id]::uuid[] AS path,
         c.old_candidate_id = c.new_candidate_id AS cycle
    FROM budget_candidate_correction_v1 c
  UNION ALL
  SELECT w.origin,
         c.new_candidate_id,
         w.path || c.new_candidate_id,
         c.new_candidate_id = ANY(w.path)
    FROM correction_walk w
    JOIN budget_candidate_correction_v1 c
      ON c.old_candidate_id = w.node
   WHERE NOT w.cycle
)
SELECT origin, node, path
  FROM correction_walk
 WHERE cycle;

-- Active reviews left on candidates that have already been corrected away.
SELECT r.id, r.candidate_id, r.scope_key, c.id AS correction_id
  FROM budget_scoped_fact_review_v1 r
  JOIN budget_candidate_correction_v1 c
    ON c.old_candidate_id = r.candidate_id
 WHERE r.status = 'active';

-- Active reviews whose candidate/current run, verification-run eligibility,
-- or immutable candidate/run hashes no longer agree.
SELECT r.id, r.candidate_id, r.run_id, r.scope_key,
       c.status AS candidate_status, v.decision AS run_decision
  FROM budget_scoped_fact_review_v1 r
  JOIN budget_extraction_candidate_v1 c ON c.id = r.candidate_id
  LEFT JOIN budget_verification_run_v1 v ON v.id = r.run_id
 WHERE r.status = 'active'
   AND (c.current_run_id IS DISTINCT FROM r.run_id
      OR c.status NOT IN ('NEEDS_REVIEW', 'REVIEW_ACCEPTED')
      OR c.source_document_id IS DISTINCT FROM r.source_document_id
      OR c.source_sha256 IS DISTINCT FROM r.source_sha256
      OR c.extraction_artifact_id IS DISTINCT FROM r.extraction_artifact_id
      OR c.extraction_artifact_sha256 IS DISTINCT FROM r.extraction_artifact_sha256
      OR c.manifest_content_sha256 IS DISTINCT FROM r.manifest_content_sha256
      OR v.candidate_id IS DISTINCT FROM r.candidate_id
      OR v.decision IS NULL
      OR v.decision NOT IN ('PASS', 'REVIEW')
      OR v.source_sha256 IS DISTINCT FROM r.source_sha256
      OR v.extraction_artifact_sha256 IS DISTINCT FROM r.extraction_artifact_sha256
      OR v.manifest_content_sha256 IS DISTINCT FROM r.manifest_content_sha256);

-- Grandfathered active reviews with no Package C eligibility seal.
SELECT id, candidate_id, run_id, scope_key, created_at
  FROM budget_scoped_fact_review_v1
 WHERE status = 'active'
   AND (eligibility_state_version IS NULL
     OR eligibility_state_sha256 IS NULL)
 ORDER BY created_at, id;

-- Legacy correction links without durable reviewed-intent snapshots.
SELECT id, old_candidate_id, new_candidate_id, created_at
  FROM budget_candidate_correction_v1
 WHERE reviewed_intent_version IS NULL
    OR reviewed_intent_jsonb IS NULL
    OR reviewed_intent_sha256 IS NULL
 ORDER BY created_at, id;
```

The null eligibility seal on a pre-migration review is explicitly
grandfathered: its immutable legacy decision hash is not rewritten. Serving
may continue only after the inventory above is reviewed against the deployment
assumption that no late verification evidence was appended to that run. A new
review always carries a versioned seal. Likewise, a legacy correction link is
preserved, but it cannot be treated as proof of a Package C reviewed intent.
The replacement command therefore refuses even a same-pair replay of a legacy
NULL-intent link with `correction_intent_mismatch`; it cannot safely infer the
old operator's selected scopes. For an interrupted legacy replacement, leave
the immutable link intact, inventory the new candidate's active scopes, and
use separately reviewed ordinary scoped-review actions for each missing scope
under an approved recovery plan. Do not backfill intent onto the legacy link or
turn the refusal into an automatic acknowledgement.

Do not roll back by dropping the new audit columns or acknowledgement history.
If a migration defect is found, stop writers and ship a forward corrective
migration.

## Preview and execution

Always preview first with the exact versioned manifest:

```bash
pnpm --filter @capiro/api replace:defense-budget-candidate-approvals-v1 -- \
  --old-candidate-id <old-uuid> \
  --new-candidate-id <new-uuid> \
  --reapproval-manifest <reviewed-manifest.json> \
  --actor <operator-id> \
  --reviewer-id <reviewer-id> \
  --correction-reason-file <reviewed-reason.txt>
```

After authorization, run the identical command with `--commit`. The database
is the durable ledger. Stdout reports `APPROVED`, `ALREADY_APPROVED`, `FAILED`,
or `RECONCILIATION_CONFLICT` per scope; it is an operator view, not a separate
source of truth.

## Exit and recovery contract

- Exit 0 means every manifest scope was observed active and exactly bound in
  the final one-statement snapshot. The message includes `observedAt`; a human
  may legitimately revoke a row after that timestamp.
- Exit 1 means usage/preflight failure or a correction-stage refusal/failure
  before this process confirmed a durable correction. Preflight refusal writes
  nothing; step 2 is unstarted. If a correction-stage transport/runtime result
  is uncertain, inspect the append-only correction table before retrying.
- Exit 2 means the correction is durable (or was already present) but only
  0..N replacement reviews were confirmed complete. This includes unexpected
  runtime interruption after the correction committed. The final ledger names
  every scope; `FAILED` means incomplete or unconfirmed, not necessarily that
  no write occurred. Re-read Postgres, resolve the condition, and rerun the
  same immutable intent.
- Exit 3 means a row counted complete changed before final reconciliation, or
  the authoritative final observation itself failed. The ledger is relabeled
  `RECONCILIATION_CONFLICT` where applicable and every unobserved scope is
  named; the command does not claim success.

A crash or exit 2 needs no local state file: rerun the exact candidate pair,
manifest, actor/reviewer, and reason. The correction replay is a no-op and
active exact approvals are skipped. A normal resume never recreates a human-
revoked review. Intentional reapproval is a new reviewer action: update that
scope to a fresh rationale and pass only the exact latest row printed by the
ledger:

```text
--acknowledge-revoked-scope <scopeKey>=<exact-revoked-review-id>
```

Never add acknowledgements automatically to make a retry pass. A later
revocation invalidates an older acknowledgement at the write boundary.

There is no reverse-correction rollback. Revoke an incorrect individual
approval through the ordinary scoped-review revocation path. If the correction
link itself was wrong, preserve it and correct the replacement candidate
forward into a third candidate. Reverse/cyclic links are refused.

## Disposable rehearsal

The supported local proof owns and removes its Postgres container and uses
only synthetic candidates/artifacts:

```bash
pnpm --filter @capiro/api run verify:replace-defense-budget-candidate-approvals-v1:db
```

It validates and regenerates Prisma Client, seeds a real pre-Package-C row,
applies the migration, proves legacy resume/revoke behavior, and runs the
replacement, held-lock concurrency, reconciliation, and serving-read suites.
The replacement suite includes BA2-shaped 17-scope and BA3-shaped 21-scope
synthetic rehearsals. These are evidence only; they do not authorize operating
on the reported real BA2 or BA3 approvals.
