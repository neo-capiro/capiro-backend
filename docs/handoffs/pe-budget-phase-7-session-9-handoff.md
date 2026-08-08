# PE budget — Phase 7 session 9 handoff

**Goal for the session:** close out Phase 7, and — after an explicit
mid-session directive from Neo — close every architecture gap that could
responsibly be closed.
**Outcome:** Workstream O is built and green. Gaps 2, 3, and 4 are closed. Gap
1 is substantially narrowed (closed for a real, named subset). Gap 4 was
found mid-session, then closed in the same session once the goal was
explicitly widened to "make sure Phase 7 finishes." All nine promotion verbs
now exist, are wired into `entrypoint.sh`, and chain into one real operator
sequence, proven against a real disposable Postgres. Every data family's
ingestion pipeline (RDT&E, non-RDT&E procurement/OM/MILCON, and committee/
Phase 6) was also run end to end against a real disposable Postgres this
session — see "Ingestion evidence" below — which surfaced and fixed two more
pre-existing, unrelated migration-rehearsal bugs. Phase 7 as a whole is
**still not closeable to production** — the reasons that remain are
genuinely not code (measured SLOs, a canary needing a human operator), not
things left undone for lack of trying.

Read [PHASE-7-ARCHITECTURE-GAPS.md](../defense-budget/PHASE-7-ARCHITECTURE-GAPS.md)
alongside this — it now carries session-9 updates inline under each gap,
including the full detail on what Gap 1 covers and does not.

---

## State

