import { matchTerms, normalizeIdentifier, routeFor, type RoutableTerm } from '../src/watchlist/term-routing.js';
import type { RelevanceBill } from '../src/tracker/relevance.util.js';

/**
 * Gate B phase b (P0-04) — "each of the 11 typed-term categories changes the
 * intended matcher." One test per canonical type, plus the cross-cutting
 * routing rules (priority scaling, first-field-wins, determinism).
 */
const term = (termType: string, value: string, topicPriority = 'med'): RoutableTerm => ({
  id: null,
  topicId: null,
  topicLabel: 'topic',
  termType,
  value,
  topicPriority,
});

const bill = (extra: Partial<RelevanceBill> & { title?: string } = {}): RelevanceBill => ({
  title: extra.title ?? '',
  policyArea: extra.policyArea ?? null,
  subjects: extra.subjects ?? null,
  latestActionText: extra.latestActionText ?? null,
  displayNum: extra.displayNum ?? null,
  billId: extra.billId ?? null,
  sponsorName: extra.sponsorName ?? null,
  cosponsorNames: extra.cosponsorNames ?? null,
  committees: extra.committees ?? null,
  programElements: extra.programElements ?? null,
});

describe('matchTerms — normalizeIdentifier', () => {
  it('collapses punctuation/spacing/congress-prefix variants to the same key', () => {
    expect(normalizeIdentifier('H.R. 1234')).toBe('hr1234');
    expect(normalizeIdentifier('hr1234')).toBe('hr1234');
    expect(normalizeIdentifier('H R 1234')).toBe('hr1234');
    expect(normalizeIdentifier('119-hr-1234')).toBe('hr1234');
  });
});

describe('matchTerms — one test per canonical type', () => {
  it('1. bill: exact_id on displayNum, matches every input form, confidence 1', () => {
    for (const displayNum of ['H.R. 1234']) {
      const m = matchTerms(bill({ displayNum }), [term('bill', 'H.R. 1234')]);
      expect(m).toHaveLength(1);
      expect(m[0]).toMatchObject({ matchType: 'exact_id', sourceField: 'displayNum', confidence: 1 });
    }
    for (const displayNum of ['hr1234', '119-hr-1234']) {
      expect(matchTerms(bill({ displayNum }), [term('bill', 'H.R. 1234')])).toHaveLength(1);
    }
  });

  it('2. bill: no substring match — H.R. 1234 does not match H.R. 12345', () => {
    const m = matchTerms(bill({ displayNum: 'H.R. 12345' }), [term('bill', 'H.R. 1234')]);
    expect(m).toHaveLength(0);
  });

  it('3. agency: whole-word match in policyArea', () => {
    const m = matchTerms(bill({ policyArea: 'Department of Energy oversight' }), [
      term('agency', 'Department of Energy'),
    ]);
    expect(m).toHaveLength(1);
    expect(m[0]?.sourceField).toBe('policyArea');
  });

  it('4. committee: matches in committees; absent committees does not throw', () => {
    const hit = matchTerms(bill({ committees: ['House Armed Services'] }), [term('committee', 'Armed Services')]);
    expect(hit).toHaveLength(1);
    expect(() => matchTerms(bill({ committees: undefined }), [term('committee', 'Armed Services')])).not.toThrow();
    expect(matchTerms(bill({ committees: undefined }), [term('committee', 'Armed Services')])).toHaveLength(0);
  });

  it('5. legislator: matches sponsorName, confidence 0.9', () => {
    const m = matchTerms(bill({ sponsorName: 'Jack Reed' }), [term('legislator', 'Reed')]);
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ sourceField: 'sponsorName', confidence: 0.9 });
  });

  it('6. company: matches title, weight 5 (med) / 6.25 (high)', () => {
    const med = matchTerms(bill({ title: 'RTX modernization act' }), [term('company', 'RTX', 'med')]);
    expect(med[0]?.weight).toBe(5);
    const high = matchTerms(bill({ title: 'RTX modernization act' }), [term('company', 'RTX', 'high')]);
    expect(high[0]?.weight).toBe(6.25);
  });

  it('7. competitor: matches title, explanation names it a competitor', () => {
    const m = matchTerms(bill({ title: 'Lockheed contracting reform' }), [term('competitor', 'Lockheed')]);
    expect(m).toHaveLength(1);
    expect(m[0]?.explanation).toMatch(/competitor/i);
  });

  it('8. topic: matches subjects, confidence 0.6', () => {
    const m = matchTerms(bill({ subjects: ['autonomous systems', 'defense'] }), [
      term('topic', 'autonomous systems'),
    ]);
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ sourceField: 'subjects', confidence: 0.6 });
  });

  it('9. risk_phrase: matches latestActionText, weight 4', () => {
    const m = matchTerms(bill({ latestActionText: 'Motion to curtailment debate' }), [
      term('risk_phrase', 'curtailment'),
    ]);
    expect(m).toHaveLength(1);
    expect(m[0]?.weight).toBe(4);
  });

  it('10. support_language / opposition_language: distinct explanations, both weight 4', () => {
    const support = matchTerms(bill({ title: 'A bill on renewable mandates' }), [
      term('support_language', 'renewable mandates'),
    ]);
    const opposition = matchTerms(bill({ title: 'A bill on renewable mandates' }), [
      term('opposition_language', 'renewable mandates'),
    ]);
    expect(support[0]?.weight).toBe(4);
    expect(opposition[0]?.weight).toBe(4);
    expect(support[0]?.explanation).not.toBe(opposition[0]?.explanation);
    expect(support[0]?.explanation).toMatch(/support/i);
    expect(opposition[0]?.explanation).toMatch(/oppose/i);
  });

  it('11. program_element: exact_id equality on programElements, surfaces include program_element', () => {
    const m = matchTerms(bill({ programElements: ['0604256F'] }), [term('program_element', '0604256F')]);
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ matchType: 'exact_id', sourceField: 'programElements' });
    expect(routeFor('program_element')?.surfaces).toContain('program_element');
  });
});

