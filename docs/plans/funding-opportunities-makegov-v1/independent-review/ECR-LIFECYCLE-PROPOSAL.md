# ECR lifecycle policy — proposal for `capiro/dev/api`

**Status:** PROPOSAL — **nothing in this document has been applied.** The live lifecycle policy on
`capiro/dev/api` is unchanged. `capiro/dev/api` is a shared repository used by several unrelated
programs, so a retention change needs agreement before it is applied (Master remediation plan
2026-09-03, §5 caution 8).

**Author:** infra hardening pass, STEP 3 of `MASTER-REMEDIATION-PLAN-2026-09-03.md`
**Date:** 2026-09-04
**Verified against:** live AWS account `967807252336`, profile `capiro-dev`, region `us-east-1`,
enumerated 2026-09-04 ~03:30 UTC. Every table below is generated from live API output
(`aws ecr describe-images`, `aws ecs list-task-definition-families --status ACTIVE` +
`describe-task-definition` on each family's current revision, `aws events list-rules` +
`list-targets-by-rule`), not from source and not from memory.

---

## 0. Read this first — a sixth recurrence is already queued

The `capiro/dev/api` repository currently holds **21 images**. The active policy keeps **5**.
Digest `sha256:847e3d46b66a2c4c887e3aea748177492b2182f8346e0511f0eb934991a62020` is the **10th
newest** image and is therefore **scheduled for deletion at the next lifecycle evaluation**
(`lastEvaluatedAt` was `2026-09-03T15:31:43-04:00`, i.e. this runs about daily).

That digest is the image behind **five ACTIVE task definitions, including the live API service**:

| Family | Revision | Role |
|---|---|---|
| `capiro-dev-api` | `:278` | **the running production API service** |
| `capiro-dev-api-migrate` | `:96` | database migrations (23 of 27 rules across many programs) |
| `capiro-dev-api-sync-jobs` | `:21` | all grants/DIBBS/SBIR ingestion — **repaired 2026-09-03** |
| `capiro-dev-api-diag` | `:8` | DB diagnostics — **repaired 2026-09-03** |
| `capiro-dev-api-c1-sql-master` | `:43` | ad-hoc SQL runner |

`sha256:d2f5a2a76c6c1dfc0bd5843df84cb1f36bb9c2bea7fafcb5819006c22ab6c5ae`
(`capiro-dev-api-db-inspect:20`) is also inside the expiry set.

**Consequence if nothing is done:** every repair made on 2026-09-03 reverts, and the live API
service becomes unable to launch a replacement task (existing running tasks survive until they are
replaced — a deploy, a scale-out, an AZ event, or a health-check restart is what turns this into an
outage). This is the same failure that has already recurred five times.

**Immediate options, in order of preference:**

1. **Apply the proposed policy in §4** (needs the cross-team agreement this document exists to get).
2. **Interim, no policy change:** re-tag the two at-risk digests with a tag that the *existing*
   rules 1/2 already protect, which removes them from rule 3's scope entirely. This is a deliberate
   abuse of the Defense Budget carve-outs and should be reverted once §4 lands, but it is one API
   call and it stops the bleeding:

   ```bash
   export AWS_PROFILE=capiro-dev
   MANIFEST=$(aws ecr batch-get-image --region us-east-1 --repository-name capiro/dev/api \
     --image-ids imageDigest=sha256:847e3d46b66a2c4c887e3aea748177492b2182f8346e0511f0eb934991a62020 \
     --query 'images[0].imageManifest' --output text)
   aws ecr put-image --region us-east-1 --repository-name capiro/dev/api \
     --image-tag keep-7028c845-attested-source --image-manifest "$MANIFEST"
   ```

3. **Do nothing** and accept a sixth recurrence. Not recommended.

Detection for this failure mode now exists (built 2026-09-04, proven with a real failing task):
EventBridge rule `capiro-dev-ecs-cannot-pull-image` → log group `/capiro/dev/ecs-task-failures` →
metric `CapiroDev/ECS` `CannotPullContainerErrorCount` → alarm `capiro-dev-ecs-cannot-pull-image`.
Detection is not prevention; this document is the prevention half.

---

## 1. Exact current policy

`aws ecr get-lifecycle-policy --repository-name capiro/dev/api` (`lastEvaluatedAt`
`2026-09-03T15:31:43-04:00`), pretty-printed verbatim:

```json
{
  "rules": [
    {
      "rulePriority": 1,
      "description": "Protect governed Defense Budget specialized ingestion-drain images from the general cleanup rule below. Bounded, not unbounded: still expires beyond 200 images.",
      "selection": {
        "tagStatus": "tagged",
        "tagPatternList": ["*ingestion-drain*"],
        "countType": "imageCountMoreThan",
        "countNumber": 200
      },
      "action": { "type": "expire" }
    },
    {
      "rulePriority": 2,
      "description": "Protect governed Defense Budget operator-attested-source carrier images from the general cleanup rule below. Bounded, not unbounded: still expires beyond 200 images.",
      "selection": {
        "tagStatus": "tagged",
        "tagPatternList": ["*attested-source*"],
        "countType": "imageCountMoreThan",
        "countNumber": 200
      },
      "action": { "type": "expire" }
    },
    {
      "rulePriority": 3,
      "description": "Keep last 5",
      "selection": {
        "tagStatus": "any",
        "countType": "imageCountMoreThan",
        "countNumber": 5
      },
      "action": { "type": "expire" }
    }
  ]
}
```

> Note: the plan's shorthand "keep last 5 images, tagStatus any" describes **rule 3 only**. Two
> Defense Budget carve-outs already exist at higher priority. Any replacement must preserve them or
> it will break that program.

