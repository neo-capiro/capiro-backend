# Phase 7 — Hand-over notes (session 8)

## Read this first

Three findings this session change what the next session should do. All three
contradict guidance in earlier handoffs, so **prefer this document where they
disagree**, and re-check anything that reasoned from the older claims.

1. **The Phase 6 → canonical promotion chain has no production producer, at any
   link.** This is the real blocker behind "Gap 1", and it trips Phase 7's own
   stop condition 1. §3.
2. **Session 7's "unexplained" working-tree edit was our own negative-control
   runner**, left behind when a killed run skipped its `finally`. The hazard is
   systemic across four scripts. §2.
3. **`BudgetLinesReadService` is not the easy next target.** Earlier handoffs
   recommended it as unblocked work; none of its nine methods migrates cleanly.
   §4.

---

## 1. Repository state

| Item               | Value                                                                  |
| ------------------ | ---------------------------------------------------------------------- |
| `main`             | `46e029dad` — merge of PR #820 (WS L–N)                                |
| Branch             | `agent/pe-budget-canonical-promotion-cutover-v1` @ `4abd776f4`, pushed |
| Unmerged on branch | **2 commits** — the Gap 1 re-diagnosis and the crash-safety fix        |
| Merged PRs         | #784 (A–K), #820 (L–N)                                                 |
| Deployed           | **nothing**                                                            |

**PR #820 was merged at Neo's explicit direction.** The Phase 7 plan says to
keep one draft PR and not merge it; that was overridden deliberately, as #784
was before it. It does not mean Phase 7 closed out — see §5.

Workstream status: **A–K** merged long ago. **L** complete. **M partial** — 1 of
36 read methods migrated, unchanged since session 7. **N at 7 of 8 verbs.**
**O barely started** (see §6 for what exists).

Two environment facts that cost time:

- `git checkout main` fails in this worktree — `main` is checked out at
  `C:\Users\neoma\capiro-clio-ux`. Work on the agent branch.
- `git push` fails: the credential helper wants a TTY. `gh` is authenticated, so
  use `git -c credential.helper='!gh auth git-credential' push …`.
  `gh auth setup-git` alone does **not** fix it.

---

## 2. The session-7 anomaly: solved, and it was a systemic tooling hazard

Session 7 found an unexplained one-line change in `line-reference-resolver.ts`,
could not attribute it, and left it in the tree.

**It was a real defect.** It replaced the accountless-procurement guard's
fail-closed `return []` with a code-only match, dropping the `account`,
`advanceProcurement`, and `component` filters. At `line-reference-resolver.ts:102`
a single context match becomes `acceptedBinding(…, 'code_plus_unique_context', 1)`,
so a reference carrying no account namespace binds **at confidence 1.0** across
account and base/advance-procurement boundaries — negative control 14, and a
direct contradiction of the doc comment three lines above it.

Nothing caught it: the suite passed 23/23. The existing bare-short-code test only
rejects because three fixtures collide on code `12`. The single-entry case — one
line in the index sharing the code, i.e. a realistic single-account manifest —
was untested. Now covered at `line-reference-resolver.spec.ts:143`, demonstrated
as a negative control (injected → failed on exactly the intended assertion, and
bound a _base_ reference to an _advance-procurement_ line → reverted → 24/24).

### Where it came from

It is **NC06 of `verify-pe-budget-phase6-negative-controls.ts`**, byte-for-byte
identical to that control's injection string.

That runner writes defects into real production source, runs a focused test that
must fail, and restores in `finally`. `finally` does not run when the process is
killed. Session 7's own handoff records that script as _"not run to completion —
timed out at 200s after 5/24 controls passed"_. NC06 is the sixth control: the
one in flight when the run died. Its mutation stayed on disk and the only copy of
the original bytes was an in-memory `Buffer` that died with the process.

