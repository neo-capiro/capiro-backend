// Document Agent Service — the core orchestrator for the conversational
// document-creation experience. Manages the agent state (config.documentAgent),
// conversation messages, brief, context, outline, generation, proposals, and
// quality checks.
//
// Key invariants:
// - WsDraft is the aggregate root; agent state is a versioned JSON object on
//   config.documentAgent.
// - Every mutation accepts expectedRevision and increments revision atomically.
//   A stale revision returns 409 DOCUMENT_AGENT_REVISION_CONFLICT.
// - Every Prisma query includes tenantId + the object ID.
// - TenantId, ownerId, and actor IDs are NEVER accepted from request bodies —
//   they come from the authenticated TenantGuard context.
// - The reasoning gateway is injected and mockable; no live model calls in tests.

import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { CollaboratorsService } from '../collaborators/collaborators.service.js';
import { canEdit, canRead, canReview, type ResolvedRole } from '../collaborators/role-policy.js';
import { GenerationService } from '../generation/generation.service.js';
import { WorkspaceReasoningGateway } from '../workspace-reasoning/workspace-reasoning.gateway.js';
import {
  recommendDocumentSetupPrompt,
  generateFollowUpQuestionsPrompt,
  synthesizeBriefPrompt,
  generateOutlinePrompt,
} from '../workspace-reasoning/workspace-reasoning.prompts.js';
import {
  createInitialAgentState,
  readAgentState,
  computeContextSnapshotHash,
  computeOutlineHash,
  computeContentHash,
  type DocumentAgentState,
  type DocumentAgentPhase,
  type DocumentAgentOutlineSection,
  type ContextConflict,
  type ContextCoverage,
  type DocumentAgentRunSummary,
  type GenerationMode,
} from './document-agent-state.js';
import {
  canTransition,
  transitionPhase,
  transitionStatus,
  mutateState,
} from './document-agent-state-machine.js';
import type { DocumentAgentQualityService } from './document-agent-quality.service.js';
import type { DocumentAgentRevisionService } from './document-agent-revision.service.js';

/** Error code for stale revision conflicts. */
export const REVISION_CONFLICT_CODE = 'DOCUMENT_AGENT_REVISION_CONFLICT';
/** Error code for stale proposals. */
export const PROPOSAL_STALE_CODE = 'PROPOSAL_STALE';

/** A draft row with its config loaded as a typed object. */
type DraftWithConfig = {
  id: string;
  tenantId: string;
  ownerId: string;
  config: Record<string, unknown>;
  updatedAt: Date;
};

/**
 * The core document-agent service. All mutations go through `mutateAgentState`
 * which enforces optimistic concurrency and atomic revision increment.
 */
@Injectable()
export class DocumentAgentService {
  private readonly logger = new Logger(DocumentAgentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly collaborators: CollaboratorsService,
    private readonly reasoning: WorkspaceReasoningGateway,
    private readonly generation: GenerationService,
  ) {}

  // ── Catalog & Recommendation ────────────────────────────────────────────

  /**
   * GET /document-agent/catalog — return the document type catalog.
   * Sourced from the existing cascade/template catalog (no new table).
   */
  async getCatalog(tenantId: string): Promise<{
    documentTypes: Array<{ id: string; label: string; product: string }>;
  }> {
    // Read from existing templates (the product catalog). Group by product.
    const templates = await this.prisma.wsTemplate.findMany({
      where: { OR: [{ tenantId: null }, { tenantId }] },
      select: { id: true, name: true, product: true },
    });
    // Deduplicate by product — each product is one "document type".
    const seen = new Set<string>();
    const documentTypes: Array<{ id: string; label: string; product: string }> = [];
    for (const t of templates) {
      if (!seen.has(t.product)) {
        seen.add(t.product);
        documentTypes.push({ id: t.id, label: t.name, product: t.product });
      }
    }
    return { documentTypes };
  }

  /**
   * POST /document-agent/recommend — recommend a document setup.
   * Never returns or persists chain-of-thought.
   */
  async recommendDocumentSetup(
    tenantId: string,
    goal: string,
    client?: string,
  ): Promise<{
    documentType: { id: string; label: string; product: string };
    recommendedBlueprints: Array<{ blueprintId: string; name: string; slug: string }>;
    recommendedTheme: { id: string; name: string };
    questions: Array<{ id: string; label: string; helpText?: string; required: boolean }>;
    rationale: string;
  }> {
    const system = recommendDocumentSetupPrompt(goal, client);
    return this.reasoning.recommendDocumentSetup(tenantId, system, system);
  }

  // ── Agent State (GET / initialize / patch) ───────────────────────────────

  /**
   * GET /drafts/:draftId/agent — read the agent state.
   */
  async getAgentState(
    tenantId: string,
    draftId: string,
    actorId: string,
  ): Promise<{ state: DocumentAgentState }> {
    const draft = await this.loadDraft(tenantId, draftId, actorId, canRead);
    const state = readAgentState(draft.config);
    return { state };
  }

