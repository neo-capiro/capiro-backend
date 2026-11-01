import { LegiWatchWave2CoverageService } from './legiwatch-wave2-coverage.service.js';
import { LegiWatchWave2Controller } from './legiwatch-wave2.controller.js';

const id = (n: number) => `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`;
const actor = { tenantId: id(1), userId: id(2), clerkUserId: 'synthetic-clerk', role: 'standard_user' } as any;
const clientId = id(3);
const topic = (termTypes = ['bill'], jurisdictions: string[] = []) => ({ id: 'synthetic-topic', label: 'Synthetic topic', termTypes, jurisdictions });
function fixture() {
  const state = { member: true, wall: true, topics: [topic()], flatTerms: '0', issueAreas: [] as string[],
    saved: null as null | { tags: unknown[]; issueAreas: string[] }, sourceAt: new Date() as Date | null, afterSource: () => {} };
  const tx = {
    $queryRawUnsafe: jest.fn(async (sql: string, ...values: unknown[]) => {
      if (sql.includes('FROM tenants t')) {
        expect(values).toEqual([actor.tenantId, clientId, actor.clerkUserId, actor.userId]);
        return state.member ? [{ userId: actor.userId, memberId: id(4), role: 'standard_user', memberUpdatedAt: 1, clientUpdatedAt: 1 }] : [];
      }
      if (sql.includes('AS allowed')) return [{ allowed: state.wall }];
      expect(values).toEqual([actor.tenantId, clientId]);
      if (sql.includes('FROM intel_watchlist_topic')) {
        expect(sql).toContain('w.tenant_id=t.tenant_id'); expect(sql).toContain('term.tenant_id=w.tenant_id');
        expect(sql).toContain('term.watchlist_id=w.id'); expect(sql).toContain('w.active = true');
        return structuredClone(state.topics);
      }
      expect(sql).toContain('term.topic_id IS NULL'); expect(sql).toContain('w.active=true');
      return [{ issueAreas: state.issueAreas, flatTermCount: state.flatTerms }];
    }),
    clientWatchlist: { findFirst: jest.fn(async ({ where }: any) => { expect(where).toEqual({ tenantId: actor.tenantId, clientId }); return state.saved; }) },
  };
  const prisma: any = {
    withTenant: jest.fn(async (_tenant: string, read: any) => read(tx)), withSystem: jest.fn(async (read: any) => read(tx)),
    $queryRawUnsafe: jest.fn(async (sql: string) => {
      const at = state.sourceAt; state.afterSource();
      if (sql.includes('committee_source_exception')) return [{ count: 0 }];
      if (sql.includes('committee_source')) return [{ lastSuccessAt: at }];
      return [{ lastObservedAt: at }];
    }),
  };
  const hearings: any = { coverage: jest.fn(async () => ({ summary: { healthy: 1, degraded: 0, failing: 0, unknown: 0 } })) };
  const service = new LegiWatchWave2CoverageService(prisma, hearings), controller = new LegiWatchWave2Controller(service);
  return { state, tx, prisma, hearings, service, controller };
}
test('existing Intel topic coverage preserves explicit numerator and denominator with current access checks', async () => {
  const f = fixture(); const value = await f.service.watchlistCoverage(actor, clientId);
  expect(value).toMatchObject({ backend: 'intelligence', configuration: { model: 'intel_watchlist', configured: true, complete: true },
    overall: { totalConcepts: 1, coveredConcepts: 1, percentage: 100, status: 'COVERED' } });
  expect(f.tx.$queryRawUnsafe.mock.calls.filter(([sql]) => sql.includes('FROM tenants t'))).toHaveLength(2);
  expect(f.tx.clientWatchlist.findFirst).not.toHaveBeenCalled();
});
test.each(['core', 'intelligence'] as const)('%s empty saved configuration is NOT_CONFIGURED with null percentage', async backend => {
  const f = fixture(); f.state.topics = [];
  await expect(f.service.watchlistCoverage(actor, clientId, backend)).resolves.toMatchObject({
    backend, overall: { status: 'NOT_CONFIGURED', percentage: null, totalConcepts: 0 }, configuration: { configured: false } });
  expect(f.prisma.$queryRawUnsafe).not.toHaveBeenCalled();
});
test('Core saved tags and issue areas stay Core-owned and cannot appear unconfigured or use Intel health', async () => {
  const f = fixture(); f.state.saved = { tags: [{ tag: 'Synthetic criteria' }], issueAreas: ['Synthetic area'] };
  await expect(f.controller.watchlistCoverage(actor, clientId, { trackerBackend: 'core' })).resolves.toMatchObject({
    backend: 'core', overall: { status: 'UNSUPPORTED', percentage: null },
    configuration: { model: 'client_watchlist', configured: true, complete: false, tagCount: 1, issueAreaCount: 1, reason: 'CORE_WATCHLIST_MODEL_UNSUPPORTED' } });
  expect(f.prisma.withSystem).not.toHaveBeenCalled(); expect(f.prisma.$queryRawUnsafe).not.toHaveBeenCalled();
});
test.each(['flat', 'issue-area'])('Intel %s-only configuration is unsupported, never unconfigured', async kind => {
  const f = fixture(); f.state.topics = [];
  if (kind === 'flat') f.state.flatTerms = '2'; else f.state.issueAreas = ['Synthetic area'];
  await expect(f.service.watchlistCoverage(actor, clientId)).resolves.toMatchObject({
    overall: { status: 'UNSUPPORTED', percentage: null }, configuration: { configured: true, complete: false, reason: 'UNMAPPED_WATCHLIST_CONFIGURATION' } });
});
test('unrepresented flat configuration prevents a misleading complete topic percentage', async () => {
  const f = fixture(); f.state.flatTerms = '1';
  await expect(f.service.watchlistCoverage(actor, clientId)).resolves.toMatchObject({ overall: { status: 'PARTIAL', percentage: null, coveredConcepts: 1 } });
});
test.each(['STALE', 'UNAVAILABLE', 'UNSUPPORTED'] as const)('preserves %s source meaning', async status => {
  const f = fixture();
  if (status === 'STALE') f.state.sourceAt = new Date(Date.now() - 8 * 86400000);
  if (status === 'UNAVAILABLE') f.state.sourceAt = null;
  if (status === 'UNSUPPORTED') f.state.topics = [topic(['risk_phrase'])];
  await expect(f.service.watchlistCoverage(actor, clientId)).resolves.toMatchObject({ overall: { status }, concepts: [{ status }] });
});
test('state bill monitoring requires existing state sync health rather than federal success', async () => {
  const f = fixture(); f.state.topics = [topic(['bill'], ['FL'])];
  const value = await f.service.watchlistCoverage(actor, clientId);
  expect(value.concepts[0]!.signalFamilies).toEqual(['state_bill']);
  expect(f.prisma.$queryRawUnsafe.mock.calls[0][1]).toBe('sync-openstates');
});
test('hearing monitoring reuses the existing source catalog', async () => {
  const f = fixture(); f.state.topics = [topic(['committee'])];
  await expect(f.service.watchlistCoverage(actor, clientId)).resolves.toMatchObject({ sourceHealth: { healthy: 1 } });
  expect(f.hearings.coverage).toHaveBeenCalledTimes(1);
});
test.each(['member', 'wall', 'configuration'])('post-await %s change withholds all coverage', async change => {
  const f = fixture(); f.state.afterSource = () => {
    if (change === 'member') f.state.member = false;
    if (change === 'wall') f.state.wall = false;
    if (change === 'configuration') f.state.topics = [];
  };
  await expect(f.service.watchlistCoverage(actor, clientId)).rejects.toMatchObject({ status: change === 'configuration' ? 503 : 404 });
});
test('denied access performs no watchlist or source read; closed selector and no-store metadata remain', async () => {
  const f = fixture(); f.state.wall = false;
  await expect(f.service.watchlistCoverage(actor, clientId)).rejects.toMatchObject({ status: 404 });
  expect(f.prisma.withSystem).not.toHaveBeenCalled(); expect(f.prisma.$queryRawUnsafe).not.toHaveBeenCalled();
  for (const query of [{ trackerBackend: ['core', 'intelligence'] }, { trackerBackend: 'other' }, { userId: id(5) }])
    expect(() => f.controller.watchlistCoverage(actor, clientId, query)).toThrow('Invalid coverage backend');
  expect(Reflect.getMetadata('__headers__', LegiWatchWave2Controller.prototype.watchlistCoverage)).toEqual([{ name: 'Cache-Control', value: 'private, no-store' }]);
});
