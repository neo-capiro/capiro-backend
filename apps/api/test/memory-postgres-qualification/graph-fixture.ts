import type { QualificationDatabase } from './harness.js';

/** Minimal graph relation shapes for this disposable SQL fixture, not a migration replay. */
export async function installGraphFixture(db: QualificationDatabase) {
  const statements = [
    "ALTER TABLE clients ADD COLUMN name text NOT NULL DEFAULT 'Synthetic client'",
    "ALTER TABLE clients ADD COLUMN status text NOT NULL DEFAULT 'active'",
    'CREATE TABLE memory_edges (tenant_id uuid NOT NULL REFERENCES tenants(id), src_item_id uuid NOT NULL REFERENCES memory_items(id), relation text NOT NULL, dst_type text NOT NULL, dst_slug text NOT NULL)',
    'CREATE TABLE tracked_bill (tenant_id uuid NOT NULL REFERENCES tenants(id), client_id uuid NOT NULL REFERENCES clients(id), bill_id text NOT NULL)',
    'CREATE TABLE client_people (id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id), client_id uuid NOT NULL REFERENCES clients(id), name text NOT NULL)',
    'CREATE TABLE congress_bill (id text PRIMARY KEY)',
  ];
  for (const statement of statements) await db.admin.$executeRawUnsafe(statement);
  for (const table of ['memory_edges', 'tracked_bill', 'client_people']) {
    await db.admin.$executeRawUnsafe(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
    await db.admin.$executeRawUnsafe(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
    await db.admin.$executeRawUnsafe(
      `CREATE POLICY tenant_scope ON ${table} USING (tenant_id = current_setting('app.current_tenant', true)::uuid)`,
    );
  }
  await db.admin.$executeRawUnsafe(
    `GRANT SELECT ON memory_edges, tracked_bill, client_people, congress_bill TO "${db.appRole}"`,
  );
}
