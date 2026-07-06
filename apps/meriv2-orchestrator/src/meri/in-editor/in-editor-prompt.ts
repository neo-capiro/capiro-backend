import { DOMAIN_PRIMER } from '@capiro/meriv2-core';

/**
 * In-editor assistant — pure prompt/edit logic, reproduced faithfully from
 * apps/api's workspace-assistant.service so the MeriV2-served surface matches
 * the legacy in-process one (SC0.2/SC0.3). Kept pure + dependency-light so it is
 * unit-tested without the network or the registry.
 */

/** The document + conversation the editor posts (mirror of WorkspaceAssistantDto). */
export interface InEditorInput {
  messages?: Array<{ role?: unknown; text?: unknown }>;
  document?: Record<string, unknown>;
  setup?: Record<string, unknown>;
  context?: Array<{ label?: unknown; text?: unknown }>;
  clientId?: string;
}

export interface AssistantEdit {
  op: 'replace_section' | 'insert_section' | 'remove_section';
  section?: string;
  afterSection?: string;
  name?: string;
  content?: string;
  note?: string;
}

export interface AssistantStep {
  tool: string;
  label: string;
  detail?: string;
  status: 'done' | 'error';
}

export interface AssistantResult {
  reply: string;
  edits: AssistantEdit[];
  steps?: AssistantStep[];
}

/**
 * The constrained READ-ONLY tool surface the in-editor assistant may use — a
 * curated allowlist (not a denylist) identical to apps/api ASSISTANT_TOOLS, so a
 * new Meri tool never silently leaks in. Matches IN_EDITOR_DELEGATED_TOOLS.
 */
export const ASSISTANT_TOOLS: ReadonlySet<string> = new Set<string>([
  'get_client_context',
  'search_client_knowledge',
  'search_research_sources',
  'read_client_documents',
  'query_intelligence',
  'query_knowledge_graph',
  'find_path_to',
  'search_intel_articles',
  'search_congress_bills',
  'search_tracked_bills',
  'search_lda_filings',
  'search_committee_hearings',
  'search_crs_reports',
  'search_gao_reports',
  'query_regulatory_dockets',
  'search_federal_awards',
  'search_program_elements',
  'get_program_element',
  'get_pe_budget_timeline',
  'get_pe_contractors',
  'get_pe_bills',
  'search_acquisition_personnel',
  'get_acquisition_person',
  'query_economic_data',
]);

const TOOL_LABELS: Record<string, string> = {
  get_client_context: 'Reviewed client context',
  search_client_knowledge: 'Searched client knowledge',
  search_research_sources: 'Searched research sources',
  read_client_documents: 'Read client documents',
  query_intelligence: 'Queried federal intelligence',
  query_knowledge_graph: 'Queried the knowledge graph',
  find_path_to: 'Traced knowledge-graph connections',
  search_intel_articles: 'Searched intel articles',
  search_congress_bills: 'Searched Congress bills',
  search_tracked_bills: 'Searched tracked bills',
  search_lda_filings: 'Searched LDA filings',
  search_committee_hearings: 'Searched committee hearings',
  search_crs_reports: 'Searched CRS reports',
  search_gao_reports: 'Searched GAO reports',
  query_regulatory_dockets: 'Queried regulatory dockets',
  search_federal_awards: 'Searched federal awards',
  search_program_elements: 'Searched program elements',
  get_program_element: 'Looked up a program element',
  get_pe_budget_timeline: 'Pulled PE budget timeline',
  get_pe_contractors: 'Pulled PE contractors',
  get_pe_bills: 'Pulled PE bill references',
  search_acquisition_personnel: 'Searched acquisition personnel',
  get_acquisition_person: 'Looked up an acquisition contact',
  query_economic_data: 'Queried economic data',
};

export function toolLabel(tool: string): string {
  return TOOL_LABELS[tool] ?? `Ran ${tool}`;
}

/** The terminal "answer" tool: the model calls this to return its reply + edits. */
export const PROPOSE_EDITS_TOOL = {
  name: 'propose_document_edits',
  description:
    'Return your reply to the user and any proposed edits to the document. Call this when you are ready to answer. For a question that needs no document change, pass an empty edits array.',
  input_schema: {
    type: 'object',
    properties: {
      reply: { type: 'string', description: 'Your conversational reply to the user.' },
      edits: {
        type: 'array',
        description:
          'Edits to apply to the document (may be empty). For a whole-document change (e.g. expanding acronyms, changing tone), emit one replace_section per affected section.',
        items: {
          type: 'object',
          properties: {
            op: { type: 'string', enum: ['replace_section', 'insert_section', 'remove_section'] },
            section: {
              type: 'string',
              description: 'Target section name — for replace_section and remove_section.',
            },
            afterSection: {
              type: 'string',
              description:
                'For insert_section: place the new section after this one (omit to append).',
            },
            name: { type: 'string', description: 'For insert_section: the new section name.' },
            content: {
              type: 'string',
              description:
                'For replace_section / insert_section: the full new section body as simple HTML (<p>, <ul>, <li>, <strong>, <em>, <h3>). Plain prose, no scripts/styles.',
            },
            note: {
              type: 'string',
              description: 'A short reason for this edit, shown to the user.',
            },
          },
          required: ['op'],
        },
      },
    },
    required: ['reply', 'edits'],
  },
} as const;

