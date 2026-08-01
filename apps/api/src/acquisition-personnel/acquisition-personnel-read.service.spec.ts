import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import {
  AcquisitionPersonnelReadService,
  inferRoleType,
} from './acquisition-personnel-read.service.js';
import { classifyContactUse, CONTACT_USE_LABELS } from './contact-use.policy.js';

const ctx: TenantContext = {
  tenantId: '00000000-0000-0000-0000-000000000001',
  tenantSlug: 'capiro',
  userId: '00000000-0000-0000-0000-000000000002',
  clerkUserId: 'user_test',
  role: 'capiro_admin',
};

const PE = '0604802A';

interface Row {
  [k: string]: unknown;
}

/**
 * In-memory Prisma double mirroring the slice of the client the read service touches.
 * AcquisitionPersonnel / PersonRole / ProgramOffice / Program* are GLOBAL tables, so
 * the service reads them via the base client (no tenant scoping); withTenant/​
 * $transaction just pass the same store through.
 */
function makePrisma(seed: {
  personnel?: Row[];
  personRoles?: Row[];
  offices?: Row[];
  programs?: Row[];
  officeLinks?: Row[];
  peMatches?: Row[];
  candidates?: Row[];
  peSources?: Row[];
}) {
  const store = {
    personnel: [...(seed.personnel ?? [])],
    personRoles: [...(seed.personRoles ?? [])],
    offices: [...(seed.offices ?? [])],
    programs: [...(seed.programs ?? [])],
    officeLinks: [...(seed.officeLinks ?? [])],
    peMatches: [...(seed.peMatches ?? [])],
    candidates: [...(seed.candidates ?? [])],
    peSources: [...(seed.peSources ?? [])],
    auditLogs: [] as Row[],
    personnelSources: [] as Row[],
  };

  let roleSeq = 0;

  const inFilter = (val: unknown, set: { in?: unknown[] } | undefined): boolean => {
    if (!set || !Array.isArray(set.in)) return true;
    return set.in.includes(val);
  };

  const prisma = {
    __store: store,

    withTenant: async <T>(
      _tenantId: string,
      fn: (tx: Record<string, unknown>) => Promise<T>,
    ): Promise<T> => fn(prisma as Record<string, unknown>),
    $transaction: async <T>(fn: (tx: Record<string, unknown>) => Promise<T>): Promise<T> =>
      fn(prisma as Record<string, unknown>),

    auditLog: {
      create: async ({ data }: { data: Row }) => {
        store.auditLogs.push(data);
        return data;
      },
    },

    acquisitionPersonnel: {
      findMany: async ({ where }: { where: Row }) => {
        const w = where as {
          supersededAt?: null;
          OR?: Array<{ pePrimary?: string; peSecondary?: { has?: string } }>;
        };
        return store.personnel.filter((p) => {
          if (w.supersededAt === null && p.supersededAt) return false;
          if (w.OR) {
            return w.OR.some((cond) => {
              if (cond.pePrimary !== undefined) return p.pePrimary === cond.pePrimary;
              if (cond.peSecondary?.has !== undefined) {
                return (
                  Array.isArray(p.peSecondary) &&
                  (p.peSecondary as string[]).includes(cond.peSecondary.has)
                );
              }
              return false;
            });
          }
          return true;
        });
      },
      findUnique: async ({ where }: { where: { id: string } }) =>
        store.personnel.find((p) => p.id === where.id) ?? null,
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        const w = where as { id: string; pePrimary?: null };
        let count = 0;
        for (const p of store.personnel) {
          if (p.id === w.id && (w.pePrimary !== null || p.pePrimary == null)) {
            Object.assign(p, data);
            count += 1;
          }
        }
        return { count };
      },
    },

    acquisitionPersonnelSource: {
      create: async ({ data }: { data: Row }) => {
        store.personnelSources.push(data);
        return data;
      },
    },

    personRole: {
      findMany: async ({ where, include }: { where: Row; include?: Row }) => {
        const w = where as {
          personId?: { in?: string[] };
          reviewStatus?: { not?: string };
        };
        const rows = store.personRoles.filter(
          (r) =>
            inFilter(r.personId, w.personId) &&
            (w.reviewStatus?.not === undefined || r.reviewStatus !== w.reviewStatus.not),
        );
        if (!include) return rows;
        // Emulate the office/program relation joins.
        return rows.map((r) => {
          const out: Row = { ...r };
          if ((include as Row).office) {
            const office = store.offices.find((o) => o.id === r.officeId);
            out.office = office ? { name: office.name } : null;
          }
          if ((include as Row).program) {
            const program = store.programs.find((pg) => pg.id === r.programId);
            out.program = program ? { canonicalName: program.canonicalName } : null;
          }
          return out;
        });
      },
      findFirst: async ({ where }: { where: Row }) => {
        const w = where as { personId: string; roleTitle: string; source: string };
        return (
          store.personRoles.find(
            (r) =>
              r.personId === w.personId && r.roleTitle === w.roleTitle && r.source === w.source,
          ) ?? null
        );
      },
      create: async ({ data }: { data: Row }) => {
        const row = { id: `role-${++roleSeq}`, ...data };
        store.personRoles.push(row);
        return row;
      },
    },

    programOffice: {
      findFirst: async ({ where }: { where: Row }) => {
        const w = where as { name?: string | { equals?: string; mode?: string } };
        if (typeof w.name === 'string') {
          return store.offices.find((o) => o.name === w.name) ?? null;
        }
        if (w.name && typeof w.name === 'object' && w.name.equals) {
          const target = w.name.equals.toLowerCase();
          return store.offices.find((o) => String(o.name).toLowerCase() === target) ?? null;
        }
        return null;
      },
    },

    programOfficeProgramLink: {
      findMany: async ({ where }: { where: Row }) => {
        const w = where as {
          officeId?: { in?: string[] };
          programId?: { in?: string[] };
          reviewStatus?: string;
        };
        return store.officeLinks.filter(
          (l) =>
            inFilter(l.officeId, w.officeId) &&
            inFilter(l.programId, w.programId) &&
            (w.reviewStatus === undefined || l.reviewStatus === w.reviewStatus),
        );
      },
    },

    peProgramMatch: {
      findMany: async ({ where }: { where: Row }) => {
        const w = where as { programId?: { in?: string[] }; peCode?: string; status?: string };
        return store.peMatches.filter(
          (m) =>
            inFilter(m.programId, w.programId) &&
            (w.peCode === undefined || m.peCode === w.peCode) &&
            (w.status === undefined || m.status === w.status),
        );
      },
    },

    programElementSource: {
      findFirst: async () => store.peSources[0] ?? null,
    },

    programElementPersonCandidate: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        store.candidates.find((c) => c.id === where.id) ?? null,
      update: async ({ where, data }: { where: { id: string }; data: Row }) => {
        const c = store.candidates.find((x) => x.id === where.id);
        if (c) Object.assign(c, data);
        return c;
      },
    },
  };

  return prisma;
}

