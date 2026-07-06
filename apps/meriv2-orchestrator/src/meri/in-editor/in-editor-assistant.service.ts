import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  collectPeStructuralWarnings,
  confidenceLevel,
  extractCitedPeCodes,
  parseVerifierClaims,
  serializeRecordForGrounding,
  summarizeVerification,
  type Confidence,
  type MeriContext,
  type PeRecordForValidation,
  type PeStructuralWarning,
  type ToolRegistry,
} from '@capiro/meriv2-core';
import { MeriRegistryService } from '../meri-registry.service.js';
import { RequestScopedLlmClient, type AnthropicToolSchema } from '../request-scoped-llm.client.js';
import { RequestCredentialsStore } from '../../request/request-credentials.store.js';
import {
  ASSISTANT_TOOLS,
  PROPOSE_EDITS_TOOL,
  buildSystemPrompt,
  sanitizeEdits,
  toolLabel,
  type AssistantEdit,
  type AssistantResult,
  type AssistantStep,
  type InEditorInput,
} from './in-editor-prompt.js';

/** System prompt for the cheap grounding-claims pass (mirrors apps/api's verifier). */
const VERIFIER_SYSTEM_PROMPT =
  'You are a strict grounding verifier for a government-affairs assistant. Given SOURCES and a ' +
  "DOCUMENT, extract the document's distinct factual claims (skip headings, opinions, and " +
  'generic advice). For each claim decide whether the SOURCES substantiate it. Return ONLY JSON: ' +
  '{"claims":[{"claim":"<short paraphrase>","supported":true|false,"sourceIds":[<source numbers>]}]}. ' +
  'Mark supported=true only when a listed source backs the claim. Be conservative: if unsure, use ' +
  'supported=false with sourceIds [].';

const MAX_ROUNDS = 5;
const MAX_TOKENS = 4096;
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
 * MeriV2-served in-editor assistant (A3). Reproduces apps/api's bounded,
 * READ-ONLY agentic loop, but tool execution goes through the orchestrator
 * registry (scoped + gated) and the model runs on the tenant's key (BYOK2, via
 * RequestScopedLlmClient). Tool JSON-schemas are fetched from apps/api at
 * request time so definitions stay single-sourced. The loop must run inside a
 * RequestCredentialsStore scope (the controller sets it) so both the delegated
 * tool calls (bearer) and the LLM (tenant credential) resolve.
 *
 * v1 returns { reply, edits, steps }; the fail-open grounding/structural
 * enrichment (confidence/structuralWarnings) is a follow-up — omitting it
 * matches the legacy path with the verifier disabled.
 */
@Injectable()
export class InEditorAssistantService {
  private readonly logger = new Logger(InEditorAssistantService.name);
  private readonly registry: ToolRegistry;
  private readonly llm: RequestScopedLlmClient;
  private readonly apiBaseUrl: string;
  private readonly callTimeoutMs: number;
  /** Mirrors apps/api's CLIO_VERIFIER_ENABLED — fail-open enrichment, off by default. */
  private readonly verifierEnabled: boolean;

  constructor(registryService: MeriRegistryService, config: ConfigService) {
    this.registry = registryService.registry;
    // Reuse the ONE request-scoped LLM client (BYOK2) the registry built — the
    // single global-key-read site lives in MeriRegistryService, so this surface
    // stays BYOK4-clean (never reads the global Anthropic env key itself). The
    // tenant key wins per-request; the default model is the orchestrator's (Sonnet).
    this.llm = registryService.llm;
    this.callTimeoutMs = Number.parseInt(config.get<string>('MERIV2_TIMEOUT_MS') ?? '120000', 10);
    this.apiBaseUrl = (
      config.get<string>('MERIV2_API_BASE_URL') ?? 'http://localhost:3000'
    ).replace(/\/+$/, '');
    this.verifierEnabled = config.get<string>('CLIO_VERIFIER_ENABLED') === 'true';
  }

