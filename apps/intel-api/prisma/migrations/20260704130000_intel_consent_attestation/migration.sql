-- Persist the consent attestation as a durable compliance artifact (P8/D11).
-- Before this, the attestation for a PRIVATE session (meeting/webinar/agency
-- session) was only logged truncated to 80 chars — no queryable audit record.
-- Now the FULL text + attesting user + timestamp are stored on the session.
-- Additive, nullable (no backfill, no default) — public proceedings stay NULL,
-- zero impact on existing rows.
ALTER TABLE "intel_live_hearing_session" ADD COLUMN "consent_attestation" TEXT;
ALTER TABLE "intel_live_hearing_session" ADD COLUMN "attested_by" TEXT;
ALTER TABLE "intel_live_hearing_session" ADD COLUMN "attested_at" TIMESTAMP(3);
