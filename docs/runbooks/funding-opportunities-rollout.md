# Runbook — Funding Opportunities rollout

**Nothing in this runbook has been executed.** Every step below is a proposal. No
migration has been applied by this work, no image deployed, no flag written, no
producer run, no schedule created or enabled. Steps marked **MUTATING** require
Neo's explicit approval before they are run.

Read-only steps are safe at any time and several are useful on their own — they
answer "is this going to work here" before anything changes.

This replaces the prior version of this file, which referenced PR #667 (long since
merged), the pre-remediation command set, and a step numbering that no longer
matches the work.

## What this rollout covers

| | |
|---|---|
| Branch | `agent/fo-final-remediation-v2` |
| PR | `#692 — fix(intelligence): finish Funding Opportunities remediation` |
| Superseded | `#680` (transport artifacts only — see §25) |
| New migration | `20260810040000_funding_opportunities_lifecycle_truth` |
| Already applied | `20260810010000_funding_opportunities`, `20260810020000_funding_opportunities_closeout` |
| Feature flag | `intel_feature_flag.feature = 'funding_opportunities'` |
| CI gate | `.github/workflows/funding-opportunities-ci.yml` |

### Source rails this feature depends on

| Verb | What it fills | Ledger source |
|---|---|---|
| `sync-grants` | `federal_grant`, the 10 fields search2 returns | `sync-grants` |
| `enrich-grant-details` | everything a user decides on (award ceiling, eligibility text, revision, amendment count) | `enrich-grant-details` |
| `sync-sam-opportunities` | `sam_opportunity`, DoD scope | `sync-sam-opportunities` |
| `sync-sam-opportunities-all-federal` | `sam_opportunity`, all federal | `sync-sam-opportunities-all-federal` |
| either scope with `--backfill` | historical windows | `…-backfill` — **separate**, see §12 |
| `generate-funding-grant-candidates` | grant suggestions | same verb |
| `generate-sam-opportunity-candidates` | contract suggestions | same verb |
| `process-funding-opportunity-lifecycle` | expiry + lifecycle alerts | same verb |

`enrich-grant-details` is a **dependency**, not a nice-to-have. `sync-grants`
populates ten fields; the award ceiling, eligibility text and amendment counters
the producers score on and the page renders come only from the detail fetch. A green
catalog rail with a dead enricher renders as "this grant has no award ceiling"
rather than "we have not fetched it". Since this change the freshness card reports
the two independently.

## Environment reminders (from prior incidents)

- **`capiro-dev` IS production.** There is no separate prod cluster.
- **`capiro-staging`'s ECS cluster does not actually exist**, despite CloudFormation
  reporting `CREATE_COMPLETE`. Never treat it as a deploy target without verifying live.
- **Do NOT run `cdk deploy Capiro-dev-Compute`.** That stack holds dead-ALB values;
  a rollback reverts production DNS (7-minute outage, 2026-07-2x).
- Deploys go via CI + `aws ecs update-service`, profile `capiro-dev`.
- One-off task defs: `capiro-dev-api-diag` (read-only, container `db-inspect`),
  `capiro-dev-api-migrate`, `capiro-dev-api-sync-jobs`. Log group `/capiro/dev/api`.
- A diag/one-off task must compose `DATABASE_URL` itself and, for RLS-forced
  tables, `SELECT set_config('app.bypass_rls','on',true)`.
- `intel_feature_flag.tenant_id` is **TEXT** — never cast it to uuid.
- `run-task` networking:
  `subnets=[subnet-0e38bd390f8961fef,subnet-0920665f91c905f01,subnet-06db79cd21239de19]`,
  `securityGroups=[sg-01def4e5c0fe44d4a]`, `assignPublicIp=DISABLED`.
- `aws ecs run-task` / `update-service` and `gh pr merge` are classifier-blocked in
  the agent shell; Neo runs those via `!`.

---

# Part A — read-only preflight

## 1. Aurora snapshot

```bash
# MUTATING (creates a snapshot; alters no data) — Neo approval
aws rds describe-db-clusters --profile capiro-dev --region us-east-1 \
  --query 'DBClusters[?DBClusterIdentifier==`<cluster>`].[DBClusterIdentifier,Status,EarliestRestorableTime,LatestRestorableTime]'

aws rds create-db-cluster-snapshot --profile capiro-dev --region us-east-1 \
  --db-cluster-identifier <cluster> \
  --db-cluster-snapshot-identifier pre-fo-final-$(date +%Y%m%d%H%M)
```

Aurora keeps continuous backups, so PITR exists without this. Take it anyway: the
restore window is the thing you want to be *certain* about before a migration, not
the thing you want to look up during one.

## 2. Migration preflight — is the schema this code needs actually there?

```bash
# READ-ONLY. Uses the read-only diag task; never a *-migrate task def.
pnpm --filter @capiro/api exec tsx scripts/verify-migrations.ts --live --service=api --profile=capiro-dev
```

Before §4 this MUST report `20260810040000_funding_opportunities_lifecycle_truth` as
**absent**, and the two earlier funding migrations as **present**. Anything else:
stop and find out why.

This step exists because of F0 (2026-07-27): LegiWatch Gate E was merged, built,
deployed and digest-verified, and still 500'd for every tenant because its
migrations were never applied. A green ECS digest proves the right *image* is
running. It does not prove the schema that image needs exists.

### Funding Opportunities migrations, in apply order

| Migration | Phase | What it adds |
|---|---|---|
| `20260810010000_funding_opportunities` | pre-program | `client_funding_opportunity`, RLS, the two partial unique indexes |
| `20260810020000_funding_opportunities_closeout` | pre-program | closeout fields |
| `20260810040000_funding_opportunities_lifecycle_truth` | pre-program | lifecycle snapshot columns + 3 indexes |
| `20260819010000_funding_opportunity_decisions` | P07 | 6 nullable decision columns, 3 CHECKs, partial decision index |
| `20260820010000_funding_opportunity_generic_source` | P13 | `source_record_type` / `source_record_key`, widened vocabulary, expanded exclusivity CHECK, partial generic unique index |

All are additive and forward-only. **None may be rolled back by dropping a column.**

#### P13 specifically

Ordering matters and the safe order is the normal one: **migration first, API
second.** The two new columns are nullable and, for the two legacy sources,
optional — so an API still running pre-P13 code keeps inserting rows with only the
legacy pointer, and the CHECK admits them. New code reads either form and backfills
the generic pair the first time it touches such a row.

The one-shot backfill inside the migration is idempotent (`WHERE source_record_key
IS NULL`). After applying, confirm it reached everything:

```sql
-- READ-ONLY. Expect 0 and 0.
SELECT count(*) AS missing_generic_identity
  FROM client_funding_opportunity
 WHERE source IN ('grants_gov','sam_gov')
   AND (source_record_key IS NULL OR source_record_type IS NULL);

SELECT count(*) AS generic_disagrees_with_legacy
  FROM client_funding_opportunity
 WHERE source IN ('grants_gov','sam_gov')
   AND source_record_key <> coalesce(grant_opportunity_id, sam_opportunity_id::text);
```

A non-zero first count after the API has fully rolled means rows were written by
pre-P13 code during the deploy window; re-running the two `UPDATE` statements from
the migration file is safe and fixes it. A non-zero second count is a real defect —
stop and investigate, do not "repair" it.

### The Tango adapter (P14) — nothing to deploy differently

`src/external/tango/` and the `@makegov/tango-node` dependency ship in this
merge. There is no live call path: `TangoModule` registers unconditionally and
every gateway method throws `TangoNotConfiguredError` until `TANGO_API_KEY`
exists (P16 wires the config; P17 is the first phase that reads a real key).
Nothing here changes the deploy sequence below — verify the API still boots with
no `TANGO_API_KEY` set, which is the same as verifying nothing at all changed.

### The Tango substrate (P15) — a migration, still nothing that writes

`tango_resource_snapshot`, `tango_resource_link`, `tango_sync_checkpoint` and
`tango_api_usage` ship in migration `20260821010000_tango_source_substrate`.
Apply it in the normal migration step (§4/§86 below) whenever this merge is
deployed — it is additive, and none of the four tables carry a `tenant_id` or RLS,
so applying it changes nothing any tenant can observe.

`TangoStoreService` (the code that reads and writes these tables) is registered
in `TangoModule` but **nothing calls it yet** — that starts at P19. There is no
data to inspect and no schedule to check after this migration lands.

```sql
-- READ-ONLY, post-migration. Expect all 4 rows, all with rls_enabled = f.
SELECT relname, relrowsecurity AS rls_enabled
  FROM pg_class
 WHERE relname IN ('tango_resource_snapshot','tango_resource_link','tango_sync_checkpoint','tango_api_usage');
```

### Config and secret wiring (P16) — code merged, nothing live changes

`apps/api/src/config/config.schema.ts` gained `TANGO_API_KEY` (optional),
`TANGO_API_BASE_URL` (HTTPS-enforced), and the timeout/page-size/ceiling/
circuit-breaker values P18 will read. `infra/cdk/lib/config.ts`'s dev
`externalSecretArns.tangoApiKey` now holds the real ARN for the `tango` secret
(created out-of-band, provenance in decision-log D-26).

**None of this takes effect until the next `cdk deploy`,** and per the plan's
own instruction this phase does not run one — live task-definition wiring
waits until P17 is ready to actually use the key. If a deploy DOES happen for
an unrelated reason after this merges, `TANGO_API_KEY` will be injected onto
the `capiro-<env>-api-sync-jobs` task only; verify with:

