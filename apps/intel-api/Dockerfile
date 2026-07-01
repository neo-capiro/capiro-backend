# Capiro Intel API container.
#
# Build context: REPOSITORY ROOT (not apps/intel-api).
#   docker buildx build --platform linux/arm64 -f apps/intel-api/Dockerfile -t capiro-intel-api:local --push .
#
# Multi-stage, mirroring apps/workspace:
#   1. base    pnpm + corepack on slim node
#   2. build   install + prisma generate + compile, then prune dev deps in place
#   3. runtime minimal node slim, non-root user, copies the pruned workspace
#
# Owns intel_* tables; the `migrate` mode runs `prisma migrate deploy` at task
# launch (forward-only), same pattern as apps/api and apps/workspace.

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
COPY apps/intel-api/package.json apps/intel-api/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter=@capiro/intel-api... --filter=@capiro/shared...

COPY packages/shared/src packages/shared/src
COPY packages/shared/tsconfig.json packages/shared/tsconfig.json
COPY apps/intel-api/src apps/intel-api/src
COPY apps/intel-api/prisma apps/intel-api/prisma
COPY apps/intel-api/tsconfig.json apps/intel-api/tsconfig.build.json apps/intel-api/nest-cli.json apps/intel-api/

RUN pnpm --filter @capiro/shared build
# Generate the Prisma client (outputs to apps/intel-api/generated/prisma-client)
# BEFORE the Nest build, since src imports the generated client.
RUN cd apps/intel-api && pnpm exec prisma generate
RUN pnpm --filter @capiro/intel-api build

# Prune dev dependencies in place (keeps the .pnpm store intact for the
# generated Prisma client).
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --filter=@capiro/intel-api... --filter=@capiro/shared...

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

COPY --chown=capiro:capiro --from=build /workspace/node_modules /app/node_modules
COPY --chown=capiro:capiro --from=build /workspace/packages/shared/dist /app/packages/shared/dist
COPY --chown=capiro:capiro --from=build /workspace/packages/shared/package.json /app/packages/shared/package.json
COPY --chown=capiro:capiro --from=build /workspace/apps/intel-api/dist /app/apps/intel-api/dist
COPY --chown=capiro:capiro --from=build /workspace/apps/intel-api/node_modules /app/apps/intel-api/node_modules
COPY --chown=capiro:capiro --from=build /workspace/apps/intel-api/package.json /app/apps/intel-api/package.json
COPY --chown=capiro:capiro --from=build /workspace/apps/intel-api/generated /app/apps/intel-api/generated
COPY --chown=capiro:capiro --from=build /workspace/apps/intel-api/prisma /app/apps/intel-api/prisma
COPY --chown=capiro:capiro --from=build /workspace/tsconfig.base.json /app/tsconfig.base.json
COPY --chown=capiro:capiro --from=build /workspace/apps/intel-api/tsconfig.json /app/apps/intel-api/tsconfig.json
COPY --chown=capiro:capiro apps/intel-api/scripts/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

USER capiro
WORKDIR /app/apps/intel-api
EXPOSE 4300
ENTRYPOINT ["/usr/bin/dumb-init", "--", "/usr/local/bin/entrypoint.sh"]
CMD ["serve"]