  async run(ctx: MeriContext, dto: InEditorInput): Promise<AssistantResult> {
    const messages: Array<{ role: 'user' | 'assistant'; content: unknown }> = (dto.messages ?? [])
      .filter(
        (m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.text === 'string',
      )
      .slice(-20)
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.text as string }));
    if (!messages.length || messages[messages.length - 1]?.role !== 'user') {
      return { reply: 'What would you like me to do with this document?', edits: [] };
    }

    const system = buildSystemPrompt(dto);
    const toolSchemas = [...(await this.fetchToolSchemas()), PROPOSE_EDITS_TOOL];
    const steps: AssistantStep[] = [];
    // Grounding capture for the post-turn verifier + structural pass (parity
    // with apps/api's legacy in-editor verifyEdits).
    const groundingBodies: string[] = [];
    const citedPeRecords = new Map<string, PeRecordForValidation>();

    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      let content: ContentBlock[];
      let stopReason: string | null;
      try {
        const resp = await this.llm.completeWithTools({
          system,
          messages,
          tools: toolSchemas as AnthropicToolSchema[],
          maxTokens: MAX_TOKENS,
          timeoutMs: this.callTimeoutMs,
        });
        content = resp.content as ContentBlock[];
        stopReason = resp.stopReason;
      } catch (e) {
        this.logger.warn(`in-editor model call failed: ${(e as Error).message}`);
        return {
          reply: 'Sorry — I hit an error reaching the model. Please try again in a moment.',
          edits: [],
        };
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

      // Terminal: the model proposed its answer (+ optional edits).
      const propose = toolUses.find((t) => t.name === 'propose_document_edits');
      if (propose) {
        const input = propose.input ?? {};
        const reply = typeof input.reply === 'string' && input.reply.trim() ? input.reply : textOut;
        const edits = sanitizeEdits(input.edits);
        const { confidence, structuralWarnings } = await this.verifyEdits(
          edits,
          groundingBodies,
          citedPeRecords,
        );
        return { reply: reply || 'Done.', edits, confidence, structuralWarnings, steps };
      }

      // No tools requested → plain conversational answer.
      if (!toolUses.length || stopReason !== 'tool_use') {
        return { reply: textOut || 'Done.', edits: [], steps };
      }

      // Execute the requested read-only data tools through the registry and feed
      // results back. The registry enforces scoping (and would gate any write —
      // none are in the allowlist).
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
              result = await this.registry.invoke(tu.name, tu.input ?? {}, ctx);
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
      steps,
    };
  }

  /**
   * Fetch the Anthropic tool schemas from apps/api (single source) with the
   * caller's bearer, filtered to the read-only allowlist. On failure, degrade to
   * no data tools (the model can still reply, just without lookups).
   */
  private async fetchToolSchemas(): Promise<AnthropicToolSchema[]> {
    const bearer = RequestCredentialsStore.get()?.bearerToken;
    if (!bearer) {
      this.logger.warn('in-editor: no bearer to fetch tool schemas; proceeding without data tools');
      return [];
    }
    try {
      const res = await fetch(`${this.apiBaseUrl}/api/clio/tool-schemas`, {
        headers: { authorization: `Bearer ${bearer}`, accept: 'application/json' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { schemas?: AnthropicToolSchema[] };
      return (body.schemas ?? []).filter((s) => ASSISTANT_TOOLS.has(s.name));
    } catch (e) {
      this.logger.warn(`in-editor: tool-schema fetch failed (${(e as Error).message})`);
      return [];
    }
  }

  /**
   * Capture rich grounding bodies + cited PE records from a read-only tool
   * result, so the post-turn verifier sees the SAME records the model saw (not
   * a stub) and the structural validator can check PE category/mission.
   * Mirrors apps/api's legacy in-editor captureGrounding.
   */
  private captureGrounding(
    toolName: string,
    result: unknown,
    groundingBodies: string[],
    citedPeRecords: Map<string, PeRecordForValidation>,
  ): void {
    if (!result || typeof result !== 'object') return;
    const rec = result as Record<string, unknown>;
    if (typeof rec.error === 'string') return;

    // PE detail tools carry the typed record we validate structurally.
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
    // Any list rows / detail object → grounding text for the verifier.
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

  /**
   * Run the SAME grounding + structural pass as apps/api's legacy in-editor
   * assistant on the proposed edits: (1) deterministic PE structural checks
   * (RDT&E vs procurement, capability/mission mismatch, primary-vehicle
   * overclaim) against any cited PE records; (2) a cheap grounding verifier
   * over the edit text vs the retrieved records. Fail-open + flag-gated
   * (CLIO_VERIFIER_ENABLED) — never blocks the edits. Runs on the request-scoped
   * LLM client (BYOK-clean — no direct global-key read here).
   */
  private async verifyEdits(
    edits: AssistantEdit[],
    groundingBodies: string[],
    citedPeRecords: Map<string, PeRecordForValidation>,
  ): Promise<{ confidence?: Confidence; structuralWarnings?: PeStructuralWarning[] }> {
    try {
      const editText = edits
        .map((e) => (typeof e.content === 'string' ? e.content.replace(/<[^>]*>/g, ' ') : ''))
        .join('\n')
        .trim();
      if (!editText) return {};

      // (1) Deterministic structural checks — also validate PEs cited in the
      // edit text even if no detail tool ran (so a bad seed PE is still flagged).
      const pes = [...citedPeRecords.values()];
      for (const code of extractCitedPeCodes(editText)) {
        if (!citedPeRecords.has(code)) pes.push({ peCode: code });
      }
      const structuralWarnings = collectPeStructuralWarnings(pes, editText);

      return await this.verifyEditsInner(editText, groundingBodies, structuralWarnings);
    } catch (e) {
      // Non-essential enrichment: never let it fail the turn. Return edits
      // unannotated.
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
  ): Promise<{ confidence?: Confidence; structuralWarnings?: PeStructuralWarning[] }> {
    let confidence: Confidence | undefined;
    if (this.verifierEnabled) {
      try {
        const sourceList = groundingBodies.length
          ? groundingBodies.map((b, i) => `[${i + 1}] ${b}`).join('\n')
          : '(no sources were retrieved)';
        const raw = await this.llm.completeJson({
          system: VERIFIER_SYSTEM_PROMPT,
          prompt: `SOURCES:\n${sourceList}\n\nDOCUMENT:\n${editText.slice(0, 12_000)}`,
          maxTokens: 1500,
        });
        const claims = parseVerifierClaims(JSON.stringify(raw));
        if (claims.length) {
          confidence = confidenceLevel(summarizeVerification(claims).unsupportedRatio);
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
}
