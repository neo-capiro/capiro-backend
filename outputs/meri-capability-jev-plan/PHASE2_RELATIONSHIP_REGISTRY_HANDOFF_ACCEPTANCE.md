# Phase 2 relationship registry handoff — acceptance

Base: `dae05afb765e68b0d5e4205c81386974e0b14ae2` (accepted integration head)

## Change

`apps/meriv2-orchestrator/src/meri/meriv3/meriv3-retrieval-relationship.ts` now recognizes the actual native API lookup shape `existingClient.id` in addition to the recipe’s existing row-based ID paths. It accepts only a non-empty trimmed string. No tool IDs, schema, gateway support, permissions, or API handlers changed.

With a valid native existing-client ID, shared relationship mode passes that ID to exactly these existing conditional readers: `get_client_context`, `search_client_knowledge`, `query_debriefs`, `query_tasks`, and `query_outreach`. Existing API/orchestrator authorization and tenant scope remain in the delegated handlers; this patch only hands off the already tenant-scoped ID from `lookup_client_registry`. Mail-history-focus still skips all five. An optional reader error remains represented in `diagnostics.optionalSourceFailures` and does not fail the recipe.

## Regression evidence

The focused recipe spec now uses the API-native response shape (`existingClient`, `ldaExactMatch`, `ldaCandidates`, `guidance`) and verifies the five calls receive `client-v6`. Additional cases verify no fan-out for a null/no existing client, an ambiguous LDA candidate without an existing Capiro client, and a whitespace-only malformed ID. A companion case proves valid `existingClient.id` still does not fan out in mail-history-focus. The native-shape test also returns an optional task-reader error and verifies it is preserved in `optionalSourceFailures`.

API source inspected: `apps/api/src/meri/meri-tools.service.ts`, `lookupClientRegistry` (around lines 7544–7610), which uses tenant-scoped client lookup and returns the `existingClient` object. The orchestrator continues to call the pre-existing governed native tools with the resulting `clientId`; no tenant or permission check was bypassed or broadened.

## Verification

- Focused serial Jest: `pnpm --filter @capiro/meriv2-orchestrator exec jest --runInBand src/meri/meriv3/meriv3-retrieval-recipes.spec.ts` — 1 suite, 11 tests passed.
- `pnpm --filter @capiro/meriv2-orchestrator typecheck` passed.
- `pnpm --filter @capiro/meriv2-orchestrator build` passed.
- `git diff dae05afb765e68b0d5e4205c81386974e0b14ae2..HEAD --check` passed after commit.
- Fresh worktree dependency artifacts (workspace package builds and local Prisma client generation) were created only for verification; no tracked generated files were changed.
- No production access, deployment, or external writes.

## Residuals

The recipe still has its existing limited mailbox-only coverage manifest and does not provide a complete ledger for the optional client readers. This patch preserves that behavior; the task-specific regression confirms optional failure reporting but does not claim complete source coverage. Existing client-reader permission/tenant enforcement remains in its underlying tools and should continue to be covered by their handler tests.

Implementation commit SHA: pending.
