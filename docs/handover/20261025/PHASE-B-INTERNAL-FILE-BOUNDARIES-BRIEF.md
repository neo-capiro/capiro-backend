## 1. Claude handles the harness

The quality bar is Claude's own. Answer quality comes from the whole harness, not only the model: its system prompt, built-in tools, subagents, skills, context management and compaction, and session handling.

- Run `@anthropic-ai/claude-agent-sdk` with its **full harness** and the Claude Code system-prompt preset, plus a short Capiro/Meri append. Don't replace the preset with our own prose.
- Do not rebuild what the SDK or AWS already does: model calls, retries, streaming, the tool loop, context management and compaction, session resume/fork, per-run turn and spend limits, AWS credentials.
- The real Claude SDK calls Bedrock directly using its narrowly scoped AgentCore runtime IAM role. Preserve the full preset, native tools, subagents and all 14 skills.
- Capiro data reaches Claude as **tools** (rule 4), not as a custom retrieval layer around the model.

Spec and plan: `phases/wave2/WAVE2-00-CLAUDE-NATIVE-HARNESS-SPEC.md`. It is **Wave 2 item 0**, and it comes before every other item that touches the runner, the proxy or authority.

## 2. Simple, standard architecture

```text
browser -> control (current access, conversation/run ownership, durable events)
        -> AgentCore Runtime V1 (isolated conversation session; actual Claude SDK) -> Bedrock
                                      -> tool gateway -> Core
control -> existing durable SDK SessionStore and artifact owners
control -> Temporal for required durable runs, schedules and background work
```

- **Core is the gatekeeper for Capiro data.** Tenant, member, client and wall rules remain server-side in Core. Check current access at admission and actual tool/data/artifact access; revocation must also prevent use of previously loaded privileged context. Do not duplicate policy in the harness.
- Reuse one isolated environment only for the same immutable tenant/actor/conversation and approved General/client scope. Serialize turns; stop idle compute and restore exact SDK transcripts and artifacts from their durable owners. A Runtime session ID is not authorization or durable storage.
- Keep the SDK's per-run turn/spend limits and one canonical tenant cap/usage owner. Preserve required durable runs, schedules, consent, outcomes and uncertain-write fences; neither SDK Task tools nor a warm process replaces Temporal durability.
- **No custom warm pool, per-turn ECS task requirement, model proxy, duplicated per-hop authority, credential-minting service or spend-reservation ledger.** Use standard Runtime V1; no V2 snapshot machinery or second SDK implementation.
- Before adding a mechanism, identify the standard feature or existing owner it uses. Before deleting a wrapper, prove the retained lower-layer behavior with meaningful positive/negative tests. Do not remove canonical authorization, idempotency or durable outcomes as “extra security.”

## 3. Leave no dead code behind

A change is not done until what it replaced is gone.

1. **Delete in the same PR** everything the change makes unused: code, tests, fixtures, docs, config keys, env vars, feature flags, IAM statements, ALB rules, secrets, task definitions, CloudFormation resources, kit steps, alarms and metric filters. Applied database migrations are history: never edit them. Drop tables only through a separately reviewed forward migration after a snapshot; this hosting migration does not itself authorize schema/data removal.
2. **Temporary diagnostics come out before merge** of the fix they were added for. A log line stays only as named product telemetry that someone reads.
3. **No code behind a flag nothing turns on.** The "source-complete, activation-held" status is retired for code we don't intend to ship. Dark features need an owner and a date, or they are deleted.
4. **No** commented-out code, `legacy` or `_old` copies, compatibility shims for removed things, or "superseded" stubs.
5. **Show proof in the PR:** list the identifiers, files and resources deleted, with a search proving no executable/active caller remains; label immutable historical references, and explain any drop in test count.
6. **Old plan tickets for removed mechanisms are closed as superseded**, not implemented and left dormant. See `source-of-truth/SUPERSEDED-BY-ITEM-0.md`.
7. **Reuse before write.** Use SDK, AWS and library features first. Custom code needs one line saying what the standard option couldn't do.

## 4. Capiro data must keep working

- Capiro data is served to Claude as tools. Core remains the source: today's read families call Core at `/api/clio/tools/<operation>`, and the new tools call the same endpoints.
- Tools are hosted by **control** (the existing tool gateway) so the runner never holds the Core service secret (`x-internal-service-secret`). The runner gets only a short-lived per-run token for control, scoped to tenant, user, client, conversation and run.
- Reuse the existing read handlers under `apps/gateway/sources/*` and their typed schemas. Delete the authority, relay and measurement wrappers around them.
- Parity: every read family that works today must be reachable as a tool with the same results and the same permission outcomes. A parity checklist is part of the item 0 spec.
- Negative tests are mandatory: another tenant's data, another client's data, and walled data must not be retrievable, through chat or through tools. A General chat reads across the clients the user can already see, with each client's wall enforced per result (FINAL-PLAN decision 2).
- The original read-only first cut is historical. Neo subsequently authorized preview client-record writes and autonomous Wave 2 completion. Activate accepted writes through their existing authenticated domain/intent owners and receipts, with the actual route/configuration and effect semantics verified. This does not authorize the assistant to send external mail without the user's specific send instruction.

# Phase B implementation allocation — File Workflows UI

Root dispatched this implementation on 25 October 2026. This allocation supersedes the proposed-owner and read-only status in the retained full brief below. Owner: File Workflows UI; Integration owns Phase A. Root assigns independent review and shipping; Release owns storage/scanner and AWS. Draft PR only; no merge, deployment, live probe, subagent, install, schema change or broad sweep. Current direct xhigh allocation supersedes historical model/role wording.

Repository: neo-capiro/capiro-backend. Branch: codex/wave2-internal-file-boundaries-20261025. Worktree: C:/dev/wave2-internal-file-boundaries-20261025. Exact base: 43fdd8928e517b1ce3a7a039f0fabeb8cf5fc5dd; base tree: 50c1214d60c17d29d9a61e5bbfea450489baa286. Stack this draft on codex/wave2-batch-core-20261025 (PR133); preserve the frozen donor and all other worktrees. Sparse checkout includes API, CDK, packages and scripts; no reusable environment is deleted or recreated.

Scope: Phase B only, using the four production paths and exact six POST expressions below. Narrow runtime/coverage/edge regressions plus the affected client-file-delete HTTP regression are allowed. No engagement.service.ts, scanner, first-chat-core.ts, policy service/types/modes, auth, manifests/lockfiles or schema edits. Keep generic deleteAttachment and every remaining provider/cleanup classification. Existing absence and finite-registry patterns suffice; no new mechanism is needed.

Verification: selected Jest runtime/route/service and retained file authority/custody/scan/delete tests using existing dependencies; finite synthesized edge behavior and negative neighbors/host/methods; restore-classification and route omission/broadening mutants. Report inherited failures separately and scoped type/lint availability. Preserve exact commands, counts and run/not-run evidence. Commit this complete standalone brief alongside the implementation. Root receives exact base/head/tree, changed paths and deletion proof; independent exact-head ACCEPT and Release/Acceptance gates remain external to this author.

Standing requirements revision loaded in full: meri-greenfield c0411e2cd20c35b3a8619817a4fec25ef7047aba, docs/handover/20261022/STANDING-REQUIREMENTS.md, including its instruction/engineering provenance correction. Sections1–4 above are unchanged. Direct Neo instructions establish authority; engineering interpretations and an approved document label do not independently approve new scope. This Phase B follows Root's existing direct allocation. Full Claude Agent SDK harness on standard AgentCore Runtime V1 direct to Bedrock, the control tool gateway, canonical Core, tenant isolation and durable user/firm memory remain unchanged. Root orchestrates at Ultra; author/reviewer work is xhigh. No new approval or qualification gate is introduced. The Core repository has no .github/pull_request_template.md at the sealed base.
## Full retained Integration repair brief (standing sections1–4 retained verbatim above)
FROM: Integration | TO: Root | TYPE: proposed PROCESS6.1 repair brief | RE: enabled workflow boundary repairs
Status: READ-ONLY COMPARISON COMPLETE; PROPOSED DISPATCH SCOPE. This document is not an implementation dispatch, deploy authorization or live acceptance result. No product file has been edited. Root's latest instruction authorizes the ordinary internal-storage classification in principle and requests this concrete per-phase brief before dispatch. The no-deploy window is retained until Root/Release expressly closes it.

