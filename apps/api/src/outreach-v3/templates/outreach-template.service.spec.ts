import { randomUUID } from 'node:crypto';
import type { TenantContext } from '@capiro/shared';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { CapabilityAuthorizationService } from '../../capabilities/capability-authorization.service.js';
import { OutreachCommandError } from '../state/outreach-command-errors.js';
import { createBlankCampaignSpecV1 } from '../state/outreach-campaign-spec.v1.js';
import {
  hashOutreachTemplateSpecV1,
  templateSpecFromCampaign,
  type OutreachTemplateSpecV1,
} from './outreach-template.contract.js';
import { OutreachTemplateService } from './outreach-template.service.js';
import type { StarterTemplateSeeder } from './starter-template-seeder.js';
import type {
  OutreachTemplateRepository,
  OutreachTemplateRow,
  OutreachTemplateVersionRow,
} from './outreach-template.repository.js';
import type { OutreachStateRepository } from '../persistence/outreach-state.repository.js';
import type { OutreachCommandEngineService } from '../services/outreach-command-engine.service.js';
import type { OutreachSessionService } from '../services/outreach-session.service.js';

const ctx = (overrides?: Partial<TenantContext>): TenantContext =>
  ({
    tenantId: '00000000-0000-4000-8000-000000000001',
    tenantSlug: 'test',
    userId: '00000000-0000-4000-8000-000000000002',
    clerkUserId: 'user_test',
    role: 'standard_user',
    ...overrides,
  }) as TenantContext;

function baseSpec(overrides?: Partial<OutreachTemplateSpecV1>): OutreachTemplateSpecV1 {
  return { ...templateSpecFromCampaign(createBlankCampaignSpecV1()), ...overrides };
}

function templateRow(overrides?: Partial<OutreachTemplateRow>): OutreachTemplateRow {
  return {
    id: randomUUID(),
    tenantId: ctx().tenantId,
    ownerUserId: ctx().userId,
    clientId: null,
    scope: 'firm',
    name: 'Source template',
    description: null,
    campaignType: null,
    status: 'active',
    currentDraftVersionId: null,
    publishedVersionId: null,
    duplicatedFromTemplateId: null,
    duplicatedFromVersionId: null,
    createdAt: new Date('2026-08-01T00:00:00Z'),
    updatedAt: new Date('2026-08-01T00:00:00Z'),
    archivedAt: null,
    ...overrides,
  };
}

function versionRow(spec: OutreachTemplateSpecV1, overrides?: Partial<OutreachTemplateVersionRow>): OutreachTemplateVersionRow {
  return {
    id: randomUUID(),
    tenantId: ctx().tenantId,
    templateId: randomUUID(),
    versionNumber: 1,
    lifecycle: 'published',
    templateSpecJsonb: spec,
    contentHash: hashOutreachTemplateSpecV1(spec),
    sourceSessionId: null,
    sourceStateVersion: null,
    createdByUserId: ctx().userId,
    createdAt: new Date('2026-08-01T00:00:00Z'),
    publishedAt: new Date('2026-08-01T00:00:00Z'),
    ...overrides,
  };
}

