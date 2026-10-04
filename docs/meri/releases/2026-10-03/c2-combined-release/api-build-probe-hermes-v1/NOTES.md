# Recorded-source probe correction

## Cause

The assertion at the original probe's `page.enabled === true` assumed that setting the three mode variables was enough to turn on the review surface. It is not. In the API implementation, `memoryReviewSurfaceEnabled()` combines `MEMORY_CLIENT_REVIEW=enforce` with the lifecycle and authorization gates. Both of those gates are tenant-scoped: `memoryGovernanceSelectedForCurrentTenant()` reads the current tenant from the canonical `AsyncLocalStorage` scope and checks it against `MEMORY_GOVERNANCE_TENANTS`. With no request tenant scope, or with a current tenant outside the configured cohort, the service returns `{ enabled: false, candidates: [] }` before entering `withTenantUser` or reading proposals. Therefore the original direct `listOwnProposals(ctx, ...)` call had no native tenant scope; the failure is the expected fail-closed gate, not evidence that assertions or production flags should be weakened.

The corrected probe now verifies three cases against those native gates: unscoped denial, scoped-but-off-cohort denial, and success under the canonical tenant scope for the tenant explicitly configured in the isolated probe's `MEMORY_GOVERNANCE_TENANTS`. It leaves production code unchanged and sets environment values only inside the disposable offline Node process.

## Source references consulted

The requested C1 path `C:/dev/main/outputs/meri-c1-20261002/...` was not present in this workspace. I located and consulted the corresponding source files in `C:/dev/capirov2-audit` (the matching API source snapshot available here):

- `apps/api/src/memory/memory-review-switch.ts`, lines 4-18: review requires exact `enforce` values for client review, lifecycle, and enforcement.
- `apps/api/src/memory/memory-governance-tenant-scope.ts`, lines 6-36: authenticated tenant is installed in `AsyncLocalStorage`; selection without request scope is allowed only through explicit `all`; scoped requests use the selected tenant.
- `apps/api/src/memory/memory-governance-lifecycle.helpers.ts`, lines 13-30: lifecycle enforcement combines the mode flag and current-tenant selection.
- `apps/api/src/memory/memory-authorization.helpers.ts`, lines 19-33: authorization enforcement is likewise tenant-scoped.
- `apps/api/src/memory/governed-memory-candidate.service.ts`, lines 160-199: `listOwnProposals` returns disabled/empty before tenant transaction when the review surface is off; when enabled it lists only the actor's tenant/proposals and conditionally loads payload behind the client access wall.
- `apps/api/src/memory/governed-memory-candidate.service.spec.ts`: the test setup arms the three review mode variables; the service tests exercise enabled and dark behavior. A separate tenant-scope test file was not found in the available snapshot.
- `packages/meriv2-core/src/memory/governance-rollout.ts`, lines 3-18: the cohort selector is fail-closed for empty tenant/unset allowlist and accepts an exact selected tenant or explicit `all`.
- The supplied preparation snippet `snippets/api-recorded-source.sh` and `templates/api/build.sh` were read. The correction retains the existing probe's privacy/source assertions and the network-isolated `docker run --network none` approach.

No `memory-governance-switch.ts` was found in the available source snapshots; the active lifecycle/enforcement logic is in the helper modules listed above.

## Delta in `api-recorded-source.sh`

- Requires the packaged `memory-governance-tenant-scope.js` module and uses `runWithMemoryGovernanceTenant`, the API's native tenant-scope helper; no direct mock/override of gate functions.
- Configures `MEMORY_GOVERNANCE_TENANTS` to the synthetic tenant only within this offline probe.
- Asserts unscoped and off-cohort calls return the native disabled/empty response and perform no tenant transaction or payload read.
- Runs the eligible success, ethical-wall denial, and unknown-source cases inside the configured tenant scope.
- Retains the original uniqueness, source-kind, private-URL/excerpt non-disclosure, no-payload-read-on-wall-denial, restricted-output, and unknown-source assertions.

## Limitations / status

This is a synthetic collaborator probe: its transaction, authorization result, clients, and candidate rows are in-memory stubs. It makes no database/provider calls; Docker networking remains disabled. It verifies packaged service behavior under constructed scope/cohort inputs, not real tenant middleware population, real grants/ethical-wall SQL, persistence, or production rollout readiness. The exact requested `meri-c1-20261002` checkout was unavailable, so source references were checked against the available `capirov2-audit` snapshot and should be confirmed by the parent integrator against source commit `c0f393f863bf73bd4e65e7a94e17c073e7be021e` before integration. No tests were run for this change, and no image build/publication is claimed.

Parent integration/review required.