1. Ownership, bases, sequencing and source evidence

Root orchestrates allocation/gates/merges; Integration is the proposed Core/frontend author; Primary is the separate exact-head reviewer; Release alone owns AWS, storage bindings, images, rollout and rollback; Acceptance alone owns the existing browser observations and any later explicitly allocated retest. File Workflows remains the sole upload diagnosis owner. No subagents, second orchestrator, #202 post, broad re-audit, installs, shared service changes or environment repair. Current direct xhigh allocation supersedes historical role/model wording in repository AGENTS files.

Frozen deployed source/reference heads (unchanged):
- Frontend PR151: dc53633f0b8c4de6432f3840e4fc79ac2ffeb02a; tree 114b64fb063f38bd46c9c57b6db57b2943fd223e; C:/dev/w2-batch-fe-20261025.
- Core PR133: 43fdd8928e517b1ce3a7a039f0fabeb8cf5fc5dd; tree 50c1214d60c17d29d9a61e5bbfea450489baa286; C:/dev/w2-batch-core-20261025.
- Meri PR252: 7eee7f7c358be9ae903169816ef68eb6e64ae1f3; tree a87135487d6c48d579b3fdfc3845e975b1d56567; C:/dev/w2-batch-meri-20261025.
- Accepted test-only FE PR152: 4fa98196d6a7dd9d5d092c15c544ffb5df4273aa; tree 48a5a63283d3f75e6a8151234a2ac499129b7c05. Primary accepted at 15:28:28 UTC. Its 14 browser and 11 distinct unit passes are closed evidence; earlier full-suite failures remain recorded, and no whole-suite green is inferred.

Proposed isolated successors, not yet created: FE codex/wave2-enabled-intents-20261025 at C:/dev/wave2-enabled-intents-20261025; Core codex/wave2-internal-file-boundaries-20261025 at C:/dev/wave2-internal-file-boundaries-20261025. Proposed FE base is accepted PR152 above, preserving its four test fixture corrections, and proposed Core base is exact PR133 above. Root must seal these bases/file ownership in the actual dispatch; a changed base requires affected re-review. No edits to frozen candidates/donors. The two independent code changes can be reviewed separately; Release's storage/scanner work must not race Integration on first-chat-core.ts or attachment-scanner.service.ts. Those paths are outside the initial Integration edit allocation.

Sources: current STANDING-REQUIREMENTS sections 1-4 reproduced above; PROCESS.md sections 6.1/6.2; current repository/host AGENTS.md; source-of-truth plans and supersession register listed in section 8. Reuse standard Next server native-token acquisition, existing Meri/Core membership admission, Engagement's existing route/service classification, and the finite preview-write registry. No new auth, permission, scanner bypass, policy service or route framework is needed for phases A/B.

Read-only evidence:
- Integration outputs/WAVE2-PREPARED-ACTIONS-DIAGNOSIS.txt: complete credential producer/receiver trace and live-cause limitation.
- Integration outputs/WAVE2-ENABLED-BOUNDARY-COMPARISON.json: methods/paths, retained actual public ALB template (61 rules), exact-source comparison and safe runtime-flag values. SHA256 of retained actual template: b48c3a06bd42de5c63d74df6925ea5ed1a5a3320436797dd36bc31b3462c803a. Six missing admissions; no source-versus-retained-actual disagreement for sampled paths.
- File Workflows outputs/ORDINARY-UPLOAD-DIAGNOSIS.txt under C:/Users/Administrator/Documents/Codex/2026-10-25/wave2-visible-file-workflows-ui: sole one-attempt upload trace and source/policy/config findings. Do not repeat upload diagnosis.
- Release outputs/LIVE-ROLLOUT-HANDOFF.txt under C:/Users/Administrator/Documents/Codex/2026-10-25/wave2-visible-release: coherent Core14, FE31, Control70/Worker66/Schedule3 and stable window from 16:23:37.165038 UTC. Private retained source/config/template evidence is referenced by filename only; do not publish its contents or bindings.
- Release outputs/ORDINARY-UPLOAD-STORAGE-PREP.txt under the same folder: completed read-only ordinary Assets/scanner prerequisite report, SHA256 ba3a34f79f080c6a10b987d2fb22e312d9d889081a0f78632e5636d232564466. Private evidence ordinary-upload-storage-prep.json is referenced by name only. Actual provisioning, external/manual IAM grants and existing live scanner status were not queried or inferred.
- Acceptance handback 16:51:10.405Z and outputs/acceptance-status.txt, wave2-live-acceptance-matrix.txt, wave2-user-acceptance-checklist.txt under its 2026-10-25 work folder: finite UI batch ended, no further prompt/effect pending. Six model submissions C1/C2/G1/G2/G3/C3; D1/R1 unused and not reassigned. Task/document/routine/memory/provider effect counts all zero. C3 preserved history after 914.015 seconds untouched. G3 UI cancel persisted, with Runtime separately owning physical/correlation qualification. No broader readiness claim.

2. Bounded comparison and actual mismatches

| Already enabled flow | Proven source/config boundary | Existing live observation / smallest action |
|---|---|---|
| Ordinary Files lifecycle | Upload-url and confirm POSTs absent from source and retained actual edge. Both service methods and three controller routes (upload, confirm, reviewed delete) classified as attachment_external_write while ENGAGEMENT_EXTERNAL_ACTIONS=disabled. Core14 has no explicit ASSETS_BUCKET injection; selected template lacks ordinary Assets S3/KMS task permissions. Scanner source selects NullAttachmentScanner. Other sampled list/usage/move/access/receipt/delete edge paths admit. | One 95-byte TXT attempt failed; actual HTTP stage/status unknown. Add two finite routes; correct only demonstrated internal classifications; Release resolves existing Assets binding plus real scan readiness. Downstream upload/scan/read/preview/download/move/delete remain NOT RUN. |
| Approval actions | FE obtains native token but sends opaque conversation session as bearer to Meri's native membership-gated intents route, ultimately Core JWT verification. Current test incorrectly expects opaque bearer. Required Core approval/authority edge routes admit; approval flag true. | Panel read unavailable. Static defect established; live HTTP/cause not observed. Correct only intents proxy bearer and its regression. |
| Tasks / action follow-through | Sampled Core approval routes admit. Relevant FE/Meri flags and owner declarations are present. These Meri owners correctly resolve opaque action sessions; do not apply the intents change to them. | Actions connected, then access cleared before query (zero query). Task preparation form reached, but no nominated harmless task ID; no preparation/mutation. No new proven defect from this comparison; preserve unresolved failure/fixture prerequisite. |
| Ordinary memory | Four enabled decision/correction POST paths absent from source and retained actual edge. Candidates-mine/status and owner-items GETs admit. Native-token forwarding is correct; owner review flag true and historical preview-memory flag false is correct ordinary mode. | Pending proposals returned zero; current personal-memory read unavailable. The four write omissions do not explain the GET failure. Add four finite routes only; read failure still unproven. No decision/retry/correction submitted. |
| D1 document | FE create_word enabled; Meri artifact/download/authority declarations present; Core artifact-authority route admits. This owner intentionally resolves opaque sessions. Ordinary Assets bucket and Meri artifact storage are distinct. | One connect returned current document context could not be verified. No create/model call, inspection/download/native-open or denial acceptance. No proven route/flag fix; existing failure correlation remains needed. |
| R1 routine | FE action flag and Meri routine/task/workflow declarations present; policy/check, cancellation-proof, unattended-grant, internal current/reads paths admit. Routine owner resolves opaque sessions. | Connect reset; no definition/update/occurrence and R1 model slot unused. No proven route/flag fix; retain unresolved observation. |

