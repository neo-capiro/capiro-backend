# Private backend successor: executable OpenAI/Codex instructions

## Outcome and authority

Prepare a dedicated successor of **private `neo-capiro/capiro-backend`** with one evidence-verified working implementation per retained feature. Complete the selective source cleanup in OpenAI/Codex sessions, with root as the sole receiving/integration writer. Publish independently reviewed draft PRs; do not merge to a default branch or deploy. This document is the handoff for a fresh worker and the continuation plan for our current sessions. Its publication is a checkpoint, not completion of backend cleanup.

Neo explicitly authorized autonomous source preparation, additional Codex sessions, the private backend successor and removal of superseded legacy runtime after tracing dependencies. Engineering and review stay in OpenAI/Codex; do not outsource to Claude/Fable or other external coding agents. This restriction concerns engineering coordination. It does **not** authorize rewriting existing product provider/model integrations, replacing needed Anthropic integrations, changing models or converting the backend to Python. Preserve TypeScript/NestJS and existing necessary Python pipelines.

The current import is broad and still contains old frontend, Meri/Clio and orchestration paths. It is not a clean backend and must not be described as production verified. Select working owners by bootstrap, routes, callers, data/auth contracts and build/image evidence. Folder names, age, duplicate-looking text and a newer rewrite are not selection evidence.

The frontend preview uses existing frontend service, current Core/backend origins and Clerk configuration, with normal login and tenant permissions unchanged. No preview-specific tenant protection, extra authorization layer, reader-role prerequisite or replacement API is authorized. The optional PR2/PR3 API/native/cross-VPC work is preserved; it does not gate the basic preview. Backend cleanup must not block frozen frontend PR25 shipping.

Source-only restrictions remain: no database or migration execution, AWS/cloud operations, provider calls or sends, paid models, real uploads/messages, customer-data mutations, credential/permission/security/network changes, destructive history or force pushes. A live test write requires the separate shipping owner to establish exact identity, tenant and an owned disposable flow; this source plan supplies no permission to create memberships, rebind identity, expand privileges, touch another tenant or overwrite/delete business records. Schema/migration **source** may be written and reviewed, never run here. Native Prisma downloads were blocked at HTTPS CONNECT to `binaries.prisma.sh`; do not bypass it or disable checksums. Type, mocked, synthetic or WASM checks are not native PostgreSQL/RLS acceptance.

Neo excluded Quick log Commitment/We owe/They owe/counterparty UI. Do not revive abandoned full commitment semantics or leave dead code for them. Retain shared task/action-item functionality still consumed by normal Capiro and rebuilt Meri. Trace dependencies before cleanup.

## Exact starting point and preserved branches

Read [PIN-MATRIX.json](PIN-MATRIX.json) first. These are immutable observations, not claims that branch names cannot move. Refresh the actual GitHub heads and compare them to the pins before taking ownership. Never overwrite a changed branch or silently swap in a newer candidate.

| Repository / role | Preserved branch or PR | Head | Tree / relation |
| --- | --- | --- | --- |
| Private backend default; broad import | `backend-import` | `c76f5fc0df6688743afeec274211afd2e67fe8f1` | `3bae0d1a303662260673ecb0c5ac0a8bfe551829`; retain, do not start cleanup from stale default |
| Private reviewed receiving | PR1, `codex/reviewed-backend-receiving-20261013` | `6efe59f24b4a711b7991bae4b2a255c667cbbf00` | `5e1812b853811f793b30fe7de0e956f65c28f056`; based on broad import |
| Optional API | PR2, `codex/preview-readonly-api-20261013` | `111f269d749cae0249c2141779bd6d7deb93f45c` | `719c8292fc0c9cf4e8242b8d58efb2d004ad0a1f`; separate branch from import |
| Optional qualification | PR3, `codex/preview-readonly-native-20261013` | `3509438f7f0c39c6da4db8a94b74c816211491b4` | `d4d01388e9edc69f40ab2e53948a0e9f75051903`; stacked on PR2 |
| **Current reviewed integration** | PR4, `codex/backend-cleanup-receiving-20261014` | **`a65ae3c8a9f1f0cf96d4f7d2ae30aad2fff172ff`** | **`b5ff0511a9e35760a4c92f74270e07beba1bf319`**; base PR1 |
| Product source underlying PR4 | source merge checkpoint | `b36cee83008830a59e304afca4aa6ae1b1c5e0d3` | `e0592f4137c67740c0b519f9a88f5d15840b0b8f`; subsequent PR4 changes are documentation |
| Four-family audit parent of this plan | `codex/api-four-family-acceptance-audit-20261014` | `4e2c4be826205dde8101e854ba079d46a6dd10ca` | `063214b484bf9955581d3d595bf60c6b4ae6e87c`; sole parent `a65…`, exactly four docs |
| Production capirov2; untouched | `main` | `4be13b0b1ed0f2f3fa014040eedbb2fc2c27dace` | Refreshed read-only; not the private receiving source |
| Frozen frontend shipping | PR25, `integration/capiro-functional-preview-20261014` | `257cf5b5db673b31c98264f9da33759c68066ba4` | Shipping source `5ca42049325881782bc9d2ac557450d642eccee8`; leave both unchanged |
| Frontend follow-up | PR26, `repair/capiro-existing-api-feedback-20261014` | `348bf98481268a5f06e26a924f0985b242265cbb` | Separate error-feedback/API map; does not replace frozen PR25 |
| Rebuilt Meri boundary | meri-greenfield PR71 | `7e822a7cfe5150b2c8d8fc1d5984fd2348ae4866` | Base `742e57287db5294f84724b6c1878c113bff3bba8`; not local mutable worktree HEAD |

