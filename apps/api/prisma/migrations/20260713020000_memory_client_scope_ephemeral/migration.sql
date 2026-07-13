-- G2 (blueprint §3.5 "Remember for this client or matter" + §5.4 scopes):
-- CLIENT memory scope + EPHEMERAL (expires_at) class. ADDITIVE ONLY — the RLS
-- expiry predicate ships separately (migration B, split-migration discipline
-- per the 1A/1C precedent: additive columns first, policy replacement in its
-- own deploy window).
--
-- Client scope model (deliberate, documented in the G2 plan): a client-scoped
-- memory is `visibility='tenant'` + `client_id` set — tenant-visible,
-- client-keyed. It is a RELEVANCE boundary (recalled only in that client's
-- conversations/drafts), NOT a per-user access boundary: no per-user client
-- ACL exists in Capiro today, so claiming DB-enforced client access control
-- would be false. memory_items.client_id already exists (base migration);
-- what's missing is client identity on clio_memory (the fast write/recall
-- store) and on memory_candidate (the review queue), plus the widened scope
-- vocabularies.

-- 1. clio_memory: client identity + widened scope vocabulary.
ALTER TABLE "clio_memory" ADD COLUMN "client_id" UUID;

ALTER TABLE "clio_memory" DROP CONSTRAINT IF EXISTS "clio_memory_scope_check";
ALTER TABLE "clio_memory" ADD CONSTRAINT "clio_memory_scope_check"
  CHECK ("scope" IN ('firm', 'user_private', 'client'));

-- scope↔owner↔client shape: firm = no owner/no client; user_private = owner,
-- no client; client = client, no owner.
ALTER TABLE "clio_memory" DROP CONSTRAINT IF EXISTS "clio_memory_scope_owner_check";
ALTER TABLE "clio_memory" ADD CONSTRAINT "clio_memory_scope_owner_check"
  CHECK (
    ("scope" = 'firm' AND "owner_user_id" IS NULL AND "client_id" IS NULL)
    OR ("scope" = 'user_private' AND "owner_user_id" IS NOT NULL AND "client_id" IS NULL)
    OR ("scope" = 'client' AND "owner_user_id" IS NULL AND "client_id" IS NOT NULL)
  );

CREATE INDEX "clio_memory_tenant_client_idx"
  ON "clio_memory" ("tenant_id", "client_id")
  WHERE "client_id" IS NOT NULL;

-- 2. memory_candidate: client identity + widened scope vocabulary.
ALTER TABLE "memory_candidate" ADD COLUMN "client_id" UUID;

ALTER TABLE "memory_candidate" DROP CONSTRAINT IF EXISTS "memory_candidate_scope_chk";
ALTER TABLE "memory_candidate" ADD CONSTRAINT "memory_candidate_scope_chk"
  CHECK ("scope" IN ('personal', 'firm', 'client'));

-- 3. Ephemeral/working memory: expires_at on both stores. NULL = durable
-- (every existing row). Partial indexes keep the purge sweep + expiry filters
-- cheap without taxing the durable majority.
ALTER TABLE "clio_memory" ADD COLUMN "expires_at" TIMESTAMPTZ(6);
ALTER TABLE "memory_items" ADD COLUMN "expires_at" TIMESTAMPTZ(6);

CREATE INDEX "clio_memory_expiry_idx"
  ON "clio_memory" ("tenant_id", "expires_at")
  WHERE "expires_at" IS NOT NULL;
CREATE INDEX "memory_items_expiry_idx"
  ON "memory_items" ("tenant_id", "expires_at")
  WHERE "expires_at" IS NOT NULL;
