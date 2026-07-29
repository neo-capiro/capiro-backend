# Runbook — Funding Opportunities rollout

**Nothing in this runbook has been executed.** Every step below is a proposal.
No migration has been applied, no image deployed, no flag written, no producer run,
no EventBridge rule created. Where a step is marked MUTATING it requires Neo's
explicit approval before it is run.

Read-only steps are safe to run at any time and are useful on their own — several
of them answer "is this feature even going to work here" before anything is changed.

Environment reminders (from prior incidents):

- **`capiro-dev` IS production.** There is no separate prod cluster.
- **`capiro-staging`'s ECS cluster does not actually exist**, despite CloudFormation
  reporting `CREATE_COMPLETE`. Never treat it as a deploy target without verifying live.
- **Do NOT run `cdk deploy Capiro-dev-Compute`.** That stack holds dead-ALB values;
  a rollback reverts production DNS (7-minute outage, 2026-07-2x).
- Deploys go via CI + `aws ecs update-service`, profile `capiro-dev`.
- One-off tasks: `capiro-dev-api-diag` (read-only, container `db-inspect`),
  `capiro-dev-api-migrate`, `capiro-dev-api-sync-jobs`. Log group `/capiro/dev/api`.
- A diag/one-off task must compose `DATABASE_URL` itself and, for RLS-forced tables,
  set `app.bypass_rls`. `intel_feature_flag.tenant_id` is **TEXT** — never cast it
  to uuid.

---

## Part A — read-only preflight

### 1. Preflight: confirm the code is where you think it is

```bash
# READ-ONLY
gh pr view 667 --json headRefOid,mergeable,isDraft,statusCheckRollup
git -C <checkout> fetch origin --prune
git -C <checkout> log --oneline origin/main..origin/agent/funding-opportunities-auto-matching
```

Expect: draft, mergeable, branch not behind `main`.

### 2. DB snapshot

```bash
# MUTATING (creates a snapshot; does not alter data) — Neo approval
aws rds describe-db-clusters --profile capiro-dev --region us-east-1 \
  --query 'DBClusters[?DBClusterIdentifier==`<cluster>`].[DBClusterIdentifier,Status,EarliestRestorableTime,LatestRestorableTime]'

aws rds create-db-cluster-snapshot --profile capiro-dev --region us-east-1 \
  --db-cluster-identifier <cluster> \
  --db-cluster-snapshot-identifier pre-funding-opportunities-$(date +%Y%m%d%H%M)
```

Aurora keeps continuous backups, so a point-in-time restore is available without
this. Take it anyway: the restore window is the thing you want to be *certain*
about before a migration, not the thing you want to look up during one.

### 3. Migration status — is the schema this code needs actually there?

```bash
# READ-ONLY. Runs the read-only diag task; never a *-migrate task def.
pnpm --filter @capiro/api exec tsx scripts/verify-migrations.ts --live --service=api --profile=capiro-dev
```

Before step 4 this MUST report `20260810010000_funding_opportunities` as
**absent**. If it reports anything else, stop and find out why.

This step exists because of F0 (2026-07-27): Gate E was merged, built, deployed and
digest-verified, and still 500'd for every tenant because its migrations were never
applied. A green ECS digest proves the right *image* is running. It does not prove
the schema that image needs exists.

---

## Part B — mutating: schema

### 4. Apply the migration

```bash
# MUTATING — Neo approval required
aws ecs run-task --profile capiro-dev --region us-east-1 \
  --cluster capiro-dev \
  --task-definition capiro-dev-api-migrate \
  --launch-type FARGATE \
  --network-configuration 'awsvpcConfiguration={subnets=[subnet-0e38bd390f8961fef,subnet-0920665f91c905f01,subnet-06db79cd21239de19],securityGroups=[sg-01def4e5c0fe44d4a],assignPublicIp=DISABLED}'
```

Then re-run step 3 and require `OK api`, and verify the objects directly:

```sql
-- via the read-only diag task
SELECT relname, relrowsecurity, relforcerowsecurity
  FROM pg_class WHERE relname = 'client_funding_opportunity';
-- expect: t, t

SELECT policyname FROM pg_policies WHERE tablename = 'client_funding_opportunity';
-- expect 4: _select, _insert, _update, _delete

SELECT indexname FROM pg_indexes
 WHERE tablename = 'client_funding_opportunity' AND indexname LIKE '%_uniq';
-- expect both partial unique indexes: _grant_uniq, _sam_uniq

SELECT column_name FROM information_schema.columns
 WHERE table_name = 'sam_opportunity'
   AND column_name IN ('base_type','sub_agency','set_aside','set_aside_code');
-- expect 4 rows

SELECT column_name FROM information_schema.columns
 WHERE table_name = 'client_intel_mapping'
   AND column_name IN ('match_basis','match_tier','match_evidence_jsonb','relationship_type','roll_up_awards');
-- expect 5 rows
```

