// Document Agent Service spec — tests the service with a mocked Prisma,
// mocked CollaboratorsService, mocked reasoning gateway, and mocked
// GenerationService. Tests never call a live model provider.

import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import { ConflictException, ForbiddenException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { DocumentAgentService, REVISION_CONFLICT_CODE } from './document-agent.service.js';
import {
  computeContentHash,
  createInitialAgentState,
  readAgentState,
  type DocumentAgentOutlineSection,
  type DocumentAgentState,
} from './document-agent-state.js';
import { DocumentAgentRevisionService } from './document-agent-revision.service.js';
import type {
  NativeGenerationTurnOutcome,
  NativeGenerationTurnPort,
} from './native-generation.bridge.js';
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
      updateMany: jest.fn(async ({ where, data }: { where: { id: string; config?: { equals: unknown } }; data: Record<string, unknown> }) => {
        const existing = drafts.get(where.id);
        if (!existing || (where.config && JSON.stringify(existing.config ?? {}) !== JSON.stringify(where.config.equals))) return { count: 0 };
        drafts.set(where.id, { ...existing, ...data });
        return { count: 1 };
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

function makeMockCollaborators(
  role: 'owner' | 'editor' | 'reviewer' | 'commenter' | 'viewer' = 'owner',
): CollaboratorsService {
  return {
    // The real `assertCan` applies the caller's predicate to the resolved role.
    assertCan: jest.fn(
      async (
        _tenantId: string,
        _draftId: string,
        _actorId: string,
        predicate: (resolved: typeof role) => boolean,
      ) => {
        if (!predicate(role)) {
          throw new ForbiddenException('You do not have permission to access this document');
        }
        return role;
      },
    ),
    resolveRole: jest.fn(async () => role),
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

// ── Native owner harness (WS-22) ─────────────────────────────────────────
// The supported generated phases are admitted through the approved greenfield
// native conversation turn owner, never through the legacy
// `WorkspaceReasoningGateway` / `GenerationService` seam. The tests drive a
// plain recorder port (no network, model, SDK or database is touched) and the
// EXISTING revision owner (`DocumentAgentRevisionService`) runs against the
// mocked Prisma store, so a pending `content_revision` really is created,
// accepted, or left exactly as it was.

const OUTLINE_SECTIONS: DocumentAgentOutlineSection[] = [
  {
    id: 's1',
    title: 'Ask',
    purpose: 'state the ask',
    instructions: 'be precise',
    required: true,
    locked: false,
    targetWords: { min: 50, max: 120 },
    evidenceItemIds: [],
  },
  {
    id: 's2',
    title: 'Budget Impact',
    purpose: 'quantify the impact',
    instructions: 'cite the PE',
    required: true,
    locked: false,
    targetWords: { min: 50, max: 120 },
    evidenceItemIds: [],
  },
];

/** The exact document body the approved outline admits. */
const DOCUMENT_BODY = {
  status: 'complete',
  runId: 'run-1',
  result: {
    document: {
      sections: [
        { id: 's1', text: 'Ask body' },
        { id: 's2', text: 'Budget body' },
      ],
    },
  },
} as unknown as NativeGenerationTurnOutcome;

type TurnRecorder = ReturnType<typeof makeTurn>;

function makeTurn(outcome: NativeGenerationTurnOutcome = DOCUMENT_BODY) {
  let next = outcome;
  const requests: Array<Record<string, unknown>> = [];
  const options: unknown[] = [];
  const turn = jest.fn(async (request: Record<string, unknown>, callOptions: unknown) => {
    requests.push(request);
    options.push(callOptions);
    return next;
  });
  const readTurn = jest.fn(async () => null);
  const cancel = jest.fn(async () => undefined);
  return {
    requests,
    options,
    turn,
    readTurn,
    cancel,
    port: { turn, readTurn, cancel } as unknown as NativeGenerationTurnPort,
    setOutcome: (value) => {
      next = value;
    },
  };
}

/**
 * The service under test with the native turn port injected. `revisions: null`
 * means the existing proposal owner is NOT composed for the deployment.
 */
function makeService(
  prisma: ReturnType<typeof makeMockPrisma>,
  options: {
    turn?: TurnRecorder;
    role?: 'owner' | 'editor' | 'reviewer' | 'commenter' | 'viewer';
    revisions?: DocumentAgentRevisionService | null;
    generation?: GenerationService;
  } = {},
): DocumentAgentService {
  const revisions =
    options.revisions === null
      ? undefined
      : options.revisions ?? new DocumentAgentRevisionService(prisma as unknown as PrismaService);
  return new DocumentAgentService(
    prisma,
    makeMockCollaborators(options.role),
    makeMockReasoning(),
    options.generation ?? makeMockGeneration(),
    revisions,
    options.turn?.port,
  );
}

/** An approved draft whose outline is exactly the sections the body must key. */
function setupApprovedDraft(
  prisma: ReturnType<typeof makeMockPrisma>,
  configOverrides: Record<string, unknown> = {},
): DocumentAgentState {
  const state = createInitialAgentState();
  state.revision = 1;
  state.brief.approvedAt = '2026-10-28T00:00:00.000Z';
  state.contextPlan.approvedAt = '2026-10-28T00:00:00.000Z';
  state.outline.sections = OUTLINE_SECTIONS;
  state.outline.version = 1;
  state.outline.approvedAt = '2026-10-28T00:00:00.000Z';
  prisma._drafts.set('draft-1', {
    id: 'draft-1',
    tenantId: 'tenant-1',
    ownerId: 'user-1',
    config: { documentAgent: state, ...configOverrides },
    updatedAt: new Date(),
  });
  return state;
}

const CREDENTIAL = 'session-credential';

function configOf(prisma: ReturnType<typeof makeMockPrisma>): Record<string, unknown> {
  return prisma._drafts.get('draft-1')!.config as Record<string, unknown>;
}

/**
 * The mock prisma's draft writes are jest mocks at runtime; the fixture's type
 * (`PrismaService & typeof prisma`) resolves `updateMany` to the Prisma
 * signature, so the mock surface is stated once here instead of cast per call.
 */
function draftWrites(
  prisma: ReturnType<typeof makeMockPrisma>,
): jest.Mock<(args: unknown) => Promise<{ count: number }>> {
  return prisma.wsDraft.updateMany as unknown as jest.Mock<
    (args: unknown) => Promise<{ count: number }>
  >;
}

function proposalOf(
  prisma: ReturnType<typeof makeMockPrisma>,
  proposalId: string,
): Record<string, unknown> {
  return prisma._proposals.get(proposalId) as unknown as Record<string, unknown>;
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
    it('cannot replace newer ordinary content after loading its agent revision', async () => {
      setupDraft(prisma);
      (prisma.wsDraft.findFirst as any).mockImplementationOnce(async () => {
        const before = structuredClone(prisma._drafts.get('draft-1'));
        const current = prisma._drafts.get('draft-1')!;
        prisma._drafts.set('draft-1', { ...current, config: {
          ...(current.config as object), sectionContent: { Overview: 'Newer manual content' },
        } });
        return before;
      });
      await expect(service.patchAgentState('tenant-1', 'draft-1', 'user-1', 1, { phase: 'blueprint' }))
        .rejects.toThrow(ConflictException);
      expect(prisma._drafts.get('draft-1')?.config).toMatchObject({ sectionContent: { Overview: 'Newer manual content' } });
    });
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
    it('rejects outline generation without pinned blueprint before any paid turn', async () => {
      setupDraft(prisma);
      const turn = makeTurn();
      const svc = makeService(prisma, { turn });
      await expect(
        svc.generateOutline('tenant-1', 'draft-1', 'user-1', 1, true, CREDENTIAL),
      ).rejects.toThrow(ConflictException);
      expect(turn.turn).not.toHaveBeenCalled();
      expect(prisma._proposals.size).toBe(0);
    });

    it('admits a pinned-blueprint outline through the native owner as a PENDING proposal', async () => {
      const nativeOutline = [
        {
          id: 's1',
          title: 'Ask',
          purpose: 'state the ask',
          instructions: 'be precise',
          required: true,
          locked: false,
          targetWords: { min: 50, max: 120 },
          evidenceItemIds: [],
        },
      ];
      const state = createInitialAgentState();
      state.revision = 1;
      state.blueprintPin = {
        blueprintId: '11111111-1111-4111-8111-111111111111',
        versionId: '22222222-2222-4222-8222-222222222222',
        version: 1,
        definitionHash: 'a'.repeat(64),
      };
      prisma._drafts.set('draft-1', {
        id: 'draft-1',
        tenantId: 'tenant-1',
        ownerId: 'user-1',
        config: { documentAgent: state },
      });
      prisma._blueprintVersions.set(state.blueprintPin.versionId, {
        id: state.blueprintPin.versionId,
        blueprintId: state.blueprintPin.blueprintId,
        tenantId: 'tenant-1',
        version: 1,
        definitionHash: state.blueprintPin.definitionHash,
        status: 'published',
        publishedAt: new Date(),
        definition: { sections: [] },
      });
      const turn = makeTurn({
        status: 'complete',
        runId: 'run-outline',
        result: { outline: nativeOutline },
      } as unknown as NativeGenerationTurnOutcome);
      const svc = makeService(prisma, { turn });

      const result = await svc.generateOutline('tenant-1', 'draft-1', 'user-1', 1, true, CREDENTIAL);

      // The retired legacy reasoning gateway is never consulted for this phase.
      expect(turn.turn).toHaveBeenCalledTimes(1);
      expect(turn.requests[0]!.phase).toBe('outline');
      expect(turn.requests[0]!.paidGeneration).toBe(true);
      expect(result.status).toBe('proposed');
      expect(result.proposal?.proposalId).toBeDefined();
      // The change is PENDING: the draft's own outline is untouched until a
      // reviewer accepts it through the existing revision owner.
      expect(result.state.outline.version).toBe(0);
      expect(result.state.outline.sections).toEqual([]);
      const proposal = proposalOf(prisma, result.proposal!.proposalId);
      expect(proposal.type).toBe('outline_revision');
      expect(proposal.status).toBe('pending');
      expect(proposal.baseRevision).toBe(1);
      expect(proposal.payload).toMatchObject({
        outlineSnapshot: nativeOutline,
        nativeGeneration: { phase: 'outline', runId: 'run-outline' },
      });
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
    it('admits the document phase for quick mode through the native owner, never the retired engine', async () => {
      setupApprovedDraft(prisma);
      const gen = makeMockGeneration();
      const turn = makeTurn();
      const svc = makeService(prisma, { turn, generation: gen });

      const result = await svc.generate('tenant-1', 'draft-1', 'user-1', 1, 'quick', true, CREDENTIAL);

      // The retired legacy engine seam is never consulted for a supported phase.
      expect(gen.generateAllSections).not.toHaveBeenCalled();
      expect(turn.turn).toHaveBeenCalledTimes(1);
      const request = turn.requests[0]!;
      expect(request.phase).toBe('document');
      expect(request.paidGeneration).toBe(true);
      expect(turn.options[0] as Record<string, unknown>).toMatchObject({ credential: CREDENTIAL });
      // The approved outline's exact section ids travel as the retained sources.
      expect(request.sources).toEqual(
        expect.arrayContaining([
          { id: 'draft-1', kind: 'workspace-draft' },
          { id: 's1', kind: 'outline-section' },
          { id: 's2', kind: 'outline-section' },
        ]),
      );

      // The mode is retained and the run stays ACTIVE until a reviewer accepts.
      expect(result.state.generation.mode).toBe('quick');
      expect(result.run?.status).toBe('active');
      expect(result.state.status).toBe('generating');
      expect(result.status).toBe('approval-required');
      expect(result.state.pendingProposalId).toBe(result.proposal?.proposalId);
    });

    it('admits the completed native body as a PENDING content_revision and writes no content', async () => {
      setupApprovedDraft(prisma, { sectionContent: { s2: 'retained budget text' } });
      const svc = makeService(prisma, { turn: makeTurn() });

      const result = await svc.generate('tenant-1', 'draft-1', 'user-1', 1, 'standard', true, CREDENTIAL);

      const proposal = proposalOf(prisma, result.proposal!.proposalId);
      expect(proposal.type).toBe('content_revision');
      expect(proposal.status).toBe('pending');
      expect(proposal.baseRevision).toBe(1);
      // The base hash is the hash of the EXACT retained content the accept path re-checks.
      expect(proposal.baseHash).toBe(computeContentHash({ s2: 'retained budget text' }));
      expect(proposal.payload).toMatchObject({
        revisedContent: { s1: 'Ask body', s2: 'Budget body' },
        runId: 'run-1',
        mode: 'standard',
      });
      // Nothing lands in the draft's existing content field before an explicit accept.
      expect(configOf(prisma).sectionContent).toEqual({ s2: 'retained budget text' });
      expect(result.status).toBe('approval-required');
    });

    it('refuses to invent a completion when the native result carries no document body', async () => {
      setupApprovedDraft(prisma);
      const turn = makeTurn({
        status: 'complete',
        runId: 'run-9',
        result: {},
      } as unknown as NativeGenerationTurnOutcome);
      const svc = makeService(prisma, { turn });

      await expect(
        svc.generate('tenant-1', 'draft-1', 'user-1', 1, 'standard', true, CREDENTIAL),
      ).rejects.toThrow(ConflictException);

      expect(prisma._proposals.size).toBe(0);
      const state = readAgentState(configOf(prisma));
      expect(state.status).not.toBe('complete');
      expect(state.pendingProposalId).toBeUndefined();
      expect(configOf(prisma)).not.toHaveProperty('sectionContent');
    });

    it('reports the native owner\'s own approval-required admission without writing content', async () => {
      setupApprovedDraft(prisma);
      const turn = makeTurn({
        status: 'approval_required',
        runId: 'run-5',
        proposalId: 'prop-native',
      } as unknown as NativeGenerationTurnOutcome);
      const svc = makeService(prisma, { turn });

      const result = await svc.generate('tenant-1', 'draft-1', 'user-1', 1, 'standard', true, CREDENTIAL);

      expect(result.status).toBe('approval-required');
      expect(result.proposal).toEqual({ proposalId: 'prop-native' });
      expect(result.state.pendingProposalId).toBe('prop-native');
      // No content_revision is invented: the native owner admitted the proposal.
      expect(prisma._proposals.size).toBe(0);
      expect(configOf(prisma)).not.toHaveProperty('sectionContent');
    });

    it('propagates the real run status on retry, not a stale cached summary', async () => {
      setupApprovedDraft(prisma);
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

  // The document phase lands a completed native body as a PENDING
  // `content_revision` through the EXISTING Workspace revision owner. Only an
  // explicit accept by a reviewer holding `canReview`, with the content hash
  // still matching, merges the exact sections. Every refusal path (stale hash,
  // stale revision, withdrawn proposal, body that does not key the approved
  // outline) leaves the proposal, the state and the content exactly as they were.
  describe('native document body through the existing revision owner', () => {
    async function admitBody(
      svc: DocumentAgentService,
    ): Promise<{ proposalId: string; revision: number }> {
      const admitted = await svc.generate(
        'tenant-1', 'draft-1', 'user-1', 1, 'standard', true, CREDENTIAL,
      );
      return { proposalId: admitted.proposal!.proposalId, revision: admitted.state.revision };
    }

    it('an explicit accept by a reviewer with the current base hash merges the exact sections', async () => {
      setupApprovedDraft(prisma, { sectionContent: { s2: 'retained budget text' } });
      const turn = makeTurn();
      const svc = makeService(prisma, { turn });
      const { proposalId, revision } = await admitBody(svc);

      // A role without `canReview` cannot land the body.
      const nonReviewer = makeService(prisma, { turn, role: 'viewer' });
      await expect(
        nonReviewer.acceptProposal('tenant-1', 'draft-1', proposalId, 'user-9', revision),
      ).rejects.toThrow(ForbiddenException);
      expect(configOf(prisma).sectionContent).toEqual({ s2: 'retained budget text' });
      expect(proposalOf(prisma, proposalId).status).toBe('pending');

      const accepted = await svc.acceptProposal('tenant-1', 'draft-1', proposalId, 'user-1', revision);

      expect(configOf(prisma).sectionContent).toEqual({ s1: 'Ask body', s2: 'Budget body' });
      expect(proposalOf(prisma, proposalId).status).toBe('accepted');
      expect(accepted.state.pendingProposalId).toBeUndefined();
    });

    it('a changed retained content turns the accept into PROPOSAL_STALE and writes no content', async () => {
      setupApprovedDraft(prisma, { sectionContent: { s2: 'retained budget text' } });
      const svc = makeService(prisma, { turn: makeTurn() });
      const { proposalId, revision } = await admitBody(svc);

      // A human edits the retained content after the body was admitted.
      prisma._drafts.set('draft-1', {
        ...prisma._drafts.get('draft-1')!,
        config: { ...configOf(prisma), sectionContent: { s2: 'newer manual text' } },
      });

      await expect(
        svc.acceptProposal('tenant-1', 'draft-1', proposalId, 'user-1', revision),
      ).rejects.toThrow(ConflictException);

      expect(proposalOf(prisma, proposalId).status).toBe('stale');
      expect(configOf(prisma).sectionContent).toEqual({ s2: 'newer manual text' });
      // The state did not lose its pointer to a proposal that never landed.
      expect(readAgentState(configOf(prisma)).pendingProposalId).toBe(proposalId);
    });

    it('a stale expectedRevision leaves the proposal pending and writes no content', async () => {
      setupApprovedDraft(prisma, { sectionContent: { s2: 'retained budget text' } });
      const svc = makeService(prisma, { turn: makeTurn() });
      const { proposalId, revision } = await admitBody(svc);

      await expect(
        svc.acceptProposal('tenant-1', 'draft-1', proposalId, 'user-1', revision + 1),
      ).rejects.toThrow(ConflictException);

      expect(proposalOf(prisma, proposalId).status).toBe('pending');
      expect(configOf(prisma).sectionContent).toEqual({ s2: 'retained budget text' });
      expect(readAgentState(configOf(prisma)).revision).toBe(revision);
    });

    it('a proposal that is no longer pending cannot be accepted', async () => {
      setupApprovedDraft(prisma, { sectionContent: { s2: 'retained budget text' } });
      const svc = makeService(prisma, { turn: makeTurn() });
      const { proposalId, revision } = await admitBody(svc);

      // A reviewer withdraws the body through the existing owner.
      await svc.rejectProposal('tenant-1', 'draft-1', proposalId, 'user-1', revision, 'not needed');

      await expect(
        svc.acceptProposal('tenant-1', 'draft-1', proposalId, 'user-1', revision),
      ).rejects.toThrow(ConflictException);

      expect(proposalOf(prisma, proposalId).status).toBe('rejected');
      expect(configOf(prisma).sectionContent).toEqual({ s2: 'retained budget text' });
    });

    const malformedBodies: Array<[string, Array<{ id: string; text: string }>]> = [
      ['a missing section', [{ id: 's1', text: 'Ask body' }]],
      ['a reordered body', [{ id: 's2', text: 'Budget body' }, { id: 's1', text: 'Ask body' }]],
      ['an unknown section id', [{ id: 's1', text: 'Ask body' }, { id: 's3', text: 'Extra body' }]],
      ['blank body text', [{ id: 's1', text: '   ' }, { id: 's2', text: 'Budget body' }]],
    ];

    it.each(malformedBodies)(
      'refuses a native body that does not key the approved outline exactly: %s',
      async (_label, sections) => {
        setupApprovedDraft(prisma);
        const turn = makeTurn({
          status: 'complete',
          runId: 'run-2',
          result: { document: { sections } },
        } as unknown as NativeGenerationTurnOutcome);
        const svc = makeService(prisma, { turn });

        await expect(
          svc.generate('tenant-1', 'draft-1', 'user-1', 1, 'standard', true, CREDENTIAL),
        ).rejects.toThrow(ConflictException);

        expect(prisma._proposals.size).toBe(0);
        const state = readAgentState(configOf(prisma));
        expect(state.pendingProposalId).toBeUndefined();
        expect(state.status).not.toBe('generating');
        expect(state.generation.lastRun).toBeUndefined();
      },
    );

    it('refuses to admit a body when the existing proposal owner is not composed', async () => {
      setupApprovedDraft(prisma);
      const svc = makeService(prisma, { turn: makeTurn(), revisions: null });

      await expect(
        svc.generate('tenant-1', 'draft-1', 'user-1', 1, 'standard', true, CREDENTIAL),
      ).rejects.toThrow(ServiceUnavailableException);

      expect(prisma._proposals.size).toBe(0);
      expect(configOf(prisma)).not.toHaveProperty('sectionContent');
    });

    it('lands the accepted content in the same compare-and-set that clears the pending proposal', async () => {
      setupApprovedDraft(prisma, { sectionContent: { s2: 'retained budget text' } });
      const svc = makeService(prisma, { turn: makeTurn() });
      const { proposalId, revision } = await admitBody(svc);
      const writesBefore = draftWrites(prisma).mock.calls.length;

      await svc.acceptProposal('tenant-1', 'draft-1', proposalId, 'user-1', revision);

      // ONE optimistic write carries the accepted state AND the content: no
      // second compare-and-set against a config the first write already changed.
      expect(draftWrites(prisma).mock.calls.length - writesBefore).toBe(1);
      expect(configOf(prisma).sectionContent).toEqual({ s1: 'Ask body', s2: 'Budget body' });
      expect(readAgentState(configOf(prisma)).pendingProposalId).toBeUndefined();
      expect(proposalOf(prisma, proposalId).status).toBe('accepted');
    });

    it('a failed compare-and-set leaves the proposal pending and the content unchanged', async () => {
      setupApprovedDraft(prisma, { sectionContent: { s2: 'retained budget text' } });
      const svc = makeService(prisma, { turn: makeTurn() });
      const { proposalId, revision } = await admitBody(svc);
      // The config changed underneath the accept, so its optimistic compare fails.
      draftWrites(prisma).mockResolvedValueOnce({ count: 0 });

      const failure = await svc
        .acceptProposal('tenant-1', 'draft-1', proposalId, 'user-1', revision)
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(ConflictException);
      expect((failure as ConflictException).getResponse()).toMatchObject({
        message: REVISION_CONFLICT_CODE,
      });
      // Accepted-proposal-without-content must be unreachable.
      expect(proposalOf(prisma, proposalId).status).toBe('pending');
      expect(readAgentState(configOf(prisma)).pendingProposalId).toBe(proposalId);
      expect(readAgentState(configOf(prisma)).revision).toBe(revision);
      expect(configOf(prisma).sectionContent).toEqual({ s2: 'retained budget text' });
    });
  });
});
