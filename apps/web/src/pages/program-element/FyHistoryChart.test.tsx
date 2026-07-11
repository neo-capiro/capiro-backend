import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { FyHistoryChart, TooltipContent, toChartPoint } from './FyHistoryChart.js';
import type { ProgramElementHistoryRow } from './types.js';

/** Sparse history row; `?? null` keeps an explicit 0 (E-7 FY27 request=0). */
function row(fy: number, f: Partial<ProgramElementHistoryRow>): ProgramElementHistoryRow {
  return {
    id: `y${fy}`,
    fy,
    request: f.request ?? null,
    hascMark: f.hascMark ?? null,
    sascMark: f.sascMark ?? null,
    hacDMark: f.hacDMark ?? null,
    sacDMark: f.sacDMark ?? null,
    conference: f.conference ?? null,
    enacted: f.enacted ?? null,
    projectedEnacted: f.enacted == null,
    sourceAttribution: {},
  };
}

const fiveYears: ProgramElementHistoryRow[] = [
  {
    id: 'y1',
    fy: 2023,
    request: 220,
    hascMark: 230,
    sascMark: 228,
    hacDMark: 229,
    sacDMark: 227,
    conference: 229,
    enacted: 228.5,
    projectedEnacted: false,
    sourceAttribution: {
      request: 'rdoc',
      hascMark: 'hasc',
      sascMark: 'sasc',
      hacDMark: 'hacd',
      sacDMark: 'sacd',
      conference: 'conf',
      enacted: 'enacted',
    },
  },
  {
    id: 'y2',
    fy: 2024,
    request: 240,
    hascMark: 245,
    sascMark: 244,
    hacDMark: 243,
    sacDMark: 242,
    conference: 243,
    enacted: 242,
    projectedEnacted: false,
    sourceAttribution: {
      request: 'rdoc',
      hascMark: 'hasc',
      sascMark: 'sasc',
      hacDMark: 'hacd',
      sacDMark: 'sacd',
      conference: 'conf',
      enacted: 'enacted',
    },
  },
  {
    id: 'y3',
    fy: 2025,
    request: 255,
    hascMark: 258,
    sascMark: 257,
    hacDMark: 256,
    sacDMark: 255.5,
    conference: 256,
    enacted: 255,
    projectedEnacted: false,
    sourceAttribution: {
      request: 'rdoc',
      hascMark: 'hasc',
      sascMark: 'sasc',
      hacDMark: 'hacd',
      sacDMark: 'sacd',
      conference: 'conf',
      enacted: 'enacted',
    },
  },
  {
    id: 'y4',
    fy: 2026,
    request: 266,
    hascMark: 269,
    sascMark: 268,
    hacDMark: 267,
    sacDMark: 266,
    conference: 267,
    enacted: 266.5,
    projectedEnacted: false,
    sourceAttribution: {
      request: 'rdoc',
      hascMark: 'hasc',
      sascMark: 'sasc',
      hacDMark: 'hacd',
      sacDMark: 'sacd',
      conference: 'conf',
      enacted: 'enacted',
    },
  },
  {
    id: 'y5',
    fy: 2027,
    request: 278.5,
    hascMark: null,
    sascMark: null,
    hacDMark: null,
    sacDMark: null,
    conference: null,
    enacted: null,
    projectedEnacted: true,
    sourceAttribution: {
      request: 'rdoc',
      conference: 'n/a',
      enacted: 'projected',
    },
  },
];

