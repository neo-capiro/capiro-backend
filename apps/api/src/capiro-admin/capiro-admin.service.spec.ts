import { describe, expect, jest, test, beforeEach } from '@jest/globals';
import { NotFoundException } from '@nestjs/common';

// @clerk/backend pulls in a `#crypto` subpath import that jest's resolver can't
// follow. CapiroAdminService imports clerk.service transitively (constructor dep),
// but the SDK is never exercised here — stub the module so the import is cheap.
jest.mock('@clerk/backend', () => ({
  __esModule: true,
  createClerkClient: () => ({}),
  verifyToken: async () => ({}),
}));

import { CapiroAdminService } from './capiro-admin.service.js';

/**
 * Step 3.5 analyst-console specs. Pure mock-prisma (no DB). The review queues +
 * quarantine tables are global (read via the base client mock); audit_logs is
 * tenant-scoped, so the `withTenant` mock just runs the callback with the same
 * mock acting as the transactional client.
 */

const CTX = {
  tenantId: '00000000-0000-0000-0000-000000000001',
  tenantSlug: 'capiro-internal',
  userId: '00000000-0000-0000-0000-0000000000aa',
  clerkUserId: 'user_abc',
  role: 'capiro_admin' as const,
};

const D = (iso: string) => new Date(iso);

