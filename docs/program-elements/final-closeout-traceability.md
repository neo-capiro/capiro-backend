# Program Elements Final Closeout — Traceability Ledger

**Baseline main SHA:** `057f5480a46f9ba9acf9296a9cc876b609593832`  
**Pre-Phase-0 #705 head (void product):** `a244022648d54d9e4ac7fb071f9f438405659056`  
**Updated (UTC):** 2026-07-30 (Phase 4 FAIL Round-2 remediations B5–B7; implementer gates green; **Phase 4 independent review REQUIRED on new tip** — no self-PASS)

Legend for **Status**:

- `in_main` — already on `origin/main`
- `recovered` — code exists on a branch / decodable patch; needs integration + rebase onto closeout tip
- `missing` — must be implemented on the closeout branch
- `blocked` — needs fixture, secret, shared env, or Neo authorization
- `oos` — intentionally out of scope for this PR / release

Closeout **execution phase** column is the session phase from the final schedule (0–11), not original A–L letters.

---

## 1. Original Phase A–C (prerequisite — already shipped)

| ID | Requirement (summary) | Status | Evidence | Closeout owner |
|---|---|---|---|---|
| A | Freeze unsafe PE writes; baseline diagnostics; pe-phase-a safety typecheck | `in_main` | `verify:pe-phase-a`, `tsconfig.pe-phase-a.json`, merged #647 | maintain via inheritance gates |
| B | USD-millions contract; exact-SHA promotion path for defense-budget commit | `in_main` | `verify:pe-phase-b`, `defense-budget-commit`, replay specs, merged #663 | maintain; Phase 2 extends to all loaders |
| C | Tenant-scoped PE watches + RLS expand/contract | `in_main` | migrations `20260728230000_*`, `20260728230100_*`, `verify:pe-phase-c`, #669+#672 | maintain |

---

## 2. Phase D — Deterministic canonical writes → Closeout Phase 1

| ID | Requirement | Status | Source | Owner phase |
|---|---|---|---|---|
| D1 | Explicit field authority map | `in_branch` (Phase 1) | decoded D patch `program-element-field-ownership.ts` | 1 |
| D2 | Source-document + parse-job write context | `in_branch` (Phase 1) / main B | D writer + main source-document registry | 1 |
| D3 | Raw namespace preservation | `in_branch` (Phase 1) | `program-element-raw-merge.ts` | 1 |
| D4 | Stable observation keys | `in_branch` (Phase 1) | migration + backfill script in D patch | 1 |
| D5 | Replay idempotency | `in_branch` (Phase 1) | writer + specs in D patch | 1 |
| D6 | Field-level winner selection | `in_branch` (Phase 1) | ownership + writer | 1 |
| D7 | Canonical mutation + outbox one transaction | `in_branch` (Phase 1) | writer + outbox service + migration | 1 |
| D8 | Durable outbox drain/retry | `in_branch` (Phase 1) — bare-client path fixed post review FAIL | `runPeOutboxSystemTx` fallback + `peChangeOutboxPrismaFromClient` + runtime specs (B1/B2) | 1 |
| D9 | Reconciliation failure rolls back canonical | `in_branch` (Phase 1) | reconciliation.service changes in D patch | 1 |
| D10 | Dry-run-first observation audit/backfill | `in_branch` (Phase 1) | backfill script | 1 |
| D11 | No temporary D workflows/patch blobs in final diff | `in_branch` (Phase 1) — no transport | Phase 0 removed transport; Phase 1 must not reintroduce `.github/phase-d-*` | 1 |
| D12 | Rehearse additive migration in disposable Postgres | `verified` PGlite + Docker pgvector/pgvector:pg16 disposable (prior Phase 1 session) | 1 |

**Phase 1 review gate:** Round 1 on `b8ed28855` = **FAIL** (B1/B2/B3). Round 2 = **PASS** on tip `da36195d3` (product `454a27f5e`); artifact `prompts/phase-1-review-PASS.md`.

