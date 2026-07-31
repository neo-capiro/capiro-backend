#!/usr/bin/env bash
set -euo pipefail

: "${PSQL_DATABASE_URL:?PSQL_DATABASE_URL is required}"
: "${DATABASE_URL:?DATABASE_URL is required}"

TENANT_ID="11111111-1111-4111-8111-111111111111"
ITEM_RESTORE="33333333-3333-4333-8333-333333333333"
ITEM_DRIFT="44444444-4444-4444-8444-444444444444"

psql "$PSQL_DATABASE_URL" -v ON_ERROR_STOP=1 <<SQL
DELETE FROM tenants WHERE id = '$TENANT_ID'::uuid;
INSERT INTO tenants (id, slug, name, status)
VALUES ('$TENANT_ID'::uuid, 'phase11-backfill-rehearsal', 'Phase 11 Backfill Rehearsal', 'active');

INSERT INTO memory_items
  (id, tenant_id, type, visibility, slug, title, source, provenance)
VALUES
  ('$ITEM_RESTORE'::uuid, '$TENANT_ID'::uuid, 'playbook', 'firm',
   'phase11-restore', 'Phase 11 Restore Fixture', 'manual', 'human'),
  ('$ITEM_DRIFT'::uuid, '$TENANT_ID'::uuid, 'firm-policy', 'firm',
   'phase11-drift', 'Phase 11 Drift Fixture', 'manual', 'human');
SQL

PREPARE_JSON=$(pnpm --filter @capiro/api exec tsx \
  scripts/backfill-memory-governance-v2.ts \
  --tenant-id "$TENANT_ID")
JOB_ID=$(printf '%s' "$PREPARE_JSON" | node -e \
  "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(JSON.parse(s).jobId))")

if [[ -z "$JOB_ID" ]]; then
  echo "prepare did not return a jobId" >&2
  exit 1
fi

PREPARED_STATUS=$(psql "$PSQL_DATABASE_URL" -Atc \
  "SELECT status FROM memory_governance_backfill_job WHERE id = '$JOB_ID'::uuid")
LEGACY_COUNT=$(psql "$PSQL_DATABASE_URL" -Atc \
  "SELECT count(*) FROM memory_items WHERE tenant_id = '$TENANT_ID'::uuid AND memory_class = 'legacy_unclassified'")
if [[ "$PREPARED_STATUS" != "prepared" || "$LEGACY_COUNT" != "2" ]]; then
  echo "prepare was not dry-run-only" >&2
  exit 1
fi

pnpm --filter @capiro/api exec tsx \
  scripts/backfill-memory-governance-v2.ts \
  --tenant-id "$TENANT_ID" \
  --execute \
  --job-id "$JOB_ID" \
  --confirm-tenant "$TENANT_ID" \
  --confirm-job "$JOB_ID" >/dev/null

EXECUTED_STATUS=$(psql "$PSQL_DATABASE_URL" -Atc \
  "SELECT status FROM memory_governance_backfill_job WHERE id = '$JOB_ID'::uuid")
APPLIED_COUNT=$(psql "$PSQL_DATABASE_URL" -Atc \
  "SELECT count(*) FROM memory_governance_backfill_row WHERE job_id = '$JOB_ID'::uuid AND apply_status = 'applied'")
if [[ "$EXECUTED_STATUS" != "executed" || "$APPLIED_COUNT" != "2" ]]; then
  echo "exact prepared job did not execute atomically" >&2
  exit 1
fi

# Simulate a later human/system correction after the backfill. Rollback must
# preserve this changed row while restoring the untouched row.
psql "$PSQL_DATABASE_URL" -v ON_ERROR_STOP=1 -c \
  "UPDATE memory_items SET source_type = 'human_override' WHERE id = '$ITEM_DRIFT'::uuid" >/dev/null

pnpm --filter @capiro/api exec tsx \
  scripts/backfill-memory-governance-v2.ts \
  --tenant-id "$TENANT_ID" \
  --rollback \
  --job-id "$JOB_ID" \
  --confirm-tenant "$TENANT_ID" \
  --confirm-job "$JOB_ID" >/dev/null

JOB_STATUS=$(psql "$PSQL_DATABASE_URL" -Atc \
  "SELECT status FROM memory_governance_backfill_job WHERE id = '$JOB_ID'::uuid")
RESTORED_CLASS=$(psql "$PSQL_DATABASE_URL" -Atc \
  "SELECT memory_class FROM memory_items WHERE id = '$ITEM_RESTORE'::uuid")
DRIFT_SOURCE=$(psql "$PSQL_DATABASE_URL" -Atc \
  "SELECT source_type FROM memory_items WHERE id = '$ITEM_DRIFT'::uuid")
RESTORED_ROWS=$(psql "$PSQL_DATABASE_URL" -Atc \
  "SELECT count(*) FROM memory_governance_backfill_row WHERE job_id = '$JOB_ID'::uuid AND rollback_status = 'restored'")
SKIPPED_ROWS=$(psql "$PSQL_DATABASE_URL" -Atc \
  "SELECT count(*) FROM memory_governance_backfill_row WHERE job_id = '$JOB_ID'::uuid AND rollback_status = 'skipped_drift'")

if [[ "$JOB_STATUS" != "rollback_partial" ]]; then
  echo "rollback did not truthfully report preserved drift" >&2
  exit 1
fi
if [[ "$RESTORED_CLASS" != "legacy_unclassified" ]]; then
  echo "unchanged row was not restored to its exact before-state" >&2
  exit 1
fi
if [[ "$DRIFT_SOURCE" != "human_override" ]]; then
  echo "rollback overwrote a later governance change" >&2
  exit 1
fi
if [[ "$RESTORED_ROWS" != "1" || "$SKIPPED_ROWS" != "1" ]]; then
  echo "rollback row ledger is not exact" >&2
  exit 1
fi

# Event evidence must remain append-only.
if psql "$PSQL_DATABASE_URL" -v ON_ERROR_STOP=1 -c \
  "UPDATE memory_governance_backfill_event SET reason_code = 'tampered' WHERE job_id = '$JOB_ID'::uuid" \
  >/dev/null 2>&1; then
  echo "append-only event ledger accepted an UPDATE" >&2
  exit 1
fi

EVENT_TYPES=$(psql "$PSQL_DATABASE_URL" -Atc \
  "SELECT string_agg(DISTINCT event_type, ',' ORDER BY event_type) FROM memory_governance_backfill_event WHERE job_id = '$JOB_ID'::uuid")
for required in prepared execute_started execute_completed rollback_started row_restored row_skipped_drift rollback_completed; do
  if [[ ",$EVENT_TYPES," != *",$required,"* ]]; then
    echo "missing Phase 11 event: $required" >&2
    exit 1
  fi
done

echo "PHASE11_BACKFILL_ROLLBACK_OK job=$JOB_ID restored=$RESTORED_ROWS skipped=$SKIPPED_ROWS"
