# Reviewed facility geocode selection and worker CAS

**Source-qualified candidate. No API/geocoder calls, shared data writes, migrations, deployment or merge.** The local source and deterministic disposable-database checks below do not establish deployed/authenticated acceptance.

## Baseline, policy and overlap

- Repository/worktree: `neo-capiro/capirov2`, `C:\dev\cap-geocode-cas-261011`.
- Branch: `codex/portfolio-geocode-cas-20261011`.
- Starting/fetched remote-main commit: `fd8765ec01d292013758606204f2c9d886cd31c1`.
- Shared policy fetched and read: local `b32b4803933760dc0a93fffdcd8fba30a89c3aac`, fetched origin/main `b2b0ce8c2bf03817b81e671d968b7892985b8d06`. No local changes were discarded. BOOTSTRAP, AGENTS and local machine map were reread. Map revision/date: `2026-09-30T00:21:48.2698715Z`.
- No application AGENTS or IMPLEMENTATION-STANDARDS files were found at this revision.
- Cleanup overlap: `apps/api/scripts/geocode-facilities.ts`. Root authorized preserving the exact cleanup script from `4ca62bb61a6ed03e76f5f967278f5b861666b1c7` in a separate prerequisite commit, **`3ac6b8cff57441545a63800efec829340c6a7959`**, before applying this candidate. The prerequisite script blob is byte-identical to cleanup's blob. No other cleanup files/commits were integrated.

Cleanup's missing-DATABASE_URL exit 2 before Prisma allocation, local Prisma ownership in main/try/finally, disconnect, explicit Prisma argument to bypassRls, final error exit and per-row delay are preserved. The candidate's exact script delta against cleanup is only imports/type, selection of client/candidate snapshot fields, guarded per-row persistence and zero-write skipped accounting. A saved diff accompanies the evidence.

The original outline was: inspect all callers; require an explicit reviewed revision; validate it against the read snapshot; atomically compare exact database values before selecting an index; keep tenant/client scoping and post-success indexing; prove both race orders in a disposable database. Root then allocated a backward-compatible reviewed route, reverse-race protection for both asynchronous writers, a narrow existing test-double correction, and server revision receipts. No frontend files were changed.

## Confirmed original failure

The original choose method reads the current candidate by index, then performs `update({where:{id}})`. A concurrent address/candidate replacement between those statements is overwritten by the old selection. The original method was reproduced from its exact base-commit AST against synthetic PGlite persistence: a concurrent `Concurrent newer address` became `Old candidate`, latitude 30, status `matched`. The diagnostic records the source commit and actual observed values. Its district normalization shim is irrelevant to the observed address/point overwrite; this is not a Prisma-engine or authorization test.

The reverse race also existed: nightly geocode used an unconditional update by ID. Inline geocode guarded only address/manual district fields, omitting candidates/status/attempt/hash/coordinates. An in-flight resolver could overwrite a reviewed choice even when the address and districts stayed the same.

## Public contract — frozen v1

Existing caller search found the legacy web facility API and ManageFacilitiesModal, plus its test. The old route is retained to avoid breaking the deployed frontend. Portfolio must use the new reviewed route and the **server-produced** revision; it must not reconstruct a hash from projected frontend fields.

### Server receipts

Every facility returned by these existing endpoints now includes an additional `geocodeCandidateRevision: string`:

- `GET /api/clients/:clientId/facilities` (each array item).
- `POST /api/clients/:clientId/facilities`.
- `PATCH /api/clients/:clientId/facilities/:id`.
- `POST /api/clients/:clientId/facilities/:id/resolve-district`.
- `POST /api/clients/:clientId/facilities/:id/geocode`.
- Both legacy and reviewed candidate-selection receipts.

The serializer appends a revision to the existing backend response shape. It does not require frontend exposure of tenant IDs or geocode-input hashes. Existing backend fields are retained for compatibility; the current backend already returns full facility records and its regression asserts the geocode hash. The frontend can retain only the opaque revision alongside its existing projected fields. Older backends may omit the new field: the frontend must treat reviewed selection as unavailable until it receives a revision.

### Reviewed action

```http
POST /api/clients/:clientId/facilities/:id/geocode-candidate/reviewed
Content-Type: application/json

{
  "candidateIndex": 0,
  "expectedRevision": "v1:<64 lowercase hexadecimal characters>"
}
```

