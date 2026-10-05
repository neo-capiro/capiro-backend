set -euo pipefail
test "$CODEBUILD_RESOLVED_SOURCE_VERSION" = "ac45312b829615a276dbe654065e7326bcfdaf06"
test "$(git rev-parse HEAD)" = "ac45312b829615a276dbe654065e7326bcfdaf06"
test "$(uname -m)" = aarch64
test "$(aws sts get-caller-identity --query Account --output text)" = 967807252336
test "$(aws ecr list-images --region us-east-1 --repository-name capiro/dev/web-vnext --filter tagStatus=TAGGED --query "length(imageIds[?imageTag=='ac45312b829615a276dbe654065e7326bcfdaf06'])" --output json)" = 0
python3 scripts/validate-meri-build-isolation.py
aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin 967807252336.dkr.ecr.us-east-1.amazonaws.com
docker build --platform linux/arm64 --build-arg NODE_VERSION=22.23.3 --build-arg GIT_SHA=ac45312b829615a276dbe654065e7326bcfdaf06 --build-arg CAPIRO_WEB_BUILD_SURFACE=vnext --label org.opencontainers.image.revision=ac45312b829615a276dbe654065e7326bcfdaf06 -f apps/web/Dockerfile -t 967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/web-vnext:ac45312b829615a276dbe654065e7326bcfdaf06 .
test "$(docker image inspect 967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/web-vnext:ac45312b829615a276dbe654065e7326bcfdaf06 --format '{{.Architecture}}')" = arm64
test "$(docker image inspect 967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/web-vnext:ac45312b829615a276dbe654065e7326bcfdaf06 --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')" = ac45312b829615a276dbe654065e7326bcfdaf06
docker run --rm --network none --entrypoint sh 967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/web-vnext:ac45312b829615a276dbe654065e7326bcfdaf06 -ec 'test -f /usr/share/nginx/html/index.html; grep -rl "Krisp" /usr/share/nginx/html/assets >/dev/null; if grep -rl "Sign-in was closed before it finished" /usr/share/nginx/html/assets; then exit 1; fi; grep -rl "Sign-in took too long" /usr/share/nginx/html/assets >/dev/null; echo KRISP_POPUP_FIX_PACKAGE_PASS'
docker push 967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/web-vnext:ac45312b829615a276dbe654065e7326bcfdaf06
digest=$(aws ecr describe-images --region us-east-1 --repository-name capiro/dev/web-vnext --image-ids imageTag=ac45312b829615a276dbe654065e7326bcfdaf06 --query 'imageDetails[0].imageDigest' --output text)
echo "QUALIFIED_BUILD_IMAGE=967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/web-vnext@$digest"
