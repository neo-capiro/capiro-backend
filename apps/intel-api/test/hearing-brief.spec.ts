import { ServiceUnavailableException } from '@nestjs/common';
import { HearingBriefService } from '../src/hearing/hearing-brief.service.js';

/**
 * H4 — the legacy saved-brief path is now an LLM-AUTHORED recap, never a
 * stitched deterministic assembly. These tests pin:
 *  - tenant/session scoping (a session outside the tenant returns null),
 *  - a FINAL transcript is REQUIRED (no usable segments => null before any model call),
 *  - the decrypted narrative source reaches the orchestrator (late material included),
 *  - sensitive encrypted segments are decrypted; undecryptable rows are excluded
 *    from the source but counted in coverage,
 *  - no usable LLM (not configured / null / malformed / foreign refs) => 503
 *    HEARING_RECAP_SYNTHESIS_UNAVAILABLE, never a fabricated recap,
 *  - supporters/opponents are NOT derived from summary-card titles.
 */

const tenantId = 'tenant_capiro';
const sessionId = 'sess_1';
const clerkUserId = 'user_1';

/** Build N plaintext FINAL transcript segments spanning the recording. */
function segments(n: number, text = 'transcript segment') {
  return Array.from({ length: n }, (_, i) => ({
    id: `seg_${i}`,
    sessionId,
    tenantId,
    startMs: i * 1000,
    endMs: i * 1000 + 900,
    speakerLabel: i % 2 ? '1' : '0',
    isFinal: true,
    textCiphertext: null,
    iv: null,
    authTag: null,
    textPlain: `${text} ${i}`,
  }));
}

/** A valid LLM-authored orchestrator result citing the supplied source. */
function authoredRecap(sourceIds: string[]) {
  return {
    executiveSummary: 'The subcommittee debated water and wildlife policy across several bills.',
    tone: 'Measured and policy-focused.',
    risks: ['A permitting change could shift compliance cost'],
    opportunities: ['A settlement framework may open engagement'],
    recommendedNextSteps: ['If the client tracks water settlements, monitor the bill text'],
    draftClientEmail: { subject: 'Recap', body: 'Hi,' },
    clientContext: 'none' as const,
    summaryTitle: 'Water, Wildlife and Fisheries legislative hearing',
    keyDevelopments: [
      {
        title: 'Manatees and the Endangered Species Act',
        text: 'Discussion of warm-water refuges and ESA status for manatees.',
        evidenceIds: [sourceIds[0]!, sourceIds[sourceIds.length - 1]!],
      },
      {
        title: 'Tribal water settlements',
        text: 'A settlement framework was discussed for tribal water rights.',
        evidenceIds: [sourceIds[1] ?? sourceIds[0]!],
      },
    ],
  };
}

function makeService(opts: {
  segs?: ReturnType<typeof segments>;
  summarize?: jest.Mock;
  orchestratorConfigured?: boolean;
  crypto?: { configured: boolean; decrypt: (p: unknown) => string };
  fetch?: jest.Mock;
}) {
  const session = {
    id: sessionId,
    tenantId,
    title: 'Water, Wildlife and Fisheries Legislative Hearing',
    status: 'ended',
    hearingId: 'cm-119-119529',
  };
  const tables = {
    liveHearingSession: { findFirst: async () => session },
    keyQuote: { findMany: async () => [] },
    liveActionItem: { findMany: async () => [] },
    entityMention: { findMany: async () => [] },
    // Concern-titled cards must NOT become opponents.
    liveSummaryCard: {
      findMany: async () => [
        { cardType: 'concern', title: 'Manatee Population Concern', startMs: 1000 },
        { cardType: 'concern', title: 'Public Access Concern', startMs: 2000 },
      ],
    },
    transcriptSegment: { findMany: async () => opts.segs ?? segments(6) },
  };
  const prisma = {
    ...tables,
    withTenant: async (_t: string, fn: (tx: typeof tables) => unknown) => fn(tables),
  } as never;
  const crypto = (opts.crypto ?? { configured: false, decrypt: () => '' }) as never;
  const orchestrator = opts.summarize
    ? ({ configured: true, summarizeHearing: opts.summarize } as never)
    : ({ configured: opts.orchestratorConfigured ?? false } as never);
  const clientContext = {
    configured: true,
    fetch: opts.fetch ?? jest.fn().mockResolvedValue(null),
  } as never;
  return new HearingBriefService(prisma, crypto, orchestrator, clientContext);
}

