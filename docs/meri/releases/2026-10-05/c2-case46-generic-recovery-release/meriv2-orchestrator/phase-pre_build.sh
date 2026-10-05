set -euo pipefail
: "${EXPECTED_SHA:?start-build must pass the exact merged-main SHA}"
[[ "$EXPECTED_SHA" =~ ^[0-9a-f]{40}$ ]]
test "${CODEBUILD_SOURCE_VERSION:-}" = "$EXPECTED_SHA"
test "${CODEBUILD_RESOLVED_SOURCE_VERSION:-}" = "$EXPECTED_SHA"
test "$(git rev-parse HEAD)" = "$EXPECTED_SHA"
test -z "$(git status --porcelain --untracked-files=no)"
test "$(uname -m)" = aarch64
test "$(aws sts get-caller-identity --query Account --output text)" = 967807252336
test "$(aws ecr list-images --region us-east-1 --repository-name capiro/dev/meriv2-orchestrator --filter tagStatus=TAGGED --query "length(imageIds[?imageTag=='${EXPECTED_SHA}'])" --output json)" = 0
python3 scripts/validate-meri-orchestrator-build-only.py
python3 scripts/validate-meri-build-isolation.py
sha256sum apps/meriv2-orchestrator/Dockerfile apps/api/prisma/schema.prisma pnpm-lock.yaml
docker pull public.ecr.aws/docker/library/node:20.16.0-bookworm-slim
docker tag public.ecr.aws/docker/library/node:20.16.0-bookworm-slim node:20.16.0-bookworm-slim
docker build --platform linux/arm64 -t "capiro-orchestrator-test-base:${EXPECTED_SHA}" - <<'DOCKERFILE'
FROM node:20.16.0-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
DOCKERFILE
aws ecr get-login-password --region us-east-1 |
  docker login --username AWS --password-stdin 967807252336.dkr.ecr.us-east-1.amazonaws.com