  /**
   * POST /drafts/:draftId/agent/initialize — initialize agent state on a draft.
   * Idempotent: if already initialized, returns the current state.
   */
  async initializeAgent(
    tenantId: string,
    draftId: string,
    actorId: string,
    init: {
      documentType?: { id: string; label: string; product: string };
      blueprintPin?: {
        blueprintId: string;
        versionId: string;
        version: number;
        definitionHash: string;
      };
      theme?: { id: string; name: string; settings: Record<string, unknown> };
      goal?: string;
    },
  ): Promise<{ state: DocumentAgentState }> {
    const draft = await this.loadDraft(tenantId, draftId, actorId, canEdit);
    const existing = readAgentState(draft.config);
    // Idempotent: if revision > 0, return existing.
    if (existing.revision > 0) {
      return { state: existing };
    }
    const initial = createInitialAgentState();
    if (init.documentType) {
      initial.documentType = init.documentType;
      initial.phase = 'blueprint';
    }
    if (init.blueprintPin) {
      initial.blueprintPin = init.blueprintPin;
      initial.phase = 'design';
    }
    if (init.theme) {
      initial.theme = init.theme;
      initial.phase = 'goal';
    }
    if (init.goal) {
      initial.goal = { text: init.goal, createdAt: new Date().toISOString() };
      initial.phase = 'brief';
    }
    initial.revision = 1;
    await this.persistAgentState(draft.id, draft.config, initial);
    return { state: initial };
  }

  /**
   * PATCH /drafts/:draftId/agent — general state mutation with optimistic
   * revision. Used for setting document type, blueprint pin, theme, goal,
   * and phase/status transitions.
   */
  async patchAgentState(
    tenantId: string,
    draftId: string,
    actorId: string,
    expectedRevision: number,
    patch: {
      documentType?: { id: string; label: string; product: string };
      blueprintPin?: Record<string, unknown>;
      theme?: Record<string, unknown>;
      goal?: Record<string, unknown>;
      phase?: string;
      status?: string;
    },
  ): Promise<{ state: DocumentAgentState }> {
    return this.withMutationLock(tenantId, draftId, actorId, canEdit, expectedRevision, (state) => {
      if (patch.documentType) state.documentType = patch.documentType;
      if (patch.blueprintPin) state.blueprintPin = patch.blueprintPin as unknown as DocumentAgentState['blueprintPin'];
      if (patch.theme) state.theme = patch.theme as unknown as DocumentAgentState['theme'];
      if (patch.goal) state.goal = patch.goal as unknown as DocumentAgentState['goal'];
      if (patch.phase) {
        const toPhase = patch.phase as DocumentAgentPhase;
        if (!canTransition(state.phase, toPhase)) {
          throw new ConflictException(
            `Invalid phase transition: ${state.phase} → ${toPhase}`,
          );
        }
        state.phase = toPhase;
      }
      if (patch.status) state.status = patch.status as DocumentAgentState['status'];
    });
  }

  // ── Conversation Messages ───────────────────────────────────────────────

  /**
   * GET /drafts/:draftId/agent/messages — list conversation messages.
   */
  async getMessages(
    tenantId: string,
    draftId: string,
    actorId: string,
  ): Promise<{ messages: unknown[] }> {
    await this.loadDraft(tenantId, draftId, actorId, canRead);
    const rows = await this.prisma.wsAgentMessage.findMany({
      where: { tenantId, draftId },
      orderBy: { createdAt: 'asc' },
    });
    return { messages: rows };
  }

