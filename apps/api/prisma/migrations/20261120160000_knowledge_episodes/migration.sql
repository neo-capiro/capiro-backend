-- Capiro Knowledge Plane — Phase 7 deterministic Knowledge Episodes.
--
-- Episodes are a DERIVED, MATERIALIZED projection over KnowledgeEvent,
-- KnowledgeAssertion, and canonical entities. This migration creates no new
-- source of truth, no second graph/relationship-history/evidence store, and
-- no event ledger: every membership row is a pointer back to the exact
-- authoritative row it groups (event/assertion/canonical entity), and
-- dropping the episode tables loses only the grouping, never the underlying
-- knowledge.
--
-- The first grouping strategy is deterministic mailbox-thread identity
-- ('mailbox_thread_v1'). `strategy` is a checked, extensible column so a
-- later phase can add topic/time/program/bill/PE strategies without a schema
-- change — this migration does not implement any of those.
--
-- IMPORTANT rollout property: this migration intentionally does NOT backfill
-- historical KnowledgeEvents into episodes. Phase 7 proves the live path
-- first; historical episode backfill remains a later, separately controlled,
-- resumable/idempotent/rate-limited/dry-run-capable operation.

CREATE TABLE "knowledge_episodes" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
  "tenant_id" UUID NOT NULL,
  "strategy" VARCHAR(32) NOT NULL,
  -- SHA-256 hex of the canonicalized grouping key (tenant, connection,
  -- provider thread id, sensitivity, access-scope digest, client-ref SET).
  -- Never the raw provider thread id or account email alone.
  "identity_key" VARCHAR(64) NOT NULL,
  "status" VARCHAR(16) NOT NULL DEFAULT 'open',

  -- Exact inherited security partition. An episode's sensitivity/access_scope
  -- is fixed at creation from its first member KnowledgeEvent and can never
  -- be widened afterward — every later member is required (by trigger, not
  -- just application code) to match exactly.
  "sensitivity" VARCHAR(96) NOT NULL,
  "access_scope" JSONB NOT NULL,
  -- Canonicalized (order/duplicate independent) client refs, denormalized
  -- from the founding event purely for read convenience; the identity_key
  -- hash — not this column — is the actual grouping identity.
  "client_refs" JSONB NOT NULL DEFAULT '[]',
  -- The exact MailboxThreadEpisodeGroupingKey (or a later strategy's
  -- equivalent) that hashed to identity_key. Never contains a raw account
  -- email or source message/thread text.
  "grouping_key" JSONB NOT NULL,

  "event_count" INTEGER NOT NULL DEFAULT 0,
  "assertion_count" INTEGER NOT NULL DEFAULT 0,
  "entity_count" INTEGER NOT NULL DEFAULT 0,
  "first_event_at" TIMESTAMPTZ(6) NOT NULL,
  "last_event_at" TIMESTAMPTZ(6) NOT NULL,
  "metadata" JSONB NOT NULL DEFAULT '{}',

  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "knowledge_episodes_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "knowledge_episodes_tenant_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "knowledge_episodes_identity_unique"
    UNIQUE ("tenant_id", "strategy", "identity_key"),
  CONSTRAINT "knowledge_episodes_strategy_check"
    CHECK ("strategy" IN ('mailbox_thread_v1')),
  CONSTRAINT "knowledge_episodes_status_check"
    CHECK ("status" IN ('open', 'closed')),
  CONSTRAINT "knowledge_episodes_identity_key_check"
    CHECK ("identity_key" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "knowledge_episodes_sensitivity_check"
    CHECK ("sensitivity" ~ '^[a-z][a-z0-9_]{0,95}$'),
  CONSTRAINT "knowledge_episodes_access_scope_check"
    CHECK (jsonb_typeof("access_scope") = 'object'),
  CONSTRAINT "knowledge_episodes_client_refs_check"
    CHECK (jsonb_typeof("client_refs") = 'array'),
  CONSTRAINT "knowledge_episodes_grouping_key_check"
    CHECK (jsonb_typeof("grouping_key") = 'object'),
  CONSTRAINT "knowledge_episodes_counts_check"
    CHECK ("event_count" >= 0 AND "assertion_count" >= 0 AND "entity_count" >= 0),
  CONSTRAINT "knowledge_episodes_temporal_check"
    CHECK ("last_event_at" >= "first_event_at")
);

