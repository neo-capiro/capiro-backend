import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ get: vi.fn() }));
const stableApi = { get: mocks.get };

vi.mock('../../lib/use-api.js', () => ({
  useApi: () => stableApi,
}));

import { MeriAnalysisChartCard } from './MeriAnalysisChartCard.js';

const provenance = {
  evidence: 'derived' as const,
  generatedAt: '2026-08-20T10:30:00.000Z',
  datasetCount: 2,
  rowCount: 3,
  datasets: [
    { name: 'HAC-D report', rowCount: 2 },
    { name: 'SAC-D summary', rowCount: 1 },
  ],
};

/** Single-series, non-negative, vertical bar spec — the reference compact shape. */
const barArtifact = {
  id: 'chart-mark-comparison',
  title: 'House and Senate marks · PE 0605053A',
  imageAvailable: true,
  provenance,
  visualization: {
    version: 1 as const,
    chartType: 'bar' as const,
    title: 'House and Senate marks · PE 0605053A',
    xKey: 'stage',
    series: [{ dataKey: 'amount', label: 'Amount', valueFormat: 'currency' as const }],
    data: [
      { stage: 'FY27 request', amount: 192.2 },
      { stage: 'House mark', amount: 210.2 },
      { stage: 'Senate mark', amount: 186 },
    ],
  },
};

const isImageUrl = (url: string) => url.endsWith('/image');

function mockValidBar() {
  mocks.get.mockImplementation((url: string) =>
    isImageUrl(url)
      ? Promise.resolve({ data: new Blob(['png'], { type: 'image/png' }) })
      : Promise.resolve({ data: barArtifact }),
  );
}

