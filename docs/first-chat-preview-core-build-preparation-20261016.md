# Held first-chat Core image build

This is the source and execution record for the bounded Core image qualification. Neo approved the exact source upload, one object-scoped IAM read policy, a dedicated CodeBuild project, and one build within a $4 bound. The source object, project, and private immutable ECR repository were created. The one approved build started and **failed in BUILD before producing an image**. No ECS task or database command has run. The local Windows Docker daemon remains inaccessible.

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
| Buildspec | [`infra/deploy/first-chat-core-preview.buildspec.yml`](../infra/deploy/first-chat-core-preview.buildspec.yml), supplied separately from the PR #43 ZIP |
| First-run live buildspec SHA-256 | `e8b79a418eae4369cc4577d82889ca0f191db177177ef8cd0c5380c2c21a45b3` over 3,653 bytes; still installed in the CodeBuild project |
| Source-only diagnostic candidate SHA-256 | `af1156290767e54aa95e30c978ec6c4b850f900a9fcda579e7686d8702bf5e7a` over 4,453 bytes; not installed or run |

The ZIP was made with `git archive` from that exact commit using only the repository-root Dockerfile inputs: root build files, `apps/api` Dockerfile/package/src/prisma/scripts/data/config, and `packages/{shared,meriv2-core,defense-contracts,defense-domain}` package/src/config. Archive inspection found the receipt migration and no Objective migration, `node_modules`, or `.env` files. The buildspec downloads the same exact S3 object version again and checks the static ZIP hash before it builds; neither a branch name nor the current PR #44 checkout selects runtime bytes. The 475-migration checksum manifest is in [`infra/deploy`](../infra/deploy/first-chat-core-pr43-migration-checksums.json) (LF-normalized SHA-256 `cebd7886545e3fbee1c3024a2d2c2e6f3fab8127c1d77c01341bd16f0b6ad5ac`).

## Applied source, project, and registry state

The existing bucket is private, versioned, SSE-S3 encrypted, and blocks all public access. The ZIP was uploaded once at the fixed key with `If-None-Match: *`; `HeadObject` of the exact VersionId confirmed 42,406,170 bytes and the SHA-256 above. Existing role `capiro-codebuild-role` received only inline policy `CapiroFirstChatCorePreviewSourceRead`: `s3:GetObject`/`s3:GetObjectVersion` on that exact key and `s3:GetBucketLocation` on that bucket. IAM policy readback and simulation confirmed those reads. The dedicated `capiro-preview-first-chat-core-build` project was created with:

- `ProjectSource.type=S3` with the exact bucket/key above. The `StartBuild.sourceVersion` must equal the recorded VersionId; no source, buildspec or environment override is permitted. The inline buildspec is the reviewed YAML in this PR, and fixed environment variables carry the bucket and VersionId.
- `LINUX_CONTAINER`, `aws/codebuild/standard:8.0`, `BUILD_GENERAL1_LARGE` (16 GiB), x86_64, privileged Docker, a 60-minute build timeout, five-minute queue timeout, one concurrent build, and zero automatic retries. The project has no VPC attachment, webhook, cache, secondary source or artifacts. Its log group is `/aws/codebuild/capiro-preview-first-chat-core-build`.
- Existing Capiro shipping role `arn:aws:iam::967807252336:role/capiro-codebuild-role`. IAM simulation allowed the new scoped S3 reads, ECR push, and Logs actions; it denied ECS service updates and Secrets Manager value reads. Its existing broad ECR/log policies remain a limitation. No new deployment or secret permission was added. Project readback matched the fixed source, role, buildspec, environment, and execution settings.
- The private `capiro/preview-core` registry was created with immutable tags, scan-on-push, and AES256 encryption. Readback matched all three settings. Existing build-role IAM simulation allowed repository/image description, ECR authorization, layer upload and `PutImage`; no new ECR IAM grant was made. Never use the older Capiro CodeBuild projects: their sources, mutable tags, and in some cases automatic ECS redeploy commands target other services.

The `ProjectSource.location` form and inline buildspec placement are specified in the [CodeBuild ProjectSource API](https://docs.aws.amazon.com/codebuild/latest/APIReference/API_ProjectSource.html). AWS documents the S3 URL and VersionId forms of `CODEBUILD_SOURCE_REPO_URL` and `CODEBUILD_SOURCE_VERSION` in its [build environment variables](https://docs.aws.amazon.com/codebuild/latest/userguide/build-env-ref-env-vars.html).

Immediately before the approved `StartBuild`, live project readback confirmed the first-run inline buildspec matched its reviewed 3,653-byte source after line-ending normalization, plus the exact S3 source URL and VersionId, fixed environment values, service role, compute class, Docker privilege and zero auto retries. The request used only the pinned VersionId and a stable idempotency token; it supplied no source, buildspec or environment overrides.

Build `capiro-preview-first-chat-core-build:32593e01-c56d-46f0-a42b-e0ee5d98953c` started at 2026-10-16 20:36:11 UTC and reached terminal **FAILED** at 20:36:35 UTC. Provisioning, source download, install and pre-build succeeded; the single compound BUILD command exited 1 before it printed a source checksum or Docker output. CloudTrail records a successful `GetCallerIdentity` call by this build role at 20:36:34 UTC in account `967807252336`; the exact silent guard that returned 1 is not proven from the available log. The PR #43 ECR tag is absent, so no image digest can be bound. The one approved build attempt is consumed; there is no automatic retry or second job under this approval.

The linked source-only diagnostic candidate adds fixed, non-secret failure stage labels around each guard, including the three source environment-variable checks immediately after STS. YAML parsing and `bash -n` passed locally. It prints neither environment values nor credentials. The live project still has the original buildspec; updating it and starting another paid job require a separate reviewed decision.

The buildspec fails closed on account/region/architecture, S3 source URL and VersionId, ZIP hash, receipt migration presence, Objective migration absence, ECR tag availability, runtime Node/Prisma import, and pushed digest. It does **not** call ECS or query the database. Diagnose the early silent guard and review a precise buildspec change before proposing another paid attempt. If the Dockerfile's fixed 4 GiB Nest heap later fails inside a 16 GiB builder, change Core source on a new reviewed commit and re-pin ZIP, hash, image tag and service binding; no image can be attributed to the old commit after such a change. The previous AWS qualification failed before 319 tests under an 8 GiB heap plus 2 GiB margin in a 12 GiB container; this build failed earlier still.

After a successful approved build, record CodeBuild project/build ID, exact S3 bucket/key/VersionId/hash, source commit, OCI image digest, and scan result. Independently compare the ECR digest with the build output. If `docker push` succeeds but a later digest check fails or times out, treat the result as **image present with uncertain verification**: inspect the immutable tag and ECR digest before any retry. The service stack accepts only `{"schemaVersion":1,"sourceHead":"13d12a7d7bdbe0be021cb218dd4cf7690cc4420b","imageDigest":"sha256:<64 lowercase hex>"}` and remains at desired count zero until activation is separately approved.

## Database gate

The image build does not qualify the live migration ledger. Use the fixed, metadata-only [ledger comparison plan](./first-chat-core-ledger-plan-20261016.md) before any migration. Repository SQL grants `capiro_app` SELECT on the ledger, but that live grant has not been attested. The fixed-purpose one-shot audit and production SQL remain held.
