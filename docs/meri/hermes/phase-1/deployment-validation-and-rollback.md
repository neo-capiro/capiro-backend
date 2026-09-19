# Deployment validation and rollback package — Meri ⇄ Hermes Phase 1

Prepared 2026-09-19. **Status: prepared, not executed.** No AWS resource was created, modified or read-for-change while preparing this. The pilot gate is closed in every environment. This document is the concrete package to be reviewed and authorized *before* any cloud validation runs; it is not a request to activate the production pilot, which is a separate decision (`decisions.md` D8).

## 1. The environment problem, stated plainly

`capiro-dev` is **not** a development environment. Per `infra/cdk/lib/config.ts` (search "ARE the live production deployment") and `infra/cdk/DRIFT-FINDINGS.md`, the `env=dev` stacks — ECS cluster `capiro-dev`, services `capiro-dev-api` / `capiro-dev-web-vnext` / `capiro-dev-engagement-api`, Aurora cluster `capiro-dev-data-auroracluster23d869c0-ltmz40k47ewv`, AWS account **967807252336**, region **us-east-1** — are the live production deployment serving `app.capiro.ai` and `capiro.ai`. The naming is known, deliberate drift.

**No isolated staging environment has been verified to exist.** Therefore every cloud gate in the Phase 1 closeout is **BLOCKED** until one of the options in §3 is authorized. Nothing in this package may be run against the resources listed above.

Resources that must **not** be modified by this validation, under any option: the `capiro-dev` ECS cluster and its services/task definitions, the Aurora cluster above and any database on it, the production ALBs/listeners/target groups, Route 53 records for `capiro.ai` / `app.capiro.ai` / `os.capiro.ai`, the existing ECR repositories used by running services, and any Secrets Manager secret consumed by a running production task.

## 2. What the validation must prove

These are the gates that cannot be closed locally. Each maps to a requirement in the closeout handoff §5.

| # | Gate | Pass condition |
|---|---|---|
| V1 | Pinned **ARM64** image runs on real Fargate | Task reaches RUNNING from the pinned digest; `GET /health` and `/v1/capabilities` answer over private networking |
| V2 | Capability parity vs the accepted amd64 baseline | `/v1/capabilities`, `/v1/toolsets` match the Phase 0 evidence set, or every difference is explained and accepted |
| V3 | First-use startup measured | Cold provision → first useful event, recorded with the image pull time separated out (the image is ~3.96 GB) |
| V4 | Task replacement restores state | Persona, skills and native session continue after the task is replaced; **idle teardown preserves authorized state** |
| V5 | Cancellation and revocation reach the worker | Stop and an authorization downgrade both actually interrupt the running worker, not just Meri's record |
| V6 | Failed provisioning and orphans are detected and cleaned | A deliberately broken provision is bounded, reported and leaves no running task or stray volume |
| V7 | Isolation holds on real infrastructure | Two scopes cannot read each other's home volume; the worker cannot reach the application database or connector secrets |

Recorded for each: resource IDs, image digest, configuration, redacted traces, timings, and the cleanup outcome.

## 3. Isolation options (pick one; all require authorization)

**Option A — separate AWS account (recommended).** A sandbox account with no production data, peered to nothing. Blast radius is structurally zero. Cost is the resources below. Requires: account provisioning + an ECR repository in that account (or cross-account pull permission for a single repository).

**Option B — isolated stack inside account 967807252336.** Everything new and distinctly named (`capiro-hermesval-*`), with **no** shared resources: its own ECS cluster, its own security group, its own EFS file system, its own log groups, and a **separate database** — either a small dedicated Aurora Serverless v2 instance or a dedicated database on a non-production instance, never the production Aurora cluster. Blast radius is bounded by naming and by touching no existing resource, but it is still the same account and the same VPC unless a new VPC is also created. Requires explicit acknowledgement that a mistake here is adjacent to production.

**Option C — not recommended.** Reusing the `capiro-dev` cluster with a new task family. Rejected: it places validation tasks on the cluster that serves customers, shares its security groups and log ingestion, and makes an accidental service/TD mutation plausible. Do not do this merely because the cluster is named "dev".

Everything below assumes Option A or B.

## 4. Exact changes to be made

