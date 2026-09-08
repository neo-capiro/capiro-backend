#!/usr/bin/env bash
# Phase 10B-31 -- self-contained qualification rehearsal for the
# lifecycle-bridge SourceDocument metadata-agreement fix.
#
# Provisions its OWN disposable infrastructure (never reuses another
# session's containers on a shared machine):
#   - a pgvector/pgvector:pg16 Postgres, migrated with BOTH prisma schemas
#     this app actually uses (prisma/schema.prisma and
#     prisma/phase6-projection/schema.prisma -- the second is required by
#     other specs the full `verify:pe-budget-phase-10b31` jest invocation
#     also touches);
#   - a minio/minio versioned S3-compatible object store, reached ONLY
#     through the pre-existing verifier-scoped test hook
#     `BUDGET_VERIFICATION_S3_ENDPOINT` (see
#     src/defense-budget/verification/trusted-proof/s3-proof-adapters.ts).
#     This is what lets the complete-archive scenarios in the regression
#     spec drive the REAL `SdkS3ProofClient` / `S3ByteLocatorReader` /
#     `ArchiveProofResolver` against complete, valid archive evidence and
#     reach a genuine overall decision (REVIEW), instead of every scenario
#     short-circuiting on `archive_version_missing`.
# It then runs the fast jest GREEN check, then the deeper RED/GREEN
# mutation-sensitivity check, and always removes both containers on exit
# (success, failure, or interruption).
#
# Requires: docker, and apps/defense-budget-parser synced with
# `uv sync --locked` (the regression spec itself refuses to run against a
# parser environment that is not THIS worktree's own `.venv`).
#
# Makes ZERO AWS calls and ZERO production-database calls: the AWS SDK is
# pointed at the local MinIO endpoint with MinIO-only credentials, and
# AWS_PROFILE is explicitly unset for the child processes so no real
# credential chain can be picked up. See
# verify-pe-budget-phase-10b31-metadata-regression.ts's own header.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

SUFFIX="$RANDOM-$$"
PG_NAME="capiro-phase10b31-metadata-pg-$SUFFIX"
MINIO_NAME="capiro-phase10b31-metadata-minio-$SUFFIX"
PG_PORT="${PHASE10B31_PG_PORT:-0}"
MINIO_PORT="${PHASE10B31_MINIO_PORT:-0}"
PASSWORD="phase10b31-rehearsal"
MINIO_USER="phase10b31"
MINIO_PASSWORD="phase10b31-isolated-archive"

cleanup() {
  docker rm -f "$PG_NAME" >/dev/null 2>&1 || true
  docker rm -f "$MINIO_NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "Starting disposable Postgres ($PG_NAME)..." >&2
if [[ "$PG_PORT" == "0" ]]; then
  docker run -d --name "$PG_NAME" -e POSTGRES_PASSWORD="$PASSWORD" -e POSTGRES_DB=capiro -P pgvector/pgvector:pg16 >/dev/null
  PG_PORT="$(docker port "$PG_NAME" 5432/tcp | head -1 | cut -d: -f2)"
else
  docker run -d --name "$PG_NAME" -e POSTGRES_PASSWORD="$PASSWORD" -e POSTGRES_DB=capiro -p "$PG_PORT:5432" pgvector/pgvector:pg16 >/dev/null
fi

echo "Starting disposable versioned MinIO ($MINIO_NAME)..." >&2
if [[ "$MINIO_PORT" == "0" ]]; then
  docker run -d --name "$MINIO_NAME" -e MINIO_ROOT_USER="$MINIO_USER" -e MINIO_ROOT_PASSWORD="$MINIO_PASSWORD" -p 0:9000 minio/minio:latest server /data >/dev/null
  MINIO_PORT="$(docker port "$MINIO_NAME" 9000/tcp | head -1 | cut -d: -f2)"
else
  docker run -d --name "$MINIO_NAME" -e MINIO_ROOT_USER="$MINIO_USER" -e MINIO_ROOT_PASSWORD="$MINIO_PASSWORD" -p "$MINIO_PORT:9000" minio/minio:latest server /data >/dev/null
fi

for _ in $(seq 1 60); do
  if docker exec "$PG_NAME" pg_isready -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec "$PG_NAME" pg_isready -U postgres >/dev/null

for _ in $(seq 1 60); do
  if curl -fsS "http://localhost:${MINIO_PORT}/minio/health/live" >/dev/null 2>&1; then break; fi
  sleep 1
done
curl -fsS "http://localhost:${MINIO_PORT}/minio/health/live" >/dev/null

export DATABASE_URL="postgresql://postgres:${PASSWORD}@localhost:${PG_PORT}/capiro"
export BUDGET_VERIFICATION_S3_ENDPOINT="http://localhost:${MINIO_PORT}"
export AWS_ACCESS_KEY_ID="$MINIO_USER"
export AWS_SECRET_ACCESS_KEY="$MINIO_PASSWORD"
export AWS_REGION="${AWS_REGION:-us-east-1}"
unset AWS_PROFILE AWS_SESSION_TOKEN BUDGET_VERIFICATION_EXTRACTION_ARTIFACT_BUCKET
echo "Postgres ready at localhost:${PG_PORT}; MinIO ready at localhost:${MINIO_PORT}. Applying migrations..." >&2

npx prisma migrate deploy >/dev/null
npx prisma migrate deploy --schema prisma/phase6-projection/schema.prisma >/dev/null

# The complete-archive scenarios drive the real @aws-sdk/client-s3 request
# pipeline, which performs a dynamic import(); Jest's module VM needs Node's
# --experimental-vm-modules flag for that (the documented Jest requirement).
# The mutation script below passes the same flag to the jest it spawns.
echo "Running the fast GREEN check (current, fixed source)..." >&2
node --experimental-vm-modules node_modules/jest/bin/jest.js --runInBand --forceExit src/defense-budget/verification/persistence/lifecycle-bridge-source-metadata-agreement.integration.spec.ts

echo "Running the deeper RED/GREEN mutation-sensitivity check..." >&2
npx tsx scripts/verify-pe-budget-phase-10b31-metadata-regression.ts
