# Phase 7 handoff — Session 4 → Session 5

**Mission for the next session: implement Phase 7 Workstreams K and L.**

Workstreams **A through J are complete and demonstrated**. What remains is
corrections/overrides (K), the outbox drainer and delta engine (L), then read
cutover (M), operator/Fargate (N), and closeout (O).

Authoritative spec: `phase-7-verified-canonical-promotion-production-cutover-v1.md`.
This handoff records repository reality, not a substitute for that plan.

> **Read this first.** Workstream E was independently reviewed in Session 3.
> Three P0s were found and fixed (rollback could not execute against the real
> schema; rollback double-consumed an authorization; a promoted snapshot would
> have contained only changed rows). A cluster of P1/P2 findings from that same
> review were triaged out and are still open — see §6. F–J have NOT been
> independently reviewed; treat them as provisional the same way F–H were
> after Session 2.

---

## 1. Repository state

| Item                     | Value                                                     |
| ------------------------ | --------------------------------------------------------- |
| Branch                   | `agent/pe-budget-canonical-promotion-cutover-v1` (pushed) |
| Draft PR                 | #784 — running record, not to be merged                   |
| `origin/main` at handoff | `9361e604c`                                               |
| Behind main              | 0 (merged this session at `3486c9ca8`)                    |
| Working tree             | clean                                                     |

### Commits added this session

```text
e47ab2345  feat(pe): Phase 7 WS I and J — MILCON and congressional lifecycle projectors
3486c9ca8  Merge remote-tracking branch 'origin/main'
65ea60c98  docs(pe): correct the session 3 handoff after the E review
b1371406a  feat(pe): Phase 7 WS E — Prisma adapter, end-to-end engine rehearsal, and independent-review fixes
```

### First four commands

```bash
git -C <clone> fetch origin && git -C <clone> merge origin/main --no-edit
pnpm install --frozen-lockfile
pnpm turbo run build --filter=@capiro/shared --filter=@capiro/meriv2-core --filter=@capiro/auth --filter=@capiro/strategy-verifier
pnpm --filter @capiro/api exec prisma generate   # and the three projection schemas — see §5
```

**Do the `prisma generate` even if you think nothing changed.** This session's
merge from `main` added a Prisma model (`funding-opportunities`) with no other
signal, and typecheck silently went from 6 errors to 10 until the client was
regenerated. That is gotcha #2 below, and it recurs on every merge.

---

## 2. What A–J delivered

Everything lives in `apps/api/src/defense-budget/promotion/`.

| WS      | Module                                                                              | Tests                 |
| ------- | ----------------------------------------------------------------------------------- | --------------------- |
| A       | eligibility + authorization contracts, services, guarded surface                    | 81                    |
| B       | `canonical-mapping-registry-v1.ts`                                                  | 44                    |
| C       | `promotion-planner-v1.ts`                                                           | 37                    |
| D       | migration `20260822010000`, models, rehearsal script                                | 33 + 68 DB checks     |
| E       | `canonical-promotion-service-v1.ts` + `canonical-promotion-repository-prisma-v1.ts` | 48 + 24 engine checks |
| F/G/H/I | `canonical-projectors-v1.ts` (four `runProjector` families)                         | 64                    |
| J       | `canonical-projectors-v1.ts` (`projectPhase6ProjectionsV1`)                         | (included in the 64)  |

**313 jest tests across 8 suites**, plus a **68-check disposable-PostgreSQL
rehearsal** (60 schema/role checks + a 24-check end-to-end promotion driven
through the real engine as `capiro_pe_promoter`, including rollback with no
manual fix-up).

### Properties K/L must not break

Everything in the Session 2 and 3 handoffs still holds. Two more, specific to
what J just added:

13. **The funding field is re-derived from the stage authority, never trusted
    from the projection.** `STAGE_TO_AUTHORITY_V1` in `canonical-projectors-v1.ts`
    is `satisfies Record<StageV1, StageAuthorityV1>`, so a new stage is a
    compile error until it is mapped. This is what makes NDAA conference
    structurally unable to write the appropriations conference field — the
    database repeats the same ten legal pairs as a CHECK constraint.
14. **A stage action carries no funding field at all.** It maps to an entity
    with `fieldAuthority: not_applicable`. An action amount cannot become an
    absolute position because there is no field for it to be written into.

---

## 3. Workstream briefs — K and L

### K — Corrections, manual overrides, conflicts, and supersession policy

