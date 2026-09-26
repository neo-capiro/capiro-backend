import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

describe('Research Portfolios Phase 10 contracts', () => {
  test('persists append-only per-recipient delivery outcomes behind RLS', () => {
    const schema = read('prisma/schema.prisma');
    const migration = read('prisma/migrations/20281002010000_research_portfolios_phase10_watch_delivery/migration.sql');
    expect(schema).toContain('model ResearchPortfolioSubscriptionDelivery');
    expect(migration).toContain('research_portfolio_subscription_deliveries_identity_key');
    expect(migration).toContain('ENABLE ROW LEVEL SECURITY');
    expect(migration).toContain('reject_append_only_mutation');
    expect(migration).toContain("'outcome_unknown'");
  });

  test('keeps research scope distinct and exposes an authorized resolver', () => {
    const apiScope = read('src/meri/meri-turn-scope.ts');
    const controller = read('src/research-portfolios/research-contexts.controller.ts');
    const adapter = read('src/research-portfolios/research-portfolio-meri-tools.service.ts');
    const meri = read('src/meri/meri.service.ts');
    expect(apiScope).toContain("'research_portfolio'");
    expect(controller).toContain("@Controller('research-contexts')");
    expect(controller).toContain("@Post('resolve')");
    expect(adapter).toContain('A valid conversationId for this Research Portfolio chat is required');
    expect(adapter).toContain('authorizeMeriResearchPortfolioScope');
    expect(adapter).toContain("'portfolioId'");
    expect(meri).toContain('A Research Portfolio conversation cannot be reassigned to a client scope.');
  });
});
