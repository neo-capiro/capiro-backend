import {
  extractDeterministicPublicHearingInsights,
  normalizeBillReference,
} from './deterministic-public-hearing-extractor.js';

const context = {
  hearingId: 'h1',
  title: 'Defense posture',
  committeeName: 'Armed Services',
};

function segment(text: string) {
  return {
    id: 's1',
    captureId: 'c1',
    hearingId: 'h1',
    sequence: 1,
    startMs: 1_000,
    endMs: 12_000,
    text,
    speakerName: 'Secretary Example',
    confidence: 0.95,
    isFinal: true,
  };
}

describe('deterministic public hearing extraction', () => {
  it('extracts public questions, commitments, deadlines, funding, bills, PEs, and agencies', () => {
    const insights = extractDeterministicPublicHearingInsights({
      context,
      segment: segment(
        'Will the Department of Defense support H.R. 1 and Program Element 0605053A? ' +
          'We will provide the committee a $125 million report no later than October 1, 2026.',
      ),
    });
    const types = new Set(insights.map((insight) => insight.insightType));
    expect(types).toEqual(
      expect.objectContaining({
        has: expect.any(Function),
      }),
    );
    expect(types.has('QUESTION')).toBe(true);
    expect(types.has('COMMITMENT')).toBe(true);
    expect(types.has('DEADLINE')).toBe(true);
    expect(types.has('FUNDING_AMOUNT')).toBe(true);
    expect(types.has('BILL_REFERENCE')).toBe(true);
    expect(types.has('PROGRAM_ELEMENT_REFERENCE')).toBe(true);
    expect(types.has('AGENCY_REFERENCE')).toBe(true);
    expect(types.has('KEY_QUOTE')).toBe(true);
  });

  it('normalizes equivalent bill typography to one canonical identifier', () => {
    expect(normalizeBillReference('H.R. 1')).toBe('HR-1');
    expect(normalizeBillReference('HR 1')).toBe('HR-1');
    expect(normalizeBillReference('S. 42')).toBe('S-42');
  });

  it('does not manufacture insights from empty text', () => {
    expect(
      extractDeterministicPublicHearingInsights({
        context,
        segment: segment('   '),
      }),
    ).toEqual([]);
  });

  it('labels interim findings as preliminary without changing the public evidence', () => {
    const candidate = { ...segment('We will deliver the report within 30 days.'), isFinal: false };
    const insights = extractDeterministicPublicHearingInsights({ context, segment: candidate });
    expect(insights.length).toBeGreaterThan(0);
    expect(insights.every((insight) => insight.preliminary)).toBe(true);
  });
});