**Recovery note (historical):** Phase D product was integrated in Phase 1 via recovered patch + corrections, not by remaining transport blobs.

---

## 3. Phase E — Exact-SHA atomic loader contract → Closeout Phase 2

| ID | Requirement | Status | Source | Owner phase |
|---|---|---|---|---|
| E0 | `agent/pe-trust-phase-e` tip == D-v2 transport tip | `recovered` name only | no distinct E product on that branch | 2 |
| E1 | Inspect → quality audit → approve exact SHA → atomic commit → safe replay for every PE dollar loader | `in_branch` (Phase 2) | `pe-exact-sha-loader-contract.ts` + converted loaders + `verify:pe-phase-e` | 2 |
| E2 | Default invocation performs no canonical write | `in_branch` (Phase 2) | inspect posture default; smoke load-om | 2 |
| E3 | `--commit` without approved exact SHA fails pre-mutation | `in_branch` (Phase 2) | `assertExactShaCommitAllowed` / Phase B PDF path | 2 |
| E4 | LlamaParse only via extract-only + explicit auth | `in_main` + retained | `ingest-defense-budget-pdf` + pe-ingestion-mode | 2 |
| E5 | Prefer checksummed extraction over paid re-parse | `in_main` + retained | loadExistingParseArtifact on PDF commit | 2 |
| E6 | Failed promotion cannot become live source head | `in_branch` stronger | `deferSupersede` + post-success `supersedeSourceDocumentHead` on rewritten loaders (o1/op5/pdoc/approps/ndaa/jbook r1-r3/enrichment); PDF pack already | 2 |
| E7 | Observation carries page/span/extractor/units | `in_branch` incremental | writeContext + originalValues on committee/pdoc/O-1; PDF Phase B | 2 |
| E8 | Loader inventory (RDT&E P-forms, O&M OP-5, J-books, HASC/SASC, HAC-D/SAC-D, NDAA conf, public law, generalized PDF) | `in_branch` (Phase 2) | `PE_EXACT_SHA_DOLLAR_LOADERS` + static verifier (13 entrypoints) | 2 |

**Phase 2 review gate:** Independent review **PASS** on tip `0f47e13f8` (product `d06601b0a`); artifact `prompts/phase-2-review-PASS.md`.

---

## 4. Phase F — Complete-window + SAM safety → Closeout Phase 3

| ID | Requirement | Status | Source | Owner phase |
|---|---|---|---|---|
| F1 | Partial runs record `partial`, not success | `in_branch` (Phase 3) | `statusFromCounts` + incomplete RunCounts | 3 |
| F2 | Only complete runs advance success watermark | `in_branch` (Phase 3) | `lastSuccessfulWatermark` status='success' only | 3 |
| F3 | Historical backfill separate source/watermark | `in_branch` (Phase 3) | `syncSourceForScope(scope, backfill)` (+ main all-federal) | 3 |
| F4 | Oversized SAM ranges recursively split | `in_branch` (Phase 3) | `collectSamWindowRecords` / `splitSamWindow` | 3 |
| F5 | Unsplittable single-day overflow stays partial/visible | `in_branch` (Phase 3) | incompleteReason + partial SyncRun | 3 |
| F6 | Notice ID dedupe across splits | `in_branch` (Phase 3) | seenNoticeIds in collector | 3 |
| F7 | SAM HTTPS, host allowlist, SSRF guard, timeouts, size limit, API key redaction | `in_branch` (Phase 3) | fetchPage + resolveSamDescription | 3 |
| F8 | Match persistence preserves accept/reject human decisions | `in_branch` (Phase 3) | persistOneMatch / persistMatches | 3 |
| F9 | Opportunity + match writes atomic | `in_branch` (Phase 3) | `$transaction` around upsert+matches | 3 |
| F10 | Drop `.github/workflows/pe-phase-f-current-source.yml` on integrate | `in_branch` (absent) | never introduced | 3 |

