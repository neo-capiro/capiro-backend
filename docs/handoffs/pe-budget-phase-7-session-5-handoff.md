# Phase 7 handoff — Session 5 → Session 6

**Mission for the next session: finish Workstream L.**

Workstreams **A through K are complete** (K bar one M-dependent item). L is
started: its drain _policy_ exists and is tested; everything in L that touches a
database does not. Then M, N, O.

Authoritative spec: `phase-7-verified-canonical-promotion-production-cutover-v1.md`.
This handoff records repository reality, not a substitute for that plan.

> **Read this first.** Phase 7 A–K was **merged to `main`** this session (PR #784,
> merge commit `783d942b2`). The plan's "one draft PR for Phase 7, do not merge
> it" no longer describes reality — Neo authorized the merge. Nothing has been
> deployed, which means **`main` now carries two migrations that no shared
> database has applied**. See §7; this is the single most important operational
> fact on this branch.

---

## 1. Repository state

| Item                     | Value                                              |
| ------------------------ | -------------------------------------------------- |
| Branch                   | `agent/pe-budget-canonical-promotion-cutover-v1`   |
| HEAD                     | `3a7a1c5de`                                        |
| Unpushed                 | **2 commits** (`d40e2e22b`, `3a7a1c5de`)           |
| `origin/main` at handoff | `783d942b2` (contains Phase 7 A–K)                 |
| Behind main              | 0 (merged this session at `ed2b5088a`)             |
| Worktree                 | clean                                              |
| PR #784                  | **merged** — a successor PR is needed for L onward |

### Commits added this session

```text
7448e65bc  fix(pe): Phase 7 R1 — a request-side candidate cannot assert a congressional mark
899a13056  feat(pe): Phase 7 WS K — governed manual-override contract and segregation
2e5943c6a  feat(pe): Phase 7 WS K — manual-override persistence, grants, and append-only
75b9c6265  feat(pe): Phase 7 WS K — two-step propose/approve for manual overrides
ee9d70ee6  feat(pe): Phase 7 WS K — propose/approve service and override lifecycle trigger
111b5df9e  feat(pe): Phase 7 WS K — Prisma adapter, queue link migration, sharper gate
ed2b5088a  Merge remote-tracking branch 'origin/main'
d40e2e22b  feat(pe): Phase 7 WS K — wire the two-step endpoints, retire the legacy write
3a7a1c5de  feat(pe): Phase 7 WS L — outbox drain policy
```

### First four commands

```bash
git -C <clone> fetch origin && git -C <clone> merge origin/main --no-edit
pnpm install --frozen-lockfile
pnpm turbo run build --filter=@capiro/shared --filter=@capiro/meriv2-core --filter=@capiro/auth --filter=@capiro/strategy-verifier
pnpm --filter @capiro/api exec prisma generate   # and the three projection schemas — see §5
```

**Do the `prisma generate` even if you think nothing changed.** This recurs on
every merge and cost time again this session.

---

## 2. What changed this session

### The F–J review (`7448e65bc`)

F–J had never been independently reviewed. The review found **one P1, now fixed**.

`STAGE_TO_AUTHORITY_V1` re-derives the funding field from the stage authority —
but only for the two entities whose `fieldAuthority.mode` is `stage_authority`.
The four per-FY position entities F/G/H/I write used `projection_funding_field`
with `ALL_STAGE_FIELDS`, so a Phase 4/5 request-side candidate could assert a
congressional mark with **no stage and no authority**. The projector never
validated at all, the planner's `stage_authority` branch never ran, and the
database CHECK was `"stage" IS NULL OR ...` — which passed trivially, because
only the Phase 6 adapter sets `stage`.

Only `enacted` failed closed, via the enactment-proof CHECK. The other six
congressional fields had no backstop, and a wrong funding field on a `*_year`
row would have travelled through L's delta engine into a client alert asserting
a congressional action that never happened.

