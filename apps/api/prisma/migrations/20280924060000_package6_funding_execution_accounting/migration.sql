-- Package 6: immutable source events, certified publication snapshots, and
-- explicit scoped reconciliation residuals for federal funding execution.

ALTER TABLE "federal_funding_allocation"
  ADD COLUMN "source_event_id" UUID,
  ADD COLUMN "amount_basis" TEXT NOT NULL DEFAULT 'legacy_unspecified',
  ADD COLUMN "as_of_date" DATE,
  ADD COLUMN "period_start" DATE,
  ADD COLUMN "period_end" DATE,
  ADD COLUMN "execution_metric" TEXT,
  ADD COLUMN "correction_of_allocation_id" UUID,
  ADD COLUMN "transfer_pair_key" TEXT,
  ADD COLUMN "transfer_side" TEXT,
  ADD CONSTRAINT "federal_funding_allocation_correction_fk"
    FOREIGN KEY ("correction_of_allocation_id") REFERENCES "federal_funding_allocation"("id")
    ON UPDATE CASCADE ON DELETE RESTRICT,
  ADD CONSTRAINT "federal_funding_allocation_basis_chk"
    CHECK ("amount_basis" IN ('legacy_unspecified','snapshot','period_delta','transaction_delta')),
  ADD CONSTRAINT "federal_funding_allocation_basis_time_chk"
    CHECK (
      ("source_event_id" IS NULL AND "amount_basis" = 'legacy_unspecified' AND "as_of_date" IS NULL AND "period_start" IS NULL AND "period_end" IS NULL)
      OR ("source_event_id" IS NOT NULL AND "amount_basis" = 'snapshot' AND "as_of_date" IS NOT NULL AND "period_start" IS NULL AND "period_end" IS NULL)
      OR ("source_event_id" IS NOT NULL AND "amount_basis" = 'period_delta' AND "period_start" IS NOT NULL AND "period_end" IS NOT NULL AND "period_end" >= "period_start")
      OR ("source_event_id" IS NOT NULL AND "amount_basis" = 'transaction_delta' AND "as_of_date" IS NOT NULL AND "period_start" IS NULL AND "period_end" IS NULL)
    ),
  ADD CONSTRAINT "federal_funding_allocation_execution_metric_chk"
    CHECK ("source_event_id" IS NULL OR "execution_metric" IS NULL OR "execution_metric" IN ('obligations','outlays')),
  ADD CONSTRAINT "federal_funding_allocation_execution_asof_chk"
    CHECK ("source_event_id" IS NULL OR "execution_metric" IS NULL OR "as_of_date" IS NOT NULL),
  ADD CONSTRAINT "federal_funding_allocation_negative_delta_chk"
    CHECK ("source_event_id" IS NULL OR "authoritative_amount_usd" IS NULL OR "authoritative_amount_usd" >= 0 OR "amount_basis" IN ('period_delta','transaction_delta')),
  ADD CONSTRAINT "federal_funding_allocation_transfer_pair_chk"
    CHECK ("source_event_id" IS NULL OR (("transfer_pair_key" IS NULL AND "transfer_side" IS NULL) OR ("transfer_pair_key" IS NOT NULL AND "transfer_side" IN ('out','in') AND "amount_basis" = 'transaction_delta')));

-- Transaction-start timestamps can fall behind a previously completed worker
-- watermark when a long transaction commits late. Wall-clock insert timestamps,
-- paired with the worker's SHARE-lock watermark capture, close that gap.
ALTER TABLE "federal_funding_allocation"
  ALTER COLUMN "created_at" SET DEFAULT clock_timestamp();

CREATE INDEX "federal_funding_allocation_source_event_idx" ON "federal_funding_allocation"("source_event_id");
CREATE INDEX "federal_funding_allocation_correction_idx" ON "federal_funding_allocation"("correction_of_allocation_id");
CREATE INDEX "federal_funding_allocation_execution_time_idx" ON "federal_funding_allocation"("execution_metric","as_of_date");

