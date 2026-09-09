# Phase 10B-35 — PE attribution repair and reviewed, partial budget display

**Branch:** `feat/phase10b35-pe-attribution-partial-display` (base: `origin/main` @ `dc28ec7a6b01f1b2f169ae083c62bfbe8c9cef25`)
**Mission:** correct the parser identity-binding defect found in Phase 10B-34, then implement explicit review scope and bounded, honestly-labeled display for the five independently-verified FY2024 Army R-2 PE totals — without weakening whole-collection completeness for any comprehensive claim.

---

## 1. Lead summary

1. **The 32 misbound assertions are fixed at the root cause**, not patched over. `groupR2aPagesByStructuralIdentityV1` now treats an Exhibit R-2 (PE-summary) page, or any other non-R-2A exhibit page, as an explicit boundary that closes the open project section — it never again inherits the previous PE's last project as a header-less continuation. A defence-in-depth rule also refuses to ever assert a "Total Program Element" row as project money, with a new omission reason (`pe_total_row_in_project_table`).
2. **Audited, not assumed.** All 108 originally-flagged assertions were reconciled against the publisher's own text layer, independently of the fix: **76 retained** (correctly bound, unchanged), **32 removed** (misbound, gone from the corrected artifact), **0 corrected-in-place**, **0 unresolved**. The other 76 are not "presumed correct" — each was individually checked against the source cost table on its own page.
3. **A new, versioned, structural governed-review policy** (`rdte_r2_scoped_pe_total_review_policy_v1`) approves an explicit, small set of assertion IDs — never a whole candidate — bound to immutable candidate/run/source/artifact/manifest identity, with a real independence analysis (direct findings, same-page/same-row findings, wrong-identity-binding-on-page) that is source-grounded, not a message-regex allow-list. It never waives the 575 unresolved discrepancies and never touches `BudgetReviewDecisionV1` or the outbox.
4. **A new, minimal, additive table** (`budget_scoped_fact_review_v1`) and a bounded read surface (`GET /api/defense-budget/reviewed-partial-pe-totals`, plus a new vNext page) serve exactly the approved PE totals — fiscal year, request stage, component, amount, source citation, review status, explicit `coverage:'partial'` — and nothing else. No canonical/legacy PE table is read or written by this surface; the existing family-readiness completeness gate is untouched.
5. **Proven end-to-end in isolation**, through the real production code path (real parser, real router, real `CompositeProofResolver` in `production_proof` mode, real disposable Postgres + versioned MinIO), not a filesystem-only shortcut: 10/10 tests pass, including the five real scoped approvals, a duplicate-decision refusal, a revoke-then-exclude proof, and a whole-candidate-REJECT-can-never-be-scoped-approved proof via the real DB trigger.
6. **Nothing in production changed.** No merge, no deploy, no replay, no review acceptance, no readiness advancement. Candidate `5522ea3b-203f-5eaa-91b2-157422121b66` and its evidence are untouched.

---

## 2. The parser repair

### 2.1 Root cause (confirmed against the real fixture, not guessed)

`apps/api/src/defense-budget/rdte/r2a/r2a-structural-project-header-parser-v1.ts`'s `groupR2aPagesByStructuralIdentityV1` classified every page with no R-2A exhibit marker as `not_r2a_page`, and a `not_r2a_page` inherited the currently-open project section unconditionally. The four real transition pages (Exhibit R-2 PE-summary pages 126, 132, 161, 164 — the first page of PEs 0601103A/0601104A/0601121A/0601601A) carry **no** R-2A marker (they are R-2, not R-2A), so each was silently absorbed into the *previous* PE's last open R-2A project section (T14, D58, J13, CB5 respectively). Every FY2025–28 cost-table figure on that page — including the PE "Total Program Element" row — was then asserted as `project_funding` under the wrong PE and wrong project.

### 2.2 The fix

