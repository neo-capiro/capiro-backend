-- Package 4: immutable federal legislative evidence, append-only mention
-- lifecycle, and retry-safe material-change delivery.
--
-- The mutable bill_text / congress_bill.pe_codes fields remain compatibility
-- projections. These tables are the evidence and lifecycle system of record.

CREATE TABLE "federal_evidence_revision" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "source_key" TEXT NOT NULL,
    "provider" VARCHAR(24) NOT NULL,
    "collection" VARCHAR(16) NOT NULL,
    "package_id" TEXT NOT NULL,
    "bill_id" TEXT,
    "version_code" VARCHAR(32),
    "lineage_key" TEXT NOT NULL,
    "content_hash" CHAR(64) NOT NULL,
    "extraction_hash" CHAR(64) NOT NULL,
    "parser_version" VARCHAR(64) NOT NULL,
    "source_url" TEXT NOT NULL,
    "source_modified_at" TIMESTAMPTZ(6),
    "published_at" TIMESTAMPTZ(6),
    "fetched_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
    "raw_content" TEXT NOT NULL,
    "extracted_text" TEXT NOT NULL,
    "completeness" VARCHAR(16) NOT NULL,
    "metadata_jsonb" JSONB NOT NULL DEFAULT '{}',
    CONSTRAINT "federal_evidence_revision_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "federal_evidence_revision_completeness_check"
      CHECK ("completeness" IN ('complete', 'partial', 'unreadable'))
);
CREATE UNIQUE INDEX "federal_evidence_revision_identity_key"
  ON "federal_evidence_revision" ("source_key", "content_hash", "extraction_hash", "parser_version");
CREATE INDEX "federal_evidence_revision_bill_idx"
  ON "federal_evidence_revision" ("bill_id", "fetched_at" DESC);
CREATE INDEX "federal_evidence_revision_package_idx"
  ON "federal_evidence_revision" ("package_id", "fetched_at" DESC);

-- Every completed inventory check appends an observation. A removed
-- observation deliberately has no revision; partial/failed fetches append
-- neither a removal nor a new current projection.
CREATE TABLE "federal_evidence_observation" (
    "id" BIGSERIAL NOT NULL,
    "observation_key" TEXT NOT NULL,
    "source_key" TEXT NOT NULL,
    "revision_id" UUID,
    "state" VARCHAR(16) NOT NULL,
    "observed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
    "source_modified_at" TIMESTAMPTZ(6),
    "inventory_window_end" TIMESTAMPTZ(6) NOT NULL,
    "historical" BOOLEAN NOT NULL DEFAULT false,
    "metadata_jsonb" JSONB NOT NULL DEFAULT '{}',
    CONSTRAINT "federal_evidence_observation_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "federal_evidence_observation_revision_fkey"
      FOREIGN KEY ("revision_id") REFERENCES "federal_evidence_revision"("id") ON DELETE RESTRICT,
    CONSTRAINT "federal_evidence_observation_state_check"
      CHECK (("state" IN ('present', 'partial', 'unreadable') AND "revision_id" IS NOT NULL) OR
             ("state" = 'removed' AND "revision_id" IS NULL))
);
CREATE UNIQUE INDEX "federal_evidence_observation_key_key"
  ON "federal_evidence_observation" ("observation_key");
CREATE INDEX "federal_evidence_observation_current_idx"
  ON "federal_evidence_observation" ("source_key", "id" DESC);

-- Candidate mentions are immutable facts about one immutable revision.
-- Unknown exact codes remain pending rather than being discarded.
CREATE TABLE "federal_evidence_mention" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "revision_id" UUID NOT NULL,
    "candidate_key" TEXT NOT NULL,
    "raw_mention" TEXT NOT NULL,
    "canonical_pe_code" VARCHAR(16),
    "match_type" VARCHAR(24) NOT NULL,
    "qualification_state" VARCHAR(16) NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "locator" TEXT NOT NULL,
    "evidence" TEXT NOT NULL,
    "language_hash" CHAR(64) NOT NULL,
    "matcher_version" VARCHAR(64) NOT NULL,
    "qualified_by" VARCHAR(64),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
    "metadata_jsonb" JSONB NOT NULL DEFAULT '{}',
    CONSTRAINT "federal_evidence_mention_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "federal_evidence_mention_revision_fkey"
      FOREIGN KEY ("revision_id") REFERENCES "federal_evidence_revision"("id") ON DELETE RESTRICT,
    CONSTRAINT "federal_evidence_mention_match_type_check"
      CHECK ("match_type" IN ('exact_pe', 'exact_blin', 'alias', 'jev')),
    CONSTRAINT "federal_evidence_mention_qualification_check"
      CHECK ("qualification_state" IN ('pending', 'qualified', 'rejected'))
);
CREATE UNIQUE INDEX "federal_evidence_mention_revision_candidate_key"
  ON "federal_evidence_mention" ("revision_id", "candidate_key", "matcher_version");
