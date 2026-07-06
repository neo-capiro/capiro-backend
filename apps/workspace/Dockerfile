# Capiro Workspace container.
#
# Build context: REPOSITORY ROOT (not apps/workspace).
#   docker buildx build --platform linux/arm64 -f apps/workspace/Dockerfile -t capiro-workspace:local --push .
#
# Multi-stage:
#   1. base    pnpm + corepack on slim node
#   2. build   install + compile, then `pnpm prune --prod` in place
#   3. runtime minimal node slim, non-root user, copies the pruned workspace
#
# Why we DON'T use `pnpm deploy`: mirrors the apps/api decision — pnpm deploy
# does not carry pnpm's symlinked store layout, which downstream additions
# (Prisma client in Phase 2) rely on. Prune dev deps in place and copy the
# whole workspace.
#
# Phase 1: no Prisma yet. openssl is installed so Phase 2 can drop in
# `prisma generate` without touching the runtime stage.

ARG NODE_VERSION=20.16.0

# -------- base ----------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /workspace

# -------- build ---------------------------------------------------------------
FROM base AS build
# openssl is kept Prisma-ready for Phase 2; bookworm ships OpenSSL 3 but
# Prisma's binary engine cannot detect it without the package present.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* tsconfig.base.json ./
COPY apps/workspace/package.json apps/workspace/package.json
COPY packages/auth/package.json packages/auth/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter=@capiro/workspace... --filter=@capiro/auth... --filter=@capiro/shared...

COPY packages/shared/src packages/shared/src
COPY packages/shared/tsconfig.json packages/shared/tsconfig.json
COPY packages/auth/src packages/auth/src
COPY packages/auth/tsconfig.json packages/auth/tsconfig.json
COPY apps/workspace/src apps/workspace/src
COPY apps/workspace/prisma apps/workspace/prisma
COPY apps/workspace/tsconfig.json apps/workspace/tsconfig.build.json apps/workspace/nest-cli.json apps/workspace/

RUN pnpm --filter @capiro/shared build
RUN pnpm --filter @capiro/auth build
# Generate the Prisma client (outputs to apps/workspace/generated/prisma-client)
# BEFORE the Nest build, since src imports the generated client.
RUN cd apps/workspace && pnpm exec prisma generate
RUN pnpm --filter @capiro/workspace build

# Prune dev dependencies in place (matches the apps/api pattern; keeps the
# .pnpm store intact for Phase 2's generated Prisma client).
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --filter=@capiro/workspace... --filter=@capiro/auth... --filter=@capiro/shared...

# -------- runtime -------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ENV NODE_ENV=production
ENV NODE_OPTIONS=--enable-source-maps
RUN groupadd --system --gid 1001 capiro \
 && useradd --system --uid 1001 --gid capiro --shell /usr/sbin/nologin capiro \
 && apt-get update \
 && apt-get install -y --no-install-recommends wget ca-certificates dumb-init openssl \
 && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /app/tmp /tmp \
 && chmod 1777 /tmp \
 && chown capiro:capiro /app/tmp
ENV TMPDIR=/app/tmp
WORKDIR /app

# Copy the entire workspace, pnpm's symlinked node_modules + the compiled
# workspace dist. Larger image (~250MB) but reliable.
COPY --chown=capiro:capiro --from=build /workspace/node_modules /app/node_modules
COPY --chown=capiro:capiro --from=build /workspace/packages/shared/dist /app/packages/shared/dist
COPY --chown=capiro:capiro --from=build /workspace/packages/shared/package.json /app/packages/shared/package.json
# @capiro/auth (Option N shared guard): dist + manifest + its OWN node_modules
# — root /app/node_modules/@capiro/auth is a pnpm symlink to here, and
# packages/auth/dist requires @nestjs/common / @clerk/backend from its own
# node_modules (pnpm doesn't hoist). Without these three the workspace crashes
# at boot with "Cannot find module '@capiro/auth'".
COPY --chown=capiro:capiro --from=build /workspace/packages/auth/dist /app/packages/auth/dist
COPY --chown=capiro:capiro --from=build /workspace/packages/auth/package.json /app/packages/auth/package.json
COPY --chown=capiro:capiro --from=build /workspace/packages/auth/node_modules /app/packages/auth/node_modules
COPY --chown=capiro:capiro --from=build /workspace/apps/workspace/dist /app/apps/workspace/dist
COPY --chown=capiro:capiro --from=build /workspace/apps/workspace/node_modules /app/apps/workspace/node_modules
COPY --chown=capiro:capiro --from=build /workspace/apps/workspace/package.json /app/apps/workspace/package.json
# Generated Prisma client + schema + migrations (the migrate verb runs
# `prisma migrate deploy` against prisma/migrations at task launch).
COPY --chown=capiro:capiro --from=build /workspace/apps/workspace/generated /app/apps/workspace/generated
COPY --chown=capiro:capiro --from=build /workspace/apps/workspace/prisma /app/apps/workspace/prisma
COPY --chown=capiro:capiro --from=build /workspace/tsconfig.base.json /app/tsconfig.base.json
COPY --chown=capiro:capiro --from=build /workspace/apps/workspace/tsconfig.json /app/apps/workspace/tsconfig.json
COPY --chown=capiro:capiro apps/workspace/scripts/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

USER capiro
WORKDIR /app/apps/workspace
EXPOSE 4200
ENTRYPOINT ["/usr/bin/dumb-init", "--", "/usr/local/bin/entrypoint.sh"]
CMD ["serve"]
