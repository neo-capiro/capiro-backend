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

  /**
   * Gate K (MP-10, f-2): the cross-topic duplicate case. No existing test in
   * this file (or watchlist-weighting.spec.ts) uses the SAME value across
   * two topics with DIFFERENT weights — every prior case used distinct
   * values or equal weights, so this failure mode had zero coverage.
   *
   * Before the fix, dedup kept whichever occurrence appeared FIRST in
   * `input.terms` (Set-based, first-write-wins), freezing its weight AND
   * topic attribution regardless of whether a later, higher-weight
   * occurrence existed. Proven here via a deliberate cap squeeze: 'shared'
   * is fed in at weight 0 under topic 'low' FIRST, then at weight 99 under
   * topic 'high' second. Topic 'low' also carries 99 filler terms at
   * weight 50 — enough that, with a 2-topic 50-each reservation split, a
   * weight-0 'shared' attributed to 'low' would rank last among ALL 100 of
   * low's own candidates and be squeezed out of both the per-topic
   * reservation AND the global overflow fill (worked through below). Only
   * the FIXED (max-weight-wins) behavior lets it survive.
   */
  it('Gate K (MP-10): a term appearing in both a low- and high-priority topic keeps the HIGH weight and high-priority attribution, not whichever the input array happened to list first', () => {
    const terms: CompilerTerm[] = [
      term('low', 'synonym', 'shared', 0),
      ...Array.from({ length: 99 }, (_, i) => term('low', 'synonym', `low-filler-${i}`, 50)),
      term('high', 'synonym', 'shared', 99),
      term('high', 'synonym', 'high-filler', 1),
    ];
    const out = compileWatchlist({
      issueAreas: [],
      topics: [topic('low'), topic('high')],
      terms,
    });
    expect(out.deepgramKeyterms).toContain('shared');
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