```bash
# READ-ONLY. Confirms placement without needing a real ecs run-task.
aws ecs describe-task-definition --profile capiro-dev --region us-east-1   --task-definition capiro-dev-api-sync-jobs   --query "taskDefinition.containerDefinitions[0].secrets[?name=='TANGO_API_KEY']"
# Expect ONE entry. The same query against capiro-dev-api (serve) and
# capiro-dev-api-migrate must return an EMPTY array.
```

This is also proven at synth time, unconditionally, by
`pnpm --filter @capiro/infra-cdk test` (wired into `ci-pr.yml`) — see
decision-log D-25.

### The Tango capability probe (P17) — read-only, run once, evidence attached

`apps/api/src/external/tango/tango-capability-probe.service.ts` and
`apps/api/scripts/diag-tango-capabilities.ts` ship in this merge. Nothing
schedules this automatically — it is a deliberate operator tool, invoked by
hand via `pnpm diag:tango-capabilities` (or `diag-tango-capabilities` through
`entrypoint-dispatcher.inc` on a running task) when a human wants a fresh
read of what the account can currently do. Deploying this merge changes
nothing observable on its own.

It was already run once against the real account as part of this phase's own
acceptance evidence — see decision-log D-29 and
`docs/plans/funding-opportunities-makegov-v1/p17-tango-capability-report.json`.
Re-running it is safe (GET / `limit: 1` calls only, never a create/update/
delete — see the service's class doc for the full "what this must never do"
list) and cheap; do so whenever a later phase (P19–P47) needs to confirm a
capability finding is still current, or after a MakeGov SDK upgrade:

```bash
# READ-ONLY against the real account. Never echoes the key: fetch and inject
# in one command, same pattern as this doc uses everywhere else the real
# secret is needed.
cd apps/api
TANGO_API_KEY="$(aws secretsmanager get-secret-value --secret-id tango --region us-east-1 --profile capiro-dev --query SecretString --output text)" \
  pnpm exec tsx scripts/diag-tango-capabilities.ts --request-ceiling=30
# Add --uei=<a real UEI> --vehicle-uuid=<a real vehicle uuid> to also exercise
# the identifier-gated probes (entities, vehicle_awardees, vehicle_orders,
# budget_flows_by_entity), which the committed evidence report left
# not_attempted — no invented identifier was substituted for them.
```

Expect `authenticationFailed: false` and the same shape of result the
committed report shows. A NEW `unsupported`/`not_found`/`tier_gated` finding
relative to that report is real signal — the account's tier or the SDK's
surface changed — not a flake to retry past.

### Rate-limit, usage, retry, and health controls (P18) — code only, nothing live yet

`tango-resilience.service.ts` (`TANGO_RESILIENT_GATEWAY`), the
`getUsageHealth` addition to `tango-store.service.ts`, and
`diag-tango-health.ts` ship in this merge. No migration — breaker/ceiling
state is in-memory by architecture, not persisted (decision-log D-30).
Nothing calls `TANGO_RESILIENT_GATEWAY` yet; P19 is the first real consumer.
Deploying this merge changes nothing observable.

Once P19+ starts making real calls through it, use this to check on the
integration's recent behavior from a shell — it reads Postgres only, never
the Tango API, and needs no key:

```bash
# READ-ONLY, no key needed. Aggregates the persisted tango_api_usage log.
cd apps/api
pnpm exec tsx scripts/diag-tango-health.ts --window=1440   # last 24 hours
```

Expect `successRate` near 1.0 once real traffic exists; `totalCalls: 0` is
normal and expected before P19 ships. A `byStatus.rate_limit` or
`byStatus.transient` count that keeps growing across repeated checks is
worth investigating BEFORE it trips the circuit breaker on a live run — the
breaker's own thresholds are `TANGO_CIRCUIT_BREAKER_THRESHOLD` /
`_COOLDOWN_MS` (P16, both optional with documented defaults; see
`config.schema.ts`).

### Reviewed-UEI entity shadow sync (P19) — a migration, and the first real Tango sync job

`prisma/migrations/20260822010000_client_tango_entity_sync_status` adds
three additive nullable columns to `clients`
(`tango_entity_last_synced_at`/`_last_attempt_at`/`_last_error`). Apply it in
the normal migration step (§4/§86 below) whenever this merge is deployed —
additive, no backfill, no RLS policy touched.

`scripts/sync-tango-entities.ts` ships but is declared `enabled: false` in
`infra/cdk/lib/ingestion-schedule.ts` (id `SyncTangoEntities`) pending an
internal canary — same posture as every other Funding Opportunities job in
that file. Nothing runs automatically from this deploy.

```sql
-- READ-ONLY, post-migration. Expect all NULL until the sync is run at least once.
SELECT count(*) FILTER (WHERE tango_entity_last_synced_at IS NOT NULL) AS synced,
       count(*) FILTER (WHERE uei IS NOT NULL) AS has_uei,
       count(*) AS total
  FROM clients;
```

To run it by hand once the canary is ready:

```bash
# Dry run first — calls Tango for real (so the reported counts are real) but
# writes nothing locally. Add --commit only after reviewing the summary.
cd apps/api
pnpm exec tsx scripts/sync-tango-entities.ts
TANGO_API_KEY="$(aws secretsmanager get-secret-value --secret-id tango --region us-east-1 --profile capiro-dev --query SecretString --output text)" \
  pnpm exec tsx scripts/sync-tango-entities.ts --commit --limit=50
```

Expect `errored: 0` on a healthy run. Any non-zero `errored` count is worth
reading `tango_entity_last_error` for on the affected clients before
re-running — see decision-log D-35 for the one already-known, already-fixed
SDK-vs-server incompatibility (`entity_structure`/`state_of_incorporation`,
now permanently excluded from the request) so a future finding isn't
mistaken for a repeat of that one.

### Client profile enrichment review workflow (P20) — a migration, and an interim CLI

`prisma/migrations/20260823010000_client_profile_enrichment_candidates` adds
a NEW tenant-scoped, RLS-enabled table. Apply it in the normal migration
step (§4/§86 below) — additive, no existing table touched.

`scripts/generate-tango-enrichment-candidates.ts` is declared `enabled:
false` in `ingestion-schedule.ts` (id `GenerateTangoEnrichmentCandidates`)
pending canary. It never writes to `clients` — only to
`client_profile_enrichment_candidate` — so enabling it is lower-risk than
most jobs in that file; it is still off by default, same posture as
everything else there.

```sql
-- READ-ONLY, post-migration. Expect 0 rows until the generator has run.
SELECT status, field, count(*) FROM client_profile_enrichment_candidate GROUP BY 1, 2 ORDER BY 1, 2;
```

Reviewing a candidate is a deliberate, one-at-a-time CLI action — there is
no bulk/all flag anywhere in `review-tango-enrichment-candidate.ts`, by
design (this phase's own acceptance bar: no accept-all, especially for
certifications):

```bash
cd apps/api
# See what's pending for one client (or the whole tenant if --client is omitted).
pnpm exec tsx scripts/review-tango-enrichment-candidate.ts --list --tenant=<uuid> --status=pending

# Accept or reject EXACTLY ONE candidate. --reason is required when rejecting.
pnpm exec tsx scripts/review-tango-enrichment-candidate.ts --tenant=<uuid> --candidate=<uuid> --accept --reviewed-by=<userId>
pnpm exec tsx scripts/review-tango-enrichment-candidate.ts --tenant=<uuid> --candidate=<uuid> --reject --reviewed-by=<userId> --reason="not accurate for this client"
```

Accepting applies the proposed value to the client's own field immediately;
rejecting never touches `clients` at all, and — per this phase's own
durability guarantee — the SAME rejected suggestion will not reappear the
next time `generate-tango-enrichment-candidates` runs, even if Tango's data
is re-observed unchanged.

### Versioned Federal Business Profile (P21) — read-only, no migration

`federal-business-profile.service.ts` ships in this merge. Pure read
aggregation over `clients`, `tango_resource_snapshot` (P19/P15), and
`client_profile_enrichment_candidate` (P20) — nothing new is persisted, and
there is no schedule entry because this is a query path, not a job.

```bash
# READ-ONLY. Prints the full versioned profile for one client.
cd apps/api
pnpm exec tsx scripts/diag-federal-business-profile.ts --tenant=<uuid> --client=<uuid>
```

Expect `verified` to be null for a client with no UEI or no Tango sync yet
— that is a normal state, not an error. `history` grows by one entry each
time `sync-tango-entities` observes a real content change for that client's
UEI (P15's versioned-head policy: an unchanged re-observation writes
nothing new).

### Relevant vehicles and past-performance sync (P22) — a migration, and a pagination fix that reaches every prior list sync

`prisma/migrations/20260824010000_client_relevant_vehicle` adds a NEW
tenant-scoped, RLS-enabled table — a MATERIALIZED current summary (self or
parent relationship, order count, IDV obligations/value), not a versioned
history; P15's `tango_resource_snapshot` still carries the full versioned
raw record for both the vehicle and the matching awardee. Apply it in the
normal migration step (§4/§86 below) — additive, no existing table touched.

`scripts/sync-tango-vehicles.ts` is declared `enabled: false` in
`ingestion-schedule.ts` (id `SyncTangoVehicles`) pending canary, same
posture as every other job in that file. It walks EVERY vehicle and every
awardee on it — there is no UEI filter on the provider's list endpoints —
but only writes a row for an awardee matching a UEI Capiro already knows;
the overwhelming majority are read, checked, and discarded.

```sql
-- READ-ONLY, post-migration. Expect 0 rows until the sync has run at least once.
SELECT relationship, count(*) FROM client_relevant_vehicle GROUP BY 1;
```

