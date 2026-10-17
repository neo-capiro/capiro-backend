# Backend workspace build qualification

## Scope

This successor starts from draft backend PR #72 at
`5b98c8929538257f1945364759f9b6f2535a55f5`. Its root
`build:backend` and `typecheck:backend` commands exclude `@capiro/web`,
`@capiro/onboard-web`, and `@capiro/e2e`. The E2E package is a visual
Playwright harness with an external runtime and no build task; it is not a
backend compiler prerequisite. `build:backend` is serialized with
`--concurrency=1`. The resulting graph has 16 workspace packages (the
filtered frozen install includes those 16 plus the root project). It still
includes non-UI operational packages such as infra CDK and Clio sandbox.

The qualification checkout is separate from the published PR #72 checkout.
The pinned toolchain is Node 22.23.3, matching `apps/api/Dockerfile`, and
pnpm 9.12.0. A frozen, filtered install used a task-owned store and
`--ignore-scripts`; local Prisma clients were generated explicitly without
connecting to a database. API, API Strategy, Intel API, Onboard API and
Workspace have explicit Prisma generate scripts. Defense API generates its
client in its build. Meri orchestrator has no Prisma generate script.

## Source and build observations

| Check | Result |
| --- | --- |
| Windows `cmd.exe` Turbo dry runs of both filtered commands | 16 packages selected; Web, Onboard Web and E2E excluded |
| Frozen pnpm install of root and selected packages, scripts disabled | Exit 0; lockfile unchanged; task-owned store |
| Serialized `build:backend` | 16/16 tasks passed, zero cache hits, 2m47.758s |
| First serialized `typecheck:backend`, process-local 4 GiB Node heap | 22/23 tasks passed; API's first `tsc` exhausted that heap before a TypeScript diagnostic |
| First serialized `typecheck:backend`, process-local 8 GiB Node heap | 22/23; API exposed seven circular type-inference errors in client profile fill composition and service |
| Two explicit return annotations in `client-profile-fill-completion.service.ts` | Focused API `tsc --noEmit --rootDir .` passed; no runtime expression changed |
| Final-source serialized `build:backend` | 16/16 passed; 15 cached, API rebuilt, 1m8.683s |
| Final-source serialized `typecheck:backend` in sandbox | 22/23; all API TypeScript steps before TSX passed, but TSX startup failed when sandboxed `os.userInfo()` returned `ENOMEM` |
| Targeted remaining API gates outside that sandbox | `verify-pe-phase-a-safety.ts` printed `PE_PHASE_A_B_SAFETY_OK`; final Legiwatch Phase 7 TypeScript project passed |
| Final-source serialized `typecheck:backend` outside sandbox, process-local 8 GiB Node heap | 23/23 passed; 22 cached, API uncached, 3m43.234s; PE safety verifier printed `PE_PHASE_A_B_SAFETY_OK` |

The initial sandboxed registry and Prisma binary requests failed with
`EACCES`/network denial. The same frozen install and pinned engine generation
completed after approved access, without changing dependency versions,
credentials, database state, or a live service. The 4 GiB typecheck failure
is preserved as a resource-bound attempt. The 8 GiB attempt revealed a
genuine source type cycle; annotating the two public completion-service
returns removed it. The final sandbox failure was isolated to TSX's Windows
user lookup: `node:os.userInfo()` returned the same `ENOMEM` in a minimal
sandboxed Node command, while the same read succeeded outside the sandbox.
The source safety verifier then passed outside the sandbox. The complete
serialized typecheck passed there. No type diagnostic was reported in either
final-source run.

## Onboarding source boundary

The current default `apps/onboard-api/Dockerfile` builds and embeds
`apps/onboard-web/dist`; `apps/onboard-api/src/main.ts` serves it on the
onboarding host. The optional `Dockerfile.spa-artifact` consumes a static
`index.html` asset closure. Frontend PR #81 is a dynamic Next standalone
application and cannot be supplied to that static-artifact recipe.

Frontend PR #81 contains source for the old onboarding browser flows, but a
separate host cutover still needs these exact source and route checks:

1. Route `onboarding.capiro.ai/` to `/register`. The old SPA redirects there;
   PR #81 currently renders Portfolio at `/`.
2. Retain or redirect the old `/favicon.svg` and `/legal-docs/*.pdf` URLs.
   Their bytes exist in PR #81 under `/onboard/`, but those original URLs do
   not have aliases there.
3. Keep same-host `/onboard-api/*` and health traffic on Onboard API,
   including OAuth callbacks and webhooks. The checked-in ALB host rule has
   priority 8 and the API path rule priority 9; changing only the host target
   would intercept the API path. Qualify the frontend gateway's
   `ONBOARD_API_BASE_URL` routing, Clerk session, invites, and IT callbacks
   before any cutover.

The embedded SPA and its default image recipe remain in place. A qualified
frontend host migration can precede a separate API-only image change and
source retirement.

## Web and marketing release source

The checked-in Web CodeBuild definition names `neo-capiro/capirov2.git`
`main`; quarantined GitHub workflows, the production OIDC trust and the
legacy release evidence policy likewise point to `capirov2`. Those source
files do not establish a `capiro-backend` automated Web build. The
`pe-phase-10-ship.ts` Web builder and `marketing/deploy.sh` can still build
from a supplied/local repository root, so the old source trees remain.
CDK's image-tag references do not identify the producing repository.

No task AWS profile or injected identity was available for a read-only cloud
metadata check (`NoCredentials` with IMDS disabled). The current cloud
CodeBuild/ECS configuration is therefore unverified. This task makes no
pipeline, IAM, Docker recipe, routing, credential, database or deployment
change. Legacy `capirov2` remains untouched.
