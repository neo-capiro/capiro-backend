#!/bin/sh
# Negative boot only: real entrypoint and compiled Nest reach the isolated DB
# connection boundary. This cannot establish a healthy API without PostgreSQL.
set -eu
image=${1:?Usage: run-alpine-amd64-entrypoint-db-gate.sh <locally-built-candidate-image>}
case "$(uname -m)" in x86_64|amd64) ;; *) echo 'Native AMD64 host required' >&2; exit 64 ;; esac
case "$(docker info --format '{{.Architecture}}')" in x86_64|amd64) ;; *) echo 'Native AMD64 Docker daemon required' >&2; exit 64 ;; esac
test "$(docker image inspect "$image" --format '{{.Os}}/{{.Architecture}}')" = linux/amd64
log=$(mktemp)
trap 'rm -f "$log"' EXIT HUP INT TERM

set +e
timeout 45s docker run --rm --read-only --network none --cap-drop ALL \
  --security-opt no-new-privileges --pids-limit 256 --memory 1g \
  --tmpfs /tmp:rw,noexec,nosuid,size=64m --shm-size 128m \
  -e DB_HOST=127.0.0.1 -e DB_PORT=9 -e DB_USER=qualification \
  -e DB_PASSWORD=fixture-only -e DB_NAME=qualification \
  -e CLERK_SECRET_KEY=fixture-only \
  -e CLERK_WEBHOOK_SIGNING_SECRET=fixture-only \
  -e CLERK_JWT_ISSUER=https://fixture.invalid \
  "$image" serve >"$log" 2>&1
status=$?
set -e

if [ "$status" -eq 0 ] || [ "$status" -eq 124 ] \
  || ! grep -q 'Fatal bootstrap error' "$log" \
  || ! grep -Eq 'P1001|Can.t reach database server' "$log" \
  || grep -q 'Capiro API listening' "$log"; then
  cat "$log" >&2
  echo 'HOLD: real entrypoint did not reach the expected isolated Prisma DB gate' >&2
  exit 1
fi
echo 'PASS_COMPILED_ENTRYPOINT_REACHES_ISOLATED_DB_GATE; FULL_API_STARTUP_UNVERIFIED'
