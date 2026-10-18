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
| R4 | … ← #82 | `apps/api/src/auth/application-authority.module.ts` | Union: controllers `ApplicationAuthority`, `ApplicationMembership`, `ApplicationReadModeObservation`; providers `ApplicationMembershipService`, `PreviewNativeReadService`, `ApplicationReadModeObservationService`, `ToolServiceSecretGuard`; export `PreviewNativeReadService`. This mounts #68's `POST /api/clio/application-authority/read-mode-observation`, which the Meri integration branch calls. |
| R5 **SEC** | … ← #82 | `apps/api/src/auth/application-authority.module.spec.ts` | Union: #68 read-mode imports, request path type and the new read-mode `describe`; kept HEAD's stricter membership tests (`user_admin`/`capiro_admin` wall test, `client_portal_user` below the `standard_user` floor → 403, bearer-denial `no-store`). `application-membership.service.ts` is byte-identical on both sides. |
| R6 | … ← #82 | `apps/api/src/auth/application-membership.spec.ts` (add/add) | Kept HEAD (adds the `preview-native-read-mode.js` port the merged middleware imports). |
| R7 | … ← #82 | `apps/api/prisma/schema.prisma` | Union: Objective workload delegation/decision/issuance/delivery/proof-use models (#42) and Engagement plan models (#27). `prisma validate` and `prisma generate` pass. |
| R8 | … ← #74 | `docs/objective-automation-reconciliation-20261015/MIGRATION-ALLOCATIONS.json` | Union of both reservations (`20281016010000_client_objective_workload_delegations`, `20281016020000_clio_conversation_bootstrap_receipts`), sorted by `allocatedAt`; `recordedAt` = later of the two. |
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
| apps/api-strategy `tsc --noEmit` | 3 × TS6059 only, pre-existing at #74 (D11) |
| apps/intel-api `tsc --noEmit` | pass after test-only fix `34ffe8ec` (three `mock.calls[0]![n]` narrowings in #37's spec) |
| Jest `--runInBand`, 24 suites that import a conflicted file (auth, tenant middleware, portfolio layout, Objective mount/work status, admin/tenant-admin, newsletter, identity outbox) | 23/24 suites, 451/452 tests pass. The one failure is the `application-authority-boundary` spec, pre-existing at #82 (D10). First run had 3 more failing suites from missing VM ports; fixed in `b2c23f77`. |
| intel-api `retained-florida-read.service.spec.ts` | 36/36 |

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
| Native read-mode observation | `POST /api/clio/application-authority/read-mode-observation` | **wired by this branch** (R4) |
| Conversation bootstrap | `POST /api/clio/conversations/bootstrap` (`MeriModule`) | mounted |
| Governed reads incl. funding/KB asOf and meeting ownership | `POST /api/clio/tools/:name` (`MeriModule`, `ToolServiceSecretGuard`) | mounted; every tool name the Meri branch calls resolves in `meri-tools.service.ts` / `federal-market-meri-tools.service.ts` except `get_florida_budget_project` (below) |
| Client ref check | `POST /api/clio/clients/check-ref` | mounted |
| Preview native GETs | `/api/me`, `/api/clients`, `/api/clients/:id` | mounted, flag-held |
| Objective generation reads/commands | `/api/clients/:clientId/objectives/:objectiveId/generation` (`ClientsModule` → `ObjectiveWorkModule`) | mounted; writes flag/authority-held |
| Objective workload decisions | `POST /api/internal/objective-workload-authority/decisions` | mounted; admission disabled |

`/api/memory/proposals/{list,propose,status,correct}` in the Meri branch are Meri control's own routes
(`apps/control/memory/routes.mjs`), not Core calls.

### Remaining (not pure composition — needs authority, credentials, infra or a product decision)

| Item | What exists | What is needed | Owner |
| --- | --- | --- | --- |
| W1 Retained reads (`retained-research-portfolio*`, `retained-florida-*`, `/api/clio/retained-reads/*`; Meri `get_florida_budget_project`) | `RetainedPrincipalModule`, `RetainedReadAuthorityModule`, `RetainedFloridaCurrentController` — "deliberately unmounted", ports `null`, `RETAINED_READ_SOURCE_ENABLED=false`; intel-api `RetainedFloridaReadModule` ports `null` | Issuer/verifier keys, audience, transport binding and an activation decision; then import into `AppModule` and supply ports | Fable + dot |
| W2 Objective admission issuance | `createObjectiveAdmissionRuntime()` disabled factory | Qualified genuine admission/base authority and purpose-qualified credentials (Core decision RS256) | Fable |
| W3 Strategy acceptance/results receiving | Zero-arg closed factory in api-strategy `PlannerModule` | Core native/retained-access/credential owners + qualified Meri custody (`meri_objective_source.custody`) | Fable |
| W4 Planner continuation / Strategy intake | Code mounted, flags off | Flag flip only after W2/W3 + migration reconciliation | Neo/dot |
| W5 Preview listener scope | #83 CDK: priority 1 = bootstrap + 3 authority POSTs, priority 2 = 3 GETs, priority 3 host-only 404 guard | Meri's `/api/clio/tools/*` and `read-mode-observation` calls are not routed on `first-chat-preview.app-dev.capiro.ai`. Needs a listener-rule change or a private in-VPC Core path. Shared listener is dot-coordinated; no AWS action here | dot |
| W6 New Core image | `first-chat-core.ts` binding accepts only PR48 source `6542f5b0…` / digest `sha256:722a4832…` | Build + scan an image from this branch's tip, then re-pin source/digest/`RELEASE_SHA` (and set `PREVIEW_NATIVE_GETS_ENABLED=true` only on that task) | Fable (when builds are authorized) |
| W7 Engagement OAuth controllers | `GoogleOAuthController`, `MicrosoftOAuthController` listed in the Engagement route policy but in no module | Out of Meri/Objective scope; pre-existing on `backend-import`. Confirm intended host app | dot |

## 6. Unresolved defects and caveats

| ID | Severity | Description | Source |
| --- | --- | --- | --- |
| D1 **SEC** | behavior change vs deployed preview | `ade7fc88` (running in Core preview task def rev 2) accepted a marked control token wherever `readApplicationAuthority` ran, i.e. also `objective-work` and `portfolio-layout`, and let it through the ordinary middleware path. With #83 those calls now fail closed (401 before DB work). If Meri uses the control credential anywhere other than the three authority POSTs, that call breaks on the next image. | R1 |
| D2 **SEC** | activation gate | Control proof shows only that *some* active Clerk session exists for the subject, not that the token's minting session is still active. Token-specific revocation and same-application issuer/audience pairing remain open. | #83 |
| D3 | activation gate | Meri must reuse a stable `jti`-bearing token for linked identity/context hashes or the join fails closed. | #83 |
| D4 | perf | Each marked POST adds one online Clerk list read before context resolution and one at the authority owner; 12-second Meri profile needs live p50/p95. | #83 |
| D5 | migration | `20281015040000_engagement_plans` (#27) now sits between `20281015030000` and `20281015050000`. Any database that already applied `050000` will see an out-of-order pending migration. Reconcile actual `_prisma_migrations` history before any `migrate deploy`. The #74 index line "No `15040000` migration exists here" is stale for this branch. | R7 |
| D6 | migration | Ordered-owner migration: `clients.account_owner_version` presence alone does not prove completion. | #83 |
| D7 | stale pin | #44's `infra/deploy/first-chat-core-ledger-audit-taskdef.mjs`, `first-chat-core-preview.buildspec.yml` and `first-chat-core-pr43-migration-checksums.json` pin PR43 `13d12a7d…`; the CDK service now pins PR48. Re-pin before using the audit/build path. | R9 |
| D8 | unqualified | Sealed PostgreSQL custody for Objective sources is incomplete (claim stickiness, cleanup cancellation/deadline, adapter tests, native storage). | #74 |
| D9 | evidence | PR evidence counts (e.g. #83 157/157, #80 111/111, #73 129/129) are per-pin and do not transfer to this merge. | #79 rules |
| D10 | test red, pre-existing | `application-authority-boundary.spec.ts` forbids any `apps/api/src/meri/` runtime import in the `ApplicationAuthorityModule` closure, but #68's read-mode observation controller/service import `../meri/tool-service-secret.guard.js` and `../meri/meri-funding-read-observation.js`. Both files are byte-identical at #82's head `fca52341`, so this already failed there; it was not introduced by the merge. Not weakened here. Proposed fix (for the #68 owner): move `ToolServiceSecretGuard`/`hasVerifiedToolServiceIdentity` and `isMeriEvidenceModeRead` to a neutral owner (e.g. `apps/api/src/auth/` or `common/`) and re-export them from the old `meri/` paths. | #68 vs boundary spec |
| D11 | typecheck red, pre-existing | apps/api-strategy `tsc --noEmit` reports TS6059: `src/meri/objective-canonical-reader-v2-{receiving,runtime}.spec.ts` import `apps/api/src/auth/workload-authority/objective-reader-v2-*.ts`, outside `rootDir: src`. Those specs and `tsconfig.json` are byte-identical at #74 `e5c8f920`. `nest build` excludes specs and passes. Fix options: a spec-only tsconfig without `rootDir`, or move the shared reader-v2 contract into `packages/shared`. | #64/#66 |

## 7. Next actions

1. dot: review R1–R9 and §1 exclusions on PR #121 / this PR.
2. Fable: decide W5 (how Meri reaches Core tools from the preview) with dot, then W6 image when authorized.
3. Integrated-candidate qualification (full suites, DB-backed tests, CDK synth, image scan, authenticated first chat) after the three repo integration branches settle.
