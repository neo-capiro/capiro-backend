import {
  DOMAIN_PRIMER,
  planModeSteering,
  type IntentClassification,
  type MeriContext,
} from '@capiro/meriv2-core';

/**
 * Full Meri chat (Workstream C4) — pure prompt/label logic, kept dependency-light
 * so it unit-tests without the network or the registry. The chat surface differs
 * from the in-editor assistant in three ways: it is NOT scoped to one document,
 * it can call the FULL tool surface (reads + gated writes, not the read-only
 * allowlist), and it answers in prose (no propose_document_edits terminal).
 */

/** The chat request: a conversation, an optional client focus, optional history id. */
export interface ChatInput {
  messages?: Array<{ role?: unknown; text?: unknown }>;
  clientId?: string;
  /** Opaque conversation id the caller threads across turns (persistence is the caller's; C4 is stateless per turn). */
  conversationId?: string;
  /**
   * Pre-warmed memory recall, provided by the apps/api proxy (which owns the
   * clio_memory store + embeddings): the same loadRelevantMemories() lines the
   * LEGACY chat injects before answering. Without this, "what is my nickname"-
   * class questions fail — the model has no reason to know a memory exists
   * (canary regression, 2026-07-06). One line per memory, already formatted.
   */
  memoryContext?: string[];
}

export interface ChatStep {
  tool: string;
  label: string;
  detail?: string;
  status: 'done' | 'error' | 'pending_approval' | 'blocked';
}

export interface ChatResult {
  reply: string;
  steps?: ChatStep[];
  /**
   * Write actions the model attempted that the compliance gate held for human
   * approval (B1-B4). Each carries the fingerprint the surface uses to approve
   * (POST /api/clio/approvals/approve) before re-running the turn. Empty/absent
   * when nothing was gated.
   */
  pendingApprovals?: Array<{ tool: string; fingerprint: string; reason: string }>;
}

/**
 * Progressive events the chat loop emits while it runs — the streaming
 * transport's contract (POST /meri-api/chat/stream). Orchestrator-shaped, NOT
 * the legacy ChatDrawer SSE union: the apps/api proxy translates. Per-round
 * granularity (completeWithTools is non-streaming): tool activity streams live
 * as it happens; each round's text arrives when the round completes. Token-level
 * deltas of the final reply are a deliberate follow-up.
 */
export type ChatStreamEvent =
  | { type: 'tool_call'; tool: string; label: string }
  | {
      type: 'tool_done';
      tool: string;
      label: string;
      status: ChatStep['status'];
      detail?: string;
    }
  | { type: 'pending_approval'; tool: string; label: string; fingerprint: string; reason: string }
  | { type: 'text'; text: string };

/** Friendly label for a tool name, for the chat's thought-process trace. */
export function toolLabel(tool: string): string {
  return TOOL_LABELS[tool] ?? `Ran ${tool}`;
}

const TOOL_LABELS: Record<string, string> = {
  get_client_context: 'Reviewed client context',
  search_client_knowledge: 'Searched client knowledge',
  search_research_sources: 'Searched research sources',
  read_client_documents: 'Read client documents',
  query_intelligence: 'Queried federal intelligence',
  query_knowledge_graph: 'Queried the knowledge graph',
  find_path_to: 'Traced knowledge-graph connections',
  search_memory: 'Searched firm memory',
  search_intel_articles: 'Searched intel articles',
  search_congress_bills: 'Searched Congress bills',
  search_tracked_bills: 'Searched tracked bills',
  search_lda_filings: 'Searched LDA filings',
  search_sec_filings: 'Searched SEC filings',
  search_fara_registrations: 'Searched FARA registrations',
  search_federal_grants: 'Searched federal grants',
  search_federal_awards: 'Searched federal awards',
  search_committee_hearings: 'Searched committee hearings',
  search_crs_reports: 'Searched CRS reports',
  search_gao_reports: 'Searched GAO reports',
  search_state_bills: 'Searched state bills',
  query_regulatory_dockets: 'Queried regulatory dockets',
  search_sam_opportunities: 'Searched SAM opportunities',
  search_program_elements: 'Searched program elements',
  get_program_element: 'Looked up a program element',
  get_pe_budget_timeline: 'Pulled PE budget timeline',
  get_pe_contractors: 'Pulled PE contractors',
  get_pe_bills: 'Pulled PE bill references',
  search_acquisition_personnel: 'Searched acquisition personnel',
  get_acquisition_person: 'Looked up an acquisition contact',
  query_economic_data: 'Queried economic data',
  search_public_web: 'Searched the public web',
  scrape_web_page: 'Read a web page',
  query_tasks: 'Reviewed tasks',
  query_action_items: 'Reviewed action items',
  query_debriefs: 'Reviewed meeting debriefs',
  query_outreach: 'Reviewed outreach',
  list_emails: 'Listed emails',
  list_scheduled_tasks: 'Listed scheduled tasks',
  // Write tools (gate-held) — labelled for the trace even when they don't run.
  create_task: 'Proposed creating a task',
  update_task: 'Proposed updating a task',
  update_client_profile: 'Proposed a client-profile update',
  send_email: 'Proposed sending an email',
  reply_email: 'Proposed an email reply',
  save_note: 'Proposed saving a note',
  save_memory: 'Proposed saving a memory',
  create_word: 'Proposed a Word document',
  create_excel: 'Proposed an Excel workbook',
  create_powerpoint: 'Proposed a PowerPoint deck',
  create_meeting_brief: 'Proposed a meeting brief',
  draft_policy_memo: 'Proposed a policy memo',
  schedule_task: 'Proposed a scheduled task',
  cancel_scheduled_task: 'Proposed cancelling a scheduled task',
};

