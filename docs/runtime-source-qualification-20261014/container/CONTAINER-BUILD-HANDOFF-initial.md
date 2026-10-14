# Pinned container build handoff

Source baseline: `dd02f3ba0b4ab77e3725e83e4b9af27aecdc8eca`, tree `03d6508d021825621f921aa37a5da6d235bb63e0`. The five-file Prisma production-classification correction is pending the parent's reviewed successor publication. Use that final published commit/tree for release builds; the baseline has a proven missing runtime migration CLI after production installation. No image, deployment, migration or serving operation occurred here.

## Actual local capability and block

Docker CLI and local Unix-socket daemon are both 28.4.0, Linux amd64. The daemon uses `/var/lib/docker`, storage driver `vfs`. Its backing 32GB filesystem reports **0 available bytes**; `/tmp` had 40,960 bytes. The separate owned `/dev/shm` scratch space does not relocate the daemon's image/layer storage. None of the four pinned Node base-image references is cached. There is no reclaimable image/build-cache storage in the read-only `docker system df` result. No build/pull/prune/reconfiguration/install was attempted. The smallest image-build environment requirement is an existing authorized builder with free persistent layer/output space, normal access to the declared registries/Debian/Prisma binary endpoints, and native ARM64 or an already qualified ARM64 build mechanism. Capacity depends on the builder/storage driver and should be established there; no unmeasured minimum is claimed here.

## Four original Docker recipes

All use **repository-root context**, Corepack `pnpm@9.12.0`, frozen lockfile installation, existing supporting-library builds, stock Prisma 5.22.0 generation before `nest build`, then frozen `--prod` installation and non-root runtime copies. Docker stages do not run migrations or seeds. Root `/package.json` pins pnpm9.12.0; prior compiler qualification used installed pnpm11.25/Node24 and did not constitute Docker acceptance.

| Service | Dockerfile | Base/runtime image tag | Shared packages built/copied | Port | Serve command |
|---|---|---|---|---|---|
| Core | `apps/api/Dockerfile` | `public.ecr.aws/docker/library/node:22.23.3-bookworm-slim` | shared, meriv2-core, defense-contracts, defense-domain | 4000 | existing wrapper/legacy dispatcher then `node dist/main.js` |
| Workspace | `apps/workspace/Dockerfile` | `node:22.23.3-bookworm-slim` | shared, auth, meriv2-core | 4200 | existing shell entrypoint `node dist/main.js` |
| Strategy | `apps/api-strategy/Dockerfile` | `node:20.16.0-bookworm-slim` | auth, shared, strategy-verifier | 4400 | existing shell entrypoint `node dist/main.js` |
| Intel | `apps/intel-api/Dockerfile` | `public.ecr.aws/docker/library/node:20.16.0-bookworm-slim` | shared, meriv2-core | 4300 | existing shell entrypoint `node dist/main.js` |

Core alone fixes build `NODE_OPTIONS=--max-old-space-size=4096`; this exact heap ceiling is not newly build-qualified here. All schemas retain built-in `prisma-client-js` with binary targets `["native", "linux-arm64-openssl-3.0.x"]`. Native-on-AMD64 generation is not ARM64 execution acceptance. Stock generation from the current four schemas previously passed with owned unmodified cached tool packages/native+ARM libraries; a clean image builder may still need normal binary downloads. A blocked engine download is a blocker, not permission to redirect engines or disable checksums.

Core/Workspace runtime validation RUN statements use `--network=none` sanitizer/leaf import expressions. Those exact expressions now pass under Node22.23.3 against retained published emitted code and full frozen/cache-bound dependencies. Strategy Planner and Intel Capture leaf imports pass under Node20.16.0. All four `main.js` syntax and shell entrypoint syntax checks pass. **No production-pruned tree, Bookworm container, ARM64 runtime or built-image acceptance is inferred.**

Strategy runtime installs Chromium/chromium-sandbox/fonts and sets the existing executable path; Intel installs ffmpeg. OpenSSL, ca-certificates and existing dumb-init/runtime requirements remain as the recipes specify. Workspace invokes its entrypoint through `/bin/sh`; Core/Strategy/Intel use the existing dumb-init chain. No new process, auth, permission or network layer is introduced.

