# LegiStorm Directory Safe Refresh — Runbook

Operational guide for the scheduled LegiStorm directory refresh (`sync-legistorm-directory`).
The pipeline archives a new immutable S3 snapshot, validates it, and only then flips the
`LATEST.json` pointer. It **never** deletes data and **never** touches Capiro-authored overlays.

> **Status:** Phases 1–2 shipped (dry-run pipeline + pointer-driven reader + committee fix).
> Phase 3 (secrets/IAM + schedules) is committed **dormant** — the two EventBridge rules are
> created `DISABLED` and the sync task-def change is not deployed. **Activation is blocked** on
> (a) rotating the exposed LegiStorm key and (b) a targeted, drift-reconciled deploy. See
> "Activation" below.

## Preservation contract (non-negotiable)

Enforced in code **and** IAM:

- **No writes/deletes under `UPDATED DIRECTORY/overlays/`** — bios, press, and photo overlays are
  Capiro-authored. The sync task role has **no** `PutObject` on `overlays/*` and **no**
  `s3:DeleteObject` anywhere.
- **No snapshot is ever deleted or overwritten** — every run writes a new `snapshots/active-current-<ts>/`
  prefix with `IfNoneMatch: '*'`.
- **`LATEST.json` is written last** (via `IfMatch` on the prior ETag) and only after every staged
  object is re-read + checksum-verified and both overlay fingerprints are confirmed unchanged.
- **On any validation failure `LATEST.json` is left untouched.**
- **Logs carry only counts + diagnostic IDs** — never API keys, emails, DOBs, addresses, or raw rows.

## S3 key ownership matrix

| Key prefix | Owner | Sync task access |
|---|---|---|
| `UPDATED DIRECTORY/snapshots/*` | refresh job | read + `PutObject` (immutable) |
| `UPDATED DIRECTORY/pointers/*` | refresh job | read + `PutObject` |
| `UPDATED DIRECTORY/LATEST.json` | refresh job | read + `PutObject` (last, conditional) |
| `UPDATED DIRECTORY/overlays/*` | Capiro (bios/press/photos) | **read-only** |

IAM (from `infra/cdk/lib/compute-stack.ts`): `s3:GetObject`/`s3:ListBucket` on the bucket +
`s3:PutObject` on the three prefixes above only. No `s3:DeleteObject`. `LEGISTORM_API_KEY` is
injected from Secrets Manager into the **sync task only** (`apiSyncSecrets`), never the serve/migrate
task defs.

## Commands

```bash
# Dry run (default): zero S3 + DB writes; prints an aggregate-only summary + validation gates.
pnpm --filter @capiro/api sync:legistorm-directory                     # incremental
pnpm --filter @capiro/api sync:legistorm-directory -- --full           # full reconciliation
pnpm --filter @capiro/api sync:legistorm-directory -- --since=2026-06-01

# Commit (publishes a new snapshot; only if every validation gate passes):
pnpm --filter @capiro/api sync:legistorm-directory -- --commit
pnpm --filter @capiro/api sync:legistorm-directory -- --commit --full
# Approve a legitimate flagged threshold change:
pnpm --filter @capiro/api sync:legistorm-directory -- --commit --approval-file=./approval.json
```

Windows: **members** are always fetched as the full current list (`floor..today`); **staff/offices**
are incremental (last successful watermark − `LEGISTORM_OVERLAP_DAYS`, default 2) unless `--full`
(floor..today) or `--since` (explicit, no overlap). The watermark comes from `sync_run`.

`approval.json` shape (audited provenance; malformed provenance fails closed):

```json
{
  "approvedBy": "neo@capiro.ai",
  "approvedAt": "2026-07-14T00:00:00.000Z",
  "reason": "Confirmed mass staff turnover after the new Congress seated",
  "gates": ["staffCountDrop"]
}
```

Valid gates: `memberCountChange`, `staffCountDrop`, `officeCountDrop`, `committeeMembershipDrop`,
`photoCoverageDrop`.

## Validation thresholds (fail closed; require approval to override)

- members within **90–110%** of the previous snapshot;
- staff / office counts drop **≤ 5%** without approval (and every removed ID needs a tombstone);
- committee-membership count drop **≤ 10%**;
- member photo coverage drop **≤ 5 percentage points**;
- every current member has a member ID, Bioguide ID, profile, and a current office.

## Configuration (env)

`LEGISTORM_API_KEY` (Secrets Manager, sync task only), `LEGISTORM_BASE_URL`, `LEGISTORM_PAGE_SIZE`,
`LEGISTORM_MAX_PAGES`, `LEGISTORM_REQUEST_DELAY_MS`, `LEGISTORM_REQUEST_TIMEOUT_MS`,
`LEGISTORM_MAX_RETRY_DELAY_MS`, `LEGISTORM_OVERLAP_DAYS`, `DIRECTORY_S3_BUCKET`,
`DIRECTORY_S3_LATEST_KEY`, `DIRECTORY_S3_PREFIX` (emergency pin only).