```bash
# Dry run first — calls Tango for real (so the reported counts are real) but
# writes nothing locally. Add --commit only after reviewing the summary.
cd apps/api
pnpm exec tsx scripts/sync-tango-vehicles.ts --limit=10
TANGO_API_KEY="$(aws secretsmanager get-secret-value --secret-id tango --region us-east-1 --profile capiro-dev --query SecretString --output text)" \
  pnpm exec tsx scripts/sync-tango-vehicles.ts --commit --limit=50
```

Expect `errored: 0` on a healthy run and `completeness: 'complete'` only
once `cursor`/`ceilingReached` genuinely say no vehicles remain — a
`--limit` short of the full ~20k-vehicle catalog correctly reports
`'in_progress'` instead (decision-log D-43 fixed a real bug where hitting
the limit mid-page used to under-report this). `vehiclesRelevant: 0` on a
low-`--limit` run against real data is normal, not a failure signal — most
vehicles belong to no Capiro client, and a small page of the ~20,709 total
is unlikely to contain one by chance.

**Read this before touching pagination anywhere else in the Tango
integration.** This phase's live-key run found that EVERY list endpoint
this gateway calls (`listEntities`, `listOpportunities`, `listNotices`,
`listForecasts`, `listVehicles`, `listVehicleAwardees`) is page-number
pagination server-side, never cursor-based — the SDK's own `.cursor` field
is unconditionally `null` for all six, by its own documented behavior
(decision-log D-42). The fix lives entirely in `tango.client.ts`'s shared
`page()` helper, so it silently repairs pagination for every sync that
walks a list endpoint, past and future — no other file needed to change.
Confirmed NOT to have affected already-merged work: P17's probe never reads
`nextCursor`, and P19's entity sync paginates over Capiro's own `clients`
table via a real Prisma keyset cursor, never calling `listEntities` at all.
P24's forecast sync (`listForecasts`) would have hit the identical wall had
this shipped first.

Also fixed this phase (decision-log D-41): the vehicle-awardee `recipient`
expansion has no parent/owner UEI field on the live server under any
name — confirmed by reading its own `available_fields` payload, not a
naming guess. `recipientParentUei` is therefore always `null` today; the
`relationship = 'parent'` code path is real and tested but not currently
reachable with live data. A future SDK release reaching per-awardee owner
data (or the provider adding the field) is the only thing that changes
that — re-adding `parent_uei` to the shape without re-confirming server
support first will reproduce the original `unknown_field` failure.

### Acquisition-position scoring and UI (P23) — no migration, a new field-level flag

`acquisition-position.ts` ships in this merge, along with the
`acquisitionPosition` field on every `FundingOpportunity` response and a
concise badge + full detail panel in the web app. No migration — it reads
P22's `client_relevant_vehicle` and P15's `tango_resource_snapshot`/
`tango_sync_checkpoint`, all already-existing tables.

**This is gated by a NEW flag, `funding_opportunities_vehicle_fit`, and it
is NOT a route guard.** Unlike `funding_opportunities` and
`funding_opportunities_client_inbox` (which 404 an entire endpoint),
acquisition position is a field inside the already-flagged opportunity
response. With no `intel_feature_flag` row for this flag, every tenant
gets `acquisitionPosition: null` on every opportunity — byte-for-byte the
same shape P22 returned, per this phase's own acceptance bar — so merging
this PR changes nothing for anybody until the flag is explicitly turned on:

```sql
-- Turn it on for one tenant. Same table, same shape, as funding_opportunities itself.
INSERT INTO intel_feature_flag (feature, tenant_id, enabled)
VALUES ('funding_opportunities_vehicle_fit', '<tenant-uuid>', true)
ON CONFLICT (feature, tenant_id) DO UPDATE SET enabled = true;
```

```sql
-- READ-ONLY. Confirm what a tenant will actually see before/after the flag write.
SELECT feature, tenant_id, enabled FROM intel_feature_flag
 WHERE feature IN ('funding_opportunities', 'funding_opportunities_vehicle_fit')
   AND tenant_id = '<tenant-uuid>';
```

**Read this before assuming a client's acquisition position looks wrong.**
The position is a CLIENT posture — computed once from every vehicle P22's
sync found relevant to that client — never a crosswalk from one specific
opportunity to one specific required vehicle (decision-log D-44 explains
why no such crosswalk exists anywhere in this codebase, and why building
one from notice text would be a fabrication this program's own identity
rules already forbid). The same position is attached identically to every
`sam_gov` opportunity for that client; a grant always gets `null`.
`vehicle_not_identified` means the sync ran and found zero relevant
vehicles for this client; `no_direct_access_evidence` means it found some,
but every one is past its own last date to order — these are genuinely
different facts, not two spellings of the same gap. `unknown` means Tango
is not configured or `sync-tango-vehicles` (P22) has never completed a
run — check `tango_sync_checkpoint` for `sync_verb = 'sync-tango-vehicles'`
before assuming a client's own data is the problem.

The `known_teaming_route` state and the recommendation engine's
`vehicleAccessRequired` override are both real, tested code with **no live
trigger today** — the same posture as D-41's dormant `'parent'`
relationship. Neither will appear in a real response until a future phase
adds a teaming-partner data source or a real opportunity-to-vehicle
crosswalk (P27+). Seeing neither in production is expected, not a bug.

### Agency forecast schema and incremental sync (P24) — a migration, ships fully dark

`prisma/migrations/20260825010000_tango_procurement_forecasts` adds a NEW
**global** table (no tenant_id, no RLS — provider catalog data). Apply it
in the normal migration step (§4/§86 below) — additive, no existing table
touched.

`scripts/sync-tango-forecasts.ts` is declared `enabled: false` in
`ingestion-schedule.ts` (id `SyncTangoForecasts`) pending canary.
`funding_opportunities_forecasts` (the flag P26 will eventually read) stays
off regardless of whether this job ever runs — this phase populates
`tango_procurement_forecast`, it does not surface anything. A forecast is
a pre-solicitation signal, never a solicitation or an active competition;
nothing downstream of this table may call it either until P25/P26 exist.

```sql
-- READ-ONLY, post-migration. Expect 0 rows until the sync has run at least once.
SELECT count(*), max(provider_modified_at) FROM tango_procurement_forecast;
```

```bash
# Dry run first — calls Tango for real (so the reported counts are real) but
# writes nothing locally. Omit --limit for a real run: this sync pages to
# EXHAUSTION of its own incremental window by default, unlike P19/P22's
# bounded client-list walks. --limit exists for a deliberate first backfill
# or a bounded test run only.
cd apps/api
pnpm exec tsx scripts/sync-tango-forecasts.ts --limit=50
TANGO_API_KEY="$(aws secretsmanager get-secret-value --secret-id tango --region us-east-1 --profile capiro-dev --query SecretString --output text)" \
  pnpm exec tsx scripts/sync-tango-forecasts.ts --commit
```

Expect `errored: 0` on a healthy run. The FIRST run ever (no
`tango_sync_checkpoint` row for `sync_verb = 'sync-tango-forecasts'`) has no
incremental window at all — `modifiedAfter: null` in the summary — and walks
the full ~25,000-row catalog by design; expect it to take a while
wall-clock-wise and to make on the order of 250 requests (well under the
default 5,000 request ceiling). Every later run is incremental: it reads
the PRIOR run's `window_end`, subtracts a safety overlap (default 4 hours,
`--overlap-hours` to change it), and asks the provider for only what
changed since then. `window_end` only advances on a run that fully
exhausts its own pages — a run stopped by `--limit` or the request ceiling
leaves the window exactly where it was, so a retry continues the same
window rather than silently narrowing it.

**Read this before assuming a stale forecast is a sync bug.**
`tango_procurement_forecast` is a SINGLE CURRENT-STATE table, upserted on
every sync — NOT layered on P15's versioned `tango_resource_snapshot` the
way P19/P20/P22's tables are (decision-log D-46, a deliberate design
choice: the live catalog is ~24,700 rows, an order of magnitude more than
any per-client-narrowed resource this program has synced so far, and a full
version history for a still-planned, frequently-reworded buy is not
something the plan's own acceptance bar asked for). `snapshot` always holds
the MOST RECENT observation, not a history — a query for "how has this
forecast changed over time" has no answer in this table today.

Also fixed this phase (decision-log D-45): the provider's forecast resource
carries a real organization hierarchy, real `modified`/`created`
timestamps, and a structured contact object — none reachable through the
SDK's own typed `listForecasts` method, whose bundled schema does not
declare any of the three. `tango.client.ts`'s `listForecasts` now calls the
SDK's own HTTP transport directly (a documented, deliberate bypass of the
SDK's client-side shape validation only, not of the live server, which
accepts every field without complaint) — the only list method in that file
that needs to. `psc_code` and `source_url` stay as columns for a future
provider release but are confirmed absent from this resource today, same
posture as D-35/D-41's other confirmed-absent fields.

### Forecast recommendation and lifecycle rules (P25) — no migration, no new caller either

`forecast-relevance.ts` ships in this merge: a pure, DB-free scoring
function (`scoreForecastRelevance`), exactly matching this phase's own
plan file list — no new Prisma model, no producer script, no DI-registered
service. **Nothing calls it with real data yet.** That wiring — a producer
proposing `client_funding_opportunity` rows for forecasts relevant to a
real client — is P26+ scope; this phase ships the rules "logic dark," per
its own ship instruction, and decision-log D-47 records exactly why the
file list stops there rather than growing to include a caller.