**Do not skip the `relforcerowsecurity` check.** A tenant table with RLS enabled
but not FORCED leaves the table owner exempt.

### 5. Promote the SAM source fields (dry run first)

```bash
# READ-ONLY (dry run) — reports what WOULD change
aws ecs run-task ... --task-definition capiro-dev-api-sync-jobs \
  --overrides '{"containerOverrides":[{"name":"sync","command":["pnpm","backfill:sam-opportunity-fields"]}]}'
```

Read the log: `scanned=N updated=M unchanged=K noSourceFields=J`.

`noSourceFields` matters. Those rows' `raw_jsonb` never carried the four fields, so
their `set_aside` stays NULL — and **a NULL set-aside is ambiguous**: it means
either "full and open" or "we never captured it". That ambiguity is exactly why
`computeSamEligibility` refuses to read a NULL set-aside as unrestricted. If `J` is
large, expect notice-stage and set-aside filtering to be sparse until those notices
are re-synced.

```bash
# MUTATING — Neo approval required
... --command ["pnpm","backfill:sam-opportunity-fields","--","--commit"]
```

Idempotent: a second pass reports `updated=0`.

---

## Part C — source freshness (read-only, do this BEFORE any producer)

### 6. Are the rails even current?

```sql
SELECT source, status, started_at, finished_at, rows_inserted, rows_updated, error_count
  FROM sync_run
 WHERE source IN ('sync-grants','sync-sam-opportunities')
 ORDER BY started_at DESC LIMIT 10;

SELECT status, count(*) FROM federal_grant GROUP BY status;
SELECT active, count(*) FROM sam_opportunity GROUP BY active;
SELECT count(*) FROM sam_opportunity WHERE set_aside_code IS NOT NULL;
SELECT notice_type, count(*) FROM sam_opportunity GROUP BY notice_type ORDER BY 2 DESC LIMIT 20;
```

If either rail has never completed, **stop**. The producers and the read path will
both correctly report "never synced", but there is nothing to roll out yet.

### 7. Grants.gov sync / reconciliation (only if stale)

```bash
# MUTATING — Neo approval. Daily incremental:
... --command ["pnpm","sync:grants"]
# Weekly all-status reconcile (~11 min for a full 830-page walk):
... --command ["pnpm","sync:grants:reconcile"]
# Detail enrichment — owns every field search2 does not return:
... --command ["pnpm","enrich:grant-details"]
```

### 8. SAM.gov sync / backfill (only if stale)

```bash
# MUTATING — Neo approval. Daily (last ~30 days):
... --command ["pnpm","sync:sam-opportunities","--","--commit"]

# Historical: SAM caps a search span at ~1 year, so walk it in <=1yr windows.
... --command ["pnpm","sync:sam-opportunities","--","--backfill","--since","2025-07-01","--posted-to","2026-06-30","--commit"]
```

Watch for `⚠️ CAPPED` in the log. A capped window means the tail was **not**
ingested; narrow `--posted-to` or raise `SAM_MAX_PAGES`.

---

## Part D — matching, dry runs first

### 9. Exact-identifier contractor matching — DRY RUN

```bash
# READ-ONLY. This dry run writes nothing and reports the read-only verdicts.
... --command ["pnpm","match:contractor-identifiers","--","--tenant","<tenantId>"]
```

Read every `WOULD AUTO-CONFIRM` line and check the pairing by eye. Only an exact,
unique, unambiguous UEI reaches that line — but a UEI stored wrongly on a client
record is still a wrong answer, and this is the only place a human sees it before
it becomes a confirmed identity.

### 10. Grant suggestion producer — DRY RUN

```bash
# READ-ONLY
... --command ["pnpm","generate:grant-opportunity-candidates","--","--tenant","<tenantId>"]
```

Note: its default floor is now **derived** from the scorer's weights, not the old
literal 40. Expect a different absolute number than any historical run; the rule
("an exact prior Assistance Listing alone qualifies") is unchanged.

### 11. SAM suggestion producer — DRY RUN

```bash
# READ-ONLY
... --command ["pnpm","generate:sam-opportunity-candidates","--","--tenant","<tenantId>"]
```

Expect `evaluated=`, `created=`, `refreshed=`, `markedStale=`,
`humanDecisionsPreserved=`. If `⚠️ CAPPED` appears, coverage for that run is
**partial** — say so in the rollout note rather than treating it as a full pass.

Without `--tenant`, this resolves tenants from the `funding_opportunities` flag and
will correctly find **none** until step 13. That is the expected state, and it logs
loudly rather than silently reporting a successful pass over everybody.

### 12. Reviewed commit runs