All source/config statements are bounded inspection, not live HTTP results. Meri private-edge source is host-only forwarding with no per-path/method filter; prior stack/target-health evidence was reused, no fresh actual private-edge template was inspected. Native flags cannot establish current end-to-end access. No 401/404/502/503 is asserted for any observed UI failure. No generic retry or acceptance replay is proposed.

3. Phase A — FE approval credential repair (proposed Integration allocation)

Initial exact changed paths, relative to the sealed FE successor:
- apps/web/src/shared/meri-intents/proxy.ts
- apps/web/tests/meri-intents-proxy.test.ts

Counterexample: proxy.ts obtains nativeToken at line 55, checks it at 57, then sends the opaque session at line 82. Meri apps/runtime/product-applications.mjs:103 and product-ports/intents.mjs:125/129 use product-access/http.mjs:57 and canonical conversationMembership. Core tenant-context.middleware.ts:325-337 requires the native JWT. history-proxy.ts:135 already provides the correct same-class forwarding precedent. Existing tests at lines 47/72 codify the wrong upstream credential.

Proposed diff: send the already-obtained server nativeToken for both list and decide. Retain opaque-header presence/lifetime prerequisite, same-origin checks, native sign-in check, typed request/response contracts, no-store, deadline, correlation/refusal behavior and browser isolation. Update the false opaque-forwarding comment/expectation in the same patch. No fallback, token minting, new auth owner, browser bearer acceptance, Core/Meri change or global replacement of opaque-session APIs.

Planned checks, all NOT RUN in this read-only phase: selected existing proxy regressions and only relevant access/denial cases, using the retained Node/dependency environment. Make a producer/receiver regression distinguish synthetic native versus opaque credentials, admit an empty authorized list, and preserve upstream denial. Cover list and decide forwarding without an actual decision or network effect. Mutation: restore the opaque bearer and require the new boundary regression to fail. Preserve existing missing session/token, origin and deadline assertions; no test-count drop without explicit justification. Run scoped lint/format/type checks only as appropriate to changed source and existing commands. No broad browser suite or closed-gate reruns.

4. Phase B — Core finite admissions and existing internal-storage classification (proposed Integration allocation)

Initial exact production paths:
- infra/cdk/lib/preview/first-chat-preview-writes.json
- apps/api/src/engagement/engagement.controller.ts
- apps/api/src/engagement/runtime/engagement-runtime-route-policy.ts
- apps/api/src/engagement/governed-engagement.factory.ts

