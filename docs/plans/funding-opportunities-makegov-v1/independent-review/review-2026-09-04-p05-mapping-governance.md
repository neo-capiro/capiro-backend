# Independent review — P05 Mapping governance hardening (Band A, §6.2 wave)

**Status:** FINAL (attempt 3; attempts 1-2 died to rate limits while still reading)
**Date:** 2026-09-04
**Pinned SHA:** `origin/main` `1c7ed27fa82e171b7d9259f6c94d49e360cae985` (worktree `C:\dev\capiro-review-p05`, verified clean at start)
**Implementation commit under review:** `21d267db` (PR #769) per completion-matrix row P05
**Reviewer lineage:** Claude, general-purpose subagent (model reported by runtime: `claude-fable-5-1`), did not implement P05, P04, P07 or P08. Read-only: no source edits, no commits, no AWS writes, no secret values touched.

## Scope
Plan section `## P05 — Mapping governance hardening` (plan line 646). Questions from the brief:
1. Admin-only approval enforced server-side (not only hidden in the UI)?
2. Can a non-admin approve/reject/edit an intelligence mapping via ANY route (REST, Meri tools, bulk)?
3. Award-bearing/protected mapping sets governed as the plan says; does the web mirror match the API?
4. The FAILING assertion in `intelligence.mapping-governance.spec.ts` ~L414 ("web mirror of the award-bearing set matches the API", `expect(received).not.toBeNull()`) — real regression or fixture rot?
5. Tenant isolation (RLS) intact on mapping tables?
6. Any live-verifiable success assertion for this phase?

## What was / was not trusted
- NOT trusted: completion-matrix P05 row prose, PR #769 description, handoff docs — treated as claims.
- Trusted only after direct observation: code at the pin, test runs I executed, live read-only AWS reads.



## 0. Correcting the brief's premises

| Premise as briefed | What is actually there |
|---|---|
| "any implementer branch (`git branch -r \| grep -i p05`)" | No remote branch matches `p05`. P05 landed as commit `e280d630a` (2026-08-06 18:11 -0400, "fix(intelligence): P05 — mapping governance hardening") inside the batch merge `21d267dbb` (PR #769, branch `agent/fo-p00-baseline-freeze`). There is no separate implementer branch to compare against; the pin is the only source. |
| "Is there a bulk path?" (implied server-side bulk endpoint) | The API has **no bulk endpoint** for mappings. "Confirm All ≥ 60%" / "Reject All < 50%" are web-side loops issuing one `PATCH /api/intelligence/mappings/:mappingId` per row (`IntelligenceMappingsPage.tsx:202-238`, `VNextIntelligenceMappingsPage.tsx:211-247`). Bulk protection therefore has to be evaluated per-PATCH on the server — see F-3. |
| "the web mirror" (singular) | There are **two** web pages: the legacy antd `apps/web/src/pages/settings/IntelligenceMappingsPage.tsx` (mounted at `App.tsx:459`) and the vNext port `apps/web/src/vnext/pages/settings/VNextIntelligenceMappingsPage.tsx` (mounted at `VNextSettingsRoutes.tsx:129`). Per memory, all os.capiro.ai traffic is 100% vNext, so the vNext page is the shipped surface. Both import the same constants from `intelligence-mappings-shared.ts`, but each duplicates the bulk-filter logic inline. Only the legacy page has tests. |

## 1. Evidence gathered (read-only, at the pin)

### 1.1 Route → role map (`apps/api/src/intelligence/intelligence.controller.ts`)
- L213-215: `@Controller('intelligence') @UseGuards(RolesGuard) @Roles('standard_user')` — controller default is `standard_user`.
- L445-446 `PATCH mappings/:mappingId` → `@Roles('user_admin')` (confirm/reject one row).
- L505-506 `POST mappings/:clientId/manual` → `@Roles('user_admin')` (manual pin).
- L523-524 `POST mappings/:clientId/reject-candidate` → `@Roles('user_admin')`.
- L239-240 `POST resolve-all` → `user_admin`; L252-253 `POST mappings/match-contractor-identifiers` → `user_admin`.
- L427 `POST mappings/:clientId/resolve` → **no override, i.e. `standard_user`** — see §1.4 for why this is acceptable.
- No `@Delete` on any mappings path.

### 1.2 RolesGuard (`apps/api/src/auth/roles.guard.ts`, full file read)
Rank table from `packages/shared/src/index.ts:54-59`: `client_portal_user 0 < standard_user 1 < user_admin 2 < capiro_admin 3`. Guard fails CLOSED on missing tenant context, on an unrecognized caller role, and on an unrecognized required role (L30-56). `ValidationPipe` is global with `whitelist: true, forbidNonWhitelisted: true` (`apps/api/src/bootstrap/configure-api-http-app.ts:152-157`), so a body `id` on `ConfirmMappingDto` (controller L68-84, no `id` field) is a 400.

### 1.3 Server-side award-bearing gate (`intelligence.service.ts`)
- `AWARD_BEARING_MAPPING_SOURCES = {contracting, assistance_recipient}` (L105-108).
- `confirmMapping` L3116-3201: tenant-scoped `findUnique` + `client.findFirst` ownership check → 404 (L3132-3136); award-bearing confirm requires `relationshipType` AND `rollUpAwards` **on this request** (L3153-3159); award-bearing reject requires non-blank `rejectionReason` (L3160-3164); writes `reviewStatus/reviewedBy/reviewedAt/rejectionReason` and an `auditLog` row `intelligence_mapping.confirmed|rejected` (L3167-3196).
- `createManualMapping` L2812-2907: same award-bearing gate (L2828-2835), writes `manual_pin`/tier 1/`reviewStatus='confirmed'` + audit.
- `rejectMappingCandidate` L2909-2984: `reason ?? 'Rejected by reviewer'` (L2943, L2957) — **reason is optional** even though the DTO restricts `source` to `'contracting'` (award-bearing). See F-2.

### 1.4 Non-admin `POST mappings/:clientId/resolve` (`resolveMapping` L3008-3104)
Upsert `update` branch touches only `externalName` and `confidence` (L3081-3084); `create` branch writes `confirmed: false, matchBasis: 'fuzzy_name', matchTier: 4` (L3094-3099). A `standard_user` can therefore create unconfirmed candidates but cannot confirm, un-confirm, or un-reject anything. Not a governance bypass.

### 1.5 Rejection durability
- `entity-resolution.service.ts:400-407`: a `reviewStatus='rejected'` row is skipped on rerun unless newly-arrived `exact_uei` tier-1 evidence supersedes a non-UEI rejection; `superseded` always skipped (L408).
- `apps/api/scripts/prune-stale-assistance-recipient-candidates.ts:234,258`: `AND m.review_status <> 'rejected'` in both prune predicates (matrix claim "prune no longer erases rejections" — verified).

### 1.6 Other writers to `client_intel_mapping` (exhaustive grep, non-spec)
Prisma writes exist only in `apps/api/src/intelligence/{intelligence,entity-resolution,firm-onboarding}.service.ts` and `apps/api/scripts/*`. No raw-SQL INSERT/UPDATE/DELETE on the table anywhere in `apps/` or `packages/`. **No Meri tool, skill, orchestrator (`apps/meriv2-orchestrator`), `intel-api`, `workspace`, or `engagement-api` references the table or the `/intelligence/mappings` routes.** `firm-onboarding` `POST firm/import` is `user_admin` (`firm-onboarding.controller.ts:64-65`) and writes `source='lda'` (not award-bearing) — see F-5 for a lifecycle inconsistency.

### 1.7 RLS
Migration `20260608010000_add_tenant_rls_client_intel_mapping/migration.sql:36-40`: `ENABLE` + `FORCE ROW LEVEL SECURITY`, policy `client_intel_mapping_isolation USING (rls_bypass() OR tenant_id = current_tenant_id()) WITH CHECK (...)`. `PrismaService.withTenant` sets `app.current_tenant` via `set_config(..., true)` inside the transaction (`apps/api/src/prisma/prisma.service.ts:157,192`). Live state verified in §2.

### 1.8 Spec run at the pin
`pnpm --filter @capiro/api exec jest src/intelligence/intelligence.mapping-governance.spec.ts src/intelligence/intelligence.manual-mapping.spec.ts --forceExit` → **Tests: 1 failed, 41 passed, 42 total** (`p05-jest-run1.txt`). The only failure is `the page explains the constraint rather than just enforcing it › the web mirror of the award-bearing set matches the API` at spec L412-417 (`expect(received).not.toBeNull()`).

### 1.9 Web behavioural tests at the pin
`pnpm --filter @capiro/web exec vitest run src/pages/settings/IntelligenceMappingsPage.test.tsx` → **17 passed / 17** (`p05-vitest-web.txt`), including "P05 — the PATCH body carries no row identifier › an individual toggle sends the id in the PATH only" and "bulk reject skips award-bearing sources and sends a written reason". These exercise the **legacy** page only; there is no `VNextIntelligenceMappingsPage.test.tsx`.

## 2. Live verification (read-only, `capiro-dev`, us-east-1, 2026-09-04)

### 2.1 What is deployed
`capiro-dev-api` service → task definition `capiro-dev-api:281` (PRIMARY, registered 2026-09-04 05:23 -0400), image digest `sha256:5c4a1c17…`, ECR tag `f2746744d274d3b6a161436f2da19fd5a2ae1e20` = merge of PR #1463, 2026-09-03 23:20 -0400. Ancestry (`git merge-base --is-ancestor`): P05 commit `e280d630a` **is** an ancestor of the live SHA; the live SHA is 2 commits behind the pin `1c7ed27fa`; `git diff --stat f2746744 1c7ed27fa -- intelligence.controller.ts intelligence.service.ts roles.guard.ts entity-resolution.service.ts` is **empty**. The live API runs byte-identical governance code to what this review read.

### 2.2 Live database diag (in-VPC `capiro-dev-api-diag:8`, SELECT-only under `app.bypass_rls`, task `ad2f015edb0447928716485c221cc279`, log stream `diag/db-inspect/ad2f015e…`, output saved as `p05-diag-output2.txt`)
| Check | Result | Reading |
|---|---|---|
| `pg_class` for `client_intel_mapping` | `relrowsecurity=true, relforcerowsecurity=true` | RLS enabled AND forced live |
| `pg_policies` | one policy `client_intel_mapping_isolation`, `cmd=ALL`, `qual = with_check = (rls_bypass() OR (tenant_id = current_tenant_id()))` | matches migration `20260608010000` exactly |
| totals | 7 tenants, 1,945 rows | |
| award-bearing rows `confirmed` with `relationship_type IS NULL OR roll_up_awards IS NULL` | `n_all=2, since_p05=0, since_p05_human_actor=0` | both pre-P05 legacy rows (plan explicitly allows NULL on pre-existing rows); **zero** post-P05 confirmations lack a decision |
| award-bearing `rejected` with blank reason | `0 / 0` | |
| award-bearing rejected rows at all | **none** | the reject paths (PATCH-reject and reject-candidate) have never been exercised on award-bearing rows in this environment |
| `audit_logs` `intelligence_mapping.*` by actor role since 2026-08-07 | `intelligence_mapping.confirmed` × 5, all `capiro_admin`; below-admin count **0** | no non-admin has performed a governance action since P05 |
| `confirmed=true` but `review_status<>'confirmed'` | `lda / candidate × 4` | lifecycle inconsistency, see F-5 |
| rows whose client belongs to a different tenant | **210** | characterised in §2.3 |

### 2.3 The 210 cross-tenant rows, characterised (task `ae21c11e46a240318cb1cd8e9ca8de54`, `p05-diag-output3.txt`)
- Sources: 209 x `lda`, 1 x `lobby_intel`. **Zero** award-bearing rows (`contracting`/`assistance_recipient`) are involved (`xtAwardBearingConfirmed.n = 0`).
- Status: 205 `candidate`, 5 `confirmed`.
- Every row was created between **2026-06-15 and 2026-07-13**, each at ~12:01 UTC (a daily scheduled job), `max(updated_at) = 2026-07-13 12:02 UTC`. Nothing since: the writer went quiet seven weeks before P05 merged (2026-08-06). No `@Cron` lives in `apps/api/src/intelligence/`; the writer was not identified within this review's budget.
- Tenant pairs (mapping `tenant_id` -> client's tenant): C2 Strategies->Maven 117 rows/12 clients; Capiro->C2 Strategies 56/5; C2 Strategies->Capiro 22/2; Capiro->DualSight 13/4; DualSight->Maven 1/1; Capiro->Maven 1/1. Client names recur across tenants ("Converge Medical Technology" in both Maven and Capiro), consistent with a job matching by client *name* across tenants rather than by tenant-scoped id.
- Reachability under the pinned code: `getAllMappingsForTenant` (`intelligence.service.ts:5929-5951`) lists only rows whose `clientId` is among the caller's own RLS-scoped clients, and the row read is itself RLS-scoped, so tenant A cannot see these rows (foreign clientId) and tenant B cannot see them (foreign tenant_id). `confirmMapping` (L3132-3136) would 404 for either tenant's admin. They are **dead rows**: invisible to every tenant UI and un-reviewable through any P05 route; only `app.bypass_rls` scripts can touch them.

## 3. Findings

### F-1 -- The failing assertion is TEST-FIXTURE ROT, not a governance regression. Severity: Low (test hygiene)
**Claim under test:** "the web mirror of the award-bearing set matches the API" (`intelligence.mapping-governance.spec.ts:412-417`).
**Mechanism of failure:** the test regexes `const AWARD_BEARING_SOURCES = new Set<string>([...])` over the *source text* of `apps/web/src/pages/settings/IntelligenceMappingsPage.tsx` (read at spec L387-390). At the P05 merge that literal sat at page L164 (`git show 21d267dbb:apps/web/src/pages/settings/IntelligenceMappingsPage.tsx | grep -n "const AWARD_BEARING_SOURCES"` -> `164:const AWARD_BEARING_SOURCES = new Set<string>(['contracting', 'assistance_recipient']);`). Commit `886ef5eb8` (2026-08-18, PR #1080 "vNext: Settings -- native port of all 14 sub-pages") extracted it to `apps/web/src/pages/settings/intelligence-mappings-shared.ts:138` and left the page importing it (page L31). PR #1080 did not touch the spec; `git log e280d630a..1c7ed27fa -- apps/api/src/intelligence/intelligence.mapping-governance.spec.ts` is empty. The regex therefore returns `null` at the pin and has done so since 2026-08-18.
**The invariant itself holds:** web `AWARD_BEARING_SOURCES = {contracting, assistance_recipient}` (shared L138) is identical to API `AWARD_BEARING_MAPPING_SOURCES` (`intelligence.service.ts:105-108`). Running the spec's own regex against the shared file yields `['assistance_recipient','contracting']`, equal to the API set sorted. The vNext page imports the same constant (`VNextIntelligenceMappingsPage.tsx:15`).
**Collateral rot in the same `describe`:** L406-410 passes only because the page's import line contains the token `AWARD_BEARING_SOURCES`; and all three "page explains" assertions anchor to the legacy antd page, which is no longer the shipped surface (os.capiro.ai is 100% vNext). The fix is to the test (read the set from `intelligence-mappings-shared.ts`; also assert the vNext page carries the tooltips and badge). No change to API or web governance logic is indicated.

### F-2 -- `reject-candidate` on an award-bearing source accepts a missing reason and substitutes a placeholder. Severity: Medium (governance consistency; admin-only, audited)
`RejectMappingCandidateDto.source` is restricted to `'contracting'` (controller L119-121), so this route *only* ever rejects award-bearing identities, yet `reason` is `@IsOptional()` (L129-132) and the service writes `input.reason ?? 'Rejected by reviewer'` on both upsert branches (`intelligence.service.ts:2943, 2957`). The sibling PATCH path enforces a non-blank reason with a 400 (L3160-3164). Plan text: "A rejection writes `reviewStatus='rejected'`, reason, actor, and timestamp"; matrix: "reject requires a written reason". Both shipped UIs send a fixed constant `'Rejected from contractor identity review'` (legacy L638, vNext L627), so no *human-written* reason ever reaches this route from the product. Live impact today: none, because zero award-bearing rejections exist in `capiro-dev`. The route is `user_admin`-gated and audited, so this is not an authorization hole.

### F-3 -- "Bulk actions cannot mutate an award-bearing mapping, including low-confidence reject" is enforced client-side only. Severity: Medium (design limit; admin-only, audited, reversible)
The API has no bulk endpoint; "Reject All < 50%" is a per-row PATCH loop that sends `rejectionReason: 'Bulk rejected below the 50% confidence threshold'` (legacy L226-233, vNext L232-240). That string satisfies the server's only reject-side check (`rejectionReason?.trim()` non-blank, L3160-3164). The in-code rationale at L3149-3151 ("requiring a reason is what a sweep cannot supply") is contradicted by the product's own sweep, which supplies one. What actually keeps award-bearing rows out of the sweep is the web filter `REQUIRES_INDIVIDUAL_REVIEW` (shared L128-131); a `user_admin` calling the API directly can bulk-reject award-bearing rows. Confirm-side bulk *is* server-blocked: a `{confirmed:true}` PATCH on an award-bearing row 400s without relationship + roll-up (L3153-3159). Mitigants: `user_admin` minimum, every write audited with before/after, and a rejection is reversible by an admin PATCH carrying relationship + roll-up.
**Sub-point (Low):** both bulk tooltips say the sweep "Excludes federal-contractor, assistance-recipient, and **PAC-committee** mappings" (legacy L450/L464, vNext L356/L373), but `REQUIRES_INDIVIDUAL_REVIEW` contains only `assistance_recipient` and `contracting`; `fec_committee` is not excluded by the filter and has no server-side guard. Live exposure is nil (3 `fec_committee` rows, all already confirmed, 0 candidates), but the tooltip overstates the protection.

### F-4 -- 210 live `client_intel_mapping` rows carry a `tenant_id` that differs from their client's tenant. Severity: Medium (tenant-integrity anomaly; pre-existing, NOT caused by P05, not reachable through P05 routes)
Evidence in section 2.3. The RLS *mechanism* is intact live (enabled, forced, correct policy body). The *data* violates the invariant `mapping.tenant_id = client.tenant_id` for 210 rows written by a daily 12:01 UTC job between 2026-06-15 and 2026-07-13: after the RLS migration of 2026-06-08 and before P05. P05's own paths are insulated by the double check (`findUnique` under RLS **and** `client.findFirst` under RLS, L3132-3136) and by `getAllMappingsForTenant`'s own-client filter; neither affected tenant can see or review these rows, and no award-bearing row is among them. Residual risk lives in `app.bypass_rls` scripts under `apps/api/scripts/` (prune/generate/backfill) that join `client_intel_mapping` to `clients` without asserting tenant equality. Recommended (out of scope here): a read-first repair script that reassigns each row to its client's tenant or deletes it, plus a nightly integrity query. Reported because the brief asked "is tenant isolation intact on the mapping tables": the enforcement is; the historical data is not.

### F-5 -- `firm/import` creates `confirmed: true` rows without setting `reviewStatus`. Severity: Low
`firm-onboarding.service.ts:286-296` writes `confidence: 1, confirmed: true` and omits `reviewStatus`, so the row lands as `review_status='candidate'` with `confirmed=true`. Live: 4 such `lda` rows. Source `lda` is outside P05's protected set and the route is `user_admin` (`firm-onboarding.controller.ts:64-65`), so no governance bypass, but the P05 lifecycle column and the boolean disagree, and any read filtering on `review_status='confirmed'` misses these rows.

### F-6 -- The shipped (vNext) mappings page has no behavioural test; all P05 web assertions target the legacy antd page. Severity: Low
`IntelligenceMappingsPage.test.tsx` (17/17 pass, including two P05 tests) and the spec's "page explains" `describe` both exercise `apps/web/src/pages/settings/IntelligenceMappingsPage.tsx`. `apps/web/src/vnext/pages/settings/VNextIntelligenceMappingsPage.tsx`, the page os.capiro.ai actually serves (`VNextSettingsRoutes.tsx:129`), has no test file and re-implements the bulk filters inline (L211-247) rather than sharing a function. By inspection the two are behaviourally identical today (same filters, same reason strings, same "Review individually" badge at L494-500), but nothing will catch drift.

### Observations (no finding)
- `POST mappings/:clientId/resolve` is reachable by `standard_user` and writes **unconfirmed** `contracting` candidates from raw trigram similarity (L3033-3048 -> L3094-3099). Its upsert `update` branch touches only `externalName`/`confidence` (L3081-3084), so it can neither confirm, un-confirm, nor un-reject. Not a bypass; at most a noise vector into the admin review queue.
- Two pre-P05 award-bearing confirmed rows lack relationship/roll-up (live `n_all=2, since_p05=0`). The plan explicitly allows NULL on pre-existing rows and read paths treat NULL as "do not roll up".
- The RolesGuard's fail-closed handling of unknown roles (guard L30-56) is what makes "portal AND standard user denied" true for every `@Roles('user_admin')` route, not just the three mapping routes.

## 4. Answers to the brief's questions

| Question | Answer | Evidence |
|---|---|---|
| Admin-only approval enforced server-side? | **Yes.** All three mutation routes carry `@Roles('user_admin')` under a controller-level `@UseGuards(RolesGuard)`; the guard fails closed. | controller L213-215, 445-446, 505-506, 523-524; `roles.guard.ts` L30-56; spec L360-382 (portal + standard denied, unknown role denied) passing |
| Can a non-admin approve/reject/edit via ANY route, incl. Meri tools or bulk? | **No route found.** No Meri tool, orchestrator, `intel-api`, `workspace`, or `engagement-api` code references the table or the routes; no raw-SQL writer exists; the only `standard_user`-reachable writer (`resolve`) cannot change `confirmed`/`reviewStatus`. Live: 0 governance audit rows by below-admin actors since P05. | section 1.6, 1.4, 2.2 |
| Award-bearing sets governed as planned; web mirror matches API? | **Yes on the set, with F-2/F-3 caveats on the reject side.** Sets are identical ({contracting, assistance_recipient}); confirm-side gate is server-enforced on both PATCH and manual-pin; reject-side "written reason" is a non-blank-string check (F-3) and is optional on `reject-candidate` (F-2). | section 1.3; F-2; F-3 |
| The failing assertion: regression or rot? | **Fixture rot** (F-1). The constant moved files on 2026-08-18 (PR #1080); the sets still match. | F-1 |
| Tenant isolation (RLS) intact? | **Enforcement intact live** (enabled + forced + correct policy). **Data has a pre-P05 anomaly**: 210 dead rows with mismatched `tenant_id` (F-4). | section 2.2, 2.3 |
| Any live-verifiable success assertion? | **Yes, three, all verified live on 2026-09-04** (below). | section 2 |

### Does this phase have any live-verifiable success assertion at all?
Yes. Unlike the 2026-08-13 banded reviews (which verified infrastructure, not the product), the following were checked against the running `capiro-dev` database by read-only in-VPC query and against the deployed image:
1. **RLS on `client_intel_mapping`**: `relrowsecurity=true`, `relforcerowsecurity=true`, policy `client_intel_mapping_isolation` with `qual = with_check = (rls_bypass() OR (tenant_id = current_tenant_id()))`. PASS.
2. **Governance invariant on data written since P05**: award-bearing rows confirmed since 2026-08-07 with NULL relationship or roll-up = **0**; award-bearing rejections with blank reason = **0**. PASS (vacuous on the reject side: no award-bearing rejections exist at all).
3. **No below-admin governance actor since P05**: `audit_logs` `intelligence_mapping.*` since 2026-08-07 = 5 rows, all `capiro_admin`; `standard_user`/`client_portal_user` = **0**. PASS.
4. **The live API runs the reviewed code**: task def `capiro-dev-api:281` -> ECR tag `f2746744d2...` (2 commits behind the pin); `git diff` of the four governance files between live SHA and pin is empty. PASS.

What could **not** be verified live without user credentials: an actual HTTP 403 for a `standard_user` PATCH. `/capiro/dev/api` does not log request paths (the only "intelligence/mappings" match in 14 days is a Nest `RouterExplorer` boot line), so there is no traffic-level evidence either way; the unit-level guard test (spec L372-382) is the evidence for that claim.

## 5. Verdict

**`P05_MAPPING_GOVERNANCE_PASS`** -- PASS WITH NON-BLOCKING NOTES.

Every acceptance criterion in the plan's P05 section is met server-side except the reject-side half of "bulk actions cannot mutate an award-bearing mapping", which is met by the shipped UI but is not distinguishable from an individual reject at the API (F-3), and the "written reason" requirement, which the `reject-candidate` route does not enforce (F-2). Neither weakens the authorization boundary: both routes are `user_admin`-minimum, fully audited, and reversible. The failing spec assertion is fixture rot (F-1), not a regression; the governance invariant it guards holds at the pin and live. The 210-row tenant anomaly (F-4) predates P05, is invisible through every P05 path, involves no award-bearing row, and is reported for the program's attention rather than charged to this phase.

**Recommended follow-ups (non-blocking):** (a) repoint the F-1 assertion at `intelligence-mappings-shared.ts` and extend the "page explains" tests to the vNext page; (b) make `reason` required on `RejectMappingCandidateDto` and reject blank strings; (c) either add `fec_committee` to `REQUIRES_INDIVIDUAL_REVIEW` or correct the two tooltips; (d) a `withBypass` repair for the 210 rows plus a nightly `mapping.tenant_id = client.tenant_id` integrity check; (e) set `reviewStatus: 'confirmed'` in `firm-onboarding.service.ts:286`.

## 6. Approval record

**Verdict: `P05_MAPPING_GOVERNANCE_PASS`** -- 2026-09-04, by Claude (general-purpose subagent, runtime model id `claude-fable-5-1`), who did not implement, test, or merge P05 or any phase in its dependency chain. Pinned at `origin/main` `1c7ed27fa82e171b7d9259f6c94d49e360cae985`; live image `f2746744d274d3b6a161436f2da19fd5a2ae1e20` (task def `capiro-dev-api:281`).

**What was executed:** `jest` on the two P05 specs (41/42 pass, sole failure = F-1); `vitest` on the legacy page test (17/17); three read-only in-VPC Fargate diag tasks (`82dde024...` failed on a wrong table name and wrote nothing; `ad2f015e...` and `ae21c11e...` returned `DIAG_OK`); `describe-services`/`describe-task-definition`/`describe-images`/`filter-log-events` reads. No `put-*`, no `enable/disable`, no secret value read or printed (the diag builds `DATABASE_URL` from container env inside the task).

**Hygiene:** worktree `C:\dev\capiro-review-p05` verified at `1c7ed27fa` with empty `git status --short --untracked-files=all` at the end of the review; no probe file was ever written into it (all probes live in the scratchpad). No disposable Postgres was needed (the P05 specs use a Prisma double) and none was created (`docker ps -a --filter name=capiro-p05-review-pg` empty). Nothing staged, committed, or pushed.

**Artifacts (scratchpad `reviews/`):** `p05-jest-run1.txt`, `p05-vitest-web.txt`, `p05-diag.js`, `p05-diag2.js`, `p05-diag-output2.txt`, `p05-diag-output3.txt`, `p05-task-arn*.txt`.