## Proven production CLI correction

All four baseline manifests put `prisma` in devDependencies although their installed runtime migration entrypoints directly execute `node_modules/prisma/build/index.js`. Exact pnpm9.12 frozen link-only testing preserves that path after development install, then removes it after `--prod` while keeping `@prisma/client`. The minimal correction moves the existing `^5.20.0` declaration and locked `5.22.0` importer row to production dependencies for all four apps. Package/snapshot/integrity/settings data and all version resolutions remain unchanged. Corrected frozen `--prod` testing retains the direct CLI. Lifecycle scripts were skipped only in this synthetic dependency-link test: this is CLI-path acceptance, not generation/native/image/migration acceptance.

## Exact source-pinned builder commands (instructions only)

In a clean, authorized checkout of the **final reviewed published successor**, set task-specific source/tree values and verify them before sending repository-root context to the builder. Do not build from a mixed working copy or archive another repository's frontend source.

```sh
CAPIRO_BACKEND_RELEASE_SHA=<final-published-successor-head>
CAPIRO_BACKEND_RELEASE_TREE=<final-published-successor-tree>
test "$(git rev-parse HEAD)" = "$CAPIRO_BACKEND_RELEASE_SHA"
test "$(git rev-parse HEAD^{tree})" = "$CAPIRO_BACKEND_RELEASE_TREE"
```

Run existing Dockerfiles serially on an already qualified builder. For an ARM64 release artifact, use its normal supported ARM64 mechanism; for an explicitly AMD64 local check change only the platform and label that limited result. The following local OCI outputs do not publish to AWS or change a running service:

```sh
docker buildx build --platform linux/arm64 --progress=plain --provenance=true --metadata-file=/authorized/evidence/core.metadata.json --output=type=oci,dest=/authorized/evidence/core.oci.tar -f apps/api/Dockerfile -t "capiro-api:$CAPIRO_BACKEND_RELEASE_SHA" .
docker buildx build --platform linux/arm64 --progress=plain --provenance=true --metadata-file=/authorized/evidence/strategy.metadata.json --output=type=oci,dest=/authorized/evidence/strategy.oci.tar -f apps/api-strategy/Dockerfile -t "capiro-api-strategy:$CAPIRO_BACKEND_RELEASE_SHA" .
docker buildx build --platform linux/arm64 --progress=plain --provenance=true --metadata-file=/authorized/evidence/workspace.metadata.json --output=type=oci,dest=/authorized/evidence/workspace.oci.tar -f apps/workspace/Dockerfile -t "capiro-workspace:$CAPIRO_BACKEND_RELEASE_SHA" .
docker buildx build --platform linux/arm64 --progress=plain --provenance=true --metadata-file=/authorized/evidence/intel.metadata.json --output=type=oci,dest=/authorized/evidence/intel.oci.tar -f apps/intel-api/Dockerfile -t "capiro-intel-api:$CAPIRO_BACKEND_RELEASE_SHA" .
```

The source commit/tree and Dockerfile hashes are immutable. Existing base tags and Debian apt repositories are not digest/snapshot pinned; record resolved base digests, final image/artifact digests, platform and full build logs as actual build evidence. Image tags alone do not establish provenance. These commands do not merge main, push a registry image, replace the existing frontend/legacy Meri or run serve/migrate.

## Migration/startup remain separate

All four default to `serve`; their `migrate` branch is a separate explicit task and uses real database bindings. Baseline Core migrate also calls its workflow seed, Workspace/Strategy call compiled seeds, and Intel deploys migrations only. The parent owns separate reviewed legacy seed cleanup/migration/rollback instructions; use the final candidate's reconciled runbook, not this baseline's seed behavior. No migration, seed, ledger recovery or live test runs are authorized by this build handoff. Ordinary login/tenant permissions and existing background ownership/action/callback controls remain unchanged; source/DI checks do not establish matching live schema, ownership, credentials, HTTP readiness or owned-account browser-flow acceptance.