Finite admission diff: add these six anchored POST paths through the existing service=core/method=POST groups, respecting existing per-rule limits and preview host/target/priority ownership. Preserve unrelated methods, catch-all and live rules. Do not broaden /api/* or duplicate the owning registry in first-chat-core-routes.json.
  ^/api/engagement/attachments/upload-url$
  ^/api/engagement/attachments/confirm$
  ^/api/memory/candidates/[A-Za-z0-9_-]+/owner-decision$
  ^/api/memory/version-candidates/[A-Za-z0-9_-]+/approve$
  ^/api/memory/version-candidates/[A-Za-z0-9_-]+/reject$
  ^/api/memory/items/[A-Za-z0-9_-]+/review-correction$

Existing controller methods are mounted; no memory domain/auth/schema mutation is required. Missing admissions independently block the enabled writes; this does not prove a live memory read failure cause. File access method is PATCH, not POST; both item/folder access already admit and need no additional route.

Classification diff (Root has authorized ordinary internal attachment storage; no new external-action enablement):
- Remove only attachment_external_write decorators for EngagementController.createAttachmentUploadUrl, confirmAttachment and deleteAttachment (the reviewed public deletion handler).
- Remove these same three entries from ENGAGEMENT_RUNTIME_ROUTE_POLICY, whose documented scope is outbound/provider-sensitive boundaries. Internal routes already use this existing absence pattern.
- Remove only createAttachmentUploadUrl and confirmAttachment entries from RUNTIME_ACTION_BY_METHOD in governed-engagement.factory.ts. Keep its separate deleteAttachment helper entry and other system cleanup, synthetic deletion, extraction, buffer-generation, prospect-copy and provider/send classifications.
- Public delete calls deleteReviewedAttachment. That method retains reviewed client command/transaction/access/custody/deletion receipt semantics, with the existing nonclient fallback. The proxy binds unwrapped methods to the target; no generic helper exemption is necessary. Review this retained lower-layer call path with the existing negative/deletion tests before removal.
- Preserve native auth, tenant/member/client/wall/parent visibility, upload/confirm exact-object checks, size/hash/MIME, quarantine, scan status, custody, access/delete commands and durable outcomes. Do not modify engagement.service.ts, runtime-policy service, policy types/modes or auth to implement this classification correction. ENGAGEMENT_EXTERNAL_ACTIONS remains disabled; no fictional attachment-only mode is added.

Expected test diff paths (change only where the affected existing assertions require it):
- apps/api/src/engagement/runtime/engagement-runtime.guard.spec.ts
- apps/api/src/engagement/runtime/engagement-service-runtime.boundary.spec.ts
- apps/api/src/engagement/runtime/engagement-runtime-route-coverage.spec.ts
- infra/cdk/test/preview-first-chat-edge.spec.ts
- infra/cdk/test/preview-first-chat-core.spec.ts, only if its actual registry consumer assertions require an update.

The route-coverage spec currently treats nearly all attachment-classified routes as external; extend its existing local-safe attachment test classification for exactly the same three handlers and prove unrelated sensitive handlers remain covered. Do not weaken or delete manifest coverage. No runtime allowlist or new security-exception service is introduced by adjusting this test's expected classification.

Planned checks, all NOT RUN: affected runtime guard/service/route-coverage specs demonstrate these internal operations reach the canonical owner with external actions disabled while outreach send/generation, extraction/prospect copy and other unaffected operations still refuse before external execution. Select existing client-file delete HTTP/storage/transaction tests and upload/confirm authorization/scan negative cases to prove retained lower-layer enforcement; use synthetic records and isolated fixtures only. Reuse exact-source unchanged evidence when sufficient. A finite edge test must admit all six real paths with POST and retain wrong-method, wrong-host, neighboring-path and unrelated-write refusals. Mutation checks for newly executable assertions: restore a removed internal classification; remove a required admission; or broaden a path and require the corresponding behavioral/negative assertion to fail. No mutation of unrelated authorization logic just to manufacture a test result. Build/type/lint only for changed affected packages with retained toolchain; report exact commands and failures, not generic green.

5. Phase C — Release storage/scanner prerequisite and later bounded activation

This is a dependency work package, not permission to provision a new scanner or change a security policy. Release's received read-only finding identifies existing AssetsStack, intended preview Assets stack, origin-limited CORS, KMS/TLS/block-public-access/versioning/retention. Retained rendered templates were explicitly synthetic/source-only. No retained actual provisioned bucket/key/scanner receipt was found. Core's selected first-chat task role lacks ordinary Assets S3/KMS data grants; the other proposed backends stack contains the reusable tenant-prefix grant pattern. The Meri artifact bucket must not be reused.

Exact existing source owner paths for Release's concrete follow-up:
- infra/cdk/lib/assets-stack.ts — existing ordinary Assets bucket/key owner.
- infra/cdk/lib/preview/services-stack.ts — reusable tenant-prefix S3/KMS and ASSETS_BUCKET binding pattern; different proposed stack, not the selected first-chat owner.
- infra/cdk/lib/preview/first-chat-core.ts — selected serving task/env/role owner needing the approved actual binding and narrowly scoped data grants.
- apps/api/src/engagement/attachment-scanner.service.ts — existing scanner adapter/status owner; currently always selects NullAttachmentScanner.
- apps/api/src/engagement/engagement.service.ts — existing confirm/quarantine/readiness owner, to be inspected by the scanner implementation owner only if the accepted real verdict transition requires a change.
- apps/api/src/config/config.schema.ts — current scan-required default false; no flag flip or schema extension allocated here.

Release proposed a standard AWS managed malware-protection plan plus its scoped role/KMS/notifications or result tags, an adapter through the existing Engagement scanner interface and exact-object verdict transition. This is a proposed option from Release, not an installed binding, verified complete design, or approved new provider. Release's concrete evidence/minimal-delta report is complete at the path above; Root must settle any missing scanner contract/owner before a scanner implementation dispatch. Integration does not choose a scanner by implication, implement a policy exception, or start cloud queries/provisioning. A null scanner with required=true fails closed; required=false reports scanner_not_required, never clean. Neither flag setting substitutes for the required working scanner/custody acceptance. Do not use an unscanned upload as proof of the repaired lifecycle.

The Release report identifies two critical implementation bounds for that follow-up: current getStatus(bucket,key) does not establish object-version custody, and confirm replay returns an existing pending row without an identified asynchronous verdict reconciliation. A clean verdict therefore must be bound to the exact version/verified bytes and drive the existing quarantine/readiness owner; an infrastructure-only scan plan is insufficient. Only the scanner may write scan-result tags. Reuse scoped tenant-prefix PutObject/GetObject/version-read and key GenerateDataKey/Decrypt-through-S3 patterns; add delete or other operations only when demonstrated by the reviewed lifecycle. Keep the original DataStack/database untouched. Provider service/cost references are in Release's report; no zero-cost or actual provisioning claim is made here.

Storage done criteria for the later Release allocation: identify actual existing/provisioned ordinary Assets bucket/key; retain preview-only CORS/TLS/encryption/public-block/retention; inject ASSETS_BUCKET and tenant-prefix/task-role permissions through selected first-chat owner; establish approved scanner result/custody contract, pending/quarantine and exact version/object verdict behavior. Report missing actual evidence explicitly. Author/source review, image, scan, rollout and later acceptance are separate gates. No archived template execution, broad storage grants, external-action enable, model requests or changes during the current window.

6. Phase D — unresolved observations and later acceptance ownership

No source edit allocated yet for Actions connection loss, document context failure, Routines reset or current personal-memory GET unavailable. Flags and sampled routes match; source/config inspection alone cannot classify these failures as legitimate unavailable or identify a bug. Root may relay requests to Acceptance/Release/Runtime for existing sanitized timestamps/status/error codes and owner correlation only. No refresh, retry, new logs sweep, customer-ID read or duplicate trace requested. Direct outgoing chat tools are unavailable in this Integration session; relay requests are retained in Integration STATUS.md.

Acceptance remains ended for this finite batch. Root must explicitly allocate any retest against a later coherent release. Preserve D1/R1 named slots and all 8 tabs; no borrowed idle/client conversation, invented task ID, automatic mutation replay or unbounded model run. A known harmless authorized task fixture is still required for task effect acceptance. Approval native forwarding is locally testable without a live decision. Ordinary memory four write routes are not accepted until a properly nominated owner/candidate fixture is used. Files need the actual storage/scanner prerequisites before a single bounded full lifecycle test. Document/Routine effects remain unrun until their owner/context failures are resolved.

7. Definition of done, checks and resources

Current read-only phase: report exact findings and proposed path ownership, six missing route admissions, retained safe config facts and all live limitations. No tests, mutants, build, source edits, commits/pushes, browser operation, model/effect call, DB/AWS/config/service action occurred in this phase. New executable assertions=0; mutation=N/A. Diagnostic read commands that used an incorrect scanner subdirectory or absent Release STATUS path returned file-not-found and were corrected/bypassed; they are not test failures or product evidence. No customer-linked IDs, credentials, bodies or binding values are published.

Later implementation done: exact sealed base/head/tree; isolated changed path list and donor/frozen-head preservation; meaningful affected test command/tool version/UTC/exit/count; new assertions and killed mutants; explain dropped tests; base-versus-head inherited failures preserved; scoped deletion search for removed wrong forwarding/classifications; draft PR committed and pushed; independent Primary ACCEPT for that exact head. No merge requested by author. Root receives an ordinary concise handoff, not another qualification framework. Tests are NOT RUN until dispatch; no preemptive passing claim.

Resource budget: one author per allocated path; existing dependencies only, synthetic local fixtures and selected tests; no model/provider budget or live fixture actions for Integration. No shared containers, database reset, repeated closed suites or installs. Integration owns only its new isolated worktrees, local scripts and outputs; preserve donors, caches, services and Acceptance tabs. No cleanup/destruction is necessary for this read-only phase. Any later task-owned temporary test resource must be named and cleaned by its owner without touching shared resources.

Named pending gates: Root seals branch bases/file ownership and dispatch; Primary exact-head review after code; Release actual Assets/scanner prerequisites and rollout; Runtime/Release existing owner correlation for unresolved UI failures; Acceptance nominated fixtures and explicitly allocated retest. The current six-route/credential/classification plan is concrete and reviewable independently of those unresolved observations.

8. Verbatim bounded source tickets and scenarios

The excerpts below retain historical evidence/scope labels verbatim. Root's current ordinary-storage authorization and finite enabled-workflow allocation govern this proposed repair, not historical preview holds. Apply source-of-truth/SUPERSEDED-BY-ITEM-0.md: no removed model proxy, per-operation authority/minting, prepared registries, reservation ledger or warm pool is recreated; browser-owned action sessions and canonical Core enforcement remain. These excerpts constrain retained behavior and do not allocate whole-ticket rewrites.

#### PF-01 · P0 prerequisite · Qualify ordinary Portfolio deployment separately from the restricted preview

**Evidence:** [backend-policy.server.ts](https://github.com/neo-capiro/capiro-frontend/blob/4f9a7e8dcaa9ba03494dc5a49559daf70cea5100/apps/web/src/shared/preview/backend-policy.server.ts); [read-config.server.ts](https://github.com/neo-capiro/capiro-frontend/blob/4f9a7e8dcaa9ba03494dc5a49559daf70cea5100/apps/web/src/shared/preview/read-config.server.ts); [PreviewClientCatalog.tsx](https://github.com/neo-capiro/capiro-frontend/blob/4f9a7e8dcaa9ba03494dc5a49559daf70cea5100/apps/web/src/features/portfolio/index/PreviewClientCatalog.tsx). Main's qualified roster pin is b97a3286; PR115/111 advances it to 50475125 but keeps activation held. PreviewClientCatalog intentionally has no profile click/selection/detail/edit.

**Root cause:** Source-only preview admission and exact-host/source pairing are narrower than the fully implemented ordinary product. That is an intentional containment boundary, not a requirement to expand the preview to deliver the ordinary product. Broad API configuration cannot substitute for selected-client/native auth qualification.

**Bounded work:** Root has approved one exact first-chat Core preview owner for client-record CRUD/detail/account-owner reads and writes, with canonical online membership, role, client-wall and capacity enforcement. Frontend uses the existing first-chat target/source pair and explicit client-write flag; keep the legacy preview routing marker for Meri compatibility. Do not relax the reserved roster guard or enable unrelated logo, profile-note, import or provider writes through a global flag. Qualify each remaining ordinary product workflow through its own canonical owner; the approved client slice does not complete them.

**Dependencies:** Parent shared proxy/config plan X-01; PF-10/11 meeting corrections; exact migrations and source/image custody; separate owner approval for any deployment/access change and, independently, any preview-policy expansion.

**Acceptance:** Verify current signed-in role, foreign tenant, hidden/revoked client, archived client, changed identity, capacity/owner concurrency and malformed requests against the exact serving cohort. Unadmitted methods/paths fail before upstream dispatch. Client writes must not break first-chat or broaden reserved roster access. Source and historical build receipts do not replace real service and deployed acceptance.

#### PF-13 · P1 reliability · Several ordinary mutations have only mounted/session uncertainty fences, not durable attributable receipts

**Evidence:** [mutations.ts](https://github.com/neo-capiro/capiro-frontend/blob/4f9a7e8dcaa9ba03494dc5a49559daf70cea5100/apps/web/src/features/portfolio/calendar/mutations.ts); [api.ts](https://github.com/neo-capiro/capiro-frontend/blob/4f9a7e8dcaa9ba03494dc5a49559daf70cea5100/apps/web/src/features/portfolio/calendar/artifacts/api.ts); [api.ts](https://github.com/neo-capiro/capiro-frontend/blob/4f9a7e8dcaa9ba03494dc5a49559daf70cea5100/apps/web/src/features/portfolio/calendar/sharing/api.ts); [api.ts](https://github.com/neo-capiro/capiro-frontend/blob/4f9a7e8dcaa9ba03494dc5a49559daf70cea5100/apps/web/src/features/portfolio/calendar/sync/api.ts); [contact-create-attempt.ts](https://github.com/neo-capiro/capiro-frontend/blob/4f9a7e8dcaa9ba03494dc5a49559daf70cea5100/apps/web/src/features/portfolio/relationships/contact-create-attempt.ts); [mutations.ts](https://github.com/neo-capiro/capiro-frontend/blob/4f9a7e8dcaa9ba03494dc5a49559daf70cea5100/apps/web/src/features/portfolio/files/mutations.ts); [actions.ts](https://github.com/neo-capiro/capiro-frontend/blob/4f9a7e8dcaa9ba03494dc5a49559daf70cea5100/apps/web/src/features/portfolio/client-profile/quick-log/actions.ts). By contrast [command-actions.ts](https://github.com/neo-capiro/capiro-frontend/blob/4f9a7e8dcaa9ba03494dc5a49559daf70cea5100/apps/web/src/features/portfolio/client-profile/quick-log/command-actions.ts) already has command receipt recovery.

**Root cause:** Some handlers deliberately freeze an uncertain write in mounted state, and some reconcile only current state via GET. That avoids immediate unsafe retry but does not identify whether this exact command succeeded after navigation/reload, nor prove attribution under concurrent edits.

**Bounded work:** Inventory by actual mutation and add only missing command protocols: meeting create/update/reassign; notes/debrief create/edit/approval/sharing; externally consequential calendar sync; client contact create; plain Quick Log create; file metadata/access/delete where current state is insufficient. Server accepts immutable command ID + actor/client/resource/version + payload digest, commits receipt with the mutation, exposes authenticated lookup, and handles same-key/same-payload replay versus conflict. UI stores a minimal scoped journal before dispatch and recovers the same command; never stores bearer tokens. Distinguish definitive refusal, accepted, completed, and unknown/provider-pending. Existing durable prep/ActivityCommand/prospect upload/Objective protocols should not be replaced.

**Dependencies:** Owner-specific DB transaction or provider reconciliation capability. For external actions, a DB receipt cannot falsely guarantee provider completion.

**Acceptance:** Lost response before/after commit, reload, multi-tab, session renewal, duplicate click and concurrent conflicting edit yield one intended write or an explicit unresolved outcome. Changed payload with same ID refuses; arbitrary fresh retries never recreate uncertain work; current-state match alone is labeled observation, not historical receipt.

#### MF-01 — Publish truthful capability and route state (P0 activation gate)

- **Root cause / evidence:** Route tree and explicit allowlists disagree with stale `shared/meri-resources/unavailable.ts`: history/create/approvals/preferences now have real slices; lifecycle is publicly exported upstream. Fixture navigation resembles working product.
- **Bounded files/owner:** Frontend shell `SidebarDestinations`, `Sidebar`, `MeriMobileNavigation`, `MeriHome`; `shared/meri-resources/unavailable*.ts`; route-activation tests. Do not edit every screen indiscriminately.
- **Implementation:** Create a reviewed capability table with source pin, ordinary route, deployment flag, accepted public contract version, runtime owner, required receipt and unavailable reason. Render only supported ordinary links; clearly label design fixtures. Replace stale no-contract copy with precise held/not-configured/missing-consumer language. Record PR115 as already merged and preserve its status-copy regression. Distinguish source reception from deployment/flag activation in release notes.
- **Dependencies / exclusions:** MR/MT/MM truth inventory, PR115 merge provenance, canonical PF-01 deployment qualification. No global enable flag or fixture-to-production rewrite.
- **Acceptance:** For every flag/config combination, sidebar/home/mobile/route guard/API agree; no dead href or disabled action claims completed work. Tree test proves actual mounts; `/kit` is not advertised. All fixture destinations remain recognizably non-authoritative.

#### MF-03 — Clear approval content on authority refusal (P0 before approvals activation)

- **Root cause / evidence:** Paging refusal currently retains existing rows at [`apps/web/src/features/meri/conversation/intents/useIntentList.ts:55–64`](https://github.com/neo-capiro/capiro-frontend/blob/4f9a7e8dcaa9ba03494dc5a49559daf70cea5100/apps/web/src/features/meri/conversation/intents/useIntentList.ts#L55-L64); access adapter classifies errors but has no host access-loss callback.
- **Bounded files/owner:** `conversation/intents/useIntentList.ts`, `useConversationIntents.ts`, `shared/meri-intents/access.ts`, relevant host lifetime boundary; new unit/browser regressions.
- **Implementation:** Classify published authority denials separately from transient unavailable errors. On ACCESS_DENIED/MEMBERSHIP_REVOKED/MEMBERSHIP_CHANGED or expired/revoked session as contract requires, clear sensitive rows, pending confirmation details and related derived caches; signal parent to retire exact session where appropriate. Preserve harmless pagination continuity only for retryable transport/service outages, visibly explain the distinction. Ignore stale completion from prior identity.
- **Dependencies / exclusions:** Use current intents error vocabulary; no blanket error suppression, no local authorization inference, no new backend grants.
- **Acceptance:** Load first page, revoke access, Load More → zero old proposal content/actions; same for refresh/decision denial and identity switch. Transient page failure keeps admitted rows only under still-valid authority and exposes retry. Out-of-order successful old reply cannot restore data.

#### MF-17 — Receive memory and preferences through existing canonical projects (P1/P2, coordination only)

- **Root cause / evidence:** PR115 owner-memory held source is not governance; main narrow personal preferences persists but UI consumption incomplete. ST-07–19 already own these gaps.
- **Bounded files/owner:** PR115 memory route/home links and public packet receiver; `MeriPreferencesPanel`, `UserPreferencesHost/Form`; only scoped navigation/lifetime integration here.
- **Implementation:** PR115 source reception is complete. Attach Meri acceptance to ST-11 owner-memory source-packet release; verify exact microsecond revision token and activeItemUnchanged correction semantics from Core/MM. Do not enable null source. For ST-12 apply saved theme/density/timezone deliberately at agreed app boundary after reload. Route remaining preferences to canonical ST13–19 delivery or explicitly unsupported copy, including fake feedback receipt correction.
- **Dependencies / exclusions:** ST-07–11 governance/files/grants/notifications, ST-12–19 settings, MM. No second memory schema/governance center or settings backlog.
- **Acceptance:** Owner memory view only shows current authorized own/wall/governance-eligible items, denied items vanish, changed token conflict reloads without overwriting; preferences persist and intended consumers actually change; notifications/privacy/connectors/help never show false save/send outcomes.

Matching master scenarios (verbatim; selection, not an instruction to run all now):
| E05 | Session expiry and transient Core503 | Retryable unavailable differs from revoked identity; no unauthorized bytes or false success |
| E06 | Sign-out/tenant/client change with stored draft/intent | Old data/credentials/receipts cannot cross the new identity or client |
| E13 | Approval allow/reject/expiry/revoke | Captured decision persists before dispatch; exact command only; stale approval refuses |
| E14 | Approval response lost/reload/paging denial | Read-only reconciliation, no automatic repost, current-access cache invalidation |
| E23 | Memory recall after correction/revocation | Current revision/permission, prior content not reused incorrectly, provenance retained |
| E24 | Memory proposal approved/rejected/lost acknowledgment | Correct owner and durable outcome; four payloads retained/tombstoned coherently |
| E26 | Attachment upload/read/file | Bytes/hash/MIME/size/scan/current custody tied to exact actor/client; rejected file never appears usable |
| E43 | Mixed versions/frontends/contracts | Explicit version/source refusal or accepted backward compatibility; no silently misparsed approvals/output |
| E44 | Inaccessible/empty/stale provider data | Truthful unavailable/no-results distinction, no fabricated success/evidence |
| E45 | Canonical cross-module handoff | Portfolio/Workspace/Settings context preserved with entity IDs; effect appears in receiving module after reload |

Recorded 2026-10-25T16:59:24.248073+00:00. Product files unchanged; no live cause inferred.

ROOT PLAN-REVIEW SUPERSESSION (2026-10-25): Earlier blanket statements in this read-only brief that ordinary Files requires a newly provisioned real malware engine are superseded. No unconditional new-engine prerequisite was verified in the accepted ordinary Files plan. Preserve the existing selected scan policy and truthful scanner_not_required/unscanned state; no scan flag flip or false-clean claim. GuardDuty was a proposal only and is not allocated or a release gate. Meri upload-to-evidence has its separate stricter scan/custody contract. Release scope is canonical Assets provisioning/binding/grants. This correction does not block Phase A frontend credentials. Root has assigned Core Phase B to File Workflows. Existing original observations are retained as history, not current scope.


## Applicable supersession register (verbatim)

# Superseded by Wave 2 item 0: register (Neo, updated 2026-10-24)

**Current target:** [AgentCore Runtime standard V1 with the real Claude Agent SDK](../plan/AGENTCORE-RUNTIME-MIGRATION-20261024.md). This register removes obsolete mechanisms, not native SessionStore, artifacts, current Core checks, required Temporal durability or any accepted feature.

**Why this exists.** The two master closeout plans, `STANDING-RULES.md` and `FINAL-PLAN-20261021.md` were written for the architecture Neo has now decided to replace. Wave 2 agents implement "each ticket's bounded work and meet its acceptance exactly", so an old ticket followed literally rebuilds code that item 0 deletes. This register, plus the inline markers in the plans, stops that.

**Principle.** Behaviour and quality stay binding: the E-scenarios, the RG gates, the original release suite and every product acceptance. The mechanisms that existed to protect, measure or speed up the removed layers are superseded. Neo's requirements are in `../STANDING-REQUIREMENTS.md`. The spec that replaces the layers is `../phases/wave2/WAVE2-00-CLAUDE-NATIVE-HARNESS-SPEC.md`.

**Legend**

| Marker | Meaning |
|---|---|
| **SUPERSEDED** | Do not implement, extend, qualify or measure. Keep only the behaviour named under "keep as acceptance". Close the ticket as superseded; don't leave its code dormant. |
| **RE-SCOPED** | The behaviour is still required. Implement it on item 0's architecture. Ignore any instruction in the ticket that names a removed component. |
| **DONE** | Shipped already. Informational. Its code may be deleted by item 0. |
| (unlisted) | Unchanged. If its text still names a removed component in an implementation instruction, follow the intent and implement it on item 0's architecture. |

Each marker also appears inline in the plan, directly under the ticket heading, in the index rows and on the scenario rows. If the inline marker and this register differ, ask on #202.

---

## A. Components deleted by item 0

Do not build, extend, qualify, measure or preserve any of these. The paths are a starting inventory taken from `main` at `05d588c7`; confirm with the import graph and delete leaf-first.

| Component | Where it lives (inventory) | Replaced by |
|---|---|---|
| Owner/proxy pair (model credentials, per-call admission, reservations, CountTokens, retries, mTLS pair) | `apps/proxy/**`; `apps/runtime/model-grant-issuer.mjs`, `pinned-native-transport.mjs`, `native-runner-gateway.mjs`; services `meri-product-preview-owner` and `-proxy`; the private PKI (`meri/preview/private-pki`); `infra/product-preview/first-chat-private-edge.mjs` and `OWNER-INTERFACE-CLOSURE-*` | SDK → Bedrock directly, using least-privilege Runtime IAM |
| Budget reservation, settlement and liability recovery | `apps/gateway/budget/**`, `apps/gateway/model-proxy/**`, `infra/product-preview/first-chat-seed-budget.sql` and its consumers | SDK `maxTurns` / `maxBudgetUsd` per run; one tenant ledger row per run, debited from the SDK result; the tenant monthly cap checked at admission |
| Per-operation authority | `apps/runtime/native-authority/**`; `read-credential-relay.mjs`; `prepared-run-*`, `prepared-candidate*`, `prepared-next-run`, `original-run-preparation`, `original-stop`, `task-bootstrap` in `apps/runtime/` | One Core access check per turn in control; SDK `allowedTools` / `canUseTool` / hooks; Core enforcement on every tool call. **Review, don't delete wholesale:** `apps/control/admitted-runs/**` and `apps/control/action-host/**` serve the browser's action-session and submit routes (`/api/action-followthrough/*`) and idempotent submit (E03). Keep what the browser still needs and delete the pin, producer-grant and capability-hash machinery inside them once the import graph shows it unreachable. Also review `memory-context-relay.mjs` and `occurrence-relay.mjs`: routines still need consent-bound reads |
| Temporal issuer | `apps/runtime/temporal-issuer/**`, `temporal-issuer-cli.mjs`, `temporal-product-*`, `temporal-authorization.mjs`; `infra/product-preview/first-chat-issuer-service.mjs`; service `meri-product-preview-temporal-issuer` | Temporal's standard auth: an mTLS client certificate or a namespace API key from Secrets Manager |
| P1 timeout/budget table, P2 proof reuse and exchange collapse, authority-lite (S2), signed lease (S4) | P1 #200 and C9 #203 (closed unmerged; historical). Already merged, to be deleted with the layers: P2 PR-A #196 and S2 #213 (P2 PR-B #199 was closed unmerged) | Nothing. They only existed to make the removed layers fast enough |
| Custom checkpoint / dormant-original continuity | Legacy completion/checkpoint and dormant-original branches, and callers that require them; identify exact current imports before deletion | Existing native SDK SessionStore opaque transcripts/substreams, durable artifacts, `resume` / `forkSession` and canonical successor ownership stay. Do not delete working native persistence merely because its filename contains session or continuation. |

| Per-turn Fargate and custom warm pool S3 | Fresh-task allocation/readiness, task router/bootstrap, runner family/IAM/SG/flags/alarms and old shipping callers after cutover acceptance | Runtime V1 isolated conversation session, idle stop and durable native restore; current control admission/Stop/outcomes remain |

**Keep and simplify:** `apps/worker/conversation/` (the SDK activity), control's conversation, event and stream code, `apps/gateway/sources/*` (the read handlers become tools), the artifact and document generation code, Temporal itself, and the migrator.

---

## B. Meri closeout plan: `Capiro-Meri-Wiring-Closeout-Plan-20261021.md`

### B1. Tickets

| Ticket | Disposition | Keep as acceptance | Dropped |
|---|---|---|---|
| **MR-01** historical stop-only retirement | **SUPERSEDED** | A Stop sent for a run that began before a deploy works (E10) | The config-SHA / facts-hash pins the ticket repairs no longer exist |
| **MR-02** transient-authority classification in the control pump | **SUPERSEDED** | A transient Core outage retries with bounded backoff inside the run deadline; a definitive refusal fails at once | The authority-availability marker and the per-operation authority layer |
| **MR-06** durable lifecycle outcome readback | **RE-SCOPED** | Outcome readback and recovery after process or request loss | Temporal plus the conversation DB are the durable record; drop the prepared-run registries |
| **MR-07** checkpoint / dormant-original continuity | **SUPERSEDED** | The next turn after a deploy continues the conversation. An SDK upgrade needs the transcript-recap handover first (O103). An incompatible state shows a clear message | Admitting render, reserved successor, mirror append and dormant-original states |
| **MR-08** admission-to-next-turn lifecycle suite | **RE-SCOPED** | Behavioural crossings: duplicate submit, ACK loss, Stop repeated, stream reconnect with cursor, next turn after a failed or cancelled turn, deploy between turns, pause/resume/fork | Crossings that exist only for kickoff claim/lease, allocation and grants, native currentness, terminal usage capture |
| **MR-09** provider terminal accounting and unresolved-liability recovery | **SUPERSEDED** | Each run's cost comes from the SDK result and is recorded once. The tenant cap is enforced. A turn is never failed because accounting is uncertain | Reservations, UNKNOWN liability, quarantine, CountTokens basis |
| MT-01 installed capability set as release truth | **RE-SCOPED** | The tool list a user's run can call is the release truth, served by the tool gateway | "Measured installation", discovery through "the actual pinned proxy" |
| MT-02 selected-read composition (PR197) | **DONE / RE-SCOPED** | Read handlers stay | The authority composition around them |
| MT-03 to MT-09, MT-16 read families | **RE-SCOPED** | Same behaviour and acceptance, implemented as tools on the tool gateway | Extending native-authority or the relays |
| MT-10, MT-11, MT-12 task and schedule actions | **RE-SCOPED** | Approval, durable receipt, no blind redispatch | Approvals go through the SDK permission callback plus Core intents; no per-operation grant minting |
| MM-01, MM-13 "current-authority reads" | **RE-SCOPED** | Memory and attachment reads are scoped to the current actor, client and permissions | Core decides on each tool call; no authority receipt layer |
| MO-10 complete-job cost, context integrity, fair capacity | **RE-SCOPED** | Cost ceilings, context integrity, fair capacity | SDK limits plus one tenant cap, SDK compaction and standard Runtime session/compute limits |
| MO-11 retire obsolete runtime code | **KEEP, now** | Item 0 step 5 is its largest instance. Do it with item 0, not at L4 | — |
| MF-02 identity, exact-run renewal, access-loss isolation | **RE-SCOPED** | A revoked user loses access within 30 s | Ordinary Clerk session refresh plus one Core access check per turn; drop "exact-run renewal" |
| MF-10 public lifecycle consumer | **RE-SCOPED** | Pause, resume and fork controls | Consume item 0's lifecycle DTOs |
| MX-05 exact image and capability measurement | **RE-SCOPED** | Exact-digest image scan and source-to-image proof | "Capability measurement" of the removed registry |
| MX-06 topology, readiness, control scale | **RE-SCOPED** | Readiness/control scale and measured Runtime V1 session reuse, idle stop and restore; no custom warm pool | Pair and issuer topology |
| MX-07 material expiry, renewal, PKI rotation | **RE-SCOPED** | Expiry and rotation for the secrets that remain (Core service secret, Temporal credential, Clerk) | Pair mTLS PKI and issuer tokens |
| MX-09 latency, cost, resource measurement | **RE-SCOPED** | Measure on the new path against the targets in `../STANDING-REQUIREMENTS.md` §6 | "Without duplicating P1/P2" (they are gone) |
| MX-02 receive existing source once | **DONE** | — | — |

Unlisted Meri tickets (MG, MB, MO except MO-10/11, MF except MF-02/10, MT-13 to MT-15, MM except MM-01/13, MR-03/04/05/10, MX-01/03/04/08 and 10 to 14) are unchanged. MR-04 (routine read consent) must be implemented against the tool gateway's run token.

### B2. Scenarios E01–E45

| Scenario | Disposition | Note |
|---|---|---|
| E09 image-only release after a completed turn | KEEP | The conversation continues after a deploy |
| **E10** deploy or rotation while an old run is in flight | **RE-SCOPED** | Stop works and the run closes or resumes cleanly. No pins |
| **E11** SDK, CLI or format incompatibility | **RE-SCOPED** | A clear message and a recap or new-chat choice (O103); no silent session loss |
| **E18** read active-set and revoked operation | **RE-SCOPED** | The tools a user can call are those Core allows for that user and client; a revoked tool refuses |
| **E39** owner/proxy partner replacement | **SUPERSEDED** | There is no pair |
| **E40** budget / terminal usage missing or contradictory | **SUPERSEDED** | Replaced by: record available canonical SDK usage once, preserve unknown accounting explicitly without fabricated usage or failing a completed answer, and enforce the tenant cap through its existing owner |
| **E42** forward rollback and schema compatibility | **RE-SCOPED** | Drop "retained liabilities"; keep forward rollback and receipts |
| All others | KEEP | |

### B3. Sections and rules

| Where | Disposition | Replacement |
|---|---|---|
| "Architecture to preserve" items 3 and 4 (worker → "allocation/claim/lease"; gateway/domain owner → "budget/liability and receipt") | **SUPERSEDED** | Runtime V1 hosts the actual SDK; tools go through the existing gateway to Core |
| Trace table rows "Chat / follow-up" (`run/claim/SDK model proxy`) and "Read/search" (`one-use delegated Core or retained authority … budget settlement/current release`) | **RE-SCOPED** | Chat: control → Runtime V1 conversation session (SDK) → Bedrock → durable native session/events. Read: tool gateway → Core with the run token; Core enforces scope |
| Stage B "Close authority, durable receipt and recovery foundations" (its runtime bullets) | **SUPERSEDED** | The frontend, commands, memory and QA bullets stay |
| Operator gate O3 "PKI material" | **RE-SCOPED** | Only for the secrets that remain |
| Definition of done #3 "Fresh tenant/actor/client/run authority through every hop" | **SUPERSEDED** | Core enforces tenant, actor and client scope on every data call; the harness doesn't re-verify at each hop |
| Definition of done #5 "UNKNOWN with read-only reconciliation" | **RE-SCOPED** | Applies to writes and external effects, not to model spend |
| R-06 "native SDK deferred discovery through the actual pinned trusted proxy" | **RE-SCOPED** | SDK tool discovery directly against Bedrock |
| RG-08 "actual-proxy compatibility" | **RE-SCOPED** | Compatibility against Bedrock through the SDK |
| REL-05 "first runtime/proxy checkpoint" | **RE-SCOPED** | The spike in item 0 step 1 |
| "Performance/cost: 100% attempt usage including failures" | **RE-SCOPED** | Usage comes from the SDK result |

---

## C. `plan/FINAL-PLAN-20261021.md`

| Item | Disposition | Note |
|---|---|---|
| **S1** (P1 table, P2 PR-A) | **SUPERSEDED** | P2 PR-A (#196) is merged and shipped. P1 #200 and C9 #203 were closed unmerged. MX-08 dashboards stay |
| **S2** (P2 PR-B, authority-lite) | **SUPERSEDED** | P2 PR-B #199 was closed unmerged; S2 #213 is merged and shipped. Replaced by one Core access check per turn |
| **S3** warm runner pool | **RE-SCOPED 2026-10-24** | Delete the custom pool mechanism. Retain latency/cost/cleanup acceptance on standard V1 conversation sessions and durable idle restore. |
| **S4** | **SUPERSEDED** | |
| **M1** | **RE-SCOPED** | MR-01, MR-02, MR-09 are superseded; MR-06, MR-08 are re-scoped. E01–E12 and E40 follow B2 |
| **MP** | **RE-SCOPED** | The Claude API path is an SDK provider setting, not a proxy feature (see the MP brief) |
| **M3** | **RE-SCOPED** | Read families become tools on the tool gateway |
| **M4** | **RE-SCOPED** | Approvals via the SDK permission callback plus Core intents |
| **L1** | **RE-SCOPED** | MX-05/06/07/09 follow B1; the release packet no longer includes pair or issuer material |
| Lanes R and D | **RE-SCOPED** | Lane D's `apps/proxy` ownership ends when item 0 deletes it |
| §7 rows ADR P3 / P4 | **SUPERSEDED** | |
| §8 | Decisions 13–17 (23–24 October 2026) | Current V1 migration/full autonomous completion supersede obsolete hosting and approval steps. |

## D. `source-of-truth/STANDING-RULES.md`

"Architecture to preserve" items 3 and 4, the Chat and Read trace rows, owner-map rows for P1 and P2 and for action-session authority, and Definition of done #3 and #5 are rewritten there in the same way as B3.

## E. App plan (Portfolio, Workspace, Settings, Mail)

No ticket is superseded. Where it says "canonical Meri context contract", read context (tenant, client, entity ids) and not an authority token. "Do not implement competing authority DTOs" now means: don't build authority machinery for Meri entry points.


## PROCESS 6.1/6.2 (historical role names superseded above)

### 6.1 Brief

```
FROM: Fable | TO: dot (relay to agent N vX, verbatim) | TYPE: brief | RE: <phase> (<wave>, lane <L>)
# <phase> brief
Repository / branch / base SHA. How we work: you build, dot's reviewers review, <shipper> merges and ships.
Rules: draft PRs only; no merges, no AWS; list tests run and not run; mutation-check new tests.
## Sources of truth: the master plans, STANDING-RULES.md, the tickets below verbatim.
## Sequencing (other open PRs, the rebase order, file exceptions and freezes)
## Tickets (verbatim from the master plan)
## Acceptance scenarios (master §5 rows, verbatim)
## Definition of done (tickets closed, E-scenarios with named tests, mutants killed, gates the shipper runs)
```

### 6.2 Change list (verdict)

```
FROM: <reviewer> | TO: agent N | TYPE: verdict | RE: PR #n at <sha>: CHANGES
Gates table (base vs head). Numbered items, each with: file:line, what is wrong, the exact test that must fail without the fix, and the mutant to kill.
Rulings on any decisions the agent asked for. "Merge is not requested."
```

## Phase B implementation evidence — 2026-10-25

The implementation follows the allocation at the top of this brief. Four production files changed, plus five affected existing specs; this full brief is the tenth committed path. The public DELETE still calls deleteReviewedAttachment; the proxy binds that unclassified method to the actual owner. Generic deleteAttachment remains externally gated. The mounted HTTP regression now includes the real EngagementRuntimeGuard and governed service proxy with externalActions=disabled and retains the existing trusted-context, malformed command, parent-ownership, receipt and nonclient-fallback cases.

Production deletion proof: removed exactly three controller decorators (createAttachmentUploadUrl, confirmAttachment, reviewed public deleteAttachment), those same three route-policy entries, and only two factory entries (createAttachmentUploadUrl, confirmAttachment). Scoped source comparisons prove every other byte in those production files is unchanged. Generic deletion, cleanup, buffer generation, extraction, copy and provider/send gates remain. No replacement flag, permission service, compatibility layer, dead stub, secret, IAM/resource or schema is added or retired by this classification correction. The changed tests remove the two obsolete service-map expectations; their two generated denial cases are replaced by positive owner/result/refusal cases. Manifest coverage remains intact, with exactly three handlers added to its existing local-safe attachment classification. Historical documents remain historical; no active wrong classification remains for the allocated operations.

The finite registry appends exactly two core/POST groups with the six allocated anchored paths. All 51 old groups, their order, the original corePostAddition and note are unchanged, so existing synthesized rule identities/priorities remain unchanged. Exact source synthesis grows from 56 to 58 rules. The retained actual-template count of 61 in the read-only brief is a different inventory, not this source synthesis count. The edge source builder and first-chat-core-routes.json are unchanged. The first-chat Core construct spec consumes the separate unchanged registry and needed no edit.

Retained tools: Windows Node24.22.1, Jest29.7.0, TypeScript5.9.3, aws-cdk-lib2.271.0, constructs10.8.1, ts-node10.9.2. Read-only dependency donors: C:/dev/wave2-d-core-high-deps (root and apps/api node_modules) and C:/dev/c1-entry/infra/cdk/node_modules. Only owned junctions were created in this worktree. No install, shared service or database change occurred. The initial full checkout did not remain materialized; the allocated branch was successfully materialized using a sparse checkout of apps/api, infra/cdk, packages and scripts. Frozen donors remain unchanged.

Actual checks (25 October, approximately 17:14–17:24 UTC):

- API invocation, from owned apps/api: node --experimental-vm-modules node_modules/jest/bin/jest.js --runInBand --runTestsByPath <selected paths below> --forceExit.
- Before removing production classifications, unchanged lower owners passed 160 tests across src/engagement/attachments/client-file-delete.spec.ts, client-file-delete.storage.spec.ts, prospect-attachment-access.spec.ts, prospect-independent-review.spec.ts and src/engagement/attachment-scanner.service.spec.ts. These are synthetic unit/HTTP transport/transaction fixtures, not live AWS or PostgreSQL qualification. They exercise current tenant/actor/client/wall/parent access, changed object bytes, scan-time revocation, fail-closed scanner status, exact receipts, retries and deletion custody. The expected NullAttachmentScanner fail-closed diagnostic remains visible; it is not proof of a configured real scanner.
- New/amended runtime regressions against unchanged base production: 9 failed / 52 passed across the three runtime specs, exit1, as expected for the old classifications.
- Corrected runtime/route/guard and mounted deletion: 72 passed across src/engagement/runtime/engagement-runtime.guard.spec.ts, engagement-service-runtime.boundary.spec.ts, engagement-runtime-route-coverage.spec.ts and src/engagement/attachments/client-file-delete.http.spec.ts, exit0. The final mounted-deletion check separately passed13; reruns are not additional unique cases.
- From owned infra/cdk: node scripts/run-construct-tests.cjs --run preview-first-chat-edge. Six tests passed, exit0. All six admissions target Core only on the preview host, reject wrong mutation methods and neighboring/suffixed/invalid-ID paths, and retain the existing finite-route/default/DNS/service checks. Existing GET/HEAD routes are preserved. The same new admission test with the exact base registry fails on the missing upload-url admission, exit1.
- Four behavioral mutants killed, each exit1 by an assertion: restore confirmAttachment factory gate (owner operation refused503); restore public-delete decorator (mounted DELETE returns503 instead of200); omit confirm admission (required Core destination missing); broaden upload-url expression (unallocated neighbor admitted). Every mutation was restored byte-for-byte in finally. Selected-test skips during mutation runs are intentional and not passing coverage.
- Scoped TypeScript5.9.3: seven changed API files, zero syntactic/semantic/options diagnostics using the repository tsconfig and checking only those files. Imported-file diagnostics and full package build are excluded. CDK affected spec and imports passed: node node_modules/typescript/bin/tsc --noEmit --target es2022 --module commonjs --esModuleInterop --resolveJsonModule --skipLibCheck --strict test/preview-first-chat-edge.spec.ts.
- git diff --check and exact production source comparison passed. The latter verifies the six additions, old-group preservation, exact eight removed classifications and unchanged service/scanner/runtime-policy/types/Core-owner/route-builder sources.

Unique passing affected cases: 232 API plus6 CDK (238 total); reruns, red checks and mutants are not added. Existing ts-jest isolatedModules deprecation and the repository test-script forceExit notice remain reported. ESLint is unavailable in the retained API donor (module resolution fails); no installation or lint success is claimed. No unrelated inherited failure was encountered in the selected passing gates; intentional base-regression and mutation failures are retained separately.

NOT RUN: full package build/typecheck/lint, broad suites, real PostgreSQL transactions, image/ARM64 build or scan, AWS changes, public/browser/model/provider effects, complete upload lifecycle or deployment acceptance. Release owns real ordinary Assets/scanner readiness and rollout; Root owns independent exact-head review and sequencing; Acceptance owns any nominated later retest. This patch does not qualify those gates or explain the uncorrelated memory GET/document/routine/action observations.

Detailed local commands/logs and one-off evidence scripts are retained in C:/Users/Administrator/Documents/Codex/2026-10-25/wave2-visible-file-workflows-ui/outputs/phase-b-* and run-phase-b-*.cjs. No live data/credentials were used. Tests closed their owned Nest apps/SDK clients and the construct fixture cleaned its own temporary synthesis directories. Dependency junctions, sparse checkout and reusable caches remain retained; no shared resource was deleted. Exact final commit/tree and draft URL are supplied in the PR and Root handoff after commit.