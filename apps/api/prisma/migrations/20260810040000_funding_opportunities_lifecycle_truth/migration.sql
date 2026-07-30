-- Funding Opportunities — source lifecycle truth.
--
-- Additive and nullable throughout. No data migration, no backfill in DDL: the
-- lifecycle processor establishes each row's baseline on its first pass, and a
-- row that has not been visited reads NULL, which is ABSENT rather than wrong.
-- That property is what makes this migration re-runnable and unable to partially
-- corrupt anything.
--
-- ── 1. source_fingerprint ───────────────────────────────────────────────────
--
-- A hash of the SOURCE-PUBLISHED content behind this workflow row, computed by
-- `src/funding-opportunities/source-lifecycle.ts`.
--
-- It exists because "has this opportunity been amended?" was previously answered
-- by comparing a timestamp, and every timestamp available to that comparison was
-- one of OUR OWN:
--
--   * `sam_opportunity.updated_at` is a Prisma @updatedAt column. An ordinary
--     re-sync rewrites the row — even with byte-identical values — so it moves on
--     every nightly pass.
--   * `federal_grant.detail_synced_at` / `.synced_at` move whenever the detail
--     enricher or the catalog sync visits a record, regardless of whether the
--     record changed.
--
-- The previous implementation read `last_updated_at ?? detail_synced_at ??
-- synced_at` (grants) and `updated_at ?? last_synced_at` (SAM), so a grant with
-- no source-published modification date generated an "Opportunity updated" alert
-- keyed on the ENRICHER'S clock, and every SAM notice a sync touched generated
-- one keyed on the sync's. For a tenant tracking a few hundred opportunities
-- that is a few hundred false alerts per night.
--
-- A fingerprint cannot express that failure: only source-published fields feed
-- it, and `source-lifecycle.spec.ts` asserts the absence of every local
-- synchronization field by name.
--
-- NULL means "no baseline yet" and is handled explicitly — the processor
-- establishes a baseline SILENTLY on first sight rather than treating "no
-- previous fingerprint" as "everything changed", which would alert on every
-- tracked row the first time it ran.
ALTER TABLE "client_funding_opportunity"
  ADD COLUMN IF NOT EXISTS "source_fingerprint" TEXT;

-- ── 2. source_active_snapshot ───────────────────────────────────────────────
--
-- Whether the SOURCE considered this opportunity live at the last observation.
--
-- Previously the processor reconstructed the previous active state by testing the
-- stored status string against a list of closed-ish words
-- (`'closed','archived','inactive','cancelled'`). That reconstruction was wrong
-- for two distinct reasons:
--
--   * A legacy row with NO snapshot at all produced status '' — which is not in
--     the list — so `previousActive` came out TRUE. Any such row whose source was
--     in fact already closed therefore fired a spurious "Opportunity closed"
--     alert the first time the processor saw it.
--   * The status string alone cannot express the date half of the lifecycle. A
--     Grants.gov notice sitting at 'posted' with a close date two years past is
--     not active, and a SAM notice can be `active = true` with its response
--     deadline already passed (the flag is derived from the ARCHIVE date, which
--     commonly trails the deadline by weeks).
--
-- Storing the computed boolean removes the reconstruction entirely.
ALTER TABLE "client_funding_opportunity"
  ADD COLUMN IF NOT EXISTS "source_active_snapshot" BOOLEAN;

-- ── 3. Lifecycle keyset cursor ──────────────────────────────────────────────
--
-- (tenant_id, id) — the ordering the lifecycle processor paginates on.
--
-- The processor used to read `findMany({ where: { tenantId }, take: 5000 })` and
-- set a `capped` flag when it hit the limit, which it then reported as an ERROR
-- COUNT on the sync run. So beyond 5,000 tracked rows in one tenant the pass was
-- silently partial: rows sorted after the cap were never expired and never
-- alerted, and the only signal was a warning line. It now walks every row with
-- `WHERE tenant_id = $1 AND id > $cursor ORDER BY id LIMIT $page`, which is what
-- this index serves.
CREATE INDEX IF NOT EXISTS "client_funding_opportunity_tenant_cursor_idx"
  ON "client_funding_opportunity" ("tenant_id", "id");

-- ── 4. Grant discovery + enrichment allocation ──────────────────────────────
--
-- (status, close_date, detail_synced_at).
--
-- Two queries want this composite:
--
--   * DISCOVERY. The read path's active-grant predicate is now
--     `lower(status) IN ('posted','forecasted') AND (close_date IS NULL OR
--     close_date >= CURRENT_DATE)`, applied IN the query. Before this change the
--     query filtered on status alone and trimmed the dates in TypeScript AFTER a
--     `LIMIT`, which is not a filter at all: ordered by soonest deadline, the cap
--     was consumed by the LONGEST-EXPIRED notices and genuinely open grants fell
--     off the end. `federal_grant_status_idx` and `federal_grant_close_date_idx`
--     exist separately, and Postgres will not combine two single-column btrees as
--     efficiently as one composite for a predicate that constrains both.
--
--   * ENRICHMENT ALLOCATION. `enrich-grant-details.ts` now reserves capacity for
--     current and for historical records instead of taking one stalest-first
--     window, so it issues two candidate scans that each constrain the lifecycle
--     columns AND `detail_synced_at`. Trailing `detail_synced_at` lets both be
--     served from this one index.
CREATE INDEX IF NOT EXISTS "federal_grant_lifecycle_enrichment_idx"
  ON "federal_grant" ("status", "close_date", "detail_synced_at");

-- ── 5. SAM lifecycle ───────────────────────────────────────────────────────
--
-- (active, response_deadline, archive_date).
--
-- `sam_opportunity_active_response_deadline_idx` already covers the first two.
-- The pursuit predicate now also constrains `archive_date`, because `active`
-- alone admits notices whose response window has shut. Trailing it here means
-- both the active-pursuit and closed-history reads evaluate the whole date half
-- of the predicate from the index. Added as a new index rather than by replacing
-- the existing one: dropping an index a live read path is using, to add one
-- trailing column, is not worth the window.
CREATE INDEX IF NOT EXISTS "sam_opportunity_lifecycle_idx"
  ON "sam_opportunity" ("active", "response_deadline", "archive_date");
