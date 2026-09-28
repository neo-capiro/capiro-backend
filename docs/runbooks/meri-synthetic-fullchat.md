Meri synthetic foundation fullChat flag workflow

Scope

`.github/workflows/meri-synthetic-fullchat.yml` owns only the database flag step for these two identities:

- `f2d6cf8f-057c-479a-8110-62fe5086d43f` / `meri-foundation-20260928-t1`
- `52e91176-08f0-4d89-9633-bc212f5bdbbf` / `meri-foundation-20260928-t2`

The only key is the literal dotted key `clioFeatureFlags['meriv3.fullChat']`. It is not a nested `meriv3` object. The existing `set-tenant-flag` image command remains the owner; its generic `--slug/--flag/--value [--commit]` contract is unchanged.

This workflow is separate from `.github/workflows/meri-synthetic-cohort.yml`. It does not change the canary-slug environment, roll either ECS service, drain research, recover a database, release a hold, run migrations, create IAM/network resources, or deploy an image.

Qualification gate before any workflow run

Do not dispatch this workflow until all of the following are true:

1. The implementation is merged to current `main`.
2. An approved API image is built from that merged commit. A branch image is not eligible. The repository's current API build path, `.github/workflows/api-image.yml`, explicitly sets `provenance: false`, does not capture the build step's digest output, and uploads no build attestation or manifest. Therefore source labels, SHA tags, and ECS/ECR digest agreement alone are not accepted as digest-to-source provenance for this release.
3. Both the running `capiro-dev-api` tasks and the latest active `capiro-dev-api-diag` task definition resolve to the same immutable `capiro/dev/api@sha256:...` digest and exact 40-character source commit.
4. The `capiro-dev-api-diag` revision has exactly one container definition, named `db-inspect`, and no task-definition `entryPoint` override (so the API image entrypoint dispatches `set-tenant-flag`). Secret and environment names must each be nonempty and unique. The two name sets must be disjoint; `DB_HOST`, `DB_PORT`, `DB_USER`, and `DB_PASSWORD` must exist only as the four exact secret references used by the served API, while exactly one plaintext `DB_NAME` must equal the served API value. The workflow never registers or repairs this revision.
5. The Actions role already has the bounded runtime permissions required to describe ECS state, run only the existing `capiro-dev-api-diag` family on `capiro-dev`, pass the unchanged existing API roles, and read that task's existing CloudWatch log stream. This code does not add permissions and has no manual-DB fallback.

The runner checks that the image-declared source commit is an ancestor of current `origin/main` and that the declared source tree contains the fixed foundation mode before it starts a task. That is a metadata/source-content guard, not proof that the observed image digest was built from that commit.

Concrete digest-to-source release requirement

No checked-in approved API-image attestation or build-manifest path exists today: the inspected `api-image.yml` path disables provenance and retains no manifest. Do not invent or infer one from image labels. Before any dispatch, release engineering must separately approve and retain a build-system-produced record that binds all of the following in one reviewed build: repository `neo-capiro/capirov2`, exact merged 40-character commit, root build context, `apps/api/Dockerfile`, `linux/arm64`, ECR repository `967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/api`, and the resulting `sha256` image digest. The reviewer must verify the record against the trusted build run's resolved source revision and output digest, then verify that exact digest is the one carried by the commit tag, every running API task, and the single-container diag revision. Until such an approved retained record exists, plan/apply/rollback remain HOLD even if this runner's metadata checks pass.

Modes

Plan (default)

Plan accepts no source receipt or confirmation. It runs the fixed command in read-only mode, locks and reads exactly the two tenant rows through `app.current_tenant`, and uploads one sanitized receipt. The receipt contains only tenant ID/slug and prior flag presence/value. It never contains the surrounding settings JSON.

Apply

Apply requires:

- the exact successful plan workflow run ID and run attempt;
- `APPLY_FIXED_MERI_FOUNDATION_FULLCHAT`.

The workflow validates GitHub run/attempt/artifact metadata and archive SHA-256, then passes the plan's exact prior states to the fixed command. One serializable transaction locks both exact UUID+slug rows, compares both prior states, and sets the literal dotted key to boolean `true` with JSONB path updates. Any mismatch aborts both rows. Exact in-transaction readback and task exit code zero are required before `verified: true`.

Rollback

Rollback requires:

- the exact successful apply workflow run ID and run attempt;
- `ROLLBACK_FIXED_MERI_FOUNDATION_FULLCHAT`.

It restores each apply receipt's exact prior state: absent remains absent, false returns to false, and any other prior JSON value is restored. Unrelated settings and flags are preserved. A state other than applied `true` or the exact prior state fails closed. Exact prior state is accepted only as reconciliation of an already-completed rollback; the runner never blindly submits a second ECS task after an ambiguous `RunTask` acknowledgement.

Cohort/research sequencing remains independent

After a verified fullChat apply receipt exists, the release lead still performs the separate active-research drain and the existing synthetic cohort preflight. The lead may then use the fullChat receipt reference as part of the existing non-secret `lead_preflight_receipt`, with the existing exact `LEAD_CONFIRMED_DB_FLAGS_AND_RESEARCH_DRAIN` confirmation. Nothing in this workflow satisfies or weakens that separate hold.

For rollback, first use the existing receipt-bound cohort rollback and independently confirm the service/cohort recovery and research state. Then run this workflow's receipt-bound rollback to restore only the two DB flags. Retain both receipts. Never replay user/provider actions.

Runtime failures

- A missing qualified image/task definition is a hard refusal, not permission to use an old image.
- Missing ECS/PassRole/CloudWatch permissions are a hard refusal; do not fall back to direct SQL.
- An extra task-definition or stopped-task container, a nonzero task, absent/duplicate sanitized result, wrong tenant/key, image/source drift, ambiguous/duplicate DB names or sources, unexpected result root field, or readback mismatch can never produce `verified: true`.
- If `RunTask` acknowledgement is lost, the runner reconciles the unique fixed `startedBy` identity. Zero or multiple matches fails without a retry.
