import type { ProviderUsage } from '@capiro/shared';
import type { ChatInput, ChatResult, ChatStreamEvent } from '../chat/chat-prompt.js';

/** Stable product labels. Provider model ids remain server configuration. */
export const MERIV3_REASONING_MODES = ['fast', 'standard', 'deep', 'max'] as const;
export type MeriV3ReasoningMode = (typeof MERIV3_REASONING_MODES)[number];

/** Responses API reasoning effort used by the configured model. */
export type MeriV3ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';

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
}

export interface MeriV3ChatResult extends ChatResult {
  runtime: 'meriv3';
  model: string;
  reasoningMode: MeriV3ReasoningMode;
  reasoningEffort: MeriV3ReasoningEffort;
}

export type MeriV3ChatStreamEvent =
  | ChatStreamEvent
  | {
      type: 'runtime';
      runtime: 'meriv3';
      model: string;
      reasoningMode: MeriV3ReasoningMode;
      reasoningEffort: MeriV3ReasoningEffort;
    };

export interface OpenAiResponsesFunctionTool {
  type: 'function';
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  strict?: boolean;
}

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
}
