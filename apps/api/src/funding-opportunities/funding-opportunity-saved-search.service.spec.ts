import { BadRequestException, NotFoundException } from '@nestjs/common';
import { FundingOpportunitySavedSearchService } from './funding-opportunity-saved-search.service.js';

const TENANT = '00000000-0000-4000-8000-000000000001';
const OTHER_TENANT = '00000000-0000-4000-8000-000000000002';
const OWNER = '00000000-0000-4000-8000-000000000011';
const READER = '00000000-0000-4000-8000-000000000012';
const ADMIN = '00000000-0000-4000-8000-000000000013';
const CLIENT_A = '00000000-0000-4000-8000-000000000021';
const CLIENT_B = '00000000-0000-4000-8000-000000000022';

const criteria = {
  schemaVersion: 2,
  mode: 'all',
  clientId: CLIENT_A,
  query: '  autonomous ground vehicle  ',
  sources: ['sam_gov'],
  types: ['solicitation'],
  lifecycle: ['active', 'forecast'],
  agencies: ['Army'],
  sectors: ['defense'],
  naicsCodes: ['541715'],
  pscCodes: ['R425'],
  setAsideCodes: [],
  eligibility: [],
  posted: [],
  geography: ['VA'],
  applicantTypes: [],
  funding: [],
  costShare: [],
  methods: [],
  disbursement: [],
  grantPrerequisites: [],
  codes: [],
  deadlineWindow: '90d',
  deadlineFrom: '2026-09-20',
  deadlineTo: '2026-12-20',
  sort: 'deadline',
  direction: 'asc',
  page: 1,
  pageSize: 50,
};

type Row = {
  id: string;
  tenantId: string;
  clientId: string | null;
  isTenantWide: boolean;
  name: string;
  description: string | null;
  opportunityTypes: string[];
  query: string;
  criteriaJson: unknown;
  sort: string;
  pageSize: number;
  matchMode: string;
  ownerId: string;
  visibility: string;
  alertsEnabled: boolean;
  alertCadence: string | null;
  alertChannels: string[];
  alertDeadlineThreshold: number | null;
  alertNewVsChanged: boolean;
  lastEvaluatedAt: Date | null;
  lastNotifiedAt: Date | null;
  lastAppliedAt: Date | null;
  lastRunResultCount: number | null;
  createdAt: Date;
  updatedAt: Date;
  schemaVersion: number;
  archivedAt: Date | null;
  originalCriteriaJson: unknown;
  migrationWarnings: unknown;
};

function row(overrides: Partial<Row> = {}): Row {
  const now = new Date('2026-09-16T12:00:00.000Z');
  return {
    id: '00000000-0000-4000-8000-000000000031',
    tenantId: TENANT,
    clientId: CLIENT_A,
    isTenantWide: false,
    name: 'AGV search',
    description: null,
    opportunityTypes: ['solicitation'],
    query: 'autonomous ground vehicle',
    criteriaJson: criteria,
    sort: 'deadline',
    pageSize: 50,
    matchMode: 'all',
    ownerId: OWNER,
    visibility: 'private',
    alertsEnabled: false,
    alertCadence: null,
    alertChannels: [],
    alertDeadlineThreshold: null,
    alertNewVsChanged: false,
    lastEvaluatedAt: null,
    lastNotifiedAt: null,
    lastAppliedAt: null,
    lastRunResultCount: null,
    createdAt: now,
    updatedAt: now,
    schemaVersion: 2,
    archivedAt: null,
    originalCriteriaJson: null,
    migrationWarnings: [],
    ...overrides,
  };
}

