# Capiro defense-api dark-service image.
# Build context: repository root.
#
# Important: after `pnpm install`, copy only source + tsconfig for each package —
# never `COPY packages/<name> packages/<name>` wholesale. A full-directory copy
# overwrites the per-package node_modules pnpm just created (or collides with a
# hoisted layout). The main API Dockerfile uses the same src/tsconfig-only pattern.
ARG NODE_VERSION=20.16.0

FROM public.ecr.aws/docker/library/node:${NODE_VERSION}-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# Prefer hardlinks/copy over deep host-path symlinks inside BuildKit cache mounts.
# On Docker Desktop for Windows, default store symlinks have been observed to bake
# unreachable host paths into the install graph (tsc MODULE_NOT_FOUND).
ENV PNPM_PACKAGE_IMPORT_METHOD=copy
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /workspace

FROM base AS build
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* tsconfig.base.json ./

# pnpm install --frozen-lockfile validates the lockfile against every project
# pnpm-workspace.yaml's globs (apps/*, packages/*, infra/*) can discover, not
# just the ones --filter will actually build below. Every workspace member's
# package.json has to be present for the lockfile to validate correctly.
COPY apps/api-strategy/package.json apps/api-strategy/package.json
COPY apps/api/package.json apps/api/package.json
COPY apps/clio-sandbox/package.json apps/clio-sandbox/package.json
COPY apps/defense-api/package.json apps/defense-api/package.json
COPY apps/intel-api/package.json apps/intel-api/package.json
COPY apps/meriv2-orchestrator/package.json apps/meriv2-orchestrator/package.json
COPY apps/onboard-api/package.json apps/onboard-api/package.json
COPY apps/onboard-web/package.json apps/onboard-web/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/workspace/package.json apps/workspace/package.json
COPY packages/auth/package.json packages/auth/package.json
COPY packages/defense-client/package.json packages/defense-client/package.json
COPY packages/defense-contracts/package.json packages/defense-contracts/package.json
COPY packages/defense-domain/package.json packages/defense-domain/package.json
COPY packages/meriv2-core/package.json packages/meriv2-core/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/strategy-verifier/package.json packages/strategy-verifier/package.json
COPY infra/cdk/package.json infra/cdk/package.json

# Isolated cache mount id so defense-api installs never share a host-contaminated
# pnpm store with other Windows Desktop builds.
RUN --mount=type=cache,id=pnpm-defense-api,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter=@capiro/defense-api...

# Source only — preserve install-time node_modules under each package.
COPY packages/shared/src packages/shared/src
COPY packages/shared/tsconfig.json packages/shared/tsconfig.json
COPY packages/auth/src packages/auth/src
COPY packages/auth/tsconfig.json packages/auth/tsconfig.json
COPY packages/defense-contracts/src packages/defense-contracts/src
COPY packages/defense-contracts/tsconfig.json packages/defense-contracts/tsconfig.json
COPY packages/defense-domain/src packages/defense-domain/src
COPY packages/defense-domain/tsconfig.json packages/defense-domain/tsconfig.json
COPY packages/defense-client/src packages/defense-client/src
COPY packages/defense-client/tsconfig.json packages/defense-client/tsconfig.json
COPY apps/defense-api/src apps/defense-api/src
COPY apps/defense-api/tsconfig.json apps/defense-api/tsconfig.json
COPY apps/defense-api/nest-cli.json apps/defense-api/nest-cli.json
COPY apps/defense-api/prisma apps/defense-api/prisma
COPY apps/defense-api/scripts apps/defense-api/scripts
COPY apps/defense-api/package.json apps/defense-api/package.json

# @capiro/shared MUST build before @capiro/defense-domain: defense-domain's
# pe-read module imports the funding-claim / money primitives from it, and with no
# packages/shared/dist present those types resolve to nothing (tsc reports missing
# properties on the derived interfaces) rather than failing at the import line.
RUN pnpm --filter @capiro/shared build \
 && pnpm --filter @capiro/auth build \
 && pnpm --filter @capiro/defense-contracts build \
 && pnpm --filter @capiro/defense-domain build \
 && pnpm --filter @capiro/defense-client build \
 && pnpm --filter @capiro/defense-api prisma:generate \
 && pnpm --filter @capiro/defense-api build

RUN --mount=type=cache,id=pnpm-defense-api,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --filter=@capiro/defense-api...

FROM public.ecr.aws/docker/library/node:${NODE_VERSION}-bookworm-slim AS runtime
ENV NODE_ENV=production
ENV NODE_OPTIONS=--enable-source-maps
RUN groupadd --system --gid 1001 capiro \
 && useradd --system --uid 1001 --gid capiro --shell /usr/sbin/nologin capiro \
 && apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates dumb-init openssl \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --chown=capiro:capiro --from=build /workspace/node_modules /app/node_modules
COPY --chown=capiro:capiro --from=build /workspace/apps/defense-api/dist /app/apps/defense-api/dist
COPY --chown=capiro:capiro --from=build /workspace/apps/defense-api/generated /app/apps/defense-api/generated
COPY --chown=capiro:capiro --from=build /workspace/apps/defense-api/node_modules /app/apps/defense-api/node_modules
COPY --chown=capiro:capiro --from=build /workspace/apps/defense-api/package.json /app/apps/defense-api/package.json
COPY --chown=capiro:capiro --from=build /workspace/apps/defense-api/prisma /app/apps/defense-api/prisma
COPY --chown=capiro:capiro --from=build /workspace/apps/defense-api/scripts /app/apps/defense-api/scripts

COPY --chown=capiro:capiro --from=build /workspace/packages/shared/dist /app/packages/shared/dist
COPY --chown=capiro:capiro --from=build /workspace/packages/shared/package.json /app/packages/shared/package.json
COPY --chown=capiro:capiro --from=build /workspace/packages/auth/dist /app/packages/auth/dist
COPY --chown=capiro:capiro --from=build /workspace/packages/auth/node_modules /app/packages/auth/node_modules
COPY --chown=capiro:capiro --from=build /workspace/packages/auth/package.json /app/packages/auth/package.json
COPY --chown=capiro:capiro --from=build /workspace/packages/defense-contracts/dist /app/packages/defense-contracts/dist
COPY --chown=capiro:capiro --from=build /workspace/packages/defense-contracts/package.json /app/packages/defense-contracts/package.json
COPY --chown=capiro:capiro --from=build /workspace/packages/defense-domain/dist /app/packages/defense-domain/dist
COPY --chown=capiro:capiro --from=build /workspace/packages/defense-domain/package.json /app/packages/defense-domain/package.json
# defense-domain has RUNTIME dependencies of its own now (@capiro/shared for the
# money/funding-claim primitives, simple-statistics for the conference forecast), so
# its node_modules link farm must ship too — as auth's already does. Without it the
# image builds and starts far enough to load main.js, then dies on the first
# `require('@capiro/shared')` from pe-read.
COPY --chown=capiro:capiro --from=build /workspace/packages/defense-domain/node_modules /app/packages/defense-domain/node_modules
COPY --chown=capiro:capiro --from=build /workspace/packages/defense-client/dist /app/packages/defense-client/dist
COPY --chown=capiro:capiro --from=build /workspace/packages/defense-client/package.json /app/packages/defense-client/package.json

USER capiro
WORKDIR /app/apps/defense-api
EXPOSE 4400
ENTRYPOINT ["/usr/bin/dumb-init", "--", "bash", "scripts/entrypoint.sh"]
CMD ["serve"]
