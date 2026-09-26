import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const requireFile = (path) => {
  if (!existsSync(resolve(root, path))) throw new Error(`Missing required artifact: ${path}`);
};
const requireText = (path, values) => {
  const content = read(path);
  for (const value of values) if (!content.includes(value)) throw new Error(`${path} is missing contract text: ${value}`);
};

for (const path of [
  'apps/api/prisma/migrations/20280929010000_research_portfolios_phase1/migration.sql',
  'apps/api/prisma/migrations/20280929020000_research_portfolios_phase2_rules/migration.sql',
  'apps/api/prisma/migrations/20280929040000_defense_context_documents/migration.sql',
  'apps/api/src/research-portfolios/research-portfolios.module.ts',
  'apps/api/src/defense-research/defense-research.module.ts',
  'apps/web/src/vnext/pages/research-portfolios/ResearchPortfolioListPage.tsx',
  'apps/web/src/vnext/pages/research-portfolios/ResearchPortfolioDetailPage.tsx',
  'docs/defense-budget/research-portfolios/phases-0-4-closeout.json',
]) requireFile(path);

requireText('apps/api/prisma/schema.prisma', [
  'model ResearchPortfolio {', 'model ResearchPortfolioMember {',
  'model ResearchTaxonomyVersion {', 'model ResearchPortfolioTemplateVersion {',
  'model ResearchPortfolioRuleVersion {', 'model ResearchPortfolioRecomputeJob {',
  'model DefenseContextDocument {', 'model DefenseContextDocumentRevision {',
  'model DefenseContextSection {', 'model DefenseReferenceOccurrence {',
]);
requireText('apps/api/src/research-portfolios/research-portfolios.controller.ts', [
  "@Post('templates/:templateId/versions')", "@Post(':id/rules/preview')", "@Post(':id/rules')",
  "@Post(':id/members/decisions')", "@Post(':id/members/:memberId/resolve')",
]);
requireText('apps/api/src/defense-research/defense-research.controller.ts', [
  "@Get('dossiers/:subjectType/:subjectId')", "@Get('dossiers/:subjectType/:subjectId/milestones')",
  "@Get('funding-matrix/:subjectType/:subjectId')", "@Get('context-documents/:documentId/references')",
  "@Get('reference-occurrences/:occurrenceId')", "@Get('evidence/:evidenceRefId')",
]);
requireText('apps/api/src/program-element/funding-execution/funding-execution-read.service.ts', [
  'amountBasis:', 'executionMetric:', 'asOfDate:', 'periodStart:', 'periodEnd:',
]);
requireText('apps/web/src/vnext/adapters/routes/routeManifest.ts', [
  "id: 'portfolio-research-portfolios'", "featureFlag: 'research_portfolios'",
]);

const closeout = JSON.parse(read('docs/defense-budget/research-portfolios/phases-0-4-closeout.json'));
if (closeout.overallStatus !== 'pass') throw new Error('Phase 0-4 closeout is not PASS');
for (const phase of [0, 1, 2, 3, 4]) {
  if (!closeout.phases.some((entry) => entry.phase === phase && entry.status === 'pass')) throw new Error(`Phase ${phase} is not closed PASS`);
}
if (closeout.deploymentStatus !== 'not_deployed' || closeout.sourceActivationStatus !== 'not_authorized_and_not_performed') throw new Error('Closeout must not imply deployment or source activation');

console.log('PASS research-portfolios phases 1-4: manual collections, rules/templates/taxonomy, defense research readers, contextual sources/references, and rollback boundaries are present.');
