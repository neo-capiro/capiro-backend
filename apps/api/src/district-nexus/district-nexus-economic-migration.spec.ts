import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const migration = readFileSync(
  resolve(
    process.cwd(),
    'prisma/migrations/20261121000000_district_nexus_release3_economic_footprint/migration.sql',
  ),
  'utf8',
);

describe('District Nexus Release 3 migration', () => {
  test('keeps public district facts separate from tenant-owned client evidence', () => {
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS client_geographic_evidence');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS district_economic_fact');
    const publicTable = migration.slice(
      migration.indexOf('CREATE TABLE IF NOT EXISTS district_economic_fact'),
      migration.indexOf('CREATE TABLE IF NOT EXISTS district_economic_source_run'),
    );
    expect(publicTable).not.toContain('tenant_id');
  });

  test('forces RLS on both tenant-owned Release 3 tables', () => {
    expect(migration).toContain('ALTER TABLE client_footprint_import FORCE ROW LEVEL SECURITY');
    expect(migration).toContain('ALTER TABLE client_geographic_evidence FORCE ROW LEVEL SECURITY');
    expect(migration).toContain('tenant_id = current_tenant_id()');
  });

  test('requires review before external use and makes completed review terminal', () => {
    expect(migration).toContain("review_status varchar(24) NOT NULL DEFAULT 'pending_review'");
    expect(migration).toContain("review_status IN ('pending_review', 'approved', 'rejected')");
    expect(migration).toContain('external_use_approved = false OR review_status = \'approved\'');
    expect(migration).toContain('enforce_client_geographic_evidence_review');
    expect(migration).toContain("OLD.review_status IN ('approved', 'rejected')");
  });

  test('prevents the same uploaded file from being committed twice for one client', () => {
    expect(migration).toContain('client_footprint_import_committed_content_uniq');
    expect(migration).toContain("content_sha256 IS NOT NULL AND status = 'committed'");
  });

  test('does not create a second subaward table', () => {
    expect(migration).not.toMatch(/CREATE TABLE[^;]*subaward/i);
  });

  test('stores source year and boundary Congress for annual public facts', () => {
    expect(migration).toContain('source_year integer NOT NULL');
    expect(migration).toContain('boundary_congress integer');
    expect(migration).toContain('margin_of_error numeric');
    expect(migration).toContain('dry_run boolean NOT NULL DEFAULT true');
  });
});