CREATE INDEX "knowledge_episodes_tenant_last_event_idx"
  ON "knowledge_episodes" ("tenant_id", "last_event_at" DESC, "id" DESC);
CREATE INDEX "knowledge_episodes_client_refs_gin"
  ON "knowledge_episodes" USING GIN ("client_refs");

ALTER TABLE "knowledge_episodes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "knowledge_episodes" FORCE ROW LEVEL SECURITY;
CREATE POLICY "knowledge_episodes_tenant_isolation"
  ON "knowledge_episodes"
  USING (rls_bypass() OR "tenant_id" = current_tenant_id())
  WITH CHECK (rls_bypass() OR "tenant_id" = current_tenant_id());

-- Episodes are append/update-in-place derived state (counts, timestamps,
-- status), never destructively removed by ordinary application code. The
-- only deletion path is the existing trusted tenant-cascade purge above.
REVOKE DELETE, TRUNCATE ON TABLE "knowledge_episodes" FROM capiro_app;
GRANT SELECT, INSERT, UPDATE ON TABLE "knowledge_episodes" TO capiro_app;

COMMENT ON TABLE "knowledge_episodes" IS
  'Phase 7 derived/materialized grouping over KnowledgeEvent/KnowledgeAssertion/canonical entities. Not a source of truth; no historical backfill performed by this migration.';
COMMENT ON COLUMN "knowledge_episodes"."identity_key" IS
  'SHA-256 of the canonicalized grouping key. Client refs are canonicalized as an order/duplicate-independent set before hashing.';

-- ---------------------------------------------------------------------------
-- knowledge_episode_events — append-only KnowledgeEvent membership.
-- ---------------------------------------------------------------------------

CREATE TABLE "knowledge_episode_events" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
  "tenant_id" UUID NOT NULL,
  "episode_id" UUID NOT NULL,
  "event_id" UUID NOT NULL,
  -- Denormalized copy of the member event's occurredAt, used only to
  -- maintain knowledge_episodes.first_event_at/last_event_at without an
  -- extra join. KnowledgeEvent remains authoritative for this value.
  "occurred_at" TIMESTAMPTZ(6) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "knowledge_episode_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "knowledge_episode_events_tenant_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "knowledge_episode_events_episode_fkey"
    FOREIGN KEY ("episode_id") REFERENCES "knowledge_episodes"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "knowledge_episode_events_event_fkey"
    FOREIGN KEY ("event_id") REFERENCES "knowledge_events"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  -- Idempotent membership: replaying the same projection job cannot insert a
  -- duplicate membership row.
  CONSTRAINT "knowledge_episode_events_membership_unique"
    UNIQUE ("tenant_id", "episode_id", "event_id"),
  -- This narrow deterministic strategy assigns each event to exactly one
  -- episode. A later fuzzy/multi-membership strategy is an explicit,
  -- separately-designed Phase 8+ change, not a relaxation of this table.
  CONSTRAINT "knowledge_episode_events_event_unique"
    UNIQUE ("tenant_id", "event_id")
);

CREATE INDEX "knowledge_episode_events_episode_idx"
  ON "knowledge_episode_events" ("tenant_id", "episode_id", "occurred_at" DESC);

CREATE OR REPLACE FUNCTION enforce_knowledge_episode_event_links()
RETURNS trigger AS $$
DECLARE
  v_episode_tenant UUID;
  v_episode_sensitivity TEXT;
  v_episode_access_scope JSONB;
  v_event_tenant UUID;
  v_event_status TEXT;
  v_event_sensitivity TEXT;
  v_event_access_scope JSONB;
