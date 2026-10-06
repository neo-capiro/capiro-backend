import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { TenantContext } from '@capiro/shared';
import type {
  LedgerEntry,
  MeriGovernedTurnContext,
  MeriEvidenceManifest,
} from '@capiro/meriv2-core';
import { createMeriResearchPlanExecutionEnvelope } from '@capiro/meriv2-core';
import { classifyApiToolReadOutcome } from '@capiro/shared/meri-read-outcome';
import { AiCredentialResolverService } from '../ai-credentials/ai-credential-resolver.service.js';
import { MeriConversationEvidenceService } from './meri-conversation-evidence.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { MeriFeatureFlagsService } from './meri-feature-flags.service.js';
import {
  MeriV3ChatClient,
  type MeriV3ChatStreamEvent,
  type MeriV3ProviderTelemetry,
} from './meriv3-chat.client.js';
import type { MeriResearchHandoff } from './meri-research-handoff.js';
import type { ResearchRunState } from './meri-research-run-state.js';
import type { SourceAttribution } from './meri-research.service.js';
import { publicResearchSourceTool } from './meri-report-provenance.js';
import {
  classifyResearchProducerInputs,
  type ResearchProducerInputCategories,
  type ResearchProducerInputDraftV1,
  type ResearchProducerInputMode,
} from './meri-research-producer-inputs.js';
import {
  projectResearchObserverEvent,
  ResearchTerminalError,
} from './research-observer-projection.js';
import type { ResearchPlanV1 } from './meri-research-plan.js';
import {
  ResearchChildTaskError,
  researchChildEvidenceHandles,
  researchChildOutputContract,
  validateResearchChildOutput,
  type ResearchChildStructuredOutputV1,
  type ResearchChildTaskV1,
} from './meri-research-child-task.js';

export interface ResearchRuntimeAuth {
  bearerToken?: string;
  impersonateTenantId?: string;
  governedContext?: MeriGovernedTurnContext;
  signal?: AbortSignal;
  /** Explicit user Resume targets the currently saved attempt. */
  resumeRunId?: string;
  /** Internal lease identity. Never accepted from a request body. */
  run?: ResearchRunState;
}

interface ResearchRunInput {
  sessionId: string;
  topic?: string;
  conversationId?: string | null;
  clientId: string | null;
  system: string;
  user: string;
  handoff: MeriResearchHandoff | null;
  clientContext?: string | null;
  /** Child leaves cannot inherit conversational evidence outside their persisted task. */
  inheritConversationEvidence?: boolean;
  /** API-admitted authority. Present only for execution, never model planning. */
  admittedPlanExecution?: {
    plan: ResearchPlanV1;
    allowedReadCapabilities: string[];
  };
}

/** How much of a rejected child output the single correction sees. */
const RESEARCH_CHILD_CORRECTION_ECHO_CHARS = 12_000;

type DoneFrame = Extract<MeriV3ChatStreamEvent, { type: 'done' }>;
type ResearchDoneFrame = DoneFrame & {
  producerInputEvaluated?: true;
  producerInputSha256?: string;
  producerInputMode?: ResearchProducerInputMode;
  clientContextSha256?: string | null;
  producerInputDraft?: ResearchProducerInputDraftV1 | null;
  producerInputCategories?: ResearchProducerInputCategories;
};

export interface ResearchChildRuntimeResult {
  taskId: string;
  output: ResearchChildStructuredOutputV1;
  model: string;
  sources: SourceAttribution[];
  toolsUsed: string[];
  ledgerEntries: LedgerEntry[];
  citations: NonNullable<DoneFrame['citations']>;
  producerInputSha256: string;
  producerInputMode: ResearchProducerInputMode;
  clientContextSha256: string | null;
  producerInputDraft: ResearchProducerInputDraftV1 | null;
  producerInputCategories: ResearchProducerInputCategories;
  schemaCorrections: 0 | 1;
}

/** Reuse chat's provider-led Responses loop, credentials, tools and governance. */
@Injectable()
export class MeriV3ResearchRunner {
  constructor(
    private readonly client: MeriV3ChatClient,
    private readonly flags: MeriFeatureFlagsService,
    private readonly credentials: AiCredentialResolverService,
    private readonly prisma: PrismaService,
    private readonly conversationEvidence: MeriConversationEvidenceService,
  ) {}

  enabled(ctx: TenantContext): Promise<boolean> {
    // An unavailable configured runtime is an error, never an implicit switch
    // to a different provider after the user selected V3 for their chat.
    return this.flags.isMeriV3ChatEnabled(ctx.tenantId);
  }

