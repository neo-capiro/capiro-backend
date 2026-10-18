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
- original application module imports, syntax-only main check with source maps
  disabled for that child process only, and writable scratch;
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

## Version-probe repair after the PR20 attempt

The terminal failed build `a437cab5-0c53-443a-a20a-ed475973b169`
reached the final static probe. Its log shows `dumb-init v1.2.5` immediately
before the version assertion rejected empty stdout. The original command
captured stdout and inherited stderr, establishing that this version banner
was written to stderr. Frozen local evidence: `core-pr20-staging/BUILD-LOG.txt`,
SHA256 `70fffd9213acecc2a5c108401655f47b00300d5ef699d418c015c4517d4757d9`.

Only this version command now captures both streams, with a 30-second deadline,
a 1 MiB buffer limit, and a required successful exit. Its version assertion is
unchanged. Other subprocess calls and all native, readiness, scan and security
gates remain unchanged. The probe exports this check for regression tests;
requiring it does not execute the image qualification.

Run `node --test apps/api/scripts/qualification/alpine-runtime-probe.test.cjs`
for real child-process checks of stderr/stdout banners, a wrong version,
nonzero exit, empty output, timeout, excessive output and a missing executable.
These local tests do not establish ARM64 image qualification. The failed attempt
produced no candidate image; this repair authorizes no additional paid attempt
and leaves `FULL_API_STARTUP_UNVERIFIED` blocking deployment.

## Native owner classification and retained Sharp dispatcher

The PR21 attempt `6b7c6e61-80e8-4e71-8ec6-8fee3d37846b` failed when the
raw-addon traversal tried the retained glibc `@img/sharp-linux-arm64@0.35.5`
binary on musl. That package has no `-gnu` suffix. Frozen build-log SHA256:
`dde3078e92948297ca99d4c80eb7658391946cfcdce2a5f960c249fc18da55de`.
The failure does not establish an actual Sharp dispatcher failure.

Both path-substring heuristics are replaced with the same package-owner and
ELF classifier. Each canonical regular file is contained in the deployed store
and its real package owner, and carries identity, platform metadata, size, hash,
ELF machine and actual DT_NEEDED evidence. Incompatible artifacts receive an
inactive row only when a real deployed parent's `optionalDependencies` declares
the exact installed name/version and its Node lookup resolves that same native
package root. The receipt retains this relationship and resolved manifest.
Any required dependency resolving to the same incompatible package holds, even
if another parent marks it optional. Missing optional proof also holds.
Missing libc metadata is resolved
only from positive ELF dependency evidence; unknown ABI and contradictory
metadata (including contradicted negative constraints) hold qualification.
Known foreign non-ELF formats also hold; this classifier accepts ELF64 only.
Active bindings must positively pass ARM64/musl
classification. A load failure is never converted into an inactive result.

