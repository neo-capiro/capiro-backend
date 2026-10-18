-- Run-bound read delegation, RC1 option B (D016-A item 4), reserved and NOT applied.
-- Contract: meri-greenfield docs/coordination/proposals/FABLE-RUN-BOUND-READ-DELEGATION-20261018.md
-- revision 3, §11.1, with Core's review changes (each noted below):
--   * tenant_id on slots and tokens, and RLS on all four tables (Core convention);
--   * tokens store the canonical request digest (§10 lost-response lookup) and their tenant;
--   * UPDATE is granted per column (state, counters, consumption) instead of whole-table UPDATE;
--   * no DELETE (expiry sweeping is a later, separate migration).
-- Snapshot first. Rollback is DROP TABLE of these four tables (they hold no other data).

CREATE TABLE "meri_read_delegation_consents" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "client_id" UUID NOT NULL,
  "schedule_id" UUID NOT NULL,
  "schedule_projection_sha256" CHAR(64) NOT NULL,
  "operations_digest" CHAR(64) NOT NULL,
  "policy_revision" CHAR(64) NOT NULL,
  "state" TEXT NOT NULL,
  "supersedes" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "meri_read_delegation_consents_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "meri_read_delegation_consents_supersedes_fkey" FOREIGN KEY ("supersedes") REFERENCES "meri_read_delegation_consents" ("id"),
  CONSTRAINT "meri_read_delegation_consents_state_check" CHECK ("state" IN ('active', 'paused', 'revoked', 'superseded', 'expired')),
  CONSTRAINT "meri_read_delegation_consents_window_check" CHECK ("expires_at" > "created_at" AND "expires_at" <= "created_at" + INTERVAL '30 days'),
  CONSTRAINT "meri_read_delegation_consents_sha_check" CHECK (
    "schedule_projection_sha256" ~ '^[0-9a-f]{64}$' AND "operations_digest" ~ '^[0-9a-f]{64}$' AND "policy_revision" ~ '^[0-9a-f]{64}$')
);
CREATE UNIQUE INDEX "meri_read_consent_active" ON "meri_read_delegation_consents" ("tenant_id", "schedule_id") WHERE "state" = 'active';

CREATE TABLE "meri_read_delegations" (
  "id" UUID NOT NULL,
  "idempotency_key" CHAR(64) NOT NULL,
  "mode" TEXT NOT NULL,
  "tenant_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "membership_id" UUID NOT NULL,
  "client_id" UUID NOT NULL,
  "conversation_id" UUID NOT NULL,
  "run_id" UUID NOT NULL,
  "attempt_id" UUID NOT NULL,
  "writer_fence" INTEGER NOT NULL,
  -- Core review: Meri's budget attempt and fence are worker integers, not the run binding's attemptId/writerFence.
  -- Core pins the values the facts view showed at creation and refuses any later change (a new worker attempt).
  "budget_attempt" INTEGER NOT NULL,
  "budget_fence" INTEGER NOT NULL,
  "budget_policy_revision" CHAR(64) NOT NULL,
  "allocation_sha256" CHAR(64) NOT NULL,
  "operations_digest" CHAR(64) NOT NULL,
  "policy_revision" CHAR(64) NOT NULL,
  "consent_id" UUID,
  "occurrence_key" CHAR(64),
  "revision" INTEGER NOT NULL DEFAULT 1,
  "state" TEXT NOT NULL,
  "supersedes" UUID,
  "revoked_reason" TEXT,
  "issued_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "meri_read_delegations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "meri_read_delegations_consent_fkey" FOREIGN KEY ("consent_id") REFERENCES "meri_read_delegation_consents" ("id"),
  CONSTRAINT "meri_read_delegations_supersedes_fkey" FOREIGN KEY ("supersedes") REFERENCES "meri_read_delegations" ("id"),
  CONSTRAINT "meri_read_delegations_mode_check" CHECK ("mode" IN ('attended', 'unattended')),
  CONSTRAINT "meri_read_delegations_state_check" CHECK ("state" IN ('active', 'superseded', 'revoked', 'expired')),
  CONSTRAINT "meri_read_delegations_fence_check" CHECK ("writer_fence" > 0 AND "budget_attempt" > 0 AND "budget_fence" > 0 AND "revision" >= 1),
  CONSTRAINT "meri_read_delegations_sha_check" CHECK (
    "idempotency_key" ~ '^[0-9a-f]{64}$' AND "allocation_sha256" ~ '^[0-9a-f]{64}$' AND "operations_digest" ~ '^[0-9a-f]{64}$'
    AND "policy_revision" ~ '^[0-9a-f]{64}$' AND "budget_policy_revision" ~ '^[0-9a-f]{64}$' AND ("occurrence_key" IS NULL OR "occurrence_key" ~ '^[0-9a-f]{64}$')),
  -- D016-A item 4: attended <= 30 min total from issuance; unattended <= 15 min per occurrence.
  CONSTRAINT "meri_read_delegations_bound_check" CHECK (
    ("mode" = 'attended' AND "consent_id" IS NULL AND "occurrence_key" IS NULL AND "expires_at" <= "issued_at" + INTERVAL '30 minutes')
    OR ("mode" = 'unattended' AND "consent_id" IS NOT NULL AND "occurrence_key" IS NOT NULL AND "expires_at" <= "issued_at" + INTERVAL '15 minutes')),
  CONSTRAINT "meri_read_delegations_expiry_check" CHECK ("expires_at" > "issued_at")
);
CREATE UNIQUE INDEX "meri_read_delegation_idem" ON "meri_read_delegations" ("idempotency_key") WHERE "state" = 'active';
CREATE UNIQUE INDEX "meri_read_delegation_occurrence" ON "meri_read_delegations" ("tenant_id", "occurrence_key") WHERE "occurrence_key" IS NOT NULL;
CREATE INDEX "meri_read_delegations_run_idx" ON "meri_read_delegations" ("tenant_id", "run_id");

