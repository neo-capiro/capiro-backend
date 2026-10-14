# Canonical successor runtime and ordinary API handoff

The reviewed runtime source checkpoint is `3f747849a1d037806faa819f7c174d8b29675947`, tree `99cfcbde6c8016747d45740eb7352f456d501125`, parent PR17 `dd02f3ba0b4ab77e3725e83e4b9af27aecdc8eca` / tree `03d6508d021825621f921aa37a5da6d235bb63e0`. The separate draft branch is `codex/backend-runtime-candidate-20261014`, based only on PR17's branch. Its publication adds evidence/docs above that implementation checkpoint. The publication PR supplies the final head/tree; build that exact clean checkout. PR17, PR16 and all original candidate heads remain preserved. No main merge or deployment occurred.

**The runtime source candidate corrects two demonstrated faults:** all four existing services retain Prisma5.22's migration CLI after production installation, and Core no longer invokes a retired no-op workflow seed after deploy. The nine-file delta changes no app/src, library, schema or migration SQL tree. Existing Objective, saved newsletter staging, Files, Calendar, authority, shared tasks and background-owner controls remain in their canonical owners.

## Qualification and actual limits

| Evidence | Accepted result | Practical limit |
| --- | --- | --- |
| PR17 ordinary configured library/Nest builds and current stock Prisma source generation | 10/10 builds; 4/4 generations, including UserPortfolioLayout; fresh Core/Workspace builds and unchanged Strategy/Intel declarations | Cached ordinary toolchain; no container or live schema acceptance |
| Exact pnpm9.12 frozen production dependency link probe | Baseline drops direct Prisma CLI; corrected runtime importer classification retains it | Seven-package synthetic projection, lifecycle disabled only for link testing; no production image/generation inference |
| Image-pinned Node/version/syntax/import probes | 14/14; Node22.23.3 for Core/Workspace,20.16.0 for Strategy/Intel | Exact pinned binaries and unpruned frozen/cache dependencies; no Bookworm/ARM64/pruned-image acceptance |
| Full existing four AppModule constructor/DI graphs | 4/4; Core's original AppModule.spec body unchanged; strict Prisma mock, denied network/process/credential IO, zero blocked IO attempts | No .init(), .listen(), actual DB/auth/HTTP/worker start |
| Core guard and inert dispatcher verification | Author and independent64/64 guard cases,10/10 dispatch cases,3/3 shell syntax | No migration or live dispatcher execution; existing manual recovery arms and legacy migrate refusal64 preserved |
| Proposals contract fixtures | 55/55 source-derived expectations | Establishes admitted malformed opaque ops and valid declared-emitter compatibility, not the actual live failing field |
| First-chat bootstrap composition | Independent exact-source join accepted across Core PR17, frontend PR39 and Meri PR82 | Real native session, Core record and approved Meri runtime inputs still required |

The canonical source review is [RUNTIME-SOURCE-INDEPENDENT-ACCEPTANCE.md](../runtime-source-qualification-20261014/independent/RUNTIME-SOURCE-INDEPENDENT-ACCEPTANCE.md). New results and closed hashes are in [FINAL-RESULT.json](../runtime-source-qualification-20261014/FINAL-RESULT.json) and [PAYLOAD-MANIFEST.json](../runtime-source-qualification-20261014/PAYLOAD-MANIFEST.json). PR17's prior results, manifest, runners and failed evidence are preserved unchanged; its historical HANDOFF remains accessible at the exact dd02 commit.

## Existing services and source-pinned image build

Use the original Docker recipes with repository-root context, frozen lockfile, pnpm9.12.0, unchanged native+linux-arm64-openssl-3.0.x Prisma targets and existing non-root runtime stages. No migrations/seeds occur during these Docker builds.