### 1.1 Why this policy destroys in-use images

- **Rule 3 uses `tagStatus: any` with `countNumber: 5`.** It counts *images*, not *releases*, and it
  has no notion of "something references this."
- **ARM64 `buildx` pushes emit 3–4 image artifacts per build** (the image, an attestation manifest,
  and an index). Live evidence: of the 21 images in the repo, **15 are untagged** — the pushes at
  `12:30:00`, `12:57:15`, `19:35:18`, `20:08:47` and `20:19:43` each produced 3 artifacts. So **a
  single build consumes 3 of the 5 retained slots.** Effective retention for real, tagged, referenced
  images is **one or two builds**, not five.
- ECR lifecycle rules are **not** "keep what is in use." AWS provides no such selector. Nothing about
  being referenced by an ACTIVE task definition, or by a running service, protects an image.
- Because rules 1 and 2 consume their matching images before rule 3 is evaluated, the Defense Budget
  images are safe; **everything else in the repo, including the API service's own image, is not.**

---

## 2. Blast radius (live enumeration, 2026-09-04)

**258** ACTIVE task-definition families exist in the account. **165** of them have a current
revision that references a `capiro/dev/api` image. Of those:

- **8 are healthy** (referenced image still exists) — and **6 of those 8 are in the expiry set** (§0).
- **157 are broken right now** — their current revision points at an image that no longer exists.

Of the account's **110** EventBridge rules, **101** have an ECS `RunTask` target, and **51** of
those target a family whose image is missing — **48 of them ENABLED**.

### 2.1 The 8 healthy families

| Task-def family : current rev | Pin type | Reference | Prune forecast |
|---|---|---|---|
| `capiro-dev-api:278` | digest | `sha256:847e3d46b66a2c4c887…` | **EXPIRES at next evaluation** |
| `capiro-dev-api-c1-sql-master:43` | digest | `sha256:847e3d46b66a2c4c887…` | **EXPIRES at next evaluation** |
| `capiro-dev-api-db-inspect:20` | digest | `sha256:d2f5a2a76c6c1dfc0bd…` | **EXPIRES at next evaluation** |
| `capiro-dev-api-diag:8` | digest | `sha256:847e3d46b66a2c4c887…` | **EXPIRES at next evaluation** |
| `capiro-dev-api-migrate:96` | digest | `sha256:847e3d46b66a2c4c887…` | **EXPIRES at next evaluation** |
| `capiro-dev-api-sync-jobs:21` | digest | `sha256:847e3d46b66a2c4c887…` | **EXPIRES at next evaluation** |
| `capiro-dev-defense-budget-ingestion-drain:16` | digest | `sha256:cafeccb9403795437f8…` | survives (protected by rule 1/2) |
| `capiro-dev-defense-paddleocr-diag:1` | digest | `sha256:cafeccb9403795437f8…` | survives (protected by rule 1/2) |


### 2.2 ENABLED EventBridge rules currently firing into a missing image (48)

**This is a live, account-wide silent outage, far wider than Funding Opportunities.** Every rule
below is ENABLED and on a schedule; every one of its invocations dies with
`CannotPullContainerError` before the container starts, so it writes nothing to `/capiro/dev/api`,
returns no exit code, and does **not** increment EventBridge `FailedInvocations`.
`capiro-dev-legiwatch-stream-preflight` (every 2 min), `capiro-dev-legiwatch-metrics` (every 5 min)
and `capiro-dev-dispatch-memory-review-notifications` (every 1 min) alone produce roughly
**2,880 failed task starts per day**, measured.


