# PE budget — Phase 7 session 12 handoff

**Goal for the session:** work the "needs no human first" rows of session 11's
what's-left table.

**Outcome:** the SLO row is done — six of the seven metrics session 11 left
specified-only are now wired to real emission call sites, taking the programme
from 2-of-9 to **8 of 9**. The seventh is not an oversight and not an effort
problem; it is blocked on something that does not exist in this repository, and
that is now written down as a decision rather than a TODO. **The persist-verb
chaining row is also done, deliberately short of automation** (see below).
**`composeEnactedStageV1` was not started** — it turned out to require a real
extractor for a document type (enacted public-law/appropriations-bill text)
nothing in this repository parses today, not an engineering task that fits in
the remainder of this session. Nothing was deployed; no AWS mutation, no
shared-database migration, no live canary.

The status line is unchanged, and still per Neo's own instruction:

```text
IMPLEMENTATION COMPLETE
LIVE ACCEPTANCE NOT RUN — AUTHORIZATION REQUIRED
```

Read [PHASE-7-ARCHITECTURE-GAPS.md](../defense-budget/PHASE-7-ARCHITECTURE-GAPS.md)
alongside this. It carries all of Neo's decisions **verbatim** and is the
authority; this handoff summarizes.

---

## State

|                    |                                                          |
| ------------------ | -------------------------------------------------------- |
| `origin/main`      | `d1d7030c` (PR #856) — **moved 22 commits** past the base of this branch since session 11, which recorded `1f97650d` |
| Branch             | `agent/pe-budget-phase7-eligibility-read-repo` (PR #848)  |
| PR #848            | OPEN · MERGEABLE · CLEAN · **not merged**                 |
| Deployed           | nothing                                                   |
| Migrations applied | none outside disposable rehearsal containers              |
| Gaps 1–5           | all closed (unchanged)                                    |

**The `main` delta is the thing a fresh session should look at first.** GitHub
reports the merge as clean, but that is textual only: every gate below was run
against a tree based on `1f97650d`, and nothing has exercised this branch
against current `main`. There is also no CI signal to fall back on — the
repo-wide `startup_failure` condition is still going, so `gh pr checks 848`
reports no checks at all. "MERGEABLE / CLEAN" here means "git found no
conflicts", not "anything passed".

## What shipped

### SLO wiring — 2 of 9 → 8 of 9

| Metric | Emission call site |
| --- | --- |
| `snapshot_staging_duration_ms` | `canonical-promotion-service-v1.ts`, the whole chunked staging phase — not per chunk, so a run that stages in many small chunks cannot look faster than one that stages in few |
| `snapshot_activation_duration_ms` | same module, around the activation attempt **including its ledger-recovery path**: an ambiguous commit resolved by reading still cost the caller that wall-clock |
| `rollback_duration_ms` | same module, around `rollback()` from the caller's entry so the lock wait is **inside** the number — time queued behind another promoter is time the environment was still on the bad snapshot |
| `snapshot_read_latency_ms` | `PeSnapshotGateService.loadRows`, which every canonical row read on the PE surface passes through |
| `shadow_read_mismatch_count` | `recordPeShadowComparisonV1`, fed by both `schedulePeShadowComparisonV1` call sites in `program-element-read.service.ts` |
| `promotion_outbox_backlog_age_ms` | `scripts/status-defense-budget-promotion-v1.ts` |

Each is an optional dependency defaulting to a no-op, so every existing caller
compiles unchanged — the same shape session 11 used for the first two.

**The sink is chosen from `PE_SNAPSHOT_READ_MODE`, not a switch of its own**
(`program-element.module.ts`). `legacy` — the default, and what every
environment runs today — gets `NoopSloMetricSinkV1`, so this lands as inert as
the rest of Workstream M. A second flag to remember alongside the mode is a flag
that gets forgotten, and the failure mode of forgetting it is a canary running
blind.

### The one that is not wired, and why

`promotion_db_connection_saturation_ratio` stays `SPECIFIED_NOT_WIRED`. A
saturation *ratio* needs a numerator and a denominator that **do not exist
anywhere in this repository**: Prisma exposes no pool statistics without the
`metrics` preview feature (a schema and client-generation change), and the
alternative — polling `pg_stat_activity` against `max_connections` — is a new
recurring query against a live database, on a schedule nobody has set,
attributing connections to a `role` dimension whose values are a deployment fact
rather than a code fact. Every plausible implementation would also be
unfalsifiable here: there is no Phase 7 deployment whose pool could be observed
to confirm the number means anything.

**This one needs an operator, not an engineer.** A plausible-looking ratio
computed from invented inputs would be worse than an honest gap.

### Persist-verb chaining — closed, deliberately short of automation

Two separate things were both true and needed separating. First, a plain
wiring gap with no design content: `persist-defense-budget-projection-plan-v1`
had **no `entrypoint.sh` case at all** — unlike every one of its
promotion-chain siblings (`plan`, `file-plan`, `authorize`, `validate`,
`status`, `compare`, `execute`, `rollback`, `resume`), it could only be run via
a raw `tsx` invocation from a shell with repo access, never as a deployed
one-off task. Closed by adding a case mirroring `file-defense-budget-promotion-plan-v1`'s
shape exactly (serve role, dry run unless `--commit`).

Second: the runbook documented the two-command chain (planner → persist) for
`committee` only. RDT&E's and the three Phase-5 families' chains exist and
work (their planners' CLI contracts were read directly from source) but were
never written down. Now they are — see the runbook's "Two prerequisite steps"
section for all four.

**Deliberately not done: automating any of this.** Neither the persist verb
nor any of the four family planners (`build-rdte-cycle`,
`plan-rdte-canonical-projection`, `plan-defense-budget-non-rdte-projection`,
`build-defense-budget-phase6-projection-plan-v1`) are wired into any scheduled
task — verified against `infra/cdk/lib/ingestion-schedule.ts` and both
entrypoint files. Fusing planner-then-persist into one automated step would
mean deciding a trigger and a cadence nobody has specified, and it would also
undo the exact separation Gap 4 chose on purpose: `plan-defense-budget-promotion-v1`
stayed read-only and filing became its own authorized ninth verb specifically
so a human decides when a plan becomes permanent evidence. Collapsing the
Phase 4/5/6 chains into one script would quietly reverse that same decision for
a different family. Each chain is still two commands an operator runs.

## Verification

| Gate                                              | Result                       |
| ------------------------------------------------- | ---------------------------- |
| `tsc -p tsconfig.phase6.json` / `.phase7.json`    | clean                        |
| Base `tsc --noEmit`                               | 6 errors — the known pre-existing baseline, unchanged, none in a touched file |
| `jest src/defense-budget src/program-element/snapshot` | **208 suites / 2916 tests**, up 1 from 2915 — the spec change replaced 2 tests with 3 |
| Phase 7 negative controls                         | 32/32                        |
| Phase 6 negative controls                         | 24/24                        |
| Phase 7 safety scan                               | PASS (re-run after the `entrypoint.sh` edit below — still PASS) |
| Phase 6 safety scan                               | PASS                         |
| `pe-budget-phase7-migration-rehearsal.sh`         | **124 checks, exit 0** — unchanged from session 11, confirming no drift |
| New backlog-age SQL                               | proved against a disposable Postgres — see below |

The `promotion_outbox_backlog_age_ms` query is **not covered by the migration
rehearsal**, because the rehearsal never invokes
`status-defense-budget-promotion-v1`. It was therefore proved directly against a
throwaway container: empty backlog returns `0` and not `NULL`, `DONE` and
`POISON` rows are excluded (a fixture with a 10h `DONE` and a 9h `POISON`
correctly reported the 2h `PENDING`), and the `environment` scoping holds. If
that verb grows more SQL, this gap in the rehearsal is worth closing properly.

## Two architectural rules Neo settled on 2026-08-08 — do not reopen

Both were open questions this handoff originally listed as needing a decision.
They are now decided, and enforced by tests rather than by convention. Full
statements in [PHASE-7-ARCHITECTURE-GAPS.md](../defense-budget/PHASE-7-ARCHITECTURE-GAPS.md);
Phase 8 inherits them via §8a of the dependency map.

### R1 — snapshot + live enrichment may coexist, but are never aggregated

> One response may contain canonical snapshot data and live enrichment, but they
> must remain separately typed, separately attributed, separately dated, and
> never be silently aggregated.

`getContractors` was computing `acceptedDirectAmountM = directAwardM + namedPrimeM`
— a government-stated R-3 exhibit value plus a rolling 24-month USAspending
obligation total, rendered as one dollar figure that changed daily while
claiming to describe an immutable exhibit. It now returns two independently
attributed buckets (`evidence.governmentExhibit` with `snapshotId` + activation
`asOf`; `evidence.federalAwards` with `source`, `asOf`, `windowMonths`) and
**no combined total**.

`sumAttributedMeasures` throws `MeasureConflationError` if anything tries to
cross the provenance boundary — the guard is a function rather than a convention
because a convention cannot fail a build. Summing *within* one provenance kind
stays legal.

`assertOneSnapshotV1` is unchanged and still correct; it forbids two canonical
*snapshots*, which is a different failure, so this is a separate rule.

### R2 — `native identity ≠ crosswalk`

No `peCode → BLIN` resolver, ever. The substrate to reuse is
`canonical_budget_line_relationship`, which already has both native identities,
`relationshipType`, `evidenceIds`, and verification lineage — but **no `status`,
`reviewedBy`, or `reviewedAt`** (verified: zero such columns). So every link in
it is a candidate, no governed crosswalk exists yet, and the affected read
methods **stay on the legacy path**. Building and reviewing the crosswalk is a
separate data-curation work item.

`crosswalkSubstrateReadinessV1()` returns `ready: false` and names exactly the
three missing fields; if a migration later adds them, the spec fails and forces
someone to update the readiness list deliberately rather than letting the flag
drift silently true.

## Things worth not rediscovering

Session 11's five still stand and are not repeated here. Three new ones:

- **`canonical-promotion-service-v1.ts` contains six deliberate `\0` bytes** —
  NUL separators inside `sha256Hex` template literals in `runKeyFor` and
  `activationKeyFor`, which is correct practice for unambiguous hash-input
  delimiting. Two consequences. First, **ripgrep treats the file as binary and
  silently returns no content matches**, so `Grep` cannot search it; use
  `Get-Content | Select-String` or `Read`. Second, the `Read` tool renders each
  NUL as a space, so **never copy one of those lines into an `Edit` anchor** —
  you would replace the NUL with a space and silently change every deterministic
  run key and activation key in the system. Verify with a byte count after
  editing that file; it should be exactly 6, and the file keeps a UTF-8 BOM.
- **`makeSnapshotGate` in `program-element-read.service.spec.ts` promises "same
  shape as the real one" and is load-bearing.** Adding a method to
  `PeSnapshotGateService` that `serveWithSnapshotOptionV1` calls will fail that
  spec at the call site, not at an assertion. Add it to the fake rather than
  making the production call defensive — the fake's whole contract is shape
  parity.
- **`src/defense-budget/verification/artifact-smoke.spec.ts` R-2 flakes on a
  5000ms default timeout** when the machine is loaded (e.g. a full-suite run
  competing with anything else). It passes in isolation. Not a regression — do
  not go looking for one.

## What's left

One of session 11's engineering rows remains **not started** — see below for
why it turned out not to be a same-session fit:

| Item                                                    | Status | Note |
| ------------------------------------------------------- | ------ | ---- |
| Wire the remaining 7 SLO metrics                        | **6 done, 1 blocked** | see above |
| Chain the persist verb into producing pipelines         | **done, deliberately short of automation** | `entrypoint.sh` case added; runbook now documents all four family chains, not just `committee`. No scheduled/automated trigger added — see below for why |
| `composeEnactedStageV1` producing real enacted candidates | **not started — larger than described** | see below |
| Rebuild + persist existing Phase 4/5/6 outputs           | not started | needs real cycle data |
| Measured SLO thresholds                                  | **needs a human** | production baseline |
| `promotion_db_connection_saturation_ratio`               | **needs a human** | no pool-statistics source exists; see above |
| Live canary / any real deployment                        | **needs a human** | separate authorization |

### `composeEnactedStageV1` — re-scoped, not attempted

Session 11's framing ("upstream of B1") undersold this. `composeEnactedStageV1`
takes `candidates: readonly EnactedLineCandidateV1[]` as a parameter — it
validates proof/profile invariants and assembles an artifact from candidates it
is handed; it does not discover them. Every construction of
`EnactedLineCandidateV1` in the repository is in a spec fixture — grep confirms
zero real producers. Building one means parsing enacted public-law text or an
incorporated conference-report table (a document type nothing here has ever
parsed — distinct from the RDT&E/procurement budget-justification books the
existing R2/R3 extractors handle) and resolving each parsed line to a
`BudgetLineIdentityV1`, which is an identity-matching problem, not a parsing
detail. That is a new extractor for a new document type against real federal
statute text, not a wiring task, and guessing at its matching rules without a
real public-law document to validate against risks a plausible-looking
extractor that is quietly wrong about money. Left for a session with either a
real document to build against or Neo's steer on approach.

## Safety statement

New source, new specs, doc edits. No merge to `main`, no deployment, no AWS
mutation, no shared-database migration, no production-data access, no canonical
promotion, no snapshot activation, no rollback, no alert fan-out, no paid-parser
call, no live canary. The only databases touched were disposable containers
destroyed on exit.