Fixed by making authority ownership a property of the **field**, not the entity:
`AUTHORITY_OWNED_FIELDS` derives from `STAGE_AUTHORITY_FIELD` rather than
restating it, enforced in the registry, the projector, and the migration's CHECK.
Registry _entries_ are untouched, so `canonicalMappingRegistryHashV1()` is
unchanged and existing plan hashes stay valid.

### Workstream K (five commits)

Complete except read-time overlay application, which needs M.

- Governed override contract with author≠approver enforced **inside the Zod
  schema**, mirroring `promotion-authorization-v1.ts`, so a caller cannot skip it.
- `defense_budget_manual_override` — immutable, versioned, append-only, with the
  segregation rules repeated as CHECK constraints because a direct SQL writer
  bypasses the application.
- **Two-step propose → approve.** Neo chose this shape when the legacy route
  turned out to have exactly one actor and therefore could not produce a valid
  governed override at all. A proposal names no approver and is not in force;
  there is no row shape, in schema or table, expressing "I approved my own
  correction".
- `enforce_manual_override_lifecycle` permits exactly `proposed → approved →
revoked` and freezes everything constituting the correction. Modelled on
  `enforce_promotion_authorization_append_only`, which already permits one
  consumption transition for the same reason.
- Both endpoints wired. `POST .../resolve` proposes;
  `POST .../:id/approve` is new.

### Workstream L, started (`3a7a1c5de`)

`promotion-outbox-drain-v1.ts` — drain policy as pure logic over a port. Retry
versus quarantine with the ceiling boundary asserted from both sides, capped
deterministic backoff, `nextRunStatusAfterDrainV1`, and pause checked _before_
claiming. Nothing in it touches a database.

### Properties L must not break

Everything in the Session 2–4 handoffs still holds. Three more:

15. **An authority-owned funding field requires its authority, on every entity.**
    Not just on stage positions. `AUTHORITY_OWNED_FIELDS` derives from
    `STAGE_AUTHORITY_FIELD`, so a new authority extends it automatically.
16. **A proposed override is not in force.** It defends no value and blocks no
    promotion. If a proposal blocked promotion, one admin could veto a cycle
    unilaterally — the opposite of what the two-step is for.
17. **A manual override is never a source observation and never a column on a
    canonical row.** It is applied beside the snapshot at read time.

---

## 3. Workstream brief — finishing L

The policy exists. What remains is everything that touches a database.

1. **The Prisma drain adapter.** Implement `OutboxDrainRepositoryV1` with a real
   `FOR UPDATE SKIP LOCKED` claim against `defense_budget_promotion_outbox`
   (status `PENDING`/`FAILED`, respecting the backoff via `isDrainEligibleV1`).
   The table already has `attempts`, a `POISON` status in its CHECK, and a
   unique `dedupe_key`.
2. **A pause-state table.** `pauseSideEffectDrain`/`resumeSideEffectDrain` at
   `canonical-promotion-repository-prisma-v1.ts:445` are still honest no-ops, so
   the policy honours a pause nothing can currently set. Needs storage per
   (domain, environment). A **new migration** — see the gate in §5.
3. **Populate the outbox's before/after money columns.** WS E writes
   `old_original_value`/`old_value_millions`/`new_*` as null
   (`canonical-promotion-service-v1.ts:1020` and `:1241`). Two routes: read the
   prior snapshot's row at drain time, or carry the prior value forward in
   `PromotionPlanItemV1`. **The plan-item route changes the plan hash** —
   `promotionPlanHashV1` hashes the whole plan including items, so it invalidates
   every issued authorization and needs a deliberate
   `DEFENSE_BUDGET_PROMOTION_PLAN_SCHEMA_VERSION` bump. The drain-time read
   avoids touching the hashed contract entirely. Decide before implementing.
4. **The generic snapshot-to-snapshot delta engine**, replacing
   `DeltaEngineService` for migrated families. Check what reads
   `program_element_delta` before removing anything.
