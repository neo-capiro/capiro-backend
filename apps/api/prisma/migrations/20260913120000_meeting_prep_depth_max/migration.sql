-- The lightest search tier became 'standard'; the two existing tiers are now
-- 'deep' and 'max'. The inline CHECK from 20260912000100 only allowed two.
ALTER TABLE meeting_prep_jobs DROP CONSTRAINT meeting_prep_jobs_depth_check;
ALTER TABLE meeting_prep_jobs ADD CONSTRAINT meeting_prep_jobs_depth_check CHECK (depth IN ('standard','deep','max'));
