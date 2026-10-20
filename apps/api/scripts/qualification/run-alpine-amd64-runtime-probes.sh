#!/bin/sh
# Execute on an isolated native AMD64 Docker host; never against a running service.
set -eu
image=${1:?Usage: run-alpine-amd64-runtime-probes.sh <locally-built-candidate-image>}
case "$(uname -m)" in x86_64|amd64) ;; *) echo 'Native AMD64 host required' >&2; exit 64 ;; esac
case "$(docker info --format '{{.Architecture}}')" in x86_64|amd64) ;; *) echo 'Native AMD64 Docker daemon required' >&2; exit 64 ;; esac
test "$(docker image inspect "$image" --format '{{.Os}}/{{.Architecture}}')" = linux/amd64
# No env file, credential mounts, ports, privileged mode, database, or AWS commands.
docker run --rm --read-only --network none --cap-drop ALL \
  --security-opt no-new-privileges --pids-limit 256 --memory 1g \
  --tmpfs /tmp:rw,noexec,nosuid,size=64m --shm-size 128m \
  --entrypoint /usr/bin/dumb-init "$image" -- \
  node /qualification/alpine-runtime-probe.cjs
