# Meri deployment prerequisite: build isolation and reviewed promotion

Prepared 2026-09-27. This document and all implementation/test references are in
`neo-capiro/capirov2`; no attachment or machine-local handoff is required.

## Scope and completion boundary

This package implements the deployment prerequisite for the consolidated native
Meri V3 improvement plan. It does not implement the later feature releases, restore
the retired Hermes runtime, enable feature flags, migrate production, or deploy an
application. Hermes here was an external coding workhorse, not an application dependency.

Initial code baseline was `f9c218a4ce495018f0f784da442ff9e0b439f6d7`.
The subsequent main change `63c214e9bb3c1ca376aaf233f034df83cb3662df`
(accessibility/deadline fixes, #1899) did not change these deployment paths.
Recheck main and live state before any release; these observations are dated.

PR #1895 had already removed orchestrator auto-deployment and its mutable tag
publication. This package extends that separation to the other reachable paths.
The historic Phase 4 emergency CI exception is not approval for this PR or any
future feature release.

**Implementation is not activation.** Until this PR is reviewed and merged,
main's old workflows remain active. A workflow already queued/running uses its
old definition; merging this change does not cancel it. At 11:25 UTC, a vNext
deployment from #1899 was in progress (Actions run `36315355510`). This package
did not cancel, approve, or change that run. Establish a quiet change window and
recheck Actions before activating the prerequisite.

## Inventory and disposition

| Path | Before | Now |
| --- | --- | --- |
| `api-image.yml`, `api-strategy-image.yml`, `workspace-image.yml` | Main/path builds publish mutable tags and update services | SHA-only build publication; no ECS calls |
| `engagement-api-image.yml`, `intel-api-image.yml`, `onboard-api-image.yml` | Shared/API/lockfile changes can publish and deploy collateral services | Same build-only isolation |
| `web-image.yml` | Build-only, but still moves mutable tag | SHA-only publication |
| `meriv2-orchestrator-image.yml` | Already isolated by #1895 | Preserved; digest evidence and wider guard added |
| `web-vnext-deploy.yml` | Build, register, deploy, rollback on main pushes | Legacy filename retained; display name `web-vnext-image`; focused build/tests retained; promotion removed |
| `deploy-all.yml` | Manual mutable deployment bypass for protected services | Only marketing and sandbox allowed; direct dispatch of any other service fails before AWS credentials |
| `execute-meriv2-ecs-release.mjs` | Bundles migration and five service deployments; resets/preserves selected controls | Retired, immediate failure; history remains in Git |
| `deploy-dev.sh`, `deploy-onboard.sh` | Manual mutable-tag deployment/migration bypass | Retired, immediate failure |
| `prepare-meriv2-ecs-release.mjs` | Legacy read-only preparation | Historical utility only; its manifest is not accepted by the new operator |
| `marketing-image.yml`, `sandbox-image.yml` | Separate product workflows | Unchanged; no Meri/shared/lockfile trigger found |
| `legiwatch-deploy-verify.yml` | Build-completion diagnostic hook | Unchanged; runs read-only DB/image probes, not service promotion; not a qualification signal for the new candidate |
| `oidc-verify.yml` | Manual IAM diagnostics | Unchanged, not dispatched here |

Every protected build publishes one SHA tag and writes its actual image digest
and source SHA to the Actions summary. **A build is a candidate, not a release.**
The guard runs before AWS setup in these build workflows and on every PR.

Some scheduled task definitions historically pull mutable tags without a service
update. Stopping mutable-tag publication also stops new builds silently changing
their next execution. Their schedules, task definitions, and already-published
tags are not changed by this package. Inventory/pin affected scheduled consumers
as a separately reviewed release when their code actually needs promotion.

The source guard is a regression check, not a malicious-YAML sandbox or IAM
permission boundary. Existing AWS credentials, CloudFormation, historical scripts
and administrator consoles can still mutate services. Do not use them to bypass
this release procedure. IAM least-privilege changes need separate review; none
were made here.

## Release operator and safety contract

Implementation: [`scripts/meri-release.mjs`](../../scripts/meri-release.mjs),
[`scripts/lib/meri-release-policy.mjs`](../../scripts/lib/meri-release-policy.mjs).
Requires Node 22, AWS CLI v2 and an authorized AWS identity. No new dependency.

Only account `967807252336`, region `us-east-1`, cluster `capiro-dev` are supported.
**Despite its name, capiro-dev is the production application environment.**
No separate staging environment is assumed. Supported service keys are `api`,
`meriv2-orchestrator`, `workspace`, `api-strategy`, `web`, `web-vnext`,
`engagement-api`, `intel-api`, and `onboard-api`. Each invocation changes at most
one service, and changes only the target container's image. It does not reset
flags or modify roles, secrets, scaling, network settings, load balancers,
service discovery, schedules, or databases.

1. `inspect` performs read-only task/service/target-health checks. It reports
   hashes, task revision, observed running digest and deployment configuration,
   not task environment or secret values. Its output is explicitly not qualification.
2. `prepare` validates candidate-bound human qualification evidence, verifies the
   SHA tag and supplied immutable digest agree in ECR, captures a healthy baseline,
   and creates a one-hour manifest without AWS writes. The observed rollback digest
   must still exist in ECR. Manifests contain hashes, not complete task definitions.
3. `promote` requires an approved manifest fingerprint and exact production/service
   confirmation. It validates qualification, account, candidate bytes, healthy
   running tasks, and full baseline fingerprints before any registration. It clones
   live task definitions in memory, changes only images, and registers pinned
   rollback/candidate revisions. It verifies registered contents, rechecks the
   baseline after registration, and reads it again immediately before UpdateService.
4. Health readback binds the exact deployment ID, revision, task hash, running
   digest, desired count, and each actual task IP/port's ALB target health. Other
   healthy targets cannot satisfy the check. There is a 25-minute polling budget
   and at most 100 polls, plus bounded in-flight AWS reads. Success means
   **ECS healthy; authenticated application acceptance still required**.
5. `rollback` requires a separately reviewed receipt fingerprint and explicit
   confirmation. It verifies both registered task hashes, the old digest's ECR
   presence, and the still-current candidate deployment/configuration immediately
   before updating. A concurrent rollout or configuration change blocks rollback.
6. Both writes persist an uncertainty receipt before calling UpdateService and
   retain the deployment ID returned by AWS. Receipt updates use synced temporary
   files and same-directory atomic replacement, preserving the last complete
   record if replacement fails. The helper never automatically retries a mutation
   or automatically rolls back on an error.

ECS itself may still automatically roll back according to its existing circuit
breaker or alarm settings. These settings are preserved. If either mechanism is
enabled for rollback, a tag-based baseline is refused: ECS could otherwise
re-pull different bytes. Such a service needs a separate reviewed baseline
normalization. If automatic rollback is disabled, an attended promotion may start
from a tag-based baseline: the explicit rollback revision is pinned to the digest
observed uniformly across running tasks, never to a fresh tag resolution. A failed
deployment can remain degraded until the operator reconciles and rolls it back.

Unpinned sidecars, mutable environment files, unsupported network/rollout types,
unknown task-definition fields, missing health evidence, and mixed running digests
fail closed. Unknown service configuration fields participate in drift detection.
Secret *references* are preserved; secret values are never fetched. This procedure
does not undo secret rotations or external configuration changes.

**ECS UpdateService has no compare-and-swap input.** Fingerprints detect drift;
they are not a distributed lock. An exclusive change window covering all operators,
autoscaling/configuration changes and other service-mutating automation is required
from preparation through acceptance/rollback. There remains a read/write race if
another actor ignores that window. Do not describe this tool as atomic against
arbitrary administrators.

## Qualification evidence and migration rules

Qualification is an explicit **human-reviewed attestation**, not a signature or
an automated GitHub check verifier. The operator validates its shape, exact
candidate binding, expiry and ECR identity; the reviewer must inspect linked
results, their conclusions, and their relationship to the candidate. A fabricated
or unrelated URL is not proof, even if it passes URL syntax validation.

Before signing off, record and inspect:

- Exact source/merge SHA, image digest, build run, relevant test runs and reviewer.
- Retirement compatibility: intended runtime/import graph contains no restored
  Hermes modules or dependence on dropped tables. Legacy release-label environment
  names alone do not prove an active runtime; check source and execution.
- Relevant native V3 flags/models and defaults. Keep unfinished features globally
  off, with global off dominating tenant/surface opt-in. This operator preserves
  flags; a flag change requires a separate exact reviewed configuration change.
- For schema changes, fresh-database rehearsal **and** supported upgrade history
  including retirement, using the actual migration runner/transaction behavior.
  Include migration identities/checksums, final schema and scope/ownership/grant/RLS
  assertions where applicable—not just a migration count.
- Old/new image compatibility during rolling replacement; confirm the production
  ledger against the reviewed schema before promotion. Qualify/apply migrations
  through a separately authorized procedure. This operator never runs migrations.
- Retain additive compatible schema on application rollback. Do not assume a down
  migration is safe, or that old-branch “445/449 migrations passed” qualifies a new tree.

For a schema change, `freshDatabase`, `retiredUpgrade`, and `compatibility` must
each be `{ "status": "passed", "url": "<versioned repository evidence>" }`.
Use commit-pinned repository documents or Actions run/attempt links; preserve
sanitized evidence before Actions retention expires. GitHub links use this repo,
not machine paths or branch-relative mutable claims.

A qualification JSON has these fields (placeholders intentionally are not usable):

```json
{
  "schemaVersion": 1,
  "service": "api",
  "sourceSha": "<40-character candidate commit>",
  "image": "967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/api@sha256:<64 hex>",
  "status": "qualified",
  "reviewer": "<reviewer's authenticated identity>",
  "reviewedAt": "<UTC timestamp>",
  "expiresAt": "<future UTC timestamp, at most 24 hours>",
  "schemaChange": false,
  "evidence": ["<commit-pinned qualification report URL>"],
  "checks": [
    { "name": "build", "status": "passed", "sourceSha": "<same SHA>", "image": "<same image>", "url": "<build evidence URL>" },
    { "name": "automated-tests", "status": "passed", "sourceSha": "<same SHA>", "image": "<same image>", "url": "<test evidence URL>" },
    { "name": "retirement-compatibility", "status": "passed", "sourceSha": "<same SHA>", "image": "<same image>", "url": "<review evidence URL>" }
  ]
}
```

## Attended commands and recovery

Run from the repository root on any authorized machine. File names below are
new operator artifacts, not dependencies on the authoring machine. Keep these
artifacts in secure persistent storage; commit sanitized evidence when appropriate.
Do not commit raw task definitions, environment values or secrets.

```sh
node scripts/meri-release.mjs inspect --service api --profile capiro-dev
node scripts/meri-release.mjs prepare --qualification qualification.json --out manifest.json --profile capiro-dev
```

Review the manifest, its displayed `manifestHash`, candidate evidence and change
window. Only after explicit release approval, substitute that hash:

```sh
node scripts/meri-release.mjs promote --manifest manifest.json --approve APPROVED_MANIFEST_HASH --confirm PROMOTE_CAPIRO_PRODUCTION_api --receipt promotion-receipt.json --profile capiro-dev
```

For an explicitly approved rollback, first review the complete promotion receipt
and compute its fingerprint using the repository function:

```sh
node --input-type=module -e "import {readFileSync} from 'node:fs'; import {fingerprint} from './scripts/lib/meri-release-policy.mjs'; console.log(fingerprint(JSON.parse(readFileSync('promotion-receipt.json','utf8'))));"
node scripts/meri-release.mjs rollback --manifest promotion-receipt.json --approve APPROVED_RECEIPT_HASH --confirm ROLLBACK_CAPIRO_PRODUCTION_api --receipt rollback-receipt.json --profile capiro-dev
```

On failure:

- Before registration: no AWS mutation occurred. Investigate and prepare/review anew.
- Registration-only: unused revisions can remain; no service update was sent.
  Keep the receipt; do not assume registration itself deployed anything.
- `update-outcome-unknown` or `rollback-update-outcome-unknown`: AWS may have
  accepted the update. Do not re-run the write or invent a deployment ID. Compare
  service primary deployment, task revision, running tasks and CloudTrail privately;
  preserve the original receipt. Obtain reviewed reconciliation evidence before
  creating a corrected recovery receipt or authorizing a fresh operation.
- Health failure/timeout: the helper does not claim rollback. Reconcile the live
  state, review the receipt and use guarded rollback if it still owns the rollout.
- Drift or ECS's own rollback: stop. Never force an old receipt over another
  operator's newer state. Prepare a newly reviewed recovery plan if necessary.

After ECS health passes, use a controlled authenticated fixture tenant, then an
internal allowlisted canary, then measured expansion. Verify API and workspace,
auth/client isolation, correct outcomes, source citations, actual artifact bytes,
memory approvals and relevant JEV behavior. Record traces, effective flags/models,
latency and cost. One healthy service does not qualify another; stop between services.

## Verification and dated observations

No production application deployment, migration, flag change, IAM change, ECR
publication/tag change or schedule change was executed for this package.

Local checks:

| Command | Result |
| --- | --- |
| `node --test scripts/lib/meri-release-policy.test.mjs scripts/meri-release.test.mjs` | Exit 0; 34 tests pass |
| `python scripts/validate-meri-build-isolation.py --self-test` | Exit 0; 12 mutation/regression tests pass |
| `python scripts/validate-meri-build-isolation.py` | Exit 0; 9 build workflows and bypass controls pass |
| `python scripts/validate-meri-orchestrator-build-only.py` | Exit 0; original 5/5 checks preserved |
| `node scripts/verify-meriv2-release-scripts.mjs` | Exit 0; 6 legacy script parse/contracts, no AWS mutation |
| YAML syntax parse | All 68 workflow files parse |
| `git diff --check` | Exit 0 |

The Node tests use injected AWS fakes, including concurrent same-revision
deployments, changed flags/config, changed SHA tags, unrelated healthy targets,
lost update responses, guarded rollback and interrupted receipt replacement.
They do not constitute a live deployment rehearsal. Full application/75-case
benchmark and production DB rehearsal were not run: this change has no application
or migration modification. Those gates still apply to future feature candidates.

Read-only AWS inspection at approximately **2026-09-27 11:20–11:23 UTC**:

| Service | Revision | Task image | Circuit breaker rollback | Evidence level |
| --- | --- | --- | --- | --- |
| API | 483 | mutable tag; observed running digest `ec98868ccf9a55525addbf2db4dee93f4d09cf2668e585292412bdc40c1ecc42` | Off | 2/2 tasks, actual digest and task ALB targets healthy via new `inspect` command |
| Orchestrator | 84 | digest `227550d5862037ef026b04e3a7cb8f77e3c3467f409e3ab5144ad0ce725018de` | On | 1/1; same full read-only inspection passed |
| vNext web | 379 | digest `642682e962adf8fe2ed3ccc9f409a6198387c75f8424c78b838cc2d26e8b4e47` | On | 1/1; same full read-only inspection passed; later deployment may supersede it |
| Workspace | 43 | Pinned digest | Off | Service/task-definition readback only |
| API strategy | 28 | Pinned digest | On | Service/task-definition readback only |
| Canonical web | 144 | Pinned digest | On | Service/task-definition readback only |
| Engagement API | 126 | Pinned digest | On | Service/task-definition readback only |
| Intel API | 56 | Pinned digest | Off | Service/task-definition readback only |
| Onboard API | 4 | Mutable tag | Off | Service/task-definition readback only |

All nine service descriptions were stable at that instant. API's earlier in-progress
deployment had completed. Current orchestrator task environment declared
`MERIV3_ENABLED=true`; no retired Hermes module was found in either current main
application module entrypoint. This is not authenticated feature/flag qualification
or a production migration-ledger audit. Existing Phase 4 *release-label* environment
names were left untouched and must not be confused with feature enablement.

## Hermes supervision and handoff

Hermes used `qwen/qwen3.6-plus` via OpenRouter for bounded audit/code/test drafts.
Drafts were independently reviewed and corrected before integration; low cost was
not treated as proof of correctness. Maximum recorded conservative request-context
bound was **13.31% of its 1,000,000-token context**, below the requested 50% ceiling.
The pre-dispatch guard reserved input-byte/framing bounds plus maximum output,
refused model fallback, and capped each dispatch session at $0.35 estimated cost.
One session hit that conservative cost reservation and stopped. Some initial
transport attempts lacked usable usage totals, and reasoning-output exhaustion
required shorter work packets; do not present partial provider estimates as a
complete account bill. No installed Hermes configuration or application runtime
was changed, and no Hermes helper should remain running after handoff.

Next agent/operator:

1. Start from the PR branch/current main; run the checks above on the intended
   merge tree. Resolve new overlapping workflow changes explicitly.
2. Review and merge the prerequisite only under normal repository policy. No
   inherited emergency skip-CI waiver, force push, or automatic merge is authorized.
3. Account for every queued/running old image/deployment job before relying on
   build isolation. Confirm no build path updates services or mutable tags.
4. For the next actual native V3 candidate, create real qualification evidence,
   inspect fresh live state, obtain an exclusive approved change window, and use
   the one-service digest procedure. Do not treat this package as rollout approval.
5. Continue the consolidated feature plan only after isolation is active. Do not
   reintroduce the old Phase 4 migration package or Hermes runtime wholesale.
