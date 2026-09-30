# Synthetic Meri cohort configuration release

## Scope

This is a configuration-only, manually dispatched release for exactly:

- repository `neo-capiro/capirov2`, merged `main` only;
- AWS account `967807252336`, region `us-east-1`, cluster `capiro-dev`;
- services `capiro-dev-meriv2-orchestrator` and `capiro-dev-api`;
- tenant slugs `meri-foundation-20260928-t1` and `meri-foundation-20260928-t2`;
- environment key `MERIV3_CANARY_TENANT_SLUGS`.

The workflow does not build or push images, run an ECS task, change models or global routing, read or write a database, expose secret values, run migrations, synthesize/deploy CDK, or create infrastructure. The existing orchestrator image workflow remains build-only and is not changed by this release.

This workflow is not full two-tenant enablement. The separately approved `settings.clioFeatureFlags.meriv3.fullChat=true` updates for tenant IDs `f2d6cf8f-057c-479a-8110-62fe5086d43f` and `52e91176-08f0-4d89-9633-bc212f5bdbbf` still need a concrete reviewed and approved GitHub Actions path that performs and receipts only that bounded transaction. No such Actions path is supplied here. This workflow never performs or claims the database change, and a manual or otherwise untracked database write is not an acceptable substitute. The same two slugs need no new user approval, but this unresolved technical dependency and the independent database-recovery hold on shared releases remain in force.

## Required lead preflight and drain dependency

ECS health does not prove that active research jobs are absent or preserved. Before `apply` (and again before `rollback`), the release lead must use the established read-only database access path to:

1. verify both tenant records and the fixture ownership guard `meriFoundationFixture.fixtureNamespace=meri-foundation-20260928`;
2. verify that the separate concrete approved GitHub Actions database path exists and has receipted the bounded transaction that adds only each tenant's `settings.clioFeatureFlags.meriv3.fullChat=true`, preserving all other settings; until that path exists, do not dispatch apply;
3. query active Meri research jobs for the two tenants and record that none are active, or coordinate and record an explicit drain window without replaying work;
4. record a non-secret receipt reference and approve the service transition.

The workflow requires the exact confirmation `LEAD_CONFIRMED_DB_FLAGS_AND_RESEARCH_DRAIN` and a non-empty, non-secret receipt reference. It stores only the SHA-256 of that reference in its receipt. These inputs are attestations, not database verification and not permission for a manual database write. If the tracked Actions receipt or read-only check cannot prove a safe transition, do not dispatch `apply` or `rollback`.

## Plan (default and read-only)

Dispatch `.github/workflows/meri-synthetic-cohort.yml` from `main` with `mode=plan` and leave every reviewed baseline at its default. The runner:

1. fetches complete `main` history, refuses a shallow checkout, and proves the workflow is the copy merged into current `origin/main` in `neo-capiro/capirov2` using Git's supported object-existence check;
2. proves served API source `42942dedad59382f4b4aac6f904b9aee0e02efa6` and orchestrator source `c2bc41a86ef087e4b163c556595507ec08b396cf` are ancestors of that fetched `origin/main`; the corrected ancestry evidence requires no exception;
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

After validating both targets completely, the runner re-reads both services before its first mutation. It registers derived task definitions that preserve all registerable fields, tags, environment entries, model controls, IAM role references, and secret references. In addition to the two apply definitions, it registers an API rollback definition derived from `capiro-dev-api:483`: the exact original nine-slug configuration with only `:latest` replaced by the exact previously observed digest. This immutable rollback definition prevents a later mutable-tag race. It changes only:

- `MERIV3_CANARY_TENANT_SLUGS`, appending the two approved slugs to the exact nine-slug value;
- the API container image from its reviewed `:latest` reference to the same immutable digest observed on every running API task.

The orchestrator image must already be pinned to its reviewed digest and is not changed. The service update order is orchestrator, then API. Immediately before each update the runner rejects service drift. ECS has no native compare-and-swap for this operation, so the receipt records that unavoidable limitation; repository concurrency plus the immediate rechecks do not claim cross-actor atomicity. Each update has a bounded 15-minute wait and succeeds only after a final authoritative observation shows actual running tasks on the exact new task definition and reviewed digest, service desired/running/pending counts at steady state, and identical PRIMARY desired/running/pending counts.

