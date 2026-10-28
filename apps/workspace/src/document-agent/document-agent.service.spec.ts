// Document Agent Service spec — tests the service with a mocked Prisma,
// mocked CollaboratorsService, mocked reasoning gateway, and mocked
// GenerationService. Tests never call a live model provider.

import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { DocumentAgentService, REVISION_CONFLICT_CODE } from './document-agent.service.js';
import {
  computeContentHash,
  createInitialAgentState,
  readAgentState,
  type DocumentAgentOutlineSection,
  type DocumentAgentRunSummary,
  type DocumentAgentState,
} from './document-agent-state.js';
import { DocumentAgentRevisionService } from './document-agent-revision.service.js';
import type {
  NativeGenerationTurnOutcome,
  NativeGenerationTurnPort,
} from './native-generation.bridge.js';
import {
  NativeGenerationRefusal,
  nativeGenerationTurnRequest,
} from './native-generation.bridge.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { CollaboratorsService } from '../collaborators/collaborators.service.js';
// The REAL ordinary drafts owner, so a witness that needs an ordinary content save
// runs the shipped merge/CAS path instead of a hand-written store mutation.
import { DraftsService } from '../drafts/drafts.service.js';
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
    // The scoped system reader the ordinary save uses for shared identity tables.
    withSystem: jest.fn(async (run: (client: unknown) => Promise<unknown>) => run(prisma)),
    $executeRaw: jest.fn(async () => 0),
    // The identity/membership read the ordinary save performs before it writes.
    $queryRaw: jest.fn(async () => [{ id: 'db-user-1' }]),
    wsDraft: {
      findFirst: jest.fn(async ({ where }: { where: { id: string; tenantId: string } }) => {
        const d = drafts.get(where.id);
        if (!d) return null;
        if (d.tenantId !== where.tenantId) return null;
        return { ...d, config: d.config ?? {} };
      }),
      findFirstOrThrow: jest.fn(async ({ where }: { where: { id: string; tenantId: string } }) => {
        const d = drafts.get(where.id);
        if (!d || d.tenantId !== where.tenantId) throw new Error('Draft not found');
        return { ...d, config: d.config ?? {} };
      }),
      // The ordinary save's own write: it merges the row, it is NOT the agent CAS.
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const existing = drafts.get(where.id);
        if (!existing) throw new Error('Draft not found');
        const next = { ...existing, ...data };
        drafts.set(where.id, next);
        return next;
      }),
      updateMany: jest.fn(async ({ where, data }: { where: { id: string; config?: { equals: unknown } }; data: Record<string, unknown> }) => {
        const existing = drafts.get(where.id);
        if (!existing || (where.config && JSON.stringify(existing.config ?? {}) !== JSON.stringify(where.config.equals))) return { count: 0 };
        drafts.set(where.id, { ...existing, ...data });
        return { count: 1 };
      }),
    },
    // Interactive transaction, as the neighbouring workspace suites fake it: the
    // callback receives the same client. There is no rollback in an in-memory fake,
    // so a witness on atomicity has to observe the GUARD (a compare-and-set that
    // fails before the insert), which is exactly what the durable code relies on.
    $transaction: jest.fn(async (run: (client: unknown) => Promise<unknown>) => run(prisma)),
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

function makeTurn(
  outcome: NativeGenerationTurnOutcome = DOCUMENT_BODY,
  /**
   * What the SAME owner answers when the request is READ back. `null` is the owner's
   * explicit answer that it holds no run for that exact request (a read is what a
   * duplicate click or a reload performs; it never issues a turn by itself).
   */
  readOutcome: NativeGenerationTurnOutcome | null = null,
  /**
   * Runs INSIDE the read, before the owner answers: a case lands a competing write
   * (a replacement, a cancel, a second concurrent check) while the canonical read is
   * genuinely in flight.
   */
  beforeRead?: () => Promise<void>,
) {
  let next = outcome;
  const requests: Array<Record<string, unknown>> = [];
  const options: unknown[] = [];
  const turn = jest.fn(async (request: Record<string, unknown>, callOptions: unknown) => {
    requests.push(request);
    options.push(callOptions);
    return next;
  });
  const readRequests: Array<Record<string, unknown>> = [];
  const readTurn = jest.fn(async (request: Record<string, unknown>) => {
    readRequests.push(request);
    if (beforeRead !== undefined) await beforeRead();
    return readOutcome;
  });
  const cancel = jest.fn(async () => undefined);
  return {
    requests,
    readRequests,
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
    /**
     * The current-authority owner as a case needs it. A case that changes the actor's
     * grant WHILE a read is in flight supplies a mutable one, so the change is a real
     * current-authority change rather than a fixture the assertion assumes.
     */
    collaborators?: CollaboratorsService;
  } = {},
): DocumentAgentService {
  const revisions =
    options.revisions === null
      ? undefined
      : options.revisions ?? new DocumentAgentRevisionService(prisma as unknown as PrismaService);
  return new DocumentAgentService(
    prisma,
    options.collaborators ?? makeMockCollaborators(options.role),
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
    documents: [],
    updatedAt: new Date(),
  });
  return state;
}

const CREDENTIAL = 'session-credential';

/**
 * The current-access CHECK action's call shape: the status read, made under the
 * caller's own credential.
 *
 * The cast is on the CALL SHAPE only, so the IDENTICAL witness can also be executed
 * against the frozen parent revision, whose status read takes no options: there the
 * argument is ignored and the run comes back unreconciled — which is precisely the
 * old behaviour the negative control has to observe. No assertion is relaxed.
 */