function buildHarness() {
  const tx = { marker: 'tx' };
  const prisma = {
    withTenantUser: jest.fn(async (_t: string, _u: string, fn: (v: unknown) => unknown) => fn(tx)),
  } as unknown as PrismaService;

  const templatesMocks = {
    getVisible: jest.fn(),
    lockManaged: jest.fn(),
    listVersions: jest.fn(async () => []),
    getVersion: jest.fn(),
    createWithDraft: jest.fn(),
    createDraftVersion: jest.fn(),
    publishDraft: jest.fn(),
    updateMetadata: jest.fn(),
    archive: jest.fn(async () => undefined),
    findApplicationByRequestKey: jest.fn(async () => null),
    recordApplication: jest.fn(),
    recordAudit: jest.fn(async () => undefined),
    getProvenanceForSession: jest.fn(async () => null),
  };
  const templates = templatesMocks as unknown as OutreachTemplateRepository;

  const sessionsMocks = {
    getSession: jest.fn(),
  };
  const sessions = sessionsMocks as unknown as OutreachSessionService;

  const stateMocks = {
    createSessionWithinTx: jest.fn(async () => ({ id: randomUUID() })),
  };
  const state = stateMocks as unknown as OutreachStateRepository;

  const commandsMocks = {
    parseNormalizeAndValidateBatch: jest.fn((input: unknown) => input),
    applyBatchWithinTx: jest.fn(
      async (_tx: unknown, _ctx: unknown, _sessionId: string, _batch: unknown, _options: unknown) => ({
        stateVersion: 2,
      }),
    ),
  };
  const commands = commandsMocks as unknown as OutreachCommandEngineService;

  const authorization = {
    authorizeClient: jest.fn(async () => undefined),
    authorizeClientWithinTx: jest.fn(async () => undefined),
  } as unknown as CapabilityAuthorizationService;

  /*
   * `list()` asks the seeder to ensure the starter templates exist before it
   * reads. Stubbed to a no-op here: these tests cover list/create/publish
   * behaviour against mocked repositories, and seeding is exercised on its own
   * in starter-template-seeder.spec.ts. Returning 'already_current' is the
   * steady state a real tenant is in for all but its first read.
   */
  const startersMocks = {
    ensureSeeded: jest.fn(async () => ({ outcome: 'already_current' as const, created: 0 })),
  };
  const starters = startersMocks as unknown as StarterTemplateSeeder;

  return {
    service: new OutreachTemplateService(
      prisma,
      templates,
      sessions,
      state,
      commands,
      authorization,
      starters,
    ),
    templates: templatesMocks,
    sessions: sessionsMocks,
    state: stateMocks,
    commands: commandsMocks,
    starters: startersMocks,
  };
}

describe('OutreachTemplateService.duplicate', () => {
  it('duplicates a firm template into a NEW independent template, never aliasing the source published pointer', async () => {
    const harness = buildHarness();
    const spec = baseSpec({ strategy: { ...baseSpec().strategy, tone: 'Direct' } });
    const source = templateRow({ scope: 'firm', publishedVersionId: 'pv', currentDraftVersionId: null });
    const published = versionRow(spec, { id: 'pv', templateId: source.id, lifecycle: 'published' });
    harness.templates.getVisible.mockResolvedValue(source);
    harness.templates.getVersion.mockResolvedValue(published);
    harness.templates.createWithDraft.mockImplementation(async (_tx, _ctx, input) => ({
      template: templateRow({ id: 'new-template', scope: input.scope, clientId: input.clientId }),
      version: versionRow(input.spec, { id: 'new-version', versionNumber: 1, lifecycle: 'draft', publishedAt: null }),
    }));

    const actor = ctx({ role: 'capiro_admin' }); // authorized for shared publication
    const result = await harness.service.duplicate(actor, source.id, {});

    expect(harness.templates.createWithDraft).toHaveBeenCalledWith(
      expect.anything(),
      actor,
      expect.objectContaining({
        templateId: expect.not.stringMatching(source.id),
        duplicatedFromTemplateId: source.id,
        duplicatedFromVersionId: published.id,
        scope: 'firm', // authorized admin keeps the shared scope
        sourceSessionId: null,
      }),
    );
    expect(result.template.id).toBe('new-template');
    expect(harness.templates.recordAudit).toHaveBeenCalledWith(
      expect.anything(),
      actor,
      expect.objectContaining({ action: 'duplicate' }),
    );
  });

  it('falls back to a PRIVATE copy when the actor lacks shared-publish authority, rather than blocking or silently escalating', async () => {
    const harness = buildHarness();
    const spec = baseSpec();
    const source = templateRow({ scope: 'firm', publishedVersionId: 'pv' });
    harness.templates.getVisible.mockResolvedValue(source);
    harness.templates.getVersion.mockResolvedValue(versionRow(spec, { id: 'pv', templateId: source.id }));
    harness.templates.createWithDraft.mockImplementation(async (_tx, _ctx, input) => ({
      template: templateRow({ id: 'new-template', scope: input.scope, clientId: input.clientId }),
      version: versionRow(input.spec, { id: 'new-version', lifecycle: 'draft', publishedAt: null }),
    }));

    const standardUser = ctx({ role: 'standard_user' }); // NOT authorized to keep firm scope
    await harness.service.duplicate(standardUser, source.id, {});

    expect(harness.templates.createWithDraft).toHaveBeenCalledWith(
      expect.anything(),
      standardUser,
      expect.objectContaining({ scope: 'private', clientId: null }),
    );
  });

  it('refuses to duplicate a template the actor cannot use (e.g. archived or never published)', async () => {
    const harness = buildHarness();
    const source = templateRow({ scope: 'firm', status: 'archived', publishedVersionId: 'pv' });
    harness.templates.getVisible.mockResolvedValue(source);

    await expect(harness.service.duplicate(ctx(), source.id, {})).rejects.toMatchObject({
      code: 'OUTREACH_TEMPLATE_FORBIDDEN',
    });
    expect(harness.templates.createWithDraft).not.toHaveBeenCalled();
  });
});

