-- Phase 8 Session 7 — Annual Defense Budget Cycle Controller +
-- Defense Budget Lifecycle Watcher control plane.
--
-- This is CONTROL-PLANE state. It records which official sources are expected,
-- which bytes have actually been seen, how they were classified, and what
-- governed ingestion work that implies. It deliberately contains NO monetary
-- column of any kind:
--
--   * a missing or not-filed source is a recorded state, never zero funding;
--   * discovery may say an official document exists and classify it, but
--     provisions, allocations and dollars come only through the governed
--     Session 6 evidence-bound ingestion path.
--
-- Immutable source identity remains `source_document` (source_key + sha256,
-- with the existing superseded_by_document_id version chain). Nothing here
-- competes with it; these tables hold only the state `source_document` does not
-- model: expected source family, adapter cursor/checkpoint, discovery status,
-- lifecycle classification, retry/error status, queue status, and
-- missing/not-filed/review-required state.

-- ───────────────────────────────────────────────────────────────────────────
-- 1. Cycle identity
--
-- Identity is (fiscal_year, authority_track), never a global current FY. The
-- UNIQUE constraint below is what makes "a newer authorization mark must never
-- overwrite an appropriations position" structural rather than aspirational:
-- the two tracks are different rows and cannot address each other.
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE "defense_budget_cycle" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "fiscal_year" INTEGER NOT NULL,
  "authority_track" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'draft',
  "template_version" TEXT NOT NULL,
  "bootstrap_origin" TEXT NOT NULL,
  "opened_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "closed_at" TIMESTAMPTZ(6),
  "dedup_key" CHAR(64) NOT NULL,
  "metadata_jsonb" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "defense_budget_cycle_track_chk" CHECK (
    "authority_track" IN (
      'request',
      'authorization',
      'appropriations',
      'alternative_funding',
      'execution'
    )
  ),
  CONSTRAINT "defense_budget_cycle_status_chk" CHECK (
    "status" IN ('draft', 'active', 'closed')
  ),
  CONSTRAINT "defense_budget_cycle_origin_chk" CHECK (
    "bootstrap_origin" IN ('discovery', 'template', 'operator')
  ),
  CONSTRAINT "defense_budget_cycle_fy_chk" CHECK (
    "fiscal_year" BETWEEN 1900 AND 2200
  ),
  CONSTRAINT "defense_budget_cycle_closed_chk" CHECK (
    "status" <> 'closed' OR "closed_at" IS NOT NULL
  ),
  CONSTRAINT "defense_budget_cycle_dedup_key_chk" CHECK (
    "dedup_key" ~ '^[0-9a-f]{64}$'
  )
);

CREATE UNIQUE INDEX "defense_budget_cycle_fy_track_key"
  ON "defense_budget_cycle"("fiscal_year", "authority_track");
CREATE UNIQUE INDEX "defense_budget_cycle_dedup_key_key"
  ON "defense_budget_cycle"("dedup_key");
CREATE INDEX "defense_budget_cycle_status_idx"
  ON "defense_budget_cycle"("status", "fiscal_year");

