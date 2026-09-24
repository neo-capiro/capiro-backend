#!/usr/bin/env bash
# Self-contained end-to-end rehearsal for
# replace-defense-budget-candidate-approvals-v1.ts -- disposable Postgres
# only (no MinIO: every fixture candidate uses a plain filesystem
# extraction-artifact locator, which the production byte-locator reader
# already supports for local paths). Own container, own port, always torn
# down. Modeled on scripts/phase10b35c-candidate-correction-e2e-rehearsal.sh.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

SUFFIX="$RANDOM-$$"
PG_NAME="capiro-replace-approvals-e2e-pg-$SUFFIX"
PG_PORT="${REPLACE_APPROVALS_PG_PORT:-0}"
PASSWORD="replace-approvals-rehearsal"
PACKAGE_C_MIGRATION="20280919020000_approval_replacement_commit_guards"
UPGRADE_TMP="$(mktemp -d)"

cleanup() {
  docker rm -f "$PG_NAME" >/dev/null 2>&1 || true
  rm -rf "$UPGRADE_TMP"
}
trap cleanup EXIT

echo "Starting disposable Postgres ($PG_NAME)..." >&2
if [[ "$PG_PORT" == "0" ]]; then
  docker run -d --name "$PG_NAME" -e POSTGRES_PASSWORD="$PASSWORD" -e POSTGRES_DB=capiro -P pgvector/pgvector:pg16 >/dev/null
  PG_PORT="$(docker port "$PG_NAME" 5432/tcp | head -1 | cut -d: -f2)"
else
  docker run -d --name "$PG_NAME" -e POSTGRES_PASSWORD="$PASSWORD" -e POSTGRES_DB=capiro -p "$PG_PORT:5432" pgvector/pgvector:pg16 >/dev/null
fi

pg_ok=0
for _ in $(seq 1 60); do
  if docker exec "$PG_NAME" pg_isready -U postgres >/dev/null 2>&1; then pg_ok=1; sleep 1; break; fi
  sleep 1
done
if [[ "$pg_ok" != "1" ]]; then
  echo "Postgres never became ready" >&2
  exit 1
fi

export DATABASE_URL="postgresql://postgres:${PASSWORD}@localhost:${PG_PORT}/capiro"
echo "Postgres ready at localhost:${PG_PORT}. Validating schema and regenerating Prisma Client..." >&2

npx prisma validate >/dev/null
npx prisma generate >/dev/null
echo "Generated client is current. Rehearsing a real pre-Package-C upgrade..." >&2

cp -R prisma "$UPGRADE_TMP/prisma"
rm -rf "$UPGRADE_TMP/prisma/migrations/$PACKAGE_C_MIGRATION"
npx prisma migrate deploy --schema "$UPGRADE_TMP/prisma/schema.prisma" >/dev/null

# Seed through the actual pre-migration schema: this row has neither the exact
# revocation-ack column nor the eligibility-seal columns yet. Package C must
# add nullable legacy fields without rewriting its immutable hash-v1 identity.
docker exec -i "$PG_NAME" psql -v ON_ERROR_STOP=1 -U postgres -d capiro >/dev/null <<'SQL'
INSERT INTO "source_document" (
  "id", "source_key", "fiscal_year", "budget_cycle", "component", "document_type",
  "title", "source_url", "sha256", "extraction_method"
) VALUES (
  '44444444-4444-4444-8444-444444444444', 'package-c-legacy-upgrade', 2024, 'pb', 'ARMY', 'r2',
  'Package C legacy upgrade fixture', 'https://example.invalid/package-c-legacy.pdf',
  repeat('a', 64), 'deterministic_pdf'
);

INSERT INTO "budget_extraction_candidate_v1" (
  "id", "cycle_id", "manifest_content_sha256", "manifest_document_key",
  "extraction_artifact_id", "extraction_artifact_sha256", "source_document_id",
  "source_sha256", "verifier_version", "policy_version", "policy_sha256", "status"
) VALUES (
  '22222222-2222-4222-8222-222222222222', 'fy2024:package-c-legacy', repeat('c', 64),
  'package-c-legacy-manifest', 'legacy-artifact', repeat('b', 64),
  '44444444-4444-4444-8444-444444444444', repeat('a', 64),
  'legacy-verifier-v1', '1', repeat('d', 64), 'NEEDS_REVIEW'
);

