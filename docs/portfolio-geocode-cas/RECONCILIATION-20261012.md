# Facility / Cleanup reconciliation — 12 October 2026

Isolated branch `codex/portfolio-facility-reconcile-20261012` is based on main
`4be13b0b1ed0f2f3fa014040eedbb2fc2c27dace`. It preserves PR2373's three commits as
separately attributed cherry-picks. No original branch is changed; no broad Cleanup
merge is included. This is a source candidate, independent of Cleanup's release gate.

| Preserved source | Reconciliation commit |
| --- | --- |
| Cleanup prerequisite `3ac6b8cff57441545a63800efec829340c6a7959` | `95d075f0f` |
| Facility CAS `8221cac0a1592a09b5da9f6abcfa140818bd5878` | `5f3c70024` |
| Facility formatting `6e5774a14c73ea04f0a77650a5bbd33173bcc9b3` | `bf4f5d940` |

## Exact overlap review

The only changed-path intersection between facility PR2373 and Cleanup PR2392
(`03d85a40e390f8f52614aab20427a3a9433786bb`) is
`apps/api/scripts/geocode-facilities.ts`. The script at the separately attributed
Cleanup prerequisite is **byte-for-byte identical** to that script in current
PR2392. Therefore PR2373 already contains the complete current lifecycle prerequisite;
there is no additional lifecycle delta to invent. The reconciled facility source is
byte-identical to PR2373's final eight-path delta, now on current main.

Independent source review of those existing candidates confirmed:

- Configuration refusal occurs before `new PrismaClient`; ownership/cleanup stays
  in `main` with `try/finally` disconnect, including initialization/runtime failure.
  `require.main` keeps imports inert. The borrowed caller-scoped transaction is not
  disposed by the shared CAS helper.
- Reviewed selection scopes tenant/client/id, validates the supplied opaque semantic
  revision, and uses `updateMany` against that same field snapshot. Zero affected
  rows is conflict; successful read-back remains in the transaction.
- Digest and CAS cover the same address, candidate, attempt/hash, district and
  coordinate semantics. JSON object keys normalize, candidate array ordering stays
  significant, and `timestamptz(6)` is not truncated into an equality precondition.
- Both inline and nightly writers retain their original snapshot across provider
  I/O and commit through `persistFacilityGeocodeSnapshot`. A stale nightly result
  counts as skipped and still observes per-row delay; stale inline results do not
  index. Retry/backoff/manual-review outcomes and Congress provenance remain intact.
- No migration or schema change. The revision is semantic equivalence, not a
  monotonic generation counter. The legacy unreviewed route's residual review risk
  is unchanged; frontend must keep using the reviewed route without fallback.

## Qualification

At source commit `bf4f5d940`, all **96 tests in four suites passed**, zero skipped:
actual service/helper PGlite CAS tests plus retained facility/geocoder/backoff tests.
The test adapter executes SQL in ephemeral PGlite; it is not native Prisma/RLS or
multiple-connection MVCC qualification. See the tracked test receipt and original
contract for limits.

A separate actual CLI process, launched in an empty task-owned working directory
with an empty environment except PATH, emitted the preserved usage error and exited
**2** with no DATABASE_URL. No Prisma client was allocated, no database connection
was attempted and no provider was called.

The first default whole-program ts-jest attempt was killed with status137 while
other full-graph checks ran concurrently. The successful command uses a scratch
config copied from the repository config with only TypeScript isolated transpilation
enabled; it changes no assertions, suite discovery, module mappings or source files.
Primary API TypeScript (`tsc --noEmit --rootDir .`, 8 GiB heap) passed separately
on this reconciled source. This does not claim the full multi-tsconfig script,
monorepo build or runtime acceptance.

Native PostgreSQL multi-connection contention, deployed registered-route/Clerk/client
privacy acceptance, provider/geocoder requests, migrations and deployment remain
**NOT RUN**. API and both workers must ship together only through the separately
approved release process (deployment preparation owner: dot). This source candidate
does not qualify Cleanup's unrelated 1,379-file candidate.
