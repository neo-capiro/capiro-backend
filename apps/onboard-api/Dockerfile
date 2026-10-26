# Capiro Onboard API container (API + onboard-web SPA in one image).
#
# Build context: REPOSITORY ROOT (not apps/onboard-api).
#   docker buildx build --platform linux/arm64 -f apps/onboard-api/Dockerfile -t capiro-onboard-api:local .
#
# Multi-stage build:
#   1. base    pnpm + corepack on Alpine node
#   2. build   install + prisma generate + compile API + build the SPA
#   3. prod-deps fresh frozen production install, including the migration CLI
#   4. runtime Alpine node, non-root user
#
# Owns onboard_* tables; the `migrate` mode runs `prisma migrate deploy` at
# task launch (forward-only), same pattern as apps/api and apps/intel-api.

# Official Node Alpine preview candidate, pinned to the qualified image index.
# Upstream ARM64 musl builds are not tested before release; retain ARM64 image qualification.

# -------- base ----------------------------------------------------------------
FROM docker.io/library/node:24.22.1-alpine3.24@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /workspace

# -------- build ---------------------------------------------------------------
FROM base AS build
RUN apk add --no-cache openssl ca-certificates

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

# -------- prod-deps -----------------------------------------------------------
# A fresh stage cannot retain the build store when pnpm requests confirmation
# to replace an existing install. The generated native client stays in build.
FROM base AS prod-deps
RUN apk add --no-cache openssl ca-certificates
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/onboard-api/package.json apps/onboard-api/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/auth/package.json packages/auth/package.json
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    CI=true pnpm install --frozen-lockfile --prod \
      --filter=@capiro/onboard-api... --filter=@capiro/shared... --filter=@capiro/auth...

# -------- runtime -------------------------------------------------------------
FROM docker.io/library/node:24.22.1-alpine3.24@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS runtime
ENV NODE_ENV=production
ENV NODE_OPTIONS=--enable-source-maps
RUN apk add --no-cache ca-certificates dumb-init openssl zlib \
 && addgroup -S -g 1001 capiro \
 && adduser -S -D -H -u 1001 -G capiro -s /sbin/nologin capiro
# Entrypoint modes invoke node directly, including Prisma migrate. Runtime
# package managers and their own dependencies are not part of that closure.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-* \
 && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
    /usr/local/bin/yarn /usr/local/bin/yarnpkg /usr/local/bin/pnpm /usr/local/bin/pnpx
RUN mkdir -p /app/tmp /tmp \
 && chmod 1777 /tmp \
 && chown capiro:capiro /app/tmp
ENV TMPDIR=/app/tmp
WORKDIR /app

COPY --chown=capiro:capiro --from=prod-deps /workspace/node_modules /app/node_modules
COPY --chown=capiro:capiro --from=build /workspace/packages/shared/dist /app/packages/shared/dist
COPY --chown=capiro:capiro --from=build /workspace/packages/shared/package.json /app/packages/shared/package.json
COPY --chown=capiro:capiro --from=build /workspace/packages/auth/dist /app/packages/auth/dist
COPY --chown=capiro:capiro --from=build /workspace/packages/auth/package.json /app/packages/auth/package.json
# @capiro/auth is consumed UNBUNDLED (nest build, not the orchestrator's
# webpack) — its dist resolves @nestjs/*+@clerk/backend through its own pnpm
# symlink dir, which must ship or the service dies at boot (MODULE_NOT_FOUND).
COPY --chown=capiro:capiro --from=prod-deps /workspace/packages/auth/node_modules /app/packages/auth/node_modules
COPY --chown=capiro:capiro --from=build /workspace/apps/onboard-api/dist /app/apps/onboard-api/dist
COPY --chown=capiro:capiro --from=prod-deps /workspace/apps/onboard-api/node_modules /app/apps/onboard-api/node_modules
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
