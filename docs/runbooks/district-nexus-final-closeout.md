# District Nexus — final closeout runbook

Ordered operational procedure for PR #635. Every command below was written
against live `capiro-dev` state verified on 2026-07-28; nothing here was run by
the agent that wrote it.

**Account** `967807252336` · **Region** `us-east-1` · **Cluster** `capiro-dev`
· **AWS profile** `capiro-dev` · **Container name in every task def** `api`

> `capiro-dev` **IS** production. There is no separate prod environment.
> `capiro-prod-os-capiro` is defunct.

## How to read this document

Every command is tagged:

| Tag | Meaning |
| --- | --- |
| 🟢 **READ-ONLY** | Safe to run at any time. Mutates nothing. |
| 🔴 **MUTATING** | Changes production data, schema, schedules, or running services. Requires Neo's explicit approval, and several are blocked for the agent by the permission classifier — Neo runs those via `!`. |

Do not run a 🔴 step because the 🟢 step before it looked fine. Each 🔴 step
names its own gate.

---

## Hard boundaries (binding, not advisory)

1. **NEVER `cdk deploy Capiro-dev-Compute`.** CloudFormation holds dead-ALB
   values for the `app.capiro.ai` Route53 records. A failed deploy rolls back to
   them and repeats the 2026-07-25 seven-minute production DNS outage. All
   schedule and service changes here go out-of-band.
2. **Nothing in this runbook enables a tenant feature flag.** `district_nexus_v2`
   stays exactly as it is (on for `capiro-internal` only) unless §11's criteria
   are met and Neo approves.
3. **Never `--commit` an ingestion or cleanup script** without the dry-run
   output from the step immediately above it in hand.
4. Do not touch auth, Clerk, Graph OAuth, or token decryption.

---

## 0. 🟢 Pre-flight

```bash
# 0.1 The app is healthy. Stop here if it is not.
curl -s -o /dev/null -w '%{http_code}\n' https://app.capiro.ai        # expect 200

# 0.2 Services are steady (runningCount == desiredCount, no failed deployments)
MSYS_NO_PATHCONV=1 aws ecs describe-services --profile capiro-dev \
  --cluster capiro-dev --services capiro-dev-api capiro-dev-web capiro-dev-intel-api \
  --query 'services[].{name:serviceName,desired:desiredCount,running:runningCount,status:status}' \
  --output table

# 0.3 Networking the one-off tasks must match (already captured, re-verify)
MSYS_NO_PATHCONV=1 aws ecs describe-services --profile capiro-dev \
  --cluster capiro-dev --services capiro-dev-api \
  --query 'services[0].networkConfiguration.awsvpcConfiguration' --output json
# Verified 2026-07-28:
#   subnets: subnet-0e38bd390f8961fef, subnet-0920665f91c905f01, subnet-06db79cd21239de19
#   securityGroups: sg-01def4e5c0fe44d4a
#   assignPublicIp: DISABLED
```

Export these once; every `run-task` below reuses them:

```bash
export AWS_PROFILE=capiro-dev
export NETCFG='awsvpcConfiguration={subnets=[subnet-0e38bd390f8961fef,subnet-0920665f91c905f01,subnet-06db79cd21239de19],securityGroups=[sg-01def4e5c0fe44d4a],assignPublicIp=DISABLED}'
```

---

## 1. 🔴 Database backup

Aurora is in a private subnet; there is no direct psql path from a workstation.
Take a manual cluster snapshot before the migration.

```bash
# 1.1 🟢 Find the cluster id
MSYS_NO_PATHCONV=1 aws rds describe-db-clusters --profile capiro-dev \
  --query 'DBClusters[].DBClusterIdentifier' --output text

# 1.2 🔴 MUTATING (creates a snapshot; does not alter data)
MSYS_NO_PATHCONV=1 aws rds create-db-cluster-snapshot --profile capiro-dev \
  --db-cluster-identifier <cluster-id> \
  --db-cluster-snapshot-identifier dn-closeout-pre-migration-20260728

# 1.3 🟢 Wait for it to be available before proceeding
MSYS_NO_PATHCONV=1 aws rds describe-db-cluster-snapshots --profile capiro-dev \
  --db-cluster-snapshot-identifier dn-closeout-pre-migration-20260728 \
  --query 'DBClusterSnapshots[0].Status' --output text            # expect "available"
```

