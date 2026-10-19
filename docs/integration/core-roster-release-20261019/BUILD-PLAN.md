# Frozen Core build and upload plan

**Historical approved plan; the single build has completed successfully and its scan did not pass the zero-findings gate.** [BUILD-RECEIPT.json](./BUILD-RECEIPT.json) records the actual upload, project update, build and image/scan results. The existing scan returned 7 HIGH, 2 MEDIUM and 2 LOW findings. The one-attempt authorization is consumed; do not rerun these instructions. No retry or deployment occurred.

Neo's approval, relayed by the parent at **2026-10-19 20:21 UTC**, allocated **$6 total: $4 Core + $2 frontend**, within the **$616 overall cap**, for one attempt each plus bounded rollout costs. The root shipping owner performed the exact Core archive upload, dedicated-project pin update and one reviewed build/image push after fresh gates. **Deployment remains held for scan review and the parent's concrete configuration/route review**; the build approval does not waive those gates or authorize SQL, grants, unrelated route changes or secret-value retrieval. Runtime source and original request templates/idempotency token remain unchanged. Below is the retained pre-execution plan; its old readbacks and unresolved template fields are historical, with actual results recorded separately in the receipt.

The runtime source remains **`50475125275853299798fc40f8cb119f0b865464`**, tree `c01138fed2e0e89e50f0f54f35c0ff4d4415c9b4`. A later documentation commit containing this plan must never replace that runtime pin. Machine-readable pins and request templates are in [build-plan.json](./build-plan.json). Every null in its unresolved outputs or request templates is an unresolved value, not an instruction to send null to AWS.

## Exact local inputs

| Input | Frozen value |
| --- | --- |
| Archive basename | `core-50475125275853299798fc40f8cb119f0b865464.zip` |
| Archive size | 43,408,386 bytes |
| Archive SHA-256, hex | `1e8d6874a99b7224513b0d2f9d92a5c5eb027f3160f38561b5049acc3bb4c17b` |
| Archive SHA-256, base64 | `Ho1odKmbciRROw0vnZKlxesCfzFg84VhtQSazDu0wXs=` |
| Inventory | 6,304 tracked files, 7,189 ZIP entries, 118,718,058 uncompressed Git blob bytes |
| Inventory SHA-256 | `186faf82290d921f787f3d7bb84b57858223e61a3058256ab4510517badc9580` |
| Dockerfile | `apps/api/Dockerfile`, Git/LF SHA-256 `86f5ed2b91cce3c9821a679c93363216af49d464213b7930cd8db51f915a57d2` |
| Buildspec | `infra/deploy/first-chat-core-preview.buildspec.yml` at frozen source, Git/LF SHA-256 `eab9286249f8d101f39d9abd09052248ee7bb5d74095419b2b680fa60b0e67f3` |
| Preparer | `infra/deploy/prepare-first-chat-core-source.mjs`, Git/LF SHA-256 `e31971d0638c6d8e6557fda5cca2b1aabd0cf2fa84936574ed530fb240f2786d` |

The source lane's local archive verification and independent file hash agreed. Before an approved upload, rerun the offline verifier against the same bytes and exact source; do not recreate a ZIP from the working directory:

```text
node infra/deploy/prepare-first-chat-core-source.mjs --ref 50475125275853299798fc40f8cb119f0b865464 --base b40971b1f8de888687a8fb92fbdf4ff653fe10d3 --verify-archive <outside-worktree>/core-50475125275853299798fc40f8cb119f0b865464.zip
```

Extract the buildspec from the frozen Git blob as raw bytes, independently check its LF hash, and decode those bytes as UTF-8 for the inline project recipe. Do not hash the Windows CRLF checkout or use a later documentation HEAD. The archive contains Docker inputs only; it does not supply the project's inline recipe. Its reviewed Stage 1 migration hash is `f9d2f4a13474a1af97afdd9b5b8587a6e27e90a36d07fdd1e6f30344bb595c51`; held helper migration `20281018100000_meri_memory_eligibility_helper` is absent. These are source checks, not permission to execute any migration.

## Exact target and historical before-to-proposed diff

Account `967807252336`, region `us-east-1`; project **`capiro-preview-first-chat-core-build`**; existing role **`arn:aws:iam::967807252336:role/capiro-codebuild-role`**. Do not use the generic `capiro-build-intel-api` project or any deployment pipeline.