describe('MeriAnalysisChartCard — compact reference presentation', () => {
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

  test('renders compact proportional bars with values on top and categories below', async () => {
    mockValidBar();
    render(<MeriAnalysisChartCard artifactId="chart-mark-comparison" title="Fallback" />);

    // Header: title + kind tag, no ANALYSIS eyebrow.
    expect(
      await screen.findByRole('figure', { name: 'House and Senate marks · PE 0605053A' }),
    ).toBeTruthy();
    expect(screen.getByText('BAR')).toBeTruthy();
    expect(screen.queryByText(/ANALYSIS · /)).toBeNull();

    // Compact bar plot: scope to the .meri-acc-bars container (the canonical
    // PNG <img> shares role img + the same accessible name when it exists).
    await waitFor(() => {
      if (!document.querySelector('.meri-acc-bars')) throw new Error('compact bars not rendered');
    });
    const plot = document.querySelector('.meri-acc-bars') as HTMLElement;
    expect(plot).toBeTruthy();
    for (const value of ['$192.2', '$210.2', '$186.0']) {
      expect(screen.getByText(value)).toBeTruthy();
    }
    for (const label of ['FY27 request', 'House mark', 'Senate mark']) {
      expect(screen.getByText(label)).toBeTruthy();
    }

    // Proportional heights inside the fixed plot slot: max (210.2) is 100%,
    // others scale down, and the rendered ratio matches the data ratio.
    const bars = plot.querySelectorAll('.meri-acc-bar');
    expect(bars).toHaveLength(3);
    const heights = Array.from(bars).map((bar) =>
      parseFloat((bar as HTMLElement).style.height),
    );
    expect(heights[1]).toBeCloseTo(100, 0);
    expect(heights[0]).toBeCloseTo((192.2 / 210.2) * 100, 0);
    expect(heights[2]).toBeCloseTo((186 / 210.2) * 100, 0);
    // The plot slot is a fixed height with bars anchored to its bottom edge.
    const slots = plot.querySelectorAll('.meri-acc-bar-plot');
    expect(slots).toHaveLength(3);
    // The max bar carries the metallic gradient; request and Senate are the two
    // distinct reference grays (#D0D5DD and #98A2B3).
    expect((bars[1] as HTMLElement).style.background).toContain('linear-gradient');
    expect((bars[0] as HTMLElement).style.background).toBe('rgb(208, 213, 221)');
    expect((bars[2] as HTMLElement).style.background).toBe('rgb(152, 162, 179)');
  });

  test('a zero value renders a zero-height bar without collapsing the proportion', async () => {
    mocks.get.mockImplementation((url: string) =>
      isImageUrl(url)
        ? Promise.reject(new Error('no image'))
        : Promise.resolve({
            data: {
              ...barArtifact,
              visualization: {
                ...barArtifact.visualization,
                data: [
                  { stage: 'FY27 request', amount: 0 },
                  { stage: 'House mark', amount: 210.2 },
                ],
              },
            },
          }),
    );
    render(<MeriAnalysisChartCard artifactId="chart-mark-comparison" title="Fallback" />);
    await waitFor(() => {
      if (!document.querySelector('.meri-acc-bars')) throw new Error('compact bars not rendered');
    });
    const plot = document.querySelector('.meri-acc-bars') as HTMLElement;
    const bars = plot.querySelectorAll('.meri-acc-bar');
    expect(parseFloat((bars[0] as HTMLElement).style.height)).toBe(0);
    expect(parseFloat((bars[1] as HTMLElement).style.height)).toBeCloseTo(100, 0);
  });

  test('keeps the Data table, CSV download and expand/close capabilities', async () => {
    // Reject the image fetch so the view stays on the chart deterministically
    // (a resolved image would otherwise snap the default view to 'image').
    mocks.get.mockImplementation((url: string) =>
      isImageUrl(url)
        ? Promise.reject(new Error('no image'))
        : Promise.resolve({ data: barArtifact }),
    );
    render(<MeriAnalysisChartCard artifactId="chart-mark-comparison" title="Fallback" />);
    await screen.findByRole('figure', { name: 'House and Senate marks · PE 0605053A' });

    // Data view -> table with the real figures (currency-formatted via the
    // shared formatValue, so assert '$210.2' scoped to the table).
    fireEvent.click(screen.getByRole('button', { name: 'Data' }));
    const table = await screen.findByRole('table');
    expect(table).toBeTruthy();
    expect(table.textContent).toContain('$210.2');
    expect(table.textContent).toContain('$186.0');

    // CSV download is still wired to the shared CSV builder.
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    fireEvent.click(screen.getByTitle('Download data as CSV'));
    expect(clickSpy).toHaveBeenCalled();
    clickSpy.mockRestore();

    // Expand opens the modal dialog; Close returns to the transcript.
    fireEvent.click(screen.getByRole('button', { name: 'Expand chart' }));
    expect(
      screen.getByRole('dialog', { name: 'House and Senate marks · PE 0605053A' }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close expanded chart' }));
    await waitFor(() =>
      expect(
        screen.queryByRole('dialog', { name: 'House and Senate marks · PE 0605053A' }),
      ).toBeNull(),
    );
  });

  test('falls back to Recharts (no compact bars) for negative values', async () => {
    mocks.get.mockImplementation((url: string) =>
      isImageUrl(url)
        ? Promise.reject(new Error('no image'))
        : Promise.resolve({
            data: {
              ...barArtifact,
              visualization: {
                ...barArtifact.visualization,
                data: [
                  { stage: 'FY27 request', amount: 192.2 },
                  { stage: 'Delta', amount: -18 },
                ],
              },
            },
          }),
    );
    render(<MeriAnalysisChartCard artifactId="chart-mark-comparison" title="Fallback" />);
    await screen.findByRole('figure', { name: 'House and Senate marks · PE 0605053A' });
    // Negative data must not be squeezed into the proportional compact plot.
    expect(document.querySelector('.meri-acc-bars')).toBeNull();
  });

  test('keeps the full Recharts renderer when the spec supplies axis labels', async () => {
    mocks.get.mockImplementation((url: string) =>
      isImageUrl(url)
        ? Promise.reject(new Error('no image'))
        : Promise.resolve({
            data: {
              ...barArtifact,
              visualization: {
                ...barArtifact.visualization,
                xAxisLabel: 'Committee position',
                yAxisLabel: 'Funding (USD)',
              },
            },
          }),
    );
    render(<MeriAnalysisChartCard artifactId="chart-mark-comparison" title="Fallback" />);
    await screen.findByRole('figure', { name: 'House and Senate marks · PE 0605053A' });
    // Explicit axis labels need the real axes — the compact plot has nowhere
    // to show them, so the full renderer must be used.
    expect(document.querySelector('.meri-acc-bars')).toBeNull();
  });

  test('keeps the full Recharts renderer for more than six categories', async () => {
    const many = Array.from({ length: 7 }, (_, index) => ({
      stage: `Mark ${index + 1}`,
      amount: 180 + index,
    }));
    mocks.get.mockImplementation((url: string) =>
      isImageUrl(url)
        ? Promise.reject(new Error('no image'))
        : Promise.resolve({
            data: {
              ...barArtifact,
              visualization: { ...barArtifact.visualization, data: many },
            },
          }),
    );
    render(<MeriAnalysisChartCard artifactId="chart-mark-comparison" title="Fallback" />);
    await screen.findByRole('figure', { name: 'House and Senate marks · PE 0605053A' });
    // Seven categories crowd the small card; the full chart handles them.
    expect(document.querySelector('.meri-acc-bars')).toBeNull();
  });

  test('shows the honest unavailable state only after both fetches fail', async () => {
    mocks.get.mockRejectedValue(new Error('unavailable'));
    render(<MeriAnalysisChartCard artifactId="missing" title="Missing chart" />);
    expect(await screen.findByText('ANALYSIS VISUAL UNAVAILABLE')).toBeTruthy();
  });
});