function makePerson(over: Row = {}): Row {
  const now = new Date('2026-06-01T00:00:00Z');
  return {
    id: 'p1',
    fullName: 'Col. Jane Doe',
    service: 'ARMY',
    organization: 'PEO Aviation',
    title: 'Program Manager, FLRAA',
    role: 'Program Manager',
    pePrimary: PE,
    peSecondary: [],
    emailDomain: 'army.mil',
    publicProfileUrl: null,
    metadata: {},
    confidence: 0.9,
    status: 'active',
    supersededAt: null,
    firstSeenAt: now,
    lastSeenAt: now,
    sources: [{ id: 's1' }],
    ...over,
  };
}

function makeRole(over: Row = {}): Row {
  return {
    id: 'r1',
    personId: 'p1',
    officeId: 'office-1',
    programId: 'program-1',
    roleTitle: 'Program Manager',
    roleType: 'pm',
    source: 'peo_roster',
    sourceUrl: null,
    observedAt: new Date('2026-05-01T00:00:00Z'),
    staleAt: null,
    confidence: 0.8,
    reviewStatus: 'accepted',
    contactUse: 'program_ownership_context',
    ...over,
  };
}

describe('AcquisitionPersonnelReadService.getProgramElementPersonnel — role attachment', () => {
  test('attaches the FULL role chain (office manages program; program maps to PE)', async () => {
    const prisma = makePrisma({
      personnel: [makePerson()],
      offices: [{ id: 'office-1', name: 'PEO Aviation' }],
      programs: [{ id: 'program-1', canonicalName: 'FLRAA' }],
      personRoles: [makeRole()],
      officeLinks: [{ officeId: 'office-1', programId: 'program-1', reviewStatus: 'accepted' }],
      peMatches: [{ programId: 'program-1', peCode: PE, status: 'accepted' }],
    });
    const svc = new AcquisitionPersonnelReadService(prisma as never);

    const result = await svc.getProgramElementPersonnel(PE, ctx);

    expect(result).toHaveLength(1);
    const person = result[0]!;
    expect(person.roles).toHaveLength(1);
    const role = person.roles![0]!;
    expect(role.id).toBe('r1');
    expect(role.officeName).toBe('PEO Aviation');
    expect(role.programName).toBe('FLRAA');
    expect(role.contactUse).toBe('program_ownership_context');
    expect(role.contactUseLabel).toBe(CONTACT_USE_LABELS.program_ownership_context);
    expect(role.observedAt).toBe('2026-05-01T00:00:00.000Z');
    expect(role.staleAt).toBeNull();
    expect(role.whyShown).toBe(
      'Program Manager at PEO Aviation; office manages FLRAA; FLRAA maps to PE 0604802A',
    );
    expect(role.whyShown.toLowerCase()).not.toContain('owns pe');
  });

  test('preserves all existing person fields alongside the new roles array', async () => {
    const prisma = makePrisma({
      personnel: [makePerson({ metadata: { headshotUrl: 'https://img/x.png' } })],
      offices: [{ id: 'office-1', name: 'PEO Aviation' }],
      programs: [{ id: 'program-1', canonicalName: 'FLRAA' }],
      personRoles: [makeRole()],
      officeLinks: [{ officeId: 'office-1', programId: 'program-1', reviewStatus: 'accepted' }],
      peMatches: [{ programId: 'program-1', peCode: PE, status: 'accepted' }],
    });
    const svc = new AcquisitionPersonnelReadService(prisma as never);

    const person = (await svc.getProgramElementPersonnel(PE, ctx))[0]!;

    expect(person.id).toBe('p1');
    expect(person.fullName).toBe('Col. Jane Doe');
    expect(person.headshotUrl).toBe('https://img/x.png');
    expect(person.sourceCount).toBe(1);
    expect(person.firstSeenAt).toBe('2026-06-01T00:00:00.000Z');
    expect(Array.isArray(person.roles)).toBe(true);
  });

  test('partial chain: accepted office->program link missing -> names that missing hop', async () => {
    const prisma = makePrisma({
      personnel: [makePerson()],
      offices: [{ id: 'office-1', name: 'PEO Aviation' }],
      programs: [{ id: 'program-1', canonicalName: 'FLRAA' }],
      personRoles: [makeRole()],
      officeLinks: [], // no accepted link
      peMatches: [{ programId: 'program-1', peCode: PE, status: 'accepted' }],
    });
    const svc = new AcquisitionPersonnelReadService(prisma as never);

    const role = (await svc.getProgramElementPersonnel(PE, ctx))[0]!.roles![0]!;
    expect(role.whyShown).toBe(
      'Program Manager at PEO Aviation, but no accepted office->program link yet',
    );
  });

  test('partial chain: link only candidate (not accepted) is NOT counted', async () => {
    const prisma = makePrisma({
      personnel: [makePerson()],
      offices: [{ id: 'office-1', name: 'PEO Aviation' }],
      programs: [{ id: 'program-1', canonicalName: 'FLRAA' }],
      personRoles: [makeRole()],
      officeLinks: [{ officeId: 'office-1', programId: 'program-1', reviewStatus: 'candidate' }],
      peMatches: [{ programId: 'program-1', peCode: PE, status: 'accepted' }],
    });
    const svc = new AcquisitionPersonnelReadService(prisma as never);

    const role = (await svc.getProgramElementPersonnel(PE, ctx))[0]!.roles![0]!;
    expect(role.whyShown).toBe(
      'Program Manager at PEO Aviation, but no accepted office->program link yet',
    );
  });

  test('partial chain: program not mapped to this PE -> names that missing hop', async () => {
    const prisma = makePrisma({
      personnel: [makePerson()],
      offices: [{ id: 'office-1', name: 'PEO Aviation' }],
      programs: [{ id: 'program-1', canonicalName: 'FLRAA' }],
      personRoles: [makeRole()],
      officeLinks: [{ officeId: 'office-1', programId: 'program-1', reviewStatus: 'accepted' }],
      peMatches: [], // no accepted PE match
    });
    const svc = new AcquisitionPersonnelReadService(prisma as never);

    const role = (await svc.getProgramElementPersonnel(PE, ctx))[0]!.roles![0]!;
    expect(role.whyShown).toBe(
      'Program Manager at PEO Aviation; office manages FLRAA, but no program mapped to this PE yet',
    );
  });

  test('partial chain: no office resolved -> names the missing office hop', async () => {
    const prisma = makePrisma({
      personnel: [makePerson()],
      offices: [],
      programs: [],
      personRoles: [makeRole({ officeId: null, programId: null })],
    });
    const svc = new AcquisitionPersonnelReadService(prisma as never);

    const role = (await svc.getProgramElementPersonnel(PE, ctx))[0]!.roles![0]!;
    expect(role.officeName).toBeNull();
    expect(role.whyShown).toBe('Program Manager, but no office resolved for this role yet');
  });

  test('unknown contactUse falls back to the raw value as its label', async () => {
    const prisma = makePrisma({
      personnel: [makePerson()],
      offices: [{ id: 'office-1', name: 'PEO Aviation' }],
      programs: [{ id: 'program-1', canonicalName: 'FLRAA' }],
      personRoles: [makeRole({ contactUse: 'some_future_value' })],
    });
    const svc = new AcquisitionPersonnelReadService(prisma as never);

    const role = (await svc.getProgramElementPersonnel(PE, ctx))[0]!.roles![0]!;
    expect(role.contactUse).toBe('some_future_value');
    expect(role.contactUseLabel).toBe('some_future_value');
  });

  test('staleAt is surfaced as an ISO string when set', async () => {
    const prisma = makePrisma({
      personnel: [makePerson()],
      offices: [{ id: 'office-1', name: 'PEO Aviation' }],
      programs: [{ id: 'program-1', canonicalName: 'FLRAA' }],
      personRoles: [makeRole({ staleAt: new Date('2026-06-07T00:00:00Z') })],
    });
    const svc = new AcquisitionPersonnelReadService(prisma as never);

    const role = (await svc.getProgramElementPersonnel(PE, ctx))[0]!.roles![0]!;
    expect(role.staleAt).toBe('2026-06-07T00:00:00.000Z');
  });

  test('person with no PersonRole rows gets roles: [] with a legacy pe_primary whyShown? — empty array', async () => {
    const prisma = makePrisma({
      personnel: [makePerson()],
      personRoles: [],
    });
    const svc = new AcquisitionPersonnelReadService(prisma as never);

    const person = (await svc.getProgramElementPersonnel(PE, ctx))[0]!;
    expect(person.roles).toEqual([]);
  });

  test('batches the role query: constant personRole.findMany (not N+1) regardless of person count', async () => {
      const prisma = makePrisma({
        personnel: [makePerson({ id: 'p1' }), makePerson({ id: 'p2', fullName: 'Maj. John Roe' })],
        offices: [{ id: 'office-1', name: 'PEO Aviation' }],
        programs: [{ id: 'program-1', canonicalName: 'FLRAA' }],
        personRoles: [makeRole({ id: 'r1', personId: 'p1' }), makeRole({ id: 'r2', personId: 'p2' })],
        officeLinks: [{ officeId: 'office-1', programId: 'program-1', reviewStatus: 'accepted' }],
        peMatches: [{ programId: 'program-1', peCode: PE, status: 'accepted' }],
      });
      const spy = jest.spyOn(prisma.personRole, 'findMany');
      const svc = new AcquisitionPersonnelReadService(prisma as never);

      const result = await svc.getProgramElementPersonnel(PE, ctx);

      expect(result).toHaveLength(2);
      expect(result[0]!.roles).toHaveLength(1);
      expect(result[1]!.roles).toHaveLength(1);
      //One query in resolveChainPersonIds + one in fetchRolesByPerson (attach + CRM gate inputs).
      // Must remain constant vs person count (not N+1).
      expect(spy).toHaveBeenCalledTimes(2);
    });

  test('HIDES quarantined roles but KEEPS accepted + candidate (badged) roles', async () => {
    const prisma = makePrisma({
      personnel: [makePerson()],
      offices: [{ id: 'office-1', name: 'PEO Aviation' }],
      programs: [{ id: 'program-1', canonicalName: 'FLRAA' }],
      personRoles: [
        makeRole({ id: 'r-accepted', reviewStatus: 'accepted' }),
        makeRole({ id: 'r-candidate', reviewStatus: 'candidate', contactUse: 'candidate' }),
        makeRole({ id: 'r-quarantined', reviewStatus: 'quarantined', contactUse: 'quarantined' }),
      ],
    });
    const svc = new AcquisitionPersonnelReadService(prisma as never);

    const roles = (await svc.getProgramElementPersonnel(PE, ctx))[0]!.roles!;
    const ids = roles.map((r) => r.id);
    expect(ids).toContain('r-accepted');
    expect(ids).toContain('r-candidate'); // shown, UI badges it "requires review"
    expect(ids).not.toContain('r-quarantined'); // suspect data never surfaces
  });
});

