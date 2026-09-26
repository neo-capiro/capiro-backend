# Meri final-schema availability proof (dark diagnostic)

The fixed v3 proof policy covers exactly `get_client_context`,
`search_client_knowledge`, and `get_representation`. The separate v2
`offeredDiagnostic` lists every exact final provider-facing name in order. It
checks those three permissions only when offered and now also checks the V3
`run_analysis` permission policy. All other names remain
`unknown/permission_semantics_unresolved`; absent fixed-catalog names are
`unknown/not_offered`. The top-level catalog SHA remains the three-check
policy identity; `offeredDiagnostic.catalogSha256` is a distinct digest that
binds the added analysis policy. The turn-binding fingerprint separately
covers the exact offered schemas. This is not JEV, a router,
an execution token, or an invocation authorization. Every response keeps
`eligibility: unresolved`, `runtimeAvailability: unresolved`, and
`executable: false` for every tool. The permission statuses are diagnostic;
they do not change which tools are sent to the model.

## Scope and trust

The HTTP endpoint requires the normal caller bearer/tenant context, the
`standard_user` role floor, and `MeriV3InternalServiceGuard`'s
`INTERNAL_SERVICE_SECRET`. The orchestrator calls it only when
`MERI_TOOL_AVAILABILITY_PROOF_SHADOW=true`; the flag defaults off. That private
service hop is trusted to assert the per-run random nonce, route surface, and
the exact provider-facing tool list. The API re-hashes that list itself. The
shared service secret is symmetric: this contract assumes trusted orchestrator
code and does not protect against a malicious or compromised orchestrator.
Nonces are generated randomly for each invocation and echoed back for exact
comparison, but the API does not keep a nonce-use registry or provide a
separate replay database.
The response is checked locally against the nonce, surface, authenticated
tenant/user/conversation/client scope, schema version, and a fingerprint
recomputed from the exact same frozen provider-facing tool array. It is not a
separately signed API response.

Tenant and user come from API bearer middleware; the conversation and client
come from an unarchived persisted conversation scoped to that tenant and user.
The fixed three-tool proof conservatively still requires conversation status
`active`; the analysis diagnostic follows the V3 bridge's unarchived rule.
The API rejects caller-supplied client, tenant, user, tool-candidate,
or fingerprint fields. It accepts only the exact request keys: conversation
id, nonce, surface, schema version, and `finalOfferedTools`. Submitted schemas
are limited to 256 functions / 900 KiB, strict allowlisted fields, and unique
safe tool names. The fingerprint uses the shared deterministic JSON
canonicalizer and schema version `meriv3.final-offered-schema.v1`.

Surface is derived in the orchestrator from the API-attested governed context
operation (`meri.chat` or the research operation IDs), not from a new body
field. The API treats that surface and the nonce as authenticated internal
service assertions. It independently computes the schema fingerprint and
returns its own check time. If the conversation was not persisted, the
orchestrator rejects the response as an exact-scope mismatch.

## Runtime behavior

With the shadow flag absent or anything other than the literal `true`, no
proof request is made and the existing schema array/provider behavior is
unchanged. In shadow mode, the provider-facing `tools` value is bounded,
JSON-cloned, and the independent clone is deeply frozen before sending it; the
same frozen clone is reused by all gather rounds. This avoids freezing schema
objects shared with the registry/cache. The API proof is verified before the
first gather request; snapshot/proof failures are caught within the diagnostic
boundary and do not alter the tools' JSON content or stop baseline dispatch.
The diagnostic has a one-second request deadline and records elapsed time on
success/failure. A missing, failed, or mismatched proof fails closed as
diagnostic evidence (it cannot qualify a tool). The later synthesis call with
`tools: []` is a separate down-only request and is not covered by the proof.
No prompt/schema content, nonce, tenant ID, or user ID is logged.

The new analysis diagnostic reads the current tenant's V3 canary and
`runAnalysis` policy, confirms the effective cached invocation gates, then
uses the V3 bridge's locked conversation/client-wall check. A clientless
conversation may be analysis-permitted while the three client tools still need
input. Research turns can offer analysis through the same bridge. This status
is a point-in-time finding for the exact bound conversation/client scope. A
concurrent client reassignment can make that earlier scope unavailable; it
does not establish permanent denial for a later turn with a new scope. The
status is permission-only: sandbox switch, URL, token, authentication health, queue
and capacity do not become runtime readiness proof. The proof checks only
per-client permission walls for the three fixed tools.
`search_client_knowledge` provider/index health and actual runtime readiness
remain unresolved. There is no validated permission/availability intersection,
catalog agreement with Phase 4, JEV connection, schema filtering, or activation.
Do not use this diagnostic to qualify candidates or authorize invocation.
The orchestrator requires the additive diagnostic and checks its exact order,
permission correspondence and non-executable/unresolved fields. If its shadow
flag is enabled, API and orchestrator must be deployed as a coordinated pair:
an older API lacks the required field and yields a shadow-only mismatch. With
the shadow flag off, there is no request or normal-path behavior change. The
two new wire-invariant failures retain distinct content-free shadow error
codes instead of collapsing to a generic failure.

## Validation state

Adversarial API and orchestrator specs were added for schema bounds, content
hashing, nonce mismatch, scope mismatch, offered-name correspondence, and
executable/eligibility escalation.
Per the resource instruction, Jest, typecheck, and database tests were not run;
only `git diff --check` is permitted for this package. Local acceptance remains
pending those checks.
