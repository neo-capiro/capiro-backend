/**
 * Prompt + terminal tool for the executive-report narrative.
 *
 * The model receives an evidence packet (verbatim, audience-safe text with
 * opaque ids) and must return flowing executive prose in which every
 * paragraph cites the ids it draws on. The orchestrator's citation gate and
 * api-strategy's destination-side verifier both check the result, so the
 * prompt's job is to make grounded prose the path of least resistance:
 * restate, connect and sequence what the evidence says — never add to it.
 */

export const REPORT_NARRATIVE_SECTION_IDS = [
  'executive_summary',
  'situation',
  'objectives_and_ask',
  'stakeholders',
  'constraints_and_timing',
  'decisions_and_risks',
  'roadmap_outlook',
] as const;

export type ReportNarrativeSectionId = (typeof REPORT_NARRATIVE_SECTION_IDS)[number];

export interface ReportNarrativeInput {
  audience: 'client' | 'internal';
  strategy: { title: string; type: string; clientName: string; asOf: string };
  sections: ReportNarrativeSectionId[];
  maxParagraphsPerSection: number;
  evidence: Array<{ id: string; text: string }>;
}

export const MAX_NARRATIVE_EVIDENCE_ITEMS = 160;
export const MAX_NARRATIVE_EVIDENCE_CHARS = 70_000;
export const MAX_NARRATIVE_PARAGRAPHS_PER_SECTION = 4;

const SECTION_GUIDANCE: Record<ReportNarrativeSectionId, string> = {
  executive_summary:
    'The opening brief a senior executive reads first: what the strategy is for, where it stands today (readiness, timing), and what leadership is being asked to do. Two or three paragraphs.',
  situation:
    'The situation and operating context: the client’s position, the external timing pressures, and the intelligence that shapes the plan. One or two paragraphs.',
  objectives_and_ask:
    'The objective, what success looks like, and the primary ask or options on the table. One or two paragraphs.',
  stakeholders:
    'The stakeholder landscape: the offices, committees and agencies the plan engages and why each matters to the outcome. Name only stakeholders that appear in the evidence. One or two paragraphs.',
  constraints_and_timing:
    'Constraints, sensitivities and timing windows that bound how the plan can be delivered. One or two paragraphs.',
  decisions_and_risks:
    'The decisions leadership must make and the risks that need an owned response, framed as an agenda. One or two paragraphs.',
  roadmap_outlook:
    'How the work sequences across the timeline horizon: what is under way now, what follows, and what the target date depends on. One or two paragraphs.',
};

export const PROPOSE_REPORT_NARRATIVE_TOOL = {
  name: 'propose_report_narrative',
  description:
    'Return the executive-report narrative: for each requested section, one to four flowing paragraphs of plain prose, each citing the evidence ids it draws on. Omit a section entirely when the evidence does not support it.',
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      sections: {
        type: 'array',
        maxItems: REPORT_NARRATIVE_SECTION_IDS.length,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', enum: [...REPORT_NARRATIVE_SECTION_IDS] },
            paragraphs: {
              type: 'array',
              minItems: 1,
              maxItems: MAX_NARRATIVE_PARAGRAPHS_PER_SECTION,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  text: {
                    type: 'string',
                    description:
                      'One paragraph of plain prose (no markdown, no bullet characters, no evidence ids in the text). 40–900 characters.',
                  },
                  evidenceIds: {
                    type: 'array',
                    minItems: 1,
                    maxItems: 12,
                    items: { type: 'string' },
                    description:
                      'Ids of the evidence entries this paragraph is drawn from. Every fact in the paragraph must come from these entries.',
                  },
                },
                required: ['text', 'evidenceIds'],
              },
            },
          },
          required: ['id', 'paragraphs'],
        },
      },
    },
    required: ['sections'],
  },
} as const;

export const REPORT_NARRATIVE_SYSTEM_BASE = [
  'You are Meri, Capiro’s government-affairs strategist, writing the narrative for a branded executive strategy report.',
  '',
  '# Grounding rules (non-negotiable)',
  '- Write ONLY from the evidence packet in the user message. Each evidence entry has an id and verbatim text.',
  '- Never add a fact, figure, date, name, office, party, bill, program or outcome that is not stated in the evidence — including anything you may know about the client, the members, or the policy area from elsewhere. If the evidence does not say it, the report does not say it.',
  '- Use numbers and dates exactly as the evidence states them (same figures, same day/month/year). Do not round, convert, or infer durations.',
  '- Name people, offices, committees and organisations exactly as the evidence names them.',
  '- Do not speculate about motives, likelihoods or consequences that the evidence does not state. Where the evidence is thin, write less; omit a section rather than pad it.',
  '- Each paragraph must cite the evidence ids it draws on in `evidenceIds`. Do not put ids, brackets, markdown, headings or bullet characters inside the prose.',
  '',
  '# Voice',
  '- Executive register: confident, concrete, plain English. Short paragraphs of connected sentences — this replaces a bullet list, so the prose must read as continuous narrative, not restated bullets.',
  '- Third person. Refer to the client by name and to the firm as “Capiro”. No first-person, no marketing language, no exclamation marks.',
  '- Quotation marks only for text you are quoting verbatim from the evidence.',
].join('\n');

