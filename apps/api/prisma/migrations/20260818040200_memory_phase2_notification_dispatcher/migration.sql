-- Phase 2 increment 4B: concurrent dispatcher leases and recipient-facing in-app notifications.
-- The outbox remains the delivery authority. In-app rows are body-free projections
-- created only after fresh membership, workflow, feature-flag, and memory-policy checks.

CREATE UNIQUE INDEX IF NOT EXISTS review_request_tenant_id_id_unique
  ON review_request (tenant_id, id);

ALTER TABLE memory_review_notification_outbox
  ADD COLUMN IF NOT EXISTS lease_token uuid,
  ADD COLUMN IF NOT EXISTS leased_until timestamptz,
  ADD COLUMN IF NOT EXISTS last_attempt_at timestamptz,
  ADD COLUMN IF NOT EXISTS terminal_at timestamptz,
  ADD COLUMN IF NOT EXISTS email_status varchar(24),
  ADD COLUMN IF NOT EXISTS provider_message_id varchar(320);

DO $$
BEGIN
  ALTER TABLE memory_review_notification_outbox
    ADD CONSTRAINT memory_review_notification_outbox_email_status_check
    CHECK (
      email_status IS NULL
      OR email_status IN ('sending', 'sent', 'suppressed', 'failed')
    );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE memory_review_notification_outbox
    ADD CONSTRAINT memory_review_notification_outbox_review_fk
    FOREIGN KEY (tenant_id, review_request_id)
    REFERENCES review_request (tenant_id, id)
    ON UPDATE NO ACTION
    ON DELETE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE memory_review_notification_outbox
    ADD CONSTRAINT memory_review_notification_outbox_candidate_fk
    FOREIGN KEY (tenant_id, candidate_id)
    REFERENCES memory_candidate (tenant_id, id)
    ON UPDATE NO ACTION
    ON DELETE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE memory_review_notification_outbox
    ADD CONSTRAINT memory_review_notification_outbox_recipient_fk
    FOREIGN KEY (recipient_user_id)
    REFERENCES users (id)
    ON UPDATE NO ACTION
    ON DELETE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS memory_review_notification_outbox_claim_idx
  ON memory_review_notification_outbox (
    available_at,
    leased_until,
    attempts,
    created_at
  )
  WHERE delivered_at IS NULL
    AND terminal_at IS NULL;

CREATE TABLE IF NOT EXISTS memory_review_in_app_notification (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL,
  recipient_user_id uuid NOT NULL,
  review_request_id uuid NOT NULL,
  candidate_id uuid NOT NULL,
  client_id uuid,
  event_type varchar(48) NOT NULL,
  title varchar(300) NOT NULL,
  metadata_jsonb jsonb NOT NULL DEFAULT '{}'::jsonb,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT memory_review_in_app_notification_event_check
    CHECK (event_type IN (
      'review_assigned',
      'review_revision_assigned',
      'review_reassigned',
      'review_changes_requested',
      'review_approved',
      'review_rejected'
    )),
  CONSTRAINT memory_review_in_app_notification_payload_check
    CHECK (
      char_length(title) BETWEEN 1 AND 300
      AND jsonb_typeof(metadata_jsonb) = 'object'
      AND pg_column_size(metadata_jsonb) <= 4096
      AND NOT (metadata_jsonb ?| ARRAY[
        'value',
        'sections',
        'body',
        'reason',
        'feedbackReason',
        'sourceExcerpt',
        'source_excerpt'
      ])
    ),
  CONSTRAINT memory_review_in_app_notification_review_fk
    FOREIGN KEY (tenant_id, review_request_id)
    REFERENCES review_request (tenant_id, id)
    ON UPDATE NO ACTION
    ON DELETE CASCADE,
  CONSTRAINT memory_review_in_app_notification_candidate_fk
    FOREIGN KEY (tenant_id, candidate_id)
    REFERENCES memory_candidate (tenant_id, id)
    ON UPDATE NO ACTION
    ON DELETE CASCADE,
  CONSTRAINT memory_review_in_app_notification_recipient_fk
    FOREIGN KEY (recipient_user_id)
    REFERENCES users (id)
    ON UPDATE NO ACTION
    ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS memory_review_in_app_notification_idempotency_unique
  ON memory_review_in_app_notification (
    tenant_id,
    recipient_user_id,
    review_request_id,
    event_type
  );

CREATE INDEX IF NOT EXISTS memory_review_in_app_notification_inbox_idx
  ON memory_review_in_app_notification (
    tenant_id,
    recipient_user_id,
    read_at,
    created_at DESC
  );

ALTER TABLE memory_review_in_app_notification ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_review_in_app_notification FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS memory_review_in_app_notification_recipient_isolation
  ON memory_review_in_app_notification;
CREATE POLICY memory_review_in_app_notification_recipient_isolation
  ON memory_review_in_app_notification
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR (
      tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid
      AND recipient_user_id = NULLIF(current_setting('app.current_user', true), '')::uuid
    )
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR (
      tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid
      AND recipient_user_id = NULLIF(current_setting('app.current_user', true), '')::uuid
    )
  );
