import type { TenantContext } from '@capiro/shared';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { TenantContextStore } from '../tenant/tenant-context.store.js';
import { MemoryStoreService } from './memory-store.service.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const CLIENT = '33333333-3333-4333-8333-333333333333';

function harness(role: TenantContext['role'], row: Record<string, unknown> | null) {
  const queryRaw = jest.fn().mockResolvedValue(row ? [row] : []);
  const executeRaw = jest.fn().mockResolvedValue(1);
  const auditCreate = jest.fn().mockResolvedValue({ id: 'audit' });
  const tx = { $queryRaw: queryRaw, $executeRaw: executeRaw, auditLog: { create: auditCreate } };
  const prisma = {
    withTenantUser: jest.fn((_tenantId: string, _userId: string, fn: (arg: typeof tx) => unknown) =>
      fn(tx),
    ),
  } as unknown as PrismaService;
  const ctx = {
    tenantId: TENANT,
    tenantSlug: 'test',
    userId: USER,
    clerkUserId: 'user_test',
    role,
  } satisfies TenantContext;
  const tenantCtx = { require: () => ctx } as unknown as TenantContextStore;
  return { service: new MemoryStoreService(prisma, tenantCtx), queryRaw, executeRaw, auditCreate };
}

const sharedRow = {
  title: 'Firm position',
  slug: 'firm-position',
  visibility: 'tenant',
  owner_user_id: null,
  client_id: null,
  status: 'active',
  legal_hold: false,
};

describe('MemoryStoreService Phase 0 mutation boundary', () => {
  it('does not convert tenant read visibility into standard-user confirm authority', async () => {
    const h = harness('standard_user', sharedRow);
    await expect(h.service.confirmMemory(CLIENT)).resolves.toEqual({ found: false });
    expect(h.executeRaw).not.toHaveBeenCalled();
  });

  it.each(['user_admin', 'capiro_admin'] as const)(
    'allows %s to confirm shared firm memory',
    async (role) => {
      const h = harness(role, sharedRow);
      await expect(h.service.confirmMemory(CLIENT)).resolves.toEqual({
        found: true,
        title: 'Firm position',
      });
      expect(h.executeRaw).toHaveBeenCalledTimes(1);
    },
  );

  it('allows an owner to confirm private memory', async () => {
    const h = harness('standard_user', {
      ...sharedRow,
      visibility: 'user',
      owner_user_id: USER,
    });
    await expect(h.service.confirmMemory(CLIENT)).resolves.toMatchObject({ found: true });
    expect(h.executeRaw).toHaveBeenCalledTimes(1);
  });

  it('denies standard-user client-shared forget without revealing the row', async () => {
    const h = harness('standard_user', { ...sharedRow, client_id: CLIENT });
    await expect(h.service.forgetMemory(CLIENT)).resolves.toEqual({ found: false });
    expect(h.executeRaw).not.toHaveBeenCalled();
    expect(h.auditCreate).not.toHaveBeenCalled();
  });

  it('legal hold blocks an otherwise authorized admin forget', async () => {
    const h = harness('user_admin', { ...sharedRow, legal_hold: true });
    await expect(h.service.forgetMemory(CLIENT)).resolves.toEqual({
      found: true,
      blockedByLegalHold: true,
      title: 'Firm position',
    });
    expect(h.executeRaw).not.toHaveBeenCalled();
  });

  it('denies standard-user correction of firm memory before any insert/update', async () => {
    const h = harness('standard_user', {
      ...sharedRow,
      type: 'note',
      entity_id: null,
      tags: [],
    });
    await expect(h.service.correctMemory(CLIENT, 'Changed')).resolves.toEqual({
      found: false,
      blockedByLegalHold: undefined,
      title: undefined,
    });
    expect(h.queryRaw).toHaveBeenCalledTimes(1);
    expect(h.executeRaw).not.toHaveBeenCalled();
  });

  it('returns non-enumerating not-found for revoked/missing rows', async () => {
    const h = harness('capiro_admin', null);
    await expect(h.service.confirmMemory(CLIENT)).resolves.toEqual({ found: false });
  });
});