  async plan(
    ctx: TenantContext,
    input: ResearchRunInput,
    auth: ResearchRuntimeAuth,
  ): Promise<string> {
    const { admittedPlanExecution: _execution, ...planningInput } = input;
    const result = await this.complete(
      ctx,
      planningInput,
      { ...auth, run: undefined },
      'none',
      () => {},
    );
    return result.reply;
  }

  async run(
    ctx: TenantContext,
    input: ResearchRunInput,
    auth: ResearchRuntimeAuth,
    onEvent: (event: Record<string, unknown>) => void,
  ): Promise<{
    reportBody: string;
    model: string;
    sources: SourceAttribution[];
    toolsUsed: string[];
    ledgerEntries: LedgerEntry[];
    citations: NonNullable<DoneFrame['citations']>;
    telemetry?: MeriV3ProviderTelemetry;
    providerCalls?: MeriV3ProviderTelemetry[];
    evidenceManifest?: MeriEvidenceManifest;
    retrieval?: DoneFrame['retrieval'];
    producerInputEvaluated: true;
    producerInputSha256: string;
    producerInputMode: ResearchProducerInputMode;
    clientContextSha256: string | null;
    producerInputDraft: ResearchProducerInputDraftV1 | null;
    producerInputCategories: ResearchProducerInputCategories;
  }> {
    const result = await this.complete(ctx, input, auth, 'read-only', onEvent);
    const ledgerEntries = result.ledgerEntries ?? [];
    const sources: SourceAttribution[] = [];
    const toolsUsed: string[] = [];
    for (const entry of ledgerEntries) {
      const durable = entry.durableSafeRead;
      if (!durable) continue;
      const publicTool = publicResearchSourceTool(durable.tool);
      if (!publicTool || !recheckableDurableStep(result.steps, entry)) continue;
      // Every re-checkable read is declared, so the read-time re-check covers
      // it; only a complete or empty read is shown as a source.
      toolsUsed.push(publicTool);
      if (!qualifiedDurableStep(result.steps, entry)) continue;
      const source: SourceAttribution = {
        tool: publicTool,
        label: 'Research source',
        summary: 'Authorized read completed',
        confidence: 'high',
      };
      sources.push(source);
      const projected = projectResearchObserverEvent(
        {
          type: 'source',
          source,
          durableSafeRead: {
            executionId: durable.executionId,
            providerCallId: durable.providerCallId,
            tool: publicTool,
            toolVersion: durable.toolVersion,
            classifier: durable.classifier,
            sequence: durable.sequence,
            receiptId: durable.receiptId,
            replayed: durable.replayed,
            outcome: 'complete',
            persisted: true,
            toolCallId: durable.providerCallId,
          },
        },
        { receiptCandidates: true },
      );
      if (projected) onEvent(projected);
    }
    return {
      reportBody: result.reply,
      model: result.model,
      sources,
      toolsUsed,
      ledgerEntries,
      citations: result.citations ?? [],
      ...(result.telemetry ? { telemetry: result.telemetry } : {}),
      ...(result.providerCalls ? { providerCalls: result.providerCalls } : {}),
      ...(result.evidenceManifest ? { evidenceManifest: result.evidenceManifest } : {}),
      ...(result.retrieval ? { retrieval: result.retrieval } : {}),
      producerInputEvaluated: true,
      producerInputSha256: result.producerInputSha256!,
      producerInputMode: result.producerInputMode!,
      clientContextSha256: result.clientContextSha256 ?? null,
      producerInputDraft: result.producerInputDraft ?? null,
      producerInputCategories: result.producerInputCategories!,
    };
  }

