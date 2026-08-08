-- Funding Opportunities P48 — event fan-out, materiality, and quiet alerts.
--
-- TWO TABLES, AND THE SPLIT IS THE WHOLE DESIGN
-- -------------------------------------------------------------------
-- `tango_event_outbox` is GLOBAL work. `tango_event_alert` is TENANT truth.
-- A verified delivery (P46) says something changed in the federal marketplace
-- — a fact about the world, carrying no tenant. Whether that matters to a
-- particular client is a separate judgement, made against that client's own
-- profile, workflow state, and ethical walls. Putting both in one table would
-- force a tenant column onto a row that has no tenant, and the first thing
-- anyone would do is invent one.
--
-- ── tango_event_outbox: the queue ───────────────────────────────────────────
--
-- WHY A SECOND TABLE AND NOT JUST DRAINING `tango_webhook_delivery`:
-- a delivery is an inbound RECORD and must stay immutable evidence of what
-- arrived. Work state — attempts, leases, quarantine — is mutable and would
-- otherwise scribble on that record. Keeping them apart means a poisoned
-- event's retry history never edits the proof of what the provider sent.
--
-- LEASED, NOT LOCKED. `lease_until` plus `FOR UPDATE SKIP LOCKED` at read time
-- lets several processors run without one blocking another, and a crashed
-- processor's row becomes eligible again when its lease expires rather than
-- being stuck forever. This mirrors `defense_budget_promotion_outbox`'s drain,
-- which solved the same problem in this repo already.
--
-- QUARANTINE IS TERMINAL AND VISIBLE. P48's acceptance requires a poison event
-- to be quarantined "and not block queue". A row at the attempt ceiling moves
-- to `quarantined` and is skipped by the claim query forever after — it does
-- not retry, and it does not silently vanish. An operator sees it.
--
-- ── tango_event_alert: quiet by construction ────────────────────────────────
--
-- The dedupe key is (tenant, client, source record, change fingerprint) and it
-- is a UNIQUE INDEX, not application logic. Replay and out-of-order delivery
-- are NORMAL for an at-least-once webhook sender, and P48's acceptance demands
-- they "produce one result". Only the database can guarantee that under
-- concurrency, so only the database is trusted with it.
--
-- The fingerprint is computed from the CHANGE, not from the delivery: the same
-- deadline slip re-delivered under a new delivery id must not produce a second
-- alert. That is precisely why P46 stores `payload_sha256` separately from
-- `delivery_id` — the two facts are different, and this table depends on it.
--
-- NO ALERT IS CREATED BY A MODEL. `evidence_jsonb` holds the classifier's own
-- before/after values (P28's `MaterialChange`), and a summary written by an LLM
-- may be attached downstream but can never bring a row into existence. The
-- plan is explicit: "model summaries are optional downstream; they cannot
-- create the alert."
--
-- RETRY-SAFE. Every statement is IF NOT EXISTS or guarded on pg_constraint.

-- ── The work queue (GLOBAL — no tenant, no RLS, by design) ───────────────────

CREATE TABLE IF NOT EXISTS "tango_event_outbox" (
  "id"                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  -- The verified delivery this work came from. No FK, same reasoning as P45's
  -- ledgers and P46's: the record that work was queued must outlive whatever
  -- it once pointed at.
  "delivery_id"       TEXT NOT NULL,
  "event_type"        TEXT NOT NULL,

  -- Which provider resource to refresh. `external_id` may be null when the
  -- payload named an event but no addressable resource — such a row is
  -- recorded and then completed as a no-op rather than retried forever.
  "resource_type"     TEXT NOT NULL,
  "external_id"       TEXT,

  -- pending -> processing -> done | quarantined
  "status"            TEXT NOT NULL DEFAULT 'pending',
  "attempts"          INTEGER NOT NULL DEFAULT 0,
  -- Sanitized. Never a payload body, never a secret.
  "last_error"        TEXT,
  "lease_until"       TIMESTAMPTZ(6),
  "last_attempted_at" TIMESTAMPTZ(6),

  "created_at"        TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at"        TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "completed_at"      TIMESTAMPTZ(6)
);

-- ONE QUEUE ROW PER DELIVERY. A delivery re-enqueued would be processed twice,
-- and every downstream dedupe would then be doing work the queue should have
-- prevented.
CREATE UNIQUE INDEX IF NOT EXISTS "tango_event_outbox_delivery_uniq"
  ON "tango_event_outbox" ("delivery_id");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tango_event_outbox_status_chk') THEN
    ALTER TABLE "tango_event_outbox"
      ADD CONSTRAINT "tango_event_outbox_status_chk"
      CHECK ("status" IN ('pending', 'processing', 'done', 'quarantined'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tango_event_outbox_attempts_chk') THEN
    ALTER TABLE "tango_event_outbox"
      ADD CONSTRAINT "tango_event_outbox_attempts_chk"
      CHECK ("attempts" >= 0);
  END IF;
END $$;

-- A finished row must say when it finished, and an unfinished one must not
-- claim a completion time.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tango_event_outbox_completed_chk') THEN
    ALTER TABLE "tango_event_outbox"
      ADD CONSTRAINT "tango_event_outbox_completed_chk"
      CHECK (
        ("status" IN ('done', 'quarantined') AND "completed_at" IS NOT NULL)
        OR ("status" IN ('pending', 'processing') AND "completed_at" IS NULL)
      );
  END IF;
END $$;

-- THE CLAIM QUERY's index: oldest pending first, quarantined never selected.
CREATE INDEX IF NOT EXISTS "tango_event_outbox_claim_idx"
  ON "tango_event_outbox" ("status", "lease_until", "created_at");

COMMENT ON TABLE "tango_event_outbox" IS
  'P48. Fan-out work derived from verified webhook deliveries. GLOBAL: a marketplace change carries no tenant. Separate from tango_webhook_delivery so mutable retry state never scribbles on immutable inbound evidence. Quarantine is terminal and visible; it never blocks the queue.';

-- ── The alert (TENANT-scoped, RLS ENABLED and FORCED) ────────────────────────

CREATE TABLE IF NOT EXISTS "tango_event_alert" (
  "id"                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  "tenant_id"           UUID NOT NULL,
  "client_id"           UUID NOT NULL,

  -- Generic source identity (P13), so forecasts and future sources reuse this
  -- without a second alert table.
  "source_type"         TEXT NOT NULL,
  "source_record_key"   TEXT NOT NULL,

  -- P28 vocabulary, reused rather than re-derived. `severity` is the
  -- classifier's own band; this phase applies policy to it, it does not invent
  -- a second scale.
  "change_dimension"    TEXT NOT NULL,
  "severity"            TEXT NOT NULL,

  -- THE DEDUPE KEY. Computed from the CHANGE and the notice that carried it
  -- (dimension + after + notice id), never from the delivery — so the same
  -- change re-delivered under a new delivery id collapses onto one alert, while
  -- two transitions that merely END at the same value stay distinct.
  -- See changeFingerprint() for why `before` is deliberately excluded.
  "change_fingerprint"  TEXT NOT NULL,

  -- The classifier's own before/after and one-sentence summary, plus source
  -- freshness. Never model-authored, and an LLM summary attached later cannot
  -- have created this row.
  "evidence_jsonb"      JSONB NOT NULL,
  "before_value"        TEXT,
  "after_value"         TEXT,

  -- What the row looked like when the alert fired, so a reader can tell why
  -- they were told. A later stage change never rewrites history here.
  "pipeline_stage_at_alert" TEXT,

  -- When Capiro last saw the source. An alert whose evidence is stale must say
  -- so rather than reading as current.
  "source_observed_at"  TIMESTAMPTZ(6),

  "delivery_id"         TEXT,
  "created_at"          TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

-- REPLAY AND OUT-OF-ORDER PRODUCE ONE RESULT. Enforced here, not in code:
-- two processors racing the same change both reach the INSERT, and only a
-- unique index resolves that correctly.
CREATE UNIQUE INDEX IF NOT EXISTS "tango_event_alert_dedupe_uniq"
  ON "tango_event_alert" ("tenant_id", "client_id", "source_record_key", "change_fingerprint");

CREATE INDEX IF NOT EXISTS "tango_event_alert_tenant_created_idx"
  ON "tango_event_alert" ("tenant_id", "created_at");
CREATE INDEX IF NOT EXISTS "tango_event_alert_client_idx"
  ON "tango_event_alert" ("tenant_id", "client_id", "created_at");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tango_event_alert_severity_chk') THEN
    ALTER TABLE "tango_event_alert"
      ADD CONSTRAINT "tango_event_alert_severity_chk"
      CHECK ("severity" IN ('critical', 'significant', 'informational'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tango_event_alert_fingerprint_chk') THEN
    ALTER TABLE "tango_event_alert"
      ADD CONSTRAINT "tango_event_alert_fingerprint_chk"
      CHECK ("change_fingerprint" ~ '^[0-9a-f]{64}$');
  END IF;
END $$;

-- A row that reached an alert must record the stage it was in, or nobody can
-- audit whether the quiet-alert policy was actually applied.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tango_event_alert_stage_chk') THEN
    ALTER TABLE "tango_event_alert"
      ADD CONSTRAINT "tango_event_alert_stage_chk"
      CHECK (
        "pipeline_stage_at_alert" IS NULL
        OR "pipeline_stage_at_alert" IN (
          'reviewing', 'qualified', 'pursuing', 'submitted', 'won', 'lost', 'passed'
        )
      );
  END IF;
END $$;

ALTER TABLE "tango_event_alert" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tango_event_alert" FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'tango_event_alert' AND policyname = 'tango_event_alert_select'
  ) THEN
    CREATE POLICY "tango_event_alert_select" ON "tango_event_alert"
        FOR SELECT USING (rls_bypass() OR tenant_id = current_tenant_id());
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'tango_event_alert' AND policyname = 'tango_event_alert_insert'
  ) THEN
    CREATE POLICY "tango_event_alert_insert" ON "tango_event_alert"
        FOR INSERT WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'tango_event_alert' AND policyname = 'tango_event_alert_update'
  ) THEN
    CREATE POLICY "tango_event_alert_update" ON "tango_event_alert"
        FOR UPDATE USING (rls_bypass() OR tenant_id = current_tenant_id())
        WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'tango_event_alert' AND policyname = 'tango_event_alert_delete'
  ) THEN
    CREATE POLICY "tango_event_alert_delete" ON "tango_event_alert"
        FOR DELETE USING (rls_bypass() OR tenant_id = current_tenant_id());
  END IF;
END $$;

COMMENT ON TABLE "tango_event_alert" IS
  'P48. One material change, for one client, told once. Deduped by a UNIQUE index on (tenant, client, source record, change fingerprint) because replay and out-of-order delivery are normal for an at-least-once sender and only the database can collapse them under concurrency. The fingerprint is computed from the CHANGE, never the delivery. No model can create a row here.';
