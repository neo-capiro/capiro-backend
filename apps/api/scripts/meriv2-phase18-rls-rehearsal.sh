#!/usr/bin/env bash
set -euo pipefail

: "${PSQL_DATABASE_URL:?PSQL_DATABASE_URL is required}"
: "${PHASE18_APP_DATABASE_URL:?PHASE18_APP_DATABASE_URL is required}"

TENANT_A='18180000-0000-4000-8000-000000000101'
TENANT_B='18180000-0000-4000-8000-000000000102'
USER_A='18180000-0000-4000-8000-000000000111'
USER_B='18180000-0000-4000-8000-000000000112'
PRIVATE_A='18180000-0000-4000-8000-000000000121'
PRIVATE_B='18180000-0000-4000-8000-000000000122'
AUDIT_A='18180000-0000-4000-8000-000000000131'
AUDIT_B='18180000-0000-4000-8000-000000000132'

admin() { psql "$PSQL_DATABASE_URL" -v ON_ERROR_STOP=1 -qAt "$@"; }
app() { psql "$PHASE18_APP_DATABASE_URL" -v ON_ERROR_STOP=1 -qAt "$@"; }

PASSES=0
pass() { PASSES=$((PASSES + 1)); echo "PASS $1"; }
fail() { echo "FAIL $1" >&2; exit 1; }
eq() {
  local name="$1" actual="$2" expected="$3"
  [[ "$actual" == "$expected" ]] && pass "$name ($actual)" || fail "$name expected=$expected actual=$actual"
}
expect_rls_failure() {
  local name="$1"; shift
  local output code
  set +e
  output=$("$@" 2>&1)
  code=$?
  set -e
  if [[ $code -eq 0 ]]; then
    fail "$name unexpectedly succeeded"
  fi
  if ! grep -qi 'row-level security' <<<"$output"; then
    echo "$output" >&2
    fail "$name failed for a reason other than RLS"
  fi
  pass "$name"
}

