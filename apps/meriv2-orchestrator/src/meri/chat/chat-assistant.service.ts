import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import {
  KeywordIntentRouter,
  wrapToolResultForPrompt,
  runAuditor,
  ledgerToToolResultMap,
  type LedgerEntry,
  type AuditorMode,
  type MeriContext,
  type ToolRegistry,
} from '@capiro/meriv2-core';
import {
  recordAiUsageEvent,
  extractCitationsFromToolResult,
  formatCitationsForPrompt,
  validateCitationMarkers,
  validateFormBCitations,
  type MeriCitation,
} from '@capiro/shared';
import { MeriRegistryService } from '../meri-registry.service.js';
import {
  RequestScopedLlmClient,
  type AnthropicToolSchema,
  type ToolLoopResponse,
} from '../request-scoped-llm.client.js';
import { RequestCredentialsStore } from '../../request/request-credentials.store.js';
import { ApiComplianceAuditRepo } from '../api-compliance-audit.repo.js';
import { ApiActionProposalRepo } from '../api-action-proposal.repo.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  composeChatSystemPrompt,
  toolLabel,
  type ChatArtifact,
  type ChatInput,
  type ChatResult,
  type ChatStep,
  type ChatStreamEvent,
} from './chat-prompt.js';
import { flattenSystemParts } from '../prompt-cache.helpers.js';

/** Optional streaming hooks: progressive events + caller-driven cancellation. */
export interface ChatRunOptions {
  onEvent?: (event: ChatStreamEvent) => void;
  signal?: AbortSignal;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Is this value a real client id rather than a display name the model guessed?
 * The distinction is what lets a multi-client turn address several clients
 * while still repairing the "sent 'RADD' where a UUID goes" mistake.
 */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
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

// Page-write mode (2.1): the draft tools whose body is applied to the open page.
// Mirrors the legacy loop (apps/api meri.service.ts), which captures the
// page-write payload only from these two draft producers.
const PAGE_WRITE_DRAFT_TOOLS = new Set(['draft_policy_memo', 'create_meeting_brief']);

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
 * to apps/api; write tools run through the registry's compliance gate — an
 * unapproved write comes back as `pending_approval` (carrying the durable,
 * server-created proposalId the surface approves by ID only), NOT as a
 * completed action, and the model is told so.
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
    private readonly prisma: PrismaService,
    private readonly actionProposals: ApiActionProposalRepo,
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
    // turn and steer the prompt when a non-default mode matches. Capture the text
    // BEFORE any vision rewrite below turns the content into a block array.
    const lastUserText = String(messages[messages.length - 1]?.content ?? '');
    const intent = new KeywordIntentRouter().classify(lastUserText);

