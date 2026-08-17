import fs from 'node:fs';
import path from 'node:path';

const apiRoot = process.cwd();
const phase11 = path.join(
  apiRoot,
  'prisma/migrations/20261120190000_retrieval_v2_exact_lexical_indexes/migration.sql',
);
const phase5 = path.join(
  apiRoot,
  'prisma/migrations/20261120100000_universal_entity_resolution/migration.sql',
);

describe('Knowledge Plane Phase 11 exact lexical index contract', () => {
  const sql = fs.readFileSync(phase11, 'utf8');
  const entitySql = fs.readFileSync(phase5, 'utf8');

  it('adds indexes only and does not create a duplicate lexical/search substrate', () => {
    expect(sql).not.toMatch(/\bCREATE\s+TABLE\b/i);
    expect(sql).not.toMatch(/\bCREATE\s+MATERIALIZED\s+VIEW\b/i);
    expect(sql).not.toMatch(/\bCREATE\s+TYPE\b/i);
    expect(sql).not.toMatch(/\bINSERT\s+INTO\b/i);
    expect(sql).not.toMatch(/\bUPDATE\s+/i);
  });

  it('indexes exact canonical names without replacing Phase 5 alias and identifier indexes', () => {
    expect(sql).toContain('canonical_entities_global_exact_name_idx');
    expect(sql).toContain('canonical_entities_tenant_exact_name_idx');

    expect(entitySql).toContain('entity_aliases_global_lookup_idx');
    expect(entitySql).toContain('entity_aliases_tenant_lookup_idx');
    expect(entitySql).toContain('entity_identifiers_global_unique');
    expect(entitySql).toContain('entity_identifiers_tenant_unique');
  });

  it('adds only the missing tenant CRM exact identifier/account indexes', () => {
    expect(sql).toContain('clients_tenant_uei_exact_idx');
    expect(sql).toContain('clients_tenant_cage_exact_idx');
    expect(sql).toContain('client_capabilities_appropriation_exact_idx');
  });

  it('covers normalized federal award, SAM, bill, program, and SEC exact lookup shapes', () => {
    for (const name of [
      'federal_award_award_unique_exact_idx',
      'federal_award_piid_exact_idx',
      'federal_award_fain_exact_idx',
      'federal_award_recipient_uei_exact_idx',
      'sam_opportunity_notice_exact_idx',
      'sam_opportunity_solicitation_exact_idx',
      'congress_bill_type_number_congress_exact_idx',
      'program_canonical_name_exact_idx',
      'sec_filing_normalized_cik_exact_idx',
    ]) {
      expect(sql).toContain(name);
    }
  });

  it('does not duplicate identifiers that are already primary/unique/live-path indexed', () => {
    // PE code is program_element's primary key; federal bill id is congress_bill's
    // primary key; ProgramAlias and SAM solicitation already have live indexes.
    expect(sql).not.toMatch(/CREATE\s+(?:UNIQUE\s+)?INDEX[^;]+ON\s+program_element\s*\(\s*pe_code/i);
    expect(sql).not.toMatch(/CREATE\s+(?:UNIQUE\s+)?INDEX[^;]+ON\s+congress_bill\s*\(\s*id/i);
    expect(sql).not.toMatch(/CREATE\s+(?:UNIQUE\s+)?INDEX[^;]+ON\s+program_alias\s*\(\s*alias_normalized/i);
  });
});
