# Backend build boundary and frontend source retirement gate

## Source pins and change

This successor starts from backend cleanup PR #71 at
`4eb9483638a3e14697855f0d68bbb486d9d523cc`. The candidate frontend owner
was read at draft `neo-capiro/capiro-frontend` PR #81 head
`01cf1df981250841d40df5fe0389f47168593cce` (tree
`f72cb34644e118933964f9f5b81bec2e11d533e9`).

Root `package.json` now exposes `build:backend`, using the same exact exclusion
set as its existing `typecheck:backend` command. Both use unquoted Turbo
filters because Windows `cmd.exe` passes single quotes literally. A Turbo
2.11.4 dry run through `cmd.exe` selected 17 workspace packages, including
`@capiro/api`, `@capiro/onboard-api`, and their shared dependencies, and
excluded `@capiro/web` and `@capiro/onboard-web`. No build ran. The unfiltered
`build` and the root pnpm workspace/lockfile remain because callable image
recipes still consume the old frontend manifests and files. Turbo's `^build`
dependency rule still builds backend-owned shared packages (`shared`, `auth`,
`strategy-verifier`, defense contracts/domain, and Meri core) when selected
backend apps need them. This frontend-excluded workspace command also selects
other non-UI packages such as infra CDK and Clio sandbox; it is not an
API-image-only graph. Top-level `marketing/` is outside pnpm workspaces and
was never selected by Turbo's root `build`; its explicit root commands remain.

## Why the old source trees cannot be removed in this commit

The backend PR #71 Git tree tracks `apps/web/` (2,343 files, 29,403,584 blob
bytes), `apps/onboard-web/` (45 files, 847,426 bytes), and `marketing/` (81
files, 23,221,402 bytes): 2,469 files and 53,472,412 bytes together. These
are current-tip Git bytes, not sparse working-tree sizes.

| Path | Current source consumer or preservation dependency | Removal gate |
| --- | --- | --- |
| `apps/web/` | `apps/web/Dockerfile` is still the source-build default. `apps/api/scripts/lib/pe-phase-10-ship.ts` builds it with `docker buildx`; `scripts/meri-image-build.mjs` maps `web-vnext` to it. `infra/deploy/codebuild-web-dev.json` names that Dockerfile, but its GitHub source is **`neo-capiro/capirov2.git` main**, not this new backend repo. Backend frontend-artifact/newsletter contracts also read selected old Web files. | Rebind or retire each callable builder and preserve the backend-owned artifact/edge checks. `apps/web/Dockerfile.frontend-artifact` exists but is explicitly opt-in and does not change the default. |
| `apps/onboard-web/` | Default `apps/onboard-api/Dockerfile` copies its manifest and source, builds it, and embeds `dist`; `apps/onboard-api/src/main.ts` serves that SPA. | Qualify a canonical SPA artifact and switch the default Onboard API image recipe while retaining its serving path. `Dockerfile.spa-artifact` is opt-in and unreleased. |
| `marketing/` | Root `marketing:build/test`, `marketing/Dockerfile`, and `marketing/deploy.sh` use this source. The deploy script can push an image and force the `capiro-dev-marketing` ECS service. `infra/cdk/lib/compute-stack.ts` models its ECR/service/ALB topology. | Preserve the marketing source represented by these checked-in recipes under an explicit owner. Retire the copied manual deploy path only after that owner and release source are pinned. Do not modify the legacy `capirov2` production repository or IAM. |

This new backend tree has **no tracked `.github` workflows**: the former
workflows are disabled under the repository-split quarantine. That limits
automatic builds from this repository, but it does not make the callable
Docker, release, or marketing paths dead. The checked-in web CodeBuild project
points to `capirov2`; its current cloud configuration was not read in this
source-only task. CDK web/marketing resource definitions and release policy
remain useful to the existing production topology and are not deletion
candidates merely because UI source is moving.

## Frontend owner comparison

The inspected PR #81 frontend tree has `apps/web/` as a Next.js application;
the backend copy is a Vite application. PR #81 has no root `marketing/` and no
`apps/onboard-web/`. At exact Git blob identity, only 6 of the backend's 45
onboard-web files appear in PR #81 `apps/web/` (the favicon, two PDFs and three
fonts); comparable application files differ. None of the 81 marketing blobs
is byte-identical in PR #81 `apps/web/`. Legacy Vite entry files such as
`apps/web/index.html`, `vite.config.ts`, `src/App.tsx`, and `src/main.tsx` are
absent at those paths in PR #81. This comparison identifies source that needs
an owner decision; matching paths or a Next replacement cannot by itself
prove equivalent product behavior. No frontend repository file is modified
here.

## Ordered removal gates

1. Frontend and marketing owners pin the canonical source for the old Web,
   onboarding, and marketing features represented by these checked-in recipes.
   Account for unique source and
   customer-facing assets before deleting the backend copies. Keep historical
   Git commits recoverable.
2. Qualify immutable external Web and onboard SPA artifacts against the
   existing `Dockerfile.frontend-artifact` and `Dockerfile.spa-artifact` byte
   contracts, including the unchanged Onboard API static serving path.
3. Update the exact old-source selectors: `apps/api/scripts/lib/pe-phase-10-ship.ts`,
   `scripts/meri-image-build.mjs`, the default Web/Onboard image recipes,
   root frontend and marketing commands, and the tests that assert those
   contracts. Verify the old `capirov2` CodeBuild source and production
   release remain unchanged. No copied IAM or live pipeline retargeting.
4. Once no backend-owned build/runtime/qualification input reads the old
   trees, remove their current-tip files in a separate reviewable commit.
   Then narrow `pnpm-workspace.yaml`, regenerate `pnpm-lock.yaml` with its
   pinned pnpm 9.12.0 toolchain, and check frozen backend installs. Keep all
   backend-consumed `packages/*`, migration history, legal notices, runbooks,
   and referenced evidence.

Old Meri Nest modules require their own runtime/DI migration trace. They are
not part of this frontend build boundary.