describe('AcquisitionPersonnelReadService.resolvePersonCandidate — matcher evolution', () => {
  function seedConfirm(over: Row = {}) {
    return makePrisma({
      personnel: [makePerson({ id: 'p1', pePrimary: null, ...over })],
      offices: [{ id: 'office-1', name: 'PEO Aviation' }],
      candidates: [
        {
          id: 'cand-1',
          personId: 'p1',
          peCode: PE,
          score: 0.82,
          matchBasis: 'exact pe',
          status: 'open',
        },
      ],
    });
  }

  test('CONFIRM creates exactly one accepted person_role row with policy-derived contactUse', async () => {
    const prisma = seedConfirm();
    const svc = new AcquisitionPersonnelReadService(prisma as never);

    const result = await svc.resolvePersonCandidate('cand-1', 'confirm', 'looks right', ctx);

    expect(result).toEqual({ resolved: true, linked: true });
    const roles = prisma.__store.personRoles;
    expect(roles).toHaveLength(1);
    const role = roles[0]!;
    expect(role.personId).toBe('p1');
    expect(role.source).toBe('pe_match_confirmed');
    expect(role.programId).toBeNull(); // PE<->program is a separate graph
    expect(role.officeId).toBe('office-1'); // resolved from organization
    expect(role.roleTitle).toBe('Program Manager, FLRAA');
    expect(role.roleType).toBe('pm');
    expect(role.reviewStatus).toBe('accepted');
    expect(role.confidence).toBe(0.82);
    // contact_use is NOT NULL and must come from the policy.
    expect(role.contactUse).toBe(
      classifyContactUse({
        roleType: 'pm',
        source: 'pe_match_confirmed',
        reviewStatus: 'accepted',
      }),
    );
    expect(role.contactUse).toBe('program_ownership_context');
    // existing pe_primary behavior preserved.
    expect(prisma.__store.personnel[0]!.pePrimary).toBe(PE);
  });

  test('REJECT does NOT create a person_role row and does not link', async () => {
    const prisma = seedConfirm();
    const svc = new AcquisitionPersonnelReadService(prisma as never);

    const result = await svc.resolvePersonCandidate('cand-1', 'reject', undefined, ctx);

    expect(result).toEqual({ resolved: true, linked: false });
    expect(prisma.__store.personRoles).toHaveLength(0);
    expect(prisma.__store.personnel[0]!.pePrimary).toBeNull();
  });

  test('re-CONFIRM is idempotent: no duplicate person_role OR provenance source row', async () => {
    const prisma = seedConfirm();
    const svc = new AcquisitionPersonnelReadService(prisma as never);

    const first = await svc.resolvePersonCandidate('cand-1', 'confirm', undefined, ctx);
    const second = await svc.resolvePersonCandidate('cand-1', 'confirm', undefined, ctx);

    expect(first).toEqual({ resolved: true, linked: true });
    // Second confirm is a no-op (candidate already resolved) — returns idempotently.
    expect(second).toEqual({ resolved: true, linked: true });
    expect(prisma.__store.personRoles).toHaveLength(1);
    // The pe_match_confirmed provenance source must be written exactly once, not
    // re-appended on the second call (split-transaction / double-click guard).
    expect(prisma.__store.personnelSources).toHaveLength(1);
  });

  test('CONFIRM with no matching office leaves officeId null (never creates an office)', async () => {
    const prisma = seedConfirm({ organization: 'Some Unknown Shop' });
    const svc = new AcquisitionPersonnelReadService(prisma as never);

    await svc.resolvePersonCandidate('cand-1', 'confirm', undefined, ctx);

    const role = prisma.__store.personRoles[0]!;
    expect(role.officeId).toBeNull();
    expect(prisma.__store.offices).toHaveLength(1); // unchanged
  });

  test('CONFIRM resolves office case-insensitively against the organization', async () => {
    const prisma = makePrisma({
      personnel: [makePerson({ id: 'p1', pePrimary: null, organization: 'peo aviation' })],
      offices: [{ id: 'office-1', name: 'PEO Aviation' }],
      candidates: [
        { id: 'cand-1', personId: 'p1', peCode: PE, score: 0.7, matchBasis: 'x', status: 'open' },
      ],
    });
    const svc = new AcquisitionPersonnelReadService(prisma as never);

    await svc.resolvePersonCandidate('cand-1', 'confirm', undefined, ctx);

    expect(prisma.__store.personRoles[0]!.officeId).toBe('office-1');
  });
});

