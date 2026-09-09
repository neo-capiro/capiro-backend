import { HearingBriefService } from '../src/hearing/hearing-brief.service.js';

/**
 * H4 — SC4.1 (all sections populated) + SC4.2 (every claim sourced to a
 * segment id + timestamp). Uses the deterministic fallback (orchestrator not
 * configured) so the test is hermetic.
 */
describe('HearingBriefService (deterministic fallback)', () => {
  const tenantId = 'tenant_capiro';
  const sessionId = 'sess_1';

  function makeService() {
    const session = { id: sessionId, tenantId, title: 'HASC FY26 Posture Hearing', status: 'ended' };
    const quotes = [
      {
        id: 'q1',
        segmentId: 'seg_1',
        startMs: 12000,
        speakerName: 'Rep. Smith',
        issueTags: ['unmanned systems'],
        textCiphertext: null,
        iv: null,
        authTag: null,
        textPlain: 'We must fully fund the autonomy program.',
      },
    ];
    const tables = {
      liveHearingSession: { findFirst: async () => session },
      keyQuote: { findMany: async () => quotes },
      liveActionItem: { findMany: async () => [{ description: 'Send funding one-pager to staff' }] },
      entityMention: { findMany: async () => [{ entityType: 'program', entityLabel: 'autonomy program', entityRef: 'PE0603xxx' }] },
      liveSummaryCard: { findMany: async () => [{ cardType: 'support_signal', title: 'Rep. Smith supportive', startMs: 12000 }] },
    };
    // The service reads through `withTenant`; the double hands back the same tables.
    const prisma = {
      ...tables,
      withTenant: async (_tenant: string, fn: (tx: typeof tables) => unknown) => fn(tables),
    } as never;
    const crypto = { configured: false, decrypt: () => '' } as never;
    const orchestrator = { configured: false } as never;
    const clientContext = { configured: false, fetch: async () => null } as never;
    return new HearingBriefService(prisma, crypto, orchestrator, clientContext);
  }

  it('produces a brief with all sections + sourced claim map (SC4.1/4.2)', async () => {
    const svc = makeService();
    const brief = await svc.generate(tenantId, sessionId, 'token');
    expect(brief).not.toBeNull();
    if (!brief) return;

    expect(brief.title).toBe('HASC FY26 Posture Hearing');
    expect(brief.executiveSummary.length).toBeGreaterThan(0);
    expect(brief.relevantQuotes.length).toBe(1);
    expect(brief.draftClientEmail.subject).toContain('HASC');
    expect(brief.recommendedNextSteps).toContain('Send funding one-pager to staff');
    expect(brief.synthesisSource).toBe('deterministic');

    // SC4.2: every claim in the claim map points to a segment id + timestamp.
    expect(brief.claimMap.length).toBe(1);
    for (const c of brief.claimMap) {
      expect(c.segmentId).toBeTruthy();
      expect(typeof c.timestampMs).toBe('number');
    }
    // every quote is sourced too
    for (const q of brief.relevantQuotes) {
      expect(q.segmentId).toBeTruthy();
      expect(typeof q.timestampMs).toBe('number');
    }
  });

  it('returns null for a session outside the tenant', async () => {
    const svc = makeService();
    // override findFirst to simulate not-found
    (svc as unknown as { prisma: { liveHearingSession: { findFirst: () => Promise<null> } } }).prisma.liveHearingSession.findFirst =
      async () => null;
    const brief = await svc.generate('other_tenant', sessionId, 'token');
    expect(brief).toBeNull();
  });

  it('without a client the brief is client-agnostic and says so (clientContext none)', async () => {
    const brief = await makeService().generate(tenantId, sessionId, 'token');
    expect(brief?.clientContext).toEqual({
      clientId: null,
      clientName: null,
      status: 'none',
      relevanceBand: null,
    });
  });
});

