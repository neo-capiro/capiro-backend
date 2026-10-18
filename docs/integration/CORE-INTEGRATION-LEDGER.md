# Core integration ledger — 2026-10-18

Branch `fable/core-integration-20261018` → `backend-import` (`c76f5fc0df6688743afeec274211afd2e67fe8f1`).
Owner: Fable (Core lane). Coordination: meri-greenfield PR #121 ("Fable Core lane:" posts).

State vocabulary follows `docs/deployment/CAPIRO-REMAINING-DEPLOYMENT-PLAN-20261017.md` §3.
This branch is **integrated (source)** only. Nothing here is qualified, deployed or live-verified,
and no migration was run against any database. Merging this PR is not a deployment.

## 1. Merged inputs

Every merge is `--no-ff` (no squash/rebase); each input's own commits are preserved.
Heads were re-read with `gh pr list` at the start of the lane (2026-10-18 ~03:50 UTC) and match the brief.

| Order | Input | Full SHA | Also brings in (already ancestors) |
| --- | --- | --- | --- |
| 1 | PR #83 first-chat auth listener reconcile | `9ab565f4fb9425828751a0a82c95f8634eb49fe4` | #1, #4–#17, #20–#24, #26, #31, #40, #41, #43, #45, #48, #62, #67, #78, #81 |
| 2 | Fable `fable/core-meri-control-credential-20261017` (deployed preview Core, task def rev 2) | `ade7fc883b7459cbc50e6f71d40ce3644bace5ea` | — |
| 3 | PR #80 cleanup PR71–77 replayed on PR78 | `00ebd1ac17332d50a6c6c5843ea2d07c1258c9bf` | — |
| 4 | PR #79 remaining app plan (docs) | `5f719149da2d8d011f1ab980a950d9692585826e` | — |
| 5 | PR #77 backend cleanup chain | `1b232adc3f40fdefba327caee4e5ef1eb6ef365d` | #44, #46, #47, #55, #65, #69, #71, #72, #75, #76 |
| 6 | PR #74 Objective/Strategy/Planner index | `e5c8f920ace2625e17e9c182c567184d38520c79` | #42, #49, #50, #51, #53, #56, #57, #58, #60, #61, #63, #64, #66, #70, #73 |
| 7 | PR #82 governed reads asOf + meeting ownership | `fca52341fd0490e769112071e6b72cfeceaf4e55` | #27, #33, #35, #52, #59, #68 |
| 8 | PR #37 retained Florida fixture repair | `1b9fedc5bd476311d9234ca4b549ff3ebb14ab2d` | — |
| 9 | PR #38 retained read producer mapping (docs) | `384325afaaf7ad34aeb9ff9b2f183d667ee17343` | — |
| 10 | PR #54 portable Objective/Meri handoff (docs) | `ee00f6d2cbf76ad83f6c8a354ed22a2a931566df` | — |
| 11 | PR #18 runtime candidate migration-history/handoff evidence (docs) | `f4f9e1361d92ac0afadd67c1cae3f5faefa829ec` | implementation `91399fe1` was already the merge base with #83; only its five later docs commits were missing |

Union was computed by `git merge-base --is-ancestor` of every open PR head against the listed tips,
plus a subject and `git patch-id --stable` comparison of every uncontained commit (no equivalents found).

### Open PRs deliberately not merged (unreceived candidates, not abandoned)

dot's disposition review (meri-greenfield #121 comment 6245425248) agrees with these holds provided the
distinctions below are kept. None of these PRs has explicit abandonment evidence; each stays open as
evidence or as a future receiving candidate.

