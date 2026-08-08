import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { MeriContext } from '@capiro/meriv2-core';
import { PrismaService } from '../../prisma/prisma.service.js';
import { ApiActionProposalRepo } from '../api-action-proposal.repo.js';
import { MeriRegistryService } from '../meri-registry.service.js';
import { toolLabel, type ChatArtifact, type ChatStep } from '../chat/chat-prompt.js';
import { OpenAiResponsesClient } from './openai-responses.client.js';
import { ApiManagedMcpRepo } from './api-managed-mcp.repo.js';
import { ApiVisualAnalysisRepo } from './api-visual-analysis.repo.js';
import { MeriV3AssistantService, type MeriV3RunOptions } from './meriv3-assistant.service.js';
import { classifyMeriV3VisualIntent, meriV3VisualIntentPrompt } from './meriv3-visual-intent.js';
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
}

interface AssistantInternals {
  fetchToolSchemas: () => Promise<ToolSchema[]>;
  invokeTool: (args: InvokeArgs) => Promise<unknown>;
  augmentToolInput: (
    dto: MeriV3ChatInput,
    input: Record<string, unknown>,
    schema: ToolSchema | undefined,
  ) => { input: Record<string, unknown>; scopeViolation?: string };
}

const MANAGED_PREFIXES = ['mcp__meriv3_hubspot__', 'mcp__meriv3_airtable__'] as const;

const VISUAL_ANALYSIS_GUIDANCE = [
  'Use run_analysis as Meri’s quantitative analyst after retrieving real numeric rows from Capiro or a connected app.',
  'Use it when a visual materially reduces interpretation effort: trends over time, budget-stage movement, rankings, portfolio exposure, distributions, correlations, scenarios, outliers, timelines, or multi-series comparisons.',
  'Do not make decorative charts for one fact, a trivial two-number answer, or data too incomplete to support the visual. Never synthesize missing rows just to complete a graph.',
  'The sandbox includes pandas, NumPy, matplotlib, SciPy, statsmodels, seaborn, and NetworkX, with no network access.',
  'For a visual answer, produce BOTH: (1) a matplotlib figure as the canonical export/fallback image and (2) an interactive spec in results.visuals.',
  'Set results to an object such as {findings:[...], table:[...], visuals:[...]}.',
  'Each visual must be plain JSON with chartType line|area|bar|stacked_bar|scatter|pie|waterfall|heatmap|timeline, a decision-useful title, optional one-line insight, data rows, and the required mapping fields.',
  'Capiro design rule: the title states the claim and the chart proves it. Never use a generic title such as “Chart of spending” or “Funding chart”.',
  'For line/area/bar/stacked_bar/scatter/waterfall use xKey plus series:[{dataKey,label,valueFormat?}]. Waterfall accepts one delta series. For pie use nameKey/valueKey. For heatmap use heatmap:{rowKey,columnKey,valueKey}. For timeline use timeline:{labelKey,startKey,endKey?,groupKey?}.',
  'Prefer one strong visual over several weak ones. Keep exact values available in results.table when the user may need to inspect or cite them.',
  'Treat the visual as DERIVED analysis. Cite the original Capiro or connected-app retrieval sources in the surrounding answer; run_analysis is not the provenance of its input rows.',
].join(' ');

function isManagedTool(name: string): boolean {
  return MANAGED_PREFIXES.some((prefix) => name.startsWith(prefix));
}

function managedLabel(name: string): string {
  const parts = name.split('__');
  const server = (parts[1] ?? '').toLowerCase();
  const app =
    server === 'meriv3_hubspot'
      ? 'HubSpot'
      : server === 'meriv3_airtable'
        ? 'Airtable'
        : 'Connected app';
  const tool = parts.slice(2).join(' ').replace(/_/g, ' ');
  const toolTitle = tool.replace(/\b\w/g, (char) => char.toUpperCase());
  return `${app}: ${toolTitle}`.trim();
}

function latestUserText(dto: MeriV3ChatInput): string {
  const message = [...(dto.messages ?? [])]
    .reverse()
    .find((candidate) => candidate?.role === 'user' && typeof candidate.text === 'string');
  return typeof message?.text === 'string' ? message.text : '';
}

