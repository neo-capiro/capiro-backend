import { describe, expect, jest, test } from '@jest/globals';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { MeriFirmSkillsService } from './meri-firm-skills.service.js';
import { commitmentsAuditProcedureSkill } from './skills/commitments-audit.procedure.js';
import type { MeriProcedureBinding } from './skills/skill.types.js';

/**
 * In-memory Prisma double with tenant-GUC-style scoping (same pattern as
 * client-facilities.service.spec.ts): every read/write inside withTenant is
 * filtered by the current tenant, so cross-tenant ids are invisible.
 */
type Row = Record<string, unknown>;

function makePrisma(seed: Row[] = [], options: { beforeVersionWrite?: () => Promise<void> } = {}) {
  const store: Row[] = [...seed];
  let idSeq = 1;
  const auditCreate = jest.fn(async () => ({}));
  const copy = <T>(value: T): T => structuredClone(value);

  const txForTenant = (tenantId: string) => {
    const scoped = () => store.filter((r) => r.tenantId === tenantId);
    return {
      clioFirmSkill: {
        findMany: async ({ where }: { where: Row }) =>
          copy(
            scoped().filter(
              (r) =>
                (where.enabled === undefined || r.enabled === where.enabled) &&
                (where.tenantId === undefined || r.tenantId === where.tenantId),
            ),
          ),
        findFirst: async ({ where }: { where: Row }) => {
          const row = scoped().find(
            (r) =>
              (where.id === undefined || r.id === where.id) &&
              (where.tenantId === undefined || r.tenantId === where.tenantId) &&
              (where.enabled === undefined || r.enabled === where.enabled),
          );
          return row ? copy(row) : null;
        },
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
          return copy(row);
        },
        update: async ({ where, data }: { where: Row; data: Row }) => {
          const row = scoped().find((r) => r.id === where.id);
          if (!row) throw new Error('not found');
          Object.assign(row, data, { updatedAt: new Date() });
          return copy(row);
        },
        updateMany: async ({ where, data }: { where: Row; data: Row }) => {
          await options.beforeVersionWrite?.();
          const row = scoped().find(
            (r) =>
              r.id === where.id && (where.version === undefined || r.version === where.version),
          );
          if (!row) return { count: 0 };
          Object.assign(row, data, { updatedAt: new Date() });
          return { count: 1 };
        },
        delete: async ({ where }: { where: Row }) => {
          const idx = store.findIndex((r) => r.id === where.id && r.tenantId === tenantId);
          if (idx >= 0) store.splice(idx, 1);
          return {};
        },
        // Deletion is fenced by the viewed version, so the double must honour `where.version` the
        // same way updateMany does and report a count.
        deleteMany: async ({ where }: { where: Row }) => {
          await options.beforeVersionWrite?.();
          const idx = store.findIndex(
            (r) =>
              r.id === where.id &&
              r.tenantId === tenantId &&
              (where.version === undefined || r.version === where.version),
          );
          if (idx < 0) return { count: 0 };
          store.splice(idx, 1);
          return { count: 1 };
        },
      },
      auditLog: { create: auditCreate },
    };
  };

  const prisma = {
    __store: store,
    __auditCreate: auditCreate,
    withTenant: async <T>(
      tenantId: string,
      fn: (t: ReturnType<typeof txForTenant>) => Promise<T>,
    ) => fn(txForTenant(tenantId)),
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

function concurrentGate(parties: number): () => Promise<void> {
  let arrived = 0;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  return async () => {
    arrived += 1;
    if (arrived === parties) release();
    await ready;
  };
}

function hollowCommitmentsSkill() {
  const hollow = structuredClone(commitmentsAuditProcedureSkill);
  hollow.systemAddendum = 'No audit instructions.';
  hollow.requiredTools = [];
  hollow.procedure!.purpose = 'Placeholder';
  hollow.procedure!.evidencePrerequisites = ['Placeholder'];
  hollow.procedure!.completion = ['Placeholder'];
  hollow.procedure!.effectPolicy.prohibitedEffects = [];
  hollow.procedure!.examples = ['Placeholder'];
  return hollow;
}

function commitmentsWithHeading(heading: string) {
  return {
    ...commitmentsAuditProcedureSkill,
    template: {
      ...commitmentsAuditProcedureSkill.template!,
      heading,
    },
  };
}

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
    await expect(svc.update(ctx(TENANT_B), created.id, VALID_SKILL, 1)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(svc.remove(ctx(TENANT_B), created.id, 1)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    // Tenant A's row survives untouched.
    expect((prisma.__store[0] as { skillId: string }).skillId).toBe('earmark_request_memo');
  });
});

