-- Maintenance window 2026-09-27: remove duplicate client_intel_mapping rows
-- Duplicates were created by concurrent entity-resolution runs.
-- Keeps the lowest UUID for each (client_id, source, external_id) triple.
-- UUID ordering is deterministic here; it does not establish creation chronology.

WITH ranked_mappings AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY client_id, source, external_id
      ORDER BY id
    ) AS duplicate_rank
  FROM client_intel_mapping
)
DELETE FROM client_intel_mapping AS mapping
USING ranked_mappings
WHERE mapping.id = ranked_mappings.id
  AND ranked_mappings.duplicate_rank > 1;
