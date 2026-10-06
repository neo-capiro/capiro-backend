set -euo pipefail
: "${EXPECTED_SHA:?start-build must pass the exact merged-main SHA}"
[[ "$EXPECTED_SHA" =~ ^[0-9a-f]{40}$ ]]
test "${CODEBUILD_RESOLVED_SOURCE_VERSION:-}" = "$EXPECTED_SHA"
test "$(git rev-parse HEAD)" = "$EXPECTED_SHA"
test -z "$(git status --porcelain --untracked-files=no)"
test "$(uname -m)" = aarch64
test "$(aws sts get-caller-identity --query Account --output text)" = 967807252336
test "$(aws ecr list-images --region us-east-1 --repository-name capiro/dev/web-vnext --filter tagStatus=TAGGED --query "length(imageIds[?imageTag=='${EXPECTED_SHA}'])" --output json)" = 0
python3 scripts/validate-meri-build-isolation.py

aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin 967807252336.dkr.ecr.us-east-1.amazonaws.com
