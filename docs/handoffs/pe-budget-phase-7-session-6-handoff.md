# Phase 7 handoff — Session 6 → Session 7

**Mission for the next session: Workstream M.**

Workstreams **A through L are complete** (K bar one M-dependent item). M, N, O
remain. L's database half — everything the session-5 handoff listed as missing —
is implemented and demonstrated against a real PostgreSQL.

Authoritative spec: `phase-7-verified-canonical-promotion-production-cutover-v1.md`.
This handoff records repository reality, not a substitute for that plan.

> **Read this first.** Two operational facts, both consequences of work that has
> already landed:
>
> 1. `main` still carries Phase 7 migrations **no shared database has applied**,
>    and `deploy-dev.sh` always migrates before rolling the API. The next routine
>    deploy anyone runs applies them to `capiro-dev`. Unchanged from session 5,
>    and still the single most important operational fact on this branch — with
>    one more migration on it now.
> 2. **A rollback now really pauses the side-effect drain, and nothing in the
>    product can un-pause it.** Session 5 shipped `pauseSideEffectDrain` as an
>    honest no-op; it is now backed by a real table that the drainer reads. Until
>    Workstream N adds `resume-defense-budget-promotion-side-effects-v1`, the
>    only ways to resume are the exported `resumeDrainV1` or one SQL statement.
>    See §7.

---

## 1. Repository state

| Item                     | Value                                                            |
| ------------------------ | ---------------------------------------------------------------- |
| Branch                   | `agent/pe-budget-canonical-promotion-cutover-v1`                 |
| HEAD before this handoff | `67854a868`                                                      |
| Unpushed                 | **5 commits** (3 inherited + 2 from this session)                |
| `origin/main`            | `458249f8e` — 59 commits ahead of this branch, no new migrations |
| Merged main this session | **No** — see below                                               |
| Worktree                 | clean                                                            |
| PR #784                  | merged; a successor PR is still needed                           |

### Why main was not merged

`git fetch` fails in this environment (no credentials, non-interactive), so the
`origin/main` ref is only as fresh as the last successful fetch. Merging 59
commits of unrelated product work from a possibly-stale ref, mid-workstream,
would have muddied a self-contained diff for no gain. **Confirmed before
deciding: `origin/main` adds no migrations**, so there is no numbering conflict
with `20260902010000`. Merge when the successor PR is opened.

### Commits added this session

```text
67854a868  feat(pe): Phase 7 WS L — outbox drain adapter, pause state, and generic deltas
           docs(pe): Phase 7 session 6 handoff — next session starts Workstream M
```

Files changed by the first commit: the migration
`20260902010000_pe_budget_phase7_outbox_drain`, `schema.prisma`, four new
modules and four new specs under `src/defense-budget/promotion`, edits to
`promotion-outbox-drain-v1.ts`, `canonical-promotion-service-v1.ts` and its
Prisma adapter and spec, the new `scripts/pe-budget-phase7-drain-rehearsal.ts`,
and `scripts/pe-budget-phase7-migration-rehearsal.sh`. **Nothing under
`src/program-element` or `apps/web` was touched.**

### First four commands

```bash
git -C <clone> fetch origin && git -C <clone> merge origin/main --no-edit
pnpm install --frozen-lockfile
pnpm turbo run build --filter=@capiro/shared --filter=@capiro/meriv2-core --filter=@capiro/auth --filter=@capiro/strategy-verifier
pnpm --filter @capiro/api exec prisma generate   # and the three projection schemas — see §5
```

**Do the `prisma generate` even if you think nothing changed.** This recurs on
every merge and has cost time in three consecutive sessions.

---

## 2. What changed this session

All of Workstream L's remaining six items, as listed in the session-5 brief.

### The migration — `20260902010000_pe_budget_phase7_outbox_drain`

Third Phase 7 migration, separate from `20260822010000` for the same reason
Workstream K's queue link is: that one is gated as purely additive and this one
adds a column to a table it created.

- `defense_budget_promotion_outbox.last_attempted_at` — the instant the drain
  policy's backoff is measured from. Without it the policy had a backoff nothing
  could measure.
- `defense_budget_side_effect_drain_pause` — pause state per (domain,
  environment), with the resume fields constrained to agree with `paused`.
- `defense_budget_canonical_delta` — the generic snapshot-to-snapshot delta,
  append-only via the Workstream D ledger trigger.

**The delta table repeats the stage-to-field authority CHECK.** The F–J review's
P1 was that a request-side candidate could assert a congressional mark, and the
damage that finding described was that mark _travelling through L's delta engine
into a client alert_. This table is that engine's output, so it refuses the same
defect at the last structure before a client can see it.

### The drain adapter — `promotion-outbox-drain-repository-prisma-v1.ts`