**Integrate note:** Path-limited port from `origin/agent/pe-trust-phase-f` product commits `107a7f5f0`/`c8ef5c3a1` **into** current-main SAM script (all-federal + dry-run hygiene + CLI validation retained). No wholesale F tip merge. No transport workflow.

**Phase 3 review gate:** Independent review **PASS WITH BLOCKERS** on tip `0a74cf9a3` (product `1e7825472`); artifact `prompts/phase-3-review-PASS.md`.

---

## 5. Phase G — Current-cycle track-aware read contract → Closeout Phase 4

| ID | Requirement | Status | Source | Owner phase |
|---|---|---|---|---|
| G1 | Shared `FundingClaim` (value, FY, stage, stageLabel, legislativeVehicle, cycleClass, isProjection) | `in_branch` (Phase 4) | `packages/shared/src/funding-claim.ts` + `@capiro/shared/funding-claim` export | 4 |
| G2 | Preserve zero-dollar values | `in_branch` (Phase 4) | selectLatestPreservingZero + SQL laterals without `<> 0` | 4 |
| G3 | Never latest-nonzero selection | `in_branch` (Phase 4) | finder/capability request/enacted picks; cycle FY counts zero marks | 4 |
| G4 | Separate request / auth / approps / auth conf / approps conf / enacted vehicles | `in_branch` (Phase 4) | FUNDING_CLAIM_VEHICLE + claimFromLadderPick | 4 |
| G5 | Auth vs approps never mix in comparisons | `in_branch` (Phase 4 FAIL fix) | canCompareClaimsForPct + **markupMonitorTrackDivergence** wired into listMarkupMonitor | 4 |
| G6 | Never cross-FY % delta | `in_branch` (Phase 4 FAIL fix) | listEnactedVsRequestDeltaPct + requestAtEnactedFy; comparableEnactedVsRequest | 4 |
| G7 | Movement KPIs over full filtered population + coverage | `in_branch` (Phase 4) | getSummary.movementCoverage | 4 |
| G8 | Capability totals one FY + coverage disclosure | `in_branch` (Phase 4) | listCapabilities shared FY + requestCoverage | 4 |
| G9 | Contractor evidence: accepted_direct / candidate / unmatched | `in_branch` (Phase 4) | getContractors.evidenceBuckets | 4 |
| G10 | Missing-mark taxonomy | `in_branch` (Phase 4) | classifyMissingMark on timeline years | 4 |
| G11 | Current request cannot be FYDP outyear | `in_branch` (Phase 4 FAIL R2 fix) | list peCurrentCycleFy + sqlCurrentCycleFyExpr; detail/timeline currentCycleFyPreservingZero + NDAA; currentCycleFyOf aligned; markup pe_cycle CTE | 4 |
| G12 | API contract tests + verify:pe-phase-g | `in_branch` (Phase 4) | funding-claim.spec + read.service Phase G case | 4 |

**Phase 4 review gate:** Round 1 FAIL B1–B3 closed on product `2adb5581a`. Round 2 on tip `13cb22c53` = **FAIL** (B5 list cycle = latest request FY; B6 detail fundingSummary NDAA-blind `currentCycleFyOf`; B7 markup `ORDER BY fy DESC`). Round-2 remediations product `5e83b8946148c91977bd4da7a4888bb94f33a642` — requires a **new** independent REVIEW on that tip (no self-PASS). Re-attack B5/B6/B7 and hold B1–B3.

---

## 6. Phase H — Trust-first PE web UX → Closeout Phase 5

