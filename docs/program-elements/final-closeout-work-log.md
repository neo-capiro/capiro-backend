# Program Elements Final Closeout — Work Log

**Branch:** `agent/program-elements-final-closeout`  
**PR:** https://github.com/neo-capiro/capirov2/pull/705 (draft → `main`)  
**Plan source:** local `program-elements-final-closeout-plan-and-schedule.md`  
**Repo:** `neo-capiro/capirov2`  
**Operator session:** Phase 9 IMPLEMENT (integrated release rehearsal)
**Generated (UTC):** 2026-07-30T10:31:22Z  
**Ledger last updated (UTC):** 2026-07-31 (Phase 9 B1 FAIL rework IMPLEMENT PUSHED / independent review REQUIRED — no self-PASS)

---

## Hard boundaries (all phases)

- One phase per agent session.
- Do not merge, deploy, run shared-environment migrations, commit ingestion, call LlamaParse, retrieve secrets, send email, or execute the derive chain unless Neo authorizes separately.
- Do not modify MeriV2 **product** source. Shared-package compatibility may be checked without edits. Older Phase J branches that patch `packages/meriv2-core` or Meri helpers are **out of scope for direct merge** under the closeout plan (classifier/grounding owned in Phase 7 with PE/API/Workspace + shared only).
- Never label synthetic/AI rows as human reviewed.
- Never mark a phase complete from comments, local-only patches, or temporary workflows.

---

## SHA ledger (recorded during Phase 0)

| Ref | Full SHA | Note |
|---|---|---|
| `origin/main` (Phase 0 baseline) | `057f5480a46f9ba9acf9296a9cc876b609593832` | `chore(infra): GitHub Actions OIDC read-only + production deploy roles (#702)` (2026-07-29) |
| `origin/main` at Phase 0 push time | `010948cc3f475dd0ee47016deba5619c044d8fed` | re-fetched; sync if different from baseline row |
| Pre-Phase-0 PR #705 head | `a244022648d54d9e4ac7fb071f9f438405659056` | Transport-only tip (base64 patch segments + source-export workflow). **Not product.** |
| Merge-base(`main`, pre-Phase-0 tip) | `057f5480a46f9ba9acf9296a9cc876b609593832` | Branch was already based on current main (0 behind, 22 ahead of transport commits only). |
| Post-Phase-0 tip (branch after Phase 0 commits) | `c42471dbaa2a8e4d39dcce20e6edf03cda46b600` | main + Phase 0 ledger docs; merge commit included for main sync |
| `origin/agent/pe-trust-phase-d` | `fc719ff27d0249cecc8c47d6524de30b86c87bce` | Snapshot workflow only |
| `origin/agent/pe-trust-phase-d-v2` / `phase-e` | `b2d500e7fbb81f2029ff649ce7e8247923e7732e` | Transport patches + finalize workflows; **no applied product tree** |
| `origin/agent/pe-trust-phase-f` | `b135689593838e7e0f0ca042b9aca7599b6b0c13` | **Recoverable product** SAM complete-window work (+ temp export workflow) |
| `origin/agent/pe-trust-phase-g-recovery` | `3dfcc2b561c1d7517ed3acd986f0c5bbd3778f00` | = Phase F product + recovery workflow text; **no Phase G product files** |
| `origin/agent/pe-trust-phase-i` | `cd59d9b3f4f56cb147193d7dcb3b3caa00f83a53` | Workflows only; product claimed “verified” but **not present in branch tree** |
| `origin/agent/pe-trust-phase-j` | `bc861f0f05b619e81567146135d92d5171b748d9` | Product embeds MeriV2 + Meri edits (plan forbids MeriV2 source edits) |
| `origin/agent/pe-trust-phase-k` | `ceadbed83e466e72d29ade9c891946e99cf1fb1a` | Phase J tree + source snapshot workflow + empty phase-k docs stub |

---

## Phase 0 executed work

### 0.1 Fetch and branch hygiene

- Removed broken local ref `refs/heads/feat/billing-stripe` blocking fetch.
- `git fetch origin main agent/program-elements-final-closeout agent/pe-trust-phase-*`
- Clean worktree at `C:/c/Users/neoma/AppData/Local/Temp/pe-closeout-wt` (MSYS path quirk) checked out as `agent/program-elements-final-closeout` from `origin/main`.

### 0.2 Pre-Phase-0 PR #705 truth

PR #705 head **claimed** “final trust remediation closeout” but the **actual git tree** contained only:

```
.github/pe-final-v2.part000 .. part015          # incomplete base64/gzip transfer (part015 == PLACEHOLDER)
.github/program-elements-final-patch.part00/01  # truncated gzip (decompress fails)
.github/remaining-transfer-instructions.txt
.github/test-small-upload-reference.txt
.github/workflows/program-elements-final-closeout-source.yml
```

- Diff vs main: **+52 / −0 across 21 files — zero product paths**.
- Concatenated `pe-final-v2` ends with literal `PLACEHOLDER`; gunzip of decoded bytes fails (`invalid literal/length code`).
- CI run `program-elements-final-closeout-source` (e.g. run `30511325568`) only zipped the transport tree (≈42 MB zip of then-current branch = main + transport).

**Conclusion:** Nothing product was ever stateful on PR #705. Supersede texts on closed phase PRs that claim #705 “contains the actual integrated product” were **aspirational / false** as of tip `a24402264`.

### 0.3 Open / closed PE PR inventory (evidence only)

| PR | State | Head ref | Real product vs main? | Disposition |
|---|---|---|---|---|
| #647 Phase A | merged | `agent/pe-trust-phase-a` | yes (in main) | already in main |
| #663 Phase B | merged | `agent/pe-trust-phase-b` | yes (in main) | already in main |
| #669 Phase C | merged | `agent/pe-trust-phase-c` | yes (in main) | already in main |
| #672 Phase C RLS follow-up | merged | `fix/pe-phase-c-rls-followup` | yes (in main) | already in main |
| #671 Phase D | closed unmerged | `agent/pe-trust-phase-d` | **no** (snapshot yml only) | evidence |
| #676 Phase D v2 | closed unmerged | `agent/pe-trust-phase-d-v2` | **transport only** | decode patch offline; integrate in Phase 1 |
| #678 Phase F | closed unmerged | `agent/pe-trust-phase-f` | **yes** (SAM + watermark helpers) | integrate in Phase 3 |
| #684 Phase G recovery | closed unmerged | `agent/pe-trust-phase-g-recovery` | no G product | evidence only |
| #689 Phase I | closed unmerged | `agent/pe-trust-phase-i` | **no product files** | rebuild in Phase 6 |
| #691 Phase J | closed unmerged | `agent/pe-trust-phase-j` | yes but **touches MeriV2** | Selective extract in Phase 7 only if PE/shared; no MeriV2 file edits |
| #695/#698 Phase K | closed unmerged | `agent/pe-trust-phase-k` | effectively Phase J + docs stub | rebuild gates in Phase 8 |
| #705 Final closeout | open draft | `agent/program-elements-final-closeout` | was transport-only | **this PR — baseline reset in Phase 0** |
| #708 temp Phase F export | closed | `main` | N/A | ignore |

Older historical PE fix PRs (code/search/units/marks/etc.) are already merged to main over time; not reopened.

### 0.4 Recovered artifacts (local, not committed as transport)

| Artifact | Location (operator machine) | Status |
|---|---|---|
| Phase D implementation patch (decoded) | `C:/Users/neoma/AppData/Local/Temp/pe-patches/phase-d-implementation.patch` | **Valid git patch** (gzip+base64 of split parts 00–04). sha256 `070c3e03ed0ba93506f8ee7c2b738cf99785f9bff0fa886b1d3f469c5355a142`. ~3426 lines. Targets writer/ownership/outbox/migration. |
| Phase D correction patches 1–5 | same `.github/phase-d-correction*.patch` | Plain diffs against intermediate trees; **must be rebased/reapplied against current main**, not blindly chained. |
| Phase F product tree | `origin/agent/pe-trust-phase-f` @ `b13568959` + CI zip `pe-phase-f-current-source` (run `30503338995`) | Product paths listed in traceability doc. Includes obsolete temp workflow to **drop**. |
| Phase I CI zip | run `30481064182` artifact | Tree equals main + Phase I **workflows only** — confirms missing product. |
| Final closeout zip | run `30511325568` | Transport era snapshot; no extra product. |
| Incomplete final b64 parts | pre-Phase-0 tip | **Unusable.** Do not commit. |

Phase D product files named inside recovered patch (for Phase 1):

- `apps/api/package.json`
- `apps/api/prisma/migrations/20260729050000_pe_observation_idempotency_and_outbox/migration.sql`
- `apps/api/prisma/schema.prisma`
- `apps/api/scripts/backfill-pe-observation-keys.ts` (+spec)
- `apps/api/scripts/drain-pe-change-outbox.ts` (+spec)
- `apps/api/scripts/entrypoint-dispatcher.inc`
- `apps/api/src/program-element/program-element-change-outbox.service.ts` (+spec)
- `apps/api/src/program-element/program-element-field-ownership.ts` (+spec)
- `apps/api/src/program-element/program-element-raw-merge.ts` (+spec)
- `apps/api/src/program-element/program-element-writer.service.ts` (+spec)
- `apps/api/src/program-element/program-element.module.ts`
- `apps/api/src/program-element/reconciliation/reconciliation.service.ts` (+spec)
- `apps/api/src/program-element/source-priority.ts`
- `apps/api/src/program-element/types.ts`
- `apps/api/tsconfig.pe-phase-a.json`

### 0.5 Temporary workflow / transport removal

Phase 0 branch tip is reset to **current main + ledger docs**. Therefore the following are **absent from the product diff** (and must never return):

- `.github/workflows/program-elements-final-closeout-source.yml`
- `.github/pe-final-v2.part*`
- `.github/program-elements-final-patch.part*`
- `.github/remaining-transfer-instructions.txt`
- `.github/test-small-upload-reference.txt`
- All phase finalize/source snapshot ymls from D/F/I/K branches

### 0.6 Main PE baseline inventory (abbrev.)

**Merged trust phases on main:** A, B, C (+ RLS follow-up). Evidence commits include Phase C merge `#669` / `#672` and Phase B USD-millions / exact-SHA promotion path (e.g. `d31eeb186 feat(defense-budget): add exact-SHA atomic canonical promotion` on ancestry).

