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

## 15. SAM producer

```bash
# READ-ONLY (dry run)
... "command":["generate-sam-opportunity-candidates"]
# MUTATING — Neo approval
... "command":["generate-sam-opportunity-candidates","--commit"]
```

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
