-- CreateTable
CREATE TABLE "intel_hearing_media_permission" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "source_url" TEXT NOT NULL,
    "hearing_id" TEXT,
    "mode" TEXT NOT NULL DEFAULT 'browser',
    "operations" TEXT[],
    "evidence" TEXT NOT NULL,
    "reviewed_by" TEXT NOT NULL,
    "reviewed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "retention_days" INTEGER NOT NULL,
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "intel_hearing_media_permission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "intel_hearing_recording" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "permission_id" TEXT NOT NULL,
    "permission_snapshot" JSONB NOT NULL,
    "origin_at" TIMESTAMP(3) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'recording',
    "transcript_state" TEXT NOT NULL DEFAULT 'streaming',
    "analysis_state" TEXT NOT NULL DEFAULT 'pending',
    "finalized_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "intel_hearing_recording_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "intel_hearing_recording_epoch" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "recording_id" TEXT NOT NULL,
    "capture_token" TIMESTAMP(3) NOT NULL,
    "mime_type" TEXT NOT NULL,
    "start_ms" INTEGER NOT NULL,
    "durable_end_ms" INTEGER NOT NULL DEFAULT 0,
    "durable_sequence" INTEGER NOT NULL DEFAULT -1,
    "durable_bytes" BIGINT NOT NULL DEFAULT 0,
    "expected_final_sequence" INTEGER,
    "complete" BOOLEAN NOT NULL DEFAULT false,
    "state" TEXT NOT NULL DEFAULT 'recording',
    "reason" TEXT,
    "artifact_key" TEXT,
    "artifact_hash" TEXT,
    "artifact_bytes" BIGINT,
    "decoded_duration_ms" INTEGER,
    "assembly_token" TEXT,
    "assembly_lease_until" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "intel_hearing_recording_epoch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "intel_hearing_recording_part" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "epoch_id" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "end_ms" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "byte_length" INTEGER NOT NULL,
    "object_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "intel_hearing_recording_part_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "intel_hearing_media_permission_tenant_id_source_url_mode_idx" ON "intel_hearing_media_permission"("tenant_id", "source_url", "mode");

-- CreateIndex
CREATE UNIQUE INDEX "intel_hearing_media_permission_tenant_id_id_key" ON "intel_hearing_media_permission"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "intel_hearing_recording_expires_at_state_idx" ON "intel_hearing_recording"("expires_at", "state");

-- CreateIndex
CREATE UNIQUE INDEX "intel_hearing_recording_tenant_id_id_key" ON "intel_hearing_recording"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "intel_hearing_recording_tenant_id_session_id_key" ON "intel_hearing_recording"("tenant_id", "session_id");

-- CreateIndex
CREATE INDEX "intel_hearing_recording_epoch_state_assembly_lease_until_idx" ON "intel_hearing_recording_epoch"("state", "assembly_lease_until");

-- CreateIndex
CREATE UNIQUE INDEX "intel_hearing_recording_epoch_tenant_id_id_key" ON "intel_hearing_recording_epoch"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "intel_hearing_recording_epoch_tenant_id_recording_id_captur_key" ON "intel_hearing_recording_epoch"("tenant_id", "recording_id", "capture_token");