**Existing PE verify commands on main (`apps/api/package.json`):**

- `verify:pe-phase-a` → `tsx scripts/verify-pe-phase-a-safety.ts`
- `verify:pe-phase-b` → jest bundle (assertion-mapper, defense-budget-commit, pe-ingestion-mode, replay, source-document registry, …)
- `verify:pe-phase-c` → jest bundle (read service, watch tenant isolation, email watch isolation, writer, tenant-scope-guard, …)
- `diag:pe-trust` → `tsx scripts/diag-program-element-trust-baseline.ts`
- typecheck includes `tsconfig.pe-phase-a.json`

**Not on main:** `verify:pe-phase-d`…`k`, `test:pe-trust`, `typecheck:pe-scripts`, `lint:pe-scripts`.

**PE-related migrations already on main (representative):**  
`20260528085651_add_program_element` … through watches, deltas, budget position, SAM opportunity, defense_budget_packages, pe_watch S3/parse_job, tenant-scoped PE watch key + RLS (`20260728230000`, `20260728230100`).  
**Missing on main:** `20260729050000_pe_observation_idempotency_and_outbox` and any Phase I data-issue tables.

**Absent modules on main (spot check):**  
`program-element-field-ownership.ts`, `program-element-change-outbox.service.ts`.

### 0.7 Pre-existing base failures

Phase 0 does **not** claim a full PE test suite green/red matrix. Commands that are the inheritance gate for later phases exist as A/B/C verifiers above.

Recorded facts:

- Full monorepo install/test was **not** run in Phase 0 (out of scope; no mutation phase).
- CI on transport tip of #705 was green only because diff was empty of product (ci-pr / legiwatch / engagement-trust-boundary / funding-opportunities-ci success around 2026-07-30T03:29Z runs) — **not evidence of PE trust readiness**.
- Phase D finalize Actions (`pe-phase-d-finalize*`, `pe-phase-d-visible`) **failed** repeatedly while `pe-phase-d-source` succeeded (artifact/workflow path only).
- Phase F finalize eventually **succeeded** on product-bearing PR head (run family ~`30451060288`).
- Phase I api-check/finalize workflows **failed**; source workflow succeeded (no product to verify).

Later phases must re-run A–C gates on exact merge-base and compare regressions after each product commit.

### 0.8 Adversarial review (Phase 0)

See `final-closeout-traceability.md` § Adversarial review. Exit criteria checked:

| Gate | Result |
|---|---|
| Clean working tree after commit | required at push |
| Branch synchronized with current main | yes — tip = main + docs |
| No unresolved merge conflict | yes |
| PR #705 no longer relies on local-only implementation claim | yes — documented truth: recovered sources externalized; product unmerged work deferred to Phases 1–8 |
| Every D–L requirement has owner/phase | yes — traceability matrix |
| Independent reviewer confirms ledger matches repo | see adversarial section |

### 0.9 What Phase 0 deliberately did **not** do

- Did not apply Phase D patch (Phase 1).
- Did not cherry-pick Phase F (Phase 3).
- Did not import Phase J MeriV2 edits.
- Did not invent Phase E/G/H/I/K product code.
- Did not run migrations or vendor calls.

---

## Commit history for this phase

| Commit | Message | Message intent |
|---|---|---|
| (this) | `chore(program-elements): establish final closeout baseline` | Ledger + traceability; clean tip on current main |

---



---

## Phase 1 — Deterministic Canonical Write Foundation

### 1.0 First implement (2026-07-30T11:04–11:13Z) — product foundation landed; review FAIL later

**Implementer claimed COMPLETE; independent review 20260730_072939_3c2039 VERDICT FAIL on tip `b8ed28855`.** Unit/logic gates were green; durable script outbox path was broken (B1/B2). Ledger below was dishonest (header said Phase 0 only; Next phase still Phase 1 while body said COMPLETE).

Landed on branch (commits `850b4b7a4`, `b8ed28855`):

- Applied recovered Phase D + correction patches 1–5; no transport `.github/phase-d-*`.
- Field ownership, raw merge, writer/outbox/reconciliation, migration `20260729050000_pe_observation_idempotency_and_outbox`, backfill + drain scripts.
- Gates then: verify:pe-phase-a/b/c/d PASS; tsc pe-phase-a PASS; PGlite 16/16; Docker pg16 disposable migration PASS.

Independent review blocking defects (must fix before any Phase 1 PASS / Phase 2):

| ID | Defect |
|---|---|
| B1 | `ProgramElementChangeOutboxService.processById` called `prisma.withSystem` unconditionally; bare `PrismaClient` has no `withSystem`. `drain-pe-change-outbox.ts` cast bare client with no shim. Drain greps-only masked it. |
| B2 | Writer autowires `new OutboxService(prisma)` when `$transaction` exists; after-commit `processOutboxIds` failed on every script writer client. |
| B3 | Work-log header/Next-phase vs COMPLETE status dishonest. |

### 1.1 Re-implement after review FAIL (this session)

**Status:** IMPLEMENT PUSHED — **independent adversarial review REQUIRED** (implementer does **not** self-PASS exit gate).  
**Base tip before fix:** `b8ed288558b15a441e8465b0e1023a14423ff392`  
**origin/main:** `010948cc3f475dd0ee47016deba5619c044d8fed` (0 behind)  
**Remote tip after fix push:** `454a27f5ee1583a100c0a01761d5e6c970621c80` (product + tests); ledger SHA row may trail by a docs-only follow-up  
**Worktree:** `C:/c/Users/neoma/AppData/Local/Temp/pe-closeout-wt`

#### Code fixes

1. **Outbox client contract** (`program-element-change-outbox.service.ts`):
   - Exported `runPeOutboxSystemTx` / `PeOutboxPrismaLike`.
   - Prefer `withSystem`; else `$transaction` + `set_config('app.bypass_rls','on',true)` (identity-outbox pattern).
   - Fail closed if neither present.
2. **Drain script** (`drain-pe-change-outbox.ts`): `peChangeOutboxPrismaFromClient` withSystem shim; no bare `as PrismaService` cast.
3. **Tests (must fail unfixed B1):**
   - Outbox unit: bare client without `withSystem` → `processById`/`drain` → `processed`.
   - `runPeOutboxSystemTx` prefers withSystem / falls back / throws.
   - Drain spec beyond greps: shim presence + bare-client runtime drain.

Writer autowire path fixed by (1): same OutboxService on bare PrismaClient now drains after commit.

#### Gates re-run this session (on fix tree)

| Command | Result |
|---|---|
| verify:pe-phase-a | PASS (`PE_PHASE_A_B_SAFETY_OK`) |
| verify:pe-phase-b | PASS 7 suites / 111 tests |
| verify:pe-phase-c | PASS 8 suites / 61 tests |
| verify:pe-phase-d | PASS 7 suites / **51** tests (was 43; +bare-client/runtime cases) |
| tsc -p tsconfig.pe-phase-a.json --noEmit | PASS |
| Scope | only outbox + drain + ledgers; no MeriV2; no transport |

#### Not done / forbidden

- Independent review of this tip (separate session).
- Phase 2+ loaders.
- Shared-env migrate, ingestion commit, merge, deploy.

#### Rollback

```bash
git revert 454a27f5ee1583a100c0a01761d5e6c970621c80   # bare-outbox durability fix (+ any docs-only follow-up)
# Full Phase 1 product rollback toward main:
git revert 850b4b7a4 b8ed28855 454a27f5ee   # or reset branch to origin/main and reopen work
```

### Independent review status

| Round | Session | Tip | Verdict |
|---|---|---|---|
| 1 | 20260730_072939_3c2039 | `b8ed28855` | **FAIL** (B1/B2/B3) |
| 2 | PASS artifact `prompts/phase-1-review-PASS.md` | `da36195d3` (product `454a27f5e`) | **PASS** |

Phase 2 started after Phase 1 PASS + main sync `6268e2f2a`.

---

## Phase 2 — Exact-SHA Atomic Loader Contract

### 2.0 Pre-flight

| Item | Value |
|---|---|
| Worktree | `C:/c/Users/neoma/AppData/Local/Temp/pe-closeout-wt` |
| Phase 1 PASS tip | `da36195d3f89c0c7f3a2d4e2e7a1fbb963041358` |
| `origin/main` at Phase 2 base | `3dcb12f823774b6fae8578dc56fc122bf9a0879e` |
| Sync commit before product | `6268e2f2a` — merge main onto closeout tip |
| Base for Phase 2 product | `6268e2f2a` (= main + Phase 0–1) |
| Status | **IMPLEMENT PUSHED** product `d06601b0a` / independent review REQUIRED (no self-PASS) |
| Remote tip after Phase 2 product push | `d06601b0ac4e2f393b946df17224052f1f7933ff` |

### 2.1 Product work

Shared exact-SHA contract + PE dollar loader conversion.

**New**
- `apps/api/scripts/lib/pe-exact-sha-loader-contract.ts` (+spec)
- `apps/api/scripts/verify-pe-phase-e-exact-sha.ts`
- `apps/api/package.json` → `verify:pe-phase-e`

**Loader entrypoints (inspect-first + `--commit --approved-sha256`):**
- R-1 `sync-comptroller-jbooks.ts`
- R-2/R-2A `sync-jbook-r2.ts`
- R-3 performers `sync-jbook-performers.ts`
- P-doc/P-40 `parse-pdoc-army.ts`, `load-pdoc-enrichment.ts`
- O-1/OP-5 `load-om.ts`, `load-om-op5.ts`
- HASC/SASC `parse-hasc-sasc-reports.ts`
- HAC-D/SAC-D `parse-defense-approps-reports.ts`
- NDAA conference `parse-ndaa-conference.ts`
- Public law `parse-defense-approps-public-law.ts`
- Package JSON `load-defense-budget-package.ts`
- Generalized PDF `ingest-defense-budget-pdf.ts` (Phase B retained; inventory + verifier)

**Parser write-context plumbing:** committee-report base + HASC/SASC/approps/conference subclasses; pdoc parser (`PeYearWriteContext` + original unit values).

**Rules enforced**
- Default/`--inspect` → no canonical write; prints SHA + quality + commit requirements
- `--commit` without matching `--approved-sha256` fails pre-mutation
- Quality fail-closed (empty artifact / units anomalies / plan.errors)
- Multi-artifact jbook commit requires single `--artifact`
- `deferSupersede` + post-success `supersedeSourceDocumentHead` on rewritten register paths (failed promotion cannot become live head)
- LlamaParse still extract-only + `--allow-vendor-parse` on PDF path
- No broad post-write provenance stamping; register before promote with deferred supersede

