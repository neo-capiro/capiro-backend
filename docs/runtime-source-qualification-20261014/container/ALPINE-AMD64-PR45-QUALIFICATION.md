# PR45 first-chat Alpine AMD64 qualification candidate

This is a source candidate, based on PR45 commit `5baef67a0ce7d67ae96255022ec7c5beb5364f8a`. The production `apps/api/Dockerfile`, current PR45 image, and service are unchanged. No image build, scan, database operation, or deployment is authorized by this document.

## Source and architecture

- Build explicitly with `apps/api/Dockerfile.alpine-amd64-qualification` for `linux/amd64`. The Node build and runtime base is the official `node:22.23.3-alpine3.24` AMD64 child manifest `sha256:2c752226d477b4a886378baa95b9af252be59301b725fdb0b7e15208131505a8` from index `sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402`.
- The [Node Docker maintainers classify AMD64 musl builds as Experimental](https://github.com/nodejs/docker-node/blob/main/README.md#musl-builds-for-alpine). They test the binaries before Docker image publication, but this tier does not make application/native-module compatibility automatic; the image and full-startup gates below remain mandatory.
- Keep the frozen pnpm lock, existing source packages, models, migrations, and production Dockerfile. The image-local Prisma generator switches the one explicit ARM64 glibc target to `linux-musl-openssl-3.0.x`; native AMD64 Alpine generation uses musl as well. No repository schema change is published.
- Shared build/production-dependency base and final runtime both require Alpine 3.24 `zlib >= 1.3.2-r1`, where the [Alpine recipe includes the CVE-2026-85091 patch](https://github.com/alpinelinux/aports/blob/3.24-stable/main/zlib/APKBUILD). The existing probe checks the installed runtime APK version and rejects Perl/util-linux origins. A successful package check is not an image vulnerability scan.
- The retained production-closure contract remains bound to the exact Git lock/manifests. The AMD64 proof adds four exact locked Canvas package manifest hashes to reconcile `libc` omitted from the lock metadata, and exact native member byte proofs for LibSQL, Canvas, SWC, Sharp, and Sharp libvips. The proof source is the official npm tarballs verified against each exact lockfile SHA-512 SRI. The probe still requires installed owner, ELF architecture/libc, active loader resolution, selected binding, and real native operations.

## Qualification sequence after a separately approved build reservation

These are instructions for a future native AMD64 qualification host. They were not run on this jump box: Docker daemon access is denied and no paid build is reserved.

```sh
docker buildx build --platform linux/amd64 --progress plain --load \
  -f apps/api/Dockerfile.alpine-amd64-qualification \
  -t capiro-core:alpine324-amd64-qualification .
sh apps/api/scripts/qualification/run-alpine-amd64-runtime-probes.sh \
  capiro-core:alpine324-amd64-qualification > alpine-amd64-runtime-probe.json
sh apps/api/scripts/qualification/run-alpine-amd64-entrypoint-db-gate.sh \
  capiro-core:alpine324-amd64-qualification > alpine-amd64-db-gate.txt
```

The runtime probe uses a read-only root filesystem, no external network, no credentials, no ports, dropped capabilities, a native AMD64 daemon, and bounded memory/PIDs. Its Dockerfile build-layer run is a static version of the same native/closure checks. Any missing artifact, optional package policy failure, unexpected native loader result, or installed vulnerable APK leaves the candidate on HOLD.

The entrypoint database gate invokes the **real** POSIX entrypoint and compiled Nest application with synthetic Clerk and DB values under `--network none`. It requires the application to reach Prisma's unreachable local database error, while forbidding a listener. This proves only `COMPILED_ENTRYPOINT_REACHES_ISOLATED_DB_GATE`. It does not prove API health or tenant/identity behavior.

Full startup remains **HOLD** until the unchanged image boots against an approved disposable PostgreSQL fixture with TLS on an isolated Docker network. Require ordinary entrypoint dispatch, migrations against only that fixture, successful Nest listener and real `GET /health`, no unexpected outbound network, and clean SIGTERM/shutdown. Record fixture and image identities. Do not point these checks at Aurora, real providers, or production credentials. Existing source does not contain an equivalent full API fixture.

## Exact image digest scan gate

Only after an approved push, use its immutable ECR manifest digest and approved repository. Capture complete responses by digest, never by tag:

```sh
aws ecr describe-images --region us-east-1 \
  --repository-name "$approved_repository" --image-ids "imageDigest=$approved_digest" \
  --output json > describe-images.json
aws ecr describe-image-scan-findings --region us-east-1 \
  --repository-name "$approved_repository" --image-id "imageDigest=$approved_digest" \
  --output json > describe-image-scan-findings.json
node apps/api/scripts/qualification/verify-alpine-amd64-scan.cjs \
  "$approved_digest" "$approved_repository" \
  describe-images.json describe-image-scan-findings.json
```

The offline verifier requires one matching repository/digest detail, a `COMPLETE` scan of the same digest completed after its push, complete finding rows and severity counts, no continuation token, and zero CRITICAL/HIGH findings. Let AWS CLI collect every page; a truncated or single-page response is HOLD. A pending, unsupported, absent, stale, mismatched, or positive finding result is also HOLD. Retain the full JSON and source/archive/image digest mapping. A scan pass alone does not waive full startup or authority checks.
