# Phase 2 relationship recipe variants — acceptance

Base: `f4ba717f0cc35095b902bef0ebc8e94b2f263c81` (accepted combined Phase 2 integration head)

Package scope: distinguish the model-facing intents `relationship_brief`, `mail_history`, and `meeting_prep` while preserving their existing shared `query_relationship_brief` recipe, tool IDs, permissions, and runtime behavior. This patch adds only advisory metadata, a truthful recipe description, and parity/regression tests.

## Evidence and contract

- `packages/shared/src/meri-skills.ts` defines the three distinct skill IDs, domains, and starter prompts. All three use `query_relationship_brief`; their promised domains differ, especially Meeting Prep’s meeting/action/outreach/legislation scope.
- `apps/meriv2-orchestrator/src/meri/retrieval/meri-retrieval-plan.ts` (`MAIL_HISTORY_RE`, `buildMeriRetrievalPlan`) classifies request text, not `skillId`. The whole-prompt heuristic gives all three current starter prompts `mail-history-focus`; tests capture this observed behavior. It is not a reliable variant identity signal and Meeting Prep has no dedicated discriminator.
- `apps/meriv2-orchestrator/src/meri/meriv3/meri-semantic-tool-gateway.ts` selects recipe-support schemas using `mail-history-focus` or the shared recipe. Topic/action rules may expose additional schemas. Schema exposure is not proof of invocation or permission. The contract records the recipe-default and mail-focus support sets separately.
- `apps/meriv2-orchestrator/src/meri/meriv3/meriv3-retrieval-relationship.ts` invokes email search, contacts, memory, and client-registry lookup for a resolved target; it may perform bounded email follow-ups (up to three participant identifiers and four subjects). In shared mode it conditionally adds client context, client knowledge, debrief, task, and outreach readers only if its client-ID extractor finds an ID. Mail-history-focus skips these client-specific reads.
- The actual API `lookup_client_registry` handler is `apps/api/src/meri/meri-tools.service.ts` (`lookupClientRegistry`, around line 7544) and returns `existingClient`, `ldaExactMatch`, `ldaCandidates`, and `guidance`. The recipe extractor scans result rows for top-level `id`/`clientId` or `client.id` (`meriv3-retrieval-relationship.ts`, around line 106), not `existingClient.id`. A new test models the native payload and confirms it does not trigger the client-specific fan-out. This is an observed existing integration mismatch, not fixed here because fixing it would change runtime behavior.
- The recipe does not call upcoming-meeting/calendar readers, full-document readers, `search_research_sources`, legislative readers, public-web/federal-market readers, or the email-thread reader. The mailbox coverage manifest describes email health/pagination only; it does not establish completeness of other sources or skill domains.
- API search/email handlers remain the existing delegated native tools in `apps/api/src/meri/meri-tools.service.ts`; no API runtime or schema was changed in this package.

The machine-readable `MERI_RELATIONSHIP_RECIPE_VARIANT_CONTRACT` and model-facing description in `apps/meriv2-orchestrator/src/meri/meriv3/meriv3-retrieval-recipes.ts` preserve separate intent domains while explicitly recording the shared recipe, request-text heuristic, source boundaries, registry-shape mismatch, gateway support, and mailbox-only coverage. No claim is made that every skill source is queried or complete.

## Verification

- Focused serial Jest: `pnpm --filter @capiro/meriv2-orchestrator exec jest --runInBand src/meri/retrieval/meri-skill-registry-routing.spec.ts src/meri/meriv3/meriv3-retrieval-recipes.spec.ts src/meri/meriv3/meri-semantic-tool-gateway.spec.ts` — 3 suites, 56 tests passed.
- Orchestrator typecheck and build passed after generating the worktree-local Prisma client required by the API dependency. The Prisma generation was local only.
- `git diff --check` passed before report creation; final base-to-head diff check is recorded with the commit.
- No production access, deployment, or external writes.

## Residuals / recommendation

Do not silently route by inferred skill identity: the planner does not receive the selected skill ID, and current starter prose triggers the mail-history regex across all three variants. A proper Meeting Prep / broad Relationship Brief distinction requires an explicit semantic design and likely runtime change. The native client-reader handoff is not accepted as continuous: current API-shaped lookup evidence does not reach client-specific readers. A bounded follow-on fix is to extend `clientIdFrom` to recognize `result.existingClient.id` (only when it is a non-empty string), add an API-shape regression expecting all five conditional client readers in shared mode, and retain a companion assertion that `mail-history-focus` still skips them. Then verify scope/tenant behavior through the existing delegated handlers and report any optional-reader failures as partial evidence. Separately, extend coverage to non-mail source health and make answer limitation guidance account for optional-source failures. None of these runtime changes are included here.

Commit SHA: pending.
