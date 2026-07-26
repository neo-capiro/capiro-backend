import { scoreBillFit, type CompiledTopicForFit } from '../src/tracker/bill-fit.util.js';
import { matchTerms, type RoutableTerm } from '../src/watchlist/term-routing.js';
import type { RelevanceBill } from '../src/tracker/relevance.util.js';

/**
 * Gate B §4.13 / §5.5 B12 — the performance cliff P0-04 introduced.
 *
 * Routing all 11 typed-term categories means the recommendations loop now runs
 * `matchTerms` for EVERY topic of EVERY candidate bill. `WatchlistTopicDto` bounds a
 * payload at 200 topics × 500 terms, and each term is tested against up to 4 fields,
 * so the theoretical worst case is ~400k bounded-regex tests per bill. The audit does
 * not mention this at all; if it were slow, every recommendation refresh would pay it.
 *
 * This locks the budget the plan specifies: 200 topics × 50 terms under 250ms.
 *
 * Measured 136–146ms on the 2026-07-26 dev machine AFTER §4.13's mitigations
 * (cached per-term matcher + compiled pattern in relevance.util, memoized per-field
 * text in matchTerms). That is only ~1.8x headroom, and the residual cost is inherent:
 * ~35k bounded-regex scans, which caching cannot remove. So read a failure here as
 * either a genuine algorithmic regression OR a slower CI box — check the logged number
 * before widening the budget.
 *
 * NOT covered by this budget: `getRecommendations` calls scoreBillFit once per
 * CANDIDATE bill, so the real ceiling is this cost × candidate count. At the live data
 * volume (13 topics / 31 terms tenant-wide as of 2026-07-26) that is negligible, but a
 * client that actually approached the DTO's 200x500 bound would need per-topic term
 * truncation (§4.13's fallback) or a pre-filter. Recorded as a follow-up, not a
 * silent assumption.
 */

const TOPICS = 200;
const TERMS_PER_TOPIC = 50;
const BUDGET_MS = 250;

/** A realistically long bill: matching cost scales with haystack length too. */
const bill: RelevanceBill = {
  title: 'A bill to modernize the electric grid and improve interconnection queue processing',
  policyArea: 'Energy',
  subjects: ['Electric power generation and transmission', 'Public utilities', 'Energy research'],
  latestActionText:
    'Referred to the Committee on Energy and Commerce, and in addition to the Committee on Science, Space, and Technology, for a period to be subsequently determined by the Speaker',
  displayNum: 'H.R. 1234',
  billId: '119-hr-1234',
  sponsorName: 'Rep. Example, Alex',
  cosponsorNames: ['Rep. Second, Blake', 'Rep. Third, Casey'],
  committees: ['House Energy and Commerce'],
  programElements: ['0604256F'],
};

const TYPES = ['topic', 'company', 'agency', 'risk_phrase', 'legislator', 'committee'];

function makeTopics(): CompiledTopicForFit[] {
  const out: CompiledTopicForFit[] = [];
  for (let t = 0; t < TOPICS; t += 1) {
    const label = `topic-${String(t).padStart(3, '0')}`;
    const routableTerms: RoutableTerm[] = [];
    for (let i = 0; i < TERMS_PER_TOPIC; i += 1) {
      routableTerms.push({
        id: null,
        topicId: null,
        topicLabel: label,
        // A spread of types so several field lists are exercised, not just one.
        termType: TYPES[i % TYPES.length]!,
        // Mostly non-matching terms — the expensive case, since a match short-circuits
        // the remaining fields for that term.
        value: i === 0 ? 'grid' : `no-match-term-${t}-${i}`,
        topicPriority: i % 3 === 0 ? 'high' : 'med',
      });
    }
    out.push({
      label,
      issueArea: null,
      priority: 'med',
      keywords: [label],
      synonyms: [],
      entities: [],
      riskPhrases: [],
      routableTerms,
    });
  }
  return out;
}

describe('matchTerms / scoreBillFit performance envelope (§4.13, B12)', () => {
  it(`scores ${TOPICS} topics x ${TERMS_PER_TOPIC} terms in under ${BUDGET_MS}ms`, () => {
    const topics = makeTopics();
    // Warm up so the first-call JIT/regex compilation is not charged to the budget.
    scoreBillFit(bill, topics.slice(0, 5), [], 0, false);

    const t0 = process.hrtime.bigint();
    const fit = scoreBillFit(bill, topics, ['Energy'], 0, false);
    const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;

    // Sanity: the work actually happened (every topic carries a matching 'grid').
    expect(fit.matchedTags.length).toBeGreaterThan(0);
    // Reported so a future regression shows the trend, not just pass/fail — jest's
    // own per-test timing includes fixture construction and is not the budget.
    // eslint-disable-next-line no-console
    console.log(`[perf] scoreBillFit ${TOPICS}x${TERMS_PER_TOPIC} = ${elapsedMs.toFixed(1)}ms (budget ${BUDGET_MS}ms)`);
    expect(elapsedMs).toBeLessThan(BUDGET_MS);
  });

  it('matchTerms is synchronous and pure — same input, deep-equal output, no throw on absent fields', () => {
    const terms = makeTopics()[0]!.routableTerms!;
    const a = matchTerms(bill, terms);
    const b = matchTerms(bill, terms);
    expect(a).toEqual(b);
    // §4.12: every new routing field absent/null must not throw.
    const bare: RelevanceBill = { title: 'grid', policyArea: null, subjects: null, latestActionText: null };
    expect(() => matchTerms(bare, terms)).not.toThrow();
  });
});
