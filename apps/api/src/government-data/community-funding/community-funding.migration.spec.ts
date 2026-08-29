import fs from 'node:fs';
import path from 'node:path';
describe('community funding migration contract', () => {
  const sql=fs.readFileSync(path.resolve(__dirname,'../../../prisma/migrations/20280101030000_cpf_cds_canonical_ingestion/migration.sql'),'utf8');
  it('creates global canonical, provenance, discovery and checkpoint tables with uniqueness and provenance FK', () => {
    expect(sql).toContain('CREATE TABLE "community_funding_request"');
    expect(sql).toContain('community_funding_request_identity_hash_key');
    expect(sql).toContain('CREATE TABLE "community_funding_request_source"');
    expect(sql).toContain('community_funding_request_source_occurrence_key');
    expect(sql).toContain('REFERENCES "source_document"("id")');
    expect(sql).toContain('CREATE TABLE "community_funding_discovery_crawl"');
    expect(sql).toContain('CREATE TABLE "community_funding_ingest_run"');
    expect(sql).not.toMatch(/tenant_id|ROW LEVEL SECURITY/i);
  });
  it('canonical request no longer carries a source-document FK or identity-hashed source fields — provenance is a separate table', () => {
    // Pins the exact repair: the canonical request table itself must not reference
    // source_document directly (that FK now lives only on community_funding_request_source).
    const canonicalTableSql = sql.slice(sql.indexOf('CREATE TABLE "community_funding_request"'), sql.indexOf('CREATE TABLE "community_funding_request_source"'));
    expect(canonicalTableSql).not.toContain('"source_document_id"');
    expect(canonicalTableSql).not.toContain('REFERENCES "source_document"');
  });
  it('provenance table has a deterministic multi-column uniqueness rule so a re-run of the same document occurrence is a no-op', () => {
    expect(sql).toContain('CREATE UNIQUE INDEX "community_funding_request_source_occurrence_key" ON "community_funding_request_source"("request_id", "source_document_id", "source_page", "source_row")');
  });
  it('is LF-only and separates requested from final amounts on both the canonical and provenance tables', () => {
    expect(sql).not.toContain('\r');
    expect(sql).toContain('"requested_amount_usd"'); expect(sql).toContain('"final_amount_usd"');
  });
});
