-- AlterTable
ALTER TABLE "state_bill" ADD COLUMN     "report_source_facts" JSONB;

-- AlterTable
ALTER TABLE "legiwatch_notification_event" ADD COLUMN     "bill_id" TEXT,
ALTER COLUMN "hearing_id" DROP NOT NULL;

-- CreateTable
CREATE TABLE "state_bill_published_record" (
    "id" UUID NOT NULL,
    "bill_key" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "source_identity" TEXT NOT NULL,
    "revision_hash" TEXT NOT NULL,
    "event_date" TEXT,
    "source_order" INTEGER NOT NULL,
    "evidence" JSONB NOT NULL,
    "first_observed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "state_bill_published_record_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "state_bill_published_record_bill_key_first_observed_at_idx" ON "state_bill_published_record"("bill_key", "first_observed_at");

-- CreateIndex
CREATE UNIQUE INDEX "state_bill_published_record_bill_key_kind_source_identity_r_key" ON "state_bill_published_record"("bill_key", "kind", "source_identity", "revision_hash");

ALTER TABLE state_bill_published_record ADD CONSTRAINT published_record_kind CHECK (kind IN ('action','amendment'));
ALTER TABLE state_bill_published_record ADD CONSTRAINT published_record_bill_fk FOREIGN KEY (bill_key) REFERENCES state_bill(id) ON DELETE CASCADE;
ALTER TABLE legiwatch_notification_event DROP CONSTRAINT legiwatch_notification_event_type_check;
ALTER TABLE legiwatch_notification_event ADD CONSTRAINT legiwatch_notification_event_type_check CHECK (event_type IN (
  'schedule_changed','location_changed','witnesses_changed','hearing_starting','capture_started','capture_failed','transcript_ready','intelligence_ready','high_priority_match','bill_record'
));
ALTER TABLE legiwatch_notification_event ADD CONSTRAINT legiwatch_notification_subject_check CHECK (
  (event_type='bill_record' AND bill_id IS NOT NULL AND hearing_id IS NULL) OR
  (event_type<>'bill_record' AND hearing_id IS NOT NULL AND bill_id IS NULL)
);
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='capiro_app') THEN
    GRANT SELECT,INSERT ON state_bill_published_record TO capiro_app;
  END IF;
END $$;
