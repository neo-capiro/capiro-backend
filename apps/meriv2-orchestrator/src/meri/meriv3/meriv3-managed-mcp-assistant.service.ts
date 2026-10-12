import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { MeriContext, MeriGovernedTurnContext } from '@capiro/meriv2-core';
import { PrismaService } from '../../prisma/prisma.service.js';
import { ApiActionProposalRepo } from '../api-action-proposal.repo.js';
import { MeriRegistryService } from '../meri-registry.service.js';
import { toolLabel, type ChatArtifact, type ChatStep } from '../chat/chat-prompt.js';
import { OpenAiResponsesClient } from './openai-responses.client.js';
import { ApiManagedMcpRepo } from './api-managed-mcp.repo.js';
import { ApiVisualAnalysisRepo } from './api-visual-analysis.repo.js';
import {
  MeriV3AssistantService,
  type MeriResolvedCapability,
  type MeriToolInvocation,
  type MeriV3RunOptions,
  type ToolSchema,
} from './meriv3-assistant.service.js';
import { classifyMeriV3VisualIntent, meriV3VisualIntentPrompt } from './meriv3-visual-intent.js';
import { currentGovernedMeriContext } from '../meri-governed-context.runtime.js';
import { catalogAvailabilityObserverOf } from './meriv3-catalog-availability.js';
import { assertMeriProcedureToolDispatch } from './meriv3-procedure-guard.js';
import { assertMeriV3ResearchCapability } from './meriv3-plan-execution.js';
import type { MeriV3ChatInput, MeriV3ChatResult, MeriV3ChatStreamEvent } from './meriv3.types.js';

import { assertToolExecutionActive, type ToolExecutionControl } from '@capiro/meriv2-core';

const MANAGED_APP_NAMES = {
  meriv3_hubspot: 'HubSpot',
  meriv3_airtable: 'Airtable',
  meriv3_monday: 'monday.com',
  meriv3_google_drive: 'Google Drive',
  meriv3_krisp: 'Krisp',
} as const;
const MANAGED_PREFIXES = Object.keys(MANAGED_APP_NAMES).map((server) => `mcp__${server}__`);

/**
 * Exact managed appId <-> bridged server mapping. A managed schema whose
 * advertised appId and server prefix disagree is never admitted, so a new
 * provider tool can never inherit authority from its name prefix alone.
 */
const MANAGED_SERVER_BY_APP_ID = {
  hubspot: 'meriv3_hubspot',
  airtable: 'meriv3_airtable',
  monday: 'meriv3_monday',
  'google-drive': 'meriv3_google_drive',
  krisp: 'meriv3_krisp',
} as const;
type ManagedAppId = keyof typeof MANAGED_SERVER_BY_APP_ID;

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
  const app = MANAGED_APP_NAMES[server as keyof typeof MANAGED_APP_NAMES] ?? 'Connected app';
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

interface ManagedSchemaMetadata {
  appId: ManagedAppId;
  appName: string;
  server: string;
}

function isManagedAppId(value: unknown): value is ManagedAppId {
  return (
    typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(MANAGED_SERVER_BY_APP_ID, value)
  );
}

/**
 * Validate the advertised managed catalog authority carried on a schema.
 * Requires the original `source=managed_mcp`, `readOnly=true`, a known
 * appId<->server mapping that agrees with the advertised name, and an
 * actually model-callable object JSON Schema (`input_schema.type==='object'`).
 * Anything else is not a managed read and is never admitted by prefix alone.
 */
function readManagedSchemaMetadata(schema: unknown): ManagedSchemaMetadata | null {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return null;
  const candidate = schema as {
    name?: unknown;
    source?: unknown;
    appId?: unknown;
    appName?: unknown;
    readOnly?: unknown;
    input_schema?: unknown;
  };
  if (typeof candidate.name !== 'string' || !candidate.name) return null;
  if (candidate.source !== 'managed_mcp') return null;
  if (candidate.readOnly !== true) return null;
  if (!isManagedAppId(candidate.appId)) return null;
  const server = MANAGED_SERVER_BY_APP_ID[candidate.appId];
  const expectedPrefix = `mcp__${server}__`;
  if (
    !candidate.name.startsWith(expectedPrefix) ||
    candidate.name.length <= expectedPrefix.length
  ) {
    return null;
  }
  const inputSchema = candidate.input_schema;
  if (!inputSchema || typeof inputSchema !== 'object' || Array.isArray(inputSchema)) {
    return null;
  }
  // The provider advertises this schema to the model as a function tool. A
  // JSON Schema whose `type` is not the literal 'object' (or is missing /
  // malformed) is not model-callable as a tool and must never be advertised or
  // executed, even though the metadata above is otherwise well-formed.
  if ((inputSchema as { type?: unknown }).type !== 'object') {
    return null;
  }
  return {
    appId: candidate.appId,
    appName:
      typeof candidate.appName === 'string' && candidate.appName.trim()
        ? candidate.appName
        : MANAGED_APP_NAMES[server],
    server,
  };
}