### 2.2 Gates (this session; base `6268e2f2a` + product)

| Command | Result |
|---|---|
| verify:pe-phase-a | PASS `PE_PHASE_A_B_SAFETY_OK` |
| verify:pe-phase-b | PASS 7 suites / 111 tests |
| verify:pe-phase-c | PASS 8 suites / 61 tests |
| verify:pe-phase-d | PASS 7 suites / 51 tests |
| verify:pe-phase-e jest | PASS 3 suites / 71 tests |
| verify-pe-phase-e-exact-sha.ts | PASS 13 loaders |
| parsers + load-defense-budget-package.spec | PASS 6 suites / 67 tests |
| Smoke load-om default | INSPECT only (exit 0) |
| Smoke load-om --commit (no sha) | FAIL closed exit 1 (`--commit requires --approved-sha256`) |
| Migrations / vendor / secrets / shared DB | **not run** |
| MeriV2 product paths | untouched |

No base-proven inherited failures on A–D for this tip.

### 2.3 Not done / forbidden

- Independent adversarial REVIEW (separate session; implementer does **not** self-PASS)
- Phase 3+
- Shared-env migrate, ingestion commit, live LlamaParse, merge, deploy

### 2.4 Rollback

```bash
git revert d06601b0ac4e2f393b946df17224052f1f7933ff
# or hard reset closeout branch product tip to pre-Phase-2 base (destroys unpushed work):
git reset --hard 6268e2f2a1ef3eda906c47e8721c211d95f102a4
```

### Independent review status

| Round | Tip | Verdict |
|---|---|---|
| Phase 2 | `0f47e13f8f5335c306b7ed18b2b292bcd25f482b` (product `d06601b0a`) | **PASS** — `prompts/phase-2-review-PASS.md` |

---

## Phase 3 — Complete-Window and SAM Ingestion Safety

### 3.0 Preflight

| Item | Value |
|---|---|
| Worktree | `C:/c/Users/neoma/AppData/Local/Temp/pe-closeout-wt` |
| Branch | `agent/program-elements-final-closeout` |
| Phase 2 PASS tip (start) | `0f47e13f8f5335c306b7ed18b2b292bcd25f482b` |
| `origin/main` at Phase 3 base | `3dcb12f823774b6fae8578dc56fc122bf9a0879e` |
| Recovered product source | `origin/agent/pe-trust-phase-f` @ `b13568959` (path-limited; not tip-merge) |
| Status | **IMPLEMENT PUSHED** product `1e7825472` / independent review REQUIRED (no self-PASS) |
| Remote tip after Phase 3 product push | `1e78254725626cf623a98951222349e14750d11e` |

### 3.1 Product work (F1–F10)

Integrated Phase F safeguards into current tip **without** regressing main’s post-F Funding Opportunities work (`--all-federal`, CLI window validation, dry-run no SyncRun, backfill separate sources, `errorMessage` on incomplete job errors).

| ID | Implementation |
|---|---|
| F1 | `RunCounts.complete===false` → `statusFromCounts` = `partial` |
| F2 | `lastSuccessfulWatermark` still only reads `status='success'`; partial/success_with_errors never advance floor |
| F3 | `syncSourceForScope(scope, backfill)` → `…-backfill` per DoD / all-federal (main naming retained, not F’s `:` form) |
| F4–F6 | `collectSamWindowRecords` + `splitSamWindow` recursive split; noticeId global dedupe; single-day overflow = incomplete |
| F7 | `fetchPage` / `resolveSamDescription`: timeout, HTTPS, sam.gov host allowlist, private-IP block, size limit, API-key redaction |
| F8 | `persistMatches` leaves accepted/rejected untouched; same-basis candidate refreshes confidence only |
| F9 | Opportunity upsert + match writes inside `prisma.$transaction` |
| F10 | No temp `.github/workflows/pe-phase-f-current-source.yml` brought onto branch |

Also retained main behavior:
- Dry-run never opens SyncRun / never moves watermark (`lastSuccessfulWatermark` for window report only).
- Main `RunCounts.errorMessage` (e.g. geocode-facilities) still persists on `success_with_errors`.
- Description URLs are not scanned as PE-match text (`descriptionForMatching`).

**Touched paths**
- `apps/api/src/ingestion/embed-watermark.ts` (+spec)
- `apps/api/src/ingestion/sync-run.helper.ts` (+spec)
- `apps/api/scripts/sync-sam-opportunities.ts` (+spec)
- `apps/api/tsconfig.pe-phase-f.json` (new)
- `apps/api/package.json` → `verify:pe-phase-f`

### 3.2 Gates (this session; base tip `0f47e13f8`)

| Command | Result |
|---|---|
| `pnpm run verify:pe-phase-f` | PASS 4 suites / 89 tests |
| `pnpm exec tsc -p tsconfig.pe-phase-f.json --noEmit` | PASS exit 0 |
| `pnpm run verify:pe-phase-a` | PASS `PE_PHASE_A_B_SAFETY_OK` |
| `pnpm run verify:pe-phase-b` | PASS 7 suites / 111 tests |
| `pnpm run verify:pe-phase-d` | PASS 7 suites / 51 tests |
| `pnpm run verify:pe-phase-e` | PASS 3 suites / 71 tests + 13 loaders static |
| verify:pe-phase-c | not re-run this session (Phase 3 did not touch watch/read/RLS paths; A/B/D/E green) |
| Shared DB migrate / SAM network / secrets / LlamaParse / email | **not run** |
| MeriV2 product paths | untouched |
| Transport / pe-phase-f-current-source workflow | absent from diff |

No base-proven inherited failures introduced on A/B/D/E/F for this tip.

### 3.3 Not done / forbidden

- Independent adversarial REVIEW (separate session; implementer does **not** self-PASS)
- Phase 4+
- Live SAM.gov calls, Secrets Manager pulls, shared-env ingestion commit, merge, deploy

### 3.4 Rollback

```bash
git revert 1e78254725626cf623a98951222349e14750d11e
# or hard reset closeout branch to Phase 2 PASS tip:
git reset --hard 0f47e13f8f5335c306b7ed18b2b292bcd25f482b
```

### Independent review status (Phase 3)

| Round | Tip | Verdict |
|---|---|---|
| Phase 3 | `0a74cf9a3220cea05d0666e41a0c88e75cb99929` (product `1e7825472`) | **PASS WITH BLOCKERS** — `prompts/phase-3-review-PASS.md` (B1 search size cap polish, B2 F9 TX unit lock residual; non-gating) |

---

## Phase 4 — Current-Cycle, Track-Aware Read Contract

### 4.0 Preflight

| Item | Value |
|---|---|
| Worktree | `C:/c/Users/neoma/AppData/Local/Temp/pe-closeout-wt` |
| Branch | `agent/program-elements-final-closeout` |
| Phase 3 PASS tip (start) | `0a74cf9a3220cea05d0666e41a0c88e75cb99929` |
| `origin/main` at Phase 4 base | `3dcb12f823774b6fae8578dc56fc122bf9a0879e` |
| Prior G product on origin | **none** (rebuild) |
| Status | **FAIL remediated IMPLEMENT** (B1–B4) / independent review REQUIRED on new tip (no self-PASS) |
| Remote tip after Phase 4 product push | `19936afde2b8d3902902996af02fa710f7f63356` |

### 4.1 Product work (G1–G12)

Built the missing Phase G **FundingClaim** contract (recovery branch had no G files) and wired primary PE read paths.

| ID | Implementation |
|---|---|
| G1 shared funding claim | `packages/shared/src/funding-claim.ts` — `FundingClaim` = value, fiscalYear, stage, stageLabel, legislativeVehicle, cycleClass, isProjection, unit |
| G2 zero preservation | `selectLatestPreservingZero`, SQL laterals drop `<> 0` on request/enacted picks; zero marks count for currentCycleFy |
| G3 no latest-nonzero | Replaced capability `request <> 0 ORDER BY fy DESC` and finder laterals that skipped zeros |
| G4 stage/vehicle separation | Fine vehicles: request / authorization / appropriations / authorization_conference / appropriations_conference / enacted; NDAA vs approps conference never share track |
| G5 separate tracks on timeline | `missingMarks` + `fundingClaim` on getTimeline years; dual-track missing taxonomy |
| G6 no cross-FY % | `listEnactedVsRequestDeltaPct` + `requestAtEnactedFy` matched pair; bare latestRequest never % base |
| G7 movement KPIs + population | `getSummary.movementCoverage` {populationSize, contributedCount, missingCount, disclosure}; money pairs include zero request |
| G8 capability one FY + coverage | `listCapabilities` pins catalog mode FY; `requestCoverage` + `requestClaim`; zeros included in SUM |
| G9 contractor evidence classes | `getContractors.evidenceBuckets` via `partitionContractorEvidence` (accepted_direct / candidate / unmatched_dollars) |
| G10 missing-mark taxonomy | `classifyMissingMark` → present \| not_applicable \| not_started \| candidate_gap \| unknown_coverage |
| G11 current request ≠ outyear | `isProjection` / cycleClass on claim; outyear never `cycleClass==='current'` |
| G12 gate | `verify:pe-phase-g` + `tsconfig.pe-phase-g.json` |

**Touched paths**
- `packages/shared/src/funding-claim.ts` (new) + `./funding-claim` package export + index pointer comment
- `apps/api/src/program-element/funding-claim.helpers.ts` (+spec)
- `apps/api/src/program-element/program-element-read.service.ts` (+spec Phase G case)
- `apps/api/src/program-element/budget-lines-read.service.ts`
- `apps/api/package.json` → `verify:pe-phase-g`
- `apps/api/tsconfig.pe-phase-g.json`

### 4.2 Gates (this session; base tip `0a74cf9a3`)

