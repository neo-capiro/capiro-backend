import { selectMeriCapabilitySchemas } from '@capiro/shared';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  assuranceMetric,
  buildControlledClaimLedger,
  classifyAssuranceRisk,
  collectPeStructuralWarnings,
  confidenceLevel,
  evaluateAssuranceRelease,
  extractCitedPeCodes,
  metricLogLine,
  parseVerifierClaims,
  resolveAssuranceRolloutMode,
  runAuditor,
  runGovernmentAffairsChecks,
  serializeRecordForGrounding,
  summarizeVerification,
  wrapToolResultForPrompt,
  type AssuranceRolloutMode,
  type Confidence,
  type LedgerEntry,
  type MeriContext,
  type PeRecordForValidation,
  type PeStructuralWarning,
  type ToolRegistry,
} from '@capiro/meriv2-core';
import { recordAiUsageEvent } from '@capiro/shared';
import { MeriRegistryService } from '../meri-registry.service.js';
import {
  RequestScopedLlmClient,
  type AnthropicToolSchema,
  type ToolLoopResponse,
} from '../request-scoped-llm.client.js';
import { RequestCredentialsStore } from '../../request/request-credentials.store.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  ASSISTANT_TOOLS,
  PROPOSE_EDITS_TOOL,
  composeInEditorSystemPrompt,
  resolveInEditorAssurance,
  sanitizeEdits,
  toolLabel,
  type AssistantEdit,
  type AssistantResult,
  type AssistantStep,
  type InEditorInput,
} from './in-editor-prompt.js';
import { flattenSystemParts } from '../prompt-cache.helpers.js';
import { createMeriExecutionControl } from '../meri-execution-control.js';

const VERIFIER_SYSTEM_PROMPT =
  'You are a strict grounding verifier for a government-affairs assistant. Given SOURCES and a ' +
  "DOCUMENT, extract the document's distinct factual claims (skip headings, opinions, and " +
  'generic advice). For each claim decide whether the SOURCES substantiate it. Return ONLY JSON: ' +
  '{"claims":[{"claim":"<short paraphrase>","supported":true|false,"sourceIds":[<source numbers>]}]}. ' +
  'Mark supported=true only when a listed source backs the claim. Be conservative: if unsure, use ' +
  'supported=false with sourceIds [].';

const MAX_ROUNDS = 3;
export const EDITOR_TOTAL_BUDGET_MS = 120_000;
const FINAL_EDIT_RESERVE_MS = 60_000;
const VERIFICATION_RESERVE_MS = 10_000;

function withinEditorBudget<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException('Editor deadline exceeded', 'TimeoutError'));
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
  });
}
// Raised from 8192: a truncated turn now discards its edits (see the max_tokens
// branch in the loop), so too low a cap costs the user the whole edit.
const MAX_TOKENS = 16384;
const TOOL_RESULT_CHARS = 12_000;

interface ContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  [k: string]: unknown;
}

@Injectable()
export class InEditorAssistantService {
  private readonly logger = new Logger(InEditorAssistantService.name);
  private readonly registry: ToolRegistry;
  private readonly llm: RequestScopedLlmClient;
  private readonly apiBaseUrl: string;
  private readonly callTimeoutMs: number;
  private readonly verifierEnabled: boolean;

  constructor(
    registryService: MeriRegistryService,
    config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    this.registry = registryService.registry;
    this.llm = registryService.llm;
    this.callTimeoutMs = Number.parseInt(config.get<string>('MERIV2_TIMEOUT_MS') ?? '120000', 10);
    this.apiBaseUrl = (
      config.get<string>('MERIV2_API_BASE_URL') ?? 'http://localhost:3000'
    ).replace(/\/+$/, '');
    this.verifierEnabled = config.get<string>('CLIO_VERIFIER_ENABLED') === 'true';
  }

  async run(ctx: MeriContext, dto: InEditorInput): Promise<AssistantResult> {
    const control = createMeriExecutionControl({}, EDITOR_TOTAL_BUDGET_MS);
    try {
      return await withinEditorBudget(this.runWithinBudget(ctx, dto, control), control.signal);
    } catch (error) {
      if (!control.signal.aborted) throw error;
      this.logger.warn('in-editor total request deadline reached; edits withheld');
      return { reply: 'I could not finish this edit in time. No changes were applied. Please try a smaller edit.', edits: [] };
    } finally {
      control.dispose();
    }
  }

