import { z } from 'zod';
import type { MeriContext, ToolDefinition } from '../../registry/types';
import type { LlmClient } from '../../llm/llm-client';

/**
 * `generate_post_hearing_summary` — synthesize the client-ready narrative for a
 * post-hearing brief from the session's extracted quotes/entities/action items.
 * Called by intel-api's HearingBriefService. Returns ONLY the narrative parts
 * (exec summary, tone, risks, opportunities, next steps, draft email); intel-api
 * owns the sourced claim map + quote list.
 *
 * When a `client` block is supplied the recap is written FOR that client: the
 * firm's stored relevance analysis (why it matters, matched priorities,
 * implications) is the grounding for risks/opportunities, and the orchestrator's
 * compiled client steering (`ctx.clientSteering`) shapes voice and emphasis.
 * Without it the recap is client-agnostic — the pre-2026-09 behaviour.
 */
export type PostHearingClientRelevanceBand =
  | 'HIGH'
  | 'MEDIUM'
  | 'LOW'
  | 'NONE'
  | 'INSUFFICIENT_EVIDENCE';

export interface PostHearingClientContextInput {
  clientId: string;
  name: string | null;
  /** apps/api's stored relevance for this hearing × client; null when none is on record. */
  relevance: {
    band: PostHearingClientRelevanceBand;
    whyItMatters: string;
    matchedPriorities: Array<{ label: string; kind: string | null }>;
    implications: string[];
  } | null;
}

export interface GeneratePostHearingSummaryInput {
  sessionId: string;
  title: string;
  quotes: Array<{ text: string; speakerName?: string; timestampMs: number }>;
  mentions: Array<{ type: string; label: string; ref: string | null }>;
  actionItems: string[];
  client?: PostHearingClientContextInput;
}

/**
 * Whether the recap was actually shaped by client context:
 *  - `applied`      a client was named AND real material was available (matched
 *                   relevance and/or compiled client steering)
 *  - `unavailable`  a client was named but nothing client-specific could be
 *                   loaded (no relevance on record, steering empty or walled)
 *  - `none`         no client was requested — a generic recap
 * Surfaced so the UI can label a recap honestly instead of implying the client's
 * priorities were considered when they were not.
 */
export type PostHearingClientContextStatus = 'applied' | 'unavailable' | 'none';

export interface GeneratePostHearingSummaryResult {
  executiveSummary: string;
  tone: string;
  risks: string[];
  opportunities: string[];
  recommendedNextSteps: string[];
  draftClientEmail: { subject: string; body: string };
  clientContext: PostHearingClientContextStatus;
}

const relevanceBandSchema = z.enum(['HIGH', 'MEDIUM', 'LOW', 'NONE', 'INSUFFICIENT_EVIDENCE']);

export const generatePostHearingSummaryInputSchema = z.object({
  sessionId: z.string().min(1),
  title: z.string().min(1),
  quotes: z.array(
    z.object({ text: z.string(), speakerName: z.string().optional(), timestampMs: z.number() }),
  ),
  mentions: z.array(z.object({ type: z.string(), label: z.string(), ref: z.string().nullable() })),
  actionItems: z.array(z.string()),
  client: z
    .object({
      clientId: z.string().min(1),
      name: z.string().nullable(),
      relevance: z
        .object({
          band: relevanceBandSchema,
          whyItMatters: z.string(),
          matchedPriorities: z.array(z.object({ label: z.string(), kind: z.string().nullable() })),
          implications: z.array(z.string()),
        })
        .nullable(),
    })
    .optional(),
});

const SYSTEM =
  'You are a senior federal government-affairs strategist writing a client-ready hearing recap. Produce STRICT ' +
  'JSON only. Ground every statement in the supplied quotes/entities — do NOT invent facts, members, or positions ' +
  'not present. When a client is named, write FOR that client: tie every risk and opportunity to the client ' +
  'priorities, positions and relevance analysis supplied, and never invent a client position. If the supplied ' +
  'relevance says the hearing has little or no bearing on the client, say so plainly in the executive summary and ' +
  'keep risks/opportunities to what the evidence supports — do not manufacture stakes. The executive summary is ' +
  '2-4 sentences. The draft email is concise and professional, addressed to the client. Output JSON only, no prose.';

const RESULT_SCHEMA = {
  executiveSummary: 'string (2-4 sentences)',
  tone: 'string (overall tone of the hearing)',
  risks: ['string'],
  opportunities: ['string'],
  recommendedNextSteps: ['string'],
  draftClientEmail: { subject: 'string', body: 'string' },
};

/** Bands that carry a real, matched signal — NONE/INSUFFICIENT are honest absences. */
const MATCHED_BANDS = new Set<PostHearingClientRelevanceBand>(['HIGH', 'MEDIUM', 'LOW']);

