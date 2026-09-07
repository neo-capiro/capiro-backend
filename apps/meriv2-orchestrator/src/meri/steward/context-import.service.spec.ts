import {
  BadGatewayException,
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { MeriContext } from '@capiro/meriv2-core';
import { recordAiUsageEvent } from '@capiro/shared';
import type { ConfigService } from '@nestjs/config';
import type { MeriRegistryService } from '../meri-registry.service.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { ToolLoopResponse } from '../request-scoped-llm.client.js';
import { ContextImportService } from './context-import.service.js';
import { CONTEXT_IMPORT_LABELS, type StrategyContextImportInput } from './context-import-prompt.js';

jest.mock('@capiro/shared', () => ({
  ...jest.requireActual('@capiro/shared'),
  recordAiUsageEvent: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../meri-registry.service.js', () => ({
  MeriRegistryService: class MeriRegistryService {},
}));
jest.mock('../../prisma/prisma.service.js', () => ({
  PrismaService: class PrismaService {},
}));

const CTX = {
  tenantId: 't1',
  userId: 'u1',
  clerkUserId: 'c1',
  role: 'standard_user',
} as MeriContext;
const SOURCE = 'The client seeks a $12 million FY2027 request; no appropriation has been enacted.';
const INPUT: StrategyContextImportInput = {
  clientId: 'client-1',
  source: {
    attachmentId: 'upload-1',
    fileName: 'Firm blueprint.pptx',
    contentHash: 'source-hash',
  },
  sections: [{ ref: 'slide:1', text: SOURCE }],
};

function build(timeout?: string) {
  const completeWithTools = jest.fn<Promise<ToolLoopResponse>, [unknown]>();
  const registry = {
    llm: { completeWithTools },
  } as unknown as MeriRegistryService;
  const config = { get: jest.fn(() => timeout) } as unknown as ConfigService;
  const service = new ContextImportService(registry, config, {} as PrismaService);
  return { service, completeWithTools };
}

function response(): ToolLoopResponse {
  return {
    content: [
      {
        type: 'tool_use',
        id: 'tu_1',
        name: 'emit_strategy_context_import',
        input: {
          documents: [
            {
              documentType: 'strategy_brief',
              title: CONTEXT_IMPORT_LABELS.strategy_brief,
              sections: [
                {
                  heading: 'Source details',
                  content: SOURCE,
                  evidence: [{ sourceRef: 'slide:1', quote: SOURCE }],
                },
              ],
            },
          ],
          warnings: [],
          conflicts: [],
        },
      },
    ],
    stopReason: 'tool_use',
    model: 'tenant-custom-model',
    provider: 'openai',
    usedTenantKey: true,
    usage: { inputTokens: 100, outputTokens: 80 },
  };
}

beforeEach(() => jest.clearAllMocks());
afterEach(() => jest.useRealTimers());

describe('ContextImportService source-only LLM conversion', () => {
  it('forces one tool, separates untrusted source data, caps timeout and returns only source-validated output', async () => {
    const { service, completeWithTools } = build('120000');
    completeWithTools.mockResolvedValue(response());
    const result = await service.import(CTX, INPUT);
    expect(result.documents[0]?.sections[0]?.content).toBe(SOURCE);
    expect(result.model).toBe('tenant-custom-model');
    expect(completeWithTools).toHaveBeenCalledTimes(1);
    expect(completeWithTools).toHaveBeenCalledWith(
      expect.objectContaining({
        toolChoice: { type: 'tool', name: 'emit_strategy_context_import' },
        timeoutMs: 50_000,
        maxTokens: 8192,
        signal: expect.any(AbortSignal),
        messages: [{ role: 'user', content: JSON.stringify(INPUT) }],
      }),
    );
    const system = (completeWithTools.mock.calls[0]![0] as { system: string }).system;
    expect(system).not.toContain(SOURCE);
  });

  it('meters the actual responding provider under authenticated tenant and user', async () => {
    const { service, completeWithTools } = build();
    completeWithTools.mockResolvedValue(response());
    await service.import(CTX, INPUT);
    expect(recordAiUsageEvent).toHaveBeenCalledWith(
      expect.anything(),
      { tenantId: 't1', userId: 'u1' },
      'meriv2_strategy_context_import',
      expect.objectContaining({
        provider: 'openai',
        model: 'tenant-custom-model',
        usedTenantKey: true,
      }),
    );
  });

  it('rejects unreadable/oversize input before a model call', async () => {
    const { service, completeWithTools } = build();
    await expect(service.import(CTX, { ...INPUT, sections: [] })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(completeWithTools).not.toHaveBeenCalled();
  });

  it('fails explicitly on provider failure without exposing provider errors or fake success', async () => {
    const { service, completeWithTools } = build();
    completeWithTools.mockRejectedValue(new Error('Provider secret-key-and-private-source'));
    await expect(service.import(CTX, INPUT)).rejects.toThrow('Meri could not finish');
    expect(recordAiUsageEvent).not.toHaveBeenCalled();
  });

  it.each(['max_tokens', 'length', 'refusal', 'end_turn', null])(
    'rejects a partial/refused tool result with stopReason %s',
    async (stopReason) => {
      const { service, completeWithTools } = build();
      completeWithTools.mockResolvedValue({ ...response(), stopReason });
      await expect(service.import(CTX, INPUT)).rejects.toBeInstanceOf(BadGatewayException);
      expect(recordAiUsageEvent).toHaveBeenCalledTimes(1);
    },
  );

  it('rejects missing and duplicate terminal tools', async () => {
    const { service, completeWithTools } = build();
    completeWithTools.mockResolvedValueOnce({
      ...response(),
      content: [{ type: 'text', text: 'No data' }],
    });
    await expect(service.import(CTX, INPUT)).rejects.toBeInstanceOf(BadGatewayException);
    completeWithTools.mockResolvedValueOnce({
      ...response(),
      content: [...response().content, ...response().content],
    });
    await expect(service.import(CTX, INPUT)).rejects.toBeInstanceOf(BadGatewayException);
  });

  it('rejects hallucinated evidence at the service boundary', async () => {
    const { service, completeWithTools } = build();
    const result = response();
    const input = (result.content[0] as { input: unknown }).input as {
      documents: Array<{
        sections: Array<{ evidence: Array<{ sourceRef: string }> }>;
      }>;
    };
    input.documents[0]!.sections[0]!.evidence[0]!.sourceRef = 'page:999';
    completeWithTools.mockResolvedValue(result);
    await expect(service.import(CTX, INPUT)).rejects.toThrow('does not match');
  });

  it('aborts the overall conversion deadline even when an adapter fails to settle', async () => {
    jest.useFakeTimers();
    const { service, completeWithTools } = build('25');
    completeWithTools.mockImplementation(() => new Promise(() => undefined));
    const pending = service.import(CTX, INPUT);
    const assertion = expect(pending).rejects.toBeInstanceOf(ServiceUnavailableException);
    await jest.advanceTimersByTimeAsync(26);
    await assertion;
    const signal = (completeWithTools.mock.calls[0]![0] as { signal: AbortSignal }).signal;
    expect(signal.aborted).toBe(true);
  });
});

describe('ContextImportService save-time comparison', () => {
  const input = {
    clientId: 'client-1',
    incomingFacts: [{ id: 'new:0', fact: 'The deadline is October 1.' }],
    existingFacts: [{ id: 'old', fact: 'The deadline is October 15.' }],
  };

  it('uses a separate forced comparison tool and leaves reviewed content unchanged', async () => {
    const { service, completeWithTools } = build();
    const compared = {
      conflicts: [{ incomingFactId: 'new:0', otherFactId: 'old', material: true }],
      warnings: [],
    };
    completeWithTools.mockResolvedValue({
      ...response(),
      content: [
        {
          type: 'tool_use',
          id: 'tu_compare',
          name: 'emit_strategy_context_conflicts',
          input: compared,
        },
      ],
    });
    expect(await service.compare(CTX, input)).toEqual(compared);
    expect(completeWithTools).toHaveBeenCalledWith(
      expect.objectContaining({
        toolChoice: { type: 'tool', name: 'emit_strategy_context_conflicts' },
        maxTokens: 4096,
        messages: [{ role: 'user', content: JSON.stringify(input) }],
      }),
    );
    expect(recordAiUsageEvent).toHaveBeenCalledWith(
      expect.anything(),
      { tenantId: 't1', userId: 'u1' },
      'meriv2_strategy_context_compare',
      expect.anything(),
    );
  });

  it('fails closed on provider failure and unresolvable output IDs', async () => {
    const { service, completeWithTools } = build();
    completeWithTools.mockRejectedValueOnce(new Error('provider unavailable'));
    await expect(service.compare(CTX, input)).rejects.toBeInstanceOf(ServiceUnavailableException);
    completeWithTools.mockResolvedValueOnce({
      ...response(),
      content: [
        {
          type: 'tool_use',
          id: 'tu_compare',
          name: 'emit_strategy_context_conflicts',
          input: {
            conflicts: [
              {
                incomingFactId: 'new:0',
                otherFactId: 'nonexistent',
                material: true,
              },
            ],
            warnings: [],
          },
        },
      ],
    });
    await expect(service.compare(CTX, input)).rejects.toBeInstanceOf(BadGatewayException);
  });
});