The docs-only plan branch is `codex/backend-successor-plan-20261014`, based on `4e2…` and proposed against PR4's branch. Its final immutable head/tree belong in the PR publication receipt; this file cannot truthfully include its own containing commit. The functional successor branch is separately reserved as `codex/backend-canonical-boundary-20261014`, currently `a65…`. Do not append functional changes to the docs-only PR. After publication root may fast-forward the separate successor to the reviewed plan and branch finite implementation slices from that checkpoint.

Watchlist and memo cleanup history is deliberately composed, not mixed wholesale:

- PR2490 `c625fcc4b5fb7c4270e701fe090b9f408d9108fe` is already an ancestor of PR1. Its direct parent is PR2485 `1ecd4b71b3243a38585a11cba6535bd7384d668b`. Do not cherry-pick it again.
- PR2491 `04137babe95e1a3f9627703239d1b5c4992f0b2b`, parent PR2490, was received by ordinary merge `9546d45d2fdf11995e57fee2ebd824d4eaabf3a1` with parents PR1 and PR2491. All 30 donor paths are preserved.
- PR2492 `c049f703d778b55684fd042a731069e73777d30c`, parent PR2491, was received at `b36…`. All 12 donor paths match exact modes/blobs. Both complete memo caller class bodies remain unchanged.
- Prior reviewed packet `b417a2610f5224c2a3e85c6a1ebba1a8102233c1`, tree `58abbf7a657b9ed81611b6d7635c451a82255064`, stays preserved. Current PR4 adds corrected finite seals, not a replacement history.

Keep all original candidates in their repositories and all new candidates. The original reconciled ledger and split-preparation inventory preserve hundreds of published heads and the original Objective/sender/facility/Planner/Quicklog/wording/ordered-owner/Files-Workspace candidates. Use exact dependency matrices before any adoption; never combine incompatible source by copying folders.

**Protected Engagement custody:** unpublished owner head `e01e3b72aa0e26f4d2a9ad65533da1d561920aca` remains separately preserved pending its owner's publication and independent review. It is not automatically the production implementation. Do not inspect, hydrate, edit, reset or force-push its branch/body, and do not claim its work lost merely because this clone lacks the object. Preserve the pointer and ask its owner for a bounded qualified handoff if needed. This plan does not receive it.

## Start safely without touching old dirty work

Run these read-only observations in each old Claude/Codex checkout that **you own or are authorized to inspect**. Do not inspect another owner's protected Engagement worktree. Do not print `.env`, credentials, customer data, process environments or auth tokens. Choose a new local evidence directory with headroom, access limited to the current workspace. Local snapshots are custody records, not automatic GitHub uploads.

```bash
# Run in a fresh Bash shell from the authorized OLD checkout.
# Inspect capacity before writes; stop if it cannot hold the owned diffs/listings.
set -euo pipefail
df -h /workspace /tmp
task_custody_dir=$(mktemp -d /workspace/capiro-custody-XXXXXXXX)
git rev-parse --show-toplevel > "$task_custody_dir/root.txt"
git rev-parse HEAD > "$task_custody_dir/head.txt"
git rev-parse HEAD^{tree} > "$task_custody_dir/tree.txt"
git branch --show-current > "$task_custody_dir/branch.txt"
git status --porcelain=v1 -z > "$task_custody_dir/status.nul"
git diff --binary --no-ext-diff > "$task_custody_dir/unstaged.patch"
git diff --cached --binary --no-ext-diff > "$task_custody_dir/staged.patch"
git ls-files --others --exclude-standard -z > "$task_custody_dir/untracked.nul"
git ls-files --others --ignored --exclude-standard -z > "$task_custody_dir/ignored.nul"
git show-ref > "$task_custody_dir/refs.txt"
# Mark completion only after every command succeeds. Keep incomplete snapshots.
test -s "$task_custody_dir/head.txt"
test -s "$task_custody_dir/tree.txt"
test -s "$task_custody_dir/refs.txt"
touch "$task_custody_dir/COMPLETE"
```

Leave the old checkout in place, including untracked/ignored files and unpublished branches. The lists and diffs do **not** back up untracked contents, ignored files, LFS objects, dependencies or dirty submodules. Preserve them in place; if moving is necessary, separately copy only authorized owned source/evidence with symlink/mode metadata and verify byte hashes before changing anything. Do not copy secrets or unknown data to the new repo. A Git bundle is optional only with measured headroom and explicit owned-ref scope; it does not include dirty/untracked content. Keep any shared clone's alternate object stores available. Do not use `stash`, `reset --hard`, `clean`, history filtering, directory-wide deletion, force push or blanket cache removal.

The current environment is nearly full. A full checkout before sparse initialization previously hit ENOSPC. The failure and owned partial-checkout recovery are retained. Existing node_modules/generated clients and evidence archives may be borrowed by other worktrees. Use a fresh small sparse checkout, initialize sparse **before** switching, and claim a unique branch. The following starts from immutable reviewed PR4 without checking out the broad import:

```bash
# From a writable parent; task_clone_dir MUST be a new directory.
task_clone_dir=/workspace/capiro-backend-codex-worker-UNIQUE
test ! -e "$task_clone_dir" || exit 1
git clone --no-checkout --single-branch \
  --branch codex/backend-cleanup-receiving-20261014 \
  https://github.com/neo-capiro/capiro-backend.git "$task_clone_dir"
cd "$task_clone_dir" || exit 1
git sparse-checkout init --no-cone
git sparse-checkout set --no-cone '/package.json' '/pnpm-lock.yaml' \
  '/pnpm-workspace.yaml' '/turbo.json' '/tsconfig*.json' \
  '/docs/backend-successor-plan-20261014/' \
  '/docs/api-four-family-acceptance-audit-20261014/' \
  '/docs/backend-cleanup-receiving-20261014/HANDOFF.md' \
  '/docs/backend-cleanup-receiving-20261014/INDEPENDENT-REVIEW.md'
git cat-file -e a65ae3c8a9f1f0cf96d4f7d2ae30aad2fff172ff^{commit} || exit 1
test "$(git rev-parse a65ae3c8^{tree})" = b5ff0511a9e35760a4c92f74270e07beba1bf319 || exit 1
git switch -c codex/backend-WORKER-SLICE-UNIQUE a65ae3c8a9f1f0cf96d4f7d2ae30aad2fff172ff
```

