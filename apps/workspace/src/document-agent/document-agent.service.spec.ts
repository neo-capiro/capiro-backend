// Document Agent Service spec — tests the service with a mocked Prisma,
// mocked CollaboratorsService, mocked reasoning gateway, and mocked
// GenerationService. Tests never call a live model provider.

import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { DocumentAgentService } from './document-agent.service.js';
import {
  createInitialAgentState,
  readAgentState,
  type DocumentAgentState,
} from './document-agent-state.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { CollaboratorsService } from '../collaborators/collaborators.service.js';
// Mock the GenerationService module to avoid importing the real one
// (which has unresolvable @capiro/meriv2-core subpaths in jest).
jest.mock('../generation/generation.service.js', () => ({
  GenerationService: jest.fn().mockImplementation(() => ({
    generateAllSections: jest.fn(),
    retryFailedSections: jest.fn(),
  })),
}));
import type { GenerationService } from '../generation/generation.service.js';
import type { WorkspaceReasoningGateway } from '../workspace-reasoning/workspace-reasoning.gateway.js';

// ── Mock factories ──────────────────────────────────────────────────────

function makeMockPrisma(): PrismaService & {
  _drafts: Map<string, Record<string, unknown>>;
  _messages: unknown[];
  _proposals: Map<string, Record<string, unknown>>;
  _contextItems: Map<string, Record<string, unknown>>;
  _templates: unknown[];
  _blueprintVersions: Map<string, Record<string, unknown>>;
} {
  const drafts = new Map<string, Record<string, unknown>>();
  const messages: unknown[] = [];
  const proposals = new Map<string, Record<string, unknown>>();
  const contextItems = new Map<string, Record<string, unknown>>();
  const blueprintVersions = new Map<string, Record<string, unknown>>();

  const prisma = {
    _drafts: drafts,
    _messages: messages,
    _proposals: proposals,
    _contextItems: contextItems,
    _templates: [],
    _blueprintVersions: blueprintVersions,
    wsDraft: {
      findFirst: jest.fn(async ({ where }: { where: { id: string; tenantId: string } }) => {
        const d = drafts.get(where.id);
        if (!d) return null;
        if (d.tenantId !== where.tenantId) return null;
        return { ...d, config: d.config ?? {} };
      }),
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const existing = drafts.get(where.id);
        if (existing) drafts.set(where.id, { ...existing, ...data });
        return drafts.get(where.id);
      }),
    },
    wsAgentMessage: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        messages.push({ id: 'msg-' + messages.length, ...data });
        return messages[messages.length - 1];
      }),
      findMany: jest.fn(async () => messages),
      findFirst: jest.fn(async () => null),
    },
    wsAgentProposal: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        proposals.set('prop-' + proposals.size, data);
        return { id: 'prop-' + (proposals.size - 1) };
      }),
      findFirst: jest.fn(async ({ where }: { where: { id: string } }) => {
        return proposals.get(where.id) ?? null;
      }),
      findMany: jest.fn(async () => Array.from(proposals.values())),
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const existing = proposals.get(where.id);
        if (existing) proposals.set(where.id, { ...existing, ...data });
        return proposals.get(where.id);
      }),
    },
    wsContextItem: {
      findMany: jest.fn(async () => Array.from(contextItems.values())),
      findFirst: jest.fn(async ({ where }: { where: { id: string } }) => contextItems.get(where.id) ?? null),
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const existing = contextItems.get(where.id);
        if (existing) contextItems.set(where.id, { ...existing, ...data });
        return contextItems.get(where.id);
      }),
    },
    wsTemplate: {
      findMany: jest.fn(async () => prisma._templates),
    },
    wsBlueprintVersion: {
      findFirst: jest.fn(async ({ where }: { where: { id: string } }) =>
        blueprintVersions.get(where.id) ?? null,
      ),
    },
  };
  return prisma as unknown as PrismaService & typeof prisma;
}

function makeMockCollaborators(): CollaboratorsService {
  return {
    assertCan: jest.fn(async () => 'owner'),
    resolveRole: jest.fn(async () => 'owner'),
  } as unknown as CollaboratorsService;
}

function makeMockGeneration(): GenerationService {
  return {
    generateAllSections: jest.fn(async () => ({ ok: true })),
    retryFailedSections: jest.fn(async () => ({ ok: true })),
  } as unknown as GenerationService;
}

