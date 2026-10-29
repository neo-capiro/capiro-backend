// Meri note-taker preview: meeting prep / debrief / notes generation through the
// OpenAI Agents SDK. No network — the SDK runner and provider are injected.

import { describe, expect, test } from '@jest/globals';
import { ServiceUnavailableException } from '@nestjs/common';
import {
  AgentSdkCompletionService,
  agentSdkGenerationEnabled,
  agentSdkModelOverride,
} from './agent-sdk-completion.service.js';
import type { LlmCompletionRequest, LlmCompletionResult } from '../llm-completion.service.js';

const req: LlmCompletionRequest = {
  provider: 'openai',
  apiKey: 'sk-test',
  model: 'gpt-test',
  system: 'SYSTEM',
  userStatic: 'STATIC',
  userVolatile: 'VOLATILE',
  jsonSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['recap'],
    properties: { recap: { type: 'string' } },
  },
  jsonSchemaName: 'meeting_debrief',
  maxTokens: 1200,
  temperature: 0.15,
  timeoutMs: 5_000,
};

const silentLogger = { warn: () => {}, log: () => {} };

const fallbackResult: LlmCompletionResult = {
  text: 'FALLBACK',
  usage: { inputTokens: 1, outputTokens: 1 },
  stopReason: 'completed',
  truncated: false,
  raw: {},
};

function makeService(runAgent: () => Promise<{ finalOutput?: unknown; state: { usage?: unknown } }>, env = {}) {
  const calls: Array<{ input: string }> = [];
  const models: string[] = [];
  const svc = new AgentSdkCompletionService({
    env,
    logger: silentLogger,
    fallback: { complete: async () => fallbackResult } as never,
    providerFactory: () =>
      ({
        getModel: async (name: string) => {
          models.push(name);
          return {};
        },
      }) as never,
    runAgent: (_agent, input) => {
      calls.push({ input });
      return runAgent();
    },
  });
  return { svc, calls, models };
}

describe('agent sdk generation switch', () => {
  test('is off unless the env value is the literal true', () => {
    expect(agentSdkGenerationEnabled({})).toBe(false);
    expect(agentSdkGenerationEnabled({ MEETING_ARTIFACT_AGENT_SDK: '1' })).toBe(false);
    expect(agentSdkGenerationEnabled({ MEETING_ARTIFACT_AGENT_SDK: 'true' })).toBe(true);
  });

  test('model override is nullable and trimmed', () => {
    expect(agentSdkModelOverride({})).toBeNull();
    expect(agentSdkModelOverride({ MEETING_ARTIFACT_AGENT_MODEL: '  ' })).toBeNull();
    expect(agentSdkModelOverride({ MEETING_ARTIFACT_AGENT_MODEL: ' gpt-5 ' })).toBe('gpt-5');
  });
});

describe('AgentSdkCompletionService', () => {
  test('keeps a non-OpenAI credential on the ordinary transport', async () => {
    const { svc, calls } = makeService(async () => ({ finalOutput: {}, state: {} }));
    const result = await svc.complete({ ...req, provider: 'anthropic', apiKey: 'anthropic-key' });
    expect(result.text).toBe('FALLBACK');
    expect(calls).toHaveLength(0);
  });

  test('refuses an OpenAI request without a credential', async () => {
    const { svc } = makeService(async () => ({ finalOutput: {}, state: {} }));
    await expect(svc.complete({ ...req, apiKey: '' })).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  test('runs the agent with the resolved model, schema and joined prompt', async () => {
    const { svc, calls, models } = makeService(async () => ({
      finalOutput: { recap: 'Recap text' },
      state: { usage: { inputTokens: 42, outputTokens: 7 } },
    }));
    const result = await svc.complete(req);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe('STATIC\n\nVOLATILE');
    expect(models[0]).toBe("gpt-test");
    expect(result.usage).toEqual({ inputTokens: 42, outputTokens: 7 });
    expect(JSON.parse(result.text)).toEqual({ recap: 'Recap text' });
    expect(result.truncated).toBe(false);
  });

  test('honours the model override env', async () => {
    const { svc, models } = makeService(
      async () => ({ finalOutput: {}, state: {} }),
      { MEETING_ARTIFACT_AGENT_MODEL: 'gpt-override' },
    );
    await svc.complete(req);
    expect(models[0]).toBe("gpt-override");
  });

  test('maps an SDK failure onto the transport error surface', async () => {
    const { svc } = makeService(async () => {
      throw new Error('tool loop failed');
    });
    await expect(svc.complete(req)).rejects.toThrow(
      /^openai completion failed: tool loop failed$/,
    );
  });
});