| Service | Recipe | Node tag | Port and native prefix | Preview dependency |
| --- | --- | --- | --- | --- |
| Core | apps/api/Dockerfile | public.ecr.aws/docker/library/node:22.23.3-bookworm-slim | 4000,/api | Existing account/client/objectives/layout/authority/conversation owners |
| Strategy | apps/api-strategy/Dockerfile | node:20.16.0-bookworm-slim | 4400,/strategy-api | Existing Planner/strategies/proposals operations |
| Workspace | apps/workspace/Dockerfile | node:22.23.3-bookworm-slim | 4200,/workspace-api | PR39 saved revision/Files/newsletter receiving when used |
| Intel | apps/intel-api/Dockerfile | public.ecr.aws/docker/library/node:20.16.0-bookworm-slim | 4300,/intel-api | Only selected Intel/capture features; no new first-chat prerequisite |
| Dedicated Meri | Existing Meri PR82 owner's recipe | Separate immutable Meri candidate | Existing qualified pathless HTTPS control origin | First real chat requires its actual approved grant/task/resource/native inputs |

Docker28.4.0 is available locally, but its vfs backing filesystem has **0 bytes free and 0 bytes reclaimable**; required base tags are absent. No build, pull, prune, engine installation or reconfiguration was attempted. A capable authorized builder with normal registry/Debian/Prisma access and persistent layer/export space is required. Match the platform to the **actual existing task architecture**. ARM64 targets in Prisma source do not prove the deployed task architecture or ARM execution.

[CONTAINER-BUILD-HANDOFF.md](../runtime-source-qualification-20261014/container/CONTAINER-BUILD-HANDOFF.md) records exact recipes, package closure, commands and raw capability facts. Its ARM64 commands are conditional examples for an owner-confirmed ARM64 task and an already qualified OCI/provenance exporter; they do not authorize installing/reconfiguring a builder. Source-head/tree checks must use the final publication, never dd02 alone or a mixed working copy. Record resolved base digests, final artifact/image digests, platform and full logs. Base tags and apt repositories remain existing mutable inputs; no exact final image digest is available yet. No image push, AWS task revision, network/security or credentials operation ran here.

Default runtime action remains serve. Full startup can connect databases and start existing background hooks; constructor-only success does not authorize admitting duplicate workers. Core migration and all existing guard logic remain distinct from serving.

## Migration allocation, ledger and rollback

The source catalog has **12 Core and13 Workspace SQL paths added versus verified old main**, with ordered paths, blobs, SHA256, source operations and data/permission actions: [migration-source-catalog.json](../runtime-source-qualification-20261014/cleanup/migration-source-catalog.json). Strategy/Intel migration trees match old main. Only Core layout/schema is added since backend-import c76. This nine-file patch changes none of those SQL bytes/names or schemas.

Core's existing timestamp policy (year offset2, seven-day tolerance) fails **five** allocations against old main's source frontier20281008040000_federal_evidence_passage_search:

- 20261007010000_newsletter_outreach_format
- 20261007020000_newsletter_review_email_delivery
- 20261007030000_newsletter_invitation_email_delivery
- 20261007040000_newsletter_account_invitations
- 20261014050000_user_portfolio_layout

The other seven Core additions pass source date/order checks. The c76 append fixture grandfathers eleven paths and reports only layout; it does not qualify the old-main migration plan. See [core12-old-main-timestamp-policy.receipt.json](../runtime-source-qualification-20261014/cleanup/core12-old-main-timestamp-policy.receipt.json).


The sole shipping owner now has a [history-aware resolution packet](../runtime-source-qualification-20261014/migration-readiness/HISTORY-RESOLUTION.md) and explicit read-only [ledger discovery](../runtime-source-qualification-20261014/migration-readiness/discover-ledger.sql), [Core12](../runtime-source-qualification-20261014/migration-readiness/core12-history.sql) and [Workspace13](../runtime-source-qualification-20261014/migration-readiness/workspace13-history.sql) queries. They are authored only and require the owner's verified actual ledger database/schema and existing permissions; no DB/Prisma call ran here. They retain every attempt, global unfinished/duplicate flags, exact/compatible checksums and alternate-name candidates without raw logs. No matching row means UNKNOWN, and a rolled-back marker does not prove SQL effects were undone. Four failing newsletter names preexist backend-import c76; layout was added in PR10. PR17/18 changed no migration names or SQL. Preserve any historical applied name/bytes; only complete never-applied/effects evidence can justify a separately reviewed source allocation correction. The five provisional2028 names in the packet are not reserved or implemented. Existing failed receipts and first-chat source proof remain unchanged.