| ID | Requirement | Status | Source | Owner phase |
|---|---|---|---|---|
| H1 | Trust header: PE mark-bearing FY, stage, vehicle, verification time, coverage, reconciliation | `in_branch` (Phase 5) | PeTrustHeader + trust-model | 5 |
| H2 | Coverage/caveats drawer | `in_branch` (Phase 5) | PeTrustHeader Drawer | 5 |
| H3 | Explicit states loading/failed+retry/partial/not_ingested/unsupported/complete | `in_branch` (Phase 5) | PeLoadState + resolvePeSurfaceState | 5 |
| H4 | Deep-link + restore tab + FY | `in_branch` (Phase 5) | ?tab=&fy= serialize/parse | 5 |
| H5 | Lazy-load hidden tabs | `in_branch` (Phase 5) | peWatchQueryEnabled; destroyOnHidden tabs | 5 |
| H6 | No projected-enacted substitution | `in_branch` (Phase 5) | FyHistoryChart + toHistoryRow | 5 |
| H7 | Preserve zeros in charts/sparks | `in_branch` (Phase 5) | toChartPoint null-safe; spark filter null only | 5 |
| H8 | Copy claim with citation | `in_branch` (Phase 5) | formatClaimWithCitation | 5 |
| H9 | Report-language match scope + attribution caveat | `in_branch` (Phase 5) | ProvisionsPanel + ProvisionItem types | 5 |
| H10 | Proof-pack / fingerprint language honest | `in_branch` (Phase 5) | ProofPackPanel + proofFingerprintLabel | 5 |
| H11 | P-40 related ids + source FY (not hard-coded 2027) | `in_branch` (Phase 5) | PdocDetailPanel + formatPdocSourceLine | 5 |
| H12 | Keyboard-accessible related-line navigation | `in_branch` (Phase 5) | LinkedLinesRail + related PE buttons | 5 |
| H13 | No fabricated personnel estimates | `in_branch` (Phase 5) | ProgramTeamPanel identified-count only | 5 |
| H14 | Web list types claim bags (Phase 4 R2 residual) | `in_branch` (Phase 5) | ProgramElementListItem claim fields | 5 |

Depends on Phase 4 read contract. **Phase 5 implement pushed — independent REVIEW required (no self-PASS).**

---

## 7. Phase I — Data issues + CRM contact controls → Closeout Phase 6

| ID | Requirement | Status | Source | Owner phase |
|---|---|---|---|---|
| I1–In | Tenant PE data issues + RLS; validation; audit; resolution non-mutating; exact peCode CRM link; server role matrix; block procurement POC / sensitive / candidate / quarantined; no admin bypass; accessible disabled reason | `missing` | Branch tip + CI zip have **workflows only**. Treat prior “publish” commits as non-evidence. | 6 |

---

## 8. Phase J + L grounding / coverage → Closeout Phase 7

| ID | Requirement | Status | Source | Owner phase |
|---|---|---|---|---|
| J1 | Shared defense-budget line classifier + primer for allowed consumers | `recovered` with constraint | Phase J branch implements via **shared + Meri + meriv2-core + Workspace**. Closeout may take **`packages/shared`** and PE/API/Workspace grounding **without** modifying `packages/meriv2-core/**` or free-form Meri runtime beyond compatibility checks. | 7 |
| J2 | Do not classify RDT&E from BA4 alone; do not call procurement lines PEs | carry from J intent | 7 |
| J3 | Preserve auth vs approps, report-language scope, contact restrictions | 7 |
| L1 | Defense Approps conference/JES | `blocked`/document | coverage decision table Phase 7 | 7 |
| L2 | Full FYDP projection coverage | `blocked`/document | 7 |
| L3 | Execution/reprogramming feeds | `oos`/`blocked` | 7 |
| L4 | Procurement performer coverage | partial main / document gaps | 7 |
| L5 | MILCON/C-1 | `oos`/`blocked` | 7 |
| L6 | Reserve exhibits | `oos`/`blocked` | 7 |
| L7 | Remaining P-5/P-21/P-3A or OP-5 gaps | document | 7 |

---

## 9. Phase K — Permanent release gates → Closeout Phase 8

