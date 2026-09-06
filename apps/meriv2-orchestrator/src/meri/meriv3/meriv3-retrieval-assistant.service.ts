import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  assertToolExecutionActive,
  type MeriContext,
  type ToolExecutionControl,
} from '@capiro/meriv2-core';
import { PrismaService } from '../../prisma/prisma.service.js';
import { ApiActionProposalRepo } from '../api-action-proposal.repo.js';
import { MeriRegistryService } from '../meri-registry.service.js';
import { toolLabel, type ChatArtifact, type ChatStep } from '../chat/chat-prompt.js';
import {
  buildMeriResearchDirectorPlan,
  elevateMeriResearchReasoningMode,
  meriResearchCriticInstructions,
  meriResearchDirectorPrompt,
  meriResearchSynthesisInstructions,
} from '../retrieval/meri-research-director.js';
import { appendMeriCoverageDisclosure } from '../retrieval/meri-retrieval-coverage.js';
import { canonicalizeMeriCompanyResearchPlan } from '../retrieval/meri-retrieval-canonicalization.js';
import { MeriRetrievalCoordinator } from '../retrieval/meri-retrieval-coordinator.js';
import {
  classifyMeriRetrievalIntent,
  meriRetrievalIntentPrompt,
} from '../retrieval/meri-retrieval-intent.js';
import {
  buildMeriRetrievalPlan,
  meriRetrievalPlanPrompt,
} from '../retrieval/meri-retrieval-plan.js';
import { compactMeriRetrievalRecipeResult } from '../retrieval/meri-retrieval-result.js';
import { currentGovernedMeriContext } from '../meri-governed-context.runtime.js';
import { ApiManagedMcpRepo } from './api-managed-mcp.repo.js';
import { ApiVisualAnalysisRepo } from './api-visual-analysis.repo.js';
import { MeriV3AssistantService, type MeriV3RunOptions } from './meriv3-assistant.service.js';
import { MeriSemanticToolGateway } from './meri-semantic-tool-gateway.js';
import { MeriV3ManagedMcpAssistantService } from './meriv3-managed-mcp-assistant.service.js';
import {
  executeMeriExternalEntityResolution,
  executeMeriRetrievalRecipe,
  isMeriRetrievalRecipeTool,
  MERI_RETRIEVAL_TOOL_SCHEMAS,
} from './meriv3-retrieval-recipes.js';
import { MeriV3ResearchRuntimeStore } from './meriv3-research-runtime.store.js';
import { MeriV3SemanticCompatibilityTools } from './meriv3-semantic-compatibility-tools.js';
import { MeriV3SemanticRuntimeStore } from './meriv3-semantic-runtime.store.js';
import { OpenAiResponsesClient } from './openai-responses.client.js';
import type { MeriV3ChatInput, MeriV3ChatResult, MeriV3ChatStreamEvent } from './meriv3.types.js';

