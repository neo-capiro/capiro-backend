#!/usr/bin/env bash
# Phase 10B-36 -- self-contained rehearsal of the COMMITTED qualification
# script end to end: disposable Postgres, disposable versioned MinIO, and a
# local static file server standing in for the real presigned S3 GET URL (so
# qualify-defense-budget-drain-image-v1.ts's own fetchAndVerifySource runs
# through the exact same HTTP-fetch + identity-verification code path a real
# Fargate qualification task would use), all torn down on exit. Modeled on
# scripts/phase10b35c-candidate-correction-e2e-rehearsal.sh's own containers/
# own ports/always-torn-down convention.
#
# This is the closest a local machine can get to reproducing the real
# capiro-dev-defense-budget-qualification Fargate task without AWS: the same
# script, invoked the same way (`tsx scripts/qualify-defense-budget-drain-image-v1.ts`,
# no arguments, driven entirely by environment variables), against real
# disposable infrastructure and the real, already-committed FY2024 Army R-2
# fixture -- calling the REAL production_proof path, never a stub.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

FIXTURE="$ROOT/src/defense-budget/rdte/cycle/__fixtures__/production-fy2024-army-r2-vol1-ba1-official.pdf"
if [[ ! -f "$FIXTURE" ]]; then
  echo "Real fixture not found at $FIXTURE" >&2
  exit 1
fi

SUFFIX="$RANDOM-$$"
PG_NAME="capiro-qualify-driver-rehearsal-pg-$SUFFIX"
MINIO_NAME="capiro-qualify-driver-rehearsal-minio-$SUFFIX"
# NOT overridable, and NOT an ephemeral/auto-picked docker -P port: the
# committed script's own sidecar-wait logic (waitForTcpPort/waitForHttpHealth)
# hardcodes 127.0.0.1:5432 / 127.0.0.1:9000, matching the real Fargate task's
# awsvpc network namespace where `pg`/`minio` sidecars are reachable at their
# own literal container ports. This rehearsal runs the script directly on the
# HOST (not inside a container), so the disposable containers must bind to
# these exact host ports for the script to find them at all -- a random -P
# port would leave the script waiting on 5432/9000 forever.
PG_PORT=5432
MINIO_PORT=9000
FIXTURE_HTTP_PORT="${QUAL_REHEARSAL_FIXTURE_PORT:-0}"
PASSWORD="qualify-driver-rehearsal"
MINIO_USER="qualifydriver"
MINIO_PASSWORD="qualify-driver-isolated-archive"

FIXTURE_SERVER_PID=""
FIXTURE_SERVE_DIR="$(mktemp -d)"
cp "$FIXTURE" "$FIXTURE_SERVE_DIR/"

cleanup() {
  # Capture the real triggering exit code FIRST: bash trap semantics do not
  # protect $? through a multi-command trap body on their own, and this trap
  # previously ended with `rm -rf` -- whose own (near-always-0) exit status
  # silently became the script's final exit code, once turning a real
  # `docker run` failure into a reported REHEARSAL_EXIT=0. Explicitly exiting
  # with the saved code at the end is what actually fixes that.
  local exit_code=$?
  [[ -n "$FIXTURE_SERVER_PID" ]] && kill "$FIXTURE_SERVER_PID" >/dev/null 2>&1 || true
  docker rm -f "$PG_NAME" >/dev/null 2>&1 || true
  docker rm -f "$MINIO_NAME" >/dev/null 2>&1 || true
  rm -rf "$FIXTURE_SERVE_DIR"
  exit "$exit_code"
}
trap cleanup EXIT

echo "Serving the real fixture locally (stands in for a presigned S3 GET URL)..." >&2
# python's http.server does not support ephemeral-port auto-selection the way
# `docker run -P` does; use a fixed high port (overridable) rather than
# reimplementing port discovery.
if [[ "$FIXTURE_HTTP_PORT" == "0" ]]; then
  FIXTURE_HTTP_PORT=18943
fi
python3 -m http.server "$FIXTURE_HTTP_PORT" --directory "$FIXTURE_SERVE_DIR" --bind 127.0.0.1 &
FIXTURE_SERVER_PID=$!
sleep 1

echo "Starting disposable Postgres ($PG_NAME) on the fixed sidecar port 127.0.0.1:${PG_PORT}..." >&2
docker run -d --name "$PG_NAME" -e POSTGRES_USER=capiro -e POSTGRES_PASSWORD="$PASSWORD" -e POSTGRES_DB=capiro -p "127.0.0.1:${PG_PORT}:5432" pgvector/pgvector:pg16 >/dev/null

echo "Starting disposable versioned MinIO ($MINIO_NAME) on the fixed sidecar port 127.0.0.1:${MINIO_PORT}..." >&2
docker run -d --name "$MINIO_NAME" -e MINIO_ROOT_USER="$MINIO_USER" -e MINIO_ROOT_PASSWORD="$MINIO_PASSWORD" -p "127.0.0.1:${MINIO_PORT}:9000" minio/minio:latest server /data >/dev/null

export DATABASE_URL="postgresql://capiro:${PASSWORD}@127.0.0.1:${PG_PORT}/capiro"
export BUDGET_VERIFICATION_S3_ENDPOINT="http://127.0.0.1:${MINIO_PORT}"
export AWS_ACCESS_KEY_ID="$MINIO_USER"
export AWS_SECRET_ACCESS_KEY="$MINIO_PASSWORD"
export AWS_REGION="${AWS_REGION:-us-east-1}"
unset AWS_PROFILE AWS_SESSION_TOKEN BUDGET_VERIFICATION_EXTRACTION_ARTIFACT_BUCKET

export QUAL_RUN_ID="rehearsal-$SUFFIX"
export QUAL_OUT_ROOT="$(mktemp -d)"
export QUAL_PRESIGNED_GET="http://127.0.0.1:${FIXTURE_HTTP_PORT}/production-fy2024-army-r2-vol1-ba1-official.pdf"
export QUAL_ARCHIVE_BUCKET="capiro-qualify-driver-rehearsal-$SUFFIX"
# Distinct per rehearsal run so repeated local runs never collide on the
# (sourceKey, sha256) unique constraint or the cycle dedupKey.
export QUAL_SOURCE_DOCUMENT_ID="$(python3 -c 'import uuid; print(uuid.uuid4())')"
export QUAL_CYCLE_ID="$(python3 -c 'import uuid; print(uuid.uuid4())')"
export QUAL_SOURCE_KEY="defense-budget-observation-qualification-rehearsal-$SUFFIX"
export DEFENSE_BUDGET_PARSER_PROJECT_DIR="$(cd "$ROOT/../defense-budget-parser" && pwd)"

echo "Postgres ready at 127.0.0.1:${PG_PORT}; MinIO ready at 127.0.0.1:${MINIO_PORT}; fixture served at ${QUAL_PRESIGNED_GET}" >&2
echo "Running the committed qualification script exactly as the ECS entrypoint would invoke it..." >&2

# set -e must not steal the exit code here -- it needs to be captured and
# reported (and the temp work dir cleaned up) whether the script exits 0 or
# not, rather than the whole rehearsal script aborting mid-way and skipping
# the summary below.
set +e
./node_modules/.bin/tsx scripts/qualify-defense-budget-drain-image-v1.ts
STATUS=$?
set -e

rm -rf "$QUAL_OUT_ROOT"
echo "qualify-defense-budget-drain-image-v1 exited $STATUS" >&2
exit "$STATUS"
