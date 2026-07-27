-- Remediation plan §3.c5/c6 — bind a send-intent's requestKey to the actual
-- request payload that minted it. Today the dedupe lookup is
-- (tenant, user, requestKey) only: a client that reused an old idempotency
-- key with a DIFFERENT payload (different versions, mailbox, attachments,
-- signature choice, or test mode) would silently get back the OLD intent
-- instead of the new request being honored or rejected.
--
-- ADDITIVE with a safe backfill for the NOT NULL requirement: add nullable,
-- backfill every existing row, then tighten to NOT NULL. A retry of this
-- script is a no-op — IF NOT EXISTS on the column add, the UPDATE only
-- touches rows still NULL, and re-applying SET NOT NULL when it is already
-- NOT NULL is a harmless no-op in Postgres.
--
-- Backfill value: 'legacy:' || id. Every REAL fingerprint this codebase ever
-- computes is 'sha256:' + 64 hex chars (see sendIntentRequestFingerprint in
-- outreach-send-intent.service.ts), so a legacy placeholder can never be
-- mistaken for matching a freshly computed one — a client that reuses a
-- pre-migration intent's requestKey correctly gets OUTREACH_REQUEST_KEY_REUSED
-- rather than a false dedupe.

ALTER TABLE "outreach_send_intents"
  ADD COLUMN IF NOT EXISTS "request_fingerprint" VARCHAR(160);

UPDATE "outreach_send_intents"
  SET "request_fingerprint" = 'legacy:' || id::text
  WHERE "request_fingerprint" IS NULL;

ALTER TABLE "outreach_send_intents"
  ALTER COLUMN "request_fingerprint" SET NOT NULL;
