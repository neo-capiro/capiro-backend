import {
  MERI_CAPABILITY_REGISTRY,
  selectMeriCapabilitySchemas,
  isMeriMailReadTool,
  resolveMeriDocumentRequest,
  stripAppendedAttachmentText,
} from '@capiro/shared';
import {
  classifyApiToolReadOutcome,
  type ApiToolReadOutcome,
} from '@capiro/shared/meri-read-outcome';
import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import {
  extractCitationsFromToolResult,
  formatCitationsForPrompt,
  computeAiCostUsd,
  recordAiUsageEvent,
  validateCitationMarkers,
  validateFormBCitations,
  type MeriCitation,
  type ProviderUsage,
} from '@capiro/shared';
import {
  AUTO_CORRECTION_CAPABILITY,
  bindCitationToLedgerEntries,
  COVERAGE_RETRIEVAL_CAPABILITY,
  PASSAGE_SELECTION_CAPABILITY,
  JEV_TASK_REGISTRY,
  JEV_TASK_REGISTRY_VERSION,
  buildAssurancePromptBlock,
  buildControlledClaimLedger,
  extractMaterialClaims,
  classifyAssuranceRisk,
  evaluateAssuranceRelease,
  ledgerToToolResultMap,
  planGovernmentAffairsEvidence,
  resolveAssuranceRolloutMode,
  resolveAutoCorrectionCategories,
  resolveCapabilityRollout,
  resolveClaimAssessmentMode,
  resolveEvidenceAccuracyMode,
  resolveJevConfig,
  resolveJevProviderMode,
  resolveJevCacheMode,
  JevDecisionCache,
  resolveMatchLabelMode,
  resolveStatusProvenanceMode,
  resolveGovernmentAffairsOperatingFrame,
  runAuditor,
  runGovernmentAffairsChecks,
  assurePreToolPersist,
  KeywordIntentRouter,
  type AssuranceSurface,
  type AssuredEvidence,
  type AuditorMode,
  type CapabilityRolloutMode,
  type DecisionProvider,
  type LedgerEntry,
  type MeriContext,
  type ToolRegistry,
  assertToolExecutionActive,
  type ToolExecutionControl,
  ReplayToolExecutor,
  classifyActionIntent,
  meriTelemetryChildSpanId,
  meriTelemetryConfigIdentity,
  meriTelemetryOperationId,
} from '@capiro/meriv2-core';
import {
  currentMeriTaskUsage,
  meriOrchestratorTelemetryHeaders,
  withMeriOrchestratorTelemetrySpan,
  emitMeriOrchestratorTelemetry,
  setMeriTelemetryConfigIdentity,
} from '../../telemetry/meri-telemetry.runtime.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { RequestCredentialsStore } from '../../request/request-credentials.store.js';
import { ApiActionProposalRepo } from '../api-action-proposal.repo.js';
import { MeriRegistryService } from '../meri-registry.service.js';
import { createMeriExecutionControl } from '../meri-execution-control.js';
import {
  catalogAvailabilityObserverOf,
  createMeriCatalogAvailabilityObserver,
  deriveCatalogAvailabilityRelevance,
  meriCatalogAvailabilityInstruction,
  meriCatalogAvailabilityReleaseNote,
  type MeriCatalogAvailabilityControl,
  type MeriCatalogAvailabilityRelevance,
  type MeriCatalogAvailabilityRelevanceSignals,
  type MeriCatalogNativeReadFailureReason,
} from './meriv3-catalog-availability.js';
import {
  composeChatSystemPrompt,
  toolLabel,
  type ChatArtifact,
  type ChatStep,
  type DurableSafeReadOutcome,
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
  completedTextResponseFailure,
  readOpenAiResponsesErrorTelemetry,
} from './openai-responses.client.js';
import { resolveMeriV3ReasoningProfile } from './meriv3-reasoning.js';
import { MeriSemanticToolGateway } from './meri-semantic-tool-gateway.js';
import { MeriProgressiveToolDiscovery } from './meri-progressive-tool-discovery.js';
import { buildMeriGovernedToolSelectionContext } from './meriv3-governed-tool-selection.js';
import { MeriV3SemanticRuntimeStore } from './meriv3-semantic-runtime.store.js';
import {
  assertMeriProcedureToolDispatch,
  bindMeriProcedureSchemas,
  MeriProcedureBindingError,
  requireMeriProcedureBinding,
} from './meriv3-procedure-guard.js';
import {
  assertMeriV3ResearchCapability,
  requireMeriV3ResearchPlanExecution,
} from './meriv3-plan-execution.js';
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
import {
  MeriRunBudget,
  MeriRunBudgetExhaustedError,
  isLegitimatePollingObservation,
  isLogicalToolFailure,
  type MeriDurableProviderAccounting,
  type MeriProviderReservation,
  type MeriToolSignatureScope,
} from './meriv3-run-budget.js';
import { scheduleClaimInventoryShadow } from './meriv3-claim-inventory-shadow.js';
import {
  buildLiteralAuditContext,
  validateLiteralAuditCorrections,
} from './meriv3-audit-contract.js';
import {
  enforceRetainedStatusProvenance,
  runStatusProvenance,
} from './status-provenance-runtime.js';
import {
  createChatDecisionProviders,
  createClientFitClient,
  createPassageSelectionClient,
} from '../jev/jev-provider.factory.js';
import { assessReleasedClaims } from '../jev/shadow-claim-assessor.js';
import {
  applyMatchLabelControl,
  createClientFitEvaluator,
  matchLabelEvent,
} from './match-label-control.js';
import {
  appendClaimTiedCoverageDisclosure,
  buildCoverageRequirements,
  compareCoverage,
  planFollowUp,
  type CoverageGap,
  type CoverageRequirement,
} from '../retrieval/meri-evidence-requirements.js';
import { applyLiveRepair, buildRepairDocumentReferences } from '../repair/live-repair.service.js';
import { createOrchestratorToolExecutor } from '../repair/orchestrator-tool-executor.js';
import { createRevisionGenerator } from '../repair/revision-generator.js';
import {
  askPassageQuestions,
  applyPassageSelectionToSynthesis,
  buildPassageCandidates,
  PASSAGE_SELECTION_MODEL_PRICE_PER_INPUT_TOKEN,
  PASSAGE_SELECTION_QUESTION_VERSION,
  rebuildSynthesisEvidence,
  selectPassages,
} from '../jev/passage-selector.js';
import {
  CanaryTurnCollector,
  replyRequestsClarification,
  type CanaryTurnSurface,
} from '../canary/canary-turn-collector.js';

export interface MeriV3RunOptions {
  onEvent?: (event: MeriV3ChatStreamEvent) => void;
  signal?: AbortSignal;
  deadlineAt?: number;
  /** Original transport signal retained for post-release shadow cancellation. */
  requestSignal?: AbortSignal;
}

const TOOL_RESULT_CHARS = 12_000;
const PROCEDURE_AUTHORITY_TIMEOUT_MS = 5_000;
/**
 * Stage 2c budget. The repair stage runs between finalization and the single
 * text emission, so `maxMs` is also the hard ceiling on how long that frame can
 * be delayed; the stage degrades to the finalized reply when it is exceeded.
 */
const AUTO_CORRECTION_BUDGET = {
  maxPasses: 1 as const,
  maxToolCalls: 3,
  maxMs: 8_000,
  maxInputTokens: 60_000,
};
/** Promoted material claims assessed per turn; later claims stay byte-identical. */
const AUTO_CORRECTION_MAX_CLAIMS = 12;
const PAGE_WRITE_DRAFT_TOOLS = new Set(['draft_policy_memo', 'create_meeting_brief']);
const UNKNOWN_PUBLIC_TOOL = {
  tool: 'unknown_tool',
  label: 'Unavailable tool',
  detail: 'An unavailable tool request was blocked.',
} as const;
const MODEL_AUTHORED_PERSISTED_BODY_FIELDS: ReadonlyMap<string, string> = new Map([
  ['draft_policy_memo', 'body'],
  ['save_note', 'body'],
]);

/**
 * Capabilities that produce or persist a Capiro artifact/effect even though the
 * registry marks them `readOnly`. `run_analysis` is the canonical case: the
 * managed dispatch calls the owner's `/v3/visual-analysis` endpoint and returns
 * an owned chart artifact, so it must never be retargeted as a plain native
 * read — it stays bound to the immutable conversation client. Ordinary write
 * tools (`readOnly: false`) are covered by the bound-effect branch and need no
 * entry here.
 */
const READONLY_ARTIFACT_OWNER_TOOLS: ReadonlySet<string> = new Set(['run_analysis']);

/** A tool input whose client filter disagrees with the conversation's client. */
export const CROSS_CLIENT_REFUSAL =
  'This conversation is pinned to a different client. I did not run the cross-client request.';

/**
 * A bound effect/artifact/write whose immutable conversation client disagrees
 * with the single client the authenticated governed turn resolves. Refused
 * before replay, dedup, proposal or persistence so a Beta-scoped turn never
 * writes an Acme conversation artifact (or vice versa).
 */
export const GOVERNED_BOUND_EFFECT_REFUSAL =
  'This governed turn resolves a different client than the conversation is pinned to, so I did not run this client-scoped action.';

/**
 * A client-bearing native read in a governed turn that resolves no single
 * authorized client (portfolio/comparison/external/general or a client scope
 * with no authenticated packet client). The UI-selected client is never used
 * as a fallback target, so the read is refused rather than silently narrowed.
 */
export const GOVERNED_NO_SINGLE_CLIENT_REFUSAL =
  'This governed turn does not resolve a single authorized client for that read, so I did not run it against the client selected in the interface.';

/**
 * A tool schema exposed to the model for this turn.
 *
 * Native schemas carry only name/description/input_schema. A managed extension
 * additionally retains the API catalog authority metadata
 * (source/appId/appName/readOnly) so admission, read-only schema exposure and
 * the final `executeFunctionCalls` dispatch agree without a second registry.
 * The extra fields are internal: the provider projection
 * (`anthropicSchemaToResponsesTool`) selects only name/description/parameters.
 */
export interface ToolSchema {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  source?: 'managed_mcp';
  appId?: string;
  appName?: string;
  readOnly?: boolean;
}

/**
 * The read/capability authority resolved for one tool name for one turn
 * (the admission seam). Native authority remains the default; a managed
 * extension resolves an equivalent, still-revalidated managed read.
 */
export interface MeriResolvedCapability {
  name: string;
  readOnly: boolean;
  source: 'native' | 'managed';
  executionMode?: string;
}

/**
 * The arguments of one tool invocation handed to `invokeTool`. Extracted so a
 * subclass can supply a typed `protected override invokeTool` at the managed
 * boundary without monkey-patching the base method.
 */
export interface MeriToolInvocation {
  ctx: MeriContext;
  dto: MeriV3ChatInput;
  name: string;
  input: Record<string, unknown>;
  conversationId?: string;
  steps: ChatStep[];
  pendingApprovals: NonNullable<MeriV3ChatResult['pendingApprovals']>;
  artifacts: ChatArtifact[];
  emit: (event: MeriV3ChatStreamEvent) => void;
  prePersistRefusal: (name: string, input: Record<string, unknown>) => string | null;
  userRequest: string;
  noteComplianceOutcome: (outcome: 'PASS' | 'WARN' | 'BLOCK') => void;
  scopeViolation?: string;
  control?: ToolExecutionControl;
  citations: MeriCitation[];
  evidenceAccuracyMode: ReturnType<typeof resolveEvidenceAccuracyMode>;
  providerCallId: string;
  schema: ToolSchema;
  researchRun?: { sessionId: string; runId: string; leaseEpoch: number };
  admittedReadCapabilities: ReadonlySet<string> | null;
  captureDurableSafeRead: (outcome: DurableSafeReadOutcome) => void;
  /**
   * The admitted (exposed) schemas for the dispatch batch this invocation
   * belongs to. Used to resolve the ACTUAL canonical schema of `name` when an
   * alternate dispatch path (recipe/semantic `invokeUnderlying`, completion)
   * carries an outer wrapper schema whose `name` differs from the real tool.
   */
  availableSchemas?: readonly ToolSchema[];
}

interface FunctionExecution {
  call: OpenAiResponsesFunctionCall;
  result: unknown;
  serialized: string;
}

/** The forced-synthesis request after Stage 2b passage selection. */
interface SelectedSynthesisEvidence {
  input: Array<Record<string, unknown>>;
  instructions: string;
  /** Enforce only: the verified rebuild removed evidence and is applied to the request. */
  applied: boolean;
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

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalJsonValue(nested)]),
    );
  }
  return value;
}

function writeIntentKey(args: {
  ctx: MeriContext;
  dto: MeriV3ChatInput;
  tool: string;
  input: Record<string, unknown>;
}): string {
  return JSON.stringify(
    canonicalJsonValue({
      tenantId: args.ctx.tenantId,
      actorUserId: args.ctx.userId,
      clientId: args.dto.clientId ?? args.input.clientId ?? null,
      conversationId: args.dto.conversationId ?? null,
      researchRunId: args.dto.researchRun?.runId ?? null,
      tool: args.tool,
      input: args.input,
    }),
  );
}

function functionCallBatchIsComplete(calls: OpenAiResponsesFunctionCall[]): boolean {
  const callIds = new Set<string>();
  return calls.every((call) => {
    if (
      (call.status !== undefined && call.status !== 'completed') ||
      !call.call_id.trim() ||
      !call.name.trim() ||
      callIds.has(call.call_id)
    ) {
      return false;
    }
    callIds.add(call.call_id);
    try {
      parseArguments(call.arguments);
      return true;
    } catch {
      return false;
    }
  });
}

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

function toolSchemaVersion(schema: ToolSchema): string {
  return `sha256:${createHash('sha256').update(canonicalSchemaJson(schema.input_schema)).digest('hex')}`;
}

function sameToolSchemaSurface(left: ToolSchema, right: ToolSchema): boolean {
  return canonicalSchemaJson(left) === canonicalSchemaJson(right);
}

function safetyIdentifier(ctx: MeriContext): string {
  return createHash('sha256').update(`${ctx.tenantId}:${ctx.userId}`).digest('hex');
}

