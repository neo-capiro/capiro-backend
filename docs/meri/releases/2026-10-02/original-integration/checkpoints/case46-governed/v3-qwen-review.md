I've gathered context on the implementation requirements but haven't created the files yet. Due to tool iteration limits, here's what I found and what needs to be done:

**Policy reference:** commit 39590a3bfc57ce03b0411ff7912a7c8d99deb70c in `C:\dev\capiro-agent-ops`

**Files to create (exactly as specified):**

1. `C:/dev/cap-meri-doc-fidelity/apps/meriv2-orchestrator/src/request/trusted-current-turn-scope.ts` - ADD separate governedArtifactPolicy field and `currentGovernedArtifactCapturePolicy()` method that validates actor/conversation/client and rejects both capabilities when present, returning null if absent. Keep existing readonly behavior.

2. `C:/dev/cap-meri-doc-fidelity/apps/meriv2-orchestrator/src/meri/api-action-proposal.repo.ts` - UPDATE to read new scope, validate exact original case46 toolinput, conversation, canonical write, add signed purposeaction_proposal header, preserve readonly denial.

3. `C:/dev/cap-meri-doc-fidelity/apps/meriv2-orchestrator/src/meri/meriv3/meriv3-governed-artifact-budget.ts` (NEW) - New `governedArtifactProviderAccounting(args)` matching existing meriv3-capture-provider-budget interface, undefined if no policy, require exact valid bound policy, bearer/service credentials, reject impersonation, encode ONLY separate governed header, same existing reservations/settlements routes.

4. `C:/dev/cap-meri-doc-fidelity/apps/meriv2-orchestrator/src/meri/meriv3/meriv3-governed-artifact-budget.spec.ts` (NEW) - Focused spec demonstrating separate header/purpose, actor/tool mutation denial, failed/uncertain settlements, no bearer/impersonation refusal.

**Key constraints:**
- Do NOT add case46 to readonly policy
- Do NOT touch core types, controller, assistant, API, existing test files
- Do NOT fetch/change branches or commit
- Use ABSOLUTE paths in edits
- Preserve other agent work in worktree
- No cloud/API/browser/provider execution, installs, config changes

The core type definitions are in `packages/meriv2-core/src/context/governed-artifact-capture.ts` with:
- `MeriGovernedArtifactCapturePolicy`
- `MERI_GOVERNED_ARTIFACT_HEADER = 'x-meri-governed-artifact-capture'`
- `encodeMeriGovernedArtifactTransport(policy, 'provider_budget'|'action_proposal', secret)`
- `validateMeriGovernedArtifactPolicy(policy, {tenantId,actorUserId,conversationId,clientId})`
- `assertMeriCase46ToolInput(policy, tool, input)`

I was blocked on accessing the full `meriv3-run-budget.ts` interface to match the accounting pattern, and haven't started writing implementation files yet.