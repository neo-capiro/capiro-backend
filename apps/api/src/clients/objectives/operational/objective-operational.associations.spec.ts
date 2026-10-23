import { readObjectivePlanResource, type TenantContext } from '@capiro/shared';
import type { PrismaService } from '../../../prisma/prisma.service.js';
import {
  readObjectiveLocalResource,
  validateObjectiveCycleContext,
} from './objective-local-resources.js';
import { ObjectiveOperationalService } from './objective-operational.service.js';
import {
  listOperationalLinks,
  loadCurrentOperationalScopeWithinTx,
  readOperationalSetVersion,
} from './objective-operational.store.js';
import {
  operationalFailure,
  parseOperationalAssociationsQuery,
} from './objective-operational.rules.js';
import type {
  OperationalAssociationsRequest,
  OperationalScope,
  OperationalResourceKind,
} from './objective-operational.types.js';

jest.mock('@capiro/shared', () => ({ readObjectivePlanResource: jest.fn() }));
jest.mock('../../../prisma/prisma.service.js', () => ({ PrismaService: class {} }));
jest.mock('./objective-local-resources.js', () => ({
  readObjectiveLocalResource: jest.fn(),
  validateObjectiveCycleContext: jest.fn(),
}));
jest.mock('./objective-operational.store.js', () => ({
  listOperationalLinks: jest.fn(),
  loadCurrentOperationalScopeWithinTx: jest.fn(),
  readOperationalSetVersion: jest.fn(),
}));
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const actor = {
  tenantId: id(1),
  userId: id(2),
  clerkUserId: 'synthetic',
  tenantSlug: 'synthetic',
  role: 'standard_user',
} as TenantContext;
const scope: OperationalScope = {
  clientId: id(3),
  objectiveId: id(4),
  currentRevisionId: id(5),
  objectiveVersion: 2,
  objectiveStatus: 'ready',
  ownerUserId: actor.userId,
};
const read: OperationalAssociationsRequest = {
  schemaVersion: 1,
  clientId: scope.clientId,
  objectiveId: scope.objectiveId,
  limit: 2,
  cursor: null,
};
const links = (
  [
    'strategy',
    'planner_project',
    'planner_task',
    'outreach_session',
    'meeting',
  ] as OperationalResourceKind[]
).map((kind, n) => ({
  id: id(10 + n),
  resourceKind: kind,
  resourceId: id(20 + n),
  linkedRevisionId: id(5),
  linkedObjectiveVersion: 2,
  linkedAt: new Date('2026-10-15T00:00:00Z'),
  cycles: [],
  removedAt: null,
}));
function fixture() {
  const tx = { $executeRaw: jest.fn(async () => 1) };
  const withTenant = jest.fn(async (_tenant, action) => action(tx));
  jest.mocked(loadCurrentOperationalScopeWithinTx).mockResolvedValue(scope);
  jest.mocked(readOperationalSetVersion).mockResolvedValue(7);
  jest
    .mocked(listOperationalLinks)
    .mockImplementation(async (_tx, _actor, _scope, page) =>
      links.slice(page!.offset, page!.offset + page!.limit),
    );
  const source = async (
    _tx: unknown,
    _actor: unknown,
    _binding: unknown,
    selection: { id: string; kind: string },
  ) => ({
    resource: {
      selection,
      title: 'Synthetic current work',
      ownerVersion: { kind: 'counter', value: 3 },
      observedAt: '2026-10-23T12:00:00Z',
    },
    startsAt: '2020-01-01T00:00:00Z',
    pendingProposals: [],
    tasks: [],
  });
  jest.mocked(readObjectivePlanResource).mockImplementation(source as any);
  jest.mocked(readObjectiveLocalResource).mockImplementation(source as any);
  jest.mocked(validateObjectiveCycleContext).mockResolvedValue(true);
  return {
    service: new ObjectiveOperationalService({ withTenant } as unknown as PrismaService),
    tx,
    withTenant,
  };
}
beforeEach(() => jest.resetAllMocks());

it('bounds the actual store query while preserving legacy unpaged callers', async () => {
  const store = jest.requireActual<typeof import('./objective-operational.store.js')>(
    './objective-operational.store.js',
  );
  const query = jest.fn(async (..._args: unknown[]) => []);
  const tx = { $queryRaw: query } as any;
  await store.listOperationalLinks(tx, actor, scope, { limit: 3, offset: 2 });
  const [template, ...parameters] = query.mock.calls[0]!;
  expect(String(template)).toContain('LIMIT');
  expect(String(template)).toContain('OFFSET');
  expect(parameters).toEqual([actor.tenantId, scope.clientId, scope.objectiveId, 3, 2]);
  await store.listOperationalLinks(tx, actor, scope);
  expect(query.mock.calls[1]!.slice(-2)).toEqual([null, 0]);
});