function analysisWorkLabel(input: Record<string, unknown>): string {
  const purpose = typeof input.purpose === 'string' ? input.purpose.toLowerCase() : '';
  if (/correlat|regress|scatter|relationship/.test(purpose)) return 'Calculating relationship';
  if (/rank|largest|smallest|top\s|bottom\s|sort/.test(purpose)) return 'Ranking results';
  if (/heatmap|exposure|matrix|coverage gap/.test(purpose)) return 'Mapping exposure';
  if (/timeline|deadline|hearing|markup|calendar|schedule/.test(purpose)) {
    return 'Building decision timeline';
  }
  if (/waterfall|stage|mark|request|appropriat|authoriz/.test(purpose)) {
    return 'Analyzing funding movement';
  }
  if (/trend|trajectory|over time|year-over-year|yoy|histor/.test(purpose)) {
    return 'Analyzing trend';
  }
  if (/scenario|sensitivity|forecast/.test(purpose)) return 'Testing scenarios';
  if (/network|centrality|stakeholder/.test(purpose)) return 'Analyzing relationships';
  return 'Analyzing data';
}

function analysisArtifacts(value: unknown): ChatArtifact[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const raw = (value as Record<string, unknown>).artifacts;
  if (!Array.isArray(raw)) return [];
  const out: ChatArtifact[] = [];
  for (const candidate of raw.slice(0, 6)) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const item = candidate as Record<string, unknown>;
    if (item.persisted !== true || typeof item.id !== 'string' || !item.id) continue;
    out.push({
      id: item.id,
      title:
        typeof item.title === 'string' && item.title.trim() ? item.title.trim() : 'Analysis visual',
      kind: 'analysis_chart',
    });
  }
  return out;
}

function bufferedAnalysisIds(
  events: Array<Extract<MeriV3ChatStreamEvent, { type: 'artifact' }>>,
): string[] {
  return [
    ...new Set(
      events
        .filter((event) => event.artifact.kind === 'analysis_chart')
        .map((event) => event.artifact.id),
    ),
  ];
}

@Injectable()
export class MeriV3ManagedMcpAssistantService extends MeriV3AssistantService {
  private readonly visualAnalysis: ApiVisualAnalysisRepo;

  constructor(
    registryService: MeriRegistryService,
    openai: OpenAiResponsesClient,
    actionProposals: ApiActionProposalRepo,
    prisma: PrismaService,
    config: ConfigService,
    managedMcp: ApiManagedMcpRepo,
    visualAnalysis: ApiVisualAnalysisRepo,
  ) {
    super(registryService, openai, actionProposals, prisma, config);
    this.visualAnalysis = visualAnalysis;

    const internals = this as unknown as AssistantInternals;
    const nativeFetch = internals.fetchToolSchemas.bind(this);
    const nativeInvoke = internals.invokeTool.bind(this);
    const nativeAugment = internals.augmentToolInput.bind(this);

    internals.fetchToolSchemas = async (): Promise<ToolSchema[]> => {
      const [nativeRaw, managed, analysisAvailable] = await Promise.all([
        nativeFetch(),
        managedMcp.schemas(),
        visualAnalysis.available(),
      ]);
      const native = nativeRaw
        .filter((schema) => schema.name !== 'run_analysis' || analysisAvailable)
        .map((schema) =>
          schema.name === 'run_analysis'
            ? { ...schema, description: `${schema.description} ${VISUAL_ANALYSIS_GUIDANCE}` }
            : schema,
        );
      const seen = new Set(native.map((schema) => schema.name));
      const extra = managed
        .filter((schema) => isManagedTool(schema.name) && !seen.has(schema.name))
        .map(({ name, description, input_schema, appName }) => ({
          name,
          input_schema,
          description: [
            `[Connected app: ${appName}; optional external evidence source.]`,
            'Use this tool only when its data is materially relevant to the user request; never call it merely because the app is connected.',
            'In a client-scoped conversation, use external records only when they clearly concern the active client; ignore unrelated records and ask for clarification when identity is ambiguous.',
            description,
          ].join(' '),
        }));
      return [...native, ...extra];
    };

    internals.augmentToolInput = (
      dto: MeriV3ChatInput,
      input: Record<string, unknown>,
      schema: ToolSchema | undefined,
    ) => {
      // An MCP provider's clientId is its own parameter namespace, not a
      // Capiro client UUID. Never rewrite managed vendor arguments.
      if (schema && isManagedTool(schema.name)) return { input: { ...input } };
      return nativeAugment(dto, input, schema);
    };

    internals.invokeTool = async (args: InvokeArgs): Promise<unknown> => {
      if (args.name === 'run_analysis') {
        const label = analysisWorkLabel(args.input);
        // The browser sees the work, not the implementation primitive.
        args.emit({ type: 'tool_call', tool: label, label });
        if (args.scopeViolation) {
          args.steps.push({
            tool: args.name,
            label,
            status: 'blocked',
            detail: args.scopeViolation,
          });
          args.emit({
            type: 'tool_done',
            tool: label,
            label,
            status: 'blocked',
            detail: args.scopeViolation,
          });
          return { error: args.scopeViolation, blocked: true };
        }
        if (!args.conversationId) {
          const detail = 'Visual analysis requires an active Meri conversation.';
          args.steps.push({ tool: args.name, label, status: 'error', detail });
          args.emit({ type: 'tool_done', tool: label, label, status: 'error', detail });
          return { error: detail };
        }
        try {
          const result = await visualAnalysis.execute({
            ...args.input,
            conversationId: args.conversationId,
          });
          for (const artifact of analysisArtifacts(result)) {
            args.artifacts.push(artifact);
            args.emit({ type: 'artifact', artifact });
          }
          args.steps.push({ tool: args.name, label, status: 'done' });
          args.emit({ type: 'tool_done', tool: label, label, status: 'done' });
          return result;
        } catch (error) {
          const detail = error instanceof Error ? error.message.slice(0, 180) : 'Analysis failed';
          args.steps.push({ tool: args.name, label, status: 'error', detail });
          args.emit({ type: 'tool_done', tool: label, label, status: 'error', detail });
          return { error: detail };
        }
      }

      if (!isManagedTool(args.name)) return nativeInvoke(args);
      const label = managedLabel(args.name) || toolLabel(args.name);
      args.emit({ type: 'tool_call', tool: label, label });
      try {
        const result = await managedMcp.executeRead(args.name, args.input);
        args.steps.push({ tool: args.name, label, status: 'done' });
        args.emit({ type: 'tool_done', tool: label, label, status: 'done' });
        return result;
      } catch (error) {
        const detail =
          error instanceof Error ? error.message.slice(0, 180) : 'Connected app failed';
        args.steps.push({ tool: args.name, label, status: 'error', detail });
        args.emit({ type: 'tool_done', tool: label, label, status: 'error', detail });
        return { error: detail, connectedApp: true };
      }
    };
  }

