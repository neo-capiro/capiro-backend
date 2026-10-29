BEGIN;

-- Review records have text subjects. Convert that reference, rather than the
-- protected candidate UUID, so the existing UUID key can serve the lookup.
-- Invalid/non-memory subjects produce no candidate identity, never a cast error.
CREATE OR REPLACE FUNCTION memory_review_candidate_identity(p_subject text) RETURNS uuid
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE SET search_path=public,pg_temp AS $$
  SELECT CASE WHEN p_subject ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    THEN p_subject::uuid ELSE NULL END
$$;
REVOKE ALL ON FUNCTION memory_review_candidate_identity(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION memory_review_candidate_identity(text) TO capiro_app;

-- Keep the same retention policy and current candidate visibility boundary.
-- This changes only the identity comparison, not who may read the candidate.
DROP POLICY memory_review_conversation_retention ON review_request;
CREATE POLICY memory_review_conversation_retention ON review_request AS RESTRICTIVE FOR SELECT
  USING(CASE WHEN rls_bypass() OR surface<>'memory' OR subject_type<>'memory_candidate' THEN true
    ELSE EXISTS(SELECT 1 FROM memory_candidate c WHERE c.tenant_id=review_request.tenant_id
      AND c.id=memory_review_candidate_identity(review_request.subject_id)) END);

COMMIT;
