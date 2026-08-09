import { Injectable } from '@nestjs/common';
import { AiCredentialResolverService } from '../../ai-credentials/ai-credential-resolver.service.js';
import {
  clarificationQuestionSchema,
  OUTREACH_REASONING_LIMITS,
  OutreachReasoningError,
  parseReasoningAssistantMessage,
  parseReasoningProposedCommands,
  type OutreachReasoningProvider,
  type ProviderConversationRef,
  type ReasoningProviderRequest,
  type ReasoningToolResultRef,
  type ReasoningTurnResult,
  type ReasoningUsage,
} from './outreach-reasoning.contract.js';

const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';
const REQUEST_TIMEOUT_MS = 90_000;

type OpenAiOutputItem =
  | {
      type: 'function_call';
      name: string;
      arguments: string;
      call_id: string;
      id?: string;
    }
  | {
      type: 'message';
      role?: string;
      content?: Array<{ type?: string; text?: string }>;
    };

interface OpenAiResponse {
  id?: string;
  status?: string;
  output?: OpenAiOutputItem[];
  output_text?: string;
  error?: { code?: string; message?: string } | null;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    output_tokens_details?: { reasoning_tokens?: number };
  } | null;
}

interface ProviderFinalPayload {
  assistantMessage?: unknown;
  proposedCommands?: unknown;
  openQuestions?: unknown;
}

const FINAL_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    assistantMessage: { type: 'string', maxLength: OUTREACH_REASONING_LIMITS.assistantMessageChars },
    proposedCommands: {
      type: 'array',
      maxItems: OUTREACH_REASONING_LIMITS.proposedCommands,
      items: { type: 'object' },
    },
    openQuestions: {
      type: 'array',
      maxItems: OUTREACH_REASONING_LIMITS.clarificationQuestions,
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', maxLength: 96 },
          question: {
            type: 'string',
            maxLength: OUTREACH_REASONING_LIMITS.clarificationQuestionChars,
          },
        },
        required: ['id', 'question'],
        additionalProperties: false,
      },
    },
  },
  required: ['assistantMessage', 'proposedCommands', 'openQuestions'],
  additionalProperties: false,
} as const;

@Injectable()
export class OpenAiOutreachReasoningProvider implements OutreachReasoningProvider {
  constructor(private readonly credentials: AiCredentialResolverService) {}

  async createConversation(input: {
    stateMode: ProviderConversationRef['stateMode'];
    model: string;
    reasoningEffort: ProviderConversationRef['reasoningEffort'];
  }): Promise<ProviderConversationRef> {
    return {
      provider: 'openai',
      stateMode: input.stateMode,
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      lastResponseId: null,
    };
  }

