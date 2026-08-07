# Phase 7 handoff — Session 3 → Session 4

**Mission for the next session: implement Phase 7 Workstreams I, J, K, and L.**

Workstreams **A through H are complete and demonstrated**. What remains is
MILCON and the congressional lifecycle (I, J), corrections and overrides (K),
and the outbox/delta/alert layer (L) — then M, N, O.

Authoritative spec: `phase-7-verified-canonical-promotion-production-cutover-v1.md`.

> **Read this first.** Workstream E is written but has **no Prisma-backed
> repository adapter**. Every port it depends on is defined and unit-tested
> against in-memory fakes, and every database guarantee it relies on is proven
> by the disposable-PostgreSQL rehearsal — but the two are not yet wired
> together. See §6. Nothing can actually promote until that adapter exists.

---

## 1. Repository state

| Item                     | Value                                                     |
| ------------------------ | --------------------------------------------------------- |
| Branch                   | `agent/pe-budget-canonical-promotion-cutover-v1` (pushed) |
| Draft PR                 | #784 — running record, not to be merged                   |
| `origin/main` at handoff | `a234e4e53`                                               |
| Behind main              | 0 (merged this session at `2c4bf0f93`)                    |
| Working tree             | clean                                                     |

### Commits added this session

```text
5cafad73b  feat(pe): Phase 7 WS F, G, H — RDT&E, procurement, and O&M canonical projectors
083dd3d33  feat(pe): Phase 7 WS E — transactional staging, activation, retry, and rollback
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

## 2. What A–H delivered

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

### Properties I–L must not break

Everything in the Session 2 handoff §2 still holds, plus:

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

## 3. Workstream briefs — I through L

### I — MILCON projector

The registry already maps `non_rdte:MilconProject`, `MilconProjectYear`, and
`MilconDetailFact`, and the natural key is
`component + account + projectCode + location` — **never title**, which is the
Workstream I acceptance criterion, already enforced by a WS B test asserting no
natural key admits a title or name field.

Implementation should be a fourth projector in `canonical-projectors-v1.ts`
following the same `runProjector` shape as G and H: `MILCON_PROJECTOR_TARGETS_V1`,
parent from `identityNaturalKey`, funding field from the candidate or `request`
for the year row. DD1391 cost categories, scope, and schedule land as detail
facts; the `dateValue` axis carries schedule and the attribute bag carries the
rest. Add project-location collision tests (same project number, two
components) and a revised-DD1391 supersession test.

### J — Congressional lifecycle projector

The larger one. Phase 6 projections are a different shape from Phase 4/5
candidates — `Phase6NativeProjectionV1` in
`defense-budget/phase6/phase6-native-projection-v1.ts` — so this needs its own
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
bindings. Prevent CR from populating full-year enacted — Phase 6 already
requires `payload.explicitLineAuthority` for that, so carry it forward.

### K — Corrections, overrides, conflicts

The planner already models this: `ManualOverlayV1` with active/expired/revoked,
and `manual_override_collision` fires only when an official value **changes**
beneath an **active** override. Unchanged-under-override and
expired/revoked-override are already tested as non-blocking.

K's remaining work is the persistence and governance side: an immutable override
overlay table with author/approver/effective/expiry/version/prior-link, the
migration of the existing admin reconciliation route onto it, legal-hold and
retention, and explicit supersession lineage. The `defense_budget_canonical_row`
attribute bag is not the place for overrides — they are a separate governed
overlay applied at read time with a visible provenance label.

### L — Outbox, deltas, caches, alert fan-out

WS E already writes outbox rows inside the activation transaction with
classification and suppression decided at planning time, and the database
refuses an un-suppressed hydration, correction, rollback, or unchanged row. What
L adds is the **drainer** (`FOR UPDATE SKIP LOCKED`, bounded batches,
retry/backoff, poison-row handling, attempt counters, exactly-once downstream
dedupe, metrics/alarms) and the generic snapshot-to-snapshot delta engine.

Note that WS E deliberately leaves a committed run in `SIDE_EFFECTS_PENDING`,
never `COMPLETED`. Advancing it to `COMPLETED` is L's job, after the drain.

`old_original_value` / `old_value_millions` / `new_*` on the outbox row are
currently written as null by WS E — it has the plan's row hashes but not the
prior row's values. L should populate them, either by reading the prior
snapshot's rows during the drain or by having the planner carry them.

---

## 4. Baselines

| Check                                 | Baseline on this branch                                         |
| ------------------------------------- | --------------------------------------------------------------- |
| `pnpm --filter @capiro/api typecheck` | **6 errors**, all pre-existing: 4× TS6059, 1× TS1470, 1× TS2493 |
| `verify:pe-budget-phase-1`…`-6`       | all green — see §7                                              |
| GitHub Actions                        | dead repo-wide; every green claim is locally reproduced         |

---

## 5. Traps found this session

Carried forward from Session 2 §9, plus:

7. **A typed axis can silently swallow its siblings.** The projector marked
   every date key consumed, so once `plannedDate` claimed the single date axis,
   `actualDate` disappeared from the row — exactly the milestone semantics the
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

## 6. Known gap — WS E has no Prisma adapter

`PromotionExecutionRepositoryV1` defines eighteen methods and is fully
unit-tested against an in-memory fake. There is no implementation backed by
Prisma, so **the engine cannot run against a real database yet**.

Writing it is the next session's first job if promotion is to be exercised
end to end. It is mechanical but not trivial:

- `withDomainCycleLock` → `pg_advisory_xact_lock` over a hash of the domain and
  cycle.
- `activate` → a single transaction doing the seven steps in WS E's documented
  order, throwing `AmbiguousActivationError` on an indeterminate commit.
- `stageRows` → idempotent insert; the unique index
  `defense_budget_canonical_row_identity_unique` makes `ON CONFLICT DO NOTHING`
  correct, and the canonical-row trigger requires the connection to be
  `capiro_pe_promoter`.
- Everything else is straightforward reads and status updates.

Once it exists, extend the rehearsal to drive a full promotion through the
engine rather than through hand-written SQL.

Also outstanding: the promoter role's Secrets Manager secret and
`PROMOTER_USER`/`PROMOTER_PASSWORD` on `ApiBootstrapRolesTaskDef` — Workstream
N, **OPERATOR ACTION, REQUIRES SEPARATE AUTHORIZATION**. Until then
`capiro_pe_promoter` cannot authenticate, which is the intended fail-closed
state.

---

## 7. Boundaries — unchanged

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
