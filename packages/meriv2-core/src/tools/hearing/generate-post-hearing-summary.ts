import { z } from 'zod';
import type { MeriContext, ToolDefinition } from '../../registry/types';
import type { LlmClient } from '../../llm/llm-client';

/**
 * `generate_post_hearing_summary` — synthesize the client-ready narrative for a
 * post-hearing brief from the session's extracted quotes/entities/action items.
 * Called by intel-api's HearingBriefService. Returns ONLY the narrative parts
 * (exec summary, tone, risks, opportunities, next steps, draft email); intel-api
 * owns the sourced claim map + quote list.
 */
export interface GeneratePostHearingSummaryInput {
  sessionId: string;
  title: string;
  quotes: Array<{ text: string; speakerName?: string; timestampMs: number }>;
  mentions: Array<{ type: string; label: string; ref: string | null }>;
  actionItems: string[];
}

export interface GeneratePostHearingSummaryResult {
  executiveSummary: string;
  tone: string;
  risks: string[];
  opportunities: string[];
  recommendedNextSteps: string[];
  draftClientEmail: { subject: string; body: string };
}

export const generatePostHearingSummaryInputSchema = z.object({
  sessionId: z.string().min(1),
  title: z.string().min(1),
  quotes: z.array(
    z.object({ text: z.string(), speakerName: z.string().optional(), timestampMs: z.number() }),
  ),
  mentions: z.array(z.object({ type: z.string(), label: z.string(), ref: z.string().nullable() })),
  actionItems: z.array(z.string()),
});

const SYSTEM =
  'You are a senior federal lobbying strategist writing a client-ready hearing recap. Produce STRICT ' +
  'JSON only. Ground every statement in the supplied quotes/entities — do NOT invent facts, members, ' +
  'or positions not present. The executive summary is 2-4 sentences. Risks/opportunities are concrete ' +
  'and client-relevant. The draft email is concise and professional. Output JSON only, no prose.';

const RESULT_SCHEMA = {
  executiveSummary: 'string (2-4 sentences)',
  tone: 'string (overall tone of the hearing)',
  risks: ['string'],
  opportunities: ['string'],
  recommendedNextSteps: ['string'],
  draftClientEmail: { subject: 'string', body: 'string' },
};

export function createGeneratePostHearingSummaryTool(
  llm: LlmClient,
): ToolDefinition<GeneratePostHearingSummaryInput, GeneratePostHearingSummaryResult> {
  return {
    name: 'generate_post_hearing_summary',
    description:
      'Synthesize the client-ready narrative (exec summary, tone, risks, opportunities, next steps, ' +
      'draft client email) for a post-hearing brief from extracted quotes and entities.',
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
      const prompt =
        (steering ? `${steering}\n\n` : '') +
        `Hearing: "${input.title}"\n\n` +
        `Flagged quotes:\n${input.quotes.map((q) => `- ${q.speakerName ? q.speakerName + ': ' : ''}"${q.text}" (@${q.timestampMs}ms)`).join('\n')}\n\n` +
        `Entities mentioned: ${input.mentions.map((m) => `${m.type}:${m.label}`).join(', ') || 'none'}\n\n` +
        `Action items captured: ${input.actionItems.join('; ') || 'none'}\n\n` +
        `Return JSON matching:\n${JSON.stringify(RESULT_SCHEMA)}`;

      const parsed = await llm.completeJson({ system: SYSTEM, prompt, maxTokens: 1500 });
      return normalize(parsed, input);
    },
  };
}

function normalize(
  p: Record<string, unknown>,
  input: GeneratePostHearingSummaryInput,
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
  };
}
