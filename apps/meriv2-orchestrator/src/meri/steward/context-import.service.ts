import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { MeriContext } from '@capiro/meriv2-core';
import { recordAiUsageEvent } from '@capiro/shared';
import { MeriRegistryService } from '../meri-registry.service.js';
import type {
  AnthropicToolSchema,
  RequestScopedLlmClient,
  ToolLoopResponse,
} from '../request-scoped-llm.client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  buildContextImportSystemPrompt,
  ContextImportValidationError,
  EMIT_CONTEXT_IMPORT_TOOL,
  sanitizeContextImportResult,
  validateContextImportInput,
  type StrategyContextImportInput,
  type StrategyContextImportResult,
} from './context-import-prompt.js';
import {
  buildContextCompareSystemPrompt,
  EMIT_CONTEXT_COMPARISON_TOOL,
  sanitizeContextCompareResult,
  validateContextCompareInput,
  type StrategyContextCompareInput,
  type StrategyContextCompareResult,
} from './context-compare-prompt.js';

const MAX_TOKENS = 8192;
const MAX_TIMEOUT_MS = 50_000;

/** One bounded, source-only conversion; api-strategy owns review and persistence. */
@Injectable()
export class ContextImportService {
  private readonly logger = new Logger(ContextImportService.name);
  private readonly llm: RequestScopedLlmClient;
  private readonly callTimeoutMs: number;

  constructor(
    registryService: MeriRegistryService,
    config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    this.llm = registryService.llm;
    const configured = Number.parseInt(
      config.get<string>('MERIV2_CONTEXT_IMPORT_TIMEOUT_MS') ?? '',
      10,
    );
    this.callTimeoutMs =
      Number.isFinite(configured) && configured > 0
        ? Math.min(configured, MAX_TIMEOUT_MS)
        : MAX_TIMEOUT_MS;
  }

  validateInput(raw: unknown): StrategyContextImportInput {
    try {
      return validateContextImportInput(raw);
    } catch (error) {
      if (error instanceof ContextImportValidationError) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }
  }

  async import(
    ctx: MeriContext,
    raw: StrategyContextImportInput,
  ): Promise<StrategyContextImportResult> {
    const input = this.validateInput(raw);
    const response = await this.complete(
      ctx,
      input,
      buildContextImportSystemPrompt(),
      EMIT_CONTEXT_IMPORT_TOOL as unknown as AnthropicToolSchema,
      MAX_TOKENS,
      'meriv2_strategy_context_import',
    );
    try {
      return {
        ...sanitizeContextImportResult(response.input, input),
        model: response.model,
      };
    } catch (error) {
      this.invalidOutput(error);
    }
  }

  validateComparison(raw: unknown): StrategyContextCompareInput {
    try {
      return validateContextCompareInput(raw);
    } catch (error) {
      if (error instanceof ContextImportValidationError)
        throw new BadRequestException(error.message);
      throw error;
    }
  }

  async compare(
    ctx: MeriContext,
    raw: StrategyContextCompareInput,
  ): Promise<StrategyContextCompareResult> {
    const input = this.validateComparison(raw);
    const response = await this.complete(
      ctx,
      input,
      buildContextCompareSystemPrompt(),
      EMIT_CONTEXT_COMPARISON_TOOL as unknown as AnthropicToolSchema,
      4096,
      'meriv2_strategy_context_compare',
    );
    try {
      return sanitizeContextCompareResult(response.input, input);
    } catch (error) {
      this.invalidOutput(error);
    }
  }

  private async complete(
    ctx: MeriContext,
    input: StrategyContextImportInput | StrategyContextCompareInput,
    system: string,
    tool: AnthropicToolSchema,
    maxTokens: number,
    workflow: string,
  ): Promise<{ input: unknown; model: string }> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let response: ToolLoopResponse;
    try {
      // Overall deadline bounds retries/failover as well as each network attempt.
      // Promise.race also prevents a non-cooperative adapter holding the request.
      response = await Promise.race([
        this.llm.completeWithTools({
          system,
          messages: [{ role: 'user', content: JSON.stringify(input) }],
          tools: [tool],
          toolChoice: { type: 'tool', name: tool.name },
          maxTokens,
          timeoutMs: this.callTimeoutMs,
          signal: controller.signal,
        }),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error('Context import deadline reached'));
          }, this.callTimeoutMs);
        }),
      ]);
    } catch {
      // Provider errors can contain credentials or source text; keep both out of
      // logs/client errors. Do not convert unavailable extraction into success.
      this.logger.warn('Strategy context import model call failed; no result was accepted.');
      throw new ServiceUnavailableException(
        'Meri could not finish reading this file. Please try again.',
      );
    } finally {
      if (timer) clearTimeout(timer);
    }

    void this.meterRound(ctx, response, workflow).catch(() => {
      this.logger.warn('Strategy context import usage metering failed.');
    });

    // OpenAI's adapter returns the same canonical tool_use stop reason.
    // A max_tokens/length/refusal result is partial even if a tool block exists.
    if (response.stopReason !== 'tool_use') {
      throw new BadGatewayException(
        'Meri returned an incomplete reading of this file. Please try again.',
      );
    }
    const tools = Array.isArray(response.content)
      ? response.content.filter(
          (block): block is {
            type: 'tool_use';
            id: string;
            name: string;
            input: Record<string, unknown>;
          } => block?.type === 'tool_use',
        )
      : [];
    if (tools.length !== 1 || tools[0]?.name !== tool.name) {
      throw new BadGatewayException(
        'Meri did not return a complete document reading. Please try again.',
      );
    }
    return { input: tools[0].input, model: response.model };
  }

  private invalidOutput(error: unknown): never {
    if (error instanceof ContextImportValidationError) {
      this.logger.warn('Strategy context import failed source validation; no result was accepted.');
      throw new BadGatewayException(error.message);
    }
    throw error;
  }

  private async meterRound(
    ctx: MeriContext,
    response: ToolLoopResponse,
    workflow: string,
  ): Promise<void> {
    // The canonical adapter exposes the actual response model across fallback.
    const provider =
      response.provider ?? (/^claude-/i.test(response.model) ? 'anthropic' : 'openai');
    await recordAiUsageEvent(
      { prisma: this.prisma, logger: this.logger },
      { tenantId: ctx.tenantId, userId: ctx.userId },
      workflow,
      {
        provider,
        model: response.model,
        usage: response.usage,
        usedTenantKey: response.usedTenantKey,
      },
    );
  }
}