**Actual applied/pending state and checksums are UNKNOWN for every one of these12 Core additions and the13 Workspace additions.** Hold renaming until the release owner establishes whether each path was ever applied. Preserve every applied name/checksum. The source-only layout name20281014050000 passes allocation policy, but no rename was implemented; an integrity check against dd02 correctly refuses that unapproved rename. No ledger resolve/reset, reverse/drop or guard exception is proposed.

Existing four app package scripts are `prisma:migrate:deploy = prisma migrate deploy`, locked CLI5.22.0, executed in each owning app's cwd. These instructions are for the sole runtime/database owner after the existing release gates. No migration/DB/seed/SQL/introspection/replay command ran here.

Core's corrected migrate wrapper execs the same direct CLI argv and adds no seed. **Its migration SQL still includes backfill INSERT and GRANT/REVOKE actions**, so the whole rollout is not pure DDL. Workspace's existing migrate wrapper also upserts20 global templates (including updates); Strategy's also seeds empty reference entries; Intel deploys only. If the release owner intends deploy-only, use each existing app's deploy script rather than silently admitting Workspace/Strategy seed effects. No additional runner or service is needed. Native PostgreSQL/schema/RLS/concurrency and actual worker-ownership qualification remain open.

Before any owner-run release, retain the current source/image digest, task revision and ledger evidence. This nine-file delta has no schema changes, but the full successor migration stack does. Ordered-owner deferred triggers require Primary==rank1 with contiguous ownership; old writers need compatibility qualification. Expanded prospect/newsletter/notification values can fail old parsers. Saved-version, prospect-origin and brief-copy immutability triggers plus receipts must survive a code rollback. Reverting an image does not prove the old code is compatible with migrated data. No destructive downgrade or migration-ledger repair is authorized by this source handoff.

## Minimum ordinary API findings

The functional-mode instruction supersedes the historical three-GET preview scope. Use the existing frontend service and ordinary Clerk login/tenant permissions unchanged. Separate PR2/PR3 API/native-fixture/cross-VPC work remains preserved; it is not made a prerequisite here. No new reader role, preview auth layer, membership, identity rebinding or privilege expansion is required by this source finding.

- Core `GET /api/clients/:clientId/objectives` is mounted in the candidate and absent in refreshed old main4be13. Layout is the existing successor capability; source generation is accepted, actual migration/schema coverage is not. A404 requires exact serving release/path/context, not another API.
- Proposals now have a concrete runtime observation from shipping: `GET https://os.capiro.ai/strategy-api/agents/change-sets` returns successful JSON that fails frontend `strategyChangeSet[]` parsing, producing generic502. This supersedes earlier reachability speculation. The registered gateway handles that operation; do not broaden the separate generic Portfolio proxy allowlist.
- Current canonical Strategy list returns raw tenant-scoped findMany rows. Source schemas, six declared PlanEdit cases and three AST-selected Watcher retime emissions fit the frontend contract. However CreateChangeSetDto admits opaque `unknown[]` ops (array/max60 only), and create/list persist/return JSON unchanged. Seven malformed-op cases prove a real admission/read-contract gap. **The actual live failing field remains unknown**; no claim attributes this incident to ops. Keep the parser intact and use the frontend owner's bounded value-free diagnostic issue path before a focused source repair.
- Native401/403/404/500 and existing agent/planner/tenant guards remain meaningful. Do not alter existing flags/auth/claims to mask a contract error. No live API test or business write was run here. A real write still needs the established exact identity/tenant and owned test flow, without other-tenant access, overwrites/deletes, provider sends or paid calls.

[PROPOSALS-CONTRACT-FINDINGS.md](../runtime-source-qualification-20261014/proposals/PROPOSALS-CONTRACT-FINDINGS.md) distinguishes source-proved admitted cases from envelope hypotheses and preserves external-source fingerprints and raw55/55 results. Private frontend source bodies were not republished.

## First-client-only chat and canonical conversation join