**Gate:** do not run §3 until §1.3 prints `available`.

---

## 2. 🟢 Migration status

This branch adds **one** migration:
`20260808010000_client_grant_nexus_manual_award_unique`.

There is also **at least one older migration on `main` that has never been
applied** — `20260806010000_client_grant_nexus_producer_unique` (the CDK entry
for `GenerateGrantOpportunityCandidates` says so in a source comment). Confirm
the real pending set rather than assuming it is only ours:

```bash
MSYS_NO_PATHCONV=1 aws ecs run-task --profile capiro-dev \
  --cluster capiro-dev --launch-type FARGATE --network-configuration "$NETCFG" \
  --task-definition capiro-dev-api-diag \
  --overrides '{"containerOverrides":[{"name":"api","command":["node","-e","const {PrismaClient}=require(\"@prisma/client\");const p=new PrismaClient();p.$queryRawUnsafe(\"SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations ORDER BY started_at DESC LIMIT 20\").then(r=>console.log(JSON.stringify(r,null,1))).finally(()=>p.$disconnect())"]}]}' \
  --query 'tasks[0].taskArn' --output text
```

Then read the log (note `--start-from-head`; without it you get the tail and
silently lose the front of the payload):

```bash
MSYS_NO_PATHCONV=1 PYTHONUTF8=1 aws logs tail /ecs/capiro-dev-api --profile capiro-dev \
  --since 10m --format short
```

Record which of these are absent from `_prisma_migrations`:

- `20260806010000_client_grant_nexus_producer_unique`
- `20260808010000_client_grant_nexus_manual_award_unique`

---

## 3. 🔴 Apply migrations

> The permission classifier blocks `run-task` against `*-migrate` task
> definitions for the agent. **Neo runs this via `!`.**

```bash
MSYS_NO_PATHCONV=1 aws ecs run-task --profile capiro-dev \
  --cluster capiro-dev --launch-type FARGATE --network-configuration "$NETCFG" \
  --task-definition capiro-dev-api-migrate \
  --query 'tasks[0].taskArn' --output text
```

The `migrate` entrypoint runs `prisma migrate deploy` and then re-seeds workflow
templates (idempotent upserts).

**Verify — do not trust the task exit code alone.** Re-run §2's query and
confirm both migration names now have a non-null `finished_at`. A digest-verified
deploy is *not* a verified migration; that conflation caused the 2026-07-27
Gate E incident (a live 500 on Recommendations from two migrations that were
never applied).

Then confirm the index itself exists:

```sql
-- via the §2 diag pattern
SELECT indexname FROM pg_indexes
WHERE tablename = 'client_grant_nexus'
ORDER BY indexname;
-- expect BOTH:
--   client_grant_nexus_producer_unique_idx
--   client_grant_nexus_manual_award_unique_idx
```

**Rollback for this migration only:**

```sql
DROP INDEX IF EXISTS "client_grant_nexus_manual_award_unique_idx";
```

It is a pure index add over zero existing rows (every `client_grant_nexus` row
today is an `opportunity_candidate` with a null `assistance_award_id`, which the
partial predicate excludes). Dropping it cannot lose data; it only returns
duplicate rejection to the advisory `findFirst` path.

---

## 4. Assistance-recipient cleanup

### 4.1 🟢 Dry run (REQUIRED before 4.2)

```bash
MSYS_NO_PATHCONV=1 aws ecs run-task --profile capiro-dev \
  --cluster capiro-dev --launch-type FARGATE --network-configuration "$NETCFG" \
  --task-definition capiro-dev-api-sync \
  --overrides '{"containerOverrides":[{"name":"api","command":["prune-stale-assistance-recipient-candidates"]}]}' \
  --query 'tasks[0].taskArn' --output text
```