| PR | Head | Disposition | Next owner |
| --- | --- | --- | --- |
| #2 → #3 read-only internal preview API | `3509438f` | Optional separate read-only API; #3 records ordinary API mode as selected. Do not introduce an alternate bootstrap/auth path automatically; evidence retained in the PRs. | dot |
| #19 Perl runtime backport | `3b7affb1` | Functionally superseded by #45's broader installed-package upgrade with version checks and `--no-remove` (present here). Do not reapply the old Dockerfile patch. | — |
| #25 held Core preview on existing database | `6949c5ab` | Generic held-preview alternative; the selected first-chat path is #44 → #62 → #78 → #83. Preserve as alternative/history; do not merge its conflicting service bindings. | dot |
| #28 Engagement preview proposal | `51678e12` | 25 inactive proposal/evidence files, no product behavior. #27 Engagement plan behavior **is** received here and must not be removed by implication. | dot |
| #29 Defense operator duplicates | `4e0c189c` | Duplicate Defense operator removals; potentially portable after caller review. | dot |
| #30 Web/Defense mirror retirement | `7b6bda7c` | Conflicts with currently retained consumers. | dot / Neo |
| #32 Directory detail mappers | `0483963a` | Distinct from #75–#77 mappers; needs isolated reconciliation. | dot |
| #34 federal readers / unused Engagement builders | `f3ede4fe` | Potentially portable. | dot |
| #36 raw Meri loop + API V2 retirement | `a2e3eee2` | Awaits consumer proof. | dot |
| #39 legacy outreach enrichment | `8d3c7422` | Flag-on relationship overlay has no recorded equivalent. | dot |