| Command | Result |
|---|---|
| `pnpm -C packages/shared run build` | PASS (emits funding-claim.js) |
| `pnpm run verify:pe-phase-g` | PASS 5 suites / 76 tests |
| `pnpm exec tsc -p tsconfig.pe-phase-g.json --noEmit` | PASS exit 0 |
| `pnpm run verify:pe-phase-a` | PASS `PE_PHASE_A_B_SAFETY_OK` |
| `pnpm run verify:pe-phase-b` | PASS 7 suites / 111 tests |
| `pnpm run verify:pe-phase-c` | PASS 8 suites / 62 tests |
| `pnpm run verify:pe-phase-d` | PASS 7 suites / 51 tests |
| `pnpm run verify:pe-phase-e` | PASS 3 suites / 71 tests + 13 loaders static |
| `pnpm run verify:pe-phase-f` | PASS 4 suites / 89 tests |
| Shared DB migrate / vendor / secrets / email / LlamaParse | **not run** |
| MeriV2 product paths | untouched |
| Transport blobs | absent |

No base-proven inherited failures introduced on A–F for this tip.

### 4.3 Not done / forbidden

- Independent adversarial REVIEW (separate session; implementer does **not** self-PASS)
- Phase 5+ UX trust header work
- Phase 3 residual polish B1/B2 (search response-size / F9 TX unit lock) — optional, non-gating per Phase 3 PASS
- Live data / migrate / merge / deploy

### 4.4 Rollback

```bash
# after product SHA is known on origin — revert that commit
git revert 19936afde2b8d3902902996af02fa710f7f63356
# or hard reset closeout branch to Phase 3 PASS tip:
git reset --hard 0a74cf9a3220cea05d0666e41a0c88e75cb99929
```

### Independent review status (Phase 4)

| Round | Tip | Verdict |
|---|---|---|
| Phase 4 product | `19936afde2b8d3902902996af02fa710f7f63356` | implement |
| Phase 4 remote tip | `2657c64ac1febbf1212272374525c6f545e6c527` | **PENDING** review (no self-PASS) |

---


### 4.5 Independent review Round 1 FAIL + remediations

| Item | Value |
|---|---|
| FAIL tip (review Round 1) | `cf87ee77a1eeea3e989b4bdf80e1a8cdcd3edec4` (docs pin) / product `19936afde` |
| Verdict artifact | `pe-closeout/prompts/phase-4-review-FAIL.md` |
| Blocking | B1 markup-monitor cross-track `divergencePct`; B2 list bare latestRequest delta base + FY remap nulled correct ler %; B3 timeline `currentCycleFy` omitted `ndaaConference` |
| Non-gating polish | B4 empty capability fabricated $0 `requestClaim` → null |

**Product fixes (this push):**

| ID | Fix |
|---|---|
| B1 | `listMarkupMonitor` per-track auth (HASC↔SASC) and approps (HAC-D↔SAC-D) %; headline `divergencePct` = max-within-track + `divergenceTrack`; pure `markupMonitorTrackDivergence` + TS remap so poisoned SQL cannot blend |
| B2 | SQL exposes `requestAtEnactedFy` (ler); `listEnactedVsRequestDeltaPct` drives `deltaPct`; `comparableEnactedVsRequest` matched pair; no bare latestRequest as % base; correct ler % kept when catalog request FY differs |
| B3 | `getTimeline` uses `currentCycleFyPreservingZero` including `ndaaConference`; `sqlCurrentCycleFyExpr` includes `ndaa_conference` |
| B4 | `listCapabilities` `requestClaim` null when lineCount=0 |

**Tests:** funding-claim B1/B2/B3 pure attacks; read.service B1 adversarial markup remap; B2 cross-FY list; B3 NDAA-only timeline.

### 4.6 Gates (FAIL-remediation session; base fail tip `cf87ee77a`)

| Command | Result |
|---|---|
| `pnpm --filter @capiro/shared build` | PASS |
| `pnpm --filter @capiro/api run verify:pe-phase-g` | PASS 5 suites / **82** tests |
| `npx tsc -p tsconfig.pe-phase-g.json --noEmit` (apps/api) | PASS exit 0 |
| `verify:pe-phase-a` … `f` | PASS (a safety OK; b 111; c 65; d 51; e 71+13 loaders; f 89) |
| controller program-element.spec | PASS 24 |
| Shared migrate / vendor / secrets / email / LlamaParse | **not run** |
| MeriV2 product paths | untouched |
| Transport blobs | absent |

Implementer does **not** self-PASS the Phase 4 exit gate. Independent REVIEW required on the new remote tip after this product commit.

### Independent review status (Phase 4) — updates through FAIL remediations

| Round | Tip | Verdict |
|---|---|---|
| Phase 4 product (initial) | `19936afde2b8d3902902996af02fa710f7f63356` | implement |
| Review Round 1 | `cf87ee77a1eeea3e989b4bdf80e1a8cdcd3edec4` | **FAIL** B1/B2/B3 (B4 polish) |
| Phase 4 product (FAIL remediations) | `2adb5581ac9151bcbd763029228b7fb5feeb2392` | implement; review REQUIRED |

### 4.7 Rollback

```bash
# after product SHA known on origin — revert that commit, or:
git reset --hard cf87ee77a1eeea3e989b4bdf80e1a8cdcd3edec4
# full drop of Phase 4 product back to Phase 3 PASS:
git reset --hard 0a74cf9a3220cea05d0666e41a0c88e75cb99929
```

---

### 4.8 FAIL Round 2 → remediations B5–B7 (this push)

| Item | Value |
|---|---|
| FAIL tip (review Round 2) | `13cb22c537ab9bc8340486d88aa1c0de5a5a8e86` (docs pin) / prior product `2adb5581a` |
| Verdict artifact | operator FAIL inject (B5 list cycle anchor, B6 detail NDAA-blind fundingSummary, B7 markup max-fy cycle) |
| Prior Round 1 FAIL closed | B1 track-separate markup; B2 matched-pair list delta; B3 timeline NDAA; B4 empty capability null claim |

**Product fixes (this push):**

| ID | Fix |
|---|---|
| B5 | Finder list claims use SQL `peCurrentCycleFy` via `sqlCurrentCycleFyExpr` (mark-bearing, incl NDAA); never `latestCurrentFy ?? latestRequestFy`. Outyear request/current → `cycleClass: outyear`, `isProjection: true` |
| B6 | `getProgramElement` `fundingSummary` uses `currentCycleFyPreservingZero` (incl NDAA), matching `getTimeline`. `currentCycleFyOf` aligned to include `ndaaConference` so default render/outreach cannot NDAA-blind disagree |
| B7 | `listMarkupMonitor` `current_cycle` joins PE cycle FY from `sqlCurrentCycleFyExpr` (`pe_cycle` CTE), not `DISTINCT ON … ORDER BY fy DESC` |

**Tests:** funding-claim B5/B6 pure; read.service B5 list outyear claims; B6 detail fundingSummary NDAA labels; B7 markup SQL contains `pe_cycle`/`ndaa_conference` and not bare max-fy ORDER.

### 4.9 Gates (FAIL Round-2 remediation; vs tip `13cb22c53`)

| Command | Result |
|---|---|
| `pnpm --filter @capiro/shared build` | PASS |
| `pnpm --filter @capiro/api run verify:pe-phase-g` | PASS 5 suites / **87** tests |
| `npx tsc -p tsconfig.pe-phase-g.json --noEmit` (apps/api) | PASS exit 0 |
| Shared migrate / vendor / secrets / email / LlamaParse | **not run** |
| MeriV2 product paths | untouched (only shared `currentCycleFyOf` alignment — no meriv2 source edits) |
| Transport blobs | absent |

Implementer does **not** self-PASS the Phase 4 exit gate. Independent REVIEW required on the **new** remote tip after this product commit (re-attack B5/B6/B7 and hold B1–B3).

### Independent review status (Phase 4) — through Round-2 FAIL remediations

| Round | Tip | Verdict |
|---|---|---|
| Phase 4 product (initial) | `19936afde2b8d3902902996af02fa710f7f63356` | implement |
| Review Round 1 | `cf87ee77a1eeea3e989b4bdf80e1a8cdcd3edec4` | **FAIL** B1/B2/B3 (B4 polish) |
| Phase 4 product (FAIL R1 remediations) | `2adb5581ac9151bcbd763029228b7fb5feeb2392` | implement |
| Docs pin R1 product | `13cb22c537ab9bc8340486d88aa1c0de5a5a8e86` | **FAIL** Round 2 B5/B6/B7 |
| Phase 4 product (FAIL R2 remediations B5–B7) | `5e83b8946148c91977bd4da7a4888bb94f33a642` | implement; review REQUIRED |

### Rollback (includes this remediation)

```bash
# drop B5–B7 product + docs pin of this tip; return to Round-2 FAIL tip:
git reset --hard 13cb22c537ab9bc8340486d88aa1c0de5a5a8e86
# full drop of Phase 4 product back to Phase 3 PASS:
git reset --hard 0a74cf9a3220cea05d0666e41a0c88e75cb99929
```

---

## Phase 5 — Trust-First Program Elements Web Experience

**Operator session:** Phase 5 IMPLEMENT only (not review)  
**Mode:** LONG  
**Base remote tip (Phase 4 PASS WITH BLOCKERS):** `7bca3b506d992d49978821fb84946eae162e8db7`  
**origin/main at implement:** `3dcb12f823774b6fae8578dc56fc122bf9a0879e` (0 behind)

### Goal
Complete Phase H against the Phase 4 read contract: trust header, explicit load states, deep-link tab+FY, lazy tabs, no projected-enacted substitution, zeros preserved, copy-with-citation, honest proof-pack/P-40 language, match-scope attributes, keyboard related-line nav, no fabricated personnel estimates.

### Tasks completed (implementer)

| ID | Work |
|---|---|
| H1 | `PeTrustHeader` — PE mark-bearing current FY, stage, vehicle, verification time, source coverage chips, reconciliation conflict tag, caveats drawer, copy claim with citation |
| H2 | `PeLoadState` + `resolvePeSurfaceState` — loading / failed+retry / not_found / not_ingested / unsupported / partial / complete |
| H3 | URL deep-link `?tab=&fy=` restore via `useSearchParams`; writing on tab/FY change |
| H4 | Lazy secondary queries: `peWatchQueryEnabled` — hidden tabs do not fetch sources/personnel/contractors/provisions on initial overview |
| H5 | Removed projected-enacted substitution in `toHistoryRow` + `FyHistoryChart.toChartPoint` (null enacted stays null; tooltip never "Enacted (Projected)" from request) |
| H6 | Zero preservation in chart points + sparklines (filter null only, not `!== 0`) |
| H7 | Proof pack: sha256 labeled as ingested-byte fingerprint, not archive receipt |
| H8 | P-40 source FY from exhibit metadata (`formatPdocSourceLine`); line item / appropriation ids; keyboard related-PE buttons |
| H9 | Linked lines rail: keyboard + aria-label navigation |
| H10 | Provisions: `matchScope` + `attributionCaveat` display |
| H11 | Program team: removed fabricated `~N known` / `estimatedTotal` inflation |
| H12 | Web list types: Phase 4 claim bags (`currentClaim`, `requestAtEnactedClaim`, `comparableEnactedVsRequest`, …) |
| H13 | Theme: `.pe-trust-header`, related-PE link focus styles |

