# Capiro Web container.
#
#   docker buildx build --platform linux/arm64 -f apps/web/Dockerfile -t capiro-web:local --push .
#
# Multi-stage:
#   1. base    pnpm + corepack
#   2. build   install + vite build → dist/ static SPA
#   3. runtime nginx-unprivileged on port 8080, runtime-config.js generated at boot
#
# Runtime config (Clerk publishable key, API base URL) is injected at container
# start by entrypoint.sh, so the same image promotes through environments.

ARG NODE_VERSION=20.16.0
ARG NGINX_VERSION=1.27.1-alpine

# -------- base ----------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /workspace

# -------- build ---------------------------------------------------------------
FROM base AS build
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* tsconfig.base.json ./
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter=@capiro/web... --filter=@capiro/shared...

COPY packages/shared/src packages/shared/src
COPY packages/shared/tsconfig.json packages/shared/tsconfig.json
COPY apps/web/src apps/web/src
COPY apps/web/public apps/web/public
COPY apps/web/index.html apps/web/vite.config.ts apps/web/tsconfig.json apps/web/

RUN pnpm --filter @capiro/shared build
# Cache-bust: GIT_SHA changes every commit, so the vite build layer below can
# never be restored stale from the GHA build cache. Without this, buildx's
# cache-from=gha was reusing a frozen dist/ across commits and shipping an old
# SPA bundle even though the image digest changed. Declared right before the
# build so only the build (and copy) layers invalidate, not the dep install.
ARG GIT_SHA=dev
RUN echo "build for ${GIT_SHA}" > /workspace/.git_sha
# Build with placeholder values; the real keys come from runtime-config.js
# generated at container start. env.ts ignores VITE_* when window.__CAPIRO_CONFIG__ is set.
# NODE_OPTIONS: Rollup's chunk rendering for this app's heavy viz deps
# (maplibre-gl, cytoscape, recharts, xyflow) has hit V8's default heap
# ceiling under concurrent arm64/qemu builds on the shared build host
# ("Ineffective mark-compacts near heap limit", SIGABRT) even though tsc
# and module transform both succeeded.
RUN NODE_OPTIONS=--max-old-space-size=6144 \
    VITE_CLERK_PUBLISHABLE_KEY=runtime VITE_API_BASE_URL=runtime \
    pnpm --filter @capiro/web build

# -------- runtime -------------------------------------------------------------
FROM nginxinc/nginx-unprivileged:${NGINX_VERSION} AS runtime
USER root
RUN apk add --no-cache wget ca-certificates
COPY apps/web/nginx/nginx.conf /etc/nginx/nginx.conf
COPY apps/web/nginx/entrypoint.sh /docker-entrypoint.d/00-runtime-config.sh
RUN chmod +x /docker-entrypoint.d/00-runtime-config.sh \
 && rm -rf /usr/share/nginx/html/* \
 && chown -R nginx:nginx /usr/share/nginx/html /var/cache/nginx
COPY --from=build --chown=nginx:nginx /workspace/apps/web/dist/ /usr/share/nginx/html/
USER nginx
EXPOSE 8080