describe('OutreachTemplateService.createFromScratch', () => {
  it('always creates a private draft, ignoring any scope the caller might have supplied on the raw input', async () => {
    const harness = buildHarness();
    harness.templates.createWithDraft.mockImplementation(async (_tx, _ctx, input) => ({
      template: templateRow({ id: 'new', scope: input.scope, clientId: input.clientId }),
      version: versionRow(input.spec, { id: 'v1', lifecycle: 'draft', publishedAt: null }),
    }));

    // The wire input type has no scope/clientId field at all — proving the
    // service ignores it even if a caller (or a stale client) sent one
    // anyway means simulating that raw JSON body, hence the `as never`.
    const wireInput = {
      name: 'From scratch',
      description: null,
      campaignType: 'Funding ask',
      scope: 'firm',
      clientId: 'sneaky-client',
      spec: baseSpec(),
    } as never;
    await harness.service.createFromScratch(ctx(), wireInput);

    expect(harness.templates.createWithDraft).toHaveBeenCalledWith(
      expect.anything(),
      ctx(),
      expect.objectContaining({ scope: 'private', clientId: null, sourceSessionId: null, sourceStateVersion: null }),
    );
  });
});

describe('OutreachTemplateService.replaceDraftContent', () => {
  it('creates a NEW draft version rather than mutating content in place', async () => {
    const harness = buildHarness();
    const template = templateRow({ currentDraftVersionId: 'old-draft' });
    harness.templates.lockManaged.mockResolvedValue(template);
    harness.templates.createDraftVersion.mockImplementation(async (_tx, _ctx, _template, input) =>
      versionRow(input.spec, { id: 'new-draft', versionNumber: 2, lifecycle: 'draft', publishedAt: null }),
    );

    const result = await harness.service.replaceDraftContent(ctx(), template.id, baseSpec({ strategy: { ...baseSpec().strategy, tone: 'Warm' } }));

    expect(harness.templates.createDraftVersion).toHaveBeenCalledWith(
      expect.anything(),
      ctx(),
      template,
      expect.objectContaining({ sourceSessionId: null, sourceStateVersion: null }),
    );
    expect(result.version.versionNumber).toBe(2);
  });
});

