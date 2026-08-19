import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { DistrictNexusTableVNext } from './DistrictNexusTableVNext.js';
import type { DistrictNexusDistrictSummary } from '../../../pages/intelligence/district-nexus/district-nexus-api.js';

/** vNext port of DistrictNexusTable.test.tsx — same honest-state contract. */

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

describe('DistrictNexusTableVNext', () => {
  test('renders a district row with its band, score, and formatted money', () => {
    render(<DistrictNexusTableVNext districts={[district()]} selectedDistrictKey={null} onSelectDistrict={vi.fn()} />);
    expect(screen.getByText('TX-23')).toBeTruthy();
    expect(screen.getByText('Moderate')).toBeTruthy();
    expect(screen.getByText('$4.8M')).toBeTruthy();
  });

  test('a null score renders as "Unscored", never as "Minimal" or 0', () => {
    render(
      <DistrictNexusTableVNext districts={[district({ score: null })]} selectedDistrictKey={null} onSelectDistrict={vi.fn()} />,
    );
    expect(screen.getByText('Unscored')).toBeTruthy();
    expect(screen.queryByText('Minimal')).toBeNull();
  });

  test('clicking a row calls onSelectDistrict with its key', () => {
    const onSelect = vi.fn();
    render(<DistrictNexusTableVNext districts={[district()]} selectedDistrictKey={null} onSelectDistrict={onSelect} />);
    screen.getByText('TX-23').closest('tr')!.click();
    expect(onSelect).toHaveBeenCalledWith('TX-23');
  });

  test('an empty district list explains itself rather than looking broken', () => {
    render(<DistrictNexusTableVNext districts={[]} selectedDistrictKey={null} onSelectDistrict={vi.fn()} />);
    expect(screen.getByText(/No districts match these filters/)).toBeTruthy();
  });

  test('null employeeCount with employeesUnreported renders "n/r", not 0 or a blank', () => {
    render(
      <DistrictNexusTableVNext
        districts={[district({ employeeCount: null, employeesUnreported: true })]}
        selectedDistrictKey={null}
        onSelectDistrict={vi.fn()}
      />,
    );
    expect(screen.getByText('n/r')).toBeTruthy();
  });

  test('sorting by Nexus places null scores below every real value, ascending first', () => {
    const districts = [
      district({ districtKey: 'TX-23', score: 42 }),
      district({ districtKey: 'WY-00', score: null }),
      district({ districtKey: 'VA-10', score: 88 }),
    ];
    render(<DistrictNexusTableVNext districts={districts} selectedDistrictKey={null} onSelectDistrict={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Nexus/ }));
    const keys = screen.getAllByText(/^(TX-23|WY-00|VA-10)$/).map((el) => el.textContent);
    expect(keys).toEqual(['WY-00', 'TX-23', 'VA-10']);
  });

  test('the selected row is visibly marked', () => {
    render(<DistrictNexusTableVNext districts={[district()]} selectedDistrictKey="TX-23" onSelectDistrict={vi.fn()} />);
    expect(screen.getByText('TX-23').closest('tr')!.className).toContain('dnx-row-selected');
  });
});
