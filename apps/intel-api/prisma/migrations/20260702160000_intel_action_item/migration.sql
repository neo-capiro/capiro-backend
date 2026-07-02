-- Actionable-recommendation state for alerts: the memo↔alert link (so the Feed
-- shows "memo drafted" + can reopen the Document), plus curation items
-- (talking points, weekly-report flags). Additive, intel-owned; no RLS (like
-- other intel_* tables — app-code filters by tenant_id + client_id).
CREATE TABLE "intel_action_item" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "client_id" TEXT NOT NULL,
  "alert_id" TEXT NOT NULL,
  "kind" TEXT NOT NULL,                       -- 'memo' | 'talking_point' | 'report'
  "text" TEXT,                                -- talking_point body
  "document_attachment_id" TEXT,              -- apps/api EngagementAttachment id (memo)
  "title" TEXT,                               -- memo title
  "created_by" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "intel_action_item_pkey" PRIMARY KEY ("id")
);

-- memo + report are singletons per alert (re-draft updates, re-flag is idempotent);
-- talking_point rows may be many per alert, so the uniqueness is partial.
CREATE UNIQUE INDEX "intel_action_item_alert_singleton_key"
  ON "intel_action_item" ("alert_id", "kind")
  WHERE "kind" IN ('memo', 'report');

CREATE INDEX "intel_action_item_tenant_client_idx"
  ON "intel_action_item" ("tenant_id", "client_id");
CREATE INDEX "intel_action_item_alert_idx"
  ON "intel_action_item" ("alert_id", "kind");
