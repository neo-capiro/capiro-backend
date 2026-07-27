import { BadRequestException, ForbiddenException, Logger, ValidationPipe } from '@nestjs/common';
import { AlertMemoService, HELD_BANNER_MARKER } from './alert-memo.service.js';
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

/** Gate I (CG-01) S1/S2: a paragraph with no numeric/date token always reaches
 *  the entailment judge (autoPasses requires at least one) — see entailment-gate.ts. */
const ENTAILMENT_REJECT_ALERT: AlertMemoAlertInput = {
  alertId: 'alert-3',
  sourceType: 'bill',
  title: 'H.R. 200: Committee markup scheduled',
  billDisplayNum: 'H.R. 200',
  actionText: 'Markup scheduled before the full committee.',
  url: 'https://congress.gov/bill/hr200',
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
/** Gate I: the entailment judge's response shape — {"verdicts":[...]}, distinct
 *  from the memo generator's {"sections":[...]}. */
function anthropicJudgeResponse(verdicts: Array<{ i: number; entailed: boolean; reason: string }>) {
  return jsonResponse({
    content: [{ type: 'text', text: JSON.stringify({ verdicts }) }],
    usage: { input_tokens: 100, output_tokens: 40 },
  });
}
/**
 * Gate I: a 2-call fetch — 1st call is the memo generator, 2nd (and any later)
 * call is the entailment judge. Every paragraph in `memoSections` must be
 * covered by ONE verdict per flattened paragraph index, in order.
 */
function stagedFetch(memoSections: unknown, judgeVerdicts: Array<{ entailed: boolean; reason: string }>) {
  let call = 0;
  return jest.fn(async () => {
    call += 1;
    if (call === 1) return anthropicTextResponse(memoSections);
    return anthropicJudgeResponse(judgeVerdicts.map((v, i) => ({ i, ...v })));
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
  /** Gate I (CG-01): force saveEdited's new-lock findFirst to return this,
   *  bypassing the in-memory store — for tests that exercise the lock in
   *  isolation (S3/S4) without running a full generate() flow first. */
  generationRecord?: { filingState: string } | null;
}) {
  const meriAuditLedgerRows: Array<{ data: Record<string, unknown> }> = [];
  const meriAuditLedgerFindFirstCalls: unknown[] = [];
  const reviewRequestFindManyCalls: unknown[] = [];
  // Gate I (CG-01): generate() now unconditionally writes an
  // AlertGenerationRecord, and saveEdited's new first lock reads it back. A
  // tiny in-memory store keeps create()/update()/findFirst() consistent so an
  // end-to-end generate()-then-saveEdited() test sees real effects, not a stub
  // that always returns the same canned value.
  const alertGenerationRecordRows: Array<{ data: Record<string, unknown> }> = [];
  const alertGenerationRecordUpdateCalls: unknown[] = [];
  const alertGenerationRecordStore = new Map<string, Record<string, unknown>>();
  let alertGenerationRecordSeq = 0;
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
        alertGenerationRecord: {
          create: jest.fn(async (args: { data: Record<string, unknown> }) => {
            alertGenerationRecordRows.push(args);
            alertGenerationRecordSeq += 1;
            const id = `gen-${alertGenerationRecordSeq}`;
            alertGenerationRecordStore.set(id, { id, ...args.data });
            return { id };
          }),
          update: jest.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
            alertGenerationRecordUpdateCalls.push(args);
            const existing = alertGenerationRecordStore.get(args.where.id) ?? {};
            const updated = { ...existing, ...args.data };
            alertGenerationRecordStore.set(args.where.id, updated);
            return updated;
          }),
          findFirst: jest.fn(async (args: { where?: { id?: string } }) => {
            if ('generationRecord' in opts) return opts.generationRecord;
            const id = args?.where?.id;
            return id ? (alertGenerationRecordStore.get(id) ?? null) : null;
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
    alertGenerationRecordRows,
    alertGenerationRecordUpdateCalls,
    alertGenerationRecordStore,
  };
}

describe('AlertMemoService — held-memo save bypass (Gate A, P0-01 items 1-4)', () => {
  const originalFetch = global.fetch;
  const originalAuditorMode = process.env.MERI_AUDITOR_MODE;
  const originalEntailmentMode = process.env.MERI_ENTAILMENT_MODE;

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalAuditorMode === undefined) delete process.env.MERI_AUDITOR_MODE;
    else process.env.MERI_AUDITOR_MODE = originalAuditorMode;
    if (originalEntailmentMode === undefined) delete process.env.MERI_ENTAILMENT_MODE;
    else process.env.MERI_ENTAILMENT_MODE = originalEntailmentMode;
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

/**
 * Gate I (CG-01) b-9 — the test the audit asks for, which fails without the
 * server-owned AlertGenerationRecord: none of S1-S4 (I_GOVERNANCE.md §1.4)
 * produce a banner or a decision:'hold' ledger row, so the pre-Gate-I locks
 * (L0-L3 above) have nothing to find and the held memo files anyway.
 *
 * S1/S2 run end-to-end (generate() really triggers an entailment-only hold,
 * auditor 'off', via a real fetch-mocked entailment judge call). S3/S4 exercise
 * the lock in isolation — directly injecting the DB state a real S3/S4
 * generate() call would have produced — because reproducing "entailment drops
 * every paragraph to a scaffold AND the auditor's deterministic checks also
 * fire on that same scaffold" end-to-end would coincidentally depend on the
 * auditor's specific check internals, which is not what this gate's fix
 * depends on: saveEdited only ever reads holdSource/filingState off the
 * record, never which upstream source produced it.
 */
describe('AlertMemoService — Gate I (CG-01): server-owned generation record closes S1-S4', () => {
  const originalFetch = global.fetch;
  const originalAuditorMode = process.env.MERI_AUDITOR_MODE;
  const originalEntailmentMode = process.env.MERI_ENTAILMENT_MODE;

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalAuditorMode === undefined) delete process.env.MERI_AUDITOR_MODE;
    else process.env.MERI_AUDITOR_MODE = originalAuditorMode;
    if (originalEntailmentMode === undefined) delete process.env.MERI_ENTAILMENT_MODE;
    else process.env.MERI_ENTAILMENT_MODE = originalEntailmentMode;
    jest.restoreAllMocks();
  });

  it('S1/S2 end-to-end: entailment-only hold (auditor off) produces no banner and no ledger row, yet saveEdited now BLOCKS it via the generation record', async () => {
    process.env.MERI_ENTAILMENT_MODE = 'enforce';
    process.env.MERI_AUDITOR_MODE = 'off';
    const { service, meriAuditLedgerRows, alertGenerationRecordRows } = makeDeps({
      createSystemReturns: null,
      hasOpenForSubject: false,
      pendingReviews: [],
    });
    global.fetch = stagedFetch(
      [
        {
          heading: 'Bottom line',
          paragraphs: [
            {
              text: 'The committee will likely favor the sponsor given prior private commitments.',
              claimIds: ['c1'],
            },
          ],
        },
      ],
      [{ entailed: false, reason: 'no claim supports a private commitment' }],
    ) as unknown as typeof fetch;

    const result = await service.generate(
      { tenantId: 't1', userId: 'u1', role: 'standard_user' } as never,
      'client-1',
      ENTAILMENT_REJECT_ALERT,
      'Acme Corp',
    );

    expect(result.held).toBe(true);
    expect(result.reviewRequestId).toBeNull();
    expect(result.markdown).not.toContain(HELD_BANNER_MARKER); // S1/S2: auditor never ran
    expect(meriAuditLedgerRows).toHaveLength(0); // S1/S2: no ledger row either
    expect(result.generationId).not.toBeNull();
    expect(alertGenerationRecordRows).toHaveLength(1);
    expect(alertGenerationRecordRows[0]!.data).toMatchObject({
      holdSource: 'entailment',
      filingState: 'blocked_pending_review',
    });

    await expect(
      service.saveEdited({ tenantId: 't1', userId: 'u1', role: 'standard_user' } as never, 'client-1', {
        title: result.title,
        markdown: result.markdown,
        clientName: 'Acme Corp',
        alertId: ENTAILMENT_REJECT_ALERT.alertId,
        generationId: result.generationId!,
      }),
    ).rejects.toThrow(ForbiddenException);
  });

  it('S3 in isolation: auditor SHADOW-with-findings shape (no banner, ledger says deliver) — old guards miss it, the generation record catches it', async () => {
    const withoutGenerationId = makeDeps({
      hasOpenForSubject: false,
      pendingReviews: [],
      recentHoldLedgerRow: null, // a decision:'hold' filter finds nothing — the real row says 'deliver'
    });
    await expect(
      withoutGenerationId.service.saveEdited(
        { tenantId: 't1', userId: 'u1', role: 'standard_user' } as never,
        'client-1',
        {
          title: 'Client memo — H.R. 8800',
          markdown: 'No banner here — shadow mode never adds one.',
          clientName: 'Acme Corp',
          alertId: 'alert-1',
        },
      ),
    ).resolves.toMatchObject({ document: { attachmentId: 'att-1' } }); // proves the pre-Gate-I gap

    const withGenerationId = makeDeps({
      hasOpenForSubject: false,
      pendingReviews: [],
      recentHoldLedgerRow: null,
      generationRecord: { filingState: 'blocked_pending_review' },
    });
    await expect(
      withGenerationId.service.saveEdited(
        { tenantId: 't1', userId: 'u1', role: 'standard_user' } as never,
        'client-1',
        {
          title: 'Client memo — H.R. 8800',
          markdown: 'No banner here — shadow mode never adds one.',
          clientName: 'Acme Corp',
          alertId: 'alert-1',
          generationId: 'gen-shadow-1',
        },
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it('S4 in isolation: auditor ANNOTATE-with-findings shape (banner present, ledger says deliver_with_flags) — old guards miss it, the generation record catches it', async () => {
    const bannerMarkdown = `> ⚠️ **Unverified — 1 ${HELD_BANNER_MARKER} (checkX).**\n\nBody.`;

    const withoutGenerationId = makeDeps({
      hasOpenForSubject: false,
      pendingReviews: [], // L3 needs pending.length > 0 — empty, so the banner alone doesn't block
      recentHoldLedgerRow: null, // L0 filters decision:'hold' — the real row says 'deliver_with_flags'
    });
    await expect(
      withoutGenerationId.service.saveEdited(
        { tenantId: 't1', userId: 'u1', role: 'standard_user' } as never,
        'client-1',
        {
          title: 'Client memo — H.R. 8800',
          markdown: bannerMarkdown,
          clientName: 'Acme Corp',
          alertId: 'alert-1',
        },
      ),
    ).resolves.toMatchObject({ document: { attachmentId: 'att-1' } }); // proves the pre-Gate-I gap

    const withGenerationId = makeDeps({
      hasOpenForSubject: false,
      pendingReviews: [],
      recentHoldLedgerRow: null,
      generationRecord: { filingState: 'blocked_pending_review' },
    });
    await expect(
      withGenerationId.service.saveEdited(
        { tenantId: 't1', userId: 'u1', role: 'standard_user' } as never,
        'client-1',
        {
          title: 'Client memo — H.R. 8800',
          markdown: bannerMarkdown,
          clientName: 'Acme Corp',
          alertId: 'alert-1',
          generationId: 'gen-annotate-1',
        },
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it('I-4: an admin can still release a blocked_pending_review generation', async () => {
    const { service, engagement } = makeDeps({
      generationRecord: { filingState: 'blocked_pending_review' },
    });

    await expect(
      service.saveEdited({ tenantId: 't1', userId: 'admin-1', role: 'user_admin' } as never, 'client-1', {
        title: 'Client memo — H.R. 8800',
        markdown: 'Admin-edited body.',
        clientName: 'Acme Corp',
        alertId: 'alert-1',
        generationId: 'gen-blocked-1',
      }),
    ).resolves.toMatchObject({ document: { attachmentId: 'att-1' } });
    expect(engagement.createAttachmentFromBuffer).toHaveBeenCalledTimes(1);
  });

  it('I-5: a clean (non-held) generation writes holdSource:none/filingState:draft, and its generationId never blocks a later save', async () => {
    process.env.MERI_AUDITOR_MODE = 'off';
    const { service, alertGenerationRecordRows } = makeDeps({ hasOpenForSubject: false, pendingReviews: [] });
    global.fetch = CLEAN_FETCH as unknown as typeof fetch;

    const result = await service.generate(
      { tenantId: 't1', userId: 'u1', role: 'standard_user' } as never,
      'client-1',
      CLEAN_ALERT,
      'Acme Corp',
    );

    expect(result.held).toBe(false);
    expect(result.generationId).not.toBeNull();
    expect(alertGenerationRecordRows[0]!.data).toMatchObject({
      holdSource: 'none',
      filingState: 'draft',
    });

    await expect(
      service.saveEdited({ tenantId: 't1', userId: 'u1', role: 'standard_user' } as never, 'client-1', {
        title: result.title,
        markdown: result.markdown,
        clientName: 'Acme Corp',
        alertId: CLEAN_ALERT.alertId,
        generationId: result.generationId!,
      }),
    ).resolves.toMatchObject({ document: { attachmentId: 'att-1' } });
  });
});
