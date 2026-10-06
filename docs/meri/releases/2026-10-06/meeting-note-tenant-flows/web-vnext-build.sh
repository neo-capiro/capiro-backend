set -euo pipefail
test "$CODEBUILD_RESOLVED_SOURCE_VERSION" = "a734bb0a54322ac5327dc04b81647a407a28fb61"
test "$(git rev-parse HEAD)" = "a734bb0a54322ac5327dc04b81647a407a28fb61"
test "$(uname -m)" = aarch64
test "$(aws sts get-caller-identity --query Account --output text)" = 967807252336
test "$(aws ecr list-images --region us-east-1 --repository-name capiro/dev/web-vnext --filter tagStatus=TAGGED --query "length(imageIds[?imageTag=='a734bb0a54322ac5327dc04b81647a407a28fb61'])" --output json)" = 0
python3 scripts/validate-meri-build-isolation.py
aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin 967807252336.dkr.ecr.us-east-1.amazonaws.com
docker build --platform linux/arm64 --build-arg NODE_VERSION=22.23.3 --build-arg NODE_IMAGE=public.ecr.aws/docker/library/node@sha256:b20fe038d9592822dd534600a1ddf467e985178aa3fed60ec441a056c2cc45bd --build-arg NGINX_IMAGE=public.ecr.aws/nginx/nginx-unprivileged@sha256:9de6da66da9ece40f08e7ba1d81011edfd1a496d9fa82a3f37ce4126b906b969 --build-arg GIT_SHA=a734bb0a54322ac5327dc04b81647a407a28fb61 --build-arg CAPIRO_WEB_BUILD_SURFACE=vnext --label org.opencontainers.image.revision=a734bb0a54322ac5327dc04b81647a407a28fb61 -f apps/web/Dockerfile -t 967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/web-vnext:a734bb0a54322ac5327dc04b81647a407a28fb61 .
test "$(docker image inspect 967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/web-vnext:a734bb0a54322ac5327dc04b81647a407a28fb61 --format '{{.Architecture}}')" = arm64
test "$(docker image inspect 967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/web-vnext:a734bb0a54322ac5327dc04b81647a407a28fb61 --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')" = a734bb0a54322ac5327dc04b81647a407a28fb61
docker run --rm --network none --entrypoint sh 967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/web-vnext:a734bb0a54322ac5327dc04b81647a407a28fb61 -c 'test -f /usr/share/nginx/html/index.html; grep -rl "directly into Meeting Notes and Debrief" /usr/share/nginx/html/assets ; grep -rl "from the completed transcripts" /usr/share/nginx/html/assets ; echo KRISP_PACKAGED_UI_PASS'
docker push 967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/web-vnext:a734bb0a54322ac5327dc04b81647a407a28fb61
digest=$(aws ecr describe-images --region us-east-1 --repository-name capiro/dev/web-vnext --image-ids imageTag=a734bb0a54322ac5327dc04b81647a407a28fb61 --query 'imageDetails[0].imageDigest' --output text)
echo "QUALIFIED_BUILD_IMAGE=967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/web-vnext@$digest"
