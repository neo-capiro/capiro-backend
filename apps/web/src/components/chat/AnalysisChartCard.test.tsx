import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ get: vi.fn() }));

const stableApi = { get: mocks.get };

vi.mock('../../lib/use-api.js', () => ({
  useApi: () => stableApi,
}));

vi.mock('recharts', async () => {
  const React = await import('react');
  const make = (name: string) =>
    function MockChart({ children }: { children?: React.ReactNode }) {
      return <div data-testid={`recharts-${name}`}>{children}</div>;
    };
  return {
    Area: make('area'),
    AreaChart: make('area-chart'),
    Bar: make('bar'),
    BarChart: make('bar-chart'),
    CartesianGrid: make('grid'),
    Cell: make('cell'),
    Line: make('line'),
    LineChart: make('line-chart'),
    Pie: make('pie'),
    PieChart: make('pie-chart'),
    ReferenceLine: make('reference-line'),
    ResponsiveContainer: make('responsive-container'),
    Scatter: make('scatter'),
    ScatterChart: make('scatter-chart'),
    Tooltip: make('tooltip'),
    XAxis: make('x-axis'),
    YAxis: make('y-axis'),
  };
});

import {
  AnalysisChartCard,
  buildAnalysisCsv,
  escapeAnalysisCsvCell,
  neutralizeAnalysisCsvCell,
} from './AnalysisChartCard.js';

const provenance = {
  evidence: 'derived' as const,
  generatedAt: '2026-08-08T10:30:00.000Z',
  datasetCount: 2,
  rowCount: 18,
  datasets: [
    { name: 'Capiro PE funding', rowCount: 14 },
    { name: 'SASC mark', rowCount: 4 },
  ],
};

const lineArtifact = {
  id: 'chart-1',
  title: 'HAC-D sits $22.7M below the FY27 request',
  imageAvailable: true,
  provenance,
  visualization: {
    version: 1 as const,
    chartType: 'line' as const,
    title: 'HAC-D sits $22.7M below the FY27 request',
    insight: 'The Senate position remains at request while HAC-D is lower.',
    description: 'Request and current position by stage.',
    xKey: 'stage',
    series: [
      { dataKey: 'request', label: 'Request', valueFormat: 'currency' as const },
      { dataKey: 'current', label: 'Current', valueFormat: 'currency' as const },
    ],
    data: [
      { stage: 'Request', request: 192.2, current: 192.2 },
      { stage: 'HAC-D', request: 192.2, current: 169.5 },
    ],
  },
};

const isImageUrl = (url: string) => url.endsWith('/image');