INSERT INTO "budget_verification_run_v1" (
  "id", "candidate_id", "verifier_version", "policy_version", "policy_sha256",
  "decision", "status", "route", "risk_score", "started_at", "completed_at",
  "manifest_content_sha256", "extraction_artifact_sha256", "source_sha256", "result_snapshot_jsonb"
) VALUES (
  '33333333-3333-4333-8333-333333333333', '22222222-2222-4222-8222-222222222222',
  'legacy-verifier-v1', '1', repeat('d', 64), 'REVIEW', 'NEEDS_REVIEW', 'human_review', 0,
  '2026-09-18T12:00:00Z', '2026-09-18T12:00:01Z', repeat('c', 64), repeat('b', 64),
  repeat('a', 64), '{}'::jsonb
);
UPDATE "budget_extraction_candidate_v1"
   SET "current_run_id" = '33333333-3333-4333-8333-333333333333'
 WHERE "id" = '22222222-2222-4222-8222-222222222222';

-- A separate pre-Package-C correction proves the additive migration keeps
-- immutable legacy links readable with NULL reviewed-intent fields. It is
-- intentionally unbound by the new contract and must fail closed on replay.
INSERT INTO "budget_extraction_candidate_v1" (
  "id", "cycle_id", "manifest_content_sha256", "manifest_document_key",
  "extraction_artifact_id", "extraction_artifact_sha256", "source_document_id",
  "source_sha256", "verifier_version", "policy_version", "policy_sha256", "status"
) VALUES
  (
    '66666666-6666-4666-8666-666666666666', 'fy2024:package-c-legacy-correction-old', repeat('e', 64),
    'package-c-legacy-correction-old-manifest', 'legacy-correction-old-artifact', repeat('f', 64),
    '44444444-4444-4444-8444-444444444444', repeat('a', 64),
    'legacy-verifier-v1', '1', repeat('d', 64), 'NEEDS_REVIEW'
  ),
  (
    '77777777-7777-4777-8777-777777777777', 'fy2024:package-c-legacy-correction-new', repeat('1', 64),
    'package-c-legacy-correction-new-manifest', 'legacy-correction-new-artifact', repeat('2', 64),
    '44444444-4444-4444-8444-444444444444', repeat('a', 64),
    'legacy-verifier-v1', '1', repeat('d', 64), 'NEEDS_REVIEW'
  );

INSERT INTO "budget_candidate_correction_v1" (
  "id", "old_candidate_id", "new_candidate_id", "old_candidate_status_at_correction",
  "old_candidate_source_document_id", "old_candidate_source_sha256",
  "new_candidate_source_document_id", "new_candidate_source_sha256",
  "superseded_scoped_fact_review_ids_jsonb", "actor", "reason"
) VALUES (
  '55555555-5555-4555-8555-555555555555',
  '66666666-6666-4666-8666-666666666666',
  '77777777-7777-4777-8777-777777777777',
  'NEEDS_REVIEW', '44444444-4444-4444-8444-444444444444', repeat('a', 64),
  '44444444-4444-4444-8444-444444444444', repeat('a', 64),
  '[]'::jsonb, 'legacy-upgrade-fixture', 'pre-Package-C correction without reviewed intent'
);

INSERT INTO "budget_scoped_fact_review_v1" (
  "id", "candidate_id", "run_id", "source_document_id", "source_sha256",
  "extraction_artifact_id", "extraction_artifact_sha256", "manifest_content_sha256",
  "policy_id", "policy_version", "policy_sha256", "scope_kind", "scope_key", "scope_jsonb",
  "assertion_ids_jsonb", "evidence_ids_jsonb", "projection_jsonb", "independence_jsonb",
  "limitations_jsonb", "decision", "reviewer_id", "rationale", "decision_hash", "status"
) VALUES (
  '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444',
  repeat('a', 64), 'legacy-artifact', repeat('b', 64), repeat('c', 64),
  'rdte_r2_pe_total_review_policy_v1', '1', repeat('d', 64),
  'rdte_r2_pe_total_request_fy', 'rdte_r2_pe_total_request_fy:ARMY:0601102A:2024:request',
  '{"scopeKind":"rdte_r2_pe_total_request_fy","peCode":"0601102A","fiscalYear":2024,"fundingField":"request","component":"ARMY"}'::jsonb,
  '["assertion-a"]'::jsonb, '["evidence-a"]'::jsonb,
  '{"peCode":"0601102A","fiscalYear":2024,"fundingField":"request","totalMillions":"10.5","component":"ARMY","source":{"physicalPage":101}}'::jsonb,
  '{}'::jsonb, '[]'::jsonb, 'approve', 'legacy-reviewer@example.com', 'legacy upgrade rationale',
  '3b83a9e30e4f154579fdd9a79000ce1d6a458218373438266b29a30365393971', 'active'
);

