-- ===========================================================================
-- Assurance: PERSISTED evaluation runs with CATEGORY-SPECIFIC release decisions.
--
-- WHY. packages/meriv2-core/src/assurance/eval-gate.ts implements exactly the
-- right thing — a per-domain gate where one critical legislative / tenancy /
-- approval / compliance regression blocks release no matter how good the average
-- is — and nothing calls it. The CI runner loops EvalCase.run() and console.logs
-- {pass, detail}: no AssuranceEvalResult, no EvalProvenance, no persisted
-- provenanceHash, no per-domain criticalFailed, no allowed/blockers decision. So
-- "the evals passed" is a line of build output that disappears with the log.
--
-- The thresholds ACTUALLY USED are stored on the run (thresholds_jsonb) so a later
-- threshold change cannot retroactively rewrite whether a past release was allowed.
--
-- Additive only. CI keeps working with no database — the persistence adapter is a
-- no-op without DATABASE_URL.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- (1) One row per evaluation RUN, keyed by its provenance hash so a re-run of the
--     identical (sha, prompt, compiler, manifest, model, dataset, date) tuple is
--     idempotent rather than duplicating history.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS assurance_eval_run (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  -- CI runs record against the platform/internal tenant.
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  git_sha varchar(80),
  prompt_version varchar(120),
  context_compiler_version varchar(120),
  tool_manifest_hash varchar(128),
  model varchar(160),
  provider varchar(40),
  dataset_version varchar(120),
  run_date timestamptz NOT NULL,
  provenance_hash varchar(64) NOT NULL,
  thresholds_jsonb jsonb NOT NULL,
  baseline_jsonb jsonb,
  candidate_jsonb jsonb,
  allowed boolean NOT NULL,
  blockers_jsonb jsonb NOT NULL DEFAULT '[]',
  warnings_jsonb jsonb NOT NULL DEFAULT '[]',
  -- Sign-off may waive ONLY cost/latency, never a safety or scope invariant —
  -- which is why there is no generic "override" column here.
  cost_latency_signoff_by_user_id uuid,
  cost_latency_signoff_reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS assurance_eval_run_provenance_unique
  ON assurance_eval_run (tenant_id, provenance_hash);
CREATE INDEX IF NOT EXISTS assurance_eval_run_recent_idx
  ON assurance_eval_run (tenant_id, run_date DESC);

ALTER TABLE assurance_eval_run ENABLE ROW LEVEL SECURITY;
ALTER TABLE assurance_eval_run FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS assurance_eval_run_tenant_isolation ON assurance_eval_run;
CREATE POLICY assurance_eval_run_tenant_isolation ON assurance_eval_run
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

-- ---------------------------------------------------------------------------
-- (2) One row per CASE. `case_id` is what an accepted feedback fixture key points
--     at (see 20260811030000), so a regression traces back to the feedback that
--     created its fixture.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS assurance_eval_result (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  eval_run_id uuid NOT NULL REFERENCES assurance_eval_run(id) ON DELETE CASCADE,
  case_id varchar(160) NOT NULL,
  tier varchar(4),
  domain varchar(32) NOT NULL,
  severity varchar(12) NOT NULL,
  passed boolean NOT NULL,
  score double precision,
  threshold double precision,
  metric varchar(48),
  detail text NOT NULL,
  CONSTRAINT assurance_eval_result_tier_check CHECK (
    tier IS NULL OR tier IN ('L0','L1','L2','L3','L4')
  ),
  CONSTRAINT assurance_eval_result_severity_check CHECK (
    severity IN ('critical','high','medium','low')
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS assurance_eval_result_case_unique
  ON assurance_eval_result (eval_run_id, case_id);
CREATE INDEX IF NOT EXISTS assurance_eval_result_domain_idx
  ON assurance_eval_result (tenant_id, domain, passed);

ALTER TABLE assurance_eval_result ENABLE ROW LEVEL SECURITY;
ALTER TABLE assurance_eval_result FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS assurance_eval_result_tenant_isolation ON assurance_eval_result;
CREATE POLICY assurance_eval_result_tenant_isolation ON assurance_eval_result
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

-- ---------------------------------------------------------------------------
-- (3) The CATEGORY-SPECIFIC decision, stored as immutable evidence rather than
--     something re-derived later from (2). Re-derivation would silently change if
--     the summarizer ever changed; the point of this table is that the per-domain
--     verdict at release time is a fact on the record.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS assurance_eval_domain_gate (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  eval_run_id uuid NOT NULL REFERENCES assurance_eval_run(id) ON DELETE CASCADE,
  domain varchar(32) NOT NULL,
  passed integer NOT NULL,
  failed integer NOT NULL,
  critical_failed integer NOT NULL,
  high_failed integer NOT NULL,
  minimum_score double precision,
  blocked boolean NOT NULL,
  blocker_reasons_jsonb jsonb NOT NULL DEFAULT '[]',
  CONSTRAINT assurance_eval_domain_gate_counts_check CHECK (
    passed >= 0 AND failed >= 0 AND critical_failed >= 0 AND high_failed >= 0
    AND critical_failed <= failed AND high_failed <= failed
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS assurance_eval_domain_gate_unique
  ON assurance_eval_domain_gate (eval_run_id, domain);

ALTER TABLE assurance_eval_domain_gate ENABLE ROW LEVEL SECURITY;
ALTER TABLE assurance_eval_domain_gate FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS assurance_eval_domain_gate_tenant_isolation ON assurance_eval_domain_gate;
CREATE POLICY assurance_eval_domain_gate_tenant_isolation ON assurance_eval_domain_gate
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

-- No explicit GRANTs: capiro_app is covered by ALTER DEFAULT PRIVILEGES.