/**
 * Conventions for an amendment-type strategy (a budget line or authorizing
 * provision pursued through a named legislative vehicle). Mirrors the
 * plan-drafting addendum in strategy-prompt.ts so the report reads the same
 * way the plan was written. Appended to the user message ONLY for that type;
 * every other type's prompt is byte-identical to before.
 */
export const AMENDMENT_REPORT_CONVENTIONS = [
  '# Amendment strategy conventions',
  '- Figures: when you cite a dollar amount, quantity or fiscal-year baseline, say which exhibit type the evidence attributes it to (for example a P-1, R-1, P-40 or R-2 exhibit, a committee report, or NDAA funding tables). Never carry a figure across from a different line item, program element or fiscal year.',
  '- The ask: describe it as a program increase to a specific line, stated as capability and quantity. Keep it vendor-neutral — never name a single company as the recipient and never call it a directed buy.',
  '- Status ladder: use exactly the five stages the evidence uses — filed, made in order, adopted, conferenced, enacted — and never advance a stage the evidence does not show. Do not describe the request as enacted, appropriated, secured or received unless the evidence states that stage.',
  '- Floor timing: when the evidence gives no scheduled floor or Rules Committee window, describe it as not yet scheduled rather than estimating a date.',
  '- Backstop: when the evidence records a fallback route (the other chamber, conference, or the next fiscal-year request window), describe it as the backstop for the primary vehicle.',
].join('\n');

/**
 * api-strategy sends the display label ("Amendment ask") rather than the raw
 * type, so match the label prefix as well as the raw enum value.
 */
export function isAmendmentStrategyType(type: string | null | undefined): boolean {
  return /^amendment\b/i.test((type ?? '').trim());
}

export function composeReportNarrativePrompt(input: ReportNarrativeInput): {
  system: string;
  user: string;
} {
  const audienceNote =
    input.audience === 'client'
      ? 'Audience: the CLIENT’s leadership. The packet has already been filtered to client-safe material; write as a polished client deliverable.'
      : 'Audience: Capiro’s INTERNAL team. Working-plan and internal notes may appear in the evidence and may be discussed plainly.';
  const sections = input.sections.map((id) => `- ${id}: ${SECTION_GUIDANCE[id]}`).join('\n');
  const evidence = input.evidence.map((entry) => `[${entry.id}] ${entry.text}`).join('\n');
  const user = [
    `Report: ${input.strategy.title} (${input.strategy.type}) for ${input.strategy.clientName}, plan as of ${input.strategy.asOf}.`,
    audienceNote,
    ...(isAmendmentStrategyType(input.strategy.type) ? ['', AMENDMENT_REPORT_CONVENTIONS] : []),
    '',
    `Requested sections (at most ${input.maxParagraphsPerSection} paragraphs each; omit a section the evidence cannot support):`,
    sections,
    '',
    '# Evidence packet',
    evidence,
    '',
    `Call the ${PROPOSE_REPORT_NARRATIVE_TOOL.name} tool with the narrative.`,
  ].join('\n');
  return { system: REPORT_NARRATIVE_SYSTEM_BASE, user };
}

/**
 * Structural validation of the untrusted request body. api-strategy is the
 * only caller, but the body still crosses a service boundary.
 */
export function parseReportNarrativeInput(body: unknown): ReportNarrativeInput | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  const audience =
    record.audience === 'internal' ? 'internal' : record.audience === 'client' ? 'client' : null;
  if (!audience) return null;
  const strategy = record.strategy as Record<string, unknown> | undefined;
  const title = str(strategy?.title);
  const clientName = str(strategy?.clientName);
  if (!title || !clientName) return null;
  const requested = Array.isArray(record.sections)
    ? record.sections
    : [...REPORT_NARRATIVE_SECTION_IDS];
  const sections = requested.filter((id): id is ReportNarrativeSectionId =>
    (REPORT_NARRATIVE_SECTION_IDS as readonly string[]).includes(String(id)),
  );
  if (sections.length === 0) return null;
  const maxParagraphs = Number(record.maxParagraphsPerSection);
  const evidenceRaw = Array.isArray(record.evidence) ? record.evidence : [];
  const seen = new Set<string>();
  const evidence: Array<{ id: string; text: string }> = [];
  let chars = 0;
  for (const entry of evidenceRaw) {
    if (!entry || typeof entry !== 'object') continue;
    const id = str((entry as Record<string, unknown>).id);
    const text = str((entry as Record<string, unknown>).text);
    if (!id || !text || seen.has(id) || !/^[a-z0-9:_.-]{1,120}$/i.test(id)) continue;
    chars += text.length;
    if (evidence.length >= MAX_NARRATIVE_EVIDENCE_ITEMS || chars > MAX_NARRATIVE_EVIDENCE_CHARS)
      break;
    seen.add(id);
    evidence.push({ id, text });
  }
  if (evidence.length === 0) return null;
  return {
    audience,
    strategy: {
      title,
      type: str(strategy?.type) ?? 'Strategy',
      clientName,
      asOf: str(strategy?.asOf) ?? 'today',
    },
    sections: [...new Set(sections)],
    maxParagraphsPerSection:
      Number.isFinite(maxParagraphs) && maxParagraphs >= 1
        ? Math.min(MAX_NARRATIVE_PARAGRAPHS_PER_SECTION, Math.floor(maxParagraphs))
        : 3,
    evidence,
  };
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
