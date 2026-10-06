-- Additive Planner-owned attachment metadata. Payloads live in the existing
-- encrypted tenant assets bucket, separate from Workspace documents.
CREATE UNIQUE INDEX "sp_planner_tasks_tenant_id_id_key" ON "sp_planner_tasks"("tenant_id","id");
CREATE TABLE "sp_planner_attachments" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "task_id" UUID NOT NULL,
  "uploaded_by" TEXT NOT NULL,
  "file_name" TEXT NOT NULL,
  "size_bytes" INTEGER NOT NULL CHECK ("size_bytes" > 0 AND "size_bytes" <= 26214400),
  "object_key" TEXT NOT NULL,
  "archived" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "sp_planner_attachments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "sp_planner_attachments_tenant_id_task_id_fkey" FOREIGN KEY ("tenant_id","task_id") REFERENCES "sp_planner_tasks"("tenant_id","id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "sp_planner_attachments_tenant_id_task_id_archived_idx" ON "sp_planner_attachments"("tenant_id","task_id","archived");
ALTER TABLE "sp_planner_attachments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sp_planner_attachments" FORCE ROW LEVEL SECURITY;
CREATE POLICY "sp_planner_attachments_tenant_isolation" ON "sp_planner_attachments" USING (tenant_id=current_tenant_id() OR rls_bypass()) WITH CHECK (tenant_id=current_tenant_id() OR rls_bypass());
