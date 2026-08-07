# Phase 7 handoff â€” Session 3 â†’ Session 4

**Mission for the next session: implement Phase 7 Workstreams I, J, K, and L.**

Workstreams **A through H are complete and demonstrated**. What remains is
MILCON and the congressional lifecycle (I, J), corrections and overrides (K),
and the outbox/delta/alert layer (L) â€” then M, N, O.

Authoritative spec: `phase-7-verified-canonical-promotion-production-cutover-v1.md`.

> **Read this first.** Workstream E has been independently reviewed, and the
> review found three P0 defects that 48 passing unit tests did not — most
> seriously, rollback could not execute at all against the real schema. All
> three are fixed. E now has a Prisma adapter and an end-to-end rehearsal that
> drives a real promotion as `capiro_pe_promoter`. **§6 lists the review
> findings that were deliberately NOT fixed** — they are real, and they are
> yours.

---

## 1. Repository state

| Item                     | Value                                                     |
| ------------------------ | --------------------------------------------------------- |
| Branch                   | `agent/pe-budget-canonical-promotion-cutover-v1` (pushed) |
| Draft PR                 | #784 â€” running record, not to be merged                 |
| `origin/main` at handoff | `a234e4e53`                                               |
| Behind main              | 0 (merged this session at `2c4bf0f93`)                    |
| Working tree             | clean                                                     |

### Commits added this session

```text
5cafad73b  feat(pe): Phase 7 WS F, G, H â€” RDT&E, procurement, and O&M canonical projectors
083dd3d33  feat(pe): Phase 7 WS E â€” transactional staging, activation, retry, and rollback
2c4bf0f93  Merge remote-tracking branch 'origin/main'
```

### First four commands

```bash
git -C <clone> fetch origin && git -C <clone> merge origin/main --no-edit
pnpm install --frozen-lockfile
pnpm turbo run build --filter=@capiro/shared --filter=@capiro/meriv2-core --filter=@capiro/auth --filter=@capiro/strategy-verifier
pnpm --filter @capiro/api exec prisma generate   # and the three projection schemas
```

---

## 2. What Aâ€“H delivered

Everything lives in `apps/api/src/defense-budget/promotion/`.

| WS    | Module                                                           | Tests |
| ----- | ---------------------------------------------------------------- | ----- |
| A     | eligibility + authorization contracts, services, guarded surface | 81    |
| B     | `canonical-mapping-registry-v1.ts`                               | 44    |
| C     | `promotion-planner-v1.ts`                                        | 37    |
| D     | migration `20260822010000`, models, rehearsal script             | 33    |
| E     | `canonical-promotion-service-v1.ts`                              | 48    |
| F/G/H | `canonical-projectors-v1.ts`                                     | 37    |

**280 jest tests across 8 suites**, plus a **66-check disposable-PostgreSQL
rehearsal**.

### Properties Iâ€“L must not break

Everything in the Session 2 handoff Â§2 still holds, plus:

8. **Nothing trusts the caller.** The engine reloads the plan, authorization,
   and projections, and re-derives every row hash. A projection that changed
   after planning is refused, not promoted.
9. **Staged rows are invisible and freeze on activation.** Proven at the
   database level: a read through the active-snapshot pointer cannot see a
   STAGING snapshot's rows, and those rows become immutable the moment the
   snapshot leaves STAGING.
10. **The activation ledger, not an exception, decides whether activation
    happened.** Both an ambiguous commit and a lost race against a concurrent
    promoter recover by reading it. Never retry blindly.
11. **A projector refuses rather than defaults.** A funding position with no
    money is a refusal, never a zero.
12. **Detail facts never double count.** `sumPositionMillionsV1` sums position
    entities only; a P-5 line or OP-5 change driver is a component of a
    position, not a second position.

---

## 3. Workstream briefs â€” I through L

### I â€” MILCON projector

The registry already maps `non_rdte:MilconProject`, `MilconProjectYear`, and
`MilconDetailFact`, and the natural key is
`component + account + projectCode + location` â€” **never title**, which is the
Workstream I acceptance criterion, already enforced by a WS B test asserting no
natural key admits a title or name field.

Implementation should be a fourth projector in `canonical-projectors-v1.ts`
following the same `runProjector` shape as G and H: `MILCON_PROJECTOR_TARGETS_V1`,
parent from `identityNaturalKey`, funding field from the candidate or `request`
for the year row. DD1391 cost categories, scope, and schedule land as detail
facts; the `dateValue` axis carries schedule and the attribute bag carries the
rest. Add project-location collision tests (same project number, two
components) and a revised-DD1391 supersession test.

### J â€” Congressional lifecycle projector

The larger one. Phase 6 projections are a different shape from Phase 4/5
candidates â€” `Phase6NativeProjectionV1` in
`defense-budget/phase6/phase6-native-projection-v1.ts` â€” so this needs its own
adapter rather than reusing `ProjectionCandidateInputV1`.