One claim statement, and nearly all the weight is in it:

- `FOR UPDATE SKIP LOCKED` in a CTE feeding the UPDATE, so concurrent drainers
  partition the backlog. A select-then-update would let two drainers take the
  same row.
- The pause check rides inside the same statement as a `NOT EXISTS`, closing the
  window between the policy's `isDrainPaused` round trip and the claim.
- **The eligibility SQL is generated from the policy, not restated.**
  `outboxBackoffCaseSqlV1` calls `drainBackoffMsV1` to build the `CASE`. A second
  handwritten copy of the backoff curve would agree today and drift the first
  time one was tuned, with nothing able to see it.

### Money on the outbox — the decision session 5 left open

**Resolved at drain time, not through `PromotionPlanItemV1`.** Carrying the prior
value in the plan item changes what `promotionPlanHashV1` hashes, which
invalidates every authorization already issued and needs a deliberate
`DEFENSE_BUDGET_PROMOTION_PLAN_SCHEMA_VERSION` bump — a large blast radius for a
reporting field. The claim instead joins `defense_budget_canonical_row` on the
identity unique key for both snapshots and `COALESCE`s, so a future writer that
does populate the columns still wins. Both snapshots are immutable, so the
answer is fixed and identical on every replay.

### Pause and resume are real

`canonical-promotion-repository-prisma-v1.ts` no longer no-ops them. Both the
rollback path and the drainer go through `side-effect-drain-pause-prisma-v1.ts`
so they cannot grow separate ideas of what a pause means.

The port signature gained a `context: { reason, actor }`. A paused drain is an
operational stop someone will eventually find and want to lift, and a pause row
that cannot say who set it or why leaves that person choosing between resuming
blind and leaving side effects stalled.

### The generic delta engine — `canonical-delta-engine-v1.ts`

Replaces `DeltaEngineService` for canonical changes. `program_element_delta` is
**not** removed: six product surfaces read it, and making the canonical delta
primary is L's remit while migrating those readers is M's.

Three decisions worth knowing before changing it:

1. **Identity and stage come from the canonical row, not the outbox row.**
   Workstream E writes `stage: null` on every outbox row, so a delta that copied
   it would carry a congressional field with no authority naming it and the new
   CHECK would refuse the insert at drain time.
2. **Typed axes decide _what_ changed; the row hash decides _whether_ anything
   did.** A hash difference no typed axis explains is the `attributes` axis.
   Exact, cheap, and it cannot miss a change.
3. **No `intelligence_change`, no alerts.** Plan L.13. A gate in
   `canonical-delta-engine-v1.spec.ts` scans the whole promotion directory for
   `intelligenceChange` / `programElementChangeOutbox` — with comments stripped,
   and reading files through `readFileSync` rather than any ripgrep-backed
   search, for the reason in gotcha #6.

### Properties L must not break

Everything in the session 2–5 handoffs still holds. Four more:

18. **The claim query and `isClaimableV1` are one policy in two languages.** The
    rehearsal seeds both sides of every boundary and fails if they disagree. If
    you tune the backoff, do it in the policy; the SQL follows.
19. **A claimed row is `PROCESSING` and committed, so a dead drainer strands it**
    unless the lease reclaims it. `OUTBOX_PROCESSING_LEASE_MS_V1` is what makes
    the port's "recoverable rather than locked forever" promise true.
20. **A delta is computed once from two immutable snapshots.** Per-tenant
    materiality is re-scored at read time and deliberately never stored, so
    there is no legitimate reason to update one — and the trigger refuses.
21. **The money delta is exact; only the score is a float.** `subtractDecimals`
    produces `money_delta_millions`; `Number()` appears once, in
    `scoreInputsFromExactDeltaV1`, feeding a 0..1 log curve where the ninth
    decimal cannot change an outcome.

---

## 3. Workstream brief — M

Plan §M. Read it; this is only what repository reality adds.

1. **Snapshot-aware read repositories** with one active-snapshot resolver.
   `program-element-read.service.ts` (1700+ lines) and
   `budget-lines-read.service.ts` (830) are the two surfaces. Existing HTTP
   response contracts stay stable; provenance fields are additive.
2. **Read-time manual override overlay** — this is Workstream K's one unfinished
   item, and it belongs here because it is a read concern. Property 17 from the
   session-5 handoff: an override is never a source observation and never a
   column on a canonical row; it is applied _beside_ the snapshot at read time
   with a visible provenance label.
3. **Rollout mode** `legacy | shadow | snapshot_canary | snapshot`, with digest
   comparison over normalized responses and the seven mismatch classes from
   plan §M.9.
4. **Legacy writer containment** — runtime kill switch, the new entrypoint
   commands, dispatcher verbs refusing canonical `--commit`, and the static
   gates. Note plan §M.15 gates these only _after_ canary acceptance.
