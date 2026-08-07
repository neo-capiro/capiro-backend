# Phase 7 handoff — Session 6 → Session 7

**Mission for the next session: finish Workstream M — the surface cutover. Then N, then O.**

Workstreams **A through L are complete**, including K's last item, which turned
out to be a read concern and landed in M. **M is PARTIAL**: its whole foundation
and its containment are implemented and demonstrated, and the surface-by-surface
migration of the read services is not. N and O have not been started.

Read §3 before anything else — it is specific about where the line falls, because
"Workstream M" appearing in a commit log is otherwise easy to mistake for
"product APIs run from the active snapshot", which is not true yet.

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
| HEAD before this handoff | `20ad74f2e`                                                      |
| Unpushed                 | **7 commits** (3 inherited + 4 from this session)                |
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
38d7307cf  docs(pe): Phase 7 session 6 handoff — next session starts Workstream M
20ad74f2e  feat(pe): Phase 7 WS M — snapshot reads, override overlay, shadow compare, containment
           docs(pe): Phase 7 session 6 handoff — M partial, surface cutover remains
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

### Workstream M, foundation and containment (`20ad74f2e`)

Everything lands inert. `PE_SNAPSHOT_READ_MODE` defaults to `legacy`, mirroring
`KG_TRAVERSAL_SOURCE`, so no caller's behaviour changes until a flag moves.

- **`snapshot-read-mode-v1`** — the four modes. Two rules that are not obvious: a
  non-canary tenant in canary mode is served legacy _and compared_ (the canary
  exists to find what shadow missed, and dropping comparison for the traffic
  still on legacy discards the larger sample); and **no active pointer forces
  legacy in every mode**, because a snapshot read with no activation is a product
  outage, not an empty result.
- **`snapshot-read-repository-v1`** — the pointer is resolved **once per
  request** and every read is scoped to that id. "One response never mixes
  snapshots" is not satisfied by careful queries: a PE profile issues several
  reads, and an activation committing between the first and the last hands the
  caller half of one annual cycle and half of another, each read individually
  correct. `assertOneSnapshotV1` is the belt to that braces.
- **`manual-override-overlay-v1`** — Workstream K's last item. The official value
  survives as `officialMoney`, and the canonical row hash is untouched: an
  override does not make a row a different government fact, it makes it one
  someone has corrected. A proposal is not in force. An in-force override whose
  target the snapshot lacks comes back as `unmatched` rather than applied or
  dropped.
- **`shadow-read-comparison-v1`** — all seven plan §M.9 classes. The result type
  has nowhere to put a value; shadow mode runs on production traffic, so a
  mismatch log that quoted the bodies would be a continuous export of budget data
  into a log aggregator. A spec asserts that directly.
- **`legacy-budget-write-gate-v1`** plus the dispatcher — the twelve verbs that
  load, rebuild, or repair canonical budget rows now refuse `--commit`. Inspect
  survives. `PE_LEGACY_BUDGET_WRITES=allow` is the operator override, and a
  snapshot or canary read mode overrides the override.

The switch is at the entry points rather than inside
`ProgramElementWriterService` on purpose: that service is the shared write path
for ordinary product behaviour, and a default-off gate inside it would refuse
writes the product still legitimately makes, during M rather than at the
rollout's freeze step.

---

## 3. Workstream brief — finishing M

**What exists:** the mode resolver, the active-snapshot resolver, the snapshot
read port and its Prisma adapter, the override overlay, shadow comparison, and
the containment gate. All unit-tested, and proved against a real database by
`scripts/pe-budget-phase7-read-rehearsal.ts` running **as `capiro_app`** — 26
checks covering pointer resolution, exact money, a real override applied with
provenance, and four refused write attempts.

**What does not exist, and is the next session's work:**

1. **The surface migration.** `program-element-read.service.ts` (1700+ lines),
   `budget-lines-read.service.ts` (830), `program-element.controller.ts`,
   `budget-lines.controller.ts`, and `meri/meri-tools.service.ts` all still read
   the legacy tables. Plan §M's acceptance criterion — "product APIs can run
   fully from the active snapshot" — **is not met.**
2. **Family-shaped read models.** The snapshot substrate is one discriminated
   table; every surface in plan §M.3 (PE finder/profile, timeline, projects,
   performers, milestones, funding positions, procurement/O&M/MILCON, sources,
   actions/provisions, movement, watches) needs a projection from canonical rows
   into the shape its existing response contract already promises. This is the
   bulk of the remaining work.
3. **Wiring shadow mode into a request path.** `compareShadowReadV1` is pure and
   ready; nothing calls it yet, because there is no snapshot response to compare
   against until (1) and (2) exist.