CREATE INDEX "federal_evidence_mention_pending_idx"
  ON "federal_evidence_mention" ("qualification_state", "raw_mention");
CREATE INDEX "federal_evidence_mention_pe_idx"
  ON "federal_evidence_mention" ("canonical_pe_code", "created_at" DESC);

-- Added/changed/removed/reinstated/resolved are append-only. event_key is the
-- logical delivery identity, not a polling-run identity.
CREATE TABLE "federal_evidence_mention_event" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "event_key" TEXT NOT NULL,
    "source_key" TEXT NOT NULL,
    "bill_id" TEXT,
    "event_type" VARCHAR(24) NOT NULL,
    "candidate_key" TEXT NOT NULL,
    "raw_mention" TEXT NOT NULL,
    "canonical_pe_code" VARCHAR(16),
    "previous_revision_id" UUID,
    "current_revision_id" UUID,
    "before_jsonb" JSONB,
    "after_jsonb" JSONB,
    "historical" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT "federal_evidence_mention_event_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "federal_evidence_mention_event_key_key" UNIQUE ("event_key"),
    CONSTRAINT "federal_evidence_mention_event_type_check"
      CHECK ("event_type" IN ('text_changed', 'added', 'changed', 'removed', 'reinstated', 'resolved', 'action_added')),
    CONSTRAINT "federal_evidence_mention_event_previous_fkey"
      FOREIGN KEY ("previous_revision_id") REFERENCES "federal_evidence_revision"("id") ON DELETE RESTRICT,
    CONSTRAINT "federal_evidence_mention_event_current_fkey"
      FOREIGN KEY ("current_revision_id") REFERENCES "federal_evidence_revision"("id") ON DELETE RESTRICT
);
CREATE INDEX "federal_evidence_mention_event_source_idx"
  ON "federal_evidence_mention_event" ("source_key", "created_at" DESC);
CREATE INDEX "federal_evidence_mention_event_pe_idx"
  ON "federal_evidence_mention_event" ("canonical_pe_code", "created_at" DESC);

CREATE TABLE "federal_evidence_change_outbox" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "event_id" UUID NOT NULL,
    "dedupe_key" TEXT NOT NULL,
    "payload_jsonb" JSONB NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "available_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
    "lease_token" UUID,
    "lease_until" TIMESTAMPTZ(6),
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
    "processed_at" TIMESTAMPTZ(6),
    CONSTRAINT "federal_evidence_change_outbox_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "federal_evidence_change_outbox_event_fkey"
      FOREIGN KEY ("event_id") REFERENCES "federal_evidence_mention_event"("id") ON DELETE RESTRICT,
    CONSTRAINT "federal_evidence_change_outbox_status_check"
      CHECK ("status" IN ('pending', 'processing', 'processed', 'failed'))
);
CREATE UNIQUE INDEX "federal_evidence_change_outbox_event_key"
  ON "federal_evidence_change_outbox" ("event_id");
CREATE UNIQUE INDEX "federal_evidence_change_outbox_dedupe_key"
  ON "federal_evidence_change_outbox" ("dedupe_key");
CREATE INDEX "federal_evidence_change_outbox_ready_idx"
  ON "federal_evidence_change_outbox" ("status", "available_at", "created_at");

CREATE TABLE "federal_evidence_checkpoint" (
    "source" TEXT NOT NULL,
    "cursor_jsonb" JSONB,
    "window_start" TIMESTAMPTZ(6),
    "window_end" TIMESTAMPTZ(6),
    "status" VARCHAR(16) NOT NULL DEFAULT 'idle',
    "lease_token" UUID,
    "lease_until" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),
    "last_error" TEXT,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT "federal_evidence_checkpoint_pkey" PRIMARY KEY ("source"),
    CONSTRAINT "federal_evidence_checkpoint_status_check"
      CHECK ("status" IN ('idle', 'running', 'failed', 'completed'))
);

