-- Maintenance window 2026-09-27: remove duplicate client_intel_mapping rows
-- Duplicates were created by concurrent entity-resolution runs.
-- Keeps the oldest row (lowest id) for each (client_id, source, external_id) triple.

DELETE FROM client_intel_mapping
WHERE id NOT IN (
  SELECT MIN(id)
  FROM client_intel_mapping
  GROUP BY client_id, source, external_id
);