The 10-16 cleanup chain (#29 → #30 → #32 → #34 → #36 → #39) is exact ancestry, but is **not** superseded by
#80: #39 and #80 diverge (ahead 60 / behind 32) and #80 receives only PR71–77. Authoritative retained-consumer
record: `docs/backend-cleanup/20261017/PR78-CLEANUP-RECEIVING-20261017.md` (from #80).

#37's fix `cbe15efc` is positively absent from #82; verified the received
`apps/intel-api/src/tracker/editorial/retained-florida-read.service.spec.ts` is byte-identical to `1b9fedc5`.
#54 is a docs custody archive; #74 already contains #51 `81dd0313` and therefore the #49–#51 Planner continuation.

## 2. Conflict resolutions

Rule applied: union of intent; never drop another author's behavior; on security-relevant code
(Clerk verification, authority receipts, tenant guards) keep the stricter check. **SEC** marks those.

| # | Merge | File(s) | Resolution |
| --- | --- | --- | --- |
| R1 **SEC** | #83 ← `ade7fc88` | `apps/api/src/auth/clerk.service.ts` | Kept #83. Both implement the same marked-template control credential (`meri_control_credential: true`, no `sid`, `jti`/`iat`/`exp` shape, ≤7-day lifetime, 2 s online `getSessionList` active-session check, `meri-template:<jti>` pseudo-session). #83 is stricter: the generic `assertActiveApplicationAuthoritySession` **denies** marked tokens, and only `tenant-context.middleware` admits them, only at exact POST `/api/clio/application-authority/{identity,context,membership}`, with an early online check before any tenant DB work. See D1 for the behavior only `ade7fc88` had. |
| R2 **SEC** | … ← #82 | `apps/api/src/auth/clerk.service.ts` | Union: kept #83's `assertActiveMeriControlCredentialSession` and #35's `assertRetainedApplicationAuthorityIssuer`. |
| R3 **SEC** | … ← #82 | `apps/api/src/tenant/tenant-context.middleware.ts` | Union of imports (preview-native-read + retained-native-authority). `no-store` path list: took #82's superset (adds retained paths and case/trailing-slash normalization; the three authority paths are unchanged). Checked the auto-merged body: retained capture goes through `readApplicationAuthority`, which denies marked tokens off the three control POSTs; `requiresVerifiedRetainedNativeAuthority` calls the native-only session check, so a control credential can never mint or refresh retained authority. #83's early marked-token refusal is unchanged. |
| R4 | … ← #82 | `apps/api/src/auth/application-authority.module.ts` | Union: controllers `ApplicationAuthority`, `ApplicationMembership`, `ApplicationReadModeObservation`; providers `ApplicationMembershipService`, `PreviewNativeReadService`, `ApplicationReadModeObservationService`, `ToolServiceSecretGuard`; export `PreviewNativeReadService`. This mounted #68's `POST /api/clio/application-authority/read-mode-observation`, which the Meri integration branch calls. **Superseded by R10.** |
| R5 **SEC** | … ← #82 | `apps/api/src/auth/application-authority.module.spec.ts` | Union: #68 read-mode imports, request path type and the new read-mode `describe`; kept HEAD's stricter membership tests (`user_admin`/`capiro_admin` wall test, `client_portal_user` below the `standard_user` floor → 403, bearer-denial `no-store`). `application-membership.service.ts` is byte-identical on both sides. |
| R6 | … ← #82 | `apps/api/src/auth/application-membership.spec.ts` (add/add) | Kept HEAD (adds the `preview-native-read-mode.js` port the merged middleware imports). |
| R7 | … ← #82 | `apps/api/prisma/schema.prisma` | Union: Objective workload delegation/decision/issuance/delivery/proof-use models (#42) and Engagement plan models (#27). `prisma validate` and `prisma generate` pass. |
| R8 | … ← #74 | `docs/objective-automation-reconciliation-20261015/MIGRATION-ALLOCATIONS.json` | Union of both reservations (`20281016010000_client_objective_workload_delegations`, `20281016020000_clio_conversation_bootstrap_receipts`), sorted by `allocatedAt`; `recordedAt` = later of the two. |
| R10 **SEC** | post-merge (`8baab30b`) | `auth/application-authority.module.ts`, new `auth/application-read-mode-observation.module.ts`, `auth/tool-service-secret.guard.ts`, `auth/meri-evidence-mode-reads.ts`, `app.module.ts` | Fixes D10 as agreed with dot (#121 6245567839). `ToolServiceSecretGuard` + `hasVerifiedToolServiceIdentity` moved to `auth/`; the evidence-mode read list and predicate moved to `auth/meri-evidence-mode-reads.ts`. The old `meri/` paths re-export them, so there is one guard class for DI and one WeakSet of verified requests. The read-mode service still needs `@capiro/meriv2-core` (evidence-accuracy rollout config), so the read-mode controller/service are mounted by a sibling `ApplicationReadModeObservationModule` that imports `ApplicationAuthorityModule`, which now exports `ApplicationMembershipService`. `ApplicationAuthorityModule` is back to #83's shape. Route, guard, roles and membership rechecks are unchanged. The boundary spec passes unweakened, and a new compat spec pins the re-exports to the same objects. |
| R9 | … ← #77 | `infra/cdk/{bin,lib/preview}/…first-chat-core.ts`, `infra/cdk/test/preview-first-chat-core.spec.ts`, `docs/first-chat-preview-core-deployment-20261016.md` (add/add) | Kept the PR48/#83 lineage: same author's later successor of #44's files (PR48 qualified digest, no ECR registry stack, no master-credential migration task, host guard split, priority-1/2 rules). #44's other files (ledger audit tooling under `infra/deploy/first-chat-*`) merged unchanged; see D7. |

All other files merged without conflict, including identical PR71–77 changes arriving from both #77 and #80.

Post-merge fixture repair (commit `b2c23f77`, test-only): the merged middleware requires
`preview-native-read-mode.js` and `clerk.service.js` (#83 lineage) and `retained-native-authority.js`
(#82 lineage). The VM-loader specs `application-authority.spec.ts`, `application-membership.spec.ts` and
`retained-native-authority.spec.ts` each mapped only their own lineage's imports. Each harness now maps the
real modules; no assertion changed.

## 3. Checks run (quick only)

Node 24.19.0, pnpm 9.12.0, frozen lockfile install (dedicated store; the shared pnpm store had a truncated index
entry). All on the integrated tree.

| Check | Result |
| --- | --- |
| `prisma validate` + `prisma generate` (apps/api, schema changed) | pass |
| `turbo build` of api / api-strategy workspace deps (defense-contracts, shared, meriv2-core, defense-domain, strategy-verifier) | pass |
| apps/api `nest build` | pass |
| apps/api `tsc --noEmit --rootDir .` (needs `--max-old-space-size=8192`; the default 4 GB heap OOMs) | pass |
| apps/api-strategy `nest build` | pass |
| apps/api-strategy `tsc --noEmit` | pass after `12ce8b79` (D11 fixed: `rootDir` moved to `tsconfig.build.json`) |
| apps/api-strategy `nest build`, after `12ce8b79` | pass; `dist/main.js` layout unchanged |
| api-strategy jest: Objective reader-v2 receiving + runtime specs | 53/53 |
| apps/intel-api `tsc --noEmit` | pass after test-only fix `34ffe8ec` (three `mock.calls[0]![n]` narrowings in #37's spec) |
| Jest `--runInBand`, 24 suites that import a conflicted file (auth, tenant middleware, portfolio layout, Objective mount/work status, admin/tenant-admin, newsletter, identity outbox) | 23/24 suites, 451/452 tests pass. The one failure is the `application-authority-boundary` spec, pre-existing at #82 (D10). First run had 3 more failing suites from missing VM ports; fixed in `b2c23f77`. |
| intel-api `retained-florida-read.service.spec.ts` | 36/36 |
| After R10 (`8baab30b`): apps/api `nest build`, `tsc --noEmit --rootDir .` | pass, pass |
| After R10: 18 suites touching the guard, read-mode or evidence-mode list (`application-authority-boundary`, authority module/spec/membership, read-mode controller/service, guard + compat, meri funding observation (+http), tools registration/award/federal-grants/program-elements, action-proposal/RP/attachment HTTP transports) | 17/18 suites. **Boundary spec passes.** The remaining red is `meri-tools.program-elements-mode.spec.ts`, pre-existing at #82 (D12). The RP transport spec needed `@capiro/meriv2-orchestrator` deps installed; after that, 8/8. |

Not run: full API/intel/strategy suites, DB-backed or native PostgreSQL
qualification, CDK synth, image build/scan, any e2e/browser test. Those belong to the integrated candidate.

## 4. Held feature flags and fences (unchanged by this branch; nothing was enabled)

| Flag / fence | Default | Effect |
| --- | --- | --- |
| `PREVIEW_NATIVE_GETS_ENABLED` (api config) | `false` | Native-session preview GETs `/api/me`, `/api/clients`, `/api/clients/:id`; only the pinned first-chat task opts in. |
| `OBJECTIVE_PLANNER_CONTINUATION_ENABLED` (api + api-strategy) | unset → off | Server Planner continuation worker. |
| `OBJECTIVE_STRATEGY_INTAKE_ENABLED` (api) | unset → off | Fresh Strategy intake. |
| Objective admission runtime (`createObjectiveAdmissionRuntime()` zero-arg factory) | disabled | `/api/internal/objective-workload-authority/decisions` refuses issuance. |
| Strategy acceptance receiving factory (api-strategy `PlannerModule`) | closed | Needs Core native/retained-access/credential owners and Meri custody. |
| `client_objective_workload_delegations` `CHECK(enabled=false)` | SQL fence | Delegations cannot be enabled by flags. |
| `RETAINED_READ_SOURCE_ENABLED` | `false` | Retained read authority (module also unmounted, below). |
| `MERI_TOOLS_REQUIRE_SERVICE_SECRET`, `MERI_EVIDENCE_ACCURACY_MODE`, `MERIV2_ACTION_PROPOSALS_ENABLED`, `MERI_POLICY_PACK_SOURCE` | as before | Unchanged existing Meri tool/rollout switches. |
| Frontend `governedPlannerReadEnabled`, `governedStrategyIntakeEnabled` | `false` | Frontend repo; recorded for completeness. |

## 5. Wiring inventory

Static scan of `apps/api/src` (module reachability from `AppModule`, controllers registered in reachable
modules), cross-checked against every Core path the Meri integration branch calls
(meri-greenfield `fable/meri-integration-20261018` @ `39278a978f10a3ee551c665432ffe154fe0a3205`).

### Wired / mounted

| Meri or Objective need | Core surface | State |
| --- | --- | --- |
| Identity / context / membership receipts | `POST /api/clio/application-authority/{identity,context,membership}` (`ApplicationAuthorityModule`) | mounted |
| Control credential at those three POSTs | `tenant-context.middleware` + `ClerkService.assertActiveMeriControlCredentialSession` | mounted (#83) |
| Native read-mode observation | `POST /api/clio/application-authority/read-mode-observation` (`ApplicationReadModeObservationModule`) | **wired by this branch** (R4, R10) |
| Conversation bootstrap | `POST /api/clio/conversations/bootstrap` (`MeriModule`) | mounted |
| Governed reads incl. funding/KB asOf and meeting ownership | `POST /api/clio/tools/:name` (`MeriModule`, `ToolServiceSecretGuard`) | mounted; every tool name the Meri branch calls resolves in `meri-tools.service.ts` / `federal-market-meri-tools.service.ts` except `get_florida_budget_project` (below) |
| Client ref check | `POST /api/clio/clients/check-ref` | mounted |
| Preview native GETs | `/api/me`, `/api/clients`, `/api/clients/:id` | mounted, flag-held |
| Objective generation reads/commands | `/api/clients/:clientId/objectives/:objectiveId/generation` (`ClientsModule` → `ObjectiveWorkModule`) | route mounted (source only); **not complete**, see W2–W4 |
| Objective workload decisions | `POST /api/internal/objective-workload-authority/decisions` | route mounted; admission disabled, **not complete** (W2) |

`/api/memory/proposals/{list,propose,status,correct}` in the Meri branch are Meri control's own routes
(`apps/control/memory/routes.mjs`), not Core calls.

### Remaining (not pure composition — needs authority, credentials, infra or a product decision)

Completion-ledger items. Merged source is **not** completion for any of them, and the chat completion gate stays
closed for a family until its row is wired or deferred by a Neo record.

| Item | What exists | What is needed | Owner |
| --- | --- | --- | --- |
| W1 Retained reads (§8.2 L5a–L5c) | `RetainedPrincipalModule`, `RetainedReadAuthorityModule`, `RetainedFloridaCurrentController` are deliberately unmounted with ports `null` and `RETAINED_READ_SOURCE_ENABLED=false`; intel-api `RetainedFloridaReadModule` ports `null`, unmounted | Mounting alone is insufficient (dot). It also needs: an admission path for signed `CapiroRetained`/`CapiroRetainedAuthority` frames past the Bearer-only middleware; issuer/verifier keys, audience and transport ports; `sourceEnabled`; mounting intel-api's module; and an activation decision. Florida budget goes on the signed intel route, not a tools fallback | Fable + dot |
| W2 Objective admission issuance | `createObjectiveAdmissionRuntime()` disabled factory | Qualified genuine admission/base authority and purpose-qualified credentials (Core decision RS256) | Fable |
| W3 Strategy acceptance/results receiving | Zero-arg closed factory in api-strategy `PlannerModule` | Core native/retained-access/credential owners + qualified Meri custody (`meri_objective_source.custody`) | Fable |
| W4 Planner continuation / Strategy intake | Code mounted, flags off | Flag flip only after W2/W3 + migration reconciliation | Neo/dot |
| W5 Preview listener scope | #83 CDK: priority 1 = bootstrap + 3 authority POSTs, priority 2 = 3 GETs, priority 3 host-only 404 guard | Every Meri→Core requirement is enumerated in **§8 Preview listener deployment packet**. No listener mutation during integration; dot reviews read-only and coordinates the one change set | dot (listener) / Fable (packet) |
| W6 New Core image | `first-chat-core.ts` binding accepts only PR48 source `6542f5b0…` / digest `sha256:722a4832…` | Build + scan an image from this branch's tip, then re-pin source/digest/`RELEASE_SHA` (and set `PREVIEW_NATIVE_GETS_ENABLED=true` only on that task) | Fable (when builds are authorized) |
| W8 Meri memory M2 routes | Meri control `apps/control/memory/core-http.mjs` POSTs `/clio/memory/review/submit`, `/clio/memory/review/status`, `/clio/memory/read_target`, `/clio/memory/find_by_key` | Core has **no** such routes (its memory review is `GET/POST /api/memory/review/candidates…`). New Core endpoints, plus a contract decision about the review inbox. Not composition | CORE (Fable) with R0 |
| W9 Service identity on the preview task | `first-chat-core.ts` task sets `NODE_ENV=production` and has no `INTERNAL_SERVICE_SECRET` | With `NODE_ENV=production`, `ToolServiceSecretGuard` refuses every `tools/*` and `read-mode-observation` call (403 "not configured"). The task needs the secret bound from Secrets Manager, with the same value held by the Meri broker. Credential action, so it belongs in the §8 change set | Fable + dot |
| W7 Engagement OAuth controllers | `GoogleOAuthController`, `MicrosoftOAuthController` listed in the Engagement route policy but in no module | Out of Meri/Objective scope; pre-existing on `backend-import`. Confirm intended host app | dot |

## 6. Unresolved defects and caveats

| ID | Severity | Description | Source |
| --- | --- | --- | --- |
| D1 **SEC** | behavior change vs deployed preview; **confirmed safe for Meri** | `ade7fc88` (running in Core preview task def rev 2) accepted a marked control token wherever `readApplicationAuthority` ran, i.e. also `objective-work` and `portfolio-layout`, and let it through the ordinary middleware path. With #83 those calls now fail closed (401 before DB work). If Meri uses the control credential anywhere other than the three authority POSTs, that call breaks on the next image. Runtime confirmed (#121 6245587848): Meri sends the control credential only to `application-authority/{identity,context,membership}`, and calls neither objective-work nor portfolio-layout. dot: keep #83's narrowing and do not reopen those routes. Invariant: the rt-reads broker must never hand out the control credential. Other routes need native or separately specified workload authority. | R1 |
| D2 **SEC** | activation gate | Control proof shows only that *some* active Clerk session exists for the subject, not that the token's minting session is still active. Token-specific revocation and same-application issuer/audience pairing remain open. | #83 |
| D3 | activation gate | Meri must reuse a stable `jti`-bearing token for linked identity/context hashes or the join fails closed. | #83 |
| D4 | perf | Each marked POST adds one online Clerk list read before context resolution and one at the authority owner; 12-second Meri profile needs live p50/p95. | #83 |
| D5 | migration | `20281015040000_engagement_plans` (#27) now sits between `20281015030000` and `20281015050000`. Any database that already applied `050000` will see an out-of-order pending migration. Reconcile actual `_prisma_migrations` history before any `migrate deploy`. The #74 index line "No `15040000` migration exists here" is stale for this branch. | R7 |
| D6 | migration | Ordered-owner migration: `clients.account_owner_version` presence alone does not prove completion. | #83 |
| D7 | stale pin | #44's `infra/deploy/first-chat-core-ledger-audit-taskdef.mjs`, `first-chat-core-preview.buildspec.yml` and `first-chat-core-pr43-migration-checksums.json` pin PR43 `13d12a7d…`; the CDK service now pins PR48. Re-pin before using the audit/build path. | R9 |
| D8 | unqualified | Sealed PostgreSQL custody for Objective sources is incomplete (claim stickiness, cleanup cancellation/deadline, adapter tests, native storage). | #74 |
| D9 | evidence | PR evidence counts (e.g. #83 157/157, #80 111/111, #73 129/129) are per-pin and do not transfer to this merge. | #79 rules |
| D10 | **resolved** `8baab30b` | Boundary spec vs #68's `meri/` imports (already red at `fca52341`). Fixed by R10 without weakening the spec. | #68 vs boundary spec |
| D11 | **resolved** `12ce8b79` | api-strategy TS6059 (already red at `e5c8f920`): Objective reader-v2 specs import the Core reader-v2 contract from outside `rootDir: src`. `rootDir` is an emit concern, so it now lives only in `tsconfig.build.json` (the `nest build` config). Typecheck/ts-jest use `tsconfig.json` without it. No `include` was widened; build output is unchanged. | #64/#66 |
| D12 | test red, pre-existing | `apps/api/src/meri/meri-tools.program-elements-mode.spec.ts` (12 tests) mocks `./meri-defense-budget-tool.helpers.js` as `{}`, but `MeriToolsService`'s PE tools call `modelBudgetLineMetadata` from it (`TypeError … is not a function`). The spec, the service and the helper are byte-identical at #82 `fca52341`, where #68's commit is titled "Preserve incomplete native read mode source handoff". Not changed here, since the mock's intent is the #68 owner's call. Likely fix: `jest.requireActual` for that helper, or add `modelBudgetLineMetadata` to the mock. | #68 |
| X1 | cross-repo (Meri) | Meri `apps/control/memory/core-http.mjs`, `apps/control/commands/source-http.mjs` and `apps/gateway/sources/action-items/http-adapter.mjs` build Core URLs as `new URL('/clio/…', origin)` with **no `/api` prefix**. Core runs `setGlobalPrefix('api')` (excluding only `health`, `webhooks/*`), so these 404 unless the configured origin path-rewrites. Other gateway sources correctly use `/api/clio/tools/…`. Meri-side fix (R0). | meri-greenfield #145 @ `39278a97` |

## 7. Next actions

1. dot: read-only review of R10, D11's fix and the §8 packet. Choose §8.3 items 1–2 or the private-path alternative.
2. Fable/R0: fix X1 (`/api` prefix) in Meri; design W8 memory routes with the lane 5 owner. W1 retained-read activation inputs.
3. Fable: W6/W9 image + task change once builds are authorized, as one coordinated change set with §8.3 item 1.
3. Integrated-candidate qualification (full suites, DB-backed tests, CDK synth, image scan, authenticated first chat) after the three repo integration branches settle.

## 8. Preview listener deployment packet (requirements only; nothing applied)

Scope: the shared ALB listener `capiro-prod-alb/7a4acb332b261724/e2d19b3dd47fc440`, host
`first-chat-preview.app-dev.capiro.ai`, as rendered by `infra/cdk/lib/preview/first-chat-core.ts` on this branch.
This is source only: read back the physical rules and template before any change set. dot owns the listener and
reviews this read-only. Fable/R0 own the Meri callers. **#84 makes no listener, task-definition or secret change.**

### 8.1 Current source rules

| Priority | Method | Path match | Credential Core requires |
| --- | --- | --- | --- |
| 1 | POST | regex: bootstrap, or application-authority identity / context / membership (exact, anchored) | Bootstrap: native Clerk session bearer (`sid`). Identity/context/membership: native session **or** marked control credential (#83, early online check) |
| 2 | GET | `^/api/me$`, `^/api/clients$`, `^/api/clients/<uuid v1-5>$` | Native session bearer + fresh online session check; task needs `PREVIEW_NATIVE_GETS_ENABLED=true` |
| 3 | any | host-only 404 guard (separate retained stack) | — |

### 8.2 Meri → Core calls not routed today

Callers are in meri-greenfield `fable/meri-integration-20261018` @ `39278a97`. The control credential is never valid
on these routes (runtime confirmed; #83 returns 401 before DB work). Every route also passes `RolesGuard` with
`standard_user` and the ordinary tenant middleware.

| # | Method + path | Meri caller | Core credential + headers | Core state on #84 | Needed for |
| --- | --- | --- | --- | --- | --- |
| L1 | POST `/api/clio/tools/:name` (Meri names match `[a-z0-9_]{2,64}`) | gateway read sources; control commands (`create_task`, `update_task`, `query_tasks`, `save_memory`, `save_chat_attachments`, `list_memory_proposals`, `query_action_items`). Florida budget is **not** served here: it belongs on the signed intel route (L5c), not a tools fallback | Native session bearer (brokered per call) **and** `x-internal-service-secret`. The guard is enforced because the task runs `NODE_ENV=production` (W9). Optional `x-meri-read-observation` for funding/KB asOf and evidence-mode reads | mounted (`MeriModule`) | lane 2 reads, lane 3 commands, lane 5 tasks/memory |
| L2 | POST `/api/clio/application-authority/read-mode-observation` | gateway evidence-mode reads | Native session bearer **and** a *matching* `x-internal-service-secret`: the service requires the verified proof even when the guard is not enforcing | mounted (R10) | evidence-mode reads |
| L3 | POST `/api/clio/clients/check-ref` | Meri client-reference checks | Native session bearer | mounted (`MeriModule`) | client resolution |
| L4 | GET `/api/research-portfolios/:id`, GET `/api/research-portfolios/:id/changes?cursor&limit` | gateway `sources/research-portfolio`, runtime `retained-reads/source-transport.mjs` | Native session bearer, **no** service secret (the Meri test asserts this) | mounted (research-portfolios controller) | RP reads |
| L5a | POST `/api/clio/application-authority/retained-{research-portfolio,research-portfolio-changes,florida-budget}` and `retained-{research-portfolio,research-portfolio-changes,florida}-principal` (6 issuance routes) | runtime native-authority retained reads | Native session bearer | **not mounted** (W1) | retained-read issuance |
| L5b | POST `/api/clio/retained-reads/{research-portfolio,research-portfolio-changes}`, POST `/api/clio/application-authority/retained-florida-current`; intel-api POST `/intel-api/internal/legiwatch/retained-florida-budget` | runtime retained reads | Signed `CapiroRetained` frame (not a Bearer). The generic Bearer-only `TenantContextMiddleware` would refuse these today | **not mounted** (W1); intel retained module unmounted | retained reads |
| L5c | intel-api POST `/intel-api/internal/legiwatch/retained-florida-authority`, Core POST `/api/clio/application-authority/retained-florida-native-current` | runtime retained Florida reads | Signed `CapiroRetainedAuthority` frame | **not mounted** (W1) | Florida budget (signed intel route) |
| L6 | POST `/api/clio/memory/review/{submit,status}`, `/api/clio/memory/{read_target,find_by_key}` | control `memory/core-http.mjs` | Native session bearer + service secret (Meri side) | **no Core route** (W8). Meri also omits `/api` (X1) | lane 5 memory; blocked until W8 + X1 |

These routes don't belong on this listener:
- `/api/clients/:clientId/objectives/:objectiveId/generation` with `/outputs`, `/commands`, `/strategy-commands`, `/confirm-pair`. These are browser-only, native session, and the frontend `governedPlannerReadEnabled`/`governedStrategyIntakeEnabled` flags are false. Add them only if the preview frontend enables governed Objective reads (W4).
- `/api/internal/objective-workload-authority/decisions`: workload RS256 caller proof, private path only.
- Strategy API `/strategy-api/internal/objective-canonical/*`: a separate service.

dot's route/auth review of `458ec355` against Meri `39278a97` (#121 6245600762) matches this table. #83's marked-token
restriction survives and no credential widening is needed. The Meri broker owner needs `getNativeCredential`,
`getServiceSecret` and `getReadModeServiceSecret`, and keeps the service secret server-side
(`apps/runtime/native-authority/native-read-credentials/{owner,client-reference}.mjs`).

### 8.3 Proposed single change set (for dot to accept, amend or reject)

1. **Priority-1 rule, in place (keeps its logical ID):** widen the single POST regex to
   `^/api/clio/(conversations/bootstrap|application-authority/(identity|context|membership|read-mode-observation)|clients/check-ref|tools/[a-z0-9_]{2,64})$`.
   It stays one regex value within the ALB per-condition limit and needs no new priority.
   Caveat from dot: `tools/[a-z0-9_]{2,64}` also admits Core **write** tools, not only reads. That matches the lane 3/5
   command scope, which still needs native bearer + service secret + Meri approval. If the listener should bound it
   instead, replace the wildcard with an enumerated alternation of the G1/G2-approved tool names (watch the ALB
   regex length limit).
2. **Priority-2 rule, in place:** add the GET regex value `^/api/research-portfolios/[0-9a-f-]{36}(/changes)?$` (L4).
   The query string is not part of the path match. That makes 4 of the 5 allowed evaluations on the rule.
3. **Task definition (W6/W9):**
   - Use an image built from #84's tip. Re-pin `FIRST_CHAT_CORE_SOURCE`, the digest and `RELEASE_SHA`.
   - Set `PREVIEW_NATIVE_GETS_ENABLED=true`.
   - Bind `INTERNAL_SERVICE_SECRET` from Secrets Manager, with the value shared with the Meri broker and never logged.
     Candidate from existing source (read back live before use): `infra/deploy/api-strategy-serve-taskdef.json` binds
     `arn:aws:secretsmanager:us-east-1:967807252336:secret:capiro/dev/internal-service-secret-6cEZG4`. The serve execution
     role would also need `GetSecretValue` on it.
   - Tool handlers that call third-party providers also need their existing provider credentials, which the held first-chat task does not carry. Inventory them from the tools G1 actually enables.
4. **Deferred until W1/W8:** the L5a–L5c and L6 paths. W1 is more than mounting: the signed routes need a
   non-Bearer admission path past `TenantContextMiddleware`, real signing/verifier/transport ports (all `null`
   today), `RETAINED_READ_SOURCE_ENABLED`/`sourceEnabled` set, and intel-api's `RetainedFloridaReadModule` mounted.
5. **Unchanged:** the priority-3 host-only 404 guard, the marked-credential narrowing, and the absence of any `/api/*` fallback.

Alternative to items 1–2: give Meri a private in-VPC Core path (Cloud Map or an internal ALB) and keep the public
preview host on first-chat routes only. That avoids a shared-listener change but needs a new network path.
Either way the credential requirements in §8.2 are the same.

### 8.4 Why `first-chat-core.ts` is not edited yet

The CDK source still pins PR48 (`6542f5b0…`, `sha256:722a4832…`) and omits `PREVIEW_NATIVE_GETS_ENABLED=true`
(dot confirmed). Per `docs/core-first-chat-preview-native-gets-20261017.md`, source SHA, digest, `RELEASE_SHA` and
that flag must change together for a newly built and scanned image. Setting the flag or widening the rules
against the PR48 image would describe a task that cannot serve them. The template edit (§8.3 items 1–3 plus the
`preview-first-chat-core.spec.ts` assertions) is therefore Core-lane source work for the W6 image step, written
after dot accepts this packet. It changes no live resource.