Current exact inputs: frontend PR39 `348c98dfe1962fac962157eb785732281a282d06`; Meri PR82 `5a87ffd7f0a5441919c1b4a869295824f1a32d08`. Read Meri's [authority/resource input contract](https://github.com/neo-capiro/meri-greenfield/blob/5a87ffd7f0a5441919c1b4a869295824f1a32d08/docs/coordination/reports/CODEX-CURRENT-CONVERSATION-AUTHORITY-INPUTS-20261014.md), plus the fingerprinted reconciliation/bootstrap notes under ../runtime-source-qualification-20261014/first-chat/. No later continuation/resume/fork/approval owner is required for this first-chat path.

The existing Core owner is ClioConversation in MeriController/MeriService. `POST /api/clio/conversations` accepts minimal `{clientId}` (optional title), derives exact tenant/native user from trusted context, checks client visibility and creates only the active/nonarchived canonical row. It does not generate content or call a model/provider/Temporal. Read an existing suitable row, or use this existing create flow after establishing that exact owned test flow. No row was created by this source task. Do not remove this legacy-named owner while its existing consumers remain.

`POST /api/clio/application-authority/identity {}` verifies actual sid/sub/JWT expiry, queried native user.id with clerkUserId==sub, current active tenant/membership and existing impersonation evidence. `/context {identitySha256,conversationId,clientId}` requires the exact active/nonarchived owned conversation and same client, current client wall/grants/prospect/research ACL, and rereads authority. Ordinary conversation GET or /me200 alone does not establish that proof. Research Portfolio rows with null client do not become this client-bound context by attaching a client. Identity hash correlation and context receipts issue no Meri run/grant/budget/allocation authority.

The first-client-only request selects the **configured preapproved Meri RunBinding**. Prepared config binds runtime and identity command-context tuple, scopes/policy, grants and allocation/budget/deadline. startControl supplies candidate.identityContext to ActionSessionOwner. The context adapter checks native tenant/actor, optional hints and current-owner reads, calls Core using the configured conversationId and selected client, and validates the returned exact native principal/revision/hash/conversation/client/expiry. When no Meri run row exists yet, only the preapproved tuple is used; an arbitrary UUID is never accepted as the Core record. The session owner and submit store/dispatcher retain that same tuple. Request UUID identifies the immutable request; session IDs/revisions are opaque-session bookkeeping. The separately generated action_session bearer is the credential; none generates conversation/run authority. Exact-source independent review and Meri's existing synthetic first-chat controls establish this source join; no genuine native run was executed here.

The actual live tuple is still a runtime input: current trusted native session/user/tenant, existing active owned Core conversation/client, approved Meri binding/policy/scopes/allocation with original positive budget/deadline, distinct existing identity/task/control/proxy capability references/grants, and dedicated DB/Temporal/image/private transport/task ARN/fence/native qualification facts. Core identity/context do not fabricate them. Meri/shipping's canonical owners supply these bindings without a new issuer/store/schema or IAM/security change.

Frontend CORE_API_BASE_URL includes /api; Meri's Core authority client accepts a **pathless HTTPS origin** and appends fixed /api/clio/application-authority endpoints. Frontend MERI_API_BASE_URL must be pathless HTTPS and the existing `MERI_CONVERSATION_WORKFLOW_ENABLED=true` explicitly opts into its first-chat connection after runtime qualification. No flag/origin/auth configuration was activated here. Preserve original expiry: Core proof expiry is bounded by JWT/session/abandon/impersonation, and repeated authority reads use the minimum rather than extending a lease. Meri preserves its own original grants/budget/task bounds and refuses changed current authority before allocation/dispatch.

