import { describe, expect, jest, test } from '@jest/globals';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { MeriFirmSkillsService } from './meri-firm-skills.service.js';
import { commitmentsAuditProcedureSkill } from './skills/commitments-audit.procedure.js';
import type { MeriProcedureBinding } from './skills/skill.types.js';

/**
 * In-memory Prisma double with tenant-GUC-style scoping (same pattern as
 * client-facilities.service.spec.ts): every read/write inside withTenant is
 * filtered by the current tenant, so cross-tenant ids are invisible.
 */
type Row = Record<string, unknown>;

function makePrisma(seed: Row[] = []) {
  const store: Row[] = [...seed];
  let currentTenant: string | null = null;
  let idSeq = 1;
  const scoped = () => store.filter((r) => r.tenantId === currentTenant);

  const tx = {
    clioFirmSkill: {
      findMany: async ({ where }: { where: Row }) =>
        scoped().filter(
          (r) =>
            (where.enabled === undefined || r.enabled === where.enabled) &&
            (where.tenantId === undefined || r.tenantId === where.tenantId),
        ),
      findFirst: async ({ where }: { where: Row }) =>
        scoped().find(
          (r) =>
            r.id === where.id &&
            (where.tenantId === undefined || r.tenantId === where.tenantId) &&
            (where.enabled === undefined || r.enabled === where.enabled),
        ) ?? null,
      create: async ({ data }: { data: Row }) => {
        if (scoped().some((r) => r.skillId === data.skillId && r.tenantId === data.tenantId)) {
          const err = new Error('unique') as Error & { code: string };
          err.code = 'P2002';
          // Mimic Prisma's known-request error shape closely enough for the catch.
          Object.setPrototypeOf(err, PrismaKnownError.prototype);
          throw err;
        }
        const row = {
          id: `skill-${idSeq++}`,
          version: 1,
          versions: [],
          enabled: true,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        };
        store.push(row);
        return row;
      },
      update: async ({ where, data }: { where: Row; data: Row }) => {
        const row = scoped().find((r) => r.id === where.id);
        if (!row) throw new Error('not found');
        Object.assign(row, data, { updatedAt: new Date() });
        return row;
      },
      delete: async ({ where }: { where: Row }) => {
        const idx = store.findIndex((r) => r.id === where.id && r.tenantId === currentTenant);
        if (idx >= 0) store.splice(idx, 1);
        return {};
      },
    },
    auditLog: { create: jest.fn(async () => ({})) },
  };

  const prisma = {
    __store: store,
    withTenant: async <T>(tenantId: string, fn: (t: typeof tx) => Promise<T>): Promise<T> => {
      currentTenant = tenantId;
      try {
        return await fn(tx);
      } finally {
        currentTenant = null;
      }
    },
  };
  return prisma;
}

// Stand-in for Prisma.PrismaClientKnownRequestError instanceof checks: the
// service catches err.code === 'P2002' via instanceof, so subclass the real
// class if available. We fake it with a named class the service's catch can
// match by code after instanceof fails — see service note below.
class PrismaKnownError extends Error {
  code = 'P2002';
}

const TENANT_A = '00000000-0000-0000-0000-00000000000a';
const TENANT_B = '00000000-0000-0000-0000-00000000000b';
const ctx = (tenantId: string) =>
  ({ tenantId, userId: '00000000-0000-0000-0000-0000000000aa', role: 'user_admin' }) as never;

const config = { get: jest.fn(() => true) };

const VALID_SKILL = {
  id: 'earmark_request_memo',
  name: 'Earmark Request Memo',
  triggers: ['earmark request memo'],
  systemAddendum: 'Produce the firm-standard earmark request memo with eligibility analysis.',
  requiredTools: ['get_client_context'],
  template: { heading: 'Earmark Request Memo', sections: ['Eligibility', 'Member Fit', 'Ask'] },
};

const COMMITMENTS_SKILL_INPUT = commitmentsAuditProcedureSkill as unknown as Record<
  string,
  unknown
>;