Read the log. The output is an audit artifact: one `PRUNE` line per row with the
client name, the matched external name, the confidence, and the verdict, then a
summary line.

**Gate — read the dry-run output before approving 4.2:**

- `scanned` should be in the ballpark of **183** (the 2026-07-27 measurement).
- `pruned` should be roughly **173–179**; the survivors are the exact-name and
  UEI-backed rows.
- `keep_confirmed` **must be 0** — the query excludes confirmed rows, so a
  non-zero value means the filter drifted. **Stop and investigate.**
- Spot-check that the `PRUNE` lines are the known-bad pairs (Olivet University →
  DUKE UNIVERSITY, SANTA ROSA COUNTY → COUNTY OF SANTA CLARA, and similar).

### 4.2 🔴 Approved cleanup execution

Only after 4.1's gate passes.

```bash
MSYS_NO_PATHCONV=1 aws ecs run-task --profile capiro-dev \
  --cluster capiro-dev --launch-type FARGATE --network-configuration "$NETCFG" \
  --task-definition capiro-dev-api-sync \
  --overrides '{"containerOverrides":[{"name":"api","command":["prune-stale-assistance-recipient-candidates","--commit"]}]}' \
  --query 'tasks[0].taskArn' --output text
```

Optionally scope to one tenant first: append `"--tenant","<tenant-uuid>"`.

**Verify:** re-run 4.1. It must report `pruned=0` (idempotent). The fixed
matcher will not recreate these rows.

---

## 5. Assistance enrichment backfill

`enrich-assistance-awards` defaults to `--limit 500`/run against ~238,619
unenriched rows — roughly **478 days** at the daily cadence. The daily rule
correctly absorbs new arrivals; the backlog needs a bounded backfill.

### 5.1 🟢 Measure the backlog first

```sql
SELECT count(*) FILTER (WHERE detail_enriched_at IS NULL) AS unenriched,
       count(*)                                           AS total
FROM federal_assistance_award;
```

### 5.2 🔴 Bounded backfill (≈4.2 h/run at `--limit 50000`, `DELAY_MS=300`)

```bash
MSYS_NO_PATHCONV=1 aws ecs run-task --profile capiro-dev \
  --cluster capiro-dev --launch-type FARGATE --network-configuration "$NETCFG" \
  --task-definition capiro-dev-api-sync \
  --overrides '{"containerOverrides":[{"name":"api","command":["enrich-assistance-awards","--limit","50000"]}]}' \
  --query 'tasks[0].taskArn' --output text
```

Expect ~5 runs for a full pass. Re-measure with 5.1 between runs. This is
resumable by construction (it selects unenriched rows), so a killed run costs
only its in-flight page.

---

## 6. 🔴 Grants.gov reconciliation

`sync-grants --all-statuses` is capped at `MAX_PAGES=100` = 10,000 upserts
against a reported `hitCount` of ~82,982, i.e. **~12% per run, ~8 passes**. It
*correctly* self-reports `success_with_errors` on cap exhaustion — that is
honest incompleteness, **not an alarm**, and the log line carries the resume
page.

```bash
MSYS_NO_PATHCONV=1 aws ecs run-task --profile capiro-dev \
  --cluster capiro-dev --launch-type FARGATE --network-configuration "$NETCFG" \
  --task-definition capiro-dev-api-sync \
  --overrides '{"containerOverrides":[{"name":"api","command":["sync-grants","--all-statuses"]}]}' \
  --query 'tasks[0].taskArn' --output text
```

---

## 7. 🔴 Grant-detail enrichment

Already healthy as of the 2026-07-27 handoff (`federal_grant` 845/845 enriched,
0 unenriched) and scheduled daily 10:45 UTC. Run manually only to pick up a
burst.

```bash
MSYS_NO_PATHCONV=1 aws ecs run-task --profile capiro-dev \
  --cluster capiro-dev --launch-type FARGATE --network-configuration "$NETCFG" \
  --task-definition capiro-dev-api-sync \
  --overrides '{"containerOverrides":[{"name":"api","command":["enrich-grant-details"]}]}' \
  --query 'tasks[0].taskArn' --output text
```