| Field | Pre-execution readback | Reviewed proposal |
| --- | --- | --- |
| Source type | S3 | Same |
| Source location | `capiro-portfolio-preview-source-967807252336-us-east-1/inputs/core-5baef67a0ce7d67ae96255022ec7c5beb5364f8a.zip` | `capiro-portfolio-preview-source-967807252336-us-east-1/inputs/core-50475125275853299798fc40f8cb119f0b865464.zip` |
| Project sourceVersion | `1JvSP5supUOJ5xN4A3Qsb8B.Vr3z77UA` | Exact candidate VersionId returned by upload and verified by version-specific HeadObject; unresolved |
| Inline buildspec LF SHA-256 | `8b025a96d3a7b6cc054033445c9449f00b7b65b78859e9ac4afd0c30bab99011` (5,008 bytes) | `eab9286249f8d101f39d9abd09052248ee7bb5d74095419b2b680fa60b0e67f3` |
| Environment | Only bucket and old VersionId pins | Exact four `APPROVED_*` variables below |

Preserve LINUX_CONTAINER, `aws/codebuild/standard:8.0`, BUILD_GENERAL1_LARGE, privileged Docker, imagePullCredentialsType CODEBUILD, existing role, timeout 60 minutes, queue timeout 5 minutes, concurrency 1, auto retries 0, no VPC/webhook/fleet/Docker server/cache/secondary source/secondary artifact, NO_ARTIFACTS, and existing dedicated CloudWatch destination. Source has insecureSsl=false and no source auth; environment has no certificate/registry credentials. Do not add deployment, secret, network, retry, extra-compute or IAM settings. Re-read these fields and the parent's trigger receipt immediately before mutation; stop on unexplained differences or any running/queued build.

Required four PLAINTEXT values are nonsecret immutable identifiers:

| Name | Value |
| --- | --- |
| `APPROVED_SOURCE_SHA` | `50475125275853299798fc40f8cb119f0b865464` |
| `APPROVED_ARCHIVE_SHA256` | `1e8d6874a99b7224513b0d2f9d92a5c5eb027f3160f38561b5049acc3bb4c17b` |
| `APPROVED_SOURCE_BUCKET` | `capiro-portfolio-preview-source-967807252336-us-east-1` |
| `APPROVED_SOURCE_VERSION_ID` | Same exact candidate VersionId as project sourceVersion; unresolved |

## Read-only preparation evidence

On 2026-10-19 around 20:17–20:18 UTC, the exact candidate key returned **HeadObject 404**, and ECR tag `50475125275853299798fc40f8cb119f0b865464` returned **ImageNotFoundException**. This proves no current object/tag was observed then; it does not inventory historical S3 versions. Recheck before proceeding and retain the upload precondition.

Existing-role IAM simulation returned **allowed**, with no missing context, for `s3:GetObject` and `s3:GetObjectVersion` on `arn:aws:s3:::capiro-portfolio-preview-source-967807252336-us-east-1/inputs/core-50475125275853299798fc40f8cb119f0b865464.zip`, and `s3:GetBucketLocation` on the bucket ARN. No grant was added. Simulation is not a guarantee against resource policies, organization controls or future drift; unexpected access failure stops this attempt and does not authorize an IAM change.

The latest five dedicated-project builds were terminal; current project has no webhook. Parent's bounded audit found no us-east-1 CodePipeline, Scheduler schedule or Pipe, and no direct default-bus EventBridge target to this project. This does not exclude every indirect or externally installed trigger. The current project still selects old source and must not be started unchanged.

## Approved build execution sequence

