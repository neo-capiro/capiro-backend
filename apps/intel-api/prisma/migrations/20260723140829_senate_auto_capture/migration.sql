-- Automatic Senate hearing capture: GLOBAL, tenant-less, RLS-FREE tables for
-- PUBLIC Senate committee-hearing transcripts (17 U.S.C. §105 public domain).
-- Deliberately NO tenant_id and NO RLS (unlike the intel_live_hearing_* /
-- intel_transcript_segment tables, which are ENABLE + FORCE ROW LEVEL SECURITY).
-- Readable by any hearing_watch tenant; nothing client-relevant is stored here.

-- CreateTable
CREATE TABLE "intel_senate_hearing_capture" (
    "id" TEXT NOT NULL,
    "hearing_key" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'senate_isvp',
    "committee_hearing_id" TEXT,
    "comm" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "committee_code" TEXT,
    "committee_name" TEXT,
    "title" TEXT,
    "hearing_type" TEXT,
    "media_url" TEXT,
    "status" TEXT NOT NULL DEFAULT 'discovered',
    "scheduled_at" TIMESTAMP(3),
    "started_at" TIMESTAMP(3),
    "ended_at" TIMESTAMP(3),
    "task_arn" TEXT,
    "heartbeat_at" TIMESTAMP(3),
    "poll_count" INTEGER NOT NULL DEFAULT 0,
    "last_probe_status" INTEGER,
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "intel_senate_hearing_capture_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "intel_senate_hearing_capture_hearing_key_key" ON "intel_senate_hearing_capture"("hearing_key");

-- CreateIndex
CREATE INDEX "intel_senate_hearing_capture_status_idx" ON "intel_senate_hearing_capture"("status");

-- CreateIndex
CREATE INDEX "intel_senate_hearing_capture_scheduled_at_idx" ON "intel_senate_hearing_capture"("scheduled_at");

-- CreateTable
CREATE TABLE "intel_senate_transcript_segment" (
    "id" TEXT NOT NULL,
    "capture_id" TEXT NOT NULL,
    "start_ms" INTEGER NOT NULL,
    "end_ms" INTEGER NOT NULL,
    "speaker_label" TEXT,
    "resolved_speaker_name" TEXT,
    "is_final" BOOLEAN NOT NULL DEFAULT true,
    "confidence" DOUBLE PRECISION,
    "source" TEXT NOT NULL DEFAULT 'deepgram',
    "text_plain" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "intel_senate_transcript_segment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "intel_senate_transcript_segment_capture_id_start_ms_end_ms_key" ON "intel_senate_transcript_segment"("capture_id", "start_ms", "end_ms");

-- CreateIndex
CREATE INDEX "intel_senate_transcript_segment_capture_id_start_ms_idx" ON "intel_senate_transcript_segment"("capture_id", "start_ms");

-- AddForeignKey
ALTER TABLE "intel_senate_transcript_segment" ADD CONSTRAINT "intel_senate_transcript_segment_capture_id_fkey" FOREIGN KEY ("capture_id") REFERENCES "intel_senate_hearing_capture"("id") ON DELETE CASCADE ON UPDATE CASCADE;
