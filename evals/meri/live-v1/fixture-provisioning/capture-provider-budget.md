# Case01 provider-budget setup

This is operator setup for the approved synthetic case01 memory capture. It is not a live result, a source-authority substitute, or a production pricing default. Other cases and retrieval domains remain unsupported. The first run has an explicit maximum of USD 3 and one case at a time. A USD 30 cross-case ledger has not been implemented.

## Prerequisites and restart behavior

Deploy the reviewed API and orchestrator bridge together with the case01 current-source authority/transport and legacy-stream guard. The API registers `MeriCaptureProviderBudgetController` in `MeriModule`; its reservation/settlement routes require the existing JWT/internal-service guard plus a server-signed `provider_budget` policy. No browser-supplied rate or cap is accepted.

The API's `MeriCase01FixtureBootstrapProvider` registers the fixed source-owned fixture reader at startup. It lazily reconstructs the canonical owners from the persisted locator, so restarting the API does not require an in-memory fixture registration. The approved synthetic namespace and memory-governance cohort must satisfy their existing gates; this setup command changes neither flags nor cohorts. `MERI_SYNTHETIC_FIXTURE_NAMESPACE` must be `meri-foundation-20260928`. Existing database and internal-service credentials stay in the approved runtime environment. No provider/model/profile changes are needed.

Before budget installation, canonical case01 seed, predecessor retirement/reset, replacement seed, `captureEvidence` binding and `case01MemoryOwner` locator must be installed and currently qualified. Both fixture installers preserve `captureProviderBudget`. This installer preserves both of their fields and every unrelated tenant setting.

## Reviewed rate evidence

Provide the actual selected provider/model entries, including native retrieval, primary, JEV and repair providers that can dispatch. Missing entries reject before dispatch. The server never looks up a zero/default price. Rates must bound the provider's billable text-token units and any internal scored-pair encoding. Unsupported billing units cannot be marked qualified. A source URL or hash alone does not establish correct prices; the operator must review the referenced pricing and unit contract.

`rateEvidence` has the `ReviewedCaptureProviderRates` shape in `apps/api/src/meri/meri-capture-provider-budget-install.ts`: version 1, kind `meri-capture-reviewed-provider-rates`, priceKind `qualified_text_token_upper_bound`, ISO `observedAt` and `expiresAt`, the exact `rates` array, and per-model `sources` with kind/provider/model/HTTPS URL/unitContract. URLs must contain no credentials or query string. Each rate uses `inputMicrosPerMillion` and `outputMicrosPerMillion`; USD 10 per million input tokens is `10000000`. Native embedding/reranking entries require positive input pricing and zero output pricing.

`qualification` has version 1, caseId `01`, the current captureRunId and currentVerifySha256, exact `rateEvidenceSha256` from the exported `captureBudgetHash(rateEvidence)`, matching `rateEvidenceExpiresAt`, matching priceKind/rates, and explicit positive integer limits: maxAttempts <= 64, maxTokens <= 1000000, maxCostMicros <= 3000000. `rateEvidence.maxTokens` must equal the admitted maxTokens: a pricing sheet qualified for a smaller context tier cannot be combined with a larger token ceiling. The rate expiry must cover the full server policy lifetime (currently 30 minutes from issue), including a fresh policy after restart. No example rate values are installed automatically.

## Executable operation

The following commands run inside the approved built API task. The script is packaged automatically with `apps/api/scripts`; it constructs only the canonical read dependencies and does not bootstrap AppModule, scheduled jobs, a web server, provider clients, or projection workers.

```sh
node /app/apps/api/scripts/meri-capture-provider-budget.mjs plan --input /dev/shm/case01-budget-plan-input.json --out /dev/shm/case01-budget-plan.json
node /app/apps/api/scripts/meri-capture-provider-budget.mjs install --input /dev/shm/case01-budget-install-input.json --out /dev/shm/case01-budget-install.json
```

The plan input is `{target:"capiro-dev", fixtureNamespace:"meri-foundation-20260928", ctx, clientId}`. `ctx` is the existing standard-user synthetic actor's tenantId, tenantSlug, userId and clerkUserId; the fixed canonical owner verifies the actual tenant, membership, identity, client and sources. Never supply credentials in JSON.

The install input extends it with `qualification`, `rateEvidence`, and the exact four plan fences: `expectedCurrentVerifySha256`, `expectedCaptureBindingSha256`, `expectedPriorQualificationSha256`, `expectedTenantRowVersion`. Map these from the plan's currentVerifySha256, captureBindingSha256, priorQualificationSha256 and tenantRowVersion respectively. Any changed source, binding, prior qualification or tenant row rejects the operation. Each output path must be new. Preserve the receipt and actual exit code. An ambiguous process failure requires a fresh read-only plan/current readback; do not retry a write blindly.

The installer calls the actual fixed hydrated source owner inside the same transaction and locks the tenant. Its only write is `jsonb_set(settings_jsonb, '{meriFoundationFixture,captureProviderBudget}', qualification)`. It reads that value back and returns its hash and limit with `liveAcceptance: NOT_RUN`. It creates no model attempt, fixture, conversation, message or research run.

## Execution and receipts

Use a fresh owned conversation for each admitted capture; the immutable admission cannot be rebound to another request or user turn. Before context retrieval, the API creates the durable ledger in conversation metadata. Native Titan/NVIDIA reservations precede dispatch; retrieval is restricted to the client's institutional memory, and only `search_memory` is qualified. The actual persisted user message then binds the turn. The ordinary V3 common budget reserves each model attempt/retry/repair/JEV call without changing Standard/Deep profiles. Detached capture shadows and unsupported child actions remain suppressed by the existing capture policy.

Unknown price, missing bounds, stale evidence, duplicate dispatch, invalid identity and exhausted budgets fail closed. Missing usage leaves the full reservation charged and the signed receipt `UNSETTLED`; it does not become a successful cost proof. The final signed providerBudget contains actual admission/turn, current ledger and qualification hashes, charged attempts/tokens/micros, and the enforced maximum. The one provider-ledger logical effect is accounting, not a business mutation. The collector must join that exact effect and require its LIVE maxSpendMicros to equal the server maximum. Row locks serialize reservations; runner concurrency one and the single admitted conversation are separate required controls.

The immutable per-conversation ledger does not enforce a shared USD 30 aggregate across conversations. Full original evaluation acceptance remains NOT RUN until the release/source proofs, actual seed/reset/current-source readback, qualified rates, strict transport and resulting live artifacts all pass.
