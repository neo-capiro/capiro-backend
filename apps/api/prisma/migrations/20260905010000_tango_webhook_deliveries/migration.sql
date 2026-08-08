-- Funding Opportunities P46 — verified Tango webhook receiver.
--
-- WHAT THIS IS
-- -------------------------------------------------------------------
-- One provider-owned ledger of webhook DELIVERIES. A row means exactly this:
-- "at this time, bytes carrying this delivery id arrived, their HMAC matched
-- the shared secret, and here is what they said." Nothing more.
--
-- WHAT IT IS NOT
-- -------------------------------------------------------------------
-- This table holds NO product decision and no conclusion, and nothing may
-- derive one from it inside the request that writes it.
--
--   * A DELIVERY IS NOT AN EVENT ABOUT THE WORLD. That the provider says a
--     notice changed is a claim by the provider, not a Capiro fact. The
--     reconciler (P47) decides what, if anything, it means — and it runs
--     dry-run first, out of band, never in this request.
--   * A DELIVERY IS NOT AN ALERT. §4.6 of the plan is explicit that webhooks
--     "cannot trigger client alerts directly from unverified payloads"; this
--     phase goes further and triggers nothing at all, verified or not.
--   * `status` IS DELIVERY LIFECYCLE, NOT OUTCOME. 'received' means recorded
--     and not yet drained. It does not mean accepted, believed, or acted on.
--
-- WHY THE PAYLOAD IS STORED
-- -------------------------------------------------------------------
-- P47 reconciles from the delivery, and a reconciler that must re-request the
-- provider to learn what it was already told is neither dry-runnable nor
-- replayable. The bytes are stored only AFTER the signature verifies, so the
-- JSON here has always been authenticated — matching §4.6's "webhook raw bytes
-- are verified before JSON trust". An unverified payload never reaches this
-- table, which is why there is no `signature_valid` column: an invalid
-- signature produces a 401 and NO ROW, so such a column could only ever hold
-- `true` and would imply a rejected-delivery audit trail that does not exist.
--
-- IDEMPOTENCY IS THE UNIQUE INDEX, NOT APPLICATION LOGIC
-- -------------------------------------------------------------------
-- `delivery_id_uniq` is the whole replay defence. A provider retry (the normal
-- case — every at-least-once webhook sender retries on timeout) hits the unique
-- violation, and the receiver answers 200 without a second enqueue. This is
-- deliberately the database's job: two concurrent retries of the same delivery
-- race, and only a unique index resolves that correctly.
--
-- `payload_sha256` is a SEPARATE fact from the delivery id and is not unique.
-- The same content legitimately arrives under different delivery ids (the
-- provider re-emitting after its own retry window), and two different contents
-- must never collide onto one id. Storing both lets P47 tell "the provider
-- said the same thing twice" apart from "the provider said something new".
--
-- NO TENANT COLUMN, NO RLS
-- -------------------------------------------------------------------
-- A webhook arrives with no session and no tenant, and this receiver is
-- mounted outside TenantContext middleware. Inventing a tenant here would be a
-- guess written into a durable record. Fan-out to tenants is P48's problem and
-- happens only after the reconciler has resolved a delivery to real local rows.
-- This is a global provider table exactly like `tango_api_usage`, and P15's
-- acceptance rule applies: no tenant RLS is falsely claimed on it.
--
-- RETRY-SAFE. Every statement is IF NOT EXISTS or guarded on pg_constraint.