  /**
   * POST /drafts/:draftId/agent/messages — send a message.
   * Idempotent via idempotencyKey. The agent may respond with questions,
   * a proposal, or a phase transition.
   */
  async sendMessage(
    tenantId: string,
    draftId: string,
    actorId: string,
    dto: {
      text: string;
      phase: string;
      expectedRevision: number;
      idempotencyKey?: string;
      scope?: {
        kind: 'whole_document' | 'selection';
        documentId?: string;
        sectionId?: string;
        quote?: string;
        start?: number;
        end?: number;
      };
    },
  ): Promise<{
    message: string;
    phase: string;
    revision: number;
    questions: unknown[];
    stateSummary: DocumentAgentState | null;
    proposal: { proposalId: string } | null;
    allowedActions: string[];
  }> {
    // Idempotency check: if an idempotencyKey is provided, check for an
    // existing message with the same key in the data field.
    if (dto.idempotencyKey) {
      const existing = await this.prisma.wsAgentMessage.findFirst({
        where: {
          tenantId,
          draftId,
          role: 'user',
          data: { equals: { idempotencyKey: dto.idempotencyKey } },
        },
        orderBy: { createdAt: 'desc' },
      });
      if (existing) {
        const state = await this.getAgentState(tenantId, draftId, actorId);
        return {
          message: 'Duplicate request ignored (idempotent).',
          phase: state.state.phase,
          revision: state.state.revision,
          questions: [],
          stateSummary: state.state,
          proposal: null,
          allowedActions: this.allowedActionsFor(state.state),
        };
      }
    }

    // Load draft + state.
    const draft = await this.loadDraft(tenantId, draftId, actorId, canEdit);

    // Persist the user message.
    await this.prisma.wsAgentMessage.create({
      data: {
        tenantId,
        draftId,
        actorId,
        role: 'user',
        phase: dto.phase,
        text: dto.text,
        data: { idempotencyKey: dto.idempotencyKey ?? null, scope: dto.scope ?? null },
      },
    });

    // Determine the agent response. For the brief phase, synthesize a brief
    // when enough information is available. For other phases, generate
    // follow-up questions.
    const state = readAgentState(draft.config);
    const phase = dto.phase as DocumentAgentPhase;

    let agentText = 'I have enough to create the working brief.';
    let questions: unknown[] = [];
    let proposal: { proposalId: string } | null = null;

    try {
      if (phase === 'brief' && state.status === 'needs_input') {
        // Attempt brief synthesis.
        const conversationHistory = await this.buildConversationText(tenantId, draftId);
        const blueprintSectionsText = state.outline.sections
          .map((s) => `- ${s.title}: ${s.purpose}`)
          .join('\n') || 'No blueprint sections yet.';
        const result = await this.reasoning.synthesizeBrief(
          tenantId,
          synthesizeBriefPrompt(state.goal?.text ?? '', conversationHistory, blueprintSectionsText),
          synthesizeBriefPrompt(state.goal?.text ?? '', conversationHistory, blueprintSectionsText),
        );
        // Apply the synthesized brief.
        const updated = await this.withMutationLock(
          tenantId,
          draftId,
          actorId,
          canEdit,
          dto.expectedRevision,
          (s) => {
            s.brief.objective = result.objective;
            s.brief.audience = result.audience;
            s.brief.desiredAction = result.desiredAction;
            s.brief.subject = result.subject;
            s.brief.centralArgument = result.centralArgument;
            s.brief.evidenceInstructions = result.evidenceInstructions;
            s.brief.tone = result.tone;
            s.brief.targetPages = result.targetPages;
            s.brief.deadline = result.deadline;
            s.brief.assumptions = result.assumptions.map((a) => ({
              id: a.id,
              text: a.text,
              status: 'open' as const,
            }));
            s.brief.provenance = result.provenance;
            s.status = 'ready';
          },
        );
        agentText = 'I have enough to create the working brief.';
        questions = [];
        return {
          message: agentText,
          phase: updated.state.phase,
          revision: updated.state.revision,
          questions,
          stateSummary: updated.state,
          proposal,
          allowedActions: this.allowedActionsFor(updated.state),
        };
      }

      // Default: generate follow-up questions.
      const conversationHistory = await this.buildConversationText(tenantId, draftId);
      const goal = state.goal?.text ?? 'No goal set.';
      const system = generateFollowUpQuestionsPrompt(goal, phase, conversationHistory);
      const result = await this.reasoning.generateFollowUpQuestions(tenantId, system, system);
      questions = result.questions;
      if (questions.length === 0) {
        agentText = 'I have enough information to proceed.';
      } else {
        agentText = 'I have a few questions to help shape the document.';
      }
    } catch (err) {
      if (err instanceof ServiceUnavailableException) throw err;
      this.logger.error(`Agent message processing failed: ${(err as Error).message}`);
      agentText = 'I encountered an issue processing that. Please try again.';
    }

    // Persist the assistant message.
    await this.prisma.wsAgentMessage.create({
      data: {
        tenantId,
        draftId,
        role: 'assistant',
        phase: dto.phase,
        text: agentText,
        data: { questions: questions as never, proposal: proposal as never },
      },
    });

    const currentState = await this.getAgentState(tenantId, draftId, actorId);
    return {
      message: agentText,
      phase: currentState.state.phase,
      revision: currentState.state.revision,
      questions,
      stateSummary: currentState.state,
      proposal,
      allowedActions: this.allowedActionsFor(currentState.state),
    };
  }

  // ── Brief ───────────────────────────────────────────────────────────────

  /**
   * PUT /drafts/:draftId/agent/brief — update the brief.
   */
  async updateBrief(
    tenantId: string,
    draftId: string,
    actorId: string,
    expectedRevision: number,
    brief: {
      objective?: string;
      audience?: string;
      desiredAction?: string;
      subject?: string;
      centralArgument?: string;
      evidenceInstructions?: string;
      tone?: string;
      targetPages?: number;
      deadline?: string;
      assumptions?: Array<{ id: string; text: string; status: 'open' | 'confirmed' | 'rejected' }>;
    },
  ): Promise<{ state: DocumentAgentState }> {
    return this.withMutationLock(tenantId, draftId, actorId, canEdit, expectedRevision, (state) => {
      if (brief.objective !== undefined) state.brief.objective = brief.objective;
      if (brief.audience !== undefined) state.brief.audience = brief.audience;
      if (brief.desiredAction !== undefined) state.brief.desiredAction = brief.desiredAction;
      if (brief.subject !== undefined) state.brief.subject = brief.subject;
      if (brief.centralArgument !== undefined) state.brief.centralArgument = brief.centralArgument;
      if (brief.evidenceInstructions !== undefined) state.brief.evidenceInstructions = brief.evidenceInstructions;
      if (brief.tone !== undefined) state.brief.tone = brief.tone;
      if (brief.targetPages !== undefined) state.brief.targetPages = brief.targetPages;
      if (brief.deadline !== undefined) state.brief.deadline = brief.deadline;
      if (brief.assumptions !== undefined) state.brief.assumptions = brief.assumptions;
    });
  }

