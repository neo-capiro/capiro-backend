# Synthetic Meri cohort configuration release

## Scope

This is a configuration-only, manually dispatched release for exactly:

- repository `neo-capiro/capirov2`, merged `main` only;
- AWS account `967807252336`, region `us-east-1`, cluster `capiro-dev`;
- services `capiro-dev-meriv2-orchestrator` and `capiro-dev-api`;
- tenant slugs `meri-foundation-20260928-t1` and `meri-foundation-20260928-t2`;
- environment key `MERIV3_CANARY_TENANT_SLUGS`.

The workflow does not build or push images, run an ECS task, change models or global routing, read or write a database, expose secret values, run migrations, synthesize/deploy CDK, or create infrastructure. The existing orchestrator image workflow remains build-only and is not changed by this release.

The separately approved `settings.clioFeatureFlags.meriv3.fullChat=true` updates for tenant IDs `f2d6cf8f-057c-479a-8110-62fe5086d43f` and `52e91176-08f0-4d89-9633-bc212f5bdbbf` remain a lead-owned database transaction. This workflow never performs or claims that transaction.

## Required lead preflight and drain dependency

ECS health does not prove that active research jobs are absent or preserved. Before `apply` (and again before `rollback`), the release lead must use the established read-only database access path to:

1. verify both tenant records and the fixture ownership guard `meriFoundationFixture.fixtureNamespace=meri-foundation-20260928`;
2. execute the separately reviewed transaction that adds only each tenant's `settings.clioFeatureFlags.meriv3.fullChat=true`, preserving all other settings;
3. query active Meri research jobs for the two tenants and record that none are active, or coordinate and record an explicit drain window without replaying work;
4. record a non-secret receipt reference and approve the service transition.

The workflow requires the exact confirmation `LEAD_CONFIRMED_DB_FLAGS_AND_RESEARCH_DRAIN` and a non-empty, non-secret receipt reference. It stores only the SHA-256 of that reference in its receipt. These inputs are attestations, not database verification. If the read-only check cannot prove a safe transition, do not dispatch `apply` or `rollback`.

## Plan (default and read-only)

Dispatch `.github/workflows/meri-synthetic-cohort.yml` from `main` with `mode=plan` and leave every reviewed baseline at its default. The runner:

1. proves the workflow is the copy merged into current `origin/main` in `neo-capiro/capirov2`;
2. proves served API source `42942dedad59382f4b4aac6f904b9aee0e02efa6` and orchestrator source `c2bc41a86ef087e4b163c556595507ec08b396cf` are ancestors of `origin/main`;
3. checks any recognized source-commit `dockerLabels` captured in each ECS task definition against those SHAs;
4. validates the fixed AWS account, region, cluster, two service names, exact task definitions, steady deployments, and exact nine-slug cohort;
5. lists and describes the actual `RUNNING` tasks for each service, requiring every task to use the service's current task definition and the reviewed image digest;
6. derives task-definition requests in memory and proves the only differences are the two appended cohort slugs and the API image pin;
7. writes a sanitized `plan.json` artifact. It never writes a full task definition, environment, secret reference, or secret value to logs/artifacts.

Reviewed baselines:

| Service                          | Task definition                     | Running digest                                                            | Served source                              |
| -------------------------------- | ----------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------ |
| `capiro-dev-api`                 | `capiro-dev-api:483`                | `sha256:640f76d01bd6d0b7658f1229aee90cd7979c75d8b0f7ab7df76a5d5b7abc3c68` | `42942dedad59382f4b4aac6f904b9aee0e02efa6` |
| `capiro-dev-meriv2-orchestrator` | `capiro-dev-meriv2-orchestrator:84` | `sha256:227550d5862037ef026b04e3a7cb8f77e3c3467f409e3ab5144ad0ce725018de` | `c2bc41a86ef087e4b163c556595507ec08b396cf` |

Any drift or concurrent deployment refuses the run.

## Apply

Apply is intentionally not a generic deployment interface. Set:

- `mode=apply`;
- both fixed tenant slugs, both fixed task definitions and digests, and the exact existing nine-slug cohort (the defaults);
- `lead_preflight_confirmation=LEAD_CONFIRMED_DB_FLAGS_AND_RESEARCH_DRAIN`;
- `lead_preflight_receipt` to the non-secret lead receipt reference;
- `apply_confirmation=ENABLE_FIXED_SYNTHETIC_MERI_COHORT`.

After validating both targets completely, the runner re-reads both services before its first mutation. It registers derived task definitions that preserve all registerable fields, tags, environment entries, model controls, IAM role references, and secret references. It changes only:

- `MERIV3_CANARY_TENANT_SLUGS`, appending the two approved slugs to the exact nine-slug value;
- the API container image from its reviewed `:latest` reference to the same immutable digest observed on every running API task.

The orchestrator image must already be pinned to its reviewed digest and is not changed. The service update order is orchestrator, then API. Before each update the runner rejects service drift. Each update has a bounded 15-minute wait and succeeds only after actual running tasks use the exact new task definition and reviewed digest with steady deployment counts.

The workflow uploads a sanitized `receipt.json`. On failure it records whether each update was requested/verified and emits reviewable rollback commands; it never blindly executes those commands or replays application work.

## Guarded rollback

Rollback accepts no task-definition input. Dispatch from `main` with:

- `mode=rollback`;
- `receipt_run_id` set to the prior apply workflow run containing `synthetic-cohort-receipt`;
- the same lead preflight confirmation and receipt requirements;
- `rollback_confirmation=ROLLBACK_FIXED_SYNTHETIC_MERI_COHORT`.

The workflow downloads the named artifact from that exact repository run. The runner accepts only its own apply receipt, exact fixed account/region/cluster/services/tenants/priors/digests, and derived task-definition ARNs in the fixed families. It requires current services to match the receipt before changing anything. Because the prior API task definition refers to `:latest`, rollback also refuses unless ECR `latest` still resolves to the reviewed API digest. It then rolls API back before orchestrator and verifies exact prior task definitions and running digests after each update.

The lead owns removal of only the two separately added `fullChat` keys, preserving fixture metadata and all other settings. Service rollback does not alter the database, delete synthetic records, or replay jobs.

## IAM and verification limitations

The OIDC role named by repository variable `AWS_DEV_GHA_ROLE_ARN` must already trust this repository's `main` subject and must have only the required target permissions. The runner needs read access for STS identity, ECS services/task definitions/tasks, and ECR image metadata; apply additionally needs `ecs:RegisterTaskDefinition`, tagging of preserved task-definition tags where required, `ecs:UpdateService` on exactly the two dev services, and `iam:PassRole` only for the already referenced task/execution roles. This change does not grant or widen any IAM permission. A missing permission causes refusal and may leave a registered but unused task-definition revision; the receipt distinguishes this from a service update.

Offline tests use a fake AWS adapter and exercise planning, transformations, target/family guards, model environment and secret-reference preservation, fail-before-mutation behavior, concurrent service change, partial outcome, guarded rollback, and immutable API pinning. They do not contact AWS.

Infrastructure/IAM integration tests were **NOT RUN** by this configuration-only implementation. No cloud-provider, network, database, deployment, install, push, or merge operation was performed while preparing it. Runtime success still depends on the existing OIDC trust and least-privilege role having the permissions above. ECS steady state confirms deployment/task identity and image bytes only; it does not guarantee preservation of active research jobs, which is why the separate lead read-only preflight/drain gate is mandatory.