The workflow uploads a sanitized `receipt.json`. Each service records attempt, response confirmation, authoritative read-back, and steady-state verification separately. An accepted update whose response is lost is read back before any next step; the run may proceed only when the fixed service authoritatively reports the receipt-bound new definition and the exact definition/digest subsequently verifies. It never emits or accepts an arbitrary rollback target and never replays application work.

## Guarded rollback

Rollback accepts no task-definition input. Dispatch from `main` with:

- `mode=rollback`;
- `receipt_run_id` and `receipt_run_attempt` set to the exact prior apply attempt containing `synthetic-cohort-receipt-<run-id>-<run-attempt>`;
- the same lead preflight confirmation and receipt requirements;
- `rollback_confirmation=ROLLBACK_FIXED_SYNTHETIC_MERI_COHORT`.

Before downloading any archive, the workflow uses the official exact workflow-run-attempt endpoint and the artifact-list endpoint through `gh api`, with `GITHUB_TOKEN` only in the process environment. It validates exact repository, workflow path, `main`, `workflow_dispatch`, run ID and attempt, timestamps, source SHA, repository identities, and exactly one unexpired artifact with the unique expected run-attempt name. Artifact metadata is not assumed to contain a nonexistent `run_attempt` field. Only the validated numeric artifact ID is passed to `/actions/artifacts/{artifact_id}/zip`; neither tokens nor signed redirect URLs are printed or persisted.

Before parsing artifact JSON or accessing AWS, the runner revalidates the metadata selection, verifies the SHA-256 of the downloaded archive bytes against GitHub's artifact digest, and opens the ZIP under fixed size limits. It accepts exactly root-level `plan.json` and `receipt.json`, rejecting duplicate, encrypted, symlink, traversal, oversized, missing, or unexpected entries. The receipt itself must bind the same run, attempt, unique artifact name, actor, workflow SHA, target, tenants, and exact apply/rollback task definitions.

The runner then independently describes every receipt-bound task definition and refuses unless the apply definitions are exact derivations of the reviewed priors and the rollback definitions are exact immutable derivations. The API rollback target is the dedicated digest-pinned nine-slug definition registered during apply planning, never mutable `capiro-dev-api:483`; the orchestrator rollback target remains its already pinned reviewed prior. For an indeterminate prior attempt, actual current state must be in the receipt-bound original-prior/apply-new/immutable-rollback set. No other task definition is accepted. Rollback marks its attempt before calling ECS, authoritatively reads back a lost response, rolls API back before orchestrator, and verifies exact rollback definitions and running digests after each update. A lost rollback response therefore cannot be reported as `FAILED_BEFORE_SERVICE_UPDATE`.

Removal of only the two separately added `fullChat` keys likewise requires the separate concrete approved and receipted GitHub Actions database path, preserving fixture metadata and all other settings. Service rollback does not alter the database, delete synthetic records, or replay jobs; do not replace the missing tracked rollback path with a manual database write.

## IAM and verification limitations

The OIDC role named by repository variable `AWS_DEV_GHA_ROLE_ARN` must already trust this repository's `main` subject and must have only the required target permissions. The runner needs read access for STS identity and ECS services/task definitions/tasks; apply additionally needs `ecs:RegisterTaskDefinition`, tagging of preserved task-definition tags where required, `ecs:UpdateService` on exactly the two dev services, and `iam:PassRole` only for the already referenced task/execution roles. This change does not grant or widen any IAM permission. A missing permission causes refusal and may leave a registered but unused task-definition revision; the receipt distinguishes this from a service update.

The 28 offline tests retain the original 20 cases and add direct fail-closed coverage for contradictory PRIMARY/service counts, final apply and rollback `:999` drift, running digest drift, exact run-attempt and unique-name binding, stale/duplicate artifact metadata, exact artifact ID selection, archive-selection tamper, archive-byte digest tamper, and unexpected ZIP entries. A temporary bare remote/clone test still executes the real Git context gate with complete ancestry and the supported object check. They do not contact AWS or GitHub.

Infrastructure/IAM integration tests were **NOT RUN** by this configuration-only implementation. No cloud-provider, network, database, deployment, install, push, or merge operation was performed while preparing it. Runtime success still depends on the existing OIDC trust and least-privilege role having the permissions above. ECS steady state confirms deployment/task identity and image bytes only; it does not guarantee preservation of active research jobs, which is why the separate lead read-only preflight/drain gate is mandatory.
