# Meri release qualification — October 2, 2026

This is the source-pinned qualification record for an attended release to the sole
`capiro-dev` environment. UI goes only to `web-vnext` at `os.capiro.ai`. Build
publication, service promotion and authenticated acceptance are separate results.

The owner explicitly requested deployment and accepted dealing with residual
database issues afterward. The original whole-dump fingerprint discrepancy is
recorded as **ACCEPTED LIMITATION** under that direction. Its original immutable
BLOCKED receipt is not changed or represented as a data-preservation PASS.
No migration, ledger rewrite, restore, customer-data test or broad feature
activation is part of this release.

Shared policy: `39590a3bfc57ce03b0411ff7912a7c8d99deb70c`; machine map dated
2026-09-30 00:21 UTC. Reviewed changes were integrated into the clean C-drive
local main before their GitHub merges: PR1921 runtime/preview fix, PR1922 release
identity, PR1923 Web Node and synthetic-wrapper identity, and PR1924 catalog tests.

## Exact image candidates

| Service | Source commit | Immutable image digest | Build |
| --- | --- | --- | --- |
| API | `83304d18e5a1ab647cf6f728392cf97b3058a832` | `sha256:1fbf675727041323c56c2330aebb7f27ae4129864cb413953b869bfffad80015` | `capiro-build-web-dev:dc4c281e-5372-4a7d-b667-2919a78125f1`, SUCCEEDED |
| Web vNext | `940fe9354f95630c6acb0f20f75ced26ea9e75f4` | `sha256:bb114117e1ac5bad398a34c2272280b0b55abbcb0502cb5b6b95356f213bdfdb` | `capiro-build-web-dev:8e88dd66-21c6-46b0-a74a-d33c7563b08e`, SUCCEEDED |
| Meri orchestrator | `39cea28f31be07def2f67ddf06ac4c44ef4ab792` | Not yet qualified in this record | `capiro-build-web-dev:8d17a8df-7779-416b-92f2-4875b722ca50`, build in progress |

All image repositories are beneath
`967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/` with the service name
shown above. Each image retains its actual source tag; no old image is retagged
as newer code. API inputs are unchanged through the Web follow-up. The later
orchestrator repair changes three test files only, plus release documentation.

The relevant exact-source Actions workflows failed with `startup_failure` and
zero jobs. The approved fallback uses the existing native ARM64 CodeBuild project,
the canonical Dockerfiles and reviewed inline build recipes preserved here.
Actual CodeBuild source/resolved SHA and stored buildspec bytes, executed test
markers, ECR SHA tag and immutable digest were independently read back. No
mutable `latest` tag or service update occurs in those builds.

## API qualification

**Build and automated image tests: PASS.** The exact-source Node 22.23.3 image
passed architecture and OCI source-label assertions, network-disabled packaged
Prisma/sanitize-html/Meri/memory imports, comparison of all 449 packaged migration
hashes with source, and local image digest/ECR equality. See
`api-build-qualification.json` and `api-83304-publication-readback.json` for actual
executed marker lines, times, recipe hash and registry readback.

**Retirement compatibility: PASS for this candidate.** The reviewed runtime
import graph has no restored Hermes modules or use of retired persistence tables.
The packaged native Meri/memory imports also pass in the actual candidate image.
The `serve` command does not run migrations. Legacy release labels are metadata,
not evidence of a restored runtime. See `RETIREMENT-ROLLING-COMPATIBILITY.md` and
its detailed JSON.

**Fresh database and retired upgrade rehearsal: PASS for the identical migration
source.** The actual isolated 449-migration fresh replay passed with exact history
and checksums. The supported isolated retirement/upgrade rehearsal passed its
final qualification after 65 verified steps. The review checked their receipt
hashes, successful exits, schema and prerequisite SQL hashes, and 466 source
files against candidate Git blobs. Earlier partial BLOCKED receipts remain
distinct from the final isolated rehearsal PASS. These are isolated migration
proofs, not a claim that the original production data fingerprint was explained.

