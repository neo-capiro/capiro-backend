/**
 * Pure, dependency-free helpers for assembling the Meri chat request to the
 * Anthropic Messages API: system-prompt content blocks, tool-schema cache
 * breakpoints, and streaming token-usage accounting.
 *
 * Everything here is a pure function so it can be unit-tested under the repo's
 * standard `src/**.spec.ts` jest matcher (jest does NOT scan `scripts/` or
 * `test/`). The orchestrating service (`meri.service.ts`) imports these; keep
 * all I/O, Prisma, and HTTP out of this file.
 *
 * Prompt caching (P0-1): Anthropic caches the request prefix up to and including
 * each `cache_control: { type: 'ephemeral' }` breakpoint. The cacheable prefix
 * order is tools -> system -> messages, so we place breakpoints on (a) the final
 * tool schema and (b) the static system base. Both are byte-identical across
 * turns, so turns 2..N within the 5-minute cache TTL read the prefix from cache
 * (response usage reports `cache_read_input_tokens > 0`) instead of re-encoding
 * it. We deliberately do NOT cache the dynamic system tail (intent guidance +
 * per-tenant context snapshot) or the messages, both of which vary per turn and
 * could otherwise leak tenant-specific content into a long-lived cache prefix.
 */

// Zero-trust grounding kernel (v3 plan §2.3 designates this file as the home).
// Canonical in @capiro/shared (so the meriv2-orchestrator shares byte-identical
// text); re-exported here so apps/api callers and tests import from one place.
export {
  MERI_GROUNDING_INVARIANT,
  MERI_GROUNDING_OUTREACH_KERNEL,
  meriGroundingSurfaceBlock,
  meriGroundingDateBlock,
  FORM_B_CITATION_RE,
  validateFormBCitations,
  type MeriGroundingSurface,
  type CitationAnchor,
  type FormBCitationCheck,
} from '@capiro/shared';

export interface EphemeralCacheControl {
  type: 'ephemeral';
}

export interface SystemTextBlock {
  type: 'text';
  text: string;
  cache_control?: EphemeralCacheControl;
}

export interface MeriTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

const EPHEMERAL: EphemeralCacheControl = { type: 'ephemeral' };

/**
 * Static "What you can do" capability block injected into Meri's system prompt.
 * Kept here as a pure, exported constant so a unit test can assert the
 * capability + memory framing is present (the regression guard for Meri ever
 * claiming it is "just a chatbot" with no memory / no abilities). The lines are
 * joined into the base prompt by meri.service.ts.
 */
export const CLIO_CAPABILITY_LINES: readonly string[] = [
  'What you are and what you can do (describe these honestly when asked about your capabilities; never deny being able to converse, and never claim you are "just a chatbot" or that you lack these abilities):',
  '- Conversational AI: yes — you are a conversational AI assistant. You hold a natural back-and-forth dialogue, answer questions, explain, summarize, and reason in plain language. If asked "are you a conversational AI" or "can you chat," the answer is YES; you are a conversational assistant AND a specialized government-affairs agent with the tools below.',
  '- Persistent memory: you remember durable facts, preferences, and priorities across conversations for this firm and user.',
  '- Live data retrieval: you call tools for client context, engagement/meetings, federal lobbying intelligence, bills, LDA/SEC/FARA filings, grants, contract awards, DoD Program Elements, GAO/CRS reports, state bills, hearings, news, and economic data.',
  "- Drafting & actions: you draft policy memos, meeting briefs, and emails, and (with the user's approval) send or reply to email.",
  "- Your firm's own work: you can read engagement tasks and what is overdue, the Needs-Attention action items, tracked bills, regulatory dockets and comment deadlines, SAM.gov contract opportunities, meeting debriefs, outreach campaigns, and full client profiles (capabilities, key people, facilities). With the user's approval you can also create or update engagement tasks.",
  "- Populating client profiles from the web: when asked to research/import/fill in a client, you can research the organization (search_public_web, scrape_web_page, and federal sources like LDA filings) and then, AFTER showing the user the proposed values with a source for each and getting their approval, write them into the client profile via update_client_profile. You can write the overview fields (name, website, description, productDescription, primary contact, sectorTag, issueCodes, uei, cageCode, naicsCodes, pscCodes) AND append facilities (locations: name, address, city, state, ZIP, congressional district, employee count) and capabilities (products/technologies/services the org offers: name, type, description, sector) you find on the client's website — pass them as the facilities[] and capabilities[] arrays (each row is appended, existing rows are never deleted). Never write unreviewed scraped data — propose first, write only what the user approves.",
  "- Client documents: you can list and READ the files uploaded in a client's Documents tab (contracts, briefs, PDFs, Word docs, text, and audio/video transcripts) via read_client_documents — so you can summarize, quote, or answer questions about a file the user uploaded for that client.",
  '- Document generation: you can produce downloadable Microsoft Word (.docx), Excel (.xlsx), and PowerPoint (.pptx) files on request via the create_word, create_excel, and create_powerpoint tools.',
  '- Formatting: you can present results in well-structured Markdown, including tables, which render cleanly in the chat.',
  'Only claim a capability you actually have here. If a specific action is unavailable in the current context (for example a tool is not configured), say so plainly rather than guessing.',
] as const;

