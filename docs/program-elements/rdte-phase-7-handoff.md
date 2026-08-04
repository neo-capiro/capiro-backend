# RDT&E Phase 7 Handoff — Canonical Promotion from the Projection Plan

Phase 4 produces `rdte_canonical_projection_plan_v1` — a deterministic,
read-only description of the exact future canonical records. Phase 7
performs governed writes from that plan. **No semantic decision may be
deferred to Phase 7**: every eligibility, disposition, role, and period
decision is already encoded in the plan (candidates, exclusions, values,
provenance). Phase 7 that reinterprets source semantics is out of contract.

## Projection record types → canonical targets

| Plan target | Canonical table | Natural key | Notes |
|---|---|---|---|
| `ProgramElement` | `program_element` | `pe_code` | R-1-owned identity; narrative merges into `description` deterministically |
| `ProgramElementYear` | `program_element_year` | `(pe_code, fy)` | budget-year request only (`canonical_request_candidate`) |
| `ProgramElementBudgetPosition` | `program_element_budget_position` | `(pe_code, position_cycle, asserted_fy, value_kind)` | PE FYDP positions of the printing cycle |
| `ProgramElementProject` | `program_element_project` | `(pe_code, project_code)` | project_code VarChar(32), never truncated |
| `ProgramElementProjectBudgetPosition` | `program_element_project_budget_position` (Phase 4 migration) | `(pe_code, project_code, position_cycle, asserted_fy, value_kind)` | project FYDP positions |
| `ProgramElementPerformer` | `program_element_performer` | existing natural key + `fy` | role-honest; totalCost is cost-analysis only |
| `ProgramElementMilestone` | `program_element_milestone` | `(pe_code, milestone_type)` | exact dates only when source-printed |
| `ProgramElementMilestoneSchedulePeriod` | `program_element_milestone_schedule_period` (Phase 4 migration) | `(milestone_id, period_role, raw_text)` | truthful periods, never fabricated |
| `ProgramElementSource` | `program_element_source` | `(pe_code, doc_type, source_url, page_number)` | page-level citations |

Every candidate carries: artifact ID/content SHA, verification
candidate/run/decision IDs, source document key + PDF SHA, assertion IDs,
evidence IDs, operation intent (insert/update/no-op/conflict), reason, and
exact values.

## Write requirements

### Transaction boundary
One transaction per cycle promotion: all inserts/updates for a certified
plan apply atomically or not at all. Conflict candidates (`operation:
conflict`) are NEVER written — they route to review before any re-run.

### Idempotency
Upsert by the natural keys above. Re-applying the same plan (same
`contentSha256`) is a no-op; a changed plan SHA implies a changed cycle and
must be promoted as a new governed run. Record the promoted plan SHA in the
run metadata.

### Exact verification-run binding
Every written row's provenance metadata must carry the plan's
`verificationCandidateId`, `verificationRunId`, and `verificationDecisionId`
verbatim. A row written without a VERIFICATION_PASSED (or immutably
review-accepted) decision behind it is a contract violation.

### Outbox behavior
Canonical mutations emit `program_element_change_outbox` rows (existing
table) with `dedupeKey` derived from `(plan SHA, natural key, operation)` so
downstream consumers see exactly one event per logical change.

### Source-value provenance
Preserve into the row's `metadata`/`raw` JSON: original value + unit,
`positionCycle`, artifact ID, assertion IDs, evidence IDs, physical +
printed page. Monetary fields store the millions value; the original
decimal string rides in provenance (never floats).

### Rollback
Rollback = restore from the pre-promotion snapshot of the affected tables
(documented snapshot taken inside the promotion transaction's preparation)
and mark the run rolled-back. Because writes are keyed and provenance-bound,
a plan-level revert never orphans rows: delete by `metadata.planSha` is the
last-resort path and requires explicit human approval.

### Legacy direct-loader containment
`sync-comptroller-jbooks.ts`, `sync-jbook-r2.ts`, and
`sync-jbook-performers.ts` write canonical rows directly today. Phase 7
must disable/contain their commit paths for RDT&E families before the first
governed promotion of the same families, so two writers never race on the
same natural keys. (Phase 4 intentionally did not rewrite them.)

### Read-model refresh
After promotion, refresh the read models the profile UI consumes
(`program-element-read.service`) from the canonical tables only. The
projection plan itself is never a read-model source.

### Alert suppression for initial hydration
The first full-family hydration will produce bulk change events. Suppress
delta/alert notifications for runs flagged `hydration: true` in the run
metadata; normal alerting resumes on subsequent cycles.

## What Phase 4 already guarantees

- Certified-cycle-only planning (planner refuses uncertified bundles);
- artifact ID + content-SHA binding to the certified bundle;
- exclusions ledger (rejected / needs-review / contextual / non-annual /
  outyear-not-request / duplicate-conflict / unsupported-role /
  unresolved-evidence) with per-assertion reasons;
- deterministic plans (permutation-invariant, canonical-JSON SHA);
- read-only diff classification (insert/update/no-op) against a canonical
  row snapshot — no writer import anywhere in the Phase 4 surface.
