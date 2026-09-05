/**
 * LegiWatch V2 Wave 1 (W1-6) — client relevance shaping.
 *
 * These run against constructed rows rather than the database, which is the
 * point: some states the shaping layer must handle correctly are not reachable
 * through the current schema (see the INSUFFICIENT_EVIDENCE block), and a
 * defensive guard that is never exercised is a guard that quietly rots.
 */
import {
  bandForScore,
  buildAllClientsRelevance,
  buildClientRelevance,
  extractMatchedPriorities,
  timecode,
  RELEVANCE_BAND_FLOORS,
  type RelevanceRow,
} from './legiwatch-wave1-relevance.js';

function row(overrides: Partial<RelevanceRow> = {}): RelevanceRow {
  return {
    id: 'rel-1',
    clientId: 'client-1',
    clientName: 'Aperture Defense',
    hearingId: 'hearing-1',
    insightId: 'insight-1',
    score: 0.9,
    matchedOn: [{ label: 'submarine industrial base', kind: 'topic' }],
    rationale: 'Aperture supplies the submarine industrial base.',
    updatedAt: new Date('2026-09-01T12:00:00Z'),
    insightType: 'FUNDING_AMOUNT',
    insightTitle: 'Multiyear procurement funding',
    insightSummary: 'The chair tied workforce stability to multiyear funding.',
    evidenceText: 'sustained multiyear procurement funding',
    speakerName: 'CHAIR',
    confidence: 0.91,
    preliminary: false,
    segmentId: 'seg-1',
    startMs: 65000,
    endMs: 95000,
    extractor: 'legiwatch-extractor',
    extractorVersion: '1.0',
    ...overrides,
  };
}

describe('relevance banding', () => {
  it('maps scores to bands at the published floors', () => {
    expect(bandForScore(0.95)).toBe('HIGH');
    expect(bandForScore(RELEVANCE_BAND_FLOORS.HIGH)).toBe('HIGH');
    expect(bandForScore(0.69)).toBe('MEDIUM');
    expect(bandForScore(RELEVANCE_BAND_FLOORS.MEDIUM)).toBe('MEDIUM');
    expect(bandForScore(0.44)).toBe('LOW');
    expect(bandForScore(RELEVANCE_BAND_FLOORS.LOW)).toBe('LOW');
    expect(bandForScore(0.19)).toBe('NONE');
  });

  it('treats a missing or non-finite score as NONE, never as a match', () => {
    expect(bandForScore(null)).toBe('NONE');
    expect(bandForScore(Number.NaN)).toBe('NONE');
  });
});

describe('timecode', () => {
  it('renders a millisecond offset as H:MM:SS', () => {
    expect(timecode(0)).toBe('0:00:00');
    expect(timecode(65000)).toBe('0:01:05');
    expect(timecode(3_725_000)).toBe('1:02:05');
  });

  it('returns null rather than a fake zero for an absent offset', () => {
    expect(timecode(null)).toBeNull();
    expect(timecode(undefined)).toBeNull();
    expect(timecode(-1)).toBeNull();
  });
});

describe('matched priorities', () => {
  it('reads labelled objects', () => {
    expect(extractMatchedPriorities([{ label: 'shipbuilding', kind: 'topic' }])).toEqual([
      { label: 'shipbuilding', kind: 'topic' },
    ]);
  });

  it('reads the alternate label carriers the worker has used', () => {
    const out = extractMatchedPriorities([
      { term: 'submarine' },
      { topic: 'readiness', type: 'issue-area' },
      { name: 'depot' },
    ]);
    expect(out.map((p) => p.label)).toEqual(['submarine', 'readiness', 'depot']);
    expect(out[1]?.kind).toBe('issue-area');
  });

  it('reads a bare string array', () => {
    expect(extractMatchedPriorities(['alpha', 'beta']).map((p) => p.label)).toEqual([
      'alpha',
      'beta',
    ]);
  });

  it('de-duplicates case-insensitively', () => {
    expect(extractMatchedPriorities(['Shipbuilding', 'shipbuilding'])).toHaveLength(1);
  });

  it('returns nothing for shapes it cannot read, rather than inventing a label', () => {
    expect(extractMatchedPriorities(null)).toEqual([]);
    expect(extractMatchedPriorities({})).toEqual([]);
    expect(extractMatchedPriorities(42)).toEqual([]);
    expect(extractMatchedPriorities([{ score: 1 }])).toEqual([]);
  });
});

