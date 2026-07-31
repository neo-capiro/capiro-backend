#!/usr/bin/env bash
set -euo pipefail

: "${PSQL_DATABASE_URL:?PSQL_DATABASE_URL is required}"

PROBE_ID="44444444-4444-4444-8444-444444444444"
OWNER="11111111-1111-4111-8111-111111111111"
REVIEWER_A="22222222-2222-4222-8222-222222222222"
REVIEWER_B="33333333-3333-4333-8333-333333333333"
SECOND="55555555-5555-4555-8555-555555555555"

psql "$PSQL_DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
DROP TABLE IF EXISTS policy_pack_concurrency_probe;
CREATE TABLE policy_pack_concurrency_probe (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  pack_key varchar(120) NOT NULL,
  version varchar(80) NOT NULL,
  jurisdiction varchar(32) NOT NULL,
  status varchar(24) NOT NULL,
  legal_review_status varchar(40) NOT NULL,
  authority_jsonb jsonb NOT NULL,
  effective_from timestamptz NOT NULL,
  effective_until timestamptz,
  owner_user_id uuid NOT NULL,
  reviewed_by_user_id uuid,
  reviewed_at timestamptz,
  second_approved_by_user_id uuid,
  second_approved_at timestamptz,
  published_by_user_id uuid,
  published_at timestamptz,
  four_eyes_required boolean NOT NULL,
  rules_jsonb jsonb NOT NULL,
  fallback_outcome varchar(8) NOT NULL,
  non_production boolean NOT NULL,
  rules_hash varchar(64) NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT probe_non_production_check CHECK (NOT (non_production AND status = 'published'))
);
CREATE TRIGGER policy_pack_concurrency_probe_trigger
BEFORE UPDATE ON policy_pack_concurrency_probe
FOR EACH ROW
EXECUTE FUNCTION enforce_policy_pack_lifecycle_concurrency();
SQL

seed_pending() {
  psql "$PSQL_DATABASE_URL" -v ON_ERROR_STOP=1 <<SQL
TRUNCATE policy_pack_concurrency_probe;
INSERT INTO policy_pack_concurrency_probe (
  id, tenant_id, pack_key, version, jurisdiction, status,
  legal_review_status, authority_jsonb, effective_from, owner_user_id,
  four_eyes_required, rules_jsonb, fallback_outcome, non_production, rules_hash
) VALUES (
  '$PROBE_ID'::uuid,
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid,
  'probe-policy',
  'v1',
  'federal',
  'pending_review',
  'pending',
  '{"type":"approved_product_policy","title":"Probe"}'::jsonb,
  now(),
  '$OWNER'::uuid,
  true,
  '[{"id":"probe"}]'::jsonb,
  'WARN',
  true,
  repeat('a', 64)
);
SQL
}

expect_failure() {
  local expected="$1"
  shift
  local output
  local code
  set +e
  output=$("$@" 2>&1)
  code=$?
  set -e
  if [[ $code -eq 0 ]]; then
    echo "Expected command to fail with ${expected}, but it succeeded" >&2
    exit 1
  fi
  if ! grep -q "$expected" <<<"$output"; then
    echo "Expected failure ${expected}; received:" >&2
    echo "$output" >&2
    exit 1
  fi
}

seed_pending

# Two independent first reviewers race. Reviewer A takes the row lock and holds it;
# reviewer B must not overwrite A after the lock is released.
(
  psql "$PSQL_DATABASE_URL" -v ON_ERROR_STOP=1 <<SQL
BEGIN;
UPDATE policy_pack_concurrency_probe
SET reviewed_by_user_id = '$REVIEWER_A'::uuid,
    reviewed_at = clock_timestamp(),
    legal_review_status = 'approved'
WHERE id = '$PROBE_ID'::uuid;
SELECT pg_sleep(2);
COMMIT;
SQL
) >policy-reviewer-a.log 2>&1 &
reviewer_a_pid=$!
sleep 0.5
set +e
psql "$PSQL_DATABASE_URL" -v ON_ERROR_STOP=1 <<SQL >policy-reviewer-b.log 2>&1
UPDATE policy_pack_concurrency_probe
SET reviewed_by_user_id = '$REVIEWER_B'::uuid,
    reviewed_at = clock_timestamp(),
    legal_review_status = 'approved'
WHERE id = '$PROBE_ID'::uuid;
SQL
reviewer_b_code=$?
set -e
wait "$reviewer_a_pid"
if [[ $reviewer_b_code -eq 0 ]]; then
  echo "Concurrent reviewer B replaced reviewer A" >&2
  cat policy-reviewer-b.log >&2
  exit 1
fi
grep -q 'policy_pack_first_reviewer_immutable' policy-reviewer-b.log
winner=$(psql "$PSQL_DATABASE_URL" -At -v ON_ERROR_STOP=1 \
  -c "SELECT reviewed_by_user_id FROM policy_pack_concurrency_probe WHERE id = '$PROBE_ID'::uuid")
if [[ "$winner" != "$REVIEWER_A" ]]; then
  echo "Unexpected winning reviewer: $winner" >&2
  exit 1
fi

# The owner cannot review, and the second approver must be independent.
seed_pending
expect_failure policy_pack_owner_cannot_review \
  psql "$PSQL_DATABASE_URL" -v ON_ERROR_STOP=1 \
  -c "UPDATE policy_pack_concurrency_probe SET reviewed_by_user_id = '$OWNER'::uuid, reviewed_at = now() WHERE id = '$PROBE_ID'::uuid"