function makeHarness(initial: Row[] = []) {
  const rows = [...initial];
  let sequence = 100;
  const clients = new Map([
    [CLIENT_A, { id: CLIENT_A, tenantId: TENANT, status: 'active', profileStatus: 'ACTIVE', memoryWall: false }],
    [CLIENT_B, { id: CLIENT_B, tenantId: TENANT, status: 'active', profileStatus: 'ACTIVE', memoryWall: false }],
  ]);
  const membership = new Set([`${TENANT}:${OWNER}`, `${TENANT}:${READER}`, `${TENANT}:${ADMIN}`]);
  const team = new Set([`${TENANT}:${CLIENT_A}:${OWNER}`, `${TENANT}:${CLIENT_A}:${READER}`]);
  const tx = {
    savedOpportunitySearch: {
      findMany: async ({ where }: any) => rows.filter((r) => {
        if (r.tenantId !== where.tenantId) return false;
        if (where.OR) return where.OR.some((clause: any) => r.clientId === clause.clientId);
        return r.clientId === where.clientId;
      }),
      findFirst: async ({ where }: any) => rows.find((r) => r.tenantId === where.tenantId && r.id === where.id) ?? null,
      create: async ({ data }: any) => {
        const created = row({ ...data, id: `00000000-0000-4000-8000-${String(sequence++).padStart(12, '0')}`, createdAt: new Date(), updatedAt: new Date() });
        rows.push(created);
        return created;
      },
      update: async ({ where, data }: any) => {
        const found = rows.find((r) => r.id === where.id);
        if (!found) throw new Error('missing');
        Object.assign(found, data, { updatedAt: new Date() });
        return found;
      },
      delete: async ({ where }: any) => {
        const index = rows.findIndex((r) => r.id === where.id);
        if (index < 0) throw new Error('missing');
        return rows.splice(index, 1)[0];
      },
    },
    tenantMembership: {
      findFirst: async ({ where }: any) => membership.has(`${where.tenantId}:${where.userId}`) ? { id: 'membership' } : null,
    },
    client: {
      findFirst: async ({ where }: any) => {
        const client = clients.get(where.id);
        return client && client.tenantId === where.tenantId ? client : null;
      },
      findMany: async ({ where }: any) => [...clients.values()].filter((client) => client.tenantId === where.tenantId && client.status !== 'archived' && client.profileStatus === 'ACTIVE'),
    },
    clientMemoryAccess: {
      findMany: async () => [],
    },
    clientTeamMember: {
      findFirst: async ({ where }: any) => team.has(`${where.tenantId}:${where.clientId}:${where.userId}`) ? { id: 'team' } : null,
    },
  };
  const prisma = {
    withTenantUser: async (tenantId: string, userId: string, callback: (value: typeof tx) => unknown) => {
      if (tenantId !== TENANT && tenantId !== OTHER_TENANT) throw new Error('unexpected tenant');
      void userId;
      return callback(tx);
    },
  };
  return { service: new FundingOpportunitySavedSearchService(prisma as never), rows, clients };
}

const ctx = (userId: string, role: 'standard_user' | 'user_admin' | 'capiro_admin' = 'standard_user') => ({ tenantId: TENANT, userId, role } as any);

