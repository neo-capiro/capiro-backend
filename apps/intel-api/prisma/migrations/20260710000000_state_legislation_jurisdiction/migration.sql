-- State Legislation Platform Phase 0 (S4.1) — jurisdiction facets, additive
-- and default-preserving (DD5). No RLS changes: these are new/altered
-- columns on already-policied tables (intel_watchlist, intel_alert_preference,
-- intel_bill_match all carry the standard per-table isolation policy from
-- 20260706010000_intel_full_rls_hold).

-- intel_bill_match: congress is meaningless for a state-bill match row.
ALTER TABLE "intel_bill_match" ALTER COLUMN "congress" DROP NOT NULL;
ALTER TABLE "intel_bill_match" ADD COLUMN "jurisdiction" TEXT NOT NULL DEFAULT 'US';

-- intel_watchlist: empty = federal-only (today's behavior, zero migration
-- surprise). Non-empty = also match the state corpus for those states.
ALTER TABLE "intel_watchlist" ADD COLUMN "jurisdictions" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- intel_alert_preference: empty = ALL jurisdictions the client's watchlist
-- produces (state alerts are additionally gated by the watchlist opt-in
-- above, so no one gets state spam by default).
ALTER TABLE "intel_alert_preference" ADD COLUMN "jurisdictions" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
