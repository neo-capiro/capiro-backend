-- Knowledge Plane — Phase 5 lifecycle terminal-state hardening.
--
-- Canonical identity is correctable by appending aliases, identifiers,
-- resolutions, and merge lineage. It is not correctable by reopening a merged
-- or withdrawn historical row. Once terminal, the row is frozen.

CREATE OR REPLACE FUNCTION reject_terminal_canonical_entity_mutation()
RETURNS trigger AS $$
BEGIN
  IF OLD.status IN ('merged', 'withdrawn') THEN
    RAISE EXCEPTION
      'Terminal CanonicalEntity rows are immutable; append a new entity or correction instead'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Prefix with zz_ so this runs after the existing updated_at trigger. Even a
-- no-op UPDATE on a terminal row would otherwise mutate updated_at.
CREATE TRIGGER "zz_canonical_entities_reject_terminal_mutation"
  BEFORE UPDATE ON "canonical_entities"
  FOR EACH ROW EXECUTE FUNCTION reject_terminal_canonical_entity_mutation();

CREATE OR REPLACE FUNCTION reject_withdrawn_identity_link_mutation()
RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'withdrawn' THEN
    RAISE EXCEPTION
      'Withdrawn identity links are immutable; append a replacement instead'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "entity_aliases_reject_withdrawn_mutation"
  BEFORE UPDATE ON "entity_aliases"
  FOR EACH ROW EXECUTE FUNCTION reject_withdrawn_identity_link_mutation();

CREATE TRIGGER "entity_identifiers_reject_withdrawn_mutation"
  BEFORE UPDATE ON "entity_identifiers"
  FOR EACH ROW EXECUTE FUNCTION reject_withdrawn_identity_link_mutation();

COMMENT ON FUNCTION reject_terminal_canonical_entity_mutation() IS
  'Merged and withdrawn canonical entities are terminal historical records and cannot be reopened or edited.';
COMMENT ON FUNCTION reject_withdrawn_identity_link_mutation() IS
  'Withdrawn aliases/identifiers are terminal; corrections append new links rather than reactivating history.';
