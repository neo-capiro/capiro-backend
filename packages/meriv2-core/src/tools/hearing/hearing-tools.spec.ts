import {
  AnthropicLlmClient,
  OpenAiLlmClient,
  parseJsonObject,
  extractAnthropicText,
} from '../../llm/llm-client';
import { createTagLivePolicyMentionsTool } from './tag-live-policy-mentions';
import {
  createGeneratePostHearingSummaryTool,
  groupEvidenceTurns,
} from './generate-post-hearing-summary';
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
    // Source selection precedes authored prose in the outbound claim schema.
    expect(
      Object.keys(body.tools[0].input_schema.properties.claims.items.anyOf[0].properties),
    ).toEqual(['id', 'kind', 'evidenceIds', 'text']);
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

  it.each([
    ['hearing_recap', /hearing_recap/, /material developments/],
    ['live_update', /live_update/, /one or two concise claims/],
  ] as const)(
    'passes a grouped system prompt and %s payload instructions without mutating the evidence',
    async (publicationKind, kindPattern, focusPattern) => {
      let seen: { system?: string; prompt?: string; toolDescription?: string } = {};
      const llm: LlmClient = {
        completeJson: async () => {
          throw Error('Evidence requests must use the schema contract');
        },
        completeWithSchema: async (args) => {
          seen = {
            system: args.system,
            prompt: args.prompt,
            toolDescription: args.toolDescription,
          };
          return {
            input: { claims: [{ id: 'claim-1', kind: 'quote', evidenceIds: ['final-1'] }] },
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        },
      };
      const evidence = [
        {
          segmentId: 'final-1',
          text: 'This is an owned test.',
          startMs: 0,
          endMs: 2000,
          speakerLabel: '0',
        },
      ];
      const result = await createGeneratePostHearingSummaryTool(llm).handler(
        { ...input, evidence, publicationKind },
        ctx,
      );
      // The handler's own system prompt carries the source-first contract.
      expect(seen.system).toMatch(/SOURCE-FIRST WORKFLOW/);
      expect(seen.system).toMatch(/GROUND RULES/);
      expect(seen.system).toMatch(/never verified identities/);
      expect(seen.system).toMatch(/supplied transcript evidence only/);
      expect(seen.system).toMatch(/own cited segments/);
      expect(seen.system).toMatch(/never complete or extend/);
      expect(seen.system).toMatch(/rendered as Speaker N/);
      expect(seen.system).toMatch(/must not be assigned to the segment's speaker/);
      expect(seen.system).not.toMatch(/the witness" as fits/);
      // The misleading verified-name branch is gone: this path cannot verify one.
      expect(seen.system).not.toMatch(/metadata does verify a name/);
      expect(seen.system).toMatch(kindPattern);
      // The payload encodes the publication kind, its narrow instruction and the evidence.
      const payload = JSON.parse(seen.prompt ?? '{}');
      expect(payload.kind).toBe(publicationKind);
      expect(payload.instructions).toMatch(kindPattern);
      expect(payload.instructions).toMatch(focusPattern);
      // The payload states the attribution contract explicitly, next to the evidence.
      expect(payload.speakerAttribution).toMatch(/diarization labels, not verified identities/);
      expect(payload.speakerAttribution).toMatch(/exact supplied speakerId/);
      expect(payload.speakerAttribution).toMatch(/must not be assigned to the segment's speaker/);
      // Raw source fields pass through unchanged inside contiguous same-label
      // turns; speakerId is only an added rendering of the supplied label,
      // never a resolved name. Every original full ID stays addressable.
      expect(payload.evidenceTurns).toEqual([
        { speakerId: 'Speaker 0', segments: [{ ...evidence[0], speakerId: 'Speaker 0' }] },
      ]);
      expect(seen.toolDescription).toMatch(focusPattern);
      // Source evidence is passed through unchanged, not rewritten by the handler.
      expect(evidence[0]!.text).toBe('This is an owned test.');
      expect(result.claims).toEqual([
        { id: 'claim-1', kind: 'quote', text: 'This is an owned test.', evidenceIds: ['final-1'] },
      ]);
    },
  );

  it('materializes a kind=quote claim as the exact persisted segment text for the selected ID, leaving the input evidence unchanged', async () => {
    // The provider only selects a segment ID for a quote; the handler copies the
    // persisted transcript text verbatim and never trusts authored quote text.
    const evidence = [
      {
        segmentId: 'final-1',
        text: 'Juan Sebastian Guerrero or Lorenzo Salgado Arajo or any of the 23 shootings involving ICER CBP?',
        startMs: 37690,
        endMs: 44230,
        speakerLabel: '0',
      },
      {
        segmentId: 'final-2',
        text: "I'll have to get back to you on those because, again, I'd have to go talk to my DHS boss. I know some of these",
        startMs: 44230,
        endMs: 49080,
        speakerLabel: '1',
      },
    ];
    const snapshot = evidence.map((e) => ({ ...e }));
    const llm: LlmClient = {
      completeJson: async () => {
        throw Error('Evidence requests must use the schema contract');
      },
      completeWithSchema: async () => ({
        input: {
          claims: [
            // The quote selection carries no authored text, per the tool contract.
            { id: 'claim-1', kind: 'quote', evidenceIds: ['final-1'] },
          ],
        },
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    };
    const result = await createGeneratePostHearingSummaryTool(llm).handler(
      { ...input, evidence },
      ctx,
    );
    // The returned text is the persisted segment bytes exactly, not a paraphrase.
    expect(result.claims).toEqual([
      {
        id: 'claim-1',
        kind: 'quote',
        text: 'Juan Sebastian Guerrero or Lorenzo Salgado Arajo or any of the 23 shootings involving ICER CBP?',
        evidenceIds: ['final-1'],
      },
    ]);
    expect(evidence).toEqual(snapshot);
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

describe('groupEvidenceTurns (H57 prompt organization only)', () => {
  const seg = (segmentId: string, speakerLabel: string | null | undefined, text = segmentId) => ({
    segmentId,
    text,
    startMs: 1,
    endMs: 2,
    speakerLabel,
  });

  it('flattens losslessly: same segments, text, timing and order as the input', () => {
    const evidence = [
      seg('a', '0'),
      seg('b', '0'),
      seg('c', '1'),
      seg('d', '0'),
      seg('e', null),
      seg('f', undefined),
      seg('g', '1'),
    ];
    const turns = groupEvidenceTurns(evidence);
    expect(turns.flatMap((t) => t.segments)).toEqual(evidence);
    // The flattened objects are the SAME references — no copy/rewrite.
    turns.flatMap((t) => t.segments).forEach((s, i) => expect(s).toBe(evidence[i]));
  });

  it('0→1→0 produces three turns; nonadjacent identical labels are never merged', () => {
    const turns = groupEvidenceTurns([seg('a', '0'), seg('b', '1'), seg('c', '0')]);
    expect(turns.map((t) => t.displayLabel)).toEqual(['Speaker 0', 'Speaker 1', 'Speaker 0']);
    expect(turns.map((t) => t.segments.map((s) => s.segmentId))).toEqual([['a'], ['b'], ['c']]);
  });

  it('null/undefined labels stay truthfully unknown and split turns like any label change', () => {
    const turns = groupEvidenceTurns([
      seg('a', null),
      seg('b', null),
      seg('c', '1'),
      seg('d', null),
    ]);
    expect(turns.map((t) => t.displayLabel)).toEqual([null, 'Speaker 1', null]);
    expect(turns[0]!.segments.map((s) => s.segmentId)).toEqual(['a', 'b']);
  });

  it('runs of the same label group into ONE turn preserving order/timing', () => {
    const evidence = [
      { segmentId: 'a', text: 'first', startMs: 0, endMs: 100, speakerLabel: '3' },
      { segmentId: 'b', text: 'second', startMs: 100, endMs: 200, speakerLabel: '3' },
    ];
    const turns = groupEvidenceTurns(evidence);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.displayLabel).toBe('Speaker 3');
    expect(turns[0]!.segments).toEqual(evidence);
  });
});

describe('evidence hearing strict wire (H57 mocked-fetch)', () => {
  const input = {
    sessionId: 'owned',
    title: 'Owned hearing fixture',
    quotes: [],
    mentions: [],
    actionItems: [],
    evidence: [
      {
        segmentId: '9caffd75-aaaa-bbbb-cccc-ddddeeeeffff',
        text: 'We review case by case.',
        startMs: 0,
        endMs: 2000,
        speakerLabel: '1',
      },
      {
        segmentId: '8cf6f8e9-aaaa-bbbb-cccc-ddddeeeeffff',
        text: 'There is no blanket rule.',
        startMs: 2000,
        endMs: 4000,
        speakerLabel: '1',
      },
    ],
  };
  const okClaims = {
    claims: [
      {
        id: 'claim-1',
        kind: 'observation',
        text: 'Reviews are case by case with no blanket rule.',
        evidenceIds: [input.evidence[0]!.segmentId, input.evidence[1]!.segmentId],
      },
    ],
  };
  function mockAnthropic(captured: { body?: Record<string, unknown> }) {
    return jest.fn(async (_url: string, init?: RequestInit) => {
      captured.body = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          content: [
            { type: 'thinking', thinking: 'hidden', signature: 'sig' },
            { type: 'tool_use', id: 't1', name: 'submit_hearing_claims', input: okClaims },
          ],
          usage: { input_tokens: 100, output_tokens: 200 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;
  }
  const quoteBranch = (schema: any) => schema.properties.claims.items.anyOf[1];
  const obsBranch = (schema: any) => schema.properties.claims.items.anyOf[0];

  it('opted-in qualified Sonnet 4.5: strict:true + projected schema, thinking1024/auto, unchanged 6000/model, full UUID enum, original schema intact', async () => {
    const captured: { body?: Record<string, unknown> } = {};
    const llm = new AnthropicLlmClient({
      apiKey: 'sk-test',
      model: 'claude-sonnet-4-5',
      fetchImpl: mockAnthropic(captured),
    });
    const result = await createGeneratePostHearingSummaryTool(llm).handler(input, ctx);
    expect(result.claims).toEqual(okClaims.claims);
    const body = captured.body!;
    const tool = (body.tools as any[])[0];
    expect(tool.strict).toBe(true);
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 1024 });
    expect(body.tool_choice).toEqual({ type: 'auto' });
    expect(body.max_tokens).toBe(6000);
    expect(body.model).toBe('claude-sonnet-4-5');
    const schema = tool.input_schema;
    // Unsupported keywords removed from the projected wire schema...
    const wireText = JSON.stringify(schema);
    expect(wireText).not.toContain('"minLength"');
    expect(wireText).not.toContain('"maxLength"');
    expect(wireText).not.toContain('"maxItems"');
    // ...while the supported subset is preserved: minItems, enums (full UUIDs),
    // additionalProperties, anyOf branches, required/property ordering.
    expect(schema.properties.claims.minItems).toBe(1);
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(['claims']);
    expect(Object.keys(obsBranch(schema).properties)).toEqual([
      'id',
      'kind',
      'evidenceIds',
      'text',
    ]);
    expect(obsBranch(schema).required).toEqual(['id', 'kind', 'evidenceIds', 'text']);
    expect(obsBranch(schema).additionalProperties).toBe(false);
    expect(quoteBranch(schema).required).toEqual(['id', 'kind', 'evidenceIds']);
    expect(obsBranch(schema).properties.evidenceIds.items.enum).toEqual([
      input.evidence[0]!.segmentId,
      input.evidence[1]!.segmentId,
    ]);
    expect(quoteBranch(schema).properties.evidenceIds.items.enum).toEqual([
      input.evidence[0]!.segmentId,
      input.evidence[1]!.segmentId,
    ]);
    expect(obsBranch(schema).properties.evidenceIds.minItems).toBe(1);
    expect(quoteBranch(schema).properties.evidenceIds.minItems).toBe(1);
    // The dropped limits survive in the property descriptions.
    expect(obsBranch(schema).properties.text.description).toMatch(/at most 2500 characters/);
    expect(obsBranch(schema).properties.id.description).toMatch(/at most 100 characters/);
    expect(quoteBranch(schema).properties.evidenceIds.description).toMatch(/EXACTLY ONE/);
    expect(schema.properties.claims.description).toMatch(/1 to 40 claims/);
    // The handler's own schema object was NOT mutated by the projection.
    const seen: Record<string, unknown> = {};
    const llmSpy: LlmClient = {
      completeJson: async () => {
        throw Error('unused');
      },
      completeWithSchema: async (args) => {
        seen.inputSchema = args.inputSchema;
        return { input: okClaims, usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    await createGeneratePostHearingSummaryTool(llmSpy).handler(input, ctx);
    const originalText = JSON.stringify(seen.inputSchema);
    expect(originalText).toContain('"maxItems":1');
    expect(originalText).toContain('"maxItems":20');
    expect(originalText).toContain('"maxItems":40');
    expect(originalText).toContain('"minLength":1');
    expect(originalText).toContain('"maxLength":2500');
    expect(originalText).toContain('"maxLength":100');
  });

  it('opted-in pinned revision also applies strict', async () => {
    const captured: { body?: Record<string, unknown> } = {};
    const llm = new AnthropicLlmClient({
      apiKey: 'sk-test',
      model: 'claude-sonnet-4-5-20250929',
      fetchImpl: mockAnthropic(captured),
    });
    await createGeneratePostHearingSummaryTool(llm).handler(input, ctx);
    expect((captured.body!.tools as any[])[0].strict).toBe(true);
    expect(JSON.stringify((captured.body!.tools as any[])[0].input_schema)).not.toContain(
      '"maxItems"',
    );
  });

  it('unsupported model opt-in keeps the prior wire: no strict field, original keywords/schema values, forced-tool choice only because reasoning is also ignored', async () => {
    const captured: { body?: Record<string, unknown> } = {};
    const llm = new AnthropicLlmClient({
      apiKey: 'sk-test',
      model: 'claude-opus-4-8',
      fetchImpl: mockAnthropic(captured),
    });
    await createGeneratePostHearingSummaryTool(llm).handler(input, ctx);
    const body = captured.body!;
    const tool = (body.tools as any[])[0];
    expect(tool.strict).toBeUndefined();
    expect(body.thinking).toBeUndefined();
    expect(body.tool_choice).toEqual({ type: 'tool', name: 'submit_hearing_claims' });
    expect(body.max_tokens).toBe(6000);
    expect(body.model).toBe('claude-opus-4-8');
    const schema = tool.input_schema;
    // Exact original raw schema values/order reach the wire unchanged.
    expect(schema.properties.claims.maxItems).toBe(40);
    expect(obsBranch(schema).properties.id.minLength).toBe(1);
    expect(obsBranch(schema).properties.id.maxLength).toBe(100);
    expect(obsBranch(schema).properties.text.minLength).toBe(1);
    expect(obsBranch(schema).properties.text.maxLength).toBe(2500);
    expect(obsBranch(schema).properties.evidenceIds.maxItems).toBe(20);
    expect(quoteBranch(schema).properties.evidenceIds.maxItems).toBe(1);
    expect(Object.keys(obsBranch(schema).properties)).toEqual([
      'id',
      'kind',
      'evidenceIds',
      'text',
    ]);
    expect(obsBranch(schema).properties.evidenceIds.items.enum).toEqual([
      input.evidence[0]!.segmentId,
      input.evidence[1]!.segmentId,
    ]);
  });

  it('the wire prompt groups the same evidence into one turn and keeps every full ID addressable', async () => {
    const captured: { body?: Record<string, unknown> } = {};
    const llm = new AnthropicLlmClient({
      apiKey: 'sk-test',
      model: 'claude-sonnet-4-5',
      fetchImpl: mockAnthropic(captured),
    });
    await createGeneratePostHearingSummaryTool(llm).handler(input, ctx);
    const messages = captured.body!.messages as Array<{ content: string }>;
    const payload = JSON.parse(messages[0]!.content);
    expect(payload.evidenceTurns).toHaveLength(1);
    expect(payload.evidenceTurns[0].speakerId).toBe('Speaker 1');
    expect(payload.evidenceTurns[0].segments.map((s: any) => s.segmentId)).toEqual([
      input.evidence[0]!.segmentId,
      input.evidence[1]!.segmentId,
    ]);
    expect(payload.evidenceTurns[0].segments[0].text).toBe('We review case by case.');
    expect(payload.evidenceTurns[0].segments[0].startMs).toBe(0);
    expect(payload.evidenceTurns[0].segments[0].endMs).toBe(2000);
  });

  it('unsupported provider (OpenAI) opt-in is not sent: no strict, original schema keywords, same key/model', async () => {
    let body: Record<string, unknown> = {};
    const fetchImpl = (async (_u: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return {
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                tool_calls: [
                  {
                    function: {
                      name: 'submit_hearing_claims',
                      arguments: JSON.stringify(okClaims),
                    },
                  },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
      } as Response;
    }) as typeof fetch;
    const llm = new OpenAiLlmClient({ apiKey: 'sk-test', model: 'gpt-5', fetchImpl });
    const result = await createGeneratePostHearingSummaryTool(llm).handler(input, ctx);
    expect(result.claims).toEqual(okClaims.claims);
    const fn = (body.tools as any[])[0].function;
    expect(fn.strict).toBeUndefined();
    expect((body.tools as any[])[0].strict).toBeUndefined();
    expect(body.model).toBe('gpt-5');
    const schema = fn.parameters;
    expect(schema.properties.claims.maxItems).toBe(40);
    expect(obsBranch(schema).properties.text.maxLength).toBe(2500);
    expect(quoteBranch(schema).properties.evidenceIds.maxItems).toBe(1);
    expect(obsBranch(schema).properties.evidenceIds.items.enum).toEqual([
      input.evidence[0]!.segmentId,
      input.evidence[1]!.segmentId,
    ]);
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
    // No evidence supplied on this path: the schema branch must stay unused.
    completeWithSchema: async () => {
      throw new Error('completeWithSchema requires evidence input');
    },
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