describe('CapiroAdminService — analyst console (Step 3.5)', () => {
  let mock: ReturnType<typeof createPrismaMock>;
  let peWriter: { upsertProgramElement: ReturnType<typeof jest.fn> };
  let personnelWriter: { upsertPerson: ReturnType<typeof jest.fn> };
  let service: CapiroAdminService;

  beforeEach(() => {
    mock = createPrismaMock();
    peWriter = { upsertProgramElement: jest.fn(async () => ({ inserted: true, pe_code: 'x' })) };
    personnelWriter = { upsertPerson: jest.fn(async () => ({ inserted: true, person_id: 'p1' })) };
    service = new CapiroAdminService(
      mock as never,
      {} as never,
      {} as never,
      {} as never,
      peWriter as never,
      personnelWriter as never,
      {} as never,
      {} as never,
      { invalidate: jest.fn() } as never,
    );
  });

  // --- review-counts -------------------------------------------------------

  describe('getReviewCounts', () => {
    test('aggregates counts + oldestOpenAt = MIN(age field) of open rows', async () => {
      mock.store.reconciliationReviewQueue.push(
        { id: 'r1', status: 'open', queuedAt: D('2026-02-01T00:00:00Z') },
        { id: 'r2', status: 'open', queuedAt: D('2026-01-15T00:00:00Z') }, // oldest open
        { id: 'r3', status: 'resolved', queuedAt: D('2025-12-01T00:00:00Z') }, // ignored
      );
      mock.store.peProgramMatch.push(
        { id: 'm1', status: 'candidate', createdAt: D('2026-03-10T00:00:00Z') },
        { id: 'm2', status: 'candidate', createdAt: D('2026-03-05T00:00:00Z') }, // oldest open
        { id: 'm3', status: 'quarantined', createdAt: D('2026-02-01T00:00:00Z') },
        { id: 'm4', status: 'quarantined', createdAt: D('2026-02-02T00:00:00Z') },
        { id: 'm5', status: 'accepted', createdAt: D('2026-01-01T00:00:00Z') },
      );
      mock.store.programElementPersonCandidate.push(
        { id: 'pc1', status: 'open', createdAt: D('2026-04-01T00:00:00Z') },
      );
      mock.store.acquisitionPersonnelMergeCandidate.push(
        { id: 'mc1', status: 'open', createdAt: D('2026-04-02T00:00:00Z') },
        { id: 'mc2', status: 'merged', createdAt: D('2026-01-02T00:00:00Z') },
      );
      mock.store.provisionPeLink.push(
        { id: 'pl1', reviewStatus: 'candidate', createdAt: D('2026-05-01T00:00:00Z') },
        { id: 'pl2', reviewStatus: 'accepted', createdAt: D('2026-01-01T00:00:00Z') },
      );
      mock.store.programElementQuarantine.push({ id: 'q1' }, { id: 'q2' }, { id: 'q3' });
      mock.store.acquisitionPersonnelQuarantine.push({ id: 'aq1' });

      const result = await service.getReviewCounts();

      expect(result.reconciliation).toEqual({
        openCount: 2,
        oldestOpenAt: '2026-01-15T00:00:00.000Z',
      });
      expect(result.programMatch).toEqual({
        openCount: 2,
        quarantinedCount: 2,
        oldestOpenAt: '2026-03-05T00:00:00.000Z',
      });
      expect(result.personCandidate).toEqual({
        openCount: 1,
        oldestOpenAt: '2026-04-01T00:00:00.000Z',
      });
      expect(result.personnelMerge).toEqual({
        openCount: 1,
        oldestOpenAt: '2026-04-02T00:00:00.000Z',
      });
      expect(result.provisionPeLink).toEqual({
        candidateCount: 1,
        oldestOpenAt: '2026-05-01T00:00:00.000Z',
      });
      expect(result.programQuarantine).toEqual({ count: 3 });
      expect(result.personnelQuarantine).toEqual({ count: 1 });
    });

    test('oldestOpenAt is null when a queue has no open rows', async () => {
      const result = await service.getReviewCounts();
      expect(result.reconciliation).toEqual({ openCount: 0, oldestOpenAt: null });
      expect(result.programMatch).toEqual({
        openCount: 0,
        quarantinedCount: 0,
        oldestOpenAt: null,
      });
    });
  });

  // --- audit-logs ----------------------------------------------------------

  describe('listAuditLogs', () => {
    beforeEach(() => {
      mock.store.auditLog.push(
        {
          id: 'a1',
          tenantId: CTX.tenantId,
          action: 'quarantine.discard',
          entityType: 'program_element_quarantine',
          actorUserId: CTX.userId,
          occurredAt: D('2026-06-01T00:00:00Z'),
        },
        {
          id: 'a2',
          tenantId: CTX.tenantId,
          action: 'quarantine.reprocess',
          entityType: 'program_element_quarantine',
          actorUserId: CTX.userId,
          occurredAt: D('2026-06-03T00:00:00Z'),
        },
        {
          id: 'a3',
          tenantId: CTX.tenantId,
          action: 'quarantine.discard',
          entityType: 'acquisition_personnel_quarantine',
          actorUserId: 'someone-else',
          occurredAt: D('2026-06-05T00:00:00Z'),
        },
      );
    });

    test('filters by action and orders occurredAt desc; tenant-scoped via withTenant', async () => {
      const result = await service.listAuditLogs(CTX, { action: 'quarantine.discard' });

      expect(mock.withTenant).toHaveBeenCalledWith(CTX.tenantId, expect.any(Function));
      expect(result.total).toBe(2);
      expect(result.data.map((r) => r.id)).toEqual(['a3', 'a1']); // newest first
      expect(result.page).toBe(1);
      expect(result.limit).toBe(50);
    });

    test('filters by date range (from/to)', async () => {
      const result = await service.listAuditLogs(CTX, {
        from: '2026-06-02T00:00:00Z',
        to: '2026-06-04T00:00:00Z',
      });
      expect(result.total).toBe(1);
      expect(result.data[0]!.id).toBe('a2');
    });

    test('paginates and caps limit at 100', async () => {
      const result = await service.listAuditLogs(CTX, { page: 2, limit: 2 });
      expect(result.page).toBe(2);
      expect(result.limit).toBe(2);
      expect(result.total).toBe(3);
      expect(result.data).toHaveLength(1); // 3 rows, page 2 of size 2 -> 1 row

      const capped = await service.listAuditLogs(CTX, { limit: 9999 });
      expect(capped.limit).toBe(100);
    });
  });

  // --- quarantine list -----------------------------------------------------

  describe('listQuarantine', () => {
    beforeEach(() => {
      mock.store.programElementQuarantine.push(
        {
          id: 'q1',
          rawRecord: { peCode: 'BAD' },
          reason: 'Invalid pe_code: BAD',
          source: 'r_doc',
          quarantinedAt: D('2026-06-01T00:00:00Z'),
        },
        {
          id: 'q2',
          rawRecord: { peCode: '0603270A' },
          reason: 'x',
          source: 'hasc_report',
          quarantinedAt: D('2026-06-02T00:00:00Z'),
        },
      );
      mock.store.acquisitionPersonnelQuarantine.push({
        id: 'aq1',
        rawRecord: { fullName: '' },
        reason: 'Missing required field: full_name',
        source: 'sam',
        quarantinedAt: D('2026-06-03T00:00:00Z'),
      });
    });

    test('filters by type', async () => {
      const pe = await service.listQuarantine({ type: 'program_element' });
      expect(pe.total).toBe(2);
      expect(pe.data.map((r) => r.id).sort()).toEqual(['q1', 'q2']);

      const personnel = await service.listQuarantine({ type: 'acquisition_personnel' });
      expect(personnel.total).toBe(1);
      expect(personnel.data[0]!.id).toBe('aq1');
    });

    test('filters by type + source', async () => {
      const result = await service.listQuarantine({ type: 'program_element', source: 'r_doc' });
      expect(result.total).toBe(1);
      expect(result.data[0]!.id).toBe('q1');
    });
  });

  // --- discard -------------------------------------------------------------

  describe('discardQuarantine', () => {
    test('removes the row and writes an audit-log entry', async () => {
      mock.store.programElementQuarantine.push({
        id: 'q1',
        rawRecord: { peCode: 'BAD' },
        reason: 'Invalid pe_code: BAD',
        source: 'r_doc',
      });

      const result = await service.discardQuarantine(CTX, 'program_element', 'q1');

      expect(result).toEqual({ discarded: true });
      expect(mock.store.programElementQuarantine).toHaveLength(0);
      expect(mock.store.auditLog).toHaveLength(1);
      expect(mock.store.auditLog[0]).toMatchObject({
        action: 'quarantine.discard',
        entityType: 'program_element_quarantine',
        entityId: 'q1',
        tenantId: CTX.tenantId,
        actorRole: 'capiro_admin',
      });
    });

    test('404s when the row does not exist', async () => {
      await expect(service.discardQuarantine(CTX, 'program_element', 'nope')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  // --- reprocess -----------------------------------------------------------

  describe('reprocessQuarantine', () => {
    test('fixable program_element: writes real row, removes quarantine, audits accepted', async () => {
      mock.store.programElementQuarantine.push({
        id: 'q1',
        rawRecord: { peCode: '0603270A', title: 'Fixed PE' },
        reason: 'transient',
        source: 'r_doc',
      });

      const result = await service.reprocessQuarantine(CTX, 'program_element', 'q1');

      expect(result).toEqual({ reprocessed: true, accepted: true });
      expect(peWriter.upsertProgramElement).toHaveBeenCalledTimes(1);
      expect(peWriter.upsertProgramElement).toHaveBeenCalledWith(
        expect.objectContaining({ peCode: '0603270A', title: 'Fixed PE' }),
        'r_doc',
        0.5,
      );
      expect(mock.store.programElementQuarantine).toHaveLength(0);
      expect(mock.store.auditLog[0]).toMatchObject({
        action: 'quarantine.reprocess',
        entityId: 'q1',
        after: { accepted: true },
      });
    });

    test('still-bad program_element: keeps the row, returns reason, audits rejection', async () => {
      mock.store.programElementQuarantine.push({
        id: 'q1',
        rawRecord: { peCode: 'BAD', title: 'still invalid' },
        reason: 'Invalid pe_code: BAD',
        source: 'r_doc',
      });

      const result = await service.reprocessQuarantine(CTX, 'program_element', 'q1');

      expect(result).toEqual({
        reprocessed: true,
        accepted: false,
        reason: 'Invalid pe_code: BAD',
      });
      expect(peWriter.upsertProgramElement).not.toHaveBeenCalled();
      expect(mock.store.programElementQuarantine).toHaveLength(1); // kept
      expect(mock.store.auditLog[0]).toMatchObject({
        action: 'quarantine.reprocess',
        after: { accepted: false, reason: 'Invalid pe_code: BAD' },
      });
    });

    test('fixable acquisition_personnel: writes person, removes quarantine, audits accepted', async () => {
      mock.store.acquisitionPersonnelQuarantine.push({
        id: 'aq1',
        rawRecord: { fullName: 'Jane Doe', organization: 'PEO' },
        reason: 'transient',
        source: 'sam',
      });

      const result = await service.reprocessQuarantine(CTX, 'acquisition_personnel', 'aq1');

      expect(result).toEqual({ reprocessed: true, accepted: true });
      expect(personnelWriter.upsertPerson).toHaveBeenCalledTimes(1);
      expect(personnelWriter.upsertPerson).toHaveBeenCalledWith(
        expect.objectContaining({ fullName: 'Jane Doe' }),
        'sam',
        undefined,
        undefined,
        expect.any(Date),
        0.5,
      );
      expect(mock.store.acquisitionPersonnelQuarantine).toHaveLength(0);
      expect(mock.store.auditLog[0]).toMatchObject({
        action: 'quarantine.reprocess',
        entityType: 'acquisition_personnel_quarantine',
        after: { accepted: true },
      });
    });

    test('still-bad acquisition_personnel (empty full_name): keeps row + reason', async () => {
      mock.store.acquisitionPersonnelQuarantine.push({
        id: 'aq1',
        rawRecord: { fullName: '   ' },
        reason: 'Missing required field: full_name',
        source: 'sam',
      });

      const result = await service.reprocessQuarantine(CTX, 'acquisition_personnel', 'aq1');

      expect(result).toEqual({
        reprocessed: true,
        accepted: false,
        reason: 'Missing required field: full_name',
      });
      expect(personnelWriter.upsertPerson).not.toHaveBeenCalled();
      expect(mock.store.acquisitionPersonnelQuarantine).toHaveLength(1);
      expect(mock.store.auditLog[0]).toMatchObject({
        after: { accepted: false, reason: 'Missing required field: full_name' },
      });
    });

    test('404s when the row does not exist', async () => {
      await expect(
        service.reprocessQuarantine(CTX, 'program_element', 'nope'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});

describe('CapiroAdminService — AI keys & usage console', () => {
  const TENANT_B = '00000000-0000-0000-0000-0000000000b1';
  const SECRET_KEY = 'sk-proj-supersecret-9876';

  let mock: ReturnType<typeof createPrismaMock>;
  let aiUsage: {
    adminAllTenantsSummary: ReturnType<typeof jest.fn>;
    tenantSummaryByTenantId: ReturnType<typeof jest.fn>;
  };
  let aiCredentials: {
    list: ReturnType<typeof jest.fn>;
    upsert: ReturnType<typeof jest.fn>;
    remove: ReturnType<typeof jest.fn>;
  };
  let service: CapiroAdminService;

  beforeEach(() => {
    mock = createPrismaMock();
    mock.store.tenant.push({ id: TENANT_B, name: 'Bravo Strategies' });
    aiUsage = {
      adminAllTenantsSummary: jest.fn(async () => [
        { tenantId: TENANT_B, tenantName: 'Bravo Strategies', totalCostUsd: 1.5, totalTokens: 100, eventCount: 2, tenantKeyEventCount: 0 },
      ]),
      tenantSummaryByTenantId: jest.fn(async () => ({ totalCostUsd: 1.5, byWorkflow: [] })),
    };
    aiCredentials = {
      list: jest.fn(async () => []),
      upsert: jest.fn(async () => ({
        provider: 'openai',
        last4: '9876',
        modelOverride: null,
        status: 'active',
      })),
      remove: jest.fn(async () => ({ removed: true })),
    };
    service = new CapiroAdminService(
      mock as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      aiUsage as never,
      aiCredentials as never,
      { invalidate: jest.fn() } as never,
    );
  });

  test('setTenantAiCredential saves via the shared store and audit-logs WITHOUT the key', async () => {
    const result = await service.setTenantAiCredential(CTX, TENANT_B, {
      provider: 'openai',
      apiKey: SECRET_KEY,
      modelOverride: 'gpt-4.1',
    });

    expect(aiCredentials.upsert).toHaveBeenCalledWith(TENANT_B, {
      provider: 'openai',
      apiKey: SECRET_KEY,
      modelOverride: 'gpt-4.1',
      createdByUserId: CTX.userId,
    });
    expect(result).toMatchObject({ provider: 'openai', last4: '9876' });

    expect(mock.store.auditLog).toHaveLength(1);
    expect(mock.store.auditLog[0]).toMatchObject({
      action: 'ai_credential.set',
      entityType: 'tenant_ai_credential',
      entityId: `${TENANT_B}:openai`,
      actorRole: 'capiro_admin',
    });
    // The audit row must never contain key material — last4 only.
    expect(JSON.stringify(mock.store.auditLog)).not.toContain('supersecret');
  });

  test('removeTenantAiCredential removes and audit-logs', async () => {
    await expect(service.removeTenantAiCredential(CTX, TENANT_B, 'openai')).resolves.toEqual({
      removed: true,
    });
    expect(aiCredentials.remove).toHaveBeenCalledWith(TENANT_B, 'openai');
    expect(mock.store.auditLog[0]).toMatchObject({ action: 'ai_credential.remove' });
  });

  test('per-tenant usage drill-down 404s an unknown tenant', async () => {
    await expect(
      service.getTenantAiUsage('00000000-0000-0000-0000-00000000dead', {}),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(aiUsage.tenantSummaryByTenantId).not.toHaveBeenCalled();
  });

  test('all-tenants summary parses the date range', async () => {
    await service.getAiUsageAllTenants({ from: '2026-06-01T00:00:00Z', to: 'not-a-date' });
    expect(aiUsage.adminAllTenantsSummary).toHaveBeenCalledWith({
      from: new Date('2026-06-01T00:00:00Z'),
      to: undefined,
    });
  });

  test('the admin console routes stay behind the capiro_admin controller guard', async () => {
    const { CapiroAdminController } = await import('./capiro-admin.controller.js');
    const { ROLES_KEY } = await import('../auth/roles.decorator.js');
    expect(Reflect.getMetadata(ROLES_KEY, CapiroAdminController)).toEqual(['capiro_admin']);
  });
});

/**
 * Minimal Prisma mock covering the model methods the analyst-console service
 * calls: count({where}), aggregate({where,_min}), findMany, findUnique, delete,
 * create. Every queue/quarantine/audit table is backed by an in-memory array on
 * `store`. `withTenant(tenantId, fn)` just invokes fn with the same mock (acting
 * as the tx client), recording the tenantId so specs can assert RLS scoping.
 */
function createPrismaMock() {
  const store = {
    reconciliationReviewQueue: [] as Array<Record<string, unknown>>,
    peProgramMatch: [] as Array<Record<string, unknown>>,
    programElementPersonCandidate: [] as Array<Record<string, unknown>>,
    acquisitionPersonnelMergeCandidate: [] as Array<Record<string, unknown>>,
    provisionPeLink: [] as Array<Record<string, unknown>>,
    programElementQuarantine: [] as Array<Record<string, unknown>>,
    acquisitionPersonnelQuarantine: [] as Array<Record<string, unknown>>,
    auditLog: [] as Array<Record<string, unknown>>,
    tenant: [] as Array<Record<string, unknown>>,
  };

  const matchesWhere = (row: Record<string, unknown>, where?: Record<string, unknown>): boolean => {
    if (!where) return true;
    for (const [field, cond] of Object.entries(where)) {
      const value = row[field];
      if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
        const c = cond as { gte?: Date; lte?: Date };
        if (c.gte && (value as Date) < c.gte) return false;
        if (c.lte && (value as Date) > c.lte) return false;
      } else if (value !== cond) {
        return false;
      }
    }
    return true;
  };

  const filtered = (rows: Array<Record<string, unknown>>, where?: Record<string, unknown>) =>
    rows.filter((r) => matchesWhere(r, where));

  const tableApi = (rows: Array<Record<string, unknown>>) => ({
    count: jest.fn(async ({ where }: { where?: Record<string, unknown> } = {}) =>
      filtered(rows, where).length,
    ),
    aggregate: jest.fn(
      async ({ where, _min }: { where?: Record<string, unknown>; _min?: Record<string, true> }) => {
        const matched = filtered(rows, where);
        const min: Record<string, Date | null> = {};
        for (const field of Object.keys(_min ?? {})) {
          const dates = matched
            .map((r) => r[field] as Date | undefined)
            .filter((d): d is Date => d instanceof Date);
          min[field] = dates.length
            ? dates.reduce((a, b) => (a < b ? a : b))
            : null;
        }
        return { _min: min };
      },
    ),
    findMany: jest.fn(
      async ({
        where,
        orderBy,
        skip = 0,
        take,
      }: {
        where?: Record<string, unknown>;
        orderBy?: Record<string, 'asc' | 'desc'>;
        select?: Record<string, boolean>;
        skip?: number;
        take?: number;
      } = {}) => {
        let result = filtered(rows, where);
        if (orderBy) {
          const [field, dir] = Object.entries(orderBy)[0]!;
          result = [...result].sort((a, b) => {
            const av = a[field] as Date | string;
            const bv = b[field] as Date | string;
            const cmp = av < bv ? -1 : av > bv ? 1 : 0;
            return dir === 'desc' ? -cmp : cmp;
          });
        }
        const sliced = take === undefined ? result.slice(skip) : result.slice(skip, skip + take);
        return sliced.map((r) => ({ ...r }));
      },
    ),
    findUnique: jest.fn(async ({ where }: { where: { id: string } }) => {
      const row = rows.find((r) => r.id === where.id);
      return row ? { ...row } : null;
    }),
    delete: jest.fn(async ({ where }: { where: { id: string } }) => {
      const idx = rows.findIndex((r) => r.id === where.id);
      if (idx >= 0) rows.splice(idx, 1);
      return {};
    }),
    create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
      rows.push({ ...data });
      return { ...data };
    }),
  });

  const withTenant = jest.fn(
    async <T>(_tenantId: string, fn: (tx: unknown) => Promise<T>): Promise<T> => fn(client),
  );

  const withSystem = jest.fn(
    async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn(client),
  );

  const client = {
    store,
    withTenant,
    withSystem,
    tenant: tableApi(store.tenant),
    reconciliationReviewQueue: tableApi(store.reconciliationReviewQueue),
    peProgramMatch: tableApi(store.peProgramMatch),
    programElementPersonCandidate: tableApi(store.programElementPersonCandidate),
    acquisitionPersonnelMergeCandidate: tableApi(store.acquisitionPersonnelMergeCandidate),
    provisionPeLink: tableApi(store.provisionPeLink),
    programElementQuarantine: tableApi(store.programElementQuarantine),
    acquisitionPersonnelQuarantine: tableApi(store.acquisitionPersonnelQuarantine),
    auditLog: tableApi(store.auditLog),
  };

  return client;
}
