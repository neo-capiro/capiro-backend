# Capiro Onboard API container (API + onboard-web SPA in one image).
#
# Build context: REPOSITORY ROOT (not apps/onboard-api).
#   docker buildx build --platform linux/arm64 -f apps/onboard-api/Dockerfile -t capiro-onboard-api:local .
#
# Multi-stage, mirroring apps/intel-api:
#   1. base    pnpm + corepack on slim node
#   2. build   install + prisma generate + compile API + build the SPA,
#              then prune dev deps in place
#   3. runtime minimal node slim, non-root user, copies the pruned workspace
#
# Owns onboard_* tables; the `migrate` mode runs `prisma migrate deploy` at
# task launch (forward-only), same pattern as apps/api and apps/intel-api.

ARG NODE_VERSION=20.16.0

# Base image is pulled from AWS's ECR Public Docker Hub mirror to avoid Docker
# Hub's anonymous pull rate limit. Functionally identical to node:<tag>-bookworm-slim.

# -------- base ----------------------------------------------------------------
FROM public.ecr.aws/docker/library/node:${NODE_VERSION}-bookworm-slim AS base
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
COPY apps/onboard-api/package.json apps/onboard-api/package.json
COPY apps/onboard-web/package.json apps/onboard-web/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/auth/package.json packages/auth/package.json
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile \
      --filter=@capiro/onboard-api... --filter=@capiro/onboard-web... \
      --filter=@capiro/shared... --filter=@capiro/auth...

COPY packages/shared/src packages/shared/src
COPY packages/shared/tsconfig.json packages/shared/tsconfig.json
COPY packages/auth/src packages/auth/src
COPY packages/auth/tsconfig.json packages/auth/tsconfig.json
COPY apps/onboard-api/src apps/onboard-api/src
COPY apps/onboard-api/prisma apps/onboard-api/prisma
COPY apps/onboard-api/tsconfig.json apps/onboard-api/tsconfig.build.json apps/onboard-api/nest-cli.json apps/onboard-api/
COPY apps/onboard-web apps/onboard-web

RUN pnpm --filter @capiro/shared build
RUN pnpm --filter @capiro/auth build
# Generate the Prisma client (outputs to apps/onboard-api/generated/prisma-client)
# BEFORE the Nest build, since src imports the generated client.
RUN cd apps/onboard-api && pnpm exec prisma generate
RUN pnpm --filter @capiro/onboard-api build
RUN pnpm --filter @capiro/onboard-web build

# Prune dev dependencies in place (keeps the .pnpm store intact for the
# generated Prisma client).
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod \
      --filter=@capiro/onboard-api... --filter=@capiro/shared... --filter=@capiro/auth...

# -------- runtime -------------------------------------------------------------
FROM public.ecr.aws/docker/library/node:${NODE_VERSION}-bookworm-slim AS runtime
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
COPY --chown=capiro:capiro --from=build /workspace/packages/auth/dist /app/packages/auth/dist
COPY --chown=capiro:capiro --from=build /workspace/packages/auth/package.json /app/packages/auth/package.json
COPY --chown=capiro:capiro --from=build /workspace/apps/onboard-api/dist /app/apps/onboard-api/dist
COPY --chown=capiro:capiro --from=build /workspace/apps/onboard-api/node_modules /app/apps/onboard-api/node_modules
COPY --chown=capiro:capiro --from=build /workspace/apps/onboard-api/package.json /app/apps/onboard-api/package.json
COPY --chown=capiro:capiro --from=build /workspace/apps/onboard-api/generated /app/apps/onboard-api/generated
COPY --chown=capiro:capiro --from=build /workspace/apps/onboard-api/prisma /app/apps/onboard-api/prisma
COPY --chown=capiro:capiro --from=build /workspace/apps/onboard-web/dist /app/apps/onboard-web/dist
COPY --chown=capiro:capiro --from=build /workspace/tsconfig.base.json /app/tsconfig.base.json
COPY --chown=capiro:capiro --from=build /workspace/apps/onboard-api/tsconfig.json /app/apps/onboard-api/tsconfig.json
COPY --chown=capiro:capiro apps/onboard-api/scripts/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

USER capiro
WORKDIR /app/apps/onboard-api
EXPOSE 4400
ENTRYPOINT ["/usr/bin/dumb-init", "--", "/usr/local/bin/entrypoint.sh"]
CMD ["serve"]
