# Program Elements Final Closeout — Traceability Ledger

**Baseline main SHA:** `057f5480a46f9ba9acf9296a9cc876b609593832`  
**Pre-Phase-0 #705 head (void product):** `a244022648d54d9e4ac7fb071f9f438405659056`  
**Updated (UTC):** 2026-07-30T10:31:22Z

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
| D1 | Explicit field authority map | `recovered` | decoded D patch `program-element-field-ownership.ts` | 1 |
| D2 | Source-document + parse-job write context | `recovered` / partial main B | D writer + main source-document registry | 1 |
| D3 | Raw namespace preservation | `recovered` | `program-element-raw-merge.ts` | 1 |
| D4 | Stable observation keys | `recovered` | migration + backfill script in D patch | 1 |
| D5 | Replay idempotency | `recovered` | writer + specs in D patch | 1 |
| D6 | Field-level winner selection | `recovered` | ownership + writer | 1 |
| D7 | Canonical mutation + outbox one transaction | `recovered` | writer + outbox service + migration | 1 |
| D8 | Durable outbox drain/retry | `recovered` | `drain-pe-change-outbox.ts` | 1 |
| D9 | Reconciliation failure rolls back canonical | `recovered` | reconciliation.service changes in D patch | 1 |
| D10 | Dry-run-first observation audit/backfill | `recovered` | backfill script | 1 |
| D11 | No temporary D workflows/patch blobs in final diff | `missing` until applied cleanly | Phase 0 removed transport; Phase 1 must not reintroduce `.github/phase-d-*` | 1 |
| D12 | Rehearse additive migration in disposable Postgres | `missing` | local disposable only; no shared env | 1 |

**Recovery note:** Apply `phase-d-implementation.patch` onto tip after resolving fuzz against main since mid-stack base `8204a347…`. Then selectively re-home correction patches 1–5 as **new** tests against the applied tree (do not assume intermediate SHAs).

---

## 3. Phase E — Exact-SHA atomic loader contract → Closeout Phase 2

| ID | Requirement | Status | Source | Owner phase |
|---|---|---|---|---|
| E0 | `agent/pe-trust-phase-e` tip == D-v2 transport tip | `recovered` name only | no distinct E product | 2 |
| E1 | Inspect → quality audit → approve exact SHA → atomic commit → safe replay for every PE dollar loader | `missing` (B covers defense-budget package commit path only) | main loaders still heterogeneous | 2 |
| E2 | Default invocation performs no canonical write | `missing`/partial | audit each entrypoint | 2 |
| E3 | `--commit` without approved exact SHA fails pre-mutation | `missing`/partial | B path exists; extend | 2 |
| E4 | LlamaParse only via extract-only + explicit auth | `partial` `in_main` | defense-budget extractors; must not regress | 2 |
| E5 | Prefer checksummed extraction over paid re-parse | `missing`/partial | 2 |
| E6 | Failed promotion cannot become live source head | `missing`/partial | 2 |
| E7 | Observation carries page/span/extractor/units | `missing` beyond D foundation | depends on D | 2 |
| E8 | Loader inventory (RDT&E P-forms, O&M OP-5, J-books, HASC/SASC, HAC-D/SAC-D, NDAA conf, public law, generalized PDF) | `missing` audit | scripts exist on main; contract not uniform | 2 |

---

## 4. Phase F — Complete-window + SAM safety → Closeout Phase 3

| ID | Requirement | Status | Source | Owner phase |
|---|---|---|---|---|
| F1 | Partial runs record `partial`, not success | `recovered` | `origin/agent/pe-trust-phase-f` product | 3 |
| F2 | Only complete runs advance success watermark | `recovered` | same + `embed-watermark.ts` | 3 |
| F3 | Historical backfill separate source/watermark | `recovered` | commit msg + SAM script | 3 |
| F4 | Oversized SAM ranges recursively split | `recovered` | `sync-sam-opportunities.ts` | 3 |
| F5 | Unsplittable single-day overflow stays partial/visible | `recovered` | same | 3 |
| F6 | Notice ID dedupe across splits | `recovered` | same | 3 |
| F7 | SAM HTTPS, host allowlist, SSRF guard, timeouts, size limit, API key redaction | `recovered` | same + specs | 3 |
| F8 | Match persistence preserves accept/reject human decisions | `recovered`/verify | integrate+test | 3 |
| F9 | Opportunity + match writes atomic | `recovered`/verify | 3 |
| F10 | Drop `.github/workflows/pe-phase-f-current-source.yml` on integrate | required | do not bring temp workflow | 3 |