  /**
   * Execute one persisted leaf child through the same approved V3 provider/tool
   * runtime and parent research budget. The API owns task persistence; this
   * adapter owns only bounded provider calls and strict output validation.
   */
  async runChild(
    ctx: TenantContext,
    task: ResearchChildTaskV1,
    input: ResearchRunInput,
    auth: ResearchRuntimeAuth,
  ): Promise<ResearchChildRuntimeResult> {
    if (
      task.generation !== 1 ||
      task.delegationAllowed ||
      !auth.run ||
      task.parentRunId !== auth.run.id ||
      task.leaseEpoch !== auth.run.leaseEpoch ||
      task.scope.sessionId !== input.sessionId ||
      task.scope.tenantId !== ctx.tenantId ||
      task.scope.actorId !== ctx.userId ||
      task.scope.clientId !== input.clientId ||
      task.scope.conversationId !== (input.conversationId ?? null) ||
      task.modelConfig.policy !== 'current_approved_research_model' ||
      task.modelConfig.provider !== 'openai' ||
      task.modelConfig.modelSelection !== 'server_resolved' ||
      task.modelConfig.reasoningMode !== (input.handoff?.reasoningMode ?? 'deep') ||
      task.modelConfig.allowProviderFallback
    ) {
      throw new ResearchChildTaskError('research_child_runtime_binding_invalid');
    }
    if (
      !Number.isFinite(Date.parse(task.deadlineAt)) ||
      Date.now() >= Date.parse(task.deadlineAt)
    ) {
      throw new ResearchChildTaskError('research_child_deadline_exceeded');
    }

    const controller = new AbortController();
    const cancel = () => controller.abort(new ResearchChildTaskError('research_child_cancelled'));
    auth.signal?.addEventListener('abort', cancel, { once: true });
    if (auth.signal?.aborted) cancel();
    const timeout = setTimeout(
      () => controller.abort(new ResearchChildTaskError('research_child_deadline_exceeded')),
      Math.min(2_147_483_647, Date.parse(task.deadlineAt) - Date.now()),
    );
    timeout.unref();
    let rejectAbort!: () => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAbort = () => reject(controller.signal.reason);
      controller.signal.addEventListener('abort', rejectAbort, { once: true });
    });
    try {
      if (controller.signal.aborted) throw controller.signal.reason;
      const result = await Promise.race([
        this.runChildWithinDeadline(ctx, task, input, { ...auth, signal: controller.signal }),
        aborted,
      ]);
      if (Date.now() >= Date.parse(task.deadlineAt))
        throw new ResearchChildTaskError('research_child_deadline_exceeded');
      return result;
    } finally {
      clearTimeout(timeout);
      auth.signal?.removeEventListener('abort', cancel);
      controller.signal.removeEventListener('abort', rejectAbort);
    }
  }

  private async runChildWithinDeadline(
    ctx: TenantContext,
    task: ResearchChildTaskV1,
    input: ResearchRunInput,
    auth: ResearchRuntimeAuth,
  ): Promise<ResearchChildRuntimeResult> {
    const childInput: ResearchRunInput = {
      ...input,
      clientContext: null,
      inheritConversationEvidence: false,
      handoff: input.handoff
        ? {
            ...input.handoff,
            requestedDeliverable: task.goal,
            summary: null,
            summaryUpToMessageId: null,
            messages: [],
            attachments: [],
          }
        : null,
      system: [
        'You are a bounded read-only Meri research leaf. You cannot write, delegate, or change scope.',
        `Role: ${task.role}@${task.roleVersion}. Goal revision: ${task.goalRevision}.`,
        `Use only these admitted read capabilities: ${task.allowedCapabilities.join(', ')}.`,
        'Every finding must name one or more exact tool_name:record-id evidence handles observed in this turn.',
        'Return only strict JSON. Extra fields, prose, markdown fences, larger permissions, and guessed evidence IDs are invalid.',
        `OUTPUT CONTRACT: ${researchChildOutputContract(task.goalRevision)}`,
      ].join('\n'),
      user: [
        `Bounded child goal: ${task.goal}`,
        `Previously admitted evidence handles: ${task.evidenceHandles.join(', ') || '(none)'}.`,
        `Absolute deadline: ${task.deadlineAt}. Attempt: ${task.attempt}.`,
      ].join('\n'),
    };

    let frame = await this.complete(ctx, childInput, auth, 'read-only', () => {});
    const qualified = qualifyResearchChildFrame(frame);
    const handles = researchChildEvidenceHandles(frame.citations ?? []).filter((handle) =>
      qualified.qualifiedTools.includes(handle.slice(0, handle.indexOf(':'))),
    );
    let output: ResearchChildStructuredOutputV1;
    let schemaCorrections: 0 | 1 = 0;
    try {
      output = validateResearchChildOutput(frame.reply, {
        goalRevision: task.goalRevision,
        allowedEvidenceHandles: handles,
      });
    } catch (error) {
      if (!(error instanceof ResearchChildTaskError)) throw error;
      if (Date.now() >= Date.parse(task.deadlineAt) || auth.signal?.aborted) throw error;
      schemaCorrections = 1;
      // The correction only reformats: it reads nothing, so the rejected
      // turn's qualified reads remain its evidence and producer inputs, and
      // the rejected output it sees never outruns them.
      const correction = await this.complete(
        ctx,
        {
          ...childInput,
          admittedPlanExecution: childInput.admittedPlanExecution && {
            ...childInput.admittedPlanExecution,
            allowedReadCapabilities: [],
          },
          system: [
            childInput.system,
            'This is the single allowed correction. Do not run a broader task or request more permission.',
          ].join('\n'),
          user: [
            `The previous output was rejected: ${error.message}.`,
            `Currently valid evidence handles: ${handles.join(', ') || '(none)'}.`,
            `Rejected output: ${frame.reply.slice(0, RESEARCH_CHILD_CORRECTION_ECHO_CHARS)}`,
            `Return only the corrected JSON for goal revision ${task.goalRevision}. Keep only findings that the currently valid evidence handles support.`,
          ].join('\n'),
        },
        auth,
        'read-only',
        () => {},
      );
      // A ledger entry or a durable read step means a tool actually executed.
      // Other steps (context and synthesis progress) are not reads; counting
      // them rejected every correction in T5 run 9c52022a.
      if (
        (correction.ledgerEntries ?? []).length ||
        (correction.steps ?? []).some((step) => step.durableSafeRead)
      )
        throw new ResearchChildTaskError('research_child_correction_read');
      frame = { ...frame, reply: correction.reply, model: correction.model };
      output = validateResearchChildOutput(frame.reply, {
        goalRevision: task.goalRevision,
        allowedEvidenceHandles: handles,
      });
    }

    return {
      taskId: task.id,
      output,
      model: frame.model,
      sources: qualified.sources,
      toolsUsed: qualified.toolsUsed,
      ledgerEntries: qualified.ledgerEntries,
      citations: frame.citations ?? [],
      producerInputSha256: frame.producerInputSha256!,
      producerInputMode: frame.producerInputMode!,
      clientContextSha256: frame.clientContextSha256 ?? null,
      producerInputDraft: frame.producerInputDraft ?? null,
      producerInputCategories: frame.producerInputCategories!,
      schemaCorrections,
    };
  }

  private async complete(
    ctx: TenantContext,
    input: ResearchRunInput,
    auth: ResearchRuntimeAuth,
    toolPolicy: 'none' | 'read-only',
    onEvent: (event: Record<string, unknown>) => void,
  ): Promise<ResearchDoneFrame> {
    if (!auth.bearerToken || !auth.governedContext) {
      throw new BadRequestException('Research requires the authenticated conversation context.');
    }
    const researchPlanExecution =
      toolPolicy === 'read-only' ? this.researchPlanExecutionEnvelope(ctx, input, auth) : undefined;
    if (!this.client.configured)
      throw new ServiceUnavailableException('MeriV3 research runtime is not configured.');
    const aiProvider = await this.credentials.resolveProvider(ctx, 'openai');
    if (!aiProvider)
      throw new ServiceUnavailableException(
        'The conversation’s OpenAI provider is not configured.',
      );
    const currentTurnImages = await this.snapshotImages(ctx, input.handoff);
    const inherited =
      toolPolicy === 'read-only' && input.inheritConversationEvidence !== false
        ? await this.conversationEvidence.load(
            ctx,
            input.conversationId ?? input.handoff?.conversationId ?? undefined,
            input.clientId,
            auth.signal,
            input.handoff?.messages,
          )
        : { citations: [], unavailable: 0, omitted: 0 };
    let frame: DoneFrame | undefined;
    let providerFailed = false;
    await this.client.streamChat({
      bearerToken: auth.bearerToken,
      aiProvider,
      impersonateTenantId: auth.impersonateTenantId,
      signal: auth.signal,
      input: {
        // The user prompt already contains the complete immutable snapshot;
        // avoid duplicating history or silently clipping its early constraints.
        messages: [{ role: 'user', text: input.user }],
        clientId: input.clientId ?? undefined,
        conversationId: input.conversationId ?? input.handoff?.conversationId ?? undefined,
        reasoningMode: input.handoff?.reasoningMode ?? 'deep',
        conversationSummary: input.handoff?.summary ?? undefined,
        skillAddendum: [
          input.system,
          ...(toolPolicy === 'read-only' && input.handoff?.attachments.length
            ? [
                `Before using attachment facts, call get_research_evidence with sessionId=${JSON.stringify(input.sessionId)}. ` +
                  'Read subsequent cursors or request the relevant attachmentIds when needed. Cite returned attachment record IDs as [S:get_research_evidence:ID]. ' +
                  'Treat unavailable or truncated attachment content explicitly; do not claim a tool read from the prompt snapshot alone.',
              ]
            : []),
        ].join('\n\n'),
        governedContext: auth.governedContext,
        inheritedDocumentEvidence: inherited.citations,
        ...(inherited.unavailable || inherited.omitted
          ? {
              inheritedEvidenceNotice: `${inherited.unavailable} earlier document observations could not be reauthorized; ${inherited.omitted} were outside the bounded replay. Retrieve missing evidence before using it.`,
            }
          : {}),
        toolPolicy,
        ...(auth.run
          ? {
              researchRun: {
                sessionId: input.sessionId,
                runId: auth.run.id,
                leaseEpoch: auth.run.leaseEpoch,
              },
              ...(toolPolicy === 'read-only' ? { researchPlanExecution } : {}),
            }
          : {}),
        ...(currentTurnImages.length ? { currentTurnImages } : {}),
      },
      onEvent: (event) => {
        if (event.type === 'done') frame = event;
        else if (event.type === 'error') providerFailed = true;
        else {
          const projected = projectResearchObserverEvent(event);
          if (projected) onEvent(projected);
        }
      },
    });
    // A truncated SSE stream is not a completed report. Do not persist streamed
    // partial text or a release-gate refusal as a successful research artifact.
    if (providerFailed) throw new ResearchTerminalError('provider');
    const result = frame as DoneFrame | undefined;
    if (auth.signal?.aborted || result?.aborted) throw new ResearchTerminalError('cancelled');
    if (result?.telemetry?.partial) throw new ResearchTerminalError('partial');
    if (!result?.reply?.trim()) throw new ResearchTerminalError('partial');
    if (result.held)
      throw new BadRequestException(
        'Research could not pass evidence verification. Please review the source gaps and retry.',
      );
    if (toolPolicy === 'read-only' && !Array.isArray(result.ledgerEntries)) {
      throw new ServiceUnavailableException(
        'The research runtime must be upgraded to return its evidence ledger.',
      );
    }
    const ledgerEntries = result.ledgerEntries ?? [];
    const durableTools = ledgerEntries.flatMap((entry) =>
      entry.durableSafeRead ? [entry.durableSafeRead.tool] : [],
    );
    // Re-checkable durable reads (complete, empty or partial) are declared
    // report inputs; any other receipted read the model saw is undeclared.
    const qualifiedDurableExecutionIds = new Set(
      ledgerEntries.flatMap((entry) =>
        entry.durableSafeRead && recheckableDurableStep(result.steps, entry)
          ? [entry.durableSafeRead.executionId]
          : [],
      ),
    );
    const producerInput = classifyResearchProducerInputs({
      hashMaterial: {
        systemSha256: createHash('sha256').update(input.system).digest('hex'),
        userSha256: createHash('sha256').update(input.user).digest('hex'),
        governedContextSha256: createHash('sha256')
          .update(JSON.stringify(auth.governedContext))
          .digest('hex'),
        userPromptTurns:
          input.handoff?.messages.filter((message) => message.role === 'user').length ?? 0,
        assistantHistoryTurns:
          input.handoff?.messages.filter((message) => message.role === 'assistant').length ?? 0,
      },
      durableTools,
      qualifiedDurableExecutionIds,
      clientContext: input.clientContext,
      governedContext: auth.governedContext,
      handoff: input.handoff,
      inherited: {
        citations: inherited.citations.length,
        unavailable: inherited.unavailable,
        omitted: inherited.omitted,
      },
      ledgerEntries,
    });
    return {
      ...result,
      producerInputEvaluated: true,
      ...producerInput,
    };
  }

  private researchPlanExecutionEnvelope(
    ctx: TenantContext,
    input: ResearchRunInput,
    auth: ResearchRuntimeAuth,
  ) {
    if (!auth.run || !input.admittedPlanExecution) {
      throw new BadRequestException('Research requires an admitted plan execution envelope.');
    }
    return createMeriResearchPlanExecutionEnvelope({
      plan: input.admittedPlanExecution.plan,
      allowedReadCapabilities: input.admittedPlanExecution.allowedReadCapabilities,
      scope: {
        sessionId: input.sessionId,
        runId: auth.run.id,
        leaseEpoch: auth.run.leaseEpoch,
        tenantId: ctx.tenantId,
        actorId: ctx.userId,
        clientId: input.clientId,
        conversationId: input.conversationId ?? input.handoff?.conversationId ?? null,
      },
    });
  }

  private async snapshotImages(ctx: TenantContext, handoff: MeriResearchHandoff | null) {
    const images =
      handoff?.attachments.filter((row) => row.kind === 'image' && row.status === 'image_ready') ??
      [];
    if (!images.length) return [];
    const stored = await this.prisma.withTenantUser(ctx.tenantId, ctx.userId, (tx) =>
      tx.clioAttachment.findMany({
        where: {
          id: { in: images.map((image) => image.id) },
          tenantId: ctx.tenantId,
          userId: ctx.userId,
        },
        select: { id: true, data: true, mediaType: true, status: true },
      }),
    );
    return images.map((image) => {
      const row = stored.find((candidate) => candidate.id === image.id);
      if (
        !row?.data ||
        row.status !== 'image_ready' ||
        !row.mediaType ||
        createHash('sha256').update(Buffer.from(row.data)).digest('hex') !== image.contentSha256 ||
        row.mediaType !== image.mediaType
      ) {
        throw new BadRequestException(
          'A research image is unavailable or changed since the handoff. Start a new research request.',
        );
      }
      return { mediaType: row.mediaType, dataBase64: Buffer.from(row.data).toString('base64') };
    });
  }
}

