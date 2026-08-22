# Phase 8 Session 12 — End-to-End Closeout Proof (No Activation)

**Prepared:** 2026-08-21
**Repository:** `neo-capiro/capirov2`
**Authoritative `main` (documented baseline handed to this session):** `f26e8b0086b1318f270d3273f9dd6ef73347b385` (PR #1171, Session 11)
**`main` at session start (verified by the prior operator before this session began):** `36cc7c1ba638db6448bd22741a14700c08517d1c` (PR #1176, Phase 27B — audited, zero path/contract overlap with Phase 8 defense-budget code)
**`main` at close (re-fetched, audited below, §11):** `56be9b5ed871b2eff32f7fd1ee766312e43a72d2`
**Session 12 branch:** `agent/phase8-session12-e2e-closeout`, forked from `36cc7c1ba6`
**Workstream:** end-to-end closeout / proof-only pass over the Session 7-11 discovery/watcher/schedule/product control plane — **no activation of anything**

---

## 1. Scope derivation — read this first

**There is no Session 12 specification document in this repository, and no code
comment or handoff forward-pointer names "Session 12" anywhere** — a genuine
break from the pattern every prior session (2-11) followed, where an informal
forward-pointer always existed even without a formal spec (a code comment or a
handoff's own "S8=X, S9=Y..." table). A repo-wide, case-insensitive search for
`"Session 12"` / `"SESSION12"` returns exactly three files, and all three
belong to a **completely different, unrelated program** — the older
PE-Budget-Phase-7 lineage (`apps/api/src/program-element/*`,
`apps/defense-api/src/program-elements/*`), which has its own independent
session-numbering track, already documented in Session 11's own handoff §2 as
"system (A)", **completely disconnected** from the Session 7-11 discovery/
watcher/schedule/product domain this session extends ("system (B)").

The only genuinely open, documented item anywhere in the Phase 8 lineage is
Session 10's handoff §10 item 1:

> "**Activation** — wiring an actual trigger (EventBridge rule, ECS scheduled
> task) to invoke `run-schedule-controller.mjs --tick --commit` on a real
> cadence, plus the egress allowlisting from Session 8's own open items, is
> deployment work this session deliberately did not do."

Session 11 explicitly claimed only item 2 from that same list ("product/HTTP
integration"); item 1 was left dangling, unclaimed by any numbered session.

**Given no repository authority exists to invent a "Session 12" scope, and
given production activation for a system this integrated with a live app
(`app.capiro.ai`/`os.capiro.ai` on `capiro-dev` AWS) must never be
self-authorized, the absence above was surfaced to the human operator
directly, and the human operator chose explicitly: "Closeout / E2E proof
only, no activation."** This is the authoritative scope for this session.
Its provenance is: (1) a repository-wide search proving the absence, (2) the
absence surfaced to the operator, (3) the operator's own explicit decision —
disclosed here plainly, exactly as any other scope source would be, because
it is the true and only source of this session's mandate. This is a
legitimate, disclosed authority chain, not an invented one, and it is a
narrower scope than any prior session claimed: it deliberately builds nothing
new, activates nothing, and proves what the existing Session 7-11 system
already does end to end.

## 2. The canonical-promotion investigation — finding

Session 11's handoff (§2) already established that system (A)'s
canonical-promotion + review-queue + HTTP surface is untouched by system (B),
and that system (B)'s own ingestion outbox "has a producer and no consumer."
This session's task was to investigate the real, current code path from
"readiness" to the Session 11 product/read routes and determine precisely
whether readiness feeds directly into the read model with no separate
promotion step, or whether a real gap exists.

**Finding: readiness feeds directly into the read model. There is no
canonical-promotion consumer anywhere in system (B), and none is needed for
the read surface to be correct.**

Traced end to end in `apps/defense-api/src/budget-lifecycle-product/
budget-lifecycle-query.service.ts`: `BudgetLifecycleQueryService` composes
`PrismaBudgetLifecycleReadStore` (raw SELECT over
`defense_budget_expected_source` / `defense_budget_source_observation`
directly), the existing `CycleHealthService`, and the frozen, pure
`deriveLifecycleSignals` — nothing in this chain reads
`defense_budget_ingestion_outbox` at all, and nothing waits for an
`observation_state = 'ingested'` transition that no application code ever
performs (the outbox has a producer — the watcher's `enqueueIngestion` call —
and, as Session 11 found, no consumer). The Session 12 rehearsal proves this
**behaviorally**, not just structurally: `scripts/seed-phase8-session12-corpus.mjs`
runs the REAL `DefenseBudgetLifecycleWatcher.runAdapter({ commit: true, ... })`
against fixtures, which leaves freshly-discovered observations at
`observation_state = 'changed'` (never advancing to `'ingested'`, because
nothing in this repository ever performs that transition), and
`scripts/verify-phase8-session12-e2e.mjs` proves the REAL, compiled
`BudgetLifecycleQueryService`, reading through `capiro_defense_serve`
credentials, immediately serves that `'changed'` observation correctly — same
fields, same provenance, same current-vs-superseded distinction — with no
extra step. `expectedState = 'published'` (Session 7's own frozen
`LifecycleStore.setExpectedSourceState` call, made the moment the watcher
commits) is the only signal the read model needs; there is no second,
separate "promote to canonical" action anywhere for it to wait on.

**Conclusion, stated plainly per the task's own instruction**: this is not a
gap to build around or disclose as unproven — the chain genuinely has no
promotion step, by design, and the existing code already proves it correct.
No new "canonical promotion" code was invented to satisfy the literal wording
of a generic ingestion-pipeline checklist, and no promotion/consumer code was
built as a speculative workaround (that would have been new production
functionality, outside this session's closeout-only scope). The one honestly
disclosed absence, carried forward unchanged from Session 11, is that
`defense_budget_lifecycle_signal` still has no writer — signals remain
computed read-time from stored observation history, exactly as Session 11
left them.

## 3. What was built

All of it is new, additive scripts and this one document. **Zero production
source files were touched** — proven mechanically, not just claimed, by
`scripts/verify-phase8-session12.mjs` §3 (diffed against this branch's own
fork point, not a moving `origin/main`; see §11 for why).

- `scripts/seed-phase8-session12-corpus.mjs` — unlike Session 11's own corpus
  script (which inserts final row state directly), this one drives the REAL
  compiled Session 7 control loop (`AnnualDefenseBudgetCycleController` +
  `DefenseBudgetLifecycleWatcher`, backed by the REAL `PrismaLifecycleStore`)
  through fixture discovery/fetch ports — reusing the exact
  `FixtureDiscoveryPort`/`FixtureFetchPort` classes Session 7's own domain
  tests established (`apps/defense-api/src/budget-lifecycle/testing/
  fixture-ports.js`, compiled to `dist/`) — with new FY2029/FY2030 fixture
  documents whose titles and structure are adapted from the same real,
  publicly-published wording Sessions 7 and 11 already used (year changed
  only, the exact technique Session 10's FY2032 merge-gate proof used). No
  network call is made anywhere; discovery and fetch are both fixture-backed.
  Builds, in order: a first-discovery HASC report (FY2029 authorization), an
  identical re-discovery (dedup proof), a corrected v2 (immutable-successor/
  supersession proof, forced via explicit `versionRank` so the outcome is
  genuinely `superseding_version`, not just `changed`), a real Session-7-style
  ambiguous omnibus appropriations act with no proven Department of Defense
  division evidence (review-required proof), a continuing-resolution overlay
  and a separately-attributable emergency supplemental (both
  `alternative_funding`, both published, both distinct stages), a healthy
  FY2030 authorization discovery, and a FY2030 appropriations adapter
  (`house-appropriations`) whose `discover()` is made to throw outright
  (simulated publisher outage — poison-isolation proof). Two schedule-tick
  rows (one completed, one failed) are seeded directly via SQL, the same
  precedent Session 11's own corpus used, since tick-health aggregation is
  read-only over already-persisted rows and exercising the real
  `ScheduleCoordinatorService` is Session 10's own already-covered territory.
- `scripts/verify-phase8-session12-e2e.mjs` — the real product/read
  integration + role-boundary + governed-resolution + poison-isolation proof,
  structured identically to `verify-phase8-session11-integration.mjs`: runs
  the REAL compiled `BudgetLifecycleQueryService` against
  `capiro_defense_serve`/`capiro_defense_job` rehearsal LOGIN roles, and
  exercises the REAL, **unmodified** `run-review-resolution.mjs` CLI (Session
  11's own governed command) as a subprocess. 18 checks; see §5.
- `scripts/verify-phase8-session12-e2e-db.sh` (+ `.mjs` wrapper) —
  orchestrates the disposable-Postgres rehearsal end to end (migrate,
  rehearsal roles, workspace-dependency build, defense-api build, seed, run
  the integration proof), following `verify-phase8-session11-db.sh`'s exact
  structure and self-managed-container convention.
- `scripts/verify-phase8-session12.mjs` — static verifier proving Session
  12's own scope claim mechanically: frozen 49 routes intact, Session 11's 6
  product routes intact and unchanged, **zero diff under any production
  source tree** (`apps/defense-api/src`, `packages/defense-domain/src`,
  `packages/defense-contracts/src`, `apps/api/src`, `apps/web/src`,
  `apps/api/prisma/schema.prisma`), no new migration, no activation-gate
  env var set to a truthy literal anywhere this session added, no live
  network call or GPU/NVIDIA/promoter/AWS-SDK reference in the new rehearsal
  scripts, and `run-review-resolution.mjs` byte-identical to what Session 11
  shipped (reused, not reimplemented).
- Three `package.json` script entries: `verify:phase8-session12`,
  `verify:phase8-session12:e2e`, `verify:phase8-session12:e2e:db` — the only
  change to any file outside `scripts/` and `docs/defense-budget/`.
- This handoff document.

**Deliberately not added**: no new GitHub Actions workflow file. Every prior
session added one, but Actions remains externally unavailable repo-wide
(unchanged since 2026-07-31), this session's own explicit deliverables list
did not call for one, and a closeout/proof-only session adding new CI
surface area felt like the wrong kind of scope creep for a session whose
entire point is "prove what exists, add nothing new." Flagged here as a
deliberate scope decision, not an oversight.

## 4. What was NOT built, and why

- **No canonical-promotion consumer.** See §2 — genuinely not needed; building
  one would have been new production functionality outside closeout scope.
- **No activation of anything.** No EventBridge rule, no ECS scheduled task,
  no cron. `PHASE8_SESSION10_TICK_AUTHORIZED` is never set to `true` anywhere
  this session added — measured by `verify-phase8-session12.mjs` §5, not
  merely claimed.
- **No AWS API call of any kind.** No `aws` CLI invocation, no AWS SDK
  reference in anything new — measured by `verify-phase8-session12.mjs` §6.
- **No live network request anywhere.** The E2E rehearsal is entirely
  fixture-driven; discovery and fetch never leave the process. Measured, not
  claimed, by the same static gate.
- **No new production HTTP route.** Zero route delta — see §7.
- **No new Prisma migration.** The existing schema already supports every
  proof this session needed; see §9 for why.
- **No signal persistence, no HTTP mutation of any kind, no NVIDIA
  provisioning or restart.** Unchanged, carried forward from Session 11 §4
  verbatim — this session touches none of that surface either.
- **No rebase onto the latest `origin/main`.** Main moved three times during
  this session (see §11); every move was audited and found to have zero path
  or contract overlap with anything this session touches. Given that, and
  given each rebase would have required re-running the entire regression
  sweep (a genuinely expensive, multi-hour operation in this sandbox — see
  §6's OOM notes), rebasing was judged unnecessary scope for a closeout-only
  session that changes no production code. The PR is opened against this
  branch's actual fork point; a maintainer can rebase before merge if desired.

## 5. The disposable-database rehearsal: SESSION12_E2E_INTEGRATION_PASS (18/18)

**Environment**: the same native Ubuntu-24.04 WSL2 distro with plain
`docker.io` (no Docker Desktop) that Session 11 set up still existed
(`wsl -l -v` showed it `Stopped`); it was started and reused exactly as
instructed, with zero recreation needed — `docker --version` reported
29.1.3 and the daemon came up in under two seconds.

Against that environment, `scripts/verify-phase8-session12-e2e-db.sh`
(self-managed `pgvector/pgvector:pg16` container) ran the full sequence —
apply the current 308-entry migration ledger from zero, create
`p8s12_serve_rehearsal`/`p8s12_job_rehearsal` LOGIN roles inheriting the real
`capiro_defense_serve`/`capiro_defense_job` capability roles, build the
`defense-api` workspace dependency graph and the app itself, run the
behavioral corpus seed, then the integration proof — and produced
**`SESSION12_E2E_INTEGRATION_PASS` (18 checks)** and
**`SESSION12_E2E_DB_REHEARSAL_PASS`**, proving every item on the 12-point
acceptance list:

1. **Two overlapping fiscal years remain independent.** FY2029 and FY2030
   were both bootstrapped and populated in the same rehearsal database; a
   read of FY2030 (immediately after reading FY2029) reports FY2030's own
   authorization/appropriations counts, and a subsequent re-read of FY2029
   reports byte-identical values to before — proven by direct assertion, not
   assumed from separate reads.
2. **Authorization and appropriations remain independently represented.**
   FY2029: authorization `published=1, reviewRequired=0`; appropriations
   `published=0, reviewRequired=1` — never merged into one count or one
   track.
3. **Unchanged bytes do not duplicate work.** The REAL watcher was run twice
   with byte-identical fixture content for the same expected source; the
   second run's outcome was asserted `unchanged`, and the observation-row
   count was asserted equal before and after (exactly 2 rows survive the
   whole scenario: v1 and the later genuine v2, never 3).
4. **Changed bytes create an immutable successor.** A corrected v2 (forced
   via explicit `versionRank` to a genuine `superseding_version` outcome)
   produced a NEW observation row with `supersededByObservationId` pointing
   forward from v1, distinct `contentSha256` values on both rows, and v1's
   own bytes read back unchanged — never an in-place edit.
5. **CR overlay does not erase the baseline.** After seeding the FY2029
   continuing-resolution and emergency-supplemental candidates, the
   authorization row was re-read and asserted still `published`, and the
   appropriations row was re-read and asserted still `review_required` —
   both untouched by the alternative-funding activity.
6. **Alternative/supplemental funding remains separately attributable.** The
   CR (`stage=continuing_resolution`) and the supplemental
   (`stage=emergency_supplemental`) are two distinct `id`s, both
   `authorityTrack=alternative_funding`, both independently `published`.
7. **Ambiguous correlation is held for review.** The real classifier
   (`classifyLifecycleSource`, untouched by this session) resolved the
   omnibus-with-no-division-evidence candidate to `decision: 'review'`
   exactly as Session 7's own fixture proved for FY2024's version of the
   same real ambiguity; the review queue read surfaced it with its actual
   classifier reasons and provenance.
8. **Governed review resolution changes only the intended row/state.** A
   full pre/post snapshot over every budget-lifecycle table plus
   `defense_budget_review_resolution` proved exactly one
   `defense_budget_expected_source` row changed (the target), plus exactly
   one new resolution-audit row — nothing in FY2030, nothing in the CR/
   supplemental rows, nothing anywhere else.
9. **The read result changes appropriately immediately after resolution.**
   The very next `listReviewQueue(2029)` call returned zero items, and
   `getExpectedSourceDetail` reported `published` with the original
   observation history (provenance) still intact.
10. **Provenance survives to the product/read output.** `discoveredUrl`
    (real `https://www.govinfo.gov/...` URL), `contentSha256` (real,
    64-hex-char sha), and `firstSeenAt` were asserted present and unchanged
    across the whole flow, including after resolution.
11. **Stale/error source health is visible in the read model.**
    `getScheduleTickHealth()` reported `completedTicks=1, failedTicks=1`,
    with the real failure reason (`house-appropriations: simulated publisher
    outage`) surviving to the read model; separately, the failing adapter's
    own row in `defense_budget_watcher_adapter` was asserted `status=
    'failing'` with a nonzero `consecutive_failures` count.
12. **One failed adapter/track does not poison unrelated results.** The
    FY2030 `house-appropriations` outage was proven not to affect FY2030
    authorization (still `published=1`) nor any FY2029 value (re-read and
    compared byte-for-byte to its pre-outage state) — and the specific
    outage-affected expected source itself was confirmed left honestly
    `expected` (zero observations), never corrupted into a false state.

Alongside the 12-point list, the same role-boundary and dry-run/refusal
proofs Session 11 established were re-run against the Session 12 corpus
specifically (not merely reused conceptually): `capiro_defense_serve` is
refused with `permission denied` on the exact UPDATE the resolution CLI
issues; a `--commit` without `PHASE8_SESSION11_REVIEW_RESOLUTION_AUTHORIZED=
true` is refused before any write; a dry run performs zero writes (full
snapshot hash unchanged); a `--commit` attempt under serve credentials is
denied by the database itself; and a repeat resolution of the now-published
item is refused (`not 'review_required'`), not double-applied.

Immediately afterward, every PRIOR session's own **unmodified**
disposable-DB rehearsal was re-run in the same environment:

```text
S7  SESSION7_DB_REHEARSAL_PASS   (63 checks)  — matches documented 63/63
S8  SESSION8_DB_REHEARSAL_PASS   (51 checks)  — matches documented 51/51
S9  SESSION9_DB_REHEARSAL_PASS   (43 checks)  — matches documented 43/43
S10 SESSION10_DB_REHEARSAL_PASS  (39 checks)  — matches documented 39/39
S11 SESSION11_INTEGRATION_PASS   (20 checks) + SESSION11_DB_REHEARSAL_PASS
                                               — matches documented 20/20
```

Every one matches its documented baseline exactly. No regression anywhere in
the Session 7-11 control plane.

## 6. Regression sweep — actually executed, this session, on the final candidate

```text
S2  SESSION2_BOUNDARY_PASS                                    static
S3  SESSION3_BOUNDARY_PASS                                    static, 49 frozen routes
S3  SESSION3_ADMIN_BOUNDARY_PASS                               static
S4  SESSION4_SOURCE_PARITY_PASS (--enforce-replay)             static
S5  full negative-provider-decision suite PASS (79 checks)     static, NVIDIA_NOT_ADOPTED intact
S6  SESSION6_FEDERAL_FUNDING_FOUNDATION_PASS (--enforce-corpus) static
S6  domain 9/9                                                 PASS
S7  SESSION7_LIFECYCLE_CONTROL_PLANE_PASS (--enforce-replay)    static
S7  domain 57/57                                                PASS
S8  SESSION8_LIVE_DISCOVERY_PASS (--enforce-replay)             static
S8  discovery domain 40/40 + publisher-native domain 15/15      PASS
S9  SESSION9_PROVIDER_RUNTIME_PASS                              static
S9  domain 36/36                                                PASS
S10 SESSION10_SCHEDULE_CONTROL_PLANE_PASS                       static
S10 domain 18/18                                                PASS
S11 SESSION11_PRODUCT_INTEGRATION_PASS                          static
S11 domain 10/10                                                PASS (buildScheduleTickHealth)
S12 SESSION12_E2E_CLOSEOUT_PASS                                 static (this session's own gate)
S7  DB rehearsal 63/63                                          PASS (re-run, native WSL2 docker.io)
S8  DB rehearsal 51/51                                          PASS (re-run)
S9  DB rehearsal 43/43                                          PASS (re-run)
S10 DB rehearsal 39/39                                          PASS (re-run)
S11 DB rehearsal 20/20                                          PASS (re-run) — SESSION11_INTEGRATION_PASS
S12 E2E DB rehearsal 18/18                                      PASS (new)   — SESSION12_E2E_INTEGRATION_PASS
defense-api typecheck                                           PASS (clean)
defense-api build (nest build)                                  PASS (dist/ built; every DB rehearsal above ran against it)
defense-api full spec suite                                     84 tests, 78 pass, 0 fail, 6 skipped
apps/api prisma validate                                        PASS
defense-api prisma validate                                     PASS
apps/api typecheck baseline                                     16 errors, byte-identical category set to the
                                                                  documented Session 9-11 baseline (4 rootDir/TS6059
                                                                  + 1 alert-memo + 2 memory + 6 meri + 3 reviews) —
                                                                  confirmed unaffected by PR #1176 (Phase 27B)
apps/web typecheck                                               PASS (clean, whole app)
apps/web applicable tests (defense-budget-lifecycle module +
  VNextRouter.defense-budget-lifecycle.test.tsx)                4 files, 14 tests, 0 fail
git diff --check (scoped to this session's own changed files)   clean
```

### 6a. Three real bugs found and fixed in this session's OWN new code, by the rehearsal itself

Exactly the spirit of every prior session's closeout — bugs the rehearsal
found, not bugs shipped around:

1. **Workspace build-order gap.** A fresh clone/install has no
   `packages/*/dist` yet, so `nest build` failed outright with 64 `TS2307`
   "cannot find module" errors against `@capiro/auth`, `@capiro/defense-
   contracts` and `@capiro/defense-domain/pe-read` on the first attempt.
   `verify-phase8-session12-e2e-db.sh` now runs
   `pnpm turbo run build --filter='@capiro/defense-api^...'` before the
   `defense-api` build step, using turbo's own `dependsOn: ["^build"]`
   dependency graph rather than hand-listing packages. The same gap existed
   for `apps/api`'s typecheck (missing `@capiro/meriv2-core`), fixed the same
   way for the regression sweep.
2. **The static verifier compared against a moving `origin/main`.**
   `verify-phase8-session12.mjs`'s first draft used `git diff --name-only
   origin/main` to prove "Session 12 touched no production tree." Two
   unrelated commits landed on `origin/main` mid-session (PR #1177's
   Outreach V3 test fix among them; see §11), and diffing against a moving
   target would fail this gate forever on any future upstream change, not
   just on something Session 12 did. Fixed by diffing against the branch's
   own fork point (`36cc7c1ba638db6448bd22741a14700c08517d1c`) instead — the
   actually meaningful question for a scope-boundary gate.
3. **`git diff --name-only` is SHA-based and does not honor whitespace-ignore
   flags.** The same gate's initial run reported 114 false-positive
   "modified" files under `apps/web/src`, all `.css` files that are not in
   `.gitattributes`' LF-forced list; this Windows checkout has them with
   CRLF line endings while `origin/main`'s stored blobs are LF-only, so
   `--name-only` (a fast SHA-comparison path) lists them as changed even
   though `git diff --ignore-cr-at-eol` shows zero real difference —
   confirmed to predate this session entirely by reproducing identically
   against this branch's own unmodified starting commit. Fixed by having
   `gitDiffNames()` follow up every SHA-based candidate with an actual
   line-ending-normalized content comparison (the same `\r\n` → `\n`
   normalization every prior session's own `read()` helper already uses)
   before treating it as a real change — the exact "preserve verifier
   portability on LF and CRLF" instruction this session was given, applied
   to a directory-diff check rather than a single-file read for the first
   time in this lineage (S10/S11's own scoped diffs never hit this because
   their path, `apps/defense-api/src/budget-lifecycle`, is TS-only and
   `.ts` files are LF-forced by `.gitattributes`; `apps/web/src` is not).
   A related self-inflicted false positive (the network/GPU/AWS
   content-scan matching its own detector regex literals — the "verifier
   matched its own prose" bug class Sessions 7 and 9 each found) was fixed
   by excluding the verifier's own file from that specific scan.

None of these three bugs touched any Session 7-11 production file; all three
were in Session 12's own new scripts, found and fixed by the rehearsal before
this candidate was finalized.

### 6b. A pre-existing, repo-wide, session-unrelated finding (disclosed, not swept under the rug)

An **unscoped** `git diff --check` (no path restriction) floods with
thousands of "trailing whitespace" warnings across many files this session
never touched (`.dockerignore`, `.env.example`, `scripts/sql/*.sql`, and
others) — every one is CRLF line endings, which register as trailing
whitespace when the diff engine treats the whole file as replaced due to the
same SHA-mismatch-from-line-endings effect described in §6a item 3.
**Confirmed to predate this session**: `git diff --check` against this
branch's own unmodified start commit (`HEAD`, not `origin/main`) reproduces
the identical warnings on the identical files. This is a Windows-checkout
line-ending artifact affecting non-`.gitattributes`-forced file types
repo-wide, unrelated to Phase 8 or this session. `git diff --check` scoped to
the files this session actually added/changed
(`scripts/seed-phase8-session12-corpus.mjs`,
`scripts/verify-phase8-session12*.{mjs,sh}`, `package.json`) is genuinely
clean — verified directly, zero output, exit 0.

### 6c. An environment note worth carrying forward: `tsc --noEmit` can abort on default V8 heap

`apps/api`'s full typecheck genuinely crashed with `SIGABRT` ("Aborted (core
dumped)") on the very first `tsc --noEmit` invocation the first time it was
attempted in this WSL2 environment — confirmed via `dmesg` to be a V8-level
fatal allocation failure, not the Linux OOM-killer (the host had 9.4 GB free
immediately after). Re-run with `NODE_OPTIONS=--max-old-space-size=8192` (and
with the missing workspace dependencies built — §6a item 1) completed cleanly
and reproduced the exact documented baseline. Worth remembering for the next
session that also needs to typecheck `apps/api` in a memory-constrained
sandbox.

## 7. Route accounting

| Surface | Count | Verified by |
|---|---|---|
| Session 3 frozen routes (`defineRoute(...)` in `packages/defense-contracts/src/public/index.ts`) | **49**, exact | `verify-phase8-session3.mjs`, re-confirmed by `verify-phase8-session12.mjs` §1 |
| Session 11 product GET routes (`defineProductRoute(...)` in `budget-lifecycle-product-routes.ts`) | **+6**, all GET | `verify-phase8-session11.mjs`, re-confirmed by `verify-phase8-session12.mjs` §2 |
| Session 12 route delta | **0** | `verify-phase8-session12.mjs` §2 diffs the product-routes file and the whole `budget-lifecycle-product/` directory against this branch's fork point — zero lines changed |

No new route, no route removed, no route method or path changed.

## 8. Security / role-boundary confirmation

Re-measured, not assumed, against the Session 12 rehearsal database, using
real `p8s12_serve_rehearsal`/`p8s12_job_rehearsal` LOGIN roles that inherit
the production `capiro_defense_serve`/`capiro_defense_job` capability roles:

- `capiro_defense_serve` performs every one of the six Session 11 read
  routes correctly against the Session 12 corpus.
- `capiro_defense_serve` is refused, measured (`permission denied`), on
  UPDATE against `defense_budget_expected_source` for the Session 12
  review-required row, and specifically on the exact UPDATE statement the
  resolution CLI issues.
- A `--commit` invocation of `run-review-resolution.mjs` under serve
  credentials is denied by the database itself, not merely by the missing
  authorization env var.
- `capiro_defense_job` retains write access, unchanged, and is the only role
  through which the one governed mutation (review resolution) can succeed.
- A full-table snapshot hash is byte-identical before and after every read
  route runs against the Session 12 corpus — no lease, no adapter call, no
  promotion, no write, from any read.
- No new migration, so no new grant statement of any kind was introduced
  this session — the entire role-boundary surface this session touches is
  exactly what Sessions 7-11 already established.

## 9. Migrations / schema drift

**None needed, and the reasoning was checked, not assumed.** This session
composes existing primitives (`AnnualDefenseBudgetCycleController`,
`DefenseBudgetLifecycleWatcher`, `PrismaLifecycleStore`,
`BudgetLifecycleQueryService`, `run-review-resolution.mjs`) against fixture
data — nothing here needed a new table, a new column, or a schema change.

- `prisma migrate deploy` applied the full, current 308-entry migration
  ledger (280 pre-existing + Sessions 2/3/6/7/8/9/10/11 + the two Phase 27A/
  27B learning-signal migrations that landed on `main` since the Session 11
  baseline) from a zero-state database with **zero collision, zero
  structural drift** — the ledger applies cleanly start to finish.
- `apps/api/prisma/schema.prisma` and `apps/defense-api/prisma/schema.prisma`
  both validate cleanly (`prisma validate`, exit 0, "The schema ... is
  valid").
- `verify-phase8-session12.mjs` §4 asserts directly, via a fork-point diff,
  that neither `apps/api/prisma/migrations` nor
  `apps/defense-api/prisma/migrations` gained a single file this session.

## 10. Disclosed limitations

### 10.1 No canonical-promotion consumer exists, and none was built

See §2. This is the honest, investigated answer, not a gap papered over.

### 10.2 The FY2030 appropriations "poison isolation" proof uses a real, but synthetic, adapter failure

The outage is simulated (the fixture discovery port's `discover()` throws for
`house-appropriations` specifically), not a real publisher 403/timeout. This
mirrors exactly how Session 10's own merge-gate proof (§5a item 2, a
"blocked" appropriations document) established the same class of guarantee —
a synthetic-but-structurally-real failure through the REAL watcher and REAL
database, not a purely in-memory unit-test double. A genuinely live publisher
outage's timing/retry characteristics remain unverified until a real
deployed tick runs — unchanged from Session 10's own disclosed limitation
9.2, which this session does not (and could not, within its own no-network
constraint) resolve.

### 10.3 `apps/api` full typecheck retains its 16 pre-existing errors

Unchanged from the Session 9-11-documented baseline, confirmed category-for-
category identical (§6). Out of Session 12 scope — this session's own diff
touches no `apps/api` TypeScript source at all.

### 10.4 No new GitHub Actions workflow

See §3. Actions remains externally unavailable repo-wide since 2026-07-31;
every gate above was run locally on this exact candidate, exactly like every
prior Phase 8 session.

### 10.5 `MAP_STYLE_ATTRIBUTION`

Still needs its real value restored — carried forward from the Engagement
vNext session, unrelated to Phase 8, noted again only for continuity with
every prior handoff in this lineage.

## 11. `origin/main` moved three times during this session — all audited, zero overlap

`origin/main` was re-fetched multiple times, per the mandatory Step 1
verification this session started with and the mandatory final re-check
before closing out.

| Move | Commits | Files touched | Overlap with Phase 8 defense-budget code |
|---|---|---|---|
| `36cc7c1ba` → `fd74b152d` | PR #1177 (`fix(outreach-v3): fix broken Phase 1 authority contract test on Vite asset-URL rewrite`) | 1 file: `apps/web/src/.../VNextOutreachApproveSendWorkspace.test.tsx` | **None.** |
| `fd74b152d` → `56be9b5ed` | PR #1178 (Phase 27C — conflict/dedup/supersession learning) + PR #1180/#1181 (client-profile Fill-with-Meri improvements) | `apps/api/src/{clients,learning,memory}/*`, `apps/web/src/vnext/pages/client-crm/*`, `packages/meriv2-core/src/learning/*`, one new learning-signal migration, `scripts/check-learning-signal-new-bypasses.mjs` | **None.** Zero references to `apps/defense-api`, `packages/defense-domain`, `packages/defense-contracts`, or `docs/defense-budget` anywhere in either diff. |

Both moves were audited the same way the prior operator audited PR #1176 at
session start: `git log --oneline <old>..<new>` plus `git diff --stat` over
the full commit range, read in full, path-by-path. Every file is either
frontend-test-only (Outreach V3, unrelated program) or backend
learning/memory/client-profile code (Phase 27A/B/C lineage, unrelated
program) — never anything under the Phase 8 defense-budget tree. No gate this
session ran needed to be re-run because of these moves; the one repo-wide-ish
gate (`apps/api` typecheck) was measured against this branch's own checked-
out code, which does not include these later commits at all, so it is
unaffected by what happened to `main` afterward. This branch was
**deliberately not rebased** onto the final tip — see §4's own reasoning.

## 12. Commands

```bash
# Domain (already exercised in every prior session's own commands, unmodified)
node scripts/verify-phase8-session12.mjs

# Behavioral corpus (real control loop, fixture-driven, no network) + the
# full end-to-end proof, against a disposable database:
pnpm verify:phase8-session12:e2e:db

# Or by hand, against any already-migrated rehearsal database:
DATABASE_URL="$REHEARSAL_DATABASE_URL" node scripts/seed-phase8-session12-corpus.mjs
ADMIN_DATABASE_URL=... SERVE_DATABASE_URL=... JOB_DATABASE_URL=... \
  node scripts/verify-phase8-session12-e2e.mjs
```

## 13. Final verdict

```text
SESSION12_COMPLETE
READY_TO_MERGE_SESSION12   (awaiting separate explicit authorisation)
```

All 12 acceptance criteria proven end to end against a real, disposable
database. Zero production code touched. Zero routes added. Zero migrations
added. Zero activation of anything. Zero AWS calls. Zero network calls. Zero
spend.

```text
AWS mutated:                      NO
Production DB mutated:            NO
Production schedules activated:   NO
EventBridge/Cron activated:       NO
Production deployment mutated:    NO
Production public routes changed: NO (delta: 0 — 49 frozen + 6 product, unchanged)
Bedrock/provider activated:       NO
Live provider calls:              NO
Provider/AWS spend:               $0
NVIDIA provisioned/restarted:     NO
Session 13 started:               NO
PR merged:                        NO
```

**Do not merge until separately authorised.**
