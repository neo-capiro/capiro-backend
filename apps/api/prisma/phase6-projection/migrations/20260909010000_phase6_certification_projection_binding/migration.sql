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