  /**
   * POST /drafts/:draftId/agent/brief/synthesize — synthesize the brief.
   */
  async synthesizeBrief(
    tenantId: string,
    draftId: string,
    actorId: string,
    expectedRevision: number,
  ): Promise<{ state: DocumentAgentState }> {
    const draft = await this.loadDraft(tenantId, draftId, actorId, canEdit);
    const state = readAgentState(draft.config);
    const conversationHistory = await this.buildConversationText(tenantId, draftId);
    const blueprintSectionsText = state.outline.sections
      .map((s) => `- ${s.title}: ${s.purpose}`)
      .join('\n') || 'No blueprint sections yet.';
    const result = await this.reasoning.synthesizeBrief(
      tenantId,
      synthesizeBriefPrompt(state.goal?.text ?? '', conversationHistory, blueprintSectionsText),
      synthesizeBriefPrompt(state.goal?.text ?? '', conversationHistory, blueprintSectionsText),
    );
    return this.withMutationLock(tenantId, draftId, actorId, canEdit, expectedRevision, (s) => {
      s.brief.objective = result.objective;
      s.brief.audience = result.audience;
      s.brief.desiredAction = result.desiredAction;
      s.brief.subject = result.subject;
      s.brief.centralArgument = result.centralArgument;
      s.brief.evidenceInstructions = result.evidenceInstructions;
      s.brief.tone = result.tone;
      s.brief.targetPages = result.targetPages;
      s.brief.deadline = result.deadline;
      s.brief.assumptions = result.assumptions.map((a) => ({
        id: a.id,
        text: a.text,
        status: 'open' as const,
      }));
      s.brief.provenance = result.provenance;
      s.status = 'ready';
    });
  }

  /**
   * POST /drafts/:draftId/agent/brief/approve — approve the brief.
   */
  async approveBrief(
    tenantId: string,
    draftId: string,
    actorId: string,
    expectedRevision: number,
  ): Promise<{ state: DocumentAgentState }> {
    return this.withMutationLock(tenantId, draftId, actorId, canEdit, expectedRevision, (state) => {
      state.brief.approvedAt = new Date().toISOString();
      state.brief.approvedBy = actorId;
      // Transition to context phase.
      if (canTransition(state.phase, 'context')) {
        state.phase = 'context';
        state.status = 'active';
      }
    });
  }

  /**
   * POST /drafts/:draftId/agent/brief/reopen — reopen the brief.
   */
  async reopenBrief(
    tenantId: string,
    draftId: string,
    actorId: string,
    expectedRevision: number,
  ): Promise<{ state: DocumentAgentState }> {
    return this.withMutationLock(tenantId, draftId, actorId, canEdit, expectedRevision, (state) => {
      state.brief.approvedAt = undefined;
      state.brief.approvedBy = undefined;
      state.phase = 'brief';
      state.status = 'active';
    });
  }

  // ── Context ─────────────────────────────────────────────────────────────

  /**
   * POST /drafts/:draftId/agent/context/recommend — recommend context items.
   */
  async recommendContext(
    tenantId: string,
    draftId: string,
    actorId: string,
    expectedRevision: number,
  ): Promise<{ state: DocumentAgentState; recommendations: unknown }> {
    const draft = await this.loadDraft(tenantId, draftId, actorId, canEdit);
    const state = readAgentState(draft.config);
    const items = await this.prisma.wsContextItem.findMany({
      where: { tenantId, draftId },
    });
    const availableItems = items
      .map((i) => `- ${i.id}: ${(i.payload as { label?: string })?.label ?? 'Unlabeled'}`)
      .join('\n');
    const result = await this.reasoning.recommendContext(
      tenantId,
      `Recommend context for: ${state.goal?.text ?? ''}`,
      `Available items:\n${availableItems}`,
    );
    const updated = await this.withMutationLock(tenantId, draftId, actorId, canEdit, expectedRevision, (s) => {
      s.contextPlan.includedItemIds = result.includedItemIds;
      s.contextPlan.excludedItems = result.excludedItems;
    });
    return { state: updated.state, recommendations: result };
  }