BEGIN
  SELECT tenant_id, sensitivity, access_scope
  INTO v_episode_tenant, v_episode_sensitivity, v_episode_access_scope
  FROM knowledge_episodes
  WHERE id = NEW.episode_id;

  IF v_episode_tenant IS NULL OR v_episode_tenant <> NEW.tenant_id THEN
    RAISE EXCEPTION 'Episode membership must reference an episode in the same tenant'
      USING ERRCODE = '23503';
  END IF;

  SELECT tenant_id, status, sensitivity, access_scope
  INTO v_event_tenant, v_event_status, v_event_sensitivity, v_event_access_scope
  FROM knowledge_events
  WHERE id = NEW.event_id;

  IF v_event_tenant IS NULL OR v_event_tenant <> NEW.tenant_id THEN
    RAISE EXCEPTION 'Episode event membership must reference a KnowledgeEvent in the same tenant'
      USING ERRCODE = '23503';
  END IF;
  IF v_event_status <> 'active' THEN
    RAISE EXCEPTION 'Episode event membership requires an active KnowledgeEvent'
      USING ERRCODE = '23514';
  END IF;
  -- Grouping must never widen access: every member event's exact
  -- sensitivity/access_scope must match the episode's inherited scope.
  IF v_event_sensitivity IS DISTINCT FROM v_episode_sensitivity
     OR v_event_access_scope IS DISTINCT FROM v_episode_access_scope THEN
    RAISE EXCEPTION 'Episode member KnowledgeEvent scope must exactly match the episode scope'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "knowledge_episode_events_enforce_links"
  BEFORE INSERT ON "knowledge_episode_events"
  FOR EACH ROW EXECUTE FUNCTION enforce_knowledge_episode_event_links();

ALTER TABLE "knowledge_episode_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "knowledge_episode_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY "knowledge_episode_events_tenant_isolation"
  ON "knowledge_episode_events"
  USING (rls_bypass() OR "tenant_id" = current_tenant_id())
  WITH CHECK (rls_bypass() OR "tenant_id" = current_tenant_id());

-- Append-only: no UPDATE/DELETE/TRUNCATE from the application role. The only
-- removal path is the trusted tenant-cascade purge (FK above).
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "knowledge_episode_events" FROM capiro_app;
GRANT SELECT, INSERT ON TABLE "knowledge_episode_events" TO capiro_app;

COMMENT ON TABLE "knowledge_episode_events" IS
  'Append-only KnowledgeEvent membership in a Phase 7 episode. KnowledgeEvent remains authoritative.';

-- ---------------------------------------------------------------------------
-- knowledge_episode_assertions — append-only KnowledgeAssertion membership.
-- ---------------------------------------------------------------------------

CREATE TABLE "knowledge_episode_assertions" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
  "tenant_id" UUID NOT NULL,
  "episode_id" UUID NOT NULL,
  "assertion_id" UUID NOT NULL,
  "origin_event_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "knowledge_episode_assertions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "knowledge_episode_assertions_tenant_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "knowledge_episode_assertions_episode_fkey"
    FOREIGN KEY ("episode_id") REFERENCES "knowledge_episodes"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "knowledge_episode_assertions_assertion_fkey"
    FOREIGN KEY ("assertion_id") REFERENCES "knowledge_assertions"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "knowledge_episode_assertions_origin_event_fkey"
    FOREIGN KEY ("origin_event_id") REFERENCES "knowledge_events"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "knowledge_episode_assertions_membership_unique"
    UNIQUE ("tenant_id", "episode_id", "assertion_id"),
  -- An assertion's episode is fully determined by its immutable origin
  -- event, so it can belong to at most one episode under this strategy.
  CONSTRAINT "knowledge_episode_assertions_assertion_unique"
    UNIQUE ("tenant_id", "assertion_id")
);

CREATE INDEX "knowledge_episode_assertions_episode_idx"
  ON "knowledge_episode_assertions" ("tenant_id", "episode_id", "created_at" DESC);
CREATE INDEX "knowledge_episode_assertions_origin_event_idx"
  ON "knowledge_episode_assertions" ("tenant_id", "origin_event_id");

