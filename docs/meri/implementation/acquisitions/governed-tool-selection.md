# Governed tool selection acquisition (Foundation 7.1 / H4)

## Pinned source

- Project: Nous Research Hermes Agent
- Supplied local snapshot root: `C:/dev/cap-meri-foundation-evidence/upstream/hermes-agent/516535b54275e963a82b4c28f866338fb768e7bc`
- Commit: `516535b54275e963a82b4c28f866338fb768e7bc`
- Files read:
  - `tools/tool_search.py`
  - `tools/tool_search_catalog.py`
  - `tools/tool_search_validation.py`
- License: MIT; attribution and license text are retained in `THIRD_PARTY_NOTICES`.

## Reused concepts

The implementation is a native TypeScript, concept-level adaptation, not a copy or port of the Python bridge. The three pinned files were read directly from the supplied snapshot; the separately installed Hermes checkout at `9fc7f17906eab1dd81ddfdf8a1edeecac1e79940` was not the acquisition source.

1. Build from the live request-scoped tool definitions. Hermes rebuilds its deferred catalog from the current tool definitions rather than retaining a drifting session catalog. Meri selects only from the authoritative `full_chat` API schemas after tool-policy and research-lease filtering.
2. Preserve ambient required tools. Hermes keeps core/direct-surface tools visible. Meri pins exact capabilities required by its evidence, document, coverage, governed-context, and trusted server-authored procedure inputs when those names remain authorized.
3. Exact-name scope intersection. Hermes limits deferred invocation to names in the pre-assembly session scope. Meri intersects every selected, protected, or fallback name with the already-authorized API schema surface and repeats the exposed-schema check before dispatch.
4. Unknown names do not execute. Hermes distinguishes directly listed, deferred, and unknown names and rejects invalid bridge calls. Meri blocks provider-emitted undeclared names before registry invocation or approval creation.
5. Keep canonical validation and execution hooks. Hermes unwraps discovery into normal dispatch so policy/hooks still run. Meri exposes the original executable schema and leaves P0B argument validation/outcomes, client pinning, write authorization/approval, research leases, and turn budgets unchanged.
6. Bound discovery work. Hermes caps searches/describes. Meri admits at most eight exact deterministic fallback names from the existing retrieval plan, after request-scope intersection; protected required capabilities are not displaced by the ordinary 20-tool selection budget.
7. Redacted observability. Meri records decision IDs plus requested/selected/exposed/invoked names and counts and a result code. It does not log request text, tool arguments, or result bodies in selector events.

## Native differences and exact remaining seam

This slice does not add `tool_search`, `tool_describe`, or `tool_call` provider tools. The fallback is deterministic request assembly from known plan names; it is static selection, not progressive model-driven discovery. Unlike Hermes, it does not defer schemas, expose a searchable request-local catalog, describe schemas in a later round, or unwrap a bridge call into canonical dispatch.

Actual progressive discovery would require a canonical request-local registry API that can:

- search only the caller's post-policy/post-surface executable schema scope,
- return exact canonical names and descriptions without creating a second catalog,
- load the original executable schema for a later provider round,
- bind discovered names to the same decision and request scope, and
- route invocation through the existing validation, authorization, approval, lease, and budget path.

The current `/api/clio/tool-schemas` response supplies the full authorized executable schemas but no scoped search/load operation. Adding that API is outside H4's allowed provider/schema surface, so this implementation documents the seam rather than representing static fallback selection as progressive discovery.

## Tests mapped to the acquisition

- `meri-semantic-tool-gateway.spec.ts`: mode/allowlist compatibility, protected capability intersection, bounded known-name fallback, unavailable-name rejection, dynamic MCP selection, and native Research Director exclusion.
- `meriv3-governed-tool-selection.spec.ts`: evidence/document/coverage/trusted-procedure pins, user-text non-enablement, and skipped Research Director removal.
- `meriv3-assistant.service.spec.ts`: actual provider schema payloads for legacy/shadow/enabled, missing required tools, selected-client pinning, read-only/none policy, rejection of a dynamic MCP schema outside the current authorized `full_chat` surface, undeclared-call zero dispatch, and redacted selector lifecycle logs.
