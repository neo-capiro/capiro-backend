import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { MeriContext } from '@capiro/meriv2-core';
import { recordAiUsageEvent } from '@capiro/shared';
import { MeriRegistryService } from '../meri-registry.service.js';
import {
  RequestScopedLlmClient,
  type AnthropicToolSchema,
  type ToolLoopResponse,
} from '../request-scoped-llm.client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { StrategyContextPackService, type PackProvenance } from './strategy-context-pack.service.js';
import {
  PROPOSE_PLAN_EDITS_TOOL,
  PROPOSE_REFERENCE_EDITS_TOOL,
  PROPOSE_STRATEGY_DRAFT_TOOL,
  buildAssistantSystemPrompt,
  buildDraftSystemPrompt,
  buildReferenceSystemPrompt,
  sanitizeDraftNodes,
  sanitizePlanEdits,
  sanitizeRefRows,
  type StrategyAssistantInput,
  type StrategyDraftInput,
  type StrategyReferenceAssistInput,
} from './strategy-prompt.js';

const MAX_ROUNDS = 8;
const MAX_TOKENS = 8192;

interface ContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

interface TerminalResult {
  input: Record<string, unknown> | null;
  text: string;
}

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim() : undefined;

/**
 * Strategy Planner Meri loop (G5) — clones the in-editor assistant shape
 * (bounded ≤8 rounds, Sonnet via the request-scoped BYOK2 client, per-round
 * ai_usage metering) but departs by pre-compiling the Client Context Pack and
 * running NO read tools in the loop: the only tool is the terminal
 * propose_strategy_draft / propose_plan_edits / propose_reference_edits. Runs
 * inside the controller's RequestCredentialsStore scope (bearer for the pack's
 * delegated reads + tenant key for the LLM). Returns typed output; api-strategy
 * re-validates + applies.
 */
@Injectable()
export class StrategyAssistantService {
  private readonly logger = new Logger(StrategyAssistantService.name);
  private readonly llm: RequestScopedLlmClient;
  private readonly callTimeoutMs: number;

  constructor(
    registryService: MeriRegistryService,
    config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly pack: StrategyContextPackService,
  ) {
    this.llm = registryService.llm;
    this.callTimeoutMs = Number.parseInt(config.get<string>('MERIV2_TIMEOUT_MS') ?? '120000', 10);
  }

  async draft(ctx: MeriContext, input: StrategyDraftInput) {
    const pack = await this.pack.compile({
      ctx,
      clientId: input.clientId,
      query: input.goal ?? '',
      slim: false,
    });
    const system = buildDraftSystemPrompt(input, pack.text);
    const userText = input.goal?.trim()
      ? `Draft the ${input.type} strategy for this goal: ${input.goal.trim()}`
      : `Draft a ${input.type} strategy for this client.`;
    const result = await this.runTerminal(system, userText, PROPOSE_STRATEGY_DRAFT_TOOL, ctx, 'meriv2_strategy_draft');
    const summary = str(result.input?.summary) ?? result.text ?? 'Drafted a plan from your goal.';
    const nodes = sanitizeDraftNodes(result.input?.nodes);
    return { summary, nodes, provenance: pack.provenance };
  }

  async assistant(ctx: MeriContext, input: StrategyAssistantInput) {
    const pack = await this.pack.compile({
      ctx,
      clientId: input.clientId,
      query: input.instruction,
      slim: true,
    });
    const system = buildAssistantSystemPrompt(input, pack.text);
    const result = await this.runTerminal(system, input.instruction, PROPOSE_PLAN_EDITS_TOOL, ctx, 'meriv2_strategy_edit');
    return {
      reply: str(result.input?.reply) ?? result.text ?? 'Done.',
      summary: str(result.input?.summary) ?? null,
      edits: sanitizePlanEdits(result.input?.edits),
      provenance: pack.provenance,
    };
  }

  async referenceAssist(ctx: MeriContext, input: StrategyReferenceAssistInput) {
    const system = buildReferenceSystemPrompt(input);
    const result = await this.runTerminal(system, input.instruction, PROPOSE_REFERENCE_EDITS_TOOL, ctx, 'meriv2_strategy_edit');
    // No structured rows from the model → return the working set unchanged.
    const rows = result.input ? sanitizeRefRows(result.input.rows) : (input.rows as Array<Record<string, unknown>>);
    return { reply: str(result.input?.reply) ?? result.text ?? '', rows };
  }

  /**
   * Bounded loop with a SINGLE terminal tool. The model either calls it (→ its
   * validated input) or replies in prose; a prose-only round is nudged once to
   * use the tool, and on budget exhaustion a tool-free synthesis returns text.
   */
  private async runTerminal(
    system: string,
    userText: string,
    tool: { name: string },
    ctx: MeriContext,
    workflow: string,
  ): Promise<TerminalResult> {
    const messages: Array<{ role: 'user' | 'assistant'; content: unknown }> = [
      { role: 'user', content: userText },
    ];
    let lastText = '';

    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      let resp: ToolLoopResponse;
      try {
        resp = await this.llm.completeWithTools({
          system,
          messages,
          tools: [tool as AnthropicToolSchema],
          maxTokens: MAX_TOKENS,
          timeoutMs: this.callTimeoutMs,
        });
      } catch (e) {
        this.logger.warn(`strategy ${workflow} model call failed: ${(e as Error).message}`);
        return { input: null, text: 'Sorry — I hit an error reaching the model. Please try again.' };
      }
      void this.meterRound(ctx, resp, workflow);

      const content = resp.content as ContentBlock[];
      lastText = content
        .filter((b) => b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text as string)
        .join('\n')
        .trim();
      const terminal = content.find(
        (b): b is ContentBlock & { name: string; input?: Record<string, unknown> } =>
          b.type === 'tool_use' && b.name === tool.name,
      );
      if (terminal) {
        return { input: terminal.input ?? {}, text: lastText };
      }
      // Prose-only round: nudge once to use the terminal tool, then keep going.
      messages.push({ role: 'assistant', content });
      messages.push({
        role: 'user',
        content: `Return your answer by calling the ${tool.name} tool.`,
      });
    }

    // Budget spent without a tool call — force a tool-free synthesis for a reply.
    try {
      const resp = await this.llm.completeWithTools({
        system: `${system}\n\n# FINISH NOW\nYou have used your budget. Do NOT call any tool. Reply in prose with your recommendation.`,
        messages,
        tools: [tool as AnthropicToolSchema],
        toolChoice: 'none',
        maxTokens: MAX_TOKENS,
        timeoutMs: this.callTimeoutMs,
      });
      void this.meterRound(ctx, resp, workflow);
      const text = (resp.content as ContentBlock[])
        .filter((b) => b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text as string)
        .join('\n')
        .trim();
      if (text) lastText = text;
    } catch (e) {
      this.logger.warn(`strategy ${workflow} synthesis failed: ${(e as Error).message}`);
    }
    return { input: null, text: lastText || 'I could not complete that — please try again.' };
  }

  private async meterRound(ctx: MeriContext, resp: ToolLoopResponse, workflow: string): Promise<void> {
    await recordAiUsageEvent(
      { prisma: this.prisma, logger: this.logger },
      { tenantId: ctx.tenantId, userId: ctx.userId },
      workflow,
      { provider: 'anthropic', model: resp.model, usage: resp.usage, usedTenantKey: resp.usedTenantKey },
    );
  }
}

/** Re-export for the controller's response typing. */
export type { PackProvenance };