CREATE OR REPLACE FUNCTION enforce_knowledge_episode_assertion_links()
RETURNS trigger AS $$
DECLARE
  v_episode_tenant UUID;
  v_episode_sensitivity TEXT;
  v_episode_access_scope JSONB;
  v_assertion_tenant UUID;
  v_assertion_origin_event UUID;
  v_assertion_sensitivity TEXT;
  v_assertion_access_scope JSONB;
BEGIN
  SELECT tenant_id, sensitivity, access_scope
  INTO v_episode_tenant, v_episode_sensitivity, v_episode_access_scope
  FROM knowledge_episodes
  WHERE id = NEW.episode_id;

  IF v_episode_tenant IS NULL OR v_episode_tenant <> NEW.tenant_id THEN
    RAISE EXCEPTION 'Episode assertion membership must reference an episode in the same tenant'
      USING ERRCODE = '23503';
  END IF;

  SELECT tenant_id, origin_event_id, sensitivity, access_scope
  INTO v_assertion_tenant, v_assertion_origin_event, v_assertion_sensitivity, v_assertion_access_scope
  FROM knowledge_assertions
  WHERE id = NEW.assertion_id;

  IF v_assertion_tenant IS NULL OR v_assertion_tenant <> NEW.tenant_id THEN
    RAISE EXCEPTION 'Episode assertion membership must reference a KnowledgeAssertion in the same tenant'
      USING ERRCODE = '23503';
  END IF;
  IF v_assertion_origin_event IS DISTINCT FROM NEW.origin_event_id THEN
    RAISE EXCEPTION 'Episode assertion membership origin_event_id must match the assertion''s own origin event'
      USING ERRCODE = '23514';
  END IF;
  IF v_assertion_sensitivity IS DISTINCT FROM v_episode_sensitivity
     OR v_assertion_access_scope IS DISTINCT FROM v_episode_access_scope THEN
    RAISE EXCEPTION 'Episode member KnowledgeAssertion scope must exactly match the episode scope'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "knowledge_episode_assertions_enforce_links"
  BEFORE INSERT ON "knowledge_episode_assertions"
  FOR EACH ROW EXECUTE FUNCTION enforce_knowledge_episode_assertion_links();

ALTER TABLE "knowledge_episode_assertions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "knowledge_episode_assertions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "knowledge_episode_assertions_tenant_isolation"
  ON "knowledge_episode_assertions"
  USING (rls_bypass() OR "tenant_id" = current_tenant_id())
  WITH CHECK (rls_bypass() OR "tenant_id" = current_tenant_id());

REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "knowledge_episode_assertions" FROM capiro_app;
GRANT SELECT, INSERT ON TABLE "knowledge_episode_assertions" TO capiro_app;

COMMENT ON TABLE "knowledge_episode_assertions" IS
  'Append-only KnowledgeAssertion membership in a Phase 7 episode. KnowledgeAssertion remains authoritative.';

-- ---------------------------------------------------------------------------
-- knowledge_episode_entities — append-only canonical entity membership.
-- ---------------------------------------------------------------------------

CREATE TABLE "knowledge_episode_entities" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
  "tenant_id" UUID NOT NULL,
  "episode_id" UUID NOT NULL,
  "canonical_entity_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "knowledge_episode_entities_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "knowledge_episode_entities_tenant_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "knowledge_episode_entities_episode_fkey"
    FOREIGN KEY ("episode_id") REFERENCES "knowledge_episodes"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  -- Phase 7 reuses Phase 5 canonical entity IDs; it never creates or resolves
  -- entities of its own. Cascade matches the tenant_id FK above so a trusted
  -- tenant purge removes membership rows together with tenant-scoped
  -- entities; a tenant-scoped canonical entity is never deleted outside that
  -- purge path today (merge/terminal-lifecycle mutate status, they do not
  -- delete rows).
  CONSTRAINT "knowledge_episode_entities_entity_fkey"
    FOREIGN KEY ("canonical_entity_id") REFERENCES "canonical_entities"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "knowledge_episode_entities_membership_unique"
    UNIQUE ("tenant_id", "episode_id", "canonical_entity_id")
);

