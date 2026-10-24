import { describe, expect, it, jest } from '@jest/globals';
import type { TenantContext } from '@capiro/shared';
jest.mock('../../prisma/prisma.service.js', () => ({ PrismaService: class {} }));
import { SupportRequestsService } from './support-requests.service.js';

const actor = { tenantId: 'tenant-a', userId: 'member-a', role: 'standard_user' } as TenantContext;
const input = {
  id: 'request-a',
  summary: ' Cannot save ',
  detail: ' Settings reports a failure. ',
  runReference: null,
};
type Stored = {
  id: string;
  tenantId: string;
  submittedByUserId: string;
  summary: string;
  detail: string;
  runReference: string | null;
  createdAt: Date;
};
function fixture() {
  const rows: Stored[] = [];
  const membership = { status: 'active', role: 'standard_user' };
  const tenant = { id: actor.tenantId, status: 'active' };
  const matches = (row: Stored, where: Record<string, unknown>) =>
    Object.entries(where).every(([key, value]) => row[key as keyof Stored] === value);
  const tx = {
    $queryRaw: jest.fn(async () => []),
    tenant: { findUnique: jest.fn(async () => tenant) },
    tenantMembership: { findUnique: jest.fn(async () => membership) },
    supportRequest: {
      createMany: jest.fn(async ({ data }: { data: Omit<Stored, 'createdAt'>[] }) => {
        for (const item of data)
          if (!rows.some((row) => row.id === item.id))
            rows.push({ ...item, createdAt: new Date('2026-10-24T00:00:00Z') });
      }),
      findFirst: jest.fn(
        async ({ where }: { where: Record<string, unknown> }) =>
          rows.find((row) => matches(row, where)) ?? null,
      ),
      findMany: jest.fn(async (_args: { select: Record<string, boolean> }) => rows),
    },
    auditLog: { create: jest.fn(async () => ({})) },
  };
  const prisma = {
    withTenant: jest.fn(async (_id: string, body: (tx: unknown) => Promise<unknown>) => body(tx)),
    withSystem: jest.fn(async (body: (tx: unknown) => Promise<unknown>) => body(tx)),
  };
  return {
    rows,
    membership,
    tenant,
    tx,
    prisma,
    service: new SupportRequestsService(prisma as never),
  };
}