**4.1 Image and registry (ticket #3).** Build the pinned upstream Hermes base from the checksum-verified source tarball (tag `v2026.9.14`, commit `7a963716b81be13ba513d4f127633b7da493aff2`, tarball SHA-256 `47df72eb…7834`) for `linux/arm64`, then the Meri layer on top:

```
PLATFORM=linux/arm64 ./docker/hermes-worker/build-base.sh
```

Prerequisites, all verified locally already: a `docker-container` buildx builder (`capiro-arm` exists and reports native `linux/arm64`; Docker Desktop's default driver is **not** sufficient and produces `exec format error`), and host memory headroom — the build is ~45 minutes and a prior attempt on this host failed at ~1.0 GB free. Push to a **new** ECR repository (`meri-hermes-worker`), record the resulting immutable digest in `docs/meri/hermes/phase-0/pins.md`, and pin every task definition to that digest, never a tag. A bundled-skill license review (upstream seeds 58 skills at first boot; only the top-level MIT license was reviewed in Phase 0) is a prerequisite for distribution sign-off and is **not yet done**.

**4.2 Worker infrastructure (ticket #2).** The CDK construct and the API-side lifecycle service are being prepared in this branch; see `closeout-report.md` for their delivered state. Shape: Fargate task definition, `cpuArchitecture: ARM64`, 1 vCPU / 2 GiB (per `measurements.md`), image by digest, no public IP, egress constrained to the model provider and the Meri API, a narrowly-scoped task role (no application-database access, no connector secrets — the worker reaches data only through the broker), a CloudWatch log group, and an EFS file system providing one access point per execution scope for the writable Hermes home.

**4.3 Application configuration.** Only the names in `pilot-configuration.md` §2–§3. `MERI_HERMES_ENABLED` stays `false`; the tenant allowlist stays empty; the per-tenant flag stays off. Validation uses **synthetic** identities in the isolated environment, not the designated pilot users.

## 5. Migrations

Three additive migrations exist on this branch (`20280920010000_meri_hermes_durable_runs`, `20280920020000_meri_hermes_admission_fencing`, plus the coordination migration added during closeout — see `closeout-report.md` for its final name). All are additive: new tables, new nullable/defaulted columns, new indexes and RLS policies. No column is dropped or retyped, so an older API revision continues to run against the migrated schema — that is what makes rollback safe.

**Before any deployment, inventory what is actually pending on the target:**

```
DATABASE_URL=<target> npx prisma migrate status
```

`prisma migrate deploy` applies **every pending migration**, not only the ones added here. If the target is behind on unrelated migrations from other workstreams, those will also apply. Review the full pending set explicitly and get it approved; do not assume it is just these three. Never run `prisma migrate dev`, `db push` or `migrate reset` against a shared database — a diff-based command against this schema will propose dropping unrelated tables (observed locally: `legiwatch_cutover_state`, `legiwatch_runtime_heartbeat`). Never edit an already-applied migration.

**Known operational hazard, specific to this account.** The `capiro-dev-api-admin-migrate` task definition pins an image **digest**, and the standard deploy script runs it *without re-registering the task definition*. `prisma migrate deploy` then executes from whatever old image the TD was pinned to, which does not contain newly added migrations — the task exits 0 and the deploy reports success while the migration silently never applies. If any migrate task is used here, re-register the task definition against the image actually being deployed first, then run that ARN, and verify by reading the task's CloudWatch stream for the literal `Applying migration …` lines rather than trusting exit 0.

## 6. Cost envelope

Estimates for the declared pilot envelope in `decisions.md` §4 (1 tenant, 2 users, **no warm pool**, 10-minute idle grace). **Confirm against current AWS pricing before sign-off; these are planning figures, not quotes.**

| Item | Basis | Estimate |
|---|---|---|
| Fargate worker | 1 vCPU / 2 GiB, ARM64, us-east-1. The recorded x86 figure for this size is ≈$0.0494/worker-hour; Graviton is priced below x86, so ≈**$0.040/worker-hour** | 2 users × ~2 h/working day × 22 days ≈ 88 worker-hours ≈ **$3.50/month** |
| EFS | Per-scope homes, a few GB total, standard storage | **< $2/month** |
| ECR | ~3.96 GB image | **< $1/month** |
| NAT / egress | Model-provider traffic from private subnets | Small, but **NAT hourly charges dominate if a NAT gateway is created solely for this** — prefer VPC endpoints or an existing NAT |
| Model tokens | Per `decisions.md` §4: ≤50 k tokens/run, ≤2 M tokens/tenant/day, hard cap **USD 25/tenant/day** | Bounded by the cap, not by compute |
| Isolated database (Option B) | Small Aurora Serverless v2 or a dedicated database | **Dominates the envelope**; size it explicitly before approving |

The compute envelope is genuinely small; the cost risk is the isolated database and any NAT created for this purpose, not the workers.

## 7. Validation procedure

1. Create the isolated resources (§3/§4.2). Record every resource ID.
2. Push the ARM64 image; record the digest; pin it.
3. Apply the reviewed migration set to the isolated database (§5), verifying the applied migration names in logs.
4. Bring up the API with the gate **closed**, confirm `/api/clio/hermes/capabilities` is 404 for every tenant.
5. Open the gate for a **synthetic** tenant only. Run V1–V7 in order, recording evidence per gate.
6. Exercise failure paths deliberately: broken image digest, unreachable worker, worker killed mid-run, membership revoked mid-tool-call, Stop during approval-wait.
7. Tear everything down and verify no task, volume, access point or log group is left running. Record the cleanup outcome.

## 8. Rollback

**Kill switch (fastest, no deploy).** Any one of the three gate keys closes the pilot: unset `MERI_HERMES_ENABLED`, remove the tenant id from `MERI_HERMES_PILOT_TENANT_IDS`, or set the per-tenant flag false (`set:tenant-flag … --value false --commit`, effective within the 60-second flag cache). New turns route to V3/legacy exactly as before; `/api/clio/hermes/*` returns 404.

**Active runs are handled explicitly, not orphaned.** Closing the gate stops new *admissions*; it must not make live workers uncontrollable. Drain policy: let in-flight runs finish within their wall-clock budget, or cancel them via `POST /api/clio/hermes/runs/:id/stop`, which reaches the worker and produces an honest `cancelled` terminal state. Any run whose consuming replica has died is reconciled to `interrupted` — never silently to success. Run records, events and the audit trail are retained regardless; rollback is not a data deletion.

**Exactly which operations survive the gate closing.** This was a genuine code/document contradiction found during closeout — the controller routed Stop through the enablement check, so disabling the pilot also removed the ability to stop the runs it left behind. The contract, now enforced in code and tested:

| Operation on an already-admitted run | After the gate closes | Why |
|---|---|---|
| `POST …/runs/:id/stop` | **Allowed** (ownership only) | Otherwise the kill switch strands live workers — the opposite of a rollback |
| `GET …/runs/:id`, `GET …/runs/:id/events` | **Allowed** (ownership only) | The operator and the user must be able to watch the drain complete |
| New submissions / a new turn | **Refused** | This is the point of the kill switch |
| `GET …/capabilities` | **Refused (404)** | The pilot surface is invisible outside the gate |
| `POST …/runs/:id/approval` | **Refused** | Approving a native command after disable would grant the worker *new* execution. Stop is the correct drain path for a run waiting on approval |

Ownership is still required for every allowed operation: a non-owner receives 404 exactly as before.

**Code rollback.** Deploy the previous API revision. Because every migration is additive, the older revision runs unchanged against the migrated schema; the new tables simply go unused. Do **not** attempt a down-migration to "clean up" — dropping `meri_agent_runs` and friends would destroy the audit record of what the pilot did.

**Infrastructure rollback.** Delete the isolated stack created in §3. In Option B, deletion is by the distinct `capiro-hermesval-*` names only; verify no resource outside that prefix is in the change set before applying.

**What rollback does not do.** It does not retroactively undo any external side effect a run already completed. Phase 1 exposes no external business writes through the runtime (business actions remain with Meri's own executor and approval records), which is what keeps this property true; that must be re-checked before Phase 2 adds mail/MCP write paths.

## 9. Authorization being requested

1. Which isolation option (§3), and for Option B, acknowledgement that validation runs in the production account under a distinct name.
2. Creation of the resources in §4.2 plus one new ECR repository, in the isolated environment only.
3. Approval of the reviewed pending-migration set (§5) for the isolated database only.
4. A cost ceiling for the isolated database and any NAT (§6).

Not requested here, and explicitly out of scope: production pilot activation, any change to `capiro-dev` resources, and any tenant-allowlist expansion.
