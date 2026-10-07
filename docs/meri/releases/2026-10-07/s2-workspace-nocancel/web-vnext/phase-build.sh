set -euo pipefail
image="967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/web-vnext:${EXPECTED_SHA}"
docker build --platform linux/arm64 \
  --build-arg NODE_VERSION=22.23.3 --build-arg GIT_SHA="$EXPECTED_SHA" --build-arg CAPIRO_WEB_BUILD_SURFACE=vnext \
  --label "org.opencontainers.image.revision=$EXPECTED_SHA" \
  --label 'org.opencontainers.image.source=https://github.com/neo-capiro/capirov2' \
  -f apps/web/Dockerfile -t "$image" .
test "$(docker image inspect "$image" --format '{{.Architecture}}')" = arm64
test "$(docker image inspect "$image" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')" = "$EXPECTED_SHA"
docker run --rm --network none --entrypoint sh "$image" -ec '
test -s /usr/share/nginx/html/index.html
test -x /docker-entrypoint.d/00-runtime-config.sh
grep -rl "__CAPIRO_CONFIG__" /usr/share/nginx/html/assets >/dev/null
echo IMAGE_SMOKE_PASS'
