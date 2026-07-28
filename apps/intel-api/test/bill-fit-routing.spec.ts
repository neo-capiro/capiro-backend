import { scoreBillFit, type CompiledTopicForFit } from '../src/tracker/bill-fit.util.js';
import type { RoutableTerm } from '../src/watchlist/term-routing.js';

const bill = (title: string, extra: Partial<{ policyArea: string; subjects: string[]; latestActionText: string }> = {}) => ({
  title,
  policyArea: extra.policyArea ?? null,
  subjects: extra.subjects ?? [],
  latestActionText: extra.latestActionText ?? '',
});

const routable = (termType: string, value: string, topicPriority = 'med'): RoutableTerm => ({
  id: null,
  topicId: null,
  topicLabel: 'topic',
  termType,
  value,
  topicPriority,
});

/**
 * Gate B phase b (P0-04) — scoreBillFit end-to-end via the real routing table.
 * Item 16 is the audit's headline claim: an RTX-typed `company` term used to
 * produce fit === 0 (the 8 dead types); it must not any more.
 */
describe('scoreBillFit — P0-04 routing end-to-end', () => {
  it('16. a topic whose ONLY term is company:RTX now produces a non-zero fit', () => {
    const topics: CompiledTopicForFit[] = [
      {
        label: 'defense primes',
        issueArea: null,
        priority: 'med',
        keywords: [],
        synonyms: [],
        entities: [],
        riskPhrases: [],
        routableTerms: [routable('company', 'RTX')],
      },
    ];
    const r = scoreBillFit(bill('RTX modernization act'), topics, [], 0, false);
    expect(r.fit).toBeGreaterThan(0);
    expect(r.matchedTags).toContain('defense primes');
  });

  it('17. a topic with only legacy synonym terms is byte-identical to the pre-routing output', () => {
    const topics: CompiledTopicForFit[] = [
      {
        label: 'grid reliability',
        issueArea: null,
        priority: 'med',
        keywords: ['grid reliability'],
        synonyms: ['load shedding'],
        entities: [],
        riskPhrases: [],
        routableTerms: [routable('synonym', 'load shedding')],
      },
    ];
    const r = scoreBillFit(bill('A bill addressing load shedding events'), topics, [], 0.3, false);
    expect(r).toEqual({
      fit: 0.42, // 0.4*0.3 (semantic) + 0.3 (textMatch) + 0 (exactEntity — synonym is not entity-like) + 0 + 0
      belowFloor: true, // < RECOMMENDATION_FLOOR (0.45)
      matchedTags: ['grid reliability'],
      // Gate K (MP-09): this fixture's topic carries no `id`, so matchedTopicIds stays empty.
      matchedTopicIds: [],
      matchReasons: [
        { kind: 'keyword', detail: 'Matches your watchlist term "load shedding".' },
        { kind: 'semantic', detail: 'Semantic match to your watchlist (≈ "grid reliability").' },
      ],
      whyKind: 'keyword',
      why: 'Matches your watchlist term "load shedding".',
    });
  });

  it('18. exactEntity fires for a company match and not for a topic-type match', () => {
    const companyTopics: CompiledTopicForFit[] = [
      {
        label: 't1',
        issueArea: null,
        priority: 'med',
        keywords: [],
        synonyms: [],
        entities: [],
        riskPhrases: [],
        routableTerms: [routable('company', 'RTX')],
      },
    ];
    const topicTopics: CompiledTopicForFit[] = [
      {
        label: 't2',
        issueArea: null,
        priority: 'med',
        keywords: [],
        synonyms: [],
        entities: [],
        riskPhrases: [],
        routableTerms: [routable('topic', 'RTX')],
      },
    ];
    const companyFit = scoreBillFit(bill('RTX news'), companyTopics, [], 0, false);
    const topicFit = scoreBillFit(bill('RTX news'), topicTopics, [], 0, false);
    // exactEntity contributes 0.15 to fit; isolate it since both hit textMatch identically.
    expect(companyFit.fit - topicFit.fit).toBeCloseTo(0.15, 9);
  });
});
