import {
  buildPhase8Recap,
  decodePhase8Cursor,
  derivePhase8Status,
  encodePhase8Cursor,
  groupPhase8Relevance,
  type Phase8PublicInsight,
} from './live-hearings-phase8.service.js';

function insight(
  id: string,
  insightType: string,
  relevance: Phase8PublicInsight['relevance'] = [],
): Phase8PublicInsight {
  return {
    id,
    insightType,
    title: `${insightType} title`,
    summary: `${insightType} summary`,
    speakerName: 'Speaker One',
    confidence: 0.9,
    preliminary: false,
    entities: [],
    evidence: {
      segmentId: `segment-${id}`,
      sequence: 1,
      startMs: 1_000,
      endMs: 2_000,
      text: 'Grounded evidence.',
    },
    extractor: { name: 'deterministic-public-facts', version: '1' },
    createdAt: '2026-08-21T00:00:00.000Z',
    updatedAt: '2026-08-21T00:00:00.000Z',
    relevance,
  };
}

describe('Live Hearings Phase 8 contract helpers', () => {
  it('round-trips the stable sequence/id cursor and rejects malformed input', () => {
    const encoded = encodePhase8Cursor({ sequence: 17, id: 'phi_abc' });
    expect(decodePhase8Cursor(encoded)).toEqual({ sequence: 17, id: 'phi_abc' });
    expect(decodePhase8Cursor('not-base64-json')).toBeNull();
    expect(
      decodePhase8Cursor(Buffer.from(JSON.stringify({ sequence: -1, id: 'x' })).toString('base64url')),
    ).toBeNull();
  });

  it('distinguishes processing, degraded, failed, ready and empty states', () => {
    expect(
      derivePhase8Status({ total: 0, publicCounts: { pending: 2 }, tenantCounts: {} }),
    ).toBe('PROCESSING');
    expect(
      derivePhase8Status({ total: 3, publicCounts: { failed: 1 }, tenantCounts: {} }),
    ).toBe('DEGRADED');
    expect(
      derivePhase8Status({ total: 0, publicCounts: { failed: 1 }, tenantCounts: {} }),
    ).toBe('FAILED');
    expect(derivePhase8Status({ total: 3, publicCounts: {}, tenantCounts: {} })).toBe('READY');
    expect(derivePhase8Status({ total: 0, publicCounts: {}, tenantCounts: {} })).toBe('EMPTY');
  });

  it('builds a source-grounded recap from persisted typed findings only', () => {
    const items = [
      insight('commitment', 'COMMITMENT'),
      insight('deadline', 'DEADLINE'),
      insight('funding', 'FUNDING_AMOUNT'),
      insight('question', 'QUESTION'),
    ];
    const recap = buildPhase8Recap(items, {
      final: true,
      total: items.length,
      byType: {
        COMMITMENT: 1,
        DEADLINE: 1,
        FUNDING_AMOUNT: 1,
        QUESTION: 1,
      },
    });
    expect(recap.state).toBe('FINAL');
    expect(recap.overview).toContain('4 source-grounded findings');
    expect(recap.commitments.map((item) => item.id)).toEqual(['commitment']);
    expect(recap.deadlines.map((item) => item.id)).toEqual(['deadline']);
    expect(recap.funding.map((item) => item.id)).toEqual(['funding']);
  });

  it('groups tenant relevance without changing the public insight', () => {
    const match = {
      id: 'thr-1',
      clientId: 'client-a',
      clientName: 'Client A',
      insightId: 'phi-1',
      score: 75,
      matchedOn: [
        { kind: 'BILL', value: '119-HR-1' },
        { kind: 'KEYWORD', value: 'autonomy' },
      ],
      rationale: 'Matched bill and keyword.',
      createdAt: '2026-08-21T00:00:00.000Z',
      updatedAt: '2026-08-21T00:00:00.000Z',
    };
    const groups = groupPhase8Relevance([
      insight('phi-1', 'BILL_REFERENCE', [match]),
      insight('phi-2', 'MENTION', [
        { ...match, id: 'thr-2', insightId: 'phi-2', score: 40 },
      ]),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      clientId: 'client-a',
      clientName: 'Client A',
      maxScore: 75,
      matchCount: 2,
    });
    expect(groups[0]?.matchedOn).toEqual(
      expect.arrayContaining([
        { kind: 'BILL', value: '119-HR-1' },
        { kind: 'KEYWORD', value: 'autonomy' },
      ]),
    );
  });
});