  private async runWithinBudget(
    ctx: MeriContext, dto: InEditorInput, control: ReturnType<typeof createMeriExecutionControl>,
  ): Promise<AssistantResult> {
    const messages: Array<{ role: 'user' | 'assistant'; content: unknown }> = (dto.messages ?? [])
      .filter(
        (m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.text === 'string',
      )
      .slice(-20)
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.text as string }));
    if (!messages.length || messages[messages.length - 1]?.role !== 'user') {
      return { reply: 'What would you like me to do with this document?', edits: [] };
    }

    const systemParts = composeInEditorSystemPrompt(dto);
    const system = flattenSystemParts(systemParts);
    const toolSchemas = [...(await this.fetchToolSchemas(control.signal)), PROPOSE_EDITS_TOOL];
    const assurance = resolveInEditorAssurance(dto);
    const assuranceRisk = classifyAssuranceRisk('in-editor', assurance.plan);
    const assuranceMode = resolveAssuranceRolloutMode({
      globalModeRaw: process.env.MERI_RELEASE_GATE,
      tenantCanariesRaw: process.env.MERI_RELEASE_GATE_TENANTS,
      surfacesRaw: process.env.MERI_RELEASE_GATE_SURFACES,
      tenantId: ctx.tenantId,
      surface: 'in-editor',
    });
    const evaluateBeforeApply =
      assuranceMode !== 'off' && assuranceRisk.requiresBufferBeforeRelease;
    const steps: AssistantStep[] = [];
    const groundingBodies: string[] = [];
    const citedPeRecords = new Map<string, PeRecordForValidation>();
    const ledgerEntries: LedgerEntry[] = [];
    let forceFinal = false;

    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      control.assertActive();
      const remaining = control.deadlineAt! - Date.now();
      const finalRound = forceFinal || round === MAX_ROUNDS - 1 || remaining <= FINAL_EDIT_RESERVE_MS + VERIFICATION_RESERVE_MS;
      const modelBudgetMs = Math.max(1, Math.min(this.callTimeoutMs, remaining - (finalRound ? VERIFICATION_RESERVE_MS : FINAL_EDIT_RESERVE_MS)));
      const modelControl = createMeriExecutionControl(control, modelBudgetMs);
      let content: ContentBlock[];
      let stopReason: string | null;
      let stopDetails: { category: string | null; explanation: string | null } | null = null;
      try {
        const resp = await withinEditorBudget(this.llm.completeWithTools({
          system: finalRound
            ? `${system}\n\nFinish the requested edit now using only established evidence. Do not research further. Call propose_document_edits with concise edits, or an empty edits array explaining what evidence is missing. Do not invent facts to finish.`
            : systemParts,
          messages,
          tools: (finalRound ? [PROPOSE_EDITS_TOOL] : toolSchemas) as AnthropicToolSchema[],
          ...(finalRound ? { toolChoice: { type: 'tool' as const, name: 'propose_document_edits' } } : {}),
          maxTokens: MAX_TOKENS,
          anthropicEffort: 'low',
          timeoutMs: modelBudgetMs,
          signal: modelControl.signal,
        }), modelControl.signal);
        control.assertActive();
        void this.meterRound(ctx, resp);
        content = resp.content as ContentBlock[];
        stopReason = resp.stopReason;
        stopDetails = resp.stopDetails ?? null;
      } catch (e) {
        if (modelControl.signal.aborted && !control.signal.aborted && !finalRound) {
          // A timed-out research attempt has no admissible new evidence. The
          // reserved response may use existing sources or explain the gap.
          forceFinal = true;
          continue;
        }
        this.logger.warn(`in-editor model call failed: ${(e as Error).message}`);
        return {
          reply: 'Sorry — I hit an error reaching the model. Please try again in a moment.',
          edits: [],
        };
      } finally {
        modelControl.dispose();
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

      // These three must be handled BEFORE the terminal propose check below: a
      // `max_tokens` stop means the final block was cut off mid-emit, so a
      // propose_document_edits payload from that round can be partial — never
      // apply document edits from a truncated turn. A refusal previously fell
      // through to `textOut || 'Done.'` and shipped a bare "Done." with no edits
      // and no logged reason.
      if (stopReason === 'refusal') {
        this.logger.warn(
          `in-editor: model refused` +
            (stopDetails?.category ? ` (category=${stopDetails.category})` : '') +
            (stopDetails?.explanation ? `: ${stopDetails.explanation.slice(0, 200)}` : ''),
        );
        return {
          reply:
            textOut ||
            'I can’t help with that request. Try rephrasing it — or flag it to the Capiro team if you think it was blocked in error.',
          edits: [],
          steps,
        };
      }
      if (stopReason === 'max_tokens') {
        this.logger.warn(
          `in-editor: hit max_tokens cap (${MAX_TOKENS}) in round ${round + 1}; edits discarded as possibly truncated`,
        );
        return {
          reply:
            `${textOut}\n\nI hit my length limit before finishing this edit, so I haven’t applied anything — narrow the request and I’ll retry.`.trim(),
          edits: [],
          steps,
        };
      }
      if (stopReason === 'pause_turn') {
        this.logger.log(`in-editor: pause_turn in round ${round + 1}; resuming`);
        messages.push({ role: 'assistant', content });
        continue;
      }

      // Terminal: the model proposed its answer (+ optional edits).
      const propose = toolUses.find((t) => t.name === 'propose_document_edits');
      if (propose) {
        const input = propose.input ?? {};
        const reply = typeof input.reply === 'string' && input.reply.trim() ? input.reply : textOut;
        const edits = sanitizeEdits(input.edits);
        const subjectId = String(
          (dto.document as Record<string, unknown> | undefined)?.id ?? 'in-editor',
        );
        const { confidence, structuralWarnings } = await withinEditorBudget(this.verifyEdits(
          edits,
          groundingBodies,
          citedPeRecords,
          subjectId,
          control,
        ), control.signal);
        control.assertActive();
        const held = evaluateBeforeApply
          ? this.holdUnverifiedEdits(
              edits,
              structuralWarnings,
              ledgerEntries,
              assurance,
              assuranceMode,
              ctx.tenantId,
              ctx.contextPacket?.persisted ? (ctx.contextPacket.packetId ?? null) : null,
            )
          : null;
        if (held) {
          return {
            reply: held,
            edits: [],
            ...(structuralWarnings ? { structuralWarnings } : {}),
            steps,
          };
        }
        return { reply: reply || 'Done.', edits, confidence, structuralWarnings, steps };
      }

      if (!toolUses.length || stopReason !== 'tool_use') {
        return { reply: textOut || 'Done.', edits: [], steps };
      }

      if (finalRound) return { reply: 'I could not complete a verified edit within this request. No changes were applied.', edits: [], steps };

      messages.push({ role: 'assistant', content });
      const results = await Promise.all(
        toolUses.map(async (tu) => {
          let result: unknown;
          if (!ASSISTANT_TOOLS.has(tu.name)) {
            result = { error: `Tool "${tu.name}" is not available in the document assistant.` };
            steps.push({
              tool: tu.name,
              label: toolLabel(tu.name),
              status: 'error',
              detail: 'unavailable',
            });
          } else {
            try {
              const toolControl = createMeriExecutionControl(control, Math.max(1, control.deadlineAt! - Date.now() - FINAL_EDIT_RESERVE_MS));
              try {
                result = await withinEditorBudget(this.registry.invoke(tu.name, tu.input ?? {}, ctx, toolControl), toolControl.signal);
              } finally {
                toolControl.dispose();
              }
              control.assertActive();
              this.captureGrounding(tu.name, result, groundingBodies, citedPeRecords);
              steps.push({ tool: tu.name, label: toolLabel(tu.name), status: 'done' });
            } catch (e) {
              result = { error: (e as Error).message };
              steps.push({
                tool: tu.name,
                label: toolLabel(tu.name),
                status: 'error',
                detail: (e as Error).message.slice(0, 120),
              });
            }
          }
          const serialized = wrapToolResultForPrompt(tu.name, result, TOOL_RESULT_CHARS);
          ledgerEntries.push({ tool: tu.name, serialized, result });
          return {
            type: 'tool_result' as const,
            tool_use_id: tu.id,
            content: serialized,
          };
        }),
      );
      messages.push({ role: 'user', content: results });
    }

    return { reply: 'I could not complete a verified edit within this request. No changes were applied.', edits: [], steps };
  }

  private holdUnverifiedEdits(
    edits: AssistantEdit[],
    structuralWarnings: PeStructuralWarning[] | undefined,
    ledgerEntries: readonly LedgerEntry[],
    assurance: ReturnType<typeof resolveInEditorAssurance>,
    mode: AssuranceRolloutMode,
    tenantId: string,
    contextPacketId: string | null,
  ): string | null {
    const editText = edits
      .map((edit) =>
        typeof edit.content === 'string' ? edit.content.replace(/<[^>]*>/g, ' ') : '',
      )
      .join('\n')
      .trim();
    if (!editText) return null;
    try {
      const ledger = buildControlledClaimLedger({
        output: editText,
        ledgerEntries,
        plan: assurance.plan,
        env: process.env,
        tenantId,
        surface: 'in-editor',
        callSite: 'holdUnverifiedEdits',
        logShadow: (event, fields) => this.logger.log(JSON.stringify({ event, ...fields })),
      });
      const grounding = runAuditor({
        output: editText,
        ledger: { entries: [...ledgerEntries] },
        surface: 'memo',
        mode: 'enforce',
      });
      const domainFindings = runGovernmentAffairsChecks({
        ledger,
        facts: [],
        outputText: editText,
      });
      const gate = evaluateAssuranceRelease({
        surface: 'in-editor',
        plan: assurance.plan,
        ledger,
        findings: [...grounding.findings, ...domainFindings],
        verificationAvailable: !(structuralWarnings ?? []).length,
      });
      // The generic gate creates an envelope for every evaluated surface. Bind
      // the persisted Context Packet identity in the metric without trusting a
      // browser-provided packet id; the destination still recomputes on apply.
      const envelopeHash = gate.envelope.hash.slice(0, 16);
      this.logger.log(
        metricLogLine(
          assuranceMetric({
            name: 'release_gate',
            dimensions: {
              surface: 'in-editor',
              domain: mode,
              outcome: gate.decision,
              category: assurance.plan.requestCategories.join(',').slice(0, 120),
              severity: grounding.topSeverity ?? undefined,
              jurisdiction: assurance.frame.jurisdictions.join(',').slice(0, 120),
              envelope: envelopeHash,
              context: contextPacketId ? 'persisted' : 'none',
            },
          }),
        ),
      );
      // Shadow computes the exact same ledger, findings, gate, and envelope but
      // returns the original edits byte-for-byte.
      if (mode !== 'enforce') return null;
      if (gate.decision !== 'repair' && gate.decision !== 'hold') return null;
      const reasons = gate.blockers
        .slice(0, 6)
        .map((reason) => `- ${reason}`)
        .join('\n');
      return [
        'I did not propose these edits, because required verification did not pass and an applied edit becomes the document.',
        reasons || '- One or more high-risk claims lacked authoritative same-turn support.',
        '',
        'Nothing was changed in your document. I did not treat an empty result, stale memory, or my own inference as proof — name the jurisdiction/vehicle/fiscal year, or restore the missing authoritative source, and ask me again.',
      ].join('\n');
    } catch (error) {
      this.logger.warn(
        `[meri-assurance] in-editor pre-release verification failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return mode === 'enforce'
        ? 'Verification was unavailable, so I did not propose edits to this document. Nothing was changed. Please try again once the authoritative sources are reachable.'
        : null;
    }
  }

  private async meterRound(ctx: MeriContext, resp: ToolLoopResponse): Promise<void> {
    await recordAiUsageEvent(
      { prisma: this.prisma, logger: this.logger },
      { tenantId: ctx.tenantId, userId: ctx.userId },
      'meriv2_in_editor',
      {
        provider: 'anthropic',
        model: resp.model,
        usage: resp.usage,
        usedTenantKey: resp.usedTenantKey,
      },
    );
  }

  private async fetchToolSchemas(signal: AbortSignal): Promise<AnthropicToolSchema[]> {
    const bearer = RequestCredentialsStore.get()?.bearerToken;
    if (!bearer) {
      this.logger.warn('in-editor: no bearer to fetch tool schemas; proceeding without data tools');
      return [];
    }
    try {
      const schemaControl = AbortSignal.any([signal, AbortSignal.timeout(5_000)]);
      const res = await withinEditorBudget(fetch(`${this.apiBaseUrl}/api/clio/tool-schemas?surface=in-editor`, {
        headers: { authorization: `Bearer ${bearer}`, accept: 'application/json' },
        signal: schemaControl,
      }), schemaControl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await withinEditorBudget(res.json(), schemaControl)) as { schemas?: AnthropicToolSchema[] };
      return selectMeriCapabilitySchemas(body.schemas ?? [], 'in_editor', this.registry.list());
    } catch (e) {
      this.logger.warn(`in-editor: tool-schema fetch failed (${(e as Error).message})`);
      return [];
    }
  }

  private captureGrounding(
    toolName: string,
    result: unknown,
    groundingBodies: string[],
    citedPeRecords: Map<string, PeRecordForValidation>,
  ): void {
    if (!result || typeof result !== 'object') return;
    const rec = result as Record<string, unknown>;
    if (typeof rec.error === 'string') return;

    const pe = rec.programElement as Record<string, unknown> | undefined;
    if (pe && typeof pe === 'object' && typeof pe.peCode === 'string') {
      citedPeRecords.set(pe.peCode, {
        peCode: pe.peCode,
        title: (pe.title as string | null) ?? null,
        service: (pe.service as string | null) ?? null,
        appropriationType: (pe.appropriationType as string | null) ?? null,
        budgetActivity: (pe.budgetActivity as string | null) ?? null,
        budgetActivityName: (pe.budgetActivityName as string | null) ?? null,
      });
    }
    const rows = Array.isArray(rec.data)
      ? rec.data
      : Array.isArray(rec.results)
        ? rec.results
        : pe
          ? [pe]
          : [];
    for (const row of (rows as unknown[]).slice(0, 5)) {
      const body = serializeRecordForGrounding(row);
      if (body) groundingBodies.push(`[${toolName}] ${body}`);
    }
  }

  private async verifyEdits(
    edits: AssistantEdit[],
    groundingBodies: string[],
    citedPeRecords: Map<string, PeRecordForValidation>,
    subjectId = 'in-editor',
    control?: ReturnType<typeof createMeriExecutionControl>,
  ): Promise<{ confidence?: Confidence; structuralWarnings?: PeStructuralWarning[] }> {
    try {
      const editText = edits
        .map((e) => (typeof e.content === 'string' ? e.content.replace(/<[^>]*>/g, ' ') : ''))
        .join('\n')
        .trim();
      if (!editText) return {};

      const pes = [...citedPeRecords.values()];
      for (const code of extractCitedPeCodes(editText)) {
        if (!citedPeRecords.has(code)) pes.push({ peCode: code });
      }
      const structuralWarnings = collectPeStructuralWarnings(pes, editText);

      return await this.verifyEditsInner(editText, groundingBodies, structuralWarnings, subjectId, control);
    } catch (e) {
      this.logger.warn(
        `in-editor verifyEdits failed (returning edits unannotated): ${(e as Error).message}`,
      );
      return {};
    }
  }

  private async verifyEditsInner(
    editText: string,
    groundingBodies: string[],
    structuralWarnings: PeStructuralWarning[],
    subjectId = 'in-editor',
    control?: ReturnType<typeof createMeriExecutionControl>,
  ): Promise<{ confidence?: Confidence; structuralWarnings?: PeStructuralWarning[] }> {
    let confidence: Confidence | undefined;
    if (this.verifierEnabled) {
      try {
        const sourceList = groundingBodies.length
          ? groundingBodies.map((b, i) => `[${i + 1}] ${b}`).join('\n')
          : '(no sources were retrieved)';
        control?.assertActive();
        const response = await this.llm.completeWithTools({
          system: VERIFIER_SYSTEM_PROMPT,
          messages: [{ role: 'user', content: `SOURCES:\n${sourceList}\n\nDOCUMENT:\n${editText.slice(0, 12_000)}` }],
          tools: [],
          toolChoice: 'none',
          maxTokens: 1500,
          anthropicEffort: 'low',
          timeoutMs: Math.max(1, Math.min(this.callTimeoutMs, (control?.deadlineAt ?? Date.now() + this.callTimeoutMs) - Date.now())),
          signal: control?.signal,
        });
        control?.assertActive();
        if (response.stopReason === 'max_tokens' || response.stopReason === 'refusal')
          throw new Error('Incomplete editor verification');
        const text = response.content.map(block =>
          block.type === 'text' && 'text' in block && typeof block.text === 'string' ? block.text : '',
        ).join('\n');
        const claims = parseVerifierClaims(text);
        if (claims.length) {
          confidence = confidenceLevel(summarizeVerification(claims).unsupportedRatio);
          this.persistClaims(subjectId, claims, groundingBodies);
        }
      } catch (e) {
        this.logger.warn(`in-editor verifyEdits grounding pass failed: ${(e as Error).message}`);
      }
    }

    return {
      confidence,
      structuralWarnings: structuralWarnings.length ? structuralWarnings : undefined,
    };
  }

  private persistClaims(
    subjectId: string,
    claims: Array<{ claim: string; supported: boolean; sourceIds: number[] }>,
    groundingBodies: string[],
  ): void {
    const bearer = RequestCredentialsStore.get()?.bearerToken;
    if (!bearer) return;
    const sources = groundingBodies.map((b, i) => ({
      n: i + 1,
      type: 'grounding',
      id: '',
      title: b.slice(0, 120),
      snippet: b.slice(0, 500),
    }));
    void fetch(`${this.apiBaseUrl}/api/clio/claims`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${bearer}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({ subjectType: 'document', subjectId, claims, sources }),
    })
      .then((res) => {
        if (!res.ok) this.logger.warn(`claim persist -> ${res.status}`);
      })
      .catch((e) => this.logger.warn(`claim persist failed (${(e as Error).message})`));
  }
}
