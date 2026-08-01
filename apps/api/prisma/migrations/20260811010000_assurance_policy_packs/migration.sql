-- ===========================================================================
-- Assurance: PERSISTED compliance policy packs (draft / review / publication /
-- rollback / simulation / selected-version audit).
--
-- WHY. packages/meriv2-core/src/assurance/policy-pack.ts is a complete policy
-- lifecycle that has never had a home: the packs are in-code constants and every
-- lifecycle function (validate/canPublish/publish/rollback/select/evaluate) is
-- pure, so there is no draft, no review record, no publication attribution, no
-- rollback trail, and no record of WHICH pack version bound a given action. The
-- decision that actually runs in production is a different, unversioned in-code
-- ruleset (ruleBasedCompliancePolicy([...PROPOSED_CAPIRO_RULES])).
--
-- SAFETY NOTE. Making packs writable creates a new activation surface for legal
-- rules. Today the "no sample legal rule is activatable" invariant holds partly
-- BECAUSE the packs are immutable constants no route can mutate. The four in-code
-- guards (validatePolicyPack, canPublishPolicyPack, evaluatePolicyPack,
-- selectPolicyPack) therefore become the only defence, so the load-bearing ones
-- are restated below as DB CHECK constraints. DISABLED_LEGAL_POLICY_EXAMPLES must
-- NEVER be seeded.
--
-- Additive only. No backfill, no seed: a seed inside a migration runs as
-- capiro_master, and RLS + FORCE makes such writes silently no-op, so the
-- published seed row is created by application code under a real tenant context.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- (1) The pack itself, one row per (tenant, pack_key, version).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS compliance_policy_pack (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- CompliancePolicyPack.id — the stable key a pack keeps across versions.
  pack_key varchar(120) NOT NULL,
  version varchar(80) NOT NULL,
  jurisdiction varchar(32) NOT NULL DEFAULT 'all',
  status varchar(24) NOT NULL DEFAULT 'draft',
  legal_review_status varchar(40) NOT NULL DEFAULT 'pending',
  authority_jsonb jsonb NOT NULL,
  effective_from timestamptz NOT NULL,
  effective_until timestamptz,
  owner_user_id uuid NOT NULL,
  reviewed_by_user_id uuid,
  reviewed_at timestamptz,
  second_approved_by_user_id uuid,
  second_approved_at timestamptz,
  published_by_user_id uuid,
  published_at timestamptz,
  four_eyes_required boolean NOT NULL DEFAULT true,
  rules_jsonb jsonb NOT NULL DEFAULT '[]',
  fallback_outcome varchar(8) NOT NULL DEFAULT 'WARN',
  -- Fail safe: a pack is non-production until someone deliberately says otherwise.
  non_production boolean NOT NULL DEFAULT true,
  -- policyPackRulesHash(pack): tamper evidence over the decision-bearing rule
  -- material. A rules_jsonb edited outside the review flow no longer matches.
  rules_hash varchar(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT compliance_policy_pack_status_check CHECK (
    status IN ('draft','pending_review','reviewed','published','retired','disabled_example')
  ),
  CONSTRAINT compliance_policy_pack_review_status_check CHECK (
    legal_review_status IN ('not_required_product_policy','pending','approved','rejected')
  ),
  CONSTRAINT compliance_policy_pack_fallback_check CHECK (
    fallback_outcome IN ('PASS','WARN','BLOCK')
  ),
  -- Mirrors validatePolicyPack: a non-production pack cannot be published. This is
  -- the DB restatement of the guard that keeps DISABLED_LEGAL_POLICY_EXAMPLES
  -- inert even if a route were ever wired to publish arbitrary rows.
  CONSTRAINT compliance_policy_pack_non_production_check CHECK (
    NOT (non_production AND status = 'published')
  ),
  -- Mirrors validatePolicyPack: a published pack must carry review + publication
  -- attribution, and its review must be approved or explicitly not-required.
  CONSTRAINT compliance_policy_pack_published_attribution_check CHECK (
    status <> 'published' OR (
      reviewed_by_user_id IS NOT NULL
      AND reviewed_at IS NOT NULL
      AND published_by_user_id IS NOT NULL
      AND published_at IS NOT NULL
      AND legal_review_status IN ('approved','not_required_product_policy')
    )
  ),
  -- Mirrors validatePolicyPack's four-eyes rule: two DISTINCT named reviewers.
  CONSTRAINT compliance_policy_pack_four_eyes_check CHECK (
    NOT four_eyes_required
    OR status IN ('draft','pending_review')
    OR (
      reviewed_by_user_id IS NOT NULL
      AND second_approved_by_user_id IS NOT NULL
      AND reviewed_by_user_id <> second_approved_by_user_id
    )
  ),
  CONSTRAINT compliance_policy_pack_effective_window_check CHECK (
    effective_until IS NULL OR effective_until > effective_from
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS compliance_policy_pack_version_unique
  ON compliance_policy_pack (tenant_id, pack_key, version);
-- AT MOST ONE live version per pack, enforced by the database rather than by
-- whichever code path happens to publish next.
CREATE UNIQUE INDEX IF NOT EXISTS compliance_policy_pack_published_unique
  ON compliance_policy_pack (tenant_id, pack_key)
  WHERE status = 'published';
CREATE INDEX IF NOT EXISTS compliance_policy_pack_lookup_idx
  ON compliance_policy_pack (tenant_id, status, jurisdiction, effective_from DESC);

ALTER TABLE compliance_policy_pack ENABLE ROW LEVEL SECURITY;
ALTER TABLE compliance_policy_pack FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS compliance_policy_pack_tenant_isolation ON compliance_policy_pack;
CREATE POLICY compliance_policy_pack_tenant_isolation ON compliance_policy_pack
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

-- ---------------------------------------------------------------------------
-- (2) Append-only lifecycle ledger. Every transition, including a simulation.
--     There is no UPDATE path: the row IS the evidence.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS compliance_policy_pack_event (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  policy_pack_id uuid NOT NULL REFERENCES compliance_policy_pack(id) ON DELETE CASCADE,
  from_status varchar(24),
  to_status varchar(24),
  action varchar(24) NOT NULL,
  actor_user_id uuid NOT NULL,
  actor_role varchar(32) NOT NULL,
  -- Set on a rollback: which version we rolled back FROM.
  rolled_back_from_pack_id uuid,
  reason text NOT NULL,
  note text,
  metadata_jsonb jsonb NOT NULL DEFAULT '{}',
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT compliance_policy_pack_event_action_check CHECK (
    action IN ('create','submit_review','review','approve','publish','retire','rollback','simulate')
  ),
  -- Bounded: this ledger is evidence, not a place to smuggle a payload dump.
  CONSTRAINT compliance_policy_pack_event_metadata_size_check CHECK (
    octet_length(metadata_jsonb::text) <= 8192
  )
);
CREATE INDEX IF NOT EXISTS compliance_policy_pack_event_pack_idx
  ON compliance_policy_pack_event (tenant_id, policy_pack_id, occurred_at DESC);

ALTER TABLE compliance_policy_pack_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE compliance_policy_pack_event FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS compliance_policy_pack_event_tenant_isolation ON compliance_policy_pack_event;
CREATE POLICY compliance_policy_pack_event_tenant_isolation ON compliance_policy_pack_event
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

-- ---------------------------------------------------------------------------
-- (3) The SELECTED-VERSION audit: which pack version, and which rule inside it,
--     bound a specific action. Without this there is no way to answer "what
--     policy actually applied on that date" after a pack is republished.
--     policy_pack_id is NULLABLE on purpose so a no-pack-selected fail-safe
--     decision is still recorded rather than silently unlogged.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS compliance_policy_decision (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  policy_pack_id uuid REFERENCES compliance_policy_pack(id) ON DELETE SET NULL,
  pack_key varchar(120),
  pack_version varchar(80),
  rule_id varchar(120),
  outcome varchar(8) NOT NULL,
  code varchar(48),
  tier varchar(16),
  simulated boolean NOT NULL DEFAULT false,
  -- proposalPolicyBinding(decision): pack@version:rule, so the binding survives
  -- even if the pack row is later deleted.
  binding varchar(280) NOT NULL,
  tool varchar(80) NOT NULL,
  channel varchar(24) NOT NULL,
  recipient_type varchar(24),
  actor_user_id uuid NOT NULL,
  actor_role varchar(32) NOT NULL,
  client_id uuid,
  jurisdiction varchar(32) NOT NULL,
  meri_action_proposal_id uuid,
  reason text NOT NULL,
  decided_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT compliance_policy_decision_outcome_check CHECK (
    outcome IN ('PASS','WARN','BLOCK')
  )
);
CREATE INDEX IF NOT EXISTS compliance_policy_decision_recent_idx
  ON compliance_policy_decision (tenant_id, decided_at DESC);
CREATE INDEX IF NOT EXISTS compliance_policy_decision_version_idx
  ON compliance_policy_decision (tenant_id, pack_key, pack_version);

ALTER TABLE compliance_policy_decision ENABLE ROW LEVEL SECURITY;
ALTER TABLE compliance_policy_decision FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS compliance_policy_decision_tenant_isolation ON compliance_policy_decision;
CREATE POLICY compliance_policy_decision_tenant_isolation ON compliance_policy_decision
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

-- No explicit GRANTs: capiro_app is covered by ALTER DEFAULT PRIVILEGES.
