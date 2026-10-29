#!/usr/bin/env bash
# Runtime smoke for the legacy Web image built from apps/web/Dockerfile
# (the artifact-consuming Node24 recipe on port 8080).
#
# It runs one unconfigured container on an ephemeral loopback port. It does not
# build, push, deploy, register or call AWS, and it needs no network egress.
# It proves the container contract only: non-root runtime, PORT 8080 binding,
# the admitted artifact entrypoint landing in the image, the health endpoint and
# the response-security headers. It is not UI, tenant, auth, proxy or deployed
# route acceptance.
set -euo pipefail

usage() {
  echo "Usage: bash apps/web/smoke-8080.sh LOCAL_IMAGE"
  echo "Exit 0: passed; 1: container/HTTP gate failed; 2: invalid arguments."
}
if [[ "${1:-}" == --help && "$#" == 1 ]]; then usage; exit 0; fi
if [[ "$#" != 1 || -z "$1" || "$1" == -* ]]; then usage >&2; exit 2; fi
image="$1"
docker image inspect "$image" --format '{{.Id}}' >/dev/null
name="capiro-legacy-web-smoke-$$-$RANDOM"
scratch=$(mktemp -d)
curl_limits=(--connect-timeout 2 --max-time 10)
cleanup() {
  docker rm -f "$name" >/dev/null 2>&1 || true
  rm -rf "$scratch"
}
trap cleanup EXIT

# The admitted artifact layout must be present in the image the recipe produced.
docker run --rm --network none --entrypoint sh "$image" -ec '
  test -s /app/apps/web/server.js
  test -s /app/apps/web/.next/BUILD_ID
  test -s /app/apps/web/.next/required-server-files.json
  test -d /app/apps/web/.next/static
  test -d /app/apps/web/public/newsletter
  test "$(id -u)" = 1000
  test "$PORT" = 8080
  echo IMAGE_LAYOUT_PASS
'

docker run -d --name "$name" -p 127.0.0.1::8080 "$image" >/dev/null
test "$(docker exec "$name" id -u)" = 1000
test "$(docker exec "$name" printenv PORT)" = 8080
test "$(docker exec "$name" printenv HOSTNAME)" = 0.0.0.0
endpoint=$(docker port "$name" 8080/tcp)
[[ "$endpoint" =~ ^127\.0\.0\.1:[0-9]+$ ]]
base="http://$endpoint"
ready=0
for _ in $(seq 1 30); do
  if [[ "$(curl "${curl_limits[@]}" --fail --silent "$base/healthz" || true)" == *'"status":"ok"'* ]]; then
    ready=1
    break
  fi
  sleep 2
done
test "$ready" = 1

probe() {
  local path="$1" expected="$2" status
  status=$(curl "${curl_limits[@]}" --silent --show-error --output "$scratch/body" \
    --dump-header "$scratch/headers" --write-out '%{http_code}' "$base$path")
  if [[ "$status" != "$expected" ]]; then
    echo "Container gate failed: $path expected $expected, received $status" >&2
    return 1
  fi
  grep -qi '^x-content-type-options: nosniff' "$scratch/headers"
  grep -qi '^x-frame-options: DENY' "$scratch/headers"
  ! grep -qi '^x-powered-by:' "$scratch/headers"
}

probe / 200
grep -qi '<html' "$scratch/body"

echo "Container smoke passed: nonroot, artifact layout, PORT 8080, health, root document and response headers."
