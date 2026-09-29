import type { MeriContext } from '@capiro/meriv2-core';
import {
  StrategyAssistantService,
  type StrategyDraftProgressEvent,
} from './strategy-assistant.service.js';
import type { MeriRegistryService } from '../meri-registry.service.js';
import type { ConfigService } from '@nestjs/config';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { StrategyContextPackService } from './strategy-context-pack.service.js';
import type { StrategyDraftInput } from './strategy-prompt.js';
import type { ToolLoopResponse, AnthropicContentBlock } from '../request-scoped-llm.client.js';

/*
 * Coverage for the `onProgress` threading added for the streaming
 * `strategy-draft/stream` route (StrategyAssistantService.draft()'s new third
 * `opts` param). Two things matter most:
 *   1. onProgress fires in order, tagged with the SAME attempt/round counters
 *      draft()'s own repair loop and runTerminal()'s round loop already log —
 *      not a parallel/derived numbering.
 *   2. The existing no-callback call site (the non-streaming `strategy-draft`
 *      route, which calls `this.assistant.draft(ctx, dto)` with no third arg)
 *      is provably BYTE-IDENTICAL: same completeWithTools params shape (no
 *      onTextDelta key at all, not even undefined) and the same final result
 *      as running the identical scenario WITH a callback attached.
 */

const CTX = {
  tenantId: 't1',
  userId: 'u1',
  clerkUserId: 'c1',
  role: 'standard_user',
} as MeriContext;

const PACK = {
  text: 'CLIENT CONTEXT TEXT',
  provenance: { sections: [], omitted: [] },
  health: { status: 'ok' as const, missingRequired: [], omittedOptional: [] },
};

function build() {
  const completeWithTools = jest.fn<Promise<ToolLoopResponse>, [unknown]>();
  const registry = { llm: { completeWithTools } } as unknown as MeriRegistryService;
  const config = { get: jest.fn(() => undefined) } as unknown as ConfigService;
  const prisma = {
    withTenant: jest.fn().mockResolvedValue(undefined),
    withSystem: jest.fn().mockResolvedValue(undefined),
  } as unknown as PrismaService;
  const compile = jest.fn().mockResolvedValue(PACK);
  const pack = { compile } as unknown as StrategyContextPackService;
  const svc = new StrategyAssistantService(registry, config, prisma, pack);
  return { svc, completeWithTools, compile };
}

function toolResp(name: string, input: Record<string, unknown>): ToolLoopResponse {
  const content: AnthropicContentBlock[] = [{ type: 'tool_use', id: 'tu_1', name, input }];
  return {
    content,
    stopReason: 'tool_use',
    usage: { inputTokens: 10, outputTokens: 10 },
    model: 'claude-test',
    usedTenantKey: false,
  };
}

const BASE_DRAFT_INPUT: StrategyDraftInput = {
  clientId: 'client-1',
  type: 'legislative',
  goal: 'Win the FY28 plus-up',
};

const CLEAN_NODES = [
  { kind: 'action', subject: 'deliverable', title: 'Draft the ask memo', startsOn: '2027-01-15' },
];

const VIOLATING_NODES = [
  {
    kind: 'action',
    subject: 'deliverable',
    title: 'File the funding request memo',
    startsOn: '2027-04-01',
    endsOn: '2027-01-05',
  },
  {
    kind: 'action',
    subject: 'milestone',
    title: 'Host the strategy kickoff',
    startsOn: '2027-04-01',
  },
];

