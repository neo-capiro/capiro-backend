import { BadRequestException, ForbiddenException, Logger, ValidationPipe } from '@nestjs/common';
import { AlertMemoService } from './alert-memo.service.js';
import { SaveAlertMemoDto } from './alert-memo.controller.js';
import type { AlertMemoAlertInput } from './alert-memo.types.js';

/**
 * Gate A, P0-01 (items 1-4) — held-memo save bypass. This is audit test-gap
 * item 1 and the single most important test in Gate A: a memo the grounding
 * auditor HELD for review must not be filed around the review gate via the
 * edit-then-save path.
 *
 * The plan's own adversarial addition (§4.2/§6.5) folds in a hole the source
 * audit missed: reviews.createSystem() is fail-open and returns null on any
 * DB error, which would leave L1/L2/L3 all vacuously passing (no
 * review_request row for any of them to find). Lock L0 (this file's "L0"
 * describe block) closes it using the meri_audit_ledger write, which happens
 * unconditionally before the hold branch and is NOT fail-open-to-null.
 *
 * Mirrors alert-memo.service.spec.ts's fake-prisma / fake-deps pattern (same
 * file the enforce/annotate/shadow mode tests already live in) rather than a
 * Nest TestingModule — this service has no HTTP-layer concerns worth booting
 * for, and the hold-triggering fixture below is copied verbatim from that
 * file's proven "under ENFORCE, a held memo is NOT auto-filed" test so the
 * auditor's real deterministic checks (not a stub) produce decision:'hold'.
 */

const HOLD_TRIGGERING_ALERT: AlertMemoAlertInput = {
  alertId: 'alert-1',
  sourceType: 'bill',
  title: 'H.R. 8800: Rule granted (floor scheduled)',
  billDisplayNum: 'H.R. 8800',
  billTitle: 'National Defense Manufacturing Act',
  actionText: 'Rules Committee granted a closed rule for floor consideration.',
  actionDate: '2026-07-01',
  committee: 'House Armed Services Committee',
  url: 'https://congress.gov/bill/hr8800',
  sourceRef: 'hr-8800-119',
};

const CLEAN_ALERT: AlertMemoAlertInput = {
  alertId: 'alert-2',
  sourceType: 'bill',
  title: 'H.R. 100: Routine reauthorization',
  billDisplayNum: 'H.R. 100',
  actionText: 'Referred to committee.',
  url: 'https://congress.gov/bill/hr100',
};

function jsonResponse(body: unknown, ok = true) {
  return { ok, json: async () => body } as Response;
}
function anthropicTextResponse(sections: unknown) {
  return jsonResponse({
    content: [{ type: 'text', text: JSON.stringify({ sections }) }],
    usage: { input_tokens: 400, output_tokens: 150 },
  });
}

