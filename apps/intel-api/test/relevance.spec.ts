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
