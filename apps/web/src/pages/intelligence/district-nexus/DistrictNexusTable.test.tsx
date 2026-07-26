import { render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { DistrictNexusTable } from './DistrictNexusTable.js';
import type { DistrictNexusDistrictSummary } from './district-nexus-api.js';

// antd's Table subscribes to matchMedia (responsive breakpoints) on mount —
// jsdom doesn't implement it. Repo precedent: ProgramElementWatchPage.test.tsx.
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

function district(overrides: Partial<DistrictNexusDistrictSummary> = {}): DistrictNexusDistrictSummary {
  return {
    districtKey: 'TX-23',
    state: 'TX',
    districtCode: '23',
    status: 'C',
    name: 'Texas 23rd',
    awarded: { contractObligations: 4_800_000, grantObligations: 0, grantOutlays: 0 },
    opportunities: { opportunityEstimatedFunding: null, opportunityAwardCeiling: null },
    clientCount: 1,
    score: 42,
    coveragePercent: 55,
    employeeCount: null,
    employeesUnreported: false,
    warnings: [],
    ...overrides,
  };
}

describe('DistrictNexusTable', () => {
  test('renders a district row with its band, score, and formatted money', () => {
    render(<DistrictNexusTable districts={[district()]} selectedDistrictKey={null} onSelectDistrict={vi.fn()} />);
    expect(screen.getByText('TX-23')).toBeTruthy();
    expect(screen.getByText('Moderate')).toBeTruthy();
    expect(screen.getByText('$4.8M')).toBeTruthy();
  });

  test('a null score renders as "Unscored", never as "Minimal" or 0', () => {
    render(<DistrictNexusTable districts={[district({ score: null })]} selectedDistrictKey={null} onSelectDistrict={vi.fn()} />);
    expect(screen.getByText('Unscored')).toBeTruthy();
    expect(screen.queryByText('Minimal')).toBeNull();
  });

  test('clicking a row calls onSelectDistrict with its key', () => {
    const onSelect = vi.fn();
    render(<DistrictNexusTable districts={[district()]} selectedDistrictKey={null} onSelectDistrict={onSelect} />);
    screen.getByText('TX-23').closest('tr')!.click();
    expect(onSelect).toHaveBeenCalledWith('TX-23');
  });

  test('an empty district list explains itself rather than looking broken', () => {
    render(<DistrictNexusTable districts={[]} selectedDistrictKey={null} onSelectDistrict={vi.fn()} />);
    expect(screen.getByText(/No districts match these filters/)).toBeTruthy();
  });

  test('null employeeCount with employeesUnreported renders "n/r", not 0 or a blank', () => {
    render(
      <DistrictNexusTable
        districts={[district({ employeeCount: null, employeesUnreported: true })]}
        selectedDistrictKey={null}
        onSelectDistrict={vi.fn()}
      />,
    );
    expect(screen.getByText('n/r')).toBeTruthy();
  });
});
