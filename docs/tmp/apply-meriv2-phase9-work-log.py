from pathlib import Path

path = Path('docs/plans/meriv2-world-class-closeout-work-log.md')
text = path.read_text(encoding='utf-8')

old_header = '''**Authoritative through:** Phase 8 code acceptance  
**Phase 8 runtime/test head:** `b18d520c02ead55cc629a72a2832149d76520baf`  
**Phase 8 first green CI evidence head:** `0ed128de929e5982578bd7d6725310044d9d79b9`  
**Moving baseline at the Phase 8 acceptance check:** `main@3dcb12f823774b6fae8578dc56fc122bf9a0879e`

No merge to `main`, AWS deployment, shared/production migration, production backfill, feature-flag activation, customer-data mutation, external send, or production rollout occurred during Phases 0–8.'''
new_header = '''**Authoritative through:** Phase 9 code acceptance  
**Phase 9 accepted code head:** `e14fbc4fc70ea8220c9861b8a9fe13eb566ff84b`  
**Phase 9 acceptance certificate commit:** `e02703ea06e722f9f6c77f12a4bc3c573578fa24`  
**Moving baseline at the Phase 9 acceptance check:** `main@3dcb12f823774b6fae8578dc56fc122bf9a0879e`

No merge to `main`, AWS deployment, shared/production migration, production backfill, feature-flag activation, customer-data mutation, external send, or production rollout occurred during Phases 0–9.'''

old_tail = '''## Cumulative Phases 1–8 closure

**PHASES 1–8 CUMULATIVE CODE ACCEPTANCE: PASS.**

Phase 8 does not invalidate atomic activation, canonical governance, Settings review, immutable versioning, durable projection, exact completion, or truthful persistence. The permanent cumulative workflow proves the entire Phase 1–8 contract on one synchronized exact code/evidence head.

Still deferred to later phases and release certification:

- governed-status authority, persisted action-policy authority, backfill/grants/withdrawal lifecycle, administration UX, assurance enforcement, migration rehearsal, authenticated browser/accessibility acceptance, SOC 2 control mapping, rollout/rollback operations, and production gates;
- shared/production migration, production backfill, deployment, feature-flag activation, and customer-data operations.

**Next gated phase: Phase 9 — make `governed_status` the authoritative v2 lifecycle state.** Do not merge or deploy PR #679.'''

new_tail = '''## Phase 9 — authoritative governed lifecycle

### Accepted code head

`e14fbc4fc70ea8220c9861b8a9fe13eb566ff84b`

### Runtime contract

- the shared governed SQL selects both `status AS "legacyStatus"` and `governed_status AS "governedStatus"`;
- Context Packet v2 derives lifecycle only from `governedStatus`; missing or invalid governed state fails closed as `pending_review` and never inherits legacy activity;
- one in-memory predicate and one SQL-equivalent predicate own recallability;
- `suggested` and `pending_review` are withheld as unapproved;
- `active` is recallable only after authority, source, scope, validity, sensitivity, approval, and ethical-wall checks;
- `stale` remains recallable under those checks, is visibly labeled stale, and keeps packet health degraded after the Phase 8 rollout finalizer;
- `conflicted` is recallable only for the exact designated controlling item of an unresolved conflict group, and packet health remains conflicted;
- unresolved noncontrolling conflict members are withheld;
- `rejected`, `superseded`, `revoked`, and `expired` are withheld with exact exclusion reasons;
- legacy status is compatibility metadata only and cannot override governed lifecycle;
- API, orchestrator, Strategy, Steward, Workspace, direct memory readers, Clio projection suppression, packet views, and Context Inspector converge on the same governed lifecycle decision;
- unknown Inspector lifecycle values render as `Unknown`, not an internal slug.

### Acceptance evidence

All six required workflows passed on the synchronized code head:

- `memory-governance-ci` run `30599893117` — **PASS**;
- `ci-pr` run `30599893132` — **PASS**;
- `meriv2-evals` run `30599893098` — **PASS**;
- `engagement-trust-boundary` run `30599893084` — **PASS**;
- `legiwatch-ci` run `30599893145` — **PASS**;
- `funding-opportunities-ci` run `30599893100` — **PASS**.

Permanent cumulative Phase 1–9 matrix:

- all five Prisma clients generated;
- full dependency graph — **18/18 typecheck tasks PASS**;
- projection-worker infrastructure typecheck — **PASS**;
- API governed-memory Phases 1–9 — **60 suites / 510 tests PASS**;
- governed lifecycle, truthful persistence, rollout, and surface policy — **5 suites / 62 tests PASS**;
- orchestrator Context, Strategy, and Steward — **6 suites / 38 tests PASS**;
- Workspace canonical context and persistence hold — **5 suites / 40 tests PASS**;
- Settings and Context Inspector — **2 files / 11 tests PASS**.

**Cumulative total: 78 suites/files / 661 tests PASS.**

The Engagement and Funding Opportunities gates also completed clean-PostgreSQL migration, schema, test, and build checks. No migration was applied to a shared or production environment.

Immediately before recording the gate, the branch remained **0 commits behind** `main@3dcb12f823774b6fae8578dc56fc122bf9a0879e`. The repository typecheck retained `PE_PHASE_A_B_SAFETY_OK`; Phase 9 did not modify Program Element or defense-budget runtime files.

### Acceptance

**PASS.** Every v2 consumer reaches the same include/exclude decision for the same governed record and actor, and legacy lifecycle state cannot override governed truth.

### Rollback posture

- set `MERIV2_CONTEXT_PACKET_V2=off`, or narrow affected tenants/surfaces to shadow/off;
- keep governed-memory enforcement dark for affected tenants during investigation;
- preserve governed status, immutable versions, packet rows, audit history, and additive schema;
- do not restore a legacy-status fallback, reopen terminal rows, or hand-promote pending records.

Detailed acceptance: `docs/qa/meriv2-phase-9-governed-lifecycle.md`.

---

## Cumulative Phases 1–9 closure

**PHASES 1–9 CUMULATIVE CODE ACCEPTANCE: PASS.**

Phase 9 preserves every accepted Phase 1–8 transaction, governance, review, immutable-version, durable-projection, exact-completion, truthful-persistence, and rollout invariant. The permanent cumulative workflow proves the entire Phase 1–9 contract on one synchronized code head.

Still deferred to later phases and release certification:

- persisted action-policy authority, reversible backfill, client-review grants, withdrawal lifecycle, governance administration UX, assurance canary/enforcement, final synchronization, migration rehearsal, authenticated browser/accessibility acceptance, SOC 2 control mapping, release authorization, and production rollout;
- shared/production migration, production backfill, deployment, feature-flag activation, and customer-data operations.

**Next gated phase: Phase 10 — make persisted policy packs the single action-policy authority.** Do not merge or deploy PR #679.'''

for label, old, new in [('header', old_header, new_header), ('tail', old_tail, new_tail)]:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'work log expected one {label} match, found {count}')
    text = text.replace(old, new, 1)

path.write_text(text, encoding='utf-8')
print('PHASE9_WORK_LOG_OK')
