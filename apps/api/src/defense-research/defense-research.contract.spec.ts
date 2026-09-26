import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

describe('Defense research Phase 3-4 contracts', () => {
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
      "@Get('evidence/:evidenceRefId')",
    ]) expect(controller).toContain(route);
    expect(controller.indexOf("@Get('context-documents/:documentId/revisions')")).toBeLessThan(controller.indexOf("@Get('context-documents/:documentId')"));
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
