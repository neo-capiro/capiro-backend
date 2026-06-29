import { explainMatch, wholeWordHit, billHaystack } from './tracker-relevance.util.js';

describe('wholeWordHit', () => {
  it('matches whole words, case-insensitively', () => {
    expect(wholeWordHit('the f-35 program', 'F-35')).toBe(true);
    expect(wholeWordHit('shipbuilding budget', 'ship')).toBe(false); // not a whole word
  });
  it('ignores terms shorter than the minimum length', () => {
    expect(wholeWordHit('ai policy', 'ai')).toBe(false);
  });
  it('escapes regex metacharacters in the term', () => {
    expect(wholeWordHit('section 1004 (a)', '1004')).toBe(true);
    expect(() => wholeWordHit('anything', 'c++')).not.toThrow();
  });
});

describe('billHaystack', () => {
  it('includes title, policy area, action text, and subjects', () => {
    const hay = billHaystack({
      title: 'NDAA',
      policyArea: 'Armed Forces',
      subjects: ['Defense'],
      latestActionText: 'Passed the House',
    });
    expect(hay).toContain('ndaa');
    expect(hay).toContain('armed forces');
    expect(hay).toContain('passed the house');
    expect(hay).toContain('defense');
  });
});

describe('explainMatch', () => {
  const ndaa = {
    title: 'National Defense Authorization Act for Fiscal Year 2027',
    policyArea: 'Armed Forces and National Security',
    subjects: ['Defense spending', 'Military procurement'],
    latestActionText: 'Passed/agreed to in House',
  };

  it('prefers an entity (tag/relatedEntity) hit and reports it', () => {
    const ex = explainMatch(ndaa, {
      issueAreas: [],
      tags: [{ tag: 'Defense Authorization', synonyms: [], relatedEntities: [], riskTerms: [] }],
    });
    expect(ex.matchedTags).toContain('Defense Authorization');
    expect(ex.why).toMatch(/watchlist term/i);
  });

  it('falls back to a synonym keyword hit', () => {
    const ex = explainMatch(ndaa, {
      issueAreas: [],
      tags: [
        {
          tag: 'Procurement',
          synonyms: ['military procurement'],
          relatedEntities: [],
          riskTerms: [],
        },
      ],
    });
    expect(ex.matchedTags).toContain('Procurement');
    expect(ex.why).toMatch(/watchlist term/i);
  });

  it('falls back to an issue-area token hit when no tag matches', () => {
    const ex = explainMatch(ndaa, { issueAreas: ['Defense'], tags: [] });
    expect(ex.matchedTags).toContain('Defense');
    expect(ex.why).toMatch(/issue area/i);
  });

  it('returns why=null when nothing matches', () => {
    const ex = explainMatch(
      { title: 'Post Office Naming Act', policyArea: null, subjects: [], latestActionText: null },
      {
        issueAreas: ['Defense'],
        tags: [{ tag: 'Shipbuilding', synonyms: [], relatedEntities: [], riskTerms: [] }],
      },
    );
    expect(ex.why).toBeNull();
    expect(ex.matchedTags).toEqual([]);
  });

  it('de-dupes and caps matched tags', () => {
    const ex = explainMatch(ndaa, {
      issueAreas: ['Defense', 'Defense'],
      tags: [{ tag: 'Defense', synonyms: ['defense'], relatedEntities: [], riskTerms: [] }],
    });
    expect(ex.matchedTags.length).toBeLessThanOrEqual(4);
    expect(new Set(ex.matchedTags).size).toBe(ex.matchedTags.length);
  });
});
