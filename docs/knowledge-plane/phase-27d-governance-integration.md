# Phase 27D — Governance Integration & Supersession Execution

Phase 27C detected and flagged: a learning-signal-derived `MemoryCandidate`
that probably duplicates or contradicts an active `memory_items` row got
`contradictsMemoryItemId` + `conflictStatus: 'open'` set — on the candidate
only. The active item was never read for a write. Phase 27D is the first
phase allowed to resolve that flag into a real change to active memory.

## What this is — one new method, not a new governance system

`ImmutableMemoryVersionService.decideLearningSignalCandidate` (`apps/api/src/memory/`)
is the ONE canonical path that may activate/supersede memory as a result of
a learning-derived candidate. It is a new method on the EXISTING class that
already does exactly this for the human correction/contradiction/restore
flow — not a new service, not a new table, not a second review queue. It
reuses `insertVersion`/`supersedeOne`/`openConflict`/`linkDuplicate`/
`finishCandidate` byte-for-byte: the same locking, the same migration-
trigger capability gate, the same `memory_transition_audit` writer, the
same cleanup-outbox enqueue.

`MemoryCandidateReviewService` (the existing kind-dispatching review
facade) grew a fourth `candidateKind`: `'learning_signal_conflict'` —
computed by the new pure `candidateKindFor()` (`memory-version.helpers.ts`)
from the candidate's OWN `contradictsMemoryItemId`/`conflictStatus`, not
just its `sourceKind`. A learning_signal candidate with no open conflict
flag is still `'standard'` — nothing for governance to resolve.

## The six decisions

| Decision | Mechanism | Active memory effect |
|---|---|---|
| `approve_new` | `MemoryCandidateReviewService.approve()` — same as `'standard'`, no new code | New independent row. Flagged item untouched. |
| `reject` | `MemoryCandidateReviewService.reject()` — same as `'standard'`, no new code | None. Candidate → `rejected`. |
| `duplicate` | `decideLearningSignalCandidate` → `linkDuplicate` | Flagged item's `last_confirmed_at` bumps. No new row. |
| `corroborate_existing` | Same mechanism as `duplicate`, distinct outcome label | Same — existing memory stays canonical; repeated evidence strengthens confirmation, never authority. |
| `supersede_existing` | `insertVersion` (parentId=target) + `supersedeOne` + `finishCandidate` | Old row → `superseded`. New row → `active`, `supersedesId` = old. |
| `conflict_requires_review` | `insertVersion` (contradictsId=target) + `openConflict` + `finishCandidate` | Old row → `governed_status='conflicted'` (status unchanged). New row → `conflicted`, sharing a `conflict_group_id`. A human still resolves the group later via the pre-existing `MemoryConflictService.resolve`. |

`approve_new`/`reject` deliberately add zero new mutation code — a learning-
signal-conflict candidate approved or rejected as a false positive is
indistinguishable, at the write layer, from any other candidate approval or
rejection. Only the four genuine conflict resolutions reach the new method.

## The core example, resolved

```
ACTIVE:     "Client wants monthly congressional updates."
CANDIDATE:  "Client wants weekly congressional updates."
```

A reviewer picks `supersede_existing`. Atomically: the monthly-cadence row
becomes `superseded` (never deleted — content, provenance, approval
history, and audit trail all survive under its old id); a new row carrying
the weekly-cadence text becomes `active` with `supersedesId` pointing at
the old row. `A → superseded_by → B`, exactly as specified — never `B`
overwriting `A` in place.

## Atomicity

One transaction (`PrismaService.withTenantUser`), one `tx` handle, no
`$transaction([...])` array — the same convention `approveCandidate`
already uses. Every UPDATE that must affect exactly one row asserts
`changed !== 1` and throws before the next step runs: if `supersedeOne`'s
row lock is lost to a concurrent change, `finishCandidate` never executes,
the new row exists but the candidate stays `pending` and unresolved (the
whole Postgres transaction rolls back — the mocked-transaction unit tests
prove the code-level ordering; the real atomicity guarantee is the
surrounding real transaction, same as every other mutator in this module).

## Concurrency and idempotency

The governing lock query
(`lockLearningSignalConflictCandidate` — `FOR UPDATE ... WHERE status =
'pending' AND source_kind = 'learning_signal' AND contradicts_memory_item_id
IS NOT NULL AND conflict_status = 'open'`) is the same idiom every other
candidate-decision lock in this module already uses. A second concurrent
decision attempt on the same candidate finds no matching row (the first
decision already flipped `status` away from `'pending'`) and gets a 404,
never a second write.

## Authorization