|                    |                                                         |
| ------------------ | ------------------------------------------------------- |
| `origin/main`      | `aff4e5a23`                                             |
| Branch             | `agent/pe-budget-canonical-promotion-cutover-v1`        |
| Deployed           | nothing                                                 |
| Migrations applied | none, anywhere, outside disposable rehearsal containers |
| Workstreams        | A–N merged (PR #820). **O built this session.**         |
| New migration      | `20260903010000_pe_budget_phase7_promotion_eligibility` |

A correction carried forward from session 8: compare branch state against
`origin/main`, not the local `main` ref in this worktree — it is stale and
sits behind the branch as an ancestor, so `git log main..HEAD` overstates the
unmerged set.

## Environment traps, all still live, one new

1. `git checkout main` fails here — `main` is checked out at `capiro-clio-ux`.
2. `git push` needs `git -c credential.helper='!gh auth git-credential' push`.
3. `verify:pe-budget-phase-7` and `prisma validate`/`generate` need a
   generated Prisma client and (for `phase6-projection`) a `DATABASE_URL` —
   even a placeholder — or they fail looking like a code defect. Both
   `verify:pe-budget-phase-7` and `verify:pe-budget-phase-6` now handle this
   themselves (the former runs `prisma generate` first; the latter still
   needs `DATABASE_URL=postgresql://placeholder:placeholder@localhost:5432/placeholder`
   set by the caller).

---

## What was built

### Workstream O — permanent gates, 32 negative controls, documentation

Everything from the plan's own list:

- `phase7-closeout-gates-v1.ts` + `verify-pe-budget-phase-7-safety.ts` — 8
  scoped architecture rules (promotion/parser_verifier/legacy_loader/serve_read
  scopes, since Phase 7's rules are directional in a way Phase 6's were not:
  the parser may call a paid parser, promotion may not).
- `verify-pe-budget-phase-7-negative-controls.ts` — all 32 controls, each a
  real defect injection with a named detector. Two needed a second pass: the
  first attempt targeted the wrong guard (a redemption-time function instead
  of the schema's own construction-time `superRefine`) for
  `authorizer_equals_reviewer` and `cycle_certification_missing` — the chosen
  detector test called `.parse()` directly, so the injection had to land in
  the schema, not the sibling evaluate function. Both fixed; 32/32 pass.
- All five closeout documents (were all missing): `CANONICAL-PROMOTION-V1.md`,
  three runbooks, and the Phase 8 Fargate handoff.
- Crash safety ported to phases 3 and 4 (already done for 5/6): both
  negative-control runners now use `SourceMutationJournal`, verified
  byte-for-byte, with phase 4 additionally sweeping stray probe files a killed
  run leaves behind.

### Gap 1 — the Phase 6 producer chain (partially closed)

Built the actual missing link: `phase6-projection-builder-v1.ts`
(`nativeIdentityHashV1`, `buildStagePositionProjectionV1`,
`buildStageActionProjectionV1`), a Prisma persistence adapter for
`Phase6AuditProjectionRepository`, a `persist-phase6-audit-projections-v1`
command, and a `committee` family added to `PrismaPromotionProjectionSourceV1`
reading persisted rows back through `projectPhase6ProjectionsV1`. **Proven
against a real disposable Postgres**, not just unit tests with fakes:
`phase6-producer-rehearsal.sh`, 16/16 checks — build → certify → persist →
read back → project, exact money surviving the NUMERIC round trip.

**Scope, stated precisely because "closed" would overclaim:** covers
`stage_position` for HASC/SASC/HAC-D/SAC-D/NDAA conference/appropriations
conference, and `stage_action` for identity-scoped actions. Does **not** cover
enacted (`public_law`/`continuing_resolution`), reprogramming, execution, or
package/account-scoped and transfer-pair actions — each of those needs a real
design decision (enactment-proof linkage, an execution-metric convention, a
package-scope pseudo-identity) that would have been guessed at under time
pressure otherwise. Full reasoning per stage is in the gaps doc.

### Gap 2 — `isNamedCompany` (closed)

Extracted the existing heuristic from `sync-jbook-performers.ts` into a shared
`r3-named-company-classifier.ts` (10 unit tests), wired into the real R-3
extractor, threaded through the assertion's `metadata` bag (no Phase 1 schema
change needed — same pattern `roleExplicit` already used), and read by the
projection planner into `values.isNamedCompany` — `null` when unclassified,
never a guessed boolean. Full `verify:pe-budget-phase-4`: 317/317.

### Gap 3 — promotion eligibility persistence and `authorize` (closed)

Migration `20260903010000_pe_budget_phase7_promotion_eligibility`:
`defense_budget_promotion_eligibility` (append-only), plus the foreign key
from `defense_budget_promotion_plan.eligibility_hash` to it — the literal
acceptance criterion the gaps doc named. Two new Prisma repositories
(eligibility persistence; the plan/authorization join) and the
`authorize-defense-budget-promotion-v1` CLI, wired into `entrypoint.sh` under
the serve-role group.

**This closes the last of the plan's eight promotion verbs.**

Deliberately **not** done, both out of Gap 3's own scope: the fact-computing
read repository (`PromotionEligibilityRepositoryV1`, which would derive a
fresh eligibility evaluation from live Phase 2/4/5/6 data) still has no Prisma
implementation — an eligibility record must still be assembled and handed to
the persistence repository directly; and `plan`'s `--eligibility-hash` flag
was not changed into a lookup, because of Gap 4 below.

#### Three real bugs found closing this gap, worth knowing about

None of these were caught by unit tests — all three only surfaced against a
real disposable Postgres, which is exactly why the rehearsal step is not
optional:

1. **A hash collision between two pre-existing rehearsal scripts.**
   `pe-budget-phase7-engine-rehearsal.ts` and `pe-budget-phase7-plan-rehearsal.ts`
   both independently picked `'e'.repeat(64)` as a placeholder hash, and both
   run against the _same_ shared disposable database within one rehearsal
   invocation. Once eligibility became a real content-addressed table with a
   unique constraint, the second script's insert collided with the first's.
   Fixed with `ON CONFLICT (eligibility_hash) DO NOTHING` in both, and in the
   bash rehearsal's own fixture insert for the same defensive reason.
2. **Missing `::uuid`/`::timestamptz` casts in the new repository's raw SQL.**
   `$executeRawUnsafe` sends untyped parameters as text by default; Postgres
   refuses an implicit text→uuid or text→timestamptz cast in that position
   (a literal string embedded directly in the query text would have been
   auto-cast, which is why the _existing_ rehearsal scripts' string-interpolated
   UUIDs never hit this). Fixed in both `insert()` and `insertAuthorization()`.
3. **A stdout-format inconsistency.** Every other Phase 7 CLI prints exactly
   one JSON document (the safety-statement header merged into the same object
   as the result). The first draft of `authorize` printed two separate
   `console.log` calls instead, which broke because the _result_ object is
   pretty-printed across multiple lines — a rehearsal script assuming
   "one JSON blob per line" grabbed only the closing `}`. Fixed by merging the
   header into the result object, matching the established convention.

### Gap 4 — nothing files a promotion plan into the database (closed)

Found while building the Gap 3 rehearsal, from `plan-defense-budget-promotion-v1.ts`'s
own header comment: _"the plan is filed by a separate authorized step, not by
this command."_ That step did not exist. `validate`, `execute`, and
`authorize` all read `defense_budget_promotion_plan` expecting a row to
already be there; every rehearsal that exercises them seeded the row directly
with raw SQL instead.

Closed as a ninth verb, `file-defense-budget-promotion-plan-v1.ts`, rather
than a flag on `plan` — keeps `plan` itself read-only, which is its own
header's claim and is now actually true. Takes the plan document `plan`
already prints, recomputes `promotionPlanHashV1` over it, and inserts one row
(dry run by default, `--commit` to write). Refuses a `plan_id` already filed
under a different hash; accepts a byte-identical refile as a replay, matching
every other content-addressed table in this schema. Runs under the serve
role. Wired into `entrypoint.sh` and `tsconfig.phase7.json`.

**One more bug only a real database could have caught:** `promotionPlanHashV1`'s
parameter type is `Omit<DefenseBudgetPromotionPlanV1, 'planHash'>`, but `Omit`
is erased at runtime — the loaded plan document still carries the `planHash`
field the original hash was computed *without*, so recomputing directly on it
hashed a different object every time and refused every plan as tampered.
Fixed by destructuring `planHash` out before recomputing. Same shape as Gap
3's missing `::uuid`/`::timestamptz` casts, one layer up: a type-level
guarantee (`Omit`) that TypeScript does not actually enforce at runtime.

**Proven against a real disposable Postgres**: replaced the raw-SQL
plan-filing step in `pe-budget-phase7-plan-rehearsal.ts` with a real spawn of
this CLI. The operator sequence is now, in full, real commands:

```text
plan-defense-budget-promotion-v1
  -> file-defense-budget-promotion-plan-v1 --commit
  -> validate-defense-budget-promotion-v1
  -> authorize-defense-budget-promotion-v1
  -> execute-defense-budget-promotion-v1
```

---

## Ingestion evidence — all three data families, real disposable Postgres

The controlling directive for the second half of this session was explicit:
"make sure all data is being ingested," not just "Phase 7's own tables behave
correctly." Every family's existing migration-rehearsal script was run
against a fresh disposable Postgres container this session:

| Family                                    | Script                                     | Result                        |
| ------------------------------------------ | ------------------------------------------- | ------------------------------ |
| RDT&E (Phase 4)                            | `rdte-phase-4-migration-rehearsal.sh`       | PASSED                        |
| Non-RDT&E: procurement/O&M/MILCON (Phase 5)| `non-rdte-phase5-migration-rehearsal.sh`    | PASSED                        |
| Committee/congressional (Phase 6 producer) | `phase6-producer-rehearsal.sh`              | PASS (16/16)                  |
| Committee/congressional (Phase 6 projection)| `phase6-projection-rehearsal.sh`           | PASS                          |
| Canonical promotion (Phase 7)              | `pe-budget-phase7-migration-rehearsal.sh`   | PASSED (103/103)              |

**The first two failed on the first attempt**, and the fix is worth recording
because it is not a Phase 4 or Phase 5 bug: both scripts predate Phase 7.
Their "pre-PhaseN upgrade" path (Path B) replays every migration in the repo
*except that phase's own*, to simulate upgrading a database that predates it.
That was correct when each was written — nothing existed chronologically
after Phase 4 or Phase 5 yet. Phase 7's canonical-promotion migration, added
by a later session, FKs into tables Phase 4 and Phase 5 create
(`program_element_project_budget_position`, `procurement_budget_line`
respectively), so replaying it as part of a "pre-Phase-4"/"pre-Phase-5"
baseline now fails on a missing relation — the exact same class of staleness
this session's own gaps doc describes, just in test infrastructure instead of
production code. Fixed by excluding Phase 7's four migrations from both
scripts' baseline-copy loops, the same way `pe-budget-phase7-migration-rehearsal.sh`
already excludes its own later add-ons from its own baseline. Both scripts
pass cleanly now.

**What this does and does not prove:** every family's schema, constraints,
and (for Phase 6/7) the actual production write paths are exercised against
a real Postgres with the repo's existing golden/synthetic fixtures — not
mocked Prisma clients, which this session repeatedly demonstrated cannot
catch real SQL type-cast bugs or constraint violations. It does **not** mean
real production DoD budget-justification PDFs are currently being ingested
anywhere — no such document was fetched or parsed this session, and every
phase plan's own non-goals explicitly exclude automatic document discovery.
"All data is being ingested" here means: the ingestion pipeline for every
family is real, wired, and proven end to end against real fixture data in a
real database, ready to run against a real document the moment an operator
supplies one — not that one is running against production right now.

---

## Verification run this session

- `verify:pe-budget-phase-4`: 317/317 tests, safety gate `ok: true`.
- `verify:pe-budget-phase-6`: 780+ tests, 24/24 negative controls, safety gate
  `status: PASS`.
- `verify:pe-budget-phase-7` (the full composite script — typecheck, jest
  across `promotion`/`snapshot`, all 32 negative controls, the safety gate):
  **exit 0.**
- `phase6-producer-rehearsal.sh` (new, disposable Postgres): 16/16 checks.
- `pe-budget-phase7-migration-rehearsal.sh` (disposable Postgres, the full
  suite including the fresh/upgrade migration paths, all pre-existing
  sub-rehearsals, the Gap 3 section, and — after Gap 4 closed — the plan
  sub-rehearsal now filing through the real ninth verb instead of raw SQL):
  **exit 0, "REHEARSAL PASSED — 103 checks."** The engine/drain/read/plan/gap3
  sub-rehearsals individually reported 24/39/32/34/13 checks (plan's count
  rose from 32 to 34 with the two added file-verb assertions); the outer
  script's own section-level counter (which increments once per sub-rehearsal
  rather than re-counting their internal checks — an existing convention, not
  new this session) reads 103.
