#!/usr/bin/env bash
# One-shot orchestration for the full Phase 8 DB-rehearsal evidence sweep
# (S7-S11), run from inside a WSL2 Ubuntu distro against native Docker
# (docker.io) — no Docker Desktop involved.
#
# Recovery recipe for "Docker Desktop won't start" (daemon unreachable via
# npipe, GUI process never spawns, the docker-desktop WSL2 distro's backend
# never initializes): install a fresh, ordinary WSL2 distro and give it its
# own docker.io, entirely independent of Docker Desktop:
#
#   wsl --install -d Ubuntu-24.04 --no-launch
#   wsl -d Ubuntu-24.04 -u root -- apt-get update -qq
#   wsl -d Ubuntu-24.04 -u root -- apt-get install -y -qq docker.io nodejs
#   wsl -d Ubuntu-24.04 -u root -- corepack enable
#
# Then run this script from inside that distro, with the repo reachable at
# its Windows path under /mnt/c/... (WSL2 mounts Windows drives there):
#
#   wsl -d Ubuntu-24.04 -u root -- bash /mnt/c/path/to/repo/scripts/wsl-session11-full-rehearsal.sh
#
# Runs every prior session's OWN, UNMODIFIED disposable-DB rehearsal script
# (each self-manages its own container on its own port), then Session 11's
# own rehearsal.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/.." && pwd)"

log() { echo "[p8s11-full-sweep] $*"; }

log "starting the docker daemon"
service docker start
sleep 2
docker version >/dev/null

cd "$REPO"

log "=== S7 DB rehearsal (self-managed container) ==="
bash scripts/verify-phase8-session7-db.sh

log "=== S8 DB rehearsal (self-managed container) ==="
bash scripts/verify-phase8-session8-db.sh

log "=== S9 DB rehearsal (self-managed container) ==="
bash scripts/verify-phase8-session9-db.sh

log "=== S10 DB rehearsal (self-managed container) ==="
bash scripts/verify-phase8-session10-db.sh

log "=== S11 DB rehearsal (self-managed container) ==="
bash scripts/verify-phase8-session11-db.sh

log "SESSION11_FULL_REHEARSAL_SWEEP_DONE"
