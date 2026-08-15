# DIBBS/SBIR full-catalog ingestion — resume

Written 2026-08-11, updated 2026-08-12 after a second resume session. Covers the
throttle-wait bug fix (D-75), the image-provenance issue (D-73/D-74), the sync-jobs IAM
role fork (D-72), and three real encounters with an external, account-wide Tango rate
limit (D-76, D-77, D-78) — the third of which meaningfully revised what the first two
suggested. **Read `decision-log.md` D-72 through D-78 before touching any of this** —
every command below assumes you already know why it's shaped this way, and the
"expect this to be slow" framing below is not pessimism, it's the actual observed rate.

## STATUS as of 2026-08-12 (verified via direct DB query, not inferred)

| Table | Rows | Target | % | State |
|---|---|---|---|---|
| `tango_dibbs_solicitation` (rfq) | 13,625 total | ~75,339 | ~18% | in progress |
| `tango_dibbs_solicitation` (rfp) | 1,144 | ~1,147 | **~100%** | **complete: true** |
| `tango_dibbs_award` | 20 (pre-existing bounded-test only) | ~185,518 | 0% | not started |
| `tango_sbir_topic` | 20 (pre-existing bounded-test only) | ~22,480 | 0% | not started |
| `tango_sbir_solicitation` | 173 | ~240 | ~72% | **complete: true** (see the open item below on why it's not 100%) |

RFP and SBIR-solicitations are the first two sub-datasets in this program to reach a
real `complete: true`. Award and SBIR-topics have never had a single page succeed —
every attempt to reach them so far has hit the still-active account-wide block before
the walk got there.

## Why this is slow: a real, external, account-wide rate limit — not a bug, and smaller than first assumed

D-75 fixed a real code bug (an unbounded sleep that hung for 4.5 hours). Once fixed,
**three** separate resume attempts, across two calendar days, each hit the same kind of
block — a `retryAfterSec` value that decreases in lockstep with the fix's 120-second
cap, meaning it's a genuine countdown, not noise. Read D-76 → D-77 → D-78 in order; the
understanding changed as more data came in:

- **D-76 (day 1, attempt 1):** block at ~13,000s (≈3.6h) remaining, after 75 real pages.
- **D-77 (day 1, attempt 2, after the first block cleared):** block at ~70,000s (≈19.7h)
  remaining, after 24 more real pages. Read at the time as "a large daily allowance that
  gets bigger the more you use it that day."
- **D-78 (day 2, fresh day):** after only RFP (13 pages, now complete) and SBIR
  solicitations (3 pages, now complete) plus a few seconds of RFQ, the block came back
  again — at ~26,000s (≈7.3h). **This revises D-77's read.** A "large daily allowance"
  hypothesis does not explain the block reappearing after such a small amount of
  activity on a fresh day. The more defensible read now: **whatever the real daily
  ceiling is, it's small enough that completing something RFP-sized exhausts most or
  all of it.**

**Practical consequence: budget for roughly one RFP-or-SBIR-solicitations-sized chunk
of real progress per calendar day**, not "most of the catalog." At that pace, RFQ (754
pages total, ~131 done as of this writing) and Award (1,856 pages, 0 done) will each
take many separate days, spread thin. If that pace is unacceptable, the actual fix is
asking MakeGov support what this account's real tier is — nothing in the plan, the
SDK, or `dibbs-sbir-rest-contract.md` documents a limit anywhere near what's actually
being observed; the published contract only describes "~25 requests per ~31 seconds,"
a completely different, much shorter window this account also has and respects
separately.

## Before resuming: check whether the block has actually cleared

**Do not launch a full walk blind.** Run a one-record probe first — it costs a single
request and immediately tells you the real state:

```bash
export AWS_PROFILE=capiro-dev
export MSYS_NO_PATHCONV=1
NETCFG='awsvpcConfiguration={subnets=[subnet-0e38bd390f8961fef,subnet-0920665f91c905f01,subnet-06db79cd21239de19],securityGroups=[sg-01def4e5c0fe44d4a],assignPublicIp=DISABLED}'
ARN=$(aws ecs run-task --region us-east-1 --cluster capiro-dev --task-definition capiro-dev-api-sync-jobs:11 --launch-type FARGATE \
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
(each retry is itself a real request against whatever quota caused this). **Given D-78's
finding, "later" may mean a different calendar day, not a few hours.**

## Spread requests across endpoints — don't let RFQ eat the whole day's budget again

**This is the actual strategy now, not just a nice-to-have.** Twice (D-76, D-77) the
walk defaulted to RFQ-first (`DIBBS_ENDPOINTS = ['rfq', 'rfp', 'award']`) and burned the
day's entire usable budget on RFQ alone, leaving RFP, Award, and SBIR at zero. On day 2,
deliberately running the SMALL endpoints first got RFP and SBIR-solicitations to
`complete: true` for the first time — proof this approach works. Keep doing it:

1. **Remaining small target: none left as of 2026-08-12** — RFP and SBIR-solicitations
   are both done. The next-smallest remaining unit of work is a BOUNDED slice of RFQ,
   Award, or SBIR-topics via `--limit=<n>` (see below), not a full unbounded walk of
   any of the two large ones.
2. Use `--endpoint=<name>` to target one dataset at a time — this is a real, existing
   flag (`parseEndpoints` in both sync scripts), not something to add.
3. Use `--limit=<n>` to bound how many records ONE run consumes, so you can rotate
   through RFQ / Award / SBIR-topics in smaller passes across a day rather than letting
   whichever one goes first consume everything before the block hits. A few thousand
   records (a few dozen pages) per pass, per dataset, mirrors what RFP/SBIR-sol actually
   got done in one day.
4. If a run is making real progress and you want to deliberately stop it early to give
   another endpoint a turn, `aws ecs stop-task` is safe — each page's upsert is
   independent and idempotent on the provider's `uuid`/natural key, so a mid-walk stop
   loses no correctness, only the pages not yet fetched.

```bash
# example: a bounded RFQ pass, not the full unbounded --full walk
--overrides '{"containerOverrides":[{"name":"api-sync-jobs","command":["sync-tango-dibbs","--endpoint=rfq","--commit","--limit=3000"]}]}'
# example: give Award its first-ever attempt, bounded
--overrides '{"containerOverrides":[{"name":"api-sync-jobs","command":["sync-tango-dibbs","--endpoint=award","--commit","--limit=3000"]}]}'
# example: give SBIR topics its first-ever attempt, bounded
--overrides '{"containerOverrides":[{"name":"api-sync-jobs","command":["sync-tango-sbir","--endpoint=topic","--commit","--limit=3000"]}]}'
```

**Once an endpoint is small enough to plausibly finish in one day (RFP-scale, SBIR-
solicitations-scale), drop `--limit` and use `--full` instead** to let it actually reach
`complete: true` rather than stopping short right before the finish line.

## `--full` vs the plain incremental form — still applies once you're not bounding by `--limit`

`sync-tango-dibbs.ts`/`sync-tango-sbir.ts` keep no checkpoint (D-63) — the incremental
window is derived from the newest date **already stored**. Once RFQ/Award/SBIR-topics
have SOME real rows (as RFQ now does), a plain `--commit` with no `--full` and no
`--limit` would derive a window near the newest stored date and skip the entire older
backlog still unfetched. Keep using `--full` for any run intended to page the WHOLE
remaining backlog of an endpoint — `--limit` and `--full` compose fine together
(`--full --limit=3000` ignores the window AND stops after 3,000 processed records,
which is exactly the "bounded pass at the true backlog, not just recent records" shape
you want here).

## `capiro-dev-api-sync-jobs:11` — what it is, and the ECR-pruning risk is now CONFIRMED, not hypothetical

Revision 11's image is pinned by digest —
`967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/api@sha256:d5030bffee59569a716e000cb4527be86c4f0c717c95fbe1b2606ba6a9abd181`,
built from commit `ac1e9c2ecf32c5e272ab0db9ea8d0ed3a7823718` (confirmed to still
contain D-75's fix via `git merge-base --is-ancestor 971ddc9f ac1e9c2e...`). It replaces
revision 10, whose pinned digest (from 2026-08-10) **was pruned from ECR within two
days** — `CannotPullContainerError: ... not found` on an otherwise-correct task launch.
This is not a hypothetical risk anymore; it happened exactly as the first version of
this doc warned it might.

**If revision 11 is more than a few days old when you read this, assume its digest may
also be gone and rebuild before trusting it:**

```bash
export AWS_PROFILE=capiro-dev
aws ecr describe-images --repository-name capiro/dev/api \
  --image-ids imageTag=ac1e9c2ecf32c5e272ab0db9ea8d0ed3a7823718 --region us-east-1 \
  --query "imageDetails[0].imagePushedAt" --output text
# if this errors ("not found") rather than returning a timestamp, rebuild:
cd /path/to/a/clean/detached/checkout/of/main  # e.g. a `git worktree add --detach` off origin/main
git fetch origin main && git checkout --detach origin/main
SHA=$(git rev-parse HEAD)
aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin 967807252336.dkr.ecr.us-east-1.amazonaws.com
docker buildx build --platform linux/arm64 -f apps/api/Dockerfile \
  -t 967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/api:latest \
  -t 967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/api:$SHA --push .
# then verify the NEW digest via describe-images before registering a new task-def revision
```

Register a new revision pinned to the freshly-verified digest; don't reuse a stale
revision number's image field and assume it still resolves.

## Polling, correctly (a real lesson, not a style preference)

A single long-lived `run_in_background` bash loop polling for hours is unreliable — its
own local process can be reaped well before the actual ECS task finishes, producing a
misleading "completed" notification for the WRAPPER, not the task. Use short, fresh,
independent `aws ecs describe-tasks` calls spaced a reasonable interval apart, not one
giant polling script — 2-5 minutes is plenty for a bounded `--limit`-ed pass; 10-20
minutes for anything left unbounded.

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

## Open item, not yet investigated: 66 SBIR-solicitation rows errored on the DB write itself

SBIR solicitations reached `complete: true` (3/3 pages, 240 processed) but only 173 of
240 actually wrote — 66 threw inside `upsertSolicitation` and one was dropped for a
missing required field. `walkEndpoint`'s catch block swallows the exception without
logging it (`catch { summary.errored += 1; summary.written -= 1; }` — no
`console.error`, no captured message), so the real cause is unknown from the run's own
output. This is NOT rate-limiting (`rateLimited: false` on that run) — it's a separate,
real DB-level failure on roughly 27% of processed SBIR solicitation rows. Before
assuming a cause (a likely candidate: a NOT NULL or CHECK constraint the mapper doesn't
account for on some subset of real responses — SBIR was captured live only 5 records
per endpoint before this, D-71, far short of 240), add temporary error logging to the
catch block, re-run against the SAME endpoint (cheap — only 3 pages), capture the real
error message, then decide whether it's a mapper bug or a genuine source-data
irregularity.

## Verifying progress independently — don't trust a run's own summary alone

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

- `TANGO_DIBBS_SYNC_DONE` reports `complete: true` for `rfq` AND `award` (RFP already
  is). `TANGO_SBIR_SYNC_DONE` reports `complete: true` for `topic` (`solicitation`
  already is, modulo the 66-error open item above).
- Independently verified row counts land near the documented targets above (exact
  counts will drift slightly — the provider's catalog changes daily; "near" is
  expected, "18%" is not).
- Given the observed pace (roughly one RFP-sized chunk per day), expect this to take
  MANY separate resume sessions, not a handful — budget calendar time accordingly, or
  escalate to MakeGov support about the account's real tier if that pace isn't
  acceptable. Don't treat "it's taking many days" as itself a sign something's broken;
  D-78 already established that's the observed normal rate.