| ID | Requirement | Status | Source | Owner phase |
|---|---|---|---|---|
| K1 | `typecheck:pe-scripts`, `lint:pe-scripts`, `test:pe-trust` naming exact scripts/tests | `missing` | phase-k tip is stubs + J tree | 8 |
| K2 | Accuracy harness identity/FY/field/SHA/span metrics separation | `missing` | 8 |
| K3 | Diagnostics fail-closed sizes | partial `diag:pe-trust` on main | 8 |
| K4 | Migration guards (validate/generate/clean replay; no hand-edit `_prisma_migrations`) | `missing` as permanent gate | 8 |
| K5 | Bounded cardinality metrics + alarm defs (no deploy schedules) | `missing` | 8 |
| K6 | Human-reviewed golden set | `blocked` human workstream | 8 + human |

---

## 10. Phases 9–11 (schedule phases, not letter phases)

| Schedule phase | Goal | Status | Owner |
|---|---|---|---|
| 9 Integrated rehearsal | Run A–K + PE suites on remote final SHA | `missing` | Phase 9 session |
| 10 Staging acceptance | Deploy/migrate staging | `blocked` until Neo authorizes | Phase 10 |
| 11 PR closeout | Body, supersede old PRs, ready-for-review | after 9/(10) | Phase 11 |

---

## 11. MeriV2 boundary

| Item | Rule |
|---|---|
| `packages/meriv2-core/**` | **Do not modify** in #705 |
| `apps/api/src/meri/**` product changes for PE | Only if required for API PE tools without forking MeriV2 core; prefer shared classifier. Prefer Phase 7 design that compiles consumers without MeriV2 edits. |
| MeriV2 PR #664 | Unrelated open draft; not this vehicle |

---

## 12. Existing migrations of PE interest on main (baseline snapshot)

Already present now (non-exhaustive): program_element core graph, watches, RLS tenant key, defense_budget_packages, SAM opportunity tables, budget position/delta, pe alert email pref, pe watch S3 archive/parse job, ingest runs.

**To add in later phases (expected):** observation idempotency + outbox (D); data-issue tables (I); any gate-only configs (K).

---

## 13. Commands catalog (inheritance)

Run from `apps/api` after `pnpm install --frozen-lockfile` at repo root (Phase 1+):

```text
pnpm -C apps/api run verify:pe-phase-a
pnpm -C apps/api run verify:pe-phase-b
pnpm -C apps/api run verify:pe-phase-c
pnpm -C apps/api run diag:pe-trust   # read-only if DATABASE_URL set; do not point at prod without auth
```

Phase 0 did not re-execute these (no install in disposable worktree). Phase 1 must establish command log against base SHA before/after D.

---

## 14. Adversarial review — Phase 0

Reviewer stance: assume transport PR lied.

**Findings:**

1. **PASS (critical):** Pre-Phase-0 #705 contained zero product. Ledger records this without restating PR body fiction.
2. **PASS:** Current states of recovered D/F/I/J/K branches polled live via `git ls-remote` + `git diff` + CI artifacts.
3. **PASS:** Incomplete final patch transfer confirmed unrecoverable (PLACEHOLDER / gunzip errors).
4. **PASS:** Phase D implementation patch **is** recoverable and inventoried; not silently applied.
5. **PASS:** Phase F product path list preserved; wholesale branch merge hazard documented (main moved).
6. **PASS:** Phase G/H/I product absence is explicit `missing` (prevents false “recovered” status).
7. **PASS:** Phase J MeriV2 file risk flagged; closeout plan forbids MeriV2 source edits.
8. **PASS:** Temporary source-export workflow not present on post-Phase-0 tip (tip = main + docs).
9. **RESIDUAL RISK (documented, not a Phase 0 fail):** Full `verify:pe-phase-a/b/c` not executed in this session — ownership is Phase 1 gate “inherited PE gates”. Base failure matrix remains TBD.
10. **RESIDUAL RISK:** Decoded D patch may not apply cleanly to `057f5480a`; fuzz conflicts are Phase 1 work, not hidden.

**Verdict:** Phase 0 baseline is **truthful and sufficient** to start Phase 1. Exit gate met for documentation and branch honesty. Implementation debt is deliberately deferred with owners.

---

## 15. Phase 1 independent REVIEW handoff (not Phase 2 implement)

