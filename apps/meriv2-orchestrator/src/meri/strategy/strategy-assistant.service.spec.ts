import type { MeriContext } from '@capiro/meriv2-core';
import { StrategyAssistantService } from './strategy-assistant.service.js';
import type { MeriRegistryService } from '../meri-registry.service.js';
import type { ConfigService } from '@nestjs/config';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { StrategyContextPackService } from './strategy-context-pack.service.js';
import { sanitizePlanEdits, type StrategyAssistantInput, type StrategyDraftInput } from './strategy-prompt.js';
import type { ToolLoopResponse, AnthropicContentBlock } from '../request-scoped-llm.client.js';

/*
 * A5 repair-loop coverage for StrategyAssistantService.draft() (LLM proposes →
 * @capiro/strategy-verifier disposes → back-prompt on hard errors, ≤MAX_REPAIRS
 * additional attempts) plus a shape-threading check on assistant() (no repair
 * loop there). verifyPlan is the REAL implementation from @capiro/strategy-verifier
 * — never mocked — so the "errors trigger a repair" assertions are an honest
 * integration against the actual verifier rules, not a stubbed shortcut.
 */

const CTX = { tenantId: 't1', userId: 'u1', clerkUserId: 'c1', role: 'standard_user' } as MeriContext;

const PACK = {
  text: 'CLIENT CONTEXT TEXT',
  provenance: { sections: [], omitted: [] },
  health: { status: 'ok' as const, missingRequired: [], omittedOptional: [] },
};

/** Build a real StrategyAssistantService over a fully-controlled completeWithTools mock. */
function build() {
  const completeWithTools = jest.fn<Promise<ToolLoopResponse>, [unknown]>();
  const registry = { llm: { completeWithTools } } as unknown as MeriRegistryService;
  const config = { get: jest.fn(() => undefined) } as unknown as ConfigService;
  // recordAiUsageEvent (fired via `void this.meterRound(...)`, never awaited by the
  // caller) is exercised against these stubs directly — no jest.mock needed since
  // it swallows its own errors, but wiring working withTenant/withSystem stubs
  // keeps the test output free of the "metering write failed" warning noise.
  const prisma = {
    withTenant: jest.fn().mockResolvedValue(undefined),
    withSystem: jest.fn().mockResolvedValue(undefined),
  } as unknown as PrismaService;
  const compile = jest.fn().mockResolvedValue(PACK);
  const pack = { compile } as unknown as StrategyContextPackService;
  const svc = new StrategyAssistantService(registry, config, prisma, pack);
  return { svc, completeWithTools, compile };
}

/** A tool-use-only ToolLoopResponse for the given terminal tool. */
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

/** A prose-only (no tool_use) ToolLoopResponse — triggers runTerminal's nudge/exhaustion path. */
function textResp(text: string): ToolLoopResponse {
  const content: AnthropicContentBlock[] = [{ type: 'text', text }];
  return {
    content,
    stopReason: 'end_turn',
    usage: { inputTokens: 10, outputTokens: 10 },
    model: 'claude-test',
    usedTenantKey: false,
  };
}

const ASSISTANT_INPUT: StrategyAssistantInput = {
  scope: 'strategy',
  instruction: 'Add a step to file the memo',
  clientId: 'client-1',
  strategy: { id: 's1', title: 'FY28 plan', type: 'legislative', nodes: [] },
};

const BASE_DRAFT_INPUT: StrategyDraftInput = {
  clientId: 'client-1',
  type: 'legislative',
  goal: 'Win the FY28 plus-up',
};

