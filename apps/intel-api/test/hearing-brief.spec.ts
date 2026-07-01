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
    const prisma = {
      liveHearingSession: { findFirst: async () => session },
      keyQuote: { findMany: async () => quotes },
      liveActionItem: { findMany: async () => [{ description: 'Send funding one-pager to staff' }] },
      entityMention: { findMany: async () => [{ entityType: 'program', entityLabel: 'autonomy program', entityRef: 'PE0603xxx' }] },
      liveSummaryCard: { findMany: async () => [{ cardType: 'support_signal', title: 'Rep. Smith supportive', startMs: 12000 }] },
    } as never;
    const crypto = { configured: false, decrypt: () => '' } as never;
    const orchestrator = { configured: false } as never;
    return new HearingBriefService(prisma, crypto, orchestrator);
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
});