  async respond(input: ReasoningProviderRequest): Promise<ReasoningTurnResult> {
    const credential = await this.credentials.resolveProviderForOutreachReasoning(
      input.ctx,
      'openai',
    );
    if (!credential) {
      throw new OutreachReasoningError(
        'OUTREACH_REASONING_PROVIDER_UNAVAILABLE',
        'OpenAI reasoning is not configured for this Capiro environment.',
        503,
        true,
      );
    }

    const model = input.model.trim() || credential.model;
    const referencedToolResults: ReasoningToolResultRef[] = [];
    let totalToolCalls = 0;
    let previousResponseId = input.previousResponseId;
    let capiroManagedInput: unknown[] = this.initialCapiroManagedInput(input);
    let lastUsage: ReasoningUsage = emptyUsage();
    let finalResponseId: string | null = previousResponseId;

    for (let round = 0; round < OUTREACH_REASONING_LIMITS.toolRounds; round += 1) {
      const body: Record<string, unknown> = {
        model,
        instructions: input.instructions,
        store: input.store,
        tools: input.tools,
        tool_choice: 'auto',
        parallel_tool_calls: false,
        text: {
          format: {
            type: 'json_schema',
            name: 'outreach_reasoning_turn',
            description:
              'Visible assistant response plus optional validated Outreach planning command proposals.',
            schema: FINAL_OUTPUT_SCHEMA,
            strict: false,
          },
        },
      };

      if (supportsReasoningEffort(model)) {
        body.reasoning = { effort: input.reasoningEffort };
      }

      if (input.stateMode === 'provider_state' && previousResponseId) {
        body.previous_response_id = previousResponseId;
        body.input = round === 0 ? input.userMessage : capiroManagedInput;
      } else {
        body.input = capiroManagedInput;
      }

      const response = await this.postResponse(credential.apiKey, body);
      finalResponseId = typeof response.id === 'string' ? response.id : finalResponseId;
      lastUsage = usageFrom(response);

      const functionCalls = (response.output ?? []).filter(
        (item): item is Extract<OpenAiOutputItem, { type: 'function_call' }> =>
          item.type === 'function_call',
      );

      if (functionCalls.length === 0) {
        const payload = parseFinalPayload(extractOutputText(response));
        return {
          assistantMessage: parseReasoningAssistantMessage(payload.assistantMessage),
          proposedCommands: parseReasoningProposedCommands(payload.proposedCommands ?? []),
          openQuestions: parseOpenQuestions(payload.openQuestions),
          referencedToolResults,
          providerResponseRef: finalResponseId,
          usage: lastUsage,
        };
      }

      totalToolCalls += functionCalls.length;
      if (totalToolCalls > OUTREACH_REASONING_LIMITS.toolCallsPerTurn) {
        throw new OutreachReasoningError(
          'OUTREACH_REASONING_LIMIT_EXCEEDED',
          'The reasoning turn exceeded its safe read-tool budget.',
          502,
        );
      }

      const toolOutputs: Array<{ type: 'function_call_output'; call_id: string; output: string }> = [];
      for (const call of functionCalls) {
        let args: unknown;
        try {
          args = JSON.parse(call.arguments);
        } catch {
          throw new OutreachReasoningError(
            'OUTREACH_REASONING_OUTPUT_INVALID',
            'The reasoning provider returned malformed tool arguments.',
            502,
          );
        }

        let executed: { resultId: string; output: unknown };
        try {
          executed = await input.executeTool(call.name, args);
        } catch (error) {
          if (error instanceof OutreachReasoningError) throw error;
          throw new OutreachReasoningError(
            'OUTREACH_REASONING_TOOL_FAILED',
            'A Capiro read tool could not complete safely.',
            502,
            true,
          );
        }

        const encoded = JSON.stringify(executed.output);
        if (Buffer.byteLength(encoded, 'utf8') > OUTREACH_REASONING_LIMITS.toolOutputBytes) {
          throw new OutreachReasoningError(
            'OUTREACH_REASONING_LIMIT_EXCEEDED',
            'A Capiro read-tool result exceeded the reasoning response budget.',
            502,
          );
        }

        referencedToolResults.push({ resultId: executed.resultId, capability: call.name });
        toolOutputs.push({ type: 'function_call_output', call_id: call.call_id, output: encoded });
      }

      if (input.stateMode === 'provider_state') {
        previousResponseId = finalResponseId;
        capiroManagedInput = toolOutputs;
      } else {
        capiroManagedInput = [
          ...capiroManagedInput,
          ...(response.output ?? []),
          ...toolOutputs,
        ];
      }
    }

    throw new OutreachReasoningError(
      'OUTREACH_REASONING_LIMIT_EXCEEDED',
      'The reasoning turn exceeded its safe tool-round budget.',
      502,
    );
  }

  async cancel(_providerResponseRef: string): Promise<void> {
    // Phase 3 uses synchronous Responses calls and aborts them at the HTTP
    // request boundary. There is no background provider run to cancel.
  }