describe('FyHistoryChart', () => {
  test('renders with 5 FYs', () => {
    render(<FyHistoryChart rows={fiveYears} />);
    expect(screen.getByText(/Funding timeline/i)).toBeInTheDocument();
    // Realization-rate label copy: "Realization rate (5y) +X.X% over request"
    // (renamed from "Win rate" per the consolidated plan §4 guardrail — a budget
    // line's request→enacted delta must not read like a sales metric; split across nodes)
    expect(screen.getByTestId('pe-win-rate-label')).toHaveTextContent(/Realization rate \(5y\)/i);
    expect(screen.getByTestId('pe-win-rate-label')).toHaveTextContent(/over request/i);
    // Chart legend
    expect(screen.getByText('Request')).toBeInTheDocument();
    expect(screen.getByText('Enacted')).toBeInTheDocument();
    expect(screen.getByText('Pending')).toBeInTheDocument();
  });

  test('empty state', () => {
    render(<FyHistoryChart rows={[]} />);
    expect(screen.getByText(/No FY history yet/i)).toBeInTheDocument();
  });

  test('onFyClick fires', async () => {
    const onFyClick = vi.fn();
    render(<FyHistoryChart rows={fiveYears} onFyClick={onFyClick} />);

    fireEvent.click(screen.getByRole('button', { name: /Select latest FY/i }));

    await waitFor(() => {
      expect(onFyClick).toHaveBeenCalled();
    });
  });

  test('tooltip shows all marks with source attribution', () => {
    render(
      <TooltipContent
        active
        payload={[
          {
            payload: {
              fy: 2027,
              request: 278.5,
              enacted: 278.5,
              funding: 278.5,
              fundingStage: 'Pending',
              projected: true,
              requestSource: 'rdoc',
              hascMark: null,
              sascMark: null,
              hacDMark: null,
              sacDMark: null,
              conference: null,
              ndaaConference: null,
              enactedSource: 'projected',
              hascSource: 'n/a',
              sascSource: 'n/a',
              hacDSource: 'n/a',
              sacDSource: 'n/a',
              conferenceSource: 'n/a',
              ndaaConferenceSource: 'n/a',
              rawEnacted: null,
            },
          },
        ]}
      />,
    );

    expect(screen.getByText(/FY 2027/i)).toBeInTheDocument();
    expect(screen.getByText(/Request/i)).toBeInTheDocument();
    expect(screen.getByText(/HASC/i)).toBeInTheDocument();
    expect(screen.getByText(/SASC/i)).toBeInTheDocument();
    expect(screen.getByText(/HAC-D/i)).toBeInTheDocument();
    expect(screen.getByText(/SAC-D/i)).toBeInTheDocument();
    expect(screen.getByText(/Conference/i)).toBeInTheDocument();
    expect(screen.getByText(/Enacted \(Projected\)/i)).toBeInTheDocument();
    expect(screen.getByText(/\[rdoc\]/i)).toBeInTheDocument();
    expect(screen.getByText(/\[projected\]/i)).toBeInTheDocument();
  });
});

describe('toChartPoint — shared funding-model precedence', () => {
  test('committee mark drives the bar when nothing final exists (E-7 FY27 shape)', () => {
    // Real E-7 FY27: request 0, SASC 1500, HAC-D 1549.1. The old blend showed $0.
    const p = toChartPoint(row(2027, { request: 0, sascMark: 1500, hacDMark: 1549.1 }));
    expect(p.funding).toBeCloseTo(1549.1, 2);
    expect(p.fundingStage).toBe('Committee');
  });

  test('conference outranks committee marks (Sentinel FY26 shape)', () => {
    const p = toChartPoint(
      row(2026, { request: 2647.56, hascMark: 3047.56, sascMark: 4647.56, conference: 3847.56 }),
    );
    expect(p.funding).toBeCloseTo(3847.56, 2);
    expect(p.fundingStage).toBe('Conference');
  });

  test('enacted wins → Enacted', () => {
    const p = toChartPoint(row(2025, { request: 3721.02, enacted: 2011.02, hascMark: 3721.02 }));
    expect(p.funding).toBeCloseTo(2011.02, 2);
    expect(p.fundingStage).toBe('Enacted');
  });

  test('request-only year → Requested', () => {
    const p = toChartPoint(row(2028, { request: 3261.2 }));
    expect(p.funding).toBeCloseTo(3261.2, 2);
    expect(p.fundingStage).toBe('Requested');
  });

  test('empty year → Pending, funding 0', () => {
    const p = toChartPoint(row(2030, {}));
    expect(p.funding).toBe(0);
    expect(p.fundingStage).toBe('Pending');
  });
});
