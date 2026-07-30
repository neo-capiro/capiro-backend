# Program Elements Final Closeout — Work Log

**Branch:** `agent/program-elements-final-closeout`  
**PR:** https://github.com/neo-capiro/capirov2/pull/705 (draft → `main`)  
**Plan source:** local `program-elements-final-closeout-plan-and-schedule.md`  
**Repo:** `neo-capiro/capirov2`  
**Operator session:** Phase 2 IMPLEMENT (exact-SHA atomic loader contract)  
**Generated (UTC):** 2026-07-30T10:31:22Z  
**Ledger last updated (UTC):** 2026-07-30 (Phase 2 IMPLEMENT PUSHED / independent review REQUIRED — no self-PASS)

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
| Status | **IMPLEMENT PUSHED / independent review REQUIRED** (no self-PASS) |

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
# After push, reverse the Phase 2 product commit only:
git revert <phase-2-product-sha>
# or hard reset closeout branch product tip to pre-Phase-2 base (destroys unpushed work):
git reset --hard 6268e2f2a1ef3eda906c47e8721c211d95f102a4
```

### Independent review status

| Round | Tip | Verdict |
|---|---|---|
| Phase 2 | (set after push to exact remote tip) | **PENDING** — implementer gates green ≠ PASS |

---

## Next phase

**Phase 2 independent adversarial REVIEW only** (not Phase 3 implement).
Do not start Phase 3 until a separate REVIEW session records `VERDICT: PASS` against the remote tip SHA after this Phase 2 product commit.