| EventBridge rule | Schedule | Target task-def | Missing image ref |
|---|---|---|---|
| `capiro-dev-crosswalk-state-people` | `cron(20 5 * * ? *)` | `capiro-dev-api-sync-legiscan-bills` | `latest` |
| `capiro-dev-derive-bill-status` | `cron(40 0/6 * * ? *)` | `capiro-dev-api-sync-congress` | `latest` |
| `capiro-dev-derive-state-bill-status` | `cron(50 0/6 * * ? *)` | `capiro-dev-api-sync-legiscan-bills` | `latest` |
| `capiro-dev-dispatch-memory-review-notifications` | `rate(1 minute)` | `capiro-dev-api-memory-review-dispatch:4` | `f3078b1977b660160a3f14a2` |
| `capiro-dev-drain-identity-outbox` | `rate(15 minutes)` | `capiro-dev-api-sync-congress` | `latest` |
| `capiro-dev-embed-bills` | `cron(0 11 * * ? *)` | `capiro-dev-api-embed-backfill` | `latest` |
| `capiro-dev-emit-changes-daily` | `cron(0 9 * * ? *)` | `capiro-dev-api-emit-changes` | `latest` |
| `capiro-dev-emit-state-changes` | `cron(55 0/6 * * ? *)` | `capiro-dev-api-sync-legiscan-bills` | `latest` |
| `capiro-dev-geocode-facilities` | `cron(15 4 * * ? *)` | `capiro-dev-api-sync-state-register:10` | `81a9c2cf042f6b2f7263c0a0` |
| `capiro-dev-legiwatch-archive-reconciliation` | `rate(30 minutes)` | `capiro-dev-legiwatch-phase9-api:25` | `45a8c6db78005ee89dca38ad` |
| `capiro-dev-legiwatch-central-discovery` | `rate(10 minutes)` | `capiro-dev-legiwatch-phase9-api:25` | `45a8c6db78005ee89dca38ad` |
| `capiro-dev-legiwatch-committee-enrichment` | `rate(15 minutes)` | `capiro-dev-legiwatch-phase9-api:25` | `45a8c6db78005ee89dca38ad` |
| `capiro-dev-legiwatch-committee-updates` | `rate(30 minutes)` | `capiro-dev-legiwatch-phase9-api:25` | `45a8c6db78005ee89dca38ad` |
| `capiro-dev-legiwatch-coverage-audit` | `rate(6 hours)` | `capiro-dev-legiwatch-phase9-api:25` | `45a8c6db78005ee89dca38ad` |
| `capiro-dev-legiwatch-metrics` | `rate(5 minutes)` | `capiro-dev-legiwatch-phase9-api:25` | `45a8c6db78005ee89dca38ad` |
| `capiro-dev-legiwatch-parallel-comparison` | `rate(6 hours)` | `capiro-dev-legiwatch-phase9-api:25` | `45a8c6db78005ee89dca38ad` |
| `capiro-dev-legiwatch-source-probe` | `rate(20 minutes)` | `capiro-dev-legiwatch-phase9-api:25` | `45a8c6db78005ee89dca38ad` |
| `capiro-dev-legiwatch-stream-preflight` | `rate(2 minutes)` | `capiro-dev-legiwatch-phase9-api:25` | `45a8c6db78005ee89dca38ad` |
| `capiro-dev-normalize-state-committees` | `cron(30 8 ? * MON *)` | `capiro-dev-api-sync-state-register` | `81a9c2cf042f6b2f7263c0a0` |
| `capiro-dev-sync-bea` | `cron(0 8 1 * ? *)` | `capiro-dev-api-sync-bea` | `latest` |
| `capiro-dev-sync-bls` | `cron(30 8 1 * ? *)` | `capiro-dev-api-sync-bls` | `latest` |
| `capiro-dev-sync-cbo` | `cron(10 6 * * ? *)` | `capiro-dev-api-sync-congress` | `latest` |
| `capiro-dev-sync-census` | `cron(0 10 1 1,4,7,10 ? *)` | `capiro-dev-api-sync-census` | `latest` |
| `capiro-dev-sync-committees` | `cron(40 5 ? * MON,THU *)` | `capiro-dev-api-sync-congress` | `latest` |
| `capiro-dev-sync-congress` | `cron(0 9 * * ? *)` | `capiro-dev-api-sync-congress` | `latest` |
| `capiro-dev-sync-congress-members` | `cron(20 5 ? * MON,THU *)` | `capiro-dev-api-sync-congress` | `latest` |
| `capiro-dev-sync-crs` | `cron(30 6 ? * SUN *)` | `capiro-dev-api-sync-crs` | `latest` |
| `capiro-dev-sync-entity-resolution` | `cron(0 12 ? * MON *)` | `capiro-dev-api-sync-entity-resolution` | `latest` |
| `capiro-dev-sync-fara` | `cron(30 7 ? * SUN *)` | `capiro-dev-api-sync-fara` | `latest` |
| `capiro-dev-sync-fec` | `cron(0 7 ? * SUN *)` | `capiro-dev-api-sync-fec` | `latest` |
| `capiro-dev-sync-federal-register` | `cron(0 9 * * ? *)` | `capiro-dev-api-sync-federal-register` | `latest` |
| `capiro-dev-sync-gao` | `cron(45 9 * * ? *)` | `capiro-dev-api-sync-gao` | `latest` |
| `capiro-dev-sync-hearings` | `cron(30 9 * * ? *)` | `capiro-dev-api-sync-hearings` | `latest` |
| `capiro-dev-sync-house-votes` | `cron(5 0/6 * * ? *)` | `capiro-dev-api-sync-congress` | `latest` |
| `capiro-dev-sync-lda` | `cron(0 6 ? * SUN *)` | `capiro-dev-api-sync-lda` | `latest` |
| `capiro-dev-sync-legiscan-bills` | `cron(30 * * * ? *)` | `capiro-dev-api-sync-legiscan-bills` | `latest` |
| `capiro-dev-sync-legiscan-masterlist-priority` | `cron(10 * * * ? *)` | `capiro-dev-api-sync-legiscan-masterlist` | `latest` |
| `capiro-dev-sync-legistorm-directory` | `cron(30 4 ? * MON-SAT *)` | `capiro-dev-directory-refresh:2` | `latest` |
| `capiro-dev-sync-lobby-trending` | `cron(0 11 * * ? *)` | `capiro-dev-api-sync-lobby-trending` | `latest` |
| `capiro-dev-sync-member-press` | `cron(0 6 1/3 * ? *)` | `capiro-dev-api-sync` | `latest` |
| `capiro-dev-sync-openlobby` | `cron(15 10 1 1,4,7,10 ? *)` | `capiro-dev-api-sync-openlobby` | `latest` |
| `capiro-dev-sync-openspending` | `cron(30 10 1 1,4,7,10 ? *)` | `capiro-dev-api-sync-openspending` | `latest` |
| `capiro-dev-sync-openstates` | `cron(0 8 ? * SUN *)` | `capiro-dev-api-sync-openstates` | `latest` |
| `capiro-dev-sync-regulations` | `cron(15 9 * * ? *)` | `capiro-dev-api-sync-regulations` | `latest` |
| `capiro-dev-sync-rss-intel` | `rate(1 hour)` | `capiro-dev-api-sync-rss-intel` | `396f8fef8e3d700c9f6d8da4` |
| `capiro-dev-sync-sec-edgar` | `cron(30 8 ? * SUN *)` | `capiro-dev-api-sync-sec-edgar` | `latest` |
| `capiro-dev-sync-senate-votes` | `cron(15 0/6 * * ? *)` | `capiro-dev-api-sync-congress` | `latest` |
| `capiro-dev-sync-state-register` | `cron(45 6 * * ? *)` | `capiro-dev-api-sync-state-register` | `81a9c2cf042f6b2f7263c0a0` |


