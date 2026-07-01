-- CreateEnum
CREATE TYPE "intel_live_hearing_source_type" AS ENUM ('hearing', 'markup', 'meeting', 'webinar', 'agency_session');

-- CreateEnum
CREATE TYPE "intel_live_hearing_audio_source" AS ENUM ('browser_mic', 'uploaded_audio', 'stream_url', 'conference_bridge');

-- CreateEnum
CREATE TYPE "intel_live_hearing_status" AS ENUM ('scheduled', 'live', 'paused', 'ended', 'failed');

-- CreateEnum
CREATE TYPE "intel_consent_status" AS ENUM ('not_required', 'confirmed', 'needs_review');

-- CreateEnum
CREATE TYPE "intel_recording_policy" AS ENUM ('transcript_only', 'audio_and_transcript', 'no_storage');

-- CreateTable
CREATE TABLE "intel_feature_flag" (
    "id" TEXT NOT NULL,
    "feature" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "intel_feature_flag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "intel_live_hearing_session" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "client_id" TEXT,
    "matter_id" TEXT,
    "issue_ids" TEXT[],
    "hearing_id" TEXT,
    "committee_id" TEXT,
    "bill_ids" TEXT[],
    "program_element_ids" TEXT[],
    "agency_ids" TEXT[],
    "title" TEXT NOT NULL,
    "source_type" "intel_live_hearing_source_type" NOT NULL,
    "audio_source" "intel_live_hearing_audio_source" NOT NULL,
    "status" "intel_live_hearing_status" NOT NULL DEFAULT 'scheduled',
    "started_at" TIMESTAMP(3),
    "ended_at" TIMESTAMP(3),
    "consent_status" "intel_consent_status" NOT NULL DEFAULT 'needs_review',
    "recording_policy" "intel_recording_policy" NOT NULL DEFAULT 'transcript_only',
    "claim_map_id" TEXT,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "intel_live_hearing_session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "intel_transcript_segment" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "start_ms" INTEGER NOT NULL,
    "end_ms" INTEGER NOT NULL,
    "speaker_label" TEXT,
    "resolved_speaker_id" TEXT,
    "resolved_speaker_name" TEXT,
    "is_final" BOOLEAN NOT NULL DEFAULT false,
    "confidence" DOUBLE PRECISION,
    "source" TEXT NOT NULL DEFAULT 'deepgram',
    "text_ciphertext" TEXT,
    "iv" TEXT,
    "auth_tag" TEXT,
    "key_version" TEXT,
    "text_plain" TEXT,
    "client_relevance_score" DOUBLE PRECISION,
    "issue_tags" TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "intel_transcript_segment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "intel_key_quote" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "segment_id" TEXT NOT NULL,
    "start_ms" INTEGER NOT NULL,
    "speaker_name" TEXT,
    "confidence" DOUBLE PRECISION,
    "issue_tags" TEXT[],
    "text_ciphertext" TEXT,
    "iv" TEXT,
    "auth_tag" TEXT,
    "key_version" TEXT,
    "text_plain" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "intel_key_quote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "intel_live_action_item" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "segment_id" TEXT,
    "start_ms" INTEGER,
    "description" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "intel_live_action_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "intel_entity_mention" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "segment_id" TEXT,
    "entity_type" TEXT NOT NULL,
    "entity_ref" TEXT,
    "entity_label" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "intel_entity_mention_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "intel_live_summary_card" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "card_type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "segment_id" TEXT,
    "start_ms" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "intel_live_summary_card_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "intel_feature_flag_feature_enabled_idx" ON "intel_feature_flag"("feature", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "intel_feature_flag_feature_tenant_id_key" ON "intel_feature_flag"("feature", "tenant_id");

-- CreateIndex
CREATE INDEX "intel_live_hearing_session_tenant_id_status_idx" ON "intel_live_hearing_session"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "intel_live_hearing_session_tenant_id_client_id_idx" ON "intel_live_hearing_session"("tenant_id", "client_id");

-- CreateIndex
CREATE INDEX "intel_transcript_segment_session_id_start_ms_idx" ON "intel_transcript_segment"("session_id", "start_ms");

-- CreateIndex
CREATE INDEX "intel_transcript_segment_tenant_id_session_id_idx" ON "intel_transcript_segment"("tenant_id", "session_id");

-- CreateIndex
CREATE UNIQUE INDEX "intel_transcript_segment_session_id_start_ms_end_ms_key" ON "intel_transcript_segment"("session_id", "start_ms", "end_ms");

-- CreateIndex
CREATE INDEX "intel_key_quote_tenant_id_session_id_idx" ON "intel_key_quote"("tenant_id", "session_id");

-- CreateIndex
CREATE INDEX "intel_live_action_item_tenant_id_session_id_idx" ON "intel_live_action_item"("tenant_id", "session_id");

-- CreateIndex
CREATE INDEX "intel_entity_mention_tenant_id_session_id_idx" ON "intel_entity_mention"("tenant_id", "session_id");

-- CreateIndex
CREATE INDEX "intel_entity_mention_entity_type_entity_ref_idx" ON "intel_entity_mention"("entity_type", "entity_ref");

-- CreateIndex
CREATE INDEX "intel_live_summary_card_tenant_id_session_id_idx" ON "intel_live_summary_card"("tenant_id", "session_id");

-- AddForeignKey
ALTER TABLE "intel_transcript_segment" ADD CONSTRAINT "intel_transcript_segment_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "intel_live_hearing_session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "intel_key_quote" ADD CONSTRAINT "intel_key_quote_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "intel_live_hearing_session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "intel_key_quote" ADD CONSTRAINT "intel_key_quote_segment_id_fkey" FOREIGN KEY ("segment_id") REFERENCES "intel_transcript_segment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "intel_live_action_item" ADD CONSTRAINT "intel_live_action_item_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "intel_live_hearing_session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "intel_entity_mention" ADD CONSTRAINT "intel_entity_mention_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "intel_live_hearing_session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "intel_live_summary_card" ADD CONSTRAINT "intel_live_summary_card_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "intel_live_hearing_session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

