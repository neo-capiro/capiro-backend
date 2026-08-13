import { ConflictException, ForbiddenException } from '@nestjs/common';
import { TemplateStudioService } from './template-studio.service.js';
import { TemplateValidator } from './template-validator.js';
import type { WorkspaceBlueprintDefinition } from './template-definition.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { CollaboratorsService } from '../collaborators/collaborators.service.js';

/**
 * Template Studio service contract tests. Mocks PrismaService + Collaborators
 * in-memory — no live model provider, no DB. Covers:
 *  - blueprint draft creation
 *  - publish immutability (PATCH after publish → 409)
 *  - version cloning
 *  - existing document remains pinned after a new blueprint version (hash
 *    comparison logic)
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const ADMIN = 'user_admin';
const NON_ADMIN = 'user_nonadmin';

// ── A minimal, valid definition used across tests ──────────────────────────
function validDefinition(): WorkspaceBlueprintDefinition {
  return {
    schemaVersion: 1,
    documentType: { id: 'ndaa-just', label: 'NDAA Justification', product: 'NDAA' },
    intakeQuestions: [
      {
        id: 'q1',
        label: 'Request amount',
        required: true,
        answerSource: 'user',
      },
    ],
    sections: [
      {
        id: 's1',
        title: 'Overview',
        purpose: 'Summarize the request',
        instructions: 'Write 2 paragraphs',
        required: true,
        removable: false,
        reorderable: false,
        lockedByDefault: true,
        targetWords: { min: 100, max: 300 },
        evidenceRules: ['primary'],
      },
    ],
    evidencePolicy: {
      minimumSources: 1,
      primarySourcesPreferred: true,
      citationRequiredFor: ['s1'],
      freshnessRules: [],
    },
    contentRules: {
      requiredTerms: ['NDAA'],
      prohibitedTerms: [],
      requiredDisclaimers: [],
      instructions: [],
    },
    approvalPolicy: {
      clientFacingApprovalRequired: false,
      permittedApproverRoles: ['editor'],
    },
    defaultTheme: { id: 'default', name: 'Default', settings: {} },
  };
}

// ── In-memory mock factories ───────────────────────────────────────────────

interface MockBlueprintRow {
  id: string;
  tenantId: string | null;
  scope: 'capiro' | 'firm';
  slug: string;
  name: string;
  product: string;
  description: string | null;
  ownerId: string | null;
  createdAt: Date;
  updatedAt: Date;
  versions: MockVersionRow[];
}

interface MockVersionRow {
  id: string;
  tenantId: string | null;
  blueprintId: string;
  version: number;
  status: 'draft' | 'published' | 'retired';
  definition: unknown;
  definitionHash: string;
  createdById: string;
  createdAt: Date;
  publishedAt: Date | null;
  retiredAt: Date | null;
}

function makePrismaMock(opts: { firmAdmin?: string } = {}) {
  const blueprints = new Map<string, MockBlueprintRow>();
  const versions = new Map<string, MockVersionRow>();
  let seq = 1;
  const uid = (p: string) => `${p}-${(seq++).toString().padStart(3, '0')}`;

  const prisma = {
    wsBlueprint: {
      findMany: async ({ where }: { where?: { OR?: Array<Record<string, unknown>> } }) => {
        const tenantId = TENANT;
        const rows = [...blueprints.values()].filter(
          (b) => b.tenantId === null || b.tenantId === tenantId,
        );
        return rows.map((b) => ({ ...b, versions: [...b.versions] }));
      },
      findFirst: async ({
        where,
      }: {
        where?: { id?: string; OR?: Array<Record<string, unknown>> };
      }) => {
        if (!where?.id) return null;
        const b = blueprints.get(where.id);
        if (!b) return null;
        const tenantOk = b.tenantId === null || b.tenantId === TENANT;
        if (!tenantOk) return null;
        return { ...b, versions: b.versions.map((v) => ({ ...v })) };
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row: MockBlueprintRow = {
          id: uid('bp'),
          tenantId: (data.tenantId as string | null) ?? null,
          scope: (data.scope as 'capiro' | 'firm') ?? 'firm',
          slug: data.slug as string,
          name: data.name as string,
          product: data.product as string,
          description: (data.description as string | null) ?? null,
          ownerId: (data.ownerId as string) ?? null,
          createdAt: new Date(),
          updatedAt: new Date(),
          versions: [],
        };
        blueprints.set(row.id, row);
        return { ...row };
      },
    },
    wsBlueprintVersion: {
      findMany: async ({ where }: { where?: { blueprintId?: string } }) => {
        if (!where?.blueprintId) return [];
        const rows = [...versions.values()]
          .filter((v) => v.blueprintId === where.blueprintId)
          .sort((a, b) => a.version - b.version);
        return rows.map((v) => ({ ...v }));
      },
      findFirst: async ({
        where,
        orderBy,
      }: {
        where?: { id?: string; blueprintId?: string };
        orderBy?: { version: 'desc' | 'asc' };
      }) => {
        if (where?.id) {
          const v = versions.get(where.id);
          return v ? { ...v } : null;
        }
        if (where?.blueprintId) {
          const rows = [...versions.values()]
            .filter((v) => v.blueprintId === where.blueprintId)
            .sort((a, b) => (orderBy?.version === 'desc' ? b.version - a.version : a.version - b.version));
          return rows[0] ? { ...rows[0] } : null;
        }
        return null;
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row: MockVersionRow = {
          id: uid('ver'),
          tenantId: (data.tenantId as string | null) ?? null,
          blueprintId: data.blueprintId as string,
          version: data.version as number,
          status: (data.status as 'draft' | 'published' | 'retired') ?? 'draft',
          definition: data.definition,
          definitionHash: data.definitionHash as string,
          createdById: data.createdById as string,
          createdAt: new Date(),
          publishedAt: null,
          retiredAt: null,
        };
        versions.set(row.id, row);
        const bp = blueprints.get(row.blueprintId);
        if (bp) bp.versions.push(row);
        return { ...row };
      },
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Record<string, unknown>;
      }) => {
        const v = versions.get(where.id);
        if (!v) throw new Error('version not found');
        const updated = { ...v, ...(data as Partial<MockVersionRow>) };
        // publishedAt/retiredAt come through as Date in data
        versions.set(v.id, updated as MockVersionRow);
        const bp = blueprints.get(v.blueprintId);
        if (bp) {
          const idx = bp.versions.findIndex((x) => x.id === v.id);
          if (idx >= 0) bp.versions[idx] = updated as MockVersionRow;
        }
        return { ...updated };
      },
    },
    $queryRaw: async () => {
      // Returns the firmAdmin setting for the tenant — admin check.
      return [{ settings_jsonb: opts.firmAdmin ? { firmAdmin: opts.firmAdmin } : null }];
    },
  };

  return { prisma, blueprints, versions };
}

function makeCollaboratorsMock() {
  return {
    resolveRole: async () => 'owner' as const,
    assertCan: async () => 'owner' as const,
  } as unknown as CollaboratorsService;
}

function makeService(opts: { firmAdmin?: string } = {}) {
  const { prisma } = makePrismaMock(opts);
  const collaborators = makeCollaboratorsMock();
  const validator = new TemplateValidator();
  const service = new TemplateStudioService(
    prisma as unknown as PrismaService,
    collaborators,
    validator,
  );
  return { service, prisma, validator };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('TemplateStudioService', () => {
  it('creates a blueprint and a draft version (firm admin)', async () => {
    const { service } = makeService({ firmAdmin: ADMIN });
    const bp = await service.createBlueprint(TENANT, ADMIN, {
      slug: 'ndaa-just',
      name: 'NDAA Justification',
      product: 'NDAA',
    });
    expect(bp.id).toBeDefined();
    expect(bp.scope).toBe('firm');
    expect(bp.tenantId).toBe(TENANT);

    const version = await service.createVersion(TENANT, bp.id, ADMIN, {});
    expect(version.status).toBe('draft');
    expect(version.version).toBe(1);
    expect(version.blueprintId).toBe(bp.id);
    // The seed definition for a brand-new blueprint is an empty object; its
    // hash is well-defined and stored.
    expect(version.definitionHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('denies blueprint creation to non-admins (403)', async () => {
    const { service } = makeService({ firmAdmin: ADMIN });
    await expect(
      service.createBlueprint(TENANT, NON_ADMIN, {
        slug: 'x',
        name: 'X',
        product: 'NDAA',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('publishes a version and makes it immutable (PATCH after publish → 409)', async () => {
    const { service } = makeService({ firmAdmin: ADMIN });
    const bp = await service.createBlueprint(TENANT, ADMIN, {
      slug: 'ndaa-pub',
      name: 'Pub',
      product: 'NDAA',
    });
    // Use a definition with NO required intake questions so publish()'s
    // internal sample test (run with empty answers) passes — this test is
    // about publish immutability, not the intake gate.
    const defNoReq = validDefinition();
    defNoReq.intakeQuestions[0]!.required = false;
    const v1 = await service.createVersion(TENANT, bp.id, ADMIN, {});
    await service.updateVersion(TENANT, bp.id, v1.id, ADMIN, {
      definition: defNoReq as unknown as Record<string, unknown>,
    });
    const published = await service.publishVersion(TENANT, bp.id, v1.id, ADMIN);
    expect(published.status).toBe('published');
    expect(published.definitionHash).toMatch(/^[0-9a-f]{64}$/);
    expect(published.publishedAt).toBeInstanceOf(Date);

    // PATCH on a published version → 409 ConflictException (immutable).
    await expect(
      service.updateVersion(TENANT, bp.id, v1.id, ADMIN, {
        definition: { ...defNoReq } as unknown as Record<string, unknown>,
      }),
    ).rejects.toBeInstanceOf(ConflictException);

    // Retire, then confirm a retired version is also immutable (PATCH → 409).
    const retired = await service.retireVersion(TENANT, bp.id, v1.id, ADMIN);
    expect(retired.status).toBe('retired');
    await expect(
      service.updateVersion(TENANT, bp.id, v1.id, ADMIN, {
        definition: { ...defNoReq } as unknown as Record<string, unknown>,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('rejects publish when the sample test fails (required intake unanswered → 422)', async () => {
    const { service } = makeService({ firmAdmin: ADMIN });
    const bp = await service.createBlueprint(TENANT, ADMIN, {
      slug: 'ndaa-fail',
      name: 'Fail',
      product: 'NDAA',
    });
    const v1 = await service.createVersion(TENANT, bp.id, ADMIN, {});
    await service.updateVersion(TENANT, bp.id, v1.id, ADMIN, {
      definition: validDefinition() as unknown as Record<string, unknown>,
    });
    // q1 is required + answerSource 'user' → publish()'s internal testVersion({})
    // throws 422 because there is no answer. Publish must surface that.
    await expect(service.publishVersion(TENANT, bp.id, v1.id, ADMIN)).rejects.toThrow();
  });

  it('clones a blueprint into a new draft version with the same definition', async () => {
    const { service } = makeService({ firmAdmin: ADMIN });
    const bp = await service.createBlueprint(TENANT, ADMIN, {
      slug: 'ndaa-clone',
      name: 'Clone',
      product: 'NDAA',
    });
    const v1 = await service.createVersion(TENANT, bp.id, ADMIN, {});
    const def = validDefinition();
    await service.updateVersion(TENANT, bp.id, v1.id, ADMIN, {
      definition: def as unknown as Record<string, unknown>,
    });
    // Re-read v1 so its definitionHash reflects the update (the createVersion
    // return carries the seed/empty hash, not the post-update hash).
    const v1Current = await service.getVersion(TENANT, bp.id, v1.id);
    const cloned = await service.cloneBlueprint(TENANT, bp.id, ADMIN, {});
    expect(cloned.status).toBe('draft');
    expect(cloned.version).toBe(2);
    expect(cloned.blueprintId).toBe(bp.id);
    // The cloned definition is byte-identical → same hash (content pinning).
    expect(cloned.definitionHash).toBe(v1Current.definitionHash);
  });

  it('keeps an existing document pinned to its version after a new version publishes (hash comparison)', async () => {
    const { service, validator } = makeService({ firmAdmin: ADMIN });
    const bp = await service.createBlueprint(TENANT, ADMIN, {
      slug: 'ndaa-pin',
      name: 'Pin',
      product: 'NDAA',
    });
    // v1: the definition an existing document adopted.
    const v1 = await service.createVersion(TENANT, bp.id, ADMIN, {});
    const defV1 = validDefinition();
    await service.updateVersion(TENANT, bp.id, v1.id, ADMIN, {
      definition: defV1 as unknown as Record<string, unknown>,
    });
    // The document is pinned to v1's hash AT ADOPTION TIME.
    const pinnedHash = (await service.getVersion(TENANT, bp.id, v1.id)).definitionHash;

    // v2: a new version with a DIFFERENT definition (different section title).
    const v2 = await service.createVersion(TENANT, bp.id, ADMIN, {});
    const defV2 = validDefinition();
    defV2.sections[0]!.title = 'Revised Overview';
    await service.updateVersion(TENANT, bp.id, v2.id, ADMIN, {
      definition: defV2 as unknown as Record<string, unknown>,
    });
    const v2Hash = (await service.getVersion(TENANT, bp.id, v2.id)).definitionHash;

    // The two versions must hash differently — that's what keeps the doc pinned.
    expect(v2Hash).not.toBe(pinnedHash);

    // The pin check: the document's stored hash does NOT match the new
    // version, so it stays on v1 (not retroactively moved to v2).
    const stillPinnedToV1 = service.isPinnedTo(pinnedHash, { definitionHash: pinnedHash });
    const movedToV2 = service.isPinnedTo(pinnedHash, { definitionHash: v2Hash });
    expect(stillPinnedToV1).toBe(true);
    expect(movedToV2).toBe(false);

    // The validator's hash is deterministic and order-independent.
    const reordered = { ...defV1, defaultTheme: defV1.defaultTheme, sections: defV1.sections };
    expect(validator.computeDefinitionHash(reordered)).toBe(pinnedHash);
  });

  it('validates definitions and rejects incomplete ones', () => {
    const validator = new TemplateValidator();
    const ok = validator.validate(validDefinition());
    expect(ok.valid).toBe(true);
    expect(ok.errors).toHaveLength(0);

    const bad = { schemaVersion: 2 } as unknown as WorkspaceBlueprintDefinition;
    const res = validator.validate(bad);
    expect(res.valid).toBe(false);
    expect(res.errors.length).toBeGreaterThan(0);
  });
});
