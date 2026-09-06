import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const migration = readFileSync(
  resolve(
    process.cwd(),
    'prisma/migrations/20260905205000_district_nexus_release4_priority_intelligence/migration.sql',
  ),
  'utf8',
);

describe('District Nexus Release 4 migration', () => {
  test('GSA + change tables are global public facts: no tenant_id, no RLS', () => {
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS gsa_real_property');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS district_nexus_change');
    for (const table of [
      'gsa_real_property',
      'gsa_real_property_source_run',
      'district_nexus_change',
    ]) {
      const start = migration.indexOf(`CREATE TABLE IF NOT EXISTS ${table} `);
      expect(start).toBeGreaterThan(-1);
      const body = migration.slice(start, migration.indexOf(');', start));
      expect(body).not.toContain('tenant_id');
    }
    expect(migration).not.toMatch(
      /ALTER TABLE (gsa_real_property|district_nexus_change)[^;]*ROW LEVEL SECURITY/i,
    );
  });

  test('dry runs can never write fact rows (storage-level CHECK)', () => {
    expect(migration).toContain('gsa_real_property_source_run_dry_run_zero_writes');
    expect(migration).toMatch(/dry_run = false OR rows_written = 0/);
    expect(migration).toContain('dry_run boolean NOT NULL DEFAULT true');
  });

  test('GSA grains are explicit and cannot blend (double-count guard)', () => {
    expect(migration).toMatch(/grain IN \('detailed_asset', 'summarized_installation'\)/);
  });

  test('change ledger requires deterministic identity and severity vocabulary', () => {
    expect(migration).toContain(
      'CONSTRAINT district_nexus_change_identity_key UNIQUE (dedupe_key)',
    );
    expect(migration).toMatch(/severity IN \('info', 'notable', 'material'\)/);
    expect(migration).toMatch(/change_kind IN \(/);
    expect(migration).toContain('observed_at timestamptz NOT NULL');
    expect(migration).toContain('effective_at timestamptz');
    expect(migration).toContain('old_value jsonb');
    expect(migration).toContain('new_value jsonb');
    expect(migration).toContain('geography_vintage varchar(48)');
    expect(migration).toContain('source_year integer');
  });

  test('GSA source identity is deterministic and year-bounded', () => {
    expect(migration).toMatch(/source_hash char\(64\) NOT NULL/);
    // source_hash IS the identity (SHA-256 over the full preimage including
    // nullable boundary_congress / asset_status_code). A nullable column in a
    // compound UNIQUE would treat NULLs as distinct and let duplicates past.
    expect(migration).toContain('CONSTRAINT gsa_real_property_identity_key UNIQUE (source_hash)');
    expect(migration).toMatch(/fiscal_year BETWEEN 1900 AND 2200/);
    expect(migration).toMatch(/retrieved_at timestamptz NOT NULL/);
  });

  test('district indexes key on boundary congress so CD119/CD120 never silently join', () => {
    // Index carries boundary_congress as a plain column (matches the Prisma
    // model + the reader query shape); the COALESCE(boundary,-1) join rule is
    // enforced in query identity logic, not in the index.
    expect(migration).toMatch(
      /district_nexus_change_district_idx\s*\n\s*ON district_nexus_change \(state_code, district_code, boundary_congress, observed_at DESC\)/,
    );
    expect(migration).toMatch(
      /gsa_real_property_district_idx\s*\n\s*ON gsa_real_property \(state_code, congressional_district, fiscal_year DESC\)/,
    );
  });
});
