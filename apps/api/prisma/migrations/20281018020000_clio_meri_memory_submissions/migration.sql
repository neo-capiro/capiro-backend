-- W8 Meri memory review submissions. One immutable row per (tenant, Meri
-- candidate id) keeps a content-free RFC 8785 SHA-256 receipt and the stable
-- reviewId Core acknowledged. The full payload belongs only to the existing
-- memory_candidate review owner, inserted in the same transaction and removed
-- by its normal client purge. A retained receipt suppresses re-submission
-- after that candidate is deleted; review decisions stay with that owner.
CREATE TABLE "clio_meri_memory_submissions" (
  "tenant_id" UUID NOT NULL,
  "candidate_id" UUID NOT NULL,
  "candidate_sha256" CHAR(64) NOT NULL,
  "proposer_user_id" UUID NOT NULL,
  "review_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "clio_meri_memory_submissions_pkey" PRIMARY KEY ("tenant_id", "candidate_id"),
  CONSTRAINT "clio_meri_memory_submissions_review_id_key" UNIQUE ("review_id"),
  CONSTRAINT "clio_meri_memory_submissions_tenant_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
  CONSTRAINT "clio_meri_memory_submissions_sha_check" CHECK ("candidate_sha256" ~ '^[0-9a-f]{64}$')
);

CREATE FUNCTION clio_meri_memory_submission_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Meri memory submission is immutable' USING ERRCODE='23514';
END $$;
CREATE TRIGGER clio_meri_memory_submission_immutable
  BEFORE UPDATE ON "clio_meri_memory_submissions"
  FOR EACH ROW EXECUTE FUNCTION clio_meri_memory_submission_immutable();

ALTER TABLE "clio_meri_memory_submissions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "clio_meri_memory_submissions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "clio_meri_memory_submissions_isolation" ON "clio_meri_memory_submissions"
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_app') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON "clio_meri_memory_submissions" FROM capiro_app;
    GRANT SELECT, INSERT ON "clio_meri_memory_submissions" TO capiro_app;
  END IF;
END $$;