function finishInstructions(): string {
  return [
    '# FINISH NOW â€” answer the user',
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
 * table from everything it found â€” 60s repeatedly wasn't enough, forcing a
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
  // (no "timed out"/AbortError text) but tags it with structured telemetry â€”
  // recognize that so this is treated as a recoverable timeout too.
  return readOpenAiResponsesErrorTelemetry(error)?.finishReason === 'deadline_exceeded';
}

/** Cancellation and research-lease loss keep their legacy handling; a Stage 2 stage must not swallow them. */
function isTurnAbortError(error: unknown, signal?: AbortSignal): boolean {
  return (
    Boolean(signal?.aborted) ||
    (error instanceof Error && error.name === 'ResearchRunInactiveError')
  );
}

function withToolBudget(
  registry: ToolRegistry,
  budget: MeriRunBudget,
  scope: MeriToolSignatureScope,
  beforeInvoke?: (
    name: string,
    input: Record<string, unknown>,
    control?: ToolExecutionControl,
  ) => Promise<void>,
  admittedReadCapabilities: ReadonlySet<string> | null = null,
): ToolRegistry {
  const invoke = async <O>(
    name: string,
    input: unknown,
    ctx: MeriContext,
    control?: ToolExecutionControl,
  ): Promise<O> => {
    assertMeriV3ResearchCapability(admittedReadCapabilities, name);
    if (!budget.reserveToolBatch(1)) {
      throw new MeriRunBudgetExhaustedError(budget.reason ?? 'tool_calls');
    }
    const validatedArgs =
      input && typeof input === 'object' && !Array.isArray(input)
        ? (input as Record<string, unknown>)
        : {};
    const signature = budget.toolSignature(scope, name, validatedArgs);
    if (!budget.beginTool(signature)) {
      throw new MeriRunBudgetExhaustedError(budget.reason ?? 'retry_calls');
    }
    try {
      assertMeriProcedureToolDispatch({
        procedure: currentGovernedMeriContext()?.procedure,
        toolName: name,
        readOnly: registry.get(name)?.readOnly,
      });
      await beforeInvoke?.(name, validatedArgs, control);
      const result = await registry.invoke<O>(name, input, ctx, control);
      if (registry.get(name)?.readOnly === true) {
        budget.observeToolResult({
          signature,
          result,
          failed: isLogicalToolFailure(result),
          repeatable: isLegitimatePollingObservation(validatedArgs, result),
        });
      }
      return result;
    } catch (error) {
      if (registry.get(name)?.readOnly === true) {
        budget.observeToolResult({
          signature,
          result: { error: errorReason(error) },
          failed: true,
        });
      }
      throw error;
    }
  };
  return new Proxy(registry, {
    get(target, property) {
      if (property === 'invoke') return invoke;
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function errorReason(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}

function governedToolResult(result: unknown): string {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return 'done';
  const record = result as Record<string, unknown>;
  if (record.pendingApproval === true) return 'pending_approval';
  if (record.blocked === true) return 'blocked';
  if (record.error) return 'error';
  return 'done';
}

class ForcedSynthesisBoundaryError extends Error {
  readonly name = 'ForcedSynthesisBoundaryError';

  constructor(readonly failure: string) {
    super(`Forced synthesis response rejected: ${failure}`);
  }
}

function boundedPartialReply(
  reason: string | null | undefined,
  ledgerEntries: LedgerEntry[],
): string {
  const retained = ledgerEntries.slice(-4).map((entry) => {
    const summary = entry.serialized.replace(/\s+/g, ' ').trim().slice(0, 320);
    return `- ${entry.tool}: ${summary}${entry.serialized.length > summary.length ? 'â€¦' : ''}`;
  });
  return [
    `I stopped this turn at its aggregate runtime bound${reason ? ` (${reason.replaceAll('_', ' ')})` : ''}.`,
    retained.length
      ? ['Retained supported findings/evidence from completed reads:', ...retained].join('\n')
      : 'No tool finding was completed before the bound was reached.',
    'No additional tool or write was started after the stop. The remaining requested work is incomplete.',
  ].join('\n\n');
}

/**
 * A genuine authorized seed/context evidence entry (the authenticated governed
 * packet or a reauthorized document observation). Authenticated provenance is
 * the REQUEST-LOCAL identity of the entry the controller seeded from the
 * governed turn — never an owner-supplied `origin` string carried on an ordinary
 * result body, which any current owner payload could forge. These seeds ARE
 * current scoped evidence: a later catalog/read outage does not erase them.
 */
function isSeedCatalogEvidence(entry: LedgerEntry, seedEntries: ReadonlySet<LedgerEntry>): boolean {
  return seedEntries.has(entry);
}

/**
 * Whether one ledger entry is a genuinely SUPPORTED finding that may be
 * retained in a bounded partial. An error/refusal result (including a raw
 * failed-owner body) is never a supported finding, regardless of any `origin`
 * label it carries; a request-authenticated seed entry always is. This reuses
 * the existing read classifier — it invents no new evidence shape and no broad
 * text scrubbing.
 */
function catalogFindingIsSupported(
  entry: LedgerEntry,
  seedEntries: ReadonlySet<LedgerEntry>,
): boolean {
  if (isSeedCatalogEvidence(entry, seedEntries)) return true;
  const result = entry.result;
  if (result && typeof result === 'object') {
    const record = result as Record<string, unknown>;
    if (typeof record.error === 'string' && record.error.trim()) return false;
    if (record.blocked === true) return false;
  }
  const classification = classifyApiToolReadOutcome(entry.tool, result);
  if (
    classification &&
    (classification.kind === 'failed' || classification.kind === 'unavailable')
  ) {
    return false;
  }
  return true;
}

/**
 * Readable bounded rendering of ONE already-accepted citation: the source
 * summary title plus its existing grounding snippet. This reuses the citation
 * ownership the turn already established (the exact text the owner extracted
 * and exposed); it never re-serializes an internal result object, invents a
 * fact contract, runs a broad scrub, or trusts provider prose.
 */
function readableAcceptedCitation(citation: MeriCitation): string {
  const title = typeof citation.title === 'string' ? citation.title.trim() : '';
  const snippet =
    typeof citation.snippet === 'string' ? citation.snippet.replace(/\s+/g, ' ').trim() : '';
  const head = `[${citation.n}] ${citation.tool}`;
  if (snippet && title) return `- ${head}: ${title} — ${snippet.slice(0, 280)}`;
  if (snippet) return `- ${head}: ${snippet.slice(0, 280)}`;
  if (title) return `- ${head}: ${title}`;
  return `- ${head}`;
}

/**
 * Bounded release when a source this request needed could not be reached. The
 * provider's free-form prose is deliberately NOT released (it may imply the
 * unavailable source's records were consulted, and the provider is not trusted
 * to obey the guidance). Only the fixed, source-specific limitation plus the
 * genuinely supported findings already retained from completed reads — and any
 * authorized seed/context evidence — are released. A failed read's error/owner
 * body is never retained as a supported finding. Reuses the same bounded
 * partial shape as `boundedPartialReply`; it invents no new evidence/fact
 * contract and no broad text scrubbing.
 */
function buildBoundedCatalogAvailabilityReply(
  limitation: string,
  ledgerEntries: LedgerEntry[],
  evidence: {
    /** Request-authenticated seed entries (governed packet / reauthorized reads). */
    seedEntries: readonly LedgerEntry[];
    /**
     * Request-local binding from EACH dispatched ledger entry to the concrete
     * accepted citations that entry itself produced. This is deliberately NOT a
     * later global citation array filtered by tool name: a later UNAVAILABLE
     * result of the SAME tool must never be restored from an earlier healthy
     * call's slot, and a genuine inner owner citation whose `tool` differs from
     * the outer host name must still be found. Seed entries are bound to the
     * request-authenticated seed citation array by their seed identity, never to
     * an owner-supplied `origin` string or arbitrary failed-owner data.
     */
    ledgerCitationBindings: ReadonlyMap<LedgerEntry, readonly MeriCitation[]>;
  },
): { reply: string; citations: MeriCitation[] } {
  const seedEntries = new Set(evidence.seedEntries);
  const supported = ledgerEntries.filter((entry) => catalogFindingIsSupported(entry, seedEntries));
  const seed = supported.filter((entry) => seedEntries.has(entry));
  const reads = supported.filter((entry) => !seedEntries.has(entry));
  const retainedEntries = seed.length ? [...seed.slice(-2), ...reads.slice(-2)] : reads.slice(-4);
  // Retain the concrete accepted citation objects bound to the ACTUAL retained
  // supported invocation identities — preserving original numbers/identity/
  // snippets. A source with no citable extract keeps a bounded honest receipt
  // (its tool name) instead of an arbitrary serialized object.
  // Deduplicate by the EXISTING accepted numbered identity — `citation.n` — not
  // by object reference. `numberMeriEvidenceCitations` keeps a prior identity's
  // number but returns a NEW `{...source, n: prior.n}` object on each extraction,
  // so two distinct supported invocations that reuse the same owner identity
  // (same source/id) yield two DISTINCT objects sharing one number. A
  // reference-only Set would release that one marker twice, with conflicting
  // metadata. The LATEST supported concrete object wins so a stale/earlier
  // title/snippet never coexists with the current one. `validateCitationMarkers`
  // already keys a released citation by its single `n`, so this matches the
  // accepted contract exactly: it never renumbers, reads the global/later
  // citation array, invents authority, or edits the shared extractor/ledger.
  // A citation that overflowed numbering (no `n`) is keyed by its own object so
  // two distinct overflow objects are never collapsed.
  const retainedByIdentity = new Map<number | MeriCitation, MeriCitation>();
  for (const entry of retainedEntries) {
    for (const citation of evidence.ledgerCitationBindings.get(entry) ?? []) {
      retainedByIdentity.set(citation.n ?? citation, citation);
    }
  }
  const boundedCitations = [...retainedByIdentity.values()].slice(-4);
  const retained = boundedCitations.length
    ? boundedCitations.map(readableAcceptedCitation)
    : retainedEntries.map(
        (entry) => `- ${entry.tool}: source read completed; no bounded fact extract was retained.`,
      );
  const reply = [
    limitation,
    retained.length
      ? ['Retained supported findings from completed reads:', ...retained].join('\n')
      : 'No supported finding was retained for a source this request needed.',
    'No source this request needed was treated as consulted when it could not be reached.',
  ].join('\n\n');
  // The bounded reply DISCARDS the provider prose, so it must return exactly the
  // genuine accepted citations it actually rendered — with their original
  // identities/numbers — alongside the reply. This keeps every `[n]` marker
  // backed by matching citation metadata (no dangling seeded/[9] marker, no
  // failed-owner citation restoration); it invents no evidence/fact contract.
  return { reply, citations: [...boundedCitations] };
}

function incompleteSynthesisPartialReply(ledgerEntries: LedgerEntry[]): string {
  const retained = ledgerEntries.slice(-4).map((entry) => {
    const summary = entry.serialized.replace(/\s+/g, ' ').trim().slice(0, 320);
    return `- ${entry.tool}: ${summary}${entry.serialized.length > summary.length ? 'â€¦' : ''}`;
  });
  return [
    'The synthesis response was incomplete, so I did not release its partial text.',
    retained.length
      ? ['Retained supported findings/evidence from completed reads:', ...retained].join('\n')
      : 'No supported tool finding was retained for a partial answer.',
    'No additional tool or write was started. The remaining requested work is incomplete.',
  ].join('\n\n');
}

/**
 * Deep Research runs reach this runtime through the chat entry point with a
 * server-owned research lease. Every Stage 0-2 capability is enrolled by exact
 * surface, so a `chat` enrollment must never reach research traffic.
 */
/**
 * Deep Research planning and execution are one surface. Execution turns carry
 * the durable lease (researchRun); planning turns carry no lease but are issued
 * by the API under the signed governed operation 'meri.research'. Before this,
 * planning ran as chat: the chat-enrolled evidence, coverage and correction
 * stages treated the plan JSON as an answer, appended limitations, and the API
 * rejected the plan as not strict JSON (Stage 2 Release A live check).
 */
function turnSurface(dto: MeriV3ChatInput): CanaryTurnSurface {
  if (dto.researchRun) return 'research';
  // A steering re-plan (and a legacy-plan migration) runs inside the research
  // run's stream, governed as 'research.generate-report', with no lease. As
  // 'chat' it got appended limitations and every re-plan failed strict JSON
  // (T7, sessions 4b03e4f2 and 886e0f30, 2026-10-07).
  const operationId = currentGovernedMeriContext()?.operationId;
  return operationId === 'meri.research' || operationId === 'research.generate-report'
    ? 'research'
    : 'chat';
}

/**
 * Prompt size for the passage-selection event without serializing the request:
 * message text, replayed function-call arguments and tool outputs.
 */
function promptTextChars(items: readonly Record<string, unknown>[]): number {
  let total = 0;
  for (const item of items) {
    if (typeof item.content === 'string') total += item.content.length;
    else if (Array.isArray(item.content)) {
      for (const part of item.content) {
        const text = (part as { text?: unknown } | null)?.text;
        if (typeof text === 'string') total += text.length;
      }
    }
    if (typeof item.output === 'string') total += item.output.length;
    if (typeof item.arguments === 'string') total += item.arguments.length;
  }
  return total;
}

type BudgetedSettlement<T> =
  { kind: 'settled'; value: T } | { kind: 'deadline' } | { kind: 'aborted' };

/**
 * Resolve `work`, or stop waiting at `deadlineAt` / on `signal`. The work
 * itself keeps running; its later settlement is observed and discarded so an
 * eventual rejection can never surface as an unhandled rejection.
 */
function settleWithinBudget<T>(
  work: Promise<T>,
  bound: { deadlineAt: number; signal: AbortSignal },
): Promise<BudgetedSettlement<T>> {
  return new Promise<BudgetedSettlement<T>>((resolve, reject) => {
    let done = false;
    const finish = (settle: () => void): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      bound.signal.removeEventListener('abort', onAbort);
      settle();
    };
    const onAbort = () => finish(() => resolve({ kind: 'aborted' }));
    const timer = setTimeout(
      () => finish(() => resolve({ kind: 'deadline' })),
      Math.max(0, Math.min(2_147_483_647, bound.deadlineAt - Date.now())),
    );
    if (bound.signal.aborted) onAbort();
    else bound.signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => finish(() => resolve({ kind: 'settled', value })),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

/** Exact owner row/span only: no serialized-entry, snippet, substring, or marker fallback. */
export function buildRepairPassages(
  evidence: readonly AssuredEvidence[],
  citations: readonly MeriCitation[],
  ledgerEntries: readonly LedgerEntry[],
  expectedClientId?: string | null,
): Record<
  string,
  {
    text: string;
    clientId?: string;
    documentId?: string;
    version?: string;
    locator?: string;
    acquisitionState?: 'discovered' | 'consulted';
    evidenceKind?: 'source_passage' | 'structured_record';
    contentHash?: string;
    ownerVerified?: boolean;
  }
> {
  const passages: Record<
    string,
    {
      text: string;
      clientId?: string;
      documentId?: string;
      version?: string;
      locator?: string;
      acquisitionState?: 'discovered' | 'consulted';
      evidenceKind?: 'source_passage' | 'structured_record';
      contentHash?: string;
      ownerVerified?: boolean;
    }
  > = {};
  for (const item of evidence) {
    let citation: MeriCitation | undefined;
    if (item.id.startsWith('citation:')) {
      citation = citations.find(
        (candidate) => `citation:${candidate.n}:${candidate.tool}:${candidate.id}` === item.id,
      );
    } else if (item.id.startsWith('formb:')) {
      citation = {
        n: 0,
        tool: item.sourceType,
        id: item.sourceId,
        type: 'source',
        title: item.title ?? item.sourceId,
        url: item.url ?? null,
        snippet: null,
      };
    }
    if (!citation) continue;
    const binding = bindCitationToLedgerEntries(citation, ledgerEntries, { expectedClientId });
    if (
      !binding ||
      (item.version && item.version !== binding.version) ||
      (item.clientId && item.clientId !== binding.clientId) ||
      (item.documentId && item.documentId !== binding.documentId) ||
      (item.contentHash && item.contentHash !== binding.contentHash)
    )
      continue;
    const receipt = {
      text: binding.text,
      ...(binding.clientId ? { clientId: binding.clientId } : {}),
      ...(binding.documentId ? { documentId: binding.documentId } : {}),
      ...(binding.version ? { version: binding.version } : {}),
      ...(binding.locator ? { locator: binding.locator } : {}),
      acquisitionState: binding.acquisitionState,
      evidenceKind: binding.evidenceKind,
      contentHash: binding.contentHash,
      ownerVerified: true,
    };
    passages[item.id] = receipt;
    if (citation.n > 0) {
      for (const alias of [
        `${citation.tool}:${citation.id}`,
        ...(citation.stableId ? [citation.stableId] : []),
      ])
        passages[alias] ??= receipt;
    }
  }
  return passages;
}

/**
 * The `(name, fields)` sink the Stage 1/2 components log through. The service
 * turns every call into one `logStructured` line, so each Meri event those
 * components emit is a single JSON object on one log line.
 */
interface MeriStructuredEventLogger {
  log(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
}

const rolloutDiagnosticsLogged = new Set<string>();

/** Tests only: clears the once-per-process rollout diagnostics. */
export function resetMeriV3RolloutDiagnosticsForTest(): void {
  rolloutDiagnosticsLogged.clear();
}

/**
 * The API appends each attachment's extracted text to the user's turn
 * ("Attached document …", filing references, unavailable notices, and the
 * compaction carry-over). Classification and planning must use what the user
 * typed: a spreadsheet's "Cost ($M)" header made a page-4 capability question a
 * budget-amount claim with an unrelated limitation (Stage 1 T4). The model
 * still receives the full turn, attachments included.
 */
/**
 * Client-file read coordination applies to ordinary client chat turns only. A
 * Deep Research run turn owns its evidence through the research receipts, and a
 * research plan turn runs with no tools at all (toolPolicy 'none'), so holding
 * either to a client-file read can only fail: planning was released as
 * "partial" whenever its prompt mentioned files (Stage 2 Release A check).
 */
export function meriDocumentRequestFor(
  dto: Pick<MeriV3ChatInput, 'clientId' | 'researchRun' | 'toolPolicy' | 'messages'>,
) {
  return dto.clientId && !dto.researchRun && dto.toolPolicy !== 'none'
    ? resolveMeriDocumentRequest(dto.messages ?? [])
    : null;
}

export function userRequestText(text: string): string {
  return stripAppendedAttachmentText(text);
}

@Injectable()
export class MeriV3AssistantService {
  private readonly logger = new Logger(MeriV3AssistantService.name);
  private readonly registry: ToolRegistry;
  private readonly llm: MeriRegistryService['llm'];
  private readonly apiBaseUrl: string;
  private readonly governedSemanticGateway: MeriSemanticToolGateway;
  private readonly serviceSecret?: string;
  private readonly jevDecisionCache = new JevDecisionCache();

  private liveRepairCache(tenantId: string) {
    const mode = resolveJevCacheMode(process.env, tenantId, 'chat');
    return mode === 'off' ? undefined : { mode, instance: this.jevDecisionCache };
  }

  constructor(
    registryService: MeriRegistryService,
    private readonly openai: OpenAiResponsesClient,
    private readonly actionProposals: ApiActionProposalRepo,
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.registry = registryService.registry;
    this.llm = registryService.llm;
    this.governedSemanticGateway = new MeriSemanticToolGateway(config);
    this.apiBaseUrl = (
      config.get<string>('MERIV2_API_BASE_URL') ?? 'http://localhost:3000'
    ).replace(/\/+$/, '');
    this.serviceSecret = config.get<string>('INTERNAL_SERVICE_SECRET') || undefined;
  }

  /**
   * The single read/capability authority seam for this turn. Native authority
   * remains the default — a live registry definition, live registry membership
   * and exact `MERI_CAPABILITY_REGISTRY` readOnly parity — and native writes are
   * never weakened. The managed subclass overrides this to add a validated,
   * still-revalidated request-scoped `managed_mcp` read.
   */
  protected resolveCapabilityAuthority(
    name: string,
    _schema?: ToolSchema,
    _dto?: MeriV3ChatInput,
  ): MeriResolvedCapability | null {
    const definition = this.registry.get(name);
    if (!definition || !this.registry.list().includes(name)) return null;
    const canonical = MERI_CAPABILITY_REGISTRY.find((item) => item.name === name);
    if (!canonical || canonical.readOnly !== definition.readOnly) return null;
    return {
      name,
      readOnly: definition.readOnly === true,
      source: 'native',
      executionMode: this.registry.executionMetadata?.(name)?.executionMode,
    };
  }

  /**
   * The canonical native read capability for a tool name, or null when the name
   * is not a canonical native read. The identity comes from registry/capability
   * metadata (`resolveCapabilityAuthority`, which requires live registry
   * membership AND exact `MERI_CAPABILITY_REGISTRY` readOnly parity) — never a
   * tool-name prefix guess. A read-only artifact owner (`run_analysis`) is
   * excluded so an effect is never recorded as a plain read.
   */
  private canonicalNativeReadCapability(
    name: string,
    schema: ToolSchema | undefined,
    dto: MeriV3ChatInput,
  ): string | null {
    const authority = this.resolveCapabilityAuthority(name, schema, dto);
    if (!authority || authority.readOnly !== true || authority.source !== 'native') return null;
    if (READONLY_ARTIFACT_OWNER_TOOLS.has(authority.name)) return null;
    return authority.name;
  }

  /**
   * Record a CURRENT native canonical-read failure for request-local status. It
   * is used for an owner throw/error or an unusable read result (the actual
   * `classifyApiToolReadOutcome` failure kinds), and never for a completed/empty
   * read or an unrecognised/refused result (an unclassified result is not an
   * outage). Status only: it can never grant a read or turn a failed read into a
   * success. Non-read effects (run_analysis/artifacts/save_memory) are never
   * recorded because `canonicalNativeReadCapability` rejects them.
   */
  private noteNativeReadOutcomeFailure(
    name: string,
    schema: ToolSchema | undefined,
    dto: MeriV3ChatInput,
    control: ToolExecutionControl | undefined,
    classification: ApiToolReadOutcome | null | undefined,
    fallbackReason?: MeriCatalogNativeReadFailureReason,
  ): void {
    const failed: MeriCatalogNativeReadFailureReason | undefined =
      fallbackReason !== undefined
        ? fallbackReason
        : classification?.kind === 'failed'
          ? 'failed'
          : classification?.kind === 'unavailable'
            ? 'unavailable'
            : undefined;
    if (!failed) return;
    const capability = this.canonicalNativeReadCapability(name, schema, dto);
    if (!capability) return;
    catalogAvailabilityObserverOf(control)?.noteNativeReadFailure(capability, failed);
  }

  /**
   * The canonical schema actually dispatched for one invocation. The batch
   * admission already resolves the schema by call name, but an alternate
   * dispatch path (recipe/semantic `invokeUnderlying`, completion/repair) can
   * carry an outer WRAPPER schema whose `name` differs from the real tool it
   * re-dispatches. Resolve the real capability's schema by name from the
   * admitted schemas so `isRetargetableGovernedRead` / `requiresClientId` see
   * the ACTUAL owner contract (a required-client read stays required; an
   * optional actor read stays optional) rather than a wrapper's shape.
   */
  protected resolveDispatchSchema(
    args: Pick<MeriToolInvocation, 'name' | 'schema' | 'availableSchemas'>,
  ): ToolSchema | undefined {
    if (!args.schema || args.schema.name === args.name) return args.schema;
    return args.availableSchemas?.find((candidate) => candidate.name === args.name) ?? args.schema;
  }

  /**
   * The authenticated governed client target for this turn, or null.
   *
   * Derived ONLY from the typed, MAC-authenticated governed context: a resolved
   * single-client procedure binding, or a `subjectScope: 'client'` retrieval
   * plan plus one authenticated context-packet client. Never from a UI hint,
   * packet item labels, the retrieval `targetHint`, evidence payloads, the
   * provider request or a `readOnly` flag. A governed turn that resolves no
   * single client returns null (never the interface selection).
   */
  protected resolveGovernedClientTarget(): string | null {
    const governed = currentGovernedMeriContext();
    if (!governed) return null;
    if (governed.procedure?.scope === 'client') {
      const procedureClient = governed.procedure.clientId;
      if (typeof procedureClient === 'string' && procedureClient.trim()) {
        return procedureClient.trim();
      }
    }
    if (governed.retrieval?.plan?.subjectScope !== 'client') return null;
    const clientId = governed.contextPacket?.clientId;
    return typeof clientId === 'string' && clientId.trim() ? clientId.trim() : null;
  }

  /**
   * Whether one resolved capability is a canonical native read that may be
   * re-targeted to the authenticated governed single client. Only a native
   * read-only capability qualifies; a read-only artifact owner (`run_analysis`)
   * is excluded because it persists an owned artifact and stays bound to the
   * immutable conversation client.
   */
  private isRetargetableGovernedRead(
    schema: ToolSchema | undefined,
    authority: MeriResolvedCapability | null | undefined,
  ): boolean {
    if (authority?.readOnly !== true || authority.source !== 'native') return false;
    // Key the exclusion on the ACTUAL dispatched capability identity, not only
    // on the outer wrapper schema name: an alternate dispatch path may retain
    // an outer schema while rewriting the real tool name, so EITHER identity
    // naming a read-only artifact owner keeps the capability a bound effect.
    return (
      !READONLY_ARTIFACT_OWNER_TOOLS.has(authority.name) &&
      !READONLY_ARTIFACT_OWNER_TOOLS.has(schema?.name ?? '')
    );
  }

  /**
   * Whether the owner contract REQUIRES a clientId (a required-client read such
   * as `get_client_context`), as opposed to an actor/tenant read that merely
   * EXPOSES an optional clientId (`search_memory`, `query_tasks`, mail reads).
   * Read only from the schema's own `required` list; never inferred from a name
   * prefix or an evidence payload.
   */
  private requiresClientId(schema: ToolSchema | undefined): boolean {
    const required = schema?.input_schema?.required;
    return Array.isArray(required) && required.includes('clientId');
  }

  /**
   * The pre-dispatch client-scope guard for one resolved capability. Returns
   * the refusal detail (which must be consumed before replay, budget dedup,
   * write-intent dedup, proposal or persistence) or null.
   *
   * - A canonical native read may target only the authenticated governed single
   *   client; an explicit different client is refused. In a governed turn that
   *   resolves no single client, the interface selection is never used as a
   *   fallback: an explicit model-supplied filter is refused (a generic actor
   *   ACL does not grant it), a required-client read with an omitted filter is
   *   refused, and only an OPTIONAL actor/tenant read with an omitted filter
   *   passes through unchanged to its existing narrow owner.
   * - A bound effect/artifact/write keeps the immutable conversation client; a
   *   governed single-client turn whose authenticated target disagrees with
   *   that binding — including an original null conversation client — is
   *   refused.
   */
  protected resolveToolScopeViolation(
    dto: MeriV3ChatInput,
    schema: ToolSchema | undefined,
    authority: MeriResolvedCapability | null | undefined,
    input: Record<string, unknown>,
  ): string | null {
    if (this.isRetargetableGovernedRead(schema, authority)) {
      const governedTarget = this.resolveGovernedClientTarget();
      const supplied = typeof input.clientId === 'string' ? input.clientId.trim() : '';
      if (governedTarget) {
        if (supplied && supplied !== governedTarget) return CROSS_CLIENT_REFUSAL;
        return null;
      }
      // An ordinary ungoverned turn keeps its legacy binding; only a governed
      // turn with no single authorized client applies the narrowed rules below.
      if (!currentGovernedMeriContext()) return null;
      // No authenticated single target: an explicit model-supplied client is
      // never granted by a generic actor ACL, so it is refused; a
      // required-client read with no target is refused too. An OPTIONAL
      // actor/tenant read whose filter is omitted stays omitted and reaches its
      // existing narrow owner (personal/general memory, personal mailbox) —
      // the interface-selected client is never used as a fallback.
      if (supplied) return GOVERNED_NO_SINGLE_CLIENT_REFUSAL;
      if (this.requiresClientId(schema)) return GOVERNED_NO_SINGLE_CLIENT_REFUSAL;
      return null;
    }
    const governedTarget = this.resolveGovernedClientTarget();
    // Symmetric immutability: a governed turn that resolves a single client must
    // match the conversation's bound client INCLUDING the null case. An
    // authenticated Beta versus an original null conversation is a mismatch
    // just as Beta versus Acme is, so there is no truthiness hole and the block
    // happens before replay, dedup, proposal or persistence.
    if (governedTarget && dto.clientId !== governedTarget) {
      return GOVERNED_BOUND_EFFECT_REFUSAL;
    }
    return null;
  }

  /**
   * The pre-dispatch client-scope guard for an AUXILIARY dispatch path that
   * calls the registry directly (`withToolBudget` — repair, status) and
   * therefore bypasses `invokeTool`. The repair path in particular projects the
   * ORIGINAL `dto.clientId` into a client-bearing read, so without this the
   * governed-target mismatch could reach an owner across client scope. It
   * re-derives the same `resolveToolScopeViolation` from the ACTUAL capability
   * and schema before any I/O.
   */
  private resolveAuxiliaryToolScopeViolation(
    dto: MeriV3ChatInput,
    schemas: readonly ToolSchema[],
    name: string,
    input: Record<string, unknown>,
  ): string | null {
    const schema = schemas.find((candidate) => candidate.name === name);
    const authority = this.resolveCapabilityAuthority(name, schema, dto);
    return this.resolveToolScopeViolation(dto, schema, authority, input);
  }

  /**
   * Confirm the exact prepared procedure against the API owner immediately
   * before dispatch. There is deliberately no cache, retry, or alternate
   * authority path; the authenticated API may only narrow the signed binding.
   */
  private async assertCurrentProcedureAuthority(
    conversationId: string | undefined,
    toolName: string,
    control?: ToolExecutionControl,
  ): Promise<void> {
    const procedure = currentGovernedMeriContext()?.procedure;
    if (!procedure) return;
    assertMeriProcedureToolDispatch({
      procedure,
      toolName,
      readOnly: this.registry.get(toolName)?.readOnly,
    });
    const creds = RequestCredentialsStore.get();
    if (!conversationId || !creds?.bearerToken || !this.serviceSecret) {
      throw new MeriProcedureBindingError(
        'Served procedure binding is invalid or no longer current',
      );
    }

    const execution = createMeriExecutionControl(control, PROCEDURE_AUTHORITY_TIMEOUT_MS);
    try {
      execution.assertActive();
      const response = await fetch(`${this.apiBaseUrl}/api/clio/procedure-runtime/validate`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${creds.bearerToken}`,
          'content-type': 'application/json',
          accept: 'application/json',
          'x-internal-service-secret': this.serviceSecret,
          ...(execution.deadlineAt ? { 'x-meri-deadline-at': String(execution.deadlineAt) } : {}),
          ...(creds.impersonateTenantId
            ? { 'x-capiro-impersonate-tenant': creds.impersonateTenantId }
            : {}),
        },
        body: JSON.stringify({
          conversationId,
          clientId: procedure.clientId,
          scope: procedure.scope,
          recordId: procedure.identity.recordId,
          canonicalId: procedure.identity.canonicalId,
          procedureVersion: procedure.identity.version,
          manifestDigest: procedure.manifestDigest,
          toolName,
        }),
        signal: execution.signal,
      });
      execution.assertActive();
      if (!response.ok) {
        throw new MeriProcedureBindingError(
          'Served procedure binding is invalid or no longer current',
        );
      }
      const decision = (await response.json()) as {
        authorized?: unknown;
        identity?: Record<string, unknown>;
        manifestDigest?: unknown;
      };
      execution.assertActive();
      if (
        decision.authorized !== true ||
        decision.identity?.source !== procedure.identity.source ||
        decision.identity.recordId !== procedure.identity.recordId ||
        decision.identity.canonicalId !== procedure.identity.canonicalId ||
        decision.identity.version !== procedure.identity.version ||
        decision.manifestDigest !== procedure.manifestDigest
      ) {
        throw new MeriProcedureBindingError(
          'Served procedure binding is invalid or no longer current',
        );
      }
    } catch {
      execution.assertActive();
      throw new MeriProcedureBindingError(
        'Served procedure binding is invalid or no longer current',
      );
    } finally {
      execution.dispose();
    }
  }

  private async assertCurrentAlternateReadAuthority(
    dto: MeriV3ChatInput,
    selectedSchemas: readonly ToolSchema[],
    toolName: string,
    control?: ToolExecutionControl,
  ): Promise<void> {
    assertToolExecutionActive(control);
    if (!selectedSchemas.some((schema) => schema.name === toolName)) {
      throw new Error(`Tool is not authorized for this turn: ${toolName}`);
    }
    const currentSchemas = await this.fetchToolSchemas(control);
    assertToolExecutionActive(control);
    const definition = this.registry.get(toolName);
    const metadata = this.registry.executionMetadata?.(toolName);
    if (
      !currentSchemas.some((schema) => schema.name === toolName) ||
      definition?.readOnly !== true ||
      metadata?.readOnly !== true ||
      metadata.executionMode !== 'read'
    ) {
      throw new Error(`Tool is not currently authorized as a read: ${toolName}`);
    }
    await this.assertCurrentProcedureAuthority(dto.conversationId, toolName, control);
    await this.assertResearchRunActive(dto, control);
    assertToolExecutionActive(control);
    const currentDefinition = this.registry.get(toolName);
    const currentMetadata = this.registry.executionMetadata?.(toolName);
    if (
      currentDefinition?.readOnly !== true ||
      currentMetadata?.readOnly !== true ||
      currentMetadata.executionMode !== 'read'
    ) {
      throw new Error(`Tool is not currently authorized as a read: ${toolName}`);
    }
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
    // Request-local, status-only catalog observer. Constructed INSIDE each run
    // and carried on the SAME control object the assistant already threads
    // through runTurn -> fetchToolSchemas -> managed reauth. It can never grant
    // authority; it only lets the provider request and final release stay
    // truthful when a requested source was unavailable.
    const runOpts: MeriV3RunOptions & MeriCatalogAvailabilityControl = {
      ...opts,
      signal: control.signal,
      deadlineAt: control.deadlineAt,
      requestSignal: opts.signal,
      catalogAvailability: createMeriCatalogAvailabilityObserver(),
    };
    try {
      return await this.runTurn(ctx, effectiveDto, runOpts);
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
   * and a large structured write â€” under Standard that gathers fine and
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
    const researchPlanExecution = requireMeriV3ResearchPlanExecution(dto, ctx);
    const admittedReadCapabilities = researchPlanExecution
      ? new Set(researchPlanExecution.allowedReadCapabilities)
      : null;
    const governed = currentGovernedMeriContext();
    const procedure = governed
      ? requireMeriProcedureBinding({ governed, dto, tenantId: ctx.tenantId })
      : null;
    const profile = resolveMeriV3ReasoningProfile(dto.reasoningMode);
    const runtimeBudget = MeriRunBudget.fromToolRoundCeiling(
      profile.maxToolRounds,
      opts,
      dto.researchRun ? this.durableProviderAccounting(dto.researchRun, opts) : undefined,
    );
    const budgetScope: MeriToolSignatureScope = {
      actorId: ctx.userId,
      tenantId: ctx.tenantId,
      clientId: dto.clientId ?? null,
      conversationId: dto.conversationId ?? null,
      runId: dto.researchRun?.runId ?? null,
    };
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

    const documentRequest = meriDocumentRequestFor(dto);
    const lastUserText = documentRequest?.request ?? this.lastUserText(dto);
    const literalAudit = buildLiteralAuditContext(dto.messages ?? []);
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
    // Stage 0-2 capabilities are enrolled by the turn's real surface. The release
    // gate and the evidence plan keep their existing chat-surface semantics.
    const surface = turnSurface(dto);
    const evidenceAccuracyMode = resolveEvidenceAccuracyMode(process.env, ctx.tenantId, surface);
    const autoCorrectionMode = this.resolveStage2Mode(
      AUTO_CORRECTION_CAPABILITY,
      ctx.tenantId,
      surface,
    );
    const autoCorrectionCategories = resolveAutoCorrectionCategories(process.env);
    if (autoCorrectionCategories.unknownTokens.length) {
      this.warnUnknownAutoCorrectionCategories(autoCorrectionCategories.unknownTokens);
    }
    const coverageRetrievalMode = this.resolveStage2Mode(
      COVERAGE_RETRIEVAL_CAPABILITY,
      ctx.tenantId,
      surface,
    );
    const passageSelectionMode = this.resolveStage2Mode(
      PASSAGE_SELECTION_CAPABILITY,
      ctx.tenantId,
      surface,
    );
    const claimAssessmentMode = resolveClaimAssessmentMode(process.env, ctx.tenantId, surface);
    const matchLabelMode = resolveMatchLabelMode(process.env, ctx.tenantId, surface);
    const clientFit = createClientFitClient({
      env: process.env,
      tenantId: ctx.tenantId,
      surface,
      logger: { warn: (event, fields) => this.logStructured('warn', event, fields ?? {}) },
      fetchImpl: runtimeBudget.budgetedFetch('selection'),
    });
    const buildEvidenceLedger = (
      input: Omit<
        Parameters<typeof buildControlledClaimLedger>[0],
        'env' | 'tenantId' | 'surface' | 'callSite' | 'logShadow'
      >,
      callSite: string,
      ledgerSurface: AssuranceSurface = surface,
    ) =>
      buildControlledClaimLedger({
        ...input,
        env: process.env,
        tenantId: ctx.tenantId,
        surface: ledgerSurface,
        callSite,
        logShadow: (event, fields) => this.logStructured('log', event, { ...fields }),
      });
    const statusProvenanceMode = resolveStatusProvenanceMode(process.env, ctx.tenantId, surface);
    const canary = new CanaryTurnCollector({
      conversationId: dto.conversationId ?? null,
      tenantId: ctx.tenantId,
      surface,
      modes: {
        evidenceAccuracy: evidenceAccuracyMode,
        claimAssessment: claimAssessmentMode,
        coverageRetrieval: coverageRetrievalMode,
        passageSelection: passageSelectionMode,
        autoCorrection: autoCorrectionMode,
        // The values that governed this turn, not the raw global environment.
        jevProvider: resolveJevProviderMode(process.env, ctx.tenantId, surface),
        routing: resolveJevConfig(process.env).routing,
      },
    });
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
      ...(literalAudit.instruction ? [literalAudit.instruction] : []),
      initialEvidence.citationPrompt,
    ].join('\n');

    const coverageRequirements =
      coverageRetrievalMode === 'off'
        ? []
        : buildCoverageRequirements({
            plan: evidencePlan,
            request: lastUserText,
            frame: operatingFrame,
            selectedDocumentIds: dto.selectedDocumentIds,
            clientId: dto.clientId,
          });
    const availabilityObserver = catalogAvailabilityObserverOf(opts);
    if (dto.toolPolicy === 'none') {
      // A deliberate whole-fetch skip is recorded as skipped, never as a fake
      // outage or a discovered-empty catalog.
      availabilityObserver?.noteNative({ outcome: 'skipped' });
      availabilityObserver?.noteManaged({ outcome: 'skipped' });
    }
    // Request-local relevance signals derived from the ACTUAL turn: the real
    // evidence plan and the canonical reads actually attempted. A retrieval
    // intent CLASS alone is deliberately NOT a signal here: a focused client
    // plus a bare history/prior/past (or other broad wording) word must not turn
    // creative/unrelated chat into an unavailable-private-record partial. A
    // genuinely record-dependent request is still relevant through the actual
    // plan (`planRequiresClientRecords`), an explicit record-phrasing request
    // (the request pattern inside `deriveCatalogAvailabilityRelevance`) or the
    // actual attempted canonical client-record read (`attemptedReads`) — the
    // primary signals. No new classifier or shared contract is introduced.
    const catalogRelevanceSignals = (): MeriCatalogAvailabilityRelevanceSignals => ({
      planRequiresClientRecords: evidencePlan.requirements.some((requirement) =>
        requirement.toolFamilies.some(
          (family) => family === 'read_client_documents' || family === 'get_client_context',
        ),
      ),
      attemptedReads: ledgerEntries.map((entry) => entry.tool),
    });
    const currentCatalogRelevance = (): MeriCatalogAvailabilityRelevance =>
      deriveCatalogAvailabilityRelevance(lastUserText, catalogRelevanceSignals());
    // Recompute the availability guidance at EVERY provider request from a FRESH
    // observer snapshot and FRESH request relevance, so a current failure
    // observed after the first round still reaches the second round and the
    // synthesis. The static instructions are never mutated: no stale block is
    // once-appended and no contradictory copies accumulate.
    const providerInstructions = (base: string): string => {
      const snapshot = availabilityObserver?.snapshot();
      if (!snapshot) return base;
      const block = meriCatalogAvailabilityInstruction(snapshot, currentCatalogRelevance());
      return block ? `${base}\n\n${block}` : base;
    };
    const toolSchemas =
      dto.toolPolicy === 'none'
        ? []
        : (await this.fetchToolSchemas(opts)).filter((schema) => {
            const authority = this.resolveCapabilityAuthority(schema.name, schema, dto);
            if (!authority) return false;
            if (dto.toolPolicy === 'read-only' && authority.readOnly !== true) return false;
            if (admittedReadCapabilities && !admittedReadCapabilities.has(schema.name))
              return false;
            return true;
          });
    // This tool reads a research snapshot, not client Files. Its session comes
    // from the authenticated research lease, never a guessed chat/client UUID.
    const leaseAuthorizedSchemas = toolSchemas.filter(
      (schema) => schema.name !== 'get_research_evidence' || Boolean(dto.researchRun),
    );
    const procedureSchemas = bindMeriProcedureSchemas({
      procedure,
      schemas: leaseAuthorizedSchemas,
      registry: this.registry,
    });
    const authorizedSchemas = procedureSchemas.schemas;
    const selectionContext = buildMeriGovernedToolSelectionContext({
      ctx,
      dto,
      request: lastUserText,
      authorizedNames: authorizedSchemas.map((schema) => schema.name),
      evidencePlan,
      coverageRequirements,
      governedContext: currentGovernedMeriContext(),
      documentReadRequired: Boolean(documentCompletion),
    });
    const selection = this.governedSemanticGateway.select({
      schemas: authorizedSchemas,
      tenantId: ctx.tenantId,
      request: lastUserText,
      recentUserContext: selectionContext.recentUserContext,
      plan: selectionContext.plan,
      protectedNames: [...selectionContext.protectedNames, ...procedureSchemas.requiredTools],
      discoveryNames: selectionContext.discoveryNames,
      allowCanonicalResearchDirector: false,
    });
    MeriV3SemanticRuntimeStore.recordDecision(selection.decision);
    let currentDiscoveryLookup: Promise<ToolSchema[]> | null = null;
    const resolveCurrentDiscoverySchemas = async (): Promise<ToolSchema[]> => {
      if (currentDiscoveryLookup) return currentDiscoveryLookup;
      const lookup = (async () => {
        try {
          assertToolExecutionActive(opts);
          const currentPlan = requireMeriV3ResearchPlanExecution(dto, ctx);
          const currentAdmitted = currentPlan ? new Set(currentPlan.allowedReadCapabilities) : null;
          await this.assertResearchRunActive(dto, opts);
          const currentCatalog =
            dto.toolPolicy === 'none'
              ? []
              : (await this.fetchToolSchemas(opts)).filter((schema) => {
                  const authority = this.resolveCapabilityAuthority(schema.name, schema, dto);
                  return Boolean(
                    authority &&
                    (dto.toolPolicy !== 'read-only' || authority.readOnly === true) &&
                    (!currentAdmitted || currentAdmitted.has(schema.name)) &&
                    (schema.name !== 'get_research_evidence' || dto.researchRun),
                  );
                });
          const currentGoverned = currentGovernedMeriContext();
          const currentProcedure = currentGoverned
            ? requireMeriProcedureBinding({
                governed: currentGoverned,
                dto,
                tenantId: ctx.tenantId,
              })
            : null;
          if (
            Boolean(currentProcedure) !== Boolean(procedure) ||
            (currentProcedure &&
              procedure &&
              (currentProcedure.manifestDigest !== procedure.manifestDigest ||
                currentProcedure.identity.recordId !== procedure.identity.recordId ||
                currentProcedure.identity.version !== procedure.identity.version))
          ) {
            return [];
          }
          return bindMeriProcedureSchemas({
            procedure: currentProcedure,
            schemas: currentCatalog,
            registry: this.registry,
          }).schemas;
        } catch {
          return [];
        }
      })();
      currentDiscoveryLookup = lookup;
      try {
        return await lookup;
      } finally {
        if (currentDiscoveryLookup === lookup) currentDiscoveryLookup = null;
      }
    };
    const authorizeCurrentDiscoverySchema = async (schema: ToolSchema): Promise<boolean> => {
      try {
        assertToolExecutionActive(opts);
        const authority = this.resolveCapabilityAuthority(schema.name, schema, dto);
        if (
          !authority ||
          dto.toolPolicy === 'none' ||
          (dto.toolPolicy === 'read-only' && authority.readOnly !== true) ||
          (admittedReadCapabilities && !admittedReadCapabilities.has(schema.name)) ||
          (schema.name === 'get_research_evidence' && !dto.researchRun)
        ) {
          return false;
        }
        assertMeriProcedureToolDispatch({
          procedure: currentGovernedMeriContext()?.procedure,
          toolName: schema.name,
          readOnly: authority.readOnly,
        });
        await this.assertCurrentProcedureAuthority(dto.conversationId, schema.name, opts);
        return true;
      } catch {
        return false;
      }
    };
    const progressiveDiscovery = new MeriProgressiveToolDiscovery({
      // Legacy and shadow remain behavior-identical. Progressive disclosure is
      // served only where the existing enabled selector already narrows schemas.
      authorizedSchemas:
        selection.decision.mode === 'enabled' ? authorizedSchemas : selection.schemas,
      exposedSchemas: selection.schemas,
      budget: runtimeBudget,
      resolveCurrentSchemas: resolveCurrentDiscoverySchemas,
      authorizeCurrentSchema: authorizeCurrentDiscoverySchema,
    });
    let availableSchemas = progressiveDiscovery.exposedSchemas();
    this.logStructured('log', 'meri.semantic_tool_gateway.selection', {
      decisionId: selection.decision.decisionId,
      mode: selection.decision.mode,
      requestedNames: selection.decision.requestedNames,
      requestedCount: selection.decision.requestedNames.length,
      selectedNames: selection.decision.selectedNames,
      selectedCount: selection.decision.selectedNames.length,
      exposedNames: selection.decision.exposedNames,
      exposedCount: selection.decision.exposedNames.length,
      invokedNames: [],
      invokedCount: 0,
      result: selection.decision.fallbackToLegacy ? 'fallback_legacy' : 'selected',
    });
    const configIdentity = meriTelemetryConfigIdentity({
      runtime: 'meriv3',
      profile: {
        model: profile.model,
        mode: profile.mode,
        effort: profile.effort,
        maxOutputTokens: profile.maxOutputTokens,
        maxToolRounds: profile.maxToolRounds,
      },
      toolPolicy: dto.toolPolicy ?? 'default',
      exposedTools: availableSchemas.map((schema) => schema.name).sort(),
      assuranceMode,
      evidenceAccuracyMode,
    });
    setMeriTelemetryConfigIdentity(configIdentity);
    emitMeriOrchestratorTelemetry({
      name: 'meri.orchestrator.tools.selected',
      boundary: 'turn',
      runtime: 'meriv3',
      provider: 'openai',
      requestedModel: profile.model,
      effectiveModel: profile.model,
      clientId: dto.clientId ?? null,
      selectedTools: selection.schemas.map((schema) => schema.name),
      exposedTools: availableSchemas.map((schema) => schema.name),
      childRunId: dto.researchRun?.runId ?? null,
      outcome: 'selected',
    });

    let tools = [...availableSchemas, ...progressiveDiscovery.controlSchemas()].map(
      anthropicSchemaToResponsesTool,
    );
    const verificationAvailable = availableSchemas.length > 0;
    const input: Array<Record<string, unknown>> = [...initialInput];
    const steps: ChatStep[] = [];
    const toolCoverage: MeriToolCoverageReceipt[] = [];
    const pendingApprovals: NonNullable<MeriV3ChatResult['pendingApprovals']> = [];
    const artifacts: ChatArtifact[] = [];
    const citations: MeriCitation[] = [...initialEvidence.citations];
    const ledgerEntries: LedgerEntry[] = [...initialEvidence.ledgerEntries];
    // Request-local binding from EACH ledger entry to the concrete accepted
    // citations that entry itself produced (or, for a seed entry, the request-
    // authenticated seed citations bound by its seed identity). The bounded final
    // release reads ONLY these bound objects, so a later unavailable result of
    // the SAME tool can never be restored from an earlier healthy call, an inner
    // owner citation is never missed because its `tool` differs from the outer
    // host name, and no owner-supplied `origin` string can forge a seed. This is
    // an internal per-request map — no shared/Core shape is introduced.
    const ledgerCitationBindings = new Map<LedgerEntry, readonly MeriCitation[]>();
    for (const seedEntry of initialEvidence.ledgerEntries) {
      ledgerCitationBindings.set(
        seedEntry,
        initialEvidence.citations.filter((citation) => citation.tool === seedEntry.tool),
      );
    }
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
        const claimLedger = buildEvidenceLedger(
          {
            output: body,
            ledgerEntries,
            citations,
            plan: evidencePlan,
          },
          'prePersistRefusal',
          'memo',
        );
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
    let providerCallRepairs = 0;
    let automaticReads = 0;
    let residualCoverageGaps: CoverageGap[] = [];
    let latestCoverageGaps: CoverageGap[] = [];
    let coverageResynthesized = false;
    let documentRequests = 0;
    const MAX_AUTOMATIC_DOCUMENT_READS = 24;
    const canReadDocuments =
      availableSchemas.some((schema) => schema.name === 'read_client_documents') &&
      this.registry.get('read_client_documents')?.readOnly === true;

    const executeCalls = async (calls: OpenAiResponsesFunctionCall[]) => {
      // A schema loaded by describe is eligible only on the next provider
      // request. A hidden leaf emitted in the same batch remains undeclared.
      const schemasAtRoundStart = [...availableSchemas];
      const executionByCallId = new Map<string, FunctionExecution>();
      const leafCalls: OpenAiResponsesFunctionCall[] = [];
      for (const call of calls) {
        if (!progressiveDiscovery.handles(call.name)) {
          leafCalls.push(call);
          continue;
        }
        let outcome;
        try {
          outcome = await progressiveDiscovery.execute(call.name, parseArguments(call.arguments));
        } catch {
          outcome = {
            result: { error: 'Progressive discovery arguments were invalid.' },
            matchedNames: [],
            loadedNames: [],
            resultCode: 'invalid_arguments',
          };
        }
        const serialized = JSON.stringify(outcome.result);
        executionByCallId.set(call.call_id, { call, result: outcome.result, serialized });
        availableSchemas = progressiveDiscovery.exposedSchemas();
        tools = [...availableSchemas, ...progressiveDiscovery.controlSchemas()].map(
          anthropicSchemaToResponsesTool,
        );
        const observedNames = [...outcome.matchedNames, ...outcome.loadedNames];
        this.logStructured('log', 'meri.semantic_tool_gateway.discovery', {
          decisionId: selection.decision.decisionId,
          operation: call.name,
          requestedNames: [],
          requestedCount: call.name === 'tool_search' ? 0 : 1,
          selectedNames: observedNames,
          selectedCount: observedNames.length,
          exposedNames: availableSchemas.map((schema) => schema.name),
          exposedCount: availableSchemas.length,
          invokedNames: [call.name],
          invokedCount: 1,
          observedNames,
          observedCount: observedNames.length,
          result: outcome.resultCode,
        });
      }
      const leafExecutions = leafCalls.length
        ? await this.executeFunctionCalls({
            ctx,
            dto,
            calls: leafCalls,
            schemas: schemasAtRoundStart,
            steps,
            toolCoverage,
            pendingApprovals,
            artifacts,
            citations,
            ledgerEntries,
            ledgerCitationBindings,
            toolsUsed,
            emit,
            prePersistRefusal,
            noteComplianceOutcome,
            evidenceAccuracyMode,
            control: opts,
            runtimeBudget,
            budgetScope,
            semanticDecisionId: selection.decision.decisionId,
            admittedReadCapabilities,
            isProgressivelyLoaded: (name) => progressiveDiscovery.isLoaded(name),
            resolveCurrentDiscoverySchemas,
            authorizeCurrentDiscoverySchema,
          })
        : [];
      for (const execution of leafExecutions) {
        executionByCallId.set(execution.call.call_id, execution);
      }
      const executions = calls.flatMap((call) => {
        const execution = executionByCallId.get(call.call_id);
        return execution ? [execution] : [];
      });
      gatheredToolOutput = gatheredToolOutput || leafExecutions.length > 0;
      for (const execution of executions) {
        const discoveryControl = progressiveDiscovery.handles(execution.call.name);
        if (!discoveryControl) MeriV3ResearchRuntimeStore.observeToolResult(execution.result);
        input.push({
          type: 'function_call_output',
          call_id: execution.call.call_id,
          output: execution.serialized,
        });
        const executionCitations = extractCitationsFromToolResult(
          execution.call.name,
          execution.result,
          1,
        );
        const executionCoverage = observeMeriTurnToolCoverage(
          execution.call.name,
          execution.result,
        );
        if (discoveryControl) continue;
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
        !runtimeBudget.acquisitionStopped &&
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

    const turnDeadlineAt = (): number => opts.deadlineAt ?? startedAt + profile.turnBudgetMs;
    const unselectedEvidence = (): SelectedSynthesisEvidence => ({
      input,
      instructions,
      applied: false,
    });

    /**
     * Stage 2b. Judges the passages of the forced-synthesis request and, in
     * enforce, rebuilds it without dropped evidence. Any failure short of turn
     * cancellation degrades to the unfiltered request.
     */
    const selectSynthesisEvidence = async (): Promise<SelectedSynthesisEvidence> => {
      const selectionStartedAt = Date.now();
      try {
        const candidates = buildPassageCandidates({
          ledgerEntries,
          citations,
          // The plan pin protects required evidence in every coverage mode;
          // satisfied essential coverage gaps add their evidence ids on top.
          requiredToolFamilies: evidencePlan.requirements
            .filter((requirement) => requirement.level === 'required')
            .flatMap((requirement) => requirement.toolFamilies),
          requiredPassageIds: latestCoverageGaps
            .filter((gap) => gap.essential && gap.status === 'satisfied')
            .flatMap((gap) => gap.evidenceIds),
          documentReferencePassageIds: citations
            .filter((citation) => {
              const evidence = citation.documentEvidence;
              if (!evidence) return false;
              return (
                dto.selectedDocumentIds?.includes(evidence.documentId) ||
                coverageRequirements.some(
                  (requirement) => requirement.route?.documentId === evidence.documentId,
                )
              );
            })
            .flatMap((citation) => [
              citation.id,
              ...(citation.stableId ? [citation.stableId] : []),
            ]),
          userSelectedDocumentIds: dto.selectedDocumentIds,
        });
        const provider = createPassageSelectionClient({
          env: process.env,
          tenantId: ctx.tenantId,
          surface: 'chat',
          logger: this.structuredLogger,
          fetchImpl: runtimeBudget.budgetedFetch('selection'),
        });
        const remainingMs = turnDeadlineAt() - selectionStartedAt;
        const answers = await askPassageQuestions({
          question: lastUserText,
          clientId: dto.clientId,
          candidates,
          provider: provider.client,
          providerUnavailableReason: provider.reason,
          signal: opts.signal,
          // Observe the turn deadline and keep a synthesis floor free of selection.
          deadlineAt: Math.min(
            turnDeadlineAt(),
            selectionStartedAt + Math.max(0, remainingMs - 1_000),
          ),
        });
        const selection = selectPassages({ candidates, answers });
        const rebuilt = rebuildSynthesisEvidence({
          input,
          baseInstructions: instructions,
          citationPrompt: initialEvidence.citationPrompt,
          candidates,
          kept: selection.kept,
        });
        const fallback = selection.fallback || rebuilt.fallback;
        const requiredCount = candidates.filter((candidate) => candidate.required).length;
        // Retention is measured on the rebuilt request, not on the candidate list.
        const requiredRetained = rebuilt.retainedRequired;
        const evidenceRecall = requiredCount ? requiredRetained / requiredCount : 1;
        if (evidenceRecall !== 1) {
          throw new Error('Passage selection required-evidence recall invariant failed');
        }
        const changed =
          rebuilt.removedCallIds.length > 0 || rebuilt.prunedCitationNumbers.length > 0;
        const applied = passageSelectionMode === 'enforce' && !fallback && changed;
        const conflictCandidates = candidates.filter(
          (candidate) => candidate.deterministicConflict,
        ).length;
        const latencyMs = Date.now() - selectionStartedAt;
        const costUsd = answers.inputTokens * PASSAGE_SELECTION_MODEL_PRICE_PER_INPUT_TOKEN;
        this.logStructured('log', 'meri.passage_selection', {
          conversationId: dto.conversationId ?? null,
          mode: passageSelectionMode,
          candidates: candidates.length,
          kept: selection.kept.length,
          dropped: selection.dropped.length,
          retainedRequired: requiredRetained,
          retainedUserSelected: rebuilt.retainedUserSelected,
          retainedContradictory: selection.retainedContradictory,
          evidenceRecall,
          conflictRetention: conflictCandidates
            ? selection.retainedContradictory / conflictCandidates
            : 1,
          fallback,
          fallbackReason: answers.fallbackReason ?? rebuilt.fallbackReason ?? null,
          removedCalls: rebuilt.removedCallIds.length,
          prunedCitations: rebuilt.prunedCitationNumbers.length,
          unremovable: rebuilt.unremovable,
          applied,
          // Prompt size from the request's text fields; never a serialization pass.
          promptCharsBefore: instructions.length + promptTextChars(input),
          promptCharsAfter: rebuilt.instructions.length + promptTextChars(rebuilt.input),
          latencyMs,
          inputTokens: answers.inputTokens,
          estimatedCostUsd: costUsd,
          registryVersion: JEV_TASK_REGISTRY_VERSION,
          task: {
            questionVersion: PASSAGE_SELECTION_QUESTION_VERSION,
            modelVersion: JEV_TASK_REGISTRY.passage_relevance.modelVersion,
          },
          questionVersion: answers.questionVersion,
          model: answers.model || provider.model,
        });
        canary.notePassageSelection({
          candidates: candidates.length,
          kept: selection.kept.length,
          dropped: selection.dropped.length,
          requiredCandidates: requiredCount,
          requiredRetained,
          contradictoryRetained: selection.retainedContradictory,
          fallback,
          safetyIntervention: {
            evaluated: true,
            intervened: selection.safetyIntervention.intervened || rebuilt.fallback,
            reasons: [
              ...selection.safetyIntervention.reasons,
              ...(rebuilt.fallback
                ? [`fallback_unfiltered:${rebuilt.fallbackReason ?? 'rebuild_failed'}`]
                : []),
            ],
          },
          latencyMs,
          tokens: answers.inputTokens,
          costUsd,
        });
        const selected = applyPassageSelectionToSynthesis({
          mode: passageSelectionMode,
          originalInput: input,
          originalInstructions: instructions,
          rebuilt,
          fallback: selection.fallback,
        });
        return { input: selected.input, instructions: selected.instructions, applied };
      } catch (error) {
        if (isTurnAbortError(error, opts.signal)) throw error;
        this.logStructured('warn', 'meri.passage_selection.failed', {
          conversationId: dto.conversationId ?? null,
          mode: passageSelectionMode,
          reason: errorReason(error),
          latencyMs: Date.now() - selectionStartedAt,
        });
        return unselectedEvidence();
      }
    };

    const runForcedSynthesis = async (
      reason: string,
      evidence?: SelectedSynthesisEvidence,
    ): Promise<string> => {
      assertToolExecutionActive(opts);
      await this.assertResearchRunActive(dto, opts);
      const selected =
        evidence ??
        (passageSelectionMode !== 'off' ? await selectSynthesisEvidence() : unselectedEvidence());
      // Selection time is charged to the turn: the synthesis timeout is computed
      // from the deadline after selection, never from a pre-selection remainder.
      const timeoutMs = Math.max(1, turnDeadlineAt() - Date.now());
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
        instructions: [
          providerInstructions(selected.instructions),
          finishInstructions(),
          ...(runtimeBudget.acquisitionStopped ? [runtimeBudget.partialInstruction()] : []),
        ].join('\n\n'),
        input: selected.input,
        tools: [],
        toolChoice: 'none',
        timeoutMs,
        deadlineAt: opts.deadlineAt,
        ...(opts.signal ? { signal: opts.signal } : {}),
        safetyIdentifier: safetyIdentifier(ctx),
        budget: runtimeBudget,
        budgetPhase: 'synthesis',
      });
      recordProviderResult(synthesis);
      addUsage(usage, synthesis.usage);
      canary.noteSynthesis(
        synthesis.usage.inputTokens + synthesis.usage.outputTokens,
        computeAiCostUsd(
          synthesis.model,
          synthesis.usage.inputTokens,
          synthesis.usage.outputTokens,
        ),
      );
      void this.meterRound(ctx, synthesis.model, synthesis.usage, synthesis.usedTenantKey);
      const boundaryFailure = completedTextResponseFailure(synthesis);
      if (boundaryFailure) throw new ForcedSynthesisBoundaryError(boundaryFailure);
      return synthesis.outputText;
    };

    try {
      await continueDocumentReads();
      for (rounds = 0; rounds < profile.maxToolRounds; rounds += 1) {
        assertToolExecutionActive(opts);
        if (runtimeBudget.acquisitionStopped) break;
        await this.assertResearchRunActive(dto, opts);
        await progressiveDiscovery.refreshLoaded();
        availableSchemas = progressiveDiscovery.exposedSchemas();
        tools = [...availableSchemas, ...progressiveDiscovery.controlSchemas()].map(
          anthropicSchemaToResponsesTool,
        );
        const remainingMs = (opts.deadlineAt ?? startedAt + profile.turnBudgetMs) - Date.now();
        // Stop opening new gather rounds once only the synthesis reserve remains.
        if (remainingMs <= reserveMs) break;

        const response = await this.openai.complete({
          profile,
          instructions: providerInstructions(instructions),
          input,
          tools,
          toolChoice: 'auto',
          // Clamp each gather call so it cannot eat the reserved synthesis window.
          timeoutMs: Math.max(15_000, remainingMs - reserveMs),
          deadlineAt: opts.deadlineAt,
          ...(opts.signal ? { signal: opts.signal } : {}),
          safetyIdentifier: safetyIdentifier(ctx),
          budget: runtimeBudget,
          budgetPhase: 'acquisition',
        });
        recordProviderResult(response);
        assertToolExecutionActive(opts);
        addUsage(usage, response.usage);
        canary.noteSynthesis(
          response.usage.inputTokens + response.usage.outputTokens,
          computeAiCostUsd(response.model, response.usage.inputTokens, response.usage.outputTokens),
        );
        void this.meterRound(ctx, response.model, response.usage, response.usedTenantKey);

        const providerCallBoundaryFailed =
          response.status !== 'completed' ||
          response.incompleteReason != null ||
          response.telemetry.finishReason === 'incomplete_function_call' ||
          response.telemetry.finishReason === 'malformed_function_call' ||
          !functionCallBatchIsComplete(response.functionCalls);
        if (providerCallBoundaryFailed) {
          if (
            providerCallRepairs < 1 &&
            rounds + 1 < profile.maxToolRounds &&
            (opts.deadlineAt ?? startedAt + profile.turnBudgetMs) - Date.now() > reserveMs
          ) {
            providerCallRepairs++;
            input.push({
              role: 'developer',
              content:
                'The previous provider response was incomplete or contained an invalid function call. Start that response again. Do not reuse or present partial prose. Emit only complete function calls with unique call IDs and valid JSON-object arguments.',
            });
            continue;
          }
          finalText =
            'I could not complete this response, so I did not execute any calls from the incomplete provider turn. Please ask me to continue.';
          break;
        }

        // The Responses API requires completed reasoning/function-call output
        // items to be replayed on the next request. Incomplete output is never
        // replayed, emitted to the browser, or persisted as a message/audit body.
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
              '\n\n_(I reached this modeâ€™s output limit. Ask me to continue if needed.)_';
          }
          break;
        }

        await executeCalls(response.functionCalls);
        await continueDocumentReads();
        if (runtimeBudget.acquisitionStopped) break;
      }

      if (coverageRetrievalMode !== 'off' && !runtimeBudget.acquisitionStopped) {
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
        let followUp = planFollowUp({
          gaps,
          requirements: coverageRequirements,
          toolSchemas: readOnlySchemas,
          request: lastUserText,
          frame: operatingFrame,
          ledgerEntries,
        });
        let followUpPlanned = followUp?.calls.length ?? 0;
        let executed = 0;
        const attempted = new Set<string>();
        if (coverageRetrievalMode === 'enforce' && followUp) {
          while (followUp && executed < 8) {
            let roundExecuted = 0;
            for (const planned of followUp.calls) {
              if (executed >= 8) break;
              const remainingMs =
                (opts.deadlineAt ?? startedAt + profile.turnBudgetMs) - Date.now();
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
              roundExecuted++;
            }
            gaps = compareCoverage({
              requirements: coverageRequirements,
              toolsUsed,
              receipts: toolCoverage,
              ledgerEntries,
              citations,
            });
            if (!gaps.some((gap) => gap.essential && gap.status !== 'satisfied')) break;
            const nextFollowUp = planFollowUp({
              gaps,
              requirements: coverageRequirements,
              toolSchemas: readOnlySchemas,
              request: lastUserText,
              frame: operatingFrame,
              ledgerEntries,
            });
            followUpPlanned += nextFollowUp?.calls.length ?? 0;
            followUp = nextFollowUp;
            if (roundExecuted === 0) break;
          }
          gaps = compareCoverage({
            requirements: coverageRequirements,
            toolsUsed,
            receipts: toolCoverage,
            ledgerEntries,
            citations,
          });
          // The prior prose was produced before the server-coordinated evidence
          // arrived. Force one no-tools synthesis over the augmented input. A
          // completed answer already in `finalText` is protected the same way
          // as the passage-selection block below: on any synthesis failure the
          // turn releases the prose the model already produced, never a generic
          // failure/timeout message (contract: a Stage 2 failure degrades to
          // legacy, it never turns a working answer into no answer). Passage
          // selection (when enforce) runs inside this same synthesis call via
          // runForcedSynthesis's own selectSynthesisEvidence() call, so the
          // later passage-selection block is skipped once this one already
          // produced (or safely restored) text.
          if (executed > 0) {
            const preCoverageText = finalText;
            finalText = '';
            if (preCoverageText) {
              try {
                const rewritten = await runForcedSynthesis('coverage follow-up added evidence');
                if (rewritten.trim()) {
                  finalText = rewritten;
                  coverageResynthesized = true;
                } else {
                  this.logStructured('warn', 'meri.coverage.failed', {
                    conversationId: dto.conversationId ?? null,
                    mode: coverageRetrievalMode,
                    reason: 'empty_synthesis',
                    keptCompletedProse: true,
                  });
                  finalText = preCoverageText;
                  coverageResynthesized = true;
                }
              } catch (error) {
                if (isTurnAbortError(error, opts.signal)) throw error;
                this.logStructured('warn', 'meri.coverage.failed', {
                  conversationId: dto.conversationId ?? null,
                  mode: coverageRetrievalMode,
                  reason: errorReason(error),
                  keptCompletedProse: true,
                });
                finalText = preCoverageText;
                coverageResynthesized = true;
              }
            }
          }
        }
        const essentialResiduals = gaps.filter(
          (gap) => gap.essential && gap.status !== 'satisfied',
        );
        residualCoverageGaps = coverageRetrievalMode === 'enforce' ? essentialResiduals : [];
        latestCoverageGaps = gaps;
        canary.noteCoverage({
          gaps: gaps.filter((gap) => gap.status !== 'satisfied').length,
          followUps: executed,
          residual: essentialResiduals.length,
          latencyMs: Date.now() - coverageStartedAt,
          retrievalToolCalls: executed,
        });
        this.logStructured('log', 'meri.coverage.turn', {
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
          followUpPlanned,
          executed,
          satisfiedAfter: gaps.filter((gap) => gap.status === 'satisfied').length,
          changedAnswer:
            coverageRetrievalMode === 'enforce' &&
            essentialResiduals.some((gap) => gap.materiality === 'changes_answer'),
          durationMs: Date.now() - coverageStartedAt,
          mode: coverageRetrievalMode,
        });
      }

      // Coverage and its follow-up evidence must exist before enforce selection.
      // Shadow remains output-identical and observes selection on forced-synthesis
      // turns only, so it never delays a completed answer. Enforce re-synthesizes
      // only when the verified rebuild actually removed evidence, and a failed
      // re-synthesis releases the prose the model had already completed.
      // Skipped when the coverage follow-up above already ran a governed forced
      // synthesis (it calls selectSynthesisEvidence() internally): re-running
      // Jev scoring here would be redundant and would pay for a second synthesis
      // call on a request whose evidence set has not changed since.
      if (
        passageSelectionMode === 'enforce' &&
        finalText &&
        !coverageResynthesized &&
        !opts.signal?.aborted
      ) {
        const preSelectionText = finalText;
        try {
          const selected = await selectSynthesisEvidence();
          if (selected.applied) {
            const rewritten = await runForcedSynthesis(
              'passage selection removed evidence from the synthesis request',
              selected,
            );
            if (rewritten.trim()) finalText = rewritten;
            else {
              this.logStructured('warn', 'meri.passage_selection.failed', {
                conversationId: dto.conversationId ?? null,
                mode: passageSelectionMode,
                reason: 'empty_synthesis',
                keptCompletedProse: true,
              });
            }
          }
        } catch (error) {
          if (isTurnAbortError(error, opts.signal)) throw error;
          this.logStructured('warn', 'meri.passage_selection.failed', {
            conversationId: dto.conversationId ?? null,
            mode: passageSelectionMode,
            reason: errorReason(error),
            keptCompletedProse: true,
          });
          finalText = preSelectionText;
        }
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
      else if (error instanceof ForcedSynthesisBoundaryError) {
        telemetry = {
          ...telemetry,
          partial: true,
          finishReason: 'incomplete_synthesis_response',
        };
        finalText = incompleteSynthesisPartialReply(ledgerEntries);
      } else if (
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
      } else if (
        !finalText &&
        (error instanceof MeriRunBudgetExhaustedError || runtimeBudget.acquisitionStopped)
      ) {
        try {
          finalText = await runForcedSynthesis('aggregate runtime bound reached');
        } catch (synthesisError) {
          this.logger.error(
            `MeriV3 bounded partial synthesis failed: ${
              synthesisError instanceof Error ? synthesisError.message : String(synthesisError)
            }`,
          );
          finalText = boundedPartialReply(runtimeBudget.reason, ledgerEntries);
        }
      } else {
        this.logger.error(
          `MeriV3 model loop failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        finalText =
          'I could not complete this turn because the MeriV3 reasoning runtime was unavailable. No unapproved action was executed.';
      }
    }

    if (
      runtimeBudget.acquisitionStopped &&
      runtimeBudget.reason !== 'cancelled' &&
      runtimeBudget.reason !== 'deadline'
    ) {
      telemetry = {
        ...telemetry,
        partial: true,
        finishReason: `runtime_${runtimeBudget.reason}`,
      };
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
          ? 'I reached this turnâ€™s time limit before completing the answer. Ask me to continue from the evidence collected so far.'
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

    // The single text emission is decided from the state at finalization. The
    // bounded repair stage below can neither hold, empty, nor suppress it.
    const emitText =
      Boolean(released.reply) &&
      (!opts.signal?.aborted || telemetry.finishReason === 'deadline_exceeded');

    if (
      autoCorrectionMode !== 'off' &&
      released.reply &&
      autoCorrectionCategories.categories.size &&
      !runtimeBudget.acquisitionStopped
    ) {
      const corrected = await this.applyBoundedAutoCorrection({
        ctx,
        dto,
        opts,
        mode: autoCorrectionMode,
        categories: autoCorrectionCategories.categories,
        released,
        ledgerEntries,
        citations,
        evidencePlan,
        assuranceRisk,
        assuranceMode,
        complianceOutcome,
        verificationAvailable,
        coverageRequirements,
        residualCoverageGaps,
        availableSchemas,
        lastUserText,
        evidenceAccuracyMode,
        synthesisModel: actualModel,
        canary,
        runtimeBudget,
        budgetScope,
        admittedReadCapabilities,
      });
      released = { ...released, reply: corrected.reply, citations: corrected.citations };
      documentRequests = corrected.documentRequests;
    }

    if (literalAudit.priorAnswer && released.reply) {
      const auditValidation = validateLiteralAuditCorrections(
        released.reply,
        literalAudit.priorAnswer,
      );
      if (!auditValidation.valid) {
        this.logStructured('warn', 'meri.audit_literal_contract.blocked', {
          conversationId: dto.conversationId ?? null,
          issues: auditValidation.issues.map((issue) => issue.code),
        });
        released = {
          reply: [
            'I could not safely release this audit because it attempted to retract a statement that does not appear literally in the preceding answer.',
            'The prior answer remains unchanged. Rerun the audit so every proposed correction quotes the exact earlier wording and cites the source for the replacement.',
          ].join('\n\n'),
          citations: [],
          held: true,
        };
      }
    }

    if (matchLabelMode === 'enforce' && released.reply) {
      const started = Date.now();
      const matchLedger = buildEvidenceLedger(
        {
          output: released.reply,
          ledgerEntries,
          citations: released.citations,
          plan: evidencePlan,
        },
        'matchLabelEnforce',
      );
      let matchResult = await applyMatchLabelControl({
        mode: 'enforce',
        reply: released.reply,
        citations: released.citations,
        evidence: matchLedger.evidence,
        ...(!runtimeBudget.acquisitionStopped && clientFit.client
          ? {
              evaluate: createClientFitEvaluator({
                provider: clientFit.client,
                tenantId: ctx.tenantId,
                deadlineAt: started + 8_000,
                signal: opts.signal,
              }),
            }
          : {}),
      });
      // A model-budget failure must not turn enforce into pass-through. Local
      // evidence derivation remains valid after aggregate acquisition stops.
      if (matchResult.failureReason) {
        matchResult = await applyMatchLabelControl({
          mode: 'enforce',
          reply: released.reply,
          citations: released.citations,
          evidence: matchLedger.evidence,
        });
      }
      released = { ...released, reply: matchResult.reply };
      if (matchResult.failureReason) {
        this.logStructured('warn', 'meri.match_label.failed', {
          reason: matchResult.failureReason,
          latencyMs: Date.now() - started,
        });
      }
    }

    if (statusProvenanceMode === 'enforce' && released.reply) {
      const retainedStatusResults = ledgerEntries
        .filter((entry) => entry.tool === 'get_certification_status')
        .map((entry) => entry.result);
      let statusResult = runtimeBudget.acquisitionStopped
        ? enforceRetainedStatusProvenance({
            reply: released.reply,
            retainedResults: retainedStatusResults,
          })
        : await runStatusProvenance({
            reply: released.reply,
            mode: 'enforce',
            registry: withToolBudget(
              this.registry,
              runtimeBudget,
              budgetScope,
              async (name, input, control) => {
                await this.assertCurrentAlternateReadAuthority(
                  dto,
                  availableSchemas,
                  name,
                  control,
                );
                await this.reserveAuxiliaryResearchDispatch(
                  dto,
                  name,
                  input,
                  `status:${runtimeBudget.toolSignature(budgetScope, name, input)}`,
                  control,
                );
              },
              admittedReadCapabilities,
            ),
            ctx,
            deadlineAt: Math.min(opts.deadlineAt ?? Date.now() + 8_000, Date.now() + 8_000),
            signal: opts.signal,
          });
      // If authoritative lookup cannot fit or fails, use retained evidence and
      // qualify unsupported claims rather than silently passing them through.
      if (!statusResult.lookupOk) {
        statusResult = enforceRetainedStatusProvenance({
          reply: released.reply,
          retainedResults: retainedStatusResults,
        });
      }
      released = { ...released, reply: statusResult.reply };
      if (!statusResult.lookupOk) {
        this.logStructured('warn', 'meri.status_provenance.failed', {
          reason: statusResult.failureReason,
          latencyMs: statusResult.latencyMs,
        });
      }
    }

    // Final release truthfulness. The provider is NOT trusted to obey the
    // instruction, so when a relevant required source was unavailable this turn
    // we do not release the provider's free-form prose at all: appending a
    // disclaimer would leave an unsupported consulted-record claim in place. We
    // instead release a bounded, fixed limitation plus only the genuinely
    // supported findings already retained from completed reads. Deliberate
    // disabled/skipped/no_eligible and unrelated failures never doom an answer.
    if (released.reply && availabilityObserver) {
      const finalSnapshot = availabilityObserver.snapshot();
      const limitation = meriCatalogAvailabilityReleaseNote(
        finalSnapshot,
        currentCatalogRelevance(),
        { seededEvidencePresent: initialEvidence.citations.length > 0 },
      );
      if (limitation) {
        // The bounded fallback DISCARDS the provider prose, so it replaces the
        // reply and its citations: the released citations become exactly the
        // genuine supported citations the bounded reply actually rendered (with
        // their original identities/numbers). `released.citations` from
        // finalizeReply is marker-filtered against the now-discarded provider
        // prose, so it would otherwise leave the bounded reply's seeded `[9]`
        // marker dangling (and could carry an unrelated provider citation).
        const bounded = buildBoundedCatalogAvailabilityReply(limitation, ledgerEntries, {
          seedEntries: initialEvidence.ledgerEntries,
          ledgerCitationBindings,
        });
        // COMPOSE, do not blanket-replace: a genuine server-owned document
        // completion gap ("The relevant text in ... has not been fully
        // reviewed.") that finalizeReply already carried must survive alongside
        // the source-specific limitation. Only the fixed, server-owned
        // `documentCompletion.gaps()` strings are re-disclosed here — never the
        // discarded provider prose and never a serialized failed-owner body.
        const completionDisclosure =
          completionGaps.length && !opts.signal?.aborted
            ? [`**Partial answer:** ${completionGaps.join(' ')}`]
            : [];
        released = {
          ...released,
          reply: [...completionDisclosure, bounded.reply].join('\n\n'),
          citations: bounded.citations,
        };
      }
    }

    if (emitText && released.reply) {
      emit({ type: 'text', text: released.reply });
      canary.noteTextEmitted();
    }
    if (matchLabelMode === 'shadow' && released.reply) {
      const reply = released.reply;
      const releasedCitations = released.citations;
      const started = Date.now();
      queueMicrotask(() => {
        void Promise.resolve()
          .then(async () => {
            const matchLedger = buildEvidenceLedger(
              {
                output: reply,
                ledgerEntries,
                citations: releasedCitations,
                plan: evidencePlan,
              },
              'matchLabelShadow',
            );
            const result = await applyMatchLabelControl({
              mode: 'shadow',
              reply,
              citations: releasedCitations,
              evidence: matchLedger.evidence,
              ...(clientFit.client
                ? {
                    evaluate: createClientFitEvaluator({
                      provider: clientFit.client,
                      tenantId: ctx.tenantId,
                      deadlineAt: started + 8_000,
                      signal: opts.signal,
                    }),
                  }
                : {}),
            });
            if (result.findings > 0) {
              this.logStructured(
                'log',
                'meri.match_label.shadow',
                matchLabelEvent(result, Date.now() - started),
              );
            }
          })
          .catch(() => undefined);
      });
    }
    const canaryEvent = canary.build({
      outcome:
        opts.signal?.aborted && telemetry.finishReason !== 'deadline_exceeded'
          ? 'aborted'
          : released.held
            ? 'held'
            : telemetry.finishReason === 'runtime_error'
              ? 'error'
              : telemetry.finishReason === 'deadline_exceeded'
                ? 'incomplete'
                : 'released',
      clarificationRequested: replyRequestsClarification(released.reply, documentRequests),
      heldReason: released.held ? (complianceOutcome ?? 'release_gate') : null,
    });
    // One JSON object per log line: the shape `readCanaryEvents` parses from an
    // exported log line, like the `meriv3.turn` event below.
    this.logStructured('log', 'meri.canary.turn', { ...canaryEvent });
    // Always schedule after text emission. Stage 1 enforce is intentionally
    // shadow-only: this cannot hold, delay, retrieve for, or rewrite the answer.
    if (claimAssessmentMode !== 'off') {
      const asOf = new Date().toISOString();
      scheduleClaimInventoryShadow({
        conversationId: dto.conversationId,
        turnId: undefined,
        replyText: released.reply,
        citations: released.citations,
        asOf,
        logger: this.structuredLogger,
        afterInventory: async () => {
          const claimLedger = buildEvidenceLedger(
            {
              output: released.reply,
              ledgerEntries,
              citations: released.citations,
              plan: evidencePlan,
            },
            'claimInventory',
          );
          const claims = extractMaterialClaims({
            replyText: released.reply,
            citations: released.citations,
            ledger: claimLedger,
            asOf,
          }).filter((claim) => claim.material);
          const passages = buildRepairPassages(
            claimLedger.evidence,
            released.citations,
            ledgerEntries,
            dto.clientId,
          );
          const providers = createChatDecisionProviders({
            env: process.env,
            tenantId: ctx.tenantId,
            surface: 'chat',
            llm: this.llm.withProviderBudget(runtimeBudget, 'shadow', 'legacy-judge-shadow'),
            logger: this.structuredLogger,
            fetchImpl: runtimeBudget.budgetedFetch('shadow'),
          });
          const shadowLegacy = providers.legacyBaseline;
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
            providers: { jev: providers.jev, legacy: shadowLegacy },
            routing: resolveJevConfig(process.env).routing,
            budget: JEV_TASK_REGISTRY.claim_support.shadowBudget!,
            signal: opts.requestSignal ?? opts.signal,
            logger: this.structuredLogger,
          });
        },
      });
    }
    // Shadow starts only after text emission and is deliberately not awaited.
    if (statusProvenanceMode === 'shadow' && released.reply) {
      void runStatusProvenance({
        reply: released.reply,
        mode: 'shadow',
        registry: withToolBudget(
          this.registry,
          runtimeBudget,
          budgetScope,
          async (name, input, control) => {
            await this.assertCurrentAlternateReadAuthority(dto, availableSchemas, name, control);
            await this.reserveAuxiliaryResearchDispatch(
              dto,
              name,
              input,
              `status-shadow:${runtimeBudget.toolSignature(budgetScope, name, input)}`,
              control,
            );
          },
          admittedReadCapabilities,
        ),
        ctx,
        deadlineAt: Date.now() + 8_000,
        signal: opts.requestSignal ?? opts.signal,
      })
        .then((result) => {
          if (!result.detected) return;
          this.logStructured('log', 'meri.status_provenance.shadow', {
            counts: result.outcomes,
            lookupOk: result.lookupOk,
            latencyMs: result.latencyMs,
          });
        })
        .catch(() => undefined);
    }
    if (
      dto.pageWrite &&
      pageWriteState.payload &&
      !released.held &&
      !opts.signal?.aborted &&
      !runtimeBudget.acquisitionStopped
    ) {
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
        runtimeBudget: runtimeBudget.snapshot(),
      }),
    );
    emitMeriOrchestratorTelemetry({
      name: 'meri.orchestrator.turn.finalized',
      boundary: 'turn',
      runtime: 'meriv3',
      provider: 'openai',
      requestedModel: profile.model,
      effectiveModel: actualModel,
      clientId: dto.clientId ?? null,
      invokedTools: toolsUsed,
      sourceRefs: released.citations.map((citation) => ({
        sourceId: citation.stableId ?? citation.id,
        version: citation.source?.version ?? null,
        hash: citation.documentEvidence?.contentHash ?? null,
        tool: citation.tool,
      })),
      proposalId: pendingApprovals[0]?.proposalId ?? null,
      artifactIds: artifacts.map((artifact) => artifact.id),
      childRunId: dto.researchRun?.runId ?? null,
      outcome: opts.signal?.aborted ? 'aborted' : telemetry.partial ? 'partial' : 'completed',
      durationMs: Date.now() - startedAt,
      usage: currentMeriTaskUsage(),
      integrationDependencies: ['captured_turn_audit_receipt_pending_capture_policy_8e'],
    });
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

  /**
   * Stage 2 rollout: the mode that governs this turn. Configuration mistakes
   * (a tenant slug instead of the canonical UUID, an unknown surface, a
   * misspelled mode) leave the capability off and are surfaced once per process.
   */
  private resolveStage2Mode(
    capability: string,
    tenantId: string,
    surface: AssuranceSurface,
  ): CapabilityRolloutMode {
    const rollout = resolveCapabilityRollout({ capability, env: process.env, tenantId, surface });
    const modeRaw = String(process.env[`MERI_${capability}_MODE`] ?? '').trim();
    const issues = rollout.reasons.filter(
      (reason) =>
        reason.startsWith('invalid_tenant:') ||
        reason.startsWith('invalid_surface:') ||
        (reason === 'invalid_mode' && modeRaw !== ''),
    );
    if (issues.length) {
      const key = `${capability}:${issues.join(',')}`;
      if (!rolloutDiagnosticsLogged.has(key)) {
        rolloutDiagnosticsLogged.add(key);
        this.logStructured('warn', 'meri.rollout.invalid_config', { capability, issues });
      }
    }
    return rollout.mode;
  }

  private warnUnknownAutoCorrectionCategories(tokens: readonly string[]): void {
    const key = `AUTO_CORRECTION_CATEGORIES:${[...tokens].sort().join(',')}`;
    if (rolloutDiagnosticsLogged.has(key)) return;
    rolloutDiagnosticsLogged.add(key);
    this.logStructured('warn', 'meri.auto_correction.unknown_categories', { tokens: [...tokens] });
  }

  /**
   * One JSON object per log line. `readCanaryEvents` and `readShadowEvents`
   * parse each exported line with `JSON.parse` and read its `event` field, so a
   * structured event is never passed to the Nest logger as a second argument
   * (that prints a multi-line `Object:` block, one log line per fragment).
   */
  private logStructured(
    level: 'log' | 'warn',
    event: string,
    fields: Record<string, unknown>,
  ): void {
    const line = JSON.stringify({ event, ...fields });
    if (level === 'warn') this.logger.warn(line);
    else this.logger.log(line);
  }

  /**
   * The logger handed to the claim inventory shadow, the Jev provider factory,
   * the shadow claim assessor and the live repair stage. Every `(name, fields)`
   * call becomes one `logStructured` line, never a two-argument Nest call. A
   * getter rather than a field so it lives on the prototype and also serves a
   * service instance built without running the constructor.
   */
  private get structuredLogger(): MeriStructuredEventLogger {
    return {
      log: (event, fields) => this.logStructured('log', event, fields ?? {}),
      warn: (event, fields) => this.logStructured('warn', event, fields ?? {}),
    };
  }

  /**
   * Stage 2c. Assesses promoted claims and, in enforce, applies a bounded
   * claim-local repair. It runs after finalization and before the single text
   * emission, so it is fenced: a hard deadline, the turn and transport signals,
   * a claim cap and a catch-all. Every failure path returns the finalized reply
   * unchanged; a rewrite is released only when it is non-empty, passes Form A/B
   * validation and the same release gate the original went through.
   */
  private async applyBoundedAutoCorrection(args: {
    ctx: MeriContext;
    dto: MeriV3ChatInput;
    opts: MeriV3RunOptions;
    mode: 'shadow' | 'enforce';
    categories: ReturnType<typeof resolveAutoCorrectionCategories>['categories'];
    released: { reply: string; citations: MeriCitation[]; held: boolean };
    ledgerEntries: LedgerEntry[];
    citations: MeriCitation[];
    evidencePlan: ReturnType<typeof planGovernmentAffairsEvidence>;
    assuranceRisk: ReturnType<typeof classifyAssuranceRisk>;
    assuranceMode: ReturnType<typeof resolveAssuranceRolloutMode>;
    complianceOutcome?: 'PASS' | 'WARN' | 'BLOCK';
    verificationAvailable: boolean;
    coverageRequirements: CoverageRequirement[];
    residualCoverageGaps: CoverageGap[];
    availableSchemas: ToolSchema[];
    lastUserText: string;
    evidenceAccuracyMode: ReturnType<typeof resolveEvidenceAccuracyMode>;
    /** Model that wrote this turn; prices legacy-judge, recheck and revision tokens. */
    synthesisModel: string;
    canary: CanaryTurnCollector;
    runtimeBudget: MeriRunBudget;
    budgetScope: MeriToolSignatureScope;
    admittedReadCapabilities: ReadonlySet<string> | null;
  }): Promise<{ reply: string; citations: MeriCitation[]; documentRequests: number }> {
    const { ctx, dto, opts, released } = args;
    const original = { reply: released.reply, citations: released.citations, documentRequests: 0 };
    const conversationId = dto.conversationId ?? null;
    if (released.held) {
      // The held text is the gate's refusal: it carries no claim to repair, and
      // a rewrite would bypass the gate and auditor that held it.
      this.logStructured('log', 'meri.auto_correction.skipped', {
        conversationId,
        mode: args.mode,
        reason: 'held',
      });
      return original;
    }
    if (
      opts.signal?.aborted ||
      opts.requestSignal?.aborted ||
      args.runtimeBudget.acquisitionStopped
    ) {
      this.logStructured('log', 'meri.auto_correction.skipped', {
        conversationId,
        mode: args.mode,
        reason: 'aborted',
      });
      return original;
    }
    const startedAt = Date.now();
    const deadlineAt = Math.min(
      startedAt + AUTO_CORRECTION_BUDGET.maxMs,
      opts.deadlineAt ?? Number.POSITIVE_INFINITY,
    );
    const controller = new AbortController();
    const abortFromTurn = () => controller.abort(opts.signal?.reason ?? opts.requestSignal?.reason);
    opts.signal?.addEventListener('abort', abortFromTurn, { once: true });
    opts.requestSignal?.addEventListener('abort', abortFromTurn, { once: true });
    const failed = (reason: string, extra: Record<string, unknown> = {}) => {
      this.logStructured('warn', 'meri.auto_correction.failed', {
        conversationId,
        mode: args.mode,
        reason,
        elapsedMs: Date.now() - startedAt,
        ...extra,
      });
      args.canary.noteRepair({
        attempted: 0,
        corrected: 0,
        qualified: 0,
        omitted: 0,
        documentRequested: 0,
        budgetExhausted: reason === 'deadline' ? 1 : 0,
        timedOut: reason === 'deadline',
        assessmentMs: 0,
        repairMs: Date.now() - startedAt,
        tokens: 0,
        costUsd: 0,
      });
      return original;
    };
    try {
      const asOf = new Date().toISOString();
      const claimLedger = buildControlledClaimLedger({
        output: released.reply,
        ledgerEntries: args.ledgerEntries,
        citations: released.citations,
        plan: args.evidencePlan,
        env: process.env,
        tenantId: ctx.tenantId,
        surface: turnSurface(dto),
        callSite: 'autoCorrection',
        logShadow: (event, fields) => this.logStructured('log', event, { ...fields }),
      });
      const promoted = extractMaterialClaims({
        replyText: released.reply,
        citations: released.citations,
        ledger: claimLedger,
        asOf,
      }).filter(
        (claim) =>
          claim.material &&
          claim.category !== 'unclassified' &&
          args.categories.has(claim.category),
      );
      const claims = promoted.slice(0, AUTO_CORRECTION_MAX_CLAIMS);
      if (promoted.length > claims.length) {
        this.logStructured('log', 'meri.auto_correction.claims_capped', {
          conversationId,
          mode: args.mode,
          promoted: promoted.length,
          assessed: claims.length,
        });
      }
      // Bind only the exact current owner row/span; metadata and whole tool
      // entries cannot become consulted evidence.
      const passages = buildRepairPassages(
        claimLedger.evidence,
        released.citations,
        args.ledgerEntries,
        dto.clientId,
      );
      const providers = createChatDecisionProviders({
        env: process.env,
        tenantId: ctx.tenantId,
        surface: 'chat',
        llm: this.llm.withProviderBudget(args.runtimeBudget, 'repair', 'legacy-judge-repair'),
        logger: this.structuredLogger,
        fetchImpl: args.runtimeBudget.budgetedFetch('repair'),
      });
      const budgetedLegacy = providers.legacy;
      // MeriRunBudget remains the aggregate owner. The typed ToolRegistry seam
      // keeps accounting outside the repair loop and ready for later durable hooks.
      const budgetedRepairRegistry = withToolBudget(
        this.registry,
        args.runtimeBudget,
        args.budgetScope,
        async (name, input, control) => {
          // The repair path projects the ORIGINAL dto.clientId into a
          // client-bearing read and calls the registry directly. Apply the same
          // governed-target scope protection before any procedure lookup or
          // owner I/O, so a mismatch is refused here rather than reaching an
          // owner outside the guarded batch dispatch.
          const scopeViolation = this.resolveAuxiliaryToolScopeViolation(
            dto,
            args.availableSchemas,
            name,
            input,
          );
          if (scopeViolation) throw new Error(scopeViolation);
          await this.assertCurrentProcedureAuthority(dto.conversationId, name, control);
          await this.reserveAuxiliaryResearchDispatch(
            dto,
            name,
            input,
            `repair:${args.runtimeBudget.toolSignature(args.budgetScope, name, input)}`,
            control,
          );
        },
        args.admittedReadCapabilities,
      );
      // Document references are built only from what this turn observed
      // (readable content reads, selected or named listings); a turn that
      // touched no document passes none. The repair loop reads their
      // `readable`/`contentState` before deciding what a document claim needs.
      const documentReferences = buildRepairDocumentReferences({
        ledgerEntries: args.ledgerEntries,
        citations: released.citations,
        selectedDocumentIds: dto.selectedDocumentIds,
        request: args.lastUserText,
        clientId: dto.clientId,
      });
      const executor =
        args.mode === 'enforce'
          ? createOrchestratorToolExecutor({
              registry: budgetedRepairRegistry,
              schemas: args.availableSchemas,
              context: {
                tenantId: ctx.tenantId,
                clientId: dto.clientId,
                conversationId: dto.conversationId,
                request: args.lastUserText,
              },
              citations: released.citations,
              ledgerEntries: args.ledgerEntries,
              invoke: async (name, input, signal) => {
                return budgetedRepairRegistry.invoke(name, input, ctx, {
                  signal: signal ?? controller.signal,
                  deadlineAt,
                });
              },
              evidenceAccuracyMode: args.evidenceAccuracyMode,
              documentReferences,
            })
          : new ReplayToolExecutor([]);
      // The stage is fenced from the outside regardless of what the repair
      // loop does with its own budget: `settleWithinBudget` below stops waiting
      // at `deadlineAt` or on abort and the finalized reply is released.
      const work = applyLiveRepair({
        released: released.reply,
        claims,
        ledger: claimLedger,
        citations: released.citations,
        passages,
        evidencePlan: args.evidencePlan,
        residualGaps: args.residualCoverageGaps,
        documentReferences,
        tenantId: ctx.tenantId,
        clientId: dto.clientId,
        conversationId: dto.conversationId,
        providers: { jev: providers.jev, legacy: budgetedLegacy },
        executor,
        // Remaining time is measured from this stage's deadline, never from a
        // budget clock the repair loop restarts for itself.
        generate:
          args.mode === 'enforce'
            ? createRevisionGenerator(
                {
                  completeWithSchema: async (params) => {
                    return this.llm
                      .withProviderBudget(args.runtimeBudget, 'repair', 'claim-revision-repair')
                      .completeWithSchema(params);
                  },
                },
                () => Math.max(1, deadlineAt - Date.now()),
              )
            : async ({ affectedText }) => ({ replacementText: affectedText, citedEvidenceIds: [] }),
        promotedCategories: args.categories,
        budget: { ...AUTO_CORRECTION_BUDGET, maxMs: Math.max(1, deadlineAt - Date.now()) },
        signal: controller.signal,
        logger: this.structuredLogger,
        // An omitted mode is treated as enforce by the repair service; always explicit.
        mode: args.mode,
        // Real read-only classification for remedy planning; unknown tools fail closed.
        toolRegistry: this.registry,
        pricing: { llmModel: args.synthesisModel },
        cache: this.liveRepairCache(ctx.tenantId),
      });
      const settled = await settleWithinBudget(work, { deadlineAt, signal: controller.signal });
      if (settled.kind !== 'settled') {
        controller.abort(new DOMException('Auto-correction budget exceeded', 'TimeoutError'));
        return failed(settled.kind, { claims: claims.length });
      }
      const repair = settled.value;
      // Repair counts come from the per-claim outcomes the repair service
      // reports (corrected + qualified + omitted + unresolved === attempted).
      args.canary.noteRepair({
        ...repair.metrics.repairs,
        timedOut: false,
        assessmentMs: repair.metrics.assessmentMs,
        repairMs: repair.metrics.repairMs,
        tokens: repair.metrics.inputTokens,
        costUsd: repair.metrics.estimatedCostUsd,
        sampled: repair.metrics.sampled,
        jevCalls: repair.metrics.jevCalls,
        legacyCalls: repair.metrics.legacyCalls,
        repairLoops: repair.metrics.repairLoops,
        cache: repair.metrics.cache,
      });
      args.canary.noteLegacy(repair.metrics.legacyInputTokens);
      this.logStructured('log', 'meri.auto_correction.stage', {
        conversationId,
        mode: args.mode,
        claimsAssessed: claims.length,
        attempted: repair.metrics.repairs.attempted,
        wouldAttempt: repair.metrics.wouldAttempt,
        unresolved: repair.metrics.unresolved,
        documentRequested: repair.metrics.repairs.documentRequested,
        replyChanged: repair.changed,
        elapsedMs: Date.now() - startedAt,
      });
      const documentRequests = repair.metrics.repairs.documentRequested;
      if (args.mode !== 'enforce' || !repair.changed) return { ...original, documentRequests };

      const formA = validateCitationMarkers(repair.reply, repair.citations);
      const formB = validateFormBCitations(
        formA.cleanedText,
        ledgerToToolResultMap(args.ledgerEntries),
      );
      const rewritten = formB.sanitizedText;
      if (!rewritten.trim()) {
        this.logStructured('warn', 'meri.auto_correction.rewrite_rejected', {
          conversationId,
          reason: 'empty',
        });
        return { ...original, documentRequests };
      }
      const seen = new Set(args.citations.map((item) => `${item.tool}:${item.n}:${item.id}`));
      const gateCitations = [
        ...args.citations,
        ...repair.citations.filter((item) => !seen.has(`${item.tool}:${item.n}:${item.id}`)),
      ];
      const gate = this.evaluateReleaseGate({
        released: rewritten,
        ledgerEntries: args.ledgerEntries,
        citations: gateCitations,
        evidencePlan: args.evidencePlan,
        assuranceRisk: args.assuranceRisk,
        assuranceMode: args.assuranceMode,
        complianceOutcome: args.complianceOutcome,
        verificationAvailable: args.verificationAvailable,
        tenantId: ctx.tenantId,
        surface: turnSurface(dto),
      });
      if (gate.held) {
        this.logStructured('warn', 'meri.auto_correction.rewrite_rejected', {
          conversationId,
          reason: 'release_gate',
        });
        return { ...original, documentRequests };
      }
      return { reply: rewritten, citations: [...formA.used], documentRequests };
    } catch (error) {
      return failed(errorReason(error));
    } finally {
      opts.signal?.removeEventListener('abort', abortFromTurn);
      opts.requestSignal?.removeEventListener('abort', abortFromTurn);
    }
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
    return userRequestText(
      String(
        [...(dto.messages ?? [])]
          .reverse()
          .find((message) => message?.role === 'user' && typeof message.text === 'string')?.text ??
          '',
      ),
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
    /**
     * Request-local binding from each dispatched ledger entry to the concrete
     * accepted citations that entry itself produced. The final bounded release
     * reads only these bound objects, never a later global array selected by
     * tool name/id.
     */
    ledgerCitationBindings: Map<LedgerEntry, readonly MeriCitation[]>;
    toolsUsed: string[];
    emit: (event: MeriV3ChatStreamEvent) => void;
    prePersistRefusal: (name: string, input: Record<string, unknown>) => string | null;
    noteComplianceOutcome: (outcome: 'PASS' | 'WARN' | 'BLOCK') => void;
    evidenceAccuracyMode: ReturnType<typeof resolveEvidenceAccuracyMode>;
    control?: ToolExecutionControl;
    runtimeBudget: MeriRunBudget;
    budgetScope: MeriToolSignatureScope;
    semanticDecisionId: string;
    admittedReadCapabilities: ReadonlySet<string> | null;
    isProgressivelyLoaded: (name: string) => boolean;
    resolveCurrentDiscoverySchemas: () => Promise<ToolSchema[]>;
    authorizeCurrentDiscoverySchema: (schema: ToolSchema) => Promise<boolean>;
  }): Promise<FunctionExecution[]> {
    const executions: FunctionExecution[] = [];
    const publicCall = (call: OpenAiResponsesFunctionCall) =>
      args.schemas.some((schema) => schema.name === call.name)
        ? { tool: call.name, label: toolLabel(call.name), detail: undefined }
        : UNKNOWN_PUBLIC_TOOL;
    const logDispatch = (
      call: OpenAiResponsesFunctionCall,
      result: string,
      invoked: boolean,
    ): void => {
      const exposed = args.schemas.some((schema) => schema.name === call.name);
      this.logStructured('log', 'meri.semantic_tool_gateway.dispatch', {
        decisionId: args.semanticDecisionId,
        // Provider-emitted undeclared names are untrusted text. Keep the
        // attempted-call count/result, but never echo an unknown name into
        // selector telemetry where it could carry copied private request text.
        requestedNames: exposed ? [call.name] : [],
        requestedCount: 1,
        selectedNames: exposed ? [call.name] : [],
        selectedCount: exposed ? 1 : 0,
        exposedNames: exposed ? [call.name] : [],
        exposedCount: exposed ? 1 : 0,
        invokedNames: invoked ? [call.name] : [],
        invokedCount: invoked ? 1 : 0,
        result,
      });
    };
    const stopWithoutDispatch = (call: OpenAiResponsesFunctionCall): void => {
      const detail = `Aggregate runtime acquisition stopped: ${args.runtimeBudget.reason ?? 'tool_calls'}.`;
      const visible = publicCall(call);
      const result = {
        error: detail,
        code: 'MERI_RUNTIME_BUDGET_STOPPED',
        partial: true,
      };
      args.steps.push({
        tool: visible.tool,
        label: visible.label,
        status: 'blocked',
        detail: visible.detail ?? detail,
      });
      args.emit({
        type: 'tool_done',
        tool: visible.tool,
        label: visible.label,
        status: 'blocked',
        detail: visible.detail ?? detail,
      });
      executions.push({ call, result, serialized: JSON.stringify(result) });
      logDispatch(call, 'blocked_budget', false);
    };
    if (!args.runtimeBudget.reserveToolBatch(args.calls.length)) {
      for (const call of args.calls) stopWithoutDispatch(call);
      return executions;
    }
    // This cache exists only for one provider-emitted batch. It prevents two
    // distinct call IDs with the same scoped write intent from creating two
    // effects/proposals while still returning one correlated output per call ID.
    const batchWriteIntents = new Map<string, FunctionExecution>();
    for (const call of args.calls) {
      assertToolExecutionActive(args.control);
      const schema = args.schemas.find((candidate) => candidate.name === call.name);
      // Enforce capability selection at execution too: a provider can emit an
      // undeclared call, but it cannot escape the caller's narrower tool policy.
      if (!schema) {
        const detail = UNKNOWN_PUBLIC_TOOL.detail;
        args.steps.push({
          tool: UNKNOWN_PUBLIC_TOOL.tool,
          label: UNKNOWN_PUBLIC_TOOL.label,
          status: 'blocked',
          detail,
        });
        args.emit({
          type: 'tool_done',
          tool: UNKNOWN_PUBLIC_TOOL.tool,
          label: UNKNOWN_PUBLIC_TOOL.label,
          status: 'blocked',
          detail,
        });
        executions.push({
          call,
          result: { error: detail },
          serialized: JSON.stringify({ error: detail }),
        });
        logDispatch(call, 'blocked_undeclared', false);
        continue;
      }
      let currentProgressiveSchema = true;
      if (args.isProgressivelyLoaded(call.name)) {
        const current = (await args.resolveCurrentDiscoverySchemas()).find(
          (candidate) => candidate.name === call.name,
        );
        currentProgressiveSchema = Boolean(
          current &&
          sameToolSchemaSurface(schema, current) &&
          (await args.authorizeCurrentDiscoverySchema(current)),
        );
      }
      const authority = this.resolveCapabilityAuthority(call.name, schema, args.dto);
      if (
        !authority ||
        !currentProgressiveSchema ||
        args.dto.toolPolicy === 'none' ||
        (args.dto.toolPolicy === 'read-only' && authority.readOnly !== true)
      ) {
        const detail =
          'This capability is no longer available under the current governed tool policy.';
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
          result: { blocked: true, error: detail },
          serialized: JSON.stringify({ blocked: true, error: detail }),
        });
        logDispatch(call, 'blocked_current_policy', false);
        continue;
      }
      await this.assertResearchRunActive(args.dto, args.control);
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
        logDispatch(call, 'invalid_arguments', false);
        continue;
      }
      const augmented = this.augmentToolInput(
        args.dto,
        this.prepareArtifactInput(call.name, parsed, args.citations, args.ledgerEntries),
        schema,
        authority,
      );
      // Consume the client-scope guard BEFORE any replay lookup, budget dedup,
      // write-intent dedup, proposal or persistence. A refused call emits its
      // blocked lifecycle and returns a blocked receipt; it never reserves
      // budget, replays, deduplicates, proposes or reaches an owner.
      if (augmented.scopeViolation) {
        const blocked = this.blockScopeViolation({
          name: call.name,
          input: augmented.input,
          providerCallId: call.call_id,
          detail: augmented.scopeViolation,
          steps: args.steps,
          emit: args.emit,
        });
        executions.push({ call, result: blocked, serialized: JSON.stringify(blocked) });
        logDispatch(call, 'blocked_scope', false);
        continue;
      }
      if (call.name === 'get_research_evidence' && args.dto.researchRun) {
        augmented.input.sessionId = args.dto.researchRun.sessionId;
      }
      const signature = args.runtimeBudget.toolSignature(
        args.budgetScope,
        call.name,
        augmented.input,
      );
      // An identical read already returned in this turn: its result is in the
      // model's context, so answer with a pointer instead of re-dispatching it
      // and resending the same evidence.
      const settledBy =
        authority.readOnly === true ? args.runtimeBudget.settledRead(signature) : null;
      if (settledBy) {
        const result = {
          repeatOf: settledBy,
          note: 'Identical to an earlier call in this turn (same tool and arguments). Its result is already above; use it instead of repeating the call.',
        };
        executions.push({ call, result, serialized: JSON.stringify(result) });
        logDispatch(call, 'deduplicated', false);
        continue;
      }
      if (!args.runtimeBudget.beginTool(signature)) {
        stopWithoutDispatch(call);
        continue;
      }
      const intentKey =
        authority.readOnly === false
          ? writeIntentKey({
              ctx: args.ctx,
              dto: args.dto,
              tool: call.name,
              input: augmented.input,
            })
          : null;
      const prior = intentKey ? batchWriteIntents.get(intentKey) : undefined;
      if (prior) {
        executions.push({ call, result: prior.result, serialized: prior.serialized });
        logDispatch(call, 'deduplicated', false);
        continue;
      }
      args.toolsUsed.push(call.name);
      let durableSafeRead: DurableSafeReadOutcome | undefined;
      const stepId = meriTelemetryChildSpanId();
      const stepStartedAt = Date.now();
      const citationStart = args.citations.length;
      const artifactStart = args.artifacts.length;
      const proposalStart = args.pendingApprovals.length;
      emitMeriOrchestratorTelemetry({
        name: 'meri.tool.step.started',
        boundary: 'orchestrator_tool',
        spanId: stepId,
        stepId,
        callSignature: signature,
        invokedTools: [call.name],
        outcome: 'started',
      });
      let result: unknown;
      try {
        result = await this.invokeTool({
          ctx: args.ctx,
          dto: args.dto,
          name: call.name,
          input: augmented.input,
          conversationId: args.dto.conversationId,
          steps: args.steps,
          pendingApprovals: args.pendingApprovals,
          artifacts: args.artifacts,
          emit: args.emit,
          prePersistRefusal: args.prePersistRefusal,
          userRequest: this.lastUserText(args.dto),
          noteComplianceOutcome: args.noteComplianceOutcome,
          scopeViolation: augmented.scopeViolation,
          control: args.control,
          citations: args.citations,
          evidenceAccuracyMode: args.evidenceAccuracyMode,
          providerCallId: call.call_id,
          schema,
          researchRun: args.dto.researchRun,
          admittedReadCapabilities: args.admittedReadCapabilities,
          availableSchemas: args.schemas,
          captureDurableSafeRead: (outcome) => {
            durableSafeRead = outcome;
          },
        });
      } catch (error) {
        emitMeriOrchestratorTelemetry({
          name: 'meri.tool.step.finalized',
          boundary: 'orchestrator_tool',
          spanId: stepId,
          stepId,
          callSignature: signature,
          invokedTools: [call.name],
          outcome: args.control?.signal?.aborted ? 'aborted' : 'error',
          durationMs: Date.now() - stepStartedAt,
        });
        throw error;
      }
      logDispatch(call, governedToolResult(result), true);
      const visibleResult = projectMeriToolEvidence({
        result,
        maxCharacters: TOOL_RESULT_CHARS,
        readOnly: authority.readOnly === true,
        inputProperties: schema.input_schema.properties as Record<string, unknown> | undefined,
      });
      if (authority.readOnly === true) {
        const failed = isLogicalToolFailure(visibleResult);
        const repeatable = isLegitimatePollingObservation(augmented.input, visibleResult);
        args.runtimeBudget.observeToolResult({
          signature,
          result: visibleResult,
          failed,
          repeatable,
        });
        if (!failed && !repeatable) args.runtimeBudget.rememberSettledRead(signature, call.call_id);
      }
      if (authority.readOnly === true) {
        const routeKeys = new Set([
          'clientId',
          'documentId',
          'billId',
          'peCode',
          'chamber',
          'opportunityId',
          'awardId',
          'sourceId',
          'cursor',
          'pageToken',
          'offset',
          'url',
        ]);
        const requestRoute = Object.fromEntries(
          Object.entries(augmented.input).filter(
            ([key, value]) =>
              routeKeys.has(key) &&
              (typeof value === 'string' ||
                typeof value === 'number' ||
                typeof value === 'boolean'),
          ),
        ) as Record<string, string | number | boolean>;
        args.toolCoverage.push(
          ...observeMeriTurnToolCoverage(call.name, visibleResult).map((receipt) => ({
            ...receipt,
            ...(Object.keys(requestRoute).length ? { requestRoute } : {}),
          })),
        );
      }
      const citationCandidates = extractCitationsFromToolResult(call.name, visibleResult, 1);
      const { citations: cites } = numberMeriEvidenceCitationsForMode(
        citationCandidates,
        args.citations,
        args.evidenceAccuracyMode,
        ({ collisions, overflow }) => {
          this.logStructured('warn', 'meri.citation_integrity', {
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
      emitMeriOrchestratorTelemetry({
        name: 'meri.tool.step.finalized',
        boundary: 'orchestrator_tool',
        spanId: stepId,
        stepId,
        callSignature: signature,
        invokedTools: [call.name],
        sourceRefs: args.citations.slice(citationStart).map((citation) => ({
          sourceId: citation.stableId ?? citation.id,
          version: citation.source?.version ?? null,
          hash: citation.documentEvidence?.contentHash ?? null,
          tool: citation.tool,
        })),
        proposalId: args.pendingApprovals[proposalStart]?.proposalId ?? null,
        operationId: meriTelemetryOperationId(result),
        artifactIds: args.artifacts.slice(artifactStart).map((artifact) => artifact.id),
        outcome:
          classifyApiToolReadOutcome(call.name, result)?.kind ??
          (isLogicalToolFailure(result) ? 'error' : governedToolResult(result)),
        durationMs: Date.now() - stepStartedAt,
      });
      const body = wrapMeriToolEvidence(call.name, visibleResult);
      const serialized = cites.length ? `${formatCitationsForPrompt(cites)}\n\n${body}` : body;
      const ledgerEntry = {
        tool: call.name,
        serialized,
        // A committed research read retains the exact owner payload; prompt
        // projection remains `visibleResult` in the Responses call below.
        result: durableSafeRead ? result : visibleResult,
        ...(durableSafeRead ? { durableSafeRead } : {}),
      } as LedgerEntry;
      args.ledgerEntries.push(ledgerEntry);
      // Bind THIS invocation's ledger identity to the concrete accepted citation
      // objects it produced (original numbers/identity/snippets). A later
      // unavailable result of the SAME tool therefore cannot overwrite the
      // healthy call's bound citation, and an inner owner citation whose `tool`
      // differs from the outer host name is not lost to a tool-name filter.
      args.ledgerCitationBindings.set(ledgerEntry, cites);
      const execution = { call, result: visibleResult, serialized };
      executions.push(execution);
      if (intentKey) batchWriteIntents.set(intentKey, execution);
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

  protected augmentToolInput(
    dto: MeriV3ChatInput,
    input: Record<string, unknown>,
    schema: ToolSchema | undefined,
    authority?: MeriResolvedCapability | null,
  ): { input: Record<string, unknown>; scopeViolation?: string } {
    const output = { ...input };
    const properties = schema?.input_schema?.properties as Record<string, unknown> | undefined;
    const governed = currentGovernedMeriContext();
    const governedTarget = this.resolveGovernedClientTarget();
    const retargetableRead = this.isRetargetableGovernedRead(schema, authority);

    // Consume the client-scope guard before any mutation: a re-targetable
    // native read refuses an explicit different client, and a bound
    // effect/artifact/write refuses a governed single-client turn that
    // disagrees with the immutable conversation client.
    if (authority) {
      const scopeViolation = this.resolveToolScopeViolation(dto, schema, authority, output);
      if (scopeViolation) return { input: output, scopeViolation };
    }

    if (properties?.clientId) {
      const supplied = typeof output.clientId === 'string' ? output.clientId.trim() : '';
      const mailRead = isMeriMailReadTool(schema?.name);
      // A governed turn with no single authorized client keeps only an OMITTED
      // optional filter (an explicit one was refused above); the interface
      // client is never injected as a fallback.
      const leaveOptionalOmitted = retargetableRead && Boolean(governed) && !governedTarget;
      if (retargetableRead && governedTarget) {
        // The authenticated single governed client is the only target a
        // canonical native read may use; an omitted one is pinned to it. The
        // explicit-different case was already refused above, and personal
        // mailbox omission is preserved.
        if (supplied || !mailRead) output.clientId = governedTarget;
      } else if (!leaveOptionalOmitted && dto.clientId) {
        // Unchanged legacy binding for an ungoverned turn and the immutable
        // conversation-client binding for a bound effect.
        if (supplied && supplied !== dto.clientId) {
          return { input: output, scopeViolation: CROSS_CLIENT_REFUSAL };
        }
        // The owner-authenticated mailbox includes mail with no client
        // association. Keep explicit client filters pinned, but let the
        // provider omit one for personal inbox questions.
        if (supplied || !mailRead) output.clientId = dto.clientId;
      }
    }
    if (dto.conversationId && output.conversationId === undefined && properties?.conversationId) {
      output.conversationId = dto.conversationId;
    }
    // save_memory binds client scope to the conversation's client server-side;
    // its schema deliberately has no clientId so the model cannot choose one.
    // Without this, a client-scoped save fell back to personal memory, which
    // is stored immediately with no review.
    if (schema?.name === 'save_memory') {
      if (dto.clientId) output.clientId = dto.clientId;
      else delete output.clientId;
    }
    return { input: output };
  }

  /**
   * Emit the blocked lifecycle for a tool call refused by the client-scope
   * guard, without reserving budget, replaying, deduplicating, proposing or
   * persisting. Each subclass supplies its own public label presentation so the
   * blocked step matches the tool the model would otherwise have run.
   */
  protected blockScopeViolation(args: {
    name: string;
    input: Record<string, unknown>;
    providerCallId: string;
    detail: string;
    steps: ChatStep[];
    emit: (event: MeriV3ChatStreamEvent) => void;
  }): { blocked: true; error: string } {
    const label = toolLabel(args.name);
    args.emit({ type: 'tool_call', tool: args.name, label, providerCallId: args.providerCallId });
    args.steps.push({ tool: args.name, label, status: 'blocked', detail: args.detail });
    args.emit({
      type: 'tool_done',
      tool: args.name,
      label,
      status: 'blocked',
      detail: args.detail,
    });
    return { blocked: true, error: args.detail };
  }

  protected async invokeTool(args: MeriToolInvocation): Promise<unknown> {
    assertToolExecutionActive(args.control);
    assertMeriV3ResearchCapability(args.admittedReadCapabilities, args.name);
    const label = toolLabel(args.name);
    args.emit({ type: 'tool_call', tool: args.name, label, providerCallId: args.providerCallId });
    // The scope guard is re-derived here even when the caller cleared it, so an
    // alternate dispatch path (document preflight/completion, retrieval
    // semantic/recipe `invokeUnderlying`) cannot bypass the batch guard: the
    // actual native dispatch rechecks the current target/binding before any
    // owner I/O.
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
        tool: args.name,
        label,
        status: 'blocked',
        detail: scopeViolation,
      });
      return { blocked: true, error: scopeViolation };
    }
    const definition = this.registry.get(args.name);
    if (!definition) {
      // A canonical native read the live registry cannot serve is a CURRENT
      // registry-unavailable read failure. The capability identity is taken from
      // the canonical capability metadata (the live registry has no definition),
      // never a tool-name prefix. Status only.
      const canonical = MERI_CAPABILITY_REGISTRY.find(
        (item) => item.name === args.name && item.readOnly === true,
      );
      if (canonical && !READONLY_ARTIFACT_OWNER_TOOLS.has(canonical.name)) {
        catalogAvailabilityObserverOf(args.control)?.noteNativeReadFailure(
          canonical.name,
          'unavailable',
        );
      }
      const detail = 'This tool is not available in the governed Capiro registry.';
      args.steps.push({ tool: args.name, label, status: 'error', detail });
      args.emit({ type: 'tool_done', tool: args.name, label, status: 'error', detail });
      return { error: detail };
    }
    assertMeriProcedureToolDispatch({
      procedure: currentGovernedMeriContext()?.procedure,
      toolName: args.name,
      readOnly: definition.readOnly,
    });
    const refusal = args.prePersistRefusal(args.name, args.input);
    if (refusal) {
      args.steps.push({ tool: args.name, label, status: 'blocked', detail: refusal });
      args.emit({ type: 'tool_done', tool: args.name, label, status: 'blocked', detail: refusal });
      return { blocked: true, persisted: false, message: refusal };
    }

    if (definition.readOnly === false) {
      const intent = classifyActionIntent(args.userRequest, args.name);
      if (!intent.authorized) {
        const detail =
          'No action was taken because this request did not explicitly authorize that action.';
        args.steps.push({ tool: args.name, label, status: 'blocked', detail });
        args.emit({ type: 'tool_done', tool: args.name, label, status: 'blocked', detail });
        return { blocked: true, persisted: false, message: detail, category: intent.category };
      }
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

    let dispatchedReservationId: string | undefined;
    // Whether the owner read itself was dispatched (so a later throw is an owner
    // read failure, not a pre-dispatch reservation/authority failure).
    let ownerReadDispatched = false;
    try {
      let result: unknown;
      let durableSafeRead: DurableSafeReadOutcome | undefined;
      if (args.researchRun) {
        const toolVersion = toolSchemaVersion(args.schema);
        const replay = await this.researchSafeReadRequest(
          args.researchRun,
          'replay',
          {
            providerCallId: args.providerCallId,
            tool: args.name,
            toolVersion,
            input: args.input,
          },
          args.control,
        );
        // The replay settlement above is awaited. Re-assert the ORIGINAL parent
        // before branching into any current-authority/reservation call, so a
        // Stop/absolute expiry during the replay settlement cannot authorize a
        // fresh reservation or a dispatch. The replay outcome itself is an
        // already-incurred bounded settlement and is preserved as-is.
        assertToolExecutionActive(args.control);
        if (replay.replayed === true) {
          await this.assertCurrentProcedureAuthority(args.conversationId, args.name, args.control);
          result = replay.result;
          durableSafeRead = this.durableOutcome(replay.durableSafeRead);
        } else {
          if (replay.dispatchAllowed === false)
            throw new Error(
              'The durable attempt was already spent or its replay proof failed; no second dispatch is allowed.',
            );
          await this.assertCurrentProcedureAuthority(args.conversationId, args.name, args.control);
          // The current-authority boundary above is awaited. Re-assert the
          // ORIGINAL parent before opening the NEW safe-read reservation, so a
          // Stop/absolute expiry during that await cannot start a fresh
          // reservation that a transport may complete anyway. An aborted signal
          // alone does not prevent a new reservation on such a transport; the
          // existing post-reservation assertion below still guards the owner
          // read that follows.
          assertToolExecutionActive(args.control);
          const reservation = await this.researchSafeReadRequest(
            args.researchRun,
            'reservations',
            {
              providerCallId: args.providerCallId,
              tool: args.name,
              input: args.input,
            },
            args.control,
          );
          if (
            reservation.dispatchAllowed !== true ||
            typeof reservation.reservationId !== 'string' ||
            reservation.tool !== args.name ||
            reservation.toolVersion !== toolVersion
          )
            throw new Error('Research tool attempt was not admitted for dispatch.');
          // The authority/reservation boundary above is awaited. Re-assert the
          // ORIGINAL parent before opening the NEW owner dispatch, so a
          // Stop/expiry during those awaits cannot start a fresh read.
          assertToolExecutionActive(args.control);
          dispatchedReservationId = reservation.reservationId;
          ownerReadDispatched = true;
          result = await this.registry.invoke(args.name, args.input, args.ctx, args.control);
          // The owner read is now INCURRED. Its outcome/failure settlement is
          // ATTEMPTED below with the ORIGINAL parent signal. This is NOT a
          // guarantee of a durable commit: a real transport that honors an
          // already-aborted parent rejects the settlement POST before any
          // durable receipt, and the catch below then leaves the reservation
          // UNCERTAIN (no invented durable-store proof). Only PUBLICATION (the
          // availability observation, the done step/event, the ledger
          // citation/artifact and the next provider round) is withheld for a
          // turn that is no longer current.
          const classification = classifyApiToolReadOutcome(args.name, result);
          // Complete, empty and partial reads are receipted; the API keeps
          // partial ones out of the qualified sources but re-checks them.
          if (
            !classification ||
            (classification.kind !== 'complete' &&
              classification.kind !== 'empty' &&
              classification.kind !== 'partial')
          ) {
            dispatchedReservationId = undefined;
            await this.researchSafeReadRequest(
              args.researchRun,
              'failures',
              {
                reservationId: reservation.reservationId,
                code: classification?.kind ?? 'unknown_owner_result',
              },
              args.control,
            );
            const detail = `Read result was not durably qualified (${classification?.kind ?? 'unknown'}).`;
            // The failure settlement above is ATTEMPTED with the original parent
            // signal (not a guaranteed receipt). A Stop/expiry during the owner
            // call or settlement must not now publish the read as a current
            // failure observation or an error step.
            assertToolExecutionActive(args.control);
            this.noteNativeReadOutcomeFailure(
              args.name,
              args.schema,
              args.dto,
              args.control,
              classification,
            );
            args.steps.push({ tool: args.name, label, status: 'error', detail });
            args.emit({ type: 'tool_done', tool: args.name, label, status: 'error', detail });
            return result;
          }
          const executionId = reservation.reservationId;
          const receipt = await this.researchSafeReadRequest(
            args.researchRun,
            'outcomes',
            {
              reservationId: executionId,
              executionId,
              providerCallId: args.providerCallId,
              tool: args.name,
              toolVersion,
              input: args.input,
              result,
            },
            args.control,
          );
          durableSafeRead = this.durableOutcome({ ...receipt, replayed: false });
          // This line is reached only because the outcomes settlement POST
          // RESOLVED with a receipt (a real transport rejects it when the parent
          // is already aborted, and the catch below then leaves the reservation
          // uncertain). A Stop/expiry during the owner call or the settlement
          // must not now publish the read as a current success. The reservation
          // is settled, so clear it so the catch cannot re-settle a successful
          // read as a failed dispatch.
          dispatchedReservationId = undefined;
          assertToolExecutionActive(args.control);
          this.noteNativeReadOutcomeFailure(
            args.name,
            args.schema,
            args.dto,
            args.control,
            classification,
          );
        }
      } else {
        await this.assertCurrentProcedureAuthority(args.conversationId, args.name, args.control);
        // The current-authority boundary above is awaited. Re-assert the
        // ORIGINAL parent before opening the NEW registry owner dispatch, so a
        // Stop/expiry during that await cannot start a fresh read.
        assertToolExecutionActive(args.control);
        ownerReadDispatched = true;
        result = await this.registry.invoke(args.name, args.input, args.ctx, args.control);
        // The owner result resolved. If the parent stopped/expired while the
        // read was awaited, the result is NOT current: withhold the availability
        // observation and the done step/event so a late result never reaches the
        // native success/failure observer, the citation/artifact ledger or the
        // next provider round as if it were current. The read was already
        // incurred at the owner; nothing is rolled back.
        assertToolExecutionActive(args.control);
        this.noteNativeReadOutcomeFailure(
          args.name,
          args.schema,
          args.dto,
          args.control,
          classifyApiToolReadOutcome(args.name, result),
        );
      }
      // The replay settlement (or the branch above) is complete. Re-assert the
      // ORIGINAL parent before the ordinary done publication so a Stop/expiry
      // during a legitimate durable settlement cannot publish the read as a
      // current success.
      assertToolExecutionActive(args.control);
      if (durableSafeRead) args.captureDurableSafeRead(durableSafeRead);
      args.steps.push({ tool: args.name, label, status: 'done', durableSafeRead });
      args.emit({
        type: 'tool_done',
        tool: args.name,
        label,
        status: 'done',
        durableSafeRead,
        ...(durableSafeRead ? { ownerResult: result } : {}),
      });
      return result;
    } catch (error) {
      if (args.researchRun && dispatchedReservationId) {
        try {
          await this.researchSafeReadRequest(
            args.researchRun,
            'failures',
            { reservationId: dispatchedReservationId, code: 'owner_dispatch_failed' },
            args.control,
          );
        } catch {
          // Keep the reservation uncertain when the lifecycle owner cannot
          // durably classify the failed dispatch.
        }
      }
      assertToolExecutionActive(args.control);
      // A throw from the actual owner read dispatch (after the read was
      // admitted) is a CURRENT canonical native-read failure. A pre-dispatch
      // reservation/authority failure (`ownerReadDispatched` still false) is NOT
      // recorded. An aborted turn already rethrew above and is never recorded.
      if (ownerReadDispatched) {
        this.noteNativeReadOutcomeFailure(
          args.name,
          args.schema,
          args.dto,
          args.control,
          undefined,
          'failed',
        );
      }
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
    residualCoverageGaps?: CoverageGap[];
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

    const gate = this.evaluateReleaseGate({
      released,
      ledgerEntries: args.ledgerEntries,
      citations: args.citations,
      evidencePlan: args.evidencePlan,
      assuranceRisk: args.assuranceRisk,
      assuranceMode: args.assuranceMode,
      complianceOutcome: args.complianceOutcome,
      verificationAvailable: args.verificationAvailable,
      tenantId: args.ctx.tenantId,
      surface: turnSurface(args.dto),
    });
    released = gate.released;
    held = gate.held;

    const residualCoverageGaps = args.residualCoverageGaps ?? [];
    // A held or refused reply carries no released claim for the note to attach to.
    if (residualCoverageGaps.length && !held) {
      released = appendClaimTiedCoverageDisclosure(
        released,
        residualCoverageGaps,
        args.coverageRequirements,
      );
    }
    return { reply: released, citations: usedCitations, held };
  }

  /**
   * The assurance release gate exactly as finalization runs it. Repaired text
   * goes through the same check before it may replace the finalized reply.
   */
  private evaluateReleaseGate(args: {
    released: string;
    ledgerEntries: LedgerEntry[];
    citations: MeriCitation[];
    evidencePlan: ReturnType<typeof planGovernmentAffairsEvidence>;
    assuranceRisk: ReturnType<typeof classifyAssuranceRisk>;
    assuranceMode: ReturnType<typeof resolveAssuranceRolloutMode>;
    complianceOutcome?: 'PASS' | 'WARN' | 'BLOCK';
    verificationAvailable: boolean;
    tenantId: string;
    surface: AssuranceSurface;
  }): { released: string; held: boolean } {
    let released = args.released;
    let held = false;
    if (
      args.assuranceMode !== 'off' &&
      args.assuranceRisk.requiresBufferBeforeRelease &&
      released.trim()
    ) {
      try {
        const claimLedger = buildControlledClaimLedger({
          output: released,
          ledgerEntries: args.ledgerEntries,
          citations: args.citations,
          plan: args.evidencePlan,
          env: process.env,
          tenantId: args.tenantId,
          surface: args.surface,
          callSite: 'evaluateReleaseGate',
          logShadow: (event, fields) => this.logStructured('log', event, { ...fields }),
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
    return { released, held };
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
    this.logStructured('warn', 'meri.citation_integrity', {
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
      await withMeriOrchestratorTelemetrySpan(
        { name: 'meri.research.active', boundary: 'research_checkpoint' },
        async () => {
          const response = await fetch(
            `${this.apiBaseUrl}/api/clio/research/${encodeURIComponent(sessionId)}/runs/${encodeURIComponent(runId)}/active`,
            {
              signal: execution.signal,
              headers: {
                ...meriOrchestratorTelemetryHeaders(),
                ...(this.serviceSecret ? { 'x-internal-service-secret': this.serviceSecret } : {}),
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
        },
        'client',
      );
    } finally {
      execution.dispose();
    }
  }

  private async researchSafeReadRequest(
    researchRun: { sessionId: string; runId: string; leaseEpoch: number },
    operation: 'reservations' | 'replay' | 'outcomes' | 'failures',
    body: Record<string, unknown>,
    control?: ToolExecutionControl,
  ): Promise<Record<string, unknown>> {
    const credentials = RequestCredentialsStore.get();
    if (!credentials?.bearerToken)
      throw new Error('Authenticated research result authority is required.');
    return withMeriOrchestratorTelemetrySpan(
      { name: `meri.research.researchSafeReadRequest.${operation}`, boundary: 'research_source' },
      async () => {
        const response = await fetch(
          `${this.apiBaseUrl}/api/clio/research/${encodeURIComponent(researchRun.sessionId)}/runs/${encodeURIComponent(researchRun.runId)}/safe-read/${operation}`,
          {
            method: 'POST',
            signal: control?.signal,
            headers: {
              ...meriOrchestratorTelemetryHeaders(),
              authorization: ['Bearer', credentials.bearerToken].join(' '),
              'content-type': 'application/json',
              accept: 'application/json',
              ...(this.serviceSecret ? { 'x-internal-service-secret': this.serviceSecret } : {}),
              ...(credentials.impersonateTenantId
                ? { 'x-capiro-impersonate-tenant': credentials.impersonateTenantId }
                : {}),
            },
            body: JSON.stringify({ ...body, leaseEpoch: researchRun.leaseEpoch }),
          },
        );
        if (!response.ok)
          throw new Error(
            `Research result authority rejected ${operation} (HTTP ${response.status}).`,
          );
        return (await response.json()) as Record<string, unknown>;
      },
      'client',
    );
  }

  private durableProviderAccounting(
    researchRun: { sessionId: string; runId: string; leaseEpoch: number },
    control?: ToolExecutionControl,
  ): MeriDurableProviderAccounting {
    return {
      reserve: async (binding) => {
        const result = await this.researchProviderBudgetRequest(
          researchRun,
          'reservations',
          binding,
          control,
        );
        if (
          typeof result.reservationId !== 'string' ||
          typeof result.deadlineAt !== 'string' ||
          typeof result.dispatchAllowed !== 'boolean'
        )
          throw new Error('Research provider authority returned an invalid reservation.');
        return {
          reservationId: result.reservationId,
          deadlineAt: result.deadlineAt,
          dispatchAllowed: result.dispatchAllowed,
        };
      },
      settle: async (reservation, outcome) => {
        await this.researchProviderBudgetRequest(
          researchRun,
          'settlements',
          providerSettlementBody(reservation, outcome),
          control,
        );
      },
    };
  }

  private async researchProviderBudgetRequest(
    researchRun: { sessionId: string; runId: string; leaseEpoch: number },
    operation: 'reservations' | 'settlements',
    body: object,
    control?: ToolExecutionControl,
  ): Promise<Record<string, unknown>> {
    const credentials = RequestCredentialsStore.get();
    const serviceSecret = this.serviceSecret;
    if (!credentials?.bearerToken || !serviceSecret)
      throw new Error('Authenticated research provider budget authority is required.');
    return withMeriOrchestratorTelemetrySpan(
      {
        name: `meri.research.researchProviderBudgetRequest.${operation}`,
        boundary: 'research_budget',
      },
      async () => {
        const response = await fetch(
          `${this.apiBaseUrl}/api/clio/research/${encodeURIComponent(researchRun.sessionId)}/runs/${encodeURIComponent(researchRun.runId)}/provider-budget/${operation}`,
          {
            method: 'POST',
            signal: control?.signal,
            headers: {
              ...meriOrchestratorTelemetryHeaders(),
              authorization: 'Bearer ' + credentials.bearerToken,
              'x-internal-service-secret': serviceSecret,
              'content-type': 'application/json',
              accept: 'application/json',
              ...(credentials.impersonateTenantId
                ? { 'x-capiro-impersonate-tenant': credentials.impersonateTenantId }
                : {}),
            },
            body: JSON.stringify({ ...body, leaseEpoch: researchRun.leaseEpoch }),
          },
        );
        if (!response.ok)
          throw new Error(
            `Research provider budget rejected ${operation} (HTTP ${response.status}).`,
          );
        return (await response.json()) as Record<string, unknown>;
      },
      'client',
    );
  }

  private async reserveAuxiliaryResearchDispatch(
    dto: MeriV3ChatInput,
    tool: string,
    input: Record<string, unknown>,
    providerCallId: string,
    control?: ToolExecutionControl,
  ): Promise<void> {
    if (!dto.researchRun) return;
    const reservation = await this.researchSafeReadRequest(
      dto.researchRun,
      'reservations',
      { providerCallId, tool, input },
      control,
    );
    if (reservation.dispatchAllowed !== true || typeof reservation.reservationId !== 'string')
      throw new Error('Research tool attempt was not admitted for dispatch.');
  }

  private durableOutcome(value: unknown): DurableSafeReadOutcome {
    if (!value || typeof value !== 'object') throw new Error('Invalid durable safe-read receipt.');
    const receipt = value as Record<string, unknown>;
    if (
      typeof receipt.executionId !== 'string' ||
      typeof receipt.providerCallId !== 'string' ||
      typeof receipt.tool !== 'string' ||
      typeof receipt.toolVersion !== 'string' ||
      (receipt.classifier !== 'complete' &&
        receipt.classifier !== 'empty' &&
        receipt.classifier !== 'partial') ||
      typeof receipt.sequence !== 'number' ||
      typeof receipt.receiptId !== 'string'
    )
      throw new Error('Incomplete durable safe-read receipt.');
    return {
      executionId: receipt.executionId,
      providerCallId: receipt.providerCallId,
      tool: receipt.tool,
      toolVersion: receipt.toolVersion,
      classifier: receipt.classifier,
      sequence: receipt.sequence,
      receiptId: receipt.receiptId,
      replayed: receipt.replayed === true,
    };
  }

  protected async fetchToolSchemas(control?: ToolExecutionControl): Promise<ToolSchema[]> {
    // Entry guard on the ORIGINAL parent control. A stopped/expired request must
    // never start discovery (and must never become a benign empty native catalog).
    assertToolExecutionActive(control);
    const observer = catalogAvailabilityObserverOf(control);
    const credentials = RequestCredentialsStore.get();
    if (!credentials?.bearerToken) {
      observer?.noteNative({ outcome: 'missing_credential' });
      this.logger.warn('MeriV3: no bearer available; proceeding without Capiro tools');
      return [];
    }
    let nativeNoted = false;
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
      // The parent may have stopped/expired while the fetch was in flight: a
      // response that resolves after Stop is NOT healthy evidence for this turn,
      // and an HTTP error must not mask the stopped/expired parent.
      assertToolExecutionActive(control);
      if (!response.ok) {
        nativeNoted = true;
        observer?.noteNative({
          outcome:
            response.status === 401 || response.status === 403 ? 'auth_denied' : 'unavailable',
        });
        throw new Error(`HTTP ${response.status}`);
      }
      const body = (await response.json()) as { schemas?: ToolSchema[] };
      // Re-assert after the JSON await before any benign status is classified.
      assertToolExecutionActive(control);
      const raw = Array.isArray(body?.schemas) ? body.schemas : null;
      if (!raw) {
        // A missing/malformed array is a failure; a genuine [] is a real empty.
        nativeNoted = true;
        observer?.noteNative({ outcome: 'malformed' });
        return [];
      }
      const selected = selectMeriCapabilitySchemas(raw, 'full_chat', this.registry.list());
      nativeNoted = true;
      observer?.noteNative({ outcome: raw.length ? 'usable' : 'empty', count: selected.length });
      return selected;
    } catch (error) {
      // Never swallow a real transport cancellation.
      if (control?.signal?.aborted) throw error;
      // An expired deadline with an un-aborted signal is still a stopped turn:
      // propagate it rather than returning a benign empty catalog. Re-assert the
      // ORIGINAL parent so a caught HTTP/JSON/credential failure can never mask
      // expired parent state.
      assertToolExecutionActive(control);
      if (!nativeNoted) {
        observer?.noteNative({
          outcome: error instanceof SyntaxError ? 'malformed' : 'unavailable',
        });
      }
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

/**
 * The API's settlement contract (strictProviderSettlementInput) requires exactly
 * these keys plus leaseEpoch, which the transport adds. logicalOperationId and
 * retryOfAttemptId were added to that contract in 6da9414dd and never sent from
 * here, so every Deep Research settlement was refused with HTTP 400 and every
 * run ended partial at its first model call (Stage 2 Release A live check).
 */
export const PROVIDER_SETTLEMENT_KEYS = [
  'reservationId',
  'logicalOperationId',
  'attemptId',
  'retryOfAttemptId',
  'kind',
  'phase',
  'provider',
  'model',
  'outcome',
  'inputTokens',
  'outputTokens',
] as const;

export function providerSettlementBody(
  reservation: MeriProviderReservation,
  outcome:
    | { kind: 'known'; inputTokens: number; outputTokens: number }
    | { kind: 'rejected' }
    | { kind: 'uncertain' },
): Record<string, unknown> {
  return {
    reservationId: reservation.reservationId,
    logicalOperationId: reservation.logicalOperationId,
    attemptId: reservation.attemptId,
    retryOfAttemptId: reservation.retryOfAttemptId,
    kind: reservation.kind,
    phase: reservation.phase,
    provider: reservation.provider,
    model: reservation.model,
    outcome: outcome.kind,
    inputTokens: outcome.kind === 'known' ? outcome.inputTokens : null,
    outputTokens: outcome.kind === 'known' ? outcome.outputTokens : null,
  };
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