describe('FundingOpportunitySavedSearchService', () => {
  it('normalizes and persists query, ALL criteria, typed scalar projections, and migration preservation', async () => {
    const { service, rows } = makeHarness();
    const original = { ...criteria, query: ' autonomous ground vehicle ', retiredFilter: ['legacy'] };

    const saved = await service.create(ctx(OWNER), {
      name: '  AGV search  ',
      description: 'keep the keyword',
      visibility: 'private',
      clientId: CLIENT_A,
      criteria: original,
    });

    expect(saved.criteria.mode).toBe('all');
    expect(saved.criteria.query).toBe('autonomous ground vehicle');
    expect(rows[0]).toMatchObject({
      tenantId: TENANT,
      clientId: CLIENT_A,
      isTenantWide: false,
      opportunityTypes: ['solicitation'],
      query: 'autonomous ground vehicle',
      sort: 'deadline',
      pageSize: 50,
      matchMode: 'all',
      ownerId: OWNER,
      originalCriteriaJson: original,
    });
    expect(rows[0]!.migrationWarnings).toEqual([{ key: 'retiredFilter', reason: 'unsupported' }]);
  });

  it('persists explicit queryMatch while leaving legacy criteria omitted', async () => {
    const { service, rows } = makeHarness();
    const saved = await service.create(ctx(OWNER), {
      name: 'Keyword search', visibility: 'private', clientId: CLIENT_A,
      criteria: { ...criteria, query: 'aircraft propulsion', queryMatch: 'keywords' },
    });
    expect(saved.criteria.queryMatch).toBe('keywords');
    expect(rows[0]!.criteriaJson).toMatchObject({ queryMatch: 'keywords' });

    const legacy = await service.create(ctx(OWNER), {
      name: 'Legacy phrase search', visibility: 'private', clientId: CLIENT_A,
      criteria: { ...criteria, query: 'aircraft propulsion' },
    });
    expect(legacy.criteria).not.toHaveProperty('queryMatch');
  });

  it('keeps tenant-wide searches explicitly identifiable and retains empty query', async () => {
    const { service, rows } = makeHarness();
    await service.create(ctx(OWNER), {
      name: 'All active opportunities', visibility: 'tenant', clientId: null,
      criteria: { ...criteria, clientId: null, mode: 'all', query: '' },
    });
    expect(rows[0]).toMatchObject({ clientId: null, isTenantWide: true, query: '', matchMode: 'all' });
  });

  it('does not expose private rows or another client through list/get/apply', async () => {
    const privateRow = row();
    const otherClientRow = row({ id: '00000000-0000-4000-8000-000000000032', clientId: CLIENT_B, visibility: 'tenant' });
    const { service } = makeHarness([privateRow, otherClientRow]);

    await expect(service.get(ctx(READER), privateRow.id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.apply(ctx(READER), privateRow.id, async () => ({ opportunities: [] }))).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.list(ctx(READER), CLIENT_B)).resolves.toEqual({ searches: [expect.objectContaining({ id: otherClientRow.id })] });
    await expect(service.list(ctx(READER), CLIENT_A)).resolves.toEqual({ searches: [] });
  });

  it('includes tenant-wide rows with the selected client but excludes other client rows', async () => {
    const tenantWide = row({ id: '00000000-0000-4000-8000-000000000033', clientId: null, isTenantWide: true, visibility: 'tenant' });
    const clientB = row({ id: '00000000-0000-4000-8000-000000000034', clientId: CLIENT_B, visibility: 'tenant' });
    const { service } = makeHarness([tenantWide, clientB]);

    await expect(service.list(ctx(READER), CLIENT_A)).resolves.toEqual({
      searches: [expect.objectContaining({ id: tenantWide.id, clientId: null, isTenantWide: true })],
    });
    await expect(service.list(ctx(READER))).resolves.toEqual({
      searches: [expect.objectContaining({ id: tenantWide.id })],
    });
  });

  it('requires the owner or an established admin role for writes, including delete', async () => {
    const existing = row({ visibility: 'tenant' });
    const { service, rows } = makeHarness([existing]);

    await expect(service.update(ctx(READER), existing.id, { name: 'reader rename' })).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.remove(ctx(READER), existing.id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.update(ctx(ADMIN, 'user_admin'), existing.id, { name: 'admin rename' })).resolves.toEqual(expect.objectContaining({ name: 'admin rename' }));
    await service.remove(ctx(ADMIN, 'user_admin'), existing.id);
    expect(rows).toHaveLength(0);
  });

  it('re-authorizes apply, restores complete criteria, and updates apply metadata without duplicating rows', async () => {
    const existing = row({ visibility: 'tenant' });
    const { service, rows } = makeHarness([existing]);
    const executor = jest.fn(async (restored: unknown) => ({ opportunities: [{ id: 'op-1' }], total: 1, criteria: restored }));

    const first = await service.apply(ctx(READER), existing.id, executor);
    const second = await service.apply(ctx(READER), existing.id, executor);

    expect(executor).toHaveBeenNthCalledWith(1, ctx(READER), expect.objectContaining({ query: 'autonomous ground vehicle', deadlineFrom: '2026-09-20T00:00:00.000Z', deadlineTo: '2026-12-20T00:00:00.000Z' }));
    expect(executor).toHaveBeenNthCalledWith(2, ctx(READER), expect.objectContaining({ query: 'autonomous ground vehicle', deadlineFrom: '2026-09-20T00:00:00.000Z', deadlineTo: '2026-12-20T00:00:00.000Z' }));
    expect(first.opportunities).toEqual([{ id: 'op-1' }]);
    expect(first.search.criteria.query).toBe('autonomous ground vehicle');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.lastAppliedAt).toBeInstanceOf(Date);
    expect(rows[0]!.lastRunResultCount).toBe(1);
  });

  it('duplicates only an authorized source and makes the new row owned by the actor', async () => {
    const existing = row({ visibility: 'tenant' });
    const { service, rows } = makeHarness([existing]);
    await expect(service.duplicate(ctx(READER), existing.id)).rejects.toBeInstanceOf(NotFoundException);
    const duplicate = await service.duplicate(ctx(OWNER), existing.id, 'AGV copy');
    expect(duplicate).toEqual(expect.objectContaining({ name: 'AGV copy', createdByUserId: OWNER }));
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ ownerId: OWNER, clientId: CLIENT_A, query: 'autonomous ground vehicle' });
  });

  it('does not disclose rows across tenants and refuses owner mutation after client access is revoked', async () => {
    const existing = row({ visibility: 'tenant' });
    const { service, clients } = makeHarness([existing]);
    await expect(service.get({ tenantId: OTHER_TENANT, userId: OWNER, role: 'standard_user' }, existing.id)).rejects.toBeInstanceOf(NotFoundException);
    clients.set(CLIENT_A, { id: CLIENT_A, tenantId: TENANT, status: 'active', profileStatus: 'ACTIVE', memoryWall: true });
    await expect(service.remove(ctx(OWNER), existing.id)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('keeps criteria clientId and scalar scope synchronized when reassigned', async () => {
    const existing = row({ visibility: 'tenant' });
    const { service, rows } = makeHarness([existing]);
    await service.update(ctx(OWNER), existing.id, { clientId: CLIENT_B });
    expect(rows[0]).toMatchObject({ clientId: CLIENT_B, isTenantWide: false });
    expect((rows[0]!.criteriaJson as any).clientId).toBe(CLIENT_B);
  });

  it('refuses future criteria schemas and future scalar rows without laundering their raw criteria', async () => {
    const futureCriteria = { ...criteria, schemaVersion: 99, futureFilter: 'keep-me' };
    const future = row({ criteriaJson: futureCriteria, schemaVersion: 99, originalCriteriaJson: futureCriteria });
    const scalarFuture = row({ id: '00000000-0000-4000-8000-000000000035', criteriaJson: criteria, schemaVersion: 99 });
    const { service, rows } = makeHarness([future, scalarFuture]);

    await expect(service.get(ctx(OWNER), future.id)).resolves.toEqual(expect.objectContaining({
      schemaVersion: 2,
      warnings: expect.arrayContaining([
        { key: 'schemaVersion', reason: 'unsupported' },
        { key: 'futureFilter', reason: 'unsupported' },
      ]),
      originalCriteriaJson: futureCriteria,
    }));
    await expect(service.update(ctx(OWNER), future.id, { name: 'renamed future search' })).resolves.toEqual(expect.objectContaining({
      name: 'renamed future search', originalCriteriaJson: futureCriteria,
    }));
    await expect(service.apply(ctx(OWNER), future.id, async () => ({ total: 1 }))).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.get(ctx(OWNER), scalarFuture.id)).resolves.toEqual(expect.objectContaining({
      schemaVersion: 2,
      warnings: [{ key: 'schemaVersion', reason: 'unsupported' }],
      originalCriteriaJson: criteria,
    }));
    await expect(service.update(ctx(OWNER), scalarFuture.id, { name: 'renamed scalar future' })).resolves.toEqual(expect.objectContaining({
      name: 'renamed scalar future',
      schemaVersion: 2,
      warnings: [{ key: 'schemaVersion', reason: 'unsupported' }],
      originalCriteriaJson: criteria,
    }));
    expect(rows.find((candidate) => candidate.id === scalarFuture.id)).toMatchObject({ schemaVersion: 99, criteriaJson: criteria });
    const scalarDuplicate = await service.duplicate(ctx(OWNER), scalarFuture.id, 'Scalar future copy');
    expect(scalarDuplicate).toEqual(expect.objectContaining({
      warnings: [{ key: 'schemaVersion', reason: 'unsupported' }],
      originalCriteriaJson: criteria,
    }));
    await expect(service.apply(ctx(OWNER), scalarFuture.id, async () => ({ total: 1 }))).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.apply(ctx(OWNER), scalarDuplicate.id, async () => ({ total: 1 }))).rejects.toBeInstanceOf(BadRequestException);
  });

  it('accepts compatible v1 rows and keeps unknown executor totals null', async () => {
    const v1 = row({ criteriaJson: { ...criteria, schemaVersion: 1 }, schemaVersion: 1 });
    const unknownTotal = row({ id: '00000000-0000-4000-8000-000000000036' });
    const { service, rows } = makeHarness([v1, unknownTotal]);

    await expect(service.get(ctx(OWNER), v1.id)).resolves.toEqual(expect.objectContaining({ schemaVersion: 2, warnings: [] }));
    const appliedV1 = await service.apply(ctx(OWNER), v1.id, async () => ({ total: 0, opportunities: [] }));
    expect(appliedV1.search.lastRunResultCount).toBe(0);
    const appliedUnknown = await service.apply(ctx(OWNER), unknownTotal.id, async () => ({ opportunities: [] }));
    expect(appliedUnknown.search.lastRunResultCount).toBeNull();
    expect(rows.find((candidate) => candidate.id === unknownTotal.id)?.lastRunResultCount).toBeNull();
  });

  it('clears unsupported raw evidence when a caller explicitly replaces criteria with valid v2', async () => {
    const unsafe = row({ criteriaJson: { ...criteria, retiredFilter: 'unsafe' }, originalCriteriaJson: { ...criteria, retiredFilter: 'unsafe' }, migrationWarnings: [{ key: 'retiredFilter', reason: 'unsupported' }] });
    const { service } = makeHarness([unsafe]);

    const replaced = await service.update(ctx(OWNER), unsafe.id, { criteria: { ...criteria, query: 'replacement' } });
    expect(replaced).toEqual(expect.objectContaining({ schemaVersion: 2, warnings: [], originalCriteriaJson: null }));
    await expect(service.apply(ctx(OWNER), unsafe.id, async () => ({ total: 0 }))).resolves.toEqual(expect.objectContaining({
      search: expect.objectContaining({ criteria: expect.objectContaining({ query: 'replacement' }) }),
    }));
  });

  it('retains an archived client search for its owner without treating the archived client as active', async () => {
    const archived = row({ archivedAt: new Date('2026-09-15T00:00:00.000Z') });
    const { service, clients } = makeHarness([archived]);
    clients.set(CLIENT_A, { id: CLIENT_A, tenantId: TENANT, status: 'archived', profileStatus: 'ACTIVE', memoryWall: false });

    await expect(service.get(ctx(OWNER), archived.id)).resolves.toEqual(expect.objectContaining({ clientId: CLIENT_A, archivedAt: expect.any(String) }));
    await expect(service.list(ctx(READER), CLIENT_A)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.get(ctx(ADMIN, 'user_admin'), archived.id)).resolves.toEqual(expect.objectContaining({ clientId: CLIENT_A }));
  });
});
