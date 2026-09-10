import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { checkGroundedCitations, type GroundedClaim, type MeriContext } from '@capiro/meriv2-core';
import { recordAiUsageEvent } from '@capiro/shared';
import { MeriRegistryService } from '../meri-registry.service.js';
import {
  RequestScopedLlmClient,
  type AnthropicToolSchema,
  type ToolLoopResponse,
} from '../request-scoped-llm.client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  composeReportNarrativePrompt,
  MAX_NARRATIVE_PARAGRAPHS_PER_SECTION,
  PROPOSE_REPORT_NARRATIVE_TOOL,
  REPORT_NARRATIVE_SECTION_IDS,
  type ReportNarrativeInput,
  type ReportNarrativeSectionId,
} from './strategy-report-narrative.prompt.js';

// One forced tool call is enough: the packet is complete and the tool schema
// is the whole answer, so there is no read-tool loop to run.
const MAX_TOKENS = 8192;
const WORKFLOW = 'meriv2_strategy_report_narrative';

export interface ReportNarrativeParagraph {
  text: string;
  evidenceIds: string[];
}

export interface ReportNarrativeSectionOut {
  id: ReportNarrativeSectionId;
  paragraphs: ReportNarrativeParagraph[];
}

export interface ReportNarrativeResponse {
  sections: ReportNarrativeSectionOut[];
  model: string | null;
  generatedAt: string;
  usage: { inputTokens: number; outputTokens: number };
  attempts: number;
  droppedParagraphs: number;
  usedFallback: boolean;
}

interface ContentBlock {
  type: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
}

/**
 * Executive-report narrative generator. Runs ONE forced terminal-tool call on
 * the request-scoped BYOK client (tenant key when present, else the global
 * key), re-validates the tool input structurally, then applies the shared
 * GroundedJson citation gate (every cited id must exist; every quoted
 * substring must appear in cited evidence). Paragraphs that fail are dropped,
 * never repaired. api-strategy runs its own stricter verifier on top.
 */
@Injectable()
export class StrategyReportNarrativeService {
  private readonly logger = new Logger(StrategyReportNarrativeService.name);
  private readonly llm: RequestScopedLlmClient;
  private readonly callTimeoutMs: number;

  constructor(
    registryService: MeriRegistryService,
    config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    this.llm = registryService.llm;
    this.callTimeoutMs = Number.parseInt(
      config.get<string>('STRATEGY_REPORT_NARRATIVE_TIMEOUT_MS') ??
        config.get<string>('MERIV2_TIMEOUT_MS') ??
        '60000',
      10,
    );
  }

  async generate(ctx: MeriContext, input: ReportNarrativeInput): Promise<ReportNarrativeResponse> {
    const { system, user } = composeReportNarrativePrompt(input);
    const usage = { inputTokens: 0, outputTokens: 0 };
    let attempts = 0;
    let model: string | null = null;

    const call = async (extraSystem?: string): Promise<Record<string, unknown> | null> => {
      attempts += 1;
      const started = Date.now();
      const resp: ToolLoopResponse = await this.llm.completeWithTools({
        system: extraSystem ? `${system}\n\n${extraSystem}` : system,
        messages: [{ role: 'user', content: user }],
        tools: [PROPOSE_REPORT_NARRATIVE_TOOL as unknown as AnthropicToolSchema],
        toolChoice: { type: 'tool', name: PROPOSE_REPORT_NARRATIVE_TOOL.name },
        maxTokens: MAX_TOKENS,
        timeoutMs: this.callTimeoutMs,
      });
      usage.inputTokens += resp.usage.inputTokens ?? 0;
      usage.outputTokens += resp.usage.outputTokens ?? 0;
      model = resp.model ?? model;
      this.logger.log(
        `strategy ${WORKFLOW} attempt ${attempts}: ${Date.now() - started}ms` +
          `${resp.model ? ` model=${resp.model}` : ''} stop=${resp.stopReason ?? 'n/a'}`,
      );
      void this.meter(ctx, resp);
      if (resp.stopReason === 'refusal') {
        this.logger.warn(
          `strategy ${WORKFLOW} refused` +
            (resp.stopDetails?.category ? ` (category=${resp.stopDetails.category})` : ''),
        );
        return null;
      }
      const terminal = (resp.content as ContentBlock[]).find(
        (block) => block.type === 'tool_use' && block.name === PROPOSE_REPORT_NARRATIVE_TOOL.name,
      );
      return terminal?.input ?? null;
    };

    let parsed = sanitizeSections(await call(), input);
    if (parsed.sections.length === 0 && parsed.problems.length > 0) {
      // ONE bounded re-prompt that names what was wrong, mirroring GroundedJson.
      parsed = sanitizeSections(
        await call(
          `Your previous response did not match the required shape (${parsed.problems
            .slice(0, 6)
            .join('; ')}). Call the tool again with corrected, fully-valid input.`,
        ),
        input,
      );
    }

    // Shared citation gate: unknown ids and unverifiable quotes drop the paragraph.
    const claims: GroundedClaim[] = parsed.sections.flatMap((section) =>
      section.paragraphs.map((paragraph) => ({
        text: paragraph.text,
        evidenceIds: paragraph.evidenceIds,
      })),
    );
    const gate = checkGroundedCitations(claims, input.evidence);
    const dropped = new Set(gate.dropped.map((entry) => entry.claim.text));
    const sections = parsed.sections
      .map((section) => ({
        ...section,
        paragraphs: section.paragraphs.filter((paragraph) => !dropped.has(paragraph.text)),
      }))
      .filter((section) => section.paragraphs.length > 0);
    if (gate.dropped.length > 0) {
      this.logger.warn(
        `strategy ${WORKFLOW} dropped ${gate.dropped.length} paragraph(s): ${gate.dropped
          .map((entry) => entry.reason)
          .join(', ')}`,
      );
    }

    return {
      sections,
      model,
      generatedAt: new Date().toISOString(),
      usage,
      attempts,
      droppedParagraphs: gate.dropped.length,
      usedFallback: sections.length === 0,
    };
  }