    // Vision (2.2): attach current-turn images as native Anthropic vision blocks
    // on the last user message — images first, then the text (legacy parity, the
    // apps/api loop does the same). completeWithTools carries the content array
    // verbatim to Anthropic; the OpenAI adapter fails loud on image content.
    const turnImages = dto.currentTurnImages ?? [];
    if (turnImages.length) {
      const last = messages[messages.length - 1];
      if (last && last.role === 'user' && typeof last.content === 'string') {
        last.content = [
          ...turnImages.map((img) => ({
            type: 'image',
            source: { type: 'base64', media_type: img.mediaType, data: img.dataBase64 },
          })),
          { type: 'text', text: last.content },
        ];
      }
    }
    // Prompt caching (P0-1 orchestrator parity): `systemParts` (the {base,
    // dynamic} split) is what every round of THIS turn's tool loop sends —
    // request-scoped-llm.client.ts places the cache breakpoint on `base`, so
    // round 2..N of this turn (and turn 2..N of this conversation, within the
    // ~5-minute cache TTL) reuse that prefix. `system` (the flat string) is
    // kept only for the one-off "FINISH NOW" synthesis retry below, which is
    // never repeated and so never benefits from a breakpoint.
    const systemParts = composeChatSystemPrompt(dto, ctx, intent);
    const system = flattenSystemParts(systemParts);
    const toolSchemas = await this.fetchToolSchemas();
    const steps: ChatStep[] = [];
    const pendingApprovals: NonNullable<ChatResult['pendingApprovals']> = [];
    const artifacts: ChatArtifact[] = [];
    // Wave-2 post-hoc auditor ledger for the GA chat surface (the DEFAULT chat
    // path — most traffic). Accumulated across tool rounds; audited at finalize.
    const ledgerEntries: LedgerEntry[] = [];
    // Inline citations (1B.5): numbered sources accumulated across tool rounds;
    // injected into each tool_result the model reads, then validated against the
    // final reply so only real [N] markers survive.
    const citations: MeriCitation[] = [];
    // Every exit shares the same aggregates (steps + gate-held writes + produced
    // deliverables), so build the result in one place. finalize also fires the
    // shadow auditor (fire-and-forget, like meterRound) so every exit is covered.
    // Aggregate token usage across every tool-loop round (1A.2) — one row per
    // round is metered separately (meterRound); this is the turn total the
    // proxy surfaces as a `usage` frame + persists.
    const usageAcc = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    };
    // Page-write mode (2.1): the last draft body produced this turn, applied to
    // the open page. Mirrors legacy (last draft wins); emitted once at finalize.
    let pageWritePayload: { subject: string; body: string } | null = null;
    const finalize = (reply: string): ChatResult => {
      // Validate [N] markers against the sources we injected: keep only real
      // ones, strip hallucinated ones from the prose, and report the citations
      // actually used (1B.5). Audit the CLEANED reply.
      const { used, cleanedText: formACleaned } = validateCitationMarkers(reply, citations);
      // Same idea for FORM B [S:tool_name:record_id] tokens (legacy chat parity —
      // meri.service.ts strips these before persistence too): a token whose tool
      // wasn't called this turn, or whose record_id isn't verbatim in that tool's
      // result, gets stripped so it can't lend false authority to a fabricated
      // claim in the persisted history. Does not affect text already streamed to
      // the client this turn (chat stays observe-only per ADR-2, same as the
      // post-hoc auditor below).
      const formB = validateFormBCitations(formACleaned, ledgerToToolResultMap(ledgerEntries));
      if (formB.invalid.length) {
        this.logger.warn(
          `Meri dropped ${formB.invalid.length} unresolved FORM B citation(s) from persisted history: ${formB.invalid.join(', ')}`,
        );
      }
      const cleanedText = formB.sanitizedText;
      // Post-hoc auditor. runAuditor is synchronous/deterministic, so we run it
      // INLINE (negligible latency) to surface a non-blocking caveat under
      // enforce/annotate — chat can't hold an already-streamed reply (ADR-2), so
      // HIGH/CRITICAL grounding findings become a visible caveat frame instead.
      // The DB persist stays fire-and-forget (no added latency).
      const audit = this.auditChatReply(cleanedText, ledgerEntries);
      if (audit && audit.verdict.findings.length > 0) {
        if (audit.mode === 'enforce' || audit.mode === 'annotate') {
          const severe = audit.verdict.findings.filter(
            (f) => f.severity === 'high' || f.severity === 'critical',
          );
          if (severe.length > 0) {
            emit({
              type: 'grounding_caveat',
              topSeverity: audit.verdict.topSeverity ?? null,
              findings: severe.map((f) => ({
                check: f.check,
                severity: f.severity,
                detail: f.detail,
              })),
            });
          }
        }
        void this.persistChatAudit(ctx.tenantId, audit.mode, audit.verdict, cleanedText);
      }
      // Page-write mode: apply the produced draft to the open page (one frame,
      // last draft wins — legacy parity). Only when the caller opted in and a
      // draft actually produced a body.
      if (dto.pageWrite && pageWritePayload) {
        emit({
          type: 'page_write',
          target: 'outreach_draft',
          subject: pageWritePayload.subject,
          body: pageWritePayload.body,
        });
      }
      return {
        reply: cleanedText,
        intent: intent.mode,
        usage: { ...usageAcc },
        steps,
        ...(used.length ? { citations: used } : {}),
        ...(pendingApprovals.length ? { pendingApprovals } : {}),
        ...(artifacts.length ? { artifacts } : {}),
      };
    };

    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      if (opts.signal?.aborted) {
        // Caller went away (streaming client disconnect) — stop burning tokens.
        return finalize('');
      }
      let content: ContentBlock[];
      let stopReason: string | null;
      // Token-level streaming (2.4): stream text deltas straight to the client so
      // chat types token-by-token instead of in per-round bursts. `streamed`
      // tells us the text already went out — don't re-emit it below.
      let streamed = false;
      try {
        const resp = await this.llm.completeWithTools({
          system: systemParts,
          messages,
          tools: toolSchemas as AnthropicToolSchema[],
          maxTokens: MAX_TOKENS,
          timeoutMs: this.callTimeoutMs,
          onTextDelta: (delta) => emit({ type: 'text', text: delta }),
          ...(opts.signal ? { signal: opts.signal } : {}),
        });
        void this.meterRound(ctx, resp);
        usageAcc.inputTokens += resp.usage.inputTokens;
        usageAcc.outputTokens += resp.usage.outputTokens;
        usageAcc.cacheReadTokens += resp.usage.cacheReadTokens ?? 0;
        usageAcc.cacheCreationTokens += resp.usage.cacheCreationTokens ?? 0;
        content = resp.content as ContentBlock[];
        stopReason = resp.stopReason;
        streamed = resp.streamed ?? false;
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
          // When streamed, the deltas already went out this round — don't double-emit.
          if (!streamed) emit({ type: 'text', text: textOut });
          return finalize(textOut);
        }
        // The model ended its turn with no prose (a stray stop / whitespace-only
        // turn). Never ship a bare "Done." — force one tool-free synthesis pass
        // over the context already in `messages`.
        return finalize(
          await this.synthesizeFinalAnswer(ctx, system, toolSchemas, messages, emit, opts),
        );
      }

      // Intermediate round text ("Let me look that up…") streams to the client
      // but stays OUT of ChatResult.reply — reply remains the final round's text
      // (the non-streaming contract existing callers/tests pin). When streamed,
      // the deltas already went out; just add the round separator.
      if (textOut) {
        emit({ type: 'text', text: streamed ? '\n\n' : `${textOut}\n\n` });
      }

      messages.push({ role: 'assistant', content });
      // Invoke tools in PARALLEL, then number/serialize SEQUENTIALLY — citation
      // marker numbers must be deterministic (a shared counter inside the
      // parallel map would race). Citations extracted per tool result get a
      // stable 1-based [N]; the numbered sources are injected into the
      // tool_result the model reads so it cites the exact [N] we assigned (1B.5).
      const invoked = await Promise.all(
        toolUses.map(async (tu) => ({
          tu,
          result: await this.invokeTool(
            ctx,
            tu.name,
            this.augmentToolInput(dto, tu.input ?? {}),
            dto.conversationId,
            steps,
            pendingApprovals,
            artifacts,
            emit,
          ),
        })),
      );
      // Page-write mode: capture the body of any draft a draft tool produced this
      // round so finalize can apply it to the open page (last draft wins, legacy
      // parity). The `artifact` event already surfaced the same deliverable.
      if (dto.pageWrite) {
        for (const { tu, result } of invoked) {
          if (!PAGE_WRITE_DRAFT_TOOLS.has(tu.name)) continue;
          const draft = extractChatArtifacts(result).find((a) => a.bodyText);
          if (draft?.bodyText) pageWritePayload = { subject: draft.title, body: draft.bodyText };
        }
      }
      const results = invoked.map(({ tu, result }) => {
        const cites = extractCitationsFromToolResult(tu.name, result, citations.length + 1);
        citations.push(...cites);
        const body = wrapToolResultForPrompt(tu.name, result, TOOL_RESULT_CHARS);
        const serialized = cites.length ? `${formatCitationsForPrompt(cites)}\n\n${body}` : body;
        ledgerEntries.push({ tool: tu.name, serialized, result });
        return { type: 'tool_result' as const, tool_use_id: tu.id, content: serialized };
      });
      messages.push({ role: 'user', content: results });
    }

    // Tool-round budget spent while the model still wanted tools. Do NOT discard
    // the research — force a final tool-free synthesis over everything gathered.
    return finalize(
      await this.synthesizeFinalAnswer(ctx, system, toolSchemas, messages, emit, opts),
    );
  }

  /**
   * Best-effort metering for one `completeWithTools` round (Phase 1 M5.0, H-1) —
   * one `ai_usage_events` row per round (each round is its own Anthropic API
   * call). `recordAiUsageEvent` never throws (it swallows + logs its own
   * failures), so this is fire-and-forget from the caller's perspective.
   */
  private async meterRound(ctx: MeriContext, resp: ToolLoopResponse): Promise<void> {
    await recordAiUsageEvent(
      { prisma: this.prisma, logger: this.logger },
      { tenantId: ctx.tenantId, userId: ctx.userId },
      'meriv2_chat',
      {
        provider: 'anthropic',
        model: resp.model,
        usage: resp.usage,
        usedTenantKey: resp.usedTenantKey,
      },
    );
  }

  /**
   * Wave-2 post-hoc auditor on the GA chat surface (default/highest-traffic).
   * SYNCHRONOUS + deterministic (MERI_AUDITOR_MODE off = no-op): re-derives ground
   * truth from the turn's tool-result ledger and returns any contradiction
   * (reversed direction, failed-rule-as-operative, LI-as-PE, unresolved citation).
   * Run inline so the caller can surface a non-blocking caveat under enforce/
   * annotate — chat can't withhold an already-streamed reply (ADR-2), so real
   * enforcement (hold-as-draft) stays on the DELIVERABLE surfaces (outreach/
   * alert-memo/research). Fully guarded — an auditor error never affects the reply.
   */
  private auditChatReply(
    reply: string,
    ledgerEntries: LedgerEntry[],
  ): { mode: AuditorMode; verdict: ReturnType<typeof runAuditor> } | null {
    const mode = (process.env.MERI_AUDITOR_MODE as AuditorMode | undefined) ?? 'off';
    if (mode === 'off' || !reply || reply.trim().length === 0) return null;
    try {
      const verdict = runAuditor({
        output: reply,
        ledger: { entries: ledgerEntries },
        surface: 'chat',
        mode,
      });
      return { mode, verdict };
    } catch (err) {
      this.logger.warn(
        `[meri-auditor] GA chat audit failed (reply unaffected): ${(err as Error).message}`,
      );
      return null;
    }
  }

  /**
   * Persist a chat auditor verdict to meri_audit_ledger — fire-and-forget from the
   * caller (like meterRound), so the DB write never adds latency to the reply. The
   * orchestrator shares apps/api's generated Prisma client + DB, so this is the
   * SAME table the other 4 surfaces write to.
   */
  private async persistChatAudit(
    tenantId: string,
    mode: AuditorMode,
    verdict: ReturnType<typeof runAuditor>,
    reply: string,
  ): Promise<void> {
    try {
      this.logger.warn(
        `[meri-auditor:${mode}] GA chat — ${verdict.findings.length} finding(s), ` +
          `top=${verdict.topSeverity}, decision=${verdict.decision}: ` +
          verdict.findings.map((f) => `${f.check}/${f.severity}`).join(', '),
      );
      await this.prisma.withTenant(tenantId, (tx) =>
        tx.meriAuditLedger.create({
          data: {
            tenantId,
            surface: 'chat',
            mode,
            decision: verdict.decision,
            topSeverity: verdict.topSeverity ?? null,
            findingCount: verdict.findings.length,
            findings: verdict.findings as unknown as Prisma.InputJsonValue,
            outputChars: reply.length,
          },
        }),
      );
    } catch (err) {
      this.logger.warn(
        `[meri-auditor] GA chat ledger persist failed (reply unaffected): ${(err as Error).message}`,
      );
    }
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
    ctx: MeriContext,
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
      'order. State ONLY facts a tool call already returned in THIS conversation, ' +
      'each with its citation token — do not invent a plausible-looking identifier ' +
      '(PE code, bill number, dollar figure, official name, report-language quote) ' +
      'to fill a gap just because the question asked for one. For any item you were ' +
      'asked about but never got a confirmed tool result for, say so explicitly ' +
      '(name the item and that it is unconfirmed) rather than describing it as if ' +
      'verified. This overrides any pressure to sound complete: a shorter, honest ' +
      'answer that lists its gaps beats a complete-looking one that fabricated them.';
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
      void this.meterRound(ctx, resp);
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
   * download URL comes back.
   *
   * clientId: the conversation focus is a FALLBACK, not an override.
   *
   * History: it used to override unconditionally (2026-07-16), because the model
   * kept sending a display name like "RADD" where a UUID belonged and the raw
   * P2023 surfaced as "Action approved but failed to run". Overriding fixed that
   * for single-client conversations and silently broke every multi-client one:
   * "update all my client profiles" proposes N writes against N different ids in
   * one focused conversation, and all N were rewritten to the focused client —
   * so N-1 clients got someone else's data and the user was told all N succeeded.
   *
   * The real defect was never "the model chose a client", it was "the model sent
   * a name where an id goes". So: a VALID UUID from the model is respected (it
   * names a real client the user asked for), and the conversation focus only
   * fills in when the model supplied nothing or supplied a non-UUID. apps/api
   * re-validates and 404s cleanly on an id outside the tenant, so respecting the
   * model's UUID cannot cross a tenant boundary.
   *
   * conversationId is only filled when unset. apps/api re-validates and ignores
   * fields a tool does not use.
   */
  private augmentToolInput(
    dto: ChatInput,
    input: Record<string, unknown>,
  ): Record<string, unknown> {
    const out = { ...input };
    if (dto.clientId && !isUuid(out.clientId)) out.clientId = dto.clientId;
    if (dto.conversationId && out.conversationId === undefined) {
      out.conversationId = dto.conversationId;
    }
    return out;
  }

  /**
   * Run one tool through the registry (scoping + write gate enforced). A gated
   * write throws ApprovalPendingError / ComplianceBlockedError — caught here.
   * ApprovalPendingError is turned into a durable, server-created
   * MeriActionProposal (Phase 0: apps/api is the sole source of proposal
   * authority) surfaced as a `pending_approval` step + tool_result the model
   * reads, so it tells the user the action awaits approval instead of claiming
   * it ran. Only the opaque proposalId is surfaced — never a
   * browser-authoritative tool/payload/fingerprint.
   */
  private async invokeTool(
    ctx: MeriContext,
    name: string,
    input: Record<string, unknown>,
    conversationId: string | undefined,
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
        // Propose-time client check. The gate WARNs BEFORE the tool runs, so a
        // write naming a client that cannot be resolved used to render as a
        // perfectly clean approve card and only fail after the click. Three
        // profile fills were once proposed for clients whose create_client had
        // never been approved; every card looked fine. Say so on the card.
        const blocker = await this.describeClientBlocker(input);

        let proposal: Awaited<ReturnType<ApiActionProposalRepo['create']>>;
        try {
          proposal = await this.actionProposals.create({
            tool: name,
            input,
            ...(conversationId ? { conversationId } : {}),
            surface: 'chat',
          });
        } catch (createErr) {
          // Persistence failed — never fabricate a usable approval card. The
          // model must be told plainly that nothing was proposed or queued, so
          // it can never claim otherwise (a browser card requires a durable
          // proposalId that does not exist here).
          const detail = (createErr as Error).message.slice(0, 160);
          steps.push({ tool: name, label, status: 'error', detail });
          emit({ type: 'tool_done', tool: name, label, status: 'error', detail });
          return {
            error: true,
            message:
              'This action could not be proposed due to a system error. Tell the user it was NOT submitted, queued, or scheduled, and that they should try again.',
          };
        }

        const reason = blocker ? `${proposal.reason} — ${blocker}` : proposal.reason;
        steps.push({ tool: name, label, status: 'pending_approval' });
        pendingApprovals.push({
          tool: name,
          proposalId: proposal.proposalId,
          reason,
          status: proposal.status,
        });
        emit({ type: 'tool_done', tool: name, label, status: 'pending_approval' });
        emit({
          type: 'pending_approval',
          tool: name,
          label,
          proposalId: proposal.proposalId,
          status: proposal.status,
          reason,
          expiresAt: proposal.expiresAt,
          riskTier: proposal.riskTier,
          policyCode: proposal.policyCode,
          preview: proposal.preview,
        });
        // Compliance audit for this WARN decision is already durably recorded
        // by apps/api INSIDE the same transaction as proposal creation
        // (MeriActionProposalService.create -> recordDecision) — recording it
        // again here would just duplicate the row.
        if (blocker) {
          // Also hand it to the model as tool output, so its prose matches the
          // card instead of promising a fill that provably cannot happen.
          return {
            pendingApproval: true,
            proposalId: proposal.proposalId,
            willFail: true,
            message: `This action needs the user's approval, and as proposed it will FAIL: ${blocker}. Tell the user plainly and fix the reference (or create the client first) rather than repeating the same proposal.`,
          };
        }
        return {
          pendingApproval: true,
          proposalId: proposal.proposalId,
          message: `This action needs the user's approval before it runs: ${proposal.reason}`,
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
   * If a held write names a client, can that client actually be written to?
   *
   * Returns a human-readable blocker, or null when the reference resolves (or
   * when we simply could not check). FAIL-OPEN by design: this is advisory
   * copy on an approve card, so a slow or unreachable apps/api must never
   * degrade the turn or, worse, mark a perfectly good action as doomed.
   */
  private async describeClientBlocker(input: Record<string, unknown>): Promise<string | null> {
    const ref = input.clientId;
    if (typeof ref !== 'string' || !ref.trim()) return null;
    const bearer = RequestCredentialsStore.get()?.bearerToken;
    if (!bearer) return null;
    const impersonateTenantId = RequestCredentialsStore.get()?.impersonateTenantId;
    try {
      const res = await fetch(`${this.apiBaseUrl}/api/clio/clients/check-ref`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${bearer}`,
          'content-type': 'application/json',
          accept: 'application/json',
          ...(impersonateTenantId ? { 'x-capiro-impersonate-tenant': impersonateTenantId } : {}),
        },
        body: JSON.stringify({ ref }),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { ok?: boolean; reason?: string };
      if (body.ok === false && typeof body.reason === 'string') return body.reason;
      return null;
    } catch {
      return null;
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