```text
You are the INDEPENDENT ADVERSARIAL REVIEWER for Program Elements Final Closeout Phase 1 only.
MODE: REVIEW (read-only). Do NOT implement, commit, push, or start Phase 2.

Repository: neo-capiro/capirov2
Branch: agent/program-elements-final-closeout
PR: #705
Prior tip that FAILED review: b8ed288558b15a441e8465b0e1023a14423ff392
Product tip after B1/B2 fix (review this commit or successor tip): 454a27f5ee1583a100c0a01761d5e6c970621c80
Prior FAIL session: 20260730_072939_3c2039 (B1 bare withSystem / B2 script writers / B3 dishonest ledger)
origin/main at implement: 010948cc3f475dd0ee47016deba5619c044d8fed

Read before judging:
1. /c/Users/neoma/Downloads/program-elements-final-closeout-plan-and-schedule.md (Phase 1 section only)
2. docs/program-elements/final-closeout-work-log.md
3. docs/program-elements/final-closeout-traceability.md
4. apps/api/src/program-element/program-element-change-outbox.service.ts (+spec)
5. apps/api/scripts/drain-pe-change-outbox.ts (+spec)
6. apps/api/src/program-element/program-element-writer.service.ts (outbox autowire + processOutboxIds)
7. Contrast: apps/api/scripts/drain-identity-outbox.ts withSystem shim

Hard boundaries:
- REVIEW only — no patches, no commits, no Phase 2.
- No MeriV2, merge, deploy, shared migrate, secrets, email, LlamaParse.
- Do not treat implementer "gates PASS" or work-log prose as exit PASS.
- No PASS WITH BLOCKERS.

Required checks:
1. git fetch; record remote tip SHA of agent/program-elements-final-closeout; ahead/behind vs origin/main.
2. Confirm prior FAIL items B1/B2 closed in code (not docs alone):
   - processById must not require Nest withSystem on bare PrismaClient
   - drain script must not cast bare client without shim
   - typescript tests exist that FAIL on unfixed tip: bare client WITHOUT withSystem completes processById/drain
   - drain-pe-change-outbox.spec.ts exercises runtime, not greps only; dry-run remains default
3. Writer autowire path: new ProgramElementChangeOutboxService(prisma) when only $transaction exists must be durable.
4. Re-run locally: verify:pe-phase-a/b/c/d + tsc -p tsconfig.pe-phase-a.json --noEmit
5. Scope: no MeriV2, no transport/.part, only Phase 1 product.
6. Ledgers: honest Phase 1 status; Next phase must NOT claim Phase 2 implement until VERDICT PASS; no "Operator session: Phase 0 only" while Phase 1 is active; remote SHA after push recorded or recordable.
7. Ownership/determinism still sound from prior foundation (field authority, replay, recon rollback).

Exit:
- End with exact line: VERDICT: PASS or VERDICT: FAIL
- List residual blockers if FAIL.
- If PASS only: reproduce remote tip SHA and provide Phase 2 IMPLEMENT handoff prompt (do not implement Phase 2).
- If FAIL: list minimal fix list for another Phase 1 implement session.

Worktree on this machine: C:/c/Users/neoma/AppData/Local/Temp/pe-closeout-wt (MSYS may show C:/c/Users/...).
Launcher: /c/Users/neoma/Downloads/pe-closeout/pe-closeout-run.sh review 1
```

---

## Phase 2 REVIEW handoff (executable — not Phase 3)

