import { PublicHearingBoundaryError } from './public-hearing-boundary.js';
import { PublicHearingIntelligenceProcessor } from './public-hearing-intelligence.processor.js';
import type { PublicHearingInsightExtractor } from './public-hearing-intelligence.types.js';

const context = {
  hearingId: 'h1',
  title: 'Defense posture',
  committeeName: 'Armed Services',
};

const segment = {
  id: 's1',
  captureId: 'c1',
  hearingId: 'h1',
  sequence: 1,
  startMs: 0,
  endMs: 5_000,
  text: 'We will deliver the H.R. 1 report within 30 days.',
  confidence: 0.9,
  isFinal: true,
};

describe('PublicHearingIntelligenceProcessor', () => {
  it('keeps deterministic facts when an optional extractor fails', async () => {
    const failure = jest.fn();
    const broken: PublicHearingInsightExtractor = {
      name: 'broken-optional',
      version: '1',
      extract: async () => {
        throw new Error('provider unavailable');
      },
    };
    const processor = new PublicHearingIntelligenceProcessor({
      extractors: [broken],
      now: () => new Date('2026-08-21T12:00:00Z'),
      onExtractorFailure: failure,
    });

    const result = await processor.processSegment({ segment, context });

    expect(result.insights.length).toBeGreaterThan(0);
    expect(result.insights.some((insight) => insight.insightType === 'COMMITMENT')).toBe(true);
    expect(result.insights.some((insight) => insight.insightType === 'BILL_REFERENCE')).toBe(true);
    expect(result.extractorFailures).toEqual([
      expect.objectContaining({ extractor: 'broken-optional', message: 'provider unavailable' }),
    ]);
    expect(failure).toHaveBeenCalledTimes(1);
  });

  it('adds a valid optional public extractor without duplicating deterministic facts', async () => {
    const optional: PublicHearingInsightExtractor = {
      name: 'optional-public',
      version: '2',
      extract: async () => [
        {
          insightType: 'MENTION',
          title: 'Acquisition milestone',
          summary: 'The witness referenced an acquisition milestone.',
          evidenceText: segment.text,
          entities: [{ entityType: 'OTHER', label: 'acquisition milestone' }],
        },
      ],
    };
    const processor = new PublicHearingIntelligenceProcessor({
      extractors: [optional],
      now: () => new Date('2026-08-21T12:00:00Z'),
    });
    const result = await processor.processSegment({ segment, context });
    expect(result.insights).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          insightType: 'MENTION',
          extractor: 'optional-public',
          extractorVersion: '2',
        }),
      ]),
    );
  });

  it('rejects tenant/client context even when a caller bypasses TypeScript', async () => {
    const processor = new PublicHearingIntelligenceProcessor();
    await expect(
      processor.processSegment({
        segment,
        context: { ...context, clientName: 'Private Client' } as typeof context,
      }),
    ).rejects.toBeInstanceOf(PublicHearingBoundaryError);
  });

  it('rejects hearing mismatches before producing public records', async () => {
    const processor = new PublicHearingIntelligenceProcessor();
    await expect(
      processor.processSegment({
        segment: { ...segment, hearingId: 'other' },
        context,
      }),
    ).rejects.toThrow(/does not match/i);
  });

  it('generates replay-stable ids and deterministic ordering', async () => {
    const processor = new PublicHearingIntelligenceProcessor({
      now: () => new Date('2026-08-21T12:00:00Z'),
    });
    const first = await processor.processSegment({ segment, context });
    const second = await processor.processSegment({ segment, context });
    expect(second.insights.map((insight) => insight.id)).toEqual(
      first.insights.map((insight) => insight.id),
    );
  });
});
