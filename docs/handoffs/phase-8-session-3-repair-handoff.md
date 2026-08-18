# Phase 8 Session 3 — Repair Handoff

## Repository / branch / PR

- Repository: neo-capiro/capirov2
- Branch: agent/phase8-session3-program-elements-repair
- Base SHA (origin/main at this closeout tip): b00c9e30142e4343fc6f9602b7fca029e42df0cf
- Head SHA: 83fa3d6c0… (bug-fix pass on top of the prior closeout tip)
- PR: https://github.com/neo-capiro/capirov2/pull/1044 (draft, OPEN, MERGEABLE)
- Docker gate: CLOSED and re-proven on this tip

## Verdict

**NOT SESSION3_COMPLETE.** A prior session on this same branch recorded `SESSION3_COMPLETE` in this file and in the PR description. That verdict was not justified and is retracted here — do not trust it, and do not repeat it without independently re-verifying business logic, not just route/security shape.

What genuinely holds, independently re-verified by actually running every command (not by trusting this file or the PR's prior claims):
- Route contract (49/49), security boundary (no apps/api imports, no parser/GPU/promoter credentials, no promotion/activation reachability, no PE↔BLIN coercion), and DB tenant/role isolation are real and correct.
- 3 genuine correctness bugs (see below) found via old-vs-new parity mapping against `apps/api` and fixed on this tip, with DB-backed regression tests.

What does NOT hold — the "not stubs, not a mechanical copy of apps/api" claim previously in this file (v. `2daa37438`) is false:
- 5 of 9 Budget Lines methods are unconditional stubs returning empty data.
- PE list, PE detail, and Timeline are each missing large fractions of apps/api's actual response shape (money/funding-claim/signal fields, `fundingSummary`/`billCount`, and the entire per-year enrichment layer respectively).
- `Programs.getProgram` is missing `awards`, `performers`, and several base fields.
- Provenance (`getSources`) is missing most of what constitutes provenance (`exhibitType`, `publisher`, `snippet`, `confidence`, `sourceDocument`).
- See "Known residual gap" below for the full itemized list. This is genuinely a large remaining porting effort, not a documentation gap.

PR remains **draft / unmerged** by design (no merge/deploy). `apps/api` remains sole production owner of these routes. Session 4 may proceed only as dark work on its own branch, but the handoff instruction to "first fully repair and close Session 3" before returning to Session 4 has NOT been satisfied by this tip.

## Exact commands re-run on tip `83fa3d6c0` (bug-fix pass)

| Command | Result |
|---|---|
| `pnpm install --frozen-lockfile` | PASS exit 0 |
| `pnpm --filter @capiro/auth build` | PASS |
| `pnpm --filter @capiro/defense-contracts build` | PASS |
| `pnpm --filter @capiro/defense-domain build` | PASS |
| `pnpm --filter @capiro/defense-client build` | PASS |
| `DATABASE_URL=... pnpm --filter @capiro/defense-api prisma:validate` | PASS — schema valid |
| `pnpm --filter @capiro/defense-api typecheck` | PASS |
| `pnpm --filter @capiro/defense-api test` (no DB) | PASS — 43 pass / 4 skipped (DB-gated) / 0 fail |
| `pnpm --filter @capiro/defense-api build` | PASS |
| `pnpm verify:phase8-session2` | PASS — SESSION2_BOUNDARY_PASS |
| `pnpm verify:phase8-session2:db` | PASS — SESSION2_DB_REHEARSAL_PASS (36 checks) |
| `pnpm verify:phase8-session3` | PASS — SESSION3_BOUNDARY_PASS · 49/49 |
| `pnpm verify:phase8-session3:db` | PASS — SESSION3_DB_REHEARSAL_PASS (31 checks) · downstream test suite 53/53 (incl. all 3 bug-fix regressions) |
| `pnpm verify:phase8-session3:parity` | PASS — 2/2 (pb-comparison only; see gap below) |
| `docker build -f apps/defense-api/Dockerfile -t capiro-defense-api:phase8-session3 .` | PASS exit 0, rebuilt from source (not cache-stale) |
| Image smoke `docker run … serve` (no secrets) | Independently re-verified fail-closed: `DATABASE_URL is required; CLERK_SECRET_KEY is required` |
| `git diff --check` | PASS |

Route count: **49/49**. DB rehearsals: Session 2 (36) + Session 3 (31, incl. new downstream handoff) both PASS on this tip. Docker: PASS.

## 3 real bugs found and fixed this pass

Found via old-vs-new parity mapping against `apps/api` (not by the static verifier, which only checks route/security shape):

1. **Money-semantics violation** — `isCanonicalDecimalStringV1` accepted trailing-zero decimal strings (`"1.20"`) that `apps/api`'s `isCanonicalDecimalString` refuses; `findById` didn't renormalize `NUMERIC(24,9)` scale-padding (`"1.25"` → `"1.250000000"`) on read. Fixed in `promotion/manual-override-service-v1.ts` / `promotion/manual-override-repository.prisma.ts`.
2. **Real logic bug** — `findLatestForTarget` filtered only on `(canonicalEntity, canonicalNaturalKey)`, dropping `fundingField`, causing false-positive `target_has_open_proposal` refusals across independent fields on the same PE/FY. Fixed by adding `fiscalYear`/`fundingField` to the WHERE clause (matching `apps/api`'s adapter exactly).
3. **Data-loss / correctness risk** — `Programs.mergePrograms` bulk-`updateMany`'d aliases/matches with no collision handling (would abort on any real unique-constraint collision) and hard-deleted the loser `Program` row instead of retiring it. Fixed to dedupe per-row and retire (`status='merged'`).

Fix 3 needed additive grants (`UPDATE` on `program`, `DELETE` on `pe_program_match`) for `capiro_defense_serve` — added to this branch's own not-yet-merged migration (see below), disposable rehearsal DB only.

All 3 have DB-backed regression tests (`*.integration.spec.ts`, gated on `REHEARSAL_DATABASE_URL`/`REHEARSAL_SERVE_URL`), and `verify-phase8-session3-db.sh` now hands off to the full defense-api test suite at the end (step 10), mirroring Session 2's rehearsal script.

## Known residual gap — real, itemized, NOT fixed this pass

Four independent research passes mapped every route against `apps/api`. Old-vs-new parity test coverage is currently 1 route (`pb-comparison`) out of the ~15 representative routes the Session 3 acceptance criteria require. What's actually missing or reduced:

- **PE list**: ~20 enrichment fields missing (money/funding-claim/signal fields) — returns raw rows only, no `markup-monitor` mode.
- **PE detail**: missing `fundingSummary`, `billCount`, `currentCycleFy`, plus 8 base-PE columns absent from defense-api's Prisma schema.
- **Timeline**: missing the entire per-year enrichment layer (funding claims, cycle classification, conference-prediction integration) — the largest single gap.
- **Provenance (`getSources`)**: missing `exhibitType`, `publisher`, `snippet`, `confidence`, `sourceDocument`; also returns `{data:[...]}` where apps/api returns a bare array, and has no PE-existence 404 check.
- **Related programs / provisions / opportunities**: field loss (esp. `evidence`, `evidenceTier`, `whyShown`, `confidenceBand` on related-programs) and a divergent `attributionCaveat` wording on provisions; opportunities is the one route that's actually close to faithful.
- **Budget Lines**: `getActions`, `getMovement`, `listCapabilities`, `getCapabilityRecommendations`, `searchCapabilityLines` are unconditional stubs (always empty). `getIncumbents` uses a materially weaker 2-tier dedup model vs apps/api's 3-tier fuzzy-match model. `getGraph`/`getRelationships` have field-naming and enrichment-field divergences.
- **Programs.getProgram**: missing `awards`, `performers`, `component`, `capabilityArea`, `acquisitionPathway`, `description` entirely (columns don't exist in defense-api's Prisma model).
- **Programs.listMatchQueue**: wrong filter semantics for `status='all'` (returns every status, vs apps/api's candidate+quarantined-non-weak) and a different default page size (25 vs 50).
- **Programs.resolveMatch**: no curated-seed protection (`evidenceTier==='mdap_curated'`), and blocks idempotent re-resolution that apps/api allows.
- **Programs alias CRUD**: missing type-stoplist, duplicate-detection, and last-canonical-alias-deletion guards apps/api enforces.
- **Data issues**: `suggestedSourceUrl` silently dropped end-to-end (column exists, physically never populated via this path); `fy` range, `fieldName` allowlist, `resolutionNotes` trim/length-cap, and list `status` filter are all unvalidated at the service layer (DTO-level validation still applies over HTTP, but a direct service call bypasses it).
- **peCode normalization is inconsistent** across nearly every method — some trim+uppercase+throw (`requirePeCode`), others trim-only-and-silently-empty, others do nothing at all. Worth a dedicated pass to make this consistent, separate from the enrichment-field gap.

Closing this is comparable in size to a fresh multi-session build, not a follow-up patch — scope and staff it as its own piece of work rather than absorbing it into a "done" verdict.

## New DB grants (disposable rehearsal only)

Migration `apps/api/prisma/migrations/20261120210000_phase8_defense_serve_user_resolver/migration.sql`, as of this tip:
- `capiro_defense_resolve_member(tenant_id, clerk_user_id)` SECURITY DEFINER
- `GRANT INSERT, UPDATE ON defense_budget_manual_override TO capiro_defense_serve` (no DELETE — records are immutable/versioned)
- `GRANT SELECT, INSERT, UPDATE, DELETE ON program_alias TO capiro_defense_serve`
- `GRANT SELECT, UPDATE, DELETE ON pe_program_match TO capiro_defense_serve` (DELETE added this pass, for merge-dedup)
- `GRANT UPDATE ON program TO capiro_defense_serve` (added this pass, replacing the unused DELETE grant — mergePrograms now retires, never deletes)
- Never applied to shared/production DB — disposable rehearsal containers only.

## Explicit statements (hard scope limits — all honored)

- AWS mutation: **NONE**
- Production DB mutation: **NONE** (disposable containers only)
- Production data mutation: **NONE**
- Routing change: **NONE**
- Schedule change: **NONE**
- IAM/secrets change: **NONE**
- Snapshot activation: **NONE**
- Canonical promotion: **NONE**
- Merge: **NONE** (PR draft)
- Session 5: **NOT STARTED**

## Prior tip history

Earlier tip `04e7ec6ce` closed Docker after restack onto `d14e1d161…`. Tip `2daa37438` restacked onto `b00c9e301…` and recorded a `SESSION3_COMPLETE` verdict that a fresh independent review (this tip, `83fa3d6c0`) found was not justified — route/security work was solid, but most business logic across the 49-route surface was missing or reduced, and 3 of the pieces that did exist had real correctness bugs. Those 3 bugs are fixed here; the enrichment-field gap is not.