CREATE TABLE "federal_funding_source_event" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "source_event_key" TEXT NOT NULL,
  "source_system" TEXT NOT NULL,
  "source_record_id" TEXT NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "event_type" TEXT NOT NULL,
  "measure_id" UUID,
  "source_document_id" UUID NOT NULL,
  "occurred_at" TIMESTAMPTZ(6),
  "source_observed_at" TIMESTAMPTZ(6),
  "source_url" TEXT,
  "source_version" TEXT,
  "amount_basis" TEXT,
  "execution_metric" TEXT,
  "as_of_date" DATE,
  "period_start" DATE,
  "period_end" DATE,
  "source_amount_usd" NUMERIC(20,2),
  "signed_obligation_delta" NUMERIC(20,2),
  "signed_outlay_delta" NUMERIC(20,2),
  "correction_of_event_id" UUID,
  "transfer_pair_key" TEXT,
  "transfer_side" TEXT,
  "content_sha256" CHAR(64) NOT NULL,
  "raw_jsonb" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "federal_funding_source_event_measure_fk" FOREIGN KEY ("measure_id") REFERENCES "federal_funding_measure"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT "federal_funding_source_event_document_fk" FOREIGN KEY ("source_document_id") REFERENCES "source_document"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT "federal_funding_source_event_correction_fk" FOREIGN KEY ("correction_of_event_id") REFERENCES "federal_funding_source_event"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT "federal_funding_source_event_revision_chk" CHECK ("revision" >= 1),
  CONSTRAINT "federal_funding_source_event_sha_chk" CHECK ("content_sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "federal_funding_source_event_basis_chk" CHECK ("amount_basis" IS NULL OR "amount_basis" IN ('snapshot','period_delta','transaction_delta')),
  CONSTRAINT "federal_funding_source_event_execution_chk" CHECK ("execution_metric" IS NULL OR "execution_metric" IN ('obligations','outlays')),
  CONSTRAINT "federal_funding_source_event_amount_chk" CHECK (
    "amount_basis" IS NULL OR
    ("amount_basis" = 'snapshot' AND "source_amount_usd" IS NOT NULL AND "signed_obligation_delta" IS NULL AND "signed_outlay_delta" IS NULL) OR
    ("amount_basis" IN ('period_delta','transaction_delta') AND (
      ("execution_metric" IS NULL AND "source_amount_usd" IS NOT NULL AND "signed_obligation_delta" IS NULL AND "signed_outlay_delta" IS NULL) OR
      ("execution_metric" = 'obligations' AND "source_amount_usd" IS NULL AND "signed_obligation_delta" IS NOT NULL AND "signed_outlay_delta" IS NULL) OR
      ("execution_metric" = 'outlays' AND "source_amount_usd" IS NULL AND "signed_outlay_delta" IS NOT NULL AND "signed_obligation_delta" IS NULL)))
  ),
  CONSTRAINT "federal_funding_source_event_basis_time_chk" CHECK (
    "amount_basis" IS NULL OR
    ("amount_basis" = 'snapshot' AND "as_of_date" IS NOT NULL AND "period_start" IS NULL AND "period_end" IS NULL) OR
    ("amount_basis" = 'period_delta' AND "period_start" IS NOT NULL AND "period_end" IS NOT NULL AND "period_end" >= "period_start") OR
    ("amount_basis" = 'transaction_delta' AND "as_of_date" IS NOT NULL)
  ),
  CONSTRAINT "federal_funding_source_event_execution_asof_chk" CHECK ("execution_metric" IS NULL OR "as_of_date" IS NOT NULL),
  CONSTRAINT "federal_funding_source_event_transfer_chk" CHECK (("transfer_pair_key" IS NULL AND "transfer_side" IS NULL) OR ("transfer_pair_key" IS NOT NULL AND "transfer_side" IN ('out','in') AND "amount_basis" = 'transaction_delta')),
  CONSTRAINT "federal_funding_source_event_rescission_sign_chk" CHECK (
    "event_type" !~* 'rescission' OR
      ("amount_basis" = 'transaction_delta' AND "source_amount_usd" IS NOT NULL AND "source_amount_usd" < 0)
  )
);
CREATE UNIQUE INDEX "federal_funding_source_event_content_key" ON "federal_funding_source_event"("source_event_key","content_sha256");
CREATE UNIQUE INDEX "federal_funding_source_event_revision_key" ON "federal_funding_source_event"("source_event_key","revision");
CREATE INDEX "federal_funding_source_event_source_time_idx" ON "federal_funding_source_event"("source_system","source_record_id","recorded_at" DESC);
CREATE INDEX "federal_funding_source_event_measure_time_idx" ON "federal_funding_source_event"("measure_id","recorded_at" DESC);

