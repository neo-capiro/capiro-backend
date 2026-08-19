import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, test, vi } from 'vitest';
import { DistrictNexusMapVNext } from './DistrictNexusMapVNext.js';
import type { DistrictNexusDistrictSummary } from '../../../pages/intelligence/district-nexus/district-nexus-api.js';

/**
 * §8.6 fallback contract for the DN page's map: when WebGL is unavailable the
 * page must render the warning banner PLUS the full district table — never a
 * blank canvas. This file deliberately does NOT stub canvas.getContext, so
 * the shared map's real WebGL probe fails exactly as it would in a browser
 * with GL disabled (jsdom implements no GL context). Kept separate from
 * DistrictNexusMapLibre.test.tsx because the probe result is cached at module
 * scope for the process lifetime.
 */

const apiGetMock = vi.fn();
vi.mock('../../../lib/use-api.js', () => ({ useApi: () => ({ get: apiGetMock }) }));

function district(key: string): DistrictNexusDistrictSummary {
  const [state, districtCode] = key.split('-') as [string, string];
  return {
    districtKey: key,
    state,
    districtCode,
    status: 'C',
    name: null,
    awarded: { contractObligations: 1_000_000, grantObligations: null, grantOutlays: null },
    opportunities: { opportunityEstimatedFunding: null, opportunityAwardCeiling: null },
    clientCount: 1,
    score: 42,
    coveragePercent: 55,
    employeeCount: null,
    employeesUnreported: false,
    warnings: [],
  };
}

describe('DistrictNexusMapVNext — boundary/WebGL fallback (§8.6)', () => {
  test('with WebGL unavailable, renders the warning banner and the district table, never a blank canvas', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <DistrictNexusMapVNext
          districts={[district('TX-23'), district('CA-12')]}
          metric="nexus"
          view="current"
          selectedDistrictKey={null}
          onSelectDistrict={vi.fn()}
          showFacilities
          onShowFacilitiesChange={vi.fn()}
          fitToken={null}
        />
      </QueryClientProvider>,
    );

    expect(screen.getByText('Boundary map unavailable.')).toBeTruthy();
    expect(screen.getByText(/WebGL is unavailable in this browser session/)).toBeTruthy();
    expect(screen.getByText(/the map is a view of this data, not its source/)).toBeTruthy();
    // The table fallback carries every district the map would have shown.
    expect(screen.getByText('TX-23')).toBeTruthy();
    expect(screen.getByText('CA-12')).toBeTruthy();
    // Fail-closed on network too: the boundary queries are gated on WebGL.
    expect(apiGetMock).not.toHaveBeenCalled();
  });
});
