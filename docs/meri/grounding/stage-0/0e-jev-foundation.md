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

## Next step

T12 adds deterministic envelope construction, replay tooling, and fixture generation. It does not make this provider user-visible by itself.