### Files (product)

- `apps/web/src/pages/program-element/trust-model.ts` (+test)
- `apps/web/src/pages/program-element/PeTrustHeader.tsx`
- `apps/web/src/pages/program-element/PeLoadState.tsx`
- `apps/web/src/pages/program-element/ProgramElementWatchPage.tsx` (+test)
- `apps/web/src/pages/program-element/FyHistoryChart.tsx` (+test)
- `apps/web/src/pages/program-element/ProofPackPanel.tsx` (+test)
- `apps/web/src/pages/program-element/PdocDetailPanel.tsx`
- `apps/web/src/pages/program-element/ProgramTeamPanel.tsx` (+test)
- `apps/web/src/pages/program-element/ProvisionsPanel.tsx`
- `apps/web/src/pages/program-element/BudgetLinePanels.tsx`
- `apps/web/src/pages/program-element/types.ts`
- `apps/web/src/theme.css`
- ledger docs

### Gates (implement local)

| Command | Result |
|---|---|
| vitest PE trust suite (6 files, 41 tests) | PASS |
| `pnpm --filter web run build` (production) | PASS |
| `pnpm --filter @capiro/api run verify:pe-phase-g` | PASS 5/87 |
| `pnpm --filter @capiro/api run verify:pe-phase-a` | PASS `PE_PHASE_A_B_SAFETY_OK` |
| Shared migrate / vendor / secrets / email / LlamaParse / browser visual matrix | **not run** (no disposable browser matrix in this session; pure layout CSS + a11y attributes added) |
| MeriV2 product paths | untouched |
| Transport blobs | absent |

### Migrations / data ops
None.

### Non-gating residuals / known limits
- Browser smoke at desktop/tablet/mobile widths not executed here (no headed browser gate); CSS is responsive flex wrap — REVIEW should note if visual gate is required for PASS.
- Catalog `detail.currentCycleFy` remains mode-request FY (Phase 4 R1); trust strip prefers PE mark-bearing cycle via shared helper and discloses catalog mismatch in caveats.
- Open reconciliation conflict count only displays when API sets `openReconciliationConflictCount` (defaults 0 / "no open conflicts reported").
- Phase 3 SAM B1/B2 polish still optional.

### Independent review status (Phase 5) — prior tip `e7ffe8b76`
Prior independent review **VERDICT: FAIL** (B1 browser smoke, B2 secondary isError dark, B3 complete_empty dead).
Superseded by FAIL-remediation implement below (new tip after push).

### Rollback (prior Phase 5 first tip)

```bash
git reset --hard 7bca3b506d992d49978821fb84946eae162e8db7
```

---

## Phase 5 FAIL remediation — Trust-first web (re-implement after review FAIL)

**When:** 2026-07-30 19:49 UTC
**Operator session:** Phase 5 IMPLEMENT only (FAIL inject for B1/B2/B3; not review)
**Mode:** LONG
**Base (failed tip):** `e7ffe8b76a8496e9846fb9a59002142d26b03546`
**Product tip (this remediation):** `9381d154c2869e5db995f16b968d2a41422d3deb`
**origin/main at implement:** `3dcb12f823774b6fae8578dc56fc122bf9a0879e` (0 behind / 21 ahead pre-push)

### Blocking defects closed

| ID | Fix |
|---|---|
| B2 | Every enabled secondary bucket `isError` participates in `secondaryFailed` via `anyEnabledSecondaryFailed`. Per-panel `errored` + `PeSecondaryFailed` (Retry) — never `data ?? []` success Empty on isError. Tests force personnel + provisions reject → failed UI + Partial banner. |
| B3 | `resolvePeSurfaceState` + `yearsHaveStageValue`: yearCount===0 → `not_ingested`; years present all stages null → `complete_empty`; any stage incl $0 → `complete_with_data`. Unit tests; Watch banner `pe-banner-complete-empty`. |
| B1 | Viewport smoke: `pe-watch-viewport-smoke.test.tsx` desktop 1280 / tablet 768 / mobile 375 — trust header, tabs, caveats open, deep-link `tab=funding&fy=2027`. 3/3 PASS. |
| B5 (opt) | FyHistoryChart tooltip fixture no longer tautology; asserts null-enacted / `projected:false` never paint Enacted (Projected) or `[projected]`. |
| B6 (opt) | `latestMeaningful` keeps explicit $0 (no longer skips `num===0`). |
| B4 | Deferred (Finder deltaPct / claim bags UI still type-level; not exit-gating). |

### Files

- `apps/web/src/pages/program-element/trust-model.ts` (+test)
- `apps/web/src/pages/program-element/PeSecondaryFailed.tsx` (new)
- `apps/web/src/pages/program-element/ProgramElementWatchPage.tsx` (+test)
- `apps/web/src/pages/program-element/pe-watch-viewport-smoke.test.tsx` (new)
- Secondary panels: ProgramTeam, Contractors, Provisions, Related, Proof, Projects, Programs, ClientRelevance, WhatChanged, ProcurementActivity, Bills, BudgetLinePanels (actions/relationships/incumbents)
- `FyHistoryChart.test.tsx`

### Gates (implement local)

| Command | Result |
|---|---|
| vitest PE trust suite (6 files) | **62/62 PASS** |
| vitest pe-watch-viewport-smoke | **3/3 PASS** (1280 / 768 / 375) |
| `pnpm --filter @capiro/web run build` | **PASS** (vite ~24s) |
| Migrations / secrets / MeriV2 / email / LlamaParse / shared migrate | not run |
| Scope bleed | web PE panels + ledgers only |

### Migrations / data ops
None.

### Independent review status (Phase 5)
**IMPLEMENT PUSHED — independent adversarial REVIEW REQUIRED** on remote tip `9381d154c2869e5db995f16b968d2a41422d3deb`.
Implementer does **not** self-PASS. Do **not** start Phase 6.

### Rollback

```bash
# return to Phase 5 FAIL tip (pre-remediation):
git reset --hard e7ffe8b76a8496e9846fb9a59002142d26b03546
# or Phase 4 PASS tip:
git reset --hard 7bca3b506d992d49978821fb84946eae162e8db7
```

---

## Phase 5 FAIL remediation r2 — B8–B11 overview/procurement success-Empty on isError

**When:** 2026-07-30 20:28 UTC
**Operator session:** Phase 5 IMPLEMENT only (FAIL inject B8–B11; not review)
**Mode:** LONG
**Base (failed tip after prior review):** `e08797811cbaa1af0ae12c991aba52afd619e4c0` / product `9381d154c2869e5db995f16b968d2a41422d3deb`
**Product tip (this remediation):** `4e2abed9ba5a03acdfbdef6b47ec0be1d2fe3ba3`
**origin/main at implement:** `3dcb12f823774b6fae8578dc56fc122bf9a0879e` (0 behind / 23 ahead pre-product)

### Blocking defects closed

| ID | Fix |
|---|---|
| B8 | Overview `BudgetActionsFeed` now gets `errored={actionsQuery.isError}` + `onRetry`; data cleared on error. Test: actions 500 → `pe-secondary-failed-actions`, no "No recorded budget actions". |
| B9 | `LinkedLinesRail` gains `errored`/`onRetry` + `PeSecondaryFailed`; overview wires relationships isError. Test: relationships 500 → no "No linked lines yet". |
| B10 | Overview Recent activity branches on `billsQuery.isLoading` / `isError` before empty. Test: bills 500 → `pe-secondary-failed-recent-activity`, no "No dated legislative actions yet." |
| B11 | `SecondaryDistributionPanel` errored path + Watch page wires `procurementLinesQuery.isError`. Panel unit + page test (PROC line → Procurement detail tab). Never honesty Empty on error. |

Note: Partial banner alone was already ORing secondary failures; section bodies still painted success Empty — fixed at body level.

### Files

- `apps/web/src/pages/program-element/BudgetLinePanels.tsx` (`LinkedLinesRail` failed path)
- `apps/web/src/pages/program-element/SecondaryDistributionPanel.tsx` (+test)
- `apps/web/src/pages/program-element/ProgramElementWatchPage.tsx` (+test B8–B11)
- ledger docs

### Gates (implement local)

| Command | Result |
|---|---|
| vitest PE trust suite (7 files) | **51/51 PASS** (incl. 4 new B8–B11 + prior B2/B3) |
| `pnpm --filter @capiro/web` / `apps/web` `run build` | **PASS** (vite ~24s) |
| Migrations / secrets / MeriV2 / email / LlamaParse / shared migrate | not run |
| Scope bleed | web PE overview/procurement panels + ledgers only |

### Migrations / data ops
None.

### Independent review status (Phase 5)
**IMPLEMENT PUSHED — independent adversarial REVIEW REQUIRED** on the **new product tip after push** (not self-PASS). Close Gate #4 only if B8–B11 cannot reproduce success-Empty on 500. Do **not** start Phase 6.

### Rollback

```bash
# return to tip that failed B8–B11 review:
git reset --hard e08797811cbaa1af0ae12c991aba52afd619e4c0
# or prior Phase 5 product only:
git reset --hard 9381d154c2869e5db995f16b968d2a41422d3deb
```

---

## Phase 5 FAIL remediation r3 — B12 FundingNarrativePanel isError (failed ≠ stages Empty)

**When:** 2026-07-30 21:12 UTC
**Operator session:** Phase 5 IMPLEMENT only (FAIL inject B12; not review)
**Mode:** LONG
**Base (failed tip after B8–B11 review):** `eafbfb2c0e848a0f692fd8b69950766a8e1277b5` / product `4e2abed9ba5a03acdfbdef6b47ec0be1d2fe3ba3`
**Product tip (this remediation):** `c8ac942b93d299ccb5fa7e704e76ebac2937580d`
**origin/main at implement:** `3dcb12f823774b6fae8578dc56fc122bf9a0879e` (0 behind)

