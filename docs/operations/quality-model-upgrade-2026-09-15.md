# Text model upgrade — September 15, 2026

The application now uses **GPT-6 Astra (`gpt-6-astra`)** for previous GPT-4.1,
GPT-4o, GPT-mini and GPT-5 text workloads, and **Claude Sonnet 5
(`claude-sonnet-5`)** for previous Claude Sonnet and Haiku workloads.

## Behavior

- The shared model policy applies to platform defaults, recognized legacy
  environment settings, tenant overrides, saved Outreach conversations and
  provider request bodies. API-key ownership and provider ordering are preserved.
- Existing Opus overrides and custom deployment names remain available.
- Meri's Fast, Standard, Deep and Max modes use GPT-6 Astra with their existing
  low, medium, high and max effort levels and investigation budgets.
- Briefing generation no longer substitutes a mini/Haiku model for the selected
  model. The admin model picker offers GPT-6 Astra and Sonnet 5.
- Embeddings, transcription, document parsing and reranking keep their dedicated
  models. Historical usage and pricing records keep their original identifiers.

## Compatibility

- GPT-6 requests omit unsupported sampling/log-probability parameters. Missing,
  `none` or `minimal` effort becomes `low`; explicit supported effort is retained.
  Existing output ceilings receive reasoning headroom. The shared OpenAI tool
  adapter sends GPT-6 requests through Responses and preserves tool call IDs,
  arguments, results and usage in the existing application contract. Stateless
  tool rounds replay encrypted provider state and assistant phase unchanged;
  that opaque state is excluded from Anthropic failover requests and visible text.
- Sonnet 5 requests omit sampling controls and replace manual thinking with
  adaptive thinking. Output budgets allow for thinking plus visible text.
  Forced schema/tool responses explicitly disable incompatible implicit thinking.
- Claude response parsing selects text blocks by type. Streamed thinking and
  signature blocks remain intact for subsequent tool rounds and are excluded
  from visible text deltas.
- Shared cost estimates include GPT-6 Astra ($10/$50 per million input/output
  tokens) and Sonnet 5 ($2/$10). The existing estimator does not model cache
  discounts, long-context premiums or every provider billing adjustment.

## Validation and rollout

Provider-model retrieval checks returned HTTP 200 for both platform credentials
and all six active tenant credentials. These were metadata reads; they did not
generate text or send customer messages.

Regression coverage captures outgoing request bodies, schema output, tool-call
continuity, tenant credential isolation, effort profiles, streaming thinking
replay and existing generation failures. Rollout requires new API, Engagement
API, Meri orchestrator, Workspace and web-vNext images plus updated model
environment values. Public UI deployment targets os.capiro.ai.

Sources: [GPT-6 migration](https://developers.openai.com/api/docs/guides/latest-model/gpt-6-astra),
[GPT-6 model](https://developers.openai.com/api/docs/models/gpt-6-astra),
[Sonnet 5 migration](https://platform.claude.com/docs/en/models/sonnet-5/migration-guide),
[Claude effort](https://platform.claude.com/docs/en/build-with-claude/effort).