function makeMockReasoning(): WorkspaceReasoningGateway {
  return {
    recommendDocumentSetup: jest.fn(async () => ({
      documentType: { id: 'ndaa', label: 'NDAA Paper', product: 'NDAA' },
      recommendedBlueprints: [],
      recommendedTheme: { id: 'default', name: 'Default' },
      questions: [],
      rationale: 'Test rationale',
    })),
    generateFollowUpQuestions: jest.fn(async () => ({ questions: [] })),
    synthesizeBrief: jest.fn(async () => ({
      objective: 'Test objective',
      audience: 'HASC staff',
      assumptions: [{ id: 'a1', text: 'Assumption 1' }],
      provenance: { objective: 'user' },
    })),
    recommendContext: jest.fn(async () => ({
      includedItemIds: [],
      excludedItems: [],
    })),
    analyzeContext: jest.fn(async () => ({
      conflicts: [],
      coverage: { plannedClaims: 0, supportedClaims: 0, missingClaims: [] },
    })),
    generateOutline: jest.fn(async () => ({
      sections: [],
    })),
  } as unknown as WorkspaceReasoningGateway;
}

function setupDraft(prisma: ReturnType<typeof makeMockPrisma>, overrides: Partial<Record<string, unknown>> = {}) {
  const state = createInitialAgentState();
  state.revision = 1;
  prisma._drafts.set('draft-1', {
    id: 'draft-1',
    tenantId: 'tenant-1',
    ownerId: 'user-1',
    config: { documentAgent: state },
    updatedAt: new Date(),
    ...overrides,
  });
}

// ── Service tests ────────────────────────────────────────────────────────

