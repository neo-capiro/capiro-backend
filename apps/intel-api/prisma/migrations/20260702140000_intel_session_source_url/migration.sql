-- Optional direct media URL for a live hearing session, so the room can
-- pre-fill + auto-start ingestion instead of a manual paste. Additive, nullable
-- (no backfill, no default) — zero impact on existing rows.
ALTER TABLE "intel_live_hearing_session" ADD COLUMN "source_url" TEXT;
