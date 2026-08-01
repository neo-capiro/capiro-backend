import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import {
  KeywordIntentRouter,
  wrapToolResultForPrompt,
  runAuditor,
  ledgerToToolResultMap,
  resolveGovernmentAffairsOperatingFrame,
  planGovernmentAffairsEvidence,
  buildAssurancePromptBlock,
  buildClaimLedgerFromToolResults,
  classifyAssuranceRisk,
  evaluateAssuranceRelease,
  assurePreToolPersist,
  resolveAssuranceRolloutMode,
  runGovernmentAffairsChecks,
  assuranceMetric,
  metricLogLine,
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

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

const MAX_ROUNDS = 14;
const MAX_TOKENS = 8192;
const TOOL_RESULT_CHARS = 12_000;
const PAGE_WRITE_DRAFT_TOOLS = new Set(['draft_policy_memo', 'create_meeting_brief']);

const MODEL_AUTHORED_PERSISTED_BODY_FIELDS: ReadonlyMap<string, string> = new Map([
  ['draft_policy_memo', 'body'],
  ['save_note', 'body'],
]);

interface ContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  [k: string]: unknown;
}

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
    this.llm = registryService.llm;
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

    const lastUserText = String(messages[messages.length - 1]?.content ?? '');
    const intent = new KeywordIntentRouter().classify(lastUserText);
    const operatingFrame = resolveGovernmentAffairsOperatingFrame({
      request: lastUserText,
      explicit: dto.clientId ? { clientId: dto.clientId } : undefined,
    });
    const evidencePlan = planGovernmentAffairsEvidence({
      request: lastUserText,
      frame: operatingFrame,
      surface: 'chat',
    });
    const assuranceRisk = classifyAssuranceRisk('chat', evidencePlan);
    const assuranceMode = resolveAssuranceRolloutMode({
      globalModeRaw: process.env.MERI_RELEASE_GATE,
      tenantCanariesRaw: process.env.MERI_RELEASE_GATE_TENANTS,
      surfacesRaw: process.env.MERI_RELEASE_GATE_SURFACES,
      tenantId: ctx.tenantId,
      surface: 'chat',
    });
    const evaluateBeforeRelease =
      assuranceMode !== 'off' && assuranceRisk.requiresBufferBeforeRelease;
    const bufferBeforeRelease =
      assuranceMode === 'enforce' && assuranceRisk.requiresBufferBeforeRelease;

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
    const baseSystemParts = composeChatSystemPrompt(dto, ctx, intent);
    const systemParts = {
      ...baseSystemParts,
      dynamic: `${baseSystemParts.dynamic}\n\n${buildAssurancePromptBlock(operatingFrame, evidencePlan)}`,
    };
    const system = flattenSystemParts(systemParts);
    const toolSchemas = await this.fetchToolSchemas();
    const verificationAvailable = toolSchemas.length > 0;
    const steps: ChatStep[] = [];
    const pendingApprovals: NonNullable<ChatResult['pendingApprovals']> = [];
    const artifacts: ChatArtifact[] = [];
    let complianceOutcome: 'PASS' | 'WARN' | 'BLOCK' | undefined;
    const noteComplianceOutcome = (outcome: 'PASS' | 'WARN' | 'BLOCK'): void => {
      const rank = { PASS: 0, WARN: 1, BLOCK: 2 } as const;
      if (complianceOutcome === undefined || rank[outcome] > rank[complianceOutcome]) {
        complianceOutcome = outcome;
      }
    };
    const ledgerEntries: LedgerEntry[] = [];
    const citations: MeriCitation[] = [];
    const usageAcc = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    };
    let pageWritePayload: { subject: string; body: string } | null = null;

    const prePersistRefusal = (name: string, input: Record<string, unknown>): string | null => {
      if (!evaluateBeforeRelease) return null;
      const field = MODEL_AUTHORED_PERSISTED_BODY_FIELDS.get(name);
      if (!field) return null;
      const raw = input[field];
      const body = typeof raw === 'string' ? raw.trim() : '';
      if (!body) return null;
      try {
        const claimLedger = buildClaimLedgerFromToolResults({
          output: body,
          ledgerEntries,
          citations,
          plan: evidencePlan,
        });
        const grounding = runAuditor({
          output: body,
          ledger: { entries: ledgerEntries },
          surface: 'memo',
          mode: 'enforce',
        });
        const domainFindings = runGovernmentAffairsChecks({
          ledger: claimLedger,
          facts: [],
          outputText: body,
        });
        const decision = assurePreToolPersist({
          surface: 'memo',
          plan: evidencePlan,
          ledger: claimLedger,
          findings: [...grounding.findings, ...domainFindings],
          ...(complianceOutcome ? { complianceOutcome } : {}),
          verificationAvailable,
          subject: `The ${toolLabel(name).toLowerCase()}`,
        });
        this.logger.log(
          metricLogLine(
            assuranceMetric({
              name: 'release_gate',
              dimensions: {
                surface: 'chat',
                domain: `${assuranceMode}:pre_persist`,
                outcome: decision.gate.decision,
                category: name,
                jurisdiction: operatingFrame.jurisdictions.join(',').slice(0, 120),
                envelope: decision.gate.envelope.hash.slice(0, 16),
              },
            }),
          ),
        );
        if (assuranceMode !== 'enforce') return null;
        return decision.allowPersist ? null : decision.refusal;
      } catch (error) {
        this.logger.warn(
          `[meri-assurance] pre-persist verification failed for ${name}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return assuranceMode === 'enforce'
          ? 'Pre-persistence verification was unavailable, so this deliverable was NOT created or saved. Tell the user nothing was written and try again once verification is available.'
          : null;
      }
    };

    const finalize = (reply: string): ChatResult => {
      const { used, cleanedText: formACleaned } = validateCitationMarkers(reply, citations);
      const formB = validateFormBCitations(formACleaned, ledgerToToolResultMap(ledgerEntries));
      if (formB.invalid.length) {
        this.logger.warn(
          `Meri dropped ${formB.invalid.length} unresolved FORM B citation(s) from persisted history: ${formB.invalid.join(', ')}`,
        );
      }
      const cleanedText = formB.sanitizedText;
      let releasedText = cleanedText;
      let releaseHeld = false;
      const audit = this.auditChatReply(cleanedText, ledgerEntries);
      if (audit && audit.verdict.findings.length > 0) {
        if (!bufferBeforeRelease && (audit.mode === 'enforce' || audit.mode === 'annotate')) {
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

      if (evaluateBeforeRelease && cleanedText.trim()) {
        try {
          const claimLedger = buildClaimLedgerFromToolResults({
            output: cleanedText,
            ledgerEntries,
            citations,
            plan: evidencePlan,
          });
          const grounding = runAuditor({
            output: cleanedText,
            ledger: { entries: ledgerEntries },
            surface: 'chat',
            mode: 'enforce',
          });
          const domainFindings = runGovernmentAffairsChecks({
            ledger: claimLedger,
            facts: [],
            outputText: cleanedText,
          });
          const combinedFindings = [...grounding.findings, ...domainFindings];
          const gate = evaluateAssuranceRelease({
            surface: 'chat',
            plan: evidencePlan,
            ledger: claimLedger,
            findings: combinedFindings,
            ...(complianceOutcome ? { complianceOutcome } : {}),
            verificationAvailable,
          });
          this.logger.log(
            metricLogLine(
              assuranceMetric({
                name: 'release_gate',
                dimensions: {
                  surface: 'chat',
                  domain: assuranceMode,
                  outcome: gate.decision,
                  category: assuranceRisk.categories.join(',').slice(0, 120),
                  severity: grounding.topSeverity ?? undefined,
                  jurisdiction: operatingFrame.jurisdictions.join(',').slice(0, 120),
                  envelope: gate.envelope.hash.slice(0, 16),
                },
              }),
            ),
          );
          const severe = combinedFindings.filter(
            (finding) => finding.severity === 'critical' || finding.severity === 'high',
          );
          if (assuranceMode === 'enforce' && severe.length) {
            emit({
              type: 'grounding_caveat',
              topSeverity: severe.some((finding) => finding.severity === 'critical')
                ? 'critical'
                : 'high',
              findings: severe.slice(0, 20).map((finding) => ({
                check: finding.check,
                severity: finding.severity,
                detail: finding.detail,
              })),
            });
          }
          if (
            assuranceMode === 'enforce' &&
            (gate.decision === 'repair' || gate.decision === 'hold')
          ) {
            releaseHeld = true;
            const reasons = gate.blockers
              .slice(0, 6)
              .map((reason) => `- ${reason}`)
              .join('\n');
            releasedText = [
              'I could not safely release the requested high-stakes answer because required verification did not pass.',
              reasons || '- One or more high-risk claims lacked authoritative same-turn support.',
              '',
              'I did not treat an empty result, stale memory, or model inference as proof. Refine the jurisdiction/vehicle/fiscal year or restore the missing authoritative source, then run the request again.',
            ].join('\n');
          }
        } catch (error) {
          this.logger.warn(
            `[meri-assurance] pre-release verification failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          if (assuranceMode === 'enforce') {
            releaseHeld = true;
            releasedText =
              'Verification was unavailable, so I did not release the requested high-stakes answer. Please try again after the authoritative sources are available.';
          }
        }
        if (bufferBeforeRelease) emit({ type: 'text', text: releasedText });
      }

      if (dto.pageWrite && pageWritePayload && !releaseHeld) {
        emit({
          type: 'page_write',
          target: 'outreach_draft',
          subject: pageWritePayload.subject,
          body: pageWritePayload.body,
        });
      }
      return {
        reply: releasedText,
        intent: intent.mode,
        usage: { ...usageAcc },
        steps,
        ...(used.length ? { citations: used } : {}),
        ...(pendingApprovals.length ? { pendingApprovals } : {}),
        ...(artifacts.length && !releaseHeld ? { artifacts } : {}),
      };
    };

    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      if (opts.signal?.aborted) return finalize('');
      let content: ContentBlock[];
      let stopReason: string | null;
      let streamed = false;
      try {
        const resp = await this.llm.completeWithTools({
          system: systemParts,
          messages,
          tools: toolSchemas as AnthropicToolSchema[],
          maxTokens: MAX_TOKENS,
          timeoutMs: this.callTimeoutMs,
          ...(bufferBeforeRelease
            ? {}
            : { onTextDelta: (delta: string) => emit({ type: 'text' as const, text: delta }) }),
          ...(opts.signal ? { signal: opts.signal } : {}),
        });
        void this.meterRound(ctx, resp);
        usageAcc.inputTokens += resp.usage.inputTokens;
        usageAcc.outputTokens += resp.usage.outputTokens;
        usageAcc.cacheReadTokens += resp.usage.cacheReadTokens ?? 0;
        usageAcc.cacheCreationTokens += resp.usage.cacheCreationTokens ?? 0;
        content = resp.content as ContentBlock[];
        stopReason = resp.stopReason;
        streamed = bufferBeforeRelease ? false : (resp.streamed ?? false);
      } catch (e) {
        if (opts.signal?.aborted) return finalize('');
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
          if (!bufferBeforeRelease && !streamed) emit({ type: 'text', text: textOut });
          return finalize(textOut);
        }
        return finalize(
          await this.synthesizeFinalAnswer(
            ctx,
            system,
            toolSchemas,
            messages,
            emit,
            opts,
            bufferBeforeRelease,
          ),
        );
      }

      if (textOut && !bufferBeforeRelease) {
        emit({ type: 'text', text: streamed ? '\n\n' : `${textOut}\n\n` });
      }

      messages.push({ role: 'assistant', content });
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
            prePersistRefusal,
            noteComplianceOutcome,
          ),
        })),
      );
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

    return finalize(
      await this.synthesizeFinalAnswer(
        ctx,
        system,
        toolSchemas,
        messages,
        emit,
        opts,
        bufferBeforeRelease,
      ),
    );
  }

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

  private async synthesizeFinalAnswer(
    ctx: MeriContext,
    system: string,
    toolSchemas: AnthropicToolSchema[],
    messages: Array<{ role: 'user' | 'assistant'; content: unknown }>,
    emit: (event: ChatStreamEvent) => void,
    opts: ChatRunOptions,
    suppressStreaming = false,
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
      if (text && !suppressStreaming) emit({ type: 'text', text });
      return (
        text || 'I gathered the context but could not compose a final answer — please ask again.'
      );
    } catch (e) {
      if (opts.signal?.aborted) return '';
      this.logger.warn(`chat synthesis call failed: ${(e as Error).message}`);
      return 'I gathered a lot of context but hit an error composing the final answer — please ask again.';
    }
  }

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

  private async invokeTool(
    ctx: MeriContext,
    name: string,
    input: Record<string, unknown>,
    conversationId: string | undefined,
    steps: ChatStep[],
    pendingApprovals: NonNullable<ChatResult['pendingApprovals']>,
    artifacts: ChatArtifact[],
    emit: (event: ChatStreamEvent) => void = () => {},
    prePersistRefusal: (name: string, input: Record<string, unknown>) => string | null = () => null,
    noteComplianceOutcome: (outcome: 'PASS' | 'WARN' | 'BLOCK') => void = () => {},
  ): Promise<unknown> {
    const label = toolLabel(name);
    const isWrite = this.registry.get(name)?.readOnly === false;
    emit({ type: 'tool_call', tool: name, label });
    const refusal = prePersistRefusal(name, input);
    if (refusal) {
      const detail = 'held: pre-release verification failed';
      steps.push({ tool: name, label, status: 'blocked', detail });
      emit({ type: 'tool_done', tool: name, label, status: 'blocked', detail });
      return { blocked: true, persisted: false, message: refusal };
    }

    if (isWrite) {
      let authority: Awaited<ReturnType<ApiActionProposalRepo['create']>>;
      try {
        authority = await this.actionProposals.create({
          tool: name,
          input,
          ...(conversationId ? { conversationId } : {}),
          surface: 'chat',
        });
      } catch (error) {
        const detail = (error as Error).message.slice(0, 160);
        steps.push({ tool: name, label, status: 'error', detail });
        emit({ type: 'tool_done', tool: name, label, status: 'error', detail });
        return {
          error: true,
          message:
            'The server-owned action authority was unavailable. Nothing was executed or proposed.',
        };
      }

      const proposal = authority.proposal;
      if (authority.disposition === 'executed') {
        noteComplianceOutcome('PASS');
        steps.push({ tool: name, label, status: 'done' });
        emit({ type: 'tool_done', tool: name, label, status: 'done' });
        for (const art of extractChatArtifacts(authority.executionResult)) {
          artifacts.push(art);
          emit({ type: 'artifact', artifact: art });
        }
        return authority.executionResult;
      }
      if (authority.disposition === 'pending_approval') {
        noteComplianceOutcome('WARN');
        const blocker = await this.describeClientBlocker(input);
        const reason = blocker ? `${proposal.reason} — ${blocker}` : proposal.reason;
        steps.push({ tool: name, label, status: 'pending_approval' });
        pendingApprovals.push({
          tool: name,
          proposalId: proposal.proposalId,
          reason,
          status: proposal.status,
          policy: {
            packKey: proposal.policy.packKey,
            packVersion: proposal.policy.packVersion,
            binding: proposal.policy.binding,
            decisionHash: proposal.policy.decisionHash,
          },
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
          ruleId: proposal.ruleId,
          policy: proposal.policy,
          preview: proposal.preview,
        });
        return blocker
          ? {
              pendingApproval: true,
              proposalId: proposal.proposalId,
              willFail: true,
              message: `This action needs approval and will fail as proposed: ${blocker}.`,
            }
          : {
              pendingApproval: true,
              proposalId: proposal.proposalId,
              message: `This action needs approval before it runs: ${proposal.reason}`,
            };
      }

      if (authority.disposition === 'blocked') {
        noteComplianceOutcome('BLOCK');
        const detail = (proposal?.reason ?? 'Blocked by policy').slice(0, 120);
        steps.push({ tool: name, label, status: 'blocked', detail });
        emit({ type: 'tool_done', tool: name, label, status: 'blocked', detail });
        return {
          blocked: true,
          message: `Blocked by the authoritative policy pack: ${proposal?.reason ?? 'blocked'}`,
        };
      }

      const detail =
        proposal?.error?.message?.slice(0, 120) ??
        (typeof authority.disposition === 'string'
          ? `Action authority returned ${authority.disposition}`
          : 'Action execution failed');
      steps.push({ tool: name, label, status: 'error', detail });
      emit({ type: 'tool_done', tool: name, label, status: 'error', detail });
      return { error: true, message: detail };
    }

    try {
      const result = await this.registry.invoke(name, input, ctx);
      steps.push({ tool: name, label, status: 'done' });
      emit({ type: 'tool_done', tool: name, label, status: 'done' });
      for (const art of extractChatArtifacts(result)) {
        artifacts.push(art);
        emit({ type: 'artifact', artifact: art });
      }
      return result;
    } catch (error) {
      const detail = (error as Error).message.slice(0, 120);
      steps.push({ tool: name, label, status: 'error', detail });
      emit({ type: 'tool_done', tool: name, label, status: 'error', detail });
      return { error: detail };
    }
  }

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