The runtime image does not copy `apps/workspace`, and the API does not declare
Sharp directly. The new check therefore exercises each actual deployed Sharp
store owner (at most eight), explicitly reported as `RETAINED_STORE_SHARP_OWNER`.
It resolves that owner's entry and exact pinned musl optional package, performs
a real 1-pixel to 2-by-2 resize with a five-second Sharp processing limit, and
checks the resulting pixels and actual loaded binding's real owner/version,
hash, ARM64 ELF and musl classification. The selected binding must belong to
that owner's resolved optional package. The pinned upstream
[Sharp package](https://github.com/lovell/sharp/blob/v0.35.5/package.json) and
[musl ARM64 package](https://github.com/lovell/sharp/blob/v0.35.5/npm/linuxmusl-arm64/package.json)
define this optional relationship and the platform package export.

Local ELF fixtures test classifier decisions, containment and rejection paths;
they are never loaded as native code. They do not substitute for the mandatory
real Sharp operation or ARM64 image qualification. Existing canvas, esbuild,
Prisma, read-only, HTTP/TLS, signal and full-readiness gates remain in place.
No paid attempt, dependency change, Dockerfile change or deployment is authorized
by this source repair.

## Consolidated diagnostic candidate after PR22 (target operations UNRUN)

Baseline source is `2875afa0cf65053b5faa2b29e742c81cba446931`. PR22 stopped on
`@libsql/linux-arm64-musl@0.5.29`: its real package omits `libc`, and its ELF
DT_NEEDED contains generic `libc.so`. The static classifier therefore returned
UNKNOWN before any native require. Absence of metadata is not proof of an ABI
failure. The previous failure did not establish a LibSQL dispatcher failure or
complete the remaining native inventory and dispatchers.

The consolidated candidate preserves static UNKNOWN and examines an otherwise
eligible addon only in a bounded, credential-free child. A successful require
alone is insufficient. A runtime upgrade needs the exact addon path/hash in
both intercepted `process.dlopen` and the child's own mapped objects, the fixed
system musl loader's real path/hash/ARM64 ELF and positive version banner, and
the actual loader's resolved libc dependency mapping to that same mapped musl
object. ELF RPATH/RUNPATH and SONAME are retained in receipts; LD overrides are
absent. Glibc, escaped/unobserved mappings, unexplained loader errors or missing
evidence hold. The musl `--list` query may lack Node-exported symbols when run
outside Node; only narrowly identified Node API relocation errors on the exact
addon are explained, and the subsequent real Node load must still succeed.
This observation mechanism has **not** been executed on the target image.

The official `libsql@0.5.29` npm tarball was read without installation or
execution and verified against frozen-lock SHA512
`8lMP8iMgiBzzoNbAPQ59qdVcj6UaE/Vnm+fiwX4doX4Narook0a4GPKWBEv+CR8a1OwbfkgL18uBfBjWdF0Fzg==`.
Its dispatcher `index.js` SHA256 is
`cc6f0fb815d302185ba69d4f749b423dfe304add1c58d6ff687842f8c1e39152`;
the independently integrity-verified ARM64 musl addon is 8,731,816 bytes with
SHA256 `e4a292a56e0b4baf88f22ab5ade36e4ea0991a11577b1c31a6fe19f5e4218fb9`.
Both pins are checked before the fixture. The vendor dispatcher uses
`@neon-rs/load` plus `detect-libc` to select its exact optional platform package.
Its verified constructor/statement API supports `new Database(':memory:')`,
`prepare('SELECT 7 AS qualification_value').get()`, and `close()`. That is the
entire database operation: no file URI, schema/table writes, remote URL, sync,
provider credential, migration, or live database. The actual deployed owner is
resolved and its selected native binding must satisfy the runtime proof.
There is no proven API dependency path to LibSQL or Sharp; these receipts are
explicitly retained-store coverage, not application reachability claims.

`--inventory-only` performs bounded filesystem observation before any addon or
dispatcher load. It emits every retained `.node`, `.so`, schema-engine and
ELF executable with canonical path, mode, bytes, SHA256, real owner/platform
metadata and actual ELF/foreign-format evidence. It returns
`DIAGNOSTIC_INVENTORY`/`INVENTORY_ONLY`, never a qualification PASS. Lockfile
candidate families are not called installed files. Unknown/foreign/stripped or
malformed observations remain explicit; no format or ABI is silently inferred.
It also emits each deployed package manifest's real path, hash, byte length,
name/version and declared os/cpu/libc before loads. Package-scope manifests
without package identity are labelled as scope metadata; malformed or unreadable
manifests retain error rows. Missing libc remains null. APK inventory stays in
the runtime vendor report.

Normal execution emits numbered `CORE_NATIVE_RECEIPT` records before loads,
then independently checks Sharp, LibSQL, retained Canvas, esbuild and SWC owners,
Prisma, every eligible raw addon, safe API imports, active bindings, dispatch,
read-only rootfs, loopback HTTP/TLS and signal forwarding. Sharp executes first
in its own child so another addon failure cannot suppress its real operation.
Child limits are 30 seconds/256 KiB per output stream with a forced kill;
failure, timeout and overflow retain bounded stdout/stderr/status/error receipts.
Every required HOLD remains blocking in the aggregate nonzero result; diagnostic
receipts never satisfy a successful `OFFLINE_RUNTIME` inventory join.

Additional retained dispatcher coverage is conditional on actual filesystem
owners: Canvas 0.1.80/1.0.9, esbuild 0.21.5/0.28.2, and SWC 1.16.2. Each runs a
real bounded operation. Esbuild also resolves and executes its exact owner's
ARM64 platform binary/version; the transform's separate service-child selection
is explicitly not independently observed. An actually retained ONNX runtime has
no approved offline inference model fixture; the candidate reports that missing
dispatcher case as UNRUN/HOLD rather than downloading a model or claiming an
inference pass. This limitation needs review against actual application scope.
Canvas and SWC operations resolve the exact native optional owner before loading
and use the same real-operation dlopen/mapped byte proof, including when package
libc metadata is absent. Unexpected selected native owners hold. The API's
pdf-parse-selected Canvas fixture also records this runtime evidence, which its
final active-binding check revalidates; an absent libc declaration alone is not
a false compatibility failure.

Proposed single future diagnostic plan, requiring independent review and fresh
attempt authorization: create a qualification-only runtime-base stage after all
runtime files/identity/entrypoint are installed; retain both original final RUN
gates unchanged in the default final stage. Build the diagnostic base locally,
capture full inventory, and run the complete aggregate probe under the original
read-only/network-none/cap-drop/no-new-privileges/PID/memory/noexec restrictions.
Never push or admit the diagnostic stage. Only complete success could proceed
to the unchanged final gates, immutable candidate push and supported full scan.
The parent owns the candidate-recipe proposal, output persistence and packet;
this probe change does not edit either Dockerfile or authorize any paid run.

Local tests validate classification, runtime-proof rejection/acceptance rules,
bounded real child outcomes and failure aggregation. They do not execute Linux
native addons, LibSQL, Sharp or the target loader on this Windows host. The
Docker Linux engine is unavailable; no daemon, WSL or replacement environment
is started. Actual target operations, full image qualification and full API
readiness remain UNRUN/unverified. `FULL_API_STARTUP_UNVERIFIED` still blocks
deployment regardless of a future native or scan result.