export function classifyClientContext(
  client: PostHearingClientContextInput | undefined,
  ctx: MeriContext,
): PostHearingClientContextStatus {
  if (!client) return 'none';
  const relevanceMatched = Boolean(client.relevance && MATCHED_BANDS.has(client.relevance.band));
  const steering = ctx.clientSteering;
  const steeringPresent = Boolean(steering?.soul || steering?.compass || steering?.people);
  return relevanceMatched || steeringPresent ? 'applied' : 'unavailable';
}

function clientBlock(client: PostHearingClientContextInput, ctx: MeriContext): string {
  const lines: string[] = [`Client: ${client.name ?? client.clientId}`];
  const rel = client.relevance;
  if (rel) {
    lines.push(
      `Relevance to this client, from the firm's stored relevance analysis (band ${rel.band}): ${rel.whyItMatters}`,
    );
    if (rel.matchedPriorities.length) {
      lines.push(
        'Matched client priorities: ' +
          rel.matchedPriorities
            .map((p) => (p.kind ? `${p.label} (${p.kind})` : p.label))
            .join('; '),
      );
    }
    if (rel.implications.length) {
      lines.push('Implications on record:\n' + rel.implications.map((i) => `- ${i}`).join('\n'));
    }
  } else {
    lines.push(
      'Client relevance analysis: none on record for this hearing — do not assume the hearing matters ' +
        'to the client beyond what the quotes and entities above show.',
    );
  }
  const steering = ctx.clientSteering;
  if (steering?.soul) lines.push(`Client soul:\n${steering.soul}`);
  if (steering?.compass) lines.push(`Client compass:\n${steering.compass}`);
  if (steering?.people) lines.push(`Client people:\n${steering.people}`);
  return lines.join('\n');
}

export function createGeneratePostHearingSummaryTool(
  llm: LlmClient,
): ToolDefinition<GeneratePostHearingSummaryInput, GeneratePostHearingSummaryResult> {
  return {
    name: 'generate_post_hearing_summary',
    description:
      'Synthesize the client-ready narrative (exec summary, tone, risks, opportunities, next steps, ' +
      'draft client email) for a post-hearing brief from extracted quotes and entities, written for the ' +
      'named client when one is supplied.',
    readOnly: true,
    inputSchema: generatePostHearingSummaryInputSchema,
    handler: async (input, ctx: MeriContext): Promise<GeneratePostHearingSummaryResult> => {
      const steering = [
        ctx.firmMemory?.soul ? `Firm identity (Firm Soul):\n${ctx.firmMemory.soul}` : '',
        ctx.firmMemory?.compass ? `Firm direction (Firm Compass):\n${ctx.firmMemory.compass}` : '',
        ctx.userVoice ? `Draft the client email in this author's voice:\n${ctx.userVoice}` : '',
      ]
        .filter(Boolean)
        .join('\n\n');
      const client = input.client ? clientBlock(input.client, ctx) : '';
      const prompt =
        (steering ? `${steering}\n\n` : '') +
        (client ? `${client}\n\n` : '') +
        `Hearing: "${input.title}"\n\n` +
        `Flagged quotes:\n${input.quotes.map((q) => `- ${q.speakerName ? q.speakerName + ': ' : ''}"${q.text}" (@${q.timestampMs}ms)`).join('\n')}\n\n` +
        `Entities mentioned: ${input.mentions.map((m) => `${m.type}:${m.label}`).join(', ') || 'none'}\n\n` +
        `Action items captured: ${input.actionItems.join('; ') || 'none'}\n\n` +
        `Return JSON matching:\n${JSON.stringify(RESULT_SCHEMA)}`;

      const parsed = await llm.completeJson({ system: SYSTEM, prompt, maxTokens: 2000 });
      return normalize(parsed, input, classifyClientContext(input.client, ctx));
    },
  };
}

function normalize(
  p: Record<string, unknown>,
  input: GeneratePostHearingSummaryInput,
  clientContext: PostHearingClientContextStatus,
): GeneratePostHearingSummaryResult {
  const arr = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
  const str = (v: unknown, fallback: string): string =>
    typeof v === 'string' && v.trim() ? v : fallback;
  const email = (p.draftClientEmail ?? {}) as Record<string, unknown>;
  return {
    executiveSummary: str(p.executiveSummary, `Recap of "${input.title}".`),
    tone: str(p.tone, 'neutral'),
    risks: arr(p.risks),
    opportunities: arr(p.opportunities),
    recommendedNextSteps: arr(p.recommendedNextSteps).length
      ? arr(p.recommendedNextSteps)
      : input.actionItems,
    draftClientEmail: {
      subject: str(email.subject, `Hearing recap: ${input.title}`),
      body: str(email.body, `Recap of "${input.title}" attached.`),
    },
    clientContext,
  };
}
