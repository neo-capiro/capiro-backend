# Phase 4 worker claim gate — local source and image qualification

Date: 2026-09-26

Branch: `integration/meri-provisional-346-20260925`

Parent checkpoint: `682f234f46241d08c7a2d60077cff47813ea920a`

## Outcome

The previously dormant Phase 4 claim/tool-view contract now has a source-authored worker-side enforcement slice and a qualified disposable local image. The worker captures the exact signed request, launches only through canonical `POST /v1/runs` in guarded mode, performs one bounded HTTPS claim, and opens provider/tool execution only for the exact transitioned response. UNKNOWN, rejected, malformed, ambiguous, timed-out, and transport-failed outcomes remain permanently denied and are not retried.

This is local source/image evidence only. The API adapter remains dormant and unregistered, no release image was pushed, no deployment or live prompt occurred, and Phase 4 remains off.

## Enforced boundaries

- Exact method, path, query, content type, header multiplicity, raw body and request-local tool-view bindings are captured before native idempotency reservation.
- A purpose-separated claim attestation is checked against the worker run, dispatch bearer, image/build, raw and applied catalog/tool-view digests, Meri catalog/mapping, protocols, credential and actor/session scope.
- The claim uses one two-second HTTPS request with no proxy, redirects or retry. Only `{version:2, kind:"transitioned", launchAuthorized:true}` authorizes launch.
- Agent exposure, provider transport, institutional memory, tool execution, background review and delegation inherit or recheck the launch gate. Guarded cron, curator, fallback, route overrides and proactive dispatch are disabled.
- Guarded runtime selection is fixed to the provisioned custom/chat-completions runtime. Provider/model/model-options/room overrides fail before agent construction.
- Guarded context resolution uses the mandatory bounded local context pin. Local endpoint fingerprinting is disabled, closing constructor-time `/api/v1/models`, `/api/tags`, `/props` and `/version` probes before the claim.
- The overlay is bound to exact v2026.9.14 file hashes and a 13-file enforcement manifest, including the native idempotency implementation. Claim mode refuses a missing, incomplete or modified enforcement set.
- The claim-attestation key must differ from the configured tool-view, API, claim-service, worker-token and provider credentials; the entrypoint does not bake secrets into the image.

## Exact local evidence

- Consolidated source gate: 3 claim Jest suites plus the gate-bearer suite; strict targeted TypeScript; 2 Node image-harness guardrail tests; Python claim 11/11, tool-view 14/14 and exact pinned-archive 1/1.
- Exact pinned archive: SHA-256 `47df72ebd3f9c96d806a94541163f7fe7d7ce5b84f85c1d3787e6dfeea1d7834`; all patched sources compiled after the overlay was applied.
- Local disposable image: `meri-hermes-worker@sha256:4fa0477fcc569666e553db05a32f8556f7a1bcaa86254ca2062504f03b5e9f13`, with distinct tool-view and Phase 4 claim labels set to `1`.
- Image integrity: all 13 manifest entries passed `sha256sum -c` and Python bytecode compilation.
- Patched live hook dispatcher: 5/5 serialization/timeout race tests passed inside the built image.
- Adversarial built-image contract passed on an owned internal Docker network with a fake TLS claim service, provider, memory endpoint and broker. Two distinct transitioned runs executed concurrently and every provider/memory/broker event followed its claim. Runtime overrides caused no network I/O. UNKNOWN, rejected and Stop-during-claim runs produced zero provider/memory/broker effects and exactly one claim each.
- The same contract reserved a native run in one container and recovered the exact reservation in a second container over an owned mounted volume. Guarded mode rejected `:memory:`, rejected default-path open failure, and refused startup when `HERMES_HOME=/opt/data` was not a mount.
- Native reservations now carry the signed retention horizon. Acknowledgement age cannot prune a positive-horizon row early; the row prunes at the exact exclusive horizon, while legacy rows retain upstream acknowledgement/age pruning.
- The built-image contract removed all owned containers, networks and volumes on completion.

The upstream init layer may emit a transient legacy-config migration warning before the Meri entrypoint rewrites the owned config. Final rendered guarded config is version 12 with the pinned model/provider/base URL/context, tool search off, and background review/curator disabled. The warning is not treated as qualification evidence.

## Independent review and remaining blocker

The local lifecycle source now uses a persisted ECS RunTask idempotency identity plus a separate takeover lease. A crash after RunTask but before the task-ARN write replays a byte-identical request and recovers the same task; stale owners cannot commit progress, success, or failure after takeover. The real local-Postgres advisory-lock concurrency suite and the simulated crash-window suite pass.

This does not prove that a production EFS mount is durable or that every deployed worker path is single-writer. Status/Stop recovery is still dormant and unregistered, broker-effect receipts are absent, and the earlier route-operator migration correctly refuses a database whose inherited PUBLIC routine privileges have not been hardened.

Before activation, register and authorize the private API claim endpoint and caller, complete actor/session mapping and producer credential custody, wire authenticated status/recovery plus lost-response/late-ID/Stop reconciliation and broker-effect receipts, harden the database privilege baseline, qualify production durability/topology/rollback/concurrency, and obtain explicit user deployment GO. Phase 5 adjudication and Phase 6 representative signed-cohort gates remain independent.
