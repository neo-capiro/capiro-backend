#!/usr/bin/env bash
# Deploy the Capiro marketing site (capiro.ai) to AWS.
#
# capiro.ai is served by an nginx Docker container running as the ECS service
# `capiro-dev-marketing` — NOT S3/CloudFront. (The old S3 path in this script's
# history pointed at a distribution that no longer fronts capiro.ai.) The deploy
# is: build the arm64 image (which bakes in marketing/index.html + assets), push
# to ECR, force a new deployment of the ECS service, wait for steady state.
#
# Usage:  ./marketing/deploy.sh
# Prereqs: docker + buildx, AWS CLI configured for account 967807252336.
#          Build context is the REPOSITORY ROOT (the Dockerfile COPYs marketing/*).

set -euo pipefail
export MSYS_NO_PATHCONV=1  # keep ARNs/paths intact under git-bash on Windows

ACCOUNT="967807252336"
REGION="us-east-1"
CLUSTER="capiro-dev"
SERVICE="capiro-dev-marketing"
REPO="${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/capiro/dev/marketing"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
TAG="manual-$(date +%Y%m%d-%H%M%S)"

if [[ ! -f "$HERE/index.html" ]]; then
  echo "ERROR: $HERE/index.html not found" >&2
  exit 1
fi

echo "==> ECR login"
aws ecr get-login-password --region "$REGION" \
  | docker login --username AWS --password-stdin "${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com"

echo "==> Build + push image ($REPO:latest and :$TAG)"
# Docker on Windows (git-bash) needs a native path for the build context and
# Dockerfile. MSYS_NO_PATHCONV=1 (above) keeps AWS ARNs intact but also stops
# the usual /c/... -> C:/... conversion, so do it explicitly when cygpath exists
# (no-op on Linux/macOS). Without this, a build from a worktree fails with
# "unable to prepare context: path ... not found".
CTX="$ROOT"
DOCKERFILE="$ROOT/marketing/Dockerfile"
if command -v cygpath >/dev/null 2>&1; then
  CTX="$(cygpath -m "$ROOT")"
  DOCKERFILE="$(cygpath -m "$ROOT/marketing/Dockerfile")"
fi
docker buildx build \
  --platform linux/arm64 \
  -f "$DOCKERFILE" \
  -t "$REPO:latest" \
  -t "$REPO:$TAG" \
  --push \
  "$CTX"

echo "==> Force new deployment of $SERVICE"
aws ecs update-service \
  --cluster "$CLUSTER" \
  --service "$SERVICE" \
  --force-new-deployment \
  --region "$REGION" \
  --query 'service.serviceName' --output text >/dev/null

echo "==> Waiting for $SERVICE to reach steady state..."
aws ecs wait services-stable --cluster "$CLUSTER" --services "$SERVICE" --region "$REGION"

echo "✓ done — pushed :$TAG, service stable."
echo "  Verify: curl -sI https://capiro.ai | grep -i content-length   (compare to local index.html size)"
