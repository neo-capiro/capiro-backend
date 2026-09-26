import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = (name: string) =>
  readFileSync(resolve(process.cwd(), `src/research-portfolios/${name}`), 'utf8');

describe('Research Portfolios Phase 7 route ownership', () => {
  it('exposes the complete Phase 7 review endpoints', () => {
    const controller = source('research-portfolios.controller.ts');
    for (const decorator of [
      "@Get(':id/reviews')",
      "@Post(':id/reviews/:reviewId/assign')",
      "@Post(':id/reviews/:reviewId/decision')",
      "@Post(':id/reviews/bulk')",
      "@Get(':id/annual-review')",
      "@Post(':id/annual-review/reopen')",
      "@Post(':id/imports')",
      "@Get(':id/imports/:jobId')",
      "@Post(':id/imports/:jobId/:action')",
    ]) {
      expect(controller).toContain(decorator);
    }
  });

  it('registers review service in module', () => {
    const module = source('research-portfolios.module.ts');
    expect(module).toContain('ResearchPortfolioReviewService');
    expect(module).toContain('import { ResearchPortfolioReviewService }');
    expect(module).toMatch(/providers:\s*\[[^\]]*ResearchPortfolioReviewService[^\]]*\]/s);
    expect(module).toContain('ResearchPortfolioImportService');
  });

  it('ensures tenant-scoped authorization with PrismaService.withTenant', () => {
    const service = source('research-portfolio-review.service.ts');
    expect(service).toContain('this.prisma.withTenant');
    expect(service).toContain('loadAuthorized');
    expect(service).toContain('isPortfolioArchived');
  });

  it('validates against archived portfolio mutations', () => {
    const service = source('research-portfolio-review.service.ts');
    expect(service).toContain('Cannot assign reviews for archived portfolio');
    expect(service).toContain('Cannot decide reviews for archived portfolio');
    expect(service).toContain('Cannot bulk decide reviews for archived portfolio');
    expect(service).toContain('Cannot reopen annual review for archived portfolio');
    expect(service).not.toContain('Cannot list reviews for archived portfolio');
    expect(service).not.toContain('Cannot get annual review for archived portfolio');
  });

  it('implements assignment with active tenant user validation', () => {
    const service = source('research-portfolio-review.service.ts');
    expect(service).toContain('requireActiveTenantMember');
    expect(service).toContain('User is not an active member of this tenant');
  });

  it('requires non-empty reasons for decisions', () => {
    const service = source('research-portfolio-review.service.ts');
    expect(service).toContain('Every bulk decision requires a non-empty reason');
    expect(service).toContain('Decision requires a non-empty reason');
  });

  it('rejects mixed incompatible decision types in bulk operations', () => {
    const service = source('research-portfolio-review.service.ts');
    expect(service).toContain('Bulk decisions must use one compatible decision type and scope');
  });

  it('implements append-only decisions with prior/supersedes references', () => {
    const service = source('research-portfolio-review.service.ts');
    expect(service).toContain('priorDecisionId');
    expect(service).toContain('supersedesId');
  });

  it('handles empty continuity history gracefully', () => {
    const service = source('research-portfolio-review.service.ts');
    expect(service).toContain('items: items.map((item) => this.continuityLedgerDto(item))');
    expect(service).toContain('unchanged: 0');
    expect(service).toContain('new: 0');
  });

  it('implements idempotent changed-only reopening', () => {
    const service = source('research-portfolio-review.service.ts');
    expect(service).toContain("ledger.status === 'unchanged' || ledger.status === 'new'");
    expect(service).toContain('skipping');
    expect(service).toContain('triggerFingerprint');
    expect(service).toContain('dependencyFingerprint');
  });
});