/** Coerce + validate the model's proposed edits into the strict edit shape (max 40). */
export function sanitizeEdits(raw: unknown): AssistantEdit[] {
  if (!Array.isArray(raw)) return [];
  const out: AssistantEdit[] = [];
  for (const e of raw.slice(0, 40)) {
    if (!e || typeof e !== 'object') continue;
    const op = (e as { op?: unknown }).op;
    if (op !== 'replace_section' && op !== 'insert_section' && op !== 'remove_section') continue;
    const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : undefined);
    const edit: AssistantEdit = {
      op,
      section: str((e as { section?: unknown }).section),
      afterSection: str((e as { afterSection?: unknown }).afterSection),
      name: str((e as { name?: unknown }).name),
      content:
        typeof (e as { content?: unknown }).content === 'string'
          ? (e as { content: string }).content
          : undefined,
      note: str((e as { note?: unknown }).note),
    };
    if (op === 'remove_section' && !edit.section) continue;
    if (op === 'replace_section' && (!edit.section || edit.content == null)) continue;
    if (op === 'insert_section' && (!edit.name || edit.content == null)) continue;
    out.push(edit);
  }
  return out;
}

/** System prompt: who Meri is, the live document, setup, and the edit contract. */
export function buildSystemPrompt(dto: InEditorInput): string {
  const doc = dto.document ?? {};
  const title = typeof doc.title === 'string' ? doc.title : 'Untitled document';
  const product = typeof doc.product === 'string' ? doc.product : '';
  const client = typeof doc.client === 'string' ? doc.client : '';
  const sections = Array.isArray(doc.sections) ? doc.sections : [];

  const sectionText = sections
    .map((s) => {
      const sec = (s ?? {}) as { name?: unknown; content?: unknown };
      const name = typeof sec.name === 'string' ? sec.name : 'Section';
      const body =
        typeof sec.content === 'string' ? sec.content.replace(/<[^>]*>/g, ' ').trim() : '';
      const trimmed = body.length > 1500 ? `${body.slice(0, 1500)}…` : body || '(empty)';
      return `### ${name}\n${trimmed}`;
    })
    .join('\n\n')
    .slice(0, 16_000);

  const setup = dto.setup ?? {};
  const setupLines = Object.entries(setup)
    .filter(([, v]) => v != null && v !== '' && !(Array.isArray(v) && v.length === 0))
    .map(([k, v]) => `- ${k}: ${Array.isArray(v) ? v.join(', ') : String(v)}`)
    .join('\n')
    .slice(0, 2_000);

  const contextText = (dto.context ?? [])
    .map((c) => {
      const label = c?.label ? `${String(c.label)}: ` : '';
      const text = (typeof c?.text === 'string' ? c.text : '').replace(/\s+/g, ' ').trim();
      return text ? `- ${label}${text.length > 600 ? `${text.slice(0, 600)}…` : text}` : '';
    })
    .filter(Boolean)
    .join('\n')
    .slice(0, 8_000);

  const sectionNames = sections
    .map((s) => (s as { name?: unknown })?.name)
    .filter((n): n is string => typeof n === 'string');

  return [
    'You are Meri, an in-document drafting assistant for a U.S. federal government-affairs (lobbying) firm.',
    'You are editing ONE specific document with the user, like an AI assistant inside a Google Doc. Operate ONLY in the context of THIS document — do not invent unrelated content.',
    '',
    `# Document\nTitle: ${title}${product ? `\nWork product: ${product}` : ''}${client ? `\nClient: ${client}` : ''}${dto.clientId ? `\nClient id (use for client tools): ${dto.clientId}` : ''}`,
    sectionNames.length ? `Sections (in order): ${sectionNames.join(' | ')}` : '',
    '',
    '## Current section content\n' + (sectionText || '(no sections yet)'),
    setupLines ? `\n# Setup\n${setupLines}` : '',
    contextText
      ? `\n# Linked context (from the Context Builder — ground your work in this)\n${contextText}`
      : '',
    '',
    '# Tools',
    'You may call the provided READ-ONLY tools to look up firm/client data, tracked bills, program elements & budgets, the congressional directory, and federal intelligence. Ground factual claims in retrieved data or the linked context above. Never fabricate figures, bill numbers, names, or citations. If you lack the data, say so.',
    'RETRIEVE BEFORE YOU DRAFT: before writing any sentence about a Program Element, bill, person, or budget figure, call the relevant tool (e.g. get_program_element / get_pe_budget_timeline) and quote the returned title, appropriation type, and figures verbatim. Do NOT assume a PE from the setup/context is correct — validate that its mission and appropriation type match the ask before building strategy on it.',
    '',
    `# Domain knowledge\n${DOMAIN_PRIMER}`,
    '',
    '# How to respond',
    'When you are ready, call `propose_document_edits` with your `reply` and an `edits` array:',
    '- To rewrite a section, use replace_section with the EXISTING section name and the full new HTML body.',
    '- To add a section, use insert_section with a new name, the HTML body, and optionally afterSection.',
    '- To delete a section, use remove_section with the section name.',
    '- For a whole-document change (expand acronyms, shift tone, tighten the ask), emit one replace_section per affected section.',
    'Keep HTML simple: <p>, <ul>, <li>, <strong>, <em>, <h3>. No scripts, styles, or images.',
    'Call `propose_document_edits` as the ONLY tool in that response — never alongside a data-lookup tool. Do your lookups first, in earlier turns.',
    'If the user only asks a question or wants advice, reply with an empty edits array.',
    'Be concise and concrete. Match the document’s tone and the firm’s professional register.',
  ]
    .filter(Boolean)
    .join('\n');
}