describe('MeriFirmSkillsService — versioning + lifecycle', () => {
  test('update pushes the prior version into history; restore brings it back', async () => {
    const prisma = makePrisma();
    const svc = new MeriFirmSkillsService(prisma as never, config as never);
    const created = (await svc.create(ctx(TENANT_A), VALID_SKILL)) as { id: string };

    await svc.update(
      ctx(TENANT_A),
      created.id,
      {
        ...VALID_SKILL,
        systemAddendum: 'Version two of the memo guidance with sharper asks.',
      },
      created.version,
    );
    const afterUpdate = await svc.skillsForTenant(TENANT_A);
    expect(afterUpdate[0]?.systemAddendum).toContain('Version two');

    // Fenced by the version the operator viewed: after the update above the row is at version 2.
    const restored = (await svc.restore(ctx(TENANT_A), created.id, 1, 2)) as { version: number };
    expect(restored.version).toBe(3);
    const afterRestore = await svc.skillsForTenant(TENANT_A);
    expect(afterRestore[0]?.systemAddendum).toBe(VALID_SKILL.systemAddendum);
  });

  test('disable removes the skill from turn-time loading (cache invalidated)', async () => {
    const prisma = makePrisma();
    const svc = new MeriFirmSkillsService(prisma as never, config as never);
    const created = (await svc.create(ctx(TENANT_A), VALID_SKILL)) as { id: string };
    expect(await svc.skillsForTenant(TENANT_A)).toHaveLength(1);
    await svc.setEnabled(ctx(TENANT_A), created.id, false, created.version);
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

    await svc.update(
      ctx(TENANT_A),
      created.id,
      { ...commitmentsWithHeading('Tenant Commitments Review') },
      created.version,
    );
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
    await disabledSvc.setEnabled(ctx(TENANT_A), disabledRow.id, false, 1);
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
    await revokedSvc.remove(ctx(TENANT_A), revokedRow.id, 1);
    await expect(
      revokedSvc.resolveProcedureReference(TENANT_A, revokedBinding),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('MeriFirmSkillsService — canonical procedure integrity', () => {
  test('rejects hollow canonical updates, restores, and resolution of tampered stored JSON', async () => {
    const prisma = makePrisma();
    const svc = new MeriFirmSkillsService(prisma as never, config as never);
    const created = (await svc.create(ctx(TENANT_A), COMMITMENTS_SKILL_INPUT)) as {
      id: string;
    };
    await expect(
      svc.update(ctx(TENANT_A), created.id, hollowCommitmentsSkill() as unknown as Row, 1),
    ).rejects.toBeInstanceOf(BadRequestException);

    await svc.update(
      ctx(TENANT_A),
      created.id,
      { ...commitmentsWithHeading('Tenant Commitments Review') },
      1,
    );
    const stored = prisma.__store[0]!;
    const history = stored.versions as Array<{ version: number; skillJson: Row }>;
    history[0]!.skillJson = hollowCommitmentsSkill() as unknown as Row;
    // The row is at version 2 after the update above; the snapshot itself is rejected before the CAS.
    await expect(svc.restore(ctx(TENANT_A), created.id, 1, 2)).rejects.toBeInstanceOf(
      BadRequestException,
    );

    const currentBinding = (await svc.skillsForTenant(TENANT_A))[0]!.procedureBinding!;
    stored.skillJson = hollowCommitmentsSkill();
    await expect(svc.resolveProcedureReference(TENANT_A, currentBinding)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('MeriFirmSkillsService — viewed-version fence on every usability mutation', () => {
  test.each(['update', 'setEnabled', 'restore', 'remove'] as const)(
    '%s refuses a future viewed version before a racing write can match it',
    async (operation) => {
      let raceEnabled = false;
      let attemptedWrites = 0;
      const prisma = makePrisma([], {
        beforeVersionWrite: async () => {
          if (!raceEnabled) return;
          attemptedWrites += 1;
          // A different writer could advance the row after this request's read.
          // Matching that later version must not permit history derived from the old read.
          prisma.__store[0]!.version = 3;
          prisma.__store[0]!.name = 'Concurrent revision';
        },
      });
      const svc = new MeriFirmSkillsService(prisma as never, config as never);
      const created = await svc.create(ctx(TENANT_A), COMMITMENTS_SKILL_INPUT);
      await svc.update(ctx(TENANT_A), created.id, { ...commitmentsWithHeading('Version Two') }, 1);
      const before = structuredClone(prisma.__store);
      const auditsBefore = prisma.__auditCreate.mock.calls.length;
      raceEnabled = true;
      const mutations = {
        update: () =>
          svc.update(ctx(TENANT_A), created.id, { ...commitmentsWithHeading('Unviewed') }, 3),
        setEnabled: () => svc.setEnabled(ctx(TENANT_A), created.id, false, 3),
        restore: () => svc.restore(ctx(TENANT_A), created.id, 1, 3),
        remove: () => svc.remove(ctx(TENANT_A), created.id, 3),
      };

      await expect(mutations[operation]()).rejects.toBeInstanceOf(ConflictException);
      expect(attemptedWrites).toBe(0);
      expect(prisma.__store).toEqual(before);
      expect(prisma.__auditCreate.mock.calls.length).toBe(auditsBefore);
    },
  );

  test('a stale viewed version writes nothing and records no audit success', async () => {
    const prisma = makePrisma();
    const svc = new MeriFirmSkillsService(prisma as never, config as never);
    const created = (await svc.create(ctx(TENANT_A), COMMITMENTS_SKILL_INPUT)) as { id: string };
    await svc.update(ctx(TENANT_A), created.id, { ...commitmentsWithHeading('Version Two') }, 1);

    const before = structuredClone(prisma.__store[0]!);
    const auditsBefore = prisma.__auditCreate.mock.calls.length;

    // The row is at version 2; the operator still holds version 1. Previously only `update`/`restore`
    // had any CAS at all (and even that compared the transaction's own read), while `setEnabled` and
    // `delete` had none — so this is the fence that did not exist.
    await expect(
      svc.update(ctx(TENANT_A), created.id, { ...commitmentsWithHeading('Stale') }, 1),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(svc.setEnabled(ctx(TENANT_A), created.id, false, 1)).rejects.toBeInstanceOf(
      ConflictException,
    );
    await expect(svc.remove(ctx(TENANT_A), created.id, 1)).rejects.toBeInstanceOf(
      ConflictException,
    );
    await expect(svc.restore(ctx(TENANT_A), created.id, 1, 1)).rejects.toBeInstanceOf(
      ConflictException,
    );

    expect(prisma.__store[0]).toEqual(before);
    expect(prisma.__auditCreate.mock.calls.length).toBe(auditsBefore);
  });

  test('the exact viewed version succeeds, and a usability mutation advances the revision', async () => {
    const prisma = makePrisma();
    const svc = new MeriFirmSkillsService(prisma as never, config as never);
    const created = (await svc.create(ctx(TENANT_A), COMMITMENTS_SKILL_INPUT)) as { id: string };

    const updated = (await svc.update(
      ctx(TENANT_A),
      created.id,
      { ...commitmentsWithHeading('Version Two') },
      1,
    )) as { version: number };
    expect(updated.version).toBe(2);

    // Disabling changes whether the turn path serves the row, so it must advance the revision.
    const toggled = (await svc.setEnabled(ctx(TENANT_A), created.id, false, 2)) as {
      version: number;
      enabled: boolean;
    };
    expect(toggled.version).toBe(3);
    expect(toggled.enabled).toBe(false);
    expect(await svc.skillsForTenant(TENANT_A)).toHaveLength(0);

    const restored = (await svc.restore(ctx(TENANT_A), created.id, 1, 3)) as { version: number };
    expect(restored.version).toBe(4);

    await svc.remove(ctx(TENANT_A), created.id, 4);
    expect(prisma.__store).toHaveLength(0);
  });

  test('a malformed or missing viewed version fails instead of falling back', async () => {
    const prisma = makePrisma();
    const svc = new MeriFirmSkillsService(prisma as never, config as never);
    const created = (await svc.create(ctx(TENANT_A), COMMITMENTS_SKILL_INPUT)) as { id: string };

    // A malformed fence must fail, not fall back. This is a BadRequest, not a Conflict: nothing was
    // attempted. `undefined` is the dangerous case — `where: { version: undefined }` drops the
    // predicate and would have made the CAS an unconditioned write.
    for (const bogus of [undefined, Number.NaN, 0] as unknown as number[]) {
      await expect(
        svc.update(ctx(TENANT_A), created.id, { ...commitmentsWithHeading('Bogus') }, bogus),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(svc.setEnabled(ctx(TENANT_A), created.id, false, bogus)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      await expect(svc.remove(ctx(TENANT_A), created.id, bogus)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      await expect(svc.restore(ctx(TENANT_A), created.id, 1, bogus)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    }
    expect(prisma.__store).toHaveLength(1);
    expect((prisma.__store[0] as { version: number }).version).toBe(1);
  });
});

describe('MeriFirmSkillsService — concurrent version compare-and-swap', () => {
  test('update/update gives one writer version 2 and conflicts the loser without reusing its binding', async () => {
    const gate = concurrentGate(2);
    const prisma = makePrisma([], { beforeVersionWrite: gate });
    const svc = new MeriFirmSkillsService(prisma as never, config as never);
    const created = (await svc.create(ctx(TENANT_A), COMMITMENTS_SKILL_INPUT)) as { id: string };
    const staleBinding = (await svc.skillsForTenant(TENANT_A))[0]!.procedureBinding!;
    const first = 'First Commitments Review';
    const second = 'Second Commitments Review';

    // Both writers viewed version 1 — the realistic stale-view race. The viewed version is now the
    // fence, so exactly one CAS can match and the loser writes nothing.
    const outcomes = await Promise.allSettled([
      svc.update(ctx(TENANT_A), created.id, { ...commitmentsWithHeading(first) }, 1),
      svc.update(ctx(TENANT_A), created.id, { ...commitmentsWithHeading(second) }, 1),
    ]);
    const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(fulfilled[0]!.value.version).toBe(2);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBeInstanceOf(ConflictException);
    expect((rejected[0]!.reason as Error).message).toContain('retry');

    await expect(svc.resolveProcedureReference(TENANT_A, staleBinding)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    const currentBinding = (await svc.skillsForTenant(TENANT_A))[0]!.procedureBinding!;
    expect(currentBinding.version).toBe(2);
    const resolved = await svc.resolveProcedureReference(TENANT_A, currentBinding);
    expect([first, second]).toContain(resolved.template?.heading);
    expect((prisma.__store[0]!.versions as Row[]).map((entry) => entry.version)).toEqual([1]);
    expect(prisma.__auditCreate).toHaveBeenCalledTimes(2);
  });

  test('update/restore gives one writer version 3 and preserves a resolvable current binding', async () => {
    let gateEnabled = false;
    const gate = concurrentGate(2);
    const prisma = makePrisma([], {
      beforeVersionWrite: async () => {
        if (gateEnabled) await gate();
      },
    });
    const svc = new MeriFirmSkillsService(prisma as never, config as never);
    const created = (await svc.create(ctx(TENANT_A), COMMITMENTS_SKILL_INPUT)) as { id: string };
    await svc.update(
      ctx(TENANT_A),
      created.id,
      { ...commitmentsWithHeading('Version Two Commitments Review') },
      1,
    );
    const staleBinding = (await svc.skillsForTenant(TENANT_A))[0]!.procedureBinding!;
    const third = 'Concurrent Commitments Review';
    gateEnabled = true;

    // Both writers viewed version 2: one CAS matches, the other conflicts atomically.
    const outcomes = await Promise.allSettled([
      svc.update(ctx(TENANT_A), created.id, { ...commitmentsWithHeading(third) }, 2),
      svc.restore(ctx(TENANT_A), created.id, 1, 2),
    ]);
    const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect((fulfilled[0] as PromiseFulfilledResult<Row>).value.version).toBe(3);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(ConflictException);

    await expect(svc.resolveProcedureReference(TENANT_A, staleBinding)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    const currentBinding = (await svc.skillsForTenant(TENANT_A))[0]!.procedureBinding!;
    expect(currentBinding.version).toBe(3);
    const resolved = await svc.resolveProcedureReference(TENANT_A, currentBinding);
    expect([commitmentsAuditProcedureSkill.template?.heading, third]).toContain(
      resolved.template?.heading,
    );
    const stored = prisma.__store[0]!;
    expect((stored.versions as Row[]).map((entry) => entry.version)).toEqual([2, 1]);
    expect(prisma.__auditCreate).toHaveBeenCalledTimes(3);
  });
});