```bash
# MUTATING — Neo approval, and only after the matching dry-run output has been read
... --command ["pnpm","match:contractor-identifiers","--","--tenant","<tenantId>","--commit"]
... --command ["pnpm","generate:grant-opportunity-candidates","--","--tenant","<tenantId>","--commit"]
... --command ["pnpm","generate:sam-opportunity-candidates","--","--tenant","<tenantId>","--commit"]
```

Verify afterwards:

```sql
SELECT source, workflow_status, evidence_source_type, count(*)
  FROM client_funding_opportunity
 GROUP BY 1,2,3 ORDER BY 4 DESC;
-- Expect ONLY evidence_source_type='deterministic_relevance_v1' with
-- workflow_status='suggested'. Any user_action row at this point would mean a
-- human has already used the surface, which cannot be true before step 14.

SELECT match_basis, match_tier, confirmed, count(*)
  FROM client_intel_mapping WHERE source='contracting'
 GROUP BY 1,2,3 ORDER BY 4 DESC;
-- Every confirmed row should be match_tier=1 (exact_uei or manual_pin), or a
-- legacy row whose basis was never recorded. A confirmed tier-2/4 row means
-- something confirmed a NAME — investigate before proceeding.
```

---

## Part E — schedules (proposal only)

### 13a. Proposed EventBridge schedules — **DO NOT CREATE**

No rule may be created or enabled by this rollout. Recorded here as the proposal:

| Producer | Proposed cadence | Rationale |
| --- | --- | --- |
| `sync:grants` | daily 06:00 UTC | already scheduled; unchanged |
| `enrich:grant-details` | daily 07:00 UTC | already scheduled; unchanged |
| `sync:grants:reconcile` | weekly Sun 08:00 UTC | already scheduled; unchanged |
| `sync:sam-opportunities --commit` | daily 06:30 UTC | 30-day window; unchanged |
| `generate:grant-opportunity-candidates --commit` | daily 09:00 UTC | after both grant jobs |
| **`generate:sam-opportunity-candidates --commit`** | **daily 09:30 UTC** | after the SAM sync; must not overlap it |
| **`match:contractor-identifiers --commit`** | **weekly Mon 05:00 UTC** | contractor identities change slowly; a weekly pass is enough and keeps the review queue small |
| **`backfill:sam-opportunity-fields --commit`** | **one-off, then never** | the live sync writes these fields going forward |

Two ordering constraints, both real: a suggestion producer that runs *before* its
sync scores yesterday's catalog, and two producers writing
`client_funding_opportunity` concurrently would race the partial unique index
(`runWithSyncRun`'s `skipIfRunning` is the primary defence; the index is the
backstop).

### 13b. Auto-expiry (not implemented)

`staleAt` is set by the producer, and the read path already treats a closed source
as not-active — so nothing false is displayed today. Flipping a *suggested* row's
status to `expired` needs a scheduled pass that does not exist yet. Tracked as
rollout blocker RB-6.

---

## Part F — deploy and canary

### 14. Deploy API + web

```bash
# MUTATING — Neo approval required. NEVER `cdk deploy Capiro-dev-Compute`.
# Merge to main, let CI build, then:
aws ecs update-service --profile capiro-dev --region us-east-1 \
  --cluster capiro-dev --service capiro-dev-api --force-new-deployment
aws ecs update-service --profile capiro-dev --region us-east-1 \
  --cluster capiro-dev --service capiro-dev-web --force-new-deployment
```

Verify the running task's image **digest** matches the built digest — a tag match
is not a deploy verification. Then re-run step 3: a green digest with a missing
migration is exactly the F0 failure.

### 15. Internal canary — enable the flag for capiro-internal only

```bash
# MUTATING — Neo approval required. This is the ONLY thing that turns the
# feature on anywhere; there is no implicit internal-tenant fallback in this guard.
aws ecs run-task ... --task-definition capiro-dev-api-diag \
  --overrides '... enable-feature funding_opportunities <capiro-internal tenantId> ...'
```

`intel_feature_flag.tenant_id` is **TEXT**. Do not cast it to uuid — that cast is
what made District Nexus 404 for a tenant whose flag was genuinely enabled.

Then walk the surface as a `capiro_admin` on capiro-internal:

1. `/intelligence/opportunities` — the nav item appears; the page loads.
2. Freshness strip names both rails with plausible record counts.
3. KPI strip: grants and contracts counted separately, **no dollar figure at all**.
4. A grant card shows "Award ceiling" (or "Program funding"); a SAM card shows
   "Contract value — Not stated". **No card anywhere shows `$0`.**
5. Relevance and eligibility are two separate badges.
6. A SAM card whose `baseType` differs shows "Was Presolicitation".
7. Save → Pursue → Dismiss → Restore on one opportunity; reload and confirm each
   survived.
