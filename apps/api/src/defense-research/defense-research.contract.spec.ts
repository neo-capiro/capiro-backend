import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

describe('Defense research Phase 3-8 contracts', () => {
  test('registers the read module and complete route foundation', () => {
    const app = read('src/app.module.ts');
    const controller = read('src/defense-research/defense-research.controller.ts');
    expect(app).toContain("import { DefenseResearchModule } from './defense-research/defense-research.module.js';");
    for (const route of [
      "@Get('dossiers/:subjectType/:subjectId')",
      "@Get('dossiers/:subjectType/:subjectId/milestones')",
      "@Get('funding-matrix/:subjectType/:subjectId')",
      "@Get('context-documents')",
      "@Get('context-documents/:documentId/revisions')",
      "@Get('context-documents/:documentId/sections')",
      "@Get('context-documents/:documentId/references')",
      "@Get('context-documents/:documentId/cited-by')",
      "@Get('reference-occurrences/:occurrenceId')",
      "@Get('offices')",
      "@Get('offices/:officeId')",
      "@Get('relationships')",
      "@Get('acquisition-records')",
      "@Get('acquisition-records/:identityKey/actions')",
      "@Get('acquisition-records/:identityKey')",
      "@Get('acquisition-coverage')",
      "@Get('evidence/:evidenceRefId')",
      "@Get('search')",
      "@Get('compare')",
      "@Get('product-coverage')",
    ]) expect(controller).toContain(route);
    expect(controller.indexOf("@Get('context-documents/:documentId/revisions')")).toBeLessThan(controller.indexOf("@Get('context-documents/:documentId')"));
    expect(controller.indexOf("@Get('acquisition-records/:identityKey/actions')")).toBeLessThan(controller.indexOf("@Get('acquisition-records/:identityKey')"));
  });

  test('keeps customer search, comparison, and coverage semantics explicit', () => {
    const service = read('src/defense-research/defense-research.service.ts');
    expect(service).toContain("status: 'accepted'");
    const controller = read('src/defense-research/defense-research.controller.ts');
    const semantic = read('src/defense-research/defense-research-semantic.ts');
    expect(service).toContain('semanticEnabled = false');
    expect(service).toContain("status: 'disabled'");
    expect(service).toContain('await readPublicPESemanticSuggestions(this.prisma, ctx, original)');
    expect(controller).toContain('@CurrentTenant() ctx: TenantContext');
    expect(controller).toContain("this.service.search(q, semanticEnabled === 'true', ctx)");
    expect(semantic).toContain('prisma.withTenantUser');
    expect(semantic).toContain('tx.tenantMembership.findFirst');
    expect(service).toContain('Semantic results are partial public-PE mission-similarity suggestions');
    expect(service).toContain('do not attest every indexed field at that locator or independently qualify relevance');
    expect(service).toContain('missing is not zero');
    expect(service).toContain("state: 'unknown'");
    expect(service).toContain('No cohort is labelled complete while its denominator is unknown.');
    expect(service).not.toContain("adapterId: source.adapterId");
  });

  test('reads the immutable acquisition ledger without converting associations into allocations', () => {
    const service = read('src/defense-research/defense-research.service.ts');
    expect(service).toContain('this.prisma.acquisitionRecordRevision.findMany');
    expect(service).toContain("distinct: ['identityKey']");
    expect(service).toContain('this.prisma.acquisitionAwardTransactionRevision.findMany');
    expect(service).toContain("distinct: ['transactionIdentityKey']");
    expect(service).toContain("rel.relationshipClass === 'source_stated_financial_allocation'");
    expect(service).toContain("rel.relationshipClass === 'deterministic_financial_allocation'");
    expect(service).toContain("reviewStatus: includeSpeculative ? { in: ['accepted', 'candidate'] } : 'accepted'");
    expect(service).toContain('resolvedAt: null');
  });

  test('composes office and relationship research from existing temporal authorities', () => {
    const service = read('src/defense-research/defense-research.service.ts');
    expect(service).toContain('this.prisma.programOffice.findMany');
    expect(service).toContain("relation: 'holds_role'");
    expect(service).toContain("relation: 'acquisition_path'");
    expect(service).not.toContain('defenseRelationshipEdge');
    expect(service).not.toContain("relation: 'allocates'");
    expect(service).toContain("filters.includeSpeculative ? ['accepted', 'candidate'] : ['accepted']");
  });

  test('defines immutable contextual revisions and exact reference spans', () => {
    const schema = read('prisma/schema.prisma');
    const migration = read('prisma/migrations/20280929040000_defense_context_documents/migration.sql');
    for (const model of ['DefenseContextDocument', 'DefenseContextDocumentRevision', 'DefenseContextSection', 'DefenseReferenceOccurrence']) {
      expect(schema).toContain(`model ${model} {`);
    }
    expect(schema).toMatch(/model DefenseReferenceOccurrence \{[\s\S]*exactSpan[\s\S]*startOffset[\s\S]*endOffset[\s\S]*targetCandidates[\s\S]*resolvedTarget[\s\S]*disposition/);
    expect(migration).toContain('defense_context_document_revisions_append_only_trigger');
    expect(migration).toContain('defense_context_sections_append_only_trigger');
    expect(migration).toContain('BEFORE UPDATE OR DELETE');
  });

  test('defines immutable rule versions, bounded previews, and recompute jobs', () => {
    const schema = read('prisma/schema.prisma');
    const migration = read('prisma/migrations/20280929020000_research_portfolios_phase2_rules/migration.sql');
    for (const model of ['ResearchTaxonomyVersion', 'ResearchPortfolioTemplateVersion', 'ResearchPortfolioRuleVersion', 'ResearchPortfolioRulePreview', 'ResearchPortfolioRecomputeJob']) {
      expect(schema).toContain(`model ${model} {`);
    }
    expect(migration).toContain('research_portfolio_rule_versions_append_only_trigger');
    expect(migration).toContain('research_taxonomy_versions_append_only_trigger');
    expect(migration).toContain('research_portfolio_template_versions_operation_key');
    expect(migration).toContain('research_portfolio_rule_versions_template_fkey');
    expect(migration).toContain('BEFORE UPDATE OR DELETE');
  });
});
