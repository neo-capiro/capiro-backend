import type { ReactNode } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, test, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DistrictNexusSection } from './DistrictNexusSection.js';

/**
 * REGRESSION (2026-07-10, Wave-2 closure / W2.2): both the district-nexus query
 * and the representation query must render a DISTINCT error state on a failed
 * fetch — never fall through to the "No federal contractor linked yet" empty
 * state (which would wrongly tell the user to go map a contractor) or to
 * rendering nothing (indistinguishable from "this client has no facilities").
 * These pin the isError branches added in W2.2 so a future ternary reorder that
 * regresses error→empty is caught.
 */

vi.mock('react-router-dom', () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
}));
vi.mock('../../../../lib/use-api.js', () => ({ useApi: () => ({ get: vi.fn() }) }));

const getNexusMock = vi.fn();
const getRepMock = vi.fn();
vi.mock('../district-nexus-api.js', () => ({
  getClientDistrictNexus: (...args: unknown[]) => getNexusMock(...args),
}));
vi.mock('../representation-api.js', () => ({
  getClientRepresentation: (...args: unknown[]) => getRepMock(...args),
}));

function renderSection() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <DistrictNexusSection clientId="abc" />
    </QueryClientProvider>,
  );
}

describe('DistrictNexusSection error states (W2.2)', () => {
  beforeEach(() => {
    getNexusMock.mockReset();
    getRepMock.mockReset();
  });

  test('a district-nexus fetch error shows a distinct error notice, NOT the "no contractor linked" empty state', async () => {
    getNexusMock.mockRejectedValue(new Error('boom'));
    getRepMock.mockResolvedValue([]);
    renderSection();
    await waitFor(() => expect(screen.getByText(/Couldn't load district nexus/i)).toBeTruthy());
    // The failure must NOT be misrepresented as "you haven't mapped a contractor".
    expect(screen.queryByText(/No federal contractor linked yet/i)).toBeNull();
  });

  test('a representation fetch error shows the representatives error notice (not silent nothing)', async () => {
    getNexusMock.mockResolvedValue({ linked: false });
    getRepMock.mockRejectedValue(new Error('boom'));
    renderSection();
    await waitFor(() =>
      expect(screen.getByText(/Couldn't load this client's representatives/i)).toBeTruthy(),
    );
  });
});