-- CreateIndex
CREATE UNIQUE INDEX "intel_hearing_recording_part_tenant_id_epoch_id_sequence_key" ON "intel_hearing_recording_part"("tenant_id", "epoch_id", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "intel_live_hearing_session_tenant_id_id_key" ON "intel_live_hearing_session"("tenant_id", "id");

-- AddForeignKey
ALTER TABLE "intel_hearing_recording" ADD CONSTRAINT "intel_hearing_recording_tenant_id_session_id_fkey" FOREIGN KEY ("tenant_id", "session_id") REFERENCES "intel_live_hearing_session"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "intel_hearing_recording_epoch" ADD CONSTRAINT "intel_hearing_recording_epoch_tenant_id_recording_id_fkey" FOREIGN KEY ("tenant_id", "recording_id") REFERENCES "intel_hearing_recording"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "intel_hearing_recording_part" ADD CONSTRAINT "intel_hearing_recording_part_tenant_id_epoch_id_fkey" FOREIGN KEY ("tenant_id", "epoch_id") REFERENCES "intel_hearing_recording_epoch"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE intel_hearing_recording ADD CONSTRAINT recording_permission_scope
  FOREIGN KEY (tenant_id,permission_id) REFERENCES intel_hearing_media_permission(tenant_id,id) ON DELETE RESTRICT;
ALTER TABLE intel_hearing_media_permission ADD CONSTRAINT recording_permission_bounds CHECK
  (mode IN ('browser','server') AND retention_days BETWEEN 1 AND 90 AND expires_at > reviewed_at);
ALTER TABLE intel_hearing_recording ADD CONSTRAINT recording_state CHECK
  (state IN ('recording','processing','ready','partial','expired') AND expires_at > origin_at);
ALTER TABLE intel_hearing_recording_epoch ADD CONSTRAINT recording_epoch_bounds CHECK
  (start_ms >= 0 AND durable_end_ms >= start_ms AND durable_sequence >= -1 AND durable_bytes >= 0
   AND state IN ('recording','queued','assembling','ready','failed','expired')
   AND (decoded_duration_ms IS NULL OR decoded_duration_ms > 0));
ALTER TABLE intel_hearing_recording_part ADD CONSTRAINT recording_part_bounds CHECK
  (sequence >= 0 AND end_ms >= 0 AND byte_length BETWEEN 1 AND 262144 AND sha256 ~ '^[0-9a-f]{64}$');

CREATE FUNCTION hearing_recording_session_access(record_tenant text, record_session text)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT record_tenant = current_tenant_id()::text AND EXISTS (
    SELECT 1 FROM intel_live_hearing_session s
    WHERE s.tenant_id=record_tenant AND s.id=record_session
      AND (s.source_type IN ('hearing','markup') OR s.created_by=current_setting('app.hearing_actor',true))
  )
$$;

ALTER TABLE intel_hearing_media_permission ENABLE ROW LEVEL SECURITY;
ALTER TABLE intel_hearing_media_permission FORCE ROW LEVEL SECURITY;
CREATE POLICY recording_permission_tenant ON intel_hearing_media_permission FOR ALL
  USING (tenant_id=current_tenant_id()::text OR current_setting('app.bypass_rls',true)='on')
  WITH CHECK (tenant_id=current_tenant_id()::text OR current_setting('app.bypass_rls',true)='on');

ALTER TABLE intel_hearing_recording ENABLE ROW LEVEL SECURITY;
ALTER TABLE intel_hearing_recording FORCE ROW LEVEL SECURITY;
CREATE POLICY recording_actor ON intel_hearing_recording FOR ALL
  USING (hearing_recording_session_access(tenant_id,session_id) OR current_setting('app.bypass_rls',true)='on')
  WITH CHECK (hearing_recording_session_access(tenant_id,session_id) OR current_setting('app.bypass_rls',true)='on');

ALTER TABLE intel_hearing_recording_epoch ENABLE ROW LEVEL SECURITY;
ALTER TABLE intel_hearing_recording_epoch FORCE ROW LEVEL SECURITY;
CREATE POLICY recording_epoch_actor ON intel_hearing_recording_epoch FOR ALL
  USING (EXISTS(SELECT 1 FROM intel_hearing_recording r WHERE r.tenant_id=intel_hearing_recording_epoch.tenant_id AND r.id=recording_id))
  WITH CHECK (EXISTS(SELECT 1 FROM intel_hearing_recording r WHERE r.tenant_id=intel_hearing_recording_epoch.tenant_id AND r.id=recording_id));

ALTER TABLE intel_hearing_recording_part ENABLE ROW LEVEL SECURITY;
ALTER TABLE intel_hearing_recording_part FORCE ROW LEVEL SECURITY;
CREATE POLICY recording_part_actor ON intel_hearing_recording_part FOR ALL
  USING (EXISTS(SELECT 1 FROM intel_hearing_recording_epoch e WHERE e.tenant_id=intel_hearing_recording_part.tenant_id AND e.id=epoch_id))
  WITH CHECK (EXISTS(SELECT 1 FROM intel_hearing_recording_epoch e WHERE e.tenant_id=intel_hearing_recording_part.tenant_id AND e.id=epoch_id));

CREATE FUNCTION hearing_recording_retention_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM intel_live_hearing_session s
    WHERE s.tenant_id=NEW.tenant_id AND s.id=NEW.session_id AND s.recording_policy='audio_and_transcript') THEN
    RAISE EXCEPTION 'session does not permit retained audio';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER hearing_recording_retention_guard BEFORE INSERT ON intel_hearing_recording
  FOR EACH ROW EXECUTE FUNCTION hearing_recording_retention_guard();

DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='capiro_app') THEN
    GRANT SELECT ON intel_hearing_media_permission TO capiro_app;
    GRANT SELECT,INSERT,UPDATE,DELETE ON intel_hearing_recording,intel_hearing_recording_epoch,intel_hearing_recording_part TO capiro_app;
  END IF;
END $$;