### Blocking defect closed

| ID | Fix |
|---|---|
| B12 | Lift narrative fetch into Watch page with `q('narrative')` (funding-tab only); `FundingNarrativePanel` accepts `data/loading/errored/onRetry` and branches `isError` → `PeSecondaryFailed` testId `pe-secondary-failed-narrative` + Retry. Never stages Empty (“No current-cycle funding stages recorded…”) on failure. Fold into `anyEnabledSecondaryFailed` + Partial banner + bulk refetch. Test: Funding tab + `/narrative` 500 → failed UI; stages Empty copy ABSENT; `/narrative` not fetched on overview cold start. |

### Files

- `apps/web/src/pages/program-element/FundingNarrativePanel.tsx`
- `apps/web/src/pages/program-element/ProgramElementWatchPage.tsx` (+test B12)
- `apps/web/src/pages/program-element/trust-model.ts` (+test narrative bucket)
- ledger docs

### Gates (implement local)

| Command | Result |
|---|---|
| vitest PE trust suite (9 files) | **77/77 PASS** (incl. B12 + prior B2/B3/B8–B11) |
| `apps/web` `run build` (tsc + vite) | **PASS** (vite ~26s) |
| Migrations / secrets / MeriV2 / email / LlamaParse / shared migrate | not run |
| Scope bleed | web PE funding narrative path + trust-model bucket + ledgers only |

### Migrations / data ops
None.

### Independent review status (Phase 5)
**IMPLEMENT PUSHED — independent adversarial REVIEW REQUIRED** on the **new product tip after push** (not self-PASS). Close Gate #4 only if B12 cannot reproduce stages Empty on narrative 500, and prior B2/B8–B11 still hold. Do **not** start Phase 6.

### Rollback

```bash
# return to tip that failed B12 review:
git reset --hard eafbfb2c0e848a0f692fd8b69950766a8e1277b5
# or prior B8–B11 product only:
git reset --hard 4e2abed9ba5a03acdfbdef6b47ec0be1d2fe3ba3
```

---

## Phase 5 FAIL remediation r4 — re-verify B12 + optional B13 queryTab clamp

**When:** 2026-07-30 22:40 UTC  
**Operator session:** Phase 5 IMPLEMENT only (FAIL inject B12; not review)  
**Mode:** LONG  
**Base (failed tip after B8–B11 review):** `eafbfb2c0e848a0f692fd8b69950766a8e1277b5` / product `4e2abed9ba5a03acdfbdef6b47ec0be1d2fe3ba3`  
**Prior B12 product (already on branch before this session):** `c8ac942b93d299ccb5fa7e704e76ebac2937580d` (docs pin `88921392c`)  
**Product tip (this remediation):** `af09ca8517d40b53df271e0a8ac3e6aad47bc580`  
**origin/main at implement:** `3dcb12f823774b6fae8578dc56fc122bf9a0879e` (0 behind)

### Finding

Independent review FAIL inject named B12 against tip `eafbfb2c0` / product `4e2abed9b`. Worktree at session start already contained B12 product `c8ac942b9` + docs pin `88921392c` on `origin/agent/program-elements-final-closeout` (0 behind main / 29 ahead). This session **re-verified** B12 gates and closed residual **B13** (non-gating alone, optional in FAIL list).

### Defects closed this push

| ID | Fix |
|---|---|
| B12 | Re-verified only (no code delta vs `c8ac942b9`): narrative query lifted to Watch page; `FundingNarrativePanel` `errored` → `PeSecondaryFailed` testId `pe-secondary-failed-narrative`; Partial OR; test ABSENT stages Empty. |
| B13 | Secondary `q()` enablement now uses `effectivePeWatchTab(activeTab, lineTypeFromDetail)` so RDTE deep-link `?tab=procurement` does not sticky-fetch `/procurement-lines` while Tabs paint overview. Shared helper + unit + page test. |

### Files

- `apps/web/src/pages/program-element/trust-model.ts` (+test)
- `apps/web/src/pages/program-element/ProgramElementWatchPage.tsx` (+test B13)
- ledger docs

### Gates (implement local)

| Command | Result |
|---|---|
| vitest `src/pages/program-element/` | **153/153 PASS** (B12 + B13 + prior B2/B3/B8–B11 + viewport) |
| `apps/web` `run build` (tsc + vite) | **PASS** (vite ~27s) |
| Migrations / secrets / MeriV2 / email / LlamaParse / shared migrate | not run |
| Scope bleed | PE web trust tab clamp + B12 re-verify + ledgers only |

### Migrations / data ops
None.

### Independent review status (Phase 5)
**IMPLEMENT PUSHED — independent adversarial REVIEW REQUIRED** on the **new product tip after push** (not self-PASS). Gate #4 still requires B12 cannot reproduce stages Empty on narrative 500 and prior B2/B8–B11 still hold. B13 is residual polish unless reviewer reopens lazy-tab enablement. Do **not** start Phase 6.

### Rollback

```bash
# return to pre-r4 tip (B12 only, docs pin):
git reset --hard 88921392c7e35973eb2a1f96d28c18733cd13950
# or tip that failed B12 review:
git reset --hard eafbfb2c0e848a0f692fd8b69950766a8e1277b5
```

---


## Phase 5 FAIL remediation r5 — B14 intelligence body + B15 billActions failed≠empty

**When:** 2026-07-30 (UTC session)  
**Operator session:** Phase 5 IMPLEMENT only (FAIL inject B14/B15; not review)  
**Mode:** LONG  
**Base (FAILED review tip):** `77fd4182dca94a51b68b8c9b22ac24ce3b0c9df7` (product r4 `af09ca8517d40b53df271e0a8ac3e6aad47bc580`)  
**Product tip (this remediation):** `3f4c19c6bba9492f82f7344bb703ec92a40cd098`  

### Finding

Independent review FAIL on tip `77fd4182d` closed B2/B3/B8–B13 but reopened Gate #4:

- **B14:** `intelligenceQuery` featured in Partial OR and enabled nearly every tab, yet `MaturityLadderPanel` / `AppropriabilityPanel` received only data without `errored`. On `/intelligence` 500, bodies painted derivation-pending Empty ("not yet computed/scored").
- **B15:** `historyEvents = billActionsQuery.data ?? []` silently recovered from `/bill-actions` 500; Legislation Action history showed "No action history synced yet" without `PeSecondaryFailed`.

Inventory rule applied: Partial banner alone never counts when a visible secondary body still success-Empties.

### All PE Watch secondary useQueries (r5 inventory)

| bucket | query | enabled tabs (TAB_QUERY_MAP) | failed body path |
|---|---|---|---|
| bills | billsQuery | overview + most | Recent activity + BillsTouchingPePanel |
| intelligence | intelligenceQuery | nearly all | MaturityLadder + Appropriability (B14) |
| sources | sourcesQuery | proof | Proof sources panel |
| contractors | contractorsQuery | incumbents | ContractorsPanel |
| personnel | programTeamQuery | team | roster/confidence charts + ProgramTeamPanel |
| programs | programsQuery | relationships | ProgramsPanel |
| clientRelevance | clientRelevanceQuery | proof | ClientRelevancePanel |
| deltas | deltasQuery | proof | deltas panel |
| projects | projectsQuery | overview (RDTE) | ProjectsPanel |
| related | relatedQuery | relationships | RelatedPesPanel |
| provisions | provisionsQuery | legislation | ProvisionsPanel |
| opportunities | opportunitiesQuery | legislation | ProcurementActivityPanel |
| procurementLines | procurementLinesQuery | procurement | SecondaryDistributionPanel |
| actions | actionsQuery | overview/legislation | BudgetActionsFeed |
| relationships | relationshipsQuery | overview/relationships | LinkedLinesRail / graph |
| incumbents | incumbentsQuery | incumbents | IncumbentMapPanel |
| billActions | billActionsQuery | overview + legislation | Bills panel action history (B15) |
| narrative | narrativeQuery | funding | FundingNarrativePanel |

### Defects closed this push

| ID | Fix |
|---|---|
| B14 | `MaturityLadderPanel` / `AppropriabilityPanel` gain `errored`/`onRetry`; on `intelligenceQuery.isError` mounting sites pass failed UI with testIds `pe-secondary-failed-intelligence-maturity` / `pe-secondary-failed-intelligence-appropriability`. Never derivation-pending Empty on HTTP error. Partial OR already included intelligence. |
| B15 | Do not coalesce `billActionsQuery.data ?? []` on error; pass `billActionsErrored` + retry into `BillsTouchingPePanel`; Action history paints `pe-secondary-failed-bill-actions` instead of "No action history synced yet." Partial OR already included billActions. |

### Files

- `apps/web/src/pages/program-element/BudgetLinePanels.tsx`
- `apps/web/src/pages/program-element/BillsTouchingPePanel.tsx`
- `apps/web/src/pages/program-element/ProgramElementWatchPage.tsx`
- `apps/web/src/pages/program-element/ProgramElementWatchPage.test.tsx` (B14/B15 + setupApi `/bill-actions` before `/bills`)
- ledger docs

### Gates (implement local)

| Command | Result |
|---|---|
| vitest `src/pages/program-element/` | **155/155 PASS** (B14/B15 + hold B2/B8–B13) |
| `apps/web` `run build` (tsc + vite) | **PASS** (~25s) |
| Migrations / secrets / MeriV2 / email / LlamaParse / shared migrate | not run |
| Scope bleed | PE Watch failed≠empty B14/B15 + tests + ledgers only |

### Migrations / data ops
None.

### Independent review status (Phase 5)
**IMPLEMENT PUSHED — independent adversarial REVIEW REQUIRED** on the **new product tip after push** (not self-PASS). Gate #4 requires B14/B15 cannot reproduce derivation-pending Empty or silent bill-actions empty on 500, and prior B2/B8–B13 still hold. Do **not** start Phase 6.

### Rollback

```bash
# return to failure tip that named B14/B15:
git reset --hard 77fd4182dca94a51b68b8c9b22ac24ce3b0c9df7
```

---

---

## Phase 6 — Analyst Feedback and CRM Contact Controls

