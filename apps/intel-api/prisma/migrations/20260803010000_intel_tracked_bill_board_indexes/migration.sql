-- LegiWatch Gate E phase a (P1-18) — index support for the now-bounded,
-- keyset-paginated board queries.
--
-- getBoard/getTenantBoard order by (trackedAt desc, billId desc) and page with
-- a keyset WHERE (no OFFSET). Without a leading (tenant_id[, client_id],
-- tracked_at) index, that ORDER BY forces a sort over every tracked row for
-- the tenant on each page. ADDITIVE ONLY (CREATE INDEX IF NOT EXISTS) — a
-- retry is a no-op, and this changes no existing index or column.
--
-- Names match Prisma's default convention for `@@index([tenantId, trackedAt])`
-- / `@@index([tenantId, clientId, trackedAt])` on intel_tracked_bill, so a
-- future `prisma migrate diff` sees no drift.

CREATE INDEX IF NOT EXISTS "intel_tracked_bill_tenant_id_tracked_at_idx"
  ON "intel_tracked_bill" ("tenant_id", "tracked_at");

CREATE INDEX IF NOT EXISTS "intel_tracked_bill_tenant_id_client_id_tracked_at_idx"
  ON "intel_tracked_bill" ("tenant_id", "client_id", "tracked_at");
