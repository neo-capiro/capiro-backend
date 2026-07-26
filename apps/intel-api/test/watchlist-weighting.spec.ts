import { compileWatchlist, DEEPGRAM_KEYTERM_CAP, type CompilerTerm } from '../src/watchlist/watchlist-compiler.js';
import { weightForTerm } from '../src/watchlist/term-routing.js';
import { TrackerWatchlistService } from '../src/tracker/tracker-watchlist.service.js';
import { makeWatchlistStore } from './support/watchlist-store.js';

/**
 * Gate B phase g (§4.9) — weighted hearing keyterms.
 *
 * Every keyterm used to carry weight 1: putWatchlist never wrote the column (so it
 * kept its DEFAULT 1) and getCompiled hardcoded 1. With all weights equal the sort's
 * only effective comparator was the alphabetical tiebreak, so once a client exceeded
 * the Deepgram cap of 100 the selection was purely lexical — a client's
 * highest-priority company name lost to any earlier-alphabet noise term. Verified
 * against the live database on 2026-07-26: `SELECT weight, count(*) FROM
 * intel_watchlist_term GROUP BY 1` returned exactly one row, `weight=1, n=31`.
 */

const TENANT = 'tenant-1';
const CLIENT = '11111111-1111-1111-1111-111111111111';

describe('weightForTerm (§4.9 banding)', () => {
  it('g-6.1 produces the audit’s bands from the routing table + topic priority', () => {
    // Exact-identity types at high priority top the table…
    expect(weightForTerm('company', 'high')).toBe(6.25);
    expect(weightForTerm('bill', 'high')).toBe(6.25);
    expect(weightForTerm('program_element', 'high')).toBe(6.25);
    // …then high-priority language/risk…
    expect(weightForTerm('risk_phrase', 'high')).toBe(5);
    expect(weightForTerm('support_language', 'high')).toBe(5);
    expect(weightForTerm('opposition_language', 'high')).toBe(5);
    // …then med exact-entity…
    expect(weightForTerm('company', 'med')).toBe(5);
    expect(weightForTerm('entity', 'med')).toBe(3);
    expect(weightForTerm('agency', 'med')).toBe(3);
    // …then broad terms…
    expect(weightForTerm('topic', 'med')).toBe(2);
    expect(weightForTerm('synonym', 'med')).toBe(2);
    // …and a low-priority broad term at the bottom.
    expect(weightForTerm('synonym', 'low')).toBe(1.5);
    expect(weightForTerm('topic', 'low')).toBe(1.5);
  });

  it('an UNROUTED (hearing-native) term type keeps its previous weight of 1', () => {
    expect(weightForTerm('some_hearing_native_type', 'med')).toBe(1);
    expect(weightForTerm('some_hearing_native_type', 'high')).toBe(1);
  });
});

describe('TrackerWatchlistService — persisted + compiled weights (§4.9)', () => {
  const seed = (svc: TrackerWatchlistService, topics: unknown[]) =>
    svc.putWatchlist(TENANT, CLIENT, 'user-1', { issueAreas: [], topics: topics as never });

  it('g-6.3 putWatchlist persists a non-1 weight (company on a high-priority topic)', async () => {
    const h = makeWatchlistStore({ tenantId: TENANT, clientId: CLIENT });
    const svc = new TrackerWatchlistService(h.prisma as never);

    await seed(svc, [
      {
        label: 'primes',
        priority: 'high',
        terms: [
          { termType: 'company', value: 'RTX' },
          { termType: 'topic', value: 'autonomous systems' },
        ],
      },
    ]);

    const byValue = new Map(h.snapshot().terms.map((t) => [t.value, t.weight]));
    expect(byValue.get('RTX')).toBe(6.25);
    expect(byValue.get('autonomous systems')).toBe(2.5);
    // The whole point: not every row is 1 any more.
    expect(new Set(h.snapshot().terms.map((t) => t.weight)).size).toBeGreaterThan(1);
  });

  it('g-6.2 getCompiled reports per-term weights from weightForTerm, not all 1', async () => {
    const h = makeWatchlistStore({ tenantId: TENANT, clientId: CLIENT });
    const svc = new TrackerWatchlistService(h.prisma as never);
    await seed(svc, [
      { label: 'primes', priority: 'high', terms: [{ termType: 'company', value: 'RTX' }] },
      { label: 'noise', priority: 'low', terms: [{ termType: 'synonym', value: 'grid load' }] },
    ]);

    const compiled = await svc.getCompiled(TENANT, CLIENT);
    const weights = new Map(compiled.hearingTerms.map((t) => [t.value, t.weight]));

    expect(weights.get('RTX')).toBe(6.25);
    expect(weights.get('grid load')).toBe(1.5);
  });

  it('flipping a topic’s PRIORITY rewrites its terms’ weights rather than being skipped', async () => {
    const h = makeWatchlistStore({ tenantId: TENANT, clientId: CLIENT });
    const svc = new TrackerWatchlistService(h.prisma as never);
    const terms = [{ termType: 'company', value: 'RTX' }];

    await seed(svc, [{ label: 'primes', priority: 'med', terms }]);
    expect(h.snapshot().terms[0]!.weight).toBe(5);

    await seed(svc, [{ label: 'primes', priority: 'high', terms }]);
    expect(h.snapshot().terms[0]!.weight).toBe(6.25);
  });
});

