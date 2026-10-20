-- Source only: no migration/database execution is part of this change.
-- Presentation preferences stay outside membership rows/identity revisions.
-- Existing capiro_admin impersonation retains its actor UUID; membership is
-- rechecked by the canonical request owner, not a target-membership FK.

CREATE FUNCTION portfolio_layout_order_valid(order_ids UUID[]) RETURNS BOOLEAN
LANGUAGE SQL IMMUTABLE STRICT AS $$
  SELECT CASE
    WHEN cardinality(order_ids) = 0 THEN true
    WHEN cardinality(order_ids) > 2000 OR array_ndims(order_ids) <> 1 OR array_lower(order_ids, 1) <> 1 THEN false
    ELSE (SELECT count(DISTINCT id) FROM unnest(order_ids) AS ids(id)) = cardinality(order_ids)
  END
$$;

CREATE TABLE "user_portfolio_layouts" (
  "tenant_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "client_order" UUID[] NOT NULL,
  "version" INTEGER NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "user_portfolio_layouts_pkey" PRIMARY KEY ("tenant_id", "user_id"),
  CONSTRAINT "user_portfolio_layouts_tenant_id_fkey" FOREIGN KEY ("tenant_id")
    REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "user_portfolio_layouts_user_id_fkey" FOREIGN KEY ("user_id")
    REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "user_portfolio_layouts_version_check" CHECK ("version" BETWEEN 1 AND 2147483647),
  CONSTRAINT "user_portfolio_layouts_order_check" CHECK (portfolio_layout_order_valid("client_order"))
);

ALTER TABLE "user_portfolio_layouts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user_portfolio_layouts" FORCE ROW LEVEL SECURITY;
CREATE POLICY "user_portfolio_layouts_owner_isolation" ON "user_portfolio_layouts"
  USING (rls_bypass() OR ("tenant_id" = current_tenant_id() AND "user_id" = current_user_id()))
  WITH CHECK (rls_bypass() OR ("tenant_id" = current_tenant_id() AND "user_id" = current_user_id()));
CREATE TRIGGER "user_portfolio_layouts_set_updated_at"
  BEFORE UPDATE ON "user_portfolio_layouts"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