That accounts for every observation — the later mtime, a defect too well-formed
to be accidental (it _is_ a designed defect), the `prettier --check` failure (the
injection string is written verbatim), and why no ordinary test caught it (NC06's
detector lives in the runner's own focused spec, which never ran).

**An earlier revision of this handoff said provenance was never established and
suggested auditing write access to `C:\capiro-build`. That was wrong.** Nothing
external touched the machine. If a stray edit ever appears here again, check the
negative-control runners before anything else.

### The hazard, and what was done about it

All four `verify-pe-budget-phase-*-negative-controls` runners mutate production
source and restore only in `finally` from an in-memory buffer. Any interruption
leaves an injected defect with no record. This one came within one `git add` of
being committed to a financial-truth pipeline.

`scripts/lib/source-mutation-journal.ts` fixes it: originals are written to disk
_before_ the first mutation and removed only after a restore is verified
byte-for-byte, so a killed run leaves a recoverable journal and the next run
restores it loudly instead of building on a mutated tree. Journal directories are
gitignored but live inside the package, so an abandoned one is visible to
`git status` too.

**Wired into phases 5 and 6. Phases 3 and 4 still carry the unfixed pattern** —
they have multi-site mutations and were left rather than refactored blind. That
is the smallest genuinely useful task left; see §7.

---

## 3. The real blocker: Phase 6 promotion has no producer

Session 7 framed Gap 1 as "nothing resolves `peCode → nativeIdentityHash`", with
the fix being to ship that resolver. Session 8 went looking for it on the theory
that it might be trivial — and it is:
`nativeIdentityKeyV1({ lineKind: 'RDTE_PE', peCode })` returns
`` `RDTE_PE:${peCode}` ``, a pure function of the peCode needing no semantic
decision at all.

That was never the hard part. Checked across `src` and `scripts`, excluding
`.spec.ts`:

| Link in the Phase 6 → canonical chain                            | Producer in production code        |
| ---------------------------------------------------------------- | ---------------------------------- |
| Constructs a `Phase6NativeProjectionV1`                          | **none** — spec fixtures only      |
| Computes `nativeIdentityHash` (required, sha256)                 | **none, anywhere**                 |
| Calls `Phase6AuditProjectionRepository`                          | **none** — the class has no caller |
| Opens the `phase6-projection` Prisma client                      | **none at all**                    |
| Calls `projectPhase6ProjectionsV1` (Phase 7's Phase 6 projector) | **none**                           |

The `phase6-projection` database has a schema, migrations, and a generated
client that no code path ever opens.

So the read-side join is downstream of the blocker. **There is nothing to join
to, and there still would be nothing if the resolver shipped tomorrow** — it
would point at storage nothing can populate.

### Why this is a stop condition, not a to-do

Phase 7's mandatory prerequisite 7 requires Phase 6 "merged and green"
_including_ "verified stage/action/provision projections". Phase 6's suite is
genuinely green — 780 tests and 24/24 negative controls, re-confirmed twice this
session. But green tests over contracts and projectors with no production wiring
is a different claim from a working pipeline, and the prerequisite was accepted
on the former.

Phase 7's stop conditions open with _"any prerequisite phase is incomplete"_.
**A Phase 6 owner has to say which was intended** — persistence deliberately
deferred to a later workstream, or a producer expected and never built. Until
then, every congressional-mark and typed-action surface is unbuildable, and
building more read surfaces on top is building on sand.

---

## 4. Correction: `BudgetLinesReadService` is not unblocked

Earlier handoffs recommend migrating its nine methods next, "pattern applies
directly". Mapping each method to its tables and each table to its canonical
entity: **none migrates cleanly.**

- **Three** (`getActions`, `getMovement`, `getWatchSignals`) read `budget_action`
  → `canonical_stage_action`, whose natural key leads with `nativeIdentityHash`.
  Blocked by §3. This also means Gap 1 covers **6 methods across two services**,
  typed actions as well as congressional marks.
- **Six** read `program_element_intelligence_cache`, `federal_award`, or
  `capability*` — **none of which has a canonical entity at all.** They are
  derived product data and external award data, not budget truth.

Reachable by `peCode` without the hash: `canonical_rdte_program_element`
(`['peCode']`), `canonical_rdte_performer` (peCode-led), and
`canonical_budget_line_relationship` (`from`/`toNaturalKey`, which for an RDT&E
line _is_ the peCode).

**But that raises a plan-owner question first:** `getRelationships`, `getGraph`,
and `getIncumbents` would each serve one response built half from the active
snapshot and half from tables that are not snapshot-scoped. Invariant 22 forbids
mixing two _snapshots_; it is silent on mixing snapshot data with derived caches
and external award data. Get that answered before writing code.

---

## 5. What shipped this session

**Workstream N: 2 of 8 verbs → 7 of 8**, all wired into `entrypoint.sh`.

| Verb                                      | Mode          | Note                                               |
| ----------------------------------------- | ------------- | -------------------------------------------------- |
| `plan-…-v1`                               | read-only     | deterministic plan/snapshot ids derived from scope |
| `validate-…-v1`                           | read-only     | blocking vs advisory checks; exit 3 on invalid     |
| `compare-…-canonical-reads-v1`            | read-only     | one Nest boot per read mode                        |
| `execute-…-v1`                            | promoter role | dry run unless `--commit --confirm <env>`          |
| `rollback-defense-budget-snapshot-v1`     | promoter role | same gating; deletes nothing                       |
| `status-…-v1`, `resume-…-side-effects-v1` | —             | session 7                                          |

Three decisions worth keeping:

- **`execute`/`rollback` read `PROMOTER_DATABASE_URL` and never fall back to
  `DATABASE_URL`.** A missing promoter URL is a usage error, not licence to grab
  whatever else is in the environment. `entrypoint.sh` deliberately does not call
  `compose_database_url` for those two.
- **`--commit` requires `--confirm <environment>`** echoed exactly. A plan id
  pasted against the wrong environment is the realistic operator error.
- **`compare` spawns itself once per read mode.** `PeSnapshotGateService` binds
  the mode from `ConfigService` at Nest boot; calling the private
  legacy/snapshot methods directly would compare something other than what the
  service serves, which is the one thing the command exists to measure.

**A production projection source.** `promotion-projection-source-prisma-v1.ts`
did not exist — the only `PromotionProjectionSourceV1` was declared inline in the
engine rehearsal with hardcoded lineage (`artifact-1`, `doc-1`, `ev-1`). A plan
built from it would bind every canonical row to provenance that does not exist.
The new source reads real lineage columns, derives an identity row's provenance
from its own first funding row in deterministic order, and **reports a family it
cannot read** rather than contributing a silent zero. Only `om` has a reader;
`plan --families rdte` exits 3 naming the family.

**Gates that did not exist.** `tsconfig.json` excludes `scripts/`, and no focused
config covered the Phase 7 CLIs — **none of them were typechecked by anything**.
`tsconfig.phase7.json` fixed that and immediately surfaced 12 errors (2 real:
`import.meta` is a compile error under this CommonJS target — use
`process.argv[1]`). Also added `verify:pe-budget-phase-7`, the plan's Workstream
O item 1; only the `:db` variant existed.

---

## 6. Baselines

All local. Every phase run as its **full named script**, which the previous two
sessions did not do.

| Check                                                        | Result                                                                                                             |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `verify:pe-budget-phase-1` … `-5`                            | **PASS** — 859 / 840 / 216 / 305 / 358 tests                                                                       |
| `verify:pe-budget-phase-6`                                   | **PASS** — 780 tests, 78 suites, **24/24 negative controls**, 575s                                                 |
| `verify:pe-budget-phase-7` (new)                             | **PASS** — 612 tests, 26 suites                                                                                    |
| `verify:pe-budget-phase-7:db`                                | **PASS, exit 0** — **229 checks** (102 shell + 24 engine + 39 drain + 32 read + **32 new plan/validate**), was 196 |
| `source-mutation-journal.spec.ts` (new)                      | 5/5                                                                                                                |
| `tsc -p tsconfig.phase7.json` (new)                          | 0 errors                                                                                                           |
| `tsc -p tsconfig.phase6.json`                                | 0 errors                                                                                                           |
| `tsc --noEmit -p .`                                          | **6 errors** — unchanged documented baseline                                                                       |
| `jest src/program-element src/defense-budget src/config`     | **3435 passed, 258 suites** (was 3423 / 257)                                                                       |
| `prettier --check` on every touched file, `git diff --check` | clean                                                                                                              |

**Phase 6 completed for the first time.** Session 7 reported its negative-control
script timing out at 5/24; run without a competing rehearsal it finishes and all
24 pass. The earlier timeout was contention — and it is what left NC06's defect
behind (§2).

**Phase 6 needs `DATABASE_URL` set and there is no `apps/api/.env`.**
`prisma validate` refuses the phase-6 projection schema without it (`P1012`),
failing the script at 13s before any test runs. A placeholder is sufficient —
`validate` never connects. This is almost certainly why it kept being skipped: it
looks like a code failure and is an environment gap.

### What the new rehearsal section proves

The 32 new checks spawn the **real CLIs** as the `capiro_app` serve role, so a
missing SELECT grant fails there rather than in production. They pin plan-hash
determinism across two runs of an unchanged scope, a stable derived snapshot id,
an unreadable family exiting 3 _and being named_, and validate refusing both an
unknown plan id and a drifted expectation with the failure attributed to the
pointer check specifically.

Three of those checks exist because writing them failed first: sharing FY2027
with the engine rehearsal made the plan legitimately cover 4 items; splicing the
args array by index silently dropped `--eligibility-hash`; and staging drift by
`UPDATE` was **refused by the append-only trigger** — Workstream D working as
intended, now itself a check.

---

## 7. Next steps, in order

1. **Escalate §3 to a Phase 6 owner.** Nothing else in M unblocks until someone
   says whether Phase 6 projections are meant to be produced at all. All three
   gaps are written up in
   [`docs/defense-budget/PHASE-7-ARCHITECTURE-GAPS.md`](../defense-budget/PHASE-7-ARCHITECTURE-GAPS.md)
   — **not filed anywhere outside this repo.**
2. **Finish the crash-safety fix** — phases 3 and 4 (§2). Small, contained,
   unblocked, and it closes a hazard that has already bitten once.
3. **Close Gap 3** (no eligibility persistence) to unblock the 8th verb and any
   real operator promotion path. Needs a migration + repository; A/D territory.
4. **Workstream O for the parts that do not depend on Phase 6**: the 32 negative
   controls (most target promotion mechanics that work today and are covered by
   229 rehearsal checks) and the four runbooks.
5. Answer the plan-owner question in §4 before touching `BudgetLinesReadService`.

### What cannot be finished by an implementer

Recorded so nobody plans around it: production-scale rehearsal needs _measured_
production SLOs (the plan forbids inventing thresholds); the canary acceptance
matrix needs an operator and separate authorization; and Workstream O's closeout
is specified to run in a fresh independent context, not the implementer's. Phase
7 "complete" cannot be read off a green test run.

---

## 8. Safety confirmation

| Action                 | Occurred                                                           |
| ---------------------- | ------------------------------------------------------------------ |
| commit                 | **yes** — 6 commits this session                                   |
| push                   | **yes**                                                            |
| PR created/updated     | **yes** — #820 opened, then marked ready                           |
| merge                  | **yes** — #820 → `main` (`46e029dad`), at Neo's explicit direction |
| deployment             | no                                                                 |
| AWS change             | no                                                                 |
| shared migration       | no                                                                 |
| production backup      | no                                                                 |
| production promotion   | no                                                                 |
| active-snapshot switch | no — disposable containers only                                    |
| rollback               | no                                                                 |
| paid parser call       | no                                                                 |
| production-data access | no                                                                 |
| alert fan-out          | no                                                                 |

`main` carries unapplied Phase 7 migrations and `deploy-dev.sh` always runs
`prisma migrate deploy` before rolling the API, so the next deploy of `main`
applies all of them at once. `PE_LEGACY_BUDGET_WRITES` remains unset, so
`capiro-dev-watch-budget-docs` will exit 64 on that deploy — unchanged from
session 7 and still accepted.