describe('HearingBriefService — narrative recap sourcing', () => {
  it('returns null for a session outside the tenant', async () => {
    const svc = makeService({});
    (
      svc as unknown as { prisma: { liveHearingSession: { findFirst: () => Promise<null> } } }
    ).prisma.liveHearingSession.findFirst = async () => null;
    await expect(svc.generate('other_tenant', sessionId, clerkUserId)).resolves.toBeNull();
  });

  it('returns null when there is NO usable FINAL transcript — before any model call', async () => {
    const summarize = jest.fn();
    const svc = makeService({ segs: [], summarize });
    await expect(svc.generate(tenantId, sessionId, clerkUserId)).resolves.toBeNull();
    expect(summarize).not.toHaveBeenCalled();
  });

  it('feeds the FULL decrypted narrative source (late material included) to the orchestrator', async () => {
    const segs = segments(20);
    const sourceIds = segs.map((s) => s.id);
    const summarize = jest.fn().mockResolvedValue(authoredRecap(sourceIds));
    const svc = makeService({ segs, summarize });
    const brief = await svc.generate(tenantId, sessionId, clerkUserId);
    expect(brief).not.toBeNull();
    const call = summarize.mock.calls[0]![0];
    // Whole-recording chronological coverage: first AND last segment present.
    const fedIds = call.narrativeSource.map((s: { segmentId: string }) => s.segmentId);
    expect(fedIds[0]).toBe('seg_0');
    expect(fedIds[fedIds.length - 1]).toBe('seg_19');
    expect(call.narrativeSource).toHaveLength(20);
    // New structured fields populated; legacy clipped-quote keyMoments gone.
    expect(brief!.summaryTitle).toBe('Water, Wildlife and Fisheries legislative hearing');
    expect(brief!.keyDevelopments).toHaveLength(2);
    expect(brief!.keyMoments).toEqual([]);
    expect(brief!.synthesisSource).toBe('orchestrator');
    // Coverage: all 20 stored, all 20 included, not limited.
    expect(brief!.sourceCoverage).toEqual({
      availableSegments: 20,
      includedSegments: 20,
      startMs: 0,
      endMs: 19900,
      limited: false,
      omittedSegments: 0,
      truncatedSegments: 0,
    });
    // claimMap covers the whole narrative source (every citable ID resolvable).
    expect(brief!.claimMap).toHaveLength(20);
    expect(brief!.claimMap[0]).toMatchObject({ segmentId: 'seg_0', timestampMs: 0, endMs: 900 });
  });

  it('decrypts sensitive segments and EXCLUDES undecryptable rows from source but counts them in coverage', async () => {
    // 4 plaintext + 1 encrypted (decryptable) + 1 with no key (unreadable).
    const segs = [
      ...segments(4),
      {
        id: 'seg_enc',
        sessionId,
        tenantId,
        startMs: 4000,
        endMs: 4900,
        speakerLabel: '0',
        isFinal: true,
        textCiphertext: 'ciphertext',
        iv: 'iv',
        authTag: 'tag',
        textPlain: null,
      },
      {
        id: 'seg_locked',
        sessionId,
        tenantId,
        startMs: 5000,
        endMs: 5900,
        speakerLabel: '1',
        isFinal: true,
        textCiphertext: 'ciphertext2',
        iv: 'iv2',
        authTag: 'tag2',
        textPlain: null,
      },
    ];
    const crypto = {
      configured: true,
      // Only seg_enc decrypts; seg_locked throws -> '[decryption unavailable]'.
      decrypt: (p: unknown) =>
        (p as { textCiphertext: string }).textCiphertext === 'ciphertext'
          ? 'decrypted sensitive statement'
          : (() => {
              throw new Error('bad key');
            })(),
    };
    const sourceIds = ['seg_0', 'seg_1', 'seg_2', 'seg_3', 'seg_enc'];
    const summarize = jest.fn().mockResolvedValue(authoredRecap(sourceIds));
    const svc = makeService({ segs, summarize, crypto });
    const brief = await svc.generate(tenantId, sessionId, clerkUserId);
    const fedIds = summarize.mock.calls[0]![0].narrativeSource.map(
      (s: { segmentId: string }) => s.segmentId,
    );
    expect(fedIds).toContain('seg_enc'); // decrypted sensitive content included
    expect(fedIds).not.toContain('seg_locked'); // undecryptable excluded
    expect(
      summarize.mock.calls[0]![0].narrativeSource.some(
        (s: { text: string }) => s.text === 'decrypted sensitive statement',
      ),
    ).toBe(true);
    // Coverage: 6 stored FINAL rows, 5 included, the locked row is disclosed.
    expect(brief!.sourceCoverage!.availableSegments).toBe(6);
    expect(brief!.sourceCoverage!.includedSegments).toBe(5);
    expect(brief!.sourceCoverage!.omittedSegments).toBe(1);
    expect(brief!.sourceCoverage!.limited).toBe(true);
  });

  it('never promotes summary-card concern titles to supporters/opponents', async () => {
    const segs = segments(4);
    const summarize = jest.fn().mockResolvedValue(authoredRecap(segs.map((s) => s.id)));
    const brief = await makeService({ segs, summarize }).generate(tenantId, sessionId, clerkUserId);
    expect(brief!.supporters).toEqual([]);
    expect(brief!.opponents).toEqual([]);
  });

  it('bounds a long recording to <=500 segments, keeps first+last, and discloses limited coverage', async () => {
    const segs = segments(800);
    // Whatever the model cites must be in the actually-included source; cite the
    // first and last ids — both are guaranteed retained by the bounder.
    const recap = authoredRecap(['seg_0', 'seg_799']);
    const summarize = jest.fn().mockImplementation((args) => {
      const ids = args.narrativeSource.map((s: { segmentId: string }) => s.segmentId);
      expect(ids.length).toBeLessThanOrEqual(500);
      expect(ids[0]).toBe('seg_0');
      expect(ids[ids.length - 1]).toBe('seg_799');
      return Promise.resolve({
        ...recap,
        keyDevelopments: [
          { title: 'Opening', text: 'opening material', evidenceIds: ['seg_0'] },
          { title: 'Late', text: 'late material', evidenceIds: ['seg_799'] },
        ],
      });
    });
    const brief = await makeService({ segs, summarize }).generate(tenantId, sessionId, clerkUserId);
    expect(brief!.sourceCoverage!.availableSegments).toBe(800);
    expect(brief!.sourceCoverage!.includedSegments).toBeLessThanOrEqual(500);
    expect(brief!.sourceCoverage!.limited).toBe(true);
    expect(brief!.sourceCoverage!.omittedSegments).toBe(
      800 - brief!.sourceCoverage!.includedSegments,
    );
  });

  it('truncates an oversized segment to the wire cap and flags coverage limited', async () => {
    const segs = [
      { ...segments(1)[0]!, id: 'seg_big', textPlain: 'x'.repeat(25000) },
      ...segments(3).map((s, i) => ({ ...s, id: `seg_s${i}` })),
    ];
    const summarize = jest.fn().mockImplementation((args) => {
      const big = args.narrativeSource.find(
        (s: { segmentId: string }) => s.segmentId === 'seg_big',
      );
      expect(big.text.length).toBeLessThanOrEqual(20000);
      return Promise.resolve({
        ...authoredRecap(['seg_big']),
        keyDevelopments: [{ title: 'T', text: 'x', evidenceIds: ['seg_big'] }],
      });
    });
    const brief = await makeService({ segs, summarize }).generate(tenantId, sessionId, clerkUserId);
    expect(brief!.sourceCoverage!.truncatedSegments).toBe(1);
    expect(brief!.sourceCoverage!.limited).toBe(true);
  });
});

