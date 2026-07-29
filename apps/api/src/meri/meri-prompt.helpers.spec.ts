import {
  addUsage,
  applyRoundUsageEvent,
  applyToolCacheControl,
  buildMeriSystemBlocks,
  clientScopeDirective,
  clientScopeRefusal,
  CLIENT_ID_UUID_RE,
  meriCapabilityBlock,
  CLIO_CAPABILITY_LINES,
  emptyUsage,
  readUsageFromStreamEvent,
  MERI_GROUNDING_INVARIANT,
  MERI_GROUNDING_OUTREACH_KERNEL,
  meriGroundingSurfaceBlock,
  meriGroundingDateBlock,
  validateFormBCitations,
} from './meri-prompt.helpers.js';

// A conversation assigned to a client answered with OTHER clients' work because
// nothing in the prompt ever said the session was a boundary — the client was
// just a `Client: <name>` line inside the context snapshot, next to the firm's
// full roster (reported live 2026-07-29).
describe('clientScopeDirective — the hard scope constraint for a client session', () => {
  it('names the client and forbids other clients outright', () => {
    const directive = clientScopeDirective('C2 Strategies');
    expect(directive).toContain('HARD CONSTRAINT');
    expect(directive).toContain('"C2 Strategies"');
    expect(directive).toMatch(/Do NOT report, compare, summarize, or mention any other client's/);
  });

  it('tells the model what to do when asked about a different client (refuse, not answer)', () => {
    const directive = clientScopeDirective('C2 Strategies');
    expect(directive).toContain("switch the session's client");
    expect(directive).toContain("Do not answer from another client's data");
  });

  it('keeps the roster answerable — it is scoped as a lookup list, not as material', () => {
    expect(clientScopeDirective('C2 Strategies')).toContain(
      'provided only so you can answer questions about the roster itself',
    );
  });

  it('still constrains the session when the client name is missing or blank', () => {
    for (const name of [null, undefined, '   ']) {
      const directive = clientScopeDirective(name);
      expect(directive).toContain('HARD CONSTRAINT');
      expect(directive).toContain('the client this session is assigned to');
      expect(directive).not.toContain('""');
    }
  });
});

describe('clientScopeRefusal — what a cross-client tool call gets back', () => {
  it('states that nothing was read and names the session client', () => {
    const refusal = clientScopeRefusal('C2 Strategies');
    expect(refusal).toContain('Blocked');
    expect(refusal).toContain('nothing was read');
    expect(refusal).toContain('"C2 Strategies"');
  });

  it('is worded for the user, since the model relays it', () => {
    expect(clientScopeRefusal('C2 Strategies')).toContain('Tell the user');
  });

  it('degrades to an unnamed phrasing rather than an empty quote', () => {
    expect(clientScopeRefusal(null)).toContain('the client this session is assigned to');
    expect(clientScopeRefusal('')).not.toContain('""');
  });
});

describe('CLIENT_ID_UUID_RE — tells a client uuid apart from an exact client name', () => {
  it('matches a uuid in either case', () => {
    expect(CLIENT_ID_UUID_RE.test('3f6d5a1e-8c2b-4d7f-9a10-2b3c4d5e6f70')).toBe(true);
    expect(CLIENT_ID_UUID_RE.test('3F6D5A1E-8C2B-4D7F-9A10-2B3C4D5E6F70')).toBe(true);
  });

  it('does not match a client name or a partial id', () => {
    expect(CLIENT_ID_UUID_RE.test('C2 Strategies')).toBe(false);
    expect(CLIENT_ID_UUID_RE.test('3f6d5a1e-8c2b-4d7f-9a10')).toBe(false);
    expect(CLIENT_ID_UUID_RE.test('')).toBe(false);
  });
});

describe('MERI_GROUNDING_INVARIANT (Wave 1 zero-trust kernel)', () => {
  it('opens the meri_grounding element and states every kernel block', () => {
    expect(MERI_GROUNDING_INVARIANT.startsWith('<meri_grounding version="1.0">')).toBe(true);
    expect(MERI_GROUNDING_INVARIANT).toContain('CLOSED-WORLD RULE');
    expect(MERI_GROUNDING_INVARIANT).toContain('Data missing from legislative context');
    expect(MERI_GROUNDING_INVARIANT).toContain('CITATION TOKENS');
    expect(MERI_GROUNDING_INVARIANT).toContain('[S:tool_name:record_id]');
    expect(MERI_GROUNDING_INVARIANT).toContain('AUTHORIZATION vs APPROPRIATION');
    expect(MERI_GROUNDING_INVARIANT).toContain('PROGRAM ELEMENTS vs PROCUREMENT LINE ITEMS');
    expect(MERI_GROUNDING_INVARIANT).toContain('NUMERIC INTEGRITY');
    expect(MERI_GROUNDING_INVARIANT).toContain('UNCERTAINTY LADDER');
    expect(MERI_GROUNDING_INVARIANT).toContain('ADVICE GATE');
    expect(MERI_GROUNDING_INVARIANT).toContain('BEFORE SENDING');
  });
  it('carries no unresolved template variable (date lives only in the date block)', () => {
    expect(MERI_GROUNDING_INVARIANT).not.toContain('{{CURRENT_DATE}}');
  });
});

describe('MERI_GROUNDING_OUTREACH_KERNEL (token-free subset)', () => {
  it('includes the accuracy blocks', () => {
    expect(MERI_GROUNDING_OUTREACH_KERNEL).toContain('CLOSED-WORLD RULE');
    expect(MERI_GROUNDING_OUTREACH_KERNEL).toContain('AUTHORIZATION vs APPROPRIATION');
    expect(MERI_GROUNDING_OUTREACH_KERNEL).toContain('NUMERIC INTEGRITY');
    expect(MERI_GROUNDING_OUTREACH_KERNEL).toContain('ADVICE GATE');
  });
  it('EXCLUDES the inline-citation and self-check blocks (an email body carries no tokens)', () => {
    expect(MERI_GROUNDING_OUTREACH_KERNEL).not.toContain('CITATION TOKENS');
    expect(MERI_GROUNDING_OUTREACH_KERNEL).not.toContain('BEFORE SENDING');
    expect(MERI_GROUNDING_OUTREACH_KERNEL).not.toContain('<meri_grounding');
  });
});

describe('meriGroundingSurfaceBlock + meriGroundingDateBlock', () => {
  it('returns the matching surface block', () => {
    expect(meriGroundingSurfaceBlock('chat')).toContain('CHAT SURFACE');
    expect(meriGroundingSurfaceBlock('research')).toContain('DEEP RESEARCH SURFACE');
    expect(meriGroundingSurfaceBlock('outreach')).toContain('OUTREACH SURFACE');
    expect(meriGroundingSurfaceBlock('memo')).toContain('MEMO / BRIEFING / DELIVERABLE SURFACE');
  });
  it('renders the date and closes the meri_grounding element', () => {
    const block = meriGroundingDateBlock('2026-07-12T10:00:00Z');
    expect(block).toContain("Today's date is 2026-07-12.");
    expect(block.trimEnd().endsWith('</meri_grounding>')).toBe(true);
    // accepts a bare date too
    expect(meriGroundingDateBlock('2026-01-05')).toContain("Today's date is 2026-01-05.");
  });
});

describe('validateFormBCitations (§2.1 substring check, LLM-free)', () => {
  const results = {
    get_pe_budget_timeline: '{"peCode":"0603851F","request":72.1}',
    get_bill_status: '{"billId":"hr-8800-119","status":"rule_failed"}',
  };
  it('keeps a token whose tool was called AND whose record_id is verbatim in the result', () => {
    const text = 'FY27 request is $72.1M [S:get_pe_budget_timeline:0603851F].';
    const r = validateFormBCitations(text, results);
    expect(r.valid).toEqual(['[S:get_pe_budget_timeline:0603851F]']);
    expect(r.invalid).toEqual([]);
    expect(r.sanitizedText).toBe(text);
  });
  it('strips a token whose tool was NOT called this turn', () => {
    const text = 'Per representation [S:get_representation:AL-05].';
    const r = validateFormBCitations(text, results);
    expect(r.invalid).toEqual(['[S:get_representation:AL-05]']);
    expect(r.sanitizedText).toBe('Per representation .');
  });
  it('strips a token whose record_id is not a verbatim substring of the result', () => {
    const text = 'Reported [S:get_bill_status:hr-9999-119].';
    const r = validateFormBCitations(text, results);
    expect(r.invalid).toEqual(['[S:get_bill_status:hr-9999-119]']);
    expect(r.sanitizedText).not.toContain('[S:');
  });
  it('handles empty text and preserves valid while stripping invalid in mixed text', () => {
    expect(validateFormBCitations('', results).tokens).toEqual([]);
    const mixed = 'A [S:get_pe_budget_timeline:0603851F] and B [S:get_bill_status:hr-0000-000].';
    const r = validateFormBCitations(mixed, results);
    expect(r.valid).toEqual(['[S:get_pe_budget_timeline:0603851F]']);
    expect(r.invalid).toEqual(['[S:get_bill_status:hr-0000-000]']);
    expect(r.sanitizedText).toContain('[S:get_pe_budget_timeline:0603851F]');
    expect(r.sanitizedText).not.toContain('hr-0000-000');
  });
});

describe('meriCapabilityBlock (self-description correctness)', () => {
  it('states persistent memory, document generation, and table formatting', () => {
    const block = meriCapabilityBlock().toLowerCase();
    expect(block).toContain('persistent memory');
    expect(block).toContain('.docx');
    expect(block).toContain('.xlsx');
    expect(block).toContain('.pptx');
    expect(block).toContain('table');
  });
  it('affirms it IS a conversational AI (regression: must not deny chatting)', () => {
    const block = meriCapabilityBlock().toLowerCase();
    expect(block).toContain('conversational ai');
    expect(block).toContain('the answer is yes');
  });
  it('forbids the "just a chatbot / no memory" framing and warns against overstating', () => {
    const block = meriCapabilityBlock();
    expect(block).toContain('never claim you are "just a chatbot"');
    expect(block.toLowerCase()).toContain('only claim a capability you actually have');
  });
  it('advertises firm operational data + approval-gated task writes', () => {
    const block = meriCapabilityBlock().toLowerCase();
    expect(block).toContain("firm's own work");
    expect(block).toContain('needs-attention');
    expect(block).toContain('tracked bills');
    expect(block).toContain('regulatory dockets');
    expect(block).toContain('sam.gov');
    expect(block).toContain('client profiles');
    expect(block).toContain('debrief');
    expect(block).toContain('outreach');
    expect(block).toContain("with the user's approval");
  });
  it('joins the capability lines verbatim', () => {
    expect(meriCapabilityBlock()).toBe(CLIO_CAPABILITY_LINES.join('\n'));
  });
});

describe('buildMeriSystemBlocks', () => {
  it('puts a single cache breakpoint on the static base block when caching is enabled', () => {
    const blocks = buildMeriSystemBlocks({
      base: 'BASE PROMPT',
      dynamic: 'ctx',
      cacheEnabled: true,
    });
    expect(blocks).toEqual([
      { type: 'text', text: 'BASE PROMPT', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'ctx' },
    ]);
    // The dynamic block must never carry a breakpoint (it varies per turn).
    expect(blocks[1]!.cache_control).toBeUndefined();
  });

  it('omits all cache_control when caching is disabled', () => {
    const blocks = buildMeriSystemBlocks({ base: 'BASE', dynamic: 'ctx', cacheEnabled: false });
    expect(blocks.every((b) => b.cache_control === undefined)).toBe(true);
  });

  it('emits only the base block when the dynamic tail is empty or whitespace', () => {
    expect(buildMeriSystemBlocks({ base: 'BASE', dynamic: '', cacheEnabled: true })).toHaveLength(
      1,
    );
    expect(
      buildMeriSystemBlocks({ base: 'BASE', dynamic: '   \n ', cacheEnabled: true }),
    ).toHaveLength(1);
    expect(buildMeriSystemBlocks({ base: 'BASE', cacheEnabled: true })).toHaveLength(1);
  });

  it('preserves base text byte-for-byte so the cached prefix is stable across turns', () => {
    const base = 'You are Meri.\n- rule one\n- rule two';
    const a = buildMeriSystemBlocks({ base, dynamic: 'turn-1 context', cacheEnabled: true });
    const b = buildMeriSystemBlocks({
      base,
      dynamic: 'turn-2 different context',
      cacheEnabled: true,
    });
    expect(a[0]).toEqual(b[0]); // identical cached base block => cache hit
  });

  it('does not attach a breakpoint to an empty base', () => {
    const blocks = buildMeriSystemBlocks({ base: '', dynamic: 'ctx', cacheEnabled: true });
    expect(blocks[0]!.cache_control).toBeUndefined();
  });
});

describe('applyToolCacheControl', () => {
  const tools = [
    { name: 'a', description: 'A', input_schema: {} },
    { name: 'b', description: 'B', input_schema: {} },
    { name: 'c', description: 'C', input_schema: {} },
  ];

  it('marks only the last tool when caching is enabled', () => {
    const out = applyToolCacheControl(tools, true);
    expect(out[0]!.cache_control).toBeUndefined();
    expect(out[1]!.cache_control).toBeUndefined();
    expect(out[2]!.cache_control).toEqual({ type: 'ephemeral' });
  });

  it('marks no tool when caching is disabled', () => {
    const out = applyToolCacheControl(tools, false);
    expect(out.every((t) => (t as { cache_control?: unknown }).cache_control === undefined)).toBe(
      true,
    );
  });

  it('never mutates the input array or its elements', () => {
    const input = [{ name: 'x', description: 'X', input_schema: {} }];
    const out = applyToolCacheControl(input, true);
    expect(out[0]).not.toBe(input[0]); // shallow clone
    expect((input[0] as { cache_control?: unknown }).cache_control).toBeUndefined();
  });

  it('handles an empty tool list', () => {
    expect(applyToolCacheControl([], true)).toEqual([]);
  });
});

describe('readUsageFromStreamEvent', () => {
  it('reads all four counts from message_start', () => {
    const evt = {
      type: 'message_start',
      message: {
        usage: {
          input_tokens: 1200,
          output_tokens: 1,
          cache_read_input_tokens: 800,
          cache_creation_input_tokens: 400,
        },
      },
    };
    expect(readUsageFromStreamEvent(evt)).toEqual({
      inputTokens: 1200,
      outputTokens: 1,
      cacheReadInputTokens: 800,
      cacheCreationInputTokens: 400,
    });
  });

  it('defaults missing cache fields on message_start to 0', () => {
    const evt = { type: 'message_start', message: { usage: { input_tokens: 50 } } };
    expect(readUsageFromStreamEvent(evt)).toEqual({
      inputTokens: 50,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    });
  });

  it('reads only output_tokens from message_delta', () => {
    expect(
      readUsageFromStreamEvent({ type: 'message_delta', usage: { output_tokens: 321 } }),
    ).toEqual({
      outputTokens: 321,
    });
  });

  it('returns null for events without usage and for garbage', () => {
    expect(
      readUsageFromStreamEvent({ type: 'content_block_delta', delta: { text: 'hi' } }),
    ).toBeNull();
    expect(readUsageFromStreamEvent({ type: 'message_delta' })).toBeNull();
    expect(readUsageFromStreamEvent({ type: 'message_start', message: {} })).toBeNull();
    expect(readUsageFromStreamEvent(null)).toBeNull();
    expect(readUsageFromStreamEvent('nope')).toBeNull();
  });
});

describe('addUsage', () => {
  it('folds a delta into the accumulator, treating missing fields as 0', () => {
    const acc = emptyUsage();
    addUsage(acc, { inputTokens: 10, cacheReadInputTokens: 5 });
    addUsage(acc, { outputTokens: 7, cacheCreationInputTokens: 3 });
    expect(acc).toEqual({
      inputTokens: 10,
      outputTokens: 7,
      cacheReadInputTokens: 5,
      cacheCreationInputTokens: 3,
    });
  });
});

describe('applyRoundUsageEvent', () => {
  it('accumulates a realistic round: message_start then several message_delta', () => {
    const round = emptyUsage();
    applyRoundUsageEvent(round, {
      type: 'message_start',
      message: {
        usage: {
          input_tokens: 30,
          output_tokens: 1,
          cache_read_input_tokens: 1500,
          cache_creation_input_tokens: 0,
        },
      },
    });
    applyRoundUsageEvent(round, { type: 'message_delta', usage: { output_tokens: 40 } });
    applyRoundUsageEvent(round, { type: 'message_delta', usage: { output_tokens: 95 } });
    // input/cache from message_start are retained; output is the latest cumulative delta.
    expect(round).toEqual({
      inputTokens: 30,
      outputTokens: 95,
      cacheReadInputTokens: 1500,
      cacheCreationInputTokens: 0,
    });
  });

  it('ignores events with no usage', () => {
    const round = emptyUsage();
    applyRoundUsageEvent(round, { type: 'ping' });
    applyRoundUsageEvent(round, { type: 'content_block_start', index: 0 });
    expect(round).toEqual(emptyUsage());
  });
});
