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
// - The SUPPORTED generated phases (brief/context/outline/document) do NOT call
//   the reasoning gateway or GenerationService: they issue ONE canonical native
//   conversation SDK turn through native-generation.bridge.ts and admit the
//   result through the existing state/proposal/approval owners.

import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { resolveBlueprintPin } from '../template-studio/blueprint-pin.js';
import { CollaboratorsService } from '../collaborators/collaborators.service.js';
import { canEdit, canRead, canReview, type ResolvedRole } from '../collaborators/role-policy.js';
import { GenerationService } from '../generation/generation.service.js';
import type { GenerationRunSummary } from '../generation/generation-run.js';
import { WorkspaceReasoningGateway } from '../workspace-reasoning/workspace-reasoning.gateway.js';
import {
  recommendDocumentSetupPrompt,
  generateFollowUpQuestionsPrompt,
  synthesizeBriefPrompt,
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
import { DocumentAgentRevisionService } from './document-agent-revision.service.js';
import {
  NATIVE_GENERATION_TURN,
  NativeGenerationBridge,
  NativeGenerationRefusal,
  nativeGenerationTurnRequest,
  type NativeGenerationAdmission,
  type NativeGenerationPhase,
  type NativeGenerationProposalOwner,
  type NativeGenerationSource,
  type NativeGenerationTurnPort,
} from './native-generation.bridge.js';
import { NativeGenerationOwnerError } from './native-generation-conversation.client.js';
// The ONE explicit acknowledgement that a failed-unit retry is deliberate paid work.
import { RETRY_FAILED_UNITS_INTENT } from '../quick-draft/dto/intake.dto.js';

/** The accepted section text of a draft config, in the shape `computeContentHash` takes. */
function sectionContentOf(config: Record<string, unknown>): Record<string, string> {
  return (config as { sectionContent?: Record<string, string> }).sectionContent ?? {};
}

/** A content revision payload is a section-id -> text map; anything else does not apply. */
function isContentMap(value: unknown): value is Record<string, string> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.values(value as Record<string, unknown>).every((text) => typeof text === 'string')
  );
}

/** Error code for stale revision conflicts. */
export const REVISION_CONFLICT_CODE = 'DOCUMENT_AGENT_REVISION_CONFLICT';
/** Error code for stale proposals. */
export const PROPOSAL_STALE_CODE = 'PROPOSAL_STALE';

/** A draft row with its config loaded as a typed object. */
type DraftWithConfig = {
  id: string;
  tenantId: string;
  ownerId: string;
  clientId: string | null;
  config: Record<string, unknown>;
  updatedAt: Date;
};

/**
 * The shape every supported generated phase answers with: the canonical state
 * after the phase, the retained native request identity, and the pending
 * proposal when the phase was admitted as one.
 */
export type DocumentAgentNativeGenerationResult = {
  state: DocumentAgentState;
  requestId: string;
  status: 'result' | 'proposed' | 'approval-required' | 'unknown';
  proposal: { proposalId: string } | null;
};

/**
 * The proposal owner used when the deployment does not compose the existing
 * revision service. It refuses rather than inventing a store.
 */
const UNAVAILABLE_PROPOSALS: NativeGenerationProposalOwner = {
  createProposal: async () => {
    throw new NativeGenerationRefusal(
      'owner-unavailable',
      'The existing Workspace proposal owner is not composed for this deployment.',
    );
  },
};

/**
 * The core document-agent service. All mutations go through `mutateAgentState`
 * which enforces optimistic concurrency and atomic revision increment.
 */
@Injectable()
export class DocumentAgentService {
  private readonly logger = new Logger(DocumentAgentService.name);
  private readonly nativeGeneration: NativeGenerationBridge;

