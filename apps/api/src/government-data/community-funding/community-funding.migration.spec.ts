import fs from 'node:fs';
import path from 'node:path';
describe('community funding migration contract', () => {
  const sql=fs.readFileSync(path.resolve(__dirname,'../../../prisma/migrations/20280101030000_cpf_cds_canonical_ingestion/migration.sql'),'utf8');
  it('creates global canonical, discovery and checkpoint tables with uniqueness and provenance FK', () => {
    expect(sql).toContain('CREATE TABLE "community_funding_request"');
    expect(sql).toContain('community_funding_request_identity_hash_key');
    expect(sql).toContain('REFERENCES "source_document"("id")');
    expect(sql).toContain('CREATE TABLE "community_funding_discovery_crawl"');
    expect(sql).toContain('CREATE TABLE "community_funding_ingest_run"');
    expect(sql).not.toMatch(/tenant_id|ROW LEVEL SECURITY/i);
  });
  it('is LF-only and separates requested from final amounts', () => {
    expect(sql).not.toContain('\r'); expect(sql).toContain('"requested_amount_usd"'); expect(sql).toContain('"final_amount_usd"');
  });
});