/** Framing the failed-rule bill (`hr-8800-119`, live-checked as `rule_failed`) as still operative — the D6 check the existing spec proves triggers decision:'hold' under enforce. */
const HOLD_TRIGGERING_FETCH = jest.fn(async () =>
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
const CLEAN_FETCH = jest.fn(async () =>
  anthropicTextResponse([
    { heading: 'Bottom line', paragraphs: [{ text: 'Referred to committee as expected.', claimIds: ['c1'] }] },
  ]),
);

function makeDeps(opts: {
  createSystemReturns?: string | null;
  hasOpenForSubject?: boolean;
  pendingReviews?: Array<{ title: string; subjectId: string | null }>;
  recentHoldLedgerRow?: { id: string } | null;
}) {
  const meriAuditLedgerRows: Array<{ data: Record<string, unknown> }> = [];
  const meriAuditLedgerFindFirstCalls: unknown[] = [];
  const reviewRequestFindManyCalls: unknown[] = [];
  const prisma = {
    withTenant: jest.fn(async (_tenantId: string, fn: (tx: unknown) => unknown) =>
      fn({
        aiUsageEvent: { create: jest.fn(async (args: unknown) => args) },
        tenant: { findFirst: jest.fn(async () => null) },
        meriAuditLedger: {
          create: jest.fn(async (args: { data: Record<string, unknown> }) => {
            meriAuditLedgerRows.push(args);
            return args;
          }),
          findFirst: jest.fn(async (args: unknown) => {
            meriAuditLedgerFindFirstCalls.push(args);
            return opts.recentHoldLedgerRow ?? null;
          }),
        },
        reviewRequest: {
          findMany: jest.fn(async (args: unknown) => {
            reviewRequestFindManyCalls.push(args);
            return opts.pendingReviews ?? [];
          }),
        },
      }),
    ),
  };
  const credentials = {
    resolveProvider: jest.fn(async () => ({ apiKey: 'key', model: 'claude-sonnet-5', usedTenantKey: false })),
  };
  const contextCompiler = {
    compile: jest.fn(async () => ({ packetId: 'pkt-1', rendered: [], items: [], exclusions: [] })),
  };
  const engagement = {
    createAttachmentFromBuffer: jest.fn(async () => ({ id: 'att-1', fileName: 'memo.docx' })),
    deleteAttachment: jest.fn(async () => undefined),
    billTruthBlock: jest.fn(async () => ({
      text: 'authoritative block',
      raw: { id: 'hr-8800-119', status: 'rule_failed', statusAt: '2026-07-10T00:00:00.000Z' },
    })),
  };
  const reviews = {
    createSystem: jest.fn(async () => ('createSystemReturns' in opts ? opts.createSystemReturns : 'rr-1')),
    hasOpenForSubject: jest.fn(async () => opts.hasOpenForSubject ?? false),
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
    engagement,
    reviews,
    meriAuditLedgerRows,
    meriAuditLedgerFindFirstCalls,
    reviewRequestFindManyCalls,
  };
}

describe('AlertMemoService — held-memo save bypass (Gate A, P0-01 items 1-4)', () => {
  const originalFetch = global.fetch;
  const originalAuditorMode = process.env.MERI_AUDITOR_MODE;

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalAuditorMode === undefined) delete process.env.MERI_AUDITOR_MODE;
    else process.env.MERI_AUDITOR_MODE = originalAuditorMode;
    jest.restoreAllMocks();
  });

  it('1. end-to-end bypass, proven closed: a held memo cannot be filed via saveEdited with its own returned title/markdown/alertId', async () => {
    process.env.MERI_AUDITOR_MODE = 'enforce';
    const { service, engagement, reviews } = makeDeps({ hasOpenForSubject: true });
    global.fetch = HOLD_TRIGGERING_FETCH as unknown as typeof fetch;

    const result = await service.generate(
      { tenantId: 't1', userId: 'u1', role: 'standard_user' } as never,
      'client-1',
      HOLD_TRIGGERING_ALERT,
      'Acme Corp',
    );

    expect(result.held).toBe(true);
    expect(result.document).toBeNull();
    expect(result.reviewRequestId).toBe('rr-1');
    expect(reviews.createSystem).toHaveBeenCalledTimes(1);

    await expect(
      service.saveEdited(
        { tenantId: 't1', userId: 'u1', role: 'standard_user' } as never,
        'client-1',
        {
          title: result.title,
          markdown: result.markdown,
          clientName: 'Acme Corp',
          alertId: HOLD_TRIGGERING_ALERT.alertId,
        },
      ),
    ).rejects.toThrow(ForbiddenException);
    expect(engagement.createAttachmentFromBuffer).not.toHaveBeenCalled();
  });

  it('2. L1 in isolation: correct alertId with a changed title and banner-stripped markdown still blocks', async () => {
    const { service } = makeDeps({ hasOpenForSubject: true, pendingReviews: [] });

    await expect(
      service.saveEdited({ tenantId: 't1', userId: 'u1', role: 'standard_user' } as never, 'client-1', {
        title: 'A completely different title',
        markdown: 'No banner here, freely edited.',
        clientName: 'Acme Corp',
        alertId: 'alert-1',
      }),
    ).rejects.toThrow(ForbiddenException);
  });

  it('3. L2 in isolation: a bogus alertId with the correct (server-generated) title still blocks', async () => {
    const { service } = makeDeps({
      hasOpenForSubject: false,
      pendingReviews: [{ title: 'Client memo — H.R. 8800', subjectId: 'alert-1' }],
    });

    await expect(
      service.saveEdited({ tenantId: 't1', userId: 'u1', role: 'standard_user' } as never, 'client-1', {
        title: 'Client memo — H.R. 8800',
        markdown: 'No banner here, freely edited.',
        clientName: 'Acme Corp',
        alertId: 'spoofed',
      }),
    ).rejects.toThrow(ForbiddenException);
  });

  it('4. L3 in isolation: a bogus alertId and a changed title but the banner intact still blocks', async () => {
    const { service } = makeDeps({
      hasOpenForSubject: false,
      pendingReviews: [{ title: 'Some other pending memo title', subjectId: 'alert-1' }],
    });

    await expect(
      service.saveEdited({ tenantId: 't1', userId: 'u1', role: 'standard_user' } as never, 'client-1', {
        title: 'A completely different title',
        markdown: '> ⚠️ **Unverified — 1 grounding finding(s) held for review (checkX).**\n\nBody.',
        clientName: 'Acme Corp',
        alertId: 'spoofed',
      }),
    ).rejects.toThrow(ForbiddenException);
  });

  it('5. admin release path: the same held state succeeds for a tenant admin', async () => {
    const { service, engagement } = makeDeps({
      hasOpenForSubject: true,
      pendingReviews: [{ title: 'Client memo — H.R. 8800', subjectId: 'alert-1' }],
    });

    await expect(
      service.saveEdited({ tenantId: 't1', userId: 'admin-1', role: 'user_admin' } as never, 'client-1', {
        title: 'Client memo — H.R. 8800',
        markdown: '> ⚠️ **Unverified — 1 grounding finding(s) held for review (checkX).**\n\nBody.',
        clientName: 'Acme Corp',
        alertId: 'alert-1',
      }),
    ).resolves.toMatchObject({ document: { attachmentId: 'att-1' } });
    expect(engagement.createAttachmentFromBuffer).toHaveBeenCalledTimes(1);
  });

  it('6. annotate must not regress: a flagged memo still files under annotate, and its later edited save still succeeds', async () => {
    process.env.MERI_AUDITOR_MODE = 'annotate';
    const { service, engagement, reviews } = makeDeps({
      hasOpenForSubject: false,
      pendingReviews: [],
      recentHoldLedgerRow: null,
    });
    global.fetch = HOLD_TRIGGERING_FETCH as unknown as typeof fetch;

    const result = await service.generate(
      { tenantId: 't1', userId: 'u1', role: 'standard_user' } as never,
      'client-1',
      HOLD_TRIGGERING_ALERT,
      'Acme Corp',
    );

    expect(result.held).toBe(false);
    expect(result.document).not.toBeNull();
    expect(result.reviewRequestId).toBeNull();
    expect(result.markdown).toContain('grounding finding(s) held for review'); // annotate adds the same banner
    expect(reviews.createSystem).not.toHaveBeenCalled(); // no review_request created — nothing was held

    await expect(
      service.saveEdited({ tenantId: 't1', userId: 'u1', role: 'standard_user' } as never, 'client-1', {
        title: result.title,
        markdown: result.markdown,
        clientName: 'Acme Corp',
        alertId: HOLD_TRIGGERING_ALERT.alertId,
      }),
    ).resolves.toMatchObject({ document: { attachmentId: 'att-1' } });
    expect(engagement.createAttachmentFromBuffer).toHaveBeenCalledTimes(2); // once from generate(), once from saveEdited()
  });

  it('7. clean path: mode off never holds, and an ordinary edited save succeeds', async () => {
    process.env.MERI_AUDITOR_MODE = 'off';
    const { service, engagement, reviews } = makeDeps({ hasOpenForSubject: false, pendingReviews: [] });
    global.fetch = CLEAN_FETCH as unknown as typeof fetch;

    const result = await service.generate(
      { tenantId: 't1', userId: 'u1', role: 'standard_user' } as never,
      'client-1',
      CLEAN_ALERT,
      'Acme Corp',
    );

    expect(result.held).toBe(false);
    expect(result.reviewRequestId).toBeNull();
    expect(result.heldReason).toBe('');
    expect(reviews.createSystem).not.toHaveBeenCalled();

    await expect(
      service.saveEdited({ tenantId: 't1', userId: 'u1', role: 'standard_user' } as never, 'client-1', {
        title: result.title,
        markdown: result.markdown,
        clientName: 'Acme Corp',
        alertId: CLEAN_ALERT.alertId,
      }),
    ).resolves.toMatchObject({ document: { attachmentId: 'att-1' } });
    expect(engagement.createAttachmentFromBuffer).toHaveBeenCalledTimes(2);
  });

  it('8. missing alertId is a 400, not a silent skip, through the real global ValidationPipe', async () => {
    const pipe = new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    });
    const meta = { type: 'body' as const, metatype: SaveAlertMemoDto };

    await expect(
      pipe.transform({ title: 't', markdown: 'm', clientName: 'c' }, meta),
    ).rejects.toThrow(BadRequestException);

    // Positive control: the same shape WITH alertId passes.
    await expect(
      pipe.transform({ title: 't', markdown: 'm', clientName: 'c', alertId: 'alert-1' }, meta),
    ).resolves.toBeInstanceOf(SaveAlertMemoDto);
  });

  it("L0. createSystem returning null (fail-open) still blocks the save via the durable meri_audit_ledger hold row, and logs at ERROR", async () => {
    process.env.MERI_AUDITOR_MODE = 'enforce';
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { service, meriAuditLedgerFindFirstCalls } = makeDeps({
      createSystemReturns: null,
      hasOpenForSubject: false, // no review_request row exists — createSystem failed
      pendingReviews: [], // same reason: L1/L2/L3's data source is empty
      recentHoldLedgerRow: { id: 'ledger-1' }, // but the ledger write is NOT fail-open-to-null
    });
    global.fetch = HOLD_TRIGGERING_FETCH as unknown as typeof fetch;

    const result = await service.generate(
      { tenantId: 't1', userId: 'u1', role: 'standard_user' } as never,
      'client-1',
      HOLD_TRIGGERING_ALERT,
      'Acme Corp',
    );

    expect(result.held).toBe(true);
    expect(result.reviewRequestId).toBeNull();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('review_request creation FAILED'));

    await expect(
      service.saveEdited({ tenantId: 't1', userId: 'u1', role: 'standard_user' } as never, 'client-1', {
        title: result.title,
        markdown: result.markdown,
        clientName: 'Acme Corp',
        alertId: HOLD_TRIGGERING_ALERT.alertId,
      }),
    ).rejects.toThrow(ForbiddenException);
    expect(meriAuditLedgerFindFirstCalls).toHaveLength(1);
    expect(meriAuditLedgerFindFirstCalls[0]).toMatchObject({
      where: expect.objectContaining({ tenantId: 't1', surface: 'alert', decision: 'hold' }),
    });
  });
});