describe('StrategyAssistantService.draft — streaming onProgress', () => {
  it("emits onProgress deltas in order, tagged with the draft loop's own attempt/round counters", async () => {
    const { svc, completeWithTools } = build();
    // Attempt 1 (round 1): streams two deltas, then proposes a plan with a hard
    // verifier error -> triggers a repair (attempt 2).
    completeWithTools.mockImplementationOnce(async (params: unknown) => {
      const { onTextDelta } = params as { onTextDelta?: (d: string) => void };
      onTextDelta?.('Draft');
      onTextDelta?.('ing the plan');
      return toolResp('propose_strategy_draft', { summary: 'First pass.', nodes: VIOLATING_NODES });
    });
    // Attempt 2 (round 1): streams one more delta, then a clean plan.
    completeWithTools.mockImplementationOnce(async (params: unknown) => {
      const { onTextDelta } = params as { onTextDelta?: (d: string) => void };
      onTextDelta?.('Fixed it');
      return toolResp('propose_strategy_draft', { summary: 'Second pass.', nodes: CLEAN_NODES });
    });

    const events: StrategyDraftProgressEvent[] = [];
    const result = await svc.draft(CTX, BASE_DRAFT_INPUT, {
      onProgress: (event) => events.push(event),
    });

    expect(events).toEqual([
      { stage: 'drafting', attempt: 1, round: 1, delta: 'Draft' },
      { stage: 'drafting', attempt: 1, round: 1, delta: 'ing the plan' },
      { stage: 'drafting', attempt: 2, round: 1, delta: 'Fixed it' },
    ]);
    expect(result.summary).toBe('Second pass.');
    expect(result.violations).toEqual([]);
  });

  it('passes onTextDelta to completeWithTools ONLY when onProgress is supplied', async () => {
    const { svc, completeWithTools } = build();
    completeWithTools.mockResolvedValue(
      toolResp('propose_strategy_draft', { summary: 'Clean plan.', nodes: CLEAN_NODES }),
    );

    await svc.draft(CTX, BASE_DRAFT_INPUT); // no opts at all — the non-streaming call site's shape
    const noCallbackParams = completeWithTools.mock.calls[0]![0] as Record<string, unknown>;
    expect('onTextDelta' in noCallbackParams).toBe(false);

    completeWithTools.mockClear();
    await svc.draft(CTX, BASE_DRAFT_INPUT, { onProgress: () => {} });
    const withCallbackParams = completeWithTools.mock.calls[0]![0] as Record<string, unknown>;
    expect(typeof withCallbackParams.onTextDelta).toBe('function');
  });

  it('the no-callback path is provably unchanged: identical final result with and without onProgress attached', async () => {
    const scenario = () => {
      const { svc, completeWithTools } = build();
      completeWithTools
        .mockResolvedValueOnce(
          toolResp('propose_strategy_draft', { summary: 'Worse pass.', nodes: VIOLATING_NODES }),
        )
        .mockResolvedValueOnce(
          toolResp('propose_strategy_draft', {
            summary: 'Better pass.',
            nodes: [
              {
                kind: 'action',
                subject: 'milestone',
                title: 'Host the strategy kickoff',
                startsOn: '2027-04-01',
              },
              {
                kind: 'action',
                subject: 'deliverable',
                title: 'File the funding request memo',
                startsOn: '2027-05-01',
                dependsOn: [0],
              },
            ],
          }),
        );
      return svc.draft(CTX, BASE_DRAFT_INPUT);
    };

    const withoutCallback = await scenario();

    const events: StrategyDraftProgressEvent[] = [];
    const { svc, completeWithTools } = build();
    completeWithTools
      .mockResolvedValueOnce(
        toolResp('propose_strategy_draft', { summary: 'Worse pass.', nodes: VIOLATING_NODES }),
      )
      .mockResolvedValueOnce(
        toolResp('propose_strategy_draft', {
          summary: 'Better pass.',
          nodes: [
            {
              kind: 'action',
              subject: 'milestone',
              title: 'Host the strategy kickoff',
              startsOn: '2027-04-01',
            },
            {
              kind: 'action',
              subject: 'deliverable',
              title: 'File the funding request memo',
              startsOn: '2027-05-01',
              dependsOn: [0],
            },
          ],
        }),
      );
    const withCallback = await svc.draft(CTX, BASE_DRAFT_INPUT, {
      onProgress: (event) => events.push(event),
    });

    expect(withCallback).toEqual(withoutCallback);
    expect(withCallback.summary).toBe('Better pass.');
  });

  it('a pre-aborted signal skips the LLM call entirely and returns the same default result draft() falls back to', async () => {
    const { svc, completeWithTools } = build();
    const controller = new AbortController();
    controller.abort();

    const result = await svc.draft(CTX, BASE_DRAFT_INPUT, { signal: controller.signal });

    expect(completeWithTools).not.toHaveBeenCalled();
    expect(result).toEqual({
      summary: 'Drafted a plan from your goal.',
      nodes: [],
      provenance: PACK.provenance,
      violations: [],
      groundingHealth: PACK.health,
    });
  });

  it('aborting mid-loop (simulating a client disconnect between attempts) stops further repair attempts, keeping the best-so-far result', async () => {
    const { svc, completeWithTools } = build();
    const controller = new AbortController();
    // Attempt 1 proposes a plan with a hard verifier error (triggers a repair)
    // but the "client" disconnects while this call was in flight.
    completeWithTools.mockImplementationOnce(async () => {
      controller.abort();
      return toolResp('propose_strategy_draft', { summary: 'First pass.', nodes: VIOLATING_NODES });
    });

    const result = await svc.draft(CTX, BASE_DRAFT_INPUT, { signal: controller.signal });

    // Only the one in-flight call — the disconnect check at the top of the next
    // repair iteration stops a second (wasted) attempt from firing.
    expect(completeWithTools).toHaveBeenCalledTimes(1);
    expect(result.summary).toBe('First pass.');
    expect(result.nodes).toHaveLength(2);
    expect(result.violations.some((v) => v.severity === 'error')).toBe(true);
  });
});
