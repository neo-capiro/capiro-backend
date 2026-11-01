jest.mock('../prisma/prisma.service.js', () => ({ PrismaService: class {} }));
import { GovernmentForecastsService } from './government-forecasts.service.js';
import { GovernmentForecastsController } from './government-forecasts.controller.js';
import { ROLES_KEY } from '../auth/roles.decorator.js';

describe('staff forecast reads', () => {
  function port(responses: unknown[][]) {
    const calls: unknown[] = [];
    const tx = {
      $queryRaw: jest.fn(async (query: unknown) => {
        calls.push(query);
        return responses.shift();
      }),
    };
    const prisma = { $transaction: jest.fn(async (fn: (tx: unknown) => unknown) => fn(tx)) };
    return { service: new GovernmentForecastsService(prisma as never), calls, prisma };
  }
  it('binds both endpoints to the existing staff role guard', () => {
    expect(Reflect.getMetadata(ROLES_KEY, GovernmentForecastsController)).toEqual([
      'standard_user',
    ]);
    expect(
      Reflect.getMetadata('__guards__', GovernmentForecastsController).map(
        (x: { name: string }) => x.name,
      ),
    ).toEqual(['RolesGuard']);
  });
  it('keeps a never-ingested catalog unavailable rather than claiming current empty coverage', async () => {
    const p = port([[], [{ total: 0n }], [], []]);
    expect(await p.service.list({ from: '2026-11-01', to: '2026-12-01' })).toMatchObject({
      items: [],
      total: 0,
      coverage: { lastCheckStatus: 'unavailable', lastSuccessfulCheckAt: null, edition: null },
    });
  });
  it('discloses rejected source records and a failed later check separately from successful observation', async () => {
    const at = new Date('2026-10-31T00:00:00Z'),
      later = new Date('2026-11-01T00:00:00Z');
    const p = port([
      [],
      [{ total: 0n }],
      [{ attempted_at: later, status: 'failed', edition: null }],
      [{ attempted_at: at, edition: '202510', accepted_count: 9, rejected_count: 2 }],
    ]);
    expect((await p.service.list({ from: '2026-11-01', to: '2026-12-01' })).coverage).toEqual({
      lastAttemptAt: later.toISOString(),
      lastSuccessfulCheckAt: at.toISOString(),
      lastCheckStatus: 'failed',
      edition: '202510',
      acceptedCount: 9,
      rejectedCount: 2,
      partial: true,
    });
  });
  it('rejects malformed range/history identity before querying', async () => {
    const p = port([]);
    await expect(p.service.list({ from: '2026-02-30', to: '2026-03-01' })).rejects.toThrow();
    await expect(p.service.history('other', {})).rejects.toThrow();
    expect(p.prisma.$transaction).not.toHaveBeenCalled();
  });
  it('unknown history is a missing record, never an empty successful history', async () => {
    const p = port([[{ total: 0n }]]);
    await expect(p.service.history('a'.repeat(64), {})).rejects.toThrow('not found');
  });
});