CREATE FUNCTION assert_federal_funding_source_transfer_pair() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE pair_key TEXT; pair_count INTEGER; out_count INTEGER; in_count INTEGER; basis_count INTEGER; metric_count INTEGER;
        obligation_sum NUMERIC; outlay_sum NUMERIC; authority_sum NUMERIC; obligation_count INTEGER; outlay_count INTEGER; authority_count INTEGER;
BEGIN
  pair_key := COALESCE(NEW.transfer_pair_key, OLD.transfer_pair_key);
  IF pair_key IS NULL THEN RETURN NULL; END IF;
  SELECT COUNT(*), COUNT(*) FILTER (WHERE transfer_side='out'), COUNT(*) FILTER (WHERE transfer_side='in'),
         COALESCE(SUM(signed_obligation_delta) FILTER (WHERE execution_metric='obligations'),0),
         COALESCE(SUM(signed_outlay_delta) FILTER (WHERE execution_metric='outlays'),0),
         COALESCE(SUM(source_amount_usd) FILTER (WHERE execution_metric IS NULL),0),
         COUNT(*) FILTER (WHERE execution_metric='obligations' AND signed_obligation_delta IS NOT NULL),
         COUNT(*) FILTER (WHERE execution_metric='outlays' AND signed_outlay_delta IS NOT NULL),
         COUNT(*) FILTER (WHERE execution_metric IS NULL AND source_amount_usd IS NOT NULL),
         COUNT(DISTINCT amount_basis), COUNT(DISTINCT COALESCE(execution_metric,'authority'))
    INTO pair_count, out_count, in_count, obligation_sum, outlay_sum, authority_sum, obligation_count, outlay_count, authority_count, basis_count, metric_count
    FROM federal_funding_source_event WHERE transfer_pair_key=pair_key;
  IF pair_count <> 2 OR out_count <> 1 OR in_count <> 1 OR basis_count <> 1 OR metric_count <> 1 OR
     NOT ((authority_count = 2 AND authority_sum = 0 AND obligation_count = 0 AND outlay_count = 0) OR
          (obligation_count = 2 AND obligation_sum = 0 AND outlay_count = 0 AND authority_count = 0) OR
          (outlay_count = 2 AND outlay_sum = 0 AND obligation_count = 0 AND authority_count = 0)) THEN
    RAISE EXCEPTION 'source transfer pair % must contain balanced signed out/in events for one basis and metric', pair_key;
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER "federal_funding_source_transfer_pair_deferred"
  AFTER INSERT OR UPDATE OR DELETE ON "federal_funding_source_event"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_federal_funding_source_transfer_pair();

ALTER TABLE "federal_funding_allocation"
  ADD CONSTRAINT "federal_funding_allocation_source_event_fk"
    FOREIGN KEY ("source_event_id") REFERENCES "federal_funding_source_event"("id") ON UPDATE CASCADE ON DELETE RESTRICT;

