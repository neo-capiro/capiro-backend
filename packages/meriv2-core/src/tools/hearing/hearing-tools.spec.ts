import { parseJsonObject, extractAnthropicText } from '../../llm/llm-client';
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

/** None of these hearing tools use schema-forced completion — a fake that throws if ever called. */
const completeWithSchema: LlmClient['completeWithSchema'] = async () => {
  throw new Error('completeWithSchema not used in this test');
};

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
});