  private initialCapiroManagedInput(input: ReasoningProviderRequest): unknown[] {
    if (input.stateMode === 'provider_state') {
      return [{ role: 'user', content: input.userMessage }];
    }
    return [
      ...input.recentTranscript.map((turn) => ({ role: turn.role, content: turn.text })),
      { role: 'user', content: input.userMessage },
    ];
  }

  private async postResponse(apiKey: string, body: Record<string, unknown>): Promise<OpenAiResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(OPENAI_RESPONSES_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new OutreachReasoningError(
          response.status === 408 || response.status === 429 || response.status >= 500
            ? 'OUTREACH_REASONING_PROVIDER_UNAVAILABLE'
            : 'OUTREACH_REASONING_PROVIDER_REJECTED',
          `OpenAI reasoning request failed safely (HTTP ${response.status}).`,
          response.status === 429 || response.status >= 500 ? 503 : 502,
          response.status === 408 || response.status === 429 || response.status >= 500,
        );
      }

      const parsed = (await response.json()) as OpenAiResponse;
      if (!parsed || typeof parsed !== 'object' || parsed.error) {
        throw new OutreachReasoningError(
          'OUTREACH_REASONING_PROVIDER_REJECTED',
          'OpenAI returned an invalid reasoning response.',
          502,
        );
      }
      return parsed;
    } catch (error) {
      if (error instanceof OutreachReasoningError) throw error;
      const timedOut = error instanceof Error && error.name === 'AbortError';
      throw new OutreachReasoningError(
        'OUTREACH_REASONING_PROVIDER_UNAVAILABLE',
        timedOut
          ? 'OpenAI reasoning timed out safely.'
          : 'OpenAI reasoning was unavailable.',
        503,
        true,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

function supportsReasoningEffort(model: string): boolean {
  return /^(gpt-5|o[1-9])/i.test(model);
}

function extractOutputText(response: OpenAiResponse): string {
  if (typeof response.output_text === 'string' && response.output_text.trim()) {
    return response.output_text;
  }
  for (const item of response.output ?? []) {
    if (item.type !== 'message') continue;
    const text = item.content
      ?.filter((part) => part.type === 'output_text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('');
    if (text?.trim()) return text;
  }
  throw new OutreachReasoningError(
    'OUTREACH_REASONING_OUTPUT_INVALID',
    'The reasoning provider returned no visible response.',
    502,
  );
}

function parseFinalPayload(text: string): ProviderFinalPayload {
  try {
    const parsed = JSON.parse(text) as ProviderFinalPayload;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not object');
    }
    return parsed;
  } catch {
    throw new OutreachReasoningError(
      'OUTREACH_REASONING_OUTPUT_INVALID',
      'The reasoning provider returned malformed structured output.',
      502,
    );
  }
}

function parseOpenQuestions(value: unknown): Array<{ id: string; question: string }> {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > OUTREACH_REASONING_LIMITS.clarificationQuestions) {
    throw new OutreachReasoningError(
      'OUTREACH_REASONING_OUTPUT_INVALID',
      'The reasoning provider returned invalid clarification questions.',
      502,
    );
  }
  try {
    return value.map((entry) => clarificationQuestionSchema.parse(entry));
  } catch {
    throw new OutreachReasoningError(
      'OUTREACH_REASONING_OUTPUT_INVALID',
      'The reasoning provider returned invalid clarification questions.',
      502,
    );
  }
}

function usageFrom(response: OpenAiResponse): ReasoningUsage {
  return {
    inputTokens: numberOrNull(response.usage?.input_tokens),
    outputTokens: numberOrNull(response.usage?.output_tokens),
    reasoningTokens: numberOrNull(response.usage?.output_tokens_details?.reasoning_tokens),
    totalTokens: numberOrNull(response.usage?.total_tokens),
  };
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function emptyUsage(): ReasoningUsage {
  return { inputTokens: null, outputTokens: null, reasoningTokens: null, totalTokens: null };
}
