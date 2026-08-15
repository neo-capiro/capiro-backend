import { createHash } from 'node:crypto';
import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { QuickDraftService } from './quick-draft.service.js';
import { createInitialAgentState } from '../document-agent/document-agent-state.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { CollaboratorsService } from '../collaborators/collaborators.service.js';
import type { ContextService } from '../context/context.service.js';
import type { WorkspaceReasoningGateway } from '../workspace-reasoning/workspace-reasoning.gateway.js';
import type { GenerateFromIntakeDto, QuickDraftSourceDto } from './dto/quick-draft.dto.js';

const UPDATED_AT = new Date('2026-08-15T12:00:00.000Z');

function agentConfig(revision = 2) {
  const state = createInitialAgentState();
  state.revision = revision;
  state.documentType = { id: 'ndaa', label: 'NDAA Paper', product: 'NDAA' };
  state.blueprintPin = {
    blueprintId: 'blueprint-1',
    versionId: 'version-1',
    version: 3,
    definitionHash: 'hash-3',
  };
  state.goal = {
    text: 'Original goal',
    client: 'Overland AI',
    createdAt: '2026-08-15T11:00:00.000Z',
  };
  return { documentAgent: state };
}

function blueprintDefinition() {
  return {
    sections: [
      {
        id: 'executive-ask',
        title: 'Executive Ask',
        purpose: 'State the requested action.',
        instructions: 'Be direct.',
        required: true,
        lockedByDefault: false,
        targetWords: { min: 100, max: 180 },
      },
    ],
    evidencePolicy: { minimumSources: 1 },
    contentRules: { requiredTerms: [] },
  };
}

function makePrisma(options?: {
  revision?: number;
  blueprintExists?: boolean;
  updateCount?: number;
  messageFailure?: boolean;
}) {
  let savedConfig: Record<string, unknown> | null = null;
  const updateMany = jest.fn(async ({ data }: { data: { config: Record<string, unknown> } }) => {
    savedConfig = data.config;
    return { count: options?.updateCount ?? 1 };
  });
  const createMany = options?.messageFailure
    ? jest.fn(async () => {
        throw new Error('transcript unavailable');
      })
    : jest.fn(async () => ({ count: 2 }));

  const prisma = {
    wsDraft: {
      findFirst: jest.fn(async () => ({
        id: 'draft-1',
        docTitle: 'Autonomous Systems Readiness',
        config: agentConfig(options?.revision ?? 2),
        updatedAt: UPDATED_AT,
      })),
      updateMany,
    },
    wsBlueprintVersion: {
      findFirst: jest.fn(async () =>
        options?.blueprintExists === false
          ? null
          : {
              definition: blueprintDefinition(),
              version: 3,
            },
      ),
    },
    wsAgentMessage: { createMany },
  };

  return {
    prisma: prisma as unknown as PrismaService,
    updateMany,
    createMany,
    savedConfig: () => savedConfig,
  };
}

function sourceHash(source: QuickDraftSourceDto): string {
  return createHash('sha256')
    .update(
      [
        source.purpose,
        source.refId ?? '',
        source.url ?? '',
        source.label.trim().toLowerCase(),
      ].join('|'),
      'utf8',
    )
    .digest('hex');
}

function makeContext(existing: unknown[] = []) {
  let counter = 0;
  const addItem = jest.fn(
    async (
      _tenantId: string,
      _draftId: string,
      dto: { payload: Record<string, unknown> },
    ) => ({
      id: `${String(dto.payload.purpose)}-${++counter}`,
      payload: dto.payload,
    }),
  );
  return {
    service: {
      listItems: jest.fn(async () => existing),
      addItem,
    } as unknown as ContextService,
    addItem,
  };
}

