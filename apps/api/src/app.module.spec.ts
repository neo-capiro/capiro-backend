/**
 * DI-graph boot smoke test. Compiling AppModule instantiates every provider in
 * the full module graph, so a circular module import or a provider whose module
 * forgot to export it (e.g. the Meri tool-coverage expansion pulling
 * Workflows/Strategies/Intelligence/Clients/RegulatoryDocket into MeriModule)
 * fails HERE instead of at deploy. compile() does not run onModuleInit, so no
 * database/network is touched.
 *
 * This test MUST assert that compile() actually completes, not merely that it
 * raises no error. An unresolved forwardRef cycle makes NestFactory.create()
 * never settle: it emits no error and rejects nothing, bootstrap()'s .catch never
 * fires, and the container exits 0 immediately after "Starting Capiro API" — which
 * ECS reports only as "essential container exited". That is exactly how the
 * governed candidate services deadlocked API boot, so a hang is a FAILURE here.
 */

describe('AppModule DI graph', () => {
  it('compiles with every provider resolvable (no cycle, no missing export)', async () => {
    // Required env (zod-validated in ConfigModule) — dummies are fine because
    // nothing connects during compile().
    process.env.DATABASE_URL ??= 'postgresql://capiro:***@127.0.0.1:5432/capiro_di_smoke';
    process.env.CLERK_SECRET_KEY ??= 'sk_test_di_smoke_dummy';
    process.env.CLERK_WEBHOOK_SIGNING_SECRET ??= 'whsec_di_smoke_dummy';

    const { Test } = await import('@nestjs/testing');
    const { AppModule } = await import('./app.module.js');

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    expect(moduleRef).toBeDefined();

    const { MeriToolsService } = await import('./meri/meri-tools.service.js');
    expect(moduleRef.get(MeriToolsService, { strict: false })).toBeDefined();

    await moduleRef.close();
  }, 180_000);
});
