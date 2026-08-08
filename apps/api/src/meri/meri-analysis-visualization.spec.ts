import {
  analysisResultsWithoutVisualizations,
  analysisVisualizationCandidatesFromResults,
  sanitizeAnalysisVisualization,
  sanitizeAnalysisVisualizations,
  visualizationsFromAnalysisResults,
} from './meri-analysis-visualization.js';

describe('Meri analysis visualization contract', () => {
  test('accepts a bounded line chart, insight, and strips unknown row values', () => {
    const spec = sanitizeAnalysisVisualization({
      version: 999,
      chartType: 'line',
      title: 'HAC-D sits $22.7M below the FY27 request',
      insight: 'The Senate position remains at request while HAC-D is 11.8% lower.',
      xKey: 'stage',
      series: [{ dataKey: 'amount', label: 'Funding', valueFormat: 'currency' }],
      data: [
        { stage: 'Request', amount: 192.2, ignored: { nested: true } },
        { stage: 'HAC-D', amount: 169.5 },
      ],
      javascript: 'alert(1)',
    });

    expect(spec).toEqual({
      version: 1,
      chartType: 'line',
      title: 'HAC-D sits $22.7M below the FY27 request',
      insight: 'The Senate position remains at request while HAC-D is 11.8% lower.',
      xKey: 'stage',
      series: [{ dataKey: 'amount', label: 'Funding', valueFormat: 'currency' }],
      data: [
        { stage: 'Request', amount: 192.2 },
        { stage: 'HAC-D', amount: 169.5 },
      ],
    });
  });

  test('accepts government-affairs waterfall, heatmap, timeline and pie shapes', () => {
    expect(
      sanitizeAnalysisVisualization({
        chartType: 'waterfall',
        title: 'House marks erase $22.7M from the FY27 request',
        xKey: 'stage',
        series: [{ dataKey: 'delta', label: 'Change' }],
        data: [
          { stage: 'Request', delta: 192.2 },
          { stage: 'HASC', delta: -10 },
          { stage: 'HAC-D', delta: -12.7 },
        ],
      })?.chartType,
    ).toBe('waterfall');

    expect(
      sanitizeAnalysisVisualization({
        chartType: 'heatmap',
        title: 'Appropriations is the highest-exposure issue across the portfolio',
        heatmap: { rowKey: 'client', columnKey: 'issue', valueKey: 'score' },
        data: [{ client: 'RTX', issue: 'Appropriations', score: 3 }],
      })?.heatmap,
    ).toEqual({ rowKey: 'client', columnKey: 'issue', valueKey: 'score' });

    expect(
      sanitizeAnalysisVisualization({
        chartType: 'timeline',
        title: 'Three client decisions converge before the September deadline',
        timeline: { labelKey: 'event', startKey: 'date', groupKey: 'lane' },
        data: [{ event: 'HAC-D markup', date: '2026-08-12', lane: 'Appropriations' }],
      })?.timeline?.labelKey,
    ).toBe('event');

    expect(
      sanitizeAnalysisVisualization({
        chartType: 'pie',
        title: 'Army programs account for most of verified exposure',
        nameKey: 'service',
        valueKey: 'amount',
        data: [
          { service: 'Army', amount: 50 },
          { service: 'Navy', amount: 30 },
        ],
      })?.nameKey,
    ).toBe('service');
  });

  test('fails closed on malformed, mixed-type, or unsupported quantitative specs', () => {
    expect(
      sanitizeAnalysisVisualization({ chartType: 'javascript', title: 'No', data: [] }),
    ).toBeNull();
    expect(
      sanitizeAnalysisVisualization({
        chartType: 'line',
        title: 'Missing series',
        xKey: 'year',
        data: [{ year: 2026, amount: 1 }],
      }),
    ).toBeNull();
    expect(
      sanitizeAnalysisVisualization({
        chartType: 'bar',
        title: 'All values accidentally formatted as prose',
        xKey: 'name',
        series: [{ dataKey: 'value' }],
        data: [{ name: 'A', value: '$10 million' }],
      }),
    ).toBeNull();
    expect(
      sanitizeAnalysisVisualization({
        chartType: 'bar',
        title: 'A single numeric row cannot legitimize prose values',
        xKey: 'name',
        series: [{ dataKey: 'value' }],
        data: [
          { name: 'A', value: 10 },
          { name: 'B', value: '$20M' },
        ],
      }),
    ).toBeNull();
    expect(
      sanitizeAnalysisVisualization({
        chartType: 'scatter',
        title: 'Scatter x must be numeric',
        xKey: 'agency',
        series: [{ dataKey: 'amount' }],
        data: [{ agency: 'Army', amount: 1 }],
      }),
    ).toBeNull();
    expect(
      sanitizeAnalysisVisualization({
        chartType: 'waterfall',
        title: 'Two series not allowed',
        xKey: 'stage',
        series: [{ dataKey: 'a' }, { dataKey: 'b' }],
        data: [{ stage: 'PB', a: 1, b: 2 }],
      }),
    ).toBeNull();
  });

  test('rejects negative, zero-total, and prose pie slices', () => {
    const base = {
      chartType: 'pie',
      title: 'Exposure by service',
      nameKey: 'service',
      valueKey: 'amount',
    };
    expect(
      sanitizeAnalysisVisualization({
        ...base,
        data: [
          { service: 'Army', amount: 10 },
          { service: 'Navy', amount: -1 },
        ],
      }),
    ).toBeNull();
    expect(
      sanitizeAnalysisVisualization({
        ...base,
        data: [
          { service: 'Army', amount: 0 },
          { service: 'Navy', amount: 0 },
        ],
      }),
    ).toBeNull();
    expect(
      sanitizeAnalysisVisualization({
        ...base,
        data: [
          { service: 'Army', amount: 10 },
          { service: 'Navy', amount: '20' },
        ],
      }),
    ).toBeNull();
  });

  test('requires unambiguous ISO dates for timeline sorting', () => {
    const base = {
      chartType: 'timeline',
      title: 'Decision calendar',
      timeline: { labelKey: 'event', startKey: 'start', endKey: 'end' },
    };
    expect(
      sanitizeAnalysisVisualization({
        ...base,
        data: [
          { event: 'Hearing', start: '2026-08-12', end: '2026-08-12T15:00:00Z' },
          { event: 'Deadline', start: '2026-08-20', end: null },
        ],
      })?.timeline,
    ).toEqual({ labelKey: 'event', startKey: 'start', endKey: 'end' });
    expect(
      sanitizeAnalysisVisualization({
        ...base,
        data: [{ event: 'Ambiguous', start: 'August 12', end: 'next week' }],
      }),
    ).toBeNull();
    expect(
      sanitizeAnalysisVisualization({
        ...base,
        data: [{ event: 'Impossible', start: '2026-99-99', end: null }],
      }),
    ).toBeNull();
  });

  test('caps visual count and reads either results.visuals or results.__visuals', () => {
    const visual = {
      chartType: 'bar',
      title: 'The top program drives the ranking',
      xKey: 'name',
      series: [{ dataKey: 'value' }],
      data: [{ name: 'A', value: 1 }],
    };
    expect(sanitizeAnalysisVisualizations(Array.from({ length: 10 }, () => visual))).toHaveLength(
      6,
    );
    expect(visualizationsFromAnalysisResults({ visuals: [visual] })).toHaveLength(1);
    expect(visualizationsFromAnalysisResults({ __visuals: [visual] })).toHaveLength(1);
  });

  test('preserves raw candidate indexes even when an earlier visual is invalid', () => {
    const valid = {
      chartType: 'bar',
      title: 'The valid second chart stays paired to the second image',
      xKey: 'name',
      series: [{ dataKey: 'value' }],
      data: [{ name: 'A', value: 1 }],
    };
    const candidates = analysisVisualizationCandidatesFromResults({
      visuals: [{ chartType: 'javascript', title: 'Invalid first chart' }, valid],
    });
    expect(candidates).toHaveLength(2);
    expect(sanitizeAnalysisVisualization(candidates[0])).toBeNull();
    expect(sanitizeAnalysisVisualization(candidates[1])?.title).toBe(
      'The valid second chart stays paired to the second image',
    );
  });

  test('removes visual payloads from model-facing results without mutating findings/table', () => {
    const input = {
      findings: { topRisk: 'PE 0604201A' },
      table: [{ pe: '0604201A', delta: -22.7 }],
      visuals: [{ chartType: 'bar', data: Array.from({ length: 500 }, () => ({ value: 1 })) }],
      __visuals: [{ legacy: true }],
    };
    expect(analysisResultsWithoutVisualizations(input)).toEqual({
      findings: { topRisk: 'PE 0604201A' },
      table: [{ pe: '0604201A', delta: -22.7 }],
    });
    expect(input).toHaveProperty('visuals');
  });
});