CREATE INDEX "knowledge_episode_entities_episode_idx"
  ON "knowledge_episode_entities" ("tenant_id", "episode_id");
CREATE INDEX "knowledge_episode_entities_entity_idx"
  ON "knowledge_episode_entities" ("tenant_id", "canonical_entity_id");

CREATE OR REPLACE FUNCTION enforce_knowledge_episode_entity_links()
RETURNS trigger AS $$
DECLARE
  v_episode_tenant UUID;
BEGIN
  SELECT tenant_id INTO v_episode_tenant
  FROM knowledge_episodes
  WHERE id = NEW.episode_id;

  IF v_episode_tenant IS NULL OR v_episode_tenant <> NEW.tenant_id THEN
    RAISE EXCEPTION 'Episode entity membership must reference an episode in the same tenant'
      USING ERRCODE = '23503';
  END IF;

  -- canonical_entities.tenant_id may legitimately be NULL (global identity
  -- scope) or equal to NEW.tenant_id (tenant-private identity scope); it may
  -- never belong to a DIFFERENT tenant.
  IF EXISTS (
    SELECT 1 FROM canonical_entities
    WHERE id = NEW.canonical_entity_id
      AND tenant_id IS NOT NULL
      AND tenant_id <> NEW.tenant_id
  ) THEN
    RAISE EXCEPTION 'Episode entity membership cannot reference a canonical entity owned by another tenant'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "knowledge_episode_entities_enforce_links"
  BEFORE INSERT ON "knowledge_episode_entities"
  FOR EACH ROW EXECUTE FUNCTION enforce_knowledge_episode_entity_links();

ALTER TABLE "knowledge_episode_entities" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "knowledge_episode_entities" FORCE ROW LEVEL SECURITY;
CREATE POLICY "knowledge_episode_entities_tenant_isolation"
  ON "knowledge_episode_entities"
  USING (rls_bypass() OR "tenant_id" = current_tenant_id())
  WITH CHECK (rls_bypass() OR "tenant_id" = current_tenant_id());

REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "knowledge_episode_entities" FROM capiro_app;
GRANT SELECT, INSERT ON TABLE "knowledge_episode_entities" TO capiro_app;

COMMENT ON TABLE "knowledge_episode_entities" IS
  'Append-only canonical entity membership in a Phase 7 episode. Reuses Phase 5 canonical_entities; performs no resolution of its own.';

-- ---------------------------------------------------------------------------
-- knowledge_episode_projection_jobs — durable, tenant-scoped projection queue.
-- ---------------------------------------------------------------------------

CREATE TABLE "knowledge_episode_projection_jobs" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
  "tenant_id" UUID NOT NULL,
  "event_id" UUID NOT NULL,

  "status" VARCHAR(24) NOT NULL DEFAULT 'pending',
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "available_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "locked_at" TIMESTAMPTZ(6),
  "locked_by" VARCHAR(160),
  "last_error" TEXT,
  -- Set once an episode has been assigned; NULL while pending/failed/skipped
  -- for a reason that produced no episode.
  "episode_id" UUID,

  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "knowledge_episode_projection_jobs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "knowledge_episode_projection_jobs_tenant_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "knowledge_episode_projection_jobs_event_fkey"
    FOREIGN KEY ("event_id") REFERENCES "knowledge_events"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "knowledge_episode_projection_jobs_episode_fkey"
    FOREIGN KEY ("episode_id") REFERENCES "knowledge_episodes"("id")
    ON DELETE SET NULL ON UPDATE CASCADE,
  -- Exactly one projection job per event: trigger-driven enqueue is
  -- idempotent under replay via ON CONFLICT DO NOTHING against this.
  CONSTRAINT "knowledge_episode_projection_jobs_event_unique"
    UNIQUE ("tenant_id", "event_id"),
  CONSTRAINT "knowledge_episode_projection_jobs_status_check"
    CHECK ("status" IN (
      'pending', 'processing', 'succeeded', 'skipped', 'failed', 'dead_letter'
    )),
  CONSTRAINT "knowledge_episode_projection_jobs_attempt_check"
    CHECK ("attempt_count" >= 0 AND "attempt_count" <= 100),
  CONSTRAINT "knowledge_episode_projection_jobs_lock_state_check"
    CHECK (
      ("status" = 'processing' AND "locked_at" IS NOT NULL AND "locked_by" IS NOT NULL)
      OR
      ("status" <> 'processing' AND "locked_at" IS NULL AND "locked_by" IS NULL)
    ),
  CONSTRAINT "knowledge_episode_projection_jobs_episode_state_check"
    CHECK (
      ("status" = 'succeeded' AND "episode_id" IS NOT NULL)
      OR
      ("status" <> 'succeeded')
    )
);

