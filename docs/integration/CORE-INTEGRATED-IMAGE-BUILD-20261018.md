# Integrated Core image build inputs — source packet

Status: **unfilled and unexecuted**. The historical PR43 source ZIP, project
environment and image are not inputs for an integrated Core image. This packet
does not authorize an S3 upload, CodeBuild run, IAM change, image push or ECS
update.

## Freeze and review the exact inputs

| Input | Required binding |
| --- | --- |
| `APPROVED_SOURCE_SHA` | The final frozen Core source commit, exactly 40 lowercase hex characters. `FIRST_CHAT_CORE_IMAGE_PINS` stays `null` until its image is qualified. |
| `APPROVED_SOURCE_BUCKET` | `capiro-portfolio-preview-source-967807252336-us-east-1`. |
| S3 key | Derived by the buildspec as `inputs/core-<APPROVED_SOURCE_SHA>.zip`; the reviewed CodeBuild ProjectSource location must name this same key. |
| `APPROVED_SOURCE_VERSION_ID` | The VersionId returned and read back for that exact uploaded ZIP. `StartBuild.sourceVersion` must equal it; no source, buildspec or environment overrides. |
| `APPROVED_ARCHIVE_SHA256` | SHA-256 of the ZIP made from the frozen commit, after reviewing that it contains every repository-root Dockerfile input and no credentials or local build artifacts. |
| Buildspec | Reviewed `infra/deploy/first-chat-core-preview.buildspec.yml` bytes and the same inline project buildspec on readback. The former PR43-specific pin and Objective-migration-absence check are removed. |
| Registry | Existing immutable-tag `967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/preview-core`, tag equal to `APPROVED_SOURCE_SHA`. |

The buildspec fails before Docker unless the project pins have valid shapes,
the account and region are `967807252336/us-east-1`, the worker is aarch64,
`CODEBUILD_SOURCE_VERSION` equals the reviewed VersionId, and the repository
has immutable tags with no image already at the source tag. It downloads the
explicit S3 object *by VersionId*, compares the returned VersionId and the
full ZIP SHA-256, then checks the bootstrap receipt migration, integrated
read-delegation migration and execution receiver. It builds linux/arm64 using
`apps/api/Dockerfile.alpine-qualification` and its mandatory final `runtime`
target, executes the existing native runtime probe without container network,
pushes once, and
compares the local and ECR image digests. The buildspec performs no ECS or SQL
operation.

The tracked-only source preparer includes this ARM recipe, every local COPY
input and the frozen runtime closure document. The runtime stage copies the
shared platform selector and uses the existing direct-owner repair with exact
ARM esbuild/Prisma payload pins before the unchanged static closure/native gate.
The repair preserves x64 pins for the separately retained historical recipe;
it does not admit unknown artifacts or weaken the runtime probe. ARM esbuild
0.28.2 is bound to the lockfile SHA512 archive; Prisma5.22 engine commit
`605197351a3c8bdd595af2d2a9bc3025bca48ea2` is bound to its published raw and
gzip checksums. Source verification does not prove native execution.

Use the existing native ARM CodeBuild environment after root reads back its
configuration and permissions. No project, role or sourceVersion is supplied
by this document. `first-chat-core.ts` emits ARM64, retaining 1vCPU/2GiB,
the existing roles, TLS, `/health` and listener rules. The image source/digest
pins remain null until a qualified build exists. No migration is changed or
activated by this packaging alignment.

## Qualification and pin handoff

Before a paid build, the single shipping operator must read back the exact
CodeBuild source location, VersionId, inline buildspec, pinned environment,
role, architecture, timeout and retry settings, and obtain the separately
authorized build window. The checked-in buildspec cannot update the existing
project configuration by itself. Do not use a prior PR43/PR48 image digest as
the successor pin.

After the build, independently read back the immutable ECR tag and digest,
wait for the image scan to complete, and record its findings. The deployment
packet requires zero findings before use. Only then may a new source commit
set `FIRST_CHAT_CORE_IMAGE_PINS` to the exact frozen source SHA and qualified
digest. Render the Core preview binding with schema version 5 and the matching
`sourceHead`/`imageDigest`; `RELEASE_SHA` follows that source pin. Coordinate
the corresponding Meri and frontend source/image pins. A build, scan or source
pin does not establish a running task; live activation needs its own task,
listener and service readback.