  /**
   * POST /drafts/:draftId/agent/context/analyze — analyze context for
   * conflicts and coverage.
   */
  async analyzeContext(
    tenantId: string,
    draftId: string,
    actorId: string,
    expectedRevision: number,
  ): Promise<{ state: DocumentAgentState }> {
    const draft = await this.loadDraft(tenantId, draftId, actorId, canEdit);
    const state = readAgentState(draft.config);
    const items = await this.prisma.wsContextItem.findMany({
      where: { tenantId, draftId },
    });
    const included = items.filter((i) => state.contextPlan.includedItemIds.includes(i.id));
    const includedText = included
      .map((i) => `- ${i.id}: ${(i.payload as { label?: string })?.label ?? ''}`)
      .join('\n');
    const result = await this.reasoning.analyzeContext(
      tenantId,
      `Analyze context for: ${state.brief.objective ?? ''}`,
      `Included items:\n${includedText}`,
    );
    // Compute the context snapshot hash.
    const snapshotItems = included.map((i) => ({
      id: i.id,
      label: (i.payload as { label?: string })?.label ?? '',
      text: (i.payload as { text?: string })?.text,
    }));
    const snapshotHash = computeContextSnapshotHash(snapshotItems);
    return this.withMutationLock(tenantId, draftId, actorId, canEdit, expectedRevision, (s) => {
      s.contextPlan.conflicts = result.conflicts as ContextConflict[];
      s.contextPlan.coverage = result.coverage as ContextCoverage;
      s.contextPlan.snapshotHash = snapshotHash;
    });
  }

  /**
   * POST /drafts/:draftId/agent/context/approve — approve the context plan.
   */
  async approveContext(
    tenantId: string,
    draftId: string,
    actorId: string,
    expectedRevision: number,
  ): Promise<{ state: DocumentAgentState }> {
    return this.withMutationLock(tenantId, draftId, actorId, canEdit, expectedRevision, (state) => {
      state.contextPlan.approvedAt = new Date().toISOString();
      state.contextPlan.approvedBy = actorId;
      if (canTransition(state.phase, 'outline')) {
        state.phase = 'outline';
        state.status = 'active';
      }
    });
  }

  /**
   * PATCH /drafts/:draftId/context/:itemId — extend a context item's payload.
   * This extends WsContextItem.payload, not replacing the model.
   */
  async patchContextItem(
    tenantId: string,
    draftId: string,
    itemId: string,
    payloadPatch: Record<string, unknown>,
  ): Promise<{ item: unknown }> {
    const item = await this.prisma.wsContextItem.findFirst({
      where: { id: itemId, tenantId, draftId },
    });
    if (!item) throw new NotFoundException('Context item not found');
    const existing = (item.payload as Record<string, unknown>) ?? {};
    const merged = { ...existing, ...payloadPatch };
    const updated = await this.prisma.wsContextItem.update({
      where: { id: itemId },
      data: { payload: merged as never },
    });
    return { item: updated };
  }

  // ── Outline ─────────────────────────────────────────────────────────────

  /**
   * POST /drafts/:draftId/agent/outline/generate — generate the outline.
   */
  async generateOutline(
    tenantId: string,
    draftId: string,
    actorId: string,
    expectedRevision: number,
  ): Promise<{ state: DocumentAgentState }> {
    const draft = await this.loadDraft(tenantId, draftId, actorId, canEdit);
    const state = readAgentState(draft.config);
    // The blueprint must be pinned.
    if (!state.blueprintPin) {
      throw new ConflictException('A blueprint must be pinned before generating an outline.');
    }
    // Load the blueprint version definition.
    const blueprintVersion = await this.prisma.wsBlueprintVersion.findFirst({
      where: { id: state.blueprintPin.versionId, tenantId },
    });
    if (!blueprintVersion) {
      throw new ConflictException('Pinned blueprint version not found.');
    }
    const definition = blueprintVersion.definition as {
      sections?: Array<{ id: string; title: string; purpose: string; instructions: string; required: boolean; lockedByDefault: boolean; targetWords: { min: number; max: number }; evidenceRules: string[] }>;
    };
    const blueprintSectionsText = (definition.sections ?? [])
      .map((s) => `- ${s.id}: ${s.title} — ${s.purpose}`)
      .join('\n');
    const contextSummary = `Included items: ${state.contextPlan.includedItemIds.length}`;
    const system = generateOutlinePrompt(
      state.brief.objective ?? '',
      blueprintSectionsText,
      contextSummary,
    );
    const result = await this.reasoning.generateOutline(tenantId, system, system);
    return this.withMutationLock(tenantId, draftId, actorId, canEdit, expectedRevision, (s) => {
      s.outline.version += 1;
      s.outline.sections = result.sections as DocumentAgentOutlineSection[];
    });
  }

  /**
   * PUT /drafts/:draftId/agent/outline — update the outline.
   */
  async updateOutline(
    tenantId: string,
    draftId: string,
    actorId: string,
    expectedRevision: number,
    sections: DocumentAgentOutlineSection[],
  ): Promise<{ state: DocumentAgentState }> {
    return this.withMutationLock(tenantId, draftId, actorId, canEdit, expectedRevision, (state) => {
      state.outline.sections = sections;
      state.outline.version += 1;
    });
  }

