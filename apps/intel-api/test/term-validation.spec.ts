import { isAcceptableTerm } from '../src/watchlist/term-validation.js';
import { wholeWordHit, explainMatch, type WatchlistLike } from '../src/tracker/relevance.util.js';
import { dedupeClean, compileWatchlist } from '../src/watchlist/watchlist-compiler.js';

/**
 * Gate B phase a (P0-05) — term-shape-aware validation. AI, 5G, VA, EU, C2,
 * F-1 were silently dropped by the old flat MIN_TERM_LEN = 3; this file locks
 * in the identifier-shape carve-out and its short-term case-sensitive match.
 */
describe('isAcceptableTerm', () => {
  it.each([
    ['AI', true],
    ['5G', true],
    ['VA', true],
    ['EU', true],
    ['UK', true],
    ['C2', true],
    ['C3', true],
    ['F-1', true],
    ['F-35', true],
    ['H.R. 1', true],
    ['0604256F', true],
    ['ai', false],
    ['of', false],
    ['to', false],
    ['an', false],
    ['a', false],
    ['', false],
    ['data center load', true],
  ])('isAcceptableTerm(%j) === %p', (input, expected) => {
    expect(isAcceptableTerm(input)).toBe(expected);
  });
});

describe('wholeWordHit — short identifier-shaped terms', () => {
  it('matches "AI" case-sensitively against original-case text', () => {
    const orig = 'A new bill on AI research funding';
    expect(wholeWordHit(orig.toLowerCase(), 'AI', orig)).toBe(true);
  });

  it('does not false-positive on "ai" inside another word', () => {
    const orig = 'A bill establishing chain of custody rules';
    expect(wholeWordHit(orig.toLowerCase(), 'AI', orig)).toBe(false);
  });

  it('is case-sensitive: lower-case "Ai" in the original does not match "AI"', () => {
    const orig = 'A bill mentions Ai informally';
    expect(wholeWordHit(orig.toLowerCase(), 'AI', orig)).toBe(false);
  });

  it('fails closed with no original-case haystack supplied', () => {
    const orig = 'A new bill on AI research funding';
    expect(wholeWordHit(orig.toLowerCase(), 'AI')).toBe(false);
  });

  it('"F-35" matches "the F-35 program" but not "F-350 truck"', () => {
    const hit = 'Funding for the F-35 program';
    const miss = 'Regulating the F-350 truck fleet';
    expect(wholeWordHit(hit.toLowerCase(), 'F-35', hit)).toBe(true);
    expect(wholeWordHit(miss.toLowerCase(), 'F-35', miss)).toBe(false);
  });
});

describe('explainMatch — short identifier-shaped watchlist terms', () => {
  it('matches AI and VA as identifier-shaped entity terms', () => {
    const wl: WatchlistLike = {
      issueAreas: [],
      tags: [{ tag: 'defense policy', relatedEntities: ['AI', 'VA'] }],
    };
    const bill = {
      title: 'AI accountability in VA health systems',
      policyArea: null,
      subjects: [],
      latestActionText: null,
    };
    const ex = explainMatch(bill, wl);
    expect(ex.matchedTags).toContain('defense policy');
    expect(ex.why).toMatch(/AI|VA/);
    // Both terms independently match this text — explainMatch surfaces only the
    // first hit via `why`, so verify the other directly against the same haystack.
    const hay = bill.title.toLowerCase();
    expect(wholeWordHit(hay, 'AI', bill.title)).toBe(true);
    expect(wholeWordHit(hay, 'VA', bill.title)).toBe(true);
  });
});

describe('dedupeClean — short-term aware', () => {
  it('accepts identifier-shaped short terms, rejects lower-case fragments, dedupes case-insensitively', () => {
    expect(dedupeClean(['AI', '5G', 'ai', 'of'])).toEqual(['5G', 'AI']);
  });
});

describe('compileWatchlist — short terms reach hearing terms and Deepgram keyterms', () => {
  it('AI and 5G survive compilation into hearingTerms and deepgramKeyterms', () => {
    const out = compileWatchlist({
      issueAreas: [],
      topics: [{ label: 'signals', issueArea: null, position: 'monitor', priority: 'med' }],
      terms: [
        { topicLabel: 'signals', termType: 'topic', value: 'AI', weight: 1 },
        { topicLabel: 'signals', termType: 'topic', value: '5G', weight: 1 },
      ],
    });
    const hearingVals = out.hearingTerms.map((h) => h.value).sort();
    expect(hearingVals).toEqual(['5G', 'AI']);
    expect(out.deepgramKeyterms).toEqual(['5g', 'ai']);
  });
});
