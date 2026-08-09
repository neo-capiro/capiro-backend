-- Phase 6 / Phase 7 repair — bind each cycle certification to the exact
-- immutable projection set it certified. NONCANONICAL; no product truth rows.
--
-- Historical certifications pre-dating this migration deliberately remain
-- NULL/UNBOUND. They are audit history, not promotion inputs. Rebuild and
-- persist the deterministic cycle to obtain a promotable bound certification.

ALTER TABLE phase6_cycle_certification
  ADD COLUMN IF NOT EXISTS projection_set_sha256 char(64),
  ADD COLUMN IF NOT EXISTS projection_count integer;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'phase6_cycle_cert_projection_binding_shape_check'
  ) THEN
    ALTER TABLE phase6_cycle_certification
      ADD CONSTRAINT phase6_cycle_cert_projection_binding_shape_check CHECK (
        (projection_set_sha256 IS NULL AND projection_count IS NULL)
        OR
        (
          projection_set_sha256 IS NOT NULL
          AND projection_set_sha256 ~ '^[0-9a-f]{64}$'
          AND projection_count IS NOT NULL
          AND projection_count >= 0
          AND report_jsonb->>'projectionSetSha256' = projection_set_sha256
          AND (report_jsonb->>'projectionCount')::integer = projection_count
        )
      );
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS phase6_cycle_certification_projection (
  certification_content_sha256 char(64) NOT NULL,
  projection_id text NOT NULL,
  projection_ordinal integer NOT NULL CHECK (projection_ordinal >= 0),
  CONSTRAINT phase6_cert_projection_pkey
    PRIMARY KEY (certification_content_sha256, projection_id),
  CONSTRAINT phase6_cert_projection_ordinal_key
    UNIQUE (certification_content_sha256, projection_ordinal),
  CONSTRAINT phase6_cert_projection_cert_fkey
    FOREIGN KEY (certification_content_sha256)
    REFERENCES phase6_cycle_certification(content_sha256)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT phase6_cert_projection_projection_fkey
    FOREIGN KEY (projection_id)
    REFERENCES phase6_audit_projection(projection_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS phase6_cert_projection_projection_idx
  ON phase6_cycle_certification_projection(projection_id);

-- A historical unbound certification cannot be retrofitted with guessed row
-- bindings. Only a newly generated certification carrying its exact set hash
-- and count may receive association rows.
CREATE OR REPLACE FUNCTION phase6_certification_projection_requires_bound_cert()
RETURNS trigger AS $$
DECLARE
  parent_hash char(64);
  parent_count integer;
BEGIN
  SELECT projection_set_sha256, projection_count
    INTO parent_hash, parent_count
    FROM phase6_cycle_certification
   WHERE content_sha256 = NEW.certification_content_sha256;

  IF parent_hash IS NULL OR parent_count IS NULL THEN
    RAISE EXCEPTION 'phase6 certification predates exact projection-set binding';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS phase6_cert_projection_requires_bound_cert_trg
  ON phase6_cycle_certification_projection;
CREATE TRIGGER phase6_cert_projection_requires_bound_cert_trg
BEFORE INSERT ON phase6_cycle_certification_projection
FOR EACH ROW EXECUTE FUNCTION phase6_certification_projection_requires_bound_cert();

CREATE OR REPLACE FUNCTION phase6_certification_projection_immutable()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'phase6 certification projection bindings are immutable';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS phase6_cert_projection_immutable_update_trg
  ON phase6_cycle_certification_projection;
CREATE TRIGGER phase6_cert_projection_immutable_update_trg
BEFORE UPDATE ON phase6_cycle_certification_projection
FOR EACH ROW EXECUTE FUNCTION phase6_certification_projection_immutable();

DROP TRIGGER IF EXISTS phase6_cert_projection_immutable_delete_trg
  ON phase6_cycle_certification_projection;
CREATE TRIGGER phase6_cert_projection_immutable_delete_trg
BEFORE DELETE ON phase6_cycle_certification_projection
FOR EACH ROW EXECUTE FUNCTION phase6_certification_projection_immutable();

DROP TRIGGER IF EXISTS phase6_cert_projection_immutable_truncate_trg
  ON phase6_cycle_certification_projection;
CREATE TRIGGER phase6_cert_projection_immutable_truncate_trg
BEFORE TRUNCATE ON phase6_cycle_certification_projection
FOR EACH STATEMENT EXECUTE FUNCTION phase6_certification_projection_immutable();

-- Phase 7 execution reloads the exact association under capiro_pe_promoter.
-- This migration belongs to the separate Phase 6 chain, so the promoter role
-- may or may not exist yet depending on migration order. Grant SELECT only when
-- it does; the main Phase 7 forward migration repeats the grant for the inverse
-- ordering. No INSERT/UPDATE/DELETE privilege is granted to the promoter.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_pe_promoter') THEN
    GRANT SELECT ON phase6_cycle_certification_projection TO capiro_pe_promoter;
  END IF;
END $$;