## Reader resolution & rollback

The API resolves the snapshot per cache rebuild (≤ 30 min):

1. `DIRECTORY_S3_PREFIX` set → **emergency pin** (no `LATEST.json` read).
2. else → `LATEST.json`'s `snapshot_prefix` (+ `previous_snapshot_prefix` for fallback).
3. `LATEST.json` absent/bad → documented default prefix (keeps the directory working pre-launch).

**Rollback** (never restore data — snapshots are immutable):

- Fast: `aws s3api list-object-versions … LATEST.json` then copy the prior version back over
  `LATEST.json`; or
- Pin: set `DIRECTORY_S3_PREFIX=UPDATED DIRECTORY/snapshots/active-current-<good-ts>` on the API
  task and force a new deployment. The reader also auto-falls-back to `previous_snapshot_prefix`
  and, failing that, serves a stale in-memory cache rather than an empty directory.

## Activation (operator-gated — do in this order)

1. **Rotate + revoke the exposed LegiStorm key.** The key pasted in chat during Phase 0 is
   compromised. Issue a new key, store it in Secrets Manager `capiro/dev/legistorm-api-key`
   (out of band), and revoke the old one. **Do not proceed until this is done.**
2. **Verify no drift** before deploying Compute. Compare live `capiro-dev-api-sync:6` (container
   `api`) against the synthesized `api-sync-jobs` (container name, image, secrets, env, roles, log
   group). A blind `cdk deploy` can DROP out-of-band secrets/env from the live API task — see the
   `infra_cdk_taskdef_drift` note.
3. **Targeted diff + deploy only.** `cdk diff Capiro-dev-Compute` and confirm the ONLY changes are:
   the LegiStorm secret import, `apiSyncSecrets` on the sync task, the scoped directory `PutObject`,
   and the two DISABLED rules. **Never `cdk deploy --all`.** Apply task-def/secret changes
   out-of-band if the diff shows unrelated drift. Verify `:latest` carries the intended merge SHA
   before any roll.
4. **Canary (commit) once**, verify overlay SHA-256/VersionIds + tenant note/favorite/press counts
   are byte-identical, then confirm no `DeleteObject` CloudTrail events by the sync role.
5. **Enable** `capiro-dev-sync-legistorm-directory` (Mon–Sat). After two clean daily runs, enable
   `capiro-dev-reconcile-legistorm-directory-full` (Sun).

```bash
# Manual one-off ECS run (dry run shown; add --commit to publish):
aws ecs run-task --cluster capiro-dev --launch-type FARGATE \
  --task-definition capiro-dev-api-sync-jobs \
  --overrides '{"containerOverrides":[{"name":"api-sync-jobs","command":["sync-legistorm-directory"]}]}'

# Enable / disable the rules:
aws events enable-rule  --name capiro-dev-sync-legistorm-directory
aws events disable-rule --name capiro-dev-sync-legistorm-directory
aws events describe-rule --name capiro-dev-reconcile-legistorm-directory-full   # expect State
```

## Observability

- `sync_run` rows (source `sync-legistorm-directory`): latest status should be `success`.
- CloudWatch `Capiro/Ingestion` `ingestion.error_count` (from the job's `INGESTION_METRIC` lines).
- `SYNC_LEGISTORM_SUMMARY {…}` stdout line carries the aggregate run report (windows, counts,
  gates, proposed prefix, overlay fingerprints) — no PII.

## Completeness metrics + drift warnings (Task 16)

The validation report's `metrics` block reports both count metrics (members, staff, offices,
committee memberships, member photo coverage) and completeness metrics that guard profile /
dictionary richness from silent regression: `uniqueBioguideIds`, `membersWithCurrentOffice`,
and `staffWithPhoto` (a **nullable** metric — `0` is honest today; the entitlement returns no
staff photo). Regression gates fail closed on member 90–110%, staff/office 5%, committee
membership 10%, and photo coverage 5pp unless an audited approval covers the gate.

`report.warnings` is a **non-blocking** advisory channel. Today it fires when the source begins
returning a staff-photo field (`… staff photo for N staffer(s); review + map before exposing`) —
a signal to review + wire the new field rather than let it drop silently. Warnings never block
pointer promotion.

## Adding a newly entitled LegiStorm endpoint

Do **not** fold new datasets (caucuses, town halls, hearings, trips) into this member-directory
job. Give each its own script + schedule and its own retention policy.

## Privacy / logging

Never log API keys, emails, DOB, race, religion, addresses, or staff issue assignments. The
validation report and run summary are restricted to aggregate metrics and diagnostic IDs.