describe('StrategyAssistantService.draft — A5 repair loop', () => {
  it('returns after ONE completeWithTools call when the first plan has zero verifier errors', async () => {
    const { svc, completeWithTools } = build();
    completeWithTools.mockResolvedValueOnce(
      toolResp('propose_strategy_draft', {
        summary: 'A clean single-step plan.',
        nodes: [
          { kind: 'action', subject: 'deliverable', title: 'Draft the ask memo', startsOn: '2027-01-15' },
        ],
      }),
    );

    const result = await svc.draft(CTX, BASE_DRAFT_INPUT);

    expect(completeWithTools).toHaveBeenCalledTimes(1);
    expect(result.summary).toBe('A clean single-step plan.');
    expect(result.nodes).toHaveLength(1);
    expect(result.violations).toEqual([]);
  });

  it('re-prompts with the verifier violation messages when the first plan has a real dep-order error', async () => {
    const { svc, completeWithTools } = build();
    // Node 0 depends on node 1, but node 1 starts LATER — a genuine dep-order
    // violation per @capiro/strategy-verifier's checkOrdering (not mocked).
    const violatingNodes = [
      {
        kind: 'action',
        subject: 'deliverable',
        title: 'File the funding request memo',
        startsOn: '2027-01-05',
        dependsOn: [1],
      },
      {
        kind: 'action',
        subject: 'milestone',
        title: 'Host the strategy kickoff',
        startsOn: '2027-04-01',
      },
    ];
    completeWithTools
      .mockResolvedValueOnce(
        toolResp('propose_strategy_draft', { summary: 'First pass.', nodes: violatingNodes }),
      )
      .mockResolvedValueOnce(
        toolResp('propose_strategy_draft', {
          summary: 'Fixed pass.',
          nodes: [
            { kind: 'action', subject: 'milestone', title: 'Host the strategy kickoff', startsOn: '2027-04-01' },
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

    const result = await svc.draft(CTX, BASE_DRAFT_INPUT);

    expect(completeWithTools).toHaveBeenCalledTimes(2);
    const secondCallParams = completeWithTools.mock.calls[1]![0] as { system: string };
    // The repair suffix carries the ACTUAL violation message forward verbatim.
    expect(secondCallParams.system).toContain('FIX THESE PROBLEMS');
    expect(secondCallParams.system).toContain('starts before the step it depends on');
    expect(secondCallParams.system).toContain('File the funding request memo');
    expect(secondCallParams.system).toContain('Host the strategy kickoff');
    // The repaired plan clears the verifier (dependency now precedes its dependent).
    expect(result.summary).toBe('Fixed pass.');
    expect(result.violations).toEqual([]);
  });

  it('stops after MAX_REPAIRS=2 additional attempts (≤3 total calls) even if errors never clear', async () => {
    const { svc, completeWithTools } = build();
    const violatingNodes = [
      {
        kind: 'action',
        subject: 'deliverable',
        title: 'Always-broken step',
        startsOn: '2027-01-05',
        dependsOn: [1],
      },
      { kind: 'action', subject: 'milestone', title: 'Later gate', startsOn: '2027-04-01' },
    ];
    // Every attempt re-proposes the SAME violating plan — errors never clear.
    completeWithTools.mockImplementation(async () =>
      toolResp('propose_strategy_draft', { summary: 'Still broken.', nodes: violatingNodes }),
    );

    const result = await svc.draft(CTX, BASE_DRAFT_INPUT);

    // 1 initial + MAX_REPAIRS(2) repairs = 3 total, never more, never an infinite loop.
    expect(completeWithTools).toHaveBeenCalledTimes(3);
    expect(result.violations.length).toBeGreaterThan(0);
    expect(result.nodes).toHaveLength(2);
    expect(result.summary).toBe('Still broken.');
  });

  it('breaks the loop early when a repaired response comes back with ZERO nodes', async () => {
    const { svc, completeWithTools } = build();
    const violatingNodes = [
      {
        kind: 'action',
        subject: 'deliverable',
        title: 'Broken step',
        startsOn: '2027-01-05',
        dependsOn: [1],
      },
      { kind: 'action', subject: 'milestone', title: 'Later gate', startsOn: '2027-04-01' },
    ];
    completeWithTools
      .mockResolvedValueOnce(
        toolResp('propose_strategy_draft', { summary: 'First pass.', nodes: violatingNodes }),
      )
      .mockResolvedValueOnce(
        toolResp('propose_strategy_draft', { summary: 'Nothing to draft.', nodes: [] }),
      );

    const result = await svc.draft(CTX, BASE_DRAFT_INPUT);

    // Stops right after the empty-nodes round — does NOT burn the remaining repair
    // budget treating an empty plan as still-erroring.
    expect(completeWithTools).toHaveBeenCalledTimes(2);
    expect(result.nodes).toEqual([]);
    expect(result.violations).toEqual([]);
    expect(result.summary).toBe('Nothing to draft.');
  });

  it('keeps repairing when a NON-EMPTY malformed response is sanitized down to ZERO nodes', async () => {
    const { svc, completeWithTools } = build();
    // Every attempt proposes nodes, but each one is missing a required field
    // (e.g. truncated near the token cap) so sanitizeDraftNodes drops them all —
    // this must NOT be mistaken for a deliberate empty plan.
    completeWithTools.mockImplementation(async () =>
      toolResp('propose_strategy_draft', {
        summary: 'Malformed pass.',
        nodes: [{ kind: 'action', subject: 'deliverable' /* missing title/startsOn */ }],
      }),
    );

    const result = await svc.draft(CTX, BASE_DRAFT_INPUT);

    // 1 initial + MAX_REPAIRS(2) repairs = 3 total — it spends the full repair
    // budget trying to get usable nodes instead of accepting the degenerate result.
    expect(completeWithTools).toHaveBeenCalledTimes(3);
    expect(result.nodes).toEqual([]);
  });

  it('keeps repairing when runTerminal is forced to finish with input:null', async () => {
    const { svc, completeWithTools } = build();
    // Every round is prose-only (no tool_use block), including the forced-finish
    // call — runTerminal exhausts its budget and returns { input: null, text }.
    completeWithTools.mockImplementation(async () => ({
      content: [{ type: 'text', text: 'thinking out loud, no tool call' }],
      stopReason: 'end_turn',
      usage: { inputTokens: 10, outputTokens: 10 },
      model: 'claude-test',
      usedTenantKey: false,
    }));

    const result = await svc.draft(CTX, BASE_DRAFT_INPUT);

    // Each draft() attempt drives its own bounded runTerminal (MAX_ROUNDS prose-only
    // nudges + 1 forced-finish call = 9 completeWithTools calls); a null tool input
    // must not be read as a deliberate empty plan, so all 1+MAX_REPAIRS(2) = 3
    // attempts are spent (27 total calls), not just 1.
    expect(result.nodes).toEqual([]);
    expect(completeWithTools).toHaveBeenCalledTimes(27);
  });
});

describe('StrategyAssistantService.assistant — no repair loop', () => {
  it('compiles the pack slim, calls the LLM once, and returns sanitizePlanEdits(edits)', async () => {
    const { svc, completeWithTools, compile } = build();
    const rawEdits = [
      {
        op: 'add',
        kind: 'action',
        subject: 'deliverable',
        title: 'New step',
        startsOn: '2027-02-01',
      },
      { op: 'not-a-real-op' }, // dropped by sanitizePlanEdits
    ];
    completeWithTools.mockResolvedValueOnce(
      toolResp('propose_plan_edits', {
        reply: 'Added it.',
        summary: 'Updated plan summary',
        edits: rawEdits,
      }),
    );

    const input: StrategyAssistantInput = {
      scope: 'strategy',
      instruction: 'Add a step to file the memo',
      clientId: 'client-1',
      strategy: { id: 's1', title: 'FY28 plan', type: 'legislative', nodes: [] },
    };

    const result = await svc.assistant(CTX, input);

    expect(completeWithTools).toHaveBeenCalledTimes(1);
    expect(compile).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: 'client-1', query: input.instruction, slim: true }),
    );
    expect(result.reply).toBe('Added it.');
    expect(result.summary).toBe('Updated plan summary');
    // Shape threading: assistant() returns exactly sanitizePlanEdits(raw edits),
    // no separate transform of its own.
    expect(result.edits).toEqual(sanitizePlanEdits(rawEdits));
    expect(result.edits).toHaveLength(1); // the bogus op was dropped
    expect(result.provenance).toBe(PACK.provenance);
    expect(result.groundingHealth).toBe(PACK.health);
  });
});

describe('StrategyAssistantService — runTerminal bounded loop (A7.4)', () => {
  it('nudges once on a prose-only round, then succeeds when the next round calls the tool', async () => {
    const { svc, completeWithTools } = build();
    completeWithTools
      .mockResolvedValueOnce(textResp('Let me think about this...'))
      .mockResolvedValueOnce(
        toolResp('propose_plan_edits', { reply: 'Added it.', edits: [] }),
      );

    const result = await svc.assistant(CTX, ASSISTANT_INPUT);

    expect(completeWithTools).toHaveBeenCalledTimes(2);
    // The nudge round replays the prose reply as an assistant turn, then asks
    // (as a user turn) for the terminal tool by name — not just "auto" retry.
    const secondCallParams = completeWithTools.mock.calls[1]![0] as {
      messages: Array<{ role: string; content: unknown }>;
    };
    expect(secondCallParams.messages).toHaveLength(3);
    expect(secondCallParams.messages[1]).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'Let me think about this...' }],
    });
    expect(secondCallParams.messages[2]).toEqual({
      role: 'user',
      content: 'Return your answer by calling the propose_plan_edits tool.',
    });
    expect(result.reply).toBe('Added it.');
  });

  it('exhausts MAX_ROUNDS=8 prose-only rounds, then force-finishes with toolChoice + FINISH NOW and returns the forced tool call', async () => {
    const { svc, completeWithTools } = build();
    let call = 0;
    completeWithTools.mockImplementation(async (params: unknown) => {
      call += 1;
      const { toolChoice } = params as { toolChoice?: unknown };
      if (toolChoice) {
        return toolResp('propose_plan_edits', { reply: 'Forced finish.', edits: [] });
      }
      return textResp(`still thinking, round ${call}`);
    });

    const result = await svc.assistant(CTX, ASSISTANT_INPUT);

    // 8 normal rounds (never a tool call) + 1 forced-finish call.
    expect(completeWithTools).toHaveBeenCalledTimes(9);
    const forcedCallParams = completeWithTools.mock.calls[8]![0] as {
      system: string;
      toolChoice?: unknown;
    };
    expect(forcedCallParams.toolChoice).toEqual({ type: 'tool', name: 'propose_plan_edits' });
    expect(forcedCallParams.system).toContain('FINISH NOW');
    expect(forcedCallParams.system).toContain('Call the propose_plan_edits tool now');
    expect(result.reply).toBe('Forced finish.');
  });

  it('falls back to the last prose text (never throws) when the forced-finish call itself errors', async () => {
    const { svc, completeWithTools } = build();
    let call = 0;
    completeWithTools.mockImplementation(async (params: unknown) => {
      call += 1;
      const { toolChoice } = params as { toolChoice?: unknown };
      if (toolChoice) {
        throw new Error('forced-finish call failed');
      }
      return textResp(`round ${call} musing`);
    });

    const result = await svc.assistant(CTX, ASSISTANT_INPUT);

    // Still 8 normal rounds + 1 (failed) forced-finish attempt — the error is
    // swallowed, not propagated to the caller.
    expect(completeWithTools).toHaveBeenCalledTimes(9);
    // Degrades to the last prose text seen rather than a hard failure.
    expect(result.reply).toBe('round 8 musing');
    expect(result.edits).toEqual([]);
  });
});