### 2.3 DISABLED rules pointing at a missing image (3)

Listed for completeness — these are not currently firing, but they will fail the moment anyone
enables them.


| Rule (DISABLED) | Schedule | Target task-def |
|---|---|---|
| `capiro-dev-drain-mailbox-knowledge` | `rate(15 minutes)` | `capiro-dev-api-sync-congress` |
| `capiro-dev-memory-projection-worker` | `rate(5 minutes)` | `capiro-dev-memory-projection-worker:1` |
| `capiro-dev-meriv2-control-monitor` | `rate(5 minutes)` | `capiro-dev-meriv2-control-monitor:1` |


### 2.4 Full list of the 157 broken families

Most of these are dead one-off probe/diagnostic families (the `:latest` tag does not exist in the
repository at all, so **every** `:latest` reference is broken). They are listed because "which
task-defs are broken" is exactly the question nobody could answer during the five prior incidents,
and because the "Live rule?" column separates dead scratch families from real scheduled work.


| Task-def family : current rev | Pin type | Reference | Image exists? | Live rule? |
|---|---|---|---|---|
| `capiro-assoc-probe:1` | tag | `latest` | **NO** | — |
| `capiro-bright-delete:2` | tag | `latest` | **NO** | — |
| `capiro-bright-probe:4` | tag | `latest` | **NO** | — |
| `capiro-clients-probe:2` | tag | `latest` | **NO** | — |
| `capiro-del2-exec:1` | tag | `latest` | **NO** | — |
| `capiro-del2-probe:7` | tag | `latest` | **NO** | — |
| `capiro-del3-exec:1` | tag | `latest` | **NO** | — |
| `capiro-dev-api-admin-migrate:35` | digest | `sha256:456db8b8195f6fb47311d88c8065392d43a3c0ed6` | **NO** | — |
| `capiro-dev-api-backfill-articles:1` | digest | `sha256:c39b834c53cd63fad299bb6a8ca7a5abad835f9e1` | **NO** | — |
| `capiro-dev-api-backfill-sectors:1` | tag | `latest` | **NO** | — |
| `capiro-dev-api-billsdiag:1` | tag | `latest` | **NO** | — |
| `capiro-dev-api-bootstrap-roles:1` | tag | `latest` | **NO** | — |
| `capiro-dev-api-bridge:1` | tag | `latest` | **NO** | — |
| `capiro-dev-api-bridge2:1` | tag | `latest` | **NO** | — |
| `capiro-dev-api-brsrc:1` | tag | `latest` | **NO** | — |
| `capiro-dev-api-c1-sql:3` | tag | `9493fc234cc1a11e46d340043d80f8be6514948a` | **NO** | — |
| `capiro-dev-api-c1-sql-v2:1` | tag | `f8dba151c04f334fb81961baa8d67b261b5f6009` | **NO** | — |
| `capiro-dev-api-c1-sql-v3:1` | tag | `f8dba151c04f334fb81961baa8d67b261b5f6009` | **NO** | — |
| `capiro-dev-api-c1-sql-v4:1` | tag | `f8dba151c04f334fb81961baa8d67b261b5f6009` | **NO** | — |
| `capiro-dev-api-c1-sql-v5:1` | tag | `cd2855d982fad1436bf42cc78664c40de332dada` | **NO** | — |
| `capiro-dev-api-c1-sql-v6:25` | tag | `eab19f21d26ee0cff7256875cffbb7fc2c77c9e2` | **NO** | — |
| `capiro-dev-api-c2diag:1` | tag | `latest` | **NO** | — |
| `capiro-dev-api-cgprobe:2` | tag | `latest` | **NO** | — |
| `capiro-dev-api-changes:1` | tag | `latest` | **NO** | — |
| `capiro-dev-api-chk2:1` | tag | `latest` | **NO** | — |
| `capiro-dev-api-coverage:1` | tag | `latest` | **NO** | — |
| `capiro-dev-api-cpf-cds-ingest:4` | tag | `cpf-cds-ingest-427aef919-v4` | **NO** | — |
| `capiro-dev-api-crm-status:1` | digest | `sha256:31f7cd2b6c96a17ee6f711de862b5c65ee2d70ad5` | **NO** | — |
| `capiro-dev-api-data-runner:1` | tag | `latest` | **NO** | — |
| `capiro-dev-api-dbg-title:1` | tag | `latest` | **NO** | — |
| `capiro-dev-api-delconn:1` | tag | `latest` | **NO** | — |
| `capiro-dev-api-embed-backfill:1` | tag | `latest` | **NO** | `capiro-dev-embed-bills` |
| `capiro-dev-api-emit-changes:1` | tag | `latest` | **NO** | `capiro-dev-emit-changes-daily` |
| `capiro-dev-api-emit-redistrict:2` | tag | `latest` | **NO** | — |
| `capiro-dev-api-engagement-migrate-status:2` | tag | `745de6131fb28b3aa8087860898b96e8b23773fe` | **NO** | — |
| `capiro-dev-api-enrich-districts:5` | tag | `latest` | **NO** | — |
| `capiro-dev-api-evpayload:1` | tag | `latest` | **NO** | — |
| `capiro-dev-api-fedfix:1` | tag | `fedfix-amd64` | **NO** | — |
| `capiro-dev-api-flagutil:5` | digest | `sha256:152dcb2aae70396a3dc3877e456072d1ca5cea7f6` | **NO** | — |
| `capiro-dev-api-hearchk:1` | tag | `latest` | **NO** | — |
| `capiro-dev-api-hearings-repair:2` | tag | `latest` | **NO** | — |
| `capiro-dev-api-hearings-verify:7` | tag | `latest` | **NO** | — |
| `capiro-dev-api-hr8800-probe:2` | tag | `latest` | **NO** | — |
| `capiro-dev-api-junk-audit:3` | tag | `latest` | **NO** | — |
| `capiro-dev-api-junk-delete:1` | tag | `latest` | **NO** | — |
| `capiro-dev-api-keel-delete:1` | tag | `latest` | **NO** | — |
| `capiro-dev-api-keel-inspect:1` | tag | `latest` | **NO** | — |
| `capiro-dev-api-kp8-migrate:2` | tag | `dad97e60abbfb34f8fae02d9d06517517d688347` | **NO** | — |
| `capiro-dev-api-kpstab-canary1:1` | tag | `latest` | **NO** | — |
| `capiro-dev-api-kpstab-canary2:1` | tag | `latest` | **NO** | — |
| `capiro-dev-api-kpstab-canary3:1` | tag | `latest` | **NO** | — |
| `capiro-dev-api-kpstab-ctl1:2` | tag | `latest` | **NO** | — |
| `capiro-dev-api-kpstab-ctl2:1` | tag | `latest` | **NO** | — |
| `capiro-dev-api-kpstab-ctl3:1` | tag | `latest` | **NO** | — |
| `capiro-dev-api-kpstab-fi1:2` | tag | `latest` | **NO** | — |
| `capiro-dev-api-kpstab-fi2:2` | tag | `latest` | **NO** | — |
| `capiro-dev-api-kpstab-fi3:1` | tag | `latest` | **NO** | — |
| `capiro-dev-api-kpstab-fixt:1` | tag | `latest` | **NO** | — |
| `capiro-dev-api-kpstab-tel1:1` | tag | `latest` | **NO** | — |
| `capiro-dev-api-kpstab-tel2:1` | tag | `latest` | **NO** | — |
| `capiro-dev-api-legprof:1` | tag | `latest` | **NO** | — |
| `capiro-dev-api-memory-review-dispatch:4` | tag | `f3078b1977b660160a3f14a2cc099a5d88f05fad` | **NO** | `capiro-dev-dispatch-memory-review-notifications` |
| `capiro-dev-api-meri-verify:2` | tag | `latest` | **NO** | — |
| `capiro-dev-api-meriv2-bootprobe:7` | digest | `sha256:152dcb2aae70396a3dc3877e456072d1ca5cea7f6` | **NO** | — |
| `capiro-dev-api-mscheck:1` | tag | `latest` | **NO** | — |
| `capiro-dev-api-mscheck2:1` | tag | `latest` | **NO** | — |
| `capiro-dev-api-msconns:1` | tag | `latest` | **NO** | — |
| `capiro-dev-api-namebackfill:1` | tag | `latest` | **NO** | — |
| `capiro-dev-api-namediag:1` | tag | `latest` | **NO** | — |
| `capiro-dev-api-namediag2:1` | tag | `latest` | **NO** | — |
| `capiro-dev-api-owner-migrate:1` | tag | `32eae60bab8c6b3cbb032a02405bd9b6160f0352` | **NO** | — |
| `capiro-dev-api-p27g-learning:3` | digest | `sha256:6af4389f394a5e17104c7aa42e89b9d77055179b7` | **NO** | — |
| `capiro-dev-api-p27g-migrate:2` | digest | `sha256:79b5f5216125cf62587a8c9a9a96528fa2273530e` | **NO** | — |
| `capiro-dev-api-pe-audit:1` | tag | `latest` | **NO** | — |
| `capiro-dev-api-pe-cleanup:4` | tag | `latest` | **NO** | — |
| `capiro-dev-api-pe-enrichment:36` | tag | `eab19f21d26ee0cff7256875cffbb7fc2c77c9e2` | **NO** | — |
| `capiro-dev-api-pe-match:4` | tag | `latest` | **NO** | — |
| `capiro-dev-api-pe-match-apply:1` | tag | `latest` | **NO** | — |
| `capiro-dev-api-pe-match3:1` | tag | `latest` | **NO** | — |
| `capiro-dev-api-pe-match3-apply:1` | tag | `latest` | **NO** | — |
| `capiro-dev-api-pe-profile:1` | tag | `latest` | **NO** | — |
| `capiro-dev-api-pe-suffix:1` | tag | `latest` | **NO** | — |
| `capiro-dev-api-pe-verify:6` | tag | `latest` | **NO** | — |
| `capiro-dev-api-pending-cleanup:1` | tag | `latest` | **NO** | — |
| `capiro-dev-api-por:1` | tag | `latest` | **NO** | — |
| `capiro-dev-api-profile-diag:1` | tag | `latest` | **NO** | — |
| `capiro-dev-api-qprov:1` | tag | `latest` | **NO** | — |
| `capiro-dev-api-r2check:1` | tag | `latest` | **NO** | — |
| `capiro-dev-api-readonly-diag:6` | tag | `3f00ed8410cad712139901d8bbc6fab1ac967afd` | **NO** | — |
| `capiro-dev-api-recal:1` | tag | `latest` | **NO** | — |
| `capiro-dev-api-recal-apply:1` | tag | `latest` | **NO** | — |
| `capiro-dev-api-runs:1` | tag | `latest` | **NO** | — |
| `capiro-dev-api-sam-probe:8` | tag | `latest` | **NO** | — |
| `capiro-dev-api-set-flags:1` | tag | `cd2855d982fad1436bf42cc78664c40de332dada` | **NO** | — |
| `capiro-dev-api-sig2:1` | tag | `latest` | **NO** | — |
| `capiro-dev-api-sig2rev:1` | tag | `latest` | **NO** | — |
| `capiro-dev-api-sig2rev2:1` | tag | `latest` | **NO** | — |
| `capiro-dev-api-sig3:1` | tag | `latest` | **NO** | — |
| `capiro-dev-api-snyder-probe:1` | tag | `latest` | **NO** | — |
| `capiro-dev-api-sql-exec:3` | tag | `latest` | **NO** | — |
| `capiro-dev-api-state:1` | tag | `latest` | **NO** | — |
| `capiro-dev-api-strategy:18` | digest | `sha256:c38596ee35f9c7ad381e8b5108bf070730c720e06` | **NO** | — |
| `capiro-dev-api-strategy-migrate:2` | tag | `latest` | **NO** | — |
| `capiro-dev-api-svc-profile:1` | tag | `latest` | **NO** | — |
| `capiro-dev-api-sync:6` | tag | `latest` | **NO** | `capiro-dev-sync-member-press` |
| `capiro-dev-api-sync-all:2` | tag | `latest` | **NO** | — |
| `capiro-dev-api-sync-bea:3` | tag | `latest` | **NO** | `capiro-dev-sync-bea` |
| `capiro-dev-api-sync-bls:3` | tag | `latest` | **NO** | `capiro-dev-sync-bls` |
| `capiro-dev-api-sync-census:3` | tag | `latest` | **NO** | `capiro-dev-sync-census` |
| `capiro-dev-api-sync-congress:5` | tag | `latest` | **NO** | `capiro-dev-derive-bill-status`, `capiro-dev-drain-identity-outbox`, `capiro-dev-drain-mailbox-knowledge`, `capiro-dev-sync-cbo`, `capiro-dev-sync-committees`, `capiro-dev-sync-congress`, `capiro-dev-sync-congress-members`, `capiro-dev-sync-house-votes`, `capiro-dev-sync-senate-votes` |
| `capiro-dev-api-sync-crs:2` | tag | `latest` | **NO** | `capiro-dev-sync-crs` |
| `capiro-dev-api-sync-entity-resolution:2` | tag | `latest` | **NO** | `capiro-dev-sync-entity-resolution` |
| `capiro-dev-api-sync-fara:2` | tag | `latest` | **NO** | `capiro-dev-sync-fara` |
| `capiro-dev-api-sync-fec:3` | tag | `latest` | **NO** | `capiro-dev-sync-fec` |
| `capiro-dev-api-sync-federal-register:5` | tag | `latest` | **NO** | `capiro-dev-sync-federal-register` |
| `capiro-dev-api-sync-free:1` | tag | `latest` | **NO** | — |
| `capiro-dev-api-sync-gao:2` | tag | `latest` | **NO** | `capiro-dev-sync-gao` |
| `capiro-dev-api-sync-grants:4` | tag | `9c302d26064a5f82643a722104dd9e3751181859` | **NO** | — |
| `capiro-dev-api-sync-hearings:3` | tag | `latest` | **NO** | `capiro-dev-sync-hearings` |
| `capiro-dev-api-sync-keyed:1` | tag | `latest` | **NO** | — |
| `capiro-dev-api-sync-lda:3` | tag | `latest` | **NO** | `capiro-dev-sync-lda` |
| `capiro-dev-api-sync-legiscan-bills:2` | tag | `latest` | **NO** | `capiro-dev-crosswalk-state-people`, `capiro-dev-derive-state-bill-status`, `capiro-dev-emit-state-changes`, `capiro-dev-sync-legiscan-bills` |
| `capiro-dev-api-sync-legiscan-masterlist:2` | tag | `latest` | **NO** | `capiro-dev-sync-legiscan-masterlist-priority` |
| `capiro-dev-api-sync-lobby-trending:2` | tag | `latest` | **NO** | `capiro-dev-sync-lobby-trending` |
| `capiro-dev-api-sync-openlobby:2` | tag | `latest` | **NO** | `capiro-dev-sync-openlobby` |
| `capiro-dev-api-sync-openspending:2` | tag | `latest` | **NO** | `capiro-dev-sync-openspending` |
| `capiro-dev-api-sync-openstates:3` | tag | `latest` | **NO** | `capiro-dev-sync-openstates` |
| `capiro-dev-api-sync-regulations:5` | tag | `latest` | **NO** | `capiro-dev-sync-regulations` |
| `capiro-dev-api-sync-rss-intel:6` | tag | `396f8fef8e3d700c9f6d8da434b3d6d09042eb57` | **NO** | `capiro-dev-sync-rss-intel` |
| `capiro-dev-api-sync-sec-edgar:2` | tag | `latest` | **NO** | `capiro-dev-sync-sec-edgar` |
| `capiro-dev-api-sync-state-register:10` | tag | `81a9c2cf042f6b2f7263c0a0a09bb54b7940aa44` | **NO** | `capiro-dev-geocode-facilities`, `capiro-dev-normalize-state-committees`, `capiro-dev-sync-state-register` |
| `capiro-dev-api-tomandapp:1` | tag | `latest` | **NO** | — |
| `capiro-dev-api-trgm-test:1` | tag | `latest` | **NO** | — |
| `capiro-dev-api-vq:1` | tag | `latest` | **NO** | — |
| `capiro-dev-bill-pe:1` | tag | `latest` | **NO** | — |
| `capiro-dev-dbprobe:53` | tag | `latest` | **NO** | — |
| `capiro-dev-defense-job-inspect:1` | tag | `latest` | **NO** | — |
| `capiro-dev-directory-refresh:2` | tag | `latest` | **NO** | `capiro-dev-sync-legistorm-directory` |
| `capiro-dev-kp-canary:1` | tag | `latest` | **NO** | — |
| `capiro-dev-legiwatch-phase9-api:25` | tag | `45a8c6db78005ee89dca38ad63751b3f29056834` | **NO** | `capiro-dev-legiwatch-archive-reconciliation`, `capiro-dev-legiwatch-central-discovery`, `capiro-dev-legiwatch-committee-enrichment`, `capiro-dev-legiwatch-committee-updates`, `capiro-dev-legiwatch-coverage-audit`, `capiro-dev-legiwatch-metrics`, `capiro-dev-legiwatch-parallel-comparison`, `capiro-dev-legiwatch-source-probe`, `capiro-dev-legiwatch-stream-preflight` |
| `capiro-dev-memory-projection-worker:1` | digest | `sha256:152dcb2aae70396a3dc3877e456072d1ca5cea7f6` | **NO** | `capiro-dev-memory-projection-worker` |
| `capiro-dev-meriv2-control-monitor:1` | digest | `sha256:152dcb2aae70396a3dc3877e456072d1ca5cea7f6` | **NO** | `capiro-dev-meriv2-control-monitor` |
| `capiro-dev-pe-ingest:3` | tag | `latest` | **NO** | — |
| `capiro-dev-phase10b22-governed-cli:1` | digest | `sha256:5097b45d2bc9f0f7f4a2940bb6684947c2431f206` | **NO** | — |
| `capiro-dev-probe:2` | tag | `latest` | **NO** | — |
| `capiro-dualsight-delete:1` | tag | `latest` | **NO** | — |
| `capiro-dualsight-probe:2` | tag | `latest` | **NO** | — |
| `capiro-keel-delete:5` | tag | `latest` | **NO** | — |
| `capiro-keel-probe:22` | tag | `latest` | **NO** | — |
| `capiro-landscape-probe:2` | tag | `latest` | **NO** | — |
| `capiro-lia-exec:1` | tag | `latest` | **NO** | — |
| `capiro-mailsync-probe:4` | tag | `latest` | **NO** | — |
| `capiro-outreach-probe:1` | tag | `latest` | **NO** | — |
| `capiro-prep-probe:3` | tag | `latest` | **NO** | — |
| `capiro-snyder-diag:5` | tag | `latest` | **NO** | — |
| `capiro-testacct-delete:1` | tag | `latest` | **NO** | — |
| `capiro-testacct-probe:2` | tag | `latest` | **NO** | — |


