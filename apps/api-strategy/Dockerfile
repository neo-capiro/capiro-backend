# Capiro Strategy API (api-strategy) container.
#
# Build context: REPOSITORY ROOT (not apps/api-strategy).
#   docker buildx build --platform linux/arm64 -f apps/api-strategy/Dockerfile -t capiro-api-strategy:local --push .
#
# Multi-stage:
#   1. base    pnpm + corepack on slim node
#   2. build   install + generate Prisma client + compile, then `pnpm prune --prod` in place
#   3. runtime minimal node slim, non-root user, copies the pruned workspace
#
# Mirrors apps/workspace's Dockerfile (the closest separate-service precedent),
# minus @capiro/shared and @capiro/meriv2-core (api-strategy depends only on
# @capiro/auth at Phase-1 scope). openssl is installed so Prisma's binary engine
# resolves on bookworm's OpenSSL 3.

ARG NODE_VERSION=20.16.0

# -------- base ----------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /workspace

# -------- build ---------------------------------------------------------------
FROM base AS build
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* tsconfig.base.json ./
COPY apps/api-strategy/package.json apps/api-strategy/package.json
COPY packages/auth/package.json packages/auth/package.json
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter=@capiro/api-strategy... --filter=@capiro/auth...

COPY packages/auth/src packages/auth/src
COPY packages/auth/tsconfig.json packages/auth/tsconfig.json
COPY apps/api-strategy/src apps/api-strategy/src
COPY apps/api-strategy/prisma apps/api-strategy/prisma
COPY apps/api-strategy/tsconfig.json apps/api-strategy/tsconfig.build.json apps/api-strategy/nest-cli.json apps/api-strategy/

RUN pnpm --filter @capiro/auth build
# Generate the Prisma client (outputs to apps/api-strategy/generated/prisma-client)
# BEFORE the Nest build, since src imports the generated client.
RUN cd apps/api-strategy && pnpm exec prisma generate
RUN pnpm --filter @capiro/api-strategy build

# Prune dev dependencies in place (keeps the .pnpm store intact for the
# generated Prisma client).
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --filter=@capiro/api-strategy... --filter=@capiro/auth...

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

# Copy the entire workspace's pnpm-symlinked node_modules + the compiled dist.
COPY --chown=capiro:capiro --from=build /workspace/node_modules /app/node_modules
# @capiro/auth (shared Clerk guard): dist + manifest + its OWN node_modules —
# root /app/node_modules/@capiro/auth is a pnpm symlink to here, and
# packages/auth/dist require()s @nestjs/common / @clerk/backend from its own
# node_modules (pnpm doesn't hoist). Without these three the service crashes at
# boot with "Cannot find module '@capiro/auth'".
COPY --chown=capiro:capiro --from=build /workspace/packages/auth/dist /app/packages/auth/dist
COPY --chown=capiro:capiro --from=build /workspace/packages/auth/package.json /app/packages/auth/package.json
COPY --chown=capiro:capiro --from=build /workspace/packages/auth/node_modules /app/packages/auth/node_modules
COPY --chown=capiro:capiro --from=build /workspace/apps/api-strategy/dist /app/apps/api-strategy/dist
COPY --chown=capiro:capiro --from=build /workspace/apps/api-strategy/node_modules /app/apps/api-strategy/node_modules
COPY --chown=capiro:capiro --from=build /workspace/apps/api-strategy/package.json /app/apps/api-strategy/package.json
# Generated Prisma client + schema + migrations (the migrate verb runs
# `prisma migrate deploy` against prisma/migrations at task launch).
COPY --chown=capiro:capiro --from=build /workspace/apps/api-strategy/generated /app/apps/api-strategy/generated
COPY --chown=capiro:capiro --from=build /workspace/apps/api-strategy/prisma /app/apps/api-strategy/prisma
COPY --chown=capiro:capiro --from=build /workspace/tsconfig.base.json /app/tsconfig.base.json
COPY --chown=capiro:capiro --from=build /workspace/apps/api-strategy/tsconfig.json /app/apps/api-strategy/tsconfig.json
COPY --chown=capiro:capiro apps/api-strategy/scripts/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

USER capiro
WORKDIR /app/apps/api-strategy
EXPOSE 4400
ENTRYPOINT ["/usr/bin/dumb-init", "--", "/usr/local/bin/entrypoint.sh"]
CMD ["serve"]
