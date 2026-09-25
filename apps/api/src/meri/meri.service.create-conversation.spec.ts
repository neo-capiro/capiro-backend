import { BadRequestException, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { TenantContext } from '@capiro/shared';
import { MeriService } from './meri.service.js';
import { MERI_PROSPECT_SCOPE_METADATA_KEY } from '../business-development/bizdev-meri-scope.service.js';

/**
 * Phase 4 server-only slice — focused Jest coverage for prospect-scoped
 * Meri conversation creation. Pins: ordinary creation unchanged, server-only
 * scope persistence, linked-client auto-bind after the access check,
 * mismatching/arbitrary client rejection, inaccessible linked client
 * rejection, and fail-closed behavior when the optional scope service is
 * unavailable.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const ctx = { tenantId: TENANT, userId: USER } as TenantContext;

interface Harness {
  service: MeriService;
  conversationCreate: jest.Mock;
  resolve: jest.Mock;
}

function buildHarness(options: {
  bizdevScope?: {
    resolve: (
      c: TenantContext,
      prospectId: string,
    ) => Promise<{
      prospectId: string;
      prospectName: string;
      canonicalOrganizationId: string | null;
      linkedClientId: string | null;
      scopeVersion: string;
    }>;
  };
}): Harness {
  const conversationCreate = jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
    id: randomUUID(),
    ...data,
  }));
  const tx = {
    clioConversation: { create: conversationCreate },
    user: {
      findUnique: jest.fn(async () => ({ email: 'user@example.test', firstName: null, lastName: null })),
    },
    client: {
      findFirst: jest.fn(async ({ where }: { where: { id: string; tenantId: string; status?: unknown } }) => ({
        id: where.id,
      })),
    },
  };
  const prisma = {
    withTenant: jest.fn(async (_t: string, cb: (value: typeof tx) => unknown) => cb(tx)),
  };
  const resolve = jest.fn(options.bizdevScope?.resolve);
  const bizdevScope = options.bizdevScope ? ({ resolve } as never) : undefined;
  // Positional construction mirrors meri.service.upload-attachment.spec.ts;
  // bizdevScope is the FINAL optional parameter.
  const service = new MeriService(
    prisma as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    bizdevScope,
  );
  return { service, conversationCreate, resolve };
}

const scopeFor = (prospectId: string, over: Record<string, unknown> = {}) => ({
  prospectId,
  prospectName: 'Acme LLC',
  canonicalOrganizationId: randomUUID(),
  linkedClientId: null,
  scopeVersion: 'a'.repeat(64),
  ...over,
});

describe('MeriService.createConversation — ordinary (no prospectId) creation', () => {
  test('unchanged: no scope resolution, no scope metadata, brand/runtime/userEmail kept', async () => {
    const h = buildHarness({
      bizdevScope: { resolve: async () => scopeFor(randomUUID()) },
    });
    await h.service.createConversation(ctx, { title: 'Hello' });
    expect(h.resolve).not.toHaveBeenCalled();
    expect(h.conversationCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: TENANT,
        userId: USER,
        clientId: null,
        title: 'Hello',
        workspaceKey: 'workspace',
        metadata: expect.objectContaining({
          brand: 'Meri',
          runtime: 'Hermes',
          userEmail: 'user@example.test',
        }),
      }),
    });
    const metadata = (h.conversationCreate.mock.calls[0][0] as { data: { metadata: Record<string, unknown> } })
      .data.metadata;
    expect(metadata[MERI_PROSPECT_SCOPE_METADATA_KEY]).toBeUndefined();
    expect(Object.keys(metadata).sort()).toEqual(['brand', 'runtime', 'userEmail']);
  });
});

describe('MeriService.createConversation — prospect-scoped creation', () => {
  test('persists only the server-resolved bounded scope under the one metadata key', async () => {
    const prospectId = randomUUID();
    const canonicalId = randomUUID();
    const scope = scopeFor(prospectId, {
      canonicalOrganizationId: canonicalId,
      linkedClientId: null,
    });
    const h = buildHarness({ bizdevScope: { resolve: async () => scope } });
    await h.service.createConversation(ctx, { prospectId });
    expect(h.resolve).toHaveBeenCalledWith(ctx, prospectId);
    const data = h.conversationCreate.mock.calls[0][0].data as {
      clientId: string | null;
      metadata: Record<string, unknown>;
    };
    expect(data.clientId).toBeNull();
    const persisted = data.metadata[MERI_PROSPECT_SCOPE_METADATA_KEY] as Record<string, unknown>;
    expect(persisted).toEqual(scope);
    expect(Object.keys(persisted).sort()).toEqual(
      ['canonicalOrganizationId', 'linkedClientId', 'prospectId', 'prospectName', 'scopeVersion'].sort(),
    );
    // brand/runtime/userEmail survive alongside the bounded scope.
    expect(data.metadata.brand).toBe('Meri');
    expect(data.metadata.runtime).toBe('Hermes');
    expect(data.metadata.userEmail).toBe('user@example.test');
  });

  test('auto-binds the linked client after the access check', async () => {
    const prospectId = randomUUID();
    const linkedClientId = randomUUID();
    const scope = scopeFor(prospectId, { linkedClientId });
    const h = buildHarness({ bizdevScope: { resolve: async () => scope } });
    await h.service.createConversation(ctx, { prospectId });
    const data = h.conversationCreate.mock.calls[0][0].data as { clientId: string | null };
    expect(data.clientId).toBe(linkedClientId);
  });

  test('matching supplied clientId is accepted (exact match required)', async () => {
    const prospectId = randomUUID();
    const linkedClientId = randomUUID();
    const scope = scopeFor(prospectId, { linkedClientId });
    const h = buildHarness({ bizdevScope: { resolve: async () => scope } });
    await h.service.createConversation(ctx, { prospectId, clientId: linkedClientId });
    const data = h.conversationCreate.mock.calls[0][0].data as { clientId: string | null };
    expect(data.clientId).toBe(linkedClientId);
  });

  test('mismatching supplied clientId is rejected', async () => {
    const prospectId = randomUUID();
    const scope = scopeFor(prospectId, { linkedClientId: randomUUID() });
    const h = buildHarness({ bizdevScope: { resolve: async () => scope } });
    await expect(
      h.service.createConversation(ctx, { prospectId, clientId: randomUUID() }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(h.conversationCreate).not.toHaveBeenCalled();
  });

  test('arbitrary clientId with an unlinked prospect is rejected', async () => {
    const prospectId = randomUUID();
    const scope = scopeFor(prospectId, { linkedClientId: null });
    const h = buildHarness({ bizdevScope: { resolve: async () => scope } });
    await expect(
      h.service.createConversation(ctx, { prospectId, clientId: randomUUID() }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(h.conversationCreate).not.toHaveBeenCalled();
  });

  test('inaccessible linked client is rejected (auto-bind only when authorized)', async () => {
    const prospectId = randomUUID();
    const linkedClientId = randomUUID();
    const scope = scopeFor(prospectId, { linkedClientId });
    const conversationCreate = jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
      id: randomUUID(),
      ...data,
    }));
    const tx = {
      clioConversation: { create: conversationCreate },
      user: {
        findUnique: jest.fn(async () => ({ email: 'user@example.test', firstName: null, lastName: null })),
      },
      // Linked client resolves to NOTHING (archived or otherwise invisible).
      client: { findFirst: jest.fn(async () => null) },
    };
    const prisma = {
      withTenant: jest.fn(async (_t: string, cb: (value: typeof tx) => unknown) => cb(tx)),
    };
    const service = new MeriService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { resolve: async () => scope } as never,
    );
    await expect(service.createConversation(ctx, { prospectId })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(conversationCreate).not.toHaveBeenCalled();
  });

  test('missing optional scope service fails closed on a prospect request', async () => {
    const h = buildHarness({}); // no bizdevScope provided
    await expect(
      h.service.createConversation(ctx, { prospectId: randomUUID() }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(h.conversationCreate).not.toHaveBeenCalled();
  });

  test('scope resolution failure (safe 404) propagates before any write', async () => {
    const h = buildHarness({
      bizdevScope: {
        resolve: async () => {
          throw new NotFoundException();
        },
      },
    });
    await expect(
      h.service.createConversation(ctx, { prospectId: randomUUID() }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(h.conversationCreate).not.toHaveBeenCalled();
  });
});
