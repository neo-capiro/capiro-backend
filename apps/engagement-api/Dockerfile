# Capiro engagement-api container.
#
# Build context: REPOSITORY ROOT (not apps/engagement-api).
#   docker build -f apps/engagement-api/Dockerfile -t capiro-engagement-api:phase1-local .
#
# Multi-stage, mirroring apps/api/Dockerfile:
#   1. base    pnpm + corepack on slim node
#   2. build   install + compile, then `pnpm prune --prod` in place
#   3. runtime minimal node slim, non-root user, copies the pruned workspace
#
# The engagement-api image runs the SAME compiled source as the main API
# (dist/engagement-main.js) but with a serve-only entrypoint that refuses
# migrations and unknown verbs. It never owns database migrations.

ARG NODE_VERSION=20.16.0

# -------- base ----------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /workspace

# -------- build ---------------------------------------------------------------
FROM base AS build
# Prisma's binary engine wants libssl. Bookworm ships OpenSSL 3 but Prisma
# can't detect it without the package present.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/meriv2-core/package.json packages/meriv2-core/package.json
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter=@capiro/api... --filter=@capiro/shared... --filter=@capiro/meriv2-core...

COPY packages/shared/src packages/shared/src
COPY packages/shared/tsconfig.json packages/shared/tsconfig.json
COPY packages/meriv2-core/src packages/meriv2-core/src
COPY packages/meriv2-core/tsconfig.json packages/meriv2-core/tsconfig.json
COPY apps/api/src apps/api/src
COPY apps/api/tsconfig.json apps/api/tsconfig.build.json apps/api/nest-cli.json apps/api/
COPY apps/api/prisma apps/api/prisma
# Only the DB URL helper is needed by the engagement-api entrypoint.
# Do NOT copy all of apps/api/scripts (no sync-*/diag-* needed).
COPY apps/api/scripts/lib/pe-compose-database-url.js apps/api/scripts/lib/pe-compose-database-url.js

RUN pnpm --filter @capiro/shared build
RUN pnpm --filter @capiro/meriv2-core build
RUN pnpm --filter @capiro/api exec prisma generate
RUN pnpm --filter @capiro/api build

# Prune dev dependencies in place (keeps the .pnpm store with the generated
# Prisma client intact).
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --filter=@capiro/api... --filter=@capiro/shared... --filter=@capiro/meriv2-core...

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

# Copy the entire workspace, pnpm's symlinked node_modules + the generated
# Prisma client + the compiled API. Same layout as the main API image.
COPY --chown=capiro:capiro --from=build /workspace/node_modules /app/node_modules
COPY --chown=capiro:capiro --from=build /workspace/packages/shared/dist /app/packages/shared/dist
COPY --chown=capiro:capiro --from=build /workspace/packages/shared/package.json /app/packages/shared/package.json
COPY --chown=capiro:capiro --from=build /workspace/packages/meriv2-core/dist /app/packages/meriv2-core/dist
COPY --chown=capiro:capiro --from=build /workspace/packages/meriv2-core/package.json /app/packages/meriv2-core/package.json
# meriv2-core has workspace deps of its own — copy its node_modules or the API
# crashloops at boot with MODULE_NOT_FOUND '@capiro/shared'.
COPY --chown=capiro:capiro --from=build /workspace/packages/meriv2-core/node_modules /app/packages/meriv2-core/node_modules
COPY --chown=capiro:capiro --from=build /workspace/apps/api/dist /app/apps/api/dist
COPY --chown=capiro:capiro --from=build /workspace/apps/api/node_modules /app/apps/api/node_modules
COPY --chown=capiro:capiro --from=build /workspace/apps/api/prisma /app/apps/api/prisma
COPY --chown=capiro:capiro --from=build /workspace/apps/api/package.json /app/apps/api/package.json
# The DB URL helper used by the entrypoint.
COPY --chown=capiro:capiro --from=build /workspace/apps/api/scripts/lib/pe-compose-database-url.js /app/apps/api/scripts/lib/pe-compose-database-url.js
# tsx is NOT needed in the engagement-api image (serve-only; no sync-* or
# diag-* scripts). Do NOT copy apps/api/scripts or apps/api/src.

COPY --chown=capiro:capiro apps/engagement-api/scripts/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 0755 /usr/local/bin/entrypoint.sh

USER capiro
WORKDIR /app/apps/api
EXPOSE 4500
ENTRYPOINT ["/usr/bin/dumb-init", "--", "/usr/local/bin/entrypoint.sh"]
CMD ["serve"]