  constructor(
    private readonly prisma: PrismaService,
    private readonly collaborators: CollaboratorsService,
    private readonly reasoning: WorkspaceReasoningGateway,
    private readonly generation: GenerationService,
    @Optional() private readonly revisions?: DocumentAgentRevisionService,
    @Optional() @Inject(NATIVE_GENERATION_TURN) turn?: NativeGenerationTurnPort,
  ) {
    this.nativeGeneration = new NativeGenerationBridge({
      turn,
      proposals: this.revisions ?? UNAVAILABLE_PROPOSALS,
    });
  }

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
      initial.blueprintPin = (await resolveBlueprintPin(this.prisma, tenantId, init.blueprintPin)).pin;
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
      generation?: { mode?: 'quick' | 'standard' | 'max' };
      phase?: string;
      status?: string;
    },
  ): Promise<{ state: DocumentAgentState }> {
    let blueprintPin: DocumentAgentState['blueprintPin'] = null;
    if (patch.blueprintPin) {
      // Establish document access before resolving a requested catalog resource;
      // the mutation owner rechecks current access/revision before persistence.
      await this.loadDraft(tenantId, draftId, actorId, canEdit);
      blueprintPin = (await resolveBlueprintPin(this.prisma, tenantId, patch.blueprintPin)).pin;
    }
    return this.withMutationLock(tenantId, draftId, actorId, canEdit, expectedRevision, (state) => {
      if (patch.documentType) state.documentType = patch.documentType;
      if (blueprintPin) state.blueprintPin = blueprintPin;
      if (patch.theme) state.theme = patch.theme as unknown as DocumentAgentState['theme'];
      if (patch.goal) state.goal = patch.goal as unknown as DocumentAgentState['goal'];
      if (patch.generation?.mode) state.generation.mode = patch.generation.mode;
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
   *
   * The content comes from ONE canonical native conversation SDK turn prepared
   * by the existing greenfield Meri owner (see native-generation.bridge.ts);
   * the brief is then applied by this service's own state owner under the ACL
   * and revision lock, and the existing `brief.approvedAt` pin stays the human
   * acceptance. `WorkspaceReasoningGateway` is not consulted.
   */
  async synthesizeBrief(
    tenantId: string,
    draftId: string,
    actorId: string,
    expectedRevision: number,
    paidGeneration: boolean,
    credential?: string,
  ): Promise<DocumentAgentNativeGenerationResult> {
    const draft = await this.loadDraft(tenantId, draftId, actorId, canEdit);
    const state = readAgentState(draft.config);
    if (state.revision !== expectedRevision) throw new ConflictException(REVISION_CONFLICT_CODE);
    const admission = await this.admitNativeGeneration(state, {
      phase: 'brief',
      tenantId,
      actorId,
      draftId,
      clientId: draft.clientId,
      expectedRevision,
      intent: paidGeneration,
      credential,
    });
    if (admission.kind === 'result') {
      const brief = admission.result.brief;
      if (!brief) throw new ConflictException('The native brief result did not carry a brief.');
      const updated = await this.withMutationLock(tenantId, draftId, actorId, canEdit, expectedRevision, (s) => {
        s.brief.objective = brief.objective;
        s.brief.audience = brief.audience;
        s.brief.desiredAction = brief.desiredAction;
        s.brief.subject = brief.subject;
        s.brief.centralArgument = brief.centralArgument;
        s.brief.evidenceInstructions = brief.evidenceInstructions;
        s.brief.tone = brief.tone;
        s.brief.targetPages = brief.targetPages;
        s.brief.deadline = brief.deadline;
        s.brief.assumptions = brief.assumptions.map((a) => ({
          id: a.id,
          text: a.text,
          status: 'open' as const,
        }));
        s.brief.provenance = brief.provenance;
        s.status = 'ready';
      });
      return { state: updated.state, requestId: admission.requestId, status: 'result', proposal: null };
    }
    return this.nativeGenerationResult(tenantId, draftId, actorId, admission);
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
   * The recommendation comes from ONE canonical native conversation SDK turn;
   * it is applied by this service's state owner and `contextPlan.approvedAt`
   * stays the human acceptance.
   */
  async recommendContext(
    tenantId: string,
    draftId: string,
    actorId: string,
    expectedRevision: number,
    paidGeneration: boolean,
    credential?: string,
  ): Promise<DocumentAgentNativeGenerationResult> {
    const draft = await this.loadDraft(tenantId, draftId, actorId, canEdit);
    const state = readAgentState(draft.config);
    if (state.revision !== expectedRevision) throw new ConflictException(REVISION_CONFLICT_CODE);
    const admission = await this.admitNativeGeneration(state, {
      phase: 'context-recommend',
      tenantId,
      actorId,
      draftId,
      clientId: draft.clientId,
      expectedRevision,
      intent: paidGeneration,
      credential,
    });
    if (admission.kind === 'result') {
      const context = admission.result.context;
      if (!context) throw new ConflictException('The native context result did not carry a context plan.');
      const updated = await this.withMutationLock(tenantId, draftId, actorId, canEdit, expectedRevision, (s) => {
        s.contextPlan.includedItemIds = context.includedItemIds;
        s.contextPlan.excludedItems = context.excludedItems;
      });
      return { state: updated.state, requestId: admission.requestId, status: 'result', proposal: null };
    }
    return this.nativeGenerationResult(tenantId, draftId, actorId, admission);
  }

  /**
   * POST /drafts/:draftId/agent/context/analyze — analyze context for
   * conflicts and coverage. The analysis comes from ONE canonical native
   * conversation SDK turn; the snapshot hash is still computed here from the
   * retained included items, so the existing conflict/coverage fence is kept.
   */
  async analyzeContext(
    tenantId: string,
    draftId: string,
    actorId: string,
    expectedRevision: number,
    paidGeneration: boolean,
    credential?: string,
  ): Promise<DocumentAgentNativeGenerationResult> {
    const draft = await this.loadDraft(tenantId, draftId, actorId, canEdit);
    const state = readAgentState(draft.config);
    if (state.revision !== expectedRevision) throw new ConflictException(REVISION_CONFLICT_CODE);
    const admission = await this.admitNativeGeneration(state, {
      phase: 'context-analyze',
      tenantId,
      actorId,
      draftId,
      clientId: draft.clientId,
      expectedRevision,
      intent: paidGeneration,
      credential,
    });
    if (admission.kind === 'result') {
      const analysis = admission.result.context;
      if (!analysis) throw new ConflictException('The native context result did not carry a context plan.');
      const items = await this.prisma.wsContextItem.findMany({
        where: { tenantId, draftId },
      });
      const included = items.filter((i) => state.contextPlan.includedItemIds.includes(i.id));
      const snapshotItems = included.map((i) => ({
        id: i.id,
        label: (i.payload as { label?: string })?.label ?? '',
        text: (i.payload as { text?: string })?.text,
      }));
      const snapshotHash = computeContextSnapshotHash(snapshotItems);
      const updated = await this.withMutationLock(tenantId, draftId, actorId, canEdit, expectedRevision, (s) => {
        s.contextPlan.conflicts = (analysis.conflicts ?? []) as ContextConflict[];
        s.contextPlan.coverage = analysis.coverage as ContextCoverage;
        s.contextPlan.snapshotHash = snapshotHash;
      });
      return { state: updated.state, requestId: admission.requestId, status: 'result', proposal: null };
    }
    return this.nativeGenerationResult(tenantId, draftId, actorId, admission);
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
   * POST /drafts/:draftId/agent/context/resolve — resolve a single context
   * conflict by marking it resolved with the user's resolution text. This is
   * the semantic route GAPS §4 identified as missing: the DTO was defined but
   * had zero references. Now resolves the conflict in the agent state JSONB.
   */
  async resolveContextConflict(
    tenantId: string,
    draftId: string,
    actorId: string,
    conflictId: string,
    dto: { resolution: string; keptItemId?: string; excludedItemIds?: string[] },
    expectedRevision: number,
  ): Promise<{ state: DocumentAgentState }> {
    return this.withMutationLock(tenantId, draftId, actorId, canEdit, expectedRevision, (s) => {
      const conflict = s.contextPlan.conflicts.find((c) => c.id === conflictId);
      if (!conflict) {
        throw new NotFoundException('Context conflict not found');
      }
      if (conflict.resolved) {
        throw new ConflictException('Conflict is already resolved');
      }
      // mutateState copies the conflicts ARRAY but shares its ELEMENTS, so the
      // matched element is replaced rather than written through: the object the
      // persist compare-and-set compares must stay exactly the stored row.
      s.contextPlan.conflicts = s.contextPlan.conflicts.map((c) =>
        c.id === conflictId ? { ...c, resolved: true, resolution: dto.resolution } : c,
      );
      // Remove excluded items from the included set so the approved plan
      // reflects the user's resolution choice.
      if (dto.excludedItemIds && dto.excludedItemIds.length > 0) {
        const excluded = new Set(dto.excludedItemIds);
        s.contextPlan.includedItemIds = s.contextPlan.includedItemIds.filter(
          (id) => !excluded.has(id),
        );
        for (const itemId of dto.excludedItemIds) {
          s.contextPlan.excludedItems.push({
            itemId,
            reason: `Excluded during conflict resolution: ${dto.resolution}`,
          });
        }
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
    actorId: string,
    itemId: string,
    payloadPatch: Record<string, unknown>,
    expectedRevision?: number,
  ): Promise<{ item: unknown }> {
    const draft = await this.loadDraft(tenantId, draftId, actorId, canEdit);
    if (expectedRevision !== undefined) {
      const state = readAgentState(draft.config);
      if (state.revision !== expectedRevision) {
        throw new ConflictException(REVISION_CONFLICT_CODE);
      }
    }
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
   *
   * The sections come from ONE canonical native conversation SDK turn. They are
   * NEVER written to the outline here: they are admitted as a PENDING
   * `outline_revision` proposal through the existing revision owner, and only
   * land when a reviewer with `canReview` accepts it (acceptProposal re-checks
   * the outline hash for staleness). This preserves the outline approval pin.
   */
  async generateOutline(
    tenantId: string,
    draftId: string,
    actorId: string,
    expectedRevision: number,
    paidGeneration: boolean,
    credential?: string,
  ): Promise<DocumentAgentNativeGenerationResult> {
    const draft = await this.loadDraft(tenantId, draftId, actorId, canEdit);
    const state = readAgentState(draft.config);
    // The blueprint must be pinned AND still resolvable before any paid turn.
    if (!state.blueprintPin) {
      throw new ConflictException('A blueprint must be pinned before generating an outline.');
    }
    await resolveBlueprintPin(this.prisma, tenantId, state.blueprintPin, 'retained');
    if (state.revision !== expectedRevision) throw new ConflictException(REVISION_CONFLICT_CODE);
    const admission = await this.admitNativeGeneration(state, {
      phase: 'outline',
      tenantId,
      actorId,
      draftId,
      clientId: draft.clientId,
      expectedRevision,
      intent: paidGeneration,
      credential,
    });
    return this.nativeGenerationResult(tenantId, draftId, actorId, admission);
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
    // Only a content revision carries content, and only when the payload really is
    // a section-id -> text map.
    const revisedContent =
      proposal.type === 'content_revision' && isContentMap(payload.revisedContent)
        ? payload.revisedContent
        : undefined;
    const updated = await this.withMutationLock(
      tenantId,
      draftId,
      actorId,
      canReview,
      expectedRevision,
      (s) => {
        if (proposal.type === 'outline_revision' && payload.outlineSnapshot) {
          s.outline.sections = payload.outlineSnapshot;
          s.outline.version += 1;
        }
        s.pendingProposalId = undefined;
      },
      // A content revision lands in the draft's EXISTING `sectionContent` editor
      // field, which the agent state mutation cannot carry. It is written in the
      // SAME optimistic config write as the state — one compare-and-set against
      // the exact config this accept validated staleness against — so a failed
      // compare leaves the proposal, the state, the config and the content
      // exactly as they were instead of accepting a proposal with no content.
      revisedContent === undefined
        ? undefined
        : (config) => ({
            ...config,
            sectionContent: {
              ...((config as { sectionContent?: Record<string, string> }).sectionContent ?? {}),
              ...revisedContent,
            },
          }),
    );

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
   * POST /drafts/:draftId/agent/generate — start the document run.
   *
   * The run is started as ONE canonical native conversation SDK turn for the
   * exact authenticated identity and the draft's selected client. A completed
   * document body is admitted by the EXISTING document/artifact approval owner,
   * never written here; this method only records the run under the existing
   * state owner so cancel/reload semantics and the run identity survive. It does
   * NOT call `GenerationService` and does NOT use an untracked void promise.
   */
  async generate(
    tenantId: string,
    draftId: string,
    actorId: string,
    expectedRevision: number,
    mode: GenerationMode = 'standard',
    paidGeneration: boolean,
    credential?: string,
  ): Promise<{
    state: DocumentAgentState;
    run: DocumentAgentRunSummary | null;
    requestId: string;
    status: 'approval-required' | 'unknown';
    proposal: { proposalId: string } | null;
  }> {
    const draft = await this.loadDraft(tenantId, draftId, actorId, canEdit);
    const state = readAgentState(draft.config);

    // Validate preconditions (the existing approval pins).
    if (!state.brief.approvedAt) {
      throw new ConflictException('Brief must be approved before generation.');
    }
    if (!state.contextPlan.approvedAt) {
      throw new ConflictException('Context must be approved before generation.');
    }
    if (!state.outline.approvedAt) {
      throw new ConflictException('Outline must be approved before generation.');
    }
    if (state.revision !== expectedRevision) throw new ConflictException(REVISION_CONFLICT_CODE);

    // The bridge retains a DEFINITIVE failure of this first attempt against the run's
    // own request identity before it maps the refusal (see admitNativeGeneration), so
    // a real first failure is retryable even though nothing was ever written on it.
    const admission = await this.admitNativeGeneration(state, {
      phase: 'document',
      tenantId,
      actorId,
      draftId,
      clientId: draft.clientId,
      expectedRevision,
      intent: paidGeneration,
      credential,
    });

    if (admission.kind === 'unknown') {
      // UNKNOWN is reconciled against the exact retained request — never retried
      // blind. The run's own request identity is RETAINED here, in the draft's own
      // compare-and-set, because an UNKNOWN is exactly the state in which the caller
      // must be able to reconcile (and, when the owner later reports a failure, to
      // retry) the request this run actually issued. The caller reads that same
      // requestId back.
      await this.retainNativeRunIdentity({
        tenantId,
        draftId,
        actorId,
        expectedRevision,
        requestId: admission.requestId,
        status: 'active',
      });
      const current = await this.getAgentState(tenantId, draftId, actorId);
      return {
        state: current.state,
        run: current.state.generation.lastRun ?? null,
        requestId: admission.requestId,
        status: 'unknown',
        proposal: null,
      };
    }
    // The document body the native turn produced enters the EXISTING Workspace
    // proposal owner as a PENDING `content_revision` proposal. Nothing is written
    // here: only a reviewer with `canReview` accepting the proposal lands the body
    // in the draft's existing `sectionContent` field, and acceptProposal re-checks
    // the retained content hash for staleness first.
    let proposalId: string;
    if (admission.kind === 'result' && admission.result.document) {
      if (!this.revisions) {
        throw new ServiceUnavailableException(
          'The Workspace document proposal owner is not composed; the document body cannot be admitted.',
        );
      }
      const revisedContent = Object.fromEntries(
        admission.result.document.sections.map((section) => [section.id, section.text]),
      );
      const retainedContent =
        (draft.config as { sectionContent?: Record<string, string> }).sectionContent ?? {};
      const proposal = await this.revisions.createProposal({
        tenantId,
        draftId,
        createdById: actorId,
        type: 'content_revision',
        baseRevision: expectedRevision,
        baseHash: computeContentHash(retainedContent),
        payload: {
          revisedContent,
          requestId: admission.requestId,
          runId: admission.runId,
          mode,
        },
      });
      proposalId = proposal.proposalId;
    } else if (admission.kind === 'approval-required') {
      proposalId = admission.proposalId;
    } else {
      throw new ConflictException(
        'The native document run did not return a document body or an approval-required admission.',
      );
    }

    const runSummary: DocumentAgentRunSummary = {
      runId: admission.runId,
      requestId: admission.requestId,
      mode,
      startedAt: new Date().toISOString(),
      status: 'active',
      stages: [],
      // The pin this run's retained request identity was derived under, so a later
      // failed-unit retry re-derives the SAME identity and can refuse a run whose
      // pinned sources moved.
      expectedRevision,
    };
    const updated = await this.withMutationLock(tenantId, draftId, actorId, canEdit, expectedRevision, (s) => {
      s.generation.mode = mode;
      s.generation.activeRunId = admission.runId;
      s.generation.lastRun = runSummary;
      s.phase = 'generate';
      s.status = 'generating';
      s.pendingProposalId = proposalId;
    });
    return {
      state: updated.state,
      run: runSummary,
      requestId: admission.requestId,
      status: 'approval-required',
      proposal: { proposalId },
    };
  }

  /**
   * GET /drafts/:draftId/agent/generation — get the current generation status.
   */
  async getGenerationStatus(
    tenantId: string,
    draftId: string,
    actorId: string,
    options: { credential?: string } = {},
  ): Promise<{ run: DocumentAgentRunSummary | null }> {
    const draft = await this.loadDraft(tenantId, draftId, actorId, canRead);
    const state = readAgentState(draft.config);
    const run = state.generation.lastRun ?? null;
    // This status read IS the caller's existing check action, so it is where a
    // retained native run whose outcome the owner has not published is reconciled:
    // the exact retained request is read back — never turned again, never
    // re-scoped, never re-identified — and the run's own stored outcome is made
    // truthful. Without it an UNKNOWN admission could never become the
    // authoritative failure an explicit failed-unit retry continues.
    const reconciled = await this.reconcileRetainedNativeRun({
      tenantId,
      draftId,
      actorId,
      clientId: draft.clientId ?? null,
      credential: options.credential ?? '',
      state,
      config: draft.config as Record<string, unknown>,
    });
    return { run: reconciled ?? run };
  }

  /**
   * Reconcile the outcome of a retained NATIVE document run from a current-access
   * status read: the run's RETAINED request is read back through the existing native
   * owner, and only what the owner itself publishes is stored.
   *
   *   * the request is RE-DERIVED from the pins the run was admitted under, so a run
   *     whose pinned sources moved (or one that is not this state's) is left alone
   *     with nothing dispatched;
   *   * it is only ever READ: no turn is issued, no identity is replaced, and a run
   *     that is still UNKNOWN keeps its identity and writes nothing at all;
   *   * an owner-published DEFINITIVE failure makes the run retryable exactly once —
   *     a later explicit retry continues it;
   *   * an owner-published body enters the EXISTING pending `content_revision`
   *     proposal owner, exactly as the original turn's own success does; nothing
   *     lands in the draft until a reviewer accepts it.
   */
  private async reconcileRetainedNativeRun(input: {
    tenantId: string;
    draftId: string;
    actorId: string;
    clientId: string | null;
    credential: string;
    state: DocumentAgentState;
    /** The exact draft bytes this read was issued on. */
    config: Record<string, unknown>;
  }): Promise<DocumentAgentRunSummary | null> {
    const { tenantId, draftId, actorId, state } = input;
    const run = state.generation.lastRun;
    // Only a retained native run the owner has not settled has anything to
    // reconcile. A settled run is read as it is: a check never rewrites an answer it
    // already has, and it never re-derives an identity.
    if (run?.requestId === undefined || run.expectedRevision === undefined) return null;
    if (run.status !== 'active') return null;
    // A proposal still awaiting review IS this run's open outcome.
    if (state.pendingProposalId !== undefined) return null;
    if (input.credential.length === 0) return null;
    // Reconciling WRITES the run's outcome, so it needs the authority that outcome
    // needs: a caller who cannot edit generation keeps the local state, and nothing
    // is dispatched for them.
    const role = await this.collaborators.resolveRole(tenantId, draftId, actorId);
    if (!canEdit(role)) return null;
    // The run's OWN retained identity, re-derived from the pins it was admitted
    // under — never from a caller-provided identity.
    const retainedRequestId = nativeGenerationTurnRequest({
      phase: 'document',
      tenantId,
      actorId,
      draftId,
      clientId: input.clientId,
      expectedRevision: run.expectedRevision,
      sources: this.nativeGenerationSources(draftId, state, 'document'),
    }).requestId;
    if (retainedRequestId !== run.requestId) return null;

    let admission: NativeGenerationAdmission;
    try {
      admission = await this.readBackNativeGeneration({
        state,
        phase: 'document',
        tenantId,
        actorId,
        draftId,
        clientId: input.clientId,
        expectedRevision: run.expectedRevision,
        credential: input.credential,
        intent: true,
        attemptRunId: null,
        attemptGeneration: 1,
      });
    } catch (error) {
      // The owner's own published answer is a DEFINITIVE failure of this run: it
      // becomes truthfully retryable here.
      if (error instanceof NativeGenerationRefusal && error.code === 'run-failed')
        return this.recordRetainedRunStatus({ ...input, run, status: 'failed' });
      // Anything else (a credential this caller no longer holds, an owner that is not
      // composed, a policy refusal) is not this run's outcome.
      return null;
    }
    // Still UNKNOWN: the identity stays exactly as retained and NOTHING is written.
    if (admission.kind === 'unknown') return null;
    if (admission.kind === 'result' && admission.result.document) {
      // The owner's answer is not the caller's authority to write it: the CURRENT
      // edit/source grant is re-resolved through the existing collaborator owner here,
      // AFTER the owner answered and BEFORE anything becomes durable. A revoke or a
      // downgrade that landed while the read was in flight therefore admits nothing,
      // rather than committing a row the caller is refused at the door for.
      if (!(await this.holdsCurrentEditAccess(input.tenantId, input.draftId, input.actorId)))
        return null;
      return this.admitRetainedRunBody({ ...input, run, admission });
    }
    return null;
  }

  /**
   * The caller's CURRENT edit grant, resolved through the existing authorization owner
   * at the moment a durable effect would be admitted — never assumed from the read.
   */
  private async holdsCurrentEditAccess(
    tenantId: string,
    draftId: string,
    actorId: string,
  ): Promise<boolean> {
    try {
      await this.collaborators.assertCan(
        tenantId,
        draftId,
        actorId,
        canEdit,
        'You do not have permission to access this document',
      );
      return true;
    } catch {
      return false;
    }
  }

  /** Store the outcome the owner itself published for a retained run. */
  private async recordRetainedRunStatus(input: {
    tenantId: string;
    draftId: string;
    actorId: string;
    state: DocumentAgentState;
    run: DocumentAgentRunSummary;
    status: DocumentAgentRunSummary['status'];
  }): Promise<DocumentAgentRunSummary | null> {
    try {
      const updated = await this.withMutationLock(
        input.tenantId,
        input.draftId,
        input.actorId,
        canEdit,
        input.state.revision,
        (s) => {
          const prior = s.generation.lastRun;
          // Only THIS run, and only while it is still open: a draft that moved, a run
          // that was replaced, or an outcome written in between is never rewritten
          // from this older read.
          if (prior === undefined || prior.requestId !== input.run.requestId) return;
          if (prior.status !== 'active') return;
          s.generation.lastRun = { ...prior, status: input.status };
        },
      );
      return updated.state.generation.lastRun ?? null;
    } catch {
      // A moved draft or a lost lock is not the run's answer: the caller keeps the
      // state it already had and its next check reconciles again.
      return null;
    }
  }

  /**
   * A retained run whose own request the owner has since ANSWERED with a document
   * body enters the EXISTING pending `content_revision` proposal owner, exactly as
   * the original turn's own success does. The run was only READ back — no turn was
   * issued — and nothing lands in the draft until a reviewer accepts the proposal.
   */
  private async admitRetainedRunBody(input: {
    tenantId: string;
    draftId: string;
    actorId: string;
    /** The draft bytes the canonical read was ISSUED on (the caller's own snapshot). */
    config: Record<string, unknown>;
    run: DocumentAgentRunSummary;
    admission: NativeGenerationAdmission;
  }): Promise<DocumentAgentRunSummary | null> {
    const admission = input.admission;
    if (admission.kind !== 'result') return null;
    const { document } = admission.result;
    if (!document) return null;
    const revisions = this.revisions;
    if (!revisions) return null;
    // The proposal's base and the durable compare-and-set are the SAME draft bytes the
    // read was issued on. The draft is never re-loaded to obtain a newer base: an answer
    // belongs to the run it was read for, at the revision that run was admitted under.
    const snapshot = readAgentState(input.config);
    // ...and the base hash is the content hash OF those bytes. A permitted ordinary
    // content save replaces `config.sectionContent` without touching `documentAgent`,
    // so the revision does not move with the text: a base taken from a later load would
    // silently belong to text this answer was never generated against.
    const readBaseHash = computeContentHash(sectionContentOf(input.config));
    const revisedContent = Object.fromEntries(
      document.sections.map((section) => [section.id, section.text]),
    );
    let admitted = false;
    try {
      await this.prisma.$transaction(async (transaction) => {
        // The durable effect boundary. The run this answer belongs to, the state that
        // points at it, and the pending-proposal row are established together under one
        // compare-and-set, so a run that was replaced/cancelled in between, or a second
        // check holding the same answer, leaves NO actionable proposal behind: the row
        // is inserted only after the claim that justifies it has been written.
        const row = await transaction.wsDraft.findFirst({
          where: { id: input.draftId, tenantId: input.tenantId },
          select: { config: true },
        });
        const currentConfig = (row?.config ?? {}) as Record<string, unknown>;
        const current = readAgentState(currentConfig);
        // Anything that moved since the read means this answer is no longer the current
        // truth for this draft: the next check re-reads the then-current run.
        if (current.revision !== snapshot.revision) {
          throw new ConflictException(REVISION_CONFLICT_CODE);
        }
        // The revision is not the whole basis. An ordinary content save keeps
        // `documentAgent` (and the revision) exactly as it was while replacing the
        // accepted text, so an answer read for the OLDER text must not be admitted
        // against newer bytes it was never generated against.
        if (computeContentHash(sectionContentOf(currentConfig)) !== readBaseHash) {
          throw new ConflictException(REVISION_CONFLICT_CODE);
        }
        const retained = current.generation.lastRun;
        if (retained === undefined || retained.requestId !== input.run.requestId) {
          throw new ConflictException(REVISION_CONFLICT_CODE);
        }
        // A run that has been cancelled or settled since the read is no longer open, and
        // a draft that already has a pending proposal is not admitted a second one.
        if (retained.status !== 'active' || current.pendingProposalId !== undefined) {
          throw new ConflictException(REVISION_CONFLICT_CODE);
        }
        const claimed = mutateState(current, (s) => {
          s.generation = { ...s.generation, activeRunId: admission.runId };
          s.phase = 'generate';
          s.status = 'generating';
        });
        const claimedConfig = { ...currentConfig, documentAgent: claimed };
        const saved = await transaction.wsDraft.updateMany({
          where: { id: input.draftId, config: { equals: currentConfig as never } },
          data: { config: claimedConfig as never },
        });
        if (saved.count !== 1) throw new ConflictException(REVISION_CONFLICT_CODE);
        const proposal = await revisions.createProposal(
          {
            tenantId: input.tenantId,
            draftId: input.draftId,
            createdById: input.actorId,
            type: 'content_revision',
            baseRevision: snapshot.revision,
            baseHash: readBaseHash,
            payload: {
              revisedContent,
              requestId: admission.requestId,
              runId: admission.runId,
              mode: input.run.mode,
            },
          },
          transaction,
        );
        const linked = mutateState(claimed, (s) => {
          s.pendingProposalId = proposal.proposalId;
        });
        const savedLink = await transaction.wsDraft.updateMany({
          where: { id: input.draftId, config: { equals: claimedConfig as never } },
          data: { config: { ...claimedConfig, documentAgent: linked } as never },
        });
        if (savedLink.count !== 1) throw new ConflictException(REVISION_CONFLICT_CODE);
        admitted = true;
      });
    } catch {
      // Moved, replaced, cancelled, already-admitted or raced: nothing was inserted,
      // because the insert only ever follows the claim that passed the compare-and-set.
      return null;
    }
    if (!admitted) return null;
    const after = await this.loadDraft(input.tenantId, input.draftId, input.actorId, canEdit);
    return readAgentState(after.config).generation.lastRun ?? null;
  }

  /**
   * POST /drafts/:draftId/agent/generation/retry — retry the units a run FAILED.
   *
   * A run the NATIVE bridge admitted (it carries its own retained request identity)
   * is retried through the SAME retained native owner every other document turn uses
   * and lands as an EXISTING pending `content_revision` proposal. A run the legacy
   * engine produced keeps its existing `GenerationService.retryFailedSections`
   * behaviour byte-for-byte. Neither path regenerates a unit that already holds
   * accepted content.
   */
  async retryGeneration(
    tenantId: string,
    draftId: string,
    actorId: string,
    expectedRevision: number,
    sectionIds?: string[],
    options: { intent?: unknown; credential?: string } = {},
  ): Promise<{ state: DocumentAgentState }> {
    const draft = await this.loadDraft(tenantId, draftId, actorId, canEdit);
    const state = readAgentState(draft.config);
    // The explicit failed-unit retry intent IS the new native-only control's own
    // discriminator, so it may never fall through to the legacy engine dispatcher: a
    // run with no retained native request identity (fresh, stale, foreign or legacy)
    // is refused HERE, before either owner is consulted, and nothing is dispatched.
    // A caller that does not present that intent keeps its existing behaviour exactly,
    // including the historical legacy retry.
    if (
      options.intent === RETRY_FAILED_UNITS_INTENT &&
      state.generation.lastRun?.requestId === undefined
    )
      throw new ConflictException(
        'This run carries no retained native generation request; the paid native failed-unit retry only serves a durable native run.',
      );
    // The NATIVE-ONLY selector, and only a selector: the retained native request
    // identity is what makes a run native (see cancelGeneration), and only such a run
    // is served by the bridge. A legacy engine run has no requestId and keeps its
    // existing path — no legacy caller changes behaviour.
    if (state.generation.lastRun?.requestId !== undefined) {
      return this.retryNativeGeneration({
        tenantId,
        draftId,
        actorId,
        expectedRevision,
        sectionIds,
        intent: options.intent,
        credential: options.credential,
        clientId: draft.clientId ?? null,
        state,
        retainedContent:
          (draft.config as { sectionContent?: Record<string, string> }).sectionContent ?? {},
      });
    }
    // Delegate to existing retry-failed-sections. Note: the engine recomputes the
    // failed-section set itself from the persisted run and ignores `sectionIds`
    // (see docs/handoff/GAPS.md) — ask-for-specific-sections is not yet supported.
    // The access guard above is the one this method always applied.
    const result = await this.generation.retryFailedSections(tenantId, draftId, actorId);
    const engineRun = (result as { generationRun?: GenerationRunSummary | null }).generationRun ?? null;
    if (engineRun) {
      const finalState = await this.getAgentState(tenantId, draftId, actorId);
      return this.withMutationLock(
        tenantId,
        draftId,
        actorId,
        canEdit,
        finalState.state.revision,
        (s) => {
          // Construct a complete summary from the engine's real result even if no
          // prior lastRun existed — a real retry result must never be dropped.
          const prior = s.generation.lastRun;
          s.generation.lastRun = {
            runId: prior?.runId ?? engineRun.id,
            mode: prior?.mode ?? s.generation.mode,
            startedAt: prior?.startedAt ?? engineRun.startedAt,
            stages: prior?.stages ?? [],
            status: engineRun.status,
            completedAt: engineRun.completedAt,
            sectionResults: Object.fromEntries(
              engineRun.sectionResults.map((r) => [
                r.section,
                r.status === 'succeeded'
                  ? { status: 'succeeded' as const }
                  : { status: 'failed' as const, error: r.message },
              ]),
            ),
          };
          s.status = engineRun.status === 'failed' ? 'failed' : engineRun.status === 'partial' ? 'partial' : 'complete';
        },
      );
    }
    return this.getAgentState(tenantId, draftId, actorId);
  }

  /**
   * Retry the units a terminal NATIVE document run failed, through the SAME retained
   * native owner every other document turn uses, and land the result as an EXISTING
   * pending `content_revision` proposal.
   *
   * The units to retry are derived from the CURRENT PINNED outline and the draft's
   * RETAINED accepted content: a unit that already holds accepted bytes succeeded, so
   * it is never regenerated and its bytes survive both the retry and the accept. The
   * proposal carries ONLY the retried units and is based on the hash of the retained
   * content, so `acceptProposal` merges them over the preserved content and refuses a
   * draft that moved in the meantime.
   *
   * Access, the approval pins and the revision pin are the ones a first document turn
   * uses. The run's retained request identity is re-derived BEFORE either dispatcher
   * is consulted, so a run whose pinned sources moved — or one that does not belong to
   * this draft's own state — is refused without a native call.
   */
  private async retryNativeGeneration(input: {
    tenantId: string;
    draftId: string;
    actorId: string;
    expectedRevision: number;
    sectionIds?: string[];
    intent?: unknown;
    credential?: string;
    clientId: string | null;
    state: DocumentAgentState;
    retainedContent: Record<string, string>;
  }): Promise<{ state: DocumentAgentState }> {
    const { tenantId, draftId, actorId, expectedRevision, state, clientId } = input;
    const run = state.generation.lastRun;
    if (!run?.requestId || !run.runId)
      throw new ConflictException('This run carries no retained native request identity.');

    // The preconditions a first document turn enforces, in the same order.
    if (!state.brief.approvedAt)
      throw new ConflictException('Brief must be approved before generation.');
    if (!state.contextPlan.approvedAt)
      throw new ConflictException('Context must be approved before generation.');
    if (!state.outline.approvedAt)
      throw new ConflictException('Outline must be approved before generation.');
    if (state.revision !== expectedRevision) throw new ConflictException(REVISION_CONFLICT_CODE);
    // A proposal that is still pending must be decided first: its content has not
    // landed, so the failed units cannot be derived from the retained content.
    if (state.pendingProposalId !== undefined)
      throw new ConflictException('A pending proposal must be decided before this run can be retried.');
    if (run.status === 'active')
      throw new ConflictException('This run is still in flight; it cannot be retried.');
    const revisions = this.revisions;
    if (!revisions)
      throw new ServiceUnavailableException(
        'The Workspace document proposal owner is not composed; the document body cannot be admitted.',
      );

    // The RETAINED pins must still derive the run's OWN request identity. A run whose
    // pinned sources or revision moved — or a run that is not this state's — derives a
    // different identity and is refused HERE, before either dispatcher, with no native
    // call at all.
    const pin = run.expectedRevision;
    if (pin === undefined)
      throw new ConflictException('This run does not carry the revision pin a retry must continue.');
    const retainedRequestId = nativeGenerationTurnRequest({
      phase: 'document',
      tenantId,
      actorId,
      draftId,
      clientId,
      expectedRevision: pin,
      sources: this.nativeGenerationSources(draftId, state, 'document'),
    }).requestId;
    if (retainedRequestId !== run.requestId)
      throw new ConflictException(
        'The pinned sources of this run have changed since it was admitted; its retained native request cannot be continued.',
      );

    // The failed units, from this RUN's OWN retained per-unit facts and the current
    // pinned outline — never from the mere presence of accepted text in the draft,
    // which says nothing about whether THIS run's attempt produced that unit (text
    // accepted by an earlier run is not proof that the current attempt succeeded).
    // A unit this run recorded as succeeded — or one a completed attempt of this run
    // already landed — is preserved with its bytes and review state and is not
    // retried; every other pinned unit is.
    const succeeded = new Set<string>();
    for (const [unit, result] of Object.entries(run.sectionResults ?? {}))
      if (result?.status === 'succeeded') succeeded.add(unit);
    if (run.retry?.outcome === 'completed')
      for (const id of run.retry.sectionIds) succeeded.add(id);
    const failed = state.outline.sections.filter(
      (section) => !succeeded.has(section.id) && !succeeded.has(section.title),
    );
    const scoped = input.sectionIds?.length
      ? failed.filter((section) => input.sectionIds?.includes(section.id))
      : failed;
    if (scoped.length === 0)
      throw new ConflictException('This run has no failed unit to retry through the native owner.');
    const sectionIds = scoped.map((section) => section.id);

    const bound = run.retry;
    const sameScope =
      bound !== undefined &&
      bound.sectionIds.length === sectionIds.length &&
      bound.sectionIds.every((id, index) => id === sectionIds[index]);
    // An attempt that has NOT definitively failed (UNKNOWN, or one the owner is still
    // answering) IS this run's current attempt, and its scope was frozen when it was
    // pinned. A caller-supplied subset can therefore never re-scope it — neither to a
    // narrower nor to a wider set. Refusing here keeps that attempt's exact request and
    // scope intact; without it a changed subset would look like a different attempt and
    // silently replace a still-UNKNOWN binding with a second paid identity. Only a
    // DEFINITE failure permits a genuinely new, separately pinned attempt.
    if (bound !== undefined && bound.outcome !== 'failed' && !sameScope)
      throw new ConflictException(
        'This run already has an unresolved retry attempt pinned for a different set of units; that attempt must be reconciled before another retry is started.',
      );

    // An attempt that has NOT definitively failed is this run's current attempt: a
    // duplicate click or a reload addresses exactly it — the same request, read back
    // from the owner — and never allocates a second paid turn.
    const settled = bound !== undefined && bound.outcome !== 'failed' && sameScope;
    if (!settled && input.intent !== RETRY_FAILED_UNITS_INTENT)
      throw new BadRequestException(
        'Retrying the units a native run failed starts a new paid native generation turn and must be explicitly acknowledged with the retry intent.',
      );
    // The attempt GENERATION: every attempt that definitively failed is preserved in
    // custody, and this attempt is the next generation. Derived from the run's own
    // preserved custody — never a clock or a random id — so a duplicate click derives
    // the same one.
    const custody = run.retryCustody ?? [];
    const retired =
      bound === undefined || bound.outcome !== 'failed'
        ? custody
        : [...custody, { requestId: bound.requestId, sectionIds: bound.sectionIds }];
    const generation = settled ? bound.generation : retired.length + 1;
    const boundRevision = settled ? bound.expectedRevision : expectedRevision;
    // The retried units ONLY, in the pinned outline's own order.
    const scopedState: DocumentAgentState = {
      ...state,
      outline: { ...state.outline, sections: scoped },
    };
    // The identity of THIS attempt: the retained run id plus its generation, both hash
    // PREIMAGES ONLY — they refine the request so the owner can recognise a genuine
    // retry apart from its original failed run, and they never travel on the request.
    const attempt = nativeGenerationTurnRequest({
      phase: 'document',
      tenantId,
      actorId,
      draftId,
      clientId,
      expectedRevision: boundRevision,
      sources: this.nativeGenerationSources(draftId, scopedState, 'document'),
      attemptRunId: run.runId,
      attemptGeneration: generation,
    });

    if (!settled) {
      // Pinned BEFORE any effect, in the draft's own compare-and-set; the attempt and
      // the custody it retires land in ONE write, so they can never disagree.
      await this.withMutationLock(tenantId, draftId, actorId, canEdit, expectedRevision, (s) => {
        const prior = s.generation.lastRun;
        if (!prior) return;
        s.generation.lastRun = {
          ...prior,
          ...(retired.length === custody.length ? {} : { retryCustody: retired }),
          retry: {
            requestId: attempt.requestId,
            sectionIds,
            generation,
            expectedRevision: boundRevision,
            outcome: 'unknown' as const,
          },
        };
      });
    }

    const admitInput = {
      phase: 'document' as const,
      tenantId,
      actorId,
      draftId,
      clientId,
      expectedRevision: boundRevision,
      intent: true,
      credential: input.credential ?? '',
      attemptRunId: run.runId,
      attemptGeneration: generation,
      state: scopedState,
      sources: this.nativeGenerationSources(draftId, scopedState, 'document'),
    };
    let admission: NativeGenerationAdmission;
    try {
      // A settled attempt is only ever READ back: an uncertain or already-answered
      // attempt never becomes new paid work. Both branches keep the attempt's own
      // refusal code visible, so a definitive failure of the attempt can be recorded
      // before the caller sees the mapped HTTP error.
      admission = settled
        ? await this.readBackNativeGeneration({
            state: scopedState,
            phase: 'document',
            tenantId,
            actorId,
            draftId,
            clientId,
            expectedRevision: boundRevision,
            credential: input.credential ?? '',
            intent: true,
            attemptRunId: run.runId,
            attemptGeneration: generation,
          })
        : await this.nativeGeneration.admit(admitInput);
    } catch (error) {
      // A DEFINITIVE failure of the attempt itself is recorded BEFORE it is surfaced:
      // the next explicit retry is then a genuinely NEW, separately pinned attempt at
      // the next generation — custody keeps this one — instead of the run replaying a
      // failed attempt forever.
      if (error instanceof NativeGenerationRefusal && error.code === 'run-failed')
        await this.retireNativeRetryAttempt(tenantId, draftId, actorId, {
          requestId: settled ? bound.requestId : attempt.requestId,
          sectionIds,
        });
      throw this.nativeGenerationHttpError(error);
    }

    if (admission.kind === 'unknown') {
      // The bound attempt stays EXACTLY as pinned: nothing new is derived and a later
      // call reads the SAME request.
      return this.getAgentState(tenantId, draftId, actorId);
    }
    if (admission.kind !== 'result' || !admission.result.document)
      throw new ConflictException(
        'The native document retry did not return a document body for the failed units.',
      );

    const revisedContent = Object.fromEntries(
      admission.result.document.sections.map((section) => [section.id, section.text]),
    );
    const current = await this.getAgentState(tenantId, draftId, actorId);
    // ONLY the retried units, based on the RETAINED content's hash: accepting this
    // merges them over the units that succeeded, and a draft that moved in between is
    // refused as stale rather than overwriting content the reviewer has not seen.
    const proposal = await revisions.createProposal({
      tenantId,
      draftId,
      createdById: actorId,
      type: 'content_revision',
      baseRevision: current.state.revision,
      baseHash: computeContentHash(input.retainedContent),
      payload: {
        revisedContent,
        requestId: admission.requestId,
        runId: admission.runId,
        mode: run.mode,
        retriedSectionIds: sectionIds,
      },
    });
    return this.withMutationLock(
      tenantId,
      draftId,
      actorId,
      canEdit,
      current.state.revision,
      (s) => {
        const prior = s.generation.lastRun;
        if (prior) {
          s.generation.lastRun = {
            ...prior,
            retry: {
              requestId: admission.requestId,
              sectionIds,
              generation,
              expectedRevision: boundRevision,
              outcome: 'completed' as const,
            },
          };
        }
        s.generation.activeRunId = admission.runId;
        s.pendingProposalId = proposal.proposalId;
        s.phase = 'generate';
        s.status = 'generating';
      },
    );
  }

  /**
   * Record that the run's bound attempt DEFINITIVELY failed. The attempt itself stays
   * addressable (its identity is retained on the run); it becomes custody when the
   * next explicit retry binds its successor, so no failed attempt is ever replayed.
   */
  private async retireNativeRetryAttempt(
    tenantId: string,
    draftId: string,
    actorId: string,
    attempt: { requestId: string; sectionIds: string[] },
  ): Promise<void> {
    const current = await this.getAgentState(tenantId, draftId, actorId);
    await this.withMutationLock(tenantId, draftId, actorId, canEdit, current.state.revision, (s) => {
      const prior = s.generation.lastRun;
      if (!prior?.retry) return;
      s.generation.lastRun = {
        ...prior,
        status: 'failed',
        completedAt: new Date().toISOString(),
        retry: { ...prior.retry, outcome: 'failed' as const },
      };
      s.status = 'failed';
    });
  }

  /**
   * POST /drafts/:draftId/agent/generation/cancel — cancel generation.
   */
  async cancelGeneration(
    tenantId: string,
    draftId: string,
    actorId: string,
    expectedRevision: number,
    credential?: string,
  ): Promise<{ state: DocumentAgentState }> {
    // Cancel the EXACT retained native request: the run summary keeps the
    // native request identity, so a cancel after a reload still addresses the
    // same conversation turn and never a different one.
    const draft = await this.loadDraft(tenantId, draftId, actorId, canEdit);
    // The DTO carries only the revision, so the run this cancel means is whatever
    // the row retains NOW — never a run the caller was looking at. Refuse a stale
    // caller BEFORE the effect, exactly as the neighbouring native phases do (:555,
    // :647, :686, :842, :1115): a request that must be turned away must not stop
    // the newer run that took its place. withMutationLock's own revision check and
    // the single persist compare-and-set stay the authoritative guard — no second
    // lock, transaction or authority is added here.
    const current = readAgentState(draft.config);
    if (current.revision !== expectedRevision) throw new ConflictException(REVISION_CONFLICT_CODE);
    const retainedRun = current.generation.lastRun;
    const retained = retainedRun?.requestId;
    if (retained !== undefined) {
      try {
        await this.nativeGeneration.cancel(
          {
            requestId: retained,
            tenantId,
            actorId,
            draftId,
            clientId: draft.clientId,
            // The exact run the original turn started, retained in the run summary:
            // the native owner must resolve this binding, never a different one.
            ...(retainedRun?.runId === undefined ? {} : { runId: retainedRun.runId }),
          },
          credential ?? '',
        );
      } catch (error) {
        throw this.nativeGenerationHttpError(error);
      }
    }
    return this.withMutationLock(tenantId, draftId, actorId, canEdit, expectedRevision, (state) => {
      state.generation = {
        ...state.generation,
        activeRunId: undefined,
        // The run summary is a NESTED object that mutateState shares with the
        // stored state, so the cancel REPLACES it instead of writing through it:
        // the object handed to the persist compare-and-set must stay exactly the
        // stored row, or the cancel would 409 after the native cancel was issued.
        lastRun:
          state.generation.lastRun === undefined
            ? undefined
            : { ...state.generation.lastRun, status: 'partial' as const },
      };
      state.status = 'partial';
    });
  }

  // ── Quality ─────────────────────────────────────────────────────────────
  // Quality evaluation is handled by DocumentAgentQualityService, which is
  // injected into the controller (not this service). The controller delegates
  // quality endpoint calls directly to the quality service.

  // ── Native generation helpers (approved greenfield owner) ────────────────

  /**
   * The exact retained Workspace sources a native generation turn is scoped to.
   * Derived only from canonical draft state (opaque ids — never prompt or
   * document text), so an unchanged request always derives the same native
   * request identity and a changed retained set derives a different one.
   */
  private nativeGenerationSources(
    draftId: string,
    state: DocumentAgentState,
    phase: NativeGenerationPhase,
  ): NativeGenerationSource[] {
    const sources: NativeGenerationSource[] = [
      { id: draftId, kind: 'workspace-draft' },
      ...state.contextPlan.includedItemIds.map((id) => ({ id, kind: 'context-item' })),
    ];
    if (state.blueprintPin) sources.push({ id: state.blueprintPin.versionId, kind: 'blueprint-version' });
    if (state.documentType) sources.push({ id: state.documentType.id, kind: 'document-type' });
    // The document body is keyed by the APPROVED outline's sections, so the exact
    // retained section ids travel as sources and the answer must key them exactly.
    if (phase === 'document')
      sources.push(...state.outline.sections.map((section) => ({ id: section.id, kind: 'outline-section' })));
    return sources;
  }

  /**
   * Admit one supported generated phase through the native bridge and translate
   * its policy refusal into the HTTP error the caller sees. The legacy
   * `WorkspaceReasoningGateway` / `GenerationService` owners are never
   * consulted from here.
   */
  private async admitNativeGeneration(
    state: DocumentAgentState,
    request: {
      phase: NativeGenerationPhase;
      tenantId: string;
      actorId: string;
      draftId: string;
      clientId: string | null;
      expectedRevision: number;
      intent: unknown;
      credential?: string;
      /**
       * The retained native run a failed-unit retry ATTEMPT continues, and its
       * generation. HASH PREIMAGES ONLY — they are part of the derived request
       * identity and never travel on the request that is posted.
       */
      attemptRunId?: string | null;
      attemptGeneration?: number | null;
    },
  ): Promise<NativeGenerationAdmission> {
    try {
      return await this.nativeGeneration.admit({
        ...request,
        // The bridge's input contract always carries a credential STRING, so the
        // optional credential this service accepts is normalised here rather than
        // asserted: an absent credential becomes the empty string and the bridge's
        // own requireCredential() remains the single refusal point for it. The
        // caller's credential itself is forwarded verbatim, never reinterpreted.
        credential: request.credential ?? '',
        state,
        sources: this.nativeGenerationSources(request.draftId, state, request.phase),
      });
    } catch (error) {
      // A DEFINITIVE failure of a FIRST document attempt is retained BEFORE the mapped
      // HTTP error reaches the caller. Before this the run's identity was written only
      // on a success or an approval, so a real first failure could never become
      // retryable and its failed units could never be re-derived from the run's own
      // retained facts. Only the run's own (undiscriminated) request is retained: an
      // ATTEMPT's identity is a continuation and must never replace the run's.
      if (
        error instanceof NativeGenerationRefusal &&
        error.code === 'run-failed' &&
        request.attemptRunId === undefined
      )
        await this.retainNativeRunIdentity({
          tenantId: request.tenantId,
          draftId: request.draftId,
          actorId: request.actorId,
          expectedRevision: request.expectedRevision,
          requestId: nativeGenerationTurnRequest({
            phase: request.phase,
            tenantId: request.tenantId,
            actorId: request.actorId,
            draftId: request.draftId,
            clientId: request.clientId,
            expectedRevision: request.expectedRevision,
            sources: this.nativeGenerationSources(request.draftId, state, request.phase),
          }).requestId,
          status: 'failed',
        });
      throw this.nativeGenerationHttpError(error);
    }
  }

  /**
   * READ back one already-issued native request through the same bridge, without ever
   * issuing a turn: a duplicate click or a reload resolves the SAME request instead of
   * starting a second paid generation. The attempt's refusal code stays visible to the
   * caller, which must be able to record a definitive failure of that attempt.
   */
  private async readBackNativeGeneration(input: {
    state: DocumentAgentState;
    phase: NativeGenerationPhase;
    tenantId: string;
    actorId: string;
    draftId: string;
    clientId: string | null;
    expectedRevision: number;
    credential: string;
    /** Carried for the input contract only: a READ never consumes a paid intent. */
    intent: unknown;
    attemptRunId: string | null;
    attemptGeneration: number;
  }): Promise<NativeGenerationAdmission> {
    return this.nativeGeneration.reconcile({
      ...input,
      sources: this.nativeGenerationSources(input.draftId, input.state, input.phase),
    });
  }

  /** A bridge refusal is a policy decision; it maps to a 4xx/503, not a 500. */
  private nativeGenerationHttpError(error: unknown): Error {
    if (error instanceof NativeGenerationOwnerError) {
      switch (error.code) {
        case 'unavailable':
          return new ServiceUnavailableException(error.message);
        case 'authority':
          return new ForbiddenException(error.message);
        case 'output':
          return new BadGatewayException(error.message);
        default:
          return new ConflictException(error.message);
      }
    }
    if (!(error instanceof NativeGenerationRefusal)) return error as Error;
    switch (error.code) {
      case 'intent-required':
      case 'credential-required':
        return new BadRequestException(error.message);
      case 'owner-unavailable':
        return new ServiceUnavailableException(error.message);
      default:
        return new ConflictException(error.message);
    }
  }

  /**
   * Retain a native document run's OWN request identity through the existing state
   * owner, under the caller's revision pin, BEFORE a settled answer exists.
   *
   * A first attempt that answered UNKNOWN and a first attempt that DEFINITIVELY
   * failed are both runs this draft must be able to reconcile — and, once the owner
   * reports a failure, to retry from the run's own retained facts. Before this, the
   * identity was written only on a success or an approval, so neither state could
   * ever become retryable. The write cannot mask the outcome it describes: a lock or
   * revision refusal here leaves the caller's own answer (UNKNOWN, or the mapped
   * failure) untouched.
   *
   * Every per-run fact it carries is bound to the request that produced it. Reusing
   * the SAME request keeps that run's own custody, bound attempt and per-unit facts;
   * a DISTINCT request starts with its own truthful run facts and never inherits an
   * earlier run's successes or completed attempt — inheriting them would let a later
   * generation failure claim the earlier run's succeeded units and silently omit the
   * outstanding units of the run that actually failed.
   */
  private async retainNativeRunIdentity(input: {
    tenantId: string;
    draftId: string;
    actorId: string;
    expectedRevision: number;
    requestId: string;
    status: DocumentAgentRunSummary['status'];
  }): Promise<void> {
    try {
      await this.withMutationLock(
        input.tenantId,
        input.draftId,
        input.actorId,
        canEdit,
        input.expectedRevision,
        (s) => {
          const prior = s.generation.lastRun;
          // A retained run's facts belong to the request that produced them. The SAME
          // request keeps its own per-unit facts, bound attempt and custody (an UNKNOWN
          // and a later definitive failure of ONE attempt are the same run, and a
          // legitimate existing custody must never be discarded). A DISTINCT request
          // starts with its own truthful run facts instead.
          if (prior !== undefined && prior.requestId === input.requestId) {
            s.generation.lastRun = {
              ...prior,
              status: input.status,
              expectedRevision: input.expectedRevision,
            };
            return;
          }
          s.generation.lastRun = {
            runId: input.requestId,
            requestId: input.requestId,
            mode: s.generation.mode,
            startedAt: new Date().toISOString(),
            status: input.status,
            stages: [],
            expectedRevision: input.expectedRevision,
          };
        },
      );
    } catch {
      // A moved draft (revision refusal) or a lost lock is not this run's answer: the
      // caller still sees UNKNOWN, or the definitive failure it was given.
    }
  }

  /**
   * The canonical answer a supported generated phase returns: the state after
   * the phase, the retained native request identity, and the pending proposal
   * when the phase was admitted as one.
   */
  private async nativeGenerationResult(
    tenantId: string,
    draftId: string,
    actorId: string,
    admission: NativeGenerationAdmission,
  ): Promise<DocumentAgentNativeGenerationResult> {
    const current = await this.getAgentState(tenantId, draftId, actorId);
    if (admission.kind === 'unknown') {
      return { state: current.state, requestId: admission.requestId, status: 'unknown', proposal: null };
    }
    return {
      state: current.state,
      requestId: admission.requestId,
      status: admission.kind,
      proposal: admission.kind === 'result' ? null : { proposalId: admission.proposalId },
    };
  }

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
      where: { prospectId: null, id: draftId, tenantId },
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
      clientId: (draft.clientId as string | null | undefined) ?? null,
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
    configPatch?: (config: Record<string, unknown>) => Record<string, unknown>,
  ): Promise<{ state: DocumentAgentState }> {
    const draft = await this.loadDraft(tenantId, draftId, actorId, predicate);
    const state = readAgentState(draft.config);
    if (state.revision !== expectedRevision) {
      throw new ConflictException(REVISION_CONFLICT_CODE);
    }
    const next = mutateState(state, mutation);
    await this.persistAgentState(draft.id, draft.config, next, configPatch);
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
    configPatch?: (config: Record<string, unknown>) => Record<string, unknown>,
  ): Promise<void> {
    const patched = configPatch === undefined ? existingConfig : configPatch(existingConfig);
    const newConfig = { ...patched, documentAgent: state as unknown as Record<string, unknown> };
    const saved = await this.prisma.wsDraft.updateMany({
      where: { id: draftId, config: { equals: existingConfig as never } },
      data: { config: newConfig as never },
    });
    if (saved.count !== 1) throw new ConflictException(REVISION_CONFLICT_CODE);
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