it('lists every readable manual kind in bounded pages without pending or future filters', async () => {
  const { service, tx } = fixture();
  const first = await service.associations(actor, read);
  const second = await service.associations(actor, { ...read, cursor: first.nextCursor });
  const third = await service.associations(actor, { ...read, cursor: second.nextCursor });
  expect(
    [...first.items, ...second.items, ...third.items].map((row) => row.resource.selection.kind),
  ).toEqual(links.map((row) => row.resourceKind));
  expect(first.pageCoverage).toBe('complete');
  expect(third.nextCursor).toBeNull();
  expect(listOperationalLinks).toHaveBeenNthCalledWith(2, tx, actor, scope, {
    limit: 3,
    offset: 2,
  });
  expect(loadCurrentOperationalScopeWithinTx).toHaveBeenCalledTimes(3);
  expect(
    tx.$executeRaw.mock.calls.some(([sql]) => String(sql).includes('pg_advisory_xact_lock_shared')),
  ).toBe(true);
});
it('omits hidden source identity and retains paging over the bounded underlying positions', async () => {
  const { service } = fixture();
  jest.mocked(readObjectivePlanResource).mockResolvedValueOnce(null);
  const first = await service.associations(actor, read);
  expect(first.pageCoverage).toBe('partial');
  expect(first.items).toHaveLength(1);
  expect(JSON.stringify(first)).not.toContain(links[0]!.resourceId);
  expect(JSON.stringify(first)).not.toContain(links[0]!.id);
  expect(first).not.toHaveProperty('total');
  expect(
    (await service.associations(actor, { ...read, cursor: first.nextCursor })).items[0]!.resource
      .selection.kind,
  ).toBe('planner_task');
});
it('rejects cursor drift across set, Objective revision, actor, tenant, limit, restart and tampering', async () => {
  const { service } = fixture();
  const cursor = (await service.associations(actor, read)).nextCursor!;
  jest.mocked(readOperationalSetVersion).mockResolvedValue(8);
  await expect(service.associations(actor, { ...read, cursor })).rejects.toMatchObject({
    response: { code: 'CURSOR_STALE' },
  });
  jest.mocked(readOperationalSetVersion).mockResolvedValue(7);
  jest
    .mocked(loadCurrentOperationalScopeWithinTx)
    .mockResolvedValue({ ...scope, currentRevisionId: id(90) });
  await expect(service.associations(actor, { ...read, cursor })).rejects.toMatchObject({
    response: { code: 'CURSOR_STALE' },
  });
  jest.mocked(loadCurrentOperationalScopeWithinTx).mockResolvedValue(scope);
  for (const changed of [
    { ...actor, userId: id(90) },
    { ...actor, tenantId: id(90) },
  ])
    await expect(service.associations(changed, { ...read, cursor })).rejects.toMatchObject({
      response: { code: 'CURSOR_STALE' },
    });
  await expect(service.associations(actor, { ...read, cursor, limit: 1 })).rejects.toMatchObject({
    response: { code: 'CURSOR_STALE' },
  });
  await expect(
    service.associations(actor, { ...read, cursor: cursor + 'x' }),
  ).rejects.toMatchObject({ response: { code: 'CURSOR_STALE' } });
  await expect(fixture().service.associations(actor, { ...read, cursor })).rejects.toMatchObject({
    response: { code: 'CURSOR_STALE' },
  });
});
it('rechecks the canonical wall before source reads and hides unreadable annotation contexts', async () => {
  const { service } = fixture();
  jest
    .mocked(loadCurrentOperationalScopeWithinTx)
    .mockImplementationOnce(async () => operationalFailure('NOT_AVAILABLE'));
  await expect(service.associations(actor, read)).rejects.toMatchObject({
    response: { code: 'NOT_AVAILABLE' },
  });
  expect(readObjectivePlanResource).not.toHaveBeenCalled();
  const cycle = {
    fiscalYear: 2028,
    authorityTrack: null,
    basis: 'human_annotation' as const,
    context: { kind: 'budget_package' as const, id: id(55) },
  };
  jest.mocked(listOperationalLinks).mockResolvedValue([{ ...links[0]!, cycles: [cycle] }]);
  jest.mocked(validateObjectiveCycleContext).mockResolvedValue(false);
  const page = await service.associations(actor, read);
  expect(page.items).toEqual([]);
  expect(page.pageCoverage).toBe('partial');
  expect(JSON.stringify(page)).not.toContain(cycle.context.id);
});
it('parses only the bounded explicit public query without authority input', () => {
  const query = { schemaVersion: '1', objectiveId: read.objectiveId, limit: '2' };
  expect(parseOperationalAssociationsQuery(read.clientId, query)).toEqual(read);
  for (const change of [
    { limit: '0' },
    { limit: '101' },
    { limit: '02' },
    { limit: 2 },
    { cursor: '' },
    { tenantId: id(1) },
    { schemaVersion: ['1', '1'] },
  ])
    expect(() =>
      parseOperationalAssociationsQuery(read.clientId, { ...query, ...change }),
    ).toThrow();
});
