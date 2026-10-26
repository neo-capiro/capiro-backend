import { describe, it, expect, jest } from '@jest/globals';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { resolveBlueprintPin } from './blueprint-pin.js';

const tenant = 'current-tenant';
const blueprintId = '11111111-1111-4111-8111-111111111111';
const versionId = '22222222-2222-4222-8222-222222222222';
const foreignId = '33333333-3333-4333-8333-333333333333';
const pin = { blueprintId, versionId, version: 2, definitionHash: 'a'.repeat(64) };

function fixture(parentTenant: string | null = tenant) {
  const row = {
    id: versionId,
    blueprintId,
    version: 2,
    definitionHash: pin.definitionHash,
    status: 'published',
    publishedAt: new Date(),
    definition: { sections: [] },
  };
  const db = {
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
        }) => {
          if (where.id !== row.id || where.blueprintId !== row.blueprintId) return null;
          if (where.blueprint && !where.blueprint.OR.some((x) => x.tenantId === parentTenant))
            return null;
          return { ...row };
        },
      ),
    },
  };
  return { db, row };
}

describe('exact published Blueprint adoption', () => {
  it.each([tenant, null])(
    'resolves an exact accessible published pin (%s) without choosing latest',
    async (scope) => {
      const h = fixture(scope);
      const result = await resolveBlueprintPin(h.db as never, tenant, pin);
      expect(result.pin).toEqual(pin);
      expect(result.pin).not.toBe(pin);
      expect(result.version.id).toBe(versionId);
    },
  );

  it('refuses another tenant even with a complete internally consistent tuple', async () => {
    const h = fixture('other-tenant');
    await expect(resolveBlueprintPin(h.db as never, tenant, pin)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it.each([{ blueprintId: foreignId }, { versionId: foreignId }])(
    'binds both resource identities: %p',
    async (patch) => {
      const h = fixture();
      await expect(
        resolveBlueprintPin(h.db as never, tenant, { ...pin, ...patch }),
      ).rejects.toBeInstanceOf(NotFoundException);
    },
  );

  it.each([{ version: 1 }, { definitionHash: 'b'.repeat(64) }])(
    'refuses a mismatched version/hash: %p',
    async (patch) => {
      const h = fixture();
      await expect(
        resolveBlueprintPin(h.db as never, tenant, { ...pin, ...patch }),
      ).rejects.toBeInstanceOf(ConflictException);
    },
  );

  it.each(['draft', 'retired'])('refuses new adoption of %s', async (status) => {
    const h = fixture();
    h.row.status = status;
    await expect(resolveBlueprintPin(h.db as never, tenant, pin)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('keeps a previously published retired pin readable without permitting new adoption', async () => {
    const h = fixture(null);
    h.row.status = 'retired';
    await expect(
      resolveBlueprintPin(h.db as never, tenant, pin, 'retained'),
    ).resolves.toMatchObject({ pin });
    h.row.status = 'draft';
    await expect(
      resolveBlueprintPin(h.db as never, tenant, pin, 'retained'),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it.each([
    null,
    {},
    [],
    { ...pin, version: '2' },
    { ...pin, version: 0 },
    { ...pin, definitionHash: 'not-a-hash' },
    { ...pin, blueprintId: 'catalog-template' },
  ])('refuses incomplete/malformed pins before persistence lookup: %p', async (input) => {
    const h = fixture();
    await expect(resolveBlueprintPin(h.db as never, tenant, input)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(h.db.wsBlueprintVersion.findFirst).not.toHaveBeenCalled();
  });
});
