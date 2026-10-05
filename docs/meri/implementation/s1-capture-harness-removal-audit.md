# Stage 1 §4.4 — capture harness removal: reachability audit

Program plan: `00-Meri-Program-Plan-2026-10-05.md` §4.4 (scope), §3 rule 7 (delete only after a reachability audit), §9 (typecheck plus focused specs).

Branch `codex/meri-remove-capture-harness-s1`, cut from `origin/main` at `4cc1b7793`. Every importer below was read on that commit, before any edit.

## Method

1. Built a relative-import graph over every `.ts`, `.tsx`, `.js`, `.mjs` and `.cjs` file in `apps/`, `packages/`, `scripts/`, `evals/` and `infra/` (9,810 files scanned, 23,944 resolved import edges; `node_modules`, `dist` and build output excluded). For each candidate file the graph gives its importers.
2. Searched for path references that are not imports: `git grep` over the same trees plus `.github/workflows/*`, `apps/api/Dockerfile`, `apps/api/scripts/entrypoint.sh`, `package.json`, and the `require('../dist/...')` / `source('memory/...')` dynamic loads inside the API operator scripts.
3. Read every non-harness importer to find what the ordinary (no capture policy) path does through the harness call. Each harness entry point returns `null`, `undefined` or the unchanged input when no capture policy is present; that path was kept, the capture branch was removed.
4. Deleted the files, fixed the importers, then ran the three typechecks and the focused specs (results in the PR body).

## Corrections to the plan's list

The §4.4 list named four modules that are not part of the harness. The audit keeps them:

| File | Why it stays |
| --- | --- |
| `apps/api/src/meri/governed-meri-tools.proxy.ts` | Wraps `MeriToolsService` for every tool call: translates the governed-memory `memory_pending_review` / `memory_duplicate` signals, checks chart-artifact ownership for `create_word` / `create_powerpoint`, and dispatches the Federal Market tools. Provided by `meri.module.ts`. No capture code. |
| `apps/api/src/meri/governed-meri-research.factory.ts` | Phase 19 Context Plane wrapper for Deep Research (`streamPlan`, `streamResearch`) and the Phase 27F evaluation decision. Provided by `meri.module.ts`. No capture code. |
| `apps/api/src/meri/meri-artifact-test-fixtures.ts` | Test-only byte generators (PNG, PDF, DOCX/XLSX/PPTX) used by seven product artifact specs. Not imported by production code and not capture-related. |
| `apps/meriv2-orchestrator/src/meri/meriv3/meriv3-governed-tool-selection.ts` | Builds the semantic tool gateway's selection context (retrieval plan, protected and discovery tool names) on every V3 turn in `meriv3-assistant.service.ts`. Deleting it would change ordinary tool selection. |

The plan's list also missed harness code outside `apps/api/src/meri/`. These were found by the audit and removed: `client-documents/case46-source-indexing.ts`, `memory/case14-fixture-evidence.ts` (+ `case14-reviewer-preflight.ts`), `memory/pending-memory-fixture-evidence.ts`, `memory/case12-*` and `retrieval/adapters/case12-memory-eligibility.read.ts`. The two memory fixture-evidence modules load `evals/meri/live-v1/fixture-provisioning/*.mjs` at runtime, so they could not stay once `live-v1` is gone.

## Deleted files and their importers

"Importers" lists only files outside the deleted set; "(edited)" marks the product files changed in this PR to drop the call.

### API Meri harness modules (`apps/api/src/meri/`)