-- Mutable discovery projections. They are not evidence; they make a complete
-- reconciliation able to prove that a previously known source disappeared.
CREATE TABLE "federal_evidence_inventory_member" (
    "inventory_source" TEXT NOT NULL,
    "source_key" TEXT NOT NULL,
    "package_id" TEXT NOT NULL,
    "last_seen_window_end" TIMESTAMPTZ(6) NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT "federal_evidence_inventory_member_pkey"
      PRIMARY KEY ("inventory_source", "source_key")
);
CREATE INDEX "federal_evidence_inventory_member_last_seen_idx"
  ON "federal_evidence_inventory_member" ("inventory_source", "last_seen_window_end");

CREATE TABLE "federal_evidence_coverage_gap" (
    "source_key" TEXT NOT NULL,
    "package_id" TEXT NOT NULL,
    "collection" VARCHAR(16) NOT NULL,
    "reason" VARCHAR(64) NOT NULL,
    "detail" TEXT,
    "first_observed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
    "last_observed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
    "resolved_at" TIMESTAMPTZ(6),
    CONSTRAINT "federal_evidence_coverage_gap_pkey" PRIMARY KEY ("source_key", "reason")
);
CREATE INDEX "federal_evidence_coverage_gap_open_idx"
  ON "federal_evidence_coverage_gap" ("collection", "resolved_at", "last_observed_at" DESC);

-- The latest complete observation is the current source projection. Branches
-- stay separate because source_key includes the package/version identity.
CREATE VIEW "federal_evidence_current" AS
SELECT DISTINCT ON (o.source_key)
       o.source_key, o.state, o.revision_id, o.observation_key, o.observed_at,
       r.provider, r.collection, r.package_id, r.bill_id, r.version_code,
       r.lineage_key, r.content_hash, r.extraction_hash, r.source_url,
       r.source_modified_at, r.extracted_text, r.completeness, r.metadata_jsonb
  FROM federal_evidence_observation o
  LEFT JOIN federal_evidence_revision r ON r.id = o.revision_id
 WHERE o.state IN ('present', 'removed')
 ORDER BY o.source_key, o.id DESC;

-- The existing LegiWatch immutability function is installed by the earlier
-- published-record migrations. Evidence/outcome history is insert-only.
CREATE TRIGGER federal_evidence_revision_immutable
  BEFORE UPDATE OR DELETE ON federal_evidence_revision
  FOR EACH ROW EXECUTE FUNCTION legiwatch_reject_record_rewrite();
CREATE TRIGGER federal_evidence_observation_immutable
  BEFORE UPDATE OR DELETE ON federal_evidence_observation
  FOR EACH ROW EXECUTE FUNCTION legiwatch_reject_record_rewrite();
CREATE TRIGGER federal_evidence_mention_immutable
  BEFORE UPDATE OR DELETE ON federal_evidence_mention
  FOR EACH ROW EXECUTE FUNCTION legiwatch_reject_record_rewrite();
CREATE TRIGGER federal_evidence_mention_event_immutable
  BEFORE UPDATE OR DELETE ON federal_evidence_mention_event
  FOR EACH ROW EXECUTE FUNCTION legiwatch_reject_record_rewrite();

GRANT SELECT, INSERT ON federal_evidence_revision, federal_evidence_observation,
  federal_evidence_mention, federal_evidence_mention_event TO capiro_app;
GRANT USAGE, SELECT ON SEQUENCE federal_evidence_observation_id_seq TO capiro_app;
GRANT SELECT, INSERT, UPDATE ON federal_evidence_change_outbox, federal_evidence_checkpoint TO capiro_app;
GRANT SELECT, INSERT, UPDATE ON federal_evidence_inventory_member, federal_evidence_coverage_gap TO capiro_app;
GRANT SELECT ON federal_evidence_current TO capiro_app;
REVOKE UPDATE, DELETE, TRUNCATE ON federal_evidence_revision, federal_evidence_observation,
  federal_evidence_mention, federal_evidence_mention_event FROM capiro_app;