- `resolve_conflict` — an existing `MemoryPermission` (`memory-authorization.helpers.ts`,
  predates this phase) — gates every genuine conflict resolution. `approve`/
  `review` continue to gate `approve_new`/`reject` exactly as they already
  did for `'standard'`.
- Segregation of duties: the same explicit self-approval ban
  `approveCandidate` already enforces for shared scope
  (`candidate.proposed_by === ctx.userId && !isMemoryReviewAdminRole(...)`)
  is duplicated verbatim in `decideLearningSignalCandidate` — not left to
  `evaluateGovernedMemoryAuthorization` alone, which does not itself ban
  self-review for `resolve_conflict` (only for `approve`/`review`).
- `legal_hold` blocks `supersede_existing` (it fully retires the flagged
  row's `status`, mirroring why `approveCandidate` blocks a held item's
  `correction`) but not `conflict_requires_review`/`duplicate`/
  `corroborate_existing` (none of those change the flagged row's `status`
  column) — mirroring the existing correction-vs-contradiction asymmetry
  exactly rather than inventing a new policy.

## AI feedback-loop protection

`linkDuplicate` (the mechanism behind both `duplicate` and
`corroborate_existing`) never writes `memory_authority` — only
`last_confirmed_at`. `insertVersion`'s `memory_authority` is a pure function
of `memory_scope` (`firm→firm_approved`, `client→client_approved`, else
`user_asserted`) — it has never been a function of corroboration count or
provenance lineage, in this phase or any prior one. Repeated evidence
(including two generations from the same AI lineage, were that to reach a
governed decision at all) cannot compound into a stronger authority tier
through this mechanism; there simply is no code path that reads "how many
times has this been confirmed" and writes a stronger authority as a result.
Tested explicitly in `learning-signal-governance.spec.ts`.

## Rejection durability

`LearningSignalCandidateService.findExactDuplicate` (CRM path — the only
surface with a stable dedup key pre-27D; extending Meri's is the same
disclosed 27B/27C gap, still deferred) now matches `'rejected'` alongside
`'pending' | 'approved' | 'auto_committed'`. A signal for the exact same
`(clientId, kind, targetKey)` as an already-rejected candidate is recorded
`eligibility: 'duplicate'` again — no new taxonomy value, no migration —
with the outcome's `reason` text distinguishing "already rejected" from
"already pending/active," and `memoryCandidateId` linking straight to the
earlier candidate for audit. Deliberately no automatic "stronger
independent evidence" override: building a real evidence-strength
comparison with no product surface to drive it would be speculative;
suppression is unconditional today, and a genuinely new candidate for the
same proposition remains possible only through an explicit, auditable path
that does not exist in any surface yet — not automatically inferred.

## Duplicate/corroboration handling

Both routes converge on `linkDuplicate`: the existing memory row stays
canonical, no second active row is created, and the confirmation timestamp
advances. `corroborate_existing` exists as its own reviewer-facing decision
label (distinct copy, same mechanism) because a reviewer choosing it is
making an affirmative claim — "this independently confirms the existing
fact" — worth recording as its own outcome even though the write is
identical to a plain `duplicate` call.

## Architecture guard

`check-learning-signal-new-bypasses.mjs` gained one new check (10) rather
than any change to the existing bans: it confirms
`decideLearningSignalCandidate` exists on `ImmutableMemoryVersionService`,
and that no file under `apps/api/src/learning/` or
`packages/meriv2-core/src/learning/` references it by name. Because the new
method lives on the SAME class check 2 already bans unconditionally inside
those directories, the existing guard already proved this invariant by
construction — check 10 reaffirms it explicitly, by name, the same way
check 9 reaffirmed 27C's wiring rather than trusting the class-level ban
alone.

## Schema

**No new migration.** Every column this phase writes
(`memory_items.supersedes_id`/`contradicts_id`/`governed_status`,
`memory_candidate.committed_memory_item_id`/`duplicate_memory_item_id`/
`contradicts_memory_item_id`) already existed and was already written by
the human correction/contradiction flow — this phase is a second caller of
the same columns via the same service, not new state.

## What this explicitly does NOT do

- No sixth context layer, no alternative `ContextPacket`, no alternative
  active-memory store — approved memory flows through the existing
  Institutional Memory → Context Plane path exactly as before.
- No automatic activation of anything currently review-required — every
  genuine conflict resolution still requires an authenticated, authorized,
  non-self reviewer action.
- No change to `LEARNING_SIGNAL_CAPTURE`/`LEARNING_CANDIDATE_GENERATION` —
  both remain independently dark, unaffected by this phase.
- No semantic candidate-vs-pending-candidate matching for Meri, and no
  automatic evidence-strength scoring for rejection overrides — both
  documented deferrals, not oversights.
- No production rollout in this phase.