interface ToolSchema {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

interface InvokeArgs {
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
}

interface AssistantInternals {
  fetchToolSchemas: (control?: ToolExecutionControl) => Promise<ToolSchema[]>;
  invokeTool: (args: InvokeArgs) => Promise<unknown>;
}

const RECIPE_LABELS: Record<string, string> = {
  query_relationship_brief: 'Building relationship brief',
  query_client_changes: 'Scanning client changes',
  query_portfolio_changes: 'Scanning portfolio changes',
  research_external_company: 'Researching company',
  research_federal_market_strategy: 'Building comprehensive federal strategy',
  query_portfolio_overlap: 'Comparing portfolio overlap',
};

const SEMANTIC_COMPATIBILITY_LABELS: Record<string, string> = {
  analyze_funding_opportunity: 'Collecting funding evidence',
  create_artifact: 'Creating artifact',
};

function latestUserText(dto: MeriV3ChatInput): string {
  const message = [...(dto.messages ?? [])]
    .reverse()
    .find((candidate) => candidate?.role === 'user' && typeof candidate.text === 'string');
  return typeof message?.text === 'string' ? message.text : '';
}

function recentUserContext(dto: MeriV3ChatInput): string {
  return (dto.messages ?? [])
    .filter((message) => message?.role === 'user')
    .slice(-3)
    .flatMap((message) => (typeof message.text === 'string' ? [message.text.trim()] : []))
    .filter(Boolean)
    .join('\n');
}

function priorUserTargetHint(dto: MeriV3ChatInput): string | null {
  const users = (dto.messages ?? []).filter(
    (message) => message?.role === 'user' && typeof message.text === 'string',
  );
  // Exclude the latest user message: its target is already part of the current
  // intent. This history lookup exists for terse follow-ups such as “Search
  // across clients” immediately after researching Kinetic Industries.
  for (let index = users.length - 2; index >= 0; index -= 1) {
    const text = users[index]?.text;
    if (typeof text !== 'string') continue;
    const target = classifyMeriRetrievalIntent(text, null).targetHint;
    if (target) return target;
  }
  return null;
}

function enhancedDescription(schema: ToolSchema): ToolSchema {
  if (schema.name === 'resolve_entity') {
    return {
      ...schema,
      description: `${schema.description} For a company or organization that is not a client, call it with the best available name/domain: Meri automatically falls back to the client registry, internal research, LDA, SEC, federal awards, and public web identity signals. Do not stop merely because the organization is not a client.`,
    };
  }
  if (schema.name === 'search_research_sources') {
    return {
      ...schema,
      description:
        'Search authorized INTERNAL Capiro clients, meetings, synchronized mail, notes, and directory notes. This is broad discovery, not exhaustive enumeration: zero matches do not prove absence, and portfolio/change/everything requests must use the corresponding high-level retrieval recipe first.',
    };
  }
  if (schema.name === 'search_emails') {
    return {
      ...schema,
      description: `${schema.description} The result includes totalMatches, returned, hasMore, and searchedMailboxes coverage. Treat the search as incomplete when hasMore is true or any mailbox is unavailable.`,
    };
  }
  return schema;
}

/**
 * Retrieval-aware adapter around the established MeriV3 runtime.
 *
 * Compatibility mode retains the historic V3 retrieval planner/recipes for
 * direct callers. A Phase 19 Capiro turn arrives inside currentGovernedMeriContext
 * and bypasses that second retrieval/coverage engine entirely: the API Context
 * Plane already resolved identity, retrieved evidence, and proved coverage.
 * Native reasoning/action tools remain available for same-turn work.
 */
@Injectable()
export class MeriV3RetrievalAssistantService extends MeriV3ManagedMcpAssistantService {
  private readonly retrievalLogger = new Logger(MeriV3RetrievalAssistantService.name);
  private readonly semanticGateway: MeriSemanticToolGateway;
  private readonly semanticCompatibility: MeriV3SemanticCompatibilityTools;

