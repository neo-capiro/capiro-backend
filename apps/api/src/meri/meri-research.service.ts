import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import { validateFormBCitations } from '@capiro/shared';
import { runAuditor, ledgerToToolResultMap, type LedgerEntry } from '@capiro/meriv2-core';
import { resolveTenantAuditorMode } from '../common/auditor-mode.js';
import type { AppConfig } from '../config/config.schema.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { MeriToolsService } from './meri-tools.service.js';
import { AiCredentialResolverService } from '../engagement/ai-credential-resolver.service.js';
import { ReviewsService } from '../reviews/reviews.service.js';
import { DELIVERABLE_RISK_TIERS } from '@capiro/shared';
import {
  assembleReportArtifact,
  buildPlanSystemPrompt,
  buildPlanUserPrompt,
  buildResearchSystemPrompt,
  buildResearchUserPrompt,
  clampTitle,
  humanToolLabel,
  parsePlanProposal,
  summarizeJsonForPrompt,
  summarizeToolResultForTrust,
  type PlanProposal,
} from './meri-research.helpers.js';
import {
  applyThinkingStreamEvent,
  createThinkingState,
  thinkingReplayBlocks,
  thinkingRequestParams,
  type ThinkingSettings,
} from './meri-thinking.helpers.js';

const PRODUCT_NAME = 'Meri';

interface SourceAttribution {
  tool: string;
  label: string;
  count?: number | null;
  summary: string;
  confidence: 'low' | 'high';
}

interface SseSink {
  write: (data: string) => void;
}

/**
 * MeriResearchService — the "Deep Research" brain.
 *
 * A lobbyist starts a session with a topic. Meri:
 *   1. PLAN: proposes a research plan + clarifying questions (one model call).
 *   2. CLARIFY: the user answers (no model call; persisted via answerClarifications).
 *   3. GATHER + 4. SYNTHESIZE: an agentic Anthropic-native streaming tool loop
 *      across all 22 internal Meri tools + web, then a long, cited report.
 *
 * The final report is persisted as a ClioArtifact (kind = 'research_report') and
 * linked back to the session. Mirrors the drawer's streaming tool-use loop in
 * meri.service.ts so behavior is consistent (SSE block parsing, record-boundary
 * -safe tool-result feedback, in-process tool execution).
 */
@Injectable()
export class MeriResearchService {
  private readonly logger = new Logger(MeriResearchService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppConfig, true>,
    private readonly tools: MeriToolsService,
    private readonly aiCredentials: AiCredentialResolverService,
    private readonly reviews: ReviewsService,
  ) {}

  // ── Session CRUD ─────────────────────────────────────────────────────────

  async listSessions(ctx: TenantContext) {
    return this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.clioResearchSession.findMany({
        where: { tenantId: ctx.tenantId, userId: ctx.userId },
        orderBy: { updatedAt: 'desc' },
        take: 50,
        select: {
          id: true,
          title: true,
          topic: true,
          status: true,
          clientId: true,
          reportArtifactId: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
    );
  }

  async getSession(ctx: TenantContext, id: string) {
    const session = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.clioResearchSession.findFirst({
        where: { id, tenantId: ctx.tenantId, userId: ctx.userId },
      }),
    );
    if (!session) throw new NotFoundException('Research session not found');

    // Attach the report artifact body when complete.
    let report: { id: string; title: string; bodyText: string | null } | null = null;
    if (session.reportArtifactId) {
      report = await this.prisma.withTenant(ctx.tenantId, (tx) =>
        tx.clioArtifact.findFirst({
          where: { id: session.reportArtifactId ?? undefined, tenantId: ctx.tenantId },
          select: { id: true, title: true, bodyText: true },
        }),
      );
    }
    return { ...session, report };
  }

  async createSession(
    ctx: TenantContext,
    input: { topic: string; clientId?: string | null; title?: string },
  ) {
    const topic = (input.topic ?? '').trim();
    if (!topic) throw new BadRequestException('A research topic is required');

    return this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.clioResearchSession.create({
        data: {
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          clientId: input.clientId ?? null,
          title: clampTitle(input.title?.trim() || topic),
          topic,
          status: 'plan',
        },
        select: {
          id: true,
          title: true,
          topic: true,
          status: true,
          clientId: true,
          createdAt: true,
        },
      }),
    );
  }