describe('buildClientRelevance', () => {
  const base = {
    clientId: 'client-1',
    clientName: 'Aperture Defense',
    hearingId: 'hearing-1',
    hasTranscript: true,
  };

  it('produces a structured HIGH result with grounded evidence and provenance', () => {
    const result = buildClientRelevance({ ...base, rows: [row()] });
    expect(result.band).toBe('HIGH');
    expect(result.score).toBe(0.9);
    expect(result.whyItMatters).toBe('Aperture supplies the submarine industrial base.');
    expect(result.matchedPriorities).toEqual([
      { label: 'submarine industrial base', kind: 'topic' },
    ]);
    expect(result.evidence[0]).toMatchObject({
      insightId: 'insight-1',
      segmentId: 'seg-1',
      timecode: '0:01:05',
      quote: 'sustained multiyear procurement funding',
    });
    expect(result.provenance).toMatchObject({
      insightIds: ['insight-1'],
      segmentIds: ['seg-1'],
      transcriptAvailable: true,
      extractors: ['legiwatch-extractor@1.0'],
      matchCount: 1,
    });
    expect(result.evaluatedAt).toBe('2026-09-01T12:00:00.000Z');
  });

  it('orders evidence strongest-first', () => {
    const result = buildClientRelevance({
      ...base,
      rows: [
        row({ id: 'r-low', insightId: 'i-low', score: 0.3 }),
        row({ id: 'r-high', insightId: 'i-high', score: 0.95 }),
      ],
    });
    expect(result.evidence.map((e) => e.insightId)).toEqual(['i-high', 'i-low']);
    expect(result.score).toBe(0.95);
  });

  it('returns NONE with an honest sentence when there are no rows', () => {
    const result = buildClientRelevance({ ...base, rows: [] });
    expect(result.band).toBe('NONE');
    expect(result.whyItMatters).toContain('No watchlist or client-priority match');
    expect(result.evidence).toEqual([]);
    expect(result.recommendedActions).toEqual([]);
    expect(result.evaluatedAt).toBeNull();
  });

  /**
   * The guard this file exists for. The current schema FKs an insight to its
   * transcript segment ON DELETE CASCADE, so a relevance row citing a deleted
   * segment cannot survive in the database — which means this state is only
   * constructible here. It is still worth enforcing: the rule is that a missing
   * transcript must never yield transcript-based claims, and a future change to
   * that FK, or a relevance source that is not segment-bound, would make it
   * reachable.
   */
  it('downgrades to INSUFFICIENT_EVIDENCE when rows cite a transcript that is not available', () => {
    const result = buildClientRelevance({ ...base, hasTranscript: false, rows: [row()] });
    expect(result.band).toBe('INSUFFICIENT_EVIDENCE');
    expect(result.evidence).toEqual([]);
    expect(result.implications).toEqual([]);
    expect(result.recommendedActions).toEqual([]);
    expect(result.whyItMatters).toContain('not enough evidence on the record');
    expect(result.provenance.transcriptAvailable).toBe(false);
  });

  it('keeps a non-transcript-citing match rather than voiding it', () => {
    // A row that cites neither a segment nor a quote makes no transcript claim,
    // so the absence of a transcript is not a reason to suppress it.
    const result = buildClientRelevance({
      ...base,
      hasTranscript: false,
      rows: [row({ segmentId: null, evidenceText: null })],
    });
    expect(result.band).toBe('HIGH');
    expect(result.evidence[0]?.quote).toBeNull();
    expect(result.evidence[0]?.timecode).toBeNull();
  });

  it('says so when rows exist but carry no rationale, rather than filling the gap', () => {
    const result = buildClientRelevance({ ...base, rows: [row({ rationale: '' })] });
    expect(result.whyItMatters).toContain('no rationale was recorded');
  });

  it('joins at most three distinct rationales', () => {
    const result = buildClientRelevance({
      ...base,
      rows: [
        row({ id: 'a', insightId: 'ia', rationale: 'One.', score: 0.9 }),
        row({ id: 'b', insightId: 'ib', rationale: 'Two.', score: 0.8 }),
        row({ id: 'c', insightId: 'ic', rationale: 'Three.', score: 0.7 }),
        row({ id: 'd', insightId: 'id', rationale: 'Four.', score: 0.6 }),
      ],
    });
    expect(result.whyItMatters).toBe('One. Two. Three.');
  });

  it('derives implications only from insight types actually present', () => {
    const result = buildClientRelevance({
      ...base,
      rows: [row({ insightType: 'COMMITMENT' })],
    });
    expect(result.implications).toEqual([
      'A witness or member made a commitment on the record that can be tracked to follow-through.',
    ]);
  });

  it('emits no implication for an insight type with no mapping', () => {
    const result = buildClientRelevance({ ...base, rows: [row({ insightType: 'MENTION' })] });
    expect(result.implications).toEqual([]);
  });

  it('recommends outreach only when something actionable is on the record', () => {
    const withCommitment = buildClientRelevance({
      ...base,
      rows: [row({ insightType: 'COMMITMENT' })],
    });
    expect(withCommitment.recommendedActions.map((a) => a.action)).toContain('stage_outreach');

    const withoutHook = buildClientRelevance({
      ...base,
      rows: [row({ insightType: 'MENTION' })],
    });
    expect(withoutHook.recommendedActions.map((a) => a.action)).not.toContain('stage_outreach');
  });

  it('never recommends saving a moment with no segment to point at', () => {
    const result = buildClientRelevance({ ...base, rows: [row({ segmentId: null })] });
    expect(result.recommendedActions.map((a) => a.action)).not.toContain('save_moment');
  });

  it('prefills every recommended action with a real reference', () => {
    const result = buildClientRelevance({ ...base, rows: [row({ insightType: 'DEADLINE' })] });
    for (const action of result.recommendedActions) {
      if (action.insightId) expect(action.insightId).toBe('insight-1');
      if (action.segmentId) expect(action.segmentId).toBe('seg-1');
    }
  });
});