For actual continuation, fetch the published docs-plan branch, read its **reviewed immutable head from the PR receipt**, verify its tree and source-only ancestry, then fast-forward this new worker branch to that head. Do not infer the pin from a mutable branch name. Add only owned source and required fixtures to sparse checkout. `git sparse-checkout add` uses the existing non-cone mode; this installed Git does not accept `add --no-cone`. Read missing source with `git show <exactSHA>:<path>` rather than checking out everything. If cloning is too large, a separate local shared clone is acceptable with explicit permanent custody of its alternate object store; never delete that store.

```bash
# Replace BOTH placeholders from the independently reviewed publication receipt.
# They are required input; a branch name alone is not the starting contract.
task_plan_head=REVIEWED_40_HEX_DOCS_HEAD
task_plan_tree=REVIEWED_40_HEX_DOCS_TREE
git fetch origin refs/heads/codex/backend-successor-plan-20261014
git cat-file -e "$task_plan_head^{commit}" || exit 1
test "$(git rev-parse "$task_plan_head^{tree}")" = "$task_plan_tree" || exit 1
git merge-base --is-ancestor a65ae3c8a9f1f0cf96d4f7d2ae30aad2fff172ff "$task_plan_head" || exit 1
# Inspect this output: every path must be under docs/ for this docs-only handoff.
git diff --name-status a65ae3c8a9f1f0cf96d4f7d2ae30aad2fff172ff "$task_plan_head"
git merge --ff-only "$task_plan_head"
node docs/backend-successor-plan-20261014/verify-plan.mjs
```

Refresh read-only remote state before receiving a slice:

```bash
gh api repos/neo-capiro/capiro-backend --jq '{private,default_branch}'
gh api repos/neo-capiro/capiro-backend/pulls/4 --jq '{state,draft,head:.head.sha,base:.base.ref}'
gh api repos/neo-capiro/capirov2/commits/main --jq .sha
gh api repos/neo-capiro/capiro-frontend/pulls/25 --jq '{head:.head.sha,base:.base.ref}'
gh api repos/neo-capiro/meri-greenfield/pulls/71 --jq '{head:.head.sha,base:.base.sha}'
```

Stop only the dependent receiving action if a head changes; preserve both pins, compare deltas and coordinate with the owner. Continue unrelated bounded work. Root `AGENTS.md` is absent in the private receiving tree at `a65…`; search exact Git tree for scoped AGENTS before editing any path. Meri's own AGENTS and implementation standards apply to Meri-owned changes; do not invent private-root instructions.

## Repository roles and concurrency

| Owner / lane | Writes allowed in this plan | Required boundary |
| --- | --- | --- |
| Root backend receiver | Dedicated private backend source/docs branches, ordinary reviewed composition, draft PR publication | Sole integration/ref writer; never capirov2 main, frozen Front PR25 or Meri implementation |
| Cleanup owner / independent audit | Separate audit/review notes; future source only after exact path claim | Trace removal and Cleanup1–4 obligations; do not silently publish a competing backend integration |
| Meri owner | meri-greenfield runtime and exact boundary handoff | No legacy runtime copied into backend; qualify its own native registration/supervisor gates |
| Frontend shipping owner | Existing service and separately owned follow-up | Frozen PR25/source unchanged by backend cleanup; basic preview does not wait for optional APIs |
| Bounded Codex source worker | Only explicit disjoint paths on a unique branch | Characterize before edits; report head/tree/files/evidence; no other owner's refs or index |
| Independent Codex reviewer | Read-only exact candidate and separate review notes | Adversarial authority/replay/concurrency/DI review; no self-review substituted for acceptance |

Before parallel work, record exact baseline, owned files, intentionally read dependencies, reviewer and no-overlap list in the slice handoff. A branch is not a path-ownership grant. Root receives only reviewed immutable commits after checking parent, changed paths and all modes/blobs. Use ordinary merges or explicitly reviewed narrow commits; no wholesale source replacement, duplicate cherry-picks or assumption that sibling qualification applies to a combined tree. If a path overlaps another owner, pause that path and continue disjoint work. Keep one current contract handoff and one overlap/dependency matrix per composed candidate; this document is the top-level map and the four-family audit supplies endpoint detail.

Rollback is a new reviewed revert commit on the private successor, leaving original heads available. Do not reset/delete a donor, rewrite a protected branch, remove evidence or undo another owner's unrelated work. A failed slice is preserved with exact failed output and disposition, not relabeled as passing.

## Canonical-owner selection: Engagement first

Create an inventory row for **every actual candidate**, with feature ID, exact commit/tree, bootstrap/module import closure, controller/routes/DTOs, auth/tenant owner, persistence model/migration, service/helper owner, callers (including frontend), configuration/flags, workers/on-init/timers, build/image path, tests/fixtures and proposed disposition. Distinguish a second process/image from a second implementation. A branch/folder inventory alone cannot establish the requested three Engagement versions or select production.

Already verified source observations at `a65…`:

- Core: `apps/api/src/main.ts` boots `AppModule`; its `EngagementModule` registers the current `apps/api/src/engagement` owner.
- `apps/engagement-api` is a **Docker/process adapter**, with no separate package.json or independent Engagement implementation. Its README says it uses the same `apps/api/src` and DB. `apps/api/src/engagement-main.ts` boots `EngagementApiAppModule`, which imports that same `EngagementModule`.
- Engagement API additionally registers OutreachV3 state/targets/context/reasoning/generation/drafts/send modules. State/staging is an existing explicit feature owner, not proof that it replaces the full Engagement service.
- The shadow image is serve-only and defaults background/external actions/callbacks/recall to disabled; invalid arming fails config bootstrap. Preserve those existing semantics. Do not call it an ordinary deployed production backend merely because Docker source exists.
- Protected unpublished `e01…` is a separately held candidate. Do not adopt or inspect its reporting body during this lane.

