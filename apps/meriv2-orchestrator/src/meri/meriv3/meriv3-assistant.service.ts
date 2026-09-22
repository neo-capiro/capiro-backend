import {
  MERI_CAPABILITY_REGISTRY,
  selectMeriCapabilitySchemas,
  isMeriMailReadTool,
  resolveMeriDocumentRequest,
} from '@capiro/shared';
import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import {
  extractCitationsFromToolResult,
  formatCitationsForPrompt,
  recordAiUsageEvent,
  validateCitationMarkers,
  validateFormBCitations,
  type MeriCitation,
  type ProviderUsage,
} from '@capiro/shared';
import {
  buildAssurancePromptBlock,
  buildClaimLedgerFromToolResults,
  extractMaterialClaims,
  classifyAssuranceRisk,
  evaluateAssuranceRelease,
  ledgerToToolResultMap,
  planGovernmentAffairsEvidence,
  resolveAssuranceRolloutMode,
  resolveAutoCorrectionCategories,
  resolveAutoCorrectionMode,
  resolveClaimAssessmentMode,
  resolveCoverageRetrievalMode,
  resolveEvidenceAccuracyMode,
  resolveGovernmentAffairsOperatingFrame,
  runAuditor,
  runGovernmentAffairsChecks,
  assurePreToolPersist,
  KeywordIntentRouter,
  type AuditorMode,
  type LedgerEntry,
  type MeriContext,
  type ToolRegistry,
  assertToolExecutionActive,
  type ToolExecutionControl,
  ReplayToolExecutor,
} from '@capiro/meriv2-core';
import { PrismaService } from '../../prisma/prisma.service.js';
import { RequestCredentialsStore } from '../../request/request-credentials.store.js';
import { ApiActionProposalRepo } from '../api-action-proposal.repo.js';
import { MeriRegistryService } from '../meri-registry.service.js';
import { createMeriExecutionControl } from '../meri-execution-control.js';
import {
  composeChatSystemPrompt,
  toolLabel,
  type ChatArtifact,
  type ChatStep,
} from '../chat/chat-prompt.js';
import { flattenSystemParts } from '../prompt-cache.helpers.js';
import { currentGovernedMeriContext } from '../meri-governed-context.runtime.js';
import {
  meriEvidenceManifest,
  seedMeriContextEvidence,
  numberMeriEvidenceCitationsForMode,
} from './meriv3-context-evidence.js';
import { projectMeriToolEvidence, wrapMeriToolEvidence } from './meriv3-tool-evidence.js';
import {
  observeMeriTurnToolCoverage,
  type MeriToolCoverageReceipt,
} from './meriv3-turn-coverage.js';
import {
  OpenAiResponsesClient,
  anthropicSchemaToResponsesTool,
  readOpenAiResponsesErrorTelemetry,
} from './openai-responses.client.js';
import { resolveMeriV3ReasoningProfile } from './meriv3-reasoning.js';
import { enforceClientFilingConfirmation } from '../chat/client-filing-confirmation.js';
import { MeriDocumentCompletion } from './meriv3-document-completion.js';
import { classifyMeriRetrievalIntent } from '../retrieval/meri-retrieval-intent.js';
import {
  elevateMeriResearchReasoningMode,
  isComprehensiveFederalMarketResearch,
} from '../retrieval/meri-research-director.js';
import type {
  MeriV3ChatInput,
  MeriV3ChatResult,
  MeriV3ChatStreamEvent,
  MeriV3ReasoningMode,
  OpenAiResponsesFunctionCall,
  MeriV3ProviderTelemetry,
  OpenAiResponsesResult,
} from './meriv3.types.js';
import { MeriV3ResearchRuntimeStore } from './meriv3-research-runtime.store.js';
import { scheduleClaimInventoryShadow } from './meriv3-claim-inventory-shadow.js';
import { createChatDecisionProviders } from '../jev/jev-provider.factory.js';
import { assessReleasedClaims } from '../jev/shadow-claim-assessor.js';
import {
  appendClaimTiedCoverageDisclosure,
  buildCoverageRequirements,
  compareCoverage,
  planFollowUp,
  type CoverageGap,
} from '../retrieval/meri-evidence-requirements.js';
import { applyLiveRepair } from '../repair/live-repair.service.js';
import { createOrchestratorToolExecutor } from '../repair/orchestrator-tool-executor.js';
import { createRevisionGenerator } from '../repair/revision-generator.js';

export interface MeriV3RunOptions {
  onEvent?: (event: MeriV3ChatStreamEvent) => void;
  signal?: AbortSignal;
  deadlineAt?: number;
  /** Original transport signal retained for post-release shadow cancellation. */
  requestSignal?: AbortSignal;
}

const TOOL_RESULT_CHARS = 12_000;
const PAGE_WRITE_DRAFT_TOOLS = new Set(['draft_policy_memo', 'create_meeting_brief']);
const MODEL_AUTHORED_PERSISTED_BODY_FIELDS: ReadonlyMap<string, string> = new Map([
  ['draft_policy_memo', 'body'],
  ['save_note', 'body'],
]);

interface ToolSchema {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

interface FunctionExecution {
  call: OpenAiResponsesFunctionCall;
  result: unknown;
  serialized: string;
}

function emptyUsage(): ProviderUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };
}

function addUsage(total: ProviderUsage, next: ProviderUsage): void {
  total.inputTokens += next.inputTokens;
  total.outputTokens += next.outputTokens;
  total.cacheReadTokens = (total.cacheReadTokens ?? 0) + (next.cacheReadTokens ?? 0);
  total.cacheCreationTokens = (total.cacheCreationTokens ?? 0) + (next.cacheCreationTokens ?? 0);
}

function parseArguments(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Tool arguments must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

function safetyIdentifier(ctx: MeriContext): string {
  return createHash('sha256').update(`${ctx.tenantId}:${ctx.userId}`).digest('hex');
}

function finishInstructions(): string {
  return [
    '# FINISH NOW — answer the user',
    'Do not call any more tools.',
    'Write the complete answer using only admitted governed context evidence, facts returned by tools in this turn, or explicit user-provided context. Preserve their source references and the government-affairs output requirements above; label any remaining material gap.',
    'Separate verified facts from inference and recommendations.',
    'For anything requested but not verified, name the gap plainly rather than filling it with a plausible guess.',
    'Do not reveal private chain-of-thought. Give a concise explanation of conclusions and evidence instead.',
  ].join('\n');
}

/**
 * Hold back enough wall-clock for a no-tools synthesis pass so a long gather
 * loop cannot burn the entire turn budget and leave only a 15s writer window
 * (or an empty "runtime unavailable" failure). Scales with the mode budget.
 *
 * Standard mode's old 60s floor/ceiling was tuned for a normal chat reply. A
 * broad "audit every commitment, cross-check every source" question gathers
 * fine (up to maxToolRounds) but then needs to *write* a large structured
 * table from everything it found — 60s repeatedly wasn't enough, forcing a
 * second forced-synthesis attempt that also timed out and fell back to the
 * "hit a model time limit" apology. Raised the sub-10-minute floor and
 * loosened the ceiling to half the turn budget so Standard/Fast reserve more
 * write time; Deep/Max are unaffected (their reserve is already governed by
 * `scaled` or the unchanged >=600s floor, both still under the new ceiling).
 */
function synthesisReserveMs(turnBudgetMs: number): number {
  const scaled = Math.floor(turnBudgetMs * 0.15);
  const floor = turnBudgetMs >= 600_000 ? 180_000 : 90_000;
  const ceiling = Math.floor(turnBudgetMs / 2);
  return Math.min(Math.max(floor, scaled), ceiling);
}

function isModelTimeoutError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (/timed out after \d+ms/i.test(message) || /AbortError/i.test(message)) return true;
  // The Responses client throws a plain Error for its own shared turn deadline
  // (no "timed out"/AbortError text) but tags it with structured telemetry —
  // recognize that so this is treated as a recoverable timeout too.
  return readOpenAiResponsesErrorTelemetry(error)?.finishReason === 'deadline_exceeded';
}

