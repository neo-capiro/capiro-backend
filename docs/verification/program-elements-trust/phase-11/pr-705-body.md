# Program Elements final closeout (PR #705)

**Single integration vehicle** for Program Elements trust remediation (closeout Phases 0–11).  
**Status:** ready for review — **do not merge** without Neo explicit merge authorization after independent REVIEW 11 PASS.

## SHAs (at Phase 11 implement)

| Ref | Full SHA |
|---|---|
| `origin/main` (base) | `3dcb12f823774b6fae8578dc56fc122bf9a0879e` |
| merge-base | `3dcb12f823774b6fae8578dc56fc122bf9a0879e` |
| Branch tip (Phase 10 PASS / Phase 11 start) | `693eb7093d48376621180ef71d81cfd45be97573` |
| Phase 11 docs tip | `851a4f2941c3e21083d444c1dfd4cb6b38890759` |
| Behind main | **0** |
| Ahead of main | **97+** (product + evidence + Phase 11 closeout docs) |

**Replace-bind (Phase 10 tip truth residual):** fetch `refs/replace/*` when verifying tip tree equality for `693eb7093…` — see `docs/verification/program-elements-trust/phase-10/FETCH_REPLACE_BIND.md`.

## Completed closeout phases

| Phase | Outcome | Notes |
|---:|---|---|
| 0 | Baseline + ledgers | Transport stripped |
| 1 | Canonical write foundation | observation idempotency + outbox |
| 2 | Exact-SHA atomic loaders | fail-closed promotion |
| 3 | SAM complete-window safety | |
| 4 | Current-cycle track-aware reads | FundingClaim |
| 5 | Trust-first web | failed ≠ empty |
| 6 | Data issues + CRM contact-use | |
| 7 | Grounding + coverage matrix | no MeriV2 source edits |
| 8 | Permanent K gates | synthetic goldens loud |
| 9 | Integrated rehearsal | `PE_PHASE_9_OK` harness |
| 10 | Sole-live `env=dev` acceptance | REVIEW **PASS WITH BLOCKERS** on `693eb7093…` |
| 11 | PR closeout | this update — REVIEW **required** |

## Product diff (vs main)

- ~179 files, +27k / −2k (order of magnitude; re-check `git diff --stat origin/main...HEAD`)
- **No** MeriV2 product source edits
- **No** transport `partNNN` / source-export workflows in tip
- Apps: `apps/api` PE domain, scripts, migrations; `apps/web` PE pages; `apps/workspace` grounding helpers; `packages/shared` FundingClaim + coverage

## Migrations (branch vs main)

1. `20260729050000_pe_observation_idempotency_and_outbox`
2. `20260811010000_program_element_data_issue`

Disposable clean + upgrade migrate replay: **PASS** (Phase 9 re-run in Phase 11).  
**Do not** hand-edit `_prisma_migrations`.

## Tests / gates (commands)

From repo root (Windows: use `~/bin/pnpm` → node+corepack):

```bash
pnpm -C apps/api run verify:pe-phase-a   # … through …
pnpm -C apps/api run verify:pe-phase-k
pnpm -C apps/api run verify:pe-phase-9 -- --full --skip-install
pnpm -C apps/api run verify:pe-phase-10  # sole-live; needs Neo auth env
```

**Phase 11 re-run on tip `693eb7093…`:** marker **`PE_PHASE_9_OK`** (`gate.ok=true`).  
Evidence: `docs/verification/program-elements-trust/phase-11/`  
Operator RLS disposable re-run: **23/23 PASS** (`phase-11/rls-rehearsal.log`).  
Soft residual: Prettier PE surface style debt (not hard gate).

Inherited lettered gates A–K all exit 0 under the Phase 9 orchestrator.

## Human accuracy evidence

- Grounded-field goldens are **SYNTHETIC / NOT human-reviewed** (Phase K honesty).
- Do not treat synthetic rows as human goldens.
- Human golden completion remains a separate human block if Neo elevates it.

## Staging / sole-live evidence (authorized Phase 10)

- Plane: **`capiro-dev` / workflow `env=dev` / `app.capiro.ai`** (sole live = prod path; not dead staging)
- Marker: `PE_PHASE_10_OK` implementer; independent review **PASS WITH BLOCKERS**
- Record: `docs/verification/program-elements-trust/phase-10/`
- Live proofs tip (honesty): `28dbed74845a74f1cb432ee4e5d1577827eaf182`
- Plan Verify: `neo_residual` (PE API 401 wall + health 200)
- Dual-tenant live RLS leakN=0; identical_replay + mutation_boundary
- Alarms: synthetic pulse only — **not** humanReviewed

## Coverage limitations

See `docs/program-elements/source-coverage-matrix.md`.

Unsupported / blocked families **fail closed** (no canonical PE year writes), including e.g. MILCON C-1, reserve exhibits, execution/reprogramming feeds, remaining P-5/P-21/P-3A/OP-5 gaps.

## Deployment order (post-merge — **not authorized by this PR alone**)

1. Neo **merge** authorization for #705  
2. Green CI on merge commit  
3. Additive `prisma migrate deploy` on the **authorized** plane only  
4. Deploy API task definition, then web  
5. Smoke: health + PE auth wall  
6. Keep email / canaries / LlamaParse / `derive --commit` **dark** unless separately authorized  

## Rollback order

1. Restore **prior** ECS task defs (Phase 10 capture — pre-ship):  
   - `arn:aws:ecs:us-east-1:967807252336:task-definition/capiro-dev-api:88`  
   - `arn:aws:ecs:us-east-1:967807252336:task-definition/capiro-dev-web:22`  
2. Current tip restore targets (post-ship): api `:89` / web `:23`  
3. Schema: Aurora snapshot if migrate is bad — **never** hand-edit `_prisma_migrations`  
4. Forbidden clusters (`capiro-staging`, `capiro-prod-os-capiro`) must not be targeted by this closeout path  

## Production / shared-env statement

- This PR closeout session **did not merge** to `main`.  
- Phase 11 performed **no** additional shared-environment migrate/deploy, Secrets Manager GetSecretValue, email, LlamaParse, or derive commit.  
- Prior Phase 10 sole-live ship (when Neo-authorized) is evidence under `phase-10/`; merge remains a separate Neo decision.  
- **Production is not “closed out” by draft PR text alone.**

## Ledgers

- `docs/program-elements/final-closeout-work-log.md`
- `docs/program-elements/final-closeout-traceability.md`
- `docs/runbooks/program-elements-trust-gates.md`

## Superseded PE trust PRs

Older lettered PE trust PRs (`#671`, `#676`, `#678`, `#684`, `#689`, `#691`, `#695`, `#698`, etc.) are **closed**; product equivalent lives on this branch. Do not merge them independently.

## Hard boundaries

- No MeriV2 product source modifications  
- Unsupported sources fail closed  
- Synthetic ≠ human reviewed  
- Implementer `PE_PHASE_*_OK` ≠ independent REVIEW PASS  
- Merge/deploy only with Neo explicit auth after closeout review  

## Reviewer focus (Phase 11)

1. Tip is 0 behind main; product diff real; no transport  
2. Phase 9 re-run evidence on final tip; RLS 23/23  
3. PR body matches tree + evidence paths  
4. Ready-for-review without merge  
5. Residuals honest (prettier soft, replace-bind, synthetic goldens, hosted checks may be empty)
