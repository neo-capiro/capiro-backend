-- Source allocation only. Do not apply while the earlier held 090000 memory
-- disposition migration raises SQLSTATE 55000, or before the signed Meri/Core
-- two-step wire and role readback are qualified. This alters the existing
-- Option B token table; it adds no runtime role grant, table or tool slot.
BEGIN;

ALTER TABLE "meri_read_tokens"
  ADD COLUMN "parent_jti" UUID,
  ADD COLUMN "parent_body_sha256" CHAR(64),
  ADD COLUMN "page_arguments_sha256" CHAR(64),
  ADD COLUMN "page_request_sha256" CHAR(64),
  ADD COLUMN "correlation_sha256" CHAR(64),
  ADD COLUMN "page_result_sha256" CHAR(64),
  ADD COLUMN "records_sha256" CHAR(64),
  ADD COLUMN "binding_sha256" CHAR(64);

ALTER TABLE "meri_read_tokens"
  DROP CONSTRAINT "meri_read_tokens_kind_check",
  ADD CONSTRAINT "meri_read_tokens_kind_check"
    CHECK ("kind" IN ('tool', 'mode', 'reference', 'current', 'memory_eligibility')),
  ADD CONSTRAINT "meri_read_tokens_memory_parent_fkey"
    FOREIGN KEY ("parent_jti") REFERENCES "meri_read_tokens" ("jti"),
  ADD CONSTRAINT "meri_read_tokens_memory_helper_check" CHECK (
    ("kind" = 'memory_eligibility') =
      ("parent_jti" IS NOT NULL AND "parent_body_sha256" IS NOT NULL AND
       "page_arguments_sha256" IS NOT NULL AND "page_request_sha256" IS NOT NULL AND
       "correlation_sha256" IS NOT NULL AND "page_result_sha256" IS NOT NULL AND
       "records_sha256" IS NOT NULL AND "binding_sha256" IS NOT NULL)
    AND ("kind" = 'memory_eligibility' OR
      ("parent_jti" IS NULL AND "parent_body_sha256" IS NULL AND
       "page_arguments_sha256" IS NULL AND "page_request_sha256" IS NULL AND
       "correlation_sha256" IS NULL AND "page_result_sha256" IS NULL AND
       "records_sha256" IS NULL AND "binding_sha256" IS NULL))
    AND ("kind" <> 'memory_eligibility' OR
      ("target_path" = '/api/clio/tools/search_memory_eligibility' AND
       "arguments_sha256" IS NULL AND "parent_jti" <> "jti"))
    AND ("parent_body_sha256" IS NULL OR "parent_body_sha256" ~ '^[0-9a-f]{64}$')
    AND ("page_arguments_sha256" IS NULL OR "page_arguments_sha256" ~ '^[0-9a-f]{64}$')
    AND ("page_request_sha256" IS NULL OR "page_request_sha256" ~ '^[0-9a-f]{64}$')
    AND ("correlation_sha256" IS NULL OR "correlation_sha256" ~ '^[0-9a-f]{64}$')
    AND ("page_result_sha256" IS NULL OR "page_result_sha256" ~ '^[0-9a-f]{64}$')
    AND ("records_sha256" IS NULL OR "records_sha256" ~ '^[0-9a-f]{64}$')
    AND ("binding_sha256" IS NULL OR "binding_sha256" ~ '^[0-9a-f]{64}$')
  );

-- There is no retry or lost-response reissue for this helper. The existing
-- tool_tokens <= 1 check and original allowed-operation set are untouched.
CREATE UNIQUE INDEX "meri_read_tokens_memory_helper_slot_key"
  ON "meri_read_tokens" ("run_id", "call_key") WHERE "kind" = 'memory_eligibility';
CREATE UNIQUE INDEX "meri_read_tokens_memory_helper_parent_key"
  ON "meri_read_tokens" ("parent_jti") WHERE "kind" = 'memory_eligibility';

COMMIT;
