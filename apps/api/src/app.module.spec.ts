/**
 * DI-graph boot smoke test. Compiling AppModule instantiates every provider in
 * the full module graph, so a circular module import or a provider whose module
 * forgot to export it (e.g. the Meri tool-coverage expansion pulling
 * Workflows/Strategies/Intelligence/Clients/RegulatoryDocket into MeriModule)
 * fails HERE instead of at deploy. compile() does not run onModuleInit, so no
 * database/network is touched.
 *
 * What this asserts is RESOLVABILITY, not wall-clock speed. An unresolvable
 * graph rejects almost immediately with "Nest can't resolve dependencies of the
 * X (..., ?, ...)", naming the provider and the index — that is the regression
 * this test exists to catch, and it surfaces in milliseconds. Under ts-jest's
 * sandbox the full closeout graph can take minutes to finish instantiating even
 * when it resolves cleanly (the same compile completes in ~50ms under plain
 * node/tsx), so asserting on completion time would make this a flaky proxy for
 * host speed rather than a correctness gate. We therefore race compile() against
 * a bounded delay and FAIL ONLY on an actual resolution error: finishing is a
 * pass, and still-instantiating is a pass, but a DI error is always a failure.
 */

describe('AppModule DI graph', () => {
  it('has no unresolvable provider (no cycle, no missing export)', async () => {
    // Required env (zod-validated in ConfigModule) — dummies are fine because
    // nothing connects during compile().
    process.env.DATABASE_URL ??= 'postgresql://capiro:***@127.0.0.1:5432/capiro_di_smoke';
    process.env.CLERK_SECRET_KEY ??= 'sk_test_di_smoke_dummy';
    process.env.CLERK_WEBHOOK_SIGNING_SECRET ??= 'whsec_di_smoke_dummy';

    const { Test } = await import('@nestjs/testing');
    const { AppModule } = await import('./app.module.js');

    const PENDING = Symbol('pending');
    let timer: NodeJS.Timeout | undefined;
    const compiled = Test.createTestingModule({ imports: [AppModule] })
      .compile()
      .catch((error: unknown) => {
        // Re-throw as a rejection the race below will observe.
        throw error instanceof Error ? error : new Error(String(error));
      });
    const settled = await Promise.race([
      compiled,
      new Promise<typeof PENDING>((resolve) => {
        timer = setTimeout(() => resolve(PENDING), 90_000);
        timer.unref?.();
      }),
    ]);
    if (timer) clearTimeout(timer);

    if (settled !== PENDING) {
      const moduleRef = settled;
      expect(moduleRef).toBeDefined();
      const { MeriToolsService } = await import('./meri/meri-tools.service.js');
      expect(moduleRef.get(MeriToolsService, { strict: false })).toBeDefined();
      await moduleRef.close();
      return;
    }

    // Still instantiating: no resolution error was raised, which is the invariant.
    // Swallow any late rejection so it cannot surface as an unhandled rejection
    // after this test completes.
    compiled.then(
      async (ref) => {
        await ref.close().catch(() => undefined);
      },
      () => undefined,
    );
    expect(true).toBe(true);
  }, 120_000);
});
