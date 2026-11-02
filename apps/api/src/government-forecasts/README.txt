Government forecast windows (B8)

Product decisions, 1 November 2026: Unified Agenda publisher-stated proposed-rule
and final-rule months; signed-in staff only in Master/client Calendar; observation
age stale after seven days; separate publisher edition date. Confidence is not
supplied by this source. Neither source status nor a recent fetch is a probability.

Core owns authorization through existing authenticated middleware and RolesGuard
standard_user. These tables contain global public publisher facts, no tenant/client
association or private annotation. Client Calendar labels them global; a user's
selected client does not establish relevance. No anonymous, portal or user-write
endpoint is added. Existing confirmed events/hearings/deadlines are unchanged.

GET /government-forecasts uses from inclusive/to exclusive YYYY-MM-DD bounds,
page/pageSize, includeWithdrawn (both terminal statuses), and includeUndated.
Limit 366 days and100rows/page. Month civil bounds are solely interval-filter
boundaries; no event instant is stored or returned. Unknown periods stay unplaced.
GET /government-forecasts/:id/history returns immutable revisions newest first.
Both endpoints require current ordinary staff authorization.

Producer: parseUnifiedAgenda accepts a qualified XML edition. Exact NPRM and Final
Rule are supported; generic Final Action and ambiguous/repeated milestones are held.
Stable identity is RIN+supported milestone type only while identity remains unique.
An ended identity never automatically reactivates. Explicit publisher historical
action dates produce source_completed, not canonical calendar confirmation. Source
clock bounds guard future or invalid historical dates. Same-snapshot completion is
applied before proceeding withdrawal. Missing entries, elapsed months or check
failure do not imply withdrawal, completion or cancellation.

The SQL migration creates a public source archive, current heads, immutable content
revisions, check records, observation links and first-observed terminal identities.
Terminal identities survive even if no prior approximate window was ever imported;
later same-key projections stay held. Prisma parameterized transactions
archive exact XML by SHA256 and atomically advance heads. Advisory serialization
and original hash/observation identity prevent competing writes and duplicate
revisions. Older editions/check times are rejected. Unchanged content receives an
observation without a new revision. Re-observing an old edition does not change its
publisher-issued date. Failed check receipts are separate and idempotent by time.
Unqualified snapshots fail; accepted/rejected counts expose partial coverage.

Use existing qualified public-data job tooling (no new pipeline/schedule):
  pnpm --filter @capiro/api exec tsx scripts/sync-government-forecasts.ts --help
Default invocation validates a local source snapshot and prints counts without a
database connection. --apply requires DATABASE_URL, actual collection time, edition
and exact SHA256; the sole data/Release owners bind the environment and invocation.
Unknown apply outcome must reconcile that original identity. Do not substitute a
new timestamp to retry. --record-failure is only for a definite source-check failure,
never an unknown database commit. Source fetch/refresh cadence uses the existing
public-data operator's allocated work; this module starts no background job.

Source: https://www.reginfo.gov/public/do/eAgendaXmlReport
Semantics: https://www.reginfo.gov/public/jsp/eAgenda/StaticContent/202510/RiscPreamble.pdf
Preserve actual edition ID202510 separately from the publisher's2026 display label.
RUN_DATE is generation metadata, not an edition publication timestamp.

Deployment order: DB-owner qualified forward migration and application-role grants;
compatible Core; FE consumer. DB qualification must exercise actual concurrent
transaction/replay, rollback, revisions/observations/archive, range/history reads and
current role denial. Unit mocks do not satisfy these checks. Only Release builds
or deploys. No live import or deployed acceptance is established by this source.
