# Phase 8 Defense API — Session 4 closeout handoff

## Verdict

**SESSION4_COMPLETE** for dark inspect-only runtime boundary + dual-path FY27 fixture replay on tip restacked onto current main.

PR remains draft/unmerged. No production cutover.

## Repository coordinates

- Repository: neo-capiro/capirov2
- Branch: agent/phase8-session4-runtime-closeout (updates draft PR #1035 head)
- Base: origin/main @ b00c9e30142e4343fc6f9602b7fca029e42df0cf
- Head: e93262625c8b96587da7e0cea69dc7bcb551cffa
- Session 3 prerequisite: PR #1044 draft, tip SESSION3_COMPLETE (49/49 + docker)

## Delivered this closeout

1. Kept exact Git-tree mirrors under apps/defense-api/runtime-source (parity re-verified after rebase onto main).
2. Kept Phase17RuntimeCoordinator inspect-only composition boundary.
3. Materialized production-equivalent adapters in `phase1-7-runtime.adapters.ts` for all 9 ports (source profile → outbox status) without parser-worker/GPU/promoter credentials.
4. Dual-path FY27 inspect replay script `scripts/phase8-session4-fy27-replay.mjs` writing schema-valid evidence.
5. Verifier hardened: comment-stripped forbidden-token scan, repo-root resolution, Dockerfile node_modules-stomp detection, adapter presence check.
6. Dockerfile hardened to Session 3 src/tsconfig-only COPY pattern (Docker build PASS).
7. Unit tests prove retained vs moved identical lineage hashes.

## Exact commands / results (this tip)

| Command | Result |
|---|---|
| pnpm install --frozen-lockfile | PASS |
| auth/defense-* builds | PASS |
| defense-api prisma:validate | PASS |
| defense-api typecheck | PASS |
| defense-api test | PASS — 29 pass / 1 skipped / 0 fail (includes adapter dual-path tests) |
| defense-api build | PASS |
| verify:session4 | SESSION4_SOURCE_PARITY_PASS |
| phase8-session4-fy27-replay.mjs | PASS unexplainedDifferences=0 |
| verify:session4 --enforce-replay | SESSION4_SOURCE_PARITY_PASS |
| api tsc budget-extraction-contract | PASS |
| api tsc budget-verification-v1 | PASS (after shared build + prisma generate) |
| api tsc budget-parser-router | PASS |
| api tsc rdte-phase-4 | PASS |
| api tsc phase6 | PASS |
| api typecheck:phase7 | FAIL residual 4 TS errors in engagement google/microsoft naming (not in S4 diff; apps/api unchanged by Session 4) |
| docker build defense-api | PASS · capiro-defense-api:phase8-session4-closeout |
| docker smoke serve | fail-closed missing DATABASE_URL/CLERK_SECRET_KEY |
| git diff --check | PASS |

## FY27 replay evidence

- Path: docs/defense-budget/phase8-session4-fy27-replay-evidence.json
- Dual-path over immutable fixture slices present identically under retained + moved trees
- All same* hash flags true; unexplainedDifferences=0; canonicalMutationAttempted=false
- Mode: inspect-only fixture dual-path (no live parser-worker/GPU, no DB, no promotion execution)

## Explicit statements

- AWS mutation: NONE
- Production DB mutation: NONE
- Production data mutation: NONE
- Routing / schedule / IAM / secrets: NONE
- Snapshot activation / canonical promotion: NONE
- Merge: NONE (draft)
- Session 5: NOT STARTED

## Residual

- `pnpm --filter @capiro/api typecheck:phase7` still reports a small engagement-controller "cannot be named" residual set after building shared/meriv2-core. Session 4 does not modify apps/api; treat as environment/baseline residual, not a Session 4 regression. Defense-api gates and enforced FY27 replay are green.