describe('compileWatchlist — per-topic Deepgram capacity reservation (§4.9)', () => {
  const topic = (label: string, priority = 'med') => ({
    label,
    issueArea: null,
    position: 'monitor',
    priority,
  });
  const term = (topicLabel: string, termType: string, value: string, priority = 'med'): CompilerTerm => ({
    termType,
    value,
    weight: weightForTerm(termType, priority),
    topicLabel,
    topicPriority: priority,
  });

  it('g-6.4 reserves a share per topic so one large topic cannot crowd the others out', () => {
    const terms: CompilerTerm[] = [];
    // Topic A floods the cap with 100 broad terms…
    for (let i = 0; i < 100; i += 1) terms.push(term('A', 'topic', `a-term-${String(i).padStart(3, '0')}`));
    // …while B and C have 25 each. Alphabetically, every "a-term-*" sorts FIRST.
    for (let i = 0; i < 25; i += 1) terms.push(term('B', 'topic', `b-term-${String(i).padStart(3, '0')}`));
    for (let i = 0; i < 24; i += 1) terms.push(term('C', 'topic', `c-term-${String(i).padStart(3, '0')}`));
    // C also owns the client's most strategically important term.
    terms.push(term('C', 'company', 'RTX', 'high'));

    const out = compileWatchlist({
      issueAreas: [],
      topics: [topic('A'), topic('B'), topic('C')],
      terms,
    });

    expect(out.deepgramKeyterms).toHaveLength(DEEPGRAM_KEYTERM_CAP);
    // Pre-change this returned the alphabetically-first 100 — all of topic A —
    // so neither the company name nor a single B/C term made the cut.
    expect(out.deepgramKeyterms).toContain('rtx');
    const from = (p: string) => out.deepgramKeyterms.filter((v) => v.startsWith(p)).length;
    expect(from('b-term-')).toBeGreaterThanOrEqual(25);
    expect(from('c-term-')).toBeGreaterThanOrEqual(24);
    // A still gets the remaining capacity — reservation, not an equal split.
    expect(from('a-term-')).toBeGreaterThan(perTopicFloor());
    function perTopicFloor() {
      return Math.floor(DEEPGRAM_KEYTERM_CAP / 3) - 1;
    }
  });

  it('g-6.5 output is byte-stable across runs and lexically sorted', () => {
    const input = {
      issueAreas: [],
      topics: [topic('A', 'high'), topic('B', 'low')],
      terms: [
        term('A', 'company', 'RTX', 'high'),
        term('A', 'topic', 'autonomy', 'high'),
        term('B', 'synonym', 'grid load', 'low'),
      ],
    };
    const a = compileWatchlist(input).deepgramKeyterms;
    const b = compileWatchlist(input).deepgramKeyterms;

    expect(a).toEqual(b);
    expect(a).toEqual([...a].sort((x, y) => x.localeCompare(y)));
    expect(a).toEqual(['autonomy', 'grid load', 'rtx']);
  });

  it('g-6.6 a watchlist UNDER the cap is unaffected: every acceptable term still ships', () => {
    const terms: CompilerTerm[] = [];
    for (let i = 0; i < 40; i += 1) terms.push(term('A', 'topic', `a-${String(i).padStart(2, '0')}`));
    for (let i = 0; i < 40; i += 1) terms.push(term('B', 'topic', `b-${String(i).padStart(2, '0')}`));

    const out = compileWatchlist({ issueAreas: [], topics: [topic('A'), topic('B')], terms });

    expect(out.deepgramKeyterms).toHaveLength(80);
    expect(out.deepgramKeyterms).toEqual(
      terms.map((t) => t.value.toLowerCase()).sort((x, y) => x.localeCompare(y)),
    );
  });

  it('a single-topic watchlist over the cap behaves exactly as before (perTopic IS the cap)', () => {
    const terms: CompilerTerm[] = [];
    for (let i = 0; i < 150; i += 1) {
      terms.push({
        termType: 'synonym',
        value: `term-${String(i).padStart(3, '0')}`,
        weight: i,
        topicLabel: 'A',
        topicPriority: 'med',
      });
    }
    const out = compileWatchlist({ issueAreas: [], topics: [topic('A')], terms });

    expect(out.deepgramKeyterms).toHaveLength(DEEPGRAM_KEYTERM_CAP);
    expect(out.deepgramKeyterms).toContain('term-149'); // highest weight kept
    expect(out.deepgramKeyterms).not.toContain('term-000'); // lowest weight dropped
  });

  it('flat (topic-less) hearing terms get their own reserved bucket rather than none', () => {
    const terms: CompilerTerm[] = [];
    for (let i = 0; i < 120; i += 1) terms.push(term('A', 'topic', `a-term-${String(i).padStart(3, '0')}`));
    terms.push({
      termType: 'agency',
      value: 'FERC',
      weight: weightForTerm('agency', 'med'),
      topicLabel: null,
      topicPriority: 'med',
    });

    const out = compileWatchlist({ issueAreas: [], topics: [topic('A')], terms });

    expect(out.deepgramKeyterms).toHaveLength(DEEPGRAM_KEYTERM_CAP);
    expect(out.deepgramKeyterms).toContain('ferc');
  });
});
