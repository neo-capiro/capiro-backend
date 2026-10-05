set -euo pipefail
test "$CODEBUILD_RESOLVED_SOURCE_VERSION" = "be4d886ffa774f72e0ed5c5268995109cbd11220"
test "$(git rev-parse HEAD)" = "be4d886ffa774f72e0ed5c5268995109cbd11220"
test "$(uname -m)" = aarch64
test "$(aws sts get-caller-identity --query Account --output text)" = 967807252336
test "$(aws ecr list-images --region us-east-1 --repository-name capiro/dev/web-vnext --filter tagStatus=TAGGED --query "length(imageIds[?imageTag=='be4d886ffa774f72e0ed5c5268995109cbd11220'])" --output json)" = 0
python3 scripts/validate-meri-build-isolation.py
aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin 967807252336.dkr.ecr.us-east-1.amazonaws.com
docker build --platform linux/arm64 --build-arg NODE_VERSION=22.23.3 --build-arg GIT_SHA=be4d886ffa774f72e0ed5c5268995109cbd11220 --build-arg CAPIRO_WEB_BUILD_SURFACE=vnext --label org.opencontainers.image.revision=be4d886ffa774f72e0ed5c5268995109cbd11220 -f apps/web/Dockerfile -t 967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/web-vnext:be4d886ffa774f72e0ed5c5268995109cbd11220 .
test "$(docker image inspect 967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/web-vnext:be4d886ffa774f72e0ed5c5268995109cbd11220 --format '{{.Architecture}}')" = arm64
test "$(docker image inspect 967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/web-vnext:be4d886ffa774f72e0ed5c5268995109cbd11220 --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')" = be4d886ffa774f72e0ed5c5268995109cbd11220
docker run --rm --network none --entrypoint sh 967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/web-vnext:be4d886ffa774f72e0ed5c5268995109cbd11220 -c 'test -f /usr/share/nginx/html/index.html; grep -rl "Krisp" /usr/share/nginx/html/assets >/dev/null; echo KRISP_PACKAGED_UI_PASS'
docker push 967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/web-vnext:be4d886ffa774f72e0ed5c5268995109cbd11220
digest=$(aws ecr describe-images --region us-east-1 --repository-name capiro/dev/web-vnext --image-ids imageTag=be4d886ffa774f72e0ed5c5268995109cbd11220 --query 'imageDetails[0].imageDigest' --output text)
echo "QUALIFIED_BUILD_IMAGE=967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/web-vnext@$digest"
