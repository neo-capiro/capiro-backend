# Four-service Alpine image qualification

Status: narrow security follow-up after native ARM qualification of `c286c886`.
The preceding `0eee084c` qualification and ordinary Core `75a9069b` merge remain
recorded below. The `c286c886` four ARM builds, probes and compatibility checks
passed; exact-digest ECR scans reported zero findings and Trivy zero HIGH/CRITICAL.
That fresh scan identified sanitize-html 2.18.0's discarded-iframe recursion
advisory and Stripe's remaining qs 6.15.1 edge. This follow-up repairs both.
The earlier `0eee084c` four ARM builds/probes, real Strategy PDF render and
exact-digest ECR scans passed; Trivy reported zero HIGH/CRITICAL findings, with
21 remaining advisory/package version records. The approved repair and bounded
dispositions are below. Fresh
final-head qualification is required. Earlier failures and receipts remain
history, including the missing Engagement inputs and Strategy HOME fixes.

Base: `db96ad310fa1c3cc43278ff9c2d59e750581bac3` (`backend-import`). Briefs:
[original](https://github.com/neo-capiro/meri-greenfield/issues/202#issuecomment-6355187204)
and [four-service addendum](https://github.com/neo-capiro/meri-greenfield/issues/202#issuecomment-6355270797).
Neo lifted the earlier holds. Root Codex owns AWS, CodeBuild, image/database gates,
shipping and live acceptance; implementation sessions do not run those operations.

## Current narrow advisory repair

All four build bases and final runtime stages require Alpine `musl` and
`musl-utils >=1.2.6-r3`. The maintainer's [regcomp advisory](https://seclists.org/oss-sec/2026/q4/289)
describes integer overflow and possible heap writes; UNKNOWN scan severity is
not an acceptance. V8 regex is a different implementation, but native utilities
prevent a whole-image unreachability claim. The Alpine security patch is used
without changing the pinned Node major or native-tool behavior.

| Exact parent(s) | Final pin | Reason |
|---|---|---|
| `@nestjs/platform-express@10.4.22` | `multer` 2.4.0 | Existing upload selector advances to the aborted-disk-write fix; inspected product storage is memory-based. |
| `@nestjs/platform-express@10.4.22`, `express@4.22.1` | `body-parser` 1.20.6 | Reject invalid body-limit options while retaining positive/oversize/malformed request behavior. |
| `body-parser@1.20.6`, `express@4.22.1`, `stripe@17.7.0` | `qs` 6.16.0 | Close comma-limit and stringify defects; body-parser and Stripe still resolve 6.15.1 without their exact selectors. |
| `@capiro/api@0.0.0`, `@capiro/workspace@0.0.0` | `sanitize-html` 2.18.1 | Retain noscript/meta/SVG fixes and close discarded-iframe recursion/global nesting-limit bypass on actual HTML-sanitizing service roots. |
| `minimatch@3.1.5`, `minimatch@5.1.9` | `brace-expansion` 1.1.21, 2.1.7 respectively | Patch the existing ExcelJS/archive glob paths. |
| `express-rate-limit@8.7.0`, `socks@2.8.9` | `ip-address` 10.7.4 | Patch Address6 percent/newline rejection. Rate-limit is in Core's MCP closure; the socks selector also affects other/dev consumers. |

Published registry metadata was checked for all seven final package versions;
none is deprecated and all support the image's Node 22.23.3. The lock preserves
unrelated importers, versions and records, including unused historical records;
new `launder` 1.7.2 is sanitize-html's declared dependency. Root closure metadata
and its exact pin are regenerated as required by AGENTS. Prisma schema bytes and
existing architecture-specific generator pins are unchanged.

The maintainer's [CVE-2026-113650 advisory](https://github.com/apostrophecms/apostrophe/security/advisories/GHSA-c9rx-x947-fp3h)
identifies 2.18.1 as the iframe fix. It removes the deepmerge dependency while
retaining the other locked sanitizer dependencies. A timeout-bounded child
process exercises 2,000 discarded iframes and cross-iframe nesting limits, with
ordinary fallback and permitted markup positive controls. Stripe's real installed
request serializer is checked for nested parameters, arrays, dates and hostile
constructor-shaped values; the fixture also exercises its exact qs dependency.
Prior-version controls and first-attempt failures remain in the review evidence.

Three affected packages remain present with explicit, bounded dispositions:

- [Nest SSE injection](https://github.com/nestjs/nest/security/advisories/GHSA-36xv-jgw5-4q75):
  no `@Sse`/SseStream consumer was found in the four-service product source.
  The affected formatter needs user-influenced message type/id; retain Nest 10.
- [file-type ASF](https://github.com/sindresorhus/file-type/security/advisories/GHSA-5v7r-6r5c-r473)
  and [ZIP](https://github.com/sindresorhus/file-type/security/advisories/GHSA-j47w-4g3g-c36v):
  only the Nest common lazy FileTypeValidator edge enters this selected closure.
  No direct file-type, FileTypeValidator or ParseFilePipe builder call was found.
  Keep 20.4.1; a new caller must reopen this disposition. Size caps alone would
  not mitigate the small malformed ASF payload.
- [uuid buffer bounds](https://github.com/uuidjs/uuid/security/advisories/GHSA-w5hq-g745-h8pq):
  MSAL Node 2.16.3 and ExcelJS 4.4.0 are the two uuid 8 parents. Their inspected code
  only calls v4 without output buffers; the affected APIs are v3/v5/v6 with
  caller buffers/offsets. Retain 8.3.2 without a major override.

These are reachability dispositions for the reviewed source, not scanner
exclusions or absence claims. Recheck the final production graph and preserve
all remaining scan records. Other services sharing exact parents are affected
by the lock change and are not qualified by four-service results.

The compatibility fixture retains its previous real upload, WS, SDK, XLSX and
PPTX checks and adds body-parser limits, qs regression cases, sanitizer cases and
MCP rate-limit IPv6 checks, with non-loopback network refused. Windows native
results are supplemental; all Linux/native ARM image gates remain root-owned.

Workspace's prior ARM Jest run has 12 suite-load failures from requiring the
sanitizer's ESM parser through Jest's VM. Its test-only native environment now
loads the real Workspace-installed sanitizer and an exact-specifier bridge
exposes that function to the suite. Missing/malformed exports fail closed; there
is no sanitizer stub or parser downgrade. The existing `jest*` qualification COPY
includes these files. Two other suite-load failures, two assertion failures and
the skipped database tier remain separate from this harness repair.

The follow-up Windows checks pass 44 compatibility cases and 52 closure/platform
checks. Prior-version controls reproduce the sanitizer stack/depth failures and
Stripe's qs constructor/comma failures. Two real-module harness cases pass;
removing the bridge restores the expected ESM failure. Of the 12 previously
ESM-blocked suites, three pass 27 cases locally and nine reach missing generated
Workspace Prisma-client type members. Those failures are retained, without
disabling diagnostics. The final image must rerun them with its generated client.
The regenerated graph has 505 nodes, 989 edges and zero unresolved references;
the removed old qs also removes its unused side-channel root, and the new
sanitizer removes deepmerge. Retained nodes, unrelated edges and Prisma pins
are unchanged.

## Source archive and test disposition

The old ARM source manifest is not byte-identical to Git: 3,245 files, including
610 migration SQL files across the full repo, were converted from LF to CRLF.
No other source-content mismatch was found; two explicit gate wrappers were
additional files. The 18 Engagement plan cases failed their approved migration
checksum before reaching the database guard. Preserve those failures and the
approved SQL/pin. The next archive must disable Git working-tree conversion:

```bash
git -c core.autocrlf=false -c core.eol=lf archive --format=tar "$sha" > source.tar
```

Root verifies each archive source file against its Git blob before adding the
explicit qualification wrappers and uploading the checksum-bound artifact.
Do not normalize SQL at runtime or change an approved pin to fit a bad archive.

The old Intel ARM result has 159 DB-prerequisite assertion failures, one
Senate smoke case requiring both DB and public-source acceptance, and 22 non-DB
failures. Six unique suites also fail DB guards before assertions (Jest's
runtime-error aggregate reports 12). The 20 stale mock cases, performance case
and file-pin case have earlier AMD64 base attribution; that does not qualify
ARM timing or the converted source artifact. Workspace's two assertions and 14
parser/type failures reproduce on base, including the same VM flag. Its 37 WS03
skips remain unqualified. Engagement's six non-DB failures have base evidence;
its 18 checksum failures require corrected source bytes before real PG replay.
Strategy's 233 pending cases also remain explicit. No failed/skipped test is
silently waived, and an inherited fixture failure still leaves behavior untested.

Core 75a's separate local migration receipt proves 599 exact, finished, unrolled
ledger rows: 474 Core-prefix migrations through 20281016020000, 28 Strategy,
remaining 9 Core, 61 Intel, 27 Workspace. Strategy precedes Core 20281017010000
because that Core migration references `sp_draft_job`. It uses unchanged SQL
and actual Prisma deploy. This does not prove runtime RLS/grants/concurrency,
application behavior, separate Workspace database behavior or ARM execution.
Root's subsequent actual database tiers remain separate evidence.

## Implementation outline and requirement audit

Each service owns its new `Dockerfile.alpine`; existing Debian recipes, entrypoint
scripts, application code, service manifests and schema files remain unchanged.
Reuse Core's exact Node 22.23.3 / Alpine 3.24 amd64 pin and its image-local Prisma
generator helper. Node 22 also satisfies the frozen `sanitize-html` dependency's
Node >=22.12 requirement already recorded in Core and Workspace Dockerfiles;
Intel and Engagement's old Debian defaults still say Node 20. The reviewed
root manifest/lockfile repair changes only the parent-scoped dependency paths
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
| Strategy PDF | Chromium 155.0.8059.84-r0, Liberation 2.1.5-r2, existing configured executable path; writable image HOME at `/app/tmp` | Probe performs real canonical-driver render and disabled-export control; fresh image result still required |
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

Engagement qualification now also contains the seven exact root inputs used by
its selected suites: the three `scripts/{run-engagement-phase1-local,
run-engagement-phase1-post-acceptance,verify-engagement-phase1-local}.mjs` files,
the two `tests/support/legacy-web/engagement-phase1-{browser-parity,
post-acceptance}.mjs` files, `scripts/testing/a1-disposable-postgres.cjs`, and
`docs/a1/mail/single-mail-intents.sql`. No host fixture mount is required. These
files are copied only after `FROM build AS qualification`; production dependency
and runtime stages do not inherit them. The existing source assertions remain
unchanged. To reproduce the reviewed input defect's positive control after the
qualification build above:

```bash
docker run --rm --network none "$(cat "$out/engagement-api.tests.id")" \
  node --experimental-vm-modules node_modules/jest/bin/jest.js --runInBand --forceExit \
  --runTestsByPath \
  src/engagement/runtime/engagement-phase1-browser-acceptance.spec.ts \
  src/engagement/engagement-route-manifest.spec.ts \
  src/engagement/engagement-dependency-manifest.spec.ts \
  src/engagement/engagement-side-effect-registry.spec.ts \
  >"$out/engagement-api.qualification-inputs.log" 2>&1
```

This focused input check supplements the unchanged full selection above. It
does not omit or waive failures from that broader selection.

Run the dependency compatibility fixture on each production image, with a writable
temporary directory. `--network none` retains loopback sockets used by synthetic
multipart and WebSocket requests; no provider or database is contacted:

```bash
docker run --rm --network none --read-only --tmpfs /app/tmp:uid=1001,gid=1001 \
  --entrypoint node "$image" /qualification/alpine-dependency-compatibility.cjs "$service"
```

Strategy's packaging probe now launches its actual compiled `PdfBrowserDriver`
at UID 1001, checks the disabled-export refusal, then validates PDF header, EOF,
page marker and nonempty output. It reports byte count and SHA256 and fails the
whole probe on any render error. The image supplies `HOME=/app/tmp`; do not
override HOME in the gate. To retain the synthetic artifact, bind the output
directory while the container is alive (copying after tmpfs teardown loses it):

```bash
mkdir -p "$out/strategy-pdf"
chmod 0777 "$out/strategy-pdf"
docker run --rm --network none --read-only --tmpfs /app/tmp:uid=1001,gid=1001 \
  --mount "type=bind,src=$out/strategy-pdf,dst=/evidence" \
  -e PDF_GATE_OUTPUT=/evidence/strategy-synthetic.pdf \
  --entrypoint node "$(cat "$out/api-strategy.runtime.id")" \
  /qualification/alpine-service-probe.cjs api-strategy \
  >"$out/strategy-pdf/render.log" 2>&1
```

The source driver, its sandbox/launch arguments and Debian recipe are unchanged.
Root's same-image `44443edf` controls failed with Crashpad `--database is required`
under both writable and read-only root filesystems, then passed with only
`HOME=/app/tmp` on a read-only root plus the existing tmpfs. That render produced
23,504 bytes and passed the disabled-export control. Its successful receipt is
`20261023T042507Z-alpine-44443edf/strategy-real-pdf-tmp-home-a25bf4a2`. The new
default-image HOME and integrated probe still require a fresh root-owned gate.

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
Independent reverse-graph review specifically identified Defense API, Meri
orchestrator and Onboard API (Nest/Express/Clerk parents), Onboard Web (Clerk
cookie closure), and `packages/auth` (Clerk/Nest config closure) as collateral
production consumers of the first six selectors. Four-service image results
must never be presented as qualification of those consumers.

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

## Qualification-input audit and native repair evidence

The selected Jest patterns were audited for filesystem reads, repository-root
paths, cross-service imports and helper-spawned manifest generators. Engagement's
runtime route/boundary scans and generators require the entire existing Core
`src` tree, already copied by the build stage. Strategy's signed wire fixture
JSONs/Core imports, Intel's Core/Workspace imports plus ownership inventory and
shared sources, and Workspace's A1 helper/Core datamodel are already included
in their qualification stages. Service-local source, schemas, templates, eval
files and test fixtures are covered by each existing COPY block. This audit
does not claim that every selected assertion passes.

A native preload models the tracked COPY inputs from each Dockerfile; it is not
a Docker execution. With the old Engagement recipe it reproduced exactly 31
browser-contract failures and four passes. With the repaired recipe the same
suite passed 35/35. All seven added files were readable under the model; the A1
helper correctly reported unavailable with no disposable URL, without a DB call.
Across ten related Engagement source-contract suites, 4,200 distinct tracked
reads had no missing COPY input. Final results were 109 passed / two failed;
the unchanged controller/route-manifest mismatches remain open and match the
two named failures already retained in root's baseline analysis. The first
preload denied tsx's local named-pipe IPC as well as TCP; after allowing only
that pipe form, the three affected generator suites passed 33/33. All TCP
remained refused. Original results and reruns are retained in
`d-dependency-evidence/qualification-input-summary.json` and adjacent receipts.

Existing Strategy PDF-document and DOCX/PPTX renderer source suites passed
34/34 with network refused. They do not launch Chromium and do not substitute
for the new real-image PDF probe. Both probe syntax and unsupported-service
refusal were checked natively. No Docker or database operation ran in lane D.

## Database and external-acceptance prerequisites

The existing [disposable bootstrap](../../scripts/ci/bootstrap-disposable-databases.sh)
requires the complete API → Intel → Workspace migration chains on their shared
`capiro` database, plus Workspace's separate `capiro_workspace` ledger. It then
creates fresh, closed `capiro_worker_1`/`capiro_worker_2` clones of the fully
migrated shared template for the API worker-binding contract. Intel's
`hearing-recording-postgres.spec.ts` explicitly requires the full API+Intel
chains, a loopback `DATABASE_URL` and `LEGIWATCH_RECORDING_TEST_DATABASE=disposable`.
An empty schema or Prisma `db push` does not qualify that suite.

Read the bootstrap's actual guards before any separately authorized mutation:
`CI=true`, `CI_DISPOSABLE_POSTGRES=1`, and either its GitHub Actions service or
`CLEANUP1_OWNED_PG=1` with a non-5432 loopback connect port. The local path also
requires the exact container name/64-hex ID/ownership label and matching
5432/tcp loopback binding, plus `psql`, frozen workspace dependencies and exact
database/worker names. It verifies the server role/port/superuser identity before
DDL. A forwarded container may require `CI_POSTGRES_SERVER_PORT=5432` while the
host connect port remains non-5432. Do not run this bootstrap merely to turn
offline failures green. Fresh inherited migration-chain failure is a separate,
still-open gate; no migration repair or replay is included here.

The [A1 native guide](../../scripts/testing/A1-NATIVE-POSTGRES.md) instead permits
its helper to create an owned random `a1_native_<nonce>` schema in a **new local
PG16 + pgvector instance**, using a checked-in datamodel with `prisma db push
--skip-generate`. It requires explicit `A1_NATIVE_PG_ALLOW_DISPOSABLE=1` and
`A1_NATIVE_PG_URL` naming loopback, port 1024–65535 and an
`a1_disposable_<8–48 lowercase letters/digits/underscores>` database, with no
query/fragment. It has no ordinary `DATABASE_URL` fallback. Core requires
`vector`, `pg_trgm`, `citext`, and `uuid-ossp`; locked builds/generated clients
must exist. Containerized tests share the disposable DB's network namespace.
Ownership-marked schema cleanup and final instance removal are mandatory.

That helper supports mailbox collision (six cases), PF-12 debrief (nine cases)
and Workspace WS03 (37 cases) according to their existing guide. WS03's joined
gateway additionally requires `WS03_FRONTEND_CHECKOUT` at unchanged frontend
head `67b71caaf5994465c5162c320cda02a3e588d413`, tree
`f27b5f7ede8ee5fc02cc025152da70d6ff68b455`, its locked install and existing
`@capiro/meri-client` build. A1 does not establish full-chain RLS, grants,
triggers, concurrency or migration-ledger behavior. Root's earlier 37 passing
Engagement PG16 cases at `44443edf` (plans 18, mailbox 6, debrief 9, prep 4) are
prior-head receipts only and do not clear the complete migration-chain gate.

Intel `src/hearing/capture/e2e-senate-smoke.spec.ts` uses an actual public Senate
hearing source. It belongs to held external acceptance, not merely the DB tier;
do not enable public network access to make the offline suite pass. Missing
prerequisites, skips and existing failures stay explicit. No database or external
acceptance command was executed for this prerequisite audit.
