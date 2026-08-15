-- Knowledge Plane — Phase 5A hardening.
--
-- The initial Universal Entity Resolution migration established the canonical
-- registry. This migration closes the remaining integrity gaps before source
-- adapters/backfill begin:
--   * immutable identity scope/type and immutable alias/identifier provenance;
--   * safe merge semantics (same type, visible target, no cross-tenant target);
--   * candidate arrays may contain only active entities visible to the tenant;
--   * corrected resolutions must preserve the original query and name an actor;
--   * the selected entity must be one of the recorded candidates.
--
-- Corrections create new rows. Scope changes create a new canonical entity and
-- merge the old tenant-private entity into it. Neither path rewrites history.

ALTER TABLE "entity_resolutions"
  ADD CONSTRAINT "entity_resolutions_correction_state_check"
  CHECK (
    (
      "status" = 'corrected'
      AND "correction_of_resolution_id" IS NOT NULL
      AND "actor_user_id" IS NOT NULL
    )
    OR
    (
      "status" <> 'corrected'
      AND "correction_of_resolution_id" IS NULL
    )
  );

CREATE OR REPLACE FUNCTION enforce_canonical_entity_invariants()
RETURNS trigger AS $$
DECLARE
  v_target_scope TEXT;
  v_target_tenant UUID;
  v_target_type TEXT;
  v_target_status TEXT;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.identity_scope IS DISTINCT FROM OLD.identity_scope THEN
      RAISE EXCEPTION
        'Canonical entity scope is immutable; create a new entity and merge instead'
        USING ERRCODE = '55000';
    END IF;

    IF NEW.entity_type IS DISTINCT FROM OLD.entity_type THEN
      RAISE EXCEPTION
        'Canonical entity type is immutable; create a corrected entity instead'
        USING ERRCODE = '55000';
    END IF;
  END IF;

  IF NEW.status = 'merged' THEN
    SELECT identity_scope, tenant_id, entity_type, status
      INTO v_target_scope, v_target_tenant, v_target_type, v_target_status
    FROM canonical_entities
    WHERE id = NEW.merged_into_entity_id;

    IF v_target_scope IS NULL OR v_target_status <> 'active' THEN
      RAISE EXCEPTION 'Canonical entity merge target must exist and be active'
        USING ERRCODE = '23503';
    END IF;

    IF v_target_type <> NEW.entity_type THEN
      RAISE EXCEPTION 'Canonical entities of different types cannot be merged'
        USING ERRCODE = '23514';
    END IF;

    IF NEW.identity_scope = 'global_public' AND v_target_scope <> 'global_public' THEN
      RAISE EXCEPTION 'A global public entity may merge only into another global public entity'
        USING ERRCODE = '23514';
    END IF;

    IF NEW.identity_scope = 'tenant_private'
       AND v_target_scope = 'tenant_private'
       AND v_target_tenant <> NEW.tenant_id THEN
      RAISE EXCEPTION 'A tenant-private entity cannot merge into another tenant'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "canonical_entities_enforce_invariants"
  BEFORE INSERT OR UPDATE OF
    "tenant_id",
    "identity_scope",
    "entity_type",
    "status",
    "merged_into_entity_id"
  ON "canonical_entities"
  FOR EACH ROW EXECUTE FUNCTION enforce_canonical_entity_invariants();

CREATE OR REPLACE FUNCTION reject_entity_alias_identity_mutation()
RETURNS trigger AS $$
BEGIN
  IF NEW.entity_id IS DISTINCT FROM OLD.entity_id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.identity_scope IS DISTINCT FROM OLD.identity_scope
     OR NEW.alias IS DISTINCT FROM OLD.alias
     OR NEW.normalized_alias IS DISTINCT FROM OLD.normalized_alias
     OR NEW.source_type IS DISTINCT FROM OLD.source_type
     OR NEW.source_id IS DISTINCT FROM OLD.source_id THEN
    RAISE EXCEPTION
      'EntityAlias identity and provenance are immutable; withdraw and append a replacement'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "entity_aliases_reject_identity_mutation"
  BEFORE UPDATE OF
    "entity_id",
    "tenant_id",
    "identity_scope",
    "alias",
    "normalized_alias",
    "source_type",
    "source_id"
  ON "entity_aliases"
  FOR EACH ROW EXECUTE FUNCTION reject_entity_alias_identity_mutation();

