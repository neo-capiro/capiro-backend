import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  assuranceMetric,
  metricLogLine,
  resolveAssuranceRolloutMode,
  summarizeAssuranceEnvelope,
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

const MAX_TOKENS = 8192;

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim() : undefined;

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
    const { facts, rawIndexToSanitized } = sanitizeExtractedFactsIndexed(raw.facts);
    const conflicts = sanitizeConflicts(raw.conflicts, rawIndexToSanitized);
    const summary = str(raw.summary) ?? '';

    const mode = resolveAssuranceRolloutMode({
      globalModeRaw: process.env.MERI_RELEASE_GATE,
      tenantCanariesRaw: process.env.MERI_RELEASE_GATE_TENANTS,
      surfacesRaw: process.env.MERI_RELEASE_GATE_SURFACES,
      tenantId: ctx.tenantId,
      surface: 'steward',
    });
    const assessed = assessStewardFacts({
      facts,
      conflicts,
      refs: input.refs ?? [],
      templateKey: input.templateKey,
      ...(input.clientId ? { clientId: input.clientId } : {}),
      contextPacketId: ctx.contextPacket?.persisted ? (ctx.contextPacket.packetId ?? null) : null,
      mode,
    });
    const envelope = summarizeAssuranceEnvelope(assessed.envelope);
    this.logger.log(
      metricLogLine(
        assuranceMetric({
          name: 'release_gate',
          value: assessed.heldCount,
          dimensions: {
            surface: 'steward',
            domain: mode,
            outcome: assessed.gate.decision,
            category: input.templateKey,
            envelope: envelope.hash.slice(0, 16),
          },
        }),
      ),
    );
    if (mode === 'enforce' && assessed.heldCount > 0) {
      this.logger.warn(
        `[meri-assurance] steward held ${assessed.heldCount} high-risk fact(s) with unresolved anchors (document ${input.documentId}; envelope ${envelope.hash.slice(0, 16)})`,
      );
    }
    return {
      facts: assessed.facts,
      conflicts: assessed.conflicts,
      summary:
        mode === 'enforce' && assessed.heldCount > 0
          ? [
              summary,
              `${assessed.heldCount} high-risk fact(s) were withheld because their cited document anchor did not resolve. They were NOT saved. Re-check the document's headings/rows and re-run extraction.`,
            ]
              .filter(Boolean)
              .join('\n\n')
          : summary,
    };
  }

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