- `rdte-phase-4-migration-rehearsal.sh` (disposable Postgres, after fixing its
  stale Phase-7-migration exclusion): **exit 0, "REHEARSAL PASSED."**
- `non-rdte-phase5-migration-rehearsal.sh` (disposable Postgres, same fix):
  **exit 0, "REHEARSAL PASSED."**
- `phase6-projection-rehearsal.sh` (disposable Postgres): **PASS** — all
  migrations + replay + upgrade + terminal constraints + immutable audit
  lineage + rollback + idempotency.
- `git status` after every rehearsal run: clean — no leftover `.p7-rehearsal-migrations`,
  `.p4-rehearsal-migrations`, `.p5-rehearsal-migrations`, `.p6-nc-restore`, or
  `.p7-nc-restore` directories.

Nothing committed, pushed, deployed, applied to a shared database, or
promoted anywhere real.

---

## Why Phase 7 still cannot be called complete

Three things remain, and none of them is "ran out of time to write code":

1. **Gap 1's uncovered stages** (enacted/reprogramming/execution, package-scoped
   actions) each need a specific design decision documented in the gaps file.
2. **`PromotionEligibilityRepositoryV1` has no Prisma implementation.** An
   eligibility record must still be assembled by an operator or a script and
   handed to the persistence repository directly — nothing yet derives one
   from live Phase 2/4/5/6 data.
