-- Advocacy Matter correction UX (closeout PR, section 6/7 of the handoff).
--
-- PR #1253 shipped the Matter grouping abstraction with a 4-value status
-- enum (open/monitoring/resolved/stalled) and manual rename/status-edit/merge.
-- What it did not ship: (a) the full product-required lifecycle status set,
-- (b) any way to reassign or detach an individual record without editing the
-- whole Matter, (c) a "not advocacy" rejection path, and (d) protection for
-- any of the above against being silently overwritten the next time Fill
-- with Meri re-runs and calls assignMatterForRecord/applyAdvocacyRecord for
-- the same external_key. This migration is additive only.

-- 1. Expand the Matter status enum to the full lifecycle the product spec
--    requires. Existing rows keep their current value ('open' -> maps
--    conceptually onto the new set; 'resolved'/'stalled' are NOT touched by
--    this migration -- there is no reliable automatic mapping from the old
--    4-value set into e.g. 'successful' vs 'unsuccessful', and inventing one
--    would be exactly the "Meri silently decides successful" failure mode
--    section 7 forbids. A human re-classifies existing Matters over time.
ALTER TABLE client_advocacy_matter DROP CONSTRAINT IF EXISTS client_advocacy_matter_status_check;
ALTER TABLE client_advocacy_matter ADD CONSTRAINT client_advocacy_matter_status_check CHECK (status IN (
  'planning', 'active', 'monitoring', 'outcome_observed',
  'successful', 'partially_successful', 'unsuccessful', 'withdrawn', 'archived',
  -- Legacy values from the original 4-value enum, retained so existing rows
  -- never violate the constraint post-migration. New writes should use the
  -- lifecycle set above; the API layer no longer offers these as choices.
  'open', 'resolved', 'stalled'
));

-- 2. outcome_observed/successful/partially_successful/unsuccessful require
--    either explicit evidence (an outcome_event link already present) or a
--    human confirmation flag. This is enforced at the service layer (see
--    ClientAdvocacyMatterService.updateMatter), not by a DB trigger, because
--    the evidence check spans a second table (client_advocacy_matter_link)
--    and Postgres CHECK constraints cannot reference other tables. Documented
--    here so the rule's location doesn't have to be rediscovered by grep.

-- 3. Manual correction lock. When a human reassigns a record to a different
--    Matter, detaches it, or marks it "not advocacy", automatic clustering
--    (assignMatterForRecord, called from applyAdvocacyRecord on every Fill
--    with Meri re-run for the same external_key) must NOT silently move it
--    back. matter_locked=true means "a human decided this record's Matter
--    assignment; do not auto-cluster it again."
ALTER TABLE client_advocacy_record ADD COLUMN IF NOT EXISTS matter_locked BOOLEAN NOT NULL DEFAULT false;

-- 4. "Not advocacy" rejection. A record marked not_advocacy is excluded from
--    Matter rollups, the Matters view record lists, and the Timeline, but is
--    NOT deleted -- it stays queryable for audit (who rejected it, when, and
--    what it originally was) and so a later re-run of Fill with Meri does
--    not resurrect an identical rejected finding (product spec section 26).
ALTER TABLE client_advocacy_record ADD COLUMN IF NOT EXISTS not_advocacy BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE client_advocacy_record ADD COLUMN IF NOT EXISTS not_advocacy_reason TEXT NULL;
ALTER TABLE client_advocacy_record ADD COLUMN IF NOT EXISTS reviewed_by_user_id UUID NULL;
ALTER TABLE client_advocacy_record ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ NULL;

CREATE INDEX IF NOT EXISTS client_advocacy_record_not_advocacy_idx
  ON client_advocacy_record (tenant_id, client_id)
  WHERE not_advocacy = true;

-- 5. Outcome confirmation. A Matter status transition into
--    successful/partially_successful/unsuccessful must be explicit --
--    outcome_confirmed_by_user_id/outcome_confirmed_at record who confirmed
--    it and when, so "Meri must not automatically set successful" (spec
--    section 7) is auditable, not just a convention the service happens to
--    follow today.
ALTER TABLE client_advocacy_matter ADD COLUMN IF NOT EXISTS outcome_confirmed_by_user_id UUID NULL;
ALTER TABLE client_advocacy_matter ADD COLUMN IF NOT EXISTS outcome_confirmed_at TIMESTAMPTZ NULL;