  private async meter(ctx: MeriContext, resp: ToolLoopResponse): Promise<void> {
    await recordAiUsageEvent(
      { prisma: this.prisma, logger: this.logger },
      { tenantId: ctx.tenantId, userId: ctx.userId },
      WORKFLOW,
      {
        provider: 'anthropic',
        model: resp.model,
        usage: resp.usage,
        usedTenantKey: resp.usedTenantKey,
      },
    );
  }
}

/**
 * Structural re-validation of the model's tool input. `strict: true` is
 * stripped for models without GA structured outputs, so nothing about the
 * shape is trusted: unknown or duplicate sections, non-string text, empty or
 * non-string citations, oversized text and markdown/bullet artefacts are all
 * rejected here, and the problems are reported for the single re-prompt.
 */
export function sanitizeSections(
  raw: Record<string, unknown> | null,
  input: ReportNarrativeInput,
): { sections: ReportNarrativeSectionOut[]; problems: string[] } {
  const problems: string[] = [];
  if (!raw) return { sections: [], problems: ['no tool call was returned'] };
  const list = Array.isArray(raw.sections) ? raw.sections : null;
  if (!list) return { sections: [], problems: ['sections must be an array'] };
  const allowed = new Set<string>(input.sections);
  const seen = new Set<string>();
  const sections: ReportNarrativeSectionOut[] = [];
  const maxParagraphs = Math.min(
    input.maxParagraphsPerSection,
    MAX_NARRATIVE_PARAGRAPHS_PER_SECTION,
  );
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id : '';
    if (!(REPORT_NARRATIVE_SECTION_IDS as readonly string[]).includes(id) || !allowed.has(id)) {
      problems.push(`unknown section id "${id}"`);
      continue;
    }
    if (seen.has(id)) {
      problems.push(`duplicate section "${id}"`);
      continue;
    }
    seen.add(id);
    const paragraphsRaw = Array.isArray(record.paragraphs) ? record.paragraphs : [];
    const paragraphs: ReportNarrativeParagraph[] = [];
    for (const paragraph of paragraphsRaw.slice(0, maxParagraphs)) {
      if (!paragraph || typeof paragraph !== 'object') continue;
      const value = paragraph as Record<string, unknown>;
      const text = typeof value.text === 'string' ? value.text.replace(/\s+/g, ' ').trim() : '';
      const evidenceIds = Array.isArray(value.evidenceIds)
        ? [
            ...new Set(
              value.evidenceIds.filter(
                (item): item is string => typeof item === 'string' && item.trim().length > 0,
              ),
            ),
          ]
        : [];
      if (text.length < 20 || text.length > 1_400) {
        problems.push(`${id}: paragraph text must be 20–1400 characters`);
        continue;
      }
      if (evidenceIds.length === 0) {
        problems.push(`${id}: a paragraph cited no evidence ids`);
        continue;
      }
      if (/^[-*•]\s|[\[\]{}<>#]|\*\*/.test(text)) {
        problems.push(`${id}: prose must be plain text without markdown, bullets or brackets`);
        continue;
      }
      paragraphs.push({ text, evidenceIds });
    }
    if (paragraphs.length > 0) sections.push({ id: id as ReportNarrativeSectionId, paragraphs });
  }
  return { sections, problems };
}