3. **Production-scale rehearsal has no thresholds.** The plan forbids
   inventing them; they must come from measured production SLOs, which do not
   exist.
4. **Canary acceptance needs a separate authorization and a human operator.**
   Code being complete is explicitly not a reason to run it.

None of these four is "no way to file a plan" anymore — Gap 4 is closed, and
all nine verbs now chain into one real, rehearsed operator sequence.

## Next steps, in order

1. **Build the `PromotionEligibilityRepositoryV1` Prisma implementation** (the
   fact-computing read side Gap 3 deliberately left out) so eligibility can be
   derived from live data instead of hand-assembled.
2. **Pick up Gap 1's remaining stages** — enacted first, since it's the one
   with the clearest existing dependency (`EnactmentProofV1`) to design against.
3. **Measure production SLOs** so the production-scale rehearsal can have real
   thresholds, then consider a canary — with its own separate authorization.
4. **Get a real source document through the pipeline once**, end to end, as
   the first thing after a canary is authorized — everything proven this
   session used golden/synthetic fixtures, deliberately, since no phase plan's
   scope includes fetching one.

---

## The honest status

Phase 7's promotion engine is well-proven and its cutover has never run
anywhere real — that was true at the start of this session and remains true.
What changed: all four architecture gaps blocking read-side migration, the
`authorize` verb, and the plan-filing step are now closed (three fully, one —
Gap 1 — for a real, named, documented subset), each proven against a real
disposable Postgres rather than asserted from unit tests alone. Every family's
ingestion pipeline (RDT&E, non-RDT&E, committee/Phase 6) was independently
run against a real disposable Postgres this session and passes, including two
pre-existing migration-rehearsal bugs in the Phase 4 and Phase 5 scripts that
this run surfaced and fixed. Every bug found this session (five, all told —
two rehearsal-script staleness bugs, a hash collision, missing SQL casts, and
an erased-`Omit` type mismatch) is fixed and the fix is proven, not just
applied. All nine promotion verbs exist, are wired, and chain into one real
operator sequence.

**Phase 7 completion still cannot be read off a green test run, and still
cannot be called finished in the sense of "safe to run against production
today."** What "all data is being ingested" means, precisely: every family's
pipeline is real code, wired end to end, and proven against real fixture data
in a real database — not that a real document is flowing through it right
now, which no phase plan's scope ever asked for. What remains before Phase 7
could responsibly touch production is unchanged in kind from before this
session — a fact-computing eligibility repository, Gap 1's remaining
stages, measured SLOs, and a human-authorized canary — but the list is
shorter, and everything on it now requires a decision or a measurement, not
a missing verb.