---

## 8. Opportunity-candidate producer

### 8.1 🟢 Dry run

```bash
MSYS_NO_PATHCONV=1 aws ecs run-task --profile capiro-dev \
  --cluster capiro-dev --launch-type FARGATE --network-configuration "$NETCFG" \
  --task-definition capiro-dev-api-sync \
  --overrides '{"containerOverrides":[{"name":"api","command":["generate-grant-opportunity-candidates"]}]}' \
  --query 'tasks[0].taskArn' --output text
```

Expect it to evaluate every (client, opportunity) pair — ~6,888 for
`capiro-internal` — not a handful. A tiny `evaluated` count means the per-client
loop regressed.

### 8.2 🔴 Commit run

**Gate: §3 must have applied `20260806010000_client_grant_nexus_producer_unique`
first.** Without that unique index a concurrent double-run can duplicate rows.

```bash
MSYS_NO_PATHCONV=1 aws ecs run-task --profile capiro-dev \
  --cluster capiro-dev --launch-type FARGATE --network-configuration "$NETCFG" \
  --task-definition capiro-dev-api-sync \
  --overrides '{"containerOverrides":[{"name":"api","command":["generate-grant-opportunity-candidates","--commit"]}]}' \
  --query 'tasks[0].taskArn' --output text
```

---

## 9. 🔴 EventBridge rule creation / verification

### 9.1 🟢 What is live today

```bash
MSYS_NO_PATHCONV=1 aws events list-rules --profile capiro-dev \
  --query 'Rules[?contains(Name,`capiro-dev`)].{Name:Name,Sched:ScheduleExpression,State:State}' \
  --output table
```

Four District-Nexus-adjacent rules are ENABLED and verified:
`sync-federal-assistance-awards` (daily 11:20 UTC),
`enrich-assistance-awards` (11:50), `enrich-grant-details` (10:45),
`sync-grants-reconcile` (Sun 08:25).

**`GenerateGrantOpportunityCandidates` has NO live rule.** Its 4 existing rows
came from a manual run. CDK declares it `enabled: true` as *desired state* — that
is not a deploy.

### 9.2 🔴 Create the producer rule (blocked for the agent; Neo runs via `!`)

Only after §8.2 has run cleanly at least once.

```bash
MSYS_NO_PATHCONV=1 aws events put-rule --profile capiro-dev \
  --name capiro-dev-generate-grant-opportunity-candidates \
  --schedule-expression 'cron(35 11 * * ? *)' \
  --state DISABLED          # create disabled, enable only after the target is verified

MSYS_NO_PATHCONV=1 aws events put-targets --profile capiro-dev \
  --rule capiro-dev-generate-grant-opportunity-candidates \
  --targets '<clone the Input/EcsParameters/RoleArn from an existing verified rule>'

# verify the target round-trips before enabling
MSYS_NO_PATHCONV=1 aws events list-targets-by-rule --profile capiro-dev \
  --rule capiro-dev-generate-grant-opportunity-candidates --output json

MSYS_NO_PATHCONV=1 aws events enable-rule --profile capiro-dev \
  --name capiro-dev-generate-grant-opportunity-candidates
```

> Clone the target from a rule already proven to fire. A hand-written target that
> looks right but never invokes is the failure mode that produced a false
> positive on 2026-07-27. Confirm with one **observed natural tick**, not a
> one-shot cron.

---

## 10. Boundary artifact verification

### 10.1 🟢 Verify the artifact is being served

```bash
curl -s -o /dev/null -w '%{http_code} %{size_download}\n' \
  https://app.capiro.ai/api/intelligence/district-nexus/boundaries
```

### 10.2 🔴 Known IAM gap — `--commit` will fail without this

`ApiTaskRole` has **no `s3:PutObject` on `district-boundaries/*`**, so
`build-district-boundary-artifacts --commit` fails `AccessDenied`. The geometry
itself is dry-run verified (441 features, 4.90 MB gzipped, zero warnings).

