# Backend repository consumes the separately built frontend release artifact.
# Context: repository root plus explicit release-artifacts/capiro-frontend inputs.
# Source compilation belongs to capiro-frontend; missing pins/artifacts fail closed.
# The accepted byte gate, pinned runtime profile, port8080 and non-root user remain.
# apps/web/Dockerfile.frontend-artifact remains the unchanged compatibility recipe.

FROM node:24.21.0-alpine3.23@sha256:9ec4a2e289874ed0d722e1772ec2de45d2801541db8612f3638b26f128c69ac2 AS base
RUN apk add --no-cache --upgrade zlib=1.3.2-r1 ca-certificates
WORKDIR /app

FROM base AS artifact-check
WORKDIR /workspace
COPY scripts/lib/frontend-standalone-artifact-contract.mjs scripts/lib/frontend-standalone-artifact-contract.mjs
COPY scripts/lib/newsletter-accepted-source-profile.json scripts/lib/newsletter-accepted-source-profile.json
COPY scripts/lib/newsletter-static-release-contract.mjs scripts/lib/newsletter-static-release-contract.mjs
COPY release-artifacts/capiro-frontend release-artifacts/capiro-frontend
ARG FRONTEND_ARTIFACT_MANIFEST_SHA256
ARG FRONTEND_ARTIFACT_SOURCE_REPOSITORY
ARG FRONTEND_ARTIFACT_SOURCE_COMMIT
ARG TARGETPLATFORM
RUN node scripts/lib/frontend-standalone-artifact-contract.mjs \
      --artifact-dir /workspace/release-artifacts/capiro-frontend \
      --manifest-sha256 "$FRONTEND_ARTIFACT_MANIFEST_SHA256" \
      --source-repository "$FRONTEND_ARTIFACT_SOURCE_REPOSITORY" \
      --source-commit "$FRONTEND_ARTIFACT_SOURCE_COMMIT" \
      --target-platform "$TARGETPLATFORM" \
      --target-libc musl \
      --target-node-major 24

FROM base AS runtime
ENV NODE_ENV=production PORT=8080 HOSTNAME=0.0.0.0
COPY --from=artifact-check --chown=node:node /workspace/release-artifacts/capiro-frontend/rootfs ./
USER node
EXPOSE 8080
CMD ["node", "apps/web/server.js"]