Most of the safety is already structural:

- The registry maps all seven `phase6:*` kinds and gives `stage_position`
  `fieldAuthority.mode: 'stage_authority'`, so `validateFundingFieldForMappingV1`
  re-derives the field from the authority and refuses NDAA conference writing
  the appropriations conference field. A WS B test covers all seven authority
  pairs.
- The database repeats it: `defense_budget_canonical_row_stage_field_check`
  enumerates the ten legal (stage, field) pairs and the illegal pairing is
  absent by construction.
- `stage_action` has `fieldAuthority: not_applicable`, which is what stops an
  action amount being promoted as an absolute position.
- Enacted rows require `enactment_proof_id` at the database level.

So J is mostly mapping `Phase6NativeProjectionV1` onto
`PromotionProjectionInputV1`, populating the new optional `stage` field that
WS E added for the CHECK constraint, and refusing candidate/conflicting
bindings. Prevent CR from populating full-year enacted â€” Phase 6 already
requires `payload.explicitLineAuthority` for that, so carry it forward.

### K â€” Corrections, overrides, conflicts

The planner already models this: `ManualOverlayV1` with active/expired/revoked,
and `manual_override_collision` fires only when an official value **changes**
beneath an **active** override. Unchanged-under-override and
expired/revoked-override are already tested as non-blocking.

K's remaining work is the persistence and governance side: an immutable override
overlay table with author/approver/effective/expiry/version/prior-link, the
migration of the existing admin reconciliation route onto it, legal-hold and
retention, and explicit supersession lineage. The `defense_budget_canonical_row`
attribute bag is not the place for overrides â€” they are a separate governed
overlay applied at read time with a visible provenance label.

### L â€” Outbox, deltas, caches, alert fan-out

WS E already writes outbox rows inside the activation transaction with
classification and suppression decided at planning time, and the database
refuses an un-suppressed hydration, correction, rollback, or unchanged row. What
L adds is the **drainer** (`FOR UPDATE SKIP LOCKED`, bounded batches,
retry/backoff, poison-row handling, attempt counters, exactly-once downstream
dedupe, metrics/alarms) and the generic snapshot-to-snapshot delta engine.

Note that WS E deliberately leaves a committed run in `SIDE_EFFECTS_PENDING`,
never `COMPLETED`. Advancing it to `COMPLETED` is L's job, after the drain.

`old_original_value` / `old_value_millions` / `new_*` on the outbox row are
currently written as null by WS E â€” it has the plan's row hashes but not the
prior row's values. L should populate them, either by reading the prior
snapshot's rows during the drain or by having the planner carry them.

---

## 4. Baselines

| Check                                 | Baseline on this branch                                            |
| ------------------------------------- | ------------------------------------------------------------------ |
| `pnpm --filter @capiro/api typecheck` | **6 errors**, all pre-existing: 4Ã— TS6059, 1Ã— TS1470, 1Ã— TS2493 |
| `verify:pe-budget-phase-1`â€¦`-6`     | all green â€” see Â§7                                              |
| GitHub Actions                        | dead repo-wide; every green claim is locally reproduced            |

---

## 5. Traps found this session

Carried forward from Session 2 Â§9, plus:

7. **A typed axis can silently swallow its siblings.** The projector marked
   every date key consumed, so once `plannedDate` claimed the single date axis,
   `actualDate` disappeared from the row â€” exactly the milestone semantics the
   plan requires preserving. Extraction now reports _which_ key it consumed and
   only that one is removed from the attribute bag. Any future typed axis needs
   the same treatment.
8. **An architecture gate can match its own documentation.** The "imports no
   `ProgramElementWriterService`" check failed on the comment saying it never
   calls one. Strip comments before scanning, and add a companion assertion that
   the identifier IS present in the raw source so the check cannot pass
   vacuously. This is trap #3 from Session 1 recurring in a new form.
9. **`exit` inside a bash helper still exits the shell when called under
   `|| true`.** Combined with `2>/dev/null` this produced a silent exit 1 with
   no diagnostic in the rehearsal script. Do not wrap a `fail`-calling helper in
   `|| true`.
10. **Recovering only from a typed error is too narrow.** WS E originally
    recovered only from `AmbiguousActivationError`; a concurrent promoter losing
    the unique-key race surfaced a raw duplicate-key error instead. The ledger,
    not the exception type, is the authority on whether an activation happened.

---

## 6. Open findings from the independent review of E

A fresh-context reviewer audited Workstream E against the plan and tried to
break it. Three P0s and several P1s were fixed (see commit `b1371406a`). These
were triaged out and remain open. They do not block I–L, but they are real.