describe('Immutable support requests', () => {
  it('rejects a newly suspended tenant before creating or reading a report', async () => {
    const f = fixture();
    f.tenant.status = 'suspended';
    await expect(f.service.create(actor, input)).rejects.toThrow('Current tenant');
    await expect(f.service.ownReceipt(actor, input.id)).rejects.toThrow('Current tenant');
    expect(f.tx.supportRequest.createMany).not.toHaveBeenCalled();
    expect(f.tx.supportRequest.findFirst).not.toHaveBeenCalled();
  });
  it('persists caller ownership and normalized text; same-id replay returns the original timestamp', async () => {
    const f = fixture();
    const first = await f.service.create(actor, input);
    expect(first).toMatchObject({
      tenantId: actor.tenantId,
      submittedByUserId: actor.userId,
      summary: 'Cannot save',
      detail: 'Settings reports a failure.',
      runReference: null,
    });
    expect(await f.service.create(actor, input)).toEqual(first);
    expect(f.rows).toHaveLength(1);
    expect(f.prisma.withTenant).toHaveBeenCalledWith(actor.tenantId, expect.any(Function));
    expect(f.tx.supportRequest.createMany).toHaveBeenCalledWith(
      expect.objectContaining({ skipDuplicates: true }),
    );
    expect(f.tx.auditLog.create).not.toHaveBeenCalled();
  });
  it.each(['summary', 'detail', 'runReference'] as const)(
    'rejects same-id changed %s without replacing a report',
    async (field) => {
      const f = fixture();
      await f.service.create(actor, input);
      await expect(f.service.create(actor, { ...input, [field]: 'different' })).rejects.toThrow(
        'different report',
      );
      expect(f.rows[0]!.detail).toBe('Settings reports a failure.');
    },
  );
  it.each([{ userId: 'member-b' }, { tenantId: 'tenant-b' }])(
    'does not reveal another actor or tenant receipt: %j',
    async (change) => {
      const f = fixture();
      await f.service.create(actor, input);
      await expect(f.service.ownReceipt({ ...actor, ...change }, input.id)).rejects.toThrow(
        'not found',
      );
      await expect(f.service.create({ ...actor, ...change }, input)).rejects.toThrow(
        'different report',
      );
    },
  );
  it.each(['removed', 'invited'])(
    'rejects %s membership before touching report data',
    async (status) => {
      const f = fixture();
      f.membership.status = status;
      await expect(f.service.create(actor, input)).rejects.toThrow('Current membership');
      await expect(f.service.ownReceipt(actor, input.id)).rejects.toThrow('Current membership');
      expect(f.tx.supportRequest.createMany).not.toHaveBeenCalled();
      expect(f.tx.supportRequest.findFirst).not.toHaveBeenCalled();
    },
  );
  it.each([{ summary: ' ' }, { detail: 'x'.repeat(5001) }, { runReference: 'x'.repeat(201) }])(
    'refuses out-of-bounds normalized content',
    async (change) => {
      const f = fixture();
      await expect(f.service.create(actor, { ...input, ...change })).rejects.toThrow(
        'allowed length',
      );
      expect(f.prisma.withTenant).not.toHaveBeenCalled();
    },
  );
  it('stores an opaque opt-in reference without fetching any run content', async () => {
    const f = fixture();
    expect(
      await f.service.create(actor, { ...input, runReference: ' user-provided-reference ' }),
    ).toMatchObject({ runReference: 'user-provided-reference' });
    expect(Object.keys(f.tx)).toEqual([
      '$queryRaw',
      'tenant',
      'tenantMembership',
      'supportRequest',
      'auditLog',
    ]);
  });
  it('requires fresh HQ role for list and detail even if the request context had staff role', async () => {
    const f = fixture();
    const staff = { ...actor, role: 'capiro_admin' } as TenantContext;
    await expect(f.service.listForStaff(staff, { tenantId: 'tenant-b' })).rejects.toThrow(
      'Current membership',
    );
    await expect(f.service.detailForStaff(staff, 'tenant-b', input.id)).rejects.toThrow(
      'Current membership',
    );
    expect(f.tx.supportRequest.findMany).not.toHaveBeenCalled();
  });
  it('bounds staff pages, validates cursor tenant and records metadata-only access audit', async () => {
    const f = fixture();
    f.membership.role = 'capiro_admin';
    const staff = { ...actor, role: 'capiro_admin' } as TenantContext;
    for (let i = 0; i < 51; i++)
      f.rows.push({
        ...input,
        id: `request-${i}`,
        tenantId: actor.tenantId,
        submittedByUserId: actor.userId,
        createdAt: new Date(),
      });
    const page = await f.service.listForStaff(staff, { tenantId: actor.tenantId });
    expect(page.items).toHaveLength(50);
    expect(page.nextCursor).toBe('request-49');
    expect(f.tx.supportRequest.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 51,
        where: { tenantId: actor.tenantId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
    );
    expect(f.tx.supportRequest.findMany.mock.calls[0]![0].select).not.toHaveProperty('detail');
    await expect(
      f.service.listForStaff(staff, { tenantId: 'tenant-b', cursor: 'request-0' }),
    ).rejects.toThrow('page not found');
    await f.service.detailForStaff(staff, actor.tenantId, 'request-0');
    expect(JSON.stringify(f.tx.auditLog.create.mock.calls)).not.toContain(input.detail);
    await expect(f.service.detailForStaff(staff, 'tenant-b', 'request-0')).rejects.toThrow(
      'not found',
    );
  });
});