**Exact missing production evidence:** no binding of the actually serving Core/Engagement image digest to a build-used Git commit/tree, process command/entrypoint, route origin and current configuration was established here. Declared/admitted Core `1e99f0921b207318c6d2abf03927b5c4daa5768b` and Intel `0732f2511796411c2d9a492e6a3b0a4bc33cb225` are reference admissions, not that binding. Source CDK topology is not proof of live deployments. Do not select “newest” or “legacy” based on them.

Prepare this bounded read request for the authorized shipping/runtime owner: existing deployment/task revision; serving image digest; existing build receipt linking digest to checkout commit/tree and dirty state; current process command; sanitized non-secret routing/feature posture; exact frontend API origin mapping. Ask for existing artifacts first, with no registry pull, rebuild, deploy, AWS access or credentials copied here. Record unavailable facts separately. Current authorization permits repo/PR/artifact metadata reads; it does not permit this source session to perform AWS/cloud operations. Only the dependent claim/removal requiring live provenance waits; source dependency extraction and candidate inventory can proceed. A normal API 401/403/404/5xx must be attributed to its actual owner/middleware/route/config, not guessed as preview tenant denial.

Choose one canonical implementation only when the evidence shows retained callers and contracts resolve to it. Preserve an alternative as a pinned ancestor/archive if not selected; remove active imports/registrations/build consumers on the dedicated successor only after mapped replacement and before/after verification. Retained V3 additions must have explicit scope and guards; avoid a second shadow store/service. This lane must not duplicate or change the protected reporting work.

## Meri boundary: extract domain authority, retire legacy runtime

