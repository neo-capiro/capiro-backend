/** Minimal local schema for actual canonical service qualification; no shared DDL. */
export function memoryFixtureSchemaSql(schema) {
  if (!/^meri_approved_[a-f0-9]{32}$/.test(schema)) throw new Error('Invalid owned schema');
  return `
      CREATE TABLE "${schema}".tenants(id uuid PRIMARY KEY, slug text);
      CREATE TYPE "${schema}".tenant_role AS ENUM ('capiro_admin','user_admin','standard_user','client_portal_user');
      CREATE TABLE "${schema}".tenant_memberships(tenant_id uuid, user_id uuid, status text, role "${schema}".tenant_role DEFAULT 'standard_user');
      CREATE TABLE "${schema}".clients(id uuid PRIMARY KEY, tenant_id uuid, memory_wall boolean NOT NULL DEFAULT false, status text DEFAULT 'active');
      CREATE TABLE "${schema}".client_memory_access(tenant_id uuid, client_id uuid, user_id uuid);
      CREATE TABLE "${schema}".clio_memory(id uuid PRIMARY KEY, tenant_id uuid, scope text, key text, owner_user_id uuid, client_id uuid,
        value text, source text, metadata_jsonb jsonb DEFAULT '{}', expires_at timestamptz,
        created_at timestamptz DEFAULT clock_timestamp(), updated_at timestamptz DEFAULT clock_timestamp());
      CREATE TABLE "${schema}".memory_candidate(
        id uuid PRIMARY KEY, tenant_id uuid, proposed_by uuid, source_kind text,
        scope text, client_id uuid, payload_jsonb jsonb, provenance_jsonb jsonb,
        duplicate_of_id uuid, status text, confidence float,
        source_type text, source_id text, memory_class text DEFAULT 'legacy_unclassified',
        memory_authority text DEFAULT 'legacy_unclassified', contradicts_memory_item_id uuid,
        conflict_status text, committed_memory_id uuid, committed_memory_item_id uuid,
        decided_at timestamptz, created_at timestamptz DEFAULT clock_timestamp(),
        governed_status text DEFAULT 'suggested', instructions_allowed boolean DEFAULT false,
        approved_at timestamptz, approved_by_user_id uuid,
        revision_root_id uuid, predecessor_candidate_id uuid, revision_number int DEFAULT 1,
        superseded_by_id uuid, contradicts_id uuid, decided_by uuid,
        memory_scope text DEFAULT 'firm', source_ref text, source_excerpt text,
        source_content_hash text, source_version text, asserted_by_user_id uuid,
        second_approved_by_user_id uuid, second_approved_at timestamptz,
        as_of timestamptz, effective_from timestamptz, valid_until timestamptz,
        expires_at timestamptz, review_cadence_days int, review_due_at timestamptz,
        conflict_group_id uuid, controlling_item_id uuid, sensitivity text DEFAULT 'normal',
        retention_policy_jsonb jsonb, legal_hold boolean DEFAULT false,
        origin_surface text, origin_trace_id text, origin_context_packet_id uuid,
        origin_model text, origin_prompt_version text, duplicate_memory_item_id uuid
      );
      CREATE TABLE "${schema}".memory_transition_audit(
        id uuid PRIMARY KEY, tenant_id uuid, memory_item_id uuid, memory_candidate_id uuid,
        actor_user_id uuid, effective_tenant_id uuid, client_id uuid,
        from_status text, to_status text, reason_code text, reason text, source_type text,
        source_id text, proposal_id uuid, impersonation_session_id uuid,
        metadata_jsonb jsonb DEFAULT '{}', occurred_at timestamptz DEFAULT clock_timestamp()
      );
      CREATE TABLE "${schema}".review_request(id uuid PRIMARY KEY, tenant_id uuid, subject_id text, status text);
      CREATE TABLE "${schema}".memory_access_grant(id uuid PRIMARY KEY,tenant_id uuid,client_id uuid,user_id uuid,
        permissions text[],status text,expires_at timestamptz,reason text,created_at timestamptz DEFAULT clock_timestamp());
      CREATE TABLE "${schema}".memory_items(
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid,client_id uuid,owner_user_id uuid,
        type text,visibility text,entity_id uuid,slug text,title text,aliases text[],tags text[],source text,
        source_ref text,provenance text,sections_jsonb jsonb,schema_version int,status text,sensitivity text,
        legal_hold boolean,exportable boolean,training_use text,expires_at timestamptz,confidence float,
        memory_class text DEFAULT 'legacy_unclassified',memory_authority text DEFAULT 'legacy_unclassified',
        memory_scope text,governed_status text DEFAULT 'pending_review',source_type text,
        source_id text,source_excerpt text,source_content_hash text,source_version text,asserted_by_user_id uuid,
        approved_by_user_id uuid,approved_at timestamptz,second_approved_by_user_id uuid,second_approved_at timestamptz,
        last_confirmed_at timestamptz,review_state text,review_due_at timestamptz,retention_policy_jsonb jsonb,
        as_of timestamptz,effective_from timestamptz,valid_until timestamptz,conflict_status text,conflict_group_id uuid,
        controlling_item_id uuid,origin_surface text,origin_trace_id text,origin_context_packet_id uuid,
        origin_model text,origin_prompt_version text,instructions_allowed boolean,revoked_at timestamptz,revoked_by uuid,
        ingest_run_id uuid,ingested_at timestamptz,
        created_at timestamptz DEFAULT clock_timestamp(),updated_at timestamptz DEFAULT clock_timestamp(),UNIQUE(tenant_id,type,slug)
      );
      CREATE TABLE "${schema}".memory_edges(tenant_id uuid,src_item_id uuid,relation text,dst_type text,dst_slug text,
        UNIQUE(src_item_id,relation,dst_type,dst_slug));
      CREATE TABLE "${schema}".memory_cleanup_outbox(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid,
        memory_item_id uuid,clio_memory_id uuid,operation text,idempotency_key text,status text DEFAULT 'pending',
        UNIQUE(tenant_id,idempotency_key));
      CREATE TABLE "${schema}".context_embeddings(source_type text,source_id text);
      CREATE TABLE "${schema}".audit_logs(id uuid PRIMARY KEY,tenant_id uuid,actor_user_id uuid,actor_role text,
        action text,entity_type text,entity_id text,before_jsonb jsonb,after_jsonb jsonb,ip text,user_agent text,
        request_id text,occurred_at timestamptz DEFAULT clock_timestamp())
  `;
}
