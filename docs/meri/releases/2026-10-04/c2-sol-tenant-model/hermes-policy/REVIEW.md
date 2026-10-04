# Independent review: exact `gpt-6.1-sol` support

## Verdict: qualified pass

I found no source-level blocker in the copied evidence for exact Sol routing, Responses normalization, continuation-state handling, output-token bounds, tenant override selection, or the legacy price estimate. This is a static review of the supplied files, not provider inference proof. I did not run tests or contact a provider (per scope); the focused/core test results below are root-reported, not independently verified here.

## Review notes

- **Routing and fallback boundary:** `packages/shared/src/ai-model-policy.ts` recognizes only the exact `gpt-6.1-sol` identifier (not dated lookalikes) as GPT-6, while `upgradeTextModel` leaves it unchanged and the global default remains `gpt-6-astra`. `packages/meriv2-core/src/llm/openai-responses-adapter.ts` therefore sends it to `/v1/responses`; non-GPT-6/custom models keep the existing Chat Completions route. In the orchestrator client, retries and reasoning-parameter corrections retain the resolved model; I found no provider/model fallback from Sol to Astra.
- **Request normalization:** the shared final wire guard strips sampling/log-probability fields, removes `message.output_text.logprobs`, replaces legacy `prompt_cache_retention` with `prompt_cache_options.ttl = '30m'`, and normalizes unsupported/missing Sol effort to a supported value (medium for absent/unknown; low for `none`/`minimal`). Supported `low`, `medium`, `high`, `xhigh`, and `max` are preserved. This matches the provider constraints supplied in the review brief.
- **Continuation and tool flow:** the adapter serializes GPT-6 tool calls through Responses and carries returned output items back as opaque assistant state on the next round. Anthropic preparation filters that OpenAI-only state. The provided core test exercises two mocked rounds, including encrypted state, assistant phase, tool output, and exact Sol; it does not establish live provider acceptance.
- **Output bound:** the shared normalizer raises the Astra bound to its existing 8192 floor but deliberately does not raise exact Sol's caller-provided `max_output_tokens`. The orchestrator reserves the post-normalization wire ceiling, so its reservation tracks any policy adjustment. The Sol-focused unit test asserts preservation at 2048; the orchestrator's existing low-profile-bound test covers Astra's floor behavior.
- **Tenant selection:** orchestrator selection uses the explicit model override only when the request actually used a tenant OpenAI key and `modelOverridden` is true; otherwise it uses the resolved profile model, not the resolver's incidental model field. The existing orchestrator test covers the boolean selection rule with generic model names, but not the exact Sol identifier end-to-end (see finding).
- **Pricing:** the shared price table includes exact Sol at the stated standard input/output rates. The legacy estimate intentionally does not apply cache discounts; the long-context multiplier is applied to the full input and output only when input is strictly greater than 272,000 tokens. Root-reported pricing tests cover the boundary and stale unknown-model zero case. This review does not verify provider billing or the separate governed-capture rate contract.

## Finding (non-blocking; coverage)

**P2 — Add one orchestrator-level regression for an explicit tenant Sol override.** The exact-Sol route/normalization and encrypted multi-turn behavior are covered in core, and the orchestrator has generic override-selection coverage, but the supplied `openai-responses.client.spec.ts` has no case proving those decisions compose in the production orchestrator client for Sol. This leaves a wiring regression (for example, the explicit-override gate or final prepared body) undetected by the focused tests.

Minimal fix: extend the existing orchestrator Jest spec—no new framework—with a mocked `global.fetch` and `RequestCredentialsStore.run` using `provider: 'openai'`, `usedTenantKey: true`, `modelOverridden: true`, and `model: 'gpt-6.1-sol'`. Assert the request is to the Responses endpoint, the wire model is exactly Sol, a deliberately small configured `max_output_tokens` remains unchanged and is the value reserved by `MeriRunBudget`, and returned telemetry records the requested/effective model appropriately. A paired `modelOverridden: false` assertion can ensure the resolver default still wins. This is a test recommendation, not an observed runtime defect.

## Evidence reviewed

- `evidence/packages/shared/src/ai-model-policy.ts`
- `evidence/packages/shared/src/index.ts` (pricing and estimator)
- `evidence/packages/meriv2-core/src/llm/openai-responses-adapter.ts`
- `evidence/packages/meriv2-core/src/llm/llm-client.ts`
- `evidence/packages/meriv2-core/src/llm/quality-model-upgrade.spec.ts`
- `evidence/apps/meriv2-orchestrator/src/meri/meriv3/openai-responses.client.ts`
- `evidence/apps/meriv2-orchestrator/src/meri/meriv3/openai-responses.client.spec.ts`
- `evidence/apps/api/src/ai-usage/ai-model-policy.sol.spec.ts`

Root-reported execution: 10 focused policy/pricing tests and 36 core tests passed, including mocked multi-turn Responses/state coverage for Astra and Sol. Not run or independently confirmed in this review; not evidence of live provider inference.

## Limitations

The bundle does not include every imported orchestrator dependency (including reasoning-profile and capture-wire implementation files), so I reviewed their call sites and stated behavior only where visible in the supplied client/spec. Official documentation claims and published rates are taken from the user-provided review brief, not independently fetched or revalidated here.