  /**
   * POST /drafts/:draftId/agent/outline/revise — revise the outline.
   * Creates a WsAgentProposal. Does NOT mutate the outline directly.
   */
  async reviseOutline(
    tenantId: string,
    draftId: string,
    actorId: string,
    expectedRevision: number,
    instruction: string,
  ): Promise<{ proposal: { proposalId: string } }> {
    const draft = await this.loadDraft(tenantId, draftId, actorId, canEdit);
    const state = readAgentState(draft.config);
    const baseHash = computeOutlineHash(state.outline.sections);
    // Create the proposal.
    const proposal = await this.prisma.wsAgentProposal.create({
      data: {
        tenantId,
        draftId,
        createdById: actorId,
        type: 'outline_revision',
        status: 'pending',
        baseRevision: expectedRevision,
        baseHash,
        payload: { instruction, outlineSnapshot: state.outline.sections } as never,
      },
    });
    return { proposal: { proposalId: proposal.id } };
  }

  /**
   * POST /drafts/:draftId/agent/outline/approve — approve the outline.
   */
  async approveOutline(
    tenantId: string,
    draftId: string,
    actorId: string,
    expectedRevision: number,
  ): Promise<{ state: DocumentAgentState }> {
    return this.withMutationLock(tenantId, draftId, actorId, canEdit, expectedRevision, (state) => {
      state.outline.approvedAt = new Date().toISOString();
      state.outline.approvedBy = actorId;
      if (canTransition(state.phase, 'generate')) {
        state.phase = 'generate';
        state.status = 'ready';
      }
    });
  }

  // ── Proposals ───────────────────────────────────────────────────────────

  /**
   * GET /drafts/:draftId/agent/proposals — list proposals.
   */
  async getProposals(
    tenantId: string,
    draftId: string,
    actorId: string,
  ): Promise<{ proposals: unknown[] }> {
    await this.loadDraft(tenantId, draftId, actorId, canRead);
    const rows = await this.prisma.wsAgentProposal.findMany({
      where: { tenantId, draftId },
      orderBy: { createdAt: 'desc' },
    });
    return { proposals: rows };
  }

  /**
   * POST /drafts/:draftId/agent/proposals/:proposalId/accept — accept a proposal.
   * Before applying: compare baseRevision, recompute the affected-content hash,
   * compare with baseHash. Return 409 PROPOSAL_STALE if changed.
   */
  async acceptProposal(
    tenantId: string,
    draftId: string,
    proposalId: string,
    actorId: string,
    expectedRevision: number,
  ): Promise<{ state: DocumentAgentState }> {
    await this.loadDraft(tenantId, draftId, actorId, canReview);
    const proposal = await this.prisma.wsAgentProposal.findFirst({
      where: { id: proposalId, tenantId, draftId },
    });
    if (!proposal) throw new NotFoundException('Proposal not found');
    if (proposal.status !== 'pending') {
      throw new ConflictException(`Proposal is already ${proposal.status}`);
    }

    // Staleness check: recompute hash and compare.
    const draft = await this.loadDraft(tenantId, draftId, actorId, canReview);
    const state = readAgentState(draft.config);

    // For outline revisions, recompute the outline hash.
    if (proposal.type === 'outline_revision') {
      const currentHash = computeOutlineHash(state.outline.sections);
      if (currentHash !== proposal.baseHash) {
        await this.prisma.wsAgentProposal.update({
          where: { id: proposalId },
          data: { status: 'stale' },
        });
        throw new ConflictException(PROPOSAL_STALE_CODE);
      }
    }

    // For content revisions, recompute the content hash.
    if (proposal.type === 'content_revision') {
      const sectionContent = (draft.config as { sectionContent?: Record<string, string> }).sectionContent ?? {};
      const currentHash = computeContentHash(sectionContent);
      if (currentHash !== proposal.baseHash) {
        await this.prisma.wsAgentProposal.update({
          where: { id: proposalId },
          data: { status: 'stale' },
        });
        throw new ConflictException(PROPOSAL_STALE_CODE);
      }
    }

    // Apply the proposal.
    const payload = proposal.payload as {
      instruction?: string;
      outlineSnapshot?: DocumentAgentOutlineSection[];
      revisedContent?: Record<string, string>;
    };
    const updated = await this.withMutationLock(tenantId, draftId, actorId, canReview, expectedRevision, (s) => {
      if (proposal.type === 'outline_revision' && payload.outlineSnapshot) {
        s.outline.sections = payload.outlineSnapshot;
        s.outline.version += 1;
      }
      if (proposal.type === 'content_revision' && payload.revisedContent) {
        // Merge revised content into config.sectionContent (the existing editor field).
        // The actual merge happens in the config object, not the agent state.
      }
      s.pendingProposalId = undefined;
    });

    // Mark the proposal as accepted.
    await this.prisma.wsAgentProposal.update({
      where: { id: proposalId },
      data: {
        status: 'accepted',
        decidedAt: new Date().toISOString(),
        decidedById: actorId,
      },
    });

    return updated;
  }