function makeReasoning(conflicts: unknown[] = []) {
  const synthesizeBrief = jest.fn(async () => ({
    objective: 'Protect the FY27 request.',
    audience: 'HASC staff',
    desiredAction: 'Restore the reduction.',
    subject: 'Ground Robotics',
    centralArgument: 'Stable funding enables fielding.',
    tone: 'Persuasive and technical',
    targetPages: 2,
    assumptions: [],
    provenance: { objective: 'user' as const },
  }));
  const analyzeContext = jest.fn(async () => ({
    conflicts,
    coverage: {
      plannedClaims: 3,
      supportedClaims: 2,
      missingClaims: [],
    },
  }));
  const generateOutline = jest.fn(async () => ({
    sections: [
      {
        id: 'executive-ask',
        title: 'Executive Ask',
        purpose: 'State the requested action.',
        instructions: 'Be direct.',
        required: true,
        locked: false,
        targetWords: { min: 100, max: 180 },
        evidenceItemIds: ['context-1', 'sample-2', 'system-3'],
      },
    ],
  }));
  const planDocument = jest.fn(async () => ({
    evidencePlan: {
      sectionEvidence: [
        { sectionId: 'executive-ask', evidenceItemIds: ['context-1'] },
      ],
    },
    narrativePlan: { themes: ['readiness'], flow: 'ask to evidence' },
  }));
  const draftDocument = jest.fn(async () => ({
    content: '<p>Initial section.</p>',
    citations: [],
  }));
  const runEditorialPass = jest.fn(async () => ({
    sectionEdits: [
      {
        sectionId: 'executive-ask',
        content: '<p>Edited section.</p><script>alert(1)</script>',
      },
    ],
  }));

  return {
    service: {
      synthesizeBrief,
      analyzeContext,
      generateOutline,
      planDocument,
      draftDocument,
      runEditorialPass,
    } as unknown as WorkspaceReasoningGateway,
    synthesizeBrief,
    analyzeContext,
    generateOutline,
    planDocument,
    draftDocument,
    runEditorialPass,
  };
}

function collaborators(): CollaboratorsService {
  return {
    assertCan: jest.fn(async () => 'owner'),
  } as unknown as CollaboratorsService;
}

function input(sources?: QuickDraftSourceDto[]): GenerateFromIntakeDto {
  return {
    expectedRevision: 2,
    goal: 'Protect FY27 Ground Robotics funding and accelerate fielding.',
    sources:
      sources ??
      [
        {
          purpose: 'context',
          label: 'Budget source',
          text: 'The FY27 request is $192.2 million.',
          sourceType: 'user-upload',
        },
        {
          purpose: 'sample',
          label: 'Strong prior paper',
          text: 'Use this structure and tone.',
          sourceType: 'sample-document',
        },
        {
          purpose: 'system',
          label: 'Defense budget',
          text: 'Retrieve relevant defense-budget context.',
          sourceType: 'capiro-context-request',
        },
      ],
  };
}