-- Seed a revoked legacy row as well: the generation backfill must cross the
-- old immutability trigger safely without changing either legacy status.
INSERT INTO "budget_scoped_fact_review_v1" (
  "id", "candidate_id", "run_id", "source_document_id", "source_sha256",
  "extraction_artifact_id", "extraction_artifact_sha256", "manifest_content_sha256",
  "policy_id", "policy_version", "policy_sha256", "scope_kind", "scope_key", "scope_jsonb",
  "assertion_ids_jsonb", "evidence_ids_jsonb", "projection_jsonb", "independence_jsonb",
  "limitations_jsonb", "decision", "reviewer_id", "rationale", "decision_hash", "status"
) VALUES (
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444',
  repeat('a', 64), 'legacy-artifact', repeat('b', 64), repeat('c', 64),
  'rdte_r2_pe_total_review_policy_v1', '1', repeat('d', 64),
  'rdte_r2_pe_total_request_fy', 'rdte_r2_pe_total_request_fy:ARMY:0601103A:2024:request',
  '{"scopeKind":"rdte_r2_pe_total_request_fy","peCode":"0601103A","fiscalYear":2024,"fundingField":"request","component":"ARMY"}'::jsonb,
  '["assertion-b"]'::jsonb, '["evidence-b"]'::jsonb,
  '{"peCode":"0601103A","fiscalYear":2024,"fundingField":"request","totalMillions":"11.5","component":"ARMY","source":{"physicalPage":102}}'::jsonb,
  '{}'::jsonb, '[]'::jsonb, 'approve', 'legacy-reviewer@example.com', 'legacy revoked rationale',
  repeat('9', 64), 'active'
);
UPDATE "budget_scoped_fact_review_v1"
   SET "status" = 'revoked',
       "revoked_at" = '2099-01-01T00:00:00Z',
       "revoked_by" = 'legacy-reviewer@example.com',
       "revocation_reason" = 'legacy revoked before Package C'
 WHERE "id" = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
SQL

# Restore the canonical migration directory only after the legacy fixture is
# present, then exercise the same deploy path the repository permits in real
# environments. Never substitute raw psql + `migrate resolve`: that can hide
# migration-ledger or deploy-order failures and is forbidden by the migration
# gate.
cp -R "prisma/migrations/$PACKAGE_C_MIGRATION" "$UPGRADE_TMP/prisma/migrations/$PACKAGE_C_MIGRATION"
npx prisma migrate deploy --schema "$UPGRADE_TMP/prisma/schema.prisma" >/dev/null

echo "Package C migration applied over a real legacy row. Proving grandfathered read/reconcile/revoke behavior..." >&2
APPROVAL_REPLACEMENT_UPGRADE_REHEARSAL=1 node --experimental-vm-modules node_modules/jest/bin/jest.js \
  --runInBand --forceExit --cacheDirectory "${REPLACE_APPROVALS_JEST_CACHE_DIR:-/tmp/replace-approvals-jestcache}" \
  scripts/approval-replacement-upgrade.integration.spec.ts

echo "Upgrade proof passed. Confirming migration ledger and running replacement + transactional hardening specs..." >&2
npx prisma migrate deploy >/dev/null

JEST_CACHE_DIR="${REPLACE_APPROVALS_JEST_CACHE_DIR:-/tmp/replace-approvals-jestcache}"
node --experimental-vm-modules node_modules/jest/bin/jest.js --runInBand --forceExit \
  --cacheDirectory "$JEST_CACHE_DIR" \
  scripts/replace-defense-budget-candidate-approvals-v1-reconciliation.spec.ts \
  scripts/replace-defense-budget-candidate-approvals-v1.integration.spec.ts \
  src/defense-budget/governed-acceptance/candidate-correction/phase10b41-hardening.integration.spec.ts \
  src/defense-budget/governed-acceptance/scoped-fact-review/reviewed-partial-pe-totals-prisma-repository-v1.spec.ts
