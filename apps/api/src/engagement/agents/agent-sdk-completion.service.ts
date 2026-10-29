import { Logger, ServiceUnavailableException } from '@nestjs/common';
import {
  Agent,
  OpenAIProvider,
  run,
  setTracingDisabled,
  type JsonSchemaDefinition,
} from '@openai/agents';
import type { ProviderUsage } from '@capiro/shared';
import {
  LlmCompletionService,
  type LlmCompletionRequest,
  type LlmCompletionResult,
} from '../llm-completion.service.js';
import { openAiSupportsReasoningEffort } from '../generation/reasoning-effort.js';

/**
 * Meri note-taker preview: meeting prep / debrief / notes generation through the
 * OpenAI Agents SDK (`@openai/agents`) instead of the raw Responses transport.
 *
 * Drop-in for {@link LlmCompletionService.complete}: same request/result contract,
 * so the prep briefing job and the debrief generator switch transport without
 * changing prompt, schema or persistence. Non-OpenAI credentials (a tenant BYOK
 * anthropic key) keep the ordinary client — the Agents SDK is OpenAI-only.
 *
 * Off unless MEETING_ARTIFACT_AGENT_SDK is the literal 'true', so ordinary
 * (non-preview) environments keep the existing transport byte-for-byte. The key
 * is the already-configured OPENAI_API_KEY (AWS Secrets Manager → task env), or a
 * tenant BYOK key resolved upstream; this service never reads a secret itself.
 */
export const AGENT_SDK_FLAG = 'MEETING_ARTIFACT_AGENT_SDK';

export function agentSdkGenerationEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MEETING_ARTIFACT_AGENT_SDK === 'true';
}

/** Optional model override; unset means "whatever credential/model the caller resolved". */
export function agentSdkModelOverride(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env.MEETING_ARTIFACT_AGENT_MODEL?.trim();
  return value ? value : null;
}

const jsonschema = (req: LlmCompletionRequest): JsonSchemaDefinition => ({
  type: 'json_schema',
  name: req.jsonSchemaName ?? 'meeting_artifact',
  strict: true,
  schema: req.jsonSchema as unknown as JsonSchemaDefinition['schema'],
});

const joinUser = (userStatic: string, userVolatile: string): string =>
  userStatic ? `${userStatic}\n\n${userVolatile}` : userVolatile;

export interface AgentSdkCompletionDeps {
  /** Ordinary transport, used for non-OpenAI credentials. */
  fallback?: LlmCompletionService;
  env?: NodeJS.ProcessEnv;
  logger?: Pick<Logger, 'warn' | 'log'>;
  /** Injectable for tests; defaults to the SDK's `run`. */
  runAgent?: (
    agent: Agent<unknown, JsonSchemaDefinition>,
    input: string,
    options: { signal: AbortSignal },
  ) => Promise<{ finalOutput?: unknown; state: { usage?: unknown } }>;
  /** Injectable for tests; defaults to `new OpenAIProvider({ apiKey })`. */
  providerFactory?: (apiKey: string) => OpenAIProvider;
}

export class AgentSdkCompletionService {
  private readonly fallback: LlmCompletionService;
  private readonly env: NodeJS.ProcessEnv;
  private readonly logger: Pick<Logger, 'warn' | 'log'>;
  private readonly runAgent: NonNullable<AgentSdkCompletionDeps['runAgent']>;
  private readonly providerFactory: NonNullable<AgentSdkCompletionDeps['providerFactory']>;

  constructor(deps: AgentSdkCompletionDeps = {}) {
    this.fallback = deps.fallback ?? new LlmCompletionService();
    this.env = deps.env ?? process.env;
    this.logger = deps.logger ?? new Logger(AgentSdkCompletionService.name);
    this.runAgent = deps.runAgent ?? ((agent, input, options) => run(agent, input, options));
    this.providerFactory = deps.providerFactory ?? ((apiKey) => new OpenAIProvider({ apiKey }));
    // Backend generation must not upload agent traces; tracing has no per-run
    // switch in 0.21.0, only this process-wide one.
    setTracingDisabled(true);
  }

  async complete(req: LlmCompletionRequest): Promise<LlmCompletionResult> {
    if (req.provider !== 'openai') return this.fallback.complete(req);
    if (!req.apiKey) {
      throw new ServiceUnavailableException(
        'meeting_artifact_agent_sdk_requires_openai_credential',
      );
    }
    const model = agentSdkModelOverride(this.env) ?? req.model;
    const timeoutMs = req.timeoutMs ?? 90_000;
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
    const startedAt = Date.now();
    try {
      const agent = new Agent<unknown, JsonSchemaDefinition>({
        name: req.jsonSchemaName ?? 'meeting_artifact',
        instructions:
          req.system.trim() ||
          'You produce structured JSON for meeting artifacts. Return only the requested JSON.',
        model,
        outputType: jsonschema(req),
        modelSettings: {
          ...(req.maxTokens ? { maxTokens: req.maxTokens } : {}),
          ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
          ...(req.reasoningEffort && openAiSupportsReasoningEffort(model)
            ? { reasoning: { effort: req.reasoningEffort } }
            : {}),
        },
      });
      const provider = this.providerFactory(req.apiKey);
      // 0.21.0's run() has no modelProvider slot: resolve the Model from the
      // provider (this is what binds the request to the resolved credential key)
      // and hand that instance to the agent.
      agent.model = await provider.getModel(model);
      const result = await this.runAgent(agent, joinUser(req.userStatic, req.userVolatile), {
        signal,
      });
      const usage = toUsage(result.state.usage);
      this.logger.log(
        JSON.stringify({
          event: 'meeting_artifact_agent_sdk_call',
          stage: req.jsonSchemaName ?? 'result',
          runtimeAction: req.runtimeAction ?? null,
          model,
          elapsedMs: Date.now() - startedAt,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          status: 'completed',
        }),
      );
      return {
        text: JSON.stringify(result.finalOutput ?? {}),
        usage,
        stopReason: 'completed',
        truncated: false,
        raw: { agentSdk: true, finalOutput: result.finalOutput ?? null },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      this.logger.warn(
        JSON.stringify({
          event: 'meeting_artifact_agent_sdk_call',
          stage: req.jsonSchemaName ?? 'result',
          model,
          elapsedMs: Date.now() - startedAt,
          status: 'failed',
          errorType: error instanceof Error ? error.name : 'unknown',
        }),
      );
      if (signal.aborted && !req.signal?.aborted) {
        throw new ServiceUnavailableException(
          `openai completion failed: request timed out after ${timeoutMs / 1000}s`,
        );
      }
      req.signal?.throwIfAborted();
      throw new ServiceUnavailableException(`openai completion failed: ${message}`);
    }
  }
}

function toUsage(usage: unknown): ProviderUsage {
  const value = usage as
    | { inputTokens?: number; outputTokens?: number }
    | null
    | undefined;
  return {
    inputTokens: Number(value?.inputTokens ?? 0),
    outputTokens: Number(value?.outputTokens ?? 0),
  };
}
