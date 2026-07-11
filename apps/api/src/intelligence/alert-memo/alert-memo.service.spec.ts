import { ServiceUnavailableException } from '@nestjs/common';
import { AlertMemoService } from './alert-memo.service.js';
import type { AlertMemoAlertInput } from './alert-memo.types.js';

/**
 * AlertMemoService.generate — Phase 1 M5.0 (H-1 metering gap). This file had
 * NO prior test coverage; the focused scope here is proving the metering fix
 * (recordAiUsageEvent now fires on every generate() call, success or
 * scaffold-fallback) — mirroring district-brief.service.spec.ts's fake-prisma
 * pattern, this memo generator's newer twin.
 */

const FEDERAL_ALERT: AlertMemoAlertInput = {
  alertId: 'alert-1',
  sourceType: 'bill',
  title: 'H.R. 8800: Rule granted (floor scheduled)',
  whyItMatters: 'Directly affects defense manufacturing incentives the client relies on.',
  billDisplayNum: 'H.R. 8800',
  billTitle: 'National Defense Manufacturing Act',
  actionText: 'Rules Committee granted a closed rule for floor consideration.',
  actionDate: '2026-07-01',
  committee: 'House Armed Services Committee',
  url: 'https://congress.gov/bill/hr8800',
};

function makeDeps(opts: {
  cred?: { apiKey: string; model: string; usedTenantKey: boolean } | null;
  memoryItem?: unknown;
}) {
  const aiUsageEvents: unknown[] = [];
  const prisma = {
    withTenant: jest.fn(async (_tenantId: string, fn: (tx: unknown) => unknown) =>
      fn({
        aiUsageEvent: {
          create: jest.fn(async (args: unknown) => {
            aiUsageEvents.push(args);
            return args;
          }),
        },
      }),
    ),
  };
  const credentials = {
    resolveProvider: jest.fn(async () =>
      'cred' in opts
        ? opts.cred
        : { apiKey: 'key', model: 'claude-sonnet-5', usedTenantKey: false },
    ),
  };
  const memory = {
    getByTypeSlug: jest.fn(async () => opts.memoryItem ?? null),
  };
  const engagement = {
    createAttachmentFromBuffer: jest.fn(async () => ({ id: 'att-1', fileName: 'memo.docx' })),
    deleteAttachment: jest.fn(async () => undefined),
  };
  const service = new AlertMemoService(
    credentials as never,
    memory as never,
    engagement as never,
    prisma as never,
  );
  return { service, prisma, credentials, memory, engagement, aiUsageEvents };
}

function jsonResponse(body: unknown, ok = true) {
  return { ok, json: async () => body } as Response;
}

function anthropicTextResponse(sections: unknown) {
  return jsonResponse({
    content: [{ type: 'text', text: JSON.stringify({ sections }) }],
    usage: { input_tokens: 400, output_tokens: 150 },
  });
}

describe('AlertMemoService.generate — metering (Phase 1 M5.0)', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('PINNED: a grounded memo meters exactly one ai_usage_events row with the real token usage', async () => {
    const { service, aiUsageEvents } = makeDeps({});
    global.fetch = jest.fn(async () =>
      anthropicTextResponse([
        {
          heading: 'Bottom line',
          paragraphs: [
            { text: 'The rule was granted; floor action is imminent.', claimIds: ['c1'] },
          ],
        },
      ]),
    );

    const result = await service.generate(
      { tenantId: 't1', userId: 'u1' } as never,
      'client-1',
      FEDERAL_ALERT,
      'Acme Corp',
    );

    expect(result.lowConfidence).toBe(false);
    expect(aiUsageEvents).toHaveLength(1);
    const data = (aiUsageEvents[0] as { data: Record<string, unknown> }).data;
    expect(data).toMatchObject({
      tenantId: 't1',
      userId: 'u1',
      workflow: 'alert_memo',
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      inputTokens: 400,
      outputTokens: 150,
      usedTenantKey: false,
    });
  });

  it('PINNED (W3.3, D-9 — federal prod behavior): a ZERO-citation paragraph is never emitted; a fully-uncited memo downgrades to the scaffold + lowConfidence', async () => {
    const { service } = makeDeps({});
    global.fetch = jest.fn(async () =>
      anthropicTextResponse([
        {
          heading: 'Bottom line',
          // No citation at all — pre-W3.3 this shipped into a client-facing
          // FEDERAL memo (`[].every` vacuously true).
          paragraphs: [{ text: 'This bill will certainly become law within weeks.', claimIds: [] }],
        },
      ]),
    );

    const result = await service.generate(
      { tenantId: 't1', userId: 'u1' } as never,
      'client-1',
      FEDERAL_ALERT,
      'Acme Corp',
    );

    // All paragraphs were uncited -> dropped -> scaffold downgrade.
    expect(result.lowConfidence).toBe(true);
    const allText = result.sections.flatMap((s) => s.paragraphs.map((p) => p.text)).join(' ');
    expect(allText).not.toContain('certainly become law'); // ungrounded prose not filed
  });

  it('W3.3: keeps grounded paragraphs but drops only the zero-citation one from a mixed memo', async () => {
    const { service } = makeDeps({});
    global.fetch = jest.fn(async () =>
      anthropicTextResponse([
        {
          heading: 'Bottom line',
          paragraphs: [
            { text: 'The rule was granted; floor action is imminent.', claimIds: ['c1'] },
            { text: 'It is a lock to pass.', claimIds: [] },
          ],
        },
      ]),
    );

    const result = await service.generate(
      { tenantId: 't1', userId: 'u1' } as never,
      'client-1',
      FEDERAL_ALERT,
      'Acme Corp',
    );

    expect(result.lowConfidence).toBe(false); // the grounded paragraph survived
    const allText = result.sections.flatMap((s) => s.paragraphs.map((p) => p.text)).join(' ');
    expect(allText).toContain('floor action is imminent');
    expect(allText).not.toContain('It is a lock to pass');
  });

  it('a failed Anthropic call falls back to the scaffold — STILL meters (zero usage), never fails the memo', async () => {
    const { service, aiUsageEvents } = makeDeps({});
    global.fetch = jest.fn(async () => jsonResponse({ error: 'boom' }, false));

    const result = await service.generate(
      { tenantId: 't1', userId: 'u1' } as never,
      'client-1',
      FEDERAL_ALERT,
      'Acme Corp',
    );

    expect(result.lowConfidence).toBe(true);
    expect(aiUsageEvents).toHaveLength(1);
    const data = (aiUsageEvents[0] as { data: Record<string, unknown> }).data;
    expect(data).toMatchObject({ workflow: 'alert_memo', inputTokens: 0, outputTokens: 0 });
  });

  it('throws before generating (never meters) when no Anthropic credential is available for the tenant', async () => {
    const { service, aiUsageEvents } = makeDeps({ cred: null });

    await expect(
      service.generate(
        { tenantId: 't1', userId: 'u1' } as never,
        'client-1',
        FEDERAL_ALERT,
        'Acme Corp',
      ),
    ).rejects.toThrow(ServiceUnavailableException);
    expect(aiUsageEvents).toHaveLength(0);
  });
});
