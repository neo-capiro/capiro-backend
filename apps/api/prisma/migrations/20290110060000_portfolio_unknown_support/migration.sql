-- An approved fit recommendation is not evidence of an office's interest.
-- Keep existing person-reviewed stances unchanged.
ALTER TABLE client_target_supports
  DROP CONSTRAINT client_target_supports_stance_check,
  ADD CONSTRAINT client_target_supports_stance_check
    CHECK (stance IN ('unknown','interested','supportive','champion','declined')),
  ALTER COLUMN stance SET DEFAULT 'unknown';
