# Held first-chat Core image build

This is the source and execution record for the bounded Core image qualification. Neo approved the exact source upload, one object-scoped IAM read policy, a dedicated CodeBuild project, and one build within a $4 bound. The source object and project have been created. The ECR repository does not yet exist, so no build has started or image been pushed. No ECS task or database command has run. The local Windows Docker daemon remains inaccessible.

## Immutable input

| Item | Exact value |
| --- | --- |
| Core runtime source | PR #43 commit `13d12a7d7bdbe0be021cb218dd4cf7690cc4420b` |
| Local Git archive ZIP | `../../first-chat-core-pr43-source-13d12a7.zip`, 42,406,170 bytes |
| ZIP SHA-256 | `8643d671d641fb6379c442931e2ed953c2654b418580e7274116d2e4c4d68b16` |
| S3 bucket/key | `capiro-portfolio-preview-source-967807252336-us-east-1/inputs/core-13d12a7d7bdbe0be021cb218dd4cf7690cc4420b.zip` |
| S3 VersionId | `H7novBkHZg.qAof.Kf5GRr_joZfnzOHx` |
| Target ECR repository | `967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/preview-core` |
| Image tag | Exact 40-character source commit, in an **immutable-tag** repository |
| Buildspec | [`infra/deploy/first-chat-core-preview.buildspec.yml`](../infra/deploy/first-chat-core-preview.buildspec.yml), supplied as the dedicated project's inline buildspec; the PR #43 ZIP intentionally does not contain PR #44 deployment source |
| Buildspec SHA-256 | `e8b79a418eae4369cc4577d82889ca0f191db177177ef8cd0c5380c2c21a45b3` over the reviewed 3,653-byte file |

The ZIP was made with `git archive` from that exact commit using only the repository-root Dockerfile inputs: root build files, `apps/api` Dockerfile/package/src/prisma/scripts/data/config, and `packages/{shared,meriv2-core,defense-contracts,defense-domain}` package/src/config. Archive inspection found the receipt migration and no Objective migration, `node_modules`, or `.env` files. The buildspec downloads the same exact S3 object version again and checks the static ZIP hash before it builds; neither a branch name nor the current PR #44 checkout selects runtime bytes. The 475-migration checksum manifest is in [`infra/deploy`](../infra/deploy/first-chat-core-pr43-migration-checksums.json) (LF-normalized SHA-256 `cebd7886545e3fbee1c3024a2d2c2e6f3fab8127c1d77c01341bd16f0b6ad5ac`).

## Applied source and project state; build held

The existing bucket is private, versioned, SSE-S3 encrypted, and blocks all public access. The ZIP was uploaded once at the fixed key with `If-None-Match: *`; `HeadObject` of the exact VersionId confirmed 42,406,170 bytes and the SHA-256 above. Existing role `capiro-codebuild-role` received only inline policy `CapiroFirstChatCorePreviewSourceRead`: `s3:GetObject`/`s3:GetObjectVersion` on that exact key and `s3:GetBucketLocation` on that bucket. IAM policy readback and simulation confirmed those reads. The dedicated `capiro-preview-first-chat-core-build` project was created with:

- `ProjectSource.type=S3` with the exact bucket/key above. The `StartBuild.sourceVersion` must equal the recorded VersionId; no source, buildspec or environment override is permitted. The inline buildspec is the reviewed YAML in this PR, and fixed environment variables carry the bucket and VersionId.
- `LINUX_CONTAINER`, `aws/codebuild/standard:8.0`, `BUILD_GENERAL1_LARGE` (16 GiB), x86_64, privileged Docker, a 60-minute build timeout, five-minute queue timeout, one concurrent build, and zero automatic retries. The project has no VPC attachment, webhook, cache, secondary source or artifacts. Its log group is `/aws/codebuild/capiro-preview-first-chat-core-build`.
- Existing Capiro shipping role `arn:aws:iam::967807252336:role/capiro-codebuild-role`. IAM simulation allowed the new scoped S3 reads, ECR push, and Logs actions; it denied ECS service updates and Secrets Manager value reads. Its existing broad ECR/log policies remain a limitation. No new deployment or secret permission was added. Project readback matched the fixed source, role, buildspec, environment, and execution settings.
- The `capiro/preview-core` registry still needs its own approval. The buildspec refuses to run unless that repository exists with immutable tags. No build has been started, and no image is present. Never use the older Capiro CodeBuild projects: their sources, mutable tags, and in some cases automatic ECS redeploy commands target other services.

The `ProjectSource.location` form and inline buildspec placement are specified in the [CodeBuild ProjectSource API](https://docs.aws.amazon.com/codebuild/latest/APIReference/API_ProjectSource.html). AWS documents the S3 URL and VersionId forms of `CODEBUILD_SOURCE_REPO_URL` and `CODEBUILD_SOURCE_VERSION` in its [build environment variables](https://docs.aws.amazon.com/codebuild/latest/userguide/build-env-ref-env-vars.html).

Immediately before `StartBuild`, read back the project definition and verify the inline buildspec is byte-for-byte the hash-pinned file above, plus its exact S3 source URL, fixed environment values, service role, architecture, Docker privilege and absent webhook/secondary source. Verify the build request uses the approved source VersionId and has no source, buildspec or environment overrides. If any comparison differs, stop before starting a paid build.

The buildspec fails closed on account/region/architecture, S3 source URL and VersionId, ZIP hash, receipt migration presence, Objective migration absence, ECR tag availability, runtime Node/Prisma import, and pushed digest. It does **not** call ECS or query the database. If the Dockerfile's fixed 4 GiB Nest heap fails inside a 16 GiB builder, change Core source on a new reviewed commit and re-pin ZIP, hash, image tag and service binding; no image can be attributed to the old commit after such a change. The previous AWS qualification failed before 319 tests under an 8 GiB heap plus 2 GiB margin in a 12 GiB container; this job remains unexecuted.

After a successful approved build, record CodeBuild project/build ID, exact S3 bucket/key/VersionId/hash, source commit, OCI image digest, and scan result. Independently compare the ECR digest with the build output. If `docker push` succeeds but a later digest check fails or times out, treat the result as **image present with uncertain verification**: inspect the immutable tag and ECR digest before any retry. The service stack accepts only `{"schemaVersion":1,"sourceHead":"13d12a7d7bdbe0be021cb218dd4cf7690cc4420b","imageDigest":"sha256:<64 lowercase hex>"}` and remains at desired count zero until activation is separately approved.

## Database gate

The image build does not qualify the live migration ledger. Use the fixed, metadata-only [ledger comparison plan](./first-chat-core-ledger-plan-20261016.md) before any migration. Repository SQL grants `capiro_app` SELECT on the ledger, but that live grant has not been attested. The fixed-purpose one-shot audit and production SQL remain held.
