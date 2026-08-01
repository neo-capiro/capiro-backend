# MeriV2 World-Class Closeout — Phases 10–11 Ledger Addendum

**Repository:** `neo-capiro/capirov2`  
**Branch:** `agent/meriv2-world-class-closeout`  
**PR:** `#679`  
**State:** Draft, open, unmerged  
**Accepted baseline:** Phases 0–9  
**Current implementation state:** Phases 10–11 present, final acceptance blocked by GitHub Actions control-plane failure

This addendum continues `docs/plans/meriv2-world-class-closeout-work-log.md`, whose accepted evidence remains authoritative through Phase 9. It does not retroactively mark Phase 10 or Phase 11 accepted.

No merge to `main`, AWS deployment, shared or production migration, tenant backfill, feature-flag activation, customer-data mutation, secret retrieval, external send, or production rollout occurred during Phase 10 or Phase 11 implementation.

---

## Phase 10 — persisted action-policy authority

### Implementation state

**IMPLEMENTED; NOT YET ACCEPTED.**

Persisted policy packs are the server-owned authority for governed action decisions. The implementation includes:

- `off`, `shadow`, and fail-closed `enforce` resolution;
- tenant-, actor-, effective-user-, role-, client-, jurisdiction-, tool-, channel-, recipient-type-, and effective-time-aware selection;
- immutable policy-pack identity, version, binding, context hash, and decision hash on action proposals;
- approval-time policy re-evaluation and invalidation of stale approvals;
- transactional policy-decision evidence;
- administrator lifecycle APIs and Policy Packs settings UX;
- independent review and optional second approval;
- simulation that is explicitly nonbinding;
- publish, retire, and rollback lifecycle controls; and
- additive migration and permanent cumulative tests.

Static product policy remains authoritative only in `off`. `shadow` records comparisons without changing execution. `enforce` denies when the required persisted policy authority is missing, invalid, unavailable, or hash-inconsistent.

### Acceptance blocker

GitHub workflow identity `324351375` is a deleted synthetic registration with `path=BuildFailed`. Repository events generate zero-job `startup_failure` runs under that identity before the legitimate required workflows schedule. All current workflow files pass `actionlint` and independent YAML parsing; this is a repository Actions control-plane defect, not a known branch YAML error.

Phase 10 therefore remains provisional until the full cumulative matrix and all required workflows pass on one exact synchronized head.

---

## Phase 11 — reversible, drift-safe governance backfill

### Implementation state

**IMPLEMENTED; LOCAL/DISPOSABLE-POSTGRES VALIDATION REQUIRED; NOT YET ACCEPTED.**

The legacy governance backfill is now an explicit three-stage state machine:

1. **Prepare** — tenant-scoped dry-run snapshot; zero canonical `memory_items` mutations.
2. **Execute** — exact prepared job plus matching tenant and job confirmations; any pre-execution governance drift blocks the entire job before mutation.
3. **Rollback** — restore only rows that still match the exact expected post-state; preserve and audit later changes.

### Durable control boundary

Additive migrations:

- `20260814010000_memory_governance_backfill_jobs`
- `20260814011000_memory_governance_backfill_delete_guards`

They add:

- tenant-scoped job headers with classifier version, plan hash, counts, and terminal lifecycle;
- exact before-state and expected-post-state row snapshots;
- bounded append-only event evidence;
- forced RLS on every Phase 11 control table;
- immutable prepared job and row-plan triggers;
- direct-delete guards that preserve evidence while still allowing an authorized tenant purge cascade; and
- no migration-time write to `memory_items`.

The snapshot stores governance metadata only: class, authority, scope, governed status, source type, source ID, and review-due timestamp. It does not store memory bodies, titles, prompts, provider payloads, email content, or customer communications.

### Execution and rollback invariants

- The CLI defaults to prepare/dry-run.
- Execute and rollback require exact `--tenant-id`, `--job-id`, `--confirm-tenant`, and `--confirm-job` agreement.
- Execute and rollback consume the prepared snapshot; they do not recompute classification.
- The store verifies the job plan hash, counts, every before-state hash, and every expected-post-state hash.
- Covered canonical rows are locked in a bounded 15-minute transaction.
- Any changed or missing row before execute produces terminal `execute_blocked_drift` with zero canonical mutations.
- Rollback restores exact prior governance fields only where the current row still equals the job’s expected post-state.
- Changed or missing rows are retained and marked `skipped_drift`.
- A complete rollback is `rolled_back`; preserved later changes produce truthful terminal `rollback_partial`.
- Applied and restored transitions write `memory_transition_audit` with bounded IDs, versions, hashes, and reason codes.

### Permanent gates

`memory-governance-ci` is extended through Phase 11 and includes:

- clean migration replay;
- full repository dependency typecheck;
- an explicit typecheck for the production backfill CLI/store excluded by the primary API tsconfig;
- both Phase 11 migration contract suites;
- exact argument and canonical-hash tests; and
- a disposable PostgreSQL rehearsal proving:
  - prepare changes no canonical row;
  - pre-execution drift blocks the whole job;
  - a newly prepared exact job executes;
  - rollback restores an unchanged row;
  - rollback preserves a later-modified row;
  - terminal state is `rollback_partial`; and
  - prepared snapshots and events reject direct mutation.

Detailed Phase 11 contract: `docs/qa/meriv2-phase-11-reversible-governance-backfill.md`.

### Rollout posture

No Phase 11 migration or backfill has been run outside disposable validation. A future environment operation must:

1. pin the exact commit and image digest;
2. apply additive migrations first;
3. keep governed-memory enforcement dark;
4. prepare and review each tenant job independently;
5. execute only the reviewed exact job ID; and
6. retain the same job ID for drift-safe rollback.

---

## Current gate and next phase

Phases 0–9 remain accepted. Phases 10–11 are implemented but cannot receive final acceptance while GitHub Actions is unable to schedule the legitimate workflows. Phase 12 has not started.

PR #679 must remain draft and unmerged. Deployment through AWS CLI is a later separately authorized operation and must use an exact accepted commit SHA and immutable image digests rather than an unqualified branch or `latest` tag.