| File | Importers on origin/main (outside the deleted set) | Disposition |
| --- | --- | --- |
| `meri/meri-api-capture-observations.ts` | `meri/meri.service.ts` (edited) | deleted |
| `meri/meri-capture-api-provider-scope.ts` | `embeddings/titan-embedding.provider.ts` (edited); `memory/memory-candidate.service.ts` (edited); `meri/meri-context-plane-runtime.ts` (edited); `meri/meri-context-plane.service.ts` (edited); `meri/meri-tools.service.ts` (edited); `reranking/nvidia-reranking.provider.ts` (edited) | deleted |
| `meri/meri-capture-clock-packets.ts` | `meri/meriv3-proxy.service.ts` (edited) | deleted |
| `meri/meri-capture-policy-readback.ts` | `meri/meri.service.ts` (edited) | deleted |
| `meri/meri-capture-provider-budget-install.ts` | none (only other deleted harness files) | deleted |
| `meri/meri-capture-provider-budget-owner.ts` | `meri/meri-context-plane-runtime.ts` (edited); `meri/meriv3-proxy.service.ts` (edited) | deleted |
| `meri/meri-capture-provider-budget-receipt.ts` | `meri/meriv3-proxy.service.ts` (edited) | deleted |
| `meri/meri-capture-provider-budget.controller.ts` | `meri/meri.module.ts` (edited) | deleted |
| `meri/meri-capture-provider-budget.ts` | `meri/meri-context-plane-runtime.ts` (edited); `meri/meri-tools.service.ts` (edited); `meri/meriv3-proxy.service.ts` (edited) | deleted |
| `meri/meri-capture-semantic-clock.ts` | `meri/meri-context-plane-runtime.ts` (edited) | deleted |
| `meri/meri-case01-capture-authority.ts` | `meri/meri.service.ts` (edited) | deleted |
| `meri/meri-case01-fixture-authority-registry.ts` | none (only other deleted harness files) | deleted |
| `meri/meri-case01-fixture-bootstrap.provider.ts` | `meri/meri.module.ts` (edited) | deleted |
| `meri/meri-case01-fixture-loader.ts` | none (only other deleted harness files) | deleted |
| `meri/meri-case12-capture-authority.ts` | `meri/meri-context-plane.service.ts` (edited); `meri/meri-tools.service.ts` (edited); 1 spec(s), edited: `meri-context-plane.tools.spec.ts` | deleted |
| `meri/meri-case12-capture-install.ts` | none (only other deleted harness files) | deleted |
| `meri/meri-case12-capture-readback.ts` | `meri/meri.service.ts` (edited) | deleted |
| `meri/meri-case12-capture-remediation.ts` | none (only other deleted harness files) | deleted |
| `meri/meri-case12-native-setup-admission.ts` | none (only other deleted harness files) | deleted |
| `meri/meri-case12-setup-budget-owner.ts` | none (only other deleted harness files) | deleted |
| `meri/meri-case12-setup-budget.ts` | none (only other deleted harness files) | deleted |
| `meri/meri-case12-setup-completion.read.ts` | none (only other deleted harness files) | deleted |
| `meri/meri-case12-setup-provider-scope.ts` | `embeddings/titan-embedding.provider.ts` (edited); `memory/memory-candidate.service.ts` (edited) | deleted |
| `meri/meri-case14-capture-authority.ts` | `meri/meri.service.ts` (edited) | deleted |
| `meri/meri-case46-action-authority.ts` | `meri/meri-action-proposal.controller.ts` (edited); `meri/meri-action-proposal.service.ts` (edited); `meri/meri-context-plane-runtime.ts` (edited); `meri/meri-tools.service.ts` (edited); `meri/meri.module.ts` (edited); `meri/meri.service.ts` (edited); `meri/meriv3-proxy.service.ts` (edited); 1 spec(s), edited: `meri-action-proposal.service.spec.ts` | deleted |
| `meri/meri-case46-api-provider-scope.ts` | `meri/meri-context-plane-runtime.ts` (edited) | deleted |
| `meri/meri-case46-authority.ts` | `meri/meri-action-proposal.service.ts` (edited); `meri/meri-context-plane-runtime.ts` (edited); `meri/meri.service.ts` (edited); `meri/meriv3-proxy.service.ts` (edited); 1 spec(s), edited: `engagement.client-filing.spec.ts` | deleted |
| `meri/meri-case46-capture-readback.ts` | `meri/meri.service.ts` (edited) | deleted |
| `meri/meri-case46-provider-budget-owner.ts` | `meri/meri-context-plane-runtime.ts` (edited); `meri/meriv3-proxy.service.ts` (edited) | deleted |
| `meri/meri-case46-provider-budget.ts` | `meri/meri-context-plane-runtime.ts` (edited) | deleted |
| `meri/meri-case46-remediation.ts` | none (only other deleted harness files) | deleted |
| `meri/meri-case46-setup-dependencies.ts` | none (only other deleted harness files) | deleted |
| `meri/meri-case46-setup-owner.ts` | none (only other deleted harness files) | deleted |
| `meri/meri-case46-turn-owner.ts` | `meri/meri-context-plane-runtime.ts` (edited); `meri/meriv3-proxy.service.ts` (edited) | deleted |
| `meri/meri-controlled-budget-result.ts` | none (only other deleted harness files) | deleted |
| `meri/meri-controlled-read-capture-authority.ts` | `meri/meri.service.ts` (edited) | deleted |
| `meri/meri-controlled-read-fixture.ts` | `meri/meri-source.service.ts` (edited); `meri/meri-tools.service.ts` (edited); `meri/meri.controller.ts` (edited) | deleted |
| `meri/meri-feedback-fixture.service.ts` | `meri/meri.module.ts` (edited); 1 spec(s), edited: `meri-feedback-anonymize.spec.ts` | deleted |
| `meri/meri-server-capture-evidence.ts` | `meri/meri.service.ts` (edited); `meri/meriv3-proxy.service.ts` (edited) | deleted |
| `meri/meri-server-readonly-capture.ts` | `meri/meri-action-proposal.controller.ts` (edited); `meri/meri-context-plane-runtime.ts` (edited); `meri/meri-tools.service.ts` (edited); `meri/meri.controller.ts` (edited); `meri/meri.service.ts` (edited); `meri/meriv3-proxy.service.ts` (edited); 1 spec(s), edited: `meri-tools.registration.spec.ts` | deleted |
| `meri/meri-synthetic-read-budget-owner.ts` | `meri/meri-context-plane-runtime.ts` (edited); `meri/meri.service.ts` (edited); `meri/meriv3-proxy.service.ts` (edited) | deleted |
| `meri/meri-synthetic-read-budget.ts` | none (only other deleted harness files) | deleted |