```text
You are executing Program Elements Final Closeout Phase 2 INDEPENDENT ADVERSARIAL REVIEW only.

Repository: neo-capiro/capirov2
Branch: agent/program-elements-final-closeout
PR: #705
MODE: REVIEW (read-only)
Do not edit files, commit, push, merge, deploy, or start Phase 3.

Verify against remote tip:
  git fetch origin agent/program-elements-final-closeout main
  git rev-parse origin/agent/program-elements-final-closeout
  git log --oneline origin/main..origin/agent/program-elements-final-closeout | head -20
  git diff --stat origin/main...origin/agent/program-elements-final-closeout

Falsify Phase 2 exit gate:
1. Inventory every PE dollar loader; confirm default invocation cannot write canonical data.
2. --commit without --approved-sha256 fails before Prisma mutation on each converted loader.
3. Quality failure and SHA mismatch block promotion.
4. Failed promotion cannot become live source head (deferSupersede / supersede after success).
5. LlamaParse still requires --extract-only + --allow-vendor-parse; no secret retrieval in tests.
6. verify:pe-phase-e and inheritance A/B/D gates pass on the tip; compare to base SHA if red.
7. No MeriV2 edits; no transport patches; no shared-env ops in the diff.

End with exactly:
VERDICT: PASS
or
VERDICT: FAIL
plus concrete findings. Do not implement fixes.
```


---

## Phase 5 status (FAIL remediation re-implement)

| Field | Value |
|---|---|
| Phase | 5 — Trust-first web |
| Prior product tip (FAIL B1–B3) | `e7ffe8b76a8496e9846fb9a59002142d26b03546` |
| Prior product tip (FAIL B8–B11 closed; B12 open) | `4e2abed9ba5a03acdfbdef6b47ec0be1d2fe3ba3` (docs pin `eafbfb2c0`) |
| Prior review tip | `eafbfb2c0e848a0f692fd8b69950766a8e1277b5` |
| Prior review | VERDICT: FAIL — **B12** FundingNarrativePanel ignores isError (stages Empty on `/narrative` 500); B8–B11 closed |
| Remediation product r3 (B12) | `c8ac942b93d299ccb5fa7e704e76ebac2937580d` (docs pin `88921392c`) |
| Remediation product r4 (B12 re-verify + B13) | _(after push — product commit SHA)_ |
| Remote tip (docs pin after push) | _(origin/agent/program-elements-final-closeout)_ |
| Implementer gate | IMPLEMENT PUSHED / review **REQUIRED** — **not** self-PASS |
| Next | New session `./pe-closeout-run.sh review 5` on **new** tip only |
| MeriV2 | untouched |
| Migrations | none |

### Exit-gate attack notes for reviewer

1. Force `GET .../personnel` 500 on team tab → must render `pe-secondary-failed-*`, Partial banner; never "No identified personnel yet."
2. Force `GET .../provisions` 503 on legislation → `pe-secondary-failed-provisions`, not Empty report-language copy.
3. Detail with `years: [{fy, all stages null}]` → surface `complete_empty` (banner `pe-banner-complete-empty`), not `not_ingested` and not complete_with_data.
4. Detail with year + `request: 0` → `complete_with_data` (zero is a stage).
5. Viewport smoke file green at 1280/768/375; deep-link funding+fy restores selected tab.
6. Initial overview still must not fetch `/sources|/personnel|/contractors|/provisions` **or** `/narrative`.
7. **B8** Force `GET .../actions` 500 on default Overview → `pe-secondary-failed-actions` / Partial; never "No recorded budget actions".
8. **B9** Force `GET .../relationships` 500 on Overview → `pe-secondary-failed-linked-lines`; never "No linked lines yet".
9. **B10** Force `GET .../bills` 500 on Overview Recent activity → `pe-secondary-failed-recent-activity`; never "No dated legislative actions yet."
10. **B11** Force `GET .../procurement-lines` 500 on Procurement detail (PROC line) → `pe-secondary-failed-procurement-lines`; never Secondary Distribution honesty Empty ("no per-recipient breakdown"). Partial banner alone is insufficient if section body still paints success Empty.
11. **B12** Force `GET .../narrative` 500 on **Funding** tab → `pe-secondary-failed-narrative` + Retry + Partial; never "No current-cycle funding stages recorded for this program element yet." Overview cold start must not request `/narrative`.
12. **B13** RDTE detail deep-link `?tab=procurement` → Tabs paint Overview; do **not** fetch `/procurement-lines` under sticky disallowed activeTab (query enablement follows `effectivePeWatchTab`).
