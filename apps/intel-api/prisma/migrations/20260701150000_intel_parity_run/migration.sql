-- Phase 5 parity audit table (§8.6). Additive, non-destructive: one new table,
-- no changes to any existing table. Written by the parity-report task only.

-- CreateTable
CREATE TABLE "intel_parity_run" (
    "id" TEXT NOT NULL,
    "run_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "window_days" INTEGER NOT NULL,
    "tenant_scope" TEXT NOT NULL,
    "tenant_id" TEXT,
    "client_count" INTEGER NOT NULL,
    "legacy_count" INTEGER NOT NULL,
    "intel_count" INTEGER NOT NULL,
    "intersection" INTEGER NOT NULL,
    "overlap" DOUBLE PRECISION NOT NULL,
    "recall" DOUBLE PRECISION NOT NULL,
    "precision" DOUBLE PRECISION NOT NULL,
    "missed_criticals" INTEGER NOT NULL,
    "severity_critical_mismatches" INTEGER NOT NULL,
    "max_score_delta" DOUBLE PRECISION,
    "p95_score_delta" DOUBLE PRECISION,
    "passed" BOOLEAN NOT NULL,
    "reason" TEXT,
    "git_sha" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "intel_parity_run_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "intel_parity_run_tenant_scope_run_at_idx" ON "intel_parity_run"("tenant_scope", "run_at");