CREATE INDEX "knowledge_episode_projection_jobs_due_idx"
  ON "knowledge_episode_projection_jobs" ("status", "available_at", "created_at", "id")
  WHERE "status" IN ('pending', 'failed', 'processing');
CREATE INDEX "knowledge_episode_projection_jobs_tenant_event_idx"
  ON "knowledge_episode_projection_jobs" ("tenant_id", "event_id");

ALTER TABLE "knowledge_episode_projection_jobs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "knowledge_episode_projection_jobs" FORCE ROW LEVEL SECURITY;
CREATE POLICY "knowledge_episode_projection_jobs_tenant_isolation"
  ON "knowledge_episode_projection_jobs"
  USING (rls_bypass() OR "tenant_id" = current_tenant_id())
  WITH CHECK (rls_bypass() OR "tenant_id" = current_tenant_id());

-- Operational queue state is mutable (claim/complete/fail transitions), but
-- application code cannot destructively delete the queue/audit trail. The
-- only deletion path is the existing trusted tenant-cascade purge above.
REVOKE DELETE, TRUNCATE ON TABLE "knowledge_episode_projection_jobs" FROM capiro_app;
GRANT SELECT, INSERT, UPDATE ON TABLE "knowledge_episode_projection_jobs" TO capiro_app;

COMMENT ON TABLE "knowledge_episode_projection_jobs" IS
  'Phase 7 durable, tenant-scoped queue projecting live active KnowledgeEvents into episodes. Live-only; this migration performs no historical enqueue.';

-- ---------------------------------------------------------------------------
-- Enqueue trigger — fires off the SAME Phase 4 success condition Phase 6
-- already uses, independently of Phase 6/extraction being enabled. This
-- keeps Phase 7 projection available even when Phase 6 extraction stays
-- permanently disabled, and guarantees no historical sweep: only a live
-- transition of knowledge_mailbox_jobs into ('succeeded' with a result
-- event) enqueues a row.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION enqueue_knowledge_episode_projection_job()
RETURNS trigger AS $$
BEGIN
  IF NEW.status <> 'succeeded'
     OR NEW.result_event_id IS NULL
     OR NEW.processed_content_hash IS NULL THEN
    RETURN NEW;
  END IF;

  INSERT INTO knowledge_episode_projection_jobs (
    tenant_id,
    event_id,
    status,
    available_at
  )
  VALUES (
    NEW.tenant_id,
    NEW.result_event_id,
    'pending',
    CURRENT_TIMESTAMP
  )
  ON CONFLICT (tenant_id, event_id) DO NOTHING;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public;

CREATE TRIGGER "knowledge_mailbox_jobs_enqueue_episode_projection"
  AFTER UPDATE OF "status", "result_event_id", "processed_content_hash"
  ON "knowledge_mailbox_jobs"
  FOR EACH ROW
  WHEN (
    NEW.status = 'succeeded'
    AND NEW.result_event_id IS NOT NULL
    AND NEW.processed_content_hash IS NOT NULL
  )
  EXECUTE FUNCTION enqueue_knowledge_episode_projection_job();

COMMENT ON TRIGGER "knowledge_mailbox_jobs_enqueue_episode_projection" ON "knowledge_mailbox_jobs" IS
  'Queues Phase 7 episode projection only after Phase 4 successfully commits an immutable KnowledgeEvent, independent of Phase 6 extraction being enabled. No historical backfill is performed by this migration.';