Out-of-band fix (Neo runs; do not `cdk deploy`):

```bash
MSYS_NO_PATHCONV=1 aws iam put-role-policy --profile capiro-dev \
  --role-name <ApiTaskRole name> \
  --policy-name district-boundaries-put \
  --policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Action": ["s3:PutObject"],
      "Resource": "arn:aws:s3:::<boundary-bucket>/district-boundaries/*"
    }]
  }'
```

Then:

```bash
# 🟢 dry run first — asserts 441 features and zero warnings
... --overrides '{"containerOverrides":[{"name":"api","command":["build-district-boundary-artifacts"]}]}'
# 🔴 commit
... --overrides '{"containerOverrides":[{"name":"api","command":["build-district-boundary-artifacts","--commit"]}]}'
```

---

## 11. 🟢 Feature-flag verification

**Read only. This runbook does not change any flag.**

```bash
MSYS_NO_PATHCONV=1 aws ecs run-task --profile capiro-dev \
  --cluster capiro-dev --launch-type FARGATE --network-configuration "$NETCFG" \
  --task-definition capiro-dev-api-diag \
  --overrides '{"containerOverrides":[{"name":"api","command":["node","-e","const {PrismaClient}=require(\"@prisma/client\");const p=new PrismaClient();p.$queryRawUnsafe(\"SELECT f.feature, f.enabled, t.slug FROM intel_feature_flag f JOIN tenants t ON t.id::text = f.tenant_id WHERE f.feature = $$district_nexus_v2$$\").then(r=>console.log(JSON.stringify(r,null,1))).finally(()=>p.$disconnect())"]}]}' \
  --query 'tasks[0].taskArn' --output text
```

Expected today: exactly one row, `capiro-internal`, `enabled = true`.

Two gotchas that have each cost a session:

- **No `::uuid` cast against `intel_feature_flag`.** `tenant_id` is TEXT there
  (intel-api owns the table and its RLS casts the other way). A uuid cast throws
  `42883 operator does not exist: text = uuid`, the guard catches it and fails
  closed, and the feature 404s for a tenant whose flag is genuinely on.
- The diag task needs `DATABASE_URL`, which `entrypoint.sh` composes from the
  `DB_*` secrets. Invoking `node -e` directly through the entrypoint keeps that.

### Criteria for expanding beyond `capiro-internal`

Do **not** widen the flag until all four hold:

1. §4.2 cleanup committed and verified idempotent — otherwise a new tenant's
   reviewer sees a queue where 95% of the suggestions are wrong.
2. That tenant has at least one **trustworthy** confirmed assistance mapping
   (UEI-backed or exact-name). Without one, F3 shows an empty pipeline and the
   feature looks broken rather than empty.
3. §8.2 producer has run for that tenant, and §9.2's rule is firing on an
   observed natural tick, so candidates stay fresh.
4. Facility geocoding coverage is understood for that tenant. 61% of facilities
   currently score at half credit (only 58 of 150 are `geocoded`/`matched`), so
   scores will read thin.

Widening is a `capiro-dev-api-diag` write against `intel_feature_flag`; the
classifier blocks it for the agent. Neo runs it via `!`.

---

## 12. 🔴 API and web deployment (approved out-of-band path)

CI builds and pushes the image; the rollout is a service update. **Never a
`cdk deploy` of the Compute stack.**

```bash
# 12.1 🟢 Confirm CI pushed an image for the merge commit
MSYS_NO_PATHCONV=1 aws ecr describe-images --profile capiro-dev \
  --repository-name capiro-api \
  --query 'sort_by(imageDetails,&imagePushedAt)[-3:].{tags:imageTags,pushed:imagePushedAt,digest:imageDigest}' \
  --output table
```

> An `api-image` job reported as `cancelled` is usually the 25-minute workflow
> timeout, **not** a build failure. Check ECR before re-running anything.

