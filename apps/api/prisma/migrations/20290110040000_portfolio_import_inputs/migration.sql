-- Provisional websites belong to the existing durable import request, not the client profile.
-- NULL preserves every historical request and its original digest.
ALTER TABLE firm_import_jobs ADD COLUMN request_jsonb jsonb;
ALTER TABLE firm_import_jobs ADD CONSTRAINT firm_import_jobs_request_object
  CHECK (request_jsonb IS NULL OR COALESCE(
    jsonb_typeof(request_jsonb) = 'object'
    AND request_jsonb->'schemaVersion' = '1'::jsonb
    AND jsonb_typeof(request_jsonb->'websites') = 'object', false));