### API harness modules outside `meri/`

| File | Importers on origin/main (outside the deleted set) | Disposition |
| --- | --- | --- |
| `client-documents/case46-source-indexing.ts` | `engagement/engagement.service.ts` (edited); 1 spec(s), edited: `engagement.client-filing.spec.ts` | deleted |
| `memory/case12-setup-terminal.read.ts` | none (only other deleted harness files) | deleted |
| `memory/case12-synthetic-approved-memory-set.read.ts` | none (only other deleted harness files) | deleted |
| `memory/case14-fixture-evidence.ts` | `memory/memory-review-inbox.service.ts` (edited) | deleted |
| `memory/case14-reviewer-preflight.ts` | none (only other deleted harness files) | deleted |
| `memory/pending-memory-fixture-evidence.ts` | `memory/governed-memory-candidate.service.ts` (edited) | deleted |
| `retrieval/adapters/case12-memory-eligibility.read.ts` | none (only other deleted harness files) | deleted |

### API capture setup scripts (`apps/api/scripts/`)

| File | Importers on origin/main (outside the deleted set) | Disposition |
| --- | --- | --- |
| `apps/api/scripts/meri-capture-provider-budget.mjs` | none (only other deleted harness files) | deleted |
| `apps/api/scripts/meri-case01-setup-dependencies.mjs` | none (only other deleted harness files) | deleted |
| `apps/api/scripts/meri-case01-setup.mjs` | none (only other deleted harness files) | deleted |
| `apps/api/scripts/meri-case12-setup-native.mjs` | none (only other deleted harness files) | deleted |
| `apps/api/scripts/meri-case12-setup-plan.mjs` | none (only other deleted harness files) | deleted |
| `apps/api/scripts/meri-case14-recall-setup.mjs` | none (only other deleted harness files) | deleted |
| `apps/api/scripts/meri-case46-setup.mjs` | none (only other deleted harness files) | deleted |
| `apps/api/scripts/meri-controlled-read-setup.mjs` | none (only other deleted harness files) | deleted |
| `apps/api/scripts/meri-operator-json-input.mjs` | none (only other deleted harness files) | deleted |
| `apps/api/scripts/meri-pending-memory-setup.mjs` | none (only other deleted harness files) | deleted |
| `apps/api/scripts/meri-synthetic-read-budget.mjs` | none (only other deleted harness files) | deleted |

