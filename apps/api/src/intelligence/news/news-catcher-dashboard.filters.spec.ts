import {
  buildPolicyQuery,
  normalizeNewsDashboardFilters,
} from './news-catcher-dashboard.service.js';

describe('NewsCatcher dashboard filters', () => {
  it('keeps the original balanced 48h behavior when no filters are supplied', () => {
    const filters = normalizeNewsDashboardFilters();
    expect(filters).toEqual({
      clientIds: [],
      policyTopics: [
        'legislation',
        'hearings',
        'regulation',
        'budget',
        'procurement',
        'grants',
        'state',
        'executive',
      ],
      signalKinds: ['capability', 'issue', 'program', 'alias'],
      customTopics: [],
      lookback: '48h',
    });
    expect(buildPolicyQuery(filters.policyTopics, filters.customTopics)).toContain('Congress');
  });

  it('sanitizes unsupported values and preserves user-selected retrieval controls', () => {
    const filters = normalizeNewsDashboardFilters({
      clientIds: [' client-1 ', 'client-1', 'client-2'],
      policyTopics: ['budget', 'procurement', 'not-real'],
      signalKinds: ['program', 'capability', 'not-real'],
      customTopics: ['Golden Dome', 'Counter-UAS', ''],
      lookback: '7d',
    });

    expect(filters).toEqual({
      clientIds: ['client-1', 'client-2'],
      policyTopics: ['budget', 'procurement'],
      signalKinds: ['program', 'capability'],
      customTopics: ['Golden Dome', 'Counter-UAS'],
      lookback: '7d',
    });

    const query = buildPolicyQuery(filters.policyTopics, filters.customTopics);
    expect(query).toContain('appropriations');
    expect(query).toContain('procurement');
    expect(query).toContain('"Golden Dome"');
    expect(query).not.toContain('Federal Register');
  });

  it('falls back to safe defaults instead of accepting an empty/invalid filter set', () => {
    const filters = normalizeNewsDashboardFilters({
      policyTopics: ['bogus'],
      signalKinds: ['bogus'],
      lookback: 'forever',
    });
    expect(filters.policyTopics).toHaveLength(8);
    expect(filters.signalKinds).toEqual(['capability', 'issue', 'program', 'alias']);
    expect(filters.lookback).toBe('48h');
  });
});