/** The capability block as a single newline-joined string for prompt assembly. */
export function meriCapabilityBlock(): string {
  return CLIO_CAPABILITY_LINES.join('\n');
}

/** How to refer to the session's client when its name could not be resolved. */
const UNNAMED_CLIENT = 'the client this session is assigned to';

/**
 * Tells a client UUID apart from an exact client NAME in a tool's `clientId`
 * (find_contacts documents both forms). Shared by every surface that enforces
 * session client scope — the chat loop, the Deep Research loop, and the
 * firm-wide tool readers — so they agree on what "a different client" means.
 */
export const CLIENT_ID_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Hard client-scope directive for a conversation assigned to a client.
 *
 * Before this existed, the ONLY signal that a session belonged to one client
 * was a `Client: <name>` line buried in the per-turn context snapshot — sitting
 * directly beside the firm's full client roster and tenant-wide research. The
 * model was never told the session was a boundary, so it happily answered a
 * scoped session with other clients' work (reported live, 2026-07-29).
 *
 * Lives in the per-turn DYNAMIC tail, never the cached base: the client varies
 * per conversation, so caching it would poison the shared prefix.
 */
export function clientScopeDirective(clientName: string | null | undefined): string {
  const label = clientName?.trim() ? `"${clientName.trim()}"` : UNNAMED_CLIENT;
  return [
    `Active client scope (HARD CONSTRAINT): this conversation is assigned to ${label}.`,
    `Every answer, draft, recommendation, and tool call in this session must be about ${label} and nothing else.`,
    `Do NOT report, compare, summarize, or mention any other client's meetings, emails, tasks, outreach, documents, filings, or remembered facts — not even in passing, and not even if another client appears in the context below or in a tool result. Treat any such material as out of scope and leave it out.`,
    `The firm's client roster is provided only so you can answer questions about the roster itself (who the clients are, how many there are, whether an organization is a client). It is not license to discuss another client's work.`,
    `If the user asks about a different client, say plainly that this session is scoped to ${label} and ask them to switch the session's client (or open a General session). Do not answer from another client's data.`,
    `Client-scoped tools are pinned to ${label}: they refuse a different client rather than returning it.`,
  ].join(' ');
}

/**
 * The result a client-scoped session returns when the model asks a tool for a
 * DIFFERENT client. Deliberately a refusal, not a silent rewrite to the session
 * client: swapping the id under the model would let it present client A's rows
 * under client B's name, which is worse than reading nothing. Worded for the
 * user, because the model relays it.
 */
export function clientScopeRefusal(clientName: string | null | undefined): string {
  const label = clientName?.trim() ? `"${clientName.trim()}"` : UNNAMED_CLIENT;
  return (
    `Blocked: this conversation is scoped to ${label}, so nothing was read for the client you requested. ` +
    `Tell the user this session only covers ${label}, and that switching the session's client (or opening a General session) is what lets you look at another client.`
  );
}

/**
 * Build the `system` field as an array of content blocks. The static `base`
 * goes first and (when caching is enabled) carries the cache breakpoint; the
 * per-turn `dynamic` tail, if present, follows WITHOUT a breakpoint so it never
 * busts the cached prefix. When `dynamic` is empty/whitespace it is omitted so
 * the cached prefix is exactly `base`.
 */
