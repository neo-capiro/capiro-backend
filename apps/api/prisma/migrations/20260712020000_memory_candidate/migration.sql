-- Phase 1 ("One Memory, One Ledger") workstream 1B — candidate lifecycle for
-- memory writes (blueprint §4.6.5). A write from save_memory (either surface —
-- legacy chat and MeriV2 both converge on MeriToolsService.saveMemory, the
-- MeriV2 write-tool delegates via POST /api/clio/tools/save_memory) always
-- creates a row here first; evaluateMemoryCandidate (memory-candidate-
-- rules.ts) resolves PASS (auto-commit, same request) or WARN (stays
-- 'pending' until an admin approves/rejects it).
--
-- Follows the established RLS pattern (migration 20260501000000): tenant-
-- scoped, FORCE ROW LEVEL SECURITY, isolation policy keyed on
-- current_tenant_id()/rls_bypass().
CREATE TABLE "memory_candidate" (
  "id"                   UUID          NOT NULL DEFAULT uuid_generate_v4(),
  "tenant_id"            UUID          NOT NULL,
  "proposed_by"          UUID          NOT NULL,
  "source_kind"          VARCHAR(24)   NOT NULL,
  "scope"                VARCHAR(16)   NOT NULL,
  "payload_jsonb"        JSONB         NOT NULL,
  "provenance_jsonb"     JSONB         NOT NULL,
  "duplicate_of_id"      UUID,
  "contradicts_id"       UUID,
  "status"               VARCHAR(16)   NOT NULL DEFAULT 'pending',
  "decided_by"           UUID,
  "decided_at"           TIMESTAMPTZ(6),
  "committed_memory_id"  UUID,
  "created_at"           TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "memory_candidate_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "memory_candidate_tenant_fk"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
  CONSTRAINT "memory_candidate_duplicate_of_fk"
    FOREIGN KEY ("duplicate_of_id") REFERENCES "memory_candidate"("id") ON DELETE SET NULL,
  CONSTRAINT "memory_candidate_scope_chk"
    CHECK ("scope" IN ('personal', 'firm')),
  CONSTRAINT "memory_candidate_source_kind_chk"
    CHECK ("source_kind" IN ('explicit_user', 'workflow_event', 'artifact_approval', 'model_extraction')),
  CONSTRAINT "memory_candidate_status_chk"
    CHECK ("status" IN ('pending', 'approved', 'rejected', 'auto_committed'))
);

CREATE INDEX "memory_candidate_tenant_status_idx"
  ON "memory_candidate" ("tenant_id", "status");
CREATE INDEX "memory_candidate_tenant_proposed_by_idx"
  ON "memory_candidate" ("tenant_id", "proposed_by");

ALTER TABLE "memory_candidate" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "memory_candidate" FORCE ROW LEVEL SECURITY;
CREATE POLICY "memory_candidate_isolation" ON "memory_candidate"
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());
