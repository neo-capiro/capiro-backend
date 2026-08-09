import { z } from 'zod';
import {
  parseOutreachCommandEnvelope,
  type ParsedOutreachCommandEnvelope,
} from '../state/outreach-command.contract.js';

export const OUTREACH_REASONING_LIMITS = Object.freeze({
  userMessageChars: 16_000,
  assistantMessageChars: 24_000,
  clarificationQuestions: 8,
  clarificationQuestionChars: 600,
  proposedCommands: 20,
  referencedToolResults: 32,
  toolRounds: 6,
  toolCallsPerTurn: 16,
  toolOutputBytes: 96_000,
  recentTranscriptTurns: 12,
  recentTranscriptChars: 32_000,
});

export const OUTREACH_REASONING_PROVIDER = 'openai' as const;
export type OutreachReasoningProviderName = typeof OUTREACH_REASONING_PROVIDER;

export const OUTREACH_REASONING_STATE_MODES = ['capiro_managed', 'provider_state'] as const;
export type OutreachReasoningStateMode = (typeof OUTREACH_REASONING_STATE_MODES)[number];

export const OUTREACH_REASONING_EFFORTS = ['low', 'medium', 'high'] as const;
export type OutreachReasoningEffort = (typeof OUTREACH_REASONING_EFFORTS)[number];

export const OUTREACH_REASONING_ERROR_CODES = [
  'OUTREACH_REASONING_DISABLED',
  'OUTREACH_REASONING_INVALID_INPUT',
  'OUTREACH_REASONING_NOT_FOUND',
  'OUTREACH_REASONING_PROVIDER_UNAVAILABLE',
  'OUTREACH_REASONING_PROVIDER_REJECTED',
  'OUTREACH_REASONING_PROVIDER_STATE_DISABLED',
  'OUTREACH_REASONING_TOOL_NOT_ALLOWED',
  'OUTREACH_REASONING_TOOL_FAILED',
  'OUTREACH_REASONING_OUTPUT_INVALID',
  'OUTREACH_REASONING_LIMIT_EXCEEDED',
] as const;
export type OutreachReasoningErrorCode = (typeof OUTREACH_REASONING_ERROR_CODES)[number];

export class OutreachReasoningError extends Error {
  readonly name = 'OutreachReasoningError';

  constructor(
    readonly code: OutreachReasoningErrorCode,
    message: string,
    readonly httpStatus: number,
    readonly retryable = false,
    readonly safeMetadata?: Record<string, string | number | boolean | null>,
  ) {
    super(message);
  }
}

const boundedVisibleText = (max: number) =>
  z
    .string()
    .max(max)
    .transform((value) => value.replace(/\r\n?/g, '\n').trim());

export const reasoningTurnInputSchema = z
  .object({
    message: boundedVisibleText(OUTREACH_REASONING_LIMITS.userMessageChars).refine(
      (value) => value.length > 0,
      'message is required',
    ),
  })
  .strict();

export type ReasoningTurnInput = z.infer<typeof reasoningTurnInputSchema>;

export const clarificationQuestionSchema = z
  .object({
    id: z.string().min(1).max(96),
    question: boundedVisibleText(OUTREACH_REASONING_LIMITS.clarificationQuestionChars).refine(
      (value) => value.length > 0,
      'question is required',
    ),
  })
  .strict();

export interface ReasoningUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
}

export interface ReasoningToolResultRef {
  resultId: string;
  capability: string;
}

export interface ReasoningProposedCommandSet {
  commands: ParsedOutreachCommandEnvelope[];
}

export interface ReasoningTurnResult {
  assistantMessage: string;
  proposedCommands: ParsedOutreachCommandEnvelope[];
  openQuestions: Array<z.infer<typeof clarificationQuestionSchema>>;
  referencedToolResults: ReasoningToolResultRef[];
  providerResponseRef: string | null;
  usage: ReasoningUsage;
}

export interface ProviderConversationRef {
  provider: OutreachReasoningProviderName;
  stateMode: OutreachReasoningStateMode;
  model: string;
  reasoningEffort: OutreachReasoningEffort;
  lastResponseId: string | null;
}

export interface ReasoningTranscriptTurn {
  role: 'user' | 'assistant';
  text: string;
}

export interface ReasoningCampaignContext {
  sessionId: string;
  currentStateVersion: number;
  specHash: string;
  spec: unknown;
  readiness: unknown;
  pendingProposalCount: number;
}

export interface ReasoningProviderTool {
  type: 'function';
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  strict: true;
}

export interface ReasoningProviderRequest {
  provider: OutreachReasoningProviderName;
  stateMode: OutreachReasoningStateMode;
  model: string;
  reasoningEffort: OutreachReasoningEffort;
  store: boolean;
  previousResponseId: string | null;
  instructions: string;
  userMessage: string;
  recentTranscript: ReasoningTranscriptTurn[];
  tools: ReasoningProviderTool[];
  executeTool(name: string, input: unknown): Promise<{ resultId: string; output: unknown }>;
}

export interface OutreachReasoningProvider {
  createConversation(input: {
    stateMode: OutreachReasoningStateMode;
    model: string;
    reasoningEffort: OutreachReasoningEffort;
  }): Promise<ProviderConversationRef>;

  respond(input: ReasoningProviderRequest): Promise<ReasoningTurnResult>;

  cancel(providerResponseRef: string): Promise<void>;
}

export function parseReasoningTurnInput(input: unknown): ReasoningTurnInput {
  try {
    return reasoningTurnInputSchema.parse(input);
  } catch {
    throw new OutreachReasoningError(
      'OUTREACH_REASONING_INVALID_INPUT',
      'The Outreach reasoning request is invalid.',
      400,
    );
  }
}

export function parseReasoningProposedCommands(input: unknown): ParsedOutreachCommandEnvelope[] {
  if (!Array.isArray(input) || input.length > OUTREACH_REASONING_LIMITS.proposedCommands) {
    throw new OutreachReasoningError(
      'OUTREACH_REASONING_OUTPUT_INVALID',
      'The reasoning provider returned an invalid command proposal.',
      502,
    );
  }

  try {
    return input.map((entry) => parseOutreachCommandEnvelope(entry));
  } catch {
    throw new OutreachReasoningError(
      'OUTREACH_REASONING_OUTPUT_INVALID',
      'The reasoning provider returned an invalid command proposal.',
      502,
    );
  }
}

export function parseReasoningAssistantMessage(input: unknown): string {
  try {
    return boundedVisibleText(OUTREACH_REASONING_LIMITS.assistantMessageChars).parse(input);
  } catch {
    throw new OutreachReasoningError(
      'OUTREACH_REASONING_OUTPUT_INVALID',
      'The reasoning provider returned an invalid visible response.',
      502,
    );
  }
}