There is nothing to run or verify live for this phase specifically — the
function takes no network dependency of its own, and its inputs
(`FederalBusinessProfile` from P21, `AcquisitionPosition` from P23, real
forecast data from P24) are each already live-verified in their own
phases. Correctness here rests on the exhaustive unit suite instead: 23
tests plus a 144-case cross-product sweep proving, among other things,
that `machineRecommendation` never once produces `'pursue'` and that the
word "deadline" never appears in any output text on any branch.

**Read this if a forecast-sourced inbox row ever renders "Source record no
longer in the catalog" and you are sure the forecast still exists.** That
was a real, confirmed bug (decision-log D-47) in
`funding-opportunity-inbox.service.ts`'s `titlesFor`, fixed this phase: the
lookup key used to come from the two legacy pointers only, never
consulting P13's own generic `sourceRecordKey` column, so a row addressed
purely through the generic identity always fell through to the "gone"
message. Fixed via `readSourceRecordId` — the same dual-read helper the
row's own `sourceRecordId` field already used two lines away. No
producer writes an `agency_forecast` row today, so if you are seeing this
message on a REAL row, the more likely explanation is still a genuinely
deleted or mistyped forecast id — this fix only changes what happens once
such a row exists at all.

```bash
# READ-ONLY. Confirm the fix's own boundary hasn't drifted: no write path,
# no widened API vocabulary. (Also runs as part of the normal test suite —
# this is for a manual spot-check.)
cd apps/api
pnpm exec jest funding-opportunity-identity.spec.ts --silent
```

### Forecast early-signal UI (P26) — no migration, one NEW flag, ships dark

Adds `funding_opportunities_forecasts` and the surface behind it: a forecast
card in the triage inbox, a forecast detail body, and a read-only forecast
route (`GET /api/intelligence/opportunities/forecasts/:forecastId`) guarded by
that flag. **No tenant has a row for it**, so the route 404s everywhere and the
UI renders nothing — exactly like P23's vehicle-fit flag.

This is also the phase that gives P25's `scoreForecastRelevance` its first real
caller. A forecast is served from its OWN route with its OWN record type and is
never a `FundingOpportunity`: that shape carries a response deadline, an
eligibility determination and money, and a forecast carries none of the three.

```sql
-- READ-ONLY. Expect 0 rows — no tenant has the forecast flag.
SELECT tenant_id, enabled FROM intel_feature_flag
 WHERE feature = 'funding_opportunities_forecasts';
```

```sql
-- MUTATING — Neo approval required. The internal-tenant canary, when wanted.
-- Requires funding_opportunities AND funding_opportunities_client_inbox to be
-- on for the same tenant first; the forecast surface lives inside the inbox.
INSERT INTO intel_feature_flag (tenant_id, feature, enabled)
VALUES ('<internal-tenant-uuid>', 'funding_opportunities_forecasts', true)
ON CONFLICT (tenant_id, feature) DO UPDATE SET enabled = true;
```

**Turning the flag on surfaces nothing on its own.** No producer writes a
forecast `client_funding_opportunity` row, so the inbox will contain no forecast
rows however many `tango_procurement_forecast` records exist. What the flag
enables is (a) the forecast source filter, (b) the forecast detail route for a
directly-addressed forecast id, and (c) the rendering path for a row if one ever
exists. Building the producer is a later, separate decision.

With the flag OFF the inbox WITHHOLDS any forecast row rather than rendering it,
and says how many it withheld — the tab badges count every row the tenant has,
and a page quietly showing fewer rows than its badge reads as a broken filter.

### Tango↔SAM crosswalk and parity ledger (P27) — a migration, no user surface