```bash
# 12.2 🔴 Roll the services
MSYS_NO_PATHCONV=1 aws ecs update-service --profile capiro-dev \
  --cluster capiro-dev --service capiro-dev-api --force-new-deployment
MSYS_NO_PATHCONV=1 aws ecs update-service --profile capiro-dev \
  --cluster capiro-dev --service capiro-dev-web --force-new-deployment

# 12.3 🟢 Digest-verify: the RUNNING task's image digest must equal 12.1's
MSYS_NO_PATHCONV=1 aws ecs describe-tasks --profile capiro-dev --cluster capiro-dev \
  --tasks $(MSYS_NO_PATHCONV=1 aws ecs list-tasks --profile capiro-dev --cluster capiro-dev \
      --service-name capiro-dev-api --query 'taskArns[]' --output text) \
  --query 'tasks[].containers[].{name:name,image:image,digest:imageDigest}' --output table
```

**Ordering:** §3 (migration) must complete before §12.2 puts the new image in
front of traffic. The new code's duplicate handling expects the index; without
it, duplicate rejection silently falls back to the advisory `findFirst` path.

---

## 13. 🟢 Canary smoke tests

Against `capiro-internal` (the only tenant with the flag on), signed in as a
`user_admin`:

1. Open a client's **Intelligence** tab. The District Nexus section renders,
   with **Reviewed grant relationships** beneath it.
2. **Add relationship** → search an award by recipient name → save as
   *unverified*. It appears with an `unverified` tag and **no** "External use
   approved" tag.
3. Edit it to *verified* with an evidence source. The external-use switch is
   only enabled once the status is `verified`.
4. Try to save a *project site* with no facility → refused with
   "Project-site evidence requires a client facility."
5. Try the same award/type/facility twice → the second is refused with the
   duplicate conflict message (this now comes from the index, not just the probe).
6. **Reject** it. It leaves the active list, the footer reports
   "1 rejected relationship retained in the audit history", and the nexus score
   drops.
7. Sign in as a `standard_user`. The panel renders read-only: no **Add
   relationship**, no **Edit**, no **Reject**.
8. Open `/intelligence/district-nexus`. Map, filters, table fallback, and drawer
   all render; district counts match the widget.

Then confirm the audit trail:

```sql
SELECT action, entity_type, entity_id, actor_user_id, created_at
FROM audit_log
WHERE action LIKE 'district_nexus.grant_relationship.%'
ORDER BY created_at DESC LIMIT 20;
```

Every create/update/reject in steps 2–6 must appear, with `before` populated on
update and reject.

---

## 14. 🟢 Tenant-isolation tests

```bash
# A tenant WITHOUT the flag must 404 (not 403) on every District Nexus route.
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer <token-for-flagless-tenant>" \
  https://app.capiro.ai/api/intelligence/clients/<their-client-id>/district-nexus-relationships
# expect 404

# A client id from ANOTHER tenant must 404 even for a flag-enabled caller.
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer <capiro-internal-token>" \
  https://app.capiro.ai/api/intelligence/clients/<other-tenant-client-id>/district-nexus-relationships
# expect 404

# A standard_user must be refused every mutation.
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  -H "Authorization: Bearer <standard-user-token>" -H 'Content-Type: application/json' \
  -d '{"assistanceAwardId":"<uuid>","relationshipType":"subrecipient"}' \
  https://app.capiro.ai/api/intelligence/clients/<client-id>/district-nexus-relationships
# expect 403
```

---

## 15. 🟢 Data-quality checks

