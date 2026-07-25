import type { MeriContext } from '@capiro/meriv2-core';
import { recordAiUsageEvent } from '@capiro/shared';
import type { ConfigService } from '@nestjs/config';
import { StewardExtractService } from './steward-extract.service.js';
import type { MeriRegistryService } from '../meri-registry.service.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { StewardExtractInput } from './steward-prompt.js';
import type { AnthropicContentBlock, ToolLoopResponse } from '../request-scoped-llm.client.js';

/*
 * Stage E Steward extraction — a single FORCED tool call (never a loop, never
 * conversational), per-call metering under meriv2_steward_extract, and a
 * fail-soft empty result on model failure (api-strategy treats empty facts as
 * a no-op, so a flaky model never blocks a document upload).
 */

// Mock ONLY recordAiUsageEvent so the workflow label is assertable on the wire;
// everything else in @capiro/shared stays real.
jest.mock('@capiro/shared', () => ({
  ...jest.requireActual('@capiro/shared'),
  recordAiUsageEvent: jest.fn().mockResolvedValue(undefined),
}));

const CTX = {
  tenantId: 't1',
  userId: 'u1',
  clerkUserId: 'c1',
  role: 'standard_user',
} as MeriContext;

const INPUT: StewardExtractInput = {
  clientId: 'client-1',
  documentId: 'doc-1',
  templateKey: '02_client_constraints',
  authority: 'client_approved',
  asOf: '2026-07-01',
  content: '## Hard limits\nNo direct Hill outreach before October.',
  refs: [
    {
      ref: 'heading:Hard limits',
      kind: 'heading',
      preview: 'No direct Hill outreach before October.',
    },
  ],
  existingFacts: [
    {
      id: 'fact-aaa',
      fact: 'Direct Hill outreach is allowed from September.',
      documentTitle: 'Client constraints (v1)',
      authority: 'working_draft',
      asOf: '2026-05-01',
    },
  ],
};

/** Build a real StewardExtractService over a fully-controlled completeWithTools mock. */
function build() {
  const completeWithTools = jest.fn<Promise<ToolLoopResponse>, [unknown]>();
  const registry = { llm: { completeWithTools } } as unknown as MeriRegistryService;
  const config = { get: jest.fn(() => undefined) } as unknown as ConfigService;
  const prisma = {} as PrismaService; // recordAiUsageEvent is mocked — prisma is never touched
  const svc = new StewardExtractService(registry, config, prisma);
  return { svc, completeWithTools };
}

/** A tool-use-only ToolLoopResponse for emit_extracted_facts. */
function toolResp(input: Record<string, unknown>): ToolLoopResponse {
  const content: AnthropicContentBlock[] = [
    { type: 'tool_use', id: 'tu_1', name: 'emit_extracted_facts', input },
  ];
  return {
    content,
    stopReason: 'tool_use',
    usage: { inputTokens: 10, outputTokens: 10 },
    model: 'claude-test',
    usedTenantKey: true,
  };
}

beforeEach(() => {
  (recordAiUsageEvent as jest.Mock).mockClear();
});

describe('StewardExtractService.extract — happy path', () => {
  it('makes ONE forced-tool call and shapes the sanitized facts/conflicts/summary through', async () => {
    const { svc, completeWithTools } = build();
    completeWithTools.mockResolvedValueOnce(
      toolResp({
        summary: 'Extracted 2 facts; 1 conflict.',
        facts: [
          {
            fact: 'No direct Hill outreach before October.',
            sourceRef: 'heading:Hard limits',
            confidence: 0.95,
            citation: 'No direct Hill outreach before October.',
          },
          { fact: 'malformed — no sourceRef', confidence: 0.5, citation: 'x' },
        ],
        conflicts: [
          {
            newFactIndex: 0,
            existingFactId: 'fact-aaa',
            material: true,
            rationale: 'windows contradict',
          },
          {
            newFactIndex: 5,
            existingFactId: 'fact-aaa',
            material: true,
            rationale: 'out of range → dropped',
          },
        ],
      }),
    );

    const result = await svc.extract(CTX, INPUT);

    expect(completeWithTools).toHaveBeenCalledTimes(1);
    // Extraction is NOT conversational — the terminal tool is FORCED on the wire.
    const params = completeWithTools.mock.calls[0]![0] as {
      system: string;
      tools: Array<{ name: string; strict?: boolean }>;
      toolChoice: unknown;
      maxTokens: number;
    };
    expect(params.toolChoice).toEqual({ type: 'tool', name: 'emit_extracted_facts' });
    expect(params.tools).toHaveLength(1);
    expect(params.tools[0]!.name).toBe('emit_extracted_facts');
    expect(params.maxTokens).toBe(8192);
    expect(params.system).toContain('Cite sourceRef ONLY from this list — do not invent anchors');
    expect(params.system).toContain('[fact-aaa]');

    // Sanitized output: the malformed fact and the out-of-range conflict are gone.
    expect(result.summary).toBe('Extracted 2 facts; 1 conflict.');
    expect(result.facts).toEqual([
      {
        fact: 'No direct Hill outreach before October.',
        sourceRef: 'heading:Hard limits',
        authority: null,
        asOf: null,
        confidence: 0.95,
        citation: 'No direct Hill outreach before October.',
      },
    ]);
    expect(result.conflicts).toEqual([
      {
        newFactIndex: 0,
        existingFactId: 'fact-aaa',
        material: true,
        rationale: 'windows contradict',
      },
    ]);
  });

  it('meters the call as workflow meriv2_steward_extract', async () => {
    const { svc, completeWithTools } = build();
    completeWithTools.mockResolvedValueOnce(toolResp({ summary: 's', facts: [], conflicts: [] }));

    await svc.extract(CTX, INPUT);

    expect(recordAiUsageEvent).toHaveBeenCalledTimes(1);
    expect(recordAiUsageEvent).toHaveBeenCalledWith(
      expect.anything(),
      { tenantId: 't1', userId: 'u1' },
      'meriv2_steward_extract',
      expect.objectContaining({ provider: 'anthropic', model: 'claude-test', usedTenantKey: true }),
    );
  });

  it('degrades to an empty result when the forced call returns no tool_use block', async () => {
    const { svc, completeWithTools } = build();
    completeWithTools.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'prose only' }],
      stopReason: 'end_turn',
      usage: { inputTokens: 1, outputTokens: 1 },
      model: 'claude-test',
      usedTenantKey: false,
    });

    const result = await svc.extract(CTX, INPUT);

    expect(result).toEqual({ facts: [], conflicts: [], summary: '' });
  });
});

describe('StewardExtractService.extract — fail-soft (model failure)', () => {
  it('returns empty facts/conflicts with a diagnostic summary instead of throwing', async () => {
    const { svc, completeWithTools } = build();
    completeWithTools.mockRejectedValueOnce(new Error('Anthropic HTTP 529: overloaded'));

    const result = await svc.extract(CTX, INPUT);

    expect(result).toEqual({
      facts: [],
      conflicts: [],
      summary: 'extraction failed: Anthropic HTTP 529: overloaded',
    });
    // No response → nothing to meter.
    expect(recordAiUsageEvent).not.toHaveBeenCalled();
  });
});
