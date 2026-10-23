# Four-service Alpine image qualification

Status: repair candidate after the orchestrator's first image gate at
`5bf9e058912569ba8206a2c71450001dc26a142c`. Intel, Strategy and Workspace built
and passed their offline probes but scans reported respectively 1/20, 1/21 and
1/19 CRITICAL/HIGH. Engagement failed on an incorrect probe module path. The
changes below need fresh exact-head image gates; no security acceptance is claimed.

Base: `db96ad310fa1c3cc43278ff9c2d59e750581bac3` (`backend-import`). Briefs:
[original](https://github.com/neo-capiro/meri-greenfield/issues/202#issuecomment-6355187204)
and [four-service addendum](https://github.com/neo-capiro/meri-greenfield/issues/202#issuecomment-6355270797).
The 2026-10-23 dispatch limits work to PRs, local gates and design; no CodeBuild
starts, ECR pushes, AWS writes, migrations, deploys or live acceptance are authorized.

## Implementation outline and requirement audit

Each service owns its new `Dockerfile.alpine`; existing Debian recipes, entrypoint
scripts, application code, service manifests and schema files remain unchanged.
Reuse Core's exact Node 22.23.3 / Alpine 3.24 amd64 pin and its image-local Prisma
generator helper. Node 22 also satisfies the frozen `sanitize-html` dependency's
Node >=22.12 requirement already recorded in Core and Workspace Dockerfiles;
Intel and Engagement's old Debian defaults still say Node 20. The reviewed
root manifest/lockfile repair changes only six parent-scoped dependency paths
listed below. Global npm/Corepack are removed from runtime stages; all existing
entrypoint verbs use Node directly, and their local Prisma CLI remains installed.

| Requirement | Source result | Remaining proof |
|---|---|---|
| Four services, Debian preserved | Four sibling recipes; no old file edits | Independent exact-head diff review |
| Nonroot / init / serve | UID/GID 1001; dumb-init; retained service entrypoint and `serve` | Image inspection and signal/startup checks |
| Workspace shell dispatch | Retains `/bin/sh /usr/local/bin/entrypoint.sh`, wrapped by dumb-init | Same verbs/negative dispatch tests |
| Ports / health | Intel 4300 `/health`; Strategy 4400 `/strategy-api/health`; Workspace 4200 `/health`; Engagement 4500 `/health` | Actual startup + response checks in isolated synthetic environment |
| Prisma musl | Existing helper changes only copied generator target to host image architecture; fresh production generation | Probe loads exact `.so.node` engine; real isolated PG16 checks still required |
| Production graph | Empty frozen `--prod` workspace, generated Prisma and pnpm workspace links retained | Runtime import probes + scanner inventory |
| Intel hearing tools | Pinned ffmpeg 8.1.2-r0 includes ffmpeg and ffprobe | Existing hearing/audio suites plus actual synthetic WebM/PCM probe |
| Strategy PDF | Chromium 155.0.8059.84-r0, Liberation 2.1.5-r2, existing configured executable path | Existing report/PDF specs and real synthetic PDF render |
| amd64 | Exact Core-qualified image manifest default | All four builds/tests/scans |
| arm64 | Explicit known Core ARM64 pin supported; musl selection follows actual Node arch | Not built; never claim cross-architecture acceptance |
| 0 HIGH / 0 CRITICAL | Required threshold unchanged; first gate failed | Fresh scans of repaired exact images required |
| MEDIUM | No acceptance inferred | Enumerate every finding, version, fix and disposition; do not silently accept |

`ffmpeg-audio-command.ts` and `ffmpeg-deepgram-capture.runtime.ts` call ffmpeg for
HTTPS/HLS to 16kHz PCM. `recording-assembly.worker.ts` calls ffmpeg for WebM remux,
decode validation and ffprobe for duration; `transcription-recovery.worker.ts`
also calls ffmpeg. The offline runtime probe exercises real installed binaries
on synthetic local audio and validates required protocols, with no provider call.
Strategy retains the existing Chromium driver and its existing sandbox options;
this packaging change does not claim browser sandbox qualification.

Alpine package versions were read from the official
[community index](https://dl-cdn.alpinelinux.org/alpine/v3.24/community/x86_64/APKINDEX.tar.gz)
and [main index](https://dl-cdn.alpinelinux.org/alpine/v3.24/main/x86_64/APKINDEX.tar.gz)
on 2026-10-23. Exact leaf pins fail closed if removed; refresh only after scan and
review. Other OS dependencies resolve from the pinned Alpine release, so retain
the final package inventory and image ID for every gate (the base pin alone does
not pin those repository packages).

## Exact local gate commands (orchestrator only, sequential)

Run in an exact-head Linux checkout on WSL `Codex-Gates`, not the damaged original
Core working tree. No cloud credentials or env files are needed. Record `git
rev-parse HEAD`, `git rev-parse HEAD^{tree}`, `docker version`, scanner version and
scanner database timestamp. Resolve tags to IDs before running tests/scans.

```bash
set -euo pipefail
test -z "$(git status --porcelain)"
sha=$(git rev-parse HEAD)
mkdir -p /tmp/wave2-alpine-$sha
out=/tmp/wave2-alpine-$sha
for service in intel-api api-strategy workspace engagement-api; do
  docker build --platform linux/amd64 --progress=plain \
    -f apps/$service/Dockerfile.alpine --target runtime \
    --iidfile "$out/$service.runtime.id" -t wave2-$service:$sha . \
    >"$out/$service.build.log" 2>&1
  image=$(cat "$out/$service.runtime.id")
  docker image inspect "$image" >"$out/$service.inspect.json"
  docker run --rm --network none --read-only --tmpfs /app/tmp:uid=1001,gid=1001 \
    --entrypoint node "$image" /qualification/alpine-service-probe.cjs "$service" \
    >"$out/$service.probe.log" 2>&1
  docker run --rm --network none --entrypoint /sbin/apk "$image" info -vv \
    >"$out/$service.apk.txt"
  docker build --platform linux/amd64 --progress=plain \
    -f apps/$service/Dockerfile.alpine --target qualification \
    --iidfile "$out/$service.tests.id" -t wave2-$service-tests:$sha . \
    >"$out/$service.test-build.log" 2>&1
done
```

Qualification targets are **musl build/test images**, not the shipped runtime.
They retain unchanged source, Jest setup and development tools. Runtime probes
above independently exercise the production graph. Do not report passing tests
in the development image as complete production-runtime or DB qualification.

Run the existing suites with no cloud/provider network. Preserve every failure
and every existing skip, and diagnose each; the following commands do not waive
PG-dependent acceptance. The Engagement image compiles `apps/api`; its bounded
service suites target Engagement code rather than all unrelated Core families.

```bash
docker run --rm --network none "$(cat "$out/intel-api.tests.id")" pnpm exec jest --runInBand \
  >"$out/intel-api.tests.log" 2>&1
docker run --rm --network none "$(cat "$out/api-strategy.tests.id")" pnpm exec jest --runInBand \
  >"$out/api-strategy.tests.log" 2>&1
docker run --rm --network none "$(cat "$out/workspace.tests.id")" pnpm exec jest --runInBand \
  >"$out/workspace.tests.log" 2>&1
docker run --rm --network none "$(cat "$out/engagement-api.tests.id")" pnpm exec jest --runInBand \
  --testPathPattern='src/(engagement-api|engagement)/' \
  >"$out/engagement-api.tests.log" 2>&1
```

Keep three explicit test tiers: offline source/fixture suites; runtime packaging
and loopback-only compatibility; disposable PostgreSQL 16 suites with synthetic
configuration. Preserve the initial unfiltered failures and list each test moved
to the DB tier. DB-required tests and existing skips are not waived by an offline
pass. Qualification stages include the actual imported cross-service source,
workspace dependency links, Prisma clients and checked-in docs; Workspace WS03
also receives its existing disposable-PG helper, Core schema and pg/Prisma closure.
Runtime stages receive none of those test-only inputs.

Run the dependency compatibility fixture on each production image, with a writable
temporary directory. `--network none` retains loopback sockets used by synthetic
multipart and WebSocket requests; no provider or database is contacted:

```bash
docker run --rm --network none --read-only --tmpfs /app/tmp:uid=1001,gid=1001 \
  --entrypoint node "$image" /qualification/alpine-dependency-compatibility.cjs "$service"
```

For the Engagement probe, the unchanged `serve` command runs
`dist/engagement-main.js`, whose relative import is
`./engagement-api.app.module.js`. The corrected probe checks the compiled entrypoint,
imports that real module and its bootstrap dependencies with explicit synthetic
production/shadow configuration, and runs the actual environment validator. It
does not construct Nest or a Prisma pool. Image failure controls must hide the
compiled app module or one required dependency and observe a nonzero exit; an
absent package is not caught or ignored. Actual startup/health still needs PG16.

Prioritize Intel `src/hearing/capture/ffmpeg-audio-command.spec.ts`,
`ffmpeg-deepgram-capture.runtime.spec.ts`, recording/recovery specs, Strategy PDF
driver/report specs, Workspace version/rendering specs and Engagement entrypoint,
health/runtime-policy specs. Actual service health requires synthetic PG16/config
and the existing service initialization contract; never substitute a fake health
response or use the clone DB. Failure with absent prerequisites is BLOCKED, not
PASS. Tests are unrun at source handoff.

Scan the actual production IDs with the root-owned installed Trivy (or an
equivalent reviewed scanner), including unfixed vulnerabilities. A local scan
does not replace the future exact-digest ECR gate in the original brief.

```bash
for service in intel-api api-strategy workspace engagement-api; do
  image=$(cat "$out/$service.runtime.id")
  trivy image --scanners vuln --format json --output "$out/$service.scan.json" "$image"
  trivy image --scanners vuln --severity HIGH,CRITICAL --exit-code 1 "$image"
done
```

For every image report counts for CRITICAL/HIGH/MEDIUM/LOW/UNKNOWN separately.
List MEDIUM records as vulnerability ID, package, installed version, fixed
version, source URL and disposition. No automatic acceptance. Name any npm
finding and seek concrete review before touching dependencies/application code.

ARM64 is an **additional unrun gate**, with the same commands and:

```bash
--platform linux/arm64 \
--build-arg NODE_IMAGE=docker.io/library/node:22.23.3-alpine3.24@sha256:85cdd100016a2e09927c0776bb7ebebcfefce5cd0af49893ada91cbc4d78ee22
```

Do not run arm64 with the default amd64 child digest. No cross-architecture claim
until actual build/runtime tests pass. Independent Astra/ultra exact-head review
and all required image gates remain outstanding.

## Native source checks at initial handoff

`node --check scripts/qualification/alpine-service-probe.cjs`: passed.
Unsupported service invocation: bounded usage failure before allocation.
`git diff --check`: passed. No application tests, Docker builds, PostgreSQL
checks, vulnerability scans, CodeBuild or provider-live checks were run by lane D.
The probe's positive runtime checks require Linux images; Windows syntax checks
are not evidence that the native binaries load.

## Reviewed dependency repair and compatibility evidence

The orchestrator allocated `package.json`, `pnpm-lock.yaml` and the compatibility
fixture after reviewing each concrete need. No service manifest version, Debian
recipe, entrypoint or application source was changed. pnpm 9.12.0's generated
metadata/snapshots for the three new versions were retained while unrelated lock
records/importers were preserved. A frozen install for all four service closures
passed without resolution (10 workspace projects, 1,433 packages).

| Exact parent | Repair | Runtime reason / evidence |
|---|---|---|
| `express@4.22.1` | `proxy-addr` 2.0.7 → 2.0.8 | Nest HTTP IP/trusted-proxy handling; trusted/untrusted chain and malformed range checks |
| `@nestjs/platform-express@10.4.22` | `multer` 2.0.2 → 2.3.0 | Planner and newsletter uploads; actual Nest interceptor bytes, oversize, malformed, abort and subsequent-request checks |
| `@clerk/shared@3.47.5` | `js-cookie` 3.0.5 → 3.0.7 | Clerk's shared runtime closure; Clerk import and delimiter-safe cookie round trip |
| `@nestjs/config@3.3.0` | `lodash` 4.17.21 → 4.18.1 | Configuration lookup/merge; dotted paths, fallbacks and prototype protection. Registry marks 4.18.0 a bad deprecated release, so it was rejected. |
| `@nestjs/platform-ws@10.4.22` | `ws` 8.18.0 → 8.21.0 | Intel Nest WebSocket adapter; actual loopback handshake, echo and orderly close. Direct `ws` 8.22.0 stays unchanged. |
| `pptxgenjs@3.12.0` | remove unused `image-size` edge | Published PptxGenJS code never imports it; verified rendering detailed below. No major API override. |

Exact package metadata/integrities were read from the npm registry on 2026-10-23
([proxy-addr](https://registry.npmjs.org/proxy-addr/2.0.8),
[multer](https://registry.npmjs.org/multer/2.3.0),
[js-cookie](https://registry.npmjs.org/js-cookie/3.0.7),
[lodash](https://registry.npmjs.org/lodash/4.18.1),
[ws](https://registry.npmjs.org/ws/8.21.0)). The corresponding hashes are pinned in
the lockfile. This shared lock repair also affects other services that consume
those exact parents; their unchanged Debian recipes do not isolate dependency
resolution. No acceptance is claimed for those out-of-scope service images.

The [published PptxGenJS 3.12.0 tarball](https://registry.npmjs.org/pptxgenjs/-/pptxgenjs-3.12.0.tgz)
has lock-matching SHA512
`ZozkYKWb1MoPR4ucw3/aFYlHkVIJxo9czikEclcUVnS4Iw/M+r+TEwdlB3fyAWO9JY1USxJDt0Y0/r15IR/RUA==`.
Its CJS, ES, bundle, minified JS and declarations contain no `image-size` import
or use; the only declaration is package metadata. It was the lockfile's only
incoming `image-size` edge. The new fixture checks resolution fails, proves a
forced import trap rejects, then renders PNG bytes, an SVG and a local PNG path
with that trap armed. It checks three picture elements, exact OOXML dimensions,
media relationships and original PNG/SVG bytes. This removes unused code from the
installed closure; it is not a scanner exclusion or an acceptance of the finding.

Windows Node 24.22.1 native compatibility results: Intel 6/6, Strategy 6/6,
Workspace 5/5 and Engagement 6/6. Existing Strategy report/image, planner upload/
attachment and auth suites passed 45/45 after building their existing shared,
auth and strategy-verifier prerequisites. The first attempt reported three
missing `@capiro/strategy-verifier` build-output errors; rebuilding that unchanged
workspace prerequisite fixed them. These native fixtures do not substitute for
the orchestrator's Linux/musl source suites, runtime scans, startup, or PG16 gates.
Existing Intel hearing-gateway capture and tenant/resolver auth suites also
passed 52/52 with synthetic mocks; no provider request or database connection ran.

The orchestrator's exact `5df32e16` rebuild reached the new syntax-check child in
all four images but Node 22.23.3 crashed in `SourceMapCacheMap.set/checkSyntax`
with `TypeError: WeakRef: invalid target` when inheriting
`NODE_OPTIONS=--enable-source-maps`. Its isolated control on the existing Intel
runtime image reproduced exit 1 with inherited maps and exit 0 with
`node --no-enable-source-maps --check <compiled-file>`. Invalid JavaScript under
the same diagnostic flags still exited 1 with `SyntaxError`. Evidence:
`20261023T042150Z-node22-syntax-repro/summary.json` in the orchestrator's gate runs.
Both syntax-check calls now pass that child-only CLI flag. The image environment,
actual service execution, module imports, Prisma and dependency checks retain
their existing settings. Native probe syntax passes; fresh exact-head image
qualification remains required.

## Engagement dependency follow-up

The orchestrator's `44443edfc41cd0172fa75df4c7a7c63740c99d9c` gate built all four
images and passed their runtime probes/compatibility fixtures. Intel, Strategy
and Workspace had zero HIGH/CRITICAL findings at that exact head. Engagement
still had 18 HIGH findings in four package versions. These earlier results do
not qualify the new head; fresh exact-head builds and scans remain required.

Four additional selectors were reviewed before editing:

| Exact parent | Pinned change | Production path and compatibility |
|---|---|---|
| `@capiro/api@0.0.0` | MCP SDK 1.31.0 → 1.32.0 | Core's direct managed-MCP client; real in-memory initialize, list, call, invalid arguments/unknown tool, close and post-close rejection |
| `minimatch@3.1.5` | brace-expansion 1.1.14 → 1.1.20 | ExcelJS → archiver/fstream → glob; nested, escaped and numeric braces plus positive/negative matching |
| `minimatch@5.1.9` | brace-expansion 2.1.0 → 2.1.6 | ExcelJS → archiver → readdir-glob; same brace controls and real XLSX write/load with sheet/cell/value checks |
| `cheerio@1.2.0` | undici 7.26.0 → 7.29.1 | Cheerio's import-time HTTP dependency; loopback HTML/entity parsing, redirect, non-2xx and invalid MIME rejection |

Registry metadata/integrities were captured on 2026-10-23 for
[SDK 1.32.0](https://registry.npmjs.org/@modelcontextprotocol%2fsdk/1.32.0),
[brace 1.1.20](https://registry.npmjs.org/brace-expansion/1.1.20),
[brace 2.1.6](https://registry.npmjs.org/brace-expansion/2.1.6), and
[Undici 7.29.1](https://registry.npmjs.org/undici/7.29.1). None is deprecated in
that capture. pnpm 9.12.0 importer-scoped overrides were first verified in an
isolated workspace, then the four service closures passed a frozen install
with resolution skipped (10 workspace projects). A structural lock comparison
checks only the four selectors, Core SDK importer, corresponding new package
records and three parent edges changed. SDK transitive versions are unchanged.
Core's direct Undici 6.28.1, jsdom's Undici 7.26.0, minimatch 9's brace 2.1.0,
and unrelated SDK 1.31.0/Zod 4 peer closures remain unchanged.

Production reverse-dependency traversal reaches these four selected parents
only through Core's SDK, Cheerio and ExcelJS. The minimatch 3 selector also
affects development tooling: root promptfoo, Nest CLI in Core/Strategy/Intel/
Workspace/Defense/Meri orchestrator/Onboard, and Jest/ts-jest in those services
except Defense, plus `infra/cdk`, `packages/auth` and `packages/meriv2-core`.
No other production importer resolves a changed parent. Core's other entrypoints
and unchanged Debian builds consume its same root lock, so they also receive
these Core dependency changes; no separate qualification of those images is
claimed. Full reverse paths are retained in the orchestrator's
`d-dependency-evidence/engagement-lock-verification.json`.

The compatibility fixture now blocks non-loopback sockets before DNS/connect,
with a negative control proving an attempted outbound address is refused.
Windows Node 24.22.1 results: Intel 7/7, Strategy 7/7, Workspace 6/6, Engagement
10/10. The actual source MCP transport/pagination/OAuth and Florida parser suites
passed 76 tests across seven suites with all network connections refused by a
test-only preload. The first source attempt started before native Prisma
generation completed and had three module-load failures; after generation,
only those three OAuth suites were rerun (24/24). The original 52-test result
and failed-load evidence are retained. No schema, provider or database operation
was run; Prisma client generation only writes local generated artifacts.

The first Cheerio relative-redirect fixture exposed its missing default origin.
An isolated control with the same Cheerio 1.2.0 and Undici 7.26.0 versus 7.29.1
reproduced `ERR_INVALID_URL` in both; both pass when its request options supply
the origin. The retained redirect check supplies that origin explicitly. Core
source uses `cheerio.load`, with no `cheerio.fromURL` callers found; parser suites
exercise that actual usage. This control does not claim the inherited default
relative-redirect behavior is fixed.

## MEDIUM disposition draft (no acceptance)

Source: the orchestrator's complete Trivy findings at `44443edf`, run
`20261023T042507Z-alpine-44443edf`. Versions/fixes below are reported by that
scanner; reachability statements come from the locked graph and source, not
exploit reproduction. A package's presence is not proof of vulnerable-code
reachability, and absence of a located caller is not an exclusion. Every record
remains visible and requires final-image reconciliation. No additional package
upgrade, risk acceptance or scanner suppression is included in this change.

| Package / affected image | MEDIUM IDs and scanner fix | Reachability evidence / pending disposition |
|---|---|---|
| `@nestjs/core` 10.4.22 / all four | [CVE-2026-35515](https://avd.aquasec.com/nvd/cve-2026-35515); 11.1.18 | Actual HTTP bootstrap dependency. Requires separate Nest-major compatibility review; remains open. |
| `file-type` 20.4.1 / all four | [CVE-2026-31808](https://avd.aquasec.com/nvd/cve-2026-31808), [CVE-2026-32630](https://avd.aquasec.com/nvd/cve-2026-32630); 21.3.1 / 21.3.2 respectively | Nest common dependency. No direct file-type/FileTypeValidator caller found in the four service source trees; indirect framework usage still needs review. Major override not authorized. |
| `multer` 2.3.0 / all four | [CVE-2026-88932](https://avd.aquasec.com/nvd/cve-2026-88932); 2.4.0 | Real Nest upload interceptors process multipart input. Existing malformed/limit/abort controls are compatibility evidence, not a CVE waiver; separate fix review remains open. |
| `qs` 6.14.2 and 6.15.1 / all four | [CVE-2026-82417](https://avd.aquasec.com/nvd/cve-2026-82417), [CVE-2026-82562](https://avd.aquasec.com/nvd/cve-2026-82562), [CVE-2026-8723](https://avd.aquasec.com/nvd/cve-2026-8723); 6.16.0 covers all three (8723 also fixed in 6.15.2) | Express/body-parser request parsing closure; attacker-controlled request input is plausible. Exact enabled parser/options and fix compatibility need review. Both installed-version records remain open. |
| `sanitize-html` 2.17.7 / Workspace, Engagement | [CVE-2026-113654](https://avd.aquasec.com/nvd/cve-2026-113654), [CVE-2026-113661](https://avd.aquasec.com/nvd/cve-2026-113661); 2.18.0 | Actual newsletter/signature/SVG sanitization source callers. Needs focused policy and malformed-markup regression controls before a separately reviewed upgrade. |
| MCP SDK 1.31.0 / Engagement | [CVE-2026-111769](https://avd.aquasec.com/nvd/cve-2026-111769), [CVE-2026-111771](https://avd.aquasec.com/nvd/cve-2026-111771); 1.32.0 | Managed MCP imports use it. Approved HIGH repair pins the reported fixed version; removal of these MEDIUM findings is pending the new exact-image scan. |
| `brace-expansion` 1.1.14, 2.1.0 / Engagement | [CVE-2026-102277](https://avd.aquasec.com/nvd/cve-2026-102277); 1.1.21 / 2.1.7 (also 3.0.9 / 5.0.12) | ExcelJS archive glob closure. Reviewed HIGH pins 1.1.20 / 2.1.6 do not satisfy this MEDIUM fix; user-controlled glob reachability is unproven. Remains open; no extra update inferred. |
| `ip-address` 10.7.2 / Engagement | [CVE-2026-111997](https://avd.aquasec.com/nvd/cve-2026-111997); 10.7.4 | SDK → express-rate-limit dependency. Core uses SDK client transports; server/rate-limit code reachability still needs proof. Remains open. |
| `undici` 7.26.0 / Engagement | [CVE-2026-14643](https://avd.aquasec.com/nvd/cve-2026-14643), [15157](https://avd.aquasec.com/nvd/cve-2026-15157), [16728](https://avd.aquasec.com/nvd/cve-2026-16728), [16729](https://avd.aquasec.com/nvd/cve-2026-16729), [18149](https://avd.aquasec.com/nvd/cve-2026-18149), [84890](https://avd.aquasec.com/nvd/cve-2026-84890), [84933](https://avd.aquasec.com/nvd/cve-2026-84933), [85014](https://avd.aquasec.com/nvd/cve-2026-85014), [9678](https://avd.aquasec.com/nvd/cve-2026-9678), [9679](https://avd.aquasec.com/nvd/cve-2026-9679); 7.29.1 covers all ten | Cheerio imports it, but actual source calls `load`, not its HTTP API. Reviewed HIGH fix pins 7.29.1; new image scan must confirm these records disappear. Direct Core 6.28.1 is untouched. |
| `uuid` 8.3.2 / Engagement | [CVE-2026-41907](https://avd.aquasec.com/nvd/cve-2026-41907); 11.1.1 / 12.0.1 / 13.0.1 | MSAL Node and ExcelJS dependencies; exact vulnerable API usage unresolved. Major update requires parent/API review, remains open. |

Fresh full scans, source-suite disposition against exact baselines, disposable
PG16 coverage, complete runtime/failure controls and independent exact-head
Astra review are still required. This native checkpoint is not full qualification.
