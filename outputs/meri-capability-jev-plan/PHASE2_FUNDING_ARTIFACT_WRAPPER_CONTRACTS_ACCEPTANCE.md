# Phase 2 funding and artifact wrapper contracts — acceptance report

Date: 2026-09-25
Baseline: `06748f1ccdb87b285721d696d6f4551d208fd814`
Branch: `phase2/meri-wrapper-contracts-20260925`

## Scope and result

Audited `analyze_funding_opportunity` and `create_artifact` against Phase 2 of `IMPLEMENTATION_PLAN.md`. Added advisory, machine-readable wrapper contracts and truthful model-facing descriptions, plus focused schema/contract parity tests. Contracts remain separate from executable provider schemas and do not consolidate the artifact interface or change delegated runtime behavior.

The only execution/schema-surface change is a narrow funding schema exposure correction: `compare_funding_opportunities` and `build_opportunity_action_plan` are no longer suppressed merely because the funding wrapper exists; the wrapper does not call or replace them. `get_opportunity_client_context` also remains available for client-only use. The wrapper-invoked `explain_opportunity_match` and `get_opportunity_government_landscape` remain hidden as redundant schemas. This is not an authorization change.

## Verified behavior

`analyze_funding_opportunity` requires `clientId`, `source` (`grants_gov` or `sam_gov`), and `sourceRecordId`; its wrapper schema does not enforce UUID formats. It delegates in order to opportunity facts, client context, match explanation, and government landscape; SAM additionally calls the requirements reader. For Grants.gov, `requirements` is a notice-body continuation instruction, not extracted requirement evidence, while government landscape reports unsupported source. The returned aggregate preserves the individual subresults and includes requested-domain metadata and `toolsInvoked`; `requestedDomains` is not evidence that retrieval succeeded. Consumers must inspect source envelopes/statuses and actual invoked tools.

`create_artifact` accepts six distinct types and dispatches to six existing handler paths: `word` → `create_word`; `pdf` → `create_word` with `format: "pdf"`; `spreadsheet` → `create_excel`; `presentation` → `create_powerpoint`; `meeting_brief` → `create_meeting_brief`; `policy_memo` → `draft_policy_memo`. Its shared `spec` schema is only a generic object (`additionalProperties: true`); type-specific validation remains in the individual backing writers and handlers. PDF and DOCX are separate creations even though saved word specs can support either download format. Meeting brief can return an asynchronous preparation job. Policy memo requires a client and may compose from internal context/research when body is omitted; it preserves supplied body. Scope conflicts and artifact writes continue through existing wrapper/backing checks. There is no uniform approval contract or normalized receipt claimed here.

Both contracts record their effect/dependency/scope/availability boundaries as advisory metadata. Feature gates and tenant allowlists remain default-off and authoritative; the contracts do not assert that a gated capability is available to a caller.

## Validation

- Focused Jest: `src/meri/meriv3/meriv3-semantic-compatibility-tools.spec.ts` — 18 passed.
- `@capiro/shared` build — passed.
- `@capiro/meriv2-core` build — passed after shared build.
- `@capiro/shared` typecheck — passed.
- `@capiro/meriv2-orchestrator` typecheck — passed after generating the API Prisma client in this isolated worktree.
- `@capiro/meriv2-orchestrator` build — passed.
- `git diff --check` and `git show --check` — passed after correcting report whitespace.

## Residuals

- The generic artifact `spec` schema still cannot validate type-specific fields at model-schema level; validation remains delegated. Phase 2's shared-interface validation goal is therefore only documented/tested for current dispatch, not completed.
- Funding wrapper coverage is source-dependent and does not synthesize a uniform success/failure state. Grants requirement evidence and Grants government landscape remain unavailable from these calls as described above.
- No evidence supports uniform source freshness, complete retrieval, universal approval, or a single artifact receipt, so the contracts do not claim them.
- No production writes, deploy, migration, or external calls were performed.

## Correction notice

The earlier warning that `get_research_evidence` required an unrelated `to` field and omitted `sessionId` was a false positive and is explicitly withdrawn. It must not be propagated as a Phase 2 finding. The callable schema at the inspected `06748f1cc` baseline requires `sessionId`; that warning was not evidence about either wrapper in this report.