/** System prompt: who Meri is, the firm/user voice, the tool contract, the gate. */
export function buildChatSystemPrompt(
  dto: ChatInput,
  ctx: MeriContext,
  intent?: IntentClassification,
): string {
  const firm = ctx.firmMemory;
  const voice = ctx.userVoice;
  return [
    'You are Meri, an AI copilot for a U.S. federal government-affairs (lobbying) firm.',
    'You help lobbyists research legislation, program elements & budgets, the congressional directory, federal intelligence, and their own clients — and you can draft and take actions on their behalf.',
    dto.clientId
      ? `\nThe conversation is focused on client id: ${dto.clientId} (use it for client tools).`
      : '',
    firm?.soul ? `\n# Firm identity\n${firm.soul}` : '',
    firm?.compass ? `\n# Firm compass\n${firm.compass}` : '',
    voice ? `\n# The user's writing voice (mirror it when you draft)\n${voice}` : '',
    dto.memoryContext?.length
      ? `\n# What you remember (firm + this user)\nThese are stored memories relevant to this conversation — use them directly when they answer the question:\n${dto.memoryContext.map((m) => `- ${m}`).join('\n')}`
      : '',
    // Plan-mode steering (agent-map wiring): only when a mode classified with
    // signal — `research` is also the zero-hit fallback, so the common case
    // stays byte-identical to before.
    intent && intent.mode !== 'research' && intent.confidence > 0
      ? `
# Mode: ${intent.mode}
${planModeSteering(intent.mode)}`
      : '',
    '',
    '# Tools',
    'Call the provided tools to look up firm/client data and federal intelligence, and to draft or take actions. Ground every factual claim in retrieved data — never fabricate figures, bill numbers, names, or citations. If you lack the data, say so and offer to look it up.',
    'RETRIEVE BEFORE YOU ASSERT: before stating anything about a Program Element, bill, person, or budget figure, call the relevant tool and quote the returned values.',
    '',
    '# Where firm data lives (route the question to the RIGHT tool)',
    'Questions about the USER or the FIRM (their preferences, nicknames, people, prior decisions, anything "about me/us"): call search_memory FIRST — never say you have no record before searching memory.',
    'Meetings and meeting history/debriefs: query_debriefs. Tasks and to-dos: query_tasks. Outreach and past communications: query_outreach. Emails: list_emails. A client’s profile, team, and context: get_client_context (use the conversation’s client focus, or search memory/knowledge for the client first).',
    'search_research_sources, search_public_web, and the congress/PE/LDA tools are for FEDERAL and legislative research — never use them for firm-internal questions like meetings, clients, or user facts.',
    '',
    '# Actions require approval',
    'Some tools take real actions (sending email, creating tasks, updating a client profile, generating documents, saving memory). When you call one, the system holds it for the user to approve — you will see it come back as "pending approval", NOT as a completed action. Never tell the user an action is done when it is only pending; say you have proposed it and it awaits their approval.',
    '',
    `# Domain knowledge\n${DOMAIN_PRIMER}`,
    '',
    '# How to respond',
    'Do your lookups first, then answer in clear, concise prose in the firm’s professional register. Cite the data you used. When you propose an action, briefly say what it will do and that it needs approval.',
  ]
    .filter(Boolean)
    .join('\n');
}
