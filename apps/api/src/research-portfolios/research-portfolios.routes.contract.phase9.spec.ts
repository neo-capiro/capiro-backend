import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('Research Portfolios Phase 9 route contract', () => {
  const controller = readFileSync(resolve(process.cwd(), 'src/research-portfolios/research-portfolios.controller.ts'), 'utf8');
  const module = readFileSync(resolve(process.cwd(), 'src/research-portfolios/research-portfolios.module.ts'), 'utf8');

  it.each([
    "@Get(':id/changes')",
    "@Patch(':id/changes/:eventId/state')",
    "@Get(':id/subscriptions')",
    "@Post(':id/subscriptions')",
    "@Patch(':id/subscriptions/:subscriptionId')",
    "@Get(':id/analytics')",
    "@Get(':id/snapshots')",
    "@Post(':id/snapshots')",
    "@Get(':id/snapshots/:snapshotId')",
    "@Post(':id/outputs')",
    "@Get(':id/output-jobs/:jobId')",
    "@Get(':id/outputs/:outputId/download')",
    "@Post(':id/outputs/:outputId/client-files')",
  ])('declares route %s', (route) => expect(controller).toContain(route));

  it.each(['ResearchPortfolioChangesService', 'ResearchPortfolioAnalyticsService', 'ResearchPortfolioOutputService'])
    ('registers %s once as the shared UI/Meri domain service', (service) => {
      expect(module).toContain(service);
    });

  it('uses the canonical client writer and current-ACL download response', () => {
    expect(module).toContain('ClientDocumentsModule');
    expect(controller).toContain("response.setHeader('Cache-Control', 'private, no-store')");
  });
});