export function buildMeriSystemBlocks(opts: {
  base: string;
  dynamic?: string;
  cacheEnabled: boolean;
}): SystemTextBlock[] {
  const base: SystemTextBlock = { type: 'text', text: opts.base };
  if (opts.cacheEnabled && opts.base.length > 0) {
    base.cache_control = EPHEMERAL;
  }
  const blocks: SystemTextBlock[] = [base];
  if (opts.dynamic && opts.dynamic.trim().length > 0) {
    blocks.push({ type: 'text', text: opts.dynamic });
  }
  return blocks;
}

/**
 * Return a NEW tool array with a single cache breakpoint on the LAST tool, so
 * Anthropic caches the entire (static) tool block. Never mutates the input
 * array or its elements (we shallow-clone every element). No-op shape when
 * caching is disabled or the list is empty.
 */
export function applyToolCacheControl<T extends object>(
  tools: T[],
  cacheEnabled: boolean,
): Array<T & { cache_control?: EphemeralCacheControl }> {
  const lastIndex = tools.length - 1;
  return tools.map((tool, index) => {
    if (cacheEnabled && index === lastIndex) {
      return { ...tool, cache_control: EPHEMERAL };
    }
    return { ...tool };
  });
}

/** A fresh zeroed usage accumulator. */
export function emptyUsage(): MeriTokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  };
}

/**
 * Extract token usage from a single Anthropic streaming event.
 * - `message_start` carries `message.usage` with input + cache token counts
 *   (and an initial output count).
 * - `message_delta` carries `usage.output_tokens`, the cumulative output count
 *   for the in-flight message.
 * Returns `null` for events that carry no usage. Defensive against partial /
 * malformed events (everything coerces to a finite number or is omitted).
 */
export function readUsageFromStreamEvent(evt: unknown): Partial<MeriTokenUsage> | null {
  if (!evt || typeof evt !== 'object') return null;
  const e = evt as { type?: unknown; message?: { usage?: unknown }; usage?: unknown };

  if (e.type === 'message_start') {
    const usage = e.message?.usage;
    if (!usage || typeof usage !== 'object') return null;
    const u = usage as Record<string, unknown>;
    return {
      inputTokens: numOr0(u.input_tokens),
      outputTokens: numOr0(u.output_tokens),
      cacheReadInputTokens: numOr0(u.cache_read_input_tokens),
      cacheCreationInputTokens: numOr0(u.cache_creation_input_tokens),
    };
  }

  if (e.type === 'message_delta') {
    const usage = e.usage;
    if (!usage || typeof usage !== 'object') return null;
    const u = usage as Record<string, unknown>;
    if (u.output_tokens === undefined) return null;
    return { outputTokens: numOr0(u.output_tokens) };
  }

  return null;
}

/**
 * Fold a per-round usage delta into a running total. `message_delta` output
 * counts are cumulative WITHIN a round (not across rounds), so callers resolve a
 * round to a single `MeriTokenUsage` first, then add it here once per round.
 */
export function addUsage(acc: MeriTokenUsage, delta: Partial<MeriTokenUsage>): void {
  acc.inputTokens += delta.inputTokens ?? 0;
  acc.outputTokens += delta.outputTokens ?? 0;
  acc.cacheReadInputTokens += delta.cacheReadInputTokens ?? 0;
  acc.cacheCreationInputTokens += delta.cacheCreationInputTokens ?? 0;
}

/**
 * Apply a single stream event's usage onto the current round's accumulator.
 * `message_start` sets the input/cache fields (and a baseline output); later
 * `message_delta` events overwrite `outputTokens` with the cumulative count.
 */
export function applyRoundUsageEvent(round: MeriTokenUsage, evt: unknown): void {
  const u = readUsageFromStreamEvent(evt);
  if (!u) return;
  if (u.inputTokens !== undefined) round.inputTokens = u.inputTokens;
  if (u.cacheReadInputTokens !== undefined) round.cacheReadInputTokens = u.cacheReadInputTokens;
  if (u.cacheCreationInputTokens !== undefined)
    round.cacheCreationInputTokens = u.cacheCreationInputTokens;
  if (u.outputTokens !== undefined) round.outputTokens = u.outputTokens;
}

function numOr0(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
