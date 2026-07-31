# MeriV2 Phase 9 Acceptance — Authoritative Governed Lifecycle

**Repository:** `neo-capiro/capirov2`  
**Branch:** `agent/meriv2-world-class-closeout`  
**PR:** `#679`  
**Accepted code head:** `e14fbc4fc70ea8220c9861b8a9fe13eb566ff84b`  
**Moving baseline:** `main@3dcb12f823774b6fae8578dc56fc122bf9a0879e`  
**Branch state at code acceptance:** 0 commits behind, draft, mergeable, unmerged

## Acceptance result

**PASS.** Context Packet v2 and governed-memory recall now use `governed_status` as the authoritative lifecycle state. Legacy `status` is retained only as compatibility metadata and cannot make a governed terminal or pending record recallable.

## Authoritative lifecycle contract

The shared governed SQL selects both lifecycle fields explicitly:

- `status AS "legacyStatus"`;
- `governed_status AS "governedStatus"`.

`governedRecord()` derives the v2 lifecycle only from `governedStatus`. A missing or invalid governed value fails closed as `pending_review`; it never inherits a permissive legacy state.

The shared in-memory and SQL recall predicates implement the same policy:

| Governed status | Recall result |
| --- | --- |
| `suggested` | excluded as unapproved |
| `pending_review` | excluded as unapproved |
| `active` | included when authority, source, scope, sensitivity, validity, wall, and approval checks pass |
| `stale` | included under the same checks, surfaced as stale, and packet health remains degraded pending review |
| `conflicted` | included only when it is the explicitly designated controlling item for the unresolved conflict group; packet health is conflicted |
| `rejected` | excluded as rejected |
| `superseded` | excluded as superseded |
| `revoked` | excluded as revoked |
| `expired` | excluded as expired |

An unresolved noncontrolling conflict member is excluded as `conflicted`. An active or stale row carrying unresolved conflict metadata is likewise usable only when its `controlling_item_id` identifies that exact row.

## Cross-surface convergence

The same lifecycle decision is used by:

- API Context Packet v2;
- MeriV2 orchestrator chat and in-editor context;
- Strategy and Steward context through the orchestrator compiler;
- Workspace generation context;
- direct API memory list/search/graph/export readers through the shared governed recall SQL helper;
- Clio compatibility recall suppression through the canonical `memory_items` projection;
- Context Packet persistence and Inspector metadata.

The Context Inspector displays governed lifecycle labels. Unknown future values render as `Unknown` rather than exposing an internal slug. Legacy status remains queryable for compatibility evidence but is not the displayed or enforced lifecycle authority.

## Regression and security coverage

The Phase 9 matrix proves:

- legacy `active` cannot override governed `revoked`, `superseded`, or `expired`;
- pending/rejected/revoked/superseded/expired records are withheld with exact reasons;
- active records are included only after the existing authority/source/wall checks;
- stale records remain visible but degraded after the Phase 8 rollout finalizer;
- a controlling conflicted record can be included while a noncontrolling conflict member is withheld;
- the in-memory and SQL predicates encode the same controlling-item rule;
- API, orchestrator/Strategy, and Workspace reach the same governed lifecycle decision;
- Workspace tests inspect the actual nested Prisma `Sql` interpolation rather than a flattened placeholder;
- packet views and Context Inspector preserve lifecycle truth without confidential body disclosure;
- Program Element safety verification remains green.

## Exact-head validation

All required workflows ran and passed on code head `e14fbc4f`:

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

**Cumulative total: 78 suites/files and 661 tests, all passing.**

The Engagement and Funding Opportunities gates also completed clean-PostgreSQL migration, schema, test, and build checks. No migration was applied to a shared or production environment.

## Program Element protection

The branch was 0 commits behind current `main` immediately before this acceptance record. Phase 9 did not modify Program Element or defense-budget runtime files. The repository typecheck retained `PE_PHASE_A_B_SAFETY_OK`.

## Rollback

- Set `MERIV2_CONTEXT_PACKET_V2=off` or narrow affected tenants/surfaces to shadow/off.
- Keep governed-memory lifecycle enforcement dark for affected tenants while investigating.
- Preserve governed status, immutable versions, packet rows, audit history, and additive schema.
- Do not restore a legacy-status fallback, reopen terminal rows, or hand-promote pending records.

No merge, deployment, AWS operation, shared/production migration, production backfill, production flag activation, external send, or customer-data mutation occurred.

## Next gated phase

Phase 10 — make persisted policy packs the single server-owned action-policy authority.