psql "$PSQL_DATABASE_URL" -v ON_ERROR_STOP=1 <<SQL
UPDATE policy_pack_concurrency_probe
SET reviewed_by_user_id = '$REVIEWER_A'::uuid,
    reviewed_at = now(),
    legal_review_status = 'approved'
WHERE id = '$PROBE_ID'::uuid;
SQL
expect_failure policy_pack_second_reviewer_not_independent \
  psql "$PSQL_DATABASE_URL" -v ON_ERROR_STOP=1 \
  -c "UPDATE policy_pack_concurrency_probe SET second_approved_by_user_id = '$REVIEWER_A'::uuid, second_approved_at = now(), status = 'reviewed' WHERE id = '$PROBE_ID'::uuid"
psql "$PSQL_DATABASE_URL" -v ON_ERROR_STOP=1 <<SQL
UPDATE policy_pack_concurrency_probe
SET second_approved_by_user_id = '$SECOND'::uuid,
    second_approved_at = now(),
    status = 'reviewed'
WHERE id = '$PROBE_ID'::uuid;
SQL

# Reviewed decision material and lifecycle cannot be rewritten or jumped.
expect_failure policy_pack_reviewed_material_immutable \
  psql "$PSQL_DATABASE_URL" -v ON_ERROR_STOP=1 \
  -c "UPDATE policy_pack_concurrency_probe SET rules_jsonb = '[{\"id\":\"tampered\"}]'::jsonb WHERE id = '$PROBE_ID'::uuid"

seed_pending
expect_failure policy_pack_illegal_lifecycle_transition \
  psql "$PSQL_DATABASE_URL" -v ON_ERROR_STOP=1 \
  -c "UPDATE policy_pack_concurrency_probe SET status = 'published' WHERE id = '$PROBE_ID'::uuid"
expect_failure policy_pack_stale_or_noop_transition \
  psql "$PSQL_DATABASE_URL" -v ON_ERROR_STOP=1 \
  -c "UPDATE policy_pack_concurrency_probe SET status = 'pending_review' WHERE id = '$PROBE_ID'::uuid"

# Rollback is an explicit published -> retired plus retired -> published pair.
psql "$PSQL_DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
TRUNCATE policy_pack_concurrency_probe;
INSERT INTO policy_pack_concurrency_probe (
  id, tenant_id, pack_key, version, jurisdiction, status,
  legal_review_status, authority_jsonb, effective_from, owner_user_id,
  reviewed_by_user_id, reviewed_at, second_approved_by_user_id, second_approved_at,
  published_by_user_id, published_at, four_eyes_required, rules_jsonb,
  fallback_outcome, non_production, rules_hash
) VALUES
(
  'aaaaaaaa-0000-4000-8000-000000000001',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'probe-policy', 'v2', 'federal', 'published', 'approved',
  '{"type":"approved_product_policy","title":"Probe"}', now(),
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222', now(),
  '33333333-3333-4333-8333-333333333333', now(),
  '55555555-5555-4555-8555-555555555555', now(),
  true, '[{"id":"probe"}]', 'WARN', false, repeat('a', 64)
),
(
  'aaaaaaaa-0000-4000-8000-000000000002',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'probe-policy', 'v1', 'federal', 'retired', 'approved',
  '{"type":"approved_product_policy","title":"Probe"}', now(),
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222', now(),
  '33333333-3333-4333-8333-333333333333', now(),
  '55555555-5555-4555-8555-555555555555', now(),
  true, '[{"id":"probe"}]', 'WARN', false, repeat('a', 64)
),
(
  'aaaaaaaa-0000-4000-8000-000000000003',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'probe-policy', 'example', 'federal', 'retired', 'approved',
  '{"type":"example_only","title":"Example"}', now(),
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222', now(),
  '33333333-3333-4333-8333-333333333333', now(),
  '55555555-5555-4555-8555-555555555555', now(),
  true, '[]', 'WARN', true, repeat('b', 64)
);

BEGIN;
UPDATE policy_pack_concurrency_probe
SET status = 'retired'
WHERE id = 'aaaaaaaa-0000-4000-8000-000000000001';
UPDATE policy_pack_concurrency_probe
SET status = 'published',
    published_by_user_id = '66666666-6666-4666-8666-666666666666',
    published_at = now()
WHERE id = 'aaaaaaaa-0000-4000-8000-000000000002';
COMMIT;

DO $$
BEGIN
  IF (SELECT status FROM policy_pack_concurrency_probe WHERE id = 'aaaaaaaa-0000-4000-8000-000000000001') <> 'retired'
     OR (SELECT status FROM policy_pack_concurrency_probe WHERE id = 'aaaaaaaa-0000-4000-8000-000000000002') <> 'published' THEN
    RAISE EXCEPTION 'rollback pair did not complete';
  END IF;
END;
$$;
SQL
expect_failure probe_non_production_check \
  psql "$PSQL_DATABASE_URL" -v ON_ERROR_STOP=1 \
  -c "UPDATE policy_pack_concurrency_probe SET status = 'published' WHERE id = 'aaaaaaaa-0000-4000-8000-000000000003'"

psql "$PSQL_DATABASE_URL" -v ON_ERROR_STOP=1 -c 'DROP TABLE policy_pack_concurrency_probe;'
echo POLICY_PACK_LIFECYCLE_CONCURRENCY_OK