```sql
-- 15.1 No active manual duplicate survived the migration.
SELECT tenant_id, client_id, assistance_award_id, relationship_type,
       COALESCE(facility_id, '00000000-0000-0000-0000-000000000000'::uuid) AS fac,
       count(*)
FROM client_grant_nexus
WHERE assistance_award_id IS NOT NULL AND verification_status <> 'rejected'
GROUP BY 1,2,3,4,5 HAVING count(*) > 1;
-- expect zero rows

-- 15.2 Money stays separated — obligations and outlays are distinct columns.
SELECT count(*) FILTER (WHERE total_obligated_amount IS NOT NULL) AS obligated,
       count(*) FILTER (WHERE total_outlayed_amount  IS NOT NULL) AS outlayed
FROM federal_assistance_award;

-- 15.3 No sentinel geography was resolved to a real House district.
SELECT DISTINCT pop_congressional_district
FROM federal_assistance_award
WHERE pop_congressional_district IN ('90','98','ZZ');
-- these must stay as sentinels; they must never appear as a district key

-- 15.4 External-use approval implies verification (the invariant the service enforces).
SELECT count(*) FROM client_grant_nexus
WHERE external_use_approved = true AND verification_status <> 'verified';
-- expect 0

-- 15.5 The remaining assistance_recipient queue is trustworthy after §4.2.
SELECT confirmed, count(*) FROM client_intel_mapping
WHERE source = 'assistance_recipient' GROUP BY 1;
```

---

## 16. 🟢 Performance checks

```bash
# 16.1 Per-source health + latency for the client Intelligence tab.
MSYS_NO_PATHCONV=1 aws ecs run-task --profile capiro-dev \
  --cluster capiro-dev --launch-type FARGATE --network-configuration "$NETCFG" \
  --task-definition capiro-dev-api-diag \
  --overrides '{"containerOverrides":[{"name":"api","command":["diag-profile-v1","--client","<client-uuid>"]}]}' \
  --query 'tasks[0].taskArn' --output text
```

```bash
# 16.2 Any source that breached or approached its budget now says so by name.
MSYS_NO_PATHCONV=1 PYTHONUTF8=1 aws logs filter-log-events --profile capiro-dev \
  --log-group-name /ecs/capiro-dev-api \
  --filter-pattern '"profile-v1 source"' --max-items 50
```

`profile-v1 source "<label>" took <n>ms` fires above 3,000 ms;
`... exceeded its 20000ms budget` means that source was abandoned and its
section fell back. **Neither is a reason to raise a client timeout** — the point
of the budget is that the slow source is now named.

```sql
-- 16.3 Read-only plan check for the relationship read path.
EXPLAIN (ANALYZE, BUFFERS)
SELECT * FROM client_grant_nexus
WHERE tenant_id = '<tenant-uuid>'::uuid AND client_id = '<client-uuid>'::uuid
  AND assistance_award_id IS NOT NULL;
-- expect an index scan on client_grant_nexus_tenant_client_idx, not a seq scan
```

**Open sizing question for Neo:** `connection_limit=10` is set explicitly in
`scripts/entrypoint.sh:40` against a 512-CPU-unit (0.5 vCPU) task. It replaced
Prisma's CPU-derived default of ~3–5, which is what made the 24-way fan-out
starve. 10 has not been load-validated; if 16.2 shows budget breaches clustered
in the `withTenant` sources, that is the number to revisit.

---

## 17. 🔴 Rollback

In increasing order of severity. **Prefer the flag.**

1. **Feature flag (fastest, no deploy).** Set `enabled = false` on the
   `district_nexus_v2` row. Both the web hook and the API guard fail closed, so
   the nav item disappears and every endpoint 404s. The legacy client District
   Nexus widget keeps working.
2. **Service rollback.** Re-point the service at the previous task-definition
   revision:
   ```bash
   MSYS_NO_PATHCONV=1 aws ecs update-service --profile capiro-dev \
     --cluster capiro-dev --service capiro-dev-api --task-definition capiro-dev-api:<previous-revision>
   ```
   ⚠️ Roll the service, **never** the CloudFormation stack.
3. **Migration rollback.** `DROP INDEX IF EXISTS "client_grant_nexus_manual_award_unique_idx";`
   Safe and lossless (§3).
4. **Do not** roll back the district foundation, the ingested
   `federal_assistance_award` data, or the additive tables. Keep the data; turn
   off the surface.

**The cleanup in §4.2 is a DELETE and is NOT rollback-able** except by restoring
the §1.2 snapshot. That is exactly why §4.1's dry run is a hard gate. The rows it
deletes are junk the fixed matcher would never write again, but "junk" is a
judgement — read the dry-run output.