CREATE TABLE "meri_read_delegation_slots" (
  "run_id" UUID NOT NULL,
  "call_key" VARCHAR(128) NOT NULL,
  "tenant_id" UUID NOT NULL,
  "delegation_id" UUID NOT NULL,
  "tool_tokens" SMALLINT NOT NULL DEFAULT 0,
  "mode_tokens" SMALLINT NOT NULL DEFAULT 0,
  "reference_tokens" SMALLINT NOT NULL DEFAULT 0,
  "current_tokens" SMALLINT NOT NULL DEFAULT 0,
  "reissues" SMALLINT NOT NULL DEFAULT 0,
  "opened_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "meri_read_delegation_slots_pkey" PRIMARY KEY ("run_id", "call_key"),
  CONSTRAINT "meri_read_delegation_slots_delegation_fkey" FOREIGN KEY ("delegation_id") REFERENCES "meri_read_delegations" ("id"),
  CONSTRAINT "meri_read_delegation_slots_call_key_check" CHECK ("call_key" ~ '^[A-Za-z0-9_-]{1,128}$'),
  -- Per-slot ceilings (contract §5, Meri contract.mjs readTokenCeilings): tool 1, mode 7, reference 7, current 35.
  CONSTRAINT "meri_read_delegation_slots_tool_check" CHECK ("tool_tokens" BETWEEN 0 AND 1),
  CONSTRAINT "meri_read_delegation_slots_mode_check" CHECK ("mode_tokens" BETWEEN 0 AND 7),
  CONSTRAINT "meri_read_delegation_slots_reference_check" CHECK ("reference_tokens" BETWEEN 0 AND 7),
  CONSTRAINT "meri_read_delegation_slots_current_check" CHECK ("current_tokens" BETWEEN 0 AND 35),
  -- At most 2 lost-response re-issues per kind (4 kinds).
  CONSTRAINT "meri_read_delegation_slots_reissues_check" CHECK ("reissues" BETWEEN 0 AND 8)
);

