-- Committee-follow alerting: follow flag, notification-event email-delivery
-- columns, committee notification preference, two new event types, and the
-- notification-drain runtime registration. Forward-only; tenant-scoped RLS tables
-- use the canonical isolation policy shape as Wave 1's migration.

-- 1) follow: publication category flag (default true so follow() emits them)
ALTER TABLE legiwatch_committee_follow
  ADD COLUMN IF NOT EXISTS notify_on_publication BOOLEAN NOT NULL DEFAULT true,
  -- Durable bounded-intake boundary: once a follow sync has caught up to
  -- T (bounded retrospective) the runtime repeatedly fills the gap from the
  -- COALESCE(alert_started_at, created_at) watermark forward using NOT
  -- EXISTS recipient dedup — no timestamp-pagination skip possible. The
  -- catch-up path sets this atomically, no email is triggered from it.
  ADD COLUMN IF NOT EXISTS alert_started_at TIMESTAMPTZ(6);

-- 2) event-type CHECK: 'new_hearing' + 'committee_publication' become legal
ALTER TABLE legiwatch_notification_event
  DROP CONSTRAINT legiwatch_notification_event_type_check;
ALTER TABLE legiwatch_notification_event
  ADD CONSTRAINT legiwatch_notification_event_type_check CHECK(event_type IN (
    'schedule_changed','location_changed','witnesses_changed','hearing_starting',
    'capture_started','capture_failed','transcript_ready','intelligence_ready',
    'high_priority_match','bill_record','agenda_changed','live_update','hearing_recap',
    'record_brief','record_correction','bill_keyword',
    'new_hearing','committee_publication'));

-- subject-check must accept the two new types: 'committee_publication' may bind
-- a hearing or not; committee announcements can also precede a canonical hearing.
ALTER TABLE legiwatch_notification_event
  DROP CONSTRAINT legiwatch_notification_subject_check;
ALTER TABLE legiwatch_notification_event
  ADD CONSTRAINT legiwatch_notification_subject_check CHECK(
    (event_type IN ('record_brief','record_correction')
      AND hearing_record_brief_id IS NOT NULL AND hearing_id IS NOT NULL
      AND bill_id IS NULL AND hearing_publication_id IS NULL)
    OR
    (hearing_record_brief_id IS NULL AND (
      (event_type IN ('live_update','hearing_recap')
        AND hearing_publication_id IS NOT NULL AND bill_id IS NULL)
      OR
      (event_type IN ('bill_record','bill_keyword')
        AND bill_id IS NOT NULL AND hearing_id IS NULL AND hearing_publication_id IS NULL)
      OR
      (event_type NOT IN ('live_update','hearing_recap','bill_record','bill_keyword',
                          'record_brief','record_correction','committee_publication',
                          'new_hearing'
                          )
        AND hearing_id IS NOT NULL AND bill_id IS NULL AND hearing_publication_id IS NULL)
      OR
      (event_type='committee_publication' AND bill_id IS NULL AND hearing_publication_id IS NULL
        AND committee_system_code IS NOT NULL)
      OR
      (event_type='new_hearing' AND bill_id IS NULL AND hearing_publication_id IS NULL
        AND committee_system_code IS NOT NULL)
    )));

ALTER TABLE legiwatch_notification_event
  ADD COLUMN IF NOT EXISTS email_delivery_status TEXT,
  ADD COLUMN IF NOT EXISTS email_delivery_attempts INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS email_delivery_next_attempt_at TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS email_delivery_lease_until TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS email_delivery_last_error TEXT,
  ADD COLUMN IF NOT EXISTS email_delivery_sent_at TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS email_delivery_lease_id TEXT;

-- Status semantics per row. never queued by default --
-- NULL = not email-eligible (catch-up, prefs disabled, missing email)
-- queued | sending | sent | retry_wait | failed_final | suppressed
-- Dedup through lease-through on 'sending': a row that has actually delivered
-- on never returns; crashed-before-write-back rows DO retry (at-least-once
-- vs-Ses acknowledgement boundary is not claimable exact-once).
ALTER TABLE legiwatch_notification_event
  ADD CONSTRAINT legiwatch_notification_event_email_status_check CHECK(
    email_delivery_status IS NULL OR email_delivery_status IN (
      'queued','sending','sent','retry_wait','failed_final','suppressed'));

CREATE INDEX IF NOT EXISTS legiwatch_notification_event_email_drain_idx
  ON legiwatch_notification_event (email_delivery_status, email_delivery_next_attempt_at)
  WHERE email_delivery_status IS NOT NULL;

-- 3) dedicated committee notification preference (default off; email is resolved
-- server-side on each send and cached here only as an audit snapshot of the last
-- resolution; enabling requires the account email to exist at PUT time)
CREATE TABLE IF NOT EXISTS legiwatch_committee_email_preference (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  user_id TEXT NOT NULL,  -- internal users.id (::uuid stored as text)
  committee_email_enabled BOOLEAN NOT NULL DEFAULT false,
  email_address TEXT,
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT legiwatch_committee_email_preference_pkey PRIMARY KEY (id),
  CONSTRAINT legiwatch_committee_email_preference_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT legiwatch_committee_email_preference_user_key
    UNIQUE (tenant_id, user_id)
);
CREATE INDEX IF NOT EXISTS legiwatch_committee_email_preference_tenant_user_idx
  ON legiwatch_committee_email_preference (tenant_id, user_id);

-- 4) phase9 runtime registration (default disabled; deployment enables while wiring
-- EventBridge target) so `legiwatch-phase9-job notification-drain` is a
-- registered job rather than an unknown key at first run.
ALTER TABLE legiwatch_runtime_heartbeat DROP CONSTRAINT legiwatch_runtime_heartbeat_type_check;
ALTER TABLE legiwatch_runtime_heartbeat ADD CONSTRAINT legiwatch_runtime_heartbeat_type_check CHECK (
  job_type IN ('central_discovery','committee_enrichment','committee_updates','source_probe','coverage_audit',
    'stream_preflight','capture_worker','archive_reconciliation','intelligence_worker','relevance_worker',
    'parallel_comparison','metrics','hearing_media_worker','hearing_delivery_worker','notification_drain')
);
INSERT INTO legiwatch_runtime_heartbeat(job_key,job_type,status,enabled,schedule_enabled,expected_interval_seconds,max_lag_seconds,metrics)
SELECT 'notification-drain','notification_drain','idle',false,false,300,7200,'{}'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM legiwatch_runtime_heartbeat WHERE job_key='notification-drain');

-- 5) RLS for the new tenant-scoped preference. Tenant-scoped tables in
-- the apps/api path intentionally rely on the Prisma query hook; the isolation
-- policy shape matches every other legiwatch table (belt-and-suspenders only).
ALTER TABLE legiwatch_committee_email_preference ENABLE ROW LEVEL SECURITY;
ALTER TABLE legiwatch_committee_email_preference FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = current_schema()
      AND tablename = 'legiwatch_committee_email_preference'
      AND policyname = 'legiwatch_committee_email_preference_isolation'
  ) THEN
    EXECUTE 'CREATE POLICY "legiwatch_committee_email_preference_isolation"
              ON "legiwatch_committee_email_preference"
              USING (rls_bypass() OR tenant_id = current_tenant_id())
              WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id())';
  END IF;
END $$;