**Current schema compatibility: PASS within the reviewed scope.** A fresh
read-only catalog/history check found all 449 API and 13 Workspace migrations
finished and no unfinished failures. Five formerly missing tables exist; their
RLS/forced RLS, relevant constraints, indexes and narrow app privileges are
present. The original historical checksum differences remain recorded. There is
no pending migration to execute. See `SCHEMA-QUALIFICATION.md` and its JSON.

## Web qualification

**Build and automated tests: PASS.** Native ARM64 Node 22.23.3 ran all seven
selected suites, 54/54 tests, followed by typecheck, VNext production build and
the canonical Web Docker build. OCI source/architecture and local/ECR digest
checks passed. See `web-build-qualification.json` and the exact v3 recipe.

**Retirement and rolling compatibility: PASS subject to Web-first ordering.**
The final preview guard rejects incomplete old-API previews and responses,
rechecks before a write, and preserves exact retry identity. The 13 conversion
tests are part of the 54-test AWS result. Independent Hermes/Kimi source review
passed. Actual desktop/mobile image review found the established Research
Portfolio error/control style unchanged, readable and unclipped. That local
mocked-auth fixture is not authenticated production acceptance.

## Additional verification and retained failures

- Deterministic Meri evaluation: 26/26 cases, zero failures/errors; Promptfoo and
  custom verifier exited 0. The actual source was `4277eec813ccb78e339633406f15cafa10711fe4`,
  whose entire Git tree equals API candidate `83304d18`. Later changes affect
  build runtime, wrapper identity, test expectations and documentation only.
- Release operator: 35/35 tests passed, including conservative drift checks,
  uncertain writes, immutable rollback and source-identity preservation.
- Synthetic flag wrapper: 24/24 tests passed after the T2 UUID correction; the
  image-owned flag command was already correct and unchanged.
- First AWS preflight attempts failed because text-formatted ECR pagination
  returned multiple counts. The corrected aggregate JSON check preserves the
  no-existing-tag guard.
- The Node 20 Web attempt failed before tests initialized. Node 22 repairs the
  locked dependency engine mismatch; no tests were skipped to produce a pass.
- The first orchestrator full run failed four stale catalog assertions out of
  1,403 tests. Three test files now enforce the current canonical registry and
  side-effect classification; 33/33 affected tests passed. Independent Kimi
  source review returned PASS, but its CLI exited 1 without an exposed cause.
  That process limitation is preserved; independent Codex source verification
  found no issue. The new full ARM64 build must pass before orchestrator promotion.

## Required promotion and acceptance conditions

1. Promote this compatible Web image before the API. Verify its running digest,
   actual task health, `webSurface=vnext`, source SHA and HTTPS delivery on
   `os.capiro.ai`. Preserve listener configuration and all unrelated environment.
2. Promote the API through the merged guarded operator, retaining a pinned
   rollback task, exact registration/configuration hashes and observed deployment
   identity. Retain the forward database schema on application rollback.
3. Keep `RESEARCH_PORTFOLIO_MERI_TOOLS_ENABLED` absent or false while the older
   Engagement service serves. The existing nine-tenant Meri cohort is preserved.
   The two separately approved synthetic tenant additions use a distinct reviewed
   configuration/flag step with exact prior-state rollback.
4. Promote the orchestrator only after its own exact-source full build, tests,
   final packaged entrypoint/health/auth smoke and digest readback pass.
5. Run bounded authenticated Playwright checks with the two approved ordinary
   synthetic members. No external sends, admin elevation or customer fixtures.
   Record actual results separately; neither this build record nor a healthy ALB
   target constitutes the original plan's full acceptance suite.

At this record's creation, service promotion and authenticated live acceptance
are **NOT RUN**. Subsequent promotion receipts and acceptance results must identify
the actual service revision, source and digest; do not infer them from this file.