The **policy** already exists in the planner and is tested:
`ManualOverlayV1` with `active`/`expired`/`revoked` status,
`manual_override_collision` fires only when the official value **changes**
beneath an **active** override, and an unchanged value beneath an active
override does not block (`promotion-planner-v1.spec.ts`, "manual overrides"
describe block).

K's remaining work is persistence and governance:

1. An immutable override overlay table: target native identity, FY/field,
   value/unit, reason, evidence, author, approver, effective/expiry dates,
   version, status, prior-override link. Author must not equal approver — mirror
   the segregation-of-duties pattern already established in
   `promotion-authorization-v1.ts` (reviewer/extractor cannot be the
   authorizer).
2. Active reads apply the approved overlay with a visible provenance label —
   this is a read-time concern, so it depends on Workstream M's snapshot-aware
   reads existing. If M is not ready, stub the read path and prove the overlay
   table and its governance in isolation; do not block K on M.
3. Migrate the existing admin reconciliation route onto the governed path.
   Search for it before assuming its shape — it was not touched by A–J.
4. Existing mutable winner flags become compatibility data, not promotion
   authority. Do not delete them; just stop treating them as authoritative.
5. Legal-hold and audit-retention, if existing governance patterns in the repo
   support it (check `apps/api/src/compliance/` and the `CompliancePolicyPack`
   models referenced by `capiro_admin` self-approval work on `main`).

**Do not put overrides in `defense_budget_canonical_row.attributes`.** That
column is upstream lineage, not governance data — an override is a separate
overlay applied at read time, and conflating the two would make a promoted
snapshot's canonical row carry a human decision that has no place being
promoted.

### L — Promotion outbox, generic deltas, caches, and alert fan-out

WS E already does the hard part: outbox rows are written **inside** the
activation transaction with classification and suppression decided at planning
time (`classifyOutboxV1` in `canonical-promotion-service-v1.ts`), and the
database's `defense_budget_promotion_outbox_suppression_check` refuses an
un-suppressed hydration, correction, rollback, or unchanged row regardless of
what the application does. A committed run is deliberately left in
`SIDE_EFFECTS_PENDING`, never `COMPLETED` — advancing it after a successful
drain is L's job.

What L still owns:

1. **The drainer.** `FOR UPDATE SKIP LOCKED` against
   `defense_budget_promotion_outbox` (status `PENDING`), bounded batches,
   retry/backoff, poison-row handling after N attempts (the table already has
   an `attempts` column and a `POISON` status value in its CHECK), exactly-once
   downstream dedupe via `dedupe_key` (already unique), metrics/alarms.
2. **Populate the outbox's before/after money columns.** WS E currently writes
   `old_original_value`/`old_value_millions`/`new_*` as null — it has the
   plan's row hashes but not the prior row's actual values. Either read the
   prior snapshot's row during the drain (join on `canonical_entity` +
   `canonical_natural_key` in the superseded snapshot) or have the planner
   carry the prior value forward into the plan item. The latter is probably
   cleaner: `PromotionPlanItemV1` already carries `priorRowHash`; carrying the
   prior value alongside it means L never needs a second read.
3. **The generic snapshot-to-snapshot delta engine**, replacing
   `DeltaEngineService` for migrated families. Compatibility PE delta rows may
   still need to exist for callers not yet on the new path — check what reads
   `program_element_delta` before removing anything.
4. **Stop direct `intelligence_change` emission** from the new delta path. The
   old `IntelligenceService` emission site is documented in
   `docs/defense-budget/PHASE-7-PRE-IMPLEMENTATION-DEPENDENCY-MAP.md` §3 if you
   need to find it again.
5. Advance a run from `SIDE_EFFECTS_PENDING` to `COMPLETED` on a clean drain, or
   to `COMMITTED_WITH_SIDE_EFFECT_FAILURE` on one that exhausts retries — both
   statuses already exist in the `defense_budget_promotion_run_status_check`
   CHECK and neither is currently written by any code in this repo.

**Rollback interaction.** `rollback()` in Workstream E calls
`pauseSideEffectDrain(domain, environment)` before moving the pointer. Right
now that is an honest no-op in the Prisma adapter (see the comment at its
definition) because there is nothing to pause. L's drainer must actually honour
this signal — most naturally by having the drainer check a
paused-until-resumed flag per (domain, environment) before claiming a batch,
so a drainer mid-flight cannot publish a snapshot's changes after that
snapshot has stopped being active.