### Orchestrator harness modules

| File | Importers on origin/main (outside the deleted set) | Disposition |
| --- | --- | --- |
| `meri/controlled-read-observations.ts` | `meri/api-tool-executor.repo.ts` (edited); `meri/meriv3/meriv3-assistant.service.ts` (edited) | deleted |
| `meri/meri-capture-provider-wire.ts` | `meri/meriv3/meriv3-run-budget.ts` (edited); `meri/meriv3/openai-responses.client.ts` (edited); `meri/request-scoped-llm.client.ts` (edited) | deleted |
| `meri/meriv3/meriv3-capture-evidence.ts` | `meri/meriv3/meriv3-assistant.service.ts` (edited); `meri/meriv3/meriv3.controller.ts` (edited) | deleted |
| `meri/meriv3/meriv3-capture-provider-budget.ts` | `meri/meriv3/meriv3-assistant.service.ts` (edited) | deleted |
| `meri/meriv3/meriv3-governed-artifact-budget.ts` | `meri/meriv3/meriv3-assistant.service.ts` (edited) | deleted |

### Repo scripts and workflows

| File | Importers on origin/main (outside the deleted set) | Disposition |
| --- | --- | --- |
| `.github/workflows/meri-synthetic-cohort.yml` | none (only other deleted harness files) | deleted |
| `.github/workflows/meri-synthetic-fullchat.yml` | none (only other deleted harness files) | deleted |
| `.github/workflows/meri-synthetic-governance.yml` | none (only other deleted harness files) | deleted |
| `scripts/meri-synthetic-cohort.py` | none (only other deleted harness files) | deleted |
| `scripts/meri-synthetic-fullchat.py` | none (only other deleted harness files) | deleted |
| `scripts/meri-synthetic-governance.mjs` | none (only other deleted harness files) | deleted |

Deleted specs, tests and spec helpers outside `evals/meri/live-v1/` that only exercised the files above: 50. The script and workflow rows were reachable only through each other (each workflow ran its same-named script).

The API operator scripts have no import-graph importers; they were reachable only through `apps/api/scripts/entrypoint.sh` verbs (`meri-case46-setup`, `meri-pending-memory-setup`, `meri-case01-setup`, `meri-synthetic-read-budget`, `meri-capture-provider-budget`, `meri-case12-setup-plan`, `meri-case12-setup-native`, `meri-case14-recall-setup`; all eight removed) and they `require` the deleted modules from `dist/` or load `evals/meri/live-v1/fixture-provisioning/*`. `meri-controlled-read-setup.mjs` had no verb and was run by hand.

### Evals, repo scripts and workflows