  constructor(
    registryService: MeriRegistryService,
    openai: OpenAiResponsesClient,
    actionProposals: ApiActionProposalRepo,
    prisma: PrismaService,
    config: ConfigService,
    managedMcp: ApiManagedMcpRepo,
    visualAnalysis: ApiVisualAnalysisRepo,
    private readonly retrieval: MeriRetrievalCoordinator,
  ) {
    super(registryService, openai, actionProposals, prisma, config, managedMcp, visualAnalysis);
    this.semanticGateway = new MeriSemanticToolGateway(config);
    this.semanticCompatibility = new MeriV3SemanticCompatibilityTools(config);

    const internals = this as unknown as AssistantInternals;
    const nativeFetch = internals.fetchToolSchemas.bind(this);
    const nativeInvoke = internals.invokeTool.bind(this);

    internals.fetchToolSchemas = async (control): Promise<ToolSchema[]> => {
      const native = (await nativeFetch(control)).map(enhancedDescription);
      const seen = new Set(native.map((schema) => schema.name));
      // Phase 19 governed turns already ran Retrieval V2 upstream. Do not expose
      // the V3 recipe tools, otherwise the model can start a second retrieval
      // plan and manufacture a competing coverage manifest.
      const recipes = currentGovernedMeriContext()
        ? []
        : MERI_RETRIEVAL_TOOL_SCHEMAS.filter((schema) => !seen.has(schema.name));
      const merged = [...native, ...recipes];
      const semanticRuntime = MeriV3SemanticRuntimeStore.current();
      if (!semanticRuntime) return merged;
      const compatible = this.semanticCompatibility.prepareSchemas(
        merged,
        semanticRuntime.tenantId,
      );
      const selection = this.semanticGateway.select({
        schemas: compatible,
        tenantId: semanticRuntime.tenantId,
        request: semanticRuntime.request,
        recentUserContext: semanticRuntime.recentUserContext,
        plan: semanticRuntime.plan,
      });
      MeriV3SemanticRuntimeStore.recordDecision(selection.decision);
      return selection.schemas;
    };

    const invokeObserved = async (args: InvokeArgs): Promise<unknown> => {
      const startedAt = Date.now();
      const result = await nativeInvoke(args);
      this.retrieval.observe(args.name, args.input, result, Date.now() - startedAt);
      return result;
    };

    const invokeUnderlying =
      (args: InvokeArgs) =>
      async (name: string, input: Record<string, unknown>): Promise<unknown> =>
        invokeObserved({
          ...args,
          name,
          input,
          // The high-level recipe or semantic wrapper supplies exact authorized
          // refs where needed. Never carry an outer schema violation into an
          // independent call that has its own validation and tenant wall.
          scopeViolation: undefined,
        });

    internals.invokeTool = async (args: InvokeArgs): Promise<unknown> => {
      assertToolExecutionActive(args.control);
      const plan = this.retrieval.currentPlan();
      this.retrieval.recordModelTool(args.name);

      if (this.semanticCompatibility.isEnabledTool(args.name, args.ctx.tenantId)) {
        const startedAt = Date.now();
        const label = SEMANTIC_COMPATIBILITY_LABELS[args.name] ?? toolLabel(args.name);
        args.emit({ type: 'tool_call', tool: args.name, label });
        if (args.scopeViolation) {
          const blocked = { error: args.scopeViolation, blocked: true };
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
          this.retrieval.observe(args.name, args.input, blocked, Date.now() - startedAt);
          return blocked;
        }
        try {
          const result = await this.semanticCompatibility.execute(
            args.name,
            args.input,
            invokeUnderlying(args),
          );
          this.retrieval.observe(args.name, args.input, result, Date.now() - startedAt);
          args.steps.push({ tool: args.name, label, status: 'done' });
          args.emit({ type: 'tool_done', tool: args.name, label, status: 'done' });
          return result;
        } catch (error) {
          const detail =
            error instanceof Error ? error.message.slice(0, 240) : 'Semantic tool failed';
          const failed = { error: detail };
          this.retrieval.observe(args.name, args.input, failed, Date.now() - startedAt);
          args.steps.push({ tool: args.name, label, status: 'error', detail });
          args.emit({ type: 'tool_done', tool: args.name, label, status: 'error', detail });
          return failed;
        }
      }

      if (plan && isMeriRetrievalRecipeTool(args.name)) {
        const recipeStartedAt = Date.now();
        const label = RECIPE_LABELS[args.name] ?? toolLabel(args.name);
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
          const blocked = { error: args.scopeViolation, blocked: true };
          this.retrieval.observe(args.name, args.input, blocked, Date.now() - recipeStartedAt);
          return blocked;
        }
        try {
          const rawResult = await executeMeriRetrievalRecipe(args.name, args.input, {
            plan,
            meriContext: args.ctx,
            invoke: invokeUnderlying(args),
          });
          const result = compactMeriRetrievalRecipeResult(rawResult);
          this.retrieval.observe(args.name, args.input, result, Date.now() - recipeStartedAt);
          args.steps.push({ tool: args.name, label, status: 'done' });
          args.emit({ type: 'tool_done', tool: args.name, label, status: 'done' });
          return result;
        } catch (error) {
          const detail =
            error instanceof Error ? error.message.slice(0, 240) : 'Retrieval recipe failed';
          const failed = { error: detail };
          this.retrieval.observe(args.name, args.input, failed, Date.now() - recipeStartedAt);
          args.steps.push({ tool: args.name, label, status: 'error', detail });
          args.emit({ type: 'tool_done', tool: args.name, label, status: 'error', detail });
          return failed;
        }
      }

      if (
        plan?.subjectScope === 'external_entity' &&
        args.name === 'resolve_entity' &&
        typeof args.input.query === 'string' &&
        args.input.query.trim()
      ) {
        const startedAt = Date.now();
        const result = await executeMeriExternalEntityResolution(
          args.input.query.trim(),
          invokeUnderlying(args),
        );
        this.retrieval.observe(args.name, args.input, result, Date.now() - startedAt);
        return result;
      }

      return invokeObserved(args);
    };
  }