describe('inferRoleType', () => {
  test.each([
    ['Deputy Program Manager', null, 'deputy'],
    [null, 'Contracting Officer', 'contracting_officer'],
    ['Chief Engineer', null, 'chief_engineer'],
    ['Program Executive Officer', null, 'peo'],
    ['Program Manager', 'PM, FLRAA', 'pm'],
    ['Contract Specialist', null, 'staff'],
    ['', '', 'other'],
    [null, null, 'other'],
  ])('infers %s / %s -> %s', (role, title, expected) => {
    expect(inferRoleType(role as string | null, title as string | null)).toBe(expected);
  });

  test('passes through a canonical enum value in the role field', () => {
    expect(inferRoleType('peo', null)).toBe('peo');
    expect(inferRoleType('chief_engineer', null)).toBe('chief_engineer');
  });
});


describe('AcquisitionPersonnelReadService.linkCrmContact contact-use gate', () => {
  const PE = '0603270A';
  const OTHER_PE = '0603250F';
  const ctx = {
    tenantId: 'tenant-a',
    tenantSlug: 'a',
    userId: 'user-a',
    clerkUserId: 'clerk-a',
    role: 'standard_user',
  };

  function makeLinkHarness(opts: {
    roles?: Array<{
      id: string;
      contactUse: string;
      reviewStatus: string;
      programId: string | null;
      officeId: string | null;
    }>;
    peMatches?: Array<{ programId: string; peCode: string; status: string }>;
    contactTenantId?: string;
    personExists?: boolean;
  }) {
    const roles = opts.roles ?? [];
    const peMatches = opts.peMatches ?? [{ programId: 'program-1', peCode: PE, status: 'accepted' }];
    const audits: Array<Record<string, unknown>> = [];
    const contactTenantId = opts.contactTenantId ?? ctx.tenantId;
    const personExists = opts.personExists !== false;
    let linked = false;

    const tx = {
      engagementContact: {
        findFirst: jest.fn(async ({ where }: { where: { id: string; tenantId: string } }) => {
          if (where.tenantId !== contactTenantId) return null;
          if (where.id !== 'contact-1') return null;
          return { id: 'contact-1', tenantId: contactTenantId };
        }),
        update: jest.fn(async () => {
          linked = true;
          return { id: 'contact-1' };
        }),
      },
      auditLog: {
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          audits.push(data);
          return data;
        }),
      },
    };

    const prisma = {
      withTenant: jest.fn(async (_t: string, fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
      acquisitionPersonnel: {
        findUnique: jest.fn(async ({ where }: { where: { id: string } }) =>
          personExists && where.id === 'person-1' ? { id: 'person-1' } : null,
        ),
      },
      personRole: {
        findMany: jest.fn(async () => roles),
      },
      peProgramMatch: {
        findMany: jest.fn(async ({ where }: { where: { peCode?: string; programId?: { in?: string[] }; status?: string } }) => {
          return peMatches.filter((m) => {
            if (where.peCode && m.peCode !== where.peCode) return false;
            if (where.status && m.status !== where.status) return false;
            if (where.programId?.in && !where.programId.in.includes(m.programId)) return false;
            return true;
          });
        }),
      },
      programOfficeProgramLink: {
        findMany: jest.fn(async () => []),
      },
    };

    // Dynamic import path preserved — construct service with mocked prisma
    const { AcquisitionPersonnelReadService } = require('./acquisition-personnel-read.service');
    const svc = new AcquisitionPersonnelReadService(prisma as never);
    return { svc, audits, prisma, tx, getLinked: () => linked };
  }

  test('blocks official procurement POC and audits without PII', async () => {
    const { svc, audits, getLinked } = makeLinkHarness({
      roles: [
        {
          id: 'r1',
          contactUse: 'official_procurement_poc',
          reviewStatus: 'accepted',
          programId: 'program-1',
          officeId: null,
        },
      ],
    });
    await expect(svc.linkCrmContact('person-1', 'contact-1', PE, ctx as never)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(getLinked()).toBe(false);
    expect(audits.some((a) => a.action === 'acquisition_personnel.crm_link.blocked')).toBe(true);
    const blocked = audits.find((a) => a.action === 'acquisition_personnel.crm_link.blocked')!;
    const after = blocked.after as Record<string, unknown>;
    expect(after.adminBypass).toBe(false);
    expect(JSON.stringify(after)).not.toMatch(/@|Jane|email/i);
  });

  test('blocks procurement-sensitive, candidate, quarantined', async () => {
    for (const contactUse of [
      'do_not_contact_procurement_sensitive',
      'candidate',
      'quarantined',
    ]) {
      const { svc, getLinked } = makeLinkHarness({
        roles: [
          {
            id: 'r1',
            contactUse,
            reviewStatus: contactUse === 'quarantined' ? 'quarantined' : 'candidate',
            programId: 'program-1',
            officeId: null,
          },
        ],
      });
      await expect(svc.linkCrmContact('person-1', 'contact-1', PE, ctx as never)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(getLinked()).toBe(false);
    }
  });

  test('allows program_ownership_context link and audits allowed path without PII', async () => {
    const { svc, audits, getLinked } = makeLinkHarness({
      roles: [
        {
          id: 'r1',
          contactUse: 'program_ownership_context',
          reviewStatus: 'accepted',
          programId: 'program-1',
          officeId: null,
        },
      ],
    });
    await expect(svc.linkCrmContact('person-1', 'contact-1', PE, ctx as never)).resolves.toEqual({
      linked: true,
    });
    expect(getLinked()).toBe(true);
    const ok = audits.find((a) => a.action === 'acquisition_personnel.crm_link');
    expect(ok).toBeTruthy();
    expect(JSON.stringify(ok!.after)).not.toMatch(/@|fullName|Smith/i);
  });

  test('role on another PE cannot authorize this PE', async () => {
    const { svc, getLinked } = makeLinkHarness({
      roles: [
        {
          id: 'r1',
          contactUse: 'program_ownership_context',
          reviewStatus: 'accepted',
          programId: 'program-other',
          officeId: null,
        },
      ],
      peMatches: [{ programId: 'program-other', peCode: OTHER_PE, status: 'accepted' }],
    });
    await expect(svc.linkCrmContact('person-1', 'contact-1', PE, ctx as never)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(getLinked()).toBe(false);
  });

  test('mixed blocked + allowed applicable roles: allowed wins', async () => {
    const { svc, getLinked } = makeLinkHarness({
      roles: [
        {
          id: 'r-block',
          contactUse: 'official_procurement_poc',
          reviewStatus: 'accepted',
          programId: 'program-1',
          officeId: null,
        },
        {
          id: 'r-allow',
          contactUse: 'program_ownership_context',
          reviewStatus: 'accepted',
          programId: 'program-1',
          officeId: null,
        },
      ],
    });
    await expect(svc.linkCrmContact('person-1', 'contact-1', PE, ctx as never)).resolves.toEqual({
      linked: true,
    });
    expect(getLinked()).toBe(true);
  });

  test('cross-tenant engagement contact is rejected', async () => {
    const { svc, getLinked } = makeLinkHarness({ contactTenantId: 'tenant-b' });
    // personRole empty -> would block for no role, but contact missing throws NotFound first
    // Force contact miss by different tenant
    await expect(svc.linkCrmContact('person-1', 'contact-1', PE, ctx as never)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(getLinked()).toBe(false);
  });

  test('requires exact peCode', async () => {
    const { svc } = makeLinkHarness({});
    await expect(svc.linkCrmContact('person-1', 'contact-1', '   ', ctx as never)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  test('capiro_admin does not bypass the CRM link gate', async () => {
    const adminCtx = { ...ctx, role: 'capiro_admin' };
    const { svc, getLinked } = makeLinkHarness({
      roles: [
        {
          id: 'r1',
          contactUse: 'official_procurement_poc',
          reviewStatus: 'accepted',
          programId: 'program-1',
          officeId: null,
        },
      ],
    });
    await expect(
      svc.linkCrmContact('person-1', 'contact-1', PE, adminCtx as never),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(getLinked()).toBe(false);
  });
});
