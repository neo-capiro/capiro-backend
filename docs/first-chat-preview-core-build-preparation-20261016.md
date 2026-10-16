# Held first-chat Core image build

This is a source and approval bundle. No source ZIP has been uploaded, CodeBuild project created, build started, ECR image pushed, ECS task run, or database command issued. The local Windows Docker daemon remains inaccessible; this plan uses the supported CodeBuild Docker environment after separate action approval.

## Immutable input

| Item | Exact value |
| --- | --- |
| Core runtime source | PR #43 commit `13d12a7d7bdbe0be021cb218dd4cf7690cc4420b` |
| Local Git archive ZIP | `../../first-chat-core-pr43-source-13d12a7.zip`, 42,406,170 bytes |
| ZIP SHA-256 | `8643d671d641fb6379c442931e2ed953c2654b418580e7274116d2e4c4d68b16` |
| S3 key after approval | `inputs/core-13d12a7d7bdbe0be021cb218dd4cf7690cc4420b.zip` |
| Target ECR repository | `967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/preview-core` |
| Image tag | Exact 40-character source commit, in an **immutable-tag** repository |
| Buildspec | [`infra/deploy/first-chat-core-preview.buildspec.yml`](../infra/deploy/first-chat-core-preview.buildspec.yml), supplied as the dedicated project's inline buildspec; the PR #43 ZIP intentionally does not contain PR #44 deployment source |
| Buildspec SHA-256 | `e8b79a418eae4369cc4577d82889ca0f191db177177ef8cd0c5380c2c21a45b3` over the reviewed 3,653-byte file |

The ZIP was made with `git archive` from that exact commit using only the repository-root Dockerfile inputs: root build files, `apps/api` Dockerfile/package/src/prisma/scripts/data/config, and `packages/{shared,meriv2-core,defense-contracts,defense-domain}` package/src/config. Archive inspection found the receipt migration and no Objective migration, `node_modules`, or `.env` files. The buildspec downloads the same exact S3 object version again and checks the static ZIP hash before it builds; neither a branch name nor the current PR #44 checkout selects runtime bytes. The 475-migration checksum manifest is in [`infra/deploy`](../infra/deploy/first-chat-core-pr43-migration-checksums.json) (LF-normalized SHA-256 `cebd7886545e3fbee1c3024a2d2c2e6f3fab8127c1d77c01341bd16f0b6ad5ac`).

## Small dedicated job, held

Create one versioned, SSE-S3 source bucket or bind an already approved bucket with those same properties. Upload the ZIP at the fixed key, retain its S3 **VersionId**, and verify the uploaded object's downloaded bytes against the hash above. Then create a separate `capiro-preview-first-chat-core-build` CodeBuild project with:

- `ProjectSource.type=S3` with `location=<approved-source-bucket>/inputs/core-13d12a7d7bdbe0be021cb218dd4cf7690cc4420b.zip`; CodeBuild exposes that input to the build as `CODEBUILD_SOURCE_REPO_URL=s3://<approved-source-bucket>/...`. Set the inline buildspec to the reviewed YAML in this PR. Give the project fixed environment variables `APPROVED_SOURCE_BUCKET` and `APPROVED_SOURCE_VERSION_ID`. Pass the same VersionId as `StartBuild.sourceVersion`. Do not permit caller source/buildspec/environment overrides in the approved build invocation.
- `LINUX_CONTAINER`, `aws/codebuild/standard:8.0`, `BUILD_GENERAL1_LARGE` (16 GiB), x86_64, privileged Docker, `DOCKER_BUILDKIT=1`, account `967807252336`, `us-east-1`. No VPC attachment (the build needs package registries and ECR Public), webhook, cache, retry, secondary sources, or artifacts. A dedicated log group can retain the build receipt.
- Existing Capiro shipping role `arn:aws:iam::967807252336:role/capiro-codebuild-role` after exact action-time review. Read-only IAM simulation allows ECR `PutImage` and `DescribeImages` for the new repo; it denies `ecs:UpdateService` and `secretsmanager:GetSecretValue`. Its existing managed ECR power-user policy also covers the layer-check/upload/complete actions; confirm this again at action time. Its broad existing ECR/log policies remain a limitation. Add only scoped S3 source read (`GetBucketLocation` on the chosen bucket and `GetObject`/`GetObjectVersion` on this exact key). Avoid granting new deployment or secret rights. A new role would narrow ECR/log scope but is not technically required for this build.
- Registry stack from PR #44 first, with immutable tags and scan-on-push. The project cannot push until that separate stack is reviewed and approved. Never use the older Capiro CodeBuild projects: their sources, mutable tags, and in some cases automatic ECS redeploy commands target other services.

The `ProjectSource.location` form and inline buildspec placement are specified in the [CodeBuild ProjectSource API](https://docs.aws.amazon.com/codebuild/latest/APIReference/API_ProjectSource.html). AWS documents the S3 URL and VersionId forms of `CODEBUILD_SOURCE_REPO_URL` and `CODEBUILD_SOURCE_VERSION` in its [build environment variables](https://docs.aws.amazon.com/codebuild/latest/userguide/build-env-ref-env-vars.html).

Immediately before an approved `StartBuild`, read back the project definition and verify the inline buildspec is byte-for-byte the hash-pinned file above, plus its exact S3 source URL, fixed environment values, service role, architecture, Docker privilege and absent webhook/secondary source. Verify the build request uses the approved source VersionId and has no source, buildspec or environment overrides. If any comparison differs, stop before starting a paid build.

The buildspec fails closed on account/region/architecture, S3 source URL and VersionId, ZIP hash, receipt migration presence, Objective migration absence, ECR tag availability, runtime Node/Prisma import, and pushed digest. It does **not** call ECS or query the database. If the Dockerfile's fixed 4 GiB Nest heap fails inside a 16 GiB builder, change Core source on a new reviewed commit and re-pin ZIP, hash, image tag and service binding; no image can be attributed to the old commit after such a change. The previous AWS qualification failed before 319 tests under an 8 GiB heap plus 2 GiB margin in a 12 GiB container; this build is an unexecuted, distinct qualification, not a claim of success.

After a successful approved build, record CodeBuild project/build ID, exact S3 bucket/key/VersionId/hash, source commit, OCI image digest, and scan result. Independently compare the ECR digest with the build output. If `docker push` succeeds but a later digest check fails or times out, treat the result as **image present with uncertain verification**: inspect the immutable tag and ECR digest before any retry. The service stack accepts only `{"schemaVersion":1,"sourceHead":"13d12a7d7bdbe0be021cb218dd4cf7690cc4420b","imageDigest":"sha256:<64 lowercase hex>"}` and remains at desired count zero until activation is separately approved.

## Database gate

The image build does not qualify the live migration ledger. Use the fixed, metadata-only [ledger comparison plan](./first-chat-core-ledger-plan-20261016.md) before any migration. Current approved read-only AWS inventory found no proven read-only login able to SELECT `_prisma_migrations`; production SQL and a one-shot audit task remain held.