-- ───────────────────────────────────────────────────────────────────────────
-- 2. Expected source families
--
-- Instantiated from a versioned template, not from last year's URLs. There is
-- no amount column: an expected source that is never filed carries the state
-- 'not_filed' and no number.
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE "defense_budget_expected_source" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "cycle_id" UUID NOT NULL,
  "fiscal_year" INTEGER NOT NULL,
  "authority_track" TEXT NOT NULL,
  "stage" TEXT NOT NULL,
  "source_family" TEXT NOT NULL,
  "chamber" TEXT,
  "committee" TEXT,
  "component" TEXT,
  "adapter_id" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "expected_state" TEXT NOT NULL DEFAULT 'expected',
  "optional" BOOLEAN NOT NULL DEFAULT FALSE,
  "template_version" TEXT NOT NULL,
  "expected_from" TIMESTAMPTZ(6) NOT NULL,
  "expected_to" TIMESTAMPTZ(6) NOT NULL,
  "review_reason" TEXT,
  "dedup_key" CHAR(64) NOT NULL,
  "metadata_jsonb" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "defense_budget_expected_source_state_chk" CHECK (
    "expected_state" IN (
      'expected',
      'not_filed',
      'published',
      'superseded',
      'withdrawn',
      'unavailable',
      'review_required'
    )
  ),
  CONSTRAINT "defense_budget_expected_source_track_chk" CHECK (
    "authority_track" IN (
      'request',
      'authorization',
      'appropriations',
      'alternative_funding',
      'execution'
    )
  ),
  CONSTRAINT "defense_budget_expected_source_chamber_chk" CHECK (
    "chamber" IS NULL OR "chamber" IN ('house', 'senate', 'joint')
  ),
  CONSTRAINT "defense_budget_expected_source_component_chk" CHECK (
    "component" IS NULL OR "component" IN ('ARMY', 'NAVY', 'USMC', 'AF', 'SF', 'DW')
  ),
  CONSTRAINT "defense_budget_expected_source_window_chk" CHECK (
    "expected_from" <= "expected_to"
  ),
  CONSTRAINT "defense_budget_expected_source_review_chk" CHECK (
    "expected_state" <> 'review_required' OR "review_reason" IS NOT NULL
  ),
  CONSTRAINT "defense_budget_expected_source_dedup_key_chk" CHECK (
    "dedup_key" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "defense_budget_expected_source_cycle_fk"
    FOREIGN KEY ("cycle_id") REFERENCES "defense_budget_cycle"("id")
    ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE UNIQUE INDEX "defense_budget_expected_source_dedup_key_key"
  ON "defense_budget_expected_source"("dedup_key");
CREATE INDEX "defense_budget_expected_source_cycle_idx"
  ON "defense_budget_expected_source"("cycle_id", "stage");
CREATE INDEX "defense_budget_expected_source_state_idx"
  ON "defense_budget_expected_source"("expected_state", "fiscal_year");
CREATE INDEX "defense_budget_expected_source_adapter_idx"
  ON "defense_budget_expected_source"("adapter_id");

-- ───────────────────────────────────────────────────────────────────────────
-- 3. Source observations — the fingerprint / revision ledger
--
-- One row per (expected source, content sha256). Two watcher runs that see the
-- same bytes therefore create ONE observation: the unique index below is the
-- idempotency guarantee, not a convention.
--
-- ETag / Last-Modified are stored purely as conditional-fetch optimisations.
-- content_sha256 is the authoritative content identity, and it is NOT NULL.
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE "defense_budget_source_observation" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "expected_source_id" UUID NOT NULL,
  "cycle_id" UUID NOT NULL,
  "adapter_id" TEXT NOT NULL,
  "discovered_url" TEXT NOT NULL,
  "http_etag" TEXT,
  "http_last_modified" TEXT,
  "content_sha256" CHAR(64) NOT NULL,
  "byte_size" INTEGER,
  "observation_state" TEXT NOT NULL DEFAULT 'discovered',
  "revision_kind" TEXT NOT NULL,
  "classified_fiscal_year" INTEGER,
  "classified_authority_track" TEXT,
  "classified_stage" TEXT,
  "classified_source_family" TEXT,
  "classification_confidence" NUMERIC(4,3),
  "review_reasons" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "source_document_id" UUID,
  "superseded_by_observation_id" UUID,
  "first_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "seen_count" INTEGER NOT NULL DEFAULT 1,
  "dedup_key" CHAR(64) NOT NULL,
  "metadata_jsonb" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "defense_budget_source_observation_state_chk" CHECK (
    "observation_state" IN (
      'discovered',
      'downloaded',
      'unchanged',
      'changed',
      'classified',
      'review_required',
      'queued',
      'ingested',
      'blocked',
      'superseded',
      'withdrawn'
    )
  ),
  CONSTRAINT "defense_budget_source_observation_revision_chk" CHECK (
    "revision_kind" IN (
      'first_discovery',
      'unchanged',
      'changed',
      'replacement_url',
      'superseding_version'
    )
  ),
  CONSTRAINT "defense_budget_source_observation_sha_chk" CHECK (
    "content_sha256" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "defense_budget_source_observation_dedup_key_chk" CHECK (
    "dedup_key" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "defense_budget_source_observation_byte_size_chk" CHECK (
    "byte_size" IS NULL OR "byte_size" > 0
  ),
  CONSTRAINT "defense_budget_source_observation_confidence_chk" CHECK (
    "classification_confidence" IS NULL
    OR ("classification_confidence" >= 0 AND "classification_confidence" <= 1)
  ),
  -- An ambiguous source must carry the reason a human has to look at it.
  CONSTRAINT "defense_budget_source_observation_review_reason_chk" CHECK (
    "observation_state" <> 'review_required'
    OR jsonb_array_length("review_reasons") > 0
  ),
  -- Ambiguous classification may not claim a resolved FY/track/stage. This is
  -- what stops "review" quietly behaving like "accepted".
  CONSTRAINT "defense_budget_source_observation_review_no_stage_chk" CHECK (
    "observation_state" <> 'review_required'
    OR (
      "classified_authority_track" IS NULL
      AND "classified_stage" IS NULL
    )
  ),
  -- Reaching 'ingested' requires immutable registered source identity.
  CONSTRAINT "defense_budget_source_observation_ingested_chk" CHECK (
    "observation_state" <> 'ingested' OR "source_document_id" IS NOT NULL
  ),
  -- A superseded observation is never deleted; it points at its successor.
  CONSTRAINT "defense_budget_source_observation_superseded_chk" CHECK (
    "observation_state" <> 'superseded' OR "superseded_by_observation_id" IS NOT NULL
  ),
  CONSTRAINT "defense_budget_source_observation_self_supersede_chk" CHECK (
    "superseded_by_observation_id" IS NULL OR "superseded_by_observation_id" <> "id"
  ),
  CONSTRAINT "defense_budget_source_observation_seen_count_chk" CHECK (
    "seen_count" >= 1
  ),
  CONSTRAINT "defense_budget_source_observation_seen_order_chk" CHECK (
    "first_seen_at" <= "last_seen_at"
  ),
  CONSTRAINT "defense_budget_source_observation_expected_fk"
    FOREIGN KEY ("expected_source_id") REFERENCES "defense_budget_expected_source"("id")
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT "defense_budget_source_observation_cycle_fk"
    FOREIGN KEY ("cycle_id") REFERENCES "defense_budget_cycle"("id")
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT "defense_budget_source_observation_source_document_fk"
    FOREIGN KEY ("source_document_id") REFERENCES "source_document"("id")
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT "defense_budget_source_observation_supersede_fk"
    FOREIGN KEY ("superseded_by_observation_id")
    REFERENCES "defense_budget_source_observation"("id")
    ON UPDATE CASCADE ON DELETE RESTRICT
);

-- Idempotency: the same bytes for the same expected source are ONE observation.
CREATE UNIQUE INDEX "defense_budget_source_observation_expected_sha_key"
  ON "defense_budget_source_observation"("expected_source_id", "content_sha256");
CREATE UNIQUE INDEX "defense_budget_source_observation_dedup_key_key"
  ON "defense_budget_source_observation"("dedup_key");
-- Parent key for the ingestion-outbox composite foreign key below.
CREATE UNIQUE INDEX "defense_budget_source_observation_id_state_key"
  ON "defense_budget_source_observation"("id", "observation_state");
CREATE INDEX "defense_budget_source_observation_cycle_state_idx"
  ON "defense_budget_source_observation"("cycle_id", "observation_state");
CREATE INDEX "defense_budget_source_observation_sha_idx"
  ON "defense_budget_source_observation"("content_sha256");
CREATE INDEX "defense_budget_source_observation_source_document_idx"
  ON "defense_budget_source_observation"("source_document_id");
CREATE INDEX "defense_budget_source_observation_review_idx"
  ON "defense_budget_source_observation"("observation_state")
  WHERE "observation_state" = 'review_required';

-- ───────────────────────────────────────────────────────────────────────────
-- 4. Adapter checkpoint / cursor / lease
--
-- Durable discovery state plus the single-owner lease that makes concurrent
-- workers safe and a crashed run resumable.
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE "defense_budget_watcher_adapter" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "adapter_id" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'idle',
  "cursor_jsonb" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "checkpoint_jsonb" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "last_check_at" TIMESTAMPTZ(6),
  "last_success_at" TIMESTAMPTZ(6),
  "next_check_at" TIMESTAMPTZ(6),
  "consecutive_failures" INTEGER NOT NULL DEFAULT 0,
  "last_error_class" TEXT,
  "last_error_message" TEXT,
  "lease_owner" TEXT,
  "lease_expires_at" TIMESTAMPTZ(6),
  "requires_gpu" BOOLEAN NOT NULL DEFAULT FALSE,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "defense_budget_watcher_adapter_status_chk" CHECK (
    "status" IN ('idle', 'leased', 'running', 'failing', 'disabled')
  ),
  CONSTRAINT "defense_budget_watcher_adapter_failures_chk" CHECK (
    "consecutive_failures" >= 0
  ),
  CONSTRAINT "defense_budget_watcher_adapter_lease_chk" CHECK (
    ("lease_owner" IS NULL) = ("lease_expires_at" IS NULL)
  ),
  -- Source discovery is CPU/network work. Under the accepted Session 5 negative
  -- provider decision no watcher adapter may declare a GPU dependency.
  CONSTRAINT "defense_budget_watcher_adapter_no_gpu_chk" CHECK (
    "requires_gpu" = FALSE
  )
);

CREATE UNIQUE INDEX "defense_budget_watcher_adapter_adapter_id_key"
  ON "defense_budget_watcher_adapter"("adapter_id");
CREATE INDEX "defense_budget_watcher_adapter_next_check_idx"
  ON "defense_budget_watcher_adapter"("next_check_at");

CREATE TABLE "defense_budget_watcher_run" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "adapter_id" TEXT NOT NULL,
  "run_key" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'running',
  "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finished_at" TIMESTAMPTZ(6),
  "discovered_count" INTEGER NOT NULL DEFAULT 0,
  "unchanged_count" INTEGER NOT NULL DEFAULT 0,
  "changed_count" INTEGER NOT NULL DEFAULT 0,
  "review_count" INTEGER NOT NULL DEFAULT 0,
  "queued_count" INTEGER NOT NULL DEFAULT 0,
  "blocked_count" INTEGER NOT NULL DEFAULT 0,
  "attempt" INTEGER NOT NULL DEFAULT 1,
  "error_class" TEXT,
  "error_message" TEXT,
  "next_check_at" TIMESTAMPTZ(6),
  "metadata_jsonb" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "defense_budget_watcher_run_status_chk" CHECK (
    "status" IN ('running', 'succeeded', 'failed', 'partial')
  ),
  CONSTRAINT "defense_budget_watcher_run_counts_chk" CHECK (
    "discovered_count" >= 0
    AND "unchanged_count" >= 0
    AND "changed_count" >= 0
    AND "review_count" >= 0
    AND "queued_count" >= 0
    AND "blocked_count" >= 0
  ),
  -- A run may never queue more governed ingestion work than the number of
  -- changed/new sources it actually observed.
  CONSTRAINT "defense_budget_watcher_run_queue_bound_chk" CHECK (
    "queued_count" <= "changed_count"
  ),
  CONSTRAINT "defense_budget_watcher_run_attempt_chk" CHECK ("attempt" >= 1),
  CONSTRAINT "defense_budget_watcher_run_finished_chk" CHECK (
    "status" = 'running' OR "finished_at" IS NOT NULL
  ),
  CONSTRAINT "defense_budget_watcher_run_adapter_fk"
    FOREIGN KEY ("adapter_id") REFERENCES "defense_budget_watcher_adapter"("adapter_id")
    ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE UNIQUE INDEX "defense_budget_watcher_run_adapter_run_key"
  ON "defense_budget_watcher_run"("adapter_id", "run_key");
CREATE INDEX "defense_budget_watcher_run_status_idx"
  ON "defense_budget_watcher_run"("status", "started_at");

-- ───────────────────────────────────────────────────────────────────────────
-- 5. Governed ingestion outbox
--
-- The queue boundary between discovery and the governed Session 6 ingestion
-- path. Two guarantees are enforced here rather than trusted to callers:
--
--   * UNIQUE (observation_id, job_kind): a changed source queues EXACTLY ONE
--     job, and a repeated observation or a concurrent worker collides on the
--     unique key instead of double-enqueueing.
--   * the composite FK on (observation_id, observation_state) with
--     ON UPDATE CASCADE, combined with the queueable CHECK, makes it impossible
--     to queue an ambiguous/blocked/withdrawn observation — and impossible to
--     move an already-queued observation INTO review without the cascade
--     failing the whole statement.
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE "defense_budget_ingestion_outbox" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "observation_id" UUID NOT NULL,
  "observation_state" TEXT NOT NULL,
  "cycle_id" UUID NOT NULL,
  "job_kind" TEXT NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'pending',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "available_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leased_by" TEXT,
  "leased_until" TIMESTAMPTZ(6),
  "last_error" TEXT,
  "dedup_key" CHAR(64) NOT NULL,
  "metadata_jsonb" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "defense_budget_ingestion_outbox_job_kind_chk" CHECK (
    "job_kind" IN (
      'governed_source_ingestion',
      'governed_alternative_funding_ingestion'
    )
  ),
  CONSTRAINT "defense_budget_ingestion_outbox_state_chk" CHECK (
    "state" IN ('pending', 'leased', 'succeeded', 'failed', 'dead_letter')
  ),
  CONSTRAINT "defense_budget_ingestion_outbox_attempts_chk" CHECK ("attempts" >= 0),
  CONSTRAINT "defense_budget_ingestion_outbox_lease_chk" CHECK (
    ("leased_by" IS NULL) = ("leased_until" IS NULL)
  ),
  CONSTRAINT "defense_budget_ingestion_outbox_leased_state_chk" CHECK (
    "state" <> 'leased' OR "leased_by" IS NOT NULL
  ),
  CONSTRAINT "defense_budget_ingestion_outbox_dedup_key_chk" CHECK (
    "dedup_key" ~ '^[0-9a-f]{64}$'
  ),
  -- Ambiguous classification stops in review; it never advances into ingestion.
  CONSTRAINT "defense_budget_ingestion_outbox_queueable_chk" CHECK (
    "observation_state" NOT IN ('review_required', 'blocked', 'withdrawn')
  ),
  CONSTRAINT "defense_budget_ingestion_outbox_observation_fk"
    FOREIGN KEY ("observation_id", "observation_state")
    REFERENCES "defense_budget_source_observation"("id", "observation_state")
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT "defense_budget_ingestion_outbox_cycle_fk"
    FOREIGN KEY ("cycle_id") REFERENCES "defense_budget_cycle"("id")
    ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE UNIQUE INDEX "defense_budget_ingestion_outbox_observation_job_key"
  ON "defense_budget_ingestion_outbox"("observation_id", "job_kind");
CREATE UNIQUE INDEX "defense_budget_ingestion_outbox_dedup_key_key"
  ON "defense_budget_ingestion_outbox"("dedup_key");
CREATE INDEX "defense_budget_ingestion_outbox_ready_idx"
  ON "defense_budget_ingestion_outbox"("state", "available_at");
CREATE INDEX "defense_budget_ingestion_outbox_cycle_idx"
  ON "defense_budget_ingestion_outbox"("cycle_id");

-- ───────────────────────────────────────────────────────────────────────────
-- 6. Lifecycle signals
--
-- Source-backed deltas between stages. A signal is a notification; Meri, CRM
-- and Strategies decide the workflow. The CHECK below refuses any payload key
-- that would turn a discovery signal into a funding assertion, at any nesting
-- depth.
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE "defense_budget_lifecycle_signal" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "cycle_id" UUID NOT NULL,
  "signal_kind" TEXT NOT NULL,
  "fiscal_year" INTEGER NOT NULL,
  "authority_track" TEXT NOT NULL,
  "from_stage" TEXT NOT NULL,
  "to_stage" TEXT NOT NULL,
  "from_observation_id" UUID NOT NULL,
  "to_observation_id" UUID NOT NULL,
  "emitted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "dedup_key" CHAR(64) NOT NULL,
  "payload_jsonb" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "defense_budget_lifecycle_signal_kind_chk" CHECK (
    "signal_kind" IN (
      'pb_to_hasc',
      'pb_to_sasc',
      'pb_to_hac_d',
      'pb_to_sac_d',
      'house_to_senate',
      'latest_mark_to_conference',
      'conference_to_enacted',
      'source_correction'
    )
  ),
  CONSTRAINT "defense_budget_lifecycle_signal_track_chk" CHECK (
    "authority_track" IN (
      'request',
      'authorization',
      'appropriations',
      'alternative_funding',
      'execution'
    )
  ),
  CONSTRAINT "defense_budget_lifecycle_signal_dedup_key_chk" CHECK (
    "dedup_key" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "defense_budget_lifecycle_signal_distinct_chk" CHECK (
    "from_observation_id" <> "to_observation_id"
  ),
  CONSTRAINT "defense_budget_lifecycle_signal_no_dollars_chk" CHECK (
    "payload_jsonb"::text !~*
      '"(authoritativeAmountUsd|amountUsd|statedAmountUsd|allocatedUsd|obligatedUsd|outlayUsd|amountM|totalUsd)"[[:space:]]*:'
  ),
  CONSTRAINT "defense_budget_lifecycle_signal_cycle_fk"
    FOREIGN KEY ("cycle_id") REFERENCES "defense_budget_cycle"("id")
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT "defense_budget_lifecycle_signal_from_fk"
    FOREIGN KEY ("from_observation_id")
    REFERENCES "defense_budget_source_observation"("id")
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT "defense_budget_lifecycle_signal_to_fk"
    FOREIGN KEY ("to_observation_id")
    REFERENCES "defense_budget_source_observation"("id")
    ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE UNIQUE INDEX "defense_budget_lifecycle_signal_dedup_key_key"
  ON "defense_budget_lifecycle_signal"("dedup_key");
CREATE INDEX "defense_budget_lifecycle_signal_cycle_idx"
  ON "defense_budget_lifecycle_signal"("cycle_id", "signal_kind");
CREATE INDEX "defense_budget_lifecycle_signal_emitted_idx"
  ON "defense_budget_lifecycle_signal"("emitted_at");

-- ───────────────────────────────────────────────────────────────────────────
-- 7. Least-privilege grants
--
-- HTTP serve reads the cycle-health state. The job/ingestion role is the only
-- writer, and it cannot DELETE: a superseded observation, a failed run and a
-- withdrawn source all stay auditable. No promotion authority exists here at
-- all — Session 7 adds no snapshot activation path.
-- ───────────────────────────────────────────────────────────────────────────
REVOKE ALL ON TABLE "defense_budget_cycle" FROM PUBLIC;
REVOKE ALL ON TABLE "defense_budget_expected_source" FROM PUBLIC;
REVOKE ALL ON TABLE "defense_budget_source_observation" FROM PUBLIC;
REVOKE ALL ON TABLE "defense_budget_watcher_adapter" FROM PUBLIC;
REVOKE ALL ON TABLE "defense_budget_watcher_run" FROM PUBLIC;
REVOKE ALL ON TABLE "defense_budget_ingestion_outbox" FROM PUBLIC;
REVOKE ALL ON TABLE "defense_budget_lifecycle_signal" FROM PUBLIC;

GRANT SELECT ON TABLE "defense_budget_cycle" TO "capiro_defense_serve";
GRANT SELECT ON TABLE "defense_budget_expected_source" TO "capiro_defense_serve";
GRANT SELECT ON TABLE "defense_budget_source_observation" TO "capiro_defense_serve";
GRANT SELECT ON TABLE "defense_budget_watcher_adapter" TO "capiro_defense_serve";
GRANT SELECT ON TABLE "defense_budget_watcher_run" TO "capiro_defense_serve";
GRANT SELECT ON TABLE "defense_budget_ingestion_outbox" TO "capiro_defense_serve";
GRANT SELECT ON TABLE "defense_budget_lifecycle_signal" TO "capiro_defense_serve";

GRANT SELECT, INSERT, UPDATE ON TABLE "defense_budget_cycle" TO "capiro_defense_job";
GRANT SELECT, INSERT, UPDATE ON TABLE "defense_budget_expected_source" TO "capiro_defense_job";
GRANT SELECT, INSERT, UPDATE ON TABLE "defense_budget_source_observation" TO "capiro_defense_job";
GRANT SELECT, INSERT, UPDATE ON TABLE "defense_budget_watcher_adapter" TO "capiro_defense_job";
GRANT SELECT, INSERT, UPDATE ON TABLE "defense_budget_watcher_run" TO "capiro_defense_job";
GRANT SELECT, INSERT, UPDATE ON TABLE "defense_budget_ingestion_outbox" TO "capiro_defense_job";
GRANT SELECT, INSERT, UPDATE ON TABLE "defense_budget_lifecycle_signal" TO "capiro_defense_job";
