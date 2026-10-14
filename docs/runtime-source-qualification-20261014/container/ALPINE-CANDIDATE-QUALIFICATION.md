# Core Node22 Alpine3.24 qualification candidate

**Qualification candidate only; compatibility, scan admission and deployment are
not approved or claimed.** The sole shipping owner runs the Linux/ARM64 checks.
This task starts no paid AWS build and changes no service or database.

## Frozen inputs and scope

- Application source: `91399fe1a205e37073cbeed2d7eb66a1fafd7fa2`.
- Official Node runtime: `docker.io/library/node:22.23.3-alpine3.24`.
- Exact ARM64 manifest: `sha256:85cdd100016a2e09927c0776bb7ebebcfefce5cd0af49893ada91cbc4d78ee22`.
- Registry index: `sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402`.
- Original `apps/api/Dockerfile`, application TS, entrypoints, package manifests,
  tracked Prisma schema/models, migrations and pnpm lockfile are unchanged.
  `ALPINE-CANDIDATE-INPUTS.json` records the lockfile SHA256.
- Optional Dockerfile: `apps/api/Dockerfile.alpine-qualification`. Use it explicitly;
  it does not replace the shipping Dockerfile. Build and runtime share the pinned
  musl base, and use a separate pnpm cache ID from glibc builds.
- pnpm9.12.0 and Prisma5.22.0 remain frozen. Existing lockfile already includes
  canvas/SWC musl ARM64 variants and esbuild ARM64; no lockfile changes are needed.
- Only the image-local Prisma client generator target changes from
  `linux-arm64-openssl-3.0.x` to `linux-musl-arm64-openssl-3.0.x`. `native` on the
  ARM64 Alpine build also resolves to musl. The transformer asserts exactly one
  expected target and preserves the rest of the schema byte-for-byte. Models,
  datasource, migrations and database behavior do not change.

## Package remediation hypothesis, to verify on the exact built image

The original candidate had 5 CRITICAL/12 HIGH findings. This fresh Alpine rootfs
does not force-remove any Debian Essential packages or erase package metadata.

| Original source | Blocking CVEs | Candidate requirement |
| --- | --- | --- |
| Perl | CVE-2026-8376, 42496, 57433, 12087, 13221 (Critical); 48962, 7017, 42497, 82560, 48959, 57432 (High) | No installed APK with perl origin in final runtime; retain actual package inventory, confirm scan |
| util-linux | CVE-2026-78410, 53615, 78408, 78409, 76642 (High) | No installed util-linux origin in final runtime; GNU wget closure needs no libuuid. Do not add util-linux2.42.3 merely to satisfy a utility name; nsenter fix needs separate evidence |
| zlib | CVE-2026-85091 (High) | Require zlib >=1.3.2-r1 from authenticated Alpine3.24 repositories; actual package inventory plus supported scan |

In the CVE rows, abbreviated numbers carry the `CVE-2026-` prefix. The probe
checks APK **origin**, not just package names. It reports the whole installed
package inventory, native files and active bindings. No finding is marked
cleared before a supported COMPLETE scan of the exact new digest. New Alpine,
Node or application dependency findings may still block admission.

Primary evidence:

- [Official Node Alpine3.24 Dockerfile](https://github.com/nodejs/docker-node/blob/main/22/alpine3.24/Dockerfile): Node22.23.3 and musl base, ARM64 built from Node source.
- [Alpine zlib recipe](https://github.com/alpinelinux/aports/blob/3.24-stable/main/zlib/APKBUILD): CVE-2026-85091 fixed at1.3.2-r1 with upstream patch.
- [Alpine ARM64 package index](https://dl-cdn.alpinelinux.org/alpine/v3.24/main/aarch64/APKINDEX.tar.gz): GNU wget1.25.0-r3 uses OpenSSL3/zlib, not libuuid; openssl3.5.9-r0 and zlib1.3.2-r1 available at preparation.
- [ECR basic supported distributions](https://docs.aws.amazon.com/AmazonECR/latest/userguide/image-scanning-troubleshooting.html): Alpine is listed; verify support for the exact3.24 image rather than assuming major-version eligibility.

Runtime retains UID/GID1001, dumb-init, POSIX entrypoints, OpenSSL3, CA trust,
GNU wget and `/dev/shm` scratch fallback. Build-only python/make/g++ are not
installed in runtime. No glibc compatibility shim is added to hide wrong bindings.
OS repositories are authenticated by APK; record the full resolved closure and
package revisions because security updates can advance after this preparation.

## Native ARM64 owner-run qualification

Use an isolated native Linux ARM64 Docker host, no credentials, no AWS mounts,
no database connections and no public ports. From this branch's repository root:

```sh
test "$(uname -m)" = aarch64
docker buildx build --platform linux/arm64 --progress plain --load \
  -f apps/api/Dockerfile.alpine-qualification \
  -t capiro-core:alpine324-qualification .
sh apps/api/scripts/qualification/run-alpine-runtime-probes.sh \
  capiro-core:alpine324-qualification > alpine-runtime-probe.json
```

These commands describe local qualification, not permission to start CodeBuild
or publish an image. The runtime-stage build invokes the static native probe
after production pruning; a missing engine, unexpected OS source package or
active addon load failure stops the build.

The owner-run runtime probe uses a read-only rootfs, no network except internal
loopback, dropped capabilities/no-new-privileges, bounded memory/PIDs and writable
scratch. It verifies:

- Node22.23.3/ARM64/musl and UID/GID1001;
- musl query engine loads, schema/migration engine executes `--version`, and
  PrismaCLI5.22.0 exposes `migrate status/deploy --help` without executing them;
- absence of retained glibc Prisma engines; active native `.node` files have ARM64
  ELF headers and load in isolated processes;
- actual pdf-parse canvas and tsx/esbuild dispatch. GNU optional platform bindings
  are explicitly inventoried inactive; active dispatch must never select them;
- original application module imports and writable scratch;
- unchanged entrypoint `serve` dispatch using a diagnostic PATH shim that
  intercepts `node dist/main.js`; it does not launch the API or touch a database;
- GNU wget reads a local HTTP health fixture and validates a local TLS fixture
  certificate; dumb-init forwards SIGTERM to an isolated Node fixture.

**Startup distinction:** fixture health and dispatch are packaging checks, not
full API readiness. Before compatibility is accepted, the owner must boot the
unchanged API against already-approved isolated dependency fixtures and confirm
the real `/health`, dependency initialization, and clean shutdown. Do not point
this qualification at Aurora or real provider services, do not run migrations,
and do not substitute fixture health for API readiness. If approved fixtures
are unavailable, retain `FULL_API_STARTUP_UNVERIFIED` as a blocking result.

Capture image digest, base digest, complete APK/npm/native inventory, probe JSON,
startup/readiness evidence and an actual supported scan of the exact digest.
Require status COMPLETE and zero HIGH/CRITICAL under the unchanged gate; a scan
failure/unsupported image is not zero findings. Inactive GNU optional binaries
must receive inventory review, not automatic removal or a false passing claim.
Any missing build dependency or platform artifact is a qualification failure;
do not automatically relax checks, change the lockfile or retry a paid build.

## Checks performed during preparation

Three local schema-transformation boundary tests passed. JavaScript syntax and
diff whitespace checks passed. Registry pin and Alpine package metadata were
read; no ARM64 container was built or run here. Independent review found no
remaining blocking code/document issue after correcting the read-only probe to
require EROFS in a UID1001-owned writable directory. The reviewer independently
reran all three schema-boundary tests successfully. Native runtime, full API
startup and supported zero-finding scan remain **unverified**.
