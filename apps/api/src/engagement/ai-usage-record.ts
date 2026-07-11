/**
 * Best-effort AI usage metering. Called by the engagement service after every
 * successful generation; persists one AiUsageEvent row (tenant, workflow,
 * provider, model, tokens, estimated cost) through the RLS-scoped withTenant
 * path. A metering failure must NEVER fail the user's generation, so every
 * error is swallowed and logged.
 */
import type { Prisma } from '@prisma/client';
import { computeAiCostUsd } from './ai-pricing.js';
import type { ProviderUsage } from './ai-usage-parse.js';

export interface AiUsageRecorderDeps {
  prisma: {
    withTenant<T>(tenantId: string, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T>;
  };
  logger: { warn(message: string): void };
}

export interface AiUsageContext {
  tenantId: string;
  userId?: string | null;
}

export interface AiGenerationUsageLike {
  provider: string;
  model: string;
  usage?: ProviderUsage;
  /** Set by the credential resolver when the call ran on the tenant's own key. */
  usedTenantKey?: boolean;
  /** Outreach prompt-assembly spec ('v1'|'v2'); undefined for non-outreach. */
  promptSpecVersion?: string;
}

export async function recordAiUsageEvent(
  deps: AiUsageRecorderDeps,
  ctx: AiUsageContext,
  workflow: string,
  generated: AiGenerationUsageLike,
): Promise<void> {
  try {
    const usage = generated.usage ?? { inputTokens: 0, outputTokens: 0 };
    const costUsd = computeAiCostUsd(generated.model, usage.inputTokens, usage.outputTokens);
    await deps.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.aiUsageEvent.create({
        data: {
          tenantId: ctx.tenantId,
          userId: ctx.userId ?? null,
          workflow,
          provider: generated.provider,
          model: generated.model,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheReadTokens: usage.cacheReadTokens ?? 0,
          cacheCreationTokens: usage.cacheCreationTokens ?? 0,
          costUsd,
          usedTenantKey: generated.usedTenantKey ?? false,
          promptSpecVersion: generated.promptSpecVersion ?? null,
        },
      }),
    );
  } catch (err) {
    deps.logger.warn(
      `AI usage metering write failed (generation unaffected): ${(err as Error).message}`,
    );
  }
}