CREATE TABLE "federal_funding_certification" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "certification_key" TEXT NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "measure_id" UUID NOT NULL,
  "measure_status" TEXT NOT NULL,
  "source_event_watermark" TIMESTAMPTZ(6),
  "source_event_count" INTEGER NOT NULL,
  "scope_jsonb" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "status" TEXT NOT NULL DEFAULT 'certified',
  "certified_by" TEXT,
  "certified_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  "content_sha256" CHAR(64) NOT NULL,
  CONSTRAINT "federal_funding_certification_measure_fk" FOREIGN KEY ("measure_id") REFERENCES "federal_funding_measure"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT "federal_funding_certification_revision_chk" CHECK ("revision" >= 1),
  CONSTRAINT "federal_funding_certification_event_count_chk" CHECK ("source_event_count" >= 0),
  CONSTRAINT "federal_funding_certification_status_chk" CHECK ("status" = 'certified'),
  CONSTRAINT "federal_funding_certification_measure_status_chk" CHECK ("measure_status" IN ('draft','introduced','enacted','active','superseded','withdrawn','expired')),
  CONSTRAINT "federal_funding_certification_sha_chk" CHECK ("content_sha256" ~ '^[0-9a-f]{64}$')
);
CREATE UNIQUE INDEX "federal_funding_certification_revision_key" ON "federal_funding_certification"("certification_key","revision");
CREATE INDEX "federal_funding_certification_measure_time_idx" ON "federal_funding_certification"("measure_id","certified_at" DESC);

CREATE TABLE "federal_funding_publication" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "certification_id" UUID NOT NULL,
  "allocation_id" UUID NOT NULL,
  "allocation_snapshot_jsonb" JSONB NOT NULL,
  "content_sha256" CHAR(64) NOT NULL,
  "published_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "federal_funding_publication_cert_fk" FOREIGN KEY ("certification_id") REFERENCES "federal_funding_certification"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT "federal_funding_publication_allocation_fk" FOREIGN KEY ("allocation_id") REFERENCES "federal_funding_allocation"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT "federal_funding_publication_sha_chk" CHECK ("content_sha256" ~ '^[0-9a-f]{64}$')
);
CREATE UNIQUE INDEX "federal_funding_publication_allocation_key" ON "federal_funding_publication"("certification_id","allocation_id");
CREATE INDEX "federal_funding_publication_allocation_time_idx" ON "federal_funding_publication"("allocation_id","published_at" DESC);

CREATE TABLE "federal_funding_reconciliation_residual" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "certification_id" UUID NOT NULL,
  "scope_key" TEXT NOT NULL,
  "scope_jsonb" JSONB NOT NULL,
  "basis" TEXT NOT NULL,
  "residual_amount_usd" NUMERIC(20,2) NOT NULL,
  "reason" TEXT NOT NULL,
  "coverage_state" TEXT NOT NULL,
  "freshness_jsonb" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "evidence_source_document_id" UUID,
  "evidence_sha256" CHAR(64),
  "content_sha256" CHAR(64) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "federal_funding_residual_cert_fk" FOREIGN KEY ("certification_id") REFERENCES "federal_funding_certification"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT "federal_funding_residual_document_fk" FOREIGN KEY ("evidence_source_document_id") REFERENCES "source_document"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT "federal_funding_residual_basis_chk" CHECK ("basis" IN ('snapshot','period_delta','transaction_delta')),
  CONSTRAINT "federal_funding_residual_coverage_chk" CHECK ("coverage_state" IN ('complete','partial','unknown','unavailable','unsupported')),
  CONSTRAINT "federal_funding_residual_reason_chk" CHECK (length(btrim("reason")) > 0),
  CONSTRAINT "federal_funding_residual_evidence_chk" CHECK (("evidence_source_document_id" IS NULL) = ("evidence_sha256" IS NULL)),
  CONSTRAINT "federal_funding_residual_sha_chk" CHECK ("content_sha256" ~ '^[0-9a-f]{64}$' AND ("evidence_sha256" IS NULL OR "evidence_sha256" ~ '^[0-9a-f]{64}$'))
);
CREATE UNIQUE INDEX "federal_funding_residual_content_key" ON "federal_funding_reconciliation_residual"("certification_id","scope_key","content_sha256");
CREATE INDEX "federal_funding_residual_scope_time_idx" ON "federal_funding_reconciliation_residual"("scope_key","created_at" DESC);

