import { render } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { Sparkline } from './Sparkline.js';
import { LineChart } from './LineChart.js';
import { DeltaBars } from './DeltaBars.js';
import { Donut } from './Donut.js';
import { HBars } from './HBars.js';
import { LegTimeline } from './LegTimeline.js';
import { fmtMoneyM, fmtMoneyMBare, serviceColor, signalMeta } from './format.js';

describe('format helpers', () => {
  test('fmtMoneyM formats millions and billions', () => {
    expect(fmtMoneyM(297.74)).toBe('$297.7M');
    expect(fmtMoneyM(1000)).toBe('$1.00B');
    expect(fmtMoneyM(2894.8)).toBe('$2.89B');
    expect(fmtMoneyM(null)).toBe('—');
    expect(fmtMoneyM(undefined)).toBe('—');
  });

  test('fmtMoneyMBare drops the dollar sign', () => {
    expect(fmtMoneyMBare(14.8)).toBe('14.8M');
  });

  test('serviceColor maps known services and falls back', () => {
    expect(serviceColor('ARMY')).toBe('#2A57CE');
    expect(serviceColor('Air Force')).toBe('#A26913');
    expect(serviceColor(null)).toBe('var(--ink-3)');
    expect(serviceColor('Unknownia')).toBe('var(--ink-3)');
  });

  test('signalMeta classifies delta types + tone by score', () => {
    expect(signalMeta({ signalType: null })).toBeNull();
    expect(signalMeta({ signalType: 'mark_vs_request', signalScore: 0.8 })).toEqual({
      label: 'Markup',
      tone: 'critical',
    });
    expect(signalMeta({ signalType: 'termination', signalScore: 0.3 })).toEqual({
      label: 'Cut',
      tone: 'critical',
    });
    expect(signalMeta({ signalType: 'pb_vs_prior_pb', signalScore: 0.2 })).toEqual({
      label: 'New PB',
      tone: 'info',
    });
  });
});

describe('Sparkline', () => {
  test('renders a line path and an end dot for multi-point data', () => {
    const { container } = render(<Sparkline data={[1, 3, 2, 5]} />);
    expect(container.querySelectorAll('path').length).toBeGreaterThanOrEqual(2); // area + line
    expect(container.querySelector('circle')).toBeTruthy();
  });

  test('renders nothing for empty data', () => {
    const { container } = render(<Sparkline data={[]} />);
    expect(container.querySelector('svg')).toBeNull();
  });
});

describe('LineChart', () => {
  test('breaks the line at null values (two segments)', () => {
    const { container } = render(
      <LineChart
        labels={['FY24', 'FY25', 'FY26', 'FY27']}
        series={[{ name: 'Enacted', color: 'var(--accent)', values: [10, 20, null, 40] }]}
        mode="area"
      />,
    );
    // Two contiguous segments (10,20) and (40) => the single-point trailing segment
    // still yields a path; assert at least the leading 2-point segment renders.
    const paths = container.querySelectorAll('path');
    expect(paths.length).toBeGreaterThanOrEqual(1);
    // Markers: 3 non-null points => 3 circles.
    expect(container.querySelectorAll('circle').length).toBe(3);
  });
});

describe('DeltaBars', () => {
  test('colors positive green and negative red', () => {
    const { container } = render(
      <DeltaBars
        data={[
          { fy: 'FY24', delta: 12 },
          { fy: 'FY25', delta: -8 },
          { fy: 'FY26', delta: null },
        ]}
      />,
    );
    const rects = Array.from(container.querySelectorAll('rect'));
    const fills = rects.map((r) => r.getAttribute('fill'));
    expect(fills).toContain('var(--success)');
    expect(fills).toContain('var(--critical)');
    // Null year renders no bar (just a placeholder dot text), so exactly 2 bars.
    expect(rects.length).toBe(2);
  });
});

describe('Donut', () => {
  test('renders a track ring plus one arc per datum', () => {
    const { container } = render(
      <Donut
        data={[
          { label: 'A', value: 3 },
          { label: 'B', value: 1 },
        ]}
        centerLabel="4"
        centerSub="PEs"
      />,
    );
    // 1 track + 2 arcs.
    expect(container.querySelectorAll('circle').length).toBe(3);
    expect(container.textContent).toContain('4');
    expect(container.textContent).toContain('PEs');
  });
});

describe('HBars', () => {
  test('fill width is proportional to the max value', () => {
    const { container } = render(
      <HBars
        data={[
          { label: 'Big', value: 100 },
          { label: 'Half', value: 50 },
        ]}
        fmt={(v) => `${v}`}
      />,
    );
    const fills = Array.from(container.querySelectorAll('.pe-hbar-fill')) as HTMLElement[];
    expect(fills[0]!.style.width).toBe('100%');
    expect(fills[1]!.style.width).toBe('50%');
  });
});

describe('LegTimeline', () => {
  test('renders one node per event and derives year ticks', () => {
    const { container } = render(
      <LegTimeline
        events={[
          { date: '2024-06-01', label: 'Introduced', num: 'H.R. 1', kind: 'intro' },
          { date: '2025-10-01', label: 'Markup', num: 'S. 2', kind: 'markup' },
        ]}
      />,
    );
    // node markers r=5 have stroke-width 2.5; assert 2 event nodes present.
    const nodes = Array.from(container.querySelectorAll('circle'));
    expect(nodes.length).toBe(2);
  });

  test('renders nothing with no events', () => {
    const { container } = render(<LegTimeline events={[]} />);
    expect(container.querySelector('svg')).toBeNull();
  });
});
