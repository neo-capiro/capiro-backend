import {
  normalizeEvidence,
  ALERT_EVIDENCE_SCHEMA_VERSION,
  type NormalizeInput,
} from '../src/feed/normalize-evidence.js';

/**
 * P0-07 / P1-09 (Gate C a-8). Closes audit test-gap item 7: there was no test that a
 * stored writer shape survives the read boundary as the contract the web declares.
 */

/** The EXACT object bill-change-detector.service.ts:1031-1048 writes. */
const flatBillEvidence = () => ({
  // ...(ev.extra ?? {}) — event-specific fields spread FIRST so fixed keys win.
  tally: { yea: 32, nay: 12 },
  stage: 'Reported by committee',
  actionText: 'Ordered to be Reported by the Yeas and Nays: 32 - 12.',
  actionDate: '2026-07-18',
  url: 'https://www.congress.gov/bill/119th-congress/house-bill/8800',
  sourceUrl: 'https://www.congress.gov/bill/119th-congress/house-bill/8800',
  why: 'Matches your watchlist term "hypersonics".',
  matchedTags: ['Hypersonics', 'Defense RDT&E'],
  tone: 'positive',
  band: 'B',
  triggerKey: 'committee_vote',
  billTitle: 'Hypersonic Capability Acceleration Act',
  displayNum: 'H.R. 8800',
  jurisdiction: 'US',
});

const base = (over: Partial<NormalizeInput> = {}): NormalizeInput => ({
  sourceType: 'bill',
  sourceRef: '119-hr-8800',
  title: 'H.R. 8800: Reported by committee',
  whyItMatters: 'Headline why.',
  termId: null,
  evidence: flatBillEvidence(),
  ...over,
});

describe('normalizeEvidence — flat bill-change-detector shape (P0-07)', () => {
  // Case 1
  it('synthesizes a nested bill from the flat writer', () => {
    const r = normalizeEvidence(base());
    expect(r.schemaVersion).toBe(ALERT_EVIDENCE_SCHEMA_VERSION);
    expect(r.schemaVersion).toBe(1);
    expect(r.type).toBe('bill');
    expect(r.provenance.writerShape).toBe('flat_bill');
    expect(r.bill).toEqual({
      billId: '119-hr-8800',
      displayNum: 'H.R. 8800',
      title: 'Hypersonic Capability Acceleration Act',
      url: 'https://www.congress.gov/bill/119th-congress/house-bill/8800',
      stage: 'Reported by committee',
      actionText: 'Ordered to be Reported by the Yeas and Nays: 32 - 12.',
      actionDate: '2026-07-18',
      jurisdiction: 'US',
    });
  });

  // Case 2
  it('carries a state jurisdiction onto both the bill and the provenance', () => {
    const r = normalizeEvidence(
      base({
        sourceType: 'state_bill',
        sourceRef: 'ca-ab-1234',
        evidence: { ...flatBillEvidence(), jurisdiction: 'CA' },
      }),
    );
    expect(r.type).toBe('state_bill');
    expect(r.bill?.jurisdiction).toBe('CA');
    expect(r.provenance.jurisdiction).toBe('CA');
  });

  it('falls back to sourceRef for displayNum and omits jurisdiction when unset', () => {
    const r = normalizeEvidence(base({ evidence: { stage: 'Introduced' } }));
    expect(r.bill?.displayNum).toBe('119-hr-8800');
    expect(r.bill?.title).toBeNull();
    expect(r.bill?.actionText).toBeNull();
    expect(r.bill?.stage).toBe('Introduced');
    expect('jurisdiction' in (r.bill ?? {})).toBe(false);
    expect(r.provenance.jurisdiction).toBe('US'); // established default
  });
});

