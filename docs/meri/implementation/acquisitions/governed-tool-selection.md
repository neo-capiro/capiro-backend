> Local implementation note: this isolated branch adds bounded progressive discovery to the held selector and later foundation work. It is not main, release, H4 adoption acceptance, CD7, or File-01 completion. Flags, tenant allowlists, provider/model routing, and rollout cohorts are unchanged.

# H4 governed tool-selection adoption record

## Disposition

Current isolated base `c89fe84902d2833c5b376b72a8920a9d6343f9af`: `IMPLEMENTED_CANDIDATE_NOT_ACCEPTED`.

The base already contains the held selector, report/plan/procedure work, and canonical registry/gateway dispatch. This change adds a request-local search/describe control in `meri-progressive-tool-discovery.ts` and integrates it only into the existing MeriV3 assistant loop. It does not add a second executable catalog, `tool_call`, generic execute-anything bridge, provider, model, route, database, migration, or UI surface.

Implementation plus focused tests is not adoption PASS. Foundation 7.1 still requires full CD7, authenticated live acceptance, source coverage, privacy/freshness qualification, independent review, both-main integration, and release evidence.

## Exact donor source

Project: Nous Research Hermes Agent
License: MIT License, Copyright (c) 2025 Nous Research

Original H4 source pin:

- `NousResearch/hermes-agent@516535b54275e963a82b4c28f866338fb768e7bc/tools/tool_search.py`, SHA-256 `1f3598a0cd221e77132bc20636e57bc10dc7fb6c2fc12b93f4427bc9019eac44`
- `.../tools/tool_search_catalog.py`, SHA-256 `7ecbeef40ce88a2932fc261b881923a808004876d8425e668c3c829162552722`
- `.../tools/tool_search_validation.py`, SHA-256 `495d75b44fcaa1f694ac9dc3cae86d5d22d1d964f76c46df022b345fe818dbc0`
- `.../LICENSE`, SHA-256 `821556e6336796450ab852d375117b48a4887e71d255794fd6318d99982a5ab6`

Separate later test pin required by Foundation 9.5:

- `NousResearch/hermes-agent@062dc1e7f0f5faa5114b4d98b94c48f5ec5df36f/tests/tools/test_tool_search.py`, SHA-256 `abd8d6ebdaf8a0364f695caa3f40fa5792e00c185a2258b003df9fe6441d0564`
- `.../test_tool_search_context_provider.py`, SHA-256 `3d2cffb736714e1984e20f29f18694a921101934654b85174f9a0dcce303ad5c`
- `.../test_tool_search_multiquery.py`, SHA-256 `e67020d8ae3c886fece392180d1d31a7775ecd070af2be58257dd2084c8bae09`

The pins remain separate. The candidate used the `516535...` source; the `062dc1...` tests are translated comparison specimens, not a replacement source pin.

## Candidate adaptation determination

The candidate is a concept-level TypeScript adaptation, not copied Python and not a dependency. It translates live request-scoped catalog construction, required ambient capability retention, exact-name scope intersection, unknown-name rejection, canonical dispatch, bounded selection, and redacted event intent into Capiro's registry/authorization seam. This is deliberate donor-informed adaptation, not a conclusion based on one phrase.

The current candidate implements provider-driven `tool_search` and `tool_describe` over omitted schemas from the request's already authorized canonical `full_chat` surface. Describe loads the original exact leaf schema only for a later provider request. There is deliberately no `tool_call`: the provider invokes the loaded canonical leaf directly, and ordinary registry validation, client pinning, procedure checks, action approval, research capability/lease checks, and aggregate run-budget fences remain the only dispatch path. The earlier eight-name plan fallback remains initial selection input; it is not represented as progressive discovery.

## Implemented bounds and authority

- Search: at most four queries per call, five matches per query, 120 characters per query, and three search attempts.
- Describe: at most eight exact names per call, eight loaded schemas total, 12,000 serialized schema-growth characters, and three describe attempts.
- The combined discovery-attempt ceiling is also clamped to the existing `MeriRunBudget` gather-model-call allowance; provider rounds and leaf calls remain charged to that same run budget.
- Unknown, malformed, control, undiscovered, removed, read-only-policy-incompatible, research-plan-incompatible, lease-incompatible, and procedure-incompatible names are never loaded.
- Search/describe results grant no authority. Load rechecks the current registry definition and read-only metadata; every leaf invocation then repeats current procedure, research capability/lease, actor, selected-client, action/approval, schema, and registry checks.
- Selector telemetry records only bounded decision IDs, canonical authorized names, counts, operation and result codes. It never records search queries, arguments, result bodies, or unknown provider-controlled names.
- Native versus MCP origin is retained in search results. The exact owner schema preserves its filters, pagination, required fields, and parameter contract when loaded.

## Candidate targets and hashes

SHA-256 over exact Git blobs at `9a651d5fae1f240a36fc9b04c7007d76d8cba172`:

- `apps/meriv2-orchestrator/src/meri/meriv3/meriv3-governed-tool-selection.ts`: `928f3e8c09d57d45607eda77b30e48846cbdb0060c17064103accfa2abe3b9a5`
- `apps/meriv2-orchestrator/src/meri/meriv3/meri-semantic-tool-gateway.ts`: `c40b80b3f9c93fbf89c0ba1e1d54e820665b7147862d945d2f4ed3d6cd87e017`
- `apps/meriv2-orchestrator/src/meri/meriv3/meriv3-assistant.service.ts`: `0e4a052a22e8e432a5c3743ad4145a95ddbf74793d9e3d09497fce6ba96d2ee3`
- `apps/meriv2-orchestrator/src/meri/meriv3/meriv3-governed-tool-selection.spec.ts`: `5a70fad9ab58938cbac6480b64bedbd70d146a186a23689c4ff082f3817ff96d`
- `apps/meriv2-orchestrator/src/meri/meriv3/meri-semantic-tool-gateway.spec.ts`: `a362f0195780b75eeb9e179fd9edf2b2b876b9b279009f5d0426d2cc1e308570`
- `apps/meriv2-orchestrator/src/meri/meriv3/meriv3-assistant.service.spec.ts`: `efb7641321c9ac787b9694d9362049c67f62b8d53c874c131a0cf08f16d0abcb`

## Donor-test mapping and observed candidate receipts

- `test_tool_search.py` -> candidate `meri-semantic-tool-gateway.spec.ts`: `enabled mode exposes only the semantic proposal for an allowlisted tenant` and `protects every authorized required capability without recreating unavailable names`.
- `test_tool_search_context_provider.py` -> candidate `meriv3-governed-tool-selection.spec.ts`: `protects evidence, document, coverage, and exact trusted-procedure capabilities` and `does not name-enable a capability from user text`.
- `test_tool_search_multiquery.py` -> candidate gateway test `bounds fallback discovery and intersects it with the live authorized surface`; unlike the donor, this remains static and does not provide multi-query provider discovery.

Saved observations only: selector candidate `b7ad92e...` passed 132 tests across three focused suites; its package suite reported 1,242 passed and two skipped. Served candidate `5a1985ce9...` reported 141 orchestrator tests across four suites plus 48 API and 15 governed-context tests. Independent review then reproduced user-visible/persisted leakage of an undeclared provider-controlled name and a meetings-reader/served-procedure gap; the broader `9a651d5fa...` Git candidate was not rerun for this record. See `governed-selector-completion-report.md`, `review-governed-selector-report.md`, `served-procedure-completion-report.md`, and `review-served-procedure-report.md` under the external evidence root.

## Notice, rollback, update owner, and remaining gap

`THIRD_PARTY_NOTICES` names the exact original pin/files, the native TypeScript adaptation targets, and retains the full MIT text and 2025 Nous Research attribution. The separate `062dc1...` files remain test specimens and do not replace the original source pin.

Rollback owner: File-01 lead / P1B registry-selector owner. Existing selector flags and tenant allowlists remain the rollback control; reverting this application slice removes progressive controls without replacing the canonical registry or authorization gateway.

Update policy: no silent pin upgrade; compare a new donor pin and tests in a new record.

Remaining mandatory work: independent review, authenticated current-policy/live-source qualification, full CD7 and release evidence. Focused implementation tests do not satisfy acceptance and H4 is not claimed PASS.

## Preserved candidate implementation record

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

## Historical pre-progressive candidate seam

The preserved selector candidate described below did not add `tool_search`, `tool_describe`, or `tool_call`. That historical limitation is repaired by the current isolated implementation record above; it is retained here to distinguish the static donor adaptation checkpoint from this progressive candidate.

The required seam was:

- search only the caller's post-policy/post-surface executable schema scope,
- return exact canonical names and descriptions without creating a second catalog,
- load the original executable schema for a later provider round,
- bind discovered names to the same decision and request scope, and
- route invocation through the existing validation, authorization, approval, lease, and budget path.

The implementation uses the existing authenticated `/api/clio/tool-schemas` response after shared-registry, surface, tool-policy, research-plan, lease, and procedure filtering. Search indexes only that request-local exact schema set; describe returns and later exposes the original owner schema. No API or second catalog was added.

## Tests mapped to the acquisition

- `meri-semantic-tool-gateway.spec.ts`: mode/allowlist compatibility, protected capability intersection, bounded known-name fallback, unavailable-name rejection, dynamic MCP selection, and native Research Director exclusion.
- `meriv3-governed-tool-selection.spec.ts`: evidence/document/coverage/trusted-procedure pins, user-text non-enablement, and skipped Research Director removal.
- `meriv3-assistant.service.spec.ts`: actual provider schema payloads for legacy/shadow/enabled, missing required tools, selected-client pinning, read-only/none policy, rejection of a dynamic MCP schema outside the current authorized `full_chat` surface, undeclared-call zero dispatch, and redacted selector lifecycle logs.
- `meri-progressive-tool-discovery.spec.ts`: multi-query bounds, exact-schema identity, native/MCP boundaries, schema/handler control parity, unknown/malformed/undiscovered/disallowed rejection, attempt limits, and output/schema-growth bounds.
- `meriv3-assistant.service.spec.ts`: first provider request omits a rare authorized leaf; search and describe occur in separate rounds; the next request contains the exact owner schema; the canonical leaf executes once; the following request observes its result; current registry removal fails closed with zero handler invocation.
