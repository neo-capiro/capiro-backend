# Stage 1d: replay-only research and correction loop

Stage 1d implements the correction algorithm in `@capiro/meriv2-core` without connecting it to any application answer path. `MERI_AUTO_CORRECTION_MODE` defaults to `off`, enrollment defaults empty, and no `apps/**` module imports `repair/`.

## Flow

1. `deriveRequirement` maps an unsupported, contradictory, conflicting, unavailable, or stale decision to the matching required evidence-plan entry.
2. `planRemedy` chooses at most one concrete tool call. The supplied runtime registry must classify that tool `readOnly: true`; unknown and mutating tools fail closed.
3. The executor retrieves recorded evidence. Replay keys are SHA-256 of the tool name plus canonical arguments. A turn remembers failed dedupe keys and will not issue the same failed call again.
4. `reviseAffectedClaim` asks an injected generator for replacement text covering only the claim and deterministic dependents. Dependents are later sentences in the same paragraph that repeat a capitalized entity or numeric token from the claim. Returned citations must exist in the new ledger.
5. `recheckRevision` assesses the revised claim and sentence-level newly introduced material assertions through a `DecisionProvider`.
6. `assembleAnswer` accepts only revisions produced against the current monotonic ledger version. A late result from an older version is traced and discarded.

Cancellation is checked before and after every awaited retrieval, generation, and assessment. A cancelled run assembles no late revision.

## Shared budgets

A turn shares `maxPasses`, `maxToolCalls`, `maxMs`, and `maxInputTokens`. One pass is the normal default. A second pass is useful only after new evidence was obtained or a concrete different remedy route exists; an identical failed route is deduplicated. Exhausting a budget returns the unchanged supported content plus a claim-local limitation, not a generic refusal.

## Remedy selection

| Requirement | Remedy |
| --- | --- |
| missing document passage | `read_document_section` |
| primary-source fact | `query_primary_source` |
| structured official record | `inspect_structured_record` |
| unresolved person or organization | `resolve_entity` |
| contradiction or conflict | `fetch_comparison_source` |
| stale same-turn status | `refresh_status` |

The evidence plan provides tool families; the loop does not own a stale hardcoded tool allowlist. The app-side adapter supplies a registry lookup and an executor interface only. The loop never performs external writes.

## Proportional fallback policy

Exact amounts, percentages, years, dates, and numbered page/section claims are omitted when unresolved rather than guessed. Other unresolved claims receive one precise limitation attached to that claim. Missing transcript text is qualified without inventing a quotation and without demanding that the user upload it again. Conflicting sources are rechecked together; unresolved disagreement remains explicit rather than silently selecting a value.

## Stage 2 wiring

Stage 2 may connect the control to a reviewed live path, provide the application registry/executor adapter, and replace the fallback sentence extractor with S1-A's material-claim inventory. That work must retain cancellation, budgets, read-only classification, failed-call dedupe, and latest-ledger race protection. Stage 1 has no live caller.
