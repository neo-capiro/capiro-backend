import { describe, expect, it } from 'vitest';
import {
  normalizePhase8Insight,
  normalizePhase8Intelligence,
} from './live-hearings-phase8-api.js';

describe('Phase 8 Live Hearings intelligence contracts', () => {
  it('normalizes public evidence and tenant relevance as separate layers', () => {
    const result = normalizePhase8Intelligence({
      hearingId: 'hearing-1',
      status: 'READY',
      sourceBoundary: 'CANONICAL_PUBLIC_TRANSCRIPT_ONLY',
      summary: {
        total: 1,
        returned: 1,
        preliminary: 0,
        evidenceSegments: 1,
        clientRelevant: 1,
        byType: { COMMITMENT: 1 },
      },
      recap: {
        state: 'FINAL',
        overview: 'One source-grounded commitment.',
        commitments: [],
        deadlines: [],
        funding: [],
        policyPositions: [],
        questions: [],
        keyQuotes: [],
        references: [],
      },
      items: [
        {
          id: 'phi-1',
          insightType: 'COMMITMENT',
          title: 'Agency commitment',
          summary: 'The witness committed to provide the report.',
          speakerName: 'Witness One',
          confidence: 0.91,
          preliminary: false,
          entities: [{ entityType: 'AGENCY', label: 'Department of Example' }],
          evidence: {
            segmentId: 'segment-1',
            sequence: 22,
            startMs: 90_000,
            endMs: 95_000,
            text: 'We will provide that report next week.',
          },
          extractor: { name: 'deterministic-public-facts', version: '1' },
          relevance: [
            {
              id: 'thr-1',
              clientId: 'client-1',
              clientName: 'Client One',
              insightId: 'phi-1',
              score: 75,
              matchedOn: [{ kind: 'AGENCY', value: 'Department of Example' }],
              rationale: 'Matched agency.',
            },
          ],
        },
      ],
      clientGroups: [
        {
          clientId: 'client-1',
          clientName: 'Client One',
          maxScore: 75,
          matchCount: 1,
          insightIds: ['phi-1'],
          matchedOn: [{ kind: 'AGENCY', value: 'Department of Example' }],
          rationales: ['Matched agency.'],
        },
      ],
      jobs: { public: { completed: 1 }, tenant: { completed: 1 } },
      hasMore: false,
      disclaimer: 'Verify consequential quotations.',
    });

    expect(result.status).toBe('READY');
    expect(result.items[0]).toMatchObject({
      id: 'phi-1',
      insightType: 'COMMITMENT',
      evidence: { segmentId: 'segment-1', sequence: 22, startMs: 90_000 },
    });
    expect(result.items[0]?.relevance[0]).toMatchObject({
      clientId: 'client-1',
      score: 75,
    });
    expect(result.clientGroups[0]).toMatchObject({ clientId: 'client-1', matchCount: 1 });
  });

  it('drops malformed insight, entity and relevance rows rather than inventing defaults', () => {
    expect(normalizePhase8Insight({ title: 'Missing identity and evidence' })).toBeNull();

    const insight = normalizePhase8Insight({
      id: 'phi-2',
      insightType: 'QUESTION',
      title: 'Question',
      summary: 'A question was asked.',
      entities: [null, {}, { entityType: 'BILL', label: 'H.R. 1', canonicalId: '119-HR-1' }],
      evidence: { segmentId: 'segment-2', sequence: '3', startMs: '5000', endMs: '7000' },
      extractor: {},
      relevance: [null, { id: 'broken' }],
    });

    expect(insight?.entities).toEqual([
      { entityType: 'BILL', label: 'H.R. 1', canonicalId: '119-HR-1' },
    ]);
    expect(insight?.relevance).toEqual([]);
    expect(insight?.evidence).toMatchObject({ sequence: 3, startMs: 5_000, endMs: 7_000 });
  });

  it('fails unknown server status closed to EMPTY', () => {
    const result = normalizePhase8Intelligence({
      hearingId: 'h-1',
      status: 'MAGIC_SUCCESS',
      items: [],
      recap: {},
      jobs: {},
    });
    expect(result.status).toBe('EMPTY');
    expect(result.sourceBoundary).toBe('CANONICAL_PUBLIC_TRANSCRIPT_ONLY');
  });
});