  override async run(
    ctx: MeriContext,
    dto: MeriV3ChatInput,
    opts: MeriV3RunOptions = {},
  ): Promise<MeriV3ChatResult> {
    const governed = currentGovernedMeriContext();
    if (governed) {
      // The controller already appends governed.prompt to skillAddendum and sets
      // ctx.contextPacket to the upstream body-free packet summary. Calling the
      // parent directly preserves native reasoning/actions while skipping this
      // class's classifier, recipes, research director and coverage engine.
      const result = await super.run({ ...ctx, contextPacket: governed.contextPacket }, dto, opts);
      return { ...result, retrieval: undefined };
    }

    const request = latestUserText(dto);
    const selectedClientId = dto.clientId;
    const retrievalIntent = classifyMeriRetrievalIntent(request, selectedClientId);
    const baseRetrievalPlan = buildMeriRetrievalPlan(
      request,
      retrievalIntent,
      ctx,
      priorUserTargetHint(dto),
    );
    const retrievalPlan = canonicalizeMeriCompanyResearchPlan(
      baseRetrievalPlan,
      this.semanticGateway.canonicalResearchDirectorEnabled(ctx.tenantId),
    );
    const comprehensiveResearch = retrievalPlan.recipeTool === 'research_federal_market_strategy';
    const researchDirectorPlan = comprehensiveResearch
      ? buildMeriResearchDirectorPlan(request, retrievalPlan.targetHint)
      : null;
    const retrievalSteering = [
      meriRetrievalIntentPrompt(retrievalIntent, selectedClientId),
      meriRetrievalPlanPrompt(retrievalPlan),
      researchDirectorPlan ? meriResearchDirectorPrompt(researchDirectorPlan) : null,
    ]
      .filter(Boolean)
      .join('\n\n');

    const includeFocusedClient = retrievalIntent.includeFocusedClientContext;
    const scopedDto: MeriV3ChatInput = includeFocusedClient
      ? dto
      : {
          ...dto,
          clientId: undefined,
          clientKbSnapshot: undefined,
          memoryContext: undefined,
        };
    const scopedCtx: MeriContext = includeFocusedClient
      ? ctx
      : {
          ...ctx,
          clientSteering: undefined,
          contextPacket: undefined,
        };
    const effectiveReasoningMode = elevateMeriResearchReasoningMode(
      scopedDto.reasoningMode,
      comprehensiveResearch,
    );

    return MeriV3SemanticRuntimeStore.run(
      {
        tenantId: ctx.tenantId,
        request,
        recentUserContext: recentUserContext(dto),
        plan: retrievalPlan,
      },
      () =>
        this.retrieval.run(retrievalPlan, async () => {
          const originalOnEvent = opts.onEvent;
          let textEventSeen = false;
          const runAssistant = () =>
            super.run(
              scopedCtx,
              {
                ...scopedDto,
                reasoningMode: effectiveReasoningMode,
                skillAddendum: [dto.skillAddendum, retrievalSteering].filter(Boolean).join('\n\n'),
              },
              {
                ...opts,
                onEvent: originalOnEvent
                  ? (event) => {
                      if (event.type === 'text') {
                        textEventSeen = true;
                        return;
                      }
                      originalOnEvent(event);
                    }
                  : undefined,
              },
            );

          const result = researchDirectorPlan
            ? await MeriV3ResearchRuntimeStore.run(
                {
                  forcedFirstTool: 'research_federal_market_strategy',
                  criticInstructions: meriResearchCriticInstructions(researchDirectorPlan),
                  synthesisInstructions: meriResearchSynthesisInstructions(researchDirectorPlan),
                },
                runAssistant,
              )
            : await runAssistant();
          const coverage = this.retrieval.coverage();
          const trace = this.retrieval.trace();
          const semantic = MeriV3SemanticRuntimeStore.current()?.decision;
          const modelToolSet = new Set(trace.modelTools);
          const proposedToolSet = new Set(semantic?.proposedNames ?? []);
          const missingToolFromSemanticSet = trace.modelTools.filter(
            (name) => !proposedToolSet.has(name),
          );
          const schemasExposedButUnused = (semantic?.exposedNames ?? []).filter(
            (name) => !modelToolSet.has(name),
          );
          const reply = appendMeriCoverageDisclosure(result.reply, retrievalPlan, coverage);
          if (originalOnEvent && textEventSeen && !opts.signal?.aborted) {
            originalOnEvent({ type: 'text', text: reply });
          }
          this.retrievalLogger.log(
            JSON.stringify({
              event: 'meri.retrieval',
              tenantId: ctx.tenantId,
              queryClass: retrievalPlan.queryClass,
              subjectScope: retrievalPlan.subjectScope,
              recipeTool: retrievalPlan.recipeTool,
              researchDirector: comprehensiveResearch,
              effectiveReasoningMode,
              complete: coverage.complete,
              missingDomains: coverage.missingDomains,
              partialDomains: coverage.partialDomains,
              durationMs: trace.durationMs,
              cumulativeToolMs: trace.cumulativeToolMs,
              observedToolCalls: trace.observedToolCalls,
              modelTools: trace.modelTools,
              recipeFirst: trace.recipeFirst,
              outOfPlanModelTools: trace.outOfPlanModelTools,
              paginationDebt: trace.paginationDebt,
              semanticGatewayMode: semantic?.mode ?? 'legacy',
              semanticToolsAvailable: semantic?.legacyNames ?? [],
              semanticToolsProposed: semantic?.proposedNames ?? [],
              semanticToolsExposed: semantic?.exposedNames ?? [],
              schemasExposedButUnused,
              missingToolFromSemanticSet,
              semanticFallbackToLegacy: semantic?.fallbackToLegacy ?? false,
              semanticFallbackReason: semantic?.fallbackReason ?? null,
              canonicalResearchDirector: semantic?.canonicalResearchDirector ?? false,
              fundingSemanticTools: this.semanticCompatibility.fundingEnabled(ctx.tenantId),
              artifactToolV2: this.semanticCompatibility.artifactEnabled(ctx.tenantId),
            }),
          );
          return {
            ...result,
            reply,
            retrieval: {
              plan: {
                version: retrievalPlan.version,
                queryClass: retrievalPlan.queryClass,
                subjectScope: retrievalPlan.subjectScope,
                targetHint: retrievalPlan.targetHint,
                recipeTool: retrievalPlan.recipeTool,
                requireCompleteCoverage: retrievalPlan.requireCompleteCoverage,
                requiredDomains: retrievalPlan.requiredDomains,
                timeWindow: retrievalPlan.timeWindow,
              },
              coverage,
              trace,
            },
          };
        }),
    );
  }
}

export type MeriV3RetrievalAssistantToken = MeriV3AssistantService;