describe('HearingBriefService (client-aware)', () => {
  const tenantId = 'tenant_capiro';
  const sessionId = 'sess_1';
  const clientId = '22222222-2222-4222-8222-222222222222';

  function makeService(opts: {
    fetch: jest.Mock;
    summarize?: jest.Mock;
    hearingId?: string | null;
  }) {
    const session = {
      id: sessionId,
      tenantId,
      title: 'HASC FY26 Posture Hearing',
      status: 'ended',
      // `undefined` = the default canonical hearing; an explicit `null` models an
      // ad-hoc browser-captured session with no canonical hearing at all.
      hearingId: opts.hearingId === undefined ? 'cm-119-119533' : opts.hearingId,
    };
    const tables = {
      liveHearingSession: { findFirst: async () => session },
      keyQuote: {
        findMany: async () => [
          {
            id: 'q1',
            segmentId: 'seg_1',
            startMs: 12000,
            speakerName: 'Rep. Smith',
            issueTags: [],
            textCiphertext: null,
            iv: null,
            authTag: null,
            textPlain: 'We must fully fund the autonomy program.',
          },
        ],
      },
      liveActionItem: { findMany: async () => [] },
      entityMention: { findMany: async () => [] },
      liveSummaryCard: { findMany: async () => [] },
    };
    const prisma = {
      ...tables,
      withTenant: async (_tenant: string, fn: (tx: typeof tables) => unknown) => fn(tables),
    } as never;
    const crypto = { configured: false, decrypt: () => '' } as never;
    const orchestrator = opts.summarize
      ? ({ configured: true, summarizeHearing: opts.summarize } as never)
      : ({ configured: false } as never);
    const clientContext = { configured: true, fetch: opts.fetch } as never;
    return new HearingBriefService(prisma, crypto, orchestrator, clientContext);
  }

  const relevance = {
    band: 'HIGH' as const,
    score: 0.82,
    whyItMatters: 'The autonomy line the client sells was debated directly.',
    matchedPriorities: [{ label: 'autonomous systems', kind: 'watchlist' }],
    implications: ['A funding cut would hit FY27 orders'],
  };

  it('asks apps/api for the client context with the session\'s canonical hearing id', async () => {
    const fetch = jest.fn().mockResolvedValue({ clientName: 'Anduril', relevance });
    const svc = makeService({ fetch });
    await svc.generate(tenantId, sessionId, 'token', clientId);
    expect(fetch).toHaveBeenCalledWith({ tenantId, clientId, hearingId: 'cm-119-119533' });
  });

  it('forwards the client block to the orchestrator and reports the status it returns', async () => {
    const fetch = jest.fn().mockResolvedValue({ clientName: 'Anduril', relevance });
    const summarize = jest.fn().mockResolvedValue({
      executiveSummary: 'Anduril-specific summary.',
      tone: 'contentious',
      risks: ['Amendment may strip the autonomy line'],
      opportunities: [],
      recommendedNextSteps: ['Brief the program office'],
      draftClientEmail: { subject: 'Recap', body: 'Hi Anduril team,' },
      clientContext: 'applied',
    });
    const svc = makeService({ fetch, summarize });
    const brief = await svc.generate(tenantId, sessionId, 'token', clientId);

    expect(summarize).toHaveBeenCalledWith(
      expect.objectContaining({
        client: {
          clientId,
          name: 'Anduril',
          relevance: {
            band: 'HIGH',
            whyItMatters: relevance.whyItMatters,
            matchedPriorities: relevance.matchedPriorities,
            implications: relevance.implications,
          },
        },
      }),
    );
    expect(brief?.synthesisSource).toBe('orchestrator');
    expect(brief?.clientContext).toEqual({
      clientId,
      clientName: 'Anduril',
      status: 'applied',
      relevanceBand: 'HIGH',
    });
  });

  it('deterministic fallback still carries the STORED relevance rationale for the client, verbatim', async () => {
    const fetch = jest.fn().mockResolvedValue({ clientName: 'Anduril', relevance });
    const brief = await makeService({ fetch }).generate(tenantId, sessionId, 'token', clientId);
    expect(brief?.synthesisSource).toBe('deterministic');
    expect(brief?.executiveSummary).toContain('Relevance to Anduril (HIGH');
    expect(brief?.executiveSummary).toContain(relevance.whyItMatters);
    // Matched relevance IS client context even when the model never ran.
    expect(brief?.clientContext.status).toBe('applied');
  });

  it('is honest when the client context hop fails: unavailable, not silently generic', async () => {
    const fetch = jest.fn().mockResolvedValue(null);
    const brief = await makeService({ fetch }).generate(tenantId, sessionId, 'token', clientId);
    expect(brief?.clientContext).toEqual({
      clientId,
      clientName: null,
      status: 'unavailable',
      relevanceBand: null,
    });
    expect(brief?.executiveSummary).not.toContain('Relevance to');
  });

  it('a NONE band is an honest absence: unavailable, and no relevance sentence is written', async () => {
    const fetch = jest.fn().mockResolvedValue({
      clientName: 'Anduril',
      relevance: { ...relevance, band: 'NONE', whyItMatters: 'No stored relevance.' },
    });
    const brief = await makeService({ fetch }).generate(tenantId, sessionId, 'token', clientId);
    expect(brief?.clientContext.status).toBe('unavailable');
    expect(brief?.clientContext.relevanceBand).toBe('NONE');
    expect(brief?.executiveSummary).not.toContain('No stored relevance.');
  });

  it('a session with no canonical hearing still resolves the client name (hearingId null)', async () => {
    const fetch = jest.fn().mockResolvedValue({ clientName: 'Anduril', relevance: null });
    const brief = await makeService({ fetch, hearingId: null }).generate(
      tenantId,
      sessionId,
      'token',
      clientId,
    );
    expect(fetch).toHaveBeenCalledWith({ tenantId, clientId, hearingId: null });
    expect(brief?.clientContext.clientName).toBe('Anduril');
    expect(brief?.clientContext.status).toBe('unavailable');
  });
});
