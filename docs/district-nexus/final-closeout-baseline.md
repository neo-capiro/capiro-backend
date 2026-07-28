# District Nexus — final closeout baseline

Recorded at the start of the PR #635 closeout pass, before any code was edited on
this branch. Every number here was measured in this worktree, not inferred from a
prior PR summary.

- **Repository:** `neo-capiro/capirov2`
- **Branch:** `agent/district-nexus-final-closeout`
- **PR:** [#635](https://github.com/neo-capiro/capirov2/pull/635) — draft
- **Worktree:** `C:\dev\capiro-dn-closeout-wt` (dedicated; `C:\dev\capirov2` was
  left untouched — it is on `fix/legiwatch-completion-l` with unrelated
  uncommitted engagement work)

---

## 1. SHAs

| Ref | SHA |
| --- | --- |
| `origin/agent/district-nexus-final-closeout` at start | `3dd9d2c0fcca7a2860c381f7c96e25cfd593eaa7` |
| `origin/main` at start | `444d883825f1091a62520c468240cd7a73958479` |
| Merge base | `d61b7bcb…` lineage (branch cut before the Strategy Phase 2/3 merges) |
| Merge commit created by this pass | `bbfe607a7a104d48776589e0a2cf3d63c3cf969f` |

**Divergence at start:** branch was **8 commits behind** and **13 commits ahead**
of `origin/main`.

`git merge origin/main` completed with **zero conflicts**. Nothing was dropped;
`git status` was clean before and after. `git add -A` was never used.

### The 13 branch commits

```
3dd9d2c0 fix(district-nexus): align relationship form with review rules
1bb48418 test(district-nexus): cover reviewed grant relationship workflow
8d08b3e8 fix(district-nexus): harden reviewed relationship persistence
fc0453d6 fix(district-nexus): tighten relationship DTO imports
d9e59105 feat(district-nexus): expose reviewed grant relationships in client intel
00883b93 feat(district-nexus): add grant relationship review panel
cc93be5d feat(district-nexus): add grant relationship web API
680b41b9 feat(district-nexus): register grant relationship review surface
e4e74d03 feat(district-nexus): expose reviewed grant relationship API
8dcb061d feat(district-nexus): add reviewed grant relationship service
b032a98d test(district-nexus): pin internal tenant slug fallback
ff631e47 fix(district-nexus): make internal canary gate self-contained
bd31c071 fix(web): preserve unknown states across intelligence surfaces
```

### The 8 main commits merged in

```
444d8838 Merge pull request #634 from neo-capiro/feat/strategy-proto-phase-3
99ac2f1a Merge remote-tracking branch 'origin/main' into feat/strategy-proto-phase-3
bb7800aa Merge pull request #630 from neo-capiro/feat/strategy-proto-phase-2
bc5f6773 feat(strategy): Phase 3 — Watch consistency backend
0ad433f0 Merge pull request #633 from neo-capiro/fix/engagement-trust-boundary-remediation
5ce6f130 Merge origin/main into fix/engagement-trust-boundary-remediation
2cb3287e fix(engagement): make attachment identity and readiness part of the send boundary
1e8d334b feat(strategy): Phase 2 — persistent contextual Meri chat
```

None of them touch `district-nexus`. The merge was mechanically safe.

---

## 2. Changed-file inventory at start (15 files, +2,283 / −172)

| File | ± |
| --- | --- |
| `apps/api/src/district-nexus/district-nexus-flag.guard.spec.ts` | 36 |
| `apps/api/src/district-nexus/district-nexus-flag.guard.ts` | 35 |
| `apps/api/src/district-nexus/district-nexus-relationships.controller.ts` | 218 |
| `apps/api/src/district-nexus/district-nexus-relationships.service.spec.ts` | 257 |
| `apps/api/src/district-nexus/district-nexus-relationships.service.ts` | 830 |
| `apps/api/src/district-nexus/district-nexus.module.ts` | 12 |
| `apps/web/src/pages/HomePage.tsx` | 64 |
| `apps/web/src/pages/clients/TargetsTab.tsx` | 17 |
| `apps/web/src/pages/clients/intelligence-v1/ClientIntelV1Page.tsx` | 15 |
| `apps/web/src/pages/clients/intelligence-v1/district-nexus-relationships-api.ts` | 138 |
| `apps/web/src/pages/clients/intelligence-v1/sections/DistrictNexusRelationshipsPanel.tsx` | 482 |
| `apps/web/src/pages/clients/intelligence-v1/sections/SnapshotSection.tsx` | 101 |
| `apps/web/src/pages/intelligence/ChangesInboxPage.test.tsx` | 36 |
| `apps/web/src/pages/intelligence/ChangesInboxPage.tsx` | 31 |
| `apps/web/src/pages/intelligence/ClientIntelProfilePage.tsx` | 183 |

**No migration and no `schema.prisma` change on this branch.** The
`ClientGrantNexus` and `FederalAssistanceAward` models it writes to already
exist on `main` and are already applied in `capiro-dev`. This matters for the
rollout story: this branch is **code-only**.

---

## 3. Existing failures at start

### CI

The single required check, `verify`, was **failing**
([run 30318469221](https://github.com/neo-capiro/capirov2/actions/runs/30318469221)).
Cause: `@capiro/api#typecheck`, six errors, all in a file this branch added.

```
src/district-nexus/district-nexus-relationships.service.spec.ts(150,24): error TS2352
src/district-nexus/district-nexus-relationships.service.spec.ts(150,53): error TS2493
src/district-nexus/district-nexus-relationships.service.spec.ts(166,23): error TS2352
src/district-nexus/district-nexus-relationships.service.spec.ts(166,52): error TS2493
src/district-nexus/district-nexus-relationships.service.spec.ts(247,23): error TS2352
src/district-nexus/district-nexus-relationships.service.spec.ts(247,52): error TS2493
```

Root cause: the spec harness declares its Prisma mocks as zero-argument
`jest.fn(async () => …)`. TypeScript then infers the call-tuple type as `[]`, so
every `mock.calls[0]![0]` argument assertion is an index into an empty tuple.
This is **branch-introduced**, not a pre-existing baseline failure. Fixed in
this pass by declaring the mock argument types.

- **API typecheck at start:** FAIL (6 errors, all the above)
- **Web typecheck at start:** PASS, clean
- **API typecheck after the fix:** PASS, clean

### Local jest

A fresh worktree reports far more failures than the real baseline unless
`packages/*` are built first — an unbuilt `@capiro/shared` produces ~40 spurious
`TS2307: Cannot find module '@capiro/shared'` typecheck errors and a cascade of
suite-level jest failures. `pnpm --filter "./packages/**" build` is a mandatory
setup step in this repo and was run before any measurement here.

The documented repo baseline is ~40 pre-existing API jest failures across ~12
suites (MCP-SDK jest resolver mapping + drifted hand-mocks). Actual measured
numbers for this branch are recorded in `final-closeout-verification.md`, not
here — this document only pins the starting state.

---

## 4. Known deployment limitations carried into this pass

These are pre-existing operational constraints, restated so the closeout does
not silently violate one.

1. **Never `cdk deploy Capiro-dev-Compute`.** The stack holds dead-ALB values for
   the `app.capiro.ai` Route53 records; a failed deploy repeats the 2026-07-25
   seven-minute production DNS outage. Schedule changes go out-of-band via
   `aws events put-rule` / `put-targets`.
2. **`capiro-dev` IS production.** There is no separate prod environment.
3. **CDK ↔ live EventBridge have drifted** by design (CDK entries ship
   `enabled: false`; live rules are created out-of-band). Both must be
   documented; neither should be "fixed" without intent.
4. **`GenerateGrantOpportunityCandidates` has no live rule** — its 4 rows came
   from a manual run.
5. **The permission classifier blocks** `aws events` mutations and write-intent
   `ecs run-task`. Those commands are prepared for Neo to run via `!`.
6. **No migration is pending for this branch** (see §2), so no migration gate
   applies to merging it.

---

## 5. Exact commands used to establish this baseline

```bash
# probe (read-only)
git -C /c/dev/capirov2 fetch origin --prune
git -C /c/dev/capirov2 rev-parse origin/main
git -C /c/dev/capirov2 rev-parse origin/agent/district-nexus-final-closeout
git -C /c/dev/capirov2 rev-list --left-right --count \
    origin/main...origin/agent/district-nexus-final-closeout
gh pr view 635 --json number,title,state,isDraft,headRefName,baseRefName,\
additions,deletions,changedFiles
gh pr checks 635
gh run view 30318469221 --log-failed

# isolate
git -C /c/dev/capirov2 worktree add /c/dev/capiro-dn-closeout-wt \
    agent/district-nexus-final-closeout

# integrate
cd /c/dev/capiro-dn-closeout-wt
git merge origin/main -m "Merge origin/main into agent/district-nexus-final-closeout"

# build + measure
pnpm install --frozen-lockfile
pnpm --filter "./packages/**" build          # MANDATORY on a fresh worktree
pnpm --filter @capiro/api prisma:generate
pnpm --filter @capiro/api typecheck
pnpm --filter @capiro/web typecheck
apps/api/node_modules/.bin/jest              # run from apps/api
```

---

## 6. Binding sources read before any implementation decision

- `district-nexus-grants-mcp-plan.md` (Revision 2, 1,425 lines) — the primary plan
- `docs/district-nexus/2026-07-27-open-findings.md` — in-repo findings
- `district-nexus-handoff-2026-07-27.md` — blockers B1–B10
- PR #635 body and full diff
- All 26 `apps/api/src/district-nexus/*` files
- All 18 District Nexus web files
- `apps/api/prisma/schema.prisma` (`ClientGrantNexus`, `FederalAssistanceAward`,
  `LegislativeDistrict`)
- `infra/cdk/lib/ingestion-schedule.ts`, `apps/api/scripts/entrypoint.sh`

### PRs #591 and #592

| PR | Title | Disposition |
| --- | --- | --- |
| #591 | `fix(web): stop failed requests from rendering as confident empty/zero answers` | **Superseded.** Commit `bd31c071` on this branch ("preserve unknown states across intelligence surfaces") implements the same intent across the same surfaces. Do not re-apply. |
| #592 | `fix(infra): codify CAPIRO_INTERNAL_TENANT_ID on the api service` | **Still open and still needed for infra**, but commit `ff631e47` on this branch makes the flag guard's internal-canary path self-contained via a tenant-slug fallback, so the API no longer *depends* on that env var being set. Not a merge blocker for #635. |
