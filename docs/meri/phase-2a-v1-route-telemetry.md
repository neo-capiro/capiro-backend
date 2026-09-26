# Phase 2A: Legacy V1 route-selection telemetry

Base: `703fdf8d143d71ec78149fd99f6e7bf05150c838`

## Change

Added paired low-cardinality structured `MeriRouteTelemetry` events when the
raw V3 fallback proceeds past the MeriV2 gate and actually selects the legacy
V1 loop. The selection event is emitted immediately before V1 intent
classification. The outcome event is emitted after return or throw and
classifies in-band error frames, thrown errors, aborts, and the controller's
fixed client-disconnect AbortError. Both events include fixed route labels, a
random `routeAttemptId` UUID shared by the pair, and `impersonated: boolean`;
they do not include tenant/user/conversation IDs, credentials, prompt text, or
arbitrary exception text. Logger failures are swallowed and cannot change
routing or stream behavior; SSE payloads are unchanged.

The V3-declined and V2-declined decisions are represented together by the
fixed `dispatch=v3_raw_v2_declined` label. V2 turns and shared-prelude early
exits do not emit V1-selected events. This measures V1-loop selections rather
than raw-service entries.

## Acceptance and residual limits

- Route tests lock existing Hermes/V3/raw routing and verify selected + outcome
  records for success, in-band service error, and client disconnect, including
  an impersonated turn, paired random IDs, absence of sensitive identifiers,
  and logger-failure isolation.
- Focused route/lifecycle suite: 4 suites, 94 tests passed (`meriv3-runtime.proxy.spec.ts`,
  `meriv3-proxy.service.spec.ts`, `meriv2-routing.matrix.spec.ts`,
  `meri-turn-lifecycle.phase4.spec.ts`). This includes normal completion,
  service error-frame, client-disconnect, correlated-pair, and logger-failure
  isolation cases.
- API typecheck passed (`PE_PHASE_A_B_SAFETY_OK`, `API_TYPECHECK_PASS`).
- API production build passed (`API_BUILD_PASS`).
- `git diff --check` passed; source diff review found only the internal optional
  callback, telemetry wrapper, focused tests, and retirement documentation.
- The telemetry is necessary but not sufficient to begin the four-week
  zero-traffic clock. Deployment and log-pipeline validation remain required;
  logging must be unsampled/retained, and unmatched selections must be treated
  as interruption rather than zero traffic.
- Because events intentionally omit tenant identifiers, they cannot establish
  tenant-by-tenant coverage or independently detect a newly added/disabled
  tenant with no events. Pair with tenant/cohort configuration inventory and
  persisted `servedBy` checks. `impersonated` records only the passed boolean,
  not impersonator/effective tenant identity or authorization success.

No database migration, route change, runtime dispatch change, deployment, or
production action is included. Rollback is a source revert of this commit.

## Follow-up: fragmented SSE error observation

The initial observer treated each `writer.write()` call as a complete SSE
frame. Hermes and V3 may split one frame over multiple writes, so an in-band
`{"type":"error"}` could be counted as `completed`. The follow-up adds one
synchronous SSE observer shared by Hermes, V3, and V1 route telemetry. It
assembles complete events across arbitrary chunk boundaries, accepts LF, CRLF,
and CR line endings plus `data:` with or without a following space, and joins
multiple `data:` lines according to SSE framing before attempting JSON parse.
It classifies only complete, valid JSON events whose `type` is `error`.

Observation retains at most 65,536 JavaScript characters of event text (not
an encoded-byte limit). Malformed and oversized
events are ignored for classification. The wrapper sends every original write
argument to the original writer, in the same order, without buffering or
rewriting response output; the observer is synchronous and emits no content to
logs. Source tests cover fragmented/multiline CRLF frames, incomplete JSON,
malformed and oversized events, and unchanged writes across Hermes, V3, and V1.
Those added source tests were not run in this constrained follow-up. Runtime
validation remains outstanding; the prior focused suite/build/typecheck
evidence above describes the pre-follow-up source state only.