describe('normalizeEvidence — nested shapes pass through', () => {
  // Case 3
  it('passes a nested hearing through BY REFERENCE and synthesizes no bill', () => {
    const hearing = {
      sessionId: 'sess-1',
      title: 'Posture hearing',
      committeeId: 'HSAS',
      occurredAt: '2026-07-01T14:00:00Z',
      mentions: [{ segmentId: 'seg1', quote: 'plaintext', quoteSource: 'textPlain', issueTags: [] }],
    };
    const input = base({ sourceType: 'hearing', sourceRef: 'sess-1', evidence: { hearing } });
    const r = normalizeEvidence(input);
    expect(r.hearing).toBe(hearing); // identity, not deep equality
    expect(r.bill).toBeUndefined();
    expect(r.type).toBe('hearing');
    expect(r.provenance.writerShape).toBe('nested');
  });

  // Case 4
  it('passes a nested programElement through and synthesizes no bill', () => {
    const programElement = { peCode: '0603286F', title: 'Hypersonics Prototyping', deltaMillions: 250 };
    const r = normalizeEvidence(
      base({ sourceType: 'program_element', sourceRef: '0603286F', evidence: { programElement } }),
    );
    expect(r.programElement).toBe(programElement);
    expect(r.bill).toBeUndefined();
    expect(r.type).toBe('program_element');
  });

  // Case 5 — §4 edge case 1: writerShape 'mixed'.
  it('keeps both bill and hearing on a combined alert', () => {
    const hearing = { sessionId: 'sess-2', mentions: [] };
    const bill = {
      billId: '119-s-4000',
      displayNum: 'S. 4000',
      title: 'NDAA',
      url: null,
      stage: 'Passed Senate',
      actionText: null,
      actionDate: null,
    };
    const r = normalizeEvidence(
      base({
        sourceType: 'combined',
        sourceRef: '119-s-4000',
        evidence: { bill, hearing, stage: 'Passed Senate', displayNum: 'S. 4000' },
      }),
    );
    expect(r.type).toBe('combined');
    expect(r.provenance.writerShape).toBe('mixed');
    expect(r.bill).toBe(bill); // §4 edge case 2: nested wins, never a field-by-field merge
    expect(r.hearing).toBe(hearing);
    // The unconsumed flat keys are preserved rather than dropped.
    expect(r.extra['stage']).toBe('Passed Senate');
    expect(r.extra['displayNum']).toBe('S. 4000');
  });

  it('passes regulation and link objects through by reference', () => {
    const regulation = { docketId: 'EPA-HQ-OAR-2026-0001', commentsDue: '2026-09-01' };
    const link = { via: 'bill_hearing_linker', confidence: 0.82 };
    const r = normalizeEvidence(
      base({ sourceType: 'regulation', evidence: { regulation, link } }),
    );
    expect(r.regulation).toBe(regulation);
    expect(r.link).toBe(link);
    expect(r.bill).toBeUndefined();
  });
});

describe('normalizeEvidence — match block (P1-09)', () => {
  // Case 6
  it('lifts matchedTags and prefers ev.why over the headline', () => {
    const r = normalizeEvidence(base());
    expect(r.match.matchedTags).toEqual(['Hypersonics', 'Defense RDT&E']);
    expect(r.match.why).toBe('Matches your watchlist term "hypersonics".');
    expect(r.match.details).toEqual([]); // honest: no writer emits matchDetails yet
  });

  it('falls back to whyItMatters when ev.why is absent', () => {
    const ev = flatBillEvidence() as Record<string, unknown>;
    delete ev['why'];
    const r = normalizeEvidence(base({ evidence: ev, whyItMatters: 'Headline why.' }));
    expect(r.match.why).toBe('Headline why.');
  });

  it('carries termId and the resolved topicLabel', () => {
    const r = normalizeEvidence(base({ termId: 'term-1', topicLabel: 'Hypersonic Weapons' }));
    expect(r.match.termId).toBe('term-1');
    expect(r.match.topicLabel).toBe('Hypersonic Weapons');
  });

  it('drops non-string entries from matchedTags rather than throwing', () => {
    const r = normalizeEvidence(base({ evidence: { matchedTags: ['ok', 42, null, 'also'] } }));
    expect(r.match.matchedTags).toEqual(['ok', 'also']);
  });
});

describe('normalizeEvidence — provenance', () => {
  // Case 7
  it('prefers sourceUrl, falls back to url, and is null when neither exists', () => {
    expect(normalizeEvidence(base()).provenance.sourceUrl).toBe(
      'https://www.congress.gov/bill/119th-congress/house-bill/8800',
    );
    expect(
      normalizeEvidence(base({ evidence: { url: 'https://only-url.example', stage: 's' } })).provenance
        .sourceUrl,
    ).toBe('https://only-url.example');
    expect(normalizeEvidence(base({ evidence: { stage: 's' } })).provenance.sourceUrl).toBeNull();
  });

  it('carries triggerKey, tone and band', () => {
    const p = normalizeEvidence(base()).provenance;
    expect(p.triggerKey).toBe('committee_vote');
    expect(p.tone).toBe('positive');
    expect(p.band).toBe('B');
  });
});