function qualifyResearchChildFrame(frame: ResearchDoneFrame): {
  sources: SourceAttribution[];
  /** Declared for the read-time re-check: every re-checkable durable read. */
  toolsUsed: string[];
  /** Complete or empty reads only: the tools a finding may cite. */
  qualifiedTools: string[];
  ledgerEntries: LedgerEntry[];
} {
  const ledgerEntries = frame.ledgerEntries ?? [];
  const sources: SourceAttribution[] = [];
  const toolsUsed: string[] = [];
  const qualifiedTools: string[] = [];
  for (const entry of ledgerEntries) {
    const durable = entry.durableSafeRead;
    if (!durable || !recheckableDurableStep(frame.steps, entry)) continue;
    toolsUsed.push(durable.tool);
    const matchedStep = qualifiedDurableStep(frame.steps, entry);
    if (!matchedStep) continue;
    sources.push({
      tool: durable.tool,
      label: matchedStep.label,
      summary: `${durable.tool} returned a qualified ${durable.classifier} result.`,
      confidence: 'high',
    });
    qualifiedTools.push(durable.tool);
  }
  return {
    sources,
    toolsUsed: [...new Set(toolsUsed)],
    qualifiedTools: [...new Set(qualifiedTools)],
    ledgerEntries,
  };
}