CREATE TABLE "federal_funding_publication_checkpoint" (
  "checkpoint_key" TEXT PRIMARY KEY,
  "version" INTEGER NOT NULL,
  "cursor" TEXT,
  "through_id" TEXT,
  "complete" BOOLEAN NOT NULL DEFAULT FALSE,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "federal_funding_checkpoint_version_chk" CHECK ("version" = 1)
);

CREATE FUNCTION prevent_federal_funding_history_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; insert a new revision', TG_TABLE_NAME;
END;
$$;
CREATE TRIGGER "federal_funding_source_event_immutable" BEFORE UPDATE OR DELETE ON "federal_funding_source_event" FOR EACH ROW EXECUTE FUNCTION prevent_federal_funding_history_mutation();
CREATE TRIGGER "federal_funding_certification_immutable" BEFORE UPDATE OR DELETE ON "federal_funding_certification" FOR EACH ROW EXECUTE FUNCTION prevent_federal_funding_history_mutation();
CREATE TRIGGER "federal_funding_publication_immutable" BEFORE UPDATE OR DELETE ON "federal_funding_publication" FOR EACH ROW EXECUTE FUNCTION prevent_federal_funding_history_mutation();
CREATE TRIGGER "federal_funding_residual_immutable" BEFORE UPDATE OR DELETE ON "federal_funding_reconciliation_residual" FOR EACH ROW EXECUTE FUNCTION prevent_federal_funding_history_mutation();

CREATE FUNCTION assert_federal_funding_transfer_pair() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE pair_key TEXT; pair_count INTEGER; pair_sum NUMERIC; out_count INTEGER; in_count INTEGER;
BEGIN
  pair_key := COALESCE(NEW.transfer_pair_key, OLD.transfer_pair_key);
  IF pair_key IS NULL THEN RETURN NULL; END IF;
  SELECT COUNT(*), COALESCE(SUM(authoritative_amount_usd),0),
         COUNT(*) FILTER (WHERE transfer_side='out' AND authoritative_amount_usd < 0),
         COUNT(*) FILTER (WHERE transfer_side='in' AND authoritative_amount_usd > 0)
    INTO pair_count, pair_sum, out_count, in_count
    FROM federal_funding_allocation WHERE transfer_pair_key=pair_key;
  IF pair_count <> 2 OR out_count <> 1 OR in_count <> 1 OR pair_sum <> 0 THEN
    RAISE EXCEPTION 'transfer pair % must contain one signed out and one equal signed in allocation', pair_key;
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER "federal_funding_allocation_transfer_pair_deferred"
  AFTER INSERT OR UPDATE OR DELETE ON "federal_funding_allocation"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_federal_funding_transfer_pair();

REVOKE ALL ON TABLE "federal_funding_source_event" FROM PUBLIC;
REVOKE ALL ON TABLE "federal_funding_certification" FROM PUBLIC;
REVOKE ALL ON TABLE "federal_funding_publication" FROM PUBLIC;
REVOKE ALL ON TABLE "federal_funding_reconciliation_residual" FROM PUBLIC;
REVOKE ALL ON TABLE "federal_funding_publication_checkpoint" FROM PUBLIC;
GRANT SELECT ON TABLE "federal_funding_source_event","federal_funding_certification","federal_funding_publication","federal_funding_reconciliation_residual","federal_funding_publication_checkpoint" TO "capiro_defense_serve";
GRANT SELECT, INSERT, UPDATE ON TABLE "federal_funding_source_event","federal_funding_certification","federal_funding_publication","federal_funding_reconciliation_residual","federal_funding_publication_checkpoint" TO "capiro_defense_job";
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO "capiro_defense_job";
