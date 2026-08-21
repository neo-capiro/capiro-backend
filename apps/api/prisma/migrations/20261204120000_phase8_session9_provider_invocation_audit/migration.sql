-- Phase 8 Session 9 — cross-domain provider invocation audit.
--
-- Sessions 2 and 3 bound the two Workstream-E cross-domain ports to
-- "unconfigured" implementations, because the missing piece was the OUTBOUND
-- CREDENTIAL rather than any business logic. Session 9 wires real providers
-- behind those same frozen ports.
--
-- Both ports degrade silently by contract:
--
--   EmbeddingPort.embedQuery -> "Returns null when no embedder is configured or
--                                the provider fails"
--   client relevance         -> "a relevance probe failure simply omits this
--                                PE's relevance signal"
--
-- That is correct product behaviour and terrible operational behaviour: an empty
-- capability search could be a genuinely empty result, an unconfigured provider,
-- a throttle, or an expired credential, and from the outside all four are
-- identical. This table is what makes them distinguishable.
--
-- What it deliberately does NOT hold:
--
--   * the query text or the PE-code list  -> only a SHA-256 digest;
--   * the embedding vector                -> only its dimension;
--   * any secret, header or credential    -> no column can express one;
--   * any monetary column                 -> provider cost is not a funding
--     fact. Sessions 7 and 8 asserted no dollars and so does this one; the
--     rehearsal measures it against information_schema rather than trusting
--     this comment.
--
-- Append-only, like the Session 8 discovery audit: neither role may DELETE, so a
-- degraded invocation stays on the record.

CREATE TABLE "defense_provider_invocation" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "provider" TEXT NOT NULL,
  "operation" TEXT NOT NULL,
  "outcome" TEXT NOT NULL,
  -- Model id for an embedding call; NULL for a relevance call. Part of the
  -- stored-vector contract: every vector read filters on
  -- `context_embeddings.model`, so a mismatch silently returns zero rows.
  "model" TEXT,
  "tenant_id" TEXT NOT NULL,
  "payload_sha256" CHAR(64) NOT NULL,
  "idempotency_key" CHAR(64) NOT NULL,
  "attempts" INTEGER NOT NULL,
  "latency_ms" INTEGER NOT NULL,
  "failure_class" TEXT,
  "reason" TEXT NOT NULL,
  "result_dimension" INTEGER,
  "result_count" INTEGER,
  "started_at" TIMESTAMPTZ(6) NOT NULL,
  "finished_at" TIMESTAMPTZ(6) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "dpi_operation_chk" CHECK (
    "operation" IN ('embed_query', 'relevant_pe_codes')
  ),
  CONSTRAINT "dpi_outcome_chk" CHECK (
    "outcome" IN (
      'succeeded',
      'degraded_unconfigured',
      'degraded_failed',
      'degraded_concurrency',
      'degraded_empty_input'
    )
  ),
  -- A failure class only makes sense on a failed invocation, and a failed
  -- invocation must name one. This is what stops "it just returned nothing"
  -- from being a storable state.
  CONSTRAINT "dpi_failure_class_chk" CHECK (
    ("outcome" = 'degraded_failed') = ("failure_class" IS NOT NULL)
  ),
  -- A success has to have produced something.
  CONSTRAINT "dpi_success_has_result_chk" CHECK (
    "outcome" <> 'succeeded'
    OR "result_dimension" IS NOT NULL
    OR "result_count" IS NOT NULL
  ),
  -- And a degraded invocation must not claim an embedding it never got.
  CONSTRAINT "dpi_degraded_no_dimension_chk" CHECK (
    "outcome" = 'succeeded' OR "result_dimension" IS NULL
  ),
  -- Only an embedding call has a model; only an embedding call has a dimension.
  CONSTRAINT "dpi_model_only_for_embedding_chk" CHECK (
    "operation" = 'embed_query' OR "model" IS NULL
  ),
  CONSTRAINT "dpi_dimension_only_for_embedding_chk" CHECK (
    "operation" = 'embed_query' OR "result_dimension" IS NULL
  ),
  CONSTRAINT "dpi_count_only_for_relevance_chk" CHECK (
    "operation" = 'relevant_pe_codes' OR "result_count" IS NULL
  ),
  CONSTRAINT "dpi_reason_chk" CHECK (length(btrim("reason")) > 0),
  CONSTRAINT "dpi_attempts_chk" CHECK ("attempts" >= 0),
  CONSTRAINT "dpi_latency_chk" CHECK ("latency_ms" >= 0),
  CONSTRAINT "dpi_window_chk" CHECK ("finished_at" >= "started_at"),
  CONSTRAINT "dpi_dimension_positive_chk" CHECK (
    "result_dimension" IS NULL OR "result_dimension" > 0
  ),
  CONSTRAINT "dpi_count_nonnegative_chk" CHECK (
    "result_count" IS NULL OR "result_count" >= 0
  ),
  CONSTRAINT "dpi_tenant_chk" CHECK (length(btrim("tenant_id")) > 0)
);

CREATE INDEX "dpi_provider_started_idx"
  ON "defense_provider_invocation" ("provider", "started_at" DESC);
CREATE INDEX "dpi_outcome_idx" ON "defense_provider_invocation" ("outcome");
CREATE INDEX "dpi_tenant_started_idx"
  ON "defense_provider_invocation" ("tenant_id", "started_at" DESC);
CREATE INDEX "dpi_idempotency_idx" ON "defense_provider_invocation" ("idempotency_key");

-- ───────────────────────────────────────────────────────────────────────────
-- Least-privilege grants.
--
-- The serve role gets SELECT and INSERT on THIS TABLE ONLY. That is a deliberate
-- and narrow addition to the Session 2/3 posture, and it is required rather than
-- convenient: the provider calls happen on the HTTP read path, so the serve task
-- is the only thing that can record them. Without the grant the choice would be
-- between an unauditable provider call and no provider at all.
--
-- It is bounded three ways: this single table, no UPDATE, and no DELETE. The
-- serve role gains no write access to any pre-existing relation, and the
-- rehearsal asserts exactly that.
-- ───────────────────────────────────────────────────────────────────────────
REVOKE ALL ON TABLE "defense_provider_invocation" FROM PUBLIC;

GRANT SELECT, INSERT ON TABLE "defense_provider_invocation" TO "capiro_defense_serve";
GRANT SELECT, INSERT ON TABLE "defense_provider_invocation" TO "capiro_defense_job";