| Path | Reachable from | Disposition |
| --- | --- | --- |
| `evals/meri/live-v1/` (249 files after the two moves below) | `apps/api/Dockerfile` (six `COPY` lines for the Case01 restart graph), the deleted API scripts, `package.json` `capture:meri-live-read`, and `evals/meri/simple/{run-cases,regrade,review-export}.mjs` (`../live-v1/cases.mjs`) | deleted; Dockerfile `COPY` lines and the `package.json` script removed |
| `evals/meri/live-v1/cases.mjs` | `evals/meri/simple/run-cases.mjs`, `regrade.mjs`, `review-export.mjs` | moved to `evals/meri/simple/original-cases.mjs`; its only import (`FIXTURE_VERSION` from `fixture.mjs`) is inlined with the same value; the three runners import it from there |
| `evals/meri/live-v1/contract.types.d.ts` | JSDoc `@typedef` in `cases.mjs` | moved to `evals/meri/simple/contract.types.d.ts` |
| `scripts/meri-synthetic-{cohort,fullchat,governance}*` (7 files) | only `.github/workflows/meri-synthetic-{cohort,fullchat,governance}.yml` | deleted with the three workflows |
| `evals/meri/simple/`, `evals/meri/commitments-deliverables/`, `evals/meri/runtime/` | product evals | kept; no other `live-v1` import in any of them |

`scripts/validate-meri-build-isolation.py` and `scripts/validate-meri-orchestrator-build-only.py` do not enumerate the deleted paths (one comment named `meri-synthetic-fullchat.py` and was updated). Both validators pass after the change.

## Product files edited

Each edit removes a call whose ordinary-path result was a no-op (`null` policy, `undefined` accounting, unchanged input). V3 turns without a capture policy run the same code as before.

| File | What was removed |
| --- | --- |
| `apps/api/src/meri/meri-context-plane-runtime.ts` | Capture/Case46 policy issuance, semantic clock, provider-budget admission, provider scopes, current-authority re-reads, and the capture fields of the runtime state. `runChatTurn` now resolves the Context Plane and runs the turn. |
| `apps/api/src/meri/meri-context-plane.service.ts` | `MeriToolCompilerCapture`, the semantic-clock / Case12 binding branch in `searchToolData`, `now` / `semanticClock` in `resolveChat` and `resolve`, and the capture retrieval-plan assertion. |
| `apps/api/src/meri/meriv3-proxy.service.ts` | Capture output fence, policy turn binding, provider-budget admit/finish, capture evidence receipt persistence, receipts on `done` frames and assistant rows, Case46 input/turn/receipt checks, and the capture guards on attachment re-extraction and after-turn maintenance. |
| `apps/api/src/meri/meri-tools.service.ts` | Capture budget tool gate, provider scope, Case12 binding checks, controlled-read fixture dispatch, current-authority re-reads, memory capture-source signing and clock packets in `search_memory`, and the Case46 artifact check in `persistArtifact`. |
| `apps/api/src/meri/meri.service.ts` (V1, deleted later in §4.3) | Capture imports and branches only: readback/admission enrichment in `getConversation` and `listMessages`, the capture prelude, fence and receipts in `streamMessage`, API capture observations, evidence receipt persistence and the capture guards on metering, claims, learning and maintenance. Historical Case46 rows keep their signed transport server-side through a local `publicConversationMetadata` that drops that one key. |
| `apps/api/src/meri/meri.controller.ts`, `meri-action-proposal.controller.ts` | Capture/Case46 transport admission on `POST tools/:name` and `POST action-proposals`, and the controlled-read HTTP status override. |
| `apps/api/src/meri/meri-action-proposal.service.ts` | Case46 proposal authority on create/approve, the Case46 preview marker, and the capture-policy expiry clamp. |
| `apps/api/src/meri/meri-tool-request-control.ts`, `meri-memory-proposal-read.ts`, `meri-data-search.helpers.ts` | Capture policy and memory capture request plumbing. |
| `apps/api/src/meri/meri-source.service.ts`, `meri-source.controller.ts` | The `controlled_read` source kind. |
| `apps/api/src/meri/meri.module.ts` | `MeriCaptureProviderBudgetController`, `MeriFeedbackFixtureService`, `MeriCase01FixtureBootstrapProvider` and the `CASE46_AUTHORITY_DEPENDENCIES` provider. |
| `apps/api/src/meri/meriv3-chat.client.ts` | `serverCaptureEvidenceObservation` on the V3 `done` frame type. |
| `apps/api/src/embeddings/titan-embedding.provider.ts`, `reranking/nvidia-reranking.provider.ts`, `memory/memory-candidate.service.ts` | Capture and Case12 setup provider-scope wrappers; each provider now runs its ordinary request path only (providers kept). |
| `apps/api/src/memory/memory-review-inbox.service.ts`, `governed-memory-candidate.service.ts`, `memory-proposal.controller.ts` | Case14 / pending-memory fixture evidence on the review detail and own-proposal list. |
| `apps/api/src/engagement/engagement.service.ts` | The Case46 synthetic source-indexing branch in `createAttachmentFromBuffer` (always false outside the deleted operator). |
| `apps/meriv2-orchestrator/src/meri/meriv3/meriv3-assistant.service.ts` | Capture/Case46 provider accounting, tool-surface filters, capture execution observation, `captureEvidence` on the result, Case46 export guard, controlled-read invocation wrapper, and the capture guards on shadow work, metering and audit persistence. |
| `apps/meriv2-orchestrator/src/meri/meriv3/meriv3.controller.ts` | Capture policy validation, the capture `read-only` override, signed capture evidence and receipts on `done`, and capture fields in the trusted turn scope. |
| `apps/meriv2-orchestrator/src/request/trusted-current-turn-scope.ts` | `capturePolicy` / `governedArtifactPolicy` and their accessors and validators. |
| `apps/meriv2-orchestrator/src/meri/{api-tool-executor,api-action-proposal}.repo.ts`, `meriv3/api-managed-mcp.repo.ts` | Capture transport headers, controlled-read and clock observation, and capture / Case46 denials. |
| `apps/meriv2-orchestrator/src/meri/meriv3/{openai-responses.client,meriv3-run-budget}.ts`, `request-scoped-llm.client.ts` | Capture provider-wire request rewriting (`service_tier`, `redirect: 'error'`, budgeted wire fetch). Identity when capture was inactive. |
| `apps/meriv2-orchestrator/src/meri/meriv3/meriv3-clean-assistant.service.ts`, `meriv3.types.ts` | Case46 exact-export bypass and the `captureEvidence` result type. |
| `apps/meriv2-orchestrator/src/meri/chat/{chat-assistant.service,chat.controller}.ts` (V2, deleted later in §4.3) | Capture checks only, so the shared turn-scope type compiles. |