- `extractR2aStructuralHeaderV1` now returns a new `exhibit_boundary` status (kinds `pe_summary` / `other_exhibit` / `unmarked_identity_cells`) for any page that structurally belongs to a different exhibit or opens a new PE, detected via an `Exhibit R-2` / `RDT&E Budget Item Justification` marker, a generic `Exhibit <code>` marker for any other exhibit, or a PE identity cell with no project cell.
- `groupR2aPagesByStructuralIdentityV1` closes the open section on `exhibit_boundary` and records it separately (`boundaries`, new field) — never an omission, never inherited.
- Header-less continuation inheritance (`not_r2a_page`) is now also gated on **physical adjacency**: a header-less page only extends an open section when it is exactly the next physical page; a gap closes the section.
- `r2a-project-funding-extractor-v1.ts`'s table analyzer now classifies a `"Total Program Element"` row as `peTotalRows`, kept structurally separate from `dataRows`, and every numeric cell on such a row is refused with the new omission reason `pe_total_row_in_project_table` rather than ever being asserted as `project_funding`.

### 2.3 Regression evidence

New file: `apps/api/src/defense-budget/rdte/r2a/r2a-pe-exhibit-boundary-regression.spec.ts` — **15 tests**, real fixture + generic synthetic controls (different identifiers, different page numbers, valid continuations, conflicting headers, a different exhibit, a page gap, and the specific 78.009/0601103A misbinding from the review packet).

**RED/GREEN proof** (source reverted via `git stash`, re-run, restored):

| | Tests |
|---|---|
| RED (pre-fix source) | 13 failed, 2 passed / 15 |
| GREEN (fixed source) | 15 passed / 15 |

### 2.4 The 108-assertion audit

Independently re-parsed the exact real fixture (`production-fy2024-army-r2-raw-parser-output-170pages.json`, SHA `1fb74021…`) through the corrected code via a new evidence driver (`scripts/phase10b35-real-parse-driver.ts`, `scripts/phase10b35-artifact-delta.ts`) and diffed against the **original production artifact** (content SHA `be275e2b…`), field-by-field, run-id/hash fields excluded:

| Classification | Count | Disposition |
|---|---:|---|
| Retained | 76 | Unchanged — page header PE/project and the cost-table row identity agree exactly with the artifact binding, confirmed against the publisher text layer |
| Removed | 32 | Gone from the corrected artifact — all four misbound page groups (126/132/161/164), all now `pe_total_row_in_project_table` or excluded-by-boundary; **0** re-emitted, because none were legitimate project-level facts under any identity (the PE-total row is separately and correctly asserted by the R-2 path; per-page project rows on these four pages belong to a different PE than any project ever active on them) |
| Corrected-in-place | 0 | — |
| Unresolved | 0 | — |

Full delta: **document_facts** 57 removed / 0 added / 398 unchanged; **omissions** 47 removed / 0 added / 417 unchanged; **project_funding** 32 removed / 0 added / 76 unchanged; **peTotals** (the 5 PE headline totals from the review packet) **0 removed / 0 added / 50 unchanged** — the corrected parser reproduces every one of the five FY2024 request totals exactly (296.67 / 75.672 / 108.946 / 5.459 / 10.708). `identities`: 0/0 (still exactly 5). Overall: 611 → 522 assertions, 467 → 417 omissions, decision REVIEW / TERMINAL_REVIEW unchanged. Every removed row's page is one of the four known transition pages — confirmed programmatically, not asserted.

### 2.5 Wider regression scope

`src/defense-budget/{rdte,contracts,verification/rules,promotion}` (excludes only the three long-running real-document e2e specs unrelated to this defect): **99 suites / 1727 tests, 0 failures.**

Full `apps/api` typecheck: **18 pre-existing errors, byte-identical before and after this change**, none in a touched file.

---

## 3. Explicit review scope for R-2 facts

### 3.1 Why a new table, not a second `budget_review_decision_v1` row

