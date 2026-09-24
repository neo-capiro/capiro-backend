-- A persisted manifest is the complete authority set for its item rows.
-- Serialize inserts on the parent so the item-count cap cannot race.
CREATE FUNCTION guard_defense_budget_ingestion_manifest_item_insert_v1() RETURNS TRIGGER AS $$
DECLARE
  parent_manifest JSONB;
  parent_status TEXT;
  member_count INTEGER;
  existing_item_count INTEGER;
  exact_member_matches INTEGER;
BEGIN
  SELECT "manifest_jsonb", "status"
    INTO parent_manifest, parent_status
    FROM "defense_budget_ingestion_manifest_v1"
    WHERE "id" = NEW."manifest_id"
    FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'manifest item parent does not exist' USING ERRCODE = '23503';
  END IF;
  IF parent_status <> 'running' THEN
    RAISE EXCEPTION 'manifest items may only be added while registering a running operation' USING ERRCODE = '23514';
  END IF;
  IF jsonb_typeof(parent_manifest->'members') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'manifest members must be an array' USING ERRCODE = '23514';
  END IF;

  member_count := jsonb_array_length(parent_manifest->'members');
  IF member_count < 1 OR member_count > 5 THEN
    RAISE EXCEPTION 'manifest must contain between one and five members' USING ERRCODE = '23514';
  END IF;

  SELECT count(*) INTO existing_item_count
    FROM "defense_budget_ingestion_manifest_item_v1"
    WHERE "manifest_id" = NEW."manifest_id";
  IF existing_item_count >= 5 THEN
    RAISE EXCEPTION 'a manifest cannot have more than five item rows' USING ERRCODE = '23514';
  END IF;

  -- Compare the complete JSON member as well as every identity represented by
  -- relational columns. JSONB equality is key-order independent. Requiring one
  -- match rejects missing, duplicated, mutated, and out-of-manifest entries.
  SELECT count(*) INTO exact_member_matches
    FROM jsonb_array_elements(parent_manifest->'members') AS candidate(value)
    WHERE candidate.value = NEW."member_jsonb"
      AND candidate.value->>'memberId' = NEW."id"::text
      AND candidate.value->>'ordinal' = NEW."ordinal"::text
      AND candidate.value#>>'{lifecycle,outboxRowId}' = NEW."outbox_row_id"::text
      AND candidate.value#>>'{lifecycle,observationId}' = NEW."observation_id"::text
      AND candidate.value#>>'{lifecycle,cycleId}' = NEW."cycle_id"::text
      AND candidate.value#>>'{lifecycle,sourceDocumentId}' = NEW."source_document_id"::text
      AND candidate.value#>>'{lifecycle,expectedOutboxState}' = NEW."expected_outbox_state"
      AND candidate.value#>>'{source,sha256}' = NEW."source_sha256"
      AND candidate.value#>>'{source,byteSize}' = NEW."source_byte_size"::text;

  IF exact_member_matches <> 1 THEN
    RAISE EXCEPTION 'manifest item does not correspond exactly to one immutable manifest member' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "defense_budget_ingestion_manifest_item_v1_insert_guard"
  BEFORE INSERT ON "defense_budget_ingestion_manifest_item_v1"
  FOR EACH ROW EXECUTE FUNCTION guard_defense_budget_ingestion_manifest_item_insert_v1();