**P1-2 — `mapping_registry_drift` is declared but never emitted.** The service
does not compare `canonicalMappingRegistryHashV1()` against
`plan.mappingRegistryHash`, and never compares the authorization's
`eligibilityHash` against the plan's. If the registry is edited between
planning and execution, rows are stamped with the stale hash while being routed
through the current registry — lineage claiming a version the row was not built
under. `StoredExecutionAuthorizationV1.eligibilityHash` and
`StoredSnapshotV1.completedScopes` are declared and never read.

**P1-8 — the architecture gates are name-list regexes over one file's text.**
The reviewer constructed 13 realistic violations (`fetch()` to a webhook,
`redis.del`, `performance.now()`, `require('@prisma/client')`, dynamic
`import()`) and all 13 passed the gates. The purity claim is currently true —
the transitive closure pulls only `zod` and `node:crypto` — but the tests do
nothing to defend it. Resolve the module graph and assert the external
specifier set against an allowlist.

**P1-9 — the Prisma adapter has no unit spec.** It is covered end-to-end by the
engine rehearsal, which is the stronger proof, but there is no fast test for
`isAmbiguousActivationFailureV1` or `advisoryLockKeyV1` in isolation.

**P1-10 — five refusal branches have no test:**
`authorization_plan_hash_mismatch`, `authorization_plan_mismatch`,
`unaccounted_plan_item`, `missing_dependency_row`, `run_already_committed`.
The first is the check enforcing "a changed plan requires a new authorization".
Note also that `parentIsLive` never queries the database despite its name: it
scans the plan for an UNCHANGED item, so a parent that is genuinely live but
absent from the plan produces a false refusal.

**P2 cluster, roughly in priority order:**

- `findActivationByKey` throwing inside the catch swallows the original error
  and strands the run in `ACTIVATING` — and that is the _likely_ case, since
  the reason activation failed is usually that the connection is gone.
- An ambiguous commit with an empty ledger read is recorded as
  `FAILED_PRECOMMIT`, which asserts "no canonical changes" — possibly false.
  Needs a distinct indeterminate status that blocks resume.
- `isAmbiguousActivationFailureV1` does not match real Prisma error shapes
  (`P1001`/`P1017`), so the classifier is largely inert. Impact is limited to
  the `failureReason` label, because the ledger is read on every error anyway.
- The lock connection has no `error` handler, no keepalive, and no acquisition
  timeout. An RDS failover mid-run emits `error` on an EventEmitter with no
  listener and crashes the process.
- The lock key omits `environment` and is scoped per cycle, but the pointer it
  protects is per (domain, environment). The test's fake lock ignores its key
  entirely, so it proves "a global mutex exists", not "the right scope".
- `execute()` never compares `authorization.expectedActiveSnapshotId`;
  `rollback()` does. The asymmetry is an oversight.
- "Required scopes complete" is self-fulfilling: the check compares against the
  plan's families and then writes exactly that set into `completed_scopes`.
- `cancel()` has a TOCTOU with `execute()` and takes no lock, so it can
  overwrite a `COMMITTED` status.
- `recordPlanItemsStaged` updates `defense_budget_promotion_item`, which
  nothing in Phase 7 ever inserts into. It is likely a silent no-op today.
- Recovered activations are never audited.

**P3s:** `classifyOutboxV1` has no `mode === 'correction'` case for a fresh
INSERT; `'resume'` execution mode is accepted but never distinguished from
`'execute'`; the rollback marker outbox row hard-codes a real entity name for a
non-entity; `'ROLLED_BACK'` is missing from the snapshot ready-needs-hash
CHECK; the "never deletes anything" test is a source-text slice between two
literal markers and degrades silently if either moves.

---

## 6a. Operator action — still outstanding

The promoter role's Secrets Manager secret and
`PROMOTER_USER`/`PROMOTER_PASSWORD` on `ApiBootstrapRolesTaskDef` — Workstream
N, **OPERATOR ACTION, REQUIRES SEPARATE AUTHORIZATION**. Until then
`capiro_pe_promoter` cannot authenticate outside a disposable rehearsal, which
is the intended fail-closed state.

---

## 7. Boundaries â€” unchanged

Neo has authorized merging to `main` and shipping from AWS MCP. That does **not**
extend to: production baseline snapshot creation, production canonical
promotion, active-snapshot switch, production rollback, enabling production read
flags, enabling client alert fan-out, or applying Phase 7 migrations to any
shared database.

Migration `20260822010000` has been applied only to disposable Docker containers
that were destroyed afterwards. No test may call a paid parser, touch production
data, or use a shared database.

---

## 8. Definition of done for the next session

I, J, K, L each: production code implemented, focused tests written and passing,
typecheck compared against the **6-error** baseline, formatting applied to new
files only, architecture gates passing, the rehearsal extended where the
workstream adds database behaviour, and a coherent commit landed. Then re-run
`verify:pe-budget-phase-1` through `-6`.

Report exact commands, exit codes, and test counts. A workstream is done when it
is demonstrated, not when the files exist.
