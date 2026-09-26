CREATE TABLE "research_portfolio_bookmarks" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "portfolio_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "target_kind" VARCHAR(48) NOT NULL,
    "target_id" VARCHAR(256) NOT NULL,
    "label" VARCHAR(255),
    "note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "research_portfolio_bookmarks_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "research_portfolio_tour_states" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "tour_version" VARCHAR(64) NOT NULL,
    "status" VARCHAR(24) NOT NULL,
    "completed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "research_portfolio_tour_states_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "research_portfolio_review_notes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "portfolio_id" UUID NOT NULL,
    "review_id" UUID NOT NULL,
    "author_user_id" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "research_portfolio_review_notes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "research_portfolio_bookmarks_unique"
    ON "research_portfolio_bookmarks"("tenant_id", "portfolio_id", "user_id", "target_kind", "target_id");

CREATE INDEX "research_portfolio_bookmarks_user_idx"
    ON "research_portfolio_bookmarks"("tenant_id", "portfolio_id", "user_id", "created_at" DESC);

CREATE UNIQUE INDEX "research_portfolio_tour_state_unique"
    ON "research_portfolio_tour_states"("tenant_id", "user_id", "tour_version");

CREATE INDEX "research_portfolio_review_notes_review_idx"
    ON "research_portfolio_review_notes"("tenant_id", "review_id", "created_at" DESC);

ALTER TABLE "research_portfolio_bookmarks"
    ADD CONSTRAINT "research_portfolio_bookmarks_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "research_portfolio_bookmarks"
    ADD CONSTRAINT "research_portfolio_bookmarks_tenant_id_portfolio_id_fkey"
    FOREIGN KEY ("tenant_id", "portfolio_id") REFERENCES "research_portfolios"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "research_portfolio_tour_states"
    ADD CONSTRAINT "research_portfolio_tour_states_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "research_portfolio_review_notes"
    ADD CONSTRAINT "research_portfolio_review_notes_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "research_portfolio_review_notes"
    ADD CONSTRAINT "research_portfolio_review_notes_tenant_id_portfolio_id_fkey"
    FOREIGN KEY ("tenant_id", "portfolio_id") REFERENCES "research_portfolios"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "research_portfolio_review_notes"
    ADD CONSTRAINT "research_portfolio_review_notes_tenant_id_review_id_fkey"
    FOREIGN KEY ("tenant_id", "review_id") REFERENCES "research_portfolio_reviews"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TYPE "research_portfolio_event_kind" ADD VALUE IF NOT EXISTS 'review_note_added';
