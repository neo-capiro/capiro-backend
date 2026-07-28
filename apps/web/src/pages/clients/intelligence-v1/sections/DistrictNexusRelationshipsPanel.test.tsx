import { App as AntApp } from 'antd';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { DistrictNexusRelationshipsPanel } from './DistrictNexusRelationshipsPanel.js';
import type {
  DistrictNexusAssistanceAwardOption,
  DistrictNexusRelationshipRecord,
} from '../district-nexus-relationships-api.js';

/**
 * The reviewed-grant-relationship panel is the ONLY entry point for the seven
 * award-bearing relationship types, so its honest-state behaviour is
 * load-bearing rather than cosmetic. These pin the five properties the closeout
 * requires:
 *
 *   1. permissions      — a reader must not see any mutation affordance
 *   2. failed vs empty  — a failed request must never render as "none on file"
 *   3. review states    — verified / unverified / rejected are distinguishable,
 *                         and a rejected row is soft-state, not a deletion
 *   4. null money       — a null attributable amount renders as an em dash and
 *                         never as $0 (the Money-type contract)
 *   5. cache            — a mutation invalidates every surface that consumes
 *                         the score this evidence feeds
 */

function setupAntdBrowserMocks() {
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
  class ResizeObserverMock {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal('ResizeObserver', ResizeObserverMock);
}

vi.mock('../../../../lib/use-api.js', () => ({ useApi: () => ({}) }));

const listMock = vi.fn();
const searchMock = vi.fn();
const createMock = vi.fn();
const updateMock = vi.fn();
const rejectMock = vi.fn();

// A vi.mock factory replaces the WHOLE module namespace, so the const the
// component imports for its type <Select> has to be re-exported here too.
vi.mock('../district-nexus-relationships-api.js', () => ({
  DISTRICT_NEXUS_AWARD_RELATIONSHIP_TYPES: [
    'direct_recipient',
    'subrecipient',
    'project_site',
    'research_partner',
    'coalition_partner',
    'beneficiary',
    'matching_contributor',
  ],
  getDistrictNexusRelationships: (...args: unknown[]) => listMock(...args),
  searchDistrictNexusAssistanceAwards: (...args: unknown[]) => searchMock(...args),
  createDistrictNexusRelationship: (...args: unknown[]) => createMock(...args),
  updateDistrictNexusRelationship: (...args: unknown[]) => updateMock(...args),
  rejectDistrictNexusRelationship: (...args: unknown[]) => rejectMock(...args),
}));

const AWARD: DistrictNexusAssistanceAwardOption = {
  id: 'award-1',
  awardUniqueId: 'ASST_NON_123',
  fain: 'FAIN-123',
  recipientName: 'Example Research University',
  recipientUei: 'ABC123DEF456',
  assistanceListingNumber: '12.345',
  assistanceListingTitle: 'Example Program',
  awardingAgency: 'Department of Example',
  totalObligatedAmount: 1_000_000,
  totalOutlayedAmount: 250_000,
  startDate: '2026-01-01',
  endDate: '2027-01-01',
  state: 'VA',
  congressionalDistrict: '10',
  geographyBasis: 'place_of_performance',
};

function record(over: Partial<DistrictNexusRelationshipRecord> = {}): DistrictNexusRelationshipRecord {
  return {
    id: 'rel-1',
    clientId: 'client-1',
    assistanceAwardId: AWARD.id,
    facilityId: null,
    relationshipType: 'subrecipient',
    relationshipDescription: null,
    attributableAmount: 250_000,
    beneficiaryCount: null,
    evidenceSourceType: 'analyst_manual_entry',
    evidenceSourceRef: 'signed subaward agreement',
    confidence: 1,
    verificationStatus: 'verified',
    externalUseApproved: true,
    verifiedAt: '2026-07-27T12:00:00.000Z',
    verifiedByUserId: 'user-1',
    effectiveStart: null,
    effectiveEnd: null,
    createdAt: '2026-07-27T12:00:00.000Z',
    updatedAt: '2026-07-27T12:00:00.000Z',
    award: AWARD,
    facility: null,
    ...over,
  };
}

function renderPanel(canManage: boolean) {
  const qc = new QueryClient({
    // retryDelay (not retry) — the component hardcodes `retry: 1`, which
    // overrides a default, so the only way to keep the error test fast is to
    // collapse the backoff.
    defaultOptions: { queries: { retry: false, retryDelay: 0 } },
  });
  const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
  const utils = render(
    <QueryClientProvider client={qc}>
      <AntApp>
        <DistrictNexusRelationshipsPanel clientId="client-1" canManage={canManage} />
      </AntApp>
    </QueryClientProvider>,
  );
  return { ...utils, invalidateSpy };
}

describe('DistrictNexusRelationshipsPanel', () => {
  beforeAll(setupAntdBrowserMocks);

  beforeEach(() => {
    listMock.mockReset();
    searchMock.mockReset();
    createMock.mockReset();
    updateMock.mockReset();
    rejectMock.mockReset();
  });

  test('a standard user sees the evidence but no create, edit, or reject affordance', async () => {
    listMock.mockResolvedValue({ relationships: [record()], facilities: [] });

    renderPanel(false);

    await screen.findByText('Subrecipient');
    expect(screen.queryByRole('button', { name: /add relationship/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /edit/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /reject/i })).toBeNull();
    // The empty-state copy must not accuse a reader of not having entered data.
    expect(screen.queryByText(/have been entered/i)).toBeNull();
  });

  test('an admin sees the management affordances', async () => {
    listMock.mockResolvedValue({ relationships: [record()], facilities: [] });

    renderPanel(true);

    await screen.findByText('Subrecipient');
    expect(screen.getByRole('button', { name: /add relationship/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /edit/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /reject/i })).toBeTruthy();
  });

  test('a failed request renders as a failure, never as "none on file"', async () => {
    listMock.mockRejectedValue(new Error('boom'));

    renderPanel(true);

    await waitFor(() =>
      expect(screen.getByText(/Grant relationships could not load/i)).toBeTruthy(),
    );
    expect(
      screen.getByText(/request failure, not confirmation that no relationships exist/i),
    ).toBeTruthy();
    // The distinction this whole test exists for.
    expect(screen.queryByText(/No reviewed award-bearing grant relationships/i)).toBeNull();
  });

  test('a genuinely empty result renders the empty state and no error', async () => {
    listMock.mockResolvedValue({ relationships: [], facilities: [] });

    renderPanel(true);

    await screen.findByText(/No reviewed award-bearing grant relationships have been entered/i);
    expect(screen.queryByText(/could not load/i)).toBeNull();
  });

  test('verified, unverified, and rejected rows are told apart, and rejection is soft state', async () => {
    listMock.mockResolvedValue({
      relationships: [
        record({ id: 'rel-verified', verificationStatus: 'verified', externalUseApproved: true }),
        record({
          id: 'rel-unverified',
          relationshipType: 'research_partner',
          verificationStatus: 'unverified',
          externalUseApproved: false,
        }),
        record({
          id: 'rel-rejected',
          relationshipType: 'beneficiary',
          verificationStatus: 'rejected',
          externalUseApproved: false,
        }),
      ],
      facilities: [],
    });

    renderPanel(true);

    await screen.findByText('Subrecipient');
    expect(screen.getByText('verified')).toBeTruthy();
    expect(screen.getByText('unverified')).toBeTruthy();
    // Only a verified row may advertise external-use approval.
    expect(screen.getAllByText('External use approved')).toHaveLength(1);

    // A rejected row leaves the active list but is NOT deleted — it is still
    // reported as retained history.
    expect(screen.queryByText('Beneficiary')).toBeNull();
    expect(
      screen.getByText(/1 rejected relationship retained in the audit history/i),
    ).toBeTruthy();
  });

  test('a null attributable amount renders an em dash, never $0', async () => {
    listMock.mockResolvedValue({
      relationships: [record({ attributableAmount: null })],
      facilities: [],
    });

    const { container } = renderPanel(true);

    await screen.findByText('Subrecipient');
    const amount = container.querySelector('.iv1-dnx-amt');
    expect(amount?.textContent).toBe('—');
    expect(screen.queryByText('$0')).toBeNull();
  });

  test('rejecting invalidates every surface that consumes the relationship score', async () => {
    listMock.mockResolvedValue({ relationships: [record()], facilities: [] });
    rejectMock.mockResolvedValue(undefined);

    const { invalidateSpy } = renderPanel(true);

    await screen.findByText('Subrecipient');
    invalidateSpy.mockClear();

    fireEvent.click(screen.getByRole('button', { name: /reject/i }));
    await screen.findByText(/Reject this relationship\?/i);

    const popover = document.querySelector('.ant-popover');
    expect(popover).toBeTruthy();
    fireEvent.click(within(popover as HTMLElement).getByRole('button', { name: /reject/i }));

    await waitFor(() => expect(rejectMock).toHaveBeenCalledWith({}, 'client-1', 'rel-1'));

    // The relationship list alone is not enough: this evidence feeds the client
    // widget's score and both firm-map surfaces, so all four must be refetched
    // or the user is shown a stale number they just changed.
    const keys = invalidateSpy.mock.calls.map(([arg]) =>
      JSON.stringify((arg as { queryKey?: unknown }).queryKey),
    );
    expect(keys).toContain(JSON.stringify(['district-nexus-relationships', 'client-1']));
    expect(keys).toContain(JSON.stringify(['client-district-nexus-v2', 'client-1']));
    expect(keys).toContain(JSON.stringify(['district-nexus', 'map']));
    expect(keys).toContain(JSON.stringify(['district-nexus', 'detail']));
  });
});
