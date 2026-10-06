set -euo pipefail
test "$CODEBUILD_RESOLVED_SOURCE_VERSION" = "6db96857068b52ec2993af33267f14a45efcf2e6"
test "$(git rev-parse HEAD)" = "6db96857068b52ec2993af33267f14a45efcf2e6"
test "$(uname -m)" = aarch64
test "$(aws sts get-caller-identity --query Account --output text)" = 967807252336
test "$(aws ecr list-images --region us-east-1 --repository-name capiro/dev/web-vnext --filter tagStatus=TAGGED --query "length(imageIds[?imageTag=='6db96857068b52ec2993af33267f14a45efcf2e6'])" --output json)" = 0
python3 scripts/validate-meri-build-isolation.py
aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin 967807252336.dkr.ecr.us-east-1.amazonaws.com
docker build --platform linux/arm64 --build-arg NODE_VERSION=22.23.3 --build-arg GIT_SHA=6db96857068b52ec2993af33267f14a45efcf2e6 --build-arg CAPIRO_WEB_BUILD_SURFACE=vnext --label org.opencontainers.image.revision=6db96857068b52ec2993af33267f14a45efcf2e6 -f apps/web/Dockerfile -t 967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/web-vnext:6db96857068b52ec2993af33267f14a45efcf2e6 .
test "$(docker image inspect 967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/web-vnext:6db96857068b52ec2993af33267f14a45efcf2e6 --format '{{.Architecture}}')" = arm64
test "$(docker image inspect 967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/web-vnext:6db96857068b52ec2993af33267f14a45efcf2e6 --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')" = 6db96857068b52ec2993af33267f14a45efcf2e6
docker run --rm --network none --entrypoint sh 967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/web-vnext:6db96857068b52ec2993af33267f14a45efcf2e6 -c 'test -f /usr/share/nginx/html/index.html; grep -rl "directly into Meeting Notes and Debrief" /usr/share/nginx/html/assets >/dev/null; echo KRISP_PACKAGED_UI_PASS'
docker push 967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/web-vnext:6db96857068b52ec2993af33267f14a45efcf2e6
digest=$(aws ecr describe-images --region us-east-1 --repository-name capiro/dev/web-vnext --image-ids imageTag=6db96857068b52ec2993af33267f14a45efcf2e6 --query 'imageDetails[0].imageDigest' --output text)
echo "QUALIFIED_BUILD_IMAGE=967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/web-vnext@$digest"