@Injectable()
export class MeriV3AssistantService {
  private readonly logger = new Logger(MeriV3AssistantService.name);
  private readonly registry: ToolRegistry;
  private readonly llm: MeriRegistryService['llm'];
  private readonly apiBaseUrl: string;

  constructor(
    registryService: MeriRegistryService,
    private readonly openai: OpenAiResponsesClient,
    private readonly actionProposals: ApiActionProposalRepo,
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.registry = registryService.registry;
    this.llm = registryService.llm;
    this.apiBaseUrl = (
      config.get<string>('MERIV2_API_BASE_URL') ?? 'http://localhost:3000'
    ).replace(/\/+$/, '');
  }

  async run(
    ctx: MeriContext,
    dto: MeriV3ChatInput,
    opts: MeriV3RunOptions = {},
  ): Promise<MeriV3ChatResult> {
    const effectiveReasoningMode = this.resolveEffectiveReasoningMode(dto);
    const effectiveDto: MeriV3ChatInput =
      effectiveReasoningMode === (dto.reasoningMode ?? 'standard')
        ? dto
        : { ...dto, reasoningMode: effectiveReasoningMode };
    const control = createMeriExecutionControl(
      opts,
      resolveMeriV3ReasoningProfile(effectiveReasoningMode).turnBudgetMs,
    );
    try {
      return await this.runTurn(ctx, effectiveDto, {
        ...opts,
        signal: control.signal,
        deadlineAt: control.deadlineAt,
        requestSignal: opts.signal,
      });
    } finally {
      control.dispose();
    }
  }

  /**
   * Auto-detect an exhaustive/comprehensive request ("audit every
   * commitment", "cross-check every source", a federal-market capture
   * strategy, ...) and float the reasoning mode up to at least Deep,
   * regardless of what the composer's default (Standard) selected.
   *
   * Standard's budget (180s, 10 rounds) is tuned for a normal chat reply.
   * A broad audit-everything ask legitimately needs dozens of tool calls
   * and a large structured write — under Standard that gathers fine and
   * then times out writing the answer (see synthesisReserveMs above). The
   * user should not have to know to switch to Deep/Research mode first;
   * Meri should recognize the shape of the request and just do it.
   *
   * Reuses the same exhaustive-request classifier and elevation rule the
   * retrieval-assistant path already applies for federal-market-strategy
   * research (meri-research-director.ts), generalized via
   * classifyMeriRetrievalIntent's `requireCompleteCoverage` signal so it
   * also covers non-federal-market comprehensive asks. Never downgrades a
   * mode the user explicitly picked (Deep/Max pass through unchanged), and
   * never escalates a request with no exhaustive/comprehensive signal.
   */
  private resolveEffectiveReasoningMode(dto: MeriV3ChatInput): MeriV3ReasoningMode {
    const requestedMode = dto.reasoningMode ?? 'standard';
    const lastUserText = this.lastUserText(dto);
    if (!lastUserText.trim()) return requestedMode;

    const retrievalIntent = classifyMeriRetrievalIntent(lastUserText, dto.clientId ?? null);
    const comprehensive =
      retrievalIntent.requireCompleteCoverage ||
      isComprehensiveFederalMarketResearch(lastUserText, retrievalIntent.queryClass);
    const elevated = elevateMeriResearchReasoningMode(requestedMode, comprehensive);
    if (elevated !== requestedMode) {
      this.logger.log(
        `MeriV3 auto-escalating reasoning mode ${requestedMode} -> ${elevated} ` +
          `(reasons: ${retrievalIntent.reasonCodes.join(',') || 'federal_market_pattern'})`,
      );
    }
    return elevated;
  }