1. **Upload once, after explicit approval.** Use `s3api put-object` on only the exact bucket/key below, body equal to the frozen local ZIP, ExpectedBucketOwner `967807252336`, `IfNoneMatch="*"`, ContentType `application/zip`, ServerSideEncryption `AES256`, ChecksumAlgorithm `SHA256`, ChecksumSHA256 equal to the base64 value above. The CLI streaming `--body` takes a local file path without a `file://` or `fileb://` prefix. Do not use `sync`, recursive upload, ACL changes, overwrite, or a different key. Capture VersionId and checksum response. Then HeadObject with that exact VersionId, expected bucket owner and checksum mode ENABLED must match VersionId, 43,408,386 bytes, SHA-256 and AES256. Keep both receipts. If upload outcome is uncertain, inspect current/version metadata before considering any retry; do not issue a second blind upload.
2. **Materialize the project update from the reviewed JSON template.** Fill only the upload-derived VersionId and exact frozen buildspec string. Update `name`, `source`, `sourceVersion`, and the preserved environment object with the four variables. Omitted service-role/timeout/retry/cache/log/network/etc. fields remain unchanged. Re-read all allowed fields, hash inline recipe, compare exact diff and confirm no concurrent build. A difference beyond source/location/version/recipe and the two added plus one changed environment pin blocks the run. This preparation has not created or submitted the update request.
3. **One StartBuild, after paid-build approval.** The complete request is exactly `projectName`, `sourceVersion`, `idempotencyToken` from the machine template. Token: **`core-roster-50475125-20261019-01`**. It must use the candidate S3 VersionId, never the Git SHA or a branch. No other override, debug session or automatic retry. Record the resulting build ID immediately. CodeBuild's token deduplicates for five minutes only; an uncertain response must first be resolved by current build metadata. Never repeat after five minutes assuming the token still protects against a second paid run.
4. **Observe the same build to a terminal result.** Do not relaunch on failure or timeout. The reviewed buildspec independently verifies account/region/x86_64, immutable ECR and empty source tag, exact S3 version/hash, source/migration gates, Docker linux/amd64 build, image architecture, Node 22.23.3/Prisma/Core offline imports, one push and local-versus-ECR digest equality. No DB or ECS command is part of the recipe. It uses `docker build --pull`, so the receipt must retain the resulting immutable image digest; a source archive alone does not fully pin mutable upstream base/package downloads.
5. **Seal the image receipt.** Independently read ECR tag/digest/size/push timestamp and completed scan summary. Existing qualification requires zero findings. Record build ID/status/start/end, project configuration/recipe hash, source SHA, ZIP hash/size, exact VersionId, image tag/digest, platform, offline smoke result and scan status/time/counts. Candidate image digest and build ID are unresolved until then. A failure or a nonzero scan stops shipping; no second allocation is implicit. Successful build/scan does not authorize ECS registration, activation, SQL, frontend pairing or route changes.

Exact upload target: `s3://capiro-portfolio-preview-source-967807252336-us-east-1/inputs/core-50475125275853299798fc40f8cb119f0b865464.zip`. Exact image tag: `967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/preview-core:50475125275853299798fc40f8cb119f0b865464`. Deployment uses its **future full digest**, never a mutable tag or a made-up value.

## Cost and stopping boundary

One build, max 60-minute configured timeout / 5-minute queue, concurrency 1, retries 0. Verified AWS Price List Linux/x86-64 OnDemand-EC2 general1.large rate is **$0.02/minute**, SKU `8MTWRQ8M475YQT7D`, rate code `8MTWRQ8M475YQT7D.JRTCKXETXF.6YS6EN2CT7`, effective 2026-08-01, read 2026-10-19: 60 billed minutes = **$1.20**. A conservative 65 billed minutes = $1.30. The allocated bounded rollout allowance covers at most 30 minutes of one extra current-size 0.5-vCPU/1-GiB task, about **$0.01234** compute, but deployment execution stays held for the parent's concrete configuration/route review. Combined baseline compute estimate is about $1.21234, leaving about $2.78766 of the allocated Core $4 for billable overhead/ancillaries. Storage, logs, transfer and shared-service usage remain additional; the allocation is not an AWS-enforced dollar ceiling or a statement of actual spend. No retry, new infrastructure, sustained replica or private qualification task is included.

Approval for this frozen source/archive/recipe, narrow project diff and one paid build was received and used once. Fresh gates passed before execution; actual outputs are in [BUILD-RECEIPT.json](./BUILD-RECEIPT.json). The nonzero scan stops shipping under the recorded gate. Remediation, another build or deployment requires a separately reviewed decision; none is implied by this retained plan.

References: [AWS StartBuild](https://docs.aws.amazon.com/cli/latest/reference/codebuild/start-build.html), [CodeBuild pricing](https://aws.amazon.com/codebuild/pricing/), [S3 PutObject](https://docs.aws.amazon.com/cli/latest/reference/s3api/put-object.html).