describe('normalizeEvidence — malformed input never throws', () => {
  // Case 8
  it.each([[null], ['a string'], [42], [[]], [undefined]])('tolerates %p', (evidence) => {
    const r = normalizeEvidence(base({ evidence }));
    expect(r.provenance.writerShape).toBe('empty');
    expect(r.type).toBe('bill'); // still from sourceType, the authoritative column
    expect(r.match.matchedTags).toEqual([]);
    expect(r.bill).toBeUndefined();
    expect(r.extra).toEqual({});
  });

  it('maps an unknown sourceType to type:"unknown" without inferring from the shape', () => {
    const r = normalizeEvidence(base({ sourceType: 'martian_decree' }));
    expect(r.type).toBe('unknown');
    // Flat bill keys are present, but the type is not bill-shaped → no bill.
    expect(r.bill).toBeUndefined();
  });
});

describe('normalizeEvidence — no data loss (the anti-data-loss guarantee)', () => {
  // Case 9
  it('preserves every unclaimed key under extra and hoists none to the top level', () => {
    const r = normalizeEvidence(
      base({
        evidence: {
          ...flatBillEvidence(),
          tally: { yea: 32, nay: 12 },
          cutoffType: 'committee',
          cosponsorNames: ['Rep. A', 'Rep. B'],
          zzz_unknown_key: 'must survive',
        },
      }),
    );
    expect(r.extra['tally']).toEqual({ yea: 32, nay: 12 });
    expect(r.extra['cutoffType']).toBe('committee');
    expect(r.extra['cosponsorNames']).toEqual(['Rep. A', 'Rep. B']);
    expect(r.extra['zzz_unknown_key']).toBe('must survive');
    for (const k of ['tally', 'cutoffType', 'cosponsorNames', 'zzz_unknown_key']) {
      expect(k in r).toBe(false);
    }
  });

  it('keeps flat bill keys in extra when they were NOT used to synthesize a bill', () => {
    // §4 edge case 3: a hearing alert carrying stray flat keys.
    const r = normalizeEvidence(
      base({
        sourceType: 'hearing',
        sourceRef: 'sess-3',
        evidence: { sessionId: 'sess-3', stage: 'Hearing held', actionText: 'Testimony taken' },
      }),
    );
    expect(r.bill).toBeUndefined();
    expect(r.extra['sessionId']).toBe('sess-3');
    expect(r.extra['stage']).toBe('Hearing held');
    expect(r.extra['actionText']).toBe('Testimony taken');
  });

  // §4 edge case 4: the writer spreads ev.extra FIRST, so a fixed key already won at
  // write time. Nothing to do on read — assert the precedence survives.
  it('reflects the writer-time precedence when ev.extra collided with a fixed key', () => {
    const stored = { ...{ stage: 'STALE FROM EXTRA' }, ...flatBillEvidence() };
    const r = normalizeEvidence(base({ evidence: stored }));
    expect(r.bill?.stage).toBe('Reported by committee');
  });
});

describe('normalizeEvidence — decryptQuotes ordering (§2.4.3)', () => {
  // Case 10
  it('reflects a quote mutated after input construction but before normalization', () => {
    const hearing = {
      sessionId: 'sess-4',
      mentions: [{ segmentId: 'seg1', quote: null as string | null, quoteSource: 'encrypted' }],
    };
    const input = base({ sourceType: 'hearing', sourceRef: 'sess-4', evidence: { hearing } });
    // This is exactly what FeedService.decryptQuotes does: mutate in place, then
    // normalize. Pass-by-reference is what makes the decrypted text survive.
    hearing.mentions[0]!.quote = 'DECRYPTED';
    const r = normalizeEvidence(input);
    expect((r.hearing as typeof hearing).mentions[0]!.quote).toBe('DECRYPTED');
    expect(r.hearing).toBe(hearing);
  });

  it('never substitutes a placeholder for a failed decrypt (fail-closed)', () => {
    const hearing = {
      sessionId: 'sess-5',
      mentions: [{ segmentId: 'seg1', quote: null, quoteSource: 'encrypted' }],
    };
    const r = normalizeEvidence(base({ sourceType: 'hearing', evidence: { hearing } }));
    expect((r.hearing as typeof hearing).mentions[0]!.quote).toBeNull();
  });
});
