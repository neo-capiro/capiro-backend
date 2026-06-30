# Capiro MeriV2 Orchestrator container.
#
# Build context: REPOSITORY ROOT (not apps/meriv2-orchestrator).
#   docker buildx build --platform linux/arm64 \
#     -f apps/meriv2-orchestrator/Dockerfile -t capiro-meriv2-orchestrator:local --push .
#
# Mirrors apps/workspace/Dockerfile. The orchestrator imports `@prisma/client`
# generated from apps/api/prisma/schema.prisma (shared DB, shared client — no
# duplicated schema), so the build copies the api Prisma schema and runs
# `prisma generate` before the Nest build.
#
# Prod Fargate is ARM64 — always build linux/arm64 (buildx) or the task won't pull.

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
COPY apps/meriv2-orchestrator/package.json apps/meriv2-orchestrator/package.json
COPY packages/meriv2-core/package.json packages/meriv2-core/package.json
COPY packages/shared/package.json packages/shared/package.json
# api manifest + prisma schema are needed only to generate the shared client.
COPY apps/api/package.json apps/api/package.json
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile \
      --filter=@capiro/meriv2-orchestrator... \
      --filter=@capiro/meriv2-core... \
      --filter=@capiro/shared...

COPY packages/shared/src packages/shared/src
COPY packages/shared/tsconfig.json packages/shared/tsconfig.json
COPY packages/meriv2-core/src packages/meriv2-core/src
COPY packages/meriv2-core/tsconfig.json packages/meriv2-core/tsconfig.json
COPY apps/api/prisma apps/api/prisma
COPY apps/meriv2-orchestrator/src apps/meriv2-orchestrator/src
COPY apps/meriv2-orchestrator/tsconfig.json apps/meriv2-orchestrator/tsconfig.build.json apps/meriv2-orchestrator/nest-cli.json apps/meriv2-orchestrator/

RUN pnpm --filter @capiro/shared build
RUN pnpm --filter @capiro/meriv2-core build
# Generate the @prisma/client the orchestrator imports, from the api schema.
RUN cd apps/meriv2-orchestrator && pnpm exec prisma generate --schema ../api/prisma/schema.prisma
RUN pnpm --filter @capiro/meriv2-orchestrator build

RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod \
      --filter=@capiro/meriv2-orchestrator... \
      --filter=@capiro/meriv2-core... \
      --filter=@capiro/shared...

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
COPY --chown=capiro:capiro --from=build /workspace/packages/meriv2-core/dist /app/packages/meriv2-core/dist
COPY --chown=capiro:capiro --from=build /workspace/packages/meriv2-core/package.json /app/packages/meriv2-core/package.json
COPY --chown=capiro:capiro --from=build /workspace/apps/meriv2-orchestrator/dist /app/apps/meriv2-orchestrator/dist
COPY --chown=capiro:capiro --from=build /workspace/apps/meriv2-orchestrator/node_modules /app/apps/meriv2-orchestrator/node_modules
COPY --chown=capiro:capiro --from=build /workspace/apps/meriv2-orchestrator/package.json /app/apps/meriv2-orchestrator/package.json
COPY --chown=capiro:capiro --from=build /workspace/tsconfig.base.json /app/tsconfig.base.json
COPY --chown=capiro:capiro apps/meriv2-orchestrator/scripts/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

USER capiro
WORKDIR /app/apps/meriv2-orchestrator
EXPOSE 4300
ENTRYPOINT ["/usr/bin/dumb-init", "--", "/usr/local/bin/entrypoint.sh"]
CMD ["serve"]
