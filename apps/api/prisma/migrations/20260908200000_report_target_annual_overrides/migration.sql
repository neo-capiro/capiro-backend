-- Additive rollout: retain the target identity's original unique key and legacy
-- status columns. Existing API instances can continue inserting/upserting while
-- the new instances use annual overrides. Never assign legacy null-client rows.
ALTER TABLE engagement_report_target_offices
  ADD COLUMN first_report_year integer,
  ADD COLUMN display_overrides text[] NOT NULL DEFAULT '{}',
  ADD COLUMN archived_at timestamptz(6);
UPDATE engagement_report_target_offices
  SET first_report_year = EXTRACT(year FROM created_at AT TIME ZONE 'UTC')::integer;
ALTER TABLE engagement_report_target_offices
  ALTER COLUMN first_report_year SET DEFAULT EXTRACT(year FROM CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::integer,
  ALTER COLUMN first_report_year SET NOT NULL;
ALTER TABLE engagement_report_target_offices
  ADD CONSTRAINT engagement_report_targets_id_tenant_key UNIQUE (id, tenant_id);

CREATE TABLE engagement_report_target_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  target_id uuid NOT NULL,
  report_year integer NOT NULL CHECK (report_year BETWEEN 1900 AND 2200),
  prep_status text NOT NULL DEFAULT 'auto' CHECK (prep_status IN ('auto','not_started','in_progress','complete')),
  outreach_status text NOT NULL DEFAULT 'auto' CHECK (outreach_status IN ('auto','not_started','in_progress','complete')),
  submission_status text NOT NULL DEFAULT 'auto' CHECK (submission_status IN ('auto','not_started','in_progress','complete')),
  created_at timestamptz(6) NOT NULL DEFAULT now(),
  updated_at timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT engagement_report_overrides_target_year_key UNIQUE (target_id, report_year),
  CONSTRAINT engagement_report_overrides_target_tenant_fkey
    FOREIGN KEY (target_id, tenant_id) REFERENCES engagement_report_target_offices(id, tenant_id)
    ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX engagement_report_overrides_tenant_year_idx
  ON engagement_report_target_overrides(tenant_id, report_year);

-- Old statuses were never year-keyed. Preserve them in the deployment's current
-- UTC year only; assigning them to every historic year would fabricate history.
INSERT INTO engagement_report_target_overrides
  (tenant_id, target_id, report_year, prep_status, outreach_status, submission_status)
SELECT tenant_id, id, EXTRACT(year FROM CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::integer,
       prep_status, outreach_status, submission_status
FROM engagement_report_target_offices
WHERE prep_status <> 'auto' OR outreach_status <> 'auto' OR submission_status <> 'auto';

ALTER TABLE engagement_report_target_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE engagement_report_target_overrides FORCE ROW LEVEL SECURITY;
CREATE POLICY engagement_report_overrides_select ON engagement_report_target_overrides
  FOR SELECT USING (rls_bypass() OR tenant_id = current_tenant_id());
CREATE POLICY engagement_report_overrides_insert ON engagement_report_target_overrides
  FOR INSERT WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());
CREATE POLICY engagement_report_overrides_update ON engagement_report_target_overrides
  FOR UPDATE USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());
CREATE POLICY engagement_report_overrides_delete ON engagement_report_target_overrides
  FOR DELETE USING (rls_bypass() OR tenant_id = current_tenant_id());