The authoritative Meri-owned boundary is [PR71's immutable report](https://github.com/neo-capiro/meri-greenfield/blob/7e822a7cfe5150b2c8d8fc1d5984fd2348ae4866/docs/coordination/reports/CODEX-CAPIRO-BACKEND-INTEGRATION-BOUNDARY-20261014.md), based on backend PR2449 `60cf2e51129f8358e6afe5fc600ffcdb6de01759` carried by PR2482 `37339931788d8384b864192f2c2eacf56cd9bf06`. Its extraction compiles **four MeriService methods and two controller methods**, not the legacy runtime. Compare exact current bodies to those pins; preserve any reviewed later authority fixes. [Cleanup PR2493's reviewed plan](https://github.com/neo-capiro/capirov2/blob/243943b0ca6f17b399d9f417e343050cbd3e4185/docs/backend-cleanup/20261014/canonical-backend-boundary/PLAN.md) independently inspected 17 complete private subtrees/2,307 unique leaf paths and verified 56 critical private blobs; it corroborates this extraction and the unresolved wider retirement. Exact lossless report copies and their source/hash identities are retained beside this document.

Retain the existing wire and current authorization for one authenticated conversation:

| Required contract | Existing owner / exact behavior |
| --- | --- |
| `POST /api/clio/application-authority/identity`, body `{}` | `MeriController.applicationAuthorityIdentity` → service method at pinned line 395 → strict body helper, `TenantContextMiddleware.readApplicationAuthority`, identity receipt; no-store/current native bearer, principal/revision/current-check/**original expiry** |
| `POST /api/clio/application-authority/context`, body `{identitySha256,conversationId,clientId}` | Controller → service at pinned line 401 → strict context parse, fresh native authority, owned active conversation, client visibility/current wall/grant; prospect branch additionally binds linkedClientId |
| Active owned conversation authorization | `ensureConversation` at pinned line 912: `clioConversation` matches ID, tenant, native owner user and `archivedAt:null`, includes client, research-portfolio authorization |
| Current client visibility | `ensureClientVisible` at pinned line 994: same tenant/client, not archived; canonical `ContextSecurityScopeService.resolveApplicationAuthorityClient` supplies current client-wall/grant authority |

Actor ID is **`TenantContext.userId`**, never the Clerk subject. Raw `/me` or membership-profile JSON is not a replacement for the receipt. Retain native auth helpers at `apps/api/src/auth/application-authority.ts`, current Clerk session/original expiry, tenant middleware/store, active membership/roles/RolesGuard and Prisma.withTenant. Preserve middleware provisioning/activity/audit behavior, strict unknown-field rejection, current receipt revalidation and original expiry. No new auth layer or receipt store is needed.

Keep the `clioConversation` lookup/table despite its name: it currently binds the conversation presented by Meri to native tenant/owner/client authority. A replacement mapping needs an explicit coordinated equivalent contract, not deletion by name. Retain conditional business-development/prospect/research permission helpers: `meri-prospect-scope.helpers.ts`, `bizdev-meri-scope.service.ts`, research scope parser and `research-portfolio-artifact-authority.ts`. Do not copy agent/planner loops with them.

Required narrow read contracts from Meri's implemented source adapters (currently disabled for first plain conversation; activation separately owned):

- `POST /clio/tools/query_tasks` and `/clio/tools/query_action_items`: preserve canonical typed task/action-item queries, paging/coverage and current actor/client permissions through thin domain handlers; do not retain the old agent dispatcher just to keep these routes.
- `POST /clio/tools/list_memory_proposals`: own pending governed proposals/current policy. Preserve domain proposal behavior, not the legacy memory agent.
- Research portfolio `GET /research-portfolios/:id/snapshots/:recordId`, `/:id/annual-review`, `/:id/reviews?lane={mine,team,deferred,resolved}`: preserve domain APIs/visibility/RLS.
- Mail, meetings/debriefs, client documents/context, institutional memory eligibility/search, Monday boards and identity/contact resolution use explicit endpoint maps in Meri's `sources/*/http-adapter.mjs`. Do not invent fixed paths; preserve the underlying domain owners and coordinate maps separately.

Prefix mapping is unresolved for source read adapters: authority explicitly sends `/api/clio/...`, while those read adapters construct `/clio/...` and `/research-portfolios/...` against an origin-only binding. Coordinate public `/api`/reverse-proxy mapping with Meri; do not silently add/remove prefixes or claim disabled adapters are deployed accepted routes.

Meri owns SDK loop, Temporal/broker, run/event/budget/session journals, native task verification, SessionStore/registration observation, trusted runtime/model proxy, skill/MCP continuation, approvals/governed output and DOCX/artifact generation/storage/rendering. Ten task operations relay only to Meri control. Do not implement runner/worker/readiness/model orchestration APIs in capiro-backend. No rebuilt Meri callsite requires old `/meri-api`, `MERIV2_ORCHESTRATOR_URL`, recipes/planners/semantic gateway, queues/workers/front-end runtime or legacy Office generators.

**Actual dependency hazards before retirement:** Core currently imports MeriModule/MeriMobileModule; MeriModule registers 11 controllers and legacy service/V2/V3 clients/tools/factories/lease sweeper/OTEL lifecycle. Mobile, WorkspaceAssistant and CapiroAdmin import MeriModule. Engagement and Retrieval import managed-MCP independently. `main.ts` invokes the old policy-pack disabling helper. API, Intel hearing tools, Workspace generation/reasoning/in-editor and Strategy draft/report still call `apps/meriv2-orchestrator`. Strategy has URL-gated draft timers and watcher/outbox/reconciler loops. `clio-sandbox` is called by meri-tools; default `MEMORY_RECALL_SOURCE=clio` may still be domain behavior. Trace each before source removal.

`@capiro/meriv2-core` has active shared contracts: memo/district/outreach auditor behavior before filing/state writes, auditor mode/skeptic escalation, ContextPacketRolloutCompiler, memory governance and Intel Zod/tool/editorial/record contracts. Extract or retain canonical domain/audit contracts with parity; do not delete by package name or rewrite an active provider integration under the engineering-agent restriction. A truly unused package edge must be proven with static/dynamic/build consumers.

The first substantial seam should move authority/context plus required domain authorization into a focused existing auth/domain owner and thin controller, severing its reliance on legacy Meri runtime DI. Root allocates exact paths only after the dependency audit and docs publication. Preserve ordinary route/auth receipts and all callers. Subsequent slices replace narrow source-read handler dependencies, then remove runtime imports/on-init/build/deployment-source consumers in the successor after their replacement is proven. Avoid isolated cosmetic dead-helper removal as a substitute for this boundary. Do not describe the successor as runtime-free until the selected bootstrap import closure proves it.

Cleanup PR2493 adds required full successor startup acceptance: build and inspect the candidate's own emitted closure with retired paths/packages unavailable; compose real retained Nest modules with I/O-only stand-ins and independently denied outbound network; verify routes/domain behavior, exclusive worker/callback ownership, container argv and shutdown. Stale donor dist/node_modules, an empty replacement root or a failed DB connection cannot count as a successful boot. Engagement defaults can be active, and an inert source fixture must also cover direct OutreachV3 flag readers. Read its [AUTHORITY-ACCEPTANCE.json](https://github.com/neo-capiro/capirov2/blob/243943b0ca6f17b399d9f417e343050cbd3e4185/docs/backend-cleanup/20261014/canonical-backend-boundary/AUTHORITY-ACCEPTANCE.json), [START-ACCEPTANCE.json](https://github.com/neo-capiro/capirov2/blob/243943b0ca6f17b399d9f417e343050cbd3e4185/docs/backend-cleanup/20261014/canonical-backend-boundary/START-ACCEPTANCE.json) and [production provenance gaps](https://github.com/neo-capiro/capirov2/blob/243943b0ca6f17b399d9f417e343050cbd3e4185/docs/backend-cleanup/20261014/canonical-backend-boundary/PRODUCTION-PROVENANCE-GAPS.json) before declaring retirement accepted. Those startup checks were proposed, not run by that audit. The private Workspace subtree differs from the cleanup donor, so its qualification cannot be transferred. Root workspace selectors still span apps/packages/infra, and some default verification chains include old frontend; select inspected backend-only commands and migrate selectors/build inputs before frontend retirement.

That audit preserves old October 12 **observations**, not a fresh deployment binding: Core task `capiro-dev-api:650`, digest `sha256:0a2ea000b74b164f0080ee84f61554f59784d2caecb0f97bae59ac3eb44474c0`, revision label `1e99…`/tree `ce817706a72b7f096cf3e112f28ec355153e5653`; standalone Engagement task `capiro-dev-engagement-api:155`, digest `sha256:e23a4a9d79d625649d24a9d9e54f843d110669e50c0a341cf72f5aa71f14c441`, label `192cca3a1386eb2ceb370e01f6041e338709ab24`/tree `5b899d3e35253493b7f8ea9b193279a0d76b0645`. Build-used source and current runtime ownership remain unestablished. Request existing attestation/current safe metadata through the authorized runtime owner; no AWS/cloud call is made here. Three complete competing Engagement managers were **not corroborated**: Core/standalone share implementation and V2/V3 have distinct state semantics.

## Existing feature contracts: qualify, do not duplicate

Use [the full four-family source matrix](../api-four-family-acceptance-audit-20261014/MATRIX.md). Its receipt binds 62 selected source/test/doc blobs and 136 literal test declarations; those counts are an inventory, not a fresh pass.

| Feature / canonical owner | Existing implementation | Remaining qualification / dependency |
| --- | --- | --- |
| Objectives / Core Clients | Client-nested GET/POST/PATCH/DELETE/transition, expectedVersion, create-request replay, immutable revision persistence | Chosen Core entrypoint/current auth/client scope and schema; qualify normal lifecycle first; reuse ObjectivePR2362, no second store |
| Objective destinations / each resource owner | Bounded kind/resource ID/objective revision; current same-client authority via Core Objective plus Outreach/Strategy/Planner/Workspace owner | Read-only resolution receipts do not create durable work/association; no mixed-owner fallback |
| Ordered account owners / Core Clients | GET/PUT ranked owners, expectedVersion, shared legacy Primary projection/transaction/audit | Native consistency/backfill/RLS and authorized versioned read/save/recovery with legacy writer |
| Saved newsletter / Workspace + Engagement V3 | Exact WsDocVersion canonical snapshot hash; current source rights; existing owned session/expectedStateVersion; durable command-batch receipt and replay | POST is on **EngagementApiAppModule**, not Core; existing state flag defaults disabled →404. Coordinate routing/config/schema, do not disable gates or clone handlers. No send/generation; not initial live test because it replaces session content |
| Effective dates / Core Federal Register | Effective-only authoritative evidence with date-kind/provenance, bounded date range, explicit incomplete coverage/freshness/refresh/correction semantics | Controlled authoritative ingestion/data/MVCC/native qualification. Empty local result is not complete coverage; publication/comment-end dates are never substitutes |

Workspace saved-version immutability migration is committed as `20261012040000_saved_version_immutability/migration.sql`; frontend PR26's `20281012040000...` label is a documentation discrepancy, not a missing migration. Reconcile the handoff without running it. The existing `OUTREACH_V3_STATE_ENABLED` guard remains unchanged; actual feature admission is a separate shipping/config decision. No extra auth/tenant layer is warranted for the basic preview.

Saved portfolio layout is a separate actual source gap: frozen PR25's `apps/web/src/features/portfolio/index/layout/api.ts`, blob `6991341ec7c9def7cb645b34e54d557bfa74a032`, calls Core `GET/PUT /api/me/portfolio-layout` with actor/catalog/version receipts. No matching route/module/persistence model was found in receiving Core API/schema/Shared at `a65…`; existing `/me` preference fields are not this contract. Coordinate the frontend owner's saved-layout mapping rather than assuming it is one of the four implemented families or silently assigning a new backend store in this extraction.

## Selective retirement and Cleanup1–4 standards

For every proposed removal, record stable feature/group ID, before path/blob, all source/dynamic/build/CLI/worker/frontend/Meri consumers, replacement path/blob, exact preserved contracts/test identities and disposition. Review runtime `import()`, reflection/DI registration, barrel exports, package manifests/workspace globs, scripts, Dockerfiles/CDK source, env flags/defaults, on-init hooks/timers, test/fixture imports, SDK types, shared schemas and migration/history dependencies. Static zero imports alone is not enough. Keep migration/incident/ADR/manual-recovery/history records and source archives. Retire only from the dedicated successor; original histories and branches stay intact.

Read the immutable originals [CleanUp1](https://github.com/neo-capiro/capirov2/blob/f1e83a3f194a8ebd972e370ff6e5b5f559888b29/docs/plans/CleanUp1.md), [CleanUp2](https://github.com/neo-capiro/capirov2/blob/f1e83a3f194a8ebd972e370ff6e5b5f559888b29/docs/plans/CleanUp2.md), [CleanUp3](https://github.com/neo-capiro/capirov2/blob/f1e83a3f194a8ebd972e370ff6e5b5f559888b29/docs/plans/CleanUp3.md), [CleanUp4](https://github.com/neo-capiro/capirov2/blob/f1e83a3f194a8ebd972e370ff6e5b5f559888b29/docs/plans/CleanUp4.md) and [current requirements reconciliation](https://github.com/neo-capiro/capiro-backend/blob/a65ae3c8a9f1f0cf96d4f7d2ae30aad2fff172ff/docs/backend-cleanup/20261013/requirements-reconciliation/REQUIREMENTS-RECONCILIATION-v2.md), JSON, provenance and closeout map. Their precise requirements remain binding. Neo's newer selective-retirement instruction supersedes blanket preservation of legacy Meri/frontend **only on this private successor after dependency closure**; it does not retroactively close their gates.

- Cleanup1: retain locked toolchains and global clean-checkout package/type/build/four-guard/Python/isolated-script-smoke/visual/3× flake/coverage-floor obligations. Source CI presence or finite app tests do not make the whole gate green.
- Cleanup2: generate a fresh all-eight-subject inventory with stable IDs and human dispositions, canonical helpers/config/contracts/loops and retained behavior. Historical `a533ad1` inventory and 1,559 open rows are stale, not a current deletion list. Remaining TS/Python domain ADR is still open; this task does not authorize language conversion.
- Cleanup3: preserve before/after expanded test identities, assertion intent, multiplicity and fixtures across the five runner families. Remove a duplicate/obsolete structural test only with explicit proof/mapping; no test deletion to hide failures, denominator gaming or mocked substitutes for native acceptance.
- Cleanup4: preserve all five Wave0 postures, shared-seam adoption/same-change guards, nine domain registries, twins/gods/context/config/flags/security coordination. Use focused cohesive modules, explicit interfaces and one canonical source owner. Specific reviewed extraction scopes expect below 400 nonblank module lines and 80 physical function lines; this is not a universal arbitrary quota or permission to fragment cohesive functions.

The reconciled 84 obligation groups include 6 finite-qualified, 15 preservation, 18 implementation-primary and 45 blocked/acceptance groups. The latter 63 are **remaining obligations**, not 63 actual defects. Watchlist/parser finite contributions do not close additional original global groups. The historical coverage baseline and complete global gates remain open; retain these limits rather than invent acceptance.

Keep implementation details out of product UI flows. Use existing domain owners/services; do not create a generic framework, competing store or parallel authorization engine. Preserve role/current tenant checks, request DTO closure, error semantics, async launch/await order, receivers/default evaluation, import safety and cleanup of borrowed resources.

## Before/after verification and evidence

Before a substantial change, outline exact responsibility split and characterize real boundaries with inert ports. Bind every receipt to exact source commit/tree, toolchain/config/command, selected dependency schemas and full lossless output. Keep failures alongside corrected runs. Native/client presence does not permit a DB connection or generation. Never run a broad script merely because its name contains “verify”; inspect whether it migrates/seeds/uploads/calls providers first.

Finite sequence for each owned slice:

1. Source/consumer manifest and stable test identity/assertion/fixture baseline. Hash relevant source and existing dependency/client schemas; declare protected body exclusions and any opaque throwing DI token used by a fixture.
2. Baseline focused **actual** service/controller checks with mocked/inert database/provider ports, not tests that mirror the planned implementation. Confirm ordinary auth/body/role failures and receiver/async ordering.
3. Implement the canonical extraction; preserve route DTOs/auth/receipts, read/write ordering, current-check/expiry, exact snapshot/hash/replay/version/error contracts. For mutating domain owners independently review foreign scope, revoked authority before replay, request-ID collisions, stale versions, rollback and concurrent winner behavior. Do not promise stronger locks/CAS than implemented.
4. Repeat original cases and meaningful adversarial additions; compare case identities/multiplicity/assertion intent and fixtures. No lost/skipped business cases. Run source import/DI/route closure guards and relevant twin/cycle/ownership ratchets. Prove retired runtime/timers cannot be reached/armed by the **selected** bootstrap; distinguish that from a global full-app boot claim.
5. Run appropriate locked type/build/syntax checks for changed owners and their callers where dependencies permit. Inspect scripts first, use no network/provider/DB ports, preserve failed evidence if resource/protected-source prerequisites block full scope. Scoped TS/transpile/fixture pass is not a full API Nest build, native migration/RLS or live acceptance.
6. Independent Codex review of exact commit/tree and adversarial controls; root receives only after source and evidence agree. Publish draft PR/head/tree promptly; continue remaining independent work.

Current PR4 finite receipts: Watchlist 481 cases/37 suites, fresh Shared build, full Intel type/build, strict tracker/watchlist fixtures and emitted-artifact checks. Existing targeting version read/upsert still has no CAS/row lock; cleanup did not add a concurrency guarantee. Memo/parser 161 cases/13 suites plus strict import-free parser typecheck, three API compiler-option transpile/syntax checks, two caller class bodies byte/hash preserved. Memo's protected Engagement dependency was replaced **only in the docs fixture** with an opaque throwing token; no no-op business behavior. Full API type/Nest/seven-ratchet chain was not rerun in the receiver. These receipts are source/mocked/finite, not whole production/native acceptance.

PR4 packet has 57 indexed files and exactly two derived exclusions, 15 decoded raw observations, including failed ENOSPC/path/Git-buffer/relative-filename checks and corrected runs. `seal-packet.py` verifies committed Git objects; archives and earlier receipts remain. No active `.github/workflows` entries exist; all 74 planned workflow/dependabot files are disabled in the quarantine archive. Do not activate them as part of this task.

Source hygiene command (first materialize its small explicit dependencies):

```bash
node scripts/lib/reviewed-source-hygiene.mjs --run \
  --base a65ae3c8a9f1f0cf96d4f7d2ae30aad2fff172ff
```

It checks working/index paths with four exact immutable raw-observation exclusions, not broad whitespace/evidence exemption. A JS fence/environment scrub helps source checks but is **not** an OS sandbox. Do not claim complete network prevention or run live ports. Existing caches are borrowed: the old Core client was stale; the selected preserved client source schema SHA256 is `215556bd82b97f0be84d7f97da7f19a5a25bace97dc54b1a550cab2039a740fb`. Intel generated schema differs formatting but has 24,378 identical lexer tokens including strings/comments. Schema presence/lexical match is not native permission/database qualification.

## Ordered continuation and genuine blockers

After this docs-only PR is reviewed and published:

1. Root resumes the separate functional successor; publish refreshed owner/retirement/dependency matrix. Inventory real Engagement versions first and request the exact missing serving-image/source binding through the authorized runtime owner. Continue source seams without claiming deployed winner.
2. Extract Meri authority/context into focused shared auth/domain ownership with exact existing route/receipt/current scope and all conditional branches preserved. Independently verify before/after and absence of a legacy runtime dependency for this seam.
3. Map narrow task/action/memory/research reads, replace legacy module consumers and source-call transport edges, then retire old runtime bootstrap/on-init/build/source deployment references where contracts are closed. Preserve canonical audit/shared domain pieces even if names are old. Coordinate unresolved source-read prefix maps with Meri owner.
4. Qualify already implemented Core Objectives, then ranked owners through normal existing APIs/auth. Calendar evidence/refresh and saved staging owner/routing/schema each keep their explicit acceptance boundary. Coordinate the separate missing `GET/PUT /api/me/portfolio-layout` persistence/receipt mapping with the frontend owner and root before allocating backend paths; retain its held disposition until the existing canonical owner and exact contract are agreed. Implement only reproduced current source/runtime gaps, not duplicate routes. These are not basic-preview gates.
5. Receive each disjoint independently reviewed slice, maintain exact handoff/matrix, publish draft PR/head/tree with finite failed/passing evidence and continue.

Open facts that cannot be papered over: real serving image/source/command/config/origin binding; current signed-in identity/tenant/owned test flow; native Core/Workspace/outreach schemas/grants/RLS/migration acceptance; controlled calendar ingestion/MVCC; protected Engagement publication/full API qualification; Meri native registration-reader/supervisor and live acceptance; source-read prefix mapping; global Cleanup coverage floor/visual/flake/all-package gates. Report exact dependent action/blocker. Ask the user only for genuine unresolved product choices; missing build/runtime artifacts are evidence requests, not invented product decisions. Continue unrelated source work.

## Primary source links

- [Private PR4](https://github.com/neo-capiro/capiro-backend/pull/4), [exact receiving handoff](https://github.com/neo-capiro/capiro-backend/blob/a65ae3c8a9f1f0cf96d4f7d2ae30aad2fff172ff/docs/backend-cleanup-receiving-20261014/HANDOFF.md), [independent review](https://github.com/neo-capiro/capiro-backend/blob/a65ae3c8a9f1f0cf96d4f7d2ae30aad2fff172ff/docs/backend-cleanup-receiving-20261014/INDEPENDENT-REVIEW.md).
- [Private PR1](https://github.com/neo-capiro/capiro-backend/pull/1), [optional PR2](https://github.com/neo-capiro/capiro-backend/pull/2), [optional PR3](https://github.com/neo-capiro/capiro-backend/pull/3).
- [Frozen frontend PR25](https://github.com/neo-capiro/capiro-frontend/pull/25), [separate PR26 API/error follow-up](https://github.com/neo-capiro/capiro-frontend/pull/26).
- [Meri PR71](https://github.com/neo-capiro/meri-greenfield/pull/71), [exact boundary report](https://github.com/neo-capiro/meri-greenfield/blob/7e822a7cfe5150b2c8d8fc1d5984fd2348ae4866/docs/coordination/reports/CODEX-CAPIRO-BACKEND-INTEGRATION-BOUNDARY-20261014.md), [Meri implementation standards](https://github.com/neo-capiro/meri-greenfield/blob/7e822a7cfe5150b2c8d8fc1d5984fd2348ae4866/docs/IMPLEMENTATION-STANDARDS.md).
- [Cleanup PR2493](https://github.com/neo-capiro/capirov2/pull/2493), [exact selective boundary plan and evidence directory](https://github.com/neo-capiro/capirov2/tree/243943b0ca6f17b399d9f417e343050cbd3e4185/docs/backend-cleanup/20261014/canonical-backend-boundary).
- [Original reconciled ledger](https://github.com/neo-capiro/capirov2/blob/797e3a59158cff56b017ab7d01ee445bf624fced/docs/backend-frontend-handoff-20261012/RECONCILED-LEDGER.md), [PR2400 immutable tree](https://github.com/neo-capiro/capirov2/tree/6c26ac2dad3756a61b6733329dea7ce3c9138ece/docs), [split-preparation custody inventory](https://github.com/neo-capiro/capiro-backend/tree/a65ae3c8a9f1f0cf96d4f7d2ae30aad2fff172ff/docs/backend-repository-split-preparation-20261013), [current Cleanup closeout](https://github.com/neo-capiro/capiro-backend/blob/a65ae3c8a9f1f0cf96d4f7d2ae30aad2fff172ff/docs/backend-cleanup/20261013/CLEANUP-CLOSEOUT-MAP.md).

## Copy-paste starting prompt for a fresh OpenAI/Codex worker

```text
You are an OpenAI/Codex source worker for PRIVATE neo-capiro/capiro-backend.
Read this exact published instructions file, its PIN-MATRIX.json, independent
review, four-family MATRIX.md, PR4 handoff and Meri PR71 immutable boundary.
Verify the instructions PR's exact head/tree from its publication receipt.
Base a new unique sparse checkout/branch on that reviewed docs head; preserve
all old dirty/untracked/ignored/unpublished work in place and all original refs.
Do not start from backend-import or copy mixed candidate folders.

Root is sole private receiving/integration writer. First report your baseline,
proposed exact owned paths and dependencies; obtain path allocation from root.
Do not touch frozen frontend PR25, capirov2/main, Meri runtime source, another
worker's index/refs or protected unpublished Engagement e01e3b72aa0e26f4d2a9ad65533da1d561920aca/body.
Do not use Claude/Fable/external coding agents for engineering/review. This
does not authorize changing product models/providers. Keep TypeScript/NestJS.

Engagement inventory comes first: distinguish shared implementation/process
adapters and V3 additions, trace real bootstrap/routes/data/auth/callers/flags/
workers/builds, and identify actual missing image-digest-to-source binding.
Do not declare a production winner from folder names/newness/reference pins.
Continue the allocated substantial source slice while bounded runtime evidence
is requested from the authorized owner. No AWS/cloud operation here.

Extract narrow existing Meri identity/context/domain authorization and typed
read contracts with exact native actor/current session/original expiry/client-
wall/conversation/prospect/research behavior. No legacy Meri/Clio runtime belongs
in the selected new backend bootstrap; shared auth/data/audit services remain.
Trace all consumers before retiring source and preserve migration/history.
Use one canonical working owner per feature. Existing Objective/ordered-owner/
saved-version staging/effective-date routes already exist; qualify their real
entrypoint/schema/routing/data gaps rather than inventing another API/store.
Use normal existing login/tenant permissions; no preview auth layer/reader gate.

Characterize before editing, retain all business cases/fixtures/assertion intent,
run meaningful inert source/type/build/import/DI/auth/replay/concurrency checks,
retain lossless failures and corrected receipts bound to exact source. Obtain
independent Codex review. Return head/tree/files, before/after evidence, precise
remaining blockers and a reviewable draft-PR handoff to root promptly.
No DB/migrations, real messages/uploads/provider/paid calls, customer writes,
credentials/permissions/security/network changes, force pushes, main merges or
deployments. No abandoned Commitment/We owe/They owe/counterparty UI or dead
code. Preserve normal shared task management. Ask the user only for genuinely
unresolved product choices and continue unrelated work. Docs are a checkpoint:
continue actual allocated selective source cleanup after publishing them.
```
