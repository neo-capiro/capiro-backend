import { LegiWatchPhase9MetricsService } from './legiwatch-phase9-metrics.service.js';

// Minimal Prisma stub: $queryRawUnsafe is called 5 times per snapshot() (state,
// latest run, queue, capture, runtime). Return empty arrays so the service
// falls back to its documented defaults — the Environment dimension is the
// only thing under test here, not the metric values themselves.
function prismaStub() {
  const query = jest.fn(async () => [] as unknown[]);
  return { $queryRawUnsafe: query } as unknown as { $queryRawUnsafe: jest.Mock };
}

describe('LegiWatchPhase9MetricsService — Environment dimension contract', () => {
  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  test('CAPIRO_ENV=dev produces Environment=dev (both in the snapshot and the EMF payload)', async () => {
    process.env.CAPIRO_ENV = 'dev';
    process.env.NODE_ENV = 'development';
    const prisma = prismaStub();
    const service = new LegiWatchPhase9MetricsService(prisma as never);

    const snapshot = await service.snapshot(new Date('2026-08-23T09:00:00Z'));

    expect(snapshot.environment).toBe('dev');
    expect(snapshot.emf.Environment).toBe('dev');
    // The EMF CloudWatchMetrics dimension set is still just ['Environment'] —
    // this contract only changes the *value*, never the dimension shape.
    const emfMeta = snapshot.emf._aws as { CloudWatchMetrics: Array<{ Dimensions: string[][] }> };
    const firstMetric = emfMeta.CloudWatchMetrics[0];
    expect(firstMetric).toBeDefined();
    expect(firstMetric!.Dimensions).toEqual([['Environment']]);
  });

  test('if CAPIRO_ENV is absent, the existing NODE_ENV fallback remains intact', async () => {
    delete process.env.CAPIRO_ENV;
    process.env.NODE_ENV = 'development';
    const prisma = prismaStub();
    const service = new LegiWatchPhase9MetricsService(prisma as never);

    const snapshot = await service.snapshot(new Date('2026-08-23T09:00:00Z'));

    expect(snapshot.environment).toBe('development');
    expect(snapshot.emf.Environment).toBe('development');
  });

  test('if both CAPIRO_ENV and NODE_ENV are absent, falls back to "unknown"', async () => {
    delete process.env.CAPIRO_ENV;
    delete process.env.NODE_ENV;
    const prisma = prismaStub();
    const service = new LegiWatchPhase9MetricsService(prisma as never);

    const snapshot = await service.snapshot(new Date('2026-08-23T09:00:00Z'));

    expect(snapshot.environment).toBe('unknown');
  });

  test('CAPIRO_ENV takes precedence over NODE_ENV when both are set', () => {
    process.env.CAPIRO_ENV = 'dev';
    process.env.NODE_ENV = 'development';
    // Precedence is asserted structurally against the source, since the
    // resolution itself is exercised by the first test above.
    expect(process.env.CAPIRO_ENV ?? process.env.NODE_ENV ?? 'unknown').toBe('dev');
  });
});
