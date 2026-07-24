import { Test } from '@nestjs/testing';
import { AppModule } from './app.module.js';

/**
 * A real Nest DI container compile of the ENTIRE app — every module wired
 * together exactly as main.ts assembles them. Unlike the per-service specs
 * (which construct one service with hand-built fakes and can't see a module
 * forgetting to export/import a provider another module needs), this catches
 * wiring bugs: missing exports, unresolvable constructor deps, circular
 * imports Nest can't resolve, duplicate provider tokens.
 *
 * `.compile()` builds the graph and instantiates every provider's constructor
 * but does NOT run lifecycle hooks (onModuleInit/onModuleDestroy) — those only
 * fire on `.init()`. So PrismaService's `$connect()` never runs here; no live
 * DB, Clerk, or Anthropic credential is required. DATABASE_URL still has to be
 * present (Prisma's constructor parses the datasource URL eagerly), and
 * CLERK_SECRET_KEY is stubbed by jest.setup.ts for the same reason.
 */
describe('AppModule (full DI graph)', () => {
  const priorDatabaseUrl = process.env.DATABASE_URL;

  beforeAll(() => {
    if (!process.env.DATABASE_URL) {
      process.env.DATABASE_URL = 'postgresql://jest:jest@localhost:5432/jest_di_boot_only';
    }
  });

  afterAll(() => {
    process.env.DATABASE_URL = priorDatabaseUrl;
  });

  it('compiles every module (Strategy, Agents, Context, Meri, Flags, Firm-phases, Reference, Auth, Health) without a live DB or external credential', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    expect(moduleRef).toBeDefined();
    await moduleRef.close();
  });
});
