import { scoreBillFit, RECOMMENDATION_FLOOR, type CompiledTopicForFit } from '../src/tracker/bill-fit.util.js';
import type { RoutableTerm } from '../src/watchlist/term-routing.js';

// P0-04 (Gate B phase b): scoreBillFit now matches exclusively via
// routableTerms, which the real WatchlistCompiler populates from every
// persisted term PLUS a synthetic keyword-typed entry for the topic's own
// label (watchlist-compiler.ts). These fixtures hand-build what the compiler
// would produce so the unit tests exercise the real post-migration contract.
const labelTerm = (label: string, priority: string): RoutableTerm => ({
  id: null,
  topicId: null,
  topicLabel: label,
  termType: 'keyword',
  value: label,
  topicPriority: priority,
});

const topics: CompiledTopicForFit[] = [
  {
    label: 'data center load',
    issueArea: 'Energy',
    priority: 'high',
    keywords: ['data center load', 'data center'],
    synonyms: ['hyperscale demand'],
    entities: ['PJM'],
    riskPhrases: ['grid strain'],
    routableTerms: [
      labelTerm('data center load', 'high'),
      { id: null, topicId: null, topicLabel: 'data center load', termType: 'synonym', value: 'hyperscale demand', topicPriority: 'high' },
      { id: null, topicId: null, topicLabel: 'data center load', termType: 'entity', value: 'PJM', topicPriority: 'high' },
      { id: null, topicId: null, topicLabel: 'data center load', termType: 'risk', value: 'grid strain', topicPriority: 'high' },
    ],
  },
  {
    label: 'permitting',
    issueArea: null,
    priority: 'med',
    keywords: ['permitting'],
    synonyms: [],
    entities: [],
    riskPhrases: [],
    routableTerms: [labelTerm('permitting', 'med')],
  },
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
    // 'permitting' label/keyword hit (textMatch only — P0-04 no longer grants
    // exactEntity for a plain keyword-kind match; only genuinely entity-like
    // routes do, per term-routing.ts ENTITY_KIND_TYPES), 'Energy' issue-area
    // hit (subjectMatch), med priority (no boost), semantic 0.5.
    const r = scoreBillFit(bill('A permitting reform Energy bill'), topics, issueAreas, 0.5, false);
    // 0.4*0.5 + 0.3 + 0 + 0.1 = 0.6
    expect(r.fit).toBeCloseTo(0.6, 9);
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
      routableTerms: [
        labelTerm(`t${i}`, 'low'),
        { id: null, topicId: null, topicLabel: `t${i}`, termType: 'keyword', value: `term${i}`, topicPriority: 'low' },
      ],
    }));
    const title = many.map((_, i) => `term${i}`).join(' ');
    const r = scoreBillFit(bill(title), many, [], 0, false);
    expect(r.matchedTags.length).toBe(4);
  });
});

describe('scoreBillFit — §4.10 (Gate E phase f): feedback parameter', () => {
  // Isolate ONE plain-keyword, med-priority topic so the feedback multiplier
  // affects ONLY textMatchWeight — exactEntityWeight, priorityBoostWeight,
  // subjectMatch, and semantic all stay at 0 (empty issueAreas, semantic=0,
  // keywordHit=false), so the fit formula reduces to exactly `0.3 * weight`.
  const feedbackTopic: CompiledTopicForFit[] = [
    {
      label: 'permitting',
      issueArea: null,
      priority: 'med',
      keywords: ['permitting'],
      synonyms: [],
      entities: [],
      riskPhrases: [],
      routableTerms: [labelTerm('permitting', 'med')],
    },
  ];
  const feedbackBill = bill('A permitting reform bill');

  it('f-7 case 4 (byte-identical — the most important test in the phase): feedback absent, an explicit undefined, and an empty Map all produce identical output, across five varied inputs', () => {
    const check = (
      b: ReturnType<typeof bill>,
      t: CompiledTopicForFit[],
      areas: string[],
      sem: number,
      kw: boolean,
    ) => {
      const omitted = scoreBillFit(b, t, areas, sem, kw);
      expect(scoreBillFit(b, t, areas, sem, kw, undefined)).toEqual(omitted);
      expect(scoreBillFit(b, t, areas, sem, kw, new Map())).toEqual(omitted);
    };
    check(bill('A bill to address data center load on the PJM grid', { policyArea: 'Energy' }), topics, issueAreas, 0.7, true);
    check(bill('A bill about postal rates', { policyArea: 'Government operations' }), topics, issueAreas, 0.5, false);
    check(bill('A permitting reform Energy bill'), topics, issueAreas, 0.5, false);
    check(bill('An Environment quality bill'), topics, issueAreas, 0, false);
    check(bill('Unrelated title'), topics, [], 0.6, true);
  });

  it("f-7 case 5: 3 too_broad dismissals multiply a topic's contribution by 0.75, 6 by 0.5, 20 stays at the 0.5 floor", () => {
    const baseline = scoreBillFit(feedbackBill, feedbackTopic, [], 0, false);
    expect(baseline.fit).toBeCloseTo(0.3, 9); // 0.3 * weight(1.0), nothing else contributes

    const at3 = scoreBillFit(
      feedbackBill,
      feedbackTopic,
      [],
      0,
      false,
      new Map([['permitting', { total: 3, byReason: { too_broad: 3 } }]]),
    );
    expect(at3.fit).toBeCloseTo(0.3 * 0.75, 9);

    const at6 = scoreBillFit(
      feedbackBill,
      feedbackTopic,
      [],
      0,
      false,
      new Map([['permitting', { total: 6, byReason: { too_broad: 6 } }]]),
    );
    expect(at6.fit).toBeCloseTo(0.3 * 0.5, 9);

    const at20 = scoreBillFit(
      feedbackBill,
      feedbackTopic,
      [],
      0,
      false,
      new Map([['permitting', { total: 20, byReason: { too_broad: 20 } }]]),
    );
    expect(at20.fit).toBeCloseTo(0.3 * 0.5, 9); // floor — a topic must stay able to recover
  });

  it('f-7 case 6: already_handled dismissals do not down-weight a topic (the reason filter is load-bearing)', () => {
    const baseline = scoreBillFit(feedbackBill, feedbackTopic, [], 0, false);
    const withAlreadyHandled = scoreBillFit(
      feedbackBill,
      feedbackTopic,
      [],
      0,
      false,
      new Map([['permitting', { total: 3, byReason: { already_handled: 3 } }]]),
    );
    expect(withAlreadyHandled.fit).toBeCloseTo(baseline.fit, 9);
    expect(withAlreadyHandled.fit).toBeCloseTo(0.3, 9);
  });
});