`BudgetReviewDecisionV1` is enforced as **one terminal decision per candidate** at three independent layers (a DB partial unique index, a BEFORE-INSERT trigger, and the service's own `prior_review_exists` check), and accepting it flips the *whole candidate* to `REVIEW_ACCEPTED`. There is no existing per-assertion scope primitive anywhere in review or acceptance (confirmed by exhaustive grep) — the closest existing thing, `allowedReviewedAcceptances`, is a set of whole `verificationRunId`s. Reusing or widening `BudgetReviewDecisionV1` would have meant either accepting the whole candidate (falsely implying the other ~600 assertions and 575 discrepancies are resolved) or building a parallel per-assertion column onto an append-only, trigger-guarded table not designed for it.

**New table**: `budget_scoped_fact_review_v1` (migration `20280909010000_phase10b35_scoped_fact_review`). Binds candidate/run/source/artifact/manifest identity by exact hash equality (enforced by a BEFORE-INSERT trigger, same discipline as `BudgetReviewDecisionV1`), never approves outside its own `assertionIds`, and is append-only except for the single permitted transition `active → revoked | superseded` (enforced by a BEFORE-UPDATE trigger that also freezes every decision column). A DB-level partial unique index guarantees **at most one active approval per scope key across the whole table** — a fiscal-year PE total can never be served with two different live values.

### 3.2 The policy (`scoped-fact-review-policy-v1.ts`)

Scope kind v1: `rdte_r2_pe_total_request_fy` — one PE's FY "Total Program Element" row, President's Budget request stage. Structured rules, every one reading typed fields of the hash-verified artifact and the persisted checks/discrepancies/proofs — **no message-regex matching anywhere**:

- **Candidate-wide gates**: run decision PASS/REVIEW (never REJECT); candidate status NEEDS_REVIEW/REVIEW_ACCEPTED; zero FAIL+blocking checks; zero blocking-severity discrepancies; every proof snapshot verified; the artifact's own recomputed content hash matches the candidate; the artifact's `source` (family/documentType/budgetCycle/fiscalYear/component/sourcePdfSha256/sourceDocumentId) matches the requested scope exactly.
- **Scope resolution**: exactly one `r2_total_component` pe_total assertion for (PE, FY); base must equal total when no OCO is printed; a `program_element_identity` assertion for the same PE, `contextSource: explicit_header`, on the **same physical page** as the total.
- **Independence** (source-grounded, never "absent from the list"): (1) no approved assertion ID is named by any FAIL/NOT_RUN check or review/blocking discrepancy; (2) every omission/discrepancy on the *same physical page* is classified by **table row** — a finding on the approved row blocks, a finding on a different row is recorded as a disclosed limitation, not silently dropped; (3) **any assertion on the approved page bound to a different PE blocks unconditionally** — this is exactly the Phase 10B-34 misbinding defect class, and it is never waivable even after the parser fix (belt-and-suspenders).

**17 unit tests** cover every rule independently (clean case, each individual refusal reason, the same-row-vs-different-row distinction, the wrong-identity-binding defence, the NOT_RUN-check-naming-the-assertion case, and the unsupported-scope-kind fail-closed path).

### 3.3 Service, CLI, revocation

`ScopedFactReviewV1Service` — dry-run by default; `commit:true` persists exactly one row, reloading and re-hashing the artifact from its durable locator (never trusting a caller-supplied artifact). New CLIs: `review:defense-budget-scoped-fact-v1` (approve/reject, dry-run/commit) and `revoke:defense-budget-scoped-fact-v1`. A revoked/superseded row is immutable and disappears from every subsequent read — proven live in the isolation test (approve → verify visible → revoke → verify excluded → re-approve → verify visible again).

---

## 4. Bounded partial display

### 4.1 API

`GET /api/defense-budget/reviewed-partial-pe-totals?fiscalYear=2024[&component=ARMY]` — gated `capiro-internal` only (same `DefenseBudgetLifecycleInternalGuard`, 404-not-403, as the existing `/api/budget-lifecycle/*` routes), since this is pre-publication partial data. Reads **only** `budget_scoped_fact_review_v1` (`status='active' AND decision='approve'`) — never `program_element_year`, never any `DefenseBudgetCanonicalRow`/snapshot table, never the legacy PE finder. Every row carries fiscal year, `stage:'request'` + a plain-language label, component, base/OCO/total amounts in USD millions, the exact source citation (document id, PDF SHA-256, exhibit, physical page, artifact id + content SHA), `reviewStatus:'reviewed_partial'`, `coverage:'partial'`, and the full limitations list. The response envelope itself carries a `coverageNote` explaining the collection is not complete.

### 4.2 UI

`apps/web/src/vnext/pages/program-elements/reviewed-partial/ReviewedPartialPeTotalsPage.tsx`, routed at `/defense-budget-lifecycle/reviewed-partial` (linked from the existing Lifecycle Health page), capiro-internal gated in-page. Table with base/OCO/total, a linked source citation, a `Reviewed · partial` badge, and an expandable detail panel showing every limitation, the reviewer, policy version, rationale, and full source identity. Deliberately has **no** totals row, ranking, export, or cross-year comparison.

### 4.3 Consumer/leakage audit

Every existing aggregation path (`getSummary`, `listCapabilities`, `getMovement`, the deltas engine, Meri's PE tools, every CSV export, `outreach-truth.service.ts`, `workspace-table.service.ts`) reads exclusively `program_element_year` / `DefenseBudgetCanonicalRow` / legacy tables (confirmed by repo-wide grep during the mapping phase of this work). **`budget_scoped_fact_review_v1` is a brand-new table nothing else queries** — there is no existing consumer to retrofit, and the new controller is the only reader, which labels every row `coverage:'partial'` and never sums, ranks, or compares it against anything else. The whole-collection family-readiness gate (`cycle-family-readiness-v1.ts`) is untouched and does not consult this table.

---

## 5. Proof in isolation (real path, disposable infrastructure)

New end-to-end spec: `phase10b35-scoped-review-e2e.integration.spec.ts` + rehearsal script `phase10b35-scoped-review-e2e-rehearsal.sh` (self-provisions and tears down its own `pgvector/pgvector:pg16` + `minio/minio`, same convention as the Phase 10B-31 driver). Run: `pnpm --filter @capiro/api run verify:phase10b35-scoped-review-e2e:db`.

Exercises the **real** production path: `DefaultParserHandoffAdapter.handoff()` → real page profiler → real router → real `deterministic_pdfplumber` + real `paddleocr` (pages 11–37) → the corrected R-2/R-2A pipeline → real verifier → real `CompositeProofResolver` in `production_proof` mode against a real archived, versioned MinIO object → `persistCompletedVerification` into real Postgres rows → `ScopedFactReviewV1Service` against that real candidate/run → `ReviewedPartialPeTotalsReadServiceV1` against the real table.

**Result: 10/10 passing.**

1. A real, verified candidate is produced through the full production router (not a fixture shortcut) — decision REVIEW, all proofs `verified`, 5 identities.
2. The corrected parser produces **none** of the 32 known-wrong `project_funding` assertions on any of the four transition pages.
3–7. Each of the five FY2024 Army R-2 PE totals is scoped-approved through the real service, persists a real row, is **absent** from the read before approval and **present** after, with the exact publisher-verified value (296.67 / 75.672 / 108.946 / 5.459 / 10.708), correct title, correct page, and the partial-coverage limitation — then revoked (confirmed excluded from the next read) and re-approved (confirmed visible again).
8. A second scoped decision for the same candidate/scope is refused (`scope_already_decided_on_candidate`).
9. The reviewed-partial read returns **exactly** the five approved PE totals — no unreviewed R-2A project-level assertion, no wrong-identity binding, ever leaks in.
10. A second, deliberately REJECT-inducing candidate (no archive evidence) is genuinely REJECTed by the real verifier, and the real DB trigger (`check_budget_scoped_fact_review_v1_binding`) refuses a scoped approval bound to it.

No mock repository stands in for Prisma anywhere in this test; no filesystem-only proof resolver is used.

---

## 6. Independent review

*(To be run before merge — see Deliverables in the handoff. This packet documents the implementation and its own verification; a genuinely independent reviewer re-executing the claims, per this program's standing practice, is a separate step not yet performed as of this packet's authorship.)*

---

## 7. What is NOT done / explicitly out of scope

- **No production mutation of any kind.** Candidate `5522ea3b…`, outbox row `f57a3419…`, and the production drain (`capiro-dev-defense-budget-ingestion-drain:18`) are untouched.
- **No merge, no image build, no deploy, no task-definition change.**
- **No real human-review decision recorded** — `neo@capiro.ai`'s actual approval of these five PE totals happens only when Neo runs the prepared CLI command against production (§8) after reviewing this packet; nothing here fabricates that decision. The isolation test's "approve" actions are test fixtures against disposable infrastructure, never Neo's real review.
- **The R-2 acceptance-policy gap from Phase 10B-34** (the *whole-candidate* `evaluateR1ReviewAcceptanceEligibilityV1` has no R-2-shaped allowed-omission class) is separately being addressed on draft PR #1438 (`feat(defense-budget): govern acceptance of review-only R-2 evidence`) — **not part of this PR**, and not required for this bounded-display path, since scoped review never touches outbox acceptance.
- **Whole-collection completeness is untouched.** `cycle-family-readiness-v1.ts` still requires all 15 RDT&E expected sources and all 10 Army R-2 bundle volumes for FY2024/request before any comprehensive-family claim — this PR adds no path around that gate.
- **The remaining 575 discrepancies (467 review_omission + 108 page_only_reference_proof_failed on project-level rows) are not resolved.** They remain visible as `NOT_RUN`/`review`-severity findings; the scoped-review independence rule accounts for exactly which of them sit on the same page as an approved PE total (none do, for these five) but does not clear them.

---

## 8. Release/activation packet — proposed steps only, NONE executed

Every step below is a **separate, explicit go-ahead**, per this program's standing pattern. This mission stops before any of them.

1. **Independent review** of this PR (attribution fix, scoped-review policy, leakage boundary) — recommended before merge.
2. **Merge** `feat/phase10b35-pe-attribution-partial-display` to `main`. CI is still repo-wide `startup_failure` (unrelated, pre-existing) — expect the same non-signal as every recent merge.
3. **Build + push** a new `capiro/dev/api` image from the merged SHA (ARM64, `--provenance=false`), and a new ingestion-drain image layering the same parser fix (`Dockerfile.defense-budget-ingestion-drain`).
4. **Qualify** the new drain image the same way as Phase 10B-32 (isolated qualification family, real ARM64 Fargate run against the real FY2024 Army R-2 fixture) — confirm the corrected artifact (522 assertions / 417 omissions / 76 project_funding, decision REVIEW) reproduces in the qualification environment.
5. **A separate, explicit decision on the existing candidate `5522ea3b…`.** It was produced by the *pre-fix* parser and still contains the 32 misbound assertions. Options, not decided here: (a) leave it as historical evidence exactly as instructed (never silently transfer its acceptance), and require a **fresh candidate** from a corrected re-parse/re-drain of the same source document before any scoped review is recorded against production data; or (b) if a corrected re-parse can be produced without a full production replay (e.g., a bounded, audited correction/supersession workflow — not built in this mission, since the mission's own scope explicitly deferred it: "No such production workflow executes during this mission"), use that. **Recommendation: (a).** Recording a scoped approval against the existing pre-fix candidate would approve PE totals that are technically correct in themselves (§2.4 confirms the five PE-total rows were never among the 32 misbound assertions) but would leave production's copy of the artifact carrying the 32 known-wrong bindings elsewhere — a fresh, corrected candidate is the more honest artifact of record.
6. **Deploy** the qualified image to `capiro-dev-defense-budget-ingestion-drain` (new revision, current :18 kept for rollback).
7. **A governed replay/re-ingestion** of the FY2024 Army R-2 Volume 1 BA1 source through the corrected drain, producing a fresh candidate (new UUID, distinct from `5522ea3b…`).
8. **Record the real human-review decision** for the fresh candidate (`review:defense-budget-verification-v1 --decision accept --commit`, reviewer `neo@capiro.ai`) — a prerequisite this policy's candidate-wide gate checks but does not itself perform.
9. **Record five real scoped approvals** (`review:defense-budget-scoped-fact-v1 --commit`, one per PE, reviewer `neo@capiro.ai`, a real rationale) against the fresh candidate.
10. **Verify live**: `GET /api/defense-budget/reviewed-partial-pe-totals?fiscalYear=2024&component=ARMY` returns the five rows with correct values/citations, and `os.capiro.ai/defense-budget-lifecycle/reviewed-partial` renders them, using a real authenticated capiro-internal session.

Completion token for that future mission: `PHASE10B35_FIRST_REVIEWED_RECORDS_LIVE` — not claimed here.

---

## 9. Deliverables in this PR

Commits, reviewable separately:
1. Parser repair (`r2a-structural-project-header-parser-v1.ts`, `r2a-project-funding-extractor-v1.ts`) + regression spec + updated pre-existing spec assertions + evidence-generation scripts.
2. Scoped-review schema, policy, persistence, service, CLI.
3. Bounded-display API + module wiring.
4. vNext UI page + route.
5. Isolated end-to-end proof spec + rehearsal script.
6. This packet.

**Tests**: 15 (boundary regression) + 17 (policy unit) + 10 (real e2e isolation) = 42 new tests, all passing; 99 suites / 1727 tests in the wider defense-budget regression scope unaffected; 18 pre-existing `tsc` errors unchanged (0 new, none in touched files).