---

## 3. Who else is in this repository

Tag and family patterns across the 165 referencing families identify these distinct programs sharing
`capiro/dev/api`. **All of them are affected by any retention change**, so all of them should be
consulted:

| Program / team | How it shows up | Notes |
|---|---|---|
| **Core platform / API** | bare 40-char commit-SHA tags (17 families), plus `capiro-dev-api:278` | the main CI/CD publish path; owns the live service |
| **Defense Budget** | `*-ingestion-drain`, `*-attested-source`, `phase10b*` | already has carve-out rules 1/2 — the only program currently protected |
| **LegiWatch** | `capiro-dev-legiwatch-phase9-api` | 9 ENABLED rules, all dead right now |
| **Knowledge Plane** | `capiro-dev-api-kpstab-*`, `capiro-dev-api-p27g-*`, `capiro-dev-kp-canary` | 15 families, all broken |
| **Meri v2 / memory** | `capiro-dev-meriv2-*`, `capiro-dev-memory-projection-worker`, `capiro-dev-api-memory-review-dispatch` | `dispatch-memory-review-notifications` fires every minute into a missing image |
| **Political Engagement (PE)** | `capiro-dev-api-pe-*`, `capiro-dev-pe-ingest`, `capiro-dev-bill-pe` | 12 families |
| **Strategies** | `capiro-dev-api-strategy*` | |
| **Funding Opportunities / MakeGov** | `capiro-dev-api-sync-jobs`, `capiro-dev-api-sync-grants` | the program that raised this |
| **CPF/CDS (Advocacy History)** | `cpf-cds-ingest-427aef919-v4` | |
| **Congressional / state data sync** | `capiro-dev-api-sync-*` (~25 families) | FEC, LDA, FARA, GAO, Census, BEA, BLS, OpenStates, LegiScan, Federal Register, Regulations |
| **Ad-hoc client/tenant probes** | `capiro-*-probe`, `capiro-*-delete`, all on `:latest` | ~127 families; almost certainly disposable |