describe('buildAllClientsRelevance', () => {
  const authorizedClients = [
    { id: 'client-1', name: 'Aperture Defense' },
    { id: 'client-2', name: 'Northwind Maritime' },
    { id: 'client-3', name: 'Quiet Client' },
  ];

  it('ranks HIGH before MEDIUM before NONE', () => {
    const results = buildAllClientsRelevance({
      hearingId: 'hearing-1',
      authorizedClients,
      hasTranscript: true,
      rows: [
        row({ clientId: 'client-2', insightId: 'i2', score: 0.5 }),
        row({ clientId: 'client-1', insightId: 'i1', score: 0.95 }),
      ],
    });
    expect(results.map((r) => r.clientId)).toEqual(['client-1', 'client-2', 'client-3']);
    expect(results.map((r) => r.band)).toEqual(['HIGH', 'MEDIUM', 'NONE']);
  });

  it('includes non-matching clients so the ranking is a complete answer', () => {
    const results = buildAllClientsRelevance({
      hearingId: 'hearing-1',
      authorizedClients,
      hasTranscript: true,
      rows: [],
    });
    expect(results).toHaveLength(3);
    expect(results.every((r) => r.band === 'NONE')).toBe(true);
  });

  it('drops a row naming a client the caller is not authorized to see', () => {
    // Defence in depth: even if a stray row named another tenant's client, it
    // must not surface here.
    const results = buildAllClientsRelevance({
      hearingId: 'hearing-1',
      authorizedClients,
      hasTranscript: true,
      rows: [row({ clientId: 'other-tenant-client', score: 0.99 })],
    });
    expect(results.map((r) => r.clientId)).not.toContain('other-tenant-client');
    expect(results.every((r) => r.band === 'NONE')).toBe(true);
  });

  it('breaks a band and score tie by client name', () => {
    const results = buildAllClientsRelevance({
      hearingId: 'hearing-1',
      authorizedClients: [
        { id: 'z', name: 'Zulu' },
        { id: 'a', name: 'Alpha' },
      ],
      hasTranscript: true,
      rows: [],
    });
    expect(results.map((r) => r.clientName)).toEqual(['Alpha', 'Zulu']);
  });
});
