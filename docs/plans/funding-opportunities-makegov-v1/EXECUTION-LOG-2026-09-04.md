# Execution log — 2026-09-04 — "execute the entire plan"

**Governs:** `MASTER-REMEDIATION-PLAN-2026-09-03.md`. This document records what was actually
executed against that plan on 2026-09-04, with the evidence for each item. Where the plan said
"needs Neo's go-ahead", the go-ahead was Neo's instruction on 2026-09-03 to *execute the entire
plan*, given after the plan (including G1/G2 and migrate:95) had been presented. Items that need a
human outside this system (SAM.gov key, Tango signing secret, the P49 walk) remain open and are
listed in §5.

**Method note, same convention as every document in this folder:** nothing below is asserted from
memory or from reading; each row names the command, task id, log stream, PR or commit that proves it.
Every ECS one-off used `capiro-dev-api-diag:8` (read-only SQL under
`set_config('app.bypass_rls','on',true)`) or the named task definition; every AWS write is listed
with its rollback.

---

## 1. Status table (plan step → what happened)

| Step | Item | Result 2026-09-04 | Evidence |
|---|---|---|---|
| 1 | SAM.gov API key (U3) | **STILL BLOCKED — human-only.** Key still returns 401. Both SAM rules now *run* (U2, fixed 2026-09-03) and log the real error instead of silently failing to start. | `INGESTION_METRIC` `sync-sam-opportunities` 2026-09-04T07:51:06Z `rows_inserted:0, error_count:1`; `sync-sam-opportunities-all-federal` 07:56:00Z same. Secret `capiro/dev/sam-gov-api-key` unchanged. |
| 2 | G1 + G2 grant-matching fixes | **MERGED — PR #1466**, merge `070955b998853db88343a5ef996b5ddaea208066`. Producer now takes `scored.meetsSuggestionFloor` and computes no floor; `DEFAULT_MIN_RELEVANCE = 15`; `normalizeListing` extracts with an anchored pattern that keeps the letter suffix. Both new specs were confirmed failing on unfixed code before the fix. | 71/71 in the two specs; broad run over `src/district-nexus`, `src/funding-opportunities` and the producer specs: 66 suites / 2011 tests, 2006 pass, 5 pre-existing failures (§4). FO tsconfig `tsc` exit 0. Live proof = the post-deploy dry run in §3. |
| 3 | ECR pruning hardening (I4) | **DETECTION BUILT** (by the STEP 3 agent, 2026-09-03 ~23:00 EDT; verified live 2026-09-04), **INTERIM PREVENTION APPLIED** (2026-09-04), **POLICY PROPOSED, NOT APPLIED**. See §2. | Rule `capiro-dev-ecs-cannot-pull-image` → log group `/capiro/dev/ecs-task-failures` → metric `CapiroDev/ECS CannotPullContainerErrorCount` → alarm → SNS `capiro-dev-platform-alarms` (e-mail neo@capiro.ai). Eight `capiro-dev-ingestion-no-run-*` and three `capiro-dev-ingestion-zero-rows-*` liveness alarms. `independent-review/ECR-LIFECYCLE-PROPOSAL.md`. |
| 4 | `capiro-dev-api-migrate:95` (I2) | **DONE 2026-09-03.** `:96` registered against digest `847e3d46…`, proven with `migration-status` ("345 migrations found, Database schema is up to date!"); the three `:68`-pinned FO rules were repointed to `:96` (DN producer dry-run proof: "Would insert 1076, update 1212, skip 162140, of 164428"); the three `:42`-pinned PE-budget rules (`extract-bill-pe-codes`, `match-pe-mentions`, `pe-derive-chain`) were deliberately left alone — another team's pin. | task ids and streams in the 2026-09-03 session record |
| 5 | P08 idempotency (F5) | **MERGED — PR #1465**, merge `302868130441afca43066c494d47f7587a821921`. Migration `20280211010000_engagement_task_action_source_uniq` (partial unique index with RAISE-EXCEPTION pre-flight) + `P2002` catch that re-reads the winner and returns `reused: true`. Real-Postgres 8-way proof passes, and **provably fails with the index dropped** (6 distinct task ids returned). | PR body carries the transcripts. Live pre-flight: **0 duplicates** (`engagement_tasks` = 9 rows, 1 with both source columns; `client_funding_opportunity` = 499) — diag task `2b888e1ae5cf426ea4b4758d2036f7dd`, stream `diag/db-inspect/2b888e1ae5cf426ea4b4758d2036f7dd`. Migration applied live: §3. |
| 6 | Forecast decision (T2) | **DONE 2026-09-03 — Option A.** `funding_opportunities_forecasts` disabled for c2-strategies, dualsight, maven, prospering-solutions, revere, victory-six-advisors; capiro-internal left on for development. Recorded as D-83 (PR #1464). | before/after snapshots via `capiro-dev-api-diag:8`; intel-api `task disable-feature funding_opportunities_forecasts <slug>` × 6, each `FEATURE_DISABLED` |
| 7 | P46 live proof (F2) | **STILL BLOCKED** — needs a real Tango signing secret and a real delivery. `tango_webhook_delivery` (singular) still 0 rows. | unchanged |
| 8 | Docs closeout C1 + C2 | **MERGED — PR #1464** (`1c7ed27fa`): completion-matrix verdicts for 43 phases, D-80..D-85. This PR adds the master plan, the fix plans, the ECR proposal, this log and the new reviews. | `git log origin/main -- docs/plans/funding-opportunities-makegov-v1/` |
| 9 | C4 runbook defects + real `--tenant`/`--client` scoping | **PR #1467** — all four runbook defects fixed; both Tango sync scripts gain real scoping applied to the live `where` clause; an unknown flag is a hard stop (exit 2 + usage) before any DB/network access. Merge status in §5. | 62/62 in the two scoping specs; `tsx scripts/sync-tango-entities.ts --bogus` → `EXIT=2` with usage; FO tsconfig `tsc` exit 0 |
| 10 | P49 canary walk | **STILL BLOCKED — Neo only.** Unblocked on the runbook side by step 9; still needs a live MakeGov key and flag enablement, on a day with zero ingestion runs. | — |
| 11 | C5 formal reviews (P05, P20, P21, P31, P37, P38, P39, P44, P45) | **IN PROGRESS** — see §6 for which reviews landed in this PR. Two full waves of reviewer agents were terminated by API rate limits before writing anything; the third wave runs two at a time. | `independent-review/review-2026-09-04-*.md` |
| 12 | D1 UEI divergence | **DONE** — D-84 recorded (PR #1464). No code change. | `decision-log.md` |
| 13 | U4 CDK drift check | **NOT RUN** — no `cdk deploy` of the ingestion stack was attempted or is planned in this round; the caution stands. | — |

---

## 2. ECR image pruning — what was done, exactly

### 2.1 Detection (built 2026-09-03 ~23:00–00:00 EDT; verified live 2026-09-04 09:00Z)
- EventBridge rule `capiro-dev-ecs-cannot-pull-image` (ENABLED): source `aws.ecs`, detail-type
  `ECS Task State Change`, `lastStatus = STOPPED`, `stoppedReason` prefix `CannotPullContainerError`,
  cluster `capiro-dev`. Single target: CloudWatch Logs group `/capiro/dev/ecs-task-failures`
  (30-day retention). A per-event SNS target was deliberately removed: the 48 pre-existing broken
  rules in §2.3 produce roughly 2,880 such events per day, which would have been a mail bomb.
- Metric filter `capiro-dev-cannot-pull-container-error` → `CapiroDev/ECS` `CannotPullContainerErrorCount`.
- Alarm `capiro-dev-ecs-cannot-pull-image` (threshold ≥ 1) → SNS `capiro-dev-platform-alarms`
  (e-mail subscription neo@capiro.ai). **It is in ALARM and will stay there** until the account-wide
  problem in §2.3 is addressed. That is the alarm working, not a defect.
- Liveness: metric filters on `/capiro/dev/api` matching `INGESTION_METRIC {"source":"<job>"` for
  eight jobs (`RunCount_<job>`) and `"rows_inserted":0,` for the three sync jobs
  (`ZeroRowRun_<job>`); alarms `capiro-dev-ingestion-no-run-<job>` (Sum over 1 h, 26 periods,
  `LessThanThreshold 1`, missing data = breaching) and `capiro-dev-ingestion-zero-rows-<job>`.
  Five `no-run` alarms were in ALARM on the morning of 2026-09-04 only because the filters were
  created *after* the 2026-09-03 smoke runs. The 10:00Z scheduled `sync-grants` run
  (`rows_inserted: 1592, error_count: 0`, logged 10:01:37Z) is the first datapoint they see.
- The throwaway task definition the plan asked for as proof was **not** left behind:
  `list-task-definitions --family-prefix capiro-dev-throwaway` (ACTIVE and INACTIVE) → empty.

### 2.2 Prevention — interim, applied 2026-09-04 (Neo's 2026-09-03 answer "5. yes" = protect the digest)
The live lifecycle policy is three rules: two Defense-Budget carve-outs (`*ingestion-drain*` and
`*attested-source*`, each keep ≤ 200) and `keep last 5, tagStatus any`. Rules 1 and 2 are evaluated
first, so an image carrying a tag that matches either pattern is excluded from rule 3. Digest
`847e3d46…` — behind the API task definition `capiro-dev-api:278`, `api-migrate:96`,
`api-sync-jobs:21`, `api-diag:8` and `api-c1-sql-master:43` — had fallen to 11th newest of 22 and
would have been deleted at the next daily evaluation (`lastEvaluatedAt` 2026-09-03T15:31 EDT).

Applied. Each is one additive `put-image` of the image's own manifest, byte-exact (the returned
digest equals the source digest). Rollback is `batch-delete-image --image-ids imageTag=<tag>`,
which removes only the tag.

| Digest | Referenced by | Tag added |
|---|---|---|
| `sha256:847e3d46b66a2c4c887e3aea748177492b2182f8346e0511f0eb934991a62020` | `capiro-dev-api:278`, `api-migrate:96`, `api-sync-jobs:21`, `api-diag:8`, `api-c1-sql-master:43` | `keep-7028c845-api-attested-source` |
| `sha256:d2f5a2a76c6c1dfc0bd5843df84cb1f36bb9c2bea7fafcb5819006c22ab6c5ae` | `capiro-dev-api-db-inspect:20` | `keep-db-inspect20-attested-source` |
| `sha256:f3fb7078d6bad94d3dfa4029510e776e7f9829dd60a347897c1155bf1b933218` | **`capiro-dev-api:280` — the revision actually serving since 2026-09-04 00:23 EDT** (registered by `capirocli`, pinned by mutable tag `35ed6a3da`, another workstream) | `keep-35ed6a3da-api280-attested-source` |

A first attempt fetched the manifest with `--output text`, which altered the bytes and created two
*new* untagged manifests (`ec38d203…`, `41cedf7c…`) instead of tagging the originals; both were
deleted within the minute with `batch-delete-image`, and the repository returned to 22 images.

**This is a deliberate, temporary use of another program's carve-out.** It changes no policy and
touches no other team's images, and it must be reverted (drop the three tags) once §2.3 lands.

### 2.3 Prevention — the real fix, proposed, NOT applied (needs cross-team agreement)
`independent-review/ECR-LIFECYCLE-PROPOSAL.md`, generated from live API output 2026-09-04 ~03:30Z.
Headline numbers, all live-enumerated:

- 258 ACTIVE task-definition families; **165** reference a `capiro/dev/api` image; **157 of those
  are broken right now** (the image no longer exists — most are dead probe families pinned to
  `latest`, a tag that did not exist until another workstream pushed it at 2026-09-04 00:20 EDT).
- **101 EventBridge rules target ECS; 51 point at a family whose image is missing; 48 of them are
  ENABLED** — LegiWatch (`capiro-dev-legiwatch-phase9-api:25`, nine rules including one every two
  minutes), the congress / legiscan / federal-register / GAO / hearings sync family (all `latest`),
  memory-review dispatch (every minute), state-register, rss-intel, directory refresh. Every one of
  those dies with `CannotPullContainerError` before the container starts, so it writes nothing to
  `/capiro/dev/api`, returns no exit code, and does **not** increment `FailedInvocations`.
  **This is an account-wide silent outage far wider than Funding Opportunities. It is reported here
  for the other owners; nothing outside Funding Opportunities was touched.**
- Root cause of the recurrence: a buildx push emits three artifacts, so `keep last 5 (any tag)`
  retains one or two builds, and ECR has no "referenced by an ACTIVE task definition" selector.

---

## 3. Deploy of the merged fixes (G1+G2, P08, canary scoping) — 2026-09-04 10:45–11:20Z

Order followed: build → register digest-pinned revisions → `migration-status` → `migrate` →
`migration-status` → roll the API service → retarget the sync-jobs rules → prove G1 with a dry run.

### 3.1 Image
- Built from commit `4ed88e51c17420d4ff1e644b9ceadd4ef0132670` (the PR #1467 tip, rebased on
  main after #1465/#1466). After #1467 merged, `git rev-parse origin/main^{tree}` equals that
  commit's tree, so the image is byte-for-byte main `d6af452feb0e2f5bf74854ecc1e61501d377874a`.
- `docker buildx build --builder fo-ship --platform linux/arm64 --provenance=false --sbom=false -f apps/api/Dockerfile --push`;
  27 build steps, ~17 min, pushed 11:01:56Z. Single OCI manifest (no index), 31 layers.
- Digest **`sha256:637cd7cc1b3801b5d3a6ee2397879849af7274f911e6de0970bb1f9b43742924`**; tags
  `4ed88e51c1742…`, `d6af452feb0e2…` (main), and `keep-d6af452f-fo-remediation-attested-source`
  (interim retention, §2.2).
- ECR ran its lifecycle evaluation at 10:22:59Z, between the tagging in §2.2 and this push: the
  repository went from 22 to 18 images and **every protected digest survived**, including
  `847e3d46…` which sat well below the "last 5" line. That is the interim protection proven by
  execution, not by reading.

### 3.2 Task definitions (copy of the live definition, `image` the only changed field — asserted by diff before registering)
| Family | Copied from | New revision | Note |
|---|---|---|---|
| `capiro-dev-api` | `:281` (live at the time — another workstream had moved it 278→279→280→281 overnight; re-read immediately before registering) | **`:282`** | |
| `capiro-dev-api-sync-jobs` | `:21` | **`:22`** | |
| `capiro-dev-api-migrate` | `:96` | **`:98`** | `:97` had been registered 00:20 EDT by `capirocli` (tag `35ed6a3da`, another workstream) and had been serving the 23 unpinned rules today; `:98` supersedes it with a newer main image. Recorded here because it changes what those rules run. |

### 3.3 Migration
- `migration-status` on `:98` (task `d098e101cd6346ac81d9b380d27be764`, stream `api/api/d098e101…`):
  348 migrations found; **one** not yet applied — `20280211010000_engagement_task_action_source_uniq`.
  (`20260903200000_legiwatch_user_prefs` and `20280210010000_meri_analytics_ro_role` had already
  been applied by their own workstreams; the latter at 09:16:38Z.)
- `migrate` (task `b0ed2ba4972e417a80cc5ed715fd9151`, exit 0): "Applying migration
  `20280211010000_engagement_task_action_source_uniq` … All migrations have been successfully applied."
- `migration-status` after (task `8f3e5111740b4037bd1b3ace19bce617`): "Database schema is up to date!"
- Independent proof (diag task `5199d507e7194aea956976bc9a7c7421`): `pg_indexes` now holds
  `CREATE UNIQUE INDEX engagement_tasks_tenant_source_uniq ON public.engagement_tasks USING btree (tenant_id, source_type, source_id) WHERE ((source_type IS NOT NULL) AND (source_id IS NOT NULL))`;
  `_prisma_migrations` row finished `2026-09-04 11:09:08Z`, `applied_steps_count = 1`.

### 3.4 API service roll
- `update-service capiro-dev-api --task-definition capiro-dev-api:282` at 11:13:07Z; deployment
  `ecs-svc/7135172622657635243` COMPLETED at 11:15:49Z; 2/2 tasks RUNNING + HEALTHY on image
  `637cd7cc…`; ALB target group shows the two new targets `healthy`, the two old ones `draining`.
- Rollback, if ever needed: `update-service --task-definition capiro-dev-api:281` (no rebuild; the
  `:281` image is retained under `keep-api281-attested-source`).

### 3.5 EventBridge rules → `capiro-dev-api-sync-jobs:22`
Enumerated by walking all 101 rules that target the cluster (a first pass matched only one rule
because `jq` output carries `\r` on Windows and the API rejected every name — strip CR). Sixteen
rules target the family; **13** were at `:21` and were retargeted (`put-targets`, only
`EcsParameters.TaskDefinitionArn` changed, before/after JSON kept):
`capiro-dev-sync-grants`, `capiro-dev-sync-grants-reconcile`, `capiro-dev-enrich-grant-details`,
`capiro-dev-generate-funding-grant-candidates`, `capiro-dev-sync-sam-opportunities`,
`capiro-dev-sync-sam-opportunities-all-federal`, `fo-dev-sync-tango-dibbs`, `fo-dev-sync-tango-sbir`,
`fo-dev-reconcile-tango-dibbs-full`, `fo-dev-reconcile-tango-sbir-full`,
`fo-dev-generate-dibbs-opportunity-candidates`, `fo-dev-generate-sbir-opportunity-candidates`,
`fo-dev-process-tango-events`.
**Not touched — another team's pin, and broken:** `capiro-dev-sync-legistorm-trips`,
`capiro-dev-sync-legistorm-districts`, `capiro-dev-reconcile-legistorm-trips-full` all point at
`capiro-dev-api-sync-jobs:1`, whose image no longer exists (same class as §2.3). Reported, not fixed.

### 3.6 G1 live proof
- Dry run on `:22` (task `596a3ae3ed1841c1ae875c079ca8ca5b`, no `--commit`):
  `DRY RUN tenants=7 evaluated=164428 created=2166 refreshed=122 stale=0 preserved=0 errors=0 coverage=COMPLETE clients=101 grants=1628`.
  Baseline on the old image, same day, same corpus: `created=4`. **The fix took.**
- The plan's own gate: "only commit after reviewing a sample of the newly-qualifying pairs by hand."
  The daily `--commit` schedule (`cron(42 11 * * ? *)`) was 26 minutes away, so the rule
  `capiro-dev-generate-funding-grant-candidates` was **DISABLED at 11:15:57Z** pending that review.
  Re-enable: `aws events enable-rule --name capiro-dev-generate-funding-grant-candidates`.
  Sample review and outcome: §3.7.

### 3.7 Sample review of newly-qualifying pairs — and what it found
Method: commit for the **internal tenant only** first (`--commit --tenant 17b63099-bc0f-4ac5-b596-496161e9481e`,
task `c899bac4243444a8bdb1cfd15ea7df8c`: `evaluated=17908 created=1145 refreshed=122 errors=0`), then
read the created rows back with read-only diag tasks (`5199d507…` family; queries kept in the
scratchpad as `diag-g1-sample.js`, `diag-g1-applicant.js`).

What the 1,145 internal rows were:

| Client | Rows | Signal make-up | Score |
|---|---|---|---|
| L3 Harris (internal test client) | 1,145 (all of them) | **1,117 `applicantType` alone**, 18 `capabilityKeyword+sector`, 10 `applicantType+sector` | 1,135 × 18, 10 × 25 |

- The `applicantType`-only volume is a **data artifact of the test client**: L3 Harris has **all 16**
  Grants.gov applicant types selected, including "Individuals", "Unrestricted" and "Public housing
  authorities", so 1,117 of the 1,628 live grants match it on eligibility alone. Only one other
  client in the whole environment has any applicant-type data (Lumaril, tenant `revere`, one type).
- The 18 `capabilityKeyword+sector` rows — the arm G1 exists to admit — are of the same quality the
  on-demand read path already showed users: DARPA PINPOINT (`real-time`), NDEP (`manufacturing`),
  NASA ROSES (`space`) are reasonable; "U.S. Mission to Latvia — Alumni Engagement Innovation Fund"
  on `space`+`defense` is not. Single-word capability names (`space`, `energy`, `defense`) are the
  weak point, and that is a property of the shared scorer, unchanged by this PR.
- **Verdict of the review: the producer now agrees with `scoreOpportunityRelevance` exactly as the
  plan and the new invariant test require; nothing here is a G1/G2 defect.** Schedule re-enabled at
  11:28:36Z and the full commit run immediately (task `e12c373404784b37bc9c2477597050c4`):
  `COMMITTED tenants=7 evaluated=164428 created=1021 refreshed=1267 errors=0`. Total new candidates
  today: 1,145 + 1,021 = 2,166, equal to the dry run.

Where the 1,021 customer-tenant rows went (read-only diag, `diag-g1-tenants.js`):

| Tenant | New rows | Clients touched | Signal make-up |
|---|---|---|---|
| `revere` | **777** | 1 (Lumaril) | **all `applicantType` = "Small businesses"** |
| `c2-strategies` | 189 | 10 | `capabilityKeyword+sector` (First American Nuclear 72 on `energy`; Hop Aero / Omega Project 41 each on `space`/`defense`) |
| `dualsight` | 49 | 3 | `capabilityKeyword+sector` (Vantage Autonomy 47 on `defense`) |
| `victory-six-advisors` | 5 | 2 | `capabilityKeyword+sector` |
| `prospering-solutions` | 1 | 1 | `capabilityKeyword+sector` |
| `maven` | 0 | 0 | — |

### 3.8 Live UI check (os.capiro.ai, signed in as Neo, 11:40Z)
`https://os.capiro.ai/intelligence/opportunities?clientId=0e042626-…` (L3 Harris): header reads
"Grants.gov opportunities: current to Sep 4 · 1,628 active of 83,443", "Grant details: enriched to
Sep 4", and — honestly — "SAM.gov all-federal contract opportunities: current to Jul 29 — **LAST RUN
FAILED Sep 4**" (the U2 fix surfacing the U3 key outage instead of silence). Pursuit pipeline 1,269,
Active grants 1,235. The list renders the new rows with the `Suggested` badge and the transparent
reasoning the design intended: "STRONGEST REASON — Aimed at this kind of organization — matched on
'Unrestricted (i.e., open to any type of entity above)…' — Evidence (3) · relevance 36 — Better
matching needs: Federal award history". So the change is observable end to end, and the UI is
already telling the user exactly why these are weak. Observation, not investigated: the "Triage
inbox" tab counter showed 0 for the same client while the pipeline showed 1,269.

**Product finding for Neo, not fixed here (§5):** one strong `applicantType` signal clears the
shared floor by design (`SIGNAL_STRENGTH.applicantType = 'strong'`, weight 25 → score 18 ≥ 15).
"Small businesses" is one of the most common eligibility types on Grants.gov, so a client whose only
profile fact is that eligibility now receives hundreds of `suggested` rows that say nothing about
fit. The read path has always behaved this way on demand; G1 makes the producer persist it. This is
eligibility being scored as relevance. Candidate remedies are all shared-scorer decisions — downgrade
`applicantType` to `moderate` so it needs a companion signal, or treat the ubiquitous types
("Small businesses", "Unrestricted…", "For profit organizations…") as eligibility-only — and would
change the read path everywhere, so they were **not** made unilaterally. Rollback of today's rows if
Neo wants them gone before a scorer change: they are identifiable as
`source='grants_gov' AND evidence_source_type='deterministic_relevance_v1' AND created_at BETWEEN '2026-09-04 11:20Z' AND '2026-09-04 11:31Z' AND workflow_status='suggested'`;
note the daily 11:42Z schedule would recreate them unless the scorer changes or the rule is disabled.

---

## 4. Pre-existing test failures observed, not introduced, not fixed

- `apps/api/src/funding-opportunities/funding-opportunities.service.spec.ts` — five tests throw
  `BadRequestException: This contract opportunity is closed…`. The SAM fixture's
  `responseDeadline: new Date('2026-09-01T00:00:00Z')` (line 100) passed on 2026-09-01, and
  `isSamActiveShared` now correctly reports it closed. Time-bomb fixture. Owner: whoever owns that
  spec; not touched by any PR in this round.
- `apps/api/src/intelligence/intelligence.mapping-governance.spec.ts` ~line 414 — "the web mirror
  of the award-bearing set matches the API" (`expect(received).not.toBeNull()`). Handed to the P05
  independent review (§6) to decide regression versus fixture rot.

---

## 5. Open items after this round

Grouped by who has to act. Nothing here was silently dropped; each item names the evidence that
makes it open.

### 5.1 Neo — decisions
1. **Eligibility scored as relevance (new, §3.7).** `applicantType` alone clears the shared floor and
   the numeric backstop; Lumaril (`revere`) received 777 `suggested` grant rows on "Small businesses"
   alone today, and the internal test client L3 Harris 1,117 on its all-16-types profile. Decide:
   (a) downgrade `applicantType` to `moderate` in `SIGNAL_STRENGTH` (needs a companion signal;
   changes the read path everywhere too), (b) treat ubiquitous types as eligibility-only, or
   (c) accept. If (a)/(b): a small PR in `grant-opportunity-relevance.ts` plus its spec, then a
   one-off cleanup of today's rows by the predicate in §3.7. If nothing is decided, tomorrow's
   11:42Z run keeps the current behaviour.
2. **Capability keywords are single generic words** (`space`, `energy`, `defense`) and match embassy
   public-diplomacy grants. Pre-existing scorer property, now persisted by the producer. Options: a
   stop-list, minimum specificity, or requiring two topical signals for keyword matches.
3. **`funding_opportunities_meri_v2` is ON for all 7 tenants** including customers (P37 review F-1,
   High). The plan said internal canary only and no decision records the enablement. Decide and
   record (D-86 candidate); if it stays on, the Meri gate must also read the master flag (P37 F-3).
4. **`funding_opportunities_documents` is ON for 7 of 8 tenants** against three empty tables
   (P31 review F-2, High) — the D-82/D-83 shape again. Decide (turn off, or fund the producer that
   was never built) and record (D-87 candidate).
5. **ECR lifecycle policy** — apply `independent-review/ECR-LIFECYCLE-PROPOSAL.md` §4 after the
   other teams sharing `capiro/dev/api` agree, then drop the five interim `keep-*-attested-source`
   tags. Until then every new API image must be tagged the same way or it is pruned within days.
6. **48 ENABLED EventBridge rules across the account point at images that no longer exist**
   (§2.3) — LegiWatch, congress/legiscan/federal-register/GAO/hearings syncs, memory-review
   dispatch, and the three LegiStorm rules on `capiro-dev-api-sync-jobs:1`. Not Funding
   Opportunities work; owners need to be told. The `capiro-dev-ecs-cannot-pull-image` alarm will stay
   in ALARM (and e-mail neo@) until they are fixed.
7. **P20/P21, P37/P38, P39, P45 review verdicts are FAIL** (§6). Each names a bounded fix. Decide
   which are GA blockers. The reviewers' view: P20 F-1/F-2 (lost update, no audit) and P39 F-01/F-02
   (read-only unenforced, unaudited) are the ones that change what a customer could be exposed to;
   the rest are gaps in dark or internal-only paths.

### 5.2 Neo — actions only a human can take
8. **SAM.gov API key rotation** (STEP 1) — 37 days of 401s. Portal account owner generates a new key,
   updates secret `capiro/dev/sam-gov-api-key`, then the proof run in the master plan STEP 1.
9. **Tango webhook signing secret** for the P46 live proof (STEP 7).
10. **P49 canary walk** (STEP 10) — now unblocked on the runbook side by PR #1467; needs a live
    MakeGov key, flag enablement, and a day with zero ingestion runs.
11. **P51 design-partner acceptance** — deferred by decision D-81, not resolved.

### 5.3 Engineering follow-ups (bounded, no decision needed)
12. Time-bomb fixture in `funding-opportunities.service.spec.ts` line 100 (§4) — 5 red tests since
    2026-09-01.
13. Fixture rot in `intelligence.mapping-governance.spec.ts:412-417` (P05 F-1) — regex the shared
    file, not the legacy page.
14. P45 `RISK_STATES` needs `not_synced` (review F-4) — ~20 lines + one test; precondition to ever
    enabling the flag.
15. The P08 reuse path discards the caller's fresh due-date/owner (FIX-PLAN §11) and the `review`
    intent's `nextAction=null` with non-null `nextActionDueAt` violates
    `client_funding_opportunity_next_action_chk` — both named in PR #1465, both out of scope there.
16. Liveness alarms: the five `capiro-dev-ingestion-no-run-*` alarms were still in ALARM at 11:35Z
    although `sync-grants` (10:01Z) and `enrich-grant-details` (10:47Z) each produced a datapoint
    in their hour. Configuration is M=N=26 hourly periods, missing = breaching, which is the right
    shape; CloudWatch had not re-evaluated to OK within 95 minutes. Re-check on 2026-09-05; if still
    ALARM with 26 real datapoints available, the alarm definition, not the jobs, is wrong.
17. Three `capiro-dev-api-migrate:42`-pinned PE-budget rules (2026-09-03) and three
    `capiro-dev-api-sync-jobs:1`-pinned LegiStorm rules (today) point at pruned images — other
    teams' pins, reported to them, untouched.

### 5.4 Standing cautions (unchanged)
Never `cdk deploy Capiro-dev-Compute`; never treat a quiet run as a healthy one; `cdk diff` before
any ingestion-stack deploy (it compares to CloudFormation, not to live — today's `put-targets`
changes will not appear in it and a deploy would revert them); zero ingestion on a canary day.

---

## 6. Independent reviews landed in this PR (STEP 11 / C5)

All nine previously-unreviewed phases now carry a §6.2 verdict from a reviewer that did not
implement them, pinned to `1c7ed27fa`, dated 2026-09-04, with reproducible transcripts. The
completion matrix rows were updated from these documents (Review cell for all nine; Deploy cell for
P37/P38/P39 where the reviewer proved the code is live — the matrix's "not yet deployed" had been
false since 2026-08-07).

| Band | Phases | Document | Verdict | Load-bearing findings |
|---|---|---|---|---|
| A | P05 | `review-2026-09-04-p05-mapping-governance.md` | **PASS** with non-blocking notes | admin gating real server-side; failing spec assertion is fixture rot (PR #1080), not regression; 210 pre-existing cross-tenant `client_intel_mapping` rows (dormant job) |
| A | P39 | `review-2026-09-04-p39-tango-mcp.md` | **FAIL** | read-only is an editable seed default, not an invariant; read-only tools are exactly the unaudited ones; flag gates offering not use; no P18 accounting; live server advertises OAuth `read`, not the shipped API-key header; deployed flag-dark |
| B | P20 + P21 | `review-2026-09-04-p20-p21-profile-enrichment.md` | **FAIL / FAIL** | lost update on accept (proven); no audit / provenance destroyed; P21 not delivered as specified (no version table, no per-field provenance, service unused); never run live |
| B | P37 + P38 | `review-2026-09-04-p37-p38-meri-tools.md` | **FAIL / FAIL** | `meri_v2` flag ON for all 7 tenants unrecorded; Meri gate ≠ HTTP gate (master/landscape flags never read; #1100 fix confirmed live); `conversationId` unverified; fail-open provenance; 0 artifacts ever; **deployed**, contradicting the matrix |
| B | P31 + P44 + P45 | `review-2026-09-04-p31-p44-p45-evidence-context.md` | **FAIL / PASS / FAIL** | P31: producer never existed, `documents` flag ON for 7/8 tenants against empty tables, review routes unimplemented; P44: D-82 confirmed on all four claims, honest `not_synced`; P45: cannot say "never synced" — collapses empty tables into "none observed" |

Reviewer lineage, stated as the convention requires: each document was produced by a Claude
general-purpose subagent that had not implemented, tested or merged the phase, working from a clean
detached worktree at the pin, read-only against live `capiro-dev` (describe/list/logs plus the
`capiro-dev-api-diag:8` SELECT-only task), with all probe files deleted and no AWS writes. Two
earlier waves of the same reviews were terminated by API rate limits before writing anything and
are not represented here.
