import type { ProviderUsage } from '@capiro/shared';
import type {
  LedgerEntry,
  MeriEvidenceManifest,
  MeriResearchPlanExecutionEnvelopeV1,
} from '@capiro/meriv2-core';
import type {
  ChatInput,
  ChatResult,
  ChatStreamEvent,
  DurableSafeReadOutcome,
} from '../chat/chat-prompt.js';
import type { MeriCoverageManifest } from '../retrieval/meri-retrieval-coverage.js';
import type { MeriRetrievalTrace } from '../retrieval/meri-retrieval-coordinator.js';
import type {
  MeriRetrievalDomain,
  MeriRuntimeRetrievalRecipeTool,
  MeriRetrievalTimeWindow,
} from '../retrieval/meri-retrieval-plan.js';
import type { MeriQueryClass, MeriSubjectScope } from '../retrieval/meri-retrieval-intent.js';
import type { MeriToolCoverageReceipt } from './meriv3-turn-coverage.js';

/** Stable product labels. Provider model ids remain server configuration. */
export const MERIV3_REASONING_MODES = ['fast', 'standard', 'deep', 'max'] as const;
export type MeriV3ReasoningMode = (typeof MERIV3_REASONING_MODES)[number];

/** Responses API reasoning effort used by the configured model. */
export type MeriV3ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** Provider execution facts; never contains provider reasoning or raw errors. */
export interface MeriV3ProviderTelemetry {
  requestedModel: string;
  effectiveModel: string | null;
  requestedReasoningEffort: MeriV3ReasoningEffort;
  /** Null means omitted/unknown, not that the model performed no reasoning. */
  effectiveReasoningEffort: MeriV3ReasoningEffort | null;
  reasoningFallbackReasons: string[];
  finishReason: string;
  partial: boolean;
}

export interface MeriV3ReasoningProfile {
  mode: MeriV3ReasoningMode;
  label: string;
  description: string;
  model: string;
  effort: MeriV3ReasoningEffort;
  maxOutputTokens: number;
  maxToolRounds: number;
  turnBudgetMs: number;
}

export interface MeriV3ChatInput extends ChatInput {
  reasoningMode?: MeriV3ReasoningMode;
  /** A caller may only narrow the normal governed full-chat capabilities. */
  toolPolicy?: 'none' | 'read-only';
  /** Server-owned durable research lease; reauthorized before each dispatch. */
  researchRun?: { sessionId: string; runId: string; leaseEpoch: number };
  /** API-admitted read authority; valid only under the governed-context MAC. */
  researchPlanExecution?: MeriResearchPlanExecutionEnvelopeV1;
}

export interface MeriV3RetrievalSummary {
  plan: {
    version: 1;
    queryClass: MeriQueryClass;
    subjectScope: MeriSubjectScope;
    targetHint: string | null;
    recipeTool: MeriRuntimeRetrievalRecipeTool | null;
    requireCompleteCoverage: boolean;
    requiredDomains: MeriRetrievalDomain[];
    timeWindow: MeriRetrievalTimeWindow | null;
  };
  coverage: MeriCoverageManifest;
  trace: MeriRetrievalTrace;
}

export interface MeriV3ChatResult extends ChatResult {
  toolCoverage?: MeriToolCoverageReceipt[];
  evidenceManifest?: MeriEvidenceManifest;
  providerCalls?: MeriV3ProviderTelemetry[];
  /** Tool evidence for the API research auditor; never provider reasoning. */
  ledgerEntries?: Array<LedgerEntry & { durableSafeRead?: DurableSafeReadOutcome }>;
  held?: boolean;
  runtime: 'meriv3';
  model: string;
  reasoningMode: MeriV3ReasoningMode;
  reasoningEffort: MeriV3ReasoningEffort | null;
  telemetry?: MeriV3ProviderTelemetry;
  retrieval?: MeriV3RetrievalSummary;
  evidenceAccuracy?: 'enforce';
}

export type MeriV3ChatStreamEvent =
  | ChatStreamEvent
  | {
      type: 'runtime';
      runtime: 'meriv3';
      model: string;
      reasoningMode: MeriV3ReasoningMode;
      reasoningEffort: MeriV3ReasoningEffort | null;
      telemetry?: MeriV3ProviderTelemetry;
      providerCalls?: MeriV3ProviderTelemetry[];
    };

export interface OpenAiResponsesFunctionTool {
  type: 'function';
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  strict?: boolean;
}

export type OpenAiResponsesToolChoice =
  | 'auto'
  | 'none'
  | 'required'
  | {
      type: 'function';
      name: string;
    };

export interface OpenAiResponsesFunctionCall {
  type: 'function_call';
  call_id: string;
  name: string;
  arguments: string;
  id?: string;
  status?: string;
}

export interface OpenAiResponsesOutputText {
  type: 'output_text';
  text: string;
  annotations?: unknown[];
}

export interface OpenAiResponsesMessageItem {
  type: 'message';
  role?: 'assistant';
  status?: string;
  content?: Array<OpenAiResponsesOutputText | { type: string; [key: string]: unknown }>;
  [key: string]: unknown;
}

export type OpenAiResponsesOutputItem =
  | OpenAiResponsesFunctionCall
  | OpenAiResponsesMessageItem
  | { type: 'reasoning'; [key: string]: unknown }
  | { type: string; [key: string]: unknown };

export interface OpenAiResponsesResult {
  id: string;
  status: string;
  output: OpenAiResponsesOutputItem[];
  outputText: string;
  functionCalls: OpenAiResponsesFunctionCall[];
  usage: ProviderUsage;
  model: string;
  usedTenantKey: boolean;
  incompleteReason?: string | null;
  telemetry: MeriV3ProviderTelemetry;
  /** Includes hidden critic/synthesis calls when the research runtime invokes them. */
  providerCalls?: MeriV3ProviderTelemetry[];
}