CREATE OR REPLACE FUNCTION reject_entity_identifier_identity_mutation()
RETURNS trigger AS $$
BEGIN
  IF NEW.entity_id IS DISTINCT FROM OLD.entity_id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.identity_scope IS DISTINCT FROM OLD.identity_scope
     OR NEW.identifier_type IS DISTINCT FROM OLD.identifier_type
     OR NEW.identifier_value IS DISTINCT FROM OLD.identifier_value
     OR NEW.normalized_value IS DISTINCT FROM OLD.normalized_value
     OR NEW.source_type IS DISTINCT FROM OLD.source_type
     OR NEW.source_id IS DISTINCT FROM OLD.source_id THEN
    RAISE EXCEPTION
      'EntityIdentifier identity and provenance are immutable; withdraw and append a replacement'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "entity_identifiers_reject_identity_mutation"
  BEFORE UPDATE OF
    "entity_id",
    "tenant_id",
    "identity_scope",
    "identifier_type",
    "identifier_value",
    "normalized_value",
    "source_type",
    "source_id"
  ON "entity_identifiers"
  FOR EACH ROW EXECUTE FUNCTION reject_entity_identifier_identity_mutation();

CREATE OR REPLACE FUNCTION enforce_entity_resolution_scope()
RETURNS trigger AS $$
DECLARE
  v_entity_scope TEXT;
  v_entity_tenant UUID;
  v_correction_tenant UUID;
  v_previous_raw_input TEXT;
  v_previous_normalized_input TEXT;
  v_previous_type_hint TEXT;
  v_candidate_count INTEGER;
  v_distinct_candidate_count INTEGER;
BEGIN
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(NEW.candidate_entity_ids) AS candidate(value)
    WHERE jsonb_typeof(candidate.value) <> 'string'
  ) THEN
    RAISE EXCEPTION 'Entity resolution candidates must be UUID strings'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements_text(NEW.candidate_entity_ids) AS candidate(value)
    WHERE candidate.value !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ) THEN
    RAISE EXCEPTION 'Entity resolution candidates must be valid UUIDs'
      USING ERRCODE = '23514';
  END IF;

  v_candidate_count := jsonb_array_length(NEW.candidate_entity_ids);
  SELECT COUNT(DISTINCT candidate.value)
    INTO v_distinct_candidate_count
  FROM jsonb_array_elements_text(NEW.candidate_entity_ids) AS candidate(value);

  IF v_candidate_count <> v_distinct_candidate_count THEN
    RAISE EXCEPTION 'Entity resolution candidates must not contain duplicates'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements_text(NEW.candidate_entity_ids) AS candidate(value)
    LEFT JOIN canonical_entities AS entity
      ON entity.id = candidate.value::uuid
     AND entity.status = 'active'
     AND (
       entity.identity_scope = 'global_public'
       OR entity.tenant_id = NEW.tenant_id
     )
    WHERE entity.id IS NULL
  ) THEN
    RAISE EXCEPTION 'Entity resolution candidate is not visible to this tenant'
      USING ERRCODE = '23503';
  END IF;

  IF NEW.status = 'ambiguous' AND v_candidate_count < 2 THEN
    RAISE EXCEPTION 'An ambiguous resolution requires at least two visible candidates'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.selected_entity_id IS NOT NULL THEN
    SELECT identity_scope, tenant_id
      INTO v_entity_scope, v_entity_tenant
    FROM canonical_entities
    WHERE id = NEW.selected_entity_id
      AND status = 'active';

    IF v_entity_scope IS NULL
       OR (v_entity_scope = 'tenant_private' AND v_entity_tenant <> NEW.tenant_id) THEN
      RAISE EXCEPTION 'Selected canonical entity is not visible to this tenant'
        USING ERRCODE = '23503';
    END IF;

    IF NOT (NEW.candidate_entity_ids ? NEW.selected_entity_id::text) THEN
      RAISE EXCEPTION 'Selected canonical entity must be present in candidate_entity_ids'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.correction_of_resolution_id IS NOT NULL THEN
    SELECT
      tenant_id,
      raw_input,
      normalized_input,
      entity_type_hint
    INTO
      v_correction_tenant,
      v_previous_raw_input,
      v_previous_normalized_input,
      v_previous_type_hint
    FROM entity_resolutions
    WHERE id = NEW.correction_of_resolution_id;

    IF v_correction_tenant IS NULL OR v_correction_tenant <> NEW.tenant_id THEN
      RAISE EXCEPTION 'Corrected resolution must exist in the same tenant'
        USING ERRCODE = '23503';
    END IF;

    IF NEW.raw_input IS DISTINCT FROM v_previous_raw_input
       OR NEW.normalized_input IS DISTINCT FROM v_previous_normalized_input
       OR NEW.entity_type_hint IS DISTINCT FROM v_previous_type_hint THEN
      RAISE EXCEPTION 'A correction must preserve the original resolution query'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMENT ON CONSTRAINT "entity_resolutions_correction_state_check"
  ON "entity_resolutions" IS
  'Corrections are append-only, attributable, and must reference the resolution they correct.';
COMMENT ON FUNCTION enforce_canonical_entity_invariants() IS
  'Prevents identity scope/type rewrites and unsafe cross-scope/cross-tenant merges.';
COMMENT ON FUNCTION enforce_entity_resolution_scope() IS
  'Fails closed on invisible candidates, selected-entity drift, and correction-lineage drift.';