CREATE TABLE "meri_read_tokens" (
  "jti" UUID NOT NULL,
  "token_sha256" CHAR(64) NOT NULL,
  "tenant_id" UUID NOT NULL,
  "delegation_id" UUID NOT NULL,
  "run_id" UUID NOT NULL,
  "call_key" VARCHAR(128) NOT NULL,
  "kind" TEXT NOT NULL,
  "target_method" TEXT NOT NULL,
  "target_path" TEXT NOT NULL,
  "body_sha256" CHAR(64) NOT NULL,
  -- Core review: a `tool` token keeps its reservation's arguments hash, so use re-checks Meri's UNKNOWN reservation.
  "arguments_sha256" CHAR(64),
  "request_digest" CHAR(64) NOT NULL,
  "issued_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  "consumed_at" TIMESTAMPTZ(6),
  "superseded_at" TIMESTAMPTZ(6),
  CONSTRAINT "meri_read_tokens_pkey" PRIMARY KEY ("jti"),
  CONSTRAINT "meri_read_tokens_token_sha256_key" UNIQUE ("token_sha256"),
  CONSTRAINT "meri_read_tokens_delegation_fkey" FOREIGN KEY ("delegation_id") REFERENCES "meri_read_delegations" ("id"),
  CONSTRAINT "meri_read_tokens_slot_fkey" FOREIGN KEY ("run_id", "call_key") REFERENCES "meri_read_delegation_slots" ("run_id", "call_key"),
  CONSTRAINT "meri_read_tokens_kind_check" CHECK ("kind" IN ('tool', 'mode', 'reference', 'current')),
  CONSTRAINT "meri_read_tokens_method_check" CHECK ("target_method" = 'POST'),
  CONSTRAINT "meri_read_tokens_expiry_check" CHECK ("expires_at" > "issued_at" AND "expires_at" <= "issued_at" + INTERVAL '60 seconds'),
  CONSTRAINT "meri_read_tokens_use_check" CHECK ("consumed_at" IS NULL OR "superseded_at" IS NULL),
  CONSTRAINT "meri_read_tokens_arguments_check" CHECK (("kind" = 'tool') = ("arguments_sha256" IS NOT NULL)
    AND ("arguments_sha256" IS NULL OR "arguments_sha256" ~ '^[0-9a-f]{64}$')),
  CONSTRAINT "meri_read_tokens_sha_check" CHECK (
    "token_sha256" ~ '^[0-9a-f]{64}$' AND "body_sha256" ~ '^[0-9a-f]{64}$' AND "request_digest" ~ '^[0-9a-f]{64}$')
);
CREATE INDEX "meri_read_tokens_expiry" ON "meri_read_tokens" ("expires_at") WHERE "consumed_at" IS NULL AND "superseded_at" IS NULL;
CREATE INDEX "meri_read_tokens_retry_idx" ON "meri_read_tokens" ("run_id", "call_key", "kind", "request_digest");

ALTER TABLE "meri_read_delegation_consents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "meri_read_delegation_consents" FORCE ROW LEVEL SECURITY;
CREATE POLICY "meri_read_delegation_consents_isolation" ON "meri_read_delegation_consents"
  USING (rls_bypass() OR tenant_id = current_tenant_id()) WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());
ALTER TABLE "meri_read_delegations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "meri_read_delegations" FORCE ROW LEVEL SECURITY;
CREATE POLICY "meri_read_delegations_isolation" ON "meri_read_delegations"
  USING (rls_bypass() OR tenant_id = current_tenant_id()) WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());
ALTER TABLE "meri_read_delegation_slots" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "meri_read_delegation_slots" FORCE ROW LEVEL SECURITY;
CREATE POLICY "meri_read_delegation_slots_isolation" ON "meri_read_delegation_slots"
  USING (rls_bypass() OR tenant_id = current_tenant_id()) WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());
ALTER TABLE "meri_read_tokens" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "meri_read_tokens" FORCE ROW LEVEL SECURITY;
CREATE POLICY "meri_read_tokens_isolation" ON "meri_read_tokens"
  USING (rls_bypass() OR tenant_id = current_tenant_id()) WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_app') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON "meri_read_delegation_consents", "meri_read_delegations",
      "meri_read_delegation_slots", "meri_read_tokens" FROM capiro_app;
    GRANT SELECT, INSERT ON "meri_read_delegation_consents", "meri_read_delegations",
      "meri_read_delegation_slots", "meri_read_tokens" TO capiro_app;
    GRANT UPDATE ("state") ON "meri_read_delegation_consents" TO capiro_app;
    GRANT UPDATE ("state", "revoked_reason") ON "meri_read_delegations" TO capiro_app;
    GRANT UPDATE ("tool_tokens", "mode_tokens", "reference_tokens", "current_tokens", "reissues") ON "meri_read_delegation_slots" TO capiro_app;
    GRANT UPDATE ("consumed_at", "superseded_at") ON "meri_read_tokens" TO capiro_app;
  END IF;
END $$;