describe('matchTerms — priority scaling (rule 7)', () => {
  it('high topic weighs 1.25x med; low weighs 0.75x', () => {
    const b = bill({ title: 'Lockheed contracting reform' });
    const med = matchTerms(b, [term('competitor', 'Lockheed', 'med')])[0]!.weight;
    const high = matchTerms(b, [term('competitor', 'Lockheed', 'high')])[0]!.weight;
    const low = matchTerms(b, [term('competitor', 'Lockheed', 'low')])[0]!.weight;
    expect(med).toBe(4);
    expect(high).toBe(5); // 4 * 1.25
    expect(low).toBe(3); // 4 * 0.75
  });
});

describe('matchTerms — first-field-wins (rule 5)', () => {
  it('a term present in both title and latestActionText yields exactly one match, on title', () => {
    const m = matchTerms(
      bill({ title: 'curtailment risk', latestActionText: 'curtailment debated' }),
      [term('risk_phrase', 'curtailment')],
    );
    expect(m).toHaveLength(1);
    expect(m[0]?.sourceField).toBe('title');
  });
});

describe('matchTerms — determinism (rule 8)', () => {
  it('is deterministic across repeated calls', () => {
    const b = bill({ title: 'RTX and Lockheed both mentioned', latestActionText: 'curtailment' });
    const terms = [term('company', 'RTX'), term('competitor', 'Lockheed'), term('risk_phrase', 'curtailment')];
    expect(matchTerms(b, terms)).toEqual(matchTerms(b, terms));
  });

  it('sorts by weight desc, then by field priority within each term route, then matchedText', () => {
    // 'agency' and 'committee' both weight 3 (med); agency's first field is
    // 'title' (index 0), committee's first listed field is 'committees'
    // (index 0 too) — so this pair ties down to matchedText localeCompare.
    const b = bill({ title: 'Zebra agency mentioned', committees: ['Alpha committee referred'] });
    const m = matchTerms(b, [term('agency', 'Zebra agency'), term('committee', 'Alpha committee')]);
    expect(m).toHaveLength(2);
    expect(m.map((x) => x.matchedText)).toEqual(['Alpha committee', 'Zebra agency']); // localeCompare tiebreak
  });
});

describe('matchTerms — short identifier-shaped terms route correctly (P0-05 carve-out)', () => {
  it('AI as a topic-typed term matches "AI" but not "chain"', () => {
    const hit = matchTerms(bill({ title: 'AI accountability act' }), [term('topic', 'AI')]);
    expect(hit).toHaveLength(1);
    const miss = matchTerms(bill({ title: 'chain of custody rules' }), [term('topic', 'AI')]);
    expect(miss).toHaveLength(0);
  });
});