5. **Stop direct `intelligence_change` emission** from the new delta path. The
   old emission site is documented in
   `docs/defense-budget/PHASE-7-PRE-IMPLEMENTATION-DEPENDENCY-MAP.md` §3.
6. **Rehearsal proof.** A unit test cannot prove `SKIP LOCKED`. The rehearsal
   needs concurrent drainers actually partitioning a backlog, plus a poison row
   surviving its attempts and a paused drain claiming nothing.

---

## 4. Baselines

| Check                                 | Baseline on this branch                                         |
| ------------------------------------- | --------------------------------------------------------------- |
| `jest src/defense-budget/promotion`   | **423 passed, 12 suites**                                       |
| `jest src/program-element`            | **1123 passed, 72 suites** (with promotion)                     |
| `pnpm --filter @capiro/api typecheck` | **6 errors**, all pre-existing: 4× TS6059, 1× TS1470, 1× TS2493 |
| phase7 migration rehearsal            | **97 checks**, disposable PostgreSQL, disposed on exit          |
| `verify:pe-budget-phase-1`…`-6`       | not re-run this session — re-run before your own handoff        |
| GitHub Actions                        | still dead repo-wide; every green claim is locally reproduced   |

---

## 5. Environment gotchas — carried forward, four new

1. `pnpm install` alone leaves hundreds of phantom errors. Also run the turbo
   build of workspace packages and `prisma generate` for all four schemas.
2. **A silent merge can desync the Prisma client.** Always regenerate after
   merging; if typecheck shows more than the documented baseline, regenerate
   before assuming you introduced a regression.
3. Four Prisma schemas, all literally named `schema.prisma`. Compare full paths.
4. The rehearsal image must be `pgvector/pgvector:pg16`.
5. `DATABASE_URL` must be set for `prisma validate` / `verify:pe-budget-phase-6`,
   even though it never connects.
6. **`promotion-planner-v1.ts` contains literal NUL bytes** as composite-map-key
   delimiters, so ripgrep, `grep`, and the Grep tool treat it as binary and skip
   it **silently**. Use `grep -a`. Any repo-wide sweep that doesn't will pass
   over the planner and report clean.
7. **Migration `20260822010000` is gated as purely additive.** An architecture
   test asserts it contains no `ALTER TABLE`. Anything touching a pre-existing
   table needs its own migration — that is why the queue link is
   `20260822020000`. The gate now strips SQL comments before scanning, so a
   comment explaining the rule no longer trips it.
8. **Postgres pads `NUMERIC` to its declared scale.** `NUMERIC(24,9)` returns
   `1.250000000` for a stored `1.25`, which is _not_ canonical decimal form.
   Any adapter reading money out of a NUMERIC must normalize through
   `parseCanonicalDecimalString` or the record schema refuses it.
9. **`reconciliation_review_queue.id` is a Prisma-side `@default(uuid())`**, not
   a database default. Raw SQL inserts must supply it.

---

## 6. Open findings

### From the independent review of E — unchanged, still open

**P1-2** — `mapping_registry_drift` is declared but never emitted. The service
never compares `canonicalMappingRegistryHashV1()` against
`plan.mappingRegistryHash`, nor the authorization's `eligibilityHash` against
the plan's.

**P1-8** — the architecture gates are name-list regexes over one file's text; 13
constructed violations all passed. (The migration gate specifically was
sharpened this session to strip comments, but the general finding stands.)

**P1-9 / P1-10** — the Workstream E Prisma adapter has no unit spec, and five
refusal branches are untested. _K's adapter now has one, and writing it caught a
real defect immediately — see gotcha #8._

**P2 cluster** — `findActivationByKey` failure swallows the original error; the
ambiguous-vs-determinate Prisma error classifier doesn't match real
`P1001`/`P1017` shapes; the lock connection has no error handler or acquisition
timeout; the lock key omits `environment`; `execute()` never compares
`expectedActiveSnapshotId` on the authorization while `rollback()` does;
`cancel()` has a TOCTOU with `execute()`; `recordPlanItemsStaged` updates a table
nothing else inserts into.

