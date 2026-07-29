import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  assuranceMetric,
  assuranceReleaseArmedFor,
  metricLogLine,
  type MeriContext,
} from '@capiro/meriv2-core';
import { recordAiUsageEvent } from '@capiro/shared';
import { MeriRegistryService } from '../meri-registry.service.js';
import type {
  AnthropicToolSchema,
  RequestScopedLlmClient,
  ToolLoopResponse,
} from '../request-scoped-llm.client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  EMIT_EXTRACTED_FACTS_TOOL,
  buildStewardSystemPrompt,
  sanitizeConflicts,
  sanitizeExtractedFactsIndexed,
  type StewardExtractInput,
  type StewardExtractResult,
} from './steward-prompt.js';
import { assessStewardFacts } from './steward-assurance.js';

/** Extraction is a single bounded emission, not an agent loop — 8192 covers ≤80 facts. */
const MAX_TOKENS = 8192;

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim() : undefined;

/**
 * Context Steward extraction (Stage E) — ONE completeWithTools call with the
 * single strict terminal tool, toolChoice FORCED to emit_extracted_facts
 * (extraction is not conversational: there is nothing to converse about, so we
 * never burn rounds nudging prose). Runs on the request-scoped BYOK2 client
 * inside the controller's RequestCredentialsStore scope; each call meters one
 * ai_usage_events row (workflow meriv2_steward_extract). A model-call failure
 * is FAIL-SOFT: an empty result with a diagnostic summary — api-strategy treats
 * empty facts as a no-op, so a flaky model never blocks a document upload.
 * THE STEWARD NEVER MUTATES STRATEGY NODES — it only ever returns facts/
 * conflicts for api-strategy to persist into sp_context_*.
 */
@Injectable()
export class StewardExtractService {
  private readonly logger = new Logger(StewardExtractService.name);
  private readonly llm: RequestScopedLlmClient;
  private readonly callTimeoutMs: number;

  constructor(
    registryService: MeriRegistryService,
    config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    this.llm = registryService.llm;
    this.callTimeoutMs = Number.parseInt(config.get<string>('MERIV2_TIMEOUT_MS') ?? '120000', 10);
  }

  async extract(ctx: MeriContext, input: StewardExtractInput): Promise<StewardExtractResult> {
    const system = buildStewardSystemPrompt(input);
    let resp: ToolLoopResponse;
    try {
      resp = await this.llm.completeWithTools({
        system,
        messages: [
          {
            role: 'user',
            content: `Extract the facts from the ${input.templateKey} document above and pair any conflicts against the existing facts on record.`,
          },
        ],
        tools: [EMIT_EXTRACTED_FACTS_TOOL as AnthropicToolSchema],
        toolChoice: { type: 'tool', name: EMIT_EXTRACTED_FACTS_TOOL.name },
        maxTokens: MAX_TOKENS,
        timeoutMs: this.callTimeoutMs,
      });
    } catch (e) {
      const msg = (e as Error).message;
      this.logger.warn(`steward extract model call failed (fail-soft): ${msg}`);
      return { facts: [], conflicts: [], summary: `extraction failed: ${msg}` };
    }
    void this.meterRound(ctx, resp, 'meriv2_steward_extract');

    const terminal = resp.content.find(
      (b): b is { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> } =>
        b.type === 'tool_use' && (b as { name?: unknown }).name === EMIT_EXTRACTED_FACTS_TOOL.name,
    );
    const raw = terminal?.input ?? {};
    // Conflicts are remapped from the model's raw fact positions to the
    // sanitized array the wire response carries (wire contract 1: newFactIndex
    // indexes the RETURNED facts array).
    const { facts, rawIndexToSanitized } = sanitizeExtractedFactsIndexed(raw.facts);
    const conflicts = sanitizeConflicts(raw.conflicts, rawIndexToSanitized);
    const summary = str(raw.summary) ?? '';

    // PRE-PERSISTENCE GATE. api-strategy persists every fact returned here into
    // sp_context_fact, from which the Strategy context pack later reads it as
    // established client context — so a high-risk figure anchored to an anchor
    // that is not in the document's closed set would launder itself into
    // authority. This is the only point before that write that the orchestrator
    // controls.
    //
    // DARK BY DEFAULT: the verdicts and the metric are always computed (so the
    // hold can be observed before it is armed), but nothing is withheld unless
    // `steward` is explicitly named in MERI_RELEASE_GATE_SURFACES. With it unset
    // the response is byte-identical to before.
    const armed = assuranceReleaseArmedFor(process.env.MERI_RELEASE_GATE_SURFACES, 'steward');
    const assessed = assessStewardFacts({
      facts,
      conflicts,
      refs: input.refs ?? [],
      templateKey: input.templateKey,
      ...(input.clientId ? { clientId: input.clientId } : {}),
      armed,
    });
    this.logger.log(
      metricLogLine(
        assuranceMetric({
          name: 'release_gate',
          value: assessed.heldCount,
          dimensions: {
            surface: 'steward',
            domain: armed ? 'enforce' : 'observe',
            outcome: assessed.gate.decision,
            category: input.templateKey,
          },
        }),
      ),
    );
    if (armed && assessed.heldCount > 0) {
      this.logger.warn(
        `[meri-assurance] steward held ${assessed.heldCount} high-risk fact(s) with unresolved anchors (document ${input.documentId})`,
      );
    }
    return {
      facts: assessed.facts,
      conflicts: assessed.conflicts,
      // Say so in the summary the reviewer reads, rather than silently returning
      // fewer facts than the document contains.
      summary:
        armed && assessed.heldCount > 0
          ? [
              summary,
              `${assessed.heldCount} high-risk fact(s) were withheld because their cited document anchor did not resolve. They were NOT saved. Re-check the document's headings/rows and re-run extraction.`,
            ]
              .filter(Boolean)
              .join('\n\n')
          : summary,
    };
  }

  /** Clone of strategy-assistant.service.ts's meterRound (Phase 1 M5.0 H-1). */
  private async meterRound(
    ctx: MeriContext,
    resp: ToolLoopResponse,
    workflow: string,
  ): Promise<void> {
    await recordAiUsageEvent(
      { prisma: this.prisma, logger: this.logger },
      { tenantId: ctx.tenantId, userId: ctx.userId },
      workflow,
      {
        provider: 'anthropic',
        model: resp.model,
        usage: resp.usage,
        usedTenantKey: resp.usedTenantKey,
      },
    );
  }
}
