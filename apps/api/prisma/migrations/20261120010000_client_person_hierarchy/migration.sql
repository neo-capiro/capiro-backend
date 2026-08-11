-- Client organization hierarchy (Client CRM vNext, Figma 906:2790 / 907:3028).
--
-- The roster is structured automatically from titles, but a MANUAL placement
-- always wins over inference — so the source of a placement is stored, not
-- guessed from whether the other columns happen to be filled in.
--
-- Additive and nullable throughout: every existing client_people row stays
-- valid and simply reads as "not yet placed", which the UI renders as an
-- explicit unplaced state rather than as level 0.

ALTER TABLE client_people
  -- executive | c_suite | senior_leadership | leadership | management | team
  ADD COLUMN IF NOT EXISTS hierarchy_level varchar(24) NULL,
  ADD COLUMN IF NOT EXISTS reports_to_person_id uuid NULL,
  -- auto_title | manual. Manual placement is never re-derived from a title.
  ADD COLUMN IF NOT EXISTS placement_source varchar(16) NOT NULL DEFAULT 'auto_title',
  -- Inference confidence, NULL for manual placements (a human is not a score).
  ADD COLUMN IF NOT EXISTS placement_confidence numeric(4,3) NULL,
  -- Set when a title is ambiguous or unmatched and a human should look.
  ADD COLUMN IF NOT EXISTS review_required boolean NOT NULL DEFAULT false;

DO $$
BEGIN
  -- A person cannot report to themselves. Enforced in the database because the
  -- service is not the only writer: Meri's contact import writes here too.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'client_people_no_self_report_chk'
  ) THEN
    ALTER TABLE client_people
      ADD CONSTRAINT client_people_no_self_report_chk
      CHECK (reports_to_person_id IS NULL OR reports_to_person_id <> id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'client_people_placement_source_chk'
  ) THEN
    ALTER TABLE client_people
      ADD CONSTRAINT client_people_placement_source_chk
      CHECK (placement_source IN ('auto_title', 'manual'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'client_people_hierarchy_level_chk'
  ) THEN
    ALTER TABLE client_people
      ADD CONSTRAINT client_people_hierarchy_level_chk
      CHECK (hierarchy_level IS NULL OR hierarchy_level IN (
        'executive', 'c_suite', 'senior_leadership', 'leadership', 'management', 'team'
      ));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'client_people_confidence_range_chk'
  ) THEN
    ALTER TABLE client_people
      ADD CONSTRAINT client_people_confidence_range_chk
      CHECK (placement_confidence IS NULL
             OR (placement_confidence >= 0 AND placement_confidence <= 1));
  END IF;

  -- Reports-to must stay inside the same client. A FK to client_people(id)
  -- alone would allow pointing at another client's contact.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'client_people_scope_uniq'
  ) THEN
    ALTER TABLE client_people
      ADD CONSTRAINT client_people_scope_uniq UNIQUE (id, tenant_id, client_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'client_people_reports_to_fk'
  ) THEN
    ALTER TABLE client_people
      ADD CONSTRAINT client_people_reports_to_fk
      FOREIGN KEY (reports_to_person_id, tenant_id, client_id)
      REFERENCES client_people (id, tenant_id, client_id)
      -- Deleting a manager unplaces their reports instead of deleting them or
      -- leaving a dangling pointer: "reports-to a deleted user" is a state the
      -- contract names explicitly.
      ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS client_people_reports_to_idx
  ON client_people (tenant_id, client_id, reports_to_person_id);
CREATE INDEX IF NOT EXISTS client_people_review_required_idx
  ON client_people (tenant_id, client_id)
  WHERE review_required;
