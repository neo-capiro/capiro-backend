import { describe, expect, it } from '@jest/globals';
import { deriveEvidenceDates } from './evidence-dates';
import { evaluateFreshness } from './freshness';
import { compareExactValues, extractExactValues, houseSenateComparisonComplete } from './exact-comparison';
import { evaluateClaimDeterministically } from './deterministic-evaluation';

describe('deriveEvidenceDates', () => {
  it.each([
    ['award', { latestActionDate: '2026-04-02', capiroSyncedAt: '2026-04-03' }, '2026-04-02T00:00:00.000Z', null, 'tool_asOf'],
    ['rule', { effectiveDate: '2026-05-01', lastSyncAt: '2026-05-02' }, '2026-05-01T00:00:00.000Z', null, 'tool_asOf'],
    ['budget', { source: { observedAt: '2026-06-01' } }, null, '2026-06-01T00:00:00.000Z', 'none'],
  ])('%s dates preserve source semantics', (_name, toolPayload, effectiveAt, publishedAt, retrievalBasis) => {
    const result = deriveEvidenceDates({ toolPayload });
    expect(result.effectiveAt).toBe(effectiveAt);
    expect(result.publishedAt).toBe(publishedAt);
    expect(result.basis.retrievedAt).toBe(retrievalBasis);
  });

  it('prefers citation observation for retrieval and leaves unknown values null', () => {
    expect(deriveEvidenceDates({ citation: { type: 'web', source: { kind: 'document', recordId: 'r', observedAt: '2026-07-01' } } }))
      .toEqual(expect.objectContaining({ retrievedAt: '2026-07-01T00:00:00.000Z', basis: expect.objectContaining({ retrievedAt: 'observedAt' }) }));
    expect(deriveEvidenceDates({})).toEqual({ publishedAt: null, effectiveAt: null, retrievedAt: null,
      basis: { publishedAt: 'none', effectiveAt: 'none', retrievedAt: 'none' } });
  });
});

describe('evaluateFreshness', () => {
  it('keeps enactment and awards durable regardless of age', () => {
    expect(evaluateFreshness({ category: 'enactment', evidence: { effectiveAt: '1990-01-01' }, asOf: '2026-09-22' }).state).toBe('fresh');
    expect(evaluateFreshness({ category: 'grant_award', evidence: { effectiveAt: '1990-01-01' }, asOf: '2026-09-22' }).state).toBe('fresh');
  });
  it('does not let a recent retrieval refresh a stale status statement', () => {
    expect(evaluateFreshness({ category: 'bill_status', evidence: {
      publishedAt: '2026-01-01', retrievedAt: '2026-09-22',
    }, asOf: '2026-09-22' })).toEqual(expect.objectContaining({ state: 'stale', basis: 'publishedAt' }));
  });
  it('treats a passed opportunity deadline as stale', () => {
    expect(evaluateFreshness({ category: 'grant_opportunity', evidence: { effectiveAt: '2026-09-01' }, asOf: '2026-09-22' }).state).toBe('stale');
  });
});

describe('exact comparison', () => {
  it('normalizes amounts and rounds evidence to claim precision', () => {
    expect(compareExactValues({ claim: 'The request is $42.1M.', evidencePassages: ['$42,140,000 requested.'] }).result).toBe('match');
    expect(compareExactValues({ claim: 'The request is $42M.', evidencePassages: ['$43 million requested.'] }).result).toBe('mismatch');
  });
  it('normalizes dates, fiscal years, stages, bills, and PE identifiers', () => {
    const values = extractExactValues('On September 22, 2026, FY27 HASC marked H.R. 8800 for PE 0601234A.');
    expect(values).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'date', normalized: '2026-09-22' }),
      expect.objectContaining({ kind: 'fiscal_year', normalized: '2027' }),
      expect.objectContaining({ kind: 'funding_stage', normalized: 'hasc' }),
      expect.objectContaining({ kind: 'identifier', normalized: 'HR8800' }),
      expect.objectContaining({ kind: 'identifier', normalized: '0601234A' }),
    ]));
  });
  it('requires both chamber figures only for chamber comparisons', () => {
    const claim = 'House HASC provided $42M versus Senate SASC at $43M.';
    expect(houseSenateComparisonComplete({ claimText: claim, evidence: ['HASC provided $42M.'] })).toBe(false);
    expect(houseSenateComparisonComplete({ claimText: claim, evidence: ['HASC provided $42M.', 'SASC provided $43M.'] })).toBe(true);
  });
});

describe('evaluateClaimDeterministically freshness aggregation', () => {
  const asOf = '2026-09-22';
  const claim = { text: 'H.R. 1 passed the House.', category: 'bill_status' };
  const source = (id: string, dates: { publishedAt?: string; effectiveAt?: string }) => ({
    id, sourceType: 'official', sourceId: id, evidenceClass: 'official_government_data' as const,
    primary: true, authoritative: true, requirementIds: [], ...dates,
  });

  it('keeps a claim fresh while any supporting source is current', () => {
    const result = evaluateClaimDeterministically({
      claim, asOf,
      evidence: [source('old', { publishedAt: '2025-08-01' }), source('current', { effectiveAt: '2026-09-20' })],
    });
    expect(result.freshness).toMatchObject({ state: 'fresh', basis: 'effectiveAt', ageDays: 2 });
  });

  it('marks a claim stale only when no supporting source is fresh', () => {
    expect(evaluateClaimDeterministically({
      claim, asOf, evidence: [source('a', { publishedAt: '2025-08-01' }), source('b', { publishedAt: '2025-01-01' })],
    }).freshness).toMatchObject({ state: 'stale', ageDays: 417 });
    expect(evaluateClaimDeterministically({
      claim, asOf, evidence: [source('a', { publishedAt: '2025-08-01' }), source('b', {})],
    }).freshness.state).toBe('stale');
    expect(evaluateClaimDeterministically({ claim, asOf, evidence: [source('b', {})] }).freshness.state).toBe('unknown');
  });
});