**When:** 2026-07-31 (UTC session)
**Operator session:** Phase 6 IMPLEMENT only (not review)
**Mode:** LONG
**Base tip (Phase 5 PASS):** `c48d30bdc2229c2c452640065402efc92551f2b1`
**Product tip (this phase):** `85e768ee086a3e8289d3b85264aefb0fa8be7adb`
**Remote tip (post-push / review target):** `ed311e883082f13b23b0d7e04fba26abc33cb451` (includes package.json repair `ed311e883` after product `85e768ee086`)

### Tasks completed (implementation)

| ID | Work |
|---|---|
| I1 | Tenant-scoped `ProgramElementDataIssue` model + migration `20260811010000_program_element_data_issue` with FORCE RLS (`program_element_data_issue_isolation`) |
| I2 | `ProgramElementDataIssueService` create/list/admin/resolve; PE + FY + field + http(s) URL + description validation; audit on create/resolve without description/URL PII; resolve never mutates canonical PE year marker |
| I3 | Web `ProgramElementDataIssueModal` + Report data issue from `PeTrustHeader` |
| I4 | `isCrmLinkBlocked` / `crmLinkBlockedReason`; `linkCrmContact` requires exact `peCode`; evaluates PE-applicable roles only; blocks procurement POC / sensitive / candidate / quarantined; no admin bypass; audits allowed+blocked without PII |
| I5 | Personnel response carries `crmLinkBlocked` + reason; Program Team Link disabled + tooltip/aria; modal posts peCode |
| I6 | Targeted API + web regression tests; `verify:pe-phase-i` script |

### Files (product)

- `apps/api/prisma/schema.prisma`
- `apps/api/prisma/migrations/20260811010000_program_element_data_issue/migration.sql`
- `apps/api/src/program-element/program-element-data-issue.service.ts` (+spec)
- `apps/api/src/program-element/program-element.controller.ts` (+spec)
- `apps/api/src/program-element/program-element.module.ts`
- `apps/api/src/acquisition-personnel/contact-use.policy.ts` (+spec)
- `apps/api/src/acquisition-personnel/acquisition-personnel-read.service.ts` (+spec)
- `apps/api/src/acquisition-personnel/acquisition-personnel.controller.ts` (+spec)
- `apps/api/src/acquisition-personnel/dto/list-personnel.dto.ts`
- `apps/api/package.json` (`verify:pe-phase-i`)
- `apps/web/src/pages/program-element/ProgramElementDataIssueModal.tsx` (+test)
- `apps/web/src/pages/program-element/ProgramTeamPanel.tsx` (+test)
- `apps/web/src/pages/program-element/LinkCrmContactModal.tsx`
- `apps/web/src/pages/program-element/PeTrustHeader.tsx`
- `apps/web/src/pages/program-element/ProgramElementWatchPage.tsx`
- `apps/web/src/pages/program-element/api.ts`
- `apps/web/src/pages/program-element/types.ts`
- ledger docs

### Gates (implement local)

| Command | Result |
|---|---|
| `pnpm run verify:pe-phase-i` (apps/api) | **102/102 PASS** |
| `pnpm run verify:pe-phase-a` | **PE_PHASE_A_B_SAFETY_OK** |
| jest watch tenant isolation + tenant-scope-guard | **4/4 PASS** |
| vitest ProgramTeamPanel + ProgramElementDataIssueModal | **10/10 PASS** |
| vitest `src/pages/program-element/` (after modal fix) | targeted PE suite green; build PASS |
| `apps/web` `run build` | **PASS** (~17s vite) |
| Migrations applied to shared env | **not run** (additive migration only) |
| Secrets / MeriV2 / email / LlamaParse / ingestion commit | not run |

### Migrations / data ops

- Additive only: `program_element_data_issue` + FORCE RLS. No shared-env migrate executed in this session.
- Resolution path reads PE year marker and fails closed if it changed (must not write PE dollars).

### Tip pin (package.json repair)
After product commit `85e768ee086a3e8289d3b85264aefb0fa8be7adb`, commit `ed311e883` repaired `apps/api/package.json` JSON after a corrupt `verify:pe-phase-i` script insert. **Review target tip:** `ed311e883082f13b23b0d7e04fba26abc33cb451`.

### Independent review status (Phase 6)

**IMPLEMENT PUSHED — independent adversarial REVIEW REQUIRED** on the remote tip after push (not self-PASS).
Do **not** start Phase 7 until REVIEW records `VERDICT: PASS` (or PASS WITH BLOCKERS with exit-gate bullets satisfied).

### Rollback

```bash
git reset --hard c48d30bdc2229c2c452640065402efc92551f2b1
```

### Exit gate bullets for REVIEW (do not self-PASS)

- Cross-tenant issue and contact isolation holds
- Blocked and allowed CRM attempts audited without PII
- Another PE's role cannot authorize this PE
- Canonical PE year rows unchanged after issue resolution
- Migration + web disabled-link + report modal present

---


---

## Phase 8 — Complete Phase K Permanent Release Gates (IMPLEMENT)

**When (UTC date):** 2026-07-31  
**Base (Phase 7 PASS tip):** `e4f416ed574eaf222d6355b4cbdc6524cc778121`  
**origin/main at implement:** `3dcb12f823774b6fae8578dc56fc122bf9a0879e`  
**Mode:** LONG IMPLEMENT only — no self-PASS, no Phase 9, no MeriV2 source edits, no shared-env migrate/deploy   (product `e8124cc8ea96185ddb810e381e4a80bc45e19d00`; REVIEW must re-resolve origin HEAD)

### Tasks completed (implementation)

| ID | Work |
|---|---|
| K1 | Bounded `tsconfig.pe-scripts.json` + `typecheck:pe-scripts` / `lint:pe-scripts` / `test:pe-trust` / `verify:pe-phase-k` naming exact scripts/tests (no globs) |
| K2 | Accuracy harness grounded-field exact identity/FY/field/stage/SHA/page/span + separated precision/recall/coverage/classification/FP/FN (`accuracy-metrics.ts`) |
| K3 | Diagnostics fail-closed evaluator (`pe-trust-diagnostics.ts`) + live `diag:pe-trust --fail-closed` wiring |
| K4 | Migration guards pure module + `verify:pe-migration-guards` (entrypoint history mutation ban, single migrate deploy path, offline validate/generate optional); clean/upgrade replay documented for disposable Postgres only |
| K5 | Bounded-cardinality PE trust metric + alarm catalog (`pe-trust-metric-catalog.ts`) + synthetic alarm test events (no schedule deploy) |
| K6 | Golden grounded-field synthetic set with loud NOT-HUMAN warnings; provenance auditor; human-reviewed evidence remains **blocked** human workstream |
| Docs | `docs/runbooks/program-elements-trust-gates.md` + `docs/verification/program-elements-trust/phase-k/` |

### Files (product)

- `apps/api/scripts/lib/pe-production-scripts.ts` (+spec)
- `apps/api/scripts/lib/pe-trust-diagnostics.ts` (+spec)
- `apps/api/scripts/lib/pe-migration-guards.ts` (+spec)
- `apps/api/scripts/lint-pe-scripts.ts`
- `apps/api/scripts/verify-pe-phase-k.ts`
- `apps/api/scripts/verify-pe-migration-guards.ts`
- `apps/api/scripts/diag-program-element-trust-baseline.ts` (trustEvaluation + `--fail-closed`)
- `apps/api/src/intelligence/metrics/accuracy-metrics.ts` (+spec Phase K)
- `apps/api/src/program-element/pe-trust-metric-catalog.ts` (+spec)
- `apps/api/test/__golden__/grounded-field.golden.json` + README
- `apps/api/tsconfig.pe-scripts.json` + `tsconfig.pe-scripts-catalog.json`
- `apps/api/package.json` scripts
- `docs/runbooks/program-elements-trust-gates.md`
- `docs/verification/program-elements-trust/phase-k/**`
- ledger docs

### Gates (implement local)

| Command | Result |
|---|---|
| `pnpm -C apps/api run typecheck:pe-scripts` | **PASS** |
| `pnpm -C apps/api run lint:pe-scripts` | **PE_LINT_SCRIPTS_OK** |
| `pnpm -C apps/api run test:pe-trust` | **48/48 PASS** + `PE_PHASE_K_OK` |
| `pnpm -C apps/api run verify:pe-phase-k` | **PASS** (typecheck+lint+test+migration guards) |
| `pnpm -C apps/api run verify:pe-migration-guards` | **PE_MIGRATION_GUARDS_OK** |
| `pnpm -C apps/api run verify:pe-phase-a` | **PE_PHASE_A_B_SAFETY_OK** |
| `pnpm -C apps/api run verify:pe-phase-d` | **52/52 PASS** |
| `pnpm -C apps/api run verify:pe-phase-j` | **77/77 PASS** |
| `prisma validate` (dummy DATABASE_URL) | **schema valid** |
| Shared-env migrate / ingestion / secrets / email / LlamaParse / schedule deploy | **not run** |
| MeriV2 source edits | **none** |

### Migrations / data ops

- None applied. No Prisma schema change. No shared DB touch.
- Clean/upgrade migrate replay remains operator disposable-Postgres step (runbook); pure interpreters unit-tested.

### Base-proven failures / honesty

- Committed grounded golden rows remain **SYNTHETIC** — accuracy numbers must not be labeled human-verified (K6 blocked human workstream).
- Live `diag:pe-trust` still requires DATABASE_URL; gate uses pure fixtures + `--fail-closed` size evaluator.
- Full production-script tree typecheck is catalog-bounded (gate modules + metrics); nest-heavy loaders remain covered by pe-phase tsconfigs + existence lint — intentional bound per plan "bounded PE production-script TypeScript configuration".

### Independent review status (Phase 8)

**IMPLEMENT PUSHED — independent adversarial REVIEW REQUIRED** on the remote tip after push (not self-PASS).  
Do **not** start Phase 9 until REVIEW records `VERDICT: PASS` (or PASS WITH BLOCKERS with exit-gate bullets satisfied).

### Rollback

```bash
git reset --hard e4f416ed574eaf222d6355b4cbdc6524cc778121
```

### Exit gate bullets for REVIEW (do not self-PASS)

- `test:pe-trust` / `verify:pe-phase-k` pass on the exact remote SHA
- Script typecheck and static lint pass (`typecheck:pe-scripts`, `lint:pe-scripts`)
- Migration guards pass offline; no hand-edit `_prisma_migrations` on entrypoints
- Diagnostics fail closed when expected (unit fixtures + evaluator)
- Alarm definitions receive synthetic test events via `buildPeTrustSyntheticAlarmEvent` (no deploy required)
- Human-reviewed accuracy evidence present **or** PR remains draft and explicitly blocked on K6 human workstream (synthetic goldens loud)

