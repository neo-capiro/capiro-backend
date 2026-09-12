-- AlterTable
-- Public calendar facts remain API-owned. Unknown historic provenance remains
-- NULL; an old congress number or existing canonical source ID qualifies US.
-- This migration is additive and follows the already-applied 20280910 chain.
ALTER TABLE "state_bill_calendar_event" ADD COLUMN     "description" TEXT,
ADD COLUMN     "first_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "present" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "raw" JSONB;

-- AlterTable
ALTER TABLE "committee_hearing" ADD COLUMN     "body_source_key" TEXT,
ADD COLUMN     "calendar_check_state" TEXT NOT NULL DEFAULT 'unknown',
ADD COLUMN     "calendar_checked_at" TIMESTAMPTZ(6),
ADD COLUMN     "calendar_provenance" JSONB,
ADD COLUMN     "calendar_revision" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "calendar_snapshot" JSONB,
ADD COLUMN     "geographic_jurisdiction" TEXT,
ADD COLUMN     "legislative_session" TEXT,
ADD COLUMN     "scheduled_end" TIMESTAMPTZ(6),
ADD COLUMN     "state_committee_id" TEXT,
ADD COLUMN     "time_precision" TEXT;

-- CreateTable
CREATE TABLE "legislative_agenda_item" (
    "id" UUID NOT NULL,
    "hearing_id" TEXT NOT NULL,
    "item_key" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "bill_scope" TEXT,
    "state_bill_key" TEXT,
    "federal_bill_id" TEXT,
    "source_url" TEXT NOT NULL,
    "evidence" JSONB NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "revision" INTEGER NOT NULL,
    "first_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "legislative_agenda_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "legislative_calendar_transition" (
    "id" UUID NOT NULL,
    "hearing_id" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "before" JSONB,
    "after" JSONB NOT NULL,
    "changed_fields" TEXT[],
    "source_id" UUID,
    "source_url" TEXT NOT NULL,
    "observed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "legislative_calendar_transition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "legislative_observation_revision" (
    "id" UUID NOT NULL,
    "source_id" UUID NOT NULL,
    "external_event_id" TEXT NOT NULL,
    "hearing_id" TEXT NOT NULL,
    "content_hash" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "observed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "legislative_observation_revision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "legislative_calendar_coverage" (
    "id" UUID NOT NULL,
    "source_id" UUID NOT NULL,
    "jurisdiction" TEXT NOT NULL,
    "chamber" TEXT NOT NULL,
    "session" TEXT,
    "from_date" DATE NOT NULL,
    "to_date" DATE NOT NULL,
    "status" TEXT NOT NULL,
    "pages" INTEGER NOT NULL DEFAULT 0,
    "items" INTEGER NOT NULL DEFAULT 0,
    "details" JSONB NOT NULL,
    "attempted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "legislative_calendar_coverage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "state_bill_calendar_snapshot" (
    "id" UUID NOT NULL,
    "bill_key" TEXT NOT NULL,
    "content_hash" TEXT NOT NULL,
    "completeness" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "issues" JSONB NOT NULL,
    "observed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "state_bill_calendar_snapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "legislative_agenda_item_state_bill_key_active_hearing_id_idx" ON "legislative_agenda_item"("state_bill_key", "active", "hearing_id");

-- CreateIndex
CREATE INDEX "legislative_agenda_item_federal_bill_id_active_hearing_id_idx" ON "legislative_agenda_item"("federal_bill_id", "active", "hearing_id");

-- CreateIndex
CREATE UNIQUE INDEX "legislative_agenda_item_hearing_id_item_key_key" ON "legislative_agenda_item"("hearing_id", "item_key");

-- CreateIndex
CREATE INDEX "legislative_calendar_transition_observed_at_id_idx" ON "legislative_calendar_transition"("observed_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "legislative_calendar_transition_hearing_id_revision_key" ON "legislative_calendar_transition"("hearing_id", "revision");

-- CreateIndex
CREATE INDEX "legislative_observation_revision_hearing_id_observed_at_idx" ON "legislative_observation_revision"("hearing_id", "observed_at");

-- CreateIndex
CREATE INDEX "legislative_observation_revision_source_id_external_event_i_idx" ON "legislative_observation_revision"("source_id", "external_event_id", "observed_at");

-- CreateIndex
CREATE INDEX "legislative_calendar_coverage_jurisdiction_chamber_attempte_idx" ON "legislative_calendar_coverage"("jurisdiction", "chamber", "attempted_at");

-- CreateIndex
CREATE INDEX "state_bill_calendar_snapshot_bill_key_observed_at_idx" ON "state_bill_calendar_snapshot"("bill_key", "observed_at");

-- CreateIndex
CREATE INDEX "committee_hearing_geographic_jurisdiction_legislative_sessi_idx" ON "committee_hearing"("geographic_jurisdiction", "legislative_session", "date");

UPDATE committee_hearing SET geographic_jurisdiction='US'
WHERE congress IS NOT NULL OR id ~ '^(cm|sen)-[0-9]+-' OR id ~ '^[0-9]+-[0-9]+-[0-9]{4}-';
-- Existing exports used 0/1. Begin above both without changing any UID.
UPDATE committee_hearing SET calendar_revision=2;
ALTER TABLE committee_hearing DROP CONSTRAINT committee_hearing_event_status_chk;
ALTER TABLE committee_hearing ADD CONSTRAINT committee_hearing_event_status_chk
CHECK (event_status IN ('scheduled','postponed','canceled','in_progress','completed','unknown'));
ALTER TABLE committee_hearing ADD CONSTRAINT committee_hearing_calendar_revision_chk CHECK (calendar_revision >= 0);
ALTER TABLE legislative_agenda_item ADD CONSTRAINT legislative_agenda_bill_scope_chk CHECK (
  (bill_scope IS NULL AND state_bill_key IS NULL AND federal_bill_id IS NULL AND kind <> 'bill') OR
  (bill_scope='state' AND state_bill_key IS NOT NULL AND federal_bill_id IS NULL AND kind='bill') OR
  (bill_scope='federal' AND federal_bill_id IS NOT NULL AND state_bill_key IS NULL AND kind='bill')
);
ALTER TABLE legislative_agenda_item ADD CONSTRAINT legislative_agenda_hearing_fk FOREIGN KEY (hearing_id) REFERENCES committee_hearing(id);
ALTER TABLE legislative_agenda_item ADD CONSTRAINT legislative_agenda_state_bill_fk FOREIGN KEY (state_bill_key) REFERENCES state_bill(id);
ALTER TABLE legislative_calendar_transition ADD CONSTRAINT legislative_transition_hearing_fk FOREIGN KEY (hearing_id) REFERENCES committee_hearing(id);
ALTER TABLE legislative_observation_revision ADD CONSTRAINT legislative_observation_hearing_fk FOREIGN KEY (hearing_id) REFERENCES committee_hearing(id);
ALTER TABLE state_bill_calendar_snapshot ADD CONSTRAINT state_calendar_snapshot_bill_fk FOREIGN KEY (bill_key) REFERENCES state_bill(id);

-- Covers existing federal writers as well as the new reconciler. Polling,
-- coverage checks and capture progress do not advance calendar SEQUENCE.
CREATE FUNCTION legiwatch_calendar_material_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.title,NEW.date,NEW.starts_at,NEW.time,NEW.timezone,NEW.location,NEW.event_status,NEW.url,NEW.scheduled_end)
     IS DISTINCT FROM ROW(OLD.title,OLD.date,OLD.starts_at,OLD.time,OLD.timezone,OLD.location,OLD.event_status,OLD.url,OLD.scheduled_end)
     AND NEW.calendar_revision <= OLD.calendar_revision THEN
    NEW.calendar_revision := OLD.calendar_revision + 1;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER legiwatch_calendar_material_revision BEFORE UPDATE ON committee_hearing
FOR EACH ROW EXECUTE FUNCTION legiwatch_calendar_material_revision();

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='capiro_app') THEN
    GRANT SELECT, INSERT, UPDATE ON legislative_agenda_item, legislative_calendar_coverage TO capiro_app;
    GRANT SELECT, INSERT ON legislative_calendar_transition, legislative_observation_revision, state_bill_calendar_snapshot TO capiro_app;
  END IF;
END $$;