Meri owner coordination is recorded at [PR82 comment6167937332](https://github.com/neo-capiro/meri-greenfield/pull/82#issuecomment-6167937332); no response was present in the refreshed discussion when this handoff was sealed. Source join can be reviewed without requesting live secrets or creating records.

## Retained source dependencies and overlap

| Owner/candidate | Exact dependency and boundary |
| --- | --- |
| New runtime candidate | Nine reviewed paths on exact PR17 only:4 manifests,lock,retired seed deletion,2 Core entrypoint sources and guard envelope fingerprint maintenance. Two raw hashes change; guard enforcement/three-source protocol/manual recovery/legacy refusal stay intact. |
| PR17 | Exact dd02 preserved, source generation/build/capture/startup evidence retained. This candidate does not modify its branch or product src trees. |
| PR16 and published PR1-16 | Exact PR16 d15bba2cd75a8d36743e5d7a10eda346e4e48e2a remains ancestor. Canonical Objective destination revision/current same-client authorization, exact WsDocVersion staging/OutreachV3 expectedStateVersion+receipt, authoritative effective evidence/date-kind/provenance/coverage remain in existing owners. No incompatible cherry-picks. |
| Original capirov2 candidate ledger | [Reconciled ledger](https://github.com/neo-capiro/capirov2/blob/797e3a59158cff56b017ab7d01ee445bf624fced/docs/backend-frontend-handoff-20261012/RECONCILED-LEDGER.md) and PR2400 contracts retained as historical source inputs. Newer reviewed successor contracts govern this exact stack; abandoned commitment semantics stay excluded. |
| Frontend | PR36 7e170defb9442aa3ce0fd1d5b14060af831ce8d0 is the original ordinary gateway input; PR39 integrates saved resources/first-chat, preserves PR35/37/38. No frontend source/refs or serving configuration changed here. Diagnostic owner supplies actual proposals issue paths. |
| Meri | Exact PR82 source binding contract and earlier PR81 remain separate; backend authority is retained, later lifecycle owners do not block first chat. No Meri source/ref/private-body archival here. |
| Legacy Web/Onboard/e2e/infra | Existing Onboard Dockerfile builds/copies apps/onboard-web SPA and main serves it. Existing artifact-only Docker path needs an actual approved artifact. e2e/operator/mixed release/CDK dependencies still reference legacy Web/Marketing ownership. Keep currently used source; use selected backend Docker contexts instead of whole-workspace generic Turbo closure. No inferred permission to delete consumers. |
| Additional retired workflow utility | Pre-existing scripts/seed-demo-client.ts still references removed workflowTemplate. It is outside this scoped no-op runtime-seed removal and remains a source backlog; this handoff does not claim all legacy workflow code is cleaned. |
| Protected Engagement | Published service blob stays6eb8259f7eb77f64c6ab41d403480ac1ea3f1e82. Protected unpublished reporting head is neither read/hydrated/changed nor declared lost. Existing background ownership must be verified before admitting another Core runtime. |

Refreshed capirov2 main remains4be13b0b1ed0f2f3fa014040eedbb2fc2c27dace; backend-import remainsc76f5fc0df6688743afeec274211afd2e67fe8f1. Repo-root AGENTS.md is absent in this successor and current original workspace; read failures are retained rather than inventing instructions.

## Failed evidence, reproduction and ownership transfer

The new payload includes failed initial ENOSPC guard/metadata probes, initial inert mock mismatch, initial SQL-comment metadata extraction, and Core's first DI probe which falsely classified @aws package paths as credential directories. The corrected test guard matches literal .aws directory segments; production code was unaffected. An orchestration SyntaxError occurred before the other three apps ran, then corrected probes passed. Passed/failed raw artifacts and external-input runners are kept, not converted into native acceptance. PR17's earlier killed/partial builds, namespace/output preservation failures and explicitly zero-byte raw artifacts remain preserved at their original source pins.

No new healthy-source build/test repetition was required after independent nine-file acceptance. Reproduction binds exact published source, pinned Node/pnpm, documented cached dependencies and strict mocked ports. Source/DI/WASM/compile evidence does not replace native Postgres/RLS/concurrency, production image, full init, worker ownership or real account-flow acceptance. The sole AWS/release owner receives the exact publication, recipe/log/digest requirements, migration catalog/holds and runtime-native inputs before any serving action.

Automatic approval review previously rejected cross-repository archival of a private frontend source test bundle. Its rejection, safe fingerprints/results and external-input runners stay preserved in PR17. No encoding/upload/repository retry or bypass occurred. This is an evidence-archival limitation, not permission to loosen source provenance.

No real provider/model/upload/message/customer-data call, credential/permission/AWS/security/network mutation, DB/migration execution, main merge or deployment occurred. The runnable-source progress above does not claim the successor is live or fully runtime qualified.