cleanup() {
  admin -c "DELETE FROM tenants WHERE id IN ('$TENANT_A'::uuid, '$TENANT_B'::uuid);" >/dev/null 2>&1 || true
  admin -c "DELETE FROM users WHERE id IN ('$USER_A'::uuid, '$USER_B'::uuid);" >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup

admin >/dev/null <<SQL
INSERT INTO users (id, clerk_user_id, email)
VALUES
  ('$USER_A'::uuid, 'phase18-rls-a', 'phase18-rls-a@invalid.example'),
  ('$USER_B'::uuid, 'phase18-rls-b', 'phase18-rls-b@invalid.example');
INSERT INTO tenants (id, slug, name, status)
VALUES
  ('$TENANT_A'::uuid, 'phase18-rls-a', 'Phase 18 RLS A', 'active'),
  ('$TENANT_B'::uuid, 'phase18-rls-b', 'Phase 18 RLS B', 'active');
INSERT INTO memory_items
  (id, tenant_id, owner_user_id, type, visibility, slug, title, source, provenance,
   memory_class, memory_authority, memory_scope, governed_status)
VALUES
  ('$PRIVATE_A'::uuid, '$TENANT_A'::uuid, '$USER_A'::uuid, 'user-voice', 'user',
   'phase18-private-a', 'Private A', 'manual', 'human',
   'user_preference', 'user_asserted', 'user_private', 'active'),
  ('$PRIVATE_B'::uuid, '$TENANT_A'::uuid, '$USER_B'::uuid, 'user-voice', 'user',
   'phase18-private-b', 'Private B', 'manual', 'human',
   'user_preference', 'user_asserted', 'user_private', 'active');
INSERT INTO memory_transition_audit
  (id, tenant_id, memory_candidate_id, effective_tenant_id, to_status, reason_code, reason)
VALUES
  ('$AUDIT_B'::uuid, '$TENANT_B'::uuid, gen_random_uuid(), '$TENANT_B'::uuid,
   'pending_review', 'proposed', 'Phase 18 tenant B fixture');
SQL

# Every Phase 18 tenant table must be RLS-enabled and RLS-forced.
RLS_BAD=$(admin -c "
  SELECT count(*)
  FROM (VALUES
    ('memory_access_grant'), ('memory_transition_audit'), ('memory_cleanup_outbox'),
    ('compliance_policy_pack'), ('compliance_policy_pack_event'), ('compliance_policy_decision'),
    ('assurance_eval_run'), ('assurance_eval_result'), ('assurance_eval_domain_gate'),
    ('assurance_feedback_candidate'), ('assurance_eval_fixture'),
    ('memory_governance_backfill_job'), ('memory_governance_backfill_row'),
    ('memory_governance_backfill_event')
  ) expected(name)
  LEFT JOIN pg_class c ON c.oid = to_regclass(expected.name)
  WHERE c.oid IS NULL OR NOT c.relrowsecurity OR NOT c.relforcerowsecurity;")
eq "all governed tables have ENABLE + FORCE RLS" "$RLS_BAD" 0

# Runtime role without tenant/user context is fail-closed.
eq "no tenant context sees zero transition rows" \
  "$(app -c 'SELECT count(*) FROM memory_transition_audit;')" 0
eq "no tenant context sees zero private memory rows" \
  "$(app -c 'SELECT count(*) FROM memory_items WHERE visibility = '\''user'\'';')" 0

# Same-tenant insert and read through the real application role.
SAME=$(app -c "
  SELECT set_config('app.current_tenant', '$TENANT_A', false);
  SELECT set_config('app.current_user', '$USER_A', false);
  INSERT INTO memory_transition_audit
    (id, tenant_id, memory_candidate_id, effective_tenant_id, to_status, reason_code, reason)
  VALUES
    ('$AUDIT_A'::uuid, '$TENANT_A'::uuid, gen_random_uuid(), '$TENANT_A'::uuid,
     'pending_review', 'proposed', 'Phase 18 same-tenant insert');
  SELECT count(*) FROM memory_transition_audit WHERE id = '$AUDIT_A'::uuid;" | tail -1)
eq "same tenant application-role insert/read" "$SAME" 1

# WITH CHECK denies cross-tenant writes.
expect_rls_failure "cross-tenant insert denied" app -c "
  SELECT set_config('app.current_tenant', '$TENANT_A', false);
  SELECT set_config('app.current_user', '$USER_A', false);
  INSERT INTO memory_transition_audit
    (tenant_id, memory_candidate_id, effective_tenant_id, to_status, reason_code, reason)
  VALUES
    ('$TENANT_B'::uuid, gen_random_uuid(), '$TENANT_B'::uuid,
     'pending_review', 'proposed', 'must be denied');"

# USING hides cross-tenant UPDATE and DELETE targets.
UPDATED=$(app -c "
  SELECT set_config('app.current_tenant', '$TENANT_A', false);
  UPDATE memory_transition_audit SET reason = 'tamper' WHERE id = '$AUDIT_B'::uuid;
  SELECT count(*) FROM memory_transition_audit WHERE id = '$AUDIT_B'::uuid;" | tail -1)
eq "cross-tenant update target is invisible" "$UPDATED" 0
DELETED=$(app -c "
  SELECT set_config('app.current_tenant', '$TENANT_A', false);
  DELETE FROM memory_transition_audit WHERE id = '$AUDIT_B'::uuid;
  SELECT count(*) FROM memory_transition_audit WHERE id = '$AUDIT_B'::uuid;" | tail -1)
eq "cross-tenant delete target is invisible" "$DELETED" 0
eq "tenant B audit row remains present" \
  "$(admin -c "SELECT count(*) FROM memory_transition_audit WHERE id = '$AUDIT_B'::uuid;")" 1

# Private owner isolation uses app.current_user in addition to tenant scope.
OWNER_A=$(app -c "
  SELECT set_config('app.current_tenant', '$TENANT_A', false);
  SELECT set_config('app.current_user', '$USER_A', false);
  SELECT count(*) FROM memory_items WHERE id IN ('$PRIVATE_A'::uuid, '$PRIVATE_B'::uuid);" | tail -1)
eq "private owner sees only their own row" "$OWNER_A" 1
OWNER_B=$(app -c "
  SELECT set_config('app.current_tenant', '$TENANT_A', false);
  SELECT set_config('app.current_user', '$USER_B', false);
  SELECT count(*) FROM memory_items WHERE id IN ('$PRIVATE_A'::uuid, '$PRIVATE_B'::uuid);" | tail -1)
eq "second private owner sees only their own row" "$OWNER_B" 1

echo "MERIV2_PHASE18_RLS_REHEARSAL_OK checks=$PASSES"
