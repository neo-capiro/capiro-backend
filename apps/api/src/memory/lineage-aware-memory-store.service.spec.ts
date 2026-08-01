import { afterEach, describe, expect, it, jest } from '@jest/globals';
import type { TenantContext } from '@capiro/shared';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { TenantContextStore } from '../tenant/tenant-context.store.js';
import { GovernedMemoryStoreService } from './governed-memory-store.service.js';
import type { ImmutableMemoryVersionService } from './immutable-memory-version.service.js';
import { LineageAwareMemoryStoreService } from './lineage-aware-memory-store.service.js';
import type { MemoryAuthorizationService } from './memory-authorization.service.js';
import type { MemoryCleanupOutboxService } from './memory-cleanup-outbox.service.js';
import type { MemoryTransitionAuditService } from './memory-transition-audit.service.js';
import type { MemoryItem } from './memory.types.js';

const ctx: TenantContext = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  tenantSlug: 'test',
  userId: '22222222-2222-4222-8222-222222222222',
  clerkUserId: 'user_1',
  role: 'user_admin',
};

function item(overrides: Partial<MemoryItem> = {}): MemoryItem {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    tenantId: ctx.tenantId,
    clientId: null,
    ownerUserId: null,
    type: 'firm-soul',
    visibility: 'tenant',
    entityId: null,
    slug: 'firm',
    title: 'Firm Soul',
    aliases: [],
    tags: [],
    source: 'manual',
    sourceRef: null,
    provenance: 'human',
    sections: [{ key: 'who', heading: 'Who', owner: 'human', body: 'Old.' }],
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    schemaVersion: 1,
    status: 'superseded',
    lastConfirmedAt: null,
    reviewCadenceDays: null,
    supersedesId: null,
    contradictsId: null,
    sensitivity: 'normal',
    retentionPolicy: null,
    legalHold: false,
    revokedAt: null,
    revokedBy: null,
    exportable: true,
    trainingUse: 'excluded',
    governedStatus: 'superseded',
    ...overrides,
  };
}

afterEach(() => jest.restoreAllMocks());

describe('LineageAwareMemoryStoreService', () => {
  it('resolves the stable catalog slug to the active immutable descendant', async () => {
    const active = item({
      id: '44444444-4444-4444-8444-444444444444',
      slug: 'firm--version-candidate',
      status: 'active',
      governedStatus: 'active',
      sections: [{ key: 'who', heading: 'Who', owner: 'human', body: 'Current.' }],
    });
    jest
      .spyOn(GovernedMemoryStoreService.prototype, 'getByTypeSlug')
      .mockResolvedValueOnce(item())
      .mockResolvedValueOnce(active);

    const tx = {
      $queryRaw: jest.fn(async () => [
        { id: active.id, type: active.type, slug: active.slug },
      ]),
    };
    const prisma = {
      withTenantUser: jest.fn(
        async (_tenant: string, _user: string, work: (value: typeof tx) => unknown) => work(tx),
      ),
    } as unknown as PrismaService;
    const tenantCtx = { require: () => ctx } as TenantContextStore;
    const service = new LineageAwareMemoryStoreService(
      prisma,
      tenantCtx,
      {} as MemoryAuthorizationService,
      {} as MemoryTransitionAuditService,
      {} as MemoryCleanupOutboxService,
      {} as ImmutableMemoryVersionService,
    );

    const resolved = await service.getByTypeSlug('firm-soul', 'firm');
    expect(resolved?.id).toBe(active.id);
    expect(resolved?.sections[0]?.body).toBe('Current.');
  });
});