type ResearchLedgerEntry = NonNullable<DoneFrame['ledgerEntries']>[number];

const QUALIFIED_READ_KINDS: ReadonlySet<string> = new Set(['complete', 'empty']);
const RECHECKABLE_READ_KINDS: ReadonlySet<string> = new Set(['complete', 'empty', 'partial']);

/** A durable read is a report source only when it is also complete or empty. */
function qualifiedDurableStep(
  steps: DoneFrame['steps'],
  entry: ResearchLedgerEntry,
): DoneFrame['steps'][number] | null {
  return recheckableDurableStep(steps, entry, QUALIFIED_READ_KINDS);
}

/**
 * A durable read the read-time re-check covers: its step, receipt and owner
 * classification agree. A partial read qualifies here (Neo, 2026-10-06) so the
 * model never sees a private input the re-check does not cover.
 */
function recheckableDurableStep(
  steps: DoneFrame['steps'],
  entry: ResearchLedgerEntry,
  kinds: ReadonlySet<string> = RECHECKABLE_READ_KINDS,
): DoneFrame['steps'][number] | null {
  const durable = entry.durableSafeRead;
  if (!durable) return null;
  const matchingSteps = steps.filter(
    (step) => step.durableSafeRead?.executionId === durable.executionId,
  );
  const matchedStep = matchingSteps.length === 1 ? matchingSteps[0] : undefined;
  const ownerClassification = classifyApiToolReadOutcome(durable.tool, entry.result);
  if (
    !matchedStep ||
    matchedStep.status !== 'done' ||
    matchedStep.durableSafeRead?.receiptId !== durable.receiptId ||
    matchedStep.durableSafeRead?.tool !== durable.tool ||
    !ownerClassification ||
    !kinds.has(ownerClassification.kind) ||
    ownerClassification.kind !== durable.classifier
  )
    return null;
  return matchedStep;
}