  async deleteSession(ctx: TenantContext, id: string) {
    await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.clioResearchSession.deleteMany({
        where: { id, tenantId: ctx.tenantId, userId: ctx.userId },
      }),
    );
    return { ok: true };
  }

  /**
   * Fetch the completed report's markdown for a session (for export). Throws if
   * the session has no report yet.
   */
  async getReportMarkdown(
    ctx: TenantContext,
    id: string,
  ): Promise<{ title: string; markdown: string }> {
    const session = await this.ensureSession(ctx, id);
    if (!session.reportArtifactId) {
      throw new BadRequestException('This research session has no report yet');
    }
    const artifact = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.clioArtifact.findFirst({
        where: { id: session.reportArtifactId ?? undefined, tenantId: ctx.tenantId },
        select: { title: true, bodyText: true },
      }),
    );
    if (!artifact) throw new NotFoundException('Report artifact not found');
    return { title: artifact.title, markdown: artifact.bodyText ?? '' };
  }

  /** Persist the lobbyist's answers to the clarifying questions. */
  async answerClarifications(ctx: TenantContext, id: string, answers: Record<string, string>) {
    const session = await this.ensureSession(ctx, id);
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(answers ?? {})) {
      if (typeof v === 'string' && v.trim()) clean[String(k)] = v.trim();
    }
    await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.clioResearchSession.update({
        where: { id: session.id },
        data: {
          clarifyingAnswers: clean as Prisma.InputJsonValue,
          status: 'researching',
          updatedAt: new Date(),
        },
      }),
    );
    return { ok: true };
  }

  // ── Phase 1: PLAN (streamed) ───────────────────────────────────────────────

  /**
   * Stream the PLAN phase: one model call that returns a plan + clarifying
   * questions. Persists them on the session and emits a `clarify` SSE event the
   * UI renders as an answer form.
   */
  async streamPlan(ctx: TenantContext, id: string, sse: SseSink) {
    const session = await this.ensureSession(ctx, id);
    sse.write(sseEvent({ type: 'phase', phase: 'plan' }));

    const clientContext = await this.clientContext(ctx, session.clientId);
    const system = buildPlanSystemPrompt(PRODUCT_NAME);
    const user = buildPlanUserPrompt(session.topic, clientContext);

    let proposal: PlanProposal;
    try {
      const raw = await this.anthropicComplete(ctx.tenantId, system, user);
      proposal = parsePlanProposal(raw, session.topic);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Planning failed';
      this.logger.warn(`Research plan failed: ${msg}`);
      // Fall back to a safe deterministic plan so the lobbyist is never stuck.
      proposal = parsePlanProposal('', session.topic);
    }

    await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.clioResearchSession.update({
        where: { id: session.id },
        data: {
          title: clampTitle(proposal.title),
          plan: proposal.plan as Prisma.InputJsonValue,
          clarifyingQuestions: proposal.clarifyingQuestions as Prisma.InputJsonValue,
          status: 'awaiting_clarification',
          updatedAt: new Date(),
        },
      }),
    );

    sse.write(sseEvent({ type: 'title', title: proposal.title }));
    sse.write(sseEvent({ type: 'plan', plan: proposal.plan }));
    sse.write(sseEvent({ type: 'clarify', questions: proposal.clarifyingQuestions }));
    sse.write(sseEvent({ type: 'done' }));
  }

  // ── Phases 3+4: GATHER + SYNTHESIZE (streamed) ──────────────────────────────

  /**
   * Stream the agentic research run: multi-round Anthropic tool loop over all 22
   * internal tools + web, then the synthesized report. Persists the report as a
   * ClioArtifact and links it to the session.
   */
  async streamResearch(ctx: TenantContext, id: string, sse: SseSink) {
    const session = await this.ensureSession(ctx, id);

    const plan = asStringArray(session.plan);
    const clarifyingQuestions = asStringArray(session.clarifyingQuestions);
    const clarifyingAnswers = asStringRecord(session.clarifyingAnswers);
    const clientContext = await this.clientContext(ctx, session.clientId);

    sse.write(sseEvent({ type: 'phase', phase: 'gather' }));

    // BYOK: run Deep Research gather on the tenant's own key when set, else the
    // global fallback (resolver). Model stays CLIO_RESEARCH_MODEL.
    const resolved = await this.aiCredentials.resolveProvider(ctx, 'anthropic');
    if (!resolved) {
      sse.write(sseEvent({ type: 'error', message: 'ANTHROPIC_API_KEY not configured' }));
      sse.write(sseEvent({ type: 'done' }));
      return;
    }
    const anthropicKey = resolved.apiKey;

    const model = this.config.get('CLIO_RESEARCH_MODEL', { infer: true });
    const maxTokens = this.config.get('CLIO_RESEARCH_MAX_TOKENS', { infer: true });
    // Extended thinking (F3): research gather/synthesize is deep work by
    // definition, so it always qualifies when the feature is enabled.
    const thinkingSettings: ThinkingSettings = {
      enabled: this.config.get('CLIO_EXTENDED_THINKING', { infer: true }),
      mode: this.config.get('CLIO_THINKING_MODE', { infer: true }),
      budgetTokens: this.config.get('CLIO_RESEARCH_THINKING_BUDGET_TOKENS', { infer: true }),
    };
    const thinking = thinkingRequestParams(thinkingSettings, 'deep', maxTokens);
    // Deep research uses its OWN (much longer) per-request timeout, not the
    // short interactive-chat one — a single gather/synthesis turn runs minutes.
    const timeoutMs = this.config.get('CLIO_RESEARCH_TIMEOUT_MS', { infer: true });
    const maxRounds = this.config.get('CLIO_RESEARCH_MAX_TOOL_ROUNDS', { infer: true });
    // Deep Research is a read-only GATHER agent: it must NOT be able to call
    // side-effecting tools (send_email/reply_email/save_memory/create_task/
    // update_client_profile/docgen/...). A long-running agentic loop over the full
    // tool set could otherwise autonomously send mail or mutate data. Filter to
    // concurrency-safe (== read-only, i.e. not in SIDE_EFFECTING_TOOLS) tools;
    // the final report is persisted by this service, not via a write tool. This
    // mirrors the read-only hardening on the scheduled-tasks runner.
    const toolSchemas = this.tools
      .anthropicToolSchemas()
      .filter((s) => this.tools.isConcurrencySafe(s.name));
    const system = buildResearchSystemPrompt(PRODUCT_NAME);

    const messages: Array<{ role: 'user' | 'assistant'; content: unknown }> = [
      {
        role: 'user',
        content: buildResearchUserPrompt({
          topic: session.topic,
          plan,
          clarifyingQuestions,
          clarifyingAnswers,
          clientContext,
        }),
      },
    ];

    let reportBody = '';
    const sources: SourceAttribution[] = [];
    const toolsUsed: string[] = [];
    // Wave-2 post-hoc auditor ledger for the research surface (the most dangerous
    // one — the S3 fabrication cluster). Accumulates successful tool results
    // across gather rounds; audited after synthesis.
    const ledgerEntries: LedgerEntry[] = [];
    // Resolved ONCE up front because ENFORCE changes the streaming shape below:
    // the post-hoc audit can only protect the READER if the report text hasn't
    // already been streamed to them token-by-token. Under enforce we buffer the
    // report deltas (thinking/steps/sources still stream live so the trust
    // timeline works), audit, then deliver — the full body when cleared, a hold
    // notice instead of the body when held. Shadow/annotate keep today's
    // stream-as-generated behavior (the audit there never withholds anything).
    const auditorMode = await resolveTenantAuditorMode(this.prisma, ctx.tenantId);
    const bufferReport = auditorMode === 'enforce';
    let synthesizing = false;
    // True only when the agentic loop ended because the model stopped calling
    // tools and wrote its report. If it ends any other way (tool-round budget
    // exhausted, or a round aborted on timeout) the report was never written, so
    // the forced-synthesis pass below MUST run.
    let endedCleanly = false;

    try {
      for (let round = 0; round < maxRounds; round += 1) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const toolUseById = new Map<number, { id: string; name: string; jsonParts: string[] }>();
        const thinkingState = createThinkingState();
        let stopReason: string | null = null;

        try {
          const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
              'x-api-key': anthropicKey,
              'anthropic-version': '2023-06-01',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              model,
              max_tokens: thinking.maxTokens,
              // Zero-trust Wave 1 (RC8): temperature 0.2 on the figure-heavy
              // research rounds — but ONLY when extended thinking is off
              // (Anthropic rejects temperature != 1 alongside a thinking block).
              ...(thinking.thinking ? { thinking: thinking.thinking } : { temperature: 0.2 }),
              stream: true,
              system,
              tools: toolSchemas,
              messages,
            }),
            signal: controller.signal,
          });

          if (!response.ok || !response.body) {
            const errText = await response.text().catch(() => '');
            throw new Error(
              `Anthropic HTTP ${response.status}${errText ? `: ${errText.slice(0, 300)}` : ''}`,
            );
          }

          const decoder = new TextDecoder();
          const responseBody = response.body as unknown as AsyncIterable<Uint8Array>;
          let buffer = '';

          for await (const chunk of responseBody) {
            buffer += decoder.decode(chunk, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';

            for (const line of lines) {
              if (!line.startsWith('data: ')) continue;
              const payload = line.slice(6).trim();
              if (!payload || payload === '[DONE]') continue;
              try {
                const evt = JSON.parse(payload);
                // Extended thinking (F3): relay reasoning to the research
                // timeline; blocks replay in the loop but never persist.
                const thinkingDelta = applyThinkingStreamEvent(thinkingState, evt);
                if (thinkingDelta.thinkingTextDelta) {
                  sse.write(sseEvent({ type: 'thinking', text: thinkingDelta.thinkingTextDelta }));
                }
                if (evt.type === 'content_block_start') {
                  const block = evt.content_block ?? {};
                  if (block.type === 'tool_use') {
                    toolUseById.set(evt.index, {
                      id: String(block.id ?? ''),
                      name: String(block.name ?? ''),
                      jsonParts: [],
                    });
                  }
                } else if (evt.type === 'content_block_delta') {
                  const delta = evt.delta ?? {};
                  if (delta.type === 'text_delta' && typeof delta.text === 'string') {
                    // The first streamed prose marks the transition into synthesis.
                    if (!synthesizing) {
                      synthesizing = true;
                      sse.write(sseEvent({ type: 'phase', phase: 'synthesize' }));
                    }
                    reportBody += delta.text;
                    // Enforce buffers report text until the post-hoc audit
                    // clears it (see bufferReport above).
                    if (!bufferReport) sse.write(sseEvent({ type: 'text', text: delta.text }));
                  } else if (
                    delta.type === 'input_json_delta' &&
                    typeof delta.partial_json === 'string'
                  ) {
                    toolUseById.get(evt.index)?.jsonParts.push(delta.partial_json);
                  }
                } else if (evt.type === 'message_delta') {
                  stopReason = evt.delta?.stop_reason ?? stopReason;
                }
              } catch {
                /* incomplete chunk */
              }
            }
          }
        } catch (roundErr) {
          // A per-round abort means this model turn exceeded the (long) research
          // timeout. Don't let it kill the whole run — stop gathering and fall
          // through to the forced-synthesis pass so we still write a report
          // rather than persisting only the sources gathered so far.
          if (isAbortError(roundErr)) {
            this.logger.warn(`Research gather round ${round} timed out; forcing synthesis`);
            break;
          }
          throw roundErr;
        } finally {
          clearTimeout(timer);
        }

        // If the model did not request tools, it wrote its final report.
        if (stopReason !== 'tool_use' || toolUseById.size === 0) {
          endedCleanly = true;
          break;
        }

        const orderedTools = [...toolUseById.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([, v]) => v);

        // Thinking blocks first (the API requires them replayed with
        // signatures when tools are used — F3), then tool_use blocks.
        const assistantTurn: Array<Record<string, unknown>> = [
          ...thinkingReplayBlocks(thinkingState),
        ];
        for (const t of orderedTools) {
          let parsedInput: Record<string, unknown> = {};
          const raw = t.jsonParts.join('');
          if (raw.trim()) {
            try {
              parsedInput = JSON.parse(raw);
            } catch {
              parsedInput = {};
            }
          }
          assistantTurn.push({ type: 'tool_use', id: t.id, name: t.name, input: parsedInput });
        }
        messages.push({ role: 'assistant', content: assistantTurn });

        const toolResultBlocks: Array<Record<string, unknown>> = [];
        for (const t of orderedTools) {
          let parsedInput: Record<string, unknown> = {};
          const raw = t.jsonParts.join('');
          if (raw.trim()) {
            try {
              parsedInput = JSON.parse(raw);
            } catch {
              parsedInput = {};
            }
          }
          // Default clientId from the session if the model omitted it.
          if (session.clientId && parsedInput.clientId === undefined) {
            parsedInput.clientId = session.clientId;
          }
          toolsUsed.push(t.name);
          sse.write(sseEvent({ type: 'step', tool: t.name, label: humanToolLabel(t.name) }));

          let resultPayload: unknown;
          let isError = false;
          // Defense-in-depth: never execute a side-effecting tool in the
          // read-only research loop, even if one somehow reaches this point
          // (schema-filter regression, model hallucinating a tool name).
          if (!this.tools.isConcurrencySafe(t.name)) {
            isError = true;
            resultPayload = { error: `Tool "${t.name}" is not permitted in read-only research` };
            this.logger.warn(
              `Deep Research blocked a side-effecting tool call: ${t.name} (session ${session.id})`,
            );
          } else {
            try {
              resultPayload = await this.tools.execute(ctx, t.name as never, parsedInput);
            } catch (err) {
              isError = true;
              resultPayload = {
                error: err instanceof Error ? err.message : 'Tool execution failed',
              };
            }
          }

          const { count, detail } = summarizeToolResultForTrust(resultPayload);
          const source: SourceAttribution = {
            tool: t.name,
            label: humanToolLabel(t.name),
            count: count ?? undefined,
            summary: isError
              ? typeof (resultPayload as { error?: unknown })?.error === 'string'
                ? (resultPayload as { error: string }).error
                : 'Tool error'
              : detail || 'Completed',
            confidence: isError ? 'low' : 'high',
          };
          sources.push(source);
          sse.write(sseEvent({ type: 'source', source }));

          const serialized = summarizeJsonForPrompt(resultPayload, 12_000);
          toolResultBlocks.push({
            type: 'tool_result',
            tool_use_id: t.id,
            is_error: isError,
            content: serialized,
          });
          if (!isError) {
            ledgerEntries.push({
              tool: t.name,
              serialized,
              result: resultPayload,
              rowCount: count ?? undefined,
            });
          }
        }
        messages.push({ role: 'user', content: toolResultBlocks });
      }

      // FORCED SYNTHESIS. The agentic loop can end WITHOUT the model ever
      // writing its report — it exhausted the tool-round budget while still
      // gathering, or a round hit the research timeout (endedCleanly === false).
      // In those cases any text streamed so far is gather-phase narration ("I'll
      // search X, then Y…"), NOT the report — exactly the "it only tells me what
      // it searched / only sources" symptom. Also force a pass if the loop ended
      // cleanly but produced no prose. Make one final NO-TOOLS call so the model
      // must produce the report from the evidence it already gathered.
      if (!endedCleanly || !reportBody.trim()) {
        // Discard gather-phase narration so the forced pass writes a clean
        // report instead of appending it to the narration.
        if (!endedCleanly) reportBody = '';
        messages.push({
          role: 'user',
          content:
            'You have gathered enough. Do NOT call any more tools. Write the full, decision-grade ' +
            'research report NOW, in markdown, following the report requirements: Executive Summary, ' +
            'plan-driven sections with inline source citations, Recommended Actions, and Open Questions.',
        });
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
              'x-api-key': anthropicKey,
              'anthropic-version': '2023-06-01',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              model,
              max_tokens: thinking.maxTokens,
              // Zero-trust Wave 1 (RC8): temperature 0.2 on the figure-heavy
              // research rounds — but ONLY when extended thinking is off
              // (Anthropic rejects temperature != 1 alongside a thinking block).
              ...(thinking.thinking ? { thinking: thinking.thinking } : { temperature: 0.2 }),
              stream: true,
              system,
              // No `tools` key → the model cannot call tools and must answer.
              messages,
            }),
            signal: controller.signal,
          });
          if (!response.ok || !response.body) {
            const errText = await response.text().catch(() => '');
            throw new Error(
              `Anthropic HTTP ${response.status}${errText ? `: ${errText.slice(0, 300)}` : ''}`,
            );
          }
          if (!synthesizing) {
            synthesizing = true;
            sse.write(sseEvent({ type: 'phase', phase: 'synthesize' }));
          }
          const decoder = new TextDecoder();
          const responseBody = response.body as unknown as AsyncIterable<Uint8Array>;
          let buffer = '';
          for await (const chunk of responseBody) {
            buffer += decoder.decode(chunk, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';
            for (const line of lines) {
              if (!line.startsWith('data: ')) continue;
              const payload = line.slice(6).trim();
              if (!payload || payload === '[DONE]') continue;
              try {
                const evt = JSON.parse(payload);
                if (
                  evt.type === 'content_block_delta' &&
                  evt.delta?.type === 'thinking_delta' &&
                  typeof evt.delta.thinking === 'string'
                ) {
                  // Thinking from the forced pass streams to the timeline only;
                  // it never enters reportBody (redaction guarantee, F3).
                  sse.write(sseEvent({ type: 'thinking', text: evt.delta.thinking }));
                } else if (
                  evt.type === 'content_block_delta' &&
                  evt.delta?.type === 'text_delta' &&
                  typeof evt.delta.text === 'string'
                ) {
                  reportBody += evt.delta.text;
                  // Enforce buffers report text until the post-hoc audit
                  // clears it (see bufferReport above).
                  if (!bufferReport) sse.write(sseEvent({ type: 'text', text: evt.delta.text }));
                }
              } catch {
                /* incomplete chunk */
              }
            }
          }
        } catch (synthErr) {
          // Keep whatever prose streamed before an abort rather than discarding
          // it — a partial report is still more useful than sources alone.
          if (isAbortError(synthErr)) {
            this.logger.warn('Forced research synthesis timed out; keeping partial report');
          } else {
            throw synthErr;
          }
        } finally {
          clearTimeout(timer);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Research failed';
      this.logger.warn(`Research run failed: ${msg}`);
      sse.write(sseEvent({ type: 'error', message: msg }));
    }

    // Strip unresolved FORM B [S:tool:record_id] tokens from the report BEFORE
    // the auditor + persist. The research prompt instructs a FORM-B token on
    // every material claim, so a token whose tool wasn't called this turn (or
    // whose record_id isn't verbatim in that tool's result) lends false
    // authority to a likely-fabricated sentence. Mirrors the chat loops (which
    // strip persisted history) and workspace doc-gen (which strips delivered
    // HTML) — research was the one delivered surface still carrying them. Runs
    // before runAuditor below so a stray unresolved token no longer counts
    // toward a D1 hold; the underlying claim, if fabricated, is still caught by
    // the content checks (D2/D4/D7/D11).
    if (reportBody.trim().length > 0) {
      const formB = validateFormBCitations(reportBody, ledgerToToolResultMap(ledgerEntries));
      if (formB.invalid.length) {
        this.logger.warn(
          `[meri-research] stripped ${formB.invalid.length} unresolved FORM B citation(s) ` +
            `from the report: ${formB.invalid.join(', ')}`,
        );
        reportBody = formB.sanitizedText;
      }
    }

    // Wave-2 post-hoc auditor on the RESEARCH surface — SHADOW by default
    // (MERI_AUDITOR_MODE off = no-op). Research is the most dangerous surface, so
    // extending shadow coverage here is high-value: it re-derives ground truth
    // from the gather-loop ledger and logs/persists any contradiction in the
    // synthesized report WITHOUT altering it. Fully guarded; never breaks a run.
    // held: true only when the auditor returns decision==='hold' (enforce mode +
    // a finding on this blocking surface). Research has no external send/file to
    // block, so "hold" = the persisted report artifact is marked heldForReview
    // (and its body already carries the Unverified banner below), so a flagged
    // report is never presented as a cleared deliverable. Inert under shadow/
    // annotate (decision is never 'hold' there), so the default flow is unchanged.
    let held = false;
    let heldReason = '';
    if (auditorMode !== 'off' && reportBody.trim().length > 0) {
      try {
        const verdict = runAuditor({
          output: reportBody,
          ledger: { entries: ledgerEntries },
          surface: 'research',
          mode: auditorMode,
        });
        if (verdict.findings.length > 0) {
          this.logger.warn(
            `[meri-auditor:${auditorMode}] research session ${session.id} — ${verdict.findings.length} finding(s), ` +
              `top=${verdict.topSeverity}, decision=${verdict.decision}: ` +
              verdict.findings.map((f) => `${f.check}/${f.severity}`).join(', '),
          );
          await this.prisma.withTenant(ctx.tenantId, (tx) =>
            tx.meriAuditLedger.create({
              data: {
                tenantId: ctx.tenantId,
                surface: 'research',
                mode: auditorMode,
                decision: verdict.decision,
                topSeverity: verdict.topSeverity ?? null,
                findingCount: verdict.findings.length,
                findings: verdict.findings as unknown as Prisma.InputJsonValue,
                outputChars: reportBody.length,
              },
            }),
          );
          // Degraded mode (v3 plan §3.6): research is fully-blocking. SHADOW only
          // logs+persists (above); ANNOTATE/ENFORCE additionally prepend an
          // Unverified banner naming the held findings to the PERSISTED report,
          // so a flagged report can never present its findings as confirmed.
          // Inert while mode is shadow (the default) — this branch is skipped.
          if (auditorMode === 'annotate' || auditorMode === 'enforce') {
            const checks = [...new Set(verdict.findings.map((f) => f.check))].join(', ');
            reportBody =
              `> ⚠️ **Unverified — ${verdict.findings.length} grounding finding(s) held for review ` +
              `(${checks}).** Treat flagged claims as unconfirmed until a reviewer clears them.\n\n` +
              reportBody;
          }
          // Enforce = hold: mark the persisted artifact/session heldForReview
          // below. decisionFor() returns 'hold' only in enforce mode, so this is
          // inert under shadow/annotate.
          held = verdict.decision === 'hold';
          if (held) {
            heldReason = `Grounding auditor: ${verdict.findings
              .map((f) => `${f.check} (${f.severity}): ${f.detail}`)
              .join('; ')}`.slice(0, 2000);
          }
        }
      } catch (err) {
        this.logger.warn(
          `[meri-auditor] research audit failed (run unaffected): ${(err as Error).message}`,
        );
      }
    }

    // Reader-protection flush (enforce only): report deltas were withheld above,
    // so deliver now — the full (banner-prefixed) body when the audit cleared
    // it, or a hold notice INSTEAD of the body when held. The persisted artifact
    // keeps the full text either way; approve in Reviews releases it.
    const heldNotice =
      `> ⏸️ **Report held for review.** The grounding auditor flagged this report under ` +
      `enforce mode and it was not delivered. A reviewer must approve it in Reviews before ` +
      `the content is released; the saved report is marked *held for review*.` +
      (heldReason ? `\n>\n> ${heldReason.slice(0, 500)}` : '');
    if (bufferReport) {
      const deliverable = held ? heldNotice : reportBody;
      if (deliverable.trim().length > 0) sse.write(sseEvent({ type: 'text', text: deliverable }));
    }

    // Persist the report artifact + link it to the session.
    const artifactBody = assembleReportArtifact({
      title: session.title,
      topic: session.topic,
      plan,
      reportBody,
      sources,
      generatedAt: new Date(),
    });

    const artifactId = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      // ClioArtifact.conversationId is a required FK to clio_conversations, so a
      // research session needs a lightweight backing conversation to anchor its
      // report artifact (this also surfaces the report in the existing artifact
      // panel). One backing conversation per session, created on first report.
      const existing =
        session.metadata && typeof session.metadata === 'object' && !Array.isArray(session.metadata)
          ? (session.metadata as Record<string, unknown>).backingConversationId
          : undefined;
      let conversationId = typeof existing === 'string' ? existing : null;
      if (!conversationId) {
        const conversation = await tx.clioConversation.create({
          data: {
            tenantId: ctx.tenantId,
            userId: ctx.userId,
            clientId: session.clientId ?? null,
            title: `Research: ${session.title}`,
            status: 'active',
            metadata: { researchSessionId: session.id } as Prisma.InputJsonObject,
          },
          select: { id: true },
        });
        conversationId = conversation.id;
      }

      const artifact = await tx.clioArtifact.create({
        data: {
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          clientId: session.clientId ?? null,
          conversationId,
          title: session.title,
          kind: 'research_report',
          contentType: 'text/markdown',
          bodyText: artifactBody,
          metadata: {
            researchSessionId: session.id,
            topic: session.topic,
            plan,
            toolsUsed,
            sourceCount: sources.length,
            model,
            // Phase 2.5-1: set only under enforce+finding; consumers/UI treat a
            // held report as not-yet-cleared (its body carries the banner too).
            ...(held ? { heldForReview: true } : {}),
          } as Prisma.InputJsonObject,
        },
        select: { id: true },
      });
      await tx.clioResearchSession.update({
        where: { id: session.id },
        data: {
          status: 'complete',
          reportArtifactId: artifact.id,
          sources: sources as unknown as Prisma.InputJsonValue,
          metadata: { backingConversationId: conversationId } as Prisma.InputJsonObject,
          updatedAt: new Date(),
        },
      });
      return artifact.id;
    });

    // G4: a held report becomes a pending review_request so a reviewer can
    // clear heldForReview through the Reviews queue (fail-open by contract).
    if (held) {
      await this.reviews.createSystem(ctx.tenantId, {
        riskTier: DELIVERABLE_RISK_TIERS.research_report ?? 'moderate',
        surface: 'research',
        subjectType: 'research_artifact',
        subjectId: artifactId,
        clientId: session.clientId ?? null,
        title: session.title,
        reason: heldReason || 'Grounding auditor held this research report for review.',
        payload: { artifactId },
        requestedBy: ctx.userId,
      });
    }

    sse.write(sseEvent({ type: 'phase', phase: 'done' }));
    // The report event REPLACES the whole chat message client-side — when held
    // (enforce only) it must carry the hold notice, never the report body, or
    // the buffering above would be undone at the finish line.
    sse.write(sseEvent({ type: 'report', artifactId, body: held ? heldNotice : artifactBody }));
    sse.write(sseEvent({ type: 'done' }));
  }

  // ── internals ───────────────────────────────────────────────────────────

  private async ensureSession(ctx: TenantContext, id: string) {
    const session = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.clioResearchSession.findFirst({
        where: { id, tenantId: ctx.tenantId, userId: ctx.userId },
      }),
    );
    if (!session) throw new NotFoundException('Research session not found');
    return session;
  }

  private async clientContext(ctx: TenantContext, clientId: string | null): Promise<string | null> {
    if (!clientId) return null;
    try {
      const client = await this.prisma.withTenant(ctx.tenantId, (tx) =>
        tx.client.findFirst({
          where: { id: clientId },
          select: { name: true, description: true, productDescription: true },
        }),
      );
      if (!client) return null;
      const parts = [`Client: ${client.name}`];
      if (client.description) parts.push(`Description: ${client.description}`);
      if (client.productDescription) parts.push(`Product/service: ${client.productDescription}`);
      return parts.join('\n');
    } catch {
      return null;
    }
  }

  /** Single non-streaming Anthropic completion (used for the PLAN phase). */
  private async anthropicComplete(tenantId: string, system: string, user: string): Promise<string> {
    // BYOK: tenant key (or global fallback) via resolver; model unchanged.
    const resolved = await this.aiCredentials.resolveProviderByTenantId(tenantId, 'anthropic');
    if (!resolved) throw new Error('ANTHROPIC_API_KEY not configured');
    const anthropicKey = resolved.apiKey;
    const model = this.config.get('CLIO_RESEARCH_PLAN_MODEL', { infer: true });
    const timeoutMs = this.config.get('CLIO_REQUEST_TIMEOUT_MS', { infer: true });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': anthropicKey,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          max_tokens: 1500,
          system,
          messages: [{ role: 'user', content: user }],
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        throw new Error(
          `Anthropic HTTP ${response.status}${errText ? `: ${errText.slice(0, 300)}` : ''}`,
        );
      }
      const json = (await response.json()) as { content?: Array<{ type: string; text?: string }> };
      return (json.content ?? [])
        .filter((b) => b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('');
    } finally {
      clearTimeout(timer);
    }
  }
}

/* ── module-private pure helpers ─────────────────────────────────────────── */

function sseEvent(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/**
 * True for an AbortController-driven timeout. fetch/undici surface these as a
 * DOMException/Error named 'AbortError' (and sometimes the message "This
 * operation was aborted"), so match on either.
 */
function isAbortError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === 'AbortError' || /abort/i.test(err.message);
}

function asStringArray(value: Prisma.JsonValue | null | undefined): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}

function asStringRecord(value: Prisma.JsonValue | null | undefined): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}
