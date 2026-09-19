#!/usr/bin/env bash
# Build the PINNED upstream Hermes Agent base image from a checksum-verified
# source tarball, then the Meri worker layer on top of it.
#
#   ./docker/hermes-worker/build-base.sh            # amd64 (local harness)
#   PLATFORM=linux/arm64 ./docker/hermes-worker/build-base.sh   # Fargate target (needs a docker-container buildx builder)
#
# Pins (do not float):
set -euo pipefail
HERMES_TAG="${HERMES_TAG:-v2026.9.14}"
HERMES_COMMIT="${HERMES_COMMIT:-7a963716b81be13ba513d4f127633b7da493aff2}"
HERMES_TARBALL_SHA256="${HERMES_TARBALL_SHA256:-47df72ebd3f9c96d806a94541163f7fe7d7ce5b84f85c1d3787e6dfeea1d7834}"
BASE_TAG="${BASE_TAG:-meri-hermes-worker:${HERMES_TAG}}"
WORKER_TAG="${WORKER_TAG:-meri-hermes-worker:${HERMES_TAG}-meri}"
PLATFORM="${PLATFORM:-linux/amd64}"
WORK="${WORK:-$(mktemp -d)}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "[build-base] downloading hermes-agent ${HERMES_TAG} → ${WORK}"
curl -fsSL -o "${WORK}/hermes.tar.gz" \
  "https://github.com/NousResearch/hermes-agent/archive/refs/tags/${HERMES_TAG}.tar.gz"
echo "${HERMES_TARBALL_SHA256}  ${WORK}/hermes.tar.gz" | sha256sum -c -
mkdir -p "${WORK}/src"
tar -xzf "${WORK}/hermes.tar.gz" -C "${WORK}/src" --strip-components=1
grep -q '^version = "0.21.3"' "${WORK}/src/pyproject.toml" || { echo "unexpected pyproject version" >&2; exit 1; }

echo "[build-base] building base ${BASE_TAG} for ${PLATFORM} (15–45 min cold)"
if [ "${PLATFORM}" = "linux/amd64" ]; then
  DOCKER_BUILDKIT=1 docker build --progress=plain -t "${BASE_TAG}" "${WORK}/src"
else
  # Fargate is ARM64. Docker Desktop's default builder cannot emit arm64 for
  # this image reliably; use a docker-container buildx builder (see memory note
  # capirov2-arm64-docker-build-requirements) and --load or --push.
  docker buildx build --platform "${PLATFORM}" -t "${BASE_TAG}" --load "${WORK}/src"
fi

echo "[build-base] building Meri worker layer ${WORKER_TAG}"
docker build --build-arg "HERMES_BASE_IMAGE=${BASE_TAG}" -t "${WORKER_TAG}" "${HERE}"
docker image inspect "${WORKER_TAG}" --format 'image_id={{.Id}} arch={{.Architecture}} size={{.Size}}'
echo "[build-base] done. Record the image id above in docs/meri/hermes/phase-0/pins.md."
