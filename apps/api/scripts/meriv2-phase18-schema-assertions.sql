\set ON_ERROR_STOP on

DO $$
DECLARE
  missing text[];
BEGIN
  SELECT array_agg(name ORDER BY name)
  INTO missing
  FROM (VALUES
    ('memory_access_grant'),
    ('memory_transition_audit'),
    ('memory_cleanup_outbox'),
    ('compliance_policy_pack'),
    ('compliance_policy_pack_event'),
    ('compliance_policy_decision'),
    ('assurance_eval_run'),
    ('assurance_eval_result'),
    ('assurance_eval_domain_gate'),
    ('assurance_feedback_candidate'),
    ('assurance_eval_fixture'),
    ('memory_governance_backfill_job'),
    ('memory_governance_backfill_row'),
    ('memory_governance_backfill_event')
  ) AS expected(name)
  WHERE to_regclass(expected.name) IS NULL;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'missing Phase 18 tables: %', missing;
  END IF;
END
$$;

DO $$
DECLARE
  missing text[];
BEGIN
  SELECT array_agg(table_name || '.' || column_name ORDER BY table_name, column_name)
  INTO missing
  FROM (VALUES
    ('memory_items','memory_class'),
    ('memory_items','memory_authority'),
    ('memory_items','memory_scope'),
    ('memory_items','governed_status'),
    ('memory_items','source_type'),
    ('memory_items','approved_by_user_id'),
    ('memory_items','second_approved_by_user_id'),
    ('memory_items','legal_hold'),
    ('memory_items','conflict_group_id'),
    ('memory_items','controlling_item_id'),
    ('memory_candidate','committed_memory_item_id'),
    ('memory_candidate','duplicate_memory_item_id'),
    ('memory_candidate','contradicts_memory_item_id'),
    ('memory_cleanup_outbox','lease_owner'),
    ('memory_cleanup_outbox','lease_expires_at'),
    ('memory_cleanup_outbox','dead_lettered_at'),
    ('memory_cleanup_outbox','expected_source_version'),
    ('memory_cleanup_outbox','expected_content_hash'),
    ('memory_cleanup_outbox','superseded_at'),
    ('context_packet','packet_version'),
    ('context_packet','compiler_version'),
    ('context_packet','policy_version'),
    ('context_packet','health_jsonb'),
    ('compliance_policy_pack','rules_hash'),
    ('compliance_policy_decision','decision_hash'),
    ('memory_governance_backfill_job','plan_hash')
  ) AS expected(table_name, column_name)
  WHERE NOT EXISTS (
    SELECT 1
    FROM information_schema.columns c
    WHERE c.table_schema = current_schema()
      AND c.table_name = expected.table_name
      AND c.column_name = expected.column_name
  );
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'missing Phase 18 columns: %', missing;
  END IF;
END
$$;

DO $$
DECLARE
  bad text[];
BEGIN
  SELECT array_agg(name ORDER BY name)
  INTO bad
  FROM (VALUES
    ('memory_access_grant'),
    ('memory_transition_audit'),
    ('memory_cleanup_outbox'),
    ('compliance_policy_pack'),
    ('compliance_policy_pack_event'),
    ('compliance_policy_decision'),
    ('assurance_eval_run'),
    ('assurance_eval_result'),
    ('assurance_eval_domain_gate'),
    ('assurance_feedback_candidate'),
    ('assurance_eval_fixture'),
    ('memory_governance_backfill_job'),
    ('memory_governance_backfill_row'),
    ('memory_governance_backfill_event')
  ) AS expected(name)
  LEFT JOIN pg_class c ON c.oid = to_regclass(expected.name)
  WHERE c.oid IS NULL OR NOT c.relrowsecurity OR NOT c.relforcerowsecurity;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'RLS not enabled and forced: %', bad;
  END IF;
END
$$;

DO $$
DECLARE
  missing text[];
BEGIN
  SELECT array_agg(name ORDER BY name)
  INTO missing
  FROM (VALUES
    ('memory_items_governed_recall_idx'),
    ('memory_candidate_governed_queue_idx'),
    ('memory_access_grant_unique_active'),
    ('memory_cleanup_outbox_idempotency_key'),
    ('memory_cleanup_outbox_worker_due_idx'),
    ('memory_cleanup_outbox_dead_letter_idx'),
    ('compliance_policy_pack_published_unique'),
    ('memory_governance_backfill_job_tenant_time_idx'),
    ('memory_governance_backfill_row_tenant_item_idx')
  ) AS expected(name)
  WHERE to_regclass(expected.name) IS NULL;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'missing Phase 18 indexes: %', missing;
  END IF;
END
$$;

DO $$
DECLARE
  missing text[];
BEGIN
  SELECT array_agg(name ORDER BY name)
  INTO missing
  FROM (VALUES
    ('memory_items_governed_status_check'),
    ('memory_candidate_governed_status_check'),
    ('memory_candidate_status_check'),
    ('memory_cleanup_operation_check'),
    ('memory_cleanup_status_check'),
    ('compliance_policy_pack_non_production_check'),
    ('compliance_policy_pack_four_eyes_check'),
    ('memory_transition_exact_subject_check')
  ) AS expected(name)
  WHERE NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = expected.name);
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'missing Phase 18 constraints: %', missing;
  END IF;
END
$$;

DO $$
DECLARE
  expected text[] := ARRAY[
    '20260729010000_memory_governance_context_v2',
    '20260729011000_memory_governance_lineage',
    '20260811010000_assurance_policy_packs',
    '20260811020000_assurance_eval_runs',
    '20260811030000_assurance_feedback_fixtures',
    '20260811040000_memory_index_outbox_subject',
    '20260812010000_memory_immutable_versions',
    '20260812020000_memory_cleanup_worker_leases',
    '20260812030000_memory_projection_exact_completion',
    '20260813010000_policy_pack_action_authority',
    '20260813020000_policy_pack_lifecycle_concurrency',
    '20260814010000_memory_governance_backfill_jobs',
    '20260814011000_memory_governance_backfill_delete_guards',
    '20260815010000_memory_candidate_withdrawal'
  ];
  missing text[];
BEGIN
  SELECT array_agg(name ORDER BY name)
  INTO missing
  FROM unnest(expected) AS name
  WHERE NOT EXISTS (
    SELECT 1 FROM _prisma_migrations
    WHERE migration_name = name AND finished_at IS NOT NULL AND rolled_back_at IS NULL
  );
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'unapplied Phase 18 migrations: %', missing;
  END IF;
END
$$;

SELECT json_build_object(
  'marker', 'MERIV2_PHASE18_SCHEMA_ASSERTIONS_OK',
  'database', current_database(),
  'server_version', current_setting('server_version'),
  'vector_version', (SELECT extversion FROM pg_extension WHERE extname = 'vector'),
  'applied_migrations', (SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL),
  'phase18_tables', 14
);
