import { WatchlistMatcherService, type WatchTerm } from '../src/watchlist/watchlist-matcher.service.js';

/**
 * H2 — SC2.2 (a watchlist term in a segment yields a match) + SC2.3 (precision
 * >= 0.8 on a labeled set; no false-positive flood on non-matching segments).
 */
describe('WatchlistMatcherService', () => {
  const svc = new WatchlistMatcherService();

  function term(id: string, termType: string, value: string, weight = 1): WatchTerm {
    return { id, watchlistId: 'wl1', clientId: 'c1', termType, value, weight };
  }

  const terms: WatchTerm[] = [
    term('t-bill', 'bill', 'SB 410'),
    term('t-phrase', 'topic', 'interconnection queue'),
    term('t-risk', 'risk_phrase', 'ratepayer impact'),
    term('t-topic', 'topic', 'data centers'),
    term('t-company', 'company', 'Acme Grid'),
  ];

  it('matches a bill number despite spacing/case (SC2.2)', () => {
    const m = svc.match('The committee took up sb410 this morning.', terms);
    expect(m.map((x) => x.termId)).toContain('t-bill');
  });

  it('matches a multi-word phrase on word boundary', () => {
    const m = svc.match('Concerns about the interconnection queue were raised.', terms);
    expect(m.map((x) => x.termId)).toContain('t-phrase');
  });

  it('does NOT match unrelated text (no false-positive flood)', () => {
    const m = svc.match('The weather today is sunny and mild.', terms);
    expect(m).toHaveLength(0);
  });

  it('does NOT substring-match short tokens inside other words', () => {
    // "grid" should not match "Acme Grid" company term (requires both words)
    const m = svc.match('The power grid is aging.', terms);
    expect(m.map((x) => x.termId)).not.toContain('t-company');
  });

  it('precision >= 0.8 across a labeled segment set (SC2.3)', () => {
    // labeled: [segment, shouldMatchTermId|null]
    const labeled: Array<[string, string | null]> = [
      ['SB 410 advanced out of committee', 't-bill'],
      ['the interconnection queue backlog', 't-phrase'],
      ['ratepayer impact was debated', 't-risk'],
      ['new data centers in the district', 't-topic'],
      ['Acme Grid testified today', 't-company'],
      ['unrelated procedural motion', null],
      ['lunch recess until 2pm', null],
      ['the chair recognized the gentleman', null],
      ['a vote on final passage', null],
      ['gridlock in negotiations continued', null], // must NOT match t-company
    ];
    let truePos = 0;
    let falsePos = 0;
    for (const [seg, expected] of labeled) {
      const got = svc.match(seg, terms);
      const ids = got.map((x) => x.termId);
      if (expected) {
        if (ids.includes(expected)) truePos++;
        // any extra match on an expected-positive row is also a false positive
        falsePos += ids.filter((i) => i !== expected).length;
      } else {
        falsePos += ids.length;
      }
    }
    const precision = truePos / (truePos + falsePos);
    expect(precision).toBeGreaterThanOrEqual(0.8);
  });
});