describe('AnalysisChartCard', () => {
  beforeEach(() => {
    mocks.get.mockReset();
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      writable: true,
      value: vi.fn(() => 'blob:analysis-chart'),
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      writable: true,
      value: vi.fn(),
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  test('renders the claim, insight, derived/source line, interactive chart, and exact data', async () => {
    mocks.get.mockImplementation((url: string) =>
      isImageUrl(url)
        ? Promise.resolve({ data: new Blob(['png'], { type: 'image/png' }) })
        : Promise.resolve({ data: lineArtifact }),
    );
    render(<AnalysisChartCard artifactId="chart-1" title="Fallback title" />);

    expect(await screen.findByText('HAC-D sits $22.7M below the FY27 request')).toBeTruthy();
    expect(screen.getByText('ANALYSIS · LINE')).toBeTruthy();
    expect(screen.getByText('INSIGHT')).toBeTruthy();
    expect(
      screen.getByText('The Senate position remains at request while HAC-D is lower.'),
    ).toBeTruthy();
    expect(screen.getByText('◆ DERIVED')).toBeTruthy();
    expect(screen.getByText('SOURCE DATA · CAPIRO PE FUNDING · SASC MARK')).toBeTruthy();
    expect(screen.getByText('18 ROWS')).toBeTruthy();
    expect(screen.getByText('SOURCES · SEE MERI CITATIONS')).toBeTruthy();
    expect(screen.getByTestId('recharts-line-chart')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Request/ })).toHaveAttribute('aria-pressed', 'true');
    expect(mocks.get).toHaveBeenCalledWith('/api/clio/analysis-artifacts/chart-1');
    expect(mocks.get).toHaveBeenCalledWith('/api/clio/analysis-artifacts/chart-1/image', {
      responseType: 'blob',
    });

    fireEvent.click(screen.getByRole('button', { name: 'DATA' }));
    expect(screen.getByRole('table')).toBeTruthy();
    expect(screen.getByText('HAC-D')).toBeTruthy();
    expect(screen.getAllByText('$192.2').length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: 'IMAGE' }));
    expect(
      screen.getByRole('img', { name: 'HAC-D sits $22.7M below the FY27 request' }),
    ).toHaveAttribute('src', 'blob:analysis-chart');
  });

  test('falls back calmly to the canonical PNG when no interactive spec is available', async () => {
    mocks.get.mockImplementation((url: string) =>
      isImageUrl(url)
        ? Promise.resolve({ data: new Blob(['png'], { type: 'image/png' }) })
        : Promise.resolve({
            data: {
              id: 'legacy-chart',
              title: 'Legacy analysis chart',
              visualization: null,
              imageAvailable: true,
              provenance: {
                evidence: 'derived',
                generatedAt: '2026-08-08T10:30:00.000Z',
                datasetCount: 0,
                rowCount: 0,
                datasets: [],
              },
            },
          }),
    );
    render(<AnalysisChartCard artifactId="legacy-chart" title="Legacy analysis chart" />);
    expect(await screen.findByRole('img', { name: 'Legacy analysis chart' })).toHaveAttribute(
      'src',
      'blob:analysis-chart',
    );
    expect(
      screen.getByText('INTERACTIVE VIEW UNAVAILABLE · SHOWING SAVED ANALYSIS IMAGE'),
    ).toBeTruthy();
    expect(screen.getByText('SOURCE DATA · AUTHORIZED RETRIEVAL')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'DATA' })).toBeNull();
  });

  test('renders a decision-useful heatmap without relying on the PNG', async () => {
    mocks.get.mockImplementation((url: string) => {
      if (isImageUrl(url)) return Promise.reject(new Error('no image'));
      return Promise.resolve({
        data: {
          id: 'heatmap-1',
          title: 'Appropriations is the highest-exposure portfolio issue',
          imageAvailable: false,
          provenance: {
            evidence: 'derived',
            generatedAt: '2026-08-08T10:30:00.000Z',
            datasetCount: 1,
            rowCount: 2,
            datasets: [{ name: 'Client issue scores', rowCount: 2 }],
          },
          visualization: {
            version: 1,
            chartType: 'heatmap',
            title: 'Appropriations is the highest-exposure portfolio issue',
            heatmap: { rowKey: 'client', columnKey: 'issue', valueKey: 'score' },
            data: [
              { client: 'RTX', issue: 'Appropriations', score: 3 },
              { client: 'Overland AI', issue: 'NDAA', score: 2 },
            ],
          },
        },
      });
    });
    render(<AnalysisChartCard artifactId="heatmap-1" title="Client exposure" />);
    expect(
      await screen.findByRole('table', {
        name: 'Appropriations is the highest-exposure portfolio issue',
      }),
    ).toBeTruthy();
    expect(screen.getByText('Appropriations')).toBeTruthy();
    expect(screen.getByTitle('RTX · Appropriations: 3')).toBeTruthy();
  });

  test('expands into a transient modal surface and closes with Escape', async () => {
    mocks.get.mockImplementation((url: string) =>
      isImageUrl(url)
        ? Promise.resolve({ data: new Blob(['png'], { type: 'image/png' }) })
        : Promise.resolve({ data: lineArtifact }),
    );
    render(<AnalysisChartCard artifactId="chart-1" title="Chart" />);
    await screen.findByText('HAC-D sits $22.7M below the FY27 request');
    fireEvent.click(screen.getByRole('button', { name: 'Expand chart' }));
    expect(
      screen.getByRole('dialog', { name: 'HAC-D sits $22.7M below the FY27 request' }),
    ).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() =>
      expect(
        screen.queryByRole('dialog', { name: 'HAC-D sits $22.7M below the FY27 request' }),
      ).toBeNull(),
    );
  });

  test('shows an honest unavailable state only after both structured and image fetches fail', async () => {
    mocks.get.mockRejectedValue(new Error('unavailable'));
    render(<AnalysisChartCard artifactId="missing" title="Missing chart" />);
    expect(await screen.findByText('ANALYSIS VISUAL UNAVAILABLE')).toBeTruthy();
  });
});

describe('analysis CSV export hardening', () => {
  test.each([
    ['=HYPERLINK("https://evil.example")', '\'=HYPERLINK("https://evil.example")'],
    ['+SUM(1,1)', "'+SUM(1,1)"],
    ['-2+3', "'-2+3"],
    ['@SUM(1,1)', "'@SUM(1,1)"],
    ['\t=1+1', "'\t=1+1"],
    ['\r=1+1', "'\r=1+1"],
    ['  =1+1', "'  =1+1"],
  ])('neutralizes spreadsheet formula strings %j', (input, expected) => {
    expect(neutralizeAnalysisCsvCell(input)).toBe(expected);
  });

  test('does not convert real numeric negatives into strings', () => {
    expect(neutralizeAnalysisCsvCell(-22.7)).toBe('-22.7');
  });

  test('quotes commas, quotes and newlines after formula neutralization', () => {
    expect(escapeAnalysisCsvCell('=SUM(1,2)')).toBe('"\'=SUM(1,2)"');
    expect(escapeAnalysisCsvCell('client "A"')).toBe('"client ""A"""');
  });

  test('builds a formula-safe CSV across untrusted connected-app string cells', () => {
    const csv = buildAnalysisCsv([
      { office: '=CMD()', amount: -22.7, note: '+SUM(1,1)' },
      { office: 'Senate', amount: 10, note: '@IMPORTDATA("x")' },
    ]);
    expect(csv).toContain("'=CMD()");
    expect(csv).toContain('-22.7');
    expect(csv).toContain('"\'+SUM(1,1)"');
    expect(csv).toContain('"\'@IMPORTDATA(""x"")"');
  });
});
