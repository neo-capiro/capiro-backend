-- CreateTable
-- Additive only. Legacy detector eligibility, subscriptions and watermarks are
-- intentionally absent. Apply after API identity/RLS foundations.
CREATE TABLE "intel_legiwatch_folder" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "owner_clerk_id" TEXT,
    "other_user_access" TEXT NOT NULL DEFAULT 'read_change',
    "client_id" TEXT,
    "default_session" TEXT NOT NULL DEFAULT 'current',
    "jurisdiction" TEXT NOT NULL DEFAULT 'FL',
    "version" INTEGER NOT NULL DEFAULT 0,
    "provenance" JSONB NOT NULL DEFAULT '{}',
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "intel_legiwatch_folder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "intel_legiwatch_folder_bill" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "folder_id" TEXT NOT NULL,
    "bill_id" TEXT NOT NULL,
    "session_key" TEXT NOT NULL,
    "jurisdiction" TEXT NOT NULL,
    "top_priority" BOOLEAN NOT NULL DEFAULT false,
    "importance" TEXT NOT NULL DEFAULT 'normal',
    "position" TEXT NOT NULL DEFAULT 'none',
    "internal_comments" TEXT NOT NULL DEFAULT '',
    "external_comments" TEXT NOT NULL DEFAULT '',
    "added_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "added_date_raw" TEXT,
    "added_date_precision" TEXT NOT NULL DEFAULT 'instant',
    "version" INTEGER NOT NULL DEFAULT 0,
    "updated_by" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "provenance" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "intel_legiwatch_folder_bill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "intel_legiwatch_folder_revision" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "assignment_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "changed_by" TEXT NOT NULL,
    "context" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "intel_legiwatch_folder_revision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "intel_legiwatch_import_run" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "source_account" TEXT NOT NULL,
    "capture_id" TEXT NOT NULL,
    "source_hash" TEXT NOT NULL,
    "mapping_hash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'preview',
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "intel_legiwatch_import_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "intel_legiwatch_import_item" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "reason" TEXT,
    "payload" JSONB NOT NULL,
    "target_id" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "intel_legiwatch_import_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "intel_legiwatch_source_mapping" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "source_account" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "target_id" TEXT NOT NULL,
    "source_hash" TEXT NOT NULL,
    "target_version" INTEGER NOT NULL DEFAULT 0,
    "run_id" TEXT NOT NULL,
    "provenance" JSONB NOT NULL DEFAULT '{}',
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "intel_legiwatch_source_mapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "intel_legiwatch_staged_configuration" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "source_account" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'staged',
    "payload" JSONB NOT NULL,
    "provenance" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "intel_legiwatch_staged_configuration_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "intel_legiwatch_folder_tenant_id_archived_name_idx" ON "intel_legiwatch_folder"("tenant_id", "archived", "name");

-- CreateIndex
CREATE UNIQUE INDEX "intel_legiwatch_folder_tenant_id_id_key" ON "intel_legiwatch_folder"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "intel_legiwatch_folder_bill_tenant_id_folder_id_session_key_idx" ON "intel_legiwatch_folder_bill"("tenant_id", "folder_id", "session_key", "jurisdiction");

-- CreateIndex
CREATE UNIQUE INDEX "intel_legiwatch_folder_bill_tenant_id_folder_id_bill_id_key" ON "intel_legiwatch_folder_bill"("tenant_id", "folder_id", "bill_id");

-- CreateIndex
CREATE UNIQUE INDEX "intel_legiwatch_folder_bill_tenant_id_id_key" ON "intel_legiwatch_folder_bill"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "intel_legiwatch_folder_revision_tenant_id_assignment_id_ver_key" ON "intel_legiwatch_folder_revision"("tenant_id", "assignment_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "intel_legiwatch_import_run_tenant_id_source_account_source__key" ON "intel_legiwatch_import_run"("tenant_id", "source_account", "source_hash", "mapping_hash");

-- CreateIndex
CREATE UNIQUE INDEX "intel_legiwatch_import_run_tenant_id_id_key" ON "intel_legiwatch_import_run"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "intel_legiwatch_import_item_tenant_id_run_id_status_idx" ON "intel_legiwatch_import_item"("tenant_id", "run_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "intel_legiwatch_import_item_tenant_id_run_id_kind_source_id_key" ON "intel_legiwatch_import_item"("tenant_id", "run_id", "kind", "source_id");

-- CreateIndex
CREATE INDEX "intel_legiwatch_source_mapping_tenant_id_target_id_idx" ON "intel_legiwatch_source_mapping"("tenant_id", "target_id");

-- CreateIndex
CREATE UNIQUE INDEX "intel_legiwatch_source_mapping_tenant_id_source_account_kin_key" ON "intel_legiwatch_source_mapping"("tenant_id", "source_account", "kind", "source_id");

-- CreateIndex
CREATE INDEX "intel_legiwatch_staged_configuration_tenant_id_kind_idx" ON "intel_legiwatch_staged_configuration"("tenant_id", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "intel_legiwatch_staged_configuration_tenant_id_source_accou_key" ON "intel_legiwatch_staged_configuration"("tenant_id", "source_account", "kind", "source_id");

-- AddForeignKey
ALTER TABLE "intel_legiwatch_folder_bill" ADD CONSTRAINT "intel_legiwatch_folder_bill_tenant_id_folder_id_fkey" FOREIGN KEY ("tenant_id", "folder_id") REFERENCES "intel_legiwatch_folder"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "intel_legiwatch_folder_revision" ADD CONSTRAINT "intel_legiwatch_folder_revision_tenant_id_assignment_id_fkey" FOREIGN KEY ("tenant_id", "assignment_id") REFERENCES "intel_legiwatch_folder_bill"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "intel_legiwatch_import_item" ADD CONSTRAINT "intel_legiwatch_import_item_tenant_id_run_id_fkey" FOREIGN KEY ("tenant_id", "run_id") REFERENCES "intel_legiwatch_import_run"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
