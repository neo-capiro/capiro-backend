#!/usr/bin/env bash
set -euo pipefail
: "${DATABASE_URL:?Set DATABASE_URL to an explicitly disposable, migrated reextract_test_* PostgreSQL schema.}"
export REEXTRACTION_INTEGRATION=1
cd "$(dirname "$0")/.."
exec pnpm exec jest --runInBand --config scripts/reextraction-db.jest.config.cjs "$@"