/** Task-scoped schema equality: canonical JSON of the advertised input schema. */
function canonicalSchemaJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalSchemaJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalSchemaJson((value as Record<string, unknown>)[key])}`,
      )
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function sameInputSchema(left: unknown, right: unknown): boolean {
  return canonicalSchemaJson(left) === canonicalSchemaJson(right);
}

@Injectable()
export class MeriV3ManagedMcpAssistantService extends MeriV3AssistantService {
  private readonly managedMcp: ApiManagedMcpRepo;
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
    this.managedMcp = managedMcp;
    this.visualAnalysis = visualAnalysis;
  }

  /**
   * The managed extension of the read/capability seam. A validated
   * `managed_mcp` read-only schema is admitted only for an ordinary personal
   * NONCLIENT turn; a client/comparison/portfolio/external scope (or any
   * authenticated governed client) falls through to the native authority, which
   * has no such tool, so the managed read stays blocked before any owner I/O.
   */
  protected override resolveCapabilityAuthority(
    name: string,
    schema?: ToolSchema,
    dto?: MeriV3ChatInput,
  ): MeriResolvedCapability | null {
    const metadata = readManagedSchemaMetadata(schema);
    if (metadata && schema?.name === name && !this.managedRawReadRefusal(dto)) {
      return { name, readOnly: true, source: 'managed', executionMode: 'read' };
    }
    return super.resolveCapabilityAuthority(name, schema, dto);
  }

  /**
   * Managed raw reads are ordinary personal NONCLIENT only. A research
   * execution request, any governed operation other than `meri.chat`, a
   * governed procedure binding, any request client, authenticated governed
   * client, non-general subject scope, client-scoped governed evidence, any
   * inherited typed client binding, or any capture authority makes the read
   * unavailable. These are read from the typed envelope fields only — never a
   * prompt-only condition — and never rewrite a vendor clientId. Malformed or
   * incomplete governed authority (a missing context packet, a missing
   * retrieval plan, or a missing subject scope) is refused (fail-closed), never
   * treated as an ordinary personal turn.
   */
  private managedRawReadRefusal(dto?: MeriV3ChatInput): string | null {
    if (dto?.researchRun || dto?.researchPlanExecution) {
      return 'Connected-app reads are not available in a research execution request.';
    }
    if (dto?.clientId) {
      return 'Connected-app reads are not available in a client-scoped conversation.';
    }
    return this.governedManagedReadRefusal(currentGovernedMeriContext());
  }

  /**
   * The governed half of the managed raw-read refusal, read from the typed,
   * request-local `MeriGovernedTurnContext` only (never a prompt-only condition,
   * never global actor/catalog state). Shared verbatim by admission
   * (`managedRawReadRefusal`) and by pre-discovery (`fetchToolSchemas`), so a
   * governed capture/client turn skips managed catalog discovery before it
   * starts instead of fetching and discarding it. Returns null for an ordinary
   * non-governed turn (`governed === null`) and for a valid personal
   * `meri.chat`/`general` turn, preserving historical managed admission.
   *
   * A missing context packet, a missing retrieval plan, or a missing subject
   * scope is incomplete authority and is refused here (fail-closed), never
   * treated as an ordinary personal turn.
   */
  private governedManagedReadRefusal(governed: MeriGovernedTurnContext | null): string | null {
    if (!governed) return null;
    // The managed chat service is driven only by the ordinary `meri.chat`
    // operation. Any other governed operation (or a missing/malformed
    // operationId) must not inherit personal managed-read authority.
    if (governed.operationId !== 'meri.chat') {
      return 'Connected-app reads are not available for this governed operation.';
    }
    if (governed.procedure) {
      return 'Connected-app reads are not available under a governed procedure.';
    }
    // A governed personal managed read requires a real authenticated context
    // packet and an explicit `general` subject scope. A missing context packet,
    // a missing retrieval plan, or a missing scope is incomplete authority and
    // is refused here; absence is never read as an ordinary personal turn.
    if (!governed.contextPacket) {
      return 'Connected-app reads are not available without an authenticated governed context.';
    }
    if (governed.contextPacket.clientId) {
      return 'Connected-app reads are not available for an authenticated governed client.';
    }
    if (governed.retrieval?.plan?.subjectScope !== 'general') {
      return 'Connected-app reads are not available for this governed scope.';
    }
    // Inherited document observations carry real, authenticated client
    // bindings: `source.clientId` (exact owner locator) and
    // `documentEvidence.clientId` (reauthorized read). Either binding means the
    // turn is client-scoped.
    if (
      governed.inheritedDocumentEvidence?.some(
        (citation) => citation?.source?.clientId || citation?.documentEvidence?.clientId,
      )
    ) {
      return 'Connected-app reads are not available for client-scoped governed document evidence.';
    }
    // Any capture authority forbids dynamic MCP reads outright: the existing
    // server-readonly and governed-artifact capture policies both carry the
    // literal `dynamicMcpAllowed: false`, so an authenticated capture turn — even
    // one whose capture clientId is null — must never grant personal managed-read
    // authority. Fail closed on the mere presence of capture authority.
    if (governed.serverReadonlyCapturePolicy || governed.governedArtifactCapturePolicy) {
      return 'Connected-app reads are not available under a server capture policy.';
    }
    for (const record of governed.evidence?.records ?? []) {
      const payload = record?.payload;
      if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
        const clientId = (payload as Record<string, unknown>).clientId;
        if (typeof clientId === 'string' && clientId) {
          return 'Connected-app reads are not available for client-scoped governed evidence.';
        }
      }
    }
    return null;
  }

  protected override async fetchToolSchemas(control?: ToolExecutionControl): Promise<ToolSchema[]> {
    // Entry guard on the ORIGINAL parent control: a stopped/expired request must
    // never begin native + managed discovery.
    assertToolExecutionActive(control);
    // Pre-discovery refusal: when the request-local governed authority already
    // forbids a managed raw read (capture, client scope, non-chat operation,
    // governed procedure, or incomplete authority), skip the managed catalog
    // fetch entirely instead of hardening API rows / running provider discovery
    // and then discarding the result. A policy-forbidden source is intentionally
    // not queried; this is not a fabricated empty successful catalog. An
    // ordinary non-governed turn and a valid personal governed `meri.chat`
    // /`general` turn still resolve null here and fetch as before. The existing
    // `toolPolicy === 'none'` path already performs no fetch at all.
    const managedDiscoveryForbidden = this.governedManagedReadRefusal(currentGovernedMeriContext());
    if (managedDiscoveryForbidden) {
      // Intentional pre-discovery skip of a policy-forbidden source: recorded as
      // a deliberate skip, never a fake outage and never a reconnect attempt.
      catalogAvailabilityObserverOf(control)?.noteManaged({ outcome: 'skipped' });
    }
    // `[]` is a deliberate skip, not a discovered empty catalog: the forbidden
    // source is never queried.
    const managedCatalog: Promise<ToolSchema[]> = managedDiscoveryForbidden
      ? Promise.resolve([])
      : this.managedMcp.schemas(control);
    const [nativeRaw, managed, analysisAvailable] = await Promise.all([
      super.fetchToolSchemas(control),
      managedCatalog,
      this.visualAnalysis.available(control),
    ]);
    // Every discovery branch above is awaited; re-assert the ORIGINAL parent
    // before constructing/returning the model surface so a parent Stop/expiry
    // during discovery can never leave a usable/empty catalog for the turn.
    assertToolExecutionActive(control);
    const native = nativeRaw
      .filter((schema) => schema.name !== 'run_analysis' || analysisAvailable)
      .map((schema) =>
        schema.name === 'run_analysis'
          ? { ...schema, description: `${schema.description} ${VISUAL_ANALYSIS_GUIDANCE}` }
          : schema,
      );
    const seen = new Set(native.map((schema) => schema.name));
    const extra: ToolSchema[] = [];
    for (const schema of managed) {
      if (seen.has(schema.name)) continue;
      // Only validated read-only managed schemas are exposed; invalid/write
      // metadata never reaches the model and never inherits a name prefix.
      const metadata = readManagedSchemaMetadata(schema);
      if (!metadata) continue;
      extra.push({
        name: schema.name,
        input_schema: schema.input_schema,
        // Preserve the API catalog authority internally rather than dropping it.
        source: 'managed_mcp',
        appId: metadata.appId,
        appName: metadata.appName,
        readOnly: true,
        description: [
          `[Connected app: ${metadata.appName}; optional external evidence source.]`,
          'Use this tool only when its data is materially relevant to the user request; never call it merely because the app is connected.',
          'In a client-scoped conversation, use external records only when they clearly concern the active client; ignore unrelated records and ask for clarification when identity is ambiguous.',
          metadata.appId === 'monday'
            ? 'Never treat all personal monday.com work as belonging to the active client. Use only a board ID/link supplied by the user or an explicit server-authorized client-board mapping; otherwise report monday.com as unmapped rather than searching broadly.'
            : '',
          schema.description,
        ]
          .filter(Boolean)
          .join(' '),
      });
    }
    return [...native, ...extra];
  }

  protected override augmentToolInput(
    dto: MeriV3ChatInput,
    input: Record<string, unknown>,
    schema: ToolSchema | undefined,
    authority?: MeriResolvedCapability | null,
  ): { input: Record<string, unknown>; scopeViolation?: string } {
    // An MCP provider's clientId is its own parameter namespace, not a
    // Capiro client UUID. Never rewrite managed vendor arguments.
    if (schema && isManagedTool(schema.name)) return { input: { ...input } };
    return super.augmentToolInput(dto, input, schema, authority);
  }

  /**
   * `run_analysis` presents as its work label, not the implementation
   * primitive, so its client-scope refusal matches its normal dispatch
   * presentation. Every other tool keeps the base presentation.
   */
  protected override blockScopeViolation(args: {
    name: string;
    input: Record<string, unknown>;
    providerCallId: string;
    detail: string;
    steps: ChatStep[];
    emit: (event: MeriV3ChatStreamEvent) => void;
  }): { blocked: true; error: string } {
    if (args.name !== 'run_analysis') return super.blockScopeViolation(args);
    const label = analysisWorkLabel(args.input);
    args.emit({ type: 'tool_call', tool: label, label });
    args.steps.push({ tool: args.name, label, status: 'blocked', detail: args.detail });
    args.emit({ type: 'tool_done', tool: label, label, status: 'blocked', detail: args.detail });
    return { blocked: true, error: args.detail };
  }

  protected override async invokeTool(args: MeriToolInvocation): Promise<unknown> {
    assertToolExecutionActive(args.control);
    if (args.name === 'run_analysis') {
      const label = analysisWorkLabel(args.input);
      // The browser sees the work, not the implementation primitive.
      args.emit({ type: 'tool_call', tool: label, label });
      // Re-derive the client-scope guard so an alternate dispatch path cannot
      // retarget a persisted chart analysis as a plain native read: a
      // mismatch suppresses the owner POST before any persistence. Resolve the
      // ACTUAL canonical schema of `args.name` so a wrapper schema cannot
      // disguise the owner contract.
      const dispatchSchema = this.resolveDispatchSchema(args);
      const scopeViolation =
        args.scopeViolation ??
        this.resolveToolScopeViolation(
          args.dto,
          dispatchSchema,
          this.resolveCapabilityAuthority(args.name, dispatchSchema, args.dto),
          args.input,
        ) ??
        undefined;
      if (scopeViolation) {
        args.steps.push({
          tool: args.name,
          label,
          status: 'blocked',
          detail: scopeViolation,
        });
        args.emit({
          type: 'tool_done',
          tool: label,
          label,
          status: 'blocked',
          detail: scopeViolation,
        });
        return { error: scopeViolation, blocked: true };
      }
      if (!args.conversationId) {
        const detail = 'Visual analysis requires an active Meri conversation.';
        args.steps.push({ tool: args.name, label, status: 'error', detail });
        args.emit({ type: 'tool_done', tool: label, label, status: 'error', detail });
        return { error: detail };
      }
      try {
        const result = await this.visualAnalysis.execute(
          {
            ...args.input,
            conversationId: args.conversationId,
          },
          args.control,
        );
        // The owner call resolved; assert the ORIGINAL parent before emitting any
        // artifact or returning, so a Stop/expiry during the call cannot leak a
        // later artifact effect.
        assertToolExecutionActive(args.control);
        for (const artifact of analysisArtifacts(result)) {
          args.artifacts.push(artifact);
          args.emit({ type: 'artifact', artifact });
        }
        args.steps.push({ tool: args.name, label, status: 'done' });
        args.emit({ type: 'tool_done', tool: label, label, status: 'done' });
        return result;
      } catch (error) {
        assertToolExecutionActive(args.control);
        const detail = error instanceof Error ? error.message.slice(0, 180) : 'Analysis failed';
        args.steps.push({ tool: args.name, label, status: 'error', detail });
        args.emit({ type: 'tool_done', tool: label, label, status: 'error', detail });
        return { error: detail };
      }
    }

    if (!isManagedTool(args.name)) return super.invokeTool(args);
    const label = managedLabel(args.name) || toolLabel(args.name);
    args.emit({ type: 'tool_call', tool: label, label });
    try {
      // The advertised authority must still be a valid managed read, the turn
      // must still be ordinary personal NONCLIENT, and the credential-scoped
      // catalog must still advertise the same schema immediately before I/O.
      const metadata = readManagedSchemaMetadata(args.schema);
      if (!metadata || args.schema?.name !== args.name) {
        throw new Error('Connected-app tool metadata is invalid.');
      }
      const refusal = this.managedRawReadRefusal(args.dto);
      if (refusal) throw new Error(refusal);
      // Final managed dispatch mirrors the native last-mile guards: a research
      // plan execution must still admit this exact tool, and a governed
      // procedure binding must still allow this read-only tool. These run
      // before any catalog fetch or owner I/O, so a managed read can never
      // escape a governed procedure/research boundary even if it was somehow
      // advertised.
      assertMeriV3ResearchCapability(args.admittedReadCapabilities, args.name);
      assertMeriProcedureToolDispatch({
        procedure: currentGovernedMeriContext()?.procedure,
        toolName: args.name,
        readOnly: true,
      });
      await this.assertCurrentManagedReadCatalog(args.name, args.schema, args.control);
      // The reauthorization look-up is awaited; assert the ORIGINAL parent before
      // any owner I/O so a Stop/expiry between revalidation and dispatch stops
      // the read instead of starting a later owner call.
      assertToolExecutionActive(args.control);
      let result: unknown;
      try {
        result = await this.managedMcp.executeRead(args.name, args.input, args.control);
      } catch (ownerError) {
        // A CURRENT owner read failure after an initially healthy catalog is a
        // real failure for this app (from admitted metadata), so the released
        // answer cannot imply its records were consulted. No retry/reconnect.
        catalogAvailabilityObserverOf(args.control)?.noteManagedAppUnavailable(
          metadata.appId,
          'unavailable',
        );
        throw ownerError;
      }
      // A successful owner read that resolved after Stop/expiry is not a new
      // effect: assert the parent before recording/returning its result.
      assertToolExecutionActive(args.control);
      args.steps.push({ tool: args.name, label, status: 'done' });
      args.emit({ type: 'tool_done', tool: label, label, status: 'done' });
      return result;
    } catch (error) {
      assertToolExecutionActive(args.control);
      const detail = error instanceof Error ? error.message.slice(0, 180) : 'Connected app failed';
      args.steps.push({ tool: args.name, label, status: 'error', detail });
      args.emit({ type: 'tool_done', tool: label, label, status: 'error', detail });
      return { error: detail, connectedApp: true };
    }
  }

  /**
   * Re-fetch the current credential-scoped managed catalog and confirm the tool
   * is still advertised with the same appId mapping and input schema. This is
   * deliberately a fresh lookup, never a cached success: a revocation between
   * the first advertisement and dispatch leaves the read blocked.
   */
  private async assertCurrentManagedReadCatalog(
    name: string,
    advertised: ToolSchema,
    control?: ToolExecutionControl,
  ): Promise<void> {
    // Entry guard on the ORIGINAL parent control.
    assertToolExecutionActive(control);
    const current = (await this.managedMcp.schemas(control)).find((schema) => schema.name === name);
    // A revocation/omission look-up is only meaningful for a live parent: assert
    // after the await so a stopped/expired parent is never reported as a
    // "no longer available" tool.
    assertToolExecutionActive(control);
    const advertisedMetadata = readManagedSchemaMetadata(advertised);
    const currentMetadata = readManagedSchemaMetadata(current);
    if (
      !current ||
      !advertisedMetadata ||
      !currentMetadata ||
      currentMetadata.appId !== advertisedMetadata.appId ||
      !sameInputSchema(advertised.input_schema, current.input_schema)
    ) {
      // A revocation/omission after the first advertisement is a CURRENT failure
      // for the app whose admitted metadata authorized this dispatch (derived
      // from canonical metadata, never a tool-name prefix). Status only: the
      // read stays blocked before owner I/O and this never grants a read.
      if (advertisedMetadata) {
        catalogAvailabilityObserverOf(control)?.noteManagedAppUnavailable(
          advertisedMetadata.appId,
          'unavailable',
        );
      }
      throw new Error('Connected-app tool is no longer available.');
    }
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
