import { describe, expect, it, jest } from '@jest/globals';
import { recordAiUsageEvent } from '@capiro/shared';

const ctx = {
  tenantId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  userId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
};

function makeDeps(createImpl?: () => Promise<unknown>) {
  const create = jest.fn(createImpl ?? (() => Promise.resolve({})));
  const tx = { aiUsageEvent: { create } };
  const prisma = {
    withTenant: jest.fn(async (_tenantId: string, fn: (tx: unknown) => Promise<unknown>) => fn(tx)),
    withSystem: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(tx)),
  };
  const logger = { warn: jest.fn() };
  return { prisma, logger, create };
}

describe('recordAiUsageEvent (Phase 1 M5.0 — lifted into @capiro/shared)', () => {
  it('writes exactly one event with tenant, tokens, and computed cost', async () => {
    const { prisma, logger, create } = makeDeps();

    await recordAiUsageEvent({ prisma, logger } as never, ctx, 'outreach_campaign', {
      provider: 'openai',
      model: 'gpt-4.1',
      usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
    });

    expect(prisma.withTenant).toHaveBeenCalledTimes(1);
    expect(prisma.withTenant.mock.calls[0]?.[0]).toBe(ctx.tenantId);
    expect(create).toHaveBeenCalledTimes(1);
    const data = (create.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0].data;
    expect(data).toMatchObject({
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      workflow: 'outreach_campaign',
      provider: 'openai',
      model: 'gpt-4.1',
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      usedTenantKey: false,
    });
    // gpt-4.1: $2/M in + $8/M out → $10 for 1M+1M
    expect(data.costUsd).toBeCloseTo(10.0, 5);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('records usedTenantKey when the generation used a tenant credential', async () => {
    const { prisma, logger, create } = makeDeps();

    await recordAiUsageEvent({ prisma, logger } as never, ctx, 'meeting_prep', {
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      usage: { inputTokens: 1000, outputTokens: 500 },
      usedTenantKey: true,
    });

    const data = (create.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0].data;
    expect(data.usedTenantKey).toBe(true);
    expect(data.costUsd).toBeGreaterThan(0);
  });

  it('writes zero tokens / zero cost when usage is missing', async () => {
    const { create } = await (async () => {
      const deps = makeDeps();
      await recordAiUsageEvent(
        { prisma: deps.prisma, logger: deps.logger } as never,
        ctx,
        'meeting_prep',
        {
          provider: 'anthropic',
          model: 'claude-haiku-4-5-20251001',
        },
      );
      return deps;
    })();

    const data = (create.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0].data;
    expect(data).toMatchObject({ inputTokens: 0, outputTokens: 0 });
    expect(data.costUsd).toBe(0);
  });

  it('never throws when the metering write fails — logs and returns', async () => {
    const { prisma, logger } = makeDeps(() => Promise.reject(new Error('db down')));

    await expect(
      recordAiUsageEvent({ prisma, logger } as never, ctx, 'outreach_campaign', {
        provider: 'openai',
        model: 'gpt-4.1',
        usage: { inputTokens: 10, outputTokens: 10 },
      }),
    ).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(String(logger.warn.mock.calls[0]?.[0])).toContain('db down');
  });

  it('never throws when withTenant itself rejects', async () => {
    const prisma = { withTenant: jest.fn(() => Promise.reject(new Error('no tenant guc'))) };
    const logger = { warn: jest.fn() };

    await expect(
      recordAiUsageEvent({ prisma, logger } as never, ctx, 'campaign_email', {
        provider: 'openai',
        model: 'gpt-4o',
        usage: { inputTokens: 5, outputTokens: 5 },
      }),
    ).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
  });

  describe('tenant-agnostic path (Phase 1 M5.0)', () => {
    it('PINNED: a null tenantId meters via withSystem (not withTenant), writing tenant_id = NULL', async () => {
      const { prisma, logger, create } = makeDeps();
      const agnosticCtx = { tenantId: null };

      await recordAiUsageEvent(
        { prisma, logger } as never,
        agnosticCtx,
        'legiwatch_alert_enrichment',
        {
          provider: 'anthropic',
          model: 'claude-haiku-4-5-20251001',
          usage: { inputTokens: 100, outputTokens: 50 },
        },
      );

      expect(prisma.withSystem).toHaveBeenCalledTimes(1);
      expect(prisma.withTenant).not.toHaveBeenCalled();
      const data = (create.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0].data;
      expect(data.tenantId).toBeNull();
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('never throws when the system-scoped write fails', async () => {
      const prisma = { withSystem: jest.fn(() => Promise.reject(new Error('bypass denied'))) };
      const logger = { warn: jest.fn() };

      await expect(
        recordAiUsageEvent(
          { prisma, logger } as never,
          { tenantId: null },
          'legiwatch_alert_enrichment',
          {
            provider: 'anthropic',
            model: 'claude-haiku-4-5-20251001',
            usage: { inputTokens: 5, outputTokens: 5 },
          },
        ),
      ).resolves.toBeUndefined();
      expect(logger.warn).toHaveBeenCalled();
    });
  });
});
