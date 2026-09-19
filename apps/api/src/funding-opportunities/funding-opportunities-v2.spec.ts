import { describe, expect, test } from '@jest/globals';
import { normalizeOpportunitySearchCriteria } from '@capiro/shared';

describe('Funding Opportunities v2 search criteria', () => {
  test('round-trips every typed filter group, multi-lifecycle, relative deadline, query, mode, and client', () => {
    const result = normalizeOpportunitySearchCriteria({
      mode: 'all', clientId: ' client-1 ', query: '  turbofan   engine  ', queryMatch: 'keywords',
      sources: ['sam_gov', 'agency_forecast'], types: ['grant', 'solicitation'],
      lifecycle: ['active', 'forecast', 'closed'], agencies: [' Department of Defense '], sectors: ['defense'],
      posted: ['last_30_days'], geography: ['TX', 'nationwide'], applicantTypes: ['small businesses'],
      funding: ['grant_program'], costShare: ['required'], methods: ['competitive'], disbursement: ['milestone'],
      grantPrerequisites: ['uei'], setAsideCodes: ['sdvosbc'], naicsCodes: ['336411', ' 336411 '],
      pscCodes: [' 1560 '], codes: ['541715', 'psc:1560'], eligibility: ['unknown'], deadlineWindow: '90d',
      deadlineFrom: '2026-01-01', deadlineTo: '2026-12-31', sort: 'relevance', direction: 'desc', page: 0, pageSize: 1000,
    });
    expect(result.warnings).toEqual([]);
    expect(result.criteria).toMatchObject({
      schemaVersion: 2, mode: 'all', clientId: 'client-1', query: 'turbofan engine', queryMatch: 'keywords',
      sources: ['sam_gov', 'agency_forecast'], types: ['grant', 'solicitation'], lifecycle: ['active', 'forecast', 'closed'],
      posted: ['last_30_days'], geography: ['TX', 'nationwide'], applicantTypes: ['small businesses'], funding: ['grant_program'],
      costShare: ['required'], methods: ['competitive'], disbursement: ['milestone'], grantPrerequisites: ['uei'],
      setAsideCodes: ['SDVOSBC'], naicsCodes: ['336411'], pscCodes: ['1560'], codes: ['541715', 'PSC:1560'],
      deadlineWindow: '90d', page: 1, pageSize: 100, sort: 'relevance', direction: 'desc',
    });
  });

  test('keeps queryMatch omitted for legacy criteria and rejects invalid explicit modes', () => {
    const legacy = normalizeOpportunitySearchCriteria({ query: 'autonomous ground vehicle' });
    expect(legacy.criteria).not.toHaveProperty('queryMatch');
    expect(normalizeOpportunitySearchCriteria({ query: 'autonomous ground vehicle', queryMatch: 'phrase' }).criteria.queryMatch)
      .toBe('phrase');
    const invalid = normalizeOpportunitySearchCriteria({ queryMatch: 'semantic' });
    expect(invalid.criteria).not.toHaveProperty('queryMatch');
    expect(invalid.warnings).toContainEqual({ key: 'queryMatch', reason: 'invalid' });
  });

  test('bounds only explicit query modes and leaves legacy query inputs unchanged', () => {
    const longQuery = normalizeOpportunitySearchCriteria({ query: 'x'.repeat(513), queryMatch: 'phrase' });
    expect(longQuery.warnings).toContainEqual({ key: 'query', reason: 'invalid' });
    const tooManyTerms = normalizeOpportunitySearchCriteria({ query: Array.from({ length: 21 }, (_, i) => `term${i}`).join(' '), queryMatch: 'keywords' });
    expect(tooManyTerms.warnings).toContainEqual({ key: 'query', reason: 'invalid' });
    const legacy = normalizeOpportunitySearchCriteria({ query: 'x'.repeat(513) });
    expect(legacy.warnings).toEqual([]);
    expect(legacy.criteria.query).toHaveLength(513);
  });

  test('permits an empty query and preserves unsupported keys and invalid enum values as warnings', () => {
    const result = normalizeOpportunitySearchCriteria({ query: '   ', mode: 'matched', clientId: null, retiredTab: 'triage', lifecycle: ['active', 'retired'] });
    expect(result.criteria.query).toBe('');
    expect(result.criteria.lifecycle).toEqual(['active']);
    expect(result.warnings).toEqual(expect.arrayContaining([
      { key: 'retiredTab', reason: 'unsupported' },
      { key: 'lifecycle:retired', reason: 'invalid' },
    ]));
    expect(result.unsupported).toEqual({ retiredTab: 'triage' });
  });
});
