import { z } from 'zod';
import type { MeriContext, ToolDefinition } from '../../registry/types';
import type { LlmClient } from '../../llm/llm-client';

/**
 * `tag_live_policy_mentions` — extract structured lobbying intelligence from ONE
 * finalized hearing transcript segment. Called by intel-api's live extraction
 * dispatcher for each final segment. Deepgram does STT; THIS does the policy
 * reasoning (entities, stance, client relevance, quote, action item, card).
 *
 * Read-only: it derives data from the supplied segment text; it does not mutate.
 */
export interface TagLivePolicyMentionsInput {
  sessionId: string;
  segment: { startMs: number; endMs: number; text: string; speakerLabel?: string };
  context: {
    clientId?: string | null;
    issueIds: string[];
    billIds: string[];
    programElementIds: string[];
    committeeId?: string | null;
  };
}

export interface TagLivePolicyMentionsResult {
  entityMentions: Array<{
    entityType: string;
    entityRef?: string;
    entityLabel: string;
    confidence?: number;
  }>;
  keyQuote?: { text: string; confidence?: number; issueTags: string[] };
  actionItem?: { description: string };
  clientRelevanceScore?: number;
  issueTags: string[];
  resolvedSpeakerId?: string;
  resolvedSpeakerName?: string;
  summaryCard?: { cardType: string; title: string; body?: string };
}

export const tagLivePolicyMentionsInputSchema = z.object({
  sessionId: z.string().min(1),
  segment: z.object({
    startMs: z.number(),
    endMs: z.number(),
    text: z.string().min(1),
    speakerLabel: z.string().optional(),
  }),
  context: z.object({
    clientId: z.string().nullish(),
    issueIds: z.array(z.string()),
    billIds: z.array(z.string()),
    programElementIds: z.array(z.string()),
    committeeId: z.string().nullish(),
  }),
});

const SYSTEM =
  'You are a federal lobbying intelligence analyst. From ONE hearing transcript segment, extract ' +
  'structured intelligence as STRICT JSON only. Detect mentions of bills, agencies, programs, program ' +
  'elements (PE), companies, offices/members, and policy issues. Judge relevance to the client context. ' +
  'Do NOT fabricate entities not present in the text. If nothing notable, return empty arrays. Never ' +
  'output prose outside the JSON.';

const RESULT_SCHEMA = {
  entityMentions: [
    {
      entityType: 'bill|agency|program|program_element|company|office|member|issue',
      entityRef: 'optional id/symbol',
      entityLabel: 'string',
      confidence: '0..1',
    },
  ],
  keyQuote: '{ text, confidence, issueTags[] } or null if not quote-worthy',
  actionItem: '{ description } or null',
  clientRelevanceScore: '0..1',
  issueTags: ['string'],
  summaryCard:
    '{ cardType: client_mention|bill_mention|program_element|potential_ask|opposition|member_position|follow_up|appropriations_language|compliance_sensitive|quote, title, body } or null',
};

export function createTagLivePolicyMentionsTool(
  llm: LlmClient,
): ToolDefinition<TagLivePolicyMentionsInput, TagLivePolicyMentionsResult> {
  return {
    name: 'tag_live_policy_mentions',
    description:
      'Extract structured lobbying intelligence (entities, stance, client relevance, key quote, action ' +
      'item, summary card) from one finalized hearing transcript segment.',
    readOnly: true,
    inputSchema: tagLivePolicyMentionsInputSchema,
    handler: async (input, _ctx: MeriContext): Promise<TagLivePolicyMentionsResult> => {
      const prompt =
        `Client context: ${JSON.stringify(input.context)}\n\n` +
        `Segment (${input.segment.startMs}-${input.segment.endMs}ms` +
        `${input.segment.speakerLabel ? `, speaker ${input.segment.speakerLabel}` : ''}):\n` +
        `"${input.segment.text}"\n\n` +
        `Return JSON matching this shape:\n${JSON.stringify(RESULT_SCHEMA)}`;

      const parsed = await llm.completeJson({ system: SYSTEM, prompt, maxTokens: 1024 });
      return normalize(parsed);
    },
  };
}

function normalize(p: Record<string, unknown>): TagLivePolicyMentionsResult {
  const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
  const str = (v: unknown): string | undefined =>
    typeof v === 'string' && v.trim() ? v : undefined;
  const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);

  const entityMentions = arr(p.entityMentions)
    .map((m) => {
      const o = (m ?? {}) as Record<string, unknown>;
      const label = str(o.entityLabel);
      const type = str(o.entityType);
      if (!label || !type) return null;
      return {
        entityType: type,
        entityRef: str(o.entityRef),
        entityLabel: label,
        confidence: num(o.confidence),
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  const kq = (p.keyQuote ?? null) as Record<string, unknown> | null;
  const keyQuote =
    kq && str(kq.text)
      ? {
          text: String(kq.text),
          confidence: num(kq.confidence),
          issueTags: arr(kq.issueTags).map(String),
        }
      : undefined;

  const ai = (p.actionItem ?? null) as Record<string, unknown> | null;
  const actionItem =
    ai && str(ai.description) ? { description: String(ai.description) } : undefined;

  const sc = (p.summaryCard ?? null) as Record<string, unknown> | null;
  const summaryCard =
    sc && str(sc.cardType) && str(sc.title)
      ? { cardType: String(sc.cardType), title: String(sc.title), body: str(sc.body) }
      : undefined;

  return {
    entityMentions,
    keyQuote,
    actionItem,
    clientRelevanceScore: num(p.clientRelevanceScore),
    issueTags: arr(p.issueTags).map(String),
    resolvedSpeakerId: str(p.resolvedSpeakerId),
    resolvedSpeakerName: str(p.resolvedSpeakerName),
    summaryCard,
  };
}
