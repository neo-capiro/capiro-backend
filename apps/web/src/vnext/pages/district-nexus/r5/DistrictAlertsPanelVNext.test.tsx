/**
 * Vitest for DistrictAlertsPanelVNext - flag-gate behavior.
 *
 * Run: cd apps/web && node ../../node_modules/vitest/vitest.mjs run src/vnext/pages/district-nexus/r5/DistrictAlertsPanelVNext.test.tsx
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import React from 'react';

// Mock the API hook
vi.mock('../../../../lib/use-api.js', () => ({
  useApi: () => ({ get: vi.fn() }),
}));

// Mock feature flags
const mockFeatureFlags: Record<string, boolean> = {};
vi.mock('../../../../lib/intel-feature-flags.js', () => ({
  useIntelFeatureEnabled: (feature: string) => Boolean(mockFeatureFlags[feature]),
  useIntelFeature: (feature: string) => ({
    enabled: Boolean(mockFeatureFlags[feature]),
    ready: true,
  }),
}));

// Mock feedback components
vi.mock('../../../../components/feedback/index.js', () => ({
  CapiroSkeleton: ({ height, width }: any) =>
    React.createElement('div', { 'data-testid': 'skeleton', style: { height, width } }),
  CapiroErrorState: ({ title }: any) =>
    React.createElement('div', { 'data-testid': 'error' }, title),
}));

// Mock icons
vi.mock('../icons.js', () => ({
  DnxWarningIcon: () => React.createElement('span', { 'data-testid': 'warning-icon' }, '!'),
}));

// Mock r5-api
vi.mock('./r5-api.js', () => ({
  getDistrictNexusAlerts: vi.fn().mockResolvedValue([]),
  DISTRICT_NEXUS_R5_ALERTS_FEATURE: 'district_nexus_r5_alerts',
}));

import { DistrictAlertsPanelVNext } from './DistrictAlertsPanelVNext';

function renderWithQuery(ui: React.ReactElement) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    React.createElement(QueryClientProvider, { client: qc }, ui),
  );
}

describe('DistrictAlertsPanelVNext', () => {
  beforeEach(() => {
    Object.keys(mockFeatureFlags).forEach((k) => delete mockFeatureFlags[k]);
  });

  it('renders nothing when flag is off', () => {
    mockFeatureFlags['district_nexus_r5_alerts'] = false;
    const { container } = renderWithQuery(
      React.createElement(DistrictAlertsPanelVNext, {
        clientId: 'test-client',
        state: 'TX',
        districtNo: '23',
      }),
    );
    expect(container.innerHTML).toBe('');
  });

  it('renders loading state when flag is on but data is pending', () => {
    mockFeatureFlags['district_nexus_r5_alerts'] = true;
    renderWithQuery(
      React.createElement(DistrictAlertsPanelVNext, {
        clientId: 'test-client',
        state: 'TX',
        districtNo: '23',
      }),
    );
    // Skeleton is rendered while loading
    expect(screen.getByTestId('skeleton')).toBeTruthy();
  });
});