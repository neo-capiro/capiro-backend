#!/usr/bin/env bash
# Runtime smoke for the marketing image built from marketing/Dockerfile
# (nginx-unprivileged static site on 8080). Build it with
#   ./marketing/deploy.sh --build-only
# then:
#   bash marketing/smoke-8080.sh capiro-marketing:source-<tag>
#
# It runs one unconfigured container on an ephemeral loopback port and does not
# build, push, deploy, register or call AWS. It proves the container contract:
# non-root nginx, port 8080, the generated pages (not the committed copies),
# clean URLs, 404 behavior, robots/sitemap/assets and the base security headers.
# It is not a visual, SEO or deployed-domain acceptance.
set -euo pipefail

usage() {
  echo "Usage: bash marketing/smoke-8080.sh LOCAL_IMAGE"
  echo "Exit 0: passed; 1: container/HTTP gate failed; 2: invalid arguments."
}
if [[ "${1:-}" == --help && "$#" == 1 ]]; then usage; exit 0; fi
if [[ "$#" != 1 || -z "$1" || "$1" == -* ]]; then usage >&2; exit 2; fi
image="$1"
docker image inspect "$image" --format '{{.Id}}' >/dev/null
name="capiro-marketing-smoke-$$-$RANDOM"
scratch=$(mktemp -d)
curl_limits=(--connect-timeout 2 --max-time 10)
cleanup() {
  docker rm -f "$name" >/dev/null 2>&1 || true
  rm -rf "$scratch"
}
trap cleanup EXIT

# Generated pages and static inputs must be baked into the image, and the
# runtime must stay the unprivileged nginx user (never root).
docker run --rm --network none --entrypoint sh "$image" -ec '
  for page in index platform solutions insights pricing privacy support terms; do
    test -s "/usr/share/nginx/html/$page.html"
  done
  test -s /usr/share/nginx/html/sitemap.xml
  test -s /usr/share/nginx/html/robots.txt
  test -s /usr/share/nginx/html/assets/styles.css
  test "$(id -u)" != 0
  echo IMAGE_LAYOUT_PASS
'

docker run -d --name "$name" -p 127.0.0.1::8080 "$image" >/dev/null
test "$(docker exec "$name" id -u)" != 0
endpoint=$(docker port "$name" 8080/tcp)
[[ "$endpoint" =~ ^127\.0\.0\.1:[0-9]+$ ]]
base="http://$endpoint"
ready=0
for _ in $(seq 1 30); do
  if [[ "$(curl "${curl_limits[@]}" --fail --silent --show-error "$base/healthz" || true)" == "ok" ]]; then
    ready=1
    break
  fi
  sleep 1
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
}

probe / 200
grep -q '<link rel="canonical" href="https://capiro.ai/">' "$scratch/body"
grep -qi '^x-content-type-options: nosniff' "$scratch/headers"
grep -qi '^x-frame-options: DENY' "$scratch/headers"
for route in platform solutions insights pricing privacy support terms; do
  probe "/$route" 200
  grep -q "<link rel=\"canonical\" href=\"https://capiro.ai/$route\">" "$scratch/body"
done
probe /robots.txt 200
grep -qi 'sitemap' "$scratch/body"
probe /sitemap.xml 200
test "$(grep -c '<loc>' "$scratch/body")" = 8
probe /assets/styles.css 200
probe /no-such-page 404

echo "Container smoke passed: nonroot, PORT 8080, health, 8 canonical pages, clean URLs, 404, robots/sitemap/assets and headers."