---

## 4. Proposed replacement policy

Design goals: (a) keep the two Defense Budget carve-outs byte-identical so that program is
unaffected; (b) never expire an image that has been deliberately marked for retention; (c) reclaim
space from the untagged `buildx` by-products that are actually causing the pressure, rather than
from real releases; (d) raise general retention above the number of builds any team does between
deploys.

```json
{
  "rules": [
    {
      "rulePriority": 1,
      "description": "Protect governed Defense Budget specialized ingestion-drain images. Unchanged from the current policy.",
      "selection": {
        "tagStatus": "tagged",
        "tagPatternList": ["*ingestion-drain*"],
        "countType": "imageCountMoreThan",
        "countNumber": 200
      },
      "action": { "type": "expire" }
    },
    {
      "rulePriority": 2,
      "description": "Protect governed Defense Budget operator-attested-source carrier images. Unchanged from the current policy.",
      "selection": {
        "tagStatus": "tagged",
        "tagPatternList": ["*attested-source*"],
        "countType": "imageCountMoreThan",
        "countNumber": 200
      },
      "action": { "type": "expire" }
    },
    {
      "rulePriority": 3,
      "description": "Never expire images explicitly marked for retention. Any image referenced by a long-lived task definition MUST carry a keep- or release- tag.",
      "selection": {
        "tagStatus": "tagged",
        "tagPatternList": ["keep-*", "release-*"],
        "countType": "imageCountMoreThan",
        "countNumber": 500
      },
      "action": { "type": "expire" }
    },
    {
      "rulePriority": 4,
      "description": "Expire untagged images (buildx attestation/index by-products) after 7 days. This is where the space actually is: 15 of 21 images in this repo are untagged.",
      "selection": {
        "tagStatus": "untagged",
        "countType": "sinceImagePushed",
        "countUnit": "days",
        "countNumber": 7
      },
      "action": { "type": "expire" }
    },
    {
      "rulePriority": 5,
      "description": "General cleanup: keep the last 30 tagged images. Replaces 'keep last 5, tagStatus any'.",
      "selection": {
        "tagStatus": "tagged",
        "tagPatternList": ["*"],
        "countType": "imageCountMoreThan",
        "countNumber": 30
      },
      "action": { "type": "expire" }
    }
  ]
}
```