---

## Phase 8 independent review (recorded at Phase 9 kickoff)

**VERDICT: PASS WITH BLOCKERS** on remote tip `cf9545d7e8879862a19bac4e82620eadf010c6b7` (product `e8124cc8ea96185ddb810e381e4a80bc45e19d00`). Artifact: operator `prompts/phase-8-review-PASS.md`. B5 upgrade-from-base-dump closed in Phase 9 via disposable clean+upgrade migrate replay.

---

## Phase 9 — Integrated Release Rehearsal (IMPLEMENT)

**When (UTC date):** 2026-07-31
**Base (Phase 8 PASS tip):** `cf9545d7e8879862a19bac4e82620eadf010c6b7`
**origin/main at implement:** `3dcb12f823774b6fae8578dc56fc122bf9a0879e` (merge-base identical)
**Mode:** LONG IMPLEMENT only — no self-PASS, no Phase 10, no MeriV2 source edits, no shared-env migrate/deploy/ingestion/email/LlamaParse/secrets
**Product tip (this phase):** `ca3f372b0abfc75e06d0b031e89c18f2cd640e01`
**Evidence refresh tip:** `a21640c568dbfef01dbbce5945bf032221213414`
**Remote tip after push (review target):** `git rev-parse origin/agent/program-elements-final-closeout` (must include product `ca3f372b0abfc75e06d0b031e89c18f2cd640e01` and evidence `a21640c568dbfef01dbbce5945bf032221213414` ancestry; implementer does not self-PASS)

### Tasks completed (implementation)

| ID | Work |
|---|---|
| R1 | Ordered Phase 9 step catalog covering install, prisma, shared/api/workspace/web typecheck+build, PE scripts typecheck, A-K gates, test:pe-trust, full PE API surface, workspace grounding, web PE vitest, prettier (soft), git hygiene, integrity, migration guards, clean+upgrade disposable migrate replay, optional Phase C RLS |
| R2 | Pure failure classifier + integrity evaluator — branch-introduced vs base-proven vs environment; transport forbidden-path scan |
| R3 | Executable orchestrator verify-pe-phase-9.ts + package scripts verify:pe-phase-9 / verify:pe-phase-9:full |
| R4 | Disposable Docker clean + production-equivalent upgrade migrate replay pe-phase-9-migration-replay.sh (DB name capiro; branch-only migs via git diff --diff-filter=A; in-container dump/restore; PE-path node/prisma) |
| R5 | Extended proof owner map (dry-run loaders, exact-SHA, outbox retry, SAM partial window, data-issue non-mutation, CRM matrix, coverage honesty) |
| R6 | Evidence under docs/verification/program-elements-trust/phase-9/ + runbook section |
| R7 | Targeted unit tests (pe-phase-9-rehearsal.spec.ts); wired into test:pe-trust + tsconfig.pe-scripts + production script catalog |
| R8 | Hardening: migration-guards validate/generate via node+prisma (no MSYS pnpm rewrite); PE jest surface excludes unrelated main-failing acq extractors; workspace typecheck runs prisma generate + @capiro/auth build first |

### Files (product)

- apps/api/scripts/lib/pe-phase-9-rehearsal-catalog.ts
- apps/api/scripts/lib/pe-phase-9-rehearsal.ts (+spec)
- apps/api/scripts/verify-pe-phase-9.ts
- apps/api/scripts/pe-phase-9-migration-replay.sh
- apps/api/scripts/verify-pe-migration-guards.ts (node+prisma validate/generate)
- apps/api/scripts/lib/pe-production-scripts.ts
- apps/api/tsconfig.pe-scripts.json
- apps/api/package.json / root package.json scripts
- docs/runbooks/program-elements-trust-gates.md
- docs/verification/program-elements-trust/phase-9/**
- ledger docs

### Gates (implement local — PE_PHASE_9_OK)

| Command | Result |
|---|---|
| typecheck:pe-scripts | PASS |
| test:pe-trust (incl. phase-9 pure specs) | PASS + PE_PHASE_K_OK |
| verify:pe-phase-a … verify:pe-phase-k | PASS (via full orchestrator) |
| full PE API jest surface (PE + CRM personnel closeout paths) | PASS |
| workspace domain-grounding.helpers | 10/10 PASS |
| web src/pages/program-element vitest | 158/158 PASS (23 files) |
| web typecheck + build | PASS |
| shared build + typecheck | PASS |
| api typecheck | PASS |
| workspace typecheck (after prisma generate + auth build) | PASS |
| git diff --check PE product paths | PASS |
| transport integrity | PE_PHASE_9_INTEGRITY_OK |
| migration guards + validate/generate | PE_MIGRATION_*_OK |
| clean + upgrade disposable migrate replay | PE_PHASE_9_MIGRATION_REPLAY_OK (196 migrations) |
| Full orchestrator | PE_PHASE_9_OK (gate.ok true) |
| Shared-env migrate / deploy / email / LlamaParse / secrets / MeriV2 edits | not run / none |

### Soft failures (non-blocking warnings)

| Step | Exit | Note |
|---|---|---|
| prettier_pe_surface | 1 | Large pre-existing PE tree style debt (225 files) — soft; Phase 11 body/hygiene may pick up |
| rls_phase_c_rehearsal | 127 | Host psql not on PATH; Phase C unit+disposal already covered by pe-phase-c + clean migrate FORCE RLS. Soft |
| Unrelated acq extractors (dow-org-import.helpers, sam-personnel-extractor email) | n/a | Fail on tip but not in PE closeout changed runtime paths and not bundled into Phase 9 full PE surface; residual base/main debt |

### Base-proven / honesty

- Grounded goldens remain SYNTHETIC (K6 human workstream blocked).
- Zero PE letter gate regressions A-K on HEAD.
- No migration name-set drift clean vs upgrade.
- No transport/recovery artifacts on tip.

### Independent review status (Phase 9)

**IMPLEMENT PUSHED — independent adversarial REVIEW REQUIRED** on the remote tip after push (not self-PASS).
Do **not** start Phase 10 until REVIEW records PASS **and** Neo authorizes staging (PE_CLOSEOUT_STAGING_OK / explicit text).

### Rollback

```bash
git reset --hard cf9545d7e8879862a19bac4e82620eadf010c6b7
```

### Exit gate bullets for REVIEW (do not self-PASS)

- Zero branch-introduced failure on required rehearsal steps for remote HEAD
- Base failures (if any) reproduced on exact merge-base and unrelated to changed PE runtime paths
- No migration drift (clean + upgrade disposable replay OK)
- No temporary workflows / patch payloads / recovery artifacts on tip
- Independent reviewer returns PASS

---


---

## Phase 9 independent review FAIL + B1 rework (IMPLEMENT)

**When (UTC date):** 2026-07-31
**Failed tip (review 9 FAIL):** `255098977509c9b06e7142f0624fa4822dfadb36`
**Product fix tip:** `e22423fd23cd957c165417428bf5d40f41a13848`
**Evidence / docs pin tip (review resolves live origin HEAD):** re-run exist against that HEAD after pin push (implementer does not self-PASS)
**origin/main at rework:** `3dcb12f823774b6fae8578dc56fc122bf9a0879e` (0 behind)
**Mode:** LONG IMPLEMENT only — close review B1 only; no self-PASS; no Phase 10

### Blocking defect closed (implement claim — REVIEW must falsify)

| ID | Defect | Fix |
|---|---|---|
| B1 | Upgrade migrate path false-green: MSYS `git -C "$(pwd)"` on `/c/c/...` failed → empty branch-only → tip applied with 0 pending PE migs while clean claimed 196 | `pe-phase-9-migration-replay.sh`: resolve Git-accepted root via `cygpath -m` / `pwd -W`; `git_req` never swallows exit 128; hard assert empty branch-only when main≠HEAD mig counts; `branch_only≥2` (exact PE names when present); `upgrade_base_applied==main (194)`; tip `applied_delta≥branch_only`; reject No pending when overlay exists; `count_lines` replaces `grep -c \|\| echo 0` → `00` footgun |
| soft | host psql missing → rls exit 127 noise | `pe-phase-c-rls-rehearsal.sh` soft skip with `PE_PHASE_C_RLS_REHEARSAL_SKIP` when psql absent (still required:false) |

### Commands (rework)

```text
bash apps/api/scripts/pe-phase-9-migration-replay.sh
# → PE_PHASE_9_MIGRATION_REPLAY_OK ... applied=196 base_applied=194 branch_only=2 tip_delta=2
# tip applied: 20260729050000_pe_observation_idempotency_and_outbox + 20260811010000_program_element_data_issue

NODE_EXE=C:/Users/neoma/AppData/Local/hermes/node/node.exe \
PNPM_JS=C:/Users/neoma/AppData/Local/hermes/node/node_modules/corepack/dist/pnpm.js \
"$NODE_EXE" "$PNPM_JS" -C apps/api run verify:pe-phase-9 -- --full --skip-install
# → PE_PHASE_9_OK (gate.ok true); soft prettier only
```

### Files changed (rework)

- apps/api/scripts/pe-phase-9-migration-replay.sh
- apps/api/scripts/pe-phase-c-rls-rehearsal.sh
- docs/verification/program-elements-trust/phase-9/*
- ledger docs (this section + traceability)

### Independent review status (Phase 9 rework)

**IMPLEMENT PUSHED — independent adversarial REVIEW REQUIRED** against live origin HEAD after push (must include fix `e22423fd23cd957c165417428bf5d40f41a13848`).
Do **not** treat implementer PE_PHASE_9_OK as REVIEW PASS.
Do **not** start Phase 10 until new REVIEW PASS **and** Neo staging auth (`PE_CLOSEOUT_STAGING_OK=yes`).

### Rollback

```bash
git reset --hard 255098977509c9b06e7142f0624fa4822dfadb36   # failed tip
# or Phase 8 PASS:
git reset --hard cf9545d7e8879862a19bac4e82620eadf010c6b7
```


## Next phase

**Phase 9 independent adversarial REVIEW only** against the **post-fix remote tip** (not Phase 10).
Operator: `./pe-closeout-run.sh review 9` in a NEW shell after push.
Do not start Phase 10 unless Neo authorizes staging.
