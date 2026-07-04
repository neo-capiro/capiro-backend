# Capiro marketing site container.
# Multi-page static HTML built from templates, served by nginx-unprivileged on 8080.
# Build context: REPOSITORY ROOT.
#   docker buildx build --platform linux/arm64 -f marketing/Dockerfile -t capiro-marketing:local --push .

ARG NGINX_VERSION=1.27.1-alpine
ARG NODE_VERSION=20-alpine

# ---- build stage: render the 7 pages + sitemap.xml from templates ----
FROM node:${NODE_VERSION} AS build
WORKDIR /build
COPY marketing/build.mjs ./build.mjs
COPY marketing/templates ./templates
RUN mkdir -p /out && OUT_DIR=/out node build.mjs

# ---- runtime stage ----
FROM nginxinc/nginx-unprivileged:${NGINX_VERSION} AS runtime
USER root
RUN apk add --no-cache wget ca-certificates
COPY marketing/nginx/nginx.conf /etc/nginx/nginx.conf
RUN rm -rf /usr/share/nginx/html/* \
 && chown -R nginx:nginx /usr/share/nginx/html /var/cache/nginx
# Generated pages + sitemap.xml from the build stage.
COPY --from=build --chown=nginx:nginx /out/ /usr/share/nginx/html/
# Static assets and robots.txt copied straight from the repo.
COPY --chown=nginx:nginx marketing/assets /usr/share/nginx/html/assets
COPY --chown=nginx:nginx marketing/robots.txt /usr/share/nginx/html/robots.txt
USER nginx
EXPOSE 8080
