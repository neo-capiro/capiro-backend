#!/usr/bin/env bash
set -euo pipefail

API_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$API_ROOT/../.." && pwd)"
cd "$API_ROOT"

echo "[Phase 6] projection schema generate + validate"
pnpm exec prisma generate --schema prisma/phase6-projection/schema.prisma
pnpm exec prisma validate --schema prisma/phase6-projection/schema.prisma

echo "[Phase 6] strict TypeScript"
pnpm exec tsc -p tsconfig.phase6.json --noEmit

echo "[Phase 6] Jest stages + phase6 + verification"
node_modules/.bin/jest --ci --runInBand --forceExit \
  src/defense-budget/stages \
  src/defense-budget/phase6 \
  src/defense-budget/verification

echo "[Phase 6] mandatory NC01-NC24 mutate/fail/restore controls"
pnpm exec tsx scripts/verify-pe-budget-phase6-negative-controls.ts

echo "[Phase 6] architecture + permanent safety"
pnpm exec tsx scripts/verify-pe-budget-phase6-safety.ts

echo "[Phase 6] formatting"
cd "$REPO_ROOT"
pnpm exec prettier --check \
  "apps/api/src/defense-budget/stages/**/*.ts" \
  "apps/api/src/defense-budget/phase6/**/*.{ts,json}" \
  "apps/api/src/defense-budget/verification/**/*.ts" \
  "apps/api/scripts/phase6-stage-cycle.ts" \
  "apps/api/scripts/verify-pe-budget-phase6-negative-controls.ts" \
  "apps/api/scripts/verify-pe-budget-phase6-safety.ts" \
  "apps/api/scripts/parse-defense-approps-public-law.ts" \
  "docs/defense-budget/CONGRESSIONAL-TO-ENACTED-INGESTION-V1.md" \
  "docs/runbooks/defense-budget-stage-cycle-v1.md" \
  "docs/runbooks/defense-budget-enactment-proof-v1.md" \
  "docs/runbooks/defense-budget-recovery-and-source-drift.md" \
  "docs/phase7-handoff.md"

echo "[Phase 6] Python parser quality + full tests"
cd "$REPO_ROOT/apps/defense-budget-parser"
uv sync --frozen --extra dev
uv run ruff format --check src tests
uv run ruff check src tests
uv run mypy src
uv run pytest -q

if [[ "${PHASE6_SKIP_DB_REHEARSAL:-0}" == "1" ]]; then
  echo "[Phase 6] DB rehearsal explicitly skipped via PHASE6_SKIP_DB_REHEARSAL=1"
else
  echo "[Phase 6] disposable PostgreSQL rehearsal"
  command -v docker >/dev/null 2>&1 || {
    echo "Docker is required for the Phase 6 disposable PostgreSQL rehearsal" >&2
    exit 1
  }
  docker info >/dev/null 2>&1 || {
    echo "Docker daemon is not available for the Phase 6 disposable PostgreSQL rehearsal" >&2
    exit 1
  }
  cd "$API_ROOT"
  bash scripts/phase6-projection-rehearsal.sh
fi

cd "$REPO_ROOT"
git diff --check

echo "Phase 6 J-O closeout PASS"