**Notes on the proposal**

- ECR has **no** "keep if referenced by a task definition" selector. Rule 3 is the closest achievable
  substitute, and it is why the operational rule in §5 is mandatory rather than advisory — the policy
  cannot protect an image the publisher did not mark.
- Rule 3's `countNumber: 500` keeps it bounded (an unbounded rule is what the Defense Budget
  carve-outs were careful to avoid); raise it if the repo ever legitimately holds more.
- Rule 4 is the real space reclaim. Untagged artifacts are 15 of 21 images today.
- Rule 5 at 30 tagged images is roughly a month of daily deploys.
- **Before applying**, tag the currently-referenced images (§0 option 2, but with a correct `keep-`
  prefix rather than the Defense Budget hack), or applying this policy will not save them.
- Validate with `aws ecr start-lifecycle-policy-preview` before `put-lifecycle-policy` — preview
  returns the exact expiry set without deleting anything.

---

## 5. Operational rule to adopt alongside the policy

The policy alone is not sufficient — five recurrences happened under a policy that looked reasonable.
Both halves are required:

1. **Every task-definition registration pins by digest, never by mutable tag.**
   `…/capiro/dev/api@sha256:…`, not `…/capiro/dev/api:<commit>`. Digest pinning does not prevent
   garbage collection, but it removes the separate failure mode where a tag is re-pointed underneath
   a live task definition. Live evidence this is not yet the norm: of the 165 referencing families,
   **127 use `:latest`** — a tag that does not exist in this repository at all.