-- Mirror only current-year statuses while old/new API instances coexist. The
-- depth guard prevents the reciprocal compatibility triggers recursing. Updates
-- to an earlier year's overrides never alter the current-year legacy columns.
-- New API mutations lock the parent target rows BEFORE touching annual rows,
-- matching the parent -> annual lock order used by old API status writes.
CREATE FUNCTION mirror_legacy_report_statuses() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN RETURN NEW; END IF;
  INSERT INTO engagement_report_target_overrides
    (tenant_id, target_id, report_year, prep_status, outreach_status, submission_status)
  VALUES (NEW.tenant_id, NEW.id, EXTRACT(year FROM CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::integer,
          NEW.prep_status, NEW.outreach_status, NEW.submission_status)
  ON CONFLICT (target_id, report_year) DO UPDATE SET
    prep_status = EXCLUDED.prep_status,
    outreach_status = EXCLUDED.outreach_status,
    submission_status = EXCLUDED.submission_status,
    updated_at = now();
  RETURN NEW;
END $$;
CREATE TRIGGER engagement_report_legacy_status_compat
  AFTER INSERT
  ON engagement_report_target_offices FOR EACH ROW EXECUTE FUNCTION mirror_legacy_report_statuses();

-- An old API UPDATE supplies only the status fields the user changed. At the
-- UTC year boundary, copying the entire legacy row would carry last year's
-- untouched statuses into the new year. Separate UPDATE OF triggers preserve
-- the actual SET columns, even when a supplied value equals last year's value.
CREATE FUNCTION mirror_legacy_report_status_field() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  current_year integer := EXTRACT(year FROM CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::integer;
BEGIN
  IF pg_trigger_depth() > 1 THEN RETURN NEW; END IF;
  INSERT INTO engagement_report_target_overrides
    (tenant_id, target_id, report_year, prep_status, outreach_status, submission_status)
  VALUES (NEW.tenant_id, NEW.id, current_year,
          CASE WHEN TG_ARGV[0] = 'prep_status' THEN NEW.prep_status ELSE 'auto' END,
          CASE WHEN TG_ARGV[0] = 'outreach_status' THEN NEW.outreach_status ELSE 'auto' END,
          CASE WHEN TG_ARGV[0] = 'submission_status' THEN NEW.submission_status ELSE 'auto' END)
  ON CONFLICT (target_id, report_year) DO UPDATE SET
    prep_status = CASE WHEN TG_ARGV[0] = 'prep_status'
      THEN EXCLUDED.prep_status ELSE engagement_report_target_overrides.prep_status END,
    outreach_status = CASE WHEN TG_ARGV[0] = 'outreach_status'
      THEN EXCLUDED.outreach_status ELSE engagement_report_target_overrides.outreach_status END,
    submission_status = CASE WHEN TG_ARGV[0] = 'submission_status'
      THEN EXCLUDED.submission_status ELSE engagement_report_target_overrides.submission_status END,
    updated_at = now();

  -- The nested annual trigger is depth-guarded, so explicitly refresh legacy
  -- readers here. Any other original UPDATE OF events still carry their own
  -- original NEW values and apply their explicitly supplied fields afterward.
  UPDATE engagement_report_target_offices AS target SET
    prep_status = annual.prep_status, outreach_status = annual.outreach_status,
    submission_status = annual.submission_status
  FROM engagement_report_target_overrides AS annual
  WHERE target.id = NEW.id AND target.tenant_id = NEW.tenant_id
    AND annual.target_id = target.id AND annual.tenant_id = target.tenant_id
    AND annual.report_year = current_year;
  RETURN NEW;
END $$;
CREATE TRIGGER engagement_report_legacy_prep_compat
  AFTER UPDATE OF prep_status ON engagement_report_target_offices
  FOR EACH ROW EXECUTE FUNCTION mirror_legacy_report_status_field('prep_status');
CREATE TRIGGER engagement_report_legacy_outreach_compat
  AFTER UPDATE OF outreach_status ON engagement_report_target_offices
  FOR EACH ROW EXECUTE FUNCTION mirror_legacy_report_status_field('outreach_status');
CREATE TRIGGER engagement_report_legacy_submission_compat
  AFTER UPDATE OF submission_status ON engagement_report_target_offices
  FOR EACH ROW EXECUTE FUNCTION mirror_legacy_report_status_field('submission_status');

CREATE FUNCTION mirror_annual_report_statuses() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF pg_trigger_depth() > 1 OR NEW.report_year <> EXTRACT(year FROM CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::integer
    THEN RETURN NEW; END IF;
  UPDATE engagement_report_target_offices SET
    prep_status = NEW.prep_status, outreach_status = NEW.outreach_status,
    submission_status = NEW.submission_status
  WHERE id = NEW.target_id AND tenant_id = NEW.tenant_id;
  RETURN NEW;
END $$;
CREATE TRIGGER engagement_report_annual_status_compat
  AFTER INSERT OR UPDATE ON engagement_report_target_overrides
  FOR EACH ROW EXECUTE FUNCTION mirror_annual_report_statuses();
