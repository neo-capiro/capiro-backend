# Stage 1b: paired claim-support shadow

Stage 1b observes MeriV3 chat answers only after their text event has been emitted. It never holds, delays, rewrites, or changes an answer, and a shadow result never triggers retrieval or any other tool call. `enforce` intentionally remains shadow-only in Stage 1. `cascade` behaves as paired until a later stage defines calibrated cascade policy.

## Flow and controls

`MERI_CLAIM_ASSESSMENT_MODE|_TENANTS|_SURFACES` enables the post-release inventory. The legacy skeptic always uses the orchestrator's existing request-scoped BYOK LLM client. Jev is additionally constructed only when its config is available, `MERI_JEV_PROVIDER_MODE` enrolls the tenant and chat surface, `MERI_CHAT_EVIDENCE_JUDGE` is `jev`, `paired`, or `cascade`, and `MERI_JEV_TASKS` contains `claim_support`.

The released material claims are ordered with document-specific and `DEFAULT_HIGH_RISK_CATEGORIES` claims first, uncited claims second, and all remaining claims last. Each claim receives the same bounded evidence envelope and `claim_support.v1` question for both providers. Exact-source failures become `document_unavailable` without a provider call. Provider errors are operational decisions and cannot fail chat.

The per-turn limits are 12 claims, 60,000 estimated input tokens, and one shared 6,000 ms deadline. Client cancellation is chained into the shared deadline signal. A slow provider therefore does not delay the already-emitted answer and receives cancellation when the request disconnects or the shadow deadline expires.

## Logs

One `meri.evidence_shadow` event per selected claim contains conversation and turn ids, claim identity/kind/category, evidence-envelope hash, exact-source eligibility, normalized Jev and legacy decisions, agreement, and proposed actions. Each normalized decision contains outcome or failure state, confidence, probabilities, reason codes, model, question version, latency, and input tokens.

One `meri.evidence_shadow.turn` event contains selected/skipped counts, budget exhaustion, duration, input tokens, estimated Jev input cost at $0.042 per million tokens, and a deterministic ten-percent `sampled` flag. Sampling includes agreements so later review is not disagreement-only.

## Proposed actions

| Decision | Proposed action |
| --- | --- |
| `supported` | `retain` |
| `insufficient_evidence` | `retrieve_missing_evidence` |
| `conflicting_evidence` | `retrieve_and_compare` |
| `contradicted` | `qualify_or_omit` |
| operational failure | `none:failure` |

High-risk conflicting evidence maps to `compare_authority_scope_dates`; other conflicts map to `retrieve_and_compare`. Stage 1 records but never executes either proposed action.

## Development recording

Set `MERI_JEV_RECORDING_PATH` to a local JSONL path to wrap both live providers in `RecordingDecisionProvider`. Each append contains only envelope-derived request state/questions and the normalized response; the store rejects authorization, bearer, and API-key material. Production must leave `MERI_JEV_RECORDING_PATH` unset. The file is for authorized development review and replay, not a production telemetry sink.