**Product paths on F tip (merge these, not whole historical branch tip-with-main-delta noise):**

- `apps/api/scripts/sync-sam-opportunities.ts`
- `apps/api/scripts/sync-sam-opportunities.spec.ts`
- `apps/api/src/ingestion/embed-watermark.ts` (+spec)
- `apps/api/src/ingestion/sync-run.helper.ts` (+spec)
- `apps/api/package.json` (script/tsconfig entries only as needed)
- `apps/api/tsconfig.pe-phase-f.json`

**Warning:** Three-dot or two-dot diff of F vs main is polluted by **main moving forward after F branched** (funding-opportunities, hearings, etc. show as deletions on older tip). Integrate by **cherry-picking path-limited commits** `107a7f5f0`, `c8ef5c3a1` (and typing follow-ups as needed) onto current main, **not** by merging the branch tip wholesale.

---

## 5. Phase G — Current-cycle track-aware read contract → Closeout Phase 4

| ID | Requirement | Status | Source | Owner phase |
|---|---|---|---|---|
| G1–G12 | Shared funding claim; zero preservation; no latest-nonzero; stage/vehicle separation; no cross-FY %; coverage denominators; contractor evidence classes; missing-mark taxonomy | `missing` | recovery branch has **no** G product files; PR #684 body claimed later G/H publish — **those final G/H branches are not present on origin** as of Phase 0 fetch | 4 |

---

## 6. Phase H — Trust-first PE web UX → Closeout Phase 5

| ID | Requirement | Status | Source | Owner phase |
|---|---|---|---|---|
| H1–Hn | Trust header, caveats drawer, explicit load/fail/partial/unsupported states, deep-link tab+FY, lazy tabs, no projected-enacted substitution, zero charts, copy-with-citation, proof-pack language, P-40 ids, a11y, no fabricated personnel | `missing` | no H branch/product on origin | 5 |

Depends on Phase 4 read contract.

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

## 15. Phase 1 executable handoff prompt

```text
You are executing Program Elements Final Closeout Phase 1 only.

Repository: neo-capiro/capirov2
Branch: agent/program-elements-final-closeout
PR: #705
Base: current main (must match or be merged-forward from SHA recorded in docs/program-elements/final-closeout-work-log.md)
MODE: LONG

Read:
1. docs/program-elements/final-closeout-work-log.md
2. docs/program-elements/final-closeout-traceability.md
3. Phase 1 section of the final closeout plan
4. Recovered Phase D patch at (operator path) C:/Users/neoma/AppData/Local/Temp/pe-patches/phase-d-implementation.patch
   and correction patches in the same directory's .github/ folder — OR re-decode from origin/agent/pe-trust-phase-d-v2 .github/phase-d-implementation.patch{{,.01,.02,.03,.04}} via base64|gzip.

Hard boundaries:
- Do not begin Phase 2+.
- Do not merge or deploy.
- Do not run shared-environment migrations, backfills-with-commit, ingestion commits, derive-chain, email, LlamaParse, Secrets Manager, or infra changes.
- Do not modify MeriV2 source.
- Do not commit transport patch blobs or temporary workflows.
- Preserve main behavior except explicit tested D changes.

Required execution:
1. Verify branch tip is main + Phase 0 docs (or merge main if moved).
2. Apply/reconcile Phase D recovered implementation onto current tip; fix conflicts; drop any .github transport.
3. Implement any D gaps still missing after patch.
4. Add/adjust regression tests for authority, non-owner preserve, unknown authority, replay idempotency, reconciliation rollback, outbox retry, dry-run backfill.
5. Rehearse additive migration in disposable PostgreSQL only.
6. Run verify:pe-phase-a/b/c plus new D tests; compare failures to base SHA.
7. Independent adversarial review.
8. Commit: fix(program-elements): deterministic canonical write foundation
9. Push branch; verify remote diff is product + tests + migration only.
10. Update work log + traceability; return SHAs, commands, rollback, Phase 2 handoff.

Stop when Phase 1 exit gate fails. Do not start Phase 2.
```