2. **AND the image must carry a retained tag** (`keep-*` / `release-*`) so rule 3 protects it.
   Digest-pinning alone is what `sync-jobs:21`, `api-diag:8` and `api-migrate:96` do today, and all
   three are in the current expiry set — correct pinning, unprotected image.
3. **Never register a long-lived task definition against an image built from a feature branch**
   unless that image is tagged `keep-*`. Scratch builds should stay untagged and be reaped by rule 4.
4. **When a task definition is retired, deregister it.** 157 broken families is largely accumulated
   scratch; deregistering removes them from this list and makes the real breakage visible.
5. **Retire `:latest` in this repository.** It resolves to nothing, so each of those 127 families is
   a landmine that reads as configured-and-fine until it runs.

---

## 6. Recommendation to Neo

Apply the §4 policy, but do the tagging first and in that order: today the repository holds 21 images
against a retention of 5, and the digest that backs the live `capiro-dev-api:278` service — along
with `api-migrate:96`, `api-diag:8` and the `sync-jobs:21` that ended the 5–6 day grants outage
yesterday — is tenth in line and will be deleted at the next lifecycle evaluation, so the sixth
recurrence of this failure is already queued and will land within about a day if nothing changes;
tag those digests `keep-*` now (§0 gives a one-call interim that works under the *existing* policy),
then apply §4, which leaves the two Defense Budget carve-outs untouched, moves the pressure onto the
untagged `buildx` by-products that are 15 of the 21 images and the actual cause of the churn, and
raises real retention from five images to thirty. The wider finding is that this is not a Funding
Opportunities problem: **48 ENABLED EventBridge rules across LegiWatch, Knowledge Plane, Meri, PE and
the whole congressional/state sync fleet are firing into images that no longer exist**, several of
them every one to five minutes, and they have been failing silently because a container that cannot
pull its image never runs long enough to log anything or to increment `FailedInvocations` — so the
repair backlog in §2.2 is owned by several teams and should be circulated with this document rather
than absorbed by one. Treat §4 as needing the same cross-team go-ahead as `capiro-dev-api-migrate`
itself, and note that the detection built on 2026-09-04 (`capiro-dev-ecs-cannot-pull-image`) will
hold the alarm in ALARM continuously until §2.2 is worked off — that is the alarm telling the truth,
not a false positive.

---

## 7. What this document did **not** change

- The live ECR lifecycle policy on `capiro/dev/api` — **untouched**.
- Any task definition, EventBridge rule target, or image tag — **untouched**.
- `capiro-dev-api-migrate` — untouched (it is now at `:96`, healthy, digest-pinned, and in the
  expiry set like everything else).
