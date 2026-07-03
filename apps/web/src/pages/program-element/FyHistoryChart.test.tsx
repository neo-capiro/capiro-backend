import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { FyHistoryChart, TooltipContent } from './FyHistoryChart.js';
import type { ProgramElementHistoryRow } from './types.js';

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
              enactedSource: 'projected',
              hascSource: 'n/a',
              sascSource: 'n/a',
              hacDSource: 'n/a',
              sacDSource: 'n/a',
              conferenceSource: 'n/a',
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