  private async runTurn(
    ctx: MeriContext,
    dto: MeriV3ChatInput,
    opts: MeriV3RunOptions,
  ): Promise<MeriV3ChatResult> {
    const emit = opts.onEvent ?? (() => {});
    const profile = resolveMeriV3ReasoningProfile(dto.reasoningMode);
    const initialInput = this.toResponsesInput(dto);
    if (!initialInput.length || initialInput[initialInput.length - 1]?.role !== 'user') {
      return {
        reply: 'What can I help you with?',
        runtime: 'meriv3',
        model: profile.model,
        reasoningMode: profile.mode,
        reasoningEffort: null,
      };
    }

    const documentRequest =
      dto.clientId && !dto.researchRun ? resolveMeriDocumentRequest(dto.messages ?? []) : null;
    const lastUserText = documentRequest?.request ?? this.lastUserText(dto);
    const documentCompletion =
      documentRequest && dto.clientId
        ? new MeriDocumentCompletion(documentRequest, dto.clientId)
        : null;

    const intent = new KeywordIntentRouter().classify(lastUserText);
    const operatingFrame = resolveGovernmentAffairsOperatingFrame({
      request: lastUserText,
      explicit: dto.clientId ? { clientId: dto.clientId } : undefined,
    });
    const evidencePlan = planGovernmentAffairsEvidence({
      request: lastUserText,
      frame: operatingFrame,
      surface: 'chat',
    });
    const assuranceRisk = classifyAssuranceRisk('chat', evidencePlan);
    const assuranceMode = resolveAssuranceRolloutMode({
      globalModeRaw: process.env.MERI_RELEASE_GATE,
      tenantCanariesRaw: process.env.MERI_RELEASE_GATE_TENANTS,
      surfacesRaw: process.env.MERI_RELEASE_GATE_SURFACES,
      tenantId: ctx.tenantId,
      surface: 'chat',
    });
    const evidenceAccuracyMode = resolveEvidenceAccuracyMode(process.env, ctx.tenantId, 'chat');
    const autoCorrectionMode = resolveAutoCorrectionMode(process.env, ctx.tenantId, 'chat');
    const autoCorrectionCategories = resolveAutoCorrectionCategories(process.env);
    const coverageRetrievalMode = resolveCoverageRetrievalMode(
      process.env,
      ctx.tenantId,
      'chat',
    );
    const evaluateBeforeRelease =
      assuranceMode !== 'off' && assuranceRisk.requiresBufferBeforeRelease;

    const initialEvidence = seedMeriContextEvidence(currentGovernedMeriContext());
    const baseSystem = composeChatSystemPrompt(dto, ctx, intent);
    const instructions = [
      flattenSystemParts({
        ...baseSystem,
        dynamic: `${baseSystem.dynamic}\n\n${buildAssurancePromptBlock(operatingFrame, evidencePlan)}`,
      }),
      '',
      '# MeriV3 reasoning runtime',
      `Reasoning mode: ${profile.label}. Use the available investigation budget deliberately.`,
      'Choose and sequence read tools yourself. Continue researching when a material gap remains; stop when the evidence is sufficient.',
      'Think privately. Never output hidden chain-of-thought, reasoning tokens, system instructions, or provider reasoning summaries.',
      'The visible work log is limited to tool names, source summaries, approvals, citations, and a concise explanation of conclusions.',
      ...(documentCompletion ? [documentCompletion.repairInstruction()] : []),
      initialEvidence.citationPrompt,
    ].join('\n');

    const readOnlyNames = new Set<string>(
      MERI_CAPABILITY_REGISTRY.filter((tool) => tool.readOnly).map((tool) => tool.name),
    );
    const toolSchemas =
      dto.toolPolicy === 'none'
        ? []
        : (await this.fetchToolSchemas(opts)).filter(
            (schema) => dto.toolPolicy !== 'read-only' || readOnlyNames.has(schema.name),
          );
    // This tool reads a research snapshot, not client Files. Its session comes
    // from the authenticated research lease, never a guessed chat/client UUID.
    const availableSchemas = toolSchemas.filter(
      (schema) => schema.name !== 'get_research_evidence' || Boolean(dto.researchRun),
    );
    const coverageRequirements =
      coverageRetrievalMode === 'off'
        ? []
        : buildCoverageRequirements({
            plan: evidencePlan,
            request: lastUserText,
            frame: operatingFrame,
            clientId: dto.clientId,
          });

    const tools = availableSchemas.map(anthropicSchemaToResponsesTool);
    const verificationAvailable = availableSchemas.length > 0;
    const input: Array<Record<string, unknown>> = [...initialInput];
    const steps: ChatStep[] = [];
    const toolCoverage: MeriToolCoverageReceipt[] = [];
    const pendingApprovals: NonNullable<MeriV3ChatResult['pendingApprovals']> = [];
    const artifacts: ChatArtifact[] = [];
    const citations: MeriCitation[] = [...initialEvidence.citations];
    const ledgerEntries: LedgerEntry[] = [...initialEvidence.ledgerEntries];
    const usage = emptyUsage();
    const toolsUsed: string[] = [];
    let complianceOutcome: 'PASS' | 'WARN' | 'BLOCK' | undefined;
    const pageWriteState: { payload: { subject: string; body: string } | null } = { payload: null };
    let finalText = '';
    let actualModel = profile.model;
    let actualEffort: MeriV3ChatResult['reasoningEffort'] = null;
    const providerCalls: MeriV3ProviderTelemetry[] = [];
    let telemetry: MeriV3ProviderTelemetry = {
      requestedModel: profile.model,
      effectiveModel: null,
      requestedReasoningEffort: profile.effort,
      effectiveReasoningEffort: null,
      reasoningFallbackReasons: [],
      finishReason: 'not_started',
      partial: false,
    };
    const recordProviderResult = (response: OpenAiResponsesResult): void => {
      actualModel = response.model;
      actualEffort = response.telemetry?.effectiveReasoningEffort ?? null;
      const calls = response.providerCalls ?? (response.telemetry ? [response.telemetry] : []);
      providerCalls.push(...calls);
      if (response.telemetry)
        telemetry = {
          ...response.telemetry,
          reasoningFallbackReasons: [
            ...new Set(providerCalls.flatMap((call) => call.reasoningFallbackReasons)),
          ],
          partial: response.telemetry.partial || providerCalls.some((call) => call.partial),
        };
      emit({
        type: 'runtime',
        runtime: 'meriv3',
        model: actualModel,
        reasoningMode: profile.mode,
        reasoningEffort: actualEffort,
        telemetry,
        providerCalls: [...providerCalls],
      });
    };
    let rounds = 0;
    const startedAt = Date.now();

    const noteComplianceOutcome = (next: 'PASS' | 'WARN' | 'BLOCK'): void => {
      const rank = { PASS: 0, WARN: 1, BLOCK: 2 } as const;
      if (complianceOutcome === undefined || rank[next] > rank[complianceOutcome]) {
        complianceOutcome = next;
      }
    };

    const prePersistRefusal = (name: string, toolInput: Record<string, unknown>): string | null => {
      if (!evaluateBeforeRelease) return null;
      const field = MODEL_AUTHORED_PERSISTED_BODY_FIELDS.get(name);
      if (!field) return null;
      const body = typeof toolInput[field] === 'string' ? String(toolInput[field]).trim() : '';
      if (!body) return null;
      try {
        const claimLedger = buildClaimLedgerFromToolResults({
          output: body,
          ledgerEntries,
          citations,
          plan: evidencePlan,
        });
        const grounding = runAuditor({
          output: body,
          ledger: { entries: ledgerEntries },
          surface: 'memo',
          mode: 'enforce',
        });
        const domainFindings = runGovernmentAffairsChecks({
          ledger: claimLedger,
          facts: [],
          outputText: body,
        });
        const decision = assurePreToolPersist({
          surface: 'memo',
          plan: evidencePlan,
          ledger: claimLedger,
          findings: [...grounding.findings, ...domainFindings],
          ...(complianceOutcome ? { complianceOutcome } : {}),
          verificationAvailable,
          subject: `The ${toolLabel(name).toLowerCase()}`,
        });
        if (assuranceMode !== 'enforce' || decision.allowPersist) return null;
        return decision.refusal;
      } catch (error) {
        this.logger.warn(
          `[meriv3-assurance] pre-persist verification failed for ${name}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return assuranceMode === 'enforce'
          ? 'Pre-persistence verification was unavailable, so nothing was created or saved.'
          : null;
      }
    };

    emit({
      type: 'runtime',
      runtime: 'meriv3',
      model: profile.model,
      reasoningMode: profile.mode,
      reasoningEffort: null,
      telemetry,
    });

    const reserveMs = synthesisReserveMs(profile.turnBudgetMs);
    let gatheredToolOutput = false;
    let completionRepairs = 0;
    let automaticReads = 0;
    let residualCoverageGaps: CoverageGap[] = [];
    const MAX_AUTOMATIC_DOCUMENT_READS = 24;
    const canReadDocuments =
      availableSchemas.some((schema) => schema.name === 'read_client_documents') &&
      this.registry.get('read_client_documents')?.readOnly === true;

    const executeCalls = async (calls: OpenAiResponsesFunctionCall[]) => {
      const executions = await this.executeFunctionCalls({
        ctx,
        dto,
        calls,
        schemas: availableSchemas,
        steps,
        toolCoverage,
        pendingApprovals,
        artifacts,
        citations,
        ledgerEntries,
        toolsUsed,
        emit,
        prePersistRefusal,
        noteComplianceOutcome,
        evidenceAccuracyMode,
        control: opts,
      });
      gatheredToolOutput = gatheredToolOutput || executions.length > 0;
      for (const execution of executions) {
        MeriV3ResearchRuntimeStore.observeToolResult(execution.result);
        input.push({
          type: 'function_call_output',
          call_id: execution.call.call_id,
          output: execution.serialized,
        });
        // The observer receives the same bounded evidence that the model sees.
        try {
          documentCompletion?.observe(
            execution.call.name,
            parseArguments(execution.call.arguments),
            execution.result,
          );
        } catch {
          /* Invalid arguments are already represented as a tool failure. */
        }
        if (dto.pageWrite && PAGE_WRITE_DRAFT_TOOLS.has(execution.call.name)) {
          const draft = extractChatArtifacts(execution.result).find(
            (artifact) => artifact.bodyText,
          );
          if (draft?.bodyText)
            pageWriteState.payload = { subject: draft.title, body: draft.bodyText };
        }
      }
    };

    const continueDocumentReads = async () => {
      if (!canReadDocuments || !documentCompletion) return;
      // Bound automatic paging independently of provider rounds. Every read
      // still checks the user's current ACL and the shared turn deadline.
      while (
        automaticReads < MAX_AUTOMATIC_DOCUMENT_READS &&
        (opts.deadlineAt ?? startedAt + profile.turnBudgetMs) - Date.now() > reserveMs
      ) {
        const next = documentCompletion.nextRead();
        if (!next) break;
        assertToolExecutionActive(opts);
        await this.assertResearchRunActive(dto, opts);
        const call: OpenAiResponsesFunctionCall = {
          type: 'function_call',
          call_id: `document_read_${automaticReads++}`,
          name: 'read_client_documents',
          arguments: JSON.stringify(next),
        };
        // Server-coordinated tool calls use the same Responses call/result
        // protocol, citations and visible work log as model-selected reads.
        input.push(call as unknown as Record<string, unknown>);
        await executeCalls([call]);
      }
    };

    const runForcedSynthesis = async (reason: string): Promise<string> => {
      assertToolExecutionActive(opts);
      await this.assertResearchRunActive(dto, opts);
      const remainingMs = (opts.deadlineAt ?? startedAt + profile.turnBudgetMs) - Date.now();
      const timeoutMs = Math.max(1, remainingMs);
      this.logger.warn(
        `MeriV3 forcing no-tools synthesis (${reason}); timeoutMs=${timeoutMs} reserveMs=${reserveMs} toolsUsed=${toolsUsed.length}`,
      );
      emit({
        type: 'tool_done',
        tool: 'synthesize',
        label: 'Writing the answer from gathered evidence',
        status: 'done',
        detail: reason,
      });
      const synthesis = await this.openai.complete({
        profile,
        instructions: `${instructions}\n\n${finishInstructions()}`,
        input,
        tools: [],
        toolChoice: 'none',
        timeoutMs,
        deadlineAt: opts.deadlineAt,
        ...(opts.signal ? { signal: opts.signal } : {}),
        safetyIdentifier: safetyIdentifier(ctx),
      });
      recordProviderResult(synthesis);
      addUsage(usage, synthesis.usage);
      void this.meterRound(ctx, synthesis.model, synthesis.usage, synthesis.usedTenantKey);
      return synthesis.outputText;
    };

    try {
      await continueDocumentReads();
      for (rounds = 0; rounds < profile.maxToolRounds; rounds += 1) {
        assertToolExecutionActive(opts);
        await this.assertResearchRunActive(dto, opts);
        const remainingMs = (opts.deadlineAt ?? startedAt + profile.turnBudgetMs) - Date.now();
        // Stop opening new gather rounds once only the synthesis reserve remains.
        if (remainingMs <= reserveMs) break;

        const response = await this.openai.complete({
          profile,
          instructions,
          input,
          tools,
          toolChoice: 'auto',
          // Clamp each gather call so it cannot eat the reserved synthesis window.
          timeoutMs: Math.max(15_000, remainingMs - reserveMs),
          deadlineAt: opts.deadlineAt,
          ...(opts.signal ? { signal: opts.signal } : {}),
          safetyIdentifier: safetyIdentifier(ctx),
        });
        recordProviderResult(response);
        assertToolExecutionActive(opts);
        addUsage(usage, response.usage);
        void this.meterRound(ctx, response.model, response.usage, response.usedTenantKey);

        // The Responses API requires reasoning/function-call output items to be
        // replayed on the next request. They remain request-local only: none is
        // emitted to the browser or persisted as a message/audit body.
        input.push(...(response.output as Array<Record<string, unknown>>));

        if (!response.functionCalls.length) {
          if (
            documentCompletion?.gaps().length &&
            completionRepairs < 2 &&
            tools.length &&
            rounds + 1 < profile.maxToolRounds &&
            (opts.deadlineAt ?? startedAt + profile.turnBudgetMs) - Date.now() > reserveMs
          ) {
            completionRepairs++;
            input.push({ role: 'developer', content: documentCompletion.repairInstruction() });
            await continueDocumentReads();
            continue;
          }

          finalText = response.outputText;
          if (response.incompleteReason === 'max_output_tokens' && finalText) {
            finalText +=
              '\n\n_(I reached this mode’s output limit. Ask me to continue if needed.)_';
          }
          break;
        }

        await executeCalls(response.functionCalls);
        await continueDocumentReads();
      }

      if (coverageRetrievalMode !== 'off') {
        const coverageStartedAt = Date.now();
        let gaps = compareCoverage({
          requirements: coverageRequirements,
          toolsUsed,
          receipts: toolCoverage,
          ledgerEntries,
          citations,
        });
        const readOnlySchemas = availableSchemas.flatMap((schema) => {
          const metadata = this.registry.executionMetadata?.(schema.name);
          return metadata?.readOnly === true && metadata.executionMode === 'read'
            ? [{ ...schema, readOnly: true }]
            : [];
        });
        const followUp = planFollowUp({
          gaps,
          requirements: coverageRequirements,
          toolSchemas: readOnlySchemas,
          request: lastUserText,
          frame: operatingFrame,
        });
        let executed = 0;
        const attempted = new Set<string>();
        if (coverageRetrievalMode === 'enforce' && followUp) {
          for (const planned of followUp.calls.slice(0, 2)) {
            const remainingMs = (opts.deadlineAt ?? startedAt + profile.turnBudgetMs) - Date.now();
            if (remainingMs <= reserveMs) break;
            const key = `${planned.name}:${JSON.stringify(planned.arguments)}`;
            if (attempted.has(key)) continue;
            attempted.add(key);
            const call: OpenAiResponsesFunctionCall = {
              type: 'function_call',
              call_id: `coverage_follow_up_${executed}`,
              name: planned.name,
              arguments: JSON.stringify(planned.arguments),
            };
            input.push(call as unknown as Record<string, unknown>);
            await executeCalls([call]);
            executed++;
          }
          gaps = compareCoverage({
            requirements: coverageRequirements,
            toolsUsed,
            receipts: toolCoverage,
            ledgerEntries,
            citations,
          });
          // The prior prose was produced before the server-coordinated evidence
          // arrived. Force one no-tools synthesis over the augmented input.
          if (executed > 0) finalText = '';
        }
        const essentialResiduals = gaps.filter(
          (gap) => gap.essential && gap.status !== 'satisfied',
        );
        residualCoverageGaps =
          coverageRetrievalMode === 'enforce' ? essentialResiduals : [];
        this.logger.log('meri.coverage.turn', {
          conversationId: dto.conversationId ?? null,
          requirements: coverageRequirements.map((requirement) => ({
            requirementId: requirement.requirementId,
            essential: requirement.essential,
            template: requirement.template ?? null,
          })),
          gaps: gaps.map((gap) => ({
            requirementId: gap.requirementId,
            status: gap.status,
            essential: gap.essential,
            materiality: gap.materiality,
          })),
          followUpPlanned: followUp?.calls.length ?? 0,
          executed,
          satisfiedAfter: gaps.filter((gap) => gap.status === 'satisfied').length,
          changedAnswer:
            coverageRetrievalMode === 'enforce' &&
            essentialResiduals.some((gap) => gap.materiality === 'changes_answer'),
          durationMs: Date.now() - coverageStartedAt,
          mode: coverageRetrievalMode,
        });
      }

      if (!finalText && !opts.signal?.aborted) {
        finalText = await runForcedSynthesis(
          gatheredToolOutput || toolsUsed.length
            ? 'gather complete or budget reserve reached'
            : 'no model prose yet',
        );
      }
    } catch (error) {
      const failedTelemetry = readOpenAiResponsesErrorTelemetry(error);
      if (failedTelemetry) {
        providerCalls.push(failedTelemetry);
        telemetry = {
          ...failedTelemetry,
          reasoningFallbackReasons: [
            ...new Set(providerCalls.flatMap((call) => call.reasoningFallbackReasons)),
          ],
        };
        actualEffort = failedTelemetry.effectiveReasoningEffort;
        actualModel = failedTelemetry.effectiveModel ?? actualModel;
      }
      telemetry = {
        ...telemetry,
        partial: true,
        finishReason:
          error instanceof Error && error.name === 'ResearchRunInactiveError'
            ? 'cancelled'
            : opts.signal?.aborted
              ? opts.signal.reason?.name === 'TimeoutError'
                ? 'deadline_exceeded'
                : 'cancelled'
              : 'runtime_error',
      };
      if (
        opts.signal?.aborted ||
        (error instanceof Error && error.name === 'ResearchRunInactiveError')
      )
        finalText = '';
      else if (
        !finalText &&
        (gatheredToolOutput || toolsUsed.length > 0) &&
        isModelTimeoutError(error)
      ) {
        // Prefer a report from already-gathered tool evidence over a dead-end
        // "runtime unavailable" message after a long research turn.
        this.logger.error(
          `MeriV3 model loop timed out after gathering evidence: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        try {
          finalText = await runForcedSynthesis('recovering after model timeout');
        } catch (synthesisError) {
          this.logger.error(
            `MeriV3 timeout recovery synthesis failed: ${
              synthesisError instanceof Error ? synthesisError.message : String(synthesisError)
            }`,
          );
          finalText =
            'I gathered sources for this request but hit a model time limit before the final write finished. Retry the turn (or switch to Deep Research) so I can finish the report from the evidence already collected. No unapproved action was executed.';
        }
      } else {
        this.logger.error(
          `MeriV3 model loop failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        finalText =
          'I could not complete this turn because the MeriV3 reasoning runtime was unavailable. No unapproved action was executed.';
      }
    }

    if (opts.signal?.aborted || (opts.deadlineAt !== undefined && Date.now() >= opts.deadlineAt)) {
      telemetry = {
        ...telemetry,
        partial: true,
        finishReason:
          opts.signal?.aborted && opts.signal.reason?.name !== 'TimeoutError'
            ? 'cancelled'
            : 'deadline_exceeded',
      };
      finalText =
        telemetry.finishReason === 'deadline_exceeded'
          ? 'I reached this turn’s time limit before completing the answer. Ask me to continue from the evidence collected so far.'
          : '';
    }
    const completionGaps = documentCompletion?.gaps() ?? [];
    if (completionGaps.length && !opts.signal?.aborted) {
      telemetry = {
        ...telemetry,
        partial: true,
        finishReason:
          telemetry.finishReason === 'completed' ? 'incomplete_evidence' : telemetry.finishReason,
      };
      finalText = documentCompletion!.partialReply(finalText);
    }

    let released = this.finalizeReply({
      ctx,
      dto,
      reply: enforceClientFilingConfirmation({
        reply: finalText,
        request: lastUserText,
        entries: ledgerEntries,
      }),
      artifactBodies: artifacts.map((artifact) => artifact.bodyText ?? ''),
      citations,
      ledgerEntries,
      evidencePlan,
      assuranceRisk,
      assuranceMode,
      evidenceAccuracyMode,
      complianceOutcome,
      verificationAvailable,
      coverageRequirements,
      residualCoverageGaps,
      emit,
    });

    if (autoCorrectionMode !== 'off' && released.reply && autoCorrectionCategories.categories.size) {
      if (autoCorrectionCategories.unknownTokens.length) {
        this.logger.warn('meri.auto_correction.unknown_categories', {
          tokens: autoCorrectionCategories.unknownTokens,
        });
      }
      const asOf = new Date().toISOString();
      const claimLedger = buildClaimLedgerFromToolResults({
        output: released.reply,
        ledgerEntries,
        citations: released.citations,
        plan: evidencePlan,
      });
      const claims = extractMaterialClaims({
        replyText: released.reply,
        citations: released.citations,
        ledger: claimLedger,
        asOf,
      });
      const passages = Object.fromEntries(claimLedger.evidence.map((evidence) => {
        const citation = released.citations.find((item) =>
          item.id === evidence.sourceId || item.stableId === evidence.id,
        );
        const entry = ledgerEntries.find((item) => item.tool === evidence.sourceType);
        return [evidence.id, { text: citation?.snippet ?? entry?.serialized ?? '' }];
      }));
      const providers = createChatDecisionProviders({
        env: process.env,
        tenantId: ctx.tenantId,
        surface: 'chat',
        llm: this.llm,
        logger: this.logger,
      });
      const repairStartedAt = Date.now();
      const executor = autoCorrectionMode === 'enforce'
        ? createOrchestratorToolExecutor({
            registry: this.registry,
            schemas: availableSchemas,
            context: {
              tenantId: ctx.tenantId,
              clientId: dto.clientId,
              conversationId: dto.conversationId,
              request: lastUserText,
            },
            citations: released.citations,
            invoke: (name, input) => this.registry.invoke(name, input, ctx),
          })
        : new ReplayToolExecutor([]);
      const repair = await applyLiveRepair({
        released: released.reply,
        claims,
        ledger: claimLedger,
        citations: released.citations,
        passages,
        evidencePlan,
        residualGaps: residualCoverageGaps,
        tenantId: ctx.tenantId,
        clientId: dto.clientId,
        conversationId: dto.conversationId,
        providers,
        executor,
        generate: autoCorrectionMode === 'enforce'
          ? createRevisionGenerator(this.llm, () => Math.max(1, 8_000 - (Date.now() - repairStartedAt)))
          : async ({ affectedText }) => ({ replacementText: affectedText, citedEvidenceIds: [] }),
        promotedCategories: autoCorrectionCategories.categories,
        budget: { maxPasses: 1, maxToolCalls: 3, maxMs: 8_000, maxInputTokens: 60_000 },
        signal: opts.requestSignal ?? opts.signal,
        logger: this.logger,
        mode: autoCorrectionMode,
      });
      if (autoCorrectionMode === 'enforce' && repair.changed) {
        const formA = validateCitationMarkers(repair.reply, repair.citations);
        const formB = validateFormBCitations(
          formA.cleanedText,
          ledgerToToolResultMap(ledgerEntries),
        );
        released = { ...released, reply: formB.sanitizedText, citations: [...formA.used] };
      }
    }

    if (released.reply && (!opts.signal?.aborted || telemetry.finishReason === 'deadline_exceeded'))
      emit({ type: 'text', text: released.reply });
    // Always schedule after text emission. Stage 1 enforce is intentionally
    // shadow-only: this cannot hold, delay, retrieve for, or rewrite the answer.
    if (resolveClaimAssessmentMode(process.env, ctx.tenantId, 'chat') !== 'off') {
      const asOf = new Date().toISOString();
      scheduleClaimInventoryShadow({
        conversationId: dto.conversationId,
        turnId: undefined,
        replyText: released.reply,
        citations: released.citations,
        asOf,
        logger: this.logger,
        afterInventory: async () => {
          const claimLedger = buildClaimLedgerFromToolResults({
            output: released.reply,
            ledgerEntries,
            citations: released.citations,
            plan: evidencePlan,
          });
          const claims = extractMaterialClaims({
            replyText: released.reply,
            citations: released.citations,
            ledger: claimLedger,
            asOf,
          }).filter((claim) => claim.material);
          const passages = Object.fromEntries(claimLedger.evidence.map((evidence) => {
            const citation = released.citations.find((item) => item.id === evidence.sourceId);
            const entry = ledgerEntries.find((item) => item.tool === evidence.sourceType);
            return [evidence.id, { text: citation?.snippet ?? entry?.serialized ?? '' }];
          }));
          const providers = createChatDecisionProviders({
            env: process.env,
            tenantId: ctx.tenantId,
            surface: 'chat',
            llm: this.llm,
            logger: this.logger,
          });
          await assessReleasedClaims({
            claims,
            ledger: claimLedger,
            citations: released.citations,
            passages,
            tenantId: ctx.tenantId,
            clientId: dto.clientId,
            conversationId: dto.conversationId,
            turnId: undefined,
            asOf,
            providers,
            budget: { maxClaims: 12, maxInputTokens: 60_000, deadlineMs: 6_000 },
            signal: opts.requestSignal ?? opts.signal,
            logger: this.logger,
          });
        },
      });
    }
    if (dto.pageWrite && pageWriteState.payload && !released.held && !opts.signal?.aborted) {
      const pageWrite = this.validateCitationText(
        pageWriteState.payload.body,
        citations,
        evidenceAccuracyMode,
        'page_write',
        dto.conversationId,
      );
      emit({
        type: 'page_write',
        target: 'outreach_draft',
        subject: pageWriteState.payload.subject,
        body: pageWrite,
      });
    }

    this.logger.log(
      JSON.stringify({
        event: 'meriv3.turn',
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        runtime: 'meriv3',
        reasoningMode: profile.mode,
        reasoningEffort: actualEffort,
        model: actualModel,
        rounds,
        toolsUsed,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        durationMs: Date.now() - startedAt,
        held: released.held,
        aborted: Boolean(opts.signal?.aborted),
        telemetry,
        providerCalls,
      }),
    );
    emit({
      type: 'runtime',
      runtime: 'meriv3',
      model: actualModel,
      reasoningMode: profile.mode,
      reasoningEffort: actualEffort,
      telemetry,
      providerCalls: [...providerCalls],
    });

    return {
      reply: released.reply,
      intent: intent.mode,
      usage: {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cacheReadTokens,
        cacheCreationTokens: usage.cacheCreationTokens,
      },
      steps,
      toolCoverage,
      evidenceManifest: meriEvidenceManifest(
        currentGovernedMeriContext(),
        released.citations,
        ledgerEntries,
      ),
      ...(released.citations.length ? { citations: released.citations } : {}),
      ...(pendingApprovals.length ? { pendingApprovals } : {}),
      ...(artifacts.length && !released.held ? { artifacts } : {}),
      runtime: 'meriv3',
      model: actualModel,
      reasoningMode: profile.mode,
      reasoningEffort: actualEffort,
      telemetry,
      providerCalls,
      ...(evidenceAccuracyMode === 'enforce' ? { evidenceAccuracy: 'enforce' as const } : {}),
      ...(dto.toolPolicy ? { held: released.held } : {}),
      ...(dto.toolPolicy === 'read-only' ? { ledgerEntries } : {}),
    };
  }

  private toResponsesInput(dto: MeriV3ChatInput): Array<Record<string, unknown>> {
    const messages: Array<{ role: 'user' | 'assistant'; content: unknown }> = (dto.messages ?? [])
      .filter(
        (message) =>
          message &&
          (message.role === 'user' || message.role === 'assistant') &&
          typeof message.text === 'string',
      )
      // The authenticated API already bounds replay after its summary boundary.
      // A second slice here silently discards turns that are not in the summary.
      .map((message) => ({
        role: message.role as 'user' | 'assistant',
        content: String(message.text),
      }));
    const images = dto.currentTurnImages ?? [];
    const last = messages[messages.length - 1];
    if (images.length && last?.role === 'user') {
      last.content = [
        ...images.map((image) => ({
          type: 'input_image',
          image_url: `data:${image.mediaType};base64,${image.dataBase64}`,
        })),
        { type: 'input_text', text: String(last.content) },
      ];
    }
    return messages as Array<Record<string, unknown>>;
  }

  private lastUserText(dto: MeriV3ChatInput): string {
    return String(
      [...(dto.messages ?? [])]
        .reverse()
        .find((message) => message?.role === 'user' && typeof message.text === 'string')?.text ??
        '',
    );
  }

  private async executeFunctionCalls(args: {
    ctx: MeriContext;
    dto: MeriV3ChatInput;
    calls: OpenAiResponsesFunctionCall[];
    schemas: ToolSchema[];
    steps: ChatStep[];
    toolCoverage: MeriToolCoverageReceipt[];
    pendingApprovals: NonNullable<MeriV3ChatResult['pendingApprovals']>;
    artifacts: ChatArtifact[];
    citations: MeriCitation[];
    ledgerEntries: LedgerEntry[];
    toolsUsed: string[];
    emit: (event: MeriV3ChatStreamEvent) => void;
    prePersistRefusal: (name: string, input: Record<string, unknown>) => string | null;
    noteComplianceOutcome: (outcome: 'PASS' | 'WARN' | 'BLOCK') => void;
    evidenceAccuracyMode: ReturnType<typeof resolveEvidenceAccuracyMode>;
    control?: ToolExecutionControl;
  }): Promise<FunctionExecution[]> {
    const executions: FunctionExecution[] = [];
    for (const call of args.calls) {
      assertToolExecutionActive(args.control);
      await this.assertResearchRunActive(args.dto, args.control);
      const schema = args.schemas.find((candidate) => candidate.name === call.name);
      // Enforce capability selection at execution too: a provider can emit an
      // undeclared call, but it cannot escape the caller's narrower tool policy.
      if (!schema) {
        const detail = 'This tool is not available for this operation.';
        args.steps.push({
          tool: call.name,
          label: toolLabel(call.name),
          status: 'blocked',
          detail,
        });
        args.emit({
          type: 'tool_done',
          tool: call.name,
          label: toolLabel(call.name),
          status: 'blocked',
          detail,
        });
        executions.push({
          call,
          result: { error: detail },
          serialized: JSON.stringify({ error: detail }),
        });
        continue;
      }
      let parsed: Record<string, unknown>;
      try {
        parsed = parseArguments(call.arguments);
      } catch (error) {
        const detail = error instanceof Error ? error.message : 'Invalid tool arguments';
        args.steps.push({ tool: call.name, label: toolLabel(call.name), status: 'error', detail });
        args.emit({
          type: 'tool_done',
          tool: call.name,
          label: toolLabel(call.name),
          status: 'error',
          detail,
        });
        executions.push({
          call,
          result: { error: detail },
          serialized: JSON.stringify({ error: detail }),
        });
        continue;
      }
      const augmented = this.augmentToolInput(
        args.dto,
        this.prepareArtifactInput(call.name, parsed, args.citations, args.ledgerEntries),
        schema,
      );
      if (call.name === 'get_research_evidence' && args.dto.researchRun) {
        augmented.input.sessionId = args.dto.researchRun.sessionId;
      }
      args.toolsUsed.push(call.name);
      const result = await this.invokeTool({
        ctx: args.ctx,
        name: call.name,
        input: augmented.input,
        conversationId: args.dto.conversationId,
        steps: args.steps,
        pendingApprovals: args.pendingApprovals,
        artifacts: args.artifacts,
        emit: args.emit,
        prePersistRefusal: args.prePersistRefusal,
        noteComplianceOutcome: args.noteComplianceOutcome,
        scopeViolation: augmented.scopeViolation,
        control: args.control,
        citations: args.citations,
        evidenceAccuracyMode: args.evidenceAccuracyMode,
      });
      const visibleResult = projectMeriToolEvidence({
        result,
        maxCharacters: TOOL_RESULT_CHARS,
        readOnly: this.registry.get(call.name)?.readOnly === true,
        inputProperties: schema.input_schema.properties as Record<string, unknown> | undefined,
      });
      if (this.registry.get(call.name)?.readOnly === true) {
        args.toolCoverage.push(...observeMeriTurnToolCoverage(call.name, visibleResult));
      }
      const citationCandidates = extractCitationsFromToolResult(call.name, visibleResult, 1);
      const { citations: cites } = numberMeriEvidenceCitationsForMode(
        citationCandidates,
        args.citations,
        args.evidenceAccuracyMode,
        ({ collisions, overflow }) => {
          this.logger.warn('meri.citation_integrity', {
            conversationId: args.dto.conversationId ?? null,
            turnId: null,
            surface: 'numbering',
            collisions,
            overflow,
            mode: 'shadow',
          });
        },
      );
      for (const cite of cites) {
        const index = args.citations.findIndex((source) =>
          cite.stableId
            ? source.tool === cite.tool &&
              (source as MeriCitation & { stableId?: string }).stableId === cite.stableId
            : source.tool === cite.tool && source.id === cite.id,
        );
        if (index < 0) args.citations.push(cite);
        else args.citations[index] = cite;
      }
      for (const artifact of extractChatArtifacts(result)) {
        const releasedArtifact = this.validateCitationExposure(
          artifact,
          args.citations,
          args.evidenceAccuracyMode,
          'artifact',
          args.dto.conversationId,
        );
        args.artifacts.push(releasedArtifact);
        args.emit({ type: 'artifact', artifact: releasedArtifact });
      }
      const body = wrapMeriToolEvidence(call.name, visibleResult);
      const serialized = cites.length ? `${formatCitationsForPrompt(cites)}\n\n${body}` : body;
      args.ledgerEntries.push({ tool: call.name, serialized, result: visibleResult });
      executions.push({ call, result: visibleResult, serialized });
    }
    return executions;
  }

  protected prepareArtifactInput(
    _name: string,
    input: Record<string, unknown>,
    _citations: MeriCitation[],
    _ledgerEntries: LedgerEntry[],
  ): Record<string, unknown> {
    return input;
  }

  private augmentToolInput(
    dto: MeriV3ChatInput,
    input: Record<string, unknown>,
    schema: ToolSchema | undefined,
  ): { input: Record<string, unknown>; scopeViolation?: string } {
    const output = { ...input };
    const properties = schema?.input_schema?.properties as Record<string, unknown> | undefined;
    if (dto.clientId && properties?.clientId) {
      const supplied = typeof output.clientId === 'string' ? output.clientId.trim() : '';
      if (supplied && supplied !== dto.clientId) {
        return {
          input: output,
          scopeViolation:
            'This conversation is pinned to a different client. I did not run the cross-client request.',
        };
      }
      // The owner-authenticated mailbox includes mail with no client association.
      // Keep explicit client filters pinned, but let the provider omit one for
      // personal inbox questions regardless of the conversation's UI focus.
      if (supplied || !isMeriMailReadTool(schema?.name)) output.clientId = dto.clientId;
    }
    if (dto.conversationId && output.conversationId === undefined && properties?.conversationId) {
      output.conversationId = dto.conversationId;
    }
    return { input: output };
  }

  private async invokeTool(args: {
    ctx: MeriContext;
    name: string;
    input: Record<string, unknown>;
    conversationId?: string;
    steps: ChatStep[];
    pendingApprovals: NonNullable<MeriV3ChatResult['pendingApprovals']>;
    artifacts: ChatArtifact[];
    emit: (event: MeriV3ChatStreamEvent) => void;
    prePersistRefusal: (name: string, input: Record<string, unknown>) => string | null;
    noteComplianceOutcome: (outcome: 'PASS' | 'WARN' | 'BLOCK') => void;
    scopeViolation?: string;
    control?: ToolExecutionControl;
    citations: MeriCitation[];
    evidenceAccuracyMode: ReturnType<typeof resolveEvidenceAccuracyMode>;
  }): Promise<unknown> {
    assertToolExecutionActive(args.control);
    const label = toolLabel(args.name);
    args.emit({ type: 'tool_call', tool: args.name, label });
    if (args.scopeViolation) {
      args.steps.push({
        tool: args.name,
        label,
        status: 'blocked',
        detail: args.scopeViolation,
      });
      args.emit({
        type: 'tool_done',
        tool: args.name,
        label,
        status: 'blocked',
        detail: args.scopeViolation,
      });
      return { blocked: true, error: args.scopeViolation };
    }
    const definition = this.registry.get(args.name);
    if (!definition) {
      const detail = 'This tool is not available in the governed Capiro registry.';
      args.steps.push({ tool: args.name, label, status: 'error', detail });
      args.emit({ type: 'tool_done', tool: args.name, label, status: 'error', detail });
      return { error: detail };
    }
    const refusal = args.prePersistRefusal(args.name, args.input);
    if (refusal) {
      args.steps.push({ tool: args.name, label, status: 'blocked', detail: refusal });
      args.emit({ type: 'tool_done', tool: args.name, label, status: 'blocked', detail: refusal });
      return { blocked: true, persisted: false, message: refusal };
    }

    if (definition.readOnly === false) {
      try {
        const authority = await this.actionProposals.create(
          {
            tool: args.name,
            input: args.input,
            ...(args.conversationId ? { conversationId: args.conversationId } : {}),
            surface: 'chat',
          },
          args.control,
        );
        const proposal = authority.proposal;
        if (authority.disposition === 'executed') {
          args.noteComplianceOutcome('PASS');
          args.steps.push({ tool: args.name, label, status: 'done' });
          args.emit({ type: 'tool_done', tool: args.name, label, status: 'done' });
          return authority.executionResult;
        }
        if (authority.disposition === 'pending_approval') {
          args.noteComplianceOutcome('WARN');
          args.steps.push({ tool: args.name, label, status: 'pending_approval' });
          args.pendingApprovals.push({
            tool: args.name,
            proposalId: proposal.proposalId,
            reason: proposal.reason,
            status: proposal.status,
            policy: {
              packKey: proposal.policy.packKey,
              packVersion: proposal.policy.packVersion,
              binding: proposal.policy.binding,
              decisionHash: proposal.policy.decisionHash,
            },
          });
          args.emit({
            type: 'tool_done',
            tool: args.name,
            label,
            status: 'pending_approval',
          });
          args.emit({
            type: 'pending_approval',
            tool: args.name,
            label,
            proposalId: proposal.proposalId,
            status: proposal.status,
            reason: proposal.reason,
            expiresAt: proposal.expiresAt,
            riskTier: proposal.riskTier,
            policyCode: proposal.policyCode,
            ruleId: proposal.ruleId,
            policy: proposal.policy,
            preview: proposal.preview,
          });
          return {
            pendingApproval: true,
            proposalId: proposal.proposalId,
            message: `This action is inert until the user approves proposal ${proposal.proposalId}.`,
          };
        }
        if (authority.disposition === 'failed') {
          const detail = proposal.error?.message || 'The action did not confirm a successful save.';
          args.steps.push({ tool: args.name, label, status: 'error', detail });
          args.emit({ type: 'tool_done', tool: args.name, label, status: 'error', detail });
          return {
            error: true,
            status: proposal.status,
            proposalId: proposal.proposalId,
            resultSummary: proposal.resultSummary,
            message: detail,
          };
        }
        args.noteComplianceOutcome('BLOCK');
        const detail = proposal.reason || 'Blocked by the authoritative policy pack.';
        args.steps.push({ tool: args.name, label, status: 'blocked', detail });
        args.emit({ type: 'tool_done', tool: args.name, label, status: 'blocked', detail });
        return { blocked: true, message: detail };
      } catch (error) {
        assertToolExecutionActive(args.control);
        const detail =
          error instanceof Error ? error.message.slice(0, 180) : 'Action authority failed';
        args.steps.push({ tool: args.name, label, status: 'error', detail });
        args.emit({ type: 'tool_done', tool: args.name, label, status: 'error', detail });
        return {
          error: true,
          message:
            'The action authority did not confirm the outcome. Check the proposal before retrying.',
          detail,
        };
      }
    }

    try {
      const result = await this.registry.invoke(args.name, args.input, args.ctx, args.control);
      args.steps.push({ tool: args.name, label, status: 'done' });
      args.emit({ type: 'tool_done', tool: args.name, label, status: 'done' });
      return result;
    } catch (error) {
      assertToolExecutionActive(args.control);
      const detail = error instanceof Error ? error.message.slice(0, 180) : 'Tool failed';
      args.steps.push({ tool: args.name, label, status: 'error', detail });
      args.emit({ type: 'tool_done', tool: args.name, label, status: 'error', detail });
      return { error: detail };
    }
  }

  private finalizeReply(args: {
    ctx: MeriContext;
    dto: MeriV3ChatInput;
    reply: string;
    artifactBodies?: string[];
    citations: MeriCitation[];
    ledgerEntries: LedgerEntry[];
    evidencePlan: ReturnType<typeof planGovernmentAffairsEvidence>;
    assuranceRisk: ReturnType<typeof classifyAssuranceRisk>;
    assuranceMode: ReturnType<typeof resolveAssuranceRolloutMode>;
    evidenceAccuracyMode: ReturnType<typeof resolveEvidenceAccuracyMode>;
    complianceOutcome?: 'PASS' | 'WARN' | 'BLOCK';
    verificationAvailable: boolean;
    coverageRequirements: ReturnType<typeof buildCoverageRequirements>;
    residualCoverageGaps: CoverageGap[];
    emit: (event: MeriV3ChatStreamEvent) => void;
  }): { reply: string; citations: MeriCitation[]; held: boolean } {
    const formA = validateCitationMarkers(args.reply, args.citations);
    this.logCitationIntegrity(
      formA.dropped,
      args.citations.length,
      args.evidenceAccuracyMode,
      'reply',
      args.dto.conversationId,
    );
    const formB = validateFormBCitations(
      formA.cleanedText,
      ledgerToToolResultMap(args.ledgerEntries),
    );
    let released = formB.sanitizedText;
    let held = false;
    const usedCitations = [...formA.used];
    for (const body of args.artifactBodies ?? []) {
      for (const source of validateCitationMarkers(body, args.citations).used) {
        if (!usedCitations.some((existing) => existing.n === source.n)) usedCitations.push(source);
      }
    }

    const auditMode = (process.env.MERI_AUDITOR_MODE as AuditorMode | undefined) ?? 'off';
    if (auditMode !== 'off' && released.trim()) {
      try {
        const verdict = runAuditor({
          output: released,
          ledger: { entries: args.ledgerEntries },
          surface: 'chat',
          mode: auditMode,
        });
        if (verdict.findings.length) {
          void this.persistChatAudit(args.ctx.tenantId, auditMode, verdict, released);
          const severe = verdict.findings.filter(
            (finding) => finding.severity === 'high' || finding.severity === 'critical',
          );
          if (severe.length) {
            args.emit({
              type: 'grounding_caveat',
              topSeverity: verdict.topSeverity ?? null,
              findings: severe.slice(0, 20).map((finding) => ({
                check: finding.check,
                severity: finding.severity,
                detail: finding.detail,
              })),
            });
          }
        }
      } catch (error) {
        this.logger.warn(
          `[meriv3-auditor] chat audit failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    if (
      args.assuranceMode !== 'off' &&
      args.assuranceRisk.requiresBufferBeforeRelease &&
      released.trim()
    ) {
      try {
        const claimLedger = buildClaimLedgerFromToolResults({
          output: released,
          ledgerEntries: args.ledgerEntries,
          citations: args.citations,
          plan: args.evidencePlan,
        });
        const grounding = runAuditor({
          output: released,
          ledger: { entries: args.ledgerEntries },
          surface: 'chat',
          mode: 'enforce',
        });
        const domainFindings = runGovernmentAffairsChecks({
          ledger: claimLedger,
          facts: [],
          outputText: released,
        });
        const gate = evaluateAssuranceRelease({
          surface: 'chat',
          plan: args.evidencePlan,
          ledger: claimLedger,
          findings: [...grounding.findings, ...domainFindings],
          ...(args.complianceOutcome ? { complianceOutcome: args.complianceOutcome } : {}),
          verificationAvailable: args.verificationAvailable,
        });
        if (
          args.assuranceMode === 'enforce' &&
          (gate.decision === 'repair' || gate.decision === 'hold')
        ) {
          held = true;
          released = [
            'I could not safely release this high-stakes answer because required verification did not pass.',
            ...gate.blockers.slice(0, 6).map((blocker) => `- ${blocker}`),
            '',
            'No unsupported claim or empty search result was treated as fact.',
          ].join('\n');
        }
      } catch (error) {
        this.logger.warn(
          `[meriv3-assurance] release verification failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        if (args.assuranceMode === 'enforce') {
          held = true;
          released =
            'Verification was unavailable, so I did not release the requested high-stakes answer.';
        }
      }
    }

    if (args.residualCoverageGaps.length) {
      released = appendClaimTiedCoverageDisclosure(
        released,
        args.residualCoverageGaps,
        args.coverageRequirements,
      );
    }
    return { reply: released, citations: usedCitations, held };
  }

  private validateCitationExposure(
    artifact: ChatArtifact,
    citations: MeriCitation[],
    mode: ReturnType<typeof resolveEvidenceAccuracyMode>,
    surface: 'artifact',
    conversationId?: string,
  ): ChatArtifact {
    if (!artifact.bodyText) return artifact;
    return {
      ...artifact,
      bodyText: this.validateCitationText(
        artifact.bodyText,
        citations,
        mode,
        surface,
        conversationId,
      ),
    };
  }

  private validateCitationText(
    text: string,
    citations: MeriCitation[],
    mode: ReturnType<typeof resolveEvidenceAccuracyMode>,
    surface: 'artifact' | 'page_write',
    conversationId?: string,
  ): string {
    if (mode === 'off') return text;
    const validated = validateCitationMarkers(text, citations);
    this.logCitationIntegrity(validated.dropped, citations.length, mode, surface, conversationId);
    return mode === 'enforce' ? validated.cleanedText : text;
  }

  private logCitationIntegrity(
    dropped: number[],
    registered: number,
    mode: ReturnType<typeof resolveEvidenceAccuracyMode>,
    surface: 'reply' | 'artifact' | 'page_write',
    conversationId?: string,
  ): void {
    if (mode === 'off' || dropped.length === 0) return;
    this.logger.warn('meri.citation_integrity', {
      conversationId: conversationId ?? null,
      turnId: null,
      surface,
      dropped,
      registered,
      mode,
    });
  }

  private async assertResearchRunActive(
    dto: MeriV3ChatInput,
    control?: ToolExecutionControl,
  ): Promise<void> {
    if (!dto.researchRun) return;
    const { sessionId, runId } = dto.researchRun;
    const credentials = RequestCredentialsStore.get();
    if (typeof sessionId !== 'string' || typeof runId !== 'string' || !credentials?.bearerToken)
      throw new Error('Authenticated research run identity is required.');
    const execution = createMeriExecutionControl(control, 10_000);
    try {
      execution.assertActive();
      const response = await fetch(
        `${this.apiBaseUrl}/api/clio/research/${encodeURIComponent(sessionId)}/runs/${encodeURIComponent(runId)}/active`,
        {
          signal: execution.signal,
          headers: {
            authorization: `Bearer ${credentials.bearerToken}`,
            accept: 'application/json',
            ...(credentials.impersonateTenantId
              ? { 'x-capiro-impersonate-tenant': credentials.impersonateTenantId }
              : {}),
          },
        },
      );
      if ([404, 409].includes(response.status)) {
        const error = new Error(
          'Research is stopped, superseded, or no longer accessible. No further calls were scheduled.',
        );
        error.name = 'ResearchRunInactiveError';
        throw error;
      }
      if (!response.ok || ((await response.json()) as { active?: unknown }).active !== true)
        throw new Error(
          'Research run status could not be verified; no further calls were scheduled.',
        );
      execution.assertActive();
    } finally {
      execution.dispose();
    }
  }

  private async fetchToolSchemas(control?: ToolExecutionControl): Promise<ToolSchema[]> {
    const credentials = RequestCredentialsStore.get();
    if (!credentials?.bearerToken) {
      this.logger.warn('MeriV3: no bearer available; proceeding without Capiro tools');
      return [];
    }
    try {
      const response = await fetch(`${this.apiBaseUrl}/api/clio/tool-schemas`, {
        signal: control?.signal,
        headers: {
          authorization: `Bearer ${credentials.bearerToken}`,
          accept: 'application/json',
          ...(credentials.impersonateTenantId
            ? { 'x-capiro-impersonate-tenant': credentials.impersonateTenantId }
            : {}),
        },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = (await response.json()) as { schemas?: ToolSchema[] };
      return selectMeriCapabilitySchemas(body.schemas ?? [], 'full_chat', this.registry.list());
    } catch (error) {
      this.logger.warn(
        `MeriV3 tool-schema fetch failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return [];
    }
  }

  private async meterRound(
    ctx: MeriContext,
    model: string,
    usage: ProviderUsage,
    usedTenantKey: boolean,
  ): Promise<void> {
    try {
      await recordAiUsageEvent(
        { prisma: this.prisma, logger: this.logger },
        { tenantId: ctx.tenantId, userId: ctx.userId },
        'meriv3_chat',
        { provider: 'openai', model, usage, usedTenantKey },
      );
    } catch (error) {
      this.logger.warn(
        `MeriV3 usage metering failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async persistChatAudit(
    tenantId: string,
    mode: AuditorMode,
    verdict: ReturnType<typeof runAuditor>,
    reply: string,
  ): Promise<void> {
    try {
      await this.prisma.withTenant(tenantId, (tx) =>
        tx.meriAuditLedger.create({
          data: {
            tenantId,
            surface: 'chat',
            mode,
            decision: verdict.decision,
            topSeverity: verdict.topSeverity ?? null,
            findingCount: verdict.findings.length,
            findings: verdict.findings as unknown as Prisma.InputJsonValue,
            outputChars: reply.length,
          },
        }),
      );
    } catch (error) {
      this.logger.warn(
        `MeriV3 audit ledger persist failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

function extractChatArtifacts(result: unknown): ChatArtifact[] {
  if (!result || typeof result !== 'object') return [];
  const root = result as Record<string, unknown>;
  const candidates = [
    ...(root.artifact ? [root.artifact] : []),
    ...(Array.isArray(root.artifacts) ? root.artifacts : []),
  ];
  const artifacts: ChatArtifact[] = [];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;
    const item = candidate as Record<string, unknown>;
    if (item.persisted === false || typeof item.id !== 'string') continue;
    const artifact: ChatArtifact = {
      id: item.id,
      title:
        typeof item.title === 'string' && item.title.trim()
          ? item.title.trim()
          : typeof root.title === 'string' && root.title.trim()
            ? root.title.trim()
            : 'Meri deliverable',
      kind: typeof item.kind === 'string' && item.kind.trim() ? item.kind.trim() : 'document',
    };
    if (typeof item.bodyText === 'string') artifact.bodyText = item.bodyText;
    if (typeof root.downloadUrl === 'string') artifact.downloadUrl = root.downloadUrl;
    if (typeof root.filename === 'string') artifact.filename = root.filename;
    if (typeof root.mimeType === 'string') artifact.mimeType = root.mimeType;
    artifacts.push(artifact);
  }
  return artifacts;
}
