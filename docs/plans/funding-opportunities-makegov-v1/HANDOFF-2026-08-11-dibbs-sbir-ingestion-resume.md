# DIBBS/SBIR full-catalog ingestion — resume

Written at the close of the session that fixed the throttle-wait bug (D-75), fixed the
image-provenance issue (D-73/D-74), forked the sync-jobs IAM role (D-72), and ran the
ingestion far enough to hit a real, external, account-wide Tango rate limit twice
(D-76, D-77). **Read `decision-log.md` D-72 through D-77 before touching any of
this** — every command below assumes you already know why it's shaped this way.

## STATUS as of 2026-08-11 (verified via direct DB query, not inferred)

| Table | Rows | Target | % |
|---|---|---|---|
| `tango_dibbs_solicitation` (rfq) | 9,920 (9,900 this session + 20 pre-existing bounded-test rows) | ~75,339 | ~13% |
| `tango_dibbs_solicitation` (rfp) | 0 real rows | ~1,147 | 0% |
| `tango_dibbs_award` | 20 (pre-existing bounded-test only) | ~185,518 | 0% |
| `tango_sbir_topic` | 20 (pre-existing bounded-test only) | ~22,480 | 0% |
| `tango_sbir_solicitation` | 20 (pre-existing bounded-test only) | ~240 | 0% |

RFQ is DIBBS_ENDPOINTS' first endpoint (`['rfq', 'rfp', 'award']` in
`sync-tango-dibbs.ts`) — RFP and Award have never had a single page succeed, because
the account-wide block was already in effect by the time the walk reached them both
times this was attempted. SBIR has not been attempted at all this session, deliberately
(same account/key as DIBBS — see D-76).

## Why this stopped: a real, external, account-wide rate limit — not a bug

D-75 fixed a real code bug (an unbounded sleep that hung for 4.5 hours). Once fixed, two
separate full-walk attempts each made real progress and then hit the SAME kind of block
again — a `retryAfterSec` value in the tens of thousands, decreasing in lockstep with
the fix's 120-second cap, meaning it's a genuine countdown, not noise:

- Attempt 1: block reported ~13,000s (≈3.6h) remaining. RFQ got 75 pages (7,500 rows)
  before exhausting retries.
- Attempt 2 (after confirming the first block had cleared): 24 more pages (2,400 more
  rows), then blocked again at ~70,000s (≈19.7h) remaining — about 5x larger.

**Two data points, read together, look like a daily (or similarly long,
calendar-anchored) quota that gets a bigger remaining-time value the more the account
is used in a day** — this is a working hypothesis (D-77), not a confirmed fact. Nothing
in the plan, the SDK, or `dibbs-sbir-rest-contract.md` documents a limit anywhere near
this size; the published contract only describes "~25 requests per ~31 seconds," which
is a completely different, much shorter window that this account also has and respects
separately.

## Before resuming: check whether the block has actually cleared

**Do not launch the full walk blind.** Run a one-record probe first — it costs a single
request and immediately tells you the real state:

```bash
export AWS_PROFILE=capiro-dev
export MSYS_NO_PATHCONV=1
NETCFG='awsvpcConfiguration={subnets=[subnet-0e38bd390f8961fef,subnet-0920665f91c905f01,subnet-06db79cd21239de19],securityGroups=[sg-01def4e5c0fe44d4a],assignPublicIp=DISABLED}'
ARN=$(aws ecs run-task --region us-east-1 --cluster capiro-dev --task-definition capiro-dev-api-sync-jobs:10 --launch-type FARGATE \
  --overrides '{"containerOverrides":[{"name":"api-sync-jobs","command":["sync-tango-dibbs","--endpoint=rfq","--limit=1"]}]}' \
  --network-configuration "$NETCFG" --started-by "resume-probe" --query "tasks[0].taskArn" --output text)
TID="${ARN##*/}"
# poll until STOPPED (see "Polling, correctly" below), then:
aws logs get-log-events --region us-east-1 --log-group-name /capiro/dev/api \
  --log-stream-name "sync-jobs/api-sync-jobs/$TID" --start-from-head --query "events[].message" --output text
```

