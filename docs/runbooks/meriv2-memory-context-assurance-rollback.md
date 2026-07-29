# Runbook — MeriV2 memory / context / assurance ROLLBACK

**Nothing in this runbook has been executed.** Every step is a proposal. No
migration has been applied, no image deployed, no flag written. Steps marked
**MUTATING** require Neo's explicit approval before running.

Scope: undoing the MeriV2 Phase 2–4 closeout (PR #679, branch
`agent/meriv2-world-class-closeout`) in production. Paired with the rollout
runbook; this document is the one you reach for at 2am.

Environment reminders (from prior incidents):

- **`capiro-dev` IS production.** There is no separate prod cluster.
- **`capiro-staging`'s ECS cluster does not exist**, despite CloudFormation
  reporting `CREATE_COMPLETE`. Never treat it as a rollback target.
- **Do NOT run `cdk deploy Capiro-dev-Compute`.** That stack holds dead-ALB
  values; a rollback reverts production DNS (7-minute outage).
- Deploys go via CI + `aws ecs update-service`, profile `capiro-dev`.
- Log group `/capiro/dev/api`. Diag task `capiro-dev-api-diag`, container
  `db-inspect`; it must compose `DATABASE_URL` itself and set `app.bypass_rls`
  for RLS-forced tables.

---

## Ordering principle

**Turn behaviour off before you take code away, and never drop a column during
an incident.** Every control in this closeout is either env-gated or additive,
so the fast, safe rollback is always a *mode flip*, not a migration.

Escalation ladder, cheapest first:

| # | Action | Blast radius | Reversible? |
| --- | --- | --- | --- |
| 1 | Flip a feature mode to `off` | one behaviour | instantly |
| 2 | Stop the outbox drain | cleanup lag only | instantly |
| 3 | Roll the application image back | all MeriV2 behaviour | minutes |
| 4 | Roll back a backfill job | governed columns | drift-checked |
| 5 | Roll back a policy-pack version | action policy | audited |
| 6 | Drop additive columns | **destructive** | no — last resort |

Do not skip down the ladder. Rungs 1–3 resolve almost every incident.

---

## 1. Turn feature modes off (no deploy required)

These are read from the environment at request time, so a service restart with
changed env is sufficient — no image rebuild.

| Variable | Armed value | Rollback value | Effect of rollback |
| --- | --- | --- | --- |
| `CONTEXT_PACKET_V2` | `enforce` | *unset* or any other string | Context Packet v2 stops compiling; every surface returns to v1 context. The parser admits **only** the exact string `enforce`, so any other value is off. |
| `MERI_RELEASE_GATE` | `enforce` / `annotate` | *unset* | High-risk release gate stops holding output. |
| `MERI_AUDITOR_MODE` | `enforce` | `annotate` | Grounding audit keeps running and keeps writing `meri_audit_ledger` evidence, but stops withholding bodies. **Prefer `annotate` over `off`** — see §3. |
| `MEMORY_GOVERNANCE_LIFECYCLE` | on | *unset* | `markDecided` returns to the pre-governance single-row write. |

```bash
# MUTATING — requires approval
aws ecs update-service --cluster capiro-dev --service capiro-dev-api \
  --force-new-deployment --profile capiro-dev
```

Verify with a fresh log line, not with the task definition:

```bash
# READ-ONLY
aws logs filter-log-events --log-group-name "/capiro/dev/api" \
  --start-time $(( ($(date +%s) - 600) * 1000 )) \
  --filter-pattern '"context_packet"' --max-items 20 --profile capiro-dev
```

> `MSYS_NO_PATHCONV=1` is required on Git Bash or the log-group path is mangled
> into a Windows path and the call fails validation.

---

## 2. Revert to v1 context behaviour specifically

If context is the only suspect, `CONTEXT_PACKET_V2` alone is the whole rollback.
v2 is additive at every call site: `contextPacketV2Overrides` returns `{}` when
the switch is not armed, so the compiled request is byte-for-byte the pre-v2
one. No packet rows need deleting — stale `context_packet` rows are inert
metadata and are safe to leave for forensics.

**Do not** roll back the ethical-wall change to get client context back. If
client memory has vanished from packets after arming v2, the cause is a wall
denial or an adapter not selecting governed columns — both are diagnosed with
the exclusion counts on the packet, and the correct response is to disarm v2
(above), not to reopen the wall.

---

## 3. Disable release enforcement WITHOUT losing audit

The common mistake is setting `MERI_AUDITOR_MODE=off`, which also stops the
evidence you need to explain the incident afterwards.

