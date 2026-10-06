set -euo pipefail
test "$CODEBUILD_RESOLVED_SOURCE_VERSION" = "ca5e574dbe436db86924d3c23d791d97c7aa57c7"
test "$(git rev-parse HEAD)" = "ca5e574dbe436db86924d3c23d791d97c7aa57c7"
test "$(uname -m)" = aarch64
test "$(aws sts get-caller-identity --query Account --output text)" = 967807252336
test "$(aws ecr list-images --region us-east-1 --repository-name capiro/dev/web-vnext --filter tagStatus=TAGGED --query "length(imageIds[?imageTag=='ca5e574dbe436db86924d3c23d791d97c7aa57c7'])" --output json)" = 0
python3 scripts/validate-meri-build-isolation.py
aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin 967807252336.dkr.ecr.us-east-1.amazonaws.com
docker build --platform linux/arm64 --build-arg NODE_VERSION=22.23.3 --build-arg NODE_IMAGE=public.ecr.aws/docker/library/node@sha256:b20fe038d9592822dd534600a1ddf467e985178aa3fed60ec441a056c2cc45bd --build-arg NGINX_IMAGE=public.ecr.aws/nginx/nginx-unprivileged@sha256:9de6da66da9ece40f08e7ba1d81011edfd1a496d9fa82a3f37ce4126b906b969 --build-arg GIT_SHA=ca5e574dbe436db86924d3c23d791d97c7aa57c7 --build-arg CAPIRO_WEB_BUILD_SURFACE=vnext --label org.opencontainers.image.revision=ca5e574dbe436db86924d3c23d791d97c7aa57c7 -f apps/web/Dockerfile -t 967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/web-vnext:ca5e574dbe436db86924d3c23d791d97c7aa57c7 .
test "$(docker image inspect 967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/web-vnext:ca5e574dbe436db86924d3c23d791d97c7aa57c7 --format '{{.Architecture}}')" = arm64
test "$(docker image inspect 967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/web-vnext:ca5e574dbe436db86924d3c23d791d97c7aa57c7 --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')" = ca5e574dbe436db86924d3c23d791d97c7aa57c7
docker run --rm --network none --entrypoint sh 967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/web-vnext:ca5e574dbe436db86924d3c23d791d97c7aa57c7 -c 'test -f /usr/share/nginx/html/index.html; grep -rl "directly into Meeting Notes and Debrief" /usr/share/nginx/html/assets >/dev/null; grep -rl "from the completed transcripts" /usr/share/nginx/html/assets >/dev/null; echo KRISP_PACKAGED_UI_PASS'
docker push 967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/web-vnext:ca5e574dbe436db86924d3c23d791d97c7aa57c7
digest=$(aws ecr describe-images --region us-east-1 --repository-name capiro/dev/web-vnext --image-ids imageTag=ca5e574dbe436db86924d3c23d791d97c7aa57c7 --query 'imageDetails[0].imageDigest' --output text)
echo "QUALIFIED_BUILD_IMAGE=967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/web-vnext@$digest"