5. **Migrate the `program_element_delta` readers**, or decide explicitly that
   they stay on the compatibility projection. The six call sites are in
   `program-element-read.service.ts`, `action-recommendation.service.ts`,
   `product-metrics.service.ts`, and `delta-engine.service.ts`.
6. **The admin UI pending state.** Created in session 5 and still open: the
   two-step override flow means a correction no longer lands on the first click,
   and nothing in `apps/web` knows.

**Do the source sweeps with `grep -a` or `readFileSync`.** See gotcha #6 — it is
worse than session 5 recorded.

---

## 4. Baselines

Measured on this branch, this session, all locally reproduced.

| Check                                     | Result                                                  |
| ----------------------------------------- | ------------------------------------------------------- |
| `jest src/defense-budget/promotion`       | **505 passed, 16 suites** (was 423 / 12)                |
| `jest src/program-element`                | **723 passed, 61 suites**                               |
| `pnpm --filter @capiro/api typecheck`     | **6 errors**, the documented pre-existing set           |
| `prettier --check` on every file touched  | clean                                                   |
| `verify:pe-budget-phase-7:db` (rehearsal) | **98 shell + 24 engine + 39 drain checks**, exit 0      |
| `verify:pe-budget-phase-1`                | 859 passed, 59 suites, exit 0                           |
| `verify:pe-budget-phase-2`                | 840 passed, 58 suites, exit 0                           |
| `verify:pe-budget-phase-3`                | 216 passed, 16 suites, exit 0                           |
| `verify:pe-budget-phase-4`                | 305 passed, 20 suites, exit 0                           |
| `verify:pe-budget-phase-5`                | 358 passed, 28 suites, exit 0                           |
| `verify:pe-budget-phase-6`                | 779 passed, 78 suites + 24/24 negative controls, exit 0 |
| GitHub Actions                            | still dead repo-wide; every claim above is local        |

> The session-5 handoff recorded `jest src/program-element` as "1123 passed, 72
> suites (with promotion)". That arithmetic implies 700 tests / 60 suites for
> `src/program-element` alone, against 723 / 61 measured here. **No file under
> `src/program-element` was touched this session** — `git status` is in §1's
> commit. Treat the numbers in this table as the baseline and the older figure
> as measured differently.

---

## 5. Environment gotchas — carried forward, one sharpened

1. `pnpm install` alone leaves hundreds of phantom errors. Also run the turbo
   build of workspace packages and `prisma generate` for all four schemas.
2. **A silent merge can desync the Prisma client.** Always regenerate after
   merging; if typecheck shows more than the documented baseline, regenerate
   before assuming you introduced a regression.
3. Four Prisma schemas, all literally named `schema.prisma`. Compare full paths.
4. The rehearsal image must be `pgvector/pgvector:pg16`.
5. `DATABASE_URL` must be set for `prisma validate` / `verify:pe-budget-phase-6`,
   even though it never connects.
6. **Two files in `src/defense-budget/promotion` contain literal NUL bytes**, not
   one. Session 5 recorded `promotion-planner-v1.ts` (3 bytes);
   **`canonical-promotion-service-v1.ts` has 6** and is skipped just as
   silently — it is the file that defines the promotion repository port, so a
   sweep for a port method finds the implementation and the call site and misses
   the declaration. Use `grep -a`, `Select-String`, or `readFileSync`. Verified
   this session: an ordinary `Grep` for `SideEffectDrain` returned the spec and
   the adapter and _not_ the interface that declares it.
7. **Migration `20260822010000` is gated as purely additive.** Anything touching
   a pre-existing table needs its own migration — that is why the queue link is
   `20260822020000` and the drain column is `20260902010000`.
8. **Postgres pads `NUMERIC` to its declared scale.** `NUMERIC(24,9)` returns
   `1.250000000` for a stored `1.25`, which is not canonical decimal form. Any
   adapter reading money out of a NUMERIC must normalize through
   `parseCanonicalDecimalString`.
9. **`reconciliation_review_queue.id` is a Prisma-side `@default(uuid())`**, not
   a database default. Raw SQL inserts must supply it.
10. **Partial indexes have no Prisma representation** and are simply absent from
    `schema.prisma` in this repository — the one-use authorization index set the
    precedent, and the drain eligibility index follows it. Adding a non-partial
    twin to the Prisma schema would create drift.
11. **A source-scanning gate must strip comments first.** The L.13 gate matched
    its own header explaining that it emits no `intelligence_change`. Same
    lesson as the migration gate, and the same shape as open finding P1-8.

---

## 6. Open findings

### From the independent review of E — unchanged, still open

**P1-2** — `mapping_registry_drift` is declared but never emitted. The service
never compares `canonicalMappingRegistryHashV1()` against
`plan.mappingRegistryHash`, nor the authorization's `eligibilityHash` against
the plan's.

