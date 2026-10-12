# Strategy grounding clock and context retry preparation

App source checkpoint: `e22731a66021bb4e7e5b4112624c823c611d2a3c`, tree
`19b961637081340dcad1eb70522868fe2863762d`. Base: frozen PR2408
`1bf52945b9fa01496ce41a349f8eaace490ad4ac`, tree
`d3ede11cd213151b244853e39bb7fab30610d2d9`.

This is a bounded app contribution for root's coordinated source slice. Root owns
the shared `time.ts`/barrel, ratchet/data/CI, progress and handoff; this branch
changes only eleven Strategy source/test files plus this unique evidence directory.
It is not a standalone, independently accepted or published release. Root must
integrate the canonical shared utility and same-change anti-bypass guard, then
obtain independent review. No Wave 1 completion or full Cleanup gate is claimed.

## Canonical seam and bounded adoption

Root's pure shared utility provides `WallClock = () => number`,
`RandomSource = () => number` and `Delay = (milliseconds: number) => Promise<void>`.
Lazy defaults are `systemWallClock`, `systemRandom` and `systemDelay`; they retain
real wall time, Math.random's [0,1) uniform source and a setTimeout Promise.
The helper source used here has SHA-256
`c8f5e960d56e7bdb509a990517c2c2ffe7cbfbc975442bb7a53a4ed52845a854`.
No shared/package/root/workflow source was authored by this app contributor.
Existing shared dependency/build packaging from the frozen base is retained.

`meri/strategy-time.providers.ts` contains value providers and symbols, no new
service/store. `MeriModule` registers them. Raw Meri requires
`STRATEGY_WALL_CLOCK` and `STRATEGY_CONTEXT_RETRY`; DraftJobService requires the
retry token. Existing governed wrapper registration and delegation remain intact.
Clock input is server DI, never a request/DTO/context claim. The qualified Meri
auth/capture semantic clock is intentionally separate and is not imported.

`MeriService.fiscalWindow` samples `this.clock()` exactly once at its original
sampling point, after required grounding loads, or after credential resolution
for reference assistance. It reuses canonical `currentFyWindow` and existing
`isoDate`. Fiscal year calculation still uses host-local calendar fields and
the date string still uses existing ISO conversion; no timezone policy is fixed
or added. Each call observes fresh time, without an import-time cached date.

The fiscal math helpers now require an explicit Date. All production callers were
traced: `reference/baseline.ts` already samples its own existing `now` default and
passes the same Date to `currentFyWindow`/`qToDate`; `axisStart`'s internal callers
already pass it too. That producer's default/sampling and stored baseline reads
are untouched. Explicit date construction and quarter/leap-month math remain.

`withContextRetry(source, fn, runtime)` requires the third argument, with no hidden
fallback. All six production calls pass `this.retryRuntime`:

- Meri `firm-phases` and `reference-calendars` grounding loads.
- Meri draft `client-existence` lookup.
- Meri `steward-facts` and `steward-health` loads, inside existing fail-soft policy.
- DraftJobService submit `client-existence` lookup before job persistence.

The helper uses `runtime.random()` and `runtime.delay(...)`. Delays remain
`200 * 2 ** attempt + floor(random * 75)`: 200–274ms then 400–474ms, at most two
retries/three attempts. Final failure has no extra delay/sample. The error
classifier, logger messages, source labels and caller fail-soft/hard policies are
unchanged. Its existing timeout-text-before-status ordering is explicitly pinned:
`{status:401,message:'timeout'}` remains transient. Tightening that policy would
be a separate declared behavior change, not part of injection.

Meri mutation timestamps, telemetry, crypto UUIDs, draft deadlines/worker clocks,
credential caches and other apps' clocks remain outside this bounded conversion.
The ratchet must preserve those explicit existing exceptions while preventing new
ambient time/RNG/timer fallbacks at the adopted boundaries. No HTTP route, DTO,
response field, schema, persistence, model, authorization or frontend contract
changes are introduced. Frontend head `4a161488` therefore needs no new contract
consumption from this app contribution.

## Source qualification and preserved evidence

Frozen source checks: **137/137 across seven suites passed** and complete strict
Strategy TypeScript checking passed. Tests exercise actual helper/service methods
with synthetic collaborators and actual Nest constructor injection. They cover
FY rollover, fresh sampling after asynchronous loads, reference forwarding,
clock/hook failure propagation, exact jitter floors/backoff, await ordering,
retry exhaustion, all six callers, unknown-client/denial before persistence,
missing DI tokens, canonical default identity and governed/reference regressions.

All **102 original full test names** from the four changed suites remain in the
executed result, with no removed names. Their byte-identical original source was
verified before a deliberately skipped name-only inventory; skip output is name
evidence, not test acceptance. The final run also executes the new provider suite
and two unchanged governed-wrapper/reference-baseline suites.

Raw initial/passing/failed logs and JSON are retained under `evidence/`:

- Initial five-suite run passed 125 cases before two final clock cases.
- Initial complete typecheck failed because the isolated copy of main's dependency
  scope lacked its `@capiro/shared` link. Added an explicit private app binding to
  root's built shared package; no common RC/main binding or source was changed.
  The retry and frozen full typechecks pass.
- Initial name inventory could not find the parent worktree's generated client.
  The source-only mapper uses this worktree's local engine-free JS/declarations;
  the repaired inventory contains all 102 original names.
- A post-run assertion that parent specs still matched the original failed after
  root legitimately cherry-picked this app source. Original Git blob provenance,
  the successful pre-run verification and full-name comparison remain retained;
  no implementation loss or source regression is implied.

Dependency links are private/read-only; generated JS/types were copied locally
with native .node/.wasm/query-engine files excluded. No engine generation/download,
database/PGlite/migration, provider/model call, customer mutation, cloud operation,
credential/permission/security/network change, main merge or deployment was run.
Isolated ts-jest transpilation is separate from the full strict compiler check.
Independent review and root's same-change ratchet/CI acceptance remain pending.
Native/full Cleanup prerequisite gates remain open. EngagementService reporting,
PE migrations/public-law, previous adoption matrix and PR2408 packet are untouched.