- `candidateIndex` is a nonnegative safe integer. The DTO also validates the inherited integer/minimum rules.
- `expectedRevision` is required by the reviewed DTO. The handler passes an explicit review context; a missing value cannot fall back to legacy behavior even if DTO validation is bypassed in a direct invocation.
- Missing/malformed revision or index: **400**. A facility outside current tenant/client scope remains **404**.
- Changed reviewed snapshot or a failed atomic write: **409**, with body `{ code: 'FACILITY_GEOCODE_CANDIDATES_CHANGED', message: 'Facility or geocode candidates changed. Refresh the facility and review its current candidates.' }`.
- Success returns the selected persisted facility, including its new server revision.
- A missing reviewed route on an older backend is **404/unsupported**. Never fall back to the legacy route or send a precondition to the legacy route and assume it was enforced.

The existing `RolesGuard`, standard-user role and current tenant context remain on the controller. Existing tenant/client facility predicates are retained in reads and repeated in the atomic update. This does not add permissions or expand access.

### Legacy compatibility

`POST .../:id/geocode-candidate` keeps its existing `{candidateIndex}` body. It gains atomic protection against a replacement **after its own read**. It still cannot establish that the caller reviewed the current candidate set before the request. That residual stale-client risk is explicitly tracked for the legacy owner; this candidate does not claim a global client-contract migration. Portfolio uses only the reviewed endpoint.

## Revision and persistence semantics

`facility-geocode-candidate-revision.ts` owns the deterministic semantic digest, the exact Prisma predicate, a shared background commit boundary and the receipt extension. The v1 revision hashes canonical UTF-8 JSON using SHA256 and a `v1:` prefix. Object keys sort by code-point order recursively; array order is preserved because candidate indexes are meaningful. JSONB key reordering does not invalidate equivalent content. The fixture `revision-v1.fixture.json` records a stable synthetic vector for independent protocol checks, not production data or a frontend implementation requirement.

Every field used by the database predicate is included in the digest:

```text
id, tenantId, clientId,
addressLine, city, state, zip,
geocodeCandidates, geocodeStatus, geocodeAttemptCount, geocodeInputHash,
congressionalDistrict, congressionalDistrictCongress, districtSource,
stateHouseDistrict, stateSenateDistrict, latitude, longitude
```

The service first checks the supplied revision against the scoped current row. It then executes one `updateMany` whose predicate compares those original values, including structural JSON equality and all nullable fields. A pre-read alone is insufficient: the update itself must report exactly one row. A stale/deleted/replaced row reports zero, produces 409, and does not index a stale location. The successful updated row is reread within the existing tenant transaction and then indexed once.

This deliberately avoids equality on a JavaScript Date against PostgreSQL `timestamptz(6)`: database microseconds need not survive a JavaScript millisecond round-trip. The tests retain a `.123456` timestamp and demonstrate that it is not used as a lossy precondition. Unrelated note/name/timestamp changes do not invalidate a review. Changes to any guarded geocode/address/district/point field do invalidate it. This conservative inclusion can reject a choice when a related district changes without changing candidate labels; the correct action is refresh/review.

The revision is a **semantic snapshot**, not a monotonic row generation or authorization credential. Identical same-field replays and schedule-only equivalent pending retries are treated as equivalent. A new schema generation counter or raw precision timestamp contract was deliberately not introduced. Root accepted this equivalence for the current reviewed-selection/worker safety requirement. The candidate list, state, attempt count and address/hash changes that distinguish a reviewed choice or replacement are all guarded.

### Background writers

Inline and nightly resolvers perform provider I/O outside the persistence transaction, then call the same `persistFacilityGeocodeSnapshot` with their **original snapshot**. Nightly SELECT now includes client ID and candidate JSON. A reviewed choice clears the candidate list, marks it matched and stamps `facilityAddressHash` for the selected address; old worker snapshots no longer match. A zero-write nightly result is counted as skipped and still reaches the existing per-row delay. It does not consume a retry or overwrite a newer user's state. Inline stale results do not trigger knowledge-base indexing.

The current worker result path still preserves outcome updates, retry/backoff/manual-review rules, attempt counts, error messages, discrepancy reporting, scan scope/bounds, lifecycle cleanup and successful current-snapshot persistence. Selection clears the retry schedule/error and stamps the existing shared address hash, preventing an unnecessary changed-address retry for the chosen point. Existing deliberate Congress-provenance backfill eligibility is retained.

## Validation and limitations