8. Deadlines tab shows only items within 30 days.
9. Dismissed tab shows the dismissed one, and it is absent from All.
10. Client Intelligence tab: the Funding Opportunities card renders **even for a
    client with zero matches**, and its empty text names a specific reason.
11. `/settings/intelligence-mappings?source=contracting&clientId=<id>` lands
    preselected, with the candidate panel open and conflicts visible.
12. Narrow the viewport to ~820px: the KPI strip reflows to two rows, the filter
    row wraps, and nothing scrolls horizontally.
13. Keyboard only: Tab reaches every filter and every card action; each has an
    audible/visible name.
14. Break it on purpose — block `/api/intelligence/opportunities` in devtools and
    confirm an **error** renders, not an empty list.

### 16. Standard-user test

Sign in as a `standard_user` on the canary tenant and confirm: the page loads,
save/pursue/dismiss/restore all work, and no mapping-management control is
reachable. Then confirm a `client_portal_user` receives a 403 on
`GET /api/intelligence/opportunities`.

### 17. Second-tenant isolation test

With the flag enabled on ONE tenant only:

```bash
# READ-ONLY
curl -H "Authorization: Bearer <token for tenant B>" https://<host>/api/intelligence/opportunities
# expect 404 (the flag guard), NOT 403 and NOT data
```

Then enable it on a second tenant and verify from tenant B that:

- no opportunity carries tenant A's workflow, notes or owner;
- `SELECT tenant_id, count(*) FROM client_funding_opportunity GROUP BY 1` matches
  what each tenant sees.

### 18. Data-quality checks

```sql
-- No row may reference both sources or neither (the CHECK should make this impossible).
SELECT count(*) FROM client_funding_opportunity
 WHERE (grant_opportunity_id IS NULL) = (sam_opportunity_id IS NULL);
-- expect 0

-- No workflow row may point at a source record that does not exist.
SELECT count(*) FROM client_funding_opportunity c
  LEFT JOIN federal_grant g ON g.id = c.grant_opportunity_id
 WHERE c.source='grants_gov' AND g.id IS NULL;
-- expect 0
SELECT count(*) FROM client_funding_opportunity c
  LEFT JOIN sam_opportunity s ON s.id = c.sam_opportunity_id
 WHERE c.source='sam_gov' AND s.id IS NULL;
-- expect 0

-- A facility link must belong to the same client.
SELECT count(*) FROM client_funding_opportunity c
  JOIN client_facilities f ON f.id = c.facility_id
 WHERE f.client_id <> c.client_id;
-- expect 0

-- An owner must be in the same tenant.
SELECT count(*) FROM client_funding_opportunity c
  JOIN users u ON u.id = c.owner_user_id
 WHERE u.tenant_id <> c.tenant_id;
-- expect 0

-- No confirmed contracting mapping should rest on a NAME.
SELECT count(*) FROM client_intel_mapping
 WHERE source='contracting' AND confirmed=true
   AND match_basis IN ('fuzzy_name','exact_legal_name','exact_legal_name_corroborated');
-- expect 0 for anything created after this release
```

---

## Part G — rollback

### 19a. Turn it off (seconds, no deploy)

```bash
# MUTATING — Neo approval. The fastest and safest rollback.
... enable-feature funding_opportunities <tenantId> false
```

The flag guard 404s every route and the nav item disappears. **No data is lost** —
`client_funding_opportunity` rows persist, so re-enabling restores every saved and
pursued opportunity exactly as it was.

### 19b. Roll back the images

```bash
# MUTATING — Neo approval
aws ecs update-service --profile capiro-dev --cluster capiro-dev \
  --service capiro-dev-api --task-definition <previous revision>
```

### 19c. The migration is NOT rolled back

Deliberately. It is additive: one new table plus nullable columns. Rolling it back
would drop saved pursuit decisions and, because the Prisma client selects the new
`sam_opportunity` columns, dropping them would 500 every notice read. Leave the
schema in place and use 19a.

If the table itself must go (it should not), that is a separate reviewed migration,
not an ad-hoc `DROP`.

---

## Criteria for widening the rollout

Do not enable a second tenant until all of these hold:

1. Steps 15-18 completed on capiro-internal with **no** finding.
2. `set_aside_code` is populated on a meaningful share of active notices — until
   then set-aside filtering and the small-business relevance signal are inert.
3. At least one full week of both suggestion producers with no `⚠️ CAPPED` and no
   growth in `error_count`.
4. `client_intel_mapping` shows **zero** confirmed contracting rows with a
   name-based basis.
5. At least one client on the canary tenant has a confirmed contractor identity AND
   resolvable award history — otherwise the agency/office signals are silent and
   the feature is being judged with half its inputs missing.
6. RB-7 (alert hooks) has an owner and a decision: either implemented, or
   explicitly accepted as absent for the wider rollout.
7. Someone other than the implementer has walked step 15.