describe('QuickDraftService', () => {
  let prisma: ReturnType<typeof makePrisma>;
  let context: ReturnType<typeof makeContext>;
  let reasoning: ReturnType<typeof makeReasoning>;

  beforeEach(() => {
    prisma = makePrisma();
    context = makeContext();
    reasoning = makeReasoning();
  });

  function service() {
    return new QuickDraftService(
      prisma.prisma,
      collaborators(),
      context.service,
      reasoning.service,
    );
  }

  it('runs the full Max plan, draft, and editorial pipeline and saves an editable draft', async () => {
    const result = await service().generateFromIntake(
      'tenant-1',
      'draft-1',
      'user-1',
      input(),
    );

    expect(reasoning.synthesizeBrief).toHaveBeenCalledTimes(1);
    expect(reasoning.analyzeContext).toHaveBeenCalledTimes(1);
    expect(reasoning.generateOutline).toHaveBeenCalledTimes(1);
    expect(reasoning.planDocument).toHaveBeenCalledTimes(1);
    expect(reasoning.draftDocument).toHaveBeenCalledTimes(1);
    expect(reasoning.runEditorialPass).toHaveBeenCalledTimes(1);
    expect(result.state.phase).toBe('draft');
    expect(result.state.generation.mode).toBe('max');
    expect(result.run.status).toBe('complete');

    const config = prisma.savedConfig() as {
      sectionContent: Record<string, string>;
      documentAgent: {
        contextPlan: { includedItemIds: string[] };
        outline: { sections: Array<{ evidenceItemIds: string[] }> };
      };
    };
    expect(config.sectionContent['Executive Ask']).toBe(
      '<p>Edited section.</p>',
    );
    expect(config.documentAgent.contextPlan.includedItemIds).toEqual([
      'context-1',
    ]);
    expect(
      config.documentAgent.outline.sections[0]?.evidenceItemIds,
    ).toEqual(['context-1']);
  });

  it('keeps sample documents and unresolved system requests out of factual evidence', async () => {
    await service().generateFromIntake(
      'tenant-1',
      'draft-1',
      'user-1',
      input(),
    );

    const planCallArgs = reasoning.planDocument.mock.calls[0] as unknown as Array<unknown> | undefined;
    const planPrompt = String(planCallArgs?.[2] ?? '{}');
    const packet = JSON.parse(planPrompt) as {
      sources: Array<{
        purpose: string;
        factualUseAllowed: boolean;
      }>;
    };
    expect(
      packet.sources.find((source) => source.purpose === 'context')
        ?.factualUseAllowed,
    ).toBe(true);
    expect(
      packet.sources.find((source) => source.purpose === 'sample')
        ?.factualUseAllowed,
    ).toBe(false);
    expect(
      packet.sources.find((source) => source.purpose === 'system')
        ?.factualUseAllowed,
    ).toBe(false);
  });

  it('preserves unresolved conflicts and does not mark factual context approved', async () => {
    reasoning = makeReasoning([
      {
        id: 'numeric:funding',
        itemIds: ['context-1'],
        type: 'numeric',
        description: 'Funding values disagree.',
        recommendedResolution: 'Verify the official source.',
      },
    ]);

    const result = await service().generateFromIntake(
      'tenant-1',
      'draft-1',
      'user-1',
      input(),
    );

    expect(result.run.status).toBe('complete_with_warnings');
    expect(result.state.contextPlan.conflicts[0]?.resolved).toBe(false);
    expect(result.state.contextPlan.approvedAt).toBeUndefined();
  });

  it('does not report a completed draft as failed when transcript recording fails', async () => {
    prisma = makePrisma({ messageFailure: true });

    const result = await service().generateFromIntake(
      'tenant-1',
      'draft-1',
      'user-1',
      input(),
    );

    expect(result.run.status).toBe('complete');
    expect(prisma.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.savedConfig()).not.toBeNull();
  });

  it('rejects a stale expectedRevision before invoking the reasoning runtime', async () => {
    prisma = makePrisma({ revision: 5 });

    await expect(
      service().generateFromIntake(
        'tenant-1',
        'draft-1',
        'user-1',
        input(),
      ),
    ).rejects.toThrow(ConflictException);
    expect(reasoning.synthesizeBrief).not.toHaveBeenCalled();
  });

  it('requires a currently published pinned blueprint version', async () => {
    prisma = makePrisma({ blueprintExists: false });

    await expect(
      service().generateFromIntake(
        'tenant-1',
        'draft-1',
        'user-1',
        input(),
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects the final save when the draft changed during Max generation', async () => {
    prisma = makePrisma({ updateCount: 0 });

    await expect(
      service().generateFromIntake(
        'tenant-1',
        'draft-1',
        'user-1',
        input(),
      ),
    ).rejects.toThrow(ConflictException);
  });

  it('deduplicates a source already attached to the draft', async () => {
    const source: QuickDraftSourceDto = {
      purpose: 'context',
      label: 'Budget source',
      text: 'Current source text',
      sourceType: 'user-upload',
    };
    context = makeContext([
      {
        id: 'existing-context',
        payload: {
          quickDraftSourceKey: sourceHash(source),
          purpose: 'context',
          label: source.label,
          text: source.text,
          sourceType: source.sourceType,
        },
      },
    ]);

    const result = await service().generateFromIntake(
      'tenant-1',
      'draft-1',
      'user-1',
      input([source]),
    );

    expect(context.addItem).not.toHaveBeenCalled();
    expect(result.state.contextPlan.includedItemIds).toEqual([
      'existing-context',
    ]);
  });
});
