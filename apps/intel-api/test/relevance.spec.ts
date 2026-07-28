import { wholeWordHit, explainMatch, humanizeBillId, type WatchlistLike } from '../src/tracker/relevance.util.js';

describe('wholeWordHit', () => {
  it('matches whole words only, case-insensitively, min length 3', () => {
    expect(wholeWordHit('the data center load', 'data')).toBe(true);
    expect(wholeWordHit('database migration', 'data')).toBe(false); // not a whole word
    expect(wholeWordHit('a b c', 'ab')).toBe(false); // < 3
  });
});

describe('explainMatch', () => {
  const wl: WatchlistLike = {
    issueAreas: ['Energy & Utilities'],
    tags: [{ tag: 'data center load', synonyms: ['large-load customers'], relatedEntities: ['FERC'], riskTerms: ['moratorium'] }],
  };
  const bill = (title: string, extra: Partial<{ latestActionText: string; subjects: string[] }> = {}) => ({
    title,
    policyArea: null,
    subjects: extra.subjects ?? [],
    latestActionText: extra.latestActionText ?? null,
  });

  it('prefers an entity match and cites it', () => {
    const ex = explainMatch(bill('A bill re: FERC interconnection'), wl);
    expect(ex.why).toContain('FERC');
    expect(ex.matchedTags).toContain('data center load');
  });
  it('falls back to a keyword (synonym/risk) match', () => {
    const ex = explainMatch(bill('A moratorium on new hookups'), wl);
    expect(ex.why).toContain('moratorium');
  });
  it('falls back to an issue-area token match', () => {
    const ex = explainMatch(bill('An act concerning energy policy'), wl);
    expect(ex.why).toContain('Energy');
  });
  it('returns why=null when nothing matches', () => {
    const ex = explainMatch(bill('An act about postal rates'), wl);
    expect(ex.why).toBeNull();
    expect(ex.matchedTags).toEqual([]);
  });

  it('returns matchDetails: [] and every primaryTopic* as null when nothing matches (Gate K, HP-01)', () => {
    const ex = explainMatch(bill('An act about postal rates'), wl);
    expect(ex.matchDetails).toEqual([]);
    expect(ex.primaryTopicId).toBeNull();
    expect(ex.primaryTopicLabel).toBeNull();
    expect(ex.primaryTopicPriority).toBeNull();
    expect(ex.primaryTopicPosition).toBeNull();
  });

  describe('Gate K (HP-01, d-1): matchDetails and primary-topic attribution', () => {
    const wlWithTyped: WatchlistLike = {
      issueAreas: [],
      tags: [
        {
          tag: 'data center load',
          topicId: 'topic-dcl',
          priority: 'high',
          position: 'oppose',
          typedTerms: [{ termType: 'company', value: 'RTX', id: 'term-1' }],
        },
      ],
    };

    it('accumulates the real TermMatch[] instead of discarding it after extracting `why`', () => {
      const ex = explainMatch(bill('RTX modernization act'), wlWithTyped);
      expect(ex.matchDetails).toHaveLength(1);
      expect(ex.matchDetails[0]).toMatchObject({
        termId: 'term-1',
        topicId: 'topic-dcl',
        termType: 'company',
        matchedText: 'RTX',
      });
    });

    it('attributes primaryTopic{Id,Label,Priority,Position} to the first matched tag', () => {
      const ex = explainMatch(bill('RTX modernization act'), wlWithTyped);
      expect(ex.primaryTopicId).toBe('topic-dcl');
      expect(ex.primaryTopicLabel).toBe('data center load');
      expect(ex.primaryTopicPriority).toBe('high');
      expect(ex.primaryTopicPosition).toBe('oppose');
    });

    it('a legacy-only match (no typedTerms) still attributes a primary topic, with empty matchDetails', () => {
      const ex = explainMatch(bill('A bill re: FERC interconnection'), wl);
      expect(ex.primaryTopicId).toBeNull(); // this fixture's tag has no topicId
      expect(ex.primaryTopicLabel).toBe('data center load');
      expect(ex.matchDetails).toEqual([]); // FERC matched via the legacy relatedEntities check, not matchTerms
    });

    it('multiple matched tags: primaryTopic is the FIRST one, not the highest-weight one (matches bill-fit.util.ts topTagLabel convention)', () => {
      const multi: WatchlistLike = {
        issueAreas: [],
        tags: [
          { tag: 'first topic', topicId: 't-1', priority: 'low', typedTerms: [{ termType: 'keyword', value: 'grid' }] },
          { tag: 'second topic', topicId: 't-2', priority: 'high', typedTerms: [{ termType: 'company', value: 'RTX' }] },
        ],
      };
      const ex = explainMatch(bill('A grid bill naming RTX'), multi);
      expect(ex.matchedTags).toEqual(['first topic', 'second topic']);
      expect(ex.primaryTopicId).toBe('t-1');
      expect(ex.matchDetails.length).toBeGreaterThanOrEqual(2); // both tags' matches are accumulated regardless
    });
  });
});

describe('humanizeBillId', () => {
  it('formats known bill types', () => {
    expect(humanizeBillId('119-hr-1234')).toBe('H.R. 1234');
    expect(humanizeBillId('118-s-45')).toBe('S. 45');
    expect(humanizeBillId('119-hjres-7')).toBe('H.J.Res. 7');
  });
  it('falls back to the raw id when unparseable', () => {
    expect(humanizeBillId('weird-id')).toBe('weird-id');
  });
});
