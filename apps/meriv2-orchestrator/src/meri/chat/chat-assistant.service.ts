import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  computeActionFingerprint,
  KeywordIntentRouter,
  wrapToolResultForPrompt,
  type MeriContext,
  type ToolRegistry,
} from '@capiro/meriv2-core';
import { MeriRegistryService } from '../meri-registry.service.js';
import { RequestScopedLlmClient, type AnthropicToolSchema } from '../request-scoped-llm.client.js';
import { RequestCredentialsStore } from '../../request/request-credentials.store.js';
import { ApiComplianceAuditRepo } from '../api-compliance-audit.repo.js';
import {
  buildChatSystemPrompt,
  toolLabel,
  type ChatArtifact,
  type ChatInput,
  type ChatResult,
  type ChatStep,
  type ChatStreamEvent,
} from './chat-prompt.js';

/** Optional streaming hooks: progressive events + caller-driven cancellation. */
export interface ChatRunOptions {
  onEvent?: (event: ChatStreamEvent) => void;
  signal?: AbortSignal;
}

// A complex analyst question ("why was this PE cut, is there report language,
// who do I call, will it survive conference?") legitimately fans out to a dozen+
// tool calls. 8 rounds capped that mid-research; the loop then returned a canned
// "ran out of steps" line and DISCARDED everything it had gathered — the reported
// "Meri never answers" bug. 14 rounds gives real headroom, and on exhaustion we
// now force a synthesis turn (below) instead of throwing the context away.
const MAX_ROUNDS = 14;
// Output budget. 4096 could truncate a thorough strategic answer mid-sentence
// (another flavor of "incomplete"); tool-call rounds rarely emit near this, so
// the extra ceiling only ever helps the prose answer.
const MAX_TOKENS = 8192;
const TOOL_RESULT_CHARS = 12_000;

interface ContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  [k: string]: unknown;
}

/**
 * MeriV2-served full chat surface (Workstream C4). The bounded agentic loop over
 * the ENTIRE tool registry (all read tools + the gated write tools), on the
 * tenant's key (BYOK via the shared RequestScopedLlmClient). Read tools delegate
 * to apps/api; write tools run through the registry's B1-B4 compliance gate —
 * an unapproved write comes back as `pending_approval` (with the fingerprint the
 * surface uses to approve), NOT as a completed action, and the model is told so.
 *
 * SCOPE (v1): stateless per turn — the caller threads `messages[]` (same
 * contract as the in-editor surface). STREAMING (SSE) and server-side
 * conversation-history persistence are deliberate follow-ups: the orchestrator
 * has no SSE transport yet and apps/api exposes no message-append delegation
 * endpoint, so inventing either here would be speculative. This returns a
 * complete result; a streaming transport can wrap the same loop later.
 */
@Injectable()
export class ChatAssistantService {
  private readonly logger = new Logger(ChatAssistantService.name);
  private readonly registry: ToolRegistry;
  private readonly llm: RequestScopedLlmClient;
  private readonly apiBaseUrl: string;
  private readonly callTimeoutMs: number;

  constructor(
    registryService: MeriRegistryService,
    config: ConfigService,
    private readonly audit: ApiComplianceAuditRepo,
  ) {
    this.registry = registryService.registry;
    this.llm = registryService.llm; // single global-key-read site lives in the registry (BYOK4-clean)
    this.callTimeoutMs = Number.parseInt(config.get<string>('MERIV2_TIMEOUT_MS') ?? '120000', 10);
    this.apiBaseUrl = (
      config.get<string>('MERIV2_API_BASE_URL') ?? 'http://localhost:3000'
    ).replace(/\/+$/, '');
  }