4. **Tenant overlays after global snapshot selection** (plan §M.4). The read port
   is global by design; watches and relevance are tenant-scoped and must join
   after the snapshot is chosen.
5. **The `program_element_delta` readers** — migrate them onto
   `defense_budget_canonical_delta`, or decide explicitly that they stay on the
   compatibility projection. Six call sites in
   `program-element-read.service.ts`, `action-recommendation.service.ts`,
   `product-metrics.service.ts`, and `delta-engine.service.ts`.
6. **Static gates** (plan §M.15) — deliberately absent. The plan places them
   after canary acceptance, and the runtime switch is the live control until then.
7. **The admin UI pending state.** Created in session 5, still open: the two-step
   override flow means a correction no longer lands on the first click, and
   nothing in `apps/web` knows.

**Do the source sweeps with `grep -a` or `readFileSync`.** See gotcha #6 — it is
worse than session 5 recorded.

---

## 4. Baselines

Measured on this branch, this session, all locally reproduced.

| Check                                                    | Result                                                        |
| -------------------------------------------------------- | ------------------------------------------------------------- |
| `jest src/defense-budget/promotion`                      | **578 passed, 21 suites** (was 423 / 12)                      |
| `jest src/config src/defense-budget src/program-element` | **3397 passed, 253 suites**                                   |
| `jest src/program-element`                               | **723 passed, 61 suites**                                     |
| `pnpm --filter @capiro/api typecheck`                    | **6 errors**, the documented pre-existing set                 |
| `prettier --check` on every file touched                 | clean                                                         |
| `verify:pe-budget-phase-7:db` (rehearsal)                | **100 shell + 24 engine + 39 drain + 26 read checks**, exit 0 |
| `verify:pe-budget-phase-1`                               | 859 passed, 59 suites, exit 0                                 |
| `verify:pe-budget-phase-2`                               | 840 passed, 58 suites, exit 0                                 |
| `verify:pe-budget-phase-3`                               | 216 passed, 16 suites, exit 0                                 |
| `verify:pe-budget-phase-4`                               | 305 passed, 20 suites, exit 0                                 |
| `verify:pe-budget-phase-5`                               | 358 passed, 28 suites, exit 0                                 |
| `verify:pe-budget-phase-6`                               | 779 passed, 78 suites + 24/24 negative controls, exit 0       |
| GitHub Actions                                           | still dead repo-wide; every claim above is local              |

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

### New: the containment gate changes scheduled-task behaviour on the next deploy

The twelve dispatcher budget verbs now refuse `--commit` with
`PE_LEGACY_BUDGET_WRITES` unset, and that variable is unset everywhere. **Any
scheduled ECS task that passes `--commit` to one of them starts exiting 64 the
first time this image is deployed.** That is the rollout's step-0 freeze arriving
as a side effect of a deploy rather than as a decision.

This is intended containment, not an accident, but it needs Workstream N to
finish the thought: N owns setting `PE_LEGACY_BUDGET_WRITES=allow` on whichever
legacy task definitions are still permitted to run, and removing it again at
rollout step 15. **Until N does that, do not deploy this branch without checking
`ingestion-schedule.ts` and `scheduled-ingestion-jobs.ts` for verbs in the
containment list** — `LEGACY_BUDGET_DISPATCHER_VERBS_V1` in
`legacy-budget-write-gate-v1.ts` is the authoritative list.

The alert emitters (`emit-changes`, `emit-bill-alerts`, `emit-committee-changes`,
`send-pe-alert-emails`) are deliberately **not** in that list. They publish rather
than write canonical rows, and the rollout's own final step is where they are
gated.

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

Finish M: the surface migration in §3 items 1–5, with shadow comparison actually
wired into a request path and run against fixtures rather than described. The
honest test of "done" for M is plan §M's own words — a product API served
entirely from the active snapshot, with a measured mismatch rate.

Then N, then O. N cannot be finalized until D/E/L/M's security boundaries are
accepted (plan's dependency rules), and N owes the two loose ends this session
created: the drain resume command, and `PE_LEGACY_BUDGET_WRITES` on the legacy
task definitions.

Typecheck against the **6-error** baseline, formatting applied, and re-run
`verify:pe-budget-phase-1` through `-6` before your own handoff.

Open a successor PR to #784, which is merged.

Report exact commands, exit codes, and test counts. A workstream is done when it
is demonstrated, not when the files exist — and M in particular is easy to
over-claim, because its foundation is complete and its purpose is not yet served.

Report exact commands, exit codes, and test counts. A workstream is done when it
is demonstrated, not when the files exist.
