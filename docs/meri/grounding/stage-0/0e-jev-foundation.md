# Stage 0e: isolated Jev provider foundation

Stage 0e adds a dependency-injected TypeSafe/Jev client and a provider-neutral evidence-decision contract in `@capiro/meriv2-core`. It is dark in production: no chat, editor, workspace, strategy, research, outreach, memo, district-brief, or steward code path constructs or calls this client.

## Architecture and isolation

- The client uses injected `fetchImpl` (defaulting to `globalThis.fetch`) and is never instantiated at import time.
- Authentication is sent only as a bearer header. Request bodies containing the key are refused.
- Requests are bounded to 64 KB and responses to 1 MB. The client owns retries for network errors and HTTP 429/529 only, with deadline, timeout, cancellation, and `Retry-After` handling.
- Provider messages never include response bodies, request headers, or key material.
- `EvidenceDecision` separates evidence outcomes from operational failures. Provider output supplies probabilities and reason codes; the adapter never invents rationale.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `TYPESAFE_API_KEY` | empty | Secret-backed provider credential; presence only is validated/logged. |
| `MERI_JEV_MODEL` | `jev-1.13.0` | Pinned model. Moving aliases and non-versioned values make Jev unavailable. |
| `MERI_JEV_TIMEOUT_MS` | `8000` | Per-attempt timeout, clamped to 500–30000 ms. |
| `MERI_JEV_MAX_ATTEMPTS` | `2` | Total attempts, clamped to 1–3. |
| `MERI_JEV_PROVIDER_MODE` | `off` | Rollout mode (`off`, `shadow`, `enforce`). |
| `MERI_JEV_PROVIDER_TENANTS` | empty | Canonical tenant UUID allowlist. |
| `MERI_JEV_PROVIDER_SURFACES` | empty | Assurance-surface allowlist. |
| `MERI_CHAT_EVIDENCE_JUDGE` | `llm` | Stage 1 routing contract: `llm`, `jev`, `paired`, or `cascade`. |
| `MERI_JEV_TASKS` | empty | Stage 1 task allowlist. |

`MERI_CHAT_EVIDENCE_JUDGE` and `MERI_JEV_TASKS` are validation-only in Stage 0. There is no master switch: provider rollout still requires mode, tenant, and surface selection, and no application integration exists yet.

## Failure mapping

Authentication, request rejection, exhausted rate/overload/network failures map to `judge_unavailable` with stable reason codes. Timeouts map to `timeout`, caller aborts to `cancelled`, response/schema errors to `malformed_response`, and tenant mismatch to `scope_refused` without a network call.

## Evidence envelopes

`buildEvidenceEnvelope` selects only ledger evidence named in the claim's `sourceIds`. It copies bounded passages, never documents: each passage is capped at 2,000 characters and the envelope at approximately 24,000 tokens using the conservative characters/4 estimate. Category, as-of date, and caller qualifiers are sorted deterministically. Any dropped or shortened evidence is listed explicitly in truncation metadata, and the schema-validated envelope receives a deterministic content hash.

## Recorded replay and paired evaluation

The JSONL replay store is append-only and keyed by envelope hash, question version, model, and provider. Each line contains the bounded request state/questions, raw response, latency, usage, and recording date; credentials and header-like key material are rejected. Replay misses are operational `not_checked` failures with reason `no_recording`, never network calls.

Run offline from the repository root:

`pnpm --filter @capiro/meriv2-core eval:jev-replay -- --store <recordings.jsonl> --output <directory>`

This writes deterministic `results.json` and a short Markdown summary. Live recording is intentionally restricted to an explicit `--live` invocation with both `TYPESAFE_API_KEY` and `MERI_JEV_PROVIDER_MODE=shadow`; no live run was performed in Stage 0.

## Fixture review

`stage0-claim-evidence-v1.json` contains synthetic, non-sensitive tuning and held-out cases. All enter as `humanReview.status: proposed`. A designated grounding/product reviewer must compare the claim, bounded passages, expected outcome, operational state, and one-sentence rationale; approval records the reviewer and review time and changes status to `approved` in a reviewed dataset revision. Fixture labels are evidence for evaluation, not automatic production policy. Thresholds are not selected until Stage 1.

## Stage 1 handoff

- Obtain human approval for fixture labels while preserving the tuning/held-out boundary.
- Perform an authorized shadow-only recording run and review the JSONL for data minimization.
- Compare Jev and legacy category/claim-kind results, latency, token use, and estimated cost.
- Select and document calibrated thresholds only after reviewing held-out results.
- Add application factories and rollout telemetry separately; the Stage 0 package remains outside all app answer paths.
- Provision `capiro/<env>/typesafe-api-key` before enabling `typesafeApiKeySecretEnabled` and deploying.