async function checkGeneration(
  service: DocumentAgentService,
  options: { credential?: string } = { credential: CREDENTIAL },
): Promise<{ run: DocumentAgentRunSummary | null }> {
  const read = service.getGenerationStatus as unknown as (
    tenantId: string,
    draftId: string,
    actorId: string,
    call?: { credential?: string },
  ) => Promise<{ run: DocumentAgentRunSummary | null }>;
  return read.call(service, 'tenant-1', 'draft-1', 'user-1', options);
}

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

  // The failed units of a terminal NATIVE run are retried through the SAME retained
  // native owner every other document turn uses, and the result lands as an EXISTING
  // pending `content_revision` carrying ONLY those units — so the units that already
  // succeeded keep their accepted bytes through the retry AND through the accept.
  describe('native failed-unit retry through the existing owners', () => {
    const RETRY_INTENT = 'retry-failed-units';
    /** The closed key set the native owner's turn reader accepts, nothing more. */
    const CLOSED_TURN_KEYS = [
      'actorId',
      'clientId',
      'draftId',
      'expectedRevision',
      'paidGeneration',
      'phase',
      'requestId',
      'sources',
      'tenantId',
    ];

    /**
     * The retained request identity of the run this draft stores, DERIVED by the real
     * builder from the state's own implied source set (the draft plus the approved
     * outline's sections; this fixture pins no blueprint, document type or context
     * item). A test never hand-writes an identity it is checking.
     */
    function retainedRequestIdFor(state: DocumentAgentState): string {
      return nativeGenerationTurnRequest({
        phase: 'document',
        tenantId: 'tenant-1',
        actorId: 'user-1',
        draftId: 'draft-1',
        clientId: null,
        expectedRevision: state.generation.lastRun?.expectedRevision ?? 1,
        sources: [
          { id: 'draft-1', kind: 'workspace-draft' },
          ...state.outline.sections.map((section) => ({
            id: section.id,
            kind: 'outline-section' as const,
          })),
        ],
      }).requestId;
    }

    /**
     * Seed the terminal native run this draft retains, with unit s2 recorded as
     * SUCCEEDED by the run's own per-unit facts — nothing is inferred from the
     * draft's accepted content, which may be older text from an earlier run.
     */
    function seedRun(
      overrides: Partial<NonNullable<DocumentAgentState['generation']['lastRun']>> = {},
    ): DocumentAgentState {
      const state = readAgentState(configOf(prisma));
      state.generation.lastRun = {
        runId: 'run-1',
        requestId: '',
        mode: 'standard',
        startedAt: '2026-10-28T00:00:00.000Z',
        status: 'partial',
        stages: [],
        expectedRevision: 1,
        sectionResults: { s2: { status: 'succeeded' } },
        ...overrides,
      };
      state.generation.lastRun.requestId =
        overrides.requestId ?? retainedRequestIdFor(state);
      prisma._drafts.set('draft-1', {
        ...prisma._drafts.get('draft-1')!,
        config: { ...configOf(prisma), documentAgent: state },
      });
      return readAgentState(configOf(prisma));
    }

    /** A body that keys ONLY the retried (failed) unit. */
    const retriedBody = (text = 'Ask body v2') =>
      ({
        status: 'complete',
        runId: 'run-retry-9',
        result: { document: { sections: [{ id: 's1', text }] } },
      }) as unknown as NativeGenerationTurnOutcome;

    it('retries only the failed unit and preserves the accepted unit through the accept', async () => {
      setupApprovedDraft(prisma, { sectionContent: { s2: 'retained budget text' } });
      const seeded = seedRun();
      const turn = makeTurn(retriedBody());
      const svc = makeService(prisma, { turn });

      const result = await svc.retryGeneration('tenant-1', 'draft-1', 'user-1', 1, undefined, {
        intent: RETRY_INTENT,
        credential: CREDENTIAL,
      });

      // Exactly ONE native turn, scoped to the FAILED unit only.
      expect(turn.turn).toHaveBeenCalledTimes(1);
      const request = turn.requests[0]!;
      expect(request.sources).toEqual([
        { id: 'draft-1', kind: 'workspace-draft' },
        { id: 's1', kind: 'outline-section' },
      ]);
      expect(request.paidGeneration).toBe(true);
      expect(turn.options[0] as Record<string, unknown>).toMatchObject({ credential: CREDENTIAL });
      // A GENUINE retry: its identity differs from the run's original retained request,
      // and the server-owned discriminator never becomes a field of the posted request
      // (the owner's turn reader accepts this closed key set and rejects anything else).
      expect(request.requestId).not.toBe(seeded.generation.lastRun?.requestId);
      expect(Object.keys(request).sort()).toEqual(CLOSED_TURN_KEYS);

      // The attempt is pinned under ITS identity, and the run's own retained request
      // identity is left intact so the run stays addressable.
      const afterAttempt = readAgentState(configOf(prisma));
      expect(afterAttempt.generation.lastRun?.requestId).toBe(seeded.generation.lastRun?.requestId);
      expect(afterAttempt.generation.lastRun?.retry).toMatchObject({
        requestId: request.requestId,
        sectionIds: ['s1'],
        generation: 1,
        outcome: 'completed',
      });

      // The body lands as a PENDING content_revision carrying ONLY the retried unit,
      // based on the hash of the content the accept path re-checks.
      const proposalId = result.state.pendingProposalId!;
      expect(proposalId).toBeDefined();
      const proposal = proposalOf(prisma, proposalId);
      expect(proposal.type).toBe('content_revision');
      expect(proposal.status).toBe('pending');
      expect(proposal.baseHash).toBe(computeContentHash({ s2: 'retained budget text' }));
      expect(proposal.payload).toMatchObject({ revisedContent: { s1: 'Ask body v2' } });
      // Nothing lands in the draft's content field before an explicit accept.
      expect(configOf(prisma).sectionContent).toEqual({ s2: 'retained budget text' });

      // An explicit accept by a reviewer merges the retried unit over the preserved one.
      const reviewer = makeService(prisma, { turn, role: 'reviewer' });
      const accepted = await reviewer.acceptProposal(
        'tenant-1',
        'draft-1',
        proposalId,
        'user-1',
        result.state.revision,
      );
      expect(accepted.state.pendingProposalId).toBeUndefined();
      expect(configOf(prisma).sectionContent).toEqual({
        s1: 'Ask body v2',
        s2: 'retained budget text',
      });
      expect(proposalOf(prisma, proposalId).status).toBe('accepted');
    });

    it('refuses a stale revision before either dispatcher', async () => {
      setupApprovedDraft(prisma, { sectionContent: { s2: 'retained budget text' } });
      seedRun();
      const turn = makeTurn(retriedBody());
      const svc = makeService(prisma, { turn });

      await expect(
        svc.retryGeneration('tenant-1', 'draft-1', 'user-1', 99, undefined, {
          intent: RETRY_INTENT,
          credential: CREDENTIAL,
        }),
      ).rejects.toThrow(ConflictException);

      expect(turn.turn).not.toHaveBeenCalled();
      expect(prisma._proposals.size).toBe(0);
      expect(configOf(prisma).sectionContent).toEqual({ s2: 'retained budget text' });
    });

    it('refuses a run whose pinned sources changed before either dispatcher', async () => {
      setupApprovedDraft(prisma, { sectionContent: { s2: 'retained budget text' } });
      seedRun();
      // The pinned outline gains a unit AFTER the run was admitted: the run's retained
      // identity no longer re-derives, so its request cannot be continued.
      const current = readAgentState(configOf(prisma));
      current.outline.sections = [
        ...current.outline.sections,
        { ...OUTLINE_SECTIONS[1]!, id: 's3', title: 'Cost' },
      ];
      prisma._drafts.set('draft-1', {
        ...prisma._drafts.get('draft-1')!,
        config: { ...configOf(prisma), documentAgent: current },
      });
      const turn = makeTurn(retriedBody());
      const svc = makeService(prisma, { turn });

      await expect(
        svc.retryGeneration('tenant-1', 'draft-1', 'user-1', 1, undefined, {
          intent: RETRY_INTENT,
          credential: CREDENTIAL,
        }),
      ).rejects.toThrow(ConflictException);

      expect(turn.turn).not.toHaveBeenCalled();
      expect(prisma._proposals.size).toBe(0);
    });

    it('requires the explicit paid acknowledgement before starting a new native attempt', async () => {
      setupApprovedDraft(prisma, { sectionContent: { s2: 'retained budget text' } });
      seedRun();
      const turn = makeTurn(retriedBody());
      const svc = makeService(prisma, { turn });

      await expect(
        svc.retryGeneration('tenant-1', 'draft-1', 'user-1', 1, undefined, {
          credential: CREDENTIAL,
        }),
      ).rejects.toThrow(BadRequestException);

      expect(turn.turn).not.toHaveBeenCalled();
      expect(prisma._proposals.size).toBe(0);
    });

    it('re-reads the SAME attempt when the owner answers UNKNOWN, never a second request', async () => {
      setupApprovedDraft(prisma, { sectionContent: { s2: 'retained budget text' } });
      seedRun();
      const turn = makeTurn({ status: 'unknown' } as unknown as NativeGenerationTurnOutcome);
      const svc = makeService(prisma, { turn });

      const first = await svc.retryGeneration('tenant-1', 'draft-1', 'user-1', 1, undefined, {
        intent: RETRY_INTENT,
        credential: CREDENTIAL,
      });
      const pinned = readAgentState(configOf(prisma)).generation.lastRun?.retry;
      expect(pinned).toMatchObject({ sectionIds: ['s1'], generation: 1, outcome: 'unknown' });
      expect(turn.turn).toHaveBeenCalledTimes(1);

      // A repeated click (and a reload) addresses the SAME pinned request: it is READ
      // back, never turned again, so an uncertain attempt cannot become new paid work.
      const second = await svc.retryGeneration('tenant-1', 'draft-1', 'user-1', first.state.revision, undefined, {
        intent: RETRY_INTENT,
        credential: CREDENTIAL,
      });
      expect(turn.turn).toHaveBeenCalledTimes(1);
      expect(turn.readTurn).toHaveBeenCalledTimes(1);
      const read = (turn.readTurn as unknown as jest.Mock).mock.calls[0]![0] as Record<string, unknown>;
      expect(read.requestId).toBe(pinned?.requestId);
      expect(Object.keys(read).sort()).toEqual(CLOSED_TURN_KEYS);
      expect(prisma._proposals.size).toBe(0);
      expect(second.state.pendingProposalId).toBeUndefined();
      expect(readAgentState(configOf(prisma)).generation.lastRun?.retry).toEqual(pinned);
    });

    it('a definitively failed attempt is kept as custody and the next retry is a new generation', async () => {
      setupApprovedDraft(prisma, { sectionContent: { s2: 'retained budget text' } });
      seedRun();
      const turn = makeTurn();
      turn.turn.mockRejectedValueOnce(
        new NativeGenerationRefusal('run-failed', 'the native run ended without this phase output'),
      );
      const svc = makeService(prisma, { turn });

      await expect(
        svc.retryGeneration('tenant-1', 'draft-1', 'user-1', 1, undefined, {
          intent: RETRY_INTENT,
          credential: CREDENTIAL,
        }),
      ).rejects.toThrow(ConflictException);
      // The failure is recorded on the run, not lost: the attempt keeps its identity
      // (which was pinned before the turn) and is explicitly failed.
      const failed = readAgentState(configOf(prisma));
      expect(failed.generation.lastRun?.retry).toMatchObject({
        sectionIds: ['s1'],
        generation: 1,
        outcome: 'failed',
      });
      const firstAttempt = failed.generation.lastRun?.retry?.requestId;
      expect(typeof firstAttempt).toBe('string');
      expect(failed.generation.lastRun?.status).toBe('failed');

      // The next explicit retry is a genuinely NEW, separately pinned attempt, and the
      // failed one is preserved in custody instead of being replayed forever.
      turn.setOutcome({ status: 'unknown' } as unknown as NativeGenerationTurnOutcome);
      const second = await svc.retryGeneration(
        'tenant-1',
        'draft-1',
        'user-1',
        failed.revision,
        undefined,
        { intent: RETRY_INTENT, credential: CREDENTIAL },
      );
      expect(turn.turn).toHaveBeenCalledTimes(2);
      // The recorded request is the SECOND attempt: the first one was refused by the
      // owner itself and never returned a body.
      const secondAttempt = turn.requests[0]!;
      expect(secondAttempt.requestId).not.toBe(firstAttempt);
      expect(Object.keys(secondAttempt).sort()).toEqual(CLOSED_TURN_KEYS);
      const next = readAgentState(configOf(prisma));
      // The failed attempt is preserved EXACTLY, in order, as custody.
      expect(next.generation.lastRun?.retryCustody).toEqual([
        { requestId: firstAttempt, sectionIds: ['s1'] },
      ]);
      expect(next.generation.lastRun?.retry).toMatchObject({
        requestId: secondAttempt.requestId,
        generation: 2,
        outcome: 'unknown',
      });
      expect(second.state.pendingProposalId).toBeUndefined();
    });

    it('never regenerates a unit THIS RUN recorded as succeeded', async () => {
      setupApprovedDraft(prisma, { sectionContent: { s1: 'accepted ask', s2: 'accepted budget' } });
      seedRun({ sectionResults: { s1: { status: 'succeeded' }, s2: { status: 'succeeded' } } });
      const turn = makeTurn(retriedBody());
      const svc = makeService(prisma, { turn });

      await expect(
        svc.retryGeneration('tenant-1', 'draft-1', 'user-1', 1, undefined, {
          intent: RETRY_INTENT,
          credential: CREDENTIAL,
        }),
      ).rejects.toThrow(ConflictException);

      expect(turn.turn).not.toHaveBeenCalled();
      expect(prisma._proposals.size).toBe(0);

      // Accepted content is NOT a success fact: the same draft with no per-unit
      // success recorded still retries that unit, because older accepted text says
      // nothing about whether the current attempt produced it.
      seedRun({ sectionResults: { s2: { status: 'succeeded' } } });
      const retryTurn = makeTurn(retriedBody());
      const retrySvc = makeService(prisma, { turn: retryTurn });
      await retrySvc.retryGeneration('tenant-1', 'draft-1', 'user-1', 1, undefined, {
        intent: RETRY_INTENT,
        credential: CREDENTIAL,
      });
      expect(retryTurn.turn).toHaveBeenCalledTimes(1);
      expect(retryTurn.requests[0]!.sources).toEqual([
        { id: 'draft-1', kind: 'workspace-draft' },
        { id: 's1', kind: 'outline-section' },
      ]);
    });

    it('a legacy engine run keeps the existing retry path', async () => {
      setupDraft(prisma);
      const gen = makeMockGeneration();
      (gen.retryFailedSections as jest.Mock).mockResolvedValue({
        generationRun: {
          status: 'partial',
          completedAt: '2026-10-28T00:00:00.000Z',
          sectionResults: [{ section: 'Overview', status: 'failed', message: 'boom' }],
        },
      } as never);
      const turn = makeTurn();
      const svc = makeService(prisma, { turn, generation: gen });

      const result = await svc.retryGeneration('tenant-1', 'draft-1', 'user-1', 1);

      expect(gen.retryFailedSections).toHaveBeenCalledWith('tenant-1', 'draft-1', 'user-1');
      expect(turn.turn).not.toHaveBeenCalled();
      expect(result.state.generation.lastRun?.status).toBe('partial');
    });

    it('makes a REAL first native failure retryable: generate() retains the failed run, then the retry lands a pending proposal', async () => {
      setupApprovedDraft(prisma);
      // The owner answers the FIRST document turn with a definitive failure.
      const failing = makeTurn({
        status: 'failed',
        runId: 'run-native-failed',
        state: 'failed',
      } as unknown as NativeGenerationTurnOutcome);
      const svc = makeService(prisma, { turn: failing });

      await expect(
        svc.generate('tenant-1', 'draft-1', 'user-1', 1, 'standard', true, CREDENTIAL),
      ).rejects.toThrow(ConflictException);

      // The run's OWN request identity is retained even though the attempt failed —
      // before this it was written only on a success or an approval, so a real first
      // failure could never become retryable.
      const retained = readAgentState(configOf(prisma)).generation.lastRun;
      expect(retained?.requestId).toMatch(/^wsgen:[a-f0-9]{64}$/u);
      expect(retained?.status).toBe('failed');
      expect(retained?.expectedRevision).toBe(1);
      expect(failing.turn).toHaveBeenCalledTimes(1);

      // With no per-unit success fact, every pinned unit is outstanding.
      const both = makeTurn({
        status: 'complete',
        runId: 'run-native-retry',
        result: {
          document: {
            sections: [
              { id: 's1', text: 'Ask body v2' },
              { id: 's2', text: 'Budget body v2' },
            ],
          },
        },
      } as unknown as NativeGenerationTurnOutcome);
      const retrySvc = makeService(prisma, { turn: both });
      // The retention moved the draft's revision, so the retry pins the CURRENT one.
      const retryRevision = readAgentState(configOf(prisma)).revision;
      const retried = await retrySvc.retryGeneration(
        'tenant-1', 'draft-1', 'user-1', retryRevision, undefined,
        { intent: RETRY_INTENT, credential: CREDENTIAL },
      );

      expect(both.turn).toHaveBeenCalledTimes(1);
      const proposalId = retried.state.pendingProposalId!;
      expect(proposalId).toBeDefined();
      expect(proposalOf(prisma, proposalId).status).toBe('pending');
      expect(configOf(prisma)).not.toHaveProperty('sectionContent');
      // Only a reviewer's explicit accept lands the retried body.
      const accepted = await retrySvc.acceptProposal(
        'tenant-1', 'draft-1', proposalId, 'user-1', retried.state.revision,
      );
      expect(configOf(prisma).sectionContent).toEqual({
        s1: 'Ask body v2',
        s2: 'Budget body v2',
      });
      expect(accepted.state.pendingProposalId).toBeUndefined();

      // A replayed COMPLETED receipt cannot mint a second proposal for the same
      // attempt: every retried unit is recorded as succeeded by the completed attempt,
      // so it is no longer a failed unit, and the run is refused before any new paid
      // identity is derived. No second turn, exactly one proposal.
      await expect(
        retrySvc.retryGeneration(
          'tenant-1', 'draft-1', 'user-1', readAgentState(configOf(prisma)).revision, undefined,
          { intent: RETRY_INTENT, credential: CREDENTIAL },
        ),
      ).rejects.toThrow(ConflictException);
      expect(both.turn).toHaveBeenCalledTimes(1);
      expect(prisma._proposals.size).toBe(1);
      expect(configOf(prisma).sectionContent).toEqual({
        s1: 'Ask body v2',
        s2: 'Budget body v2',
      });
    });

    it('reconciles the initial UNKNOWN through the current-access status read, then retries the units it actually failed', async () => {
      setupApprovedDraft(prisma);

      // 1. The first document turn answers UNKNOWN. The run's OWN request identity is
      //    durable state now, so it is addressable for reconcile instead of being lost.
      const unknown = makeTurn({
        status: 'unknown',
        requestId: `wsgen:${'cd'.repeat(32)}`,
      } as unknown as NativeGenerationTurnOutcome);
      const svc = makeService(prisma, { turn: unknown });

      const admitted = await svc.generate(
        'tenant-1', 'draft-1', 'user-1', 1, 'standard', true, CREDENTIAL,
      );

      expect(admitted.status).toBe('unknown');
      const retained = readAgentState(configOf(prisma)).generation.lastRun!;
      expect(retained.requestId).toBe(admitted.requestId);
      expect(retained.expectedRevision).toBe(1);
      expect(retained.status).toBe('active');
      expect(unknown.turn).toHaveBeenCalledTimes(1);

      // 2. The caller's CHECK action — the existing current-access status read — reads
      //    that EXACT retained request back. While the owner still answers UNKNOWN the
      //    identity stays exactly as retained and NOTHING is written.
      const stillUnknown = makeTurn(DOCUMENT_BODY, {
        status: 'unknown',
        requestId: retained.requestId,
      } as unknown as NativeGenerationTurnOutcome);
      const checkSvc = makeService(prisma, { turn: stillUnknown });
      const revisionBefore = readAgentState(configOf(prisma)).revision;

      const unchanged = await checkGeneration(checkSvc);

      expect(stillUnknown.turn).toHaveBeenCalledTimes(0);
      expect(stillUnknown.readTurn).toHaveBeenCalledTimes(1);
      // The read is bound to the ORIGINAL request identity, revision pin and sources.
      expect(stillUnknown.readRequests[0]?.requestId).toBe(retained.requestId);
      expect(stillUnknown.readRequests[0]?.expectedRevision).toBe(1);
      expect(stillUnknown.readRequests[0]?.sources).toEqual([
        { id: 'draft-1', kind: 'workspace-draft' },
        { id: 's1', kind: 'outline-section' },
        { id: 's2', kind: 'outline-section' },
      ]);
      expect(unchanged.run?.requestId).toBe(retained.requestId);
      expect(unchanged.run?.status).toBe('active');
      expect(readAgentState(configOf(prisma)).revision).toBe(revisionBefore);

      // 3. A later check: the owner now publishes a DEFINITIVE failure of that same
      //    request, so the stored run becomes truthfully retryable.
      const failedRead = makeTurn(DOCUMENT_BODY, {
        status: 'failed',
        runId: 'run-native-failed',
        state: 'failed',
      } as unknown as NativeGenerationTurnOutcome);
      const failedSvc = makeService(prisma, { turn: failedRead });

      const reconciled = await checkGeneration(failedSvc);

      // Never a second paid turn: only a read of the same request.
      expect(failedRead.turn).toHaveBeenCalledTimes(0);
      expect(failedRead.readTurn).toHaveBeenCalledTimes(1);
      expect(failedRead.readRequests[0]?.requestId).toBe(retained.requestId);
      expect(reconciled.run?.status).toBe('failed');
      expect(reconciled.run?.requestId).toBe(retained.requestId);
      expect(readAgentState(configOf(prisma)).generation.lastRun?.status).toBe('failed');

      // 4. A reload of the same check reads the settled run as it stands: the truthful
      //    status and the SAME identity survive, with no further owner call.
      const reloadCheck = makeTurn(DOCUMENT_BODY, {
        status: 'unknown',
        requestId: retained.requestId,
      } as unknown as NativeGenerationTurnOutcome);
      const reloadSvc = makeService(prisma, { turn: reloadCheck });

      const reloaded = await checkGeneration(reloadSvc);

      expect(reloadCheck.turn).toHaveBeenCalledTimes(0);
      expect(reloadCheck.readTurn).toHaveBeenCalledTimes(0);
      expect(reloaded.run?.requestId).toBe(retained.requestId);
      expect(reloaded.run?.status).toBe('failed');

      // 5. ONLY now is the explicit failed-unit retry reachable: exactly ONE new paid
      //    attempt and exactly ONE pending proposal, and nothing lands in the draft
      //    until a reviewer accepts it.
      const both = makeTurn({
        status: 'complete',
        runId: 'run-native-retry',
        result: {
          document: {
            sections: [
              { id: 's1', text: 'Ask body v2' },
              { id: 's2', text: 'Budget body v2' },
            ],
          },
        },
      } as unknown as NativeGenerationTurnOutcome);
      const retrySvc = makeService(prisma, { turn: both });
      const retryRevision = readAgentState(configOf(prisma)).revision;

      const retried = await retrySvc.retryGeneration(
        'tenant-1', 'draft-1', 'user-1', retryRevision, undefined,
        { intent: RETRY_INTENT, credential: CREDENTIAL },
      );

      expect(both.turn).toHaveBeenCalledTimes(1);
      expect(prisma._proposals.size).toBe(1);
      const proposalId = retried.state.pendingProposalId!;
      expect(proposalOf(prisma, proposalId).status).toBe('pending');
      expect(configOf(prisma)).not.toHaveProperty('sectionContent');

      const accepted = await retrySvc.acceptProposal(
        'tenant-1', 'draft-1', proposalId, 'user-1', retried.state.revision,
      );
      expect(configOf(prisma).sectionContent).toEqual({
        s1: 'Ask body v2',
        s2: 'Budget body v2',
      });
      expect(accepted.state.pendingProposalId).toBeUndefined();
    });

    it('lands the body the owner publishes for a retained UNKNOWN request as a pending proposal, never a second turn', async () => {
      setupApprovedDraft(prisma);
      const unknown = makeTurn({
        status: 'unknown',
        requestId: `wsgen:${'ef'.repeat(32)}`,
      } as unknown as NativeGenerationTurnOutcome);
      const svc = makeService(prisma, { turn: unknown });
      await svc.generate('tenant-1', 'draft-1', 'user-1', 1, 'standard', true, CREDENTIAL);
      const retained = readAgentState(configOf(prisma)).generation.lastRun!;

      // The owner has since ANSWERED that exact request with a body: the check reads it
      // back and admits it through the existing pending-proposal owner.
      const answered = makeTurn(DOCUMENT_BODY, DOCUMENT_BODY);
      const checkSvc = makeService(prisma, { turn: answered });
      const revision = readAgentState(configOf(prisma)).revision;

      const status = await checkGeneration(checkSvc);

      // The run was read back, never turned again, and its identity is unchanged.
      expect(answered.turn).toHaveBeenCalledTimes(0);
      expect(answered.readTurn).toHaveBeenCalledTimes(1);
      expect(answered.readRequests[0]?.requestId).toBe(retained.requestId);
      expect(status.run?.requestId).toBe(retained.requestId);
      expect(status.run?.status).toBe('active');

      // Exactly one pending proposal; the accepted bytes do not move until it is
      // reviewed, and re-reading the settled run creates nothing further.
      expect(prisma._proposals.size).toBe(1);
      const proposalId = readAgentState(configOf(prisma)).pendingProposalId!;
      expect(proposalOf(prisma, proposalId).status).toBe('pending');
      expect(configOf(prisma)).not.toHaveProperty('sectionContent');

      const repeat = makeService(prisma, { turn: makeTurn(DOCUMENT_BODY, DOCUMENT_BODY) });
      await checkGeneration(repeat);
      expect(prisma._proposals.size).toBe(1);

      const accepted = await repeat.acceptProposal(
        'tenant-1', 'draft-1', proposalId, 'user-1', readAgentState(configOf(prisma)).revision,
      );
      expect(configOf(prisma).sectionContent).toEqual({ s1: 'Ask body', s2: 'Budget body' });
      expect(accepted.state.pendingProposalId).toBeUndefined();
      expect(readAgentState(configOf(prisma)).revision).toBeGreaterThan(revision);
    });

    it('refuses the body when an ordinary content save replaced the read’s ORIGINAL content basis', async () => {
      setupApprovedDraft(prisma, { sectionContent: { s1: 'original ask' } });
      const unknown = makeTurn({
        status: 'unknown',
        requestId: `wsgen:${'12'.repeat(32)}`,
      } as unknown as NativeGenerationTurnOutcome);
      const svc = makeService(prisma, { turn: unknown });
      await svc.generate('tenant-1', 'draft-1', 'user-1', 1, 'standard', true, CREDENTIAL);
      const retained = readAgentState(configOf(prisma)).generation.lastRun!;
      const revision = readAgentState(configOf(prisma)).revision;

      // The teammate's ORDINARY content save lands WHILE the canonical read is in
      // flight, through the REAL drafts owner: it merges the permitted `config` field
      // and refuses to move `documentAgent`, so the agent revision does NOT change and
      // the retained run stays active under the same request.
      const drafts = new DraftsService(
        prisma as unknown as PrismaService,
        makeMockCollaborators(),
      );
      let saved: unknown;
      const answered = makeTurn(DOCUMENT_BODY, DOCUMENT_BODY, async () => {
        if (saved !== undefined) return;
        saved = await drafts.update('tenant-1', 'draft-1', 'user-1', {
          config: { sectionContent: { s1: 'newer manual ask' } },
        });
      });
      const checkSvc = makeService(prisma, { turn: answered });

      const status = await checkGeneration(checkSvc);

      // The save really landed, and it moved only the accepted CONTENT: the answer was
      // read for the older basis while the draft now carries the newer one.
      expect(saved).toBeDefined();
      expect(configOf(prisma).sectionContent).toEqual({ s1: 'newer manual ask' });
      const after = readAgentState(configOf(prisma));
      expect(after.revision).toBe(revision);
      expect(after.generation.lastRun?.requestId).toBe(retained.requestId);
      expect(after.generation.lastRun?.status).toBe('active');

      // ...and that answer created NOTHING against the newer accepted bytes: no
      // actionable pending row, no pointer to one, and the newer content is preserved
      // exactly as the teammate saved it.
      expect(prisma._proposals.size).toBe(0);
      expect(after.pendingProposalId).toBeUndefined();
      expect(configOf(prisma).sectionContent).toEqual({ s1: 'newer manual ask' });
      expect(answered.turn).toHaveBeenCalledTimes(0);
      expect(answered.readTurn).toHaveBeenCalledTimes(1);
      expect(status.run?.requestId).toBe(retained.requestId);
      expect(status.run?.status).toBe('active');
    });

    it('refuses the body when current edit access was removed while the canonical read was in flight', async () => {
      setupApprovedDraft(prisma, { sectionContent: { s2: 'retained budget text' } });
      const unknown = makeTurn({
        status: 'unknown',
        requestId: `wsgen:${'34'.repeat(32)}`,
      } as unknown as NativeGenerationTurnOutcome);
      const svc = makeService(prisma, { turn: unknown });
      await svc.generate('tenant-1', 'draft-1', 'user-1', 1, 'standard', true, CREDENTIAL);
      const retained = readAgentState(configOf(prisma)).generation.lastRun!;
      const revision = readAgentState(configOf(prisma)).revision;

      // The actor's CURRENT grant is changed through the existing collaborator owner
      // while the read is in flight: a downgrade is independent of the draft's config
      // and revision, so nothing else moves. The actor keeps read access, so the read
      // still starts; only `canEdit` is gone.
      let currentRole: 'owner' | 'viewer' = 'owner';
      const collaborators = {
        resolveRole: jest.fn(async () => currentRole),
        assertCan: jest.fn(
          async (
            _tenantId: string,
            _draftId: string,
            _actorId: string,
            predicate: (resolved: 'owner' | 'viewer') => boolean,
          ) => {
            if (!predicate(currentRole)) {
              throw new ForbiddenException('You do not have permission to access this document');
            }
            return currentRole;
          },
        ),
      } as unknown as CollaboratorsService;
      const answered = makeTurn(DOCUMENT_BODY, DOCUMENT_BODY, async () => {
        currentRole = 'viewer';
      });
      const checkSvc = makeService(prisma, { turn: answered, collaborators });

      const outcome = await checkGeneration(checkSvc).then(
        (answer) => answer,
        (error: unknown) => error,
      );

      // The grant really changed mid-read, and the CURRENT-authority owner was
      // consulted again for it after the native owner answered.
      expect(currentRole).toBe('viewer');
      expect((collaborators.assertCan as jest.Mock).mock.calls.length).toBeGreaterThan(1);

      // No durable effect was admitted for a read that started under the older grant:
      // zero actionable rows, no pointer, unchanged state and content.
      expect(prisma._proposals.size).toBe(0);
      const after = readAgentState(configOf(prisma));
      expect(after.pendingProposalId).toBeUndefined();
      expect(after.revision).toBe(revision);
      expect(after.generation.lastRun?.requestId).toBe(retained.requestId);
      expect(after.generation.lastRun?.status).toBe('active');
      expect(configOf(prisma).sectionContent).toEqual({ s2: 'retained budget text' });
      expect(answered.turn).toHaveBeenCalledTimes(0);
      expect(answered.readTurn).toHaveBeenCalledTimes(1);
      // The caller keeps the state it already had instead of being handed an effect it
      // may not hold: the check still answers with the run this draft retains.
      expect(outcome).toMatchObject({
        run: { requestId: retained.requestId, status: 'active' },
      });
    });

    it('never admits a late body for a run that was REPLACED while its canonical read was in flight', async () => {
      setupApprovedDraft(prisma);
      const unknown = makeTurn({
        status: 'unknown',
        requestId: `wsgen:${'aa'.repeat(32)}`,
      } as unknown as NativeGenerationTurnOutcome);
      const svc = makeService(prisma, { turn: unknown });
      await svc.generate('tenant-1', 'draft-1', 'user-1', 1, 'standard', true, CREDENTIAL);
      const runA = readAgentState(configOf(prisma)).generation.lastRun!;

      // WHILE run A's canonical read is in flight, a legitimate competing admission
      // replaces the retained run with B through the real owner.
      let replaced: string | undefined;
      const lateRead = makeTurn(DOCUMENT_BODY, DOCUMENT_BODY, async () => {
        if (replaced !== undefined) return;
        const revision = readAgentState(configOf(prisma)).revision;
        const b = makeService(prisma, {
          turn: makeTurn({
            status: 'unknown',
            requestId: `wsgen:${'bb'.repeat(32)}`,
          } as unknown as NativeGenerationTurnOutcome),
        });
        const admitted = await b.generate(
          'tenant-1', 'draft-1', 'user-1', revision, 'standard', true, CREDENTIAL,
        );
        replaced = admitted.requestId;
      });
      const lateSvc = makeService(prisma, { turn: lateRead });

      const answer = await checkGeneration(lateSvc);

      // The replacement really happened, and A's late body was NOT admitted: no new
      // actionable proposal row exists for a run that is no longer the current one,
      // and B's identity/status are untouched.
      expect(replaced).toEqual(expect.any(String));
      expect(replaced).not.toBe(runA.requestId);
      expect(lateRead.readTurn).toHaveBeenCalledTimes(1);
      expect(lateRead.turn).toHaveBeenCalledTimes(0);
      expect(prisma._proposals.size).toBe(0);
      expect(answer.run?.requestId).toBe(runA.requestId);
      expect(readAgentState(configOf(prisma)).generation.lastRun?.requestId).toBe(replaced);
      expect(readAgentState(configOf(prisma)).pendingProposalId).toBeUndefined();
      expect(configOf(prisma)).not.toHaveProperty('sectionContent');
    });

    it('never admits a late body for a run that was CANCELLED while its canonical read was in flight', async () => {
      setupApprovedDraft(prisma);
      const unknown = makeTurn({
        status: 'unknown',
        requestId: `wsgen:${'cc'.repeat(32)}`,
      } as unknown as NativeGenerationTurnOutcome);
      const svc = makeService(prisma, { turn: unknown });
      await svc.generate('tenant-1', 'draft-1', 'user-1', 1, 'standard', true, CREDENTIAL);
      const runA = readAgentState(configOf(prisma)).generation.lastRun!;

      // WHILE run A's canonical read is in flight, that same run is legitimately
      // cancelled through the real owner (status becomes truthfully non-open).
      let cancelled = false;
      const lateRead = makeTurn(DOCUMENT_BODY, DOCUMENT_BODY, async () => {
        if (cancelled) return;
        const revision = readAgentState(configOf(prisma)).revision;
        await svc.cancelGeneration('tenant-1', 'draft-1', 'user-1', revision, CREDENTIAL);
        cancelled = true;
      });
      const lateSvc = makeService(prisma, { turn: lateRead });

      const answer = await checkGeneration(lateSvc);

      // Nothing was admitted for the cancelled run, and the cancel's own outcome was
      // not resurrected into a fresh 'generating' run with a pending proposal.
      expect(cancelled).toBe(true);
      expect(lateRead.readTurn).toHaveBeenCalledTimes(1);
      expect(prisma._proposals.size).toBe(0);
      expect(readAgentState(configOf(prisma)).pendingProposalId).toBeUndefined();
      expect(readAgentState(configOf(prisma)).generation.lastRun).toMatchObject({
        requestId: runA.requestId,
        status: 'partial',
      });
      expect(readAgentState(configOf(prisma)).status).toBe('partial');
      expect(answer.run?.requestId).toBe(runA.requestId);
      expect(configOf(prisma)).not.toHaveProperty('sectionContent');
    });

    it('admits a body read by TWO concurrent checks of the same run exactly once', async () => {
      setupApprovedDraft(prisma);
      const unknown = makeTurn({
        status: 'unknown',
        requestId: `wsgen:${'dd'.repeat(32)}`,
      } as unknown as NativeGenerationTurnOutcome);
      const svc = makeService(prisma, { turn: unknown });
      await svc.generate('tenant-1', 'draft-1', 'user-1', 1, 'standard', true, CREDENTIAL);

      // Both checks get their canonical answer before either has landed anything: the
      // real duplicate-click interleaving.
      let arrived = 0;
      let release: () => void = () => undefined;
      const bothInFlight = new Promise<void>((resolve) => {
        release = () => resolve();
      });
      const beforeRead = async () => {
        arrived += 1;
        if (arrived === 2) release();
        await bothInFlight;
      };
      const first = makeService(prisma, {
        turn: makeTurn(DOCUMENT_BODY, DOCUMENT_BODY, beforeRead),
      });
      const second = makeService(prisma, {
        turn: makeTurn(DOCUMENT_BODY, DOCUMENT_BODY, beforeRead),
      });

      await Promise.all([checkGeneration(first), checkGeneration(second)]);

      // Exactly ONE pending actionable proposal exists, and it is the one the state
      // points at. The loser left nothing listable or acceptable behind.
      expect(arrived).toBe(2);
      expect(prisma._proposals.size).toBe(1);
      const rows = Array.from(prisma._proposals.entries());
      expect(rows).toHaveLength(1);
      const state = readAgentState(configOf(prisma));
      expect(state.pendingProposalId).toBe(rows[0]![0]);
      expect(rows[0]![1].status).toBe('pending');
      expect(configOf(prisma)).not.toHaveProperty('sectionContent');

      // The single admitted proposal is the one a reviewer can accept.
      const accepted = await first.acceptProposal(
        'tenant-1', 'draft-1', state.pendingProposalId!, 'user-1', state.revision,
      );
      expect(configOf(prisma).sectionContent).toEqual({ s1: 'Ask body', s2: 'Budget body' });
      expect(accepted.state.pendingProposalId).toBeUndefined();
    });

    it('leaves a retained run alone when its pins moved, the caller cannot edit, or no credential is presented', async () => {
      setupApprovedDraft(prisma);
      // A run pinned under a DIFFERENT revision: its own retained identity can no longer
      // be re-derived from the pins the current state carries.
      seedRun({ expectedRevision: 0, requestId: 'wsgen:' + 'ab'.repeat(32), status: 'active' });

      const ownRequest = readAgentState(configOf(prisma)).generation.lastRun!.requestId;
      const revision = readAgentState(configOf(prisma)).revision;

      // (a) A run whose pinned sources/revision moved: nothing is dispatched.
      const movedTurn = makeTurn(DOCUMENT_BODY, {
        status: 'failed',
        runId: 'run-native-failed',
        state: 'failed',
      } as unknown as NativeGenerationTurnOutcome);
      const movedSvc = makeService(prisma, { turn: movedTurn });
      const moved = await checkGeneration(movedSvc);

      expect(movedTurn.turn).toHaveBeenCalledTimes(0);
      expect(movedTurn.readTurn).toHaveBeenCalledTimes(0);
      expect(moved.run?.requestId).toBe(ownRequest);
      expect(moved.run?.status).toBe('active');

      // (b) A caller who cannot edit generation: the run is read as it stands, and the
      //     owner is not consulted on their behalf.
      const viewerTurn = makeTurn(DOCUMENT_BODY, {
        status: 'failed',
        runId: 'run-native-failed',
        state: 'failed',
      } as unknown as NativeGenerationTurnOutcome);
      const viewerSvc = makeService(prisma, { turn: viewerTurn, role: 'viewer' });
      const viewed = await checkGeneration(viewerSvc);

      expect(viewerTurn.turn).toHaveBeenCalledTimes(0);
      expect(viewerTurn.readTurn).toHaveBeenCalledTimes(0);
      expect(viewed.run?.requestId).toBe(ownRequest);

      // (c) No current credential: the same, with the run and its revision untouched.
      const anonymousTurn = makeTurn(DOCUMENT_BODY, {
        status: 'failed',
        runId: 'run-native-failed',
        state: 'failed',
      } as unknown as NativeGenerationTurnOutcome);
      const anonymousSvc = makeService(prisma, { turn: anonymousTurn });
      const anonymous = await checkGeneration(anonymousSvc, {});

      expect(anonymousTurn.turn).toHaveBeenCalledTimes(0);
      expect(anonymousTurn.readTurn).toHaveBeenCalledTimes(0);
      expect(anonymous.run?.requestId).toBe(ownRequest);
      expect(readAgentState(configOf(prisma)).revision).toBe(revision);
    });

    it('binds a new native run’s OWN facts to its own request, never the earlier run’s successes or completed attempt', async () => {
      setupApprovedDraft(prisma, { sectionContent: { s2: 'retained budget text' } });
      // The draft retains an EARLIER native run: it recorded s2 as succeeded and its
      // failed-unit attempt completed — all of it under ITS OWN request identity, pinned
      // at the revision it was admitted under (the draft has moved since).
      const priorRequestId = nativeGenerationTurnRequest({
        phase: 'document',
        tenantId: 'tenant-1',
        actorId: 'user-1',
        draftId: 'draft-1',
        clientId: null,
        expectedRevision: 0,
        sources: [
          { id: 'draft-1', kind: 'workspace-draft' },
          { id: 's1', kind: 'outline-section' },
          { id: 's2', kind: 'outline-section' },
        ],
      }).requestId;
      const seeded = readAgentState(configOf(prisma));
      seeded.generation.lastRun = {
        runId: 'run-prior',
        requestId: priorRequestId,
        mode: 'standard',
        startedAt: '2026-10-27T00:00:00.000Z',
        status: 'partial',
        stages: [],
        expectedRevision: 0,
        sectionResults: { s2: { status: 'succeeded' } },
        retry: {
          requestId: priorRequestId,
          sectionIds: ['s2'],
          generation: 1,
          expectedRevision: 0,
          outcome: 'completed',
        },
        retryCustody: [{ requestId: priorRequestId, sectionIds: ['s2'] }],
      };
      prisma._drafts.set('draft-1', {
        ...prisma._drafts.get('draft-1')!,
        config: { ...configOf(prisma), documentAgent: seeded },
      });

      // A DISTINCT current run is admitted and DEFINITIVELY fails.
      const failing = makeTurn({
        status: 'failed',
        runId: 'run-new-failed',
        state: 'failed',
      } as unknown as NativeGenerationTurnOutcome);
      const failingSvc = makeService(prisma, { turn: failing });

      await expect(
        failingSvc.generate('tenant-1', 'draft-1', 'user-1', 1, 'standard', true, CREDENTIAL),
      ).rejects.toThrow(ConflictException);

      const retained = readAgentState(configOf(prisma)).generation.lastRun!;
      // Its OWN identity and its OWN truthful run facts: nothing of the earlier run is
      // inherited, so the earlier run's successes cannot be claimed by this failure.
      expect(retained.requestId).not.toBe(priorRequestId);
      expect(retained.runId).toBe(retained.requestId);
      expect(retained.startedAt).not.toBe('2026-10-27T00:00:00.000Z');
      expect(retained.status).toBe('failed');
      expect(retained.retry).toBeUndefined();
      expect(retained.retryCustody).toBeUndefined();
      expect(retained.sectionResults).toBeUndefined();
      expect(failing.turn).toHaveBeenCalledTimes(1);

      // Its failed-unit retry covers its ACTUAL outstanding units — both pinned units,
      // because THIS run recorded no success on either — while the earlier run's
      // accepted bytes stay exactly as they are until an explicit accept.
      const both = makeTurn({
        status: 'complete',
        runId: 'run-new-retry',
        result: {
          document: {
            sections: [
              { id: 's1', text: 'Ask body v2' },
              { id: 's2', text: 'Budget body v2' },
            ],
          },
        },
      } as unknown as NativeGenerationTurnOutcome);
      const retrySvc = makeService(prisma, { turn: both });
      const retryRevision = readAgentState(configOf(prisma)).revision;

      const retried = await retrySvc.retryGeneration(
        'tenant-1', 'draft-1', 'user-1', retryRevision, undefined,
        { intent: RETRY_INTENT, credential: CREDENTIAL },
      );

      expect(both.turn).toHaveBeenCalledTimes(1);
      // BOTH units are retried: the new run's own failure set, in the pinned order.
      expect(both.requests[0]?.sources).toEqual([
        { id: 'draft-1', kind: 'workspace-draft' },
        { id: 's1', kind: 'outline-section' },
        { id: 's2', kind: 'outline-section' },
      ]);
      expect(configOf(prisma).sectionContent).toEqual({ s2: 'retained budget text' });
      const proposalId = retried.state.pendingProposalId!;
      expect(proposalOf(prisma, proposalId).status).toBe('pending');

      await retrySvc.acceptProposal('tenant-1', 'draft-1', proposalId, 'user-1', retried.state.revision);
      expect(configOf(prisma).sectionContent).toEqual({
        s1: 'Ask body v2',
        s2: 'Budget body v2',
      });
    });

    it('keeps a run’s own facts when the SAME request is retained again', async () => {
      setupApprovedDraft(prisma);
      const seeded = seedRun({
        status: 'partial',
        sectionResults: { s2: { status: 'succeeded' } },
        retryCustody: [{ requestId: 'wsgen:' + 'ab'.repeat(32), sectionIds: ['s2'] }],
      });
      const ownRequestId = seeded.generation.lastRun!.requestId!;

      // The SAME request is admitted again and answers UNKNOWN: its own custody and
      // per-unit facts must survive (a legitimate existing custody is never discarded).
      const unknown = makeTurn({
        status: 'unknown',
        requestId: ownRequestId,
      } as unknown as NativeGenerationTurnOutcome);
      const svc = makeService(prisma, { turn: unknown });

      const admitted = await svc.generate(
        'tenant-1', 'draft-1', 'user-1', 1, 'standard', true, CREDENTIAL,
      );

      expect(admitted.status).toBe('unknown');
      const retained = readAgentState(configOf(prisma)).generation.lastRun!;
      expect(retained.requestId).toBe(ownRequestId);
      expect(retained.status).toBe('active');
      expect(retained.sectionResults).toEqual({ s2: { status: 'succeeded' } });
      expect(retained.retryCustody).toEqual([
        { requestId: 'wsgen:' + 'ab'.repeat(32), sectionIds: ['s2'] },
      ]);
    });

    it('refuses a changed subset while an attempt is unresolved, preserving its exact request and scope', async () => {
      setupApprovedDraft(prisma);
      seedRun({ sectionResults: {} });
      const unknown = makeTurn({
        status: 'unknown',
        requestId: `wsgen:${'ef'.repeat(32)}`,
      } as unknown as NativeGenerationTurnOutcome);
      const svc = makeService(prisma, { turn: unknown });

      await svc.retryGeneration('tenant-1', 'draft-1', 'user-1', 1, undefined, {
        intent: RETRY_INTENT,
        credential: CREDENTIAL,
      });
      const bound = readAgentState(configOf(prisma)).generation.lastRun!.retry!;
      expect(bound.sectionIds).toEqual(['s1', 's2']);
      expect(bound.outcome).toBe('unknown');

      // An interleaving result records s2 as SUCCEEDED, so a repeated call would
      // otherwise derive a NARROWER scope and look like a different attempt.
      const moved = readAgentState(configOf(prisma));
      moved.generation.lastRun = {
        ...moved.generation.lastRun!,
        sectionResults: { s2: { status: 'succeeded' } },
      };
      prisma._drafts.set('draft-1', {
        ...prisma._drafts.get('draft-1')!,
        config: { ...configOf(prisma), documentAgent: moved },
      });

      await expect(
        svc.retryGeneration('tenant-1', 'draft-1', 'user-1', 1, undefined, {
          intent: RETRY_INTENT,
          credential: CREDENTIAL,
        }),
      ).rejects.toThrow(ConflictException);

      // The unresolved attempt is untouched: same request, same scope, one turn.
      expect(readAgentState(configOf(prisma)).generation.lastRun!.retry).toEqual(bound);
      expect(unknown.turn).toHaveBeenCalledTimes(1);
      expect(prisma._proposals.size).toBe(0);
    });

    it('refuses the paid native retry before either dispatcher when the run has no retained native request', async () => {
      setupDraft(prisma);
      const turn = makeTurn();
      const gen = makeMockGeneration();
      const svc = makeService(prisma, { turn, generation: gen });

      await expect(
        svc.retryGeneration('tenant-1', 'draft-1', 'user-1', 1, undefined, {
          intent: RETRY_INTENT,
          credential: CREDENTIAL,
        }),
      ).rejects.toThrow(ConflictException);

      // The explicit intent is a native-only control: it never falls through to the
      // legacy engine, and nothing was dispatched.
      expect(turn.turn).not.toHaveBeenCalled();
      expect(gen.retryFailedSections).not.toHaveBeenCalled();
    });

    it('refuses the document retry for a role without canEdit before any request is built', async () => {
      setupApprovedDraft(prisma, { sectionContent: { s2: 'retained budget text' } });
      seedRun();
      const turn = makeTurn(retriedBody());
      const svc = makeService(prisma, { turn, role: 'viewer' });

      await expect(
        svc.retryGeneration('tenant-1', 'draft-1', 'user-1', 1, undefined, {
          intent: RETRY_INTENT,
          credential: CREDENTIAL,
        }),
      ).rejects.toThrow(ForbiddenException);
      expect(turn.turn).not.toHaveBeenCalled();
      expect(prisma._proposals.size).toBe(0);
    });
  });
});