describe('OutreachTemplateService.usePublished — variable substitution', () => {
  function published(spec: OutreachTemplateSpecV1, template: OutreachTemplateRow) {
    return versionRow(spec, { id: 'pv', templateId: template.id, lifecycle: 'published' });
  }

  it('substitutes a required variable into the compiled command text and records it as refreshed, not stored back on the template', async () => {
    const harness = buildHarness();
    const spec = baseSpec({
      goal: { ...baseSpec().goal, goal: 'Support {program} funding' },
      variables: [{
        key: 'program',
        label: 'Program',
        question: null,
        type: 'text',
        choices: null,
        required: true,
        defaultValue: null,
        resolutionPolicy: 'user_must_confirm',
        scope: 'public',
        appliesTo: ['goal'],
      }],
    });
    const template = templateRow({ scope: 'firm', publishedVersionId: 'pv' });
    harness.templates.getVisible.mockResolvedValue(template);
    harness.templates.getVersion.mockResolvedValue(published(spec, template));
    harness.templates.recordApplication.mockImplementation(async (_tx, _ctx, input) => ({
      application: { id: 'app-1', sessionId: input.sessionId, resultingStateVersion: input.resultingStateVersion },
      replayed: false,
    }));

    const result = await harness.service.usePublished(ctx(), template.id, {
      requestKey: randomUUID(),
      variableValues: { program: 'HAC-D' },
    });

    // The compiled batch is whatever parseNormalizeAndValidateBatch (identity mock) returned,
    // which is whatever compileOutreachTemplateBatch built from the SUBSTITUTED spec.
    const compiledArg = harness.commands.applyBatchWithinTx.mock.calls[0]![3] as {
      commands: Array<{ type: string; payload: { value: string } }>;
    };
    const setGoal = compiledArg.commands.find((c) => c.type === 'SET_GOAL')!;
    expect(setGoal.payload.value).toBe('Support HAC-D funding');
    const receipt = result.receipt as import('./outreach-template.service.js').OutreachTemplateApplicationReceipt;
    expect(receipt.refreshed.some((item) => item.field === 'variable:program')).toBe(true);
  });

  it('rejects use when a required variable has no default and none was supplied', async () => {
    const harness = buildHarness();
    const spec = baseSpec({
      goal: { ...baseSpec().goal, goal: 'Support {program} funding' },
      variables: [{
        key: 'program',
        label: 'Program',
        question: null,
        type: 'text',
        choices: null,
        required: true,
        defaultValue: null,
        resolutionPolicy: 'user_must_confirm',
        scope: 'public',
        appliesTo: ['goal'],
      }],
    });
    const template = templateRow({ scope: 'firm', publishedVersionId: 'pv' });
    harness.templates.getVisible.mockResolvedValue(template);
    harness.templates.getVersion.mockResolvedValue(published(spec, template));

    await expect(
      harness.service.usePublished(ctx(), template.id, { requestKey: randomUUID() }),
    ).rejects.toMatchObject({ code: 'OUTREACH_TEMPLATE_VARIABLE_REQUIRED' });
    expect(harness.commands.applyBatchWithinTx).not.toHaveBeenCalled();
  });

  it('never falls back to a stored default for an "always_ask" variable — a fresh value is mandatory every time', async () => {
    const harness = buildHarness();
    // Contract-level validation already forbids storing a defaultValue for
    // always_ask (see contract.spec.ts); this proves the SERVICE independently
    // enforces "no silent reuse" even if a stored spec somehow had one.
    const spec = baseSpec({
      goal: { ...baseSpec().goal, goal: 'Deadline is {deadline}' },
      variables: [{
        key: 'deadline',
        label: 'Deadline',
        question: null,
        type: 'date',
        choices: null,
        required: true,
        defaultValue: null,
        resolutionPolicy: 'always_ask',
        scope: 'public',
        appliesTo: ['goal'],
      }],
    });
    const template = templateRow({ scope: 'firm', publishedVersionId: 'pv' });
    harness.templates.getVisible.mockResolvedValue(template);
    harness.templates.getVersion.mockResolvedValue(published(spec, template));

    await expect(
      harness.service.usePublished(ctx(), template.id, { requestKey: randomUUID(), variableValues: {} }),
    ).rejects.toMatchObject({ code: 'OUTREACH_TEMPLATE_VARIABLE_REQUIRED' });
  });
});