  override async run(
    ctx: MeriContext,
    dto: MeriV3ChatInput,
    opts: MeriV3RunOptions = {},
  ): Promise<MeriV3ChatResult> {
    const decision = classifyMeriV3VisualIntent(latestUserText(dto));
    const visualSteering = meriV3VisualIntentPrompt(decision);
    const downstream = opts.onEvent;
    const bufferedArtifacts: Array<Extract<MeriV3ChatStreamEvent, { type: 'artifact' }>> = [];
    const runOptions: MeriV3RunOptions = {
      ...opts,
      onEvent: (event) => {
        if (event.type === 'artifact') {
          bufferedArtifacts.push(event);
          return;
        }
        downstream?.(event);
      },
    };

    let result: MeriV3ChatResult;
    try {
      result = await super.run(
        ctx,
        {
          ...dto,
          skillAddendum: [dto.skillAddendum, visualSteering].filter(Boolean).join('\n\n'),
        },
        runOptions,
      );
    } catch (error) {
      // A model/transport/assurance failure after run_analysis persisted a chart
      // has no final result to release. Delete those unlinked V3 charts now;
      // the API's 24h sweep remains the fallback if this cleanup call fails.
      const failedAnalysis = bufferedAnalysisIds(bufferedArtifacts);
      if (failedAnalysis.length) {
        await this.visualAnalysis.discard(failedAnalysis).catch(() => undefined);
      }
      throw error;
    }

    // Base assurance can remove artifacts when an answer is held. Only release
    // IDs that survived that final decision; never let a chart outrun its answer.
    const allowed = new Set((result.artifacts ?? []).map((artifact) => artifact.id));
    const emitted = new Set<string>();
    const withheldAnalysis = new Set<string>();
    for (const event of bufferedArtifacts) {
      if (!allowed.has(event.artifact.id)) {
        if (event.artifact.kind === 'analysis_chart') withheldAnalysis.add(event.artifact.id);
        continue;
      }
      if (emitted.has(event.artifact.id)) continue;
      emitted.add(event.artifact.id);
      downstream?.(event);
    }

    // Storage hygiene must never turn a safe answer into a failed answer. The
    // API also has a bounded 24h sweep for a network/process failure here.
    if (withheldAnalysis.size) {
      await this.visualAnalysis.discard([...withheldAnalysis]).catch(() => undefined);
    }

    return result;
  }
}
