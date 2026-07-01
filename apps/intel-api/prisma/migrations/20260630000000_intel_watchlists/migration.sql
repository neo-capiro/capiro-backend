-- CreateTable
CREATE TABLE "intel_watchlist" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "intel_watchlist_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "intel_watchlist_term" (
    "id" TEXT NOT NULL,
    "watchlist_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "term_type" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "weight" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "intel_watchlist_term_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "intel_watchlist_match" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "segment_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "watchlist_id" TEXT NOT NULL,
    "term_id" TEXT NOT NULL,
    "term_type" TEXT NOT NULL,
    "term_value" TEXT NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "start_ms" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "intel_watchlist_match_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "intel_watchlist_tenant_id_client_id_idx" ON "intel_watchlist"("tenant_id", "client_id");

-- CreateIndex
CREATE INDEX "intel_watchlist_tenant_id_active_idx" ON "intel_watchlist"("tenant_id", "active");

-- CreateIndex
CREATE INDEX "intel_watchlist_term_watchlist_id_idx" ON "intel_watchlist_term"("watchlist_id");

-- CreateIndex
CREATE INDEX "intel_watchlist_term_tenant_id_term_type_idx" ON "intel_watchlist_term"("tenant_id", "term_type");

-- CreateIndex
CREATE INDEX "intel_watchlist_match_tenant_id_session_id_idx" ON "intel_watchlist_match"("tenant_id", "session_id");

-- CreateIndex
CREATE INDEX "intel_watchlist_match_tenant_id_client_id_idx" ON "intel_watchlist_match"("tenant_id", "client_id");

-- AddForeignKey
ALTER TABLE "intel_watchlist_term" ADD CONSTRAINT "intel_watchlist_term_watchlist_id_fkey" FOREIGN KEY ("watchlist_id") REFERENCES "intel_watchlist"("id") ON DELETE CASCADE ON UPDATE CASCADE;