**PASS: 96 tests in four suites; zero failed, skipped or snapshots; exit 0.** Twenty focused cases use a disposable in-memory PGlite 0.5.8 Postgres/WASM database with a small canonical table and a thin Prisma-query adapter executing the actual service/helper. The other 76 are unchanged existing service/geocode/retry assertions, except a narrowly allocated query-double helper correction.

Covered cases include server list/receipt revisions, JSONB key stability, timestamp microseconds, explicit chosen point and address hash, repeated selection, stale displayed candidates, address/candidate/count/district/point/hash/status/delete interleavings at the database update boundary, two competing choices, original worker snapshot → reviewed choice → stale commit refusal, worker replacement → reviewed conflict, a current worker success with retry state, same-address/same-district in-flight inline resolver fencing, tenant/wrong-client lookup, malformed DTO/body/index and retained controller route/role metadata.

**PASS: strict source-region typecheck; exit 0.** The reproducible harness extracts the exact choose and inline methods, actual nightly commit call and DTO classes from source, and checks them plus the real helper against installed generated `Prisma.TransactionClient`, Nest and shared types using `strict`/`noUncheckedIndexedAccess`. It is not a full application typecheck. The extraction avoids importing unrelated application dependency/runtime graphs or creating Prisma clients.

Preserved failures/setup evidence:

- Initial typecheck harness emitted Windows backslashes inside generated module specifiers; fixed scratch path serialization, no source workaround.
- Initial Jest/PGlite invocation required Node `--experimental-vm-modules`; retained as setup limitation. No assertion was skipped.
- Initial valid PGlite run: 15/16, one fixture SELECT missing a column alias; fixed the alias, preserving the failed JSON.
- Initial existing regression: 75/76. Its fake compared new JSON filter objects by identity. The allocated correction models omitted undefined, structural JSON equality and Prisma AnyNull. All original assertions were retained; final 76/76 pass. Real PGlite cases also pass independently of that fake.
- ts-jest emits the repository's existing hybrid-module configuration warning; Node emits the experimental VM warning. Neither is hidden by a config suppression.

The PGlite adapter is not the Prisma engine, a multiple-connection MVCC test, RLS verification or an authenticated HTTP test. Interleavings are controlled at the update boundary and execute real database equality/atomic UPDATE semantics. Existing controller guards were retained and their metadata checked; no claim of live permission/session acceptance is made. No geocoder/provider request is sent.

Full monorepo/app build, repository-wide lint, deployment, actual Prisma/Postgres role behavior, API proxy routing and browser/tenant session checks are **NOT RUN** in this source-only allocation. No packages were installed or copied. Existing installed runtimes were reused read-only; all scratch/DB state is task-owned.

## Commands and integration prerequisites

Run from `C:\dev\cap-geocode-cas-261011\apps\api` with the preserved scratch Jest config in the task output:

```powershell
& '<pinned-node24>' --experimental-vm-modules '<existing-api-node_modules>/jest/bin/jest.js' `
  --config '<task>/work/geocode-cas-jest.config.cjs' --runInBand --runTestsByPath `
  src/clients/facility-geocode-candidate-cas.spec.ts `
  src/clients/client-facilities.service.spec.ts `
  src/clients/facility-geocode.util.spec.ts src/clients/geocode-retry.spec.ts `
  --json --outputFile '<task>/work/geocode-cas-regression-final.json'
```

Pinned Node is `C:\Users\Administrator\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe`; existing API dependencies are `C:\dev\capirov2\apps\api\node_modules`. Typecheck command from the parent task directory: `& '<pinned-node24>' work/check-geocode-cas-types.cjs`. Source positive reproduction: the same runtime with `work/reproduce-original-geocode-race.cjs`.

Remaining prerequisites:

1. **Root Portfolio frontend owner:** retain optional server revision in the read adapter, require it for choosing, call only the reviewed route, disable duplicate pending actions, invalidate/refresh on 409 and require a renewed visible choice. Never silently fall back to legacy behavior on missing revision/404.
2. **Cleanup/backend owner:** review/integrate the separately attributed lifecycle prerequisite and exact CAS script delta. The local copied prerequisite does not merge cleanup's broader branch or authorize deployment.
3. **Backend/auth owner:** run normal full application gates and actual Prisma/Postgres tenant/client/privacy checks, then coordinate deployment of API and worker together so the reverse-race protection is present in both writers. No schema/migration dependency exists.
4. **Frontend/backend owners:** designated service/browser acceptance for refreshed revisions, 409 handling, address edits during selection, queue/rerun behavior, session expiry and knowledge-base invalidation. Source and fixture results are insufficient for live acceptance.
