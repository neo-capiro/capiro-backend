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
| R11 **SEC** | post-merge (W1/W5 wiring) | `packages/shared/src/core-retained-{jcs,trust}.ts`, `apps/api/src/auth/retained-trust.ts`, `retained-{principal,read-authority}.module.ts`, `tenant-context.middleware.ts`, `app.module.ts`; Intel `retained-florida-trust.ts`, `app.module.ts`, `tracker.module.ts`; `meri/meri-tool-allowlist.ts`; `infra/cdk/lib/preview/first-chat-core*.{ts,json}` | Wired the existing retained contracts as dot asked (#121 6245600762). A shared trust loader turns env pins into validated issuer/origins/Ed25519 keys: inert when disabled, fail-fast when enabled but incomplete, and it refuses a private key on the Intel side. Core composes signers/verifiers/probe verifier/Florida HTTP port with the existing factories and mounts `RetainedPrincipalModule`. Intel mounts `RetainedFloridaReadModule` with verifier-only ports and TrackerModule's exported Phase8 owner. The tenant middleware admits signed retained POSTs only by exact path + POST + scheme while enabled, and sets no tenant context. The #83 control-credential gate is unchanged. Core enforces an exact Meri tool allowlist. The CDK template encodes the §8 packet. The Intel spec's 'unmounted' assertion now pins a single root mount. |
| R12 **SEC** | item 2 (P-INT-10) | new `apps/api/src/meri/native-approvals/*`, `ClioMeriApprovalDecision` model, migration `20281018010000_clio_meri_approval_decisions`, `app.module.ts` | Core owner for Meri `apps/control/intents/native-approvals.mjs` `approval/record` and `approval/decision`. Bodies and receipts are byte-for-byte those operations, HTTP 200, closed shapes. Routes: `POST /api/clio/approvals/native/{record,decision}`. Auth matches `/api/clio/tools`: native session bearer + verified `x-internal-service-secret` + `standard_user`. Record requires the authenticated user to be the approver, the proposal's `requiredApprover` and the conversation owner. It verifies proposal integrity (RFC 8785 SHA-256 of `command`, expiry, approver tenant), allows `task.create` only (Meri `approval.mjs:29`), and cross-checks Meri's `meri_commands.approval_metadata` row, failing closed (503) until Core can read it. `policyRevision` is the single revision shared by `command.scopes`. Decisions are immutable (trigger, RLS, insert-only grant) and idempotent per (tenant, proposal): a repeat answers the stored decision and never flips; a concurrent first insert answers the winner. `approval/decision` compares tenant/actor/conversation/run only (callers pass fresh attempt/worker/fence) and answers `null` without disclosure otherwise. `approval/read` is not implemented: Meri defines no envelope (D18) |
| R13 **SEC** | item 4 (W8 M2) | new `apps/api/src/meri/memory-receiving/*`, `ClioMeriMemorySubmission` model, migration `20281018020000_clio_meri_memory_submissions`, `app.module.ts` | Core owner for Meri `apps/control/memory/core-http.mjs` `CORE_MEMORY_ROUTES`. Response shapes follow `core-review.mjs` and `core-memory.mjs`. The candidate is `candidate.mjs` `meri.memory-candidate.v1`: closed, with Meri's exact bounds (`wire.mjs` sourceRef: trimmed reference up to 512 characters, https for web_page, title up to 200). Routes: `POST /api/clio/memory/{review/submit,review/status,read_target,find_by_key}`, HTTP 200, no-store. Auth matches `/api/clio/tools`: bearer + verified service secret + `standard_user`.<br>**Submit.** `candidateSha256` must equal the RFC 8785 SHA-256 of the candidate. Tenant and proposer must be the authenticated Core tenant and user, and client scope passes the memory wall. Submit inserts a **pending** `memory_candidate` under the Meri candidate id (`source_kind explicit_user`, `source_type meri`, Meri identity in provenance). It never commits inline, at any scope, and never calls `proposeSaveMemory`. In the same transaction it writes an immutable submission row (RLS, insert-only) with a stable `reviewId`. Replaying the same hash answers the original ack; a different hash or a foreign proposer answers 409. The payload is the existing candidate payload shape, so the existing approve/reject owner decides it.<br>**Status.** Proposer-only and hash-bound; anything else answers `not_found`. `approved`/`auto_committed` map to `approved` with `publishedMemoryId = committed_memory_id`; `rejected` and `withdrawn` pass through.<br>**Reads.** Core visibility applies: owner only for personal, memory wall for client. The target hashes a closed `capiro.clio-memory.v1` projection.<br>Corrections are refused (D21) |
| R14 **SEC** | item 3 (execution capability), **DRAFT** | new `apps/api/src/meri/execution-capability/*`, `apps/api/src/auth/core-ed25519-signer.ts`, `docs/integration/MERI-EXECUTION-CAPABILITY-DRAFT.md`, `docs/integration/meri-execution-capability.vector.json`; `parseScope` exported | Draft `capiro.meri-execution-capability.v1`, assigned to Core by dot (#121 6246253130).<br>**Token.** A short-lived (at most 120 s) EdDSA compact JWS whose payload is the exact RFC 8785 form. It carries:<br>- Meri's exact `CapabilityClaims`: audience `meri-gateway`, `command.execute` only, the executor RunBinding, the proposal scopes, and `policyRevision` equal to the decision's;<br>- an `execution` binding: the `CommandExecutionRequest` hash, the `argumentsSha256` of the command arguments, the client ids, the immutable decision hash and the approver.<br>**Issuance** requires the stored R12 decision to be current and approved, and the same tenant/actor/conversation/run.<br>**Verification** pins the key, issuer, clock and exact header, and recomputes every hash.<br>**Replay and revocation:** the `jti` ledger, immutable grant facts, the command-journal claim, and the executor's existing CURRENT re-checks.<br>**Receiver branch (executor with no user bearer):** a proposal-bound `approval/decision` read, and an arguments-bound `create_task` call only. Drafted (`executionCoversDecisionRead`), not mounted.<br>**Signing** goes through the async Ed25519 signer shape: in-process, or KMS `ED25519_SHA_512` RAW (pure Ed25519) verified against the pinned key. This is also D7-2's signer.<br>No route, key, ledger or credential exists. Six open questions are in draft §7.<br>**Rev 2 (dot 6246527853 / 6246534408):** binds `sourceBodySha256` (Meri's `create_task` body projection) next to `argumentsSha256`. Makes unique **consumption** (a claim in the effect transaction; a repeat answers the stored result or UNKNOWN, never a redispatch) and decision **revocation** (R12 has none today) explicit obligations before mounting |
| R15 **SEC** | W8 fixes from dot's M2 review (#121 6246374007), points 2–5 | `meri-memory-receiving.service.ts`, `memory/memory-candidate.service.ts`, `memory/memory.controller.ts`, new `memory/memory-authorization.policy.ts` (a pure move, re-exported by `memory-authorization.helpers.ts`), `auth/application-membership{,.service}.ts`, specs | **Keys (3).**<br>- Logical null is kept apart from the storage key. A memory committed from an unkeyed Meri addition reads back as `key: null`, proven through the submission and `committed_memory_id` lineage, never from the `meri:` prefix alone. `find_by_key` never matches it.<br>- The projection hash covers the logical key and the storage key. Nothing is truncated or rewritten; keys over 120 characters stay unaddressable (D23).<br>- Submit refuses the reserved `meri:<uuid>` form, and refuses an addition whose key is already committed in that scope (409: submit a correction).<br>- Approval of a Meri-sourced candidate is **insert-only** in the existing owner (`commitToClioMemoryInTx` `insertOnly`): an existing key, or a P2002 race between two pending additions, answers 409 instead of an upsert.<br>**Personal review (2).** No auto-commit. A new explicit owner path: `GET /api/memory/candidates/mine` and `POST /api/memory/candidates/:id/owner-decision` `{decision: approve|reject}` (standard_user). It decides only the caller's own personal candidate, through the existing approve/reject owner. Meri personal submissions are **owner-only**: always enforced on approve/reject (even with governed enforcement dark) and hidden from other viewers' admin queue, because the content is private memory.<br>**Firm (4).** Membership receipts emit `permissions: ['memory.propose.firm']`, derived from the canonical `evaluateGovernedMemoryAuthorization` (firm `propose`, tenant member), never fabricated. Re-derived on every read and covered by `membershipRevision` through the role. The pure policy split keeps the authority closure free of `@capiro/meriv2*`; the boundary spec passes.<br>**reviewId (5).** It is the submission receipt, **not** `review_request.id`. Approval UIs resolve the workflow by `candidateId` and use the owner-returned `reviewRequestId`. Documented, no change.<br>**Corrections (1)** still answer 409; the adapter is the next commit |
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
| After R11 + §8 enumeration: apps/api `nest build`, `tsc --noEmit --rootDir .`; intel-api `tsc`; infra/cdk `tsc --noEmit` | pass |
| After the compact listener (dot 6246021908): infra/cdk `tsc` pass; cdk node:test 9/9; routing 8/8 (shared priorities unchanged); api `tsc` pass; tool-allowlist spec 14/14; config specs 50/50 | pass |
| Jest after R11: 18 api suites (retained trust/JCS/signed admission, tool allowlist, authority/membership/boundary, tenant middleware incl. #83 control credential and preview GETs, retained principal/request/native, Meri funding/RP/attachment HTTP transports) | 18/18, 449/449 |
| Jest after R11: intel-api `tracker/editorial` (retained Florida read/controller/trust, current authority, publisher coverage) | 5/5, 102/102 |
| After R13 (W8 memory receiving): `prisma validate` + `generate`; `meri-memory-receiving.service.spec.ts`; apps/api `tsc --noEmit` (8 GB heap); `nest build` | pass; 24/24; pass; pass |
| After the native-operations rule (dot 6246253130): infra/cdk `tsc --noEmit`; `preview-first-chat-core.spec.ts`; `infra/routing` | pass; 6/6; 9/9 |
| After R14 (execution capability draft): capability + Ed25519 signer spec; approvals, memory and capability specs together; apps/api `tsc --noEmit` | 21/21; 57/57; pass |
| After R15 (M2 review fixes): memory candidate, controller and W8 specs; auth membership, authority, module and boundary specs; memory authorization specs; apps/api `tsc --noEmit` | 107/107 (13 in the approval spec); 149/149; pass; pass |
| After capability rev 2: capability spec (vector regenerated); apps/api `tsc --noEmit` | 22/22; pass |
| `scripts/engagement-api-infra-discover.spec.mjs` | 17/17 |
| `scripts/ci/newsletter-declared-edge.contract.spec.mjs` | 0/1, pre-existing since #78 (D14) |

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
| W1 Retained reads (§8.2 A5–A7, I1–I2) | **Composed in source (R11).** Mounted, but inert until trust is enabled | Remaining activation inputs (not composition): Ed25519 keypairs and Secrets Manager entries, issuer and Intel origin pins, a new Core image and an Intel image with this wiring, JCS qualification (D13), and an activation decision. The non-UUID Florida client selector still returns 503 pending the canonical client-name resolver seam (#35 handoff) | Fable + dot |
| W2 Objective admission issuance | `createObjectiveAdmissionRuntime()` disabled factory | Qualified genuine admission/base authority and purpose-qualified credentials (Core decision RS256) | Fable |
| W3 Strategy acceptance/results receiving | Zero-arg closed factory in api-strategy `PlannerModule` | Core native/retained-access/credential owners + qualified Meri custody (`meri_objective_source.custody`) | Fable |
| W4 Planner continuation / Strategy intake | Code mounted, flags off | Flag flip only after W2/W3 + migration reconciliation | Neo/dot |
| W5 Preview listener scope | **Encoded in source (§8.1), compact layout.** P1 POST and P2 GET carry every route, guard 3 unchanged, no shared rule moves. The preview profile makes the exact tool allowlist mandatory | Listener readback plus one coordinated change set (dot). No live change here | dot |
| W6 New Core image | `FIRST_CHAT_CORE_IMAGE_PINS = null`; PR48 is refused | Build and scan the integrated image, then pin its source and digest together (§8.4) | Fable (when builds are authorized) |
| W8 Meri memory M2 routes | **Composed in source (R13).** `POST /api/clio/memory/{review/submit,review/status,read_target,find_by_key}` (`MeriMemoryReceivingModule`); the submission ledger migration is reserved, not applied | Before live: listener capacity (D20), the personal-scope decision (D22), the corrections mapping (D21) and the migration applied by its owner. Mismatches are in D23–D25 | Fable / dot |
| W9 Service identity on the preview task | **Encoded in source (§8.3):** `INTERNAL_SERVICE_SECRET` from an exact Secrets Manager ARN, server-side only | Choose and read back the secret; the Meri broker holds the same value | Fable + dot |
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
| D13 **SEC** | activation gate | The retained codecs require a trusted RFC 8785 JCS provider. This branch adds an in-repo serializer (`@capiro/shared/core-retained-jcs`) that refuses non-JSON input (non-finite numbers, lone surrogates, sparse arrays, non-plain objects, cycles) and passes the RFC 8785 §3.2.3/§3.2.4 vectors. The #35 handoff called for a separately qualified provider; the only published package (`canonicalize` 5.x) is ESM-only and was updated 2026-09, so it was not added to a signing path or the shared lockfile without an owner decision. Qualify (or replace) before `RETAINED_READS_ENABLED=true` | R11 |
| D14 | test red, pre-existing | `scripts/ci/newsletter-declared-edge.contract.spec.mjs` fingerprints `scripts/engagement-api-alb-rules.sh` at backend-import's bytes/SHA-256 (`133d9067…`) and expects preview priority 6. #78 (`bcdd6899`) already changed that script, so it fails at the merge. This branch leaves the script exactly as received. Re-seal with the newsletter owner | #78 / newsletter contract |
| D15 | cross-repo (Meri), blocks item 2 live | `approval/*` has no path to Core. Meri `native.call` posts to `${native.origin}/v1/<op>` (`apps/runtime/native-client.mjs:12`); in preview `native.origin` is control private and the in-process candidate serves only readiness/execution/worker/runner/checkpoint (`prepared-candidate.mjs:100,107`, `prepared-run-registry.mjs:100,108`). R0 must add a forwarder from `/v1/approval/{record,decision}` to Core's routes carrying the user bearer (A relay) + service secret | Meri R0 |
| D16 | cross-repo, design | Meri's `policyRevision` is its run qualification revision (`approval-context.mjs:9-14`, `lifecycle/service.mjs:58`); Core has no Meri command-policy owner, so Core echoes the single scope revision of the proposal. If Meri intends Core to own command policy, that owner needs a spec | Meri R0 / dot |
| D17 | grant | `meri_commands.approval_metadata` (Meri migration `approval-metadata/0001`, unapplied) must be readable by Core's database role (SELECT), or every approval answers 503 | deployment packet |
| D18 | spec gap | `approval/read` (lifecycle `readProposal`) has no envelope in Meri (`product-ports/lifecycle.mjs:11-16,30`); the proposal is Meri-held data. Not implemented until Meri defines it | Meri R0 |
| D19 | cross-repo, blocks item 3; **contract drafted (R14), awaiting R0 + dot** | `issueExecution` is an in-process Meri port (`approval.mjs:121-135`). Its `credential` is verified by Meri `verifyCapability` (`current-tool-authority.mjs:28-42`) and must match a grant bound by `bindTrustedGrant` in Meri's budget store. The capability claims, signature and verifier key are unspecified; `BACKLOG.md:53` names a Core "intent capability issuer" without a contract. `verifyCapability`/`currentRun`/`authorizeBusiness`/`authorizeSources` and `getCredentials` for `/api/clio/tools/*` have no production supplier. Per-run result release (`intents/result-release.mjs:27-47`) names no Core route | Meri R0 + Core, spec first |
| D20 | listener, **encoded per dot 6246253130** | Rule 1 is at capacity (3 values). New Core POST families (`/api/clio/approvals/native/{record,decision}`, W8 `/api/clio/memory/{review/submit,review/status,read_target,find_by_key}`) need one more Core rule. Its one value, 104 characters, matches exactly those six paths: `^/api/clio/(approvals/native/(record|decision)|memory/(review/(submit|status)|read_target|find_by_key))$`. Encoded (§8.1): the new Core rule is at P3, and the guard moves to the readback-verified `listener.guardPriority`. P4 is not assumed (Meri may hold it live). No live rule is authorized; the readback and the slot go into the coordinated change set | dot (readback) |
| D21 | cross-repo, blocks memory corrections | Meri's `corrects.memoryId` is the `clio_memory` id that `read_target` returns. Core corrections run through `ImmutableMemoryVersionService` on `memory_items`, a different id namespace. Submit therefore refuses `kind:'correction'` with 409 until the clio_memory→memory_items mapping and its approval path are specified. No Meri change requested yet | Meri R0 + Core memory owner |
| D22 | product decision, **owner path wired (R15)** | Meri personal additions stay **pending**; Core's legacy `proposeSaveMemory` commits them inline. Core's review trigger opens a `review_request` only for firm/client scope, so a personal Meri candidate waits for the existing candidate approve route (proposer or admin) and does not appear in the review inbox. Meri `core-review.mjs` names Core the only review authority, so pending is the conservative reading. Decide whether personal Meri memory should auto-commit | Neo / dot |
| D23 | contract mismatch | Keys. Core `clio_memory.key` is NOT NULL `VARCHAR(200)`; Meri keys are null or up to 120 characters. An unkeyed Meri addition is stored and read back as `meri:<candidateId>`. A Core key longer than 120 characters answers `{memory:null}`, because Meri's closed target check would refuse it. Client-scope keys are unique per tenant **across clients**: the partial index `clio_memory_firm_key_uniq` covers every owner-less row, so the same key for two clients collides at approval | Meri R0 + Core memory owner |
| D24 | contract note | States. Core emits only `active` and `expired`: forgotten rows are deleted, and superseded history lives in `memory_items`. Review status never emits `expired`, because Core has no candidate expiry. Meri's `MEMORY_STATES` and `REVIEW_STATUSES` keep those values; no change requested | recorded |
| D25 | contract mismatch, **firm fact emitted (R15)** | Firm authority. Core admits firm reads and firm proposals for every tenant member, and review gates publication. Core membership receipts carry `permissions:[]`, so no Core fact backs any Meri firm-permission check. Candidate `tenantId` and `proposerActorId` must be Core's authenticated tenant and user ids | dot |
| D26 | environmental, pre-existing | `infra/deploy/first-chat-core-ledger-audit-taskdef.spec.mjs` hashes `docs/meri/releases/2026-10-02/.../rds-us-east-1-bundle.pem` as checked out. The pinned hash is the **CRLF** form, so the spec passes only on a `core.autocrlf=true` checkout and fails on this LF worktree (required by the CRLF lockfile rule). The file is not touched by this branch | owner of `13668f72` |
| D27 | pre-existing, recorded | Legacy (non-Meri) personal candidates that are pending are still listed to admins and can be approved by them while governed enforcement is dark, because `requireSharedApprovalPolicy` checks only shared scopes. R15 closes this for Meri submissions only, to avoid changing legacy behavior unasked. The canonical policy (owner-only) applies once enforcement is on | memory owner / Neo |
| D28 | frontend | The owner decision path (`/api/memory/candidates/{mine,:id/owner-decision}`) has no os.capiro.ai UI yet. Until it does, a personal Meri submission stays pending | FE |
| X1 | cross-repo (Meri), **fixed by R0** | Meri callers built `/clio/...` without Core's `/api` prefix. dot counted at least 6 caller files (memory core-http, commands source-http, action-items, memory-proposals, original-tracking, research-portfolio-evidence). R0 prefixed them in meri-greenfield `adcdd120` (#121 6245813936). Core: the §8 packet now includes the RP-evidence GETs | meri-greenfield |

## 7. Next actions

Scope added by dot (#121 6246004526 / 6246011427 / 6246021908). Native owners are integration work, not testing gaps. Items are taken in this order:

1. ~~Compact listener + mandatory preview allowlist~~ (§8.1, this branch).
2. ~~P-INT-10 `approval/record`, `approval/decision`~~ (R12). `approval/read` waits on Meri's envelope (D18); going live needs D15/D17/D20.
3. Execution capability: **drafted (R14)**, awaiting R0 (consumer) and dot (fit) on draft §7. After agreement come the issuance route, its ledger migration and the receiver branch. Per-run result release and the other gateway ports stay open (D19).
4. ~~W8 memory receiving routes~~ (R13), ~~M2 review fixes 2–5~~ (R15). Corrections: the adapter is next (D21). Going live needs D20, the migration, and the FE owner view (D28).
5. Unattended schedule grants/proof/revocation (`apps/runtime/schedule-service.mjs`).
6. Artifact options authority (`product-ports/documents.mjs`).
7. Objective D7-2 / D7-3 credential owners (RS256 admit-only workload credential; pure Ed25519 KMS signer shape). Keys are created only in the deployment packet.
8. Owners: W1 activation inputs, D13 JCS qualification, W6 image + W9 secret, D14 re-seal. dot: listener readback and one coordinated change set. Then integrated-candidate qualification.

## 8. Preview Core deployment packet (source encoded; nothing applied)

Scope: the shared ALB listener `capiro-prod-alb/7a4acb332b261724/e2d19b3dd47fc440`, host
`first-chat-preview.app-dev.capiro.ai`, and the held `capiro-preview-first-chat-core` task, as rendered by
`infra/cdk/lib/preview/first-chat-core.ts` on this branch. Requested by dot in #121 6245600762 / 6245738181 /
6245767749. dot reviews read-only. **No listener, task, secret, key, image or AWS change is made by #84.**
Physical rule ownership and the current template must be read back before any change set.

### 8.1 Listener rules (source, compact preview layout chosen by dot)

dot chose the compact preview-only option (#121 6246021908) over relocating shared rules (6246004526). Rules 1 and 2 keep their logical IDs, and **no shared dev/prod rule, priority, default or fingerprint changes**. The shared registry, snapshot and ALB scripts are unchanged.

**Native-operations rule (dot 6246253130, source layout only, no live rule authorized).** One new exact Core POST rule, `FirstChatNativeOpsPostOnly`, takes priority 3 for the P-INT-10 approval and W8 memory routes. **Only the Core-host guard moves.** Its new slot is not fixed in source: the render binding (schema v3) requires `listener.guardPriority`, read back from the live listener.
- **Before rendering**, run `corePreviewPacketRules(readback, routes, { guardPriority })` in `infra/routing`. It refuses the slot unless it is unused, after the native-operations rule, and before the first non-Core rule that could match the Core host. So same-host precedence is unchanged.
- **On the frozen snapshot plus the registry relocations, only 4 qualifies.** 5 and 6 are taken, and the any-host header rule sits at 7.
- **If the readback shows Meri's public rule at 4** (earlier live reports), 4 is refused and the slot Meri left (6) qualifies. The simulator covers both cases.
- **If a readback leaves no qualifying slot**, no packet is valid. The fallback would merge native-ops into rule 2 with methods GET+POST, widening both method sets. That is dot's call, not encoded.
- **Order.** The guard stack updates first, which frees 3; the service stack then creates the P3 rule. The CDK stack dependency enforces this.

ALB limits (AWS "Condition types for listener rules"):
- at most 3 match values per condition;
- 5 match evaluations per rule (host + method + 3 paths = 5);
- 128 characters per path pattern;
- no lookaround.

| Priority (logical ID) | Method | Path regex values (`infra/cdk/lib/preview/first-chat-core-routes.json`) |
| --- | --- | --- |
| 1 (`FirstChatPostsOnly`) | POST | `^/api/clio/application-authority/(identity\|context\|membership\|read-mode-observation\|retained-florida-(budget\|principal))$` (121) · `^/api/clio/application-authority/retained-(research-portfolio(-changes)?(-principal)?\|florida-(native-)?current)$` (113) · `^/api/clio/(conversations/bootstrap\|clients/check-ref\|retained-reads/research-portfolio(-changes)?\|tools/[a-z][a-z0-9_]{1,63})$` (127, dot's exact pattern) |
| 2 (`FirstChatMembershipPostOnly`) | GET | `^/api/(me\|clients)$` · `^/api/clients/<uuid v1-5>$` · `^/api/research-portfolios/[0-9a-f-]{36}(/(changes\|reviews\|annual-review\|snapshots/[0-9a-f-]{36}))?$` |
| 3 (`FirstChatNativeOpsPostOnly`) | POST | `^/api/clio/(approvals/native/(record\|decision)\|memory/(review/(submit\|status)\|read_target\|find_by_key))$` (104) |
| readback `listener.guardPriority` (retained guard stack) | any | host-only 404, moved from 3; nothing else changes |

**Perimeter tradeoff (recorded per dot 6246011427).** The listener forwards any *syntactically valid* tool name (`[a-z][a-z0-9_]{1,63}`), not only the 65. That is a wider network perimeter than exact ALB enumeration. Core closes it:
- **Profile requirement.** The task runs `CORE_DEPLOYMENT_PROFILE=first-chat-preview`. In that profile, startup refuses to run without an exact, non-empty `MERI_TOOL_ALLOWLIST` (config validation), and the route refuses every tool if the list were somehow absent.
- **Order of checks.** `POST /api/clio/tools/:name` first passes native bearer authentication and the service-identity guard. It then returns 404 for any name outside the 65.
- **Other deployments.** They keep the `standard` default (no list = every registered tool), unchanged.
- **Writes.** The four allowed writes (`create_task`, `update_task`, `save_memory`, `save_chat_attachments`) still require upstream approval/compliance. A path or name allowlist does not approve an individual write.
- **Control credential.** The marked control credential stays restricted to the three authority POSTs.

Proof:
- **CDK spec** (`infra/cdk/test/preview-first-chat-core.spec.ts`): exact patterns and lengths, the profile env, and that the 65 names plus an unlisted name such as `send_email` match rule 1 (the tradeoff).
- **Simulator** (`infra/routing` 9/9):
  - every shared priority is unchanged, and only the guard moves;
  - every non-Core request routes identically;
  - every §8.2 route reaches Core, and the six native operations reach P3;
  - malformed tool paths, `GET` tools or native ops, analytics, `/health`, other APIs and `memory/recent` hit the guard;
  - invalid, occupied or post-header-rule slots are refused.

Any other new Core POSTs must be added to these patterns when implemented. They are not covered implicitly.

### 8.2 Route / method / authority bindings

ALB query strings are not part of the path match. Core enforces method, authority and body shape.

| # | Method + path | Caller | Authority Core enforces |
| --- | --- | --- | --- |
| A1 | POST `/api/clio/application-authority/{identity,context,membership}` | Meri control | Native Clerk session bearer **or** the marked control credential (#83: only these three, early online check). `RolesGuard` |
| A2 | POST `/api/clio/conversations/bootstrap`, `/api/clio/clients/check-ref` | browser / Meri | Native session bearer. `RolesGuard` |
| A3 | POST `/api/clio/application-authority/read-mode-observation` | Meri gateway | Native bearer **and** a *matching* `x-internal-service-secret`; the service requires the verified proof |
| A4 | POST `/api/clio/tools/:name` | Meri gateway / control | Native bearer **and** `x-internal-service-secret` (enforced: `NODE_ENV=production`, `MERI_TOOLS_REQUIRE_SERVICE_SECRET=true`). The listener forwards any syntactically valid name (rule 1, bounded pattern). The `first-chat-preview` profile makes `MERI_TOOL_ALLOWLIST` mandatory and Core refuses any other `:name` after auth: the **65 exact names** from dot's fixed inventory (`infra/cdk/lib/preview/first-chat-core-meri-tools.json`), intersected with the Core manifest. Anything else returns 404 like an unknown tool. Writes in the list: `create_task`, `update_task`, `save_memory`, `save_chat_attachments`. Florida budget is **not** a tool here. |
| A5 | POST `/api/clio/application-authority/retained-{research-portfolio,research-portfolio-changes,florida-budget}` and `retained-{research-portfolio,research-portfolio-changes,florida}-principal` | Meri control | Native bearer. Issuer + current facts. `RolesGuard standard_user` |
| A6 | POST `/api/clio/retained-reads/research-portfolio(-changes)`, `/api/clio/application-authority/retained-florida-current` | Meri retained transport (validates the legacy shape, then emits the signed POST); Intel | Signed `Authorization: CapiroRetained <envelope>`. **Not** `RolesGuard` or Bearer: the tenant middleware admits only this exact path + POST + scheme while `RETAINED_READS_ENABLED=true`; the controller verifies the pinned Ed25519 signature and digests, then freshly rechecks native and resource authority |
| A7 | POST `/api/clio/application-authority/retained-florida-native-current` | Intel | Signed `CapiroRetainedAuthority <probe>` only, admitted the same exact way; verified with the probe key |
| A8 | GET `/api/me`, `/api/clients`, `/api/clients/:uuid` | browser | Native bearer + fresh online session; `PREVIEW_NATIVE_GETS_ENABLED=true` on this task only |
| A9 | GET `/api/research-portfolios/:id`, `/:id/changes`, `/:id/reviews`, `/:id/annual-review`, `/:id/snapshots/:snapshotId` | Meri RP and RP-evidence gateways | Native bearer, ordinary tenant middleware and `RolesGuard` |
| I1 | POST `/intel-api/internal/legiwatch/retained-florida-budget` | Meri (Florida budget) | Signed `CapiroRetained` data envelope addressed to the Intel origin. **Served by Intel**, not this host: reached at `RETAINED_INTEL_ORIGIN` through the existing path-only Intel rule (priority 14) |
| I2 | POST `/intel-api/internal/legiwatch/retained-florida-authority` | Core | Signed `CapiroRetainedAuthority` probe; same Intel origin |

Not on this host: Objective generation routes (browser-only; frontend governed flags false, W4),
`/api/internal/objective-workload-authority/decisions` (workload RS256, private), Strategy API, and the W8 memory
routes (no Core owner yet).

### 8.3 Task definition (source)

- **Image:** `FIRST_CHAT_CORE_IMAGE_PINS` is `null` and PR48 (`6542f5b0…` / `sha256:722a4832…`) is no longer
  accepted. Rendering refuses until the integrated image is built from #84 (or its successor), scanned,
  and its source SHA + digest are pinned together. `RELEASE_SHA` follows the binding.
- **Environment:** `CORE_DEPLOYMENT_PROFILE=first-chat-preview` (makes the allowlist mandatory at startup), `PREVIEW_NATIVE_GETS_ENABLED=true`, `MERI_TOOL_ALLOWLIST=<65 names>`, `MERI_TOOLS_REQUIRE_SERVICE_SECRET=true`.
  - With trust bound: `RETAINED_READS_ENABLED=true`, `RETAINED_TRUST_ISSUER`, `RETAINED_CORE_ORIGIN=https://first-chat-preview.app-dev.capiro.ai`, `RETAINED_INTEL_ORIGIN`, `RETAINED_PRINCIPAL_KEY_ID`, `RETAINED_PROBE_KEY_ID`.
  - Without trust bound: `RETAINED_READS_ENABLED=false`, so every retained route returns 503.
- **Secrets (server-side only, from Secrets Manager by exact complete ARN in 967807252336/us-east-1):**
  - `INTERNAL_SERVICE_SECRET` (required binding field).
  - `RETAINED_PRINCIPAL_PRIVATE_KEY_PEM` and `RETAINED_PROBE_PRIVATE_KEY_PEM` (Ed25519 PKCS8; distinct secrets), only when trust is bound.
  - The execution role gets `GetSecretValue` on exactly these.
  - No secret or PEM value appears in the environment, the browser or the template.
- **Binding v3** (`schemaVersion`, `sourceHead`, `imageDigest`, `internalServiceSecretArn`, `retainedTrust|null`, `listener.guardPriority`): exact keys, complete secret ARNs, an exact HTTPS Intel origin, visible-ASCII key IDs, and an integer guard slot after the native-operations rule (occupancy and precedence checked offline against the readback, §8.1).

### 8.4 Inputs still needed before any change set (no AWS action here)

1. Build and scan the integrated Core image (W6), then pin it in the image-qualification commit.
2. Choose and read back the `INTERNAL_SERVICE_SECRET` secret. The existing source reference is `infra/deploy/api-strategy-serve-taskdef.json` → `…:secret:capiro/dev/internal-service-secret-6cEZG4`. The Meri broker must hold the same value server-side.
3. For retained reads, the following must be allocated and pinned:
   - two Ed25519 keypairs (principal, probe), with the private PEMs in Secrets Manager for Core;
   - the public PEMs and key IDs in the Intel task;
   - the issuer string, plus `RETAINED_INTEL_ORIGIN`: an existing HTTPS host whose `/intel-api/*` reaches the dev Intel target group (`capiro-dev-intelapi-albtg` in the historical snapshot; read back live);
   - an Intel image that contains this branch's Intel wiring.
   If the new secrets use a CMK other than the two already granted, the execution role needs `kms:Decrypt` via Secrets Manager for it.
4. JCS qualification of the in-repo RFC 8785 serializer (D13) before trust is enabled.
5. Owner approval for each hand-managed rule move in §8.1, a readback of the current listener against the frozen snapshot, then one coordinated change set (dot), applied in the §8.1 step order.