### From the F–J review this session — open, all P2/P3

**R2** — `sourceAssertionId` is fabricated. The Phase 6 adapter sets it to
`projection.projectionId` unconditionally; F–I use
`assertionIds[0] ?? candidateId`, which is order-dependent and drops assertions
2..N entirely. Persisted onto the canonical row but excluded from the row hash,
so nothing can detect it.

**R3** — `directOrDerived` defaults to `direct` when `values.direct` is absent,
over-claiming provenance and contradicting the module's own stated rule that a
missing field blocks rather than defaults. **Needs an upstream-contract decision**
before changing: the projector spec's base fixture omits `direct` and expects
success, so upstream likely relies on the default.

**R4** — `projectionHash` is the artifact SHA, so every row from one document
shares it. Value changes are still caught via `proposedRowHash`, so this is
audit-trail accuracy, not a safety hole.

**R5** — the registry declares `compatibility` (43 refs), source observations
(47), and typed relationships (13) that the projectors never read. Same shape as
P1-2.

None of these block L. They are real and want a dedicated pass, probably
alongside O's negative-control work — several are exactly the shape of defect a
negative control would inject.

---

## 7. Boundaries — changed this session, read carefully

Neo authorized **merging to `main`**, and that has happened. Neo explicitly
**held the deploy**.

**`main` now contains two Phase 7 migrations that no shared database has
applied.** `scripts/deploy-dev.sh` line 22 says it outright: _"we ALWAYS migrate
before rolling the API — there's no 'does this PR have a migration' check."_ So
the next routine `deploy-dev.sh` anyone runs — for an unrelated web change, a
routine roll, anything — will apply them to `capiro-dev`. That is no longer a
Phase 7 decision someone makes deliberately; it is the default behaviour of the
next deploy. **Tell the team.**

The session-4 §7 carve-out still stands and was the reason the deploy was held:
authorization to merge and ship does **not** extend to applying Phase 7
migrations to any shared database, production baseline snapshot creation,
production canonical promotion, active-snapshot switch, production rollback,
enabling production read flags, or enabling client alert fan-out.

**Operator action still outstanding (Workstream N):** the promoter role's
Secrets Manager secret and `PROMOTER_USER`/`PROMOTER_PASSWORD` on
`ApiBootstrapRolesTaskDef`. Until provisioned, `capiro_pe_promoter` cannot
authenticate outside a disposable rehearsal — the intended fail-closed state.

**Front-end gap created this session:** the two-step flow means a corrected value
no longer lands on the first click. **The admin UI needs a pending state and a
second action**, and nothing in `apps/web` knows about it yet.

---

## 8. What "fully complete" cannot mean

Three Definition-of-Done items do not close by writing code, and should be
tracked as operator/reviewer items rather than quietly marked done:

- **#31** production-scale rehearsal against _measured_ production SLOs. Plan
  §O.7: "Do not invent numbers without measuring current baselines." Requires a
  production-scale dataset and real SLO measurement.
- **#35** independent closeout reporting no P0/P1. The plan requires a fresh
  context that is **not** the primary implementer. An implementer reviewing
  their own work does not satisfy it.
- The **canary acceptance matrix** — separate authorization, real tenant.

---

## 9. Definition of done for the next session

Finish L: production code implemented, focused tests passing, typecheck compared
against the **6-error** baseline, formatting applied to new files, the rehearsal
extended to cover the new database behaviour — **the drainer needs a real
`FOR UPDATE SKIP LOCKED` proof with concurrent drainers, not just a unit test** —
and a coherent commit landed. Open a successor PR to #784, which is merged.

Then re-run `verify:pe-budget-phase-1` through `-6`.

Report exact commands, exit codes, and test counts. A workstream is done when it
is demonstrated, not when the files exist.
