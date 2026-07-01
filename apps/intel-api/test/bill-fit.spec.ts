import { scoreBillFit, RECOMMENDATION_FLOOR, type CompiledTopicForFit } from '../src/tracker/bill-fit.util.js';

const topics: CompiledTopicForFit[] = [
  {
    label: 'data center load',
    issueArea: 'Energy',
    priority: 'high',
    keywords: ['data center load', 'data center'],
    synonyms: ['hyperscale demand'],
    entities: ['PJM'],
    riskPhrases: ['grid strain'],
  },
  { label: 'permitting', issueArea: null, priority: 'med', keywords: ['permitting'], synonyms: [], entities: [], riskPhrases: [] },
];
const issueAreas = ['Energy', 'Environment'];

const bill = (title: string, extra: Partial<{ policyArea: string; subjects: string[]; latestActionText: string }> = {}) => ({
  title,
  policyArea: extra.policyArea ?? null,
  subjects: extra.subjects ?? [],
  latestActionText: extra.latestActionText ?? '',
});

describe('scoreBillFit', () => {
  it('scores an exact entity + high-priority match above the floor', () => {
    const r = scoreBillFit(bill('A bill to address data center load on the PJM grid', { policyArea: 'Energy' }), topics, issueAreas, 0.7, true);
    expect(r.fit).toBeGreaterThanOrEqual(RECOMMENDATION_FLOOR);
    expect(r.belowFloor).toBe(false);
    expect(r.matchedTags).toContain('data center load');
    expect(r.whyKind).toBe('entity');
  });

  it('keeps a semantic-only hit below the floor', () => {
    const r = scoreBillFit(bill('A bill about postal rates', { policyArea: 'Government operations' }), topics, issueAreas, 0.5, false);
    // 0.4 * 0.5 = 0.20 only
    expect(r.fit).toBeLessThan(RECOMMENDATION_FLOOR);
    expect(r.belowFloor).toBe(true);
  });

  it('applies the composite weights exactly', () => {
    // 'permitting' keyword hit (textMatch + exactEntity), 'Energy' issue-area hit (subjectMatch),
    // med priority (no boost), semantic 0.5.
    const r = scoreBillFit(bill('A permitting reform Energy bill'), topics, issueAreas, 0.5, false);
    // 0.4*0.5 + 0.3 + 0.15 + 0.1 = 0.75
    expect(r.fit).toBeCloseTo(0.75, 9);
  });

  it('treats an issue-area-only match as issue_code, below floor but > 0', () => {
    const r = scoreBillFit(bill('An Environment quality bill'), topics, issueAreas, 0, false);
    expect(r.fit).toBeGreaterThan(0);
    expect(r.fit).toBeLessThan(RECOMMENDATION_FLOOR);
    expect(r.whyKind).toBe('issue_code');
  });

  it('falls back to keywordHit for textMatch when no topic term hits', () => {
    const r = scoreBillFit(bill('Unrelated title'), topics, [], 0.6, true);
    // 0.4*0.6 + 0.3 = 0.54
    expect(r.fit).toBeCloseTo(0.54, 9);
  });

  it('caps matchedTags at 4 and dedupes', () => {
    const many: CompiledTopicForFit[] = Array.from({ length: 8 }, (_, i) => ({
      label: `t${i}`,
      issueArea: null,
      priority: 'low',
      keywords: [`term${i}`],
      synonyms: [],
      entities: [],
      riskPhrases: [],
    }));
    const title = many.map((_, i) => `term${i}`).join(' ');
    const r = scoreBillFit(bill(title), many, [], 0, false);
    expect(r.matchedTags.length).toBe(4);
  });
});
