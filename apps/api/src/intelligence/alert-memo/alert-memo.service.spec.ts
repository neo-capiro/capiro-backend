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
  billTruthBlock?: () => Promise<unknown>;
}) {
  const aiUsageEvents: unknown[] = [];
  const meriAuditLedgerRows: unknown[] = [];
  const prisma = {
    withTenant: jest.fn(async (_tenantId: string, fn: (tx: unknown) => unknown) =>
      fn({
        aiUsageEvent: {
          create: jest.fn(async (args: unknown) => {
            aiUsageEvents.push(args);
            return args;
          }),
        },
        meriAuditLedger: {
          create: jest.fn(async (args: unknown) => {
            meriAuditLedgerRows.push(args);
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
  // Context Compiler v1 (G1): steering now arrives as a compiled packet. An
  // opts.memoryItem seeds one rendered client-soul item (render:'all' shape).
  const contextCompiler = {
    compile: jest.fn(async () =>
      opts.memoryItem
        ? {
            packetId: 'pkt-1',
            rendered: [
              {
                layer: 'client-steering',
                id: 'mi-1',
                type: 'client-soul',
                slug: 'client-1',
                title: (opts.memoryItem as { title?: string }).title ?? 'Client Soul',
                body: 'steering body',
              },
            ],
            items: [],
            exclusions: [],
          }
        : { packetId: 'pkt-1', rendered: [], items: [], exclusions: [] },
    ),
  };
  const engagement = {
    createAttachmentFromBuffer: jest.fn(async () => ({ id: 'att-1', fileName: 'memo.docx' })),
    deleteAttachment: jest.fn(async () => undefined),
    // Gate H a-6: regenerate/save now supersede rather than delete — see the
    // dedicated describe block below. Stubbed here so any path that reaches
    // it doesn't throw "supersedeAttachment is not a function".
    supersedeAttachment: jest.fn(async () => undefined),
    billTruthBlock: jest.fn(opts.billTruthBlock ?? (async () => null)),
  };
  // G4: held memos emit a review_request (fail-open) — captured for assertions.
  const reviews = {
    createSystem: jest.fn(async () => 'rr-1'),
    hasOpenForSubject: jest.fn(async () => false),
  };
  const service = new AlertMemoService(
    credentials as never,
    contextCompiler as never,
    engagement as never,
    prisma as never,
    reviews as never,
  );
  return {
    service,
    prisma,
    credentials,
    contextCompiler,
    engagement,
    reviews,
    aiUsageEvents,
    meriAuditLedgerRows,
  };
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

describe('AlertMemoService.generate — live bill re-query (5.2C / RC3 fix)', () => {
  const originalFetch = global.fetch;
  const originalAuditorMode = process.env.MERI_AUDITOR_MODE;
  afterEach(() => {
    global.fetch = originalFetch;
    if (originalAuditorMode === undefined) delete process.env.MERI_AUDITOR_MODE;
    else process.env.MERI_AUDITOR_MODE = originalAuditorMode;
    jest.restoreAllMocks();
  });

  const STALE_ALERT: AlertMemoAlertInput = { ...FEDERAL_ALERT, sourceRef: 'hr-8800-119' };

  it('feeds the CURRENT live bill status into the prompt, superseding the frozen alert snapshot', async () => {
    const { service } = makeDeps({
      billTruthBlock: async () => ({
        text: 'authoritative block (unused by the assertion)',
        raw: { id: 'hr-8800-119', status: 'rule_failed', statusAt: '2026-07-10T00:00:00.000Z' },
      }),
    });
    const fetchMock = jest.fn(async (_url: string, init: { body: string }) =>
      anthropicTextResponse([
        {
          heading: 'Bottom line',
          paragraphs: [{ text: 'The rule has since failed on the floor.', claimIds: ['c1'] }],
        },
      ]),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    await service.generate(
      { tenantId: 't1', userId: 'u1' } as never,
      'client-1',
      STALE_ALERT,
      'Acme Corp',
    );

    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    const prompt: string = body.messages[0].content;
    // The alert's OWN snapshot ("Rule granted") is still present as history...
    expect(prompt).toContain('Rule granted');
    // ...but the live re-query's current status is present and marked authoritative.
    expect(prompt).toContain('CURRENT status as of memo generation');
    expect(prompt).toContain('as of 2026-07-10');
    expect(prompt.toLowerCase()).toContain('failed');
  });

  it('never calls the live re-query for a hearing-only alert (no bill id to look up)', async () => {
    const billTruthBlock = jest.fn(async () => null);
    const { service } = makeDeps({ billTruthBlock });
    global.fetch = jest.fn(async () => anthropicTextResponse([]));

    await service.generate(
      { tenantId: 't1', userId: 'u1' } as never,
      'client-1',
      { ...FEDERAL_ALERT, sourceType: 'hearing', sourceRef: 'hearing-session-1' },
      'Acme Corp',
    );

    expect(billTruthBlock).not.toHaveBeenCalled();
  });

  it('a live re-query failure never blocks memo generation (best-effort)', async () => {
    const { service } = makeDeps({
      billTruthBlock: async () => {
        throw new Error('congressBill lookup failed');
      },
    });
    global.fetch = jest.fn(async () =>
      anthropicTextResponse([
        { heading: 'Bottom line', paragraphs: [{ text: 'Grounded text.', claimIds: ['c1'] }] },
      ]),
    );

    const result = await service.generate(
      { tenantId: 't1', userId: 'u1' } as never,
      'client-1',
      STALE_ALERT,
      'Acme Corp',
    );

    expect(result.lowConfidence).toBe(false);
  });

  it('under ENFORCE, a held memo is NOT auto-filed to the client Documents (held=true, document=null) — Phase 2.5-1', async () => {
    process.env.MERI_AUDITOR_MODE = 'enforce';
    const { service, engagement } = makeDeps({
      billTruthBlock: async () => ({
        text: 'authoritative block',
        raw: { id: 'hr-8800-119', status: 'rule_failed', statusAt: '2026-07-10T00:00:00.000Z' },
      }),
    });
    global.fetch = jest.fn(async () =>
      anthropicTextResponse([
        {
          heading: 'Bottom line',
          // Frames a failed-rule bill as operative → D6 critical finding → hold.
          paragraphs: [
            {
              text: 'Debate on hr-8800-119 is limited and floor consideration is expected to pass.',
              claimIds: ['c1'],
            },
          ],
        },
      ]),
    );

    const {
      service: svc2,
      engagement: eng2,
      reviews,
    } = makeDeps({
      billTruthBlock: async () => ({
        text: 'authoritative block',
        raw: { id: 'hr-8800-119', status: 'rule_failed', statusAt: '2026-07-10T00:00:00.000Z' },
      }),
    });
    void service;
    void engagement;
    global.fetch = jest.fn(async () =>
      anthropicTextResponse([
        {
          heading: 'Bottom line',
          paragraphs: [
            {
              text: 'Debate on hr-8800-119 is limited and floor consideration is expected to pass.',
              claimIds: ['c1'],
            },
          ],
        },
      ]),
    );

    const result = await svc2.generate(
      { tenantId: 't1', userId: 'u1' } as never,
      'client-1',
      STALE_ALERT,
      'Acme Corp',
    );

    expect(result.held).toBe(true);
    expect(result.document).toBeNull();
    // The memo content is still returned for review (with the Unverified banner)...
    expect(result.markdown).toContain('Unverified');
    // ...but nothing was filed into the client's Documents.
    expect(eng2.createAttachmentFromBuffer).not.toHaveBeenCalled();
    // G4: a hold is no longer a dead end — it emitted a pending review_request
    // carrying the markdown+title+client the reviewer needs to release it.
    expect(reviews.createSystem).toHaveBeenCalledTimes(1);
    const emitted = (reviews.createSystem as jest.Mock).mock.calls[0]![1] as {
      surface: string;
      riskTier: string;
      subjectId: string;
      payload: { markdown: string };
    };
    expect(emitted.surface).toBe('alert-memo');
    expect(emitted.riskTier).toBe('high');
    expect(emitted.payload.markdown).toContain('Unverified');
  });

  it('under SHADOW, the same flagged memo is NOT held — it files normally (enforce is the only mode that holds)', async () => {
    process.env.MERI_AUDITOR_MODE = 'shadow';
    const { service, engagement } = makeDeps({
      billTruthBlock: async () => ({
        text: 'authoritative block',
        raw: { id: 'hr-8800-119', status: 'rule_failed', statusAt: '2026-07-10T00:00:00.000Z' },
      }),
    });
    global.fetch = jest.fn(async () =>
      anthropicTextResponse([
        {
          heading: 'Bottom line',
          paragraphs: [
            {
              text: 'Debate on hr-8800-119 is limited and floor consideration is expected to pass.',
              claimIds: ['c1'],
            },
          ],
        },
      ]),
    );

    const result = await service.generate(
      { tenantId: 't1', userId: 'u1' } as never,
      'client-1',
      STALE_ALERT,
      'Acme Corp',
    );

    expect(result.held).toBe(false);
    expect(engagement.createAttachmentFromBuffer).toHaveBeenCalled();
    expect(result.document).not.toBeNull();
  });

  it('under a live auditor mode, the ledger carries a get_bill_status entry built from the live re-query, not the frozen claim sheet alone', async () => {
    process.env.MERI_AUDITOR_MODE = 'shadow';
    const { service, meriAuditLedgerRows } = makeDeps({
      billTruthBlock: async () => ({
        text: 'authoritative block',
        raw: { id: 'hr-8800-119', status: 'rule_failed', statusAt: '2026-07-10T00:00:00.000Z' },
      }),
    });
    global.fetch = jest.fn(async () =>
      anthropicTextResponse([
        {
          heading: 'Bottom line',
          // Still frames the rule as operative — the auditor's D6 check should
          // catch this against the LIVE status, which shadow-only logs (never
          // alters the memo). Includes the ledger's billId token verbatim, same
          // as the D6 golden fixture, so the check's concernsFailed match fires.
          paragraphs: [
            {
              text: 'Debate on hr-8800-119 is limited and floor consideration is expected to pass.',
              claimIds: ['c1'],
            },
          ],
        },
      ]),
    );

    await service.generate(
      { tenantId: 't1', userId: 'u1' } as never,
      'client-1',
      STALE_ALERT,
      'Acme Corp',
    );

    expect(meriAuditLedgerRows.length).toBe(1);
    const row = (meriAuditLedgerRows[0] as { data: Record<string, unknown> }).data;
    expect(row.surface).toBe('alert');
    expect(row.findingCount).toBeGreaterThan(0);
  });
});

describe('AlertMemoService — regenerate/save supersedes, never deletes (Gate H a-6 / RB-04)', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('generate() with a replaceAttachmentId supersedes the old doc — never deletes it', async () => {
    const { service, engagement } = makeDeps({});
    global.fetch = jest.fn(async () =>
      anthropicTextResponse([
        { heading: 'Bottom line', paragraphs: [{ text: 'Rule granted.', claimIds: ['c1'] }] },
      ]),
    );

    const result = await service.generate(
      { tenantId: 't1', userId: 'u1' } as never,
      'client-1',
      FEDERAL_ALERT,
      'Acme Corp',
      'old-att-1',
    );

    expect(result.document).toEqual({ attachmentId: 'att-1', fileName: 'memo.docx' });
    expect(engagement.supersedeAttachment).toHaveBeenCalledTimes(1);
    expect(engagement.supersedeAttachment).toHaveBeenCalledWith(
      { tenantId: 't1', userId: 'u1' },
      'old-att-1',
      'att-1',
    );
    expect(engagement.deleteAttachment).not.toHaveBeenCalled();
  });

  it('generate() with no replaceAttachmentId calls neither supersede nor delete (first-time generation)', async () => {
    const { service, engagement } = makeDeps({});
    global.fetch = jest.fn(async () =>
      anthropicTextResponse([
        { heading: 'Bottom line', paragraphs: [{ text: 'Rule granted.', claimIds: ['c1'] }] },
      ]),
    );

    await service.generate(
      { tenantId: 't1', userId: 'u1' } as never,
      'client-1',
      FEDERAL_ALERT,
      'Acme Corp',
    );

    expect(engagement.supersedeAttachment).not.toHaveBeenCalled();
    expect(engagement.deleteAttachment).not.toHaveBeenCalled();
  });

  it('a failed supersede is swallowed (best-effort) — the regenerated memo is still returned with its new document', async () => {
    const { service, engagement } = makeDeps({});
    (engagement.supersedeAttachment as jest.Mock).mockRejectedValueOnce(new Error('db down'));
    global.fetch = jest.fn(async () =>
      anthropicTextResponse([
        { heading: 'Bottom line', paragraphs: [{ text: 'Rule granted.', claimIds: ['c1'] }] },
      ]),
    );

    const result = await service.generate(
      { tenantId: 't1', userId: 'u1' } as never,
      'client-1',
      FEDERAL_ALERT,
      'Acme Corp',
      'old-att-1',
    );

    expect(result.document).toEqual({ attachmentId: 'att-1', fileName: 'memo.docx' });
  });

  it('saveEdited() with a replaceAttachmentId supersedes the old doc — never deletes it', async () => {
    const { service, engagement } = makeDeps({});

    const result = await service.saveEdited(
      { tenantId: 't1', userId: 'u1', role: 'user_admin' } as never,
      'client-1',
      {
        title: 'H.R. 8800 memo',
        markdown: '# Bottom line\n\nRule granted.',
        clientName: 'Acme Corp',
        alertId: 'alert-1',
        replaceAttachmentId: 'old-att-2',
      },
    );

    expect(result.document).toEqual({ attachmentId: 'att-1', fileName: 'memo.docx' });
    expect(engagement.supersedeAttachment).toHaveBeenCalledTimes(1);
    expect(engagement.supersedeAttachment).toHaveBeenCalledWith(
      { tenantId: 't1', userId: 'u1', role: 'user_admin' },
      'old-att-2',
      'att-1',
    );
    expect(engagement.deleteAttachment).not.toHaveBeenCalled();
  });

  it('saveEdited() with no replaceAttachmentId calls neither supersede nor delete (first-time save)', async () => {
    const { service, engagement } = makeDeps({});

    await service.saveEdited(
      { tenantId: 't1', userId: 'u1', role: 'user_admin' } as never,
      'client-1',
      {
        title: 'H.R. 8800 memo',
        markdown: '# Bottom line\n\nRule granted.',
        clientName: 'Acme Corp',
        alertId: 'alert-1',
      },
    );

    expect(engagement.supersedeAttachment).not.toHaveBeenCalled();
    expect(engagement.deleteAttachment).not.toHaveBeenCalled();
  });
});