describe('DocumentAgentService', () => {
  let prisma: ReturnType<typeof makeMockPrisma>;
  let service: DocumentAgentService;

  beforeEach(() => {
    prisma = makeMockPrisma();
    service = new DocumentAgentService(
      prisma,
      makeMockCollaborators(),
      makeMockReasoning(),
      makeMockGeneration(),
    );
  });

  describe('getCatalog', () => {
    it('returns document types from templates', async () => {
      prisma._templates = [
        { id: 't1', name: 'NDAA Paper', product: 'NDAA' },
        { id: 't2', name: 'Fact Sheet', product: 'Fact Sheet' },
        { id: 't3', name: 'NDAA Brief', product: 'NDAA' },
      ];
      const result = await service.getCatalog('tenant-1');
      expect(result.documentTypes).toHaveLength(2); // deduped by product
      expect(result.documentTypes[0]!.product).toBe('NDAA');
    });
  });

  describe('recommendDocumentSetup', () => {
    it('returns recommendation from the reasoning gateway', async () => {
      const result = await service.recommendDocumentSetup('tenant-1', 'Test goal');
      expect(result.documentType.product).toBe('NDAA');
      expect(result.rationale).toBe('Test rationale');
    });
  });

  describe('getAgentState', () => {
    it('returns the agent state for a draft', async () => {
      setupDraft(prisma);
      const result = await service.getAgentState('tenant-1', 'draft-1', 'user-1');
      expect(result.state.schemaVersion).toBe(1);
    });

    it('throws 404 for non-existent draft', async () => {
      await expect(
        service.getAgentState('tenant-1', 'missing', 'user-1'),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws 404 for cross-tenant access', async () => {
      setupDraft(prisma);
      await expect(
        service.getAgentState('other-tenant', 'draft-1', 'user-1'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('initializeAgent', () => {
    it('initializes agent state on a fresh draft', async () => {
      setupDraft(prisma, { config: {} }); // no documentAgent
      const result = await service.initializeAgent('tenant-1', 'draft-1', 'user-1', {
        documentType: { id: 'ndaa', label: 'NDAA Paper', product: 'NDAA' },
      });
      expect(result.state.revision).toBe(1);
      expect(result.state.documentType?.product).toBe('NDAA');
    });

    it('is idempotent — returns existing state if already initialized', async () => {
      setupDraft(prisma);
      const result = await service.initializeAgent('tenant-1', 'draft-1', 'user-1', {});
      expect(result.state.revision).toBe(1); // unchanged
    });
  });

  describe('patchAgentState', () => {
    it('patches state with valid expectedRevision', async () => {
      setupDraft(prisma);
      const result = await service.patchAgentState(
        'tenant-1',
        'draft-1',
        'user-1',
        1, // expectedRevision
        { phase: 'blueprint' },
      );
      expect(result.state.phase).toBe('blueprint');
      expect(result.state.revision).toBe(2);
    });

    it('throws 409 on stale revision', async () => {
      setupDraft(prisma);
      await expect(
        service.patchAgentState('tenant-1', 'draft-1', 'user-1', 99, { phase: 'blueprint' }),
      ).rejects.toThrow(ConflictException);
    });

    it('throws 409 on invalid phase transition', async () => {
      setupDraft(prisma);
      await expect(
        service.patchAgentState('tenant-1', 'draft-1', 'user-1', 1, { phase: 'context' }),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('brief', () => {
    it('updates brief fields', async () => {
      setupDraft(prisma);
      const result = await service.updateBrief(
        'tenant-1', 'draft-1', 'user-1', 1,
        { objective: 'New objective' },
      );
      expect(result.state.brief.objective).toBe('New objective');
    });

    it('approves brief and transitions to context', async () => {
      // Set up draft with phase = 'brief'
      const state = createInitialAgentState();
      state.revision = 1;
      state.phase = 'brief';
      prisma._drafts.set('draft-1', {
        id: 'draft-1',
        tenantId: 'tenant-1',
        ownerId: 'user-1',
        config: { documentAgent: state },
      });
      const result = await service.approveBrief('tenant-1', 'draft-1', 'user-1', 1);
      expect(result.state.brief.approvedAt).toBeDefined();
      expect(result.state.phase).toBe('context');
    });

    it('reopens brief', async () => {
      setupDraft(prisma);
      // First approve
      await service.approveBrief('tenant-1', 'draft-1', 'user-1', 1);
      // Then reopen
      const result = await service.reopenBrief('tenant-1', 'draft-1', 'user-1', 2);
      expect(result.state.brief.approvedAt).toBeUndefined();
      expect(result.state.phase).toBe('brief');
    });
  });

  describe('outline', () => {
    it('rejects outline generation without pinned blueprint', async () => {
      setupDraft(prisma);
      await expect(
        service.generateOutline('tenant-1', 'draft-1', 'user-1', 1),
      ).rejects.toThrow(ConflictException);
    });

    it('generates outline with pinned blueprint', async () => {
      const state = createInitialAgentState();
      state.revision = 1;
      state.blueprintPin = {
        blueprintId: 'bp-1',
        versionId: 'bv-1',
        version: 1,
        definitionHash: 'hash',
      };
      prisma._drafts.set('draft-1', {
        id: 'draft-1',
        tenantId: 'tenant-1',
        ownerId: 'user-1',
        config: { documentAgent: state },
      });
      prisma._blueprintVersions.set('bv-1', {
        id: 'bv-1',
        tenantId: 'tenant-1',
        definition: { sections: [] },
      });
      const result = await service.generateOutline('tenant-1', 'draft-1', 'user-1', 1);
      expect(result.state.outline.version).toBe(1);
    });
  });

  describe('proposals', () => {
    it('creates an outline revision proposal', async () => {
      setupDraft(prisma);
      const result = await service.reviseOutline(
        'tenant-1', 'draft-1', 'user-1', 1, 'Fix the outline',
      );
      expect(result.proposal.proposalId).toBeDefined();
    });

    it('rejects a proposal', async () => {
      setupDraft(prisma);
      // First create a proposal
      const created = await service.reviseOutline(
        'tenant-1', 'draft-1', 'user-1', 1, 'Fix',
      );
      const proposalId = created.proposal.proposalId;
      // Then reject it
      const result = await service.rejectProposal(
        'tenant-1', 'draft-1', proposalId, 'user-1', 2, 'Bad idea',
      );
      expect(result.state).toBeDefined();
    });
  });

  describe('generation mode routing', () => {
    it('routes to generateAllSections for quick mode', async () => {
      const gen = makeMockGeneration();
      (gen.generateAllSections as jest.Mock).mockResolvedValue({ ok: true } as never);
      const svc = new DocumentAgentService(prisma, makeMockCollaborators(), makeMockReasoning(), gen);
      // Set up approved state.
      const state = createInitialAgentState();
      state.revision = 1;
      state.brief.approvedAt = new Date().toISOString();
      state.contextPlan.approvedAt = new Date().toISOString();
      state.outline.approvedAt = new Date().toISOString();
      prisma._drafts.set('draft-1', {
        id: 'draft-1',
        tenantId: 'tenant-1',
        ownerId: 'user-1',
        config: { documentAgent: state },
      });
      const result = await svc.generate('tenant-1', 'draft-1', 'user-1', 1, 'quick');
      expect(gen.generateAllSections).toHaveBeenCalled();
      expect(result.state.generation.mode).toBe('quick');
    });

    function setupApprovedDraft() {
      const state = createInitialAgentState();
      state.revision = 1;
      state.brief.approvedAt = new Date().toISOString();
      state.contextPlan.approvedAt = new Date().toISOString();
      state.outline.approvedAt = new Date().toISOString();
      prisma._drafts.set('draft-1', {
        id: 'draft-1',
        tenantId: 'tenant-1',
        ownerId: 'user-1',
        config: { documentAgent: state },
      });
    }

    it('renders the REAL engine run status/sectionResults instead of hardcoding complete', async () => {
      setupApprovedDraft();
      const gen = makeMockGeneration();
      (gen.generateAllSections as jest.Mock).mockResolvedValue({
        generationRun: {
          status: 'partial',
          completedAt: '2026-08-15T00:00:00.000Z',
          sectionResults: [
            { section: 'Overview', status: 'succeeded', contentChars: 500 },
            { section: 'Budget Impact', status: 'failed', errorCode: 'provider_timeout', message: 'timed out' },
          ],
        },
      } as never);
      const svc = new DocumentAgentService(prisma, makeMockCollaborators(), makeMockReasoning(), gen);

      const result = await svc.generate('tenant-1', 'draft-1', 'user-1', 1, 'standard');

      expect(result.state.status).toBe('partial'); // NOT hardcoded 'complete'
      expect(result.state.generation.lastRun?.status).toBe('partial');
      expect(result.state.generation.lastRun?.sectionResults).toEqual({
        Overview: { status: 'succeeded' },
        'Budget Impact': { status: 'failed', error: 'timed out' },
      });
    });

    it('falls back to complete when the engine returns no run summary (back-compat)', async () => {
      setupApprovedDraft();
      const gen = makeMockGeneration(); // resolves { ok: true }, no generationRun
      const svc = new DocumentAgentService(prisma, makeMockCollaborators(), makeMockReasoning(), gen);

      const result = await svc.generate('tenant-1', 'draft-1', 'user-1', 1, 'standard');

      expect(result.state.status).toBe('complete');
      expect(result.state.generation.lastRun?.status).toBe('complete');
    });

    it('propagates the real run status on retry, not a stale cached summary', async () => {
      setupApprovedDraft();
      const gen = makeMockGeneration();
      (gen.retryFailedSections as jest.Mock).mockResolvedValue({
        generationRun: {
          status: 'complete_with_warnings',
          completedAt: '2026-08-15T00:00:00.000Z',
          sectionResults: [{ section: 'Overview', status: 'succeeded', contentChars: 500 }],
        },
      } as never);
      const svc = new DocumentAgentService(prisma, makeMockCollaborators(), makeMockReasoning(), gen);

      const result = await svc.retryGeneration('tenant-1', 'draft-1', 'user-1', 1);

      expect(result.state.generation.lastRun?.status).toBe('complete_with_warnings');
      expect(result.state.status).toBe('complete'); // coarser enum has no 'complete_with_warnings'
    });
  });

  describe('patchAgentState generation mode', () => {
    it('persists generation.mode instead of silently dropping it', async () => {
      setupDraft(prisma);
      const result = await service.patchAgentState('tenant-1', 'draft-1', 'user-1', 1, {
        generation: { mode: 'max' },
      });
      expect(result.state.generation.mode).toBe('max');
    });
  });

  describe('patchContextItem', () => {
    it('enforces expectedRevision when provided', async () => {
      setupDraft(prisma);
      prisma._contextItems.set('item-1', {
        id: 'item-1', tenantId: 'tenant-1', draftId: 'draft-1', payload: { text: 'original' },
      });
      await expect(
        service.patchContextItem('tenant-1', 'draft-1', 'user-1', 'item-1', { text: 'edited' }, 99),
      ).rejects.toThrow(ConflictException);
    });

    it('merges the payload when expectedRevision matches (or is omitted)', async () => {
      setupDraft(prisma);
      prisma._contextItems.set('item-1', {
        id: 'item-1', tenantId: 'tenant-1', draftId: 'draft-1', payload: { text: 'original', keep: true },
      });
      const result = await service.patchContextItem(
        'tenant-1', 'draft-1', 'user-1', 'item-1', { text: 'edited' }, 1,
      );
      expect((result.item as { payload: Record<string, unknown> }).payload).toEqual({
        text: 'edited',
        keep: true,
      });
    });
  });
});