## Left in place (harness-adjacent, not on the turn path)

- `packages/meriv2-core` capture modules (`server-readonly-capture`, `capture-evidence-receipt`, `governed-artifact-capture`, `memory-capture-source`, `case12-setup-binding`, `synthetic-read-budget`, `MERI_CASE46`) and the optional capture fields on `MeriGovernedTurnContext`. Per the brief, core is untouched; these exports now have no app caller.
- `apps/api/src/memory/synthetic-*.helpers.ts` and `engagement/synthetic-document-deletion.helpers.ts`: synthetic-fixture guards inside memory and engagement services, gated on `MERI_SYNTHETIC_FIXTURE_NAMESPACE`. Not capture code and not on the Meri turn path; candidates for a later cleanup.
- `apps/api/src/meri/meri-memory-content.helpers.ts` `captureSourceOwner` option and `apps/api/src/embeddings/client-kb.service.ts` `indexAttachmentIfEnabled`: no caller passes the capture value any more; harmless.
- `apps/web/src/vnext/meri/meri-source-api.ts` still accepts a `controlled_read` source kind. The API now rejects that kind with 400; only controlled-read fixture conversations (Cases 20 to 27 and 72) ever produced it.
- `apps/meriv2-orchestrator/src/meri/meri-governed-context.runtime.ts` prompt clock (`currentMeriPromptClockUse`): it reads `semanticClock` from the signed governed context, which the API no longer sets.