**P1-8** — the architecture gates are name-list regexes over one file's text; 13
constructed violations all passed. The L.13 gate added this session is the same
shape, with two mitigations the others lack: comments are stripped, and it
scans a whole directory through `readFileSync` rather than one file through a
tool that skips binaries.

**P1-9 / P1-10** — the Workstream E Prisma adapter still has no unit spec and
five refusal branches are untested. K's adapter has one, and L's adapter now has
one too; both were worth writing.

**P2 cluster** — unchanged: `findActivationByKey` failure swallows the original
error; the ambiguous-vs-determinate classifier doesn't match real `P1001`/`P1017`
shapes; the lock connection has no error handler or acquisition timeout; the lock
key omits `environment`; `execute()` never compares `expectedActiveSnapshotId` on
the authorization while `rollback()` does; `cancel()` has a TOCTOU with
`execute()`; `recordPlanItemsStaged` updates a table nothing else inserts into.

### From the F–J review — unchanged, all P2/P3

**R2** `sourceAssertionId` is fabricated. **R3** `directOrDerived` defaults to
`direct` and needs an upstream-contract decision. **R4** `projectionHash` is the
artifact SHA. **R5** the registry declares compatibility, source-observation, and
relationship behaviour the projectors never read.

### New this session

**L1 (P2)** — `resumeSideEffectDrain` has no operator surface. See §7.

**L2 (P3)** — the delta engine's materiality reuses the PE scorer from
`program-element/deltas/materiality-scorer.ts`. It is pure and imports nothing,
so it brings no coupling, but it is a defense-budget module importing from the
legacy product module. If Workstream M's static gates ban that direction, move
the scorer to a shared home rather than duplicating it.

None of these block M.

---

## 7. Boundaries — one new consequence, read carefully

Neo authorized **merging to `main`** in session 5 and explicitly **held the
deploy**. That is unchanged, and so is the session-4 carve-out: authorization to
merge and ship does **not** extend to applying Phase 7 migrations to any shared
database, production baseline snapshot creation, production canonical promotion,
active-snapshot switch, production rollback, enabling production read flags, or
enabling client alert fan-out.

**Nothing was pushed, deployed, merged, or applied to a shared database this
session.** Every database statement ran against a disposable container that was
destroyed on exit.

### New: a rollback now wedges the drain until someone resumes it

This is a real consequence of making the pause real, and it is mine.

Before this session `pauseSideEffectDrain` did nothing, so a rollback left the
(non-existent) drainer running. It now writes a pause row that the drainer
honours, and **nothing in the product can clear it** — Workstream N owns
`resume-defense-budget-promotion-side-effects-v1`, which does not exist yet.

Until it does, the supported interim is one statement as the promoter or owner:

```sql
UPDATE defense_budget_side_effect_drain_pause
   SET paused = false, resumed_by = '<actor>', resumed_at = now(), updated_at = now()
 WHERE domain = 'defense_budget' AND environment = '<env>';
```

`resumeDrainV1` in `side-effect-drain-pause-prisma-v1.ts` does exactly this and
is what N's command should call. This cannot bite production yet — no promotion
has run there and the promoter role still cannot authenticate — but it will bite
the first rehearsal or dev promotion that rolls back.

**Operator action still outstanding (Workstream N):** the promoter role's
Secrets Manager secret and `PROMOTER_USER`/`PROMOTER_PASSWORD` on
`ApiBootstrapRolesTaskDef`. Until provisioned, `capiro_pe_promoter` cannot
authenticate outside a disposable rehearsal — the intended fail-closed state.

**Front-end gap, still open from session 5:** the two-step override flow means a
corrected value no longer lands on the first click, and nothing in `apps/web`
knows.

---

## 8. What "fully complete" cannot mean

Unchanged from session 5, and worth repeating because three Definition-of-Done
items do not close by writing code:

- **#31** production-scale rehearsal against _measured_ production SLOs. Plan
  §O.7: "Do not invent numbers without measuring current baselines."
- **#35** independent closeout reporting no P0/P1, from a fresh context that is
  **not** the primary implementer.
- The **canary acceptance matrix** — separate authorization, real tenant.

The plan also says O "cannot be compressed into another session" and that no
session should execute more than four implementation workstreams. M and N are
two; O is its own.

---

## 9. Definition of done for the next session

Workstream M: production code implemented, focused tests passing, typecheck
compared against the **6-error** baseline, formatting applied, and the shadow
comparison actually run against fixtures rather than described. Then re-run
`verify:pe-budget-phase-1` through `-6`.

Open a successor PR to #784, which is merged.

Report exact commands, exit codes, and test counts. A workstream is done when it
is demonstrated, not when the files exist.