  async run(ctx: MeriContext, dto: ChatInput, opts: ChatRunOptions = {}): Promise<ChatResult> {
    const emit = opts.onEvent ?? (() => {});
    const messages: Array<{ role: 'user' | 'assistant'; content: unknown }> = (dto.messages ?? [])
      .filter(
        (m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.text === 'string',
      )
      .slice(-30)
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.text as string }));
    if (!messages.length || messages[messages.length - 1]?.role !== 'user') {
      return { reply: 'What can I help you with?' };
    }

    // Plan-mode routing (deterministic keyword router): classify the last user
    // turn and steer the prompt when a non-default mode matches.
    const lastUserText = String(messages[messages.length - 1]?.content ?? '');
    const intent = new KeywordIntentRouter().classify(lastUserText);
    const system = buildChatSystemPrompt(dto, ctx, intent);
    const toolSchemas = await this.fetchToolSchemas();
    const steps: ChatStep[] = [];
    const pendingApprovals: NonNullable<ChatResult['pendingApprovals']> = [];
    const artifacts: ChatArtifact[] = [];
    // Every exit shares the same aggregates (steps + gate-held writes + produced
    // deliverables), so build the result in one place.
    const finalize = (reply: string): ChatResult => ({
      reply,
      steps,
      ...(pendingApprovals.length ? { pendingApprovals } : {}),
      ...(artifacts.length ? { artifacts } : {}),
    });

    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      if (opts.signal?.aborted) {
        // Caller went away (streaming client disconnect) — stop burning tokens.
        return finalize('');
      }
      let content: ContentBlock[];
      let stopReason: string | null;
      try {
        const resp = await this.llm.completeWithTools({
          system,
          messages,
          tools: toolSchemas as AnthropicToolSchema[],
          maxTokens: MAX_TOKENS,
          timeoutMs: this.callTimeoutMs,
          ...(opts.signal ? { signal: opts.signal } : {}),
        });
        content = resp.content as ContentBlock[];
        stopReason = resp.stopReason;
      } catch (e) {
        if (opts.signal?.aborted) {
          return finalize('');
        }
        this.logger.warn(`chat model call failed: ${(e as Error).message}`);
        return finalize('Sorry — I hit an error reaching the model. Please try again in a moment.');
      }

      const textOut = content
        .filter((b) => b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text as string)
        .join('\n')
        .trim();
      const toolUses = content.filter(
        (b): b is ContentBlock & { id: string; name: string; input?: Record<string, unknown> } =>
          b.type === 'tool_use' && typeof b.name === 'string' && typeof b.id === 'string',
      );

      if (!toolUses.length || stopReason !== 'tool_use') {
        if (textOut) {
          emit({ type: 'text', text: textOut });
          return finalize(textOut);
        }
        // The model ended its turn with no prose (a stray stop / whitespace-only
        // turn). Never ship a bare "Done." — force one tool-free synthesis pass
        // over the context already in `messages`.
        return finalize(
          await this.synthesizeFinalAnswer(system, toolSchemas, messages, emit, opts),
        );
      }

      // Intermediate round text ("Let me look that up…") streams to the client
      // but stays OUT of ChatResult.reply — reply remains the final round's text
      // (the non-streaming contract existing callers/tests pin).
      if (textOut) emit({ type: 'text', text: `${textOut}\n\n` });

      messages.push({ role: 'assistant', content });
      const results = await Promise.all(
        toolUses.map(async (tu) => {
          const result = await this.invokeTool(
            ctx,
            tu.name,
            this.augmentToolInput(dto, tu.input ?? {}),
            steps,
            pendingApprovals,
            artifacts,
            emit,
          );
          return {
            type: 'tool_result' as const,
            tool_use_id: tu.id,
            content: wrapToolResultForPrompt(tu.name, result, TOOL_RESULT_CHARS),
          };
        }),
      );
      messages.push({ role: 'user', content: results });
    }

    // Tool-round budget spent while the model still wanted tools. Do NOT discard
    // the research — force a final tool-free synthesis over everything gathered.
    return finalize(await this.synthesizeFinalAnswer(system, toolSchemas, messages, emit, opts));
  }

  /**
   * Force a final, TOOL-FREE answer from everything gathered so far. Invoked when
   * the tool-round budget is spent (or a turn ended with no prose) so the loop
   * never returns bare "Let me look that up…" narration or a canned "ran out of
   * steps" line while throwing real context away — the reported completion bug.
   * Sends `tool_choice:'none'` with a synthesis directive appended to the system
   * prompt; degrades to a helpful message (never empty) on model error.
   */
  private async synthesizeFinalAnswer(
    system: string,
    toolSchemas: AnthropicToolSchema[],
    messages: Array<{ role: 'user' | 'assistant'; content: unknown }>,
    emit: (event: ChatStreamEvent) => void,
    opts: ChatRunOptions,
  ): Promise<string> {
    if (opts.signal?.aborted) return '';
    const synthesisSystem =
      `${system}\n\n# FINISH NOW — write the answer\n` +
      'You have completed your research and must NOT call any more tools. Using ' +
      'everything gathered in the conversation above, write your complete final ' +
      "answer now. Address every part of the user's question directly and in " +
      'order; cite the specific data you retrieved (figures, bill numbers, names, ' +
      'report language). Where the data is incomplete, state what you found and ' +
      'flag what remains uncertain rather than guessing or leaving it unfinished.';
    try {
      const resp = await this.llm.completeWithTools({
        system: synthesisSystem,
        messages,
        tools: toolSchemas as AnthropicToolSchema[],
        toolChoice: 'none',
        maxTokens: MAX_TOKENS,
        timeoutMs: this.callTimeoutMs,
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
      const text = (resp.content as ContentBlock[])
        .filter((b) => b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text as string)
        .join('\n')
        .trim();
      if (text) emit({ type: 'text', text });
      return (
        text || 'I gathered the context but could not compose a final answer — please ask again.'
      );
    } catch (e) {
      if (opts.signal?.aborted) return '';
      this.logger.warn(`chat synthesis call failed: ${(e as Error).message}`);
      return 'I gathered a lot of context but hit an error composing the final answer — please ask again.';
    }
  }

  /**
   * Thread the conversation context the model never sees into a tool input —
   * mirroring the legacy loop (apps/api MeriService): default clientId from the
   * conversation focus, and ALWAYS supply the active conversationId. The
   * artifact-producing write tools (create_word / create_excel /
   * create_powerpoint, create_meeting_brief, draft_policy_memo) REQUIRE
   * conversationId to persist their ClioArtifact row — without it apps/api returns
   * { persisted: false }, the generated Office document is dropped, and no
   * download URL comes back. Only fills a field the model left unset; apps/api
   * re-validates and ignores fields a tool does not use.
   */
  private augmentToolInput(
    dto: ChatInput,
    input: Record<string, unknown>,
  ): Record<string, unknown> {
    const out = { ...input };
    if (dto.clientId && out.clientId === undefined) out.clientId = dto.clientId;
    if (dto.conversationId && out.conversationId === undefined) {
      out.conversationId = dto.conversationId;
    }
    return out;
  }

  /**
   * Run one tool through the registry (scoping + write gate enforced). A gated
   * write throws ApprovalPendingError / ComplianceBlockedError — caught here and
   * turned into a `pending_approval` / `blocked` step + a tool_result the model
   * reads, so it tells the user the action awaits approval instead of claiming
   * it ran. The fingerprint (recomputed with the same pure function the gate
   * used) is surfaced so the client can approve, then re-run.
   */
  private async invokeTool(
    ctx: MeriContext,
    name: string,
    input: Record<string, unknown>,
    steps: ChatStep[],
    pendingApprovals: NonNullable<ChatResult['pendingApprovals']>,
    artifacts: ChatArtifact[],
    emit: (event: ChatStreamEvent) => void = () => {},
  ): Promise<unknown> {
    const label = toolLabel(name);
    // Only write tools (readOnly:false) pass through the compliance gate, so
    // only they produce an auditable decision.
    const isWrite = this.registry.get(name)?.readOnly === false;
    emit({ type: 'tool_call', tool: name, label });
    try {
      const result = await this.registry.invoke(name, input, ctx);
      steps.push({ tool: name, label, status: 'done' });
      emit({ type: 'tool_done', tool: name, label, status: 'done' });
      // Surface any deliverable the tool produced + persisted (a generated
      // document, meeting brief, or policy memo) so the client can render a
      // download / canvas card — the apps/api proxy maps this to the legacy
      // ChatDrawer `artifact` frame. A tool that could not persist (no
      // conversation context) returns { persisted: false } and is skipped.
      for (const art of extractChatArtifacts(result)) {
        artifacts.push(art);
        emit({ type: 'artifact', artifact: art });
      }
      // A write tool that resolved passed the gate (PASS or an approved WARN).
      if (isWrite) {
        this.audit.record({
          trigger: name,
          decision: 'PASS',
          reason: 'Passed the compliance gate.',
        });
      }
      return result;
    } catch (e) {
      const err = e as Error;
      if (err.name === 'ApprovalPendingError') {
        const fingerprint = computeActionFingerprint(name, input, ctx);
        steps.push({ tool: name, label, status: 'pending_approval' });
        pendingApprovals.push({ tool: name, fingerprint, reason: err.message });
        emit({ type: 'tool_done', tool: name, label, status: 'pending_approval' });
        emit({ type: 'pending_approval', tool: name, label, fingerprint, reason: err.message });
        this.audit.record({ trigger: name, decision: 'WARN', reason: err.message });
        return {
          pendingApproval: true,
          fingerprint,
          message: `This action needs the user's approval before it runs: ${err.message}`,
        };
      }
      if (err.name === 'ComplianceBlockedError') {
        const detail = err.message.slice(0, 120);
        steps.push({ tool: name, label, status: 'blocked', detail });
        emit({ type: 'tool_done', tool: name, label, status: 'blocked', detail });
        this.audit.record({ trigger: name, decision: 'BLOCK', reason: err.message });
        return { blocked: true, message: `Blocked by compliance policy: ${err.message}` };
      }
      const detail = err.message.slice(0, 120);
      steps.push({ tool: name, label, status: 'error', detail });
      emit({ type: 'tool_done', tool: name, label, status: 'error', detail });
      return { error: err.message };
    }
  }

  /**
   * Fetch the Anthropic tool schemas from apps/api (single source) with the
   * caller's bearer — the FULL set (chat may use any registered tool). Filtered
   * to what the registry actually knows so a schema for an unregistered tool
   * can't be offered. On failure, degrade to no data tools (still answers).
   */
  private async fetchToolSchemas(): Promise<AnthropicToolSchema[]> {
    const bearer = RequestCredentialsStore.get()?.bearerToken;
    if (!bearer) {
      this.logger.warn('chat: no bearer to fetch tool schemas; proceeding without data tools');
      return [];
    }
    try {
      const res = await fetch(`${this.apiBaseUrl}/api/clio/tool-schemas`, {
        headers: { authorization: `Bearer ${bearer}`, accept: 'application/json' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { schemas?: AnthropicToolSchema[] };
      const known = new Set(this.registry.list());
      return (body.schemas ?? []).filter((s) => known.has(s.name));
    } catch (e) {
      this.logger.warn(`chat: tool-schema fetch failed (${(e as Error).message})`);
      return [];
    }
  }
}

/**
 * Pull persisted deliverables out of a tool result. The artifact-producing Meri
 * tools return either `{ artifact: {...} }` (create_word/excel/powerpoint,
 * create_meeting_brief, draft_policy_memo) or `{ artifacts: [...] }`; the
 * persisted row carries an `id`, and the document tools add top-level
 * `downloadUrl` / `filename` / `mimeType`. A tool that could not persist returns
 * the row as `{ persisted: false }` (no id) — skipped so we never surface a card
 * for a document that was silently dropped. Same contract apps/api's
 * extractToolArtifacts reads.
 */
function extractChatArtifacts(result: unknown): ChatArtifact[] {
  if (!result || typeof result !== 'object') return [];
  const r = result as Record<string, unknown>;
  const candidates: unknown[] = [];
  if (r.artifact) candidates.push(r.artifact);
  if (Array.isArray(r.artifacts)) candidates.push(...r.artifacts);
  const out: ChatArtifact[] = [];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;
    const a = candidate as Record<string, unknown>;
    if (a.persisted === false) continue;
    const id = typeof a.id === 'string' ? a.id : null;
    if (!id) continue;
    const title =
      typeof a.title === 'string' && a.title.trim()
        ? a.title.trim()
        : typeof r.title === 'string' && r.title.trim()
          ? (r.title as string).trim()
          : 'Meri deliverable';
    const kind = typeof a.kind === 'string' && a.kind.trim() ? a.kind.trim() : 'document';
    const art: ChatArtifact = { id, title, kind };
    if (typeof a.bodyText === 'string') art.bodyText = a.bodyText;
    if (typeof r.downloadUrl === 'string') art.downloadUrl = r.downloadUrl;
    if (typeof r.filename === 'string') art.filename = r.filename;
    if (typeof r.mimeType === 'string') art.mimeType = r.mimeType;
    out.push(art);
  }
  return out;
}