Look for `"rateLimited":false` in the `TANGO_DIBBS_SYNC_DONE` summary. If it's `true`,
the block hasn't cleared — check the `retryAfterSec` value logged on the way there for a
real estimate of remaining wait, and come back later rather than retrying repeatedly
(each retry is itself a real request against whatever quota caused this).

## Resuming DIBBS — use `--full`, not the plain incremental form

**This is the one mistake most likely to silently under-ingest the catalog.**
`sync-tango-dibbs.ts` keeps no checkpoint (D-63) — its incremental window is derived
from the newest `issue_date`/`issued_date`/`posted_date` **already stored**. Since RFQ
already has 9,900 real rows with real issue dates, a plain `sync-tango-dibbs --commit`
(no `--full`) would derive a window starting near the newest of those dates and skip
every OLDER unfetched record still sitting in the backlog. Keep using `--full` — which
ignores the window and pages the whole catalog, upserting on the provider's `uuid`
(idempotent, so re-fetching already-stored rows is harmless) — until DIBBS reports
`complete: true` on all three endpoints in one run.

```bash
export AWS_PROFILE=capiro-dev
export MSYS_NO_PATHCONV=1
NETCFG='awsvpcConfiguration={subnets=[subnet-0e38bd390f8961fef,subnet-0920665f91c905f01,subnet-06db79cd21239de19],securityGroups=[sg-01def4e5c0fe44d4a],assignPublicIp=DISABLED}'
ARN=$(aws ecs run-task --region us-east-1 --cluster capiro-dev --task-definition capiro-dev-api-sync-jobs:10 --launch-type FARGATE \
  --overrides '{"containerOverrides":[{"name":"api-sync-jobs","command":["sync-tango-dibbs","--commit","--full"]}]}' \
  --network-configuration "$NETCFG" --started-by "dibbs-resume" --query "tasks[0].taskArn" --output text)
```

Then SBIR, only after DIBBS reports `complete: true` on all three endpoints (or you've
made your own call to proceed anyway — but expect it to hit the same account-wide
block immediately if DIBBS just did):

```bash
  --overrides '{"containerOverrides":[{"name":"api-sync-jobs","command":["sync-tango-sbir","--commit","--full"]}]}'
```

## `capiro-dev-api-sync-jobs:10` — what it is and when to rebuild instead of reuse

Revision 10's image is pinned by **digest** (not a mutable tag) —
`967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/api@sha256:460993b83d14affeffed2c12b3f9f489bb7be8c8553e712146f74ce95061ea64`,
built from commit `342d6fa2535c4c402759143272d1da86e30e8ab4`. It includes D-75's fix and
is known-good. **If `main` has moved forward since**, decide deliberately:

- Reusing revision 10 as-is is fine and safe for finishing THIS ingestion — nothing
  about resuming the walk needs anything newer.
- If you want any later fix, rebuild fresh from `main`'s current tip (see
  `docs/runbooks/prisma-migrate-commands.md`'s build steps, same buildx/ECR pattern),
  and **verify the new digest via `aws ecr describe-images` before trusting it** — D-73
  is the whole reason this session stopped trusting `:latest` by name. Register a NEW
  revision pinned to that digest; don't overwrite `capiro-dev-api-sync-jobs:latest`
  and assume anything that resolves it later gets the right thing.

## Polling, correctly (a real lesson from this session, not a style preference)

A single long-lived `run_in_background` bash loop polling for hours is unreliable — its
own local process can be reaped well before the actual ECS task finishes, and you'll get
a misleading "completed" notification for the WRAPPER, not the task. Use short, fresh,
independent `aws ecs describe-tasks` calls spaced a reasonable interval apart (10–20
min for a run expected to take hours), not one giant polling script.

