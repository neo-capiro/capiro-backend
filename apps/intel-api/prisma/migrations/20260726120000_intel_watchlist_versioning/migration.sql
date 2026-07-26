-- LegiWatch Gate B phase d/e (P0-03 item 5, P1-02) — shared-targeting concurrency.
--
-- ADDITIVE ONLY: no DROP, no type change, no NOT NULL without DEFAULT. Re-running
-- `migrate deploy` is a no-op. Run through the deployed intel-api's migration step
-- (Aurora is private-subnet; never from a workstation).
--
-- PRE-FLIGHT (run 2026-07-26 against capiro-dev via the read-only db-inspect diag
-- task, Gate B §2.2 constraint 1): duplicate (watchlist_id, label) groups = 0,
-- excess rows = 0 across 13 topic rows / 14 `wl:` watchlists. The UNIQUE INDEX
-- below therefore cannot fail on existing data. If this migration is ever replayed
-- into a different database, re-run that query FIRST:
--   SELECT watchlist_id, label, count(*) FROM intel_watchlist_topic
--    GROUP BY 1,2 HAVING count(*) > 1;

-- P1-02: optimistic concurrency + attribution on the shared client watchlist.
-- `version` starts at 0 on every existing row, so the first versioned PUT sends
-- expectedVersion: 0 and matches (the web reads the version it saw).
ALTER TABLE "intel_watchlist"
  ADD COLUMN IF NOT EXISTS "version"    INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "updated_by" TEXT;

-- P0-03 item 5 / P1-02: `label` IS the de-facto topic identity everywhere in the
-- compiler (watchlist-compiler.ts groups terms byTopic BY LABEL) and the mapper
-- (watchlist-mapping.ts dedupes topics by lower-cased label). Enforce it so the
-- diff-based reconcile can upsert on it instead of delete-all-then-recreate,
-- which minted a fresh cuid for every topic on every save.
CREATE UNIQUE INDEX IF NOT EXISTS "intel_watchlist_topic_watchlist_label_key"
  ON "intel_watchlist_topic" ("watchlist_id", "label");

-- P1-02: "Updated by … at …" plus a change log the Configure panel can show.
CREATE TABLE IF NOT EXISTS "intel_watchlist_revision" (
  "id"           TEXT NOT NULL,
  "tenant_id"    TEXT NOT NULL,
  "client_id"    TEXT NOT NULL,
  "watchlist_id" TEXT NOT NULL,
  "version"      INTEGER NOT NULL,
  "changed_by"   TEXT,
  "summary"      JSONB NOT NULL DEFAULT '{}',
  "created_at"   TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "intel_watchlist_revision_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "intel_watchlist_revision_client_idx"
  ON "intel_watchlist_revision" ("tenant_id", "client_id", "version" DESC);

-- RLS. The pre-flight confirmed intel_watchlist / _term / _topic all carry
-- relrowsecurity = relforcerowsecurity = true (policies from
-- 20260706010000_intel_full_rls_hold). A new tenant-scoped intel_* table MUST
-- join that hold or it would be the only unguarded one in the family — the
-- revision log carries tenant_id + client_id and is read request-scoped through
-- withTenant, so it takes the standard isolation policy verbatim. Guarded by
-- IF NOT EXISTS / pg_policy checks so a replay is a no-op.
-- (current_tenant_id() returns UUID while every intel_* tenant_id is TEXT —
-- hence the ::text cast, same landmine noted in the RLS-hold migration.)
DO $$
BEGIN
  EXECUTE 'ALTER TABLE "intel_watchlist_revision" ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE "intel_watchlist_revision" FORCE ROW LEVEL SECURITY';
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
     WHERE c.relname = 'intel_watchlist_revision'
       AND p.polname = 'intel_watchlist_revision_isolation'
  ) THEN
    EXECUTE 'CREATE POLICY "intel_watchlist_revision_isolation" ON "intel_watchlist_revision" '
         || 'USING (rls_bypass() OR tenant_id = current_tenant_id()::text) '
         || 'WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id()::text)';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON "intel_watchlist_revision" TO capiro_app';
  END IF;
END
$$;
