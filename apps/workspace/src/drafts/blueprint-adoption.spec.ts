import { describe, it, expect, jest } from '@jest/globals';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { DraftsService } from './drafts.service.js';
import { readAgentState } from '../document-agent/document-agent-state.js';

const tenant = 'current-tenant',
  actor = 'member';
const pin = {
  blueprintId: '11111111-1111-4111-8111-111111111111',
  versionId: '22222222-2222-4222-8222-222222222222',
  version: 1,
  definitionHash: 'a'.repeat(64),
};

function fixture(parentTenant: string | null = tenant) {
  let membership = true;
  let saved: Record<string, unknown> = {
    id: 'draft',
    tenantId: tenant,
    ownerId: actor,
    prospectId: null,
    clientId: null,
    client: null,
    config: {},
    documents: [],
  };
  const version = {
    id: pin.versionId,
    blueprintId: pin.blueprintId,
    version: 1,
    definitionHash: pin.definitionHash,
    status: 'published',
    publishedAt: new Date(),
  };
  const db = {
    $executeRaw: jest.fn(async () => 1),
    $queryRaw: jest.fn(async () => (membership ? [{ id: 'active-member' }] : [])),
    wsBlueprintVersion: {
      findFirst: jest.fn(
        async ({
          where,
        }: {
          where: {
            id: string;
            blueprintId: string;
            blueprint?: { OR: Array<{ tenantId: string | null }> };
          };
        }) =>
          where.id === version.id &&
          where.blueprintId === version.blueprintId &&
          (!where.blueprint || where.blueprint.OR.some((x) => x.tenantId === parentTenant))
            ? { ...version }
            : null,
      ),
    },
    wsDraft: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        saved = { ...saved, ...data };
        return structuredClone(saved);
      }),
      findFirst: jest.fn(async () => structuredClone(saved)),
      findFirstOrThrow: jest.fn(async () => structuredClone(saved)),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        saved = { ...saved, ...data };
        return structuredClone(saved);
      }),
    },
    wsDocument: {
      create: jest.fn(async () => {
        saved.documents = [{ id: 'document' }];
        return { id: 'document' };
      }),
    },
  };
  const prisma = {
    ...db,
    $transaction: async (run: (tx: typeof db) => Promise<unknown>) => run(db),
    withSystem: async (run: (tx: typeof db) => Promise<unknown>) => run(db),
  };
  const collaborators = { assertCan: jest.fn(async () => 'owner') };
  return {
    db,
    version,
    saved: () => structuredClone(saved),
    revoke: () => {
      membership = false;
    },
    service: new DraftsService(prisma as never, collaborators as never),
    collaborators,
  };
}

describe('ordinary draft Blueprint adoption', () => {
  it.each([tenant, null])(
    'persists one exact published pin on the existing aggregate (%s)',
    async (scope) => {
      const h = fixture(scope);
      const created = await h.service.create(tenant, actor, {
        product: 'Brief',
        blueprintPin: pin,
      });
      expect(readAgentState(created.config as Record<string, unknown>).blueprintPin).toEqual(pin);
      expect(h.db.wsDraft.create).toHaveBeenCalledTimes(1);
      expect(h.db.wsDocument.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ body: { blocks: [] } }) }),
      );
      h.version.version = 2;
      h.version.definitionHash = 'b'.repeat(64);
      expect(readAgentState(h.saved().config as Record<string, unknown>).blueprintPin).toEqual(pin);
    },
  );

  it.each(['draft', 'retired'])(
    'rejects %s adoption before draft/document writes',
    async (status) => {
      const h = fixture();
      h.version.status = status;
      await expect(h.service.create(tenant, actor, { blueprintPin: pin })).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(h.db.wsDraft.create).not.toHaveBeenCalled();
      expect(h.db.wsDocument.create).not.toHaveBeenCalled();
    },
  );

  it('rejects a foreign pin before draft/document writes', async () => {
    const h = fixture('other-tenant');
    await expect(h.service.create(tenant, actor, { blueprintPin: pin })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(h.db.wsDraft.create).not.toHaveBeenCalled();
    expect(h.db.wsDocument.create).not.toHaveBeenCalled();
  });

  it('preserves current membership checks before reading a pin', async () => {
    const h = fixture();
    h.revoke();
    await expect(h.service.create(tenant, actor, { blueprintPin: pin })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(h.db.wsBlueprintVersion.findFirst).not.toHaveBeenCalled();
    expect(h.db.wsDraft.create).not.toHaveBeenCalled();
  });

  it('keeps catalog-only creation unchanged when no pin is selected', async () => {
    const h = fixture();
    const created = await h.service.create(tenant, actor, { product: 'Brief' });
    expect((created.config as Record<string, unknown>).selectedTemplate).toBeNull();
    expect((created.config as Record<string, unknown>).documentAgent).toBeUndefined();
    expect(h.db.wsBlueprintVersion.findFirst).not.toHaveBeenCalled();
  });

  it('round-trips unchanged agent state but refuses replacing or removing it via config', async () => {
    const h = fixture();
    await h.service.create(tenant, actor, { blueprintPin: pin });
    const config = h.saved().config as Record<string, unknown>;
    await h.service.update(tenant, 'draft', actor, { config: structuredClone(config) });
    await h.service.update(tenant, 'draft', actor, { config: { tone: 'Friendly' } });
    for (const documentAgent of [null, {}, { blueprintPin: { ...pin, version: 99 } }])
      await expect(
        h.service.update(tenant, 'draft', actor, { config: { documentAgent } }),
      ).rejects.toBeInstanceOf(ConflictException);
    expect(h.db.wsDraft.update).toHaveBeenCalledTimes(2);
    expect(readAgentState(h.saved().config as Record<string, unknown>).blueprintPin).toEqual(pin);
  });
});