## Watch the logs for the fix actually firing

Every capped wait now logs before it sleeps:

```
TANGO_DIBBS_SYNC_THROTTLE_WAIT {"endpoint":"rfq","page":26,"resetIn":31,"waitMs":31000}
TANGO_DIBBS_SYNC_RATE_LIMIT_RETRY {"attempt":1,"retryAfterSec":70816,"waitMs":120000}
```

A `waitMs` at or under 120000 means the D-75 cap is working. If you ever see a raw,
uncapped multi-hour sleep with no log line preceding it, the fix has regressed — check
`sync-tango-dibbs.ts`/`sync-tango-sbir.ts` for `MAX_PROVIDER_WAIT_MS` before assuming
anything else.

## Verifying progress independently — don't trust the run's own summary alone

```bash
export AWS_PROFILE=capiro-dev
export MSYS_NO_PATHCONV=1
NETCFG='awsvpcConfiguration={subnets=[subnet-0e38bd390f8961fef,subnet-0920665f91c905f01,subnet-06db79cd21239de19],securityGroups=[sg-01def4e5c0fe44d4a],assignPublicIp=DISABLED}'
aws ecs run-task --region us-east-1 --cluster capiro-dev --task-definition capiro-dev-api-diag --launch-type FARGATE \
  --overrides '{"containerOverrides":[{"name":"db-inspect","command":["const { PrismaClient } = require(\"@prisma/client\");\nprocess.env.DATABASE_URL = ` postgresql://${process.env.DB_USER}:${encodeURIComponent(process.env.DB_PASSWORD)}@${process.env.DB_HOST}:${process.env.DB_PORT}/capiro?schema=public`.trim();\nconst prisma = new PrismaClient();\n(async () => {\n  const rows = await prisma.$queryRawUnsafe(`SELECT '\''tango_dibbs_solicitation'\'' AS t, count(*)::int AS n FROM tango_dibbs_solicitation UNION ALL SELECT '\''tango_dibbs_award'\'', count(*)::int FROM tango_dibbs_award UNION ALL SELECT '\''tango_sbir_solicitation'\'', count(*)::int FROM tango_sbir_solicitation UNION ALL SELECT '\''tango_sbir_topic'\'', count(*)::int FROM tango_sbir_topic`);\n  console.log('\''ROWCOUNTS'\'', JSON.stringify(rows));\n  await prisma.$disconnect();\n})().catch(e => { console.error('\''DIAG_ERR'\'', String(e)); process.exit(1); });"]}]}' \
  --network-configuration "$NETCFG" --started-by "rowcount-check" --query "tasks[0].taskArn" --output text
```

(A cleaner copy of this override JSON, plus a version that also samples the 3 most
recent rows per table, lived in this session's scratchpad at
`diag-rowcount-overrides.json` — not committed to the repo; recreate it from the
snippet above if you don't have that file.)

## Acceptance — how you know this phase is actually done

- `TANGO_DIBBS_SYNC_DONE` reports `complete: true` for `rfq`, `rfp`, AND `award` in the
  same run (or across runs, as long as each endpoint independently reaches `complete:
  true` — they're tracked separately, D-63/D-75's endpoint-scoped counters exist for
  exactly this).
- `TANGO_SBIR_SYNC_DONE` reports `complete: true` for `topic` and `solicitation`.
- Independently verified row counts land near the documented targets above (exact
  counts will drift slightly — the provider's catalog changes daily; "near" is
  expected, "13%" is not).
- If either walk NEVER reaches `complete: true` after several resume attempts across
  several days, that itself is a finding worth a new decision-log entry — it would mean
  the daily-quota hypothesis (D-77) is wrong, or the quota is smaller than the catalog
  requires to page through in one day even at full throughput, which would need
  escalating to MakeGov support rather than more retries.