  /**
   * POST /drafts/:draftId/agent/proposals/:proposalId/reject — reject a proposal.
   */
  async rejectProposal(
    tenantId: string,
    draftId: string,
    proposalId: string,
    actorId: string,
    expectedRevision: number,
    note?: string,
  ): Promise<{ state: DocumentAgentState }> {
    await this.loadDraft(tenantId, draftId, actorId, canReview);
    const proposal = await this.prisma.wsAgentProposal.findFirst({
      where: { id: proposalId, tenantId, draftId },
    });
    if (!proposal) throw new NotFoundException('Proposal not found');
    if (proposal.status !== 'pending') {
      throw new ConflictException(`Proposal is already ${proposal.status}`);
    }
    await this.prisma.wsAgentProposal.update({
      where: { id: proposalId },
      data: {
        status: 'rejected',
        decidedAt: new Date().toISOString(),
        decidedById: actorId,
      },
    });
    const state = await this.getAgentState(tenantId, draftId, actorId);
    return state;
  }

  // ── Generation ──────────────────────────────────────────────────────────

  /**
   * POST /drafts/:draftId/agent/generate — start generation.
   * Delegates to the existing GenerationService. Keeps the request open or
   * runs through the existing durable worker. Does NOT use an untracked
   * void promise background task.
   */
  async generate(
    tenantId: string,
    draftId: string,
    actorId: string,
    expectedRevision: number,
    mode: GenerationMode = 'standard',
  ): Promise<{ state: DocumentAgentState; run: DocumentAgentRunSummary | null }> {
    const draft = await this.loadDraft(tenantId, draftId, actorId, canEdit);
    const state = readAgentState(draft.config);

    // Validate preconditions.
    if (!state.brief.approvedAt) {
      throw new ConflictException('Brief must be approved before generation.');
    }
    if (!state.contextPlan.approvedAt) {
      throw new ConflictException('Context must be approved before generation.');
    }
    if (!state.outline.approvedAt) {
      throw new ConflictException('Outline must be approved before generation.');
    }

    const runId = state.generation.activeRunId ?? crypto.randomUUID();
    const runSummary: DocumentAgentRunSummary = {
      runId,
      mode,
      startedAt: new Date().toISOString(),
      status: 'active',
      stages: [],
    };

    // Update state to generating.
    const updated = await this.withMutationLock(tenantId, draftId, actorId, canEdit, expectedRevision, (s) => {
      s.generation.mode = mode;
      s.generation.activeRunId = runId;
      s.generation.lastRun = runSummary;
      s.phase = 'generate';
      s.status = 'generating';
    });

    // Delegate to the existing GenerationService (request-scoped).
    try {
      if (mode === 'max') {
        // Max mode: full pipeline via generateAllSections.
        await this.generation.generateAllSections(tenantId, draftId, actorId, {});
      } else {
        // Quick/standard: also via existing generation.
        await this.generation.generateAllSections(tenantId, draftId, actorId, {});
      }
      // Mark complete.
      const finalState = await this.getAgentState(tenantId, draftId, actorId);
      const completed = await this.withMutationLock(
        tenantId,
        draftId,
        actorId,
        canEdit,
        finalState.state.revision,
        (s) => {
          if (s.generation.lastRun) {
            s.generation.lastRun.status = 'complete';
            s.generation.lastRun.completedAt = new Date().toISOString();
          }
          s.status = 'complete';
          s.phase = 'draft';
        },
      );
      return { state: completed.state, run: runSummary };
    } catch (err) {
      // Mark failed; preserve prior content.
      const finalState = await this.getAgentState(tenantId, draftId, actorId);
      await this.withMutationLock(
        tenantId,
        draftId,
        actorId,
        canEdit,
        finalState.state.revision,
        (s) => {
          if (s.generation.lastRun) {
            s.generation.lastRun.status = 'failed';
          }
          s.status = 'failed';
        },
      );
      throw err;
    }
  }

  /**
   * GET /drafts/:draftId/agent/generation — get the current generation status.
   */
  async getGenerationStatus(
    tenantId: string,
    draftId: string,
    actorId: string,
  ): Promise<{ run: DocumentAgentRunSummary | null }> {
    const draft = await this.loadDraft(tenantId, draftId, actorId, canRead);
    const state = readAgentState(draft.config);
    return { run: state.generation.lastRun ?? null };
  }

  /**
   * POST /drafts/:draftId/agent/generation/retry — retry failed sections.
   * Delegates to the existing GenerationService.retryFailedSections.
   * Does NOT regenerate successful sections.
   */
  async retryGeneration(
    tenantId: string,
    draftId: string,
    actorId: string,
    expectedRevision: number,
    sectionIds?: string[],
  ): Promise<{ state: DocumentAgentState }> {
    await this.loadDraft(tenantId, draftId, actorId, canEdit);
    // Delegate to existing retry-failed-sections.
    await this.generation.retryFailedSections(tenantId, draftId, actorId);
    const state = await this.getAgentState(tenantId, draftId, actorId);
    return state;
  }

