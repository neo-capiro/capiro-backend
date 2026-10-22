# A1 review: surviving guard mutations

The new tests execute the real `HillDaySourceService.requireClient`, `getClient`,
document admission and get/list/job/export callers. Each caller first succeeds
for its active owner, then refuses or filters the same resource after its client
wall is revoked. Removed/suspended membership and inactive-tenant rows are
refused even when the client wall itself allows access.

The generation test runs six units through the real job loop. After the first
two admitted units start, the fixture revokes the wall. The remaining units
never reach the model seam, and the job fails instead of claiming completion.
The draft test refuses a nonempty display name without a UUID with 409 before
either draft or document writes, while retaining firm-level null association.

All tests run under **`apps/workspace/jest.config.cjs`**, without the private docs
runner. After restoring every mutant, **44/44 tests in three suites pass**:
the nine new guard cases and all 35 resolution tests. `guards-evidence.json`
records the command, runtime, test hashes, failed test names and limits.

| Mutant | Behavioral failures |
| --- | --- |
| B8: omit the wall predicate | 4: get, list, job, export admit the revoked row |
| B9: omit active-membership denial | 3: removed, suspended and inactive-tenant identities resolve |
| B10: omit per-unit admission | 1: generation continues through units 3–6 after revocation |
| B22b: omit name-only create refusal | 1: the invalid draft is persisted instead of returning 409 |
| Omit missing-document/actor admission | 2: missing-document refusal loses its 404 and another actor reads relationships |

All five mutations were restored byte-for-byte. B8 retains the null-client
check and B9 uses an erased non-null assertion solely to keep the mutants
type-correct, so their recorded failures are runtime behavior failures.

These tests use controlled Prisma result rows, not a live database. No SQL or
external operation was executed. Model/context work and PDF rendering remain
inert seams. Cached dependencies and an isolated build of the repository's
shared package were used; clean locked-install, native PostgreSQL/RLS, full
build and deployment qualification remain separate gates. Signed-file
serve-time revocation coverage is recorded by its separate review correction.