describe('HearingBriefService — synthesis unavailable => 503, never fabricated', () => {
  it('orchestrator NOT configured => 503 HEARING_RECAP_SYNTHESIS_UNAVAILABLE', async () => {
    const svc = makeService({ orchestratorConfigured: false });
    const err = await svc.generate(tenantId, sessionId, clerkUserId).catch((e) => e);
    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect((err as ServiceUnavailableException).getResponse()).toMatchObject({
      code: 'HEARING_RECAP_SYNTHESIS_UNAVAILABLE',
    });
  });

  it('orchestrator returns null => 503', async () => {
    const summarize = jest.fn().mockResolvedValue(null);
    const svc = makeService({ summarize });
    await expect(svc.generate(tenantId, sessionId, clerkUserId)).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'HEARING_RECAP_SYNTHESIS_UNAVAILABLE' }),
    });
  });

  it('malformed/empty model output (empty summary or no developments) => 503', async () => {
    const summarize = jest
      .fn()
      .mockResolvedValue({ executiveSummary: '', keyDevelopments: [], tone: '', risks: [] });
    const svc = makeService({ summarize });
    await expect(svc.generate(tenantId, sessionId, clerkUserId)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('foreign development references (IDs not in the narrative source) => 503', async () => {
    const segs = segments(4);
    const bad = authoredRecap(segs.map((s) => s.id));
    bad.keyDevelopments = [{ title: 'T', text: 'x', evidenceIds: ['seg_NOT_IN_SOURCE'] }];
    const summarize = jest.fn().mockResolvedValue(bad);
    const svc = makeService({ segs, summarize });
    await expect(svc.generate(tenantId, sessionId, clerkUserId)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('orchestrator throws => 503', async () => {
    const summarize = jest.fn().mockRejectedValue(new Error('boom'));
    const svc = makeService({ summarize });
    await expect(svc.generate(tenantId, sessionId, clerkUserId)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});

describe('HearingBriefService — client context honesty', () => {
  const clientId = '22222222-2222-4222-8222-222222222222';

  it('NONE band does NOT force a no-bearing/no-action narrative; status is unavailable, recap still authored', async () => {
    const segs = segments(4);
    const fetch = jest.fn().mockResolvedValue({
      clientName: 'Anduril',
      relevance: {
        band: 'NONE',
        whyItMatters: 'No stored relevance.',
        matchedPriorities: [],
        implications: [],
      },
    });
    const summarize = jest.fn().mockResolvedValue(authoredRecap(segs.map((s) => s.id)));
    const brief = await makeService({ segs, summarize, fetch }).generate(
      tenantId,
      sessionId,
      clerkUserId,
      clientId,
    );
    expect(brief).not.toBeNull();
    // The authored summary is used verbatim — no injected "no bearing" claim.
    expect(brief!.executiveSummary).not.toContain('No stored relevance.');
    expect(brief!.executiveSummary).not.toMatch(/no bearing|no action|not relevant/i);
    expect(brief!.clientContext.status).toBe('unavailable');
    expect(brief!.clientContext.relevanceBand).toBe('NONE');
  });

  it('a matched HIGH relevance is client context (applied) and forwarded to the model', async () => {
    const segs = segments(4);
    const fetch = jest.fn().mockResolvedValue({
      clientName: 'Anduril',
      relevance: {
        band: 'HIGH',
        whyItMatters: 'The autonomy line the client sells was debated directly.',
        matchedPriorities: [{ label: 'autonomous systems', kind: 'watchlist' }],
        implications: ['A funding cut would hit FY27 orders'],
      },
    });
    const summarize = jest.fn().mockResolvedValue({
      ...authoredRecap(segs.map((s) => s.id)),
      clientContext: 'applied',
    });
    const brief = await makeService({ segs, summarize, fetch }).generate(
      tenantId,
      sessionId,
      clerkUserId,
      clientId,
    );
    expect(summarize).toHaveBeenCalledWith(
      expect.objectContaining({
        client: expect.objectContaining({ clientId, name: 'Anduril' }),
      }),
    );
    expect(brief!.clientContext.status).toBe('applied');
    expect(brief!.clientContext.relevanceBand).toBe('HIGH');
  });
});
