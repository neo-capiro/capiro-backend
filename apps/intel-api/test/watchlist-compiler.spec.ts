import { compileWatchlist, type CompilerTerm } from '../src/watchlist/watchlist-compiler.js';

const topic = (label: string, issueArea: string | null = null, id: string | null = null) => ({
  id,
  label,
  issueArea,
  position: 'monitor',
  priority: 'med',
});
const term = (topicLabel: string | null, termType: string, value: string, weight = 1): CompilerTerm => ({
  topicLabel,
  termType,
  value,
  weight,
});

/** Phase 2 (plan §5.3 / SC-4): compiler output for the two matching paths. */
describe('compileWatchlist', () => {
  it('buckets topic terms into keyword/synonym/entity/riskPhrases (label is a keyword)', () => {
    const out = compileWatchlist({
      issueAreas: ['Energy & Utilities'],
      topics: [topic('data center load', 'Energy & Utilities')],
      terms: [
        term('data center load', 'synonym', 'large-load customers'),
        term('data center load', 'entity', 'FERC'),
        term('data center load', 'risk', 'moratorium'),
      ],
    });
    expect(out.billMatchSet).toHaveLength(1);
    const t = out.billMatchSet[0];
    expect(t.keywords).toContain('data center load');
    expect(t.synonyms).toEqual(['large-load customers']);
    expect(t.entities).toEqual(['FERC']);
    expect(t.riskPhrases).toEqual(['moratorium']);
    expect(out.issueAreas).toEqual(['Energy & Utilities']);
  });

  it('produces flat hearingTerms from topic + global terms (len >= 3)', () => {
    const out = compileWatchlist({
      issueAreas: [],
      topics: [topic('t1')],
      terms: [term('t1', 'synonym', 'grid'), term(null, 'keyword', 'hearing'), term(null, 'keyword', 'ab')],
    });
    const vals = out.hearingTerms.map((h) => h.value).sort();
    expect(vals).toEqual(['grid', 'hearing']); // 'ab' dropped (<3)
  });

  it('deepgramKeyterms are lower-cased, de-duped, and byte-stable across runs', () => {
    const input = {
      issueAreas: [],
      topics: [topic('t1')],
      terms: [term('t1', 'synonym', 'Grid'), term('t1', 'entity', 'grid'), term('t1', 'risk', 'Moratorium')],
    };
    const a = compileWatchlist(input).deepgramKeyterms;
    const b = compileWatchlist(input).deepgramKeyterms;
    expect(a).toEqual(b); // deterministic
    expect(a).toEqual(['grid', 'moratorium']); // lower-cased, de-duped, sorted
  });

  it('caps deepgramKeyterms and keeps highest-weight terms', () => {
    const terms: CompilerTerm[] = [];
    for (let i = 0; i < 150; i += 1) terms.push(term('t1', 'synonym', `term-${String(i).padStart(3, '0')}`, i));
    const out = compileWatchlist({ issueAreas: [], topics: [topic('t1')], terms });
    expect(out.deepgramKeyterms.length).toBe(100);
    // highest weights are term-149..term-050; term-000 (weight 0) must be excluded
    expect(out.deepgramKeyterms).not.toContain('term-000');
    expect(out.deepgramKeyterms).toContain('term-149');
  });

  // P5: the unified editor writes the full 11 canonical term types. Every type
  // must survive compilation and be usable by the hearing matcher (each shows up
  // as a hearingTerm); the three billMatchSet buckets (synonym/entity/risk) stay
  // as-is for the bill matcher. Nothing is silently dropped.
  it('compiles all 11 canonical term types into usable hearing terms', () => {
    const CANONICAL_TYPES = [
      'bill',
      'agency',
      'committee',
      'legislator',
      'company',
      'competitor',
      'topic',
      'risk_phrase',
      'support_language',
      'opposition_language',
      'program_element',
    ];
    const out = compileWatchlist({
      issueAreas: [],
      topics: [topic('everything')],
      terms: CANONICAL_TYPES.map((t) => term('everything', t, `${t}-term`)),
    });
    const hearingVals = out.hearingTerms.map((h) => h.value).sort();
    expect(hearingVals).toEqual(CANONICAL_TYPES.map((t) => `${t}-term`).sort());
    // deepgram keyterms carry every type too (lower-cased, deduped).
    expect(out.deepgramKeyterms).toEqual(
      CANONICAL_TYPES.map((t) => `${t}-term`.toLowerCase()).sort(),
    );
    // The topic label is still the primary bill keyword.
    expect(out.billMatchSet[0].keywords).toContain('everything');
  });

  /**
   * Gate K (MP-08/MP-09). `CompiledBillTopic.id` and each `RoutableTerm.topicId`
   * were both hardcoded away before this gate — `id` was simply absent from
   * the output topic, and every routable term (including the synthetic
   * label-as-keyword entry) carried `topicId: null` regardless of the real
   * topic id. Both are what `scoreBillFit`'s matchedTopicIds (recommendations)
   * and `matchTerms`'s per-match provenance depend on.
   */
  it('carries the topic id through to CompiledBillTopic.id and every RoutableTerm.topicId (Gate K)', () => {
    const out = compileWatchlist({
      issueAreas: [],
      topics: [topic('data center load', 'Energy', 'topic-abc')],
      terms: [term('data center load', 'synonym', 'hyperscale demand')],
    });
    expect(out.billMatchSet[0]!.id).toBe('topic-abc');
    // Every routable term — the synthetic label keyword AND the real term — carries the same topicId.
    for (const rt of out.billMatchSet[0]!.routableTerms) {
      expect(rt.topicId).toBe('topic-abc');
    }
  });

  it('a topic with no id (not yet persisted) compiles with id: null, never throwing', () => {
    const out = compileWatchlist({
      issueAreas: [],
      topics: [topic('Hearing terms')],
      terms: [term('Hearing terms', 'agency', 'FERC')],
    });
    expect(out.billMatchSet[0]!.id).toBeNull();
    for (const rt of out.billMatchSet[0]!.routableTerms) {
      expect(rt.topicId).toBeNull();
    }
  });
});
