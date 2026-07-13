-- G3 — structured advocacy OUTCOMES (blueprint §3.1 stage 5 + §5.2 flywheel).
--
-- One row per observed result of the firm's work: a response received, a
-- meeting held, requested language included, funding changed, a filing
-- completed, or an explicit no-action signal. Until now the only outcome
-- records were free-text (client_submission_history.outcome,
-- action_recommendation.outcome) — nothing structured linked ARTIFACTS and
-- OUTREACH to RESULTS, which is the signal the operating-memory flywheel
-- compounds on.
--
-- Linkage is loose polymorphic (source_type + source_id — the
-- EngagementTask/MeetingBotSession precedent) because outcomes reference rows
-- across modules (outreach_records, meetings, ws_draft artifacts,
-- client_submission_history) and PE funding rows are GLOBAL + superseded over
-- time — so funding outcomes SNAPSHOT their evidence (pe code, fy, stage,
-- amounts) into evidence_jsonb rather than FK-ing a mutable delta row.
--
-- Tenant-scoped + RLS-isolated per the meri_audit_ledger template.
CREATE TABLE "outcome_event" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "tenant_id" UUID NOT NULL,
    "client_id" UUID,
    -- response_received | meeting_scheduled | meeting_held | language_included
    -- | funding_changed | filing_completed | commitment_secured | no_action
    "kind" VARCHAR(32) NOT NULL,
    -- outreach | meeting | artifact | campaign | submission | manual
    "source_type" VARCHAR(24) NOT NULL,
    "source_id" TEXT,
    -- Snapshotted proof: { peCode?, fiscalYear?, stage?, amountFrom?, amountTo?,
    -- billNumber?, threadId?, ... } — shape evolves without migration.
    "evidence_jsonb" JSONB NOT NULL DEFAULT '{}',
    "notes" TEXT,
    -- users.id of whoever recorded it; NULL for system-emitted mirrors.
    "recorded_by" UUID,
    "observed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "outcome_event_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "outcome_event_tenant_fkey" FOREIGN KEY ("tenant_id")
        REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "outcome_event_kind_chk" CHECK ("kind" IN (
        'response_received', 'meeting_scheduled', 'meeting_held',
        'language_included', 'funding_changed', 'filing_completed',
        'commitment_secured', 'no_action'
    )),
    CONSTRAINT "outcome_event_source_type_chk" CHECK ("source_type" IN (
        'outreach', 'meeting', 'artifact', 'campaign', 'submission', 'manual'
    ))
);

CREATE INDEX "outcome_event_tenant_observed_idx"
    ON "outcome_event" ("tenant_id", "observed_at" DESC);
CREATE INDEX "outcome_event_tenant_client_idx"
    ON "outcome_event" ("tenant_id", "client_id", "observed_at" DESC);
CREATE INDEX "outcome_event_source_idx"
    ON "outcome_event" ("tenant_id", "source_type", "source_id");

ALTER TABLE "outcome_event" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "outcome_event" FORCE ROW LEVEL SECURITY;

CREATE POLICY "outcome_event_select" ON "outcome_event"
    FOR SELECT USING (rls_bypass() OR tenant_id = current_tenant_id());
CREATE POLICY "outcome_event_insert" ON "outcome_event"
    FOR INSERT WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());
CREATE POLICY "outcome_event_update" ON "outcome_event"
    FOR UPDATE USING (rls_bypass() OR tenant_id = current_tenant_id())
    WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());
CREATE POLICY "outcome_event_delete" ON "outcome_event"
    FOR DELETE USING (rls_bypass() OR tenant_id = current_tenant_id());