CREATE TABLE IF NOT EXISTS "tango_webhook_delivery" (
  "id"                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  -- The provider's own delivery identifier, echoed from the delivery header.
  -- This is the idempotency key and the reason a retry is free.
  "delivery_id"        TEXT NOT NULL,

  -- Provider vocabulary, stored as stated. Deliberately NOT mapped into a
  -- Capiro enum here: an unknown event type must be recordable, not rejected —
  -- refusing to store an event we do not yet understand would lose exactly the
  -- evidence needed to add support for it.
  "event_type"         TEXT NOT NULL,
  -- The provider's id for the underlying event, when the payload carries one.
  -- Distinct from `delivery_id`: one event may be delivered more than once.
  "event_id"           TEXT,

  -- SHA-256 over the exact verified bytes, lowercase hex.
  "payload_sha256"     TEXT NOT NULL,
  "payload_bytes"      INTEGER NOT NULL,
  -- Verified bytes, parsed. See "why the payload is stored" above.
  "payload"            JSONB NOT NULL,

  -- Delivery lifecycle only: 'received' (recorded, not yet drained),
  -- 'processed' (P47 drained it), 'ignored' (P47 decided it needs no action),
  -- 'failed' (P47 could not drain it). P46 only ever writes 'received'.
  "status"             TEXT NOT NULL DEFAULT 'received',

  -- The provider's own timestamp for the event, when supplied. Used for the
  -- replay window. NULL means the payload carried none — which is NOT treated
  -- as stale, because a missing timestamp is missing evidence, not old evidence.
  "provider_event_at"  TIMESTAMPTZ(6),

  "received_at"        TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "processed_at"       TIMESTAMPTZ(6),
  -- Sanitized reason a drain failed. Never carries a secret or a raw payload.
  "process_error"      TEXT,

  "created_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

-- A delivery with no provider delivery id has no identity, and every retry of
-- it would create another row — the exact duplicate-alert failure P48 must not
-- inherit.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tango_webhook_delivery_delivery_id_chk') THEN
    ALTER TABLE "tango_webhook_delivery"
      ADD CONSTRAINT "tango_webhook_delivery_delivery_id_chk"
      CHECK (btrim("delivery_id") <> '');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tango_webhook_delivery_event_type_chk') THEN
    ALTER TABLE "tango_webhook_delivery"
      ADD CONSTRAINT "tango_webhook_delivery_event_type_chk"
      CHECK (btrim("event_type") <> '');
  END IF;
END $$;

-- Closed lifecycle vocabulary. Widened, never narrowed, per this program's rule.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tango_webhook_delivery_status_chk') THEN
    ALTER TABLE "tango_webhook_delivery"
      ADD CONSTRAINT "tango_webhook_delivery_status_chk"
      CHECK ("status" IN ('received', 'processed', 'ignored', 'failed'));
  END IF;
END $$;

-- A drained delivery must say when it was drained, and an undrained one must
-- not claim a drain time. Without this, a partially-written drain looks
-- complete.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tango_webhook_delivery_processed_chk') THEN
    ALTER TABLE "tango_webhook_delivery"
      ADD CONSTRAINT "tango_webhook_delivery_processed_chk"
      CHECK (
        ("status" = 'received' AND "processed_at" IS NULL)
        OR ("status" <> 'received' AND "processed_at" IS NOT NULL)
      );
  END IF;
END $$;

-- Lowercase hex SHA-256, exactly 64 characters. A truncated or upper-cased hash
-- would silently never match on comparison.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tango_webhook_delivery_sha256_chk') THEN
    ALTER TABLE "tango_webhook_delivery"
      ADD CONSTRAINT "tango_webhook_delivery_sha256_chk"
      CHECK ("payload_sha256" ~ '^[0-9a-f]{64}$');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tango_webhook_delivery_bytes_chk') THEN
    ALTER TABLE "tango_webhook_delivery"
      ADD CONSTRAINT "tango_webhook_delivery_bytes_chk"
      CHECK ("payload_bytes" >= 0);
  END IF;
END $$;

-- THE idempotency guarantee. See the header.
CREATE UNIQUE INDEX IF NOT EXISTS "tango_webhook_delivery_delivery_id_uniq"
  ON "tango_webhook_delivery" ("delivery_id");

-- P47's drain query: oldest undrained delivery first.
CREATE INDEX IF NOT EXISTS "tango_webhook_delivery_status_idx"
  ON "tango_webhook_delivery" ("status", "received_at");

-- "What has this event type been telling us lately", for P48 materiality and
-- for the operator diagnostics that decide whether a schedule can be relaxed.
CREATE INDEX IF NOT EXISTS "tango_webhook_delivery_event_idx"
  ON "tango_webhook_delivery" ("event_type", "received_at");

-- Same-content detection across differing delivery ids. Non-unique by design.
CREATE INDEX IF NOT EXISTS "tango_webhook_delivery_payload_sha_idx"
  ON "tango_webhook_delivery" ("payload_sha256");

COMMENT ON TABLE "tango_webhook_delivery" IS
  'P46. Verified Tango webhook deliveries. A row is evidence that authenticated bytes arrived, not that anything is true about the world. Global provider table: no tenant column and no RLS, by design — a webhook carries no tenant. Rows are written only after HMAC verification; an invalid signature yields a 401 and no row.';