`prisma/migrations/20260826010000_tango_opportunity_crosswalk` adds ONE new
**global** table, `tango_opportunity_parity` (no tenant_id, no RLS, and no
foreign key — see the migration's own header). Apply it in the normal migration
step (§4 below); additive, no existing table touched.

**This phase writes nothing to `sam_opportunity`, ever.** Plan §4.2 binds here:
first-party ingestion stays authoritative for canonical lifecycle fields, a
Tango observation may verify or identify a conflict, the conflict is RECORDED,
and no "last write wins" merge is permitted. The shadow sync writes exactly
three provider-owned things — P15's `tango_resource_snapshot`, P15's
`tango_resource_link` (basis `exact_identifier`), and the new parity ledger.

```sql
-- READ-ONLY, post-migration. Expect 0 rows until the shadow sync has run.
SELECT count(*) FROM tango_opportunity_parity;
SELECT agreement, count(*) FROM tango_opportunity_parity GROUP BY agreement;
```

```bash
# Dry run first — calls Tango for real (so the reported counts are real) but
# writes nothing locally. --changed-since bounds a first/backfill run; the
# default is 90 days back, because reaching further would report notices that
# predate Capiro's own SAM.gov ingestion as coverage gaps, which they are not.
cd apps/api
pnpm exec tsx scripts/sync-tango-opportunity-shadow.ts --limit=50
TANGO_API_KEY="$(aws secretsmanager get-secret-value --secret-id tango --region us-east-1 --profile capiro-dev --query SecretString --output text)" \
  pnpm exec tsx scripts/sync-tango-opportunity-shadow.ts --commit --limit=200
```

```bash
# READ-ONLY. No Tango call and no key — reads Capiro's own tables only.
# Exits 0 unless a threshold YOU set is breached.
cd apps/api
pnpm exec tsx scripts/diag-tango-opportunity-parity.ts
pnpm exec tsx scripts/diag-tango-opportunity-parity.ts --field=response_deadline --sample=25
```

**Read this before treating `unlinked` as a failure.** A steady population of
provider notices with no local counterpart is the EXPECTED state of a
verification rail: the two catalogs sync on different schedules and cover
slightly different windows. The diagnostic exits nonzero only for an
operator-set `--max-conflicts` / `--max-ambiguous` / `--stale-hours`, and there
is deliberately no flag that makes an ordinary unlinked row blocking.

**Read this before treating `ambiguous` as a bug.** One solicitation number
routinely spans a presolicitation, a solicitation and several amendments, each
its own `sam_opportunity` row. When more than one local notice carries the
provider's number, NOTHING is linked — attaching a provider observation
(including a deadline) to whichever amendment sorted first is how a closed
presolicitation acquires a live deadline. `ambiguous` has its own count in the
diagnostic for exactly this reason.

**A conflict is never resolved by a job.** `resolution` starts `unreviewed` and
moves only through an attributed human review; the database enforces the
three-way all-or-nothing (a reviewed row carries both actor and timestamp, an
unreviewed row carries neither). There is no review CLI in this phase — the
operational default is source precedence, which is already what the code does:
the local value stays canonical whether or not anybody looks.

### Notice history and material-change timeline (P28) — a migration, one NEW flag

`prisma/migrations/20260827010000_tango_opportunity_notice_history` adds ONE
new **global** table, `tango_opportunity_notice` (no tenant_id, no RLS, no FK).
Additive; apply it in the normal migration step below.

Adds `funding_opportunities_notice_history`, which gates the read route
(`GET /api/intelligence/opportunities/:source/:id/timeline`) and the timeline
panel on the detail surface. No tenant has a row, so the route 404s everywhere.

**The timeline is DERIVED on read, never stored.** There is no timeline table
and the CI schema check asserts there is not one — a stored copy alongside its
own inputs is a second thing that can be wrong about them.

**P28 emits nothing.** No alert, no task, no email. Alerting on a material
change is P48's, and neither the classifier nor the read service holds a
dependency through which one could be sent.

```sql
-- READ-ONLY, post-migration. Expect 0 rows until the notice sync has run.
SELECT count(*) AS notices,
       count(*) FILTER (WHERE sam_opportunity_id IS NOT NULL) AS crosswalked
  FROM tango_opportunity_notice;
```

```bash
# Dry run first — calls Tango for real, writes nothing locally.
cd apps/api
pnpm exec tsx scripts/sync-tango-opportunity-notices.ts --limit=50
TANGO_API_KEY="$(aws secretsmanager get-secret-value --secret-id tango --region us-east-1 --profile capiro-dev --query SecretString --output text)" \
  pnpm exec tsx scripts/sync-tango-opportunity-notices.ts --commit --limit=200
```

Expect `errored: 0`. A healthy re-run reports a large `unchanged` count and a
small `written` one — that is the content-hash no-op path working, and it is
what makes the incremental overlap free.

**Read this before treating a low `crosswalked` count as a bug.** A notice is
stamped with a local `sam_opportunity.id` only when EXACTLY ONE local notice
carries its solicitation number, reusing P27's own rule. One number routinely
spans a presolicitation, a solicitation and several amendments, so an ambiguous
number stamps nothing — the notice is still stored and becomes reachable the
moment the ambiguity resolves. The timeline API reports
`coverage: 'not_crosswalked'` for such a solicitation rather than an empty
history, because "we cannot prove which one this is" and "it was never amended"
are different statements.

**Four of the plan's nine change dimensions are not covered**, and the UI says
so rather than omitting them: the SDK's bundled `NOTICE_SCHEMA` declares no
notice type, no place of performance, no contact and no description, so a
change to any of the four cannot be observed from notice history. Whether the
LIVE server carries more than the SDK declares is a decision-log D-45-style
investigation — request a deliberately invalid field and read the
`available_fields` payload the server returns — and it needs a key.

### Attachment metadata and secure archive (P29) — a migration, no flag, no UI

`prisma/migrations/20260829010000_opportunity_attachments` adds ONE new
**global** table, `opportunity_attachment`. Additive; apply it in the normal
migration step below. There is no new feature flag: nothing is surfaced yet, and
the sync is dry-run by default.

**The attachment URLs do not come from the provider.** The installed
`@makegov/tango-node@1.1.0` exposes no attachment *enumeration* — its only
attachment-shaped method is `searchOpportunityAttachments`, a semantic search
that answers "which documents mention X" and cannot answer "what documents does
this solicitation have". The enumerable source is Capiro's own SAM.gov
ingestion: `sam_opportunity.raw.resourceLinks`.

```sql
-- READ-ONLY, post-migration. Expect 0 rows until the sync has run.
SELECT status, count(*) FROM opportunity_attachment GROUP BY status;
```

```bash
# Dry run. Reports what it WOULD discover and transfer; touches nothing.
cd apps/api
pnpm exec tsx scripts/sync-tango-opportunity-attachments.ts

# Metadata only — writes the candidate rows, fetches nothing. Do this before
# any archiving run: seeing the candidate list is how you sanity-check it.
pnpm exec tsx scripts/sync-tango-opportunity-attachments.ts --commit --discover-only

# Archiving. Needs a bucket; refuses to start without one rather than fetching
# megabytes with nowhere to put them.
OPPORTUNITY_ATTACHMENT_BUCKET=capiro-dev-fo-attachments   pnpm exec tsx scripts/sync-tango-opportunity-attachments.ts --commit --limit=25
```

**The bucket is not wired into any task definition.** Same posture P16 took for
the Tango API key: `OPPORTUNITY_ATTACHMENT_BUCKET` is optional config that
nothing in a serve/web/workspace/migrate task reads, and injecting it into the
ephemeral sync task is a deliberate out-of-band step. The bucket itself must
have block-public-access on, default encryption, and versioning; the writer sets
`ServerSideEncryption`, `ACL: private` and a download-only
`Content-Disposition` on every object regardless.

**Read this before retrying a `refused` row.** `refused` and `failed` are
different states on purpose:

- **`refused`** — Capiro declined to go somewhere: a non-HTTPS URL, a
  private-network host, an off-allow-list host, a disallowed or mismatched MIME
  type, too many redirects. **Never retried.** Re-attempting an SSRF target on a
  schedule is the attack working, slowly. Changing the outcome means changing
  the policy, deliberately.
- **`failed`** — the fetch was attempted and did not complete: a timeout, an
  HTTP error, a truncated body, a decompression ratio over the ceiling. Retried
  by the next run.

**`status = 'archived'` is the only state a downstream claim may cite**, and the
database enforces it: an archived row must carry its bucket, key, SHA-256, byte
count and timestamp, and a non-archived row must carry none of the location
fields. A failed fetch cannot mark metadata complete.

**The archive key is the content hash.** Identical bytes re-archive to the
identical key (a free no-op); changed bytes get a *different* key rather than
overwriting. That is what lets a requirement extracted from version A still
resolve to version A's bytes after the agency posts version B.

### Tier-aware extracted-text ingestion (P30) — a migration, no flag, no UI

`prisma/migrations/20260830010000_opportunity_document_text` adds ONE new
**global** table. Additive; apply it in the normal migration step below.

**Read this before concluding a solicitation has no requirements.** An empty
text field has five causes and only one of them is a fact about the document:

| status | what it means | whose gap |
|---|---|---|
| `available` | text is held | — |
| `not_entitled` | the account's plan excludes extracted text | **billing** |
| `not_provided` | the provider has no text — a scanned or image-only file | **the document** |
| `pending` | nobody has run an extraction yet | Capiro |
| `failed` | an extraction was attempted and did not complete | Capiro |

The database refuses a row that could mislead: `available` requires text, a
method and a count, and every other status must hold **no** text — so a
`not_entitled` row cannot carry a leftover body from an entitled period.

**A hard provider limit, recorded rather than worked around.** The installed
`@makegov/tango-node@1.1.0` exposes extracted text through exactly one method,
`searchOpportunityAttachments({ q, topK, includeExtractedText })` — a *semantic
search* taking a query. There is no `getAttachmentText(id)`. "Give me the text
of this document" is not a question this SDK can ask, and inventing a query to
stand in for a document id would bind returned text to an attachment it merely
*resembles* — the fuzzy identity substitution P02 forbids for award history.

So the sync seeds the correct unavailability status and stops there. Finishing
the phase needs either a provider endpoint or a `local_parser` extraction
against the bytes P29 already archived — `extraction_method` exists so that
would be a separately labelled row, never a silent substitute for provider text.

```bash
# Dry run.
cd apps/api
pnpm exec tsx scripts/sync-tango-opportunity-text.ts

# Seed. --entitled ONLY if P17's probe reported extracted text as available on
# this account; the script never asks the provider itself, because re-deriving
# entitlement from a failed call turns one rate-limit into "we lost the plan".
pnpm exec tsx scripts/sync-tango-opportunity-text.ts --commit
pnpm exec tsx scripts/sync-tango-opportunity-text.ts --commit --entitled
```

```sql
-- READ-ONLY. Why there is no text, per document.
SELECT status, extraction_method, count(*)
  FROM opportunity_document_text GROUP BY 1, 2 ORDER BY 1, 2;
```

**Text is bound to bytes.** Every row carries the SHA-256 of the exact
attachment bytes it came from. If the agency reposts a document it archives
under a new hash (P29's key *is* the hash), the old text row stops covering it,
and the uncovered-attachment query correctly picks it up again — which is how a
stale extraction gets replaced rather than silently kept.

### Pursuit pipeline stages (P35) — a migration, a NEW flag, and MIGRATION FIRST is not optional here

**Order: migration, then deploy, then flag.** Not a convention this time — the
column has to exist before any pod that references it starts, or every board read
throws.

```bash
# MUTATING — Neo approval required
aws ecs run-task --profile capiro-dev --region us-east-1   --cluster capiro-dev   --task-definition capiro-dev-api-migrate   --launch-type FARGATE   --network-configuration 'awsvpcConfiguration={subnets=[subnet-0e38bd390f8961fef,subnet-0920665f91c905f01,subnet-06db79cd21239de19],securityGroups=[sg-01def4e5c0fe44d4a],assignPublicIp=DISABLED}'
```

**The migration is safe to apply while the OLD code is running**, which is what
makes the ordering workable rather than a window of downtime:

| Property | Why it matters during the roll |
|---|---|
| `pipeline_stage` NULLABLE, no default | an old pod's INSERT omits it and succeeds; the row honestly has no stage |
| `pipeline_stage_version` NOT NULL DEFAULT 0 | the same INSERT still gets a usable concurrency token |
| new columns are additive, new table is new | nothing an old pod reads or writes changes shape |

**What the backfill does and does not do.** It maps `saved → reviewing`,
`pursuing → pursuing`, `dismissed → passed`, `won → won`, `lost → lost`. It leaves
`suggested` and `expired` rows with **no stage**, deliberately: a machine
suggestion nobody has opened is not a human "reviewing" it, and which stage a row
was in when the source closed underneath it was never recorded. It writes no
transition rows, because a backfill is not a move and inventing an actor would put
somebody's name against a decision they did not make.

```sql
-- READ-ONLY. Verify the mapping and, more importantly, the two DELIBERATE gaps.
SELECT workflow_status, pipeline_stage, count(*)
  FROM client_funding_opportunity
 GROUP BY 1, 2 ORDER BY 1;
-- expect: suggested -> NULL, expired -> NULL, every other status mapped.

-- Every backfilled stage carries a timestamp and NO actor. That NULL is
-- meaningful, not missing: the read reports the stage as DERIVED rather than
-- claiming a person moved it.
SELECT count(*) AS backfilled
  FROM client_funding_opportunity
 WHERE pipeline_stage IS NOT NULL AND pipeline_stage_by_user_id IS NULL;
```

**Then the flag, per tenant, and it is a WRITE surface.**

```sql
-- READ-ONLY. Expect 0 rows before the canary.
SELECT tenant_id, enabled, updated_at
  FROM intel_feature_flag
 WHERE feature = 'funding_opportunities_pipeline_v2';
```

**Flag OFF changes nothing.** The board component renders nothing and issues no
request; the Triage inbox and Explore tabs are byte-identical to today, because
`workflow_status` is still the column every code path writes. That is also the
rollback: turn the flag off and the old fields stay readable and correct.

**Do NOT roll the migration back.** Four additive nullable-or-defaulted columns,
one new table, three indexes. The previous code ignores all of them. Dropping
`pipeline_stage` would destroy every recorded stage move and, worse, the audit
table cascades from `client_funding_opportunity` — so a rollback that dropped the
table would take the record of who moved what with it.

**Two behaviours that will be reported as bugs and are not.**

1. *"A row shows a coarser stage than the one somebody set."* During and after the
   roll, an older pod can move `workflow_status` without moving the stage. The read
   resolves this by letting the legacy status win and labels the card **Derived**
   with an explanation. That is the rolling-deploy rule working, not a lost move.
   Moving the card once records it properly.
2. *"The board says 900 in Reviewing but shows 4 cards."* The counts come from a
   `GROUP BY` over every workflow row; the cards are a bounded window. The column
   says "896 more not shown" rather than implying four is all there is.

**A forecast cannot be pursued or submitted from the board**, matching P26's own
`FORECAST_FORBIDDEN_ACTIONS`. Its cards offer `reviewing`, `qualified` and
`passed` only.

---

### Deterministic action plan (P34) — no migration, NO new flag, and the landscape flag now gates two surfaces

**Nothing to apply.** P34 adds no table, no column and no flag. The plan is
composed from rows P22, P24, P31 and P33 already write, and the accept path is
P08's existing `POST clients/:clientId/opportunities/:source/:id/action`.

**The operationally important part: the blast radius of one existing flag grew.**
`funding_opportunities_government_landscape` gated one read-only panel at P33. It
now also gates `GET opportunities/:source/:id/action-plan` AND the Accept button
that panel renders. Turning that flag on for a tenant therefore enables a surface
that can WRITE — a task plus a workflow decision — where before it only read.

One flag for both is deliberate: an action plan without the landscape it derives
its evidence from is a list of steps nobody can check, so the two are not
independently useful and two flags would mean a way to configure exactly that.
But it does mean a tenant enabled at P33 gains the write path on the deploy that
carries P34, with no second decision. Check who has it before deploying:

```sql
-- READ-ONLY. Expect 0 rows unless somebody enabled the landscape at P33.
SELECT tenant_id, enabled, updated_at
  FROM intel_feature_flag
 WHERE feature = 'funding_opportunities_government_landscape';
```

If a row exists and you are not ready for the write path, set it to `false`
BEFORE the deploy rather than after.

**Nothing is written by opening the page.** The plan route is a GET that composes
and returns; it holds no transaction and creates no row. A task exists only after
a human presses Accept, and that press goes through P08 — same idempotency key,
same pursuit guard, same single transaction. A closed notice is refused there
exactly as it is on the save path, and the plan does not propose pursuing one in
the first place.

**Accepting twice does not make two tasks.** P08's key is
`<source>:<sourceRecordId>:<intent>`, so two `review` actions accepted from one
plan land on ONE task and the second returns it with `reused: true`. This is P08
working as designed, and the panel says so on screen. If an operator reports
"three actions, one task", that is the expected behaviour, not a defect.

**Forecasts are read-only here.** P08's route is bounded to `sam_gov` and
`grants_gov`, so a forecast plan renders its proposals with no Accept control and
an explanation. Do not widen `SourceParamDto` to fix this — the workflow row has
no place to put a forecast, and admitting one would let a forecast id reach
handlers that assume a notice.

---

## 3. Confirm the code is where you think it is

```bash
# READ-ONLY
gh pr view 692 --json headRefOid,mergeable,isDraft,statusCheckRollup
git fetch origin --prune
git log --oneline origin/main..origin/agent/fo-final-remediation-v2
```

Expect: draft, `MERGEABLE`, `funding-opportunities-ci` green.

---

# Part B — mutating: schema

## 4. Apply the migration

```bash
# MUTATING — Neo approval required
aws ecs run-task --profile capiro-dev --region us-east-1 \
  --cluster capiro-dev \
  --task-definition capiro-dev-api-migrate \
  --launch-type FARGATE \
  --network-configuration 'awsvpcConfiguration={subnets=[subnet-0e38bd390f8961fef,subnet-0920665f91c905f01,subnet-06db79cd21239de19],securityGroups=[sg-01def4e5c0fe44d4a],assignPublicIp=DISABLED}'
```

## 5. Schema / RLS / index verification

Re-run §2 and require `OK api`, then verify the objects directly via the read-only
diag task:

```sql
-- The two new snapshot columns. BOTH must be NULLABLE. NULL means "no baseline
-- yet", which the lifecycle pass treats as a SILENT first observation. A NOT NULL
-- default would make every legacy row look already-observed, and the first
-- lifecycle run would alert on the entire corpus.
SELECT column_name, is_nullable, data_type
  FROM information_schema.columns
 WHERE table_name = 'client_funding_opportunity'
   AND column_name IN ('source_fingerprint','source_active_snapshot');
-- expect 2 rows, both is_nullable = YES

-- The lifecycle keyset cursor.
SELECT indexname FROM pg_indexes
 WHERE tablename = 'client_funding_opportunity'
   AND indexname = 'client_funding_opportunity_tenant_cursor_idx';
-- expect 1 row

-- Discovery / enrichment-allocation indexes.
SELECT indexname FROM pg_indexes
 WHERE indexname IN ('federal_grant_lifecycle_enrichment_idx','sam_opportunity_lifecycle_idx');
-- expect 2 rows

-- RLS: unchanged by this migration, re-verified because it is cheap and the
-- consequence of it being wrong is cross-tenant disclosure.
SELECT relname, relrowsecurity, relforcerowsecurity
  FROM pg_class WHERE relname = 'client_funding_opportunity';
-- expect: t, t

SELECT policyname FROM pg_policies WHERE tablename = 'client_funding_opportunity';
-- expect 4: _select, _insert, _update, _delete

SELECT indexname FROM pg_indexes
 WHERE tablename = 'client_funding_opportunity' AND indexname LIKE '%_uniq';
-- expect both partial unique indexes: _grant_uniq, _sam_uniq
```

**Do not skip `relforcerowsecurity`.** RLS enabled but not FORCED leaves the table
owner exempt, and migrations run as the owner — which is how a PE Phase-C backfill
silently no-op'd earlier this month.

---

# Part C — mutating: deploy

## 6. Deploy the API and web

```bash
# MUTATING — Neo approval required. Ship via CI, then roll the services.
aws ecs update-service --profile capiro-dev --region us-east-1 \
  --cluster capiro-dev --service capiro-dev-api --force-new-deployment
aws ecs update-service --profile capiro-dev --region us-east-1 \
  --cluster capiro-dev --service capiro-dev-web --force-new-deployment
```

Then **verify the running digest**, not the task-definition revision. A task
definition that *exists* with the new image is not a service that is *running* it —
the generation gateway looked enabled for a week because rev 60 carried the flag
while the service was still on rev 59.

```bash
aws ecs describe-services --profile capiro-dev --region us-east-1 \
  --cluster capiro-dev --services capiro-dev-api capiro-dev-web \
  --query 'services[].{name:serviceName,taskDef:taskDefinition,running:runningCount,desired:desiredCount}'
```

API and web must roll **together**. The freshness payload gained fields
(`lastAttemptAt`, `lastRunStatus`, `lastFailureAt`, `enrichment`, …) that the new
card renders. An old web against a new API silently drops them; a new web against an
old API renders `undefined`.

---

# Part D — mutating: data repair

Each repair is **dry-run by default**. Run the dry run, read the counts, then commit.
All three are idempotent — a second commit pass reports zero changes.

## 7. SAM promoted-field backfill

```bash
# READ-ONLY (dry run)
aws ecs run-task ... --task-definition capiro-dev-api-sync-jobs \
  --overrides '{"containerOverrides":[{"name":"sync","command":["backfill-sam-opportunity-fields"]}]}'
```

Read `scanned=N updated=M unchanged=K noSourceFields=J`.

`noSourceFields` matters. Those rows' `raw_jsonb` never carried the four fields, so
their `set_aside` stays NULL — and **a NULL set-aside is ambiguous**: either "full
and open" or "we never captured it". That ambiguity is why `evaluateSetAsideEligibility`
refuses to read NULL as unrestricted. If `J` is large, expect notice-stage and
set-aside filtering to be sparse until those notices are re-synced.

```bash
# MUTATING — Neo approval
... "command":["backfill-sam-opportunity-fields","--commit"]
```

## 8. Legacy mapping repair

```bash
# READ-ONLY (dry run)
... "command":["backfill-funding-mapping-review"]
# MUTATING — Neo approval
... "command":["backfill-funding-mapping-review","--commit"]
```

Only an exact client-UEI ↔ source-UEI match is repaired automatically. Name matches,
manual pins without a relationship, parents and subsidiaries stay review-required
and are never guessed.

## 9. Set-aside certification repair

```bash
# READ-ONLY (dry run)
... "command":["repair-set-aside-certifications"]
# MUTATING — Neo approval
... "command":["repair-set-aside-certifications","--commit"]
# Optional narrowing
... "command":["repair-set-aside-certifications","--tenant","<uuid>","--commit"]
```

Read the output carefully:

- `renamed` — SAM solicitation codes mapped to the durable status they imply
  (`SDVOSBC`/`SDVOSBS` → `SDVOSB`, `HZC`/`HZS` → `HUBZONE`, `8AN` → `8A`, …).
- `dropped` — `SBA`/`SBP` and anything unrecognised. **This is intended.** No firm
  holds an "SBA certification"; it is SAM's code for a restriction on a
  solicitation. The honest home for "we are a small business" is the
  `applicant_types` self-report. Every drop is written to `audit_logs` with the
  original array, so nothing is unrecoverable.
- **`⚠️ unrecognized value(s) dropped: …`** — if this line appears, read the values
  before treating the run as complete. It means a vocabulary `set-aside.ts` does not
  know was in use, and one of those strings might be a real certification.

Verify:

```sql
-- No SAM solicitation code should remain in a certification column.
SELECT id, name, set_aside_certifications FROM clients
 WHERE set_aside_certifications && ARRAY['SBA','SBP','8AN','SDVOSBC','SDVOSBS','WOSBSS','EDWOSBSS','HZC','HZS'];
-- expect 0 rows after --commit
```

---

# Part E — mutating: ingestion

## 10. Grants.gov all-status reconciliation

```bash
# MUTATING — Neo approval
... "command":["sync-grants","--all-statuses"]
```

**Known limitation, not a bug to chase:** `--all-statuses` always restarts at page 0,
so a single pass does not complete the corpus and the "~8 Sundays per pass" model in
older notes is wrong. Treat this as "advance coverage", not "finish".

## 11. Grants.gov detail enrichment

```bash
# MUTATING — Neo approval
... "command":["enrich-grant-details","--limit","300"]
```

Since this change every run **reserves capacity for both populations** and logs the
split:

```
[enrich-grant-details] budget limit=300 pursuable=210 historical=90
```

That line is the thing to check. Before this change the pass took `limit` pursuable
rows first and only topped up from the archived tail if fewer existed — and because
pursuable rows are re-enriched forever on a stalest-first cycle to catch amendments,
that pool permanently exceeds 300, so the 72,689 archived rows were never touched
again. **If `historical=0` while a large archived backlog exists, something has
regressed.**

`--limit` is now validated: a non-integer or non-positive value fails **before** the
SyncRun row is opened, rather than dying inside Prisma after the ledger already
recorded an attempt.

## 12. All-federal SAM bounded backfill

```bash
# MUTATING — Neo approval. BOTH bounds are now REQUIRED.
... "command":["sync-sam-opportunities","--all-federal","--backfill",
               "--since","2024-07-01","--posted-to","2025-06-30","--commit"]
```

Three things changed here and all three matter operationally:

1. **`--backfill` refuses to run without explicit `--since` AND `--posted-to`.** It
   used to fall through to the watermark or the default 2-day lookback, so a command
   whose whole purpose was "ingest this past year" quietly ingested the last two days
   and reported success.
2. **A backfill writes to its own ledger source** (`…-all-federal-backfill`). It
   previously shared the daily's source, and `runWithSyncRun` derives the incremental
   window from the last successful run's `startedAt` — which for a backfill is *now*.
   So a completed backfill pushed the next daily window forward to the backfill's
   start instant, and everything posted since the previous daily was skipped
   permanently.
3. **Dates are validated.** `--posted-to 2026-02-30` is rejected rather than silently
   becoming "now".

Watch for `⚠️ INCOMPLETE`: the page budget ran out with records left. Narrow the
window or raise `SAM_MAX_PAGES`; the tail was **not** ingested and the run closes
`success_with_errors` so the watermark is not trusted for that window.

## 13. Exact contractor matching

```bash
# READ-ONLY (dry run)
... "command":["match-contractor-identifiers"]
# MUTATING — Neo approval
... "command":["match-contractor-identifiers","--commit"]
```

---

# Part F — mutating: producers and lifecycle

## 14. Grant producer

```bash
# READ-ONLY (dry run) — creates NO SyncRun row
... "command":["generate-funding-grant-candidates"]
# MUTATING — Neo approval
... "command":["generate-funding-grant-candidates","--commit"]
```

### Coverage is now algorithmic (P03)

`OPPORTUNITY_SCAN_CAP` (4,000) and `CLIENT_CAP` (500) are gone. Both dimensions
are walked with deterministic keyset pages (`id > cursor ORDER BY id`), so the run
covers the whole corpus rather than the first N rows by close date.

Read the last line of the run output:

```text
coverage=COMPLETE   clients=<n> grants=<n>     -> the whole corpus was evaluated
coverage=INCOMPLETE                            -> a runaway guard tripped
```

`INCOMPLETE` is **not** the old `CAPPED`. It sets `complete: false` on the
SyncRun, which `statusFromCounts` records as `partial`, and
`lastSuccessfulWatermark` only reads `status='success'` — so a partial run does
not advance the incremental watermark and the unseen tail stays retryable.

There is no cap to raise. Finish the walk from where it stopped:

```bash
# The INCOMPLETE warning prints the exact cursor.
... "command":["generate-funding-grant-candidates","--resume-client","<cursor>"]
```

The cursor is carried by the operator (it is printed and persisted in the
SyncRun's `incompleteReason`), not stored in a dedicated column — P03 ships no
migration. Re-running from a cursor is safe: the walk resumes at `id > cursor`,
and every write is find-then-branch, so nothing is duplicated.

**Expect this run to be slower than the pre-P03 one and to create more
suggestions**, for two independent reasons: it now evaluates every grant instead
of 4,000, and P01/P02 corrected award-history identity. Compare a dry run against
the previous run's counts before committing.

## 15. SAM producer

```bash
# READ-ONLY (dry run)
... "command":["generate-sam-opportunity-candidates"]
# MUTATING — Neo approval
... "command":["generate-sam-opportunity-candidates","--commit"]
```

### Coverage is now algorithmic (P04)

Same contract as §14, same words, same `--resume-client` flag — deliberately, so
one operator habit covers both producers.

```text
coverage=COMPLETE clients=<n> notices=<n> pursuable=<n>
coverage=INCOMPLETE
```

`SAM_OPPORTUNITY_SCAN_CAP` and `SAM_CANDIDATE_CLIENT_CAP` **no longer exist**.
They were env-overridable purely so an operator could raise the cap for a full
sweep; with a keyset walk every run is a full sweep, so setting them now does
nothing. Remove them from any task definition that carries them.

**This is the run whose cost changes most.** Measured on `capiro-dev` on
2026-07-29 there were 17,915 active in-deadline notices against a 4,000 bound, so
this producer previously evaluated ~22% of the corpus. It will now evaluate all of
it: expect roughly 4.5x the pairs, and a corresponding rise in `created`.

`pursuable` is reported separately from `notices` because award and special notices
are excluded from the scored set entirely. A corpus that is entirely informational
is `COMPLETE` with `evaluated=0` — which is a fully covered run, not a truncated
one, and is exactly what the old `capped` flag could not express.

Before committing, dry-run and compare `created` against the last run. A large
jump is expected here for three independent reasons (full corpus, P01 profile
unification, P02 identity correction) and none of them is a defect.

## 16. Lifecycle pass

```bash
# READ-ONLY (dry run)
... "command":["process-funding-opportunity-lifecycle"]
```

The dry run now reports what a commit **would** create, having consulted the alert
table — so `alerts=0 would create` genuinely means "no new alerts". It creates no
SyncRun row.

**Expect a large `baselined=` count on the first run, and `alerts=0`:**

```
[process-funding-opportunity-lifecycle] DRY RUN tenants=1 evaluated=412 alerts=0 would create expired=0 baselined=412 errors=0
[process-funding-opportunity-lifecycle] 412 row(s) received a first-observation baseline; change detection for those starts on the next run.
```

That is the intended behaviour, not a failure. A row with no stored fingerprint has
never been observed by this pass, so it gets a **silent** baseline — without that
rule the first run alerts on every tracked row in every tenant, because "no previous
value" compares unequal to every present value.

```bash
# MUTATING — Neo approval
... "command":["process-funding-opportunity-lifecycle","--commit"]
```

**Run it twice, on separate days, and require the second run to be quiet.** The
first commit establishes baselines; the second is the one that proves the anti-spam
behaviour in production. A second run that emits alerts on unchanged notices is the
old defect resurfacing, and the schedule must not be enabled.

---

# Part G — rollout

## 16b. Triage inbox flag (P10)

The inbox is gated on a SECOND flag, `funding_opportunities_client_inbox`, and it
stays off after §17 turns the master flag on. Two flags on purpose: a tenant already
using the raw catalog must keep it while the inbox is canaried, and turning the inbox
on must never be a side effect of turning the feature on.

```sql
-- MUTATING — Neo approval. Note tenant_id is TEXT; do NOT cast to uuid.
INSERT INTO intel_feature_flag (tenant_id, feature, enabled)
VALUES ('<capiro-internal-uuid>', 'funding_opportunities_client_inbox', true)
ON CONFLICT (tenant_id, feature) DO UPDATE SET enabled = true;
```

Before enabling it, confirm the endpoint is dark:

```bash
# Expect 404 while the flag is absent — the same 404 a disabled master flag gives,
# so the route leaks nothing about whether the feature exists.
curl -sS -o /dev/null -w '%{http_code}
'   -H "Authorization: Bearer <token>"   https://<host>/api/intelligence/opportunities/inbox
```

After enabling, check the wall holds. Pick a client with `memory_wall = true` and a
user with no `client_memory_access` grant: that client's rows must not appear in the
inbox for that user. A walled client with zero grants is invisible to everyone,
admins included — that is by construction, and it is the property most worth
re-verifying on live data.

Counts of `-1` in the response mean a count query failed, not that a queue is empty.
`countsUnavailableReason` says why.

### What turning this flag on actually changes (P11)

The flag now controls the **default view**, not just an endpoint. With it on, the
Funding Opportunities page lands on the triage inbox; the raw catalog becomes a
second tab, `Explore federal opportunities`. With it off the page is byte-identical
to P10 — no view switcher, and it does not call the inbox route at all.

Deploy API and web **together** for this phase: the UI sends two query parameters
(`clientId`, `source`) that the inbox route only accepts from P11 onwards. An older
API with the newer web would reject them with a 400.

Checks worth running once the flag is on for the internal tenant:

```bash
# 1. The selected-client narrowing is applied SERVER-side. The response echoes what
#    it actually applied — this is the field to trust, not the request.
curl -sS -H "Authorization: Bearer <token>"   "https://<host>/api/intelligence/opportunities/inbox?clientId=<visible-client-uuid>"   | jq '{applied: .clientId, rows: (.rows | length), counts, countsAllClients}'

# 2. A WALLED client id must come back as clientId: null with the cross-client list,
#    NOT as a 404 — a 404 would confirm the client exists.
curl -sS -H "Authorization: Bearer <token>"   "https://<host>/api/intelligence/opportunities/inbox?clientId=<walled-client-uuid>"   | jq '.clientId'   # expect: null

# 3. An unknown source IS a 400. Unlike clientId there is no privacy reason to
#    soften it, and silently widening to every rail is the worse answer.
curl -sS -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer <token>"   "https://<host>/api/intelligence/opportunities/inbox?source=fpds"   # expect: 400
```

Rollback for the UI is the flag alone: set `enabled = false` and the page returns to
the raw catalog on the next load. A user sitting on a `?view=inbox` URL falls back to
Explore rather than breaking, so no bookmark needs fixing.

### The detail surface (P12)

`/intelligence/opportunities/:source/:sourceRecordId?clientId=<uuid>` is a real
route from P12 onwards. It is gated on the MASTER `funding_opportunities` flag only,
not on the inbox flag — a detail link has to keep working for a tenant that is on
the catalog. It reads the existing `GET /opportunities/:source/:id`, which has been
deployed since before this program started, so there is nothing new to smoke-test on
the API side.

Five of its eight sections are placeholders until later phases fill them
(acquisition position P23, government landscape P33, requirements P29–P31, notice
timeline P28, full assessment P32). Each says "Not yet available" and names what it
will hold. If a reviewer reports these as bugs, they are the shell working as
designed — see decision-log D-15.

```bash
# A stale or wrong record id must return the record-does-not-exist state, not a
# blank page. The API answers 404; the page renders "No such opportunity".
curl -sS -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer <token>"   "https://<host>/api/intelligence/opportunities/sam_gov/00000000-0000-0000-0000-000000000000"   # expect: 404
```

Rollback is reverting the route and the two components. There is no data, schema or
flag change to undo.

## 17. Internal feature flag

```bash
# MUTATING — Neo approval. capiro-internal only.
... --task-definition capiro-dev-api-diag \
    "command":["set-tenant-flag","--tenant","<capiro-internal-uuid>","--feature","funding_opportunities","--enabled","true"]
```

`intel_feature_flag.tenant_id` is **TEXT**. Do not cast it to uuid.

```sql
SELECT tenant_id, feature, enabled FROM intel_feature_flag
 WHERE feature = 'funding_opportunities';
```

## 18. Admin canary

On `app-dev.capiro.ai`, signed in as an admin on `capiro-internal`:

1. Intelligence → Funding Opportunities loads with no console error.
2. The freshness row shows **both** rails plus a `Grant details:` tag. Read it: if it
   says `enrichment FAILING`, §11 has not run or is broken, and the list will be
   missing award ceilings and eligibility text.
3. Default view shows **no** award notices and **no** expired grants. Spot-check the
   soonest-deadline rows: every one must have a deadline in the future. Before this
   change the row cap was consumed by long-expired notices and the open ones fell off
   the end, so this is the single most informative check on the page.
4. Filter Notice type → Award notice. Award notices appear. Each shows **no Pursue
   button**, **no Create task**, and the line "This notice is informational, so it can
   be saved for reference but not pursued."
5. On an unsaved suggestion: ⋯ → **Assign owner**. It must succeed and the card must
   become `Saved`. This is the fix for the 404 that made assign/note/site impossible
   on every suggestion.
6. ⋯ → Add note, then ⋯ → Link project site. Both succeed.
7. Pursue a live solicitation. It moves to `Pursuing` and sorts to the top.
8. Dismiss, then Restore. Restore lands on `Saved`, not `Suggested`.
9. Audit trail:

```sql
SELECT action, entity_type, occurred_at FROM audit_logs
 WHERE entity_type = 'client_funding_opportunity'
 ORDER BY occurred_at DESC LIMIT 20;
-- expect one row per action you just took
```

## 19. Standard-user canary

Repeat 1–8 as a non-admin member of the same tenant. Everything above must work;
nothing admin-only should appear.

## 20. Portal denial

As a portal user, `/intelligence/opportunities` must be **denied**, not empty. An
empty page is indistinguishable from "there is no federal money for you".

## 21. Second-tenant isolation

With the flag OFF for a second tenant, confirm the route is denied there. Then, as a
user of the second tenant, confirm no `client_funding_opportunity` row belonging to
`capiro-internal` is reachable by id.

## 22. Freshness checks

```sql
-- What the card reads. A rail that failed last night must show status='error' HERE
-- and on the page, even though an older success exists.
SELECT source, status, error_count, started_at, finished_at
  FROM sync_run
 WHERE source IN ('sync-grants','enrich-grant-details',
                  'sync-sam-opportunities','sync-sam-opportunities-all-federal',
                  'sync-sam-opportunities-backfill','sync-sam-opportunities-all-federal-backfill',
                  'generate-funding-grant-candidates','generate-sam-opportunity-candidates',
                  'process-funding-opportunity-lifecycle')
 ORDER BY started_at DESC LIMIT 40;
```

**Confirm no SyncRun row exists for any dry run you performed.** A dry run that
created one would have advanced that rail's watermark — the defect §12 fixes.

## 23. Alert-noise checks

```sql
-- Alerts by event type since the lifecycle pass first committed.
SELECT metadata->>'eventType' AS event_type, count(*)
  FROM clio_proactive_alert
 WHERE source_type = 'funding_opportunity'
   AND created_at > now() - interval '3 days'
 GROUP BY 1 ORDER BY 2 DESC;

-- The specific regression to watch for: an `amended` alert on a row whose source did
-- not change. Should be EMPTY after a second identical pass.
SELECT a.title, a.created_at, w.workflow_status
  FROM clio_proactive_alert a
  JOIN client_funding_opportunity w ON w.id = (a.metadata->>'workflowId')::uuid
 WHERE a.source_type = 'funding_opportunity'
   AND a.metadata->>'eventType' = 'amended'
   AND a.created_at > now() - interval '1 day';

-- No alert may exist for a non-tracked status.
SELECT w.workflow_status, count(*)
  FROM clio_proactive_alert a
  JOIN client_funding_opportunity w ON w.id = (a.metadata->>'workflowId')::uuid
 WHERE a.source_type = 'funding_opportunity'
 GROUP BY 1;
-- expect ONLY 'saved' and 'pursuing'
```

## 24. Data-integrity SQL

```sql
-- Exactly one source pointer per row (CHECK-enforced; verified anyway).
SELECT count(*) FROM client_funding_opportunity
 WHERE (grant_opportunity_id IS NULL) = (sam_opportunity_id IS NULL);
-- expect 0

-- No workflow row points at a missing catalog record.
SELECT count(*) FROM client_funding_opportunity w
 LEFT JOIN federal_grant g ON g.id = w.grant_opportunity_id
 LEFT JOIN sam_opportunity s ON s.id = w.sam_opportunity_id
 WHERE (w.grant_opportunity_id IS NOT NULL AND g.id IS NULL)
    OR (w.sam_opportunity_id IS NOT NULL AND s.id IS NULL);
-- expect 0

-- No informational notice is marked pursuing.
SELECT count(*) FROM client_funding_opportunity w
  JOIN sam_opportunity s ON s.id = w.sam_opportunity_id
 WHERE w.workflow_status = 'pursuing'
   AND (lower(s.notice_type) LIKE '%award%' OR lower(s.notice_type) LIKE '%special notice%');
-- expect 0

-- The producer never overwrote a human decision.
SELECT count(*) FROM client_funding_opportunity
 WHERE user_created = true AND evidence_source_type = 'deterministic_relevance_v1';
-- expect 0

-- Baseline coverage after two lifecycle runs.
SELECT count(*) FILTER (WHERE source_fingerprint IS NULL) AS unbaselined, count(*) AS total
  FROM client_funding_opportunity;
-- `unbaselined` should be 0, or only rows created since the last run
```

## 25. Schedules, and closing #680

**Create schedules DISABLED. Enable only after §16's two-run quiet test passes.**

The Funding Opportunities schedules created for #675 were deliberately created
disabled and that canary was never run. Do not enable the lifecycle schedule until a
second consecutive committed lifecycle run has been observed to be quiet in
production — an alert channel that fires on unchanged notices every night trains
users to ignore it, which is worse than no channel.

```bash
# MUTATING — Neo approval, per rule
aws events put-rule --profile capiro-dev --region us-east-1 --state DISABLED ...
aws events enable-rule --profile capiro-dev --region us-east-1 --name <rule>
```

Order of enablement: catalog syncs → enricher → producers → lifecycle. Each layer
depends on the one above having run at least once.

**PR #680** carries only transport artifacts (`.github/remediation/*.b64` and a
temporary source-export workflow) and no application change. Its base64 stream is
also corrupt mid-patch, so nothing in it is salvageable. Close it as superseded by
#692 — but only once #692 is complete; closing it earlier discards the record of what
was attempted while the replacement is still unfinished.

---

# Part H — rollback

## 26. Rollback

**Code** — roll the services back to the previous task-definition revision.

```bash
# MUTATING — Neo approval
aws ecs update-service --profile capiro-dev --region us-east-1 \
  --cluster capiro-dev --service capiro-dev-api --task-definition capiro-dev-api:<previous-rev>
aws ecs update-service --profile capiro-dev --region us-east-1 \
  --cluster capiro-dev --service capiro-dev-web --task-definition capiro-dev-web:<previous-rev>
```

Roll **both**, for the same reason they deploy together (§6).

**Flag** — the fastest and safest kill switch. Setting `funding_opportunities` to
`false` removes the surface entirely without touching data or schema. Prefer this to
a code rollback for anything user-visible.

**Migration** — **do not roll back.** `20260810040000` is additive and nullable: two
columns and three indexes. The previous code ignores all five, so leaving them is
harmless, whereas dropping `source_fingerprint` destroys every lifecycle baseline and
makes the next run alert on the whole corpus.

**Data repairs** — `repair-set-aside-certifications` is reversible from `audit_logs`;
each row carries the original array.

```sql
SELECT entity_id, before->'setAsideCertifications' AS original
  FROM audit_logs
 WHERE action = 'client.set_aside_certifications.repaired'
 ORDER BY occurred_at DESC;
```

**Alerts** — lifecycle alerts are deduped on `source_id`, so deleting a batch is
safe: the pass will not recreate them unless the source genuinely changed again.

**Hard boundary, restated:** do not deploy the drifted `Capiro-dev-Compute` stack
under any circumstances, including rollback.