describe('MeriFirmSkillsService — validation at save', () => {
  test('creates a valid skill and serves it at turn time', async () => {
    const prisma = makePrisma();
    const svc = new MeriFirmSkillsService(prisma as never, config as never);
    await svc.create(ctx(TENANT_A), VALID_SKILL);
    const skills = await svc.skillsForTenant(TENANT_A);
    expect(skills.map((s) => s.id)).toEqual(['earmark_request_memo']);
    expect(skills[0]?.template?.sections).toEqual(['Eligibility', 'Member Fit', 'Ask']);
  });

  test('rejects reserved built-in triggers at save', async () => {
    const prisma = makePrisma();
    const svc = new MeriFirmSkillsService(prisma as never, config as never);
    await expect(
      svc.create(ctx(TENANT_A), { ...VALID_SKILL, triggers: ['generate_briefing'] }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  test('rejects tools outside the registry allowlist', async () => {
    const prisma = makePrisma();
    const svc = new MeriFirmSkillsService(prisma as never, config as never);
    await expect(
      svc.create(ctx(TENANT_A), { ...VALID_SKILL, requiredTools: ['drop_database'] }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  test('rejects oversized fields', async () => {
    const prisma = makePrisma();
    const svc = new MeriFirmSkillsService(prisma as never, config as never);
    await expect(
      svc.create(ctx(TENANT_A), { ...VALID_SKILL, systemAddendum: 'x'.repeat(2001) }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('MeriFirmSkillsService — tenant isolation (RLS double)', () => {
  test('tenant B cannot see, update, or delete tenant A skills', async () => {
    const prisma = makePrisma();
    const svc = new MeriFirmSkillsService(prisma as never, config as never);
    const created = (await svc.create(ctx(TENANT_A), VALID_SKILL)) as { id: string };

    expect(await svc.list(ctx(TENANT_B))).toEqual([]);
    expect(await svc.skillsForTenant(TENANT_B)).toEqual([]);
    await expect(svc.update(ctx(TENANT_B), created.id, VALID_SKILL)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(svc.remove(ctx(TENANT_B), created.id)).rejects.toBeInstanceOf(NotFoundException);
    // Tenant A's row survives untouched.
    expect((prisma.__store[0] as { skillId: string }).skillId).toBe('earmark_request_memo');
  });
});

describe('MeriFirmSkillsService — versioning + lifecycle', () => {
  test('update pushes the prior version into history; restore brings it back', async () => {
    const prisma = makePrisma();
    const svc = new MeriFirmSkillsService(prisma as never, config as never);
    const created = (await svc.create(ctx(TENANT_A), VALID_SKILL)) as { id: string };

    await svc.update(ctx(TENANT_A), created.id, {
      ...VALID_SKILL,
      systemAddendum: 'Version two of the memo guidance with sharper asks.',
    });
    const afterUpdate = await svc.skillsForTenant(TENANT_A);
    expect(afterUpdate[0]?.systemAddendum).toContain('Version two');

    const restored = (await svc.restore(ctx(TENANT_A), created.id, 1)) as { version: number };
    expect(restored.version).toBe(3);
    const afterRestore = await svc.skillsForTenant(TENANT_A);
    expect(afterRestore[0]?.systemAddendum).toBe(VALID_SKILL.systemAddendum);
  });

  test('disable removes the skill from turn-time loading (cache invalidated)', async () => {
    const prisma = makePrisma();
    const svc = new MeriFirmSkillsService(prisma as never, config as never);
    const created = (await svc.create(ctx(TENANT_A), VALID_SKILL)) as { id: string };
    expect(await svc.skillsForTenant(TENANT_A)).toHaveLength(1);
    await svc.setEnabled(ctx(TENANT_A), created.id, false);
    expect(await svc.skillsForTenant(TENANT_A)).toHaveLength(0);
  });

  test('test run resolves the template without executing tools', async () => {
    const prisma = makePrisma();
    const svc = new MeriFirmSkillsService(prisma as never, config as never);
    const created = (await svc.create(ctx(TENANT_A), VALID_SKILL)) as { id: string };
    const dryRun = await svc.testRun(ctx(TENANT_A), created.id);
    expect(dryRun.template?.sections).toEqual(['Eligibility', 'Member Fit', 'Ask']);
    expect(dryRun.note).toContain('No tools were executed');
  });
});

describe('MeriFirmSkillsService — current procedure binding', () => {
  test('serves actual row/version provenance and rejects a stale version after update', async () => {
    const prisma = makePrisma();
    const svc = new MeriFirmSkillsService(prisma as never, config as never);
    const created = (await svc.create(ctx(TENANT_A), COMMITMENTS_SKILL_INPUT)) as {
      id: string;
      version: number;
    };

    const served = await svc.skillsForTenant(TENANT_A);
    const binding = served[0]?.procedureBinding;
    expect(binding).toEqual({
      source: 'firm',
      recordId: created.id,
      canonicalId: 'commitments_audit',
      version: created.version,
    });
    const resolved = await svc.resolveProcedureReference(TENANT_A, binding!);
    expect(resolved.procedureBinding).toEqual(binding);
    expect(resolved.procedure?.caseIds).toContain('CD-07');

    await svc.update(ctx(TENANT_A), created.id, {
      ...commitmentsAuditProcedureSkill,
      systemAddendum: `${commitmentsAuditProcedureSkill.systemAddendum} Keep coverage explicit.`,
    });
    await expect(svc.resolveProcedureReference(TENANT_A, binding!)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    const current = (await svc.skillsForTenant(TENANT_A))[0]?.procedureBinding;
    expect(current?.version).toBe(2);
    await expect(svc.resolveProcedureReference(TENANT_A, current!)).resolves.toMatchObject({
      id: 'commitments_audit',
      procedureBinding: { version: 2 },
    });
  });

  test('fails closed for disabled, revoked, and wrong-tenant references', async () => {
    const disabledPrisma = makePrisma();
    const disabledSvc = new MeriFirmSkillsService(disabledPrisma as never, config as never);
    const disabledRow = (await disabledSvc.create(ctx(TENANT_A), COMMITMENTS_SKILL_INPUT)) as {
      id: string;
    };
    const disabledBinding = (await disabledSvc.skillsForTenant(TENANT_A))[0]
      ?.procedureBinding as MeriProcedureBinding;
    await disabledSvc.setEnabled(ctx(TENANT_A), disabledRow.id, false);
    await expect(
      disabledSvc.resolveProcedureReference(TENANT_A, disabledBinding),
    ).rejects.toBeInstanceOf(NotFoundException);

    const revokedPrisma = makePrisma();
    const revokedSvc = new MeriFirmSkillsService(revokedPrisma as never, config as never);
    const revokedRow = (await revokedSvc.create(ctx(TENANT_A), COMMITMENTS_SKILL_INPUT)) as {
      id: string;
    };
    const revokedBinding = (await revokedSvc.skillsForTenant(TENANT_A))[0]
      ?.procedureBinding as MeriProcedureBinding;
    await expect(
      revokedSvc.resolveProcedureReference(TENANT_B, revokedBinding),
    ).rejects.toBeInstanceOf(NotFoundException);
    await revokedSvc.remove(ctx(TENANT_A), revokedRow.id);
    await expect(
      revokedSvc.resolveProcedureReference(TENANT_A, revokedBinding),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