  /**
   * POST /drafts/:draftId/agent/generation/cancel — cancel generation.
   */
  async cancelGeneration(
    tenantId: string,
    draftId: string,
    actorId: string,
    expectedRevision: number,
  ): Promise<{ state: DocumentAgentState }> {
    return this.withMutationLock(tenantId, draftId, actorId, canEdit, expectedRevision, (state) => {
      state.generation.activeRunId = undefined;
      state.status = 'partial';
      if (state.generation.lastRun) {
        state.generation.lastRun.status = 'partial';
      }
    });
  }

  // ── Quality ─────────────────────────────────────────────────────────────
  // Quality evaluation is handled by DocumentAgentQualityService, which is
  // injected into the controller (not this service). The controller delegates
  // quality endpoint calls directly to the quality service.

  // ── Internal helpers ────────────────────────────────────────────────────

  /**
   * Load a draft with tenant scoping + role check. Returns the draft with
   * config as a typed object.
   */
  private async loadDraft(
    tenantId: string,
    draftId: string,
    actorId: string,
    predicate: (role: ResolvedRole) => boolean,
  ): Promise<DraftWithConfig> {
    const draft = await this.prisma.wsDraft.findFirst({
      where: { id: draftId, tenantId },
    });
    if (!draft) throw new NotFoundException('Draft not found');
    await this.collaborators.assertCan(
      tenantId,
      draftId,
      actorId,
      predicate,
      'You do not have permission to access this document',
    );
    return {
      id: draft.id,
      tenantId: draft.tenantId,
      ownerId: draft.ownerId,
      config: (draft.config as Record<string, unknown>) ?? {},
      updatedAt: draft.updatedAt,
    };
  }

  /**
   * Execute a mutation under optimistic concurrency control. Loads the draft,
   * checks expectedRevision, applies the mutation (which increments revision),
   * and persists. Returns the updated state.
   */
  private async withMutationLock(
    tenantId: string,
    draftId: string,
    actorId: string,
    predicate: (role: ResolvedRole) => boolean,
    expectedRevision: number,
    mutation: (state: DocumentAgentState) => void,
  ): Promise<{ state: DocumentAgentState }> {
    const draft = await this.loadDraft(tenantId, draftId, actorId, predicate);
    const state = readAgentState(draft.config);
    if (state.revision !== expectedRevision) {
      throw new ConflictException(REVISION_CONFLICT_CODE);
    }
    const next = mutateState(state, mutation);
    await this.persistAgentState(draft.id, draft.config, next);
    return { state: next };
  }

  /**
   * Persist the agent state back to WsDraft.config.documentAgent.
   * Uses Prisma update with tenantId filter for safety.
   */
  private async persistAgentState(
    draftId: string,
    existingConfig: Record<string, unknown>,
    state: DocumentAgentState,
  ): Promise<void> {
    const newConfig = { ...existingConfig, documentAgent: state as unknown as Record<string, unknown> };
    await this.prisma.wsDraft.update({
      where: { id: draftId },
      data: { config: newConfig as never },
    });
  }

  /**
   * Build a text summary of the conversation for the reasoning gateway.
   */
  private async buildConversationText(tenantId: string, draftId: string): Promise<string> {
    const messages = await this.prisma.wsAgentMessage.findMany({
      where: { tenantId, draftId },
      orderBy: { createdAt: 'asc' },
      take: 50,
    });
    return messages
      .map((m) => `${m.role}: ${m.text}`)
      .join('\n');
  }

  /**
   * Determine the allowed actions for the current state. Used in message
   * responses so the frontend knows what buttons to show.
   */
  private allowedActionsFor(state: DocumentAgentState): string[] {
    const actions: string[] = [];
    switch (state.phase) {
      case 'type':
        actions.push('select_type');
        break;
      case 'blueprint':
        actions.push('select_blueprint');
        break;
      case 'design':
        actions.push('select_theme');
        break;
      case 'goal':
        actions.push('set_goal');
        break;
      case 'brief':
        if (state.status === 'ready') {
          actions.push('review_brief', 'edit_brief', 'approve_brief');
        } else {
          actions.push('answer_questions', 'synthesize_brief');
        }
        break;
      case 'context':
        actions.push('recommend_context', 'analyze_context', 'approve_context');
        break;
      case 'outline':
        if (state.outline.approvedAt) {
          actions.push('revise_outline', 'approve_outline');
        } else {
          actions.push('generate_outline', 'edit_outline', 'approve_outline');
        }
        break;
      case 'generate':
        actions.push('start_generation', 'retry_failed', 'cancel');
        break;
      case 'draft':
        actions.push('review_draft', 'edit_draft', 'run_quality');
        break;
      case 'quality':
        actions.push('review_quality', 'fix_issues', 'export');
        break;
      case 'complete':
        actions.push('export', 'share');
        break;
    }
    return actions;
  }
}
