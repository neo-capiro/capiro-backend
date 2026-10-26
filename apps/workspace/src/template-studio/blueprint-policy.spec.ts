import { describe, it, expect, jest } from '@jest/globals';
import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { TemplateStudioService } from './template-studio.service.js';
import { TemplateValidator } from './template-validator.js';
import type { WorkspaceBlueprintDefinition } from './template-definition.js';

const tenant = 'tenant-one',
  owner = 'original-author',
  member = 'another-member';
const definition: WorkspaceBlueprintDefinition = {
  schemaVersion: 1,
  documentType: { id: 'brief', label: 'Brief', product: 'Brief' },
  intakeQuestions: [],
  sections: [
    {
      id: 'summary',
      title: 'Summary',
      purpose: 'Summarize',
      instructions: 'Use evidence',
      required: true,
      removable: false,
      reorderable: false,
      lockedByDefault: true,
      targetWords: { min: 10, max: 100 },
      evidenceRules: [],
    },
  ],
  evidencePolicy: {
    minimumSources: 0,
    primarySourcesPreferred: false,
    citationRequiredFor: [],
    freshnessRules: [],
  },
  contentRules: {
    requiredTerms: [],
    prohibitedTerms: [],
    requiredDisclaimers: [],
    instructions: [],
  },
  defaultTheme: { id: 'default', name: 'Default', settings: {} },
};

function fixture(scope: 'global' | 'firm' | 'foreign', status = 'draft') {
  const validator = new TemplateValidator();
  const blueprint = {
    id: 'blueprint',
    tenantId: scope === 'global' ? null : scope === 'firm' ? tenant : 'other-tenant',
    ownerId: owner,
  };
  let version = {
    id: 'version',
    blueprintId: blueprint.id,
    tenantId: blueprint.tenantId,
    version: 1,
    status,
    definition: structuredClone(definition),
    definitionHash: validator.computeDefinitionHash(definition),
  };
  let beforeUpdate = () => {};
  const db = {
    wsBlueprint: {
      findFirst: jest.fn(
        async ({ where }: { where: { id: string; OR: Array<{ tenantId: string | null }> } }) =>
          where.id === blueprint.id && where.OR.some((x) => x.tenantId === blueprint.tenantId)
            ? { ...blueprint }
            : null,
      ),
    },
    wsBlueprintVersion: {
      findMany: jest.fn(async () => [{ ...version }]),
      findFirst: jest.fn(async () => ({ ...version })),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'new-version',
        ...data,
      })),
      update: jest.fn(
        async ({
          where,
          data,
        }: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) => {
          beforeUpdate();
          if (
            Object.entries(where).some(
              ([key, value]) => version[key as keyof typeof version] !== value,
            )
          )
            throw Object.assign(new Error('Conditional update did not match'), { code: 'P2025' });
          version = { ...version, ...data };
          return { ...version };
        },
      ),
    },
  };
  return {
    service: new TemplateStudioService(db as never, validator),
    db,
    blueprint,
    current: () => version,
    race: (change: Partial<typeof version>) => {
      beforeUpdate = () => {
        version = { ...version, ...change };
      };
    },
  };
}

const actions: Array<
  [string, (service: TemplateStudioService, actor: string) => Promise<unknown>]
> = [
  [
    'create version',
    (s: TemplateStudioService, actor: string) => s.createVersion(tenant, 'blueprint', actor, {}),
  ],
  [
    'clone',
    (s: TemplateStudioService, actor: string) => s.cloneBlueprint(tenant, 'blueprint', actor, {}),
  ],
  [
    'edit',
    (s: TemplateStudioService, actor: string) =>
      s.updateVersion(tenant, 'blueprint', 'version', actor, {
        definition: definition as unknown as Record<string, unknown>,
      }),
  ],
  [
    'publish',
    (s: TemplateStudioService, actor: string) =>
      s.publishVersion(tenant, 'blueprint', 'version', actor),
  ],
  [
    'retire',
    (s: TemplateStudioService, actor: string) =>
      s.retireVersion(tenant, 'blueprint', 'version', actor),
  ],
];

describe('Blueprint existing owner policy', () => {
  it.each(actions)('refuses global non-owner %s before any version write', async (_name, act) => {
    const h = fixture('global');
    await expect(act(h.service, member)).rejects.toBeInstanceOf(ForbiddenException);
    expect(h.db.wsBlueprintVersion.create).not.toHaveBeenCalled();
    expect(h.db.wsBlueprintVersion.update).not.toHaveBeenCalled();
    expect(h.db.wsBlueprintVersion.findFirst).not.toHaveBeenCalled();
  });

  it.each(actions)('allows original global owner %s', async (name, act) => {
    const h = fixture('global', name === 'retire' ? 'published' : 'draft');
    await expect(act(h.service, owner)).resolves.toBeDefined();
  });

  it.each(actions)('preserves firm member %s without an admin or owner gate', async (name, act) => {
    const h = fixture('firm', name === 'retire' ? 'published' : 'draft');
    await expect(act(h.service, member)).resolves.toBeDefined();
  });

  it.each(actions)('conceals another tenant before %s', async (_name, act) => {
    const h = fixture('foreign');
    await expect(act(h.service, owner)).rejects.toBeInstanceOf(NotFoundException);
    expect(h.db.wsBlueprintVersion.create).not.toHaveBeenCalled();
    expect(h.db.wsBlueprintVersion.update).not.toHaveBeenCalled();
  });

  it('preserves global reads and refuses ownerless global writes', async () => {
    const h = fixture('global');
    await expect(h.service.getBlueprint(tenant, 'blueprint')).resolves.toBeDefined();
    await expect(h.service.getVersion(tenant, 'blueprint', 'version')).resolves.toBeDefined();
    h.blueprint.ownerId = '';
    await expect(h.service.createVersion(tenant, 'blueprint', member, {})).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(h.db.wsBlueprintVersion.create).not.toHaveBeenCalled();
  });
});

describe('Blueprint immutable version writes', () => {
  it('cannot edit a version published after the initial read', async () => {
    const h = fixture('firm');
    h.race({ status: 'published' });
    await expect(
      h.service.updateVersion(tenant, 'blueprint', 'version', member, { definition: {} }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(h.current().definition).toEqual(definition);
  });

  it('cannot publish a definition changed after validation', async () => {
    const h = fixture('firm');
    h.race({ definitionHash: 'a'.repeat(64) });
    await expect(
      h.service.publishVersion(tenant, 'blueprint', 'version', member),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(h.current().status).toBe('draft');
  });

  it('cannot repeat a retirement that won after the initial read', async () => {
    const h = fixture('firm', 'published');
    h.race({ status: 'retired' });
    await expect(
      h.service.retireVersion(tenant, 'blueprint', 'version', member),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