- `annotate` — audit runs, findings are recorded and banner-prefixed, nothing is
  withheld. **This is the correct incident setting.**
- `off` — no audit, no ledger rows, no evidence.

Same for `MERI_RELEASE_GATE`: prefer `annotate` to `off`.

---

## 4. Stop the outbox consumers safely

The memory cleanup outbox is drained out-of-band by an entrypoint verb, not an
in-process scheduler, so "stopping the worker" means not running the task.

```bash
# READ-ONLY — how much work is queued and how old is it?
#   SELECT status, count(*), min(created_at)
#     FROM memory_cleanup_outbox GROUP BY status;
```

Stopping the drain is **safe by design**: canonical status transitions suppress
governed recall synchronously, inside the caller's transaction. A pending
cleanup means a secondary projection (`clio_memory`, `context_embeddings`) is
stale, which can degrade semantic recall — it can **never** re-authorize revoked
memory. Let the queue build; it is idempotent on resume.

Do **not** delete outbox rows to "clear a backlog". A deleted
`revoke_projections` job leaves a revoked memory's projection alive forever.

---

## 5. Roll the application back

```bash
# READ-ONLY — what is running now?
aws ecs describe-services --cluster capiro-dev --services capiro-dev-api \
  --query 'services[0].taskDefinition' --profile capiro-dev
```

```bash
# MUTATING — requires approval. Pin the previous revision.
aws ecs update-service --cluster capiro-dev --service capiro-dev-api \
  --task-definition capiro-dev-api:<PREVIOUS_REVISION> --profile capiro-dev
```

Roll `capiro-dev-api`, `capiro-dev-web` and the orchestrator **together** if the
context contract changed: the v2 request shape crosses all three.

**The additive migrations stay applied.** Older code ignores the new columns.
Rolling the schema back to meet the code is the failure mode that causes a
second, worse incident.

---

## 6. Roll back a governance backfill job

> Not yet implementable — `apps/api/scripts/rollback-memory-governance-v2.ts`
> **does not exist** (plan §5 is unstarted). Recorded here so the gap is visible
> rather than discovered during an incident.

Intended contract once written: requires tenant id **and** job id **and**
explicit confirmation; restores a row only when its governed fields still hash
to the expected post-backfill value, and **skips with a drift report** when a
human reviewer has since changed the row. Until it exists, a backfill is
effectively one-way — which is a reason not to run one in production yet.

---

## 7. Roll back a policy-pack version

Published pack versions are immutable, so rollback is *publishing the prior
reviewed version*, never editing one in place. The replaced version is retired
with audit evidence. Approvals bound to the old pack hash are invalidated and
require reapproval — expected, not a bug.

---

## 8. Governed-memory behaviour that is code, not config

Two closeout changes are deliberately **not** flag-gated, because a flag
defaulting off would have left the defect live in production. Rolling either
back is a code revert plus a deploy (rung 3):

| Change | Commit | Why no flag |
| --- | --- | --- |
| Firm/client memory can no longer be self-ratified by its proposer | `b1cf7dd6` | A default-off flag leaves shared institutional truth self-approvable — the finding itself. |
| Embedding writeback targets the exact row id | `b1cf7dd6` | The previous behaviour overwrote other clients' vectors. There is no state in which the old predicate is preferable. |

Operational note for the first: after this ships, firm- and client-scope saves
land in the review queue instead of committing inline. A sudden rise in pending
candidates is the **expected** signal, not an incident. Watch
`memory_candidate` pending-count-by-age; if the queue is genuinely unmanageable,
the answer is more authorized reviewers or a grant, not reverting segregation of
duties.

---

## 9. Last resort — dropping additive columns

Only if a column is actively breaking writes and rungs 1–5 have failed.

Requires: a fresh snapshot, Neo's explicit approval, and a written decision
record. Governed columns carry review decisions that exist nowhere else, so a
drop is **irreversible data loss of audit evidence**. Prefer leaving the columns
and disabling the code that reads them.

---

## Verification after any rollback

1. Service healthy and on the intended digest — check the running task
   definition, not the CloudFormation template.
2. A real chat turn returns an answer (not a hold).
3. `/capiro/dev/api` shows no new `ERROR` lines in the last 10 minutes.
4. Context Inspector opens and reports a packet, or truthfully reports that
   trace persistence is unavailable — it must not claim a packet id it does not
   have.
5. Outbox oldest-pending age is falling, or the drain is intentionally stopped
   and that decision is recorded.
