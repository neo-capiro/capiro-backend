import { AnthropicLlmClient, parseJsonObject, extractAnthropicText } from '../../llm/llm-client';
import { createTagLivePolicyMentionsTool } from './tag-live-policy-mentions';
import { createGeneratePostHearingSummaryTool } from './generate-post-hearing-summary';
import type { LlmClient } from '../../llm/llm-client';
import type { MeriContext } from '../../registry/types';

const ctx: MeriContext = {
  tenantId: 't1',
  userId: 'u1',
  clerkUserId: 'cu1',
  role: 'member' as never,
};

/** Legacy narrative requests retain their JSON contract. */
const completeWithSchema: LlmClient['completeWithSchema'] = async () => {
  throw new Error('completeWithSchema not used in this test');
};

describe('evidence hearing draft provider contract', () => {
  const input = {
    sessionId: 'owned',
    title: 'Owned hearing fixture',
    quotes: [],
    mentions: [],
    actionItems: [],
    evidence: [{ segmentId: 'final-1', text: 'This is an owned test.', startMs: 0, endMs: 2000 }],
  };
  const claims = [
    { id: 'claim-1', kind: 'quote', text: input.evidence[0]!.text, evidenceIds: ['final-1'] },
  ];
  it('requests a forced claim tool and reads its arguments when free text has no claims', async () => {
    const fetchImpl = jest.fn(
      async () =>
        new Response(
          JSON.stringify({
            content: [
              { type: 'text', text: '{"executiveSummary":"A test fixture."}' },
              {
                type: 'tool_use',
                name: 'submit_hearing_claims',
                input: { claims: claims.map(({ text, ...selection }) => selection) },
              },
            ],
            usage: { input_tokens: 20, output_tokens: 40 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    const llm = new AnthropicLlmClient({
      apiKey: 'owned-test-key',
      model: 'owned-test-model',
      fetchImpl,
    });
    const result = await createGeneratePostHearingSummaryTool(llm).handler(input, ctx);
    expect(result.claims).toEqual(claims);
    const body = JSON.parse(
      (fetchImpl.mock.calls as unknown as [[string, RequestInit]])[0][1].body as string,
    );
    expect(body.tool_choice).toEqual({ type: 'tool', name: 'submit_hearing_claims' });
    expect(body.tools[0].input_schema.required).toEqual(['claims']);
    expect(
      body.tools[0].input_schema.properties.claims.items.anyOf[0].properties.evidenceIds.items.enum,
    ).toEqual(['final-1']);
    expect(
      body.tools[0].input_schema.properties.claims.items.anyOf[1].properties.text,
    ).toBeUndefined();
  });
  it.each([
    {},
    { claims: [] },
    { claims: [{ id: 'unknown', kind: 'quote', evidenceIds: ['other-session'] }] },
    { claims: [{ ...claims[0], text: 'The bill passed.' }] },
    { claims: [1, 2].map(() => ({ id: 'duplicate', kind: 'quote', evidenceIds: ['final-1'] })) },
    { claims: [{ id: 'joined', kind: 'quote', evidenceIds: ['final-1', 'final-1'] }] },
  ])('rejects missing or unsupported structured claims: %j', async (response) => {
    const llm: LlmClient = {
      completeJson: async () => {
        throw Error('Evidence requests must use the schema contract');
      },
      completeWithSchema: async () => ({
        input: response,
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    };
    await expect(createGeneratePostHearingSummaryTool(llm).handler(input, ctx)).rejects.toThrow();
  });
});

describe('llm-client helpers', () => {
  it('parses JSON from a fenced code block', () => {
    expect(parseJsonObject('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });
  it('parses JSON embedded in prose', () => {
    expect(parseJsonObject('Here you go: {"x":"y"} thanks')).toEqual({ x: 'y' });
  });
  it('returns {} on garbage', () => {
    expect(parseJsonObject('not json at all')).toEqual({});
  });
  it('extracts Anthropic text blocks', () => {
    expect(extractAnthropicText({ content: [{ type: 'text', text: 'hello' }] })).toBe('hello');
  });
});

describe('tag_live_policy_mentions tool', () => {
  const fakeLlm: LlmClient = {
    completeJson: async () => ({
      entityMentions: [
        { entityType: 'bill', entityRef: 'HR1', entityLabel: 'H.R. 1', confidence: 0.9 },
      ],
      keyQuote: { text: 'We must fund this.', confidence: 0.8, issueTags: ['funding'] },
      clientRelevanceScore: 0.7,
      issueTags: ['funding'],
      summaryCard: { cardType: 'bill_mention', title: 'H.R. 1 discussed' },
    }),
    completeWithSchema,
  };

  it('normalizes the LLM output into a structured result', async () => {
    const tool = createTagLivePolicyMentionsTool(fakeLlm);
    const out = await tool.handler(
      {
        sessionId: 's1',
        segment: { startMs: 0, endMs: 1000, text: 'fund H.R. 1' },
        context: { issueIds: [], billIds: [], programElementIds: [] },
      },
      ctx,
    );
    expect(out.entityMentions).toHaveLength(1);
    expect(out.entityMentions[0]?.entityLabel).toBe('H.R. 1');
    expect(out.keyQuote?.text).toBe('We must fund this.');
    expect(out.summaryCard?.cardType).toBe('bill_mention');
    expect(tool.readOnly).toBe(true);
  });

  it('drops malformed entities (no label/type)', async () => {
    const badLlm: LlmClient = {
      completeJson: async () => ({ entityMentions: [{ foo: 'bar' }], issueTags: [] }),
      completeWithSchema,
    };
    const tool = createTagLivePolicyMentionsTool(badLlm);
    const out = await tool.handler(
      {
        sessionId: 's1',
        segment: { startMs: 0, endMs: 1, text: 'x' },
        context: { issueIds: [], billIds: [], programElementIds: [] },
      },
      ctx,
    );
    expect(out.entityMentions).toHaveLength(0);
  });
});

describe('generate_post_hearing_summary tool', () => {
  const fakeLlm: LlmClient = {
    completeJson: async () => ({
      executiveSummary: 'The committee debated autonomy funding.',
      tone: 'contentious',
      risks: ['Amendment may strip funding'],
      opportunities: ['Champion identified'],
      recommendedNextSteps: ['Send one-pager'],
      draftClientEmail: { subject: 'Recap', body: 'Hi, here is the recap.' },
    }),
    completeWithSchema,
  };

  it('produces the narrative brief sections', async () => {
    const tool = createGeneratePostHearingSummaryTool(fakeLlm);
    const out = await tool.handler(
      {
        sessionId: 's1',
        title: 'HASC Hearing',
        quotes: [{ text: 'fund it', timestampMs: 10 }],
        mentions: [],
        actionItems: [],
      },
      ctx,
    );
    expect(out.executiveSummary).toContain('autonomy');
    expect(out.risks).toHaveLength(1);
    expect(out.draftClientEmail.subject).toBe('Recap');
  });

  it('falls back to action items for next steps when LLM omits them', async () => {
    const llm: LlmClient = {
      completeJson: async () => ({ executiveSummary: 'x' }),
      completeWithSchema,
    };
    const tool = createGeneratePostHearingSummaryTool(llm);
    const out = await tool.handler(
      { sessionId: 's1', title: 'T', quotes: [], mentions: [], actionItems: ['follow up'] },
      ctx,
    );
    expect(out.recommendedNextSteps).toEqual(['follow up']);
  });

  it('reports clientContext "none" and no client block when no client is supplied', async () => {
    const prompts: string[] = [];
    const llm: LlmClient = {
      completeJson: async ({ prompt }) => {
        prompts.push(prompt);
        return { executiveSummary: 'x' };
      },
      completeWithSchema,
    };
    const tool = createGeneratePostHearingSummaryTool(llm);
    const out = await tool.handler(
      { sessionId: 's1', title: 'T', quotes: [], mentions: [], actionItems: [] },
      ctx,
    );
    expect(out.clientContext).toBe('none');
    expect(prompts[0]).not.toContain('Client:');
  });

  it('writes for the named client: relevance, matched priorities and implications reach the prompt', async () => {
    const prompts: string[] = [];
    const llm: LlmClient = {
      completeJson: async ({ prompt, system }) => {
        prompts.push(prompt);
        expect(system).toMatch(/write FOR that client/);
        return { executiveSummary: 'x' };
      },
      completeWithSchema,
    };
    const tool = createGeneratePostHearingSummaryTool(llm);
    const out = await tool.handler(
      {
        sessionId: 's1',
        title: 'HASC Hearing',
        quotes: [{ text: 'fund it', timestampMs: 10 }],
        mentions: [],
        actionItems: [],
        client: {
          clientId: 'c1',
          name: 'Anduril',
          relevance: {
            band: 'HIGH',
            whyItMatters: 'The autonomy line the client sells was debated directly.',
            matchedPriorities: [{ label: 'autonomous systems', kind: 'watchlist' }],
            implications: ['A funding cut would hit FY27 orders'],
          },
        },
      },
      ctx,
    );
    const prompt = prompts[0] ?? '';
    expect(prompt).toContain('Client: Anduril');
    expect(prompt).toContain('band HIGH');
    expect(prompt).toContain('autonomy line the client sells');
    expect(prompt).toContain('autonomous systems (watchlist)');
    expect(prompt).toContain('- A funding cut would hit FY27 orders');
    // The client block precedes the hearing so the model reads the lens first.
    expect(prompt.indexOf('Client: Anduril')).toBeLessThan(
      prompt.indexOf('Hearing: "HASC Hearing"'),
    );
    expect(out.clientContext).toBe('applied');
  });

  it('is honest when a client is named but nothing client-specific is available', async () => {
    const prompts: string[] = [];
    const llm: LlmClient = {
      completeJson: async ({ prompt }) => {
        prompts.push(prompt);
        return { executiveSummary: 'x' };
      },
      completeWithSchema,
    };
    const tool = createGeneratePostHearingSummaryTool(llm);
    const out = await tool.handler(
      {
        sessionId: 's1',
        title: 'T',
        quotes: [],
        mentions: [],
        actionItems: [],
        client: { clientId: 'c1', name: 'Anduril', relevance: null },
      },
      ctx,
    );
    expect(out.clientContext).toBe('unavailable');
    expect(prompts[0]).toContain('none on record for this hearing');
  });

  it('a NONE relevance band is an honest absence, not applied context — unless steering exists', async () => {
    const llm: LlmClient = {
      completeJson: async () => ({ executiveSummary: 'x' }),
      completeWithSchema,
    };
    const tool = createGeneratePostHearingSummaryTool(llm);
    const client = {
      clientId: 'c1',
      name: 'Anduril',
      relevance: {
        band: 'NONE' as const,
        whyItMatters: 'No match.',
        matchedPriorities: [],
        implications: [],
      },
    };
    const base = { sessionId: 's1', title: 'T', quotes: [], mentions: [], actionItems: [], client };
    expect((await tool.handler(base, ctx)).clientContext).toBe('unavailable');
    const steered: MeriContext = {
      ...ctx,
      clientSteering: { compass: 'Protect the autonomy line.' },
    };
    expect((await tool.handler(base, steered)).clientContext).toBe('applied');
  });
});
