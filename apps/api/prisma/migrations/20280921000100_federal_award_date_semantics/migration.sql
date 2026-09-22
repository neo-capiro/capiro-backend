ALTER TABLE "sync_run"
ADD COLUMN "stats_jsonb" JSONB NOT NULL DEFAULT '{}';

ALTER TABLE "federal_award"
ADD COLUMN "base_award_signed_date" DATE,
ADD COLUMN "latest_action_date" DATE,
ADD COLUMN "source_last_modified_date" TIMESTAMPTZ(6),
ADD COLUMN "pop_start_date" DATE,
ADD COLUMN "pop_end_date" DATE,
ADD COLUMN "date_semantics_version" INTEGER,
ADD COLUMN "source_record_jsonb" JSONB;