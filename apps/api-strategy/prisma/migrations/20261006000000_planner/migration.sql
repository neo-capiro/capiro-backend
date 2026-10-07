-- CreateTable
CREATE TABLE "sp_planner_projects" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "owner_id" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "sp_planner_projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sp_planner_tasks" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "owner_id" TEXT NOT NULL,
    "assignee_id" TEXT,
    "parent_id" UUID,
    "project_ids" UUID[],
    "data" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "completed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "sp_planner_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sp_planner_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "actor_id" TEXT NOT NULL,
    "task_id" UUID,
    "project_id" UUID,
    "kind" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "minutes" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sp_planner_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sp_planner_inbox" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" TEXT NOT NULL,
    "event_id" UUID NOT NULL,
    "read" BOOLEAN NOT NULL DEFAULT false,
    "archived" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "sp_planner_inbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sp_planner_resources" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "owner_id" TEXT NOT NULL,
    "project_id" UUID,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "sp_planner_resources_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sp_planner_projects_tenant_id_archived_idx" ON "sp_planner_projects"("tenant_id", "archived");

-- CreateIndex
CREATE INDEX "sp_planner_tasks_tenant_id_archived_assignee_id_idx" ON "sp_planner_tasks"("tenant_id", "archived", "assignee_id");

-- CreateIndex
CREATE INDEX "sp_planner_tasks_tenant_id_parent_id_idx" ON "sp_planner_tasks"("tenant_id", "parent_id");

-- CreateIndex
CREATE INDEX "sp_planner_tasks_project_ids_idx" ON "sp_planner_tasks" USING GIN ("project_ids");

-- CreateIndex
CREATE INDEX "sp_planner_events_tenant_id_task_id_created_at_idx" ON "sp_planner_events"("tenant_id", "task_id", "created_at");

-- CreateIndex
CREATE INDEX "sp_planner_events_tenant_id_project_id_created_at_idx" ON "sp_planner_events"("tenant_id", "project_id", "created_at");

-- CreateIndex
CREATE INDEX "sp_planner_inbox_tenant_id_user_id_archived_idx" ON "sp_planner_inbox"("tenant_id", "user_id", "archived");

-- CreateIndex
CREATE UNIQUE INDEX "sp_planner_inbox_event_id_user_id_key" ON "sp_planner_inbox"("event_id", "user_id");

-- CreateIndex
CREATE INDEX "sp_planner_resources_tenant_id_kind_archived_idx" ON "sp_planner_resources"("tenant_id", "kind", "archived");

-- AddForeignKey
CREATE UNIQUE INDEX "sp_planner_events_tenant_id_id_key" ON "sp_planner_events"("tenant_id", "id");
ALTER TABLE "sp_planner_inbox" ADD CONSTRAINT "sp_planner_inbox_tenant_id_event_id_fkey" FOREIGN KEY ("tenant_id", "event_id") REFERENCES "sp_planner_events"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Application code enforces tenant scope even for the owner runtime role.
-- RLS is additional protection for non-owner database roles.
ALTER TABLE "sp_planner_projects" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sp_planner_tasks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sp_planner_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sp_planner_inbox" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sp_planner_resources" ENABLE ROW LEVEL SECURITY;
CREATE POLICY sp_planner_projects_tenant ON sp_planner_projects USING (rls_bypass() OR tenant_id = current_tenant_id()) WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());
CREATE POLICY sp_planner_tasks_tenant ON sp_planner_tasks USING (rls_bypass() OR tenant_id = current_tenant_id()) WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());
CREATE POLICY sp_planner_events_tenant ON sp_planner_events USING (rls_bypass() OR tenant_id = current_tenant_id()) WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());
CREATE POLICY sp_planner_inbox_tenant ON sp_planner_inbox USING (rls_bypass() OR tenant_id = current_tenant_id()) WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());
CREATE POLICY sp_planner_resources_tenant ON sp_planner_resources USING (rls_bypass() OR tenant_id = current_tenant_id()) WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());

CREATE FUNCTION sp_planner_events_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Planner activity is append-only'; END;
$$;
CREATE TRIGGER sp_planner_events_immutable BEFORE UPDATE OR DELETE ON sp_planner_events FOR EACH ROW EXECUTE FUNCTION sp_planner_events_immutable();

-- ROLLBACK: roll the application back to the previous immutable image. Retain
-- these additive tables and all user-created work. Do not drop Planner data.
