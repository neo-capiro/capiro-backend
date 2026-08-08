# Phase 7 handoff — Session 7 → Session 8

**Mission for the next session: finish Workstream M's surface migration for real —
starting with the two blockers this session found — then N, then O.**

Session 6 left M "PARTIAL: foundation and containment done, surface migration
not." Session 7 wired the foundation into one real, working method pair
(`getBudgetPositions`/`getPbComparison`), with `compareShadowReadV1` actually
proven end-to-end for the first time. It then discovered that the two
highest-value remaining methods — `getProgramElement`/`getTimeline` (the PE
profile's funding grid) and `getContractors` (named primes) — are blocked by
real, repo-wide architecture gaps, not by time pressure. Both are described in
§3. Read that section before assuming the next session can just "do the same
thing again" for the next method on the list — it can't, until one of the two
gaps is closed.

Authoritative spec: `phase-7-verified-canonical-promotion-production-cutover-v1.md`
(supplied out-of-band; not checked into this repo — see the session-6 dependency
map's own note on this). This handoff records repository reality.

> **Read this first.** Three operational facts:
>
> 1. `main` still carries Phase 7 migrations no shared database has applied
>    (unchanged since session 4, now a fourth migration deep — none added this
>    session, but the fact stands). `deploy-dev.sh` always migrates before
>    rolling the API.
> 2. **A rollback still pauses the side-effect drain**, but as of this session
>    there is finally a real command to resume it:
>    `resume-defense-budget-promotion-side-effects-v1` (wired into
>    `entrypoint.sh`). The old interim (raw SQL / `resumeDrainV1` called
>    directly) still works; this is the first supported operator path.
> 3. **`derive-budget-actions --commit` is now gated even when spawned directly**
>    by `run-pe-derive-chain.ts`, closing a real bypass in the containment gate
>    the session-6 handoff didn't know about. See §2/§6.

---

## 1. Repository state

| Item                     | Value                                                                 |
| ------------------------ | --------------------------------------------------------------------- |
| Branch                   | `agent/pe-budget-canonical-promotion-cutover-v1`                      |
| HEAD before this handoff | `1553f7706` (unchanged — nothing committed this session)              |
| Uncommitted this session | 11 modified files, 7 new files (see `git status`)                     |
| Unpushed                 | 8 commits (unchanged from session 6; this session added none)         |
| `origin/main`            | Not re-fetched this session (`git fetch` still fails, no credentials) |
| Worktree                 | Dirty — everything below is uncommitted, pending Neo's review         |
| PR #784                  | merged; a successor PR is still needed                                |

**Nothing was committed this session.** Every file below is a working-tree
change. Review before committing — this handoff is written against the
uncommitted diff, not a commit.

### Files changed this session

New:

```
apps/api/src/defense-budget/promotion/snapshot-row-grouping-v1.ts       (+spec)
apps/api/src/defense-budget/promotion/snapshot-read-port.tokens.ts
apps/api/src/program-element/snapshot/pe-snapshot-gate.service.ts       (+spec)
apps/api/src/program-element/snapshot/pe-shadow-compare.helper.ts       (+spec)
apps/api/src/program-element/snapshot/pe-funding-position-projector-v1.ts (+spec)
apps/api/scripts/status-defense-budget-promotion-v1.ts
apps/api/scripts/resume-defense-budget-promotion-side-effects-v1.ts
docs/handoffs/pe-budget-phase-7-session-7-handoff.md (this file)
```

Modified:

```
apps/api/src/program-element/program-element-read.service.ts   (+spec updates)
apps/api/src/program-element/program-element.module.ts          (DI wiring)
apps/api/scripts/derive-budget-actions.ts                       (containment fix)
apps/api/scripts/entrypoint.sh                                  (2 new verbs)
apps/api/scripts/pe-budget-phase7-migration-rehearsal.sh         (+3 fixture rows)
apps/api/scripts/pe-budget-phase7-read-rehearsal.ts              (+6 checks)
infra/cdk/bin/capiro.ts                                          (promoterDbSecret wiring)
infra/cdk/lib/data-stack.ts                                      (PromoterSecret)
infra/cdk/lib/compute-stack.ts                                   (promoter task def + bootstrap-roles secrets)
infra/cdk/test/compute-stack.tango.spec.ts                       (fixture prop)
```

### First commands for whoever picks this up

```bash
cd apps/api && pnpm exec tsc --noEmit -p .        # confirm still 6 errors, none new
pnpm exec jest src/program-element src/defense-budget src/config
bash scripts/pe-budget-phase7-migration-rehearsal.sh   # 196 checks, disposable Postgres
cd ../../infra/cdk && pnpm exec cdk synth --context account=967807252336 --context region=us-east-1 Capiro-dev-Compute Capiro-dev-Data
```

If `npx tsx` fails with "not recognized" on Windows/Git Bash, that's a local
PATH issue, not a repo defect — `npx` was resolving to a different Node
install than the one with the workspace's `node_modules`. Prepend
`apps/api/node_modules/.bin` (and repo-root `node_modules/.bin`) to `PATH`
before running the rehearsal shell script.

---

## 2. What changed this session

### Workstream M — one real migrated method pair, with shadow-compare proven

**`getBudgetPositions`/`getPbComparison`** (`program-element-read.service.ts`)
now branch on `PE_SNAPSHOT_READ_MODE` via the new `PeSnapshotGateService`,
serving `canonical_rdte_budget_position` rows through a new projector when
`serve==='snapshot'`, and scheduling a detached `compareShadowReadV1` call
when `compare===true`. Both methods fall back to pure pre-session-7 behavior
when no gate is injected (existing specs construct the service with 2 args and
keep working unmodified).

New infrastructure, all reusable by future methods:

- **`snapshot-row-grouping-v1.ts`** — the one generic gap in the read port:
  `groupSnapshotRowsByParentV1`/`indexSnapshotRowsByNaturalKeyV1`. Lives in
  `promotion/`, not `program-element/`, because every family needs
  parent→child grouping.
- **`pe-snapshot-gate.service.ts`** — one `@Injectable()` wrapping
  `resolveSnapshotReadModeV1` + a **fresh-per-call**
  `createActiveSnapshotResolverV1` + config. `resolve(tenantId)` once per
  method invocation; `loadRows(query)` passthrough so call sites don't need
  their own port injection.
- **`pe-shadow-compare.helper.ts`** — the single call site for
  `compareShadowReadV1`. `schedulePeShadowComparisonV1` runs the comparison
  detached (never awaited by the caller), so shadow mode never adds to
  client-facing latency and a comparison failure can never fail a request.
  EMF metric `pe.snapshot_shadow_mismatch`, same convention as
  `observability/api-latency.middleware.ts`.
- **`pe-funding-position-projector-v1.ts`** — projects
  `canonical_rdte_budget_position` rows into the exact legacy response shape.
  Two things worth knowing:
  1. The Phase 4 RDT&E projector always calls the number "amount" regardless
     of `valueKind` ('total' or 'quantity') — this projector infers the
     quantity/total split back onto the legacy contract's two columns. **This
     mapping has never been checked against a real promoted row** (nothing has
     been promoted anywhere yet — see §6). Re-verify the first time one exists.
  2. `sourceUrl`/`pageNumber` have no upstream source for this entity at all
     (confirmed against the actual Phase 4 candidate construction) — honest
     `null`s, not a bug.
- New `serveWithSnapshotOptionV1<T>` private method on
  `ProgramElementReadService` — the shared serve/compare dispatcher every
  future migrated method should reuse.

**A real correctness bug was caught and fixed before it shipped**: the legacy
side of both methods originally returned Prisma `Decimal` instances for
`amount`/`quantity`. `JSON.stringify` calls `Decimal#toJSON()` (identical to
`toString()`), so the HTTP contract was always fine — but
`compareShadowReadV1`'s normalizer walks plain objects key-by-key rather than
calling `toJSON()`, so every single shadow comparison would have reported a
false `contract_shape_mismatch` (Decimal object vs. the snapshot side's plain
string). Both legacy paths now explicitly `.toString()` these fields — a
behavior-preserving change for the client, a real fix for the comparator.

**Extended `pe-budget-phase7-read-rehearsal.ts`** with 6 new checks (26 → 32)
proving the funding-position projector against real NUMERIC storage: 3
`canonical_rdte_budget_position` rows (2 total-kind, 1 quantity-kind) seeded
into `pe-budget-phase7-migration-rehearsal.sh` **while the snapshot was still
STAGING** — inserting them after activation hits the immutability trigger
head-on (learned this the hard way; see §6). Proves the quantity/total split,
the honest `sourceUrl`/`pageNumber` nulls, and `getPbComparison`'s real path
(NUMERIC → projector → `computePbComparison`) end to end.

### Workstream N — started, not finished

- **`resume-defense-budget-promotion-side-effects-v1.ts`** and
  **`status-defense-budget-promotion-v1.ts`** — built, wired into
  `entrypoint.sh` (not the dispatcher — confirmed correct per the
  pre-implementation dependency map §4). `resume` closes the session-6 gap
  (rollback pauses the drain; nothing in the product could resume it).
  `status` reports the active snapshot, drain-pause state, and outbox backlog
  by status — read-only.
- **CDK: `capiro_pe_promoter`'s Secrets Manager secret** (`DataStack.promoterSecret`,
  `/capiro/<env>/aurora/promoter`) and **`PROMOTER_USER`/`PROMOTER_PASSWORD`
  on `ApiBootstrapRolesTaskDef`** — the operator action every session-4/5/6
  handoff flagged as outstanding. `bootstrap-roles.ts` already supported these
  env vars (Workstream D); only the CDK wiring was missing. Confirmed via
  `cdk synth` on both `Capiro-dev-Data` and `Capiro-dev-Compute` — no AWS
  mutation, template render only.
- **New one-off `ApiPromoterTaskDef`** (`capiro-dev-api-promoter`), following
  `apiEmbedBackfillTaskDefinition`'s overridable-command shape: no service, no
  schedule, private subnets, dedicated log group, no LLM/parser secrets,
  connects as `capiro_pe_promoter` only.
- **The `run-pe-derive-chain` containment bypass, found and fixed.**
  `run-pe-derive-chain.ts` spawns `derive-budget-actions.ts --commit` directly
  via `spawn()`, bypassing `entrypoint-dispatcher.inc`'s
  `refuse_legacy_budget_commit` entirely — so the live, enabled EventBridge
  rule `capiro-dev-pe-derive-chain` was **not actually contained** even though
  `derive-budget-actions` is one of the twelve gated verbs. Fixed by calling
  `legacyBudgetCommitDecisionV1` directly inside `derive-budget-actions.ts`
  itself, so the gate holds regardless of invocation path. Smoke-tested: exits
  64 before any DB connection with the kill switch off; proceeds normally with
  `PE_LEGACY_BUDGET_WRITES=allow`. **Note the shell dispatcher's own check is
  narrower than the full policy** — it only checks `PE_LEGACY_BUDGET_WRITES`,
  never `PE_SNAPSHOT_READ_MODE` — and this fix intentionally matches that
  narrower behavior rather than silently expanding it; extending both to also
  veto on an active snapshot/canary read is a separate, deliberate follow-on.

**The other six promotion CLI verbs (plan/validate/authorize/execute/compare/rollback)
were not built this session.** Building them to a demonstrated standard (not
just "the file exists") requires wiring `DefenseBudgetCanonicalPromotionServiceV1`'s
full role-specific DB-connection pattern — researched this session from
`pe-budget-phase7-engine-rehearsal.ts`, documented in §3, but too large to ship
and verify in the time remaining. Shipping shallow, unverified stubs for six
commands would have been worse than shipping two real ones.

**Explicitly not done, matching Neo's decision on `PE_LEGACY_BUDGET_WRITES`**:
no CDK change to `ingestion-schedule.ts` this session. `capiro-dev-watch-budget-docs`
will start exiting 64 on the next deploy that ships this branch, and that is
accepted — no canonical snapshot has ever been activated in `capiro-dev` or
production (every promotion run to date, including this session's, is against
disposable rehearsal Postgres), so there is no "new" system for that job to
hand off to yet. Killing it is a deliberate pause, not a cutover.

---

## 3. Workstream brief — finishing M's surface migration

**Two real architecture gaps block the next two most valuable methods.** Both
were found by trying to actually build the projectors, not by inspection.

### Gap 1 — the congressional-mark join has no producer or reader anywhere

`getProgramElement`/`getTimeline`/`listProgramElements` all need the full
8-column funding grid: `request, hascMark, sascMark, hacDMark, sacDMark,
conference, ndaaConference, enacted`. `canonical_rdte_program_element_year`
only ever carries `request` — confirmed by reading
`rdte-projection-planner-v1.ts`'s `case 'funding':` (line ~497), which
explicitly excludes every other field as "contextual_only" / "outyear_not_request".
The other 7 columns are supposed to come from Workstream J's Phase 6
congressional-lifecycle entity, `canonical_stage_position`, keyed by
`nativeIdentityHash` (registry: `['nativeIdentityHash', 'fiscalYear', 'stage', 'fundingField']`).

**A dedicated research pass, then a search across all 767 local + remote
branch tips in this repo (not just this branch), confirmed: no code anywhere
computes a `nativeIdentityHash` or resolves `peCode → nativeIdentityHash`.**
`canonical_native_line_binding` — the registry-declared entity that's supposed
to be this mapping — has zero producer and zero reader anywhere. The pure
identity-key function that exists (`nativeIdentityKeyV1` in
`stages/budget-line-reference-v1.ts`) is used only to build fact/assertion
IDs, never hashed into a `nativeIdentityHash`. `projectPhase6ProjectionsV1`
(`canonical-projectors-v1.ts`) passes `naturalKey` through as an opaque string
with no validation against the registry's declared key fields at all.

**What's actually missing, concretely, for whoever picks this up:**

1. A producer that, given a verified Phase 6 stage assertion (which already
   carries the full `BudgetLineIdentityV1` — see `sasc-emission-v1.ts:77`),
   emits a `Phase6NativeProjectionV1` with a `nativeIdentityHash` computed by
   some canonical, _published_ rule (e.g. `sha256Hex(nativeIdentityKeyV1(identity))`
   — this convention doesn't exist yet and needs a deliberate decision, ideally
   exported alongside `nativeIdentityKeyV1`).
2. A producer + repository for `canonical_native_line_binding` rows that
   actually persist the `peCode ↔ nativeIdentityHash` mapping queryable
   somewhere (today `attributes` is the only slot available, and nothing
   enforces it's populated).
3. Only then can a read-time projector either compute the hash directly from
   `peCode` (if the convention is guaranteed stable) or query the binding
   table.

This is bigger than a Workstream M gap — it blocks Workstream J's own stated
acceptance criterion ("the complete lifecycle is queryable without field
conflation"). Flag it to whoever owns J/N; it is not something to solve inside
a read-migration pass.

### Gap 2 — the canonical performer projection doesn't carry `isNamedCompany`/`publisher`

`getContractors`' `namedPrimes` panel filters legacy rows on
`program_element_performer.is_named_company = true` — a **selection
criterion**, not a display field — and builds its attribution string from
`publisher`. Neither field exists in the Phase 4 `canonical_rdte_performer`
projection candidate's values bag (`rdte-projection-planner-v1.ts:776-790`),
confirmed directly, and confirmed absent on every other branch too. Every
other field `getContractors` needs (`performerRole`, `location`,
`contractMethod`, `costCategory`, `totalCostM`, `sourceUrl`, `pageNumber`) _is_
carried in `attributes` — this is specifically the named-company classifier
and the publisher citation that are missing. Without the selection criterion
there's no honest way to decide which canonical rows are "named primes"
without inventing a heuristic the upstream projector never made.

### What's left once one of the two gaps is closed

`getContractors`' `data` field (USAspending/`federal_award` dollar flow) has
no canonical entity at all regardless of Gap 2 — it stays legacy in every
mode, same durable-seam treatment as `listProgramElements`' `sig` columns.
Only `namedPrimes` would move.

`listProgramElements` also needs its own pass even after Gap 1 closes: the
catalog filter/search/pagination SQL stays legacy always (it's PE-catalog
metadata, not a funding position, per the mapping registry's `moneyRule: 'none'`
identity entries), and the `program_element_delta`-sourced `sig` signal
columns stay legacy in every mode too (see the delta disposition below,
unchanged from the plan). Only the funding-derived columns would move.

### Still fully open, unchanged from the original plan

- **All 9 `BudgetLinesReadService` methods** — not attempted, no new findings.
- **`getBills`, `getProvisionsForPe`** — no clean canonical entity for bill
  history/provision text. Untouched.
- **`listSamOpportunities`** — no canonical entity for SAM.gov data at all.
  Explicitly excluded.
- **The `program_element_delta` readers** (`getDeltas`, `getNeedsAttention`,
  `action-recommendation.service.ts:176`, `product-metrics.service.ts:112`) —
  deferred, same reasoning as before: `defense_budget_canonical_delta`
  (generic hash-diff) and `program_element_delta` (domain-typed mark/conference/
  enactment taxonomy) are different shapes; migrating these four is a taxonomy
  decision, not a source swap. None are gated by `PE_SNAPSHOT_READ_MODE` today,
  so deferring is zero-risk.
- **`listReconciliationQueue`/`resolveReconciliation`/`approveReconciliation`** —
  still a plan-owner decision (branching admin moderation on read mode is
  backwards), not an implementation gap.

### Workstream N — the exact construction pattern for the remaining 6 verbs

For whoever builds `plan-defense-budget-promotion-v1`,
`validate-defense-budget-promotion-v1`, `authorize-defense-budget-promotion-v1`,
`execute-defense-budget-promotion-v1`, `compare-defense-budget-canonical-reads-v1`,
`rollback-defense-budget-snapshot-v1` — the pattern is proven and documented in
`apps/api/scripts/pe-budget-phase7-engine-rehearsal.ts`:

```ts
const repository = new PrismaPromotionExecutionRepositoryV1(
  promoterPrismaClient as unknown as PromotionPrismaLikeV1,
  projectionSource, // implements PromotionProjectionSourceV1
  async () => {
    /* returns a `pg` Client connected as the promoter, for advisory locks */
  },
);
const service = new DefenseBudgetCanonicalPromotionServiceV1(repository, auditSink, {
  now: () => new Date(),
});
const result = await service.execute({
  planId,
  authorizationId,
  expectedPlanHash,
  expectedActiveSnapshotId,
  executorIdentity,
  executionMode,
  environment,
});
// or: await service.rollback({ toSnapshotId, authorizationId, executorIdentity, environment, reason });
```

`execute`/`rollback` **reload** the plan/authorization/eligibility from
persistence via the promoter connection — they do not trust caller-supplied
proof objects. `plan-defense-budget-promotion-v1` needs
`promotion-planner-v1.ts`'s `buildPromotionPlanV1`; `authorize-...` needs
`promotion-authorization-service-v1.ts`; `validate-...`/`compare-...` are the
two genuinely-new read-only surfaces (no existing script does exactly this).
Each needs the same JSON-output + safety-header convention as
`status-defense-budget-promotion-v1.ts` (this session) and
`diag-program-element-trust-baseline.ts` (pre-existing) — `databaseHost()`/
`gitSha()` helpers, duplicated per-script rather than shared, matching this
codebase's existing convention for `apps/api/scripts/*.ts`.

---

## 4. Baselines

Measured this session, all local.

| Check                                                                                                            | Result                                                                                                                                                                                                                                                                                   |
| ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `jest src/program-element src/defense-budget src/config`                                                         | **3423 passed, 257 suites** (was 3397 / 253)                                                                                                                                                                                                                                             |
| `jest src/defense-budget/stages src/defense-budget/phase6 src/defense-budget/verification` (phase-6 jest subset) | **779 passed, 78 suites** — matches session-6 baseline exactly                                                                                                                                                                                                                           |
| `pnpm --filter @capiro/api exec tsc --noEmit -p .`                                                               | **6 errors**, unchanged documented baseline                                                                                                                                                                                                                                              |
| `prettier --check` on every file touched this session                                                            | clean (after one `--write` pass)                                                                                                                                                                                                                                                         |
| `verify:pe-budget-phase-7:db` (disposable rehearsal)                                                             | **101 shell + 24 engine + 39 drain + 32 read = 196 checks**, exit 0 (read section was 26, now 32)                                                                                                                                                                                        |
| `pnpm --filter @capiro/infra-cdk exec tsc --noEmit -p .`                                                         | clean                                                                                                                                                                                                                                                                                    |
| `cdk synth` — `Capiro-dev-Compute`, `Capiro-dev-Data`                                                            | both clean; promoter secret + task def confirmed present in synthesized template                                                                                                                                                                                                         |
| `verify:pe-budget-phase-6`'s negative-controls tsx script                                                        | **not run to completion** — timed out at 200s after 5/24 controls passed, unrelated to anything touched this session (zero files under `src/defense-budget/stages`, `phase6`, or `verification` changed). The jest portion of phase-6 (779/78, above) did complete and matches baseline. |
| `verify:pe-budget-phase-1` through `-5`, `verify:pe-budget-phase-6:full`/`:db`                                   | **not separately re-run** — their jest coverage is a subset of the `src/program-element src/defense-budget src/config` run above, which passed in full. Re-run explicitly before the next session's own handoff if a fresh signal is wanted.                                             |
| GitHub Actions                                                                                                   | still dead repo-wide (see [[project-capirov2-ci-blocked]]) — every claim above is local                                                                                                                                                                                                  |

---

## 5. Environment gotchas — carried forward, one new

All gotchas from sessions 2–6 still hold (NUL bytes in `promotion-planner-v1.ts`/
`canonical-promotion-service-v1.ts`, `ALTER DEFAULT PRIVILEGES` re-granting
`capiro_app` on every new table so enforcement must be a trigger, four Prisma
schemas all named `schema.prisma`, `pgvector/pgvector:pg16` for rehearsal,
`DATABASE_URL` needed even for `prisma validate`, Postgres NUMERIC scale
padding, `reconciliation_review_queue.id` being Prisma-side not DB-side).

**New this session: canonical rows are immutable the instant a snapshot leaves
STAGING — including for a rehearsal fixture you're adding, not just for a real
promotion.** The first version of this session's read-rehearsal extension
tried to `INSERT` three fixture rows into the already-`ACTIVE` rehearsal
snapshot from the TS script, and the append-only trigger refused it correctly
(`"snapshot ... is ACTIVE, not STAGING"`). The fix was to move the seeding into
`pe-budget-phase7-migration-rehearsal.sh`, in the same `STAGING` window as the
existing `insert_canonical_row` call, before the shell script's own baseline
activation. If you need a new fixture row in the read rehearsal, it goes in
the shell script's STAGING window, never in the TS script that runs after
everything is already activated.

**New this session, second item: `npx` can resolve to the wrong Node
install on Windows/Git Bash**, silently reporting `'tsx' is not recognized`
even though `apps/api/node_modules/.bin/tsx` exists and works fine when called
directly or via `pnpm exec`. Not a repo defect — prepend the workspace's
`node_modules/.bin` directories to `PATH` before invoking any script that
shells out via bare `npx`.

---

## 6. Open findings

### New this session — the two architecture gaps in §3

Both are P1-grade for the Phase 7 plan's own stated goals (J's "queryable
without field conflation," M's "product APIs can run fully from the active
snapshot"), not just blockers for this session's pass. Written up in full in
§3; don't re-derive, the research is already done.

### New this session — smaller findings

**L1 (unchanged from session 6, still open, now slightly better)** —
`resumeSideEffectDrain` had no operator surface; it has one now
(`resume-defense-budget-promotion-side-effects-v1`), but the underlying
`AmbiguousActivationError`/connection-error classification and lock-acquisition
timeout gaps flagged in the session-4/5/6 P2 cluster are unchanged.

**N1 (new)** — the shell dispatcher's `refuse_legacy_budget_commit` only
checks `PE_LEGACY_BUDGET_WRITES`, never `PE_SNAPSHOT_READ_MODE`, even though
the full policy function (`legacyBudgetCommitDecisionV1`) supports both. This
session's `derive-budget-actions.ts` fix intentionally matches the shell's
narrower behavior for consistency, rather than silently becoming the one verb
that's stricter than all eleven others. Extending the shell dispatcher (and
this fix) to also veto on an active snapshot/canary read is real, scoped
follow-on work — not done this session.

**N2 (new)** — `apiPromoterTaskDefinition` reuses the shared `apiTaskRole`,
the same one `apiBootstrapRolesTaskDefinition` and most other task defs in
`compute-stack.ts` already use — consistent with existing precedent in this
file, but not the fully dedicated, narrowly-scoped task role plan §N.7 calls
for. The database-level grant to `capiro_pe_promoter` is the actual
enforcement boundary today (proven by the engine rehearsal), same as the
existing bootstrap-roles task. A dedicated IAM role is real scope for later
in N, not done this session.

### From prior sessions — unchanged, still open

Everything in session-6 §6 (P1-2 mapping-registry-drift never emitted; P1-8
architecture gates being name-list regexes; P1-9/P1-10 missing adapter specs;
the P2 cluster on `canonical-promotion-service-v1.ts`; R2-R5 from the F–J
review). None of these block M or N; none were touched this session.

---

## 7. Boundaries

Unchanged from every prior session: Neo authorized merging to `main` (session 5) and explicitly held the deploy. That does **not** extend to applying Phase
7 migrations to any shared database, production baseline snapshot creation,
production canonical promotion, active-snapshot switch, production rollback,
enabling production read flags, or enabling client alert fan-out.

**Nothing was pushed, deployed, merged, committed, or applied to a shared
database this session.** Every database statement ran against a disposable
container destroyed on exit. `cdk synth` renders a template locally and made
no AWS API call requiring credentials — confirmed by exit 0 with no AWS
profile configured for a mutating call.

**New this session, worth flagging explicitly**: `PE_LEGACY_BUDGET_WRITES` on
`capiro-dev-watch-budget-docs` was deliberately left unset, after Neo
confirmed (mid-session) that no canonical snapshot has ever been activated in
`capiro-dev` or production. This means the next deploy of this branch stops
that scheduled budget-document ingestion job with no replacement — an
accepted, deliberate pause, not an oversight. If this changes before the next
deploy (e.g. someone runs a real promotion in `capiro-dev` first), revisit.

---

## 8. What "fully complete" cannot mean

Unchanged from every prior session, worth repeating because the temptation to
over-claim only grows as commits accumulate:

- **#31** production-scale rehearsal against _measured_ production SLOs — not
  attempted, no production SLOs exist to measure against yet.
- **#35** independent closeout from a fresh context that is **not** the
  primary implementer — this session did not attempt Workstream O, per its
  own explicit rule.
- **The canary acceptance matrix** — separate authorization, real tenant, not
  applicable until a real promotion exists anywhere.
- **"Two methods migrated" is not "Workstream M done."** 34 of 36 read
  methods across the two services are still on legacy, for reasons ranging
  from "not attempted" to "blocked by a repo-wide gap." The honest state is in
  §3, not a summary count.

---

## 9. Definition of done for the next session

Pick one of the two gaps in §3 and close it, or escalate it to whoever owns
Workstream J/N as a cross-workstream decision rather than attempting a third
consecutive session of discovering it's still blocked. If a gap closes,
`getProgramElement`/`getTimeline` (Gap 1) or `getContractors` (Gap 2) become
the next real migrations — both are Meri-reachable, satisfying the original
goal of covering the Meri tool surface.

If neither gap closes this session, the next honest unit of work is one of:
finishing the remaining 6 Workstream N CLI verbs using the pattern in §3
(`plan`/`validate` first — read-only, lowest risk); migrating
`BudgetLinesReadService`'s 9 methods (self-contained, proven pattern from
this session applies directly); or the `program_element_delta` taxonomy
decision (§3) that's been deferred three sessions running.

Typecheck against the documented 6-error baseline, formatting applied, and
re-run `verify:pe-budget-phase-1` through `-6` (not just their jest subset —
the full named scripts, this session only spot-checked phase-6's jest portion)
before the next handoff.

Report exact commands, exit codes, and test counts. A workstream is done when
it is demonstrated, not when the files exist.
