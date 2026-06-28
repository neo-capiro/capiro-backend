import { Injectable, Logger } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { MeriToolsService } from '../meri/meri-tools.service.js';
import { AiCredentialResolverService } from '../engagement/ai-credential-resolver.service.js';
import type { WorkspaceAssistantDto } from './workspace-assistant.dto.js';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MAX_ROUNDS = 5;
const MAX_TOKENS = 4096;
const TOOL_RESULT_CHARS = 12_000;

/**
 * The constrained, READ-ONLY tool surface the in-editor Meri may use. This is a
 * curated subset of the full Meri agent (no write-backs, no email/tasks/
 * scheduling, no doc generation, no code sandbox, no open web) — firm/client
 * data + congressional / PE / intelligence lookups only. Keeping this an
 * allowlist (not a denylist) means new Meri tools never silently leak in.
 */
const ASSISTANT_TOOLS = new Set<string>([
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

export interface AssistantEdit {
  op: 'replace_section' | 'insert_section' | 'remove_section';
  section?: string;
  afterSection?: string;
  name?: string;
  content?: string;
  note?: string;
}

export interface AssistantResult {
  reply: string;
  edits: AssistantEdit[];
}

type AnthropicBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: string; [k: string]: unknown };

/** The terminal "answer" tool: Meri calls this to return its reply + edits. */
const PROPOSE_EDITS_TOOL = {
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
            op: {
              type: 'string',
              enum: ['replace_section', 'insert_section', 'remove_section'],
            },
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

@Injectable()
export class WorkspaceAssistantService {
  private readonly logger = new Logger(WorkspaceAssistantService.name);

  constructor(
    private readonly tools: MeriToolsService,
    private readonly aiCredentials: AiCredentialResolverService,
  ) {}

  async run(ctx: TenantContext, dto: WorkspaceAssistantDto): Promise<AssistantResult> {
    const resolved = await this.aiCredentials.resolveProvider(ctx, 'anthropic');
    if (!resolved?.apiKey) {
      return {
        reply:
          'Meri is not configured for this workspace yet (no AI key). Add one in Settings → AI, or contact your admin.',
        edits: [],
      };
    }
    const { apiKey, model } = resolved;

    const system = this.buildSystemPrompt(dto);
    const toolSchemas = [
      ...this.tools.anthropicToolSchemas().filter((s) => ASSISTANT_TOOLS.has(s.name)),
      PROPOSE_EDITS_TOOL,
    ];

    // Seed the turn from the conversation history (strings). Tool rounds append
    // assistant tool_use + user tool_result block arrays.
    const messages: Array<{ role: 'user' | 'assistant'; content: unknown }> = (dto.messages ?? [])
      .filter(
        (m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.text === 'string',
      )
      .slice(-20)
      .map((m) => ({ role: m.role, content: m.text }));
    if (!messages.length || messages[messages.length - 1]?.role !== 'user') {
      return { reply: 'What would you like me to do with this document?', edits: [] };
    }

    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      let data: { content?: AnthropicBlock[]; stop_reason?: string };
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 60_000);
        const res = await fetch(ANTHROPIC_URL, {
          method: 'POST',
          headers: {
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model,
            max_tokens: MAX_TOKENS,
            system,
            tools: toolSchemas,
            messages,
          }),
          signal: controller.signal,
        }).finally(() => clearTimeout(timer));
        if (!res.ok) {
          const errText = await res.text().catch(() => '');
          throw new Error(
            `Anthropic HTTP ${res.status}${errText ? `: ${errText.slice(0, 200)}` : ''}`,
          );
        }
        data = (await res.json()) as { content?: AnthropicBlock[]; stop_reason?: string };
      } catch (e) {
        this.logger.warn(`workspace-assistant model call failed: ${(e as Error).message}`);
        return {
          reply: 'Sorry — I hit an error reaching the model. Please try again in a moment.',
          edits: [],
        };
      }

      const blocks = Array.isArray(data.content) ? data.content : [];
      const textOut = blocks
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();
      const toolUses = blocks.filter(
        (b): b is { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> } =>
          b.type === 'tool_use',
      );

      // Terminal: Meri proposed its answer (+ optional edits).
      const propose = toolUses.find((t) => t.name === 'propose_document_edits');
      if (propose) {
        const input = propose.input ?? {};
        const reply = typeof input.reply === 'string' && input.reply.trim() ? input.reply : textOut;
        return { reply: reply || 'Done.', edits: this.sanitizeEdits(input.edits) };
      }

      // No tools requested → plain conversational answer.
      if (!toolUses.length || data.stop_reason !== 'tool_use') {
        return { reply: textOut || 'Done.', edits: [] };
      }

      // Execute the requested read-only data tools and feed results back.
      messages.push({ role: 'assistant', content: blocks });
      const results = await Promise.all(
        toolUses.map(async (tu) => {
          let result: unknown;
          if (!ASSISTANT_TOOLS.has(tu.name)) {
            result = { error: `Tool "${tu.name}" is not available in the document assistant.` };
          } else {
            try {
              result = await this.tools.execute(ctx, tu.name as never, tu.input ?? {});
            } catch (e) {
              result = { error: (e as Error).message };
            }
          }
          return {
            type: 'tool_result' as const,
            tool_use_id: tu.id,
            content: JSON.stringify(result ?? {}).slice(0, TOOL_RESULT_CHARS),
          };
        }),
      );
      messages.push({ role: 'user', content: results });
    }

    return {
      reply:
        'I gathered some context but ran out of steps before composing a full answer — ask again and I’ll continue.',
      edits: [],
    };
  }

  /** Coerce + validate the model's proposed edits into the strict edit shape. */
  private sanitizeEdits(raw: unknown): AssistantEdit[] {
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
      // Drop edits that can't be applied.
      if (op === 'remove_section' && !edit.section) continue;
      if (op === 'replace_section' && (!edit.section || edit.content == null)) continue;
      if (op === 'insert_section' && (!edit.name || edit.content == null)) continue;
      out.push(edit);
    }
    return out;
  }

  /** System prompt: who Meri is, the live document, setup, and the edit contract. */
  private buildSystemPrompt(dto: WorkspaceAssistantDto): string {
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
        const label = c?.label ? `${c.label}: ` : '';
        const text = (c?.text ?? '').replace(/\s+/g, ' ').trim();
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
}