---

## 4. Baselines

| Check                                 | Baseline on this branch                                         |
| ------------------------------------- | --------------------------------------------------------------- |
| `pnpm --filter @capiro/api typecheck` | **6 errors**, all pre-existing: 4× TS6059, 1× TS1470, 1× TS2493 |
| `verify:pe-budget-phase-1`…`-6`       | not re-run this session — re-run before your own handoff        |
| GitHub Actions                        | dead repo-wide; every green claim is locally reproduced         |

---

## 5. Environment gotchas — carried forward, one new

1. `pnpm install` alone leaves hundreds of phantom errors. Also run the turbo
   build of workspace packages and `prisma generate` for all four schemas.
2. **A silent merge can desync the Prisma client.** This session's merge from
   `main` added one model and produced four new-looking typecheck errors with
   no other warning. Always regenerate after merging, and if typecheck shows
   more errors than the documented baseline, regenerate before assuming you
   introduced a regression.
3. Four Prisma schemas: `prisma/schema.prisma`, `prisma/rdte-projection/`,
   `prisma/non-rdte-projection/`, `prisma/phase6-projection/`. All are literally
   named `schema.prisma` — compare full paths, not just filenames, when
   searching for a model.
4. The rehearsal image must be `pgvector/pgvector:pg16`; the first migration in
   the chain installs the `vector` extension.
5. `DATABASE_URL` must be set for `prisma validate`/`verify:pe-budget-phase-6`,
   even though it never connects.

---

## 6. Open findings from the independent review of E — still open

Unchanged from Session 3. Reproduced here so it travels with the branch instead
of requiring a lookup in an older handoff.

**P1-2 — `mapping_registry_drift` is declared but never emitted.** The service
does not compare `canonicalMappingRegistryHashV1()` against
`plan.mappingRegistryHash`, and never compares the authorization's
`eligibilityHash` against the plan's.

**P1-8 — the architecture gates are name-list regexes over one file's text.**
13 constructed violations (webhook `fetch`, `redis.del`, `performance.now()`,
dynamic `import('@prisma/client')`) all passed. Resolve the module graph and
assert against an allowlist instead.

**P1-9 / P1-10 — the Prisma adapter has no unit spec, and five refusal branches
are untested:** `authorization_plan_hash_mismatch`, `authorization_plan_mismatch`,
`unaccounted_plan_item`, `missing_dependency_row`, `run_already_committed`.

**P2 cluster:** `findActivationByKey` failure inside the ambiguous-commit catch
swallows the original error; the classifier for ambiguous vs. determinate
Prisma errors doesn't match real `P1001`/`P1017` shapes; the lock connection has
no error handler or acquisition timeout; the lock key omits `environment`;
`execute()` never compares `expectedActiveSnapshotId` on the authorization
(rollback does — the asymmetry looks unintentional); `cancel()` has a TOCTOU
with `execute()`; `recordPlanItemsStaged` updates a table nothing else inserts
into.

None of these block K or L. They are real and worth a dedicated pass, probably
alongside O's negative-control work since several of them are exactly the shape
of defect a negative control would inject.

---

## 7. Boundaries — unchanged

Neo has authorized merging to `main` and shipping from AWS MCP. That does **not**
extend to: production baseline snapshot creation, production canonical
promotion, active-snapshot switch, production rollback, enabling production read
flags, enabling client alert fan-out, or applying Phase 7 migrations to any
shared database.

Migration `20260822010000` has been applied only to disposable Docker
containers, destroyed on exit. No test may call a paid parser, touch production
data, or use a shared database.

**Operator action still outstanding (Workstream N):** the promoter role's
Secrets Manager secret and `PROMOTER_USER`/`PROMOTER_PASSWORD` on
`ApiBootstrapRolesTaskDef`. Until provisioned, `capiro_pe_promoter` cannot
authenticate outside a disposable rehearsal, which is the intended fail-closed
state.

---

## 8. Definition of done for the next session

K and L each: production code implemented, focused tests written and passing,
typecheck compared against the **6-error** baseline, formatting applied to new
files only, architecture gates passing, the rehearsal extended to cover the new
database behaviour (L especially — the drainer needs a real
`FOR UPDATE SKIP LOCKED` proof, not just a unit test), and a coherent commit
landed. Then re-run `verify:pe-budget-phase-1` through `-6`.

Report exact commands, exit codes, and test counts. A workstream is done when
it is demonstrated, not when the files exist.
